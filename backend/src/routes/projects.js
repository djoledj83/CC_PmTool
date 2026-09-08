const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    notify,
    projectParticipantIds,
    ensureProjectParticipant,
} = require('../lib/notify');
const {
    isAdmin,
    isManager,
    requireAdminRole,
    requireAdminOrManagerRole,
    CAPABILITIES,
    hasCapability,
    isAdminOrManagerOrHasCapability,
    isAdminOrHasCapability,
    accessibleProjectIds,
    assertProjectRead,
} = require('../lib/permissions');
const { logActivityEvent } = require('../lib/activityLog');
const { generateProjectCode } = require('../lib/codes');
const { assertValidProjectStatus } = require('../lib/projectStatuses');

const PROJECT_STATUS_LABELS = {
    TODO: 'To do',
    IN_PROGRESS: 'In progress',
    DONE: 'Done',
    ON_HOLD: 'On hold',
};

const LABEL_COLOR_WHITELIST = new Set([
    'slate',
    'sky',
    'emerald',
    'amber',
    'rose',
    'violet',
    'fuchsia',
    'cyan',
    'lime',
]);

const ONGOING_FORBIDDEN_STATUSES = new Set(['DONE', 'CLIENT_TEST', 'BILLING']);

async function assertStatusAllowedForProjectType(status, projectTypeId) {
    if (!status || !ONGOING_FORBIDDEN_STATUSES.has(status) || !projectTypeId) {
        return;
    }
    const pt = await prisma.projectTypeOption.findUnique({
        where: { id: projectTypeId },
        select: { hideMarkComplete: true },
    });
    if (pt?.hideMarkComplete) {
        throw httpError(
            400,
            'This project type does not support Completed, Client test, or Billing status',
        );
    }
}

function normalizeProjectLabels(data) {
    if (!data || data.labels === undefined) return data;
    const next = { ...data };
    const raw = Array.isArray(data.labels) ? data.labels : [];
    const cleaned = raw
        .map((l) => ({
            text: (l?.text || '').trim(),
            color: LABEL_COLOR_WHITELIST.has(l?.color) ? l.color : 'slate',
        }))
        .filter((l) => l.text)
        .slice(0, 30);
    next.labels = cleaned.length ? cleaned : null;
    next.label = cleaned.length ? cleaned.map((l) => l.text).join(', ') : null;
    next.labelColor = cleaned.length ? cleaned[0].color : null;
    return next;
}

// Don't spam the audit log with view events: ignore subsequent views by
// the same user on the same project within this window.
const PROJECT_VIEW_THROTTLE_MS = 30 * 60 * 1000;

// Project edits we surface in the audit log under PROJECT_DETAILS_UPDATED.
// Status / owner / phase / billing changes have their own dedicated event
// types and are excluded here so we don't double-log them.
const DETAIL_FIELD_LABELS = {
    name: 'name',
    description: 'description',
    startDate: 'start date',
    endDate: 'end date',
    country: 'country',
    client: 'client',
    crmId: 'CRM ID',
    projectTypeId: 'project type',
    priority: 'priority',
    label: 'label',
    labelColor: 'label colour',
    reporterId: 'reporter',
};

const BILLING_FIELD_LABELS = {
    internalAmount: 'internal amount',
    internalCurrency: 'internal currency',
    clientAmount: 'client amount',
    clientCurrency: 'client currency',
    billingNotes: 'billing notes',
};

// Compare two values that may be Dates, strings or numbers. Coerces
// null / '' to a single canonical "empty" so a `null` -> `''` no-op
// edit doesn't get logged as a change.
function valueChanged(a, b) {
    const norm = (v) => {
        if (v == null || v === '') return null;
        if (v instanceof Date) return v.getTime();
        return v;
    };
    const av = norm(a);
    const bv = norm(b);
    if (av instanceof Date && bv instanceof Date) {
        return av.getTime() !== bv.getTime();
    }
    return av !== bv;
}

// Returns the list of keys (from `fieldMap`) that actually changed
// between `existing` and `data`. We only consider fields that the
// caller actually included in the patch — undefined means "leave as
// is" and shouldn't count as a change.
function changedFieldNames(existing, data, fieldMap) {
    const out = [];
    for (const key of Object.keys(fieldMap)) {
        if (!(key in data)) continue;
        if (data[key] === undefined) continue;
        if (valueChanged(existing[key], data[key])) {
            out.push(key);
        }
    }
    return out;
}

const router = express.Router();

router.use(requireAuth);

// Status is now a free string driven by the admin-managed StatusOption
// table (scope PROJECT) so admins can define fully custom workflow
// states. We only shape-check it here (non-empty, bounded); the actual
// "is this a known status key?" check happens at runtime via
// assertValidProjectStatus (which unions the six built-in keys with
// every StatusOption PROJECT key). The six built-in keys still carry
// special code semantics (DONE = complete, etc.).
const ProjectStatus = z.string().min(1).max(40);
const ProjectLifecycle = z.enum([
    'PLANNING',
    'ACTIVE',
    'MAINTENANCE',
    'CLOSED',
    'ARCHIVED',
]);
const ProjectPriority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);

const optionalDate = z
    .union([z.string().datetime(), z.literal(''), z.null()])
    .optional()
    .transform((v) => {
        if (v === undefined) return undefined;
        if (v === null || v === '') return null;
        return new Date(v);
    });

// Money input: accept null, empty string or a non-negative number. We
// coerce empty / undefined to null so the form can clear a value.
const optionalMoney = z
    .union([
        z.number().nonnegative().finite(),
        z.string(),
        z.null(),
    ])
    .optional()
    .transform((v) => {
        if (v === undefined) return undefined;
        if (v === null || v === '') return null;
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n) || n < 0) return null;
        // Round to 2 decimals so we never persist 199.99000000003.
        return Math.round(n * 100) / 100;
    });

