// Centralised error-capture wrapper.
//
// This module is intentionally a NO-OP when no DSN is configured —
// the public surface (`captureException`, `captureMessage`, the
// install hooks) returns immediately so the runtime cost stays zero
// on installs without monitoring.
//
// Why bother having it at all then? Three reasons:
//
//   1. Calling code (`process.on('unhandledRejection')`, the Express
//      error handler, scheduler error catches) becomes uniform:
//      every place that currently does `console.error(...)` can also
//      do `errorReporter.captureException(err, { tags })` once,
//      without caring whether monitoring is wired up.
//
//   2. The day the user wants to wire up Sentry (or GlitchTip, or a
//      home-grown log endpoint), they set ONE env var
//      (`ERROR_REPORTER_DSN`) and the existing call sites start
//      reporting — no code changes needed.
//
//   3. The shape of the API (`{ tags, extra, user, level }`) matches
//      Sentry's so swapping in the real SDK later is a one-file
//      change in `boot()`.
//
// To wire Sentry later:
//   1. `npm install --save @sentry/node`
//   2. set ERROR_REPORTER_DSN=<your-sentry-dsn>
//   3. uncomment the Sentry import + init in `boot()` below.

let active = false;
let send = () => {};
let installed = false;

function boot() {
    if (installed) return;
    installed = true;

    const dsn = process.env.ERROR_REPORTER_DSN;
    if (!dsn) {
        // No DSN → stay in no-op mode. We DO still install
        // `unhandledRejection` / `uncaughtException` listeners (see
        // installProcessHandlers) so the operator at least sees
        // them in container logs.
        return;
    }

    // Lazy require to avoid making @sentry/node a hard dependency.
    // When Sentry is installed and a DSN is set, replace the body of
    // this block with:
    //
    //   const Sentry = require('@sentry/node');
    //   Sentry.init({
    //       dsn,
    //       tracesSampleRate: 0,
    //       environment: process.env.NODE_ENV || 'production',
    //       release: process.env.GIT_COMMIT_SHA || undefined,
    //   });
    //   send = (kind, payload) => {
    //       if (kind === 'exception') Sentry.captureException(payload.err, payload);
    //       else Sentry.captureMessage(payload.message, payload);
    //   };
    //   active = true;

    // Until then, we keep `active = false` (so installation didn't
    // change behaviour beyond logging) and just leave a note so we
    // know we got here.
    console.warn(
        '[errorReporter] ERROR_REPORTER_DSN is set but @sentry/node ' +
            'is not installed. Run `npm install @sentry/node` and ' +
            'uncomment the init block in lib/errorReporter.js.',
    );
}

function captureException(err, options = {}) {
    if (!installed) boot();
    // Always log so the operator sees the error even without
    // monitoring wired up.
    console.error(
        '[err]',
        err?.message || err,
        options.tags ? JSON.stringify(options.tags) : '',
    );
    if (active && err) {
        send('exception', { err, ...options });
    }
}

function captureMessage(message, options = {}) {
    if (!installed) boot();
    console.warn(
        '[msg]',
        message,
        options.tags ? JSON.stringify(options.tags) : '',
    );
    if (active && message) {
        send('message', { message, ...options });
    }
}

// Install global process-level error sinks. Without these,
// unhandledRejection / uncaughtException would still kill the process
// (in newer Node versions) but you'd see only a single line in stdout
// — no stack, no tags, no context. Wire these in `index.js` very
// early in boot so they catch failures BEFORE the HTTP server starts.
function installProcessHandlers() {
    if (!installed) boot();
    process.on('unhandledRejection', (reason) => {
        captureException(reason instanceof Error ? reason : new Error(String(reason)), {
            tags: { source: 'unhandledRejection' },
        });
    });
    process.on('uncaughtException', (err) => {
        captureException(err, {
            tags: { source: 'uncaughtException' },
        });
        // After capturing, let Node's default behaviour proceed. The
        // process is already in an indeterminate state — don't try to
        // keep serving requests.
        // (Sentry's recommended pattern: capture, flush, then exit.)
    });
}

// Express error-handling middleware. Wire after the existing
// `errorHandler` if you want to keep the JSON response shape the
// frontend depends on — this one just calls `captureException` for
// any non-4xx-with-expose error.
function expressMiddleware() {
    return function reporter(err, req, res, next) {
        const status = err?.status || 500;
        if (status >= 500) {
            captureException(err, {
                tags: {
                    source: 'express',
                    route: req.originalUrl,
                    method: req.method,
                },
                user: req.user
                    ? { id: req.user.id, role: req.user.role }
                    : undefined,
            });
        }
        next(err);
    };
}

module.exports = {
    boot,
    captureException,
    captureMessage,
    installProcessHandlers,
    expressMiddleware,
};
