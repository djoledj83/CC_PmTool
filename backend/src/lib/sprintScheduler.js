// Per-project sprint scheduler.
//
// Two responsibilities:
//
//   1. `materializeNextSprints(scheduleId)` — given one schedule, ensure
//      its project has at least `lookahead` future PLANNED sprints on
//      the timeline. Used both by the manual "Generate next" API call
//      and by the background sweep.
//
//   2. `runScheduledGenerators()` — loop over every enabled schedule
//      and call materializeNextSprints on each. Cheap (one tiny query
//      per project) so we can comfortably run it hourly.
//
// Date math:
//   The user picks a cadence (WEEKLY / BIWEEKLY / MONTHLY) and an
//   anchor date. The generator walks forward from the latest existing
//   sprint's endDate (or the anchorDate if no sprints exist yet),
//   appending contiguous `[start, end)` windows in cadence-sized
//   steps. WEEKLY = +7 days, BIWEEKLY = +14, MONTHLY = +1 calendar
//   month. All start/end dates are UTC-midnight so they line up with
//   the rest of the sprint module's day-bucket math.
//
// Safety:
//   - PLANNED sprints created by the user (with custom dates) are
//     respected: the cursor walks from the latest endDate regardless of
//     who created it, so manual sprints just shift the cadence forward.
//   - Duplicate names raise P2002. We swallow + bump the counter +
//     retry (up to 5 attempts) so the generator never gets stuck on a
//     name clash.
//   - The schedule's nextNumber + lastGeneratedAt are only persisted
//     after we successfully create at least one sprint, so a partial
//     failure leaves the schedule re-runnable.

const prisma = require('./prisma');
const { logActivityEvent } = require('./activityLog');

// Cadence step in days (calendar-aware for MONTHLY). Returns a NEW Date
// so the caller doesn't have to clone.
//
// MONTHLY note: naive `setUTCMonth(m + 1)` on Jan 31 rolls over into
// March 3 because Feb 31 doesn't exist. We clamp to the last day of
// the destination month instead so anchor-on-31st schedules produce
// Jan 31 → Feb 28 → Mar 31 → Apr 30 → … (intuitive end-of-month
// behaviour).
function advanceByCadence(start, cadence) {
    const next = new Date(start.getTime());
    if (cadence === 'DAILY') {
        next.setUTCDate(next.getUTCDate() + 1);
    } else if (cadence === 'WEEKLY') {
        next.setUTCDate(next.getUTCDate() + 7);
    } else if (cadence === 'BIWEEKLY') {
        next.setUTCDate(next.getUTCDate() + 14);
    } else if (cadence === 'MONTHLY') {
        const targetDay = next.getUTCDate();
        next.setUTCDate(1);
        next.setUTCMonth(next.getUTCMonth() + 1);
        const lastDay = new Date(
            Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
        ).getUTCDate();
        next.setUTCDate(Math.min(targetDay, lastDay));
    } else {
        // Unknown cadence — default to +14 so we never produce a
        // zero-length window that would break the DB constraint.
        next.setUTCDate(next.getUTCDate() + 14);
    }
    return next;
}

// Find the first slot-start at or after `floorTs`, walking forward
// from `anchor` in cadence-sized steps. This is what keeps weekly
// schedules locked to (say) Wednesday no matter where the previous
// sprint actually ended — the anchor's weekday / day-of-month is
// preserved across the whole infinite series of slots.
function firstSlotAtOrAfter(anchor, cadence, floorTs) {
    let cursor = new Date(anchor.getTime());
    cursor.setUTCHours(0, 0, 0, 0);
    // Safety ceiling — 5000 cadence steps is ~96 years for weekly
    // and ~416 years for monthly. We should never actually hit it.
    let guard = 0;
    while (cursor.getTime() < floorTs && guard < 5000) {
        cursor = advanceByCadence(cursor, cadence);
        guard += 1;
    }
    return cursor;
}

// Default duration (informational; we no longer use it for the cadence
// step but still expose it on the schedule for the UI).
function defaultDurationDays(cadence) {
    if (cadence === 'DAILY') return 1;
    if (cadence === 'WEEKLY') return 7;
    if (cadence === 'BIWEEKLY') return 14;
    if (cadence === 'MONTHLY') return 30;
    return 14;
}

