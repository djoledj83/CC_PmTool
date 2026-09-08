// Task quick-view modal — opened by clicking a task title in any task
// list (Plan view, Todos page, etc.). Shows task details plus two
// action tabs: "Leave note" (pinned to this task) and "Log time".
// Both forms submit without leaving the modal; success closes it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
    ArrowUpRight,
    Check,
    CheckCircle2,
    Clock,
    FolderKanban,
    MessageSquarePlus,
    Loader2,
    Pencil,
    Lock,
    Share2,
    XCircle,
    RotateCcw,
} from 'lucide-react';
import ShareDialog from '@/components/ShareDialog';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import {
    TASK_PRIORITY_MAP,
    TASK_PRIORITIES,
    TASK_STATUS_MAP,
    TASK_STATUSES,
} from '@/lib/constants';
import { useTaskStatuses } from '@/lib/statuses';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Tip } from '@/components/Tip';
import { NoteAttachmentsField } from '@/components/NoteAttachments';
import LogTimeDaySummary from '@/components/LogTimeDaySummary';
import CrossUserReasonFields from '@/components/CrossUserReasonFields';
import { useAuth } from '@/contexts/AuthContext';
import { isOthersTask, assigneeLabel } from '@/lib/timeReason';

// ─── Duration helpers (mirrors LogTimeDialog) ────────────────────────
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
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function deriveStartEnd(dateString, durationMinutes) {
    const [y, m, d] = dateString.split('-').map((s) => parseInt(s, 10));
    if (!y || !m || !d) throw new Error('Invalid date');
    const baseDate = new Date(y, m - 1, d);
    const isToday =
        new Date().toDateString() === baseDate.toDateString();
    let endedAt = isToday ? new Date() : new Date(y, m - 1, d, 12, 0, 0);
    const startedAt = new Date(endedAt.getTime() - durationMinutes * 60_000);
    return { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() };
}