const baseShape = {
    name: z.string().min(1).max(150),
    description: z.string().max(2000).optional().nullable(),
    status: ProjectStatus.optional(),
    // Lifecycle mode (PLANNING/ACTIVE/MAINTENANCE/CLOSED/ARCHIVED).
    // Independent of status — a project can be ACTIVE but on hold, or
    // MAINTENANCE and in progress on a CR. See ProjectLifecycle enum
    // in schema.prisma for the full state semantics.
    lifecycle: ProjectLifecycle.optional(),
    phase: z.string().max(100).optional().nullable(),
    startDate: optionalDate,
    endDate: optionalDate,
    country: z.string().max(100).optional().nullable(),
    client: z.string().max(150).optional().nullable(),
    crmId: z.string().max(100).optional().nullable(),
    clientId: z
        .string()
        .max(40)
        .optional()
        .nullable()
        .transform((v) => (v && v.trim() ? v.trim() : null)),
    applicationId: z
        .string()
        .max(40)
        .optional()
        .nullable()
        .transform((v) => (v && v.trim() ? v.trim() : null)),
    // FK into the admin-managed Product catalogue. Empty string → null.
    productId: z
        .string()
        .max(40)
        .optional()
        .nullable()
        .transform((v) => (v && v.trim() ? v.trim() : null)),
    // FK into the admin-managed Entity catalogue. Required on shared
    // projects (enforced in the handlers, not the schema, so partial
    // manager edits don't trip on it). Empty string → null.
    entityId: z
        .string()
        .max(40)
        .optional()
        .nullable()
        .transform((v) => (v && v.trim() ? v.trim() : null)),
    // For personal projects: the shared project this personal project
    // is linked to. Stored as a proper FK (linkedProjectId) so we can
    // resolve the name. Empty string is treated as null.
    linkedProjectId: z
        .string()
        .max(40)
        .optional()
        .nullable()
        .transform((v) => (v && v.trim() ? v.trim() : null)),
    // FK into ProjectTypeOption (admin-managed catalogue). Null clears
    // the category. Empty string is treated as null so the form can
    // send "" when the user picks the "(none)" option.
    projectTypeId: z
        .string()
        .max(40)
        .optional()
        .nullable()
        .transform((v) => (v && v.trim() ? v.trim() : null)),
    priority: ProjectPriority.optional(),
    label: z
        .union([z.string().max(100), z.literal(''), z.null()])
        .optional(),
    labelColor: z
        .union([z.string().max(20), z.literal(''), z.null()])
        .optional(),
    labels: z
        .array(
            z.object({
                text: z.string().min(1).max(50),
                color: z.string().max(20).optional(),
            }),
        )
        .max(30)
        .optional()
        .nullable(),
    reporterId: z.string().min(1).optional().nullable(),
    ownerId: z.string().min(1).optional(),
    // Billing — internal settlement amount + paid flag, and the client
    // price + paid flag. Currency defaults to EUR. *PaidAt is managed
    // by the server (set when paid flips on, cleared when it flips
    // back off).
    internalAmount: optionalMoney,
    internalCurrency: z.string().max(10).optional().nullable(),
    internalPaid: z.boolean().optional(),
    clientAmount: optionalMoney,
    clientCurrency: z.string().max(10).optional().nullable(),
    clientPaid: z.boolean().optional(),
    billingNotes: z.string().max(2000).optional().nullable(),
};

// Create accepts an optional list of team ids — when present we attach
// each team to the new project and bulk-add their members as
// participants. Edits don't take this field; team membership is managed
// from the Project Teams panel afterwards.
const createSchema = z.object({
    ...baseShape,
    // Names of phase templates to seed on the new project. Omit to
    // include every active template (legacy default).
    phaseNames: z.array(z.string().min(1).max(100)).max(30).optional(),
    teamIds: z.array(z.string().min(1)).max(50).optional(),
    // When true, the project is a private personal organiser owned
    // solely by the creator. Anyone (including regular users) can
    // create one. Personal projects ignore teamIds / reporterId — the
    // creator is the only person involved.
    isPersonal: z.boolean().optional().default(false),
});
const updateSchema = z
    .object({ ...baseShape, name: baseShape.name.optional() })
    .partial();

// Subset of fields a MANAGER is allowed to change inline from the
// projects list. Anything outside this list (name, description,
// billing, labels, …) is silently stripped at parse time so managers
// cannot rename or reprice a project — they can only do day-to-day
// workflow tweaks. Each per-user capability override below contributes
// its own subset; the union of all subsets a caller holds is what the
// PATCH handler will actually accept.
const MANAGER_INLINE_FIELDS = [
    'status',
    'priority',
    'phase',
    'startDate',
    'endDate',
    'ownerId',
    'reporterId',
];

// Field subsets unlocked by the corresponding per-user capability
// checkboxes (rendered in the admin User edit dialog under "Projects").
// These were previously DEAD CODE — the checkboxes existed in the
// catalogue but no route consulted them, so granting them did nothing.
// The PATCH handler now ORs these into the manager subset to produce
// the effective allowed-field set per request.
const PROJECT_CLOSE_FIELDS = ['status'];
const PROJECT_BILLING_FIELDS = [
    'internalAmount',
    'internalCurrency',
    'internalPaid',
    'clientAmount',
    'clientCurrency',
    'clientPaid',
    'billingNotes',
];

// Builds a partial schema that accepts ONLY the named fields. Unknown
// fields are silently stripped (Zod's default for `.object().partial()`)
// so the form on the client can keep sending its full payload — a
// regression in client/server agreement won't error, it'll just drop
// the fields the user wasn't authorised to change. This matches the
// historical manager behaviour so we don't break any existing flow.
function buildPatchSchemaFor(fields) {
    return z
        .object(
            Object.fromEntries(
                Array.from(fields)
                    .filter((k) => baseShape[k])
                    .map((k) => [k, baseShape[k]]),
            ),
        )
        .partial();
}

const projectInclude = {
    owner: { select: { id: true, name: true, email: true, avatarUrl: true } },
    reporter: { select: { id: true, name: true, email: true, avatarUrl: true } },
    // For personal projects: the shared project they're linked to
    linkedProject: { select: { id: true, code: true, name: true } },
    tasks: {
        // Soft-deleted tasks must NOT leak into the project payload —
        // the Prisma client extension on `prisma.task.*` reads can't
        // touch nested includes, so the filter goes here explicitly.
        where: { deletedAt: null },
        select: {
            id: true,
            status: true,
            // M3: surface CR membership in the list payload so cards
            // can render the "CR-001" chip without an extra fetch.
            changeRequestId: true,
        },
    },
    projectType: {
        select: { id: true, name: true, isActive: true, hideMarkComplete: true },
    },
    clientRecord: {
        select: {
            id: true,
            name: true,
            crmId: true,
            country: true,
            city: true,
            address: true,
        },
    },
    application: {
        select: { id: true, name: true, packageName: true, logoUrl: true },
    },
    product: {
        select: { id: true, name: true, code: true, description: true },
    },
    entity: {
        select: { id: true, code: true, description: true },
    },
    // We pull just enough of each CR for two jobs:
    //   - summaryCounts() to roll up the contracted total (only the
    //     two money fields matter for the math).
    //   - The right-rail Billing card on ProjectDetail to render a
    //     per-CR breakdown row (needs code + title for the label).
    // Description / status / paid flags would inflate the payload
    // for the project list view that doesn't render CR detail —
    // forList() strips them, forDetail() keeps them.
    changeRequests: {
        select: {
            id: true,
            code: true,
            title: true,
            internalAmount: true,
            clientAmount: true,
        },
        orderBy: { createdAt: 'asc' },
    },
    _count: {
        select: {
            notes: true,
            files: true,
            phases: true,
            participants: true,
            changeRequests: true,
        },
    },
    // Lightweight team membership for the project list filter —
    // project-level attaches plus phase-level owns.
    teams: { select: { teamId: true } },
    phases: { select: { teams: { select: { teamId: true } } } },
};

