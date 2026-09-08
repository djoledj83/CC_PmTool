// Lightweight "log time on this task" dialog — opened from the action
// row on any task / subtask in the Plan view (next to the Note /
// Reassign / Delete buttons). It mirrors the manual form on the Time
// Tracking page but stays in-context: the user picks a date + duration,
// optionally writes a description, and we POST to /time with the task
// + project pre-filled. On success we close, toast, and let the parent
// optionally refresh.
//
// We re-derive startedAt / endedAt the same way TimeTracking.jsx does:
// if the date is today, the block ends "now"; otherwise it ends at
// noon on that day. This keeps the entry sitting naturally in the
// day's timeline whether you log "right now" or backfill yesterday.
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { Tip } from '@/components/Tip';
import LogTimeDaySummary from '@/components/LogTimeDaySummary';
import CrossUserReasonFields from '@/components/CrossUserReasonFields';
import { useAuth } from '@/contexts/AuthContext';
import { isOthersTask, assigneeLabel } from '@/lib/timeReason';

// 15-min steps for short entries (15m, 30m, 45m) and then **strict
// 30-min increments** from 1h all the way to 8h. The previous list
// jumped from 2h straight to 3h, which broke the "I logged 2h 30m"
// case the same way "1.5 hr" broke the labels.
//
// Labels use the "Xh Ym" format (matches formatHoursAsHM + the
// sprint KPIs / capacity heatmap / burndown) so the user never has
// to translate between "1.5 hr" and "1h 30m" mentally.
function buildDurationLabel(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m} min`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

const DURATION_OPTIONS = (() => {
    const out = [
        { value: 15, label: '15 min' },
        { value: 30, label: '30 min' },
        { value: 45, label: '45 min' },
    ];
    for (let mins = 60; mins <= 8 * 60; mins += 30) {
        out.push({ value: mins, label: buildDurationLabel(mins) });
    }
    return out;
})();

function todayDateValue() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function deriveStartEnd(dateString, durationMinutes) {
    const [y, m, d] = dateString.split('-').map((s) => parseInt(s, 10));
    if (!y || !m || !d) throw new Error('Invalid date');
    const baseDate = new Date(y, m - 1, d);
    const isTodayDate = (() => {
        const t = new Date();
        return (
            t.getFullYear() === baseDate.getFullYear() &&
            t.getMonth() === baseDate.getMonth() &&
            t.getDate() === baseDate.getDate()
        );
    })();
    let endedAt;
    if (isTodayDate) {
        endedAt = new Date();
    } else {
        // Anchor at noon on the chosen day so the entry sits in the
        // middle of the day's timeline; exact clock time isn't
        // meaningful for after-the-fact tracking.
        endedAt = new Date(baseDate);
        endedAt.setHours(12, 0, 0, 0);
    }
    const startedAt = new Date(
        endedAt.getTime() - durationMinutes * 60 * 1000,
    );
    return {
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
    };
}

export default function LogTimeDialog({
    open,
    task,
    // Personal to-do from /api/todos — time is logged on the linked
    // project at project level (no taskId) with the to-do title in
    // the description.
    todo,
    projectId: projectIdProp,
    projectName: projectNameProp,
    onClose,
    // Called after a successful POST. The parent decides whether it
    // wants to refresh the plan (estimates / actuals badges, etc.).
    onLogged,
}) {
    const { user } = useAuth();
    const [dateValue, setDateValue] = useState(todayDateValue);
    const [durationMinutes, setDurationMinutes] = useState(60);
    const [description, setDescription] = useState('');
    const [crossReason, setCrossReason] = useState('');
    const [crossNote, setCrossNote] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [summaryRefresh, setSummaryRefresh] = useState(0);

    // True when logging on a task that belongs to someone else — gates
    // the reason block + a required category before we allow submit.
    const othersTask = useMemo(
        () => Boolean(task) && isOthersTask(task, user?.id),
        [task, user?.id],
    );

    const projectId =
        projectIdProp || todo?.projectId || todo?.project?.id || null;
    const projectName =
        projectNameProp || todo?.project?.name || null;
    const subjectId = task?.id || todo?.id;

    // Reset the form every time the dialog reopens for a new item so
    // we don't leak the previous task's description.
    useEffect(() => {
        if (!open) return;
        setDateValue(todayDateValue());
        setDurationMinutes(60);
        setDescription('');
        setCrossReason('');
        setCrossNote('');
        setSubmitting(false);
        setSummaryRefresh(0);
    }, [open, subjectId]);

    const targetTitle = useMemo(() => {
        if (task) {
            const code = task.code ? `${task.code} · ` : '';
            return `${code}${task.title || 'task'}`;
        }
        if (todo) return todo.title || 'to-do';
        return '';
    }, [task, todo]);

    const handleSubmit = async (e) => {
        e?.preventDefault?.();
        if ((!task && !todo) || !projectId) {
            toast.error(
                todo && !projectId
                    ? 'Link this to-do to a project before logging time'
                    : 'Missing task or project',
            );
            return;
        }
        if (!durationMinutes || durationMinutes <= 0) {
            toast.error('Pick a duration');
            return;
        }
        if (othersTask && !crossReason) {
            toast.error(
                'Pick a reason for logging on someone else’s task',
            );
            return;
        }
        let scope;
        try {
            scope = deriveStartEnd(dateValue, durationMinutes);
        } catch {
            toast.error('Invalid date');
            return;
        }
        const note = description.trim();
        const payload = {
            projectId,
            startedAt: scope.startedAt,
            endedAt: scope.endedAt,
        };
        if (task) {
            payload.taskId = task.id;
            if (note) payload.description = note;
            if (othersTask) {
                payload.crossUserReason = crossReason;
                if (crossNote.trim()) payload.crossUserNote = crossNote.trim();
            }
        } else if (todo) {
            payload.description = note
                ? `Personal to-do: ${todo.title} — ${note}`
                : `Personal to-do: ${todo.title}`;
        }
        setSubmitting(true);
        try {
            await api.post('/time', payload);
            const human =
                DURATION_OPTIONS.find((o) => o.value === durationMinutes)
                    ?.label || `${durationMinutes} min`;
            toast.success(`Logged ${human} on ${targetTitle}`);
            setSummaryRefresh((n) => n + 1);
            onLogged?.();
            onClose?.();
        } catch (err) {
            toast.error(
                err?.response?.data?.error ||
                    err?.response?.data?.message ||
                    'Could not log time',
            );
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog
            open={!!open}
            onOpenChange={(v) => {
                if (!v && !submitting) onClose?.();
            }}
        >
            <DialogContent className="max-w-[420px] overflow-hidden sm:max-w-[420px]">
                <DialogHeader>
                    <DialogTitle>Log time</DialogTitle>
                    <DialogDescription className="text-xs">
                        {task || todo ? (
                            <>
                                On{' '}
                                <span className="font-medium">{targetTitle}</span>
                                {projectName ? (
                                    <>
                                        {' '}
                                        in{' '}
                                        <span className="font-medium">
                                            {projectName}
                                        </span>
                                    </>
                                ) : null}
                                .
                            </>
                        ) : (
                            'Pick a duration and an optional note.'
                        )}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="min-w-0 space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <div className="flex h-5 items-center">
                                <Label htmlFor="logtime-date" className="text-xs">
                                    Date
                                </Label>
                            </div>
                            <Input
                                id="logtime-date"
                                type="date"
                                value={dateValue}
                                onChange={(e) => setDateValue(e.target.value)}
                                max={todayDateValue()}
                                disabled={submitting}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <div className="flex h-5 items-center gap-1">
                                <Label
                                    htmlFor="logtime-duration"
                                    className="text-xs"
                                >
                                    Duration
                                </Label>
                                <Tip variant="tip" side="top">
                                    <p className="font-medium">
                                        Use the live timer for long sessions.
                                    </p>
                                    <p className="mt-1 text-muted-foreground">
                                        Manual entries snap to 30-minute
                                        steps. If you need exact wall-clock
                                        time (billable hours, focus blocks
                                        over 1h), start the live timer on
                                        the task and stop it when you're
                                        done — seconds are preserved.
                                    </p>
                                </Tip>
                            </div>
                            <Select
                                value={String(durationMinutes)}
                                onValueChange={(v) =>
                                    setDurationMinutes(parseInt(v, 10))
                                }
                                disabled={submitting}
                            >
                                <SelectTrigger id="logtime-duration">
                                    <SelectValue placeholder="Duration" />
                                </SelectTrigger>
                                <SelectContent>
                                    {DURATION_OPTIONS.map((opt) => (
                                        <SelectItem
                                            key={opt.value}
                                            value={String(opt.value)}
                                        >
                                            {opt.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <LogTimeDaySummary
                        dateValue={dateValue}
                        taskId={task?.id || null}
                        refreshToken={summaryRefresh}
                    />
                    {othersTask && (
                        <CrossUserReasonFields
                            assigneeName={assigneeLabel(task)}
                            reason={crossReason}
                            onReasonChange={setCrossReason}
                            note={crossNote}
                            onNoteChange={setCrossNote}
                            disabled={submitting}
                            idPrefix="logtime"
                        />
                    )}
                    <div className="space-y-1.5">
                        <Label htmlFor="logtime-note" className="text-xs">
                            Description{' '}
                            <span className="text-muted-foreground">
                                (optional)
                            </span>
                        </Label>
                        <Textarea
                            id="logtime-note"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="What did you do?"
                            rows={3}
                            disabled={submitting}
                        />
                    </div>
                    <DialogFooter className="gap-2 sm:gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={onClose}
                            disabled={submitting}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={submitting}>
                            {submitting && (
                                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            )}
                            Save entry
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
