// Requester's detailed view of one request: status, the original
// description, an activity timeline (status changes + comments
// interleaved), a comment box, and request participants. The requester
// can edit/delete their own request until an agent takes it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
    Loader2,
    Send,
    Pencil,
    Trash2,
    ChevronLeft,
    CheckCheck,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { hasCapability, CAPABILITIES } from '@/lib/capabilities';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
    TicketAttachments,
    AttachmentList,
    PendingFilePicker,
    uploadTicketFile,
    imagesFromClipboard,
} from '@/components/TicketAttachments';
import TicketFieldValues from '@/components/TicketFieldValues';
import { RichText, RichTextEditor, sanitizeHtml } from '@/components/RichText';
import { RequesterPicker } from '@/components/RequesterPicker';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const titleCase = (s) =>
    s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : s;
const STATUS_BADGE = {
    NEW: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    IN_PROGRESS: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
    OPEN: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
    PENDING: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    RESOLVED: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    CLOSED: 'bg-muted text-muted-foreground',
};

function fmtDateTime(v) {
    if (!v) return '';
    try {
        return new Date(v).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return '';
    }
}

// Only status-type events surface on the requester timeline; assignment /
// priority churn is agent-side noise here.
function eventLabel(e) {
    switch (e.kind) {
        case 'CREATED':
            return 'raised this request';
        case 'STATUS_CHANGED':
            return `changed the status to ${titleCase(e.toValue)}`;
        case 'REOPENED':
            return 'reopened the request';
        default:
            return null;
    }
}

