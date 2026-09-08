// Broadcast announcements. Admins compose a message and activate it; every
// targeted user then sees a modal on load until they acknowledge it (with an
// optional comment). Admins can see who has acknowledged and what they said.
//
// Targeting (`audience` mode):
//   ALL      — everyone (active accounts)
//   INTERNAL — internal staff (external = false)
//   EXTERNAL — external users / requesters (external = true)
//   ROLES    — users whose role is in `targetRoles`
//   TEAMS    — members of any team in `targetTeamIds`
//   USERS    — the specific users in `targetUserIds`
const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const { isAdmin } = require('../lib/permissions');
const { emitToUsers, emitToAll } = require('../lib/realtime');
const { logActivityEvent } = require('../lib/activityLog');
const { sanitizeRichText } = require('../lib/sanitizeHtml');
const {
    announcementImageUpload,
    announcementImageUrl,
} = require('../lib/upload');

const router = express.Router();
router.use(requireAuth);

const AUDIENCES = ['ALL', 'INTERNAL', 'EXTERNAL', 'ROLES', 'TEAMS', 'USERS'];
const ROLE_VALUES = ['ADMIN', 'MANAGER', 'APP_MODERATOR', 'USER', 'REQUESTER'];

function assertAdmin(req) {
    if (!isAdmin(req)) throw httpError(403, 'Admins only');
}

// Prisma `where` selecting the active users an announcement targets.
function audienceUserWhere(a) {
    const base = { status: 'ACTIVE' };
    switch (a.audience) {
        case 'INTERNAL':
            return { ...base, external: false };
        case 'EXTERNAL':
            return { ...base, external: true };
        case 'ROLES':
            return { ...base, role: { in: a.targetRoles || [] } };
        case 'TEAMS':
            return {
                ...base,
                teamMemberships: {
                    some: { teamId: { in: a.targetTeamIds || [] } },
                },
            };
        case 'USERS':
            return { ...base, id: { in: a.targetUserIds || [] } };
        case 'ALL':
        default:
            return base;
    }
}

// Does the current requester fall inside an announcement's audience?
// `facts` = { id, role, external, teamIds: string[] }.
function userInAudience(facts, a) {
    switch (a.audience) {
        case 'INTERNAL':
            return facts.external === false;
        case 'EXTERNAL':
            return facts.external === true;
        case 'ROLES':
            return (a.targetRoles || []).includes(facts.role);
        case 'TEAMS':
            return (a.targetTeamIds || []).some((id) =>
                facts.teamIds.includes(id),
            );
        case 'USERS':
            return (a.targetUserIds || []).includes(facts.id);
        case 'ALL':
        default:
            return true;
    }
}

// Gather the viewer's targeting facts. Team memberships are only fetched
// when at least one candidate announcement targets teams.
async function viewerFacts(req, needTeams) {
    let teamIds = [];
    if (needTeams) {
        const rows = await prisma.teamMember.findMany({
            where: { userId: req.user.id },
            select: { teamId: true },
        });
        teamIds = rows.map((r) => r.teamId);
    }
    return {
        id: req.user.id,
        role: req.user.role,
        external: Boolean(req.user.external),
        teamIds,
    };
}

const ANN_TYPES = ['IMPORTANT', 'INFO', 'TIP', 'MANDATORY'];

// A mandatory announcement's redirect must be an absolute http(s) URL — it's
// what the "Go to the new address" button navigates to.
const isHttpUrl = (u) =>
    typeof u === 'string' && /^https?:\/\//i.test(u.trim());

const targetFields = {
    type: z.enum(ANN_TYPES).optional(),
    // Only meaningful for type MANDATORY; the new address to redirect to.
    redirectUrl: z.string().trim().max(2000).nullable().optional(),
    requireAck: z.boolean().optional(),
    requireComment: z.boolean().optional(),
    audience: z.enum(AUDIENCES).optional(),
    targetRoles: z.array(z.enum(ROLE_VALUES)).optional(),
    targetTeamIds: z.array(z.string()).optional(),
    targetUserIds: z.array(z.string()).optional(),
    repeatIntervalDays: z.coerce
        .number()
        .int()
        .min(1)
        .max(365)
        .nullable()
        .optional(),
    repeatUntil: z.coerce.date().nullable().optional(),
};

const createSchema = z.object({
    title: z.string().min(1).max(200),
    // Rich HTML body — sanitized server-side; larger cap since it's markup.
    body: z.string().min(1).max(20000),
    active: z.boolean().optional(),
    ...targetFields,
});

const updateSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(20000).optional(),
    active: z.boolean().optional(),
    ...targetFields,
});

