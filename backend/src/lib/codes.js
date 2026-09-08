// Human-friendly identifier codes for projects and tasks.
//
// Format:
//   Project:  P<YY>-<CCC>-<NNNN>      e.g. "P26-USA-0001"
//   Task:     T-<NNNN>                 e.g. "T-0042"
//   Subtask:  ST-<NNNN>                e.g. "ST-0007"
//
// Notes:
//   - Year = project's *creation* year (last two digits). Picked once
//     and never recomputed.
//   - Country slot = first three letters of the project's `country`
//     field, normalized (diacritics stripped, non-letters dropped),
//     uppercased, padded to 3. Falls back to "INT" when no country.
//   - Project sequence is scoped to (year, country): "P26-USA-0001"
//     is independent of "P26-DEU-0001".
//   - Task / subtask sequences are scoped to the project: each project
//     has its own T-0001..N counter and a separate ST-0001..N counter.
//   - Always pad to 4 digits. Above 9999 we stop padding rather than
//     misrepresent the number; codes still sort correctly.
//
// All public helpers are PURE (no DB writes) — they read existing
// rows to compute the next sequence and return a string. Callers
// store the result on the row.

const PROJECT_PREFIX = 'P';
const TASK_PREFIX = 'T';
const SUBTASK_PREFIX = 'ST';
const TICKET_PREFIX = 'TKT';
const COUNTRY_FALLBACK = 'INT';
// CRs are scoped to their parent project and sequence inside it. We
// pad the per-project counter to 3 digits — most projects will have
// far fewer CRs than tasks, and "P25-USA-0001-CR-001" reads better
// than "...CR-0001". Above 999 we stop padding (lexicographic order
// is still preserved). Codes are unique globally because the project
// prefix is included.
const CR_PREFIX = 'CR';
const CR_PAD = 3;
const PAD = 4;

function pad(n) {
    const s = String(n);
    return s.length >= PAD ? s : s.padStart(PAD, '0');
}

function countryToken(country) {
    if (!country) return COUNTRY_FALLBACK;
    const cleaned = String(country)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z]/g, '')
        .toUpperCase();
    if (!cleaned) return COUNTRY_FALLBACK;
    return cleaned.slice(0, 3).padEnd(3, 'X');
}

function yearToken(date) {
    const d = date ? new Date(date) : new Date();
    if (Number.isNaN(d.getTime())) return new Date().getFullYear() % 100;
    return d.getFullYear() % 100;
}