// Fallback phase names used only when the PhaseTemplate table is empty
// (e.g. fresh boot before templates have been seeded). Once the table
// has rows, those win — admins can edit / add / remove them from the
// admin Templates page.
const DEFAULT_PHASE_NAMES = [
    'Kick-off',
    'Planning',
    'Implementation',
    'Review',
    'Closing',
];

// Returns active phase templates ordered by `order`. Falls back to
// the hard-coded list (with no colour) if no templates have been
// defined yet. We return the full {name, color} shape so phases
// created from a template inherit the admin-picked colour.
async function loadActivePhases() {
    const rows = await prisma.phaseTemplate.findMany({
        where: { isActive: true },
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
        select: { name: true, color: true },
    });
    if (rows.length === 0) {
        return DEFAULT_PHASE_NAMES.map((name) => ({ name, color: null }));
    }
    return rows.map((r) => ({ name: r.name, color: r.color || null }));
}

function summaryCounts(project) {
    // CR money rollups: sum non-null amounts across all child CRs.
    // The frontend renders these as "Original / + CRs / Total" for
    // both internal and client billing tracks. Currency isn't summed
    // because every CR inherits the parent project's currency by
    // policy (enforced server-side: CR rows have no currency column).
    const crs = project.changeRequests || [];
    const sumInternal = crs.reduce(
        (acc, cr) => acc + (Number(cr.internalAmount) || 0),
        0,
    );
    const sumClient = crs.reduce(
        (acc, cr) => acc + (Number(cr.clientAmount) || 0),
        0,
    );
    const baseInternal = Number(project.internalAmount) || 0;
    const baseClient = Number(project.clientAmount) || 0;
    return {
        totalTasks: project.tasks?.length ?? 0,
        doneTasks: project.tasks?.filter((t) => t.status === 'DONE').length ?? 0,
        noteCount: project._count?.notes ?? 0,
        fileCount: project._count?.files ?? 0,
        participantCount: project._count?.participants ?? 0,
        crCount: project._count?.changeRequests ?? 0,
        // Per-side rollups: keep "base" (original SOW), "crs" (sum of
        // child CR amounts), and "total" (base + crs). Frontend can
        // render any of the three without recomputing.
        crSumInternal: Math.round(sumInternal * 100) / 100,
        crSumClient: Math.round(sumClient * 100) / 100,
        totalContractedInternal:
            Math.round((baseInternal + sumInternal) * 100) / 100,
        totalContractedClient:
            Math.round((baseClient + sumClient) * 100) / 100,
    };
}

function collectProjectTeamIds(project) {
    const ids = new Set();
    for (const row of project.teams || []) {
        if (row.teamId) ids.add(row.teamId);
    }
    for (const phase of project.phases || []) {
        for (const row of phase.teams || []) {
            if (row.teamId) ids.add(row.teamId);
        }
    }
    return Array.from(ids);
}

function forList(project) {
    const counts = summaryCounts(project);
    const teamIds = collectProjectTeamIds(project);
    // Strip nested arrays so we don't ship the per-CR money detail in
    // the list payload — the rollup numbers in `counts` are the only
    // CR data the list cares about.
    const { tasks, changeRequests, _count, teams, phases, ...rest } = project;
    return { ...rest, ...counts, teamIds };
}

function forDetail(project) {
    const counts = summaryCounts(project);
    // Keep `changeRequests` on the detail payload — the Billing card
    // renders a per-CR breakdown row. List view strips it for size.
    const { _count, ...rest } = project;
    return { ...rest, ...counts };
}

// Visibility = admin can see anything; regular users must be a participant
// (owner counts as a participant).
async function loadVisibleProjectOr403(req, projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw httpError(404, 'Project not found');
    // Personal projects are private to their owner (and any explicit
    // participant) — invisible even to admins. This check runs BEFORE the
    // admin bypass; we 404 (not 403) so a personal project's existence
    // never leaks to outsiders.
    if (project.isPersonal) {
        if (project.ownerId === req.user.id) return project;
        const participation = await prisma.projectParticipant.findUnique({
            where: { projectId_userId: { projectId, userId: req.user.id } },
            select: { id: true },
        });
        if (!participation) throw httpError(404, 'Project not found');
        return project;
    }
    if (isAdmin(req)) return project;
    if (project.ownerId === req.user.id) return project;
    const participation = await prisma.projectParticipant.findUnique({
        where: { projectId_userId: { projectId, userId: req.user.id } },
        select: { id: true },
    });
    if (!participation) {
        throw httpError(403, 'You do not have access to this project');
    }
    return project;
}

// Project edit/delete is admin-only under the current policy.
async function requireProjectAdmin(req, projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw httpError(404, 'Project not found');
    // Personal projects: only the owner can delete / mass-edit. We
    // return 404 (not 403) for non-owners so personal projects stay
    // truly invisible to outsiders.
    if (project.isPersonal) {
        if (project.ownerId !== req.user.id) {
            throw httpError(404, 'Project not found');
        }
        return project;
    }
    if (
        !isAdminOrHasCapability(req, CAPABILITIES.PROJECT_DELETE)
    ) {
        throw httpError(
            403,
            'You do not have permission to delete projects',
        );
    }
    return project;
}

