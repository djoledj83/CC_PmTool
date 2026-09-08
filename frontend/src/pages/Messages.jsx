import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { format, formatDistanceToNowStrict, isSameDay } from 'date-fns';
import {
    ArrowLeft,
    CheckCheck,
    Download,
    FileText,
    FolderKanban,
    MessageSquare,
    MoreHorizontal,
    Paperclip,
    Plus,
    Search,
    Send,
    Trash2,
    Users as UsersIcon,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { cn, formatBytes, initials, resolveAssetUrl } from '@/lib/utils';
import { TopBar } from '@/components/TopBar';
import { ChatSoundSelect } from '@/components/ChatSoundSelect';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MentionTextarea } from '@/components/MentionTextarea';
import { renderWithRichTokens } from '@/lib/mentions';
import { useChatScrollToBottom } from '@/hooks/useChatScrollToBottom';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const TAB_PROJECT = 'project';
const TAB_DIRECT = 'direct';
// Mirror of backend `ATTACHMENT_TTL_DAYS` so the composer can quote
// the same number ("Attachments expire after 30 days").
const ATTACHMENT_TTL_DAYS = 30;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function formatDay(d) {
    return format(new Date(d), 'EEE, MMM d');
}

function formatTime(d) {
    return format(new Date(d), 'h:mm a');
}

function dmCounterpart(c, currentUserId) {
    if (!c || c.type !== 'DM') return null;
    return (c.participants || []).find((p) => p.id !== currentUserId) || null;
}

function conversationLabel(c, currentUserId) {
    if (!c) return '';
    if (c.type === 'DM') {
        return dmCounterpart(c, currentUserId)?.name || 'Direct message';
    }
    return c.title || c.project?.name || 'Project chat';
}

function lastMessagePreview(c, currentUserId) {
    const last = c?.lastMessage;
    if (!last) return 'No messages yet';
    const prefix = last.senderId === currentUserId ? 'You: ' : '';
    if (last.content) return `${prefix}${last.content}`;
    if (last.attachments?.length) {
        return `${prefix}📎 ${last.attachments[0].fileName || 'Attachment'}`;
    }
    return `${prefix}…`;
}

