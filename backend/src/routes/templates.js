const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const {
    CAPABILITIES,
    requireAdminOrCapabilityMiddleware,
} = require('../lib/permissions');

// Template management is admin-only by default, but admins can delegate
// the same power via the `template:manage` capability override on a
// specific user without making them a full admin.
const requireAdmin = requireAdminOrCapabilityMiddleware(
    CAPABILITIES.TEMPLATE_MANAGE,
);
const { httpError } = require('../middleware/error');

const router = express.Router();

router.use(requireAuth);

// =====================================================================
// Phase templates (global library of phase names admins can pick from
// when creating phases on a project, and that seed brand-new projects).
// =====================================================================

// Palette of color tokens admins can pick from for phase templates.
// Matches the frontend PHASE_PALETTE so seeded phases reliably resolve
// to the corresponding bg/header/ring/column classes without us having
// to ship a full class-string list across the wire.
const PHASE_TEMPLATE_COLORS = [
    'sky',
    'emerald',
    'violet',
    'amber',
    'rose',
    'cyan',
    'fuchsia',
    'lime',
];

const phaseCreateSchema = z.object({
    name: z.string().min(1).max(60),
    order: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    // `null` clears the colour (back to "auto"); omitting the key
    // entirely leaves the existing value untouched on PATCH.
    color: z.enum(PHASE_TEMPLATE_COLORS).nullable().optional(),
});

const phaseUpdateSchema = phaseCreateSchema.partial();

const phaseReorderSchema = z.object({
    ids: z.array(z.string().min(1)).min(1),
});

// All authenticated users can read the templates so dropdowns render
// the active set; only admins can mutate them.
router.get('/phases', async (req, res, next) => {
    try {
        const includeInactive =
            req.query.includeInactive === '1' || req.query.includeInactive === 'true';
        const where = includeInactive ? {} : { isActive: true };
        const phases = await prisma.phaseTemplate.findMany({
            where,
            orderBy: [{ order: 'asc' }, { name: 'asc' }],
        });
        res.json({ phases });
    } catch (err) {
        next(err);
    }
});

router.post('/phases', requireAdmin, async (req, res, next) => {
    try {
        const data = phaseCreateSchema.parse(req.body);
        const last = await prisma.phaseTemplate.findFirst({
            orderBy: { order: 'desc' },
            select: { order: true },
        });
        const order = data.order ?? (last ? last.order + 1 : 0);
        const phase = await prisma.phaseTemplate.create({
            data: {
                name: data.name.trim(),
                order,
                isActive: data.isActive ?? true,
                color: data.color ?? null,
            },
        });
        res.status(201).json({ phase });
    } catch (err) {
        if (err.code === 'P2002') {
            return next(httpError(400, 'A phase with that name already exists'));
        }
        next(err);
    }
});

router.patch('/phases/:id', requireAdmin, async (req, res, next) => {
    try {
        const data = phaseUpdateSchema.parse(req.body);
        const updateData = { ...data };
        if (typeof data.name === 'string') updateData.name = data.name.trim();
        // Forwarding `color: null` is intentional — it clears the row
        // back to "auto colour" mode. The Zod schema accepts null.
        const phase = await prisma.phaseTemplate.update({
            where: { id: req.params.id },
            data: updateData,
        });
        // When an admin picks a colour on the template, push it to
        // every project phase that shares this template name so the
        // plan view matches what they configured in Templates.
        if (data.color !== undefined) {
            await prisma.phase.updateMany({
                where: { name: phase.name },
                data: { color: phase.color },
            });
        }
        res.json({ phase });
    } catch (err) {
        if (err.code === 'P2025') return next(httpError(404, 'Phase not found'));
        if (err.code === 'P2002') {
            return next(httpError(400, 'A phase with that name already exists'));
        }
        next(err);
    }
});

