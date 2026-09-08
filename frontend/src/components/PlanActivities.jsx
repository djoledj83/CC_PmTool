import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
    CalendarClock,
    Check,
    FileText,
    MessageSquare,
    Pencil,
    Phone,
    Plus,
    Sparkles,
    Trash2,
    Users,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

const NO_ASSIGNEE = '__none__';

// Activity kinds shown in the icon strip of the "+ Activity" dialog.
// Order matches Bitrix-style PM apps (Call, Meeting, Reminder, ...).
export const ACTIVITY_KINDS = [
    {
        key: 'CALL',
        label: 'Call',
        icon: Phone,
        tone: 'text-sky-600 dark:text-sky-400',
        chip: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200',
    },
    {
        key: 'MEETING',
        label: 'Meeting',
        icon: Users,
        tone: 'text-violet-600 dark:text-violet-400',
        chip: 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200',
    },
    {
        key: 'REMINDER',
        label: 'Reminder',
        icon: CalendarClock,
        tone: 'text-amber-600 dark:text-amber-400',
        chip: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200',
    },
    {
        key: 'COMMENT',
        label: 'Comment',
        icon: MessageSquare,
        tone: 'text-emerald-600 dark:text-emerald-400',
        chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200',
    },
    {
        key: 'DOCUMENT',
        label: 'Document',
        icon: FileText,
        tone: 'text-indigo-600 dark:text-indigo-400',
        chip: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200',
    },
    {
        key: 'OTHER',
        label: 'Other',
        icon: Sparkles,
        tone: 'text-slate-600 dark:text-slate-300',
        chip: 'bg-slate-200 text-slate-700 dark:bg-slate-500/30 dark:text-slate-100',
    },
];

const KIND_BY_KEY = ACTIVITY_KINDS.reduce((acc, k) => {
    acc[k.key] = k;
    return acc;
}, {});

export function kindMeta(kind) {
    return KIND_BY_KEY[kind] || KIND_BY_KEY.OTHER;
}

// Convert a possibly-ISO date to a value for <input type="datetime-local">.
function toLocalInput(d) {
    if (!d) return '';
    const date = new Date(d);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(v) {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
}

// Inline activities list shown beneath the tasks of a phase. Renders a
// compact row per activity plus a "+ Activity" affordance for editors.
export function PlanActivities({
    projectId,
    phaseId,
    phaseName,
    activities = [],
    participants = [],
    canManage = false,
    currentUserId = null,
    onMutated,
}) {
    const [dialog, setDialog] = useState({ open: false, activity: null });

    const sorted = useMemo(() => {
        const copy = [...activities];
        copy.sort((a, b) => {
            if (a.done !== b.done) return a.done ? 1 : -1;
            const at = a.scheduledAt
                ? new Date(a.scheduledAt).getTime()
                : Infinity;
            const bt = b.scheduledAt
                ? new Date(b.scheduledAt).getTime()
                : Infinity;
            if (at !== bt) return at - bt;
            return new Date(a.createdAt).getTime() -
                new Date(b.createdAt).getTime();
        });
        return copy;
    }, [activities]);

    const openCreate = () => setDialog({ open: true, activity: null });
    const openEdit = (activity) => setDialog({ open: true, activity });

    const submit = async ({ id, payload }) => {
        try {
            if (id) {
                await api.patch(`/plan-activities/${id}`, payload);
                toast.success('Activity updated');
            } else {
                await api.post('/plan-activities', {
                    ...payload,
                    projectId,
                    phaseId: phaseId || null,
                });
                toast.success('Activity added');
            }
            setDialog({ open: false, activity: null });
            onMutated?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save activity');
        }
    };

    const toggleDone = async (activity) => {
        try {
            await api.patch(`/plan-activities/${activity.id}`, {
                done: !activity.done,
            });
            onMutated?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update');
        }
    };

    const remove = async (activity) => {
        if (!window.confirm(`Delete activity "${activity.title}"?`)) return;
        try {
            await api.delete(`/plan-activities/${activity.id}`);
            toast.success('Activity removed');
            onMutated?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete');
        }
    };

    if (!canManage && sorted.length === 0) return null;

    return (
        <div className="border-t bg-muted/30 px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <CalendarClock className="h-3.5 w-3.5" />
                    Activities
                    {sorted.length > 0 && (
                        <span className="rounded bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {sorted.length}
                        </span>
                    )}
                </div>
                {canManage && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={openCreate}
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Activity
                    </Button>
                )}
            </div>

            {sorted.length === 0 ? (
                <p className="py-1 text-center text-[11px] text-muted-foreground">
                    No activities scheduled for this phase.
                </p>
            ) : (
                <ul className="space-y-1">
                    {sorted.map((a) => (
                        <ActivityRow
                            key={a.id}
                            activity={a}
                            canManage={canManage}
                            currentUserId={currentUserId}
                            onToggleDone={() => toggleDone(a)}
                            onEdit={() => openEdit(a)}
                            onDelete={() => remove(a)}
                        />
                    ))}
                </ul>
            )}

            <ActivityDialog
                open={dialog.open}
                activity={dialog.activity}
                participants={participants}
                phaseName={phaseName}
                currentUserId={currentUserId}
                onClose={() => setDialog({ open: false, activity: null })}
                onSubmit={submit}
            />
        </div>
    );
}

