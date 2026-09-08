// Teams CRUD + member management + project/phase team assignments.
//
//   GET    /api/teams                       List all teams (filtered by ?q=).
//   POST   /api/teams                       Create team. Admin / Manager.
//   GET    /api/teams/:id                   Team detail with members.
//   PATCH  /api/teams/:id                   Edit team. Admin / Manager.
//   DELETE /api/teams/:id                   Delete team. Admin only.
//   POST   /api/teams/:id/members           Add a user to a team.
//   DELETE /api/teams/:id/members/:userId   Remove a user from a team.
//
//   GET    /api/teams/by-project/:projectId Teams attached to a project.
//   POST   /api/teams/by-project/:projectId Attach a team. Admin only (mirrors
//                                           participants ACL).
//   DELETE /api/teams/by-project/:projectId/:teamId
//                                           Detach a team. Admin only.
//
//   GET    /api/teams/by-phase/:phaseId     Teams owning a phase.
//   POST   /api/teams/by-phase/:phaseId     Attach a team to a phase. Admin /
//                                           Manager (since they own task
//                                           plumbing inside a project).
//   DELETE /api/teams/by-phase/:phaseId/:teamId
//                                           Detach a team from a phase.
//
// Adding a team to a project (or to a phase under a project) upserts
// every team member as a project participant — same effect as adding
// them one by one through /api/projects/:id/participants. Removing the
// team does NOT remove participants; they may have been added
// individually too. The admin can still drop them via the
// participants endpoint.

const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    notify,
    ensureProjectParticipant,
} = require('../lib/notify');
const { emitToProject } = require('../lib/realtime');
const {
    isAdmin,
    isAdminOrManager,
    CAPABILITIES,
    hasCapability,
    isAdminOrManagerOrHasCapability,
} = require('../lib/permissions');
const { httpError: _httpError } = require('../middleware/error');

// Team management is admin/manager by default; admins can also delegate
// the same powers to a specific user via the `team:manage` capability.
function requireTeamManage(req) {
    if (
        !isAdminOrManagerOrHasCapability(req, CAPABILITIES.TEAM_MANAGE)
    ) {
        throw _httpError(
            403,
            'You do not have permission to manage teams',
        );
    }
}

const {
    requireAdminRole,
    requireAdminOrManagerRole,
    assertProjectRead,
} = require('../lib/permissions');
const { logActivityEvent } = require('../lib/activityLog');

const router = express.Router();
router.use(requireAuth);

const memberSelect = {
    id: true,
    addedAt: true,
    user: {
        select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            role: true,
            position: true,
        },
    },
    addedBy: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
};

const teamInclude = {
    createdBy: {
        select: { id: true, name: true, email: true, avatarUrl: true },
    },
    members: { orderBy: { addedAt: 'asc' }, select: memberSelect },
    _count: { select: { members: true, projects: true, phases: true } },
};

function shapeTeam(team) {
    if (!team) return null;
    const { _count, members, ...rest } = team;
    return {
        ...rest,
        memberCount: _count?.members ?? members?.length ?? 0,
        projectCount: _count?.projects ?? 0,
        phaseCount: _count?.phases ?? 0,
        members: (members || []).map((m) => ({
            id: m.id,
            addedAt: m.addedAt,
            addedBy: m.addedBy,
            ...m.user,
        })),
    };
}

router.get('/', async (req, res, next) => {
    try {
        const q = (req.query.q || '').toString().trim();
        const where = q
            ? {
                  OR: [
                      { name: { contains: q, mode: 'insensitive' } },
                      { description: { contains: q, mode: 'insensitive' } },
                  ],
              }
            : {};
        const teams = await prisma.team.findMany({
            where,
            orderBy: { name: 'asc' },
            include: teamInclude,
        });
        res.json({ teams: teams.map(shapeTeam) });
    } catch (err) {
        next(err);
    }
});

const createTeamSchema = z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional().nullable(),
    color: z.string().max(40).optional().nullable(),
    memberIds: z.array(z.string().min(1)).optional(),
});

