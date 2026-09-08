// Pulled out of `pages/Activities.jsx` so the Todos page can also embed
// the "My activities" / "All activities" lists as tabs. Renders a
// filterable, bucketed list of ProjectActivity rows with a checkbox to
// toggle "done" inline.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    format,
    isPast,
    isToday,
    isTomorrow,
    isYesterday,
} from 'date-fns';
import { Check, CalendarClock } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { kindMeta } from '@/components/PlanActivities';

const STATUS_OPTIONS = [
    { id: 'open', label: 'Open' },
    { id: 'overdue', label: 'Overdue only' },
    { id: 'done', label: 'Completed' },
    { id: 'all', label: 'All statuses' },
];

const KIND_OPTIONS = [
    { id: 'all', label: 'All kinds' },
    { id: 'CALL', label: 'Calls' },
    { id: 'MEETING', label: 'Meetings' },
    { id: 'REMINDER', label: 'Reminders' },
    { id: 'COMMENT', label: 'Comments' },
    { id: 'DOCUMENT', label: 'Documents' },
    { id: 'OTHER', label: 'Other' },
];

const TIME_OPTIONS = [
    { id: '7d', label: 'Last 7 days' },
    { id: '30d', label: 'Last 30 days' },
    { id: '90d', label: 'Last 90 days' },
    { id: 'all', label: 'All time' },
];

function whenLabel(d) {
    if (!d) return null;
    const date = new Date(d);
    if (isToday(date)) return `Today, ${format(date, 'HH:mm')}`;
    if (isTomorrow(date)) return `Tomorrow, ${format(date, 'HH:mm')}`;
    if (isYesterday(date)) return `Yesterday, ${format(date, 'HH:mm')}`;
    return format(date, 'EEE, MMM d · HH:mm');
}

function bucketFor(activity) {
    if (activity.done) return 'Completed';
    if (!activity.scheduledAt) return 'No date';
    const d = new Date(activity.scheduledAt);
    if (isPast(d) && !isToday(d)) return 'Overdue';
    if (isToday(d)) return 'Today';
    if (isTomorrow(d)) return 'Tomorrow';
    return 'Later';
}

const BUCKET_ORDER = [
    'Overdue',
    'Today',
    'Tomorrow',
    'Later',
    'No date',
    'Completed',
];

