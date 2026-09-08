// Shared bits for the "logging time on someone else's task" flow.
// When a user logs time against a task assigned to a DIFFERENT person
// (helping, participating, covering …) we ask them to pick a reason so
// the entry is auditable. Categories are kept in sync with the backend
// (routes/time.js CROSS_USER_REASONS + lib/csv.js labels).

export const CROSS_USER_REASONS = [
    { value: 'HELPING', label: 'Helping' },
    { value: 'PARTICIPATING', label: 'Participating' },
    { value: 'COVERING', label: 'Covering (out of office)' },
    { value: 'CORRECTING', label: 'Correcting / fixing' },
    { value: 'OTHER', label: 'Other' },
];

export const CROSS_USER_REASON_LABELS = Object.fromEntries(
    CROSS_USER_REASONS.map((r) => [r.value, r.label]),
);

// True when `task` is assigned to someone other than the current user.
// Unassigned tasks and project-level entries are never "someone else's".
export function isOthersTask(task, currentUserId) {
    if (!task || !currentUserId) return false;
    const assigneeId = task.assignee?.id || task.assigneeId || null;
    return Boolean(assigneeId && assigneeId !== currentUserId);
}

// Best-effort display name for the current assignee (for the warning).
export function assigneeLabel(task) {
    return task?.assignee?.name || task?.assigneeName || 'another user';
}
