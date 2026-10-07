// Lightweight, dependency-free application logger + request logging.
//
// Design goals:
//   - No new npm dependencies (pure Node core) — one less thing to break.
//   - Writes structured JSON lines to dated files in LOG_DIR with daily
//     rotation and a retention window, PLUS mirrors to stdout so
//     `docker logs` keeps working.
//   - NEVER crashes the app: if the log directory isn't writable we fall
//     back to console-only. Every file write is wrapped in try/catch.
//   - Redacts obvious secrets from any structured payload.
//
// Files (in LOG_DIR):
//   app-YYYY-MM-DD.log     — everything (info/warn/error)
//   error-YYYY-MM-DD.log   — errors only
//   access-YYYY-MM-DD.log  — one line per HTTP request (metadata only)
//
// Env:
//   LOG_LEVEL           debug|info|warn|error   (default info)
//   LOG_DIR             where to write          (default LOGS_PATH, else /app/logs)
//   LOG_RETENTION_DAYS  days to keep            (default 10)
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS || 10));

function resolveDir() {
    const candidates = [
        process.env.LOG_DIR,
        process.env.LOGS_PATH,
        '/app/logs',
        path.join(process.cwd(), 'logs'),
    ].filter(Boolean);
    for (const dir of candidates) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            // Confirm we can actually write here.
            fs.accessSync(dir, fs.constants.W_OK);
            return dir;
        } catch {
            /* try next */
        }
    }
    return null;
}

const LOG_DIR = resolveDir();
const fileEnabled = Boolean(LOG_DIR);
if (!fileEnabled) {
    console.warn('[logger] no writable log directory — file logging disabled, console only');
}

// UTC date so filenames are stable regardless of server timezone.
function ymd(d = new Date()) {
    return d.toISOString().slice(0, 10);
}

// One append stream per (base, day). When the day rolls over the path
// changes, so a fresh stream is opened and the previous day's is closed.
const streams = new Map();
function streamFor(base) {
    if (!fileEnabled) return null;
    const file = path.join(LOG_DIR, `${base}-${ymd()}.log`);
    let s = streams.get(file);
    if (!s) {
        const prefix = path.join(LOG_DIR, `${base}-`);
        for (const [p, st] of streams) {
            if (p !== file && p.startsWith(prefix)) {
                try { st.end(); } catch { /* ignore */ }
                streams.delete(p);
            }
        }
        try {
            s = fs.createWriteStream(file, { flags: 'a' });
            s.on('error', () => {}); // never let a stream error crash us
            streams.set(file, s);
        } catch {
            return null;
        }
    }
    return s;
}

function writeFileLine(base, obj) {
    const s = streamFor(base);
    if (!s) return;
    try {
        s.write(`${JSON.stringify(obj)}\n`);
    } catch {
        /* ignore */
    }
}

const SECRET_KEY = /^(password|pass|token|authorization|cookie|refreshtoken|accesstoken|secret|apikey)$/i;
function redact(v, depth = 0) {
    if (v == null || depth > 5) return v;
    if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
    if (typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) {
            out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v[k], depth + 1);
        }
        return out;
    }
    return v;
}

function emit(level, msg, meta) {
    if ((LEVELS[level] ?? 99) < MIN) return;
    const t = new Date().toISOString();
    const rec = { t, level };
    if (typeof msg === 'string') rec.msg = msg;
    else rec.data = redact(msg);
    if (meta) rec.meta = redact(meta);

    const line = `[${t}] ${level.toUpperCase()} ${rec.msg ?? ''}`.trimEnd();
    if (level === 'error') console.error(line, meta ? redact(meta) : '');
    else if (level === 'warn') console.warn(line);
    else console.log(line);

    writeFileLine('app', rec);
    if (level === 'error') writeFileLine('error', rec);
}

const logger = {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    // Access log line (already-shaped object, metadata only → no redaction
    // needed because we never put a body/secret in it).
    access: (obj) => writeFileLine('access', obj),
    dir: LOG_DIR,
    enabled: fileEnabled,
};

// Skip the health/readiness probes — the Docker healthcheck hits
// /api/ready every 30s and would otherwise drown the access log.
const SKIP_ACCESS = /^\/api\/(ready|health)\b/;

// Express middleware: one access-log line per request, on response finish.
// Metadata only: method, path, status, duration, user id, IP, user-agent.
function requestLogger(req, res, next) {
    const startNs = process.hrtime.bigint();
    res.on('finish', () => {
        try {
            const url = req.originalUrl || req.url || '';
            const path0 = url.split('?')[0];
            if (SKIP_ACCESS.test(path0)) return;
            const durMs = Number(process.hrtime.bigint() - startNs) / 1e6;
            logger.access({
                t: new Date().toISOString(),
                method: req.method,
                path: path0,
                status: res.statusCode,
                durMs: Math.round(durMs),
                user: req.user?.id || null,
                ip: req.ip || req.socket?.remoteAddress || null,
                ua: req.headers['user-agent'] || null,
            });
        } catch {
            /* never let logging break a response */
        }
    });
    next();
}

// Express error middleware — mount BEFORE the JSON-shape error handler.
// Logs the error (with stack) then re-throws so the real handler still
// owns the response body.
function errorLogger(err, req, res, next) {
    try {
        const url = (req.originalUrl || req.url || '').split('?')[0];
        logger.error(`${req.method} ${url} -> ${err.status || 500} ${err.message || ''}`, {
            status: err.status || 500,
            stack: err.stack,
            user: req.user?.id || null,
            ip: req.ip || null,
        });
    } catch {
        /* ignore */
    }
    next(err);
}

// Return the last N lines of the most recent dated file for a base name.
// Used by the admin "tail" endpoint. `base` must be one of the known logs.
function readTail(base, lines = 200) {
    if (!fileEnabled) return { file: null, lines: [], dir: LOG_DIR };
    let files;
    try {
        const re = new RegExp(`^${base}-\\d{4}-\\d{2}-\\d{2}\\.log$`);
        files = fs.readdirSync(LOG_DIR).filter((f) => re.test(f)).sort();
    } catch {
        return { file: null, lines: [], dir: LOG_DIR };
    }
    if (!files.length) return { file: null, lines: [], dir: LOG_DIR };
    const file = files[files.length - 1];
    let content = '';
    try {
        content = fs.readFileSync(path.join(LOG_DIR, file), 'utf8');
    } catch {
        return { file, lines: [], dir: LOG_DIR };
    }
    const arr = content.split('\n').filter(Boolean);
    const n = Math.min(Math.max(1, Number(lines) || 200), 1000);
    return { file, lines: arr.slice(-n), dir: LOG_DIR };
}

// Delete dated log files older than the retention window.
function pruneOldLogs() {
    if (!fileEnabled) return;
    let files;
    try {
        files = fs.readdirSync(LOG_DIR);
    } catch {
        return;
    }
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    const re = /-(\d{4})-(\d{2})-(\d{2})\.log$/;
    for (const f of files) {
        const m = f.match(re);
        if (!m) continue;
        const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
        if (Number.isFinite(t) && t < cutoff) {
            try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch { /* ignore */ }
        }
    }
}

// Prune on boot and every 12h. `unref` so the timer never keeps the
// process alive on its own.
pruneOldLogs();
const pruneTimer = setInterval(pruneOldLogs, 12 * 3600 * 1000);
if (pruneTimer.unref) pruneTimer.unref();

module.exports = { logger, requestLogger, errorLogger, readTail, pruneOldLogs, LOG_DIR };