// Permission gate for project edits.
//   - Personal projects: only the owner can edit (full edit, no
//     manager-inline restrictions).
//   - Shared projects: admins edit anything; managers edit projects
//     they participate in (limited to MANAGER_INLINE_FIELDS).
// Computes the caller's effective edit tier for a project.
//
// Returns `{ project, asAdmin, allowedFields }` where `allowedFields` is
// either `null` (full edit — any field in `baseShape` accepted) or a
// `Set<string>` listing the only field names the PATCH handler should
// accept from the body. The schema builder above turns that set into a
// Zod schema for parsing.
//
// Tiers, from broadest to narrowest:
//   - Personal-project owner       → full edit on own personal project.
//   - ADMIN                        → full edit on any project.
//   - PROJECT_EDIT_ANY (per-user)  → same as admin for shared projects.
//   - MANAGER                      → MANAGER_INLINE_FIELDS only.
//   - PROJECT_CLOSE (per-user)     → adds `status` (flip to/from DONE).
//   - PROJECT_BILLING_MANAGE       → adds the seven billing fields.
//
// A caller can hold multiple per-user capabilities (e.g. CLOSE + BILLING)
// — we OR all their subsets into one allowed-field set. If the union is
// empty, the request is rejected as before.
async function requireProjectEditAccess(req, projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw httpError(404, 'Project not found');
    if (project.isPersonal) {
        if (project.ownerId !== req.user.id) {
            throw httpError(404, 'Project not found');
        }
        return { project, asAdmin: true, allowedFields: null };
    }
    if (isAdmin(req)) return { project, asAdmin: true, allowedFields: null };
    // `project:edit:any` lifts a regular user to admin-equivalent edit
    // power on shared projects without granting any other admin access.
    if (hasCapability(req, CAPABILITIES.PROJECT_EDIT_ANY)) {
        return { project, asAdmin: true, allowedFields: null };
    }

    // Build the partial-access field set from every tier the user holds.
    // Managers still get the inline set unconditionally; per-user caps
    // stack on top so granting `project:billing:manage` to a manager
    // genuinely expands what they can change (previously the cap was
    // dead — the manager's inline schema silently stripped billing).
    const allowed = new Set();
    if (isManager(req)) {
        for (const f of MANAGER_INLINE_FIELDS) allowed.add(f);
    }
    if (hasCapability(req, CAPABILITIES.PROJECT_CLOSE)) {
        for (const f of PROJECT_CLOSE_FIELDS) allowed.add(f);
    }
    if (hasCapability(req, CAPABILITIES.PROJECT_BILLING_MANAGE)) {
        for (const f of PROJECT_BILLING_FIELDS) allowed.add(f);
    }
    if (allowed.size > 0) {
        // Reuses the standard read check (owner OR participant).
        await assertProjectRead(req, projectId);
        return { project, asAdmin: false, allowedFields: allowed };
    }

    throw httpError(
        403,
        'Administrator or manager permission required to edit this project',
    );
}

async function ensureUserExists(userId) {
    if (!userId) return;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw httpError(400, 'Selected user does not exist');
}

async function resolveClientAndProductFields(data) {
    const next = { ...data };
    if (next.clientId) {
        const client = await prisma.client.findUnique({
            where: { id: next.clientId },
            select: {
                id: true,
                name: true,
                country: true,
                isActive: true,
            },
        });
        if (!client) throw httpError(400, 'Client not found');
        if (!client.isActive) {
            throw httpError(400, 'That client is inactive');
        }
        next.client = client.name;
        next.country = client.country ?? next.country ?? null;
    }
    if (next.applicationId) {
        const app = await prisma.application.findUnique({
            where: { id: next.applicationId },
            select: { id: true },
        });
        if (!app) throw httpError(400, 'Application not found');
    }
    if (next.productId) {
        const product = await prisma.product.findUnique({
            where: { id: next.productId },
            select: { id: true },
        });
        if (!product) throw httpError(400, 'Product not found');
    }
    if (next.entityId) {
        const entity = await prisma.entity.findUnique({
            where: { id: next.entityId },
            select: { id: true },
        });
        if (!entity) throw httpError(400, 'Entity not found');
    }
    return next;
}

async function ensureDefaultPhases(projectId) {
    const count = await prisma.phase.count({ where: { projectId } });
    if (count > 0) return;
    const templates = await loadActivePhases();
    await prisma.phase.createMany({
        data: templates.map((t, idx) => ({
            projectId,
            name: t.name,
            order: idx,
            color: t.color || null,
        })),
    });
}

// Admins see every project; everyone else only sees projects they're
// involved in (owner or participant).
router.get('/', async (req, res, next) => {
    try {
        const ids = await accessibleProjectIds(req);
        const where = { id: { in: ids } };
        const projects = await prisma.project.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: projectInclude,
        });
        res.json({ projects: projects.map(forList) });
    } catch (err) {
        next(err);
    }
});

