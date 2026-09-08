const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    notify,
    projectParticipantIds,
    ensureProjectParticipant,
    isProjectParticipant,
} = require('../lib/notify');
const {
    isAdminOrManager,
    requireAdminOrManagerRole,
    assertProjectRead,
    accessibleProjectIds,
} = require('../lib/permissions');
const { logActivityEvent } = require('../lib/activityLog');

const router = express.Router();

router.use(requireAuth);

const KINDS = z.enum([
    'CALL',
    'MEETING',
    'REMINDER',
    'COMMENT',
    'DOCUMENT',
    'OTHER',
]);

const optionalDate = z
    .union([z.string().min(1), z.literal(''), z.null()])
    .optional()
    .transform((v) => {
        if (v === undefined) return undefined;
        if (v === null || v === '') return null;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return null;
        return d;
    });

const createSchema = z.object({
    projectId: z.string().min(1),
    phaseId: z.string().min(1).optional().nullable(),
    kind: KINDS.optional(),
    title: z.string().min(1).max(200),
    details: z.string().max(5000).optional().nullable(),
    scheduledAt: optionalDate,
    assigneeId: z.string().min(1).optional().nullable(),
});

const updateSchema = z.object({
    phaseId: z.string().min(1).optional().nullable(),
    kind: KINDS.optional(),
    title: z.string().min(1).max(200).optional(),
    details: z.string().max(5000).optional().nullable(),
    scheduledAt: optionalDate,
    assigneeId: z.string().min(1).optional().nullable(),
    done: z.boolean().optional(),
    order: z.number().int().optional(),
});

const KIND_LABEL = {
    CALL: 'Call',
    MEETING: 'Meeting',
    REMINDER: 'Reminder',
    COMMENT: 'Comment',
    DOCUMENT: 'Document',
    OTHER: 'Activity',
};

const include = {
    assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
    createdBy: { select: { id: true, name: true, email: true, avatarUrl: true } },
    project: { select: { id: true, name: true } },
    phase: { select: { id: true, name: true } },
};

async function loadActivityOr404(id) {
    const activity = await prisma.projectActivity.findUnique({
        where: { id },
        include,
    });
    if (!activity) throw httpError(404, 'Activity not found');
    return activity;
}

async function ensurePhaseInProject(phaseId, projectId) {
    if (!phaseId) return;
    const phase = await prisma.phase.findUnique({ where: { id: phaseId } });
    if (!phase || phase.projectId !== projectId) {
        throw httpError(400, 'Phase does not belong to this project');
    }
}

async function ensureAssigneeIsParticipant(projectId, assigneeId) {
    if (!assigneeId) return;
    const member = await isProjectParticipant(projectId, assigneeId);
    if (!member) {
        throw httpError(
            400,
            'Activity assignee must be a participant of the project',
        );
    }
}

// GET /api/plan-activities?projectId=&assignee=me|<id>&status=open|done|overdue|all&since=7d|30d|90d|all&limit=
// Used by both the Plan tab (per-project) and the Activities page
// (cross-project list). Defaults match the "My activities" view: open
// items, sorted by soonest first.
router.get('/', async (req, res, next) => {
    try {
        const {
            projectId,
            assignee,
            status,
            since,
            limit: limitRaw,
        } = req.query;

        const where = {};
        if (projectId) {
            await assertProjectRead(req, projectId);
            where.projectId = projectId;
        } else {
            const ids = await accessibleProjectIds(req);
            where.projectId = { in: ids };
        }

        if (assignee) {
            // 'me' resolves to the caller; otherwise admins can filter by any
            // user id (regular users are silently restricted to themselves).
            if (assignee === 'me') {
                where.assigneeId = req.user.id;
            } else if (req.user?.role === 'ADMIN') {
                where.assigneeId = assignee;
            } else {
                where.assigneeId = req.user.id;
            }
        }

        const now = new Date();
        if (status === 'open') {
            where.done = false;
        } else if (status === 'done') {
            where.done = true;
        } else if (status === 'overdue') {
            where.done = false;
            where.scheduledAt = { lt: now };
        }

        if (since && since !== 'all') {
            const days =
                since === '7d' ? 7 : since === '30d' ? 30 : since === '90d' ? 90 : 0;
            if (days > 0) {
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - days);
                // Prefer scheduled date if present, fall back to created.
                where.OR = [
                    { scheduledAt: { gte: cutoff } },
                    { scheduledAt: null, createdAt: { gte: cutoff } },
                ];
            }
        }

        const limit = Math.min(Math.max(Number(limitRaw) || 200, 1), 500);

        const activities = await prisma.projectActivity.findMany({
            where,
            orderBy: [
                { done: 'asc' },
                { scheduledAt: 'asc' },
                { order: 'asc' },
                { createdAt: 'desc' },
            ],
            include,
            take: limit,
        });
        res.json({ activities });
    } catch (err) {
        next(err);
    }
});

