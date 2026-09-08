// Change Requests — chargeable additive scope attached to a Project.
//
// API surface (mounted at /api):
//
//   GET    /api/projects/:projectId/change-requests   -> list CRs of a project
//   POST   /api/projects/:projectId/change-requests   -> create a CR
//   GET    /api/change-requests/:id                   -> single CR (with parent project summary)
//   PATCH  /api/change-requests/:id                   -> update CR
//   DELETE /api/change-requests/:id                   -> delete CR
//
// Permissions:
//   - LIST / READ : anyone with project read access.
//   - CREATE      : cr:create capability (default: ADMIN + MANAGER).
//   - EDIT        : cr:edit capability (default: ADMIN + MANAGER).
//   - DELETE      : cr:delete capability (default: ADMIN only).
//
// Status semantics mirror Project:
//   - status comes from the ProjectStatus enum and shares the same
//     admin-managed StatusOption pipeline (scope = PROJECT).
//   - "deleted" CRs are hard-deleted today — they vanish from the
//     project's contracted-total rollup. There's no soft-delete; if
//     that's ever needed, add Status:ARCHIVED + filter or a deletedAt
//     column.
//
// Currency for amounts is inherited at query time from the parent
// project (not stored on the CR) — this is the user's policy: every
// CR is billed in the project's currency.

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    isAdmin,
    assertProjectRead,
    assertProjectWritable,
    CAPABILITIES,
    hasCapability,
} = require('../lib/permissions');
const { generateChangeRequestCode } = require('../lib/codes');
const { logActivityEvent } = require('../lib/activityLog');
const { assertValidProjectStatus } = require('../lib/projectStatuses');

// Two routers because /projects/:projectId/change-requests has the
// projectId in its path, whereas /change-requests/:id is mounted flat.
// Both are exported and wired up from index.js.
const projectScoped = express.Router({ mergeParams: true });
const flat = express.Router();

projectScoped.use(requireAuth);
flat.use(requireAuth);

// ---------------------------------------------------------------------------
// Shared schemas / helpers
// ---------------------------------------------------------------------------

// Status is a free string sharing the admin-managed StatusOption PROJECT
// pipeline with projects. Shape-checked here; membership validated at
// runtime via assertValidProjectStatus.
const ProjectStatus = z.string().min(1).max(40);

// Money: accept null, empty string, or a non-negative number. Coerce
// empty/undefined to null so the form can clear a value.
const optionalMoney = z
    .union([z.number().nonnegative().finite(), z.string(), z.null()])
    .optional()
    .transform((v) => {
        if (v === undefined) return undefined;
        if (v === null || v === '') return null;
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n) || n < 0) return null;
        return Math.round(n * 100) / 100;
    });

const optionalHours = z
    .union([z.number().nonnegative().finite(), z.string(), z.null()])
    .optional()
    .transform((v) => {
        if (v === undefined) return undefined;
        if (v === null || v === '') return null;
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n) || n < 0) return null;
        return Math.round(n * 100) / 100;
    });

const createSchema = z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(4000).optional().nullable(),
    status: ProjectStatus.optional(),
    internalAmount: optionalMoney,
    internalPaid: z.boolean().optional(),
    clientAmount: optionalMoney,
    clientPaid: z.boolean().optional(),
    estimatedHours: optionalHours,
});

const updateSchema = z
    .object({
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(4000).optional().nullable(),
        status: ProjectStatus.optional(),
        internalAmount: optionalMoney,
        internalPaid: z.boolean().optional(),
        clientAmount: optionalMoney,
        clientPaid: z.boolean().optional(),
        estimatedHours: optionalHours,
    })
    .strict();

const crInclude = {
    createdBy: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    project: {
        select: {
            id: true,
            code: true,
            name: true,
            // The CR inherits currencies from its parent. We expose
            // them in the API payload so the frontend can render money
            // without a separate project fetch.
            internalCurrency: true,
            clientCurrency: true,
            ownerId: true,
            // Needed by the CR detail page to compute phase-edit
            // gating (matches ProjectDetail: admin OR personal-project
            // owner can manage phases).
            isPersonal: true,
            lifecycle: true,
        },
    },
};

// Decorate a stored CR row with the inherited currencies + a couple of
// computed flags. Currency comes from the parent project (we never
// store it on the CR itself). `internalCurrency`/`clientCurrency`
// surface as siblings of the amount fields so the frontend can render
// money in one place without join logic.
function forApi(cr) {
    if (!cr) return cr;
    const { project, ...rest } = cr;
    return {
        ...rest,
        internalCurrency: project?.internalCurrency || 'EUR',
        clientCurrency: project?.clientCurrency || 'EUR',
        project: project
            ? {
                id: project.id,
                code: project.code,
                name: project.name,
                ownerId: project.ownerId,
                isPersonal: project.isPersonal,
                lifecycle: project.lifecycle,
            }
            : null,
    };
}

