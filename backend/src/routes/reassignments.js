// Task reassignment proposal workflow.
//
//   POST   /api/reassignments               Propose a reassignment for a task.
//   GET    /api/reassignments               List proposals visible to the
//                                           caller. Filterable by ?status,
//                                           ?taskId, ?projectId, ?mine=1.
//   GET    /api/reassignments/pending-count Count pending proposals the
//                                           caller is allowed to review.
//   PATCH  /api/reassignments/:id           Approve / reject / re-target the
//                                           proposal (manager / admin only).
//   DELETE /api/reassignments/:id           Cancel the proposal. Allowed for
//                                           the proposer themselves and for
//                                           any admin / manager.
//
// Permissions:
//   - Anyone with read access to the project can propose (typically the
//     current assignee, but a teammate may propose on their behalf).
//   - Approving / rejecting requires admin OR manager role AND read
//     access to the project. (Same matrix that lets a manager edit
//     tasks inside a project they can see.)
//
// Side effects on approval:
//   - The task's `assigneeId` is updated.
//   - The new assignee is upserted as a project participant.
//   - The new assignee gets a TASK_ASSIGNED notification.
//   - A TASK_ASSIGNEE_CHANGED activity event is appended (mirroring
//     what PATCH /api/tasks/:id would have done).
//   - The proposer (and the previous assignee, if different) gets a
//     TASK_REASSIGN_APPROVED notification with the decision note.
//
// Side effects on rejection:
//   - Just status / decision note / decidedBy are stamped; assignee is
//     unchanged. The proposer is notified.

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    notify,
    ensureProjectParticipant,
} = require('../lib/notify');
const { emitToProject } = require('../lib/realtime');
const {
    isAdmin,
    isAdminOrManager,
    requireAdminOrManagerRole,
    CAPABILITIES,
    isAdminOrManagerOrHasCapability,
    assertProjectRead,
    assertProjectWritable,
    accessibleProjectIds,
} = require('../lib/permissions');
const { logActivityEvent } = require('../lib/activityLog');

const router = express.Router();
router.use(requireAuth);

const reassignmentInclude = {
    task: {
        select: {
            id: true,
            title: true,
            projectId: true,
            assigneeId: true,
            parentTaskId: true,
            phaseId: true,
        },
    },
    project: { select: { id: true, name: true } },
    proposer: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    fromAssignee: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    toAssignee: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    decidedBy: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
};

// Mirrors the helper in tasks.js. Lets every plan-side socket know the
// task list is stale (an assignee change shows up in the row).
function emitProjectPlanChanged(projectId, payload) {
    if (!projectId) return;
    emitToProject(projectId, 'project:plan-changed', {
        projectId,
        ...payload,
        at: new Date().toISOString(),
    });
}

const createSchema = z.object({
    taskId: z.string().min(1),
    toAssigneeId: z.string().min(1).optional().nullable(),
    reason: z.string().min(3).max(2000),
});

