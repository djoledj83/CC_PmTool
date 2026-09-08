// Schema-enum mirror tests + drift check.
//
// The actual heavy-lifting lives in `scripts/check-schema-enums.js` —
// these tests run that same diff inline so `npm test` catches enum
// drift the moment it lands. They also exercise the helper surface
// (`isMemberOf`, `requireMemberOf`, `getEnumValues`) we expose to
// validators.

// describe/it/expect come from vitest globals.

const fs = require('node:fs');
const path = require('node:path');

const {
    KNOWN_ENUMS,
    Enums,
    EnumValues,
    EnumSets,
    getEnum,
    getEnumValues,
    isMemberOf,
    requireMemberOf,
} = require('../src/lib/schemaEnums');

function loadSchemaEnums() {
    const raw = fs.readFileSync(
        path.resolve(__dirname, '..', 'prisma', 'schema.prisma'),
        'utf8',
    );
    // Strip `//` line comments BEFORE running the enum-block regex.
    // Without this, a stray `}` character inside a comment (e.g. the
    // SPRINT_BULK_DELETED docstring "status }, …]") would prematurely
    // terminate the non-greedy `\{([\s\S]*?)\}` match, dropping
    // every enum value declared after the comment.
    //
    // We deliberately use `[^\r\n]*` instead of `.*` because the
    // schema file is checked in with CRLF line endings on Windows.
    // `.` doesn't match `\r`, so `.*$` won't reach the `\r` (which
    // sits before the line terminator); the comment stays intact.
    // `[^\r\n]*` walks up to (but not over) the next line break on
    // both LF and CRLF files.
    const src = raw.replace(/\/\/[^\r\n]*/g, '');
    const enums = {};
    const blockRegex = /enum\s+(\w+)\s*\{([\s\S]*?)\}/g;
    let m;
    while ((m = blockRegex.exec(src))) {
        const body = m[2]
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        const values = body
            .map((tok) => tok.replace(/[,]+$/, '').trim())
            .filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v));
        enums[m[1]] = values.sort();
    }
    return enums;
}

describe('schema enum mirror', () => {
    it('every enum in schema.prisma is in KNOWN_ENUMS', () => {
        const schemaEnums = Object.keys(loadSchemaEnums());
        const missing = schemaEnums.filter((n) => !KNOWN_ENUMS.includes(n));
        expect(
            missing,
            `Enums in schema.prisma but missing from src/lib/schemaEnums.js: ${missing.join(', ')}`,
        ).toEqual([]);
    });

    it('every name in KNOWN_ENUMS exists in schema.prisma', () => {
        const schemaEnums = Object.keys(loadSchemaEnums());
        const stale = KNOWN_ENUMS.filter((n) => !schemaEnums.includes(n));
        expect(
            stale,
            `Names in KNOWN_ENUMS but missing from schema.prisma: ${stale.join(', ')}`,
        ).toEqual([]);
    });

    it('runtime EnumValues match the schema (no value drift)', () => {
        const schemaEnums = loadSchemaEnums();
        for (const [name, schemaValues] of Object.entries(schemaEnums)) {
            const runtimeValues = EnumValues[name];
            expect(
                runtimeValues,
                `Enum ${name} is missing from EnumValues`,
            ).toBeDefined();
            expect(
                [...runtimeValues].sort(),
                `Enum ${name} drifted between schema.prisma and @prisma/client. ` +
                    `Run \`npx prisma generate\` to refresh the client.`,
            ).toEqual(schemaValues);
        }
    });

    it('Enum values are frozen (no accidental runtime mutation)', () => {
        expect(Object.isFrozen(Enums)).toBe(true);
        expect(Object.isFrozen(EnumValues)).toBe(true);
        for (const name of KNOWN_ENUMS) {
            expect(Object.isFrozen(Enums[name])).toBe(true);
            expect(Object.isFrozen(EnumValues[name])).toBe(true);
        }
    });

    it('EnumSets supports O(1) membership checks', () => {
        // Sanity: the set's size matches the array's length.
        for (const name of KNOWN_ENUMS) {
            expect(EnumSets[name].size).toBe(EnumValues[name].length);
        }
    });
});

describe('schema enum helpers', () => {
    it('getEnum returns the same object as Enums[name]', () => {
        expect(getEnum('Role')).toBe(Enums.Role);
    });

    it('getEnum throws on an unknown name', () => {
        expect(() => getEnum('Nonexistent')).toThrow(/Unknown enum/);
    });

    it('getEnumValues returns the frozen value array', () => {
        const values = getEnumValues('TaskStatus');
        expect(Object.isFrozen(values)).toBe(true);
        expect(values).toContain('DONE');
    });

    it('isMemberOf accepts valid values and rejects invalid ones', () => {
        expect(isMemberOf('Role', 'ADMIN')).toBe(true);
        expect(isMemberOf('Role', 'USER')).toBe(true);
        expect(isMemberOf('Role', 'GOD_MODE')).toBe(false);
        expect(isMemberOf('Role', null)).toBe(false);
        expect(isMemberOf('Role', undefined)).toBe(false);
    });

    it('requireMemberOf passes silently for valid values', () => {
        expect(() => requireMemberOf('Role', 'ADMIN')).not.toThrow();
    });

    it('requireMemberOf throws a 400-shaped error for invalid values', () => {
        try {
            requireMemberOf('Role', 'CHAOS_AGENT', 'role');
            throw new Error('expected requireMemberOf to throw');
        } catch (err) {
            expect(err.status).toBe(400);
            expect(err.expose).toBe(true);
            // The error copy must list the allowed values so a misbehaving
            // client knows how to retry.
            expect(err.message).toMatch(/role/);
            expect(err.message).toMatch(/CHAOS_AGENT/);
            expect(err.message).toMatch(/ADMIN/);
        }
    });

    it('Role enum carries the four roles the app actually uses', () => {
        // Spot-check one enum to make sure the mirror really agrees
        // with the schema for a key model.
        expect(new Set(EnumValues.Role)).toEqual(
            new Set(['ADMIN', 'MANAGER', 'APP_MODERATOR', 'USER']),
        );
    });

    it('ActivityEventType includes the recently-added TASK_RESTORED', () => {
        // Regression guard: TASK_RESTORED was added when we built the
        // restore feature. If a future schema edit removes it the test
        // catches it before the activity log silently stops attributing
        // restores.
        expect(EnumSets.ActivityEventType.has('TASK_RESTORED')).toBe(true);
        expect(EnumSets.ActivityEventType.has('TASK_DELETED')).toBe(true);
    });
});
