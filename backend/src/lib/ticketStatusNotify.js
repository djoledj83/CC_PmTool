// Tell the requester side when their ticket's status changes in a way
// they should know about: Pending (often waiting on them), Resolved (and
// when it will close by itself), Closed, or reopened. Goes to the
// reporter and the requester-side participants — never the actor — with
// the link that opens the right view for each (portal / workspace).
// Best-effort: a notification failure never blocks the status change.
const prisma = require('./prisma');
const { notify } = require('./notify');
const { ticketLinkFor } = require('./ticketAccess');

const DONE = new Set(['RESOLVED', 'CLOSED']);
const LABELS = { PENDING: 'Pending', RESOLVED: 'Resolved', CLOSED: 'Closed' };

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

// The message for a change, or null when it isn't worth a notification
// (e.g. New → In progress, which the "being handled" notice covers).
function statusNotice({ from, to, autoCloseDays = null, auto = false }) {
    const reopened = DONE.has(from) && !DONE.has(to);
    if (reopened) {
        return { label: 'Reopened', body: 'Reopened — the team is working on it again.' };
    }
    if (from === to || !LABELS[to]) return null;
    if (to === 'RESOLVED') {
        return {
            label: LABELS[to],
            body: autoCloseDays
                ? `Resolved — it closes automatically in ${days(autoCloseDays)} unless you reply.`
                : 'Resolved — not fixed? Reply and it reopens.',
        };
    }
    if (to === 'CLOSED') {
        return {
            label: LABELS[to],
            body: auto
                ? `Closed automatically — there was no reply ${autoCloseDays ? `within ${days(autoCloseDays)} ` : ''}after it was resolved.`
                : 'Closed.',
        };
    }
    return {
        label: LABELS[to],
        body: 'Pending — the team is waiting, often for information from you.',
    };
}

async function notifyStatusChange(ticket, { from, to, actorId = null, autoCloseDays = null, auto = false }) {
    try {
        const notice = statusNotice({ from, to, autoCloseDays, auto });
        if (!notice || !ticket?.id) return 0;
        const participantRows = await prisma.ticketParticipant.findMany({
            where: { ticketId: ticket.id },
            select: { userId: true },
        });
        const ids = Array.from(
            new Set([ticket.reporterId, ...participantRows.map((p) => p.userId)].filter(Boolean)),
        );
        if (!ids.length) return 0;
        const people = await prisma.user.findMany({
            where: { id: { in: ids }, status: 'ACTIVE' },
            select: { id: true, role: true },
        });
        // The reporter (whatever their role) + requester-side participants.
        const recipients = people.filter(
            (u) => u.id !== actorId && (u.id === ticket.reporterId || u.role === 'REQUESTER'),
        );
        for (const u of recipients) {
            await notify({
                recipientIds: [u.id],
                actorId,
                type: 'TICKET_STATUS_CHANGED',
                title: `${ticket.code}: ${notice.label.toLowerCase()}`,
                body: `${ticket.subject ? `“${ticket.subject}” — ` : ''}${notice.body}`,
                projectId: ticket.projectId || null,
                link: ticketLinkFor(u, ticket.id),
                meta: { ticketId: ticket.id, status: to },
            });
        }
        return recipients.length;
    } catch {
        return 0;
    }
}

module.exports = { statusNotice, notifyStatusChange };
