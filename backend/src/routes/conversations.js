const express = require('express');
const path = require('node:path');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const { isAdmin } = require('../lib/permissions');
const {
    fileUpload,
    fileUrl,
    signFileUrl,
    removeFileSafe,
} = require('../lib/upload');
const realtime = require('../lib/realtime');
const {
    notify,
    isProjectParticipant,
    clearChatNotificationsForConversation,
} = require('../lib/notify');

const router = express.Router();

router.use(requireAuth);

// Chat attachments expire 30 days after upload. The constant lives here
// so the upload handler and the front-end can both quote the same
// number; the cleanup job in lib/messageAttachments.js sweeps anything
// past `expiresAt`.
const ATTACHMENT_TTL_DAYS = 30;
const ATTACHMENT_TTL_MS = ATTACHMENT_TTL_DAYS * 24 * 60 * 60 * 1000;

// Signs every attachment URL for the requesting user so the asset
// server can verify the download. We sign for the standard file-URL
// TTL (an hour or so) — the 30-day expiry is enforced separately by
// the cleanup job.
function signAttachments(attachments, userId) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
        return attachments || [];
    }
    return attachments.map((a) => {
        if (!a?.fileUrl) return a;
        const filename = path.basename(a.fileUrl.split('?')[0]);
        return {
            ...a,
            fileUrl: signFileUrl(filename, userId, undefined, a.fileName),
        };
    });
}

// Same as above but works on a single message row in-place.
function signMessageAttachments(message, userId) {
    if (!message) return message;
    if (!message.attachments || message.attachments.length === 0) {
        return message;
    }
    return { ...message, attachments: signAttachments(message.attachments, userId) };
}

// Total unread across all my conversations. Used by /read so the
// client can sync its sidebar badge in one round-trip instead of
// running the count itself and risking off-by-one errors.
async function computeTotalUnreadMessages(userId) {
    const memberships = await prisma.conversationParticipant.findMany({
        where: { userId },
        select: { conversationId: true, lastReadAt: true },
    });
    if (memberships.length === 0) return 0;
    const counts = await Promise.all(
        memberships.map((m) =>
            prisma.message.count({
                where: {
                    conversationId: m.conversationId,
                    createdAt: { gt: m.lastReadAt },
                    senderId: { not: userId },
                },
            }),
        ),
    );
    return counts.reduce((sum, n) => sum + n, 0);
}

const participantSelect = {
    id: true,
    user: {
        select: { id: true, name: true, email: true, avatarUrl: true, role: true },
    },
    lastReadAt: true,
};

const conversationInclude = {
    participants: { select: participantSelect },
    project: { select: { id: true, name: true } },
};

function dmKeyFor(a, b) {
    return [a, b].sort().join(':');
}

function summarizeConversation(c, currentUserId) {
    const me = c.participants.find((p) => p.user.id === currentUserId) || null;
    const others = c.participants.filter((p) => p.user.id !== currentUserId);
    const lastMessage = c.messages?.[0] || null;
    const unreadCount = c._count?.messages ?? 0;
    // `participantReads` lets the sender's UI compute "Seen by X"
    // on their OWN messages: a message I sent is "seen by user U"
    // iff U's lastReadAt >= message.createdAt. The frontend listens
    // for `conversation:read` socket events to keep this fresh
    // without a full refetch.
    const participantReads = c.participants.map((p) => ({
        userId: p.user.id,
        lastReadAt: p.lastReadAt,
    }));
    return {
        id: c.id,
        type: c.type,
        title:
            c.title ||
            (c.type === 'PROJECT' ? c.project?.name || 'Project chat' : null),
        project: c.project || null,
        participants: c.participants.map((p) => p.user),
        otherParticipants: others.map((p) => p.user),
        lastReadAt: me?.lastReadAt || null,
        participantReads,
        lastMessage,
        unreadCount,
        updatedAt: c.updatedAt,
    };
}

async function loadMyConversation(conversationId, userId) {
    const convo = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: conversationInclude,
    });
    if (!convo) throw httpError(404, 'Conversation not found');

    // For DMs the chat-participant table is the source of truth.
    // For PROJECT rooms the project participants list is canonical \u2014 the
    // chat-participant rows are kept in sync so we can still track lastReadAt.
    if (convo.type === 'DM') {
        const member = convo.participants.some((p) => p.user.id === userId);
        if (!member) throw httpError(404, 'Conversation not found');
        return convo;
    }

    if (!convo.projectId) throw httpError(404, 'Conversation not found');
    const ok = await isProjectParticipant(convo.projectId, userId);
    if (!ok) throw httpError(404, 'Conversation not found');
    return convo;
}

