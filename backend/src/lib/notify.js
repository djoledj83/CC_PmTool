const prisma = require('./prisma');
const realtime = require('./realtime');
const { sendTemplate, appLink, APP_NAME } = require('./mailer');
const { pushToUsers } = require('./push');

// Notification types we never want to email about (chat is too chatty for
// inbox notifications by default).
const EMAIL_BLOCKLIST = new Set(['MESSAGE_RECEIVED']);

// Subject prefix mapped per notification type, so users can filter on it.
const SUBJECT_PREFIX = {
    PROJECT_CREATED: '[Project]',
    PROJECT_UPDATED: '[Project]',
    PROJECT_STATUS_CHANGED: '[Project]',
    PROJECT_OWNER_CHANGED: '[Project]',
    PROJECT_DELETED: '[Project]',
    TASK_CREATED: '[Task]',
    TASK_ASSIGNED: '[Task]',
    TASK_STATUS_CHANGED: '[Task]',
    TASK_DUE_DATE_CHANGED: '[Task]',
    NOTE_ADDED: '[Note]',
    FILE_UPLOADED: '[File]',
    MENTION: '[Mention]',
    USER_PENDING_APPROVAL: '[Admin]',
    USER_APPROVED: '[Account]',
    TASK_REASSIGN_PROPOSED: '[Reassign]',
    TASK_REASSIGN_APPROVED: '[Reassign]',
    TASK_REASSIGN_REJECTED: '[Reassign]',
};

const notificationInclude = {
    actor: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    // `code` lets the bell render the project's friendly identifier
    // alongside its name without a follow-up fetch.
    project: { select: { id: true, name: true, code: true } },
};

// Looks up the project + task codes for a notification and returns a
// label like "[P26-USA-0001 / T-0042] " ready to prepend to a title.
//
//   - Project + task   -> "[P26-USA-0001 / T-0042] "
//   - Project only     -> "[P26-USA-0001] "
//   - No projectId     -> ""  (e.g. a chat message — no project context)
//
// Falls back gracefully (returns "") on any lookup error so a bad
// prefix can never block sending the actual notification.
async function buildCodePrefix({ projectId, taskId }) {
    if (!projectId) return '';
    try {
        const [project, task] = await Promise.all([
            prisma.project.findUnique({
                where: { id: projectId },
                select: { code: true },
            }),
            taskId
                ? prisma.task.findUnique({
                      where: { id: taskId },
                      select: { code: true },
                  })
                : Promise.resolve(null),
        ]);
        const projectCode = project?.code || null;
        const taskCode = task?.code || null;
        if (projectCode && taskCode) {
            return `[${projectCode} / ${taskCode}] `;
        }
        if (projectCode) return `[${projectCode}] `;
        return '';
    } catch (err) {
        console.warn('[notify] buildCodePrefix failed:', err.message);
        return '';
    }
}

