// Applications catalogue.
//
// API surface (mounted at /api/applications):
//
//   GET    /                                        list (any authenticated user)
//   POST   /                                        create (admin or manager)
//   GET    /:id                                     detail w/ releases + notes
//   PATCH  /:id                                     update (admin or manager)
//   DELETE /:id                                     delete (admin)
//   POST   /:id/logo                                upload application logo
//   DELETE /:id/logo                                remove logo
//
//   POST   /:id/releases                            create release
//   PATCH  /:id/releases/:releaseId                 update
//   DELETE /:id/releases/:releaseId                 delete
//   POST   /:id/releases/:releaseId/file            attach release artifact
//   DELETE /:id/releases/:releaseId/file            detach release artifact
//
//   POST   /:id/releases/:releaseId/notes           post note
//   PATCH  /:id/releases/:releaseId/notes/:noteId   edit (author or admin)
//   DELETE /:id/releases/:releaseId/notes/:noteId   delete
//
// Permissions:
//   - Read everything: any authenticated user.
//   - Create / edit applications + releases / attach files: admin or
//     manager.
//   - Delete an application or any release: admin only (managers can
//     soft-cleanup by editing instead).
//   - Notes: any authenticated user can post; the author or an admin
//     can edit / delete it.

const express = require('express');
const path = require('node:path');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    isAdmin,
    hasCapability,
    requireCapability,
    CAPABILITIES,
} = require('../lib/permissions');
const {
    appLogoUpload,
    appLogoUrl,
    fileUpload,
    fileUrl,
    signFileUrl,
    removeFileSafe,
} = require('../lib/upload');
const { logActivityEvent } = require('../lib/activityLog');

// Best-effort audit logger that swallows every error so a failure in
// the audit pipeline never bubbles up into the user-facing application
// response. Mirrors the pattern used by time.js and reassignments.js.
async function logAppActivity(type, req, payload) {
    try {
        await logActivityEvent({
            type,
            actorId: req.user?.id || null,
            meta: payload,
        });
    } catch (err) {
        console.error(`[apps] failed to log ${type}:`, err);
    }
}

const router = express.Router();
router.use(requireAuth);

// `requireCapability` from lib/permissions is a *throw-only* assertion
// designed to be called inline at the top of a handler. Using it as
// Express middleware directly would silently hang requests when the
// check passes (because the guard never calls `next()`). For routes
// that need a real middleware (e.g. before multer's file parser, where
// we can't simply run the check inside the final handler), wrap it
// with this adapter.
function requireCapabilityMiddleware(capability) {
    return (req, res, next) => {
        try {
            requireCapability(req, capability);
            next();
        } catch (err) {
            next(err);
        }
    };
}

const PHASES = ['TEST', 'PILOT', 'APPROVED'];

// --- validation ------------------------------------------------------------

const optionalShortText = (max) =>
    z
        .string()
        .max(max)
        .optional()
        .nullable()
        .transform((v) => (v && v.trim() ? v.trim() : null));

const optionalLongText = (max) =>
    z
        .string()
        .max(max)
        .optional()
        .nullable()
        .transform((v) => (v && v.trim() ? v.trim() : null));

const applicationCreateSchema = z.object({
    name: z.string().min(1).max(150).transform((v) => v.trim()),
    packageName: z
        .string()
        .max(200)
        .optional()
        .nullable()
        .transform((v) => (v && v.trim() ? v.trim() : null)),
    description: optionalLongText(2000),
    dependencies: optionalLongText(4000),
    importantBehaviour: optionalLongText(4000),
    importantNotes: optionalLongText(4000),
});

const applicationUpdateSchema = applicationCreateSchema.partial();

// `targetOs` and `posTerminalType` are multi-select arrays (admin-defined
// catalogue values, but stored as plain strings on the release so the
// catalogue can later be renamed/deleted without orphaning data).
const stringArray = (max, perItem) =>
    z
        .array(z.string().max(perItem))
        .max(max)
        .optional()
        .nullable()
        .transform((v) => {
            if (!v) return [];
            const cleaned = v
                .map((s) => (typeof s === 'string' ? s.trim() : ''))
                .filter(Boolean);
            // De-dupe while preserving first occurrence — keeps the
            // chip ordering stable for the user.
            return Array.from(new Set(cleaned));
        });

