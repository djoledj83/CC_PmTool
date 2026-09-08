// Centralised authorisation helpers. The app's permission model has
// two layers:
//
// 1. ROLES — broad buckets a user belongs to.
//   ADMIN          -> full access to everything.
//   MANAGER        -> USER visibility + full task/subtask CRUD inside
//                     any project they can see. Cannot touch the
//                     project record itself or admin-only features.
//   APP_MODERATOR  -> USER visibility on projects, plus the
//                     application-catalogue powers (create / edit
//                     applications, post release notes/comments,
//                     declare release phases). Cannot touch projects
//                     or admin-only features.
//   USER           -> can ONLY see / interact with projects they
//                     participate in. Can add notes, upload files,
//                     send chat messages, toggle status on their
//                     assigned tasks. Anything else lives behind a
//                     per-user capability flag.
//
// 2. CAPABILITIES — granular per-user permission flags admins can hand
//    out on top of the role's defaults. The effective permission set
//    for a user is `roleDefaults(role) UNION user.capabilities`. This
//    is how a regular USER can be granted "may add timeline checkpoint"
//    without becoming an admin or manager.
//
// Every route file should funnel its access decisions through these
// helpers so the rules stay consistent.

const prisma = require('./prisma');
const { httpError } = require('../middleware/error');
const { isProjectParticipant } = require('./notify');

// ---------------------------------------------------------------------------
// Capability catalog
// ---------------------------------------------------------------------------
// Canonical list of capability keys the rest of the app references.
// Adding a key here is the only place to register a new fine-grained
// permission. The frontend imports `CAPABILITY_GROUPS` (mirrored in
// frontend/src/lib/capabilities.js) to render the admin checkboxes.
const CAPABILITIES = {
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
    // Approve "specific" tasks (unlocks them from TODO). Admins + Managers
    // get it by default; can also be granted to individuals.
    TASK_APPROVE: 'task:approve',
    // Raise "specific" (approval-required) tasks. Admins + Managers get it
    // by default; a regular user must be granted it to mark a task as
    // specific. Without it the "Specific (needs approval)" toggle is
    // hidden and the API rejects specific:true.
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

    // ---- Applications (existing) -------------------------------------
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

    // ---- Sprints / iterations ----------------------------------------
    // CREATE / EDIT / DELETE control the sprint record itself.
    // START / CLOSE gate the lifecycle transitions (can be handed out
    // separately to e.g. a Scrum Master who plans but isn't allowed to
    // configure the project). ASSIGN_TASK lets a user move tasks into
    // or out of a sprint without having full task-edit rights — that's
    // common for ICs who can pull their own work into the active sprint.
    SPRINT_CREATE: 'sprint:create',
    SPRINT_EDIT: 'sprint:edit',
    SPRINT_DELETE: 'sprint:delete',
    SPRINT_START: 'sprint:start',
    SPRINT_CLOSE: 'sprint:close',
    SPRINT_ASSIGN_TASK: 'sprint:assign-task',

    // ---- Change requests ---------------------------------------------
    // CRs are chargeable additive scope on a project. By policy:
    //   - CREATE: managers + admins (default). Regular users never.
    //   - EDIT:   same — covers title, description, status, money.
    //   - DELETE: admin-only by default; managers can be granted via
    //             the per-user override checkboxes if a team wants
    //             that policy. There's no soft-delete today: deleting
    //             removes the CR from the project's contracted total
    //             rollup.
    CR_CREATE: 'cr:create',
    CR_EDIT: 'cr:edit',
    CR_DELETE: 'cr:delete',

    // ── Ticketing ──────────────────────────────────────────────────
    // TICKET_CREATE: open a ticket (the REQUESTER role gets this by
    //   default; can also be granted to staff).
    // TICKET_MANAGE: act as an agent — reply, post internal notes,
    //   assign, change status/priority on any ticket in scope.
    // TICKET_VIEW_ALL: see the full ticket queue across projects
    //   (without it, a holder of TICKET_MANAGE still only sees tickets
    //   for projects they can access). Reporters always see their own.
    TICKET_CREATE: 'ticket:create',
    TICKET_MANAGE: 'ticket:manage',
    TICKET_VIEW_ALL: 'ticket:view:all',
};

