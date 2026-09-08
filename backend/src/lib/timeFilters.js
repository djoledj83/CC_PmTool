// Shared query helpers for time-entry listing, stats, and CSV export.

const prisma = require('./prisma');
const { httpError } = require('../middleware/error');
const {
    isAdmin,
    accessibleProjectIds,
    assertProjectRead,
    hasCapability,
    CAPABILITIES,
} = require('./permissions');

/**
 * Narrow `where.projectId` to projects matching optional client /
 * application FK filters. Admin-only — non-admins get 403 if they
 * pass either param.
 *
 * @param {object} where  Prisma TimeEntry where clause (mutated)
 * @param {object} query  req.query
 * @param {import('express').Request} req
 */
async function applyClientApplicationProjectFilter(where, query, req) {
    const clientId = query.clientId ? String(query.clientId) : null;
    const applicationId = query.applicationId
        ? String(query.applicationId)
        : null;
    if (!clientId && !applicationId) return where;
    if (!isAdmin(req)) {
        throw httpError(
            403,
            'Only admins can filter by client or application',
        );
    }

    const projectWhere = {};
    if (clientId) projectWhere.clientId = clientId;
    if (applicationId) projectWhere.applicationId = applicationId;

    const matchIds = (
        await prisma.project.findMany({
            where: projectWhere,
            select: { id: true },
        })
    ).map((p) => p.id);

    const setEmpty = () => {
        where.projectId = { in: [] };
        return where;
    };

    if (matchIds.length === 0) return setEmpty();

    if (typeof where.projectId === 'string') {
        if (!matchIds.includes(where.projectId)) return setEmpty();
        return where;
    }

    if (where.projectId?.in) {
        const inter = where.projectId.in.filter((id) => matchIds.includes(id));
        if (inter.length === 0) return setEmpty();
        where.projectId = inter.length === 1 ? inter[0] : { in: inter };
        return where;
    }

    where.projectId =
        matchIds.length === 1 ? matchIds[0] : { in: matchIds };
    return where;
}

/**
 * After client/application filters, normalise project read scope.
 * Client/application filters set `where.projectId` to `{ in: [...] }`,
 * which must NOT be passed to `assertProjectRead` (expects a string id).
 *
 * @returns {boolean} true when the scope is empty — caller should return
 *   zero rows without hitting the database again.
 */
async function finalizeTimeEntryProjectScope(where, req, options = {}) {
    const canSeeAll =
        options.canSeeAll ??
        (isAdmin(req) || hasCapability(req, CAPABILITIES.TIME_VIEW_ALL));

    if (typeof where.projectId === 'string') {
        await assertProjectRead(req, where.projectId);
        return false;
    }

    if (where.projectId?.in) {
        if (where.projectId.in.length === 0) return true;
        if (canSeeAll) return false;
        const ids = await accessibleProjectIds(req);
        const inter = where.projectId.in.filter((id) => ids.includes(id));
        if (inter.length === 0) {
            where.projectId = { in: [] };
            return true;
        }
        where.projectId = inter.length === 1 ? inter[0] : { in: inter };
        return false;
    }

    if (canSeeAll) return false;

    const ids = await accessibleProjectIds(req);
    if (ids.length === 0) return true;
    where.projectId = ids.length === 1 ? ids[0] : { in: ids };
    return false;
}

module.exports = {
    applyClientApplicationProjectFilter,
    finalizeTimeEntryProjectScope,
};
