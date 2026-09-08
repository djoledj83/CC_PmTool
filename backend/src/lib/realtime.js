const { Server } = require('socket.io');

const { verifyAccessToken } = require('./jwt');
const prisma = require('./prisma');

// Verify that `userId` is allowed to subscribe to `conversationId`.
// Mirrors the HTTP-side `loadMyConversation` check in
// routes/conversations.js so the socket and HTTP surfaces enforce the
// exact same membership rules. Returns true/false (never throws); the
// caller decides what to do with a "no".
//
// `isProjectParticipant` is required lazily because `lib/notify.js`
// already requires us — pulling it in eagerly would hand us a
// half-initialised module due to the circular import.
async function userCanReadConversation(conversationId, userId) {
    if (!conversationId || !userId) return false;
    if (typeof conversationId !== 'string' || conversationId.length > 64) {
        return false;
    }
    try {
        const convo = await prisma.conversation.findUnique({
            where: { id: conversationId },
            select: {
                type: true,
                projectId: true,
                participants: { select: { userId: true } },
            },
        });
        if (!convo) return false;
        if (convo.type === 'DM') {
            return convo.participants.some((p) => p.userId === userId);
        }
        if (!convo.projectId) return false;
        const { isProjectParticipant } = require('./notify');
        return Boolean(await isProjectParticipant(convo.projectId, userId));
    } catch {
        return false;
    }
}

// Mirrors the HTTP `assertProjectRead` contract for the realtime
// surface: admins can join any project room, everyone else must own
// or be a participant of the project. Same lazy-require dance as
// `userCanReadConversation` to dodge the circular import via
// `lib/notify`.
async function userCanReadProject(projectId, userId, role) {
    if (!projectId || !userId) return false;
    if (typeof projectId !== 'string' || projectId.length > 64) return false;
    if (role === 'ADMIN') return true;
    try {
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { ownerId: true },
        });
        if (!project) return false;
        if (project.ownerId === userId) return true;
        const { isProjectParticipant } = require('./notify');
        return Boolean(await isProjectParticipant(projectId, userId));
    } catch {
        return false;
    }
}

let io = null;

// Map<userId, Set<socketId>> — multiple sockets per user (multi-tab / multi-device)
const userSockets = new Map();

function userRoom(userId) {
    return `user:${userId}`;
}

function conversationRoom(conversationId) {
    return `conversation:${conversationId}`;
}

function projectRoom(projectId) {
    return `project:${projectId}`;
}

function isOnline(userId) {
    const set = userSockets.get(userId);
    return Boolean(set && set.size);
}

function getOnlineUserIds() {
    return Array.from(userSockets.keys());
}

function emitToUser(userId, event, payload) {
    if (!io) return;
    io.to(userRoom(userId)).emit(event, payload);
}

function emitToUsers(userIds, event, payload) {
    if (!io || !userIds || !userIds.length) return;
    const rooms = Array.from(new Set(userIds.filter(Boolean))).map(userRoom);
    if (rooms.length === 0) return;
    io.to(rooms).emit(event, payload);
}

function emitToConversation(conversationId, event, payload) {
    if (!io) return;
    io.to(conversationRoom(conversationId)).emit(event, payload);
}

function emitToProject(projectId, event, payload) {
    if (!io || !projectId) return;
    io.to(projectRoom(projectId)).emit(event, payload);
}

function broadcastPresence(userId, online) {
    if (!io) return;
    io.emit('presence:update', { userId, online });
}

// Broadcast to every connected client (used for shared-queue signals
// like "a ticket just had activity, bump it up the list").
function emitToAll(event, payload) {
    if (!io) return;
    io.emit(event, payload);
}

function init(httpServer, { corsOrigin } = {}) {
    io = new Server(httpServer, {
        cors: {
            origin: corsOrigin,
            credentials: true,
        },
    });

    io.use((socket, next) => {
        try {
            const token =
                socket.handshake.auth?.token ||
                (socket.handshake.headers?.authorization || '').replace(
                    /^Bearer\s+/i,
                    '',
                );
            if (!token) return next(new Error('Missing token'));
            const payload = verifyAccessToken(token);
            socket.data.user = {
                id: payload.sub,
                email: payload.email,
                role: payload.role || 'USER',
            };
            return next();
        } catch (err) {
            return next(new Error('Invalid token'));
        }
    });

    io.on('connection', (socket) => {
        const { id: userId } = socket.data.user;

        socket.join(userRoom(userId));

        let bucket = userSockets.get(userId);
        const wasOnline = Boolean(bucket && bucket.size);
        if (!bucket) {
            bucket = new Set();
            userSockets.set(userId, bucket);
        }
        bucket.add(socket.id);

        // Initial state for the just-connected client.
        socket.emit('presence:state', { online: getOnlineUserIds() });

        // Tell everyone else this user just came online (only on first socket).
        if (!wasOnline) broadcastPresence(userId, true);

        // Conversation-room subscriptions: a client tells us which DM /
        // project rooms it cares about (so message:new events get there).
        // We MUST check membership before joining the room, otherwise
        // an attacker who knows or guesses a conversation id would get
        // every new message in that room — bypassing the carefully
        // checked HTTP routes. The check mirrors the HTTP-side
        // `loadMyConversation` logic exactly.
        socket.on('conversation:join', async (conversationId, ack) => {
            const ok = await userCanReadConversation(conversationId, userId);
            if (!ok) {
                if (typeof ack === 'function') ack({ ok: false });
                return;
            }
            socket.join(conversationRoom(conversationId));
            if (typeof ack === 'function') ack({ ok: true });
        });
        socket.on('conversation:leave', (conversationId) => {
            if (typeof conversationId === 'string' && conversationId.length) {
                socket.leave(conversationRoom(conversationId));
            }
        });

        // Project-room subscriptions: the FE asks to be looped in on
        // any plan-changing event (task / note created, edited or
        // deleted) for the project page that's currently open. Same
        // membership rules as the HTTP routes — without this check
        // anyone could spy on every project's mutation stream.
        socket.on('project:join', async (projectId, ack) => {
            const role = socket.data.user?.role;
            const ok = await userCanReadProject(projectId, userId, role);
            if (!ok) {
                if (typeof ack === 'function') ack({ ok: false });
                return;
            }
            socket.join(projectRoom(projectId));
            if (typeof ack === 'function') ack({ ok: true });
        });
        socket.on('project:leave', (projectId) => {
            if (typeof projectId === 'string' && projectId.length) {
                socket.leave(projectRoom(projectId));
            }
        });

        // Lightweight typing indicator passthrough (not persisted).
        // Same membership check — otherwise anyone can spam fake "is
        // typing…" notifications into any conversation.
        socket.on('conversation:typing', async ({ conversationId, typing } = {}) => {
            if (!conversationId) return;
            const ok = await userCanReadConversation(conversationId, userId);
            if (!ok) return;
            socket.to(conversationRoom(conversationId)).emit('conversation:typing', {
                conversationId,
                userId,
                typing: Boolean(typing),
            });
        });

        socket.on('disconnect', () => {
            const set = userSockets.get(userId);
            if (!set) return;
            set.delete(socket.id);
            if (set.size === 0) {
                userSockets.delete(userId);
                broadcastPresence(userId, false);
            }
        });
    });

    return io;
}

module.exports = {
    init,
    isOnline,
    getOnlineUserIds,
    emitToUser,
    emitToUsers,
    emitToConversation,
    emitToProject,
    emitToAll,
    userRoom,
    conversationRoom,
    projectRoom,
    get io() {
        return io;
    },
};
