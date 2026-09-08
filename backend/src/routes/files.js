const express = require('express');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    fileUpload,
    fileUrl,
    withSignedUrl,
    removeFileSafe,
} = require('../lib/upload');
const {
    notify,
    notifyAssigneePersonal,
    projectParticipantIds,
} = require('../lib/notify');
const {
    requireAdminRole,
    assertProjectRead,
    assertProjectWritable,
} = require('../lib/permissions');
const {
    assertWithinQuota,
    incrementUsage,
    decrementUsage,
    getUsage,
    resolveQuotaBytes,
    formatBytes,
} = require('../lib/uploadQuota');

const router = express.Router();

router.use(requireAuth);

const fileInclude = {
    uploader: { select: { id: true, name: true, email: true, avatarUrl: true } },
    // Surface the source note (if any) so the Files panel can show a
    // "from note" link back to the note that originally pinned it.
    // We also pull the note's task / CR so the FilesPanel can build
    // the correct deep-link target — a note pinned to a CR or to a
    // CR-scoped task should jump into the CR detail page's Notes tab,
    // not the project-wide Notes tab.
    note: {
        select: {
            id: true,
            content: true,
            taskId: true,
            changeRequestId: true,
            author: { select: { id: true, name: true, email: true } },
            changeRequest: { select: { id: true, code: true, title: true } },
            task: {
                select: {
                    id: true,
                    title: true,
                    changeRequestId: true,
                    changeRequest: {
                        select: { id: true, code: true, title: true },
                    },
                },
            },
        },
    },
    // M5: surface the CR pin (if any) so the Files panel can show a
    // "from CR" badge / link back to the CR detail page.
    changeRequest: {
        select: { id: true, code: true, title: true },
    },
};

function attachNoteSnippet(file) {
    if (!file?.note) return file;
    const c = file.note.content || '';
    const preview = c.length > 80 ? `${c.slice(0, 77)}...` : c;
    return { ...file, note: { ...file.note, preview } };
}

async function ensureProjectExists(projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw httpError(404, 'Project not found');
    return project;
}

async function loadFileOr404(fileId) {
    const file = await prisma.fileAttachment.findUnique({
        where: { id: fileId },
        include: { project: true },
    });
    if (!file) throw httpError(404, 'File not found');
    return file;
}

router.get('/', async (req, res, next) => {
    try {
        const { projectId, changeRequestId } = req.query;
        if (!projectId) throw httpError(400, 'projectId is required');
        await assertProjectRead(req, projectId);

        const where = { projectId };

        // M5: optional CR narrowing. Surfaces every file "about" the
        // CR — direct CR pins + files attached to notes pinned to
        // the CR + files attached to notes pinned to one of the
        // CR's tasks. This matches the CR Files tab's semantics:
        // "everything file-shaped about this CR" in one view, no
        // matter which surface the file was originally uploaded
        // from. Validate the CR belongs to the project so a leaked
        // id can't pull files from elsewhere.
        if (changeRequestId) {
            const cr = await prisma.changeRequest.findUnique({
                where: { id: changeRequestId },
                select: { id: true, projectId: true },
            });
            if (!cr || cr.projectId !== projectId) {
                throw httpError(404, 'Change request not found in project');
            }
            where.OR = [
                { changeRequestId },
                { note: { is: { changeRequestId } } },
                { note: { is: { task: { is: { changeRequestId } } } } },
            ];
        }

        const files = await prisma.fileAttachment.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: fileInclude,
        });
        res.json({
            files: files.map((f) =>
                attachNoteSnippet(withSignedUrl(f, req.user.id)),
            ),
        });
    } catch (err) {
        next(err);
    }
});

// Pre-flight gate: verify the caller is allowed to write to the target
// project BEFORE multer streams 50MB to disk. The frontend must send
// `projectId` either as a query param or as the first multipart field
// (multer parses fields in order, so a `text` field named `projectId`
// is available on `req.body` after multer runs — we still read query
// for the early check).
//
// We also check the per-user storage quota at the same point. The
// browser sends `Content-Length` on the multipart envelope (the
// uploaded file size + a tiny header overhead), which is a good-
// enough proxy for the file size BEFORE the bytes hit disk. The
// final, authoritative check happens again after multer parses the
// file (the byte count there is exact) — but doing this pre-check
// means we don't burn disk on a request we'd reject anyway.
async function ensureUploadAccess(req, res, next) {
    try {
        const projectId = req.query.projectId || req.body.projectId;
        if (!projectId) {
            return next(httpError(400, 'projectId is required'));
        }
        // Uploads write to a project, so they're blocked on closed
        // projects for regular users via `assertProjectWritable`.
        // Admins / managers (and personal-project owners) still pass.
        await assertProjectWritable(req, projectId, 'upload a file');
        req.uploadProjectId = projectId;

        // Pre-flight quota check based on Content-Length. We subtract
        // a small fudge for the multipart wrapper (boundary, headers
        // per part); the worst case is we accept a few KB more than
        // the budget allows, which is fine. If the header is missing
        // we skip the pre-check and rely on the post-multer check
        // below where we know the actual size.
        const contentLength = Number(req.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > 0) {
            await assertWithinQuota({
                user: req.user,
                incomingBytes: Math.max(0, contentLength - 2048),
            });
        }
        next();
    } catch (err) {
        next(err);
    }
}