router.post('/', async (req, res, next) => {
    try {
        // Same permission ladder as tasks: admins + managers can create
        // activities inside any project they can read.
        requireAdminOrManagerRole(req);
        const data = createSchema.parse(req.body);
        await assertProjectRead(req, data.projectId);
        await ensurePhaseInProject(data.phaseId || null, data.projectId);
        await ensureAssigneeIsParticipant(data.projectId, data.assigneeId);

        const activity = await prisma.projectActivity.create({
            data: {
                projectId: data.projectId,
                phaseId: data.phaseId || null,
                kind: data.kind || 'MEETING',
                title: data.title.trim(),
                details: data.details?.trim() || null,
                scheduledAt: data.scheduledAt ?? null,
                assigneeId: data.assigneeId || null,
                createdById: req.user.id,
            },
            include,
        });

        // Pull the actor + assignee into the project conversation.
        await ensureProjectParticipant(activity.projectId, req.user.id, req.user.id);
        if (activity.assigneeId) {
            await ensureProjectParticipant(
                activity.projectId,
                activity.assigneeId,
                req.user.id,
            );
        }

        const involved = await projectParticipantIds(activity.projectId);
        const kindLabel = KIND_LABEL[activity.kind] || 'Activity';
        await notify({
            recipientIds: involved,
            actorId: req.user.id,
            type: 'TASK_CREATED',
            title: `${activity.project.name}: new ${kindLabel.toLowerCase()}`,
            body: `${req.user.email} added "${activity.title}".`,
            projectId: activity.projectId,
            meta: { activityId: activity.id, kind: activity.kind },
        });

        await logActivityEvent({
            type: 'PROJECT_ACTIVITY_CREATED',
            actorId: req.user.id,
            projectId: activity.projectId,
            activityId: activity.id,
            toValue: activity.kind,
            message: activity.title,
            meta: {
                kindLabel,
                scheduledAt: activity.scheduledAt,
                assigneeId: activity.assigneeId,
            },
        });

        res.status(201).json({ activity });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        const existing = await loadActivityOr404(req.params.id);
        const data = updateSchema.parse(req.body);

        // Same ladder as tasks: admins + managers can edit any field;
        // everyone else can only flip `done` (and only if they're the
        // assignee or creator of the activity).
        if (!isAdminOrManager(req)) {
            const submittedKeys = Object.keys(data).filter(
                (k) => data[k] !== undefined,
            );
            const onlyDone =
                submittedKeys.length > 0 &&
                submittedKeys.every((k) => k === 'done');
            const isOwner =
                existing.assigneeId === req.user.id ||
                existing.createdById === req.user.id;
            if (!onlyDone || !isOwner) {
                throw httpError(
                    403,
                    isOwner
                        ? 'You can only mark this activity done.'
                        : 'Only an administrator or manager can edit activities.',
                );
            }
        } else {
            // Managers must still be participants/owners of the project.
            await assertProjectRead(req, existing.projectId);
        }

        if (data.phaseId !== undefined) {
            await ensurePhaseInProject(data.phaseId, existing.projectId);
        }
        if (data.assigneeId !== undefined && data.assigneeId) {
            await ensureAssigneeIsParticipant(
                existing.projectId,
                data.assigneeId,
            );
        }

        const updateData = {};
        if (data.title !== undefined) updateData.title = data.title.trim();
        if (data.details !== undefined)
            updateData.details = data.details ? data.details.trim() : null;
        if (data.scheduledAt !== undefined)
            updateData.scheduledAt = data.scheduledAt;
        if (data.kind !== undefined) updateData.kind = data.kind;
        if (data.phaseId !== undefined)
            updateData.phaseId = data.phaseId || null;
        if (data.assigneeId !== undefined)
            updateData.assigneeId = data.assigneeId || null;
        if (data.order !== undefined) updateData.order = data.order;

        const doneChanged =
            data.done !== undefined && data.done !== existing.done;
        if (doneChanged) {
            updateData.done = data.done;
            updateData.doneAt = data.done ? new Date() : null;
        }

        const activity = await prisma.projectActivity.update({
            where: { id: existing.id },
            data: updateData,
            include,
        });

        if (
            data.assigneeId !== undefined &&
            data.assigneeId &&
            data.assigneeId !== existing.assigneeId
        ) {
            await ensureProjectParticipant(
                activity.projectId,
                data.assigneeId,
                req.user.id,
            );
            await notify({
                recipientIds: [data.assigneeId],
                actorId: req.user.id,
                type: 'TASK_ASSIGNED',
                title: `Assigned to you: ${activity.title}`,
                body: `${req.user.email} assigned an activity to you on ${activity.project.name}.`,
                projectId: activity.projectId,
                meta: { activityId: activity.id, kind: activity.kind },
            });
        }

        if (doneChanged) {
            await logActivityEvent({
                type: data.done
                    ? 'PROJECT_ACTIVITY_COMPLETED'
                    : 'PROJECT_ACTIVITY_REOPENED',
                actorId: req.user.id,
                projectId: activity.projectId,
                activityId: activity.id,
                fromValue: existing.done ? 'DONE' : 'OPEN',
                toValue: data.done ? 'DONE' : 'OPEN',
                message: activity.title,
                meta: { kind: activity.kind },
            });
        }

        res.json({ activity });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        requireAdminOrManagerRole(req);
        const existing = await loadActivityOr404(req.params.id);
        await assertProjectRead(req, existing.projectId);
        await prisma.projectActivity.delete({ where: { id: existing.id } });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
