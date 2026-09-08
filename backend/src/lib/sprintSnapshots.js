// Daily "snapshot every ACTIVE sprint" scheduler.
//
// Mirrors the approach used by deadlineAlerts.startDeadlineSweepScheduler:
// fire once shortly after boot (so a fresh container has a baseline),
// then once every 24 hours. The actual snapshot logic lives in
// routes/sprints.js so the inline calls from /start and /close can
// reuse the same code — we just call into it on a timer here.
//
// Snapshots are cheap (one task scan + one timeEntry aggregate per
// ACTIVE sprint), and active-sprint count across the workspace is
// expected to stay low (typically <= 10), so we don't need rate
// limiting or batching.

const { snapshotAllActiveSprints } = require('../routes/sprints');

function startSprintSnapshotScheduler() {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    setTimeout(() => {
        snapshotAllActiveSprints().catch((err) =>
            console.error('[sprints] initial snapshot failed:', err),
        );
    }, 60 * 1000).unref?.();

    setInterval(() => {
        snapshotAllActiveSprints().catch((err) =>
            console.error('[sprints] daily snapshot failed:', err),
        );
    }, ONE_DAY_MS).unref?.();
}

module.exports = { startSprintSnapshotScheduler };
