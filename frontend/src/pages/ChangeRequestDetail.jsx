// Change Request detail page.
//
// URL: /projects/:projectId/cr/:crId
//
// M2 scope is intentionally lean — it ships the breadcrumb /
// header / summary surface and an Estimation placeholder that
// matches the project page. Tasks / notes / time-entry scoping to
// this CR lands in M3 (we need a `changeRequestId` column on those
// models first). The route is registered now so deep-links from
// audit log + project CR list work end-to-end.

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
    ArrowLeft,
    Pencil,
    Trash2,
    Calculator,
    GitPullRequest,
    Paperclip,
    Wallet,
    Clock,
    Hash,
    ListChecks,
    StickyNote,
    User as UserIcon,
} from 'lucide-react';

import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useProjectStatuses } from '@/lib/statuses';
import { CAPABILITIES, hasCapability } from '@/lib/capabilities';

import { TopBar } from '@/components/TopBar';
import { ChangeRequestFormDialog } from '@/components/ChangeRequestFormDialog';
import { PhasesPlan } from '@/components/PhasesPlan';
import { NotesPanel } from '@/components/NotesPanel';
import { FilesPanel } from '@/components/FilesPanel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

function initials(name) {
    if (!name) return '?';
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join('')
        .toUpperCase();
}

function formatMoney(amount, currency) {
    if (amount == null || amount === '') return '—';
    const n = Number(amount);
    if (!Number.isFinite(n)) return '—';
    try {
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: currency || 'EUR',
            maximumFractionDigits: 2,
        }).format(n);
    } catch {
        return `${n.toFixed(2)} ${currency || ''}`.trim();
    }
}

