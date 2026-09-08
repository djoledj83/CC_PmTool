import { useEffect, useState } from 'react';
import { format, isToday, isYesterday, parseISO } from 'date-fns';

import { api } from '@/lib/api';
import { formatDuration } from '@/lib/time';
import { cn } from '@/lib/utils';

function dayBoundsIso(dateValue) {
    const [y, m, d] = dateValue.split('-').map((s) => parseInt(s, 10));
    if (!y || !m || !d) return null;
    const start = new Date(y, m - 1, d, 0, 0, 0, 0);
    const end = new Date(y, m - 1, d, 23, 59, 59, 999);
    return { from: start.toISOString(), to: end.toISOString() };
}

function labelForDate(dateValue) {
    if (!dateValue) return 'this day';
    const date = parseISO(`${dateValue}T12:00:00`);
    if (Number.isNaN(date.getTime())) return dateValue;
    if (isToday(date)) return 'today';
    if (isYesterday(date)) return 'yesterday';
    return format(date, 'MMM d, yyyy');
}

/**
 * Shows how much time the signed-in user already logged on the picked
 * date — the total plus the individual entries (task, duration, note)
 * so retroactive logging is informed by what's already there.
 * Updates when the date changes or after a successful save
 * (refreshToken bump).
 */
export default function LogTimeDaySummary({
    dateValue,
    taskId = null,
    refreshToken = 0,
}) {
    const [loading, setLoading] = useState(false);
    const [entries, setEntries] = useState([]);
    const [totalSeconds, setTotalSeconds] = useState(0);
    const [taskSeconds, setTaskSeconds] = useState(0);

    useEffect(() => {
        if (!dateValue) return undefined;
        const bounds = dayBoundsIso(dateValue);
        if (!bounds) return undefined;

        let cancelled = false;
        setLoading(true);
        api.get('/time/me', {
            params: { ...bounds, limit: 500 },
        })
            .then(({ data }) => {
                if (cancelled) return;
                const list = data?.entries || [];
                let total = 0;
                let onTask = 0;
                for (const e of list) {
                    const sec = e.durationSeconds || 0;
                    total += sec;
                    if (taskId && e.taskId === taskId) onTask += sec;
                }
                // Oldest first so the list reads like the day happened.
                setEntries(
                    [...list].sort(
                        (a, b) =>
                            new Date(a.startedAt).getTime() -
                            new Date(b.startedAt).getTime(),
                    ),
                );
                setTotalSeconds(total);
                setTaskSeconds(onTask);
            })
            .catch(() => {
                if (!cancelled) {
                    setEntries([]);
                    setTotalSeconds(0);
                    setTaskSeconds(0);
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [dateValue, taskId, refreshToken]);

    const dayLabel = labelForDate(dateValue);

    return (
        <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {loading ? (
                <span>Checking your logged time…</span>
            ) : (
                <>
                    <span>
                        Logged {dayLabel}:{' '}
                        <span className="font-medium text-foreground">
                            {totalSeconds > 0
                                ? formatDuration(totalSeconds)
                                : '0h'}
                        </span>
                    </span>
                    {taskId && (
                        <span className="text-muted-foreground">
                            {' '}
                            · on this task:{' '}
                            <span className="font-medium text-foreground">
                                {taskSeconds > 0
                                    ? formatDuration(taskSeconds)
                                    : '0h'}
                            </span>
                        </span>
                    )}

                    {/* The day's entries, oldest first — task, duration
                        and note — so the user can see exactly what's
                        already logged before adding more. The current
                        task's entries are emphasised. */}
                    {entries.length > 0 && (
                        <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto border-t border-dashed pt-2">
                            {entries.map((e) => {
                                const isThisTask =
                                    taskId && e.taskId === taskId;
                                const taskLabel = e.task
                                    ? e.task.parent
                                        ? `${e.task.parent.title} → ${e.task.title}`
                                        : e.task.title
                                    : e.project?.name || 'No task';
                                return (
                                    <li
                                        key={e.id}
                                        className={cn(
                                            'flex items-start gap-2',
                                            isThisTask && 'text-foreground',
                                        )}
                                        title={e.description || undefined}
                                    >
                                        <span className="w-14 shrink-0 font-medium tabular-nums text-foreground">
                                            {formatDuration(
                                                e.durationSeconds || 0,
                                            )}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            {e.task?.code && (
                                                <span className="mr-1 font-mono text-[10px]">
                                                    {e.task.code}
                                                </span>
                                            )}
                                            <span
                                                className={cn(
                                                    isThisTask &&
                                                        'font-medium',
                                                )}
                                            >
                                                {taskLabel}
                                            </span>
                                            {e.description && (
                                                <span className="mt-0.5 block break-words text-muted-foreground/80 line-clamp-2">
                                                    “{e.description}”
                                                </span>
                                            )}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </>
            )}
        </div>
    );
}
