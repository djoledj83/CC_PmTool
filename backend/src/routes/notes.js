const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    notify,
    notifyAssigneePersonal,
    projectParticipantIds,
    ensureProjectParticipant,
    resolveMentionUserIds,
} = require('../lib/notify');
const {
    requireAdminRole,
    assertProjectRead,
    assertProjectWritable,
} = require('../lib/permissions');
const { logActivityEvent } = require('../lib/activityLog');
const { isTaskApprovalLocked } = require('../lib/taskApproval');
const { emitToProject } = require('../lib/realtime');
const { withSignedUrl } = require('../lib/upload');

function notePreview(content) {
    return content.length > 140 ? `${content.slice(0, 137)}...` : content;
}

// Mirror tasks.js: broadcast a "your local copy of the plan/notes is
// stale" signal to everyone with this project page open.
function emitProjectPlanChanged(projectId, payload) {
    if (!projectId) return;
    emitToProject(projectId, 'project:plan-changed', {
        projectId,
        ...payload,
        at: new Date().toISOString(),
    });
}

const router = express.Router();

router.use(requireAuth);

const createSchema = z.object({
    projectId: z.string().min(1),
    content: z.string().min(1).max(20000),
    // Optional pin to a specific task or subtask in the same project.
    taskId: z.string().min(1).optional().nullable(),
    // Optional pin to a Change Request in the same project (M4 of the
    // CR workstream). When both taskId and changeRequestId are sent,
    // the task must belong to the CR — otherwise the request is
    // rejected to avoid notes that disagree with the task they're
    // about.
    changeRequestId: z.string().min(1).optional().nullable(),
    // Optional list of already-uploaded FileAttachment ids to claim for
    // this new note. They must belong to the same project and either be
    // unpinned or pinned to no other note (we don't allow stealing
    // attachments from another note).
    fileIds: z.array(z.string().min(1)).max(20).optional(),
});

const updateSchema = z.object({
    content: z.string().min(1).max(20000),
    // Allow re-syncing the attachment list when editing. When omitted
    // we leave existing attachments alone.
    fileIds: z.array(z.string().min(1)).max(20).optional(),
});

const noteInclude = {
    author: { select: { id: true, name: true, email: true, avatarUrl: true } },
    task: {
        select: {
            id: true,
            title: true,
            code: true,
            changeRequestId: true,
            parentTaskId: true,
            parent: { select: { id: true, title: true, code: true } },
        },
    },
    changeRequest: {
        select: { id: true, code: true, title: true },
    },
    files: {
        select: {
            id: true,
            filename: true,
            originalName: true,
            mimeType: true,
            size: true,
            url: true,
            createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
    },
};

// Attach signed URLs to every file on each note so the client can render
// images / link to downloads without an extra round-trip per file.
function decorateNote(note, userId) {
    if (!note) return note;
    const files = (note.files || []).map((f) => withSignedUrl(f, userId));
    return { ...note, files };
}

// Validate a list of file ids against a project + (optional) currently
// owning note. Returns the loaded file rows so callers can use them in
// an update transaction.
async function resolveFilesForNote(fileIds, projectId, currentNoteId = null) {
    if (!Array.isArray(fileIds) || fileIds.length === 0) return [];
    const unique = Array.from(new Set(fileIds));
    const files = await prisma.fileAttachment.findMany({
        where: { id: { in: unique } },
        select: { id: true, projectId: true, noteId: true },
    });
    if (files.length !== unique.length) {
        throw httpError(400, 'One or more attachments could not be found');
    }
    for (const f of files) {
        if (f.projectId !== projectId) {
            throw httpError(400, 'Attachment belongs to another project');
        }
        if (f.noteId && f.noteId !== currentNoteId) {
            throw httpError(400, 'Attachment is already pinned to another note');
        }
    }
    return files;
}

async function ensureProjectExists(projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw httpError(404, 'Project not found');
    return project;
}

async function loadNoteOr404(noteId) {
    const note = await prisma.note.findUnique({
        where: { id: noteId },
        include: { project: true },
    });
    if (!note) throw httpError(404, 'Note not found');
    return note;
}

router.get('/', async (req, res, next) => {
    try {
        const { projectId, taskId, changeRequestId } = req.query;
        if (!projectId) throw httpError(400, 'projectId is required');
        await assertProjectRead(req, projectId);

        // taskId filter: 'none' means project-only notes (no task pin).
        // includeSubtasks=true widens a taskId filter to also return
        // notes pinned to that task's direct subtasks — used by the
        // planning sprint board where subtasks ride along with their
        // parent row and their notes would otherwise be invisible.
        // (Only one of includeSubtasks / changeRequestId may set
        // where.OR; they're never combined by callers today.)
        const includeSubtasks =
            String(req.query.includeSubtasks || '') === 'true';
        const where = { projectId };
        if (taskId === 'none') where.taskId = null;
        else if (taskId && includeSubtasks) {
            where.OR = [
                { taskId },
                { task: { is: { parentTaskId: taskId } } },
            ];
        } else if (taskId) where.taskId = taskId;

        // changeRequestId filter (M4): when set, surface every note
        // "about" this CR — that's notes pinned directly to the CR
        // PLUS notes pinned to any task that lives inside the CR. This
        // matches the user's mental model of the CR Notes tab as the
        // single place to read CR-shaped discussion. To narrow to
        // CR-direct only, callers can also pass `taskId=none`.
        if (changeRequestId) {
            // Validate the CR belongs to this project so a leaked id
            // can't pull notes from elsewhere.
            const cr = await prisma.changeRequest.findUnique({
                where: { id: changeRequestId },
                select: { id: true, projectId: true },
            });
            if (!cr || cr.projectId !== projectId) {
                throw httpError(404, 'Change request not found in project');
            }
            where.OR = [
                { changeRequestId },
                { task: { is: { changeRequestId } } },
            ];
        }

        const notes = await prisma.note.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: noteInclude,
        });
        res.json({ notes: notes.map((n) => decorateNote(n, req.user.id)) });
    } catch (err) {
        next(err);
    }
});

