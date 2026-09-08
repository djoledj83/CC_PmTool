import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { format, isSameDay } from 'date-fns';
import { CheckCheck, ExternalLink, MessageSquare, Send } from 'lucide-react';

import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ChatComposerTextarea } from '@/components/ChatComposerTextarea';
import { useChatScrollToBottom } from '@/hooks/useChatScrollToBottom';

function formatDay(d) {
    return format(new Date(d), 'EEE, MMM d');
}
function formatTime(d) {
    return format(new Date(d), 'h:mm a');
}

export function ProjectChatPanel({ projectId, projectName }) {
    const { user: currentUser } = useAuth();
    const {
        joinConversation,
        leaveConversation,
        subscribe,
        setViewingConversation,
    } = useRealtime();
    const [conversation, setConversation] = useState(null);
    const [messages, setMessages] = useState([]);
    const [draft, setDraft] = useState('');
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [activeReads, setActiveReads] = useState(() => new Map());
    const seededReadsFor = useRef(null);
    const messagesScrollRef = useChatScrollToBottom({
        messages,
        ready: !loading,
        resetKey: projectId,
    });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const { data } = await api.post('/conversations/project-room', {
                    projectId,
                });
                if (cancelled) return;
                setConversation(data.conversation);
                const reads = new Map();
                for (const r of data.conversation?.participantReads || []) {
                    reads.set(
                        r.userId,
                        r.lastReadAt ? new Date(r.lastReadAt) : null,
                    );
                }
                setActiveReads(reads);
                seededReadsFor.current = data.conversation?.id || null;

                const msgs = await api.get(
                    `/conversations/${data.conversation.id}/messages`,
                    { params: { limit: 100 } },
                );
                if (cancelled) return;
                setMessages(msgs.data.messages);
                api.post(`/conversations/${data.conversation.id}/read`).catch(
                    () => {},
                );
            } catch (err) {
                toast.error(err.response?.data?.error || 'Failed to load chat');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    useEffect(() => {
        if (!conversation?.id) return undefined;
        setViewingConversation(conversation.id);
        joinConversation(conversation.id);
        return () => {
            setViewingConversation(null);
            leaveConversation(conversation.id);
        };
    }, [
        conversation?.id,
        joinConversation,
        leaveConversation,
        setViewingConversation,
    ]);

    useEffect(() => {
        if (!conversation?.id) return undefined;
        const off = subscribe('message:new', ({ message, conversationId }) => {
            if (conversationId !== conversation.id) return;
            setMessages((prev) =>
                prev.find((m) => m.id === message.id) ? prev : [...prev, message],
            );
            api.post(`/conversations/${conversation.id}/read`).catch(() => {});
        });
        return off;
    }, [conversation?.id, subscribe]);

    useEffect(() => {
        if (!conversation?.id) return undefined;
        const off = subscribe(
            'conversation:read',
            ({ conversationId, userId, lastReadAt }) => {
                if (conversationId !== conversation.id) return;
                setActiveReads((prev) => {
                    const next = new Map(prev);
                    next.set(userId, lastReadAt ? new Date(lastReadAt) : null);
                    return next;
                });
            },
        );
        return off;
    }, [conversation?.id, subscribe]);

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

    const send = async () => {
        const content = draft.trim();
        if (!content || !conversation || sending) return;
        setSending(true);
        try {
            const { data } = await api.post(
                `/conversations/${conversation.id}/messages`,
                { content },
            );
            setMessages((prev) =>
                prev.find((m) => m.id === data.message.id)
                    ? prev
                    : [...prev, data.message],
            );
            setDraft('');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Failed to send');
        } finally {
            setSending(false);
        }
    };

    if (loading) {
        return (
            <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
                Loading chat...
            </div>
        );
    }

    return (
        <div className="flex h-[60vh] min-h-[420px] flex-col rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
                <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-primary" />
                    <p className="text-sm font-semibold">{projectName} chat</p>
                    <span className="text-xs text-muted-foreground">
                        · {conversation?.participants?.length || 0} participant
                        {(conversation?.participants?.length || 0) === 1
                            ? ''
                            : 's'}
                    </span>
                </div>
                {conversation && (
                    <Button asChild variant="ghost" size="sm" className="gap-1">
                        <Link to={`/messages?c=${conversation.id}`}>
                            Open in Messages
                            <ExternalLink className="h-3.5 w-3.5" />
                        </Link>
                    </Button>
                )}
            </div>

            <div
                ref={messagesScrollRef}
                className="flex-1 overflow-y-auto bg-muted/20 px-4 py-3"
            >
                <Bubbles
                    messages={messages}
                    currentUserId={currentUser?.id}
                    othersLastReadAt={othersLastReadAt}
                />
            </div>

            <div className="border-t bg-background p-3">
                <div className="flex items-end gap-2">
                    <ChatComposerTextarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                send();
                            }
                        }}
                        placeholder="Send a message to everyone in this project..."
                        className="min-h-[44px]"
                    />
                    <Button
                        size="icon"
                        className="h-10 w-10 shrink-0"
                        disabled={!draft.trim() || sending}
                        onClick={send}
                    >
                        <Send className="h-4 w-4" />
                    </Button>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                    Anyone who can see this project can read and write here.
                </p>
            </div>
        </div>
    );
}

