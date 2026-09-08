import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
    ArrowLeft,
    BarChart3,
    CalendarClock,
    CalendarRange,
    CheckCircle2,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Eye,
    EyeOff,
    FolderKanban,
    ListTodo,
    Loader2,
    MessageSquarePlus,
    Pencil,
    Play,
    Plus,
    RotateCcw,
    Search,
    Settings2,
    Trash2,
    Undo2,
    Users2,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import {
    CAPABILITIES as CAPABILITIES_FRONT,
    hasCapability,
} from '@/lib/capabilities';
import { TASK_PRIORITIES, TASK_STATUSES } from '@/lib/constants';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuth } from '@/contexts/AuthContext';
import { TopBar } from '@/components/TopBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
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
import { teamColorClass } from '@/pages/Teams';
import { MultiFilter } from '@/components/MultiFilter';
import TaskQuickViewDialog from '@/components/TaskQuickViewDialog';
import { PinButton } from '@/components/PinButton';
import { Tip } from '@/components/Tip';
import { usePins } from '@/hooks/usePins';
import {
    UNASSIGNED_USER,
    buildUserTeamsMap,
    matchesTaskFilters,
} from '@/lib/taskTeamFilter';

// Radix Select reserves "" for its internal empty sentinel, so we use an
// explicit token for "org-wide / no team" and translate at the boundary.
const NO_TEAM = '__none__';
const ORG_WIDE = '__org__';

const STATUS_META = {
    ACTIVE: { label: 'Active', tone: 'text-emerald-600 dark:text-emerald-400' },
    PLANNED: { label: 'Planned', tone: 'text-sky-600 dark:text-sky-400' },
    CLOSED: { label: 'Closed', tone: 'text-muted-foreground' },
};

const STATUS_ORDER = ['ACTIVE', 'PLANNED', 'CLOSED'];

const CADENCES = [
    { value: 'DAILY', label: 'Daily' },
    { value: 'WEEKLY', label: 'Weekly' },
    { value: 'BIWEEKLY', label: 'Every 2 weeks' },
    { value: 'MONTHLY', label: 'Monthly' },
];

const PRIORITY_META = {
    HIGH: { label: 'High', cls: 'text-rose-600 dark:text-rose-400' },
    MEDIUM: { label: 'Medium', cls: 'text-amber-600 dark:text-amber-400' },
    LOW: { label: 'Low', cls: 'text-muted-foreground' },
};

const TASK_STATUS_LABEL = {
    TODO: 'To do',
    IN_PROGRESS: 'In progress',
    DONE: 'Done',
};

function fmtDate(value) {
    if (!value) return '—';
    try {
        return new Date(value).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    } catch {
        return '—';
    }
}

function toDateInput(value) {
    if (!value) return '';
    try {
        return new Date(value).toISOString().slice(0, 10);
    } catch {
        return '';
    }
}

