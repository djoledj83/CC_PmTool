// Sprints / iterations.
//
// Scrum-style time-boxed groupings of tasks inside a single project.
// A task can live in the backlog (sprintId = null) or be assigned to
// exactly one Sprint. Lifecycle is PLANNED -> ACTIVE -> CLOSED, with
// an optional one-step REOPENED back to ACTIVE.
//
// API surface (mounted at /api/sprints):
//
//   GET    /?projectId=:id                              list project's sprints
//   POST   /                                            create
//   GET    /:id                                         detail (sprint + tasks + capacity)
//   PATCH  /:id                                         edit (name/goal/dates)
//   DELETE /:id                                         delete (only PLANNED sprints)
//
//   POST   /:id/start                                   PLANNED -> ACTIVE
//   POST   /:id/close                                   ACTIVE -> CLOSED (with strategy
//                                                       for incomplete tasks)
//   POST   /:id/reopen                                  CLOSED -> ACTIVE
//
//   POST   /:id/tasks                                   add tasks to sprint
//   DELETE /:id/tasks/:taskId                           remove task from sprint
//
//   PUT    /:id/capacity                                set per-user planned hours
//
//   GET    /:id/burndown                                snapshot series + ideal line
//
// Permissions:
//   - Reading any of these endpoints requires project read access,
//     same rule as /api/tasks (admin / owner / participant).
//   - Mutations are gated by the sprint:* capabilities. Admins always
//     pass. Managers hold all sprint:* by role default.
//   - The SPRINT_ASSIGN_TASK capability lets a user move tasks in/out
//     of a sprint without needing full task-edit rights.
//
// Activity feed:
//   Every lifecycle transition + task assignment fires an event so the
//   admin audit feed can reconstruct sprint history.

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    isAdmin,
    hasCapability,
    requireCapability,
    assertProjectRead,
    CAPABILITIES,
} = require('../lib/permissions');
const { logActivityEvent } = require('../lib/activityLog');
const {
    materializeNextSprints,
    previewNextSprints,
    defaultDurationDays,
} = require('../lib/sprintScheduler');

const router = express.Router();
router.use(requireAuth);

// Best-effort audit logger that swallows every error so a sprint
// action never gets rolled back by an audit-log hiccup. Mirrors the
// pattern used in applications.js / time.js.
async function logSprintActivity(type, req, projectId, payload) {
    try {
        await logActivityEvent({
            type,
            actorId: req.user?.id || null,
            projectId: projectId || null,
            meta: payload,
        });
    } catch (err) {
        console.error(`[sprints] failed to log ${type}:`, err);
    }
}

// --- validation ------------------------------------------------------------

// Coerce + parse a body field that may arrive as either an ISO string
// (from the frontend) or a Date (from a server-side caller). We always
// strip the time portion to a midnight-UTC anchor so day-bucket math
// for the burndown chart is deterministic regardless of caller
// timezone.
const dayDate = z
    .preprocess((val) => {
        if (val instanceof Date) return val;
        if (typeof val === 'string' && val.length > 0) return new Date(val);
        return val;
    }, z.date())
    .transform((d) => {
        const out = new Date(d);
        out.setUTCHours(0, 0, 0, 0);
        return out;
    });

const sprintCreateSchema = z
    .object({
        projectId: z.string().min(1),
        name: z.string().trim().min(1).max(120),
        goal: z.string().trim().max(500).optional().nullable(),
        startDate: dayDate,
        endDate: dayDate,
    })
    .refine((d) => d.endDate.getTime() > d.startDate.getTime(), {
        message: 'End date must be after start date',
        path: ['endDate'],
    });

const sprintPatchSchema = z
    .object({
        name: z.string().trim().min(1).max(120).optional(),
        goal: z.string().trim().max(500).optional().nullable(),
        startDate: dayDate.optional(),
        endDate: dayDate.optional(),
    })
    .refine(
        (d) =>
            !d.startDate ||
            !d.endDate ||
            d.endDate.getTime() > d.startDate.getTime(),
        { message: 'End date must be after start date', path: ['endDate'] },
    );

const closeSchema = z.object({
    // PUSH_TO_NEXT  — re-parent incomplete tasks to the next PLANNED
    //                 sprint in this project (chronological).
    // BACK_TO_BACKLOG — clear sprintId on incomplete tasks so they
    //                  return to the backlog.
    // KEEP          — leave incomplete tasks attached to the closed
    //                 sprint (useful for retrospective reporting).
    strategy: z.enum(['PUSH_TO_NEXT', 'BACK_TO_BACKLOG', 'KEEP']),
});

const taskAddSchema = z.object({
    taskIds: z.array(z.string().min(1)).min(1).max(200),
});

const capacityPutSchema = z.object({
    entries: z
        .array(
            z.object({
                userId: z.string().min(1),
                plannedHours: z.number().min(0).max(1000),
            }),
        )
        .min(0)
        .max(500),
});

