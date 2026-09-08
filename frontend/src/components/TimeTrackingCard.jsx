// Project-scoped Time Tracking card. Strictly the live-timer view:
//
//   1. Totals  : project total + this-week total + your own contribution.
//                Top contributors leaderboard (admin / manager / owner only).
//                Per-task breakdown so it's obvious where the hours land.
//   2. Quick   : one-click "Start timer on this project" (with task picker)
//                or "Stop timer" if you're already running one for the
//                current project.
//   3. Mine    : a read-only list of your recent entries on this project.
//                Delete is allowed inline (so you can undo a wrong entry
//                in place); manual add and edit live on the standalone
//                /time page so the project view stays focused.
//
// Roll-up: every entry on a task is also counted at the project level
// because the backend stamps `projectId` from the task. Both totals
// in this card therefore stay consistent automatically.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import {
    ChevronDown,
    ChevronRight,
    Clock,
    ExternalLink,
    Loader2,
    Play,
    Square,
    Timer as TimerIcon,
    Trash2,
    User as UserIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import {
    Avatar,
    AvatarFallback,
    AvatarImage,
} from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { useActiveTimer } from '@/contexts/ActiveTimerContext';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/lib/api';
import {
    elapsedSecondsSince,
    formatDuration,
    formatTickerHM,
} from '@/lib/time';
import { cn, resolveAssetUrl } from '@/lib/utils';

const NO_TASK = '__no_task__';

function initials(name) {
    if (!name) return '?';
    return name
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();
}

function weekBoundsISO() {
    // ISO week: Monday as the first day. Locales differ but for an
    // internal organiser ISO is what people expect.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const day = start.getDay(); // 0=Sun,1=Mon,...
    const diff = (day + 6) % 7; // days since Monday
    start.setDate(start.getDate() - diff);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return { from: start.toISOString(), to: end.toISOString() };
}

