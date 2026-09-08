// Vitest config for the backend.
//
// Scope: PURE unit tests today (`backend/test/*.test.js`). These do
// NOT touch the live Postgres — every test that needs `prisma` uses
// `vi.mock('../src/lib/prisma', …)` so we can run the whole suite on
// a developer laptop without docker-compose up. When we add full
// integration tests later they'll live under `backend/test/integration/`
// and use a separate Postgres test schema; this config is ready to
// load them by widening `include` and pointing at a setup file.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.js'],
        // The backend source is CommonJS and uses plain `require()`
        // for inter-module loads (e.g. `require('./prisma')`). By
        // default vitest only intercepts `import` statements through
        // its plugin pipeline — bare `require()` calls in source
        // modules can bypass vitest's mock registry entirely, which
        // means `vi.mock(...)` in a test file has no effect on
        // dependencies loaded transitively via require. Adding the
        // whole `src/` tree to `server.deps.inline` forces vitest to
        // process those files through its loader, so the mocks
        // finally take effect.
        server: {
            deps: {
                inline: [/^.*\/src\//],
            },
        },
        // Globals enabled because the backend codebase is CommonJS
        // (`require()`-based) and Vitest 2.x explicitly refuses
        // `require('vitest')`. Enabling globals lets the test files
        // call `describe`/`it`/`expect`/`vi`/`beforeEach` without
        // any import, which works cleanly in CJS. The trade-off is
        // an editor's go-to-definition won't resolve the symbols
        // unless `@types/vitest`-style typings are made global —
        // negligible for our use case.
        globals: true,
        // `forks` (one process per file) is required because the
        // backend is CommonJS and vitest's `vi.mock(...)` only
        // intercepts the require cache when each test file runs in
        // its own process. The `threads` pool shares a single
        // require cache across files, which means a vi.mock in
        // file A can be defeated by a previous unmocked require in
        // file B. `forks` is also what gives `vi.hoisted` mocks
        // their guarantees that they apply BEFORE the source under
        // test is loaded.
        pool: 'forks',
        reporters: ['default'],
        // 5s/test is plenty for pure unit tests; anything slower is a
        // sign we're accidentally hitting the network / disk.
        testTimeout: 5000,
    },
});
