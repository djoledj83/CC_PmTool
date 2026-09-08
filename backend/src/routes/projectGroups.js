// Per-user project groups — a personal way to organise the Projects
// list and sidebar. Many-to-many: a project can belong to several
// groups. Membership is purely organisational and never changes the
// project itself.
//
//   GET    /api/project-groups                      list MY groups (+ project ids)
//   POST   /api/project-groups                       create my group
//   PATCH  /api/project-groups/:id                    rename / recolor (own only)
//   DELETE /api/project-groups/:id                    delete           (own only)
//   PUT    /api/project-groups/:id/projects           set members      (own only)
//
// Groups are private to the user who created them: every user can make
// and manage their own groups, and only ever sees their own.
const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');

const router = express.Router();
router.use(requireAuth);

const createSchema = z.object({
    name: z.string().trim().min(1).max(80),
    color: z.string().trim().max(30).optional().nullable(),
});

const patchSchema = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    color: z.string().trim().max(30).optional().nullable(),
    position: z.number().int().min(0).max(100000).optional(),
});

const membersSchema = z.object({
    projectIds: z.array(z.string().min(1)).max(5000),
});

function serialize(group) {
    return {
        id: group.id,
        name: group.name,
        color: group.color || null,
        position: group.position,
        projectIds: (group.members || []).map((m) => m.projectId),
        projectCount: group._count?.members ?? (group.members || []).length,
        createdAt: group.createdAt,
    };
}

// Fetch a group only if it belongs to the current user, else 404.
async function getOwnGroup(id, userId) {
    const group = await prisma.projectGroup.findUnique({ where: { id } });
    if (!group || group.createdById !== userId) {
        throw httpError(404, 'Group not found');
    }
    return group;
}

// GET / — the current user's groups with their project ids (so the FE
// can filter and show counts). Ordered by position then name.
router.get('/', async (req, res, next) => {
    try {
        const groups = await prisma.projectGroup.findMany({
            where: { createdById: req.user.id },
            orderBy: [{ position: 'asc' }, { name: 'asc' }],
            include: {
                members: { select: { projectId: true } },
                _count: { select: { members: true } },
            },
        });
        res.json({ groups: groups.map(serialize) });
    } catch (err) {
        next(err);
    }
});

router.post('/', async (req, res, next) => {
    try {
        const data = createSchema.parse(req.body);
        const max = await prisma.projectGroup.aggregate({
            where: { createdById: req.user.id },
            _max: { position: true },
        });
        const group = await prisma.projectGroup.create({
            data: {
                name: data.name,
                color: data.color || null,
                position: (max._max.position ?? 0) + 1,
                createdById: req.user.id,
            },
            include: {
                members: { select: { projectId: true } },
                _count: { select: { members: true } },
            },
        });
        res.status(201).json({ group: serialize(group) });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        const data = patchSchema.parse(req.body);
        const existing = await getOwnGroup(req.params.id, req.user.id);
        const group = await prisma.projectGroup.update({
            where: { id: existing.id },
            data: {
                ...(data.name !== undefined ? { name: data.name } : {}),
                ...(data.color !== undefined ? { color: data.color || null } : {}),
                ...(data.position !== undefined
                    ? { position: data.position }
                    : {}),
            },
            include: {
                members: { select: { projectId: true } },
                _count: { select: { members: true } },
            },
        });
        res.json({ group: serialize(group) });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const existing = await getOwnGroup(req.params.id, req.user.id);
        // Cascade drops the membership rows; projects are untouched.
        await prisma.projectGroup.delete({ where: { id: existing.id } });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// PUT /:id/projects — replace the group's membership with the given set
// of project ids in one call (the manage-members dialog drives this).
router.put('/:id/projects', async (req, res, next) => {
    try {
        const { projectIds } = membersSchema.parse(req.body);
        const existing = await getOwnGroup(req.params.id, req.user.id);

        // Keep only ids that point at real projects.
        const valid = await prisma.project.findMany({
            where: { id: { in: projectIds } },
            select: { id: true },
        });
        const validIds = valid.map((p) => p.id);

        await prisma.$transaction([
            prisma.projectGroupMembership.deleteMany({
                where: { groupId: existing.id },
            }),
            prisma.projectGroupMembership.createMany({
                data: validIds.map((projectId) => ({
                    groupId: existing.id,
                    projectId,
                })),
                skipDuplicates: true,
            }),
        ]);

        const group = await prisma.projectGroup.findUnique({
            where: { id: existing.id },
            include: {
                members: { select: { projectId: true } },
                _count: { select: { members: true } },
            },
        });
        res.json({ group: serialize(group) });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