const releaseCreateSchema = z.object({
    version: z.string().min(1).max(60).transform((v) => v.trim()),
    releaseDate: z
        .string()
        .datetime({ offset: true })
        .optional()
        .nullable()
        .transform((v) => (v ? new Date(v) : null)),
    phase: z.enum(PHASES).optional(),
    targetOs: stringArray(20, 60),
    posTerminalType: stringArray(20, 60),
    minimumVersion: optionalShortText(60),
    fixes: optionalLongText(4000),
    importantNotes: optionalLongText(4000),
});

const releaseUpdateSchema = releaseCreateSchema.partial();

// When a release moves into a phase for the first time we stamp the
// corresponding `*At` column. Doing this server-side keeps the
// "promoted to Pilot on 14 May" timeline accurate even if the user
// edits the row later — the original transition timestamp survives.
function phaseTransitionPatch(currentRow, nextPhase) {
    if (!nextPhase) return {};
    const patch = { phase: nextPhase };
    if (nextPhase === 'TEST' && !currentRow?.testAt) patch.testAt = new Date();
    if (nextPhase === 'PILOT' && !currentRow?.pilotAt) patch.pilotAt = new Date();
    if (nextPhase === 'APPROVED' && !currentRow?.approvedAt) {
        patch.approvedAt = new Date();
    }
    return patch;
}

const noteCreateSchema = z.object({
    content: z.string().min(1).max(4000).transform((v) => v.trim()),
});

const noteUpdateSchema = noteCreateSchema;

const CHECKPOINT_KINDS = [
    'PROD_DEPLOY',
    'PROD_ROLLBACK',
    'PILOT_DEPLOY',
    'TEST_DEPLOY',
    'NOTE',
];

const checkpointCreateSchema = z.object({
    kind: z.enum(CHECKPOINT_KINDS).optional(),
    occurredAt: z.coerce.date().optional(),
    environment: optionalShortText(120),
    note: optionalLongText(2000),
});

const checkpointUpdateSchema = checkpointCreateSchema.partial();

// --- includes --------------------------------------------------------------

const releaseSelect = {
    id: true,
    version: true,
    releaseDate: true,
    phase: true,
    testAt: true,
    pilotAt: true,
    approvedAt: true,
    targetOs: true,
    posTerminalType: true,
    minimumVersion: true,
    fixes: true,
    importantNotes: true,
    fileUrl: true,
    fileName: true,
    fileSize: true,
    fileMimeType: true,
    uploadedById: true,
    uploadedBy: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    createdAt: true,
    updatedAt: true,
};

const releaseWithNotesInclude = {
    uploadedBy: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    notes: {
        orderBy: { createdAt: 'desc' },
        include: {
            author: {
                select: { id: true, name: true, email: true, avatarUrl: true },
            },
        },
    },
    checkpoints: {
        orderBy: { occurredAt: 'desc' },
        include: {
            author: {
                select: { id: true, name: true, email: true, avatarUrl: true },
            },
        },
    },
};

// Listing payload: we no longer return only the single newest release
// because the cards render "latest per phase" badges. We pull a small
// window of recent releases and let the client group them by phase —
// keeps the API simple and avoids three separate queries per app.
const applicationListSelect = {
    id: true,
    name: true,
    packageName: true,
    description: true,
    logoUrl: true,
    createdAt: true,
    updatedAt: true,
    createdBy: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    _count: { select: { releases: true } },
    releases: {
        orderBy: [{ createdAt: 'desc' }],
        take: 30,
        select: {
            id: true,
            version: true,
            phase: true,
            releaseDate: true,
            testAt: true,
            pilotAt: true,
            approvedAt: true,
            createdAt: true,
        },
    },
};

// Map a release row's `fileUrl` to a freshly signed URL for the
// requesting user. Returns a shallow copy so we never mutate the
// row Prisma handed back.
function signReleaseFile(release, userId) {
    if (!release || !release.fileUrl) return release;
    // Signed URL only works on /uploads/files/<filename>.
    const filename = path.basename(release.fileUrl.split('?')[0]);
    return {
        ...release,
        fileUrl: signFileUrl(filename, userId, undefined, release.fileName),
    };
}

