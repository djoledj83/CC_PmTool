const express = require('express');

const prisma = require('../lib/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { isAdmin, accessibleProjectIds } = require('../lib/permissions');
const { buildCsv, escapeCell } = require('../lib/csv');
const { safeFilename } = require('../lib/excel');

const router = express.Router();

router.use(requireAuth);

// Shared "since" parser for the live feed AND the CSV export so the
// two stay in lock-step. Returns a Date cut-off (or null for "all").
// Accepts:
//   - 'all'                              → null (no time filter)
//   - hour-grain ('1h', '3h', '12h')     → relative offset from now
//   - day-grain  ('1d', '7d', '10d',     → relative offset from now
//                 '15d', '30d', '90d')
//   - any ISO-8601 timestamp the FE      → exact Date cut-off
//     wants to specify directly
//     (e.g. for the "Today" preset the
//      FE sends user-local midnight as
//      an ISO string — see Activities.jsx)
// Anything unrecognised falls back to 7 days, same default as the
// FE's stored preference.
//
// Note: the 10d/15d/30d/90d tokens are NO LONGER offered as quick-
// pick presets in the FE dropdown (Custom range covers those windows),
// but the BE parser still accepts them so any bookmarked URL or
// in-flight share-link from before the change keeps working.
//
// We accept ISO strings so the caller can express timezone-sensitive
// windows (like "today, in MY timezone") without the backend needing
// to know about the user's TZ. The FE computes the timestamp client-
// side and the BE just trusts it.
function parseSinceParam(raw) {
    const v = String(raw || '').toLowerCase().trim();
    if (v === 'all') return null;
    const hours = { '1h': 1, '3h': 3, '12h': 12 };
    const days = {
        '1d': 1,
        '7d': 7,
        '10d': 10,
        '15d': 15,
        '30d': 30,
        '90d': 90,
    };
    const now = Date.now();
    if (hours[v]) return new Date(now - hours[v] * 60 * 60 * 1000);
    if (days[v]) return new Date(now - days[v] * 24 * 60 * 60 * 1000);
    // Fast-path: ISO strings start with a 4-digit year. We trust
    // anything that parses to a valid Date AND lies in a sane range
    // (not pre-1970, not >1 year in the future). The future clamp
    // is a safety net against accidentally sending tomorrow as a
    // cut-off (which would return an empty feed silently).
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        const ts = Date.parse(raw);
        const oneYearOut = now + 365 * 24 * 60 * 60 * 1000;
        if (Number.isFinite(ts) && ts > 0 && ts <= oneYearOut) {
            return new Date(ts);
        }
    }
    return new Date(now - 7 * 24 * 60 * 60 * 1000);
}

// Optional UPPER bound for the audit window. Only used by the "Custom
// range" FE preset which lets admins narrow the feed to e.g. "last
// Wednesday 14:00 → 18:00" for incident investigations. Unlike
// `parseSinceParam`, this only accepts ISO timestamps (no relative
// tokens) because the upper bound is always picked explicitly. Returns
// null when the param is absent / invalid so callers can do
// `dateFilter = { ...(since && { gte: since }), ...(until && { lte: until }) }`
// without branching.
function parseUntilParam(raw) {
    if (!raw) return null;
    if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
    const ts = Date.parse(raw);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    const oneYearOut = Date.now() + 365 * 24 * 60 * 60 * 1000;
    if (ts > oneYearOut) return null;
    return new Date(ts);
}

// Combines a `since` (lower bound) and `until` (upper bound) into the
// Prisma date filter object used across both routes. Returns
// `undefined` when neither bound is set so we can spread it into
// `where: {}` without polluting the query — Prisma treats a missing
// `createdAt` filter as "no time restriction" which matches the
// "All time" preset behaviour.
function buildDateFilter(since, until) {
    if (!since && !until) return undefined;
    const out = {};
    if (since) out.gte = since;
    if (until) out.lte = until;
    return out;
}

// Single source of truth for "what audit-event types actually exist in
// the DB". Mirrors the `ActivityEventType` enum in `schema.prisma` —
// when you add a new value there, add it here too.
//
// Why this matters: the export route previously hard-coded an array
// that included pseudo-types (PROJECT_CREATED / PROJECT_ARCHIVED /
// FILE_UPLOADED / USER_JOINED) which only exist in the LIVE feed
// (synthesised from the Project / File / User source tables) — they
// are NEVER written to ActivityEvent. Passing them into
// `prisma.activityEvent.findMany({ where: { type: { in: […] } } })`
// makes Prisma reject the whole query because they aren't members
// of the ActivityEventType enum, so the "All activities" CSV export
// silently 500'd and the frontend fell back to a generic toast.
//
// We use a manual list (not `Prisma.ActivityEventType`) because in
// Prisma 5 the enum runtime values live on `$Enums.X`, not on
// `Prisma.X`, and trying to access `Prisma.X` at module load throws
// `Object.values(undefined)` which crashes the backend on start.
const ACTIVITY_EVENT_TYPE_VALUES = [
    'TASK_CREATED',
    'TASK_UPDATED',
    'TASK_ASSIGNEE_CHANGED',
    'TASK_DUE_DATE_CHANGED',
    'TASK_DELETED',
    'TASK_RESTORED',
    'PROJECT_DELETED',
    'PROJECT_RESTORED',
    'TASK_STATUS_CHANGED',
    'TASK_PHASE_CHANGED',
    'TASK_APPROVED',
    'TASK_DISAPPROVED',
    'TASK_APPROVAL_REQUESTED',
    'TODO_STATUS_CHANGED',
    'NOTE_ADDED',
    'NOTE_UPDATED',
    'NOTE_DELETED',
    'PROJECT_ACTIVITY_CREATED',
    'PROJECT_ACTIVITY_COMPLETED',
    'PROJECT_ACTIVITY_REOPENED',
    'PROJECT_PHASE_CHANGED',
    'PROJECT_VIEWED',
    'PROJECT_STATUS_CHANGED',
    'PROJECT_OWNER_CHANGED',
    'PROJECT_DETAILS_UPDATED',
    'PROJECT_BILLING_CHANGED',
    'PROJECT_PAYMENT_CHANGED',
    'USER_REGISTERED',
    'USER_LOGIN',
    'USER_CREATED',
    'USER_DELETED',
    'USER_PROFILE_UPDATED',
    'USER_AVATAR_UPDATED',
    'USER_AVATAR_REMOVED',
    'USER_PASSWORD_CHANGED',
    'USER_ROLE_CHANGED',
    'USER_CAPABILITIES_CHANGED',
    'USER_APPROVED',
    'USER_SUSPENDED',
    'USER_REACTIVATED',
    'TASK_REASSIGN_PROPOSED',
    'TASK_REASSIGN_APPROVED',
    'TASK_REASSIGN_REJECTED',
    'TASK_REASSIGN_CANCELLED',
    'TEAM_CREATED',
    'TEAM_UPDATED',
    'TEAM_DELETED',
    'TEAM_MEMBER_ADDED',
    'TEAM_MEMBER_REMOVED',
    'PROJECT_TEAM_ADDED',
    'PROJECT_TEAM_REMOVED',
    'PHASE_TEAM_ADDED',
    'PHASE_TEAM_REMOVED',
    'PROJECT_CONTACT_ADDED',
    'PROJECT_CONTACT_UPDATED',
    'PROJECT_CONTACT_REMOVED',
    'TIME_ENTRY_TRACKED',
    'TIME_ENTRY_MANUAL_ADDED',
    'CR_CREATED',
    'CR_UPDATED',
    'CR_DELETED',
    'CR_STATUS_CHANGED',
    'APP_CREATED',
    'APP_UPDATED',
    'APP_DELETED',
    'APP_RELEASE_CREATED',
    'APP_RELEASE_UPDATED',
    'APP_RELEASE_DELETED',
    'APP_RELEASE_PHASE_DECLARED',
    'APP_CHECKPOINT_ADDED',
    'APP_CHECKPOINT_DELETED',
    'SPRINT_CREATED',
    'SPRINT_UPDATED',
    'SPRINT_STARTED',
    'SPRINT_CLOSED',
    'SPRINT_REOPENED',
    'SPRINT_DELETED',
    'SPRINT_BULK_DELETED',
    'TASK_ADDED_TO_SPRINT',
    'TASK_REMOVED_FROM_SPRINT',
    'SPRINT_SCHEDULE_UPDATED',
    'SPRINT_SCHEDULE_DISABLED',
    'SPRINT_SCHEDULE_AUTO_RUN',
    'TICKET_CREATED',
    'TICKET_STATUS_CHANGED',
    'TICKET_ASSIGNED',
    'TICKET_DELETED',
    'TICKET_RESTORED',
    'ANNOUNCEMENT_CREATED',
    'ANNOUNCEMENT_ACTIVATED',
    'ANNOUNCEMENT_DEACTIVATED',
    'ANNOUNCEMENT_DELETED',
    'ANNOUNCEMENT_ACKNOWLEDGED',
];

const ACTIVITY_TYPES = [
    'project_created',
    'project_archived',
    'project_viewed',
    'project_status_changed',
    'project_owner_changed',
    'project_details_updated',
    'project_billing_changed',
    'project_payment_changed',
    'task_created',
    'task_updated',
    'task_assignee_changed',
    'task_due_date_changed',
    'task_deleted',
    'task_restored',
    'project_deleted',
    'project_restored',
    'task_status_changed',
    'task_phase_changed',
    'task_approved',
    'task_disapproved',
    'task_approval_requested',
    'todo_status_changed',
    'project_activity_created',
    'project_activity_completed',
    'project_phase_changed',
    'note_added',
    'note_updated',
    'note_deleted',
    'file_uploaded',
    'user_joined',
    'user_approved',
    'task_reassign_proposed',
    'task_reassign_approved',
    'task_reassign_rejected',
    'team_created',
    'team_updated',
    'team_deleted',
    'team_member_added',
    'team_member_removed',
    'project_team_added',
    'project_team_removed',
    'phase_team_added',
    'phase_team_removed',
    'project_contact_added',
    'project_contact_updated',
    'project_contact_removed',
    // Time tracking — distinguishes live timers (TIME_ENTRY_TRACKED)
    // from after-the-fact manual entries (TIME_ENTRY_MANUAL_ADDED) so
    // reviewers can see *how* time was logged.
    'time_entry_tracked',
    'time_entry_manual_added',
    // Account / user audit events. Recorded by auth.js + users.js
    // and visible to admins only (mirrors `user_joined` /
    // `user_approved`).
    'user_registered',
    'user_login',
    'user_created',
    'user_deleted',
    'user_profile_updated',
    'user_avatar_updated',
    'user_password_changed',
    'user_role_changed',
    'user_capabilities_changed',
    'user_suspended',
    'user_reactivated',
    // Application catalogue events. They live workspace-wide (no
    // projectId) — the merge logic further down handles them via
    // `requestedAppEventTypes`.
    'app_created',
    'app_updated',
    'app_deleted',
    'app_release_created',
    'app_release_updated',
    'app_release_deleted',
    'app_release_phase_declared',
    'app_checkpoint_added',
    'app_checkpoint_deleted',
    // Sprints / iterations. Project-scoped (each event carries a
    // projectId), so they go through the standard per-project gate
    // alongside tasks and notes.
    'sprint_created',
    'sprint_updated',
    'sprint_started',
    'sprint_closed',
    'sprint_reopened',
    'sprint_deleted',
    'sprint_bulk_deleted',
    'task_added_to_sprint',
    'task_removed_from_sprint',
    'sprint_schedule_updated',
    'sprint_schedule_disabled',
    'sprint_schedule_auto_run',
    // Ticketing (help-desk) events. Project-scoped (each carries the
    // ticket's projectId), so they ride the standard per-project gate.
    'ticket_created',
    'ticket_status_changed',
    'ticket_assigned',
    'ticket_deleted',
    'ticket_restored',
    // Broadcast announcements (admin-only, workspace-wide / no projectId).
    'announcement_created',
    'announcement_activated',
    'announcement_deactivated',
    'announcement_deleted',
    'announcement_acknowledged',
];