// Build the destination URL the bell should navigate to. We pick the
// most specific anchor available so a notification about "X added a
// note on task Y" lands the user on the note itself, not the task.
//
// Precedence (most specific wins):
//   1) explicit `link` override (caller passed `link: ...`)
//   2) chat conversation
//   3) change-request anchor — if meta carries a changeRequestId
//      then the activity belongs to a CR and the user should land
//      on the CR detail page (Plan or Notes tab) so the discussion
//      context is intact. Inside that CR URL we still surface
//      noteId / taskId as hash anchors — ChangeRequestDetail
//      mirrors ProjectDetail's hash routing.
//   4) note inside a project — note rows are unique enough that
//      they're a better target than the task they were pinned to,
//      and the Notes tab is where the actual content lives
//   5) task inside a project — for non-note events (creates, status
//      changes, reassignments, due-date changes …)
//   6) the Notes tab generally (`meta.tab === 'notes'`)
//   7) project root
//   8) nothing
function buildLink({ projectId, conversationId, meta }) {
    if (conversationId) return `/messages?c=${conversationId}`;
    if (!projectId) return null;
    const noteId = meta?.noteId;
    const taskId = meta?.taskId;
    const crId = meta?.changeRequestId;

    // CR-scoped routing (M4). Whenever the notification's meta
    // stamped a changeRequestId we keep the user inside the CR's
    // page so the "everything about this CR" context isn't lost —
    // landing them on the project Notes tab for a CR-pinned note
    // hides the CR connection. ChangeRequestDetail honours
    // #note-X (switches to Notes tab + spotlights row) and
    // #task-X (switches to Plan tab) the same way ProjectDetail
    // does, so the same hash format works for both URLs.
    const fileId = meta?.fileId;
    if (crId) {
        if (noteId) return `/projects/${projectId}/cr/${crId}#note-${noteId}`;
        if (fileId) return `/projects/${projectId}/cr/${crId}#file-${fileId}`;
        if (taskId) return `/projects/${projectId}/cr/${crId}#task-${taskId}`;
        if (meta?.tab === 'notes') return `/projects/${projectId}/cr/${crId}#notes`;
        if (meta?.tab === 'files') return `/projects/${projectId}/cr/${crId}#files`;
        return `/projects/${projectId}/cr/${crId}`;
    }

    if (noteId) return `/projects/${projectId}#note-${noteId}`;
    if (taskId) return `/projects/${projectId}#task-${taskId}`;
    if (meta?.tab === 'notes') return `/projects/${projectId}#notes`;
    return `/projects/${projectId}`;
}

// Returns the user IDs explicitly registered as participants on the project.
// This is the canonical "who should be notified" set.
async function projectParticipantIds(projectId) {
    if (!projectId) return [];
    const rows = await prisma.projectParticipant.findMany({
        where: { projectId },
        select: { userId: true },
    });
    return rows.map((r) => r.userId);
}

// Idempotently adds a user as a project participant and (if a chat room
// exists for the project) syncs them into ConversationParticipant so they
// can immediately read/write in the project chat. Safe to call repeatedly.
// `addedById` is the actor who triggered the membership.
async function ensureProjectParticipant(projectId, userId, addedById = null) {
    if (!projectId || !userId) return null;
    const existing = await prisma.projectParticipant.findUnique({
        where: { projectId_userId: { projectId, userId } },
    });
    if (existing) return existing;

    const created = await prisma.projectParticipant.create({
        data: { projectId, userId, addedById: addedById || null },
    });

    // If a chat room already exists for this project, mirror the membership.
    const conv = await prisma.conversation.findUnique({
        where: { projectId },
        select: { id: true },
    });
    if (conv) {
        await prisma.conversationParticipant.upsert({
            where: { conversationId_userId: { conversationId: conv.id, userId } },
            update: {},
            create: { conversationId: conv.id, userId },
        });
    }
    return created;
}

async function isProjectParticipant(projectId, userId) {
    if (!projectId || !userId) return false;
    const row = await prisma.projectParticipant.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { id: true },
    });
    return Boolean(row);
}