// Default capability sets per role. ADMIN doesn't appear because we
// short-circuit it inside `hasCapability` — admins always pass.
const ROLE_DEFAULT_CAPABILITIES = {
    MANAGER: [
        // Project-wise: managers don't own projects, but they can run
        // task work inside the ones they can see + handle team/team
        // assignments.
        CAPABILITIES.TASK_CREATE_ANY,
        CAPABILITIES.TASK_EDIT_ANY,
        CAPABILITIES.TASK_DELETE_ANY,
        CAPABILITIES.TASK_REASSIGN_APPROVE,
        CAPABILITIES.TASK_APPROVE,
        CAPABILITIES.TASK_SPECIFIC_CREATE,
        CAPABILITIES.TEAM_MANAGE,
        // Applications: managers can also operate the app catalog by
        // default, matching the prior implicit behaviour.
        CAPABILITIES.APP_CREATE,
        CAPABILITIES.APP_EDIT,
        CAPABILITIES.APP_COMMENT,
        CAPABILITIES.APP_RELEASE_CREATE,
        CAPABILITIES.APP_RELEASE_EDIT,
        CAPABILITIES.APP_PHASE_DECLARE,
        CAPABILITIES.APP_CHECKPOINT_ADD,
        // Sprints: managers run iteration ceremonies (planning,
        // starting, closing) and pull tasks in/out of the active
        // sprint. Same parity model as tasks above.
        CAPABILITIES.SPRINT_CREATE,
        CAPABILITIES.SPRINT_EDIT,
        CAPABILITIES.SPRINT_DELETE,
        CAPABILITIES.SPRINT_START,
        CAPABILITIES.SPRINT_CLOSE,
        CAPABILITIES.SPRINT_ASSIGN_TASK,
        // Change requests: managers get create + edit out of the box.
        // Delete is admin-only by default — admins can grant cr:delete
        // per user from the User edit dialog if desired.
        CAPABILITIES.CR_CREATE,
        CAPABILITIES.CR_EDIT,
        // Ticketing: managers are agents — they see the open (unassigned)
        // queue plus tickets assigned to or shared with them. Only admins
        // see every ticket (TICKET_VIEW_ALL), so it's not granted here.
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
        // Non-requester roles are agents: open queue + their own tickets.
        CAPABILITIES.TICKET_CREATE,
        CAPABILITIES.TICKET_MANAGE,
    ],
    // Regular users are agents too — they see the open queue and the
    // tickets they take / are invited to (not every ticket).
    USER: [CAPABILITIES.TICKET_CREATE, CAPABILITIES.TICKET_MANAGE],
    // Ticketing-only role: can open tickets and see/comment on its own.
    // No PM Tool capabilities — agents are existing staff granted
    // `ticket:manage` instead.
    REQUESTER: [CAPABILITIES.TICKET_CREATE],
};

function isAdmin(req) {
    return req.user?.role === 'ADMIN';
}

function isManager(req) {
    return req.user?.role === 'MANAGER';
}

function isAppModerator(req) {
    return req.user?.role === 'APP_MODERATOR';
}

// Ticketing-only role. Used to lock the REQUESTER out of every PM Tool
// surface (the frontend hides them; backend route guards reject them).
function isRequester(req) {
    return req.user?.role === 'REQUESTER';
}

// True for both ADMIN and MANAGER. Use this for actions where managers
// should have parity with admins (task / subtask CRUD inside a project).
// Callers that also need a project-visibility check should pair this
// with `assertProjectRead`.
function isAdminOrManager(req) {
    return isAdmin(req) || isManager(req);
}

function requireAdminRole(req) {
    if (!isAdmin(req)) {
        throw httpError(403, 'Administrator permission required');
    }
}

