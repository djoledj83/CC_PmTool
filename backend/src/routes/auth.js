const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const {
    buildPayload,
    signAccessToken,
    signRefreshToken,
    verifyRefreshToken,
    refreshCookieOptions,
    clearRefreshCookieOptions,
} = require('../lib/jwt');
const { requireAuth, invalidateUserCache } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const { createResetTokenForUser, buildResetUrl } = require('../lib/resetTokens');
const { notify, broadcastPendingUserCount } = require('../lib/notify');
const { sendTemplate, appLink, APP_NAME } = require('../lib/mailer');
const { logActivityEvent } = require('../lib/activityLog');
const { effectiveCapabilities } = require('../lib/permissions');

const router = express.Router();

const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    name: z.string().min(1, 'Name is required').max(100),
});

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});

const forgotSchema = z.object({
    email: z.string().email(),
});

const resetSchema = z.object({
    token: z.string().min(10),
    password: z.string().min(8, 'Password must be at least 8 characters'),
});

// Standard Prisma `include` so every auth response carries the same
// hydrated user shape — phone, position, teamLeader, businessUnit etc.
// Kept in sync with `userInclude` in routes/users.js.
const authUserInclude = {
    teamLeader: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    businessUnit: { select: { id: true, name: true } },
};

function publicUser(user) {
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone || null,
        avatarUrl: user.avatarUrl || null,
        position: user.position || null,
        role: user.role || 'USER',
        capabilities: Array.isArray(user.capabilities)
            ? user.capabilities
            : [],
        // Effective set = role defaults ∪ per-user overrides. The
        // frontend reads this to decide which buttons to show — we
        // never want it to compute the rules itself.
        effectiveCapabilities: effectiveCapabilities(user),
        status: user.status || 'ACTIVE',
        lastLoginAt: user.lastLoginAt || null,
        createdAt: user.createdAt,
        // Profile extras — mirrored from the users route so the
        // logged-in `useAuth().user` carries the same shape as the
        // user list / detail responses.
        country: user.country || null,
        currency: user.currency || null,
        about: user.about || null,
        teamLeaderId: user.teamLeaderId || null,
        teamLeader: user.teamLeader
            ? {
                  id: user.teamLeader.id,
                  name: user.teamLeader.name,
                  email: user.teamLeader.email,
                  avatarUrl: user.teamLeader.avatarUrl || null,
              }
            : null,
        businessUnitId: user.businessUnitId || null,
        businessUnit: user.businessUnit
            ? { id: user.businessUnit.id, name: user.businessUnit.name }
            : null,
        clientId: user.clientId || null,
        external: Boolean(user.external),
        emailNotifications:
            typeof user.emailNotifications === 'boolean'
                ? user.emailNotifications
                : true,
        themePreference: user.themePreference || 'system',
        projectOrder: Array.isArray(user.projectOrder)
            ? user.projectOrder
            : [],
    };
}

function issueTokens(res, user) {
    const payload = buildPayload(user);
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    // Web clients keep the refresh token in an httpOnly cookie. Mobile
    // (React Native) clients can't use cookies cleanly, so the caller
    // can also surface `refreshToken` in the JSON body — see
    // `isMobileClient`. We always set the cookie regardless; it's
    // simply ignored by native clients.
    res.cookie('refreshToken', refreshToken, refreshCookieOptions());
    return { accessToken, refreshToken };
}

// Native apps announce themselves with `X-Client-Type: mobile`. For
// those we return the refresh token in the response body so it can be
// stored in the device's secure storage (Keychain / Keystore). Browsers
// never send this header, so they keep the cookie-only flow.
function isMobileClient(req) {
    return String(req.headers['x-client-type'] || '').toLowerCase() === 'mobile';
}

// Read the refresh token from wherever this client keeps it: the cookie
// (web) or, for mobile, the Authorization: Bearer header or request body.
function readRefreshToken(req) {
    if (req.cookies?.refreshToken) return req.cookies.refreshToken;
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    if (req.body?.refreshToken) return String(req.body.refreshToken);
    return null;
}