// Posting a note: any project participant (or admin). Adding notes is the
// primary way regular users contribute, so we let them through here even
// though most other writes are admin-only.
router.post('/', async (req, res, next) => {
    try {
        const { projectId, content, taskId, changeRequestId, fileIds } =
            createSchema.parse(req.body);
        // Adding a note on a closed (DONE) project is locked down for
        // regular users — only admin/manager (and the personal-project
        // owner for their own organiser) can keep recording activity
        // after a project is closed.
        await assertProjectWritable(req, projectId, 'add a note');
        const project = await ensureProjectExists(projectId);

        // If pinning to a task, make sure it's in the same project.
        let taskRow = null;
        if (taskId) {
            taskRow = await prisma.task.findUnique({
                where: { id: taskId },
                select: {
                    id: true,
                    projectId: true,
                    changeRequestId: true,
                    specific: true,
                    approvedAt: true,
                },
            });
            if (!taskRow || taskRow.projectId !== projectId) {
                throw httpError(400, 'Task does not belong to this project');
            }
            if (isTaskApprovalLocked(taskRow)) {
                throw httpError(
                    403,
                    'This task must be approved before you can comment on it.',
                );
            }
        }

        // CR pin (M4). Validate the CR belongs to the same project,
        // and if the note is also pinned to a task make sure that task
        // sits inside the same CR — otherwise the note would claim to
        // be about two different CRs at once.
        if (changeRequestId) {
            const cr = await prisma.changeRequest.findUnique({
                where: { id: changeRequestId },
                select: { id: true, projectId: true },
            });
            if (!cr || cr.projectId !== projectId) {
                throw httpError(400, 'Change request does not belong to this project');
            }
            if (taskRow && taskRow.changeRequestId && taskRow.changeRequestId !== changeRequestId) {
                throw httpError(400, 'Task belongs to a different change request');
            }
        }

        // Resolve attachments BEFORE we create the note so we don't end
        // up with an orphaned note when the file list is bad.
        const filesToPin = await resolveFilesForNote(fileIds, projectId);

        const note = await prisma.$transaction(async (tx) => {
            const created = await tx.note.create({
                data: {
                    projectId,
                    content,
                    authorId: req.user.id,
                    taskId: taskId || null,
                    changeRequestId: changeRequestId || null,
                },
            });
            if (filesToPin.length) {
                await tx.fileAttachment.updateMany({
                    where: { id: { in: filesToPin.map((f) => f.id) } },
                    data: { noteId: created.id },
                });
            }
            return tx.note.findUnique({
                where: { id: created.id },
                include: noteInclude,
            });
        });

        // The author becomes a participant.
        await ensureProjectParticipant(projectId, req.user.id, req.user.id);

        // Resolve @mentions early so we can also pull them into the project.
        const mentionedIds = await resolveMentionUserIds(content);
        for (const mid of mentionedIds) {
            await ensureProjectParticipant(projectId, mid, req.user.id);
        }

        const involved = await projectParticipantIds(projectId);
        const preview = notePreview(content);
        // If the note is pinned to a task, look up that task's
        // assignee so we can suppress the duplicate participant email
        // for them — they'll get the personalised email below.
        const pinnedAssigneeId = note.taskId
            ? (
                  await prisma.task.findUnique({
                      where: { id: note.taskId },
                      select: { assigneeId: true },
                  })
              )?.assigneeId || null
            : null;
        await notify({
            recipientIds: involved,
            actorId: req.user.id,
            type: 'NOTE_ADDED',
            title: `${project.name}: new note`,
            body: `${req.user.email}: ${preview}`,
            projectId,
            meta: {
                noteId: note.id,
                taskId: note.taskId || null,
                changeRequestId: note.changeRequestId || null,
            },
            emailRecipientIds: pinnedAssigneeId
                ? involved.filter((id) => id !== pinnedAssigneeId)
                : undefined,
        });

        // Extra heads-up to the task assignee when the note is pinned
        // to a task. They still get the participant-wide bell entry
        // above (Option 1: only their email is deduped, not the bell).
        if (note.taskId) {
            await notifyAssigneePersonal({
                taskId: note.taskId,
                actorId: req.user.id,
                actorLabel: req.user.name || req.user.email,
                type: 'NOTE_ADDED',
                actionDescription: 'added a note to',
                detail: preview,
                projectId,
                meta: {
                    noteId: note.id,
                    taskId: note.taskId,
                    changeRequestId: note.changeRequestId || null,
                },
            });
        }

        if (mentionedIds.length) {
            await notify({
                recipientIds: mentionedIds,
                actorId: req.user.id,
                type: 'MENTION',
                title: `${req.user.email} mentioned you`,
                body: preview,
                projectId,
                meta: {
                    noteId: note.id,
                    taskId: note.taskId || null,
                    changeRequestId: note.changeRequestId || null,
                },
            });
        }

        // Surface the note in the unified Activities feed alongside the
        // dedicated `note_added` bucket. Keeping it as an activity event
        // means filters / deep links work consistently with other event
        // types and survives even if the source Note row is later
        // deleted.
        await logActivityEvent({
            type: 'NOTE_ADDED',
            actorId: req.user.id,
            projectId,
            taskId: note.taskId || null,
            message: preview,
            meta: {
                noteId: note.id,
                pinnedToTask: Boolean(note.taskId),
                changeRequestId: note.changeRequestId || null,
                mentionedUserIds: mentionedIds,
            },
        });

        emitProjectPlanChanged(projectId, {
            kind: 'note-added',
            noteId: note.id,
            taskId: note.taskId || null,
            changeRequestId: note.changeRequestId || null,
            actorId: req.user.id,
            actorName: req.user.name || req.user.email,
            preview,
        });

        res.status(201).json({ note: decorateNote(note, req.user.id) });
    } catch (err) {
        next(err);
    }
});

