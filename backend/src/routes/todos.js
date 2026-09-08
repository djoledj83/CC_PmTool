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

const router = express.Router();

router.use(requireAuth);

// Resolve which user we're acting on. Defaults to the authenticated user.
// Admins may pass ?userId=... to read/mutate another user's items.
async function resolveTargetUserId(req) {
    const requested = req.query.userId ? String(req.query.userId) : null;
    if (!requested || requested === req.user.id) return req.user.id;
    if (!isAdminOrManager(req)) {
        throw httpError(403, 'You can only manage your own to-do list');
    }
    const exists = await prisma.user.findUnique({
        where: { id: requested },
        select: { id: true },
    });
    if (!exists) throw httpError(404, 'User not found');
    return requested;
}

// Same as above but reads ?userId from the body, used by mutating routes
// that work off the item id (PATCH/DELETE). Admins can pass userId in the
// query string to override the item's owner check.
async function ownerAccess(req, ownerId) {
    if (ownerId === req.user.id) return true;
    if (!isAdmin(req)) return false;
    return true;
}

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'];

// Loose ISO date validator that also accepts null to clear the field.
const dateField = z
    .union([z.string().min(1), z.null()])
    .optional()
    .transform((v) => {
        if (v === undefined) return undefined;
        if (v === null || v === '') return null;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) {
            throw new Error('Invalid date');
        }
        return d;
    });

const createSchema = z.object({
    title: z.string().min(1, 'Title is required').max(280),
    notes: z.string().max(2000).optional().nullable(),
    dueDate: dateField,
    projectId: z.string().min(1, 'Related project is required'),
    priority: z.enum(PRIORITIES).optional(),
});

const updateSchema = z.object({
    title: z.string().min(1).max(280).optional(),
    notes: z.string().max(2000).optional().nullable(),
    dueDate: dateField,
    projectId: z.string().min(1).optional().nullable(),
    priority: z.enum(PRIORITIES).optional(),
    done: z.boolean().optional(),
    position: z.number().int().optional(),
});

const reorderSchema = z.object({
    ids: z.array(z.string().min(1)).min(1),
});

const todoInclude = {
    project: { select: { id: true, name: true, status: true, code: true } },
    user: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
};

const taskInclude = {
    project: { select: { id: true, name: true, status: true, code: true } },
    phase: { select: { id: true, name: true } },
    parent: { select: { id: true, title: true, code: true } },
    assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
    // Echo the original creator so the "by <name>" pill on the Todos
    // page reads the right person instead of falling back to "unknown".
    // The Plan view's taskInclude already does this; this local include
    // was missing the join, so /api/todos returned tasks without
    // createdBy and the FE showed "by unknown" for every assigned row.
    createdBy: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    // Approver / disapprover so the quick-view opened from "My Tasks"
    // can show the approval decision + reason and the creator's
    // "Re-request approval" button (the scalar specific/approvedAt/
    // rejectedAt/rejectionReason come automatically with the include).
    approvedBy: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    rejectedBy: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
};

function shape(todo) {
    return {
        kind: 'todo',
        id: todo.id,
        title: todo.title,
        notes: todo.notes || null,
        dueDate: todo.dueDate,
        done: todo.done,
        doneAt: todo.doneAt,
        priority: todo.priority,
        position: todo.position,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
        project: todo.project || null,
        projectId: todo.projectId || null,
        ownerId: todo.userId,
        owner: todo.user
            ? {
                  id: todo.user.id,
                  name: todo.user.name,
                  email: todo.user.email,
                  avatarUrl: todo.user.avatarUrl || null,
              }
            : null,
    };
}

