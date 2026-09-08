// SprintsPanel — the entire Sprints / iterations UI for a single
// project. Lives inside ProjectDetail as the "Sprints" tab.
//
// Three subviews, switched by the inner segmented control at the top:
//
//   1. list       — Planned / Active / Closed sprint cards. The
//                   default view; lets users plan new sprints, edit
//                   metadata, start a planned sprint, jump to the
//                   active board, or open a closed sprint's burndown.
//   2. board      — Kanban for the selected sprint. Active sprints
//                   show Backlog + one column per task status (To do,
//                   In progress, Done); drag between columns updates
//                   status. Planned / closed sprints keep the simpler
//                   Backlog vs sprint split.
//   3. burndown   — Line chart for a selected sprint (defaults to
//                   active). Plots the ideal line + actual remaining
//                   hours from SprintSnapshot rows plus today's live
//                   point.
//
// All write actions are gated by the sprint:* capabilities (managed
// by an admin via Users → Edit profile). The panel reads
// `currentUser.role` + capability set off the auth context to know
// which buttons to render — the backend enforces them too, so a
// missing button isn't load-bearing for security.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
    AlarmClock,
    ArrowRight,
    Bug,
    CalendarRange,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    CirclePlay,
    Clock,
    Flag,
    LayoutList,
    LineChart,
    ListChecks,
    Pencil,
    Play,
    Plus,
    Repeat,
    Settings2,
    Sparkles,
    Star,
    Stethoscope,
    Trash2,
    Undo2,
    Zap,
} from 'lucide-react';
import { format, isValid, parseISO } from 'date-fns';

import { api } from '@/lib/api';
import { TASK_STATUSES } from '@/lib/constants';

// Board column order: On hold directly after Backlog, then the normal
// To do → In progress → Done flow.
const SPRINT_BOARD_STATUSES = [
    ...TASK_STATUSES.filter((s) => s.value === 'ON_HOLD'),
    ...TASK_STATUSES.filter((s) => s.value !== 'ON_HOLD'),
];
import { formatDuration, formatHoursAsHM } from '@/lib/time';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { CAPABILITIES } from '@/lib/capabilities';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tip } from '@/components/Tip';
import { PinButton } from '@/components/PinButton';
import { usePins } from '@/hooks/usePins';

// ---- helpers --------------------------------------------------------------

// Effective-capability check. Mirrors the layered model on the backend:
// admins always pass, then we accept either a role default or a per-user
// override. Hardcoding the (small) MANAGER default list here keeps the
// frontend free of an extra round-trip just to compute "can I see this
// button". The backend re-checks anyway.
const MANAGER_DEFAULTS = new Set([
    CAPABILITIES.SPRINT_CREATE,
    CAPABILITIES.SPRINT_EDIT,
    CAPABILITIES.SPRINT_DELETE,
    CAPABILITIES.SPRINT_START,
    CAPABILITIES.SPRINT_CLOSE,
    CAPABILITIES.SPRINT_ASSIGN_TASK,
]);

function hasCap(user, cap) {
    if (!user) return false;
    if (user.role === 'ADMIN') return true;
    if (user.role === 'MANAGER' && MANAGER_DEFAULTS.has(cap)) return true;
    return Array.isArray(user.capabilities)
        ? user.capabilities.includes(cap)
        : false;
}

function formatDay(d) {
    if (!d) return '—';
    const parsed = typeof d === 'string' ? parseISO(d) : new Date(d);
    if (!isValid(parsed)) return '—';
    return format(parsed, 'MMM d, yyyy');
}

function pct(num, denom) {
    if (!denom) return 0;
    return Math.max(0, Math.min(100, Math.round((num / denom) * 100)));
}

// Convert a JS Date to the YYYY-MM-DD string an <input type="date"> expects.
function toDateInput(value) {
    if (!value) return '';
    const d = typeof value === 'string' ? parseISO(value) : new Date(value);
    if (!isValid(d)) return '';
    return format(d, 'yyyy-MM-dd');
}

const STATUS_META = {
    PLANNED: {
        label: 'Planned',
        chip: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
        dot: 'bg-sky-500',
    },
    ACTIVE: {
        label: 'Active',
        chip: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        dot: 'bg-emerald-500',
    },
    CLOSED: {
        label: 'Closed',
        chip: 'bg-muted text-foreground/70',
        dot: 'bg-muted-foreground/60',
    },
};

// ---- main panel -----------------------------------------------------------