router.post('/', async (req, res, next) => {
    try {
        requireTeamManage(req);
        const data = createTeamSchema.parse(req.body);
        const trimmed = data.name.trim();

        const collision = await prisma.team.findUnique({
            where: { name: trimmed },
            select: { id: true },
        });
        if (collision) {
            throw httpError(
                409,
                'A team with that name already exists. Pick a unique name.',
            );
        }

        const created = await prisma.team.create({
            data: {
                name: trimmed,
                description: data.description?.trim() || null,
                color: data.color || null,
                createdById: req.user.id,
                members: data.memberIds?.length
                    ? {
                          create: Array.from(new Set(data.memberIds)).map(
                              (userId) => ({
                                  userId,
                                  addedById: req.user.id,
                              }),
                          ),
                      }
                    : undefined,
            },
            include: teamInclude,
        });

        await logActivityEvent({
            type: 'TEAM_CREATED',
            actorId: req.user.id,
            message: `Created team "${trimmed}"`,
            meta: {
                teamId: created.id,
                teamName: trimmed,
                memberCount: created.members.length,
            },
        });

        res.status(201).json({ team: shapeTeam(created) });
    } catch (err) {
        next(err);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const team = await prisma.team.findUnique({
            where: { id: req.params.id },
            include: teamInclude,
        });
        if (!team) throw httpError(404, 'Team not found');
        res.json({ team: shapeTeam(team) });
    } catch (err) {
        next(err);
    }
});

const patchTeamSchema = z.object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional().nullable(),
    color: z.string().max(40).optional().nullable(),
});

router.patch('/:id', async (req, res, next) => {
    try {
        requireTeamManage(req);
        const data = patchTeamSchema.parse(req.body);
        const existing = await prisma.team.findUnique({
            where: { id: req.params.id },
        });
        if (!existing) throw httpError(404, 'Team not found');

        if (data.name && data.name.trim() !== existing.name) {
            const collision = await prisma.team.findUnique({
                where: { name: data.name.trim() },
                select: { id: true },
            });
            if (collision) throw httpError(409, 'Team name already used.');
        }

        const updated = await prisma.team.update({
            where: { id: existing.id },
            data: {
                name: data.name?.trim() || undefined,
                description:
                    data.description === undefined
                        ? undefined
                        : data.description?.trim() || null,
                color: data.color === undefined ? undefined : data.color || null,
            },
            include: teamInclude,
        });

        await logActivityEvent({
            type: 'TEAM_UPDATED',
            actorId: req.user.id,
            message: `Updated team "${updated.name}"`,
            meta: { teamId: updated.id, teamName: updated.name },
        });

        res.json({ team: shapeTeam(updated) });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        // Deletion is admin-only. A manager can stop using the team
        // (remove it from projects / phases) but can't nuke the row
        // itself, since other managers may still depend on it.
        requireAdminRole(req);
        const existing = await prisma.team.findUnique({
            where: { id: req.params.id },
        });
        if (!existing) throw httpError(404, 'Team not found');
        await prisma.team.delete({ where: { id: existing.id } });
        await logActivityEvent({
            type: 'TEAM_DELETED',
            actorId: req.user.id,
            message: `Deleted team "${existing.name}"`,
            meta: { teamId: existing.id, teamName: existing.name },
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

const addMemberSchema = z.object({ userId: z.string().min(1) });

router.post('/:id/members', async (req, res, next) => {
    try {
        requireTeamManage(req);
        const { userId } = addMemberSchema.parse(req.body);
        const team = await prisma.team.findUnique({
            where: { id: req.params.id },
        });
        if (!team) throw httpError(404, 'Team not found');
        const target = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, email: true },
        });
        if (!target) throw httpError(404, 'User not found');

        const existing = await prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId: team.id, userId } },
        });
        if (existing) {
            const fresh = await prisma.team.findUnique({
                where: { id: team.id },
                include: teamInclude,
            });
            return res.json({ team: shapeTeam(fresh), alreadyMember: true });
        }

        await prisma.teamMember.create({
            data: { teamId: team.id, userId, addedById: req.user.id },
        });

        // Backfill the user into every project the team is currently
        // attached to (project-wide AND phase-specific). Same logic
        // that `attach team` runs, only for the new user. Done in
        // small batches per project to avoid deep nested writes.
        const projects = await prisma.projectTeam.findMany({
            where: { teamId: team.id },
            select: { projectId: true },
        });
        const phases = await prisma.phaseTeam.findMany({
            where: { teamId: team.id },
            include: { phase: { select: { projectId: true } } },
        });
        const projectIds = new Set([
            ...projects.map((p) => p.projectId),
            ...phases.map((ph) => ph.phase?.projectId).filter(Boolean),
        ]);
        for (const pid of projectIds) {
            await ensureProjectParticipant(pid, userId, req.user.id);
        }

        await logActivityEvent({
            type: 'TEAM_MEMBER_ADDED',
            actorId: req.user.id,
            message: `Added ${target.name || target.email} to team "${team.name}"`,
            meta: {
                teamId: team.id,
                teamName: team.name,
                targetUserId: target.id,
                targetUserName: target.name || target.email,
            },
        });

        const fresh = await prisma.team.findUnique({
            where: { id: team.id },
            include: teamInclude,
        });
        res.status(201).json({ team: shapeTeam(fresh) });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id/members/:userId', async (req, res, next) => {
    try {
        requireTeamManage(req);
        const { id, userId } = req.params;
        const team = await prisma.team.findUnique({ where: { id } });
        if (!team) throw httpError(404, 'Team not found');
        const target = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, email: true },
        });
        const existing = await prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId: id, userId } },
        });
        if (!existing) {
            const fresh = await prisma.team.findUnique({
                where: { id },
                include: teamInclude,
            });
            return res.json({ team: shapeTeam(fresh), removed: false });
        }
        await prisma.teamMember.delete({
            where: { teamId_userId: { teamId: id, userId } },
        });
        await logActivityEvent({
            type: 'TEAM_MEMBER_REMOVED',
            actorId: req.user.id,
            message: `Removed ${target?.name || target?.email || userId} from team "${team.name}"`,
            meta: {
                teamId: team.id,
                teamName: team.name,
                targetUserId: userId,
                targetUserName: target?.name || target?.email || null,
            },
        });
        const fresh = await prisma.team.findUnique({
            where: { id },
            include: teamInclude,
        });
        res.json({ team: shapeTeam(fresh) });
    } catch (err) {
        next(err);
    }
});