function formatDate(val) {
    if (!val) return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

// ─── Main component ───────────────────────────────────────────────────
export default function TaskQuickViewDialog({
    open,
    task,
    onClose,
    // Which tab to open first. 'note' | 'logtime'. We default to
    // 'logtime' because that's the most common reason users click
    // into a task row (the note flow has its own dedicated icon /
    // small-modal entry point next to the row, while logging time
    // requires the full duration / project / task picker which lives
    // inside this dialog). Per-call sites can still override with
    // `defaultTab="note"` when they need the note bias.
    defaultTab = 'logtime',
    // Project context (needed for log time POST)
    projectId,
    projectName,
    // Callback after a note is saved (optional parent refresh)
    onNoteSubmitted,
    // Callback after time is logged (optional parent refresh)
    onTimeLogged,
    // ── Permission props ────────────────────────────────────────────
    // When false, the Log time tab body shows an inline "you can't
    // log time on this task" banner with the form fields disabled.
    // The tab itself stays clickable so the user can see WHY the
    // feature is unavailable rather than wondering where it went.
    // Default true keeps backward compatibility with existing call
    // sites that never knew about this prop.
    canLogTime = true,
    // When true, an "Edit task" button is shown in the dialog header.
    // Clicking it invokes `onEdit` (which the parent typically wires
    // to close this dialog and open its existing edit-task flow).
    canEdit = false,
    onEdit,
    // When provided, renders a status dropdown in the header so
    // assignees can mark work as started without opening the plan.
    onStatusChange,
    // TRUE when the current user may approve "specific" tasks (Admin,
    // Manager, or `task:approve` capability holder). Gates the Approve
    // button — the parent computes this via hasCapability/useAuth.
    canApprove = false,
    // Called after a successful approval so the parent can reload the
    // plan / task list and reflect the new approved state. Also fired
    // after a disapprove or re-request decision (reuse this callback).
    onApproved,
    // TRUE when the current user may put a DISAPPROVED task back to
    // pending ("Re-request approval") — i.e. they're the creator /
    // assignee, or they can approve. The parent computes this; defaults
    // to false so existing call sites keep the button hidden.
    canRerequest = false,
}) {
    const [tab, setTab] = useState(defaultTab);
    const [shareOpen, setShareOpen] = useState(false);
    const [approving, setApproving] = useState(false);
    const [rerequesting, setRerequesting] = useState(false);
    // Inline "disapprove" reason prompt state. When `showReasonPrompt`
    // is true we swap the header buttons for a compact reason field.
    const [showReasonPrompt, setShowReasonPrompt] = useState(false);
    const [reason, setReason] = useState('');
    const [disapproving, setDisapproving] = useState(false);
    // Local snapshot of the approval / rejection fields so the badge /
    // lock update the instant we act, without waiting for the parent
    // refetch to flow a new `task` prop back down. `null` on a field
    // means "not overridden — fall back to the task prop".
    const [approveOverride, setApproveOverride] = useState(null);
    const navigate = useNavigate();

    // Reset tab whenever the dialog opens
    useEffect(() => {
        if (open) setTab(defaultTab);
    }, [open, defaultTab]);

    // Drop any stale override / prompt whenever a different task loads.
    useEffect(() => {
        setApproveOverride(null);
        setShowReasonPrompt(false);
        setReason('');
    }, [task?.id]);

    const isSpecific = Boolean(task?.specific);
    // When an override snapshot exists it fully replaces the approval /
    // rejection fields for the acted-on task (the backend returns the
    // fresh task, e.g. approve clears the prior rejection).
    const approvedAt = approveOverride
        ? approveOverride.approvedAt ?? null
        : task?.approvedAt ?? null;
    const approvedBy = approveOverride
        ? approveOverride.approvedBy ?? null
        : task?.approvedBy ?? null;
    const rejectedAt = approveOverride
        ? approveOverride.rejectedAt ?? null
        : task?.rejectedAt ?? null;
    const rejectedBy = approveOverride
        ? approveOverride.rejectedBy ?? null
        : task?.rejectedBy ?? null;
    const rejectionReason = approveOverride
        ? approveOverride.rejectionReason ?? null
        : task?.rejectionReason ?? null;
    const isApprovalLocked = isSpecific && !approvedAt;
    // Pending = specific, not yet approved AND not disapproved.
    const isPending = isSpecific && !approvedAt && !rejectedAt;
    // Disapproved = a rejection stands and no approval overrides it.
    const isDisapproved = isSpecific && !approvedAt && Boolean(rejectedAt);

    const handleApprove = useCallback(async () => {
        if (!task?.id) return;
        setApproving(true);
        try {
            const { data } = await api.post(`/tasks/${task.id}/approve`);
            setApproveOverride(data?.task || null);
            setShowReasonPrompt(false);
            toast.success('Task approved');
            onApproved?.();
        } catch (err) {
            toast.error(
                err?.response?.data?.error || 'Could not approve task',
            );
        } finally {
            setApproving(false);
        }
    }, [task?.id, onApproved]);

    const handleDisapprove = useCallback(async () => {
        if (!task?.id) return;
        const text = reason.trim();
        if (text.length < 3) return;
        setDisapproving(true);
        try {
            const { data } = await api.post(`/tasks/${task.id}/disapprove`, {
                reason: text,
            });
            setApproveOverride(data?.task || null);
            setShowReasonPrompt(false);
            setReason('');
            toast.success('Task disapproved');
            onApproved?.();
        } catch (err) {
            toast.error(
                err?.response?.data?.error ||
                    err?.response?.data?.message ||
                    'Could not disapprove task',
            );
        } finally {
            setDisapproving(false);
        }
    }, [task?.id, reason, onApproved]);

    const handleRerequest = useCallback(async () => {
        if (!task?.id) return;
        setRerequesting(true);
        try {
            const { data } = await api.post(
                `/tasks/${task.id}/request-approval`,
            );
            setApproveOverride(data?.task || null);
            toast.success('Approval re-requested');
            onApproved?.();
        } catch (err) {
            toast.error(
                err?.response?.data?.error ||
                    err?.response?.data?.message ||
                    'Could not re-request approval',
            );
        } finally {
            setRerequesting(false);
        }
    }, [task?.id, onApproved]);

    const approvedDateLabel = approvedAt
        ? (() => {
              const d = new Date(approvedAt);
              return isNaN(d.getTime()) ? null : format(d, 'd MMM yyyy');
          })()
        : null;

    const rejectedDateLabel = rejectedAt
        ? (() => {
              const d = new Date(rejectedAt);
              return isNaN(d.getTime()) ? null : format(d, 'd MMM yyyy');
          })()
        : null;

    const { list: taskStatusOptions, find: findTaskStatus } = useTaskStatuses();
    const taskStatusList = taskStatusOptions.length
        ? taskStatusOptions
        : TASK_STATUSES;
    const statusMeta = task
        ? findTaskStatus(task.status) ||
          TASK_STATUS_MAP[task.status] ||
          TASK_STATUSES[0]
        : TASK_STATUSES[0];
    const priorityMeta = task
        ? (TASK_PRIORITY_MAP[task.priority] || TASK_PRIORITIES[1])
        : TASK_PRIORITIES[1];

    const isPersonalTodo = task?.kind === 'todo';

    // Always show the log-time tab — the backend guards the actual POST.
    // Hiding it from non-assignees was confusing since any project
    // participant may legitimately want to log time (e.g. admin on
    // behalf of the team). Backend rejects if not permitted.
    const showLogTime = true;
    const due = task ? formatDate(task.dueDate) : null;

    return (
        <>
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="sm:max-w-2xl">
                {task && (
                    <>
                        {/* ── Task header ── */}
                        <DialogHeader>
                            <div className="flex flex-wrap items-center gap-1.5 mb-1">
                                {!isPersonalTodo && task.code && (
                                    <span className="rounded border border-border bg-muted/60 px-1 py-px font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                                        {task.code}
                                    </span>
                                )}
                                {!isPersonalTodo && onStatusChange ? (
                                    <Select
                                        value={task.status || 'TODO'}
                                        onValueChange={onStatusChange}
                                        disabled={isApprovalLocked}
                                    >
                                        <SelectTrigger
                                            className="h-7 w-[8.5rem] text-[10px]"
                                            title={
                                                isApprovalLocked
                                                    ? 'Approve to unlock'
                                                    : undefined
                                            }
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {taskStatusList.map((s) => (
                                                <SelectItem key={s.value} value={s.value}>
                                                    {s.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                ) : !isPersonalTodo ? (
                                    <Badge
                                        variant={statusMeta.badge || 'outline'}
                                        className="text-[10px]"
                                    >
                                        {statusMeta.label}
                                    </Badge>
                                ) : null}
                                <Badge variant={priorityMeta.badge || 'outline'} className="text-[10px]">
                                    {priorityMeta.label}
                                </Badge>
                                {/* Specific-task approval state. Amber
                                    while pending (task is locked in
                                    To-do), green once an approver signs
                                    off — with a tooltip crediting them. */}
                                {isPending && (
                                    <Badge
                                        variant="outline"
                                        className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
                                    >
                                        <Lock className="h-3 w-3" />
                                        Pending approval
                                    </Badge>
                                )}
                                {isDisapproved && (
                                    <Badge
                                        variant="outline"
                                        className="gap-1 border-rose-500/40 bg-rose-500/10 text-[10px] text-rose-700 dark:text-rose-300"
                                        title={
                                            rejectionReason
                                                ? `Reason: ${rejectionReason}`
                                                : 'Disapproved'
                                        }
                                    >
                                        <XCircle className="h-3 w-3" />
                                        Disapproved
                                    </Badge>
                                )}
                                {isSpecific && approvedAt && (
                                    <Badge
                                        variant="outline"
                                        className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300"
                                        title={
                                            approvedBy
                                                ? `Approved by ${approvedBy.name}${approvedDateLabel ? ` on ${approvedDateLabel}` : ''}`
                                                : 'Approved'
                                        }
                                    >
                                        <CheckCircle2 className="h-3 w-3" />
                                        Approved
                                    </Badge>
                                )}
                            </div>
                            <div className="flex items-start justify-between gap-2">
                                <DialogTitle className="leading-snug">{task.title}</DialogTitle>
                                <div className="flex shrink-0 items-center gap-1.5">
                                    {/* Approver actions: Approve is shown
                                        both when pending AND when
                                        disapproved (an override). Disapprove
                                        only when pending; Re-request only
                                        when disapproved. All hidden while the
                                        reason prompt is open. */}
                                    {isSpecific &&
                                        !approvedAt &&
                                        canApprove &&
                                        !showReasonPrompt && (
                                            <Button
                                                type="button"
                                                size="sm"
                                                className="shrink-0 gap-1.5 bg-emerald-600 px-2 text-white hover:bg-emerald-700"
                                                title={
                                                    isDisapproved
                                                        ? 'Approve this task (overrides the disapproval)'
                                                        : 'Approve this task so it can leave To-do'
                                                }
                                                onClick={handleApprove}
                                                disabled={approving}
                                            >
                                                {approving ? (
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                ) : (
                                                    <Check className="h-3.5 w-3.5" />
                                                )}
                                                Approve
                                            </Button>
                                        )}
                                    {isPending &&
                                        canApprove &&
                                        !showReasonPrompt && (
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                className="shrink-0 gap-1.5 border-rose-300 px-2 text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10"
                                                title="Disapprove this task with a reason"
                                                onClick={() => {
                                                    setReason('');
                                                    setShowReasonPrompt(true);
                                                }}
                                                disabled={approving}
                                            >
                                                <XCircle className="h-3.5 w-3.5" />
                                                Disapprove
                                            </Button>
                                        )}
                                    {/* Re-request lives inside the rose
                                        "Disapproved" banner below, right
                                        next to the reason, so it's easy to
                                        find for the task's creator. */}
                                    {projectId && !isPersonalTodo && (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            className="shrink-0 gap-1.5 px-2"
                                            title="Share this task with a teammate"
                                            onClick={() => setShareOpen(true)}
                                        >
                                            <Share2 className="h-3.5 w-3.5" />
                                            Share
                                        </Button>
                                    )}
                                    {/* Jump straight to the task in its
                                        project plan. Uses the app-wide
                                        `#task-<id>` deep-link convention
                                        (ProjectDetail opens the Plan tab,
                                        scrolls to the row and pulses it).
                                        Subtasks land on their parent so
                                        the nested row is on screen. */}
                                    {projectId && !isPersonalTodo && (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            className="shrink-0 gap-1.5 px-2"
                                            title="Open this task in its project plan"
                                            onClick={() => {
                                                onClose();
                                                navigate(
                                                    `/projects/${projectId}#task-${
                                                        task.parentTaskId ||
                                                        task.id
                                                    }`,
                                                );
                                            }}
                                        >
                                            <ArrowUpRight className="h-3.5 w-3.5" />
                                            Open task
                                        </Button>
                                    )}
                                    {canEdit && onEdit && (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() => {
                                                // Defer to the parent: it usually
                                                // closes the quick-view and opens
                                                // the full task edit dialog.
                                                onEdit?.();
                                            }}
                                            className="shrink-0 gap-1.5 px-2"
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                            Edit
                                        </Button>
                                    )}
                                </div>
                            </div>
                            {(task.assignee ||
                                due ||
                                task.createdBy ||
                                projectName ||
                                task.project) && (
                                <DialogDescription asChild>
                                    <div className="flex flex-wrap items-center gap-3 pt-0.5 text-xs text-muted-foreground">
                                        {(projectName || task.project?.name) && (
                                            <span className="flex items-center gap-1 font-medium text-foreground">
                                                <FolderKanban className="h-3.5 w-3.5 text-primary" />
                                                {projectName || task.project?.name}
                                            </span>
                                        )}
                                        {task.assignee && (
                                            <span className="flex items-center gap-1">
                                                <Avatar className="h-4 w-4 shrink-0">
                                                    {task.assignee.avatarUrl && (
                                                        <AvatarImage
                                                            src={resolveAssetUrl(task.assignee.avatarUrl)}
                                                            alt={task.assignee.name}
                                                        />
                                                    )}
                                                    <AvatarFallback className="bg-primary/10 text-[7px] text-primary">
                                                        {initials(task.assignee.name)}
                                                    </AvatarFallback>
                                                </Avatar>
                                                {task.assignee.name}
                                            </span>
                                        )}
                                        {due && <span>Due {due}</span>}
                                        {task.phase && <span>{task.phase.name}</span>}
                                        {/* "Created by" attribution — same
                                            data the plan row chip shows,
                                            but expanded into a full name +
                                            date here since the dialog has
                                            the real estate. */}
                                        {task.createdBy && (
                                            <span
                                                className="flex items-center gap-1"
                                                title={
                                                    task.createdAt
                                                        ? `Created on ${new Date(
                                                              task.createdAt,
                                                          ).toLocaleString()}`
                                                        : undefined
                                                }
                                            >
                                                <Avatar className="h-4 w-4 shrink-0">
                                                    {task.createdBy.avatarUrl && (
                                                        <AvatarImage
                                                            src={resolveAssetUrl(
                                                                task.createdBy.avatarUrl,
                                                            )}
                                                            alt={task.createdBy.name}
                                                        />
                                                    )}
                                                    <AvatarFallback className="bg-muted text-[7px] text-muted-foreground">
                                                        {initials(task.createdBy.name)}
                                                    </AvatarFallback>
                                                </Avatar>
                                                Created by {task.createdBy.name}
                                                {task.createdAt && (
                                                    <span className="text-muted-foreground">
                                                        {' · '}
                                                        {new Date(
                                                            task.createdAt,
                                                        ).toLocaleDateString(
                                                            undefined,
                                                            {
                                                                day: '2-digit',
                                                                month: 'short',
                                                                year: 'numeric',
                                                            },
                                                        )}
                                                    </span>
                                                )}
                                            </span>
                                        )}
                                    </div>
                                </DialogDescription>
                            )}
                        </DialogHeader>

                        {/* ── Specific-task approval banner ── */}
                        {isPending && (
                            <div className="flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <p className="leading-relaxed">
                                    <span className="font-medium">
                                        Pending approval.
                                    </span>{' '}
                                    This is a specific task — it stays locked in
                                    To-do until an approver signs off.
                                    {canApprove
                                        ? ' Use Approve above to unlock it.'
                                        : ''}
                                </p>
                            </div>
                        )}
                        {isDisapproved && (
                            <div className="flex items-start gap-2 rounded-md border border-rose-300/70 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
                                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <div className="min-w-0 flex-1 leading-relaxed">
                                    <p>
                                        <span className="font-medium">
                                            Disapproved
                                            {rejectedBy
                                                ? ` by ${rejectedBy.name}`
                                                : ''}
                                        </span>
                                        {rejectedDateLabel
                                            ? ` on ${rejectedDateLabel}`
                                            : ''}
                                        .
                                    </p>
                                    {rejectionReason && (
                                        <p className="mt-0.5">
                                            <span className="font-medium">
                                                Reason:
                                            </span>{' '}
                                            {rejectionReason}
                                        </p>
                                    )}
                                    {canRerequest && (
                                        <>
                                            <p className="mt-1.5 text-rose-800/80 dark:text-rose-200/80">
                                                Addressed the feedback? Send it
                                                back for approval.
                                            </p>
                                            <Button
                                                type="button"
                                                size="sm"
                                                className="mt-2 gap-1.5 bg-rose-600 px-3 text-white hover:bg-rose-700"
                                                onClick={handleRerequest}
                                                disabled={rerequesting}
                                            >
                                                {rerequesting ? (
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                ) : (
                                                    <RotateCcw className="h-3.5 w-3.5" />
                                                )}
                                                Re-request approval
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                        {/* ── Inline disapprove reason prompt ── */}
                        {showReasonPrompt && (
                            <div className="space-y-2 rounded-md border border-rose-300/70 bg-rose-50/70 px-3 py-3 dark:border-rose-500/40 dark:bg-rose-500/10">
                                <Label
                                    htmlFor="tv-disapprove-reason"
                                    className="text-xs font-medium text-rose-900 dark:text-rose-200"
                                >
                                    Reason for disapproval
                                </Label>
                                <Textarea
                                    id="tv-disapprove-reason"
                                    autoFocus
                                    rows={3}
                                    value={reason}
                                    onChange={(e) => setReason(e.target.value)}
                                    placeholder="Explain why this task can't be approved (min 3 characters)…"
                                    disabled={disapproving}
                                />
                                <div className="flex justify-end gap-2">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => {
                                            setShowReasonPrompt(false);
                                            setReason('');
                                        }}
                                        disabled={disapproving}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700"
                                        onClick={handleDisapprove}
                                        disabled={
                                            disapproving ||
                                            reason.trim().length < 3
                                        }
                                    >
                                        {disapproving ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <XCircle className="h-3.5 w-3.5" />
                                        )}
                                        Confirm disapproval
                                    </Button>
                                </div>
                            </div>
                        )}
                        {isSpecific && approvedAt && (
                            <div className="flex items-start gap-2 rounded-md border border-emerald-300/70 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
                                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                <p className="leading-relaxed">
                                    {approvedBy
                                        ? `Approved by ${approvedBy.name}`
                                        : 'Approved'}
                                    {approvedDateLabel
                                        ? ` on ${approvedDateLabel}`
                                        : ''}
                                    .
                                </p>
                            </div>
                        )}

                        {/* ── Description (if any) ── */}
                        {(task.description || task.notes) && (
                            <p className="text-sm text-muted-foreground whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2">
                                {task.description || task.notes}
                            </p>
                        )}

                        {/* ── Locked: no comments / no time until approved ── */}
                        {isApprovalLocked ? (
                            <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
                                <Lock className="mt-0.5 h-4 w-4 shrink-0" />
                                <p className="leading-relaxed">
                                    {isDisapproved
                                        ? 'This task was disapproved — commenting, logging time, and edits stay disabled until it’s approved.'
                                        : 'Commenting, logging time, and every other action are disabled until this task is approved.'}
                                    {canApprove
                                        ? ' Use Approve above to unlock it.'
                                        : isDisapproved && canRerequest
                                          ? ' Use Re-request approval above to send it back for review.'
                                          : ' Ask an Admin or Manager to approve it.'}
                                </p>
                            </div>
                        ) : (
                        <>
                        {/* ── Tab switcher (Log time first — default tab) ── */}
                        {!isPersonalTodo ? (
                        <div className="flex gap-1 rounded-lg border bg-muted/40 p-1">
                            {showLogTime && (
                                <button
                                    type="button"
                                    onClick={() => setTab('logtime')}
                                    title={
                                        canLogTime
                                            ? undefined
                                            : "Log time isn't available on this task — it's not assigned to you."
                                    }
                                    className={cn(
                                        'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-all',
                                        tab === 'logtime'
                                            ? 'bg-primary/15 text-primary shadow-sm ring-2 ring-primary/35'
                                            : canLogTime
                                              ? 'text-muted-foreground hover:bg-background/80 hover:text-foreground'
                                              : 'text-muted-foreground/60 hover:text-muted-foreground',
                                    )}
                                >
                                    {canLogTime ? (
                                        <Clock className="h-3.5 w-3.5" />
                                    ) : (
                                        <Lock className="h-3.5 w-3.5" />
                                    )}
                                    Log time
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => setTab('note')}
                                className={cn(
                                    'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-all',
                                    tab === 'note'
                                        ? 'bg-primary/15 text-primary shadow-sm ring-2 ring-primary/35'
                                        : 'text-muted-foreground hover:bg-background/80 hover:text-foreground',
                                )}
                            >
                                <MessageSquarePlus className="h-3.5 w-3.5" />
                                Leave a note
                            </button>
                        </div>
                        ) : (
                        <div className="flex items-center gap-1.5 rounded-lg border bg-primary/10 px-3 py-2 text-sm font-medium text-primary">
                            <Clock className="h-3.5 w-3.5" />
                            Log time
                        </div>
                        )}

                        {/* ── Tab body ── */}
                        {tab === 'note' && !isPersonalTodo && (
                            <NoteForm
                                task={task}
                                projectId={projectId}
                                onClose={onClose}
                                onSubmitted={onNoteSubmitted}
                            />
                        )}
                        {(tab === 'logtime' || isPersonalTodo) && showLogTime && (
                            <LogTimeForm
                                task={task}
                                projectId={projectId}
                                projectName={projectName}
                                onClose={onClose}
                                onLogged={onTimeLogged}
                                canLogTime={canLogTime}
                                isPersonalTodo={isPersonalTodo}
                            />
                        )}
                        </>
                        )}
                    </>
                )}
            </DialogContent>
        </Dialog>
        {task && !isPersonalTodo && (
            <ShareDialog
                open={shareOpen}
                onOpenChange={setShareOpen}
                item={{
                    kind: task.parentTaskId ? 'subtask' : 'task',
                    id: task.id,
                    code: task.code,
                    title: task.title,
                    projectId,
                }}
            />
        )}
        </>
    );
}

// ─── Note form ────────────────────────────────────────────────────────
function NoteForm({ task, projectId, onClose, onSubmitted }) {
    const [content, setContent] = useState('');
    const [files, setFiles] = useState([]);
    const [saving, setSaving] = useState(false);
    const [notes, setNotes] = useState(null);
    const pid = projectId || task?.project?.id || task?.projectId;

    // Load the task's existing notes (incl. notes on its subtasks) so
    // the user can read prior discussion while writing a new note.
    const loadNotes = useCallback(async () => {
        if (!pid || !task?.id) {
            setNotes([]);
            return;
        }
        try {
            const res = await api.get('/notes', {
                params: { projectId: pid, taskId: task.id, includeSubtasks: true },
            });
            setNotes(Array.isArray(res.data?.notes) ? res.data.notes : []);
        } catch {
            setNotes([]);
        }
    }, [pid, task?.id]);

    useEffect(() => {
        setContent('');
        setFiles([]);
        setNotes(null);
        loadNotes();
    }, [task?.id, loadNotes]);

    const submit = async (e) => {
        e.preventDefault();
        const text = content.trim();
        if (!text) return;
        setSaving(true);
        try {
            await api.post('/notes', {
                projectId: pid,
                taskId: task.id,
                content: text,
                fileIds: files.map((f) => f.id),
            });
            toast.success('Note saved');
            onSubmitted?.();
            // Keep the modal open and show the new note in the list so
            // the user can keep reading/adding.
            setContent('');
            setFiles([]);
            loadNotes();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save note');
        } finally {
            setSaving(false);
        }
    };

    return (
        <form onSubmit={submit} className="space-y-3">
            {notes && notes.length > 0 && (
                <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border bg-muted/20 p-2">
                    {notes.map((n) => {
                        const onSubtask = n.task && n.task.id !== task.id;
                        return (
                            <div
                                key={n.id}
                                className="rounded border border-amber-200/70 bg-amber-50/80 px-2.5 py-1.5 text-xs dark:border-amber-500/20 dark:bg-amber-500/10"
                            >
                                <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                                    <span className="flex min-w-0 items-center gap-1.5">
                                        <span className="font-medium text-foreground/80">
                                            {n.author?.name || 'Someone'}
                                        </span>
                                        {onSubtask && (
                                            <span className="truncate rounded border border-amber-400/40 bg-amber-100 px-1 py-px font-mono text-[9px] text-amber-800 dark:bg-amber-400/15 dark:text-amber-200">
                                                ↳ {n.task.code || n.task.title}
                                            </span>
                                        )}
                                    </span>
                                    <span className="shrink-0">
                                        {n.createdAt
                                            ? new Date(
                                                  n.createdAt,
                                              ).toLocaleDateString(undefined, {
                                                  month: 'short',
                                                  day: 'numeric',
                                                  hour: 'numeric',
                                                  minute: '2-digit',
                                              })
                                            : ''}
                                    </span>
                                </div>
                                <p className="mt-0.5 whitespace-pre-wrap break-words">
                                    {n.content}
                                </p>
                            </div>
                        );
                    })}
                </div>
            )}
            <Textarea
                rows={4}
                autoFocus
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="What's on your mind? This note will be pinned to the task."
                disabled={saving}
            />
            <NoteAttachmentsField
                projectId={pid}
                files={files}
                onChange={setFiles}
                disabled={saving}
            />
            <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
                    Cancel
                </Button>
                <Button type="submit" disabled={saving || !content.trim()}>
                    {saving ? (
                        <>
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            Saving…
                        </>
                    ) : (
                        'Add note'
                    )}
                </Button>
            </div>
        </form>
    );
}

// ─── Log time form ────────────────────────────────────────────────────
function LogTimeForm({
    task,
    projectId,
    projectName,
    onClose,
    onLogged,
    canLogTime = true,
    isPersonalTodo = false,
}) {
    const { user } = useAuth();
    const [dateValue, setDateValue] = useState(todayDateValue);
    const [durationMinutes, setDurationMinutes] = useState(60);
    const [description, setDescription] = useState('');
    const [crossReason, setCrossReason] = useState('');
    const [crossNote, setCrossNote] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [summaryRefresh, setSummaryRefresh] = useState(0);
    const formDisabled = submitting || !canLogTime;
    const othersTask = useMemo(
        () => !isPersonalTodo && isOthersTask(task, user?.id),
        [task, user?.id, isPersonalTodo],
    );

    useEffect(() => {
        setDateValue(todayDateValue());
        setDurationMinutes(60);
        setDescription('');
        setCrossReason('');
        setCrossNote('');
        setSummaryRefresh(0);
    }, [task?.id]);

    const targetTitle = useMemo(() => {
        if (!task) return '';
        if (isPersonalTodo) return task.title || 'to-do';
        return task.code ? `${task.code} · ${task.title}` : task.title;
    }, [task, isPersonalTodo]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        const pid = projectId || task?.project?.id || task?.projectId;
        if (!task || !pid) {
            toast.error(
                isPersonalTodo
                    ? 'Link this to-do to a project before logging time'
                    : 'Missing task or project',
            );
            return;
        }
        if (othersTask && !crossReason) {
            toast.error('Pick a reason for logging on someone else’s task');
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
            projectId: pid,
            startedAt: scope.startedAt,
            endedAt: scope.endedAt,
        };
        if (isPersonalTodo) {
            payload.description = note
                ? `Personal to-do: ${task.title} — ${note}`
                : `Personal to-do: ${task.title}`;
        } else {
            payload.taskId = task.id;
            if (note) payload.description = note;
            if (othersTask) {
                payload.crossUserReason = crossReason;
                if (crossNote.trim()) payload.crossUserNote = crossNote.trim();
            }
        }
        setSubmitting(true);
        try {
            await api.post('/time', payload);
            const human =
                DURATION_OPTIONS.find((o) => o.value === durationMinutes)?.label ||
                `${durationMinutes} min`;
            toast.success(`Logged ${human} on ${targetTitle}`);
            setSummaryRefresh((n) => n + 1);
            onLogged?.();
            onClose();
        } catch (err) {
            toast.error(
                err?.response?.data?.error || err?.response?.data?.message || 'Could not log time',
            );
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-3">
            {!canLogTime && (
                <div
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
                >
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <div className="leading-relaxed">
                        <p className="font-medium">
                            You can't log time on this task.
                        </p>
                        <p className="mt-0.5 opacity-90">
                            It isn't assigned to you. Ask the assignee or
                            your project manager to log time here, or use{' '}
                            <span className="font-medium">Leave a note</span>{' '}
                            if you just want to add a comment.
                        </p>
                    </div>
                </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                    <div className="flex h-5 items-center">
                        <Label htmlFor="tv-date" className="text-xs">
                            Date
                        </Label>
                    </div>
                    <Input
                        id="tv-date"
                        type="date"
                        value={dateValue}
                        onChange={(e) => setDateValue(e.target.value)}
                        max={todayDateValue()}
                        disabled={formDisabled}
                    />
                </div>
                <div className="space-y-1.5">
                    <div className="flex h-5 items-center gap-1">
                        <Label htmlFor="tv-duration" className="text-xs">
                            Duration
                        </Label>
                        <Tip variant="tip" side="top">
                            <p className="font-medium">Use the live timer for long sessions.</p>
                            <p className="mt-1 text-muted-foreground">
                                Manual entries snap to 30-minute steps.
                            </p>
                        </Tip>
                    </div>
                    <Select
                        value={String(durationMinutes)}
                        onValueChange={(v) => setDurationMinutes(parseInt(v, 10))}
                        disabled={formDisabled}
                    >
                        <SelectTrigger id="tv-duration">
                            <SelectValue placeholder="Duration" />
                        </SelectTrigger>
                        <SelectContent>
                            {DURATION_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={String(opt.value)}>
                                    {opt.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>
            <LogTimeDaySummary
                dateValue={dateValue}
                taskId={isPersonalTodo ? null : task?.id}
                refreshToken={summaryRefresh}
            />
            {othersTask && canLogTime && (
                <CrossUserReasonFields
                    assigneeName={assigneeLabel(task)}
                    reason={crossReason}
                    onReasonChange={setCrossReason}
                    note={crossNote}
                    onNoteChange={setCrossNote}
                    disabled={formDisabled}
                    idPrefix="tv"
                />
            )}
            <div className="space-y-1.5">
                <Label htmlFor="tv-note" className="text-xs">
                    Description <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Textarea
                    id="tv-note"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What did you do?"
                    rows={3}
                    disabled={formDisabled}
                />
            </div>
            <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
                    Cancel
                </Button>
                <Button type="submit" disabled={formDisabled}>
                    {submitting ? (
                        <>
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            Saving…
                        </>
                    ) : (
                        'Save entry'
                    )}
                </Button>
            </div>
        </form>
    );
}
