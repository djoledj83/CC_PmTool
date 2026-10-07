// Requester portal landing: pick a request type (card) to raise a
// request, and browse your own requests with simple filters. Mirrors a
// help-center: requesters never see projects or the agent queue.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { toast } from 'sonner';
import {
    Loader2,
    Search,
    List as ListIcon,
    LayoutGrid,
    Columns3,
    FileText,
    Send,
    Users,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { uploadTicketFile } from '@/components/TicketAttachments';
import { sanitizeHtml } from '@/components/RichText';
import {
    DescriptionField,
    FileDropzone,
    FormLabel,
    IconInput,
    RaiseHelpCards,
    RaiseShell,
    RemovableChip,
} from '@/components/RaiseTicketParts';
import { getTicketTypeIcon } from '@/lib/ticketTypeIcons';
import { getTicketTypeChipClasses } from '@/lib/ticketTypeColors';
import { RequesterPicker } from '@/components/RequesterPicker';
import { PortalStats } from '@/components/PortalStats';
import TicketBoardColumns from '@/components/TicketBoardColumns';
import TicketCardShared from '@/components/TicketCardShared';
import TicketCustomFields from '@/components/TicketCustomFields';
import {
    ChoiceCards,
    CATEGORY_CHOICES,
    PRIORITY_CHOICES,
} from '@/components/TicketChoiceFields';
import PortalRequest from '@/pages/PortalRequest';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

const STATUSES = ['NEW', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
// "Category" = the incident/request/question/problem classification.
// Named distinctly from admin-defined "request types" (the cards).
const CATEGORIES = ['INCIDENT', 'REQUEST', 'QUESTION', 'PROBLEM'];
const titleCase = (s) =>
    s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : s;

const STATUS_BADGE = {
    NEW: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    OPEN: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
    IN_PROGRESS: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
    PENDING: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    RESOLVED: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    CLOSED: 'bg-muted text-muted-foreground',
};

export default function Portal() {
    const { user } = useAuth();
    const [scope, setScope] = useState('all'); // all | mine | pinned
    const [section, setSection] = useState('requests'); // requests | stats
    const [unassignedOnly, setUnassignedOnly] = useState(false);
    const [types, setTypes] = useState([]);
    const [tickets, setTickets] = useState([]);
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState('OPEN_ONLY');
    const [q, setQ] = useState('');
    const [activeType, setActiveType] = useState(null);
    // Open a request in a modal (mirrors the resolver side) instead of
    // navigating to a separate page.
    const [selectedId, setSelectedId] = useState(null);
    const [view, setView] = useState(() => {
        try {
            return localStorage.getItem('portal.requestsView') || 'list';
        } catch {
            return 'list';
        }
    });
    const changeView = (v) => {
        setView(v);
        try {
            localStorage.setItem('portal.requestsView', v);
        } catch {
            /* ignore */
        }
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                setLoading(true);
                const [t, k] = await Promise.all([
                    api.get('/ticket-request-types', { params: { active: 1 } }),
                    api.get('/tickets'),
                ]);
                if (cancelled) return;
                setTypes(t.data.requestTypes || []);
                setTickets(k.data.tickets || []);
            } catch (err) {
                if (!cancelled)
                    toast.error(
                        err.response?.data?.error || 'Could not load the portal.',
                    );
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const reloadTickets = async () => {
        try {
            const { data } = await api.get('/tickets');
            setTickets(data.tickets || []);
        } catch {
            /* ignore */
        }
    };

    // Live: any ticket activity (new comment / status / assignment) bumps
    // the queue. Debounced so a burst of events triggers one reload.
    const { subscribe } = useRealtime();
    useEffect(() => {
        let timer = null;
        const off = subscribe('ticket:activity', () => {
            clearTimeout(timer);
            timer = setTimeout(reloadTickets, 400);
        });
        return () => {
            clearTimeout(timer);
            off();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [subscribe]);

    const togglePin = async (t) => {
        const next = !t.pinned;
        setTickets((prev) =>
            prev.map((x) => (x.id === t.id ? { ...x, pinned: next } : x)),
        );
        try {
            if (next) {
                await api.post('/pins', { kind: 'TICKET', refId: t.id });
            } else {
                await api.delete('/pins', {
                    params: { kind: 'TICKET', refId: t.id },
                });
            }
        } catch {
            // revert on failure
            setTickets((prev) =>
                prev.map((x) =>
                    x.id === t.id ? { ...x, pinned: t.pinned } : x,
                ),
            );
        }
    };

    const filtered = useMemo(() => {
        let rows = tickets;
        if (scope === 'mine')
            rows = rows.filter((t) => t.reporter?.id === user?.id);
        else if (scope === 'pinned') rows = rows.filter((t) => t.pinned);
        if (unassignedOnly) rows = rows.filter((t) => !t.assignee);
        if (statusFilter === 'OPEN_ONLY')
            rows = rows.filter((t) => t.status !== 'CLOSED' && t.status !== 'RESOLVED');
        else if (statusFilter !== 'ALL')
            rows = rows.filter((t) => t.status === statusFilter);
        const term = q.trim().toLowerCase();
        if (term)
            rows = rows.filter(
                (t) =>
                    t.subject.toLowerCase().includes(term) ||
                    t.code.toLowerCase().includes(term),
            );
        // Keep the server's latest-activity order; pinning only flags a
        // ticket (use the Pinned filter to see them), it doesn't reorder.
        return rows;
    }, [tickets, scope, statusFilter, q, user?.id, unassignedOnly]);

    return (
        <div className="space-y-8">
            {/* Raise a request */}
            <section>
                <h1 className="text-xl font-semibold">What do you need help with?</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    Pick a request type to get started.
                </p>
                {loading ? (
                    <p className="mt-4 flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </p>
                ) : types.length === 0 ? (
                    <p className="mt-4 rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
                        {user?.role === 'REQUESTER'
                            ? 'There are no request types you can raise yet. Your administrator needs to enable them for your account or organisation.'
                            : 'No request types are available yet. An administrator needs to create some.'}
                    </p>
                ) : (
                    <div className="mt-4 grid items-stretch gap-3 sm:grid-cols-2">
                        {types.map((rt) => {
                            const Icon = getTicketTypeIcon(rt.icon);
                            return (
                                <button
                                    key={rt.id}
                                    type="button"
                                    onClick={() => setActiveType(rt)}
                                    className="flex h-full min-h-[7.5rem] items-start gap-3 rounded-lg border bg-background p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
                                >
                                    <span
                                        className={cn(
                                            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
                                            getTicketTypeChipClasses(rt.color),
                                        )}
                                    >
                                        <Icon className="h-5 w-5" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block font-medium">
                                            {rt.name}
                                        </span>
                                        <span className="mt-0.5 line-clamp-4 block whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                                            {rt.description ||
                                                'Raise a request of this type.'}
                                        </span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </section>

            {/* Requests (shared queue) */}
            <section>
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center rounded-md border bg-card p-0.5 text-sm font-medium">
                        {[
                            { id: 'requests', label: 'Requests' },
                            { id: 'stats', label: 'Statistics' },
                        ].map((s) => (
                            <button
                                key={s.id}
                                type="button"
                                onClick={() => setSection(s.id)}
                                className={cn(
                                    'rounded px-3 py-1 transition-colors',
                                    section === s.id
                                        ? 'bg-primary text-primary-foreground'
                                        : 'text-muted-foreground hover:bg-accent',
                                )}
                            >
                                {s.label}
                            </button>
                        ))}
                    </div>
                    {section === 'requests' && (
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center rounded-md border bg-card p-0.5 text-xs">
                            {[
                                { id: 'all', label: 'All' },
                                { id: 'mine', label: 'Mine' },
                                { id: 'pinned', label: 'Pinned' },
                            ].map((s) => (
                                <button
                                    key={s.id}
                                    type="button"
                                    onClick={() => {
                                        setScope(s.id);
                                        setUnassignedOnly(false);
                                    }}
                                    className={cn(
                                        'rounded px-2.5 py-1 font-medium transition-colors',
                                        scope === s.id
                                            ? 'bg-primary text-primary-foreground'
                                            : 'text-muted-foreground hover:bg-accent',
                                    )}
                                >
                                    {s.label}
                                </button>
                            ))}
                        </div>
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
                        <Select value={statusFilter} onValueChange={setStatusFilter}>
                            <SelectTrigger className="h-8 w-[150px] text-xs">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="OPEN_ONLY">
                                    Open requests
                                </SelectItem>
                                <SelectItem value="ALL">All requests</SelectItem>
                                {STATUSES.map((s) => (
                                    <SelectItem key={s} value={s}>
                                        {titleCase(s)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={q}
                                onChange={(e) => setQ(e.target.value)}
                                placeholder="Search…"
                                className="h-8 w-[160px] pl-7 text-xs"
                            />
                        </div>
                    </div>
                    )}
                </div>

                {section === 'stats' ? (
                    <PortalStats
                        onPick={({ scope: sc, status, unassigned }) => {
                            if (sc) setScope(sc);
                            setUnassignedOnly(Boolean(unassigned));
                            if (status) setStatusFilter(status);
                            setSection('requests');
                        }}
                    />
                ) : filtered.length === 0 ? (
                    <div className="mt-3 rounded-lg border bg-background p-4 text-sm text-muted-foreground">
                        No requests to show.
                    </div>
                ) : view === 'list' ? (
                    <div className="mt-3 space-y-2">
                        {filtered.map((t) => (
                            <TicketCardShared
                                key={t.id}
                                t={t}
                                onOpen={() => setSelectedId(t.id)}
                                onTogglePin={() => togglePin(t)}
                            />
                        ))}
                    </div>
                ) : view === 'grid' ? (
                    <div className="mt-3 grid content-start items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {filtered.map((t) => (
                            <TicketCardShared
                                key={t.id}
                                t={t}
                                onOpen={() => setSelectedId(t.id)}
                                onTogglePin={() => togglePin(t)}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="mt-3 h-[65vh]">
                        <TicketBoardColumns
                            statuses={STATUSES}
                            items={filtered}
                            labelFor={titleCase}
                            badgeClassFor={(s) =>
                                STATUS_BADGE[s] || STATUS_BADGE.NEW
                            }
                            storageKey="portal.board.collapsed"
                            renderCard={(t) => (
                                <TicketCardShared
                                    key={t.id}
                                    t={t}
                                    onOpen={() => setSelectedId(t.id)}
                                    onTogglePin={() => togglePin(t)}
                                />
                            )}
                        />
                    </div>
                )}
            </section>

            <RaiseRequestDialog
                requestType={activeType}
                onOpenChange={(open) => !open && setActiveType(null)}
                onCreated={(ticket) => {
                    setActiveType(null);
                    reloadTickets();
                    if (ticket?.id) setSelectedId(ticket.id);
                }}
            />

            {/* Request detail opens in a modal (same pattern as the
                resolver workspace) instead of a separate page. */}
            <Dialog
                open={!!selectedId}
                onOpenChange={(o) => {
                    if (!o) setSelectedId(null);
                }}
            >
                {/* Same window as the agent workspace: fixed height on
                    desktop so the conversation and the details column
                    scroll on their own. */}
                <DialogContent className="flex max-h-[94vh] flex-col gap-0 overflow-hidden p-0 lg:h-[94vh]">
                    {selectedId && (
                        <PortalRequest
                            key={selectedId}
                            idProp={selectedId}
                            onClose={() => setSelectedId(null)}
                            onChanged={reloadTickets}
                        />
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}

// "Raise new ticket" for requesters: title, category / priority cards, a
// rich-text description, the request type's custom fields (terminal on its
// own row; then Client | Share with | Attachments on one line) and a help
// column (tips + admin-configured resources / on-call contact).
const uniqById = (list) => [...new Map(list.map((x) => [x.id, x])).values()];

function RaiseRequestDialog({ requestType, onOpenChange, onCreated }) {
    const { user } = useAuth();
    const [subject, setSubject] = useState('');
    const [descHtml, setDescHtml] = useState('');
    const [descEmpty, setDescEmpty] = useState(true);
    const [priority, setPriority] = useState('NORMAL');
    const [category, setCategory] = useState('REQUEST');
    const [pendingFiles, setPendingFiles] = useState([]);
    const [coUsers, setCoUsers] = useState([]);
    const [coGroups, setCoGroups] = useState([]);
    const [custom, setCustom] = useState({
        fields: [],
        clientId: '',
        terminalModelId: '',
        fieldValues: [],
    });
    const [saving, setSaving] = useState(false);
    // Highlight the empty required boxes only after a submit attempt.
    const [tried, setTried] = useState(false);
    const fileInputRef = useRef(null);

    useEffect(() => {
        if (requestType) {
            setSubject('');
            setDescHtml('');
            setDescEmpty(true);
            setPriority(requestType.defaultPriority || 'NORMAL');
            setCategory('REQUEST');
            setPendingFiles([]);
            setCoUsers([]);
            setCoGroups([]);
            setTried(false);
            setCustom({
                fields: [],
                clientId: '',
                terminalModelId: '',
                fieldValues: [],
            });
        }
    }, [requestType]);

    // Required custom fields the requester still has to fill in.
    const missingFields = () => {
        const out = [];
        for (const f of custom.fields) {
            if (!f.required) continue;
            const entry = custom.fieldValues.find((v) => v.fieldId === f.id);
            if (f.type === 'TERMINAL' && !custom.terminalModelId)
                out.push(f.label);
            else if (f.type === 'CLIENT' && !custom.clientId) out.push(f.label);
            else if (f.type === 'YESNO' && typeof entry?.value !== 'boolean')
                out.push(f.label);
            else if (f.type === 'SELECT' && !(entry?.value?.length))
                out.push(f.label);
            else if (
                f.type === 'TEXT' &&
                !String(entry?.value ?? '').trim()
            )
                out.push(f.label);
        }
        return out;
    };

    const save = async () => {
        setTried(true);
        if (!subject.trim()) return toast.error('Enter a title.');
        if (descEmpty) return toast.error('Add a description.');
        const missing = missingFields();
        if (missing.length)
            return toast.error(`Please fill in: ${missing.join(', ')}.`);
        try {
            setSaving(true);
            // Requesters don't choose a project — a resolver assigns it.
            const { data } = await api.post('/tickets', {
                subject: subject.trim(),
                description: sanitizeHtml(descHtml),
                requestTypeId: requestType.id,
                type: category,
                priority,
                participantIds: coUsers.map((u) => u.id),
                groupIds: coGroups.map((g) => g.id),
                clientId: custom.clientId || undefined,
                terminalModelId: custom.terminalModelId || undefined,
                fieldValues: custom.fieldValues,
            });
            for (const f of pendingFiles) {
                await uploadTicketFile(data.ticket.id, f);
            }
            toast.success('Request raised.');
            onCreated?.(data.ticket);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not raise request.');
        } finally {
            setSaving(false);
        }
    };

    const TypeIcon = requestType ? getTicketTypeIcon(requestType.icon) : null;

    const shareCell = (
        <div key="share" className="min-w-0 space-y-1.5">
            <FormLabel optional>Share with</FormLabel>
            <RequesterPicker
                label="Add people / group"
                triggerVariant="field"
                excludeUserIds={[user?.id, ...coUsers.map((u) => u.id)].filter(
                    Boolean,
                )}
                onConfirm={({ users = [], groups = [] }) => {
                    setCoUsers((prev) => uniqById([...prev, ...users]));
                    setCoGroups((prev) => uniqById([...prev, ...groups]));
                }}
            />
            {(coUsers.length > 0 || coGroups.length > 0) && (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {coGroups.map((g) => (
                        <RemovableChip
                            key={`g-${g.id}`}
                            icon={Users}
                            label={g.name}
                            onRemove={() =>
                                setCoGroups((prev) => prev.filter((x) => x.id !== g.id))
                            }
                        />
                    ))}
                    {coUsers.map((u) => (
                        <RemovableChip
                            key={`u-${u.id}`}
                            label={u.name || u.email}
                            onRemove={() =>
                                setCoUsers((prev) => prev.filter((x) => x.id !== u.id))
                            }
                        />
                    ))}
                </div>
            )}
        </div>
    );
    const attachCell = (
        <div key="attach" className="min-w-0 space-y-1.5">
            <FormLabel>Attachments</FormLabel>
            <FileDropzone
                files={pendingFiles}
                onFiles={setPendingFiles}
                disabled={saving}
                inputRef={fileInputRef}
            />
        </div>
    );

    return (
        <RaiseShell
            open={!!requestType}
            onOpenChange={onOpenChange}
            title="Raise new ticket"
            badge={
                requestType && (
                    <span
                        className={cn(
                            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
                            getTicketTypeChipClasses(requestType.color),
                        )}
                    >
                        {TypeIcon && <TypeIcon className="h-3.5 w-3.5" />}
                        {requestType.name}
                    </span>
                )
            }
            subtitle={
                requestType?.description ||
                'Create a new ticket to report an issue, ask a question or request something. Please provide as much detail as possible so we can help you faster.'
            }
            // The type's own help panel (tips, resources, on-call).
            aside={<RaiseHelpCards help={requestType?.help} />}
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
                        Raise request
                    </Button>
                </>
            }
        >
            <div className="space-y-1.5">
                <FormLabel required htmlFor="raise-title">
                    Title
                </FormLabel>
                <IconInput
                    id="raise-title"
                    icon={FileText}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Short title for your request…"
                    maxLength={200}
                    className={cn(tried && !subject.trim() && 'border-rose-400')}
                />
            </div>
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
                <div className="space-y-1.5">
                    <FormLabel required>Category</FormLabel>
                    <ChoiceCards
                        label="Category"
                        value={category}
                        onChange={setCategory}
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
                    placeholder="Describe the issue, with any steps or context…"
                    invalid={tried && descEmpty}
                    disabled={saving}
                />
            </div>
            {requestType && (
                <TicketCustomFields
                    key={requestType.id}
                    requestTypeId={requestType.id}
                    onChange={setCustom}
                    hideClientField={
                        user?.role === 'REQUESTER' && user?.external
                    }
                    labelClassName="text-sm font-medium"
                    trailing={[shareCell, attachCell]}
                />
            )}
        </RaiseShell>
    );
}

