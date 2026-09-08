require('dotenv').config();

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');

// Per-request key for the global /api limiter. We prefer the
// authenticated user id (from the Bearer JWT's `sub` claim) so each
// signed-in user gets their own budget — without this the limiter
// keyed everything by IP, so an entire office behind a single NAT
// shared a single bucket and one chatty tab could throttle everyone
// else with the "Too many requests" error. We deliberately do NOT
// verify the token here; that's still done by `requireAuth` on the
// way into the route. `jwt.decode` just peeks at the payload to pull
// out a stable, non-spoofable identifier for the limiter. A request
// that arrives without a token (login, register, refresh, any
// public health probe) keeps falling back to IP, which is exactly
// the right behaviour for the small auth-specific limiters below.
function apiLimiterKey(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
        try {
            const decoded = jwt.decode(auth.slice(7));
            if (decoded && decoded.sub) return `u:${decoded.sub}`;
        } catch {
            // Malformed token — quietly fall through to IP keying.
            // The eventual requireAuth() will reject the request
            // with 401, so we don't need to do anything here.
        }
    }
    return `ip:${req.ip}`;
}

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const taskRoutes = require('./routes/tasks');
const userRoutes = require('./routes/users');
const noteRoutes = require('./routes/notes');
const fileRoutes = require('./routes/files');
const phaseRoutes = require('./routes/phases');
const participantRoutes = require('./routes/participants');
const conversationRoutes = require('./routes/conversations');
const notificationRoutes = require('./routes/notifications');
const todoRoutes = require('./routes/todos');
const insightRoutes = require('./routes/insights');
const activityRoutes = require('./routes/activities');
const projectActivityRoutes = require('./routes/projectActivities');
const exportRoutes = require('./routes/exports');
const templateRoutes = require('./routes/templates');
const searchRoutes = require('./routes/search');
const billingRoutes = require('./routes/billing');
const reassignmentRoutes = require('./routes/reassignments');
const teamRoutes = require('./routes/teams');
const projectContactRoutes = require('./routes/projectContacts');
const timeRoutes = require('./routes/time');
const applicationRoutes = require('./routes/applications');
const sprintRoutes = require('./routes/sprints');
const planningSprintRoutes = require('./routes/planningSprints');
const pinRoutes = require('./routes/pins');
const releaseNotesRoutes = require('./routes/releaseNotes');
const pushRoutes = require('./routes/push');
const projectGroupRoutes = require('./routes/projectGroups');
const changeRequestRoutes = require('./routes/changeRequests');
const clientRoutes = require('./routes/clients');
const ticketRoutes = require('./routes/tickets');
const ticketRequestTypeRoutes = require('./routes/ticketRequestTypes');
const requesterGroupRoutes = require('./routes/requesterGroups');
const terminalRoutes = require('./routes/terminals');
const ticketFieldRoutes = require('./routes/ticketFields');
const announcementRoutes = require('./routes/announcements');
const { notFound, errorHandler } = require('./middleware/error');
const errorReporter = require('./lib/errorReporter');

// Install process-level error sinks BEFORE anything else (route
// require()'s, prisma client load, scheduler boot). If any of those
// throws asynchronously we still want the error captured. When
// ERROR_REPORTER_DSN is unset this is a structured-logging upgrade;
// when it's set it ships to Sentry / GlitchTip / whichever sink the
// `boot()` function in lib/errorReporter.js wires up.
errorReporter.installProcessHandlers();
const {
    UPLOAD_ROOT,
    verifyFileSignatureMiddleware,
} = require('./lib/upload');
const {
    ensureAdmin,
    backfillProjectParticipants,
    ensureDefaultTemplates,
    backfillEntityCodes,
    backfillTaskCreators,
    backfillPhaseColorsFromTemplates,
} = require('./lib/bootstrap');
const realtime = require('./lib/realtime');
const { startAttachmentSweeper } = require('./lib/messageAttachments');
const { startDeadlineSweepScheduler } = require('./lib/deadlineAlerts');
const { startSprintSnapshotScheduler } = require('./lib/sprintSnapshots');
const { startSprintScheduleRunner } = require('./lib/sprintScheduler');
const {
    startPlanningScheduleRunner,
} = require('./lib/planningSprintScheduler');
const {
    startPlanningSprintSnapshotScheduler,
} = require('./lib/planningSprintSnapshots');

