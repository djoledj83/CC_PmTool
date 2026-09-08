// Ticketing workspace (phase 1, in-app). Two panes: a ticket list on
// the left and the selected ticket's detail + conversation on the right.
// Anyone with ticket:create can open a ticket; agents (ticket:manage)
// can answer, post internal notes, assign, and change status/priority.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
    Loader2,
    Plus,
    Send,
    Lock,
    MessageSquare,
    Trash2,
    UserCheck,
    Clock,
    AlertTriangle,
    Inbox,
    HelpCircle,
    Bug,
    FolderKanban,
    CalendarDays,
    ChevronDown,
    Check,
    Filter,
    UserPlus,
    X,
    List as ListIcon,
    LayoutGrid,
    Columns3,
    ListPlus,
    CheckSquare,
    CheckCheck,
    Eye,
    EyeOff,
    Share2,
    Copy,
    Mail,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import TicketBoardColumns from '@/components/TicketBoardColumns';
import TicketCardShared from '@/components/TicketCardShared';
import TicketFieldValues from '@/components/TicketFieldValues';
import {
    Pagination,
    PageSizeControl,
    usePagination,
} from '@/components/Pagination';
import { RichText, RichTextEditor, sanitizeHtml } from '@/components/RichText';
import { SearchableSelect } from '@/components/SearchableSelect';
import { getTicketTypeIcon } from '@/lib/ticketTypeIcons';
import { getTicketTypeBadgeClasses } from '@/lib/ticketTypeColors';
import {
    ChoiceRow,
    CATEGORY_CHOICES,
    PRIORITY_CHOICES,
} from '@/components/TicketChoiceFields';
import { hasCapability, CAPABILITIES } from '@/lib/capabilities';
import { TopBar } from '@/components/TopBar';
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

// Selectable statuses (Open retired — legacy OPEN tickets still render
// via STATUS_BADGE/STATUS_CARD below, they just can't be set again).
const STATUSES = ['NEW', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const TYPES = ['INCIDENT', 'REQUEST', 'QUESTION', 'PROBLEM'];

// Human label for a status enum (handles IN_PROGRESS → "In progress").
const statusLabel = (s) =>
    s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : s;

const STATUS_BADGE = {
    NEW: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30',
    OPEN: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30',
    IN_PROGRESS:
        'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/30',
    PENDING:
        'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
    RESOLVED:
        'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    CLOSED: 'bg-muted text-muted-foreground border-border',
};
const PRIORITY_CLS = {
    URGENT: 'text-rose-600 dark:text-rose-400 font-medium',
    HIGH: 'text-amber-600 dark:text-amber-400 font-medium',
    NORMAL: 'text-muted-foreground',
    LOW: 'text-muted-foreground',
};

// Per-status card skin: a 4px coloured left bar + a faint matching wash
// so each ticket's state reads at a glance in the list (instead of every
// card looking identical). One bg + one border-left-colour utility each,
// so no Tailwind class-order ambiguity.
const STATUS_CARD = {
    NEW: 'border-l-sky-500 bg-sky-50/50 dark:bg-sky-500/10',
    OPEN: 'border-l-blue-500 bg-blue-50/50 dark:bg-blue-500/10',
    IN_PROGRESS: 'border-l-indigo-500 bg-indigo-50/50 dark:bg-indigo-500/10',
    PENDING: 'border-l-amber-500 bg-amber-50/60 dark:bg-amber-500/10',
    RESOLVED: 'border-l-emerald-500 bg-emerald-50/50 dark:bg-emerald-500/10',
    CLOSED: 'border-l-slate-400 bg-muted/50',
};

// Small coloured dot for priority — quicker to scan than the word in a
// dense list. The word still shows on the detail pane.
const PRIORITY_DOT = {
    URGENT: 'bg-rose-500',
    HIGH: 'bg-amber-500',
    NORMAL: 'bg-slate-400',
    LOW: 'bg-slate-300',
};

// Category (ticket type) styling — icon + soft chip colour, mirrored in
// the activity feed / insights so the whole module reads consistently.
const CATEGORY_META = {
    INCIDENT: {
        label: 'Incident',
        icon: AlertTriangle,
        cls: 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
    },
    REQUEST: {
        label: 'Request',
        icon: Inbox,
        cls: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    },
    QUESTION: {
        label: 'Question',
        icon: HelpCircle,
        cls: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
    },
    PROBLEM: {
        label: 'Problem',
        icon: Bug,
        cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    },
};

function CategoryChip({ type }) {
    const meta = CATEGORY_META[type] || CATEGORY_META.REQUEST;
    const Icon = meta.icon;
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                meta.cls,
            )}
        >
            <Icon className="h-3 w-3" />
            {meta.label}
        </span>
    );
}

// Compact date ("Jun 18") for the dense list rows.
function shortDate(value) {
    if (!value) return '';
    try {
        return new Date(value).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
        });
    } catch {
        return '';
    }
}

const titleCase = (s) =>
    s ? s.charAt(0) + s.slice(1).toLowerCase() : s;

function fmtDateTime(value) {
    if (!value) return '';
    try {
        return new Date(value).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return '';
    }
}

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
        default:
            return null;
    }
}

function StatusBadge({ status }) {
    return (
        <span
            className={cn(
                'inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium',
                STATUS_BADGE[status] || STATUS_BADGE.NEW,
            )}
        >
            {statusLabel(status)}
        </span>
    );
}