const PROJECT_STATUS_LABELS = {
    TODO: 'To do',
    IN_PROGRESS: 'In progress',
    DONE: 'Done',
    ON_HOLD: 'On hold',
};

const TASK_STATUS_LABELS = {
    TODO: 'To do',
    IN_PROGRESS: 'In progress',
    DONE: 'Done',
};

const TICKET_STATUS_LABELS = {
    NEW: 'New',
    OPEN: 'Open',
    IN_PROGRESS: 'In progress',
    PENDING: 'Pending',
    RESOLVED: 'Resolved',
    CLOSED: 'Closed',
};

const ACTIVITY_KIND_LABELS = {
    CALL: 'call',
    MEETING: 'meeting',
    REMINDER: 'reminder',
    COMMENT: 'comment',
    DOCUMENT: 'document',
    OTHER: 'activity',
};

function userShape(u) {
    if (!u) return null;
    return {
        id: u.id,
        name: u.name,
        email: u.email,
        avatarUrl: u.avatarUrl || null,
    };
}

function projectShape(p) {
    if (!p) return null;
    // `isPersonal` + `ownerId` are surfaced so the FE can decide when
    // to show the "Restore" button on TASK_DELETED rows without needing
    // an extra round-trip per item. A personal-project owner is
    // ALWAYS allowed to restore their own tasks, even if their role
    // doesn't grant `task:delete:any`.
    return {
        id: p.id,
        name: p.name,
        isPersonal: Boolean(p.isPersonal),
        ownerId: p.ownerId || null,
    };
}

