// Shared guard for the "specific task" approval workflow. A specific task
// is FROZEN until an approver signs off: no status changes, no edits, no
// notes/comments, no time entries, no subtasks — nothing but approval (and
// deletion). This centralises that check so every write path enforces it.
const { httpError } = require('../middleware/error');

function isTaskApprovalLocked(task) {
    return Boolean(task && task.specific && !task.approvedAt);
}

// Throws 403 if the given task id points to an unapproved specific task.
// `action` completes the sentence "…before you can <action>."
async function assertTaskApproved(prisma, taskId, action = 'act on this task') {
    if (!taskId) return;
    const t = await prisma.task.findUnique({
        where: { id: taskId },
        select: { specific: true, approvedAt: true },
    });
    if (isTaskApprovalLocked(t)) {
        throw httpError(
            403,
            `This task must be approved before you can ${action}.`,
        );
    }
}

module.exports = { isTaskApprovalLocked, assertTaskApproved };
