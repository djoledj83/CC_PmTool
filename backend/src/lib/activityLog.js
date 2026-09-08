// Tiny wrapper around prisma.activityEvent.create that swallows errors
// so an audit-log failure never breaks the surrounding action. Every
// route that mutates a status / completes an activity should funnel
// through here so the Activities feed stays in sync.

const prisma = require('./prisma');

async function logActivityEvent({
    type,
    actorId = null,
    projectId = null,
    taskId = null,
    todoId = null,
    activityId = null,
    fromValue = null,
    toValue = null,
    message = null,
    meta = null,
}) {
    try {
        const created = await prisma.activityEvent.create({
            data: {
                type,
                actorId: actorId || null,
                projectId: projectId || null,
                taskId: taskId || null,
                todoId: todoId || null,
                activityId: activityId || null,
                fromValue: fromValue || null,
                toValue: toValue || null,
                message: message || null,
                meta: meta || undefined,
            },
            select: { id: true, type: true, projectId: true, createdAt: true },
        });
        // Spot-trace TASK_DELETED / TASK_RESTORED in particular so we
        // can correlate "user deleted a task but feed shows nothing"
        // reports against actual DB writes. These are rare events so
        // the log noise stays low.
        if (type === 'TASK_DELETED' || type === 'TASK_RESTORED') {
            console.log(
                `[activityLog] wrote ${type} id=${created.id} project=${
                    created.projectId || 'none'
                } at=${created.createdAt.toISOString()}`,
            );
        }
    } catch (err) {
        // Audit failures should not bubble up — log and move on.
        console.warn('[activityLog] failed to write event:', err.message);
    }
}

module.exports = { logActivityEvent };