// Edit: admin only.
router.patch('/:id', async (req, res, next) => {
    try {
        requireAdminRole(req);
        const existing = await loadNoteOr404(req.params.id);
        const { content, fileIds } = updateSchema.parse(req.body);
        const contentChanged = content !== existing.content;

        // Sync attachments only when the client explicitly sent fileIds.
        // Anything currently attached but not in the new list gets
        // "unpinned" (noteId set to null) — the file itself stays in
        // the project's Files panel.
        let attachmentsChanged = false;
        if (Array.isArray(fileIds)) {
            const filesToPin = await resolveFilesForNote(
                fileIds,
                existing.projectId,
                existing.id,
            );
            const currentFiles = await prisma.fileAttachment.findMany({
                where: { noteId: existing.id },
                select: { id: true },
            });
            const wantedSet = new Set(filesToPin.map((f) => f.id));
            const currentSet = new Set(currentFiles.map((f) => f.id));
            const toUnpin = [...currentSet].filter((id) => !wantedSet.has(id));
            const toPin = [...wantedSet].filter((id) => !currentSet.has(id));
            if (toUnpin.length || toPin.length) attachmentsChanged = true;
            if (toUnpin.length) {
                await prisma.fileAttachment.updateMany({
                    where: { id: { in: toUnpin } },
                    data: { noteId: null },
                });
            }
            if (toPin.length) {
                await prisma.fileAttachment.updateMany({
                    where: { id: { in: toPin } },
                    data: { noteId: existing.id },
                });
            }
        }

        const note = await prisma.note.update({
            where: { id: req.params.id },
            data: { content },
            include: noteInclude,
        });

        const newMentions = await resolveMentionUserIds(content);
        const oldMentions = await resolveMentionUserIds(existing.content);
        const freshMentions = newMentions.filter((id) => !oldMentions.includes(id));
        const preview = notePreview(content);
        if (freshMentions.length) {
            for (const mid of freshMentions) {
                await ensureProjectParticipant(
                    existing.projectId,
                    mid,
                    req.user.id,
                );
            }
            await notify({
                recipientIds: freshMentions,
                actorId: req.user.id,
                type: 'MENTION',
                title: `${req.user.email} mentioned you`,
                body: preview,
                projectId: existing.projectId,
                meta: { noteId: note.id, taskId: note.taskId || null },
            });
        }

        // Edits should reach the rest of the project, not just the
        // freshly mentioned users — otherwise an admin can rewrite
        // history without anyone noticing.
        if (contentChanged) {
            const projectName = existing.project?.name || 'project';
            const involved = await projectParticipantIds(existing.projectId);
            const pinnedAssigneeId = note.taskId
                ? (
                      await prisma.task.findUnique({
                          where: { id: note.taskId },
                          select: { assigneeId: true },
                      })
                  )?.assigneeId || null
                : null;
            await notify({
                recipientIds: involved,
                actorId: req.user.id,
                type: 'NOTE_UPDATED',
                title: `${projectName}: note updated`,
                body: `${req.user.email} edited a note: ${preview}`,
                projectId: existing.projectId,
                meta: { noteId: note.id, taskId: note.taskId || null },
                emailRecipientIds: pinnedAssigneeId
                    ? involved.filter((id) => id !== pinnedAssigneeId)
                    : undefined,
            });

            if (note.taskId) {
                await notifyAssigneePersonal({
                    taskId: note.taskId,
                    actorId: req.user.id,
                    actorLabel: req.user.name || req.user.email,
                    type: 'NOTE_UPDATED',
                    actionDescription: 'edited a note on',
                    detail: preview,
                    projectId: existing.projectId,
                    meta: { noteId: note.id, taskId: note.taskId },
                });
            }

            await logActivityEvent({
                type: 'NOTE_UPDATED',
                actorId: req.user.id,
                projectId: existing.projectId,
                taskId: note.taskId || null,
                message: preview,
                meta: {
                    noteId: note.id,
                    changeRequestId: note.changeRequestId || null,
                    fromPreview: notePreview(existing.content),
                    toPreview: preview,
                },
            });
        }

        // Broadcast on either path so the panel re-fetches thumbnails
        // when attachments change without a content edit.
        if (contentChanged || attachmentsChanged) {
            emitProjectPlanChanged(existing.projectId, {
                kind: 'note-updated',
                noteId: note.id,
                taskId: note.taskId || null,
                changeRequestId: note.changeRequestId || null,
                actorId: req.user.id,
                actorName: req.user.name || req.user.email,
                preview,
            });
        }

        res.json({ note: decorateNote(note, req.user.id) });
    } catch (err) {
        next(err);
    }
});