// Persist notifications for a list of recipients (excluding the actor) and
// push them out over the socket if they're online. Returns the created rows.
// `emailRecipientIds` lets a caller decouple the in-app fan-out from
// the email fan-out:
//   - undefined  → email every eligible bell recipient (default — old behaviour)
//   - []         → no emails at all (in-app only)
//   - [userId,…] → email only those user IDs (still subject to their
//                  emailNotifications toggle / ACTIVE status)
//
// Use cases:
//   • `emailRecipientIds: []` for task created / status / reassignment,
//     where the dedicated assignee-personal notification is the only
//     channel the assignee actually needs in their inbox.
//   • `emailRecipientIds: involved.filter(id => id !== assigneeId)`
//     to suppress the duplicate participant email for the assignee
//     when they're already getting the personalised version.
async function notify({
    recipientIds,
    actorId,
    type,
    title,
    body,
    projectId,
    conversationId,
    meta,
    link: linkOverride,
    emailRecipientIds,
}) {
    const recipients = Array.from(new Set((recipientIds || []).filter(Boolean))).filter(
        (id) => id !== actorId,
    );
    if (recipients.length === 0) return [];

    const link =
        linkOverride || buildLink({ projectId, conversationId, meta });

    // We always stamp conversationId into meta so that "clear notifications
    // when this chat is opened" works without needing to parse the link
    // string. Falls back to whatever the caller passed.
    const finalMeta = conversationId
        ? { ...(meta || {}), conversationId }
        : meta || undefined;

    // Prepend "[P26-USA-0001 / T-0042] " (or just project) so every
    // notification — bell + email — is unambiguous about which project /
    // task it came from. taskId lives in meta, set by every task-related
    // caller. Resolved once per notify() and reused for every recipient.
    const codePrefix = await buildCodePrefix({
        projectId,
        taskId: meta?.taskId || null,
    });
    const enrichedTitle =
        codePrefix && title ? `${codePrefix}${title}` : title;

    // createMany doesn't return rows on Postgres, so we create one-by-one to
    // get the records back. The volume here is small (handful of recipients).
    const created = await Promise.all(
        recipients.map((userId) =>
            prisma.notification.create({
                data: {
                    userId,
                    actorId: actorId || null,
                    type,
                    title: enrichedTitle,
                    body: body || null,
                    link,
                    projectId: projectId || null,
                    meta: finalMeta,
                },
                include: notificationInclude,
            }),
        ),
    );

    for (const n of created) {
        realtime.emitToUser(n.userId, 'notification:new', n);
    }

    // Mobile push fan-out (fire-and-forget). Each recipient's devices
    // get a push with the link + type in `data` so a tap can deep-link.
    pushToUsers(recipients, {
        title: enrichedTitle,
        body: body || '',
        data: { link, type, ...(finalMeta || {}) },
    }).catch((err) => console.warn('[notify] push fan-out failed:', err.message));

    // Apply the optional email filter. An explicit empty array means
    // "in-app only" (don't email anyone); undefined keeps the previous
    // "email every recipient" behaviour.
    let toEmail = created;
    if (Array.isArray(emailRecipientIds)) {
        const allowed = new Set(emailRecipientIds.filter(Boolean));
        toEmail = created.filter((n) => allowed.has(n.userId));
    }

    // Fire-and-forget email fan-out. We never await this because email
    // failures should never block the API response.
    if (toEmail.length > 0) {
        fanOutEmails(toEmail).catch((err) =>
            console.warn('[notify] email fan-out failed:', err.message),
        );
    }
    return created;
}

// For each persisted notification, fetch the recipient and (if they accept
// email) send a templated message. Skips chat (MESSAGE_RECEIVED) and any
// recipient who has opted out.
async function fanOutEmails(notifications) {
    if (!Array.isArray(notifications) || notifications.length === 0) return;

    const eligible = notifications.filter((n) => !EMAIL_BLOCKLIST.has(n.type));
    if (eligible.length === 0) return;

    const recipientIds = Array.from(new Set(eligible.map((n) => n.userId)));
    const recipients = await prisma.user.findMany({
        where: {
            id: { in: recipientIds },
            emailNotifications: true,
            // Don't email pending/suspended accounts (they can't act on it).
            status: 'ACTIVE',
        },
        select: { id: true, email: true, name: true },
    });
    const recipientMap = new Map(recipients.map((r) => [r.id, r]));

    for (const n of eligible) {
        const r = recipientMap.get(n.userId);
        if (!r || !r.email) continue;

        const subjectPrefix = SUBJECT_PREFIX[n.type] || '';
        const subject = subjectPrefix
            ? `${subjectPrefix} ${n.title}`
            : n.title;

        const intro = `Hi ${r.name?.split(' ')[0] || 'there'},`;
        const body = n.body || '';
        const ctaUrl = n.link ? appLink(n.link) : appLink('/');
        const ctaText = n.link ? 'Open in app' : `Go to ${APP_NAME}`;

        const projectLine = n.project?.name
            ? `Project: ${n.project.name}`
            : '';
        const composedBody = [body, projectLine].filter(Boolean).join('\n\n');

        sendTemplate({
            to: r.email,
            subject,
            heading: n.title,
            intro,
            body: composedBody,
            ctaText,
            ctaUrl,
            footer:
                'You can stop receiving these by turning off email notifications in your profile settings.',
        }).catch(() => {});
    }
}

