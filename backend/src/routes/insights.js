const express = require('express');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    accessibleProjectIds,
    projectIdsForUser,
    isAdmin,
    CAPABILITIES,
    hasCapability,
} = require('../lib/permissions');

const router = express.Router();

router.use(requireAuth);

const PROJECT_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE', 'ON_HOLD'];
const PROJECT_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'ON_HOLD', 'DONE'];

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function startOfWeek(d) {
    // Treat Monday as the start of the week.
    const x = startOfDay(d);
    const day = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - day);
    return x;
}

function fillBuckets(rows, weekCount, getBucket) {
    const map = new Map();
    for (let i = weekCount - 1; i >= 0; i -= 1) {
        const start = startOfWeek(new Date());
        start.setDate(start.getDate() - i * 7);
        map.set(start.toISOString(), { week: start.toISOString(), count: 0 });
    }
    for (const row of rows) {
        const key = getBucket(row).toISOString();
        if (map.has(key)) {
            map.get(key).count += 1;
        }
    }
    return Array.from(map.values());
}

router.get('/', async (req, res, next) => {
    try {
        const now = new Date();
        const weekStart = startOfWeek(now);
        const eightWeeksAgo = new Date(weekStart);
        eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 7 * 7);

        const startOfTodayDate = startOfDay(now);
        const endOfWeek = new Date(startOfTodayDate);
        endOfWeek.setDate(endOfWeek.getDate() + 7);

        // ?userId=... lets an admin scope insights to a specific user's view.
        // Regular users may only ever see their own insights.
        const requestedUserId = req.query.userId
            ? String(req.query.userId)
            : null;

        let scope; // array of project IDs the dashboard is allowed to see
        let me = req.user.id; // whose "personal" stats to compute
        let viewer; // metadata describing what the dashboard is showing
        let canSeePeople;
        let canSeeOwners;

        // Non-admins with the `insights:view:all` capability override
        // get the same workspace/user-selection powers as admins on
        // this page. Anything else falls through to the "own data"
        // branch below.
        const canSeeAllInsights =
            isAdmin(req) ||
            hasCapability(req, CAPABILITIES.INSIGHTS_VIEW_ALL);
        if (canSeeAllInsights && !requestedUserId) {
            scope = await accessibleProjectIds(req);
            me = req.user.id;
            viewer = { mode: 'workspace' };
            canSeePeople = true;
            canSeeOwners = true;
        } else if (canSeeAllInsights && requestedUserId) {
            // Admin viewing a specific user.
            const target = await prisma.user.findUnique({
                where: { id: requestedUserId },
                select: { id: true, name: true, email: true, avatarUrl: true },
            });
            if (!target) throw httpError(404, 'User not found');
            scope = await projectIdsForUser(target.id);
            me = target.id;
            viewer = { mode: 'user', user: target };
            canSeePeople = true;
            canSeeOwners = true;
        } else {
            // Regular user: always self-scoped, no people/owners panels.
            if (requestedUserId && requestedUserId !== req.user.id) {
                throw httpError(403, 'You can only view your own insights');
            }
            scope = await accessibleProjectIds(req);
            me = req.user.id;
            viewer = { mode: 'self' };
            canSeePeople = false;
            canSeeOwners = false;
        }

        const scopeProject = { id: { in: scope } };
        const scopeProjectId = { projectId: { in: scope } };

        // Optional reporting window (?from / ?to, ISO dates). When set, the
        // headline figures count only projects/tasks/notes/files CREATED in
        // that period. The "what's happening now" panels (recent, overdue,
        // due-this-week, recently-closed) stay relative to today.
        const parseDate = (v) => {
            if (!v) return null;
            const d = new Date(String(v));
            return Number.isNaN(d.getTime()) ? null : d;
        };
        const fromDate = parseDate(req.query.from);
        const toDate = parseDate(req.query.to);
        const createdWindow =
            fromDate || toDate
                ? {
                      ...(fromDate ? { gte: fromDate } : {}),
                      ...(toDate ? { lte: toDate } : {}),
                  }
                : null;
        // Optional Team filter (?teamId). Projects: the team is attached to
        // the project. Tasks: the task is assigned to a member of the team
        // (resource-planning view — what that team's people are working on).
        const teamId = req.query.teamId ? String(req.query.teamId) : null;
        const projTeamWhere = teamId ? { teams: { some: { teamId } } } : {};
        const taskTeamWhere = teamId
            ? { assignee: { teamMemberships: { some: { teamId } } } }
            : {};

        // When a specific user is being viewed, task-level panels (counts,
        // by-status/priority and the Gantt timeline) scope to that user's
        // ASSIGNED tasks — the same assignee-based logic the Team filter
        // uses — rather than just every task inside their projects. This is
        // what makes "Viewing: <user>" behave like a per-person view.
        const taskUserWhere =
            viewer.mode === 'user' ? { assigneeId: me } : {};

        const projWhere = {
            ...scopeProject,
            ...(createdWindow ? { createdAt: createdWindow } : {}),
            ...projTeamWhere,
        };
        const taskWhere = {
            ...scopeProjectId,
            ...(createdWindow ? { createdAt: createdWindow } : {}),
            ...taskTeamWhere,
            ...taskUserWhere,
        };
        // Notes / files live on projects, not on an assignee, so they can't
        // take the task's `assignee` team filter (that field doesn't exist
        // on those models). Keep them project-scoped + windowed only.
        const docWhere = {
            ...scopeProjectId,
            ...(createdWindow ? { createdAt: createdWindow } : {}),
        };

        const [
            projectsByStatus,
            projectsByPriority,
            tasksByStatus,
            totalProjects,
            totalUsers,
            totalNotes,
            totalFiles,
            recentProjects,
            myOpenTasks,
            myOverdueTasks,
            myDueThisWeek,
            topOwners,
            recentlyClosed,
            projectsDetailed,
            taskCountRows,
            doneTaskCountRows,
            tasksByUserRows,
            tasksByPriorityRows,
            upcomingDueTasks,
            subtaskCountRows,
            noteCountRows,
            taskTimelineRows,
            undatedTimelineRows,
        ] = await Promise.all([
            prisma.project.groupBy({
                by: ['status'],
                where: projWhere,
                _count: { _all: true },
            }),
            prisma.project.groupBy({
                by: ['priority'],
                where: projWhere,
                _count: { _all: true },
            }),
            prisma.task.groupBy({
                by: ['status'],
                where: taskWhere,
                _count: { _all: true },
            }),
            prisma.project.count({ where: projWhere }),
            // Active people only matters for admin views.
            canSeePeople
                ? prisma.user.count({ where: { status: 'ACTIVE' } })
                : Promise.resolve(0),
            prisma.note.count({ where: docWhere }),
            prisma.fileAttachment.count({ where: docWhere }),
            prisma.project.findMany({
                where: { ...scopeProject, createdAt: { gte: eightWeeksAgo } },
                select: { createdAt: true },
            }),
            prisma.task.findMany({
                where: {
                    assigneeId: me,
                    status: { not: 'DONE' },
                },
                orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
                take: 6,
                include: {
                    project: { select: { id: true, name: true } },
                },
            }),
            prisma.task.count({
                where: {
                    assigneeId: me,
                    status: { not: 'DONE' },
                    dueDate: { lt: startOfTodayDate },
                },
            }),
            prisma.task.count({
                where: {
                    assigneeId: me,
                    status: { not: 'DONE' },
                    dueDate: {
                        gte: startOfTodayDate,
                        lt: endOfWeek,
                    },
                },
            }),
            canSeeOwners
                ? prisma.project.groupBy({
                      by: ['ownerId'],
                      where: projWhere,
                      _count: { _all: true },
                      orderBy: { _count: { ownerId: 'desc' } },
                      take: 5,
                  })
                : Promise.resolve([]),
            prisma.project.findMany({
                where: { ...scopeProject, closedAt: { not: null } },
                orderBy: { closedAt: 'desc' },
                take: 5,
                select: {
                    id: true,
                    name: true,
                    closedAt: true,
                    owner: { select: { id: true, name: true, avatarUrl: true } },
                },
            }),
            // Detailed project rows for the Projects-tab breakdown charts
            // (by owner / client / product / type / team / country). Kept in
            // a single findMany + JS aggregation so we get labels for free.
            prisma.project.findMany({
                where: projWhere,
                select: {
                    id: true,
                    name: true,
                    country: true,
                    client: true,
                    ownerId: true,
                    owner: { select: { id: true, name: true, email: true } },
                    clientId: true,
                    clientRecord: { select: { id: true, name: true } },
                    productId: true,
                    product: { select: { id: true, name: true } },
                    projectTypeId: true,
                    projectType: { select: { id: true, name: true } },
                    teams: {
                        select: { team: { select: { id: true, name: true } } },
                    },
                },
                take: 2000,
            }),
            // Task counts per project → completion buckets + "most tasks".
            prisma.task.groupBy({
                by: ['projectId'],
                where: taskWhere,
                _count: { _all: true },
            }),
            prisma.task.groupBy({
                by: ['projectId'],
                where: { ...taskWhere, status: 'DONE' },
                _count: { _all: true },
            }),
            // Tasks tab: by assignee (top 10) + by priority.
            prisma.task.groupBy({
                by: ['assigneeId'],
                where: { ...taskWhere, assigneeId: { not: null } },
                _count: { _all: true },
                orderBy: { _count: { assigneeId: 'desc' } },
                take: 10,
            }),
            prisma.task.groupBy({
                by: ['priority'],
                where: taskWhere,
                _count: { _all: true },
            }),
            // Nearest upcoming due dates among open tasks ("closest overdue").
            prisma.task.findMany({
                where: {
                    ...scopeProjectId,
                    status: { not: 'DONE' },
                    dueDate: { not: null, gte: startOfTodayDate },
                },
                orderBy: { dueDate: 'asc' },
                take: 8,
                select: {
                    id: true,
                    title: true,
                    dueDate: true,
                    priority: true,
                    status: true,
                    project: { select: { id: true, name: true } },
                    assignee: {
                        select: { id: true, name: true, avatarUrl: true },
                    },
                },
            }),
            // Tasks with the most subtasks / notes (top 8 each).
            prisma.task.groupBy({
                by: ['parentTaskId'],
                where: { ...scopeProjectId, parentTaskId: { not: null } },
                _count: { _all: true },
                orderBy: { _count: { parentTaskId: 'desc' } },
                take: 8,
            }),
            prisma.note.groupBy({
                by: ['taskId'],
                where: { ...scopeProjectId, taskId: { not: null } },
                _count: { _all: true },
                orderBy: { _count: { taskId: 'desc' } },
                take: 8,
            }),
            // Gantt/resource-planning timeline: open tasks with their
            // create→deadline span. Respects scope + the Team filter; when a
            // period is set we keep tasks whose span OVERLAPS it (created on
            // or before `to`, and either no deadline or a deadline on/after
            // `from`) rather than only tasks created inside it. Soonest
            // deadline first; undated tasks last. Frontend caps to ~10 rows
            // with scroll and can toggle the undated (open-ended) ones off.
            prisma.task.findMany({
                where: {
                    ...scopeProjectId,
                    ...taskTeamWhere,
                    ...taskUserWhere,
                    status: { not: 'DONE' },
                    dueDate: { not: null },
                    ...(createdWindow
                        ? {
                              AND: [
                                  ...(toDate
                                      ? [{ createdAt: { lte: toDate } }]
                                      : []),
                                  ...(fromDate
                                      ? [{ dueDate: { gte: fromDate } }]
                                      : []),
                              ],
                          }
                        : {}),
                },
                orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
                take: 60,
                select: {
                    id: true,
                    code: true,
                    title: true,
                    createdAt: true,
                    dueDate: true,
                    status: true,
                    priority: true,
                    assignee: {
                        select: { id: true, name: true, avatarUrl: true },
                    },
                    project: { select: { id: true, name: true } },
                },
            }),
            // Undated open tasks are fetched separately so they always reach
            // the chart (they'd otherwise sort last and be cut by the take
            // cap on the dated query). An undated task "spans" from creation
            // onward, so within a period it only needs to have been created
            // on or before `to`.
            prisma.task.findMany({
                where: {
                    ...scopeProjectId,
                    ...taskTeamWhere,
                    ...taskUserWhere,
                    status: { not: 'DONE' },
                    dueDate: null,
                    ...(toDate ? { createdAt: { lte: toDate } } : {}),
                },
                orderBy: { createdAt: 'desc' },
                take: 25,
                select: {
                    id: true,
                    code: true,
                    title: true,
                    createdAt: true,
                    dueDate: true,
                    status: true,
                    priority: true,
                    assignee: {
                        select: { id: true, name: true, avatarUrl: true },
                    },
                    project: { select: { id: true, name: true } },
                },
            }),
        ]);

        const ownerIds = topOwners.map((o) => o.ownerId).filter(Boolean);
        const ownerLookup = ownerIds.length
            ? await prisma.user.findMany({
                  where: { id: { in: ownerIds } },
                  select: { id: true, name: true, email: true, avatarUrl: true },
              })
            : [];
        const ownerMap = new Map(ownerLookup.map((u) => [u.id, u]));

        const projectStatusMap = Object.fromEntries(
            PROJECT_STATUSES.map((s) => [s, 0]),
        );
        for (const row of projectsByStatus) {
            projectStatusMap[row.status] = row._count._all;
        }

        const projectPriorityMap = Object.fromEntries(
            PROJECT_PRIORITIES.map((p) => [p, 0]),
        );
        for (const row of projectsByPriority) {
            projectPriorityMap[row.priority] = row._count._all;
        }

        const taskStatusMap = Object.fromEntries(
            TASK_STATUSES.map((s) => [s, 0]),
        );
        for (const row of tasksByStatus) {
            taskStatusMap[row.status] = row._count._all;
        }

        // ---- Projects-tab breakdowns (bar charts + country pie) -----------
        // Generic "count projects grouped by a key, keep a display label,
        // sort by count desc, keep the top N". Each getter returns
        // { key, label } for a project (or null to skip it).
        const breakdown = (getter, limit = 10) => {
            const m = new Map();
            for (const p of projectsDetailed) {
                const g = getter(p);
                if (!g || g.key == null) continue;
                const cur = m.get(g.key) || { key: g.key, label: g.label, count: 0 };
                cur.count += 1;
                m.set(g.key, cur);
            }
            return [...m.values()]
                .sort((a, b) => b.count - a.count)
                .slice(0, limit);
        };

        const projectsByOwner = breakdown((p) =>
            p.ownerId
                ? { key: p.ownerId, label: p.owner?.name || p.owner?.email || 'Unknown' }
                : { key: '__none__', label: 'No owner' },
        );
        const projectsByClient = breakdown((p) => {
            const label = p.clientRecord?.name || p.client;
            return label
                ? { key: p.clientId || `name:${label}`, label }
                : { key: '__none__', label: 'No client' };
        });
        const projectsByProduct = breakdown((p) =>
            p.productId
                ? { key: p.productId, label: p.product?.name || 'Product' }
                : { key: '__none__', label: 'No product' },
        );
        const projectsByType = breakdown((p) =>
            p.projectTypeId
                ? { key: p.projectTypeId, label: p.projectType?.name || 'Type' }
                : { key: '__none__', label: 'Uncategorised' },
        );
        const projectsByCountry = breakdown((p) =>
            p.country
                ? { key: p.country, label: p.country }
                : { key: '__none__', label: 'Unknown' },
        );
        // Teams are many-to-many, so a project can appear in several teams;
        // count each membership. Projects with no team fall under "No team".
        const teamMap = new Map();
        for (const p of projectsDetailed) {
            const teams = (p.teams || [])
                .map((t) => t.team)
                .filter(Boolean);
            const rows = teams.length
                ? teams.map((t) => ({ key: t.id, label: t.name }))
                : [{ key: '__none__', label: 'No team' }];
            for (const r of rows) {
                const cur = teamMap.get(r.key) || { ...r, count: 0 };
                cur.count += 1;
                teamMap.set(r.key, cur);
            }
        }
        const projectsByTeam = [...teamMap.values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        // Completion buckets: per project, done/total tasks → 5×20% bands.
        const totalTasksByProject = new Map(
            taskCountRows.map((r) => [r.projectId, r._count._all]),
        );
        const doneTasksByProject = new Map(
            doneTaskCountRows.map((r) => [r.projectId, r._count._all]),
        );
        const bucketCounts = [0, 0, 0, 0, 0];
        for (const [pid, total] of totalTasksByProject) {
            if (!total) continue;
            const done = doneTasksByProject.get(pid) || 0;
            const pct = (done / total) * 100;
            const idx = pct >= 100 ? 4 : Math.min(4, Math.floor(pct / 20));
            bucketCounts[idx] += 1;
        }
        const completionBuckets = [
            { key: '0-20', label: '0–20%', count: bucketCounts[0] },
            { key: '20-40', label: '20–40%', count: bucketCounts[1] },
            { key: '40-60', label: '40–60%', count: bucketCounts[2] },
            { key: '60-80', label: '60–80%', count: bucketCounts[3] },
            { key: '80-100', label: '80–100%', count: bucketCounts[4] },
        ];

        // Top projects by task count.
        const projectNameById = new Map(
            projectsDetailed.map((p) => [p.id, p.name]),
        );
        const topProjectsByTasks = [...totalTasksByProject.entries()]
            .map(([pid, count]) => ({
                key: pid,
                label: projectNameById.get(pid) || '—',
                count,
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 8);

        // ---- Tasks-tab aggregations ---------------------------------------
        const assigneeIds = tasksByUserRows
            .map((r) => r.assigneeId)
            .filter(Boolean);
        const taskLabelIds = [
            ...new Set(
                [
                    ...subtaskCountRows.map((r) => r.parentTaskId),
                    ...noteCountRows.map((r) => r.taskId),
                ].filter(Boolean),
            ),
        ];
        const [assigneeUsers, taskLabelRows] = await Promise.all([
            assigneeIds.length
                ? prisma.user.findMany({
                      where: { id: { in: assigneeIds } },
                      select: { id: true, name: true, email: true },
                  })
                : Promise.resolve([]),
            taskLabelIds.length
                ? prisma.task.findMany({
                      where: { id: { in: taskLabelIds } },
                      select: { id: true, title: true },
                  })
                : Promise.resolve([]),
        ]);
        const assigneeMap = new Map(assigneeUsers.map((u) => [u.id, u]));
        const taskTitleMap = new Map(taskLabelRows.map((t) => [t.id, t.title]));

        const TASK_PRIORITY_ORDER = ['HIGH', 'MEDIUM', 'LOW'];
        const taskPriorityMap = Object.fromEntries(
            TASK_PRIORITY_ORDER.map((p) => [p, 0]),
        );
        for (const row of tasksByPriorityRows) {
            taskPriorityMap[row.priority] = row._count._all;
        }

        const tasksByUser = tasksByUserRows.map((r) => ({
            key: r.assigneeId,
            label:
                assigneeMap.get(r.assigneeId)?.name ||
                assigneeMap.get(r.assigneeId)?.email ||
                'Unknown',
            count: r._count._all,
        }));
        const tasksMostSubtasks = subtaskCountRows.map((r) => ({
            key: r.parentTaskId,
            label: taskTitleMap.get(r.parentTaskId) || '—',
            count: r._count._all,
        }));
        const notesPerTask = noteCountRows.map((r) => ({
            key: r.taskId,
            label: taskTitleMap.get(r.taskId) || '—',
            count: r._count._all,
        }));
        const upcomingDue = upcomingDueTasks.map((t) => ({
            id: t.id,
            title: t.title,
            dueDate: t.dueDate,
            priority: t.priority,
            status: t.status,
            project: t.project,
            assignee: t.assignee,
        }));

        const newProjectsByWeek = fillBuckets(recentProjects, 8, (row) =>
            startOfWeek(row.createdAt),
        );

        const summary = {
            totalProjects,
            activeProjects:
                (projectStatusMap.TODO || 0) +
                (projectStatusMap.IN_PROGRESS || 0),
            completedProjects: projectStatusMap.DONE || 0,
            onHoldProjects: projectStatusMap.ON_HOLD || 0,
            totalTasks: Object.values(taskStatusMap).reduce((a, b) => a + b, 0),
            openTasks:
                (taskStatusMap.TODO || 0) + (taskStatusMap.IN_PROGRESS || 0),
            doneTasks: taskStatusMap.DONE || 0,
            totalUsers,
            totalNotes,
            totalFiles,
            myOpenTasks: myOpenTasks.length,
            myOverdueTasks,
            myDueThisWeek,
        };

        res.json({
            viewer,
            canSeePeople,
            canSeeOwners,
            summary,
            projectsByStatus: PROJECT_STATUSES.map((status) => ({
                status,
                count: projectStatusMap[status] || 0,
            })),
            projectsByPriority: PROJECT_PRIORITIES.map((priority) => ({
                priority,
                count: projectPriorityMap[priority] || 0,
            })),
            tasksByStatus: TASK_STATUSES.map((status) => ({
                status,
                count: taskStatusMap[status] || 0,
            })),
            newProjectsByWeek,
            projectsByOwner,
            projectsByClient,
            projectsByProduct,
            projectsByType,
            projectsByTeam,
            projectsByCountry,
            completionBuckets,
            topProjectsByTasks,
            tasksByUser,
            tasksByPriority: TASK_PRIORITY_ORDER.map((priority) => ({
                priority,
                count: taskPriorityMap[priority] || 0,
            })),
            tasksMostSubtasks,
            notesPerTask,
            taskTimeline: [...taskTimelineRows, ...undatedTimelineRows].map(
                (t) => ({
                    id: t.id,
                    code: t.code,
                    title: t.title,
                    createdAt: t.createdAt,
                    dueDate: t.dueDate,
                    status: t.status,
                    priority: t.priority,
                    assignee: t.assignee,
                    project: t.project,
                }),
            ),
            upcomingDue,
            topOwners: topOwners
                .map((row) => ({
                    user: ownerMap.get(row.ownerId) || null,
                    count: row._count._all,
                }))
                .filter((row) => row.user),
            myFocus: myOpenTasks.map((t) => ({
                id: t.id,
                title: t.title,
                status: t.status,
                priority: t.priority,
                dueDate: t.dueDate,
                project: t.project,
            })),
            recentlyClosed: recentlyClosed.map((p) => ({
                id: p.id,
                name: p.name,
                closedAt: p.closedAt,
                owner: p.owner,
            })),
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