// Delete: admin only.
router.delete('/:id', async (req, res, next) => {
    try {
        requireAdminRole(req);
        const existing = await loadNoteOr404(req.params.id);
        const projectName = existing.project?.name || 'project';
        const preview = notePreview(existing.content);

        await prisma.note.delete({ where: { id: req.params.id } });

        const involved = await projectParticipantIds(existing.projectId);
        const pinnedAssigneeId = existing.taskId
            ? (
                  await prisma.task.findUnique({
                      where: { id: existing.taskId },
                      select: { assigneeId: true },
                  })
              )?.assigneeId || null
            : null;
        await notify({
            recipientIds: involved,
            actorId: req.user.id,
            type: 'NOTE_DELETED',
            title: `${projectName}: note deleted`,
            body: `${req.user.email} deleted a note.`,
            projectId: existing.projectId,
            // Note row is gone — don't deep-link to it.
            meta: { taskId: existing.taskId || null },
            emailRecipientIds: pinnedAssigneeId
                ? involved.filter((id) => id !== pinnedAssigneeId)
                : undefined,
        });

        if (existing.taskId) {
            await notifyAssigneePersonal({
                taskId: existing.taskId,
                actorId: req.user.id,
                actorLabel: req.user.name || req.user.email,
                type: 'NOTE_DELETED',
                actionDescription: 'deleted a note on',
                detail: preview,
                projectId: existing.projectId,
                meta: { taskId: existing.taskId },
            });
        }

        await logActivityEvent({
            type: 'NOTE_DELETED',
            actorId: req.user.id,
            projectId: existing.projectId,
            taskId: existing.taskId || null,
            message: preview,
            meta: {
                deletedNoteId: existing.id,
                pinnedToTask: Boolean(existing.taskId),
                changeRequestId: existing.changeRequestId || null,
            },
        });

        emitProjectPlanChanged(existing.projectId, {
            kind: 'note-deleted',
            noteId: existing.id,
            taskId: existing.taskId || null,
            changeRequestId: existing.changeRequestId || null,
            actorId: req.user.id,
            actorName: req.user.name || req.user.email,
        });

        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
