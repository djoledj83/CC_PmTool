// Who may see / be told about a ticket. Shared by the ticket routes, the
// realtime pings, pins and the auto-close sweep so the rules live in one
// place — and so EXTERNAL requesters (customers) only ever learn about
// tickets of their own organisation.
//
//   staff (any non-REQUESTER role)  → agent rules (see ticketScopeWhere)
//   internal requester (employee)   → every non-internal ticket + theirs
//   external requester (customer)   → NON-INTERNAL tickets only: all of
//                                     their organisation's, plus tickets
//                                     with no organisation they reported /
//                                     were added to / shared with. Never
//                                     another organisation's — not even
//                                     through an old share or participant
//                                     row, or after changing organisation.
const prisma = require('./prisma');
const realtime = require('./realtime');
const {
    isAdmin,
    isAdminOrHasCapability,
    hasCapability,
    CAPABILITIES,
} = require('./permissions');

const canManageTickets = (req) =>
    isAdminOrHasCapability(req, CAPABILITIES.TICKET_MANAGE);
const canViewAllTickets = (req) =>
    isAdmin(req) || hasCapability(req, CAPABILITIES.TICKET_VIEW_ALL);

const isRequester = (u) => u?.role === 'REQUESTER';

// Prisma WHERE for the tickets a caller may list / read.
function ticketScopeWhere(req) {
    if (canViewAllTickets(req)) return {};
    const me = req.user.id;
    if (canManageTickets(req)) {
        return {
            OR: [
                { assigneeId: me },
                { reporterId: me },
                { participants: { some: { userId: me } } },
                { shares: { some: { userId: me } } },
                // Restricted types are a private team queue: an allowed
                // agent sees ALL of that type's tickets (even taken ones).
                // Internal tickets stay private to their selected people.
                {
                    internal: false,
                    requestType: { agents: { some: { userId: me } } },
                },
                // Open (unassigned) tickets on an UNRESTRICTED type — no
                // request type, or a type with no allowed-agent list.
                { internal: false, assigneeId: null, requestTypeId: null },
                {
                    internal: false,
                    assigneeId: null,
                    requestType: { is: { agents: { none: {} } } },
                },
            ],
        };
    }
    // Customers (mirrors requesterCanSee): non-internal only — their
    // organisation's tickets, plus organisation-less ones they're on.
    if (req.user.external) {
        return {
            internal: false,
            OR: [
                ...(req.user.clientId ? [{ clientId: req.user.clientId }] : []),
                {
                    clientId: null,
                    OR: [
                        { reporterId: me },
                        { participants: { some: { userId: me } } },
                        { shares: { some: { userId: me } } },
                    ],
                },
            ],
        };
    }
    return {
        OR: [
            { internal: false },
            { reporterId: me },
            { participants: { some: { userId: me } } },
            { shares: { some: { userId: me } } },
        ],
    };
}

// Can this REQUESTER-side user see the ticket? (Staff have their own
// agent rules; this is for deciding who gets requester notifications.)
// `ticket` needs: internal, clientId, reporterId, participantIds, shareIds.
// Same order as loadVisibleTicket in routes/tickets.js.
function requesterCanSee(user, ticket) {
    if (!user || !ticket) return false;
    const isReporter = ticket.reporterId === user.id;
    const isShared = (ticket.shareIds || []).includes(user.id);
    const isParticipant = (ticket.participantIds || []).includes(user.id);
    if (user.external) {
        if (ticket.internal) return false;
        if (user.clientId && ticket.clientId === user.clientId) return true;
        return !ticket.clientId && (isReporter || isShared || isParticipant);
    }
    if (isReporter || isShared) return true;
    if (ticket.internal && !isParticipant) return false;
    return true;
}

// A customer = an EXTERNAL requester (a client organisation's user).
const isCustomer = (u) => isRequester(u) && Boolean(u?.external);

// May staff loop `target` into `ticket` (participant / share)? Anyone
// active — but a customer only ever joins NON-internal tickets of their
// own organisation (or tickets with no organisation set).
// `ticket` needs: internal, clientId. `target`: role, external, clientId,
// status.
function staffMayAddToTicket(target, ticket) {
    if (!target || (target.status && target.status !== 'ACTIVE')) return false;
    if (!isCustomer(target)) return true;
    if (!target.clientId) return false;
    if (ticket?.internal) return false;
    if (ticket?.clientId && ticket.clientId !== target.clientId) return false;
    return true;
}

