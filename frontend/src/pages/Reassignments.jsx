import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
    ArrowRight,
    Check,
    ExternalLink,
    Filter,
    UserCog,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { TopBar } from '@/components/TopBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

const STATUS_LABELS = {
    PENDING: 'Pending review',
    APPROVED: 'Approved',
    REJECTED: 'Declined',
    CANCELLED: 'Cancelled',
};

const STATUS_TONE = {
    PENDING:
        'bg-amber-100 text-amber-800 ring-1 ring-amber-300 dark:bg-amber-500/15 dark:text-amber-200',
    APPROVED:
        'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-200',
    REJECTED:
        'bg-rose-100 text-rose-800 ring-1 ring-rose-300 dark:bg-rose-500/15 dark:text-rose-200',
    CANCELLED:
        'bg-slate-100 text-slate-700 ring-1 ring-slate-300 dark:bg-slate-500/15 dark:text-slate-200',
};

// Inner content of the reassignments workflow, extracted so it can be
// embedded inside the tabbed Requests hub (see pages/Requests.jsx). It
// renders WITHOUT a page-level TopBar or <main> wrapper so it drops
// cleanly into a tab panel; the standalone default export below adds
// those back for the /reassignments route (kept for back-compat).
export function ReassignmentsPanel() {
    const { user } = useAuth();
    const isReviewer = user?.role === 'ADMIN' || user?.role === 'MANAGER';
    const { setPendingReassignmentCount } = useRealtime();
    const [items, setItems] = useState([]);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    // Reviewers want the queue (pending only) by default. Proposers
    // want their full history so they can see the decision and the
    // reviewer's note as soon as their request is decided — without
    // that, an APPROVED request just disappears from the page.
    const [statusFilter, setStatusFilter] = useState(
        isReviewer ? 'PENDING' : 'ALL',
    );
    const [scope, setScope] = useState(isReviewer ? 'all' : 'mine');
    const [decideTarget, setDecideTarget] = useState(null);

    const refresh = async () => {
        try {
            setLoading(true);
            const params = {};
            if (statusFilter !== 'ALL') params.status = statusFilter;
            if (scope === 'mine') params.mine = '1';
            const [resA, resB] = await Promise.all([
                api.get('/reassignments', { params }),
                isReviewer ? api.get('/users') : Promise.resolve({ data: { users: [] } }),
            ]);
            setItems(resA.data.reassignments || []);
            setUsers(resB.data.users || []);
            try {
                const pendingRes = await api.get(
                    '/reassignments/pending-count',
                );
                setPendingReassignmentCount?.(pendingRes.data.pending || 0);
            } catch {
                // ignore
            }
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    'Could not load reassignment requests.',
            );
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
    }, [statusFilter, scope]);

    const visible = items;

    return (
        <>
            <div className="w-full space-y-4">
                    <Card>
                        <CardContent className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
                            <p className="text-sm text-muted-foreground">
                                {isReviewer
                                    ? 'Review proposals to hand off tasks. Approving updates the assignee right away.'
                                    : 'Track reassignment requests you proposed or that involve your tasks.'}
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                                <Filter className="h-4 w-4 text-muted-foreground" />
                                <Select
                                    value={statusFilter}
                                    onValueChange={setStatusFilter}
                                >
                                    <SelectTrigger className="h-8 w-[170px]">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="PENDING">
                                            Pending
                                        </SelectItem>
                                        <SelectItem value="APPROVED">
                                            Approved
                                        </SelectItem>
                                        <SelectItem value="REJECTED">
                                            Declined
                                        </SelectItem>
                                        <SelectItem value="CANCELLED">
                                            Cancelled
                                        </SelectItem>
                                        <SelectItem value="ALL">All</SelectItem>
                                    </SelectContent>
                                </Select>
                                {isReviewer && (
                                    <Select value={scope} onValueChange={setScope}>
                                        <SelectTrigger className="h-8 w-[170px]">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="all">
                                                All visible
                                            </SelectItem>
                                            <SelectItem value="mine">
                                                Proposed by me
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                )}
                            </div>
                        </CardContent>
                    </Card>

                    {loading ? (
                        <Card>
                            <CardContent className="p-6 text-sm text-muted-foreground">
                                Loading requests...
                            </CardContent>
                        </Card>
                    ) : visible.length === 0 ? (
                        <Card>
                            <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                                <UserCog className="h-8 w-8 text-muted-foreground/60" />
                                <p>No reassignment requests in this view.</p>
                            </CardContent>
                        </Card>
                    ) : (
                        <div className="grid gap-3">
                            {visible.map((r) => (
                                <RequestCard
                                    key={r.id}
                                    item={r}
                                    isReviewer={isReviewer}
                                    isOwn={r.proposer?.id === user?.id}
                                    onDecide={(action) =>
                                        setDecideTarget({ item: r, action })
                                    }
                                    onCancelled={refresh}
                                />
                            ))}
                        </div>
                    )}
                </div>

            <DecisionDialog
                target={decideTarget}
                users={users}
                onClose={() => setDecideTarget(null)}
                onDecided={refresh}
            />
        </>
    );
}

// Standalone page for the legacy /reassignments route. Wraps the
// extracted panel in the page-level TopBar + scroll container so the
// old bookmark still renders a full page. New navigation points at the
// /requests hub instead.
export default function Reassignments() {
    return (
        <>
            <TopBar title="Reassignment requests" />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <ReassignmentsPanel />
            </main>
        </>
    );
}

