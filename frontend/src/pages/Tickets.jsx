// Ticketing workspace (phase 1, in-app). Two panes: a ticket list on
// the left and the selected ticket's detail + conversation on the right.
// Anyone with ticket:create can open a ticket; agents (ticket:manage)
// can answer, post internal notes, assign, and change status/priority.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
    Loader2,
    Plus,
    AlertTriangle,
    Inbox,
    HelpCircle,
    Bug,
    ChevronDown,
    Check,
    Filter,
    List as ListIcon,
    LayoutGrid,
    Columns3,
    Eye,
    EyeOff,
    FileText,
    Folder,
    Globe,
    Lock,
    Send,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import TicketBoardColumns from '@/components/TicketBoardColumns';
import TicketCardShared from '@/components/TicketCardShared';
import {
    Pagination,
    PageSizeControl,
    usePagination,
} from '@/components/Pagination';

import { SearchableSelect } from '@/components/SearchableSelect';

import {
    ChoiceCards,
    CATEGORY_CHOICES,
    PRIORITY_CHOICES,
} from '@/components/TicketChoiceFields';
import {
    DescriptionField,
    FileDropzone,
    FormLabel,
    IconInput,
    RaiseHelpCards,
    RaiseShell,
} from '@/components/RaiseTicketParts';
import { sanitizeHtml } from '@/components/RichText';
import { hasCapability, CAPABILITIES } from '@/lib/capabilities';
import {
    STATUSES,
    STATUS_BADGE,
    statusLabel,
    titleCase,
} from '@/lib/ticketMeta';

import { TopBar } from '@/components/TopBar';
import { TicketDetail } from '@/components/TicketDetail';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { uploadTicketFile } from '@/components/TicketAttachments';
import { Dialog, DialogContent } from '@/components/ui/dialog';

import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

const TYPES = ['INCIDENT', 'REQUEST', 'QUESTION', 'PROBLEM'];

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
                {/* Fixed height on desktop so the conversation and the
                    details column scroll on their own; on small screens
                    the whole body scrolls. */}
                <DialogContent className="flex max-h-[94vh] flex-col gap-0 overflow-hidden p-0 lg:h-[94vh]">
                    {selectedId && (
                        <TicketDetail
                            key={selectedId}
                            ticketId={selectedId}
                            canManage={canManage}
                            currentUser={user}
                            onChanged={loadTickets}
                            onDeleted={() => setSelectedId(null)}
                            // Related tickets open in place of this one.
                            onOpenTicket={setSelectedId}
                        />
                    )}
                </DialogContent>
            </Dialog>

            <NewTicketDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={onCreated} />
        </>
    );
}

// External (shared queue) vs Internal (only the picked people) — shown
// as two cards, like the category / priority choices.
const VISIBILITY_CHOICES = [
    {
        value: 'EXTERNAL',
        label: 'External',
        hint: 'Visible to everyone, like a normal ticket',
        Icon: Globe,
        card: 'border-primary/50 bg-primary/10 text-foreground ring-1 ring-primary/30',
    },
    {
        value: 'INTERNAL',
        label: 'Internal',
        hint: 'Only the people you pick can see it',
        Icon: Lock,
        card: 'border-amber-400 bg-amber-500/10 text-amber-900 ring-1 ring-amber-400/40 dark:text-amber-100',
    },
];