router.delete('/phases/:id', requireAdmin, async (req, res, next) => {
    try {
        await prisma.phaseTemplate.delete({ where: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) {
        if (err.code === 'P2025') return next(httpError(404, 'Phase not found'));
        next(err);
    }
});

// Reorder by sending the ids array in the desired order. We rewrite all
// `order` values atomically so the list is contiguous afterwards.
router.post('/phases/reorder', requireAdmin, async (req, res, next) => {
    try {
        const { ids } = phaseReorderSchema.parse(req.body);
        await prisma.$transaction(
            ids.map((id, idx) =>
                prisma.phaseTemplate.update({
                    where: { id },
                    data: { order: idx },
                }),
            ),
        );
        const phases = await prisma.phaseTemplate.findMany({
            orderBy: [{ order: 'asc' }, { name: 'asc' }],
        });
        res.json({ phases });
    } catch (err) {
        next(err);
    }
});

// =====================================================================
// Priority options (admin-customisable label/color/order/visibility for
// each TaskPriority/ProjectPriority enum value).
// =====================================================================

const PRIORITY_SCOPES = ['TASK', 'PROJECT'];
// Whitelist of color tokens the frontend understands. Keeps user input
// from injecting arbitrary class strings.
const PRIORITY_COLORS = [
    'slate',
    'sky',
    'emerald',
    'amber',
    'rose',
    'violet',
];

const priorityCreateSchema = z.object({
    scope: z.enum(PRIORITY_SCOPES),
    key: z.string().min(1).max(40),
    label: z.string().min(1).max(40),
    color: z.enum(PRIORITY_COLORS).optional(),
    order: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
});

const priorityUpdateSchema = z
    .object({
        label: z.string().min(1).max(40).optional(),
        color: z.enum(PRIORITY_COLORS).optional(),
        order: z.number().int().min(0).optional(),
        isActive: z.boolean().optional(),
    })
    .strict();

router.get('/priorities', async (req, res, next) => {
    try {
        const scope = req.query.scope
            ? String(req.query.scope).toUpperCase()
            : null;
        const where = scope && PRIORITY_SCOPES.includes(scope) ? { scope } : {};
        const priorities = await prisma.priorityOption.findMany({
            where,
            orderBy: [{ scope: 'asc' }, { order: 'asc' }, { label: 'asc' }],
        });
        res.json({ priorities });
    } catch (err) {
        next(err);
    }
});

router.post('/priorities', requireAdmin, async (req, res, next) => {
    try {
        const data = priorityCreateSchema.parse(req.body);
        const last = await prisma.priorityOption.findFirst({
            where: { scope: data.scope },
            orderBy: { order: 'desc' },
            select: { order: true },
        });
        const order = data.order ?? (last ? last.order + 1 : 0);
        const priority = await prisma.priorityOption.create({
            data: {
                scope: data.scope,
                key: data.key.trim().toUpperCase(),
                label: data.label.trim(),
                color: data.color ?? 'slate',
                order,
                isActive: data.isActive ?? true,
            },
        });
        res.status(201).json({ priority });
    } catch (err) {
        if (err.code === 'P2002') {
            return next(
                httpError(
                    400,
                    'A priority with that key already exists for this scope',
                ),
            );
        }
        next(err);
    }
});

router.patch('/priorities/:id', requireAdmin, async (req, res, next) => {
    try {
        const data = priorityUpdateSchema.parse(req.body);
        const updateData = { ...data };
        if (typeof data.label === 'string') updateData.label = data.label.trim();
        const priority = await prisma.priorityOption.update({
            where: { id: req.params.id },
            data: updateData,
        });
        res.json({ priority });
    } catch (err) {
        if (err.code === 'P2025') return next(httpError(404, 'Priority not found'));
        next(err);
    }
});

router.delete('/priorities/:id', requireAdmin, async (req, res, next) => {
    try {
        await prisma.priorityOption.delete({ where: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) {
        if (err.code === 'P2025') return next(httpError(404, 'Priority not found'));
        next(err);
    }
});

router.post('/priorities/reorder', requireAdmin, async (req, res, next) => {
    try {
        const { scope, ids } = z
            .object({
                scope: z.enum(PRIORITY_SCOPES),
                ids: z.array(z.string().min(1)).min(1),
            })
            .parse(req.body);
        await prisma.$transaction(
            ids.map((id, idx) =>
                prisma.priorityOption.update({
                    where: { id },
                    data: { order: idx },
                }),
            ),
        );
        const priorities = await prisma.priorityOption.findMany({
            where: { scope },
            orderBy: [{ order: 'asc' }, { label: 'asc' }],
        });
        res.json({ priorities });
    } catch (err) {
        next(err);
    }
});

// =====================================================================
// Status options (admin-customisable label/color/order/visibility for
// each ProjectStatus enum value). Same shape as priorities — see
// PriorityOption notes for why we keep the enum as the source of truth
// and treat this table as the display layer.
//
// Only PROJECT scope is wired today; the column is left flexible so a
// future TASK scope is a single extra row set away.
// =====================================================================

const STATUS_SCOPES = ['PROJECT', 'TASK'];
const STATUS_COLORS = PRIORITY_COLORS; // same palette

const statusCreateSchema = z.object({
    scope: z.enum(STATUS_SCOPES),
    key: z.string().min(1).max(40),
    label: z.string().min(1).max(40),
    color: z.enum(STATUS_COLORS).optional(),
    order: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
});

const statusUpdateSchema = z
    .object({
        label: z.string().min(1).max(40).optional(),
        color: z.enum(STATUS_COLORS).optional(),
        order: z.number().int().min(0).optional(),
        isActive: z.boolean().optional(),
    })
    .strict();

router.get('/statuses', async (req, res, next) => {
    try {
        const scope = req.query.scope
            ? String(req.query.scope).toUpperCase()
            : null;
        const where = scope && STATUS_SCOPES.includes(scope) ? { scope } : {};
        const statuses = await prisma.statusOption.findMany({
            where,
            orderBy: [{ scope: 'asc' }, { order: 'asc' }, { label: 'asc' }],
        });
        res.json({ statuses });
    } catch (err) {
        next(err);
    }
});

router.post('/statuses', requireAdmin, async (req, res, next) => {
    try {
        const data = statusCreateSchema.parse(req.body);
        // Only PROJECT statuses are truly customizable today — Task.status
        // is still a fixed enum (TODO/IN_PROGRESS/ON_HOLD/DONE) that the
        // task API validates against, so a custom TASK status would be
        // selectable but rejected on save. Block creating them until task
        // status is converted to free-form.
        if (data.scope === 'TASK') {
            throw httpError(
                400,
                'Custom task statuses are not supported yet — task statuses are fixed.',
            );
        }
        const last = await prisma.statusOption.findFirst({
            where: { scope: data.scope },
            orderBy: { order: 'desc' },
            select: { order: true },
        });
        const order = data.order ?? (last ? last.order + 1 : 0);
        const status = await prisma.statusOption.create({
            data: {
                scope: data.scope,
                key: data.key.trim().toUpperCase(),
                label: data.label.trim(),
                color: data.color ?? 'slate',
                order,
                isActive: data.isActive ?? true,
            },
        });
        res.status(201).json({ status });
    } catch (err) {
        if (err.code === 'P2002') {
            return next(
                httpError(
                    400,
                    'A status with that key already exists for this scope',
                ),
            );
        }
        next(err);
    }
});

router.patch('/statuses/:id', requireAdmin, async (req, res, next) => {
    try {
        const data = statusUpdateSchema.parse(req.body);
        const updateData = { ...data };
        if (typeof data.label === 'string') updateData.label = data.label.trim();
        const status = await prisma.statusOption.update({
            where: { id: req.params.id },
            data: updateData,
        });
        res.json({ status });
    } catch (err) {
        if (err.code === 'P2025') return next(httpError(404, 'Status not found'));
        next(err);
    }
});

router.delete('/statuses/:id', requireAdmin, async (req, res, next) => {
    try {
        await prisma.statusOption.delete({ where: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) {
        if (err.code === 'P2025') return next(httpError(404, 'Status not found'));
        next(err);
    }
});

router.post('/statuses/reorder', requireAdmin, async (req, res, next) => {
    try {
        const { scope, ids } = z
            .object({
                scope: z.enum(STATUS_SCOPES),
                ids: z.array(z.string().min(1)).min(1),
            })
            .parse(req.body);
        await prisma.$transaction(
            ids.map((id, idx) =>
                prisma.statusOption.update({
                    where: { id },
                    data: { order: idx },
                }),
            ),
        );
        const statuses = await prisma.statusOption.findMany({
            where: { scope },
            orderBy: [{ order: 'asc' }, { label: 'asc' }],
        });
        res.json({ statuses });
    } catch (err) {
        next(err);
    }
});

// =====================================================================
// Generic catalog factory used by /templates/countries and
// /templates/clients. Both expose the same name+order+isActive surface
// — keeping this DRY so a future "categories" or "departments" catalog
// only needs one line to register.
// =====================================================================

const catalogCreateSchema = z.object({
    name: z.string().min(1).max(100),
    order: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
});

const catalogUpdateSchema = catalogCreateSchema.partial();

const catalogReorderSchema = z.object({
    ids: z.array(z.string().min(1)).min(1),
});

function registerCatalog(path, model, label, options = {}) {
    const { beforeDelete } = options;
    // GET — readable by any authenticated user so dropdowns work for
    // non-admins as well. `?includeInactive=1` lets the admin Templates
    // page also surface hidden rows.
    router.get(`/${path}`, async (req, res, next) => {
        try {
            const includeInactive =
                req.query.includeInactive === '1' ||
                req.query.includeInactive === 'true';
            const where = includeInactive ? {} : { isActive: true };
            const items = await prisma[model].findMany({
                where,
                orderBy: [{ order: 'asc' }, { name: 'asc' }],
            });
            res.json({ [path]: items });
        } catch (err) {
            next(err);
        }
    });

    router.post(`/${path}`, requireAdmin, async (req, res, next) => {
        try {
            const data = catalogCreateSchema.parse(req.body);
            const last = await prisma[model].findFirst({
                orderBy: { order: 'desc' },
                select: { order: true },
            });
            const order = data.order ?? (last ? last.order + 1 : 0);
            const item = await prisma[model].create({
                data: {
                    name: data.name.trim(),
                    order,
                    isActive: data.isActive ?? true,
                },
            });
            res.status(201).json({ item });
        } catch (err) {
            if (err.code === 'P2002') {
                return next(
                    httpError(400, `That ${label} already exists`),
                );
            }
            next(err);
        }
    });

    router.patch(`/${path}/:id`, requireAdmin, async (req, res, next) => {
        try {
            const data = catalogUpdateSchema.parse(req.body);
            const updateData = { ...data };
            if (typeof data.name === 'string') {
                updateData.name = data.name.trim();
            }
            const item = await prisma[model].update({
                where: { id: req.params.id },
                data: updateData,
            });
            res.json({ item });
        } catch (err) {
            if (err.code === 'P2025')
                return next(httpError(404, `${label} not found`));
            if (err.code === 'P2002') {
                return next(
                    httpError(400, `That ${label} already exists`),
                );
            }
            next(err);
        }
    });

    router.delete(`/${path}/:id`, requireAdmin, async (req, res, next) => {
        try {
            // Optional in-use guard (e.g. don't delete a client still
            // referenced by a project). Throws an httpError if blocked.
            if (beforeDelete) {
                const item = await prisma[model].findUnique({
                    where: { id: req.params.id },
                });
                if (!item) throw httpError(404, `${label} not found`);
                await beforeDelete(item);
            }
            await prisma[model].delete({ where: { id: req.params.id } });
            res.json({ ok: true });
        } catch (err) {
            if (err.code === 'P2025')
                return next(httpError(404, `${label} not found`));
            next(err);
        }
    });

    router.post(`/${path}/reorder`, requireAdmin, async (req, res, next) => {
        try {
            const { ids } = catalogReorderSchema.parse(req.body);
            await prisma.$transaction(
                ids.map((id, idx) =>
                    prisma[model].update({
                        where: { id },
                        data: { order: idx },
                    }),
                ),
            );
            const items = await prisma[model].findMany({
                orderBy: [{ order: 'asc' }, { name: 'asc' }],
            });
            res.json({ [path]: items });
        } catch (err) {
            next(err);
        }
    });
}

const projectTypeCreateSchema = catalogCreateSchema.extend({
    hideMarkComplete: z.boolean().optional(),
    activityCode: z.string().max(60).optional().nullable(),
});
const projectTypeUpdateSchema = catalogUpdateSchema.extend({
    hideMarkComplete: z.boolean().optional(),
    activityCode: z.string().max(60).optional().nullable(),
});

registerCatalog('countries', 'countryOption', 'country');
registerCatalog('clients', 'clientOption', 'client', {
    // Projects store the client by name (denormalised string). Block
    // removing a client option while any project still references it.
    beforeDelete: async (item) => {
        const linked = await prisma.project.count({
            where: { client: item.name },
        });
        if (linked > 0) {
            throw httpError(
                400,
                `Cannot delete — ${linked} project(s) still use the client "${item.name}".`,
            );
        }
    },
});

router.get('/project-types', async (req, res, next) => {
    try {
        const includeInactive =
            req.query.includeInactive === '1' ||
            req.query.includeInactive === 'true';
        const where = includeInactive ? {} : { isActive: true };
        const items = await prisma.projectTypeOption.findMany({
            where,
            orderBy: [{ order: 'asc' }, { name: 'asc' }],
        });
        res.json({ 'project-types': items });
    } catch (err) {
        next(err);
    }
});

router.post('/project-types', requireAdmin, async (req, res, next) => {
    try {
        const data = projectTypeCreateSchema.parse(req.body);
        const last = await prisma.projectTypeOption.findFirst({
            orderBy: { order: 'desc' },
            select: { order: true },
        });
        const order = data.order ?? (last ? last.order + 1 : 0);
        const item = await prisma.projectTypeOption.create({
            data: {
                name: data.name.trim(),
                order,
                isActive: data.isActive ?? true,
                hideMarkComplete: data.hideMarkComplete ?? false,
                activityCode: data.activityCode?.trim() || null,
            },
        });
        res.status(201).json({ item });
    } catch (err) {
        if (err.code === 'P2002') {
            return next(httpError(400, 'That project type already exists'));
        }
        next(err);
    }
});

router.patch('/project-types/:id', requireAdmin, async (req, res, next) => {
    try {
        const data = projectTypeUpdateSchema.parse(req.body);
        const updateData = { ...data };
        if (typeof data.name === 'string') {
            updateData.name = data.name.trim();
        }
        if (data.activityCode !== undefined) {
            updateData.activityCode = data.activityCode?.trim() || null;
        }
        const item = await prisma.projectTypeOption.update({
            where: { id: req.params.id },
            data: updateData,
        });
        res.json({ item });
    } catch (err) {
        if (err.code === 'P2025') {
            return next(httpError(404, 'project type not found'));
        }
        if (err.code === 'P2002') {
            return next(httpError(400, 'That project type already exists'));
        }
        next(err);
    }
});

router.delete('/project-types/:id', requireAdmin, async (req, res, next) => {
    try {
        await prisma.projectTypeOption.delete({ where: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) {
        if (err.code === 'P2025') {
            return next(httpError(404, 'project type not found'));
        }
        next(err);
    }
});

router.post('/project-types/reorder', requireAdmin, async (req, res, next) => {
    try {
        const { ids } = catalogReorderSchema.parse(req.body);
        await prisma.$transaction(
            ids.map((id, idx) =>
                prisma.projectTypeOption.update({
                    where: { id },
                    data: { order: idx },
                }),
            ),
        );
        const items = await prisma.projectTypeOption.findMany({
            orderBy: [{ order: 'asc' }, { name: 'asc' }],
        });
        res.json({ 'project-types': items });
    } catch (err) {
        next(err);
    }
});

// =====================================================================
// Products — admin-managed catalogue (name + optional code + description)
// that projects pick in place of an Application. Reads are open to every
// authenticated user so the project form's picker renders; writes are
// admin-only.
// =====================================================================
const productCreateSchema = z.object({
    name: z.string().min(1).max(120),
    code: z.string().max(60).optional().nullable(),
    description: z.string().max(2000).optional().nullable(),
    isActive: z.boolean().optional(),
});
const productUpdateSchema = productCreateSchema.partial();

const cleanStr = (v) => {
    if (v === undefined) return undefined;
    const t = (v || '').trim();
    return t ? t : null;
};

router.get('/products', async (req, res, next) => {
    try {
        const includeInactive =
            req.query.includeInactive === '1' ||
            req.query.includeInactive === 'true';
        const where = includeInactive ? {} : { isActive: true };
        const items = await prisma.product.findMany({
            where,
            orderBy: [{ position: 'asc' }, { name: 'asc' }],
        });
        res.json({ products: items });
    } catch (err) {
        next(err);
    }
});

router.post('/products', requireAdmin, async (req, res, next) => {
    try {
        const data = productCreateSchema.parse(req.body);
        const item = await prisma.product.create({
            data: {
                name: data.name.trim(),
                code: cleanStr(data.code),
                description: cleanStr(data.description),
                isActive: data.isActive ?? true,
            },
        });
        res.status(201).json({ item });
    } catch (err) {
        next(err);
    }
});

router.patch('/products/:id', requireAdmin, async (req, res, next) => {
    try {
        const data = productUpdateSchema.parse(req.body);
        const updateData = {};
        if (data.name !== undefined) updateData.name = data.name.trim();
        if (data.code !== undefined) updateData.code = cleanStr(data.code);
        if (data.description !== undefined) {
            updateData.description = cleanStr(data.description);
        }
        if (data.isActive !== undefined) updateData.isActive = data.isActive;
        const item = await prisma.product.update({
            where: { id: req.params.id },
            data: updateData,
        });
        res.json({ item });
    } catch (err) {
        if (err.code === 'P2025') {
            return next(httpError(404, 'Product not found'));
        }
        next(err);
    }
});

router.delete('/products/:id', requireAdmin, async (req, res, next) => {
    try {
        // Don't silently null a product off live projects. Block the
        // delete while any project still references it.
        const linked = await prisma.project.count({
            where: { productId: req.params.id },
        });
        if (linked > 0) {
            throw httpError(
                400,
                `Cannot delete — ${linked} project(s) still use this product. Reassign them first.`,
            );
        }
        await prisma.product.delete({ where: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) {
        if (err.code === 'P2025') {
            return next(httpError(404, 'Product not found'));
        }
        next(err);
    }
});

// =====================================================================
// Entities — admin-managed billing/accounting catalogue (code + optional
// description) that each project is tagged with, used to group hours in
// the logged-time export. Reads open to any authenticated user (project
// form picker); writes admin-only.
// =====================================================================
const entityCreateSchema = z.object({
    code: z.string().min(1).max(60),
    description: z.string().max(2000).optional().nullable(),
    isActive: z.boolean().optional(),
});
const entityUpdateSchema = entityCreateSchema.partial();

router.get('/entities', async (req, res, next) => {
    try {
        const includeInactive =
            req.query.includeInactive === '1' ||
            req.query.includeInactive === 'true';
        const where = includeInactive ? {} : { isActive: true };
        const items = await prisma.entity.findMany({
            where,
            orderBy: [{ position: 'asc' }, { code: 'asc' }],
        });
        res.json({ entities: items });
    } catch (err) {
        next(err);
    }
});

router.post('/entities', requireAdmin, async (req, res, next) => {
    try {
        const data = entityCreateSchema.parse(req.body);
        const item = await prisma.entity.create({
            data: {
                code: data.code.trim(),
                description: cleanStr(data.description),
                isActive: data.isActive ?? true,
            },
        });
        res.status(201).json({ item });
    } catch (err) {
        next(err);
    }
});

router.patch('/entities/:id', requireAdmin, async (req, res, next) => {
    try {
        const data = entityUpdateSchema.parse(req.body);
        const updateData = {};
        if (data.code !== undefined) updateData.code = data.code.trim();
        if (data.description !== undefined) {
            updateData.description = cleanStr(data.description);
        }
        if (data.isActive !== undefined) updateData.isActive = data.isActive;
        const item = await prisma.entity.update({
            where: { id: req.params.id },
            data: updateData,
        });
        res.json({ item });
    } catch (err) {
        if (err.code === 'P2025') {
            return next(httpError(404, 'Entity not found'));
        }
        next(err);
    }
});

router.delete('/entities/:id', requireAdmin, async (req, res, next) => {
    try {
        // Deleting an in-use entity would SetNull it off shared projects,
        // leaving them in the "no entity" state the create/patch rules
        // forbid (and breaking the export grouping). Block it.
        const linked = await prisma.project.count({
            where: { entityId: req.params.id },
        });
        if (linked > 0) {
            throw httpError(
                400,
                `Cannot delete — ${linked} project(s) still use this entity. Reassign them first.`,
            );
        }
        await prisma.entity.delete({ where: { id: req.params.id } });
        res.json({ ok: true });
    } catch (err) {
        if (err.code === 'P2025') {
            return next(httpError(404, 'Entity not found'));
        }
        next(err);
    }
});

// Business units — users pick from this list on their profile page.
// Admins maintain it from the Templates page exactly like the other
// catalogs above.
registerCatalog('business-units', 'businessUnitOption', 'business unit');
// Application-side catalogues. Used by the Releases form on the
// Applications page to populate the "target OS" and "POS terminal"
// multi-select dropdowns.
registerCatalog('app-os', 'appOsOption', 'target OS');
registerCatalog('app-pos-terminals', 'appPosTerminalOption', 'POS terminal');

module.exports = router;