// Emails are matched case-insensitively at sign-in. New accounts are
// stored lowercased so duplicates like User@x.com / user@x.com are rejected.
function normalizeEmailInput(email) {
    return String(email || '').trim().toLowerCase();
}

async function findUserByEmail(email, { include } = {}) {
    const normalized = normalizeEmailInput(email);
    if (!normalized) return null;
    return prisma.user.findFirst({
        where: { email: { equals: normalized, mode: 'insensitive' } },
        ...(include ? { include } : {}),
    });
}

// Public sign-up is open: anyone can create an account, but the first user
// auto-bootstraps as ADMIN/ACTIVE; everyone after that lands as USER/PENDING
// and must be approved by an administrator before they can log in.
router.post('/register', async (req, res, next) => {
    try {
        const { password, name } = registerSchema.parse(req.body);
        const email = normalizeEmailInput(req.body.email);

        const existing = await findUserByEmail(email);
        if (existing) throw httpError(409, 'An account with that email already exists');

        const userCount = await prisma.user.count();
        const isFirst = userCount === 0;

        const passwordHash = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: {
                email,
                password: passwordHash,
                name,
                role: isFirst ? 'ADMIN' : 'USER',
                status: isFirst ? 'ACTIVE' : 'PENDING',
                approvedAt: isFirst ? new Date() : null,
            },
        });

        await logActivityEvent({
            type: 'USER_REGISTERED',
            actorId: user.id,
            message: user.name,
            toValue: user.email,
            meta: {
                targetUserId: user.id,
                targetUserName: user.name,
                targetUserEmail: user.email,
                role: user.role,
                status: user.status,
                bootstrap: isFirst,
            },
        });

        if (isFirst) {
            const { accessToken, refreshToken } = issueTokens(res, user);
            return res.status(201).json({
                user: publicUser(user),
                accessToken,
                ...(isMobileClient(req) ? { refreshToken } : {}),
                pending: false,
            });
        }

        // Notify every active admin so they can review & approve.
        const admins = await prisma.user.findMany({
            where: { role: 'ADMIN', status: 'ACTIVE' },
            select: { id: true },
        });
        await notify({
            recipientIds: admins.map((a) => a.id),
            actorId: user.id,
            type: 'USER_PENDING_APPROVAL',
            title: 'New user awaiting approval',
            body: `${user.name} (${user.email}) just registered.`,
            link: '/users?status=pending',
        });
        await broadcastPendingUserCount();

        // Confirmation email so the user knows the request was received and
        // that we'll email them again once it's been approved.
        sendTemplate({
            to: user.email,
            subject: `Thanks for registering — ${APP_NAME} is reviewing your account`,
            heading: 'Account request received',
            intro: `Hi ${user.name?.split(' ')[0] || 'there'},`,
            body: `Thanks for signing up to ${APP_NAME}. An administrator needs to approve your account before you can sign in. We'll send you another email as soon as your access is granted — usually within a business day.`,
            ctaText: 'Visit the sign-in page',
            ctaUrl: appLink('/login'),
            footer: `If you didn't request this, you can safely ignore this email.`,
        }).catch(() => {});

        // No tokens issued: a pending user cannot use the app yet.
        res.status(201).json({
            user: publicUser(user),
            pending: true,
            message:
                'Your account has been created and is awaiting administrator approval.',
        });
    } catch (err) {
        next(err);
    }
});

