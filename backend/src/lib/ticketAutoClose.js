// Auto-close for resolved tickets.
//
// When an agent sets a ticket to Resolved they can choose "close
// automatically after N days". The ticket stores autoCloseDays + the
// moment it's due (autoCloseAt); any other status — or a requester reply,
// which reopens it — clears both (routes/tickets.js). This sweep closes
// whatever is still Resolved once its time has come: status CLOSED, a
// timeline event (AUTO_CLOSED), an activity-feed row and a realtime ping
// so open views refresh. Runs shortly after boot (catching anything that
// fell due while the server was down) and then every few minutes.
const prisma = require('./prisma');
const { emitTicketEvent } = require('./ticketAccess');
const { logActivityEvent } = require('./activityLog');
const { notifyStatusChange } = require('./ticketStatusNotify');

const MAX_AUTO_CLOSE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const BATCH = 200;

// Ticket fields for "close N days from `now`" (days null/0 = don't).
function autoCloseFields(days, now = new Date()) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1) return { autoCloseDays: null, autoCloseAt: null };
    const d = Math.min(n, MAX_AUTO_CLOSE_DAYS);
    return { autoCloseDays: d, autoCloseAt: new Date(now.getTime() + d * DAY_MS) };
}

async function closeDueTickets(now = new Date()) {
    const due = await prisma.ticket.findMany({
        where: { status: 'RESOLVED', autoCloseAt: { not: null, lte: now } },
        select: {
            id: true,
            code: true,
            subject: true,
            type: true,
            projectId: true,
            reporterId: true,
            autoCloseDays: true,
        },
        orderBy: { autoCloseAt: 'asc' },
        take: BATCH,
    });
    let closed = 0;
    for (const t of due) {
        // Re-check in the write itself: if someone replied / changed the
        // status a moment ago, this matches nothing and we skip it.
        const res = await prisma.ticket.updateMany({
            where: {
                id: t.id,
                status: 'RESOLVED',
                autoCloseAt: { not: null, lte: now },
            },
            data: {
                status: 'CLOSED',
                closedAt: now,
                closedById: null,
                autoCloseAt: null,
                autoCloseDays: null,
            },
        });
        if (!res.count) continue;
        closed += 1;
        try {
            await prisma.ticketEvent.create({
                data: {
                    ticketId: t.id,
                    actorId: null,
                    kind: 'AUTO_CLOSED',
                    fromValue: t.autoCloseDays != null ? String(t.autoCloseDays) : null,
                    toValue: 'CLOSED',
                },
            });
        } catch {
            /* timeline is best-effort */
        }
        await logActivityEvent({
            type: 'TICKET_STATUS_CHANGED',
            actorId: null,
            projectId: t.projectId,
            message: t.subject,
            fromValue: 'RESOLVED',
            toValue: 'CLOSED',
            meta: {
                ticketId: t.id,
                ticketCode: t.code,
                ticketSubject: t.subject,
                ticketCategory: t.type,
                autoClosed: true,
                autoCloseDays: t.autoCloseDays ?? null,
            },
        });
        // Tell the requester side it closed by itself.
        await notifyStatusChange(t, {
            from: 'RESOLVED',
            to: 'CLOSED',
            actorId: null,
            autoCloseDays: t.autoCloseDays ?? null,
            auto: true,
        });
        // Ping only the people who may see this ticket.
        await emitTicketEvent(t.id, 'ticket:activity', { ticketId: t.id });
    }
    return { checked: due.length, closed };
}

async function runSweep() {
    try {
        const { closed } = await closeDueTickets();
        if (closed) console.log(`[tickets] auto-closed ${closed} resolved ticket(s)`);
    } catch (err) {
        console.error('[tickets] auto-close sweep failed:', err?.message || err);
    }
}

function startTicketAutoCloseSweeper() {
    setTimeout(runSweep, 20 * 1000).unref?.();
    setInterval(runSweep, SWEEP_INTERVAL_MS).unref?.();
}

module.exports = {
    MAX_AUTO_CLOSE_DAYS,
    autoCloseFields,
    closeDueTickets,
    startTicketAutoCloseSweeper,
};
