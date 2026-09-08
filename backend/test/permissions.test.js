// Pure unit tests for the permission ladder.
//
// These cover the synchronous helpers in `src/lib/permissions.js` —
// the ones that run on every request and decide whether a user can do
// X. They do NOT hit the database; the helpers under test (`isAdmin`,
// `hasCapability`, `effectiveCapabilities`, `requireAdminRole`, the
// `isAdminOr*` family) only look at `req.user`.
//
// The async helpers that touch Prisma (`assertProjectRead`,
// `assertProjectWritable`, `accessibleProjectIds`) live in a separate
// file (`permissions-project-access.test.js`) so we can isolate the
// Prisma mock.

// Globals (describe / it / expect) come from vitest.config.mjs
// (`globals: true`) — see the comment there for why.

const {
    CAPABILITIES,
    ROLE_DEFAULT_CAPABILITIES,
    isAdmin,
    isManager,
    isAppModerator,
    isAdminOrManager,
    requireAdminRole,
    requireAdminOrManagerRole,
    hasCapability,
    requireCapability,
    isAdminOrHasCapability,
    isAdminOrManagerOrHasCapability,
    effectiveCapabilities,
} = require('../src/lib/permissions');

const mkReq = (user) => ({ user });
const mkUser = (role, overrides = []) => ({
    id: 'u-test',
    role,
    capabilities: overrides,
});

describe('role predicates', () => {
    it('identifies ADMIN', () => {
        expect(isAdmin(mkReq(mkUser('ADMIN')))).toBe(true);
        expect(isAdmin(mkReq(mkUser('MANAGER')))).toBe(false);
        expect(isAdmin(mkReq(mkUser('USER')))).toBe(false);
        expect(isAdmin(mkReq(null))).toBe(false);
        expect(isAdmin({})).toBe(false);
    });

    it('identifies MANAGER', () => {
        expect(isManager(mkReq(mkUser('MANAGER')))).toBe(true);
        expect(isManager(mkReq(mkUser('ADMIN')))).toBe(false);
        expect(isManager(mkReq(mkUser('USER')))).toBe(false);
    });

    it('identifies APP_MODERATOR', () => {
        expect(isAppModerator(mkReq(mkUser('APP_MODERATOR')))).toBe(true);
        expect(isAppModerator(mkReq(mkUser('USER')))).toBe(false);
    });

    it('isAdminOrManager is the union of ADMIN and MANAGER', () => {
        expect(isAdminOrManager(mkReq(mkUser('ADMIN')))).toBe(true);
        expect(isAdminOrManager(mkReq(mkUser('MANAGER')))).toBe(true);
        expect(isAdminOrManager(mkReq(mkUser('APP_MODERATOR')))).toBe(false);
        expect(isAdminOrManager(mkReq(mkUser('USER')))).toBe(false);
    });
});

describe('requireAdminRole / requireAdminOrManagerRole', () => {
    it('passes silently for ADMIN', () => {
        expect(() => requireAdminRole(mkReq(mkUser('ADMIN')))).not.toThrow();
        expect(() =>
            requireAdminOrManagerRole(mkReq(mkUser('ADMIN'))),
        ).not.toThrow();
    });

    it('throws 403 for non-admin in requireAdminRole', () => {
        expect(() => requireAdminRole(mkReq(mkUser('MANAGER')))).toThrow(
            /Administrator/,
        );
        expect(() => requireAdminRole(mkReq(mkUser('USER')))).toThrow(
            /Administrator/,
        );
    });

    it('requireAdminOrManagerRole passes MANAGER but blocks USER', () => {
        expect(() =>
            requireAdminOrManagerRole(mkReq(mkUser('MANAGER'))),
        ).not.toThrow();
        expect(() => requireAdminOrManagerRole(mkReq(mkUser('USER')))).toThrow(
            /Administrator or manager/,
        );
        expect(() =>
            requireAdminOrManagerRole(mkReq(mkUser('APP_MODERATOR'))),
        ).toThrow(/Administrator or manager/);
    });

    it('thrown errors carry HTTP 403 + expose=true so the error handler returns JSON', () => {
        try {
            requireAdminRole(mkReq(mkUser('USER')));
        } catch (err) {
            expect(err.status).toBe(403);
            expect(err.expose).toBe(true);
        }
    });
});