function RequestCard({ item, isReviewer, isOwn, onDecide, onCancelled }) {
    const created = item.createdAt
        ? format(new Date(item.createdAt), "PP 'at' p")
        : '';
    const decided = item.decidedAt
        ? format(new Date(item.decidedAt), "PP 'at' p")
        : '';
    const taskHref = item.task
        ? `/projects/${item.task.projectId}#task-${item.task.id}`
        : null;

    const handleCancel = async () => {
        if (!window.confirm('Cancel this reassignment proposal?')) return;
        try {
            await api.delete(`/reassignments/${item.id}`);
            toast.success('Proposal cancelled.');
            onCancelled?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not cancel proposal.',
            );
        }
    };

    return (
        <Card>
            <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span
                        className={cn(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold',
                            STATUS_TONE[item.status],
                        )}
                    >
                        {STATUS_LABELS[item.status]}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        {created}
                    </span>
                    {item.project && (
                        <span className="text-xs text-muted-foreground">
                            · {item.project.name}
                        </span>
                    )}
                    {taskHref && (
                        <Link
                            to={taskHref}
                            className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                            Open task <ExternalLink className="h-3 w-3" />
                        </Link>
                    )}
                </div>

                <div className="text-sm">
                    <span className="font-medium">
                        {item.task?.title || 'Task'}
                    </span>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-sm">
                    <PersonChip user={item.proposer} caption="proposed" />
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">
                        reassign from
                    </span>
                    <PersonChip user={item.fromAssignee} placeholder="Unassigned" />
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <PersonChip
                        user={item.toAssignee}
                        placeholder="Anyone (reviewer picks)"
                    />
                </div>

                <div className="rounded-md border bg-muted/30 p-2 text-sm">
                    <div className="text-[11px] uppercase text-muted-foreground">
                        Reason
                    </div>
                    <p className="whitespace-pre-wrap">{item.reason}</p>
                </div>

                {item.decisionNote && (
                    <div className="rounded-md border bg-muted/30 p-2 text-sm">
                        <div className="text-[11px] uppercase text-muted-foreground">
                            Decision note
                        </div>
                        <p className="whitespace-pre-wrap">
                            {item.decisionNote}
                        </p>
                        {item.decidedBy && (
                            <p className="mt-1 text-[11px] text-muted-foreground">
                                {item.decidedBy.name || item.decidedBy.email} ·{' '}
                                {decided}
                            </p>
                        )}
                    </div>
                )}

                {item.status === 'PENDING' && (
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        {isOwn && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={handleCancel}
                            >
                                Cancel proposal
                            </Button>
                        )}
                        {isReviewer && (
                            <>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => onDecide('reject')}
                                >
                                    <X className="mr-1.5 h-4 w-4" /> Decline
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    onClick={() => onDecide('approve')}
                                >
                                    <Check className="mr-1.5 h-4 w-4" /> Approve
                                </Button>
                            </>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function PersonChip({ user, placeholder = 'Unassigned', caption }) {
    if (!user) {
        return (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground">
                {placeholder}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-0.5 text-xs">
            {user.avatarUrl ? (
                <img
                    src={resolveAssetUrl(user.avatarUrl)}
                    alt={user.name}
                    className="h-4 w-4 rounded-full object-cover"
                />
            ) : (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/20 text-[9px] font-semibold text-primary">
                    {initials(user.name)}
                </span>
            )}
            <span>
                {user.name || user.email}
                {caption ? (
                    <span className="ml-1 text-muted-foreground">{caption}</span>
                ) : null}
            </span>
        </span>
    );
}

function DecisionDialog({ target, users, onClose, onDecided }) {
    const [note, setNote] = useState('');
    const [toAssigneeId, setToAssigneeId] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (target?.item) {
            setNote('');
            setToAssigneeId(target.item.toAssignee?.id || '');
        }
    }, [target]);

    if (!target) return null;
    const { item, action } = target;
    const isApprove = action === 'approve';

    const submit = async (e) => {
        e.preventDefault();
        try {
            setSaving(true);
            const payload = { action, decisionNote: note.trim() || null };
            if (isApprove) {
                if (!toAssigneeId) {
                    toast.error('Pick someone to assign before approving.');
                    return;
                }
                payload.toAssigneeId = toAssigneeId;
            }
            await api.patch(`/reassignments/${item.id}`, payload);
            toast.success(isApprove ? 'Reassigned.' : 'Proposal declined.');
            onDecided?.();
            onClose();
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    'Could not save the decision.',
            );
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {isApprove ? 'Approve reassignment' : 'Decline reassignment'}
                    </DialogTitle>
                    <DialogDescription>
                        {isApprove
                            ? 'Pick the new assignee and (optionally) leave a note for the proposer.'
                            : "The proposer will be notified. Leave a note explaining why if it's helpful."}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="grid gap-3">
                    <div className="rounded-md border bg-muted/30 p-2 text-sm">
                        <div className="font-medium">
                            {item.task?.title || 'Task'}
                        </div>
                        <div className="text-xs text-muted-foreground">
                            {item.project?.name}
                        </div>
                    </div>
                    {isApprove && (
                        <div className="grid gap-1">
                            <Label>New assignee</Label>
                            <Select
                                value={toAssigneeId}
                                onValueChange={setToAssigneeId}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Pick someone" />
                                </SelectTrigger>
                                <SelectContent>
                                    {users.map((u) => (
                                        <SelectItem key={u.id} value={u.id}>
                                            {u.name || u.email}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                    <div className="grid gap-1">
                        <Label htmlFor="decision-note">
                            Note (optional)
                        </Label>
                        <Textarea
                            id="decision-note"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            rows={3}
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {saving
                                ? 'Saving...'
                                : isApprove
                                    ? 'Approve and reassign'
                                    : 'Decline'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
