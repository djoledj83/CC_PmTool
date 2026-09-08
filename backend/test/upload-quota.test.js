// Tests for the per-user upload quota helper.
//
// Covers the pure functions (`resolveQuotaBytes`, `formatBytes`) and
// the prisma-backed ones (`getUsage`, `assertWithinQuota`,
// `incrementUsage`, `decrementUsage`) with a mocked prisma client.

// describe/it/expect/vi/beforeEach/afterEach come from vitest globals.

// NODE_ENV=test must be set BEFORE requiring the prisma facade so
// the test-client setter doesn't refuse the swap. Vitest sets this
// automatically per the docs but we belt-and-braces it here.
process.env.NODE_ENV = 'test';

// The prisma facade exposed by `lib/prisma.js` proxies every call to
// an underlying client. Tests install a stub via `__setTestClient`
// and the source files (`uploadQuota.js`, `permissions.js`, …) start
// seeing the stub immediately — no vitest mock plumbing needed.
//
// This works because the facade itself never connects to Postgres;
// it just forwards method lookups. So importing it has no side
// effects, and we can swap in a per-test stub with `beforeEach`.
const prismaFacade = require('../src/lib/prisma');

function makePrismaStub() {
    return {
        user: {
            findUnique: vi.fn(),
            update: vi.fn().mockResolvedValue({}),
        },
        fileAttachment: {
            aggregate: vi.fn(),
        },
    };
}

const {
    resolveQuotaBytes,
    getUsage,
    assertWithinQuota,
    incrementUsage,
    decrementUsage,
    recomputeForUser,
    formatBytes,
} = require('../src/lib/uploadQuota');

const ORIGINAL_ENV = { ...process.env };
let prismaMock;

beforeEach(() => {
    prismaMock = makePrismaStub();
    prismaFacade.__setTestClient(prismaMock);
});

afterEach(() => {
    prismaFacade.__resetTestClient();
    process.env = { ...ORIGINAL_ENV };
});

describe('resolveQuotaBytes', () => {
    it('returns the 2 GiB default when env is unset', () => {
        delete process.env.USER_UPLOAD_QUOTA_BYTES;
        expect(resolveQuotaBytes()).toBe(2n * 1024n * 1024n * 1024n);
    });

    it('returns null when env is "0" (disabled)', () => {
        process.env.USER_UPLOAD_QUOTA_BYTES = '0';
        expect(resolveQuotaBytes()).toBeNull();
    });

    it('returns the parsed value for a positive integer string', () => {
        process.env.USER_UPLOAD_QUOTA_BYTES = '5368709120'; // 5 GiB
        expect(resolveQuotaBytes()).toBe(5368709120n);
    });

    it('falls back to default on a negative value', () => {
        process.env.USER_UPLOAD_QUOTA_BYTES = '-100';
        expect(resolveQuotaBytes()).toBe(2n * 1024n * 1024n * 1024n);
    });

    it('falls back to default on garbage input', () => {
        process.env.USER_UPLOAD_QUOTA_BYTES = 'two-gigabytes';
        expect(resolveQuotaBytes()).toBe(2n * 1024n * 1024n * 1024n);
    });
});

describe('formatBytes', () => {
    it('shows bytes for sub-1KB values', () => {
        expect(formatBytes(0n)).toBe('0 B');
        expect(formatBytes(512n)).toBe('512 B');
    });

    it('uses 2 decimals below 100 of a unit', () => {
        expect(formatBytes(1024n)).toBe('1.00 KB');
        expect(formatBytes(1024n * 1024n)).toBe('1.00 MB');
    });

    it('switches to 1 decimal above 100 of a unit', () => {
        expect(formatBytes(1024n * 200n)).toBe('200.0 KB');
    });

    it('handles big numbers (TB+)', () => {
        const oneTB = 1024n ** 4n;
        expect(formatBytes(oneTB)).toMatch(/^1\.00 TB$/);
    });
});

describe('getUsage', () => {
    it('returns the user\'s uploadedBytesTotal', async () => {
        prismaMock.user.findUnique.mockResolvedValue({
            uploadedBytesTotal: 1234567n,
        });
        const usage = await getUsage('u1');
        expect(usage).toBe(1234567n);
        expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
            where: { id: 'u1' },
            select: { uploadedBytesTotal: true },
        });
    });

    it('returns 0n for an unknown user', async () => {
        prismaMock.user.findUnique.mockResolvedValue(null);
        expect(await getUsage('ghost')).toBe(0n);
    });
});

