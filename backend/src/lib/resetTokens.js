const crypto = require('node:crypto');
const prisma = require('./prisma');

const RESET_TOKEN_TTL_MIN = Number(process.env.RESET_TOKEN_TTL_MIN || 30);

async function createResetTokenForUser(userId) {
    // Invalidate any previous unused tokens so a single user always has at most
    // one live reset link in flight.
    await prisma.passwordResetToken.updateMany({
        where: { userId, used: false, expiresAt: { gt: new Date() } },
        data: { used: true },
    });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MIN * 60 * 1000);
    await prisma.passwordResetToken.create({
        data: { userId, token, expiresAt },
    });
    return { token, expiresAt };
}

function buildResetUrl(token) {
    const origin = process.env.APP_ORIGIN || 'http://localhost:3000';
    return `${origin}/reset-password?token=${token}`;
}

module.exports = { createResetTokenForUser, buildResetUrl, RESET_TOKEN_TTL_MIN };