// Render a sprint name from the pattern. Supports {n}, {start}, {end},
// {month}, {year}. Any unknown {token} is left as-is so future tokens
// don't silently break existing schedules.
function renderName(pattern, { n, startDate, endDate }) {
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    const iso = (d) =>
        d
            ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
            : '';
    const monthName = (d) =>
        d
            ? d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
            : '';
    const year = (d) => (d ? String(d.getUTCFullYear()) : '');
    return String(pattern || 'Sprint {n}')
        .replace(/\{n\}/g, String(n))
        .replace(/\{start\}/g, iso(start))
        .replace(/\{end\}/g, iso(end))
        .replace(/\{month\}/g, monthName(start))
        .replace(/\{year\}/g, year(start));
}

// Lookup the latest sprint in a project (any status), so the cursor
// picks up from the most recent endDate. ACTIVE / CLOSED sprints
// participate too — that's the whole point of the contiguous cadence.
async function latestSprintForProject(projectId) {
    return prisma.sprint.findFirst({
        where: { projectId },
        orderBy: [{ endDate: 'desc' }],
        select: { id: true, endDate: true, name: true },
    });
}

// Count of PLANNED sprints starting at or after `cursorTs`. The "future
// PLANNED" window is what `lookahead` caps — past PLANNED sprints (e.g.
// a sprint that was scheduled but never started) don't count, so the
// generator can still extend the runway.
async function countFuturePlanned(projectId, cursorTs) {
    return prisma.sprint.count({
        where: {
            projectId,
            status: 'PLANNED',
            endDate: { gt: new Date(cursorTs) },
        },
    });
}

// Walk forward from the schedule's anchor in cadence-sized steps,
// creating PLANNED sprints until the project has `lookahead` future
// PLANNED sprints in front of "now". Returns the list of created
// sprint rows.
//
// Why anchor-based (not "previous endDate")?
//   Anchor-based generation guarantees every sprint starts on the
//   weekday / day-of-month the user picked. A weekly schedule
//   anchored on Wednesday will always produce Wed→Wed sprints, no
//   matter what dates the existing sprints happen to land on. This
//   matches what users expect when they say "biweekly starting
//   Tuesday" — the cadence is locked to a calendar slot, not a
//   sliding pointer.
//
//   The latest existing sprint's endDate is still consulted, but only
//   as a "don't overlap" floor: we skip past it to the next anchor-
//   aligned slot. This means a manual sprint with funky dates can
//   leave a gap before the next generated one — that's the cost of
//   keeping cadence honest.
async function materializeNextSprints(scheduleId) {
    const schedule = await prisma.sprintSchedule.findUnique({
        where: { id: scheduleId },
        include: {
            project: { select: { id: true, name: true } },
        },
    });
    if (!schedule) return { created: [], schedule: null };
    if (!schedule.enabled) return { created: [], schedule };

    const latest = await latestSprintForProject(schedule.projectId);
    const nowTs = Date.now();
    // If we already have enough future planned sprints, nothing to do.
    const futurePlanned = await countFuturePlanned(schedule.projectId, nowTs);
    if (futurePlanned >= schedule.lookahead) {
        return { created: [], schedule };
    }

    // The cursor is the first anchor-aligned slot that's >= the latest
    // sprint's endDate (so we never overlap) AND >= today (so we
    // never backfill old sprints when the anchor is in the past).
    const latestEndTs = latest ? new Date(latest.endDate).getTime() : 0;
    const floorTs = Math.max(latestEndTs, nowTs);
    const anchor = new Date(schedule.anchorDate);
    anchor.setUTCHours(0, 0, 0, 0);
    let cursor = firstSlotAtOrAfter(anchor, schedule.cadence, floorTs);

    let counter = Math.max(1, schedule.nextNumber || 1);
    let needed = schedule.lookahead - futurePlanned;
    const created = [];
    // Hard safety ceiling so a bad pattern can't loop forever.
    const HARD_MAX = Math.max(1, Math.min(20, schedule.lookahead + 2));
    let attemptsThisLoop = 0;
    while (needed > 0 && attemptsThisLoop < HARD_MAX) {
        attemptsThisLoop += 1;
        const startDate = new Date(cursor.getTime());
        const endDate = advanceByCadence(startDate, schedule.cadence);
        // Try up to 5 names — bump {n} on each P2002 collision.
        let inserted = null;
        for (let bumps = 0; bumps < 5 && !inserted; bumps += 1) {
            const candidateNumber = counter + bumps;
            const name = renderName(schedule.namePattern, {
                n: candidateNumber,
                startDate,
                endDate,
            });
            try {
                inserted = await prisma.sprint.create({
                    data: {
                        projectId: schedule.projectId,
                        name,
                        startDate,
                        endDate,
                        status: 'PLANNED',
                        createdById: schedule.createdById,
                    },
                });
                counter = candidateNumber + 1;
            } catch (err) {
                if (err?.code === 'P2002') {
                    // Duplicate (projectId, name) — try the next number.
                    continue;
                }
                throw err;
            }
        }
        if (!inserted) {
            console.warn(
                `[sprintScheduler] could not find a unique name for project ${schedule.projectId} after 5 tries — aborting this run`,
            );
            break;
        }
        created.push(inserted);
        cursor = endDate;
        needed -= 1;
    }

    if (created.length > 0) {
        await prisma.sprintSchedule.update({
            where: { id: schedule.id },
            data: {
                nextNumber: counter,
                lastGeneratedAt: new Date(),
            },
        });
        // Emit one combined activity event so the feed isn't flooded
        // when several sprints get generated in the same run.
        try {
            await logActivityEvent({
                type: 'SPRINT_SCHEDULE_AUTO_RUN',
                actorId: null, // background actor
                projectId: schedule.projectId,
                meta: {
                    scheduleId: schedule.id,
                    cadence: schedule.cadence,
                    generated: created.map((s) => ({
                        sprintId: s.id,
                        sprintName: s.name,
                        startDate: s.startDate,
                        endDate: s.endDate,
                    })),
                },
            });
        } catch (err) {
            console.warn(
                '[sprintScheduler] failed to log auto-run activity:',
                err.message,
            );
        }
    }

    return { created, schedule };
}