function Bubbles({ messages, currentUserId, othersLastReadAt }) {
    if (messages.length === 0) {
        return (
            <p className="py-8 text-center text-sm text-muted-foreground">
                No messages in this project chat yet.
            </p>
        );
    }

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

    const out = [];
    let lastDay = null;
    for (const m of messages) {
        const day = new Date(m.createdAt);
        if (!lastDay || !isSameDay(day, lastDay)) {
            out.push(
                <div key={`d-${m.id}`} className="my-2 flex justify-center">
                    <span className="rounded-full bg-muted px-3 py-0.5 text-[11px] text-muted-foreground">
                        {formatDay(m.createdAt)}
                    </span>
                </div>,
            );
            lastDay = day;
        }
        const mine = m.senderId === currentUserId;
        const showSeen = mine && m.id === lastSeenMineId;
        out.push(
            <div
                key={m.id}
                className={cn('mb-2 flex items-end gap-2', mine && 'flex-row-reverse')}
            >
                {!mine && (
                    <Avatar className="h-7 w-7">
                        {m.sender?.avatarUrl && (
                            <AvatarImage
                                src={resolveAssetUrl(m.sender.avatarUrl)}
                                alt={m.sender.name}
                            />
                        )}
                        <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                            {initials(m.sender?.name)}
                        </AvatarFallback>
                    </Avatar>
                )}
                <div
                    className={cn(
                        'flex max-w-[68%] flex-col gap-0.5',
                        mine && 'items-end',
                    )}
                >
                    <div
                        className={cn(
                            'rounded-2xl px-3 py-2 text-sm shadow-sm',
                            mine
                                ? 'rounded-br-sm bg-primary text-primary-foreground'
                                : 'rounded-bl-sm bg-background',
                        )}
                    >
                        {!mine && (
                            <p className="text-[11px] font-medium opacity-80">
                                {m.sender?.name}
                            </p>
                        )}
                        <p className="whitespace-pre-wrap break-words">{m.content}</p>
                        <p
                            className={cn(
                                'mt-0.5 text-right text-[10px]',
                                mine
                                    ? 'text-primary-foreground/70'
                                    : 'text-muted-foreground',
                            )}
                        >
                            {formatTime(m.createdAt)}
                        </p>
                    </div>
                    {showSeen && (
                        <p
                            className="flex items-center gap-1 px-1 text-[10px] font-medium text-primary"
                            title={
                                othersLastReadAt
                                    ? `Seen ${format(othersLastReadAt, 'MMM d, h:mm a')}`
                                    : 'Seen'
                            }
                        >
                            <CheckCheck className="h-3 w-3" />
                            Seen
                        </p>
                    )}
                </div>
            </div>,
        );
    }
    return <div>{out}</div>;
}