// Checkbox multi-select filter in a popover. `selected` is an array of
// values; empty = no filter. Used for status + category.
function MultiCheckFilter({ label, options, selected, onChange }) {
    const toggle = (v) =>
        onChange(
            selected.includes(v)
                ? selected.filter((x) => x !== v)
                : [...selected, v],
        );
    const count = selected.length;
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        'flex h-8 flex-1 items-center justify-between gap-1 rounded-md border px-2 text-xs transition-colors hover:bg-accent',
                        count > 0
                            ? 'border-primary/40 bg-primary/5 font-medium'
                            : 'text-muted-foreground',
                    )}
                >
                    <span className="flex items-center gap-1 truncate">
                        <Filter className="h-3 w-3" />
                        {count > 0 ? `${label} · ${count}` : `All ${label}`}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-48 p-1">
                {options.map((o) => {
                    const on = selected.includes(o.value);
                    return (
                        <button
                            key={o.value}
                            type="button"
                            onClick={() => toggle(o.value)}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                        >
                            <span
                                className={cn(
                                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                    on
                                        ? 'border-primary bg-primary text-primary-foreground'
                                        : 'border-input',
                                )}
                            >
                                {on && <Check className="h-3 w-3" />}
                            </span>
                            {o.label}
                        </button>
                    );
                })}
                {count > 0 && (
                    <button
                        type="button"
                        onClick={() => onChange([])}
                        className="mt-1 w-full rounded px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent"
                    >
                        Clear
                    </button>
                )}
            </PopoverContent>
        </Popover>
    );
}

