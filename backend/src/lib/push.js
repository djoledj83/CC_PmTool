// Expo push notifications.
//
// We talk to Expo's push service directly over HTTPS (no SDK needed):
//   POST https://exp.host/--/api/v2/push/send  with up to 100 messages.
// Tokens live in the PushToken table (one per device per user). Expo
// returns per-message tickets; a "DeviceNotRegistered" error means the
// token is dead, so we prune it.
const prisma = require('./prisma');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK = 100;

function isExpoToken(t) {
    return (
        typeof t === 'string' &&
        (t.startsWith('ExponentPushToken[') || t.startsWith('ExpoPushToken['))
    );
}

async function sendChunk(messages) {
    try {
        const res = await fetch(EXPO_PUSH_URL, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(messages),
        });
        const json = await res.json().catch(() => null);
        return json?.data || [];
    } catch (err) {
        console.warn('[push] send failed:', err.message);
        return [];
    }
}

// Fan a notification out to every device of the given users. Best-effort
// and fire-and-forget friendly — never throws.
async function pushToUsers(userIds, { title, body, data } = {}) {
    try {
        const ids = Array.from(new Set((userIds || []).filter(Boolean)));
        if (ids.length === 0) return;

        const rows = await prisma.pushToken.findMany({
            where: { userId: { in: ids } },
            select: { token: true },
        });
        const tokens = rows.map((r) => r.token).filter(isExpoToken);
        if (tokens.length === 0) return;

        const messages = tokens.map((to) => ({
            to,
            title: title || 'PM Tool',
            body: body || '',
            data: data || {},
            sound: 'default',
            channelId: 'default',
            priority: 'high',
        }));

        const deadTokens = [];
        for (let i = 0; i < messages.length; i += CHUNK) {
            const slice = messages.slice(i, i + CHUNK);
            const tickets = await sendChunk(slice);
            tickets.forEach((t, idx) => {
                if (
                    t?.status === 'error' &&
                    t?.details?.error === 'DeviceNotRegistered'
                ) {
                    deadTokens.push(slice[idx].to);
                }
            });
        }

        if (deadTokens.length) {
            await prisma.pushToken
                .deleteMany({ where: { token: { in: deadTokens } } })
                .catch(() => {});
        }
    } catch (err) {
        console.warn('[push] pushToUsers failed:', err.message);
    }
}

// Diagnostic: send a test push to one user and return Expo's raw
// tickets so we can see exactly what the push service says (ok / error,
// and which error — e.g. missing FCM credentials shows up here).
async function sendTestToUser(userId) {
    const rows = await prisma.pushToken.findMany({
        where: { userId },
        select: { token: true },
    });
    const tokens = rows.map((r) => r.token).filter(isExpoToken);
    if (tokens.length === 0) {
        return { tokenCount: 0, tickets: [], note: 'No push tokens registered for this user.' };
    }
    const messages = tokens.map((to) => ({
        to,
        title: 'PM Tool test',
        body: 'If you see this, push works 🎉',
        sound: 'default',
        channelId: 'default',
        priority: 'high',
    }));
    const tickets = await sendChunk(messages);
    return { tokenCount: tokens.length, tickets };
}

module.exports = { pushToUsers, isExpoToken, sendTestToUser };
