const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const prisma = require('../lib/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    buildProjectWorkbook,
    buildProjectsListWorkbook,
    buildTimeEntriesWorkbook,
    safeFilename,
} = require('../lib/excel');
const { buildTimeEntriesCsv, TIME_EXPORT_COLUMNS } = require('../lib/csv');
const {
    applyClientApplicationProjectFilter,
    finalizeTimeEntryProjectScope,
} = require('../lib/timeFilters');
const {
    isAdmin,
    CAPABILITIES,
    hasCapability,
} = require('../lib/permissions');
const { isProjectParticipant } = require('../lib/notify');

const router = express.Router();

router.use(requireAuth);

// Where saved export snapshots live (same volume as other uploads).
const UPLOAD_ROOT = path.resolve(__dirname, '..', '..', 'uploads');
const EXPORT_DIR = path.join(UPLOAD_ROOT, 'exports');
// Keep saved exports for one year.
const EXPORT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function canExportAll(req) {
    return isAdmin(req) || hasCapability(req, CAPABILITIES.TIME_EXPORT);
}

// Delete every expired export (file + row). Best-effort; called on list
// and after each new export so the store self-cleans without a cron.
async function pruneExpiredExports() {
    try {
        const expired = await prisma.exportRecord.findMany({
            where: { expiresAt: { lt: new Date() } },
            select: { id: true, storagePath: true },
        });
        if (expired.length === 0) return;
        for (const r of expired) {
            const abs = path.join(UPLOAD_ROOT, r.storagePath);
            if (abs.startsWith(UPLOAD_ROOT)) {
                fs.promises.unlink(abs).catch(() => {});
            }
        }
        await prisma.exportRecord.deleteMany({
            where: { id: { in: expired.map((r) => r.id) } },
        });
    } catch {
        /* non-fatal */
    }
}

// Write a generated CSV to disk and record it so it can be re-downloaded
// later exactly as produced. Never blocks the download (best-effort).
async function saveTimeExportSnapshot({ req, body, filename, rowCount, meta }) {
    await fs.promises.mkdir(EXPORT_DIR, { recursive: true });
    const stored = `${crypto.randomBytes(16).toString('hex')}.csv`;
    const abs = path.join(EXPORT_DIR, stored);
    await fs.promises.writeFile(abs, body, 'utf8');
    await prisma.exportRecord.create({
        data: {
            kind: 'TIME_CSV',
            filename,
            storagePath: `exports/${stored}`,
            sizeBytes: Buffer.byteLength(body, 'utf8'),
            rowCount: rowCount ?? null,
            meta: meta || undefined,
            createdById: req.user.id,
            expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
        },
    });
    pruneExpiredExports().catch(() => {});
}

const STATUSES = ['TODO', 'IN_PROGRESS', 'DONE', 'ON_HOLD'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

// Streams a workbook back to the caller with the right Excel mime type and
// download disposition. We commit the workbook to the response stream so
// large exports stay memory-friendly.
async function sendWorkbook(res, workbook, filename) {
    res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
    );
    await workbook.xlsx.write(res);
    res.end();
}

// CSV sibling of `sendWorkbook`. `body` is the full text payload
// (already includes the UTF-8 BOM produced by buildCsv). We set
// `text/csv` so browsers download with the right viewer hint and we
// don't tag the file as plain text.
function sendCsv(res, body, filename) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
    );
    res.end(body);
}

