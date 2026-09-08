const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    notify,
    ensureProjectParticipant,
    isProjectParticipant,
} = require('../lib/notify');
const {
    CAPABILITIES,
    hasCapability,
    requireAdminRole,
    assertProjectRead,
} = require('../lib/permissions');
const realtime = require('../lib/realtime');

const router = express.Router({ mergeParams: true });

router.use(requireAuth);

const participantSelect = {
    id: true,
    addedAt: true,
    addedBy: { select: { id: true, name: true, email: true, avatarUrl: true } },
    user: {
        select: { id: true, name: true, email: true, avatarUrl: true, role: true },
    },
};

async function loadProjectOr404(projectId) {
    const p = await prisma.project.findUnique({ where: { id: projectId } });
    if (!p) throw httpError(404, 'Project not found');
    return p;
}

// Project members (or admin) can see the participant list. We don't expose
// it to non-participants because they can't see the project itself anyway.
router.get('/', async (req, res, next) => {
    try {
        const { projectId } = req.params;
        await assertProjectRead(req, projectId);
        const participants = await prisma.projectParticipant.findMany({
            where: { projectId },
            orderBy: { addedAt: 'asc' },
            select: participantSelect,
        });
        res.json({
            participants: participants.map((p) => ({
                id: p.id,
                addedAt: p.addedAt,
                addedBy: p.addedBy,
                ...p.user,
            })),
        });
    } catch (err) {
        next(err);
    }
});

const addSchema = z.object({ userId: z.string().min(1) });

// True when the caller is allowed to manage participants on `project`:
// admin, OR the owner of a personal project (so individuals can invite
// collaborators to help on their own personal projects without an
// admin gate), OR a user the admin has granted the
// `project:participants:manage` capability override (per-user checkbox
// in the User edit dialog). Previously the override existed in the
// catalogue but was never consulted here — granting it did nothing.
function canManageParticipants(req, project) {
    if (req.user?.role === 'ADMIN') return true;
    if (project.isPersonal && project.ownerId === req.user.id) return true;
    if (hasCapability(req, CAPABILITIES.PROJECT_PARTICIPANTS_MANAGE)) {
        return true;
    }
    return false;
}

// Add: admin or personal-project owner.
router.post('/', async (req, res, next) => {
    try {
        const { projectId } = req.params;
        const project = await loadProjectOr404(projectId);
        if (!canManageParticipants(req, project)) {
            requireAdminRole(req);
        }
        const { userId } = addSchema.parse(req.body);

        const target = await prisma.user.findUnique({ where: { id: userId } });
        if (!target) throw httpError(404, 'User not found');

        const already = await isProjectParticipant(projectId, userId);
        await ensureProjectParticipant(projectId, userId, req.user.id);

        const fresh = await prisma.projectParticipant.findUnique({
            where: { projectId_userId: { projectId, userId } },
            select: participantSelect,
        });

        if (!already && userId !== req.user.id) {
            await notify({
                recipientIds: [userId],
                actorId: req.user.id,
                type: 'PROJECT_UPDATED',
                title: `Added to ${project.name}`,
                body: `${req.user.email} added you as a participant.`,
                projectId,
            });
        }

        // Push to realtime so UIs viewing the project refresh their list.
        realtime.io?.to(`project:${projectId}`).emit('participants:changed', {
            projectId,
        });

        res.status(already ? 200 : 201).json({
            participant: {
                id: fresh.id,
                addedAt: fresh.addedAt,
                addedBy: fresh.addedBy,
                ...fresh.user,
            },
            alreadyMember: already,
        });
    } catch (err) {
        next(err);
    }
});

// Remove: admin OR personal-project owner. Regular users on shared
// projects still can't remove themselves — they ask an admin.
router.delete('/:userId', async (req, res, next) => {
    try {
        const { projectId, userId } = req.params;
        const project = await loadProjectOr404(projectId);
        if (!canManageParticipants(req, project)) {
            requireAdminRole(req);
        }

        if (project.ownerId === userId) {
            throw httpError(
                400,
                'The project owner cannot be removed. Transfer ownership first.',
            );
        }

        const isSelf = userId === req.user.id;

        const existing = await prisma.projectParticipant.findUnique({
            where: { projectId_userId: { projectId, userId } },
        });
        if (!existing) {
            return res.json({ ok: true, removed: false });
        }

        await prisma.projectParticipant.delete({
            where: { projectId_userId: { projectId, userId } },
        });

        // Drop them from the chat room too if it exists.
        const conv = await prisma.conversation.findUnique({
            where: { projectId },
            select: { id: true },
        });
        if (conv) {
            await prisma.conversationParticipant.deleteMany({
                where: { conversationId: conv.id, userId },
            });
        }

        if (!isSelf) {
            await notify({
                recipientIds: [userId],
                actorId: req.user.id,
                type: 'PROJECT_UPDATED',
                title: `Removed from ${project.name}`,
                body: `${req.user.email} removed you from the project participants.`,
                projectId,
            });
        }

        realtime.io?.to(`project:${projectId}`).emit('participants:changed', {
            projectId,
        });

        res.json({ ok: true, removed: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
