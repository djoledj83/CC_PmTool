// Top-bar pill that always shows the user's currently-running timer
// (or a "Start timer" trigger when nothing is running). Clicking
// "Start timer" opens a small popover with a project picker so the
// user can begin tracking from anywhere in the app.
//
// Project + task choices: we lazily fetch the user's accessible
// projects when the popover first opens. Tasks for the picked project
// are loaded the moment a project is selected. This keeps the cost at
// zero for users who never open the picker.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Pause, Play, Square, Timer as TimerIcon } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
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
import { elapsedSecondsSince, formatTickerHM } from '@/lib/time';
import { cn } from '@/lib/utils';

const NO_TASK = '__no_task__';

export function ActiveTimerWidget() {
    const { entry, startTimer, stopTimer } = useActiveTimer();
    const [open, setOpen] = useState(false);
    const [stopping, setStopping] = useState(false);

    // Live ticking elapsed counter when a timer is running. We refresh
    // the displayed value once a second; the pill stays compact so a
    // short interval keeps the UX smooth without thrashing the app.
    const [, forceTick] = useState(0);
    useEffect(() => {
        if (!entry) return undefined;
        const id = setInterval(() => forceTick((n) => n + 1), 1000);
        return () => clearInterval(id);
    }, [entry]);

    if (entry) {
        const elapsed = elapsedSecondsSince(entry.startedAt);
        const projectName = entry.project?.name || 'Project';
        const taskTitle = entry.task?.title || null;
        // When the timer is on a subtask we want the user to know
        // which parent it's under — "Review" is much less ambiguous
        // as "Auth flow → Review" both in the pill (truncated) and
        // in the hover tooltip.
        const parentTitle = entry.task?.parent?.title || null;
        const taskPath = taskTitle
            ? parentTitle
                ? `${parentTitle} → ${taskTitle}`
                : taskTitle
            : null;
        const projectHref = entry.project?.id
            ? `/projects/${entry.project.id}`
            : null;
        const handleStop = async () => {
            setStopping(true);
            try {
                await stopTimer();
                toast.success('Timer stopped');
            } catch (err) {
                toast.error(
                    err.response?.data?.error || 'Could not stop timer',
                );
            } finally {
                setStopping(false);
            }
        };
        return (
            <div className="flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-1 py-0.5 text-emerald-800 shadow-sm dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
                <Link
                    to={projectHref || '#'}
                    onClick={(e) => {
                        if (!projectHref) e.preventDefault();
                    }}
                    className="flex max-w-[44vw] items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium transition-colors hover:bg-emerald-100/80 dark:hover:bg-emerald-500/20 sm:max-w-[260px]"
                    title={
                        taskPath
                            ? `${projectName} · ${taskPath}`
                            : projectName
                    }
                >
                    <span className="relative flex h-2 w-2 shrink-0">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                    </span>
                    <span className="truncate">
                        {taskPath || projectName}
                    </span>
                    <span className="ml-0.5 hidden font-mono text-xs tabular-nums text-emerald-700 dark:text-emerald-300 sm:inline">
                        {formatTickerHM(elapsed)}
                    </span>
                </Link>
                <button
                    type="button"
                    onClick={handleStop}
                    disabled={stopping}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50 dark:text-emerald-200 dark:hover:bg-emerald-500/20"
                    aria-label="Stop timer"
                    title="Stop timer"
                >
                    {stopping ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <Square
                            className="h-3.5 w-3.5 fill-current"
                            strokeWidth={0}
                        />
                    )}
                </button>
            </div>
        );
    }

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        'flex h-9 items-center gap-1.5 rounded-md border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                        // Hide label on very narrow screens; icon stays.
                        'sm:gap-2',
                    )}
                    aria-label="Start a timer"
                    title="Start a timer"
                >
                    <TimerIcon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Start timer</span>
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-3">
                <StartTimerForm
                    onStarted={(newEntry) => {
                        setOpen(false);
                        toast.success(
                            newEntry?.project?.name
                                ? `Timer started on ${newEntry.project.name}`
                                : 'Timer started',
                        );
                    }}
                    onStart={startTimer}
                />
            </PopoverContent>
        </Popover>
    );
}

