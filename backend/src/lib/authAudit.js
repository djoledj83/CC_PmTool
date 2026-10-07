// Records an authentication attempt (login success / failure / blocked) to
// the AuthEvent table. Best-effort: auditing must NEVER affect or block the
// auth flow, so every failure here is swallowed.
const prisma = require('./prisma');
const { logger } = require('./logger');

// type: 'LOGIN_SUCCESS' | 'LOGIN_FAILED' | 'LOGIN_BLOCKED'
// reason (freeform, short): 'ok' | 'wrong_password' | 'unknown_email'
//                           | 'pending' | 'suspended'
async function recordAuthEvent({ req, email, userId = null, type, reason = null }) {
    const ua = (req?.headers?.['user-agent'] || '').slice(0, 400) || null;
    const ip = req?.ip || req?.socket?.remoteAddress || null;
    // Also surface it in the app log so it shows up in the file logs / docker
    // logs immediately (handy for spotting a burst of failures).
    try {
        logger.info(`auth ${type}${reason ? ` (${reason})` : ''} email=${email || '-'} ip=${ip || '-'}`);
    } catch {
        /* ignore */
    }
    try {
        await prisma.authEvent.create({
            data: {
                email: email ? String(email).slice(0, 200) : null,
                userId: userId || null,
                type,
                reason,
                ip,
                userAgent: ua,
            },
        });
    } catch {
        /* swallow — never break login on an audit-write failure */
    }
}

module.exports = { recordAuthEvent };
