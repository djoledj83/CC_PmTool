// Static fallback list for project statuses. The runtime list comes
// from /api/templates/statuses (admin-managed labels/colors/order via
// StatusOption), but we still ship these constants so:
//   1. The UI renders sensibly before the API call resolves.
//   2. Code that inspects a status value (burndown, sprint close,
//      deadline alerts) keeps a canonical key→label fallback when a
//      status row was hidden by the admin but historical rows still
//      reference it.
// Order here mirrors the seeded order in backend/src/lib/bootstrap.js
// so the fallback dropdown matches a freshly seeded install.
export const PROJECT_STATUSES = [
    { value: 'TODO', label: 'To do', badge: 'secondary' },
    { value: 'IN_PROGRESS', label: 'In progress', badge: 'warning' },
    { value: 'CLIENT_TEST', label: 'Client test', badge: 'default' },
    { value: 'BILLING', label: 'Billing', badge: 'warning' },
    { value: 'DONE', label: 'Completed', badge: 'success' },
    { value: 'ON_HOLD', label: 'On hold', badge: 'outline' },
];

export const PROJECT_STATUS_MAP = Object.fromEntries(
    PROJECT_STATUSES.map((s) => [s.value, s]),
);

/** Statuses hidden for ongoing project types (hideMarkComplete). */
export const ONGOING_HIDDEN_STATUSES = new Set([
    'DONE',
    'CLIENT_TEST',
    'BILLING',
]);

/** Drop terminal workflow statuses for ongoing / maintenance types. */
export function filterProjectStatuses(statuses, hideComplete) {
    if (!hideComplete) return statuses;
    return statuses.filter((s) => !ONGOING_HIDDEN_STATUSES.has(s.value));
}

export const PROJECT_PRIORITIES = [
    { value: 'LOW', label: 'Low', badge: 'outline' },
    { value: 'MEDIUM', label: 'Medium', badge: 'secondary' },
    { value: 'HIGH', label: 'High', badge: 'warning' },
    { value: 'URGENT', label: 'Urgent', badge: 'destructive' },
];

export const PROJECT_PRIORITY_MAP = Object.fromEntries(
    PROJECT_PRIORITIES.map((p) => [p.value, p]),
);

export const TASK_STATUSES = [
    { value: 'TODO', label: 'To do', badge: 'secondary' },
    { value: 'IN_PROGRESS', label: 'In progress', badge: 'warning' },
    { value: 'ON_HOLD', label: 'On hold', badge: 'outline' },
    { value: 'DONE', label: 'Done', badge: 'success' },
];

export const TASK_STATUS_MAP = Object.fromEntries(
    TASK_STATUSES.map((s) => [s.value, s]),
);

export const TASK_PRIORITIES = [
    { value: 'LOW', label: 'Low', badge: 'outline' },
    { value: 'MEDIUM', label: 'Medium', badge: 'secondary' },
    { value: 'HIGH', label: 'High', badge: 'destructive' },
];

export const TASK_PRIORITY_MAP = Object.fromEntries(
    TASK_PRIORITIES.map((p) => [p.value, p]),
);