// ----- Project ↔ team -----------------------------------------------

router.get('/by-project/:projectId', async (req, res, next) => {
    try {
        await assertProjectRead(req, req.params.projectId);
        const rows = await prisma.projectTeam.findMany({
            where: { projectId: req.params.projectId },
            orderBy: { addedAt: 'asc' },
            include: {
                team: { include: teamInclude },
                addedBy: {
                    select: { id: true, name: true, email: true, avatarUrl: true },
                },
            },
        });
        res.json({
            teams: rows.map((r) => ({
                id: r.id,
                addedAt: r.addedAt,
                addedBy: r.addedBy,
                team: shapeTeam(r.team),
            })),
        });
    } catch (err) {
        next(err);
    }
});

const attachProjectSchema = z.object({ teamId: z.string().min(1) });

router.post('/by-project/:projectId', async (req, res, next) => {
    try {
        // Mirrors participant attach ACL: admin-only. Managers can do
        // a lot inside a project but they don't curate the membership
        // roster.
        requireAdminRole(req);
        const { projectId } = req.params;
        const project = await prisma.project.findUnique({
            where: { id: projectId },
        });
        if (!project) throw httpError(404, 'Project not found');
        const { teamId } = attachProjectSchema.parse(req.body);
        const team = await prisma.team.findUnique({
            where: { id: teamId },
            include: { members: { select: { userId: true } } },
        });
        if (!team) throw httpError(404, 'Team not found');

        const existing = await prisma.projectTeam.findUnique({
            where: { projectId_teamId: { projectId, teamId } },
        });
        if (!existing) {
            await prisma.projectTeam.create({
                data: { projectId, teamId, addedById: req.user.id },
            });
        }

        // Upsert every member as a project participant.
        for (const m of team.members) {
            await ensureProjectParticipant(projectId, m.userId, req.user.id);
        }

        await logActivityEvent({
            type: 'PROJECT_TEAM_ADDED',
            actorId: req.user.id,
            projectId,
            message: `Added team "${team.name}" to ${project.name}`,
            meta: {
                teamId: team.id,
                teamName: team.name,
                memberCount: team.members.length,
            },
        });

        // Notify newly added members. (ensureProjectParticipant is
        // idempotent so we already skipped duplicate inserts; for the
        // notification we just send to everyone in the team — they'll
        // dedupe on the FE side via the bell.)
        const notifyIds = team.members
            .map((m) => m.userId)
            .filter((id) => id !== req.user.id);
        if (notifyIds.length) {
            await notify({
                recipientIds: notifyIds,
                actorId: req.user.id,
                type: 'PROJECT_UPDATED',
                title: `Added to ${project.name}`,
                body: `You were added through team "${team.name}".`,
                projectId,
            });
        }

        emitToProject(projectId, 'project:plan-changed', {
            projectId,
            kind: 'team-added',
            teamId: team.id,
            at: new Date().toISOString(),
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.delete('/by-project/:projectId/:teamId', async (req, res, next) => {
    try {
        requireAdminRole(req);
        const { projectId, teamId } = req.params;
        const team = await prisma.team.findUnique({
            where: { id: teamId },
            select: { id: true, name: true },
        });
        const existing = await prisma.projectTeam.findUnique({
            where: { projectId_teamId: { projectId, teamId } },
        });
        if (existing) {
            await prisma.projectTeam.delete({
                where: { projectId_teamId: { projectId, teamId } },
            });
            await logActivityEvent({
                type: 'PROJECT_TEAM_REMOVED',
                actorId: req.user.id,
                projectId,
                message: `Removed team "${team?.name || teamId}" from project`,
                meta: { teamId, teamName: team?.name || null },
            });
            emitToProject(projectId, 'project:plan-changed', {
                projectId,
                kind: 'team-removed',
                teamId,
                at: new Date().toISOString(),
            });
        }
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// ----- Phase ↔ team -----------------------------------------------

router.get('/by-phase/:phaseId', async (req, res, next) => {
    try {
        const phase = await prisma.phase.findUnique({
            where: { id: req.params.phaseId },
            select: { id: true, projectId: true },
        });
        if (!phase) throw httpError(404, 'Phase not found');
        await assertProjectRead(req, phase.projectId);

        const rows = await prisma.phaseTeam.findMany({
            where: { phaseId: phase.id },
            orderBy: { addedAt: 'asc' },
            include: {
                team: { include: teamInclude },
                addedBy: {
                    select: { id: true, name: true, email: true, avatarUrl: true },
                },
            },
        });
        res.json({
            teams: rows.map((r) => ({
                id: r.id,
                addedAt: r.addedAt,
                addedBy: r.addedBy,
                team: shapeTeam(r.team),
            })),
        });
    } catch (err) {
        next(err);
    }
});

const attachPhaseSchema = z.object({ teamId: z.string().min(1) });

router.post('/by-phase/:phaseId', async (req, res, next) => {
    try {
        requireTeamManage(req);
        const phase = await prisma.phase.findUnique({
            where: { id: req.params.phaseId },
            select: { id: true, projectId: true, name: true },
        });
        if (!phase) throw httpError(404, 'Phase not found');
        await assertProjectRead(req, phase.projectId);
        const { teamId } = attachPhaseSchema.parse(req.body);
        const team = await prisma.team.findUnique({
            where: { id: teamId },
            include: { members: { select: { userId: true } } },
        });
        if (!team) throw httpError(404, 'Team not found');

        const existing = await prisma.phaseTeam.findUnique({
            where: { phaseId_teamId: { phaseId: phase.id, teamId } },
        });
        if (!existing) {
            await prisma.phaseTeam.create({
                data: {
                    phaseId: phase.id,
                    teamId,
                    addedById: req.user.id,
                },
            });
        }

        // Same as project attach — pull every team member into the
        // project participant list so the chat / mentions / etc.
        // continue to work.
        for (const m of team.members) {
            await ensureProjectParticipant(
                phase.projectId,
                m.userId,
                req.user.id,
            );
        }

        await logActivityEvent({
            type: 'PHASE_TEAM_ADDED',
            actorId: req.user.id,
            projectId: phase.projectId,
            message: `Assigned team "${team.name}" to phase "${phase.name}"`,
            meta: {
                teamId: team.id,
                teamName: team.name,
                phaseId: phase.id,
                phaseName: phase.name,
            },
        });

        emitToProject(phase.projectId, 'project:plan-changed', {
            projectId: phase.projectId,
            kind: 'phase-team-added',
            phaseId: phase.id,
            teamId,
            at: new Date().toISOString(),
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

router.delete('/by-phase/:phaseId/:teamId', async (req, res, next) => {
    try {
        requireTeamManage(req);
        const { phaseId, teamId } = req.params;
        const phase = await prisma.phase.findUnique({
            where: { id: phaseId },
            select: { id: true, projectId: true, name: true },
        });
        if (!phase) throw httpError(404, 'Phase not found');
        await assertProjectRead(req, phase.projectId);
        const team = await prisma.team.findUnique({
            where: { id: teamId },
            select: { id: true, name: true },
        });
        const existing = await prisma.phaseTeam.findUnique({
            where: { phaseId_teamId: { phaseId, teamId } },
        });
        if (existing) {
            await prisma.phaseTeam.delete({
                where: { phaseId_teamId: { phaseId, teamId } },
            });
            await logActivityEvent({
                type: 'PHASE_TEAM_REMOVED',
                actorId: req.user.id,
                projectId: phase.projectId,
                message: `Removed team "${team?.name || teamId}" from phase "${phase.name}"`,
                meta: {
                    teamId,
                    teamName: team?.name || null,
                    phaseId: phase.id,
                    phaseName: phase.name,
                },
            });
            emitToProject(phase.projectId, 'project:plan-changed', {
                projectId: phase.projectId,
                kind: 'phase-team-removed',
                phaseId,
                teamId,
                at: new Date().toISOString(),
            });
        }
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
