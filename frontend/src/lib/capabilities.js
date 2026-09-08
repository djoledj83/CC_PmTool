// Frontend mirror of backend/src/lib/permissions.js. Keep these two
// files in sync — the backend is the source of truth, but the UI needs
// the labels/groupings to render the per-user capability checkboxes
// inside the User edit dialog.

export const CAPABILITIES = {
    // ---- Projects ----------------------------------------------------
    PROJECT_CREATE: 'project:create',
    PROJECT_EDIT_ANY: 'project:edit:any',
    PROJECT_DELETE: 'project:delete',
    PROJECT_CLOSE: 'project:close',
    PROJECT_BILLING_MANAGE: 'project:billing:manage',
    PROJECT_PARTICIPANTS_MANAGE: 'project:participants:manage',

    // ---- Tasks & subtasks --------------------------------------------
    TASK_CREATE_ANY: 'task:create:any',
    TASK_EDIT_ANY: 'task:edit:any',
    TASK_DELETE_ANY: 'task:delete:any',
    TASK_REASSIGN_APPROVE: 'task:reassign:approve',
    TASK_APPROVE: 'task:approve',
    TASK_SPECIFIC_CREATE: 'task:specific:create',

    // ---- Users -------------------------------------------------------
    USER_CREATE: 'user:create',
    USER_EDIT_ANY: 'user:edit:any',
    USER_APPROVE: 'user:approve',
    USER_ROLE_MANAGE: 'user:role:manage',

    // ---- Teams -------------------------------------------------------
    TEAM_MANAGE: 'team:manage',

    // ---- Templates ---------------------------------------------------
    TEMPLATE_MANAGE: 'template:manage',

    // ---- Time tracking -----------------------------------------------
    TIME_VIEW_ALL: 'time:view:all',
    TIME_EXPORT: 'time:export',

    // ---- Insights / analytics ----------------------------------------
    INSIGHTS_VIEW_ALL: 'insights:view:all',

    // ---- Applications -----------------------------------------------
    APP_CREATE: 'app:create',
    APP_EDIT: 'app:edit',
    APP_DELETE: 'app:delete',
    APP_COMMENT: 'app:comment',
    APP_RELEASE_CREATE: 'app:release:create',
    APP_RELEASE_EDIT: 'app:release:edit',
    APP_RELEASE_DELETE: 'app:release:delete',
    APP_PHASE_DECLARE: 'app:phase:declare',
    APP_CHECKPOINT_ADD: 'app:checkpoint:add',
    APP_CHECKPOINT_DELETE: 'app:checkpoint:delete',

    // ---- Sprints / iterations ---------------------------------------
    SPRINT_CREATE: 'sprint:create',
    SPRINT_EDIT: 'sprint:edit',
    SPRINT_DELETE: 'sprint:delete',
    SPRINT_START: 'sprint:start',
    SPRINT_CLOSE: 'sprint:close',
    SPRINT_ASSIGN_TASK: 'sprint:assign-task',

    // ---- Change requests --------------------------------------------
    CR_CREATE: 'cr:create',
    CR_EDIT: 'cr:edit',
    CR_DELETE: 'cr:delete',

    // ---- Ticketing ---------------------------------------------------
    TICKET_CREATE: 'ticket:create',
    TICKET_MANAGE: 'ticket:manage',
    TICKET_VIEW_ALL: 'ticket:view:all',
};

