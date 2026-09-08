import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { io } from 'socket.io-client';

import { api, getAccessToken } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import {
    isChatMuted as readChatMuted,
    setChatMuted as persistChatMuted,
    getChatSoundId,
    setChatSoundId as persistChatSoundId,
    playMessageSound,
    primeAudio,
    installAudioGestureUnlock,
} from '@/lib/notificationSound';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const RealtimeContext = createContext(null);

export function RealtimeProvider({ children }) {
    const { user } = useAuth();
    const [socket, setSocket] = useState(null);
    const [presence, setPresence] = useState(() => new Set());
    const [unreadNotifications, setUnreadNotifications] = useState(0);
    const [unreadMessages, setUnreadMessages] = useState(0);
    const [recentNotifications, setRecentNotifications] = useState([]);
    const [pendingUserCount, setPendingUserCount] = useState(0);
    const [todoAlertCount, setTodoAlertCount] = useState(0);
    const [pendingReassignmentCount, setPendingReassignmentCount] = useState(0);
    const [chatMuted, setChatMutedState] = useState(() => readChatMuted());
    const [chatSoundId, setChatSoundIdState] = useState(() => getChatSoundId());

    // Always read the freshest mute value inside the socket handler so
    // toggling the bell takes effect without resubscribing the socket.
    const chatMutedRef = useRef(chatMuted);
    const chatSoundIdRef = useRef(chatSoundId);
    useEffect(() => {
        chatMutedRef.current = chatMuted;
    }, [chatMuted]);
    useEffect(() => {
        chatSoundIdRef.current = chatSoundId;
    }, [chatSoundId]);

    const isAdmin = user?.role === 'ADMIN';

    const setChatMuted = useCallback((nextOrUpdater) => {
        setChatMutedState((prev) => {
            const next =
                typeof nextOrUpdater === 'function'
                    ? nextOrUpdater(prev)
                    : Boolean(nextOrUpdater);
            persistChatMuted(next);
            // Unmuting (or any explicit interaction) is a good moment to
            // unlock the AudioContext that browsers gate behind a gesture.
            if (!next) primeAudio();
            return next;
        });
    }, []);

    const setChatSoundId = useCallback((soundId) => {
        const next = persistChatSoundId(soundId);
        setChatSoundIdState(next);
        return next;
    }, []);

    // Mutable subscriber registry so individual screens can listen to events
    // without re-creating the socket. Keyed by event name -> Set<callback>.
    const subscribersRef = useRef(new Map());

    // Conversation the user is actively reading (Messages page, chat
    // widget, or project panel). Suppresses badge + sound for that room
    // while still letting subscribers append live lines.
    const viewingConversationIdRef = useRef(null);
    const seenMessageIdsRef = useRef(new Set());

    const setViewingConversation = useCallback((conversationId) => {
        viewingConversationIdRef.current = conversationId || null;
    }, []);

    const rememberMessageId = useCallback((messageId) => {
        if (!messageId) return true;
        const seen = seenMessageIdsRef.current;
        if (seen.has(messageId)) return true;
        seen.add(messageId);
        if (seen.size > 300) {
            const keep = [...seen].slice(-150);
            seenMessageIdsRef.current = new Set(keep);
        }
        return false;
    }, []);

    const subscribe = useCallback((event, handler) => {
        const map = subscribersRef.current;
        if (!map.has(event)) map.set(event, new Set());
        map.get(event).add(handler);
        return () => {
            const set = map.get(event);
            if (set) set.delete(handler);
        };
    }, []);

    const dispatch = useCallback((event, payload) => {
        const set = subscribersRef.current.get(event);
        if (!set) return;
        for (const fn of set) {
            try {
                fn(payload);
            } catch (err) {
                console.error('Realtime subscriber failed:', err);
            }
        }
    }, []);

    // Bootstrap unread counts whenever we have a logged-in user. Doing this on
    // top of the live socket pushes covers the case where a notification or
    // message landed while we were offline.
    const refreshCounts = useCallback(async () => {
        if (!user) {
            setUnreadNotifications(0);
            setUnreadMessages(0);
            setRecentNotifications([]);
            setPendingUserCount(0);
            setTodoAlertCount(0);
            setPendingReassignmentCount(0);
            return;
        }
        try {
            const [n, m, recent, todos] = await Promise.all([
                api.get('/notifications/unread-count'),
                api.get('/conversations/unread-count'),
                api.get('/notifications', { params: { limit: 20 } }),
                api.get('/todos/summary'),
            ]);
            setUnreadNotifications(n.data.unread || 0);
            setUnreadMessages(m.data.unread || 0);
            setRecentNotifications(recent.data.notifications || []);
            setTodoAlertCount(todos.data.counts?.alert || 0);
        } catch {
            // Silently ignore \u2014 the bell will simply show 0 until next refresh.
        }
        if (isAdmin) {
            try {
                const { data } = await api.get('/users/pending-count');
                setPendingUserCount(data.pending || 0);
            } catch {
                // ignore
            }
        } else {
            setPendingUserCount(0);
        }
        // Reassignment proposals are visible to everyone (own / about-me
        // counts for regular users, full queue for admin/manager). The
        // endpoint already scopes by role so the FE doesn't have to.
        try {
            const { data } = await api.get('/reassignments/pending-count');
            setPendingReassignmentCount(data.pending || 0);
        } catch {
            setPendingReassignmentCount(0);
        }
    }, [user, isAdmin]);

    useEffect(() => {
        if (!user) {
            setSocket((s) => {
                s?.disconnect();
                return null;
            });
            return undefined;
        }

        const token = getAccessToken();
        if (!token) return undefined;

        const sock = io(API_URL, {
            auth: { token },
            transports: ['websocket', 'polling'],
            withCredentials: true,
            reconnection: true,
        });

        sock.on('connect', () => {
            // Re-fetch counts on (re)connect to stay in sync.
            refreshCounts();
        });
        sock.io.on('reconnect', () => {
            refreshCounts();
        });

        sock.on('connect_error', (err) => {
            // Token may have expired \u2014 axios refresh flow handles HTTP, but
            // sockets need an explicit reconnect with the new token. Trigger a
            // soft refresh and reconnect.
            if (err?.message === 'Invalid token' || err?.message === 'Missing token') {
                api.get('/notifications/unread-count').catch(() => {});
                const fresh = getAccessToken();
                if (fresh && fresh !== token) {
                    sock.auth = { token: fresh };
                    sock.connect();
                }
            }
        });

        sock.on('presence:state', ({ online }) => {
            setPresence(new Set(online));
        });
        sock.on('presence:update', ({ userId, online }) => {
            setPresence((prev) => {
                const next = new Set(prev);
                if (online) next.add(userId);
                else next.delete(userId);
                return next;
            });
        });

        sock.on('notification:new', (notification) => {
            setRecentNotifications((prev) => [
                notification,
                ...prev.filter((n) => n.id !== notification.id),
            ].slice(0, 50));
            setUnreadNotifications((n) => n + 1);
            // NOTE: we used to bump `unreadMessages` here too, but
            // `notification:new` of type MESSAGE_RECEIVED fires on
            // the same event as `message:new` below — counting both
            // doubled the badge and made it stick at "1" after the
            // user opened the chat. The chat badge is now driven
            // exclusively by `message:new`, and the bell badge is
            // still driven by `unreadNotifications`.
            if (notification.type === 'USER_PENDING_APPROVAL' && isAdmin) {
                setPendingUserCount((c) => c + 1);
            }
            // Task-related events can change my open/overdue/due-today counts
            // because assigned project tasks now feed the to-do alert badge.
            // Refresh just the to-do summary so the sidebar dot stays accurate.
            const TASK_TYPES = new Set([
                'TASK_ASSIGNED',
                'TASK_STATUS_CHANGED',
                'TASK_DUE_DATE_CHANGED',
                'TASK_CREATED',
                // Deadline sweep alerts can move a task into the
                // overdue/alert bucket on the My To-do page, so
                // refresh the sidebar dot when one arrives.
                'TASK_DUE_SOON',
            ]);
            if (TASK_TYPES.has(notification.type)) {
                api.get('/todos/summary')
                    .then((res) =>
                        setTodoAlertCount(res.data.counts?.alert || 0),
                    )
                    .catch(() => {});
            }
            // Anything related to reassignments shifts the badge — let
            // the dedicated endpoint resolve the new number rather than
            // trying to keep a counter in sync ourselves.
            const REASSIGN_TYPES = new Set([
                'TASK_REASSIGN_PROPOSED',
                'TASK_REASSIGN_APPROVED',
                'TASK_REASSIGN_REJECTED',
            ]);
            if (REASSIGN_TYPES.has(notification.type)) {
                api.get('/reassignments/pending-count')
                    .then((res) =>
                        setPendingReassignmentCount(res.data.pending || 0),
                    )
                    .catch(() => {});
            }
            dispatch('notification:new', notification);
        });

        sock.on('message:new', (payload) => {
            dispatch('message:new', payload);
            const { message, conversationId } = payload || {};
            if (!message?.id || message.senderId === user.id) return;
            // Conversation room + user-room delivery can both fire for
            // the same message when the thread is open — count once.
            if (rememberMessageId(message.id)) return;
            // User is already reading this thread; live append only.
            if (viewingConversationIdRef.current === conversationId) return;
            setUnreadMessages((n) => n + 1);
            if (!chatMutedRef.current) {
                playMessageSound(chatSoundIdRef.current);
            }
        });

        sock.on('conversation:read', (payload) => {
            dispatch('conversation:read', payload);
        });

        // Server cleared a batch of notifications for me (e.g. I just
        // opened a chat). Drop them from the bell + recent list so the UI
        // catches up without waiting for a refetch.
        sock.on('notifications:cleared', ({ ids = [], unread } = {}) => {
            if (typeof unread === 'number') {
                setUnreadNotifications(unread);
            }
            if (ids.length) {
                const idSet = new Set(ids);
                setRecentNotifications((prev) =>
                    prev.map((n) => (idSet.has(n.id) ? { ...n, read: true } : n)),
                );
            }
        });

        sock.on('conversation:typing', (payload) => {
            dispatch('conversation:typing', payload);
        });

        // Plan-shape changes for any project room this socket has
        // joined. PhasesPlan uses this to either auto-refetch or
        // surface a "reload" button to the user.
        sock.on('project:plan-changed', (payload) => {
            dispatch('project:plan-changed', payload);
        });

        // A ticket had activity (new comment / status / assignment).
        // Broadcast to all clients so the shared portal queue can reorder
        // live and an open ticket can refresh its conversation.
        sock.on('ticket:activity', (payload) => {
            dispatch('ticket:activity', payload);
        });

        // A participant opened a ticket (advanced their read cursor) — lets
        // the sender's "Seen" marker update without a full refetch.
        sock.on('ticket:read', (payload) => {
            dispatch('ticket:read', payload);
        });

        // Authoritative pending-user count from the server. Keeps the Users
        // sidebar badge in sync across all admin sessions.
        sock.on('users:pending-count', ({ pending } = {}) => {
            if (typeof pending === 'number') setPendingUserCount(pending);
        });

        // A broadcast announcement was activated for this user — the
        // AnnouncementModal subscribes and refetches so it pops up live.
        sock.on('announcement:new', (payload) => {
            dispatch('announcement:new', payload);
        });

        setSocket(sock);
        return () => {
            sock.disconnect();
            setSocket(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.id]);

    useEffect(() => {
        refreshCounts();
    }, [refreshCounts]);

    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === 'visible') refreshCounts();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [refreshCounts]);

    // Browsers will keep the AudioContext suspended until the user has
    // interacted with the page. Without this, the very first chat ping
    // after sign-in is silent. Wire a one-shot global gesture listener
    // that unlocks the context the moment the user clicks/types anywhere.
    useEffect(() => {
        return installAudioGestureUnlock();
    }, []);

    const joinConversation = useCallback(
        (conversationId) => {
            socket?.emit('conversation:join', conversationId);
        },
        [socket],
    );
    const leaveConversation = useCallback(
        (conversationId) => {
            socket?.emit('conversation:leave', conversationId);
        },
        [socket],
    );
    const joinProject = useCallback(
        (projectId) => {
            if (!projectId) return;
            socket?.emit('project:join', projectId);
        },
        [socket],
    );
    const leaveProject = useCallback(
        (projectId) => {
            if (!projectId) return;
            socket?.emit('project:leave', projectId);
        },
        [socket],
    );
    const sendTyping = useCallback(
        (conversationId, typing) => {
            socket?.emit('conversation:typing', { conversationId, typing });
        },
        [socket],
    );

    const isOnline = useCallback(
        (userId) => presence.has(userId),
        [presence],
    );

    const markNotificationsRead = useCallback(async (ids) => {
        try {
            const { data } = await api.post('/notifications/mark-read', { ids });
            setUnreadNotifications(data.unread || 0);
            setRecentNotifications((prev) =>
                prev.map((n) =>
                    !ids || ids.includes(n.id) ? { ...n, read: true } : n,
                ),
            );
        } catch {
            // ignore
        }
    }, []);

    const decrementUnreadMessages = useCallback((delta) => {
        setUnreadMessages((n) => Math.max(0, n - (delta || 0)));
    }, []);

    // Drops to whatever the server says (or to 0) instead of trying
    // to keep a local running counter in sync. Used by the Messages
    // page after marking a conversation as read.
    const setUnreadMessagesTotal = useCallback((value) => {
        const n = Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0);
        setUnreadMessages(n);
    }, []);

    const value = useMemo(
        () => ({
            socket,
            presence,
            isOnline,
            unreadNotifications,
            unreadMessages,
            recentNotifications,
            pendingUserCount,
            todoAlertCount,
            setTodoAlertCount,
            pendingReassignmentCount,
            setPendingReassignmentCount,
            chatMuted,
            setChatMuted,
            chatSoundId,
            setChatSoundId,
            subscribe,
            joinConversation,
            leaveConversation,
            joinProject,
            leaveProject,
            sendTyping,
            markNotificationsRead,
            refreshCounts,
            decrementUnreadMessages,
            setUnreadMessagesTotal,
            setViewingConversation,
        }),
        [
            socket,
            presence,
            isOnline,
            unreadNotifications,
            unreadMessages,
            recentNotifications,
            pendingUserCount,
            todoAlertCount,
            pendingReassignmentCount,
            chatMuted,
            setChatMuted,
            chatSoundId,
            setChatSoundId,
            subscribe,
            joinConversation,
            leaveConversation,
            joinProject,
            leaveProject,
            sendTyping,
            markNotificationsRead,
            refreshCounts,
            decrementUnreadMessages,
            setUnreadMessagesTotal,
            setViewingConversation,
        ],
    );

    return (
        <RealtimeContext.Provider value={value}>
            {children}
        </RealtimeContext.Provider>
    );
}

export function useRealtime() {
    const ctx = useContext(RealtimeContext);
    if (!ctx) {
        // Outside the provider (e.g. on /login). Return a no-op shape so
        // call sites don't have to null-check.
        return {
            socket: null,
            presence: new Set(),
            isOnline: () => false,
            unreadNotifications: 0,
            unreadMessages: 0,
            recentNotifications: [],
            pendingUserCount: 0,
            todoAlertCount: 0,
            setTodoAlertCount: () => {},
            pendingReassignmentCount: 0,
            setPendingReassignmentCount: () => {},
            chatMuted: false,
            setChatMuted: () => {},
            chatSoundId: 'soft-tap',
            setChatSoundId: () => 'soft-tap',
            subscribe: () => () => {},
            joinConversation: () => {},
            leaveConversation: () => {},
            joinProject: () => {},
            leaveProject: () => {},
            sendTyping: () => {},
            markNotificationsRead: () => {},
            refreshCounts: () => {},
            decrementUnreadMessages: () => {},
            setUnreadMessagesTotal: () => {},
            setViewingConversation: () => {},
        };
    }
    return ctx;
}
