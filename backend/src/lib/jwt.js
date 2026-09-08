const jwt = require('jsonwebtoken');

// Refuse to boot without explicit secrets. Hard-coded defaults are
// catastrophic for JWTs because anyone reading the repo could forge
// tokens for any user/role. We treat them as required environment.
function requireSecret(name) {
    const value = process.env[name];
    if (!value || value.length < 32) {
        throw new Error(
            `[startup] Environment variable ${name} is required and must be at ` +
                'least 32 characters. Generate one with `openssl rand -hex 48`.',
        );
    }
    if (
        value === 'dev_access_secret_change_me' ||
        value === 'dev_refresh_secret_change_me'
    ) {
        throw new Error(
            `[startup] ${name} is set to the placeholder dev value. Replace it ` +
                'with a real random secret before starting the server.',
        );
    }
    return value;
}

const ACCESS_SECRET = requireSecret('JWT_ACCESS_SECRET');
const REFRESH_SECRET = requireSecret('JWT_REFRESH_SECRET');
const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7);

function buildPayload(user) {
    return {
        sub: user.id,
        email: user.email,
        role: user.role || 'USER',
        // tokenVersion — incremented on logout to invalidate
        // outstanding refresh tokens server-side. Refresh handler
        // compares this against the live `User.tokenVersion` value
        // and rejects on mismatch.
        tv: typeof user.tokenVersion === 'number' ? user.tokenVersion : 0,
    };
}

function signAccessToken(payload) {
    return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}

function signRefreshToken(payload) {
    return jwt.sign(payload, REFRESH_SECRET, { expiresIn: `${REFRESH_TTL_DAYS}d` });
}

function verifyAccessToken(token) {
    return jwt.verify(token, ACCESS_SECRET);
}

function verifyRefreshToken(token) {
    return jwt.verify(token, REFRESH_SECRET);
}

// The `Secure` cookie flag is decoupled from NODE_ENV so an HTTP
// production deployment doesn't silently drop Set-Cookie. Explicit
// COOKIE_SECURE=true/false wins; otherwise we infer from PUBLIC_API_URL
// (https → Secure) and finally fall back to NODE_ENV for parity with
// the historical behaviour.
function cookieSecureFlag() {
    const explicit = process.env.COOKIE_SECURE;
    if (typeof explicit === 'string') {
        return ['1', 'true', 'yes', 'on'].includes(explicit.toLowerCase());
    }
    const publicUrl = process.env.PUBLIC_API_URL || process.env.APP_ORIGIN || '';
    if (publicUrl.startsWith('https://')) return true;
    if (publicUrl.startsWith('http://')) return false;
    return process.env.NODE_ENV === 'production';
}

function refreshCookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecureFlag(),
        maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
        path: '/api/auth',
    };
}

// Mirror of refreshCookieOptions WITHOUT maxAge — Express's
// `clearCookie` uses Expires=<past> internally and warns if you also
// pass `maxAge`. The attribute set must otherwise match `Set-Cookie`
// exactly or the browser refuses to overwrite.
function clearRefreshCookieOptions() {
    return {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecureFlag(),
        path: '/api/auth',
    };
}

module.exports = {
    buildPayload,
    signAccessToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    refreshCookieOptions,
    clearRefreshCookieOptions,
    cookieSecureFlag,
    REFRESH_TTL_DAYS,
};
