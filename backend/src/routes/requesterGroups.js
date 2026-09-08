// Admin-defined requester groups. A requester can add a whole group as
// ticket participants in one go.
//
//   GET    /api/requester-groups            -> list groups + members (any auth)
//   GET    /api/requester-groups/candidates -> pickable users (any auth)
//   POST   /api/requester-groups            -> create (admin)
//   PATCH  /api/requester-groups/:id        -> rename / set members (admin)
//   DELETE /api/requester-groups/:id        -> delete (admin)

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const { isAdmin } = require('../lib/permissions');

const router = express.Router();
router.use(requireAuth);

const upsertSchema = z.object({
    name: z.string().trim().min(1).max(120),
    memberIds: z.array(z.string()).optional(),
});

function serialize(g) {
    return {
        id: g.id,
        name: g.name,
        members: (g.members || []).map((m) => ({
            id: m.userId,
            name: m.user?.name || m.user?.email || null,
            email: m.user?.email || null,
        })),
    };
}

const GROUP_INCLUDE = {
    members: {
        select: {
            userId: true,
            user: { select: { id: true, name: true, email: true } },
        },
    },
};

// Keep only active user ids.
async function validUserIds(ids) {
    const unique = Array.from(new Set((ids || []).filter(Boolean)));
    if (unique.length === 0) return [];
    const users = await prisma.user.findMany({
        where: { id: { in: unique }, status: 'ACTIVE' },
        select: { id: true },
    });
    return users.map((u) => u.id);
}

// Pickable people for the "add co-requester" UI on the portal. Readable
// by any signed-in user (requesters need it). Minimal fields only.
router.get('/candidates', async (req, res, next) => {
    try {
        const users = await prisma.user.findMany({
            where: { status: 'ACTIVE' },
            select: { id: true, name: true, email: true, avatarUrl: true },
            orderBy: { name: 'asc' },
        });
        res.json({ users });
    } catch (err) {
        next(err);
    }
});

router.get('/', async (req, res, next) => {
    try {
        const groups = await prisma.requesterGroup.findMany({
            include: GROUP_INCLUDE,
            orderBy: { name: 'asc' },
        });
        res.json({ groups: groups.map(serialize) });
    } catch (err) {
        next(err);
    }
});

router.post('/', async (req, res, next) => {
    try {
        if (!isAdmin(req)) throw httpError(403, 'Admins only.');
        const data = upsertSchema.parse(req.body);
        const memberIds = await validUserIds(data.memberIds);
        const created = await prisma.requesterGroup.create({
            data: {
                name: data.name,
                members: { create: memberIds.map((userId) => ({ userId })) },
            },
            include: GROUP_INCLUDE,
        });
        res.status(201).json({ group: serialize(created) });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        if (!isAdmin(req)) throw httpError(403, 'Admins only.');
        const data = upsertSchema.partial().parse(req.body);
        const existing = await prisma.requesterGroup.findUnique({
            where: { id: req.params.id },
            select: { id: true },
        });
        if (!existing) throw httpError(404, 'Group not found.');
        const update = {};
        if (data.name !== undefined) update.name = data.name;
        if (data.memberIds !== undefined) {
            const memberIds = await validUserIds(data.memberIds);
            update.members = {
                deleteMany: {},
                create: memberIds.map((userId) => ({ userId })),
            };
        }
        const updated = await prisma.requesterGroup.update({
            where: { id: req.params.id },
            data: update,
            include: GROUP_INCLUDE,
        });
        res.json({ group: serialize(updated) });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        if (!isAdmin(req)) throw httpError(403, 'Admins only.');
        await prisma.requesterGroup
            .delete({ where: { id: req.params.id } })
            .catch(() => {
                throw httpError(404, 'Group not found.');
            });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