const app = express();
const PORT = Number(process.env.PORT || 5000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

// We sit behind a reverse proxy (nginx / Cloudfront / docker network)
// in production, so trust the first proxy hop for `req.ip`. Without
// this, express-rate-limit treats every request as coming from the
// proxy address and either locks everyone out or doesn't throttle at
// all. Using `1` (one hop) avoids the looser `true` setting that the
// rate-limit project warns against.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Standard security headers (HSTS only sets in production via the
// proxy; we still send X-Frame-Options, X-Content-Type-Options,
// Referrer-Policy, COOP/COEP, etc. across all environments).
// CSP is left disabled here because the API does not serve HTML — the
// frontend dev server / production CDN owns its own CSP.
app.use(
    helmet({
        contentSecurityPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        crossOriginEmbedderPolicy: false,
    }),
);

app.use(
    cors({
        origin: CORS_ORIGIN,
        credentials: true,
    }),
);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Decide on the right Content-Disposition for project file attachments.
// We want safe formats (PDF, images, plain text) to render INLINE so the
// in-app preview works, but we still force-download anything that could
// execute or be re-interpreted as code in the browser (HTML, SVG, JS,
// XML, CSS, Flash) to neutralise stored XSS / drive-by attacks.
//
// The frontend can also pass `?download=1` to force an attachment
// disposition for the explicit "Download" button regardless of type.
const ALWAYS_ATTACH_EXTS = new Set([
    '.html',
    '.htm',
    '.xhtml',
    '.svg',
    '.xml',
    '.js',
    '.mjs',
    '.css',
    '.swf',
]);
// Defense-in-depth: only files we explicitly expose may be served.
// Anything dropped into the uploads volume that isn't under
// /uploads/files/ or /uploads/avatars/ (e.g. log files, backups, ad-hoc
// dumps) returns 404 even though the static handler below would
// otherwise serve it.
app.use('/uploads', (req, res, next) => {
    const p = req.path || '';
    if (
        p.startsWith('/files/') ||
        p.startsWith('/avatars/') ||
        p.startsWith('/app-logos/') ||
        p.startsWith('/announcement-images/')
    ) {
        return next();
    }
    return res.status(404).end();
});

// Project file downloads must carry a valid HMAC signature issued by
// the API to the requesting user. This is what gates /uploads/files/*
// behind the same access checks the JSON API enforces — without a
// fresh signature any leaked URL is dead within ~10 minutes (and only
// works for the user it was issued to even before that).
app.use('/uploads/files', verifyFileSignatureMiddleware);

app.use('/uploads/files', (req, res, next) => {
    const filename = path.basename(req.path);
    if (filename) {
        const ext = path.extname(filename).toLowerCase();
        const forceDownload =
            req.query.download === '1' || ALWAYS_ATTACH_EXTS.has(ext);
        const disposition = forceDownload ? 'attachment' : 'inline';
        // Prefer the ORIGINAL filename (passed as `?n=` by signFileUrl) so
        // the browser saves the file under the name the uploader chose,
        // not the random on-disk name. Fall back to the stored name.
        const rawName =
            typeof req.query.n === 'string' && req.query.n
                ? req.query.n
                : filename;
        // Strip anything that could break the header, then build BOTH a
        // plain ASCII `filename=` (for legacy clients) and an RFC 5987
        // `filename*=UTF-8''…` (so non-ASCII names like "Résumé.pdf"
        // survive). Modern browsers use the latter.
        const safeName = rawName
            .replace(/[\\/\r\n"]/g, '_')
            .slice(0, 255);
        const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_') || 'download';
        res.setHeader(
            'Content-Disposition',
            `${disposition}; filename="${asciiName}"; ` +
                `filename*=UTF-8''${encodeURIComponent(safeName)}`,
        );
    }
    // Always set nosniff so a browser can't be tricked into reinterpreting
    // a JSON file as HTML, etc.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
});

app.use(
    '/uploads',
    express.static(UPLOAD_ROOT, {
        maxAge: '1d',
        fallthrough: false,
    }),
);

app.get('/', (req, res) => {
    res.json({
        name: 'PM Tool API',
        status: 'ok',
        time: new Date().toISOString(),
    });
});

// LIVENESS probe — does the process serve HTTP at all?
//
// Returns 200 unconditionally. This is the right answer for a
// docker / kubernetes "should I kill this container?" check: the
// answer is "no, kill it only if the process has crashed". A DB
// outage is a transient ops problem, not a reason to restart the
// container — restarting won't bring Postgres back.
//
// If you want "is the service ready to serve a real request?", use
// /api/ready instead (below). The two probes intentionally do
// different things even though it's tempting to make them the same.
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// READINESS probe — can this instance actually do work right now?
//
// Pings the database with `SELECT 1` and only reports OK if Postgres
// replies. If the DB is down we return 503 with a JSON body so the
// proxy / load balancer can route around the bad instance while the
// container itself stays alive (the docker-compose healthcheck below
// also points here so the orchestrator marks the service unhealthy
// and other containers depending on it can wait).
//
// We cap the DB call at 1500 ms so a slow Postgres doesn't make
// readiness checks pile up on the event loop. The promise race uses
// AbortController-free timing because $queryRaw doesn't accept a
// signal — manually rejecting after the timeout is the cleanest
// portable shape.
const prismaForReady = require('./lib/prisma');
app.get('/api/ready', async (req, res) => {
    const timeoutMs = 1500;
    let timer;
    try {
        await Promise.race([
            prismaForReady.$queryRaw`SELECT 1`,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`db ping exceeded ${timeoutMs}ms`)),
                    timeoutMs,
                );
            }),
        ]);
        res.json({
            status: 'ready',
            db: 'ok',
            uptimeSeconds: Math.round(process.uptime()),
        });
    } catch (err) {
        // 503 = not currently able to handle requests, but the
        // service itself is still alive.
        res.status(503).json({
            status: 'not_ready',
            db: 'down',
            error: err.message,
        });
    } finally {
        if (timer) clearTimeout(timer);
    }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again later.' },
});

