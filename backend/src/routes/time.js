// Time tracking. Each TimeEntry is one block of time the user spent
// working on a project — optionally pinned to a specific task.
//
// API surface (mounted at /api/time):
//
//   GET    /running                       -> caller's running timer (or null)
//   POST   /start                         -> start a live timer
//   POST   /stop                          -> stop the caller's running timer
//   POST   /                              -> manual entry (startedAt + endedAt)
//   PATCH  /:id                           -> edit an entry
//   DELETE /:id                           -> delete an entry
//   GET    /me                            -> caller's own entries
//   GET    /                              -> entries with filters (project / user / dates)
//   GET    /projects/:projectId/summary   -> totals + breakdowns for a project
//
// Permissions (kept consistent with the rest of the app):
//   - Logging time on a project  : caller must have project read access
//                                  (owner, participant, or admin on shared
//                                  projects; owner / invited participants
//                                  on personal projects).
//   - Edit / delete entry        : the entry's author OR admin.
//   - Reading other users' entries on a project : admin, manager with
//                                  project read access, or the project
//                                  owner. Otherwise callers only see
//                                  their own entries.
//
// Roll-up: `projectId` is always set. When a `taskId` is provided we
// derive the `projectId` from the task itself, so a task entry can
// never disagree with the project it belongs to.

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    isAdmin,
    isManager,
    assertProjectRead,
    assertProjectWritable,
    CAPABILITIES,
    hasCapability,
} = require('../lib/permissions');
const { logActivityEvent } = require('../lib/activityLog');
const { isTaskApprovalLocked } = require('../lib/taskApproval');
const { notify } = require('../lib/notify');
const {
    applyClientApplicationProjectFilter,
    finalizeTimeEntryProjectScope,
} = require('../lib/timeFilters');

const router = express.Router();
router.use(requireAuth);

// Emit an audit-log entry for a freshly created / freshly stopped
// time entry. Wrapped in try/catch so an audit failure never breaks
// the user-facing time API. Skips entries with zero duration so a
// "started + stopped immediately" mistake doesn't pollute the feed.
function formatDurationSeconds(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
}

function timeEntryActivityMessage(entry) {
    const dur = formatDurationSeconds(entry.durationSeconds);
    const verb = entry.source === 'MANUAL' ? 'logged' : 'tracked';
    let hint = '';
    if (entry.task?.title) {
        const code = entry.task?.code ? `${entry.task.code} · ` : '';
        hint = ` on "${code}${entry.task.title}"`;
    } else if (entry.description) {
        const text = String(entry.description);
        hint = ` — ${text.length > 72 ? `${text.slice(0, 69)}…` : text}`;
    }
    const manual = entry.source === 'MANUAL' ? ' (manual entry)' : '';
    return `${verb} ${dur}${hint}${manual}`;
}

async function logTimeEntryAdded(entry, actorId) {
    if (!entry || !actorId) return;
    if (!entry.durationSeconds || entry.durationSeconds <= 0) return;
    try {
        await logActivityEvent({
            type:
                entry.source === 'MANUAL'
                    ? 'TIME_ENTRY_MANUAL_ADDED'
                    : 'TIME_ENTRY_TRACKED',
            actorId,
            projectId: entry.projectId,
            taskId: entry.taskId || null,
            message: timeEntryActivityMessage(entry),
            meta: {
                entryId: entry.id,
                source: entry.source,
                durationSeconds: entry.durationSeconds,
                taskTitle: entry.task?.title || null,
                taskCode: entry.task?.code || null,
                description: entry.description || null,
            },
        });
    } catch (err) {
        console.warn('[time] could not audit entry:', err.message);
    }
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

const optionalDescription = z
    .string()
    .max(2000)
    .optional()
    .nullable()
    .transform((v) => {
        if (v === undefined || v === null) return undefined;
        const trimmed = v.trim();
        return trimmed.length === 0 ? null : trimmed;
    });

// Allowed "why am I logging on someone else's task" categories. Kept in
// sync with the frontend list (lib/timeReason.js).
const CROSS_USER_REASONS = [
    'HELPING',
    'PARTICIPATING',
    'COVERING',
    'CORRECTING',
    'OTHER',
];
const crossUserReasonField = z
    .enum(CROSS_USER_REASONS)
    .optional()
    .nullable();
const crossUserNoteField = z
    .string()
    .max(500)
    .optional()
    .nullable()
    .transform((v) => {
        if (v === undefined || v === null) return undefined;
        const trimmed = v.trim();
        return trimmed.length === 0 ? null : trimmed;
    });

const startSchema = z
    .object({
        projectId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        description: optionalDescription,
    })
    .refine((v) => v.projectId || v.taskId, {
        message: 'Either projectId or taskId is required',
    });

// Manual entries pass startedAt + endedAt. Both must parse to valid
// dates and `endedAt` must be strictly after `startedAt`. Capped at
// 24h to keep accidental entries (forgotten timer running for days)
// from poisoning the totals — the user can split a longer block into
// multiple entries.
const MAX_ENTRY_SECONDS = 24 * 60 * 60;

const manualSchema = z
    .object({
        projectId: z.string().min(1).optional(),
        taskId: z.string().min(1).optional(),
        startedAt: z.coerce.date(),
        endedAt: z.coerce.date(),
        description: optionalDescription,
        crossUserReason: crossUserReasonField,
        crossUserNote: crossUserNoteField,
    })
    .refine((v) => v.projectId || v.taskId, {
        message: 'Either projectId or taskId is required',
    })
    .refine((v) => v.endedAt.getTime() > v.startedAt.getTime(), {
        message: 'endedAt must be after startedAt',
        path: ['endedAt'],
    })
    .refine(
        (v) =>
            (v.endedAt.getTime() - v.startedAt.getTime()) / 1000 <=
            MAX_ENTRY_SECONDS,
        {
            message: 'Entry cannot be longer than 24 hours',
            path: ['endedAt'],
        },
    );

// PATCH accepts every editable field, all optional. We only touch what
// the caller actually sent.
const updateSchema = z
    .object({
        startedAt: z.coerce.date().optional(),
        endedAt: z.coerce.date().nullable().optional(),
        taskId: z
            .string()
            .transform((v) => (v === '' ? null : v))
            .pipe(z.string().min(1).nullable())
            .optional(),
        description: optionalDescription,
    })
    .refine(
        (v) =>
            !(v.startedAt && v.endedAt && v.endedAt instanceof Date) ||
            v.endedAt.getTime() > v.startedAt.getTime(),
        {
            message: 'endedAt must be after startedAt',
            path: ['endedAt'],
        },
    );

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const entryInclude = {
    project: {
        select: {
            id: true,
            code: true,
            name: true,
            isPersonal: true,
            ownerId: true,
        },
    },
    task: {
        select: {
            id: true,
            code: true,
            title: true,
            parentTaskId: true,
            // Parent context lets the spreadsheet render an entry on a
            // subtask as "Parent task \u2192 Subtask" without a second
            // round-trip per row.
            parent: {
                select: { id: true, code: true, title: true },
            },
        },
    },
    user: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    // For mirror entries: the personal project that originated this entry.
    fromPersonalProject: {
        select: { id: true, code: true, name: true },
    },
    // For mirror entries: hop to the source entry on the personal
    // project so the export / admin spreadsheet can show the
    // personal task title (and description) the user originally
    // logged on. Always null on source entries themselves —
    // `sourceEntryId` is only set when this row IS a mirror.
    sourceEntry: {
        select: {
            id: true,
            description: true,
            task: {
                select: {
                    id: true,
                    code: true,
                    title: true,
                    parentTaskId: true,
                    parent: {
                        select: { id: true, code: true, title: true },
                    },
                },
            },
        },
    },
};

// Resolve { projectId, taskId } from the caller's payload. If a task is
// referenced its project is the source of truth (we discard whatever
// `projectId` the caller sent for tasks). Returns the loaded task when
// taskId was present, so callers can use the title/code in audit logs.
//
// We also pull `assigneeId` and `parentTaskId` so `assertCanLogOnScope`
// below can enforce "regular users may only log on tasks assigned to
// them" without a second round-trip.
async function resolveScope({ projectId, taskId }) {
    if (taskId) {
        const task = await prisma.task.findUnique({
            where: { id: taskId },
            select: {
                id: true,
                projectId: true,
                title: true,
                code: true,
                assigneeId: true,
                parentTaskId: true,
                specific: true,
                approvedAt: true,
            },
        });
        if (!task) throw httpError(404, 'Task not found');
        if (isTaskApprovalLocked(task)) {
            throw httpError(
                403,
                'This task must be approved before you can log time on it.',
            );
        }
        return { projectId: task.projectId, taskId: task.id, task };
    }
    if (!projectId) {
        throw httpError(400, 'Either projectId or taskId is required');
    }
    return { projectId, taskId: null, task: null };
}

// -----------------------------------------------------------------------------
// Personal-project mirror helpers
// -----------------------------------------------------------------------------

// Look up personal-project metadata for a project (isPersonal + linkedProjectId).
function getProjectMirrorMeta(projectId) {
    return prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, isPersonal: true, linkedProjectId: true },
    });
}

