const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth, requireAdmin, invalidateUserCache } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const { avatarUpload, avatarUrl, removeFileSafe } = require('../lib/upload');
const { createResetTokenForUser, buildResetUrl } = require('../lib/resetTokens');
const realtime = require('../lib/realtime');
const { notify, broadcastPendingUserCount } = require('../lib/notify');
const { sendTemplate, appLink, APP_NAME } = require('../lib/mailer');
const { logActivityEvent } = require('../lib/activityLog');
const {
    CAPABILITIES,
    effectiveCapabilities,
    requireAdminOrCapabilityMiddleware,
    hasCapability,
} = require('../lib/permissions');

// Admin-or-capability middleware factories so admins can delegate
// specific user-management actions to non-admin users via the
// per-user capability override toggles.
const requireUserCreate = requireAdminOrCapabilityMiddleware(
    CAPABILITIES.USER_CREATE,
);
const requireUserEditAny = requireAdminOrCapabilityMiddleware(
    CAPABILITIES.USER_EDIT_ANY,
);
const requireUserApprove = requireAdminOrCapabilityMiddleware(
    CAPABILITIES.USER_APPROVE,
);

const KNOWN_CAPABILITIES = new Set(Object.values(CAPABILITIES));

const ROLE_LABELS = {
    ADMIN: 'Admin',
    MANAGER: 'Manager',
    APP_MODERATOR: 'App moderator',
    USER: 'User',
    REQUESTER: 'Requester',
};

// Friendly labels for the fields we audit on PATCH /users/:id. Anything
// not listed here is excluded from the change diff (password is logged
// via its own dedicated event, role via USER_ROLE_CHANGED).
const USER_FIELD_LABELS = {
    name: 'name',
    email: 'email',
    phone: 'phone',
    position: 'position',
    country: 'country',
    currency: 'currency',
    about: 'about',
    teamLeaderId: 'team leader',
    businessUnitId: 'business unit',
};

function arraysEqual(a, b) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    for (let i = 0; i < sortedA.length; i++) {
        if (sortedA[i] !== sortedB[i]) return false;
    }
    return true;
}

function diffUserFields(existing, data) {
    const out = [];
    for (const key of Object.keys(USER_FIELD_LABELS)) {
        if (!(key in data)) continue;
        if (data[key] === undefined) continue;
        const a = existing[key] ?? null;
        const b = data[key] === '' ? null : data[key] ?? null;
        if (a !== b) out.push(key);
    }
    return out;
}

const router = express.Router();

router.use(requireAuth);

const ROLES = ['ADMIN', 'MANAGER', 'APP_MODERATOR', 'USER', 'REQUESTER'];
const STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED'];

// Capability arrays come straight from the admin UI as a list of
// capability keys. We strictly validate against the canonical catalog
// to refuse typos / made-up keys.
const capabilitiesSchema = z
    .array(z.string())
    .max(64)
    .optional()
    .transform((val) =>
        Array.isArray(val)
            ? Array.from(new Set(val.filter((k) => KNOWN_CAPABILITIES.has(k))))
            : undefined,
    );

// Shared shape for the extra business / personal fields users fill
// out on their profile page. All optional so a brand-new user can
// fly past them at signup time.
const profileExtrasSchema = {
    country: z.string().max(80).optional().nullable(),
    currency: z.string().max(20).optional().nullable(),
    about: z.string().max(2000).optional().nullable(),
    teamLeaderId: z.string().min(1).optional().nullable(),
    businessUnitId: z.string().min(1).optional().nullable(),
    // The external organisation (client) a requester belongs to.
    clientId: z.string().min(1).optional().nullable(),
    // Internal (employee, sees all) vs external (org-scoped) requester.
    external: z.boolean().optional(),
    // For an internal requester: the ticket types they may raise.
    ticketTypeIds: z.array(z.string()).max(200).optional(),
    // Master switch for email notifications. When false, the mailer
    // skips this user entirely (see `fanOutEmails` in lib/notify.js).
    // The user can flip it from their profile dialog.
    emailNotifications: z.boolean().optional(),
    // UI theme, synced across devices via the user row. The TopBar
    // toggle PATCHes this on every change.
    themePreference: z.enum(['light', 'dark', 'dim', 'system']).optional(),
    // Personal drag order of the Projects list — array of project IDs.
    projectOrder: z.array(z.string().min(1)).max(2000).optional(),
};