// Renders one request's detail. Used two ways:
//   - as a routed page (/portal/requests/:id) — id comes from the URL,
//     "back" navigates to /portal.
//   - inside a modal on the portal home — caller passes `idProp` and
//     `onClose`; "back"/close calls onClose instead of navigating, and
//     `onChanged` lets the portal list refresh after edits/deletes.
export default function PortalRequest({
    idProp = null,
    onClose = null,
    onChanged = null,
}) {
    const params = useParams();
    const id = idProp || params.id;
    const navigate = useNavigate();
    const { user } = useAuth();
    const inModal = !!onClose;
    // Leave the detail: close the modal if embedded, else go home.
    const goBack = useCallback(() => {
        if (onClose) onClose();
        else navigate('/portal');
    }, [onClose, navigate]);

    // Ticket-managers (agents/admins) who land on this routed portal page
    // — e.g. from a notification on a ticket they raised internally — have
    // no way back to their workspace. Bounce them to /tickets, which opens
    // the same ticket in the resolver modal. Requesters stay on the portal.
    const canManageTickets =
        user?.role === 'ADMIN' ||
        hasCapability(user, CAPABILITIES.TICKET_MANAGE);
    useEffect(() => {
        if (!inModal && canManageTickets && id) {
            navigate(`/tickets?ticket=${id}`, { replace: true });
        }
    }, [inModal, canManageTickets, id, navigate]);

    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [comment, setComment] = useState('');
    const [commentEmpty, setCommentEmpty] = useState(true);
    const editorRef = useRef(null);
    const [pendingFiles, setPendingFiles] = useState([]);
    const [sending, setSending] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    // Per-user read cursors → "Seen" receipts. Map userId → Date.
    const [reads, setReads] = useState(() => new Map());
    // Keep the newest message in view: jump to the bottom of the
    // conversation on load and whenever a new entry arrives.
    const bottomRef = useRef(null);

    const load = useCallback(
        async ({ silent = false } = {}) => {
            try {
                // Silent (live socket) reloads must not flip the loading
                // spinner — that unmounts the composer mid-typing.
                if (!silent) setLoading(true);
                const res = await api.get(`/tickets/${id}`);
                setData(res.data);
                const map = new Map();
                for (const r of res.data.reads || []) {
                    map.set(
                        r.userId,
                        r.lastReadAt ? new Date(r.lastReadAt) : null,
                    );
                }
                setReads(map);
            } catch (err) {
                if (!silent) {
                    toast.error(
                        err.response?.data?.error || 'Could not load request.',
                    );
                    goBack();
                }
            } finally {
                if (!silent) setLoading(false);
            }
        },
        [id, goBack],
    );

    // Paste a screenshot / photo straight into the composer → queue it as
    // an attachment, uploaded with the comment like a picked file.
    const onComposerPaste = useCallback((e) => {
        const imgs = imagesFromClipboard(e);
        if (!imgs.length) return;
        e.preventDefault();
        setPendingFiles((prev) => [...prev, ...imgs]);
        toast.success(
            imgs.length === 1
                ? 'Image attached.'
                : `${imgs.length} images attached.`,
        );
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    // Live: refresh this ticket's conversation when it gets new activity,
    // so a reply appears at the top without a manual reload.
    const { subscribe } = useRealtime();
    useEffect(() => {
        const off = subscribe('ticket:activity', (payload) => {
            if (payload?.ticketId === id) load({ silent: true });
        });
        return off;
    }, [subscribe, id, load]);

    // Live "Seen": when a resolver opens this request, advance their read
    // cursor in place so the marker on my messages updates immediately.
    useEffect(() => {
        const off = subscribe('ticket:read', (payload) => {
            if (payload?.ticketId !== id || !payload?.userId) return;
            setReads((prev) => {
                const next = new Map(prev);
                next.set(
                    payload.userId,
                    payload.lastReadAt ? new Date(payload.lastReadAt) : null,
                );
                return next;
            });
        });
        return off;
    }, [subscribe, id]);

    const ticket = data?.ticket;
    const isReporter = ticket && ticket.reporter?.id === user?.id;
    // A closed request is fully locked for the requester — no edits, no
    // priority change, nothing. Only resolvers can change a closed ticket.
    const isClosed = ticket?.status === 'CLOSED';
    const canEdit = ticket && !ticket.assignee && isReporter && !isClosed;

    // Merge comments + status events into one timeline. Oldest first so it
    // reads like a chat — newest sits at the bottom, just above the
    // composer (mirrors the resolver side).
    const timeline = useMemo(() => {
        if (!data) return [];
        const msgs = (data.messages || []).map((m) => ({
            kind: 'message',
            at: m.createdAt,
            data: m,
        }));
        const evs = (data.events || [])
            .filter((e) => eventLabel(e))
            .map((e) => ({ kind: 'event', at: e.createdAt, data: e }));
        return [...msgs, ...evs].sort(
            (a, b) => new Date(a.at) - new Date(b.at),
        );
    }, [data]);

    // Scroll to the newest entry on load and as new ones arrive.
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ block: 'end' });
    }, [timeline.length]);

    // Newest read cursor among OTHER people → "Seen" receipt on my last
    // message that predates it.
    const othersLastReadAt = useMemo(() => {
        let max = null;
        for (const [uid, t] of reads) {
            if (uid === user?.id || !t) continue;
            if (!max || t > max) max = t;
        }
        return max;
    }, [reads, user?.id]);

    const lastSeenMineId = useMemo(() => {
        if (!othersLastReadAt) return null;
        const msgs = data?.messages || [];
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.author?.id !== user?.id) continue;
            if (new Date(m.createdAt) <= othersLastReadAt) return m.id;
        }
        return null;
    }, [data, othersLastReadAt, user?.id]);

    // People who can be @-mentioned: everyone on this request.
    const mentionPeople = useMemo(() => {
        const map = new Map();
        const add = (u) => {
            if (u?.id && !map.has(u.id))
                map.set(u.id, { id: u.id, name: u.name || u.email || 'User' });
        };
        add(data?.ticket?.reporter);
        add(data?.ticket?.assignee);
        (data?.participants || []).forEach(add);
        return [...map.values()];
    }, [data]);

    const changePriority = async (priority) => {
        try {
            await api.patch(`/tickets/${id}`, { priority });
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update priority.');
        }
    };

    // Split attachments: ticket-level (no messageId) vs grouped by the
    // comment they belong to.
    const { ticketAtts, attByMessage } = useMemo(() => {
        const all = data?.attachments || [];
        const byMsg = {};
        const ticketLevel = [];
        for (const a of all) {
            if (a.messageId) (byMsg[a.messageId] ||= []).push(a);
            else ticketLevel.push(a);
        }
        return { ticketAtts: ticketLevel, attByMessage: byMsg };
    }, [data]);

    const send = async () => {
        if ((commentEmpty && pendingFiles.length === 0) || sending) return;
        const body = commentEmpty ? '' : sanitizeHtml(comment);
        setSending(true);
        try {
            const { data: res } = await api.post(`/tickets/${id}/messages`, {
                body,
            });
            const msgId = res?.message?.id;
            for (const f of pendingFiles) {
                await uploadTicketFile(id, f, msgId);
            }
            setComment('');
            setCommentEmpty(true);
            editorRef.current?.clear();
            setPendingFiles([]);
            // Silent reload (no spinner / unmount), then jump to the newest
            // message so the just-sent comment is in view.
            await load({ silent: true });
            requestAnimationFrame(() =>
                bottomRef.current?.scrollIntoView({ block: 'end' }),
            );
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not send.');
        } finally {
            setSending(false);
        }
    };

    const remove = async () => {
        if (!window.confirm('Delete this request? This cannot be undone.'))
            return;
        try {
            await api.delete(`/tickets/${id}`);
            toast.success('Request deleted.');
            onChanged?.();
            goBack();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete.');
        }
    };

    if (loading) {
        return (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
        );
    }
    if (!ticket) return null;

    return (
        <div
            className={cn(
                'flex flex-col lg:flex-row',
                inModal && 'max-h-[90vh]',
            )}
        >
            {/* Left column: identity, description, captured details, people
                and attachments. The conversation gets the wide 2/3 on the
                right (stacks below on narrow screens). */}
            <div className="flex max-h-[45vh] min-w-0 shrink-0 flex-col gap-3 overflow-y-auto border-b bg-background p-4 lg:max-h-none lg:w-1/3 lg:border-b-0 lg:border-r">
                {inModal ? (
                    <button
                        type="button"
                        onClick={goBack}
                        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                        <ChevronLeft className="h-3.5 w-3.5" /> Back to requests
                    </button>
                ) : (
                    <Link
                        to="/portal"
                        className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                        <ChevronLeft className="h-3.5 w-3.5" /> Back to home page
                    </Link>
                )}
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">
                        {ticket.code}
                    </span>
                    <span
                        className={cn(
                            'rounded-md px-2 py-0.5 text-[11px] font-medium',
                            STATUS_BADGE[ticket.status] || STATUS_BADGE.NEW,
                        )}
                    >
                        {titleCase(ticket.status)}
                    </span>
                    {canEdit && (
                        <span className="ml-auto flex gap-1.5">
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 px-2 text-xs"
                                onClick={() => setEditOpen(true)}
                            >
                                <Pencil className="h-3.5 w-3.5" /> Edit
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 px-2 text-xs text-rose-600"
                                onClick={remove}
                            >
                                <Trash2 className="h-3.5 w-3.5" /> Delete
                            </Button>
                        </span>
                    )}
                </div>
                <h1 className="mt-2 text-xl font-semibold leading-snug">
                    {ticket.subject}
                </h1>
                {ticket.description && (
                    <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-foreground/90">
                        {ticket.description}
                    </p>
                )}
                {/* Other infos: opened-by, date, who's handling, priority. */}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span>
                        Opened by{' '}
                        <span className="font-medium text-foreground">
                            {ticket.reporter?.name ||
                                ticket.reporter?.email ||
                                'Unknown'}
                        </span>
                    </span>
                    <span>· {fmtDateTime(ticket.createdAt)}</span>
                    {ticket.assignee ? (
                        <span className="flex items-center gap-1">
                            · Handled by
                            <Avatar className="h-4 w-4">
                                {ticket.assignee.avatarUrl && (
                                    <AvatarImage
                                        src={resolveAssetUrl(
                                            ticket.assignee.avatarUrl,
                                        )}
                                        alt={ticket.assignee.name}
                                    />
                                )}
                                <AvatarFallback className="bg-primary/10 text-[8px] text-primary">
                                    {initials(ticket.assignee.name || '?')}
                                </AvatarFallback>
                            </Avatar>
                            <span className="font-medium text-foreground">
                                {ticket.assignee.name || ticket.assignee.email}
                            </span>
                        </span>
                    ) : (
                        <span>· Waiting to be picked up</span>
                    )}
                    {isReporter && !isClosed && (
                        <span className="ml-auto flex items-center gap-1.5">
                            <span>Priority</span>
                            <Select
                                value={ticket.priority || 'NORMAL'}
                                onValueChange={changePriority}
                            >
                                <SelectTrigger className="h-7 w-[110px] text-xs">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {PRIORITIES.map((p) => (
                                        <SelectItem key={p} value={p}>
                                            {titleCase(p)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </span>
                    )}
                </div>

                {/* Captured details, people and attachments live in the
                    left column with the rest of the request info. */}
                <TicketFieldValues ticket={ticket} />
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-medium">People</h3>
                        {!isClosed && (
                            <RequesterPicker
                                label="Add"
                                excludeUserIds={[
                                    ticket.reporter?.id,
                                    ...(data.participants || []).map(
                                        (p) => p.id,
                                    ),
                                ].filter(Boolean)}
                                onConfirm={async ({ userIds, groupIds }) => {
                                    try {
                                        await api.post(
                                            `/tickets/${id}/participants`,
                                            { userIds, groupIds },
                                        );
                                        await load();
                                    } catch (err) {
                                        toast.error(
                                            err.response?.data?.error ||
                                                'Could not add people.',
                                        );
                                    }
                                }}
                            />
                        )}
                    </div>
                    <ParticipantRow user={ticket.reporter} label="Creator" />
                    {ticket.assignee && (
                        <ParticipantRow
                            user={ticket.assignee}
                            label="Handling"
                        />
                    )}
                    {(data.participants || []).map((p) => (
                        <ParticipantRow key={p.id} user={p} />
                    ))}
                </div>
                <div>
                    <h3 className="mb-2 text-sm font-medium">Attachments</h3>
                    <TicketAttachments
                        ticketId={ticket.id}
                        attachments={ticketAtts}
                        currentUserId={user?.id}
                        canManage={false}
                        canUpload={!isClosed}
                        onChanged={load}
                    />
                </div>
            </div>

            {/* Right column: the conversation thread + composer get the
                wide 2/3 half so it's easy to read. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-hidden">
                {/* Scrollable conversation — messages left & right. */}
                <div className="flex-1 space-y-3 overflow-y-auto p-4">
                        {timeline.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                                No activity yet.
                            </p>
                        ) : (
                            timeline.map((item, idx) => {
                                if (item.kind === 'event') {
                                    return (
                                        <p
                                            key={`e-${item.data.id || idx}`}
                                            className="text-center text-[11px] text-muted-foreground"
                                        >
                                            <span className="text-foreground">
                                                {item.data.actor?.name ||
                                                    'Someone'}
                                            </span>{' '}
                                            {eventLabel(item.data)} ·{' '}
                                            {fmtDateTime(item.at)}
                                        </p>
                                    );
                                }
                                const m = item.data;
                                const mine = m.author?.id === user?.id;
                                return (
                                    <div
                                        key={`m-${m.id}`}
                                        className={cn(
                                            'flex gap-2',
                                            mine && 'flex-row-reverse',
                                        )}
                                    >
                                        <Avatar className="h-7 w-7 shrink-0">
                                            {m.author?.avatarUrl && (
                                                <AvatarImage
                                                    src={resolveAssetUrl(
                                                        m.author.avatarUrl,
                                                    )}
                                                    alt={m.author?.name}
                                                />
                                            )}
                                            <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                                                {initials(
                                                    m.author?.name || '?',
                                                )}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div
                                            className={cn(
                                                'flex max-w-[80%] flex-col gap-0.5',
                                                mine && 'items-end',
                                            )}
                                        >
                                        <div
                                            className={cn(
                                                'rounded-lg px-3 py-2 text-sm',
                                                mine
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'border bg-background',
                                            )}
                                        >
                                            <div
                                                className={cn(
                                                    'mb-0.5 text-[10px]',
                                                    mine
                                                        ? 'text-primary-foreground/80'
                                                        : 'text-muted-foreground',
                                                )}
                                            >
                                                {m.author?.name || 'Someone'} ·{' '}
                                                {fmtDateTime(item.at)}
                                            </div>
                                            {m.body && (
                                                <RichText
                                                    source={m.body}
                                                    variant={
                                                        mine
                                                            ? 'onPrimary'
                                                            : undefined
                                                    }
                                                />
                                            )}
                                            {attByMessage[m.id] && (
                                                <div className="mt-1.5">
                                                    <AttachmentList
                                                        items={
                                                            attByMessage[m.id]
                                                        }
                                                        ticketId={ticket.id}
                                                        currentUserId={user?.id}
                                                        canManage={false}
                                                        onChanged={load}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                        {mine && m.id === lastSeenMineId && (
                                            <p
                                                className="flex items-center gap-1 px-1 text-[10px] font-medium text-primary"
                                                title={
                                                    othersLastReadAt
                                                        ? `Seen ${fmtDateTime(othersLastReadAt)}`
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
                            })
                        )}
                        <div ref={bottomRef} />
                    </div>

                    {/* Composer pinned to the bottom of the conversation.
                        A CLOSED request is locked — no comments. */}
                    {ticket.status === 'CLOSED' ? (
                        <div className="shrink-0 border-t bg-background p-3 text-center text-xs text-muted-foreground">
                            This request is closed. Contact support if you need
                            to reopen it.
                        </div>
                    ) : (
                        <div className="shrink-0 space-y-2 border-t bg-background p-3">
                            <div className="flex items-end gap-2">
                                <RichTextEditor
                                    ref={editorRef}
                                    onChange={({ html, isEmpty }) => {
                                        setComment(html);
                                        setCommentEmpty(isEmpty);
                                    }}
                                    onSubmit={send}
                                    onPaste={onComposerPaste}
                                    disabled={sending}
                                    mentions={mentionPeople}
                                    placeholder="Comment on this request… (paste a screenshot, Ctrl+Enter to send)"
                                    className="flex-1"
                                />
                                <Button
                                    className="gap-1.5"
                                    disabled={
                                        (commentEmpty &&
                                            pendingFiles.length === 0) ||
                                        sending
                                    }
                                    onClick={send}
                                >
                                    {sending ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Send className="h-4 w-4" />
                                    )}
                                    Send
                                </Button>
                            </div>
                            <PendingFilePicker
                                files={pendingFiles}
                                onFiles={setPendingFiles}
                                disabled={sending}
                            />
                        </div>
                    )}
                </div>

            <EditRequestDialog
                open={editOpen}
                onOpenChange={setEditOpen}
                ticket={ticket}
                onSaved={() => {
                    setEditOpen(false);
                    load();
                }}
            />
        </div>
    );
}

function ParticipantRow({ user, label }) {
    if (!user) return null;
    return (
        <div className="flex items-center gap-2">
            <Avatar className="h-7 w-7">
                {user.avatarUrl && (
                    <AvatarImage src={resolveAssetUrl(user.avatarUrl)} alt={user.name} />
                )}
                <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                    {initials(user.name || '?')}
                </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
                <div className="truncate text-sm">{user.name}</div>
                {label && (
                    <div className="text-[11px] text-muted-foreground">{label}</div>
                )}
            </div>
        </div>
    );
}

function EditRequestDialog({ open, onOpenChange, ticket, onSaved }) {
    const [subject, setSubject] = useState('');
    const [description, setDescription] = useState('');
    const [priority, setPriority] = useState('NORMAL');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (open && ticket) {
            setSubject(ticket.subject || '');
            setDescription(ticket.description || '');
            setPriority(ticket.priority || 'NORMAL');
        }
    }, [open, ticket]);

    const save = async () => {
        if (!subject.trim()) return toast.error('Enter a subject.');
        try {
            setSaving(true);
            await api.patch(`/tickets/${ticket.id}`, {
                subject: subject.trim(),
                description: description.trim() || null,
                priority,
            });
            toast.success('Request updated.');
            onSaved?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[520px]">
                <DialogHeader>
                    <DialogTitle>Edit request</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label className="text-xs">Summary</Label>
                        <Input
                            value={subject}
                            onChange={(e) => setSubject(e.target.value)}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Priority</Label>
                        <Select value={priority} onValueChange={setPriority}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {PRIORITIES.map((p) => (
                                    <SelectItem key={p} value={p}>
                                        {titleCase(p)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Description</Label>
                        <Textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={5}
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={saving}
                    >
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={saving}>
                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
