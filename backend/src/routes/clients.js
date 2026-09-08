// Company clients — CRM-style records linked from projects.
//
//   GET    /api/clients           List (optional ?q=, ?includeInactive=1)
//   POST   /api/clients           Create. Admin / Manager.
//   GET    /api/clients/:id       Detail with contacts.
//   PATCH  /api/clients/:id       Update. Admin / Manager.
//   DELETE /api/clients/:id       Delete. Admin only.

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const { isAdmin, isAdminOrManager } = require('../lib/permissions');

const router = express.Router();
router.use(requireAuth);

const contactSchema = z.object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(200).optional().nullable().or(z.literal('')),
    phone: z.string().max(60).optional().nullable(),
    role: z.string().max(120).optional().nullable(),
    isPrimary: z.boolean().optional(),
    order: z.number().int().min(0).optional(),
});

const clientBodySchema = z.object({
    name: z.string().min(1).max(200),
    address: z.string().max(500).optional().nullable(),
    city: z.string().max(120).optional().nullable(),
    postalCode: z.string().max(40).optional().nullable(),
    country: z.string().max(100).optional().nullable(),
    phone: z.string().max(60).optional().nullable(),
    email: z.string().email().max(200).optional().nullable().or(z.literal('')),
    website: z.string().max(300).optional().nullable(),
    notes: z.string().max(5000).optional().nullable(),
    isActive: z.boolean().optional(),
    contacts: z.array(contactSchema).max(50).optional(),
    // Ticket request types this client's external users may raise.
    ticketTypeIds: z.array(z.string()).max(200).optional(),
});

const clientInclude = {
    contacts: { orderBy: [{ isPrimary: 'desc' }, { order: 'asc' }, { name: 'asc' }] },
    allowedTicketTypes: { select: { requestTypeId: true } },
    _count: { select: { projects: true } },
};

// Flatten the join rows to a plain id array on the response.
function serializeClient(client) {
    if (!client) return client;
    return {
        ...client,
        ticketTypeIds: (client.allowedTicketTypes || []).map(
            (t) => t.requestTypeId,
        ),
    };
}

function requireClientManage(req) {
    if (!isAdminOrManager(req)) {
        throw httpError(403, 'You do not have permission to manage clients');
    }
}

function normalizeContacts(contacts = []) {
    return contacts
        .map((c, idx) => ({
            name: c.name.trim(),
            email: c.email?.trim() || null,
            phone: c.phone?.trim() || null,
            role: c.role?.trim() || null,
            isPrimary: Boolean(c.isPrimary),
            order: c.order ?? idx,
        }))
        .filter((c) => c.name);
}

router.get('/', async (req, res, next) => {
    try {
        const q = (req.query.q || '').trim();
        const includeInactive =
            req.query.includeInactive === '1' ||
            req.query.includeInactive === 'true';
        const where = {};
        if (!includeInactive) where.isActive = true;
        if (q) {
            where.OR = [
                { name: { contains: q, mode: 'insensitive' } },
                { country: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
            ];
        }
        const clients = await prisma.client.findMany({
            where,
            orderBy: [{ name: 'asc' }],
            include: {
                contacts: {
                    where: { isPrimary: true },
                    take: 3,
                    orderBy: [{ order: 'asc' }],
                },
                _count: { select: { projects: true } },
            },
        });
        res.json({ clients });
    } catch (err) {
        next(err);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const client = await prisma.client.findUnique({
            where: { id: req.params.id },
            include: clientInclude,
        });
        if (!client) throw httpError(404, 'Client not found');
        res.json({ client: serializeClient(client) });
    } catch (err) {
        next(err);
    }
});

router.post('/', async (req, res, next) => {
    try {
        requireClientManage(req);
        const data = clientBodySchema.parse(req.body);
        const contacts = normalizeContacts(data.contacts || []);
        const typeIds = Array.from(new Set(data.ticketTypeIds || []));
        const client = await prisma.client.create({
            data: {
                name: data.name.trim(),
                address: data.address?.trim() || null,
                city: data.city?.trim() || null,
                postalCode: data.postalCode?.trim() || null,
                country: data.country?.trim() || null,
                phone: data.phone?.trim() || null,
                email: data.email?.trim() || null,
                website: data.website?.trim() || null,
                notes: data.notes?.trim() || null,
                isActive: data.isActive ?? true,
                contacts: contacts.length
                    ? { create: contacts }
                    : undefined,
                allowedTicketTypes: typeIds.length
                    ? { create: typeIds.map((id) => ({ requestTypeId: id })) }
                    : undefined,
            },
            include: clientInclude,
        });
        res.status(201).json({ client: serializeClient(client) });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        requireClientManage(req);
        const data = clientBodySchema.partial().parse(req.body);
        const existing = await prisma.client.findUnique({
            where: { id: req.params.id },
            select: { id: true },
        });
        if (!existing) throw httpError(404, 'Client not found');

        const updateData = {};
        if (data.name !== undefined) updateData.name = data.name.trim();
        if (data.address !== undefined) updateData.address = data.address?.trim() || null;
        if (data.city !== undefined) updateData.city = data.city?.trim() || null;
        if (data.postalCode !== undefined) {
            updateData.postalCode = data.postalCode?.trim() || null;
        }
        if (data.country !== undefined) updateData.country = data.country?.trim() || null;
        if (data.phone !== undefined) updateData.phone = data.phone?.trim() || null;
        if (data.email !== undefined) updateData.email = data.email?.trim() || null;
        if (data.website !== undefined) updateData.website = data.website?.trim() || null;
        if (data.notes !== undefined) updateData.notes = data.notes?.trim() || null;
        if (data.isActive !== undefined) updateData.isActive = data.isActive;

        const client = await prisma.$transaction(async (tx) => {
            if (data.contacts !== undefined) {
                await tx.clientContact.deleteMany({
                    where: { clientId: req.params.id },
                });
                const contacts = normalizeContacts(data.contacts);
                if (contacts.length) {
                    await tx.clientContact.createMany({
                        data: contacts.map((c) => ({
                            ...c,
                            clientId: req.params.id,
                        })),
                    });
                }
            }
            // Replace the client's allowed ticket types when provided.
            if (data.ticketTypeIds !== undefined) {
                await tx.clientTicketType.deleteMany({
                    where: { clientId: req.params.id },
                });
                const typeIds = Array.from(new Set(data.ticketTypeIds));
                if (typeIds.length) {
                    await tx.clientTicketType.createMany({
                        data: typeIds.map((requestTypeId) => ({
                            clientId: req.params.id,
                            requestTypeId,
                        })),
                        skipDuplicates: true,
                    });
                }
            }
            return tx.client.update({
                where: { id: req.params.id },
                data: updateData,
                include: clientInclude,
            });
        });

        res.json({ client: serializeClient(client) });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        if (!isAdmin(req)) {
            throw httpError(403, 'Only admins can delete clients');
        }
        const linked = await prisma.project.count({
            where: { clientId: req.params.id },
        });
        if (linked > 0) {
            throw httpError(
                400,
                `Cannot delete — ${linked} project(s) still reference this client`,
            );
        }
        await prisma.client.delete({ where: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) {
        if (err.code === 'P2025') return next(httpError(404, 'Client not found'));
        next(err);
    }
});

module.exports = router;