router.post('/', async (req, res, next) => {
    try {
        const data = createSchema.parse(req.body);

        const task = await prisma.task.findUnique({
            where: { id: data.taskId },
            select: {
                id: true,
                title: true,
                projectId: true,
                assigneeId: true,
            },
        });
        if (!task) throw httpError(404, 'Task not found');

        // Anyone who can read the project can propose a reassignment.
        // The typical proposer is the current assignee but a teammate
        // may propose on their behalf when the assignee is unavailable.
        // Closed projects don't accept new proposals from regular
        // users — admin / manager can still reorganise after closure.
        await assertProjectWritable(
            req,
            task.projectId,
            'propose a reassignment',
        );

        if (data.toAssigneeId && data.toAssigneeId === task.assigneeId) {
            throw httpError(
                400,
                'The proposed assignee is already on this task.',
            );
        }

        // Block stacking duplicate pending proposals for the same task.
        // The reviewer should decide on the existing one first.
        const existingPending = await prisma.taskReassignment.findFirst({
            where: { taskId: task.id, status: 'PENDING' },
            select: { id: true },
        });
        if (existingPending) {
            throw httpError(
                409,
                'A reassignment proposal for this task is already pending review.',
            );
        }

        // If a target was named, make sure the user exists. We do NOT
        // require them to already be a project participant — approving
        // the request will add them.
        if (data.toAssigneeId) {
            const target = await prisma.user.findUnique({
                where: { id: data.toAssigneeId },
                select: { id: true },
            });
            if (!target) throw httpError(404, 'Proposed assignee not found');
        }

        const created = await prisma.taskReassignment.create({
            data: {
                taskId: task.id,
                projectId: task.projectId,
                proposerId: req.user.id,
                fromAssigneeId: task.assigneeId || null,
                toAssigneeId: data.toAssigneeId || null,
                reason: data.reason.trim(),
                status: 'PENDING',
            },
            include: reassignmentInclude,
        });

        // Audit log + activity feed. Persist the human-readable
        // from/to names alongside the ids so the activity feed never
        // has to guess (and so the line still makes sense if the user
        // is later renamed or removed).
        const fromDisplay = created.fromAssignee
            ? created.fromAssignee.name ||
              created.fromAssignee.email ||
              'Unassigned'
            : 'Unassigned';
        const toDisplay = created.toAssignee
            ? created.toAssignee.name ||
              created.toAssignee.email ||
              'Anyone (reviewer picks)'
            : 'Anyone (reviewer picks)';
        await logActivityEvent({
            type: 'TASK_REASSIGN_PROPOSED',
            actorId: req.user.id,
            projectId: task.projectId,
            taskId: task.id,
            message: data.reason.trim().slice(0, 240),
            meta: {
                reassignmentId: created.id,
                fromAssigneeId: task.assigneeId || null,
                toAssigneeId: data.toAssigneeId || null,
                fromAssigneeName: fromDisplay,
                toAssigneeName: toDisplay,
                taskTitle: task.title,
            },
        });

        // Notify reviewers (every admin + every manager who can see the
        // project). We don't notify the proposer themselves.
        const reviewers = await prisma.user.findMany({
            where: {
                status: 'ACTIVE',
                OR: [
                    { role: 'ADMIN' },
                    {
                        role: 'MANAGER',
                        OR: [
                            { projects: { some: { id: task.projectId } } },
                            {
                                projectParticipations: {
                                    some: { projectId: task.projectId },
                                },
                            },
                        ],
                    },
                ],
            },
            select: { id: true },
        });
        const reviewerIds = reviewers
            .map((r) => r.id)
            .filter((id) => id !== req.user.id);
        if (reviewerIds.length) {
            const titlePrefix = data.toAssigneeId
                ? `Reassign request: ${task.title}`
                : `Reassign request: ${task.title}`;
            const targetName =
                created.toAssignee?.name ||
                created.toAssignee?.email ||
                'someone else';
            const body = data.toAssigneeId
                ? `${created.proposer.name || created.proposer.email} proposes reassigning "${task.title}" to ${targetName}. Reason: ${created.reason}`
                : `${created.proposer.name || created.proposer.email} proposes reassigning "${task.title}". Reason: ${created.reason}`;

            await notify({
                recipientIds: reviewerIds,
                actorId: req.user.id,
                type: 'TASK_REASSIGN_PROPOSED',
                title: titlePrefix,
                body,
                projectId: task.projectId,
                meta: {
                    taskId: task.id,
                    reassignmentId: created.id,
                },
            });
        }

        emitProjectPlanChanged(task.projectId, {
            kind: 'reassignment-proposed',
            taskId: task.id,
            reassignmentId: created.id,
        });

        res.status(201).json({ reassignment: created });
    } catch (err) {
        next(err);
    }
});