router.post('/login', async (req, res, next) => {
    try {
        const { password } = loginSchema.parse(req.body);
        const email = normalizeEmailInput(req.body.email);

        const user = await findUserByEmail(email, { include: authUserInclude });
        if (!user) throw httpError(401, 'Invalid email or password');

        const ok = await bcrypt.compare(password, user.password);
        if (!ok) throw httpError(401, 'Invalid email or password');

        if (user.status === 'PENDING') {
            throw httpError(
                403,
                'Your account is awaiting administrator approval. You will be notified once it is approved.',
            );
        }
        if (user.status === 'SUSPENDED') {
            throw httpError(
                403,
                'Your account has been suspended. Please contact an administrator.',
            );
        }

        // Stamp the login time. Best-effort: failure to update the
        // timestamp must not block the user from signing in.
        try {
            await prisma.user.update({
                where: { id: user.id },
                data: { lastLoginAt: new Date() },
            });
            user.lastLoginAt = new Date();
        } catch (e) {
            // ignore — purely informational
        }

        await logActivityEvent({
            type: 'USER_LOGIN',
            actorId: user.id,
            message: user.name,
            meta: {
                targetUserId: user.id,
                targetUserName: user.name,
                targetUserEmail: user.email,
            },
        });

        const { accessToken, refreshToken } = issueTokens(res, user);
        res.json({
            user: publicUser(user),
            accessToken,
            ...(isMobileClient(req) ? { refreshToken } : {}),
        });
    } catch (err) {
        next(err);
    }
});

router.post('/refresh', async (req, res, next) => {
    try {
        const token = readRefreshToken(req);
        if (!token) throw httpError(401, 'Missing refresh token');

        let payload;
        try {
            payload = verifyRefreshToken(token);
        } catch {
            throw httpError(401, 'Invalid refresh token');
        }

        const user = await prisma.user.findUnique({
            where: { id: payload.sub },
            include: authUserInclude,
        });
        if (!user) throw httpError(401, 'User no longer exists');
        if (user.status !== 'ACTIVE') {
            throw httpError(
                401,
                user.status === 'PENDING'
                    ? 'Your account is awaiting administrator approval.'
                    : 'Your account has been suspended.',
            );
        }
        // tokenVersion gate — bumped on logout (or admin "force sign
        // out" actions). A stale refresh cookie whose embedded `tv`
        // claim doesn't match the live counter is treated as if the
        // user had explicitly logged out, regardless of whether the
        // browser ever managed to clear the cookie.
        const liveVersion =
            typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;
        const tokenVersion = typeof payload.tv === 'number' ? payload.tv : 0;
        if (tokenVersion !== liveVersion) {
            // Defensively clear the cookie now so the next page load
            // doesn't keep retrying the same dead token.
            res.clearCookie('refreshToken', clearRefreshCookieOptions());
            res.clearCookie('refreshToken', {
                ...clearRefreshCookieOptions(),
                path: '/',
            });
            throw httpError(401, 'Session expired, please sign in again');
        }

        const { accessToken, refreshToken } = issueTokens(res, user);
        res.json({
            user: publicUser(user),
            accessToken,
            ...(isMobileClient(req) ? { refreshToken } : {}),
        });
    } catch (err) {
        next(err);
    }
});

router.post('/logout', async (req, res, next) => {
    try {
        // Best-effort: identify the caller from the refresh cookie so
        // we can bump their tokenVersion. This invalidates EVERY
        // outstanding refresh token for that user — across browsers,
        // tabs, and even server-side-replayed cookies. We tolerate
        // missing / invalid cookies because logout must always
        // succeed from the client's perspective.
        const token = readRefreshToken(req);
        if (token) {
            try {
                const payload = verifyRefreshToken(token);
                if (payload?.sub) {
                    await prisma.user.update({
                        where: { id: payload.sub },
                        data: { tokenVersion: { increment: 1 } },
                    });
                    // Drop the cached row so the next requireAuth
                    // call re-reads the new tokenVersion immediately.
                    invalidateUserCache(payload.sub);
                }
            } catch {
                // ignore — clearing the cookie is still useful
            }
        }
        // Clear the cookie at BOTH the issuing path (/api/auth) and at
        // the root path, so any legacy cookie set under a different
        // path attribute (from earlier code revisions) also dies.
        // The attribute set has to match Set-Cookie exactly or
        // browsers ignore the clear.
        res.clearCookie('refreshToken', clearRefreshCookieOptions());
        res.clearCookie('refreshToken', {
            ...clearRefreshCookieOptions(),
            path: '/',
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.get('/me', requireAuth, async (req, res, next) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user.id },
            include: authUserInclude,
        });
        if (!user) throw httpError(404, 'User not found');
        res.json({ user: publicUser(user) });
    } catch (err) {
        next(err);
    }
});