// Project tasks where the user is the assignee are surfaced into the same
// to-do feed, but kept distinct via `kind` so the UI can render them with
// project context and route mutations through /api/tasks/:id.
function shapeTask(task) {
    const done = task.status === 'DONE';
    return {
        kind: 'task',
        id: task.id,
        code: task.code || null,
        title: task.title,
        notes: task.description || null,
        dueDate: task.dueDate,
        done,
        // Tasks don't track an explicit completion timestamp, so fall back to
        // updatedAt which is close enough for "recently completed" sorting.
        doneAt: done ? task.updatedAt : null,
        priority: task.priority,
        position: null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        project: task.project || null,
        projectId: task.projectId,
        assigneeId: task.assigneeId || null,
        assignee: task.assignee || null,
        status: task.status,
        phaseId: task.phaseId || null,
        phase: task.phase || null,
        parentTaskId: task.parentTaskId || null,
        parent: task.parent || null,
        createdById: task.createdById || null,
        createdBy: task.createdBy || null,
        // Specific-task approval lifecycle — lets the quick-view show
        // the "Pending / Approved / Disapproved" state, the reason, and
        // the creator's "Re-request approval" action from My Tasks.
        specific: Boolean(task.specific),
        approvedAt: task.approvedAt || null,
        approvedById: task.approvedById || null,
        approvedBy: task.approvedBy || null,
        rejectedAt: task.rejectedAt || null,
        rejectedById: task.rejectedById || null,
        rejectionReason: task.rejectionReason || null,
        rejectedBy: task.rejectedBy || null,
    };
}

// Loads a todo and verifies the caller can mutate it. Owners can always
// mutate their own; admins can mutate anyone's.
// Personal to-dos roll time up to a shared project the user can access.
async function assertLinkableProject(req, projectId) {
    const proj = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, isPersonal: true },
    });
    if (!proj) throw httpError(400, 'Linked project does not exist');
    if (proj.isPersonal) {
        throw httpError(
            400,
            'Personal to-dos must be linked to a shared project',
        );
    }
    const scope = await accessibleProjectIds(req);
    if (!scope.includes(projectId)) {
        throw httpError(403, 'You do not have access to that project');
    }
}

async function loadMutableTodoOr404(req, id) {
    const todo = await prisma.todoItem.findUnique({
        where: { id },
        include: todoInclude,
    });
    if (!todo) throw httpError(404, 'Todo not found');
    if (!(await ownerAccess(req, todo.userId))) {
        throw httpError(404, 'Todo not found');
    }
    return todo;
}

function applyStatusToTodoWhere(where, status) {
    if (status === 'open') where.done = false;
    else if (status === 'done') where.done = true;
}

function applyStatusToTaskWhere(where, status) {
    if (status === 'open') where.status = { not: 'DONE' };
    else if (status === 'done') where.status = 'DONE';
}

async function teamMemberUserIds(teamId) {
    const rows = await prisma.teamMember.findMany({
        where: { teamId: String(teamId) },
        select: { userId: true },
    });
    return rows.map((r) => r.userId);
}

// Hard cap on rows returned by the org-wide feed so a busy workspace
// can't pull thousands of rows into a single response. Admins/managers
// can still narrow with the team / project filters.
const ORG_FEED_LIMIT = 500;

// Project visibility for assigned tasks. Admins see everything; managers
// (and any non-admin) are limited to the projects they can read.
async function taskProjectScopeClause(req) {
    if (isAdmin(req)) return {};
    const ids = await accessibleProjectIds(req);
    return { projectId: { in: ids } };
}

// Project visibility for personal to-dos in the org feed. Admins see
// every personal to-do; a manager only sees personal to-dos linked to a
// project they can access — personal to-dos are free-text and would
// otherwise leak private notes from users/projects a manager has no
// relationship with. To-dos with no linked project are admin-only.
async function todoProjectScopeClause(req) {
    if (isAdmin(req)) return {};
    const ids = await accessibleProjectIds(req);
    return { projectId: { in: ids } };
}

