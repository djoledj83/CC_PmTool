#!/usr/bin/env node
// Schema-vs-runtime drift checker.
//
// Parses every `enum Foo { … }` block out of `prisma/schema.prisma` and
// compares it (name + ordered set of values) against the runtime enums
// exported by `@prisma/client`. If they don't match exactly the script
// prints a human-readable diff and exits with code 1 — perfect for
// wiring into CI or a pre-push hook.
//
// What this catches
// =================
//   1. A new enum value added to the schema but `prisma generate`
//      wasn't re-run → the runtime client doesn't know about it yet.
//   2. An enum value REMOVED from the schema but old code still
//      references the deleted key → the build keeps working until
//      someone hits the dead branch.
//   3. A new enum added to the schema without adding it to
//      `KNOWN_ENUMS` in `src/lib/schemaEnums.js` → calls to
//      `getEnum('NewThing')` would 500.
//   4. An enum renamed in the schema without an alias for the old
//      name (callers in JS land would silently look up undefined).
//
// Run via:
//
//   node scripts/check-schema-enums.js
//   # or
//   npm run test:check-enums
//
// Exits 0 on agreement, 1 on drift.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.resolve(__dirname, '..', 'prisma', 'schema.prisma');

function loadSchemaEnums() {
    const raw = fs.readFileSync(SCHEMA_PATH, 'utf8');
    // Strip `//` line comments BEFORE running the enum-block regex.
    // A stray `}` inside a comment (we hit this when the
    // SPRINT_BULK_DELETED docstring contained `status }, …]`) would
    // otherwise close the non-greedy `\{…\}` match prematurely and
    // we'd lose every enum value defined below the comment.
    //
    // We use `[^\r\n]*` instead of `.*` for CRLF safety — see
    // backend/test/schema-enums.test.js for the long explanation.
    const src = raw.replace(/\/\/[^\r\n]*/g, '');
    const enums = {};
    const blockRegex = /enum\s+(\w+)\s*\{([\s\S]*?)\}/g;
    let m;
    while ((m = blockRegex.exec(src))) {
        const name = m[1];
        const body = m[2]
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        const values = body
            .map((tok) => tok.replace(/[,]+$/, '').trim())
            .filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v));
        enums[name] = values.sort();
    }
    return enums;
}

function loadRuntimeEnums() {
    // Re-require the runtime client AND the schemaEnums helper so the
    // drift check exercises the same path the app uses.
    let helper;
    try {
        helper = require('../src/lib/schemaEnums');
    } catch (err) {
        console.error('Failed to load schemaEnums helper:', err.message);
        process.exit(2);
    }
    return { helper, values: helper.EnumValues };
}

function diff(schemaEnums, runtimeEnums) {
    const schemaNames = new Set(Object.keys(schemaEnums));
    const runtimeNames = new Set(Object.keys(runtimeEnums));

    const missingInRuntime = [...schemaNames].filter(
        (n) => !runtimeNames.has(n),
    );
    const missingInSchema = [...runtimeNames].filter(
        (n) => !schemaNames.has(n),
    );

    const valueDiffs = [];
    for (const name of schemaNames) {
        if (!runtimeNames.has(name)) continue;
        const a = schemaEnums[name];
        const b = runtimeEnums[name];
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
            valueDiffs.push({
                name,
                onlyInSchema: a.filter((v) => !b.includes(v)),
                onlyInRuntime: b.filter((v) => !a.includes(v)),
            });
        }
    }

    return { missingInRuntime, missingInSchema, valueDiffs };
}

function main() {
    const schemaEnums = loadSchemaEnums();
    const { helper, values: runtimeEnums } = loadRuntimeEnums();

    const result = diff(schemaEnums, runtimeEnums);

    const ok =
        result.missingInRuntime.length === 0 &&
        result.missingInSchema.length === 0 &&
        result.valueDiffs.length === 0;

    if (ok) {
        const count = Object.keys(schemaEnums).length;
        console.log(
            `[schemaEnums] OK: ${count} enums in schema.prisma match ` +
                `@prisma/client runtime and src/lib/schemaEnums.js`,
        );
        return 0;
    }

    console.error('[schemaEnums] DRIFT DETECTED:');
    if (result.missingInRuntime.length) {
        console.error(
            `  Enums in schema.prisma but NOT exported by @prisma/client:`,
        );
        for (const n of result.missingInRuntime) {
            console.error(`    - ${n}`);
        }
        console.error(
            `  -> run "npm run db:push" or "npm run db:migrate:dev" ` +
                `then "npx prisma generate" to rebuild the client.`,
        );
    }
    if (result.missingInSchema.length) {
        console.error(
            `  Enums in @prisma/client but NOT in schema.prisma (stale generated client):`,
        );
        for (const n of result.missingInSchema) {
            console.error(`    - ${n}`);
        }
        console.error(
            `  -> run "npx prisma generate" against the current schema.`,
        );
    }
    if (result.valueDiffs.length) {
        console.error(`  Enum value drift (per enum):`);
        for (const d of result.valueDiffs) {
            console.error(`    ${d.name}:`);
            if (d.onlyInSchema.length) {
                console.error(
                    `       only in schema.prisma : ${d.onlyInSchema.join(', ')}`,
                );
            }
            if (d.onlyInRuntime.length) {
                console.error(
                    `       only in runtime client: ${d.onlyInRuntime.join(', ')}`,
                );
            }
        }
        console.error(
            `  -> run "npx prisma generate" to refresh the client, then ` +
                `update src/lib/schemaEnums.js if the enum NAME list changed.`,
        );
    }

    // Also assert that every schema enum is named in the helper's
    // KNOWN_ENUMS list, so adding a brand-new enum can't slip past
    // unnoticed.
    const unlistedInHelper = Object.keys(schemaEnums).filter(
        (n) => !helper.KNOWN_ENUMS.includes(n),
    );
    if (unlistedInHelper.length) {
        console.error(
            `  Enums missing from KNOWN_ENUMS in src/lib/schemaEnums.js:`,
        );
        for (const n of unlistedInHelper) {
            console.error(`    - ${n}`);
        }
    }

    return 1;
}

process.exit(main());