// Create a mirror time entry on the linked project.
// Called immediately after a source entry is completed (endedAt is set).
async function createMirrorEntry(source, personalProjectId, linkedProjectId) {
    if (!source.endedAt) return null; // Never mirror a still-running timer
    try {
        return await prisma.timeEntry.create({
            data: {
                userId: source.userId,
                projectId: linkedProjectId,
                taskId: null, // Project-level on the linked project
                startedAt: source.startedAt,
                endedAt: source.endedAt,
                durationSeconds: source.durationSeconds,
                description: source.description,
                source: source.source,
                fromPersonalProjectId: personalProjectId,
                sourceEntryId: source.id,
            },
        });
    } catch (err) {
        // Mirror creation is best-effort — don't fail the whole request.
        console.warn('[time] could not create personal-project mirror:', err.message);
        return null;
    }
}

// After an entry is created or updated, ensure its mirror on the linked project
// is in sync. Skips source entries that aren't on personal projects with a link,
// and skips mirror entries themselves (sourceEntryId != null means it's a mirror).
async function syncMirror(entry) {
    if (entry.sourceEntryId) return; // This entry IS a mirror — never recurse
    if (!entry.endedAt) return;      // Timer still running — nothing to mirror yet

    const meta = await getProjectMirrorMeta(entry.projectId);
    if (!meta?.isPersonal || !meta.linkedProjectId) return;

    const existing = await prisma.timeEntry.findUnique({
        where: { sourceEntryId: entry.id },
    });

    if (existing) {
        await prisma.timeEntry.update({
            where: { id: existing.id },
            data: {
                startedAt: entry.startedAt,
                endedAt: entry.endedAt,
                durationSeconds: entry.durationSeconds,
                description: entry.description,
            },
        });
    } else {
        await createMirrorEntry(entry, meta.id, meta.linkedProjectId);
    }
}

// Delete the mirror entry when the source is deleted.
async function deleteMirror(sourceId) {
    try {
        await prisma.timeEntry.deleteMany({ where: { sourceEntryId: sourceId } });
    } catch (err) {
        console.warn('[time] could not delete personal-project mirror:', err.message);
    }
}

// Per-policy: a regular user may log time on a project they participate
// in, but if they pin the entry to a specific task that task must be
// assigned to them. Admins and managers (already trusted with the
// project) and the project owner (covers personal projects) bypass.
//
// Project-level entries (taskId == null) are out of scope — they're
// already gated by assertProjectRead at the call site.
async function assertCanLogOnScope(req, scope) {
    if (!scope?.task) return;
    if (isAdmin(req) || isManager(req)) return;

    // Look up the project once — we need both ownerId and isPersonal.
    const project = await prisma.project.findUnique({
        where: { id: scope.projectId },
        select: { ownerId: true, isPersonal: true },
    });

    // Personal-project owners may log time on ANY task in their project
    // without having to be the assignee — the project is their private
    // organiser and they control all tasks in it.
    if (project?.isPersonal && project?.ownerId === req.user.id) return;

    // Assignee can always log against their own task.
    if (scope.task.assigneeId === req.user.id) return;

    // Owner of a shared project can log on any task in it.
    if (project?.ownerId === req.user.id) return;

    throw httpError(
        403,
        'You can only log time on tasks assigned to you. Pick "Project-level time" to log against the project instead.',
    );
}

// True when `req.user` may see any entry on this project (including
// other users' entries). Admins, managers with read, and the project
// owner.
async function canSeeAllOnProject(req, projectId) {
    if (isAdmin(req)) return true;
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, ownerId: true, isPersonal: true },
    });
    if (!project) return false;
    if (project.ownerId === req.user.id) return true;
    if (isManager(req) && !project.isPersonal) {
        try {
            await assertProjectRead(req, projectId);
            return true;
        } catch {
            return false;
        }
    }
    return false;
}

function durationSecondsBetween(start, end) {
    if (!end) return 0;
    return Math.max(
        0,
        Math.round((end.getTime() - start.getTime()) / 1000),
    );
}

function loadEntryOr404(id) {
    return prisma.timeEntry.findUnique({
        where: { id },
        include: entryInclude,
    });
}