// Org-wide feed for admins / managers (optional ?teamId= filter).
async function loadOrgTodoFeed(req, { status, projectId, teamId }) {
    const memberIds = teamId ? await teamMemberUserIds(teamId) : null;
    if (teamId && memberIds.length === 0) {
        return { todos: [], tasks: [] };
    }

    const todoWhere = {};
    applyStatusToTodoWhere(todoWhere, status);
    if (memberIds) todoWhere.userId = { in: memberIds };
    if (projectId) todoWhere.projectId = projectId;
    Object.assign(todoWhere, await todoProjectScopeClause(req));

    const taskWhere = { assigneeId: { not: null } };
    applyStatusToTaskWhere(taskWhere, status);
    if (memberIds) taskWhere.assigneeId = { in: memberIds };
    if (projectId) taskWhere.projectId = projectId;
    Object.assign(taskWhere, await taskProjectScopeClause(req));

    const [todos, tasks] = await Promise.all([
        prisma.todoItem.findMany({
            where: todoWhere,
            include: todoInclude,
            take: ORG_FEED_LIMIT,
            orderBy:
                status === 'done'
                    ? [{ doneAt: 'desc' }, { updatedAt: 'desc' }]
                    : [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        }),
        prisma.task.findMany({
            where: taskWhere,
            include: taskInclude,
            take: ORG_FEED_LIMIT,
            orderBy:
                status === 'done'
                    ? [{ updatedAt: 'desc' }]
                    : [
                          { dueDate: { sort: 'asc', nulls: 'last' } },
                          { createdAt: 'asc' },
                      ],
        }),
    ]);

    return { todos, tasks };
}

// Lists the current user's to-do feed: their personal TodoItems and any
// project Tasks assigned to them, kept as separate arrays so the UI can
// render them in dedicated sections.
//
// Query params:
//   status=open|done|all (default open)
//   projectId=...        filter both arrays to a project
//   include=counts       also return summary counts payload
//   scope=all            admin/manager: all users' open items
//   teamId=...           with scope=all: limit to a team's members
//   userId=...           admin/manager: view a specific user's list
router.get('/', async (req, res, next) => {
    try {
        const status = (req.query.status || 'open').toLowerCase();
        const projectId = req.query.projectId || undefined;
        const teamId = req.query.teamId
            ? String(req.query.teamId)
            : undefined;
        const orgScope = req.query.scope === 'all';

        if (orgScope) {
            if (!isAdminOrManager(req)) {
                throw httpError(
                    403,
                    'Only admins and managers can view all to-dos',
                );
            }
            const { todos, tasks } = await loadOrgTodoFeed(req, {
                status,
                projectId,
                teamId,
            });
            const payload = {
                todos: todos.map(shape),
                tasks: tasks.map(shapeTask),
                targetUserId: null,
                targetUser: null,
                scope: 'all',
                teamId: teamId || null,
            };
            if (req.query.include === 'counts') {
                payload.counts = await summaryCountsOrg(req, {
                    teamId,
                    projectId,
                });
            }
            return res.json(payload);
        }

        const targetUserId = await resolveTargetUserId(req);

        const todoWhere = { userId: targetUserId };
        applyStatusToTodoWhere(todoWhere, status);
        if (projectId) todoWhere.projectId = projectId;

        const taskWhere = { assigneeId: targetUserId };
        applyStatusToTaskWhere(taskWhere, status);
        if (projectId) taskWhere.projectId = projectId;

        const [todos, tasks, target] = await Promise.all([
            prisma.todoItem.findMany({
                where: todoWhere,
                include: todoInclude,
                orderBy:
                    status === 'done'
                        ? [{ doneAt: 'desc' }, { updatedAt: 'desc' }]
                        : [{ position: 'desc' }, { createdAt: 'desc' }],
            }),
            prisma.task.findMany({
                where: taskWhere,
                include: taskInclude,
                orderBy:
                    status === 'done'
                        ? [{ updatedAt: 'desc' }]
                        : [
                              { dueDate: { sort: 'asc', nulls: 'last' } },
                              { createdAt: 'asc' },
                          ],
            }),
            targetUserId === req.user.id
                ? Promise.resolve(null)
                : prisma.user.findUnique({
                      where: { id: targetUserId },
                      select: {
                          id: true,
                          name: true,
                          email: true,
                          avatarUrl: true,
                      },
                  }),
        ]);

        const payload = {
            todos: todos.map(shape),
            tasks: tasks.map(shapeTask),
            targetUserId,
            targetUser: target,
            scope: 'user',
            teamId: null,
        };

        if (req.query.include === 'counts') {
            payload.counts = await summaryCounts(targetUserId);
        }
        res.json(payload);
    } catch (err) {
        next(err);
    }
});

router.get('/summary', async (req, res, next) => {
    try {
        if (req.query.scope === 'all') {
            if (!isAdminOrManager(req)) {
                throw httpError(
                    403,
                    'Only admins and managers can view all to-dos',
                );
            }
            const teamId = req.query.teamId
                ? String(req.query.teamId)
                : undefined;
            const projectId = req.query.projectId
                ? String(req.query.projectId)
                : undefined;
            return res.json({
                counts: await summaryCountsOrg(req, { teamId, projectId }),
            });
        }
        const targetUserId = await resolveTargetUserId(req);
        res.json({ counts: await summaryCounts(targetUserId) });
    } catch (err) {
        next(err);
    }
});

// Combined counts for personal todos + assigned project tasks. The shape
// stays back-compatible (open/done/overdue/dueToday/alert) and adds per-kind
// breakdowns the UI uses for stat cards.
async function summaryCounts(userId) {
    const now = new Date();
    const startOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
    );
    const endOfToday = new Date(
        startOfToday.getTime() + 24 * 60 * 60 * 1000 - 1,
    );

    const [
        todoOpen,
        todoDone,
        todoOverdue,
        todoDueToday,
        taskOpen,
        taskDone,
        taskOverdue,
        taskDueToday,
    ] = await Promise.all([
        prisma.todoItem.count({ where: { userId, done: false } }),
        prisma.todoItem.count({ where: { userId, done: true } }),
        prisma.todoItem.count({
            where: { userId, done: false, dueDate: { lt: startOfToday } },
        }),
        prisma.todoItem.count({
            where: {
                userId,
                done: false,
                dueDate: { gte: startOfToday, lte: endOfToday },
            },
        }),
        prisma.task.count({
            where: { assigneeId: userId, status: { not: 'DONE' } },
        }),
        prisma.task.count({
            where: { assigneeId: userId, status: 'DONE' },
        }),
        prisma.task.count({
            where: {
                assigneeId: userId,
                status: { not: 'DONE' },
                dueDate: { lt: startOfToday },
            },
        }),
        prisma.task.count({
            where: {
                assigneeId: userId,
                status: { not: 'DONE' },
                dueDate: { gte: startOfToday, lte: endOfToday },
            },
        }),
    ]);

    const open = todoOpen + taskOpen;
    const done = todoDone + taskDone;
    const overdue = todoOverdue + taskOverdue;
    const dueToday = todoDueToday + taskDueToday;

    return {
        open,
        done,
        overdue,
        dueToday,
        alert: overdue + dueToday,
        todoOpen,
        todoDone,
        taskOpen,
        taskDone,
    };
}