// The ticket workspace is reusable: the /tickets route renders it plain,
// and the "My tickets" tab on the To-do page renders it `embedded` with
// `baseParams={{ assigneeId: 'me' }}` so it shows the same list / grid /
// board views and filters scoped to the current resolver — without its own
// TopBar and without touching the URL (so closing a ticket stays put).
export default function Tickets({
    embedded = false,
    baseParams = null,
    storagePrefix = 'tickets',
} = {}) {
    const { user } = useAuth();
    const canCreate = hasCapability(user, CAPABILITIES.TICKET_CREATE);
    const canManage = hasCapability(user, CAPABILITIES.TICKET_MANAGE);
    const baseParamsKey = JSON.stringify(baseParams || null);
    // Only admins (or holders of view-all) see every ticket; the "by
    // user" filter is theirs.
    const canViewAll =
        user?.role === 'ADMIN' ||
        hasCapability(user, CAPABILITIES.TICKET_VIEW_ALL);

    const [tickets, setTickets] = useState([]);
    const [loading, setLoading] = useState(true);
    // Multi-select: empty array = no filter (show all). The checkbox
    // popovers toggle individual values on/off.
    const [statusSel, setStatusSel] = useState([]);
    const [typeSel, setTypeSel] = useState([]);
    // Named request types (portal types) + the selected-ids filter.
    const [requestTypes, setRequestTypes] = useState([]);
    const [reqTypeSel, setReqTypeSel] = useState([]);
    // Internal (agent-raised) vs external (requester-raised) filter.
    const [internalSel, setInternalSel] = useState([]);
    const [userFilter, setUserFilter] = useState('');
    const [users, setUsers] = useState([]);
    const [q, setQ] = useState('');
    const [selectedId, setSelectedId] = useState(null);
    const [createOpen, setCreateOpen] = useState(false);
    // Per-user "hidden" tickets (a personal declutter — not a delete).
    // Kept in localStorage, keyed by user so a shared browser stays sane.
    const hiddenKey = `${storagePrefix}.hidden.${user?.id || 'anon'}`;
    const [hiddenIds, setHiddenIds] = useState(() => {
        try {
            const raw = localStorage.getItem(hiddenKey);
            return new Set(raw ? JSON.parse(raw) : []);
        } catch {
            return new Set();
        }
    });
    const [showHidden, setShowHidden] = useState(false);
    const toggleHide = (id) => {
        setHiddenIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            try {
                localStorage.setItem(hiddenKey, JSON.stringify([...next]));
            } catch {
                /* ignore quota */
            }
            return next;
        });
    };
    const [view, setView] = useState(() => {
        try {
            return localStorage.getItem(`${storagePrefix}.view`) || 'list';
        } catch {
            return 'list';
        }
    });
    const changeView = (v) => {
        setView(v);
        try {
            localStorage.setItem(`${storagePrefix}.view`, v);
        } catch {
            /* ignore */
        }
    };
    const openTicket = (t) => {
        setSelectedId(t.id);
        if (t.unread) {
            setTickets((prev) =>
                prev.map((x) => (x.id === t.id ? { ...x, unread: false } : x)),
            );
        }
    };
    const [searchParams, setSearchParams] = useSearchParams();

    // Deep-link support: /tickets?ticket=<id> (e.g. from the activity
    // feed or a notification) opens that ticket directly. We clear the
    // param once consumed so a later manual selection doesn't keep getting
    // overridden. Depending on `searchParams` (not just mount) means this
    // re-fires when you click a ticket notification while ALREADY on this
    // page — the URL's ?ticket= changes, so the modal opens every time
    // instead of only on the first visit.
    useEffect(() => {
        // Embedded instances (e.g. the To-do "My tickets" tab) never touch
        // the URL — the modal is driven purely by internal state so closing
        // a ticket leaves you exactly where you were.
        if (embedded) return;
        const deepId = searchParams.get('ticket');
        if (deepId) {
            setSelectedId(deepId);
            searchParams.delete('ticket');
            setSearchParams(searchParams, { replace: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams, embedded]);

    useEffect(() => {
        if (!canViewAll) return;
        api.get('/users')
            .then(({ data }) => setUsers(data.users || data || []))
            .catch(() => setUsers([]));
    }, [canViewAll]);

    // Request types power the "ticket types" filter dropdown.
    useEffect(() => {
        api.get('/ticket-request-types')
            .then(({ data }) => setRequestTypes(data.requestTypes || []))
            .catch(() => setRequestTypes([]));
    }, []);

    const loadTickets = useCallback(
        async ({ silent = false } = {}) => {
            try {
                if (!silent) setLoading(true);
                const params = { ...(baseParams || {}) };
                if (statusSel.length) params.status = statusSel.join(',');
                if (typeSel.length) params.type = typeSel.join(',');
                if (reqTypeSel.length)
                    params.requestTypeId = reqTypeSel.join(',');
                // Only filter when exactly one of internal/external is
                // picked (both or none = show all).
                if (internalSel.length === 1)
                    params.internal =
                        internalSel[0] === 'internal' ? '1' : '0';
                if (userFilter) params.userId = userFilter;
                if (q.trim()) params.q = q.trim();
                const { data } = await api.get('/tickets', { params });
                // Keep the open ticket from re-flagging as unread on a
                // live refresh — the agent is looking right at it.
                setTickets(
                    (data.tickets || []).map((t) =>
                        t.id === selectedId ? { ...t, unread: false } : t,
                    ),
                );
            } catch (err) {
                if (!silent)
                    toast.error(
                        err.response?.data?.error || 'Could not load tickets.',
                    );
            } finally {
                if (!silent) setLoading(false);
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [statusSel, typeSel, reqTypeSel, internalSel, userFilter, q, selectedId, baseParamsKey],
    );

    useEffect(() => {
        loadTickets();
    }, [loadTickets]);

    // Live queue: any ticket activity anywhere (new ticket, reply,
    // status/assignee change) silently refreshes the list so unread
    // badges, ordering and new rows appear without a manual reload —
    // the same `ticket:activity` signal the portal already uses.
    const { subscribe } = useRealtime();
    useEffect(() => {
        const off = subscribe('ticket:activity', () => {
            loadTickets({ silent: true });
        });
        return off;
    }, [subscribe, loadTickets]);

    const onCreated = (ticket) => {
        setCreateOpen(false);
        loadTickets();
        if (ticket?.id) setSelectedId(ticket.id);
    };

    // Hidden tickets drop out of every view unless "Show hidden" is on.
    const visibleTickets = showHidden
        ? tickets
        : tickets.filter((t) => !hiddenIds.has(t.id));
    const hiddenCount = tickets.filter((t) => hiddenIds.has(t.id)).length;

    // List + grid views are paginated (20/50/100). The board shows every
    // ticket in its column, so it isn't paged.
    const { page, setPage, pageSize, setPageSize, total, totalPages, pageItems } =
        usePagination(visibleTickets, 20);

    const Container = embedded ? 'div' : 'main';
    return (
        <>
            {!embedded && (
                <TopBar
                    title="Ticketing"
                    actions={
                        canCreate ? (
                            <Button
                                size="sm"
                                className="gap-1.5"
                                onClick={() => setCreateOpen(true)}
                            >
                                <Plus className="h-4 w-4" /> New ticket
                            </Button>
                        ) : null
                    }
                />
            )}
            <Container
                className={cn(
                    'flex flex-col overflow-hidden',
                    embedded
                        ? 'h-[calc(100vh-15rem)] min-h-[460px] rounded-lg border bg-card p-3'
                        : 'flex-1 bg-muted/20 p-3 sm:p-4',
                )}
            >
                {/* Filters + view switcher */}
                <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
                    <Input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search subject or code…"
                        className="h-8 w-[200px] text-xs"
                    />
                    <div className="flex items-center gap-2">
                        <MultiCheckFilter
                            label="statuses"
                            selected={statusSel}
                            onChange={setStatusSel}
                            options={STATUSES.map((s) => ({
                                value: s,
                                label: statusLabel(s),
                            }))}
                        />
                        <MultiCheckFilter
                            label="categories"
                            selected={typeSel}
                            onChange={setTypeSel}
                            options={TYPES.map((t) => ({
                                value: t,
                                label: titleCase(t),
                            }))}
                        />
                        {requestTypes.length > 0 && (
                            <MultiCheckFilter
                                label="ticket types"
                                selected={reqTypeSel}
                                onChange={setReqTypeSel}
                                options={requestTypes.map((rt) => ({
                                    value: rt.id,
                                    label: rt.name,
                                }))}
                            />
                        )}
                        <MultiCheckFilter
                            label="kinds"
                            selected={internalSel}
                            onChange={setInternalSel}
                            options={[
                                { value: 'internal', label: 'Internal' },
                                { value: 'external', label: 'External' },
                            ]}
                        />
                    </div>
                    {canViewAll && !embedded && (
                        <SearchableSelect
                            className="w-[170px]"
                            value={userFilter || 'all'}
                            onChange={(v) =>
                                setUserFilter(v === 'all' ? '' : v)
                            }
                            placeholder="Any user"
                            searchPlaceholder="Search user…"
                            options={[
                                { value: 'all', label: 'Any user' },
                                ...users.map((u) => ({
                                    value: u.id,
                                    label: u.name || u.email,
                                })),
                            ]}
                        />
                    )}
                    <div className="ml-auto flex items-center gap-2">
                        {view !== 'board' && (
                            <PageSizeControl
                                pageSize={pageSize}
                                onPageSizeChange={setPageSize}
                                options={[20, 50, 100]}
                            />
                        )}
                        {(hiddenCount > 0 || showHidden) && (
                            <button
                                type="button"
                                onClick={() => setShowHidden((s) => !s)}
                                className={cn(
                                    'flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
                                    showHidden
                                        ? 'border-primary/40 bg-primary/5 font-medium'
                                        : 'text-muted-foreground hover:bg-accent',
                                )}
                                title={
                                    showHidden
                                        ? 'Hide the hidden tickets again'
                                        : 'Show tickets you have hidden'
                                }
                            >
                                {showHidden ? (
                                    <Eye className="h-3.5 w-3.5" />
                                ) : (
                                    <EyeOff className="h-3.5 w-3.5" />
                                )}
                                {showHidden
                                    ? 'Hide hidden'
                                    : `Show hidden (${hiddenCount})`}
                            </button>
                        )}
                        <div className="flex items-center rounded-md border bg-card p-0.5">
                            {[
                                { id: 'list', Icon: ListIcon, label: 'List' },
                                { id: 'grid', Icon: LayoutGrid, label: 'Grid' },
                                { id: 'board', Icon: Columns3, label: 'Board' },
                            ].map((v) => (
                                <button
                                    key={v.id}
                                    type="button"
                                    title={v.label}
                                    aria-label={v.label}
                                    onClick={() => changeView(v.id)}
                                    className={cn(
                                        'flex h-7 w-7 items-center justify-center rounded transition-colors',
                                        view === v.id
                                            ? 'bg-primary text-primary-foreground'
                                            : 'text-muted-foreground hover:bg-accent',
                                    )}
                                >
                                    <v.Icon className="h-3.5 w-3.5" />
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {loading ? (
                    <p className="flex items-center gap-1.5 p-4 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </p>
                ) : tickets.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">
                        No tickets yet.
                        {canCreate && ' Open one with “New ticket”.'}
                    </p>
                ) : view === 'list' ? (
                    <>
                        <div className="flex-1 space-y-3 overflow-y-auto">
                            {pageItems.map((t) => (
                                <TicketCardShared
                                    key={t.id}
                                    t={t}
                                    selected={selectedId === t.id}
                                    onOpen={openTicket}
                                    hidden={hiddenIds.has(t.id)}
                                    onToggleHide={() => toggleHide(t.id)}
                                />
                            ))}
                        </div>
                        <Pagination
                            page={page}
                            pageSize={pageSize}
                            total={total}
                            totalPages={totalPages}
                            onPageChange={setPage}
                            onPageSizeChange={setPageSize}
                            pageSizeOptions={[20, 50, 100]}
                            className="shrink-0"
                        />
                    </>
                ) : view === 'grid' ? (
                    <>
                        <div className="grid flex-1 content-start items-start gap-3 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            {pageItems.map((t) => (
                                <TicketCardShared
                                    key={t.id}
                                    t={t}
                                    selected={selectedId === t.id}
                                    onOpen={openTicket}
                                    hidden={hiddenIds.has(t.id)}
                                    onToggleHide={() => toggleHide(t.id)}
                                />
                            ))}
                        </div>
                        <Pagination
                            page={page}
                            pageSize={pageSize}
                            total={total}
                            totalPages={totalPages}
                            onPageChange={setPage}
                            onPageSizeChange={setPageSize}
                            pageSizeOptions={[20, 50, 100]}
                            className="shrink-0"
                        />
                    </>
                ) : (
                    <div className="min-h-0 flex-1">
                        <TicketBoardColumns
                            statuses={STATUSES}
                            items={visibleTickets}
                            labelFor={statusLabel}
                            badgeClassFor={(s) =>
                                STATUS_BADGE[s] || STATUS_BADGE.NEW
                            }
                            storageKey={`${storagePrefix}.board.collapsed`}
                            renderCard={(t) => (
                                <TicketCardShared
                                    key={t.id}
                                    t={t}
                                    onOpen={openTicket}
                                    hidden={hiddenIds.has(t.id)}
                                    onToggleHide={() => toggleHide(t.id)}
                                />
                            )}
                        />
                    </div>
                )}
            </Container>

            {/* Ticket detail opens in a modal. */}
            <Dialog
                open={!!selectedId}
                onOpenChange={(o) => {
                    if (!o) setSelectedId(null);
                }}
            >
                <DialogContent className="w-[90vw] max-w-[90vw] gap-0 overflow-hidden p-0 sm:w-[90vw] sm:max-w-[90vw]">
                    {selectedId && (
                        <div className="overflow-hidden">
                            <TicketDetail
                                key={selectedId}
                                ticketId={selectedId}
                                canManage={canManage}
                                currentUser={user}
                                onChanged={loadTickets}
                                onDeleted={() => setSelectedId(null)}
                            />
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            <NewTicketDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={onCreated} />
        </>
    );
}

// Labeled field for the ticket meta panel — a small uppercase caption
// above its control so every dropdown is clearly identified.
function MetaField({ label, children, className }) {
    return (
        <div className={cn('flex min-w-0 flex-col gap-1', className)}>
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {label}
            </span>
            {children}
        </div>
    );
}

// Reduce a ticket to the editable-field snapshot the draft tracks, so we
// can compare "what's on the server" against "what the resolver has picked".
function ticketFieldSnapshot(t) {
    return {
        projectId: t?.project?.id || '',
        status: t?.status || '',
        priority: t?.priority || '',
        assigneeId: t?.assignee?.id || null,
    };
}

function TicketDetail({ ticketId, canManage, currentUser, onChanged, onDeleted }) {
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
                if (!silent)
                    toast.error(
                        err.response?.data?.error || 'Could not load ticket.',
                    );
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
        try {
            await navigator.clipboard.writeText(ticketUrl);
            toast.success('Link copied.');
        } catch {
            toast.error('Could not copy the link.');
        }
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
            .filter((e) => agentEventLabel(e))
            .map((e) => ({ kind: 'event', at: e.createdAt, data: e }));
        return [...msgs, ...evs].sort(
            (a, b) => new Date(a.at) - new Date(b.at),
        );
    }, [messages, events]);

    // Scroll to the newest entry on load and as new ones arrive.
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ block: 'end' });
    }, [timeline.length]);

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
    useEffect(() => {
        if (!serverSnapshot) return;
        setDraft((prev) => {
            if (
                prev &&
                JSON.stringify(prev) !== JSON.stringify(serverSnapshot)
            ) {
                return prev; // local edits in progress — keep them
            }
            return serverSnapshot;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(serverSnapshot)]);

    const setField = (patchObj) =>
        setDraft((prev) => ({ ...(prev || serverSnapshot), ...patchObj }));

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
        } catch (err) {
            toast.error(err.response?.data?.error || 'Update failed.');
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
        if (!window.confirm(`Delete ${ticket?.code}? This cannot be undone.`))
            return;
        try {
            await api.delete(`/tickets/${ticketId}`);
            toast.success('Ticket deleted.');
            onChanged?.();
            onDeleted?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete.');
        }
    };

    const send = async () => {
        if ((replyEmpty && pendingFiles.length === 0) || sending) return;
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
            setInternal(false);
            setPendingFiles([]);
            // Silent reload (no spinner / unmount) so the thread stays put,
            // then jump to the newest message we just sent.
            await load({ silent: true });
            // If replying just took the ticket, drop the staged draft so it
            // re-syncs to the assigned snapshot (mirrors take()).
            if (willAutoTake) setDraft(null);
            requestAnimationFrame(() =>
                bottomRef.current?.scrollIntoView({ block: 'end' }),
            );
            onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not send.');
        } finally {
            setSending(false);
        }
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

    return (
        <div className="flex max-h-[90vh] min-h-0 flex-col lg:flex-row">
            {/* Left column: code, type, title, full description, agent
                actions, meta, captured details, people and attachments —
                everything ABOUT the ticket. The conversation gets its own
                wide column on the right (stacks below on narrow screens). */}
            <div className="flex max-h-[45vh] min-w-0 shrink-0 flex-col gap-3 overflow-y-auto border-b bg-background p-4 lg:max-h-none lg:w-1/3 lg:border-b-0 lg:border-r">
                {/* Ticket identity: code + type + title + full description. */}
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[11px] text-muted-foreground">
                            {ticket.code}
                        </span>
                        {ticket.requestType && (
                            <span
                                title={ticket.requestType.name}
                                className={cn(
                                    'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
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
                                className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                            >
                                <Lock className="h-3 w-3" />
                                Internal
                            </span>
                        )}
                    </div>
                    <h2 className="mt-1 text-lg font-semibold leading-snug">
                        {ticket.subject}
                    </h2>
                    {ticket.description && (
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground/90">
                            {ticket.description}
                        </p>
                    )}
                </div>
                    {canManage && (
                        <div className="flex flex-wrap gap-1.5">
                            <Popover
                                open={shareOpen}
                                onOpenChange={setShareOpen}
                            >
                                <PopoverTrigger asChild>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 gap-1 px-2 text-xs"
                                    >
                                        <Share2 className="h-3.5 w-3.5" /> Share
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
                                            options={users.map((u) => ({
                                                value: u.id,
                                                label: u.name || u.email,
                                            }))}
                                        />
                                    </div>
                                </PopoverContent>
                            </Popover>
                            {!ticket.assignee && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className={cn(
                                        'h-7 gap-1 px-2 text-xs',
                                        !(draft?.projectId || ticket.project?.id) &&
                                            'opacity-60',
                                    )}
                                    onClick={take}
                                    title={
                                        !(draft?.projectId || ticket.project?.id)
                                            ? 'Assign a project before taking the ticket'
                                            : 'Assign this ticket to you'
                                    }
                                >
                                    <UserCheck className="h-3.5 w-3.5" /> Take it
                                </Button>
                            )}
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 px-2 text-xs"
                                onClick={() => setLogTimeOpen(true)}
                            >
                                <Clock className="h-3.5 w-3.5" /> Log time
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 px-2 text-xs"
                                onClick={() => setAddTaskOpen(true)}
                            >
                                <ListPlus className="h-3.5 w-3.5" /> Add as task
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 px-2 text-xs text-rose-600"
                                onClick={removeTicket}
                            >
                                <Trash2 className="h-3.5 w-3.5" /> Delete
                            </Button>
                        </div>
                    )}
                {/* Meta: project on its own line, then reporter / status /
                    priority / assignee as labeled fields. */}
                <div className="space-y-2 text-xs">
                    {canManage && ticket.linkedTasks?.length > 0 && (
                        <MetaField label="Tasks">
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
                        </MetaField>
                    )}

                    {canManage && dirty && (
                        <div className="flex items-center justify-between gap-2 rounded-md border border-amber-400/50 bg-amber-500/10 px-2.5 py-1.5 text-xs">
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

                    <MetaField label="Project">
                        {canManage ? (
                            <SearchableSelect
                                value={draft?.projectId ?? ''}
                                onChange={(v) => setField({ projectId: v })}
                                placeholder="No project"
                                searchPlaceholder="Search projects…"
                                options={projects.map((p) => ({
                                    value: p.id,
                                    label:
                                        (p.code ? `${p.code} · ` : '') + p.name,
                                }))}
                            />
                        ) : (
                            <span className="font-medium text-foreground">
                                {ticket.project?.name || '—'}
                            </span>
                        )}
                    </MetaField>

                    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                        <MetaField label="Reporter">
                            <span className="truncate font-medium text-foreground">
                                {ticket.reporter?.name || '—'}
                            </span>
                        </MetaField>
                        <MetaField label="Status">
                            {canManage ? (
                                <Select
                                    value={draft?.status ?? ticket.status}
                                    onValueChange={(v) =>
                                        setField({ status: v })
                                    }
                                >
                                    <SelectTrigger className="h-8 w-full text-xs">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {STATUSES.map((s) => (
                                            <SelectItem key={s} value={s}>
                                                {statusLabel(s)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            ) : (
                                <span>
                                    <StatusBadge status={ticket.status} />
                                </span>
                            )}
                        </MetaField>
                        <MetaField label="Priority">
                            {canManage ? (
                                <Select
                                    value={draft?.priority ?? ticket.priority}
                                    onValueChange={(v) =>
                                        setField({ priority: v })
                                    }
                                >
                                    <SelectTrigger className="h-8 w-full text-xs">
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
                            ) : (
                                <span
                                    className={cn(
                                        'font-medium',
                                        PRIORITY_CLS[ticket.priority],
                                    )}
                                >
                                    {titleCase(ticket.priority)}
                                </span>
                            )}
                        </MetaField>
                        {canManage && (
                            <MetaField label="Assignee">
                                <Select
                                    value={draft?.assigneeId || 'none'}
                                    onValueChange={(v) =>
                                        setField({
                                            assigneeId:
                                                v === 'none' ? null : v,
                                        })
                                    }
                                >
                                    <SelectTrigger className="h-8 w-full text-xs">
                                        <SelectValue placeholder="Unassigned" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="none">
                                            Unassigned
                                        </SelectItem>
                                        {users.map((u) => (
                                            <SelectItem
                                                key={u.id}
                                                value={u.id}
                                            >
                                                {u.name || u.email}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </MetaField>
                        )}
                    </div>
                </div>

                {/* Captured details, people and attachments stay with the
                    rest of the ticket info in this left column. */}
                <TicketFieldValues ticket={ticket} />
                <ParticipantsBar
                    layout="aside"
                    reporter={ticket.reporter}
                    assignee={ticket.assignee}
                    participants={participants}
                    users={users}
                    canManage={canManage}
                    onAdd={addParticipant}
                    onRemove={removeParticipant}
                />
                <div>
                    <h3 className="mb-2 text-sm font-medium">Attachments</h3>
                    <TicketAttachments
                        ticketId={ticket.id}
                        attachments={ticketAtts}
                        currentUserId={currentUser?.id}
                        canManage={canManage}
                        onChanged={load}
                    />
                </div>
            </div>

            {/* Right column: the conversation thread + reply composer get
                the wide half, so long threads are easy to read instead of
                being squeezed beside the description. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-hidden">
                {/* Scrollable conversation — messages left & right. */}
                <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {timeline.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        No activity yet.
                    </p>
                ) : (
                    timeline.map((item) => {
                        if (item.kind === 'event') {
                            const e = item.data;
                            return (
                                <p
                                    key={`e-${e.id}`}
                                    className="text-xs text-muted-foreground"
                                >
                                    <span className="text-foreground">
                                        {e.actor?.name || 'Someone'}
                                    </span>{' '}
                                    {agentEventLabel(e)} ·{' '}
                                    {fmtDateTime(e.createdAt)}
                                </p>
                            );
                        }
                        const m = item.data;
                        const mine = m.author?.id === currentUser?.id;
                        const isInternal = m.direction === 'INTERNAL';
                        return (
                            <div
                                key={m.id}
                                className={cn(
                                    'flex gap-2',
                                    mine && !isInternal && 'flex-row-reverse',
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
                                        {initials(m.author?.name || '?')}
                                    </AvatarFallback>
                                </Avatar>
                                <div
                                    className={cn(
                                        'flex max-w-[80%] flex-col gap-0.5',
                                        mine && !isInternal && 'items-end',
                                    )}
                                >
                                <div
                                    className={cn(
                                        'rounded-lg px-3 py-2 text-sm',
                                        isInternal
                                            ? 'border border-amber-400/40 bg-amber-500/10 text-amber-900 dark:text-amber-200'
                                            : mine
                                              ? 'bg-primary text-primary-foreground'
                                              : 'border bg-background',
                                    )}
                                >
                                    <div
                                        className={cn(
                                            'mb-0.5 flex items-center gap-1.5 text-[10px]',
                                            isInternal
                                                ? 'text-amber-700 dark:text-amber-300'
                                                : mine
                                                  ? 'text-primary-foreground/80'
                                                  : 'text-muted-foreground',
                                        )}
                                    >
                                        {isInternal && (
                                            <Lock className="h-3 w-3" />
                                        )}
                                        <span>{m.author?.name || 'Someone'}</span>
                                        <span>· {fmtDateTime(m.createdAt)}</span>
                                        {isInternal && (
                                            <span>· internal note</span>
                                        )}
                                    </div>
                                    {m.body && (
                                        <RichText
                                            source={m.body}
                                            variant={
                                                mine && !isInternal
                                                    ? 'onPrimary'
                                                    : undefined
                                            }
                                        />
                                    )}
                                    {attByMessage[m.id] && (
                                        <div className="mt-1.5">
                                            <AttachmentList
                                                items={attByMessage[m.id]}
                                                ticketId={ticket.id}
                                                currentUserId={currentUser?.id}
                                                canManage={canManage}
                                                onChanged={load}
                                            />
                                        </div>
                                    )}
                                </div>
                                {mine &&
                                    !isInternal &&
                                    m.id === lastSeenMineId && (
                                        <p
                                            className="flex items-center gap-1 px-1 text-[10px] font-medium text-primary"
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
                                        >
                                            <CheckCheck className="h-3 w-3" />
                                            {seenByForMarked.length === 0
                                                ? 'Seen'
                                                : seenByForMarked.length === 1
                                                  ? `Seen by ${seenByForMarked[0].name.split(' ')[0]}`
                                                  : `Seen by ${seenByForMarked[0].name.split(' ')[0]} +${seenByForMarked.length - 1}`}
                                        </p>
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
                <div ref={bottomRef} />
            </div>

            {ticket.status === 'CLOSED' ? (
                <div className="shrink-0 border-t bg-background p-3 text-center text-xs text-muted-foreground">
                    This ticket is closed.{' '}
                    {canManage ? (
                        <button
                            type="button"
                            onClick={() => patch({ status: 'IN_PROGRESS' })}
                            className="font-medium text-primary hover:underline"
                        >
                            Reopen to comment
                        </button>
                    ) : (
                        'A resolver must reopen it to add comments.'
                    )}
                </div>
            ) : (
            <div className="shrink-0 border-t bg-background p-3">
                {canManage && (
                    <div className="mb-2 flex gap-1.5 text-xs">
                        <button
                            type="button"
                            onClick={() => setInternal(false)}
                            className={cn(
                                'rounded-md px-2.5 py-1',
                                !internal
                                    ? 'bg-secondary font-medium'
                                    : 'text-muted-foreground',
                            )}
                        >
                            Reply
                        </button>
                        <button
                            type="button"
                            onClick={() => setInternal(true)}
                            className={cn(
                                'rounded-md px-2.5 py-1',
                                internal
                                    ? 'bg-amber-500/15 font-medium text-amber-800 dark:text-amber-200'
                                    : 'text-muted-foreground',
                            )}
                        >
                            Internal note
                        </button>
                    </div>
                )}
                <div className="flex items-end gap-2">
                    <RichTextEditor
                        ref={editorRef}
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
                                ? 'Internal note (not visible to the requester)… (Ctrl+Enter to send)'
                                : 'Write a reply… (paste a screenshot, Ctrl+Enter to send)'
                        }
                        className="flex-1"
                    />
                    <Button
                        className="gap-1.5"
                        disabled={
                            (replyEmpty && pendingFiles.length === 0) ||
                            sending ||
                            (canManage &&
                                !(draft?.projectId || ticket.project?.id))
                        }
                        title={
                            canManage &&
                            !(draft?.projectId || ticket.project?.id)
                                ? 'Select a project before replying'
                                : undefined
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
                {canManage &&
                    !internal &&
                    (!(draft?.projectId || ticket.project?.id) ? (
                        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-600">
                            <AlertTriangle className="h-3 w-3" />
                            Select a project to reply — it takes the ticket.
                        </p>
                    ) : !ticket.assignee ? (
                        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                            <UserCheck className="h-3 w-3" />
                            Replying will assign this ticket to you.
                        </p>
                    ) : null)}
                <div className="mt-2">
                    <PendingFilePicker
                        files={pendingFiles}
                        onFiles={setPendingFiles}
                        disabled={sending}
                    />
                </div>
            </div>
            )}
                </div>
            <TicketLogTimeDialog
                open={logTimeOpen}
                onOpenChange={setLogTimeOpen}
                ticket={ticket}
                onLogged={() => setLogTimeOpen(false)}
            />
            <AddAsTaskDialog
                open={addTaskOpen}
                onOpenChange={setAddTaskOpen}
                ticket={ticket}
                projects={projects}
                users={users}
                onCreated={() => {
                    setAddTaskOpen(false);
                    load();
                    onChanged?.();
                }}
            />
        </div>
    );
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
        setDescription(ticket?.description || '');
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

function PersonChip({ user, role, onRemove }) {
    if (!user) return null;
    return (
        <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 py-0.5 pl-0.5 pr-2 text-xs">
            <Avatar className="h-5 w-5">
                {user.avatarUrl && (
                    <AvatarImage
                        src={resolveAssetUrl(user.avatarUrl)}
                        alt={user.name}
                    />
                )}
                <AvatarFallback className="bg-primary/10 text-[9px] text-primary">
                    {initials(user.name || '?')}
                </AvatarFallback>
            </Avatar>
            <span className="max-w-[120px] truncate">
                {user.name || user.email}
            </span>
            <span className="text-[10px] text-muted-foreground">{role}</span>
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
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    const aside = layout === 'aside';
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
            <PersonChip user={reporter} role="Requester" />
            {assignee && <PersonChip user={assignee} role="Assignee" />}
            {participants.map((p) => (
                <PersonChip
                    key={p.id}
                    user={p}
                    role="Watcher"
                    onRemove={canManage ? () => onRemove(p.id) : null}
                />
            ))}
        </>
    );
    const addBtn = canManage && (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-1 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
                >
                    <UserPlus className="h-3.5 w-3.5" />
                    Add
                </button>
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

function NewTicketDialog({ open, onOpenChange, onCreated }) {
    const [projects, setProjects] = useState([]);
    const [subject, setSubject] = useState('');
    const [projectId, setProjectId] = useState('');
    const [type, setType] = useState('REQUEST');
    const [priority, setPriority] = useState('NORMAL');
    const [description, setDescription] = useState('');
    const [pendingFiles, setPendingFiles] = useState([]);
    const [internal, setInternal] = useState(false);
    const [people, setPeople] = useState([]); // selected participant ids
    const [users, setUsers] = useState([]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setSubject('');
        setProjectId('');
        setType('REQUEST');
        setPriority('NORMAL');
        setDescription('');
        setPendingFiles([]);
        setInternal(false);
        setPeople([]);
        api.get('/projects')
            .then(({ data }) => setProjects(data.projects || data || []))
            .catch(() => setProjects([]));
        api.get('/users')
            .then(({ data }) => setUsers(data.users || data || []))
            .catch(() => setUsers([]));
    }, [open]);

    const togglePerson = (id) =>
        setPeople((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );

    const save = async () => {
        if (!subject.trim()) return toast.error('Enter a subject.');
        if (!projectId) return toast.error('Pick a project.');
        if (internal && people.length === 0)
            return toast.error('Pick who can see this internal ticket.');
        try {
            setSaving(true);
            const { data } = await api.post('/tickets', {
                subject: subject.trim(),
                projectId,
                type,
                priority,
                description: description.trim() || undefined,
                internal,
                participantIds: internal ? people : undefined,
            });
            for (const f of pendingFiles) {
                await uploadTicketFile(data.ticket.id, f);
            }
            toast.success('Ticket opened.');
            onCreated?.(data.ticket);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not open ticket.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[520px]">
                <DialogHeader>
                    <DialogTitle>New ticket</DialogTitle>
                    <DialogDescription>
                        Every ticket belongs to a project — pick one below.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label className="text-xs">Subject</Label>
                        <Input
                            value={subject}
                            onChange={(e) => setSubject(e.target.value)}
                            placeholder="Short summary of the issue"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">
                            Project <span className="text-rose-500">*</span>
                        </Label>
                        <Select value={projectId} onValueChange={setProjectId}>
                            <SelectTrigger>
                                <SelectValue placeholder="Select a project" />
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
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label className="text-xs">Category</Label>
                            <ChoiceRow
                                value={type}
                                onChange={setType}
                                choices={CATEGORY_CHOICES}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Priority</Label>
                            <ChoiceRow
                                value={priority}
                                onChange={setPriority}
                                choices={PRIORITY_CHOICES}
                            />
                        </div>
                    </div>
                    {/* Visibility: external (shared queue) vs internal
                        (only the selected people). */}
                    <div className="space-y-1.5">
                        <Label className="text-xs">Visibility</Label>
                        <div className="grid grid-cols-2 gap-1.5">
                            <button
                                type="button"
                                onClick={() => setInternal(false)}
                                className={cn(
                                    'rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                                    !internal
                                        ? 'border-primary bg-primary/10 text-foreground'
                                        : 'text-muted-foreground hover:bg-accent',
                                )}
                            >
                                <div className="font-medium">External</div>
                                <div className="text-[10px] text-muted-foreground">
                                    Visible to everyone, like a normal ticket.
                                </div>
                            </button>
                            <button
                                type="button"
                                onClick={() => setInternal(true)}
                                className={cn(
                                    'rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                                    internal
                                        ? 'border-primary bg-primary/10 text-foreground'
                                        : 'text-muted-foreground hover:bg-accent',
                                )}
                            >
                                <div className="font-medium">Internal</div>
                                <div className="text-[10px] text-muted-foreground">
                                    Only the people you pick can see it.
                                </div>
                            </button>
                        </div>
                    </div>
                    {internal && (
                        <div className="space-y-1.5">
                            <Label className="text-xs">
                                Who can see it{' '}
                                <span className="text-rose-500">*</span>
                            </Label>
                            <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-1">
                                {users.length === 0 ? (
                                    <p className="px-2 py-2 text-xs text-muted-foreground">
                                        No users available.
                                    </p>
                                ) : (
                                    users.map((u) => {
                                        const on = people.includes(u.id);
                                        return (
                                            <button
                                                key={u.id}
                                                type="button"
                                                onClick={() =>
                                                    togglePerson(u.id)
                                                }
                                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                                            >
                                                <span
                                                    className={cn(
                                                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                                        on
                                                            ? 'border-primary bg-primary text-primary-foreground'
                                                            : 'border-input',
                                                    )}
                                                >
                                                    {on && (
                                                        <Check className="h-3 w-3" />
                                                    )}
                                                </span>
                                                <span className="truncate">
                                                    {u.name || u.email}
                                                </span>
                                            </button>
                                        );
                                    })
                                )}
                            </div>
                            {people.length > 0 && (
                                <p className="text-[11px] text-muted-foreground">
                                    {people.length}{' '}
                                    {people.length === 1 ? 'person' : 'people'}{' '}
                                    selected.
                                </p>
                            )}
                        </div>
                    )}
                    <div className="space-y-1.5">
                        <Label className="text-xs">Description</Label>
                        <Textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="What's happening? Steps, context, terminal/SN…"
                            rows={4}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Attachments</Label>
                        <PendingFilePicker
                            files={pendingFiles}
                            onFiles={setPendingFiles}
                            disabled={saving}
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
                        {saving && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Open ticket
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