// ---- Single project export -----------------------------------------------
//
// Allowed for any admin or anyone who can already view the project (owner /
// participant). Export is read-only so participation is sufficient.
router.get('/projects/:id/xlsx', async (req, res, next) => {
    try {
        const project = await prisma.project.findUnique({
            where: { id: req.params.id },
            include: {
                owner: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        avatarUrl: true,
                    },
                },
                reporter: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        avatarUrl: true,
                    },
                },
                phases: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
                tasks: {
                    // Exclude soft-deleted tasks from the workbook —
                    // an admin who wants to see them can restore via
                    // the Activity log first.
                    where: { deletedAt: null },
                    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
                    include: {
                        assignee: {
                            select: { id: true, name: true, email: true },
                        },
                        phase: { select: { id: true, name: true } },
                    },
                },
                activities: {
                    orderBy: [
                        { done: 'asc' },
                        { scheduledAt: 'asc' },
                        { createdAt: 'desc' },
                    ],
                    include: {
                        assignee: {
                            select: { id: true, name: true, email: true },
                        },
                        createdBy: {
                            select: { id: true, name: true, email: true },
                        },
                        phase: { select: { id: true, name: true } },
                    },
                },
                notes: {
                    orderBy: { createdAt: 'desc' },
                    include: {
                        author: {
                            select: { id: true, name: true, email: true },
                        },
                        _count: { select: { files: true } },
                    },
                },
                files: {
                    orderBy: { createdAt: 'desc' },
                    include: {
                        uploader: {
                            select: { id: true, name: true, email: true },
                        },
                    },
                },
                participants: {
                    orderBy: { addedAt: 'asc' },
                    include: {
                        user: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                role: true,
                            },
                        },
                        addedBy: {
                            select: { id: true, name: true, email: true },
                        },
                    },
                },
                // Specific-task approval lifecycle events, so the workbook
                // carries an auditable "who approved / disapproved /
                // re-requested what, when, and why" trail.
                events: {
                    where: {
                        type: {
                            in: [
                                'TASK_APPROVED',
                                'TASK_DISAPPROVED',
                                'TASK_APPROVAL_REQUESTED',
                            ],
                        },
                    },
                    orderBy: { createdAt: 'desc' },
                    include: {
                        actor: {
                            select: { id: true, name: true, email: true },
                        },
                    },
                },
            },
        });

        if (!project) throw httpError(404, 'Project not found');

        const allowed =
            isAdmin(req) ||
            project.ownerId === req.user.id ||
            (await isProjectParticipant(project.id, req.user.id));
        if (!allowed) {
            throw httpError(
                403,
                'You do not have access to this project',
            );
        }

        const includePrices =
            req.query.prices === '1' || req.query.prices === 'true';
        const workbook = buildProjectWorkbook(project, { includePrices });
        const filename = `${safeFilename(project.name, 'project')}-${new Date()
            .toISOString()
            .slice(0, 10)}.xlsx`;
        await sendWorkbook(res, workbook, filename);
    } catch (err) {
        next(err);
    }
});