export default function PlanningSprints() {
    const { user } = useAuth();
    const canManage = user?.role === 'ADMIN' || user?.role === 'MANAGER';

    const [sprints, setSprints] = useState([]);
    const [teams, setTeams] = useState([]);
    const [loading, setLoading] = useState(true);
    const [statusFilter, setStatusFilter] = useState('');
    const [teamFilter, setTeamFilter] = useState('');
    const [creating, setCreating] = useState(false);
    const [editing, setEditing] = useState(null);
    const [selectedId, setSelectedId] = useState(null);
    const [scheduleOpen, setScheduleOpen] = useState(false);
    const [scheduleTeamKey, setScheduleTeamKey] = useState(ORG_WIDE);
    const [schedules, setSchedules] = useState([]);

    const loadSprints = useCallback(async () => {
        try {
            setLoading(true);
            const params = {};
            if (statusFilter) params.status = statusFilter;
            if (teamFilter) params.teamId = teamFilter;
            const res = await api.get('/planning-sprints', { params });
            setSprints(res.data.planningSprints || []);
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not load planning sprints.',
            );
        } finally {
            setLoading(false);
        }
    }, [statusFilter, teamFilter]);

    useEffect(() => {
        loadSprints();
    }, [loadSprints]);

    // Stable callback so the detail view's `load` effect doesn't re-fire
    // (and refetch the whole sprint) every time this list re-renders.
    const handleBackFromDetail = useCallback(() => {
        setSelectedId(null);
        loadSprints();
    }, [loadSprints]);

    useEffect(() => {
        api.get('/teams')
            .then((res) => setTeams(res.data.teams || []))
            .catch(() => setTeams([]));
    }, []);

    const loadSchedules = useCallback(async () => {
        if (!canManage) {
            setSchedules([]);
            return;
        }
        try {
            const scopes = [
                { teamId: null, label: 'Org-wide' },
                ...teams.map((t) => ({ teamId: t.id, label: t.name })),
            ];
            const rows = await Promise.all(
                scopes.map(async ({ teamId, label }) => {
                    const res = await api.get('/planning-sprints/schedule', {
                        params: teamId ? { teamId } : {},
                    });
                    if (!res.data.schedule) return null;
                    return {
                        teamId,
                        label,
                        schedule: res.data.schedule,
                        preview: res.data.preview || [],
                    };
                }),
            );
            setSchedules(rows.filter(Boolean));
        } catch {
            setSchedules([]);
        }
    }, [canManage, teams]);

    useEffect(() => {
        loadSchedules();
    }, [loadSchedules]);

    const grouped = useMemo(() => {
        const out = { ACTIVE: [], PLANNED: [], CLOSED: [] };
        for (const s of sprints) {
            (out[s.status] || (out[s.status] = [])).push(s);
        }
        return out;
    }, [sprints]);

    if (selectedId) {
        return (
            <PlanningSprintDetail
                id={selectedId}
                teams={teams}
                canManage={canManage}
                onBack={handleBackFromDetail}
            />
        );
    }

    return (
        <>
            <TopBar title="Planning sprints" />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="w-full space-y-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="max-w-2xl text-sm text-muted-foreground">
                            Plan a window of work across every project. Pull
                            tasks from any project into a team-scoped sprint,
                            then start, close, or roll incomplete work into the
                            next one.
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                            <Select
                                value={statusFilter || 'all'}
                                onValueChange={(v) =>
                                    setStatusFilter(v === 'all' ? '' : v)
                                }
                            >
                                <SelectTrigger className="w-[140px]">
                                    <SelectValue placeholder="All statuses" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">
                                        All statuses
                                    </SelectItem>
                                    <SelectItem value="ACTIVE">Active</SelectItem>
                                    <SelectItem value="PLANNED">
                                        Planned
                                    </SelectItem>
                                    <SelectItem value="CLOSED">Closed</SelectItem>
                                </SelectContent>
                            </Select>
                            <Select
                                value={teamFilter || 'all'}
                                onValueChange={(v) =>
                                    setTeamFilter(v === 'all' ? '' : v)
                                }
                            >
                                <SelectTrigger className="w-[160px]">
                                    <SelectValue placeholder="All teams" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All teams</SelectItem>
                                    {teams.map((t) => (
                                        <SelectItem key={t.id} value={t.id}>
                                            {t.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {canManage && (
                                <Button
                                    variant="outline"
                                    onClick={() => {
                                        setScheduleTeamKey(ORG_WIDE);
                                        setScheduleOpen(true);
                                    }}
                                >
                                    <CalendarClock className="mr-1.5 h-4 w-4" />
                                    Scheduler
                                </Button>
                            )}
                            {canManage && (
                                <Button onClick={() => setCreating(true)}>
                                    <Plus className="mr-1.5 h-4 w-4" /> New sprint
                                </Button>
                            )}
                        </div>
                    </div>

                    {loading ? (
                        <Card>
                            <CardContent className="p-6 text-sm text-muted-foreground">
                                Loading planning sprints...
                            </CardContent>
                        </Card>
                    ) : (
                        <div className="space-y-4">
                            {canManage && schedules.length > 0 && (
                                <div className="space-y-2">
                                    {schedules.map((row) => (
                                        <PlanningScheduleBanner
                                            key={row.teamId || ORG_WIDE}
                                            row={row}
                                            plannedCount={sprints.filter(
                                                (s) =>
                                                    s.status === 'PLANNED' &&
                                                    (row.teamId
                                                        ? s.teamId ===
                                                          row.teamId
                                                        : !s.teamId),
                                            ).length}
                                            onEdit={() => {
                                                setScheduleTeamKey(
                                                    row.teamId || ORG_WIDE,
                                                );
                                                setScheduleOpen(true);
                                            }}
                                            onChanged={() => {
                                                loadSprints();
                                                loadSchedules();
                                            }}
                                        />
                                    ))}
                                </div>
                            )}
                            <div className="grid items-start gap-4 lg:grid-cols-3">
                                {STATUS_ORDER.map((status) => (
                                    <PlanningColumn
                                        key={status}
                                        status={status}
                                        sprints={grouped[status] || []}
                                        onOpen={setSelectedId}
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </main>

            <PlanningSprintFormDialog
                open={creating}
                onOpenChange={setCreating}
                teams={teams}
                onSaved={() => {
                    setCreating(false);
                    loadSprints();
                }}
            />
            <PlanningSprintFormDialog
                sprint={editing}
                open={Boolean(editing)}
                onOpenChange={(open) => !open && setEditing(null)}
                teams={teams}
                onSaved={() => {
                    setEditing(null);
                    loadSprints();
                }}
            />
            <ScheduleDialog
                open={scheduleOpen}
                onOpenChange={setScheduleOpen}
                initialTeamKey={scheduleTeamKey}
                teams={teams}
                onChanged={() => {
                    loadSprints();
                    loadSchedules();
                }}
            />
        </>
    );
}

// One status column on the board (Active / Planned / Closed), mirroring
// the in-project sprints layout. Always rendered so the three columns
// stay aligned even when one is empty.
function PlanningColumn({ status, sprints, onOpen }) {
    const meta = STATUS_META[status] || STATUS_META.PLANNED;
    return (
        <section className="min-w-0 space-y-2 rounded-xl border bg-muted/20 p-3">
            <div className="flex items-center justify-between">
                <h2
                    className={cn(
                        'text-xs font-semibold uppercase tracking-wide',
                        meta.tone,
                    )}
                >
                    {meta.label}
                </h2>
                <span className="rounded-full bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {sprints.length}
                </span>
            </div>
            {sprints.length === 0 ? (
                <p className="rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground">
                    None
                </p>
            ) : (
                <div className="flex w-full flex-col gap-2.5">
                    {sprints.map((s) => (
                        <PlanningSprintCard
                            key={s.id}
                            sprint={s}
                            onOpen={() => onOpen(s.id)}
                        />
                    ))}
                </div>
            )}
        </section>
    );
}

// Visible on the board when a recurring schedule exists — mirrors the
// project sprints ScheduleBanner so "delete series" isn't buried in
// the scheduler dialog.
function PlanningScheduleBanner({ row, plannedCount, onEdit, onChanged }) {
    const { schedule, label, teamId } = row;
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);

    const cadenceLabel =
        CADENCES.find((c) => c.value === schedule.cadence)?.label ||
        schedule.cadence;
    const next = row.preview?.[0];

    const deleteSchedule = async () => {
        try {
            setDeleting(true);
            await api.delete('/planning-sprints/schedule', {
                params: {
                    ...(teamId ? { teamId } : {}),
                    withPlanned: 'true',
                },
            });
            toast.success('Schedule and planned sprints removed.');
            setConfirmDelete(false);
            onChanged?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not remove schedule.',
            );
        } finally {
            setDeleting(false);
        }
    };

    return (
        <div
            className={cn(
                'flex flex-col gap-2 rounded-lg border px-3 py-2 text-xs',
                schedule.enabled
                    ? 'border-violet-500/30 bg-violet-500/5 text-violet-900 dark:text-violet-200'
                    : 'border-dashed bg-muted/30 text-muted-foreground',
            )}
        >
            <div className="flex flex-wrap items-center gap-2">
                <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                <span>
                    <strong>{label}</strong>
                    {schedule.enabled ? (
                        <>
                            {' '}
                            · auto-creating sprints{' '}
                            <strong>{cadenceLabel.toLowerCase()}</strong>
                            {next && (
                                <>
                                    . Next: <strong>{next.name}</strong> (
                                    {fmtDate(next.startDate)} –{' '}
                                    {fmtDate(next.endDate)})
                                </>
                            )}
                        </>
                    ) : (
                        <> · schedule paused ({cadenceLabel.toLowerCase()})</>
                    )}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={onEdit}
                    >
                        <Settings2 className="mr-1 h-3 w-3" />
                        Edit
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2 text-xs text-rose-700 hover:bg-rose-100 hover:text-rose-700 dark:text-rose-300 dark:hover:bg-rose-500/10"
                        onClick={() => setConfirmDelete((v) => !v)}
                    >
                        <Trash2 className="h-3 w-3" />
                        Delete schedule
                    </Button>
                </div>
            </div>
            {confirmDelete && (
                <div className="flex flex-wrap items-center gap-2 rounded border border-rose-400 bg-white/80 px-2 py-1.5 text-rose-800 dark:bg-rose-950/30 dark:text-rose-200">
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>
                        Delete this schedule
                        {plannedCount > 0 && (
                            <>
                                {' '}
                                and its{' '}
                                <strong>
                                    {plannedCount} planned sprint
                                    {plannedCount === 1 ? '' : 's'}
                                </strong>
                            </>
                        )}
                        ? Active and closed sprints are kept.
                    </span>
                    <div className="ml-auto flex gap-1.5">
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => setConfirmDelete(false)}
                            disabled={deleting}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 px-2 text-xs"
                            onClick={deleteSchedule}
                            disabled={deleting}
                        >
                            {deleting ? 'Deleting…' : 'Delete'}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

function PlanningSprintCard({ sprint, onOpen }) {
    const meta = STATUS_META[sprint.status] || STATUS_META.PLANNED;
    const taskCount = sprint._count?.tasks ?? sprint.tasks?.length ?? 0;
    return (
        <button
            type="button"
            onClick={onOpen}
            className="group flex h-full w-full flex-col rounded-lg border bg-card p-4 text-left shadow-sm transition hover:border-primary/40 hover:shadow"
        >
            <div className="flex items-start justify-between gap-2">
                <h3 className="line-clamp-2 font-semibold leading-tight">
                    {sprint.name}
                </h3>
                <span
                    className={cn(
                        'shrink-0 text-[11px] font-semibold uppercase',
                        meta.tone,
                    )}
                >
                    {meta.label}
                </span>
            </div>
            {sprint.goal && (
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {sprint.goal}
                </p>
            )}
            <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarRange className="h-3.5 w-3.5" />
                {fmtDate(sprint.startDate)} – {fmtDate(sprint.endDate)}
            </div>
            <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                {sprint.team ? (
                    <span
                        className={cn(
                            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                            teamColorClass(sprint.team.color),
                        )}
                    >
                        <Users2 className="h-3 w-3" />
                        {sprint.team.name}
                    </span>
                ) : (
                    <span className="text-[11px] text-muted-foreground">
                        Org-wide
                    </span>
                )}
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <ListTodo className="h-3.5 w-3.5" />
                    {taskCount}
                </span>
            </div>
        </button>
    );
}

function PlanningSprintFormDialog({
    sprint,
    open,
    onOpenChange,
    teams,
    onSaved,
}) {
    const isEdit = Boolean(sprint);
    const [name, setName] = useState('');
    const [goal, setGoal] = useState('');
    const [teamId, setTeamId] = useState(NO_TEAM);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setName(sprint?.name || '');
        setGoal(sprint?.goal || '');
        setTeamId(sprint?.teamId || NO_TEAM);
        setStartDate(toDateInput(sprint?.startDate));
        setEndDate(toDateInput(sprint?.endDate));
    }, [open, sprint]);

    const submit = async (e) => {
        e.preventDefault();
        if (!name.trim()) return toast.error('Name is required.');
        if (!startDate || !endDate) return toast.error('Pick start and end dates.');
        if (new Date(endDate) <= new Date(startDate)) {
            return toast.error('End date must be after start date.');
        }
        const payload = {
            name: name.trim(),
            goal: goal.trim() || null,
            teamId: teamId === NO_TEAM ? null : teamId,
            startDate: new Date(startDate).toISOString(),
            endDate: new Date(endDate).toISOString(),
        };
        try {
            setSaving(true);
            if (isEdit) {
                await api.patch(`/planning-sprints/${sprint.id}`, payload);
                toast.success('Planning sprint updated.');
            } else {
                await api.post('/planning-sprints', payload);
                toast.success('Planning sprint created.');
            }
            onSaved?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not save planning sprint.',
            );
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[480px]">
                <DialogHeader>
                    <DialogTitle>
                        {isEdit ? 'Edit planning sprint' : 'New planning sprint'}
                    </DialogTitle>
                    <DialogDescription>
                        A planning sprint groups tasks from across projects for a
                        team (or the whole org).
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="space-y-4">
                    <div className="space-y-1.5">
                        <Label htmlFor="ps-name">Name</Label>
                        <Input
                            id="ps-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Week 22 cross-team push"
                            autoFocus
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="ps-goal">Goal (optional)</Label>
                        <Textarea
                            id="ps-goal"
                            value={goal}
                            onChange={(e) => setGoal(e.target.value)}
                            placeholder="What should this sprint achieve?"
                            rows={2}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Team</Label>
                        <Select value={teamId} onValueChange={setTeamId}>
                            <SelectTrigger>
                                <SelectValue placeholder="Org-wide" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={NO_TEAM}>
                                    Org-wide (no team)
                                </SelectItem>
                                {teams.map((t) => (
                                    <SelectItem key={t.id} value={t.id}>
                                        {t.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="ps-start">Start</Label>
                            <Input
                                id="ps-start"
                                type="date"
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="ps-end">End</Label>
                            <Input
                                id="ps-end"
                                type="date"
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {saving
                                ? 'Saving...'
                                : isEdit
                                  ? 'Save changes'
                                  : 'Create sprint'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function PlanningSprintDetail({ id, teams, canManage, onBack }) {
    const [sprint, setSprint] = useState(null);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(false);
    const [addOpen, setAddOpen] = useState(false);
    const [closeOpen, setCloseOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [view, setView] = useState('tasks');
    const [filterUserIds, setFilterUserIds] = useState([]);
    const [filterTeamIds, setFilterTeamIds] = useState([]);
    const [filterProjectIds, setFilterProjectIds] = useState([]);
    // Cross-project backlog (tasks not in this sprint) shown next to
    // the sprint column — mirrors the project sprint board.
    const [backlog, setBacklog] = useState([]);
    const [backlogLoading, setBacklogLoading] = useState(false);
    const [backlogQ, setBacklogQ] = useState('');
    // Bulk show/hide for the per-task notes sections. `tick` forces the
    // effect in every row to re-fire even when the mode repeats (e.g.
    // user manually closed one row, then hits "Show notes" again).
    const [allNotesShown, setAllNotesShown] = useState(false);
    const [notesBulk, setNotesBulk] = useState(null);
    const toggleAllNotes = () => {
        const next = !allNotesShown;
        setAllNotesShown(next);
        setNotesBulk({ mode: next ? 'show' : 'hide', tick: Date.now() });
    };
    // Master collapse/expand for every project group in every column.
    // Broadcast via a window event so we don't have to thread a prop
    // through all the column layers (each PlanningProjectGroups listens).
    const [allProjectsCollapsed, setAllProjectsCollapsed] = useState(false);
    const toggleAllProjects = () => {
        const next = !allProjectsCollapsed;
        setAllProjectsCollapsed(next);
        window.dispatchEvent(
            new CustomEvent('planning:projects-bulk', {
                detail: { collapse: next },
            }),
        );
    };
    // "Today's focus" highlighter — same user-scoped pin store the
    // project sprint board uses, so a task focused there glows here
    // too (and vice versa).
    const focusPinHook = usePins('TASK_FOCUS');
    const [capacityOpen, setCapacityOpen] = useState(false);

    // Keep `onBack` out of `load`'s dependency list. `onBack` can change
    // identity on a parent re-render; if `load` depended on it, the
    // effect below would refetch the whole sprint on every such render —
    // wiping notes panels and half-typed input. Read it through a ref.
    const onBackRef = useRef(onBack);
    onBackRef.current = onBack;

    const load = useCallback(async () => {
        try {
            setLoading(true);
            const res = await api.get(`/planning-sprints/${id}`);
            setSprint(res.data.planningSprint);
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not load planning sprint.',
            );
            onBackRef.current?.();
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        load();
    }, [load]);

    const lifecycle = async (action) => {
        try {
            setBusy(true);
            const res = await api.post(`/planning-sprints/${id}/${action}`);
            setSprint(res.data.planningSprint);
            toast.success(`Sprint ${action === 'start' ? 'started' : action === 'reopen' ? 'reopened' : 'updated'}.`);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Action failed.');
        } finally {
            setBusy(false);
        }
    };

    const loadBacklog = useCallback(async () => {
        if (!canManage) return;
        try {
            setBacklogLoading(true);
            const params = { excludeSprintId: id, take: 500 };
            if (backlogQ.trim()) params.q = backlogQ.trim();
            const res = await api.get('/planning-sprints/backlog/tasks', {
                params,
            });
            setBacklog(res.data.tasks || []);
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not load backlog.',
            );
        } finally {
            setBacklogLoading(false);
        }
    }, [id, backlogQ, canManage]);

    const sprintStatus = sprint?.status;
    useEffect(() => {
        // Closed sprints are immutable — no point fetching a backlog
        // the user can't drag from.
        if (!sprintStatus || sprintStatus === 'CLOSED') return undefined;
        const t = setTimeout(loadBacklog, 250);
        return () => clearTimeout(t);
    }, [sprintStatus, loadBacklog]);

    const addTask = async (taskId) => {
        try {
            const res = await api.post(`/planning-sprints/${id}/tasks`, {
                taskIds: [taskId],
            });
            setSprint(res.data.planningSprint);
            loadBacklog();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add task.');
        }
    };

    const removeTask = async (taskId) => {
        try {
            const res = await api.delete(
                `/planning-sprints/${id}/tasks/${taskId}`,
            );
            setSprint(res.data.planningSprint);
            loadBacklog();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not remove task.');
        }
    };

    const saveCapacity = async (entries) => {
        try {
            const res = await api.put(`/planning-sprints/${id}/capacity`, {
                entries,
            });
            setSprint(res.data.planningSprint);
            setCapacityOpen(false);
            toast.success('Capacity saved.');
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not save capacity.',
            );
        }
    };

    // Candidate users for the capacity dialog: the sprint's team when
    // set, otherwise every team member we know about — plus anyone
    // already assigned to a sprint task or carrying a capacity row.
    const capacityUsers = useMemo(() => {
        const map = new Map();
        if (sprint?.team?.id) {
            const team = teams.find((t) => t.id === sprint.team.id);
            for (const m of team?.members || []) map.set(m.id, m);
        } else {
            for (const t of teams) {
                for (const m of t.members || []) map.set(m.id, m);
            }
        }
        for (const t of sprint?.tasks || []) {
            if (t.assignee) map.set(t.assignee.id, t.assignee);
        }
        for (const c of sprint?.capacity || []) {
            if (c.user) map.set(c.user.id, c.user);
        }
        return [...map.values()].sort((a, b) =>
            (a.name || '').localeCompare(b.name || ''),
        );
    }, [sprint?.team?.id, sprint?.tasks, sprint?.capacity, teams]);

    const deleteSprint = async () => {
        if (!window.confirm('Delete this planning sprint? Tasks are not deleted.'))
            return;
        try {
            setBusy(true);
            await api.delete(`/planning-sprints/${id}`);
            toast.success('Planning sprint deleted.');
            onBack?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete.');
            setBusy(false);
        }
    };

    const meta = sprint ? STATUS_META[sprint.status] : null;
    const counters = sprint?.counters || {
        totalTasks: 0,
        completedTasks: 0,
        totalHours: 0,
    };

    const userTeamsMap = useMemo(
        () => buildUserTeamsMap(teams),
        [teams],
    );

    const filterOptions = useMemo(() => {
        // Options span the sprint AND the backlog so the same filter
        // row narrows both columns at once.
        const tasks = [...(sprint?.tasks || []), ...backlog];
        const userMap = new Map();
        const projectMap = new Map();
        let hasUnassigned = false;
        for (const t of tasks) {
            if (t.assignee) userMap.set(t.assignee.id, t.assignee.name);
            else hasUnassigned = true;
            if (t.project) projectMap.set(t.project.id, t.project.name);
        }
        const userOptions = [
            ...(hasUnassigned
                ? [{ value: UNASSIGNED_USER, label: 'Unassigned' }]
                : []),
            ...[...userMap.entries()]
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([value, label]) => ({ value, label })),
        ];
        const projectOptions = [...projectMap.entries()]
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([value, label]) => ({ value, label }));
        const teamOptions = teams.map((t) => ({ value: t.id, label: t.name }));
        return { userOptions, teamOptions, projectOptions };
    }, [sprint?.tasks, backlog, teams]);

    const filteredTasks = useMemo(() => {
        const tasks = sprint?.tasks || [];
        if (
            !filterUserIds.length &&
            !filterTeamIds.length &&
            !filterProjectIds.length
        ) {
            return tasks;
        }
        return tasks.filter((t) =>
            matchesTaskFilters(t, {
                userIds: filterUserIds,
                teamIds: filterTeamIds,
                projectIds: filterProjectIds,
                userTeamsMap,
            }),
        );
    }, [
        sprint?.tasks,
        filterUserIds,
        filterTeamIds,
        filterProjectIds,
        userTeamsMap,
    ]);

    const filteredBacklog = useMemo(() => {
        if (
            !filterUserIds.length &&
            !filterTeamIds.length &&
            !filterProjectIds.length
        ) {
            return backlog;
        }
        return backlog.filter((t) =>
            matchesTaskFilters(t, {
                userIds: filterUserIds,
                teamIds: filterTeamIds,
                projectIds: filterProjectIds,
                userTeamsMap,
            }),
        );
    }, [
        backlog,
        filterUserIds,
        filterTeamIds,
        filterProjectIds,
        userTeamsMap,
    ]);

    const activeFilterCount =
        filterUserIds.length +
        filterTeamIds.length +
        filterProjectIds.length;

    return (
        <>
            <TopBar title="Planning sprint" />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="w-full space-y-4">
                    <Button variant="ghost" size="sm" onClick={onBack}>
                        <ArrowLeft className="mr-1.5 h-4 w-4" /> All planning
                        sprints
                    </Button>

                    {loading || !sprint ? (
                        <Card>
                            <CardContent className="p-6 text-sm text-muted-foreground">
                                Loading...
                            </CardContent>
                        </Card>
                    ) : (
                        <>
                            <Card>
                                <CardContent className="space-y-3 p-4 sm:p-5">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="space-y-1">
                                            <div className="flex items-center gap-2">
                                                <h1 className="text-lg font-semibold">
                                                    {sprint.name}
                                                </h1>
                                                <span
                                                    className={cn(
                                                        'text-[11px] font-semibold uppercase',
                                                        meta.tone,
                                                    )}
                                                >
                                                    {meta.label}
                                                </span>
                                            </div>
                                            {sprint.goal && (
                                                <p className="text-sm text-muted-foreground">
                                                    {sprint.goal}
                                                </p>
                                            )}
                                            <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
                                                <span className="inline-flex items-center gap-1">
                                                    <CalendarRange className="h-3.5 w-3.5" />
                                                    {fmtDate(sprint.startDate)} –{' '}
                                                    {fmtDate(sprint.endDate)}
                                                </span>
                                                {sprint.team ? (
                                                    <span
                                                        className={cn(
                                                            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium',
                                                            teamColorClass(
                                                                sprint.team
                                                                    .color,
                                                            ),
                                                        )}
                                                    >
                                                        <Users2 className="h-3 w-3" />
                                                        {sprint.team.name}
                                                    </span>
                                                ) : (
                                                    <span>Org-wide</span>
                                                )}
                                            </div>
                                        </div>
                                        {canManage && (
                                            <div className="flex flex-wrap items-center gap-2">
                                                {sprint.status === 'PLANNED' && (
                                                    <Button
                                                        size="sm"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            lifecycle('start')
                                                        }
                                                    >
                                                        <Play className="mr-1.5 h-4 w-4" />
                                                        Start
                                                    </Button>
                                                )}
                                                {sprint.status === 'ACTIVE' && (
                                                    <Button
                                                        size="sm"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            setCloseOpen(true)
                                                        }
                                                    >
                                                        <CheckCircle2 className="mr-1.5 h-4 w-4" />
                                                        Close
                                                    </Button>
                                                )}
                                                {sprint.status === 'CLOSED' && (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            lifecycle('reopen')
                                                        }
                                                    >
                                                        <RotateCcw className="mr-1.5 h-4 w-4" />
                                                        Reopen
                                                    </Button>
                                                )}
                                                {sprint.status !==
                                                    'CLOSED' && (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() =>
                                                            setCapacityOpen(
                                                                true,
                                                            )
                                                        }
                                                    >
                                                        <Settings2 className="mr-1.5 h-4 w-4" />
                                                        Capacity
                                                    </Button>
                                                )}
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() =>
                                                        setEditing(true)
                                                    }
                                                >
                                                    <Pencil className="mr-1.5 h-4 w-4" />
                                                    Edit
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    className="text-destructive hover:text-destructive"
                                                    disabled={busy}
                                                    onClick={deleteSprint}
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex flex-wrap gap-4 border-t pt-3 text-sm">
                                        <Stat
                                            label="Tasks"
                                            value={counters.totalTasks}
                                        />
                                        <Stat
                                            label="Done"
                                            value={`${counters.completedTasks}/${counters.totalTasks}`}
                                        />
                                        <Stat
                                            label="Est. hours"
                                            value={fmtHours(
                                                counters.totalHours || 0,
                                            )}
                                        />
                                        <Stat
                                            label="Logged"
                                            value={fmtHours(
                                                counters.loggedHours || 0,
                                            )}
                                        />
                                        <Stat
                                            label="Completion"
                                            value={`${
                                                counters.totalTasks
                                                    ? Math.round(
                                                          (counters.completedTasks /
                                                              counters.totalTasks) *
                                                              100,
                                                      )
                                                    : 0
                                            }%`}
                                        />
                                    </div>

                                    <PlanningCapacityHeatmap
                                        capacity={sprint.capacity || []}
                                        tasks={sprint.tasks || []}
                                        knownUsers={capacityUsers}
                                    />
                                </CardContent>
                            </Card>

                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="inline-flex rounded-lg border bg-muted/40 p-0.5">
                                    <ViewToggle
                                        active={view === 'tasks'}
                                        icon={ListTodo}
                                        label="Tasks"
                                        onClick={() => setView('tasks')}
                                    />
                                    <ViewToggle
                                        active={view === 'analytics'}
                                        icon={BarChart3}
                                        label="Analytics"
                                        onClick={() => setView('analytics')}
                                    />
                                </div>
                                {view === 'tasks' && (
                                    <div className="flex items-center gap-2">
                                        {sprint.tasks.length > 0 && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={toggleAllNotes}
                                            >
                                                {allNotesShown ? (
                                                    <EyeOff className="mr-1.5 h-4 w-4" />
                                                ) : (
                                                    <Eye className="mr-1.5 h-4 w-4" />
                                                )}
                                                {allNotesShown
                                                    ? 'Hide notes'
                                                    : 'Show notes'}
                                            </Button>
                                        )}
                                        {sprint.tasks.length > 0 && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={toggleAllProjects}
                                                title="Collapse or expand every project group in all columns"
                                            >
                                                <FolderKanban className="mr-1.5 h-4 w-4" />
                                                {allProjectsCollapsed
                                                    ? 'Expand projects'
                                                    : 'Collapse projects'}
                                            </Button>
                                        )}
                                        {canManage &&
                                            sprint.status !== 'CLOSED' && (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() =>
                                                        setAddOpen(true)
                                                    }
                                                >
                                                    <Plus className="mr-1.5 h-4 w-4" />{' '}
                                                    Add tasks
                                                </Button>
                                            )}
                                    </div>
                                )}
                            </div>

                            {view === 'tasks' &&
                                (sprint.tasks.length > 0 ||
                                    backlog.length > 0) && (
                                <div className="flex flex-wrap items-center gap-2">
                                    <MultiFilter
                                        label="User"
                                        values={filterUserIds}
                                        onChange={setFilterUserIds}
                                        options={filterOptions.userOptions}
                                    />
                                    <MultiFilter
                                        label="Team"
                                        values={filterTeamIds}
                                        onChange={setFilterTeamIds}
                                        options={filterOptions.teamOptions}
                                    />
                                    <MultiFilter
                                        label="Project"
                                        values={filterProjectIds}
                                        onChange={setFilterProjectIds}
                                        options={filterOptions.projectOptions}
                                    />
                                    {activeFilterCount > 0 && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 gap-1 px-2 text-xs"
                                            onClick={() => {
                                                setFilterUserIds([]);
                                                setFilterTeamIds([]);
                                                setFilterProjectIds([]);
                                            }}
                                        >
                                            <X className="h-3.5 w-3.5" />
                                            Clear filters
                                        </Button>
                                    )}
                                    {activeFilterCount > 0 && (
                                        <span className="text-xs text-muted-foreground">
                                            {filteredTasks.length} of{' '}
                                            {sprint.tasks.length} tasks
                                        </span>
                                    )}
                                </div>
                            )}

                            {view === 'analytics' ? (
                                <PlanningAnalytics sprint={sprint} />
                            ) : sprint.status === 'CLOSED' ? (
                                sprint.tasks.length === 0 ? (
                                    <Card>
                                        <CardContent className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
                                            <ListTodo className="h-7 w-7 text-muted-foreground/60" />
                                            <p>
                                                This sprint was closed without
                                                any tasks.
                                            </p>
                                        </CardContent>
                                    </Card>
                                ) : (
                                    <PlanningProjectGroups
                                        tasks={filteredTasks}
                                        renderTask={(t, color) => (
                                            <PlanningTaskRow
                                                key={t.id}
                                                task={t}
                                                hideProject
                                                canManage={canManage}
                                                canRemove={false}
                                                onRemove={() => {}}
                                                onChanged={load}
                                                notesBulk={notesBulk}
                                                stripe={color.stripe}
                                                focusPinHook={focusPinHook}
                                            />
                                        )}
                                    />
                                )
                            ) : sprint.status === 'ACTIVE' ? (
                                <PlanningSprintStatusBoard
                                    tasks={filteredTasks}
                                    backlog={filteredBacklog}
                                    backlogLoading={backlogLoading}
                                    backlogQ={backlogQ}
                                    onBacklogQChange={setBacklogQ}
                                    canManage={canManage}
                                    onAdd={addTask}
                                    onRemove={removeTask}
                                    onChanged={load}
                                    notesBulk={notesBulk}
                                    focusPinHook={focusPinHook}
                                />
                            ) : (
                                <PlanningPlannedBoard
                                    sprint={sprint}
                                    tasks={filteredTasks}
                                    backlog={filteredBacklog}
                                    backlogLoading={backlogLoading}
                                    backlogQ={backlogQ}
                                    onBacklogQChange={setBacklogQ}
                                    canManage={canManage}
                                    onAdd={addTask}
                                    onRemove={removeTask}
                                    onChanged={load}
                                    notesBulk={notesBulk}
                                    focusPinHook={focusPinHook}
                                />
                            )}
                        </>
                    )}
                </div>
            </main>

            {sprint && (
                <PlanningSprintFormDialog
                    sprint={sprint}
                    open={editing}
                    onOpenChange={setEditing}
                    teams={teams}
                    onSaved={() => {
                        setEditing(false);
                        load();
                    }}
                />
            )}

            {sprint && (
                <AddTasksDialog
                    sprintId={id}
                    open={addOpen}
                    onOpenChange={setAddOpen}
                    teams={teams}
                    onAdded={(updated) => {
                        setSprint(updated);
                        setAddOpen(false);
                    }}
                />
            )}

            {sprint && (
                <CloseSprintDialog
                    sprintId={id}
                    open={closeOpen}
                    onOpenChange={setCloseOpen}
                    onClosed={(updated) => {
                        setSprint(updated);
                        setCloseOpen(false);
                    }}
                />
            )}

            {sprint && (
                <PlanningCapacityDialog
                    open={capacityOpen}
                    sprint={sprint}
                    users={capacityUsers}
                    onClose={() => setCapacityOpen(false)}
                    onSubmit={saveCapacity}
                />
            )}
        </>
    );
}

function Stat({ label, value }) {
    return (
        <div>
            <div className="text-base font-semibold">{value}</div>
            <div className="text-xs text-muted-foreground">{label}</div>
        </div>
    );
}

function ViewToggle({ active, icon: Icon, label, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
                active
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
            )}
        >
            <Icon className="h-3.5 w-3.5" />
            {label}
        </button>
    );
}

function fmtHours(h) {
    if (!h) return '0h';
    const rounded = Math.round(h * 100) / 100;
    return `${rounded}h`;
}

// Cross-project analytics for a planning sprint: completion + hours
// stats, per-assignee load, a per-project breakdown (planning sprints
// span projects, so this is the headline view), and the burndown chart.
function PlanningAnalytics({ sprint }) {
    const tasks = sprint.tasks || [];

    const byAssignee = useMemo(() => {
        const map = new Map();
        for (const t of tasks) {
            const key = t.assignee?.id || '__unassigned__';
            const cur =
                map.get(key) ||
                {
                    user: t.assignee || null,
                    total: 0,
                    done: 0,
                    hours: 0,
                    doneHours: 0,
                };
            cur.total += 1;
            cur.hours += t.estimateHours || 0;
            if (t.status === 'DONE') {
                cur.done += 1;
                cur.doneHours += t.estimateHours || 0;
            }
            map.set(key, cur);
        }
        return [...map.values()].sort((a, b) => b.hours - a.hours);
    }, [tasks]);

    const byProject = useMemo(() => {
        const map = new Map();
        for (const t of tasks) {
            const key = t.project?.id || '__none__';
            const cur =
                map.get(key) ||
                {
                    name: t.project?.name || 'No project',
                    total: 0,
                    done: 0,
                    hours: 0,
                };
            cur.total += 1;
            cur.hours += t.estimateHours || 0;
            if (t.status === 'DONE') cur.done += 1;
            map.set(key, cur);
        }
        return [...map.values()].sort((a, b) => b.total - a.total);
    }, [tasks]);

    const maxAssigneeHours = Math.max(1, ...byAssignee.map((a) => a.hours));
    const counters = sprint.counters || {
        totalTasks: 0,
        completedTasks: 0,
        totalHours: 0,
    };
    const pctDone = counters.totalTasks
        ? Math.round((counters.completedTasks / counters.totalTasks) * 100)
        : 0;

    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Card>
                    <CardContent className="p-4">
                        <Stat label="Tasks" value={counters.totalTasks} />
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="p-4">
                        <Stat
                            label="Completed"
                            value={`${counters.completedTasks}/${counters.totalTasks} · ${pctDone}%`}
                        />
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="p-4">
                        <Stat
                            label="Est. hours"
                            value={fmtHours(counters.totalHours)}
                        />
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="p-4">
                        <Stat
                            label="Projects"
                            value={byProject.length}
                        />
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
                {/* Per-assignee load */}
                <Card>
                    <CardContent className="space-y-3 p-4">
                        <h3 className="text-sm font-semibold">
                            Load by assignee
                        </h3>
                        {byAssignee.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                                No tasks to chart.
                            </p>
                        ) : (
                            <div className="space-y-2.5">
                                {byAssignee.map((row, i) => (
                                    <div key={i} className="space-y-1">
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="inline-flex items-center gap-1.5">
                                                {row.user ? (
                                                    <Avatar className="h-5 w-5">
                                                        {row.user.avatarUrl && (
                                                            <AvatarImage
                                                                src={resolveAssetUrl(
                                                                    row.user
                                                                        .avatarUrl,
                                                                )}
                                                                alt={
                                                                    row.user
                                                                        .name
                                                                }
                                                            />
                                                        )}
                                                        <AvatarFallback className="text-[9px]">
                                                            {initials(
                                                                row.user.name,
                                                            )}
                                                        </AvatarFallback>
                                                    </Avatar>
                                                ) : (
                                                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px]">
                                                        ?
                                                    </span>
                                                )}
                                                <span className="font-medium">
                                                    {row.user?.name ||
                                                        'Unassigned'}
                                                </span>
                                            </span>
                                            <span className="text-muted-foreground">
                                                {row.done}/{row.total} ·{' '}
                                                {fmtHours(row.hours)}
                                            </span>
                                        </div>
                                        <div className="h-2 overflow-hidden rounded-full bg-muted">
                                            <div
                                                className="h-full rounded-full bg-primary/70"
                                                style={{
                                                    width: `${
                                                        (row.hours /
                                                            maxAssigneeHours) *
                                                        100
                                                    }%`,
                                                }}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Per-project breakdown */}
                <Card>
                    <CardContent className="space-y-3 p-4">
                        <h3 className="text-sm font-semibold">
                            Breakdown by project
                        </h3>
                        {byProject.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                                No tasks to chart.
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {byProject.map((row, i) => (
                                    <div
                                        key={i}
                                        className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
                                    >
                                        <span className="truncate font-medium">
                                            {row.name}
                                        </span>
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            {row.done}/{row.total} done ·{' '}
                                            {fmtHours(row.hours)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            <PlanningBurndown sprintId={sprint.id} />
        </div>
    );
}

function PlanningBurndown({ sprintId }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        (async () => {
            try {
                const res = await api.get(
                    `/planning-sprints/${sprintId}/burndown`,
                );
                if (!cancelled) setData(res.data);
            } catch (err) {
                if (!cancelled) {
                    toast.error(
                        err.response?.data?.error || 'Failed to load burndown.',
                    );
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [sprintId]);

    if (loading) {
        return (
            <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">
                    Loading burndown…
                </CardContent>
            </Card>
        );
    }
    if (!data) return null;
    return <PlanningBurndownChart data={data} />;
}

function PlanningBurndownChart({ data }) {
    const width = 720;
    const height = 280;
    const pad = { l: 36, r: 16, t: 16, b: 28 };
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;

    const totalDays = data.days || 1;
    const snapshots = data.snapshots || [];
    const maxY = Math.max(
        data.totalHours || 0,
        ...snapshots.map((s) => s.remainingHours || 0),
        1,
    );

    const x = (day) => pad.l + (day / totalDays) * innerW;
    const y = (hrs) => pad.t + innerH - (hrs / maxY) * innerH;

    const startMs = new Date(data.sprint.startDate).getTime();
    const points = snapshots.map((s) => ({
        day: Math.max(
            0,
            Math.min(
                totalDays,
                (new Date(s.capturedAt).getTime() - startMs) /
                    (24 * 60 * 60 * 1000),
            ),
        ),
        hours: s.remainingHours,
        isLive: s.id === 'live',
    }));

    const idealPath = (data.ideal || [])
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.day)} ${y(p.hours)}`)
        .join(' ');
    const actualPath = points
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.day)} ${y(p.hours)}`)
        .join(' ');

    const yTicks = 4;
    const tickValues = Array.from(
        { length: yTicks + 1 },
        (_, i) => (maxY * i) / yTicks,
    );

    const hasSeries = points.length > 1;

    return (
        <Card>
            <CardContent className="p-4">
                <div className="mb-2">
                    <h3 className="text-sm font-semibold">Burndown</h3>
                    <p className="text-xs text-muted-foreground">
                        {fmtDate(data.sprint.startDate)} →{' '}
                        {fmtDate(data.sprint.endDate)} · {totalDays} day(s) ·
                        total estimate {fmtHours(data.totalHours)}
                    </p>
                </div>
                {!hasSeries ? (
                    <p className="py-8 text-center text-xs text-muted-foreground">
                        Not enough snapshots yet — the chart fills in as the
                        sprint runs (one snapshot per day).
                    </p>
                ) : (
                    <svg
                        viewBox={`0 0 ${width} ${height}`}
                        className="w-full"
                        role="img"
                        aria-label="Burndown chart"
                    >
                        {tickValues.map((v, i) => (
                            <g key={i}>
                                <line
                                    x1={pad.l}
                                    x2={pad.l + innerW}
                                    y1={y(v)}
                                    y2={y(v)}
                                    stroke="currentColor"
                                    strokeOpacity={0.08}
                                />
                                <text
                                    x={pad.l - 6}
                                    y={y(v) + 3}
                                    textAnchor="end"
                                    fontSize="10"
                                    className="fill-muted-foreground"
                                >
                                    {Math.round(v)}h
                                </text>
                            </g>
                        ))}
                        <line
                            x1={pad.l}
                            x2={pad.l + innerW}
                            y1={pad.t + innerH}
                            y2={pad.t + innerH}
                            stroke="currentColor"
                            strokeOpacity={0.18}
                        />
                        <path
                            d={idealPath}
                            stroke="currentColor"
                            strokeOpacity={0.4}
                            strokeDasharray="4 4"
                            fill="none"
                            strokeWidth="1.5"
                        />
                        <path
                            d={actualPath}
                            className="stroke-primary"
                            fill="none"
                            strokeWidth="2"
                        />
                        {points.map((p, i) => (
                            <circle
                                key={i}
                                cx={x(p.day)}
                                cy={y(p.hours)}
                                r={p.isLive ? 4 : 2.5}
                                className={cn(
                                    p.isLive
                                        ? 'fill-primary'
                                        : 'fill-primary/70',
                                )}
                            />
                        ))}
                    </svg>
                )}
                <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-0.5 w-4 bg-current opacity-40" />
                        Ideal
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-0.5 w-4 bg-primary" />
                        Actual
                    </span>
                </div>
            </CardContent>
        </Card>
    );
}

const STATUS_PILL = {
    TODO: 'bg-muted text-muted-foreground',
    IN_PROGRESS:
        'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
    ON_HOLD:
        'bg-zinc-200 text-zinc-700 dark:bg-zinc-500/20 dark:text-zinc-300',
    DONE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
};

// Column theming for the planning boards — a stronger border, a soft
// tinted background and a coloured heading so each column reads as its
// own zone at a glance (the flat all-grey version made the backlog,
// sprint and status columns blur together).
const STATUS_COLUMN_META = {
    TODO: {
        border: 'border-sky-500/40',
        bg: 'bg-sky-500/[0.04]',
        heading: 'text-sky-700 dark:text-sky-300',
        badge: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
        accent: 'bg-sky-500',
    },
    IN_PROGRESS: {
        border: 'border-amber-500/50',
        bg: 'bg-amber-500/[0.04]',
        heading: 'text-amber-700 dark:text-amber-300',
        badge: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        accent: 'bg-amber-500',
    },
    ON_HOLD: {
        border: 'border-zinc-500/40',
        bg: 'bg-zinc-500/[0.04]',
        heading: 'text-zinc-600 dark:text-zinc-300',
        badge: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300',
        accent: 'bg-zinc-500',
    },
    DONE: {
        border: 'border-emerald-500/50',
        bg: 'bg-emerald-500/[0.04]',
        heading: 'text-emerald-700 dark:text-emerald-300',
        badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        accent: 'bg-emerald-500',
    },
};

// Board column order: On hold sits directly after the Backlog column,
// then the normal To do → In progress → Done flow. (The status dropdown
// order in TASK_STATUSES is unchanged.)
const SPRINT_BOARD_STATUSES = [
    ...TASK_STATUSES.filter((s) => s.value === 'ON_HOLD'),
    ...TASK_STATUSES.filter((s) => s.value !== 'ON_HOLD'),
];

const BACKLOG_COLUMN_META = {
    border: 'border-violet-500/40',
    bg: 'bg-violet-500/[0.04]',
    heading: 'text-violet-700 dark:text-violet-300',
    badge: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
    accent: 'bg-violet-500',
};

const SPRINT_COLUMN_META = {
    border: 'border-emerald-500/50',
    bg: 'bg-emerald-500/[0.04]',
    heading: 'text-emerald-700 dark:text-emerald-300',
    badge: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    accent: 'bg-emerald-500',
};

// Per-user, per-browser memory of which active-sprint board columns are
// collapsed. Persisted so a fold survives reloads (and the periodic
// refresh). Shape: { backlog?: bool, TODO?: bool, IN_PROGRESS?: bool,
// DONE?: bool }.
const STATUS_BOARD_COLLAPSE_KEY = 'planning-sprint-board-collapsed';

function readCollapsedCols() {
    try {
        const raw = localStorage.getItem(STATUS_BOARD_COLLAPSE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

// Header button that folds a board column down to a slim strip.
function ColumnCollapseToggle({ collapsed, onToggle, label }) {
    return (
        <button
            type="button"
            onClick={onToggle}
            title={collapsed ? `Expand ${label}` : `Collapse ${label}`}
            aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
            {collapsed ? (
                <ChevronRight className="h-3.5 w-3.5" />
            ) : (
                <ChevronLeft className="h-3.5 w-3.5" />
            )}
        </button>
    );
}

// Slim, clickable placeholder shown in place of a collapsed column. Still
// a valid drop target so you can drag a task onto a folded column.
function CollapsedColumnStrip({ label, count, meta, onExpand, dragOver, dragProps }) {
    return (
        <button
            type="button"
            onClick={onExpand}
            title={`Expand ${label}`}
            className={cn(
                'relative flex shrink-0 flex-row items-center justify-between gap-2 overflow-hidden rounded-lg border px-3 py-2 transition-colors hover:bg-accent/40 lg:w-11 lg:flex-col lg:justify-start lg:py-3',
                meta.border,
                meta.bg,
                dragOver && 'ring-2 ring-primary',
            )}
            {...dragProps}
        >
            {/* Solid status accent so a folded column's status reads at a
                glance: a bar down the left edge on desktop (vertical
                strip), across the top on mobile (horizontal row). */}
            <span
                aria-hidden
                className={cn(
                    'absolute left-0 top-0 h-1 w-full lg:h-full lg:w-1',
                    meta.accent,
                )}
            />
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span
                className={cn(
                    'text-xs font-semibold lg:[writing-mode:vertical-rl]',
                    meta.heading,
                )}
            >
                {label}
            </span>
            <span
                className={cn(
                    'rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                    meta.badge,
                )}
            >
                {count}
            </span>
        </button>
    );
}

// Deterministic per-project colour so every card belonging to the same
// project carries the same left stripe + the group header shows the
// same dot. Hash the project id into a fixed palette (all classes are
// full literals so Tailwind's JIT picks them up).
const PROJECT_COLORS = [
    {
        dot: 'bg-sky-500',
        text: 'text-sky-700 dark:text-sky-300',
        stripe: 'border-l-sky-400',
    },
    {
        dot: 'bg-rose-500',
        text: 'text-rose-700 dark:text-rose-300',
        stripe: 'border-l-rose-400',
    },
    {
        dot: 'bg-amber-500',
        text: 'text-amber-700 dark:text-amber-300',
        stripe: 'border-l-amber-400',
    },
    {
        dot: 'bg-emerald-500',
        text: 'text-emerald-700 dark:text-emerald-300',
        stripe: 'border-l-emerald-400',
    },
    {
        dot: 'bg-violet-500',
        text: 'text-violet-700 dark:text-violet-300',
        stripe: 'border-l-violet-400',
    },
    {
        dot: 'bg-cyan-500',
        text: 'text-cyan-700 dark:text-cyan-300',
        stripe: 'border-l-cyan-400',
    },
    {
        dot: 'bg-fuchsia-500',
        text: 'text-fuchsia-700 dark:text-fuchsia-300',
        stripe: 'border-l-fuchsia-400',
    },
    {
        dot: 'bg-orange-500',
        text: 'text-orange-700 dark:text-orange-300',
        stripe: 'border-l-orange-400',
    },
];

function projectColor(projectId) {
    const s = String(projectId || '');
    let h = 0;
    for (let i = 0; i < s.length; i += 1) {
        h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return PROJECT_COLORS[h % PROJECT_COLORS.length];
}

// Group a cross-project task list by project for the tree views —
// project header on top, tasks (with their nested subtasks) below.
function groupTasksByProject(tasks) {
    const map = new Map();
    for (const t of tasks) {
        const key = t.project?.id || '__none__';
        if (!map.has(key)) {
            map.set(key, {
                id: key,
                name: t.project?.name || 'No project',
                tasks: [],
            });
        }
        map.get(key).tasks.push(t);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function PlanningProjectGroups({ tasks, renderTask }) {
    const groups = useMemo(() => groupTasksByProject(tasks), [tasks]);
    // Per-group (per-column) collapse. Each header folds its own cards;
    // the page-level "Collapse/Expand projects" button broadcasts a
    // `planning:projects-bulk` window event that folds/unfolds every
    // group everywhere at once.
    const [collapsed, setCollapsed] = useState(() => new Set());
    const groupsRef = useRef(groups);
    groupsRef.current = groups;
    useEffect(() => {
        const onBulk = (e) => {
            if (e.detail?.collapse) {
                setCollapsed(new Set(groupsRef.current.map((g) => g.id)));
            } else {
                setCollapsed(new Set());
            }
        };
        window.addEventListener('planning:projects-bulk', onBulk);
        return () =>
            window.removeEventListener('planning:projects-bulk', onBulk);
    }, []);
    const toggle = (id) =>
        setCollapsed((cur) => {
            const next = new Set(cur);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    if (groups.length === 0) return null;
    return (
        <div className="space-y-3">
            {groups.map((g) => {
                const color = projectColor(g.id);
                const isCollapsed = collapsed.has(g.id);
                return (
                    <div key={g.id} className="space-y-1.5">
                        <button
                            type="button"
                            onClick={() => toggle(g.id)}
                            title={isCollapsed ? 'Expand' : 'Collapse'}
                            className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/60"
                        >
                            <ChevronDown
                                className={cn(
                                    'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                                    isCollapsed && '-rotate-90',
                                )}
                            />
                            <span
                                className={cn(
                                    'h-2 w-2 shrink-0 rounded-full',
                                    color.dot,
                                )}
                            />
                            <p
                                className={cn(
                                    'truncate text-xs font-semibold uppercase tracking-wide',
                                    color.text,
                                )}
                            >
                                {g.name}
                            </p>
                            <span className="shrink-0 rounded-full border bg-background px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                                {g.tasks.length}
                            </span>
                        </button>
                        {!isCollapsed && (
                            <div className="space-y-1.5">
                                {g.tasks.map((t) => renderTask(t, color))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// Compact status glyph shared by the backlog chips and the nested
// subtask rows — same visual language as the project sprint board.
function MiniStatusPill({ status }) {
    const tone =
        status === 'DONE'
            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
            : status === 'IN_PROGRESS'
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                : 'bg-muted text-muted-foreground';
    return (
        <span
            className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                tone,
            )}
        >
            {status === 'DONE' ? '✓' : status === 'IN_PROGRESS' ? '…' : '○'}
        </span>
    );
}

// Nested subtask list rendered under a parent task — display only;
// planning membership stays parent-level.
function SubtaskTree({ subtasks, className }) {
    if (!subtasks?.length) return null;
    return (
        <ul className={cn('space-y-0.5 border-t bg-muted/20 px-2 py-1.5', className)}>
            {subtasks.map((s) => (
                <li
                    key={s.id}
                    className="flex items-start gap-2 text-[11px]"
                    title={s.title}
                >
                    <span className="mt-0.5 text-muted-foreground/60">↳</span>
                    <span className="mt-0.5 shrink-0">
                        <MiniStatusPill status={s.status} />
                    </span>
                    {s.code && (
                        <span className="mt-0.5 shrink-0 font-mono text-[10px] text-muted-foreground">
                            {s.code}
                        </span>
                    )}
                    <span
                        className={cn(
                            'min-w-0 flex-1 break-words leading-snug',
                            s.status === 'DONE' &&
                                'text-muted-foreground line-through',
                        )}
                    >
                        {s.title}
                    </span>
                    {s.estimateHours != null && (
                        <span className="mt-0.5 shrink-0 rounded border bg-background px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                            {fmtHours(s.estimateHours)}
                        </span>
                    )}
                    {s.assignee && (
                        <Avatar className="mt-0.5 h-4 w-4 shrink-0">
                            {s.assignee.avatarUrl && (
                                <AvatarImage
                                    src={resolveAssetUrl(s.assignee.avatarUrl)}
                                    alt={s.assignee.name}
                                />
                            )}
                            <AvatarFallback className="bg-primary/10 text-[8px] text-primary">
                                {initials(s.assignee.name || '?')}
                            </AvatarFallback>
                        </Avatar>
                    )}
                </li>
            ))}
        </ul>
    );
}

// Compact draggable card for the backlog column — task + subtask tree.
function PlanningBacklogChip({
    task,
    draggable,
    onDragStart,
    onAdd,
    stripe,
    focusPinHook,
}) {
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    const doneCount = subtasks.filter((s) => s.status === 'DONE').length;
    const isFocus = focusPinHook?.isPinned
        ? focusPinHook.isPinned(task.id)
        : false;
    return (
        <div
            draggable={draggable}
            onDragStart={onDragStart}
            className={cn(
                'overflow-hidden rounded-md border border-l-4 bg-background text-xs shadow-sm',
                stripe,
                draggable && 'cursor-grab active:cursor-grabbing',
                isFocus &&
                    'border-fuchsia-300 ring-1 ring-fuchsia-300/40',
            )}
        >
            <div className="flex items-center gap-2 px-2 py-1.5">
                <MiniStatusPill status={task.status} />
                {task.code && (
                    <span className="font-mono text-[10px] text-muted-foreground">
                        {task.code}
                    </span>
                )}
                <span
                    className="min-w-0 flex-1 truncate font-semibold"
                    title={task.title}
                >
                    {task.title}
                </span>
                {subtasks.length > 0 && (
                    <span
                        className="rounded border bg-muted/30 px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground"
                        title={`${doneCount} of ${subtasks.length} subtasks done`}
                    >
                        {doneCount}/{subtasks.length}
                    </span>
                )}
                {task.estimateHours != null && (
                    <span className="rounded border bg-muted/30 px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                        {fmtHours(task.estimateHours)}
                    </span>
                )}
                {task.assignee && (
                    <Avatar className="h-5 w-5">
                        {task.assignee.avatarUrl && (
                            <AvatarImage
                                src={resolveAssetUrl(task.assignee.avatarUrl)}
                                alt={task.assignee.name}
                            />
                        )}
                        <AvatarFallback className="bg-primary/10 text-[9px] text-primary">
                            {initials(task.assignee.name || '?')}
                        </AvatarFallback>
                    </Avatar>
                )}
                {focusPinHook && (
                    <PinButton
                        kind="TASK_FOCUS"
                        refId={task.id}
                        variant="highlighter"
                        size="xs"
                        pinHookOverride={focusPinHook}
                        offLabel="Mark as today's focus"
                        onLabel="Clear today's focus"
                    />
                )}
                {onAdd && (
                    <button
                        type="button"
                        onClick={onAdd}
                        title="Add to sprint"
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                        <Plus className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>
            {task.description ? (
                <p
                    className="truncate px-2 pb-1.5 text-[11px] leading-snug text-muted-foreground"
                    title={task.description}
                >
                    {task.description.split('\n')[0]}
                </p>
            ) : null}
            <SubtaskTree subtasks={subtasks} />
        </div>
    );
}

// Cross-project backlog column: open tasks (top-level, subtasks nested)
// from every project the user can access that aren't in this planning
// sprint yet. Grouped by project; drag a card into the sprint (or hit +).
function PlanningBacklogColumn({
    backlog,
    loading,
    q,
    onQChange,
    writable,
    onAdd,
    dragOver,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragStartTask,
    focusPinHook,
    collapsed = false,
    onToggleCollapse = null,
}) {
    if (collapsed) {
        return (
            <CollapsedColumnStrip
                label="Backlog"
                count={backlog.length}
                meta={BACKLOG_COLUMN_META}
                onExpand={onToggleCollapse || (() => {})}
                dragOver={dragOver}
                dragProps={{ onDragOver, onDragLeave, onDrop }}
            />
        );
    }
    return (
        <section
            className={cn(
                'min-w-0 flex-1 rounded-lg border p-3 transition-colors',
                BACKLOG_COLUMN_META.border,
                BACKLOG_COLUMN_META.bg,
                dragOver && 'ring-2 ring-primary',
            )}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            <div className="mb-2 flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <h3
                        className={cn(
                            'text-sm font-semibold',
                            BACKLOG_COLUMN_META.heading,
                        )}
                    >
                        Backlog
                    </h3>
                    <p className="text-[11px] text-muted-foreground">
                        Open tasks from all projects, not in this sprint
                    </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <span
                        className={cn(
                            'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                            BACKLOG_COLUMN_META.badge,
                        )}
                    >
                        {backlog.length}
                    </span>
                    {onToggleCollapse && (
                        <ColumnCollapseToggle
                            collapsed={false}
                            onToggle={onToggleCollapse}
                            label="Backlog"
                        />
                    )}
                </div>
            </div>
            <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                    value={q}
                    onChange={(e) => onQChange(e.target.value)}
                    placeholder="Search backlog..."
                    className="h-8 pl-7 text-xs"
                />
            </div>
            {loading ? (
                <p className="flex items-center gap-1.5 rounded border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Loading
                    backlog…
                </p>
            ) : backlog.length === 0 ? (
                <p className="rounded border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                    No open tasks found. Adjust the search or filters.
                </p>
            ) : (
                <PlanningProjectGroups
                    tasks={backlog}
                    renderTask={(t, color) => (
                        <PlanningBacklogChip
                            key={t.id}
                            task={t}
                            draggable={writable}
                            onDragStart={(e) => onDragStartTask(e, t)}
                            onAdd={writable ? () => onAdd(t.id) : null}
                            stripe={color.stripe}
                            focusPinHook={focusPinHook}
                        />
                    )}
                />
            )}
        </section>
    );
}

// Planned (not yet started) planning sprint — backlog + sprint split,
// mirroring the project sprint board. Drag right to commit a task,
// left to send it back; both sides grouped project > task > subtask.
function PlanningPlannedBoard({
    sprint,
    tasks,
    backlog,
    backlogLoading,
    backlogQ,
    onBacklogQChange,
    canManage,
    onAdd,
    onRemove,
    onChanged,
    notesBulk,
    focusPinHook,
}) {
    const writable = canManage && sprint.status !== 'CLOSED';
    const [dragOverCol, setDragOverCol] = useState(null);
    // Collapse either column (Backlog / the sprint) to a thin strip, like
    // the started-sprint phase columns.
    const [collapsedCols, setCollapsedCols] = useState({});
    const toggleCol = (key) =>
        setCollapsedCols((cur) => ({ ...cur, [key]: !cur[key] }));

    const onDragStart = (e, taskId, source) => {
        e.dataTransfer.setData(
            'text/plain',
            JSON.stringify({ taskId, source }),
        );
        e.dataTransfer.effectAllowed = 'move';
    };

    const onDrop = async (e, target) => {
        if (!writable) return;
        e.preventDefault();
        setDragOverCol(null);
        try {
            const payload = JSON.parse(
                e.dataTransfer.getData('text/plain') || '{}',
            );
            if (!payload.taskId || payload.source === target) return;
            if (target === 'sprint') await onAdd(payload.taskId);
            if (target === 'backlog') await onRemove(payload.taskId);
        } catch {
            /* ignore */
        }
    };

    const sprintDragProps = {
        onDragOver: (e) => {
            if (!writable) return;
            e.preventDefault();
            setDragOverCol('sprint');
        },
        onDragLeave: () => setDragOverCol(null),
        onDrop: (e) => onDrop(e, 'sprint'),
    };

    return (
        <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-start">
            <PlanningBacklogColumn
                backlog={backlog}
                loading={backlogLoading}
                q={backlogQ}
                onQChange={onBacklogQChange}
                writable={writable}
                onAdd={onAdd}
                dragOver={dragOverCol === 'backlog'}
                onDragOver={(e) => {
                    if (!writable) return;
                    e.preventDefault();
                    setDragOverCol('backlog');
                }}
                onDragLeave={() => setDragOverCol(null)}
                onDrop={(e) => onDrop(e, 'backlog')}
                onDragStartTask={(e, t) => onDragStart(e, t.id, 'backlog')}
                focusPinHook={focusPinHook}
                collapsed={!!collapsedCols.backlog}
                onToggleCollapse={() => toggleCol('backlog')}
            />
            {collapsedCols.sprint ? (
                <CollapsedColumnStrip
                    label={sprint.name}
                    count={tasks.length}
                    meta={SPRINT_COLUMN_META}
                    onExpand={() => toggleCol('sprint')}
                    dragOver={dragOverCol === 'sprint'}
                    dragProps={sprintDragProps}
                />
            ) : (
            <section
                className={cn(
                    'min-w-0 flex-1 rounded-lg border p-3 transition-colors',
                    SPRINT_COLUMN_META.border,
                    SPRINT_COLUMN_META.bg,
                    dragOverCol === 'sprint' && 'ring-2 ring-primary',
                )}
                {...sprintDragProps}
            >
                <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <h3
                            className={cn(
                                'truncate text-sm font-semibold',
                                SPRINT_COLUMN_META.heading,
                            )}
                        >
                            {sprint.name}
                        </h3>
                        <p className="text-[11px] text-muted-foreground">
                            Tasks committed to this sprint
                        </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <span
                            className={cn(
                                'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                                SPRINT_COLUMN_META.badge,
                            )}
                        >
                            {tasks.length}
                        </span>
                        <ColumnCollapseToggle
                            collapsed={false}
                            onToggle={() => toggleCol('sprint')}
                            label={sprint.name}
                        />
                    </div>
                </div>
                {tasks.length === 0 ? (
                    <p className="rounded border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                        {writable
                            ? 'Drag tasks here from the backlog (or use +) to commit them to this sprint.'
                            : 'No tasks in this sprint.'}
                    </p>
                ) : (
                    <PlanningProjectGroups
                        tasks={tasks}
                        renderTask={(t, color) => (
                            <div
                                key={t.id}
                                draggable={writable}
                                onDragStart={(e) =>
                                    onDragStart(e, t.id, 'sprint')
                                }
                                className={cn(
                                    writable &&
                                        'cursor-grab active:cursor-grabbing',
                                )}
                            >
                                <PlanningTaskRow
                                    task={t}
                                    hideProject
                                    canManage={canManage}
                                    canRemove={writable}
                                    canCreateSubtask={writable}
                                    onRemove={() => onRemove(t.id)}
                                    onChanged={onChanged}
                                    notesBulk={notesBulk}
                                    stripe={color.stripe}
                                    focusPinHook={focusPinHook}
                                />
                            </div>
                        )}
                    />
                )}
            </section>
            )}
        </div>
    );
}

// Jira-style status columns for an active planning sprint — a backlog
// column on the left plus one column per task status. Drag between
// status columns to update status; drag from the backlog into a column
// to commit a task to the sprint (and back to the backlog to remove it).
function PlanningSprintStatusBoard({
    tasks,
    backlog,
    backlogLoading,
    backlogQ,
    onBacklogQChange,
    canManage,
    onAdd,
    onRemove,
    onChanged,
    notesBulk,
    focusPinHook,
}) {
    const writable = canManage;
    const [dragOverCol, setDragOverCol] = useState(null);

    // Which columns are folded to a slim strip. Persisted per-browser so
    // the layout survives reloads and the periodic refresh.
    const [collapsedCols, setCollapsedCols] = useState(readCollapsedCols);
    useEffect(() => {
        try {
            localStorage.setItem(
                STATUS_BOARD_COLLAPSE_KEY,
                JSON.stringify(collapsedCols),
            );
        } catch {
            /* storage unavailable — fold state just won't persist */
        }
    }, [collapsedCols]);
    const toggleCol = useCallback((key) => {
        setCollapsedCols((prev) => ({ ...prev, [key]: !prev[key] }));
    }, []);

    const tasksByStatus = useMemo(() => {
        const map = Object.fromEntries(
            TASK_STATUSES.map((s) => [s.value, []]),
        );
        for (const t of tasks) {
            const key = map[t.status] ? t.status : 'TODO';
            map[key].push(t);
        }
        return map;
    }, [tasks]);

    const changeStatus = async (taskId, status) => {
        try {
            await api.patch(`/tasks/${taskId}`, { status });
            onChanged?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not update task status.',
            );
        }
    };

    const onDragStart = (e, taskId, source, status = null) => {
        e.dataTransfer.setData(
            'text/plain',
            JSON.stringify({ taskId, source, status }),
        );
        e.dataTransfer.effectAllowed = 'move';
    };

    const onDrop = async (e, target) => {
        if (!writable) return;
        e.preventDefault();
        setDragOverCol(null);
        try {
            const payload = JSON.parse(
                e.dataTransfer.getData('text/plain') || '{}',
            );
            if (!payload.taskId) return;
            if (target === 'backlog') {
                if (payload.source !== 'backlog') {
                    await onRemove(payload.taskId);
                }
                return;
            }
            if (payload.source === 'backlog') {
                await onAdd(payload.taskId);
                if (target !== 'TODO') {
                    await changeStatus(payload.taskId, target);
                }
                return;
            }
            if (payload.status !== target) {
                await changeStatus(payload.taskId, target);
            }
        } catch {
            /* ignore */
        }
    };

    return (
        <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-start">
            <PlanningBacklogColumn
                backlog={backlog}
                loading={backlogLoading}
                q={backlogQ}
                onQChange={onBacklogQChange}
                writable={writable}
                onAdd={onAdd}
                dragOver={dragOverCol === 'backlog'}
                onDragOver={(e) => {
                    if (!writable) return;
                    e.preventDefault();
                    setDragOverCol('backlog');
                }}
                onDragLeave={() => setDragOverCol(null)}
                onDrop={(e) => onDrop(e, 'backlog')}
                onDragStartTask={(e, t) => onDragStart(e, t.id, 'backlog')}
                focusPinHook={focusPinHook}
                collapsed={!!collapsedCols.backlog}
                onToggleCollapse={() => toggleCol('backlog')}
            />
            {SPRINT_BOARD_STATUSES.map((s) => {
                const colMeta =
                    STATUS_COLUMN_META[s.value] || STATUS_COLUMN_META.TODO;
                const colCount = (tasksByStatus[s.value] || []).length;
                const dragProps = {
                    onDragOver: (e) => {
                        if (!writable) return;
                        e.preventDefault();
                        setDragOverCol(s.value);
                    },
                    onDragLeave: () => setDragOverCol(null),
                    onDrop: (e) => onDrop(e, s.value),
                };
                if (collapsedCols[s.value]) {
                    return (
                        <CollapsedColumnStrip
                            key={s.value}
                            label={s.label}
                            count={colCount}
                            meta={colMeta}
                            onExpand={() => toggleCol(s.value)}
                            dragOver={dragOverCol === s.value}
                            dragProps={dragProps}
                        />
                    );
                }
                return (
                <section
                    key={s.value}
                    className={cn(
                        'min-w-0 flex-1 rounded-lg border p-3 transition-colors',
                        colMeta.border,
                        colMeta.bg,
                        dragOverCol === s.value && 'ring-2 ring-primary',
                    )}
                    {...dragProps}
                >
                    <div className="mb-2 flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <h3
                                className={cn(
                                    'text-sm font-semibold',
                                    colMeta.heading,
                                )}
                            >
                                {s.label}
                            </h3>
                            <p className="text-[11px] text-muted-foreground">
                                Drag tasks here to set status
                            </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <span
                                className={cn(
                                    'rounded-full border px-2 py-0.5 text-[10px] font-medium',
                                    colMeta.badge,
                                )}
                            >
                                {colCount}
                            </span>
                            <ColumnCollapseToggle
                                collapsed={false}
                                onToggle={() => toggleCol(s.value)}
                                label={s.label}
                            />
                        </div>
                    </div>
                    {colCount === 0 ? (
                        <p className="rounded border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                            {writable
                                ? 'Drag tasks here — from another column or the backlog.'
                                : 'No tasks'}
                        </p>
                    ) : (
                        <PlanningProjectGroups
                            tasks={tasksByStatus[s.value] || []}
                            renderTask={(t, color) => (
                                <div
                                    key={t.id}
                                    draggable={writable}
                                    onDragStart={(e) =>
                                        onDragStart(
                                            e,
                                            t.id,
                                            'status',
                                            t.status,
                                        )
                                    }
                                    className={cn(
                                        writable &&
                                            'cursor-grab active:cursor-grabbing',
                                    )}
                                >
                                    <PlanningTaskRow
                                        task={t}
                                        hideProject
                                        canManage={canManage}
                                        canRemove={canManage}
                                        canCreateSubtask={canManage}
                                        onRemove={() => onRemove(t.id)}
                                        onChanged={onChanged}
                                        notesBulk={notesBulk}
                                        stripe={color.stripe}
                                        focusPinHook={focusPinHook}
                                    />
                                </div>
                            )}
                        />
                    )}
                </section>
                );
            })}
        </div>
    );
}

// Per-assignee planned vs estimated load — adapted from the project
// sprint board's CapacityHeatmap. "Planned" comes from
// PlanningSprintCapacity rows; "estimated" sums estimateHours on the
// sprint's tasks per assignee.
function PlanningCapacityHeatmap({ capacity, tasks, knownUsers }) {
    const byUser = new Map();
    for (const c of capacity || []) {
        byUser.set(c.userId, {
            user: c.user,
            planned: c.plannedHours,
            estimated: 0,
        });
    }
    for (const t of tasks || []) {
        if (!t.assigneeId) continue;
        const entry =
            byUser.get(t.assigneeId) || {
                user: t.assignee,
                planned: 0,
                estimated: 0,
            };
        entry.estimated += t.estimateHours || 0;
        byUser.set(t.assigneeId, entry);
    }
    for (const [uid, val] of byUser) {
        if (!val.user) {
            const u = (knownUsers || []).find((p) => p.id === uid);
            if (u) val.user = u;
        }
    }
    const rows = Array.from(byUser.values()).filter((r) => r.user);
    if (rows.length === 0) return null;
    const pctOf = (num, denom) =>
        denom ? Math.min(100, Math.round((num / denom) * 100)) : 0;
    return (
        <div className="space-y-1.5 border-t pt-3">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                Capacity per assignee
                <Tip variant="help" side="top">
                    <p className="font-medium">How to read this row</p>
                    <ul className="ml-4 mt-1 list-disc space-y-0.5 text-muted-foreground">
                        <li>
                            <strong>Planned</strong> (filled bar) — hours
                            committed via the <em>Capacity</em> button.
                        </li>
                        <li>
                            <strong>Estimated</strong> (outlined bar) — sum
                            of task estimates assigned to them here.
                        </li>
                        <li>
                            <strong>Rose</strong> = estimated &gt; planned
                            (overload). <strong>Amber</strong> = estimated
                            &lt; 50% of planned. Otherwise green.
                        </li>
                    </ul>
                </Tip>
            </div>
            {rows.map(({ user, planned, estimated }) => {
                const max = Math.max(planned || 0, estimated || 0, 1);
                const over = planned > 0 && estimated > planned;
                const under = planned > 0 && estimated < planned * 0.5;
                return (
                    <div
                        key={user.id}
                        className="flex items-center gap-2 text-[11px]"
                    >
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
                        <span className="w-24 truncate">{user.name}</span>
                        <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                                className="absolute left-0 top-0 h-full rounded-full bg-sky-500/40"
                                style={{
                                    width: `${pctOf(planned || 0, max)}%`,
                                }}
                                title={`Planned: ${planned}h`}
                            />
                            <div
                                className={cn(
                                    'absolute left-0 top-0 h-full rounded-full border',
                                    over
                                        ? 'border-rose-500 bg-rose-500/30'
                                        : under
                                            ? 'border-amber-500 bg-amber-500/20'
                                            : 'border-emerald-500 bg-emerald-500/20',
                                )}
                                style={{
                                    width: `${pctOf(estimated || 0, max)}%`,
                                }}
                                title={`Estimated: ${estimated}h`}
                            />
                        </div>
                        <span
                            className={cn(
                                'w-28 shrink-0 text-right tabular-nums',
                                over
                                    ? 'text-rose-600 dark:text-rose-400'
                                    : 'text-muted-foreground',
                            )}
                        >
                            {fmtHours(estimated)} / {fmtHours(planned)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

// Capacity editor — same contract as the project sprint dialog, but
// seeded from the already-loaded sprint detail (no refetch needed).
function PlanningCapacityDialog({ open, sprint, users, onClose, onSubmit }) {
    const [rows, setRows] = useState([]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open || !sprint) return;
        const map = new Map();
        for (const c of sprint.capacity || []) {
            map.set(c.userId, c.plannedHours);
        }
        setRows(
            (users || []).map((u) => ({
                userId: u.id,
                user: u,
                plannedHours: map.get(u.id) ?? 0,
            })),
        );
    }, [open, sprint, users]);

    const save = async () => {
        setSaving(true);
        try {
            const entries = rows
                .filter((r) => (r.plannedHours || 0) > 0)
                .map((r) => ({
                    userId: r.userId,
                    plannedHours: Math.max(0, Number(r.plannedHours) || 0),
                }));
            await onSubmit(entries);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => !o && !saving && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="inline-flex items-center gap-2">
                        <Settings2 className="h-4 w-4 text-sky-600" />
                        Sprint capacity
                    </DialogTitle>
                    <DialogDescription>
                        Planned hours each person can commit to “
                        {sprint?.name}”. Leave someone at zero to keep
                        them out of the heatmap.
                    </DialogDescription>
                </DialogHeader>
                {rows.length === 0 ? (
                    <p className="rounded border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                        No candidate users found — assign the sprint to a
                        team, or add tasks with assignees first.
                    </p>
                ) : (
                    <div className="max-h-[55vh] space-y-1.5 overflow-y-auto pr-1">
                        {rows.map((r, i) => (
                            <div
                                key={r.userId}
                                className="flex items-center gap-2"
                            >
                                <Avatar className="h-6 w-6">
                                    {r.user.avatarUrl && (
                                        <AvatarImage
                                            src={resolveAssetUrl(
                                                r.user.avatarUrl,
                                            )}
                                            alt={r.user.name}
                                        />
                                    )}
                                    <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                                        {initials(r.user.name || '?')}
                                    </AvatarFallback>
                                </Avatar>
                                <span className="min-w-0 flex-1 truncate text-sm">
                                    {r.user.name}
                                </span>
                                <Input
                                    type="number"
                                    min="0"
                                    step="0.5"
                                    value={r.plannedHours}
                                    onChange={(e) => {
                                        const v = e.target.value;
                                        setRows((prev) => {
                                            const next = [...prev];
                                            next[i] = {
                                                ...next[i],
                                                plannedHours: v,
                                            };
                                            return next;
                                        });
                                    }}
                                    className="h-8 w-24 text-right"
                                />
                            </div>
                        ))}
                    </div>
                )}
                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={onClose}
                        disabled={saving}
                    >
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={saving}>
                        {saving ? 'Saving…' : 'Save capacity'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function PlanningTaskRow({
    task,
    canManage,
    canRemove,
    onRemove,
    onChanged,
    hideProject = false,
    notesBulk = null,
    stripe = null,
    focusPinHook = null,
    canCreateSubtask = false,
}) {
    const { user } = useAuth();
    const prio = PRIORITY_META[task.priority] || PRIORITY_META.MEDIUM;
    const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
    const doneSubtasks = subtasks.filter((s) => s.status === 'DONE').length;
    const isFocus = focusPinHook?.isPinned
        ? focusPinHook.isPinned(task.id)
        : false;
    const [updateOpen, setUpdateOpen] = useState(false);
    const [quickViewOpen, setQuickViewOpen] = useState(false);
    const [notesOpen, setNotesOpen] = useState(false);
    const [notes, setNotes] = useState(null);
    const [loadingNotes, setLoadingNotes] = useState(false);

    const loadNotes = useCallback(async () => {
        if (!task.project?.id) return;
        try {
            setLoadingNotes(true);
            const res = await api.get('/notes', {
                params: {
                    projectId: task.project.id,
                    taskId: task.id,
                    // Subtasks ride along under their parent row, so
                    // their notes belong in this panel too.
                    includeSubtasks: true,
                },
            });
            setNotes(res.data.notes || []);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not load notes.');
        } finally {
            setLoadingNotes(false);
        }
    }, [task.project?.id, task.id]);

    const toggleNotes = () => {
        const next = !notesOpen;
        setNotesOpen(next);
        if (next && notes === null) loadNotes();
    };

    // Page-level "Show/Hide notes" toggle. The `tick` in notesBulk makes
    // this re-fire even when the same mode is requested twice.
    useEffect(() => {
        if (!notesBulk) return;
        const show = notesBulk.mode === 'show';
        setNotesOpen(show);
        if (show) {
            setNotes((cur) => {
                if (cur === null) loadNotes();
                return cur;
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [notesBulk]);

    const changeStatus = async (status) => {
        if (!status || status === task.status) return;
        try {
            await api.patch(`/tasks/${task.id}`, { status });
            onChanged?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not update task status.',
            );
        }
    };

    const changePriority = async (priority) => {
        if (!priority || priority === task.priority) return;
        try {
            await api.patch(`/tasks/${task.id}`, { priority });
            onChanged?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    'Could not update task priority.',
            );
        }
    };

    const createSubtask = async () => {
        const title = window.prompt('Subtask title');
        if (!title?.trim()) return;
        try {
            await api.post('/tasks', {
                projectId: task.project?.id,
                parentTaskId: task.id,
                title: title.trim(),
                phaseId: task.phase?.id ?? null,
            });
            toast.success('Subtask added.');
            onChanged?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not add subtask.',
            );
        }
    };

    const noteCount = Array.isArray(notes) ? notes.length : null;

    return (
        <div
            className={cn(
                'rounded-lg border bg-card text-sm',
                stripe && 'border-l-4',
                stripe,
                isFocus &&
                    'border-fuchsia-300 ring-1 ring-fuchsia-300/40',
            )}
        >
            <div className="p-3">
                <div className="min-w-0">
                    <div className="flex items-start gap-2">
                        {task.code && (
                            <span className="shrink-0 font-mono text-xs leading-snug text-muted-foreground">
                                {task.code}
                            </span>
                        )}
                        <button
                            type="button"
                            onClick={() => setQuickViewOpen(true)}
                            title="Open task details"
                            className="min-w-0 flex-1 whitespace-normal break-words text-left font-medium leading-snug hover:text-primary hover:underline"
                        >
                            {task.title}
                        </button>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {!hideProject && task.project && (
                            <span
                                title={task.project.name}
                                className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-semibold text-primary"
                            >
                                <FolderKanban className="h-3 w-3 shrink-0" />
                                {task.project.name}
                            </span>
                        )}
                        <span
                            className={cn(
                                'rounded px-1.5 py-0.5 font-medium',
                                STATUS_PILL[task.status] || STATUS_PILL.TODO,
                            )}
                        >
                            {TASK_STATUS_LABEL[task.status] || task.status}
                        </span>
                        {canManage ? (
                            // Inline priority picker — same PATCH the task
                            // edit dialog uses, just one click from the row.
                            <Select
                                value={task.priority || 'MEDIUM'}
                                onValueChange={changePriority}
                            >
                                <SelectTrigger
                                    className={cn(
                                        'h-6 w-auto gap-1 border-dashed bg-transparent px-1.5 py-0 text-[11px] font-medium shadow-none',
                                        prio.cls,
                                    )}
                                    title="Change priority"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {TASK_PRIORITIES.map((p) => (
                                        <SelectItem
                                            key={p.value}
                                            value={p.value}
                                            className="text-xs"
                                        >
                                            {p.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        ) : (
                            <span className={prio.cls}>{prio.label}</span>
                        )}
                        {task.assignee && <span>· {task.assignee.name}</span>}
                        {task.dueDate && (
                            <span>· due {fmtDate(task.dueDate)}</span>
                        )}
                        {subtasks.length > 0 && (
                            <span
                                title={`${doneSubtasks} of ${subtasks.length} subtasks done`}
                            >
                                · {doneSubtasks}/{subtasks.length} subtasks
                            </span>
                        )}
                    </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                    {focusPinHook && (
                        <PinButton
                            kind="TASK_FOCUS"
                            refId={task.id}
                            variant="highlighter"
                            size="xs"
                            pinHookOverride={focusPinHook}
                            offLabel="Mark as today's focus"
                            onLabel="Clear today's focus"
                        />
                    )}
                    {canCreateSubtask && (
                        <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={createSubtask}
                            title="Add subtask"
                        >
                            <Plus className="h-4 w-4" />
                        </Button>
                    )}
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 gap-1 px-2 text-xs"
                        onClick={toggleNotes}
                        title="Show updates / notes"
                    >
                        <ChevronDown
                            className={cn(
                                'h-3.5 w-3.5 transition-transform',
                                notesOpen && 'rotate-180',
                            )}
                        />
                        {noteCount === null ? 'Notes' : noteCount}
                    </Button>
                    {canManage && task.project && (
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1 px-2 text-xs"
                            onClick={() => setUpdateOpen(true)}
                            title="Add a status update / note"
                        >
                            <MessageSquarePlus className="h-3.5 w-3.5" />
                            Update
                        </Button>
                    )}
                    {canRemove && (
                        <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={onRemove}
                            title="Send to backlog (remove from sprint)"
                        >
                            <Undo2 className="h-4 w-4" />
                        </Button>
                    )}
                </div>
            </div>

            <SubtaskTree subtasks={subtasks} className="px-3" />

            {notesOpen && (
                <div className="border-t border-amber-300/40 bg-amber-500/[0.08] px-3 py-2 dark:bg-amber-400/[0.06]">
                    {loadingNotes ? (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" /> Loading
                            updates…
                        </p>
                    ) : !notes || notes.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                            No updates yet. Use “Update” to post one — it shows
                            up here and in the project’s notes.
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {notes.map((n) => (
                                <li
                                    key={n.id}
                                    className="rounded-md border border-amber-300/50 bg-amber-50 px-2.5 py-1.5 dark:border-amber-400/20 dark:bg-amber-400/10"
                                >
                                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                                        <span className="flex min-w-0 items-center gap-1.5">
                                            <span className="font-medium text-foreground/80">
                                                {n.author?.name || 'Someone'}
                                            </span>
                                            {/* Subtask notes are pulled in
                                                alongside the parent's —
                                                badge them so it's clear
                                                which row they belong to. */}
                                            {n.task && n.task.id !== task.id && (
                                                <span
                                                    className="truncate rounded border border-amber-400/40 bg-amber-100 px-1 py-px font-mono text-[9px] text-amber-800 dark:bg-amber-400/15 dark:text-amber-200"
                                                    title={n.task.title}
                                                >
                                                    ↳ {n.task.code || n.task.title}
                                                </span>
                                            )}
                                        </span>
                                        <span className="shrink-0">
                                            {n.createdAt
                                                ? fmtDate(n.createdAt)
                                                : ''}
                                        </span>
                                    </div>
                                    <p className="mt-0.5 whitespace-pre-wrap break-words text-xs">
                                        {n.content}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            <PlanningTaskUpdateDialog
                open={updateOpen}
                onOpenChange={setUpdateOpen}
                task={task}
                onSaved={(statusChanged) => {
                    setUpdateOpen(false);
                    setNotes(null);
                    if (notesOpen) loadNotes();
                    // Only a status change moves the card between columns and
                    // needs the full sprint reload; a note alone refreshes the
                    // local notes panel without scrolling the list to the top.
                    if (statusChanged) onChanged?.();
                }}
            />

            <TaskQuickViewDialog
                open={quickViewOpen}
                task={task}
                defaultTab="note"
                projectId={task.project?.id}
                projectName={task.project?.name}
                onClose={() => setQuickViewOpen(false)}
                onNoteSubmitted={() => {
                    setNotes(null);
                    if (notesOpen) loadNotes();
                    // Note-only: refresh the local panel, no full reload.
                }}
                onTimeLogged={() => onChanged?.()}
                canLogTime={
                    canManage || task.assignee?.id === user?.id
                }
                canApprove={
                    user?.role === 'ADMIN' ||
                    user?.role === 'MANAGER' ||
                    hasCapability(user, CAPABILITIES_FRONT.TASK_APPROVE)
                }
                canRerequest={
                    user?.role === 'ADMIN' ||
                    user?.role === 'MANAGER' ||
                    task.createdById === user?.id ||
                    task.createdBy?.id === user?.id ||
                    task.assignee?.id === user?.id
                }
                onApproved={() => onChanged?.()}
                onStatusChange={canManage ? changeStatus : undefined}
            />
        </div>
    );
}

// Combined "status update" control: write a note and optionally flip the
// task's status in one action. The note posts to the shared /notes
// endpoint pinned to the task, so it also appears in the project's Notes
// panel alongside every other note.
function PlanningTaskUpdateDialog({ open, onOpenChange, task, onSaved }) {
    const [content, setContent] = useState('');
    const [status, setStatus] = useState(task.status || 'TODO');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (open) {
            setContent('');
            setStatus(task.status || 'TODO');
        }
    }, [open, task.status]);

    const save = async () => {
        const text = content.trim();
        if (!text) return toast.error('Write a short update first.');
        try {
            setSaving(true);
            await api.post('/notes', {
                projectId: task.project.id,
                taskId: task.id,
                content: text,
            });
            const statusChanged = Boolean(status && status !== task.status);
            if (statusChanged) {
                await api.patch(`/tasks/${task.id}`, { status });
            }
            toast.success('Update posted.');
            // Tell the caller whether the card needs to move columns — a
            // note-only update shouldn't trigger a full sprint reload (that
            // scrolls the list back to the top).
            onSaved?.(statusChanged);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not post update.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[460px]">
                <DialogHeader>
                    <DialogTitle>Status update</DialogTitle>
                    <DialogDescription>
                        Post a note on{' '}
                        <span className="font-medium text-foreground">
                            {task.title}
                        </span>{' '}
                        and optionally change its status. The note also appears
                        in the project’s notes.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label>Update</Label>
                        <Textarea
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            rows={3}
                            autoFocus
                            placeholder="What changed? e.g. Started work, blocked on API, ready for review…"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Status</Label>
                        <Select value={status} onValueChange={setStatus}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {Object.entries(TASK_STATUS_LABEL).map(
                                    ([value, label]) => (
                                        <SelectItem key={value} value={value}>
                                            {label}
                                        </SelectItem>
                                    ),
                                )}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={saving}>
                        {saving ? 'Posting…' : 'Post update'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function AddTasksDialog({ sprintId, open, onOpenChange, teams, onAdded }) {
    const [q, setQ] = useState('');
    const [teamId, setTeamId] = useState('');
    const [results, setResults] = useState([]);
    const [selected, setSelected] = useState(() => new Set());
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) {
            setQ('');
            setTeamId('');
            setResults([]);
            setSelected(new Set());
        }
    }, [open]);

    const search = useCallback(async () => {
        try {
            setLoading(true);
            const params = { excludeSprintId: sprintId };
            if (q.trim()) params.q = q.trim();
            if (teamId) params.teamId = teamId;
            const res = await api.get('/planning-sprints/backlog/tasks', {
                params,
            });
            setResults(res.data.tasks || []);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Search failed.');
        } finally {
            setLoading(false);
        }
    }, [q, teamId, sprintId]);

    useEffect(() => {
        if (!open) return;
        const t = setTimeout(search, 250);
        return () => clearTimeout(t);
    }, [open, search]);

    const toggle = (taskId) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(taskId)) next.delete(taskId);
            else next.add(taskId);
            return next;
        });
    };

    const allVisibleSelected =
        results.length > 0 && results.every((t) => selected.has(t.id));

    const toggleSelectAll = () => {
        if (allVisibleSelected) {
            setSelected(new Set());
        } else {
            setSelected(new Set(results.map((t) => t.id)));
        }
    };

    const add = async () => {
        if (!selected.size) return;
        try {
            setSaving(true);
            const res = await api.post(`/planning-sprints/${sprintId}/tasks`, {
                taskIds: Array.from(selected),
            });
            toast.success('Tasks added.');
            onAdded?.(res.data.planningSprint);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add tasks.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[640px]">
                <DialogHeader>
                    <DialogTitle>Add tasks</DialogTitle>
                    <DialogDescription>
                        Search open tasks across every project you can access.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={q}
                                onChange={(e) => setQ(e.target.value)}
                                placeholder="Search by title or code..."
                                className="pl-8"
                            />
                        </div>
                        <Select
                            value={teamId || 'all'}
                            onValueChange={(v) =>
                                setTeamId(v === 'all' ? '' : v)
                            }
                        >
                            <SelectTrigger className="w-[160px]">
                                <SelectValue placeholder="Any assignee" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">Any team</SelectItem>
                                {teams.map((t) => (
                                    <SelectItem key={t.id} value={t.id}>
                                        {t.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {results.length > 0 && (
                        <div className="flex items-center justify-between gap-2 border-b pb-2">
                            <button
                                type="button"
                                onClick={toggleSelectAll}
                                className="text-xs font-medium text-primary hover:underline"
                            >
                                {allVisibleSelected
                                    ? 'Deselect all'
                                    : `Select all (${results.length})`}
                            </button>
                            {selected.size > 0 && (
                                <span className="text-xs text-muted-foreground">
                                    {selected.size} selected
                                </span>
                            )}
                        </div>
                    )}

                    <div className="max-h-[320px] space-y-1.5 overflow-auto">
                        {loading ? (
                            <p className="p-4 text-center text-sm text-muted-foreground">
                                Searching...
                            </p>
                        ) : results.length === 0 ? (
                            <p className="p-4 text-center text-sm text-muted-foreground">
                                No matching tasks.
                            </p>
                        ) : (
                            results.map((t) => {
                                const checked = selected.has(t.id);
                                const prio =
                                    PRIORITY_META[t.priority] ||
                                    PRIORITY_META.MEDIUM;
                                return (
                                    <button
                                        type="button"
                                        key={t.id}
                                        onClick={() => toggle(t.id)}
                                        className={cn(
                                            'flex w-full items-center gap-3 rounded-lg border p-2.5 text-left text-sm transition',
                                            checked
                                                ? 'border-primary bg-primary/5'
                                                : 'hover:bg-muted/50',
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                                checked
                                                    ? 'border-primary bg-primary text-primary-foreground'
                                                    : 'border-muted-foreground/40',
                                            )}
                                        >
                                            {checked && (
                                                <CheckCircle2 className="h-3.5 w-3.5" />
                                            )}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center gap-2">
                                                {t.code && (
                                                    <span className="font-mono text-xs text-muted-foreground">
                                                        {t.code}
                                                    </span>
                                                )}
                                                <span className="truncate font-medium">
                                                    {t.title}
                                                </span>
                                            </span>
                                            <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                                {t.project && (
                                                    <span className="rounded bg-muted px-1.5 py-0.5">
                                                        {t.project.name}
                                                    </span>
                                                )}
                                                <span className={prio.cls}>
                                                    {prio.label}
                                                </span>
                                                {t.assignee && (
                                                    <span>
                                                        · {t.assignee.name}
                                                    </span>
                                                )}
                                            </span>
                                        </span>
                                    </button>
                                );
                            })
                        )}
                    </div>
                </div>
                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button onClick={add} disabled={saving || !selected.size}>
                        {saving
                            ? 'Adding...'
                            : `Add ${selected.size || ''} task${selected.size === 1 ? '' : 's'}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

const CLOSE_STRATEGIES = [
    {
        value: 'KEEP',
        label: 'Keep tasks attached',
        hint: 'Leave incomplete tasks on this sprint for reporting.',
    },
    {
        value: 'PUSH_TO_NEXT',
        label: 'Move to next planning sprint',
        hint: 'Re-home incomplete tasks to the next planned sprint for this team.',
    },
    {
        value: 'BACK_TO_BACKLOG',
        label: 'Detach incomplete tasks',
        hint: 'Drop planning membership; project sprints are untouched.',
    },
];

function CloseSprintDialog({ sprintId, open, onOpenChange, onClosed }) {
    const [strategy, setStrategy] = useState('KEEP');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (open) setStrategy('KEEP');
    }, [open]);

    const close = async () => {
        try {
            setSaving(true);
            const res = await api.post(`/planning-sprints/${sprintId}/close`, {
                strategy,
            });
            toast.success('Planning sprint closed.');
            onClosed?.(res.data.planningSprint);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not close sprint.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[460px]">
                <DialogHeader>
                    <DialogTitle>Close planning sprint</DialogTitle>
                    <DialogDescription>
                        Choose what happens to tasks that aren&apos;t done yet.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                    {CLOSE_STRATEGIES.map((s) => (
                        <button
                            type="button"
                            key={s.value}
                            onClick={() => setStrategy(s.value)}
                            className={cn(
                                'flex w-full flex-col gap-0.5 rounded-lg border p-3 text-left transition',
                                strategy === s.value
                                    ? 'border-primary bg-primary/5'
                                    : 'hover:bg-muted/50',
                            )}
                        >
                            <span className="text-sm font-medium">
                                {s.label}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {s.hint}
                            </span>
                        </button>
                    ))}
                </div>
                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button onClick={close} disabled={saving}>
                        {saving ? 'Closing...' : 'Close sprint'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function ScheduleDialog({
    open,
    onOpenChange,
    initialTeamKey = ORG_WIDE,
    teams,
    onChanged,
}) {
    const [teamKey, setTeamKey] = useState(initialTeamKey);
    const [enabled, setEnabled] = useState(true);
    const [cadence, setCadence] = useState('DAILY');
    const [anchorDate, setAnchorDate] = useState(() =>
        new Date().toISOString().slice(0, 10),
    );
    const [namePattern, setNamePattern] = useState('Planning {start}');
    const [goal, setGoal] = useState('');
    const [lookahead, setLookahead] = useState(2);
    const [preview, setPreview] = useState([]);
    const [hasSchedule, setHasSchedule] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    const teamParam = teamKey === ORG_WIDE ? '' : teamKey;

    const loadSchedule = useCallback(async () => {
        try {
            setLoading(true);
            const res = await api.get('/planning-sprints/schedule', {
                params: teamParam ? { teamId: teamParam } : {},
            });
            const s = res.data.schedule;
            if (s) {
                setHasSchedule(true);
                setEnabled(s.enabled);
                setCadence(s.cadence);
                setAnchorDate(toDateInput(s.anchorDate));
                setNamePattern(s.namePattern || 'Planning {start}');
                setGoal(s.goal || '');
                setLookahead(s.lookahead || 2);
                setPreview(res.data.preview || []);
            } else {
                setHasSchedule(false);
                setEnabled(true);
                setCadence('DAILY');
                setAnchorDate(new Date().toISOString().slice(0, 10));
                setNamePattern('Planning {start}');
                setGoal('');
                setLookahead(2);
                setPreview([]);
            }
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not load schedule.');
        } finally {
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [teamParam]);

    useEffect(() => {
        if (open) {
            setTeamKey(initialTeamKey);
            loadSchedule();
        }
    }, [open, initialTeamKey, loadSchedule]);

    const save = async () => {
        if (!anchorDate) return toast.error('Pick an anchor date.');
        try {
            setSaving(true);
            await api.put('/planning-sprints/schedule', {
                teamId: teamParam || null,
                cadence,
                enabled,
                anchorDate: new Date(anchorDate).toISOString(),
                namePattern: namePattern.trim() || undefined,
                goal: goal.trim() || null,
                lookahead: Number(lookahead) || 2,
            });
            toast.success('Schedule saved.');
            await loadSchedule();
            onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save schedule.');
        } finally {
            setSaving(false);
        }
    };

    const runNow = async () => {
        try {
            setSaving(true);
            const res = await api.post(
                '/planning-sprints/schedule/run',
                null,
                { params: teamParam ? { teamId: teamParam } : {} },
            );
            const n = (res.data.created || []).length;
            toast.success(
                n ? `Generated ${n} planning sprint${n === 1 ? '' : 's'}.` : 'Already up to date.',
            );
            await loadSchedule();
            onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not run schedule.');
        } finally {
            setSaving(false);
        }
    };

    const removeSchedule = async () => {
        const withPlanned = window.confirm(
            'Delete this schedule.\n\nClick OK to ALSO delete its upcoming auto-generated (planned) sprints, or Cancel to keep them and only stop future generation.',
        );
        try {
            setSaving(true);
            await api.delete('/planning-sprints/schedule', {
                params: {
                    ...(teamParam ? { teamId: teamParam } : {}),
                    withPlanned: withPlanned ? 'true' : 'false',
                },
            });
            toast.success('Schedule removed.');
            await loadSchedule();
            onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not remove schedule.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[540px]">
                <DialogHeader>
                    <DialogTitle>Planning sprint scheduler</DialogTitle>
                    <DialogDescription>
                        Auto-generate recurring planning sprints for a team (or
                        the whole org). Great for daily stand-up planning.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="space-y-1.5">
                        <Label>Schedule for</Label>
                        <Select value={teamKey} onValueChange={setTeamKey}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ORG_WIDE}>
                                    Org-wide (no team)
                                </SelectItem>
                                {teams.map((t) => (
                                    <SelectItem key={t.id} value={t.id}>
                                        {t.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    {loading ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">
                            Loading...
                        </p>
                    ) : (
                        <>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div className="space-y-1.5">
                                    <Label>Cadence</Label>
                                    <Select
                                        value={cadence}
                                        onValueChange={setCadence}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {CADENCES.map((c) => (
                                                <SelectItem
                                                    key={c.value}
                                                    value={c.value}
                                                >
                                                    {c.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="sched-anchor">
                                        Anchor date
                                    </Label>
                                    <Input
                                        id="sched-anchor"
                                        type="date"
                                        value={anchorDate}
                                        onChange={(e) =>
                                            setAnchorDate(e.target.value)
                                        }
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div className="space-y-1.5">
                                    <Label htmlFor="sched-name">
                                        Name pattern
                                    </Label>
                                    <Input
                                        id="sched-name"
                                        value={namePattern}
                                        onChange={(e) =>
                                            setNamePattern(e.target.value)
                                        }
                                        placeholder="Planning {start}"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="sched-lookahead">
                                        Keep ahead
                                    </Label>
                                    <Input
                                        id="sched-lookahead"
                                        type="number"
                                        min={1}
                                        max={10}
                                        value={lookahead}
                                        onChange={(e) =>
                                            setLookahead(e.target.value)
                                        }
                                    />
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <Label htmlFor="sched-goal">
                                    Default goal (optional)
                                </Label>
                                <Input
                                    id="sched-goal"
                                    value={goal}
                                    onChange={(e) => setGoal(e.target.value)}
                                    placeholder="Stamped on every generated sprint"
                                />
                            </div>

                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    checked={enabled}
                                    onChange={(e) =>
                                        setEnabled(e.target.checked)
                                    }
                                    className="h-4 w-4 rounded border-muted-foreground/40"
                                />
                                Enabled (auto-generate in the background)
                            </label>

                            <p className="text-xs text-muted-foreground">
                                Tokens: <code>{'{start}'}</code>,{' '}
                                <code>{'{end}'}</code>, <code>{'{n}'}</code>,{' '}
                                <code>{'{month}'}</code>, <code>{'{year}'}</code>
                            </p>

                            {preview.length > 0 && (
                                <div className="rounded-lg border bg-muted/30 p-3">
                                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                                        Next up
                                    </p>
                                    <ul className="space-y-1 text-sm">
                                        {preview.map((p, i) => (
                                            <li
                                                key={i}
                                                className="flex items-center justify-between gap-2"
                                            >
                                                <span className="truncate">
                                                    {p.name}
                                                </span>
                                                <span className="shrink-0 text-xs text-muted-foreground">
                                                    {fmtDate(p.startDate)} –{' '}
                                                    {fmtDate(p.endDate)}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </>
                    )}
                </div>

                <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
                    <div className="flex gap-2">
                        {hasSchedule && (
                            <>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={runNow}
                                    disabled={saving}
                                >
                                    <Play className="mr-1.5 h-4 w-4" /> Generate
                                    now
                                </Button>
                                <Button
                                    type="button"
                                    variant="destructive"
                                    size="sm"
                                    onClick={removeSchedule}
                                    disabled={saving}
                                >
                                    <Trash2 className="mr-1.5 h-4 w-4" /> Delete
                                    schedule
                                </Button>
                            </>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            Close
                        </Button>
                        <Button onClick={save} disabled={saving || loading}>
                            {saving ? 'Saving...' : 'Save schedule'}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
