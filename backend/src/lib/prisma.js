// Prisma client singleton.
//
// We extend the base client with a *soft-delete filter* on the Task
// model so deleted rows never leak into ordinary reads OR get mutated
// by ordinary writes. The DELETE endpoint for tasks now marks
// `deletedAt` instead of physically removing the row; the Activity log
// surfaces a "Restore" affordance that flips the timestamp back to NULL.
//
// Why a client extension instead of editing every query? There are
// ~40 `prisma.task.findX` call sites across the routes / lib folder
// plus a handful of nested `include: { tasks: ... }` reads and a
// growing number of bulk updates (`updateMany`, `deleteMany`). A
// centralised filter is the only sane way to guarantee deleted rows
// stay hidden AND that future bulk writes can't silently mutate them.
// Nested includes (project.findUnique({ include: { tasks: ... } }))
// still need a manual `where: { deletedAt: null }` because the
// extension cannot rewrite include arguments — those are touched
// in-place at the call sites.
//
// Escape hatch: if a caller wants to LOOK AT or MODIFY deleted rows
// (the restore endpoint), it passes `where.deletedAt` explicitly.
// The extension only injects the filter when `deletedAt` is absent
// from `where` entirely, so `{ where: { id, deletedAt: { not: null } } }`
// reaches the soft-deleted row as intended.

const { PrismaClient } = require('@prisma/client');

// Read operations that accept a `where` clause and should be
// auto-filtered. These all return live rows, never including ghosts.
const READ_OPERATIONS = new Set([
    'findUnique',
    'findUniqueOrThrow',
    'findFirst',
    'findFirstOrThrow',
    'findMany',
    'count',
    'aggregate',
    'groupBy',
]);

// Write operations that accept a `where` clause and could otherwise
// silently mutate soft-deleted rows. Two scenarios this guards against:
//   1. `prisma.task.updateMany({ where: { projectId } , data: { ... } })`
//      — would otherwise update both live AND ghost rows.
//   2. `prisma.task.update({ where: { id } })` on a soft-deleted row
//      — would otherwise resurrect the row's data unintentionally.
// `upsert` is intentionally NOT in this list: it has a `create` branch
// that doesn't take a where filter, and Prisma's upsert semantics for
// soft-deleted rows are subtle — handle those explicitly at call sites
// (you almost never want upsert on a soft-deleted model anyway).
const WRITE_OPERATIONS_WITH_WHERE = new Set([
    'update',
    'updateMany',
    'delete',
    'deleteMany',
]);

const base = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

// Inject `deletedAt: null` into a where clause unless the caller has
// already mentioned `deletedAt` (even as undefined / null / a filter
// object). hasOwnProperty (not === undefined) is the right check
// because Prisma treats explicit undefined as "no filter on this
// field" — perfectly compatible with the escape hatch.
function applyTaskSoftDeleteFilter(args) {
    const where = args.where || {};
    if (!Object.prototype.hasOwnProperty.call(where, 'deletedAt')) {
        args.where = { ...where, deletedAt: null };
    }
    return args;
}

// Shared handler so Task and Project get identical soft-delete behaviour.
async function softDeleteAllOperations({ operation, args, query }) {
    if (READ_OPERATIONS.has(operation)) {
        applyTaskSoftDeleteFilter(args);
    }
    if (WRITE_OPERATIONS_WITH_WHERE.has(operation)) {
        applyTaskSoftDeleteFilter(args);
    }
    return query(args);
}

const prisma = base.$extends({
    name: 'taskSoftDelete',
    query: {
        // Projects use the same soft-delete filter as tasks: deleting a
        // project stamps `deletedAt` (auditable + restorable) and every
        // read auto-excludes it. The restore endpoint opts out with an
        // explicit `deletedAt: { not: null }`.
        project: {
            async $allOperations(ctx) {
                return softDeleteAllOperations(ctx);
            },
        },
        // Tickets soft-delete the same way: deleting stamps `deletedAt`
        // (restorable from the activity feed) and every read auto-excludes
        // it. The restore endpoint opts out with `deletedAt: { not: null }`,
        // and the ticket-code generator opts out with `deletedAt: undefined`
        // so a soft-deleted code isn't reused (unique `code` constraint).
        ticket: {
            async $allOperations(ctx) {
                return softDeleteAllOperations(ctx);
            },
        },
        task: {
            async $allOperations({ operation, args, query }) {
                // READS: filter ghost rows out so they never appear in
                // findUnique / findMany / count / etc.
                if (READ_OPERATIONS.has(operation)) {
                    // Two important escape-hatch code paths:
                    //   - the restore endpoint passes
                    //     `deletedAt: { not: null }` to find rows
                    //     that the regular reads can't see;
                    //   - the task-code generator passes
                    //     `deletedAt: undefined` so it scans BOTH
                    //     live and soft-deleted rows when picking
                    //     the next "T-NNN" number — without that,
                    //     restoring a task whose code was reused
                    //     after deletion would fail the unique
                    //     (projectId, code) constraint.
                    applyTaskSoftDeleteFilter(args);
                }
                // WRITES with a `where` clause: same filter. Stops a
                // future bulk `prisma.task.updateMany({ where: { … } })`
                // from accidentally mutating ghost rows, AND stops a
                // routine `update({ where: { id } })` from quietly
                // patching a soft-deleted row's columns. The restore
                // endpoint explicitly passes `deletedAt: { not: null }`
                // to bypass this when it flips the timestamp back to
                // NULL — same opt-out as the read path.
                if (WRITE_OPERATIONS_WITH_WHERE.has(operation)) {
                    applyTaskSoftDeleteFilter(args);
                }
                return query(args);
            },
        },
    },
});

// Test-only escape hatch. The default export below is the extended
// Prisma client. Tests that need to swap in a stub call
// `__setTestClient(stub)` BEFORE requiring the modules under test;
// `__resetTestClient()` puts it back. Production code never calls
// either. Keeping the swap behind explicit functions (rather than a
// settable property) means a stray write from anywhere outside a
// test will be obvious in code review.
let activeClient = prisma;
function __setTestClient(stub) {
    if (process.env.NODE_ENV !== 'test') {
        throw new Error(
            '[prisma] __setTestClient is only callable when NODE_ENV=test',
        );
    }
    activeClient = stub;
}
function __resetTestClient() {
    activeClient = prisma;
}

// Public surface: callers do `const prisma = require('./prisma')` and
// get back a Proxy that forwards every property access to whichever
// client is active. Production: forwards to the extended client.
// Tests: forwards to whatever stub the test installed first.
//
// The Proxy is intentionally minimal — only the `get` trap is needed
// because Prisma client API surface is "namespace.method(args)". No
// proxy magic on set / has / etc.
const facade = new Proxy(
    {},
    {
        get(_target, key) {
            if (key === '__setTestClient') return __setTestClient;
            if (key === '__resetTestClient') return __resetTestClient;
            return activeClient[key];
        },
    },
);

module.exports = facade;