export default function SprintsPanel({
    projectId,
    projectName,
    tasks: projectTasks = [],
    users: projectUsers = [],
    onTasksChanged,
}) {
    const { user } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();

    const [sprints, setSprints] = useState([]);
    // The project's auto-generation schedule (or null when not set up).
    // Returned inline by GET /api/sprints?projectId so we don't pay a
    // second roundtrip on every panel mount.
    const [schedule, setSchedule] = useState(null);
    const [loading, setLoading] = useState(true);
    const [view, setView] = useState('list');
    const [activeSprintDetail, setActiveSprintDetail] = useState(null);
    const [focusSprintId, setFocusSprintId] = useState(
        searchParams.get('sprint') || null,
    );
    // Which sprint the Board view is showing. Defaults to the ACTIVE
    // sprint when one exists (the historical behaviour); the user can
    // pick any sprint regardless of status from the picker on the
    // board header. Stored as the sprint id so it survives reloads
    // through the URL and is decoupled from the actual sprint object
    // (which gets a fresh identity after every `load()`).
    const [boardSprintId, setBoardSprintId] = useState(
        searchParams.get('board') || null,
    );
    // Personal "starred sprint goals" — one fetch per panel mount,
    // shared across every SprintCard so the per-card toggle is
    // instant. Backed by the shared UserPin table (kind=SPRINT_GOAL).
    const sprintPinHook = usePins('SPRINT_GOAL');
    // Same pattern for "today's focus" task highlights — surfaced
    // as a fuchsia stripe + Highlighter button on every TaskChip on
    // the sprint board.
    const focusPinHook = usePins('TASK_FOCUS');

    // Dialog state
    const [createOpen, setCreateOpen] = useState(false);
    const [editTarget, setEditTarget] = useState(null);
    const [capacityTarget, setCapacityTarget] = useState(null);
    const [closeTarget, setCloseTarget] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(null);
    const [scheduleOpen, setScheduleOpen] = useState(false);

    const isAdmin = user?.role === 'ADMIN';
    const canCreate = hasCap(user, CAPABILITIES.SPRINT_CREATE);
    const canEdit = hasCap(user, CAPABILITIES.SPRINT_EDIT);
    const canDelete = hasCap(user, CAPABILITIES.SPRINT_DELETE);
    const canStart = hasCap(user, CAPABILITIES.SPRINT_START);
    const canClose = hasCap(user, CAPABILITIES.SPRINT_CLOSE);
    const canAssignTasks =
        canEdit || hasCap(user, CAPABILITIES.SPRINT_ASSIGN_TASK);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const { data } = await api.get('/sprints', {
                params: { projectId },
            });
            setSprints(data.sprints || []);
            setSchedule(data.schedule || null);
        } catch (err) {
            toast.error(
                err?.response?.data?.message || 'Failed to load sprints',
            );
        } finally {
            setLoading(false);
        }
    }, [projectId]);

    useEffect(() => {
        load();
    }, [load]);

    // The backend returns sprints sorted by `startDate DESC`, which is
    // what we want for CLOSED (latest finished first → recent history
    // at the top of the column). For PLANNED that order reads
    // backwards — the user picks "the next thing on the runway" most
    // of the time, so we flip planned to chronological ASC: the
    // soonest-upcoming sprint sits at the top of the column, the
    // one after below it, and so on.
    const planned = sprints
        .filter((s) => s.status === 'PLANNED')
        .slice()
        .sort(
            (a, b) =>
                new Date(a.startDate).getTime() -
                new Date(b.startDate).getTime(),
        );
    const active = sprints.filter((s) => s.status === 'ACTIVE');
    const closed = sprints.filter((s) => s.status === 'CLOSED');
    const activeSprint = active[0] || null;

    // Resolve which sprint the Board view should render. Preference
    // order: explicit user pick (boardSprintId) → active sprint →
    // most recent closed sprint → latest planned. The board is
    // useful for ALL sprint statuses (planned: add tasks; active:
    // work in progress; closed: post-mortem read-only view), so we
    // never disable it just because there's no ACTIVE sprint.
    const boardSprint = useMemo(() => {
        if (boardSprintId) {
            const picked = sprints.find((s) => s.id === boardSprintId);
            if (picked) return picked;
        }
        if (activeSprint) return activeSprint;
        if (closed.length > 0) return closed[closed.length - 1];
        if (planned.length > 0) return planned[0];
        return null;
    }, [boardSprintId, sprints, activeSprint, closed, planned]);

    // Hydrate the board sprint detail (tasks + capacity) whenever we
    // know which sprint to render and we're on a view that needs it.
    useEffect(() => {
        if (!boardSprint) {
            setActiveSprintDetail(null);
            return;
        }
        if (view !== 'board' && view !== 'burndown') {
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const { data } = await api.get(`/sprints/${boardSprint.id}`);
                if (!cancelled) setActiveSprintDetail(data.sprint);
            } catch (err) {
                if (!cancelled) {
                    toast.error(
                        err?.response?.data?.message ||
                            'Failed to load sprint',
                    );
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [boardSprint, view, sprints]);

    // Persist subview + selected board sprint in the URL so deep-links
    // work both from the audit feed and from a refreshed tab. We only
    // serialise `board` when the user has explicitly picked one — if
    // they're on the default (active sprint), the URL stays clean.
    useEffect(() => {
        const next = new URLSearchParams(searchParams);
        if (view !== 'list') next.set('view', view);
        else next.delete('view');
        if (boardSprintId && view === 'board') {
            next.set('board', boardSprintId);
        } else {
            next.delete('board');
        }
        if (next.toString() !== searchParams.toString()) {
            setSearchParams(next, { replace: true });
        }
    }, [view, boardSprintId, searchParams, setSearchParams]);

    // Initial view restoration from URL (?view=board, etc).
    useEffect(() => {
        const v = searchParams.get('view');
        if (v && (v === 'list' || v === 'board' || v === 'burndown')) {
            setView(v);
        }
        // Intentionally only on mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleCreate = async (data) => {
        try {
            const { data: resp } = await api.post('/sprints', {
                projectId,
                ...data,
            });
            toast.success(`Sprint "${resp.sprint.name}" created`);
            setCreateOpen(false);
            await load();
        } catch (err) {
            toast.error(
                err?.response?.data?.message || 'Failed to create sprint',
            );
        }
    };

    const handleEdit = async (sprint, data) => {
        try {
            await api.patch(`/sprints/${sprint.id}`, data);
            toast.success('Sprint updated');
            setEditTarget(null);
            await load();
        } catch (err) {
            toast.error(
                err?.response?.data?.message || 'Failed to update sprint',
            );
        }
    };

    const handleStart = async (sprint) => {
        try {
            await api.post(`/sprints/${sprint.id}/start`);
            toast.success(`Sprint "${sprint.name}" is now active`);
            await load();
            setView('board');
        } catch (err) {
            toast.error(
                err?.response?.data?.message || 'Failed to start sprint',
            );
        }
    };

    const handleReopen = async (sprint) => {
        try {
            await api.post(`/sprints/${sprint.id}/reopen`);
            toast.success(`Sprint "${sprint.name}" reopened`);
            await load();
        } catch (err) {
            toast.error(
                err?.response?.data?.message || 'Failed to reopen sprint',
            );
        }
    };

    const handleClose = async (sprint, strategy) => {
        try {
            const { data } = await api.post(`/sprints/${sprint.id}/close`, {
                strategy,
            });
            const moved = data?.movedTaskCount || 0;
            const where =
                strategy === 'PUSH_TO_NEXT' && data?.movedTo
                    ? `Moved ${moved} task(s) to "${data.movedTo.name}".`
                    : strategy === 'BACK_TO_BACKLOG'
                        ? `Moved ${moved} task(s) back to backlog.`
                        : '';
            toast.success(
                `Sprint closed. ${where}`.trim() || 'Sprint closed.',
            );
            setCloseTarget(null);
            await load();
            setView('list');
        } catch (err) {
            toast.error(
                err?.response?.data?.message || 'Failed to close sprint',
            );
        }
    };

    const handleDelete = async (sprint) => {
        try {
            await api.delete(`/sprints/${sprint.id}`);
            toast.success('Sprint deleted');
            setConfirmDelete(null);
            await load();
        } catch (err) {
            toast.error(
                err?.response?.data?.message || 'Failed to delete sprint',
            );
        }
    };

    // -- scheduler handlers ----------------------------------------------
    // PUT /sprints/schedule upserts the project's schedule. The backend
    // triggers a materialize run synchronously, so a successful save
    // already produces the next batch of PLANNED sprints — we reload
    // immediately to show them. Disabling via the same endpoint
    // preserves the config (so the user can re-enable later); the
    // dedicated "Remove" path uses DELETE.
    const handleSaveSchedule = async (payload) => {
        try {
            await api.put('/sprints/schedule', { projectId, ...payload });
            toast.success(
                payload.enabled
                    ? 'Schedule saved — generating upcoming sprints…'
                    : 'Schedule saved (paused)',
            );
            setScheduleOpen(false);
            await load();
        } catch (err) {
            toast.error(
                err?.response?.data?.message || 'Failed to save schedule',
            );
        }
    };

    // Removes the schedule config. If `withPlanned` is true, also
    // cascade-deletes every PLANNED sprint for the project (used by
    // the ScheduleBanner's "Delete schedule" ribbon button — that
    // flow is "wipe the auto-generation state completely"). The
    // dialog's own "Remove schedule" button calls this without the
    // flag so it keeps the legacy semantics (config only, planned
    // sprints intact).
    const handleRemoveSchedule = async ({ withPlanned = false } = {}) => {
        try {
            const { data } = await api.delete('/sprints/schedule', {
                params: {
                    projectId,
                    ...(withPlanned ? { withPlanned: true } : {}),
                },
            });
            const planned = data?.plannedDeleted || 0;
            const detached = data?.tasksDetached || 0;
            if (withPlanned && planned > 0) {
                toast.success(
                    `Schedule deleted · ${planned} planned sprint${planned === 1 ? '' : 's'} removed` +
                        (detached
                            ? ` · ${detached} task${detached === 1 ? '' : 's'} sent back to backlog`
                            : ''),
                );
            } else if (withPlanned) {
                toast.success('Schedule deleted (no planned sprints found)');
            } else {
                toast.success('Schedule removed');
            }
            setScheduleOpen(false);
            await load();
        } catch (err) {
            toast.error(
                err?.response?.data?.message || 'Failed to remove schedule',
            );
        }
    };

    // Manual "Generate next" — useful while testing or when you want
    // the sprints immediately and don't want to wait for the hourly
    // background sweep. Bound to the schedule banner.
    const handleRunScheduleNow = async () => {
        try {
            const { data } = await api.post(
                '/sprints/schedule/run',
                null,
                { params: { projectId } },
            );
            const n = data?.created?.length || 0;
            toast.success(
                n > 0
                    ? `Generated ${n} sprint${n === 1 ? '' : 's'}`
                    : 'Schedule is already up to date',
            );
            await load();
        } catch (err) {
            toast.error(
                err?.response?.data?.message || 'Failed to generate sprints',
            );
        }
    };

    const handleAddTask = async (taskId) => {
        // Adds always target whichever sprint the board is currently
        // showing — that's the only sprint the user can actually
        // interact with on this view. CLOSED sprints are read-only
        // (the board hides backlog/add UI for them) so this is safe.
        // Accepts top-level task ids or subtask ids (backend attaches
        // the parent when a subtask is passed).
        if (!boardSprint) return;
        try {
            await api.post(`/sprints/${boardSprint.id}/tasks`, {
                taskIds: [taskId],
            });
            await load();
            const { data } = await api.get(`/sprints/${boardSprint.id}`);
            setActiveSprintDetail(data.sprint);
            onTasksChanged?.();
        } catch (err) {
            toast.error(
                err?.response?.data?.error ||
                    err?.response?.data?.message ||
                    'Failed to add task to sprint',
            );
        }
    };

    const handleCreateSubtask = async (parentTask) => {
        if (!boardSprint) return;
        const title = window.prompt('Subtask title');
        if (!title?.trim()) return;
        const full = projectTasks.find((t) => t.id === parentTask.id);
        try {
            await api.post('/tasks', {
                projectId,
                parentTaskId: parentTask.id,
                title: title.trim(),
                phaseId: full?.phaseId ?? null,
            });
            toast.success('Subtask added.');
            await load();
            const { data } = await api.get(`/sprints/${boardSprint.id}`);
            setActiveSprintDetail(data.sprint);
            onTasksChanged?.();
        } catch (err) {
            toast.error(
                err?.response?.data?.error ||
                    err?.response?.data?.message ||
                    'Failed to add subtask',
            );
        }
    };

    const handleRemoveTask = async (taskId) => {
        if (!boardSprint) return;
        try {
            await api.delete(
                `/sprints/${boardSprint.id}/tasks/${taskId}`,
            );
            await load();
            const { data } = await api.get(`/sprints/${boardSprint.id}`);
            setActiveSprintDetail(data.sprint);
            onTasksChanged?.();
        } catch (err) {
            toast.error(
                err?.response?.data?.message ||
                    'Failed to remove task from sprint',
            );
        }
    };

    const handleTaskStatusChange = async (taskId, status) => {
        if (!boardSprint) return;
        try {
            await api.patch(`/tasks/${taskId}`, { status });
            await load();
            const { data } = await api.get(`/sprints/${boardSprint.id}`);
            setActiveSprintDetail(data.sprint);
            onTasksChanged?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    err.response?.data?.message ||
                    'Failed to update task status',
            );
        }
    };

    const handleSaveCapacity = async (sprint, entries) => {
        try {
            const { data } = await api.put(
                `/sprints/${sprint.id}/capacity`,
                { entries },
            );
            toast.success('Capacity saved');
            setCapacityTarget(null);
            if (activeSprintDetail?.id === sprint.id) {
                setActiveSprintDetail({
                    ...activeSprintDetail,
                    capacity: data.capacity,
                });
            }
        } catch (err) {
            toast.error(
                err?.response?.data?.message || 'Failed to save capacity',
            );
        }
    };

    // -- render ----------------------------------------------------------

    if (loading) {
        return (
            <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
                Loading sprints…
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Subview switcher + actions */}
            <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-lg border bg-card p-1">
                    <ViewButton
                        active={view === 'list'}
                        icon={LayoutList}
                        label="List"
                        onClick={() => setView('list')}
                    />
                    <ViewButton
                        active={view === 'board'}
                        icon={ListChecks}
                        label="Board"
                        onClick={() => setView('board')}
                        disabled={!boardSprint}
                        disabledHint="No sprint to show yet"
                    />
                    <ViewButton
                        active={view === 'burndown'}
                        icon={LineChart}
                        label="Burndown"
                        onClick={() => setView('burndown')}
                        disabled={!activeSprint && closed.length === 0}
                        disabledHint="No sprint to chart yet"
                    />
                </div>
                <div className="ml-auto flex items-center gap-2">
                    {activeSprint && (
                        <span className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs text-muted-foreground">
                            <CirclePlay className="h-3.5 w-3.5 text-emerald-600" />
                            Active: <strong className="text-foreground">{activeSprint.name}</strong>
                        </span>
                    )}
                    {canEdit && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setScheduleOpen(true)}
                            title="Auto-generate sprints on a cadence"
                        >
                            <Repeat className="mr-1.5 h-4 w-4" />
                            {schedule ? 'Schedule…' : 'Schedule'}
                            {schedule?.enabled && (
                                <span
                                    className="ml-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500"
                                    aria-hidden
                                />
                            )}
                        </Button>
                    )}
                    {/* canEdit is the same gate the backend enforces
                        for PUT /sprints/schedule. Without it the banner
                        would expose a non-functional "Edit" link. */}
                    {canCreate && (
                        <Button
                            size="sm"
                            onClick={() => setCreateOpen(true)}
                        >
                            <Plus className="mr-1.5 h-4 w-4" />
                            New sprint
                        </Button>
                    )}
                </div>
            </div>

            {/* List view */}
            {view === 'list' && (
                <SprintListView
                    planned={planned}
                    active={active}
                    closed={closed}
                    focusSprintId={focusSprintId}
                    canEdit={canEdit}
                    canDelete={canDelete}
                    canStart={canStart}
                    canClose={canClose}
                    isAdmin={isAdmin}
                    onEdit={(s) => setEditTarget(s)}
                    onStart={handleStart}
                    onReopen={handleReopen}
                    onClose={(s) => setCloseTarget(s)}
                    onDelete={(s) => setConfirmDelete(s)}
                    onCapacity={(s) => setCapacityTarget(s)}
                    onBoard={() => setView('board')}
                    onBurndown={() => setView('burndown')}
                    schedule={schedule}
                    onOpenSchedule={
                        canEdit ? () => setScheduleOpen(true) : null
                    }
                    onRunScheduleNow={
                        canCreate ? handleRunScheduleNow : null
                    }
                    onDeleteSchedule={
                        canEdit && canDelete ? handleRemoveSchedule : null
                    }
                    sprintPinHook={sprintPinHook}
                />
            )}

            {/* Board view */}
            {view === 'board' && boardSprint && (
                <SprintBoardView
                    activeSprint={boardSprint}
                    detail={activeSprintDetail}
                    allSprints={sprints}
                    selectedSprintId={boardSprint.id}
                    onSelectSprint={(id) => setBoardSprintId(id)}
                    projectTasks={projectTasks}
                    projectUsers={projectUsers}
                    canAssign={canAssignTasks}
                    canClose={canClose}
                    canEditCapacity={canEdit}
                    onAddTask={handleAddTask}
                    onCreateSubtask={handleCreateSubtask}
                    onRemoveTask={handleRemoveTask}
                    onTaskStatusChange={handleTaskStatusChange}
                    onOpenClose={() => setCloseTarget(boardSprint)}
                    onOpenCapacity={() => setCapacityTarget(boardSprint)}
                    focusPinHook={focusPinHook}
                />
            )}

            {/* Burndown view */}
            {view === 'burndown' && (
                <SprintBurndownView
                    projectId={projectId}
                    activeSprint={activeSprint}
                    closedSprints={closed}
                />
            )}

            {/* Dialogs */}
            <SprintFormDialog
                open={createOpen}
                onClose={() => setCreateOpen(false)}
                onSubmit={handleCreate}
                title="New sprint"
                projectName={projectName}
            />
            <SprintFormDialog
                open={!!editTarget}
                onClose={() => setEditTarget(null)}
                onSubmit={(data) => handleEdit(editTarget, data)}
                title="Edit sprint"
                projectName={projectName}
                initial={editTarget}
            />
            <CloseSprintDialog
                open={!!closeTarget}
                sprint={closeTarget}
                onClose={() => setCloseTarget(null)}
                onConfirm={(strategy) => handleClose(closeTarget, strategy)}
            />
            <CapacityDialog
                open={!!capacityTarget}
                sprint={capacityTarget}
                projectUsers={projectUsers}
                onClose={() => setCapacityTarget(null)}
                onSubmit={(entries) =>
                    handleSaveCapacity(capacityTarget, entries)
                }
            />
            <SprintScheduleDialog
                open={scheduleOpen}
                schedule={schedule}
                onClose={() => setScheduleOpen(false)}
                onSubmit={handleSaveSchedule}
                onRemove={schedule ? handleRemoveSchedule : null}
                projectId={projectId}
                plannedSprints={planned}
            />
            <Dialog
                open={!!confirmDelete}
                onOpenChange={(o) => !o && setConfirmDelete(null)}
            >
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Delete sprint?</DialogTitle>
                        <DialogDescription>
                            “{confirmDelete?.name}” will be removed.
                            Any tasks attached to it will drop back
                            into the backlog. This cannot be undone.
                            {confirmDelete?.status === 'ACTIVE' && (
                                <>
                                    {' '}
                                    <strong className="text-rose-600">
                                        This sprint is currently
                                        active.
                                    </strong>{' '}
                                    Deleting it will also remove its
                                    burndown history. If you want to
                                    keep the audit trail, close it
                                    instead.
                                </>
                            )}
                            {confirmDelete?.status === 'CLOSED' && (
                                <>
                                    {' '}
                                    <strong className="text-rose-600">
                                        Its burndown snapshots will be
                                        deleted too.
                                    </strong>
                                </>
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setConfirmDelete(null)}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={() => handleDelete(confirmDelete)}
                        >
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function ViewButton({ active, icon: Icon, label, onClick, disabled, disabledHint }) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            title={disabled ? disabledHint : undefined}
            className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                active
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground',
            )}
        >
            <Icon className="h-3.5 w-3.5" />
            {label}
        </button>
    );
}