describe('hasCapability', () => {
    it('admin always passes, even with no overrides set', () => {
        const req = mkReq(mkUser('ADMIN'));
        // Spot-check across every capability — admin should pass them all.
        for (const cap of Object.values(CAPABILITIES)) {
            expect(hasCapability(req, cap)).toBe(true);
        }
    });

    it('manager passes the role-default caps but not user-only ones', () => {
        const req = mkReq(mkUser('MANAGER'));
        // Managers should hold TASK_*_ANY and SPRINT_* and CR_CREATE/EDIT
        // by default (per ROLE_DEFAULT_CAPABILITIES).
        expect(hasCapability(req, CAPABILITIES.TASK_CREATE_ANY)).toBe(true);
        expect(hasCapability(req, CAPABILITIES.TASK_EDIT_ANY)).toBe(true);
        expect(hasCapability(req, CAPABILITIES.TASK_DELETE_ANY)).toBe(true);
        expect(hasCapability(req, CAPABILITIES.SPRINT_START)).toBe(true);
        expect(hasCapability(req, CAPABILITIES.CR_CREATE)).toBe(true);
        // Managers do NOT get CR delete by default.
        expect(hasCapability(req, CAPABILITIES.CR_DELETE)).toBe(false);
        // Managers do NOT inherit admin-only caps.
        expect(hasCapability(req, CAPABILITIES.USER_APPROVE)).toBe(false);
        expect(hasCapability(req, CAPABILITIES.USER_ROLE_MANAGE)).toBe(false);
        expect(hasCapability(req, CAPABILITIES.PROJECT_DELETE)).toBe(false);
    });

    it('USER has zero role-default capabilities', () => {
        const req = mkReq(mkUser('USER'));
        for (const cap of Object.values(CAPABILITIES)) {
            expect(hasCapability(req, cap)).toBe(false);
        }
    });

    it('per-user override grants a capability to a USER', () => {
        const req = mkReq(mkUser('USER', [CAPABILITIES.TASK_CREATE_ANY]));
        expect(hasCapability(req, CAPABILITIES.TASK_CREATE_ANY)).toBe(true);
        // …but ONLY the granted one.
        expect(hasCapability(req, CAPABILITIES.TASK_EDIT_ANY)).toBe(false);
        expect(hasCapability(req, CAPABILITIES.TASK_DELETE_ANY)).toBe(false);
    });

    it('per-user override is additive on top of role defaults for MANAGER', () => {
        // Give a manager the CR_DELETE override which is admin-only by default.
        const req = mkReq(mkUser('MANAGER', [CAPABILITIES.CR_DELETE]));
        expect(hasCapability(req, CAPABILITIES.CR_DELETE)).toBe(true);
        // Original role defaults still apply.
        expect(hasCapability(req, CAPABILITIES.TASK_CREATE_ANY)).toBe(true);
    });

    it('returns false for unauthenticated / malformed req', () => {
        expect(hasCapability(mkReq(null), CAPABILITIES.TASK_CREATE_ANY)).toBe(
            false,
        );
        expect(hasCapability({}, CAPABILITIES.TASK_CREATE_ANY)).toBe(false);
        // Capability list missing or wrong type? Treat as no overrides.
        expect(
            hasCapability(
                mkReq({ id: 'u', role: 'USER' }),
                CAPABILITIES.TASK_CREATE_ANY,
            ),
        ).toBe(false);
        expect(
            hasCapability(
                mkReq({ id: 'u', role: 'USER', capabilities: 'broken' }),
                CAPABILITIES.TASK_CREATE_ANY,
            ),
        ).toBe(false);
    });
});

describe('requireCapability', () => {
    it('passes for admin', () => {
        expect(() =>
            requireCapability(
                mkReq(mkUser('ADMIN')),
                CAPABILITIES.PROJECT_DELETE,
            ),
        ).not.toThrow();
    });

    it('passes for USER with an explicit override', () => {
        expect(() =>
            requireCapability(
                mkReq(mkUser('USER', [CAPABILITIES.SPRINT_ASSIGN_TASK])),
                CAPABILITIES.SPRINT_ASSIGN_TASK,
            ),
        ).not.toThrow();
    });

    it('throws 403 for USER missing the capability', () => {
        try {
            requireCapability(
                mkReq(mkUser('USER')),
                CAPABILITIES.TASK_CREATE_ANY,
            );
            throw new Error('expected requireCapability to throw');
        } catch (err) {
            expect(err.status).toBe(403);
            expect(err.expose).toBe(true);
        }
    });
});