// Self-contained start form. Kept inside this file because it's only
// ever rendered by the widget's popover and there's no reuse value in
// putting it elsewhere yet.
function StartTimerForm({ onStart, onStarted }) {
    const { user: currentUser } = useAuth();
    // Mirror the rule enforced by POST /api/time/start on the server:
    // non-admin/non-manager users may only pin a timer to tasks
    // assigned to them. The project owner gets the elevated path so
    // personal projects keep working when the owner happens not to be
    // the assignee on every task.
    const elevated =
        currentUser?.role === 'ADMIN' || currentUser?.role === 'MANAGER';
    const [projects, setProjects] = useState([]);
    const [projectsLoading, setProjectsLoading] = useState(false);
    const [projectId, setProjectId] = useState('');
    const [tasks, setTasks] = useState([]);
    const [tasksLoading, setTasksLoading] = useState(false);
    const [taskId, setTaskId] = useState(NO_TASK);
    const [description, setDescription] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const cancelledRef = useRef(false);

    useEffect(() => {
        cancelledRef.current = false;
        setProjectsLoading(true);
        api.get('/projects')
            .then((res) => {
                if (cancelledRef.current) return;
                setProjects(res.data?.projects || []);
            })
            .catch((err) => {
                console.warn(
                    '[active-timer] could not load projects:',
                    err?.message,
                );
            })
            .finally(() => {
                if (!cancelledRef.current) setProjectsLoading(false);
            });
        return () => {
            cancelledRef.current = true;
        };
    }, []);

    // Reload tasks whenever the user picks a new project. We re-use
    // the existing /api/tasks endpoint with a project filter; only
    // top-level tasks make sense as a default tracking target, but
    // we include subtasks too so the user can pin time at the leaf.
    useEffect(() => {
        if (!projectId) {
            setTasks([]);
            setTaskId(NO_TASK);
            return undefined;
        }
        let cancelled = false;
        setTasksLoading(true);
        api.get('/tasks', { params: { projectId } })
            .then((res) => {
                if (cancelled) return;
                setTasks(res.data?.tasks || []);
                setTaskId(NO_TASK);
            })
            .catch(() => {
                if (cancelled) return;
                setTasks([]);
            })
            .finally(() => {
                if (!cancelled) setTasksLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    const projectOptions = useMemo(
        () => projects.map((p) => ({ id: p.id, label: p.name, code: p.code })),
        [projects],
    );

    const taskOptions = useMemo(() => {
        const project = projects.find((p) => p.id === projectId);
        const isOwner =
            project?.ownerId && project.ownerId === currentUser?.id;
        const seeAll = elevated || isOwner;

        const tasksById = new Map(tasks.map((t) => [t.id, t]));
        const childrenByParent = new Map();
        for (const t of tasks) {
            if (!t.parentTaskId) continue;
            if (!childrenByParent.has(t.parentTaskId)) {
                childrenByParent.set(t.parentTaskId, []);
            }
            childrenByParent.get(t.parentTaskId).push(t);
        }

        const out = [];
        if (seeAll) {
            for (const top of tasks.filter((t) => !t.parentTaskId)) {
                out.push({ id: top.id, label: top.title, code: top.code });
                for (const c of childrenByParent.get(top.id) || []) {
                    out.push({
                        id: c.id,
                        label: `↳ ${c.title}`,
                        code: c.code,
                    });
                }
            }
            return out;
        }

        // Regular users see only their assigned tasks. Orphaned
        // subtasks (parent isn't theirs) read as "Parent → Subtask" so
        // the entry never collapses into a dangling arrow.
        const mine = tasks.filter((t) => t.assigneeId === currentUser?.id);
        for (const t of mine) {
            if (!t.parentTaskId) {
                out.push({ id: t.id, label: t.title, code: t.code });
                for (const c of childrenByParent.get(t.id) || []) {
                    if (c.assigneeId !== currentUser?.id) continue;
                    out.push({
                        id: c.id,
                        label: `↳ ${c.title}`,
                        code: c.code,
                    });
                }
            } else {
                const parent = tasksById.get(t.parentTaskId);
                if (parent && parent.assigneeId === currentUser?.id) continue;
                const parentLabel = parent?.title || 'Task';
                out.push({
                    id: t.id,
                    label: `${parentLabel} → ${t.title}`,
                    code: t.code,
                });
            }
        }
        return out;
    }, [tasks, projects, projectId, currentUser?.id, elevated]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!projectId) {
            toast.error('Pick a project first');
            return;
        }
        setSubmitting(true);
        try {
            const newEntry = await onStart({
                projectId,
                taskId: taskId !== NO_TASK ? taskId : undefined,
                description: description.trim() || undefined,
            });
            onStarted?.(newEntry);
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not start timer',
            );
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
                <Label className="text-xs">Project</Label>
                <Select
                    value={projectId}
                    onValueChange={setProjectId}
                    disabled={projectsLoading}
                >
                    <SelectTrigger>
                        <SelectValue
                            placeholder={
                                projectsLoading
                                    ? 'Loading projects…'
                                    : 'Pick a project'
                            }
                        />
                    </SelectTrigger>
                    <SelectContent>
                        {projectOptions.map((opt) => (
                            <SelectItem key={opt.id} value={opt.id}>
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
            </div>

            <div className="space-y-1.5">
                <Label className="text-xs">Task (optional)</Label>
                <Select
                    value={taskId}
                    onValueChange={setTaskId}
                    disabled={!projectId || tasksLoading}
                >
                    <SelectTrigger>
                        <SelectValue
                            placeholder={
                                !projectId
                                    ? 'Pick a project first'
                                    : tasksLoading
                                        ? 'Loading tasks…'
                                        : 'Project-level time'
                            }
                        />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={NO_TASK}>
                            — Project-level time —
                        </SelectItem>
                        {taskOptions.map((opt) => (
                            <SelectItem key={opt.id} value={opt.id}>
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
            </div>

            <div className="space-y-1.5">
                <Label className="text-xs">Note (optional)</Label>
                <Input
                    placeholder="What are you working on?"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                />
            </div>

            <Button
                type="submit"
                size="sm"
                className="w-full gap-2"
                disabled={!projectId || submitting}
            >
                {submitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                    <Play className="h-3.5 w-3.5 fill-current" strokeWidth={0} />
                )}
                Start timer
            </Button>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Pause className="h-3 w-3" />
                Time logged on a task automatically rolls up to the project.
            </p>
        </form>
    );
}