function requireAdminOrManagerRole(req) {
    if (!isAdminOrManager(req)) {
        throw httpError(
            403,
            'Administrator or manager permission required',
        );
    }
}

// True if the caller has the named capability via either their role's
// default set or an explicit per-user override. Admins always pass.
function hasCapability(req, capability) {
    if (!req?.user) return false;
    if (isAdmin(req)) return true;
    const fromRole =
        ROLE_DEFAULT_CAPABILITIES[req.user.role] || [];
    if (fromRole.includes(capability)) return true;
    const overrides = Array.isArray(req.user.capabilities)
        ? req.user.capabilities
        : [];
    return overrides.includes(capability);
}

// Throws 403 if the caller is missing the named capability.
function requireCapability(req, capability) {
    if (!hasCapability(req, capability)) {
        throw httpError(
            403,
            'You do not have permission to perform this action',
        );
    }
}

// Express middleware factory: admin always passes, otherwise the
// caller must hold the named capability. Designed to replace the
// hard `requireAdmin` middleware where we want the same gate to be
// overridable per user.
function requireAdminOrCapabilityMiddleware(capability) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Unauthenticated' });
        }
        if (isAdmin(req) || hasCapability(req, capability)) {
            return next();
        }
        return res
            .status(403)
            .json({ error: 'You do not have permission to perform this action' });
    };
}

// Convenience: pass if either the legacy role gate matches OR the
// caller has been granted the equivalent capability. Lets us upgrade a
// route from "manager-only" to "manager-or-anyone-with-the-flag"
// without rewriting the gate at every call site.
function isAdminOrHasCapability(req, capability) {
    if (isAdmin(req)) return true;
    return hasCapability(req, capability);
}

function isAdminOrManagerOrHasCapability(req, capability) {
    if (isAdminOrManager(req)) return true;
    return hasCapability(req, capability);
}

// Returns the union of role defaults and per-user overrides — used by
// the frontend to know which buttons to show.
function effectiveCapabilities(user) {
    if (!user) return [];
    if (user.role === 'ADMIN') return Object.values(CAPABILITIES);
    const fromRole = ROLE_DEFAULT_CAPABILITIES[user.role] || [];
    const overrides = Array.isArray(user.capabilities)
        ? user.capabilities
        : [];
    return Array.from(new Set([...fromRole, ...overrides]));
}

// Loads a project and verifies the caller is allowed to read it.
//   - Personal projects: the owner always reads. Anyone the owner has
//     invited (a participant) also reads. Admins do NOT get a free pass
//     — personal means personal, even from an admin's perspective.
//   - Shared projects: admins read anything, regular users must be
//     a participant or the owner.
// Throws 404 if the project doesn't exist or is forbidden (we use 404
// for personal projects of others to avoid leaking existence).
async function loadProjectForRead(req, projectId) {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
    });
    if (!project) throw httpError(404, 'Project not found');
    if (project.isPersonal) {
        if (project.ownerId === req.user.id) return project;
        const ok = await isProjectParticipant(projectId, req.user.id);
        if (!ok) throw httpError(404, 'Project not found');
        return project;
    }
    if (isAdmin(req)) return project;
    const ok =
        project.ownerId === req.user.id ||
        (await isProjectParticipant(projectId, req.user.id));
    if (!ok) throw httpError(403, 'You do not have access to this project');
    return project;
}

// Same as `loadProjectForRead` but for routes that don't need the project
// row, just the access guard. Cheaper when the caller already has the
// project.
async function assertProjectRead(req, projectId) {
    const exists = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, ownerId: true, isPersonal: true },
    });
    if (!exists) throw httpError(404, 'Project not found');
    if (exists.isPersonal) {
        if (exists.ownerId === req.user.id) return;
        const ok = await isProjectParticipant(projectId, req.user.id);
        if (!ok) throw httpError(404, 'Project not found');
        return;
    }
    if (isAdmin(req)) return;
    if (exists.ownerId === req.user.id) return;
    const ok = await isProjectParticipant(projectId, req.user.id);
    if (!ok) throw httpError(403, 'You do not have access to this project');
}

