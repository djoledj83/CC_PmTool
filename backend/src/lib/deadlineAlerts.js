// Daily "deadline approaching" alerts.
//
// Each run:
//   1. Finds every non-DONE task with a dueDate inside our alert
//      windows (default: "<3 days" and "overdue").
//   2. For each task, computes the recipient set =
//        assignee  ∪  project.owner  ∪  project.reporter
//      (subtasks roll up to the same owner/reporter as their parent
//      project, so the rule is symmetric.)
//   3. Dedupes against `TaskDeadlineAlert` so we don't re-fire for a
//      (task, user, window) we've already alerted on. The window
//      changes if the deadline gets tighter (3-day → overdue), so we
//      DO re-fire then.
//   4. Inserts in-app notifications via the shared `notify()` helper
//      (also pushes them over socket.io) — but we hand-craft the
//      email path so each recipient gets ONE digest email per run
//      with every at-risk task they're attached to, instead of N
//      individual emails.
//
// Designed to be idempotent and cheap to call from a manual admin
// endpoint as well as from the once-a-day scheduler — re-running it
// within the same day is a no-op because of the dedupe table.

const prisma = require('./prisma');
const realtime = require('./realtime');
const { sendTemplate, appLink, APP_NAME } = require('./mailer');

// Window boundaries (in days from now). We compare `dueDate` to
// `now + days` to decide which bucket a task falls into. Order
// matters — the FIRST matching window wins (most urgent first), so
// once a task is "overdue" it stops also showing up as "<3 days".
const WINDOWS = [
    { days: 0, label: 'Overdue', urgency: 'overdue' },
    { days: 3, label: 'Due in less than 3 days', urgency: 'soon' },
];

// Maximum bucket we look at. Beyond this a task is too far out to
// alert on. Equals the largest `days` in WINDOWS above.
const FURTHEST_WINDOW_DAYS = WINDOWS.reduce((m, w) => Math.max(m, w.days), 0);

// Bucket a task's dueDate into one of WINDOWS, returning the matching
// entry or null if the task is outside our alert horizon.
function bucketize(dueDate, now = new Date()) {
    if (!dueDate) return null;
    const due = new Date(dueDate);
    const overdue = due.getTime() < now.getTime();
    if (overdue) return WINDOWS.find((w) => w.urgency === 'overdue') || null;
    const diffMs = due.getTime() - now.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    // Pick the tightest "due in less than X days" bucket that contains
    // diffDays. With WINDOWS = [overdue, 3] this is simply "<3 days".
    const candidate = WINDOWS.filter((w) => w.urgency !== 'overdue').find(
        (w) => diffDays < w.days,
    );
    return candidate || null;
}

// Format a day diff for human display. Returns strings like:
//   "tomorrow", "in 2 days", "today", "2 days ago", "yesterday".
function humanDelta(dueDate, now = new Date()) {
    if (!dueDate) return '';
    const due = new Date(dueDate);
    const ms = due.getTime() - now.getTime();
    const dayMs = 1000 * 60 * 60 * 24;
    const days = Math.round(ms / dayMs);
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    if (days > 1) return `in ${days} days`;
    return `${Math.abs(days)} days ago`;
}