// Synthesises a unified activity feed from the source tables. We pull
// `take * 2` from each source then merge / sort / trim — the math is loose
// but cheap, and the FE supports filtering / pagination on top.
router.get('/', async (req, res, next) => {
    try {
        // Sentinel sent by the FE multi-select when the user has
        // unchecked every type — distinct from "omit the param" so
        // we return zero rows instead of the default "all types"
        // fallback. Without this, the empty-set UI would confusingly
        // render a fully populated feed.
        if (req.query.types === '__none__') {
            return res.json({ activities: [] });
        }
        const requestedTypes = (req.query.types || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => ACTIVITY_TYPES.includes(s));
        const types = requestedTypes.length ? requestedTypes : ACTIVITY_TYPES;

        // Accepts hour-grain (1h / 3h / 12h) and day-grain (1d / 7d)
        // plus 'today', 'all', or a raw ISO timestamp. See
        // `parseSinceParam` above for the canonical list. `until` is
        // optional — only the "Custom range" FE preset sends it, all
        // the relative presets implicitly end at "now".
        const since = parseSinceParam(req.query.since || '7d');
        const until = parseUntilParam(req.query.until);

        let projectId = req.query.projectId || null;
        const userId = req.query.userId || null;
        const changeRequestId = req.query.changeRequestId || null;
        // Bumped from 200 → 500. The merged feed pulls `take:limit`
        // rows from each source table (Project, Task, Note, File,
        // User, ActivityEvent) and then sorts the union by createdAt
        // and slices the top `limit`. With a busy workspace the
        // less-frequent events (`task_deleted`, `task_restored`,
        // `user_suspended`, …) can be pushed off the top of the
        // list when the cap is too low. 500 gives the FE enough
        // headroom to reliably surface every recent deletion in
        // the standard 30-day window.
        const limit = Math.min(Number(req.query.limit) || 100, 500);

        // Build the Prisma date filter once, then spread into every
        // source-table query and bucket where below. `since`
        // contributes `gte`, `until` contributes `lte`. When the user
        // picked "All time" (no since, no until) we leave the filter
        // undefined so the query doesn't restrict createdAt at all.
        const dateFilter = buildDateFilter(since, until);

        // Project-scope for the audit feed.
        //
        // Regular users see activity from projects they're involved in
        // (owner / participant). Admins get a wider view — they see
        // events from EVERY project including personal projects they
        // don't own / aren't a participant on, because the workspace
        // audit trail is the one place where "personal" privacy
        // doesn't apply. Without this, an admin can't see that
        // "User X created a task on their personal project P26-…"
        // even though the system has logged the event.
        //
        // `accessibleProjectIds()` is intentionally NOT changed — its
        // stricter semantics (admins also can't see private personal
        // projects they don't participate in) still drive Insights /
        // Search / Time tracking. The override here is scoped to this
        // route only.
        const isAdminUser = isAdmin(req);
        let scope = null;
        if (!isAdminUser) {
            scope = await accessibleProjectIds(req);
        }
        if (projectId && scope && !scope.includes(projectId)) {
            return res.json({ items: [] });
        }

        // M4: optional Change Request narrowing. When `?changeRequestId=`
        // is set the feed pivots to "everything that happened on this
        // CR". We:
        //   1) validate the CR exists + the caller has access to its
        //      parent project. We emit an empty-feed response (same
        //      shape as a no-match query) instead of 404 so a leaked
        //      id can't be used to enumerate CR existence.
        //   2) auto-anchor `projectId` to the CR's parent project so
        //      the standard per-project gate downstream stays
        //      consistent — without this, picking a CR while leaving
        //      "All projects" selected would pull events from
        //      unrelated projects too.
        //   3) pre-load every task id under the CR. ActivityEvent
        //      rows for task-level changes only carry `taskId`, not
        //      the task's CR membership, so we join via this set.
        //   4) suppress side queries that can't be CR-scoped (Project,
        //      File, User events). The audit feed in CR mode should
        //      show only CR-relevant activity.
        let crTaskIds = null;
        if (changeRequestId) {
            const cr = await prisma.changeRequest.findUnique({
                where: { id: changeRequestId },
                select: { id: true, projectId: true },
            });
            if (!cr) {
                return res.json({ items: [], debug: null });
            }
            if (scope && !scope.includes(cr.projectId)) {
                return res.json({ items: [], debug: null });
            }
            projectId = cr.projectId;
            const taskRows = await prisma.task.findMany({
                where: { changeRequestId },
                select: { id: true },
            });
            crTaskIds = taskRows.map((t) => t.id);
        }

        // For admin (`scope === null`): no project-id filter at all,
        // so personal-project rows pass through too.
        const projectIdFilter = projectId
            ? { id: projectId }
            : scope === null
              ? {}
              : { id: { in: scope } };
        const projectScopeForChild = projectId
            ? { projectId }
            : scope === null
              ? {}
              : { projectId: { in: scope } };

        const tasks = [];

        if (types.includes('project_created') && !changeRequestId) {
            tasks.push(
                prisma.project.findMany({
                    where: {
                        ...(dateFilter ? { createdAt: dateFilter } : {}),
                        ...projectIdFilter,
                        ...(userId ? { ownerId: userId } : {}),
                    },
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        name: true,
                        createdAt: true,
                        owner: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                avatarUrl: true,
                            },
                        },
                    },
                }),
            );
        } else {
            tasks.push(Promise.resolve([]));
        }

        if (types.includes('project_archived') && !changeRequestId) {
            tasks.push(
                prisma.project.findMany({
                    where: {
                        closedAt: { not: null, ...(dateFilter || {}) },
                        ...projectIdFilter,
                        ...(userId ? { ownerId: userId } : {}),
                    },
                    take: limit,
                    orderBy: { closedAt: 'desc' },
                    select: {
                        id: true,
                        name: true,
                        closedAt: true,
                        owner: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                avatarUrl: true,
                            },
                        },
                    },
                }),
            );
        } else {
            tasks.push(Promise.resolve([]));
        }

        if (types.includes('task_created')) {
            tasks.push(
                prisma.task.findMany({
                    where: {
                        ...(dateFilter ? { createdAt: dateFilter } : {}),
                        ...projectScopeForChild,
                        ...(changeRequestId ? { changeRequestId } : {}),
                        // `?userId=` filters the audit feed by ACTOR.
                        // For task_created the actor is the creator
                        // (not the assignee — they may never have
                        // touched the task). We fall back to assignee
                        // for legacy rows that pre-date `createdById`.
                        ...(userId
                            ? {
                                  OR: [
                                      { createdById: userId },
                                      // Backwards compat: tasks created
                                      // before the createdBy column
                                      // existed still attribute to the
                                      // assignee in the UI, so let
                                      // ?userId match those too.
                                      {
                                          createdById: null,
                                          assigneeId: userId,
                                      },
                                  ],
                              }
                            : {}),
                    },
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        title: true,
                        createdAt: true,
                        // Primary actor — the user who created the
                        // task. Added with the soft-delete migration.
                        // May be null on legacy tasks; we fall back to
                        // the assignee, then the project owner in the
                        // serializer below so the feed never shows
                        // "Someone" for a task we actually have
                        // attribution for.
                        createdBy: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                avatarUrl: true,
                            },
                        },
                        assignee: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                avatarUrl: true,
                            },
                        },
                        project: {
                            select: {
                                id: true,
                                name: true,
                                owner: {
                                    select: {
                                        id: true,
                                        name: true,
                                        email: true,
                                        avatarUrl: true,
                                    },
                                },
                            },
                        },
                    },
                }),
            );
        } else {
            tasks.push(Promise.resolve([]));
        }

        if (types.includes('note_added')) {
            // In CR mode the audit feed surfaces every note "about"
            // the CR — directly CR-pinned notes plus notes pinned to
            // any task that lives inside the CR. This matches the
            // CR Notes tab's reading semantics so the feed and the
            // tab can't disagree on what's "in scope".
            const crNoteFilter = changeRequestId
                ? {
                      OR: [
                          { changeRequestId },
                          ...(crTaskIds && crTaskIds.length
                              ? [{ taskId: { in: crTaskIds } }]
                              : []),
                      ],
                  }
                : {};
            tasks.push(
                prisma.note.findMany({
                    where: {
                        ...(dateFilter ? { createdAt: dateFilter } : {}),
                        ...projectScopeForChild,
                        ...(userId ? { authorId: userId } : {}),
                        ...crNoteFilter,
                    },
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        content: true,
                        createdAt: true,
                        project: { select: { id: true, name: true } },
                        author: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                avatarUrl: true,
                            },
                        },
                    },
                }),
            );
        } else {
            tasks.push(Promise.resolve([]));
        }

        if (types.includes('file_uploaded')) {
            // CR scope (M5): surface every file "about" the CR — direct
            // pin + files attached to CR-pinned notes + files attached
            // to notes pinned to CR-scoped tasks. Same shape as the
            // CR Files tab.
            const crFileFilter = changeRequestId
                ? {
                      OR: [
                          { changeRequestId },
                          { note: { is: { changeRequestId } } },
                          ...(crTaskIds && crTaskIds.length
                              ? [
                                    {
                                        note: {
                                            is: {
                                                taskId: { in: crTaskIds },
                                            },
                                        },
                                    },
                                ]
                              : []),
                      ],
                  }
                : {};
            tasks.push(
                prisma.fileAttachment.findMany({
                    where: {
                        ...(dateFilter ? { createdAt: dateFilter } : {}),
                        ...projectScopeForChild,
                        ...(userId ? { uploaderId: userId } : {}),
                        ...crFileFilter,
                    },
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        originalName: true,
                        createdAt: true,
                        project: { select: { id: true, name: true } },
                        uploader: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                avatarUrl: true,
                            },
                        },
                    },
                }),
            );
        } else {
            tasks.push(Promise.resolve([]));
        }

        // Workspace-wide user events are only meaningful (and visible) to
        // admins. Non-admins get an empty array even if they ask for them.
        if (types.includes('user_joined') && !projectId && isAdmin(req)) {
            tasks.push(
                prisma.user.findMany({
                    where: {
                        ...(dateFilter ? { createdAt: dateFilter } : {}),
                        ...(userId ? { id: userId } : {}),
                    },
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        avatarUrl: true,
                        createdAt: true,
                        status: true,
                    },
                }),
            );
        } else {
            tasks.push(Promise.resolve([]));
        }

        if (types.includes('user_approved') && !projectId && isAdmin(req)) {
            tasks.push(
                prisma.user.findMany({
                    where: {
                        approvedAt: { not: null, ...(dateFilter || {}) },
                        ...(userId ? { id: userId } : {}),
                    },
                    take: limit,
                    orderBy: { approvedAt: 'desc' },
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        avatarUrl: true,
                        approvedAt: true,
                    },
                }),
            );
        } else {
            tasks.push(Promise.resolve([]));
        }

        // Status-change & project-activity events come from the
        // ActivityEvent audit log. We filter by the requested event
        // types so the same query covers task / todo / activity slices.
        // NB: `task_created` / `note_added` deliberately do NOT appear
        // here — the feed pulls those from the source Task / Note tables
        // (a row exists for every legacy entry, ActivityEvent rows only
        // exist for new ones). The audit-log copies still get written so
        // the history survives task / note deletion, but they're not
        // surfaced through this map.
        const eventTypeMap = {
            task_updated: 'TASK_UPDATED',
            task_assignee_changed: 'TASK_ASSIGNEE_CHANGED',
            task_due_date_changed: 'TASK_DUE_DATE_CHANGED',
            task_deleted: 'TASK_DELETED',
            task_restored: 'TASK_RESTORED',
            project_deleted: 'PROJECT_DELETED',
            project_restored: 'PROJECT_RESTORED',
            task_status_changed: 'TASK_STATUS_CHANGED',
            task_phase_changed: 'TASK_PHASE_CHANGED',
            task_approved: 'TASK_APPROVED',
            task_disapproved: 'TASK_DISAPPROVED',
            task_approval_requested: 'TASK_APPROVAL_REQUESTED',
            todo_status_changed: 'TODO_STATUS_CHANGED',
            project_activity_created: 'PROJECT_ACTIVITY_CREATED',
            project_activity_completed: 'PROJECT_ACTIVITY_COMPLETED',
            project_phase_changed: 'PROJECT_PHASE_CHANGED',
            project_viewed: 'PROJECT_VIEWED',
            project_status_changed: 'PROJECT_STATUS_CHANGED',
            project_owner_changed: 'PROJECT_OWNER_CHANGED',
            project_details_updated: 'PROJECT_DETAILS_UPDATED',
            project_billing_changed: 'PROJECT_BILLING_CHANGED',
            project_payment_changed: 'PROJECT_PAYMENT_CHANGED',
            note_updated: 'NOTE_UPDATED',
            note_deleted: 'NOTE_DELETED',
            task_reassign_proposed: 'TASK_REASSIGN_PROPOSED',
            task_reassign_approved: 'TASK_REASSIGN_APPROVED',
            task_reassign_rejected: 'TASK_REASSIGN_REJECTED',
            team_created: 'TEAM_CREATED',
            team_updated: 'TEAM_UPDATED',
            team_deleted: 'TEAM_DELETED',
            team_member_added: 'TEAM_MEMBER_ADDED',
            team_member_removed: 'TEAM_MEMBER_REMOVED',
            project_team_added: 'PROJECT_TEAM_ADDED',
            project_team_removed: 'PROJECT_TEAM_REMOVED',
            phase_team_added: 'PHASE_TEAM_ADDED',
            phase_team_removed: 'PHASE_TEAM_REMOVED',
            project_contact_added: 'PROJECT_CONTACT_ADDED',
            project_contact_updated: 'PROJECT_CONTACT_UPDATED',
            project_contact_removed: 'PROJECT_CONTACT_REMOVED',
            time_entry_tracked: 'TIME_ENTRY_TRACKED',
            time_entry_manual_added: 'TIME_ENTRY_MANUAL_ADDED',
            // Sprints / iterations. These ARE project-scoped (every
            // sprint event carries projectId), so they go through the
            // standard per-project filter alongside tasks and notes.
            sprint_created: 'SPRINT_CREATED',
            sprint_updated: 'SPRINT_UPDATED',
            sprint_started: 'SPRINT_STARTED',
            sprint_closed: 'SPRINT_CLOSED',
            sprint_reopened: 'SPRINT_REOPENED',
            sprint_deleted: 'SPRINT_DELETED',
            sprint_bulk_deleted: 'SPRINT_BULK_DELETED',
            task_added_to_sprint: 'TASK_ADDED_TO_SPRINT',
            task_removed_from_sprint: 'TASK_REMOVED_FROM_SPRINT',
            sprint_schedule_updated: 'SPRINT_SCHEDULE_UPDATED',
            sprint_schedule_disabled: 'SPRINT_SCHEDULE_DISABLED',
            sprint_schedule_auto_run: 'SPRINT_SCHEDULE_AUTO_RUN',
            // Tickets are project-scoped (each event carries the
            // ticket's projectId) so they ride the per-project filter.
            ticket_created: 'TICKET_CREATED',
            ticket_status_changed: 'TICKET_STATUS_CHANGED',
            ticket_assigned: 'TICKET_ASSIGNED',
            ticket_deleted: 'TICKET_DELETED',
            ticket_restored: 'TICKET_RESTORED',
        };

        // Account / user events also live in ActivityEvent. They're
        // sensitive (logins, password changes, …) so we only surface
        // them to admins, matching how `user_joined` already behaves.
        const userEventTypeMap = {
            user_registered: 'USER_REGISTERED',
            user_login: 'USER_LOGIN',
            user_created: 'USER_CREATED',
            user_deleted: 'USER_DELETED',
            user_profile_updated: 'USER_PROFILE_UPDATED',
            user_avatar_updated: 'USER_AVATAR_UPDATED',
            user_password_changed: 'USER_PASSWORD_CHANGED',
            user_role_changed: 'USER_ROLE_CHANGED',
            user_capabilities_changed: 'USER_CAPABILITIES_CHANGED',
            user_suspended: 'USER_SUSPENDED',
            user_reactivated: 'USER_REACTIVATED',
        };
        // Broadcast announcement audit events. Workspace-wide (projectId
        // null) and admin-only, same visibility model as user events.
        const announcementEventTypeMap = {
            announcement_created: 'ANNOUNCEMENT_CREATED',
            announcement_activated: 'ANNOUNCEMENT_ACTIVATED',
            announcement_deactivated: 'ANNOUNCEMENT_DEACTIVATED',
            announcement_deleted: 'ANNOUNCEMENT_DELETED',
            announcement_acknowledged: 'ANNOUNCEMENT_ACKNOWLEDGED',
        };
        // Application catalogue events live outside the per-project
        // permission model (the catalogue is workspace-wide). They are
        // surfaced to everyone, not just admins.
        const appEventTypeMap = {
            app_created: 'APP_CREATED',
            app_updated: 'APP_UPDATED',
            app_deleted: 'APP_DELETED',
            app_release_created: 'APP_RELEASE_CREATED',
            app_release_updated: 'APP_RELEASE_UPDATED',
            app_release_deleted: 'APP_RELEASE_DELETED',
            app_release_phase_declared: 'APP_RELEASE_PHASE_DECLARED',
            app_checkpoint_added: 'APP_CHECKPOINT_ADDED',
            app_checkpoint_deleted: 'APP_CHECKPOINT_DELETED',
        };
        if (isAdmin(req)) {
            for (const [k, v] of Object.entries(userEventTypeMap)) {
                if (types.includes(k)) eventTypeMap[k] = v;
            }
            // Announcement audit events are workspace-wide (no projectId).
            // Fold into the map so they render, and into the app-event
            // bypass list so the null-project rows are surfaced.
            for (const [k, v] of Object.entries(announcementEventTypeMap)) {
                if (types.includes(k)) eventTypeMap[k] = v;
            }
        }
        // App events are NOT project-scoped — fold them into a
        // separate list that bypasses the per-project filter below.
        const requestedAppEventTypes = Object.entries(appEventTypeMap)
            .filter(([k]) => types.includes(k))
            .map(([, v]) => v);
        // Also include their typed-up rendering for the
        // requestedEventTypes loop so the rendering branch fires —
        // the actual query rows are merged in further down.
        for (const [k, v] of Object.entries(appEventTypeMap)) {
            if (types.includes(k)) eventTypeMap[k] = v;
        }
        const requestedEventTypes = Object.entries(eventTypeMap)
            .filter(([k]) => types.includes(k))
            .map(([, v]) => v);
        // PROJECT_ACTIVITY_REOPENED isn't a top-level filter token but
        // we still want to surface it under "completed" so the feed
        // shows reopen events too.
        if (types.includes('project_activity_completed')) {
            requestedEventTypes.push('PROJECT_ACTIVITY_REOPENED');
        }
        // Avatar removals share the "avatar updated" filter token —
        // no need to make the user juggle two filters.
        if (types.includes('user_avatar_updated') && isAdmin(req)) {
            requestedEventTypes.push('USER_AVATAR_REMOVED');
        }

        // Noisy event types — high-volume rows that dominate any
        // recent window when grouped together. We split them off into
        // their own query so they can't crowd out rare but important
        // events (TASK_DELETED, TASK_RESTORED, sprint events, etc.)
        // when the merged feed slices the top `limit`.
        const NOISY_EVENT_TYPES = new Set([
            'PROJECT_VIEWED',
            'TASK_STATUS_CHANGED',
        ]);

        if (requestedEventTypes.length > 0) {
            const noisyTypes = requestedEventTypes.filter((t) =>
                NOISY_EVENT_TYPES.has(t),
            );
            const importantTypes = requestedEventTypes.filter(
                (t) => !NOISY_EVENT_TYPES.has(t),
            );
            // Project scope. Non-admin callers are restricted to the
            // list returned by `accessibleProjectIds()`. Admins (when
            // `scope === null`) skip the project gate entirely so the
            // audit feed surfaces ActivityEvent rows from EVERY
            // project — including other users' personal projects.
            // Application events are workspace-wide
            // (`projectId IS NULL`) and bypass the per-project gate.
            const projectScopeWhere = projectId
                ? { projectId }
                : scope === null
                  ? {}
                  : { projectId: { in: scope } };

            const eventInclude = {
                actor: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        avatarUrl: true,
                    },
                },
                // `isPersonal` + `ownerId` are surfaced so the FE can
                // show the Restore button on TASK_DELETED rows to
                // personal-project owners regardless of role. See
                // `projectShape` for how the FE consumes these fields.
                project: {
                    select: {
                        id: true,
                        name: true,
                        isPersonal: true,
                        ownerId: true,
                    },
                },
                activity: {
                    select: {
                        id: true,
                        title: true,
                        kind: true,
                        scheduledAt: true,
                    },
                },
            };

            // Builds the where-clause for one bucket of types. Handles
            // the per-project gate, the workspace-wide app events
            // OR-branch, and the personal-todo OR-branch.
            //
            // CRITICAL Prisma gotcha: an empty object `{}` placed inside
            // an `OR: []` array is interpreted as FALSE by Prisma (NOT
            // as the intuitive "match everything" you'd expect from an
            // empty filter at top level). This was silently restricting
            // the admin query: when bucketAppTypes was non-empty and
            // `projectScopeWhere === {}` (admin = no project restriction),
            // the OR would collapse to just the second branch
            // `{ projectId: null, type: { in: APP_* } }`, which then
            // AND'd with the top-level `type IN typesInBucket` and the
            // dateFilter — so every TASK_DELETED row (which has a
            // non-null projectId) was filtered out by the OR even
            // though it perfectly matched the top-level criteria. The
            // exact symptom the user reported: "deleted tasks appear
            // when I uncheck Applications". Unticking Applications
            // emptied `bucketAppTypes`, the OR branch never got built,
            // and the deletes flowed through.
            //
            // The fix: only build the OR when the project branch has
            // ACTUAL content. For admins (no project restriction),
            // app events still come through naturally because they
            // already match the top-level `type IN typesInBucket`
            // criterion — no OR fence is needed.
            // In CR mode every audit row must "belong to" the CR.
            // ActivityEvent doesn't have its own changeRequestId
            // column — CR membership lives either in `meta` (notes /
            // CR-direct events) or implicitly via the `taskId` link
            // for task events. We OR the two together so any of:
            //   • CR-direct events       (meta.crId / meta.changeRequestId)
            //   • note events on the CR  (meta.changeRequestId)
            //   • task events on a CR task (taskId in crTaskIds)
            // come through. We DON'T put this on the top-level where
            // when the bucket also needs an OR for app events — the
            // two OR clauses would compose into an `AND OR OR` that
            // Prisma collapses unexpectedly. Instead we wrap the
            // final per-bucket clause in another AND below.
            const crEventScope = changeRequestId
                ? [
                      { meta: { path: ['changeRequestId'], equals: changeRequestId } },
                      { meta: { path: ['crId'], equals: changeRequestId } },
                      ...(crTaskIds && crTaskIds.length
                          ? [{ taskId: { in: crTaskIds } }]
                          : []),
                  ]
                : null;
            const buildBucketWhere = (typesInBucket) => {
                if (typesInBucket.length === 0) return null;
                const bucketAppTypes = typesInBucket.filter((t) =>
                    requestedAppEventTypes.includes(t),
                );
                const w = {
                    type: { in: typesInBucket },
                    ...(dateFilter ? { createdAt: dateFilter } : {}),
                    ...(userId ? { actorId: userId } : {}),
                };
                const projectBranchHasContent =
                    Object.keys(projectScopeWhere).length > 0;
                if (bucketAppTypes.length > 0 && projectBranchHasContent) {
                    // Non-admin caller: keep the OR fence so they
                    // see events from their projects AND workspace-
                    // wide app events that have no projectId.
                    w.OR = [
                        projectScopeWhere,
                        { projectId: null, type: { in: bucketAppTypes } },
                    ];
                } else if (projectBranchHasContent) {
                    // Non-admin caller without app events in this
                    // bucket — apply the project scope directly.
                    Object.assign(w, projectScopeWhere);
                }
                // Admin caller (projectScopeWhere === {}): leave `w`
                // alone. The top-level type+date filters do all the
                // work; app events come through because they're in
                // `typesInBucket`, and project events come through
                // because admins have no per-project restriction.
                // Personal todos have no projectId; only surface the
                // actor's own ones, never another user's. Lives in
                // the important bucket so we wrap accordingly.
                if (
                    typesInBucket.includes('TODO_STATUS_CHANGED') &&
                    types.includes('todo_status_changed')
                ) {
                    const withTodo = {
                        OR: [
                            w,
                            {
                                type: 'TODO_STATUS_CHANGED',
                                projectId: null,
                                actorId: req.user.id,
                                ...(dateFilter
                                    ? { createdAt: dateFilter }
                                    : {}),
                            },
                        ],
                    };
                    // CR scope still wins over personal-todo branch —
                    // a CR is project-scoped, so personal todos never
                    // belong to a CR by definition. Wrapping in AND
                    // here would zero the result; we just suppress
                    // the personal-todo branch entirely.
                    if (crEventScope) {
                        return { AND: [w, { OR: crEventScope }] };
                    }
                    return withTodo;
                }
                if (crEventScope) {
                    // Wrap the bucket where in AND so the existing
                    // OR/project-scope logic stays correct while we
                    // also require CR membership. Using AND here
                    // (instead of merging) sidesteps the Prisma
                    // "empty OR member = FALSE" gotcha that bit us
                    // with the project/app-events OR.
                    return { AND: [w, { OR: crEventScope }] };
                }
                return w;
            };

            const pushBucket = (typesInBucket) => {
                const w = buildBucketWhere(typesInBucket);
                if (!w) {
                    tasks.push(Promise.resolve([]));
                    return;
                }
                tasks.push(
                    prisma.activityEvent.findMany({
                        where: w,
                        take: limit,
                        orderBy: { createdAt: 'desc' },
                        include: eventInclude,
                    }),
                );
            };

            // Two separate queries — each gets its own `take: limit`
            // window so noisy types (PROJECT_VIEWED, time entries,
            // status changes) can't crowd rare ones like
            // TASK_DELETED, TASK_RESTORED, sprint events, user audit.
            pushBucket(importantTypes);
            pushBucket(noisyTypes);
        } else {
            tasks.push(Promise.resolve([]));
            tasks.push(Promise.resolve([]));
        }

        // Use allSettled so one failing query doesn't blank the whole
        // feed — historically a Prisma schema/client mismatch on any
        // one of the side queries here would 500 the entire endpoint
        // and the user would see "internal server error" with no
        // surviving events. We log per-query failures with a stable
        // tag so they surface in `docker logs` instead.
        const settled = await Promise.allSettled(tasks);
        const QUERY_LABELS = [
            'projectsCreated',
            'projectsArchived',
            'tasksCreated',
            'notesAdded',
            'filesUploaded',
            'usersJoined',
            'usersApproved',
            'eventsImportant',
            'eventsNoisy',
        ];
        const resolved = settled.map((r, i) => {
            if (r.status === 'fulfilled') return r.value;
            console.error(
                `[activities] query "${QUERY_LABELS[i] || i}" failed:`,
                r.reason?.message || r.reason,
            );
            return [];
        });
        const [
            projectsCreated,
            projectsArchived,
            tasksCreated,
            notesAdded,
            filesUploaded,
            usersJoined,
            usersApproved,
            eventsImportant,
            eventsNoisy,
        ] = resolved;
        // Merge the two event buckets back into a single stream for
        // the rendering loop below — keeping a single `events` var
        // means the rest of this handler doesn't need to change.
        const events = [...eventsImportant, ...eventsNoisy];

        // Diagnostic: count rare event types so we can quickly see if
        // the bucket split is doing its job. Hit with `?debug=1` to
        // get the counters echoed back on the response. Cheap O(n) scan
        // and only runs when the query string asks for it.
        let debugInfo = null;
        if (req.query.debug === '1') {
            const counts = (arr, predicate) =>
                arr.reduce((n, e) => (predicate(e) ? n + 1 : n), 0);
            debugInfo = {
                eventsImportant: eventsImportant.length,
                eventsNoisy: eventsNoisy.length,
                taskDeletedInImportant: counts(
                    eventsImportant,
                    (e) => e.type === 'TASK_DELETED',
                ),
                taskRestoredInImportant: counts(
                    eventsImportant,
                    (e) => e.type === 'TASK_RESTORED',
                ),
                since: since ? since.toISOString() : 'all',
                scope:
                    scope === null
                        ? 'admin-no-filter'
                        : `${scope.length} project(s)`,
                requestedEventTypes: requestedEventTypes.length,
            };
            console.log('[activities] debug:', debugInfo);
        }

        const items = [];
        // Helper: wrap a rendering branch so a single malformed event
        // (bad meta JSON, missing relation row, etc.) gets skipped
        // with a log instead of taking the whole response down.
        const safe = (label, fn) => {
            try {
                fn();
            } catch (err) {
                console.error(
                    `[activities] render "${label}" failed:`,
                    err?.message || err,
                );
            }
        };

        for (const p of projectsCreated) {
            safe(`projectCreated:${p.id}`, () => {
                items.push({
                    id: `project-created:${p.id}`,
                    type: 'project_created',
                    createdAt: p.createdAt,
                    actor: userShape(p.owner),
                    project: { id: p.id, name: p.name },
                    target: projectShape(p),
                    summary: `created project "${p.name}"`,
                });
            });
        }
        for (const p of projectsArchived) {
            safe(`projectArchived:${p.id}`, () => {
                items.push({
                    id: `project-archived:${p.id}:${p.closedAt?.toISOString()}`,
                    type: 'project_archived',
                    createdAt: p.closedAt,
                    actor: userShape(p.owner),
                    project: { id: p.id, name: p.name },
                    target: projectShape(p),
                    summary: `archived project "${p.name}"`,
                });
            });
        }
        for (const t of tasksCreated) {
            safe(`taskCreated:${t.id}`, () => {
                // Actor resolution order:
                //   1. createdBy   — the canonical author (since the
                //                    soft-delete migration).
                //   2. assignee    — best-guess for legacy tasks that
                //                    pre-date the createdBy column.
                //   3. project.owner — last-resort fallback so a
                //                      personal-project task never
                //                      shows up as "Someone". Personal
                //                      projects only ever have tasks
                //                      added by their owner.
                const actor =
                    userShape(t.createdBy) ||
                    userShape(t.assignee) ||
                    userShape(t.project?.owner);
                items.push({
                    id: `task-created:${t.id}`,
                    type: 'task_created',
                    createdAt: t.createdAt,
                    actor,
                    project: projectShape(t.project),
                    target: { id: t.id, title: t.title },
                    summary: `added task "${t.title}"`,
                });
            });
        }
        for (const n of notesAdded) {
            safe(`noteAdded:${n.id}`, () => {
                items.push({
                    id: `note-added:${n.id}`,
                    type: 'note_added',
                    createdAt: n.createdAt,
                    actor: userShape(n.author),
                    project: projectShape(n.project),
                    target: { id: n.id },
                    summary: `added a note`,
                    preview:
                        typeof n.content === 'string'
                            ? n.content.slice(0, 200)
                            : null,
                });
            });
        }
        for (const f of filesUploaded) {
            safe(`fileUploaded:${f.id}`, () => {
                items.push({
                    id: `file-uploaded:${f.id}`,
                    type: 'file_uploaded',
                    createdAt: f.createdAt,
                    actor: userShape(f.uploader),
                    project: projectShape(f.project),
                    target: { id: f.id, name: f.originalName },
                    summary: `uploaded "${f.originalName}"`,
                });
            });
        }
        for (const u of usersJoined) {
            safe(`userJoined:${u.id}`, () => {
                items.push({
                    id: `user-joined:${u.id}`,
                    type: 'user_joined',
                    createdAt: u.createdAt,
                    actor: userShape(u),
                    project: null,
                    target: userShape(u),
                    summary:
                        u.status === 'PENDING'
                            ? `requested an account`
                            : `joined the workspace`,
                });
            });
        }
        for (const u of usersApproved) {
            safe(`userApproved:${u.id}`, () => {
                items.push({
                    id: `user-approved:${u.id}:${u.approvedAt?.toISOString()}`,
                    type: 'user_approved',
                    createdAt: u.approvedAt,
                    actor: userShape(u),
                    project: null,
                    target: userShape(u),
                    summary: `was approved as a member`,
                });
            });
        }
        for (const e of events) {
          safe(`event:${e.type}:${e.id}`, () => {
            const base = {
                id: `event-${e.id}`,
                createdAt: e.createdAt,
                actor: userShape(e.actor),
                project: projectShape(e.project),
            };
            if (e.type === 'TASK_STATUS_CHANGED') {
                const wasDone = e.fromValue === 'DONE';
                const nowDone = e.toValue === 'DONE';
                let summary;
                if (nowDone && !wasDone) {
                    summary = `marked "${e.message}" as done`;
                } else if (!nowDone && wasDone) {
                    summary = `reopened "${e.message}"`;
                } else {
                    summary = `moved "${e.message}" to ${
                        TASK_STATUS_LABELS[e.toValue] || e.toValue
                    }`;
                }
                items.push({
                    ...base,
                    type: 'task_status_changed',
                    target: { id: e.taskId, title: e.message },
                    summary,
                });
            } else if (e.type === 'TODO_STATUS_CHANGED') {
                const nowDone = e.toValue === 'DONE';
                items.push({
                    ...base,
                    type: 'todo_status_changed',
                    target: { id: e.todoId, title: e.message },
                    summary: nowDone
                        ? `marked to-do "${e.message}" as done`
                        : `reopened to-do "${e.message}"`,
                });
            } else if (e.type === 'PROJECT_ACTIVITY_CREATED') {
                const kind =
                    ACTIVITY_KIND_LABELS[
                        e.toValue || e.activity?.kind || 'OTHER'
                    ] || 'activity';
                items.push({
                    ...base,
                    type: 'project_activity_created',
                    target: {
                        id: e.activityId,
                        title: e.message,
                        kind: e.activity?.kind,
                    },
                    summary: `scheduled a ${kind} "${e.message}"`,
                });
            } else if (e.type === 'PROJECT_ACTIVITY_COMPLETED') {
                const kind =
                    ACTIVITY_KIND_LABELS[
                        e.activity?.kind || 'OTHER'
                    ] || 'activity';
                items.push({
                    ...base,
                    type: 'project_activity_completed',
                    target: {
                        id: e.activityId,
                        title: e.message,
                        kind: e.activity?.kind,
                    },
                    summary: `completed ${kind} "${e.message}"`,
                });
            } else if (e.type === 'PROJECT_ACTIVITY_REOPENED') {
                const kind =
                    ACTIVITY_KIND_LABELS[
                        e.activity?.kind || 'OTHER'
                    ] || 'activity';
                items.push({
                    ...base,
                    type: 'project_activity_completed',
                    target: {
                        id: e.activityId,
                        title: e.message,
                        kind: e.activity?.kind,
                    },
                    summary: `reopened ${kind} "${e.message}"`,
                });
            } else if (e.type === 'TASK_PHASE_CHANGED') {
                items.push({
                    ...base,
                    type: 'task_phase_changed',
                    target: { id: e.taskId, title: e.message },
                    summary: `moved "${e.message}" from ${
                        e.fromValue || 'Unphased'
                    } to ${e.toValue || 'Unphased'}`,
                });
            } else if (e.type === 'TASK_UPDATED') {
                const meta = e.meta || {};
                const labels = Array.isArray(meta.fieldLabels)
                    ? meta.fieldLabels.join(', ')
                    : 'details';
                const noun = meta.isSubtask ? 'subtask' : 'task';
                items.push({
                    ...base,
                    type: 'task_updated',
                    target: { id: e.taskId, title: e.message },
                    summary: `updated the ${labels} of ${noun} "${e.message}"`,
                });
            } else if (e.type === 'TASK_ASSIGNEE_CHANGED') {
                const meta = e.meta || {};
                const noun = meta.isSubtask ? 'subtask' : 'task';
                items.push({
                    ...base,
                    type: 'task_assignee_changed',
                    target: { id: e.taskId, title: e.message },
                    summary: `reassigned ${noun} "${e.message}" from ${
                        e.fromValue || 'Unassigned'
                    } to ${e.toValue || 'Unassigned'}`,
                });
            } else if (e.type === 'TASK_DUE_DATE_CHANGED') {
                const meta = e.meta || {};
                const noun = meta.isSubtask ? 'subtask' : 'task';
                items.push({
                    ...base,
                    type: 'task_due_date_changed',
                    target: { id: e.taskId, title: e.message },
                    summary:
                        e.toValue && e.toValue !== 'no due date'
                            ? `set due date for ${noun} "${e.message}" to ${e.toValue}`
                            : `cleared the due date on ${noun} "${e.message}"`,
                });
            } else if (e.type === 'TASK_DELETED') {
                const meta = e.meta || {};
                const noun = meta.isSubtask ? 'subtask' : 'task';
                // Surface the soft-deleted task's id in `target` so
                // the FE Activities page can attach a "Restore"
                // affordance. The target.id won't deep-link (the row
                // is hidden) — it only feeds the POST /:id/restore
                // call. The summary still describes a delete.
                items.push({
                    ...base,
                    type: 'task_deleted',
                    target: meta.deletedTaskId
                        ? {
                              id: meta.deletedTaskId,
                              title: e.message,
                              isSubtask: Boolean(meta.isSubtask),
                          }
                        : null,
                    summary: `deleted ${noun} "${e.message}"`,
                });
            } else if (e.type === 'TASK_RESTORED') {
                const meta = e.meta || {};
                const noun = meta.isSubtask ? 'subtask' : 'task';
                items.push({
                    ...base,
                    type: 'task_restored',
                    // After a restore the task is alive again, so the
                    // target points to a row the user can navigate to.
                    target: e.taskId
                        ? { id: e.taskId, title: e.message }
                        : null,
                    summary: `restored ${noun} "${e.message}"`,
                });
            } else if (e.type === 'TASK_APPROVED') {
                items.push({
                    ...base,
                    type: 'task_approved',
                    target: e.taskId
                        ? { id: e.taskId, title: e.message }
                        : null,
                    summary: `approved task "${e.message}"`,
                });
            } else if (e.type === 'TASK_DISAPPROVED') {
                const reason = e.meta?.reason;
                items.push({
                    ...base,
                    type: 'task_disapproved',
                    target: e.taskId
                        ? { id: e.taskId, title: e.message }
                        : null,
                    summary: reason
                        ? `disapproved task "${e.message}" — "${reason}"`
                        : `disapproved task "${e.message}"`,
                });
            } else if (e.type === 'TASK_APPROVAL_REQUESTED') {
                items.push({
                    ...base,
                    type: 'task_approval_requested',
                    target: e.taskId
                        ? { id: e.taskId, title: e.message }
                        : null,
                    summary: `re-requested approval for task "${e.message}"`,
                });
            } else if (e.type === 'PROJECT_DELETED') {
                const meta = e.meta || {};
                // Mirror TASK_DELETED: the project id rides in `target.id`
                // (from meta) so the FE can offer a Restore button that
                // POSTs /projects/:id/restore. No deep-link (row hidden).
                items.push({
                    ...base,
                    type: 'project_deleted',
                    target: meta.deletedProjectId
                        ? { id: meta.deletedProjectId, title: e.message }
                        : null,
                    summary: `deleted project "${e.message}"`,
                });
            } else if (e.type === 'PROJECT_RESTORED') {
                items.push({
                    ...base,
                    type: 'project_restored',
                    target: e.projectId
                        ? { id: e.projectId, title: e.message }
                        : null,
                    summary: `restored project "${e.message}"`,
                });
            } else if (e.type === 'NOTE_UPDATED') {
                items.push({
                    ...base,
                    type: 'note_updated',
                    target: e.meta?.noteId ? { id: e.meta.noteId } : null,
                    summary: 'edited a note',
                    preview:
                        typeof e.message === 'string'
                            ? e.message.slice(0, 200)
                            : null,
                });
            } else if (e.type === 'NOTE_DELETED') {
                items.push({
                    ...base,
                    type: 'note_deleted',
                    target: null,
                    summary: 'deleted a note',
                    preview:
                        typeof e.message === 'string'
                            ? e.message.slice(0, 200)
                            : null,
                });
            } else if (e.type === 'PROJECT_PHASE_CHANGED') {
                items.push({
                    ...base,
                    type: 'project_phase_changed',
                    target: e.project ? { id: e.project.id } : null,
                    summary: `moved project phase from "${
                        e.fromValue || 'Unphased'
                    }" to "${e.toValue || 'Unphased'}"`,
                });
            } else if (e.type === 'PROJECT_VIEWED') {
                items.push({
                    ...base,
                    type: 'project_viewed',
                    target: e.project ? { id: e.project.id } : null,
                    summary: 'opened the project',
                });
            } else if (e.type === 'PROJECT_STATUS_CHANGED') {
                items.push({
                    ...base,
                    type: 'project_status_changed',
                    target: e.project ? { id: e.project.id } : null,
                    summary: `changed status from "${
                        PROJECT_STATUS_LABELS[e.fromValue] ||
                        e.fromValue ||
                        '—'
                    }" to "${
                        PROJECT_STATUS_LABELS[e.toValue] || e.toValue || '—'
                    }"`,
                });
            } else if (e.type === 'PROJECT_OWNER_CHANGED') {
                items.push({
                    ...base,
                    type: 'project_owner_changed',
                    target: e.project ? { id: e.project.id } : null,
                    summary: `reassigned ownership from ${
                        e.fromValue || 'Unassigned'
                    } to ${e.toValue || 'Unassigned'}`,
                });
            } else if (e.type === 'PROJECT_DETAILS_UPDATED') {
                // toValue holds a comma-separated label list; meta.fields
                // has the underlying field keys for callers that care.
                const summary = e.toValue
                    ? `edited project details (${e.toValue})`
                    : 'edited project details';
                items.push({
                    ...base,
                    type: 'project_details_updated',
                    target: e.project ? { id: e.project.id } : null,
                    summary,
                });
            } else if (e.type === 'PROJECT_BILLING_CHANGED') {
                const summary = e.toValue
                    ? `updated billing (${e.toValue})`
                    : 'updated billing details';
                items.push({
                    ...base,
                    type: 'project_billing_changed',
                    target: e.project ? { id: e.project.id } : null,
                    summary,
                });
            } else if (e.type === 'PROJECT_PAYMENT_CHANGED') {
                const meta = e.meta || {};
                const which =
                    meta.kind === 'internal'
                        ? 'internal settlement'
                        : 'client invoice';
                const verb = e.toValue === 'paid' ? 'marked' : 'reopened';
                const amount =
                    typeof meta.amount === 'number'
                        ? `${meta.amount.toFixed(2)} ${meta.currency || 'EUR'}`
                        : null;
                const stateLabel = e.toValue === 'paid' ? 'paid' : 'unpaid';
                const summary = amount
                    ? `${verb} ${which} as ${stateLabel} (${amount})`
                    : `${verb} ${which} as ${stateLabel}`;
                items.push({
                    ...base,
                    type: 'project_payment_changed',
                    target: e.project ? { id: e.project.id } : null,
                    summary,
                });
            } else if (e.type === 'TASK_REASSIGN_PROPOSED') {
                const meta = e.meta || {};
                const taskTitle = meta.taskTitle || 'a task';
                // Show from→to in the summary so the line makes sense
                // at a glance. Fall back gracefully when the proposer
                // didn't pick a target ("Anyone (reviewer picks)") or
                // the task was previously unassigned.
                const fromN = meta.fromAssigneeName || 'Unassigned';
                const toN =
                    meta.toAssigneeName || 'Anyone (reviewer picks)';
                items.push({
                    ...base,
                    type: 'task_reassign_proposed',
                    target: e.taskId ? { id: e.taskId, title: taskTitle } : null,
                    summary: `proposed reassigning task "${taskTitle}" from ${fromN} to ${toN}`,
                    preview: e.message || null,
                });
            } else if (e.type === 'TASK_REASSIGN_APPROVED') {
                const meta = e.meta || {};
                const taskTitle = meta.taskTitle || 'a task';
                const fromN = meta.fromAssigneeName || 'Unassigned';
                const toN = meta.toAssigneeName || 'a new assignee';
                items.push({
                    ...base,
                    type: 'task_reassign_approved',
                    target: e.taskId ? { id: e.taskId, title: taskTitle } : null,
                    summary: `approved reassignment of task "${taskTitle}" from ${fromN} to ${toN}`,
                    preview: e.message || null,
                });
            } else if (e.type === 'TASK_REASSIGN_REJECTED') {
                const meta = e.meta || {};
                const taskTitle = meta.taskTitle || 'a task';
                const proposer = meta.proposerName
                    ? ` (proposed by ${meta.proposerName})`
                    : '';
                items.push({
                    ...base,
                    type: 'task_reassign_rejected',
                    target: e.taskId ? { id: e.taskId, title: taskTitle } : null,
                    summary: `declined a reassignment of task "${taskTitle}"${proposer}`,
                    preview: e.message || null,
                });
            } else if (
                e.type === 'TEAM_CREATED' ||
                e.type === 'TEAM_UPDATED' ||
                e.type === 'TEAM_DELETED' ||
                e.type === 'TEAM_MEMBER_ADDED' ||
                e.type === 'TEAM_MEMBER_REMOVED'
            ) {
                items.push({
                    ...base,
                    type: e.type.toLowerCase(),
                    target: null,
                    summary: e.message || e.type.replace(/_/g, ' ').toLowerCase(),
                });
            } else if (e.type === 'PROJECT_TEAM_ADDED') {
                items.push({
                    ...base,
                    type: 'project_team_added',
                    target: e.project ? { id: e.project.id } : null,
                    summary: e.message || 'added a team to the project',
                });
            } else if (e.type === 'PROJECT_TEAM_REMOVED') {
                items.push({
                    ...base,
                    type: 'project_team_removed',
                    target: e.project ? { id: e.project.id } : null,
                    summary: e.message || 'removed a team from the project',
                });
            } else if (e.type === 'PHASE_TEAM_ADDED') {
                items.push({
                    ...base,
                    type: 'phase_team_added',
                    target: e.project ? { id: e.project.id } : null,
                    summary: e.message || 'assigned a team to a phase',
                });
            } else if (e.type === 'PHASE_TEAM_REMOVED') {
                items.push({
                    ...base,
                    type: 'phase_team_removed',
                    target: e.project ? { id: e.project.id } : null,
                    summary: e.message || 'removed a team from a phase',
                });
            } else if (e.type === 'PROJECT_CONTACT_ADDED') {
                items.push({
                    ...base,
                    type: 'project_contact_added',
                    target: e.project ? { id: e.project.id } : null,
                    summary: e.message
                        ? `added contact "${e.message}"`
                        : 'added a project contact',
                });
            } else if (e.type === 'PROJECT_CONTACT_UPDATED') {
                items.push({
                    ...base,
                    type: 'project_contact_updated',
                    target: e.project ? { id: e.project.id } : null,
                    summary: e.message
                        ? `updated contact "${e.message}"`
                        : 'updated a project contact',
                });
            } else if (e.type === 'PROJECT_CONTACT_REMOVED') {
                items.push({
                    ...base,
                    type: 'project_contact_removed',
                    target: e.project ? { id: e.project.id } : null,
                    summary: e.message
                        ? `removed contact "${e.message}"`
                        : 'removed a project contact',
                });
            } else if (
                e.type === 'TIME_ENTRY_TRACKED' ||
                e.type === 'TIME_ENTRY_MANUAL_ADDED'
            ) {
                const meta = e.meta || {};
                const seconds = Number(meta.durationSeconds) || 0;
                const dur = (() => {
                    const s = Math.max(0, Math.floor(seconds));
                    const h = Math.floor(s / 3600);
                    const m = Math.floor((s % 3600) / 60);
                    if (h > 0 && m > 0) return `${h}h ${m}m`;
                    if (h > 0) return `${h}h`;
                    return `${m}m`;
                })();
                const taskHint = (() => {
                    if (meta.taskTitle) {
                        const code = meta.taskCode
                            ? `${meta.taskCode} · `
                            : '';
                        return ` on "${code}${meta.taskTitle}"`;
                    }
                    if (meta.description) {
                        const text = String(meta.description);
                        const short =
                            text.length > 72
                                ? `${text.slice(0, 69)}…`
                                : text;
                        return ` — ${short}`;
                    }
                    return '';
                })();
                const verb =
                    e.type === 'TIME_ENTRY_TRACKED'
                        ? 'tracked'
                        : 'logged';
                items.push({
                    ...base,
                    type:
                        e.type === 'TIME_ENTRY_TRACKED'
                            ? 'time_entry_tracked'
                            : 'time_entry_manual_added',
                    target: e.project ? { id: e.project.id } : null,
                    summary: `${verb} ${dur}${taskHint}${
                        e.type === 'TIME_ENTRY_MANUAL_ADDED'
                            ? ' (manual entry)'
                            : ''
                    }`,
                });
            } else if (e.type?.startsWith('APP_')) {
                // Application catalogue events. They have no project,
                // so we synthesize a target shape pointing at the app
                // (and, when relevant, at a specific release) so the
                // frontend can render and deep-link them.
                const meta = e.meta || {};
                const appName = meta.appName || 'an application';
                const releaseV = meta.releaseVersion
                    ? `v${meta.releaseVersion}`
                    : 'a release';
                const target = meta.appId
                    ? {
                          id: meta.appId,
                          name: meta.appName || null,
                          kind: 'application',
                          releaseId: meta.releaseId || null,
                      }
                    : null;
                let summary;
                let typeKey;
                switch (e.type) {
                    case 'APP_CREATED':
                        typeKey = 'app_created';
                        summary = `added application "${appName}"`;
                        break;
                    case 'APP_UPDATED':
                        typeKey = 'app_updated';
                        summary = `updated application "${appName}"`;
                        break;
                    case 'APP_DELETED':
                        typeKey = 'app_deleted';
                        summary = `deleted application "${appName}"`;
                        break;
                    case 'APP_RELEASE_CREATED':
                        typeKey = 'app_release_created';
                        summary = `added release ${releaseV} to "${appName}"`;
                        break;
                    case 'APP_RELEASE_UPDATED':
                        typeKey = 'app_release_updated';
                        summary = `edited release ${releaseV} of "${appName}"`;
                        break;
                    case 'APP_RELEASE_DELETED':
                        typeKey = 'app_release_deleted';
                        summary = `deleted release ${releaseV} of "${appName}"`;
                        break;
                    case 'APP_RELEASE_PHASE_DECLARED': {
                        typeKey = 'app_release_phase_declared';
                        const from = meta.fromPhase || '—';
                        const to = meta.toPhase || '—';
                        summary = `moved ${appName} ${releaseV} from ${from} to ${to}`;
                        break;
                    }
                    case 'APP_CHECKPOINT_ADDED': {
                        typeKey = 'app_checkpoint_added';
                        const where = meta.environment
                            ? ` on ${meta.environment}`
                            : '';
                        summary = `logged a ${(meta.kind || 'deployment')
                            .toLowerCase()
                            .replace(/_/g, ' ')} checkpoint for ${appName} ${releaseV}${where}`;
                        break;
                    }
                    case 'APP_CHECKPOINT_DELETED':
                        typeKey = 'app_checkpoint_deleted';
                        summary = `removed a checkpoint from ${appName} ${releaseV}`;
                        break;
                    default:
                        typeKey = 'app_event';
                        summary = `acted on ${appName}`;
                }
                items.push({
                    ...base,
                    type: typeKey,
                    target,
                    summary,
                });
            } else if (
                e.type === 'SPRINT_SCHEDULE_UPDATED' ||
                e.type === 'SPRINT_SCHEDULE_DISABLED' ||
                e.type === 'SPRINT_SCHEDULE_AUTO_RUN'
            ) {
                // Sprint scheduler events. These are project-scoped but
                // don't point at any individual sprint — the target is
                // the project itself so the FE deep-links to the
                // Sprints tab of that project.
                const meta = e.meta || {};
                const cadenceLabel = (c) =>
                    c === 'WEEKLY'
                        ? 'weekly'
                        : c === 'BIWEEKLY'
                            ? 'biweekly'
                            : c === 'MONTHLY'
                                ? 'monthly'
                                : c
                                    ? String(c).toLowerCase()
                                    : 'custom';
                const target = e.projectId
                    ? {
                          id: e.projectId,
                          name: null,
                          kind: 'sprintScheduler',
                          projectId: e.projectId,
                      }
                    : null;
                let typeKey;
                let summary;
                if (e.type === 'SPRINT_SCHEDULE_UPDATED') {
                    typeKey = 'sprint_schedule_updated';
                    summary = `${meta.enabled === false ? 'paused' : 'updated'} the sprint schedule (${cadenceLabel(meta.cadence)}, lookahead ${meta.lookahead ?? '?'})`;
                } else if (e.type === 'SPRINT_SCHEDULE_DISABLED') {
                    typeKey = 'sprint_schedule_disabled';
                    summary = 'removed the sprint schedule';
                } else {
                    typeKey = 'sprint_schedule_auto_run';
                    const list = Array.isArray(meta.generated)
                        ? meta.generated
                        : [];
                    if (list.length === 0) {
                        summary = `auto-generated 0 sprints (${cadenceLabel(meta.cadence)})`;
                    } else if (list.length === 1) {
                        summary = `auto-generated sprint "${list[0].sprintName}" (${cadenceLabel(meta.cadence)})`;
                    } else {
                        summary = `auto-generated ${list.length} sprints (${cadenceLabel(meta.cadence)}): ${list.map((s) => `"${s.sprintName}"`).join(', ')}`;
                    }
                }
                items.push({
                    ...base,
                    type: typeKey,
                    target,
                    summary,
                });
            } else if (e.type?.startsWith('SPRINT_') || e.type === 'TASK_ADDED_TO_SPRINT' || e.type === 'TASK_REMOVED_FROM_SPRINT') {
                // Sprint / iteration events. These always carry a
                // projectId via the log call (so they live in the
                // project's per-project feed) and the target points
                // at the sprint inside that project — the FE deep-
                // links to /projects/:projectId#sprints.
                const meta = e.meta || {};
                const sprintName = meta.sprintName || 'a sprint';
                const taskTitle = meta.taskTitle || 'a task';
                const target = meta.sprintId
                    ? {
                          id: meta.sprintId,
                          name: meta.sprintName || null,
                          kind: 'sprint',
                          projectId: e.projectId || null,
                      }
                    : null;
                let summary;
                let typeKey;
                switch (e.type) {
                    case 'SPRINT_CREATED':
                        typeKey = 'sprint_created';
                        summary = `created sprint "${sprintName}"`;
                        break;
                    case 'SPRINT_UPDATED':
                        typeKey = 'sprint_updated';
                        summary = `updated sprint "${sprintName}"`;
                        break;
                    case 'SPRINT_STARTED':
                        typeKey = 'sprint_started';
                        summary = `started sprint "${sprintName}"`;
                        break;
                    case 'SPRINT_CLOSED': {
                        typeKey = 'sprint_closed';
                        const strat =
                            meta.strategy === 'PUSH_TO_NEXT'
                                ? meta.movedTo
                                    ? ` and pushed ${meta.movedTaskCount || 0} task(s) to "${meta.movedTo.sprintName}"`
                                    : ` and pushed ${meta.movedTaskCount || 0} task(s) back to backlog`
                                : meta.strategy === 'BACK_TO_BACKLOG'
                                    ? ` and pushed ${meta.movedTaskCount || 0} task(s) back to backlog`
                                    : '';
                        summary = `closed sprint "${sprintName}"${strat}`;
                        break;
                    }
                    case 'SPRINT_REOPENED':
                        typeKey = 'sprint_reopened';
                        summary = `reopened sprint "${sprintName}"`;
                        break;
                    case 'SPRINT_DELETED':
                        typeKey = 'sprint_deleted';
                        summary = `deleted sprint "${sprintName}"`;
                        break;
                    case 'SPRINT_BULK_DELETED': {
                        typeKey = 'sprint_bulk_deleted';
                        const count = meta.deleted || 0;
                        const taskNote = meta.tasksDetached
                            ? ` (${meta.tasksDetached} task${meta.tasksDetached === 1 ? '' : 's'} sent back to the backlog)`
                            : '';
                        summary = `bulk-deleted ${count} sprint${count === 1 ? '' : 's'}${taskNote}`;
                        break;
                    }
                    case 'TASK_ADDED_TO_SPRINT': {
                        typeKey = 'task_added_to_sprint';
                        const code = meta.taskCode ? `${meta.taskCode} ` : '';
                        summary = `added ${code}"${taskTitle}" to sprint "${sprintName}"`;
                        break;
                    }
                    case 'TASK_REMOVED_FROM_SPRINT': {
                        typeKey = 'task_removed_from_sprint';
                        const code = meta.taskCode ? `${meta.taskCode} ` : '';
                        summary = `removed ${code}"${taskTitle}" from sprint "${sprintName}"`;
                        break;
                    }
                    default:
                        typeKey = 'sprint_event';
                        summary = `acted on sprint "${sprintName}"`;
                }
                items.push({
                    ...base,
                    type: typeKey,
                    target,
                    summary,
                });
            } else if (e.type?.startsWith('TICKET_')) {
                // Ticketing (help-desk) events. Each carries the
                // ticket's projectId (so it lands in that project's
                // feed) and meta.ticketId / meta.ticketCode /
                // meta.ticketSubject for a readable, deep-linkable row.
                const meta = e.meta || {};
                const code = meta.ticketCode ? `${meta.ticketCode} ` : '';
                const subject = meta.ticketSubject || 'a ticket';
                const target = {
                    id: meta.ticketId || null,
                    code: meta.ticketCode || null,
                    title: subject,
                    kind: 'ticket',
                };
                let summary;
                let typeKey;
                switch (e.type) {
                    case 'TICKET_CREATED':
                        typeKey = 'ticket_created';
                        summary = `opened ticket ${code}"${subject}"`;
                        break;
                    case 'TICKET_STATUS_CHANGED':
                        typeKey = 'ticket_status_changed';
                        summary = `moved ticket ${code}"${subject}" from ${
                            TICKET_STATUS_LABELS[e.fromValue] ||
                            e.fromValue ||
                            '—'
                        } to ${
                            TICKET_STATUS_LABELS[e.toValue] || e.toValue || '—'
                        }`;
                        break;
                    case 'TICKET_ASSIGNED':
                        typeKey = 'ticket_assigned';
                        summary = e.toValue
                            ? `assigned ticket ${code}"${subject}" to ${e.toValue}`
                            : `released ticket ${code}"${subject}" back to the queue`;
                        break;
                    case 'TICKET_DELETED':
                        typeKey = 'ticket_deleted';
                        summary = `deleted ticket ${code}"${subject}"`;
                        break;
                    case 'TICKET_RESTORED':
                        typeKey = 'ticket_restored';
                        summary = `restored ticket ${code}"${subject}"`;
                        break;
                    default:
                        typeKey = 'ticket_event';
                        summary = `acted on ticket ${code}"${subject}"`;
                }
                items.push({ ...base, type: typeKey, target, summary });
            } else if (e.type?.startsWith('ANNOUNCEMENT_')) {
                // Broadcast announcement audit events (admin, no project).
                const meta = e.meta || {};
                const title = meta.title || e.message || 'an announcement';
                const target = {
                    id: meta.announcementId || null,
                    title,
                    kind: 'announcement',
                };
                let summary;
                let typeKey;
                switch (e.type) {
                    case 'ANNOUNCEMENT_CREATED':
                        typeKey = 'announcement_created';
                        summary = `created announcement "${title}"`;
                        break;
                    case 'ANNOUNCEMENT_ACTIVATED':
                        typeKey = 'announcement_activated';
                        summary = `activated announcement "${title}"`;
                        break;
                    case 'ANNOUNCEMENT_DEACTIVATED':
                        typeKey = 'announcement_deactivated';
                        summary = `deactivated announcement "${title}"`;
                        break;
                    case 'ANNOUNCEMENT_DELETED':
                        typeKey = 'announcement_deleted';
                        summary = `deleted announcement "${title}"`;
                        break;
                    case 'ANNOUNCEMENT_ACKNOWLEDGED':
                        typeKey = 'announcement_acknowledged';
                        summary = meta.comment
                            ? `acknowledged "${title}" — “${meta.comment}”`
                            : `acknowledged "${title}"`;
                        break;
                    default:
                        typeKey = 'announcement_event';
                        summary = `acted on announcement "${title}"`;
                }
                items.push({ ...base, type: typeKey, target, summary });
            } else {
                // User / account events. We use the actor as the
                // visible "person" for the row and embed target user
                // details (name / id) into the target shape so the FE
                // can deep-link to them.
                const meta = e.meta || {};
                const targetUser = meta.targetUserId
                    ? {
                          id: meta.targetUserId,
                          name: meta.targetUserName || meta.targetUserEmail || null,
                      }
                    : null;
                const isSelfAction =
                    targetUser && e.actor && targetUser.id === e.actor.id;
                const targetName =
                    isSelfAction || !targetUser
                        ? null
                        : targetUser.name || 'a user';

                if (e.type === 'USER_REGISTERED') {
                    items.push({
                        ...base,
                        type: 'user_registered',
                        target: targetUser,
                        summary: meta.bootstrap
                            ? 'created the workspace and signed up as the first admin'
                            : 'registered an account',
                    });
                } else if (e.type === 'USER_LOGIN') {
                    items.push({
                        ...base,
                        type: 'user_login',
                        target: targetUser,
                        summary: 'signed in',
                    });
                } else if (e.type === 'USER_CREATED') {
                    items.push({
                        ...base,
                        type: 'user_created',
                        target: targetUser,
                        summary: targetName
                            ? `created user "${targetName}"${e.toValue ? ` (${e.toValue})` : ''}`
                            : 'created a user',
                    });
                } else if (e.type === 'USER_DELETED') {
                    items.push({
                        ...base,
                        type: 'user_deleted',
                        target: targetUser,
                        summary: targetName
                            ? `deleted user "${targetName}"`
                            : 'deleted a user',
                    });
                } else if (e.type === 'USER_PROFILE_UPDATED') {
                    const fields = e.toValue || 'profile';
                    items.push({
                        ...base,
                        type: 'user_profile_updated',
                        target: targetUser,
                        summary: isSelfAction
                            ? `updated their profile (${fields})`
                            : targetName
                                ? `updated ${targetName}'s profile (${fields})`
                                : `updated a profile (${fields})`,
                    });
                } else if (e.type === 'USER_AVATAR_UPDATED') {
                    items.push({
                        ...base,
                        type: 'user_avatar_updated',
                        target: targetUser,
                        summary: isSelfAction
                            ? meta.hadPrevious
                                ? 'changed their profile picture'
                                : 'added a profile picture'
                            : targetName
                                ? `changed ${targetName}'s profile picture`
                                : 'changed a profile picture',
                    });
                } else if (e.type === 'USER_AVATAR_REMOVED') {
                    items.push({
                        ...base,
                        type: 'user_avatar_updated',
                        target: targetUser,
                        summary: isSelfAction
                            ? 'removed their profile picture'
                            : targetName
                                ? `removed ${targetName}'s profile picture`
                                : 'removed a profile picture',
                    });
                } else if (e.type === 'USER_PASSWORD_CHANGED') {
                    items.push({
                        ...base,
                        type: 'user_password_changed',
                        target: targetUser,
                        summary: meta.viaReset
                            ? 'reset their password using a reset link'
                            : isSelfAction
                                ? 'changed their password'
                                : targetName
                                    ? `set a new password for ${targetName}`
                                    : 'changed a password',
                    });
                } else if (e.type === 'USER_ROLE_CHANGED') {
                    items.push({
                        ...base,
                        type: 'user_role_changed',
                        target: targetUser,
                        summary: targetName
                            ? `changed ${targetName}'s role from ${e.fromValue || '—'} to ${e.toValue || '—'}`
                            : `changed a user's role from ${e.fromValue || '—'} to ${e.toValue || '—'}`,
                    });
                } else if (e.type === 'USER_CAPABILITIES_CHANGED') {
                    const before = (e.meta?.before || []).length;
                    const after = (e.meta?.after || []).length;
                    items.push({
                        ...base,
                        type: 'user_capabilities_changed',
                        target: targetUser,
                        summary: targetName
                            ? `updated ${targetName}'s capability overrides (${before} → ${after})`
                            : `updated a user's capability overrides (${before} → ${after})`,
                    });
                } else if (e.type === 'USER_APPROVED') {
                    items.push({
                        ...base,
                        type: 'user_approved',
                        target: targetUser,
                        summary: targetName
                            ? `approved ${targetName}'s account`
                            : 'approved a user account',
                    });
                } else if (e.type === 'USER_SUSPENDED') {
                    items.push({
                        ...base,
                        type: 'user_suspended',
                        target: targetUser,
                        summary: targetName
                            ? `suspended ${targetName}`
                            : 'suspended a user',
                    });
                } else if (e.type === 'USER_REACTIVATED') {
                    items.push({
                        ...base,
                        type: 'user_reactivated',
                        target: targetUser,
                        summary: targetName
                            ? `reactivated ${targetName}'s account`
                            : 'reactivated a user account',
                    });
                }
            }
          });
        }

        items.sort(
            (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
        );

        // Protect rare/important events from being sliced off the
        // bottom by high-volume rendered types.
        //
        // The BACKEND already splits the queries into noisy / important
        // buckets so each bucket gets its own `take: limit` budget at
        // the DB layer — but the merged `items` array also includes
        // rows synthesised from the live source tables (Project,
        // Task, Note, File, User) which the bucket split doesn't
        // cover. On a workspace where PROJECT_VIEWED +
        // TASK_STATUS_CHANGED fire hundreds of times a day, that
        // merged array can easily exceed `limit`, and a single
        // top-N slice by createdAt evicts rare events
        // (TASK_DELETED, TASK_RESTORED, sprint events, user audit,
        // CR events, …) even though they sit in the database AND
        // appear in the CSV export — exactly the symptom the user
        // hit.
        //
        // Strategy:
        //   1. Split items by rendered type into IMPORTANT vs NOISY.
        //   2. ALWAYS keep every IMPORTANT row, even if doing so
        //      exceeds `limit` — they are the auditor's reason for
        //      visiting this page.
        //   3. Slice NOISY items to fill the remaining headroom,
        //      most-recent first.
        //   4. Re-sort the combined result by createdAt so the
        //      caller sees a single chronological list.
        const NOISY_RENDERED_TYPES = new Set([
            'project_viewed',
            'task_status_changed',
        ]);
        const importantItems = items.filter(
            (it) => !NOISY_RENDERED_TYPES.has(it.type),
        );
        const noisyItems = items.filter((it) =>
            NOISY_RENDERED_TYPES.has(it.type),
        );
        // Hard cap so a workspace with thousands of rare events
        // can't OOM the response. The cap is generous (2× limit)
        // because important events are precisely what the user
        // came here to see.
        const importantKept = importantItems.slice(0, limit * 2);
        const noisyBudget = Math.max(0, limit - importantKept.length);
        const noisyKept = noisyItems.slice(0, noisyBudget);
        const finalItems = [...importantKept, ...noisyKept].sort(
            (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
        );

        res.json({
            activities: finalItems,
            ...(debugInfo
                ? {
                      debug: {
                          ...debugInfo,
                          renderedTotal: items.length,
                          renderedImportant: importantItems.length,
                          renderedNoisy: noisyItems.length,
                          returnedImportant: importantKept.length,
                          returnedNoisy: noisyKept.length,
                          returnedTotal: finalItems.length,
                      },
                  }
                : {}),
        });
    } catch (err) {
        // Log the route + the actual failure so when the user sees
        // "internal server error" we can match it to a backend line.
        // Then pass to the central error handler for the 500 response
        // shape (same as before).
        console.error(
            '[activities] GET / failed:',
            err?.message || err,
            err?.stack,
        );
        next(err);
    }
});

