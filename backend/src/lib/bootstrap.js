const prisma = require('./prisma');
const { backfillCodes } = require('./codes');

// Ensures there is at least one ACTIVE ADMIN in the system.
// Runs at server startup. If no admin exists yet (e.g. after the role column
// was just added), promote the oldest user and force them ACTIVE. Idempotent.
async function ensureAdmin() {
    const adminCount = await prisma.user.count({
        where: { role: 'ADMIN', status: 'ACTIVE' },
    });
    if (adminCount > 0) return;

    const oldest = await prisma.user.findFirst({
        orderBy: { createdAt: 'asc' },
    });
    if (!oldest) return;

    await prisma.user.update({
        where: { id: oldest.id },
        data: {
            role: 'ADMIN',
            status: 'ACTIVE',
            approvedAt: oldest.approvedAt || new Date(),
        },
    });
    console.log(`[bootstrap] promoted ${oldest.email} to ADMIN/ACTIVE`);
}

// One-time migration helper: any project that has zero rows in
// ProjectParticipant gets seeded with the historical "involved" set
// (owner + reporter + distinct task assignees + distinct note authors +
// distinct file uploaders). Idempotent — runs on every boot but does
// nothing for projects that already have participants.
async function backfillProjectParticipants() {
    const projects = await prisma.project.findMany({
        where: { participants: { none: {} } },
        select: { id: true, ownerId: true, reporterId: true },
    });
    if (projects.length === 0) return;

    let totalRows = 0;
    for (const p of projects) {
        const ids = new Set();
        if (p.ownerId) ids.add(p.ownerId);
        if (p.reporterId) ids.add(p.reporterId);

        const [tasks, notes, files] = await Promise.all([
            prisma.task.findMany({
                where: { projectId: p.id, assigneeId: { not: null } },
                select: { assigneeId: true },
                distinct: ['assigneeId'],
            }),
            prisma.note.findMany({
                where: { projectId: p.id },
                select: { authorId: true },
                distinct: ['authorId'],
            }),
            prisma.fileAttachment.findMany({
                where: { projectId: p.id },
                select: { uploaderId: true },
                distinct: ['uploaderId'],
            }),
        ]);
        for (const t of tasks) if (t.assigneeId) ids.add(t.assigneeId);
        for (const n of notes) if (n.authorId) ids.add(n.authorId);
        for (const f of files) if (f.uploaderId) ids.add(f.uploaderId);

        if (ids.size === 0) continue;
        const rows = Array.from(ids).map((userId) => ({
            projectId: p.id,
            userId,
        }));
        const created = await prisma.projectParticipant.createMany({
            data: rows,
            skipDuplicates: true,
        });
        totalRows += created.count;
    }
    console.log(
        `[bootstrap] backfilled ${totalRows} project participant rows across ${projects.length} project(s)`,
    );
}

// Seeds the admin-managed template tables on first run. Idempotent —
// only inserts rows when the table is empty so admins can later edit /
// delete the defaults without us re-creating them on every boot.
async function ensureDefaultTemplates() {
    const phaseCount = await prisma.phaseTemplate.count();
    if (phaseCount === 0) {
        const defaults = ['Kick-off', 'Planning', 'Implementation', 'Review', 'Closing'];
        await prisma.phaseTemplate.createMany({
            data: defaults.map((name, idx) => ({ name, order: idx })),
            skipDuplicates: true,
        });
        console.log(`[bootstrap] seeded ${defaults.length} phase templates`);
    }

    const priorityCount = await prisma.priorityOption.count();
    if (priorityCount === 0) {
        const defaults = [
            // Project priorities (4-tier matches the existing enum).
            { scope: 'PROJECT', key: 'LOW', label: 'Low', color: 'slate', order: 0 },
            { scope: 'PROJECT', key: 'MEDIUM', label: 'Medium', color: 'sky', order: 1 },
            { scope: 'PROJECT', key: 'HIGH', label: 'High', color: 'amber', order: 2 },
            { scope: 'PROJECT', key: 'URGENT', label: 'Urgent', color: 'rose', order: 3 },
            // Task priorities (3-tier matches the existing enum).
            { scope: 'TASK', key: 'LOW', label: 'Low', color: 'slate', order: 0 },
            { scope: 'TASK', key: 'MEDIUM', label: 'Medium', color: 'sky', order: 1 },
            { scope: 'TASK', key: 'HIGH', label: 'High', color: 'rose', order: 2 },
        ];
        await prisma.priorityOption.createMany({
            data: defaults,
            skipDuplicates: true,
        });
        console.log(`[bootstrap] seeded ${defaults.length} priority options`);
    }

    // StatusOption is the admin-managed display layer for ProjectStatus.
    // We backfill ONCE, when the table is empty — admin renames /
    // recolours / hides shouldn't get clobbered on every boot. CRs in
    // M2 share this same set (scope: PROJECT) by design. If we ever
    // add a new ProjectStatus enum value later, ship a one-off
    // ensureStatus() upsert instead of touching this block.
    const statusCount = await prisma.statusOption.count();
    if (statusCount === 0) {
        const defaults = [
            { scope: 'PROJECT', key: 'TODO',        label: 'To do',       color: 'slate',   order: 0 },
            { scope: 'PROJECT', key: 'IN_PROGRESS', label: 'In progress', color: 'sky',     order: 1 },
            { scope: 'PROJECT', key: 'CLIENT_TEST', label: 'Client test', color: 'violet',  order: 2 },
            { scope: 'PROJECT', key: 'BILLING',     label: 'Billing',     color: 'amber',   order: 3 },
            { scope: 'PROJECT', key: 'DONE',        label: 'Done',        color: 'emerald', order: 4 },
            { scope: 'PROJECT', key: 'ON_HOLD',     label: 'On hold',     color: 'rose',    order: 5 },
        ];
        await prisma.statusOption.createMany({
            data: defaults,
            skipDuplicates: true,
        });
        console.log(`[bootstrap] seeded ${defaults.length} status options`);
    }
}