const listQuery = z.object({
    status: z
        .enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])
        .optional(),
    taskId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    mine: z.enum(['1', 'true']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get('/', async (req, res, next) => {
    try {
        const q = listQuery.parse(req.query);

        // Build the visibility filter. Admins see everything. Managers
        // see proposals in projects they can read AND ones they
        // proposed themselves. Regular users see only proposals they
        // proposed OR proposals about tasks they're currently assigned
        // to (so they get visibility into someone else asking to take
        // their task).
        const projectScope = await accessibleProjectIds(req);
        const where = {};
        if (q.status) where.status = q.status;
        if (q.taskId) where.taskId = q.taskId;
        if (q.projectId) {
            // If the user can't see this project, return empty rather
            // than 403 — keeps the picker UI simple.
            if (!projectScope.includes(q.projectId)) {
                return res.json({ reassignments: [] });
            }
            where.projectId = q.projectId;
        }

        if (q.mine === '1' || q.mine === 'true') {
            where.proposerId = req.user.id;
        } else if (!isAdmin(req)) {
            if (isAdminOrManager(req)) {
                if (projectScope.length === 0) {
                    return res.json({ reassignments: [] });
                }
                if (!q.projectId) {
                    where.projectId = { in: projectScope };
                }
            } else {
                // Regular users: own proposals OR proposals about tasks
                // they're currently the assignee of OR proposals about
                // tasks where they're the proposed target.
                where.OR = [
                    { proposerId: req.user.id },
                    { fromAssigneeId: req.user.id },
                    { toAssigneeId: req.user.id },
                ];
            }
        } else {
            // Admins: still scope to projects they can see (excludes
            // others' personal projects).
            where.projectId = q.projectId ? where.projectId : { in: projectScope };
        }

        const reassignments = await prisma.taskReassignment.findMany({
            where,
            orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
            take: q.limit || 100,
            include: reassignmentInclude,
        });
        res.json({ reassignments });
    } catch (err) {
        next(err);
    }
});

router.get('/pending-count', async (req, res, next) => {
    try {
        // The bell badge wants a single number: how many proposals the
        // caller can act on right now. Admins → all pending. Managers →
        // pending in projects they can read. Users → pending where they
        // are the from / to / proposer (so they can see their own
        // requests progress).
        const where = { status: 'PENDING' };
        const ids = await accessibleProjectIds(req);
        if (isAdmin(req)) {
            // Admins still excluded from other users' personal projects.
            where.projectId = { in: ids };
        } else if (isAdminOrManager(req)) {
            if (ids.length === 0) return res.json({ pending: 0 });
            where.projectId = { in: ids };
        } else {
            where.OR = [
                { proposerId: req.user.id },
                { fromAssigneeId: req.user.id },
                { toAssigneeId: req.user.id },
            ];
        }
        const pending = await prisma.taskReassignment.count({ where });
        res.json({ pending });
    } catch (err) {
        next(err);
    }
});

const decideSchema = z.object({
    action: z.enum(['approve', 'reject']),
    // Reviewer can override the proposed assignee at approval time
    // (e.g. proposer left it null, or named someone unsuitable).
    toAssigneeId: z.string().min(1).optional().nullable(),
    decisionNote: z.string().max(2000).optional().nullable(),
});

router.patch('/:id', async (req, res, next) => {
    try {
        // Approve / reject is admin-or-manager by default; the
        // `task:reassign:approve` capability lets an admin delegate
        // the same power to a specific user without promoting them.
        if (
            !isAdminOrManagerOrHasCapability(
                req,
                CAPABILITIES.TASK_REASSIGN_APPROVE,
            )
        ) {
            throw httpError(
                403,
                'You do not have permission to decide reassignment requests',
            );
        }
        const { id } = req.params;
        const body = decideSchema.parse(req.body);

        const existing = await prisma.taskReassignment.findUnique({
            where: { id },
            include: reassignmentInclude,
        });
        if (!existing) throw httpError(404, 'Reassignment not found');
        await assertProjectRead(req, existing.projectId);

        if (existing.status !== 'PENDING') {
            throw httpError(
                409,
                `This reassignment was already ${existing.status.toLowerCase()}.`,
            );
        }

        if (body.action === 'approve') {
            const targetId =
                body.toAssigneeId !== undefined
                    ? body.toAssigneeId
                    : existing.toAssigneeId;
            if (!targetId) {
                throw httpError(
                    400,
                    'Pick an assignee before approving this reassignment.',
                );
            }

            const target = await prisma.user.findUnique({
                where: { id: targetId },
                select: { id: true, name: true, email: true },
            });
            if (!target) throw httpError(404, 'Target user not found');

            // Make sure the new assignee can see the project.
            await ensureProjectParticipant(
                existing.projectId,
                target.id,
                req.user.id,
            );

            // Apply the assignee change + flip the proposal in one trip.
            const previousAssigneeId = existing.task.assigneeId;

            // Resolve human-readable names for the activity feed so it
            // reads "Alice → Bob" instead of "ckxyz123 → ckxyz456".
            // Falls back to email and finally a generic placeholder.
            const fromName = existing.fromAssignee
                ? existing.fromAssignee.name ||
                  existing.fromAssignee.email ||
                  'Unassigned'
                : 'Unassigned';
            const toName = target.name || target.email || 'Unassigned';

            const [, updated] = await prisma.$transaction([
                prisma.task.update({
                    where: { id: existing.taskId },
                    data: { assigneeId: target.id },
                }),
                prisma.taskReassignment.update({
                    where: { id },
                    data: {
                        status: 'APPROVED',
                        decidedById: req.user.id,
                        decidedAt: new Date(),
                        decisionNote: body.decisionNote || null,
                        toAssigneeId: target.id,
                    },
                    include: reassignmentInclude,
                }),
            ]);

            // Audit log: assignee change + proposal decided. Mirrors
            // the convention used by PATCH /tasks/:id — the from/to
            // *Value fields hold display names; the underlying ids
            // live in meta for callers that need to deep-link.
            await logActivityEvent({
                type: 'TASK_ASSIGNEE_CHANGED',
                actorId: req.user.id,
                projectId: existing.projectId,
                taskId: existing.taskId,
                fromValue: fromName,
                toValue: toName,
                message: existing.task.title,
                meta: {
                    via: 'reassignment',
                    reassignmentId: existing.id,
                    taskTitle: existing.task.title,
                    fromAssigneeId: previousAssigneeId,
                    toAssigneeId: target.id,
                },
            });
            await logActivityEvent({
                type: 'TASK_REASSIGN_APPROVED',
                actorId: req.user.id,
                projectId: existing.projectId,
                taskId: existing.taskId,
                message: body.decisionNote || null,
                meta: {
                    reassignmentId: existing.id,
                    fromAssigneeId: previousAssigneeId,
                    toAssigneeId: target.id,
                    fromAssigneeName: fromName,
                    toAssigneeName: toName,
                    proposerName:
                        existing.proposer?.name ||
                        existing.proposer?.email ||
                        null,
                    taskTitle: existing.task.title,
                },
            });

            // Notify the proposer (decision result) and the new
            // assignee (you're now on the hook).
            const recipients = new Set();
            if (existing.proposerId) recipients.add(existing.proposerId);
            if (previousAssigneeId) recipients.add(previousAssigneeId);
            if (target.id) recipients.add(target.id);
            recipients.delete(req.user.id);

            if (recipients.size) {
                await notify({
                    recipientIds: Array.from(recipients),
                    actorId: req.user.id,
                    type: 'TASK_REASSIGN_APPROVED',
                    title: `Reassignment approved: ${existing.task.title}`,
                    body: `Now assigned to ${target.name || target.email}.${
                        body.decisionNote ? ` Note: ${body.decisionNote}` : ''
                    }`,
                    projectId: existing.projectId,
                    meta: {
                        taskId: existing.taskId,
                        reassignmentId: existing.id,
                    },
                });
            }
            // Also use the regular TASK_ASSIGNED channel so the new
            // assignee sees the same "you've been assigned" UI as if it
            // had happened via the task editor.
            if (target.id !== req.user.id) {
                await notify({
                    recipientIds: [target.id],
                    actorId: req.user.id,
                    type: 'TASK_ASSIGNED',
                    title: `Assigned to: ${existing.task.title}`,
                    body: `${req.user.email} approved a reassignment to you.`,
                    projectId: existing.projectId,
                    meta: { taskId: existing.taskId },
                });
            }

            emitProjectPlanChanged(existing.projectId, {
                kind: 'task-updated',
                taskId: existing.taskId,
                reassignmentId: existing.id,
            });

            return res.json({ reassignment: updated });
        }

        // action === 'reject'
        const updated = await prisma.taskReassignment.update({
            where: { id },
            data: {
                status: 'REJECTED',
                decidedById: req.user.id,
                decidedAt: new Date(),
                decisionNote: body.decisionNote || null,
            },
            include: reassignmentInclude,
        });

        await logActivityEvent({
            type: 'TASK_REASSIGN_REJECTED',
            actorId: req.user.id,
            projectId: existing.projectId,
            taskId: existing.taskId,
            message: body.decisionNote || null,
            meta: {
                reassignmentId: existing.id,
                taskTitle: existing.task.title,
                fromAssigneeName: existing.fromAssignee
                    ? existing.fromAssignee.name ||
                      existing.fromAssignee.email
                    : null,
                toAssigneeName: existing.toAssignee
                    ? existing.toAssignee.name ||
                      existing.toAssignee.email
                    : null,
                proposerName:
                    existing.proposer?.name ||
                    existing.proposer?.email ||
                    null,
            },
        });

        if (existing.proposerId !== req.user.id) {
            await notify({
                recipientIds: [existing.proposerId],
                actorId: req.user.id,
                type: 'TASK_REASSIGN_REJECTED',
                title: `Reassignment declined: ${existing.task.title}`,
                body: body.decisionNote
                    ? `Note: ${body.decisionNote}`
                    : 'No further notes were left.',
                projectId: existing.projectId,
                meta: {
                    taskId: existing.taskId,
                    reassignmentId: existing.id,
                },
            });
        }

        emitProjectPlanChanged(existing.projectId, {
            kind: 'reassignment-decided',
            taskId: existing.taskId,
            reassignmentId: existing.id,
        });
        res.json({ reassignment: updated });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const existing = await prisma.taskReassignment.findUnique({
            where: { id },
            include: reassignmentInclude,
        });
        if (!existing) throw httpError(404, 'Reassignment not found');

        // Cancellation: the proposer themselves, or any reviewer.
        const canCancel =
            existing.proposerId === req.user.id || isAdminOrManager(req);
        if (!canCancel) throw httpError(403, 'Cannot cancel this proposal');

        if (existing.status !== 'PENDING') {
            throw httpError(409, 'Only pending proposals can be cancelled.');
        }

        const updated = await prisma.taskReassignment.update({
            where: { id },
            data: {
                status: 'CANCELLED',
                decidedById: req.user.id,
                decidedAt: new Date(),
            },
            include: reassignmentInclude,
        });

        emitProjectPlanChanged(existing.projectId, {
            kind: 'reassignment-decided',
            taskId: existing.taskId,
            reassignmentId: existing.id,
        });
        res.json({ reassignment: updated });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
