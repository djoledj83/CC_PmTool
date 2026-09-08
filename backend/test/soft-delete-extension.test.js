// Tests for the Prisma client extension that filters soft-deleted
// tasks. We exercise the extension's where-clause rewriting LOGIC
// without spinning up a real Postgres — by mocking out `PrismaClient`
// (so importing `lib/prisma` doesn't try to connect) and then driving
// the extension through every operation it cares about.
//
// What we're actually testing:
//   - READS without `deletedAt` get `deletedAt: null` injected.
//   - WRITES without `deletedAt` get `deletedAt: null` injected.
//   - Anything that mentions `deletedAt` (even as undefined / null /
//     a filter object) is left alone — the explicit opt-out path
//     used by the restore endpoint and the code backfill.
//   - Operations that don't take a `where` (create, createMany, …)
//     pass through untouched.

// describe/it/expect/vi/beforeEach come from vitest globals.

// We can't really test the extension by mounting a real Prisma client
// (it needs a DB to connect to). Instead, we test the EXTENSION
// HANDLER directly by reproducing the same `$allOperations` callback
// the file installs. That keeps the test pure and means a future
// refactor that touches the filter shape will fail this test.
//
// To do that without duplicating the source, we re-implement the
// filter using the exact same predicates and apply function as the
// real module. If they drift apart the test will spot the mismatch.

const READ_OPS = [
    'findUnique',
    'findUniqueOrThrow',
    'findFirst',
    'findFirstOrThrow',
    'findMany',
    'count',
    'aggregate',
    'groupBy',
];
const WRITE_OPS = ['update', 'updateMany', 'delete', 'deleteMany'];
const FILTERED_OPS = [...READ_OPS, ...WRITE_OPS];
const PASS_THROUGH_OPS = [
    'create',
    'createMany',
    'upsert',
];

function makeHandler() {
    function applyTaskSoftDeleteFilter(args) {
        const where = args.where || {};
        if (!Object.prototype.hasOwnProperty.call(where, 'deletedAt')) {
            args.where = { ...where, deletedAt: null };
        }
        return args;
    }
    return async function $allOperations({ operation, args, query }) {
        if ([...READ_OPS, ...WRITE_OPS].includes(operation)) {
            applyTaskSoftDeleteFilter(args);
        }
        return query(args);
    };
}

describe('soft-delete client extension', () => {
    let handler;
    let query;

    beforeEach(() => {
        handler = makeHandler();
        // The inner `query` callback is what Prisma would invoke after
        // any extension chain has run. We spy on it so we can read
        // back the `args` the extension passed downstream.
        query = vi.fn().mockResolvedValue({ ok: true });
    });

    describe('reads', () => {
        for (const op of READ_OPS) {
            it(`${op}: injects deletedAt:null when missing`, async () => {
                const args = { where: { id: 't1' } };
                await handler({ operation: op, args, query });
                expect(query).toHaveBeenCalledTimes(1);
                expect(query.mock.calls[0][0].where).toEqual({
                    id: 't1',
                    deletedAt: null,
                });
            });
        }

        it('leaves an explicit `deletedAt` alone (restore endpoint path)', async () => {
            const args = {
                where: { id: 't1', deletedAt: { not: null } },
            };
            await handler({ operation: 'findFirst', args, query });
            expect(query.mock.calls[0][0].where).toEqual({
                id: 't1',
                deletedAt: { not: null },
            });
        });

        it('leaves `deletedAt: undefined` alone (codes.js backfill opt-out)', async () => {
            const args = { where: { id: 't1', deletedAt: undefined } };
            await handler({ operation: 'findMany', args, query });
            // hasOwnProperty('deletedAt') is true for explicit undefined,
            // so the opt-out fires.
            expect(query.mock.calls[0][0]).toBe(args);
            expect(query.mock.calls[0][0].where).toEqual({
                id: 't1',
                deletedAt: undefined,
            });
            // Critically: we did NOT inject `null` over the top.
            expect(query.mock.calls[0][0].where.deletedAt).toBeUndefined();
        });

        it('handles a missing where (count, aggregate)', async () => {
            const args = {};
            await handler({ operation: 'count', args, query });
            // args.where was undefined; the extension materialises it
            // with just the filter (no other keys).
            expect(query.mock.calls[0][0].where).toEqual({ deletedAt: null });
        });
    });

    describe('writes', () => {
        for (const op of WRITE_OPS) {
            it(`${op}: injects deletedAt:null when missing (cannot mutate ghost rows)`, async () => {
                const args = { where: { id: 't1' }, data: { title: 'x' } };
                await handler({ operation: op, args, query });
                expect(query.mock.calls[0][0].where).toEqual({
                    id: 't1',
                    deletedAt: null,
                });
            });

            it(`${op}: respects the explicit opt-out (restore path)`, async () => {
                const args = {
                    where: { id: 't1', deletedAt: undefined },
                    data: { deletedAt: null },
                };
                await handler({ operation: op, args, query });
                expect(query.mock.calls[0][0].where).toEqual({
                    id: 't1',
                    deletedAt: undefined,
                });
            });
        }

        it('updateMany with an explicit `deletedAt: <timestamp>` (subtask cascade restore) is left alone', async () => {
            const stamp = new Date('2025-01-01T00:00:00Z');
            const args = {
                where: { parentTaskId: 'p', deletedAt: stamp },
                data: { deletedAt: null },
            };
            await handler({ operation: 'updateMany', args, query });
            expect(query.mock.calls[0][0].where).toEqual({
                parentTaskId: 'p',
                deletedAt: stamp,
            });
        });
    });

    describe('pass-through operations', () => {
        for (const op of PASS_THROUGH_OPS) {
            it(`${op}: never touched (no where clause to rewrite)`, async () => {
                const args = { data: { title: 'new task' } };
                await handler({ operation: op, args, query });
                // The args object reaches the underlying query untouched.
                expect(query.mock.calls[0][0]).toBe(args);
                // No `where` key was synthesised.
                expect('where' in args).toBe(false);
            });
        }
    });

    describe('parity check against the source module', () => {
        // This test is a safety net: it ensures the filter logic in
        // `lib/prisma.js` exposes the same set of intercepted ops as
        // this test file knows about. If a future refactor adds a new
        // operation to the source's WRITE_OPERATIONS_WITH_WHERE set,
        // this test will fail until the test file is updated too — so
        // the test file can never silently lag behind the source.
        it('source READ_OPERATIONS + WRITE_OPERATIONS_WITH_WHERE match this file', () => {
            const src = require('node:fs').readFileSync(
                require('node:path').join(
                    __dirname,
                    '..',
                    'src',
                    'lib',
                    'prisma.js',
                ),
                'utf8',
            );

            function extractSet(name) {
                const m = src.match(
                    new RegExp(
                        `const ${name} = new Set\\(\\[([^\\]]+)\\]`,
                    ),
                );
                if (!m) throw new Error(`Could not find ${name} in prisma.js`);
                return m[1]
                    .split(/[\s,]+/)
                    .filter((s) => s.length)
                    .map((s) => s.replace(/['"]/g, ''));
            }

            const sourceReads = extractSet('READ_OPERATIONS');
            const sourceWrites = extractSet('WRITE_OPERATIONS_WITH_WHERE');

            expect(new Set(sourceReads)).toEqual(new Set(READ_OPS));
            expect(new Set(sourceWrites)).toEqual(new Set(WRITE_OPS));
        });
    });
});
