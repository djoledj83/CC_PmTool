const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    requireAdminRole,
    assertProjectRead,
} = require('../lib/permissions');

const router = express.Router();

router.use(requireAuth);

const createSchema = z.object({
    projectId: z.string().min(1),
    name: z.string().min(1).max(100),
    color: z.string().max(40).optional().nullable(),
});

const updateSchema = z.object({
    name: z.string().min(1).max(100).optional(),
    color: z.string().max(40).optional().nullable(),
    order: z.number().int().optional(),
});

const reorderSchema = z.object({
    projectId: z.string().min(1),
    order: z.array(z.string().min(1)),
});

const phaseInclude = {
    // Exclude soft-deleted tasks from the phase's task counter so a
    // restored / deleted task is reflected immediately.
    _count: {
        select: { tasks: { where: { deletedAt: null } } },
    },
};

async function ensureProjectExists(projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw httpError(404, 'Project not found');
    return project;
}

async function loadPhaseOr404(phaseId) {
    const phase = await prisma.phase.findUnique({
        where: { id: phaseId },
        include: { project: true },
    });
    if (!phase) throw httpError(404, 'Phase not found');
    return phase;
}

router.get('/', async (req, res, next) => {
    try {
        const { projectId } = req.query;
        if (!projectId) throw httpError(400, 'projectId is required');
        await assertProjectRead(req, projectId);

        const phases = await prisma.phase.findMany({
            where: { projectId },
            orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
            include: phaseInclude,
        });
        res.json({ phases });
    } catch (err) {
        next(err);
    }
});

router.post('/', async (req, res, next) => {
    try {
        requireAdminRole(req);
        const { projectId, name, color } = createSchema.parse(req.body);
        await ensureProjectExists(projectId);

        const last = await prisma.phase.findFirst({
            where: { projectId },
            orderBy: { order: 'desc' },
        });

        const phase = await prisma.phase.create({
            data: {
                projectId,
                name,
                color: color || null,
                order: (last?.order ?? -1) + 1,
            },
            include: phaseInclude,
        });
        res.status(201).json({ phase });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        requireAdminRole(req);
        await loadPhaseOr404(req.params.id);
        const data = updateSchema.parse(req.body);

        const phase = await prisma.phase.update({
            where: { id: req.params.id },
            data,
            include: phaseInclude,
        });
        res.json({ phase });
    } catch (err) {
        next(err);
    }
});

router.post('/reorder', async (req, res, next) => {
    try {
        requireAdminRole(req);
        const { projectId, order } = reorderSchema.parse(req.body);
        await ensureProjectExists(projectId);

        const phases = await prisma.phase.findMany({
            where: { projectId },
            select: { id: true },
        });
        const validIds = new Set(phases.map((p) => p.id));
        const ops = order
            .filter((id) => validIds.has(id))
            .map((id, idx) =>
                prisma.phase.update({ where: { id }, data: { order: idx } }),
            );
        await prisma.$transaction(ops);

        const updated = await prisma.phase.findMany({
            where: { projectId },
            orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
            include: phaseInclude,
        });
        res.json({ phases: updated });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        requireAdminRole(req);
        await loadPhaseOr404(req.params.id);
        await prisma.phase.delete({ where: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