// Fires an EXTRA, personalised notification just for the assignee of
// a task whenever something happens on that task (a note added, a
// status changed, a file uploaded, …). The point is to make the
// assignee's bell + inbox unmistakable about "this is YOUR task" even
// when they're already in the general project-participant broadcast.
//
// Behaviour:
//   - If the task has no assignee → no-op.
//   - If the assignee == actor → no-op (don't email yourself).
//   - Otherwise: one extra notification + one extra email titled
//     "Your task — <actor> <actionDescription>". Goes through the
//     normal notify() path, so it picks up the project/task code
//     prefix, the email fan-out, and the realtime push for free.
//
// `actionDescription` is a short verb phrase the caller supplies, e.g.
// "added a note to", "changed the due date of", "renamed". It gets
// dropped straight into the title and the body, so keep it lowercase
// and present-tense.
async function notifyAssigneePersonal({
    taskId,
    actorId,
    actorLabel,
    type,
    actionDescription,
    detail,
    projectId,
    meta,
    linkOverride,
}) {
    if (!taskId) return null;
    let task;
    try {
        task = await prisma.task.findUnique({
            where: { id: taskId },
            select: {
                id: true,
                title: true,
                assigneeId: true,
                projectId: true,
                parentTaskId: true,
            },
        });
    } catch (err) {
        console.warn('[notify] notifyAssigneePersonal lookup failed:', err.message);
        return null;
    }
    if (!task || !task.assigneeId) return null;
    if (task.assigneeId === actorId) return null;

    const actor = actorLabel || 'Someone';
    const noun = task.parentTaskId ? 'subtask' : 'task';
    const title = `Your ${noun} — ${actor} ${actionDescription}`;
    const detailLine = detail ? ` ${detail}` : '';
    const body = `Heads up: ${actor} ${actionDescription} "${task.title}".${detailLine}`;

    return notify({
        recipientIds: [task.assigneeId],
        actorId,
        type,
        title,
        body,
        projectId: projectId || task.projectId,
        meta: {
            ...(meta || {}),
            taskId: task.id,
            personalizedForAssignee: true,
        },
        link: linkOverride,
    });
}

// Match @<token> where token is a contiguous run of letters/digits/underscore/
// dot/dash. Resolves to user IDs by:
//   1) email local-part match (before "@"), case-insensitive
//   2) name first-word match, case-insensitive
// First user found wins, results deduped.
async function resolveMentionUserIds(text) {
    if (!text || typeof text !== 'string') return [];
    const tokens = Array.from(text.matchAll(/@([a-z0-9._-]+)/gi)).map((m) =>
        m[1].toLowerCase(),
    );
    const unique = Array.from(new Set(tokens));
    if (unique.length === 0) return [];

    const users = await prisma.user.findMany({
        select: { id: true, name: true, email: true },
    });

    const resolved = new Set();
    for (const token of unique) {
        const hit = users.find((u) => {
            const local = u.email.split('@')[0].toLowerCase();
            const firstName = (u.name || '').split(/\s+/)[0].toLowerCase();
            return (
                local === token ||
                firstName === token ||
                u.name?.toLowerCase().replace(/\s+/g, '') === token
            );
        });
        if (hit) resolved.add(hit.id);
    }
    return Array.from(resolved);
}