// Upload: any project participant (or admin). Like adding notes, this is
// part of the contribution surface regular users have.
router.post(
    '/',
    ensureUploadAccess,
    fileUpload.single('file'),
    async (req, res, next) => {
    try {
        if (!req.file) throw httpError(400, 'No file uploaded');

        const projectId = req.uploadProjectId || req.body.projectId;
        if (!projectId) {
            removeFileSafe(fileUrl(req.file.filename));
            throw httpError(400, 'projectId is required');
        }

        // Re-verify in case the multipart `projectId` field differs from
        // the pre-flight one — only the post-multer value is what we'll
        // actually store, so it must pass the access check too.
        if (projectId !== req.uploadProjectId) {
            try {
                await assertProjectWritable(req, projectId, 'upload a file');
            } catch (err) {
                removeFileSafe(fileUrl(req.file.filename));
                throw err;
            }
        }

        // Final, AUTHORITATIVE quota check now that we know the exact
        // file size on disk. The pre-flight check above used the
        // Content-Length header which is an upper bound; this is the
        // real one. If it fails we delete the on-disk file so we
        // don't end up with disk-allocated bytes the DB never knew
        // about.
        try {
            await assertWithinQuota({
                user: req.user,
                incomingBytes: req.file.size,
            });
        } catch (err) {
            removeFileSafe(fileUrl(req.file.filename));
            throw err;
        }

        // Optional note pin: when files are uploaded as attachments to a
        // specific note (e.g. from the note composer) the client passes
        // the note id along so the file gets linked from creation. We
        // still verify the note belongs to the same project to stop
        // cross-project pinning. Accept the id from either the query
        // string or the multipart body — the FE sends both for the same
        // pre-flight reason as projectId.
        const noteId = req.query.noteId || req.body.noteId || null;
        let noteCrId = null;
        if (noteId) {
            const pinNote = await prisma.note.findUnique({
                where: { id: noteId },
                select: { id: true, projectId: true, changeRequestId: true },
            });
            if (!pinNote || pinNote.projectId !== projectId) {
                removeFileSafe(fileUrl(req.file.filename));
                throw httpError(400, 'Note does not belong to this project');
            }
            noteCrId = pinNote.changeRequestId || null;
        }

        // M5: optional CR pin. When the upload form comes from the
        // CR Files panel the client sends `changeRequestId` so the
        // file gets stamped directly. We still validate the CR
        // belongs to the same project, and if the file is also
        // pinned to a note that note's CR (if any) must match —
        // mirrors the note creation logic for consistency.
        const incomingCrId =
            req.query.changeRequestId || req.body.changeRequestId || null;
        if (incomingCrId) {
            const cr = await prisma.changeRequest.findUnique({
                where: { id: incomingCrId },
                select: { id: true, projectId: true },
            });
            if (!cr || cr.projectId !== projectId) {
                removeFileSafe(fileUrl(req.file.filename));
                throw httpError(
                    400,
                    'Change request does not belong to this project',
                );
            }
            if (noteCrId && noteCrId !== incomingCrId) {
                removeFileSafe(fileUrl(req.file.filename));
                throw httpError(
                    400,
                    'Note belongs to a different change request',
                );
            }
        }
        // Effective CR pin: explicit param takes precedence; otherwise
        // inherit from the pinning note. Keeps the CR back-relation
        // consistent for files attached to a CR-scoped note even
        // when the upload didn't explicitly stamp the CR.
        const changeRequestId = incomingCrId || noteCrId || null;

        // Wrap the FileAttachment INSERT and the user's quota
        // counter increment in a single transaction so they either
        // both succeed or both roll back. Without this, a crash
        // between the two statements would silently corrupt the
        // counter (eventually requiring `recomputeForUser`).
        const file = await prisma.$transaction(async (tx) => {
            const created = await tx.fileAttachment.create({
                data: {
                    filename: req.file.filename,
                    originalName: req.file.originalname,
                    mimeType: req.file.mimetype,
                    size: req.file.size,
                    url: fileUrl(req.file.filename),
                    projectId,
                    uploaderId: req.user.id,
                    noteId: noteId || null,
                    changeRequestId: changeRequestId || null,
                },
                include: fileInclude,
            });
            await incrementUsage(tx, req.user.id, req.file.size);
            return created;
        });

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { name: true },
        });
        const involved = await projectParticipantIds(projectId);
        // Resolve the (optional) task and its assignee FIRST so the
        // participant email batch can drop them (Option 1) and the
        // personalised notification can target them.
        let pinnedTaskId = null;
        let pinnedAssigneeId = null;
        if (noteId) {
            try {
                const pinnedNote = await prisma.note.findUnique({
                    where: { id: noteId },
                    select: { taskId: true },
                });
                if (pinnedNote?.taskId) {
                    pinnedTaskId = pinnedNote.taskId;
                    const t = await prisma.task.findUnique({
                        where: { id: pinnedTaskId },
                        select: { assigneeId: true },
                    });
                    pinnedAssigneeId = t?.assigneeId || null;
                }
            } catch (err) {
                console.warn(
                    '[files] task/assignee lookup failed:',
                    err.message,
                );
            }
        }

        await notify({
            recipientIds: involved,
            actorId: req.user.id,
            type: 'FILE_UPLOADED',
            title: `${project?.name || 'Project'}: file uploaded`,
            body: `${req.user.email} uploaded "${file.originalName}".`,
            projectId,
            meta: {
                fileId: file.id,
                taskId: pinnedTaskId || undefined,
                // M5: stamp the CR id so the notification's deep
                // link routes to /projects/X/cr/Y#file-Z instead of
                // the project-wide Files panel, and the audit feed
                // CR filter can pick the row up.
                changeRequestId: file.changeRequestId || undefined,
            },
            emailRecipientIds: pinnedAssigneeId
                ? involved.filter((id) => id !== pinnedAssigneeId)
                : undefined,
        });

        // If the file is pinned to a note pinned to a task, give that
        // task's assignee the personalised email.
        if (pinnedTaskId) {
            try {
                await notifyAssigneePersonal({
                    taskId: pinnedTaskId,
                    actorId: req.user.id,
                    actorLabel: req.user.name || req.user.email,
                    type: 'FILE_UPLOADED',
                    actionDescription: 'attached a file to',
                    detail: `File: "${file.originalName}".`,
                    projectId,
                    meta: {
                        fileId: file.id,
                        taskId: pinnedTaskId,
                        changeRequestId: file.changeRequestId || undefined,
                    },
                });
            } catch (err) {
                console.warn(
                    '[files] assignee notify failed:',
                    err.message,
                );
            }
        }

        res.status(201).json({
            file: attachNoteSnippet(withSignedUrl(file, req.user.id)),
        });
    } catch (err) {
        next(err);
    }
});

