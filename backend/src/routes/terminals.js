// Terminal catalog (admin-managed). Vendors group models; each model
// carries its OS type. Consumed later by the raise-ticket form so a
// requester can pick Vendor -> Model (which fixes the OS type).
//
//   GET    /api/terminals/vendors            -> vendors (+ model counts)
//   POST   /api/terminals/vendors            -> create vendor (admin)
//   PATCH  /api/terminals/vendors/:id        -> rename / (de)activate (admin)
//   DELETE /api/terminals/vendors/:id        -> delete vendor + models (admin)
//   GET    /api/terminals/models?vendorId=   -> models (optionally by vendor)
//   POST   /api/terminals/models             -> create model (admin)
//   PATCH  /api/terminals/models/:id         -> update model (admin)
//   DELETE /api/terminals/models/:id         -> delete model (admin)

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const { isAdmin } = require('../lib/permissions');

const router = express.Router();
router.use(requireAuth);

const OS = z.enum(['LINUX', 'ANDROID']);

const vendorSchema = z.object({
    name: z.string().trim().min(1).max(120),
    active: z.boolean().optional(),
});

const modelSchema = z.object({
    name: z.string().trim().min(1).max(120),
    osType: OS,
    vendorId: z.string().min(1),
    active: z.boolean().optional(),
});

function requireAdmin(req) {
    if (!isAdmin(req)) throw httpError(403, 'Admins only.');
}

// --- Vendors -----------------------------------------------------------
router.get('/vendors', async (req, res, next) => {
    try {
        const vendors = await prisma.terminalVendor.findMany({
            orderBy: { name: 'asc' },
            include: { _count: { select: { models: true } } },
        });
        res.json({ vendors });
    } catch (err) {
        next(err);
    }
});

router.post('/vendors', async (req, res, next) => {
    try {
        requireAdmin(req);
        const data = vendorSchema.parse(req.body);
        const vendor = await prisma.terminalVendor.create({
            data: { name: data.name, active: data.active ?? true },
            include: { _count: { select: { models: true } } },
        });
        res.status(201).json({ vendor });
    } catch (err) {
        next(err);
    }
});

router.patch('/vendors/:id', async (req, res, next) => {
    try {
        requireAdmin(req);
        const data = vendorSchema.partial().parse(req.body);
        const update = {};
        if (data.name !== undefined) update.name = data.name;
        if (data.active !== undefined) update.active = data.active;
        const vendor = await prisma.terminalVendor
            .update({
                where: { id: req.params.id },
                data: update,
                include: { _count: { select: { models: true } } },
            })
            .catch(() => {
                throw httpError(404, 'Vendor not found.');
            });
        res.json({ vendor });
    } catch (err) {
        next(err);
    }
});

router.delete('/vendors/:id', async (req, res, next) => {
    try {
        requireAdmin(req);
        await prisma.terminalVendor
            .delete({ where: { id: req.params.id } })
            .catch(() => {
                throw httpError(404, 'Vendor not found.');
            });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// --- Models ------------------------------------------------------------
router.get('/models', async (req, res, next) => {
    try {
        const { vendorId } = req.query;
        const models = await prisma.terminalModel.findMany({
            where: vendorId ? { vendorId: String(vendorId) } : undefined,
            orderBy: { name: 'asc' },
            include: { vendor: { select: { id: true, name: true } } },
        });
        res.json({ models });
    } catch (err) {
        next(err);
    }
});

router.post('/models', async (req, res, next) => {
    try {
        requireAdmin(req);
        const data = modelSchema.parse(req.body);
        const vendor = await prisma.terminalVendor.findUnique({
            where: { id: data.vendorId },
            select: { id: true },
        });
        if (!vendor) throw httpError(400, 'Vendor not found.');
        const model = await prisma.terminalModel.create({
            data: {
                name: data.name,
                osType: data.osType,
                vendorId: data.vendorId,
                active: data.active ?? true,
            },
            include: { vendor: { select: { id: true, name: true } } },
        });
        res.status(201).json({ model });
    } catch (err) {
        next(err);
    }
});

router.patch('/models/:id', async (req, res, next) => {
    try {
        requireAdmin(req);
        const data = modelSchema.partial().parse(req.body);
        if (data.vendorId) {
            const vendor = await prisma.terminalVendor.findUnique({
                where: { id: data.vendorId },
                select: { id: true },
            });
            if (!vendor) throw httpError(400, 'Vendor not found.');
        }
        const update = {};
        if (data.name !== undefined) update.name = data.name;
        if (data.osType !== undefined) update.osType = data.osType;
        if (data.vendorId !== undefined) update.vendorId = data.vendorId;
        if (data.active !== undefined) update.active = data.active;
        const model = await prisma.terminalModel
            .update({
                where: { id: req.params.id },
                data: update,
                include: { vendor: { select: { id: true, name: true } } },
            })
            .catch(() => {
                throw httpError(404, 'Model not found.');
            });
        res.json({ model });
    } catch (err) {
        next(err);
    }
});

router.delete('/models/:id', async (req, res, next) => {
    try {
        requireAdmin(req);
        await prisma.terminalModel
            .delete({ where: { id: req.params.id } })
            .catch(() => {
                throw httpError(404, 'Model not found.');
            });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