// ---- list view -----------------------------------------------------------

function SprintListView({
    planned,
    active,
    closed,
    focusSprintId,
    canEdit,
    canDelete,
    canStart,
    canClose,
    isAdmin = false,
    onEdit,
    onStart,
    onReopen,
    onClose,
    onDelete,
    onCapacity,
    onBoard,
    onBurndown,
    schedule,
    onOpenSchedule,
    onRunScheduleNow,
    onDeleteSchedule,
    sprintPinHook,
}) {
    // Admins can hard-delete ANY sprint (planned / active / closed).
    // Non-admin holders of sprint:delete only get the button on
    // planned sprints — the backend enforces the same rule.
    const adminCanDelete = canDelete && isAdmin;
    const empty = planned.length + active.length + closed.length === 0;
    const banner = (
        <ScheduleBanner
            schedule={schedule}
            onOpen={onOpenSchedule}
            onRunNow={onRunScheduleNow}
            onDelete={onDeleteSchedule}
            plannedCount={planned.length}
        />
    );

    if (empty) {
        return (
            <div className="space-y-4">
                {banner}
                <Card>
                    <CardContent className="flex flex-col items-center gap-3 p-10 text-center text-sm text-muted-foreground">
                        <Zap className="h-8 w-8 text-muted-foreground/60" />
                        <p>
                            No sprints yet. Use “New sprint” to plan
                            your first iteration{schedule?.enabled ? ', or wait for the schedule to generate the next one' : ''}.
                        </p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {banner}
            <div className="grid gap-4 lg:grid-cols-3">
            <ColumnGroup
                title="Active"
                icon={CirclePlay}
                tone="text-emerald-600"
                items={active}
                focusSprintId={focusSprintId}
                sprintPinHook={sprintPinHook}
                renderActions={(s) => (
                    <>
                        <Button
                            size="sm"
                            variant="default"
                            onClick={onBoard}
                        >
                            Open board
                            <ChevronRight className="ml-1 h-4 w-4" />
                        </Button>
                        {canEdit && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => onCapacity(s)}
                            >
                                <Settings2 className="mr-1 h-4 w-4" />
                                Capacity
                            </Button>
                        )}
                        {canClose && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => onClose(s)}
                            >
                                <Flag className="mr-1 h-4 w-4" />
                                Close
                            </Button>
                        )}
                        {adminCanDelete && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => onDelete(s)}
                                className="text-rose-600 hover:text-rose-600"
                                title="Admin only — hard-delete this active sprint"
                            >
                                <Trash2 className="mr-1 h-4 w-4" />
                                Delete
                            </Button>
                        )}
                    </>
                )}
                emptyHint="No active sprint. Start a planned one to focus the team."
            />
            <ColumnGroup
                title="Planned"
                icon={CalendarRange}
                tone="text-sky-600"
                items={planned}
                focusSprintId={focusSprintId}
                sprintPinHook={sprintPinHook}
                renderActions={(s) => (
                    <>
                        {canStart && (
                            <Button
                                size="sm"
                                variant="default"
                                onClick={() => onStart(s)}
                            >
                                <CirclePlay className="mr-1 h-4 w-4" />
                                Start
                            </Button>
                        )}
                        {canEdit && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => onEdit(s)}
                            >
                                <Pencil className="mr-1 h-4 w-4" />
                                Edit
                            </Button>
                        )}
                        {canDelete && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => onDelete(s)}
                                className="text-rose-600 hover:text-rose-600"
                            >
                                <Trash2 className="mr-1 h-4 w-4" />
                                Delete
                            </Button>
                        )}
                    </>
                )}
                emptyHint="No upcoming sprints. Use “New sprint” to plan one."
            />
            <ColumnGroup
                title="Closed"
                icon={Flag}
                tone="text-amber-600"
                items={closed.slice(0, 10)}
                focusSprintId={focusSprintId}
                sprintPinHook={sprintPinHook}
                renderActions={(s) => (
                    <>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={onBurndown}
                        >
                            <LineChart className="mr-1 h-4 w-4" />
                            Burndown
                        </Button>
                        {canStart && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => onReopen(s)}
                            >
                                <Undo2 className="mr-1 h-4 w-4" />
                                Reopen
                            </Button>
                        )}
                        {adminCanDelete && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => onDelete(s)}
                                className="text-rose-600 hover:text-rose-600"
                                title="Admin only — hard-delete this closed sprint (removes its burndown history too)"
                            >
                                <Trash2 className="mr-1 h-4 w-4" />
                                Delete
                            </Button>
                        )}
                    </>
                )}
                emptyHint="No closed sprints yet."
                footerHint={closed.length > 10 ? `+${closed.length - 10} older` : null}
            />
            </div>
        </div>
    );
}

function ColumnGroup({
    title,
    icon: Icon,
    tone,
    items,
    focusSprintId,
    renderActions,
    emptyHint,
    footerHint,
    sprintPinHook,
}) {
    return (
        <Card className="flex flex-col">
            <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-2">
                <Icon className={cn('h-4 w-4', tone)} />
                <CardTitle className="text-sm font-semibold">
                    {title}
                </CardTitle>
                <span className="ml-auto rounded-full border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {items.length}
                </span>
            </CardHeader>
            <CardContent className="flex-1 space-y-2 pt-2">
                {items.length === 0 ? (
                    <p className="rounded border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                        {emptyHint}
                    </p>
                ) : (
                    items.map((s) => (
                        <SprintCard
                            key={s.id}
                            sprint={s}
                            highlighted={focusSprintId === s.id}
                            renderActions={renderActions}
                            sprintPinHook={sprintPinHook}
                        />
                    ))
                )}
                {footerHint && (
                    <p className="text-[11px] text-muted-foreground">
                        {footerHint}
                    </p>
                )}
            </CardContent>
        </Card>
    );
}

function SprintCard({ sprint, highlighted, renderActions, sprintPinHook }) {
    const meta = STATUS_META[sprint.status] || STATUS_META.PLANNED;
    const total = sprint.totalTasks || 0;
    const done = sprint.completedTasks || 0;
    const progress = pct(done, total);
    const starred = sprintPinHook?.isPinned
        ? sprintPinHook.isPinned(sprint.id)
        : false;
    return (
        <div
            className={cn(
                'rounded-lg border bg-background p-3 shadow-sm transition-colors',
                highlighted && 'ring-2 ring-primary',
                starred && !highlighted && 'border-amber-400/60',
            )}
        >
            <div className="flex items-start gap-2">
                <span
                    className={cn(
                        'mt-1 inline-block h-2 w-2 shrink-0 rounded-full',
                        meta.dot,
                    )}
                />
                <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {starred && (
                            <Star
                                className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500"
                                aria-label="Starred sprint goal"
                            />
                        )}
                        {sprint.name}
                    </p>
                    {sprint.goal && (
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                            {sprint.goal}
                        </p>
                    )}
                    <p className="mt-1 text-[11px] text-muted-foreground">
                        {formatDay(sprint.startDate)} → {formatDay(sprint.endDate)}
                    </p>
                </div>
                <div className="flex items-center gap-1">
                    {sprintPinHook && (
                        <PinButton
                            kind="SPRINT_GOAL"
                            refId={sprint.id}
                            variant="star"
                            size="xs"
                            pinHookOverride={sprintPinHook}
                            offLabel="Star this sprint goal"
                            onLabel="Unstar this sprint goal"
                        />
                    )}
                    <span
                        className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] font-medium',
                            meta.chip,
                        )}
                    >
                        {meta.label}
                    </span>
                </div>
            </div>
            <div className="mt-2 space-y-1">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                        {done}/{total} tasks done
                    </span>
                    <span>{progress}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                        className={cn(
                            'h-full rounded-full',
                            progress >= 100
                                ? 'bg-emerald-500'
                                : 'bg-primary',
                        )}
                        style={{ width: `${progress}%` }}
                    />
                </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
                {renderActions(sprint)}
            </div>
        </div>
    );
}

// ---- board view ----------------------------------------------------------

