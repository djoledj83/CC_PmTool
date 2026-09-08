// Project-access guard tests.
//
// `assertProjectRead`, `assertProjectWritable`, and `accessibleProjectIds`
// touch the database — but the business rules they encode are PURE.
// We use vi.mock() to stub `prisma` and `isProjectParticipant`, then
// drive the helpers through every branch (personal vs shared, owner /
// participant / admin / outsider, open vs DONE project, manager
// override on closed projects, …).
//
// Mocks must be declared BEFORE the helpers are required, because
// `lib/permissions.js` reads `./prisma` at the top of the file.

// describe/it/expect/vi/beforeEach/afterEach come from vitest globals.
//
// We use the test-client facade installed in `lib/prisma.js` to swap
// in a per-test stub. See upload-quota.test.js for the long-form
// explanation of why we don't use `vi.mock` here (short version:
// vitest 2.x's CJS mocking is unreliable when source modules use
// bare `require()`; the facade is more robust).
//
// `notify.isProjectParticipant` is reached transitively by
// `permissions.js`. We DON'T mock it directly — instead we rely on
// the fact that its only side effect is calling
// `prisma.projectParticipant.findUnique`, which goes through the
// facade. So tests control "is X a participant" via
// `prismaMock.projectParticipant.findUnique.mockResolvedValue(...)`.
// Returning `{ id: '…' }` means yes; returning `null` means no.

process.env.NODE_ENV = 'test';

const prismaFacade = require('../src/lib/prisma');

const {
    assertProjectRead,
    assertProjectWritable,
    loadProjectForRead,
    accessibleProjectIds,
} = require('../src/lib/permissions');

function makePrismaStub() {
    return {
        project: {
            findUnique: vi.fn(),
            findMany: vi.fn(),
        },
        projectParticipant: {
            findUnique: vi.fn(),
            findMany: vi.fn(),
        },
    };
}

const mkReq = (role, id = 'u-test') => ({
    user: { id, role, capabilities: [] },
});

let prismaMock;

// Convenience: configure "is X a participant of Y" by setting a flat
// boolean. Internally we toggle the underlying findUnique mock —
// keeps the tests readable.
function setIsParticipant(value) {
    prismaMock.projectParticipant.findUnique.mockResolvedValue(
        value ? { id: 'pp-stub' } : null,
    );
}

beforeEach(() => {
    prismaMock = makePrismaStub();
    prismaFacade.__setTestClient(prismaMock);
});

afterEach(() => {
    prismaFacade.__resetTestClient();
});

describe('assertProjectRead', () => {
    it('throws 404 when the project does not exist', async () => {
        prismaMock.project.findUnique.mockResolvedValue(null);
        await expect(
            assertProjectRead(mkReq('ADMIN'), 'p-missing'),
        ).rejects.toMatchObject({ status: 404 });
    });

    it('lets the owner read their personal project', async () => {
        prismaMock.project.findUnique.mockResolvedValue({
            id: 'p1',
            ownerId: 'u-test',
            isPersonal: true,
        });
        await expect(
            assertProjectRead(mkReq('USER'), 'p1'),
        ).resolves.toBeUndefined();
        // We never looked up participants — the owner short-circuited.
        expect(
            prismaMock.projectParticipant.findUnique,
        ).not.toHaveBeenCalled();
    });

    it('hides another user\'s personal project from an ADMIN (returns 404 not 403)', async () => {
        prismaMock.project.findUnique.mockResolvedValue({
            id: 'p1',
            ownerId: 'someone-else',
            isPersonal: true,
        });
        setIsParticipant(false);
        await expect(
            assertProjectRead(mkReq('ADMIN'), 'p1'),
        ).rejects.toMatchObject({ status: 404 });
    });

    it('lets a participant read a personal project they were invited to', async () => {
        prismaMock.project.findUnique.mockResolvedValue({
            id: 'p1',
            ownerId: 'someone-else',
            isPersonal: true,
        });
        setIsParticipant(true);
        await expect(
            assertProjectRead(mkReq('USER'), 'p1'),
        ).resolves.toBeUndefined();
    });

    it('lets ADMIN read any shared project', async () => {
        prismaMock.project.findUnique.mockResolvedValue({
            id: 'p1',
            ownerId: 'someone-else',
            isPersonal: false,
        });
        await expect(
            assertProjectRead(mkReq('ADMIN'), 'p1'),
        ).resolves.toBeUndefined();
        // Participant lookup never happens for admins on shared projects.
        expect(
            prismaMock.projectParticipant.findUnique,
        ).not.toHaveBeenCalled();
    });

    it('blocks USER from a shared project they don\'t participate in (403, not 404)', async () => {
        prismaMock.project.findUnique.mockResolvedValue({
            id: 'p1',
            ownerId: 'someone-else',
            isPersonal: false,
        });
        setIsParticipant(false);
        await expect(
            assertProjectRead(mkReq('USER'), 'p1'),
        ).rejects.toMatchObject({ status: 403 });
    });
});