// List my conversations + per-conversation unread count + last message.
router.get('/', async (req, res, next) => {
    try {
        const userId = req.user.id;

        const memberships = await prisma.conversationParticipant.findMany({
            where: { userId },
            include: {
                conversation: {
                    include: {
                        participants: { select: participantSelect },
                        project: { select: { id: true, name: true } },
                        messages: {
                            orderBy: { createdAt: 'desc' },
                            take: 1,
                            include: {
                                sender: {
                                    select: {
                                        id: true,
                                        name: true,
                                        avatarUrl: true,
                                    },
                                },
                                attachments: true,
                            },
                        },
                    },
                },
            },
            orderBy: { conversation: { updatedAt: 'desc' } },
        });

        const conversations = await Promise.all(
            memberships.map(async (m) => {
                const c = m.conversation;
                const unreadCount = await prisma.message.count({
                    where: {
                        conversationId: c.id,
                        createdAt: { gt: m.lastReadAt },
                        senderId: { not: userId },
                    },
                });
                return summarizeConversation(
                    { ...c, _count: { messages: unreadCount } },
                    userId,
                );
            }),
        );

        res.json({ conversations });
    } catch (err) {
        next(err);
    }
});

// Total unread across all my conversations (for sidebar badge).
router.get('/unread-count', async (req, res, next) => {
    try {
        const unread = await computeTotalUnreadMessages(req.user.id);
        res.json({ unread });
    } catch (err) {
        next(err);
    }
});

const openDmSchema = z.object({ userId: z.string().min(1) });

// Find-or-create a 1-on-1 conversation with the given user.
router.post('/dm', async (req, res, next) => {
    try {
        const { userId: otherId } = openDmSchema.parse(req.body);
        const me = req.user.id;
        if (otherId === me) {
            throw httpError(400, 'You cannot start a chat with yourself');
        }
        const other = await prisma.user.findUnique({ where: { id: otherId } });
        if (!other) throw httpError(404, 'User not found');

        const dmKey = dmKeyFor(me, otherId);
        let convo = await prisma.conversation.findUnique({
            where: { dmKey },
            include: conversationInclude,
        });

        if (!convo) {
            convo = await prisma.conversation.create({
                data: {
                    type: 'DM',
                    dmKey,
                    participants: {
                        create: [{ userId: me }, { userId: otherId }],
                    },
                },
                include: conversationInclude,
            });
        }

        res.status(201).json({
            conversation: summarizeConversation(
                { ...convo, _count: { messages: 0 } },
                me,
            ),
        });
    } catch (err) {
        next(err);
    }
});

const projectRoomSchema = z.object({ projectId: z.string().min(1) });

// Open the project chat room. The caller must already be a project
// participant \u2014 chat membership is not the way to join the project. Use
// the participants endpoint instead.
router.post('/project-room', async (req, res, next) => {
    try {
        const { projectId } = projectRoomSchema.parse(req.body);
        const me = req.user.id;

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { id: true, name: true },
        });
        if (!project) throw httpError(404, 'Project not found');

        const allowed = await isProjectParticipant(projectId, me);
        if (!allowed) {
            throw httpError(
                403,
                'Only project participants can open the project chat',
            );
        }

        let convo = await prisma.conversation.findUnique({
            where: { projectId },
            include: conversationInclude,
        });

        if (!convo) {
            // First time the room is opened: seed chat membership with the
            // current project participant set so everyone gets lastReadAt
            // tracking and shows up in the room header.
            const projectMembers = await prisma.projectParticipant.findMany({
                where: { projectId },
                select: { userId: true },
            });
            const userIds = Array.from(
                new Set([me, ...projectMembers.map((p) => p.userId)]),
            );
            convo = await prisma.conversation.create({
                data: {
                    type: 'PROJECT',
                    projectId,
                    title: project.name,
                    participants: {
                        create: userIds.map((userId) => ({ userId })),
                    },
                },
                include: conversationInclude,
            });
        } else {
            // Top up membership for any project participants that aren't yet
            // tracked in the chat (e.g. were added after the room existed).
            const memberIds = new Set(
                convo.participants.map((p) => p.user.id),
            );
            const projectMembers = await prisma.projectParticipant.findMany({
                where: { projectId },
                select: { userId: true },
            });
            const missing = projectMembers
                .map((p) => p.userId)
                .filter((id) => !memberIds.has(id));
            if (missing.length) {
                await prisma.conversationParticipant.createMany({
                    data: missing.map((userId) => ({
                        conversationId: convo.id,
                        userId,
                    })),
                    skipDuplicates: true,
                });
                convo = await prisma.conversation.findUnique({
                    where: { id: convo.id },
                    include: conversationInclude,
                });
            }
        }

        res.status(201).json({
            conversation: summarizeConversation(
                { ...convo, _count: { messages: 0 } },
                me,
            ),
        });
    } catch (err) {
        next(err);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const c = await loadMyConversation(req.params.id, req.user.id);
        res.json({
            conversation: summarizeConversation(
                { ...c, _count: { messages: 0 } },
                req.user.id,
            ),
        });
    } catch (err) {
        next(err);
    }
});

