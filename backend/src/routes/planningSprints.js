// Planning sprints (cross-project, team-scoped).
//
// Unlike project `Sprint`s, a PlanningSprint is NOT tied to a single
// project. Admins / managers curate tasks from ANY project into it so
// they can plan a window of work for a specific team (or org-wide).
// Planning-sprint membership lives in the PlanningSprintTask join table
// and is completely independent of `Task.sprintId`, so a task can sit in
// its project sprint AND a planning sprint at the same time.
//
// API surface (mounted at /api/planning-sprints):
//
//   GET    /?status=&teamId=               list planning sprints (grouped)
//   POST   /                               create
//   GET    /:id                            detail (sprint + tasks)
//   PATCH  /:id                            edit (name/goal/dates/team)
//   DELETE /:id                            delete
//
//   POST   /:id/start                      PLANNED -> ACTIVE
//   POST   /:id/close                      ACTIVE -> CLOSED (+ strategy)
//   POST   /:id/reopen                     CLOSED -> ACTIVE
//
//   POST   /:id/tasks                      add tasks (taskIds[])
//   DELETE /:id/tasks/:taskId              remove a task
//
//   GET    /backlog/tasks                  search tasks to add (cross-project)
//
// Permissions:
//   - Every endpoint requires admin OR manager. Admins see all projects;
//     managers are scoped to their accessible projects for both reading
//     planning-sprint task lists and searching the backlog.

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    isAdmin,
    isAdminOrManager,
    accessibleProjectIds,
} = require('../lib/permissions');
const { logActivityEvent } = require('../lib/activityLog');
const {
    materializeNextPlanningSprints,
    previewNextPlanningSprints,
    defaultDurationDays,
} = require('../lib/planningSprintScheduler');

const router = express.Router();
router.use(requireAuth);

// --- access gate -----------------------------------------------------------

// Planning sprints are an admin/manager planning tool. Everything in
// this router is behind the same gate.
function requirePlanner(req) {
    if (!isAdminOrManager(req)) {
        throw httpError(403, 'Only admins or managers can manage planning sprints');
    }
}

// Project-scope filter for the cross-project task reads. Admins get an
// empty clause (all projects); managers get an `in` list of the
// projects they can read. Returns { scope, ids } where `ids` is null
// for admins.
async function plannerProjectScope(req) {
    if (isAdmin(req)) return { all: true, ids: null };
    const ids = await accessibleProjectIds(req);
    return { all: false, ids };
}

// --- validation ------------------------------------------------------------

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

const createSchema = z
    .object({
        name: z.string().trim().min(1).max(120),
        goal: z.string().trim().max(500).optional().nullable(),
        teamId: z.string().min(1).optional().nullable(),
        startDate: dayDate,
        endDate: dayDate,
    })
    .refine((d) => d.endDate.getTime() > d.startDate.getTime(), {
        message: 'End date must be after start date',
        path: ['endDate'],
    });

const patchSchema = z
    .object({
        name: z.string().trim().min(1).max(120).optional(),
        goal: z.string().trim().max(500).optional().nullable(),
        teamId: z.string().min(1).optional().nullable(),
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
    // KEEP            — leave tasks attached (retrospective reporting).
    // PUSH_TO_NEXT    — move incomplete tasks to the next PLANNED planning
    //                   sprint for the same team (chronological by start).
    // BACK_TO_BACKLOG — detach incomplete tasks (drop planning membership).
    strategy: z.enum(['KEEP', 'PUSH_TO_NEXT', 'BACK_TO_BACKLOG']),
});

const taskAddSchema = z.object({
    taskIds: z.array(z.string().min(1)).min(1).max(200),
});

// Mirror of the project-sprint capacity payload: the caller sends the
// FULL desired state; users missing from the body are deleted.
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

// Upsert schema for the per-team planning scheduler. teamId is optional
// (null/omitted = org-wide). namePattern supports the same tokens as the
// project scheduler; {n} is server-managed but `startNumber` can seed it
// on first create.
const scheduleUpsertSchema = z.object({
    teamId: z.string().min(1).optional().nullable(),
    cadence: z.enum(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']),
    enabled: z.boolean().optional().default(true),
    anchorDate: dayDate,
    namePattern: z.string().trim().min(1).max(80).optional(),
    goal: z.string().trim().max(500).optional().nullable(),
    lookahead: z.number().int().min(1).max(10).optional(),
    startNumber: z.number().int().min(1).max(100000).optional(),
});

// --- helpers ---------------------------------------------------------------

// Validate an optional team id actually exists. Returns the team row
// (or null when no team was given).
async function resolveTeam(teamId) {
    if (!teamId) return null;
    const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: { id: true, name: true, color: true },
    });
    if (!team) throw httpError(400, 'Team not found');
    return team;
}