// Which users the caller may add to a ticket (participants / "Share
// with"). Staff: anyone active (customers only on their own
// organisation's non-internal tickets — pass `ticket` {internal,
// clientId} to apply that). Internal requesters: staff and other
// internal requesters. External requesters: only colleagues of their
// own organisation.
function participantCandidateWhere(req, ticket = null) {
    if (canManageTickets(req)) {
        if (!ticket) return { status: 'ACTIVE' };
        const notCustomer = [{ role: { not: 'REQUESTER' } }, { external: false }];
        if (ticket.internal) return { status: 'ACTIVE', OR: notCustomer };
        if (ticket.clientId) {
            return {
                status: 'ACTIVE',
                OR: [...notCustomer, { clientId: ticket.clientId }],
            };
        }
        return {
            status: 'ACTIVE',
            OR: [...notCustomer, { clientId: { not: null } }],
        };
    }
    if (req.user.external) {
        return {
            status: 'ACTIVE',
            external: true,
            clientId: req.user.clientId || '__no_organisation__',
        };
    }
    return { status: 'ACTIVE', external: false };
}

// Deep link for a notification: requesters land on their portal page,
// everyone else in the workspace.
const portalTicketLink = (id) => `/portal/requests/${id}`;
const agentTicketLink = (id) => `/tickets?ticket=${id}`;
const ticketLinkFor = (user, id) =>
    isRequester(user) ? portalTicketLink(id) : agentTicketLink(id);

// Load what the audience rules need, from an id or a ticket row. Null
// when the ticket can't be loaded (callers then fail closed).
async function ticketAudienceInfo(ticketOrId) {
    const base =
        typeof ticketOrId === 'string' ? { id: ticketOrId } : ticketOrId || {};
    const hasAll =
        base.reporterId !== undefined &&
        base.internal !== undefined &&
        Array.isArray(base.participants) &&
        Array.isArray(base.shares);
    let row = hasAll ? base : null;
    if (!row && base.id) {
        row = await prisma.ticket
            .findUnique({
                where: { id: base.id },
                select: {
                    id: true,
                    internal: true,
                    clientId: true,
                    reporterId: true,
                    assigneeId: true,
                    participants: { select: { userId: true } },
                    shares: { select: { userId: true } },
                },
            })
            .catch(() => null);
    }
    if (!row) return null;
    return {
        id: row.id,
        internal: Boolean(row.internal),
        clientId: row.clientId || null,
        reporterId: row.reporterId || null,
        assigneeId: row.assigneeId || null,
        participantIds: (row.participants || []).map((p) => p.userId),
        shareIds: (row.shares || []).map((s) => s.userId),
    };
}

// Realtime ping limited to people who may see the ticket: all staff, the
// people on it who may still see it, and — for non-internal tickets —
// internal requesters and the ticket's organisation. `staffOnly` (e.g.
// an internal note) pings staff alone. Unknown ticket → staff only.
const STAFF_ONLY = { internal: true, clientId: null, userIds: [] };
async function emitTicketEvent(ticketOrId, event, payload, { staffOnly = false } = {}) {
    try {
        const t = staffOnly ? null : await ticketAudienceInfo(ticketOrId);
        if (!t) {
            realtime.emitToTicketAudience(STAFF_ONLY, event, payload);
            return;
        }
        const ids = Array.from(
            new Set(
                [t.reporterId, t.assigneeId, ...t.participantIds, ...t.shareIds].filter(Boolean),
            ),
        );
        const people = ids.length
            ? await prisma.user.findMany({
                  where: { id: { in: ids } },
                  select: { id: true, role: true, external: true, clientId: true },
              })
            : [];
        const userIds = people
            .filter((u) => !isRequester(u) || requesterCanSee(u, t))
            .map((u) => u.id);
        realtime.emitToTicketAudience(
            { internal: t.internal, clientId: t.clientId, userIds },
            event,
            payload,
        );
    } catch {
        /* realtime is best-effort */
    }
}

module.exports = {
    canManageTickets,
    canViewAllTickets,
    isRequester,
    isCustomer,
    ticketScopeWhere,
    requesterCanSee,
    staffMayAddToTicket,
    participantCandidateWhere,
    portalTicketLink,
    agentTicketLink,
    ticketLinkFor,
    ticketAudienceInfo,
    emitTicketEvent,
};
