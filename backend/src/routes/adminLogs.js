// Admin-only observability endpoints:
//   GET /api/admin/auth-events   — the sign-in / auth audit trail (DB), with
//                                  filtering + pagination.
//   GET /api/admin/logs/:name    — tail the last N lines of a server log file
//                                  (name whitelisted to access|app|error).
const express = require('express');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const { requireCapability, CAPABILITIES } = require('../lib/permissions');
const { readTail, LOG_DIR } = require('../lib/logger');

const router = express.Router();
router.use(requireAuth);

// Logs are a restricted (super-admin) capability — NOT covered by the
// admin blanket, so a plain admin without the grant gets a 403.
function assertLogsAccess(req) {
    requireCapability(req, CAPABILITIES.LOGS_VIEW);
}

const AUTH_TYPES = new Set(['LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_BLOCKED']);
const LOG_FILES = new Set(['access', 'app', 'error']);

// ── Sign-in / auth audit trail ────────────────────────────────────────
router.get('/auth-events', async (req, res, next) => {
    try {
        assertLogsAccess(req);

        const page = Math.max(1, Number(req.query.page) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 25));

        const where = {};
        if (req.query.email) {
            where.email = { contains: String(req.query.email), mode: 'insensitive' };
        }
        if (req.query.type && AUTH_TYPES.has(String(req.query.type))) {
            where.type = String(req.query.type);
        }
        // `outcome=failed` groups FAILED + BLOCKED for a quick "problems only"
        // filter without picking an exact type.
        if (req.query.outcome === 'failed') {
            where.type = { in: ['LOGIN_FAILED', 'LOGIN_BLOCKED'] };
        }
        const from = req.query.from ? new Date(String(req.query.from)) : null;
        const to = req.query.to ? new Date(String(req.query.to)) : null;
        if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
            where.createdAt = {};
            if (from && !Number.isNaN(from.getTime())) where.createdAt.gte = from;
            if (to && !Number.isNaN(to.getTime())) where.createdAt.lte = to;
        }

        const [events, total] = await Promise.all([
            prisma.authEvent.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            prisma.authEvent.count({ where }),
        ]);

        res.json({ events, total, page, pageSize });
    } catch (err) {
        next(err);
    }
});

// Build the same WHERE clause the list uses, from the query string.
function authWhereFromQuery(query) {
    const where = {};
    if (query.email) {
        where.email = { contains: String(query.email), mode: 'insensitive' };
    }
    if (query.type && AUTH_TYPES.has(String(query.type))) {
        where.type = String(query.type);
    }
    if (query.outcome === 'failed') {
        where.type = { in: ['LOGIN_FAILED', 'LOGIN_BLOCKED'] };
    }
    const from = query.from ? new Date(String(query.from)) : null;
    const to = query.to ? new Date(String(query.to)) : null;
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
        where.createdAt = {};
        if (from && !Number.isNaN(from.getTime())) where.createdAt.gte = from;
        if (to && !Number.isNaN(to.getTime())) where.createdAt.lte = to;
    }
    return where;
}

function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── Export the sign-in log as CSV (respects the same filters) ─────────
router.get('/auth-events.csv', async (req, res, next) => {
    try {
        assertLogsAccess(req);
        const where = authWhereFromQuery(req.query);
        const rows = await prisma.authEvent.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: 10000, // hard cap so an export can't blow up memory
        });
        const header = ['time', 'email', 'type', 'reason', 'ip', 'userAgent'];
        const lines = [header.join(',')];
        for (const r of rows) {
            lines.push(
                [
                    r.createdAt.toISOString(),
                    r.email,
                    r.type,
                    r.reason,
                    r.ip,
                    r.userAgent,
                ]
                    .map(csvCell)
                    .join(','),
            );
        }
        // Leading BOM so Excel opens UTF-8 correctly.
        const csv = `﻿${lines.join('\r\n')}`;
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="sign-in-log-${stamp}.csv"`,
        );
        res.send(csv);
    } catch (err) {
        next(err);
    }
});

// ── Tail a server log file ────────────────────────────────────────────
router.get('/logs/:name', (req, res, next) => {
    try {
        assertLogsAccess(req);
        const name = String(req.params.name || '');
        if (!LOG_FILES.has(name)) throw httpError(400, 'Unknown log file');
        const lines = Math.min(1000, Math.max(1, Number(req.query.lines) || 200));
        const result = readTail(name, lines);
        res.json({
            name,
            file: result.file,
            dir: LOG_DIR,
            enabled: Boolean(LOG_DIR),
            lines: result.lines,
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