describe('assertProjectWritable', () => {
    it('throws when assertProjectRead would throw (no write without read)', async () => {
        prismaMock.project.findUnique.mockResolvedValue(null);
        await expect(
            assertProjectWritable(mkReq('ADMIN'), 'p-missing'),
        ).rejects.toMatchObject({ status: 404 });
    });

    it('lets writes through on an OPEN shared project', async () => {
        // assertProjectRead's findUnique + assertProjectWritable's
        // 2nd findUnique are both stubbed via the same mock; we return
        // the same shape each time.
        prismaMock.project.findUnique.mockResolvedValue({
            id: 'p1',
            ownerId: 'u-test',
            isPersonal: false,
            status: 'IN_PROGRESS',
            name: 'Open project',
        });
        await expect(
            assertProjectWritable(mkReq('USER'), 'p1'),
        ).resolves.toBeUndefined();
    });

    it('blocks regular USER from writing to a CLOSED (DONE) shared project', async () => {
        prismaMock.project.findUnique.mockResolvedValue({
            id: 'p1',
            ownerId: 'u-test',
            isPersonal: false,
            status: 'DONE',
            name: 'Sealed',
        });
        setIsParticipant(true);
        await expect(
            assertProjectWritable(mkReq('USER'), 'p1', 'add a task'),
        ).rejects.toMatchObject({
            status: 403,
            // The error copy must mention how to fix it — the user only
            // sees this string and we want them to know to ask for a
            // reopen rather than refresh / retry.
            message: expect.stringContaining('add a task'),
        });
    });

    it('admin can still write to a closed project (to fix records up)', async () => {
        prismaMock.project.findUnique.mockResolvedValue({
            id: 'p1',
            ownerId: 'someone-else',
            isPersonal: false,
            status: 'DONE',
            name: 'Sealed',
        });
        await expect(
            assertProjectWritable(mkReq('ADMIN'), 'p1'),
        ).resolves.toBeUndefined();
    });

    it('manager can still write to a closed project', async () => {
        prismaMock.project.findUnique.mockResolvedValue({
            id: 'p1',
            ownerId: 'someone-else',
            isPersonal: false,
            status: 'DONE',
            name: 'Sealed',
        });
        setIsParticipant(true);
        await expect(
            assertProjectWritable(mkReq('MANAGER'), 'p1'),
        ).resolves.toBeUndefined();
    });

    it('owner of a CLOSED personal project still gets to keep working on it', async () => {
        prismaMock.project.findUnique.mockResolvedValue({
            id: 'p-personal',
            ownerId: 'u-test',
            isPersonal: true,
            status: 'DONE',
            name: 'My personal',
        });
        // assertProjectRead's owner short-circuit + assertProjectWritable
        // both see ownerId === req.user.id, so this should pass.
        await expect(
            assertProjectWritable(mkReq('USER'), 'p-personal'),
        ).resolves.toBeUndefined();
    });

    it('ON_HOLD projects stay editable for regular users (only DONE locks)', async () => {
        prismaMock.project.findUnique.mockResolvedValue({
            id: 'p1',
            ownerId: 'u-test',
            isPersonal: false,
            status: 'ON_HOLD',
            name: 'Paused',
        });
        await expect(
            assertProjectWritable(mkReq('USER'), 'p1'),
        ).resolves.toBeUndefined();
    });
});

describe('loadProjectForRead', () => {
    it('returns the project row on success', async () => {
        const row = {
            id: 'p1',
            ownerId: 'u-test',
            isPersonal: false,
            name: 'X',
        };
        prismaMock.project.findUnique.mockResolvedValue(row);
        const result = await loadProjectForRead(mkReq('USER'), 'p1');
        expect(result).toBe(row);
    });

    it('throws 404 on a missing project (no info leak)', async () => {
        prismaMock.project.findUnique.mockResolvedValue(null);
        await expect(
            loadProjectForRead(mkReq('USER'), 'p1'),
        ).rejects.toMatchObject({ status: 404 });
    });
});

describe('accessibleProjectIds', () => {
    it('ADMIN gets shared + personal-where-owner-or-participant', async () => {
        prismaMock.project.findMany.mockResolvedValue([
            { id: 's1' },
            { id: 's2' },
            { id: 'p-mine' },
        ]);
        const ids = await accessibleProjectIds(mkReq('ADMIN'));
        expect(ids).toEqual(['s1', 's2', 'p-mine']);
        // We called project.findMany once with the right OR.
        expect(prismaMock.project.findMany).toHaveBeenCalledTimes(1);
        const args = prismaMock.project.findMany.mock.calls[0][0];
        expect(args.where.OR).toEqual(
            expect.arrayContaining([
                { isPersonal: false },
                { ownerId: 'u-test' },
                expect.objectContaining({ isPersonal: true }),
            ]),
        );
    });

    it('non-admin merges owned + participating into a unique set', async () => {
        prismaMock.projectParticipant.findMany.mockResolvedValue([
            { projectId: 'shared-1' },
            { projectId: 'shared-2' },
        ]);
        prismaMock.project.findMany.mockResolvedValue([
            { id: 'shared-1' },
            { id: 'personal-mine' },
        ]);
        const ids = await accessibleProjectIds(mkReq('USER'));
        // shared-1 appears via BOTH queries — should be deduped.
        expect(new Set(ids)).toEqual(
            new Set(['shared-1', 'shared-2', 'personal-mine']),
        );
    });

    it('returns [] for a user with no projects', async () => {
        prismaMock.projectParticipant.findMany.mockResolvedValue([]);
        prismaMock.project.findMany.mockResolvedValue([]);
        const ids = await accessibleProjectIds(mkReq('USER'));
        expect(ids).toEqual([]);
    });
});