function ActivityRow({
    activity,
    canManage,
    currentUserId,
    onToggleDone,
    onEdit,
    onDelete,
}) {
    const meta = kindMeta(activity.kind);
    const Icon = meta.icon;
    const canCheck =
        canManage ||
        activity.assigneeId === currentUserId ||
        activity.createdById === currentUserId;
    const isOverdue =
        !activity.done &&
        activity.scheduledAt &&
        new Date(activity.scheduledAt).getTime() < Date.now();
    return (
        <li
            id={`activity-${activity.id}`}
            className={cn(
                'flex items-center gap-2 rounded border bg-card px-2 py-1.5 text-sm shadow-sm transition-shadow',
                activity.done && 'opacity-70',
            )}
        >
            <button
                type="button"
                onClick={onToggleDone}
                disabled={!canCheck}
                title={
                    canCheck
                        ? activity.done
                            ? 'Mark as open'
                            : 'Mark as done'
                        : 'Only the assignee, creator, or an editor can change this.'
                }
                className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
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
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                    meta.chip,
                )}
                title={meta.label}
            >
                <Icon className="h-3.5 w-3.5" />
            </span>

            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span
                        className={cn(
                            'truncate text-sm font-medium',
                            activity.done && 'text-muted-foreground line-through',
                        )}
                    >
                        {activity.title}
                    </span>
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
                {activity.details && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                        {activity.details}
                    </p>
                )}
            </div>

            {activity.scheduledAt && (
                <span
                    className={cn(
                        'hidden shrink-0 text-xs text-muted-foreground sm:inline',
                        isOverdue && 'text-rose-600 dark:text-rose-400',
                    )}
                >
                    {format(new Date(activity.scheduledAt), 'MMM d, HH:mm')}
                </span>
            )}

            <AssigneeChip user={activity.assignee} />

            {canManage && (
                <div className="flex shrink-0 items-center">
                    <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={onEdit}
                        title="Edit activity"
                    >
                        <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={onDelete}
                        title="Delete activity"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                </div>
            )}
        </li>
    );
}

function AssigneeChip({ user }) {
    if (!user) {
        return (
            <span className="hidden h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground sm:flex">
                —
            </span>
        );
    }
    return (
        <Avatar className="h-6 w-6 shrink-0" title={user.name || user.email}>
            {user.avatarUrl && (
                <AvatarImage src={resolveAssetUrl(user.avatarUrl)} alt="" />
            )}
            <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                {initials(user.name || user.email)}
            </AvatarFallback>
        </Avatar>
    );
}