function SprintBoardView({
    activeSprint,
    detail,
    allSprints = [],
    selectedSprintId,
    onSelectSprint,
    projectTasks,
    projectUsers,
    canAssign,
    canClose,
    canEditCapacity,
    onAddTask,
    onCreateSubtask,
    onRemoveTask,
    onTaskStatusChange,
    onOpenClose,
    onOpenCapacity,
    focusPinHook,
}) {
    // CLOSED sprints are immutable: their tasks have been frozen
    // (closedTaskIds) and rewriting them would corrupt the snapshot
    // we lean on for burndown + post-mortem KPIs. Treat the board as
    // strictly read-only in that case — picker still works, drag /
    // add / remove / close all turn off.
    const isClosed = activeSprint?.status === 'CLOSED';
    const isActive = activeSprint?.status === 'ACTIVE';
    const writable = canAssign && !isClosed;

    // The "backlog" is every top-level task in the project that doesn't
    // already belong to a sprint. Nest each parent's subtasks so you can
    // add the whole family (or a single subtask — the API pulls the
    // parent into the sprint).
    const backlog = useMemo(() => {
        const subsByParent = new Map();
        for (const t of projectTasks) {
            if (!t.parentTaskId) continue;
            if (!subsByParent.has(t.parentTaskId)) {
                subsByParent.set(t.parentTaskId, []);
            }
            subsByParent.get(t.parentTaskId).push(t);
        }
        return projectTasks
            .filter((t) => !t.parentTaskId && !t.sprintId)
            .map((t) => ({
                ...t,
                subtasks: (subsByParent.get(t.id) || []).sort((a, b) =>
                    (a.title || '').localeCompare(b.title || ''),
                ),
            }))
            .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }, [projectTasks]);
    const sprintTasks = detail?.tasks || [];
    const counters = detail?.counters || {
        totalTasks: 0,
        completedTasks: 0,
        totalHours: 0,
        loggedHours: 0,
    };

    const tasksByStatus = useMemo(() => {
        const map = Object.fromEntries(
            TASK_STATUSES.map((s) => [s.value, []]),
        );
        for (const t of sprintTasks) {
            const key = map[t.status] ? t.status : 'TODO';
            map[key].push(t);
        }
        return map;
    }, [sprintTasks]);

    const statusAccent = {
        TODO: 'border-slate-400/40',
        IN_PROGRESS: 'border-amber-500/40',
        ON_HOLD: 'border-zinc-500/40',
        DONE: 'border-emerald-500/40',
    };

    // Picker shows every sprint, grouped by status. Active first
    // (most common pick), then planned (chronological), then closed
    // (reverse-chrono so the most-recent post-mortem is one click
    // from the top).
    const pickerOptions = useMemo(() => {
        const grp = { ACTIVE: [], PLANNED: [], CLOSED: [] };
        for (const s of allSprints) {
            if (grp[s.status]) grp[s.status].push(s);
        }
        grp.PLANNED.sort(
            (a, b) =>
                new Date(a.startDate).getTime() -
                new Date(b.startDate).getTime(),
        );
        grp.CLOSED.sort(
            (a, b) =>
                new Date(b.startDate).getTime() -
                new Date(a.startDate).getTime(),
        );
        return [...grp.ACTIVE, ...grp.PLANNED, ...grp.CLOSED];
    }, [allSprints]);

    const [dragOverCol, setDragOverCol] = useState(null);
    const onDragStart = (e, taskId, source, status = null) => {
        e.dataTransfer.setData(
            'text/plain',
            JSON.stringify({ taskId, source, status }),
        );
        e.dataTransfer.effectAllowed = 'move';
    };
    const onDragOver = (e, col) => {
        if (!writable) return;
        e.preventDefault();
        setDragOverCol(col);
    };
    const onDrop = async (e, col) => {
        if (!writable) return;
        e.preventDefault();
        setDragOverCol(null);
        try {
            const payload = JSON.parse(
                e.dataTransfer.getData('text/plain') || '{}',
            );
            if (!payload.taskId) return;

            if (col === 'backlog') {
                if (payload.source !== 'backlog') {
                    await onRemoveTask(payload.taskId);
                }
                return;
            }

            if (TASK_STATUSES.some((s) => s.value === col)) {
                if (payload.source === 'backlog') {
                    await onAddTask(payload.taskId);
                    if (col !== 'TODO') {
                        await onTaskStatusChange?.(payload.taskId, col);
                    }
                } else if (payload.status !== col) {
                    await onTaskStatusChange?.(payload.taskId, col);
                }
                return;
            }

            if (col === 'sprint' && payload.source !== 'sprint') {
                await onAddTask(payload.taskId);
            } else if (col === 'backlog' && payload.source !== 'backlog') {
                await onRemoveTask(payload.taskId);
            }
        } catch {
            // bad payload or failed request — ignore.
        }
    };

    return (
        <div className="space-y-3">
            {/* Header: sprint picker + summary + capacity heatmap */}
            <Card>
                <CardContent className="space-y-3 p-3">
                    {/* Sprint picker. Always visible (even when only
                        one sprint exists) so the affordance is
                        discoverable. */}
                    {pickerOptions.length > 0 && (
                        <div className="flex flex-wrap items-center gap-2">
                            <Label
                                htmlFor="board-sprint-picker"
                                className="text-xs text-muted-foreground"
                            >
                                Sprint
                            </Label>
                            <Select
                                value={selectedSprintId || ''}
                                onValueChange={(v) =>
                                    onSelectSprint && onSelectSprint(v)
                                }
                            >
                                <SelectTrigger
                                    id="board-sprint-picker"
                                    className="h-8 w-[280px] text-xs"
                                >
                                    <SelectValue placeholder="Pick a sprint" />
                                </SelectTrigger>
                                <SelectContent>
                                    {pickerOptions.map((s) => (
                                        <SelectItem
                                            key={s.id}
                                            value={s.id}
                                            className="text-xs"
                                        >
                                            <span className="inline-flex items-center gap-1.5">
                                                <span
                                                    className={cn(
                                                        'inline-flex h-1.5 w-1.5 rounded-full',
                                                        s.status === 'ACTIVE'
                                                            ? 'bg-emerald-500'
                                                            : s.status === 'PLANNED'
                                                                ? 'bg-sky-500'
                                                                : 'bg-muted-foreground',
                                                    )}
                                                />
                                                <span>{s.name}</span>
                                                <span className="text-muted-foreground">
                                                    · {s.status.toLowerCase()}
                                                </span>
                                            </span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {isClosed && (
                                <span className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                                    Read-only · sprint is closed
                                </span>
                            )}
                        </div>
                    )}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <p className="text-sm font-semibold">
                                {activeSprint.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {formatDay(activeSprint.startDate)} →{' '}
                                {formatDay(activeSprint.endDate)}
                                {activeSprint.goal && (
                                    <>
                                        {' • '}
                                        <span className="italic">{activeSprint.goal}</span>
                                    </>
                                )}
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            {canEditCapacity && !isClosed && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={onOpenCapacity}
                                >
                                    <Settings2 className="mr-1 h-4 w-4" />
                                    Capacity
                                </Button>
                            )}
                            {canClose && isActive && (
                                <Button
                                    size="sm"
                                    variant="default"
                                    onClick={onOpenClose}
                                >
                                    <Flag className="mr-1 h-4 w-4" />
                                    Close sprint
                                </Button>
                            )}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <Stat
                            label="Tasks"
                            value={`${counters.completedTasks}/${counters.totalTasks}`}
                            icon={ListChecks}
                        />
                        <Stat
                            label="Est. hours"
                            value={formatHoursAsHM(counters.totalHours)}
                            icon={Clock}
                        />
                        <Stat
                            label="Logged"
                            value={formatHoursAsHM(counters.loggedHours)}
                            icon={Sparkles}
                        />
                        <Stat
                            label="Completion"
                            value={`${pct(counters.completedTasks, counters.totalTasks)}%`}
                            icon={CheckCircle2}
                        />
                    </div>

                    <CapacityHeatmap
                        capacity={detail?.capacity || []}
                        tasks={sprintTasks}
                        projectUsers={projectUsers}
                    />
                </CardContent>
            </Card>

            {/* Debug inspector: every time entry that contributes to
                the Logged KPI above. The sum here should match the
                KPI exactly — if they ever disagree, that's a bug in
                serializeSprintDetail's roll-up. */}
            <SprintLoggedInspector
                sprintId={activeSprint.id}
                expectedHours={counters.loggedHours}
            />

            {/* Sprint board — active sprints use Jira-style status columns;
                planned / closed keep the backlog + sprint split. */}
            {isActive ? (
                <div className="grid items-start gap-3 lg:grid-cols-4">
                    <BoardColumn
                        title="Backlog"
                        description="Project tasks not in any sprint"
                        items={backlog}
                        dragOver={dragOverCol === 'backlog'}
                        onDragOver={(e) => onDragOver(e, 'backlog')}
                        onDragLeave={() => setDragOverCol(null)}
                        onDrop={(e) => onDrop(e, 'backlog')}
                        renderItem={(t) => (
                            <TaskChip
                                key={t.id}
                                task={t}
                                draggable={writable}
                                onDragStart={(e) =>
                                    onDragStart(e, t.id, 'backlog')
                                }
                                actionIcon={writable ? Plus : null}
                                actionLabel="Add to sprint"
                                onAction={
                                    writable ? () => onAddTask(t.id) : null
                                }
                                onAddSubtask={
                                    writable ? onAddTask : null
                                }
                                focusPinHook={focusPinHook}
                            />
                        )}
                        emptyText="Backlog is empty. Add tasks under the Plan tab to populate it."
                    />
                    {SPRINT_BOARD_STATUSES.map((s) => (
                        <BoardColumn
                            key={s.value}
                            title={s.label}
                            description={`Tasks ${s.label.toLowerCase()}`}
                            items={tasksByStatus[s.value] || []}
                            accentClass={statusAccent[s.value]}
                            dragOver={dragOverCol === s.value}
                            onDragOver={(e) => onDragOver(e, s.value)}
                            onDragLeave={() => setDragOverCol(null)}
                            onDrop={(e) => onDrop(e, s.value)}
                            renderItem={(t) => (
                                <TaskChip
                                    key={t.id}
                                    task={t}
                                    draggable={writable}
                                    onDragStart={(e) =>
                                        onDragStart(
                                            e,
                                            t.id,
                                            'status',
                                            t.status,
                                        )
                                    }
                                    actionIcon={writable ? Undo2 : null}
                                    actionLabel="Send to backlog"
                                    onAction={
                                        writable
                                            ? () => onRemoveTask(t.id)
                                            : null
                                    }
                                    onCreateSubtask={
                                        writable ? onCreateSubtask : null
                                    }
                                    focusPinHook={focusPinHook}
                                />
                            )}
                            emptyText={
                                writable
                                    ? 'Drag tasks here or from the backlog.'
                                    : 'No tasks in this column.'
                            }
                        />
                    ))}
                </div>
            ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                    <BoardColumn
                        title="Backlog"
                        description="Project tasks not in any sprint"
                        items={backlog}
                        dragOver={dragOverCol === 'backlog'}
                        onDragOver={(e) => onDragOver(e, 'backlog')}
                        onDragLeave={() => setDragOverCol(null)}
                        onDrop={(e) => onDrop(e, 'backlog')}
                        renderItem={(t) => (
                            <TaskChip
                                key={t.id}
                                task={t}
                                draggable={writable}
                                onDragStart={(e) =>
                                    onDragStart(e, t.id, 'backlog')
                                }
                                actionIcon={writable ? Plus : null}
                                actionLabel="Add to sprint"
                                onAction={
                                    writable ? () => onAddTask(t.id) : null
                                }
                                onAddSubtask={
                                    writable ? onAddTask : null
                                }
                                focusPinHook={focusPinHook}
                            />
                        )}
                        emptyText="Backlog is empty. Add tasks under the Plan tab to populate it."
                    />
                    <BoardColumn
                        title={`${activeSprint.name}`}
                        description={
                            isClosed
                                ? 'Tasks captured when this sprint was closed'
                                : 'Tasks committed to this sprint'
                        }
                        items={sprintTasks}
                        accentClass={
                            isClosed
                                ? 'border-muted-foreground/40'
                                : 'border-emerald-500/40'
                        }
                        dragOver={dragOverCol === 'sprint'}
                        onDragOver={(e) => onDragOver(e, 'sprint')}
                        onDragLeave={() => setDragOverCol(null)}
                        onDrop={(e) => onDrop(e, 'sprint')}
                        renderItem={(t) => (
                            <TaskChip
                                key={t.id}
                                task={t}
                                draggable={writable}
                                onDragStart={(e) =>
                                    onDragStart(e, t.id, 'sprint')
                                }
                                actionIcon={writable ? Undo2 : null}
                                actionLabel="Send to backlog"
                                onAction={
                                    writable ? () => onRemoveTask(t.id) : null
                                }
                                onCreateSubtask={
                                    writable ? onCreateSubtask : null
                                }
                                focusPinHook={focusPinHook}
                            />
                        )}
                        emptyText={
                            writable
                                ? 'Drag tasks here from the backlog to commit them to the sprint.'
                                : 'No tasks in this sprint.'
                        }
                    />
                </div>
            )}
        </div>
    );
}

function Stat({ label, value, icon: Icon }) {
    return (
        <div className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {label}
                </p>
                <p className="text-sm font-medium tabular-nums">{value}</p>
            </div>
        </div>
    );
}

function CapacityHeatmap({ capacity, tasks, projectUsers }) {
    // Build per-user planned vs estimated load. "Planned" comes from
    // SprintCapacity rows. "Estimated load" is the sum of estimateHours
    // on tasks assigned to that user in the sprint.
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
    // Augment with any project user mentioned in capacity but missing
    // from the task list (so we render their avatar with the planned
    // hours bar even if they haven't been given a task yet).
    for (const [uid, val] of byUser) {
        if (!val.user) {
            const u = projectUsers.find((p) => p.id === uid);
            if (u) val.user = u;
        }
    }
    const rows = Array.from(byUser.values()).filter((r) => r.user);
    if (rows.length === 0) {
        return (
            <p className="rounded border border-dashed bg-muted/30 p-2 text-[11px] text-muted-foreground">
                No capacity set yet — use the Capacity button to plan how many hours each
                person is available to commit this sprint.
            </p>
        );
    }
    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                Capacity per assignee
                <Tip variant="help" side="top">
                    <p className="font-medium">How to read this row</p>
                    <ul className="ml-4 mt-1 list-disc space-y-0.5 text-muted-foreground">
                        <li>
                            <strong>Planned</strong> (filled bar) — the
                            hours you committed for this person via the
                            <em> Capacity</em> button.
                        </li>
                        <li>
                            <strong>Estimated</strong> (outlined bar) — the
                            sum of task estimateHours assigned to them.
                        </li>
                        <li>
                            <strong>Rose</strong> means estimated &gt;
                            planned (overload). <strong>Amber</strong>{' '}
                            means estimated &lt; 50% of planned (probably
                            need to add work). Otherwise green.
                        </li>
                    </ul>
                </Tip>
            </div>
            {rows.map(({ user, planned, estimated }) => {
                const max = Math.max(planned || 0, estimated || 0, 1);
                const plannedPct = pct(planned || 0, max);
                const estPct = pct(estimated || 0, max);
                const over =
                    planned > 0 && estimated > planned * 1.0;
                const under =
                    planned > 0 && estimated < planned * 0.5;
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
                                style={{ width: `${plannedPct}%` }}
                                title={`Planned: ${planned}h`}
                            />
                            <div
                                className={cn(
                                    'absolute left-0 top-0 h-full rounded-full',
                                    over
                                        ? 'bg-rose-500'
                                        : under
                                            ? 'bg-amber-500'
                                            : 'bg-emerald-500',
                                )}
                                style={{ width: `${estPct}%`, opacity: 0.85 }}
                                title={`Estimated load: ${estimated}h`}
                            />
                        </div>
                        <span className="tabular-nums text-muted-foreground">
                            {formatHoursAsHM(estimated)} /{' '}
                            {formatHoursAsHM(planned)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

// Debug inspector: lists every TimeEntry that contributes to the
// Logged KPI on the active sprint. The sum at the top should always
// match the KPI ("12h 30m") — if they ever disagree, that's a bug
// in serializeSprintDetail (or writeSprintSnapshot for the burndown
// numbers) and this panel is the easiest way to spot it. Collapsed
// by default, scrollable, no edit/delete so it never competes with
// the proper Time tracking surface.
function SprintLoggedInspector({ sprintId, expectedHours }) {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState(null);

    useEffect(() => {
        if (!open) return undefined;
        let cancelled = false;
        setLoading(true);
        api.get(`/sprints/${sprintId}/time-entries`)
            .then((res) => {
                if (cancelled) return;
                setData(res.data);
            })
            .catch((err) => {
                if (cancelled) return;
                console.warn(
                    '[sprint/inspector] failed to load entries:',
                    err?.message,
                );
                setData({ entries: [], total: { seconds: 0, hours: 0, count: 0 } });
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, sprintId]);

    const totalSeconds = data?.total?.seconds || 0;
    const totalHours = data?.total?.hours || 0;
    const count = data?.total?.count || 0;
    const mismatch =
        data &&
        typeof expectedHours === 'number' &&
        Math.abs(totalHours - expectedHours) > 0.01;

    return (
        <Card className="border-dashed">
            <CardHeader
                className="cursor-pointer pb-2"
                onClick={() => setOpen((v) => !v)}
            >
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <ChevronDown
                            className={cn(
                                'h-4 w-4 text-muted-foreground transition-transform',
                                !open && '-rotate-90',
                            )}
                        />
                        <Bug
                            className="h-4 w-4 text-rose-500"
                            aria-hidden
                        />
                        <CardTitle className="text-sm font-medium">
                            Logged time — breakdown
                        </CardTitle>
                        <span className="rounded-full border bg-rose-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-rose-700 dark:text-rose-300">
                            debug
                        </span>
                    </div>
                    {data && (
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="font-mono tabular-nums">
                                {formatHoursAsHM(totalHours)} · {count}{' '}
                                {count === 1 ? 'entry' : 'entries'}
                            </span>
                            {mismatch && (
                                <span
                                    className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-300"
                                    title={`KPI says ${formatHoursAsHM(expectedHours)}, inspector sums to ${formatHoursAsHM(totalHours)}`}
                                >
                                    mismatch
                                </span>
                            )}
                        </div>
                    )}
                </div>
                {!open && (
                    <p className="ml-6 text-[11px] text-muted-foreground">
                        Click to expand the list of every entry that adds
                        up to the <em>Logged</em> KPI above.
                    </p>
                )}
            </CardHeader>
            {open && (
                <CardContent className="pt-0">
                    {loading ? (
                        <p className="px-2 py-3 text-xs text-muted-foreground">
                            Loading entries…
                        </p>
                    ) : !data || data.entries.length === 0 ? (
                        <p className="rounded border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                            No time entries on this sprint's tasks yet.
                        </p>
                    ) : (
                        <div className="max-h-[420px] overflow-y-auto rounded border bg-background">
                            <table className="w-full text-xs">
                                <thead className="sticky top-0 z-10 bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                                    <tr>
                                        <th className="px-2 py-1.5 text-left">
                                            User
                                        </th>
                                        <th className="px-2 py-1.5 text-left">
                                            When
                                        </th>
                                        <th className="px-2 py-1.5 text-left">
                                            Task
                                        </th>
                                        <th className="px-2 py-1.5 text-right">
                                            Duration
                                        </th>
                                        <th className="px-2 py-1.5 text-left">
                                            Source
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {data.entries.map((e) => (
                                        <SprintLoggedEntryRow
                                            key={e.id}
                                            entry={e}
                                        />
                                    ))}
                                </tbody>
                                <tfoot className="sticky bottom-0 z-10 border-t bg-muted/40 text-[11px] font-medium">
                                    <tr>
                                        <td
                                            className="px-2 py-1.5 text-muted-foreground"
                                            colSpan={3}
                                        >
                                            Sum across {count} entries
                                        </td>
                                        <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                                            {formatDuration(totalSeconds)}
                                        </td>
                                        <td className="px-2 py-1.5 text-muted-foreground">
                                            {formatHoursAsHM(totalHours)}
                                        </td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    )}
                </CardContent>
            )}
        </Card>
    );
}

function SprintLoggedEntryRow({ entry }) {
    const u = entry.user || {};
    const t = entry.task;
    const parent = t?.parent || null;
    const seconds = entry.durationSeconds || 0;
    const start = entry.startedAt ? new Date(entry.startedAt) : null;
    return (
        <tr>
            <td className="px-2 py-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                    <Avatar className="h-5 w-5">
                        {u.avatarUrl && (
                            <AvatarImage
                                src={resolveAssetUrl(u.avatarUrl)}
                                alt={u.name || ''}
                            />
                        )}
                        <AvatarFallback className="text-[9px]">
                            {initials(u.name || '?')}
                        </AvatarFallback>
                    </Avatar>
                    <span className="truncate">
                        {u.name || u.email || 'Unknown'}
                    </span>
                </div>
            </td>
            <td
                className="whitespace-nowrap px-2 py-1.5 text-muted-foreground"
                title={
                    start
                        ? format(start, "EEEE, MMMM d yyyy 'at' h:mm a")
                        : ''
                }
            >
                {start ? format(start, 'd MMM, HH:mm') : '—'}
            </td>
            <td className="px-2 py-1.5">
                {!t ? (
                    <span className="italic text-muted-foreground">
                        Project-level
                    </span>
                ) : (
                    <div className="flex min-w-0 flex-wrap items-center gap-1">
                        {parent && (
                            <>
                                {parent.code && (
                                    <span className="shrink-0 whitespace-nowrap rounded border bg-muted/30 px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                                        {parent.code}
                                    </span>
                                )}
                                <span className="truncate text-muted-foreground">
                                    {parent.title}
                                </span>
                                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                                <span className="text-muted-foreground/70">
                                    ↳
                                </span>
                            </>
                        )}
                        {t.code && (
                            <span className="shrink-0 whitespace-nowrap rounded border bg-muted/30 px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                                {t.code}
                            </span>
                        )}
                        <span className="truncate">{t.title}</span>
                    </div>
                )}
            </td>
            <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono tabular-nums">
                {formatDuration(seconds)}
            </td>
            <td className="px-2 py-1.5">
                <span
                    className={cn(
                        'inline-block rounded px-1 py-0.5 text-[9px] uppercase tracking-wide',
                        entry.source === 'TIMER'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : 'bg-muted text-muted-foreground',
                    )}
                >
                    {entry.source || 'manual'}
                </span>
            </td>
        </tr>
    );
}

function BoardColumn({
    title,
    description,
    items,
    accentClass,
    dragOver,
    onDragOver,
    onDragLeave,
    onDrop,
    renderItem,
    emptyText,
}) {
    return (
        <div
            className={cn(
                'rounded-lg border bg-card p-3 transition-colors',
                accentClass,
                dragOver && 'ring-2 ring-primary',
            )}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            <div className="flex items-center justify-between pb-2">
                <div>
                    <p className="text-sm font-semibold">{title}</p>
                    <p className="text-[11px] text-muted-foreground">
                        {description}
                    </p>
                </div>
                <span className="rounded-full border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
                    {items.length}
                </span>
            </div>
            <div className="space-y-1.5">
                {items.length === 0 ? (
                    <p className="rounded border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                        {emptyText}
                    </p>
                ) : (
                    items.map((i) => renderItem(i))
                )}
            </div>
        </div>
    );
}

// Small status pill — shared between parent task chips and the
// nested subtask rows so a glance reads the same.
function StatusPill({ status }) {
    const tone =
        status === 'DONE'
            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
            : status === 'IN_PROGRESS'
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                : 'bg-muted text-muted-foreground';
    return (
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', tone)}>
            {status === 'DONE' ? '✓' : status === 'IN_PROGRESS' ? '…' : '○'}
        </span>
    );
}

function TaskChip({
    task,
    draggable,
    onDragStart,
    actionIcon: ActionIcon,
    actionLabel,
    onAction,
    onAddSubtask,
    onCreateSubtask,
    focusPinHook,
}) {
    // Subtasks ride along with their parent on the sprint board. Adding
    // a subtask from the backlog attaches the parent to the sprint;
    // creating a subtask under an in-sprint parent posts a new row.
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
                'relative overflow-hidden rounded-md border bg-background text-xs shadow-sm',
                draggable && 'cursor-grab active:cursor-grabbing',
                isFocus && 'border-fuchsia-300 ring-1 ring-fuchsia-300/40',
            )}
        >
            {/* Today's-focus marker — a thin fuchsia stripe on the
                left edge so the user can scan the column and spot
                their focus items at a glance. */}
            {isFocus && (
                <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-1 bg-fuchsia-400"
                />
            )}
            <div
                className={cn(
                    'flex items-center gap-2 px-2 py-1.5',
                    isFocus && 'pl-3',
                )}
            >
                <StatusPill status={task.status} />
                {task.code && (
                    <span className="font-mono text-[10px] text-muted-foreground">
                        {task.code}
                    </span>
                )}
                <span className="min-w-0 flex-1 truncate" title={task.title}>
                    {task.title}
                </span>
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
                        {formatHoursAsHM(task.estimateHours)}
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
                {onCreateSubtask && (
                    <button
                        type="button"
                        onClick={() => onCreateSubtask(task)}
                        title="Add subtask"
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                        <Plus className="h-3.5 w-3.5" />
                    </button>
                )}
                {ActionIcon && onAction && (
                    <button
                        type="button"
                        onClick={onAction}
                        title={actionLabel}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                        <ActionIcon className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>
            {subtasks.length > 0 && (
                <ul className="space-y-0.5 border-t bg-muted/20 px-2 py-1.5">
                    {subtasks.map((s) => (
                        <li
                            key={s.id}
                            className="flex items-center gap-2 text-[11px]"
                            title={s.title}
                        >
                            <span className="text-muted-foreground/60">↳</span>
                            <StatusPill status={s.status} />
                            {s.code && (
                                <span className="font-mono text-[10px] text-muted-foreground">
                                    {s.code}
                                </span>
                            )}
                            <span
                                className={cn(
                                    'min-w-0 flex-1 truncate',
                                    s.status === 'DONE' &&
                                        'text-muted-foreground line-through',
                                )}
                            >
                                {s.title}
                            </span>
                            {s.estimateHours != null && (
                                <span className="rounded border bg-background px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                                    {formatHoursAsHM(s.estimateHours)}
                                </span>
                            )}
                            {s.assignee && (
                                <Avatar className="h-4 w-4">
                                    {s.assignee.avatarUrl && (
                                        <AvatarImage
                                            src={resolveAssetUrl(
                                                s.assignee.avatarUrl,
                                            )}
                                            alt={s.assignee.name}
                                        />
                                    )}
                                    <AvatarFallback className="bg-primary/10 text-[8px] text-primary">
                                        {initials(s.assignee.name || '?')}
                                    </AvatarFallback>
                                </Avatar>
                            )}
                            {onAddSubtask && (
                                <button
                                    type="button"
                                    onClick={() => onAddSubtask(s.id)}
                                    title="Add to sprint (includes parent)"
                                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                                >
                                    <Plus className="h-3 w-3" />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// ---- burndown view --------------------------------------------------------

function SprintBurndownView({ projectId, activeSprint, closedSprints }) {
    const all = [
        ...(activeSprint ? [activeSprint] : []),
        ...closedSprints,
    ];
    const [selectedId, setSelectedId] = useState(all[0]?.id || null);
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!selectedId) return;
        let cancelled = false;
        setLoading(true);
        (async () => {
            try {
                const { data } = await api.get(`/sprints/${selectedId}/burndown`);
                if (!cancelled) setData(data);
            } catch (err) {
                if (!cancelled) {
                    toast.error(
                        err?.response?.data?.message ||
                            'Failed to load burndown',
                    );
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [selectedId, projectId]);

    if (all.length === 0) {
        return (
            <Card>
                <CardContent className="flex flex-col items-center gap-3 p-10 text-center text-sm text-muted-foreground">
                    <LineChart className="h-8 w-8 text-muted-foreground/60" />
                    <p>
                        No sprint to chart yet. Start a sprint or close
                        one to see its burndown here.
                    </p>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <Label className="text-xs text-muted-foreground">
                    Sprint
                </Label>
                <Select value={selectedId || ''} onValueChange={setSelectedId}>
                    <SelectTrigger className="h-8 w-[260px] text-xs">
                        <SelectValue placeholder="Pick a sprint" />
                    </SelectTrigger>
                    <SelectContent>
                        {all.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                                {s.name} · {STATUS_META[s.status]?.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            {loading || !data ? (
                <Card>
                    <CardContent className="p-6 text-sm text-muted-foreground">
                        Loading burndown…
                    </CardContent>
                </Card>
            ) : (
                <>
                    <BurndownChart data={data} />
                    <BurndownExplainPanel data={data} />
                </>
            )}
        </div>
    );
}

// Collapsible "How was this calculated?" panel. Shows the raw
// inputs the burndown chart uses (baseline totalHours, sprint
// length in days, snapshot count + per-snapshot remaining hours),
// so a reviewer who's puzzled by a flat or wrong-looking line can
// see where the curve came from without opening the network tab.
function BurndownExplainPanel({ data }) {
    const [open, setOpen] = useState(false);
    if (!data) return null;
    const snaps = data.snapshots || [];
    const ideal = data.ideal || [];
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    return (
        <Card className="border-dashed">
            <CardContent className="p-3">
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    className="flex w-full items-center justify-between text-xs"
                >
                    <span className="inline-flex items-center gap-1.5 font-medium">
                        <Stethoscope className="h-3.5 w-3.5 text-rose-500" />
                        How was this calculated?
                    </span>
                    <span className="text-muted-foreground">
                        {open ? 'Hide' : 'Show'}
                    </span>
                </button>
                {open && (
                    <div className="mt-3 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
                        <p>
                            <strong className="text-foreground">
                                Baseline:
                            </strong>{' '}
                            {data.totalHours?.toFixed(2) || 0}h total
                            estimate · {data.days} day sprint window.
                        </p>
                        <p>
                            <strong className="text-foreground">
                                Ideal line:
                            </strong>{' '}
                            straight slope from{' '}
                            <code>{data.totalHours?.toFixed(2) || 0}h</code>{' '}
                            on day&nbsp;0 to <code>0h</code> on day&nbsp;
                            {data.days}. {ideal.length} sample points.
                        </p>
                        <p>
                            <strong className="text-foreground">
                                Snapshots:
                            </strong>{' '}
                            {snaps.length} stored.
                            {first && (
                                <>
                                    {' '}First on day{' '}
                                    <code>{first.day}</code> with{' '}
                                    <code>
                                        {first.remainingHours?.toFixed(2)}h
                                    </code>{' '}
                                    remaining.
                                </>
                            )}
                            {last && first !== last && (
                                <>
                                    {' '}Last on day{' '}
                                    <code>{last.day}</code> with{' '}
                                    <code>
                                        {last.remainingHours?.toFixed(2)}h
                                    </code>{' '}
                                    remaining.
                                </>
                            )}
                        </p>
                        {data.sprint?.status === 'CLOSED' ? (
                            <p>
                                <strong className="text-foreground">
                                    Closed sprint:
                                </strong>{' '}
                                snapshots are frozen at the pre-close
                                values (taken right before any tasks
                                were moved). The "today" point is{' '}
                                <em>not</em> appended — what you see is
                                what was true on close-day.
                            </p>
                        ) : (
                            <p>
                                <strong className="text-foreground">
                                    Live sprint:
                                </strong>{' '}
                                an extra synthetic snapshot for "today"
                                is appended on the fly from current
                                tasks + time entries, so the chart
                                reflects this minute without waiting
                                for the nightly snapshot job.
                            </p>
                        )}
                        <details className="mt-2 rounded border border-dashed bg-muted/30 p-2">
                            <summary className="cursor-pointer text-foreground">
                                Raw response
                            </summary>
                            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px]">
                                {JSON.stringify(data, null, 2)}
                            </pre>
                        </details>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function BurndownChart({ data }) {
    const width = 720;
    const height = 280;
    const pad = { l: 36, r: 16, t: 16, b: 28 };
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;

    const totalDays = data.days || 1;
    const maxY = Math.max(
        data.totalHours || 0,
        ...data.snapshots.map((s) => s.remainingHours || 0),
        1,
    );

    const x = (day) => pad.l + (day / totalDays) * innerW;
    const y = (hrs) => pad.t + innerH - (hrs / maxY) * innerH;

    // Snapshots use capturedAt; map onto the day axis relative to sprint start.
    const startMs = new Date(data.sprint.startDate).getTime();
    const points = data.snapshots.map((s) => ({
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

    const idealPath =
        data.ideal
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.day)} ${y(p.hours)}`)
            .join(' ');
    const actualPath = points
        .map(
            (p, i) =>
                `${i === 0 ? 'M' : 'L'} ${x(p.day)} ${y(p.hours)}`,
        )
        .join(' ');

    const yTicks = 4;
    const tickValues = Array.from(
        { length: yTicks + 1 },
        (_, i) => (maxY * i) / yTicks,
    );

    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-base">
                    {data.sprint.name} · burndown
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                    {formatDay(data.sprint.startDate)} →{' '}
                    {formatDay(data.sprint.endDate)} · {totalDays} day(s) ·{' '}
                    Total estimate: {formatHoursAsHM(data.totalHours)}
                </p>
            </CardHeader>
            <CardContent>
                <svg
                    viewBox={`0 0 ${width} ${height}`}
                    className="w-full"
                    role="img"
                    aria-label="Burndown chart"
                >
                    {/* Grid + Y labels */}
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
                    {/* X axis */}
                    <line
                        x1={pad.l}
                        x2={pad.l + innerW}
                        y1={pad.t + innerH}
                        y2={pad.t + innerH}
                        stroke="currentColor"
                        strokeOpacity={0.18}
                    />
                    {Array.from({ length: totalDays + 1 }, (_, i) => i)
                        .filter((d) => d % Math.max(1, Math.round(totalDays / 7)) === 0)
                        .map((d) => (
                            <text
                                key={d}
                                x={x(d)}
                                y={pad.t + innerH + 16}
                                textAnchor="middle"
                                fontSize="10"
                                className="fill-muted-foreground"
                            >
                                d{d}
                            </text>
                        ))}
                    {/* Ideal line */}
                    <path
                        d={idealPath}
                        stroke="currentColor"
                        strokeOpacity={0.4}
                        strokeDasharray="4 4"
                        fill="none"
                        strokeWidth="1.5"
                    />
                    {/* Actual line */}
                    {points.length > 1 && (
                        <path
                            d={actualPath}
                            className="stroke-primary"
                            fill="none"
                            strokeWidth="2"
                        />
                    )}
                    {points.map((p, i) => (
                        <circle
                            key={i}
                            cx={x(p.day)}
                            cy={y(p.hours)}
                            r={p.isLive ? 4 : 2.5}
                            className={cn(
                                p.isLive ? 'fill-primary' : 'fill-primary/70',
                            )}
                        />
                    ))}
                </svg>
                <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-0.5 w-4 bg-current opacity-40" />
                        Ideal
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-0.5 w-4 bg-primary" />
                        Actual
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 rounded-full bg-primary" />
                        Today
                    </span>
                </div>
            </CardContent>
        </Card>
    );
}

// ---- dialogs --------------------------------------------------------------

function SprintFormDialog({
    open,
    onClose,
    onSubmit,
    title,
    projectName,
    initial,
}) {
    const [name, setName] = useState('');
    const [goal, setGoal] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setName(initial?.name || '');
        setGoal(initial?.goal || '');
        setStartDate(toDateInput(initial?.startDate));
        setEndDate(toDateInput(initial?.endDate));
        setSaving(false);
    }, [open, initial]);

    const canSave =
        !saving &&
        name.trim().length > 0 &&
        startDate &&
        endDate &&
        new Date(endDate).getTime() > new Date(startDate).getTime();

    const handle = async (e) => {
        e?.preventDefault?.();
        if (!canSave) return;
        setSaving(true);
        try {
            await onSubmit({
                name: name.trim(),
                goal: goal.trim() || null,
                startDate,
                endDate,
            });
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => !o && !saving && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="inline-flex items-center gap-2">
                        <Zap className="h-4 w-4 text-violet-600" />
                        {title}
                    </DialogTitle>
                    <DialogDescription>
                        Project: <strong>{projectName}</strong>
                    </DialogDescription>
                </DialogHeader>
                <form className="space-y-3" onSubmit={handle}>
                    <div className="space-y-1.5">
                        <Label htmlFor="sp-name">Name</Label>
                        <Input
                            id="sp-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Sprint 23"
                            autoFocus
                            required
                        />
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="sp-start">Start date</Label>
                            <Input
                                id="sp-start"
                                type="date"
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                                required
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="sp-end">End date</Label>
                            <Input
                                id="sp-end"
                                type="date"
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                                required
                            />
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="sp-goal">Goal (optional)</Label>
                        <Textarea
                            id="sp-goal"
                            value={goal}
                            onChange={(e) => setGoal(e.target.value)}
                            rows={3}
                            placeholder="One-line agreement on what success looks like for this sprint."
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => !saving && onClose()}
                            disabled={saving}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!canSave}>
                            {saving ? 'Saving…' : 'Save'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function CloseSprintDialog({ open, sprint, onClose, onConfirm }) {
    const [strategy, setStrategy] = useState('PUSH_TO_NEXT');
    useEffect(() => {
        if (open) setStrategy('PUSH_TO_NEXT');
    }, [open]);
    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="inline-flex items-center gap-2">
                        <Flag className="h-4 w-4 text-amber-600" />
                        Close sprint
                    </DialogTitle>
                    <DialogDescription>
                        Closing “{sprint?.name}”. Choose what to do
                        with any incomplete tasks.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-2 text-sm">
                    <StrategyOption
                        active={strategy === 'PUSH_TO_NEXT'}
                        onClick={() => setStrategy('PUSH_TO_NEXT')}
                        title="Move to the next planned sprint"
                        hint="Incomplete tasks land on the next chronological planned sprint. If there isn't one, they go back to the backlog."
                    />
                    <StrategyOption
                        active={strategy === 'BACK_TO_BACKLOG'}
                        onClick={() => setStrategy('BACK_TO_BACKLOG')}
                        title="Send back to the backlog"
                        hint="Incomplete tasks lose their sprint assignment and re-enter the backlog."
                    />
                    <StrategyOption
                        active={strategy === 'KEEP'}
                        onClick={() => setStrategy('KEEP')}
                        title="Keep with this sprint (retrospective)"
                        hint="Incomplete tasks stay attached to the closed sprint for reporting. Rare."
                    />
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={() => onConfirm(strategy)}>
                        Close sprint
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function StrategyOption({ active, onClick, title, hint }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'flex w-full flex-col gap-0.5 rounded-md border p-2.5 text-left transition-colors',
                active
                    ? 'border-primary bg-primary/5'
                    : 'hover:bg-accent',
            )}
        >
            <span className="text-sm font-medium">{title}</span>
            <span className="text-xs text-muted-foreground">{hint}</span>
        </button>
    );
}

function CapacityDialog({ open, sprint, projectUsers, onClose, onSubmit }) {
    const [rows, setRows] = useState([]);
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        if (!open || !sprint) return;
        // Seed with existing capacity for the sprint (loaded via /sprints/:id
        // call elsewhere — but to keep the dialog standalone we re-fetch
        // here so the user always sees fresh numbers).
        let cancelled = false;
        (async () => {
            try {
                const { data } = await api.get(`/sprints/${sprint.id}`);
                if (cancelled) return;
                const map = new Map();
                for (const c of data.sprint.capacity || []) {
                    map.set(c.userId, c.plannedHours);
                }
                setRows(
                    (projectUsers || []).map((u) => ({
                        userId: u.id,
                        user: u,
                        plannedHours: map.get(u.id) ?? 0,
                    })),
                );
            } catch {
                setRows([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, sprint, projectUsers]);

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
                        Set the planned hours each project member is
                        available to commit to “{sprint?.name}”. Leave
                        someone at zero to keep them out of the heatmap.
                    </DialogDescription>
                </DialogHeader>
                {rows.length === 0 ? (
                    <p className="rounded border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                        No participants on this project yet. Add team
                        members to the project first.
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
                                            src={resolveAssetUrl(r.user.avatarUrl)}
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
                                                plannedHours: v === '' ? '' : Number(v),
                                            };
                                            return next;
                                        });
                                    }}
                                    className="h-8 w-24 text-xs"
                                />
                                <span className="text-[11px] text-muted-foreground">
                                    h
                                </span>
                            </div>
                        ))}
                    </div>
                )}
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => !saving && onClose()}
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

// ---- schedule banner + dialog --------------------------------------------

const CADENCE_OPTIONS = [
    { value: 'DAILY', label: 'Daily', days: 1, short: 'every day' },
    { value: 'WEEKLY', label: 'Weekly', days: 7, short: 'every week' },
    { value: 'BIWEEKLY', label: 'Bi-weekly', days: 14, short: 'every 2 weeks' },
    { value: 'MONTHLY', label: 'Monthly', days: 30, short: 'every month' },
];

function cadenceLabel(value) {
    return CADENCE_OPTIONS.find((c) => c.value === value)?.label || 'Custom';
}

function cadenceShort(value) {
    return CADENCE_OPTIONS.find((c) => c.value === value)?.short || value?.toLowerCase();
}

// Mirror of backend lib/sprintScheduler.js#advanceByCadence — kept in
// sync so the live preview matches what the backend will materialise.
// MONTHLY clamps to the last day of the destination month so an
// anchor on the 31st gives Jan 31 → Feb 28 → Mar 31 (not Mar 3).
function advanceByCadenceClient(start, cadence) {
    const next = new Date(start.getTime());
    if (cadence === 'DAILY') {
        next.setUTCDate(next.getUTCDate() + 1);
    } else if (cadence === 'WEEKLY') {
        next.setUTCDate(next.getUTCDate() + 7);
    } else if (cadence === 'BIWEEKLY') {
        next.setUTCDate(next.getUTCDate() + 14);
    } else if (cadence === 'MONTHLY') {
        const targetDay = next.getUTCDate();
        next.setUTCDate(1);
        next.setUTCMonth(next.getUTCMonth() + 1);
        const lastDay = new Date(
            Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
        ).getUTCDate();
        next.setUTCDate(Math.min(targetDay, lastDay));
    } else {
        next.setUTCDate(next.getUTCDate() + 14);
    }
    return next;
}

// Mirror of firstSlotAtOrAfter on the backend. Used to fast-forward
// the dialog preview past "today" when the anchor sits in the past
// — that way the user always sees what the generator will actually
// produce.
function firstSlotAtOrAfterClient(anchor, cadence, floorTs) {
    let cursor = new Date(anchor.getTime());
    cursor.setUTCHours(0, 0, 0, 0);
    let guard = 0;
    while (cursor.getTime() < floorTs && guard < 5000) {
        cursor = advanceByCadenceClient(cursor, cadence);
        guard += 1;
    }
    return cursor;
}

function renderNameClient(pattern, { n, startDate, endDate }) {
    const iso = (d) => {
        if (!d) return '';
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
    };
    const monthName = (d) =>
        d
            ? d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
            : '';
    const year = (d) => (d ? String(d.getUTCFullYear()) : '');
    return String(pattern || 'Sprint {n}')
        .replace(/\{n\}/g, String(n))
        .replace(/\{start\}/g, iso(startDate))
        .replace(/\{end\}/g, iso(endDate))
        .replace(/\{month\}/g, monthName(startDate))
        .replace(/\{year\}/g, year(startDate));
}

// Build a 3-sprint preview given the current dialog config. Anchored
// at the chosen anchorDate (UTC-midnight); if the anchor is in the
// past we fast-forward to the next slot >= today so the preview shows
// sprints that will actually exist. No project-history is available
// client-side so we don't try to skip past the latest existing sprint
// — the backend re-derives that on save.
function buildPreview({ cadence, anchorDate, namePattern, startNumber }) {
    if (!anchorDate || !cadence) return [];
    const parts = anchorDate.split('-').map((s) => parseInt(s, 10));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return [];
    const anchor = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    let cursor = firstSlotAtOrAfterClient(anchor, cadence, Date.now());
    let counter = Math.max(1, parseInt(startNumber, 10) || 1);
    const out = [];
    for (let i = 0; i < 3; i += 1) {
        const startDate = new Date(cursor.getTime());
        const endDate = advanceByCadenceClient(startDate, cadence);
        const name = renderNameClient(namePattern || 'Sprint {n}', {
            n: counter,
            startDate,
            endDate,
        });
        out.push({ name, startDate, endDate });
        cursor = endDate;
        counter += 1;
    }
    return out;
}

// Strip beneath the subview switcher on the List view. Only renders when
// a schedule exists (any state). When disabled, the strip stays visible
// but in a muted "paused" shape so the user knows the config is still
// there. The `onOpen` handler is only wired for users with sprint:edit
// — without it the Edit button is hidden so we don't expose a
// non-functional link to read-only viewers. Same rule for onRunNow
// (sprint:create).
function ScheduleBanner({
    schedule,
    onOpen,
    onRunNow,
    onDelete,
    plannedCount = 0,
}) {
    // Two-step confirm right on the banner — no modal, no page jump,
    // no extra click to dismiss. Keeps the destructive action close
    // to the trigger so the user always sees what's about to happen.
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);

    if (!schedule) return null;
    const cadence = cadenceShort(schedule.cadence);
    const next = (() => {
        try {
            return buildPreview({
                cadence: schedule.cadence,
                anchorDate: toDateInput(schedule.anchorDate),
                namePattern: schedule.namePattern,
                startNumber: schedule.nextNumber,
            })[0];
        } catch {
            return null;
        }
    })();

    const handleDelete = async () => {
        if (!onDelete) return;
        setDeleting(true);
        try {
            // Always cascade-delete planned sprints from the ribbon.
            // The user's mental model when clicking this button is
            // "wipe the schedule" — surfacing a checkbox here just
            // adds friction.
            await onDelete({ withPlanned: true });
            setConfirmDelete(false);
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
                <span>
                    {schedule.enabled ? (
                        <>
                            Auto-creating sprints <strong>{cadence}</strong>
                            {next && (
                                <>
                                    . Next:{' '}
                                    <strong>{next.name}</strong> (
                                    {formatDay(next.startDate)} →{' '}
                                    {formatDay(next.endDate)})
                                </>
                            )}
                            {typeof schedule.lookahead === 'number' && (
                                <>
                                    . Keeping{' '}
                                    <strong>{schedule.lookahead}</strong>{' '}
                                    ahead.
                                </>
                            )}
                        </>
                    ) : (
                        <>
                            Schedule paused ({cadence}). The generator
                            won't add new sprints until you re-enable it.
                        </>
                    )}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                    {onRunNow && schedule.enabled && (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={onRunNow}
                            title="Trigger generation now (otherwise runs hourly)"
                        >
                            <Play className="mr-1 h-3 w-3" />
                            Generate now
                        </Button>
                    )}
                    {onOpen && (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={onOpen}
                        >
                            <Settings2 className="mr-1 h-3 w-3" />
                            Edit
                        </Button>
                    )}
                    {onDelete && (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1 px-2 text-xs text-rose-700 hover:bg-rose-100 hover:text-rose-700 dark:text-rose-300 dark:hover:bg-rose-500/10"
                            onClick={() => setConfirmDelete((v) => !v)}
                            title="Remove the schedule AND every planned sprint for this project"
                        >
                            <Trash2 className="h-3 w-3" />
                            Delete schedule
                        </Button>
                    )}
                </div>
            </div>
            {confirmDelete && onDelete && (
                <div className="flex flex-wrap items-center gap-2 rounded border border-rose-400 bg-white/80 px-2 py-1.5 text-rose-800 dark:bg-rose-950/30 dark:text-rose-200">
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>
                        Delete this schedule
                        {plannedCount > 0 && (
                            <>
                                {' '}AND its{' '}
                                <strong>{plannedCount} planned sprint{plannedCount === 1 ? '' : 's'}</strong>
                            </>
                        )}
                        ? Active and closed sprints are kept. Tasks
                        pinned to deleted sprints return to the backlog.
                    </span>
                    <div className="ml-auto flex gap-1">
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => setConfirmDelete(false)}
                            disabled={deleting}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            className="h-7 px-2 text-xs"
                            onClick={handleDelete}
                            disabled={deleting}
                        >
                            {deleting
                                ? 'Deleting…'
                                : plannedCount > 0
                                    ? `Yes, delete + ${plannedCount}`
                                    : 'Yes, delete'}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

function SprintScheduleDialog({
    open,
    schedule,
    onClose,
    onSubmit,
    onRemove,
    projectId = null,
    // Currently-planned sprints for this project, already sorted
    // chronologically ASC by the parent. Used so the "Danger zone"
    // can show a count + ask "keep first N, delete the rest". The
    // bulk-delete is committed together with the schedule save (the
    // parent's onSubmit handler triggers its own reload, so we don't
    // need a separate post-delete callback).
    plannedSprints = [],
}) {
    // Form state, hydrated from the saved schedule on open. We default
    // anchorDate to today (or next Monday for a clean weekly cadence)
    // when first setting up, so the user doesn't have to think.
    const [cadence, setCadence] = useState('BIWEEKLY');
    const [anchorDate, setAnchorDate] = useState('');
    const [namePattern, setNamePattern] = useState('Sprint {n}');
    const [lookahead, setLookahead] = useState(2);
    const [startNumber, setStartNumber] = useState(1);
    const [enabled, setEnabled] = useState(true);
    const [saving, setSaving] = useState(false);
    const [removing, setRemoving] = useState(false);

    // "Keep first N" stager for the bulk-delete danger zone. The
    // deletion is NOT applied when the user changes this number — it's
    // staged and committed by the Save button alongside the schedule
    // config update. That matches the mental model "Save my changes"
    // and avoids the foot-gun where a destructive action fires on a
    // tap of the slider arrows.
    //
    // We initialise to the current planned count (= "delete nothing")
    // when the dialog opens. If the user wants to clean up, they drop
    // the number; the Save button label morphs to show the pending
    // delete count.
    const [keepCount, setKeepCount] = useState(0);

    useEffect(() => {
        if (!open) return;
        if (schedule) {
            setCadence(schedule.cadence || 'BIWEEKLY');
            setAnchorDate(toDateInput(schedule.anchorDate));
            setNamePattern(schedule.namePattern || 'Sprint {n}');
            setLookahead(schedule.lookahead || 2);
            setStartNumber(schedule.nextNumber || 1);
            setEnabled(schedule.enabled !== false);
        } else {
            // Default: next Monday so weekly cadences start on a clean
            // boundary. Monthly users can change it freely.
            const today = new Date();
            const dow = today.getDay();
            const daysUntilMonday = (8 - dow) % 7 || 7;
            const nextMonday = new Date(today);
            nextMonday.setDate(today.getDate() + daysUntilMonday);
            setCadence('BIWEEKLY');
            setAnchorDate(format(nextMonday, 'yyyy-MM-dd'));
            setNamePattern('Sprint {n}');
            setLookahead(2);
            setStartNumber(1);
            setEnabled(true);
        }
        // "Keep all" by default — the user has to opt in to deletion
        // by dropping this number. This way reopening the dialog never
        // accidentally signals a pending delete that wasn't intended.
        setKeepCount(plannedSprints.length);
        setSaving(false);
        setRemoving(false);
    }, [open, schedule, plannedSprints.length]);

    const preview = useMemo(
        () =>
            buildPreview({
                cadence,
                anchorDate,
                namePattern,
                startNumber,
            }),
        [cadence, anchorDate, namePattern, startNumber],
    );

    // Sprints that would be deleted if the user clicked Save right
    // now. Empty array means "no pending deletion" — the Save button
    // text + onSubmit handler use this to decide whether to fire the
    // bulk-delete request at all. plannedSprints arrives sorted
    // chronologically ASC, so slicing from `keepCount` gives us the
    // *tail* of upcoming sprints, which is what users want to drop.
    const deletableTail = useMemo(
        () => plannedSprints.slice(keepCount),
        [plannedSprints, keepCount],
    );
    const pendingDeleteCount = deletableTail.length;

    // Auto-shrink Lookahead when the user lowers Keep first below it.
    // Without this the order of operations is:
    //   1) bulk-delete tail (PLANNED count drops to keepCount)
    //   2) PUT /schedule with the OLD lookahead
    //   3) backend materializer sees plannedCount < lookahead and
    //      regenerates the sprints we just deleted
    // …which makes the deletion look like a no-op. Clamping lookahead
    // to <= keepCount means "Keep first 10" really does leave 10
    // sprints, no surprises. We never auto-INCREASE lookahead — if
    // the user keeps more than the current lookahead, that's just
    // them choosing to retain extras the schedule will eventually
    // catch up to.
    useEffect(() => {
        if (!open || !schedule) return;
        if (pendingDeleteCount > 0 && lookahead > keepCount) {
            setLookahead(Math.max(1, keepCount));
        }
    }, [open, schedule, pendingDeleteCount, lookahead, keepCount]);

    const handleSubmit = async (e) => {
        e?.preventDefault?.();
        if (!anchorDate) {
            toast.error('Pick an anchor date');
            return;
        }
        setSaving(true);
        try {
            // 1) Apply the staged bulk-delete FIRST. This way:
            //    - The schedule's PUT route auto-runs materialize after
            //      saving, which sees the reduced count and the new
            //      lookahead together — no risk of materialising
            //      sprints that we're about to delete.
            //    - The dialog only closes once (after step 2), so the
            //      user doesn't see a "ghost" toast firing after the
            //      modal disappears.
            if (projectId && pendingDeleteCount > 0) {
                try {
                    const { data } = await api.post(
                        '/sprints/bulk-delete',
                        {
                            projectId,
                            ids: deletableTail.map((s) => s.id),
                        },
                    );
                    const removed = data?.deleted || 0;
                    const detached = data?.tasksDetached || 0;
                    const skipped = Array.isArray(data?.skipped)
                        ? data.skipped.length
                        : 0;
                    if (removed > 0) {
                        toast.success(
                            `Deleted ${removed} planned sprint${removed === 1 ? '' : 's'}` +
                                (detached
                                    ? ` · ${detached} task${detached === 1 ? '' : 's'} sent back to backlog`
                                    : '') +
                                (skipped
                                    ? ` · ${skipped} skipped`
                                    : ''),
                        );
                    } else if (skipped > 0) {
                        toast.info(
                            `${skipped} sprint${skipped === 1 ? ' was' : 's were'} not eligible for deletion`,
                        );
                    }
                    // Don't call onBulkDeleted here — the schedule
                    // save below already triggers a parent reload, no
                    // need to fire two back-to-back.
                } catch (err) {
                    toast.error(
                        err?.response?.data?.message ||
                            'Bulk delete failed — schedule not saved',
                    );
                    // Abort the save so the user knows nothing was
                    // applied; they can retry without losing context.
                    return;
                }
            }

            // 2) Save the schedule config. Parent's handler closes the
            //    dialog + reloads on success.
            await onSubmit({
                cadence,
                enabled,
                anchorDate,
                namePattern: namePattern.trim() || 'Sprint {n}',
                lookahead,
                // Only send startNumber on first create; on edit, the
                // backend ignores anything that would silently reset
                // the numbering.
                ...(schedule ? {} : { startNumber }),
            });
        } finally {
            setSaving(false);
        }
    };

    const handleRemove = async () => {
        if (!onRemove) return;
        setRemoving(true);
        try {
            await onRemove();
        } finally {
            setRemoving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => !o && !saving && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle className="inline-flex items-center gap-2">
                        <Repeat className="h-4 w-4 text-violet-600" />
                        {schedule ? 'Edit sprint schedule' : 'Set up sprint schedule'}
                    </DialogTitle>
                    <DialogDescription className="text-xs">
                        Auto-generate upcoming sprints on a cadence so
                        the team always has the next iteration ready.
                        The generator only adds sprints — it never
                        edits or removes existing ones.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label className="text-xs">Cadence</Label>
                            <Select
                                value={cadence}
                                onValueChange={setCadence}
                                disabled={saving}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {CADENCE_OPTIONS.map((opt) => (
                                        <SelectItem
                                            key={opt.value}
                                            value={opt.value}
                                        >
                                            {opt.label} ({opt.short})
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label className="flex items-center gap-1.5 text-xs">
                                Anchor (first sprint starts)
                                <Tip variant="tip" side="top">
                                    <p className="font-medium">
                                        Pick the day-of-week you want
                                        recurring sprints to fall on.
                                    </p>
                                    <p className="mt-1 text-muted-foreground">
                                        Every future sprint inherits this
                                        weekday (or day-of-month for
                                        MONTHLY). To shift the rhythm
                                        from "Wed → Wed" to "Mon → Mon",
                                        change the anchor here — the
                                        scheduler picks it up on the
                                        next run.
                                    </p>
                                </Tip>
                            </Label>
                            <Input
                                type="date"
                                value={anchorDate}
                                onChange={(e) => setAnchorDate(e.target.value)}
                                disabled={saving}
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label className="text-xs">Lookahead</Label>
                            <Input
                                type="number"
                                min={1}
                                max={10}
                                value={lookahead}
                                onChange={(e) =>
                                    setLookahead(
                                        Math.max(
                                            1,
                                            Math.min(
                                                10,
                                                parseInt(e.target.value, 10) ||
                                                    1,
                                            ),
                                        ),
                                    )
                                }
                                disabled={saving}
                            />
                            <p className="text-[10px] text-muted-foreground">
                                Future PLANNED sprints to keep ready.
                            </p>
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">
                                {schedule ? 'Next number' : 'Start at'}
                            </Label>
                            <Input
                                type="number"
                                min={1}
                                value={startNumber}
                                onChange={(e) =>
                                    setStartNumber(
                                        Math.max(
                                            1,
                                            parseInt(e.target.value, 10) || 1,
                                        ),
                                    )
                                }
                                disabled={saving || !!schedule}
                            />
                            <p className="text-[10px] text-muted-foreground">
                                {schedule
                                    ? 'Server-managed once the schedule exists.'
                                    : 'Starting value for the {n} counter.'}
                            </p>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Name pattern</Label>
                        <Input
                            value={namePattern}
                            onChange={(e) => setNamePattern(e.target.value)}
                            placeholder="Sprint {n}"
                            disabled={saving}
                        />
                        <p className="text-[10px] text-muted-foreground">
                            Tokens: <code>{'{n}'}</code>{' '}
                            <code>{'{start}'}</code>{' '}
                            <code>{'{end}'}</code>{' '}
                            <code>{'{month}'}</code>{' '}
                            <code>{'{year}'}</code>
                        </p>
                    </div>
                    <label className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
                        <input
                            type="checkbox"
                            checked={enabled}
                            onChange={(e) => setEnabled(e.target.checked)}
                            disabled={saving}
                            className="h-3.5 w-3.5"
                        />
                        <span>
                            <strong>Enabled.</strong> The background job
                            generates the next sprint automatically.
                            Uncheck to pause without losing the
                            configuration.
                        </span>
                    </label>
                    {/* Danger zone — only shown when editing an
                        existing schedule AND there are planned sprints
                        to potentially clean up. The deletion is STAGED
                        here and committed by the Save button alongside
                        the schedule update, so the user only ever has
                        one "apply my changes" action to think about. */}
                    {schedule && plannedSprints.length > 0 && projectId && (
                        <div
                            className={cn(
                                'rounded-md border p-3 text-xs transition-colors',
                                pendingDeleteCount > 0
                                    ? 'border-rose-400 bg-rose-50/80 dark:border-rose-500/50 dark:bg-rose-500/10'
                                    : 'border-rose-300/60 bg-rose-50/40 dark:border-rose-500/30 dark:bg-rose-500/5',
                            )}
                        >
                            <div className="mb-1.5 flex items-center gap-1.5 font-medium text-rose-800 dark:text-rose-200">
                                <Trash2 className="h-3.5 w-3.5" />
                                Danger zone — clean up planned sprints
                            </div>
                            <p className="mb-2 text-rose-900/80 dark:text-rose-200/70">
                                This project has{' '}
                                <strong>
                                    {plannedSprints.length} upcoming planned
                                    sprint{plannedSprints.length === 1 ? '' : 's'}
                                </strong>
                                . Drop the number below if the generator
                                rolled out more than you needed; the
                                deletion is applied when you click{' '}
                                <strong>Save</strong>. Active / closed
                                sprints are never touched. Tasks pinned
                                to deleted sprints fall back to the
                                backlog.
                            </p>
                            {pendingDeleteCount > 0 && (
                                <p className="mb-2 rounded border border-rose-300/50 bg-rose-100/60 px-2 py-1 text-[11px] text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                                    <strong>Lookahead</strong> will be
                                    clamped to{' '}
                                    <strong>{Math.max(1, keepCount)}</strong>{' '}
                                    on save so the generator doesn't
                                    immediately refill the sprints
                                    you're deleting. Bump it back up
                                    later when you want more in the
                                    queue.
                                </p>
                            )}
                            <div className="flex flex-wrap items-end gap-2">
                                <div className="space-y-1">
                                    <Label className="text-[11px] text-rose-900 dark:text-rose-200">
                                        Keep first
                                    </Label>
                                    <Input
                                        type="number"
                                        min={0}
                                        max={plannedSprints.length}
                                        value={keepCount}
                                        onChange={(e) =>
                                            setKeepCount(
                                                Math.max(
                                                    0,
                                                    Math.min(
                                                        plannedSprints.length,
                                                        parseInt(
                                                            e.target.value,
                                                            10,
                                                        ) || 0,
                                                    ),
                                                ),
                                            )
                                        }
                                        disabled={saving}
                                        className="h-8 w-24 text-xs"
                                    />
                                </div>
                                <span className="pb-2 text-rose-900/80 dark:text-rose-200/70">
                                    sprint
                                    {keepCount === 1 ? '' : 's'} →{' '}
                                    {pendingDeleteCount > 0 ? (
                                        <strong className="text-rose-700 dark:text-rose-200">
                                            {pendingDeleteCount} to delete
                                        </strong>
                                    ) : (
                                        <span className="text-muted-foreground">
                                            nothing to delete
                                        </span>
                                    )}
                                    {pendingDeleteCount > 0 && (
                                        <>
                                            {' '}
                                            (
                                            <span className="text-foreground">
                                                {deletableTail[0]?.name}
                                            </span>
                                            {pendingDeleteCount > 1 && (
                                                <>
                                                    {' '}
                                                    →{' '}
                                                    <span className="text-foreground">
                                                        {
                                                            deletableTail[
                                                                deletableTail.length -
                                                                    1
                                                            ]?.name
                                                        }
                                                    </span>
                                                </>
                                            )}
                                            )
                                        </>
                                    )}
                                </span>
                                {pendingDeleteCount > 0 && (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="ml-auto h-7 px-2 text-[11px] text-rose-700 hover:text-rose-700 dark:text-rose-200"
                                        onClick={() =>
                                            setKeepCount(plannedSprints.length)
                                        }
                                        disabled={saving}
                                        title="Don't delete anything when Save is clicked"
                                    >
                                        Reset
                                    </Button>
                                )}
                            </div>
                        </div>
                    )}
                    {preview.length > 0 && (
                        <div className="rounded-md border bg-card p-3 text-xs">
                            <div className="mb-1.5 flex items-center gap-1.5 font-medium text-foreground">
                                <AlarmClock className="h-3.5 w-3.5 text-violet-600" />
                                Preview — next 3 sprints
                            </div>
                            <ul className="space-y-1 text-muted-foreground">
                                {preview.map((p, i) => (
                                    <li
                                        key={`${p.name}-${i}`}
                                        className="flex items-baseline gap-2"
                                    >
                                        <span className="font-medium text-foreground">
                                            {p.name}
                                        </span>
                                        <span>
                                            {formatDay(p.startDate)} →{' '}
                                            {formatDay(p.endDate)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                            <p className="mt-2 text-[10px] text-muted-foreground">
                                Sprints always start on the anchor's
                                weekday (weekly / bi-weekly) or
                                day-of-month (monthly). If the project
                                already has sprints, the first
                                generated one is the next anchor slot
                                after the latest sprint ends — which
                                may leave a small gap if existing dates
                                don't align to the anchor.
                            </p>
                        </div>
                    )}
                    <DialogFooter className="flex-wrap gap-2">
                        {onRemove && (
                            <Button
                                type="button"
                                variant="ghost"
                                className="text-rose-600 hover:text-rose-600"
                                onClick={handleRemove}
                                disabled={saving || removing}
                                title="Remove the schedule (keeps existing sprints intact)"
                            >
                                {removing ? 'Removing…' : 'Remove schedule'}
                            </Button>
                        )}
                        <div className="ml-auto flex gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => !saving && onClose()}
                                disabled={saving}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                disabled={saving}
                                className={cn(
                                    pendingDeleteCount > 0 &&
                                        'bg-rose-600 hover:bg-rose-700',
                                )}
                                title={
                                    pendingDeleteCount > 0
                                        ? `Save schedule + delete ${pendingDeleteCount} planned sprint${pendingDeleteCount === 1 ? '' : 's'}`
                                        : 'Save schedule'
                                }
                            >
                                {saving
                                    ? 'Saving…'
                                    : pendingDeleteCount > 0
                                        ? `Save · delete ${pendingDeleteCount}`
                                        : 'Save'}
                            </Button>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
