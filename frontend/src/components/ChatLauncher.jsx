import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { format, isSameDay } from 'date-fns';
import {
    ArrowLeft,
    ChevronDown,
    MessageSquare,
    Search,
    Send,
    UserSearch,
    X,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MentionTextarea } from '@/components/MentionTextarea';
import { renderWithRichTokens } from '@/lib/mentions';
import { useChatScrollToBottom } from '@/hooks/useChatScrollToBottom';
import { ChatSoundSelect } from '@/components/ChatSoundSelect';
import { primeAudio } from '@/lib/notificationSound';

function formatTime(d) {
    return format(new Date(d), 'h:mm a');
}

function formatDay(d) {
    return format(new Date(d), 'EEE, MMM d');
}

// Returns the "other" participant of a 1-on-1 conversation, falling back to
// the participants list if the dedicated `otherParticipants` field isn't
// populated.
function dmCounterpartId(convo, meId) {
    if (!convo) return null;
    if (convo.otherParticipants?.[0]?.id) return convo.otherParticipants[0].id;
    const other = (convo.participants || []).find((p) => p.id !== meId);
    return other?.id || null;
}

export function ChatLauncher() {
    const { user } = useAuth();
    const location = useLocation();
    const {
        unreadMessages,
        isOnline,
        subscribe,
        joinConversation,
        leaveConversation,
        sendTyping,
        decrementUnreadMessages,
        setUnreadMessagesTotal,
        chatMuted,
        setChatMuted,
        chatSoundId,
        setChatSoundId,
        setViewingConversation,
        socket,
    } = useRealtime();

    const [open, setOpen] = useState(false);
    const [users, setUsers] = useState([]);
    const [loadingUsers, setLoadingUsers] = useState(false);
    // Map<otherUserId, { conversationId, unreadCount, lastMessage }> built
    // from /conversations so each user row can show its unread badge and
    // last preview without us needing a separate API.
    const [dmIndex, setDmIndex] = useState(() => new Map());
    const [activeId, setActiveId] = useState(null);
    const [activeUser, setActiveUser] = useState(null);
    const [messages, setMessages] = useState([]);
    const [loadingMessages, setLoadingMessages] = useState(false);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [search, setSearch] = useState('');
    const [typingUsers, setTypingUsers] = useState(new Set());
    const typingTimer = useRef(null);
    const messagesScrollRef = useChatScrollToBottom({
        messages,
        ready: Boolean(activeId) && !loadingMessages,
        resetKey: activeId,
    });

    // Close the panel whenever the route changes while it's open — e.g.
    // the user clicked a task/project code chip inside the chat, which
    // navigates the page behind the widget. Closing reveals (and lets
    // them see the pulse on) the task they jumped to.
    const navKeyRef = useRef(location.key);
    useEffect(() => {
        if (navKeyRef.current !== location.key) {
            navKeyRef.current = location.key;
            setOpen(false);
        }
    }, [location.key]);

    // Hide the floater on auth pages where there's no user context
    // yet, and on the dedicated Messages page — having the launcher
    // overlap the composer's send button (and duplicate the inbox)
    // was confusing more than helpful.
    const hidden =
        !user ||
        location.pathname.startsWith('/login') ||
        location.pathname.startsWith('/register') ||
        location.pathname.startsWith('/messages');

    // The ticket detail has a reply composer pinned to the bottom-right.
    // Lift the floater (and its panel) above it so they don't overlap
    // the Send button.
    const liftAboveComposer = location.pathname.startsWith('/tickets');

    const loadUsers = async () => {
        setLoadingUsers(true);
        try {
            const { data } = await api.get('/users');
            const others = (data.users || []).filter(
                (u) => u.id !== user?.id && u.status !== 'SUSPENDED',
            );
            setUsers(others);
        } catch {
            toast.error('Failed to load users');
        } finally {
            setLoadingUsers(false);
        }
    };

    const loadDmIndex = async () => {
        try {
            const { data } = await api.get('/conversations');
            const map = new Map();
            for (const c of data.conversations || []) {
                if (c.type !== 'DM') continue;
                const otherId = dmCounterpartId(c, user?.id);
                if (!otherId) continue;
                map.set(otherId, {
                    conversationId: c.id,
                    unreadCount: c.unreadCount || 0,
                    lastMessage: c.lastMessage || null,
                });
            }
            setDmIndex(map);
        } catch {
            // Non-fatal: rows will just show no unread badge.
        }
    };

    // Load on first open. We deliberately reload on every open so unread
    // counts can't drift if the user was reading messages elsewhere.
    useEffect(() => {
        if (!open) return;
        primeAudio();
        loadUsers();
        loadDmIndex();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // Live updates: bump unread badges and append messages into the active
    // thread when they belong to it. We also catch DMs we don't yet know
    // about (e.g. someone messages me first) by refetching the index.
    useEffect(() => {
        const off = subscribe('message:new', ({ message, conversationId }) => {
            if (open && activeId === conversationId) {
                setMessages((prev) =>
                    prev.find((m) => m.id === message.id)
                        ? prev
                        : [...prev, message],
                );
                api.post(`/conversations/${activeId}/read`).catch(() => {});
            }
            // Update the per-user index. We don't have the conversation type
            // in the payload so we only act on conversations we already know
            // about (which by construction are DMs in this widget).
            setDmIndex((prev) => {
                let updated = prev;
                let found = false;
                for (const [uid, entry] of prev.entries()) {
                    if (entry.conversationId !== conversationId) continue;
                    found = true;
                    const isMine = message.senderId === user?.id;
                    const stayingActive = activeId === conversationId && open;
                    const next = new Map(prev);
                    next.set(uid, {
                        ...entry,
                        lastMessage: message,
                        unreadCount:
                            isMine || stayingActive
                                ? entry.unreadCount
                                : (entry.unreadCount || 0) + 1,
                    });
                    updated = next;
                    break;
                }
                if (!found && open) {
                    // Could be a new DM we haven't seen yet — refresh lazily.
                    loadDmIndex();
                }
                return updated;
            });
        });
        return off;
    }, [subscribe, activeId, open, user?.id]);

    useEffect(() => {
        const off = subscribe(
            'conversation:typing',
            ({ conversationId, userId, typing }) => {
                if (conversationId !== activeId) return;
                if (userId === user?.id) return;
                setTypingUsers((prev) => {
                    const next = new Set(prev);
                    if (typing) next.add(userId);
                    else next.delete(userId);
                    return next;
                });
            },
        );
        return off;
    }, [subscribe, activeId, user?.id]);

    useEffect(() => {
        if (open && activeId) setViewingConversation(activeId);
        else setViewingConversation(null);
        return () => setViewingConversation(null);
    }, [open, activeId, setViewingConversation]);

    // Open / close a thread inside the widget. Joining the conversation
    // socket-side enables typing events and presence on the room.
    useEffect(() => {
        if (!activeId) {
            setMessages([]);
            return undefined;
        }
        joinConversation(activeId);
        let cancelled = false;
        setMessages([]);
        setLoadingMessages(true);
        (async () => {
            try {
                const { data } = await api.get(
                    `/conversations/${activeId}/messages`,
                    { params: { limit: 60 } },
                );
                if (!cancelled) setMessages(data.messages || []);
            } catch {
                toast.error('Failed to load messages');
            } finally {
                if (!cancelled) setLoadingMessages(false);
            }
            try {
                // Server returns the fresh total so we sync the
                // sidebar badge from the authoritative source instead
                // of running a local subtraction that can drift.
                const { data: readData } = await api.post(
                    `/conversations/${activeId}/read`,
                );
                if (typeof readData?.totalUnreadMessages === 'number') {
                    setUnreadMessagesTotal(readData.totalUnreadMessages);
                }
                setDmIndex((prev) => {
                    const next = new Map(prev);
                    for (const [uid, entry] of next.entries()) {
                        if (entry.conversationId === activeId && entry.unreadCount) {
                            next.set(uid, { ...entry, unreadCount: 0 });
                        }
                    }
                    return next;
                });
            } catch {
                // ignore
            }
        })();
        return () => {
            cancelled = true;
            leaveConversation(activeId);
            setTypingUsers(new Set());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId]);

    // Re-sync the open thread without clearing it. Live `message:new`
    // pushes normally keep the thread current, but if the socket napped
    // (backgrounded tab, sleep, a network blip) a message sent during the
    // gap is missed — and the user previously had to leave the thread and
    // re-open it to see it. Refetch on socket reconnect and whenever the
    // tab regains focus so new lines appear on their own.
    const refetchActiveThread = useCallback(async () => {
        if (!activeId) return;
        try {
            const { data } = await api.get(
                `/conversations/${activeId}/messages`,
                { params: { limit: 60 } },
            );
            setMessages(data.messages || []);
            api.post(`/conversations/${activeId}/read`).catch(() => {});
        } catch {
            /* ignore — the live socket will catch up if it reconnects */
        }
    }, [activeId]);

    useEffect(() => {
        if (!open || !activeId) return undefined;
        const onVisible = () => {
            if (document.visibilityState === 'visible') refetchActiveThread();
        };
        document.addEventListener('visibilitychange', onVisible);
        const mgr = socket?.io;
        const onReconnect = () => refetchActiveThread();
        mgr?.on?.('reconnect', onReconnect);
        return () => {
            document.removeEventListener('visibilitychange', onVisible);
            mgr?.off?.('reconnect', onReconnect);
        };
    }, [open, activeId, socket, refetchActiveThread]);

    // Decorate user rows with the most relevant data we have for ordering
    // and rendering: online status, unread count, last message preview.
    const decoratedUsers = useMemo(() => {
        const list = users.map((u) => {
            const dm = dmIndex.get(u.id);
            return {
                ...u,
                online: isOnline(u.id),
                unreadCount: dm?.unreadCount || 0,
                lastMessage: dm?.lastMessage || null,
                conversationId: dm?.conversationId || null,
            };
        });
        const q = search.trim().toLowerCase();
        const filtered = q
            ? list.filter((u) => {
                  const local = (u.email || '').split('@')[0].toLowerCase();
                  return (
                      u.name.toLowerCase().includes(q) ||
                      (u.email || '').toLowerCase().includes(q) ||
                      local.startsWith(q)
                  );
              })
            : list;
        // Sort: unread first, then online, then recent message, then name.
        return filtered.sort((a, b) => {
            if ((b.unreadCount > 0) !== (a.unreadCount > 0)) {
                return b.unreadCount - a.unreadCount;
            }
            if (a.online !== b.online) return a.online ? -1 : 1;
            const aT = a.lastMessage?.createdAt
                ? new Date(a.lastMessage.createdAt).getTime()
                : 0;
            const bT = b.lastMessage?.createdAt
                ? new Date(b.lastMessage.createdAt).getTime()
                : 0;
            if (aT !== bT) return bT - aT;
            return (a.name || '').localeCompare(b.name || '');
        });
    }, [users, dmIndex, isOnline, search]);

    const openChatWith = async (otherUser) => {
        const existingId = dmIndex.get(otherUser.id)?.conversationId;
        if (existingId) {
            setActiveUser(otherUser);
            setActiveId(existingId);
            return;
        }
        try {
            const { data } = await api.post('/conversations/dm', {
                userId: otherUser.id,
            });
            setDmIndex((prev) => {
                const next = new Map(prev);
                next.set(otherUser.id, {
                    conversationId: data.conversation.id,
                    unreadCount: 0,
                    lastMessage: null,
                });
                return next;
            });
            setActiveUser(otherUser);
            setActiveId(data.conversation.id);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not start chat');
        }
    };

    const closeActive = () => {
        setActiveId(null);
        setActiveUser(null);
    };

    const sendMessage = async () => {
        const content = draft.trim();
        if (!content || !activeId || sending) return;
        setSending(true);
        try {
            const { data } = await api.post(
                `/conversations/${activeId}/messages`,
                { content },
            );
            setMessages((prev) =>
                prev.find((m) => m.id === data.message.id)
                    ? prev
                    : [...prev, data.message],
            );
            // Refresh the row's preview so reordering reflects the new send.
            setDmIndex((prev) => {
                if (!activeUser) return prev;
                const entry = prev.get(activeUser.id);
                if (!entry) return prev;
                const next = new Map(prev);
                next.set(activeUser.id, { ...entry, lastMessage: data.message });
                return next;
            });
            setDraft('');
            sendTyping(activeId, false);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Failed to send');
        } finally {
            setSending(false);
        }
    };

    const onTextChange = (v) => {
        setDraft(v);
        if (!activeId) return;
        sendTyping(activeId, true);
        if (typingTimer.current) clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => {
            sendTyping(activeId, false);
        }, 1500);
    };

    if (hidden) return null;

    return (
        <>
            {/* Floating button */}
            <button
                type="button"
                onClick={() => {
                    primeAudio();
                    setOpen((o) => !o);
                }}
                className={cn(
                    'group fixed right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full text-primary-foreground shadow-lg transition-all',
                    liftAboveComposer ? 'bottom-28' : 'bottom-5',
                    open
                        ? 'bg-muted text-foreground hover:bg-muted'
                        : 'bg-primary hover:scale-105',
                )}
                aria-label={open ? 'Close chat' : 'Open chat'}
                aria-expanded={open}
            >
                {open ? (
                    <ChevronDown className="h-6 w-6" />
                ) : (
                    <MessageSquare className="h-6 w-6" />
                )}
                {!open && unreadMessages > 0 && (
                    <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-destructive px-1 text-[11px] font-semibold leading-none text-destructive-foreground ring-2 ring-background">
                        {unreadMessages > 99 ? '99+' : unreadMessages}
                    </span>
                )}
            </button>

            {/* Floating panel */}
            {open && (
                <div
                    role="dialog"
                    aria-label="Chat"
                    className={cn(
                        'fixed right-5 z-40 flex h-[min(560px,calc(100vh-7rem))] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl',
                        liftAboveComposer ? 'bottom-44' : 'bottom-24',
                    )}
                >
                    <PanelHeader
                        activeUser={activeUser}
                        onBack={closeActive}
                        onClose={() => setOpen(false)}
                        onToggleMute={() => setChatMuted(!chatMuted)}
                        muted={chatMuted}
                        soundId={chatSoundId}
                        onSoundChange={setChatSoundId}
                        isOnline={isOnline}
                    />

                    {!activeId ? (
                        <UserList
                            search={search}
                            setSearch={setSearch}
                            loading={loadingUsers}
                            users={decoratedUsers}
                            onPick={openChatWith}
                        />
                    ) : (
                        <ActiveChat
                            messages={messages}
                            loading={loadingMessages}
                            currentUserId={user?.id}
                            typingCount={typingUsers.size}
                            messagesScrollRef={messagesScrollRef}
                            draft={draft}
                            onTextChange={onTextChange}
                            sendMessage={sendMessage}
                            sending={sending}
                            label={activeUser?.name || 'Chat'}
                        />
                    )}
                </div>
            )}
        </>
    );
}

function PanelHeader({
    activeUser,
    onBack,
    onClose,
    onToggleMute,
    muted,
    soundId,
    onSoundChange,
    isOnline,
}) {
    if (!activeUser) {
        return (
            <div className="flex flex-col gap-2 border-b bg-background px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <UserSearch className="h-4 w-4 shrink-0 text-primary" />
                        <p className="truncate text-sm font-semibold">
                            Find someone
                        </p>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={onClose}
                        title="Close"
                    >
                        <X className="h-4 w-4" />
                    </Button>
                </div>
                <ChatSoundSelect
                    compact
                    soundId={soundId}
                    onSoundChange={onSoundChange}
                    muted={muted}
                    onMuteToggle={onToggleMute}
                    className="flex w-full items-center gap-1.5"
                />
            </div>
        );
    }

    const online = isOnline(activeUser.id);
    return (
        <div className="flex items-center gap-2 border-b bg-background px-2 py-2">
            <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={onBack}
                title="Back to people"
            >
                <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="relative shrink-0">
                <Avatar className="h-8 w-8">
                    {activeUser.avatarUrl && (
                        <AvatarImage
                            src={resolveAssetUrl(activeUser.avatarUrl)}
                            alt={activeUser.name}
                        />
                    )}
                    <AvatarFallback className="bg-primary/10 text-xs text-primary">
                        {initials(activeUser.name)}
                    </AvatarFallback>
                </Avatar>
                <span
                    className={cn(
                        'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-background',
                        online ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                    )}
                />
            </div>
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                    {activeUser.name}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                    {online ? 'Online' : activeUser.email || 'Offline'}
                </p>
            </div>
            <ChatSoundSelect
                compact
                soundId={soundId}
                onSoundChange={onSoundChange}
                muted={muted}
                onMuteToggle={onToggleMute}
                className="flex shrink-0 items-center gap-1"
            />
            <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={onClose}
                title="Close"
            >
                <X className="h-4 w-4" />
            </Button>
        </div>
    );
}

function UserList({ search, setSearch, loading, users, onPick }) {
    return (
        <div className="flex flex-1 flex-col overflow-hidden">
            <div className="border-b p-2">
                <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search people..."
                        className="h-8 pl-8 text-sm"
                        autoFocus
                    />
                </div>
            </div>
            <div className="flex-1 overflow-y-auto">
                {loading ? (
                    <p className="p-4 text-center text-sm text-muted-foreground">
                        Loading people...
                    </p>
                ) : users.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 p-8 text-center">
                        <UserSearch className="h-8 w-8 text-muted-foreground" />
                        <p className="text-sm font-medium">No matches</p>
                        <p className="text-xs text-muted-foreground">
                            {search
                                ? 'Try a different name or email.'
                                : "There aren't any other users yet."}
                        </p>
                    </div>
                ) : (
                    <ul className="divide-y">
                        {users.map((u) => (
                            <li key={u.id}>
                                <button
                                    type="button"
                                    onClick={() => onPick(u)}
                                    className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left hover:bg-accent"
                                >
                                    <div className="relative shrink-0">
                                        <Avatar className="h-9 w-9">
                                            {u.avatarUrl && (
                                                <AvatarImage
                                                    src={resolveAssetUrl(
                                                        u.avatarUrl,
                                                    )}
                                                    alt={u.name}
                                                />
                                            )}
                                            <AvatarFallback className="bg-primary/10 text-[11px] text-primary">
                                                {initials(u.name)}
                                            </AvatarFallback>
                                        </Avatar>
                                        <span
                                            className={cn(
                                                'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background',
                                                u.online
                                                    ? 'bg-emerald-500'
                                                    : 'bg-muted-foreground/40',
                                            )}
                                            aria-hidden
                                        />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <p className="truncate text-sm font-medium">
                                                {u.name}
                                            </p>
                                            {u.lastMessage && (
                                                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                                                    {formatTime(
                                                        u.lastMessage.createdAt,
                                                    )}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <p className="truncate text-xs text-muted-foreground">
                                                {u.lastMessage
                                                    ? u.lastMessage.content
                                                    : u.email}
                                            </p>
                                            {u.unreadCount > 0 && (
                                                <span className="ml-auto inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                                                    {u.unreadCount > 99
                                                        ? '99+'
                                                        : u.unreadCount}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

function ActiveChat({
    messages,
    loading,
    currentUserId,
    typingCount,
    messagesScrollRef,
    draft,
    onTextChange,
    sendMessage,
    sending,
    label,
}) {
    return (
        <>
            <div
                ref={messagesScrollRef}
                className="flex-1 overflow-y-auto bg-muted/30 px-3 py-3"
            >
                {loading ? (
                    <p className="text-center text-sm text-muted-foreground">
                        Loading...
                    </p>
                ) : messages.length === 0 ? (
                    <p className="text-center text-sm text-muted-foreground">
                        Start the conversation.
                    </p>
                ) : (
                    <CompactMessageList
                        messages={messages}
                        currentUserId={currentUserId}
                    />
                )}
                {typingCount > 0 && (
                    <p className="mt-2 text-[11px] italic text-muted-foreground">
                        {typingCount > 1 ? 'Several people typing...' : 'typing...'}
                    </p>
                )}
            </div>
            <div className="border-t bg-background p-2">
                <div className="flex items-end gap-2">
                    {/* MentionTextarea adds the `/` picker (type `/` then
                        a code or title to reference a task / subtask /
                        project). Its own key handling claims Enter only
                        while the picker is open; otherwise Enter falls
                        through to send. Wrapped so it fills the row. */}
                    <div className="min-w-0 flex-1">
                        <MentionTextarea
                            value={draft}
                            onChange={(e) => onTextChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    sendMessage();
                                }
                            }}
                            placeholder={`Message ${label}… (type / to link a task or project)`}
                            className="min-h-[36px] text-sm"
                            participants={[]}
                            slashIncludeProjects
                            qualifySlashCodes
                            popoverPlacement="top"
                        />
                    </div>
                    <Button
                        size="icon"
                        className="h-9 w-9 shrink-0"
                        disabled={!draft.trim() || sending}
                        onClick={sendMessage}
                    >
                        <Send className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </>
    );
}

function CompactMessageList({ messages, currentUserId }) {
    const elements = [];
    let lastDay = null;
    for (const m of messages) {
        const day = new Date(m.createdAt);
        if (!lastDay || !isSameDay(day, lastDay)) {
            elements.push(
                <div
                    key={`day-${m.id}`}
                    className="my-1.5 flex items-center justify-center"
                >
                    <span className="rounded-full bg-background px-2 py-0.5 text-[10px] text-muted-foreground shadow-sm">
                        {formatDay(m.createdAt)}
                    </span>
                </div>,
            );
            lastDay = day;
        }
        const mine = m.senderId === currentUserId;
        elements.push(
            <div
                key={m.id}
                className={cn('mb-1.5 flex items-end gap-2', mine && 'flex-row-reverse')}
            >
                {!mine && (
                    <Avatar className="h-6 w-6 shrink-0">
                        {m.sender?.avatarUrl && (
                            <AvatarImage
                                src={resolveAssetUrl(m.sender.avatarUrl)}
                                alt={m.sender.name}
                            />
                        )}
                        <AvatarFallback className="bg-primary/10 text-[9px] text-primary">
                            {initials(m.sender?.name)}
                        </AvatarFallback>
                    </Avatar>
                )}
                <div
                    className={cn(
                        'max-w-[75%] rounded-2xl px-3 py-1.5 text-sm shadow-sm',
                        mine
                            ? 'rounded-br-sm bg-primary text-primary-foreground'
                            : 'rounded-bl-sm bg-background',
                    )}
                >
                    {!mine && (
                        <p className="text-[10px] font-medium opacity-80">
                            {m.sender?.name}
                        </p>
                    )}
                    <p
                        className={cn(
                            'whitespace-pre-wrap break-words text-[13px]',
                            // Task/project code chips use `text-primary`,
                            // which is invisible on a primary-colored
                            // "mine" bubble. Recolor any linked chip so
                            // the reference stays readable.
                            mine &&
                                '[&_a]:!border-primary-foreground/40 [&_a]:!bg-primary-foreground/20 [&_a]:!text-primary-foreground',
                        )}
                    >
                        {renderWithRichTokens(m.content)}
                    </p>
                    <p
                        className={cn(
                            'mt-0.5 text-right text-[9px]',
                            mine
                                ? 'text-primary-foreground/70'
                                : 'text-muted-foreground',
                        )}
                    >
                        {formatTime(m.createdAt)}
                    </p>
                </div>
            </div>,
        );
    }
    return <div>{elements}</div>;
}