// UI groupings shown as collapsible cards on the User edit dialog.
// `risk` colours the row so admins can spot the dangerous toggles at a
// glance (delete, declare phase, etc.).
export const CAPABILITY_GROUPS = [
    {
        id: 'projects',
        label: 'Projects',
        description:
            'Who can create, edit, close and delete shared projects across the workspace.',
        items: [
            {
                key: CAPABILITIES.PROJECT_CREATE,
                label: 'Create projects',
                hint: 'Create new shared projects (personal projects are always allowed).',
            },
            {
                key: CAPABILITIES.PROJECT_EDIT_ANY,
                label: 'Edit any project',
                hint: 'Edit any field on any shared project, like an admin.',
                risk: 'sensitive',
            },
            {
                key: CAPABILITIES.PROJECT_CLOSE,
                label: 'Close / reopen projects',
                hint: 'Mark a project as complete or reopen a closed one.',
            },
            {
                key: CAPABILITIES.PROJECT_DELETE,
                label: 'Delete projects',
                hint: 'Permanently delete a project and all its content.',
                risk: 'danger',
            },
            {
                key: CAPABILITIES.PROJECT_BILLING_MANAGE,
                label: 'Manage billing details',
                hint: 'Edit internal/client prices, paid status and billing notes.',
                risk: 'sensitive',
            },
            {
                key: CAPABILITIES.PROJECT_PARTICIPANTS_MANAGE,
                label: 'Manage participants',
                hint: 'Add or remove participants on any project.',
            },
        ],
    },
    {
        id: 'tasks',
        label: 'Tasks & subtasks',
        description:
            'Default for managers — granting these to a regular user gives them the same powers inside the projects they can see.',
        items: [
            {
                key: CAPABILITIES.TASK_CREATE_ANY,
                label: 'Create tasks & subtasks',
                hint: 'Add tasks or subtasks in any project they can see.',
            },
            {
                key: CAPABILITIES.TASK_EDIT_ANY,
                label: 'Edit any task / subtask',
                hint: 'Modify status, assignee, dates, description, etc.',
            },
            {
                key: CAPABILITIES.TASK_DELETE_ANY,
                label: 'Delete tasks & subtasks',
                hint: 'Permanently remove tasks or subtasks.',
                risk: 'danger',
            },
            {
                key: CAPABILITIES.TASK_REASSIGN_APPROVE,
                label: 'Approve reassignment requests',
                hint: 'Decide on proposals to reassign a task to someone else.',
                risk: 'sensitive',
            },
            {
                key: CAPABILITIES.TASK_APPROVE,
                label: 'Approve tasks',
                hint: "Approve 'specific' tasks so they can leave To-do.",
                risk: 'sensitive',
            },
            {
                key: CAPABILITIES.TASK_SPECIFIC_CREATE,
                label: 'Create specific (approval) tasks',
                hint: "Raise 'specific' tasks that need approval before work can start.",
            },
        ],
    },
    {
        id: 'users',
        label: 'User accounts',
        description:
            'Delegate parts of admin work without granting full admin access.',
        items: [
            {
                key: CAPABILITIES.USER_CREATE,
                label: 'Create users',
                hint: 'Invite or create new user accounts.',
                risk: 'sensitive',
            },
            {
                key: CAPABILITIES.USER_EDIT_ANY,
                label: 'Edit / suspend / reset other users',
                hint: 'Edit any user, suspend accounts, generate reset links.',
                risk: 'sensitive',
            },
            {
                key: CAPABILITIES.USER_APPROVE,
                label: 'Approve pending registrations',
                hint: 'Approve newly registered users so they can sign in.',
            },
            {
                key: CAPABILITIES.USER_ROLE_MANAGE,
                label: 'Change user roles',
                hint: 'Promote / demote users between User, Manager, App moderator. Cannot grant capability overrides — that stays admin-only.',
                risk: 'danger',
            },
        ],
    },
    {
        id: 'teams',
        label: 'Teams',
        description: 'Create teams and assign them to projects / phases.',
        items: [
            {
                key: CAPABILITIES.TEAM_MANAGE,
                label: 'Manage teams',
                hint: 'Create, rename, delete teams and add or remove members.',
            },
        ],
    },
    {
        id: 'templates',
        label: 'Templates',
        description:
            'Admin-only catalogs (phases, priorities, countries, clients, project types, OS / POS terminals).',
        items: [
            {
                key: CAPABILITIES.TEMPLATE_MANAGE,
                label: 'Manage all templates',
                hint: 'Add, edit, reorder or remove entries in any admin template list.',
                risk: 'sensitive',
            },
        ],
    },
    {
        id: 'time',
        label: 'Time tracking',
        description: 'Cross-user views and exports of time entries.',
        items: [
            {
                key: CAPABILITIES.TIME_VIEW_ALL,
                label: 'View all users\u2019 time entries',
                hint: 'See the admin spreadsheet and charts across every user.',
            },
            {
                key: CAPABILITIES.TIME_EXPORT,
                label: 'Export time spreadsheet',
                hint: 'Download the full time-entries XLSX without project-scope restrictions.',
            },
        ],
    },
    {
        id: 'insights',
        label: 'Insights',
        description: 'Cross-workspace analytics dashboard.',
        items: [
            {
                key: CAPABILITIES.INSIGHTS_VIEW_ALL,
                label: 'View workspace-wide insights',
                hint: 'See the workspace dashboard and switch between any user\u2019s view.',
            },
        ],
    },
    {
        id: 'apps',
        label: 'Applications',
        description:
            'Who can change the application catalog and its releases.',
        items: [
            {
                key: CAPABILITIES.APP_CREATE,
                label: 'Create applications',
                hint: 'Add a brand-new application to the catalog.',
            },
            {
                key: CAPABILITIES.APP_EDIT,
                label: 'Edit applications',
                hint: 'Update name, description, dependencies, important notes, logo.',
            },
            {
                key: CAPABILITIES.APP_DELETE,
                label: 'Delete applications',
                hint: 'Permanently remove an application and all its releases.',
                risk: 'danger',
            },
            {
                key: CAPABILITIES.APP_COMMENT,
                label: 'Post release comments',
                hint: 'Add notes/comments under any release on this app.',
            },
        ],
    },
    {
        id: 'releases',
        label: 'Releases',
        description: 'Who can manage individual releases of an app.',
        items: [
            {
                key: CAPABILITIES.APP_RELEASE_CREATE,
                label: 'Add releases',
                hint: 'Register a new release for an existing application.',
            },
            {
                key: CAPABILITIES.APP_RELEASE_EDIT,
                label: 'Edit releases',
                hint: 'Update version, fixes, notes, target OS / POS terminal, files.',
            },
            {
                key: CAPABILITIES.APP_RELEASE_DELETE,
                label: 'Delete releases',
                hint: 'Permanently remove a release and its files.',
                risk: 'danger',
            },
            {
                key: CAPABILITIES.APP_PHASE_DECLARE,
                label: 'Declare release phase (Test / Pilot / Approved)',
                hint: 'Move a release between Test, Pilot and Approved (production-ready).',
                risk: 'sensitive',
            },
        ],
    },
    {
        id: 'timeline',
        label: 'Deployment timeline',
        description:
            'Operator-authored checkpoints recorded against a release (e.g. "deployed to prod cluster A at 02:13").',
        items: [
            {
                key: CAPABILITIES.APP_CHECKPOINT_ADD,
                label: 'Add timeline checkpoints',
                hint: 'Log when a release was deployed / rolled back on the prod network.',
            },
            {
                key: CAPABILITIES.APP_CHECKPOINT_DELETE,
                label: 'Delete any checkpoint',
                hint: 'Without this, users can only delete checkpoints they themselves added.',
                risk: 'sensitive',
            },
        ],
    },
    {
        id: 'sprints',
        label: 'Sprints & iterations',
        description:
            'Plan, run and close time-boxed sprints inside a project. Independent layer on top of tasks.',
        items: [
            {
                key: CAPABILITIES.SPRINT_CREATE,
                label: 'Create sprints',
                hint: 'Add a new planned sprint with start / end dates and a goal.',
            },
            {
                key: CAPABILITIES.SPRINT_EDIT,
                label: 'Edit sprints',
                hint: 'Rename, change dates / goal, set per-user capacity.',
            },
            {
                key: CAPABILITIES.SPRINT_DELETE,
                label: 'Delete planned sprints',
                hint: 'Only PLANNED sprints can be deleted — active sprints must be closed first.',
                risk: 'sensitive',
            },
            {
                key: CAPABILITIES.SPRINT_START,
                label: 'Start / reopen sprints',
                hint: 'Flip a planned sprint to active; reopen a closed one (one active per project).',
                risk: 'sensitive',
            },
            {
                key: CAPABILITIES.SPRINT_CLOSE,
                label: 'Close sprints',
                hint: 'End an active sprint and choose where to send any incomplete tasks.',
                risk: 'sensitive',
            },
            {
                key: CAPABILITIES.SPRINT_ASSIGN_TASK,
                label: 'Move tasks in / out of sprints',
                hint: 'Lighter than full edit — lets ICs pull their own work into the active sprint.',
            },
        ],
    },
    {
        id: 'change-requests',
        label: 'Change requests',
        description:
            'Chargeable additive scope attached to a project. CRs roll into the project\u2019s total contracted value.',
        items: [
            {
                key: CAPABILITIES.CR_CREATE,
                label: 'Create change requests',
                hint: 'Add a new CR under any project the user can read. Defaults to managers + admins.',
            },
            {
                key: CAPABILITIES.CR_EDIT,
                label: 'Edit change requests',
                hint: 'Change title, description, status and money amounts.',
            },
            {
                key: CAPABILITIES.CR_DELETE,
                label: 'Delete change requests',
                hint: 'Removes the CR and drops its value from the project\u2019s contracted total. Admin-only by default.',
                risk: 'sensitive',
            },
        ],
    },
    {
        id: 'ticketing',
        label: 'Ticketing',
        description:
            'Who can open tickets and who acts as a support agent (answer, assign, change status).',
        items: [
            {
                key: CAPABILITIES.TICKET_CREATE,
                label: 'Open tickets',
                hint: 'Create tickets against a project. Granted to the Requester role by default.',
            },
            {
                key: CAPABILITIES.TICKET_MANAGE,
                label: 'Answer & manage tickets (agent)',
                hint: 'Reply, post internal notes, assign, and change status/priority on tickets in scope.',
                risk: 'sensitive',
            },
            {
                key: CAPABILITIES.TICKET_VIEW_ALL,
                label: 'View all tickets',
                hint: 'See the whole ticket queue across every project, not just accessible ones.',
                risk: 'sensitive',
            },
        ],
    },
];