function ActivityDialog({
    open,
    activity,
    participants,
    phaseName,
    currentUserId,
    onClose,
    onSubmit,
}) {
    const isEdit = Boolean(activity);
    const [kind, setKind] = useState('MEETING');
    const [title, setTitle] = useState('');
    const [details, setDetails] = useState('');
    const [scheduledAt, setScheduledAt] = useState('');
    const [assigneeId, setAssigneeId] = useState(NO_ASSIGNEE);
    const [showDetails, setShowDetails] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        if (activity) {
            setKind(activity.kind || 'MEETING');
            setTitle(activity.title || '');
            setDetails(activity.details || '');
            setScheduledAt(toLocalInput(activity.scheduledAt));
            setAssigneeId(activity.assigneeId || NO_ASSIGNEE);
            setShowDetails(Boolean(activity.details));
        } else {
            setKind('MEETING');
            setTitle('');
            setDetails('');
            setScheduledAt(toLocalInput(new Date()));
            setAssigneeId(currentUserId || NO_ASSIGNEE);
            setShowDetails(false);
        }
        setSaving(false);
    }, [open, activity, currentUserId]);

    const submit = async (e) => {
        e.preventDefault();
        if (!title.trim()) {
            toast.error('Give the activity a title.');
            return;
        }
        setSaving(true);
        try {
            await onSubmit({
                id: activity?.id || null,
                payload: {
                    kind,
                    title: title.trim(),
                    details: details.trim() || null,
                    scheduledAt: fromLocalInput(scheduledAt),
                    assigneeId: assigneeId === NO_ASSIGNEE ? null : assigneeId,
                },
            });
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {isEdit ? 'Edit activity' : 'New activity'}
                    </DialogTitle>
                    <DialogDescription>
                        {phaseName
                            ? `Schedule a meeting, call or note for the ${phaseName} phase.`
                            : 'Schedule a meeting, call or note for this project.'}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="space-y-3">
                    <div className="flex flex-wrap gap-1">
                        {ACTIVITY_KINDS.map((k) => {
                            const Icon = k.icon;
                            const active = kind === k.key;
                            return (
                                <button
                                    key={k.key}
                                    type="button"
                                    onClick={() => setKind(k.key)}
                                    className={cn(
                                        'flex h-9 w-9 items-center justify-center rounded-md border transition-colors',
                                        active
                                            ? cn(k.chip, 'border-transparent')
                                            : 'border-border bg-background text-muted-foreground hover:bg-accent',
                                    )}
                                    title={k.label}
                                >
                                    <Icon className="h-4 w-4" />
                                </button>
                            );
                        })}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="activity-title">Title</Label>
                        <Input
                            id="activity-title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder={kindMeta(kind).label}
                            autoFocus
                        />
                    </div>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="activity-assignee">Assignee</Label>
                            <Select
                                value={assigneeId}
                                onValueChange={setAssigneeId}
                            >
                                <SelectTrigger id="activity-assignee">
                                    <SelectValue placeholder="Unassigned" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NO_ASSIGNEE}>
                                        Unassigned
                                    </SelectItem>
                                    {participants.map((p) => (
                                        <SelectItem key={p.id} value={p.id}>
                                            {p.name || p.email}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="activity-when">Date</Label>
                            <Input
                                id="activity-when"
                                type="datetime-local"
                                value={scheduledAt}
                                onChange={(e) => setScheduledAt(e.target.value)}
                            />
                        </div>
                    </div>

                    {showDetails ? (
                        <div className="space-y-1.5">
                            <Label htmlFor="activity-details">Details</Label>
                            <Textarea
                                id="activity-details"
                                rows={3}
                                value={details}
                                onChange={(e) => setDetails(e.target.value)}
                                placeholder="Optional notes…"
                            />
                        </div>
                    ) : (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => setShowDetails(true)}
                        >
                            Add more details
                        </Button>
                    )}

                    <DialogFooter className="gap-2 sm:gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={onClose}
                            className="gap-1"
                        >
                            <X className="h-4 w-4" />
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