export function PlanActivityList({ scope, currentUserId, isAdmin }) {
    // scope: 'mine' | 'all'
    const [activities, setActivities] = useState([]);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState('open');
    const [kind, setKind] = useState('all');
    const [since, setSince] = useState(scope === 'mine' ? '90d' : '30d');
    const [version, setVersion] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        const params = { since };
        if (scope === 'mine') params.assignee = 'me';
        if (status !== 'all') params.status = status;
        api.get('/plan-activities', { params })
            .then((res) => {
                if (cancelled) return;
                const list = res.data.activities || [];
                setActivities(
                    kind === 'all' ? list : list.filter((a) => a.kind === kind),
                );
            })
            .catch(() => {
                if (!cancelled) setActivities([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [scope, status, kind, since, version]);

    const grouped = useMemo(() => {
        const map = new Map();
        for (const a of activities) {
            const b = bucketFor(a);
            if (!map.has(b)) map.set(b, []);
            map.get(b).push(a);
        }
        return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({
            bucket: b,
            items: map.get(b),
        }));
    }, [activities]);

    const toggleDone = async (activity) => {
        try {
            await api.patch(`/plan-activities/${activity.id}`, {
                done: !activity.done,
            });
            setVersion((v) => v + 1);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update');
        }
    };

    const totals = useMemo(() => {
        let overdue = 0;
        let today = 0;
        for (const a of activities) {
            if (a.done) continue;
            const b = bucketFor(a);
            if (b === 'Overdue') overdue += 1;
            if (b === 'Today') today += 1;
        }
        return { overdue, today, total: activities.length };
    }, [activities]);

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 shadow-sm">
                <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger className="h-8 w-[150px] text-xs">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {STATUS_OPTIONS.map((o) => (
                            <SelectItem key={o.id} value={o.id}>
                                {o.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Select value={kind} onValueChange={setKind}>
                    <SelectTrigger className="h-8 w-[140px] text-xs">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {KIND_OPTIONS.map((o) => (
                            <SelectItem key={o.id} value={o.id}>
                                {o.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Select value={since} onValueChange={setSince}>
                    <SelectTrigger className="h-8 w-[140px] text-xs">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {TIME_OPTIONS.map((o) => (
                            <SelectItem key={o.id} value={o.id}>
                                {o.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                    {totals.overdue > 0 && (
                        <span className="rounded bg-rose-100 px-2 py-0.5 font-semibold text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">
                            {totals.overdue} overdue
                        </span>
                    )}
                    {totals.today > 0 && (
                        <span className="rounded bg-sky-100 px-2 py-0.5 font-semibold text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">
                            {totals.today} today
                        </span>
                    )}
                    <span>{totals.total} total</span>
                </div>
            </div>

            {loading ? (
                <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground shadow-sm">
                    Loading activities…
                </div>
            ) : grouped.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-card p-12 text-center shadow-sm">
                    <CalendarClock className="h-10 w-10 text-muted-foreground" />
                    <p className="font-medium">
                        {scope === 'mine'
                            ? 'No activities are assigned to you'
                            : 'No matching activities'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                        {scope === 'mine'
                            ? 'Activities scheduled on your projects will appear here.'
                            : 'Try widening your filters or extending the time range.'}
                    </p>
                </div>
            ) : (
                <div className="space-y-5">
                    {grouped.map((g) => (
                        <div key={g.bucket}>
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {g.bucket}
                                <span className="ml-1 text-muted-foreground/70">
                                    ({g.items.length})
                                </span>
                            </h3>
                            <ul className="space-y-2">
                                {g.items.map((a) => (
                                    <PlanActivityCard
                                        key={a.id}
                                        activity={a}
                                        showAssignee={scope !== 'mine'}
                                        currentUserId={currentUserId}
                                        isAdmin={isAdmin}
                                        onToggleDone={() => toggleDone(a)}
                                    />
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function PlanActivityCard({
    activity,
    showAssignee,
    currentUserId,
    isAdmin,
    onToggleDone,
}) {
    const meta = kindMeta(activity.kind);
    const Icon = meta.icon;
    const isOverdue =
        !activity.done &&
        activity.scheduledAt &&
        new Date(activity.scheduledAt).getTime() < Date.now();
    const canCheck =
        isAdmin ||
        activity.assigneeId === currentUserId ||
        activity.createdById === currentUserId;
    return (
        <li className="flex items-start gap-3 rounded-lg border bg-card p-3 shadow-sm">
            <button
                type="button"
                onClick={onToggleDone}
                disabled={!canCheck}
                title={
                    canCheck
                        ? activity.done
                            ? 'Mark as open'
                            : 'Mark as done'
                        : 'Only the assignee, creator, or an admin can change this.'
                }
                className={cn(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
                    activity.done
                        ? 'border-emerald-500 bg-emerald-500 text-white'
                        : 'border-muted-foreground/40 hover:border-emerald-500',
                    !canCheck && 'cursor-not-allowed opacity-60',
                )}
            >
                {activity.done && <Check className="h-3 w-3" />}
            </button>

            <span
                className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                    meta.chip,
                )}
                title={meta.label}
            >
                <Icon className="h-4 w-4" />
            </span>

            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <Link
                        to={`/projects/${activity.project.id}#activity-${activity.id}`}
                        className={cn(
                            'truncate text-sm font-medium hover:underline',
                            activity.done && 'text-muted-foreground line-through',
                        )}
                    >
                        {activity.title}
                    </Link>
                    <span
                        className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                            meta.chip,
                        )}
                    >
                        {meta.label}
                    </span>
                    {isOverdue && (
                        <span className="shrink-0 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">
                            Overdue
                        </span>
                    )}
                </div>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    {activity.project && (
                        <Link
                            to={`/projects/${activity.project.id}`}
                            className="font-medium text-foreground/80 hover:underline"
                        >
                            {activity.project.name}
                        </Link>
                    )}
                    {activity.phase && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                            {activity.phase.name}
                        </span>
                    )}
                    {activity.scheduledAt && (
                        <span
                            className={cn(
                                isOverdue && 'text-rose-600 dark:text-rose-400',
                            )}
                        >
                            {whenLabel(activity.scheduledAt)}
                        </span>
                    )}
                </p>
                {activity.details && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {activity.details}
                    </p>
                )}
            </div>

            {showAssignee && activity.assignee && (
                <Avatar
                    className="h-7 w-7 shrink-0"
                    title={activity.assignee.name || activity.assignee.email}
                >
                    {activity.assignee.avatarUrl && (
                        <AvatarImage
                            src={resolveAssetUrl(activity.assignee.avatarUrl)}
                            alt=""
                        />
                    )}
                    <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                        {initials(
                            activity.assignee.name || activity.assignee.email,
                        )}
                    </AvatarFallback>
                </Avatar>
            )}
        </li>
    );
}