export default function Messages() {
    const { user: currentUser } = useAuth();
    const isAdmin = currentUser?.role === 'ADMIN';
    const {
        joinConversation,
        leaveConversation,
        subscribe,
        sendTyping,
        chatMuted,
        setChatMuted,
        chatSoundId,
        setChatSoundId,
        setUnreadMessagesTotal,
        setViewingConversation,
    } = useRealtime();
    const [searchParams, setSearchParams] = useSearchParams();

    const [conversations, setConversations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState(
        searchParams.get('tab') === TAB_DIRECT ? TAB_DIRECT : TAB_PROJECT,
    );
    const [activeId, setActiveId] = useState(searchParams.get('c') || null);
    const [messages, setMessages] = useState([]);
    // `activeReads` is a Map<userId, Date> with each participant's
    // lastReadAt for the CURRENTLY OPEN conversation. We track it
    // separately from the conversation list so we can keep it
    // up-to-date in real time (via the `conversation:read` socket
    // event) and compute "Seen" indicators on the sender side
    // without forcing a full conversation refetch. We only need it
    // for the active conversation — sidebar rows don't show seen
    // markers.
    const [activeReads, setActiveReads] = useState(() => new Map());
    const [draft, setDraft] = useState('');
    const [pendingFile, setPendingFile] = useState(null);
    const [sending, setSending] = useState(false);
    const [search, setSearch] = useState('');
    const [typingUsers, setTypingUsers] = useState(new Set());
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [newDmOpen, setNewDmOpen] = useState(false);
    const fileInputRef = useRef(null);
    const messagesScrollRef = useChatScrollToBottom({
        messages,
        ready: Boolean(activeId),
        resetKey: activeId,
    });
    const typingTimer = useRef(null);

    const loadConversations = async () => {
        try {
            const { data } = await api.get('/conversations');
            const list = data.conversations || [];
            setConversations(list);
            return list;
        } catch {
            toast.error('Failed to load conversations');
            return [];
        }
    };

    useEffect(() => {
        (async () => {
            setLoading(true);
            await loadConversations();
            setLoading(false);
        })();
    }, []);

    // Keep the URL in sync with the active tab + open conversation so
    // page reloads return to the same view and notification deep-links
    // can jump straight to a specific chat.
    useEffect(() => {
        const next = new URLSearchParams(searchParams);
        if (tab !== next.get('tab')) next.set('tab', tab);
        if (activeId) next.set('c', activeId);
        else next.delete('c');
        const nextStr = next.toString();
        if (nextStr !== searchParams.toString()) {
            setSearchParams(next, { replace: true });
        }
    }, [tab, activeId]); // eslint-disable-line react-hooks/exhaustive-deps

    const projectConversations = useMemo(
        () => conversations.filter((c) => c.type === 'PROJECT'),
        [conversations],
    );
    const directConversations = useMemo(
        () => conversations.filter((c) => c.type === 'DM'),
        [conversations],
    );

    const tabUnreadProject = useMemo(
        () =>
            projectConversations.reduce(
                (s, c) => s + (c.unreadCount || 0),
                0,
            ),
        [projectConversations],
    );
    const tabUnreadDirect = useMemo(
        () =>
            directConversations.reduce(
                (s, c) => s + (c.unreadCount || 0),
                0,
            ),
        [directConversations],
    );

    const currentList = tab === TAB_DIRECT ? directConversations : projectConversations;
    const activeConversation = useMemo(
        () => conversations.find((c) => c.id === activeId) || null,
        [conversations, activeId],
    );

    // If a saved active conversation belongs to the other tab, hop tabs
    // so the user sees what they were last looking at instead of an
    // empty pane.
    useEffect(() => {
        if (!activeConversation) return;
        const wantedTab =
            activeConversation.type === 'DM' ? TAB_DIRECT : TAB_PROJECT;
        if (wantedTab !== tab) setTab(wantedTab);
    }, [activeConversation?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const want = searchParams.get('c');
        if (!want) return;
        if (conversations.find((c) => c.id === want)) {
            setActiveId(want);
        }
    }, [conversations, searchParams]);

    useEffect(() => {
        setViewingConversation(activeId || null);
        return () => setViewingConversation(null);
    }, [activeId, setViewingConversation]);

    useEffect(() => {
        if (!activeId) {
            setMessages([]);
            setPendingFile(null);
            return undefined;
        }
        joinConversation(activeId);
        let cancelled = false;
        setMessages([]);
        (async () => {
            try {
                const { data } = await api.get(
                    `/conversations/${activeId}/messages`,
                    { params: { limit: 100 } },
                );
                if (!cancelled) setMessages(data.messages);
            } catch {
                toast.error('Failed to load messages');
            }
            try {
                const { data: readData } = await api.post(
                    `/conversations/${activeId}/read`,
                );
                if (typeof readData?.totalUnreadMessages === 'number') {
                    setUnreadMessagesTotal(readData.totalUnreadMessages);
                }
                setConversations((prev) =>
                    prev.map((c) =>
                        c.id === activeId ? { ...c, unreadCount: 0 } : c,
                    ),
                );
            } catch {
                // ignore
            }
        })();
        return () => {
            cancelled = true;
            leaveConversation(activeId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeId]);

    useEffect(() => {
        const off = subscribe('message:new', ({ message, conversationId }) => {
            if (conversationId === activeId) {
                setMessages((prev) =>
                    prev.find((m) => m.id === message.id) ? prev : [...prev, message],
                );
                api.post(`/conversations/${activeId}/read`)
                    .then(({ data }) => {
                        if (typeof data?.totalUnreadMessages === 'number') {
                            setUnreadMessagesTotal(data.totalUnreadMessages);
                        }
                    })
                    .catch(() => {});
            } else {
                setConversations((prev) => {
                    const idx = prev.findIndex((c) => c.id === conversationId);
                    if (idx === -1) {
                        // Brand new conversation (e.g. someone DM'd us
                        // for the first time, or a new project room
                        // was just created). Refetch lazily so the
                        // sidebar shows the new row.
                        loadConversations();
                        return prev;
                    }
                    const c = prev[idx];
                    const updated = {
                        ...c,
                        lastMessage: message,
                        unreadCount:
                            message.senderId === currentUser?.id
                                ? c.unreadCount
                                : (c.unreadCount || 0) + 1,
                    };
                    const next = prev.slice();
                    next.splice(idx, 1);
                    next.unshift(updated);
                    return next;
                });
            }
        });
        return off;
    }, [subscribe, activeId, currentUser?.id]);

    useEffect(() => {
        const off = subscribe('conversation:typing', ({ conversationId, userId, typing }) => {
            if (conversationId !== activeId) return;
            if (userId === currentUser?.id) return;
            setTypingUsers((prev) => {
                const next = new Set(prev);
                if (typing) next.add(userId);
                else next.delete(userId);
                return next;
            });
        });
        return off;
    }, [subscribe, activeId, currentUser?.id]);

    // Seed `activeReads` from the conversation list ONCE per
    // active conversation. The backend embeds every participant's
    // `lastReadAt` in the conversation summary, so we can decide
    // straight away which of MY old messages have already been
    // seen by the other party (showing the "Seen" marker on the
    // most-recent one).
    //
    // We use a ref to track which conversation we've already
    // seeded for, otherwise every `setConversations` update (e.g.
    // a new message arriving on ANY conversation) would clobber
    // the live `activeReads` Map with the stale snapshot from the
    // conversation list — wiping out any `conversation:read`
    // events we received in the meantime.
    const seededReadsFor = useRef(null);
    useEffect(() => {
        if (!activeId) {
            setActiveReads(new Map());
            seededReadsFor.current = null;
            return;
        }
        if (seededReadsFor.current === activeId) return;
        const conv = conversations.find((c) => c.id === activeId);
        if (!conv?.participantReads) return;
        const next = new Map();
        for (const r of conv.participantReads) {
            next.set(r.userId, r.lastReadAt ? new Date(r.lastReadAt) : null);
        }
        setActiveReads(next);
        seededReadsFor.current = activeId;
    }, [activeId, conversations]);

    // Live-update read marks for the open conversation. The
    // backend emits `conversation:read` whenever any participant
    // hits POST /conversations/:id/read (i.e. opens the chat).
    // When that fires for the OTHER party in our currently-open
    // conversation, their lastReadAt jumps and the "Seen" marker
    // on my most-recent message catches up without a refetch.
    useEffect(() => {
        const off = subscribe(
            'conversation:read',
            ({ conversationId, userId, lastReadAt }) => {
                if (conversationId !== activeId) return;
                setActiveReads((prev) => {
                    const next = new Map(prev);
                    next.set(userId, lastReadAt ? new Date(lastReadAt) : null);
                    return next;
                });
            },
        );
        return off;
    }, [subscribe, activeId]);

    // The "Seen" cut-off for the active conversation: the latest
    // lastReadAt among OTHER participants. Anything I sent before
    // or at this timestamp counts as "seen". We pre-compute it
    // here rather than inside MessageList so the comparison stays
    // O(1) per message during render.
    const othersLastReadAt = useMemo(() => {
        if (!activeReads.size || !currentUser?.id) return null;
        let max = null;
        for (const [uid, t] of activeReads) {
            if (uid === currentUser.id) continue;
            if (!t) continue;
            if (!max || t > max) max = t;
        }
        return max;
    }, [activeReads, currentUser?.id]);

    // When the server tells us a conversation was deleted (by another
    // tab or another participant for a DM), drop it from the list and
    // close the pane if it was open.
    useEffect(() => {
        const off = subscribe('conversation:deleted', ({ conversationId }) => {
            setConversations((prev) => prev.filter((c) => c.id !== conversationId));
            if (activeId === conversationId) {
                setActiveId(null);
                setMessages([]);
            }
        });
        return off;
    }, [subscribe, activeId]);

    const sendMessage = async () => {
        const content = draft.trim();
        if ((!content && !pendingFile) || !activeId || sending) return;
        setSending(true);
        try {
            let response;
            if (pendingFile) {
                const form = new FormData();
                form.append('file', pendingFile);
                form.append('content', content);
                response = await api.post(
                    `/conversations/${activeId}/messages`,
                    form,
                    { headers: { 'Content-Type': 'multipart/form-data' } },
                );
            } else {
                response = await api.post(
                    `/conversations/${activeId}/messages`,
                    { content },
                );
            }
            const sent = response.data.message;
            setMessages((prev) =>
                prev.find((m) => m.id === sent.id) ? prev : [...prev, sent],
            );
            setDraft('');
            setPendingFile(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
            setConversations((prev) => {
                const idx = prev.findIndex((c) => c.id === activeId);
                if (idx === -1) return prev;
                const c = { ...prev[idx], lastMessage: sent };
                const next = prev.slice();
                next.splice(idx, 1);
                next.unshift(c);
                return next;
            });
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

    const onPickFile = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > MAX_ATTACHMENT_BYTES) {
            toast.error('File is too large (max 50 MB)');
            e.target.value = '';
            return;
        }
        setPendingFile(file);
    };

    const handleDelete = async () => {
        if (!deleteTarget) return;
        try {
            await api.delete(`/conversations/${deleteTarget.id}`);
            toast.success('Conversation deleted');
            setConversations((prev) => prev.filter((c) => c.id !== deleteTarget.id));
            if (activeId === deleteTarget.id) {
                setActiveId(null);
                setMessages([]);
            }
        } catch (err) {
            toast.error(err.response?.data?.error || 'Failed to delete');
        } finally {
            setDeleteTarget(null);
        }
    };

    const openDmWith = async (userId) => {
        try {
            const { data } = await api.post('/conversations/dm', { userId });
            const dm = data.conversation;
            setConversations((prev) => {
                if (prev.find((c) => c.id === dm.id)) return prev;
                return [dm, ...prev];
            });
            setTab(TAB_DIRECT);
            setActiveId(dm.id);
            setNewDmOpen(false);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Failed to open chat');
        }
    };

    // Handle `?dm=<userId>` deep-links — used by the "Message" button on
    // the User Profile page so any signed-in user can start a chat with
    // a teammate they were just looking at. If a DM with that user
    // already exists we just switch to it; otherwise we create one via
    // /conversations/dm. Either way the param is stripped from the URL
    // afterwards so a tab toggle or refresh doesn't re-trigger it.
    useEffect(() => {
        const dmTargetId = searchParams.get('dm');
        if (!dmTargetId) return;
        if (loading) return; // wait for initial conversation list
        if (currentUser?.id && dmTargetId === currentUser.id) {
            // Self-DM is meaningless — silently drop the param.
            const next = new URLSearchParams(searchParams);
            next.delete('dm');
            setSearchParams(next, { replace: true });
            return;
        }
        const existing = directConversations.find((c) =>
            (c.participants || []).some((p) => p.id === dmTargetId),
        );
        if (existing) {
            setTab(TAB_DIRECT);
            setActiveId(existing.id);
        } else {
            openDmWith(dmTargetId);
        }
        const next = new URLSearchParams(searchParams);
        next.delete('dm');
        setSearchParams(next, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams, loading, directConversations, currentUser?.id]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return currentList;
        return currentList.filter((c) => {
            const label = conversationLabel(c, currentUser?.id).toLowerCase();
            const last = (c.lastMessage?.content || '').toLowerCase();
            return label.includes(q) || last.includes(q);
        });
    }, [currentList, search, currentUser?.id]);

    const canDeleteActive = activeConversation
        ? activeConversation.type === 'DM' || isAdmin
        : false;

    return (
        <>
            <TopBar
                title="Messages"
                actions={
                    <ChatSoundSelect
                        soundId={chatSoundId}
                        onSoundChange={setChatSoundId}
                        muted={chatMuted}
                        onMuteToggle={() => setChatMuted(!chatMuted)}
                    />
                }
            />
            <main className="flex flex-1 overflow-hidden bg-muted/20">
                <aside
                    className={cn(
                        'flex w-full shrink-0 flex-col border-r bg-background md:w-[320px]',
                        activeId ? 'hidden md:flex' : 'flex',
                    )}
                >
                    <TabStrip
                        tab={tab}
                        onChange={(t) => {
                            setTab(t);
                            setActiveId(null);
                        }}
                        projectUnread={tabUnreadProject}
                        directUnread={tabUnreadDirect}
                    />
                    <div className="flex items-center gap-2 border-b p-3">
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder={
                                    tab === TAB_DIRECT
                                        ? 'Search people…'
                                        : 'Search projects…'
                                }
                                className="pl-8"
                            />
                        </div>
                        {tab === TAB_DIRECT && (
                            <Button
                                size="icon"
                                variant="default"
                                className="h-9 w-9 shrink-0"
                                title="Start a new direct message"
                                onClick={() => setNewDmOpen(true)}
                            >
                                <Plus className="h-4 w-4" />
                            </Button>
                        )}
                    </div>
                    <ConversationList
                        loading={loading}
                        tab={tab}
                        items={filtered}
                        activeId={activeId}
                        currentUserId={currentUser?.id}
                        onSelect={setActiveId}
                        onDeleteRequest={setDeleteTarget}
                        isAdmin={isAdmin}
                        onNewDm={() => setNewDmOpen(true)}
                    />
                </aside>

                <section
                    className={cn(
                        'flex flex-1 flex-col',
                        activeId ? 'flex' : 'hidden md:flex',
                    )}
                >
                    {!activeConversation ? (
                        <EmptyState tab={tab} onNewDm={() => setNewDmOpen(true)} />
                    ) : (
                        <>
                            <ConversationHeader
                                conversation={activeConversation}
                                currentUserId={currentUser?.id}
                                onBack={() => setActiveId(null)}
                                onDeleteRequest={
                                    canDeleteActive
                                        ? () => setDeleteTarget(activeConversation)
                                        : null
                                }
                            />

                            <div
                                ref={messagesScrollRef}
                                className="flex-1 overflow-y-auto bg-gradient-to-b from-muted/10 to-transparent px-3 py-3 sm:px-6 sm:py-4"
                            >
                                <MessageList
                                    messages={messages}
                                    currentUserId={currentUser?.id}
                                    othersLastReadAt={othersLastReadAt}
                                />
                                {typingUsers.size > 0 && (
                                    <p className="mt-2 text-xs italic text-muted-foreground">
                                        {typingUsers.size > 1
                                            ? 'Several people are typing…'
                                            : 'typing…'}
                                    </p>
                                )}
                            </div>

                            <Composer
                                draft={draft}
                                onChange={onTextChange}
                                onSend={sendMessage}
                                sending={sending}
                                pendingFile={pendingFile}
                                onClearFile={() => {
                                    setPendingFile(null);
                                    if (fileInputRef.current)
                                        fileInputRef.current.value = '';
                                }}
                                onPickFile={() => fileInputRef.current?.click()}
                                fileInputRef={fileInputRef}
                                onFileSelected={onPickFile}
                                placeholder={`Message ${conversationLabel(
                                    activeConversation,
                                    currentUser?.id,
                                )}…`}
                            />
                        </>
                    )}
                </section>
            </main>

            <DeleteConfirmDialog
                target={deleteTarget}
                currentUserId={currentUser?.id}
                onCancel={() => setDeleteTarget(null)}
                onConfirm={handleDelete}
            />

            <NewDmDialog
                open={newDmOpen}
                onClose={() => setNewDmOpen(false)}
                currentUserId={currentUser?.id}
                onPick={openDmWith}
            />
        </>
    );
}

function TabStrip({ tab, onChange, projectUnread, directUnread }) {
    const tabs = [
        {
            id: TAB_PROJECT,
            label: 'Project',
            icon: FolderKanban,
            unread: projectUnread,
        },
        {
            id: TAB_DIRECT,
            label: 'Direct',
            icon: MessageSquare,
            unread: directUnread,
        },
    ];
    return (
        <div className="flex items-stretch border-b">
            {tabs.map((t) => {
                const Icon = t.icon;
                const active = t.id === tab;
                return (
                    <button
                        key={t.id}
                        type="button"
                        onClick={() => onChange(t.id)}
                        className={cn(
                            'relative flex flex-1 items-center justify-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
                            active
                                ? 'border-primary text-foreground'
                                : 'border-transparent text-muted-foreground hover:text-foreground',
                        )}
                    >
                        <Icon className="h-4 w-4" />
                        <span>{t.label}</span>
                        {t.unread > 0 && (
                            <span
                                className={cn(
                                    'ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none',
                                    active
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-muted text-foreground',
                                )}
                            >
                                {t.unread > 99 ? '99+' : t.unread}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}

function ConversationList({
    loading,
    tab,
    items,
    activeId,
    currentUserId,
    onSelect,
    onDeleteRequest,
    isAdmin,
    onNewDm,
}) {
    if (loading) {
        return (
            <div className="flex-1 overflow-y-auto p-4 text-sm text-muted-foreground">
                Loading…
            </div>
        );
    }
    if (items.length === 0) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center text-sm text-muted-foreground">
                {tab === TAB_DIRECT ? (
                    <>
                        <MessageSquare className="h-8 w-8" />
                        <p className="font-medium text-foreground">
                            No direct messages yet
                        </p>
                        <p className="text-xs">
                            Start a 1-on-1 chat with a teammate.
                        </p>
                        <Button size="sm" className="mt-1 gap-2" onClick={onNewDm}>
                            <Plus className="h-3.5 w-3.5" />
                            New direct message
                        </Button>
                    </>
                ) : (
                    <>
                        <FolderKanban className="h-8 w-8" />
                        <p className="font-medium text-foreground">
                            No project chats yet
                        </p>
                        <p className="text-xs">
                            Open a project to start chatting with its
                            participants.
                        </p>
                    </>
                )}
            </div>
        );
    }
    return (
        <ul className="flex-1 overflow-y-auto">
            {items.map((c) => {
                const active = c.id === activeId;
                const isDm = c.type === 'DM';
                const canDelete = isDm || isAdmin;
                const dmUser = isDm ? dmCounterpart(c, currentUserId) : null;
                const title = conversationLabel(c, currentUserId);
                return (
                    <li
                        key={c.id}
                        className={cn(
                            'group flex items-center gap-2 border-b transition-colors',
                            active ? 'bg-primary/10' : 'hover:bg-accent',
                        )}
                    >
                        <button
                            type="button"
                            onClick={() => onSelect(c.id)}
                            className="flex flex-1 items-center gap-3 px-3 py-2.5 text-left"
                        >
                            {isDm ? (
                                <Avatar className="h-9 w-9 shrink-0">
                                    {dmUser?.avatarUrl && (
                                        <AvatarImage
                                            src={resolveAssetUrl(dmUser.avatarUrl)}
                                            alt={dmUser.name}
                                        />
                                    )}
                                    <AvatarFallback className="bg-primary/10 text-xs text-primary">
                                        {initials(dmUser?.name || title)}
                                    </AvatarFallback>
                                </Avatar>
                            ) : (
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                                    <FolderKanban className="h-4 w-4" />
                                </div>
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="truncate text-sm font-medium">
                                        {title}
                                    </p>
                                    {c.lastMessage && (
                                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                                            {formatTime(c.lastMessage.createdAt)}
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    <p className="truncate text-xs text-muted-foreground">
                                        {lastMessagePreview(c, currentUserId)}
                                    </p>
                                    {c.unreadCount > 0 && (
                                        <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-none text-primary-foreground">
                                            {c.unreadCount > 99 ? '99+' : c.unreadCount}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </button>
                        {canDelete && (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        type="button"
                                        // NOTE: this button stays in the DOM at full size at
                                        // all times — only its opacity changes on hover. The
                                        // previous version used `hidden` (display:none) which
                                        // gave Radix a 0x0 bounding rect when it tried to
                                        // anchor the dropdown, so the menu would pop in the
                                        // top-left corner of the screen instead of next to
                                        // the trigger. Keeping the layout intact fixes the
                                        // positioning while still letting us fade the icon
                                        // in/out on hover for a clean list.
                                        className="mr-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-70 transition-opacity hover:bg-background hover:text-foreground focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 md:opacity-0"
                                        title="Conversation actions"
                                    >
                                        <MoreHorizontal className="h-4 w-4" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-56">
                                    <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
                                        {isDm ? 'Direct message' : 'Project chat'}
                                    </DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        className="text-destructive focus:text-destructive"
                                        onSelect={(e) => {
                                            e.preventDefault();
                                            onDeleteRequest(c);
                                        }}
                                    >
                                        <Trash2 className="mr-2 h-4 w-4" />
                                        Delete conversation
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

function ConversationHeader({
    conversation,
    currentUserId,
    onBack,
    onDeleteRequest,
}) {
    const isDm = conversation.type === 'DM';
    const dmUser = isDm ? dmCounterpart(conversation, currentUserId) : null;
    const title = conversationLabel(conversation, currentUserId);
    const subtitle = isDm
        ? dmUser?.email || 'Direct message'
        : `${conversation.participants?.length || 0} participant${
              (conversation.participants?.length || 0) === 1 ? '' : 's'
          }`;
    return (
        <div className="flex items-center gap-3 border-b bg-background px-3 py-3 sm:px-4">
            {onBack && (
                <button
                    type="button"
                    onClick={onBack}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
                    aria-label="Back to conversations"
                >
                    <ArrowLeft className="h-5 w-5" />
                </button>
            )}
            {isDm ? (
                <Avatar className="h-9 w-9 shrink-0">
                    {dmUser?.avatarUrl && (
                        <AvatarImage
                            src={resolveAssetUrl(dmUser.avatarUrl)}
                            alt={dmUser.name}
                        />
                    )}
                    <AvatarFallback className="bg-primary/10 text-xs text-primary">
                        {initials(dmUser?.name || title)}
                    </AvatarFallback>
                </Avatar>
            ) : (
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <FolderKanban className="h-4 w-4" />
                </div>
            )}
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{title}</p>
                <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
            </div>
            <span
                className={cn(
                    'hidden shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] sm:inline-flex',
                    isDm
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                        : 'bg-primary/10 text-primary',
                )}
            >
                {isDm ? (
                    <>
                        <MessageSquare className="h-3 w-3" /> Direct
                    </>
                ) : (
                    <>
                        <UsersIcon className="h-3 w-3" /> Project chat
                    </>
                )}
            </span>
            {onDeleteRequest && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            title="Conversation actions"
                        >
                            <MoreHorizontal className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={(e) => {
                                e.preventDefault();
                                onDeleteRequest();
                            }}
                        >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete conversation
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
    );
}

function MessageList({ messages, currentUserId, othersLastReadAt }) {
    if (messages.length === 0) {
        return (
            <p className="mt-8 text-center text-sm text-muted-foreground">
                No messages yet. Start the conversation.
            </p>
        );
    }

    // Find the id of the most recent message I sent that has
    // already been seen by at least one other participant. We
    // only render the "Seen" tick on this one row so a long
    // history doesn't fill up with redundant markers — readers
    // intuitively get that everything above the marker is also
    // seen. If `othersLastReadAt` is null nothing has been seen
    // yet and we render no marker at all.
    let lastSeenMineId = null;
    if (othersLastReadAt) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.senderId !== currentUserId) continue;
            if (new Date(m.createdAt) <= othersLastReadAt) {
                lastSeenMineId = m.id;
                break;
            }
        }
    }

    const elements = [];
    let lastDay = null;
    let lastSenderId = null;
    for (const m of messages) {
        const day = new Date(m.createdAt);
        if (!lastDay || !isSameDay(day, lastDay)) {
            elements.push(
                <div
                    key={`day-${m.id}`}
                    className="my-3 flex items-center justify-center"
                >
                    <span className="rounded-full border bg-background px-3 py-0.5 text-[11px] font-medium text-muted-foreground shadow-sm">
                        {formatDay(m.createdAt)}
                    </span>
                </div>,
            );
            lastDay = day;
            lastSenderId = null;
        }
        const mine = m.senderId === currentUserId;
        // Group adjacent messages from the same sender into a single
        // visual cluster — the avatar shows only on the first bubble
        // and consecutive bubbles get smaller corners.
        const stacked = lastSenderId === m.senderId;
        lastSenderId = m.senderId;
        elements.push(
            <MessageBubble
                key={m.id}
                message={m}
                mine={mine}
                stacked={stacked}
                showSeen={mine && m.id === lastSeenMineId}
                seenAt={othersLastReadAt}
            />,
        );
    }
    return <div className="mx-auto max-w-3xl">{elements}</div>;
}

function MessageBubble({ message, mine, stacked, showSeen, seenAt }) {
    const hasAttachments = message.attachments?.length > 0;
    const hasText = !!message.content;
    return (
        <div
            className={cn(
                'flex items-end gap-2',
                mine && 'flex-row-reverse',
                stacked ? 'mt-0.5' : 'mt-2',
            )}
        >
            <div className={cn('w-7 shrink-0', mine && 'order-2')}>
                {!mine && !stacked && (
                    <Avatar className="h-7 w-7">
                        {message.sender?.avatarUrl && (
                            <AvatarImage
                                src={resolveAssetUrl(message.sender.avatarUrl)}
                                alt={message.sender.name}
                            />
                        )}
                        <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                            {initials(message.sender?.name)}
                        </AvatarFallback>
                    </Avatar>
                )}
            </div>
            <div
                className={cn(
                    'flex max-w-[78%] flex-col gap-1 sm:max-w-[68%]',
                    mine && 'items-end',
                )}
            >
                {!mine && !stacked && (
                    <p className="px-1 text-[11px] font-medium text-muted-foreground">
                        {message.sender?.name}
                    </p>
                )}
                {hasText && (
                    <div
                        className={cn(
                            'rounded-2xl px-3 py-2 text-sm shadow-sm',
                            mine
                                ? cn(
                                      'bg-primary text-primary-foreground',
                                      stacked ? 'rounded-br-md' : 'rounded-br-sm',
                                  )
                                : cn(
                                      'bg-background',
                                      stacked ? 'rounded-bl-md' : 'rounded-bl-sm',
                                  ),
                        )}
                    >
                        <p
                            className={cn(
                                'whitespace-pre-wrap break-words',
                                // Recolor linked code chips so they stay
                                // readable on a primary-colored bubble.
                                mine &&
                                    '[&_a]:!border-primary-foreground/40 [&_a]:!bg-primary-foreground/20 [&_a]:!text-primary-foreground',
                            )}
                        >
                            {renderWithRichTokens(message.content)}
                        </p>
                    </div>
                )}
                {hasAttachments && (
                    <div className="flex w-full flex-col gap-1">
                        {message.attachments.map((a) => (
                            <AttachmentCard key={a.id} attachment={a} mine={mine} />
                        ))}
                    </div>
                )}
                <p className="px-1 text-[10px] text-muted-foreground">
                    {formatTime(message.createdAt)}
                </p>
                {showSeen && (
                    <p
                        className="flex items-center gap-1 px-1 text-[10px] font-medium text-primary"
                        title={
                            seenAt
                                ? `Seen ${format(seenAt, 'MMM d, h:mm a')}`
                                : 'Seen'
                        }
                    >
                        <CheckCheck className="h-3 w-3" />
                        Seen
                    </p>
                )}
            </div>
        </div>
    );
}

function AttachmentCard({ attachment, mine }) {
    const url = resolveAssetUrl(attachment.fileUrl);
    const isImage =
        (attachment.fileMimeType || '').startsWith('image/');
    const expiresAt = attachment.expiresAt
        ? new Date(attachment.expiresAt)
        : null;
    const expiresLabel =
        expiresAt && expiresAt > new Date()
            ? `Expires ${formatDistanceToNowStrict(expiresAt, { addSuffix: true })}`
            : 'Expired';
    if (isImage) {
        return (
            <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className={cn(
                    'group relative block overflow-hidden rounded-2xl border bg-background shadow-sm',
                    mine ? 'self-end' : 'self-start',
                )}
                title={`${attachment.fileName} — ${expiresLabel}`}
            >
                <img
                    src={url}
                    alt={attachment.fileName}
                    className="max-h-64 w-full max-w-xs object-cover"
                />
                <div className="flex items-center justify-between gap-2 border-t bg-background/95 px-2 py-1 text-[10px] text-muted-foreground">
                    <span className="truncate">{attachment.fileName}</span>
                    <span className="shrink-0">{expiresLabel}</span>
                </div>
            </a>
        );
    }
    return (
        <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className={cn(
                'flex items-center gap-3 rounded-2xl border bg-background px-3 py-2 text-left text-sm shadow-sm transition-colors hover:bg-accent',
                mine ? 'self-end' : 'self-start',
            )}
            title={expiresLabel}
        >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FileText className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{attachment.fileName}</p>
                <p className="text-[10px] text-muted-foreground">
                    {formatBytes(attachment.fileSize)} · {expiresLabel}
                </p>
            </div>
            <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
        </a>
    );
}

function Composer({
    draft,
    onChange,
    onSend,
    sending,
    pendingFile,
    onClearFile,
    onPickFile,
    fileInputRef,
    onFileSelected,
    placeholder,
}) {
    return (
        <div className="border-t bg-background p-3">
            {pendingFile && (
                <div className="mb-2 flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-sm">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{pendingFile.name}</span>
                    <span className="text-xs text-muted-foreground">
                        {formatBytes(pendingFile.size)}
                    </span>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-6 w-6"
                        onClick={onClearFile}
                        title="Remove attachment"
                    >
                        <X className="h-3.5 w-3.5" />
                    </Button>
                </div>
            )}
            <div className="flex items-end gap-2">
                <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={onFileSelected}
                />
                <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-10 w-10 shrink-0"
                    onClick={onPickFile}
                    title="Attach a file"
                >
                    <Paperclip className="h-4 w-4" />
                </Button>
                <div className="min-w-0 flex-1">
                    <MentionTextarea
                        value={draft}
                        onChange={(e) => onChange(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                onSend();
                            }
                        }}
                        placeholder={placeholder}
                        className="min-h-[44px] rounded-xl"
                        participants={[]}
                        slashIncludeProjects
                        qualifySlashCodes
                        popoverPlacement="top"
                    />
                </div>
                <Button
                    size="icon"
                    className="h-10 w-10 shrink-0"
                    disabled={(!draft.trim() && !pendingFile) || sending}
                    onClick={onSend}
                >
                    <Send className="h-4 w-4" />
                </Button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
                Enter to send · Shift+Enter for a new line · Attachments expire
                after {ATTACHMENT_TTL_DAYS} days
            </p>
        </div>
    );
}

function EmptyState({ tab, onNewDm }) {
    if (tab === TAB_DIRECT) {
        return (
            <div className="m-auto flex max-w-sm flex-col items-center gap-3 text-center text-sm text-muted-foreground">
                <MessageSquare className="h-10 w-10" />
                <p className="text-foreground">Select a direct message</p>
                <p className="text-xs">
                    Or start a new 1-on-1 chat with a teammate.
                </p>
                <Button size="sm" className="gap-2" onClick={onNewDm}>
                    <Plus className="h-3.5 w-3.5" />
                    New direct message
                </Button>
            </div>
        );
    }
    return (
        <div className="m-auto flex max-w-sm flex-col items-center gap-3 text-center text-sm text-muted-foreground">
            <FolderKanban className="h-10 w-10" />
            <p className="text-foreground">Select a project chat</p>
            <p className="text-xs">
                Open a project chat from the list on the left to view its
                messages.
            </p>
        </div>
    );
}

function DeleteConfirmDialog({ target, currentUserId, onCancel, onConfirm }) {
    const isDm = target?.type === 'DM';
    const title = target
        ? conversationLabel(target, currentUserId)
        : '';
    return (
        <Dialog open={!!target} onOpenChange={(open) => !open && onCancel()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Delete conversation</DialogTitle>
                    <DialogDescription>
                        {isDm
                            ? 'Both you and the other participant will lose this conversation and all of its messages and attachments.'
                            : 'Every project participant will lose this conversation and all of its messages and attachments.'}
                    </DialogDescription>
                </DialogHeader>
                <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                    <p className="font-medium">{title}</p>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={onConfirm}>
                        Delete conversation
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function NewDmDialog({ open, onClose, currentUserId, onPick }) {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(false);
    const [query, setQuery] = useState('');

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const { data } = await api.get('/users');
                if (!cancelled) {
                    setUsers(
                        (data.users || []).filter((u) => u.id !== currentUserId),
                    );
                }
            } catch {
                toast.error('Failed to load users');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, currentUserId]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return users;
        return users.filter(
            (u) =>
                u.name?.toLowerCase().includes(q) ||
                u.email?.toLowerCase().includes(q),
        );
    }, [users, query]);

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>New direct message</DialogTitle>
                    <DialogDescription>
                        Pick a teammate to start a 1-on-1 conversation.
                    </DialogDescription>
                </DialogHeader>
                <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by name or email…"
                    autoFocus
                />
                <div className="max-h-[55vh] overflow-y-auto rounded-lg border">
                    {loading ? (
                        <p className="p-4 text-sm text-muted-foreground">
                            Loading…
                        </p>
                    ) : filtered.length === 0 ? (
                        <p className="p-4 text-sm text-muted-foreground">
                            No matching teammates.
                        </p>
                    ) : (
                        <ul>
                            {filtered.map((u) => (
                                <li key={u.id}>
                                    <button
                                        type="button"
                                        onClick={() => onPick(u.id)}
                                        className="flex w-full items-center gap-3 border-b px-3 py-2 text-left text-sm transition-colors last:border-b-0 hover:bg-accent"
                                    >
                                        <Avatar className="h-8 w-8">
                                            {u.avatarUrl && (
                                                <AvatarImage
                                                    src={resolveAssetUrl(u.avatarUrl)}
                                                    alt={u.name}
                                                />
                                            )}
                                            <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                                                {initials(u.name)}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate font-medium">
                                                {u.name}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {u.email}
                                            </p>
                                        </div>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