function canMutateEntry(req, entry) {
    if (!entry) return false;
    if (entry.userId === req.user.id) return true;
    if (isAdmin(req)) return true;
    return false;
}

// -----------------------------------------------------------------------------
// Running-timer helpers
// -----------------------------------------------------------------------------

function findRunningTimer(userId) {
    return prisma.timeEntry.findFirst({
        where: { userId, endedAt: null },
        orderBy: { startedAt: 'desc' },
        include: entryInclude,
    });
}

// Stop any timer the user currently has running. Used both by the
// dedicated /stop endpoint and implicitly by /start so a fresh start
// never leaves an orphaned running timer behind.
async function stopUserTimers(userId, now = new Date()) {
    const running = await prisma.timeEntry.findMany({
        where: { userId, endedAt: null },
        select: { id: true, startedAt: true },
    });
    if (running.length === 0) return [];
    return Promise.all(
        running.map((r) => {
            const seconds = durationSecondsBetween(r.startedAt, now);
            return prisma.timeEntry.update({
                where: { id: r.id },
                data: { endedAt: now, durationSeconds: seconds },
                include: entryInclude,
            });
        }),
    );
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

router.get('/running', async (req, res, next) => {
    try {
        const entry = await findRunningTimer(req.user.id);
        res.json({ entry });
    } catch (err) {
        next(err);
    }
});

// -----------------------------------------------------------------------------
// Time-log compliance policy (admin) + per-user compliance status
// -----------------------------------------------------------------------------

const TIME_POLICY_ID = 'singleton';
const DEFAULT_TIME_POLICY = {
    enabled: false,
    cutoffDay: 24,
    reminderLeadDays: 7,
    minHoursPerDay: 6,
    notify: false,
};

async function loadTimePolicy() {
    const row = await prisma.timeLogPolicy.findUnique({
        where: { id: TIME_POLICY_ID },
    });
    return (
        row || {
            id: TIME_POLICY_ID,
            ...DEFAULT_TIME_POLICY,
            updatedAt: null,
            updatedById: null,
        }
    );
}

const timePolicySchema = z.object({
    enabled: z.boolean().optional(),
    cutoffDay: z.coerce.number().int().min(1).max(28).optional(),
    reminderLeadDays: z.coerce.number().int().min(1).max(31).optional(),
    minHoursPerDay: z.coerce.number().min(0).max(24).optional(),
    notify: z.boolean().optional(),
});

// Local-day key for grouping entries + the notify-once marker.
function localDayKey(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Count working days (Mon–Fri) between two dates, inclusive. Public
// holidays aren't modelled — the target is plain weekdays.
function workingDaysBetween(start, end) {
    let count = 0;
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    while (d <= last) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) count += 1;
        d.setDate(d.getDate() + 1);
    }
    return count;
}

// Given a cutoff day-of-month and "now", work out the current cycle: the
// most-recently-completed calendar month relative to the upcoming cutoff,
// its [start,end], the deadline date, and the working-day target.
//
//   • before/on the cutoff  → enforce LAST month, due on the cutoff of THIS month
//   • after the cutoff       → enforce THIS month, due on the cutoff of NEXT month
//
// Either way the enforced month has fully elapsed by the time the reminder
// window opens, so its weekday count is always achievable.
function computeCycle(cutoffDay, now = new Date()) {
    const y = now.getFullYear();
    const m = now.getMonth();
    const afterCutoff = now.getDate() > cutoffDay;
    // Deadline month index (relative to now).
    const deadlineMonth = afterCutoff ? m + 1 : m;
    const deadline = new Date(y, deadlineMonth, cutoffDay, 23, 59, 59, 999);
    // Enforced month = the calendar month immediately before the deadline month.
    const periodStart = new Date(y, deadlineMonth - 1, 1, 0, 0, 0, 0);
    const periodEnd = new Date(y, deadlineMonth, 0, 23, 59, 59, 999); // last day of that month
    const requiredDays = workingDaysBetween(periodStart, periodEnd);
    return { periodStart, periodEnd, deadline, requiredDays };
}

// Count distinct days in [start,end] where the user's own (non-mirror)
// logged time reaches `minHoursPerDay`.
async function computeFilledDays(userId, start, end, minHoursPerDay) {
    const entries = await prisma.timeEntry.findMany({
        where: {
            userId,
            sourceEntryId: null, // exclude personal-project mirror rows
            startedAt: { gte: start, lte: end },
        },
        select: { startedAt: true, durationSeconds: true },
    });
    const perDay = new Map();
    for (const e of entries) {
        const key = localDayKey(e.startedAt);
        perDay.set(key, (perDay.get(key) || 0) + (e.durationSeconds || 0));
    }
    const minSeconds = Number(minHoursPerDay) * 3600;
    let filledDays = 0;
    for (const secs of perDay.values()) {
        if (secs >= minSeconds) filledDays += 1;
    }
    return filledDays;
}

const MONTH_LABEL = (d) =>
    d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

// Build a human-readable preview of what the current cutoff resolves to,
// so the admin can see it lands on the right month / working-day count.
function policyPreview(policy) {
    const cycle = computeCycle(policy.cutoffDay || 24);
    return {
        month: MONTH_LABEL(cycle.periodStart),
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
        deadline: cycle.deadline,
        requiredDays: cycle.requiredDays,
    };
}

// GET /time/policy — admin reads the current policy + a live preview.
router.get('/policy', async (req, res, next) => {
    try {
        if (!isAdmin(req)) throw httpError(403, 'Admins only');
        const policy = await loadTimePolicy();
        res.json({ policy, preview: policyPreview(policy) });
    } catch (err) {
        next(err);
    }
});

// PUT /time/policy — admin saves the policy.
router.put('/policy', async (req, res, next) => {
    try {
        if (!isAdmin(req)) throw httpError(403, 'Admins only');
        const data = timePolicySchema.parse(req.body);
        const update = {};
        for (const k of [
            'enabled',
            'cutoffDay',
            'reminderLeadDays',
            'minHoursPerDay',
            'notify',
        ]) {
            if (data[k] !== undefined) update[k] = data[k];
        }
        update.updatedById = req.user.id;
        const saved = await prisma.timeLogPolicy.upsert({
            where: { id: TIME_POLICY_ID },
            update,
            create: { id: TIME_POLICY_ID, ...DEFAULT_TIME_POLICY, ...update },
        });
        res.json({ policy: saved, preview: policyPreview(saved) });
    } catch (err) {
        next(err);
    }
});

