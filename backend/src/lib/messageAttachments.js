// Sweeps chat message attachments that have outlived their 30-day TTL.
// Two halves:
//   1. `sweepExpiredAttachments` does the actual work — deletes the
//      disk file then drops the row. Safe to call at any time.
//   2. `startAttachmentSweeper` schedules it: once at boot (to clean up
//      anything that aged out while the server was down) then every
//      6 hours after that.
//
// We do hard deletes so a forgotten attachment can't be revived months
// later by a stale link. If you ever want a soft-delete grace window,
// gate the disk delete here and let downloads return 410.

const prisma = require('./prisma');
const { removeFileSafe } = require('./upload');

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function sweepExpiredAttachments() {
    const now = new Date();
    const expired = await prisma.messageAttachment.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true, fileUrl: true },
        take: 500,
    });
    if (expired.length === 0) return { removed: 0 };

    for (const a of expired) {
        try {
            removeFileSafe(a.fileUrl);
        } catch {
            // Best-effort — if the file is already gone or the path
            // is unparseable we still want to delete the row so it
            // doesn't keep being picked up by the next sweep.
        }
    }

    const result = await prisma.messageAttachment.deleteMany({
        where: { id: { in: expired.map((a) => a.id) } },
    });
    return { removed: result.count };
}

// Same idea for ticket attachments: image uploads carry an `expiresAt`
// (~2 months); non-image files have it NULL and are never swept here.
async function sweepExpiredTicketAttachments() {
    const now = new Date();
    const expired = await prisma.ticketAttachment.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true, url: true },
        take: 500,
    });
    if (expired.length === 0) return { removed: 0 };

    for (const a of expired) {
        try {
            removeFileSafe(a.url);
        } catch {
            /* best-effort disk cleanup */
        }
    }

    const result = await prisma.ticketAttachment.deleteMany({
        where: { id: { in: expired.map((a) => a.id) } },
    });
    return { removed: result.count };
}

async function runSweeps() {
    const [chat, ticket] = await Promise.all([
        sweepExpiredAttachments().catch((err) => {
            console.error('[attachments] chat sweep failed:', err);
            return { removed: 0 };
        }),
        sweepExpiredTicketAttachments().catch((err) => {
            console.error('[attachments] ticket sweep failed:', err);
            return { removed: 0 };
        }),
    ]);
    if (chat.removed) {
        console.log(
            `[attachments] removed ${chat.removed} expired chat attachment(s)`,
        );
    }
    if (ticket.removed) {
        console.log(
            `[attachments] removed ${ticket.removed} expired ticket image(s)`,
        );
    }
}

function startAttachmentSweeper() {
    // Initial run, slightly delayed so we don't block startup behind
    // an unrelated DB query.
    setTimeout(() => {
        runSweeps();
    }, 15 * 1000).unref?.();

    setInterval(() => {
        runSweeps();
    }, SWEEP_INTERVAL_MS).unref?.();
}

module.exports = {
    sweepExpiredAttachments,
    sweepExpiredTicketAttachments,
    startAttachmentSweeper,
};
