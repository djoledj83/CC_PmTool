// Requester portal landing: pick a request type (card) to raise a
// request, and browse your own requests with simple filters. Mirrors a
// help-center: requesters never see projects or the agent queue.
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { toast } from 'sonner';
import {
    Loader2,
    Plus,
    Search,
    List as ListIcon,
    LayoutGrid,
    Columns3,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
    PendingFilePicker,
    uploadTicketFile,
} from '@/components/TicketAttachments';
import { getTicketTypeIcon } from '@/lib/ticketTypeIcons';
import { getTicketTypeChipClasses } from '@/lib/ticketTypeColors';
import { RequesterPicker } from '@/components/RequesterPicker';
import { PortalStats } from '@/components/PortalStats';
import TicketBoardColumns from '@/components/TicketBoardColumns';
import TicketCardShared from '@/components/TicketCardShared';
import TicketCustomFields from '@/components/TicketCustomFields';
import {
    ChoiceRow,
    CATEGORY_CHOICES,
    PRIORITY_CHOICES,
} from '@/components/TicketChoiceFields';
import PortalRequest from '@/pages/PortalRequest';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
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
                        No request types are available yet. An administrator
                        needs to create some.
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
                <DialogContent className="w-[90vw] max-w-[90vw] gap-0 overflow-hidden p-0 sm:w-[90vw] sm:max-w-[90vw]">
                    {selectedId && (
                        <div className="overflow-hidden">
                            <PortalRequest
                                key={selectedId}
                                idProp={selectedId}
                                onClose={() => setSelectedId(null)}
                                onChanged={reloadTickets}
                            />
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}

function RaiseRequestDialog({ requestType, onOpenChange, onCreated }) {
    const { user } = useAuth();
    const [subject, setSubject] = useState('');
    const [description, setDescription] = useState('');
    const [priority, setPriority] = useState('NORMAL');
    const [category, setCategory] = useState('REQUEST');
    const [pendingFiles, setPendingFiles] = useState([]);
    const [coUserIds, setCoUserIds] = useState([]);
    const [coGroupIds, setCoGroupIds] = useState([]);
    const [custom, setCustom] = useState({
        fields: [],
        clientId: '',
        terminalModelId: '',
        fieldValues: [],
    });
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (requestType) {
            setSubject('');
            setDescription('');
            setPriority(requestType.defaultPriority || 'NORMAL');
            setCategory('REQUEST');
            setPendingFiles([]);
            setCoUserIds([]);
            setCoGroupIds([]);
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
        if (!subject.trim()) return toast.error('Enter a subject.');
        const missing = missingFields();
        if (missing.length)
            return toast.error(`Please fill in: ${missing.join(', ')}.`);
        try {
            setSaving(true);
            // Requesters don't choose a project — a resolver assigns it.
            const { data } = await api.post('/tickets', {
                subject: subject.trim(),
                description: description.trim() || undefined,
                requestTypeId: requestType.id,
                type: category,
                priority,
                participantIds: coUserIds,
                groupIds: coGroupIds,
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

    return (
        <Dialog open={!!requestType} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[90vh] flex-col">
                <DialogHeader className="shrink-0">
                    <DialogTitle>{requestType?.name || 'New request'}</DialogTitle>
                    <DialogDescription>
                        {requestType?.description ||
                            'Tell us what you need and we’ll get back to you.'}
                    </DialogDescription>
                </DialogHeader>
                <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-1 sm:grid-cols-2">
                    <div className="space-y-1.5 sm:col-span-2">
                        <Label className="text-xs">Ticket title</Label>
                        <Input
                            value={subject}
                            onChange={(e) => setSubject(e.target.value)}
                            placeholder="Short title for your request"
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:col-span-2">
                        <div className="space-y-1.5">
                            <Label className="text-xs">Category</Label>
                            <ChoiceRow
                                value={category}
                                onChange={setCategory}
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
                    <div className="space-y-1.5 sm:col-span-2">
                        <Label className="text-xs">Description</Label>
                        <Textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Describe the issue, with any steps or context…"
                            rows={6}
                        />
                    </div>
                    {requestType && (
                        <div className="sm:col-span-2">
                            <TicketCustomFields
                                key={requestType.id}
                                requestTypeId={requestType.id}
                                onChange={setCustom}
                                hideClientField={
                                    user?.role === 'REQUESTER' && user?.external
                                }
                            />
                        </div>
                    )}
                    <div className="space-y-1.5">
                        <Label className="text-xs">Attachments</Label>
                        <PendingFilePicker
                            files={pendingFiles}
                            onFiles={setPendingFiles}
                            disabled={saving}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Share with (optional)</Label>
                        <div className="flex items-center gap-2">
                            <RequesterPicker
                                label="Add people / group"
                                onConfirm={({ userIds, groupIds }) => {
                                    setCoUserIds((prev) =>
                                        Array.from(
                                            new Set([...prev, ...userIds]),
                                        ),
                                    );
                                    setCoGroupIds((prev) =>
                                        Array.from(
                                            new Set([...prev, ...groupIds]),
                                        ),
                                    );
                                }}
                            />
                            {(coUserIds.length > 0 ||
                                coGroupIds.length > 0) && (
                                <span className="text-[11px] text-muted-foreground">
                                    {coUserIds.length} people
                                    {coGroupIds.length > 0
                                        ? `, ${coGroupIds.length} group(s)`
                                        : ''}{' '}
                                    will be added
                                    <button
                                        type="button"
                                        className="ml-2 underline-offset-2 hover:underline"
                                        onClick={() => {
                                            setCoUserIds([]);
                                            setCoGroupIds([]);
                                        }}
                                    >
                                        clear
                                    </button>
                                </span>
                            )}
                        </div>
                    </div>
                </div>
                <DialogFooter className="shrink-0">
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
                        <Plus className="mr-1 h-4 w-4" /> Raise request
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