// Dedicated, much more permissive limiter for /api/auth/refresh.
//
// The credentialed routes above (login / register / forgot / reset /
// change) need a tight bucket because each attempt is an authn check
// against bcrypt. /refresh is a different beast: every page load and
// every access-token expiry (every 15 min, per tab) calls it, so a
// legitimate user generates a steady trickle and an office full of
// users behind a single NAT can comfortably produce a burst.
//
// We still cap it so a buggy client or a brute-force tool can't pin
// the event loop. 600 req/min/IP = 10/s sustained — comfortably
// covers ~100 users behind one office NAT with multiple tabs /
// background reloads, but still flags scripted abuse.
//
// NOTE: this is an in-memory limiter (express-rate-limit default
// store), so it resets on restart and does NOT cross instances. Move
// it to the Redis store the moment we add a second backend container.
const refreshLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many refresh attempts. Please wait a moment.' },
});

// Coarse anti-flood limiter on every /api endpoint. Keeps any single
// caller from hammering expensive routes like /api/exports,
// /api/insights or /api/search.
//
// `keyGenerator: apiLimiterKey` (defined at the top of this file)
// switches the bucket from IP-based to user-based for authenticated
// requests — so an office of users behind one NAT no longer shares a
// single quota. 1200 req/min ≈ 20 req/sec sustained per authenticated
// user, which comfortably absorbs the chattiest interactive sessions
// (opening a long project page can fire dozens of parallel requests
// for participants, files, notes, time, etc.; the multi-tab "live
// updates" pattern can pile on more) without 429'ing real usage.
// Scripted abuse still trips the cap quickly. The dedicated auth
// limiters (login / register / refresh) apply on top, and stay
// IP-keyed because the calling user is by definition unknown at
// that point.
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1200,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: apiLimiterKey,
    message: { error: 'Too many requests. Please slow down.' },
});