// Push a live "announcement:new" to the targeted users (or everyone) so the
// modal appears without a reload. Best-effort — never throws to the caller.
async function pushAnnouncement(a) {
    try {
        if (a.audience === 'ALL') {
            emitToAll('announcement:new', { id: a.id });
            return;
        }
        const targets = await prisma.user.findMany({
            where: audienceUserWhere(a),
            select: { id: true },
        });
        emitToUsers(
            targets.map((t) => t.id),
            'announcement:new',
            { id: a.id },
        );
    } catch (e) {
        console.warn('[announcements] realtime push failed:', e.message);
    }
}

const ackSchema = z.object({
    comment: z.string().max(1000).optional().nullable(),
});

// ── Admin: upload an inline image for the rich-text body ──────────────
// Reuses the public image storage (same as app logos), so the returned
// URL is stable and safe to embed in the stored HTML. Admin-only; the
// gate runs before multer parses the upload.
router.post(
    '/upload-image',
    (req, res, next) => {
        if (!isAdmin(req)) return next(httpError(403, 'Admins only'));
        next();
    },
    announcementImageUpload.single('image'),
    (req, res, next) => {
        try {
            if (!req.file) throw httpError(400, 'No image uploaded');
            res.json({ url: announcementImageUrl(req.file.filename) });
        } catch (err) {
            next(err);
        }
    },
);

// ── Admin: create ─────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
    try {
        assertAdmin(req);
        const data = createSchema.parse(req.body);
        const isMandatory = data.type === 'MANDATORY';
        if (isMandatory && !isHttpUrl(data.redirectUrl)) {
            throw httpError(
                400,
                'A redirect URL (http/https) is required for a mandatory announcement',
            );
        }
        const created = await prisma.announcement.create({
            data: {
                title: data.title.trim(),
                body: sanitizeRichText(data.body),
                type: data.type || 'INFO',
                // Mandatory = a blocking redirect: no ack, no comment, no
                // repeat — the modal only offers the "go to new address" button.
                redirectUrl: isMandatory ? data.redirectUrl.trim() : null,
                requireAck: isMandatory
                    ? false
                    : data.requireAck === undefined
                      ? true
                      : data.requireAck,
                requireComment: isMandatory ? false : Boolean(data.requireComment),
                audience: data.audience || 'ALL',
                targetRoles: data.targetRoles || [],
                targetTeamIds: data.targetTeamIds || [],
                targetUserIds: data.targetUserIds || [],
                repeatIntervalDays: isMandatory
                    ? null
                    : (data.repeatIntervalDays ?? null),
                repeatUntil: isMandatory ? null : (data.repeatUntil ?? null),
                active: Boolean(data.active),
                activatedAt: data.active ? new Date() : null,
                createdById: req.user.id,
            },
        });
        if (created.active) await pushAnnouncement(created);
        await logActivityEvent({
            type: 'ANNOUNCEMENT_CREATED',
            actorId: req.user.id,
            message: created.title,
            meta: {
                announcementId: created.id,
                title: created.title,
                type: created.type,
                audience: created.audience,
                active: created.active,
            },
        });
        if (created.active) {
            await logActivityEvent({
                type: 'ANNOUNCEMENT_ACTIVATED',
                actorId: req.user.id,
                message: created.title,
                meta: { announcementId: created.id, title: created.title },
            });
        }
        res.status(201).json({ announcement: created });
    } catch (err) {
        next(err);
    }
});

// ── Admin: list all with acknowledged / target counts ─────────────────
router.get('/', async (req, res, next) => {
    try {
        assertAdmin(req);
        const rows = await prisma.announcement.findMany({
            orderBy: { createdAt: 'desc' },
            include: {
                createdBy: { select: { id: true, name: true, email: true } },
                _count: { select: { acks: true } },
            },
        });
        // Target count depends on each row's mode/selection.
        const announcements = await Promise.all(
            rows.map(async (a) => ({
                id: a.id,
                title: a.title,
                body: a.body,
                type: a.type,
                redirectUrl: a.redirectUrl,
                requireAck: a.requireAck,
                requireComment: a.requireComment,
                repeatIntervalDays: a.repeatIntervalDays,
                repeatUntil: a.repeatUntil,
                audience: a.audience,
                targetRoles: a.targetRoles,
                targetTeamIds: a.targetTeamIds,
                targetUserIds: a.targetUserIds,
                active: a.active,
                activatedAt: a.activatedAt,
                createdAt: a.createdAt,
                createdBy: a.createdBy || null,
                ackCount: a._count.acks,
                targetCount: await prisma.user.count({
                    where: audienceUserWhere(a),
                }),
            })),
        );
        res.json({ announcements });
    } catch (err) {
        next(err);
    }
});