// ---- Projects list export ------------------------------------------------
//
// Admin only. Mirrors the list filters (status / priority / ownerId /
// reporterId / search) so admins can export exactly what they're
// looking at. The optional `?detail=full` flag adds extra sheets
// (Phases / Tasks / Activities / Notes / Files / Participants) covering
// every row across the filtered projects so admins get a single
// auditable workbook instead of N per-project files.
router.get('/projects/xlsx', requireAdmin, async (req, res, next) => {
    try {
        const where = {};

        const {
            status,
            priority,
            ownerId,
            reporterId,
            search,
            projectIds,
        } = req.query;

        // Explicit picker overrides every other filter. The frontend
        // sends `projectIds=id1,id2,...` when the admin has ticked
        // specific rows; in that mode we just hydrate those projects so
        // the export matches what they explicitly selected, regardless
        // of the current filter chips.
        const explicitIds =
            typeof projectIds === 'string'
                ? projectIds
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                : [];

        if (explicitIds.length === 1) {
            where.id = explicitIds[0];
        } else if (explicitIds.length > 1) {
            where.id = { in: explicitIds };
        }
        // Filter chips only apply when no explicit selection was sent —
        // otherwise the admin's tick-list wins.
        const skipFilters = explicitIds.length > 0;

        // Accept either a single value (legacy) or a comma-separated list
        // for the new multi-select filters. Empty/invalid values are
        // silently dropped so a malformed query simply returns the
        // unfiltered set.
        const parseList = (v) =>
            (typeof v === 'string'
                ? v.split(',').map((s) => s.trim()).filter(Boolean)
                : []);

        const wantStatuses = skipFilters
            ? []
            : parseList(status).filter((s) => STATUSES.includes(s));
        if (wantStatuses.length === 1) where.status = wantStatuses[0];
        else if (wantStatuses.length > 1) where.status = { in: wantStatuses };

        const wantPriorities = skipFilters
            ? []
            : parseList(priority).filter((p) => PRIORITIES.includes(p));
        if (wantPriorities.length === 1) where.priority = wantPriorities[0];
        else if (wantPriorities.length > 1)
            where.priority = { in: wantPriorities };

        const wantOwners = skipFilters ? [] : parseList(ownerId);
        if (wantOwners.length === 1) where.ownerId = wantOwners[0];
        else if (wantOwners.length > 1) where.ownerId = { in: wantOwners };

        const wantReporters = skipFilters ? [] : parseList(reporterId);
        if (wantReporters.length) {
            const includeNone = wantReporters.includes('__none__');
            const ids = wantReporters.filter((id) => id !== '__none__');
            if (includeNone && ids.length === 0) {
                where.reporterId = null;
            } else if (includeNone) {
                where.OR = [
                    ...(where.OR || []),
                    { reporterId: null },
                    { reporterId: { in: ids } },
                ];
            } else if (ids.length === 1) {
                where.reporterId = ids[0];
            } else {
                where.reporterId = { in: ids };
            }
        }
        if (!skipFilters && search && typeof search === 'string') {
            const s = search.trim();
            if (s) {
                where.OR = [
                    { name: { contains: s, mode: 'insensitive' } },
                    { description: { contains: s, mode: 'insensitive' } },
                    { client: { contains: s, mode: 'insensitive' } },
                    { crmId: { contains: s, mode: 'insensitive' } },
                    { country: { contains: s, mode: 'insensitive' } },
                    { label: { contains: s, mode: 'insensitive' } },
                ];
            }
        }

        const detail = req.query.detail === 'full' ? 'full' : 'summary';
        const includePrices =
            req.query.prices === '1' || req.query.prices === 'true';

        // The summary sheet always benefits from per-task status info
        // so we pull `dueDate` + `status` for every project regardless
        // of detail level (the task counts are still cheap). The full
        // detail mode swaps in the relations needed by the extra
        // sheets.
        const tasksInclude =
            detail === 'full'
                ? {
                      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
                      include: {
                          assignee: {
                              select: { id: true, name: true, email: true },
                          },
                          phase: { select: { id: true, name: true } },
                      },
                  }
                : {
                      select: {
                          id: true,
                          status: true,
                          dueDate: true,
                          parentTaskId: true,
                          phaseId: true,
                      },
                  };

        const baseInclude = {
            owner: { select: { id: true, name: true, email: true } },
            reporter: { select: { id: true, name: true, email: true } },
            tasks: tasksInclude,
            _count: {
                select: {
                    notes: true,
                    files: true,
                    phases: true,
                    participants: true,
                    activities: true,
                },
            },
        };

        if (detail === 'full') {
            baseInclude.phases = {
                orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
            };
            baseInclude.activities = {
                orderBy: [
                    { done: 'asc' },
                    { scheduledAt: 'asc' },
                    { createdAt: 'desc' },
                ],
                include: {
                    assignee: { select: { id: true, name: true, email: true } },
                    createdBy: { select: { id: true, name: true, email: true } },
                    phase: { select: { id: true, name: true } },
                },
            };
            baseInclude.notes = {
                orderBy: { createdAt: 'desc' },
                include: {
                    author: { select: { id: true, name: true, email: true } },
                    task: { select: { id: true, title: true } },
                },
            };
            baseInclude.files = {
                orderBy: { createdAt: 'desc' },
                include: {
                    uploader: { select: { id: true, name: true, email: true } },
                },
            };
            baseInclude.participants = {
                orderBy: { addedAt: 'asc' },
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,
                            email: true,
                            role: true,
                        },
                    },
                    addedBy: { select: { id: true, name: true, email: true } },
                },
            };
        }

        const projects = await prisma.project.findMany({
            where,
            orderBy: { updatedAt: 'desc' },
            include: baseInclude,
        });

        // The summary sheet expects an `activityCount` shortcut so it
        // doesn't have to count when activities aren't loaded.
        for (const p of projects) {
            if (p.activities) {
                p.activityCount = p.activities.length;
            } else if (p._count?.activities != null) {
                p.activityCount = p._count.activities;
            }
        }

        const workbook = buildProjectsListWorkbook(projects, {
            detail,
            includePrices,
        });
        const suffix = detail === 'full' ? '-detailed' : '';
        const filename = `projects${suffix}-${new Date()
            .toISOString()
            .slice(0, 10)}.xlsx`;
        await sendWorkbook(res, workbook, filename);
    } catch (err) {
        next(err);
    }
});

