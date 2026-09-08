// Device push-token registration for the mobile app.
//
//   POST   /api/push/register   { token, platform }  -> upsert my token
//   DELETE /api/push/register   { token }            -> drop a token
//
// Tokens are Expo push tokens (ExponentPushToken[...]). A token is
// globally unique to one device install, so we key on it and (re)assign
// it to the calling user on every register — handy when a device is
// handed to a different user.
const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const { isExpoToken, sendTestToUser } = require('../lib/push');

const router = express.Router();
router.use(requireAuth);

const registerSchema = z.object({
    token: z.string().min(1).max(255),
    platform: z.string().max(20).optional().nullable(),
});

router.post('/register', async (req, res, next) => {
    try {
        const { token, platform } = registerSchema.parse(req.body);
        if (!isExpoToken(token)) {
            throw httpError(400, 'Invalid push token');
        }
        const row = await prisma.pushToken.upsert({
            where: { token },
            create: {
                token,
                platform: platform || null,
                userId: req.user.id,
            },
            // Re-point an existing token to whoever is logged in now.
            update: { userId: req.user.id, platform: platform || null },
        });
        res.json({ ok: true, id: row.id });
    } catch (err) {
        next(err);
    }
});

router.delete('/register', async (req, res, next) => {
    try {
        const { token } = z
            .object({ token: z.string().min(1) })
            .parse(req.body);
        // Only delete a token that belongs to the caller.
        await prisma.pushToken.deleteMany({
            where: { token, userId: req.user.id },
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// GET /api/push/test — fire a test push to my own devices and return
// Expo's raw tickets. Lets us confirm token registration + delivery.
router.get('/test', async (req, res, next) => {
    try {
        const result = await sendTestToUser(req.user.id);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