export default function ChangeRequestDetail() {
    const { projectId, crId } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const { user: currentUser } = useAuth();

    const [cr, setCr] = useState(null);
    const [phases, setPhases] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [users, setUsers] = useState([]);
    const [notesCount, setNotesCount] = useState(0);
    const [filesCount, setFilesCount] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [editDialogOpen, setEditDialogOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [activeTab, setActiveTab] = useState('plan');

    const { find: findCrStatus } = useProjectStatuses();

    // Single round-trip: /change-requests/:id/plan returns the CR +
    // its parent project's phases + only the tasks scoped to this CR.
    // Reusing the project's phases keeps the Plan UI consistent
    // across project and CR views.
    const load = async () => {
        if (!crId) return;
        setLoading(true);
        setError(null);
        try {
            const { data } = await api.get(`/change-requests/${crId}/plan`);
            setCr(data.changeRequest);
            setPhases(data.phases || []);
            setTasks(data.tasks || []);
            setNotesCount(
                typeof data.notesCount === 'number' ? data.notesCount : 0,
            );
            setFilesCount(
                typeof data.filesCount === 'number' ? data.filesCount : 0,
            );
            // If the URL projectId doesn't match the CR's actual
            // project, redirect to the canonical URL. Cheap insurance
            // against stale links from a copy-paste.
            if (
                data.changeRequest?.project?.id &&
                data.changeRequest.project.id !== projectId
            ) {
                navigate(
                    `/projects/${data.changeRequest.project.id}/cr/${crId}`,
                    { replace: true },
                );
            }
        } catch (err) {
            setError(
                err?.response?.data?.error || 'Failed to load change request',
            );
        } finally {
            setLoading(false);
        }
    };

    // Project participant list — PhasesPlan needs it to populate the
    // assignee picker on the task dialog. The participants endpoint
    // returns rows that spread user fields at the top level
    // ({id, name, email, avatarUrl, addedAt, addedBy}) so we can
    // pass them straight through.
    useEffect(() => {
        if (!cr?.project?.id) return;
        let cancelled = false;
        api.get(`/projects/${cr.project.id}/participants`)
            .then(({ data }) => {
                if (cancelled) return;
                setUsers(data.participants || []);
            })
            .catch(() => {
                // Non-fatal — assignee picker will just be empty.
            });
        return () => {
            cancelled = true;
        };
    }, [cr?.project?.id]);

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [crId]);

    // Hash → tab routing. Mirrors ProjectDetail's behaviour so the
    // backend's notification links (built by notify.buildLink, M4)
    // can deep-link straight into the right tab:
    //   #note-<id>  → switch to Notes tab; NotesPanel itself spots
    //                 the hash and scrolls/highlights the row
    //   #task-<id>  → switch to Plan tab; PhasesPlan handles the
    //                 scroll + spotlight + parent-expand
    //   #file-<id>  → switch to Files tab (M5)
    //   #notes / #plan / #files → bare tab switch
    // We only react to non-empty hashes; an empty hash keeps the
    // current tab so direct navigation to /projects/X/cr/Y doesn't
    // overwrite a user's manual tab choice.
    useEffect(() => {
        const hash = location.hash || '';
        if (!hash) return;
        if (/^#note-/.test(hash) || hash === '#notes') {
            setActiveTab('notes');
        } else if (/^#task-/.test(hash) || hash === '#plan') {
            setActiveTab('plan');
        } else if (/^#file-/.test(hash) || hash === '#files') {
            setActiveTab('files');
        }
    }, [location.hash]);

    const isAdmin = currentUser?.role === 'ADMIN';
    const isOwner =
        cr?.project?.ownerId && currentUser?.id === cr.project.ownerId;
    const canEdit =
        isAdmin ||
        isOwner ||
        hasCapability(currentUser, CAPABILITIES.CR_EDIT);
    const canDelete =
        isAdmin || hasCapability(currentUser, CAPABILITIES.CR_DELETE);

    // find() resolves the admin-managed status (label/color/badge) and
    // falls back for hidden/custom keys so the CR badge never blanks out.
    const statusMeta = useMemo(() => {
        if (!cr?.status) return null;
        return findCrStatus(cr.status);
    }, [cr?.status, findCrStatus]);

    const submitEdit = async (payload) => {
        if (!cr?.id) return;
        setSubmitting(true);
        try {
            const { data } = await api.patch(
                `/change-requests/${cr.id}`,
                payload,
            );
            setCr(data.changeRequest);
            setEditDialogOpen(false);
            toast.success('Change request updated');
        } catch (err) {
            toast.error(
                err?.response?.data?.error ||
                    'Failed to update change request',
            );
        } finally {
            setSubmitting(false);
        }
    };

    const remove = async () => {
        if (!cr?.id) return;
        if (
            !window.confirm(
                `Delete change request "${cr.title}"? This drops its value from the project total.`,
            )
        ) {
            return;
        }
        try {
            await api.delete(`/change-requests/${cr.id}`);
            toast.success('Change request deleted');
            navigate(`/projects/${cr.project.id}?tab=change-requests`);
        } catch (err) {
            toast.error(
                err?.response?.data?.error ||
                    'Failed to delete change request',
            );
        }
    };

    if (loading) {
        return (
            <>
                <TopBar />
                <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                    <p className="text-sm text-muted-foreground">Loading…</p>
                </main>
            </>
        );
    }
    if (error || !cr) {
        return (
            <>
                <TopBar />
                <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(-1)}
                        className="mb-4 gap-2"
                    >
                        <ArrowLeft className="h-4 w-4" /> Back
                    </Button>
                    <p className="text-sm text-destructive">
                        {error || 'Change request not found'}
                    </p>
                </main>
            </>
        );
    }

    const project = cr.project || {};
    const internalCurrency = cr.internalCurrency || 'EUR';
    const clientCurrency = cr.clientCurrency || 'EUR';

    const TABS = [
        { id: 'plan', label: 'Plan', icon: ListChecks, count: tasks.length },
        { id: 'notes', label: 'Notes', icon: StickyNote, count: notesCount },
        { id: 'files', label: 'Files', icon: Paperclip, count: filesCount },
        { id: 'overview', label: 'Overview', icon: GitPullRequest },
        { id: 'estimation', label: 'Estimation', icon: Calculator },
    ];

    // Same gates the project Plan uses, but applied here so
    // PhasesPlan inside the CR view shows add/edit task buttons for
    // the right people. The CR's parent project's ownerId is in
    // cr.project.ownerId. We also derive the same narrower
    // edit / delete / own-task flags PhasesPlan needs so a CR view
    // honours capability checkboxes identically to the project's
    // Plan tab.
    const isPersonalProject = Boolean(cr?.project?.isPersonal);
    // Mirror ProjectDetail's closed-project lock: a DONE shared
    // project disables task capabilities for regular users so the
    // PhasesPlan embedded in the CR view doesn't surface add / edit /
    // delete buttons the API would refuse anyway.
    const isProjectClosed = cr?.project?.status === 'DONE';
    const isManager = currentUser?.role === 'MANAGER';
    const isProjectLocked =
        isProjectClosed &&
        !isAdmin &&
        !isManager &&
        !(isPersonalProject && isOwner);
    const canCreateTaskCap =
        !isProjectLocked &&
        hasCapability(currentUser, CAPABILITIES.TASK_CREATE_ANY);
    const canEditTaskCap =
        !isProjectLocked &&
        hasCapability(currentUser, CAPABILITIES.TASK_EDIT_ANY);
    const canDeleteTaskCap =
        !isProjectLocked &&
        hasCapability(currentUser, CAPABILITIES.TASK_DELETE_ANY);
    const canManageTasks =
        isAdmin ||
        isManager ||
        (isPersonalProject && isOwner) ||
        canCreateTaskCap ||
        canEditTaskCap ||
        canDeleteTaskCap;
    const canEditExistingTask =
        isAdmin ||
        isManager ||
        (isPersonalProject && isOwner) ||
        canEditTaskCap;
    const canDeleteExistingTask =
        isAdmin ||
        isManager ||
        (isPersonalProject && isOwner) ||
        canDeleteTaskCap;
    // Approve "specific" tasks: Admin, Manager, or `task:approve` holder.
    const canApproveTasks =
        isAdmin ||
        isManager ||
        hasCapability(currentUser, CAPABILITIES.TASK_APPROVE);
    const canCreateSpecificTasks =
        isAdmin ||
        isManager ||
        hasCapability(currentUser, CAPABILITIES.TASK_SPECIFIC_CREATE);
    // Phases live at the project level — there's only one phase
    // table per project, and the CR view is just a filtered window
    // onto the same plan. So phase management mirrors the project's
    // rule exactly: admin on shared projects, owner on personal
    // ones. Any phase added / renamed / deleted here also affects
    // the parent project's plan (and any sibling CRs that show it).
    const canManagePhases = isAdmin || (isPersonalProject && isOwner);

    return (
        <>
            <TopBar />
            {/* See ProjectDetail.jsx — `<main>` has no top padding so
                the sticky tab bar lower down can pin flush against the
                TopBar. The `pt-3 sm:pt-6` wrapper restores top spacing
                for the breadcrumb + header. */}
            <main className="flex-1 overflow-auto bg-muted/20 px-3 pb-3 sm:px-6 sm:pb-6">
                <div className="pt-3 sm:pt-6">
                <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
                    <Link
                        to="/projects"
                        className="hover:text-foreground hover:underline"
                    >
                        Projects
                    </Link>
                    <span>/</span>
                    <Link
                        to={`/projects/${project.id}`}
                        className="hover:text-foreground hover:underline"
                    >
                        {project.code ? (
                            <span className="font-mono">{project.code}</span>
                        ) : (
                            project.name
                        )}
                    </Link>
                    <span>/</span>
                    <Link
                        to={`/projects/${project.id}?tab=change-requests`}
                        className="hover:text-foreground hover:underline"
                    >
                        Change requests
                    </Link>
                    <span>/</span>
                    <span className="font-mono text-foreground">
                        {cr.code || cr.id.slice(0, 8)}
                    </span>
                </div>

                <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2">
                            <GitPullRequest className="h-5 w-5 text-muted-foreground" />
                            <h1 className="text-2xl font-semibold">
                                {cr.title}
                            </h1>
                            {statusMeta ? (
                                <Badge variant={statusMeta.badge || 'secondary'}>
                                    {statusMeta.label}
                                </Badge>
                            ) : null}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {cr.code ? (
                                <span className="font-mono">{cr.code}</span>
                            ) : null}
                            {cr.code ? ' • ' : ''}
                            <span>
                                On project{' '}
                                <Link
                                    to={`/projects/${project.id}`}
                                    className="hover:underline"
                                >
                                    {project.name}
                                </Link>
                            </span>
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                                navigate(
                                    `/projects/${project.id}?tab=change-requests`,
                                )
                            }
                            className="gap-1.5"
                        >
                            <ArrowLeft className="h-4 w-4" />
                            Back to project
                        </Button>
                        {canEdit && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setEditDialogOpen(true)}
                                className="gap-1.5"
                            >
                                <Pencil className="h-4 w-4" />
                                Edit
                            </Button>
                        )}
                        {canDelete && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={remove}
                                className="gap-1.5 text-destructive hover:text-destructive"
                            >
                                <Trash2 className="h-4 w-4" />
                                Delete
                            </Button>
                        )}
                    </div>
                </div>

                </div>
                {/* Sticky tab bar — same treatment as ProjectDetail
                    so the plan inside a Change Request also keeps its
                    navigation visible while scrolling. PhasesPlan's
                    own sticky filter row docks just below this bar at
                    top:37px, so they stack cleanly without leaving a
                    gap. Fully opaque background so the muted page
                    background doesn't bleed through. */}
                <div className="sticky top-0 z-30 -mx-3 mb-4 border-b bg-background px-3 shadow-sm sm:-mx-6 sm:px-6">
                    <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1">
                        {TABS.map((t) => {
                            const Icon = t.icon;
                            return (
                                <button
                                    key={t.id}
                                    type="button"
                                    onClick={() => setActiveTab(t.id)}
                                    className={`inline-flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-1 text-[12px] font-medium transition-colors ${
                                        activeTab === t.id
                                            ? 'border-primary text-foreground'
                                            : 'border-transparent text-muted-foreground hover:text-foreground'
                                    }`}
                                >
                                    <Icon className="h-3 w-3" />
                                    {t.label}
                                    {t.count ? (
                                        <span className="ml-1 text-[11px] text-muted-foreground">
                                            {t.count}
                                        </span>
                                    ) : null}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {activeTab === 'plan' && (
                    <PhasesPlan
                        projectId={cr.project?.id}
                        projectName={cr.project?.name}
                        phases={phases}
                        tasks={tasks}
                        users={users}
                        canManage={canManageTasks}
                        canEditTask={canEditExistingTask}
                        canDeleteTask={canDeleteExistingTask}
                        canManageOwnTasks={canCreateTaskCap}
                        canApprove={canApproveTasks}
                        canCreateSpecific={canCreateSpecificTasks}
                        // Phase CRUD is allowed (admin / personal
                        // project owner) — see canManagePhases note
                        // above. Heads-up: phases are project-wide,
                        // so adds/edits/deletes here also affect the
                        // parent project's Plan view.
                        canManagePhases={canManagePhases}
                        currentUserId={currentUser?.id}
                        changeRequestId={cr.id}
                        onChanged={load}
                    />
                )}

                {activeTab === 'notes' && (
                    // Reuse the project NotesPanel in CR mode. It scopes
                    // both the GET filter and the new-note submit to
                    // this CR — surfaces notes pinned directly to the
                    // CR plus notes on its tasks (so the user sees one
                    // unified discussion thread for the CR).
                    <NotesPanel
                        projectId={cr.project?.id}
                        changeRequestId={cr.id}
                    />
                )}

                {activeTab === 'files' && (
                    // M5: same reuse pattern as NotesPanel. The CR
                    // mode narrows the GET filter to files "about"
                    // the CR (direct pin + files on CR-pinned
                    // notes + files on notes pinned to CR-scoped
                    // tasks) and stamps new uploads with the CR id.
                    <FilesPanel
                        projectId={cr.project?.id}
                        changeRequestId={cr.id}
                    />
                )}

                {activeTab === 'overview' && (
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">
                                    Description
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                {cr.description ? (
                                    <p className="whitespace-pre-wrap text-sm">
                                        {cr.description}
                                    </p>
                                ) : (
                                    <p className="text-sm text-muted-foreground">
                                        No description.
                                    </p>
                                )}
                            </CardContent>
                        </Card>

                        <aside className="space-y-4">
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                                        Billing
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <MoneyRow
                                        label="Client"
                                        amount={cr.clientAmount}
                                        currency={clientCurrency}
                                        paid={cr.clientPaid}
                                        paidAt={cr.clientPaidAt}
                                    />
                                    <MoneyRow
                                        label="Internal"
                                        amount={cr.internalAmount}
                                        currency={internalCurrency}
                                        paid={cr.internalPaid}
                                        paidAt={cr.internalPaidAt}
                                    />
                                    {cr.estimatedHours != null ? (
                                        <div className="flex items-center justify-between border-t pt-3 text-sm">
                                            <span className="flex items-center gap-2 text-muted-foreground">
                                                <Clock className="h-3.5 w-3.5" />
                                                Estimated hours
                                            </span>
                                            <span className="tabular-nums font-medium">
                                                {cr.estimatedHours}
                                            </span>
                                        </div>
                                    ) : null}
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                                        Meta
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-2 text-sm">
                                    <MetaRow
                                        icon={Hash}
                                        label="Code"
                                        value={
                                            cr.code ? (
                                                <span className="font-mono">
                                                    {cr.code}
                                                </span>
                                            ) : (
                                                '—'
                                            )
                                        }
                                    />
                                    <MetaRow
                                        icon={UserIcon}
                                        label="Created by"
                                        value={
                                            cr.createdBy ? (
                                                <Link
                                                    to={`/users/${cr.createdBy.id}`}
                                                    className="flex items-center gap-1.5 hover:underline"
                                                >
                                                    <Avatar className="h-5 w-5">
                                                        <AvatarImage
                                                            src={
                                                                cr.createdBy.avatarUrl ||
                                                                undefined
                                                            }
                                                        />
                                                        <AvatarFallback className="text-[10px]">
                                                            {initials(
                                                                cr.createdBy.name,
                                                            )}
                                                        </AvatarFallback>
                                                    </Avatar>
                                                    {cr.createdBy.name}
                                                </Link>
                                            ) : (
                                                '—'
                                            )
                                        }
                                    />
                                    <MetaRow
                                        icon={Wallet}
                                        label="Created"
                                        value={
                                            cr.createdAt
                                                ? format(
                                                    new Date(cr.createdAt),
                                                    'MMM d, yyyy',
                                                )
                                                : '—'
                                        }
                                    />
                                    <MetaRow
                                        icon={Wallet}
                                        label="Updated"
                                        value={
                                            cr.updatedAt
                                                ? format(
                                                    new Date(cr.updatedAt),
                                                    'MMM d, yyyy',
                                                )
                                                : '—'
                                        }
                                    />
                                </CardContent>
                            </Card>
                        </aside>
                    </div>
                )}

                {activeTab === 'estimation' && (
                    <div className="rounded-lg border border-dashed bg-card p-8 text-center">
                        <Calculator className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
                        <h3 className="text-base font-semibold">
                            Estimation
                        </h3>
                        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                            The estimation surface for change requests is
                            being designed. It will live here without
                            changing the URL.
                        </p>
                        {!canEdit ? (
                            <p className="mx-auto mt-3 max-w-md text-[11px] uppercase tracking-wide text-muted-foreground">
                                Read-only — only managers, admins or the
                                project owner will be able to edit
                                estimates.
                            </p>
                        ) : null}
                    </div>
                )}
            </main>

            <ChangeRequestFormDialog
                open={editDialogOpen}
                onOpenChange={setEditDialogOpen}
                onSubmit={submitEdit}
                submitting={submitting}
                initialValues={cr}
                internalCurrency={internalCurrency}
                clientCurrency={clientCurrency}
                title="Edit change request"
                submitLabel="Save changes"
            />
        </>
    );
}

function MoneyRow({ label, amount, currency, paid, paidAt }) {
    return (
        <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{label}</span>
            <div className="text-right">
                <div className="tabular-nums font-medium">
                    {formatMoney(amount, currency)}
                </div>
                {paid ? (
                    <div className="text-[11px] text-emerald-600">
                        Paid
                        {paidAt
                            ? ` • ${format(new Date(paidAt), 'MMM d')}`
                            : ''}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function MetaRow({ icon: Icon, label, value }) {
    return (
        <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-muted-foreground">
                <Icon className="h-3.5 w-3.5" />
                {label}
            </span>
            <span className="truncate text-right">{value}</span>
        </div>
    );
}
