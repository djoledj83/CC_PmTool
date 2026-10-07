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

// Requesters (help-desk customers — including EXTERNAL ones) may only use
// the portal's API. Everything else is staff-only, deny-by-default, so a
// new workspace route is never accidentally open to customers. The routes
// listed here still do their own per-record checks (e.g. which tickets a
// requester can see).
const REQUESTER_ROUTES = [
    { path: /^\/api\/auth(\/|$)/ },
    { path: /^\/api\/tickets(\/|$)/ },
    { path: /^\/api\/ticket-request-types\/?$/, methods: ['GET'] },
    { path: /^\/api\/ticket-fields\/effective\/?$/, methods: ['GET'] },
    { path: /^\/api\/terminals\/(models|vendors)\/?$/, methods: ['GET'] },
    { path: /^\/api\/requester-groups(\/candidates)?\/?$/, methods: ['GET'] },
    // The raise form's Client field — internal requesters only; external
    // ones are tied to their own organisation.
    { path: /^\/api\/clients\/?$/, methods: ['GET'], internalOnly: true },
    { path: /^\/api\/notifications(\/(unread-count|mark-seen|mark-read|[^/]+))?\/?$/ },
    { path: /^\/api\/announcements\/active\/?$/, methods: ['GET'] },
    { path: /^\/api\/announcements\/[^/]+\/ack\/?$/, methods: ['POST'] },
    { path: /^\/api\/push\/register\/?$/ },
    { path: /^\/api\/pins\/?$/ },
    // Country suggestions on their profile.
    { path: /^\/api\/templates\/countries\/?$/, methods: ['GET'] },
    // Their own profile and avatar only.
    { path: /^\/api\/users\/([^/]+)\/?$/, methods: ['GET', 'PATCH'], self: true },
    { path: /^\/api\/users\/([^/]+)\/avatar\/?$/, methods: ['POST', 'DELETE'], self: true },
];

function requesterMayCall(req, user) {
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    const method = String(req.method || 'GET').toUpperCase();
    return REQUESTER_ROUTES.some((r) => {
        const m = r.path.exec(path);
        if (!m) return false;
        if (r.methods && !r.methods.includes(method)) return false;
        if (r.internalOnly && user.external) return false;
        if (r.self && m[1] !== user.id) return false;
        return true;
    });
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
                    tokenVersion: true,
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
        // Session revocation. Every token carries the user's tokenVersion
        // (`tv`) from when it was issued; logout, password change/reset and
        // admin password resets bump the live counter. A token minted before
        // the bump is dead immediately — not just once its 15-min access TTL
        // runs out — so "sign out other sessions" really means now.
        const liveTv =
            typeof row.tokenVersion === 'number' ? row.tokenVersion : 0;
        const tokenTv = typeof payload.tv === 'number' ? payload.tv : 0;
        if (tokenTv !== liveTv) {
            return res
                .status(401)
                .json({ error: 'Session expired, please sign in again' });
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
        if (req.user.role === 'REQUESTER' && !requesterMayCall(req, req.user)) {
            return res
                .status(403)
                .json({ error: 'Not available for requester accounts.' });
        }
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

module.exports = {
    requireAuth,
    requireAdmin,
    invalidateUserCache,
    requesterMayCall,
};