async function summaryCountsOrg(req, { teamId, projectId } = {}) {
    const memberIds = teamId ? await teamMemberUserIds(teamId) : null;
    if (teamId && memberIds.length === 0) {
        return {
            open: 0,
            done: 0,
            overdue: 0,
            dueToday: 0,
            alert: 0,
            todoOpen: 0,
            todoDone: 0,
            taskOpen: 0,
            taskDone: 0,
        };
    }

    const now = new Date();
    const startOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
    );
    const endOfToday = new Date(
        startOfToday.getTime() + 24 * 60 * 60 * 1000 - 1,
    );

    // Optional explicit project filter (the "All open to-dos" project
    // dropdown). Applied on top of the manager visibility scope clause
    // so counts match the filtered feed exactly.
    const projectFilter = projectId ? { projectId } : {};

    const projectClause = await taskProjectScopeClause(req);
    const todoProjectClause = await todoProjectScopeClause(req);
    const todoUserClause = {
        ...(memberIds ? { userId: { in: memberIds } } : {}),
        ...todoProjectClause,
        ...projectFilter,
    };
    const taskAssigneeClause = memberIds
        ? { assigneeId: { in: memberIds }, ...projectFilter }
        : { assigneeId: { not: null }, ...projectFilter };

    const [
        todoOpen,
        todoDone,
        todoOverdue,
        todoDueToday,
        taskOpen,
        taskDone,
        taskOverdue,
        taskDueToday,
    ] = await Promise.all([
        prisma.todoItem.count({
            where: { ...todoUserClause, done: false },
        }),
        prisma.todoItem.count({
            where: { ...todoUserClause, done: true },
        }),
        prisma.todoItem.count({
            where: {
                ...todoUserClause,
                done: false,
                dueDate: { lt: startOfToday },
            },
        }),
        prisma.todoItem.count({
            where: {
                ...todoUserClause,
                done: false,
                dueDate: { gte: startOfToday, lte: endOfToday },
            },
        }),
        prisma.task.count({
            where: {
                ...taskAssigneeClause,
                ...projectClause,
                status: { not: 'DONE' },
            },
        }),
        prisma.task.count({
            where: {
                ...taskAssigneeClause,
                ...projectClause,
                status: 'DONE',
            },
        }),
        prisma.task.count({
            where: {
                ...taskAssigneeClause,
                ...projectClause,
                status: { not: 'DONE' },
                dueDate: { lt: startOfToday },
            },
        }),
        prisma.task.count({
            where: {
                ...taskAssigneeClause,
                ...projectClause,
                status: { not: 'DONE' },
                dueDate: { gte: startOfToday, lte: endOfToday },
            },
        }),
    ]);

    const open = todoOpen + taskOpen;
    const done = todoDone + taskDone;
    const overdue = todoOverdue + taskOverdue;
    const dueToday = todoDueToday + taskDueToday;

    return {
        open,
        done,
        overdue,
        dueToday,
        alert: overdue + dueToday,
        todoOpen,
        todoDone,
        taskOpen,
        taskDone,
    };
}