// Format dueDate as "May 19, 2026 at 5:00 PM" without a date-fns dep
// — keeps this file self-contained.
function formatDue(dueDate) {
    if (!dueDate) return '';
    const d = new Date(dueDate);
    return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

// Returns the deep link the bell notification should navigate to.
// Mirrors how `notify.js` builds task links (`#task-<id>`) so the
// in-app highlight effect lights up the right row.
function taskLink(task) {
    if (!task?.projectId) return null;
    return `/projects/${task.projectId}#task-${task.id}`;
}

// Computes the set of user IDs who should be alerted for `task`.
// Pulls from:
//   - task.assigneeId (if any)
//   - task.project.ownerId
//   - task.project.reporterId
// Falls back gracefully when project owner/reporter is null.
function recipientsFor(task) {
    const ids = new Set();
    if (task.assigneeId) ids.add(task.assigneeId);
    if (task.project?.ownerId) ids.add(task.project.ownerId);
    if (task.project?.reporterId) ids.add(task.project.reporterId);
    return Array.from(ids);
}

// Pulls every non-DONE task with a dueDate within the alert horizon.
// We include the parent (project + assignee) so we can compute
// recipients and render the notification text without N+1 lookups.
async function fetchAtRiskTasks(now = new Date()) {
    const horizon = new Date(now.getTime() + FURTHEST_WINDOW_DAYS * 86_400_000);
    return prisma.task.findMany({
        where: {
            status: { not: 'DONE' },
            dueDate: { not: null, lt: horizon },
            // Limit to live projects — alerting on archived / deleted
            // workspaces is just noise.
            project: { status: { not: 'DONE' } },
        },
        include: {
            project: {
                select: {
                    id: true,
                    name: true,
                    code: true,
                    ownerId: true,
                    reporterId: true,
                    status: true,
                },
            },
            assignee: {
                select: { id: true, name: true },
            },
        },
        // A defensive ceiling — if a backlog of overdue tasks blows up,
        // we still finish in bounded time. Subsequent runs pick up the
        // remainder because the dedupe table doesn't grow until rows
        // are emitted.
        take: 5000,
    });
}

// Reads existing alerts for a candidate set so we can skip
// (task, user, window) triples we've already notified about.
async function fetchExistingAlerts(candidates) {
    if (candidates.length === 0) return new Map();
    const rows = await prisma.taskDeadlineAlert.findMany({
        where: {
            OR: candidates.map((c) => ({
                taskId: c.taskId,
                userId: c.userId,
                windowDays: c.windowDays,
            })),
        },
        select: { taskId: true, userId: true, windowDays: true },
    });
    const map = new Map();
    for (const r of rows) {
        map.set(`${r.taskId}|${r.userId}|${r.windowDays}`, true);
    }
    return map;
}

// Main entry point. Returns:
//   {
//     scannedTasks: number,
//     newAlerts:    number,   // rows inserted into TaskDeadlineAlert
//     notifications:number,   // bell notifications fanned out
//     emails:       number,   // digest emails sent
//   }
async function runDeadlineSweep({ now = new Date(), silent = false } = {}) {
    const log = silent ? () => {} : (...args) => console.log('[deadlines]', ...args);

    const tasks = await fetchAtRiskTasks(now);
    log(`scanning ${tasks.length} at-risk task(s)`);

    // Per-task: which window bucket and who should be alerted.
    const candidates = [];
    for (const task of tasks) {
        const bucket = bucketize(task.dueDate, now);
        if (!bucket) continue;
        const recipientIds = recipientsFor(task);
        if (recipientIds.length === 0) continue;
        for (const userId of recipientIds) {
            candidates.push({
                taskId: task.id,
                userId,
                windowDays: bucket.days,
                bucket,
                task,
            });
        }
    }

    if (candidates.length === 0) {
        log('no recipients to alert');
        return { scannedTasks: tasks.length, newAlerts: 0, notifications: 0, emails: 0 };
    }

    const existing = await fetchExistingAlerts(candidates);
    const fresh = candidates.filter(
        (c) => !existing.has(`${c.taskId}|${c.userId}|${c.windowDays}`),
    );

    if (fresh.length === 0) {
        log('every candidate has already been alerted for this window');
        return { scannedTasks: tasks.length, newAlerts: 0, notifications: 0, emails: 0 };
    }
    log(`will emit ${fresh.length} new alert(s)`);

    // Group by user — both for the digest email and for the dedupe
    // insert. We do the inserts INSIDE a transaction so we never end
    // up emitting bell notifications without also remembering we did.
    const byUser = new Map();
    for (const c of fresh) {
        if (!byUser.has(c.userId)) byUser.set(c.userId, []);
        byUser.get(c.userId).push(c);
    }

    // Fetch recipient profiles up front (one query) so we can decide
    // who gets an email and personalise the digest.
    const recipientUsers = await prisma.user.findMany({
        where: { id: { in: Array.from(byUser.keys()) } },
        select: {
            id: true,
            name: true,
            email: true,
            emailNotifications: true,
            status: true,
        },
    });
    const userMap = new Map(recipientUsers.map((u) => [u.id, u]));

    // 1) Persist dedupe rows + notifications in a single transaction
    //    per user. We DON'T put everything in one giant transaction
    //    because a transient failure for one user shouldn't roll back
    //    every other user's alerts.
    let totalNotifs = 0;
    const notificationsByUser = new Map();
    for (const [userId, items] of byUser.entries()) {
        const user = userMap.get(userId);
        if (!user || user.status !== 'ACTIVE') continue;

        try {
            await prisma.$transaction(async (tx) => {
                // Insert dedupe rows first. Use createMany with
                // `skipDuplicates` so we tolerate the (very unlikely
                // but possible) race of two sweeps running at once.
                await tx.taskDeadlineAlert.createMany({
                    data: items.map((it) => ({
                        taskId: it.taskId,
                        userId: it.userId,
                        windowDays: it.windowDays,
                    })),
                    skipDuplicates: true,
                });
                const createdNotifications = [];
                for (const it of items) {
                    const codePrefix = buildCodePrefix(it.task);
                    const title =
                        `${codePrefix}${it.bucket.urgency === 'overdue' ? 'Task overdue' : 'Task deadline approaching'}`;
                    const body = composeBellBody(it.task, it.bucket, now);
                    const notification = await tx.notification.create({
                        data: {
                            userId,
                            type: 'TASK_DUE_SOON',
                            title,
                            body,
                            link: taskLink(it.task),
                            projectId: it.task.projectId,
                            meta: {
                                taskId: it.task.id,
                                windowDays: it.windowDays,
                                urgency: it.bucket.urgency,
                                dueDate: it.task.dueDate,
                            },
                        },
                        include: {
                            actor: {
                                select: {
                                    id: true,
                                    name: true,
                                    email: true,
                                    avatarUrl: true,
                                },
                            },
                            project: {
                                select: { id: true, name: true, code: true },
                            },
                        },
                    });
                    createdNotifications.push(notification);
                }
                notificationsByUser.set(userId, createdNotifications);
                totalNotifs += createdNotifications.length;
            });
        } catch (err) {
            console.warn(
                `[deadlines] failed to persist alerts for user ${userId}:`,
                err.message,
            );
            notificationsByUser.delete(userId);
        }
    }

    // 2) Realtime push — fire-and-forget per user. Each notification
    //    already includes the `project` join so the bell renders it
    //    immediately without a follow-up fetch.
    for (const [userId, notifications] of notificationsByUser.entries()) {
        for (const n of notifications) {
            realtime.emitToUser(userId, 'notification:new', n);
        }
    }

    // 3) One digest email per user (if they accept email). We never
    //    block on these — failures are logged inside sendTemplate.
    let totalEmails = 0;
    for (const [userId, items] of byUser.entries()) {
        const user = userMap.get(userId);
        if (!user || user.status !== 'ACTIVE') continue;
        if (!user.emailNotifications || !user.email) continue;
        // Only email about items we actually persisted — if the
        // transaction for this user failed, skip the email too so the
        // recipient sees a consistent picture (bell + inbox match).
        if (!notificationsByUser.has(userId)) continue;
        sendDigest(user, items).catch((err) =>
            console.warn(`[deadlines] digest email to ${user.email} failed: ${err.message}`),
        );
        totalEmails += 1;
    }

    return {
        scannedTasks: tasks.length,
        newAlerts: fresh.length,
        notifications: totalNotifs,
        emails: totalEmails,
    };
}

// "[P-26-USA-0001 / T-0042] " — same shape `notify.js` produces.
function buildCodePrefix(task) {
    const projectCode = task?.project?.code || null;
    const taskCode = task?.code || null;
    if (projectCode && taskCode) return `[${projectCode} / ${taskCode}] `;
    if (projectCode) return `[${projectCode}] `;
    return '';
}

// One-liner shown in the bell notification body — gives just enough
// context to act on the alert without clicking through.
function composeBellBody(task, bucket, now) {
    const projectName = task?.project?.name || 'this project';
    const delta = humanDelta(task.dueDate, now);
    const due = formatDue(task.dueDate);
    if (bucket.urgency === 'overdue') {
        return `"${task.title}" in ${projectName} was due ${delta} (${due}).`;
    }
    return `"${task.title}" in ${projectName} is due ${delta} (${due}). Less than ${bucket.days} day${bucket.days === 1 ? '' : 's'} left.`;
}

// Builds and sends the digest email. Each user gets one message that
// lists every at-risk task they own / report on / are assigned to,
// grouped by urgency bucket so the most pressing ones surface first.
async function sendDigest(user, items) {
    const firstName = (user.name || '').split(/\s+/)[0] || 'there';
    const total = items.length;
    const overdue = items.filter((i) => i.bucket.urgency === 'overdue');
    const soon = items.filter((i) => i.bucket.urgency !== 'overdue');

    const subject = `[Deadlines] ${total} task${total === 1 ? '' : 's'} need your attention`;
    const heading =
        overdue.length > 0
            ? `${overdue.length} overdue, ${soon.length} due soon`
            : `${total} task${total === 1 ? '' : 's'} due in the next few days`;
    const intro = `Hi ${firstName}, here's a quick rundown of tasks crossing into the alert window today.`;

    // Plain-text body — readable in any client even when HTML is
    // blocked. The HTML version below is just a richer rendering of
    // the same content.
    const lines = [];
    if (overdue.length > 0) {
        lines.push('Overdue:');
        for (const it of overdue) {
            lines.push(`  • ${codeAndTitle(it.task)} — was due ${humanDelta(it.task.dueDate)} (${formatDue(it.task.dueDate)})`);
            lines.push(`      ${appLink(taskLink(it.task))}`);
        }
        lines.push('');
    }
    if (soon.length > 0) {
        lines.push('Due soon:');
        for (const it of soon) {
            lines.push(`  • ${codeAndTitle(it.task)} — due ${humanDelta(it.task.dueDate)} (${formatDue(it.task.dueDate)})`);
            lines.push(`      ${appLink(taskLink(it.task))}`);
        }
    }
    const bodyText = lines.join('\n');

    // Richer HTML — uses tables so it renders consistently in Gmail
    // and Outlook. Keeps inline styles only (mail clients strip
    // <style>). Two sections, each with rows = one task per line.
    const bodyHtml = [
        overdue.length > 0
            ? renderSection('Overdue', overdue, 'background:#fef2f2;color:#991b1b;')
            : '',
        soon.length > 0
            ? renderSection('Due soon', soon, 'background:#fffbeb;color:#92400e;')
            : '',
    ]
        .filter(Boolean)
        .join('');

    return sendTemplate({
        to: user.email,
        subject,
        heading,
        intro,
        bodyHtml,
        body: bodyText,
        footer: `You're receiving this because you own, report on, or are assigned to these tasks in ${APP_NAME}. Turn off email notifications in your profile settings to stop.`,
    });
}

function codeAndTitle(task) {
    const prefix = buildCodePrefix(task).trim();
    return prefix ? `${prefix} ${task.title}` : task.title;
}

function escape(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderSection(title, items, badgeStyle) {
    const rows = items
        .map((it) => {
            const url = appLink(taskLink(it.task));
            const projectName = it.task.project?.name || '';
            const dueWhen = `${humanDelta(it.task.dueDate)} — ${formatDue(it.task.dueDate)}`;
            return `<tr>
                <td style="padding:10px 12px;border-top:1px solid #e5e7eb;">
                    <div style="font-weight:600;color:#111;">
                        <a href="${escape(url)}" style="color:#2563eb;text-decoration:none;">${escape(codeAndTitle(it.task))}</a>
                    </div>
                    <div style="color:#6b7280;font-size:12px;margin-top:2px;">
                        ${escape(projectName)} · <span style="color:#374151;">${escape(dueWhen)}</span>
                    </div>
                </td>
            </tr>`;
        })
        .join('');
    return `<div style="margin:16px 0;">
        <div style="display:inline-block;padding:4px 10px;border-radius:9999px;font-size:11px;font-weight:600;${badgeStyle}">${escape(title)} (${items.length})</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border:1px solid #e5e7eb;border-radius:6px;border-collapse:separate;border-spacing:0;overflow:hidden;">
            ${rows}
        </table>
    </div>`;
}

// Schedules a daily sweep. Runs:
//   - 30s after boot (so we catch anything that crossed a threshold
//     while the server was down)
//   - once every 24h thereafter
//
// We deliberately skip a "real" cron expression — the sweep itself is
// cheap and idempotent (the dedupe table makes re-runs no-ops), so an
// approximate "once per day" is plenty.
function startDeadlineSweepScheduler() {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    setTimeout(() => {
        runDeadlineSweep()
            .then((stats) =>
                console.log(
                    `[deadlines] initial sweep: ${stats.newAlerts} new alerts, ${stats.notifications} notifications, ${stats.emails} emails`,
                ),
            )
            .catch((err) => console.error('[deadlines] initial sweep failed:', err));
    }, 30 * 1000).unref?.();

    setInterval(() => {
        runDeadlineSweep()
            .then((stats) =>
                console.log(
                    `[deadlines] sweep: ${stats.newAlerts} new alerts, ${stats.notifications} notifications, ${stats.emails} emails`,
                ),
            )
            .catch((err) => console.error('[deadlines] sweep failed:', err));
    }, ONE_DAY_MS).unref?.();
}

module.exports = {
    runDeadlineSweep,
    startDeadlineSweepScheduler,
    // Exported for tests / future tuning
    WINDOWS,
    bucketize,
};