// Delete: admin only. The DB row and the uploader's quota counter
// decrement are wrapped in a single transaction; the on-disk blob is
// only unlinked AFTER the transaction commits so a rolled-back delete
// can't leave the file orphaned.
router.delete('/:id', async (req, res, next) => {
    try {
        requireAdminRole(req);
        const file = await loadFileOr404(req.params.id);
        await prisma.$transaction(async (tx) => {
            await tx.fileAttachment.delete({ where: { id: file.id } });
            await decrementUsage(tx, file.uploaderId, file.size);
        });
        removeFileSafe(file.url);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// Lightweight: how much storage am I using and where am I against
// the cap? The frontend hits this from the profile page (and could
// also be polled from a "Storage" widget if we add one). Admins get
// the same shape but with `quotaApplies: false` so the UI knows not
// to render a "X% used" bar that doesn't apply to them.
router.get('/quota/me', async (req, res, next) => {
    try {
        const used = await getUsage(req.user.id);
        const quotaBytes = resolveQuotaBytes();
        const isAdmin = req.user.role === 'ADMIN';
        // BigInt → number for the JSON wire (values stay well below
        // 2^53 for any quota a single user could plausibly hit).
        const usedNumber = Number(used);
        const quotaNumber = quotaBytes === null ? null : Number(quotaBytes);
        res.json({
            usedBytes: usedNumber,
            usedLabel: formatBytes(used),
            quotaBytes: quotaNumber,
            quotaLabel: quotaBytes === null ? null : formatBytes(quotaBytes),
            quotaApplies: !isAdmin && quotaBytes !== null,
            // Convenience for the FE so it doesn't have to do BigInt
            // math: percentage 0-100, undefined if no cap applies.
            percentUsed:
                quotaBytes && !isAdmin
                    ? Math.min(
                          100,
                          Math.round((Number(used) / Number(quotaBytes)) * 100),
                      )
                    : null,
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
