// Built-in keys of the admin-styled option tables (StatusOption /
// PriorityOption). Task status and task / project priority are database
// enums, so those scopes are CLOSED: their option rows only change how
// the values look. Project statuses are free text (lib/projectStatuses)
// with six built-in keys the code relies on.
const BUILTIN_OPTION_KEYS = {
    statuses: {
        TASK: ['TODO', 'IN_PROGRESS', 'ON_HOLD', 'DONE'],
        PROJECT: ['TODO', 'IN_PROGRESS', 'CLIENT_TEST', 'BILLING', 'DONE', 'ON_HOLD'],
    },
    priorities: {
        TASK: ['LOW', 'MEDIUM', 'HIGH'],
        PROJECT: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
    },
};

// Scopes that take no keys beyond the built-in ones.
const CLOSED_SCOPES = {
    statuses: ['TASK'],
    priorities: ['TASK', 'PROJECT'],
};

const isClosedScope = (kind, scope) => (CLOSED_SCOPES[kind] || []).includes(scope);

// Default look of the rows seeded for a closed scope.
const OPTION_DEFAULTS = {
    statuses: {
        TASK: [
            { key: 'TODO', label: 'To do', color: 'sky' },
            { key: 'IN_PROGRESS', label: 'In progress', color: 'amber' },
            { key: 'ON_HOLD', label: 'On hold', color: 'slate' },
            { key: 'DONE', label: 'Done', color: 'emerald' },
        ],
    },
    priorities: {
        PROJECT: [
            { key: 'LOW', label: 'Low', color: 'slate' },
            { key: 'MEDIUM', label: 'Medium', color: 'sky' },
            { key: 'HIGH', label: 'High', color: 'amber' },
            { key: 'URGENT', label: 'Urgent', color: 'rose' },
        ],
        TASK: [
            { key: 'LOW', label: 'Low', color: 'slate' },
            { key: 'MEDIUM', label: 'Medium', color: 'sky' },
            { key: 'HIGH', label: 'High', color: 'rose' },
        ],
    },
};

module.exports = {
    BUILTIN_OPTION_KEYS,
    CLOSED_SCOPES,
    isClosedScope,
    OPTION_DEFAULTS,
};
