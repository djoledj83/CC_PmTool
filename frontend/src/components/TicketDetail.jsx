// The ticket window — one component for both sides:
//   - the agent workspace (pages/Tickets.jsx), canManage = true
//   - the requester portal (pages/PortalRequest.jsx), canManage = false
// Moved out of pages/Tickets.jsx so both can share it.
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

import { toast } from 'sonner';
import {
    Loader2,
    Plus,
    Lock,
    MessageSquare,
    Trash2,
    UserCheck,
    Clock,
    AlertTriangle,
    ChevronDown,
    UserPlus,
    X,
    CheckSquare,
    Share2,
    Copy,
    Mail,
    Bell,
    BellOff,
    BellRing,
    Building2,
    FileText,
    Folder,
    History as HistoryIcon,
    Info,
    Link2,
    MoreVertical,
    Network,
    Paperclip,
    Pencil,
    Signal,
    SignalHigh,
    SignalLow,
    SignalMedium,
    StickyNote,
    User,
    Users,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';

import { useRealtime } from '@/contexts/RealtimeContext';

import { RichText, RichTextEditor, sanitizeHtml } from '@/components/RichText';
import { SearchableSelect } from '@/components/SearchableSelect';
import { RequesterPicker } from '@/components/RequesterPicker';
import { getTicketTypeIcon } from '@/lib/ticketTypeIcons';
import { getTicketTypeBadgeClasses } from '@/lib/ticketTypeColors';

import {
    PRIORITIES,
    STATUSES,
    STATUS_DOT,
    STATUS_TINT,
    daysLabel,
    escapeHtml,
    fmtDateTime,
    fmtDateTimeLong,
    groupTicketFields,
    htmlToText,
    readAutoCloseDays,
    rememberAutoCloseDays,
    toEditorHtml,
    statusLabel,
    titleCase,
} from '@/lib/ticketMeta';
import { AutoCloseCard, AutoCloseNotice } from '@/components/TicketAutoClose';
import {
    EmptyState,
    FieldBlock,
    FieldRows,
    InfoCard,
    MessageCard,
    PersonAvatar,
    SectionNav,
    SeenReceipt,
    SendSplitButton,
    SystemEventCard,
    TabBar,
    TicketActivityTab,
    TicketRelatedTab,
    TicketTimeTab,
    copyToClipboard,
} from '@/components/TicketDetailParts';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

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
import {
    Dialog,
    DialogContent,
    DialogDescription,
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
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

// Event kinds a requester sees (status-type only).
const REQUESTER_EVENT_KINDS = new Set([
    'CREATED',
    'STATUS_CHANGED',
    'REOPENED',
    'AUTO_CLOSED',
]);

// Human label for a timeline event on the agent side (all kinds shown).
function agentEventLabel(e) {
    switch (e.kind) {
        case 'CREATED':
            return 'opened the ticket';
        case 'STATUS_CHANGED':
            return `changed status to ${statusLabel(e.toValue)}`;
        case 'REOPENED':
            return 'reopened the ticket';
        case 'PRIORITY_CHANGED':
            return `set priority to ${titleCase(e.toValue)}`;
        case 'ASSIGNED':
            return 'assigned the ticket';
        case 'UNASSIGNED':
            return 'unassigned the ticket';
        case 'AUTO_CLOSED':
            return 'closed the ticket automatically';
        default:
            return null;
    }
}

// Remembered open/closed state of the ticket window's dropdown sections.
const DESC_OPEN_KEY = 'pm.ticket.descOpen.v1';

const PEOPLE_OPEN_KEY = 'pm.ticket.peopleOpen.v1';

// Could this person be looped into the ticket? Anyone active — but a
// customer (external requester) only on non-internal tickets of their own
// organisation (the API enforces the same rule).
function mayJoinTicket(u, ticket) {
    if (!u || (u.status && u.status !== 'ACTIVE')) return false;
    if (u.role !== 'REQUESTER' || !u.external) return true;
    if (!u.clientId || !ticket || ticket.internal) return false;
    const orgId = ticket.client?.id || null;
    return !orgId || orgId === u.clientId;
}

function readUiFlag(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : v === '1';
    } catch {
        return fallback;
    }
}

function writeUiFlag(key, on) {
    try {
        localStorage.setItem(key, on ? '1' : '0');
    } catch {
        /* storage disabled — the toggle still works for this session */
    }
}

// Reduce a ticket to the editable-field snapshot the draft tracks, so we
// can compare "what's on the server" against "what the resolver has picked".
function ticketFieldSnapshot(t) {
    return {
        projectId: t?.project?.id || '',
        status: t?.status || '',
        priority: t?.priority || '',
        assigneeId: t?.assignee?.id || null,
        // Resolved only: close automatically after N days (null = don't).
        autoCloseDays:
            t?.status === 'RESOLVED' ? t?.autoCloseDays ?? null : null,
    };
}

// The server snapshot moved from `base` to `next`: keep the fields the
// resolver edited locally (draft ≠ base), take the server's for the rest.
function rebaseDraft(draft, base, next) {
    if (!draft || !base) return next;
    const out = { ...next };
    for (const k of Object.keys(next)) {
        if (JSON.stringify(draft[k]) !== JSON.stringify(base[k])) out[k] = draft[k];
    }
    return out;
}

export function TicketDetail({
    ticketId,
    canManage,
    currentUser,
    onChanged,
    onDeleted,
    onOpenTicket,
    // Called when the ticket can't be loaded (e.g. it was deleted) — the
    // portal's routed page uses it to go back home.
    onLoadError,
}) {
    // canManage = agent workspace; otherwise the requester (portal) view:
    // same window, only the actions a requester has.
    const requester = !canManage;
    const onLoadErrorRef = useRef(onLoadError);
    onLoadErrorRef.current = onLoadError;
    const [editRequestOpen, setEditRequestOpen] = useState(false);
    const [ticket, setTicket] = useState(null);
    // Staged field edits. The Project / Status / Priority / Assignee controls
    // bind to this draft, NOT the ticket — so nothing is persisted or logged
    // until the resolver clicks Save. Opening a ticket and brushing a control
    // by accident leaves no trace: just close (or Discard) and it's gone.
    const [draft, setDraft] = useState(null);
    const [savingEdits, setSavingEdits] = useState(false);
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(true);
    const [reply, setReply] = useState('');
    const [replyEmpty, setReplyEmpty] = useState(true);
    const editorRef = useRef(null);
    const [internal, setInternal] = useState(false);
    const [sending, setSending] = useState(false);
    const [pendingFiles, setPendingFiles] = useState([]);
    const [logTimeOpen, setLogTimeOpen] = useState(false);
    const [addTaskOpen, setAddTaskOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    // Lightweight ticket list (code + subject) powering the "#" reference
    // picker in the reply composer.
    const [refTickets, setRefTickets] = useState([]);
    const [users, setUsers] = useState([]);
    const [events, setEvents] = useState([]);
    const [projects, setProjects] = useState([]);
    const [attachments, setAttachments] = useState([]);
    const [participants, setParticipants] = useState([]);
    // Per-user read cursors → "Seen" receipts. Map userId → Date.
    const [reads, setReads] = useState(() => new Map());
    // Keep the newest message in view (load + on each new arrival).
    const bottomRef = useRef(null);
    // ---- Modal layout: tabs, section nav, description editing ----
    const [tab, setTab] = useState('conversation');
    const [navActive, setNavActive] = useState('details');
    const [descEditing, setDescEditing] = useState(false);
    const [descDraft, setDescDraft] = useState('');
    const [descDraftEmpty, setDescDraftEmpty] = useState(true);
    // Remounts the inline description editor for each edit session.
    const [descEditKey, setDescEditKey] = useState(0);
    const [descSaving, setDescSaving] = useState(false);
    const [descExpanded, setDescExpanded] = useState(false);
    const [descOverflows, setDescOverflows] = useState(false);
    // Description + People are dropdowns (collapsed by default so the
    // conversation gets the room); the choice is remembered per browser.
    const [descOpen, setDescOpenState] = useState(() =>
        readUiFlag(DESC_OPEN_KEY, false),
    );
    const setDescOpen = (on) => {
        setDescOpenState(on);
        writeUiFlag(DESC_OPEN_KEY, on);
    };
    const [peopleOpen, setPeopleOpenState] = useState(() =>
        readUiFlag(PEOPLE_OPEN_KEY, false),
    );
    const setPeopleOpen = (on) => {
        setPeopleOpenState(on);
        writeUiFlag(PEOPLE_OPEN_KEY, on);
    };
    // Bumped after logging time so the Time tracking tab refetches.
    const [timeReloadKey, setTimeReloadKey] = useState(0);
    // Card briefly ringed after a section-nav jump ('people' | 'attachments').
    const [flash, setFlash] = useState(null);
    const mainRef = useRef(null);
    const threadRef = useRef(null);
    const descRef = useRef(null);
    const peopleRef = useRef(null);
    const attachmentsRef = useRef(null);
    // Hidden file input behind the composer's paperclip / "Attach file".
    const composerFileRef = useRef(null);

    const load = useCallback(
        async ({ silent = false } = {}) => {
            try {
                // Silent reloads (live socket refreshes) must NOT toggle the
                // loading spinner — that unmounts the composer and steals
                // focus while the user is mid-message.
                if (!silent) setLoading(true);
                const { data } = await api.get(`/tickets/${ticketId}`);
                setTicket(data.ticket);
                setMessages(data.messages || []);
                setEvents(data.events || []);
                setAttachments(data.attachments || []);
                setParticipants(data.participants || []);
                const map = new Map();
                for (const r of data.reads || []) {
                    map.set(
                        r.userId,
                        r.lastReadAt ? new Date(r.lastReadAt) : null,
                    );
                }
                setReads(map);
            } catch (err) {
                if (!silent) {
                    toast.error(
                        err.response?.data?.error ||
                            (requester
                                ? 'Could not load request.'
                                : 'Could not load ticket.'),
                    );
                    onLoadErrorRef.current?.();
                }
            } finally {
                if (!silent) setLoading(false);
            }
        },
        [ticketId],
    );

    // Paste a screenshot / photo straight into the composer → queue it as
    // an attachment (uploaded with the reply, like a picked file).
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

    // Share helpers ----------------------------------------------------
    const ticketUrl =
        typeof window !== 'undefined'
            ? `${window.location.origin}/t/${ticketId}`
            : '';
    const copyTicketLink = async () => {
        // copyText falls back to execCommand on plain-http servers, where
        // navigator.clipboard doesn't exist.
        await copyToClipboard(ticketUrl, 'Link');
        setShareOpen(false);
    };
    const shareWith = async (userId) => {
        if (!userId) return;
        try {
            await api.post(`/tickets/${ticketId}/share`, { userId });
            toast.success('Shared — they’ve been notified.');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not share.');
        }
        setShareOpen(false);
    };

    // Other tickets to reference from the composer (code + subject).
    useEffect(() => {
        if (!canManage) return;
        api.get('/tickets')
            .then(({ data }) =>
                setRefTickets((data.tickets || []).filter((t) => t.id !== ticketId)),
            )
            .catch(() => setRefTickets([]));
    }, [canManage, ticketId]);

    // Agent pickers: only active staff can handle a ticket (or a task made
    // from it); People / Share leave out anyone who couldn't see it.
    const staffUsers = useMemo(
        () =>
            users.filter(
                (u) =>
                    u.role !== 'REQUESTER' && (!u.status || u.status === 'ACTIVE'),
            ),
        [users],
    );
    const ticketInternal = Boolean(ticket?.internal);
    const ticketOrgId = ticket?.client?.id || null;
    const addableUsers = useMemo(
        () =>
            users.filter((u) =>
                mayJoinTicket(u, { internal: ticketInternal, client: { id: ticketOrgId } }),
            ),
        [users, ticketInternal, ticketOrgId],
    );

    const references = useMemo(
        () =>
            refTickets.map((t) => ({
                id: t.id,
                label: `${t.code || 'TKT'} ${t.subject || ''}`.trim(),
                // Role-agnostic deep-link: /t/:id redirects the clicker to
                // the portal or the workspace depending on who they are, so
                // a referenced ticket opens even for a requester participant.
                href:
                    typeof window !== 'undefined'
                        ? `${window.location.origin}/t/${t.id}`
                        : `/t/${t.id}`,
            })),
        [refTickets],
    );

    // Merge comments + events into one chronological activity feed.
    const timeline = useMemo(() => {
        const msgs = (messages || []).map((m) => ({
            kind: 'message',
            at: m.createdAt,
            data: m,
        }));
        const evs = (events || [])
            .filter(
                (e) =>
                    agentEventLabel(e) &&
                    // Requesters only see status-type events; assignment /
                    // priority churn is agent-side noise for them.
                    (!requester || REQUESTER_EVENT_KINDS.has(e.kind)),
            )
            .map((e) => ({ kind: 'event', at: e.createdAt, data: e }));
        return [...msgs, ...evs].sort(
            (a, b) => new Date(a.at) - new Date(b.at),
        );
    }, [messages, events, requester]);

    // Keep the newest message in view — on load, on each arrival and when
    // switching back to a message tab. Only the thread pane scrolls (the
    // description / tabs above it stay put).
    const scrollThreadToEnd = useCallback(() => {
        requestAnimationFrame(() => {
            const el = threadRef.current;
            if (el) el.scrollTop = el.scrollHeight;
        });
    }, []);
    useEffect(() => {
        if (tab === 'conversation' || tab === 'internal') scrollThreadToEnd();
    }, [timeline.length, tab, loading, scrollThreadToEnd]);

    // Newest read cursor among OTHER people — a message of mine is "seen"
    // once it predates this. The last such message gets the marker.
    const othersLastReadAt = useMemo(() => {
        let max = null;
        for (const [uid, t] of reads) {
            if (uid === currentUser?.id || !t) continue;
            if (!max || t > max) max = t;
        }
        return max;
    }, [reads, currentUser?.id]);

    const lastSeenMineId = useMemo(() => {
        if (!othersLastReadAt) return null;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.author?.id !== currentUser?.id) continue;
            if (new Date(m.createdAt) <= othersLastReadAt) return m.id;
        }
        return null;
    }, [messages, othersLastReadAt, currentUser?.id]);

    // userId → display name, drawn from everyone connected to this ticket,
    // so the "Seen" receipt can say WHO read it (not just when).
    const nameById = useMemo(() => {
        const m = new Map();
        const add = (u) => {
            if (u?.id) m.set(u.id, u.name || u.email || 'User');
        };
        add(ticket?.reporter);
        add(ticket?.assignee);
        (participants || []).forEach(add);
        (users || []).forEach(add);
        return m;
    }, [ticket, participants, users]);

    // Who has read up to the marked message — [{ name, at }], newest first.
    const seenByForMarked = useMemo(() => {
        if (!lastSeenMineId) return [];
        const msg = messages.find((m) => m.id === lastSeenMineId);
        if (!msg) return [];
        const t0 = new Date(msg.createdAt);
        const out = [];
        for (const [uid, t] of reads) {
            if (uid === currentUser?.id || !t) continue;
            if (t >= t0) {
                out.push({ name: nameById.get(uid) || 'Someone', at: t });
            }
        }
        out.sort((a, b) => b.at - a.at);
        return out;
    }, [lastSeenMineId, messages, reads, currentUser?.id, nameById]);

    // People who can be @-mentioned: everyone on this conversation.
    const mentionPeople = useMemo(() => {
        const map = new Map();
        const add = (u) => {
            if (u?.id && !map.has(u.id))
                map.set(u.id, { id: u.id, name: u.name || u.email || 'User' });
        };
        add(ticket?.reporter);
        add(ticket?.assignee);
        (participants || []).forEach(add);
        return [...map.values()];
    }, [ticket, participants]);

    // Ticket-level attachments (no messageId) vs those pinned to a comment.
    const { ticketAtts, attByMessage } = useMemo(() => {
        const byMsg = {};
        const ticketLevel = [];
        for (const a of attachments) {
            if (a.messageId) (byMsg[a.messageId] ||= []).push(a);
            else ticketLevel.push(a);
        }
        return { ticketAtts: ticketLevel, attByMessage: byMsg };
    }, [attachments]);

    const addParticipant = async (userId) => {
        try {
            await api.post(`/tickets/${ticketId}/participants`, { userId });
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add participant.');
        }
    };
    const removeParticipant = async (userId) => {
        try {
            await api.delete(`/tickets/${ticketId}/participants/${userId}`);
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not remove.');
        }
    };
    // Requester side: add people and/or whole requester groups at once.
    const addRequesterPeople = async ({ userIds = [], groupIds = [] }) => {
        if (!userIds.length && !groupIds.length) return;
        try {
            await api.post(`/tickets/${ticketId}/participants`, {
                userIds,
                groupIds,
            });
            await load({ silent: true });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add people.');
        }
    };

    useEffect(() => {
        load();
    }, [load]);

    // Keep the draft in sync with the server snapshot — but ONLY when there
    // are no pending local edits, so a background (silent) refresh never
    // wipes what the resolver is midway through changing.
    const serverSnapshot = ticket ? ticketFieldSnapshot(ticket) : null;
    const dirty =
        !!draft &&
        !!serverSnapshot &&
        JSON.stringify(draft) !== JSON.stringify(serverSnapshot);
    // Field by field: a value the resolver changed locally is kept, every
    // other field follows the server — so a status set elsewhere (e.g.
    // "Send & set Resolved", another agent) shows up instead of leaving a
    // stale draft with a bogus "Unsaved changes".
    const draftBaseRef = useRef(null);
    useEffect(() => {
        if (!serverSnapshot) return;
        const base = draftBaseRef.current;
        draftBaseRef.current = serverSnapshot;
        setDraft((prev) => rebaseDraft(prev, base, serverSnapshot));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(serverSnapshot)]);

    const setField = (patchObj) =>
        setDraft((prev) => ({ ...(prev || serverSnapshot), ...patchObj }));

    // Picking Resolved switches on auto-close with the resolver's usual
    // number of days (a ticket that's already resolved keeps its own);
    // any other status drops it.
    const pickStatus = (v) =>
        setField({
            status: v,
            autoCloseDays:
                v !== 'RESOLVED'
                    ? null
                    : serverSnapshot?.status === 'RESOLVED'
                      ? serverSnapshot.autoCloseDays ?? null
                      : readAutoCloseDays(),
        });

    // Live conversation: when this ticket gets new activity (a reply,
    // internal note, status/assignee change), refresh it so the message
    // shows up the instant it arrives — no manual reload needed.
    const { subscribe } = useRealtime();
    useEffect(() => {
        const off = subscribe('ticket:activity', (payload) => {
            if (payload?.ticketId === ticketId) load({ silent: true });
        });
        return off;
    }, [subscribe, ticketId, load]);

    // Live "Seen": when someone else opens this ticket, advance their read
    // cursor in place so the marker moves without a full refetch.
    useEffect(() => {
        const off = subscribe('ticket:read', (payload) => {
            if (payload?.ticketId !== ticketId || !payload?.userId) return;
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
    }, [subscribe, ticketId]);

    useEffect(() => {
        if (!canManage) return;
        api.get('/users')
            .then(({ data }) => setUsers(data.users || data || []))
            .catch(() => setUsers([]));
        api.get('/tickets/projects')
            .then(({ data }) => setProjects(data.projects || []))
            .catch(() => setProjects([]));
    }, [canManage]);

    const patch = async (body) => {
        try {
            const { data } = await api.patch(`/tickets/${ticketId}`, body);
            setTicket((prev) => ({ ...prev, ...data.ticket }));
            onChanged?.();
            // Silent: a non-silent load() flips the loading spinner, which
            // unmounts the whole detail (including the reply composer) for a
            // beat — the modal "blinks" and any half-typed message is lost.
            // The setTicket merge above already applied the field change; the
            // silent refresh just pulls the new timeline event / participants.
            load({ silent: true });
            return true;
        } catch (err) {
            toast.error(err.response?.data?.error || 'Update failed.');
            return false;
        }
    };

    // Persist ONLY the fields the resolver actually changed, in one PATCH.
    // Nothing here runs (and nothing is logged) unless Save is clicked.
    const saveEdits = async () => {
        if (!dirty || !draft) return;
        const body = {};
        if (draft.projectId !== serverSnapshot.projectId) {
            body.projectId = draft.projectId || null;
        }
        if (draft.status !== serverSnapshot.status) body.status = draft.status;
        if (draft.priority !== serverSnapshot.priority) {
            body.priority = draft.priority;
        }
        if (draft.assigneeId !== serverSnapshot.assigneeId) {
            body.assigneeId = draft.assigneeId || null;
        }
        if (draft.status === 'RESOLVED') {
            const days = draft.autoCloseDays ?? null;
            if (body.status === 'RESOLVED' || days !== (serverSnapshot.autoCloseDays ?? null)) {
                body.autoCloseDays = days;
                rememberAutoCloseDays(days);
            }
        }
        if (Object.keys(body).length === 0) return;
        setSavingEdits(true);
        try {
            await patch(body);
        } finally {
            setSavingEdits(false);
        }
    };

    // Throw away staged edits — revert every control to the server values.
    const discardEdits = () => setDraft(serverSnapshot);

    const take = async () => {
        // A project is mandatory before taking. Accept a project the resolver
        // just picked in the panel (draft) even if not yet saved — persist it
        // first, then take.
        const pendingProjectId = draft?.projectId || ticket?.project?.id || '';
        if (!pendingProjectId) {
            toast.error('Assign a project before taking the ticket.');
            return;
        }
        try {
            if (
                draft?.projectId &&
                draft.projectId !== (ticket?.project?.id || '')
            ) {
                await api.patch(`/tickets/${ticketId}`, {
                    projectId: draft.projectId,
                });
            }
            await api.post(`/tickets/${ticketId}/take`);
            // Silent so the composer isn't unmounted mid-message (see patch).
            await load({ silent: true });
            // Taking commits project + assignee on the server. Drop any
            // staged draft so it re-syncs to the fresh snapshot — otherwise
            // a later "Save changes" would diff against the pre-take draft
            // (assignee still null) and quietly un-assign the ticket.
            setDraft(null);
            onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not take ticket.');
        }
    };

    const removeTicket = async () => {
        if (
            !window.confirm(
                requester
                    ? 'Delete this request? This cannot be undone.'
                    : `Delete ${ticket?.code}? This cannot be undone.`,
            )
        )
            return;
        try {
            await api.delete(`/tickets/${ticketId}`);
            toast.success(requester ? 'Request deleted.' : 'Ticket deleted.');
            onChanged?.();
            onDeleted?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete.');
        }
    };

    // `thenStatus` (Send ▾ menu): after the message is posted, also move the
    // ticket to that status in one go — e.g. "Send & set Pending".
    const send = async (thenStatus) => {
        if ((replyEmpty && pendingFiles.length === 0) || sending) return;
        const nextStatus =
            canManage && typeof thenStatus === 'string' ? thenStatus : null;
        // A resolver reply takes ownership, which requires a project. Block
        // (and prompt) if none is selected; persist a just-picked project
        // first so the server sees it when it auto-assigns.
        const pendingProjectId = draft?.projectId || ticket?.project?.id || '';
        if (canManage && !pendingProjectId) {
            toast.error('Select a project before replying.');
            return;
        }
        // A first outbound reply auto-assigns the ticket (server-side). If
        // that happens we must re-sync the draft afterwards, same as Take.
        const willAutoTake =
            canManage && !internal && !ticket?.assignee && !!pendingProjectId;
        const body = replyEmpty ? '' : sanitizeHtml(reply);
        setSending(true);
        try {
            if (
                canManage &&
                draft?.projectId &&
                draft.projectId !== (ticket?.project?.id || '')
            ) {
                await api.patch(`/tickets/${ticketId}`, {
                    projectId: draft.projectId,
                });
            }
            const { data: res } = await api.post(
                `/tickets/${ticketId}/messages`,
                {
                    body,
                    internal: canManage ? internal : false,
                },
            );
            const msgId = res?.message?.id;
            for (const f of pendingFiles) {
                await uploadTicketFile(ticketId, f, msgId);
            }
            setReply('');
            setReplyEmpty(true);
            editorRef.current?.clear();
            // Stay in note mode while working the Internal notes tab.
            if (tab !== 'internal') setInternal(false);
            setPendingFiles([]);
            // Silent reload (no spinner / unmount) so the thread stays put,
            // then jump to the newest message we just sent.
            await load({ silent: true });
            // If replying just took the ticket, drop the staged draft so it
            // re-syncs to the assigned snapshot (mirrors take()).
            if (willAutoTake) setDraft(null);
            if (nextStatus && nextStatus !== ticket?.status) {
                const days =
                    nextStatus === 'RESOLVED' ? readAutoCloseDays() : null;
                const okStatus = await patch({
                    status: nextStatus,
                    ...(nextStatus === 'RESOLVED' ? { autoCloseDays: days } : {}),
                });
                if (okStatus && days) {
                    toast.success(
                        `Resolved — closes automatically in ${daysLabel(days)} unless the requester replies.`,
                    );
                }
            }
            scrollThreadToEnd();
            onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not send.');
        } finally {
            setSending(false);
        }
    };

    // ---- Header actions -------------------------------------------------
    const me = currentUser?.id;
    const isFollowing = (participants || []).some((p) => p.id === me);
    // Reporter / assignee are always notified — "Follow" is for everyone
    // else (it adds you as a watcher; unfollowing removes you again).
    const autoNotified =
        !!me && (ticket?.reporter?.id === me || ticket?.assignee?.id === me);
    const toggleFollow = async () => {
        if (!me) return;
        try {
            if (isFollowing) {
                await api.delete(`/tickets/${ticketId}/participants/${me}`);
                toast.success('You stopped following this ticket.');
            } else {
                await api.post(`/tickets/${ticketId}/participants`, {
                    userId: me,
                });
                toast.success('Following — you’ll be notified of new activity.');
            }
            await load({ silent: true });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update.');
        }
    };

    // ---- Description ----------------------------------------------------
    // Mirrors the server rule: agents always; the reporter until the
    // ticket is taken (and never once it's closed).
    const canEditDescription =
        canManage ||
        (!!me &&
            ticket?.reporter?.id === me &&
            !ticket?.assignee &&
            ticket?.status !== 'CLOSED');
    // Descriptions are rich text: the inline editor is seeded with the
    // stored HTML (legacy plain text converted, line breaks kept).
    const startEditDescription = () => {
        setDescDraft(toEditorHtml(ticket?.description || ''));
        setDescDraftEmpty(!ticket?.description);
        setDescEditKey((k) => k + 1);
        setDescEditing(true);
    };
    const saveDescription = async () => {
        setDescSaving(true);
        try {
            const ok = await patch({
                description: descDraftEmpty ? null : sanitizeHtml(descDraft),
            });
            if (ok) setDescEditing(false);
        } finally {
            setDescSaving(false);
        }
    };
    // "Show more" only when the collapsed description is cut off.
    useLayoutEffect(() => {
        if (descExpanded || descEditing) return;
        const el = descRef.current;
        if (!el) return;
        setDescOverflows(el.scrollHeight > el.clientHeight + 4);
    }, [ticket?.description, descEditing, descExpanded, descOpen, loading]);

    // ---- Tabs + section nav --------------------------------------------
    const selectTab = (id) => {
        setTab(id);
        setNavActive(
            id === 'conversation' || id === 'internal' ? 'details' : id,
        );
        // The Internal notes tab writes notes; going back to the thread
        // from it switches the composer back to a reply.
        if (id === 'internal') setInternal(true);
        else if (id === 'conversation' && tab === 'internal') setInternal(false);
    };
    const flashCard = (id) => {
        setFlash(id);
        setTimeout(() => setFlash((f) => (f === id ? null : f)), 1400);
    };
    const selectNav = (id) => {
        if (id === 'people' || id === 'attachments') {
            setNavActive(id);
            if (id === 'people') setPeopleOpen(true);
            (id === 'people' ? peopleRef : attachmentsRef).current?.scrollIntoView(
                { behavior: 'smooth', block: 'nearest' },
            );
            flashCard(id);
            return;
        }
        if (id === 'details') {
            selectTab('conversation');
            mainRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' });
            return;
        }
        selectTab(id);
    };

    // ⋯ → "Quote in reply": drop the message into the composer as a quote.
    const quoteMessage = (m) => {
        const text = htmlToText(m.body);
        if (!text) return;
        const who = escapeHtml(m.author?.name || 'Someone');
        editorRef.current?.appendHtml(
            `<blockquote><b>${who}</b> wrote:<br>${escapeHtml(text).replace(
                /\n/g,
                '<br>',
            )}</blockquote><p><br></p>`,
        );
    };

    if (loading) {
        return (
            <p className="flex items-center gap-1.5 p-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
        );
    }
    if (!ticket) return null;

    const RequestTypeIcon = ticket.requestType
        ? getTicketTypeIcon(ticket.requestType.icon)
        : null;
    const closed = ticket.status === 'CLOSED';
    const hasProject = !!(draft?.projectId || ticket.project?.id);
    // Requester rights (mirror the server): edit / delete until an agent
    // takes it; priority any time until it's closed.
    const isReporter = !!me && ticket.reporter?.id === me;
    const canEditRequest =
        requester && isReporter && !ticket.assignee && !closed;
    const canSetPriority = canManage || (isReporter && !closed);
    const visibleEvents = requester
        ? events.filter((e) => REQUESTER_EVENT_KINDS.has(e.kind))
        : events;
    const descShown = descOpen || descEditing;
    // First non-empty line of text — the collapsed description's preview.
    const descPreview =
        htmlToText(ticket.description || '')
            .split('\n')
            .map((l) => l.trim())
            .find(Boolean) || 'No description';
    const fieldGroups = groupTicketFields(ticket);
    const internalNotes = messages.filter((m) => m.direction === 'INTERNAL');
    const showComposer = tab === 'conversation' || tab === 'internal';
    const currentStatus = draft?.status ?? ticket.status;
    const currentPriority = draft?.priority ?? ticket.priority;
    // A legacy status (e.g. OPEN) must still show in the select.
    const statusChoices = STATUSES.includes(ticket.status)
        ? STATUSES
        : [ticket.status, ...STATUSES];
    const sendStatusOptions = canManage
        ? ['IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED'].filter(
              (s) => s !== ticket.status,
          )
        : [];
    // The ticket's project must stay selectable even if it isn't in the
    // resolver's project list.
    const projectOptions = [
        ...(ticket.project && !projects.some((p) => p.id === ticket.project.id)
            ? [ticket.project]
            : []),
        ...projects,
    ].map((p) => ({
        value: p.id,
        label: (p.code ? `${p.code} · ` : '') + p.name,
        icon: <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />,
    }));

    const navItems = [
        { id: 'details', label: 'Details', icon: Info },
        { id: 'people', label: 'People', icon: Users },
        { id: 'attachments', label: 'Attachments', icon: Paperclip },
        ...(canManage
            ? [
                  { id: 'related', label: 'Related tickets', icon: Network },
                  { id: 'time', label: 'Time tracking', icon: Clock },
              ]
            : []),
        { id: 'activity', label: 'Activity log', icon: HistoryIcon },
    ];
    const tabs = [
        { id: 'conversation', label: 'Conversation', icon: MessageSquare },
        ...(canManage
            ? [
                  {
                      id: 'internal',
                      label: 'Internal notes',
                      icon: StickyNote,
                      count: internalNotes.length,
                  },
                  { id: 'time', label: 'Time tracking', icon: Clock },
                  { id: 'related', label: 'Related tickets', icon: Network },
              ]
            : []),
        { id: 'activity', label: 'Activity log', icon: HistoryIcon },
    ];

    const renderMessage = (m) => {
        const mine = m.author?.id === me;
        const isInternalMsg = m.direction === 'INTERNAL';
        const showSeen = mine && !isInternalMsg && m.id === lastSeenMineId;
        const first = seenByForMarked[0]?.name?.split(' ')[0];
        return (
            <MessageCard
                key={m.id}
                message={m}
                mine={mine}
                onQuote={closed ? null : () => quoteMessage(m)}
                attachments={
                    attByMessage[m.id] ? (
                        <AttachmentList
                            items={attByMessage[m.id]}
                            ticketId={ticket.id}
                            currentUserId={me}
                            canManage={canManage}
                            onChanged={load}
                            className="mt-2 space-y-1.5"
                        />
                    ) : null
                }
                seen={
                    showSeen ? (
                        <SeenReceipt
                            label={
                                seenByForMarked.length === 0
                                    ? 'Seen'
                                    : seenByForMarked.length === 1
                                      ? `Seen by ${first}`
                                      : `Seen by ${first} +${seenByForMarked.length - 1}`
                            }
                            title={
                                seenByForMarked.length > 0
                                    ? `Seen by:\n${seenByForMarked
                                          .map(
                                              (s) =>
                                                  `${s.name} · ${fmtDateTime(s.at)}`,
                                          )
                                          .join('\n')}`
                                    : othersLastReadAt
                                      ? `Seen ${fmtDateTime(othersLastReadAt)}`
                                      : 'Seen'
                            }
                        />
                    ) : null
                }
            />
        );
    };

    // ---- Field controls (right column) ----------------------------------
    const statusControl = canManage ? (
        <Select value={currentStatus} onValueChange={pickStatus}>
            <SelectTrigger
                className={cn(
                    'h-9 w-full text-sm font-medium',
                    STATUS_TINT[currentStatus],
                )}
            >
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {statusChoices.map((s) => (
                    <SelectItem key={s} value={s}>
                        <span className="flex items-center gap-2">
                            <span
                                className={cn(
                                    'h-2 w-2 shrink-0 rounded-full',
                                    STATUS_DOT[s] || 'bg-slate-400',
                                )}
                            />
                            {statusLabel(s)}
                        </span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    ) : (
        <div
            className={cn(
                'flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium',
                STATUS_TINT[ticket.status],
            )}
        >
            <span
                className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    STATUS_DOT[ticket.status] || 'bg-slate-400',
                )}
            />
            {statusLabel(ticket.status)}
        </div>
    );
    const priorityControl = canManage ? (
        <Select
            value={currentPriority}
            onValueChange={(v) => setField({ priority: v })}
        >
            <SelectTrigger className="h-9 w-full text-sm font-medium">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                        <span className="flex items-center gap-2">
                            <PriorityGlyph priority={p} />
                            {titleCase(p)}
                        </span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    ) : canSetPriority ? (
        // Requester (their own open request): saves straight away — there's
        // no staged "Save changes" bar on the requester side.
        <Select
            value={ticket.priority || 'NORMAL'}
            onValueChange={(v) => {
                if (v !== ticket.priority) patch({ priority: v });
            }}
        >
            <SelectTrigger className="h-9 w-full text-sm font-medium">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                        <span className="flex items-center gap-2">
                            <PriorityGlyph priority={p} />
                            {titleCase(p)}
                        </span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    ) : (
        <div className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium">
            <PriorityGlyph priority={ticket.priority} />
            {titleCase(ticket.priority)}
        </div>
    );
    const assigneeControl = canManage ? (
        <Select
            value={draft?.assigneeId || 'none'}
            onValueChange={(v) =>
                setField({ assigneeId: v === 'none' ? null : v })
            }
        >
            <SelectTrigger className="h-9 w-full text-sm">
                <SelectValue placeholder="Unassigned" />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="none">
                    <span className="flex items-center gap-2">
                        <User className="h-4 w-4 text-muted-foreground" />
                        Unassigned
                    </span>
                </SelectItem>
                {staffUsers.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                        <span className="flex items-center gap-2">
                            <PersonAvatar
                                user={u}
                                className="h-5 w-5"
                                fallbackClassName="text-[9px]"
                            />
                            {u.name || u.email}
                        </span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    ) : (
        <div className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
            {ticket.assignee ? (
                <>
                    <PersonAvatar
                        user={ticket.assignee}
                        className="h-5 w-5"
                        fallbackClassName="text-[9px]"
                    />
                    {ticket.assignee.name || ticket.assignee.email}
                </>
            ) : (
                <>
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">
                        {requester ? 'Waiting to be picked up' : 'Unassigned'}
                    </span>
                </>
            )}
        </div>
    );
    const projectControl = canManage ? (
        <SearchableSelect
            value={draft?.projectId ?? ''}
            onChange={(v) => setField({ projectId: v })}
            placeholder="No project"
            searchPlaceholder="Search projects…"
            className="h-9 text-sm"
            options={projectOptions}
        />
    ) : (
        <div className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm">
            <Folder className="h-4 w-4 text-muted-foreground" />
            <span className={cn(!ticket.project && 'text-muted-foreground')}>
                {ticket.project?.name || 'No project'}
            </span>
        </div>
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {/* ---------- Header: identity + actions ---------- */}
            <header className="flex shrink-0 flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b px-4 pb-3 pt-4 pr-12 sm:px-6 sm:pr-14">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="mt-0.5 hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary sm:flex">
                        <FileText className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-xs text-muted-foreground">
                                {ticket.code}
                            </span>
                            <button
                                type="button"
                                onClick={() =>
                                    copyToClipboard(ticket.code, 'Ticket number')
                                }
                                className="rounded p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                title="Copy ticket number"
                                aria-label="Copy ticket number"
                            >
                                <Copy className="h-3.5 w-3.5" />
                            </button>
                            {ticket.requestType && (
                                <span
                                    title={ticket.requestType.name}
                                    className={cn(
                                        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
                                        getTicketTypeBadgeClasses(
                                            ticket.requestType.color,
                                        ),
                                    )}
                                >
                                    {RequestTypeIcon && (
                                        <RequestTypeIcon className="h-3 w-3" />
                                    )}
                                    {ticket.requestType.name}
                                </span>
                            )}
                            {ticket.internal && (
                                <span
                                    title="Raised internally (not by a requester)"
                                    className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
                                >
                                    <Lock className="h-3 w-3" />
                                    Internal
                                </span>
                            )}
                        </div>
                        <h2 className="mt-1 break-words text-lg font-bold leading-snug sm:text-xl">
                            {ticket.subject}
                        </h2>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            Opened {fmtDateTimeLong(ticket.createdAt)}
                            <span className="mx-1.5">•</span>
                            by{' '}
                            <span className="font-medium text-foreground/80">
                                {ticket.reporter?.name || '—'}
                            </span>
                        </p>
                    </div>
                </div>
                {/* Requester: edit / delete their own request until an
                    agent picks it up. */}
                {requester && canEditRequest && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1.5"
                            onClick={() => setEditRequestOpen(true)}
                        >
                            <Pencil className="h-4 w-4" /> Edit
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1.5 text-rose-600 hover:text-rose-600"
                            onClick={removeTicket}
                        >
                            <Trash2 className="h-4 w-4" /> Delete
                        </Button>
                    </div>
                )}
                {canManage && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Popover open={shareOpen} onOpenChange={setShareOpen}>
                            <PopoverTrigger asChild>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 gap-1.5"
                                >
                                    <Share2 className="h-4 w-4" /> Share
                                </Button>
                            </PopoverTrigger>
                            <PopoverContent
                                align="end"
                                className="w-64 space-y-1 p-2"
                            >
                                <button
                                    type="button"
                                    onClick={copyTicketLink}
                                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                                >
                                    <Copy className="h-4 w-4 text-muted-foreground" />
                                    Copy link
                                </button>
                                <a
                                    href={`mailto:?subject=${encodeURIComponent(
                                        `[${ticket.code}] ${ticket.subject}`,
                                    )}&body=${encodeURIComponent(
                                        `${ticket.subject}\n\n${ticketUrl}`,
                                    )}`}
                                    onClick={() => setShareOpen(false)}
                                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                                >
                                    <Mail className="h-4 w-4 text-muted-foreground" />
                                    Email a link
                                </a>
                                <div className="border-t pt-2">
                                    <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                        Notify a teammate
                                    </p>
                                    <SearchableSelect
                                        value=""
                                        onChange={shareWith}
                                        placeholder="Pick a person…"
                                        searchPlaceholder="Search users…"
                                        options={addableUsers.map((u) => ({
                                            value: u.id,
                                            label: u.name || u.email,
                                        }))}
                                    />
                                </div>
                            </PopoverContent>
                        </Popover>
                        {/* Follow = watcher. Always a toggle: "Following"
                            turns into "Unfollow" on hover and one click
                            stops it. (Reporter / assignee still get their
                            own notifications either way.) */}
                        <Button
                            size="sm"
                            variant="outline"
                            aria-pressed={isFollowing}
                            data-follow-button=""
                            className={cn(
                                'group h-8 gap-1.5',
                                isFollowing &&
                                    'border-primary/40 bg-primary/5 text-primary hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10',
                            )}
                            onClick={toggleFollow}
                            title={
                                (isFollowing
                                    ? 'Click to stop following this ticket.'
                                    : 'Follow to get notified about new activity.') +
                                (autoNotified
                                    ? ' You also get updates as the reporter / assignee.'
                                    : '')
                            }
                        >
                            {isFollowing ? (
                                <>
                                    <BellRing className="h-4 w-4 group-hover:hidden" />
                                    <BellOff className="hidden h-4 w-4 group-hover:block" />
                                    <span className="group-hover:hidden">
                                        Following
                                    </span>
                                    <span className="hidden group-hover:inline">
                                        Unfollow
                                    </span>
                                </>
                            ) : (
                                <>
                                    <Bell className="h-4 w-4" />
                                    Follow
                                </>
                            )}
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1.5"
                            onClick={() => setLogTimeOpen(true)}
                            disabled={!ticket.project}
                            title={
                                ticket.project
                                    ? 'Log time on this ticket'
                                    : 'Assign (and save) a project before logging time'
                            }
                        >
                            <Clock className="h-4 w-4" /> Log time
                        </Button>
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1.5"
                            onClick={() => setAddTaskOpen(true)}
                            title="Create a project task from this ticket"
                        >
                            <Link2 className="h-4 w-4" /> Add to task
                        </Button>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 gap-1.5"
                                >
                                    <MoreVertical className="h-4 w-4" />
                                    More
                                    <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                                {!ticket.assignee && (
                                    <DropdownMenuItem
                                        onSelect={take}
                                        disabled={!hasProject}
                                    >
                                        <UserCheck className="mr-2 h-4 w-4" />
                                        {hasProject
                                            ? 'Assign to me'
                                            : 'Assign to me (pick a project first)'}
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onSelect={copyTicketLink}>
                                    <Link2 className="mr-2 h-4 w-4" />
                                    Copy link
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    onSelect={removeTicket}
                                    className="text-rose-600 focus:text-rose-600"
                                >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    Delete ticket
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                )}
            </header>

            {/* ---------- Body: section nav · main · details ---------- */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6 lg:flex lg:gap-5 lg:overflow-hidden">
                <div className="hidden w-44 shrink-0 xl:block">
                    <SectionNav
                        items={navItems}
                        active={navActive}
                        onSelect={selectNav}
                    />
                </div>

                <main
                    ref={mainRef}
                    className="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1"
                >
                    {/* Description — a dropdown: collapsed it's a single
                        line with a preview, so the conversation below gets
                        the height. */}
                    <section
                        className="shrink-0 rounded-xl border bg-card shadow-sm"
                        data-section="description"
                    >
                        <div className="flex items-center gap-2 px-4 py-2.5">
                            <button
                                type="button"
                                onClick={() => setDescOpen(!descShown)}
                                aria-expanded={descShown}
                                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            >
                                <ChevronDown
                                    className={cn(
                                        'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                                        !descShown && '-rotate-90',
                                    )}
                                />
                                <FileText className="h-4 w-4 shrink-0 text-primary" />
                                <span className="shrink-0 text-sm font-semibold">
                                    Description
                                </span>
                                {!descShown && (
                                    <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                                        {descPreview}
                                    </span>
                                )}
                            </button>
                            {canEditDescription && !descEditing && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
                                    onClick={() => {
                                        // Requesters edit title + description
                                        // + priority together in a dialog.
                                        if (requester) {
                                            setEditRequestOpen(true);
                                            return;
                                        }
                                        setDescOpen(true);
                                        startEditDescription();
                                    }}
                                >
                                    <Pencil className="h-3.5 w-3.5" /> Edit
                                </Button>
                            )}
                        </div>
                        {descShown && (
                        <div className="border-t px-4 py-3">
                        {descEditing ? (
                            <div className="space-y-2">
                                <RichTextEditor
                                    key={descEditKey}
                                    compact
                                    enableLink
                                    enableEmoji
                                    initialHtml={descDraft}
                                    onChange={({ html, isEmpty }) => {
                                        setDescDraft(html);
                                        setDescDraftEmpty(isEmpty);
                                    }}
                                    onSubmit={saveDescription}
                                    disabled={descSaving}
                                    placeholder="Describe the request…"
                                    editorClassName="min-h-[140px] max-h-[40vh] resize-y"
                                />
                                <div className="flex justify-end gap-2">
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => setDescEditing(false)}
                                        disabled={descSaving}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        size="sm"
                                        onClick={saveDescription}
                                        disabled={descSaving}
                                        className="gap-1.5"
                                    >
                                        {descSaving && (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        )}
                                        Save
                                    </Button>
                                </div>
                            </div>
                        ) : ticket.description ? (
                            <>
                                <div
                                    ref={descRef}
                                    className={cn(
                                        'relative break-words text-sm leading-relaxed text-foreground/90',
                                        descExpanded
                                            ? 'max-h-[45vh] overflow-y-auto'
                                            : 'max-h-40 overflow-hidden',
                                    )}
                                >
                                    {/* Rich text (legacy plain text still
                                        renders, line breaks kept). */}
                                    <RichText source={ticket.description} />
                                    {!descExpanded && descOverflows && (
                                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent" />
                                    )}
                                </div>
                                {descOverflows && (
                                    <button
                                        type="button"
                                        onClick={() => setDescExpanded((v) => !v)}
                                        className="mt-1.5 text-xs font-medium text-primary hover:underline"
                                    >
                                        {descExpanded ? 'Show less' : 'Show more'}
                                    </button>
                                )}
                            </>
                        ) : (
                            <p className="text-sm text-muted-foreground">
                                No description.
                            </p>
                        )}
                        </div>
                        )}
                    </section>

                    <div className="flex min-h-[24rem] flex-col lg:min-h-0 lg:flex-1">
                        <TabBar tabs={tabs} active={tab} onChange={selectTab} />
                        <div
                            ref={threadRef}
                            className="min-h-[12rem] flex-1 space-y-3 overflow-y-auto py-3 pr-1"
                        >
                            {tab === 'conversation' &&
                                (timeline.length === 0 ? (
                                    <EmptyState
                                        icon={MessageSquare}
                                        title="No messages yet"
                                        hint="Write the first reply below."
                                    />
                                ) : (
                                    timeline.map((item) =>
                                        item.kind === 'event' ? (
                                            <SystemEventCard
                                                key={`e-${item.data.id}`}
                                                event={item.data}
                                                nameById={nameById}
                                            />
                                        ) : (
                                            renderMessage(item.data)
                                        ),
                                    )
                                ))}
                            {tab === 'internal' &&
                                (internalNotes.length === 0 ? (
                                    <EmptyState
                                        icon={Lock}
                                        title="No internal notes yet"
                                        hint="Internal notes are only visible to agents — never to the requester."
                                    />
                                ) : (
                                    internalNotes.map(renderMessage)
                                ))}
                            {tab === 'time' && canManage && (
                                <TicketTimeTab
                                    ticketId={ticket.id}
                                    reloadKey={timeReloadKey}
                                    onLogTime={() => setLogTimeOpen(true)}
                                    canLog={!!ticket.project}
                                    logHint="Assign (and save) a project before logging time"
                                />
                            )}
                            {tab === 'related' && canManage && (
                                <TicketRelatedTab
                                    ticketId={ticket.id}
                                    onOpenTicket={onOpenTicket}
                                />
                            )}
                            {tab === 'activity' && (
                                <TicketActivityTab
                                    events={visibleEvents}
                                    messages={messages}
                                    nameById={nameById}
                                />
                            )}
                            <div ref={bottomRef} />
                        </div>

                        {showComposer &&
                            (closed ? (
                                <div className="shrink-0 rounded-xl border bg-muted/30 p-3 text-center text-xs text-muted-foreground">
                                    {requester
                                        ? 'This request is closed. Contact support if you need to reopen it.'
                                        : 'This ticket is closed. '}
                                    {requester ? null : canManage ? (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                patch({ status: 'IN_PROGRESS' })
                                            }
                                            className="font-medium text-primary hover:underline"
                                        >
                                            Reopen to comment
                                        </button>
                                    ) : (
                                        'A resolver must reopen it to add comments.'
                                    )}
                                </div>
                            ) : (
                                <div
                                    // No overflow-hidden here: the editor's
                                    // style / emoji / @ / # pickers pop UP
                                    // out of this card.
                                    className={cn(
                                        'shrink-0 rounded-xl border bg-card shadow-sm',
                                        internal && 'border-amber-400/60',
                                    )}
                                >
                                    <div className="flex items-center gap-1 border-b px-2">
                                        <ComposerTab
                                            active={!internal}
                                            onClick={() => setInternal(false)}
                                        >
                                            Reply
                                        </ComposerTab>
                                        {canManage && (
                                            <ComposerTab
                                                active={internal}
                                                amber
                                                onClick={() => setInternal(true)}
                                            >
                                                <Lock className="h-3.5 w-3.5" />
                                                Internal note
                                            </ComposerTab>
                                        )}
                                    </div>
                                    <RichTextEditor
                                        ref={editorRef}
                                        compact
                                        bare
                                        enableLink
                                        enableEmoji
                                        onAttachClick={() =>
                                            composerFileRef.current?.click()
                                        }
                                        onChange={({ html, isEmpty }) => {
                                            setReply(html);
                                            setReplyEmpty(isEmpty);
                                        }}
                                        onSubmit={send}
                                        onPaste={onComposerPaste}
                                        disabled={sending}
                                        mentions={mentionPeople}
                                        references={references}
                                        placeholder={
                                            internal
                                                ? 'Internal note — only agents can see it… (Ctrl/Cmd + Enter to send)'
                                                : requester
                                                  ? 'Comment on this request… (Ctrl/Cmd + Enter to send)'
                                                  : 'Write a reply… (Ctrl/Cmd + Enter to send)'
                                        }
                                        className={cn(
                                            internal &&
                                                'bg-amber-50/50 dark:bg-amber-500/5',
                                        )}
                                        editorClassName="min-h-[52px]"
                                    />
                                    <div
                                        className={cn(
                                            'px-3',
                                            pendingFiles.length > 0 && 'pb-2 pt-1',
                                        )}
                                    >
                                        <PendingFilePicker
                                            files={pendingFiles}
                                            onFiles={setPendingFiles}
                                            disabled={sending}
                                            inputRef={composerFileRef}
                                            showButton={false}
                                        />
                                    </div>
                                    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-1.5">
                                        <div className="flex min-w-0 flex-1 items-center gap-3">
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                className="h-8 shrink-0 gap-1.5"
                                                onClick={() =>
                                                    composerFileRef.current?.click()
                                                }
                                                disabled={sending}
                                            >
                                                <Paperclip className="h-4 w-4" />
                                                Attach file
                                            </Button>
                                            {canManage &&
                                                !internal &&
                                                (!hasProject ? (
                                                    <span className="flex min-w-0 items-center gap-1 text-[11px] text-amber-600">
                                                        <AlertTriangle className="h-3 w-3 shrink-0" />
                                                        <span className="truncate">
                                                            Select a project to reply — it takes the ticket.
                                                        </span>
                                                    </span>
                                                ) : !ticket.assignee ? (
                                                    <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                                                        <UserCheck className="h-3 w-3 shrink-0" />
                                                        <span className="truncate">
                                                            Replying will assign this ticket to you.
                                                        </span>
                                                    </span>
                                                ) : null)}
                                        </div>
                                        <SendSplitButton
                                            onSend={send}
                                            statusOptions={sendStatusOptions}
                                            sending={sending}
                                            disabled={
                                                (replyEmpty &&
                                                    pendingFiles.length === 0) ||
                                                sending ||
                                                (canManage && !hasProject)
                                            }
                                            title={
                                                canManage && !hasProject
                                                    ? 'Select a project before replying'
                                                    : undefined
                                            }
                                        />
                                    </div>
                                </div>
                            ))}
                    </div>
                </main>

                <aside className="mt-4 space-y-3 lg:mt-0 lg:min-h-0 lg:w-[22rem] lg:shrink-0 lg:overflow-y-auto lg:pr-1 xl:w-[24rem]">
                    {canManage && dirty && (
                        <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-xs">
                            <span className="font-medium text-amber-800 dark:text-amber-200">
                                Unsaved changes
                            </span>
                            <span className="flex shrink-0 gap-1.5">
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs"
                                    onClick={discardEdits}
                                    disabled={savingEdits}
                                >
                                    Discard
                                </Button>
                                <Button
                                    size="sm"
                                    className="h-7 gap-1.5 px-2 text-xs"
                                    onClick={saveEdits}
                                    disabled={savingEdits}
                                >
                                    {savingEdits && (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    )}
                                    Save changes
                                </Button>
                            </span>
                        </div>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                        <InfoCard className="p-3">
                            <FieldBlock label="Status">{statusControl}</FieldBlock>
                        </InfoCard>
                        <InfoCard className="p-3">
                            <FieldBlock label="Priority">
                                {priorityControl}
                            </FieldBlock>
                        </InfoCard>
                    </div>
                    {canManage && currentStatus === 'RESOLVED' && (
                        <AutoCloseCard
                            days={draft?.autoCloseDays ?? null}
                            onChange={(d) => setField({ autoCloseDays: d })}
                            savedDays={
                                ticket.status === 'RESOLVED'
                                    ? ticket.autoCloseDays ?? null
                                    : null
                            }
                            savedAt={
                                ticket.status === 'RESOLVED'
                                    ? ticket.autoCloseAt || null
                                    : null
                            }
                            disabled={savingEdits}
                        />
                    )}
                    {requester &&
                        ticket.status === 'RESOLVED' &&
                        ticket.autoCloseAt && (
                            <AutoCloseNotice at={ticket.autoCloseAt} />
                        )}
                    <InfoCard className="space-y-3 p-3">
                        <FieldBlock
                            label={requester ? 'Handled by' : 'Assignee'}
                            action={
                                canManage && !ticket.assignee ? (
                                    <button
                                        type="button"
                                        onClick={take}
                                        disabled={!hasProject}
                                        title={
                                            hasProject
                                                ? 'Assign this ticket to you'
                                                : 'Assign a project before taking the ticket'
                                        }
                                        className="text-[11px] font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
                                    >
                                        Assign to me
                                    </button>
                                ) : null
                            }
                        >
                            {assigneeControl}
                        </FieldBlock>
                        {/* Requesters never pick (or see) the project. */}
                        {!requester && (
                            <FieldBlock label="Project">{projectControl}</FieldBlock>
                        )}
                        {canManage && ticket.linkedTasks?.length > 0 && (
                            <FieldBlock label="Linked tasks">
                                <div className="flex flex-wrap items-center gap-1.5">
                                    {ticket.linkedTasks.map((tk) => (
                                        <span
                                            key={tk.id}
                                            title={tk.title}
                                            className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[11px]"
                                        >
                                            <CheckSquare className="h-3 w-3 text-emerald-600" />
                                            <span className="font-mono">
                                                {tk.code || 'Task'}
                                            </span>
                                        </span>
                                    ))}
                                </div>
                            </FieldBlock>
                        )}
                    </InfoCard>
                    {fieldGroups.terminal.length > 0 && (
                        <InfoCard icon={Building2} title="Client & Terminal">
                            <FieldRows rows={fieldGroups.terminal} />
                        </InfoCard>
                    )}
                    {fieldGroups.contact.length > 0 && (
                        <InfoCard icon={User} title="Contact">
                            <FieldRows rows={fieldGroups.contact} />
                        </InfoCard>
                    )}
                    {fieldGroups.other.length > 0 && (
                        <InfoCard icon={Info} title="Other details">
                            <FieldRows rows={fieldGroups.other} />
                        </InfoCard>
                    )}
                    <InfoCard sectionRef={peopleRef} highlight={flash === 'people'}>
                        <ParticipantsBar
                            layout="card"
                            expanded={peopleOpen}
                            onToggleExpanded={() => setPeopleOpen(!peopleOpen)}
                            reporter={ticket.reporter}
                            assignee={ticket.assignee}
                            participants={participants}
                            users={addableUsers}
                            canManage={canManage}
                            onAdd={addParticipant}
                            onRemove={removeParticipant}
                            roleLabels={
                                requester
                                    ? {
                                          reporter: 'Creator',
                                          assignee: 'Handling',
                                          watcher: 'Participant',
                                      }
                                    : null
                            }
                            // Requesters add colleagues (people or whole
                            // requester groups) with the portal picker.
                            addSlot={
                                requester && !closed ? (
                                    <RequesterPicker
                                        label="Add"
                                        align="end"
                                        triggerClassName="h-8 px-3 text-sm"
                                        excludeUserIds={[
                                            ticket.reporter?.id,
                                            ...participants.map((p) => p.id),
                                        ].filter(Boolean)}
                                        onConfirm={addRequesterPeople}
                                    />
                                ) : null
                            }
                        />
                    </InfoCard>
                    <InfoCard
                        sectionRef={attachmentsRef}
                        highlight={flash === 'attachments'}
                    >
                        <TicketAttachments
                            heading={
                                <h3 className="flex items-center gap-2 text-sm font-semibold">
                                    <Paperclip className="h-4 w-4 text-primary" />
                                    Attachments
                                </h3>
                            }
                            ticketId={ticket.id}
                            attachments={ticketAtts}
                            currentUserId={me}
                            canManage={canManage}
                            // A closed request is locked for the requester.
                            canUpload={canManage || !closed}
                            onChanged={load}
                        />
                    </InfoCard>
                </aside>
            </div>

            <TicketLogTimeDialog
                open={logTimeOpen}
                onOpenChange={setLogTimeOpen}
                ticket={ticket}
                onLogged={() => {
                    setLogTimeOpen(false);
                    setTimeReloadKey((k) => k + 1);
                }}
            />
            <AddAsTaskDialog
                open={addTaskOpen}
                onOpenChange={setAddTaskOpen}
                ticket={ticket}
                projects={projects}
                users={staffUsers}
                onCreated={() => {
                    setAddTaskOpen(false);
                    load();
                    onChanged?.();
                }}
            />
            {requester && (
                <EditRequestDialog
                    open={editRequestOpen}
                    onOpenChange={setEditRequestOpen}
                    ticket={ticket}
                    onSaved={() => {
                        setEditRequestOpen(false);
                        load({ silent: true });
                        onChanged?.();
                    }}
                />
            )}
        </div>
    );
}

// Requester's "Edit request": title, priority and description together
// (allowed until an agent takes the request).
function EditRequestDialog({ open, onOpenChange, ticket, onSaved }) {
    const [subject, setSubject] = useState('');
    const [descHtml, setDescHtml] = useState('');
    const [descEmpty, setDescEmpty] = useState(true);
    const [priority, setPriority] = useState('NORMAL');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (open && ticket) {
            setSubject(ticket.subject || '');
            setDescHtml(toEditorHtml(ticket.description || ''));
            setDescEmpty(!ticket.description);
            setPriority(ticket.priority || 'NORMAL');
        }
    }, [open, ticket]);

    const save = async () => {
        if (!subject.trim()) {
            toast.error('Enter a subject.');
            return;
        }
        if (descEmpty) {
            toast.error('Add a description.');
            return;
        }
        try {
            setSaving(true);
            await api.patch(`/tickets/${ticket.id}`, {
                subject: subject.trim(),
                description: sanitizeHtml(descHtml),
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
                    <DialogDescription className="text-xs">
                        You can change your request until support picks it
                        up.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label className="text-xs">Summary</Label>
                        <Input
                            value={subject}
                            onChange={(e) => setSubject(e.target.value)}
                            maxLength={200}
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
                                        <span className="flex items-center gap-2">
                                            <PriorityGlyph priority={p} />
                                            {titleCase(p)}
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">
                            Description <span className="text-rose-500">*</span>
                        </Label>
                        {/* Mounted per open (the dialog unmounts on close),
                            so it's seeded with the current description. */}
                        <RichTextEditor
                            compact
                            enableLink
                            enableEmoji
                            initialHtml={toEditorHtml(ticket?.description || '')}
                            onChange={({ html, isEmpty }) => {
                                setDescHtml(html);
                                setDescEmpty(isEmpty);
                            }}
                            disabled={saving}
                            placeholder="Describe the request…"
                            editorClassName="min-h-[160px] max-h-[45vh] resize-y"
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
                    <Button onClick={save} disabled={saving} className="gap-1.5">
                        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// Reply / Internal note switch at the top of the composer.
function ComposerTab({ active, amber = false, onClick, children }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm transition-colors',
                active
                    ? amber
                        ? 'border-amber-500 font-medium text-amber-700 dark:text-amber-300'
                        : 'border-primary font-medium text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
        >
            {children}
        </button>
    );
}

// Priority as a signal-strength glyph (Low → Urgent).
const PRIORITY_GLYPH = {
    LOW: { Icon: SignalLow, cls: 'text-slate-400' },
    NORMAL: { Icon: SignalMedium, cls: 'text-emerald-600 dark:text-emerald-400' },
    HIGH: { Icon: SignalHigh, cls: 'text-amber-500' },
    URGENT: { Icon: Signal, cls: 'text-rose-600 dark:text-rose-400' },
};

function PriorityGlyph({ priority }) {
    const meta = PRIORITY_GLYPH[priority] || PRIORITY_GLYPH.NORMAL;
    const Icon = meta.Icon;
    return <Icon className={cn('h-4 w-4 shrink-0', meta.cls)} />;
}

// Resolver action: spin a project task off a ticket. Title + description
// are prefilled from the ticket but fully editable; the resolver picks a
// project (prefilled from the ticket when set) and a phase, and may set
// a due date, priority and assignee before creating. The new task is
// linked back to the ticket via sourceTicketId.
function AddAsTaskDialog({ open, onOpenChange, ticket, projects, users, onCreated }) {
    const [projectId, setProjectId] = useState('');
    const [phaseId, setPhaseId] = useState('');
    const [phases, setPhases] = useState([]);
    const [loadingPhases, setLoadingPhases] = useState(false);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [dueDate, setDueDate] = useState('');
    const [priority, setPriority] = useState('MEDIUM');
    const [assigneeId, setAssigneeId] = useState('none');
    const [saving, setSaving] = useState(false);

    // Reset the form from the ticket each time the dialog opens.
    useEffect(() => {
        if (!open) return;
        setProjectId(ticket?.project?.id || '');
        setPhaseId('');
        setTitle(ticket?.subject || '');
        // Tasks keep plain-text descriptions — take the readable text.
        setDescription(htmlToText(ticket?.description || ''));
        setDueDate('');
        setPriority('MEDIUM');
        setAssigneeId('none');
    }, [open, ticket]);

    // Load the chosen project's phases for the phase picker.
    useEffect(() => {
        if (!open || !projectId) {
            setPhases([]);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                setLoadingPhases(true);
                const { data } = await api.get('/phases', {
                    params: { projectId },
                });
                if (!cancelled) setPhases(data.phases || []);
            } catch {
                if (!cancelled) setPhases([]);
            } finally {
                if (!cancelled) setLoadingPhases(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, projectId]);

    const save = async () => {
        if (!projectId) {
            toast.error('Pick a project for the task.');
            return;
        }
        if (!title.trim()) {
            toast.error('Task title is required.');
            return;
        }
        try {
            setSaving(true);
            const { data } = await api.post('/tasks', {
                projectId,
                title: title.trim(),
                description: description.trim() || null,
                phaseId: phaseId || null,
                dueDate: dueDate
                    ? new Date(`${dueDate}T12:00:00`).toISOString()
                    : null,
                priority,
                assigneeId: assigneeId === 'none' ? null : assigneeId,
                sourceTicketId: ticket.id,
            });
            toast.success(`Created task ${data.task?.code || ''}`.trim());
            onCreated?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not create task.');
        } finally {
            setSaving(false);
        }
    };

    // This ticket can become at most one live task per (project, phase).
    // Warn (and block) up-front if the chosen slot already has one.
    const duplicate = (ticket?.linkedTasks || []).find(
        (tk) =>
            tk.projectId === projectId &&
            (tk.phaseId || null) === (phaseId || null),
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[520px]">
                <DialogHeader>
                    <DialogTitle>Add as task</DialogTitle>
                    <DialogDescription className="text-xs">
                        Create a project task from {ticket?.code}. Edit anything
                        before creating.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label className="text-xs">Project</Label>
                            <Select
                                value={projectId}
                                onValueChange={(v) => {
                                    setProjectId(v);
                                    setPhaseId('');
                                }}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Pick a project" />
                                </SelectTrigger>
                                <SelectContent>
                                    {projects.map((p) => (
                                        <SelectItem key={p.id} value={p.id}>
                                            {p.code ? `${p.code} · ` : ''}
                                            {p.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Phase</Label>
                            <Select
                                value={phaseId || 'none'}
                                onValueChange={(v) =>
                                    setPhaseId(v === 'none' ? '' : v)
                                }
                                disabled={!projectId || loadingPhases}
                            >
                                <SelectTrigger>
                                    <SelectValue
                                        placeholder={
                                            loadingPhases
                                                ? 'Loading…'
                                                : 'No phase'
                                        }
                                    />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="none">
                                        No phase
                                    </SelectItem>
                                    {phases.map((ph) => (
                                        <SelectItem key={ph.id} value={ph.id}>
                                            {ph.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Title</Label>
                        <Input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="Task title"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Description</Label>
                        <Textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={3}
                            placeholder="Task description"
                        />
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                        <div className="space-y-1.5">
                            <Label className="text-xs">Due date</Label>
                            <Input
                                type="date"
                                value={dueDate}
                                onChange={(e) => setDueDate(e.target.value)}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Priority</Label>
                            <Select
                                value={priority}
                                onValueChange={setPriority}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="LOW">Low</SelectItem>
                                    <SelectItem value="MEDIUM">
                                        Medium
                                    </SelectItem>
                                    <SelectItem value="HIGH">High</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Assignee</Label>
                            <Select
                                value={assigneeId}
                                onValueChange={setAssigneeId}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Unassigned" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="none">
                                        Unassigned
                                    </SelectItem>
                                    {users.map((u) => (
                                        <SelectItem key={u.id} value={u.id}>
                                            {u.name || u.email}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    {duplicate && (
                        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                            This ticket is already a task
                            {duplicate.code ? ` (${duplicate.code})` : ''} in the
                            selected phase. Pick a different phase to add another.
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={saving}
                    >
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={saving || !!duplicate}>
                        {saving && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Create task
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function PersonChip({ user, role, onRemove, large = false }) {
    if (!user) return null;
    return (
        <span
            className={cn(
                'inline-flex max-w-full items-center rounded-full border',
                large
                    ? 'gap-2 bg-primary/5 py-1 pl-1 pr-2.5 text-sm'
                    : 'gap-1.5 bg-muted/40 py-0.5 pl-0.5 pr-2 text-xs',
            )}
        >
            <Avatar className={large ? 'h-7 w-7' : 'h-5 w-5'}>
                {user.avatarUrl && (
                    <AvatarImage
                        src={resolveAssetUrl(user.avatarUrl)}
                        alt={user.name}
                    />
                )}
                <AvatarFallback
                    className={cn(
                        'bg-primary/10 text-primary',
                        large ? 'text-[11px] font-semibold' : 'text-[9px]',
                    )}
                >
                    {initials(user.name || '?')}
                </AvatarFallback>
            </Avatar>
            <span
                className={cn(
                    'truncate',
                    large ? 'max-w-[11rem] font-medium' : 'max-w-[120px]',
                )}
            >
                {user.name || user.email}
            </span>
            <span
                className={cn(
                    'shrink-0 text-muted-foreground',
                    large ? 'text-xs' : 'text-[10px]',
                )}
            >
                {role}
            </span>
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    className="ml-0.5 rounded p-0.5 text-muted-foreground hover:text-rose-600"
                    title="Remove"
                >
                    <X className="h-3 w-3" />
                </button>
            )}
        </span>
    );
}

// Shows everyone on a ticket (requester, assignee, watchers) and lets an
// agent add more participants from the user list.
function ParticipantsBar({
    reporter,
    assignee,
    participants,
    users,
    canManage,
    onAdd,
    onRemove,
    layout = 'bar',
    // 'card' layout only: collapsible ("dropdown") when a toggle is given.
    expanded = true,
    onToggleExpanded = null,
    // Custom chip labels, e.g. the portal's Creator / Handling / Participant.
    roleLabels = null,
    // Replaces the agent "Add" popover (the portal passes its own picker).
    addSlot = null,
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    const aside = layout === 'aside';
    // 'card' — the ticket modal's People card (title + Add in the header).
    const card = layout === 'card';
    const involvedIds = new Set(
        [reporter?.id, assignee?.id, ...participants.map((p) => p.id)].filter(
            Boolean,
        ),
    );
    const addable = users.filter(
        (u) =>
            !involvedIds.has(u.id) &&
            (!q ||
                (u.name || u.email || '')
                    .toLowerCase()
                    .includes(q.toLowerCase())),
    );
    const chips = (
        <>
            <PersonChip
                user={reporter}
                role={
                    roleLabels?.reporter || (card ? 'Reporter' : 'Requester')
                }
                large={card}
            />
            {assignee && (
                <PersonChip
                    user={assignee}
                    role={roleLabels?.assignee || 'Assignee'}
                    large={card}
                />
            )}
            {participants.map((p) => (
                <PersonChip
                    key={p.id}
                    user={p}
                    role={roleLabels?.watcher || 'Watcher'}
                    large={card}
                    onRemove={canManage ? () => onRemove(p.id) : null}
                />
            ))}
        </>
    );
    const addBtn = canManage && (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                {card ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5"
                    >
                        <Plus className="h-4 w-4" />
                        Add
                    </Button>
                ) : (
                    <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-1 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
                    >
                        <UserPlus className="h-3.5 w-3.5" />
                        Add
                    </button>
                )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-60 p-1">
                <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search people…"
                    className="mb-1 w-full rounded border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
                />
                <div className="max-h-56 overflow-y-auto">
                    {addable.length === 0 ? (
                        <p className="px-2 py-2 text-xs text-muted-foreground">
                            No one to add.
                        </p>
                    ) : (
                        addable.slice(0, 50).map((u) => (
                            <button
                                key={u.id}
                                type="button"
                                onClick={() => {
                                    onAdd(u.id);
                                    setOpen(false);
                                    setQ('');
                                }}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                            >
                                <Avatar className="h-5 w-5">
                                    {u.avatarUrl && (
                                        <AvatarImage
                                            src={resolveAssetUrl(u.avatarUrl)}
                                            alt={u.name}
                                        />
                                    )}
                                    <AvatarFallback className="bg-primary/10 text-[9px] text-primary">
                                        {initials(u.name || '?')}
                                    </AvatarFallback>
                                </Avatar>
                                <span className="truncate">
                                    {u.name || u.email}
                                </span>
                            </button>
                        ))
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );

    if (card) {
        const collapsible = typeof onToggleExpanded === 'function';
        const isOpen = collapsible ? expanded : true;
        // Everyone involved, once each (reporter may also be a watcher).
        const seen = new Set();
        const everyone = [reporter, assignee, ...participants].filter((u) => {
            if (!u?.id || seen.has(u.id)) return false;
            seen.add(u.id);
            return true;
        });
        const title = (
            <>
                {collapsible && (
                    <ChevronDown
                        className={cn(
                            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                            !isOpen && '-rotate-90',
                        )}
                    />
                )}
                <Users className="h-4 w-4 shrink-0 text-primary" />
                <span className="text-sm font-semibold">People</span>
                <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                    {everyone.length}
                </span>
                {!isOpen && everyone.length > 0 && (
                    // Collapsed: who's on it at a glance (avatar stack).
                    <span className="ml-1 flex -space-x-1.5">
                        {everyone.slice(0, 5).map((u) => (
                            <Avatar
                                key={u.id}
                                className="h-6 w-6 border-2 border-card"
                                title={u.name || u.email}
                            >
                                {u.avatarUrl && (
                                    <AvatarImage
                                        src={resolveAssetUrl(u.avatarUrl)}
                                        alt={u.name}
                                    />
                                )}
                                <AvatarFallback className="bg-primary/10 text-[9px] font-semibold text-primary">
                                    {initials(u.name || '?')}
                                </AvatarFallback>
                            </Avatar>
                        ))}
                        {everyone.length > 5 && (
                            <span className="flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-card bg-muted px-1 text-[9px] font-medium">
                                +{everyone.length - 5}
                            </span>
                        )}
                    </span>
                )}
            </>
        );
        return (
            <div>
                <div
                    className={cn(
                        'flex items-center justify-between gap-2',
                        isOpen && 'mb-3',
                    )}
                >
                    {collapsible ? (
                        <button
                            type="button"
                            onClick={onToggleExpanded}
                            aria-expanded={isOpen}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                            {title}
                        </button>
                    ) : (
                        <h3 className="flex items-center gap-2">{title}</h3>
                    )}
                    {addBtn || addSlot}
                </div>
                {isOpen && (
                    <div className="flex flex-col items-start gap-2">{chips}</div>
                )}
            </div>
        );
    }

    // Vertical sidebar variant — a stacked People list with the Add
    // control in the section header (mirrors the requester portal aside).
    if (aside) {
        return (
            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">People</h3>
                    {addBtn}
                </div>
                <div className="flex flex-col items-start gap-1.5">{chips}</div>
            </div>
        );
    }

    return (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                People
            </span>
            {chips}
            {addBtn}
        </div>
    );
}

function TicketLogTimeDialog({ open, onOpenChange, ticket, onLogged }) {
    const DURATIONS = [
        { v: 15, label: '15m' },
        { v: 30, label: '30m' },
        { v: 45, label: '45m' },
        { v: 60, label: '1h' },
        { v: 90, label: '1h 30m' },
        { v: 120, label: '2h' },
        { v: 180, label: '3h' },
        { v: 240, label: '4h' },
        { v: 480, label: '8h' },
    ];
    const today = () => new Date().toISOString().slice(0, 10);
    const [dateValue, setDateValue] = useState(today());
    const [minutes, setMinutes] = useState(30);
    const [note, setNote] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (open) {
            setDateValue(today());
            setMinutes(30);
            setNote('');
        }
    }, [open]);

    const save = async () => {
        try {
            setSaving(true);
            // End "now" when logging for today, else at noon of the chosen
            // day, so the entry sits naturally in that day's timeline.
            const isToday = dateValue === today();
            const endedAt = isToday
                ? new Date()
                : new Date(`${dateValue}T12:00:00`);
            const startedAt = new Date(endedAt.getTime() - minutes * 60000);
            await api.post(`/tickets/${ticket.id}/log-time`, {
                startedAt: startedAt.toISOString(),
                endedAt: endedAt.toISOString(),
                note: note.trim() || undefined,
            });
            toast.success('Time logged.');
            onLogged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not log time.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[440px]">
                <DialogHeader>
                    <DialogTitle>Log time</DialogTitle>
                    <DialogDescription className="text-xs">
                        On {ticket?.code} · {ticket?.subject} — logged to{' '}
                        {ticket?.project?.name}.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label className="text-xs">Date</Label>
                            <Input
                                type="date"
                                value={dateValue}
                                max={today()}
                                onChange={(e) => setDateValue(e.target.value)}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Duration</Label>
                            <Select
                                value={String(minutes)}
                                onValueChange={(v) => setMinutes(Number(v))}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {DURATIONS.map((d) => (
                                        <SelectItem
                                            key={d.v}
                                            value={String(d.v)}
                                        >
                                            {d.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Note (optional)</Label>
                        <Textarea
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="What did you do?"
                            rows={2}
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
                        Log time
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default TicketDetail;