describe('assertWithinQuota', () => {
    it('throws 401 when there is no user on the request', async () => {
        await expect(
            assertWithinQuota({ user: null, incomingBytes: 100 }),
        ).rejects.toMatchObject({ status: 401 });
    });

    it('admins bypass the cap entirely', async () => {
        process.env.USER_UPLOAD_QUOTA_BYTES = '100';
        prismaMock.user.findUnique.mockResolvedValue({
            uploadedBytesTotal: 1000n,
        });
        await expect(
            assertWithinQuota({
                user: { id: 'admin', role: 'ADMIN' },
                incomingBytes: 50_000,
            }),
        ).resolves.toBeUndefined();
        // We didn't even need to look up the usage row for admins.
        // (Implementation could change to read it for analytics; the
        // contract is just "doesn't throw".)
    });

    it('passes when usage + incoming is under the cap', async () => {
        process.env.USER_UPLOAD_QUOTA_BYTES = '2000';
        prismaMock.user.findUnique.mockResolvedValue({
            uploadedBytesTotal: 500n,
        });
        await expect(
            assertWithinQuota({
                user: { id: 'u1', role: 'USER' },
                incomingBytes: 500,
            }),
        ).resolves.toBeUndefined();
    });

    it('throws 413 when usage + incoming exceeds the cap', async () => {
        process.env.USER_UPLOAD_QUOTA_BYTES = '1000';
        prismaMock.user.findUnique.mockResolvedValue({
            uploadedBytesTotal: 900n,
        });
        try {
            await assertWithinQuota({
                user: { id: 'u1', role: 'USER' },
                incomingBytes: 200,
            });
            throw new Error('expected assertWithinQuota to throw');
        } catch (err) {
            expect(err.status).toBe(413);
            expect(err.expose).toBe(true);
            // The error message must include the actionable info: how
            // much you've used, the cap, and what remains.
            expect(err.message).toMatch(/storage quota/);
            expect(err.message).toMatch(/Remaining/);
        }
    });

    it('passes when the cap is disabled (env=0) regardless of usage', async () => {
        process.env.USER_UPLOAD_QUOTA_BYTES = '0';
        prismaMock.user.findUnique.mockResolvedValue({
            uploadedBytesTotal: 99999999999n,
        });
        await expect(
            assertWithinQuota({
                user: { id: 'u1', role: 'USER' },
                incomingBytes: 1024 * 1024 * 1024,
            }),
        ).resolves.toBeUndefined();
    });
});

describe('incrementUsage / decrementUsage', () => {
    // The helpers take a `tx` (Prisma transaction client) so they
    // commit/rollback with the surrounding work. We stub one that
    // mirrors the prisma client surface.
    let tx;
    beforeEach(() => {
        tx = {
            user: {
                findUnique: vi.fn(),
                update: vi.fn().mockResolvedValue({}),
            },
        };
    });

    it('incrementUsage bumps the counter atomically', async () => {
        await incrementUsage(tx, 'u1', 500);
        expect(tx.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { uploadedBytesTotal: { increment: 500n } },
        });
    });

    it('incrementUsage no-ops for zero or negative inputs', async () => {
        await incrementUsage(tx, 'u1', 0);
        await incrementUsage(tx, 'u1', -10);
        expect(tx.user.update).not.toHaveBeenCalled();
    });

    it('decrementUsage subtracts the bytes, clamped at zero', async () => {
        tx.user.findUnique.mockResolvedValue({ uploadedBytesTotal: 100n });
        await decrementUsage(tx, 'u1', 30);
        expect(tx.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { uploadedBytesTotal: 70n },
        });
    });

    it('decrementUsage clamps to 0n on counter drift (delete > stored)', async () => {
        tx.user.findUnique.mockResolvedValue({ uploadedBytesTotal: 10n });
        await decrementUsage(tx, 'u1', 999);
        expect(tx.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { uploadedBytesTotal: 0n },
        });
    });

    it('decrementUsage skips entirely if the user disappeared', async () => {
        tx.user.findUnique.mockResolvedValue(null);
        await decrementUsage(tx, 'u1', 30);
        expect(tx.user.update).not.toHaveBeenCalled();
    });
});

describe('recomputeForUser', () => {
    it('rewrites the counter from the FileAttachment aggregate', async () => {
        prismaMock.fileAttachment.aggregate.mockResolvedValue({
            _sum: { size: 8192 },
        });
        prismaMock.user.update.mockResolvedValue({});
        const total = await recomputeForUser('u1');
        expect(total).toBe(8192n);
        expect(prismaMock.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { uploadedBytesTotal: 8192n },
        });
    });

    it('writes 0n when the user has no attachments', async () => {
        prismaMock.fileAttachment.aggregate.mockResolvedValue({
            _sum: { size: null },
        });
        prismaMock.user.update.mockResolvedValue({});
        const total = await recomputeForUser('u1');
        expect(total).toBe(0n);
        expect(prismaMock.user.update).toHaveBeenCalledWith({
            where: { id: 'u1' },
            data: { uploadedBytesTotal: 0n },
        });
    });
});
