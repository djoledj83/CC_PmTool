// Daily "snapshot every ACTIVE planning sprint" scheduler.
//
// Planning analogue of lib/sprintSnapshots.js. The snapshot logic lives
// in routes/planningSprints.js (so the inline calls from /start and
// /close reuse the same code) — here we just call it on a timer: once
// shortly after boot for a fresh baseline, then once every 24 hours.

const {
    snapshotAllActivePlanningSprints,
} = require('../routes/planningSprints');

function startPlanningSprintSnapshotScheduler() {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    setTimeout(() => {
        snapshotAllActivePlanningSprints().catch((err) =>
            console.error(
                '[planningSprints] initial snapshot failed:',
                err,
            ),
        );
    }, 70 * 1000).unref?.();

    setInterval(() => {
        snapshotAllActivePlanningSprints().catch((err) =>
            console.error('[planningSprints] daily snapshot failed:', err),
        );
    }, ONE_DAY_MS).unref?.();
}

module.exports = { startPlanningSprintSnapshotScheduler };