// --- helpers ---------------------------------------------------------------

async function loadApplicationOr404(id) {
    const app = await prisma.application.findUnique({ where: { id } });
    if (!app) throw httpError(404, 'Application not found');
    return app;
}

async function loadReleaseOr404(applicationId, releaseId) {
    const release = await prisma.appRelease.findUnique({
        where: { id: releaseId },
    });
    if (!release || release.applicationId !== applicationId) {
        throw httpError(404, 'Release not found');
    }
    return release;
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
    try {
        const search = (req.query.search || '').toString().trim().toLowerCase();
        // `?phase=TEST|PILOT|APPROVED` now filters by RELEASE phase: an
        // app shows up if any of its releases is in the requested phase.
        const phase = (req.query.phase || '').toString().toUpperCase();
        const where = {};
        if (PHASES.includes(phase)) {
            where.releases = { some: { phase } };
        }
        if (search) {
            // `mode: 'insensitive'` keeps the search case-blind on
            // Postgres without forcing the client to normalise.
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
                {
                    releases: {
                        some: {
                            OR: [
                                { version: { contains: search, mode: 'insensitive' } },
                                { targetOs: { has: search } },
                                { posTerminalType: { has: search } },
                            ],
                        },
                    },
                },
            ];
        }

        const applications = await prisma.application.findMany({
            where,
            orderBy: [{ name: 'asc' }],
            select: applicationListSelect,
        });
        res.json({ applications });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Cross-application timeline.
//
// Flattens every release phase transition (TEST / PILOT / APPROVED) plus
// every operator-authored ReleaseCheckpoint across the whole catalogue
// into a single event stream, newest first.
//
// Lives at /api/applications/timeline. MUST be defined before the
// `/:id` route otherwise Express grabs "timeline" as an application id.
//
// Query params (all optional):
//   appIds  csv of application ids to include (defaults to "every app")
//   phases  csv subset of TEST,PILOT,APPROVED (defaults to all)
//   kinds   csv subset of phase,PROD_DEPLOY,PROD_ROLLBACK,PILOT_DEPLOY,
//           TEST_DEPLOY,NOTE (defaults to all)
//   since   ISO date — drop events older than this
//   until   ISO date — drop events newer than this
//   limit   1..2000 (defaults to 500)
//
// Read-open to every authenticated user (same scope as the rest of the
// catalogue).
// ---------------------------------------------------------------------------
const TIMELINE_PHASES = new Set(['TEST', 'PILOT', 'APPROVED']);
const TIMELINE_CHECKPOINT_KINDS = new Set([
    'PROD_DEPLOY',
    'PROD_ROLLBACK',
    'PILOT_DEPLOY',
    'TEST_DEPLOY',
    'NOTE',
]);

function parseCsv(value) {
    if (!value) return [];
    return value
        .toString()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

router.get('/timeline', async (req, res, next) => {
    try {
        const appIdsRaw = parseCsv(req.query.appIds);
        const phasesRaw = parseCsv(req.query.phases)
            .map((s) => s.toUpperCase())
            .filter((p) => TIMELINE_PHASES.has(p));
        const kindsRaw = parseCsv(req.query.kinds).map((s) => {
            const v = s.toUpperCase();
            if (v === 'PHASE') return 'phase';
            return v;
        });
        // Default: include phase events AND every checkpoint kind.
        const includePhase =
            kindsRaw.length === 0 || kindsRaw.includes('phase');
        const wantedCheckpointKinds = new Set(
            kindsRaw.filter((k) => TIMELINE_CHECKPOINT_KINDS.has(k)),
        );
        const includeAnyCheckpoint =
            kindsRaw.length === 0 || wantedCheckpointKinds.size > 0;

        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || 500, 1),
            2000,
        );

        const since = req.query.since ? new Date(req.query.since) : null;
        const until = req.query.until ? new Date(req.query.until) : null;
        const sinceTs =
            since && !Number.isNaN(since.getTime()) ? since.getTime() : null;
        const untilTs =
            until && !Number.isNaN(until.getTime()) ? until.getTime() : null;

        const releaseWhere = {};
        if (appIdsRaw.length > 0) {
            releaseWhere.applicationId = { in: appIdsRaw };
        }

        // Pulling every release in one query and flattening in JS keeps
        // the SQL simple — releases × checkpoints is small in practice
        // (<10k events even for years of history), so we trade a bit of
        // memory for cleaner code.
        const releases = await prisma.appRelease.findMany({
            where: releaseWhere,
            select: {
                id: true,
                applicationId: true,
                version: true,
                phase: true,
                testAt: true,
                pilotAt: true,
                approvedAt: true,
                fileName: true,
                fileUrl: true,
                fixes: true,
                importantNotes: true,
                application: {
                    select: { id: true, name: true, logoUrl: true },
                },
                checkpoints: includeAnyCheckpoint
                    ? {
                          where:
                              wantedCheckpointKinds.size > 0
                                  ? {
                                        kind: {
                                            in: Array.from(
                                                wantedCheckpointKinds,
                                            ),
                                        },
                                    }
                                  : undefined,
                          select: {
                              id: true,
                              kind: true,
                              occurredAt: true,
                              environment: true,
                              note: true,
                              author: {
                                  select: {
                                      id: true,
                                      name: true,
                                      email: true,
                                      avatarUrl: true,
                                  },
                              },
                          },
                      }
                    : false,
            },
        });

        const events = [];
        const wantsPhase = (p) =>
            phasesRaw.length === 0 || phasesRaw.includes(p);

        for (const r of releases) {
            const releaseSummary = {
                id: r.id,
                version: r.version,
                phase: r.phase,
                fileName: r.fileName || null,
                hasFile: Boolean(r.fileUrl),
                fixesPreview:
                    typeof r.fixes === 'string' && r.fixes.length > 0
                        ? r.fixes.slice(0, 200)
                        : null,
                importantNotesPreview:
                    typeof r.importantNotes === 'string' &&
                    r.importantNotes.length > 0
                        ? r.importantNotes.slice(0, 200)
                        : null,
            };

            if (includePhase) {
                const phaseStamps = [
                    ['TEST', r.testAt],
                    ['PILOT', r.pilotAt],
                    ['APPROVED', r.approvedAt],
                ];
                for (const [p, at] of phaseStamps) {
                    if (!at) continue;
                    if (!wantsPhase(p)) continue;
                    events.push({
                        id: `phase:${r.id}:${p}`,
                        kind: 'phase',
                        phase: p,
                        at,
                        applicationId: r.applicationId,
                        application: r.application,
                        release: releaseSummary,
                    });
                }
            }

            if (includeAnyCheckpoint && Array.isArray(r.checkpoints)) {
                for (const cp of r.checkpoints) {
                    events.push({
                        id: `cp:${cp.id}`,
                        kind: 'checkpoint',
                        checkpointKind: cp.kind,
                        at: cp.occurredAt,
                        applicationId: r.applicationId,
                        application: r.application,
                        release: releaseSummary,
                        checkpoint: {
                            id: cp.id,
                            kind: cp.kind,
                            environment: cp.environment || null,
                            note: cp.note || null,
                            author: cp.author || null,
                        },
                    });
                }
            }
        }

        // Drop events outside the [since, until] window before sorting
        // / trimming so the limit reflects what the user actually sees.
        const filtered = events.filter((e) => {
            const t = new Date(e.at).getTime();
            if (sinceTs !== null && t < sinceTs) return false;
            if (untilTs !== null && t > untilTs) return false;
            return true;
        });

        filtered.sort(
            (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
        );

        const totalBeforeLimit = filtered.length;
        const sliced = filtered.slice(0, limit);

        res.json({
            events: sliced,
            total: totalBeforeLimit,
            truncated: totalBeforeLimit > sliced.length,
        });
    } catch (err) {
        next(err);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const app = await prisma.application.findUnique({
            where: { id: req.params.id },
            include: {
                createdBy: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        avatarUrl: true,
                    },
                },
                releases: {
                    // Newest at the top, full stop. Sorting by
                    // `releaseDate` first looks tempting but Postgres
                    // defaults `ORDER BY x DESC` to NULLS FIRST — so a
                    // release with no manually-typed releaseDate would
                    // jump above newer releases that DO have one. Using
                    // `createdAt` keeps the timeline intuitive: the
                    // release you just added always lands at position 1.
                    orderBy: [{ createdAt: 'desc' }],
                    include: releaseWithNotesInclude,
                },
            },
        });
        if (!app) return next(httpError(404, 'Application not found'));
        // Sign every release artifact for the caller — same scheme as
        // project files, time-limited download links.
        app.releases = (app.releases || []).map((r) =>
            signReleaseFile(r, req.user.id),
        );
        res.json({ application: app });
    } catch (err) {
        next(err);
    }
});

