// External / important contacts attached to a project — e.g. a
// client representative, a vendor PM, a stakeholder. NOT system users,
// just free-form contact info living alongside the project.
//
// Permissions:
//   - Read: anyone with project read access.
//   - Create / update / delete: admin, manager, or the project owner
//     (so a regular user managing a personal project can also use it).

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    isAdmin,
    isManager,
    assertProjectRead,
} = require('../lib/permissions');
const { logActivityEvent } = require('../lib/activityLog');

const router = express.Router();
router.use(requireAuth);

// Trim and treat blank strings as null so the DB never stores "" for
// optional contact fields.
const optionalString = z
    .string()
    .max(2000)
    .optional()
    .nullable()
    .transform((v) => {
        if (v === undefined || v === null) return undefined;
        const trimmed = v.trim();
        return trimmed.length === 0 ? null : trimmed;
    });

const baseShape = {
    name: z
        .string()
        .min(1, 'Name is required')
        .max(200)
        .transform((v) => v.trim()),
    role: optionalString,
    company: optionalString,
    email: z
        .string()
        .email('Invalid email')
        .max(320)
        .optional()
        .nullable()
        .or(z.literal(''))
        .transform((v) => {
            if (!v) return null;
            const trimmed = v.trim();
            return trimmed || null;
        }),
    phone: optionalString,
    notes: optionalString,
};

const createSchema = z.object({
    projectId: z.string().min(1),
    ...baseShape,
});
const updateSchema = z
    .object({ ...baseShape, name: baseShape.name.optional() })
    .partial();

const contactInclude = {
    createdBy: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
};

// True when the caller may mutate contacts on the given project:
// admin, manager (with read access), or the project owner.
async function canManageContacts(req, project) {
    if (isAdmin(req)) return true;
    if (project.ownerId === req.user.id) return true;
    if (isManager(req)) {
        await assertProjectRead(req, project.id);
        return true;
    }
    return false;
}

async function loadProjectOr404(projectId) {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
            id: true,
            ownerId: true,
            isPersonal: true,
            name: true,
        },
    });
    if (!project) throw httpError(404, 'Project not found');
    return project;
}

// GET /api/project-contacts?projectId=xxx
router.get('/', async (req, res, next) => {
    try {
        const projectId = String(req.query.projectId || '').trim();
        if (!projectId) {
            throw httpError(400, 'projectId is required');
        }
        await assertProjectRead(req, projectId);
        const contacts = await prisma.projectContact.findMany({
            where: { projectId },
            orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
            include: contactInclude,
        });
        res.json({ contacts });
    } catch (err) {
        next(err);
    }
});

// POST /api/project-contacts
router.post('/', async (req, res, next) => {
    try {
        const data = createSchema.parse(req.body);
        const project = await loadProjectOr404(data.projectId);
        if (!(await canManageContacts(req, project))) {
            throw httpError(
                403,
                'You do not have permission to add contacts to this project',
            );
        }
        const created = await prisma.projectContact.create({
            data: {
                projectId: project.id,
                createdById: req.user.id,
                name: data.name,
                role: data.role ?? null,
                company: data.company ?? null,
                email: data.email ?? null,
                phone: data.phone ?? null,
                notes: data.notes ?? null,
            },
            include: contactInclude,
        });

        // Audit so the project's activity feed reflects who added the
        // contact. Not a notification — contacts are "background" data.
        try {
            await logActivityEvent({
                type: 'PROJECT_CONTACT_ADDED',
                actorId: req.user.id,
                projectId: project.id,
                message: created.name,
                meta: { contactId: created.id },
            });
        } catch (auditErr) {
            console.warn(
                '[contacts] could not audit add:',
                auditErr.message,
            );
        }

        res.status(201).json({ contact: created });
    } catch (err) {
        next(err);
    }
});

// PATCH /api/project-contacts/:id
router.patch('/:id', async (req, res, next) => {
    try {
        const existing = await prisma.projectContact.findUnique({
            where: { id: req.params.id },
            include: contactInclude,
        });
        if (!existing) throw httpError(404, 'Contact not found');
        const project = await loadProjectOr404(existing.projectId);
        if (!(await canManageContacts(req, project))) {
            throw httpError(
                403,
                'You do not have permission to edit this contact',
            );
        }
        const data = updateSchema.parse(req.body);
        // Strip undefined keys so we don't blank out fields the client
        // didn't touch.
        const patch = {};
        for (const key of [
            'name',
            'role',
            'company',
            'email',
            'phone',
            'notes',
        ]) {
            if (data[key] !== undefined) patch[key] = data[key];
        }
        const updated = await prisma.projectContact.update({
            where: { id: existing.id },
            data: patch,
            include: contactInclude,
        });

        try {
            await logActivityEvent({
                type: 'PROJECT_CONTACT_UPDATED',
                actorId: req.user.id,
                projectId: project.id,
                message: updated.name,
                meta: { contactId: updated.id },
            });
        } catch (auditErr) {
            console.warn(
                '[contacts] could not audit update:',
                auditErr.message,
            );
        }

        res.json({ contact: updated });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/project-contacts/:id
router.delete('/:id', async (req, res, next) => {
    try {
        const existing = await prisma.projectContact.findUnique({
            where: { id: req.params.id },
            select: {
                id: true,
                projectId: true,
                name: true,
            },
        });
        if (!existing) throw httpError(404, 'Contact not found');
        const project = await loadProjectOr404(existing.projectId);
        if (!(await canManageContacts(req, project))) {
            throw httpError(
                403,
                'You do not have permission to delete this contact',
            );
        }
        await prisma.projectContact.delete({ where: { id: existing.id } });

        try {
            await logActivityEvent({
                type: 'PROJECT_CONTACT_REMOVED',
                actorId: req.user.id,
                projectId: project.id,
                message: existing.name,
                meta: { contactId: existing.id },
            });
        } catch (auditErr) {
            console.warn(
                '[contacts] could not audit remove:',
                auditErr.message,
            );
        }

        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