// ---- Time tracking export -------------------------------------------------
//
// Exports time entries to XLSX with the columns the team specified:
//   User · Project type · CRM ID · Project · Date · Time spent ·
//   Task · Log comment (note) · IDs (project / task / subtask)
//
// Permissions match the rest of the time-tracking surface:
//   - Admins: get every entry across every project (the "All users"
//     view). Honours optional `userId`, `projectId`, `from`, `to`.
//   - Non-admins: always exporting their OWN entries only. We still
//     honour `projectId` / `from` / `to` filters, and silently drop
//     any other `userId` so a regular user can't read someone else's
//     log via the export endpoint.
//
// Filters mirror /api/time exactly so the UI can pass through whatever
// the user has selected on the page.
// CSV time-entries export. The route lives at /time/csv now; the old
// /time/xlsx alias below kept for ~one release in case any external
// scripts still point at it (it just redirects to the canonical CSV
// endpoint).
async function exportTimeCsv(req, res, next) {
    try {
        const where = {};
        const { projectId, from, to } = req.query;
        const requestedUserId = req.query.userId
            ? String(req.query.userId)
            : null;

        if (projectId) where.projectId = String(projectId);
        // Optional multi-task filter — same shape as /api/time so the
        // CSV export honours whatever tasks the user picked in the
        // Time tracking dropdown.
        const rawTaskIds = req.query.taskIds;
        if (rawTaskIds !== undefined && rawTaskIds !== null && rawTaskIds !== '') {
            const arr = Array.isArray(rawTaskIds)
                ? rawTaskIds.flatMap((v) => String(v).split(','))
                : String(rawTaskIds).split(',');
            const clean = Array.from(
                new Set(arr.map((s) => s.trim()).filter(Boolean)),
            );
            if (clean.length === 1) where.taskId = clean[0];
            else if (clean.length > 1) where.taskId = { in: clean };
        }
        if (from || to) {
            where.startedAt = {};
            if (from) where.startedAt.gte = new Date(String(from));
            if (to) where.startedAt.lte = new Date(String(to));
        }
        await applyClientApplicationProjectFilter(where, req.query, req);

        // Scope to projects the caller can read at all so a non-admin
        // can't probe by guessing project ids. Users with the
        // explicit `time:export` capability override get the same
        // wide-open view as an admin.
        const canExportAll =
            isAdmin(req) || hasCapability(req, CAPABILITIES.TIME_EXPORT);
        const scopeEmpty = await finalizeTimeEntryProjectScope(where, req, {
            canSeeAll: canExportAll,
        });
        if (scopeEmpty) {
            return sendCsv(
                res,
                buildTimeEntriesCsv([]),
                `time-entries-${new Date().toISOString().slice(0, 10)}.csv`,
            );
        }
        if (!canExportAll) {
            where.userId = req.user.id;
        } else if (requestedUserId) {
            where.userId = requestedUserId;
        }

        const entries = await prisma.timeEntry.findMany({
            // Same anti-double-row filter as /api/time admin view:
            // hide source entries that have already been mirrored to
            // a shared project so the spreadsheet shows ONE row per
            // logging event. Wrapped in AND so we never clobber any
            // OR / AND already inside `where`.
            where: {
                AND: [
                    where,
                    {
                        OR: [
                            { sourceEntryId: { not: null } }, // is mirror
                            { mirroredAs: { is: null } }, // no mirror exists
                        ],
                    },
                ],
            },
            orderBy: { startedAt: 'desc' },
            // Generous cap. CSV streams handle millions of rows fine
            // but we kept the same ceiling we used for the XLSX export
            // so a runaway query can't OOM the box.
            take: 50000,
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        employeeCode: true,
                    },
                },
                project: {
                    select: {
                        id: true,
                        code: true,
                        name: true,
                        crmId: true,
                        projectType: {
                            select: {
                                id: true,
                                name: true,
                                activityCode: true,
                            },
                        },
                        entity: { select: { code: true, description: true } },
                        product: { select: { code: true, name: true } },
                    },
                },
                task: {
                    select: {
                        id: true,
                        code: true,
                        title: true,
                        parent: {
                            select: { id: true, code: true, title: true },
                        },
                        sourceTicket: { select: { code: true } },
                    },
                },
                // Mirror rows need the original personal project +
                // source task so the CSV's "Project / task" column
                // can inline them ("P26-SER-006 Personal -> T-001 ...").
                // Without these the export shows generic "Project-
                // level" text instead of the user's actual personal
                // task title.
                fromPersonalProject: {
                    select: { id: true, code: true, name: true },
                },
                sourceEntry: {
                    select: {
                        id: true,
                        description: true,
                        task: {
                            select: {
                                id: true,
                                code: true,
                                title: true,
                                parentTaskId: true,
                                parent: {
                                    select: {
                                        id: true,
                                        code: true,
                                        title: true,
                                    },
                                },
                                sourceTicket: { select: { code: true } },
                            },
                        },
                    },
                },
            },
        });

        // Optional ordered column selection from the export dialog:
        // `fields=key1,key2,...`. Unknown keys are dropped in the CSV
        // builder; an empty/missing value yields the full default set.
        const fields =
            typeof req.query.fields === 'string' && req.query.fields.trim()
                ? req.query.fields
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                : null;

        const filename = `time-entries-${new Date()
            .toISOString()
            .slice(0, 10)}.csv`;
        const body = buildTimeEntriesCsv(entries, { from, to }, { fields });

        // Snapshot the export so it can be re-downloaded from the history
        // later — best-effort, never block the actual download.
        try {
            await saveTimeExportSnapshot({
                req,
                body,
                filename,
                rowCount: entries.length,
                meta: {
                    from: from || null,
                    to: to || null,
                    fields: fields || null,
                    userId: requestedUserId || null,
                },
            });
        } catch (e) {
            console.warn('[export] could not save history:', e.message);
        }

        return sendCsv(res, body, filename);
    } catch (err) {
        return next(err);
    }
}