export const ROLE_LABELS = {
    ADMIN: 'Admin',
    MANAGER: 'Manager',
    APP_MODERATOR: 'App moderator',
    USER: 'User',
    REQUESTER: 'Requester',
};

// Mirror of ROLE_DEFAULT_CAPABILITIES on the backend. Kept here so the
// UI can render "comes from your role" hints next to checkboxes the
// admin doesn't need to explicitly toggle.
export const ROLE_DEFAULT_CAPABILITIES = {
    ADMIN: Object.values(CAPABILITIES),
    MANAGER: [
        CAPABILITIES.TASK_CREATE_ANY,
        CAPABILITIES.TASK_EDIT_ANY,
        CAPABILITIES.TASK_DELETE_ANY,
        CAPABILITIES.TASK_REASSIGN_APPROVE,
        CAPABILITIES.TASK_APPROVE,
        CAPABILITIES.TASK_SPECIFIC_CREATE,
        CAPABILITIES.TEAM_MANAGE,
        CAPABILITIES.APP_CREATE,
        CAPABILITIES.APP_EDIT,
        CAPABILITIES.APP_COMMENT,
        CAPABILITIES.APP_RELEASE_CREATE,
        CAPABILITIES.APP_RELEASE_EDIT,
        CAPABILITIES.APP_PHASE_DECLARE,
        CAPABILITIES.APP_CHECKPOINT_ADD,
        CAPABILITIES.SPRINT_CREATE,
        CAPABILITIES.SPRINT_EDIT,
        CAPABILITIES.SPRINT_DELETE,
        CAPABILITIES.SPRINT_START,
        CAPABILITIES.SPRINT_CLOSE,
        CAPABILITIES.SPRINT_ASSIGN_TASK,
        CAPABILITIES.CR_CREATE,
        CAPABILITIES.CR_EDIT,
        CAPABILITIES.TICKET_CREATE,
        CAPABILITIES.TICKET_MANAGE,
    ],
    APP_MODERATOR: [
        CAPABILITIES.APP_CREATE,
        CAPABILITIES.APP_EDIT,
        CAPABILITIES.APP_COMMENT,
        CAPABILITIES.APP_RELEASE_CREATE,
        CAPABILITIES.APP_RELEASE_EDIT,
        CAPABILITIES.APP_PHASE_DECLARE,
        CAPABILITIES.APP_CHECKPOINT_ADD,
        CAPABILITIES.TICKET_CREATE,
        CAPABILITIES.TICKET_MANAGE,
    ],
    USER: [CAPABILITIES.TICKET_CREATE, CAPABILITIES.TICKET_MANAGE],
    REQUESTER: [CAPABILITIES.TICKET_CREATE],
};

export function roleDefaults(role) {
    return ROLE_DEFAULT_CAPABILITIES[role] || [];
}

// Effective capability = role-default ∪ explicit overrides. Admins
// always have everything.
export function hasCapability(user, capability) {
    if (!user) return false;
    if (user.role === 'ADMIN') return true;
    if (Array.isArray(user.effectiveCapabilities)) {
        return user.effectiveCapabilities.includes(capability);
    }
    if (roleDefaults(user.role).includes(capability)) return true;
    return Array.isArray(user.capabilities)
        ? user.capabilities.includes(capability)
        : false;
}