// Compute the next sequence number inside a (year, country) bucket.
// Reads every existing project code with the same prefix and bumps
// the highest numeric tail by one. New buckets start at 1.
async function nextProjectSequence(prisma, yyToken, countryTokenStr) {
    const yy = String(yyToken).padStart(2, '0');
    const prefix = `${PROJECT_PREFIX}${yy}-${countryTokenStr}-`;
    const rows = await prisma.project.findMany({
        // `deletedAt: undefined` opts out of the soft-delete read filter
        // in `lib/prisma.js` so the counter sees BOTH live and
        // soft-deleted project codes. Without it, a code freed up by a
        // soft-deleted project gets reused and collides with the still-
        // present (soft-deleted) row on the UNIQUE `code` constraint —
        // which made the code-stamp fail and left new projects codeless.
        where: { code: { startsWith: prefix }, deletedAt: undefined },
        select: { code: true },
    });
    let max = 0;
    for (const r of rows) {
        const tail = r.code?.slice(prefix.length);
        if (!tail) continue;
        const n = Number.parseInt(tail, 10);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
}

async function nextTaskSequence(prisma, projectId, prefix) {
    const rows = await prisma.task.findMany({
        // `deletedAt: undefined` opts out of the soft-delete read
        // filter in `lib/prisma.js` so the counter inspects BOTH
        // live and soft-deleted task codes. Otherwise restoring a
        // task whose code was reused after deletion would explode
        // on the (projectId, code) unique constraint.
        where: {
            projectId,
            code: { startsWith: `${prefix}-` },
            deletedAt: undefined,
        },
        select: { code: true },
    });
    let max = 0;
    for (const r of rows) {
        const tail = r.code?.slice(prefix.length + 1);
        if (!tail) continue;
        const n = Number.parseInt(tail, 10);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
}

// CR-scoped task sequence: scope is (changeRequestId, prefix). The
// prefix here is the *full* per-CR prefix (e.g.
// "P25-USA-0001-CR-001-T") not just "T", which is why we don't reuse
// nextTaskSequence — that one assumes (projectId, prefix) scoping
// and a short prefix.
async function nextCRTaskSequence(prisma, changeRequestId, fullPrefix) {
    const rows = await prisma.task.findMany({
        // Same opt-out as nextTaskSequence; codes must be globally
        // unique within the CR regardless of soft-delete state so a
        // restore never collides.
        where: {
            changeRequestId,
            code: { startsWith: `${fullPrefix}-` },
            deletedAt: undefined,
        },
        select: { code: true },
    });
    let max = 0;
    for (const r of rows) {
        const tail = r.code?.slice(fullPrefix.length + 1);
        if (!tail) continue;
        const n = Number.parseInt(tail, 10);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
}

// Public API ---------------------------------------------------------

// Ticket codes are GLOBAL (not per-project): `TKT-0001`, `TKT-0002`, …
// One running sequence across the whole workspace, so a code is
// unambiguous on its own. Reads the current max and bumps it.
async function generateTicketCode(prisma) {
    const prefix = `${TICKET_PREFIX}-`;
    const rows = await prisma.ticket.findMany({
        // `deletedAt: undefined` opts out of the soft-delete read filter so
        // the max-scan spans BOTH live and soft-deleted ticket codes.
        // Otherwise a code freed up by a soft delete would get reused and
        // then collide with the still-present ghost row on the UNIQUE
        // `code` constraint — and restoring that ghost would be impossible.
        where: { code: { startsWith: prefix }, deletedAt: undefined },
        select: { code: true },
    });
    let max = 0;
    for (const r of rows) {
        const tail = r.code?.slice(prefix.length);
        if (!tail) continue;
        const n = Number.parseInt(tail, 10);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return `${prefix}${pad(max + 1)}`;
}

async function generateProjectCode(prisma, { country, createdAt } = {}) {
    const yy = String(yearToken(createdAt)).padStart(2, '0');
    const cc = countryToken(country);
    const seq = await nextProjectSequence(prisma, yy, cc);
    return `${PROJECT_PREFIX}${yy}-${cc}-${pad(seq)}`;
}

async function generateTaskCode(
    prisma,
    { projectId, parentTaskId, changeRequestId } = {},
) {
    if (!projectId) return null;
    const isSubtask = Boolean(parentTaskId);
    const shortPrefix = isSubtask ? SUBTASK_PREFIX : TASK_PREFIX;

    // CR-scoped task: code shape "<CR_CODE>-T-001" /
    // "<CR_CODE>-ST-001". Counter is per (CR, prefix) so each CR
    // gets its own T-001, T-002... independent of the project's
    // top-level task counter. If for some reason the CR doesn't
    // have a stamped code yet (rare — backfill runs on boot), fall
    // back to the legacy project-scoped sequence so nothing crashes
    // and the row gets a code it can be searched on.
    if (changeRequestId) {
        const cr = await prisma.changeRequest.findUnique({
            where: { id: changeRequestId },
            select: { code: true },
        });
        if (cr?.code) {
            const fullPrefix = `${cr.code}-${shortPrefix}`;
            const seq = await nextCRTaskSequence(
                prisma,
                changeRequestId,
                fullPrefix,
            );
            const seqStr =
                String(seq).length >= CR_PAD
                    ? String(seq)
                    : String(seq).padStart(CR_PAD, '0');
            return `${fullPrefix}-${seqStr}`;
        }
    }

    const seq = await nextTaskSequence(prisma, projectId, shortPrefix);
    return `${shortPrefix}-${pad(seq)}`;
}

// CRs use the parent project's code as their stable prefix so the
// code reads "P25-USA-0001-CR-001" and remains unique globally
// (Project.code is itself unique). Falls back to "PROJ-<id6>-CR-001"
// for projects that haven't been stamped yet — backfillCodes runs on
// every boot so this is rare in practice.
function projectCodeBaseForCR(project) {
    if (project?.code) return project.code;
    if (project?.id) return `PROJ-${String(project.id).slice(0, 6).toUpperCase()}`;
    return 'PROJ-UNKNOWN';
}

async function nextCRSequence(prisma, projectId, basePrefix) {
    const prefix = `${basePrefix}-${CR_PREFIX}-`;
    const rows = await prisma.changeRequest.findMany({
        where: { projectId, code: { startsWith: prefix } },
        select: { code: true },
    });
    let max = 0;
    for (const r of rows) {
        const tail = r.code?.slice(prefix.length);
        if (!tail) continue;
        const n = Number.parseInt(tail, 10);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
}

async function generateChangeRequestCode(prisma, { projectId } = {}) {
    if (!projectId) return null;
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, code: true },
    });
    if (!project) return null;
    const base = projectCodeBaseForCR(project);
    const seq = await nextCRSequence(prisma, projectId, base);
    const seqStr =
        String(seq).length >= CR_PAD
            ? String(seq)
            : String(seq).padStart(CR_PAD, '0');
    return `${base}-${CR_PREFIX}-${seqStr}`;
}

// One-shot backfill helper: assign codes to any rows that don't have
// one yet. Idempotent — call it on every boot; once everything's
// stamped it's a no-op (the WHERE filters out non-null rows).
//
// Order matters: oldest rows first so they get the lowest sequence
// numbers in their bucket. Top-level tasks before subtasks so the
// numbering reads naturally when they're shown together.
async function backfillCodes(prisma, { logger } = {}) {
    const log = logger || (() => {});
    let projectN = 0;
    let taskN = 0;
    let subtaskN = 0;

    const projects = await prisma.project.findMany({
        where: { code: null },
        select: { id: true, country: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
    });
    for (const p of projects) {
        try {
            const code = await generateProjectCode(prisma, {
                country: p.country,
                createdAt: p.createdAt,
            });
            await prisma.project.update({
                where: { id: p.id },
                data: { code },
            });
            projectN++;
        } catch (err) {
            log(`[codes] backfill skipped project ${p.id}: ${err.message}`);
        }
    }

    const tasks = await prisma.task.findMany({
        // Backfill must reach soft-deleted rows too — otherwise a
        // legacy task that was soft-deleted before getting a code
        // would never get one even after being restored. Pass
        // `deletedAt: undefined` to opt out of the auto-filter.
        where: { code: null, parentTaskId: null, deletedAt: undefined },
        select: {
            id: true,
            projectId: true,
            changeRequestId: true,
        },
        orderBy: { createdAt: 'asc' },
    });
    for (const t of tasks) {
        try {
            const code = await generateTaskCode(prisma, {
                projectId: t.projectId,
                parentTaskId: null,
                changeRequestId: t.changeRequestId,
            });
            // `deletedAt: undefined` opts this update out of the
            // soft-delete client extension's write filter — without
            // it, soft-deleted ghost rows would silently fail to
            // get a code, defeating the whole point of fetching them
            // with `deletedAt: undefined` above.
            await prisma.task.update({
                where: { id: t.id, deletedAt: undefined },
                data: { code },
            });
            taskN++;
        } catch (err) {
            log(`[codes] backfill skipped task ${t.id}: ${err.message}`);
        }
    }

    const subtasks = await prisma.task.findMany({
        // Same opt-out reasoning as the parent-task backfill above —
        // soft-deleted legacy subtasks still need a stamped code so
        // they aren't broken if ever restored.
        where: {
            code: null,
            parentTaskId: { not: null },
            deletedAt: undefined,
        },
        select: {
            id: true,
            projectId: true,
            parentTaskId: true,
            changeRequestId: true,
        },
        orderBy: { createdAt: 'asc' },
    });
    for (const s of subtasks) {
        try {
            const code = await generateTaskCode(prisma, {
                projectId: s.projectId,
                parentTaskId: s.parentTaskId,
                changeRequestId: s.changeRequestId,
            });
            // Same opt-out as the parent backfill — see comment there.
            await prisma.task.update({
                where: { id: s.id, deletedAt: undefined },
                data: { code },
            });
            subtaskN++;
        } catch (err) {
            log(`[codes] backfill skipped subtask ${s.id}: ${err.message}`);
        }
    }

    if (projectN || taskN || subtaskN) {
        log(
            `[codes] backfill done: ${projectN} project(s), ${taskN} task(s), ${subtaskN} subtask(s)`,
        );
    }
}

module.exports = {
    generateProjectCode,
    generateTaskCode,
    generateChangeRequestCode,
    generateTicketCode,
    backfillCodes,
    countryToken,
};