// Guard for any write that targets a project (create task, log time,
// add note, upload file, schedule activity, …). Wraps `assertProjectRead`
// so the read-access check is never skipped, then additionally refuses
// the request if the project is CLOSED / DONE and the caller is a plain
// user. Admins and managers can keep editing a closed project (they
// often need to fix up records after the fact), and so can the owner of
// a personal project (it's their own organiser — they get to keep
// working on it). For shared projects, everyone else hits a 403 with
// a copy that explains how to fix it.
//
// `kind` is just a label for the error message ("add a task" vs.
// "log time") — purely cosmetic, callers don't have to pass it.
async function assertProjectWritable(req, projectId, kind = 'modify') {
    await assertProjectRead(req, projectId);
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
            id: true,
            status: true,
            isPersonal: true,
            ownerId: true,
            name: true,
        },
    });
    if (!project) throw httpError(404, 'Project not found');
    // Status "DONE" is the canonical "this project is closed" state
    // (a `closedAt` timestamp is stamped alongside it in the project
    // PATCH handler). All other statuses — including ON_HOLD — stay
    // editable; closing is a deliberate manager / admin action.
    if (project.status !== 'DONE') return;
    if (isAdmin(req) || isManager(req)) return;
    // Personal projects belong solely to their owner; we don't lock
    // them out of their own organiser even after they mark it DONE.
    if (project.isPersonal && project.ownerId === req.user.id) return;
    throw httpError(
        403,
        `This project is closed. Ask an admin or manager to reopen it before you can ${kind}.`,
    );
}

// Returns the list of project IDs the caller is allowed to see. Always
// returns an array (never null) so callers can unconditionally scope
// queries with `where: { projectId: { in: ids } }`.
//
// Visibility rules:
//   - Personal projects: only the owner ever sees them (admins included).
//   - Shared projects: admins see all, regular users see owned + ones
//     they participate in.
async function accessibleProjectIds(req) {
    if (isAdmin(req)) {
        // Admin: all shared projects, plus personal projects they
        // either own or have been invited to as a participant. A
        // personal project the admin isn't part of stays invisible.
        const rows = await prisma.project.findMany({
            where: {
                OR: [
                    { isPersonal: false },
                    { ownerId: req.user.id },
                    {
                        isPersonal: true,
                        participants: { some: { userId: req.user.id } },
                    },
                ],
            },
            select: { id: true },
        });
        return rows.map((r) => r.id);
    }
    return projectIdsForUser(req.user.id);
}

// Same shape as accessibleProjectIds but for an arbitrary user id,
// ignoring admin status. Used by admin-only endpoints that need to
// compute a specific user's view (e.g. "show me this user's insights").
// Personal projects owned by `userId` are included; personal projects
// owned by anyone else are NOT (a user only ever sees their own).
async function projectIdsForUser(userId) {
    const [participant, owned] = await Promise.all([
        // Participants only exist for shared projects, so this naturally
        // excludes personal projects owned by others.
        prisma.projectParticipant.findMany({
            where: { userId },
            select: { projectId: true },
        }),
        prisma.project.findMany({
            where: { ownerId: userId },
            select: { id: true },
        }),
    ]);
    const set = new Set(owned.map((p) => p.id));
    for (const p of participant) set.add(p.projectId);
    return Array.from(set);
}

module.exports = {
    CAPABILITIES,
    ROLE_DEFAULT_CAPABILITIES,
    isAdmin,
    isManager,
    isAppModerator,
    isRequester,
    isAdminOrManager,
    requireAdminRole,
    requireAdminOrManagerRole,
    hasCapability,
    requireCapability,
    requireAdminOrCapabilityMiddleware,
    isAdminOrHasCapability,
    isAdminOrManagerOrHasCapability,
    effectiveCapabilities,
    loadProjectForRead,
    assertProjectRead,
    assertProjectWritable,
    accessibleProjectIds,
    projectIdsForUser,
};
