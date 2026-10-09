// Wallboards — big-screen ticket boards opened without signing in.
//
//   GET    /api/wallboard/view/:key            PUBLIC: the board's data
//                                               (open, non-internal tickets)
//   GET    /api/wallboard/boards                admin: list links
//   POST   /api/wallboard/boards                admin: create { name }
//   PATCH  /api/wallboard/boards/:id            admin: { name?, active? }
//   POST   /api/wallboard/boards/:id/regenerate admin: new key (old link dies)
//   DELETE /api/wallboard/boards/:id            admin: delete
//
// "Admin" = admins or holders of the template:manage capability (the
// links live under Templates → Tickets → Wallboards).
const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const realtime = require('../lib/realtime');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    CAPABILITIES,
    requireAdminOrCapabilityMiddleware,
} = require('../lib/permissions');
const {
    newWallboardKey,
    findActiveWallboard,
    wallboardData,
} = require('../lib/wallboard');

const router = express.Router();
const requireManage = [
    requireAuth,
    requireAdminOrCapabilityMiddleware(CAPABILITIES.TEMPLATE_MANAGE),
];

const LAST_SEEN_EVERY_MS = 60 * 1000;

// PUBLIC — no session. The key in the link is the only credential, so an
// unknown, malformed or paused key gets the same 404.
router.get('/view/:key', async (req, res, next) => {
    try {
        res.set('Cache-Control', 'no-store');
        const board = await findActiveWallboard(req.params.key);
        if (!board) throw httpError(404, 'This wallboard link is not valid.');
        const now = Date.now();
        if (!board.lastSeenAt || now - new Date(board.lastSeenAt).getTime() > LAST_SEEN_EVERY_MS) {
            prisma.wallboard
                .update({ where: { id: board.id }, data: { lastSeenAt: new Date(now) } })
                .catch(() => {});
        }
        const data = await wallboardData({ since: req.query.since });
        res.json({ board: { name: board.name }, ...data });
    } catch (err) {
        next(err);
    }
});

const nameSchema = z.string().trim().min(1).max(80);
const createSchema = z.object({ name: nameSchema });
const patchSchema = z.object({ name: nameSchema.optional(), active: z.boolean().optional() });

const publicRow = (b) => ({
    id: b.id,
    name: b.name,
    key: b.key,
    active: b.active,
    lastSeenAt: b.lastSeenAt,
    createdAt: b.createdAt,
});

router.get('/boards', requireManage, async (req, res, next) => {
    try {
        const boards = await prisma.wallboard.findMany({ orderBy: { createdAt: 'asc' } });
        res.json({ boards: boards.map(publicRow) });
    } catch (err) {
        next(err);
    }
});

router.post('/boards', requireManage, async (req, res, next) => {
    try {
        const data = createSchema.parse(req.body);
        const board = await prisma.wallboard.create({
            data: { name: data.name, key: newWallboardKey(), createdById: req.user.id },
        });
        res.status(201).json({ board: publicRow(board) });
    } catch (err) {
        next(err);
    }
});

router.patch('/boards/:id', requireManage, async (req, res, next) => {
    try {
        const data = patchSchema.parse(req.body);
        const board = await prisma.wallboard.update({
            where: { id: req.params.id },
            data,
        });
        // Paused → screens showing it go dark right away.
        if (data.active === false) realtime.disconnectWallboard(board.id);
        res.json({ board: publicRow(board) });
    } catch (err) {
        if (err.code === 'P2025') return next(httpError(404, 'Wallboard not found.'));
        next(err);
    }
});

router.post('/boards/:id/regenerate', requireManage, async (req, res, next) => {
    try {
        const board = await prisma.wallboard.update({
            where: { id: req.params.id },
            data: { key: newWallboardKey() },
        });
        realtime.disconnectWallboard(board.id);
        res.json({ board: publicRow(board) });
    } catch (err) {
        if (err.code === 'P2025') return next(httpError(404, 'Wallboard not found.'));
        next(err);
    }
});

router.delete('/boards/:id', requireManage, async (req, res, next) => {
    try {
        await prisma.wallboard.delete({ where: { id: req.params.id } });
        realtime.disconnectWallboard(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        if (err.code === 'P2025') return next(httpError(404, 'Wallboard not found.'));
        next(err);
    }
});

module.exports = router;