// GET /time/compliance — the current user's status against the policy.
// The frontend uses this to decide whether to show the daily reminder
// modal. When the policy has `notify` on and the user is short, we also
// drop an in-app notification (at most once per local day).
router.get('/compliance', async (req, res, next) => {
    try {
        const policy = await loadTimePolicy();
        const me = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { timeLogMandatory: true, lastTimeLogNotifiedOn: true },
        });
        const mandatory = Boolean(me?.timeLogMandatory);
        const applicable = Boolean(mandatory && policy.enabled);
        if (!applicable) {
            return res.json({
                applicable: false,
                mandatory,
                enabled: Boolean(policy.enabled),
                remind: false,
                compliant: true,
            });
        }

        const now = new Date();
        const cycle = computeCycle(policy.cutoffDay, now);
        const filledDays = await computeFilledDays(
            req.user.id,
            cycle.periodStart,
            cycle.periodEnd,
            policy.minHoursPerDay,
        );
        const requiredDays = cycle.requiredDays;
        const compliant = filledDays >= requiredDays;

        // Only nag inside the lead-up window before the deadline.
        const msLeft = cycle.deadline.getTime() - now.getTime();
        const daysUntilDeadline = Math.ceil(msLeft / 86400000);
        const inWindow =
            msLeft >= 0 &&
            daysUntilDeadline <= (policy.reminderLeadDays || 7);
        const remind = inWindow && !compliant;

        // Optional bell notification, deduped to one per local day.
        if (policy.notify && remind) {
            const todayKey = localDayKey(now);
            const lastKey = me?.lastTimeLogNotifiedOn
                ? localDayKey(me.lastTimeLogNotifiedOn)
                : null;
            if (lastKey !== todayKey) {
                try {
                    await notify({
                        recipientIds: [req.user.id],
                        actorId: null,
                        type: 'TIME_LOG_REMINDER',
                        title: 'Please fill your working log',
                        body: `You've logged ${filledDays} of ${requiredDays} working days for ${MONTH_LABEL(cycle.periodStart)}. It's due by ${cycle.deadline.toLocaleDateString()}.`,
                        link: '/time',
                    });
                    await prisma.user.update({
                        where: { id: req.user.id },
                        data: { lastTimeLogNotifiedOn: now },
                    });
                } catch (e) {
                    // Reminder is best-effort — never fail the status call.
                    console.warn(
                        '[time] could not send log reminder:',
                        e.message,
                    );
                }
            }
        }

        res.json({
            applicable: true,
            mandatory: true,
            enabled: true,
            remind,
            compliant,
            filledDays,
            requiredDays,
            minHoursPerDay: policy.minHoursPerDay,
            periodMonth: MONTH_LABEL(cycle.periodStart),
            periodStart: cycle.periodStart,
            periodEnd: cycle.periodEnd,
            deadline: cycle.deadline,
            daysUntilDeadline: Math.max(daysUntilDeadline, 0),
            shortBy: Math.max(requiredDays - filledDays, 0),
        });
    } catch (err) {
        next(err);
    }
});

router.post('/start', async (req, res, next) => {
    try {
        const data = startSchema.parse(req.body);
        const scope = await resolveScope(data);
        // Closed (DONE) projects can't accept new time entries from
        // regular users — billing for the period is already locked.
        // Admins / managers can still record retroactive time.
        await assertProjectWritable(req, scope.projectId, 'log time');
        await assertCanLogOnScope(req, scope);

        const now = new Date();
        // Auto-stop whatever was running so we never end up with two
        // live timers per user (the index assumes one).
        await stopUserTimers(req.user.id, now);

        const created = await prisma.timeEntry.create({
            data: {
                userId: req.user.id,
                projectId: scope.projectId,
                taskId: scope.taskId,
                startedAt: now,
                endedAt: null,
                durationSeconds: 0,
                description: data.description ?? null,
                source: 'TIMER',
            },
            include: entryInclude,
        });

        res.status(201).json({ entry: created });
    } catch (err) {
        next(err);
    }
});

router.post('/stop', async (req, res, next) => {
    try {
        const stopped = await stopUserTimers(req.user.id);
        // Audit every stopped entry so the activity feed reflects all
        // time the user just logged (in practice there's only one,
        // but stopUserTimers is defensive and supports many).
        for (const e of stopped) {
            await logTimeEntryAdded(e, req.user.id);
            // Mirror completed timer entries to any linked project.
            await syncMirror(e);
        }
        // Always return the most recently stopped entry (or null) so
        // the client can patch state in one round trip.
        const entry = stopped.length > 0 ? stopped[stopped.length - 1] : null;
        res.json({ entry });
    } catch (err) {
        next(err);
    }
});