// Task select used for the planning board — carries project + assignee
// info because the board is explicitly cross-project.
const PLANNING_TASK_SELECT = {
    id: true,
    code: true,
    title: true,
    description: true,
    status: true,
    priority: true,
    dueDate: true,
    createdAt: true,
    estimateHours: true,
    assigneeId: true,
    parentTaskId: true,
    assignee: { select: { id: true, name: true, avatarUrl: true } },
    project: { select: { id: true, name: true, isPersonal: true } },
    phase: { select: { id: true, name: true } },
    createdBy: { select: { id: true, name: true, avatarUrl: true } },
    // Subtasks ride along with their parent for visibility on the
    // planning board — same contract as the project sprint board.
    // They are NOT planning-sprint members themselves; they inherit
    // the parent's membership for display purposes only. Counters /
    // burndown ignore them (parent-task semantics stay the source
    // of truth for "what counts as done").
    subtasks: {
        // Soft-deleted subtasks must not leak — the Prisma client
        // extension on top-level reads cannot reach nested includes.
        where: { deletedAt: null },
        select: {
            id: true,
            code: true,
            title: true,
            status: true,
            priority: true,
            estimateHours: true,
            assigneeId: true,
            assignee: { select: { id: true, name: true, avatarUrl: true } },
        },
        orderBy: [
            { status: 'asc' },
            { priority: 'asc' },
            { createdAt: 'asc' },
        ],
    },
};

// Load a planning sprint, 404 when missing.
async function loadPlanningSprint(id) {
    const sprint = await prisma.planningSprint.findUnique({
        where: { id },
        include: {
            team: { select: { id: true, name: true, color: true } },
            createdBy: { select: { id: true, name: true, avatarUrl: true } },
        },
    });
    if (!sprint) throw httpError(404, 'Planning sprint not found');
    return sprint;
}

// Build the detail shape: sprint row + task list (scoped for managers)
// + small counters. Managers only see tasks from projects they can
// access; tasks from other projects are silently filtered out so a
// manager's board never leaks task titles from projects they can't see.
async function serializePlanningDetail(req, sprint) {
    const scope = await plannerProjectScope(req);

    const links = await prisma.planningSprintTask.findMany({
        where: { planningSprintId: sprint.id },
        orderBy: { addedAt: 'asc' },
        select: { taskId: true },
    });
    const taskIds = links.map((l) => l.taskId);

    const taskWhere = {
        id: { in: taskIds },
        deletedAt: null,
        ...(scope.all ? {} : { projectId: { in: scope.ids } }),
    };

    const tasks = taskIds.length
        ? await prisma.task.findMany({
              where: taskWhere,
              select: PLANNING_TASK_SELECT,
              orderBy: [
                  { status: 'asc' },
                  { priority: 'asc' },
                  { createdAt: 'asc' },
              ],
          })
        : [];

    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t) => t.status === 'DONE').length;
    const hoursOf = (t) =>
        typeof t.estimateHours === 'number' ? t.estimateHours : 0;
    const totalHours = tasks.reduce((acc, t) => acc + hoursOf(t), 0);
    const completedHours = tasks
        .filter((t) => t.status === 'DONE')
        .reduce((acc, t) => acc + hoursOf(t), 0);

    // Logged hours + capacity ride along like on the project board.
    // Logged time is aggregated over the SCOPED task set (and their
    // subtasks) so a manager's counters never include hours from
    // projects they can't read.
    const scopedIds = tasks.map((t) => t.id);
    const [capacity, logged] = await Promise.all([
        prisma.planningSprintCapacity.findMany({
            where: { planningSprintId: sprint.id },
            include: {
                user: { select: { id: true, name: true, avatarUrl: true } },
            },
        }),
        scopedIds.length
            ? prisma.timeEntry.aggregate({
                  where: {
                      sourceEntryId: null,
                      task: {
                          OR: [
                              { id: { in: scopedIds } },
                              { parentTaskId: { in: scopedIds } },
                          ],
                      },
                  },
                  _sum: { durationSeconds: true },
              })
            : null,
    ]);
    const loggedSeconds = logged?._sum?.durationSeconds || 0;
    const loggedHours = Math.round((loggedSeconds / 3600) * 100) / 100;

    return {
        ...sprint,
        tasks,
        capacity,
        counters: {
            totalTasks,
            completedTasks,
            totalHours,
            completedHours,
            loggedHours,
        },
    };
}