// Schema for the per-project sprint scheduler upsert. namePattern
// supports {n}, {start}, {end}, {month}, {year} tokens; the {n}
// counter is server-managed (see SprintSchedule.nextNumber) but the
// caller can pass an initial value via `startNumber` when creating
// for the first time, so existing teams can pick up from "Sprint 47".
const scheduleUpsertSchema = z.object({
    projectId: z.string().min(1),
    cadence: z.enum(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']),
    enabled: z.boolean().optional().default(true),
    anchorDate: dayDate,
    namePattern: z.string().trim().min(1).max(80).optional(),
    lookahead: z.number().int().min(1).max(10).optional(),
    // First-time create only — server ignores it on subsequent updates
    // so the running counter doesn't reset on every PUT.
    startNumber: z.number().int().min(1).max(100000).optional(),
});

// --- helpers --------------------------------------------------------------

// Project-level capability gate that uses ASSIGN_TASK as the
// permissive fallback when the action is "move a task in/out". The
// task add/remove endpoints accept anyone who has ASSIGN_TASK OR full
// EDIT (since EDIT implies the lighter ASSIGN power).
function canMoveSprintTasks(req) {
    return (
        isAdmin(req) ||
        hasCapability(req, CAPABILITIES.SPRINT_ASSIGN_TASK) ||
        hasCapability(req, CAPABILITIES.SPRINT_EDIT)
    );
}

// Load a sprint by id, throw 404 when missing, and ensure the caller
// can read its parent project. Returns the sprint row with its project
// snapshot so handlers don't need a second query for the projectId
// scope.
async function loadSprintForRead(req, sprintId) {
    const sprint = await prisma.sprint.findUnique({
        where: { id: sprintId },
        include: {
            project: { select: { id: true, name: true, ownerId: true, isPersonal: true } },
        },
    });
    if (!sprint) throw httpError(404, 'Sprint not found');
    await assertProjectRead(req, sprint.projectId);
    return sprint;
}

// Build the same shape the frontend expects for a sprint detail
// response: the sprint row, an aggregated task list (with assignee
// info), capacity entries, and a small set of computed counters used
// in the sidebar / sprint card UI.
// Pulls the list of top-level taskIds that "belong" to this sprint
// for read-side purposes:
//   - ACTIVE / PLANNED sprints: every top-level task currently
//     assigned via Task.sprintId (the live source of truth).
//   - CLOSED sprints with a `closedTaskIds` snapshot: use that
//     frozen list. This preserves the end-of-sprint membership
//     even after the close handler has re-parented incomplete
//     tasks to the next sprint or back to the backlog. Without
//     this, every closed sprint that used PUSH_TO_NEXT looks
//     hollow (board only shows DONE tasks, totals collapse,
//     burndown ideal line is flat at 0).
//   - CLOSED sprints WITHOUT a snapshot (legacy data from before
//     this fix): fall back to the live query so we at least show
//     what's still attached.
function resolveSprintTaskIds(sprint) {
    if (sprint.status === 'CLOSED' && Array.isArray(sprint.closedTaskIds)) {
        return { mode: 'frozen', ids: sprint.closedTaskIds };
    }
    return { mode: 'live', ids: null };
}

// Shared task-include shape used by both the live and frozen
// branches of serializeSprintDetail so the frontend shape stays
// identical regardless of how we resolved the membership.
const SPRINT_TASK_SELECT = {
    id: true,
    code: true,
    title: true,
    status: true,
    priority: true,
    dueDate: true,
    estimateHours: true,
    assigneeId: true,
    assignee: {
        select: { id: true, name: true, avatarUrl: true },
    },
    // Subtasks ride along with their parent for visibility on the
    // sprint board. They are NOT added to the sprint independently
    // — they inherit the parent's sprint membership — but the
    // board needs them so the user can track per-subtask progress
    // without leaving the Sprint tab. KPI counters / burndown
    // intentionally ignore them so the parent-task semantics stay
    // the source of truth for "what counts as done".
    subtasks: {
        // Soft-deleted subtasks must not leak into the sprint board —
        // the Prisma client extension on top-level task reads cannot
        // reach this nested include.
        where: { deletedAt: null },
        select: {
            id: true,
            code: true,
            title: true,
            status: true,
            priority: true,
            estimateHours: true,
            assigneeId: true,
            assignee: {
                select: { id: true, name: true, avatarUrl: true },
            },
        },
        orderBy: [
            { status: 'asc' },
            { priority: 'asc' },
            { createdAt: 'asc' },
        ],
    },
};

async function serializeSprintDetail(sprint) {
    const membership = resolveSprintTaskIds(sprint);
    const tasksWhere =
        membership.mode === 'frozen'
            ? { id: { in: membership.ids }, parentTaskId: null }
            : { sprintId: sprint.id, parentTaskId: null };
    // Time-entry roll-up: include subtasks via their parent. For
    // frozen (closed) sprints we filter by the historical task IDs
    // instead of the live `sprintId`, otherwise we'd lose every
    // time entry whose task was moved to the next sprint.
    const timeWhere =
        membership.mode === 'frozen'
            ? {
                  task: {
                      OR: [
                          { id: { in: membership.ids } },
                          { parentTaskId: { in: membership.ids } },
                      ],
                  },
              }
            : {
                  task: {
                      OR: [
                          { sprintId: sprint.id },
                          { parent: { sprintId: sprint.id } },
                      ],
                  },
              };

    const [tasks, capacity, logged, lastSnapshot] = await Promise.all([
        prisma.task.findMany({
            where: tasksWhere,
            select: SPRINT_TASK_SELECT,
            orderBy: [
                { status: 'asc' },
                { priority: 'asc' },
                { createdAt: 'asc' },
            ],
        }),
        prisma.sprintCapacity.findMany({
            where: { sprintId: sprint.id },
            include: {
                user: {
                    select: { id: true, name: true, avatarUrl: true },
                },
            },
        }),
        prisma.timeEntry.aggregate({
            where: timeWhere,
            _sum: { durationSeconds: true },
        }),
        // For CLOSED sprints we also fetch the most recent snapshot
        // so we can prefer the frozen counters when the snapshot
        // exists (it was captured before any task re-parenting in
        // the close handler — the authoritative end-of-sprint
        // numbers).
        sprint.status === 'CLOSED'
            ? prisma.sprintSnapshot.findFirst({
                  where: { sprintId: sprint.id },
                  orderBy: { capturedAt: 'desc' },
              })
            : Promise.resolve(null),
    ]);

    const liveTotalHours = tasks.reduce(
        (acc, t) =>
            acc + (typeof t.estimateHours === 'number' ? t.estimateHours : 0),
        0,
    );
    const liveCompletedHours = tasks
        .filter((t) => t.status === 'DONE')
        .reduce(
            (acc, t) =>
                acc +
                (typeof t.estimateHours === 'number' ? t.estimateHours : 0),
            0,
        );
    const liveLoggedSeconds = logged?._sum?.durationSeconds || 0;
    const liveLoggedHours =
        Math.round((liveLoggedSeconds / 3600) * 100) / 100;

    // Prefer snapshot counters for CLOSED sprints — they captured
    // the end-of-sprint state before tasks were moved. Fall back to
    // the live values when no snapshot exists (legacy closes from
    // before this fix).
    const counters =
        sprint.status === 'CLOSED' && lastSnapshot
            ? {
                  totalTasks: lastSnapshot.totalTasks,
                  completedTasks: lastSnapshot.completedTasks,
                  totalHours: lastSnapshot.totalHours,
                  completedHours: Math.max(
                      0,
                      lastSnapshot.totalHours - lastSnapshot.remainingHours,
                  ),
                  loggedHours: lastSnapshot.loggedHours,
              }
            : {
                  totalTasks: tasks.length,
                  completedTasks: tasks.filter((t) => t.status === 'DONE')
                      .length,
                  totalHours: liveTotalHours,
                  completedHours: liveCompletedHours,
                  loggedHours: liveLoggedHours,
              };

    return {
        ...sprint,
        tasks,
        capacity,
        counters,
    };
}

// Tiny safe-divide helper used by burndown / ideal-line math so a
// zero-task sprint returns 0% instead of NaN.
function safeRatio(num, denom) {
    if (!denom) return 0;
    return num / denom;
}

// --- routes ---------------------------------------------------------------

// GET /api/sprints?projectId=:id
// List every sprint in a project, grouped by status, with the small
// aggregate counters needed for the list-view cards.
router.get('/', async (req, res, next) => {
    try {
        const projectId = String(req.query.projectId || '').trim();
        if (!projectId) {
            throw httpError(400, 'projectId is required');
        }
        await assertProjectRead(req, projectId);
        const sprints = await prisma.sprint.findMany({
            where: { projectId },
            orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
            include: {
                // _count needs an explicit where to exclude soft-deleted
                // tasks — without it the sprint card shows the wrong
                // total after a task is restored / deleted.
                _count: {
                    select: {
                        tasks: { where: { deletedAt: null } },
                    },
                },
            },
        });
        // For the list view we want per-sprint quick counters
        // (completed vs total) without paying for the full task list.
        // We aggregate the DONE tasks in a second roundtrip rather
        // than N findMany calls.
        const doneCounts = await prisma.task.groupBy({
            by: ['sprintId'],
            where: {
                sprintId: { in: sprints.map((s) => s.id) },
                status: 'DONE',
                parentTaskId: null,
            },
            _count: { _all: true },
        });
        const doneMap = new Map(
            doneCounts.map((d) => [d.sprintId, d._count._all]),
        );
        const enriched = sprints.map((s) => ({
            id: s.id,
            projectId: s.projectId,
            name: s.name,
            goal: s.goal,
            startDate: s.startDate,
            endDate: s.endDate,
            status: s.status,
            startedAt: s.startedAt,
            closedAt: s.closedAt,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            createdById: s.createdById,
            totalTasks: s._count?.tasks || 0,
            completedTasks: doneMap.get(s.id) || 0,
        }));
        // Surface the project's schedule (if any) in the same response
        // so the UI can render the "auto-creating biweekly" banner
        // without a second roundtrip. Schedule is small (one row);
        // safe to include.
        const schedule = await prisma.sprintSchedule.findUnique({
            where: { projectId },
        });
        res.json({ sprints: enriched, schedule: schedule || null });
    } catch (err) {
        next(err);
    }
});

// POST /api/sprints
// Create a new PLANNED sprint. The (projectId, name) compound is
// unique — duplicate names raise a 409 so the frontend can show a
// friendlier message than a generic 500.
router.post('/', async (req, res, next) => {
    try {
        const data = sprintCreateSchema.parse(req.body);
        await assertProjectRead(req, data.projectId);
        requireCapability(req, CAPABILITIES.SPRINT_CREATE);
        const created = await prisma.sprint
            .create({
                data: {
                    projectId: data.projectId,
                    name: data.name,
                    goal: data.goal ?? null,
                    startDate: data.startDate,
                    endDate: data.endDate,
                    status: 'PLANNED',
                    createdById: req.user.id,
                },
            })
            .catch((err) => {
                if (err.code === 'P2002') {
                    throw httpError(
                        409,
                        'A sprint with this name already exists in this project',
                    );
                }
                throw err;
            });
        await logSprintActivity('SPRINT_CREATED', req, data.projectId, {
            sprintId: created.id,
            sprintName: created.name,
            startDate: created.startDate,
            endDate: created.endDate,
        });
        res.status(201).json({ sprint: created });
    } catch (err) {
        next(err);
    }
});

// --- schedule (per-project sprint cadence) -------------------------------
//
// These routes MUST be declared before the `/:id` routes so Express
// doesn't try to interpret "schedule" as a sprintId. The scheduler
// keeps `lookahead` PLANNED sprints in front of the project's
// timeline; see backend/src/lib/sprintScheduler.js for the generator.

// GET /api/sprints/schedule?projectId=:id
router.get('/schedule', async (req, res, next) => {
    try {
        const projectId = String(req.query.projectId || '').trim();
        if (!projectId) throw httpError(400, 'projectId is required');
        await assertProjectRead(req, projectId);
        const schedule = await prisma.sprintSchedule.findUnique({
            where: { projectId },
            include: {
                createdBy: { select: { id: true, name: true, email: true } },
                updatedBy: { select: { id: true, name: true, email: true } },
            },
        });
        // Always return a preview of the next 3 sprints (whether the
        // schedule is enabled or not) so the UI can render the live
        // "next will be …" hint right after the user edits the form.
        let preview = [];
        if (schedule) {
            const latest = await prisma.sprint.findFirst({
                where: { projectId },
                orderBy: [{ endDate: 'desc' }],
                select: { endDate: true },
            });
            preview = previewNextSprints(schedule, latest?.endDate || null, 3);
        }
        res.json({ schedule, preview });
    } catch (err) {
        next(err);
    }
});

// PUT /api/sprints/schedule
// Upsert the schedule for a project. Requires SPRINT_EDIT (or admin).
// The first call seeds nextNumber from startNumber (default 1);
// subsequent calls only patch the user-controlled config.
router.put('/schedule', async (req, res, next) => {
    try {
        const data = scheduleUpsertSchema.parse(req.body);
        await assertProjectRead(req, data.projectId);
        requireCapability(req, CAPABILITIES.SPRINT_EDIT);
        const existing = await prisma.sprintSchedule.findUnique({
            where: { projectId: data.projectId },
        });
        const namePattern = data.namePattern?.trim() || 'Sprint {n}';
        const lookahead = data.lookahead ?? existing?.lookahead ?? 2;
        const durationDays = defaultDurationDays(data.cadence);
        let row;
        if (!existing) {
            row = await prisma.sprintSchedule.create({
                data: {
                    projectId: data.projectId,
                    cadence: data.cadence,
                    enabled: data.enabled,
                    anchorDate: data.anchorDate,
                    durationDays,
                    namePattern,
                    nextNumber: data.startNumber ?? 1,
                    lookahead,
                    createdById: req.user.id,
                },
            });
        } else {
            row = await prisma.sprintSchedule.update({
                where: { projectId: data.projectId },
                data: {
                    cadence: data.cadence,
                    enabled: data.enabled,
                    anchorDate: data.anchorDate,
                    durationDays,
                    namePattern,
                    lookahead,
                    updatedById: req.user.id,
                    // Only allow seeding nextNumber via PUT if the
                    // caller is realigning numbering. We don't reset
                    // automatically — that would silently re-number
                    // sprints on every save.
                    ...(typeof data.startNumber === 'number'
                        ? { nextNumber: data.startNumber }
                        : {}),
                },
            });
        }
        // Try to materialise immediately so the UI shows the new
        // sprints after a single save (no waiting for the hourly job).
        // Errors here don't block the response — the upsert itself
        // already succeeded.
        try {
            await materializeNextSprints(row.id);
        } catch (err) {
            console.warn(
                '[sprints] immediate materialize after schedule save failed:',
                err.message,
            );
        }
        await logSprintActivity(
            'SPRINT_SCHEDULE_UPDATED',
            req,
            data.projectId,
            {
                scheduleId: row.id,
                cadence: row.cadence,
                enabled: row.enabled,
                anchorDate: row.anchorDate,
                lookahead: row.lookahead,
                namePattern: row.namePattern,
            },
        );
        res.json({ schedule: row });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/sprints/schedule?projectId=:id
// Removes the schedule entirely. Use the PUT route with enabled=false
// if you want to pause without losing the config.
router.delete('/schedule', async (req, res, next) => {
    try {
        const projectId = String(req.query.projectId || '').trim();
        if (!projectId) throw httpError(400, 'projectId is required');
        // ?withPlanned=true also bulk-deletes every PLANNED sprint
        // for this project in the same request. This is what the
        // ScheduleBanner's "Delete schedule" button uses to fully
        // reset the auto-generation state without forcing the user
        // to also open the dialog and run a separate bulk delete.
        // Active / closed sprints are NEVER touched here, regardless
        // of the caller's role — historical sprints are immutable
        // from this endpoint's point of view.
        const withPlanned =
            String(req.query.withPlanned || '').toLowerCase() === 'true';
        await assertProjectRead(req, projectId);
        requireCapability(req, CAPABILITIES.SPRINT_EDIT);
        if (withPlanned) {
            // Bulk delete reuses sprint:delete because the user is
            // about to remove every planned sprint, which is the
            // same destructive intent the bulk-delete endpoint
            // gates on.
            requireCapability(req, CAPABILITIES.SPRINT_DELETE);
        }
        const existing = await prisma.sprintSchedule.findUnique({
            where: { projectId },
        });

        // Wipe planned sprints first when asked. Order matters: if we
        // delete the schedule before clearing the planned tail, the
        // hourly generator could re-create some of them between the
        // two calls. Doing planned deletion first guarantees a clean
        // post-state regardless of timing.
        let plannedDeleted = 0;
        let tasksDetached = 0;
        let plannedNames = [];
        if (withPlanned) {
            const planned = await prisma.sprint.findMany({
                where: { projectId, status: 'PLANNED' },
                select: { id: true, name: true },
                orderBy: { startDate: 'asc' },
            });
            if (planned.length > 0) {
                const plannedIds = planned.map((p) => p.id);
                // Detach tasks first so the count is auditable. The
                // FK is ON DELETE SET NULL anyway, but explicit is
                // better here.
                const detachResult = await prisma.task.updateMany({
                    where: { sprintId: { in: plannedIds } },
                    data: { sprintId: null },
                });
                tasksDetached = detachResult.count;
                const delResult = await prisma.sprint.deleteMany({
                    where: { id: { in: plannedIds } },
                });
                plannedDeleted = delResult.count;
                plannedNames = planned.map((p) => p.name);
                await logSprintActivity(
                    'SPRINT_BULK_DELETED',
                    req,
                    projectId,
                    {
                        deleted: plannedDeleted,
                        tasksDetached,
                        reason: 'schedule_deleted',
                        sprints: planned.map((p) => ({
                            sprintId: p.id,
                            sprintName: p.name,
                            status: 'PLANNED',
                        })),
                    },
                );
            }
        }

        if (!existing) {
            // No schedule to delete, but the planned-sweep above may
            // still have done useful work — surface that to the
            // client so the toast wording is accurate.
            return res.json({
                ok: true,
                removed: false,
                plannedDeleted,
                tasksDetached,
            });
        }
        await prisma.sprintSchedule.delete({ where: { projectId } });
        await logSprintActivity(
            'SPRINT_SCHEDULE_DISABLED',
            req,
            projectId,
            {
                scheduleId: existing.id,
                removed: true,
                plannedDeleted,
                tasksDetached,
            },
        );
        res.json({
            ok: true,
            removed: true,
            plannedDeleted,
            tasksDetached,
            plannedNames,
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/sprints/schedule/run?projectId=:id
// Manually triggers a generation run for a single project. Useful for
// "Generate next" buttons and tests; the background job calls the
// same helper hourly across all enabled schedules.
router.post('/schedule/run', async (req, res, next) => {
    try {
        const projectId = String(req.query.projectId || '').trim();
        if (!projectId) throw httpError(400, 'projectId is required');
        await assertProjectRead(req, projectId);
        requireCapability(req, CAPABILITIES.SPRINT_CREATE);
        const schedule = await prisma.sprintSchedule.findUnique({
            where: { projectId },
        });
        if (!schedule) throw httpError(404, 'No schedule for this project');
        if (!schedule.enabled) {
            throw httpError(
                400,
                'Schedule is disabled. Enable it before generating sprints.',
            );
        }
        const { created } = await materializeNextSprints(schedule.id);
        res.json({ created });
    } catch (err) {
        next(err);
    }
});

// GET /api/sprints/:id
router.get('/:id', async (req, res, next) => {
    try {
        const sprint = await loadSprintForRead(req, req.params.id);
        const detail = await serializeSprintDetail(sprint);
        res.json({ sprint: detail });
    } catch (err) {
        next(err);
    }
});

// PATCH /api/sprints/:id
// Edit a sprint's metadata. Forbidden on CLOSED sprints (their record
// is meant to be immutable for historical reporting).
router.patch('/:id', async (req, res, next) => {
    try {
        const data = sprintPatchSchema.parse(req.body);
        const existing = await loadSprintForRead(req, req.params.id);
        requireCapability(req, CAPABILITIES.SPRINT_EDIT);
        if (existing.status === 'CLOSED') {
            throw httpError(
                400,
                'Closed sprints cannot be edited. Reopen the sprint first.',
            );
        }
        const updated = await prisma.sprint
            .update({
                where: { id: req.params.id },
                data: {
                    ...(data.name !== undefined ? { name: data.name } : {}),
                    ...(data.goal !== undefined ? { goal: data.goal } : {}),
                    ...(data.startDate ? { startDate: data.startDate } : {}),
                    ...(data.endDate ? { endDate: data.endDate } : {}),
                },
            })
            .catch((err) => {
                if (err.code === 'P2002') {
                    throw httpError(
                        409,
                        'A sprint with this name already exists in this project',
                    );
                }
                throw err;
            });
        await logSprintActivity(
            'SPRINT_UPDATED',
            req,
            existing.projectId,
            { sprintId: updated.id, sprintName: updated.name },
        );
        res.json({ sprint: updated });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/sprints/:id
// Non-admin holders of sprint:delete can only hard-delete PLANNED
// sprints — ACTIVE/CLOSED ones must be closed first so the activity
// history stays intact. Admins can delete any sprint outright (e.g.
// to clean up a botched ACTIVE sprint that should never have been
// started). Attached tasks fall back to the backlog either way (the
// FK is ON DELETE SET NULL, and we also log per-task removal events
// below).
router.delete('/:id', async (req, res, next) => {
    try {
        const existing = await loadSprintForRead(req, req.params.id);
        requireCapability(req, CAPABILITIES.SPRINT_DELETE);
        if (existing.status !== 'PLANNED' && !isAdmin(req)) {
            throw httpError(
                400,
                'Only planned sprints can be deleted. Active sprints must be closed first.',
            );
        }
        // Detach any tasks before delete — the FK is ON DELETE SET NULL
        // so this isn't strictly required, but doing it explicitly lets
        // us log per-task removal events for the audit trail.
        const attached = await prisma.task.findMany({
            where: { sprintId: existing.id },
            select: { id: true, title: true, code: true },
        });
        await prisma.task.updateMany({
            where: { sprintId: existing.id },
            data: { sprintId: null },
        });
        for (const t of attached) {
            await logSprintActivity(
                'TASK_REMOVED_FROM_SPRINT',
                req,
                existing.projectId,
                {
                    sprintId: existing.id,
                    sprintName: existing.name,
                    taskId: t.id,
                    taskTitle: t.title,
                    taskCode: t.code,
                    reason: 'sprint deleted',
                },
            );
        }
        await prisma.sprint.delete({ where: { id: existing.id } });
        await logSprintActivity(
            'SPRINT_DELETED',
            req,
            existing.projectId,
            { sprintId: existing.id, sprintName: existing.name },
        );
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// POST /api/sprints/bulk-delete
// Drop a series of sprints in one round-trip. Body shape:
//   { projectId: string, ids: string[] }
//
// Use case: the schedule generator just spun up 100 planned sprints
// because the user fat-fingered the lookahead — clicking 100 trash
// buttons one-by-one is painful and noisy in the audit feed.
//
// Authorization:
//   - Caller must hold `sprint:delete` (same as single delete).
//   - Each sprint must belong to `projectId` (rejected otherwise).
//   - Non-admins can only nuke PLANNED sprints; admins can nuke any
//     status (matches single-delete behaviour).
//
// Implementation notes:
//   - We batch the task detach + sprint delete via `deleteMany` /
//     `updateMany` so the round-trips are O(buckets), not O(sprints).
//   - We emit ONE combined `SPRINT_BULK_DELETED` activity event with
//     the sprint names + the count of detached tasks, instead of
//     hundreds of individual SPRINT_DELETED / TASK_REMOVED_FROM_SPRINT
//     rows — the audit feed stays readable when somebody cleans up a
//     runaway schedule. (Per-sprint delete still uses the granular
//     events for the single-item case.)
const bulkDeleteSchema = z.object({
    projectId: z.string().min(1),
    ids: z.array(z.string().min(1)).min(1).max(500),
});
router.post('/bulk-delete', async (req, res, next) => {
    try {
        const data = bulkDeleteSchema.parse(req.body);
        await assertProjectRead(req, data.projectId);
        requireCapability(req, CAPABILITIES.SPRINT_DELETE);
        // Dedupe in case the client sent the same id twice.
        const uniqueIds = Array.from(new Set(data.ids));
        // Fetch the candidates first so we can authorise per-status
        // and report which ones we skipped (active / closed without
        // admin, or that just don't belong to the project).
        const candidates = await prisma.sprint.findMany({
            where: { id: { in: uniqueIds }, projectId: data.projectId },
            select: { id: true, name: true, status: true },
        });
        const admin = isAdmin(req);
        const deletable = [];
        const skipped = [];
        const knownIds = new Set(candidates.map((c) => c.id));
        for (const id of uniqueIds) {
            if (!knownIds.has(id)) {
                skipped.push({ id, reason: 'not found in project' });
            }
        }
        for (const c of candidates) {
            if (c.status !== 'PLANNED' && !admin) {
                skipped.push({
                    id: c.id,
                    name: c.name,
                    reason: 'only planned sprints can be bulk-deleted',
                });
            } else {
                deletable.push(c);
            }
        }
        let deleted = 0;
        let tasksDetached = 0;
        if (deletable.length > 0) {
            const ids = deletable.map((d) => d.id);
            // Detach tasks first (FK is SET NULL anyway, but doing it
            // explicitly lets us log a count). Single updateMany.
            const detachResult = await prisma.task.updateMany({
                where: { sprintId: { in: ids } },
                data: { sprintId: null },
            });
            tasksDetached = detachResult.count;
            // Then delete the sprints themselves. Single deleteMany.
            const delResult = await prisma.sprint.deleteMany({
                where: { id: { in: ids } },
            });
            deleted = delResult.count;
            await logSprintActivity(
                'SPRINT_BULK_DELETED',
                req,
                data.projectId,
                {
                    deleted,
                    tasksDetached,
                    sprints: deletable.map((d) => ({
                        sprintId: d.id,
                        sprintName: d.name,
                        status: d.status,
                    })),
                },
            );
        }
        res.json({ deleted, tasksDetached, skipped });
    } catch (err) {
        next(err);
    }
});

// POST /api/sprints/:id/start
// PLANNED -> ACTIVE. Enforces "one ACTIVE sprint per project" by
// flipping any other ACTIVE sprint to CLOSED first would be too
// aggressive — instead we reject the start with a clear 409 so the
// human has to explicitly close the old one.
router.post('/:id/start', async (req, res, next) => {
    try {
        const existing = await loadSprintForRead(req, req.params.id);
        requireCapability(req, CAPABILITIES.SPRINT_START);
        if (existing.status === 'ACTIVE') {
            return res.json({ sprint: existing });
        }
        if (existing.status === 'CLOSED') {
            throw httpError(
                400,
                'Closed sprints cannot be started. Use reopen instead.',
            );
        }
        const otherActive = await prisma.sprint.findFirst({
            where: {
                projectId: existing.projectId,
                status: 'ACTIVE',
                id: { not: existing.id },
            },
            select: { id: true, name: true },
        });
        if (otherActive) {
            throw httpError(
                409,
                `Project already has an active sprint ("${otherActive.name}"). Close it before starting a new one.`,
            );
        }
        const updated = await prisma.sprint.update({
            where: { id: existing.id },
            data: { status: 'ACTIVE', startedAt: new Date() },
        });
        // Write an immediate snapshot so the burndown chart has a
        // day-zero baseline even before the nightly job runs.
        await writeSprintSnapshot(updated.id).catch(() => {});
        await logSprintActivity(
            'SPRINT_STARTED',
            req,
            existing.projectId,
            { sprintId: updated.id, sprintName: updated.name },
        );
        res.json({ sprint: updated });
    } catch (err) {
        next(err);
    }
});

// POST /api/sprints/:id/close
// ACTIVE -> CLOSED with one of three strategies for incomplete tasks.
router.post('/:id/close', async (req, res, next) => {
    try {
        const { strategy } = closeSchema.parse(req.body);
        const existing = await loadSprintForRead(req, req.params.id);
        requireCapability(req, CAPABILITIES.SPRINT_CLOSE);
        if (existing.status !== 'ACTIVE') {
            throw httpError(400, 'Only active sprints can be closed');
        }

        // === HISTORICAL CAPTURE ===
        // Before we touch any task assignments, freeze:
        //   1. The full list of top-level task IDs that belong to
        //      this sprint right now (closedTaskIds on the Sprint).
        //   2. A SprintSnapshot row computed against that list.
        //
        // This is the fix for "closed sprint burndown is empty / all
        // data shows up in the next sprint": if we snapshot AFTER
        // moving incomplete tasks out, the snapshot only sees the
        // (now lonely) DONE tasks and the closed sprint looks like
        // it had no scope at all. Capturing first preserves the
        // end-of-sprint reality regardless of the strategy below.
        const sprintTopLevelTasks = await prisma.task.findMany({
            where: { sprintId: existing.id, parentTaskId: null },
            select: { id: true, status: true },
        });
        const closedTaskIds = sprintTopLevelTasks.map((t) => t.id);
        // Snapshot now (pre-move) using the explicit task list so the
        // result is the authoritative end-of-sprint row even if
        // someone races a task update between this and the move.
        await writeSprintSnapshot(existing.id, {
            taskIds: closedTaskIds,
        }).catch((err) =>
            console.warn(
                '[sprints] pre-close snapshot failed:',
                err?.message,
            ),
        );

        // Find incomplete tasks attached to this sprint. Subtasks are
        // included via their parent's status only — we don't move
        // subtasks independently of their parents.
        const incomplete = sprintTopLevelTasks.filter(
            (t) => t.status !== 'DONE',
        );

        let movedTo = null;
        if (strategy === 'PUSH_TO_NEXT' && incomplete.length > 0) {
            // Pick the next chronological PLANNED sprint in the same
            // project. If none exists we fall back to BACK_TO_BACKLOG
            // so we don't silently leave the tasks on a CLOSED sprint.
            const next = await prisma.sprint.findFirst({
                where: {
                    projectId: existing.projectId,
                    status: 'PLANNED',
                    startDate: { gte: existing.endDate },
                },
                orderBy: { startDate: 'asc' },
                select: { id: true, name: true },
            });
            if (next) {
                movedTo = next;
                await prisma.task.updateMany({
                    where: { id: { in: incomplete.map((t) => t.id) } },
                    data: { sprintId: next.id },
                });
            } else {
                await prisma.task.updateMany({
                    where: { id: { in: incomplete.map((t) => t.id) } },
                    data: { sprintId: null },
                });
            }
        } else if (strategy === 'BACK_TO_BACKLOG' && incomplete.length > 0) {
            await prisma.task.updateMany({
                where: { id: { in: incomplete.map((t) => t.id) } },
                data: { sprintId: null },
            });
        }
        // 'KEEP' is a no-op — tasks stay attached for historical reads.

        const closed = await prisma.sprint.update({
            where: { id: existing.id },
            data: {
                status: 'CLOSED',
                closedAt: new Date(),
                // Persist the membership snapshot so closed-sprint
                // reads can resolve tasks even after the live
                // `sprintId` on those tasks has changed.
                closedTaskIds,
            },
        });
        // Intentionally NOT calling writeSprintSnapshot here — the
        // pre-move snapshot above is the authoritative one. A second
        // post-move snapshot would just add a misleading row that
        // looks like the sprint shrank at the very end.
        await logSprintActivity(
            'SPRINT_CLOSED',
            req,
            existing.projectId,
            {
                sprintId: closed.id,
                sprintName: closed.name,
                strategy,
                movedTo: movedTo
                    ? { sprintId: movedTo.id, sprintName: movedTo.name }
                    : null,
                movedTaskCount: movedTo
                    ? incomplete.length
                    : strategy === 'BACK_TO_BACKLOG'
                        ? incomplete.length
                        : 0,
            },
        );
        res.json({ sprint: closed, movedTo, movedTaskCount: incomplete.length });
    } catch (err) {
        next(err);
    }
});

// POST /api/sprints/:id/reopen
// CLOSED -> ACTIVE. Refuses if another ACTIVE sprint already exists
// in the same project (same invariant as start).
router.post('/:id/reopen', async (req, res, next) => {
    try {
        const existing = await loadSprintForRead(req, req.params.id);
        requireCapability(req, CAPABILITIES.SPRINT_START);
        if (existing.status !== 'CLOSED') {
            throw httpError(400, 'Only closed sprints can be reopened');
        }
        const otherActive = await prisma.sprint.findFirst({
            where: {
                projectId: existing.projectId,
                status: 'ACTIVE',
                id: { not: existing.id },
            },
            select: { id: true, name: true },
        });
        if (otherActive) {
            throw httpError(
                409,
                `Project already has an active sprint ("${otherActive.name}"). Close it first.`,
            );
        }
        const updated = await prisma.sprint.update({
            where: { id: existing.id },
            data: { status: 'ACTIVE', closedAt: null },
        });
        await logSprintActivity(
            'SPRINT_REOPENED',
            req,
            existing.projectId,
            { sprintId: updated.id, sprintName: updated.name },
        );
        res.json({ sprint: updated });
    } catch (err) {
        next(err);
    }
});

// POST /api/sprints/:id/tasks  { taskIds: [...] }
// Attach one or more tasks to the sprint. Tasks must belong to the
// same project as the sprint (caller can't move a task across
// projects). Top-level tasks are assigned via `sprintId`. Subtasks
// are not given their own sprintId — they ride under their parent —
// but you MAY pass subtask ids here: we attach the parent task to
// this sprint so every subtask underneath becomes visible on the
// board.
router.post('/:id/tasks', async (req, res, next) => {
    try {
        const { taskIds } = taskAddSchema.parse(req.body);
        const sprint = await loadSprintForRead(req, req.params.id);
        if (!canMoveSprintTasks(req)) {
            throw httpError(
                403,
                'You do not have permission to move tasks in/out of sprints',
            );
        }
        if (sprint.status === 'CLOSED') {
            throw httpError(
                400,
                'Cannot add tasks to a closed sprint',
            );
        }
        const requested = await prisma.task.findMany({
            where: { id: { in: taskIds } },
            select: {
                id: true,
                title: true,
                code: true,
                projectId: true,
                parentTaskId: true,
                sprintId: true,
            },
        });
        const byId = new Map(requested.map((t) => [t.id, t]));
        const parentIds = [
            ...new Set(
                requested
                    .map((t) => t.parentTaskId)
                    .filter(Boolean),
            ),
        ];
        const parents = parentIds.length
            ? await prisma.task.findMany({
                  where: { id: { in: parentIds } },
                  select: {
                      id: true,
                      title: true,
                      code: true,
                      projectId: true,
                      sprintId: true,
                  },
              })
            : [];
        const parentById = new Map(parents.map((p) => [p.id, p]));

        const attachParentIds = new Set();
        const logRows = [];

        for (const id of taskIds) {
            const t = byId.get(id);
            if (!t || t.projectId !== sprint.projectId) continue;

            if (!t.parentTaskId) {
                if (t.sprintId === sprint.id) continue;
                if (t.sprintId && t.sprintId !== sprint.id) {
                    throw httpError(
                        409,
                        `"${t.title}" belongs to another sprint`,
                    );
                }
                attachParentIds.add(t.id);
                logRows.push({ task: t, viaSubtask: null });
                continue;
            }

            const parent = parentById.get(t.parentTaskId);
            if (!parent || parent.projectId !== sprint.projectId) continue;
            if (parent.sprintId === sprint.id) continue;
            if (parent.sprintId && parent.sprintId !== sprint.id) {
                throw httpError(
                    409,
                    `Parent "${parent.title}" belongs to another sprint`,
                );
            }
            if (!attachParentIds.has(parent.id)) {
                attachParentIds.add(parent.id);
                logRows.push({ task: parent, viaSubtask: t });
            }
        }

        if (attachParentIds.size === 0) {
            return res.json({ ok: true, added: 0 });
        }

        const attachList = [...attachParentIds];
        await prisma.task.updateMany({
            where: { id: { in: attachList } },
            data: { sprintId: sprint.id },
        });

        for (const row of logRows) {
            await logSprintActivity(
                'TASK_ADDED_TO_SPRINT',
                req,
                sprint.projectId,
                {
                    sprintId: sprint.id,
                    sprintName: sprint.name,
                    taskId: row.task.id,
                    taskTitle: row.task.title,
                    taskCode: row.task.code,
                    previousSprintId: row.task.sprintId || null,
                    ...(row.viaSubtask
                        ? {
                              viaSubtaskId: row.viaSubtask.id,
                              viaSubtaskTitle: row.viaSubtask.title,
                          }
                        : {}),
                },
            );
        }
        res.json({ ok: true, added: attachList.length });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/sprints/:id/tasks/:taskId
router.delete('/:id/tasks/:taskId', async (req, res, next) => {
    try {
        const sprint = await loadSprintForRead(req, req.params.id);
        if (!canMoveSprintTasks(req)) {
            throw httpError(
                403,
                'You do not have permission to move tasks in/out of sprints',
            );
        }
        if (sprint.status === 'CLOSED') {
            throw httpError(
                400,
                'Cannot remove tasks from a closed sprint',
            );
        }
        const task = await prisma.task.findUnique({
            where: { id: req.params.taskId },
            select: { id: true, title: true, code: true, sprintId: true },
        });
        if (!task || task.sprintId !== sprint.id) {
            throw httpError(404, 'Task not found in this sprint');
        }
        await prisma.task.update({
            where: { id: task.id },
            data: { sprintId: null },
        });
        await logSprintActivity(
            'TASK_REMOVED_FROM_SPRINT',
            req,
            sprint.projectId,
            {
                sprintId: sprint.id,
                sprintName: sprint.name,
                taskId: task.id,
                taskTitle: task.title,
                taskCode: task.code,
            },
        );
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// PUT /api/sprints/:id/capacity
// Replace the per-user planned hours for the sprint. Missing entries
// (users not in the body) are deleted so the caller can drive the
// final state in one call.
router.put('/:id/capacity', async (req, res, next) => {
    try {
        const { entries } = capacityPutSchema.parse(req.body);
        const sprint = await loadSprintForRead(req, req.params.id);
        requireCapability(req, CAPABILITIES.SPRINT_EDIT);
        if (sprint.status === 'CLOSED') {
            throw httpError(400, 'Cannot change capacity on a closed sprint');
        }
        await prisma.$transaction(async (tx) => {
            const keepIds = entries.map((e) => e.userId);
            await tx.sprintCapacity.deleteMany({
                where: {
                    sprintId: sprint.id,
                    userId: { notIn: keepIds.length > 0 ? keepIds : [''] },
                },
            });
            for (const e of entries) {
                await tx.sprintCapacity.upsert({
                    where: {
                        sprintId_userId: {
                            sprintId: sprint.id,
                            userId: e.userId,
                        },
                    },
                    create: {
                        sprintId: sprint.id,
                        userId: e.userId,
                        plannedHours: e.plannedHours,
                    },
                    update: { plannedHours: e.plannedHours },
                });
            }
        });
        const capacity = await prisma.sprintCapacity.findMany({
            where: { sprintId: sprint.id },
            include: {
                user: { select: { id: true, name: true, avatarUrl: true } },
            },
        });
        res.json({ capacity });
    } catch (err) {
        next(err);
    }
});

// GET /api/sprints/:id/time-entries
// Returns every TimeEntry whose task belongs to this sprint, plus
// the rolled-up total. Powers the "show me how Logged was counted"
// inspector under the Sprint Board KPI strip — if the sum here ever
// disagrees with the KPI it's a bug in serializeSprintDetail's
// roll-up math (or the matching writeSprintSnapshot path). Mirrors
// the shape of /api/time so the frontend can reuse the same entry
// rendering helpers.
//
// Access: same read gate as the rest of the sprint endpoints — if
// you can read the sprint, you can see the contributing entries.
// Each entry's row already carries the user, so non-admins viewing
// a project they're a participant on will see other people's
// contributions; that's the same exposure the All-Users tab gives
// admins, just scoped to one sprint.
router.get('/:id/time-entries', async (req, res, next) => {
    try {
        const sprint = await loadSprintForRead(req, req.params.id);
        // Gather every task that "belongs" to this sprint for the
        // purposes of time roll-up: the top-level tasks AND every
        // subtask underneath them. Subtasks have their own sprintId
        // set to NULL by design (they inherit the parent's sprint
        // membership), so the OR clause below catches them.
        //
        // For CLOSED sprints we use the frozen `closedTaskIds` list
        // (captured by the close handler before any tasks were
        // moved out) — otherwise the inspector would only see the
        // DONE tasks that stayed put, and would silently under-
        // count exactly like the KPI used to.
        const membership = resolveSprintTaskIds(sprint);
        const tasks = await prisma.task.findMany({
            where:
                membership.mode === 'frozen'
                    ? {
                          OR: [
                              { id: { in: membership.ids } },
                              { parentTaskId: { in: membership.ids } },
                          ],
                      }
                    : {
                          OR: [
                              { sprintId: sprint.id },
                              { parent: { sprintId: sprint.id } },
                          ],
                      },
            select: { id: true },
        });
        const taskIds = tasks.map((t) => t.id);
        if (taskIds.length === 0) {
            return res.json({
                entries: [],
                total: { seconds: 0, hours: 0, count: 0 },
            });
        }
        const entries = await prisma.timeEntry.findMany({
            where: { taskId: { in: taskIds } },
            orderBy: { startedAt: 'desc' },
            select: {
                id: true,
                startedAt: true,
                endedAt: true,
                durationSeconds: true,
                description: true,
                source: true,
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        avatarUrl: true,
                    },
                },
                project: {
                    select: { id: true, code: true, name: true },
                },
                task: {
                    select: {
                        id: true,
                        code: true,
                        title: true,
                        parent: {
                            select: { id: true, code: true, title: true },
                        },
                    },
                },
            },
            take: 2000,
        });
        const totalSeconds = entries.reduce(
            (acc, e) => acc + (e.durationSeconds || 0),
            0,
        );
        res.json({
            entries,
            total: {
                seconds: totalSeconds,
                // Two-decimal hours match counters.loggedHours format
                // used by the KPI so the inspector and the KPI never
                // disagree if the math is right.
                hours: Math.round((totalSeconds / 3600) * 100) / 100,
                count: entries.length,
            },
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/sprints/:id/burndown
// Returns: { startDate, endDate, totalHours, ideal: [{day,hours}],
//   actual: [{day,hours}], days: number, snapshots: [...] }
//
// The ideal line is a straight-line burndown from totalHours -> 0
// across the sprint days. The actual line is built from
// SprintSnapshot rows (one per day captured by the background job).
// The frontend overlays both.
router.get('/:id/burndown', async (req, res, next) => {
    try {
        const sprint = await loadSprintForRead(req, req.params.id);
        const snapshots = await prisma.sprintSnapshot.findMany({
            where: { sprintId: sprint.id },
            orderBy: { capturedAt: 'asc' },
        });
        const totalDays = Math.max(
            1,
            Math.round(
                (sprint.endDate.getTime() - sprint.startDate.getTime()) /
                    (24 * 60 * 60 * 1000),
            ),
        );

        // The "total hours" used to size the ideal line depends on
        // the sprint's life-cycle state:
        //   - ACTIVE / PLANNED: recompute live so adding/removing
        //     tasks mid-sprint is reflected immediately. Also append
        //     a synthetic "today" snapshot so the chart has a tail
        //     between nightly snapshot rows.
        //   - CLOSED: trust the snapshots already on disk. The
        //     close handler captured a snapshot BEFORE moving
        //     incomplete tasks, so `serializeSprintDetail` would
        //     redundantly hit the same numbers — but if we ran it
        //     anyway, any legacy closed sprints without the new
        //     `closedTaskIds` field would fall back to the live
        //     `sprintId` query and report a hollow scope. Skipping
        //     the live overlay keeps closed sprints stable.
        let totalHours;
        let outSnapshots;
        if (sprint.status === 'CLOSED') {
            // Use the latest snapshot's totalHours as the baseline.
            // For sprints closed with the new handler this is the
            // pre-move state — i.e. the real end-of-sprint scope.
            const latest = snapshots[snapshots.length - 1];
            totalHours = latest?.totalHours || 0;
            outSnapshots = snapshots;
        } else {
            const liveDetail = await serializeSprintDetail(sprint);
            const liveRemaining =
                liveDetail.counters.totalHours -
                liveDetail.counters.completedHours;
            const liveSnapshot = {
                id: 'live',
                sprintId: sprint.id,
                capturedAt: new Date(),
                totalTasks: liveDetail.counters.totalTasks,
                completedTasks: liveDetail.counters.completedTasks,
                totalHours: liveDetail.counters.totalHours,
                remainingHours: Math.max(0, liveRemaining),
                loggedHours: liveDetail.counters.loggedHours,
            };
            totalHours = liveDetail.counters.totalHours;
            outSnapshots = [...snapshots, liveSnapshot];
        }

        const ideal = [];
        for (let i = 0; i <= totalDays; i++) {
            ideal.push({
                day: i,
                hours: totalHours * (1 - safeRatio(i, totalDays)),
            });
        }
        res.json({
            sprint: {
                id: sprint.id,
                name: sprint.name,
                status: sprint.status,
                startDate: sprint.startDate,
                endDate: sprint.endDate,
            },
            totalHours,
            days: totalDays,
            ideal,
            snapshots: outSnapshots,
        });
    } catch (err) {
        next(err);
    }
});

// --- background snapshot writer ------------------------------------------
// Exported so the daily-sweep scheduler can call it. Also called inline
// from start + close so the chart always has at least one row.
// Writes a SprintSnapshot row for the given sprint.
//
// Options:
//   - taskIds: explicit top-level task IDs to roll up. When set
//     (used by the close handler), we ignore Task.sprintId and use
//     this list as the source of truth. This is what lets us
//     snapshot the *end-of-sprint state* before incomplete tasks
//     are moved to the next sprint.
//   - When omitted (used by the start handler + the daily
//     background sweep), we query live by Task.sprintId — the
//     usual "what's currently in this sprint" behaviour.
async function writeSprintSnapshot(sprintId, { taskIds = null } = {}) {
    const sprint = await prisma.sprint.findUnique({
        where: { id: sprintId },
        select: { id: true },
    });
    if (!sprint) return;
    const useExplicit = Array.isArray(taskIds);
    const tasks = await prisma.task.findMany({
        where: useExplicit
            ? { id: { in: taskIds }, parentTaskId: null }
            : { sprintId, parentTaskId: null },
        select: { status: true, estimateHours: true },
    });
    const logged = await prisma.timeEntry.aggregate({
        // See serializeSprintDetail for the rationale — subtask time
        // must be rolled up under the parent's sprint membership,
        // otherwise the nightly snapshot (and therefore the burndown
        // chart's actual line) silently under-counts.
        where: useExplicit
            ? {
                  task: {
                      OR: [
                          { id: { in: taskIds } },
                          { parentTaskId: { in: taskIds } },
                      ],
                  },
              }
            : {
                  task: {
                      OR: [
                          { sprintId },
                          { parent: { sprintId } },
                      ],
                  },
              },
        _sum: { durationSeconds: true },
    });
    const totalHours = tasks.reduce(
        (a, t) => a + (typeof t.estimateHours === 'number' ? t.estimateHours : 0),
        0,
    );
    const completedHours = tasks
        .filter((t) => t.status === 'DONE')
        .reduce(
            (a, t) =>
                a + (typeof t.estimateHours === 'number' ? t.estimateHours : 0),
            0,
        );
    const loggedSeconds = logged?._sum?.durationSeconds || 0;
    await prisma.sprintSnapshot.create({
        data: {
            sprintId,
            totalTasks: tasks.length,
            completedTasks: tasks.filter((t) => t.status === 'DONE').length,
            totalHours,
            remainingHours: Math.max(0, totalHours - completedHours),
            loggedHours: Math.round((loggedSeconds / 3600) * 100) / 100,
        },
    });
}

// Called by the daily scheduler — writes one row per ACTIVE sprint
// across the whole workspace. Cheap because we only touch sprints
// flagged ACTIVE (typically a handful).
async function snapshotAllActiveSprints() {
    try {
        const active = await prisma.sprint.findMany({
            where: { status: 'ACTIVE' },
            select: { id: true },
        });
        for (const s of active) {
            await writeSprintSnapshot(s.id).catch((err) =>
                console.warn(`[sprints] snapshot failed for ${s.id}:`, err.message),
            );
        }
        if (active.length > 0) {
            console.log(`[sprints] wrote ${active.length} burndown snapshot(s)`);
        }
    } catch (err) {
        console.warn('[sprints] snapshotAllActiveSprints failed:', err.message);
    }
}

module.exports = router;
module.exports.writeSprintSnapshot = writeSprintSnapshot;
module.exports.snapshotAllActiveSprints = snapshotAllActiveSprints;