router.post('/', async (req, res, next) => {
    try {
        const data = manualSchema.parse(req.body);
        const scope = await resolveScope(data);
        // Manual entries are gated the same as the live timer above:
        // closed projects don't accept new time from regular users.
        await assertProjectWritable(req, scope.projectId, 'log time');
        await assertCanLogOnScope(req, scope);
        // Logging on a task assigned to SOMEONE ELSE requires a reason
        // (helping / participating / …). Applies to everyone, admins
        // included. Own-task and project-level entries never need one.
        const isOthersTask = Boolean(
            scope.task &&
                scope.task.assigneeId &&
                scope.task.assigneeId !== req.user.id,
        );
        let crossUserReason = null;
        let crossUserNote = null;
        if (isOthersTask) {
            if (!data.crossUserReason) {
                throw httpError(
                    400,
                    'This task is assigned to someone else — pick a reason for logging time on it (or choose the correct task).',
                );
            }
            crossUserReason = data.crossUserReason;
            crossUserNote = data.crossUserNote ?? null;
        }
        const seconds = durationSecondsBetween(data.startedAt, data.endedAt);
        const created = await prisma.timeEntry.create({
            data: {
                userId: req.user.id,
                projectId: scope.projectId,
                taskId: scope.taskId,
                startedAt: data.startedAt,
                endedAt: data.endedAt,
                durationSeconds: seconds,
                description: data.description ?? null,
                crossUserReason,
                crossUserNote,
                source: 'MANUAL',
            },
            include: entryInclude,
        });
        await logTimeEntryAdded(created, req.user.id);
        // Mirror to linked project if this is a personal-project entry.
        await syncMirror(created);
        res.status(201).json({ entry: created });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        const existing = await loadEntryOr404(req.params.id);
        if (!existing) throw httpError(404, 'Time entry not found');
        if (!canMutateEntry(req, existing)) {
            throw httpError(
                403,
                'You can only edit your own time entries',
            );
        }
        // Closed projects lock retroactive edits for regular users —
        // billing for the period is presumed finalised. Admins /
        // managers still pass.
        await assertProjectWritable(
            req,
            existing.projectId,
            'edit this time entry',
        );
        const data = updateSchema.parse(req.body);
        const patch = {};
        // Resolve taskId / projectId together so they can't drift.
        if (data.taskId !== undefined) {
            if (data.taskId === null) {
                patch.taskId = null;
            } else {
                const task = await prisma.task.findUnique({
                    where: { id: data.taskId },
                    select: {
                        id: true,
                        projectId: true,
                        assigneeId: true,
                        parentTaskId: true,
                    },
                });
                if (!task) throw httpError(404, 'Task not found');
                if (task.projectId !== existing.projectId) {
                    throw httpError(
                        400,
                        'Task does not belong to this project',
                    );
                }
                await assertCanLogOnScope(req, {
                    projectId: existing.projectId,
                    taskId: task.id,
                    task,
                });
                patch.taskId = task.id;
            }
        }
        if (data.startedAt !== undefined) patch.startedAt = data.startedAt;
        if (data.endedAt !== undefined) patch.endedAt = data.endedAt;
        if (data.description !== undefined) {
            patch.description = data.description ?? null;
        }
        // Recompute the cached duration whenever timing changes.
        const nextStart = patch.startedAt ?? existing.startedAt;
        const nextEnd =
            patch.endedAt === undefined ? existing.endedAt : patch.endedAt;
        if (
            patch.startedAt !== undefined ||
            patch.endedAt !== undefined
        ) {
            patch.durationSeconds = durationSecondsBetween(
                nextStart,
                nextEnd,
            );
        }
        const updated = await prisma.timeEntry.update({
            where: { id: existing.id },
            data: patch,
            include: entryInclude,
        });
        // Keep the mirror in sync (no-op if entry is itself a mirror
        // or if the project isn't a linked personal project).
        await syncMirror(updated);
        res.json({ entry: updated });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const existing = await loadEntryOr404(req.params.id);
        if (!existing) throw httpError(404, 'Time entry not found');
        if (!canMutateEntry(req, existing)) {
            throw httpError(
                403,
                'You can only delete your own time entries',
            );
        }
        // Same lock as PATCH: closed projects refuse deletions from
        // regular users, admins / managers still pass.
        await assertProjectWritable(
            req,
            existing.projectId,
            'delete this time entry',
        );
        // Remove the mirror on the linked project first (if any).
        await deleteMirror(existing.id);
        await prisma.timeEntry.delete({ where: { id: existing.id } });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// -----------------------------------------------------------------------------
// Listing
// -----------------------------------------------------------------------------

// Normalise a `taskIds` query param into a unique non-empty string
// array. Accepts comma-separated strings ("a,b,c"), repeated query
// keys (?taskIds=a&taskIds=b — Express coerces this to an array
// automatically), or a single string. Returns null when nothing was
// supplied (so the caller can skip adding it to `where`).
function parseTaskIdsParam(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    let arr;
    if (Array.isArray(raw)) {
        arr = raw.flatMap((v) => String(v).split(','));
    } else {
        arr = String(raw).split(',');
    }
    const clean = Array.from(
        new Set(arr.map((s) => s.trim()).filter(Boolean)),
    );
    return clean.length > 0 ? clean : null;
}

// Pull common filters out of the query string. Returns a Prisma `where`
// fragment + the bookkeeping fields the route handler needs.
//
// `taskId` (singular) is kept for backward compatibility with the
// inline "log time on this task" callers; the newer multi-task filter
// in the Time tracking page sends `taskIds` (comma-separated). If both
// are supplied, the singular gets folded into the array and we use
// `where.taskId.in` so both code paths behave identically.
function parseListFilters(req) {
    const where = {};
    const { projectId, taskId, from, to } = req.query;
    if (projectId) where.projectId = String(projectId);
    const multi = parseTaskIdsParam(req.query.taskIds);
    if (multi || taskId) {
        const ids = new Set(multi || []);
        if (taskId) ids.add(String(taskId));
        const arr = Array.from(ids);
        if (arr.length === 1) {
            where.taskId = arr[0];
        } else {
            where.taskId = { in: arr };
        }
    }
    if (from || to) {
        where.startedAt = {};
        if (from) where.startedAt.gte = new Date(String(from));
        if (to) where.startedAt.lte = new Date(String(to));
    }
    const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1),
        500,
    );
    return { where, limit };
}

router.get('/me', async (req, res, next) => {
    try {
        const { where, limit } = parseListFilters(req);
        where.userId = req.user.id;
        // Exclude mirror entries — they're created automatically for the linked
        // project's benefit and would double-count the user's personal time.
        where.fromPersonalProjectId = null;
        const entries = await prisma.timeEntry.findMany({
            where,
            orderBy: { startedAt: 'desc' },
            take: limit,
            include: entryInclude,
        });
        res.json({ entries });
    } catch (err) {
        next(err);
    }
});

router.get('/', async (req, res, next) => {
    try {
        const { where, limit } = parseListFilters(req);
        await applyClientApplicationProjectFilter(where, req.query, req);

        const scopeEmpty = await finalizeTimeEntryProjectScope(where, req);
        if (scopeEmpty) {
            res.json({ entries: [] });
            return;
        }

        const requestedUserId = req.query.userId
            ? String(req.query.userId)
            : null;

        // Admins implicitly have a "see everything" view: if they don't
        // narrow by user, they get every entry on every project they
        // can see (which is, in practice, all of them). The /time page's
        // "All users" tab uses this. Non-admins with the explicit
        // `time:view:all` capability override get the same powers.
        const canSeeAllTimes =
            isAdmin(req) || hasCapability(req, CAPABILITIES.TIME_VIEW_ALL);
        if (canSeeAllTimes) {
            if (requestedUserId) where.userId = requestedUserId;
        } else if (requestedUserId && requestedUserId !== req.user.id) {
            // Non-admin asking for someone else's entries on a project
            // they can read — only allowed when they have visibility
            // into all entries on that specific project (manager-with-
            // read or the project owner).
            const projectIdForGate =
                typeof where.projectId === 'string'
                    ? where.projectId
                    : null;
            if (
                !projectIdForGate ||
                !(await canSeeAllOnProject(req, projectIdForGate))
            ) {
                throw httpError(
                    403,
                    "You do not have permission to view this user\u2019s time entries",
                );
            }
            where.userId = requestedUserId;
        } else if (
            // No explicit userId, non-admin caller. Default to their own
            // entries unless they have all-user visibility on the
            // specific project they asked for.
            !requestedUserId &&
            (typeof where.projectId !== 'string' ||
                !(await canSeeAllOnProject(req, where.projectId)))
        ) {
            where.userId = req.user.id;
        }

        const entries = await prisma.timeEntry.findMany({
            // Hide source entries that already have a mirror on a
            // shared project. The mirror is on the project the admin
            // is actually looking at — keeping BOTH would render
            // every personal-project log twice in the spreadsheet.
            // Sources without a mirror (legacy personal projects
            // that were created before the linked-project field was
            // mandatory) still pass through this filter, so nothing
            // disappears from the audit log. Wrapped in AND so we
            // don't clobber any OR/AND already inside `where`.
            where: {
                AND: [
                    where,
                    {
                        OR: [
                            // This row IS a mirror — keep it (it's
                            // the canonical shared-project entry).
                            { sourceEntryId: { not: null } },
                            // This row is NOT a mirror AND has no
                            // mirror referring back to it — keep it
                            // (regular shared-project entry, or
                            // a legacy personal entry without a
                            // linked parent).
                            { mirroredAs: { is: null } },
                        ],
                    },
                ],
            },
            orderBy: { startedAt: 'desc' },
            take: limit,
            include: entryInclude,
        });
        res.json({ entries });
    } catch (err) {
        next(err);
    }
});

// Workspace-wide stats for the Charts tab on /time.
//
// Returns six bucketed series + a total, all derived from the same
// scoped entry set the listing API uses. Defaults to the trailing 30
// days when no `from` / `to` is sent.
//
//   byDay        [{ date: 'YYYY-MM-DD', seconds }]   contiguous, fills empty days
//   byDayUser    [{ date, userId, seconds }]         per-day per-user; powers the
//                                                      stacked Daily Hours chart for admins
//   byDayProject [{ date, projectId, seconds }]      per-day per-project; powers
//                                                      the stacked Daily Hours chart
//                                                      for non-admin / single-user views
//   byProject    [{ projectId, code, name, seconds }] desc, top 10
//   byType       [{ projectTypeId, name, seconds }]   desc; null type as "Uncategorised"
//   byClient     [{ clientId, name, seconds }]         desc; admin charts
//   byApplication [{ applicationId, name, seconds }]   desc; admin charts
//   byUser       [{ userId, name, seconds }]          desc; non-admin: just themselves
//
// Query filters: `clientId`, `applicationId` (admin-only — narrows to
// projects linked to that client / application).
//
// Permissions match GET /api/time:
//   - Admin: workspace-wide. May narrow with `userId` / `projectId`.
//   - Non-admin: own entries only, across projects they can read.
router.get('/stats', async (req, res, next) => {
    try {
        const { projectId, from, to } = req.query;
        const requestedUserId = req.query.userId
            ? String(req.query.userId)
            : null;

        // Default window is the trailing 30 days so the charts have a
        // sensible shape on first paint.
        const now = new Date();
        const fromDate = from
            ? new Date(String(from))
            : new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
        const toDate = to ? new Date(String(to)) : now;
        // Snap to day bounds so partial-day filters still capture
        // entries that started/ended within them.
        fromDate.setHours(0, 0, 0, 0);
        toDate.setHours(23, 59, 59, 999);

        const where = {
            startedAt: { gte: fromDate, lte: toDate },
        };
        if (projectId) where.projectId = String(projectId);
        await applyClientApplicationProjectFilter(where, req.query, req);
        // Optional multi-task filter — same shape as the listing
        // endpoint. The user picks N tasks from a multi-select
        // dropdown in the Charts / All-users tabs; we constrain the
        // aggregation to entries on those tasks.
        const taskIds = parseTaskIdsParam(req.query.taskIds);
        if (taskIds) {
            where.taskId = taskIds.length === 1 ? taskIds[0] : { in: taskIds };
        }

        // Same access scoping as the listing endpoint.
        const canSeeAllTimes =
            isAdmin(req) || hasCapability(req, CAPABILITIES.TIME_VIEW_ALL);
        if (!canSeeAllTimes) {
            const scopeEmpty = await finalizeTimeEntryProjectScope(where, req, {
                canSeeAll: false,
            });
            if (scopeEmpty) {
                res.json({
                    byDay: [],
                    byDayUser: [],
                    byDayProject: [],
                    byProject: [],
                    byType: [],
                    byClient: [],
                    byApplication: [],
                    byUser: [],
                    total: 0,
                    range: { from: fromDate, to: toDate },
                });
                return;
            }
            where.userId = req.user.id;
        } else if (requestedUserId) {
            where.userId = requestedUserId;
        } else {
            const scopeEmpty = await finalizeTimeEntryProjectScope(where, req);
            if (scopeEmpty) {
                res.json({
                    byDay: [],
                    byDayUser: [],
                    byDayProject: [],
                    byProject: [],
                    byType: [],
                    byClient: [],
                    byApplication: [],
                    byUser: [],
                    total: 0,
                    range: { from: fromDate, to: toDate },
                });
                return;
            }
        }

        // Pull every entry in the window. Cap large workspaces so we
        // don't load the world; charts show "the recent picture" so 5k
        // is plenty for a month.
        const entries = await prisma.timeEntry.findMany({
            // Charts must NOT double-count personal-project sources
            // that have been mirrored to a shared project. Same anti-
            // double filter as /api/time admin view; AND-wrap so we
            // don't blow away any OR / AND inside `where`.
            where: {
                AND: [
                    where,
                    {
                        OR: [
                            { sourceEntryId: { not: null } }, // is mirror
                            { mirroredAs: { is: null } }, // no mirror exists
                        ],
                    },
                ],
            },
            select: {
                id: true,
                userId: true,
                projectId: true,
                startedAt: true,
                durationSeconds: true,
            },
            orderBy: { startedAt: 'asc' },
            take: 50000,
        });

        // ---- byDay ----
        const dayMap = new Map();
        const dayKey = (d) => {
            const dt = d instanceof Date ? d : new Date(d);
            return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        };
        // Pre-seed every date in [fromDate, toDate] so a quiet day still
        // renders a zero bar (a contiguous axis is much easier to read).
        const cursor = new Date(fromDate);
        cursor.setHours(0, 0, 0, 0);
        const endStop = new Date(toDate);
        endStop.setHours(0, 0, 0, 0);
        while (cursor.getTime() <= endStop.getTime()) {
            dayMap.set(dayKey(cursor), 0);
            cursor.setDate(cursor.getDate() + 1);
        }
        let total = 0;
        const projectMap = new Map();
        const userMap = new Map();
        // Per-day per-key buckets that power the new stacked Daily
        // Hours chart. Each entry contributes one second-count to the
        // (day, userId) and (day, projectId) cells.
        const dayUserMap = new Map(); // key = `${date}|${userId}`
        const dayProjectMap = new Map(); // key = `${date}|${projectId}`
        for (const e of entries) {
            const k = dayKey(e.startedAt);
            const sec = e.durationSeconds || 0;
            dayMap.set(k, (dayMap.get(k) || 0) + sec);
            total += sec;

            projectMap.set(
                e.projectId,
                (projectMap.get(e.projectId) || 0) + sec,
            );
            userMap.set(e.userId, (userMap.get(e.userId) || 0) + sec);

            const duKey = `${k}|${e.userId}`;
            dayUserMap.set(duKey, (dayUserMap.get(duKey) || 0) + sec);
            const dpKey = `${k}|${e.projectId}`;
            dayProjectMap.set(dpKey, (dayProjectMap.get(dpKey) || 0) + sec);
        }
        const byDay = Array.from(dayMap.entries()).map(([date, seconds]) => ({
            date,
            seconds,
        }));

        // ---- byProject (top 10) + byType ----
        const projectIds = Array.from(projectMap.keys()).filter(Boolean);
        const userIds = Array.from(userMap.keys()).filter(Boolean);

        const [projects, users] = await Promise.all([
            projectIds.length
                ? prisma.project.findMany({
                      where: { id: { in: projectIds } },
                      select: {
                          id: true,
                          name: true,
                          code: true,
                          client: true,
                          clientId: true,
                          applicationId: true,
                          clientRecord: { select: { id: true, name: true } },
                          application: { select: { id: true, name: true } },
                          projectType: { select: { id: true, name: true } },
                      },
                  })
                : [],
            userIds.length
                ? prisma.user.findMany({
                      where: { id: { in: userIds } },
                      select: {
                          id: true,
                          name: true,
                          email: true,
                          avatarUrl: true,
                      },
                  })
                : [],
        ]);
        const projectsById = new Map(projects.map((p) => [p.id, p]));
        const usersById = new Map(users.map((u) => [u.id, u]));

        const byProject = Array.from(projectMap.entries())
            .map(([id, seconds]) => {
                const p = projectsById.get(id);
                return {
                    projectId: id,
                    name: p?.name || 'Unknown project',
                    code: p?.code || null,
                    seconds,
                };
            })
            .sort((a, b) => b.seconds - a.seconds)
            .slice(0, 10);

        const typeMap = new Map();
        for (const [pid, seconds] of projectMap) {
            const p = projectsById.get(pid);
            const key = p?.projectType?.id || '__none__';
            const name = p?.projectType?.name || 'Uncategorised';
            const cur = typeMap.get(key) || { name, seconds: 0 };
            cur.seconds += seconds;
            cur.name = name;
            typeMap.set(key, cur);
        }
        const byType = Array.from(typeMap.entries())
            .map(([projectTypeId, v]) => ({
                projectTypeId: projectTypeId === '__none__' ? null : projectTypeId,
                name: v.name,
                seconds: v.seconds,
            }))
            .sort((a, b) => b.seconds - a.seconds);

        const clientMap = new Map();
        const applicationMap = new Map();
        for (const [pid, seconds] of projectMap) {
            const p = projectsById.get(pid);
            const clientKey =
                p?.clientId ||
                p?.clientRecord?.id ||
                (p?.client ? `name:${p.client}` : '__none__');
            const clientName =
                p?.clientRecord?.name || p?.client || 'No client';
            const clientCur = clientMap.get(clientKey) || {
                name: clientName,
                seconds: 0,
            };
            clientCur.seconds += seconds;
            clientCur.name = clientName;
            clientMap.set(clientKey, clientCur);

            const appKey = p?.applicationId || '__none__';
            const appName = p?.application?.name || 'No application';
            const appCur = applicationMap.get(appKey) || {
                name: appName,
                seconds: 0,
            };
            appCur.seconds += seconds;
            appCur.name = appName;
            applicationMap.set(appKey, appCur);
        }
        const byClient = Array.from(clientMap.entries())
            .map(([clientId, v]) => ({
                clientId: clientId.startsWith('name:') ? null : clientId,
                name: v.name,
                seconds: v.seconds,
            }))
            .sort((a, b) => b.seconds - a.seconds)
            .slice(0, 15);
        const byApplication = Array.from(applicationMap.entries())
            .map(([applicationId, v]) => ({
                applicationId:
                    applicationId === '__none__' ? null : applicationId,
                name: v.name,
                seconds: v.seconds,
            }))
            .sort((a, b) => b.seconds - a.seconds)
            .slice(0, 15);

        const byUser = Array.from(userMap.entries())
            .map(([id, seconds]) => {
                const u = usersById.get(id);
                return {
                    userId: id,
                    name: u?.name || u?.email || 'Unknown',
                    avatarUrl: u?.avatarUrl || null,
                    seconds,
                };
            })
            .sort((a, b) => b.seconds - a.seconds);

        // Flat per-day-per-key arrays. Frontend pivots into stacked
        // bar segments. Smaller payload than nesting and trivial to
        // sort/filter on the client.
        const byDayUser = Array.from(dayUserMap.entries()).map(([k, seconds]) => {
            const [date, userId] = k.split('|');
            return { date, userId, seconds };
        });
        const byDayProject = Array.from(dayProjectMap.entries()).map(
            ([k, seconds]) => {
                const [date, projectId] = k.split('|');
                return { date, projectId, seconds };
            },
        );

        res.json({
            byDay,
            byDayUser,
            byDayProject,
            byProject,
            byType,
            byClient,
            byApplication,
            byUser,
            total,
            entryCount: entries.length,
            range: { from: fromDate, to: toDate },
        });
    } catch (err) {
        next(err);
    }
});

// Project-scoped summary: total time + breakdowns by user and by task.
// Anyone with read access can call this; non-privileged callers see
// only their own totals (the per-user list is hidden).
router.get('/projects/:projectId/summary', async (req, res, next) => {
    try {
        const { projectId } = req.params;
        await assertProjectRead(req, projectId);
        const seeAll = await canSeeAllOnProject(req, projectId);

        const baseWhere = { projectId };
        // Range filter is optional. Without it we sum every entry the
        // caller may see; with it the totals correspond to the chart
        // window the client is rendering.
        if (req.query.from || req.query.to) {
            baseWhere.startedAt = {};
            if (req.query.from)
                baseWhere.startedAt.gte = new Date(String(req.query.from));
            if (req.query.to)
                baseWhere.startedAt.lte = new Date(String(req.query.to));
        }

        const ownWhere = { ...baseWhere, userId: req.user.id };

        const [totalAll, totalOwn, byUserRaw, byTaskRaw] = await Promise.all([
            seeAll
                ? prisma.timeEntry.aggregate({
                      where: baseWhere,
                      _sum: { durationSeconds: true },
                      _count: true,
                  })
                : Promise.resolve(null),
            prisma.timeEntry.aggregate({
                where: ownWhere,
                _sum: { durationSeconds: true },
                _count: true,
            }),
            seeAll
                ? prisma.timeEntry.groupBy({
                      by: ['userId'],
                      where: baseWhere,
                      _sum: { durationSeconds: true },
                  })
                : Promise.resolve([]),
            // By-task breakdown is useful even for non-privileged users,
            // scoped to their own entries.
            prisma.timeEntry.groupBy({
                by: ['taskId'],
                where: seeAll ? baseWhere : ownWhere,
                _sum: { durationSeconds: true },
            }),
        ]);

        // Hydrate user / task names for the leaderboards.
        const userIds = byUserRaw
            .map((r) => r.userId)
            .filter(Boolean);
        const taskIds = byTaskRaw
            .map((r) => r.taskId)
            .filter(Boolean);
        const [users, tasks] = await Promise.all([
            userIds.length
                ? prisma.user.findMany({
                      where: { id: { in: userIds } },
                      select: {
                          id: true,
                          name: true,
                          email: true,
                          avatarUrl: true,
                      },
                  })
                : [],
            taskIds.length
                ? prisma.task.findMany({
                      where: { id: { in: taskIds } },
                      select: {
                          id: true,
                          code: true,
                          title: true,
                          parentTaskId: true,
                      },
                  })
                : [],
        ]);
        const userMap = new Map(users.map((u) => [u.id, u]));
        const taskMap = new Map(tasks.map((t) => [t.id, t]));

        const byUser = byUserRaw
            .map((r) => ({
                user: userMap.get(r.userId) || { id: r.userId, name: 'Unknown' },
                seconds: r._sum.durationSeconds || 0,
            }))
            .sort((a, b) => b.seconds - a.seconds);

        const byTask = byTaskRaw
            .map((r) => ({
                task: r.taskId
                    ? taskMap.get(r.taskId) || {
                          id: r.taskId,
                          title: 'Removed task',
                      }
                    : null,
                seconds: r._sum.durationSeconds || 0,
            }))
            .sort((a, b) => b.seconds - a.seconds);

        res.json({
            seeAll,
            total: {
                seconds: totalAll
                    ? totalAll._sum.durationSeconds || 0
                    : totalOwn._sum.durationSeconds || 0,
                count: totalAll
                    ? totalAll._count || 0
                    : totalOwn._count || 0,
            },
            mine: {
                seconds: totalOwn._sum.durationSeconds || 0,
                count: totalOwn._count || 0,
            },
            byUser,
            byTask,
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/time/diagnostics
//   Returns a debug-style snapshot of the caller's time tracking
//   state: total entries / hours, running-timer flag, the earliest /
//   latest entry, a per-month bucket count, and any anomalies we can
//   detect cheaply (overlapping entries, zero-duration manual rows,
//   entries with no project, etc.). Surfaces in the Profile page
//   behind the Wrench debug button. Admin callers may pass
//   `?userId=…` to inspect another user.
router.get('/diagnostics', async (req, res, next) => {
    try {
        const targetUserId =
            req.query.userId && isAdmin(req)
                ? String(req.query.userId)
                : req.user.id;

        const entries = await prisma.timeEntry.findMany({
            // Exclude personal-project mirror rows. A mirror is an
            // auto-generated copy of a source entry on the linked
            // shared project with IDENTICAL timestamps — counting it
            // would double the totals and report a bogus "overlap"
            // between the source and its own mirror. Diagnostics should
            // reflect the time the user actually logged, so we only
            // look at originating entries (sourceEntryId = null).
            where: { userId: targetUserId, sourceEntryId: null },
            orderBy: { startedAt: 'asc' },
            select: {
                id: true,
                projectId: true,
                taskId: true,
                startedAt: true,
                endedAt: true,
                source: true,
            },
        });

        const totalEntries = entries.length;
        const running = entries.filter((e) => e.endedAt === null);
        let totalSeconds = 0;
        const monthBuckets = new Map();
        const issues = [];
        let earliest = null;
        let latest = null;
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (e.endedAt) {
                const seconds = Math.max(
                    0,
                    Math.floor(
                        (new Date(e.endedAt).getTime() -
                            new Date(e.startedAt).getTime()) /
                            1000,
                    ),
                );
                totalSeconds += seconds;
                if (seconds === 0 && e.source !== 'TIMER') {
                    issues.push({
                        id: e.id,
                        kind: 'zero_duration',
                        message:
                            'Manual entry has identical start and end timestamps.',
                    });
                }
                if (seconds > 12 * 3600) {
                    issues.push({
                        id: e.id,
                        kind: 'very_long',
                        message: `Entry is ${Math.round(seconds / 360) / 10}h long — exceeds the 12h sanity cap.`,
                    });
                }
                const d = new Date(e.startedAt);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                monthBuckets.set(key, (monthBuckets.get(key) || 0) + seconds);
            }
            if (!e.projectId) {
                issues.push({
                    id: e.id,
                    kind: 'orphan_project',
                    message: 'Entry is missing a projectId.',
                });
            }
            // Overlap detection: DISABLED for now. Colleagues typically
            // log their time at the end of the day rather than in real
            // time, so adjacent manual entries routinely "overlap" even
            // though the logged totals are correct. That produced a
            // constant stream of false-positive overlap issues with no
            // actionable meaning, so the check is commented out. The
            // logic is intentionally left here (not deleted) in case we
            // reintroduce real-time tracking later and want it back.
            //
            // if (i > 0) {
            //     const prev = entries[i - 1];
            //     if (
            //         prev.endedAt &&
            //         new Date(prev.endedAt).getTime() >
            //             new Date(e.startedAt).getTime()
            //     ) {
            //         issues.push({
            //             id: e.id,
            //             kind: 'overlap',
            //             message: `Overlaps with previous entry ending ${new Date(prev.endedAt).toISOString()}.`,
            //         });
            //     }
            // }
            if (!earliest || new Date(e.startedAt) < new Date(earliest)) {
                earliest = e.startedAt;
            }
            if (e.endedAt && (!latest || new Date(e.endedAt) > new Date(latest))) {
                latest = e.endedAt;
            }
        }

        res.json({
            userId: targetUserId,
            totalEntries,
            totalHours: Math.round((totalSeconds / 3600) * 100) / 100,
            runningCount: running.length,
            earliestStartedAt: earliest,
            latestEndedAt: latest,
            issues,
            byMonth: Array.from(monthBuckets.entries())
                .sort((a, b) => (a[0] < b[0] ? -1 : 1))
                .map(([month, seconds]) => ({
                    month,
                    seconds,
                    hours: Math.round((seconds / 3600) * 100) / 100,
                })),
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
