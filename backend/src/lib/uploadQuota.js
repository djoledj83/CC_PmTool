// Per-user upload quota.
//
// We meter "project file" uploads (the `/api/files` endpoint) against
// a rolling per-user byte total stored on `User.uploadedBytesTotal`.
// Avatars and app logos are excluded — they're capped per-file (5MB
// and 3MB respectively), users only ever hold one of each, and they
// double as visual identity so making them quota-bearing creates
// weird UX (a user can't change their picture because the catalog
// they manage went over budget).
//
// Why a counter instead of `SUM(size)` on every upload? A single
// indexed lookup beats scanning the entire FileAttachment table
// on every POST — on a busy install that table grows to millions
// of rows. The counter is updated INSIDE the same Prisma
// transaction that creates / deletes the FileAttachment, so the
// two can never drift unless the DB itself was corrupted. We also
// expose a one-off `recomputeQuota(userId)` helper as a recovery
// path if drift is ever suspected (admin tools / cron).

const prisma = require('./prisma');

// 2 GiB default — generous enough for typical usage (hundreds of
// PDFs / docs / images) without a single bad actor filling the
// Contabo disk. Override via env (USER_UPLOAD_QUOTA_BYTES) when the
// install scales up. Set the env to `0` to disable the cap
// entirely (returns Infinity from the resolver below).
const DEFAULT_QUOTA_BYTES = 2n * 1024n * 1024n * 1024n;

function resolveQuotaBytes() {
    const raw = process.env.USER_UPLOAD_QUOTA_BYTES;
    if (raw === undefined || raw === '') return DEFAULT_QUOTA_BYTES;
    if (raw === '0') return null; // disabled
    try {
        const parsed = BigInt(raw);
        if (parsed < 0n) {
            console.warn(
                `[uploadQuota] Ignoring negative USER_UPLOAD_QUOTA_BYTES=${raw}, using default ${DEFAULT_QUOTA_BYTES}`,
            );
            return DEFAULT_QUOTA_BYTES;
        }
        return parsed;
    } catch (err) {
        console.warn(
            `[uploadQuota] Ignoring invalid USER_UPLOAD_QUOTA_BYTES=${raw} (${err.message}), using default`,
        );
        return DEFAULT_QUOTA_BYTES;
    }
}

// Returns the user's current usage in bytes (as BigInt). Admins are
// not exempt — the counter still ticks for them too, but the cap
// check via `assertWithinQuota` skips them so they can keep working
// when the quota is hit (e.g. uploading recovery data).
async function getUsage(userId) {
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { uploadedBytesTotal: true },
    });
    if (!row) return 0n;
    return row.uploadedBytesTotal;
}

// Throws a 413 (Payload Too Large) error if accepting `incomingBytes`
// would push the user over the quota. Admin role bypasses the check
// so we don't paint ourselves into a corner where the admin can't
// delete a file they need to delete because the workspace is full.
async function assertWithinQuota({ user, incomingBytes }) {
    if (!user || !user.id) {
        const err = new Error('Not authenticated');
        err.status = 401;
        err.expose = true;
        throw err;
    }
    // Admins bypass — same reasoning as we apply elsewhere ("don't
    // lock the person who is supposed to be cleaning up the mess
    // out of the cleanup tool").
    if (user.role === 'ADMIN') return;
    const quota = resolveQuotaBytes();
    if (quota === null) return; // disabled
    const incoming = BigInt(Math.max(0, Math.floor(Number(incomingBytes) || 0)));
    const usage = await getUsage(user.id);
    if (usage + incoming > quota) {
        const remaining = usage > quota ? 0n : quota - usage;
        const err = new Error(
            `Upload would exceed your storage quota. ` +
                `You're using ${formatBytes(usage)} of ${formatBytes(quota)}; ` +
                `this upload is ${formatBytes(incoming)}. ` +
                `Remaining: ${formatBytes(remaining)}. ` +
                `Ask an admin to clean up older attachments or to raise the per-user limit.`,
        );
        err.status = 413;
        err.expose = true;
        throw err;
    }
}

// Format a BigInt byte count to a human-readable string. Matches the
// convention the rest of the app uses for file sizes (KB / MB / GB,
// 2 decimal places when sub-100). `bigint`-safe (Numbers can lose
// precision above 2^53).
function formatBytes(value) {
    const n = typeof value === 'bigint' ? value : BigInt(value);
    if (n < 1024n) return `${n.toString()} B`;
    const asNumber = Number(n);
    const k = 1024;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = asNumber / k;
    let i = 0;
    while (v >= k && i < units.length - 1) {
        v /= k;
        i++;
    }
    return `${v.toFixed(v < 100 ? 2 : 1)} ${units[i]}`;
}

// Atomically bump the user's running total. Caller passes the live
// `tx` so the increment commits/rolls back with the FileAttachment
// row in the same transaction.
async function incrementUsage(tx, userId, bytes) {
    if (!userId || !bytes || bytes <= 0) return;
    await tx.user.update({
        where: { id: userId },
        data: { uploadedBytesTotal: { increment: BigInt(bytes) } },
    });
}

// Inverse of incrementUsage — decrements on delete. Clamps to zero so
// a counter drift can never go negative.
async function decrementUsage(tx, userId, bytes) {
    if (!userId || !bytes || bytes <= 0) return;
    const row = await tx.user.findUnique({
        where: { id: userId },
        select: { uploadedBytesTotal: true },
    });
    if (!row) return;
    const next =
        row.uploadedBytesTotal > BigInt(bytes)
            ? row.uploadedBytesTotal - BigInt(bytes)
            : 0n;
    await tx.user.update({
        where: { id: userId },
        data: { uploadedBytesTotal: next },
    });
}

// One-shot recovery: walks the FileAttachment table and rewrites
// every user's `uploadedBytesTotal` from scratch. Use sparingly —
// scans the whole table — but invaluable if the counter ever drifts
// (concurrent test scripts, manual SQL surgery, …).
async function recomputeForUser(userId) {
    const agg = await prisma.fileAttachment.aggregate({
        where: { uploaderId: userId },
        _sum: { size: true },
    });
    const total = BigInt(agg._sum.size || 0);
    await prisma.user.update({
        where: { id: userId },
        data: { uploadedBytesTotal: total },
    });
    return total;
}

module.exports = {
    resolveQuotaBytes,
    getUsage,
    assertWithinQuota,
    incrementUsage,
    decrementUsage,
    recomputeForUser,
    formatBytes,
};