// Project creation:
//   - Personal projects: any authenticated user can create one.
//     Owner is forced to the caller, no other participants / reporter
//     / teams are attached.
//   - Shared projects: admin OR manager. Managers gain this through
//     the same "Personal project" switch admins see in the UI; regular
//     users never see the switch and so always submit isPersonal=true.
router.post('/', async (req, res, next) => {
    try {
        const data = normalizeProjectLabels(
            createSchema.parse(req.body),
        );
        await assertValidProjectStatus(data.status);
        const { phaseNames, ...createFields } = data;
        const resolved = await resolveClientAndProductFields(createFields);
        const now = new Date();
        const isPersonal = Boolean(resolved.isPersonal);

        if (!isPersonal) {
            // Default: admin or manager. Per-user override:
            // `project:create` lets anyone create a shared project.
            if (
                !isAdminOrManagerOrHasCapability(
                    req,
                    CAPABILITIES.PROJECT_CREATE,
                )
            ) {
                throw httpError(
                    403,
                    'You do not have permission to create projects',
                );
            }
        } else {
            // Personal projects MUST be linked to a shared project so
            // every minute logged on a personal task automatically
            // mirrors back to a project the team can see. Without
            // the link the personal project becomes a private
            // organiser whose hours never appear in any shared
            // billing / admin view — exactly the loophole we want to
            // close. Existing personal projects without a parent
            // stay grandfathered (the update path enforces the same
            // rule only when the field is explicitly touched).
            if (!resolved.linkedProjectId) {
                throw httpError(
                    400,
                    'A personal project must be linked to a shared parent project',
                );
            }
            const parent = await prisma.project.findUnique({
                where: { id: resolved.linkedProjectId },
                select: { id: true, isPersonal: true },
            });
            if (!parent) {
                throw httpError(400, 'Linked parent project not found');
            }
            if (parent.isPersonal) {
                throw httpError(
                    400,
                    'A personal project must be linked to a shared (non-personal) parent project',
                );
            }
        }

        // Shared projects must be tagged with an Entity (drives the
        // logged-time export grouping). Personal projects are exempt.
        if (!isPersonal && !resolved.entityId) {
            throw httpError(400, 'An entity is required for shared projects.');
        }

        let ownerId = req.user.id;
        if (!isPersonal) {
            if (!resolved.ownerId) {
                throw httpError(400, 'Assigned to is required');
            }
            await ensureUserExists(resolved.ownerId);
            ownerId = resolved.ownerId;
        }

        if (!isPersonal && resolved.status) {
            await assertStatusAllowedForProjectType(
                resolved.status,
                resolved.projectTypeId,
            );
        }

        if (!isPersonal && resolved.reporterId) {
            await ensureUserExists(resolved.reporterId);
        }

        const { ownerId: _drop, teamIds, ...rest } = resolved;

        // Up-front team validation so we don't half-create a project.
        // Personal projects can never have teams; silently drop them
        // to keep the create flow simple.
        let teamsToAttach = [];
        if (!isPersonal && Array.isArray(teamIds) && teamIds.length) {
            teamsToAttach = await prisma.team.findMany({
                where: { id: { in: teamIds } },
                include: { members: { select: { userId: true } } },
            });
            if (teamsToAttach.length !== teamIds.length) {
                throw httpError(400, 'One or more teams could not be found');
            }
        }

        // Personal projects start as a clean slate — no predefined
        // phase workflow, no billing flags, no reporter. Tasks added
        // later land in the "Unphased" virtual section, which is what
        // a personal organiser actually wants.
        let phaseTemplates = [];
        if (!isPersonal) {
            const all = await loadActivePhases();
            if (phaseNames === undefined) {
                phaseTemplates = all;
            } else if (phaseNames.length > 0) {
                const wanted = new Set(phaseNames);
                phaseTemplates = all.filter((t) => wanted.has(t.name));
            }
        }

        const project = await prisma.project.create({
            data: {
                ...rest,
                reporterId: resolved.reporterId || null,
                ownerId,
                statusChangedAt: now,
                statusUpdatedAt: now,
                closedAt: resolved.status === 'DONE' ? now : null,
                internalPaidAt: resolved.internalPaid ? now : null,
                clientPaidAt: resolved.clientPaid ? now : null,
                phases:
                    phaseTemplates.length === 0
                        ? undefined
                        : {
                              create: phaseTemplates.map((t, idx) => ({
                                  name: t.name,
                                  order: idx,
                                  color: t.color || null,
                              })),
                          },
                participants: {
                    // Personal projects: only the creator is "involved";
                    // we still seed a participant row so the existing
                    // visibility / chat / activity machinery works
                    // without special-casing every read.
                    create: isPersonal
                        ? [{ userId: ownerId, addedById: req.user.id }]
                        : Array.from(
                              new Set(
                                  [
                                      ownerId,
                                      resolved.reporterId,
                                      req.user.id,
                                  ].filter(Boolean),
                              ),
                          ).map((userId) => ({
                              userId,
                              addedById: req.user.id,
                          })),
                },
            },
            include: {
                ...projectInclude,
                phases: { orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] },
            },
        });

        // Stamp a friendly code (e.g. "P26-USA-0001") in a follow-up
        // update so a code-generation hiccup can never block the
        // project create itself. Worst case the row stays codeless and
        // the startup backfill picks it up later.
        try {
            const code = await generateProjectCode(prisma, {
                country: project.country,
                createdAt: project.createdAt,
            });
            const stamped = await prisma.project.update({
                where: { id: project.id },
                data: { code },
            });
            project.code = stamped.code;
        } catch (codeErr) {
            console.warn(
                '[projects] could not stamp project code:',
                codeErr.message,
            );
        }

        // Attach any teams the admin picked at create time. Each attach
        // also upserts every team member as a project participant — so
        // the team owners stop being a "phantom roster" and start
        // appearing in pickers / chat / notifications immediately.
        const teamMemberNotifyIds = new Set();
        for (const team of teamsToAttach) {
            await prisma.projectTeam.create({
                data: {
                    projectId: project.id,
                    teamId: team.id,
                    addedById: req.user.id,
                },
            });
            for (const m of team.members) {
                await ensureProjectParticipant(
                    project.id,
                    m.userId,
                    req.user.id,
                );
                if (m.userId !== req.user.id) {
                    teamMemberNotifyIds.add(m.userId);
                }
            }
            await logActivityEvent({
                type: 'PROJECT_TEAM_ADDED',
                actorId: req.user.id,
                projectId: project.id,
                message: `Added team "${team.name}" to ${project.name}`,
                meta: {
                    teamId: team.id,
                    teamName: team.name,
                    memberCount: team.members.length,
                    via: 'project-create',
                },
            });
        }

        // Notify the assigned owner (if not the actor) and the reporter.
        await notify({
            recipientIds: [ownerId, data.reporterId],
            actorId: req.user.id,
            type: 'PROJECT_CREATED',
            title: `New project: ${project.name}`,
            body:
                ownerId !== req.user.id
                    ? `${req.user.email} created a project and made you the owner.`
                    : `${req.user.email} added you as the reporter on a new project.`,
            projectId: project.id,
        });

        // Let team members know they were pulled in.
        if (teamMemberNotifyIds.size) {
            const teamNames = teamsToAttach.map((t) => t.name).join(', ');
            await notify({
                recipientIds: Array.from(teamMemberNotifyIds),
                actorId: req.user.id,
                type: 'PROJECT_UPDATED',
                title: `Added to ${project.name}`,
                body: `You were added through team${
                    teamsToAttach.length > 1 ? 's' : ''
                } "${teamNames}".`,
                projectId: project.id,
            });
        }

        res.status(201).json({ project: forList(project) });
    } catch (err) {
        next(err);
    }
});

