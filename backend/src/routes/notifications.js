const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const { runDeadlineSweep } = require('../lib/deadlineAlerts');

const router = express.Router();

router.use(requireAuth);

function isAdmin(req) {
    return req.user?.role === 'ADMIN';
}

const notificationInclude = {
    actor: { select: { id: true, name: true, email: true, avatarUrl: true } },
    project: { select: { id: true, name: true } },
};

// Notifications store the related task id in `meta.taskId` (there's no
// FK column), so we can't `include` the task via Prisma. Instead we
// batch-look-up every referenced task once and attach a small
// `task: { id, code, title, parentTaskId, parent }` object to each
// notification — this is what lets the bell show the task NAME (and,
// for subtasks, the parent task) on its own line. Works for old rows
// too since it reads from meta at fetch time.
async function attachTasks(notifications) {
    const taskIds = [
        ...new Set(
            notifications
                .map((n) => n.meta?.taskId)
                .filter((id) => typeof id === 'string' && id.length > 0),
        ),
    ];
    if (taskIds.length === 0) return notifications;
    const tasks = await prisma.task.findMany({
        where: { id: { in: taskIds } },
        select: {
            id: true,
            code: true,
            title: true,
            parentTaskId: true,
            parent: { select: { id: true, code: true, title: true } },
        },
    });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return notifications.map((n) => {
        const t = n.meta?.taskId ? byId.get(n.meta.taskId) : null;
        return t ? { ...n, task: t } : n;
    });
}

router.get('/', async (req, res, next) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const onlyUnread = req.query.unread === '1' || req.query.unread === 'true';

        const notifications = await prisma.notification.findMany({
            where: {
                userId: req.user.id,
                ...(onlyUnread ? { read: false } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: notificationInclude,
        });
        const unread = await prisma.notification.count({
            where: { userId: req.user.id, read: false },
        });

        res.json({ notifications: await attachTasks(notifications), unread });
    } catch (err) {
        next(err);
    }
});

router.get('/unread-count', async (req, res, next) => {
    try {
        const unread = await prisma.notification.count({
            where: { userId: req.user.id, read: false },
        });
        res.json({ unread });
    } catch (err) {
        next(err);
    }
});

const idsSchema = z.object({
    ids: z.array(z.string().min(1)).optional(),
});

router.post('/mark-read', async (req, res, next) => {
    try {
        const { ids } = idsSchema.parse(req.body || {});
        const now = new Date();
        await prisma.notification.updateMany({
            where: {
                userId: req.user.id,
                ...(ids && ids.length ? { id: { in: ids } } : {}),
                read: false,
            },
            data: { read: true, readAt: now },
        });
        const unread = await prisma.notification.count({
            where: { userId: req.user.id, read: false },
        });
        res.json({ ok: true, unread });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const note = await prisma.notification.findUnique({
            where: { id: req.params.id },
        });
        if (!note || note.userId !== req.user.id) {
            throw httpError(404, 'Notification not found');
        }
        await prisma.notification.delete({ where: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.delete('/', async (req, res, next) => {
    try {
        await prisma.notification.deleteMany({ where: { userId: req.user.id } });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// Admin-only manual trigger for the deadline alert sweep. Useful for
// testing without waiting for the 24h schedule. Idempotent — the
// dedupe table makes re-running it the same day a no-op. Returns the
// sweep stats so the caller (curl / a future admin button) can see
// exactly what happened.
router.post('/run-deadline-sweep', async (req, res, next) => {
    try {
        if (!isAdmin(req)) {
            throw httpError(403, 'Admin permission required');
        }
        const stats = await runDeadlineSweep();
        res.json({ ok: true, ...stats });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