async function loadCROr404(id) {
    const cr = await prisma.changeRequest.findUnique({
        where: { id },
        include: crInclude,
    });
    if (!cr) throw httpError(404, 'Change request not found');
    return cr;
}

// Set paidAt to "now" when the boolean flips ON, clear it when the
// boolean flips OFF. Pure helper, returns a patch object you can
// spread into prisma.update data. No-op when nothing changed.
function paidTimestampPatch(currentPaid, currentAt, nextPaid) {
    if (typeof nextPaid !== 'boolean') return {};
    if (nextPaid === currentPaid) return {};
    return nextPaid ? { paidAt: new Date() } : { paidAt: null };
}

// ---------------------------------------------------------------------------
// /api/projects/:projectId/change-requests
// ---------------------------------------------------------------------------

projectScoped.get('/', async (req, res, next) => {
    try {
        const { projectId } = req.params;
        await assertProjectRead(req, projectId);
        const rows = await prisma.changeRequest.findMany({
            where: { projectId },
            include: crInclude,
            orderBy: [{ createdAt: 'asc' }],
        });
        res.json({ changeRequests: rows.map(forApi) });
    } catch (err) {
        next(err);
    }
});

projectScoped.post('/', async (req, res, next) => {
    try {
        const { projectId } = req.params;
        // Closed projects can't accept new CRs from regular users —
        // the project lifecycle ended. Admins / managers bypass.
        await assertProjectWritable(req, projectId, 'create a change request');
        if (!isAdmin(req) && !hasCapability(req, CAPABILITIES.CR_CREATE)) {
            throw httpError(
                403,
                'You do not have permission to create change requests',
            );
        }
        const data = createSchema.parse(req.body);
        await assertValidProjectStatus(data.status);
        const code = await generateChangeRequestCode(prisma, { projectId });
        const cr = await prisma.changeRequest.create({
            data: {
                code,
                projectId,
                title: data.title.trim(),
                description: data.description?.trim() || null,
                status: data.status || 'TODO',
                internalAmount: data.internalAmount ?? null,
                internalPaid: data.internalPaid ?? false,
                internalPaidAt: data.internalPaid ? new Date() : null,
                clientAmount: data.clientAmount ?? null,
                clientPaid: data.clientPaid ?? false,
                clientPaidAt: data.clientPaid ? new Date() : null,
                estimatedHours: data.estimatedHours ?? null,
                createdById: req.user.id,
            },
            include: crInclude,
        });
        await logActivityEvent({
            type: 'CR_CREATED',
            projectId,
            actorId: req.user.id,
            meta: {
                crId: cr.id,
                crCode: cr.code,
                crTitle: cr.title,
            },
        }).catch(() => {});
        res.status(201).json({ changeRequest: forApi(cr) });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// /api/change-requests/:id (flat — easier to deep-link)
// ---------------------------------------------------------------------------

flat.get('/:id', async (req, res, next) => {
    try {
        const cr = await loadCROr404(req.params.id);
        await assertProjectRead(req, cr.projectId);
        res.json({ changeRequest: forApi(cr) });
    } catch (err) {
        next(err);
    }
});

// Plan payload for the CR — the same shape PhasesPlan consumes on
// the project detail page, but scoped to just this CR. We include
// the parent project's phases (so tasks have somewhere to live and
// the phase columns are consistent across project + CR views) and
// only return tasks whose `changeRequestId` matches this CR.
flat.get('/:id/plan', async (req, res, next) => {
    try {
        const cr = await loadCROr404(req.params.id);
        await assertProjectRead(req, cr.projectId);

        // M4: include the count of notes "about" this CR so the
        // detail page can show a badge on the Notes tab without
        // re-fetching after switching tabs. Same scope as the
        // /notes filter: CR-direct pins + notes on CR-scoped tasks.
        // M5: same shape for files — direct CR pins + files on
        // CR-pinned notes + files on notes pinned to CR-scoped
        // tasks. The two badges share a single bundle response.
        const [phases, tasks, notesCount, filesCount] = await Promise.all([
            prisma.phase.findMany({
                where: { projectId: cr.projectId },
                orderBy: [{ order: 'asc' }, { name: 'asc' }],
            }),
            prisma.task.findMany({
                where: { changeRequestId: cr.id },
                include: {
                    assignee: {
                        select: {
                            id: true,
                            name: true,
                            email: true,
                            avatarUrl: true,
                        },
                    },
                    // Echo the creator so the "by <name>" pill on the
                    // CR Plan tab matches the project Plan. Without
                    // this the row shows "by unknown" because the FE
                    // can't find task.createdBy in the payload.
                    createdBy: {
                        select: {
                            id: true,
                            name: true,
                            email: true,
                            avatarUrl: true,
                        },
                    },
                    changeRequest: {
                        select: { id: true, code: true, title: true },
                    },
                    _count: {
                        // Hide soft-deleted subtasks from the badge.
                        select: {
                            subtasks: { where: { deletedAt: null } },
                        },
                    },
                },
                orderBy: [{ createdAt: 'asc' }],
            }),
            prisma.note.count({
                where: {
                    projectId: cr.projectId,
                    OR: [
                        { changeRequestId: cr.id },
                        { task: { is: { changeRequestId: cr.id } } },
                    ],
                },
            }),
            prisma.fileAttachment.count({
                where: {
                    projectId: cr.projectId,
                    OR: [
                        { changeRequestId: cr.id },
                        { note: { is: { changeRequestId: cr.id } } },
                        {
                            note: {
                                is: { task: { is: { changeRequestId: cr.id } } },
                            },
                        },
                    ],
                },
            }),
        ]);

        res.json({
            changeRequest: forApi(cr),
            phases,
            tasks,
            notesCount,
            filesCount,
        });
    } catch (err) {
        next(err);
    }
});

flat.patch('/:id', async (req, res, next) => {
    try {
        const existing = await loadCROr404(req.params.id);
        await assertProjectWritable(req, existing.projectId, 'edit this change request');
        if (!isAdmin(req) && !hasCapability(req, CAPABILITIES.CR_EDIT)) {
            throw httpError(
                403,
                'You do not have permission to edit change requests',
            );
        }
        const data = updateSchema.parse(req.body);
        await assertValidProjectStatus(data.status);
        const patch = {};
        if (data.title !== undefined) patch.title = data.title.trim();
        if (data.description !== undefined) {
            patch.description = data.description?.trim() || null;
        }
        let statusChanged = false;
        if (data.status !== undefined && data.status !== existing.status) {
            patch.status = data.status;
            statusChanged = true;
        }
        if (data.internalAmount !== undefined) {
            patch.internalAmount = data.internalAmount;
        }
        if (data.clientAmount !== undefined) {
            patch.clientAmount = data.clientAmount;
        }
        if (data.estimatedHours !== undefined) {
            patch.estimatedHours = data.estimatedHours;
        }
        if (typeof data.internalPaid === 'boolean') {
            patch.internalPaid = data.internalPaid;
            const ts = paidTimestampPatch(
                existing.internalPaid,
                existing.internalPaidAt,
                data.internalPaid,
            );
            if (ts.paidAt !== undefined) patch.internalPaidAt = ts.paidAt;
        }
        if (typeof data.clientPaid === 'boolean') {
            patch.clientPaid = data.clientPaid;
            const ts = paidTimestampPatch(
                existing.clientPaid,
                existing.clientPaidAt,
                data.clientPaid,
            );
            if (ts.paidAt !== undefined) patch.clientPaidAt = ts.paidAt;
        }
        const updated = await prisma.changeRequest.update({
            where: { id: existing.id },
            data: patch,
            include: crInclude,
        });

        await logActivityEvent({
            type: statusChanged ? 'CR_STATUS_CHANGED' : 'CR_UPDATED',
            projectId: existing.projectId,
            actorId: req.user.id,
            meta: {
                crId: existing.id,
                crCode: existing.code,
                crTitle: updated.title,
                ...(statusChanged
                    ? {
                        fromStatus: existing.status,
                        toStatus: updated.status,
                    }
                    : {}),
            },
        }).catch(() => {});

        res.json({ changeRequest: forApi(updated) });
    } catch (err) {
        next(err);
    }
});

flat.delete('/:id', async (req, res, next) => {
    try {
        const existing = await loadCROr404(req.params.id);
        await assertProjectWritable(req, existing.projectId, 'delete this change request');
        if (!isAdmin(req) && !hasCapability(req, CAPABILITIES.CR_DELETE)) {
            throw httpError(
                403,
                'You do not have permission to delete change requests',
            );
        }
        await prisma.changeRequest.delete({ where: { id: existing.id } });
        await logActivityEvent({
            type: 'CR_DELETED',
            projectId: existing.projectId,
            actorId: req.user.id,
            meta: {
                crId: existing.id,
                crCode: existing.code,
                crTitle: existing.title,
            },
        }).catch(() => {});
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = { projectScoped, flat };