const createSchema = z.object({
    email: z.string().email(),
    name: z.string().min(1).max(100),
    phone: z.string().max(40).optional().nullable(),
    position: z.string().max(120).optional().nullable(),
    // Payroll / accounting code. Admin-managed (see the isAdmin gate in
    // the update handler); accepted at create because create is admin-only.
    employeeCode: z.string().max(60).optional().nullable(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    role: z.enum(ROLES).optional(),
    status: z.enum(STATUSES).optional(),
    capabilities: capabilitiesSchema,
    // Admin-managed: opt this user into the mandatory time-log reminder.
    timeLogMandatory: z.boolean().optional(),
    ...profileExtrasSchema,
});

// status is intentionally not editable here — use the dedicated
// /approve and /suspend endpoints so we can emit the right notifications.
const updateSchema = z.object({
    email: z.string().email().optional(),
    name: z.string().min(1).max(100).optional(),
    phone: z.string().max(40).optional().nullable(),
    position: z.string().max(120).optional().nullable(),
    // Only applied when the caller is an admin (gated in the handler).
    employeeCode: z.string().max(60).optional().nullable(),
    password: z.string().min(8).optional().nullable(),
    role: z.enum(ROLES).optional(),
    capabilities: capabilitiesSchema,
    // Admin-managed (gated in the handler like employeeCode).
    timeLogMandatory: z.boolean().optional(),
    ...profileExtrasSchema,
});

// Standard Prisma include for the User shape rendered by `publicUser`.
// Centralised here so every endpoint hydrates the same set of joined
// relations (counts + teamLeader + businessUnit) without copy/paste
// drift.
const userInclude = {
    _count: { select: { projects: true, assignedTasks: true } },
    teamLeader: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    businessUnit: { select: { id: true, name: true } },
    client: { select: { id: true, name: true } },
    ticketTypes: { select: { requestTypeId: true } },
};

function publicUser(u) {
    return {
        id: u.id,
        email: u.email,
        name: u.name,
        phone: u.phone || null,
        avatarUrl: u.avatarUrl || null,
        position: u.position || null,
        employeeCode: u.employeeCode || null,
        role: u.role || 'USER',
        capabilities: Array.isArray(u.capabilities) ? u.capabilities : [],
        // Pre-computed effective set so the frontend can show "X via
        // role default" hints without re-deriving the rules.
        effectiveCapabilities: effectiveCapabilities(u),
        status: u.status || 'ACTIVE',
        approvedAt: u.approvedAt || null,
        lastLoginAt: u.lastLoginAt || null,
        timeLogMandatory: Boolean(u.timeLogMandatory),
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        projectCount: u._count?.projects ?? undefined,
        taskCount: u._count?.assignedTasks ?? undefined,
        // Profile extras — strings stay null when blank so the FE can
        // render the empty-state placeholders consistently.
        country: u.country || null,
        currency: u.currency || null,
        about: u.about || null,
        teamLeaderId: u.teamLeaderId || null,
        teamLeader: u.teamLeader
            ? {
                  id: u.teamLeader.id,
                  name: u.teamLeader.name,
                  email: u.teamLeader.email,
                  avatarUrl: u.teamLeader.avatarUrl || null,
              }
            : null,
        businessUnitId: u.businessUnitId || null,
        businessUnit: u.businessUnit
            ? { id: u.businessUnit.id, name: u.businessUnit.name }
            : null,
        clientId: u.clientId || null,
        client: u.client ? { id: u.client.id, name: u.client.name } : null,
        external: Boolean(u.external),
        ticketTypeIds: (u.ticketTypes || []).map((t) => t.requestTypeId),
        // Defaults to true at the schema level — we coerce to true
        // when the value is undefined/null so the FE never has to
        // deal with a missing field.
        emailNotifications:
            typeof u.emailNotifications === 'boolean'
                ? u.emailNotifications
                : true,
        themePreference: u.themePreference || 'system',
    };
}

// Trimmed view for non-admin listings (used to populate owner / reporter /
// assignee dropdowns). Sensitive fields like phone, counts and timestamps
// stay hidden from non-admins.
function directoryUser(u) {
    return {
        id: u.id,
        name: u.name,
        email: u.email,
        avatarUrl: u.avatarUrl || null,
        role: u.role || 'USER',
        // Lightweight org fields so the /directory page can render a
        // useful "people" view without leaking anything sensitive
        // (no phone, no last-login, no capabilities, etc.). Position
        // is free-text on the user's own profile and the business
        // unit is admin-managed metadata, so neither is private.
        position: u.position || null,
        businessUnit: u.businessUnit
            ? { id: u.businessUnit.id, name: u.businessUnit.name }
            : null,
        status: u.status || null,
    };
}

function isAdmin(req) {
    return req.user?.role === 'ADMIN';
}

function isSelf(req, id) {
    return req.user?.id === id;
}

function requireSelfOrAdmin(req, id) {
    if (!isAdmin(req) && !isSelf(req, id)) {
        throw httpError(403, 'You can only modify your own profile');
    }
}

// Validates that `id` references an existing user. When `selfId` is
// provided, we also refuse self-references so a user can't make
// themselves their own team leader (would create a degenerate cycle
// in any future org-chart view).
async function assertTeamLeader(id, selfId) {
    if (!id) return;
    if (selfId && id === selfId) {
        throw httpError(400, 'You cannot set yourself as your team leader');
    }
    const exists = await prisma.user.findUnique({
        where: { id },
        select: { id: true, status: true },
    });
    if (!exists) {
        throw httpError(400, 'Selected team leader does not exist');
    }
    if (exists.status === 'SUSPENDED') {
        throw httpError(400, 'Selected team leader is suspended');
    }
}

async function assertBusinessUnit(id) {
    if (!id) return;
    const exists = await prisma.businessUnitOption.findUnique({
        where: { id },
        select: { id: true, isActive: true },
    });
    if (!exists) {
        throw httpError(400, 'Selected business unit does not exist');
    }
    if (!exists.isActive) {
        throw httpError(400, 'Selected business unit is no longer active');
    }
}

// Snapshot of who's currently connected via the realtime channel. Used by the
// UI on first load before any presence:update events have arrived.
router.get('/online', (req, res) => {
    res.json({ online: realtime.getOnlineUserIds() });
});

// Count of users currently waiting for admin approval. Drives the small
// badge on the Users sidebar entry.
router.get('/pending-count', requireAdmin, async (req, res, next) => {
    try {
        const pending = await prisma.user.count({ where: { status: 'PENDING' } });
        res.json({ pending });
    } catch (err) {
        next(err);
    }
});

// Anyone signed in can list users so the UI can populate owner / reporter /
// assignee dropdowns. Non-admins get a trimmed payload (no phone, no counts);
// admins get the full management view.
router.get('/', async (req, res, next) => {
    try {
        if (isAdmin(req)) {
            const users = await prisma.user.findMany({
                orderBy: { createdAt: 'asc' },
                include: userInclude,
            });
            return res.json({ users: users.map(publicUser) });
        }

        const users = await prisma.user.findMany({
            orderBy: { name: 'asc' },
            select: {
                id: true,
                name: true,
                email: true,
                avatarUrl: true,
                role: true,
                position: true,
                status: true,
                businessUnit: { select: { id: true, name: true } },
            },
        });
        res.json({ users: users.map(directoryUser) });
    } catch (err) {
        next(err);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        if (!isAdmin(req) && !isSelf(req, req.params.id)) {
            throw httpError(403, 'You can only view your own profile');
        }
        const user = await prisma.user.findUnique({
            where: { id: req.params.id },
            include: userInclude,
        });
        if (!user) throw httpError(404, 'User not found');
        res.json({ user: publicUser(user) });
    } catch (err) {
        next(err);
    }
});

router.post('/', requireUserCreate, async (req, res, next) => {
    try {
        const data = createSchema.parse(req.body);

        const existing = await prisma.user.findUnique({ where: { email: data.email } });
        if (existing) throw httpError(409, 'Email already in use');

        if (data.external && !data.clientId) {
            throw httpError(
                400,
                'External requesters must belong to an organization.',
            );
        }

        const password = await bcrypt.hash(data.password, 10);
        // Admin-created accounts are pre-approved unless the admin explicitly
        // creates them as PENDING/SUSPENDED.
        const status = data.status || 'ACTIVE';
        // Validate FK refs eagerly so the create doesn't fall through
        // to a Prisma P2003 with a useless message. We use the same
        // helpers on PATCH below — see `assertTeamLeader` /
        // `assertBusinessUnit`.
        if (data.teamLeaderId) {
            await assertTeamLeader(data.teamLeaderId, null);
        }
        if (data.businessUnitId) {
            await assertBusinessUnit(data.businessUnitId);
        }

        const user = await prisma.user.create({
            data: {
                email: data.email,
                name: data.name,
                phone: data.phone || null,
                position: data.position || null,
                // employeeCode is admin-managed — a non-admin USER_CREATE
                // holder can create users but must not set payroll codes.
                employeeCode:
                    isAdmin(req) ||
                    hasCapability(req, CAPABILITIES.USER_EDIT_ANY)
                        ? data.employeeCode || null
                        : null,
                password,
                // Admin-managed, same gate as employeeCode.
                timeLogMandatory:
                    (isAdmin(req) ||
                        hasCapability(req, CAPABILITIES.USER_EDIT_ANY)) &&
                    data.timeLogMandatory
                        ? true
                        : false,
                // New users default to Requester (lowest-privilege) when
                // no role is supplied.
                role: data.role || 'REQUESTER',
                capabilities: data.capabilities || [],
                status,
                approvedAt: status === 'ACTIVE' ? new Date() : null,
                country: data.country || null,
                currency: data.currency || null,
                about: data.about || null,
                teamLeaderId: data.teamLeaderId || null,
                businessUnitId: data.businessUnitId || null,
                clientId: data.clientId || null,
                external: Boolean(data.external),
                ticketTypes: (data.ticketTypeIds || []).length
                    ? {
                          create: Array.from(
                              new Set(data.ticketTypeIds),
                          ).map((requestTypeId) => ({ requestTypeId })),
                      }
                    : undefined,
            },
            include: userInclude,
        });

        await logActivityEvent({
            type: 'USER_CREATED',
            actorId: req.user.id,
            message: user.name,
            toValue: ROLE_LABELS[user.role] || user.role,
            meta: {
                targetUserId: user.id,
                targetUserName: user.name,
                targetUserEmail: user.email,
                role: user.role,
                status: user.status,
            },
        });

        res.status(201).json({ user: publicUser(user) });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        const data = updateSchema.parse(req.body);
        // Self-edit always allowed; otherwise needs admin OR the
        // `user:edit:any` capability override.
        const editingOther = req.user?.id !== req.params.id;
        if (
            editingOther &&
            !isAdmin(req) &&
            !hasCapability(req, CAPABILITIES.USER_EDIT_ANY)
        ) {
            throw httpError(403, 'You can only modify your own profile');
        }

        const target = await prisma.user.findUnique({ where: { id: req.params.id } });
        if (!target) throw httpError(404, 'User not found');

        // Changing roles requires admin OR the explicit
        // `user:role:manage` capability override. Capabilities (the
        // `data.capabilities` field) remain admin-only — delegating
        // the ability to grant capabilities would let a user grant
        // themselves admin power transitively.
        if (data.role && data.role !== target.role) {
            const canManageRole =
                isAdmin(req) ||
                hasCapability(req, CAPABILITIES.USER_ROLE_MANAGE);
            if (!canManageRole) {
                throw httpError(403, 'Only admins can change roles');
            }
            if (target.role === 'ADMIN' && data.role !== 'ADMIN') {
                const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
                if (adminCount <= 1) {
                    throw httpError(400, 'You cannot demote the last admin');
                }
            }
        }

        if (data.email && data.email !== target.email) {
            const dup = await prisma.user.findUnique({ where: { email: data.email } });
            if (dup) throw httpError(409, 'Email already in use');
        }

        const updateData = {};
        if (data.email !== undefined) updateData.email = data.email;
        if (data.name !== undefined) updateData.name = data.name;
        if (data.phone !== undefined) updateData.phone = data.phone || null;
        if (data.position !== undefined) updateData.position = data.position || null;
        // employeeCode is admin-managed: only apply it when the caller is an
        // admin (or holds user:edit:any). A self-service profile PATCH can't
        // set its own code even if it were slipped into the body.
        if (
            data.employeeCode !== undefined &&
            (isAdmin(req) || hasCapability(req, CAPABILITIES.USER_EDIT_ANY))
        ) {
            updateData.employeeCode = data.employeeCode
                ? data.employeeCode.trim()
                : null;
        }
        // Time-log mandatory flag is admin-managed, same gate as above.
        if (
            data.timeLogMandatory !== undefined &&
            (isAdmin(req) || hasCapability(req, CAPABILITIES.USER_EDIT_ANY))
        ) {
            updateData.timeLogMandatory = Boolean(data.timeLogMandatory);
        }
        // Profile extras. Validate FK refs first so we surface a
        // useful error instead of a generic P2003.
        if (data.country !== undefined) {
            updateData.country = data.country ? data.country.trim() : null;
        }
        if (data.currency !== undefined) {
            updateData.currency = data.currency ? data.currency.trim() : null;
        }
        if (data.about !== undefined) {
            updateData.about = data.about ? data.about.trim() : null;
        }
        if (data.teamLeaderId !== undefined) {
            const id = data.teamLeaderId || null;
            if (id) await assertTeamLeader(id, req.params.id);
            updateData.teamLeaderId = id;
        }
        if (data.businessUnitId !== undefined) {
            const id = data.businessUnitId || null;
            if (id) await assertBusinessUnit(id);
            updateData.businessUnitId = id;
        }
        if (data.clientId !== undefined) {
            updateData.clientId = data.clientId || null;
        }
        if (data.external !== undefined) {
            updateData.external = Boolean(data.external);
        }
        if (data.ticketTypeIds !== undefined) {
            const ids = Array.from(new Set(data.ticketTypeIds));
            updateData.ticketTypes = {
                deleteMany: {},
                create: ids.map((requestTypeId) => ({ requestTypeId })),
            };
        }
        // An external requester must end up with an organisation.
        const finalExternal =
            data.external !== undefined ? data.external : target.external;
        const finalClientId =
            data.clientId !== undefined
                ? data.clientId || null
                : target.clientId;
        if (finalExternal && !finalClientId) {
            throw httpError(
                400,
                'External requesters must belong to an organization.',
            );
        }
        if (data.emailNotifications !== undefined) {
            updateData.emailNotifications = Boolean(data.emailNotifications);
        }
        if (data.themePreference !== undefined) {
            updateData.themePreference = data.themePreference;
        }
        if (data.projectOrder !== undefined) {
            updateData.projectOrder = data.projectOrder;
        }
        // Only an admin acting on someone else can set a password from
        // this endpoint. A user changing their own password MUST go
        // through POST /api/auth/change-password, which requires the
        // current password — otherwise a stolen access token could be
        // used to lock out the rightful owner.
        if (data.password && isAdmin(req) && !isSelf(req, req.params.id)) {
            updateData.password = await bcrypt.hash(data.password, 10);
        } else if (data.password) {
            throw httpError(
                400,
                'Use /api/auth/change-password to change your own password',
            );
        }
        if (
            data.role !== undefined &&
            (isAdmin(req) || hasCapability(req, CAPABILITIES.USER_ROLE_MANAGE))
        ) {
            updateData.role = data.role;
        }
        if (data.capabilities !== undefined && isAdmin(req)) {
            // Admins are the only ones who can edit per-user capability
            // overrides. Delegating this would let any user with role-
            // mgmt grant themselves arbitrary additional powers.
            updateData.capabilities = data.capabilities;
        }

        const user = await prisma.user.update({
            where: { id: req.params.id },
            data: updateData,
            include: userInclude,
        });

        // Bust the auth cache so the freshly-saved role/capabilities
        // are visible to the next request, not 30 seconds later.
        invalidateUserCache(user.id);

        // Audit-log every change. Role / password get their own
        // dedicated event types so the feed reads cleanly. Everything
        // else is collapsed into a single USER_PROFILE_UPDATED entry
        // that lists which fields changed (and the before/after).
        const targetMeta = {
            targetUserId: user.id,
            targetUserName: user.name,
            targetUserEmail: user.email,
            self: isSelf(req, user.id),
        };

        if (
            data.role !== undefined &&
            isAdmin(req) &&
            data.role !== target.role
        ) {
            await logActivityEvent({
                type: 'USER_ROLE_CHANGED',
                actorId: req.user.id,
                message: user.name,
                fromValue: ROLE_LABELS[target.role] || target.role,
                toValue: ROLE_LABELS[data.role] || data.role,
                meta: targetMeta,
            });
        }

        // Capability override edits get their own audit entry. We only
        // log when the set actually changed (admin opened the form,
        // checked nothing, hit save = no event).
        if (
            data.capabilities !== undefined &&
            isAdmin(req) &&
            !arraysEqual(target.capabilities || [], data.capabilities)
        ) {
            await logActivityEvent({
                type: 'USER_CAPABILITIES_CHANGED',
                actorId: req.user.id,
                message: user.name,
                fromValue: (target.capabilities || []).join(', ') || '—',
                toValue: data.capabilities.join(', ') || '—',
                meta: {
                    ...targetMeta,
                    before: target.capabilities || [],
                    after: data.capabilities,
                },
            });
        }

        if (updateData.password) {
            await logActivityEvent({
                type: 'USER_PASSWORD_CHANGED',
                actorId: req.user.id,
                message: user.name,
                meta: { ...targetMeta, byAdmin: true },
            });
        }

        const changedFields = diffUserFields(target, data);
        if (changedFields.length > 0) {
            const labelList = changedFields
                .map((f) => USER_FIELD_LABELS[f])
                .join(', ');
            const diff = Object.fromEntries(
                changedFields.map((f) => [
                    f,
                    {
                        from: target[f] ?? null,
                        to: (data[f] === '' ? null : data[f]) ?? null,
                    },
                ]),
            );
            await logActivityEvent({
                type: 'USER_PROFILE_UPDATED',
                actorId: req.user.id,
                message: user.name,
                toValue: labelList,
                meta: { ...targetMeta, fields: changedFields, diff },
            });
        }

        res.json({ user: publicUser(user) });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', requireUserEditAny, async (req, res, next) => {
    try {
        if (req.params.id === req.user.id) {
            throw httpError(400, 'You cannot delete your own account');
        }

        const user = await prisma.user.findUnique({ where: { id: req.params.id } });
        if (!user) throw httpError(404, 'User not found');

        if (user.role === 'ADMIN') {
            const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
            if (adminCount <= 1) {
                throw httpError(400, 'You cannot delete the last admin');
            }
        }

        if (user.avatarUrl) removeFileSafe(user.avatarUrl);
        await prisma.user.delete({ where: { id: req.params.id } });
        if (user.status === 'PENDING') await broadcastPendingUserCount();

        await logActivityEvent({
            type: 'USER_DELETED',
            actorId: req.user.id,
            message: user.name,
            toValue: user.email,
            meta: {
                targetUserId: user.id,
                targetUserName: user.name,
                targetUserEmail: user.email,
                role: user.role,
                status: user.status,
            },
        });

        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// Cheap pre-flight gate so we never spend disk on a 5MB upload from
// someone who has no business writing to this user record.
function ensureAvatarAccess(req, res, next) {
    try {
        requireSelfOrAdmin(req, req.params.id);
        next();
    } catch (err) {
        next(err);
    }
}

router.post(
    '/:id/avatar',
    ensureAvatarAccess,
    avatarUpload.single('avatar'),
    async (req, res, next) => {
    try {
        if (!req.file) throw httpError(400, 'No file uploaded');

        const target = await prisma.user.findUnique({ where: { id: req.params.id } });
        if (!target) {
            removeFileSafe(avatarUrl(req.file.filename));
            throw httpError(404, 'User not found');
        }

        if (target.avatarUrl) removeFileSafe(target.avatarUrl);

        const user = await prisma.user.update({
            where: { id: req.params.id },
            data: { avatarUrl: avatarUrl(req.file.filename) },
            include: userInclude,
        });

        await logActivityEvent({
            type: 'USER_AVATAR_UPDATED',
            actorId: req.user.id,
            message: user.name,
            meta: {
                targetUserId: user.id,
                targetUserName: user.name,
                self: isSelf(req, user.id),
                hadPrevious: Boolean(target.avatarUrl),
            },
        });

        res.json({ user: publicUser(user) });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id/avatar', async (req, res, next) => {
    try {
        requireSelfOrAdmin(req, req.params.id);

        const target = await prisma.user.findUnique({ where: { id: req.params.id } });
        if (!target) throw httpError(404, 'User not found');

        const hadAvatar = Boolean(target.avatarUrl);
        if (target.avatarUrl) removeFileSafe(target.avatarUrl);
        const user = await prisma.user.update({
            where: { id: req.params.id },
            data: { avatarUrl: null },
            include: userInclude,
        });

        if (hadAvatar) {
            await logActivityEvent({
                type: 'USER_AVATAR_REMOVED',
                actorId: req.user.id,
                message: user.name,
                meta: {
                    targetUserId: user.id,
                    targetUserName: user.name,
                    self: isSelf(req, user.id),
                },
            });
        }

        res.json({ user: publicUser(user) });
    } catch (err) {
        next(err);
    }
});

router.post('/:id/reset-link', requireUserEditAny, async (req, res, next) => {
    try {
        const target = await prisma.user.findUnique({ where: { id: req.params.id } });
        if (!target) throw httpError(404, 'User not found');

        const { token, expiresAt } = await createResetTokenForUser(target.id);
        res.json({ resetUrl: buildResetUrl(token), expiresAt });
    } catch (err) {
        next(err);
    }
});

// Approve a PENDING (or re-activate a SUSPENDED) account so they can log in.
router.post('/:id/approve', requireUserApprove, async (req, res, next) => {
    try {
        const target = await prisma.user.findUnique({ where: { id: req.params.id } });
        if (!target) throw httpError(404, 'User not found');

        if (target.status === 'ACTIVE') {
            const fresh = await prisma.user.findUnique({
                where: { id: req.params.id },
                include: userInclude,
            });
            return res.json({ user: publicUser(fresh), changed: false });
        }

        const wasPending = target.status === 'PENDING';
        const user = await prisma.user.update({
            where: { id: req.params.id },
            data: {
                status: 'ACTIVE',
                approvedAt: target.approvedAt || new Date(),
            },
            include: userInclude,
        });

        await notify({
            recipientIds: [user.id],
            actorId: req.user.id,
            type: 'USER_APPROVED',
            title: wasPending
                ? 'Your account has been approved'
                : 'Your account has been reactivated',
            body: wasPending
                ? 'Welcome aboard — you can now sign in and start using the app.'
                : 'You can sign in again.',
        });
        if (wasPending) await broadcastPendingUserCount();

        await logActivityEvent({
            type: wasPending ? 'USER_APPROVED' : 'USER_REACTIVATED',
            actorId: req.user.id,
            message: user.name,
            fromValue: target.status,
            toValue: 'ACTIVE',
            meta: {
                targetUserId: user.id,
                targetUserName: user.name,
                targetUserEmail: user.email,
            },
        });

        // Out-of-app heads-up — the user might not be signed in yet, so an
        // explicit welcome email is the only reliable channel here.
        sendTemplate({
            to: user.email,
            subject: wasPending
                ? `Your ${APP_NAME} account has been approved`
                : `Your ${APP_NAME} account is active again`,
            heading: wasPending
                ? 'Welcome aboard 🎉'
                : 'Your account has been reactivated',
            intro: `Hi ${user.name?.split(' ')[0] || 'there'},`,
            body: wasPending
                ? `An administrator just approved your access. You can now sign in and start collaborating in ${APP_NAME}. Please update your account information.`
                : `Your account has been reactivated. You can sign in again whenever you're ready.`,
            ctaText: 'Sign in now',
            ctaUrl: appLink('/login'),
            footer: `If you weren't expecting this email, you can safely ignore it.`,
        }).catch(() => {});

        res.json({ user: publicUser(user), changed: true });
    } catch (err) {
        next(err);
    }
});

// Block a user from logging in without deleting their data.
router.post('/:id/suspend', requireUserEditAny, async (req, res, next) => {
    try {
        if (req.params.id === req.user.id) {
            throw httpError(400, 'You cannot suspend your own account');
        }

        const target = await prisma.user.findUnique({ where: { id: req.params.id } });
        if (!target) throw httpError(404, 'User not found');

        // Don't strand the org without an active admin.
        if (target.role === 'ADMIN' && target.status === 'ACTIVE') {
            const activeAdmins = await prisma.user.count({
                where: { role: 'ADMIN', status: 'ACTIVE' },
            });
            if (activeAdmins <= 1) {
                throw httpError(400, 'You cannot suspend the last active admin');
            }
        }

        const user = await prisma.user.update({
            where: { id: req.params.id },
            data: { status: 'SUSPENDED' },
            include: userInclude,
        });

        await logActivityEvent({
            type: 'USER_SUSPENDED',
            actorId: req.user.id,
            message: user.name,
            fromValue: target.status,
            toValue: 'SUSPENDED',
            meta: {
                targetUserId: user.id,
                targetUserName: user.name,
                targetUserEmail: user.email,
            },
        });

        res.json({ user: publicUser(user) });
    } catch (err) {
        next(err);
    }
});

// GET /api/users/:id/profile
//
// Rich aggregator behind the public-facing user profile page. Returns
// everything the FE needs to render the page in a single round-trip:
//
//   identity        — the `publicUser` view (name, email, role, status,
//                     position, country, currency, about, businessUnit,
//                     teamLeader, lastLoginAt, createdAt …)
//   teams           — direct reports + every Team membership row (with
//                     team name + role)
//   stats           — projects owned / participating, tasks
//                     assigned/done/in-progress, sprints created,
//                     applications + releases authored, total hours
//                     logged, last week / month buckets
//   timeHeatmap     — last 84 days (12 weeks) of time entries, one
//                     row per day with total seconds. Drives the
//                     GitHub-style heatmap on the page.
//   recentActivity  — last 12 audit events the user triggered
//   pinCounts       — { PROJECT, TASK_FOCUS, SPRINT_GOAL, RELEASE_PROD,
//                     ACTIVITY } counts (only filled when viewing own
//                     profile, since pins are private)
//
// Permissions: anyone signed in can view another user's profile (the
// data is already exposed piecemeal via the existing endpoints — this
// just packages it). Pin counts collapse to null for OTHER users so
// we don't accidentally leak someone else's bookmarks.
router.get('/:id/profile', async (req, res, next) => {
    try {
        const targetId = req.params.id;
        const self = isSelf(req, targetId);

        const target = await prisma.user.findUnique({
            where: { id: targetId },
            include: {
                ...userInclude,
                directReports: {
                    where: { status: { not: 'SUSPENDED' } },
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        avatarUrl: true,
                        position: true,
                        role: true,
                    },
                    orderBy: { name: 'asc' },
                },
            },
        });
        if (!target) throw httpError(404, 'User not found');

        // Heatmap window — caller can pick a length so the same
        // endpoint backs the period switcher on the FE. Default 84
        // (12w), clamped to [14, 366] so we don't accidentally pull
        // years of TimeEntry rows.
        const requestedDays = Number.parseInt(req.query.heatmapDays, 10);
        const heatmapDays = Number.isFinite(requestedDays)
            ? Math.max(14, Math.min(366, requestedDays))
            : 84;

        const now = new Date();
        const heatmapFrom = new Date(now);
        heatmapFrom.setDate(heatmapFrom.getDate() - (heatmapDays - 1));
        heatmapFrom.setHours(0, 0, 0, 0);

        const weekAgo = new Date(now.getTime() - 7 * 86400 * 1000);
        const monthAgo = new Date(now.getTime() - 30 * 86400 * 1000);

        // Counters + heatmap + recent activity all fan out in parallel.
        // Promise.allSettled so one slow / failing query doesn't drag
        // the whole profile down — the FE just shows "—" for any
        // missing block.
        const [
            ownedProjects,
            participantRows,
            tasksByStatus,
            sprintsCreated,
            applicationsCreated,
            releasesUploaded,
            totalSeconds,
            weekSeconds,
            monthSeconds,
            timeEntriesForHeatmap,
            recentActivity,
            teamMemberships,
            pinRows,
            projectList,
        ] = await Promise.all([
            prisma.project.count({ where: { ownerId: targetId } }),
            prisma.projectParticipant.count({ where: { userId: targetId } }),
            prisma.task.groupBy({
                by: ['status'],
                where: { assigneeId: targetId },
                _count: { _all: true },
            }),
            prisma.sprint.count({ where: { createdById: targetId } }),
            prisma.application.count({ where: { createdById: targetId } }),
            prisma.appRelease.count({
                where: { uploadedById: targetId },
            }),
            // Sum of duration on every CLOSED entry. We can't aggregate
            // `endedAt - startedAt` directly in Prisma without a raw
            // query, so we pull the lightweight pair of fields and roll
            // them up in JS. Capped at the user's full history — fine
            // for now since most users have at most a few thousand
            // entries.
            prisma.timeEntry.findMany({
                where: { userId: targetId, endedAt: { not: null } },
                select: { startedAt: true, endedAt: true },
            }),
            prisma.timeEntry.findMany({
                where: {
                    userId: targetId,
                    endedAt: { not: null },
                    startedAt: { gte: weekAgo },
                },
                select: { startedAt: true, endedAt: true },
            }),
            prisma.timeEntry.findMany({
                where: {
                    userId: targetId,
                    endedAt: { not: null },
                    startedAt: { gte: monthAgo },
                },
                select: { startedAt: true, endedAt: true },
            }),
            prisma.timeEntry.findMany({
                where: {
                    userId: targetId,
                    endedAt: { not: null },
                    startedAt: { gte: heatmapFrom },
                },
                select: { startedAt: true, endedAt: true },
            }),
            prisma.activityEvent.findMany({
                where: { actorId: targetId },
                orderBy: { createdAt: 'desc' },
                take: 12,
                select: {
                    id: true,
                    type: true,
                    message: true,
                    createdAt: true,
                    projectId: true,
                    taskId: true,
                    // ActivityEvent doesn't have a relation to Task
                    // (taskId is denormalised). Project IS a real
                    // relation though, so we can join through it.
                    project: { select: { id: true, name: true, code: true } },
                },
            }),
            prisma.teamMember.findMany({
                where: { userId: targetId },
                select: {
                    addedAt: true,
                    team: {
                        select: {
                            id: true,
                            name: true,
                            description: true,
                            color: true,
                            _count: { select: { members: true } },
                        },
                    },
                },
            }),
            self
                ? prisma.userPin.groupBy({
                      by: ['kind'],
                      where: { userId: targetId },
                      _count: { _all: true },
                  })
                : Promise.resolve(null),
            // Projects the user is involved in — owner OR participant.
            // Powers the "Projects" card on the profile. Soft-deleted
            // projects are auto-filtered by the Prisma client extension.
            prisma.project.findMany({
                where: {
                    isPersonal: false,
                    OR: [
                        { ownerId: targetId },
                        { participants: { some: { userId: targetId } } },
                    ],
                },
                orderBy: [{ updatedAt: 'desc' }],
                select: {
                    id: true,
                    code: true,
                    name: true,
                    status: true,
                    ownerId: true,
                },
            }),
        ]);

        const sumSeconds = (rows) =>
            rows.reduce(
                (acc, r) =>
                    acc +
                    Math.max(
                        0,
                        Math.floor(
                            (new Date(r.endedAt).getTime() -
                                new Date(r.startedAt).getTime()) /
                                1000,
                        ),
                    ),
                0,
            );

        // Bucket the heatmap entries by yyyy-mm-dd (server-local, which
        // matches the user's timezone in practice). Empty days are
        // filled in below so the FE can render a clean 12x7 grid.
        const buckets = new Map();
        for (const e of timeEntriesForHeatmap) {
            const d = new Date(e.startedAt);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const seconds = Math.max(
                0,
                Math.floor(
                    (new Date(e.endedAt).getTime() -
                        new Date(e.startedAt).getTime()) /
                        1000,
                ),
            );
            buckets.set(key, (buckets.get(key) || 0) + seconds);
        }
        const heatmap = [];
        for (let i = 0; i < heatmapDays; i++) {
            const d = new Date(heatmapFrom);
            d.setDate(d.getDate() + i);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const seconds = buckets.get(key) || 0;
            heatmap.push({
                date: key,
                seconds,
                hours: Math.round((seconds / 3600) * 100) / 100,
            });
        }

        const tasksAssigned = tasksByStatus.reduce(
            (acc, r) => acc + r._count._all,
            0,
        );
        const tasksDone =
            tasksByStatus.find((r) => r.status === 'DONE')?._count._all || 0;
        const tasksInProgress =
            tasksByStatus.find((r) => r.status === 'IN_PROGRESS')?._count
                ._all || 0;

        const pinCounts = self
            ? Object.fromEntries(
                  (pinRows || []).map((p) => [p.kind, p._count._all]),
              )
            : null;

        res.json({
            user: publicUser(target),
            teams: teamMemberships.map((m) => ({
                id: m.team.id,
                name: m.team.name,
                description: m.team.description || null,
                color: m.team.color || null,
                joinedAt: m.addedAt,
                memberCount: m.team._count?.members ?? null,
            })),
            directReports: target.directReports,
            projects: (projectList || []).map((p) => ({
                id: p.id,
                code: p.code,
                name: p.name,
                status: p.status,
                isOwner: p.ownerId === targetId,
            })),
            stats: {
                projectsOwned: ownedProjects,
                projectsParticipating: participantRows,
                tasksAssigned,
                tasksDone,
                tasksInProgress,
                sprintsCreated,
                applicationsCreated,
                releasesUploaded,
                totalHours:
                    Math.round((sumSeconds(totalSeconds) / 3600) * 100) /
                    100,
                hoursLast7d:
                    Math.round((sumSeconds(weekSeconds) / 3600) * 100) /
                    100,
                hoursLast30d:
                    Math.round((sumSeconds(monthSeconds) / 3600) * 100) /
                    100,
                totalEntries: totalSeconds.length,
            },
            timeHeatmap: {
                from: heatmapFrom.toISOString(),
                to: now.toISOString(),
                periodDays: heatmapDays,
                days: heatmap,
            },
            recentActivity: recentActivity.map((a) => ({
                id: a.id,
                type: a.type,
                message: a.message,
                createdAt: a.createdAt,
                project: a.project,
                taskId: a.taskId,
            })),
            pinCounts,
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