app.use('/api', apiLimiter);

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth/change-password', authLimiter);
app.use('/api/auth/refresh', refreshLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/projects/:projectId/participants', participantRoutes);
// Change requests — two mount points:
//   project-scoped (list + create under /api/projects/:projectId/change-requests)
//   flat          (get/update/delete under /api/change-requests/:id)
// Both share gates + schemas (see backend/src/routes/changeRequests.js).
app.use(
    '/api/projects/:projectId/change-requests',
    changeRequestRoutes.projectScoped,
);
app.use('/api/change-requests', changeRequestRoutes.flat);
app.use('/api/tasks', taskRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/phases', phaseRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/todos', todoRoutes);
app.use('/api/insights', insightRoutes);
app.use('/api/activities', activityRoutes);
app.use('/api/plan-activities', projectActivityRoutes);
app.use('/api/exports', exportRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/reassignments', reassignmentRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/project-contacts', projectContactRoutes);
app.use('/api/time', timeRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/sprints', sprintRoutes);
app.use('/api/planning-sprints', planningSprintRoutes);
app.use('/api/pins', pinRoutes);
app.use('/api/release-notes', releaseNotesRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/project-groups', projectGroupRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/ticket-request-types', ticketRequestTypeRoutes);
app.use('/api/requester-groups', requesterGroupRoutes);
app.use('/api/terminals', terminalRoutes);
app.use('/api/ticket-fields', ticketFieldRoutes);
app.use('/api/announcements', announcementRoutes);

app.use(notFound);
// Report 5xx errors to the reporter BEFORE the JSON-shape error
// handler runs. The reporter's middleware always calls next(err) so
// the existing handler still owns the actual response body. With no
// DSN configured the reporter is a structured-logging upgrade; with
// a DSN it ships to Sentry / GlitchTip.
app.use(errorReporter.expressMiddleware());
app.use(errorHandler);

async function start() {
    try {
        await ensureAdmin();
    } catch (err) {
        console.error('[bootstrap] ensureAdmin failed:', err);
    }
    try {
        await backfillProjectParticipants();
    } catch (err) {
        console.error('[bootstrap] backfillProjectParticipants failed:', err);
    }
    try {
        await ensureDefaultTemplates();
    } catch (err) {
        console.error('[bootstrap] ensureDefaultTemplates failed:', err);
    }
    try {
        await backfillEntityCodes();
    } catch (err) {
        // Non-fatal: rows just stay codeless until the next boot or
        // until they're individually stamped by a future create.
        console.error('[bootstrap] backfillEntityCodes failed:', err);
    }
    try {
        await backfillTaskCreators();
    } catch (err) {
        // Non-fatal: the "by <name>" chip on those rows will just
        // keep reading "by unknown" until the next boot resolves it.
        console.error('[bootstrap] backfillTaskCreators failed:', err);
    }
    try {
        await backfillPhaseColorsFromTemplates();
    } catch (err) {
        console.error('[bootstrap] backfillPhaseColorsFromTemplates failed:', err);
    }

    const server = http.createServer(app);
    realtime.init(server, { corsOrigin: CORS_ORIGIN });

    // Chat message attachments are short-lived (30 days). The sweeper
    // runs in the background and quietly garbage-collects expired
    // rows + their files; failures are logged and never fatal.
    try {
        startAttachmentSweeper();
    } catch (err) {
        console.error('[bootstrap] startAttachmentSweeper failed:', err);
    }

    // Daily "task deadline approaching" sweep. Runs ~30s after boot
    // to catch anything that crossed a threshold while the server was
    // down, then every 24h after that. Idempotent — see
    // lib/deadlineAlerts.js for how it dedupes per (task × user ×
    // window).
    try {
        startDeadlineSweepScheduler();
    } catch (err) {
        console.error('[bootstrap] startDeadlineSweepScheduler failed:', err);
    }

    // Daily burndown snapshot for every ACTIVE sprint. Same shape as
    // the deadline sweep — one warm-up shot after boot, then once
    // every 24h. See lib/sprintSnapshots.js for the wrapper and
    // routes/sprints.js for the per-sprint snapshot logic.
    try {
        startSprintSnapshotScheduler();
    } catch (err) {
        console.error('[bootstrap] startSprintSnapshotScheduler failed:', err);
    }

    // Per-project sprint generator (weekly / biweekly / monthly).
    // Runs ~90s after boot and then hourly, materialising as many
    // PLANNED sprints as each project's lookahead requires. See
    // lib/sprintScheduler.js for the cadence math + naming pattern
    // engine.
    try {
        startSprintScheduleRunner();
    } catch (err) {
        console.error('[bootstrap] startSprintScheduleRunner failed:', err);
    }

    // Per-team planning-sprint generator (DAILY / weekly / biweekly /
    // monthly). Mirrors the project scheduler but for the cross-project
    // PlanningSprint timeline. See lib/planningSprintScheduler.js.
    try {
        startPlanningScheduleRunner();
    } catch (err) {
        console.error(
            '[bootstrap] startPlanningScheduleRunner failed:',
            err,
        );
    }

    // Daily burndown snapshots for ACTIVE planning sprints (mirrors the
    // project sprint snapshot scheduler). See lib/planningSprintSnapshots.js.
    try {
        startPlanningSprintSnapshotScheduler();
    } catch (err) {
        console.error(
            '[bootstrap] startPlanningSprintSnapshotScheduler failed:',
            err,
        );
    }

    server.listen(PORT, () => {
        console.log(`Backend running on port ${PORT} (HTTP + WebSocket)`);
    });
}

start();
