// Ticketing module — phase 1 (in-app).
//
// API surface (mounted at /api/tickets):
//   GET    /api/tickets              -> list tickets in the caller's scope
//   POST   /api/tickets              -> open a ticket (needs ticket:create)
//   GET    /api/tickets/:id          -> one ticket + its conversation
//   PATCH  /api/tickets/:id          -> status / priority / type / assignee
//                                       (needs ticket:manage — "agent")
//   POST   /api/tickets/:id/messages -> add a reply or internal note
//
// Access model:
//   - REQUESTER / regular user: sees and comments on its OWN tickets.
//     Replies are stored as INBOUND. Never sees INTERNAL notes.
//   - Agent (ticket:manage, default ADMIN + MANAGER): can answer
//     (OUTBOUND), post INTERNAL notes, assign, and change status. Sees
//     all tickets for projects they can access; with ticket:view:all
//     (or ADMIN) sees the whole queue.
//
// Email ingestion is out of scope here — every ticket created via this
// route is source = IN_APP.

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    isAdmin,
    isAdminOrHasCapability,
    hasCapability,
    accessibleProjectIds,
    CAPABILITIES,
} = require('../lib/permissions');
const { generateTicketCode } = require('../lib/codes');
const {
    notify,
    clearTicketNotificationsForTicket,
    ticketsWithUnreadActivity,
} = require('../lib/notify');
const { logActivityEvent } = require('../lib/activityLog');
const {
    ticketFileUpload,
    fileUrl,
    withSignedUrl,
    removeFileSafe,
} = require('../lib/upload');
const realtime = require('../lib/realtime');
const { sanitizeRichText } = require('../lib/sanitizeHtml');

const router = express.Router();
router.use(requireAuth);

// Image attachments live ~2 months before the sweeper removes them.
const TICKET_IMAGE_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

const TicketStatus = z.enum([
    'NEW',
    'OPEN',
    'IN_PROGRESS',
    'PENDING',
    'RESOLVED',
    'CLOSED',
]);
const TicketPriority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const TicketType = z.enum(['INCIDENT', 'REQUEST', 'QUESTION', 'PROBLEM']);

const createSchema = z.object({
    subject: z.string().trim().min(1).max(200),
    description: z.string().trim().max(10000).optional().nullable(),
    // Requesters DON'T pick a project — a resolver assigns it later, so
    // projectId is optional. Agents may still pass one when opening.
    projectId: z.string().min(1).optional().nullable(),
    requestTypeId: z.string().min(1).optional(),
    type: TicketType.optional(),
    priority: TicketPriority.optional(),
    // Optional co-requesters to add as participants at open time, either
    // as individual user ids or whole requester-group ids.
    participantIds: z.array(z.string()).optional(),
    groupIds: z.array(z.string()).optional(),
    // Agents can open a private (internal) ticket; requesters always
    // create external ones (the flag is ignored unless they can manage).
    internal: z.boolean().optional(),
    // Custom-field values captured from the admin-defined fields.
    clientId: z.string().min(1).optional().nullable(),
    terminalModelId: z.string().min(1).optional().nullable(),
    fieldValues: z
        .array(z.object({ fieldId: z.string(), value: z.any() }))
        .optional()
        .nullable(),
});

const patchSchema = z.object({
    // subject/description are editable by the reporter (until taken) and
    // by agents; the rest are agent-only.
    subject: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(10000).optional().nullable(),
    status: TicketStatus.optional(),
    priority: TicketPriority.optional(),
    type: TicketType.optional(),
    // Resolver can (re)assign the ticket's project.
    projectId: z.string().min(1).optional(),
    // null clears the assignee; a string sets it.
    assigneeId: z.string().min(1).optional().nullable(),
});

const messageSchema = z.object({
    // Body may be empty when the message carries only attachment(s) —
    // the frontend uploads files against the new message id right after
    // creating it, so an attach-only comment posts an empty body first.
    body: z.string().trim().max(10000).optional(),
    internal: z.boolean().optional(),
});

const logTimeSchema = z
    .object({
        startedAt: z.coerce.date(),
        endedAt: z.coerce.date(),
        note: z.string().trim().max(2000).optional().nullable(),
    })
    .refine((v) => v.endedAt.getTime() > v.startedAt.getTime(), {
        message: 'End must be after start.',
        path: ['endedAt'],
    });

// Capability helpers ---------------------------------------------------
const canManage = (req) =>
    isAdminOrHasCapability(req, CAPABILITIES.TICKET_MANAGE);
const canViewAll = (req) =>
    isAdmin(req) || hasCapability(req, CAPABILITIES.TICKET_VIEW_ALL);

const TICKET_INCLUDE = {
    project: { select: { id: true, name: true, code: true } },
    client: { select: { id: true, name: true } },
    terminalModel: {
        select: {
            id: true,
            name: true,
            osType: true,
            vendor: { select: { id: true, name: true } },
        },
    },
    reporter: { select: { id: true, name: true, email: true, avatarUrl: true } },
    assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
    requestType: {
        select: {
            id: true,
            name: true,
            icon: true,
            color: true,
            agents: { select: { userId: true } },
        },
    },
};

// Append a timeline event. Non-fatal: a logging failure must never block
// the action that triggered it.
async function logTicketEvent(ticketId, actorId, kind, fromValue, toValue) {
    try {
        await prisma.ticketEvent.create({
            data: {
                ticketId,
                actorId: actorId || null,
                kind,
                fromValue: fromValue ?? null,
                toValue: toValue ?? null,
            },
        });
    } catch {
        /* ignore */
    }
}

// Resolve a set of user ids from explicit participant ids + requester
// group ids. Only active users are kept. Returns a deduped array.
async function resolveParticipantUserIds(participantIds, groupIds) {
    const ids = new Set((participantIds || []).filter(Boolean));
    if (groupIds && groupIds.length) {
        const members = await prisma.requesterGroupMember.findMany({
            where: { groupId: { in: groupIds } },
            select: { userId: true },
        });
        for (const m of members) ids.add(m.userId);
    }
    if (ids.size === 0) return [];
    const users = await prisma.user.findMany({
        where: { id: { in: Array.from(ids) }, status: 'ACTIVE' },
        select: { id: true },
    });
    return users.map((u) => u.id);
}

// Ids of everyone watching a ticket (besides reporter / assignee).
async function ticketParticipantIds(ticketId) {
    const rows = await prisma.ticketParticipant.findMany({
        where: { ticketId },
        select: { userId: true },
    });
    return rows.map((r) => r.userId);
}

// Notification deep-links differ by role: the requester lands on their
// portal request, everyone else (agents / watchers) on the workspace.
const portalTicketLink = (id) => `/portal/requests/${id}`;
const agentTicketLink = (id) => `/tickets?ticket=${id}`;

// First non-empty line of the ticket's own description, trimmed for a
// list preview. NOT the request type's blurb — the actual content the
// requester typed.
function descriptionPreview(desc) {
    if (!desc) return null;
    const line = desc
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean);
    if (!line) return null;
    return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

function forList(t) {
    return {
        id: t.id,
        code: t.code,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        type: t.type,
        source: t.source,
        internal: t.internal ?? false,
        project: t.project,
        requestType: t.requestType
            ? {
                  id: t.requestType.id,
                  name: t.requestType.name,
                  icon: t.requestType.icon,
                  color: t.requestType.color,
              }
            : null,
        reporter: t.reporter,
        assignee: t.assignee,
        client: t.client ?? null,
        terminalModel: t.terminalModel ?? null,
        fieldValues: Array.isArray(t.fieldValues) ? t.fieldValues : [],
        descriptionPreview: descriptionPreview(t.description),
        messageCount: t._count?.messages ?? undefined,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
    };
}