// Roll up the task set committed to a planning sprint into burndown
// numbers. `taskIds` are the top-level tasks in the join table; logged
// time rolls subtask entries up under their parent (mirrors the project
// sprint snapshot logic). Returns counters used by both the live
// burndown overlay and the persisted snapshot row.
async function planningTaskRollup(taskIds) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
        return {
            totalTasks: 0,
            completedTasks: 0,
            totalHours: 0,
            completedHours: 0,
            loggedHours: 0,
        };
    }
    const tasks = await prisma.task.findMany({
        where: { id: { in: taskIds }, parentTaskId: null, deletedAt: null },
        select: { status: true, estimateHours: true },
    });
    const logged = await prisma.timeEntry.aggregate({
        where: {
            sourceEntryId: null,
            task: {
                OR: [
                    { id: { in: taskIds } },
                    { parentTaskId: { in: taskIds } },
                ],
            },
        },
        _sum: { durationSeconds: true },
    });
    const hoursOf = (t) =>
        typeof t.estimateHours === 'number' ? t.estimateHours : 0;
    const totalHours = tasks.reduce((a, t) => a + hoursOf(t), 0);
    const completedHours = tasks
        .filter((t) => t.status === 'DONE')
        .reduce((a, t) => a + hoursOf(t), 0);
    const loggedSeconds = logged?._sum?.durationSeconds || 0;
    return {
        totalTasks: tasks.length,
        completedTasks: tasks.filter((t) => t.status === 'DONE').length,
        totalHours,
        completedHours,
        loggedHours: Math.round((loggedSeconds / 3600) * 100) / 100,
    };
}

// Write one PlanningSprintSnapshot. When `taskIds` is provided (close
// handler) we use it verbatim; otherwise we read the current join-table
// membership. Best-effort — callers wrap in try/catch.
async function writePlanningSprintSnapshot(planningSprintId, { taskIds = null } = {}) {
    const sprint = await prisma.planningSprint.findUnique({
        where: { id: planningSprintId },
        select: { id: true },
    });
    if (!sprint) return;
    let ids = taskIds;
    if (!Array.isArray(ids)) {
        const links = await prisma.planningSprintTask.findMany({
            where: { planningSprintId },
            select: { taskId: true },
        });
        ids = links.map((l) => l.taskId);
    }
    const r = await planningTaskRollup(ids);
    await prisma.planningSprintSnapshot.create({
        data: {
            planningSprintId,
            totalTasks: r.totalTasks,
            completedTasks: r.completedTasks,
            totalHours: r.totalHours,
            remainingHours: Math.max(0, r.totalHours - r.completedHours),
            loggedHours: r.loggedHours,
        },
    });
}

// Daily sweep: one snapshot per ACTIVE planning sprint. Exported for the
// scheduler in lib/planningSprintSnapshots.js.
async function snapshotAllActivePlanningSprints() {
    try {
        const active = await prisma.planningSprint.findMany({
            where: { status: 'ACTIVE' },
            select: { id: true },
        });
        for (const s of active) {
            await writePlanningSprintSnapshot(s.id).catch((err) =>
                console.warn(
                    `[planningSprints] snapshot failed for ${s.id}:`,
                    err.message,
                ),
            );
        }
        if (active.length > 0) {
            console.log(
                `[planningSprints] wrote ${active.length} burndown snapshot(s)`,
            );
        }
    } catch (err) {
        console.warn(
            '[planningSprints] snapshotAllActivePlanningSprints failed:',
            err.message,
        );
    }
}

function safePlanningRatio(num, denom) {
    if (!denom) return 0;
    return num / denom;
}

async function logPlanningActivity(type, req, payload) {
    try {
        await logActivityEvent({
            type,
            actorId: req.user?.id || null,
            meta: payload,
        });
    } catch (err) {
        console.error(`[planningSprints] failed to log ${type}:`, err);
    }
}

// --- routes ----------------------------------------------------------------

// GET /api/planning-sprints?status=&teamId=
// List planning sprints grouped by status with quick counters. Managers
// see all planning sprints (the container itself is not project-scoped),
// but the per-sprint task counts are scoped to projects they can read.
router.get('/', async (req, res, next) => {
    try {
        requirePlanner(req);
        const statusFilter = String(req.query.status || '').trim().toUpperCase();
        const teamId = String(req.query.teamId || '').trim();

        const where = {};
        if (['PLANNED', 'ACTIVE', 'CLOSED'].includes(statusFilter)) {
            where.status = statusFilter;
        }
        if (teamId) where.teamId = teamId;

        const sprints = await prisma.planningSprint.findMany({
            where,
            orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
            include: {
                team: { select: { id: true, name: true, color: true } },
                createdBy: { select: { id: true, name: true } },
                _count: { select: { tasks: true } },
            },
        });

        res.json({ planningSprints: sprints });
    } catch (err) {
        next(err);
    }
});

// POST /api/planning-sprints
router.post('/', async (req, res, next) => {
    try {
        requirePlanner(req);
        const body = createSchema.parse(req.body);
        const team = await resolveTeam(body.teamId);

        const sprint = await prisma.planningSprint.create({
            data: {
                name: body.name,
                goal: body.goal || null,
                teamId: team?.id || null,
                startDate: body.startDate,
                endDate: body.endDate,
                status: 'PLANNED',
                createdById: req.user.id,
            },
            include: {
                team: { select: { id: true, name: true, color: true } },
                createdBy: { select: { id: true, name: true, avatarUrl: true } },
            },
        });

        await logPlanningActivity('PLANNING_SPRINT_CREATED', req, {
            planningSprintId: sprint.id,
            planningSprintName: sprint.name,
            teamId: team?.id || null,
            teamName: team?.name || null,
            startDate: sprint.startDate,
            endDate: sprint.endDate,
        });

        res.status(201).json({ planningSprint: { ...sprint, tasks: [], counters: { totalTasks: 0, completedTasks: 0, totalHours: 0 } } });
    } catch (err) {
        next(err);
    }
});