router.post('/forgot-password', async (req, res, next) => {
    try {
        const email = normalizeEmailInput(forgotSchema.parse(req.body).email);
        const user = await findUserByEmail(email);

        // Always respond `{ ok: true }` regardless of whether the email
        // matches a real account. The reset URL is NEVER returned to the
        // caller — it goes out via email only. In development without an
        // SMTP server configured, the URL is logged so you can copy it
        // from the server console (gated behind NODE_ENV !== 'production'
        // so production logs never carry one-time secrets).
        if (!user) return res.json({ ok: true });

        const { token } = await createResetTokenForUser(user.id);
        const resetUrl = buildResetUrl(token);

        if (process.env.NODE_ENV !== 'production') {
            console.log(`[reset-password] ${user.email} -> ${resetUrl}`);
        }

        // Fire-and-forget. Email delivery should never gate the response
        // (and never reveal whether an account exists by varying timing
        // significantly), so we await but ignore failures.
        try {
            await sendTemplate({
                to: user.email,
                subject: `Reset your ${APP_NAME} password`,
                heading: 'Password reset requested',
                intro: `Hi ${user.name || 'there'},`,
                body:
                    'We received a request to reset your password. Click the ' +
                    'button below to choose a new one. The link expires in ' +
                    '60 minutes. If you did not request this, you can ' +
                    'safely ignore this email.',
                ctaText: 'Reset password',
                ctaUrl: resetUrl,
                footer: `If the button does not work, paste this URL into your browser:\n${resetUrl}`,
            });
        } catch (err) {
            console.warn('[forgot-password] mail send failed:', err.message);
        }

        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.post('/reset-password', async (req, res, next) => {
    try {
        const { token, password } = resetSchema.parse(req.body);

        const record = await prisma.passwordResetToken.findUnique({ where: { token } });
        if (!record || record.used || record.expiresAt < new Date()) {
            throw httpError(400, 'Reset link is invalid or expired');
        }

        const passwordHash = await bcrypt.hash(password, 10);
        await prisma.$transaction([
            prisma.user.update({
                where: { id: record.userId },
                data: { password: passwordHash },
            }),
            prisma.passwordResetToken.update({
                where: { id: record.id },
                data: { used: true },
            }),
        ]);

        const resetUser = await prisma.user.findUnique({
            where: { id: record.userId },
            select: { id: true, name: true },
        });
        await logActivityEvent({
            type: 'USER_PASSWORD_CHANGED',
            actorId: record.userId,
            message: resetUser?.name || null,
            meta: {
                targetUserId: record.userId,
                targetUserName: resetUser?.name || null,
                viaReset: true,
            },
        });

        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.post('/change-password', requireAuth, async (req, res, next) => {
    try {
        const schema = z.object({
            currentPassword: z.string().min(1),
            newPassword: z.string().min(8),
        });
        const { currentPassword, newPassword } = schema.parse(req.body);

        const user = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!user) throw httpError(404, 'User not found');

        const ok = await bcrypt.compare(currentPassword, user.password);
        if (!ok) throw httpError(400, 'Current password is incorrect');

        const passwordHash = await bcrypt.hash(newPassword, 10);
        await prisma.user.update({
            where: { id: user.id },
            data: { password: passwordHash },
        });

        await logActivityEvent({
            type: 'USER_PASSWORD_CHANGED',
            actorId: user.id,
            message: user.name,
            meta: {
                targetUserId: user.id,
                targetUserName: user.name,
                self: true,
            },
        });

        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