describe('isAdminOr* aggregate helpers', () => {
    it('isAdminOrHasCapability is admin OR capability', () => {
        expect(
            isAdminOrHasCapability(
                mkReq(mkUser('ADMIN')),
                CAPABILITIES.SPRINT_DELETE,
            ),
        ).toBe(true);
        expect(
            isAdminOrHasCapability(
                mkReq(mkUser('USER', [CAPABILITIES.SPRINT_DELETE])),
                CAPABILITIES.SPRINT_DELETE,
            ),
        ).toBe(true);
        expect(
            isAdminOrHasCapability(
                mkReq(mkUser('USER')),
                CAPABILITIES.SPRINT_DELETE,
            ),
        ).toBe(false);
    });

    it('isAdminOrManagerOrHasCapability accepts manager unconditionally', () => {
        // The helper short-circuits on role: any ADMIN or MANAGER
        // passes regardless of which cap is named (semantically the
        // function is "are you in the admin/manager bucket, OR do you
        // hold this specific override?"). This is the part of the API
        // that previously confused us — make sure the contract is
        // pinned down by a test, since changing it would silently
        // tighten or loosen 30+ call sites.
        expect(
            isAdminOrManagerOrHasCapability(
                mkReq(mkUser('MANAGER')),
                CAPABILITIES.TASK_CREATE_ANY,
            ),
        ).toBe(true);
        // Manager passes even for an admin-default cap like CR_DELETE
        // that they don't actually hold via `hasCapability`. This is
        // INTENTIONAL — the function name implies it.
        expect(
            isAdminOrManagerOrHasCapability(
                mkReq(mkUser('MANAGER')),
                CAPABILITIES.CR_DELETE,
            ),
        ).toBe(true);
        // Sanity: managers do NOT actually carry CR_DELETE via
        // `hasCapability` — the wider helper is the only one that
        // grants it to them. If you need the strict "do they really
        // have the cap?" check, use `hasCapability` directly.
        expect(
            hasCapability(
                mkReq(mkUser('MANAGER')),
                CAPABILITIES.CR_DELETE,
            ),
        ).toBe(false);
        // USER with the override still wins via the cap path.
        expect(
            isAdminOrManagerOrHasCapability(
                mkReq(mkUser('USER', [CAPABILITIES.CR_DELETE])),
                CAPABILITIES.CR_DELETE,
            ),
        ).toBe(true);
        // Plain USER without the override does NOT pass.
        expect(
            isAdminOrManagerOrHasCapability(
                mkReq(mkUser('USER')),
                CAPABILITIES.CR_DELETE,
            ),
        ).toBe(false);
        // APP_MODERATOR also does NOT pass (not in admin-or-manager).
        expect(
            isAdminOrManagerOrHasCapability(
                mkReq(mkUser('APP_MODERATOR')),
                CAPABILITIES.CR_DELETE,
            ),
        ).toBe(false);
    });
});

describe('effectiveCapabilities', () => {
    it('returns every capability for ADMIN', () => {
        const caps = effectiveCapabilities(mkUser('ADMIN'));
        expect(caps).toEqual(
            expect.arrayContaining(Object.values(CAPABILITIES)),
        );
        // No duplicates.
        expect(new Set(caps).size).toBe(caps.length);
    });

    it('returns role defaults for MANAGER and includes overrides additively', () => {
        const u = mkUser('MANAGER', [CAPABILITIES.CR_DELETE, 'unknown:cap']);
        const caps = effectiveCapabilities(u);
        expect(caps).toEqual(
            expect.arrayContaining([
                CAPABILITIES.TASK_CREATE_ANY,
                CAPABILITIES.CR_DELETE,
                'unknown:cap',
            ]),
        );
        // Even unknown overrides leak through — that's intentional: the
        // capability key list is the source of truth, but the helper
        // doesn't gate on it (so legacy DB rows don't disappear).
        expect(caps).toContain('unknown:cap');
        // Set behaviour: no duplicates.
        expect(new Set(caps).size).toBe(caps.length);
    });

    it('returns just the overrides (with no role defaults) for USER', () => {
        const u = mkUser('USER', [CAPABILITIES.TASK_CREATE_ANY]);
        const caps = effectiveCapabilities(u);
        expect(caps).toEqual([CAPABILITIES.TASK_CREATE_ANY]);
    });

    it('returns [] for null user', () => {
        expect(effectiveCapabilities(null)).toEqual([]);
        expect(effectiveCapabilities(undefined)).toEqual([]);
    });

    it('shape invariant: every key in ROLE_DEFAULT_CAPABILITIES is a known capability', () => {
        // Defensive: a typo in a default ("task:create:anny") would
        // silently grant no permission. Walk every role's defaults and
        // assert every entry is in the canonical CAPABILITIES enum.
        const known = new Set(Object.values(CAPABILITIES));
        for (const [role, defaults] of Object.entries(
            ROLE_DEFAULT_CAPABILITIES,
        )) {
            for (const cap of defaults) {
                expect(
                    known.has(cap),
                    `Role ${role} default "${cap}" is not in CAPABILITIES`,
                ).toBe(true);
            }
        }
    });
});