// ─── CSV export (admin only) ────────────────────────────────────────
// Dumps raw ActivityEvent rows that match the same filters the feed UI
// uses (`since`, `types`, `projectId`, `userId`). No per-bucket cap —
// the entire matching set is streamed back, suitable for offline
// archival. Capped at MAX_EXPORT_ROWS as a hard safety net so a
// runaway "All time / All activity" pull can't OOM the API node.
const MAX_EXPORT_ROWS = 50_000;
router.get('/export.csv', requireAdmin, async (req, res, next) => {
    try {
        // Same `__none__` sentinel as the live feed — when the user
        // has unchecked every type, return an empty CSV (headers
        // only) instead of dumping the entire audit log.
        if (req.query.types === '__none__') {
            const headers = [
                { key: 'createdAt', label: 'Timestamp' },
                { key: 'type', label: 'Event type' },
            ];
            const csv = buildCsv(headers, []);
            const stamp = new Date().toISOString().slice(0, 10);
            const filename = `${safeFilename('activities', 'activities')}-${stamp}.csv`;
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${filename}"`,
            );
            return res.send(csv);
        }
        const requestedTypes = (req.query.types || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => ACTIVITY_TYPES.includes(s));
        const types = requestedTypes.length
            ? requestedTypes
            : ACTIVITY_TYPES;

        const since = parseSinceParam(req.query.since || '7d');
        const until = parseUntilParam(req.query.until);

        let projectId = req.query.projectId || null;
        const userId = req.query.userId || null;
        const changeRequestId = req.query.changeRequestId || null;

        // Map the lowercase filter ids back to UPPER_CASE event types
        // for the where clause, then INTERSECT with the actual Prisma
        // enum so synthetic types (PROJECT_CREATED / PROJECT_ARCHIVED /
        // FILE_UPLOADED / USER_JOINED — which only exist in the live
        // feed, never in ActivityEvent) drop out cleanly. Without the
        // intersection, Prisma rejects the whole query the moment we
        // try to filter `type: { in: [...invalidEnumValue] }`, which
        // is what was making "All activities" exports silently 500.
        const lower2upper = (t) => t.toUpperCase();
        const validEnumSet = new Set(ACTIVITY_EVENT_TYPE_VALUES);
        let eventTypeFilter;
        if (requestedTypes.length) {
            const wanted = new Set(requestedTypes.map(lower2upper));
            // PROJECT_ACTIVITY_REOPENED shares the "completed" filter id.
            if (wanted.has('PROJECT_ACTIVITY_COMPLETED')) {
                wanted.add('PROJECT_ACTIVITY_REOPENED');
            }
            if (wanted.has('USER_AVATAR_UPDATED')) {
                wanted.add('USER_AVATAR_REMOVED');
            }
            eventTypeFilter = ACTIVITY_EVENT_TYPE_VALUES.filter((t) =>
                wanted.has(t),
            );
        } else {
            // No type filter = export EVERY audit row. We pass the full
            // enum so it stays in sync with schema.prisma automatically.
            eventTypeFilter = ACTIVITY_EVENT_TYPE_VALUES;
        }
        // Defensive trim: if some caller ever slips a non-enum string
        // through the filter pipeline above (legacy column rename,
        // etc.), strip it out here so the query can't blow up.
        eventTypeFilter = eventTypeFilter.filter((t) => validEnumSet.has(t));

        // CR scope for the export. Same semantics as the live feed:
        // pivot to "events about this CR" — its tasks, its notes,
        // and any event whose meta carries the CR id. We resolve the
        // CR's projectId and force `projectId` to match so the row-
        // count stays consistent with the on-screen feed an admin
        // would see for the same filter combo.
        let crTaskIds = null;
        if (changeRequestId) {
            const cr = await prisma.changeRequest.findUnique({
                where: { id: changeRequestId },
                select: { id: true, projectId: true },
            });
            if (!cr) {
                // Empty CSV (headers only) keeps the response shape
                // identical to "no matches".
                const headers = [
                    { key: 'createdAt', label: 'Timestamp' },
                    { key: 'type', label: 'Event type' },
                ];
                const csv = buildCsv(headers, []);
                const stamp = new Date().toISOString().slice(0, 10);
                const filename = `${safeFilename('activities', 'activities')}-${stamp}.csv`;
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader(
                    'Content-Disposition',
                    `attachment; filename="${filename}"`,
                );
                return res.send(csv);
            }
            projectId = cr.projectId;
            const taskRows = await prisma.task.findMany({
                where: { changeRequestId },
                select: { id: true },
            });
            crTaskIds = taskRows.map((t) => t.id);
        }

        const where = {
            type: { in: eventTypeFilter },
            // `since` (gte) + optional `until` (lte) — when the FE
            // sends a Custom range we get both bounds; relative
            // presets only set `since`.
            ...(buildDateFilter(since, until)
                ? { createdAt: buildDateFilter(since, until) }
                : {}),
            ...(userId ? { actorId: userId } : {}),
            ...(projectId ? { projectId } : {}),
            ...(changeRequestId
                ? {
                      AND: [
                          {
                              OR: [
                                  {
                                      meta: {
                                          path: ['changeRequestId'],
                                          equals: changeRequestId,
                                      },
                                  },
                                  {
                                      meta: {
                                          path: ['crId'],
                                          equals: changeRequestId,
                                      },
                                  },
                                  ...(crTaskIds && crTaskIds.length
                                      ? [{ taskId: { in: crTaskIds } }]
                                      : []),
                              ],
                          },
                      ],
                  }
                : {}),
        };

        const rows = await prisma.activityEvent.findMany({
            where,
            take: MAX_EXPORT_ROWS,
            orderBy: { createdAt: 'desc' },
            include: {
                actor: {
                    select: { id: true, name: true, email: true },
                },
                project: { select: { id: true, name: true } },
            },
        });

        const headers = [
            { key: 'createdAt', label: 'Timestamp' },
            { key: 'type', label: 'Event type' },
            { key: 'actorName', label: 'Actor' },
            { key: 'actorEmail', label: 'Actor email' },
            { key: 'projectName', label: 'Project' },
            { key: 'projectId', label: 'Project id' },
            { key: 'taskId', label: 'Task id' },
            { key: 'message', label: 'Message' },
            { key: 'fromValue', label: 'From' },
            { key: 'toValue', label: 'To' },
            { key: 'meta', label: 'Meta (JSON)' },
        ];

        const csvRows = rows.map((r) => ({
            createdAt: r.createdAt,
            type: r.type,
            actorName: r.actor?.name || '',
            actorEmail: r.actor?.email || '',
            projectName: r.project?.name || '',
            projectId: r.projectId || '',
            taskId: r.taskId || '',
            message: r.message || '',
            fromValue: r.fromValue || '',
            toValue: r.toValue || '',
            meta: r.meta ? JSON.stringify(r.meta) : '',
        }));

        const csv = buildCsv(headers, csvRows);
        const stamp = new Date().toISOString().slice(0, 10);
        const filename = `${safeFilename('activities', 'activities')}-${stamp}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${filename}"`,
        );
        res.send(csv);
    } catch (err) {
        console.error(
            '[activities] GET /export.csv failed:',
            err?.message || err,
            err?.stack,
        );
        next(err);
    }
});

module.exports = router;