// --- scheduler (per-team planning cadence) ---------------------------------
//
// These routes MUST be declared before the `/:id` routes so Express
// doesn't interpret "schedule" as a planning-sprint id. The runner keeps
// `lookahead` PLANNED planning sprints in front of each team's timeline;
// see lib/planningSprintScheduler.js for the generator.

// Resolve the teamId query param into a canonical value. '' / 'org' /
// missing all mean the org-wide (null) schedule.
function scheduleTeamKey(raw) {
    const v = String(raw || '').trim();
    if (!v || v === 'org' || v === 'all') return null;
    return v;
}

// GET /api/planning-sprints/schedule?teamId=:id   (omit teamId = org-wide)
router.get('/schedule', async (req, res, next) => {
    try {
        requirePlanner(req);
        const teamId = scheduleTeamKey(req.query.teamId);
        const schedule = await prisma.planningSprintSchedule.findFirst({
            where: { teamId },
            include: {
                team: { select: { id: true, name: true, color: true } },
                createdBy: { select: { id: true, name: true, email: true } },
                updatedBy: { select: { id: true, name: true, email: true } },
            },
        });
        let preview = [];
        if (schedule) {
            const latest = await prisma.planningSprint.findFirst({
                where: { teamId },
                orderBy: [{ endDate: 'desc' }],
                select: { endDate: true },
            });
            preview = previewNextPlanningSprints(
                schedule,
                latest?.endDate || null,
                3,
            );
        }
        res.json({ schedule: schedule || null, preview });
    } catch (err) {
        next(err);
    }
});