// Build the WHERE that scopes which tickets a caller may list/read.
//   - view-all (admin) -> everything
//   - agent            -> the OPEN queue (unassigned) + tickets assigned
//                         to them, ones they're a participant on, and
//                         ones they reported. A ticket taken by another
//                         agent disappears unless you're invited.
//   - otherwise        -> only their own (reporter)
async function scopeWhere(req) {
    if (canViewAll(req)) return {};
    const me = req.user.id;
    if (canManage(req)) {
        return {
            OR: [
                { assigneeId: me },
                { reporterId: me },
                { participants: { some: { userId: me } } },
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
    // External requesters are scoped to their organisation: they see only
    // non-internal tickets they reported, ones tagged to their client
    // (organisation), or ones they were explicitly invited to.
    if (req.user.external) {
        return {
            internal: false,
            OR: [
                { reporterId: me },
                ...(req.user.clientId
                    ? [{ clientId: req.user.clientId }]
                    : []),
                { participants: { some: { userId: me } } },
            ],
        };
    }
    // Internal requesters (our employees) get the shared queue: every
    // non-internal ticket, plus internal ones they reported or are on.
    return {
        OR: [
            { internal: false },
            { reporterId: me },
            { participants: { some: { userId: me } } },
        ],
    };
}

// GET /api/tickets ------------------------------------------------------
router.get('/', async (req, res, next) => {
    try {
        const where = await scopeWhere(req);
        const {
            status,
            projectId,
            assigneeId,
            q,
            type,
            requestTypeId,
            internal,
            userId,
            reporterId,
        } = req.query;
        // status / type accept a single value or a comma-separated list
        // (the checkbox filters send "NEW,OPEN" etc).
        const asList = (v) =>
            String(v)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        if (status) {
            const list = asList(status);
            if (list.length === 1) where.status = list[0];
            else if (list.length > 1) where.status = { in: list };
        }
        if (type) {
            const list = asList(type);
            if (list.length === 1) where.type = list[0];
            else if (list.length > 1) where.type = { in: list };
        }
        // Filter by request type (the named portal type, e.g. "SoftPOS").
        // Accepts a single id or a comma-separated list.
        if (requestTypeId) {
            const list = asList(requestTypeId);
            if (list.length === 1) where.requestTypeId = list[0];
            else if (list.length > 1) where.requestTypeId = { in: list };
        }
        // Internal (agent-raised) vs external (requester-raised) tickets.
        // '1'/'true' = internal only, '0'/'false' = external only.
        if (internal === '1' || internal === 'true') where.internal = true;
        else if (internal === '0' || internal === 'false')
            where.internal = false;
        if (projectId) {
            const pid = String(projectId);
            // Project "Tickets" tab: anyone who can read the project sees
            // EVERY ticket on it, not just the ones personally scoped to
            // them. Drop the personal OR-scope in that case.
            const canSeeProjectTickets =
                canViewAll(req) ||
                (await accessibleProjectIds(req)).includes(pid);
            if (canSeeProjectTickets) delete where.OR;
            where.projectId = pid;
        }
        if (assigneeId === 'me') where.assigneeId = req.user.id;
        else if (assigneeId) where.assigneeId = String(assigneeId);
        // "My tickets" = tickets the caller opened (reporter).
        if (reporterId === 'me') where.reporterId = req.user.id;
        else if (reporterId) where.reporterId = String(reporterId);
        // Filter by a person involved (reporter or assignee) — admin's
        // "by user" filter.
        if (userId) {
            where.AND = [
                ...(where.AND || []),
                {
                    OR: [
                        { reporterId: String(userId) },
                        { assigneeId: String(userId) },
                    ],
                },
            ];
        }
        if (q && String(q).trim()) {
            const term = String(q).trim();
            where.AND = [
                ...(where.AND || []),
                {
                    OR: [
                        { subject: { contains: term, mode: 'insensitive' } },
                        { code: { contains: term, mode: 'insensitive' } },
                    ],
                },
            ];
        }
        const tickets = await prisma.ticket.findMany({
            where,
            include: { ...TICKET_INCLUDE, _count: { select: { messages: true } } },
            // Latest activity first — updatedAt is bumped on every new
            // message and on status/assignment changes, so tickets that
            // just had action float to the top.
            orderBy: { updatedAt: 'desc' },
            take: 500,
        });
        // Flag rows with unread activity (a ticket notification the caller
        // hasn't opened yet) so the list can bold / dot them.
        const unreadSet = await ticketsWithUnreadActivity(
            req.user.id,
            tickets.map((t) => t.id),
        );
        // Which of these tickets has the caller pinned (reuses UserPin).
        const pinRows = await prisma.userPin.findMany({
            where: {
                userId: req.user.id,
                kind: 'TICKET',
                refId: { in: tickets.map((t) => t.id) },
            },
            select: { refId: true },
        });
        const pinnedSet = new Set(pinRows.map((p) => p.refId));
        res.json({
            tickets: tickets.map((t) => ({
                ...forList(t),
                unread: unreadSet.has(t.id),
                pinned: pinnedSet.has(t.id),
            })),
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/tickets -----------------------------------------------------
router.post('/', async (req, res, next) => {
    try {
        if (!isAdminOrHasCapability(req, CAPABILITIES.TICKET_CREATE)) {
            throw httpError(403, 'You cannot open tickets.');
        }
        const data = createSchema.parse(req.body);

        // The requester picks the project. The request type (if any) is
        // just a classification now — we only read its default priority,
        // never its project.
        let requestType = null;
        if (data.requestTypeId) {
            requestType = await prisma.ticketRequestType.findUnique({
                where: { id: data.requestTypeId },
                select: {
                    id: true,
                    active: true,
                    defaultPriority: true,
                    agents: { select: { userId: true } },
                },
            });
            if (!requestType || !requestType.active) {
                throw httpError(400, 'Request type not available.');
            }
            // External requesters may only raise types their organisation
            // (client) is allowed to use.
            if (req.user.external) {
                const allowed = req.user.clientId
                    ? await prisma.clientTicketType.findUnique({
                          where: {
                              clientId_requestTypeId: {
                                  clientId: req.user.clientId,
                                  requestTypeId: requestType.id,
                              },
                          },
                          select: { clientId: true },
                      })
                    : null;
                if (!allowed) {
                    throw httpError(
                        403,
                        'Your organisation cannot raise this request type.',
                    );
                }
            } else if (req.user.role === 'REQUESTER') {
                // Internal requesters may only raise their granted types.
                const allowed = await prisma.userTicketType.findUnique({
                    where: {
                        userId_requestTypeId: {
                            userId: req.user.id,
                            requestTypeId: requestType.id,
                        },
                    },
                    select: { userId: true },
                });
                if (!allowed) {
                    throw httpError(
                        403,
                        'You cannot raise this request type.',
                    );
                }
            }
        }
        // Project is optional now. If one was passed (an agent opening a
        // ticket, say) verify it exists; requesters leave it null and a
        // resolver assigns it later.
        if (data.projectId) {
            const project = await prisma.project.findUnique({
                where: { id: data.projectId },
                select: { id: true },
            });
            if (!project) throw httpError(400, 'Selected project not found.');
        }

        // Resolve + validate the admin-defined custom fields (global +
        // this request type's). Required ones are enforced for requesters;
        // agents opening a ticket may leave them and fill in later.
        const fieldDefs = await prisma.ticketFieldDef.findMany({
            where: {
                active: true,
                OR: [
                    { requestTypeId: null },
                    ...(requestType ? [{ requestTypeId: requestType.id }] : []),
                ],
            },
        });
        if (data.clientId) {
            const c = await prisma.client.findUnique({
                where: { id: data.clientId },
                select: { id: true },
            });
            if (!c) throw httpError(400, 'Selected client not found.');
        }
        if (data.terminalModelId) {
            const m = await prisma.terminalModel.findUnique({
                where: { id: data.terminalModelId },
                select: { id: true },
            });
            if (!m) throw httpError(400, 'Selected terminal model not found.');
        }
        const provided = new Map(
            (data.fieldValues || []).map((v) => [v.fieldId, v.value]),
        );
        const enforce = !canManage(req);
        // Requesters' client is their own organisation (auto-tagged), so a
        // required Client field is satisfied by that even if not sent.
        const effectiveClientId = canManage(req)
            ? data.clientId || null
            : req.user.clientId || data.clientId || null;
        const missing = [];
        const cleanValues = [];
        for (const d of fieldDefs) {
            if (d.type === 'TERMINAL') {
                if (enforce && d.required && !data.terminalModelId)
                    missing.push(d.label);
            } else if (d.type === 'CLIENT') {
                if (enforce && d.required && !effectiveClientId)
                    missing.push(d.label);
            } else if (d.type === 'YESNO') {
                const val = provided.get(d.id);
                const has = typeof val === 'boolean';
                if (enforce && d.required && !has) missing.push(d.label);
                if (has) {
                    cleanValues.push({
                        fieldId: d.id,
                        label: d.label,
                        type: 'YESNO',
                        value: Boolean(val),
                    });
                }
            } else {
                const val = provided.get(d.id);
                const has =
                    d.type === 'SELECT'
                        ? Array.isArray(val) && val.length > 0
                        : typeof val === 'string' && val.trim().length > 0;
                if (enforce && d.required && !has) missing.push(d.label);
                if (has) {
                    cleanValues.push({
                        fieldId: d.id,
                        label: d.label,
                        type: d.type,
                        value: d.type === 'SELECT' ? val : String(val).trim(),
                    });
                }
            }
        }
        if (missing.length) {
            throw httpError(400, `Please fill in: ${missing.join(', ')}.`);
        }

        const code = await generateTicketCode(prisma);
        const ticket = await prisma.ticket.create({
            data: {
                code,
                subject: data.subject,
                description: data.description || null,
                projectId: data.projectId || null,
                requestTypeId: requestType ? requestType.id : null,
                // Requesters' tickets are auto-tagged to their own
                // organisation so their colleagues can see them; agents
                // pick the client explicitly.
                clientId: effectiveClientId,
                terminalModelId: data.terminalModelId || null,
                fieldValues: cleanValues.length ? cleanValues : null,
                // Only agents can mark a ticket internal.
                internal: canManage(req) ? Boolean(data.internal) : false,
                reporterId: req.user.id,
                type: data.type || 'REQUEST',
                priority:
                    data.priority ||
                    requestType?.defaultPriority ||
                    'NORMAL',
                status: 'NEW',
                source: 'IN_APP',
            },
            include: { ...TICKET_INCLUDE, _count: { select: { messages: true } } },
        });
        await logTicketEvent(ticket.id, req.user.id, 'CREATED', null, null);

        // Co-requesters chosen at open time (individuals + groups) become
        // participants. The reporter is dropped (they're already on it).
        try {
            const coIds = (
                await resolveParticipantUserIds(
                    data.participantIds,
                    data.groupIds,
                )
            ).filter((uid) => uid !== req.user.id);
            if (coIds.length) {
                await prisma.ticketParticipant.createMany({
                    data: coIds.map((userId) => ({
                        ticketId: ticket.id,
                        userId,
                        addedById: req.user.id,
                    })),
                    skipDuplicates: true,
                });
            }
        } catch {
            /* non-fatal */
        }

        await logActivityEvent({
            type: 'TICKET_CREATED',
            actorId: req.user.id,
            projectId: ticket.projectId,
            message: ticket.subject,
            meta: {
                ticketId: ticket.id,
                ticketCode: ticket.code,
                ticketSubject: ticket.subject,
                ticketCategory: ticket.type,
            },
        });

        // Notify the agent pool that a new ticket is in the queue. For a
        // restricted type, only the allowed agents are notified (they're
        // the only ones who can see it); otherwise every active
        // non-requester user. notify() drops the actor automatically.
        // Best-effort — never block the create on a notification failure.
        try {
            const allowedAgentIds = (requestType?.agents || []).map(
                (a) => a.userId,
            );
            let recipientIds;
            if (allowedAgentIds.length > 0) {
                recipientIds = allowedAgentIds;
            } else {
                const agents = await prisma.user.findMany({
                    where: { role: { not: 'REQUESTER' }, status: 'ACTIVE' },
                    select: { id: true },
                });
                recipientIds = agents.map((a) => a.id);
            }
            await notify({
                recipientIds,
                actorId: req.user.id,
                type: 'TICKET_CREATED',
                title: `New ticket: ${ticket.code}`,
                body: `${ticket.subject} — opened by ${req.user.name || req.user.email || 'a requester'}`,
                projectId: ticket.projectId,
                // Deep-link straight to the ticket (was just '/tickets',
                // which only opened the list). Recipients here are always
                // agents (the non-requester pool), so the workspace link
                // opens the ticket modal directly.
                link: agentTicketLink(ticket.id),
                meta: { ticketId: ticket.id },
            });
        } catch {
            /* non-fatal */
        }

        res.status(201).json({ ticket: forList(ticket) });
    } catch (err) {
        next(err);
    }
});

// GET /api/tickets/projects -------------------------------------------
// The list of projects a ticket can be filed against. Requesters have no
// PM project access, so this returns every project (minimal fields) to
// anyone who can open or manage tickets — the picker on the portal.
// Declared before /:id so "projects" isn't read as a ticket id.
router.get('/projects', async (req, res, next) => {
    try {
        if (
            !isAdminOrHasCapability(req, CAPABILITIES.TICKET_CREATE) &&
            !canManage(req)
        ) {
            throw httpError(403, 'Not allowed.');
        }
        const projects = await prisma.project.findMany({
            select: { id: true, name: true, code: true },
            orderBy: { name: 'asc' },
        });
        res.json({ projects });
    } catch (err) {
        next(err);
    }
});

// GET /api/tickets/stats ----------------------------------------------
// Dashboard data. Every agent gets a `mine` block (tickets assigned to
// them + the shared unassigned queue count). Admins / view-all holders
// also get a workspace-wide `workspace` block. Aggregated in JS — ticket
// volume is low enough that one scan is fine. Declared before /:id.
router.get('/stats', async (req, res, next) => {
    try {
        // Open to everyone: agents get assigned-to-me stats, requesters
        // get reported-by-me stats (the portal statistics tab).
        const agent = canManage(req);
        // Admins / view-all holders can scope the "mine" block to another
        // user (the Insights "Viewing" picker). Everyone else only sees
        // their own.
        const me =
            canViewAll(req) && req.query.userId
                ? String(req.query.userId)
                : req.user.id;
        // Optional reporting window (?from / ?to, ISO). Filters the counts
        // to tickets CREATED in that period; the 30-day mini-trend below
        // stays a fixed window.
        const parseDate = (v) => {
            if (!v) return null;
            const d = new Date(String(v));
            return Number.isNaN(d.getTime()) ? null : d;
        };
        const fromDate = parseDate(req.query.from);
        const toDate = parseDate(req.query.to);
        const createdWindow =
            fromDate || toDate
                ? {
                      ...(fromDate ? { gte: fromDate } : {}),
                      ...(toDate ? { lte: toDate } : {}),
                  }
                : null;
        // Optional Team filter (?teamId) — tickets belonging to that team.
        const teamId = req.query.teamId ? String(req.query.teamId) : null;
        const teamWhere = teamId ? { teamId } : {};
        // "My tickets": agents = assigned to me; requesters = opened by me.
        const mineWhere = {
            ...(agent ? { assigneeId: me } : { reporterId: me }),
            ...(createdWindow ? { createdAt: createdWindow } : {}),
            ...teamWhere,
        };
        const RESOLVED = new Set(['RESOLVED', 'CLOSED']);
        const now = Date.now();
        const D30 = now - 30 * 24 * 60 * 60 * 1000;
        const tally = (obj, key) => {
            obj[key] = (obj[key] || 0) + 1;
        };
        const topN = (obj, n = 8) =>
            Object.entries(obj)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, n);

        // ── Mine ──────────────────────────────────────────────────
        const mineRows = await prisma.ticket.findMany({
            where: mineWhere,
            select: { status: true, createdAt: true, closedAt: true },
        });
        const mineByStatus = {};
        let mineOpen = 0;
        let mineResolved = 0;
        let mineResolvedLast30 = 0;
        let mineResSum = 0;
        let mineResCount = 0;
        for (const t of mineRows) {
            tally(mineByStatus, t.status);
            if (RESOLVED.has(t.status)) {
                mineResolved += 1;
                if (t.closedAt) {
                    mineResSum +=
                        (new Date(t.closedAt) - new Date(t.createdAt)) / 1000;
                    mineResCount += 1;
                    if (new Date(t.closedAt).getTime() >= D30)
                        mineResolvedLast30 += 1;
                }
            } else {
                mineOpen += 1;
            }
        }
        const unassignedQueue = await prisma.ticket.count({
            where: { assigneeId: null, status: { notIn: ['RESOLVED', 'CLOSED'] } },
        });
        const payload = {
            mine: {
                open: mineOpen,
                resolved: mineResolved,
                resolvedLast30: mineResolvedLast30,
                byStatus: mineByStatus,
                avgResolutionSeconds: mineResCount
                    ? Math.round(mineResSum / mineResCount)
                    : null,
                unassignedQueue,
            },
        };

        // ── Workspace ─────────────────────────────────────────────
        // Admins / view-all holders, AND requesters (who have a shared
        // queue over every ticket) get the workspace-wide block.
        if (canViewAll(req) || !agent) {
            const all = await prisma.ticket.findMany({
                where: {
                    ...(createdWindow ? { createdAt: createdWindow } : {}),
                    ...teamWhere,
                },
                select: {
                    id: true,
                    code: true,
                    subject: true,
                    status: true,
                    priority: true,
                    type: true,
                    createdAt: true,
                    closedAt: true,
                    assigneeId: true,
                    clientId: true,
                    project: { select: { name: true } },
                    assignee: { select: { name: true } },
                    client: { select: { id: true, name: true } },
                },
            });
            const byStatus = {};
            const byPriority = {};
            const byCategory = {};
            const byProject = {};
            const byAssignee = {};
            const byClient = {};
            const createdByDay = {};
            const resolvedByDay = {};
            let open = 0;
            let resolved = 0;
            let unassigned = 0;
            let resSum = 0;
            let resCount = 0;
            for (const t of all) {
                tally(byStatus, t.status);
                tally(byPriority, t.priority);
                tally(byCategory, t.type);
                tally(byProject, t.project?.name || '—');
                if (t.clientId) tally(byClient, t.client?.name || '—');
                if (!t.assigneeId) unassigned += 1;
                else tally(byAssignee, t.assignee?.name || '—');
                if (RESOLVED.has(t.status)) {
                    resolved += 1;
                    if (t.closedAt) {
                        resSum +=
                            (new Date(t.closedAt) - new Date(t.createdAt)) /
                            1000;
                        resCount += 1;
                    }
                } else {
                    open += 1;
                }
                if (new Date(t.createdAt).getTime() >= D30) {
                    tally(
                        createdByDay,
                        new Date(t.createdAt).toISOString().slice(0, 10),
                    );
                }
                if (t.closedAt && new Date(t.closedAt).getTime() >= D30) {
                    tally(
                        resolvedByDay,
                        new Date(t.closedAt).toISOString().slice(0, 10),
                    );
                }
            }
            const trend = [];
            for (let i = 29; i >= 0; i -= 1) {
                const key = new Date(now - i * 86400000)
                    .toISOString()
                    .slice(0, 10);
                trend.push({
                    date: key,
                    created: createdByDay[key] || 0,
                    resolved: resolvedByDay[key] || 0,
                });
            }
            // ── Phase timing (event-driven) ──────────────────────────
            // Pull the status/assignment history for these tickets so we
            // can measure: time-to-first-assignment ("open → taken"),
            // time-to-resolution ("open → resolved"), and how long each
            // still-open ticket has been sitting in its current phase.
            const ticketIds = all.map((t) => t.id);
            const events = ticketIds.length
                ? await prisma.ticketEvent.findMany({
                      where: {
                          ticketId: { in: ticketIds },
                          kind: { in: ['ASSIGNED', 'STATUS_CHANGED'] },
                      },
                      select: {
                          ticketId: true,
                          kind: true,
                          toValue: true,
                          createdAt: true,
                      },
                      orderBy: { createdAt: 'asc' },
                  })
                : [];
            const evByTicket = new Map();
            for (const e of events) {
                let rec = evByTicket.get(e.ticketId);
                if (!rec) {
                    rec = {
                        firstAssigned: null,
                        lastStatusAt: null,
                        firstResolved: null,
                    };
                    evByTicket.set(e.ticketId, rec);
                }
                const at = new Date(e.createdAt).getTime();
                if (e.kind === 'ASSIGNED') {
                    if (rec.firstAssigned == null) rec.firstAssigned = at;
                } else if (e.kind === 'STATUS_CHANGED') {
                    // events are asc → the last write is the current phase.
                    rec.lastStatusAt = at;
                    if (
                        rec.firstResolved == null &&
                        (e.toValue === 'RESOLVED' || e.toValue === 'CLOSED')
                    ) {
                        rec.firstResolved = at;
                    }
                }
            }
            const allById = new Map(all.map((t) => [t.id, t]));
            let takenSum = 0;
            let takenCount = 0;
            let o2rSum = 0;
            let o2rCount = 0;
            for (const [tid, rec] of evByTicket) {
                const t = allById.get(tid);
                if (!t) continue;
                const created = new Date(t.createdAt).getTime();
                if (rec.firstAssigned) {
                    takenSum += (rec.firstAssigned - created) / 1000;
                    takenCount += 1;
                }
                if (rec.firstResolved) {
                    o2rSum += (rec.firstResolved - created) / 1000;
                    o2rCount += 1;
                }
            }
            // Per-ticket time in current phase (open tickets only — exclude
            // RESOLVED/CLOSED which are effectively done).
            const openPhaseRows = all
                .filter(
                    (t) => t.status !== 'CLOSED' && t.status !== 'RESOLVED',
                )
                .map((t) => {
                    const rec = evByTicket.get(t.id);
                    const phaseStart =
                        rec?.lastStatusAt || new Date(t.createdAt).getTime();
                    return {
                        id: t.id,
                        code: t.code,
                        subject: t.subject,
                        status: t.status,
                        assignee: t.assignee?.name || null,
                        sinceMs: now - phaseStart,
                    };
                })
                .sort((a, b) => b.sinceMs - a.sinceMs);
            const timeInPhase = openPhaseRows.slice(0, 12);
            const pendingTime = openPhaseRows
                .filter((r) => r.status === 'PENDING')
                .slice(0, 12);

            payload.workspace = {
                total: all.length,
                open,
                resolved,
                unassigned,
                byStatus,
                byPriority,
                byCategory,
                byProject: topN(byProject),
                byAssignee: topN(byAssignee),
                byClient: topN(byClient),
                avgResolutionSeconds: resCount
                    ? Math.round(resSum / resCount)
                    : null,
                avgOpenToTakenSeconds: takenCount
                    ? Math.round(takenSum / takenCount)
                    : null,
                avgOpenToResolvedSeconds: o2rCount
                    ? Math.round(o2rSum / o2rCount)
                    : null,
                timeInPhase,
                pendingTime,
                trend,
            };
        }
        res.json(payload);
    } catch (err) {
        next(err);
    }
});

// Load a ticket the caller is allowed to see, or throw 404. Mirrors
// scopeWhere: admins see all; the reporter sees their own; an agent sees
// the ticket while it's unassigned, or if it's assigned to them, or if
// they're a participant. A ticket taken by another agent is hidden
// (404) unless you've been invited as a participant.
async function loadVisibleTicket(req, id) {
    const ticket = await prisma.ticket.findUnique({
        where: { id },
        include: {
            ...TICKET_INCLUDE,
            participants: { select: { userId: true } },
            shares: { select: { userId: true } },
            // Tasks spun off this ticket via "Add as Task", so the detail
            // can show "Created task T-0001" chips.
            tasks: {
                where: { deletedAt: null },
                select: {
                    id: true,
                    code: true,
                    title: true,
                    status: true,
                    projectId: true,
                    phaseId: true,
                    project: { select: { id: true, name: true, code: true } },
                },
                orderBy: { createdAt: 'desc' },
            },
        },
    });
    if (!ticket) throw httpError(404, 'Ticket not found.');
    if (canViewAll(req)) return ticket;
    const me = req.user.id;
    if (ticket.reporterId === me) return ticket;
    const isParticipant = (ticket.participants || []).some(
        (p) => p.userId === me,
    );
    // A ticket explicitly shared with me is viewable regardless of role,
    // internal flag, or organisation — that's the whole point of sharing.
    const isSharedWithMe = (ticket.shares || []).some((s) => s.userId === me);
    if (isSharedWithMe) return ticket;
    if (canManage(req)) {
        if (ticket.assigneeId === me) return ticket;
        if (isParticipant) return ticket;
        // Internal tickets are private to their reporter / assignee /
        // selected participants — no open-queue or team-queue access.
        if (!ticket.internal) {
            // Restricted type → only allowed agents (team queue). Otherwise
            // (no type / no allowed list) the open queue is visible to all.
            const allowed = (ticket.requestType?.agents || []).map(
                (a) => a.userId,
            );
            if (allowed.length > 0) {
                if (allowed.includes(me)) return ticket;
            } else if (!ticket.assigneeId) {
                return ticket;
            }
        }
        throw httpError(404, 'Ticket not found.');
    }
    // Requesters never see internal (private) tickets unless invited.
    if (ticket.internal && !isParticipant) {
        throw httpError(404, 'Ticket not found.');
    }
    // External requesters are further limited to their own organisation.
    if (req.user.external) {
        const sameOrg =
            req.user.clientId && ticket.clientId === req.user.clientId;
        if (!sameOrg && !isParticipant) {
            throw httpError(404, 'Ticket not found.');
        }
    }
    return ticket;
}

// GET /api/tickets/:id --------------------------------------------------
router.get('/:id', async (req, res, next) => {
    try {
        const ticket = await loadVisibleTicket(req, req.params.id);
        // Opening the ticket clears its "new activity" notifications for
        // this user (best-effort — never block the read on it).
        clearTicketNotificationsForTicket(req.user.id, ticket.id).catch(
            () => {},
        );
        const messages = await prisma.ticketMessage.findMany({
            where: { ticketId: ticket.id },
            include: {
                author: {
                    select: { id: true, name: true, avatarUrl: true },
                },
            },
            orderBy: { createdAt: 'asc' },
        });
        // Requesters never see internal agent notes.
        const visibleMessages = canManage(req)
            ? messages
            : messages.filter((m) => m.direction !== 'INTERNAL');
        const events = await prisma.ticketEvent.findMany({
            where: { ticketId: ticket.id },
            include: {
                actor: { select: { id: true, name: true, avatarUrl: true } },
            },
            orderBy: { createdAt: 'asc' },
        });
        const participants = await prisma.ticketParticipant.findMany({
            where: { ticketId: ticket.id },
            include: {
                user: { select: { id: true, name: true, avatarUrl: true } },
            },
        });
        const attachments = await prisma.ticketAttachment.findMany({
            where: { ticketId: ticket.id },
            include: {
                uploader: { select: { id: true, name: true, avatarUrl: true } },
            },
            orderBy: { createdAt: 'asc' },
        });
        // Read receipts: stamp THIS viewer's cursor "now", then return the
        // whole ticket's cursors so the sender side can render "Seen". Tell
        // other open viewers my cursor moved so their marker updates live.
        const now = new Date();
        await prisma.ticketRead
            .upsert({
                where: {
                    ticketId_userId: {
                        ticketId: ticket.id,
                        userId: req.user.id,
                    },
                },
                create: {
                    ticketId: ticket.id,
                    userId: req.user.id,
                    lastReadAt: now,
                },
                update: { lastReadAt: now },
            })
            .catch(() => {});
        const reads = await prisma.ticketRead.findMany({
            where: { ticketId: ticket.id },
            select: { userId: true, lastReadAt: true },
        });
        realtime.emitToAll('ticket:read', {
            ticketId: ticket.id,
            userId: req.user.id,
            lastReadAt: now,
        });
        res.json({
            ticket: {
                ...forList(ticket),
                description: ticket.description,
                linkedTasks: ticket.tasks || [],
            },
            messages: visibleMessages,
            events,
            participants: participants.map((p) => p.user),
            attachments: attachments.map((a) => withSignedUrl(a, req.user.id)),
            reads,
        });
    } catch (err) {
        next(err);
    }
});

// PATCH /api/tickets/:id ------------------------------------------------
// Agents may edit anything anytime. The reporter may edit only the
// subject/description/priority of their OWN ticket, and only until an
// agent has taken it (assigneeId still null).
router.patch('/:id', async (req, res, next) => {
    try {
        const ticket = await loadVisibleTicket(req, req.params.id);
        const data = patchSchema.parse(req.body);
        const agent = canManage(req);
        const isOwnReporter = ticket.reporterId === req.user.id;
        // CLOSED is locked for the requester: no edits of any kind. Only
        // resolvers (agents) can change anything on a closed ticket.
        const isClosed = ticket.status === 'CLOSED';
        // The reporter can edit subject/description only until an agent
        // takes the ticket, and can raise/lower priority any time — but
        // never once the ticket is closed.
        const canEditContent =
            agent || (isOwnReporter && !ticket.assigneeId && !isClosed);
        const canSetPriority = agent || (isOwnReporter && !isClosed);

        const update = {};
        const events = [];

        // subject/description — reporter (until taken) or agent.
        if (data.subject !== undefined || data.description !== undefined) {
            if (!canEditContent) {
                throw httpError(
                    403,
                    'You can only edit your own ticket until an agent takes it.',
                );
            }
            if (data.subject !== undefined) update.subject = data.subject;
            if (data.description !== undefined)
                update.description = data.description;
        }

        // priority — reporter any time, or agent.
        if (data.priority !== undefined && data.priority !== ticket.priority) {
            if (!canSetPriority) {
                throw httpError(403, 'You cannot change the priority.');
            }
            update.priority = data.priority;
            events.push(['PRIORITY_CHANGED', ticket.priority, data.priority]);
        }

        // Agent-only fields.
        if (agent) {
            if (data.type !== undefined) update.type = data.type;
            if (data.projectId !== undefined)
                update.projectId = data.projectId;
            if (
                data.assigneeId !== undefined &&
                data.assigneeId !== ticket.assigneeId
            ) {
                // Taking / assigning a ticket requires a project — either
                // already set or provided in this same request.
                if (data.assigneeId) {
                    const effectiveProjectId =
                        data.projectId !== undefined
                            ? data.projectId
                            : ticket.projectId;
                    if (!effectiveProjectId) {
                        throw httpError(
                            400,
                            'Assign a project before taking the ticket.',
                        );
                    }
                }
                update.assigneeId = data.assigneeId;
                events.push([
                    data.assigneeId ? 'ASSIGNED' : 'UNASSIGNED',
                    ticket.assignee?.name || null,
                    data.assigneeId || null,
                ]);
            }
            if (data.status !== undefined && data.status !== ticket.status) {
                update.status = data.status;
                if (data.status === 'CLOSED') {
                    update.closedById = req.user.id;
                    update.closedAt = new Date();
                } else if (ticket.status === 'CLOSED') {
                    update.closedById = null;
                    update.closedAt = null;
                }
                const kind =
                    ticket.status === 'CLOSED' ? 'REOPENED' : 'STATUS_CHANGED';
                events.push([kind, ticket.status, data.status]);
            }
        } else if (
            data.status !== undefined ||
            data.assigneeId !== undefined ||
            data.type !== undefined
        ) {
            throw httpError(403, 'Only agents can change status or assignee.');
        }

        const updated = await prisma.ticket.update({
            where: { id: ticket.id },
            data: update,
            include: { ...TICKET_INCLUDE, _count: { select: { messages: true } } },
        });
        for (const [kind, from, to] of events) {
            await logTicketEvent(ticket.id, req.user.id, kind, from, to);
        }
        // Mirror status / assignment changes into the global activity
        // feed (project-scoped). Priority changes stay on the ticket's
        // own timeline only — they'd be noise in the project feed.
        const ticketMeta = {
            ticketId: updated.id,
            ticketCode: updated.code,
            ticketSubject: updated.subject,
            ticketCategory: updated.type,
        };
        for (const [kind, from, to] of events) {
            if (kind === 'STATUS_CHANGED' || kind === 'REOPENED') {
                await logActivityEvent({
                    type: 'TICKET_STATUS_CHANGED',
                    actorId: req.user.id,
                    projectId: updated.projectId,
                    message: updated.subject,
                    fromValue: from,
                    toValue: to,
                    meta: ticketMeta,
                });
            } else if (kind === 'ASSIGNED' || kind === 'UNASSIGNED') {
                await logActivityEvent({
                    type: 'TICKET_ASSIGNED',
                    actorId: req.user.id,
                    projectId: updated.projectId,
                    message: updated.subject,
                    toValue:
                        kind === 'ASSIGNED'
                            ? updated.assignee?.name || null
                            : null,
                    meta: ticketMeta,
                });
            }
        }
        // On a (re)assignment, tell the requester who's handling it and
        // give the newly assigned agent a heads-up. Best-effort.
        if (events.some(([k]) => k === 'ASSIGNED') && updated.assigneeId) {
            try {
                await notify({
                    recipientIds: [updated.reporterId],
                    actorId: req.user.id,
                    type: 'TICKET_ASSIGNED',
                    title: `${updated.code}: your request is being handled`,
                    body: `${updated.assignee?.name || 'An agent'} is now handling your request.`,
                    projectId: updated.projectId,
                    link: portalTicketLink(updated.id),
                    meta: { ticketId: updated.id },
                });
                await notify({
                    recipientIds: [updated.assigneeId],
                    actorId: req.user.id,
                    type: 'TICKET_ASSIGNED',
                    title: `${updated.code}: assigned to you`,
                    body: `You've been assigned "${updated.subject}".`,
                    projectId: updated.projectId,
                    link: agentTicketLink(updated.id),
                    meta: { ticketId: updated.id },
                });
            } catch {
                /* non-fatal */
            }
        }
        realtime.emitToAll('ticket:activity', { ticketId: updated.id });
        res.json({ ticket: forList(updated) });
    } catch (err) {
        next(err);
    }
});

// POST /api/tickets/:id/take -------------------------------------------
// An agent claims an unassigned ticket: assigns it to themselves and
// moves NEW -> OPEN. They become the owner.
router.post('/:id/take', async (req, res, next) => {
    try {
        if (!canManage(req)) throw httpError(403, 'Only agents can take tickets.');
        const ticket = await loadVisibleTicket(req, req.params.id);
        // A ticket must belong to a project before anyone takes ownership —
        // the resolver assigns one from the ticket panel first.
        if (!ticket.projectId) {
            throw httpError(
                400,
                'Assign a project to this ticket before taking it.',
            );
        }
        const data = {
            assigneeId: req.user.id,
            // Picking up a brand-new ticket moves it to In progress.
            status: ticket.status === 'NEW' ? 'IN_PROGRESS' : ticket.status,
        };
        const updated = await prisma.ticket.update({
            where: { id: ticket.id },
            data,
            include: { ...TICKET_INCLUDE, _count: { select: { messages: true } } },
        });
        await logTicketEvent(
            ticket.id,
            req.user.id,
            'ASSIGNED',
            ticket.assignee?.name || null,
            req.user.name || null,
        );
        const takeMeta = {
            ticketId: updated.id,
            ticketCode: updated.code,
            ticketSubject: updated.subject,
            ticketCategory: updated.type,
        };
        await logActivityEvent({
            type: 'TICKET_ASSIGNED',
            actorId: req.user.id,
            projectId: updated.projectId,
            message: updated.subject,
            toValue: req.user.name || null,
            meta: takeMeta,
        });
        if (ticket.status === 'NEW') {
            await logTicketEvent(
                ticket.id,
                req.user.id,
                'STATUS_CHANGED',
                'NEW',
                'IN_PROGRESS',
            );
            await logActivityEvent({
                type: 'TICKET_STATUS_CHANGED',
                actorId: req.user.id,
                projectId: updated.projectId,
                message: updated.subject,
                fromValue: 'NEW',
                toValue: 'IN_PROGRESS',
                meta: takeMeta,
            });
        }
        // Let the requester know who's now handling their request.
        try {
            await notify({
                recipientIds: [ticket.reporterId],
                actorId: req.user.id,
                type: 'TICKET_ASSIGNED',
                title: `${ticket.code}: your request was picked up`,
                body: `${req.user.name || 'An agent'} is now handling your request.`,
                projectId: ticket.projectId,
                link: portalTicketLink(ticket.id),
                meta: { ticketId: ticket.id },
            });
        } catch {
            /* non-fatal */
        }
        realtime.emitToAll('ticket:activity', { ticketId: updated.id });
        res.json({ ticket: forList(updated) });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/tickets/:id ----------------------------------------------
// Agents/admins may delete any ticket; the reporter may delete their own
// only until it's been taken. SOFT delete: we stamp `deletedAt` instead of
// physically removing the row, so an accidental delete is restorable from
// the activity feed. Messages / events / attachments ride along on the same
// (now-hidden) ticket and come back intact on restore.
router.delete('/:id', async (req, res, next) => {
    try {
        const ticket = await loadVisibleTicket(req, req.params.id);
        const agent = canManage(req);
        const ownUntaken =
            ticket.reporterId === req.user.id &&
            !ticket.assigneeId &&
            ticket.status !== 'CLOSED';
        if (!agent && !ownUntaken) {
            throw httpError(403, 'You cannot delete this ticket.');
        }
        await prisma.ticket.update({
            where: { id: ticket.id },
            data: { deletedAt: new Date() },
        });
        await logActivityEvent({
            type: 'TICKET_DELETED',
            actorId: req.user.id,
            projectId: ticket.projectId,
            message: ticket.subject,
            meta: {
                ticketId: ticket.id,
                ticketCode: ticket.code,
                ticketSubject: ticket.subject,
                ticketCategory: ticket.type,
            },
        });
        realtime.emitToAll('ticket:activity', { ticketId: ticket.id });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// POST /api/tickets/:id/restore — undo a soft delete. Admins and ticket
// managers (the roles that can delete) can put a ticket back. Looks
// specifically at SOFT-DELETED rows via an explicit `deletedAt: { not:
// null }` filter (the client extension only auto-injects `deletedAt: null`
// when the caller hasn't mentioned it).
router.post('/:id/restore', async (req, res, next) => {
    try {
        if (!canManage(req)) {
            throw httpError(403, 'Only agents can restore tickets.');
        }
        const ghost = await prisma.ticket.findFirst({
            where: { id: req.params.id, deletedAt: { not: null } },
            select: {
                id: true,
                code: true,
                subject: true,
                type: true,
                projectId: true,
            },
        });
        if (!ghost) {
            // Tell the caller WHY: never existed, or already restored.
            const probe = await prisma.ticket.findFirst({
                where: { id: req.params.id, deletedAt: undefined },
                select: { id: true, deletedAt: true },
            });
            if (!probe) {
                throw httpError(
                    404,
                    'Ticket has been permanently removed and can no longer be restored.',
                );
            }
            throw httpError(
                409,
                'This ticket has already been restored — refresh the activity feed to see it again.',
            );
        }
        await prisma.ticket.update({
            where: { id: ghost.id, deletedAt: { not: null } },
            data: { deletedAt: null },
        });
        await logActivityEvent({
            type: 'TICKET_RESTORED',
            actorId: req.user.id,
            projectId: ghost.projectId,
            message: ghost.subject,
            meta: {
                ticketId: ghost.id,
                ticketCode: ghost.code,
                ticketSubject: ghost.subject,
                ticketCategory: ghost.type,
            },
        });
        realtime.emitToAll('ticket:activity', { ticketId: ghost.id });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// Attachments ----------------------------------------------------------
// Anyone who can see the ticket can attach a file (requester or agent).
// The multer filter (ticketFileFilter) blocks executables / scripts /
// .svg / .html; everything else up to 50MB is accepted. Multer errors
// (filter reject, too large) are normalised to a 400 here.
function uploadTicketFile(req, res, next) {
    ticketFileUpload.single('file')(req, res, (err) => {
        if (err) {
            return next(httpError(400, err.message || 'Upload failed.'));
        }
        next();
    });
}

router.post('/:id/attachments', uploadTicketFile, async (req, res, next) => {
    try {
        if (!req.file) throw httpError(400, 'No file uploaded.');
        let ticket;
        try {
            ticket = await loadVisibleTicket(req, req.params.id);
        } catch (err) {
            // Don't leave an orphaned blob if the caller can't see the
            // ticket (or it doesn't exist).
            removeFileSafe(fileUrl(req.file.filename));
            throw err;
        }
        // A closed ticket is locked — no new attachments. Only resolvers
        // reopening it (changing its status) unlock uploads again.
        if (ticket.status === 'CLOSED' && !canManage(req)) {
            removeFileSafe(fileUrl(req.file.filename));
            throw httpError(409, 'This ticket is closed.');
        }
        // Optional: pin the file to a specific message (a comment's
        // attachment). The message must belong to this ticket. Omit to
        // attach at ticket level.
        const messageId = req.body?.messageId || null;
        if (messageId) {
            const msg = await prisma.ticketMessage.findUnique({
                where: { id: messageId },
                select: { id: true, ticketId: true },
            });
            if (!msg || msg.ticketId !== ticket.id) {
                removeFileSafe(fileUrl(req.file.filename));
                throw httpError(400, 'Message does not belong to this ticket.');
            }
        }
        // Images are pasted/attached photos — keep them for ~2 months then
        // sweep. Everything else (docs, archives, …) is retained.
        const isImage = (req.file.mimetype || '').startsWith('image/');
        const expiresAt = isImage
            ? new Date(Date.now() + TICKET_IMAGE_TTL_MS)
            : null;
        const created = await prisma.ticketAttachment.create({
            data: {
                ticketId: ticket.id,
                messageId: messageId || null,
                uploaderId: req.user.id,
                filename: req.file.filename,
                originalName: req.file.originalname,
                url: fileUrl(req.file.filename),
                size: req.file.size,
                mime: req.file.mimetype || null,
                expiresAt,
            },
            include: {
                uploader: { select: { id: true, name: true, avatarUrl: true } },
            },
        });
        res.status(201).json({
            attachment: withSignedUrl(created, req.user.id),
        });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id/attachments/:attId', async (req, res, next) => {
    try {
        const ticket = await loadVisibleTicket(req, req.params.id);
        const att = await prisma.ticketAttachment.findUnique({
            where: { id: req.params.attId },
        });
        if (!att || att.ticketId !== ticket.id) {
            throw httpError(404, 'Attachment not found.');
        }
        // The uploader can remove their own file; agents/admins can
        // remove any attachment on a ticket they manage.
        if (att.uploaderId !== req.user.id && !canManage(req)) {
            throw httpError(403, 'You cannot remove this attachment.');
        }
        await prisma.ticketAttachment.delete({ where: { id: att.id } });
        removeFileSafe(att.url);
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// Participants (watchers / share) --------------------------------------
router.post('/:id/participants', async (req, res, next) => {
    try {
        const ticket = await loadVisibleTicket(req, req.params.id);
        // A closed ticket is locked for requesters — no adding people.
        if (ticket.status === 'CLOSED' && !canManage(req)) {
            throw httpError(409, 'This ticket is closed.');
        }
        // Accept a single userId, an array of userIds, and/or a groupId
        // (a requester group, expanded to its members).
        const single = req.body?.userId ? [String(req.body.userId)] : [];
        const many = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
        const groupIds = req.body?.groupId
            ? [String(req.body.groupId)]
            : Array.isArray(req.body?.groupIds)
              ? req.body.groupIds
              : [];
        const targetIds = await resolveParticipantUserIds(
            [...single, ...many],
            groupIds,
        );
        if (targetIds.length === 0) {
            throw httpError(400, 'No valid users to add.');
        }

        // Which are genuinely new (so we only notify those).
        const already = await prisma.ticketParticipant.findMany({
            where: { ticketId: ticket.id, userId: { in: targetIds } },
            select: { userId: true },
        });
        const alreadySet = new Set(already.map((p) => p.userId));

        await prisma.ticketParticipant.createMany({
            data: targetIds.map((userId) => ({
                ticketId: ticket.id,
                userId,
                addedById: req.user.id,
            })),
            skipDuplicates: true,
        });

        for (const userId of targetIds) {
            if (alreadySet.has(userId) || userId === req.user.id) continue;
            try {
                const isReporter = userId === ticket.reporterId;
                await notify({
                    recipientIds: [userId],
                    actorId: req.user.id,
                    type: 'TICKET_ASSIGNED',
                    title: `${ticket.code}: you were added to a ticket`,
                    body: `${req.user.name || 'Someone'} added you to "${ticket.subject}".`,
                    projectId: ticket.projectId,
                    link: isReporter
                        ? portalTicketLink(ticket.id)
                        : agentTicketLink(ticket.id),
                    meta: { ticketId: ticket.id },
                });
            } catch {
                /* non-fatal */
            }
        }
        res.status(201).json({ ok: true, added: targetIds.length });
    } catch (err) {
        next(err);
    }
});

// POST /api/tickets/:id/log-time ---------------------------------------
// An agent logs work time against the ticket's project. Gated by ticket
// access (not project-write), since agents work tickets on projects they
// may not otherwise belong to. The entry is tagged with the ticket code
// + subject so it's traceable in the project's / user's time.
router.post('/:id/log-time', async (req, res, next) => {
    try {
        if (!canManage(req)) {
            throw httpError(403, 'Only agents can log time on a ticket.');
        }
        const ticket = await loadVisibleTicket(req, req.params.id);
        if (!ticket.projectId) {
            throw httpError(
                400,
                'Assign this ticket to a project before logging time.',
            );
        }
        const data = logTimeSchema.parse(req.body);
        const seconds = Math.round(
            (data.endedAt.getTime() - data.startedAt.getTime()) / 1000,
        );
        if (seconds <= 0) throw httpError(400, 'Duration must be positive.');
        if (seconds > 24 * 60 * 60) {
            throw httpError(400, 'Entry cannot be longer than 24 hours.');
        }
        const note = data.note?.trim();
        const description =
            `${ticket.code} · ${ticket.subject}` +
            (note ? ` — ${note}` : '');
        const entry = await prisma.timeEntry.create({
            data: {
                userId: req.user.id,
                projectId: ticket.projectId,
                taskId: null,
                startedAt: data.startedAt,
                endedAt: data.endedAt,
                durationSeconds: seconds,
                description,
                source: 'MANUAL',
            },
        });
        res.status(201).json({ entry });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id/participants/:userId', async (req, res, next) => {
    try {
        const ticket = await loadVisibleTicket(req, req.params.id);
        await prisma.ticketParticipant
            .delete({
                where: {
                    ticketId_userId: {
                        ticketId: ticket.id,
                        userId: req.params.userId,
                    },
                },
            })
            .catch(() => {});
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// POST /api/tickets/:id/messages ---------------------------------------
router.post('/:id/messages', async (req, res, next) => {
    try {
        const ticket = await loadVisibleTicket(req, req.params.id);
        const data = messageSchema.parse(req.body);
        const agent = canManage(req);

        // CLOSED is a locked terminal state: no comments (and no
        // auto-reopen). A resolver must reopen it (change its status)
        // before anyone can comment again.
        if (ticket.status === 'CLOSED') {
            throw httpError(
                409,
                'This ticket is closed. A resolver must reopen it before adding comments.',
            );
        }

        // Direction: an agent posts OUTBOUND (or INTERNAL when flagged);
        // anyone else (the requester) posts INBOUND and can't go internal.
        let direction = 'INBOUND';
        if (agent) direction = data.internal ? 'INTERNAL' : 'OUTBOUND';

        // First resolver to reply owns the ticket: an OUTBOUND reply on an
        // unassigned ticket auto-assigns it to the author. Requires a
        // project (same rule as an explicit "take"); without one we just
        // post the reply and leave it unassigned.
        const autoTake =
            direction === 'OUTBOUND' &&
            !ticket.assigneeId &&
            !!ticket.projectId;
        const autoTakeToProgress = autoTake && ticket.status === 'NEW';

        const message = await prisma.ticketMessage.create({
            data: {
                ticketId: ticket.id,
                authorId: req.user.id,
                direction,
                // Sanitize server-side (defense in depth): strip any markup
                // outside our allowlist before it ever reaches the DB, so a
                // direct API call can't persist active <script>/onerror/etc.
                body: sanitizeRichText(data.body || ''),
            },
            include: {
                author: { select: { id: true, name: true, avatarUrl: true } },
            },
        });
        // A requester replying to a RESOLVED ticket reopens it (CLOSED is
        // locked above and never reaches here).
        const reopened =
            direction === 'INBOUND' && ticket.status === 'RESOLVED';
        await prisma.ticket.update({
            where: { id: ticket.id },
            data: {
                updatedAt: new Date(),
                ...(reopened
                    ? { status: 'IN_PROGRESS', closedById: null, closedAt: null }
                    : {}),
                ...(autoTake ? { assigneeId: req.user.id } : {}),
                ...(autoTakeToProgress ? { status: 'IN_PROGRESS' } : {}),
            },
        });
        // First-reply ownership: record the assignment (and NEW→IN_PROGRESS)
        // on the timeline + activity feed so metrics like "open → taken"
        // pick it up. We skip a separate "assigned" notification here — the
        // reply notification below already tells the requester someone
        // responded.
        if (autoTake) {
            const takeMeta = {
                ticketId: ticket.id,
                ticketCode: ticket.code,
                ticketSubject: ticket.subject,
                ticketCategory: ticket.type,
            };
            await logTicketEvent(
                ticket.id,
                req.user.id,
                'ASSIGNED',
                null,
                req.user.name || null,
            );
            await logActivityEvent({
                type: 'TICKET_ASSIGNED',
                actorId: req.user.id,
                projectId: ticket.projectId,
                message: ticket.subject,
                toValue: req.user.name || null,
                meta: takeMeta,
            });
            if (autoTakeToProgress) {
                await logTicketEvent(
                    ticket.id,
                    req.user.id,
                    'STATUS_CHANGED',
                    'NEW',
                    'IN_PROGRESS',
                );
                await logActivityEvent({
                    type: 'TICKET_STATUS_CHANGED',
                    actorId: req.user.id,
                    projectId: ticket.projectId,
                    message: ticket.subject,
                    fromValue: 'NEW',
                    toValue: 'IN_PROGRESS',
                    meta: takeMeta,
                });
            }
        }
        if (reopened) {
            await logTicketEvent(
                ticket.id,
                req.user.id,
                'REOPENED',
                ticket.status,
                'IN_PROGRESS',
            );
            await logActivityEvent({
                type: 'TICKET_STATUS_CHANGED',
                actorId: req.user.id,
                projectId: ticket.projectId,
                message: ticket.subject,
                fromValue: ticket.status,
                toValue: 'IN_PROGRESS',
                meta: {
                    ticketId: ticket.id,
                    ticketCode: ticket.code,
                    ticketSubject: ticket.subject,
                    ticketCategory: ticket.type,
                },
            });
        }

        // Live signal so the shared queue reorders without a refresh.
        realtime.emitToAll('ticket:activity', { ticketId: ticket.id });

        // Notify the right people about the new comment. Best-effort.
        try {
            const watcherIds = await ticketParticipantIds(ticket.id);
            // Bodies are rich-text HTML now; strip tags + decode the few
            // common entities for a clean plain-text notification preview.
            const snippet = (data.body || '')
                .replace(/<[^>]*>/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 140);
            const actorName = req.user.name || 'Someone';
            if (direction === 'OUTBOUND') {
                // Agent replied → the requester sees it on their portal.
                await notify({
                    recipientIds: [ticket.reporterId],
                    actorId: req.user.id,
                    type: 'TICKET_COMMENT',
                    title: `${ticket.code}: new reply on your request`,
                    body: snippet || `${actorName} replied to your request.`,
                    projectId: ticket.projectId,
                    link: portalTicketLink(ticket.id),
                    meta: { ticketId: ticket.id },
                });
                // Watchers / assignee (agents) get the workspace link.
                const agentRecipients = [
                    ...watcherIds,
                    ticket.assigneeId,
                ].filter((uid) => uid && uid !== ticket.reporterId);
                await notify({
                    recipientIds: agentRecipients,
                    actorId: req.user.id,
                    type: 'TICKET_COMMENT',
                    title: `${ticket.code}: new reply`,
                    body: snippet,
                    projectId: ticket.projectId,
                    link: agentTicketLink(ticket.id),
                    meta: { ticketId: ticket.id },
                });
            } else if (direction === 'INTERNAL') {
                // Internal note → agents/watchers only, never the requester.
                const agentRecipients = [
                    ...watcherIds,
                    ticket.assigneeId,
                ].filter((uid) => uid && uid !== ticket.reporterId);
                await notify({
                    recipientIds: agentRecipients,
                    actorId: req.user.id,
                    type: 'TICKET_COMMENT',
                    title: `${ticket.code}: internal note`,
                    body: snippet,
                    projectId: ticket.projectId,
                    link: agentTicketLink(ticket.id),
                    meta: { ticketId: ticket.id, internal: true },
                });
            } else {
                // Requester replied → assignee + watchers (agents).
                const agentRecipients = [
                    ...watcherIds,
                    ticket.assigneeId,
                ].filter(Boolean);
                await notify({
                    recipientIds: agentRecipients,
                    actorId: req.user.id,
                    type: 'TICKET_COMMENT',
                    title: `${ticket.code}: requester replied`,
                    body: snippet,
                    projectId: ticket.projectId,
                    link: agentTicketLink(ticket.id),
                    meta: { ticketId: ticket.id },
                });
            }

            // @-mentions: notify the tagged people directly (best-effort).
            // Each mention is a <span data-mention="userId"> chip the
            // composer inserted. Internal notes never ping the requester
            // side.
            const mentionedIds = Array.from(
                new Set(
                    [
                        ...(data.body || '').matchAll(
                            /data-mention="([^"]+)"/g,
                        ),
                    ].map((m) => m[1]),
                ),
            ).filter((uid) => uid && uid !== req.user.id);
            if (mentionedIds.length) {
                const mentioned = await prisma.user.findMany({
                    where: { id: { in: mentionedIds }, status: 'ACTIVE' },
                    select: { id: true, role: true, external: true },
                });
                for (const u of mentioned) {
                    const requesterSide =
                        u.id === ticket.reporterId ||
                        u.role === 'REQUESTER' ||
                        u.external;
                    if (direction === 'INTERNAL' && requesterSide) continue;
                    await notify({
                        recipientIds: [u.id],
                        actorId: req.user.id,
                        type: 'TICKET_COMMENT',
                        title: `${ticket.code}: ${actorName} mentioned you`,
                        body: snippet || `${actorName} mentioned you.`,
                        projectId: ticket.projectId,
                        link: requesterSide
                            ? portalTicketLink(ticket.id)
                            : agentTicketLink(ticket.id),
                        meta: { ticketId: ticket.id, mention: true },
                    });
                }
            }

            // Ticket references (#link to another ticket): grant this
            // ticket's reporter read-only access to the linked ticket (a
            // "shared with" record, not participation), so "pointing" them
            // there actually lets them open it.
            // Match both link shapes: the role-agnostic /t/:id deep-link
            // and the legacy ?ticket=<id> query form (older messages).
            const referencedIds = Array.from(
                new Set(
                    [
                        ...(data.body || '').matchAll(
                            /(?:[?&]ticket=|\/t\/)([a-z0-9_-]{1,48})/gi,
                        ),
                    ].map((m) => m[1]),
                ),
            ).filter((rid) => rid && rid !== ticket.id);
            if (referencedIds.length && ticket.reporterId) {
                for (const rid of referencedIds) {
                    const exists = await prisma.ticket.findUnique({
                        where: { id: rid },
                        select: { id: true },
                    });
                    if (!exists) continue;
                    await prisma.ticketShare
                        .upsert({
                            where: {
                                ticketId_userId: {
                                    ticketId: rid,
                                    userId: ticket.reporterId,
                                },
                            },
                            create: {
                                ticketId: rid,
                                userId: ticket.reporterId,
                                sharedById: req.user.id,
                            },
                            update: {},
                        })
                        .catch(() => {});
                }
            }
        } catch {
            /* non-fatal */
        }

        res.status(201).json({ message });
    } catch (err) {
        next(err);
    }
});

// POST /api/tickets/:id/share — "share with a teammate": adds the user as a
// participant (so they can actually open the ticket) and pings them with a
// notification linking to it. Anyone who can see the ticket can share it.
router.post('/:id/share', async (req, res, next) => {
    try {
        const ticket = await loadVisibleTicket(req, req.params.id);
        const userId = String(req.body?.userId || '').trim();
        if (!userId) throw httpError(400, 'Pick someone to share with.');
        if (userId === req.user.id) {
            return res.json({ ok: true }); // sharing with yourself is a no-op
        }
        const target = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, role: true, external: true },
        });
        if (!target) throw httpError(404, 'User not found.');
        // Grant access: a read-only "shared with" record (NOT a participant,
        // so they aren't subscribed to every future message) — unless they
        // already have an intrinsic role on the ticket (reporter / assignee).
        if (
            target.id !== ticket.reporterId &&
            target.id !== ticket.assigneeId
        ) {
            await prisma.ticketShare
                .upsert({
                    where: {
                        ticketId_userId: {
                            ticketId: ticket.id,
                            userId: target.id,
                        },
                    },
                    create: {
                        ticketId: ticket.id,
                        userId: target.id,
                        sharedById: req.user.id,
                    },
                    update: {},
                })
                .catch(() => {});
        }
        const requesterSide =
            target.id === ticket.reporterId ||
            target.role === 'REQUESTER' ||
            target.external;
        await notify({
            recipientIds: [target.id],
            actorId: req.user.id,
            type: 'TICKET_COMMENT',
            title: `${ticket.code}: ${req.user.name || 'Someone'} shared a ticket with you`,
            body: ticket.subject,
            projectId: ticket.projectId,
            link: requesterSide
                ? portalTicketLink(ticket.id)
                : agentTicketLink(ticket.id),
            meta: { ticketId: ticket.id, shared: true },
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