// ── Admin: acknowledgement detail (who saw it + who hasn't) ────────────
router.get('/:id/acks', async (req, res, next) => {
    try {
        assertAdmin(req);
        const announcement = await prisma.announcement.findUnique({
            where: { id: req.params.id },
        });
        if (!announcement) throw httpError(404, 'Announcement not found');

        const acks = await prisma.announcementAck.findMany({
            where: { announcementId: announcement.id },
            orderBy: { acknowledgedAt: 'desc' },
            include: {
                user: {
                    select: { id: true, name: true, email: true, avatarUrl: true },
                },
            },
        });
        const ackedIds = new Set(acks.map((a) => a.userId));
        const targets = await prisma.user.findMany({
            where: audienceUserWhere(announcement),
            select: { id: true, name: true, email: true, avatarUrl: true },
            orderBy: { name: 'asc' },
        });
        const pending = targets.filter((u) => !ackedIds.has(u.id));

        res.json({
            announcement: {
                id: announcement.id,
                title: announcement.title,
                audience: announcement.audience,
                active: announcement.active,
            },
            acknowledged: acks.map((a) => ({
                user: a.user,
                comment: a.comment || null,
                acknowledgedAt: a.acknowledgedAt,
            })),
            pending,
            ackCount: acks.length,
            targetCount: targets.length,
        });
    } catch (err) {
        next(err);
    }
});

// ── Admin: update / activate / deactivate ─────────────────────────────
router.patch('/:id', async (req, res, next) => {
    try {
        assertAdmin(req);
        const data = updateSchema.parse(req.body);
        const existing = await prisma.announcement.findUnique({
            where: { id: req.params.id },
        });
        if (!existing) throw httpError(404, 'Announcement not found');

        const update = {};
        if (data.title !== undefined) update.title = data.title.trim();
        if (data.body !== undefined) update.body = sanitizeRichText(data.body);
        if (data.type !== undefined) update.type = data.type;
        if (data.requireAck !== undefined) update.requireAck = data.requireAck;
        if (data.requireComment !== undefined)
            update.requireComment = data.requireComment;
        if (data.redirectUrl !== undefined) {
            update.redirectUrl = data.redirectUrl
                ? data.redirectUrl.trim()
                : null;
        }
        // Enforce the mandatory invariants against the *resulting* row.
        const nextType = data.type !== undefined ? data.type : existing.type;
        if (nextType === 'MANDATORY') {
            const nextUrl =
                data.redirectUrl !== undefined
                    ? data.redirectUrl
                    : existing.redirectUrl;
            if (!isHttpUrl(nextUrl)) {
                throw httpError(
                    400,
                    'A redirect URL (http/https) is required for a mandatory announcement',
                );
            }
            update.redirectUrl = nextUrl.trim();
            update.requireAck = false;
            update.requireComment = false;
            update.repeatIntervalDays = null;
            update.repeatUntil = null;
        } else if (existing.type === 'MANDATORY') {
            // Switched away from mandatory → drop the stale redirect.
            update.redirectUrl = null;
        }
        if (data.audience !== undefined) update.audience = data.audience;
        if (data.targetRoles !== undefined) update.targetRoles = data.targetRoles;
        if (data.targetTeamIds !== undefined)
            update.targetTeamIds = data.targetTeamIds;
        if (data.targetUserIds !== undefined)
            update.targetUserIds = data.targetUserIds;
        if (nextType !== 'MANDATORY' && data.repeatIntervalDays !== undefined)
            update.repeatIntervalDays = data.repeatIntervalDays;
        if (nextType !== 'MANDATORY' && data.repeatUntil !== undefined)
            update.repeatUntil = data.repeatUntil;
        if (data.active !== undefined) {
            update.active = data.active;
            if (data.active && !existing.activatedAt) {
                update.activatedAt = new Date();
            }
        }
        const saved = await prisma.announcement.update({
            where: { id: existing.id },
            data: update,
        });
        // Live-push when this request activated it (turned active on).
        if (data.active === true) await pushAnnouncement(saved);
        if (data.active === true && !existing.active) {
            await logActivityEvent({
                type: 'ANNOUNCEMENT_ACTIVATED',
                actorId: req.user.id,
                message: saved.title,
                meta: { announcementId: saved.id, title: saved.title },
            });
        } else if (data.active === false && existing.active) {
            await logActivityEvent({
                type: 'ANNOUNCEMENT_DEACTIVATED',
                actorId: req.user.id,
                message: saved.title,
                meta: { announcementId: saved.id, title: saved.title },
            });
        }
        res.json({ announcement: saved });
    } catch (err) {
        next(err);
    }
});