// Loop over every enabled schedule and try to materialize. Errors on
// one project don't stop the others; each project's failure is logged
// and we move on.
async function runScheduledGenerators() {
    try {
        const schedules = await prisma.sprintSchedule.findMany({
            where: { enabled: true },
            select: { id: true, projectId: true },
        });
        let totalCreated = 0;
        for (const s of schedules) {
            try {
                const { created } = await materializeNextSprints(s.id);
                totalCreated += created.length;
            } catch (err) {
                console.warn(
                    `[sprintScheduler] generation failed for project ${s.projectId}:`,
                    err.message,
                );
            }
        }
        if (totalCreated > 0) {
            console.log(
                `[sprintScheduler] generated ${totalCreated} sprint(s) across ${schedules.length} schedule(s)`,
            );
        }
    } catch (err) {
        console.warn('[sprintScheduler] sweep failed:', err.message);
    }
}

// Start a periodic background sweep. We fire 90 seconds after boot so a
// fresh container can immediately materialise missing sprints, and then
// every hour. The hourly cadence is fine even for daily cadences —
// being a few minutes late never matters here, and idempotency means
// extra runs are no-ops.
function startSprintScheduleRunner() {
    const HOUR_MS = 60 * 60 * 1000;
    setTimeout(() => {
        runScheduledGenerators().catch((err) =>
            console.error('[sprintScheduler] initial run failed:', err),
        );
    }, 90 * 1000).unref?.();
    setInterval(() => {
        runScheduledGenerators().catch((err) =>
            console.error('[sprintScheduler] hourly run failed:', err),
        );
    }, HOUR_MS).unref?.();
}

// Pure helper exposed for the API endpoints (preview without writing).
// Mirrors the cursor-picking rule used by materializeNextSprints so
// the dialog preview is exactly what the generator will produce: walk
// from the anchor in cadence-sized steps, skip past any existing
// latest-end / today floor, then emit `n` consecutive slots.
function previewNextSprints(config, latestEndDate, n) {
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
    materializeNextSprints,
    runScheduledGenerators,
    startSprintScheduleRunner,
    previewNextSprints,
    advanceByCadence,
    defaultDurationDays,
    renderName,
};
