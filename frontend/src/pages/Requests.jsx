import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
    CheckCircle2,
    ClipboardCheck,
    ExternalLink,
    Filter,
    Inbox,
    Lock,
    RotateCcw,
    UserCheck,
    UserCog,
    XCircle,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { TASK_PRIORITY_MAP, TASK_PRIORITIES } from '@/lib/constants';
import { TopBar } from '@/components/TopBar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Avatar,
    AvatarFallback,
    AvatarImage,
} from '@/components/ui/avatar';
import { ReassignmentsPanel } from '@/pages/Reassignments';

// Tab identifiers. Reassignments is the default tab so the old
// /reassignments muscle-memory (and the redirect from that route)
// lands somewhere familiar.
const TABS = [
    { id: 'reassignments', label: 'Reassignments', icon: UserCog },
    { id: 'tasks', label: 'Task approvals', icon: ClipboardCheck },
    { id: 'users', label: 'User approvals', icon: UserCheck },
];

export default function Requests() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    const [tab, setTab] = useState('reassignments');

    return (
        <>
            <TopBar title="Requests" />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="w-full space-y-4">
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">
                            Reassignments, task approvals, and user approvals
                            in one place.
                        </p>
                        <div className="inline-flex flex-wrap rounded-lg border bg-card p-1 shadow-sm">
                            {TABS.map((t) => (
                                <TabButton
                                    key={t.id}
                                    active={tab === t.id}
                                    onClick={() => setTab(t.id)}
                                    icon={t.icon}
                                >
                                    {t.label}
                                </TabButton>
                            ))}
                        </div>
                    </div>

                    {tab === 'reassignments' && <ReassignmentsPanel />}
                    {tab === 'tasks' && <TaskApprovalsPanel />}
                    {tab === 'users' && (
                        <UserApprovalsPanel isAdmin={isAdmin} />
                    )}
                </div>
            </main>
        </>
    );
}

function TabButton({ active, onClick, icon: Icon, children }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                active
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
            )}
        >
            {Icon && <Icon className="h-4 w-4" />}
            {children}
        </button>
    );
}

// ---- Tab B: Task approvals ------------------------------------------