// ── Admin: delete ─────────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
    try {
        assertAdmin(req);
        const existing = await prisma.announcement.findUnique({
            where: { id: req.params.id },
            select: { id: true, title: true },
        });
        await prisma.announcement.delete({ where: { id: req.params.id } });
        if (existing) {
            await logActivityEvent({
                type: 'ANNOUNCEMENT_DELETED',
                actorId: req.user.id,
                message: existing.title,
                meta: { announcementId: existing.id, title: existing.title },
            });
        }
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// ── Admin: re-send now — clear acknowledgements so everyone sees it
// again immediately, (re)activate it, and push it live. ───────────────
router.post('/:id/resend', async (req, res, next) => {
    try {
        assertAdmin(req);
        const existing = await prisma.announcement.findUnique({
            where: { id: req.params.id },
        });
        if (!existing) throw httpError(404, 'Announcement not found');
        await prisma.announcementAck.deleteMany({
            where: { announcementId: existing.id },
        });
        const saved = await prisma.announcement.update({
            where: { id: existing.id },
            data: { active: true, activatedAt: new Date() },
        });
        await pushAnnouncement(saved);
        await logActivityEvent({
            type: 'ANNOUNCEMENT_ACTIVATED',
            actorId: req.user.id,
            message: saved.title,
            meta: {
                announcementId: saved.id,
                title: saved.title,
                resent: true,
            },
        });
        res.json({ announcement: saved });
    } catch (err) {
        next(err);
    }
});

// ── User: active announcements this user still needs to see ───────────
router.get('/active', async (req, res, next) => {
    try {
        // Pull every active announcement plus THIS user's ack (if any) so we
        // can decide per row: show if never acknowledged, or — for recurring
        // ones — if the repeat interval has elapsed since the last ack and
        // we're still within the repeat window.
        const rows = await prisma.announcement.findMany({
            where: { active: true },
            orderBy: { activatedAt: 'asc' },
            include: {
                createdBy: { select: { id: true, name: true } },
                acks: {
                    where: { userId: req.user.id },
                    select: { acknowledgedAt: true },
                },
            },
        });
        const needTeams = rows.some((a) => a.audience === 'TEAMS');
        const facts = await viewerFacts(req, needTeams);
        const now = Date.now();
        const DAY = 86400000;
        const shouldShow = (a) => {
            const myAck = a.acks && a.acks[0];
            if (!myAck) return true; // never acknowledged → show
            if (!a.repeatIntervalDays) return false; // one-off, already acked
            if (a.repeatUntil && now > new Date(a.repeatUntil).getTime()) {
                return false; // past the repeat window
            }
            const since = now - new Date(myAck.acknowledgedAt).getTime();
            return since >= a.repeatIntervalDays * DAY; // interval elapsed
        };
        const announcements = rows
            .filter((a) => userInAudience(facts, a) && shouldShow(a))
            .map((a) => ({
                id: a.id,
                title: a.title,
                body: a.body,
                type: a.type,
                redirectUrl: a.redirectUrl,
                requireAck: a.requireAck,
                requireComment: a.requireComment,
                repeatIntervalDays: a.repeatIntervalDays,
                repeatUntil: a.repeatUntil,
                audience: a.audience,
                activatedAt: a.activatedAt,
                createdAt: a.createdAt,
                createdBy: a.createdBy || null,
            }));
        res.json({ announcements });
    } catch (err) {
        next(err);
    }
});

// ── User: acknowledge (optionally with a short response) ──────────────
router.post('/:id/ack', async (req, res, next) => {
    try {
        const data = ackSchema.parse(req.body);
        const announcement = await prisma.announcement.findUnique({
            where: { id: req.params.id },
        });
        if (!announcement) throw httpError(404, 'Announcement not found');
        const facts = await viewerFacts(
            req,
            announcement.audience === 'TEAMS',
        );
        if (!userInAudience(facts, announcement)) {
            throw httpError(403, 'This announcement is not addressed to you');
        }
        const comment =
            data.comment && data.comment.trim() ? data.comment.trim() : null;
        const ack = await prisma.announcementAck.upsert({
            where: {
                announcementId_userId: {
                    announcementId: announcement.id,
                    userId: req.user.id,
                },
            },
            update: { comment },
            create: {
                announcementId: announcement.id,
                userId: req.user.id,
                comment,
            },
        });
        await logActivityEvent({
            type: 'ANNOUNCEMENT_ACKNOWLEDGED',
            actorId: req.user.id,
            message: announcement.title,
            meta: {
                announcementId: announcement.id,
                title: announcement.title,
                comment: comment || null,
            },
        });
        res.json({ ack: { id: ack.id, acknowledgedAt: ack.acknowledgedAt } });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
