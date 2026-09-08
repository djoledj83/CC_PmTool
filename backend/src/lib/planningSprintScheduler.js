// Planning-sprint scheduler (cross-project, per-team).
//
// The planning analogue of lib/sprintScheduler.js. Where that keeps a
// runway of PLANNED sprints per PROJECT, this keeps a runway of PLANNED
// PlanningSprints per TEAM (or one org-wide series when teamId is null).
//
// It reuses the same cadence + naming math as the project scheduler
// (advanceByCadence / renderName / defaultDurationDays) so DAILY /
// WEEKLY / BIWEEKLY / MONTHLY behaviour and the {n}/{start}/{end}/
// {month}/{year} tokens are identical across both schedulers.
//
// Responsibilities:
//   1. materializeNextPlanningSprints(scheduleId) — ensure the team has
//      at least `lookahead` future PLANNED planning sprints.
//   2. runPlanningScheduleGenerators() — sweep every enabled schedule.
//   3. startPlanningScheduleRunner() — periodic background sweep.
//   4. previewNextPlanningSprints(config, latestEndDate, n) — pure
//      preview for the settings dialog.

const prisma = require('./prisma');
const { logActivityEvent } = require('./activityLog');
const {
    advanceByCadence,
    renderName,
    defaultDurationDays,
} = require('./sprintScheduler');

// Find the first slot-start at or after `floorTs`, walking forward from
// `anchor` in cadence-sized steps. Keeps the series locked to the
// anchor's weekday / day-of-month. (Local copy — sprintScheduler keeps
// its own private version.)
function firstSlotAtOrAfter(anchor, cadence, floorTs) {
    let cursor = new Date(anchor.getTime());
    cursor.setUTCHours(0, 0, 0, 0);
    let guard = 0;
    while (cursor.getTime() < floorTs && guard < 5000) {
        cursor = advanceByCadence(cursor, cadence);
        guard += 1;
    }
    return cursor;
}

// The latest planning sprint for a team (any status) so the cursor picks
// up from the most recent endDate. `teamId` may be null (org-wide).
async function latestPlanningSprintForTeam(teamId) {
    return prisma.planningSprint.findFirst({
        where: { teamId: teamId ?? null },
        orderBy: [{ endDate: 'desc' }],
        select: { id: true, endDate: true, name: true },
    });
}

// Count of PLANNED planning sprints (for this team) ending after
// `cursorTs`. This is what `lookahead` caps.
async function countFuturePlanned(teamId, cursorTs) {
    return prisma.planningSprint.count({
        where: {
            teamId: teamId ?? null,
            status: 'PLANNED',
            endDate: { gt: new Date(cursorTs) },
        },
    });
}

// Walk forward from the schedule's anchor in cadence-sized steps,
// creating PLANNED planning sprints until the team has `lookahead`
// future PLANNED ones in front of "now". Returns the created rows.
async function materializeNextPlanningSprints(scheduleId) {
    const schedule = await prisma.planningSprintSchedule.findUnique({
        where: { id: scheduleId },
        include: { team: { select: { id: true, name: true } } },
    });
    if (!schedule) return { created: [], schedule: null };
    if (!schedule.enabled) return { created: [], schedule };

    const latest = await latestPlanningSprintForTeam(schedule.teamId);
    const nowTs = Date.now();
    const futurePlanned = await countFuturePlanned(schedule.teamId, nowTs);
    if (futurePlanned >= schedule.lookahead) {
        return { created: [], schedule };
    }

    const latestEndTs = latest ? new Date(latest.endDate).getTime() : 0;
    const floorTs = Math.max(latestEndTs, nowTs);
    const anchor = new Date(schedule.anchorDate);
    anchor.setUTCHours(0, 0, 0, 0);
    let cursor = firstSlotAtOrAfter(anchor, schedule.cadence, floorTs);

    let counter = Math.max(1, schedule.nextNumber || 1);
    let needed = schedule.lookahead - futurePlanned;
    const created = [];
    const HARD_MAX = Math.max(1, Math.min(20, schedule.lookahead + 2));
    let attemptsThisLoop = 0;
    while (needed > 0 && attemptsThisLoop < HARD_MAX) {
        attemptsThisLoop += 1;
        const startDate = new Date(cursor.getTime());
        const endDate = advanceByCadence(startDate, schedule.cadence);
        const name = renderName(schedule.namePattern, {
            n: counter,
            startDate,
            endDate,
        });
        // Planning sprints have no unique-name constraint, so a plain
        // create is enough — no P2002 retry loop needed.
        const inserted = await prisma.planningSprint.create({
            data: {
                name,
                goal: schedule.goal || null,
                teamId: schedule.teamId || null,
                startDate,
                endDate,
                status: 'PLANNED',
                createdById: schedule.createdById,
            },
        });
        created.push(inserted);
        counter += 1;
        cursor = endDate;
        needed -= 1;
    }

    if (created.length > 0) {
        await prisma.planningSprintSchedule.update({
            where: { id: schedule.id },
            data: { nextNumber: counter, lastGeneratedAt: new Date() },
        });
        try {
            await logActivityEvent({
                type: 'PLANNING_SPRINT_SCHEDULE_AUTO_RUN',
                actorId: null,
                meta: {
                    scheduleId: schedule.id,
                    teamId: schedule.teamId || null,
                    teamName: schedule.team?.name || null,
                    cadence: schedule.cadence,
                    generated: created.map((s) => ({
                        planningSprintId: s.id,
                        name: s.name,
                        startDate: s.startDate,
                        endDate: s.endDate,
                    })),
                },
            });
        } catch (err) {
            console.warn(
                '[planningSprintScheduler] failed to log auto-run activity:',
                err.message,
            );
        }
    }

    return { created, schedule };
}