// The column catalogue for the export field-picker dialog.
router.get('/time/columns', (req, res) => {
    res.json({ columns: TIME_EXPORT_COLUMNS });
});

// ---- Saved export history -------------------------------------------------

// List saved time-tracking exports. Admins / time:export holders see every
// export; everyone else only their own.
router.get('/time/history', async (req, res, next) => {
    try {
        pruneExpiredExports().catch(() => {});
        const where = { kind: 'TIME_CSV' };
        if (!canExportAll(req)) where.createdById = req.user.id;
        const rows = await prisma.exportRecord.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: 300,
            include: {
                createdBy: { select: { id: true, name: true, email: true } },
            },
        });
        res.json({
            exports: rows.map((r) => ({
                id: r.id,
                filename: r.filename,
                sizeBytes: r.sizeBytes,
                rowCount: r.rowCount,
                meta: r.meta || null,
                createdAt: r.createdAt,
                expiresAt: r.expiresAt,
                createdBy: r.createdBy
                    ? {
                          id: r.createdBy.id,
                          name: r.createdBy.name || r.createdBy.email,
                      }
                    : null,
            })),
        });
    } catch (err) {
        next(err);
    }
});

// Re-download a saved export (byte-identical to when it was produced).
router.get('/time/history/:id/download', async (req, res, next) => {
    try {
        const rec = await prisma.exportRecord.findUnique({
            where: { id: req.params.id },
        });
        if (!rec) throw httpError(404, 'Export not found');
        if (!canExportAll(req) && rec.createdById !== req.user.id) {
            throw httpError(403, 'You cannot download this export');
        }
        const abs = path.join(UPLOAD_ROOT, rec.storagePath);
        if (!abs.startsWith(UPLOAD_ROOT) || !fs.existsSync(abs)) {
            throw httpError(410, 'This export is no longer available');
        }
        const body = await fs.promises.readFile(abs);
        return sendCsv(res, body, rec.filename);
    } catch (err) {
        next(err);
    }
});

// Delete a saved export (file + record).
router.delete('/time/history/:id', async (req, res, next) => {
    try {
        const rec = await prisma.exportRecord.findUnique({
            where: { id: req.params.id },
        });
        if (!rec) return res.json({ ok: true });
        if (!canExportAll(req) && rec.createdById !== req.user.id) {
            throw httpError(403, 'You cannot delete this export');
        }
        const abs = path.join(UPLOAD_ROOT, rec.storagePath);
        if (abs.startsWith(UPLOAD_ROOT)) {
            fs.promises.unlink(abs).catch(() => {});
        }
        await prisma.exportRecord.delete({ where: { id: rec.id } });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.get('/time/csv', exportTimeCsv);
// Legacy alias — the previous Excel endpoint. We now serve CSV from
// this URL too so any bookmarks or scripts that still hit it keep
// working (just with a new file extension).
router.get('/time/xlsx', exportTimeCsv);

module.exports = router;