// Detail view is gated by visibility (admin or participant/owner).
router.get('/:id', async (req, res, next) => {
    try {
        const visible = await loadVisibleProjectOr403(req, req.params.id);
        await ensureDefaultPhases(req.params.id);

        // Audit "viewed" events. Throttle so quickly switching tabs or
        // refreshing doesn't pollute the feed.
        try {
            const since = new Date(Date.now() - PROJECT_VIEW_THROTTLE_MS);
            const recent = await prisma.activityEvent.findFirst({
                where: {
                    type: 'PROJECT_VIEWED',
                    actorId: req.user.id,
                    projectId: visible.id,
                    createdAt: { gte: since },
                },
                select: { id: true },
            });
            if (!recent) {
                await logActivityEvent({
                    type: 'PROJECT_VIEWED',
                    actorId: req.user.id,
                    projectId: visible.id,
                    message: visible.name,
                });
            }
        } catch {
            /* never let auditing break the detail load */
        }

        const project = await prisma.project.findUnique({
            where: { id: req.params.id },
            include: {
                ...projectInclude,
                tasks: {
                    // Hide soft-deleted tasks from the detail view too.
                    // The Prisma extension can't reach this nested
                    // include so we set the filter manually.
                    where: { deletedAt: null },
                    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
                    include: {
                        assignee: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                avatarUrl: true,
                            },
                        },
                        // Echo the creator so the "by <name>" pill on
                        // the Plan view reads the original author
                        // instead of falling back to "unknown".
                        // PhasesPlan renders this pill on every row;
                        // ProjectDetail seeds PhasesPlan from this
                        // endpoint, so the include was the lowest
                        // place to add it.
                        createdBy: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                avatarUrl: true,
                            },
                        },
                        // Lightweight sprint chip on the Plan view —
                        // tasks belonging to a sprint show the sprint
                        // name as a small badge so users can spot
                        // sprint-committed work without leaving the
                        // Plan tab.
                        sprint: {
                            select: {
                                id: true,
                                name: true,
                                status: true,
                            },
                        },
                        // CR chip on the Plan view — tasks belonging
                        // to a Change Request show the CR's code as a
                        // small badge so the holistic project view
                        // can call out CR-scoped work at a glance.
                        changeRequest: {
                            select: {
                                id: true,
                                code: true,
                                title: true,
                            },
                        },
                        // Approver / disapprover so the Plan + task
                        // dialogs can show "Approved by X" / "Disapproved
                        // by X" (the scalar approvedAt/rejectedAt/
                        // rejectionReason come automatically with the
                        // include; these relations must be requested).
                        approvedBy: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                avatarUrl: true,
                            },
                        },
                        rejectedBy: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                avatarUrl: true,
                            },
                        },
                    },
                },
                activities: {
                    orderBy: [
                        { done: 'asc' },
                        { scheduledAt: 'asc' },
                        { order: 'asc' },
                        { createdAt: 'desc' },
                    ],
                    include: {
                        assignee: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                avatarUrl: true,
                            },
                        },
                        createdBy: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                avatarUrl: true,
                            },
                        },
                    },
                },
                phases: {
                    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
                },
                participants: {
                    where: { userId: req.user.id },
                    select: { id: true },
                    take: 1,
                },
            },
        });

        const isParticipant = (project.participants || []).length > 0;
        const { participants: _drop, ...rest } = project;
        res.json({ project: { ...forDetail(rest), isParticipant } });
    } catch (err) {
        next(err);
    }
});

