// Global, admin-defined extra fields for the raise-ticket form.
//
//   GET    /api/ticket-fields          -> list ordered by position (authed)
//   POST   /api/ticket-fields          -> create (admin)
//   PATCH  /api/ticket-fields/:id       -> update (admin)
//   DELETE /api/ticket-fields/:id       -> delete (admin)
//   POST   /api/ticket-fields/reorder   -> set order from id list (admin)
//
// TERMINAL / CLIENT are built-in pickers and may exist at most once.
// SELECT fields must carry a non-empty `options` string array.

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const { isAdmin } = require('../lib/permissions');

const router = express.Router();
router.use(requireAuth);

const FieldType = z.enum(['TERMINAL', 'CLIENT', 'TEXT', 'SELECT', 'YESNO']);

const baseSchema = z.object({
    type: FieldType,
    label: z.string().trim().min(1).max(120),
    options: z.array(z.string().trim().min(1).max(120)).optional().nullable(),
    required: z.boolean().optional(),
    active: z.boolean().optional(),
    // 'none'/absent => global field; otherwise a ticket request type id.
    requestTypeId: z.string().min(1).optional().nullable(),
});

// Resolve the scope a request is targeting: a concrete request type id,
// or null for the global set. 'none' and '' both mean global.
function resolveScope(raw) {
    if (raw === undefined || raw === null || raw === '' || raw === 'none') {
        return null;
    }
    return String(raw);
}

function requireAdmin(req) {
    if (!isAdmin(req)) throw httpError(403, 'Admins only.');
}

// Normalise options: only SELECT keeps a (deduped, non-empty) list.
function normaliseOptions(type, options) {
    if (type !== 'SELECT') return null;
    const list = Array.from(
        new Set((options || []).map((s) => s.trim()).filter(Boolean)),
    );
    if (list.length === 0) {
        throw httpError(400, 'A multi-select field needs at least one option.');
    }
    return list;
}

router.get('/', async (req, res, next) => {
    try {
        // ?requestTypeId=none -> global set; =<id> -> that type's fields;
        // omitted entirely -> everything (used when building a raise form).
        const where = {};
        if (req.query.requestTypeId !== undefined) {
            where.requestTypeId = resolveScope(req.query.requestTypeId);
        }
        const fields = await prisma.ticketFieldDef.findMany({
            where,
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        });
        res.json({ fields });
    } catch (err) {
        next(err);
    }
});

// Effective fields for a raise form: active global fields + the chosen
// request type's active fields, global first then by position.
router.get('/effective', async (req, res, next) => {
    try {
        const scope = resolveScope(req.query.requestTypeId);
        const fields = await prisma.ticketFieldDef.findMany({
            where: {
                active: true,
                OR: [
                    { requestTypeId: null },
                    ...(scope ? [{ requestTypeId: scope }] : []),
                ],
            },
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        });
        fields.sort(
            (a, b) =>
                (a.requestTypeId ? 1 : 0) - (b.requestTypeId ? 1 : 0) ||
                a.position - b.position,
        );
        res.json({ fields });
    } catch (err) {
        next(err);
    }
});

router.post('/', async (req, res, next) => {
    try {
        requireAdmin(req);
        const data = baseSchema.parse(req.body);
        const scope = resolveScope(data.requestTypeId);
        if (scope) {
            const rt = await prisma.ticketRequestType.findUnique({
                where: { id: scope },
                select: { id: true },
            });
            if (!rt) throw httpError(400, 'Request type not found.');
        }
        // Built-in pickers are singletons WITHIN their scope (one terminal
        // / client field per type, and one in the global set).
        if (data.type === 'TERMINAL' || data.type === 'CLIENT') {
            const existing = await prisma.ticketFieldDef.findFirst({
                where: { type: data.type, requestTypeId: scope },
                select: { id: true },
            });
            if (existing) {
                throw httpError(
                    409,
                    `A ${data.type.toLowerCase()} field already exists here.`,
                );
            }
        }
        const options = normaliseOptions(data.type, data.options);
        const last = await prisma.ticketFieldDef.findFirst({
            where: { requestTypeId: scope },
            orderBy: { position: 'desc' },
            select: { position: true },
        });
        const field = await prisma.ticketFieldDef.create({
            data: {
                type: data.type,
                label: data.label,
                options,
                required: data.required ?? false,
                active: data.active ?? true,
                requestTypeId: scope,
                position: (last?.position ?? -1) + 1,
            },
        });
        res.status(201).json({ field });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        requireAdmin(req);
        const existing = await prisma.ticketFieldDef.findUnique({
            where: { id: req.params.id },
        });
        if (!existing) throw httpError(404, 'Field not found.');
        // Type + scope are immutable after creation (keeps values coherent).
        const data = baseSchema
            .partial()
            .omit({ type: true, requestTypeId: true })
            .parse(req.body);
        const update = {};
        if (data.label !== undefined) update.label = data.label;
        if (data.required !== undefined) update.required = data.required;
        if (data.active !== undefined) update.active = data.active;
        if (data.options !== undefined) {
            update.options = normaliseOptions(existing.type, data.options);
        }
        const field = await prisma.ticketFieldDef.update({
            where: { id: req.params.id },
            data: update,
        });
        res.json({ field });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        requireAdmin(req);
        await prisma.ticketFieldDef
            .delete({ where: { id: req.params.id } })
            .catch(() => {
                throw httpError(404, 'Field not found.');
            });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.post('/reorder', async (req, res, next) => {
    try {
        requireAdmin(req);
        const { ids } = z
            .object({ ids: z.array(z.string()).min(1) })
            .parse(req.body);
        await prisma.$transaction(
            ids.map((id, i) =>
                prisma.ticketFieldDef.update({
                    where: { id },
                    data: { position: i },
                }),
            ),
        );
        const fields = await prisma.ticketFieldDef.findMany({
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        });
        res.json({ fields });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