// Agent "New ticket": the same form look as the portal's "Raise new
// ticket", with the agent fields (project, visibility, who can see it).
function NewTicketDialog({ open, onOpenChange, onCreated }) {
    const [projects, setProjects] = useState([]);
    const [subject, setSubject] = useState('');
    const [projectId, setProjectId] = useState('');
    const [type, setType] = useState('REQUEST');
    const [priority, setPriority] = useState('NORMAL');
    const [descHtml, setDescHtml] = useState('');
    const [descEmpty, setDescEmpty] = useState(true);
    const [pendingFiles, setPendingFiles] = useState([]);
    const [internal, setInternal] = useState(false);
    const [people, setPeople] = useState([]); // selected participant ids
    const [peopleQuery, setPeopleQuery] = useState('');
    const [users, setUsers] = useState([]);
    const [saving, setSaving] = useState(false);
    const [tried, setTried] = useState(false);
    const fileInputRef = useRef(null);

    useEffect(() => {
        if (!open) return;
        setSubject('');
        setProjectId('');
        setType('REQUEST');
        setPriority('NORMAL');
        setDescHtml('');
        setDescEmpty(true);
        setPendingFiles([]);
        setInternal(false);
        setPeople([]);
        setPeopleQuery('');
        setTried(false);
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
        setTried(true);
        if (!subject.trim()) return toast.error('Enter a title.');
        if (!projectId) return toast.error('Pick a project.');
        if (descEmpty) return toast.error('Add a description.');
        if (internal && people.length === 0)
            return toast.error('Pick who can see this internal ticket.');
        try {
            setSaving(true);
            const { data } = await api.post('/tickets', {
                subject: subject.trim(),
                projectId,
                type,
                priority,
                description: sanitizeHtml(descHtml),
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

    const q = peopleQuery.trim().toLowerCase();
    const peopleOptions = q
        ? users.filter((u) => (u.name || u.email || '').toLowerCase().includes(q))
        : users;

    return (
        <RaiseShell
            open={open}
            onOpenChange={onOpenChange}
            title="New ticket"
            subtitle="Open a ticket for a client or for internal work. Every ticket belongs to a project — pick one below."
            // No ticket type here, so just the built-in tips.
            aside={<RaiseHelpCards help={null} showOncall={false} />}
            footer={
                <>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={saving}
                    >
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={saving} className="gap-1.5">
                        {saving ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Send className="h-4 w-4" />
                        )}
                        Open ticket
                    </Button>
                </>
            }
        >
            <div className="space-y-1.5">
                <FormLabel required htmlFor="new-ticket-title">
                    Title
                </FormLabel>
                <IconInput
                    id="new-ticket-title"
                    icon={FileText}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Short summary of the issue…"
                    maxLength={200}
                    className={cn(tried && !subject.trim() && 'border-rose-400')}
                />
            </div>
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
                <div className="space-y-1.5">
                    <FormLabel required>Category</FormLabel>
                    <ChoiceCards
                        label="Category"
                        value={type}
                        onChange={setType}
                        choices={CATEGORY_CHOICES}
                    />
                </div>
                <div className="space-y-1.5">
                    <FormLabel required>Priority</FormLabel>
                    <ChoiceCards
                        label="Priority"
                        value={priority}
                        onChange={setPriority}
                        choices={PRIORITY_CHOICES}
                    />
                </div>
            </div>
            <div className="space-y-1.5">
                <FormLabel required>Description</FormLabel>
                <DescriptionField
                    onChange={({ html, isEmpty }) => {
                        setDescHtml(html);
                        setDescEmpty(isEmpty);
                    }}
                    onAttachClick={() => fileInputRef.current?.click()}
                    onPasteFiles={(imgs) =>
                        setPendingFiles((prev) => [...prev, ...imgs])
                    }
                    placeholder="What's happening? Steps, context, terminal / SN…"
                    invalid={tried && descEmpty}
                    disabled={saving}
                />
            </div>
            <div className="grid items-start gap-5 md:grid-cols-2">
                <div className="min-w-0 space-y-1.5">
                    <FormLabel required>Project</FormLabel>
                    <SearchableSelect
                        value={projectId}
                        onChange={setProjectId}
                        placeholder="Select a project"
                        searchPlaceholder="Search projects…"
                        className={cn(
                            'h-10 text-sm',
                            tried && !projectId && 'border-rose-400',
                        )}
                        options={projects.map((p) => ({
                            value: p.id,
                            label: (p.code ? `${p.code} · ` : '') + p.name,
                            icon: (
                                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                            ),
                        }))}
                    />
                </div>
                <div className="min-w-0 space-y-1.5">
                    <FormLabel>Visibility</FormLabel>
                    <ChoiceCards
                        label="Visibility"
                        value={internal ? 'INTERNAL' : 'EXTERNAL'}
                        onChange={(v) => setInternal(v === 'INTERNAL')}
                        choices={VISIBILITY_CHOICES}
                        className="grid-cols-2 sm:grid-cols-2"
                    />
                </div>
            </div>
            <div
                className={cn(
                    'grid items-start gap-5',
                    internal && 'md:grid-cols-2',
                )}
            >
                {internal && (
                    <div className="min-w-0 space-y-1.5">
                        <FormLabel required>Who can see it</FormLabel>
                        <Input
                            value={peopleQuery}
                            onChange={(e) => setPeopleQuery(e.target.value)}
                            placeholder="Search people…"
                            className="h-9"
                        />
                        <div
                            className={cn(
                                'max-h-44 space-y-0.5 overflow-y-auto rounded-md border p-1',
                                tried && people.length === 0 && 'border-rose-400',
                            )}
                        >
                            {peopleOptions.length === 0 ? (
                                <p className="px-2 py-2 text-xs text-muted-foreground">
                                    No one found.
                                </p>
                            ) : (
                                peopleOptions.map((u) => {
                                    const on = people.includes(u.id);
                                    return (
                                        <button
                                            key={u.id}
                                            type="button"
                                            onClick={() => togglePerson(u.id)}
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
                                                {on && <Check className="h-3 w-3" />}
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
                                {people.length === 1 ? 'person' : 'people'} selected.
                            </p>
                        )}
                    </div>
                )}
                <div className="min-w-0 space-y-1.5">
                    <FormLabel>Attachments</FormLabel>
                    <FileDropzone
                        files={pendingFiles}
                        onFiles={setPendingFiles}
                        disabled={saving}
                        inputRef={fileInputRef}
                    />
                </div>
            </div>
        </RaiseShell>
    );
}