// Editing a project. Access tiers are computed in
// `requireProjectEditAccess` (admin / personal-owner = full,
// `project:edit:any` = full on shared, manager = inline subset, plus
// per-user caps `project:close` and `project:billing:manage` that
// extend a regular USER's allowed-field set without granting full
// edit). The returned `allowedFields` is used to narrow the parse
// schema on the fly so the same handler covers every tier.
router.patch('/:id', async (req, res, next) => {
    try {
        const {
            project: existing,
            allowedFields,
        } = await requireProjectEditAccess(req, req.params.id);
        // `allowedFields === null` is the full-edit path (admin, owner of
        // a personal project, or PROJECT_EDIT_ANY holder). Otherwise we
        // narrow the schema to exactly the fields the caller's tier
        // permits — any extra keys in the body are silently dropped.
        const parsed = allowedFields
            ? buildPatchSchemaFor(allowedFields).parse(req.body)
            : updateSchema.parse(req.body);
        const data = normalizeProjectLabels(parsed);
        await assertValidProjectStatus(data.status);

        // A shared project can't have its Entity cleared once set — the
        // export depends on it. (Existing projects with no entity stay
        // valid until the user edits and picks one.)
        if (
            !existing.isPersonal &&
            data.entityId !== undefined &&
            !data.entityId
        ) {
            throw httpError(400, 'An entity is required for shared projects.');
        }

        if (
            data.clientId !== undefined ||
            data.applicationId !== undefined ||
            data.productId !== undefined ||
            data.entityId !== undefined
        ) {
            const synced = await resolveClientAndProductFields({
                clientId:
                    data.clientId !== undefined
                        ? data.clientId
                        : existing.clientId,
                applicationId:
                    data.applicationId !== undefined
                        ? data.applicationId
                        : existing.applicationId,
                productId:
                    data.productId !== undefined
                        ? data.productId
                        : existing.productId,
                entityId:
                    data.entityId !== undefined
                        ? data.entityId
                        : existing.entityId,
                country: data.country,
            });
            if (data.clientId !== undefined) {
                data.client = synced.client ?? data.client ?? null;
                data.country = synced.country ?? data.country ?? null;
            }
            if (data.applicationId !== undefined) {
                data.applicationId = synced.applicationId ?? null;
            }
        }

        const now = new Date();

        // Personal projects must keep a shared parent. If the user
        // explicitly sends `linkedProjectId` we either accept a
        // valid shared project OR reject — they CANNOT clear it.
        // Existing personal projects without a parent (grandfathered
        // from before the constraint) are untouched as long as the
        // field isn't on the request.
        if (existing.isPersonal && data.linkedProjectId !== undefined) {
            if (!data.linkedProjectId) {
                throw httpError(
                    400,
                    'A personal project must remain linked to a shared parent project',
                );
            }
            const parent = await prisma.project.findUnique({
                where: { id: data.linkedProjectId },
                select: { id: true, isPersonal: true },
            });
            if (!parent) {
                throw httpError(400, 'Linked parent project not found');
            }
            if (parent.isPersonal) {
                throw httpError(
                    400,
                    'A personal project must be linked to a shared (non-personal) parent project',
                );
            }
        }

        if (data.ownerId !== undefined && data.ownerId !== existing.ownerId) {
            await ensureUserExists(data.ownerId);
        } else if (data.ownerId !== undefined) {
            // Same owner; nothing to do, but keep it out of updateData below.
        }

        const updateData = { ...data, statusUpdatedAt: now };

        if (data.reporterId !== undefined) {
            updateData.reporterId = data.reporterId || null;
            if (data.reporterId) await ensureUserExists(data.reporterId);
        }

        if (data.ownerId === undefined || data.ownerId === existing.ownerId) {
            delete updateData.ownerId;
        }

        if (data.status && data.status !== existing.status) {
            const typeId =
                data.projectTypeId !== undefined
                    ? data.projectTypeId
                    : existing.projectTypeId;
            await assertStatusAllowedForProjectType(data.status, typeId);
            updateData.statusChangedAt = now;
            if (data.status === 'DONE') {
                updateData.closedAt = now;
            } else if (existing.status === 'DONE') {
                updateData.closedAt = null;
            }
        }

        // Stamp / clear the *PaidAt timestamp whenever the *Paid flag
        // flips. This lets the Billing page show "paid on" without us
        // having to thread an extra field through the form.
        if (
            data.internalPaid !== undefined &&
            data.internalPaid !== existing.internalPaid
        ) {
            updateData.internalPaidAt = data.internalPaid ? now : null;
        }
        if (
            data.clientPaid !== undefined &&
            data.clientPaid !== existing.clientPaid
        ) {
            updateData.clientPaidAt = data.clientPaid ? now : null;
        }

        const project = await prisma.project.update({
            where: { id: req.params.id },
            data: updateData,
            include: projectInclude,
        });

        // Make sure newly-set roles also become participants.
        if (data.reporterId) {
            await ensureProjectParticipant(project.id, data.reporterId, req.user.id);
        }
        if (data.ownerId) {
            await ensureProjectParticipant(project.id, data.ownerId, req.user.id);
        }

        // Decide which event(s) to fire. We deliberately fire focused ones
        // (status change, owner change) where applicable and fall back to a
        // generic "project updated" otherwise.
        const involved = await projectParticipantIds(project.id);

        if (data.status && data.status !== existing.status) {
            await notify({
                recipientIds: involved,
                actorId: req.user.id,
                type: 'PROJECT_STATUS_CHANGED',
                title: `${project.name}: status changed`,
                body: `${req.user.email} moved status from ${
                    PROJECT_STATUS_LABELS[existing.status] || existing.status
                } to ${PROJECT_STATUS_LABELS[data.status] || data.status}.`,
                projectId: project.id,
            });
            await logActivityEvent({
                type: 'PROJECT_STATUS_CHANGED',
                actorId: req.user.id,
                projectId: project.id,
                fromValue:
                    PROJECT_STATUS_LABELS[existing.status] || existing.status,
                toValue: PROJECT_STATUS_LABELS[data.status] || data.status,
                message: project.name,
            });
        }

        if (data.ownerId !== undefined && data.ownerId !== existing.ownerId) {
            await notify({
                recipientIds: [data.ownerId, existing.ownerId, ...involved],
                actorId: req.user.id,
                type: 'PROJECT_OWNER_CHANGED',
                title: `${project.name}: owner changed`,
                body: `${req.user.email} changed the project owner.`,
                projectId: project.id,
            });
            // Resolve display names so the audit log reads naturally
            // even after the user is renamed.
            const ownerLookup = await prisma.user.findMany({
                where: { id: { in: [existing.ownerId, data.ownerId].filter(Boolean) } },
                select: { id: true, name: true, email: true },
            });
            const labelFor = (id) => {
                const u = ownerLookup.find((x) => x.id === id);
                return u ? u.name || u.email || id : 'Unassigned';
            };
            await logActivityEvent({
                type: 'PROJECT_OWNER_CHANGED',
                actorId: req.user.id,
                projectId: project.id,
                fromValue: labelFor(existing.ownerId),
                toValue: labelFor(data.ownerId),
                message: project.name,
                meta: {
                    fromUserId: existing.ownerId,
                    toUserId: data.ownerId,
                },
            });
        }

        if (
            data.phase !== undefined &&
            (data.phase || null) !== (existing.phase || null)
        ) {
            const fromPhase = existing.phase || 'Unphased';
            const toPhase = data.phase || 'Unphased';
            await notify({
                recipientIds: involved,
                actorId: req.user.id,
                type: 'PROJECT_UPDATED',
                title: `${project.name}: phase changed`,
                body: `${req.user.email} moved the project from "${fromPhase}" to "${toPhase}".`,
                projectId: project.id,
            });
            await logActivityEvent({
                type: 'PROJECT_PHASE_CHANGED',
                actorId: req.user.id,
                projectId: project.id,
                fromValue: fromPhase,
                toValue: toPhase,
                message: project.name,
            });
        }

        // Billing-specific notifications. Fired separately from the
        // generic "project updated" so the body reads naturally and the
        // sidebar bell entry tells the participant exactly what changed.
        const fmtMoney = (a, c) =>
            a == null ? '—' : `${Number(a).toFixed(2)} ${c || 'EUR'}`;
        if (
            data.internalPaid !== undefined &&
            data.internalPaid !== existing.internalPaid
        ) {
            await notify({
                recipientIds: involved,
                actorId: req.user.id,
                type: 'PROJECT_UPDATED',
                title: `${project.name}: internal settlement ${
                    data.internalPaid ? 'marked paid' : 'reopened'
                }`,
                body: `${req.user.email} ${
                    data.internalPaid
                        ? 'recorded the internal settlement as paid'
                        : 'reopened the internal settlement'
                } (${fmtMoney(project.internalAmount, project.internalCurrency)}).`,
                projectId: project.id,
            });
            await logActivityEvent({
                type: 'PROJECT_PAYMENT_CHANGED',
                actorId: req.user.id,
                projectId: project.id,
                fromValue: existing.internalPaid ? 'paid' : 'unpaid',
                toValue: data.internalPaid ? 'paid' : 'unpaid',
                message: project.name,
                meta: {
                    kind: 'internal',
                    amount: project.internalAmount,
                    currency: project.internalCurrency,
                },
            });
        }
        if (
            data.clientPaid !== undefined &&
            data.clientPaid !== existing.clientPaid
        ) {
            await notify({
                recipientIds: involved,
                actorId: req.user.id,
                type: 'PROJECT_UPDATED',
                title: `${project.name}: client invoice ${
                    data.clientPaid ? 'marked paid' : 'reopened'
                }`,
                body: `${req.user.email} ${
                    data.clientPaid
                        ? 'recorded the client invoice as paid'
                        : 'reopened the client invoice'
                } (${fmtMoney(project.clientAmount, project.clientCurrency)}).`,
                projectId: project.id,
            });
            await logActivityEvent({
                type: 'PROJECT_PAYMENT_CHANGED',
                actorId: req.user.id,
                projectId: project.id,
                fromValue: existing.clientPaid ? 'paid' : 'unpaid',
                toValue: data.clientPaid ? 'paid' : 'unpaid',
                message: project.name,
                meta: {
                    kind: 'client',
                    amount: project.clientAmount,
                    currency: project.clientCurrency,
                },
            });
        }

        // Audit edits to the billing card (amounts, currencies, notes).
        // Paid flags are already covered above so we exclude them here.
        const billingChanged = changedFieldNames(
            existing,
            data,
            BILLING_FIELD_LABELS,
        );
        if (billingChanged.length > 0) {
            const labelList = billingChanged
                .map((f) => BILLING_FIELD_LABELS[f])
                .join(', ');
            const diff = Object.fromEntries(
                billingChanged.map((f) => [
                    f,
                    { from: existing[f] ?? null, to: data[f] ?? null },
                ]),
            );
            await logActivityEvent({
                type: 'PROJECT_BILLING_CHANGED',
                actorId: req.user.id,
                projectId: project.id,
                message: project.name,
                toValue: labelList,
                meta: { fields: billingChanged, diff },
            });
        }

        // Catch-all "details edited" event so people see name / dates /
        // description / label / etc. updates in the audit log too. We
        // skip it whenever a more specific event already fired.
        const detailFieldsChanged = changedFieldNames(
            existing,
            data,
            DETAIL_FIELD_LABELS,
        );
        if (detailFieldsChanged.length > 0) {
            const labelList = detailFieldsChanged
                .map((f) => DETAIL_FIELD_LABELS[f])
                .join(', ');
            await logActivityEvent({
                type: 'PROJECT_DETAILS_UPDATED',
                actorId: req.user.id,
                projectId: project.id,
                message: project.name,
                toValue: labelList,
                meta: { fields: detailFieldsChanged },
            });
        }

        // Generic "updated" only if nothing more specific fired and there
        // were actually edits to non-system fields.
        const onlySystemBumps =
            Object.keys(data).length === 0 ||
            (Object.keys(data).length === 1 && data.statusUpdatedAt);
        const phaseChanged =
            data.phase !== undefined &&
            (data.phase || null) !== (existing.phase || null);
        const billingOnlyFields = new Set([
            'internalAmount',
            'internalCurrency',
            'internalPaid',
            'clientAmount',
            'clientCurrency',
            'clientPaid',
            'billingNotes',
        ]);
        const otherFieldsTouched = Object.keys(data).some(
            (k) =>
                !['phase', 'status', 'ownerId'].includes(k) &&
                !billingOnlyFields.has(k),
        );
        if (
            !data.status &&
            data.ownerId === undefined &&
            !onlySystemBumps &&
            (!phaseChanged || otherFieldsTouched) &&
            otherFieldsTouched
        ) {
            // Spell out *which* fields were edited so the notification is
            // actionable instead of a generic "edited project details".
            // We list field names only (not values) — same set the audit
            // log records — so the recipient can see at a glance what the
            // editor touched.
            const changedLabels = [
                ...detailFieldsChanged.map((f) => DETAIL_FIELD_LABELS[f]),
                ...billingChanged.map((f) => BILLING_FIELD_LABELS[f]),
            ].filter(Boolean);
            const body = changedLabels.length
                ? `${req.user.email} edited ${changedLabels.join(', ')}.`
                : `${req.user.email} edited project details.`;
            await notify({
                recipientIds: involved,
                actorId: req.user.id,
                type: 'PROJECT_UPDATED',
                title: `${project.name} was updated`,
                body,
                projectId: project.id,
                meta: { fields: [...detailFieldsChanged, ...billingChanged] },
            });
        }

        res.json({ project: forList(project) });
    } catch (err) {
        next(err);
    }
});