// Stamps friendly codes (P25-USA-0001 / T-0001 / ST-0001) on any
// project / task / subtask that doesn't have one yet. Idempotent —
// the WHERE clause on `code: null` makes subsequent boots no-ops.
async function backfillEntityCodes() {
    await backfillCodes(prisma, { logger: console.log });
}

// Stamps `createdById` on legacy tasks that pre-date the column.
// Resolution order:
//   1. The TASK_CREATED ActivityEvent for that task (oldest one,
//      since a task may have been re-stamped after a restore).
//   2. The project's `ownerId` as the catch-all fallback so the
//      Plan view "by <name>" pill never reads "Unknown" purely
//      because we shipped the column late.
// Idempotent — the WHERE clause skips rows that already have a
// `createdById`, so subsequent boots are no-ops.
async function backfillTaskCreators() {
    const orphan = await prisma.task.findMany({
        where: { createdById: null, deletedAt: null },
        select: { id: true, projectId: true },
    });
    if (orphan.length === 0) return;

    let resolved = 0;
    for (const t of orphan) {
        let actorId = null;
        // 1) the original TASK_CREATED event (covers the common case
        //    where the task was created by a user back when the
        //    column didn't exist on the row but the event did).
        const ev = await prisma.activityEvent.findFirst({
            where: { type: 'TASK_CREATED', taskId: t.id },
            orderBy: { createdAt: 'asc' },
            select: { actorId: true },
        });
        if (ev?.actorId) {
            actorId = ev.actorId;
        } else {
            // 2) project owner — best-effort guess; better than
            //    leaving the pill as "Unknown".
            const project = await prisma.project.findUnique({
                where: { id: t.projectId },
                select: { ownerId: true },
            });
            if (project?.ownerId) actorId = project.ownerId;
        }
        if (!actorId) continue;
        await prisma.task.update({
            where: { id: t.id },
            data: { createdById: actorId },
        });
        resolved += 1;
    }
    console.log(
        `[bootstrap] backfilled createdById on ${resolved}/${orphan.length} task(s)`,
    );
}

// Copy colours from the phase template library onto project phases
// that share the same name but still have `color = null` (rows
// created before template colours existed, or before an admin
// picked a swatch). Idempotent — safe on every boot.
async function backfillPhaseColorsFromTemplates() {
    const templates = await prisma.phaseTemplate.findMany({
        where: { color: { not: null }, isActive: true },
        select: { name: true, color: true },
    });
    if (templates.length === 0) return;

    let total = 0;
    for (const tpl of templates) {
        const result = await prisma.phase.updateMany({
            where: { name: tpl.name, color: null },
            data: { color: tpl.color },
        });
        total += result.count;
    }
    if (total > 0) {
        console.log(
            `[bootstrap] backfilled phase colour on ${total} project phase(s) from templates`,
        );
    }
}

module.exports = {
    ensureAdmin,
    backfillProjectParticipants,
    ensureDefaultTemplates,
    backfillEntityCodes,
    backfillTaskCreators,
    backfillPhaseColorsFromTemplates,
};
