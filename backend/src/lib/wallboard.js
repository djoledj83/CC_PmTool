// Wallboards — a big-screen ticket board that runs without signing in
// (e.g. a TV in the support room). Access is the secret key in the board's
// link (/wallboard/<key>); admins create, pause, regenerate and delete
// links under Templates → Tickets → Wallboards.
//
// What a board shows is deliberately small: UNRESOLVED (New / In progress
// / Pending), NON-INTERNAL tickets
// with code, title, ticket type, category, priority, status, age and who
// is handling it — no descriptions, clients, requesters or ids.
const crypto = require('crypto');
const prisma = require('./prisma');

// Every status that isn't Resolved / Closed ("Open" is retired).
const OPEN_STATUSES = ['NEW', 'IN_PROGRESS', 'PENDING'];
const KEY_RE = /^[A-Za-z0-9_-]{20,80}$/;
const MAX_TICKETS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

// 192 random bits, URL-safe.
const newWallboardKey = () => crypto.randomBytes(24).toString('base64url');

// The board behind a key, if the key is well-formed and the board active.
async function findActiveWallboard(key) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
    const board = await prisma.wallboard.findUnique({ where: { key } });
    return board && board.active ? board : null;
}

// "Today" starts at the screen's local midnight (sent by the board as
// ?since=); anything odd falls back to the last 24 hours.
function windowStart(since, now = new Date()) {
    const d = since ? new Date(String(since)) : null;
    if (d && !Number.isNaN(d.getTime())) {
        const age = now.getTime() - d.getTime();
        if (age >= 0 && age <= 2 * DAY_MS) return d;
    }
    return new Date(now.getTime() - DAY_MS);
}

const TICKET_SELECT = {
    code: true,
    subject: true,
    status: true,
    priority: true,
    type: true,
    createdAt: true,
    updatedAt: true,
    assigneeId: true,
    assignee: { select: { name: true } },
    requestType: { select: { name: true, icon: true, color: true } },
};

async function wallboardData({ since } = {}) {
    const now = new Date();
    const from = windowStart(since, now);
    const openWhere = { internal: false, status: { in: OPEN_STATUSES } };
    const [rows, open, unassigned, urgent, newToday, resolved] = await Promise.all([
        prisma.ticket.findMany({
            where: openWhere,
            select: TICKET_SELECT,
            orderBy: { createdAt: 'desc' },
            take: MAX_TICKETS,
        }),
        prisma.ticket.count({ where: openWhere }),
        prisma.ticket.count({ where: { ...openWhere, assigneeId: null } }),
        prisma.ticket.count({ where: { ...openWhere, priority: 'URGENT' } }),
        prisma.ticket.count({ where: { internal: false, createdAt: { gte: from } } }),
        prisma.ticketEvent.findMany({
            where: {
                createdAt: { gte: from },
                kind: { in: ['STATUS_CHANGED', 'AUTO_CLOSED'] },
                toValue: { in: ['RESOLVED', 'CLOSED'] },
                ticket: { is: { internal: false, deletedAt: null } },
            },
            select: { ticketId: true },
            distinct: ['ticketId'],
        }),
    ]);
    return {
        now: now.toISOString(),
        since: from.toISOString(),
        counters: {
            open,
            newToday,
            unassigned,
            urgent,
            resolvedToday: resolved.length,
        },
        tickets: rows.map((t) => ({
            code: t.code,
            title: t.subject,
            status: t.status,
            priority: t.priority,
            category: t.type,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            handler: t.assigneeId ? t.assignee?.name || 'Someone' : null,
            requestType: t.requestType
                ? {
                      name: t.requestType.name,
                      icon: t.requestType.icon || null,
                      color: t.requestType.color || null,
                  }
                : null,
        })),
    };
}

module.exports = {
    OPEN_STATUSES,
    newWallboardKey,
    findActiveWallboard,
    windowStart,
    wallboardData,
};
