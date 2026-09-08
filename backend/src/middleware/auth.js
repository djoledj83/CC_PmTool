const { verifyAccessToken } = require('../lib/jwt');
const prisma = require('../lib/prisma');

// Tiny in-memory cache of (userId -> { row, expiresAt }). The capability
// array lives on the User row, and we want capability edits to take
// effect quickly without paying for a DB round-trip on EVERY request.
// 30 seconds is short enough to feel instant for the user being edited
// and long enough to soak up bursty UI traffic.
const USER_CACHE_TTL_MS = 30_000;
const userCache = new Map();

function cachedUser(id) {
    const hit = userCache.get(id);
    if (hit && hit.expiresAt > Date.now()) return hit.row;
    return null;
}

function rememberUser(row) {
    userCache.set(row.id, {
        row,
        expiresAt: Date.now() + USER_CACHE_TTL_MS,
    });
}

// Exported so the user routes can blow away the cache the moment an
// admin toggles a capability or changes a role — no waiting for the
// 30s TTL.
function invalidateUserCache(id) {
    if (id) userCache.delete(id);
    else userCache.clear();
}

async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'Missing access token' });
    }

    try {
        const payload = verifyAccessToken(token);
        // Source of truth for role + capabilities is the DB. The JWT
        // payload only proves the bearer is who they say they are.
        let row = cachedUser(payload.sub);
        if (!row) {
            row = await prisma.user.findUnique({
                where: { id: payload.sub },
                select: {
                    id: true,
                    email: true,
                    name: true,
                    role: true,
                    status: true,
                    capabilities: true,
                    clientId: true,
                    external: true,
                },
            });
            if (!row) {
                return res
                    .status(401)
                    .json({ error: 'Account no longer exists' });
            }
            if (row.status === 'SUSPENDED') {
                return res
                    .status(403)
                    .json({ error: 'Account suspended' });
            }
            rememberUser(row);
        }
        req.user = {
            id: row.id,
            email: row.email,
            name: row.name || null,
            role: row.role || 'USER',
            capabilities: row.capabilities || [],
            clientId: row.clientId || null,
            external: Boolean(row.external),
        };
        return next();
    } catch (err) {
        return res
            .status(401)
            .json({ error: 'Invalid or expired access token' });
    }
}

function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Admin permission required' });
    }
    return next();
}

module.exports = { requireAuth, requireAdmin, invalidateUserCache };