// Marks the user's chat notifications for a given conversation as read.
// Used by `POST /conversations/:id/read` so opening a chat instantly
// drops the bell badge for that thread. Returns { ids, unread } where
// `ids` are the notification IDs that just transitioned read=true and
// `unread` is the user's remaining unread total.
async function clearChatNotificationsForConversation(userId, conversationId) {
    if (!userId || !conversationId) return { ids: [], unread: 0 };

    // Find unread MESSAGE_RECEIVED notifications that point at this chat
    // (we stamp conversationId into meta when we create them).
    const candidates = await prisma.notification.findMany({
        where: {
            userId,
            read: false,
            type: 'MESSAGE_RECEIVED',
            // JSON path filter — Prisma exposes this for Postgres JSON cols.
            meta: { path: ['conversationId'], equals: conversationId },
        },
        select: { id: true },
    });
    const ids = candidates.map((c) => c.id);
    if (ids.length) {
        await prisma.notification.updateMany({
            where: { id: { in: ids } },
            data: { read: true, readAt: new Date() },
        });
    }
    const unread = await prisma.notification.count({
        where: { userId, read: false },
    });
    if (ids.length) {
        // Tell every tab the user has open to remove these from the bell.
        realtime.emitToUser(userId, 'notifications:cleared', {
            ids,
            unread,
            reason: 'conversation-opened',
            conversationId,
        });
    }
    return { ids, unread };
}

// Marks the user's unread ticket notifications for a given ticket as
// read — called when they open the ticket so the "new activity"
// highlight on the list clears. Mirrors clearChatNotificationsForConversation.
async function clearTicketNotificationsForTicket(userId, ticketId) {
    if (!userId || !ticketId) return { ids: [], unread: 0 };
    const candidates = await prisma.notification.findMany({
        where: {
            userId,
            read: false,
            type: { in: ['TICKET_CREATED', 'TICKET_COMMENT', 'TICKET_ASSIGNED'] },
            meta: { path: ['ticketId'], equals: ticketId },
        },
        select: { id: true },
    });
    const ids = candidates.map((c) => c.id);
    if (ids.length) {
        await prisma.notification.updateMany({
            where: { id: { in: ids } },
            data: { read: true, readAt: new Date() },
        });
    }
    const unread = await prisma.notification.count({
        where: { userId, read: false },
    });
    if (ids.length) {
        realtime.emitToUser(userId, 'notifications:cleared', {
            ids,
            unread,
            reason: 'ticket-opened',
            ticketId,
        });
    }
    return { ids, unread };
}

// Returns the set of ticket ids (from the given list) that have at least
// one UNREAD ticket notification for this user — i.e. "new activity you
// haven't looked at". Used to bold/flag rows in the ticket lists.
async function ticketsWithUnreadActivity(userId, ticketIds) {
    const empty = new Set();
    if (!userId || !ticketIds || ticketIds.length === 0) return empty;
    const rows = await prisma.notification.findMany({
        where: {
            userId,
            read: false,
            type: { in: ['TICKET_CREATED', 'TICKET_COMMENT', 'TICKET_ASSIGNED'] },
        },
        select: { meta: true },
    });
    const wanted = new Set(ticketIds);
    const out = new Set();
    for (const r of rows) {
        const tid = r.meta?.ticketId;
        if (tid && wanted.has(tid)) out.add(tid);
    }
    return out;
}

// Pushes the current pending-user count to every active admin's socket so
// the Users sidebar badge stays in sync across browsers / accounts. Call
// this whenever the pending count could have changed.
async function broadcastPendingUserCount() {
    const [admins, pending] = await Promise.all([
        prisma.user.findMany({
            where: { role: 'ADMIN', status: 'ACTIVE' },
            select: { id: true },
        }),
        prisma.user.count({ where: { status: 'PENDING' } }),
    ]);
    for (const a of admins) {
        realtime.emitToUser(a.id, 'users:pending-count', { pending });
    }
    return pending;
}

module.exports = {
    notify,
    notifyAssigneePersonal,
    projectParticipantIds,
    ensureProjectParticipant,
    isProjectParticipant,
    resolveMentionUserIds,
    broadcastPendingUserCount,
    clearChatNotificationsForConversation,
    clearTicketNotificationsForTicket,
    ticketsWithUnreadActivity,
};
