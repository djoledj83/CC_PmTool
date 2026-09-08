// Billing endpoints — admin-only summary of every project's pricing.
//
// Returns one row per project with the internal-settlement and client
// price, paid status, paid-on date and computed unpaid totals so the
// frontend Billing page can render a tidy table without doing the math
// itself.

const express = require('express');

const prisma = require('../lib/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logActivityEvent } = require('../lib/activityLog');

const router = express.Router();

router.use(requireAuth);

const PROJECT_SELECT = {
    id: true,
    name: true,
    status: true,
    client: true,
    country: true,
    crmId: true,
    label: true,
    labelColor: true,
    phase: true,
    startDate: true,
    endDate: true,
    closedAt: true,
    createdAt: true,
    updatedAt: true,
    internalAmount: true,
    internalCurrency: true,
    internalPaid: true,
    internalPaidAt: true,
    clientAmount: true,
    clientCurrency: true,
    clientPaid: true,
    clientPaidAt: true,
    billingNotes: true,
    owner: { select: { id: true, name: true, email: true, avatarUrl: true } },
    reporter: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    // Per-CR money so the Billing page can render a breakdown row
    // under each project (CR-001: client X, internal Y), plus the
    // computed contracted-total in the summary cards. Sorted by
    // creation order so CR-001 always comes before CR-002.
    changeRequests: {
        select: {
            id: true,
            code: true,
            title: true,
            internalAmount: true,
            internalPaid: true,
            internalPaidAt: true,
            clientAmount: true,
            clientPaid: true,
            clientPaidAt: true,
        },
        orderBy: { createdAt: 'asc' },
    },
};

// Aggregate by currency. Mixing currencies in a single sum would be
// misleading — instead we surface a per-currency breakdown and let the
// UI pick how to display them.
function emptyBucket() {
    return {
        internalTotal: {},
        internalPaid: {},
        internalUnpaid: {},
        clientTotal: {},
        clientPaid: {},
        clientUnpaid: {},
    };
}

function bumpBucket(bucket, key, currency, amount) {
    if (amount == null) return;
    const c = currency || 'EUR';
    bucket[key][c] = (bucket[key][c] || 0) + Number(amount);
}

function summariseProjects(rows) {
    const totals = emptyBucket();
    let projectsCount = 0;
    let internalUnpaidCount = 0;
    let clientUnpaidCount = 0;

    for (const p of rows) {
        projectsCount += 1;
        bumpBucket(totals, 'internalTotal', p.internalCurrency, p.internalAmount);
        bumpBucket(totals, 'clientTotal', p.clientCurrency, p.clientAmount);
        if (p.internalAmount != null) {
            if (p.internalPaid) {
                bumpBucket(
                    totals,
                    'internalPaid',
                    p.internalCurrency,
                    p.internalAmount,
                );
            } else {
                bumpBucket(
                    totals,
                    'internalUnpaid',
                    p.internalCurrency,
                    p.internalAmount,
                );
                internalUnpaidCount += 1;
            }
        }
        if (p.clientAmount != null) {
            if (p.clientPaid) {
                bumpBucket(totals, 'clientPaid', p.clientCurrency, p.clientAmount);
            } else {
                bumpBucket(
                    totals,
                    'clientUnpaid',
                    p.clientCurrency,
                    p.clientAmount,
                );
                clientUnpaidCount += 1;
            }
        }

        // CRs roll into the same buckets — they're contracted scope
        // that bills in the project's currency. Each CR contributes
        // to total + (paid/unpaid) just like the project's base
        // amount does. The unpaid-count tallies stay project-level
        // (the user's mental model is "this project has unpaid
        // money", whether it's the SOW or a CR doesn't matter for
        // the count).
        for (const cr of p.changeRequests || []) {
            bumpBucket(
                totals,
                'internalTotal',
                p.internalCurrency,
                cr.internalAmount,
            );
            bumpBucket(
                totals,
                'clientTotal',
                p.clientCurrency,
                cr.clientAmount,
            );
            if (cr.internalAmount != null) {
                bumpBucket(
                    totals,
                    cr.internalPaid ? 'internalPaid' : 'internalUnpaid',
                    p.internalCurrency,
                    cr.internalAmount,
                );
            }
            if (cr.clientAmount != null) {
                bumpBucket(
                    totals,
                    cr.clientPaid ? 'clientPaid' : 'clientUnpaid',
                    p.clientCurrency,
                    cr.clientAmount,
                );
            }
        }
    }

    // Round the per-currency sums so the JSON stays clean.
    for (const key of Object.keys(totals)) {
        for (const c of Object.keys(totals[key])) {
            totals[key][c] = Math.round(totals[key][c] * 100) / 100;
        }
    }

    return {
        projectsCount,
        internalUnpaidCount,
        clientUnpaidCount,
        ...totals,
    };
}

router.get('/', requireAdmin, async (req, res, next) => {
    try {
        // Optional filters mirror the export route: status / country /
        // search / payment-state. We keep this lean — the frontend table
        // does its own client-side sorting and richer filters.
        const where = {};
        const { status, search, unpaid, paid, country } = req.query;

        if (status && typeof status === 'string') {
            const list = status.split(',').map((s) => s.trim()).filter(Boolean);
            if (list.length === 1) where.status = list[0];
            else if (list.length > 1) where.status = { in: list };
        }
        if (country && typeof country === 'string') {
            const list = country.split(',').map((s) => s.trim()).filter(Boolean);
            if (list.length === 1) where.country = list[0];
            else if (list.length > 1) where.country = { in: list };
        }
        if (search && typeof search === 'string') {
            const s = search.trim();
            if (s) {
                where.OR = [
                    { name: { contains: s, mode: 'insensitive' } },
                    { client: { contains: s, mode: 'insensitive' } },
                    { crmId: { contains: s, mode: 'insensitive' } },
                ];
            }
        }
        if (unpaid === 'internal') where.internalPaid = false;
        else if (unpaid === 'client') where.clientPaid = false;
        else if (unpaid === 'any') {
            where.OR = [
                ...(where.OR || []),
                { internalPaid: false, internalAmount: { not: null } },
                { clientPaid: false, clientAmount: { not: null } },
            ];
        }
        // Inverse: surface fully-paid rows. `internal`/`client` only
        // require that side to be paid; `both` requires both. We also
        // require the corresponding amount to be non-null so projects
        // without pricing don't pollute the "paid" view.
        if (paid === 'internal') {
            where.internalPaid = true;
            where.internalAmount = { not: null };
        } else if (paid === 'client') {
            where.clientPaid = true;
            where.clientAmount = { not: null };
        } else if (paid === 'both') {
            where.AND = [
                ...(where.AND || []),
                {
                    OR: [
                        { internalAmount: null },
                        { internalPaid: true },
                    ],
                },
                {
                    OR: [
                        { clientAmount: null },
                        { clientPaid: true },
                    ],
                },
                {
                    OR: [
                        { internalAmount: { not: null } },
                        { clientAmount: { not: null } },
                    ],
                },
            ];
        }

        const projects = await prisma.project.findMany({
            where,
            orderBy: [{ updatedAt: 'desc' }],
            select: PROJECT_SELECT,
        });

        // Skip projects that have no pricing at all when the caller
        // asked for an unpaid-only or paid-only view (they're noise).
        const filtered =
            unpaid || paid
                ? projects.filter(
                      (p) =>
                          p.internalAmount != null || p.clientAmount != null,
                  )
                : projects;

        res.json({
            projects: filtered,
            summary: summariseProjects(filtered),
        });
    } catch (err) {
        next(err);
    }
});

// Convenience endpoints to flip the "paid" flag from the Billing
// table without going through the full project edit form. We mirror
// the audit log + side-effects from the PATCH /projects/:id flow so
// a quick toggle here ends up identical to a full edit there.
async function togglePay(req, res, next, kind) {
    try {
        const { paid } = req.body || {};
        const next_ = paid === false ? false : true;
        const now = new Date();
        const isInternal = kind === 'internal';

        // Snapshot first so we can short-circuit no-op toggles and
        // include the previous state in the audit event.
        const existing = await prisma.project.findUnique({
            where: { id: req.params.id },
            select: PROJECT_SELECT,
        });
        if (!existing) return res.status(404).json({ error: 'Project not found' });

        const wasPaid = isInternal ? existing.internalPaid : existing.clientPaid;
        const data = isInternal
            ? {
                  internalPaid: next_,
                  internalPaidAt: next_ ? now : null,
                  statusUpdatedAt: now,
              }
            : {
                  clientPaid: next_,
                  clientPaidAt: next_ ? now : null,
                  statusUpdatedAt: now,
              };

        const project = await prisma.project.update({
            where: { id: req.params.id },
            data,
            select: PROJECT_SELECT,
        });

        if (wasPaid !== next_) {
            await logActivityEvent({
                type: 'PROJECT_PAYMENT_CHANGED',
                actorId: req.user.id,
                projectId: project.id,
                fromValue: wasPaid ? 'paid' : 'unpaid',
                toValue: next_ ? 'paid' : 'unpaid',
                message: project.name,
                meta: {
                    kind,
                    amount: isInternal
                        ? project.internalAmount
                        : project.clientAmount,
                    currency: isInternal
                        ? project.internalCurrency
                        : project.clientCurrency,
                    source: 'billing-toggle',
                },
            });
        }

        res.json({ project });
    } catch (err) {
        next(err);
    }
}

router.post('/:id/internal/pay', requireAdmin, (req, res, next) =>
    togglePay(req, res, next, 'internal'),
);

router.post('/:id/client/pay', requireAdmin, (req, res, next) =>
    togglePay(req, res, next, 'client'),
);

module.exports = router;
