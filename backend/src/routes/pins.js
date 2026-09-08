const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const { accessibleProjectIds, isAdmin } = require('../lib/permissions');

const router = express.Router();

router.use(requireAuth);

// One generic table covers every "user X marked Y" affordance in
// the app — see comment on UserPin in schema.prisma for the kinds.
const KINDS = ['PROJECT', 'TASK_FOCUS', 'SPRINT_GOAL', 'RELEASE_PROD', 'ACTIVITY', 'TICKET'];

// Per-kind existence check so we don't accept pins on records the
// user can't see (or that have been deleted). Throws httpError on
// any check that fails; resolves to void on success.
async function ensureRefVisible(req, kind, refId) {
    const scope = await accessibleProjectIds(req);
    if (kind === 'PROJECT') {
        const row = await prisma.project.findFirst({
            where: { id: refId, OR: [{ id: { in: scope } }, isAdmin(req) ? {} : { ownerId: req.user.id }] },
            select: { id: true },
        });
        if (!row) throw httpError(404, 'Project not found or out of scope');
        return;
    }
    if (kind === 'TASK_FOCUS') {
        const row = await prisma.task.findFirst({
            where: {
                id: refId,
                project: { id: { in: scope } },
            },
            select: { id: true },
        });
        if (!row) throw httpError(404, 'Task not found or out of scope');
        return;
    }
    if (kind === 'SPRINT_GOAL') {
        const row = await prisma.sprint.findFirst({
            where: { id: refId, projectId: { in: scope } },
            select: { id: true },
        });
        if (!row) throw httpError(404, 'Sprint not found or out of scope');
        return;
    }
    if (kind === 'RELEASE_PROD') {
        // Application catalogue is workspace-wide so any signed-in
        // user can star a release. We still verify the row exists
        // before persisting the pin.
        const row = await prisma.appRelease.findUnique({
            where: { id: refId },
            select: { id: true },
        });
        if (!row) throw httpError(404, 'Release not found');
        return;
    }
    if (kind === 'TICKET') {
        // Tickets are a shared portal queue — any signed-in user can pin
        // any ticket. We just verify the row exists.
        const row = await prisma.ticket.findUnique({
            where: { id: refId },
            select: { id: true },
        });
        if (!row) throw httpError(404, 'Ticket not found');
        return;
    }
    if (kind === 'ACTIVITY') {
        // Activity rows come from many tables (events + projects +
        // tasks + …). The composite ID format used by the activity
        // feed is `event-<uuid>` / `task-created:<uuid>` etc. We
        // don't try to validate it — `refId` is opaque here and just
        // gets echoed back. The feed handler strips stale rows on
        // read (best effort, since deleted projects cascade).
        return;
    }
    throw httpError(400, `Unknown pin kind: ${kind}`);
}

// GET /api/pins
//   ?kind=PROJECT
//   ?refIds=a,b,c  (filter by specific refs — used by listing pages
//                  to render the star/pin state without loading the
//                  whole pin table for big libraries)
router.get('/', async (req, res, next) => {
    try {
        const kind = req.query.kind ? String(req.query.kind).toUpperCase() : null;
        if (kind && !KINDS.includes(kind)) {
            return res.status(400).json({ error: `Invalid kind: ${kind}` });
        }
        const refIds = req.query.refIds
            ? String(req.query.refIds)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
            : null;

        const pins = await prisma.userPin.findMany({
            where: {
                userId: req.user.id,
                ...(kind ? { kind } : {}),
                ...(refIds ? { refId: { in: refIds } } : {}),
            },
            orderBy: { createdAt: 'desc' },
        });
        res.json({ pins });
    } catch (err) {
        next(err);
    }
});

const upsertSchema = z.object({
    kind: z.enum(KINDS),
    refId: z.string().min(1).max(200),
    note: z.string().max(200).optional().nullable(),
});

// POST /api/pins — idempotent upsert. Returns the row whether it
// existed already or not. The unique (userId, kind, refId) index
// handles the dedup at the DB layer.
router.post('/', async (req, res, next) => {
    try {
        const parsed = upsertSchema.parse(req.body);
        await ensureRefVisible(req, parsed.kind, parsed.refId);
        const pin = await prisma.userPin.upsert({
            where: {
                userId_kind_refId: {
                    userId: req.user.id,
                    kind: parsed.kind,
                    refId: parsed.refId,
                },
            },
            create: {
                userId: req.user.id,
                kind: parsed.kind,
                refId: parsed.refId,
                note: parsed.note || null,
            },
            update: {
                note: parsed.note ?? undefined,
            },
        });
        res.json({ pin });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/pins?kind=…&refId=…
//   Convenient "unpin" call. Returns 204 whether the row existed or
//   not so the FE can fire-and-forget on toggle.
router.delete('/', async (req, res, next) => {
    try {
        const kind = req.query.kind ? String(req.query.kind).toUpperCase() : null;
        const refId = req.query.refId ? String(req.query.refId) : null;
        if (!kind || !KINDS.includes(kind)) {
            return res.status(400).json({ error: 'Missing or invalid kind' });
        }
        if (!refId) {
            return res.status(400).json({ error: 'Missing refId' });
        }
        await prisma.userPin
            .delete({
                where: {
                    userId_kind_refId: {
                        userId: req.user.id,
                        kind,
                        refId,
                    },
                },
            })
            .catch(() => {});
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

module.exports = router;
