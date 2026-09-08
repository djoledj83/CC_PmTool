// Validation for the (now free-string) project / change-request status.
//
// Project.status and ChangeRequest.status used to be a Prisma enum. They
// are now plain strings driven by the admin-managed StatusOption table
// (scope PROJECT), so admins can define fully custom workflow states. To
// avoid persisting garbage we still validate an incoming status against
// the set of ACCEPTABLE keys: the six built-in ProjectStatus keys plus
// every key currently defined in StatusOption (scope PROJECT) — active
// or not, so a status that was just deactivated can still be read/edited
// out of, and historical rows never fail validation.
const prisma = require('./prisma');
const { httpError } = require('../middleware/error');

// The six built-in project status keys. These used to be a Prisma enum
// (ProjectStatus) but the column is now a free String so admins can add
// custom statuses. These keys still carry special code semantics
// (DONE = complete, ON_HOLD, CLIENT_TEST + BILLING) and are always
// acceptable even if an admin deletes their StatusOption rows — code
// still emits them (sprint close → DONE, etc.).
const BUILTIN = new Set([
    'TODO',
    'IN_PROGRESS',
    'CLIENT_TEST',
    'BILLING',
    'DONE',
    'ON_HOLD',
]);

async function acceptableProjectStatusKeys() {
    const rows = await prisma.statusOption.findMany({
        where: { scope: 'PROJECT' },
        select: { key: true },
    });
    const set = new Set(BUILTIN);
    for (const r of rows) set.add(r.key);
    return set;
}

// Throws 400 when `status` isn't an acceptable key. Skips when status is
// undefined (partial update that doesn't touch status).
async function assertValidProjectStatus(status) {
    if (status === undefined || status === null) return;
    const keys = await acceptableProjectStatusKeys();
    if (!keys.has(status)) {
        throw httpError(
            400,
            `Invalid status: "${status}". Add it under Templates → Statuses first.`,
        );
    }
}

module.exports = { assertValidProjectStatus, acceptableProjectStatusKeys };