export function TimeTrackingCard({ project, collapsed, onToggle }) {
    const { user: currentUser } = useAuth();
    const { entry: runningEntry, startTimer, stopTimer, revision, notifyChanged } =
        useActiveTimer();
    const [summary, setSummary] = useState(null);
    const [weekSummary, setWeekSummary] = useState(null);
    const [recentEntries, setRecentEntries] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [pickedTaskId, setPickedTaskId] = useState(NO_TASK);
    const [description, setDescription] = useState('');

    const projectId = project?.id;
    const isRunningOnThisProject = Boolean(
        runningEntry && runningEntry.projectId === projectId,
    );

    // Live ticker for an entry that's running on THIS project — keeps
    // the "your contribution today" number honest while you're working.
    const [, forceTick] = useState(0);
    useEffect(() => {
        if (!isRunningOnThisProject) return undefined;
        const id = setInterval(() => forceTick((n) => n + 1), 1000);
        return () => clearInterval(id);
    }, [isRunningOnThisProject]);

    // Load project totals (all-time) and the week's slice in parallel.
    // We refetch whenever:
    //   - the user opens the card (collapsed -> expanded),
    //   - a timer starts / stops (revision tick from the context),
    //   - the user adds / edits / deletes a manual entry.
    const refresh = useCallback(async () => {
        if (!projectId || collapsed) return;
        setLoading(true);
        const week = weekBoundsISO();
        try {
            const [summaryRes, weekRes, entriesRes] = await Promise.all([
                api.get(`/time/projects/${projectId}/summary`),
                api.get(`/time/projects/${projectId}/summary`, {
                    params: { from: week.from, to: week.to },
                }),
                api.get('/time/me', {
                    params: { projectId, limit: 25 },
                }),
            ]);
            setSummary(summaryRes.data || null);
            setWeekSummary(weekRes.data || null);
            setRecentEntries(entriesRes.data?.entries || []);
        } catch (err) {
            console.warn(
                '[time-card] could not load summary:',
                err?.message,
            );
        } finally {
            setLoading(false);
        }
    }, [projectId, collapsed]);

    useEffect(() => {
        refresh();
    }, [refresh, revision]);

    // Tasks for the quick-start picker. Pulled once per project; lives
    // alongside the card state because the picker is right here.
    useEffect(() => {
        if (!projectId || collapsed) return undefined;
        let cancelled = false;
        api.get('/tasks', { params: { projectId } })
            .then((res) => {
                if (cancelled) return;
                setTasks(res.data?.tasks || []);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [projectId, collapsed]);

    const taskOptions = useMemo(() => {
        const tops = tasks.filter((t) => !t.parentTaskId);
        const childrenByParent = new Map();
        for (const t of tasks) {
            if (!t.parentTaskId) continue;
            if (!childrenByParent.has(t.parentTaskId)) {
                childrenByParent.set(t.parentTaskId, []);
            }
            childrenByParent.get(t.parentTaskId).push(t);
        }
        const out = [];
        for (const top of tops) {
            out.push({ id: top.id, label: top.title, code: top.code });
            const kids = childrenByParent.get(top.id) || [];
            for (const c of kids) {
                out.push({
                    id: c.id,
                    label: `↳ ${c.title}`,
                    code: c.code,
                });
            }
        }
        return out;
    }, [tasks]);

    const handleQuickStart = async () => {
        setSubmitting(true);
        try {
            await startTimer({
                projectId,
                taskId: pickedTaskId !== NO_TASK ? pickedTaskId : undefined,
                description: description.trim() || undefined,
            });
            setDescription('');
            toast.success('Timer started');
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not start timer',
            );
        } finally {
            setSubmitting(false);
        }
    };

    const handleQuickStop = async () => {
        setSubmitting(true);
        try {
            await stopTimer();
            toast.success('Timer stopped');
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not stop timer',
            );
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (entryId) => {
        if (!window.confirm('Delete this time entry?')) return;
        try {
            await api.delete(`/time/${entryId}`);
            toast.success('Time entry deleted');
            notifyChanged();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not delete entry',
            );
        }
    };

    // Live numbers. When a timer is running on this project we add the
    // running elapsed seconds to the cached "mine" total so the UI
    // matches what the user expects to see.
    const liveExtraSeconds =
        isRunningOnThisProject && runningEntry?.startedAt
            ? elapsedSecondsSince(runningEntry.startedAt)
            : 0;
    const totalSeconds =
        (summary?.total?.seconds || 0) + liveExtraSeconds;
    const mineSeconds =
        (summary?.mine?.seconds || 0) + liveExtraSeconds;
    const weekSeconds = (weekSummary?.total?.seconds || 0) + liveExtraSeconds;

    const seeAllUsers =
        Boolean(summary?.seeAll) && (summary?.byUser?.length ?? 0) > 0;
    const taskBreakdown = (summary?.byTask || []).filter(
        (b) => b.seconds > 0,
    );

    return (
        <Card>
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                    <button
                        type="button"
                        onClick={onToggle}
                        className="-ml-1 flex flex-1 items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-accent/40"
                        aria-expanded={!collapsed}
                    >
                        {collapsed ? (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        ) : (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                        <TimerIcon className="h-4 w-4 text-muted-foreground" />
                        <CardTitle className="text-base">
                            Time tracking
                        </CardTitle>
                    </button>
                    {isRunningOnThisProject && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
                            <span className="relative flex h-1.5 w-1.5">
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            </span>
                            Tracking
                        </span>
                    )}
                </div>
            </CardHeader>
            {!collapsed && (
                <CardContent className="space-y-4">
                    {loading && !summary ? (
                        <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Loading…
                        </div>
                    ) : (
                        <>
                            {/* --- Totals ----------------------------- */}
                            <div className="grid grid-cols-1 gap-2 text-center sm:grid-cols-3">
                                <Stat
                                    label={summary?.seeAll ? 'Total' : 'You'}
                                    seconds={
                                        summary?.seeAll
                                            ? totalSeconds
                                            : mineSeconds
                                    }
                                    primary
                                />
                                <Stat
                                    label="This week"
                                    seconds={weekSeconds}
                                />
                                <Stat label="Your time" seconds={mineSeconds} />
                            </div>

                            {/* --- Top contributors ------------------ */}
                            {seeAllUsers && (
                                <div className="space-y-1.5">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        Top contributors
                                    </div>
                                    <ul className="space-y-1">
                                        {summary.byUser.slice(0, 5).map((row) => (
                                            <ContributorRow
                                                key={row.user.id}
                                                user={row.user}
                                                seconds={row.seconds}
                                                totalSeconds={totalSeconds}
                                                isMe={row.user.id === currentUser?.id}
                                                liveBoost={
                                                    isRunningOnThisProject &&
                                                    row.user.id ===
                                                        runningEntry?.userId
                                                        ? liveExtraSeconds
                                                        : 0
                                                }
                                            />
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* --- Per-task breakdown --------------- */}
                            {taskBreakdown.length > 0 && (
                                <div className="space-y-1.5">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        By task
                                    </div>
                                    <ul className="space-y-1 text-sm">
                                        {taskBreakdown.slice(0, 5).map((row) => (
                                            <li
                                                key={row.task?.id || 'project'}
                                                className="flex items-center justify-between gap-2"
                                            >
                                                <span className="min-w-0 truncate">
                                                    {row.task ? (
                                                        <>
                                                            {row.task.code && (
                                                                <span className="mr-1 font-mono text-[10px] uppercase text-muted-foreground">
                                                                    {row.task.code}
                                                                </span>
                                                            )}
                                                            {row.task.title}
                                                        </>
                                                    ) : (
                                                        <span className="italic text-muted-foreground">
                                                            Project-level time
                                                        </span>
                                                    )}
                                                </span>
                                                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                                                    {formatDuration(row.seconds)}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            <Separator />

                            {/* --- Quick start / stop --------------- */}
                            {isRunningOnThisProject ? (
                                <div className="space-y-2 rounded-md border border-emerald-300/70 bg-emerald-50 p-3 text-sm dark:border-emerald-500/40 dark:bg-emerald-500/10">
                                    <div className="flex items-center justify-between gap-2 text-emerald-900 dark:text-emerald-100">
                                        <div className="min-w-0">
                                            <div className="text-xs font-semibold uppercase tracking-wide opacity-70">
                                                Tracking
                                            </div>
                                            <div className="truncate font-medium">
                                                {runningEntry.task?.title ||
                                                    'Project-level time'}
                                            </div>
                                            {runningEntry.description && (
                                                <div className="truncate text-xs opacity-80">
                                                    {runningEntry.description}
                                                </div>
                                            )}
                                        </div>
                                        <div className="font-mono text-base tabular-nums">
                                            {formatTickerHM(
                                                elapsedSecondsSince(
                                                    runningEntry.startedAt,
                                                ),
                                            )}
                                        </div>
                                    </div>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="w-full gap-2 border-emerald-400 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-500/50 dark:text-emerald-100 dark:hover:bg-emerald-500/20"
                                        onClick={handleQuickStop}
                                        disabled={submitting}
                                    >
                                        {submitting ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Square
                                                className="h-3.5 w-3.5 fill-current"
                                                strokeWidth={0}
                                            />
                                        )}
                                        Stop timer
                                    </Button>
                                </div>
                            ) : (
                                <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        Quick start
                                    </div>
                                    <Select
                                        value={pickedTaskId}
                                        onValueChange={setPickedTaskId}
                                    >
                                        <SelectTrigger className="h-8 text-xs">
                                            <SelectValue placeholder="Project-level time" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value={NO_TASK}>
                                                — Project-level time —
                                            </SelectItem>
                                            {taskOptions.map((opt) => (
                                                <SelectItem
                                                    key={opt.id}
                                                    value={opt.id}
                                                >
                                                    {opt.code ? (
                                                        <span className="font-mono text-[10px] uppercase text-muted-foreground">
                                                            {opt.code}
                                                        </span>
                                                    ) : null}{' '}
                                                    {opt.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <Input
                                        placeholder="What are you working on? (optional)"
                                        value={description}
                                        onChange={(e) =>
                                            setDescription(e.target.value)
                                        }
                                        className="h-8 text-xs"
                                    />
                                    <Button
                                        type="button"
                                        size="sm"
                                        className="w-full gap-2"
                                        onClick={handleQuickStart}
                                        disabled={submitting}
                                    >
                                        {submitting ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Play
                                                className="h-3.5 w-3.5 fill-current"
                                                strokeWidth={0}
                                            />
                                        )}
                                        Start timer
                                    </Button>
                                </div>
                            )}

                            {/* --- My recent entries --------------- */}
                            {recentEntries.length > 0 && (
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                        <span>Your recent entries</span>
                                        <Link
                                            to="/time"
                                            className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-primary hover:underline"
                                            title="Manage all your time entries"
                                        >
                                            All
                                            <ExternalLink className="h-3 w-3" />
                                        </Link>
                                    </div>
                                    <ul className="divide-y rounded-md border">
                                        {recentEntries.slice(0, 5).map((row) => (
                                            <EntryRow
                                                key={row.id}
                                                entry={row}
                                                onDelete={() => handleDelete(row.id)}
                                            />
                                        ))}
                                    </ul>
                                    <p className="text-[11px] text-muted-foreground">
                                        Manual entries and edits live on the{' '}
                                        <Link
                                            to="/time"
                                            className="text-primary hover:underline"
                                        >
                                            Time tracking page
                                        </Link>
                                        .
                                    </p>
                                </div>
                            )}
                        </>
                    )}
                </CardContent>
            )}
        </Card>
    );
}

function Stat({ label, seconds, primary }) {
    return (
        <div
            className={cn(
                'rounded-md border bg-card px-2 py-2',
                primary && 'border-primary/40 bg-primary/5',
            )}
        >
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
            </div>
            <div
                className={cn(
                    'mt-0.5 font-mono text-base tabular-nums',
                    primary ? 'text-foreground' : 'text-foreground/80',
                )}
            >
                {formatDuration(seconds)}
            </div>
        </div>
    );
}

function ContributorRow({ user, seconds, totalSeconds, isMe, liveBoost }) {
    const liveTotal = (seconds || 0) + (liveBoost || 0);
    const pct = totalSeconds > 0 ? (liveTotal / totalSeconds) * 100 : 0;
    const avatar = resolveAssetUrl(user.avatarUrl);
    return (
        <li className="space-y-0.5">
            <div className="flex items-center justify-between gap-2 text-sm">
                <div className="flex min-w-0 items-center gap-1.5">
                    <Avatar className="h-5 w-5">
                        {avatar && <AvatarImage src={avatar} alt={user.name || ''} />}
                        <AvatarFallback className="bg-muted text-[9px]">
                            {initials(user.name)}
                        </AvatarFallback>
                    </Avatar>
                    <span className="truncate">
                        {user.name || 'Unknown'}
                        {isMe && (
                            <span className="ml-1 text-[10px] font-semibold uppercase text-muted-foreground">
                                you
                            </span>
                        )}
                    </span>
                </div>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {formatDuration(liveTotal)}
                </span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-muted">
                <div
                    className="h-full bg-primary/70"
                    style={{ width: `${Math.min(100, pct)}%` }}
                />
            </div>
        </li>
    );
}

function EntryRow({ entry, onDelete }) {
    const taskTitle = entry.task?.title;
    const desc = entry.description;
    const taskCode = entry.task?.code;
    const isRunning = !entry.endedAt;
    const seconds = isRunning
        ? elapsedSecondsSince(entry.startedAt)
        : entry.durationSeconds || 0;
    return (
        <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
            <div className="min-w-0">
                <div className="truncate font-medium">
                    {taskTitle ? (
                        <>
                            {taskCode && (
                                <span className="mr-1 font-mono text-[10px] uppercase text-muted-foreground">
                                    {taskCode}
                                </span>
                            )}
                            {taskTitle}
                        </>
                    ) : (
                        <span className="italic text-muted-foreground">
                            Project-level time
                        </span>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    <span>
                        {format(new Date(entry.startedAt), "MMM d, h:mm a")}
                    </span>
                    {desc && <span className="truncate">· {desc}</span>}
                    {entry.fromPersonalProject && (
                        <span
                            className="inline-flex items-center gap-1 rounded border border-violet-200 bg-violet-50 px-1.5 py-px text-[10px] text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300"
                            title={`From personal project: ${entry.fromPersonalProject.name}`}
                        >
                            <UserIcon className="h-2.5 w-2.5" />
                            Personal · {entry.fromPersonalProject.name}
                        </span>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-1">
                <span
                    className={cn(
                        'font-mono text-xs tabular-nums',
                        isRunning
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : 'text-muted-foreground',
                    )}
                >
                    {isRunning
                        ? formatTickerHM(seconds)
                        : formatDuration(seconds)}
                </span>
                {!isRunning && (
                    <button
                        type="button"
                        onClick={onDelete}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label="Delete entry"
                        title="Delete entry"
                    >
                        <Trash2 className="h-3 w-3" />
                    </button>
                )}
            </div>
        </li>
    );
}