function TaskApprovalsPanel() {
    const { user } = useAuth();
    const [tasks, setTasks] = useState([]);
    const [canApprove, setCanApprove] = useState(false);
    const [loading, setLoading] = useState(true);
    const [approvingId, setApprovingId] = useState(null);

    // A user may re-request approval for a disapproved task if they can
    // approve OR they're the task's creator / assignee (mirrors backend).
    const canRerequestTask = (task) =>
        canApprove ||
        Boolean(
            user &&
                (task.createdById === user.id ||
                    task.createdBy?.id === user.id ||
                    task.assignee?.id === user.id ||
                    task.assigneeId === user.id),
        );
    // The pending-approval feed carries BOTH tasks still awaiting a
    // decision (no rejectedAt) and ones that were disapproved
    // (rejectedAt set). Let reviewers narrow to one or the other.
    const [statusFilter, setStatusFilter] = useState('ALL');

    const refresh = async () => {
        try {
            setLoading(true);
            const { data } = await api.get('/tasks/pending-approval');
            setTasks(data.tasks || []);
            setCanApprove(Boolean(data.canApprove));
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    'Could not load tasks awaiting approval.',
            );
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
    }, []);

    const handleApprove = async (task) => {
        try {
            setApprovingId(task.id);
            await api.post(`/tasks/${task.id}/approve`);
            toast.success('Task approved.');
            await refresh();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not approve task.',
            );
        } finally {
            setApprovingId(null);
        }
    };

    const handleDisapprove = async (task, reason) => {
        try {
            setApprovingId(task.id);
            await api.post(`/tasks/${task.id}/disapprove`, { reason });
            toast.success('Task disapproved.');
            await refresh();
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    err.response?.data?.message ||
                    'Could not disapprove task.',
            );
        } finally {
            setApprovingId(null);
        }
    };

    const handleRerequest = async (task) => {
        try {
            setApprovingId(task.id);
            await api.post(`/tasks/${task.id}/request-approval`);
            toast.success('Approval re-requested.');
            await refresh();
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    err.response?.data?.message ||
                    'Could not re-request approval.',
            );
        } finally {
            setApprovingId(null);
        }
    };

    if (loading) {
        return (
            <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">
                    Loading tasks...
                </CardContent>
            </Card>
        );
    }

    if (tasks.length === 0) {
        return (
            <Card>
                <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                    <ClipboardCheck className="h-8 w-8 text-muted-foreground/60" />
                    <p>No tasks awaiting approval.</p>
                </CardContent>
            </Card>
        );
    }

    const filteredTasks = tasks.filter((task) => {
        if (statusFilter === 'PENDING') return !task.rejectedAt;
        if (statusFilter === 'DISAPPROVED') return Boolean(task.rejectedAt);
        return true;
    });

    return (
        <div className="space-y-3">
            {!canApprove && (
                <p className="text-xs text-muted-foreground">
                    Only Admins, Managers, or approvers can approve.
                </p>
            )}
            <Card>
                <CardContent className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
                    <p className="text-sm text-muted-foreground">
                        Specific tasks awaiting approval, plus ones that
                        were disapproved.
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
                                <SelectItem value="ALL">All</SelectItem>
                                <SelectItem value="PENDING">
                                    Pending approval
                                </SelectItem>
                                <SelectItem value="DISAPPROVED">
                                    Disapproved
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>
            {filteredTasks.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">
                    No tasks match this filter.
                </p>
            ) : (
                <div className="grid gap-3">
                    {filteredTasks.map((task) => (
                        <TaskApprovalRow
                            key={task.id}
                            task={task}
                            canApprove={canApprove}
                            canRerequest={canRerequestTask(task)}
                            approving={approvingId === task.id}
                            onApprove={() => handleApprove(task)}
                            onDisapprove={(reason) =>
                                handleDisapprove(task, reason)
                            }
                            onRerequest={() => handleRerequest(task)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function TaskApprovalRow({
    task,
    canApprove,
    canRerequest,
    approving,
    onApprove,
    onDisapprove,
    onRerequest,
}) {
    const [showReason, setShowReason] = useState(false);
    const [reason, setReason] = useState('');
    const priorityMeta =
        TASK_PRIORITY_MAP[task.priority] || TASK_PRIORITIES[1];
    const created = task.createdAt
        ? format(new Date(task.createdAt), 'PP')
        : '';
    const taskHref = task.project
        ? `/projects/${task.project.id}#task-${task.id}`
        : null;
    // Both pending and disapproved specific tasks land in this queue
    // (both have approvedAt: null). Disapproved rows carry rejectedAt.
    const isDisapproved = Boolean(task.rejectedAt);
    const rejectedOn = task.rejectedAt
        ? format(new Date(task.rejectedAt), 'PP')
        : '';

    const submitReason = () => {
        const text = reason.trim();
        if (text.length < 3) return;
        onDisapprove?.(text);
        setShowReason(false);
        setReason('');
    };

    return (
        <Card>
            <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                    {isDisapproved ? (
                        <Badge
                            variant="outline"
                            className="gap-1 border-rose-500/40 bg-rose-500/10 text-[10px] text-rose-700 dark:text-rose-300"
                        >
                            <XCircle className="h-3 w-3" />
                            Disapproved
                        </Badge>
                    ) : (
                        <Badge
                            variant="outline"
                            className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
                        >
                            <Lock className="h-3 w-3" />
                            Pending approval
                        </Badge>
                    )}
                    <Badge variant="outline" className="text-[10px]">
                        Specific
                    </Badge>
                    <Badge
                        variant={priorityMeta.badge || 'outline'}
                        className="text-[10px]"
                    >
                        {priorityMeta.label}
                    </Badge>
                    {created && (
                        <span className="text-xs text-muted-foreground">
                            Created {created}
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
                    {task.code && (
                        <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                            {task.code}
                        </span>
                    )}
                    <span className="font-medium">{task.title}</span>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {task.project && (
                        <span>
                            {task.project.name}
                            {task.project.code
                                ? ` (${task.project.code})`
                                : ''}
                        </span>
                    )}
                    <span className="inline-flex items-center gap-1.5">
                        {task.assignee ? (
                            <>
                                <Avatar className="h-5 w-5">
                                    {task.assignee.avatarUrl && (
                                        <AvatarImage
                                            src={resolveAssetUrl(
                                                task.assignee.avatarUrl,
                                            )}
                                            alt={task.assignee.name || ''}
                                        />
                                    )}
                                    <AvatarFallback className="bg-primary/10 text-[9px] font-semibold text-primary">
                                        {initials(task.assignee.name)}
                                    </AvatarFallback>
                                </Avatar>
                                <span>
                                    {task.assignee.name ||
                                        task.assignee.email}
                                </span>
                            </>
                        ) : (
                            <span className="italic">Unassigned</span>
                        )}
                    </span>
                </div>

                {isDisapproved && (
                    <div className="rounded-md border border-rose-200/70 bg-rose-50/60 px-3 py-2 text-xs text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                        {task.rejectionReason && (
                            <p>
                                <span className="font-medium">Reason:</span>{' '}
                                {task.rejectionReason}
                            </p>
                        )}
                        <p className="mt-0.5 text-[11px] opacity-80">
                            Disapproved
                            {task.rejectedBy
                                ? ` by ${task.rejectedBy.name}`
                                : ''}
                            {rejectedOn ? ` on ${rejectedOn}` : ''}
                        </p>
                    </div>
                )}

                {canApprove && showReason && (
                    <div className="space-y-2 rounded-md border border-rose-300/70 bg-rose-50/70 px-3 py-3 dark:border-rose-500/40 dark:bg-rose-500/10">
                        <Label
                            htmlFor={`disapprove-reason-${task.id}`}
                            className="text-xs font-medium text-rose-900 dark:text-rose-200"
                        >
                            Reason for disapproval
                        </Label>
                        <Textarea
                            id={`disapprove-reason-${task.id}`}
                            rows={3}
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="Explain why this task can't be approved (min 3 characters)…"
                            disabled={approving}
                        />
                        <div className="flex justify-end gap-2">
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    setShowReason(false);
                                    setReason('');
                                }}
                                disabled={approving}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700"
                                onClick={submitReason}
                                disabled={approving || reason.trim().length < 3}
                            >
                                <XCircle className="h-4 w-4" />
                                {approving ? 'Working...' : 'Confirm disapproval'}
                            </Button>
                        </div>
                    </div>
                )}

                {!showReason &&
                    (canApprove || (isDisapproved && canRerequest)) && (
                        <div className="flex flex-wrap justify-end gap-2">
                            {/* Re-request: for a disapproved task, shown to
                                approvers AND to the task's creator/assignee
                                so a regular user can re-apply after fixing
                                what the reviewer flagged. */}
                            {isDisapproved && canRerequest && (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="gap-1.5"
                                    onClick={onRerequest}
                                    disabled={approving}
                                >
                                    <RotateCcw className="h-4 w-4" />
                                    {approving
                                        ? 'Working...'
                                        : 'Re-request approval'}
                                </Button>
                            )}
                            {!isDisapproved && canApprove && (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="gap-1.5 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10"
                                    onClick={() => {
                                        setReason('');
                                        setShowReason(true);
                                    }}
                                    disabled={approving}
                                >
                                    <XCircle className="h-4 w-4" />
                                    Disapprove
                                </Button>
                            )}
                            {canApprove && (
                                <Button
                                    type="button"
                                    size="sm"
                                    className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                                    onClick={onApprove}
                                    disabled={approving}
                                >
                                    <CheckCircle2 className="h-4 w-4" />
                                    {approving ? 'Approving...' : 'Approve'}
                                </Button>
                            )}
                        </div>
                    )}
            </CardContent>
        </Card>
    );
}

// ---- Tab C: User approvals (surface-only) ---------------------------

function UserApprovalsPanel({ isAdmin }) {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [denied, setDenied] = useState(false);
    // Keep the full roster in state and narrow client-side. Default to
    // PENDING so the tab still opens on the "awaiting approval" queue.
    const [statusFilter, setStatusFilter] = useState('PENDING');

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            // Non-admins never have access to the user roster / pending
            // queue, so short-circuit to the friendly message rather than
            // firing a request that will just 403.
            if (!isAdmin) {
                setDenied(true);
                setLoading(false);
                return;
            }
            try {
                setLoading(true);
                const { data } = await api.get('/users');
                if (cancelled) return;
                setUsers(data.users || []);
            } catch (err) {
                if (cancelled) return;
                if (err.response?.status === 403) {
                    setDenied(true);
                } else {
                    toast.error(
                        err.response?.data?.error ||
                            'Could not load pending users.',
                    );
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        load();
        return () => {
            cancelled = true;
        };
    }, [isAdmin]);

    if (denied) {
        return (
            <Card>
                <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                    <UserCheck className="h-8 w-8 text-muted-foreground/60" />
                    <p>You don&apos;t have access to user approvals.</p>
                </CardContent>
            </Card>
        );
    }

    if (loading) {
        return (
            <Card>
                <CardContent className="p-6 text-sm text-muted-foreground">
                    Loading pending users...
                </CardContent>
            </Card>
        );
    }

    const filteredUsers = users.filter((u) => {
        if (statusFilter === 'ALL') return true;
        return (u.status || 'ACTIVE') === statusFilter;
    });

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                    User approvals are handled on the Users page.
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
                            <SelectItem value="PENDING">Pending</SelectItem>
                            <SelectItem value="ACTIVE">Active</SelectItem>
                            <SelectItem value="SUSPENDED">
                                Suspended
                            </SelectItem>
                            <SelectItem value="ALL">All</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button asChild variant="outline" size="sm">
                        <Link to="/users?status=pending">
                            <Inbox className="mr-1.5 h-4 w-4" />
                            Go to Users
                        </Link>
                    </Button>
                </div>
            </div>

            {filteredUsers.length === 0 ? (
                <p className="px-1 text-sm text-muted-foreground">
                    No users match this filter.
                </p>
            ) : (
                <div className="grid gap-3">
                    {filteredUsers.map((u) => (
                        <Card key={u.id}>
                            <CardContent className="flex flex-wrap items-center gap-3 p-4">
                                <Avatar className="h-9 w-9">
                                    {u.avatarUrl && (
                                        <AvatarImage
                                            src={resolveAssetUrl(u.avatarUrl)}
                                            alt={u.name || ''}
                                        />
                                    )}
                                    <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                                        {initials(u.name)}
                                    </AvatarFallback>
                                </Avatar>
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium">
                                        {u.name || u.email}
                                    </div>
                                    <div className="truncate text-xs text-muted-foreground">
                                        {u.email}
                                        {u.createdAt
                                            ? ` · signed up ${format(
                                                  new Date(u.createdAt),
                                                  'PP',
                                              )}`
                                            : ''}
                                    </div>
                                </div>
                                <Button asChild variant="ghost" size="sm">
                                    <Link to="/users?status=pending">
                                        Review
                                    </Link>
                                </Button>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}