// Schema for the paginated history query string. Strict validation
// keeps malformed `before` / `limit` values from sliding into Prisma.
const messagesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    before: z
        .string()
        .datetime({ offset: true })
        .optional()
        .or(z.literal('').transform(() => undefined)),
});

// Paginated message history (newest first; reversed on the client for display).
router.get('/:id/messages', async (req, res, next) => {
    try {
        await loadMyConversation(req.params.id, req.user.id);
        const parsed = messagesQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            throw httpError(400, 'Invalid query parameters');
        }
        const limit = parsed.data.limit || 50;
        const before = parsed.data.before
            ? new Date(parsed.data.before)
            : undefined;

        const messages = await prisma.message.findMany({
            where: {
                conversationId: req.params.id,
                ...(before ? { createdAt: { lt: before } } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: {
                sender: {
                    select: { id: true, name: true, email: true, avatarUrl: true },
                },
                attachments: true,
            },
        });

        const signed = messages
            .map((m) => signMessageAttachments(m, req.user.id))
            .reverse();
        res.json({ messages: signed });
    } catch (err) {
        next(err);
    }
});

// `content` can be empty when the message is attachment-only — we
// enforce that "at least one of content/attachment" requirement in
// the multipart branch below.
const sendSchema = z.object({
    content: z.string().max(4000).optional(),
});

router.post(
    '/:id/messages',
    // multer is set up to ignore non-multipart bodies, so the JSON
    // path (which the current frontend uses) still works.
    fileUpload.single('file'),
    async (req, res, next) => {
    try {
        const conv = await loadMyConversation(req.params.id, req.user.id);
        // multer puts text fields under req.body in multipart requests;
        // for application/json the body is parsed normally upstream.
        const { content } = sendSchema.parse({
            content: req.body?.content ?? '',
        });
        const trimmed = (content || '').trim();
        const hasFile = Boolean(req.file);
        if (!trimmed && !hasFile) {
            if (hasFile) removeFileSafe(fileUrl(req.file.filename));
            throw httpError(400, 'Message body or attachment required');
        }

        const message = await prisma.message.create({
            data: {
                conversationId: conv.id,
                senderId: req.user.id,
                content: trimmed,
                ...(hasFile
                    ? {
                          attachments: {
                              create: [
                                  {
                                      fileUrl: fileUrl(req.file.filename),
                                      fileName: req.file.originalname,
                                      fileSize: req.file.size,
                                      fileMimeType: req.file.mimetype,
                                      expiresAt: new Date(
                                          Date.now() + ATTACHMENT_TTL_MS,
                                      ),
                                  },
                              ],
                          },
                      }
                    : {}),
            },
            include: {
                sender: {
                    select: { id: true, name: true, email: true, avatarUrl: true },
                },
                attachments: true,
            },
        });

        await prisma.conversation.update({
            where: { id: conv.id },
            data: { updatedAt: new Date() },
        });

        // Bump my own lastReadAt so I don't get an unread count for my message.
        await prisma.conversationParticipant.updateMany({
            where: { conversationId: conv.id, userId: req.user.id },
            data: { lastReadAt: message.createdAt },
        });

        // Sign attachment URLs once for the broadcast — every receiving
        // tab will already be authenticated, so the same signature is
        // valid for all of them. The downside of signing per-recipient
        // is small (extra DB round trips) and not worth it here.
        const signed = signMessageAttachments(message, req.user.id);

        const messagePayload = {
            message: signed,
            conversationId: conv.id,
        };

        // Push the message to everyone who has joined this conversation
        // room (open chat tab / widget / project panel). Live threads
        // subscribe here so new lines appear without a refetch.
        realtime.emitToConversation(conv.id, 'message:new', messagePayload);

        // Notify other participants who are NOT in the room (or are offline)
        // so they get a bell badge / desktop notification stub. For project
        // rooms we use the canonical project participant list so newly-added
        // members aren't missed even if their lastReadAt tracking row was
        // created later.
        let recipientIds = [];
        if (conv.type === 'PROJECT' && conv.projectId) {
            const rows = await prisma.projectParticipant.findMany({
                where: { projectId: conv.projectId },
                select: { userId: true },
            });
            recipientIds = rows.map((r) => r.userId);
        } else {
            recipientIds = conv.participants.map((p) => p.user.id);
        }
        recipientIds = recipientIds.filter((id) => id !== req.user.id);

        // Deliver message:new on each recipient's user socket so chat
        // badge + sound update even when they have not joined the
        // conversation room (browsing plan, todos, etc.).
        if (recipientIds.length) {
            realtime.emitToUsers(recipientIds, 'message:new', messagePayload);
        }

        // Prefer the text body for the bell preview; fall back to the
        // first attachment's filename so an image-only message still
        // shows something meaningful in the notification.
        let preview = trimmed;
        if (!preview && hasFile) {
            preview = `📎 ${req.file.originalname}`;
        }
        await notify({
            recipientIds,
            actorId: req.user.id,
            type: 'MESSAGE_RECEIVED',
            title: req.user.email,
            body: preview.length > 140 ? `${preview.slice(0, 137)}...` : preview,
            conversationId: conv.id,
            projectId: conv.type === 'PROJECT' ? conv.projectId : null,
        });

        res.status(201).json({ message: signed });
    } catch (err) {
        next(err);
    }
});

router.post('/:id/read', async (req, res, next) => {
    try {
        await loadMyConversation(req.params.id, req.user.id);
        const now = new Date();
        await prisma.conversationParticipant.updateMany({
            where: { conversationId: req.params.id, userId: req.user.id },
            data: { lastReadAt: now },
        });
        realtime.emitToConversation(req.params.id, 'conversation:read', {
            conversationId: req.params.id,
            userId: req.user.id,
            lastReadAt: now,
        });
        // Drop any "new message" bell notifications attached to this chat;
        // opening the conversation should make them disappear immediately.
        const cleared = await clearChatNotificationsForConversation(
            req.user.id,
            req.params.id,
        );
        // Compute a fresh total so the sidebar badge can be set
        // directly from the server's view of the world. The old flow
        // tried to keep a local counter in sync by decrementing on
        // every open, which was easy to drift out of sync (notably
        // when both `message:new` and `notification:new` fired for the
        // same message and double-counted).
        const totalUnreadMessages = await computeTotalUnreadMessages(
            req.user.id,
        );
        res.json({
            ok: true,
            lastReadAt: now,
            clearedNotificationIds: cleared.ids,
            unreadNotifications: cleared.unread,
            totalUnreadMessages,
        });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id/leave', async (req, res, next) => {
    try {
        const c = await loadMyConversation(req.params.id, req.user.id);
        if (c.type === 'DM') {
            throw httpError(400, 'You cannot leave a direct message');
        }
        await prisma.conversationParticipant.deleteMany({
            where: { conversationId: c.id, userId: req.user.id },
        });
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// Delete a whole conversation, including its history.
// - DM: any participant can delete it (their counterpart loses the
//   history too — by definition a 1:1 chat has no neutral keeper).
// - PROJECT: only admins. Project rooms are tied to the project
//   itself and the chat is shared between every project participant.
router.delete('/:id', async (req, res, next) => {
    try {
        const c = await loadMyConversation(req.params.id, req.user.id);
        if (c.type === 'PROJECT' && !isAdmin(req)) {
            throw httpError(
                403,
                'Only admins can delete a project conversation',
            );
        }

        // Clean up file attachments from disk before we drop the
        // rows (cascade) so the upload folder doesn't grow forever.
        const attachments = await prisma.messageAttachment.findMany({
            where: { message: { conversationId: c.id } },
            select: { fileUrl: true },
        });
        for (const a of attachments) {
            try {
                removeFileSafe(a.fileUrl);
            } catch {
                /* best effort */
            }
        }

        await prisma.conversation.delete({ where: { id: c.id } });

        realtime.emitToConversation(c.id, 'conversation:deleted', {
            conversationId: c.id,
        });
        // Project rooms are looked up by projectId on the client (so
        // it shows up immediately the next time the project page is
        // opened) — surface that fact in the response so the caller
        // can refresh their cache.
        res.json({ ok: true, projectId: c.type === 'PROJECT' ? c.projectId : null });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