// PUT /api/planning-sprints/schedule
// Upsert the schedule for a team (or the org-wide series). Admin/manager
// only. First call seeds nextNumber from startNumber (default 1).
router.put('/schedule', async (req, res, next) => {
    try {
        requirePlanner(req);
        const data = scheduleUpsertSchema.parse(req.body);
        const teamId = data.teamId || null;
        if (teamId) await resolveTeam(teamId);

        const existing = await prisma.planningSprintSchedule.findFirst({
            where: { teamId },
        });
        const namePattern = data.namePattern?.trim() || 'Planning {start}';
        const lookahead = data.lookahead ?? existing?.lookahead ?? 2;
        const durationDays = defaultDurationDays(data.cadence);

        let row;
        if (!existing) {
            row = await prisma.planningSprintSchedule.create({
                data: {
                    teamId,
                    cadence: data.cadence,
                    enabled: data.enabled,
                    anchorDate: data.anchorDate,
                    durationDays,
                    namePattern,
                    goal: data.goal || null,
                    nextNumber: data.startNumber ?? 1,
                    lookahead,
                    createdById: req.user.id,
                },
            });
        } else {
            row = await prisma.planningSprintSchedule.update({
                where: { id: existing.id },
                data: {
                    cadence: data.cadence,
                    enabled: data.enabled,
                    anchorDate: data.anchorDate,
                    durationDays,
                    namePattern,
                    goal: data.goal || null,
                    lookahead,
                    updatedById: req.user.id,
                    ...(typeof data.startNumber === 'number'
                        ? { nextNumber: data.startNumber }
                        : {}),
                },
            });
        }

        // Materialize immediately so the UI shows generated sprints after
        // a single save. Failures here don't block the upsert response.
        try {
            await materializeNextPlanningSprints(row.id);
        } catch (err) {
            console.warn(
                '[planningSprints] immediate materialize after schedule save failed:',
                err.message,
            );
        }

        await logPlanningActivity('PLANNING_SPRINT_SCHEDULE_UPDATED', req, {
            scheduleId: row.id,
            teamId: row.teamId || null,
            cadence: row.cadence,
            enabled: row.enabled,
            anchorDate: row.anchorDate,
            lookahead: row.lookahead,
            namePattern: row.namePattern,
        });

        res.json({ schedule: row });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/planning-sprints/schedule?teamId=:id
// Removes the schedule. ?withPlanned=true also deletes that team's empty
// future PLANNED planning sprints. Use PUT enabled=false to pause
// without losing config.
router.delete('/schedule', async (req, res, next) => {
    try {
        requirePlanner(req);
        const teamId = scheduleTeamKey(req.query.teamId);
        const withPlanned =
            String(req.query.withPlanned || '').toLowerCase() === 'true';

        const existing = await prisma.planningSprintSchedule.findFirst({
            where: { teamId },
        });

        let plannedDeleted = 0;
        if (withPlanned) {
            // Only remove PLANNED, future sprints — never active/closed
            // history. Cascade on PlanningSprintTask clears memberships.
            const del = await prisma.planningSprint.deleteMany({
                where: {
                    teamId,
                    status: 'PLANNED',
                    endDate: { gt: new Date() },
                },
            });
            plannedDeleted = del.count;
        }

        if (!existing) {
            return res.json({ ok: true, removed: false, plannedDeleted });
        }

        await prisma.planningSprintSchedule.delete({
            where: { id: existing.id },
        });
        await logPlanningActivity('PLANNING_SPRINT_SCHEDULE_DISABLED', req, {
            scheduleId: existing.id,
            teamId: existing.teamId || null,
            removed: true,
            plannedDeleted,
        });
        res.json({ ok: true, removed: true, plannedDeleted });
    } catch (err) {
        next(err);
    }
});

// POST /api/planning-sprints/schedule/run?teamId=:id
// Manually trigger a generation run for one team's schedule.
router.post('/schedule/run', async (req, res, next) => {
    try {
        requirePlanner(req);
        const teamId = scheduleTeamKey(req.query.teamId);
        const schedule = await prisma.planningSprintSchedule.findFirst({
            where: { teamId },
        });
        if (!schedule) throw httpError(404, 'No schedule for this team');
        if (!schedule.enabled) {
            throw httpError(
                400,
                'Schedule is disabled. Enable it before generating sprints.',
            );
        }
        const { created } = await materializeNextPlanningSprints(schedule.id);
        res.json({ created });
    } catch (err) {
        next(err);
    }
});

// GET /api/planning-sprints/:id
router.get('/:id', async (req, res, next) => {
    try {
        requirePlanner(req);
        const sprint = await loadPlanningSprint(req.params.id);
        const detail = await serializePlanningDetail(req, sprint);
        res.json({ planningSprint: detail });
    } catch (err) {
        next(err);
    }
});

// GET /api/planning-sprints/:id/burndown
// Mirrors /api/sprints/:id/burndown: an ideal straight-line plus the
// actual remaining-hours series from PlanningSprintSnapshot rows. For
// ACTIVE/PLANNED sprints we recompute live and append a synthetic
// "today" point so the chart tail tracks mid-sprint scope changes.
router.get('/:id/burndown', async (req, res, next) => {
    try {
        requirePlanner(req);
        const sprint = await loadPlanningSprint(req.params.id);
        const snapshots = await prisma.planningSprintSnapshot.findMany({
            where: { planningSprintId: sprint.id },
            orderBy: { capturedAt: 'asc' },
        });
        const totalDays = Math.max(
            1,
            Math.round(
                (sprint.endDate.getTime() - sprint.startDate.getTime()) /
                    (24 * 60 * 60 * 1000),
            ),
        );

        let totalHours;
        let outSnapshots;
        if (sprint.status === 'CLOSED') {
            const latest = snapshots[snapshots.length - 1];
            totalHours = latest?.totalHours || 0;
            outSnapshots = snapshots;
        } else {
            const links = await prisma.planningSprintTask.findMany({
                where: { planningSprintId: sprint.id },
                select: { taskId: true },
            });
            const r = await planningTaskRollup(links.map((l) => l.taskId));
            const liveSnapshot = {
                id: 'live',
                planningSprintId: sprint.id,
                capturedAt: new Date(),
                totalTasks: r.totalTasks,
                completedTasks: r.completedTasks,
                totalHours: r.totalHours,
                remainingHours: Math.max(0, r.totalHours - r.completedHours),
                loggedHours: r.loggedHours,
            };
            totalHours = r.totalHours;
            outSnapshots = [...snapshots, liveSnapshot];
        }

        const ideal = [];
        for (let i = 0; i <= totalDays; i += 1) {
            ideal.push({
                day: i,
                hours: totalHours * (1 - safePlanningRatio(i, totalDays)),
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

// PATCH /api/planning-sprints/:id
router.patch('/:id', async (req, res, next) => {
    try {
        requirePlanner(req);
        const existing = await loadPlanningSprint(req.params.id);
        const body = patchSchema.parse(req.body);

        // teamId can be explicitly set to null to make a sprint org-wide.
        let teamUpdate;
        if (Object.prototype.hasOwnProperty.call(body, 'teamId')) {
            const team = await resolveTeam(body.teamId || null);
            teamUpdate = team?.id || null;
        }

        const updated = await prisma.planningSprint.update({
            where: { id: existing.id },
            data: {
                ...(body.name !== undefined ? { name: body.name } : {}),
                ...(body.goal !== undefined ? { goal: body.goal || null } : {}),
                ...(teamUpdate !== undefined ? { teamId: teamUpdate } : {}),
                ...(body.startDate ? { startDate: body.startDate } : {}),
                ...(body.endDate ? { endDate: body.endDate } : {}),
            },
            include: {
                team: { select: { id: true, name: true, color: true } },
                createdBy: { select: { id: true, name: true, avatarUrl: true } },
            },
        });

        await logPlanningActivity('PLANNING_SPRINT_UPDATED', req, {
            planningSprintId: updated.id,
            planningSprintName: updated.name,
        });

        const detail = await serializePlanningDetail(req, updated);
        res.json({ planningSprint: detail });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/planning-sprints/:id
// Cascade removes the PlanningSprintTask join rows; tasks themselves and
// their project-sprint membership are untouched.
router.delete('/:id', async (req, res, next) => {
    try {
        requirePlanner(req);
        const existing = await loadPlanningSprint(req.params.id);
        await prisma.planningSprint.delete({ where: { id: existing.id } });

        await logPlanningActivity('PLANNING_SPRINT_DELETED', req, {
            planningSprintId: existing.id,
            planningSprintName: existing.name,
        });

        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// POST /api/planning-sprints/:id/start  (PLANNED -> ACTIVE)
router.post('/:id/start', async (req, res, next) => {
    try {
        requirePlanner(req);
        const existing = await loadPlanningSprint(req.params.id);
        if (existing.status !== 'PLANNED') {
            throw httpError(409, 'Only planned sprints can be started');
        }
        const updated = await prisma.planningSprint.update({
            where: { id: existing.id },
            data: { status: 'ACTIVE', startedAt: new Date() },
            include: {
                team: { select: { id: true, name: true, color: true } },
                createdBy: { select: { id: true, name: true, avatarUrl: true } },
            },
        });
        // Baseline snapshot so the burndown chart has a day-0 row.
        await writePlanningSprintSnapshot(updated.id).catch((err) =>
            console.warn(
                '[planningSprints] start snapshot failed:',
                err.message,
            ),
        );
        await logPlanningActivity('PLANNING_SPRINT_STARTED', req, {
            planningSprintId: updated.id,
            planningSprintName: updated.name,
        });
        const detail = await serializePlanningDetail(req, updated);
        res.json({ planningSprint: detail });
    } catch (err) {
        next(err);
    }
});

// POST /api/planning-sprints/:id/close  (ACTIVE -> CLOSED, with strategy)
router.post('/:id/close', async (req, res, next) => {
    try {
        requirePlanner(req);
        const existing = await loadPlanningSprint(req.params.id);
        if (existing.status === 'CLOSED') {
            throw httpError(409, 'Sprint is already closed');
        }
        const { strategy } = closeSchema.parse(req.body);

        // Snapshot current membership before any re-parenting so closed
        // sprints keep an accurate historical task list.
        const links = await prisma.planningSprintTask.findMany({
            where: { planningSprintId: existing.id },
            select: { taskId: true },
        });
        const allTaskIds = links.map((l) => l.taskId);

        // Which of those tasks are still incomplete (not DONE)?
        const incomplete = allTaskIds.length
            ? await prisma.task.findMany({
                  where: {
                      id: { in: allTaskIds },
                      deletedAt: null,
                      status: { not: 'DONE' },
                  },
                  select: { id: true },
              })
            : [];
        const incompleteIds = incomplete.map((t) => t.id);

        await prisma.$transaction(async (tx) => {
            await tx.planningSprint.update({
                where: { id: existing.id },
                data: {
                    status: 'CLOSED',
                    closedAt: new Date(),
                    closedTaskIds: allTaskIds,
                },
            });

            if (!incompleteIds.length) return;

            if (strategy === 'BACK_TO_BACKLOG') {
                // Drop planning membership for incomplete tasks.
                await tx.planningSprintTask.deleteMany({
                    where: {
                        planningSprintId: existing.id,
                        taskId: { in: incompleteIds },
                    },
                });
            } else if (strategy === 'PUSH_TO_NEXT') {
                // Find the next PLANNED planning sprint for the same team
                // (chronological by start date). null team only matches
                // null team so org-wide and team sprints stay separate.
                const next = await tx.planningSprint.findFirst({
                    where: {
                        status: 'PLANNED',
                        teamId: existing.teamId,
                        id: { not: existing.id },
                        startDate: { gte: existing.startDate },
                    },
                    orderBy: { startDate: 'asc' },
                    select: { id: true },
                });
                if (next) {
                    // Re-home incomplete tasks: remove from this sprint,
                    // add to the next (skipDuplicates guards re-adds).
                    await tx.planningSprintTask.deleteMany({
                        where: {
                            planningSprintId: existing.id,
                            taskId: { in: incompleteIds },
                        },
                    });
                    await tx.planningSprintTask.createMany({
                        data: incompleteIds.map((taskId) => ({
                            planningSprintId: next.id,
                            taskId,
                            addedById: req.user.id,
                        })),
                        skipDuplicates: true,
                    });
                }
                // No next sprint: leave tasks attached (acts like KEEP).
            }
            // KEEP: nothing to do — tasks stay attached.
        });

        // Snapshot the end-of-sprint state from the frozen task set so
        // the closed burndown reflects everything that was committed,
        // even tasks just pushed to the next sprint.
        await writePlanningSprintSnapshot(existing.id, {
            taskIds: allTaskIds,
        }).catch((err) =>
            console.warn(
                '[planningSprints] close snapshot failed:',
                err.message,
            ),
        );

        await logPlanningActivity('PLANNING_SPRINT_CLOSED', req, {
            planningSprintId: existing.id,
            planningSprintName: existing.name,
            strategy,
            movedTasks: incompleteIds.length,
        });

        const refreshed = await loadPlanningSprint(existing.id);
        const detail = await serializePlanningDetail(req, refreshed);
        res.json({ planningSprint: detail });
    } catch (err) {
        next(err);
    }
});

// POST /api/planning-sprints/:id/reopen  (CLOSED -> ACTIVE)
router.post('/:id/reopen', async (req, res, next) => {
    try {
        requirePlanner(req);
        const existing = await loadPlanningSprint(req.params.id);
        if (existing.status !== 'CLOSED') {
            throw httpError(409, 'Only closed sprints can be reopened');
        }
        const updated = await prisma.planningSprint.update({
            where: { id: existing.id },
            data: { status: 'ACTIVE', closedAt: null, closedTaskIds: null },
            include: {
                team: { select: { id: true, name: true, color: true } },
                createdBy: { select: { id: true, name: true, avatarUrl: true } },
            },
        });
        await logPlanningActivity('PLANNING_SPRINT_UPDATED', req, {
            planningSprintId: updated.id,
            planningSprintName: updated.name,
            reopened: true,
        });
        const detail = await serializePlanningDetail(req, updated);
        res.json({ planningSprint: detail });
    } catch (err) {
        next(err);
    }
});

// POST /api/planning-sprints/:id/tasks  { taskIds: [...] }
// Add tasks to the planning sprint. Managers can only add tasks from
// projects they can read; out-of-scope task ids are rejected.
router.post('/:id/tasks', async (req, res, next) => {
    try {
        requirePlanner(req);
        const existing = await loadPlanningSprint(req.params.id);
        if (existing.status === 'CLOSED') {
            throw httpError(409, 'Cannot add tasks to a closed sprint');
        }
        const { taskIds } = taskAddSchema.parse(req.body);
        const scope = await plannerProjectScope(req);

        // Top-level tasks and subtasks may be added. Subtasks are linked
        // directly (no requirement to also add the parent).
        const tasks = await prisma.task.findMany({
            where: {
                id: { in: taskIds },
                deletedAt: null,
                ...(scope.all ? {} : { projectId: { in: scope.ids } }),
            },
            select: { id: true },
        });
        if (!tasks.length) {
            throw httpError(400, 'No valid tasks to add');
        }

        await prisma.planningSprintTask.createMany({
            data: tasks.map((t) => ({
                planningSprintId: existing.id,
                taskId: t.id,
                addedById: req.user.id,
            })),
            skipDuplicates: true,
        });

        await logPlanningActivity('TASK_ADDED_TO_PLANNING_SPRINT', req, {
            planningSprintId: existing.id,
            planningSprintName: existing.name,
            count: tasks.length,
        });

        const detail = await serializePlanningDetail(req, existing);
        res.json({ planningSprint: detail });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/planning-sprints/:id/tasks/:taskId
router.delete('/:id/tasks/:taskId', async (req, res, next) => {
    try {
        requirePlanner(req);
        const existing = await loadPlanningSprint(req.params.id);
        if (existing.status === 'CLOSED') {
            throw httpError(409, 'Cannot modify tasks on a closed sprint');
        }
        await prisma.planningSprintTask.deleteMany({
            where: {
                planningSprintId: existing.id,
                taskId: req.params.taskId,
            },
        });

        await logPlanningActivity('TASK_REMOVED_FROM_PLANNING_SPRINT', req, {
            planningSprintId: existing.id,
            planningSprintName: existing.name,
            taskId: req.params.taskId,
        });

        const detail = await serializePlanningDetail(req, existing);
        res.json({ planningSprint: detail });
    } catch (err) {
        next(err);
    }
});

// PUT /api/planning-sprints/:id/capacity
// Replace the per-user planned hours for the planning sprint. Missing
// entries (users not in the body) are deleted so the caller drives the
// final state in one call — same contract as the project sprint route.
router.put('/:id/capacity', async (req, res, next) => {
    try {
        requirePlanner(req);
        const { entries } = capacityPutSchema.parse(req.body);
        const existing = await loadPlanningSprint(req.params.id);
        if (existing.status === 'CLOSED') {
            throw httpError(400, 'Cannot change capacity on a closed sprint');
        }
        await prisma.$transaction(async (tx) => {
            const keepIds = entries.map((e) => e.userId);
            await tx.planningSprintCapacity.deleteMany({
                where: {
                    planningSprintId: existing.id,
                    userId: { notIn: keepIds.length > 0 ? keepIds : [''] },
                },
            });
            for (const e of entries) {
                await tx.planningSprintCapacity.upsert({
                    where: {
                        planningSprintId_userId: {
                            planningSprintId: existing.id,
                            userId: e.userId,
                        },
                    },
                    create: {
                        planningSprintId: existing.id,
                        userId: e.userId,
                        plannedHours: e.plannedHours,
                    },
                    update: { plannedHours: e.plannedHours },
                });
            }
        });
        const detail = await serializePlanningDetail(req, existing);
        res.json({ planningSprint: detail });
    } catch (err) {
        next(err);
    }
});

// GET /api/planning-sprints/backlog/tasks
// Cross-project task search for building a planning sprint. Filters:
//   q           — case-insensitive match on title or code
//   projectId   — restrict to one project
//   teamId      — restrict to tasks assigned to that team's members
//   assigneeId  — restrict to one assignee
//   status      — TODO | IN_PROGRESS | DONE (defaults to open only)
//   excludeSprintId — drop tasks already in this planning sprint
// Managers are always scoped to their accessible projects.
router.get('/backlog/tasks', async (req, res, next) => {
    try {
        requirePlanner(req);
        const scope = await plannerProjectScope(req);

        const q = String(req.query.q || '').trim();
        const projectId = String(req.query.projectId || '').trim();
        const teamId = String(req.query.teamId || '').trim();
        const assigneeId = String(req.query.assigneeId || '').trim();
        const statusRaw = String(req.query.status || '').trim().toUpperCase();
        const excludeSprintId = String(req.query.excludeSprintId || '').trim();

        const where = {
            deletedAt: null,
            // Backlog lists top-level tasks only; subtasks ride along
            // nested under their parent (PLANNING_TASK_SELECT) so the
            // tree stays intact. Membership is parent-level anyway.
            parentTaskId: null,
        };

        if (scope.all) {
            if (projectId) where.projectId = projectId;
        } else {
            // Intersect requested project with accessible ones.
            if (projectId) {
                if (!scope.ids.includes(projectId)) {
                    return res.json({ tasks: [] });
                }
                where.projectId = projectId;
            } else {
                where.projectId = { in: scope.ids };
            }
        }

        if (['TODO', 'IN_PROGRESS', 'DONE'].includes(statusRaw)) {
            where.status = statusRaw;
        } else {
            // Default: open work only (hide DONE from the picker).
            where.status = { not: 'DONE' };
        }

        if (assigneeId) where.assigneeId = assigneeId;

        if (teamId) {
            const members = await prisma.teamMember.findMany({
                where: { teamId },
                select: { userId: true },
            });
            const memberIds = members.map((m) => m.userId);
            where.assigneeId = assigneeId
                ? assigneeId
                : { in: memberIds.length ? memberIds : ['__none__'] };
        }

        if (q) {
            // Term-based search: split the query on whitespace and
            // require EVERY term to match at least one field, so
            // "api fix" finds "Fix API timeout" (the old single-
            // substring match couldn't). Each term can hit:
            //   - the task's title or code,
            //   - the PROJECT name (so typing a project surfaces its
            //     whole group),
            //   - any subtask's title or code — a subtask hit
            //     surfaces the parent (nested under it) so the tree
            //     never shows orphaned children.
            const terms = q.split(/\s+/).filter(Boolean);
            where.AND = terms.map((term) => ({
                OR: [
                    { title: { contains: term, mode: 'insensitive' } },
                    { code: { contains: term, mode: 'insensitive' } },
                    {
                        project: {
                            is: {
                                name: {
                                    contains: term,
                                    mode: 'insensitive',
                                },
                            },
                        },
                    },
                    {
                        subtasks: {
                            some: {
                                deletedAt: null,
                                OR: [
                                    {
                                        title: {
                                            contains: term,
                                            mode: 'insensitive',
                                        },
                                    },
                                    {
                                        code: {
                                            contains: term,
                                            mode: 'insensitive',
                                        },
                                    },
                                ],
                            },
                        },
                    },
                ],
            }));
        }

        if (excludeSprintId) {
            const links = await prisma.planningSprintTask.findMany({
                where: { planningSprintId: excludeSprintId },
                select: { taskId: true },
            });
            const ids = links.map((l) => l.taskId);
            if (ids.length) where.id = { notIn: ids };
        }

        // The backlog column groups by project, so order by project
        // name first — grouping on the client stays stable even when
        // the take-limit truncates the list. `take` is clamped so the
        // browse-all backlog view can pull more than the old 100 cap
        // without letting a client request an unbounded payload.
        const takeRaw = Number.parseInt(String(req.query.take || ''), 10);
        const take = Number.isFinite(takeRaw)
            ? Math.min(Math.max(takeRaw, 1), 500)
            : 200;

        const tasks = await prisma.task.findMany({
            where,
            select: PLANNING_TASK_SELECT,
            orderBy: [
                { project: { name: 'asc' } },
                { priority: 'asc' },
                { createdAt: 'desc' },
            ],
            take,
        });

        res.json({ tasks });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
module.exports.writePlanningSprintSnapshot = writePlanningSprintSnapshot;
module.exports.snapshotAllActivePlanningSprints = snapshotAllActivePlanningSprints;