router.post('/', async (req, res, next) => {
    try {
        const targetUserId = await resolveTargetUserId(req);
        const data = createSchema.parse(req.body);

        await assertLinkableProject(req, data.projectId);

        const top = await prisma.todoItem.findFirst({
            where: { userId: targetUserId },
            orderBy: { position: 'desc' },
            select: { position: true },
        });
        const nextPosition = (top?.position ?? 0) + 1;

        const todo = await prisma.todoItem.create({
            data: {
                userId: targetUserId,
                title: data.title.trim(),
                notes: data.notes ? data.notes.trim() : null,
                dueDate: data.dueDate ?? null,
                projectId: data.projectId,
                priority: data.priority || 'MEDIUM',
                position: nextPosition,
            },
            include: todoInclude,
        });
        res.status(201).json({ todo: shape(todo) });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        const data = updateSchema.parse(req.body);
        const existing = await loadMutableTodoOr404(req, req.params.id);

        if (data.projectId === null) {
            throw httpError(400, 'Related project is required');
        }
        if (data.projectId) {
            await assertLinkableProject(req, data.projectId);
        } else if (!existing.projectId) {
            throw httpError(400, 'Related project is required');
        }

        const updateData = {};
        if (data.title !== undefined) updateData.title = data.title.trim();
        if (data.notes !== undefined)
            updateData.notes = data.notes ? data.notes.trim() : null;
        if (data.dueDate !== undefined) updateData.dueDate = data.dueDate;
        if (data.projectId !== undefined)
            updateData.projectId = data.projectId || null;
        if (data.priority !== undefined) updateData.priority = data.priority;
        if (data.position !== undefined) updateData.position = data.position;

        const doneChanged =
            data.done !== undefined && data.done !== existing.done;
        if (doneChanged) {
            updateData.done = data.done;
            updateData.doneAt = data.done ? new Date() : null;
        }

        const todo = await prisma.todoItem.update({
            where: { id: existing.id },
            data: updateData,
            include: todoInclude,
        });

        if (doneChanged) {
            await logActivityEvent({
                type: 'TODO_STATUS_CHANGED',
                actorId: req.user.id,
                projectId: todo.projectId || null,
                todoId: todo.id,
                fromValue: existing.done ? 'DONE' : 'OPEN',
                toValue: data.done ? 'DONE' : 'OPEN',
                message: todo.title,
                meta: {
                    ownerId: todo.userId,
                    selfAction: todo.userId === req.user.id,
                },
            });
        }
        res.json({ todo: shape(todo) });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const existing = await loadMutableTodoOr404(req, req.params.id);
        await prisma.todoItem.delete({ where: { id: existing.id } });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.post('/clear-done', async (req, res, next) => {
    try {
        const targetUserId = await resolveTargetUserId(req);
        const result = await prisma.todoItem.deleteMany({
            where: { userId: targetUserId, done: true },
        });
        res.json({ ok: true, deleted: result.count });
    } catch (err) {
        next(err);
    }
});

// Reorder by giving the new ordering of IDs (top-first). All ids must
// belong to the same owner; admins may reorder another user's list by
// passing ?userId=... and ensuring those ids belong to that user.
router.post('/reorder', async (req, res, next) => {
    try {
        const targetUserId = await resolveTargetUserId(req);
        const { ids } = reorderSchema.parse(req.body);

        const owned = await prisma.todoItem.findMany({
            where: { userId: targetUserId, id: { in: ids } },
            select: { id: true },
        });
        if (owned.length !== ids.length) {
            throw httpError(400, 'Some todos do not belong to this user');
        }

        const top = ids.length;
        await prisma.$transaction(
            ids.map((id, idx) =>
                prisma.todoItem.update({
                    where: { id },
                    data: { position: top - idx },
                }),
            ),
        );

        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