// Deleting a project is admin-only.
router.delete('/:id', async (req, res, next) => {
    try {
        const existing = await requireProjectAdmin(req, req.params.id);

        // Snapshot recipients BEFORE the delete so we can still notify the
        // people who were on the project.
        const recipientIds = await projectParticipantIds(existing.id);

        // SOFT delete: stamp `deletedAt` instead of physically removing the
        // row. The project (and its tasks / time / notes) survive so the
        // deletion is fully reversible; every project read auto-excludes it
        // via the Prisma extension. Hard-deleting used to also cascade-wipe
        // the audit trail \u2014 soft-delete keeps it.
        await prisma.project.update({
            where: { id: existing.id },
            data: { deletedAt: new Date() },
        });

        // Audit-log the deletion so it shows in the Activity feed with an
        // "Undo/Restore" action. The project id lives in meta (mirroring
        // TASK_DELETED) because the row is now hidden from normal reads.
        await logActivityEvent({
            type: 'PROJECT_DELETED',
            actorId: req.user.id,
            projectId: existing.id,
            message: existing.name,
            meta: {
                deletedProjectId: existing.id,
                code: existing.code || null,
            },
        });

        await notify({
            recipientIds,
            actorId: req.user.id,
            type: 'PROJECT_DELETED',
            title: `Project deleted: ${existing.name}`,
            body: `${req.user.email} deleted this project.`,
        });

        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// Restore a soft-deleted project. Same permission as delete
// (admin / project:delete, or the personal-project owner). Mirrors the
// task restore endpoint: fetch through the soft-delete escape hatch, flip
// deletedAt back to NULL, audit + notify.
router.post('/:id/restore', async (req, res, next) => {
    try {
        const project = await prisma.project.findFirst({
            where: { id: req.params.id, deletedAt: { not: null } },
        });
        if (!project) {
            // Distinguish "never existed / hard gone" from "already live".
            const live = await prisma.project.findFirst({
                where: { id: req.params.id, deletedAt: undefined },
                select: { id: true, deletedAt: true },
            });
            if (live && !live.deletedAt) {
                throw httpError(409, 'That project is not deleted.');
            }
            throw httpError(404, 'Project not found.');
        }
        // Permission: personal-project owner, or admin / project:delete.
        if (project.isPersonal) {
            if (project.ownerId !== req.user.id) {
                throw httpError(404, 'Project not found.');
            }
        } else if (!isAdminOrHasCapability(req, CAPABILITIES.PROJECT_DELETE)) {
            throw httpError(
                403,
                'You do not have permission to restore projects',
            );
        }

        await prisma.project.update({
            // deletedAt: undefined opts out of the soft-delete filter so the
            // update can reach the hidden row and flip it back to live.
            where: { id: project.id, deletedAt: undefined },
            data: { deletedAt: null },
        });

        await logActivityEvent({
            type: 'PROJECT_RESTORED',
            actorId: req.user.id,
            projectId: project.id,
            message: project.name,
            meta: { restoredProjectId: project.id, code: project.code || null },
        });

        const recipientIds = await projectParticipantIds(project.id);
        await notify({
            recipientIds,
            actorId: req.user.id,
            type: 'PROJECT_RESTORED',
            title: `Project restored: ${project.name}`,
            body: `${req.user.email} restored this project.`,
            projectId: project.id,
            link: `/projects/${project.id}`,
        });

        res.json({ ok: true, project: { id: project.id } });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
