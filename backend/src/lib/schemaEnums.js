// Single source of truth for Prisma enum values at runtime.
//
// Why this file exists
// ====================
// We had two bugs in the past where a hand-mirrored array of allowed
// enum values silently fell out of sync with `schema.prisma` — the
// `ACTIVITY_EVENT_TYPE_VALUES` array in `routes/activities.js` for
// one, and a couple of capability key lists for another. Both were
// the kind of drift you only catch when a user reports "this dropdown
// is missing an option" or worse, when the API silently rejects a
// valid value.
//
// Prisma already generates a runtime JS object for every enum in
// `schema.prisma` and exposes it at the top of `@prisma/client` (and
// also under `$Enums`). Those generated objects ARE the right source
// of truth — they're produced by the same generator that builds the
// types the rest of the codebase uses. This module just re-exports
// them in a friendlier shape:
//
//   - `Enums.<EnumName>` -> the original `{ KEY: 'KEY', ... }` object
//   - `EnumValues.<EnumName>` -> a frozen array of the enum's string
//     values, sorted, ready to feed into a Zod `z.enum(...)` or a
//     `Set.has` membership check
//   - `isMemberOf(enumName, value)` -> boolean predicate
//   - `requireMemberOf(enumName, value, label)` -> throws a 400-style
//     error when `value` is not in the enum (used by validators)
//
// Drift checking
// ==============
// `backend/scripts/check-schema-enums.js` parses `schema.prisma`,
// extracts every enum declaration, and compares it against this
// module. If a new enum is added to the schema (or a value renamed)
// without a regenerated client, the script exits non-zero. Run it via
// `npm run test:check-enums` — also wired into the vitest suite so
// `npm test` catches drift too.

const client = require('@prisma/client');

// All enum NAMES we expect to find as runtime exports. Pulled out into
// a constant so the drift checker has a single point of truth instead
// of guessing from the export keys. Keep this list sorted to make
// review diffs readable.
const KNOWN_ENUMS = [
    'ActivityEventType',
    'ActivityKind',
    'ApplicationPhase',
    'ConversationType',
    'NotificationType',
    'ProjectLifecycle',
    'ProjectPriority',
    // ProjectStatus was removed: Project.status / ChangeRequest.status are
    // now free String columns (admin-managed custom statuses), so the enum
    // no longer exists in schema.prisma and Prisma won't export it. The
    // six built-in keys live in lib/projectStatuses.js instead.
    'ReassignmentStatus',
    'ReleaseCheckpointKind',
    'Role',
    'SprintCadence',
    'SprintStatus',
    'TaskPriority',
    'TaskStatus',
    'TimeEntrySource',
    'TodoPriority',
    'UserPinKind',
    'UserStatus',
];

const Enums = Object.freeze(
    KNOWN_ENUMS.reduce((acc, name) => {
        const live = client[name];
        if (!live || typeof live !== 'object') {
            // Hard failure at import time — we want the server to
            // refuse to boot rather than silently use a missing enum.
            throw new Error(
                `[schemaEnums] @prisma/client is missing runtime export "${name}". ` +
                    `Did you forget to run \`prisma generate\` after editing schema.prisma?`,
            );
        }
        acc[name] = Object.freeze({ ...live });
        return acc;
    }, {}),
);

const EnumValues = Object.freeze(
    Object.fromEntries(
        Object.entries(Enums).map(([name, obj]) => [
            name,
            Object.freeze(Object.values(obj).sort()),
        ]),
    ),
);

const EnumSets = Object.freeze(
    Object.fromEntries(
        Object.entries(EnumValues).map(([name, values]) => [
            name,
            new Set(values),
        ]),
    ),
);

function getEnum(enumName) {
    if (!Object.prototype.hasOwnProperty.call(Enums, enumName)) {
        throw new Error(`[schemaEnums] Unknown enum "${enumName}"`);
    }
    return Enums[enumName];
}

function getEnumValues(enumName) {
    if (!Object.prototype.hasOwnProperty.call(EnumValues, enumName)) {
        throw new Error(`[schemaEnums] Unknown enum "${enumName}"`);
    }
    return EnumValues[enumName];
}

function isMemberOf(enumName, value) {
    if (!Object.prototype.hasOwnProperty.call(EnumSets, enumName)) {
        throw new Error(`[schemaEnums] Unknown enum "${enumName}"`);
    }
    return EnumSets[enumName].has(value);
}

// Throw a 400-style error (the shape the existing error middleware
// expects — `status`, `expose`) when `value` is not in the named enum.
// `label` is the user-facing field name, e.g. "status".
function requireMemberOf(enumName, value, label = enumName) {
    if (!isMemberOf(enumName, value)) {
        const err = new Error(
            `Invalid ${label}: "${value}". Expected one of: ${EnumValues[
                enumName
            ].join(', ')}.`,
        );
        err.status = 400;
        err.expose = true;
        throw err;
    }
}

module.exports = {
    KNOWN_ENUMS,
    Enums,
    EnumValues,
    EnumSets,
    getEnum,
    getEnumValues,
    isMemberOf,
    requireMemberOf,
};