// Loop over every enabled planning schedule and try to materialize.
async function runPlanningScheduleGenerators() {
    try {
        const schedules = await prisma.planningSprintSchedule.findMany({
            where: { enabled: true },
            select: { id: true, teamId: true },
        });
        let totalCreated = 0;
        for (const s of schedules) {
            try {
                const { created } = await materializeNextPlanningSprints(s.id);
                totalCreated += created.length;
            } catch (err) {
                console.warn(
                    `[planningSprintScheduler] generation failed for team ${
                        s.teamId || 'org-wide'
                    }:`,
                    err.message,
                );
            }
        }
        if (totalCreated > 0) {
            console.log(
                `[planningSprintScheduler] generated ${totalCreated} planning sprint(s) across ${schedules.length} schedule(s)`,
            );
        }
    } catch (err) {
        console.warn('[planningSprintScheduler] sweep failed:', err.message);
    }
}

// Periodic background sweep — fires 90s after boot, then hourly. Hourly
// is fine even for DAILY cadence (idempotent; being minutes late never
// matters).
function startPlanningScheduleRunner() {
    const HOUR_MS = 60 * 60 * 1000;
    setTimeout(() => {
        runPlanningScheduleGenerators().catch((err) =>
            console.error(
                '[planningSprintScheduler] initial run failed:',
                err,
            ),
        );
    }, 95 * 1000).unref?.();
    setInterval(() => {
        runPlanningScheduleGenerators().catch((err) =>
            console.error('[planningSprintScheduler] hourly run failed:', err),
        );
    }, HOUR_MS).unref?.();
}

// Pure preview for the settings dialog — mirrors the cursor rule used by
// materializeNextPlanningSprints.
function previewNextPlanningSprints(config, latestEndDate, n) {
    const anchor = new Date(config.anchorDate);
    anchor.setUTCHours(0, 0, 0, 0);
    const nowTs = Date.now();
    const latestEndTs = latestEndDate ? new Date(latestEndDate).getTime() : 0;
    const floorTs = Math.max(latestEndTs, nowTs);
    let cursor = firstSlotAtOrAfter(anchor, config.cadence, floorTs);
    const out = [];
    let counter = Math.max(1, config.nextNumber || 1);
    for (let i = 0; i < Math.max(0, Math.min(10, n || 0)); i += 1) {
        const startDate = new Date(cursor.getTime());
        const endDate = advanceByCadence(startDate, config.cadence);
        const name = renderName(config.namePattern, {
            n: counter,
            startDate,
            endDate,
        });
        out.push({ name, startDate, endDate });
        cursor = endDate;
        counter += 1;
    }
    return out;
}

module.exports = {
    materializeNextPlanningSprints,
    runPlanningScheduleGenerators,
    startPlanningScheduleRunner,
    previewNextPlanningSprints,
    defaultDurationDays,
};
