// Admin-managed ticket request types — the cards shown on the requester
// portal. Each type maps to a project, so picking a type sets the
// ticket's project automatically.
//
//   GET    /api/ticket-request-types          -> list (active-only for non-admins)
//   POST   /api/ticket-request-types          -> create (admin)
//   PATCH  /api/ticket-request-types/:id       -> update (admin)
//   DELETE /api/ticket-request-types/:id       -> delete (admin)
//
// Read access: anyone who can open or manage tickets (so the portal can
// render the cards). Write access: admin only — this is workspace config.

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    isAdmin,
    isAdminOrHasCapability,
    hasCapability,
    CAPABILITIES,
} = require('../lib/permissions');

const router = express.Router();
router.use(requireAuth);

const TicketPriority = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);

const createSchema = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(255).optional().nullable(),
    icon: z.string().trim().max(60).optional().nullable(),
    color: z.string().trim().max(30).optional().nullable(),
    // Optional soft default/hint only — types are not tied to a project.
    projectId: z.string().min(1).optional().nullable(),
    defaultPriority: TicketPriority.optional().nullable(),
    active: z.boolean().optional(),
    position: z.number().int().min(0).max(100000).optional(),
    // Agents allowed to see this type's tickets. Empty/omitted =
    // unrestricted (every agent sees the open queue).
    agentIds: z.array(z.string()).optional(),
});

const patchSchema = createSchema.partial();

// Keep only ids that map to real, active, non-requester users — a
// requester must never be granted agent-side visibility.
async function validAgentIds(ids) {
    const unique = Array.from(new Set((ids || []).filter(Boolean)));
    if (unique.length === 0) return [];
    const users = await prisma.user.findMany({
        where: {
            id: { in: unique },
            status: 'ACTIVE',
            role: { not: 'REQUESTER' },
        },
        select: { id: true },
    });
    return users.map((u) => u.id);
}

function serialize(t, { includeAgents = false } = {}) {
    const out = {
        id: t.id,
        name: t.name,
        description: t.description || null,
        icon: t.icon || null,
        color: t.color || null,
        projectId: t.projectId,
        project: t.project
            ? { id: t.project.id, name: t.project.name, code: t.project.code }
            : null,
        defaultPriority: t.defaultPriority || null,
        active: t.active,
        position: t.position,
    };
    // Only admins get the allowed-agent list; the portal cards don't
    // need (and shouldn't leak) it.
    if (includeAgents) {
        out.agents = (t.agents || []).map((a) => ({
            id: a.userId,
            name: a.user?.name || a.user?.email || null,
        }));
        out.agentIds = (t.agents || []).map((a) => a.userId);
    }
    return out;
}

const AGENT_INCLUDE = {
    project: { select: { id: true, name: true, code: true } },
    agents: {
        select: {
            userId: true,
            user: { select: { id: true, name: true, email: true } },
        },
    },
};

const canRead = (req) =>
    isAdminOrHasCapability(req, CAPABILITIES.TICKET_CREATE) ||
    hasCapability(req, CAPABILITIES.TICKET_MANAGE);

router.get('/', async (req, res, next) => {
    try {
        if (!canRead(req)) throw httpError(403, 'Not allowed.');
        const where = {};
        // Non-admins (requesters) only ever see active types.
        if (!isAdmin(req)) where.active = true;
        if (req.query.active === '1') where.active = true;
        // External requesters only see the types their organisation (client)
        // is allowed to raise. No allowance = no types (strict).
        if (req.user.external) {
            const allowed = req.user.clientId
                ? await prisma.clientTicketType.findMany({
                      where: { clientId: req.user.clientId },
                      select: { requestTypeId: true },
                  })
                : [];
            where.id = { in: allowed.map((a) => a.requestTypeId) };
        } else if (req.user.role === 'REQUESTER') {
            // Internal requesters only see their own per-user allowed types.
            const allowed = await prisma.userTicketType.findMany({
                where: { userId: req.user.id },
                select: { requestTypeId: true },
            });
            where.id = { in: allowed.map((a) => a.requestTypeId) };
        }
        const admin = isAdmin(req);
        const rows = await prisma.ticketRequestType.findMany({
            where,
            include: admin
                ? AGENT_INCLUDE
                : { project: { select: { id: true, name: true, code: true } } },
            orderBy: [{ position: 'asc' }, { name: 'asc' }],
        });
        res.json({
            requestTypes: rows.map((r) =>
                serialize(r, { includeAgents: admin }),
            ),
        });
    } catch (err) {
        next(err);
    }
});

router.post('/', async (req, res, next) => {
    try {
        if (!isAdmin(req)) throw httpError(403, 'Admins only.');
        const data = createSchema.parse(req.body);
        if (data.projectId) {
            const project = await prisma.project.findUnique({
                where: { id: data.projectId },
                select: { id: true },
            });
            if (!project) throw httpError(400, 'Project not found.');
        }
        const agentIds = await validAgentIds(data.agentIds);
        const created = await prisma.ticketRequestType.create({
            data: {
                name: data.name,
                description: data.description || null,
                icon: data.icon || null,
                color: data.color || null,
                projectId: data.projectId || null,
                defaultPriority: data.defaultPriority || null,
                active: data.active ?? true,
                position: data.position ?? 0,
                createdById: req.user.id,
                agents: { create: agentIds.map((userId) => ({ userId })) },
            },
            include: AGENT_INCLUDE,
        });
        res.status(201).json({
            requestType: serialize(created, { includeAgents: true }),
        });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        if (!isAdmin(req)) throw httpError(403, 'Admins only.');
        const data = patchSchema.parse(req.body);
        const existing = await prisma.ticketRequestType.findUnique({
            where: { id: req.params.id },
            select: { id: true },
        });
        if (!existing) throw httpError(404, 'Request type not found.');
        if (data.projectId) {
            const project = await prisma.project.findUnique({
                where: { id: data.projectId },
                select: { id: true },
            });
            if (!project) throw httpError(400, 'Project not found.');
        }
        const update = {};
        for (const k of [
            'name',
            'description',
            'icon',
            'color',
            'projectId',
            'defaultPriority',
            'active',
            'position',
        ]) {
            if (data[k] !== undefined) update[k] = data[k];
        }
        // Replace the allowed-agent set when the caller sends agentIds.
        if (data.agentIds !== undefined) {
            const agentIds = await validAgentIds(data.agentIds);
            update.agents = {
                deleteMany: {},
                create: agentIds.map((userId) => ({ userId })),
            };
        }
        const updated = await prisma.ticketRequestType.update({
            where: { id: req.params.id },
            data: update,
            include: AGENT_INCLUDE,
        });
        res.json({
            requestType: serialize(updated, { includeAgents: true }),
        });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        if (!isAdmin(req)) throw httpError(403, 'Admins only.');
        // Tickets keep their project; their requestTypeId is set null by
        // the FK rule, so deleting a type never deletes tickets.
        await prisma.ticketRequestType
            .delete({ where: { id: req.params.id } })
            .catch(() => {
                throw httpError(404, 'Request type not found.');
            });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