router.post('/', async (req, res, next) => {
    try {
        requireCapability(req, CAPABILITIES.APP_CREATE);
        const data = applicationCreateSchema.parse(req.body);
        const created = await prisma.application.create({
            data: { ...data, createdById: req.user.id },
            select: applicationListSelect,
        });
        await logAppActivity('APP_CREATED', req, {
            appId: created.id,
            appName: created.name,
        });
        res.status(201).json({ application: created });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        requireCapability(req, CAPABILITIES.APP_EDIT);
        await loadApplicationOr404(req.params.id);
        const data = applicationUpdateSchema.parse(req.body);
        const updated = await prisma.application.update({
            where: { id: req.params.id },
            data,
            select: applicationListSelect,
        });
        await logAppActivity('APP_UPDATED', req, {
            appId: updated.id,
            appName: updated.name,
            // Names of the fields that were edited — handy for the
            // feed text without dumping the entire payload.
            fields: Object.keys(data),
        });
        res.json({ application: updated });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        requireCapability(req, CAPABILITIES.APP_DELETE);
        const app = await loadApplicationOr404(req.params.id);
        // Cascade-delete handles releases + notes; we still need to
        // sweep up the disk-resident logo + release artifacts.
        const releases = await prisma.appRelease.findMany({
            where: { applicationId: req.params.id },
            select: { fileUrl: true },
        });
        await prisma.application.delete({ where: { id: req.params.id } });
        if (app.logoUrl) removeFileSafe(app.logoUrl);
        for (const r of releases) {
            if (r.fileUrl) removeFileSafe(r.fileUrl);
        }
        await logAppActivity('APP_DELETED', req, {
            appId: app.id,
            appName: app.name,
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// --- logo ------------------------------------------------------------------

router.post(
    '/:id/logo',
    requireCapabilityMiddleware(CAPABILITIES.APP_EDIT),
    appLogoUpload.single('logo'),
    async (req, res, next) => {
        try {
            if (!req.file) throw httpError(400, 'No file uploaded');
            const app = await prisma.application.findUnique({
                where: { id: req.params.id },
            });
            if (!app) {
                removeFileSafe(appLogoUrl(req.file.filename));
                throw httpError(404, 'Application not found');
            }
            if (app.logoUrl) removeFileSafe(app.logoUrl);
            const updated = await prisma.application.update({
                where: { id: req.params.id },
                data: { logoUrl: appLogoUrl(req.file.filename) },
                select: applicationListSelect,
            });
            res.json({ application: updated });
        } catch (err) {
            next(err);
        }
    },
);

router.delete('/:id/logo', async (req, res, next) => {
    try {
        requireCapability(req, CAPABILITIES.APP_EDIT);
        const app = await loadApplicationOr404(req.params.id);
        if (app.logoUrl) removeFileSafe(app.logoUrl);
        const updated = await prisma.application.update({
            where: { id: req.params.id },
            data: { logoUrl: null },
            select: applicationListSelect,
        });
        res.json({ application: updated });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

router.post(
    '/:id/releases',
    async (req, res, next) => {
        try {
            requireCapability(req, CAPABILITIES.APP_RELEASE_CREATE);
            await loadApplicationOr404(req.params.id);
            const data = releaseCreateSchema.parse(req.body);
            // The starting phase choice (TEST/PILOT/APPROVED) is a
            // separate, more sensitive capability. If the caller doesn't
            // hold APP_PHASE_DECLARE we silently force TEST regardless
            // of what they sent.
            const phase = hasCapability(req, CAPABILITIES.APP_PHASE_DECLARE)
                ? data.phase || 'TEST'
                : 'TEST';
            const transition = phaseTransitionPatch(null, phase);
            const release = await prisma.appRelease.create({
                data: {
                    applicationId: req.params.id,
                    uploadedById: req.user.id,
                    ...data,
                    phase,
                    ...transition,
                },
                select: releaseSelect,
            });
            const app = await prisma.application.findUnique({
                where: { id: req.params.id },
                select: { id: true, name: true },
            });
            await logAppActivity('APP_RELEASE_CREATED', req, {
                appId: app?.id,
                appName: app?.name,
                releaseId: release.id,
                releaseVersion: release.version,
                phase,
            });
            res.status(201).json({
                release: signReleaseFile(release, req.user.id),
            });
        } catch (err) {
            next(err);
        }
    },
);

router.patch(
    '/:id/releases/:releaseId',
    async (req, res, next) => {
        try {
            requireCapability(req, CAPABILITIES.APP_RELEASE_EDIT);
            const existing = await loadReleaseOr404(
                req.params.id,
                req.params.releaseId,
            );
            const data = releaseUpdateSchema.parse(req.body);
            // Phase declarations are gated by their own capability —
            // strip the field if the caller can't change it so the
            // rest of the patch still goes through.
            if (
                data.phase !== undefined &&
                !hasCapability(req, CAPABILITIES.APP_PHASE_DECLARE)
            ) {
                delete data.phase;
            }
            // If the caller is changing the phase, fold in the
            // appropriate `*At` stamp (only when not previously set).
            const phaseChanging = data.phase && data.phase !== existing.phase;
            const transition = phaseChanging
                ? phaseTransitionPatch(existing, data.phase)
                : {};
            const release = await prisma.appRelease.update({
                where: { id: req.params.releaseId },
                data: { ...data, ...transition },
                select: releaseSelect,
            });
            const app = await prisma.application.findUnique({
                where: { id: req.params.id },
                select: { id: true, name: true },
            });
            // Two separate audit events: phase declarations are
            // operationally significant (production cutover) and we
            // want them to read distinctly in the feed.
            if (phaseChanging) {
                await logAppActivity('APP_RELEASE_PHASE_DECLARED', req, {
                    appId: app?.id,
                    appName: app?.name,
                    releaseId: release.id,
                    releaseVersion: release.version,
                    fromPhase: existing.phase,
                    toPhase: data.phase,
                });
            }
            await logAppActivity('APP_RELEASE_UPDATED', req, {
                appId: app?.id,
                appName: app?.name,
                releaseId: release.id,
                releaseVersion: release.version,
                fields: Object.keys(data),
            });
            res.json({ release: signReleaseFile(release, req.user.id) });
        } catch (err) {
            next(err);
        }
    },
);

router.delete(
    '/:id/releases/:releaseId',
    async (req, res, next) => {
        try {
            requireCapability(req, CAPABILITIES.APP_RELEASE_DELETE);
            const release = await loadReleaseOr404(
                req.params.id,
                req.params.releaseId,
            );
            await prisma.appRelease.delete({
                where: { id: req.params.releaseId },
            });
            if (release.fileUrl) removeFileSafe(release.fileUrl);
            const app = await prisma.application.findUnique({
                where: { id: req.params.id },
                select: { id: true, name: true },
            });
            await logAppActivity('APP_RELEASE_DELETED', req, {
                appId: app?.id,
                appName: app?.name,
                releaseId: release.id,
                releaseVersion: release.version,
            });
            res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    },
);

router.post(
    '/:id/releases/:releaseId/file',
    requireCapabilityMiddleware(CAPABILITIES.APP_RELEASE_EDIT),
    fileUpload.single('file'),
    async (req, res, next) => {
        try {
            if (!req.file) throw httpError(400, 'No file uploaded');
            const release = await loadReleaseOr404(
                req.params.id,
                req.params.releaseId,
            ).catch((e) => {
                removeFileSafe(fileUrl(req.file.filename));
                throw e;
            });
            if (release.fileUrl) removeFileSafe(release.fileUrl);
            const updated = await prisma.appRelease.update({
                where: { id: req.params.releaseId },
                data: {
                    fileUrl: fileUrl(req.file.filename),
                    fileName: req.file.originalname,
                    fileSize: req.file.size,
                    fileMimeType: req.file.mimetype,
                    uploadedById: req.user.id,
                },
                select: releaseSelect,
            });
            res.json({
                release: signReleaseFile(updated, req.user.id),
            });
        } catch (err) {
            next(err);
        }
    },
);

router.delete(
    '/:id/releases/:releaseId/file',
    async (req, res, next) => {
        try {
            requireCapability(req, CAPABILITIES.APP_RELEASE_EDIT);
            const release = await loadReleaseOr404(
                req.params.id,
                req.params.releaseId,
            );
            if (release.fileUrl) removeFileSafe(release.fileUrl);
            const updated = await prisma.appRelease.update({
                where: { id: req.params.releaseId },
                data: {
                    fileUrl: null,
                    fileName: null,
                    fileSize: null,
                    fileMimeType: null,
                },
                select: releaseSelect,
            });
            res.json({
                release: signReleaseFile(updated, req.user.id),
            });
        } catch (err) {
            next(err);
        }
    },
);

// ---------------------------------------------------------------------------
// Release notes
// ---------------------------------------------------------------------------

router.post(
    '/:id/releases/:releaseId/notes',
    async (req, res, next) => {
        try {
            requireCapability(req, CAPABILITIES.APP_COMMENT);
            await loadReleaseOr404(req.params.id, req.params.releaseId);
            const { content } = noteCreateSchema.parse(req.body);
            const note = await prisma.appReleaseNote.create({
                data: {
                    releaseId: req.params.releaseId,
                    authorId: req.user.id,
                    content,
                },
                include: {
                    author: {
                        select: {
                            id: true,
                            name: true,
                            email: true,
                            avatarUrl: true,
                        },
                    },
                },
            });
            res.status(201).json({ note });
        } catch (err) {
            next(err);
        }
    },
);

router.patch(
    '/:id/releases/:releaseId/notes/:noteId',
    async (req, res, next) => {
        try {
            const note = await prisma.appReleaseNote.findUnique({
                where: { id: req.params.noteId },
            });
            if (!note || note.releaseId !== req.params.releaseId) {
                return next(httpError(404, 'Note not found'));
            }
            if (!isAdmin(req) && note.authorId !== req.user.id) {
                return next(httpError(403, 'Not your note'));
            }
            const { content } = noteUpdateSchema.parse(req.body);
            const updated = await prisma.appReleaseNote.update({
                where: { id: note.id },
                data: { content },
                include: {
                    author: {
                        select: {
                            id: true,
                            name: true,
                            email: true,
                            avatarUrl: true,
                        },
                    },
                },
            });
            res.json({ note: updated });
        } catch (err) {
            next(err);
        }
    },
);

router.delete(
    '/:id/releases/:releaseId/notes/:noteId',
    async (req, res, next) => {
        try {
            const note = await prisma.appReleaseNote.findUnique({
                where: { id: req.params.noteId },
            });
            if (!note || note.releaseId !== req.params.releaseId) {
                return next(httpError(404, 'Note not found'));
            }
            if (!isAdmin(req) && note.authorId !== req.user.id) {
                return next(httpError(403, 'Not your note'));
            }
            await prisma.appReleaseNote.delete({ where: { id: note.id } });
            res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    },
);

// ---------------------------------------------------------------------------
// Release checkpoints — operator-authored timeline entries (e.g. "deployed
// v1.2.3 to prod cluster A at 02:13"). Anyone with the
// `app:checkpoint:add` capability can stamp one. Useful for rollback
// post-mortems where the official "phase changed to APPROVED" timestamp
// isn't granular enough.
// ---------------------------------------------------------------------------

const checkpointInclude = {
    author: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
};

router.get(
    '/:id/releases/:releaseId/checkpoints',
    async (req, res, next) => {
        try {
            await loadReleaseOr404(req.params.id, req.params.releaseId);
            const checkpoints = await prisma.releaseCheckpoint.findMany({
                where: { releaseId: req.params.releaseId },
                orderBy: { occurredAt: 'desc' },
                include: checkpointInclude,
            });
            res.json({ checkpoints });
        } catch (err) {
            next(err);
        }
    },
);

router.post(
    '/:id/releases/:releaseId/checkpoints',
    async (req, res, next) => {
        try {
            requireCapability(req, CAPABILITIES.APP_CHECKPOINT_ADD);
            await loadReleaseOr404(req.params.id, req.params.releaseId);
            const data = checkpointCreateSchema.parse(req.body);
            const checkpoint = await prisma.releaseCheckpoint.create({
                data: {
                    releaseId: req.params.releaseId,
                    authorId: req.user.id,
                    kind: data.kind || 'PROD_DEPLOY',
                    occurredAt: data.occurredAt || new Date(),
                    environment: data.environment ?? null,
                    note: data.note ?? null,
                },
                include: checkpointInclude,
            });
            const app = await prisma.application.findUnique({
                where: { id: req.params.id },
                select: {
                    id: true,
                    name: true,
                    releases: {
                        where: { id: req.params.releaseId },
                        select: { version: true },
                    },
                },
            });
            await logAppActivity('APP_CHECKPOINT_ADDED', req, {
                appId: app?.id,
                appName: app?.name,
                releaseId: req.params.releaseId,
                releaseVersion: app?.releases?.[0]?.version,
                checkpointId: checkpoint.id,
                kind: checkpoint.kind,
                environment: checkpoint.environment,
            });
            res.status(201).json({ checkpoint });
        } catch (err) {
            next(err);
        }
    },
);

router.patch(
    '/:id/releases/:releaseId/checkpoints/:checkpointId',
    async (req, res, next) => {
        try {
            const cp = await prisma.releaseCheckpoint.findUnique({
                where: { id: req.params.checkpointId },
            });
            if (!cp || cp.releaseId !== req.params.releaseId) {
                return next(httpError(404, 'Checkpoint not found'));
            }
            // Author can edit their own checkpoint as long as they
            // still hold the add capability; admins can edit any.
            const isAuthor = cp.authorId === req.user.id;
            if (!isAdmin(req)) {
                if (!isAuthor) {
                    return next(httpError(403, 'Not your checkpoint'));
                }
                requireCapability(req, CAPABILITIES.APP_CHECKPOINT_ADD);
            }
            const data = checkpointUpdateSchema.parse(req.body);
            const updated = await prisma.releaseCheckpoint.update({
                where: { id: cp.id },
                data: {
                    ...(data.kind !== undefined ? { kind: data.kind } : {}),
                    ...(data.occurredAt !== undefined
                        ? { occurredAt: data.occurredAt }
                        : {}),
                    ...(data.environment !== undefined
                        ? { environment: data.environment }
                        : {}),
                    ...(data.note !== undefined ? { note: data.note } : {}),
                },
                include: checkpointInclude,
            });
            res.json({ checkpoint: updated });
        } catch (err) {
            next(err);
        }
    },
);

router.delete(
    '/:id/releases/:releaseId/checkpoints/:checkpointId',
    async (req, res, next) => {
        try {
            const cp = await prisma.releaseCheckpoint.findUnique({
                where: { id: req.params.checkpointId },
            });
            if (!cp || cp.releaseId !== req.params.releaseId) {
                return next(httpError(404, 'Checkpoint not found'));
            }
            const isAuthor = cp.authorId === req.user.id;
            // Anyone with the explicit delete capability can remove
            // a checkpoint; otherwise only the author (if they still
            // hold add) or an admin can.
            if (!isAdmin(req)) {
                if (hasCapability(req, CAPABILITIES.APP_CHECKPOINT_DELETE)) {
                    // ok
                } else if (
                    isAuthor &&
                    hasCapability(req, CAPABILITIES.APP_CHECKPOINT_ADD)
                ) {
                    // ok
                } else {
                    return next(
                        httpError(
                            403,
                            'You cannot delete this checkpoint',
                        ),
                    );
                }
            }
            await prisma.releaseCheckpoint.delete({ where: { id: cp.id } });
            const app = await prisma.application.findUnique({
                where: { id: req.params.id },
                select: {
                    id: true,
                    name: true,
                    releases: {
                        where: { id: req.params.releaseId },
                        select: { version: true },
                    },
                },
            });
            await logAppActivity('APP_CHECKPOINT_DELETED', req, {
                appId: app?.id,
                appName: app?.name,
                releaseId: req.params.releaseId,
                releaseVersion: app?.releases?.[0]?.version,
                checkpointId: cp.id,
                kind: cp.kind,
            });
            res.json({ ok: true });
        } catch (err) {
            next(err);
        }
    },
);

module.exports = router;
