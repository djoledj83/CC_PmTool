import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
    ArrowLeft,
    Trash2,
    Pencil,
    CalendarDays,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Check,
    CheckCircle2,
    Download,
    FileText,
    Flag,
    ListChecks,
    MessageSquare,
    Paperclip,
    RotateCcw,
    StickyNote,
    User as UserIcon,
    Globe,
    Briefcase,
    Hash,
    Tag,
    Clock,
    TrendingUp,
    Receipt,
    Wallet,
    DollarSign,
    FolderKanban,
    Package,
    Zap,
    Calculator,
    Wrench,
    GitPullRequest,
    Plus,
    Share2,
    LifeBuoy,
} from 'lucide-react';
import ShareDialog from '@/components/ShareDialog';

import { api } from '@/lib/api';
import { downloadFromApi } from '@/lib/download';
import { useAuth } from '@/contexts/AuthContext';
import {
    PROJECT_STATUS_MAP,
    PROJECT_PRIORITY_MAP,
} from '@/lib/constants';
import { useProjectPriorities } from '@/lib/priorities';
import { useProjectStatuses } from '@/lib/statuses';
import {
    CAPABILITIES as CAPABILITIES_FRONT,
    hasCapability,
} from '@/lib/capabilities';
import { labelColorClass } from '@/lib/labelColors';
import { parseProjectLabels } from '@/lib/projectLabels';
import {
    cn,
    daysRemainingFromStart,
    durationInDays,
    initials,
    markDeepLinkHandled,
    resolveAssetUrl,
    timeProgress,
    timeProgressColorClass,
    timeProgressTextClass,
    timeRemainingLabel,
} from '@/lib/utils';
import { TopBar } from '@/components/TopBar';
import { ProjectFormDialog } from '@/components/ProjectFormDialog';
import { ConfirmDeleteDialog } from '@/components/ConfirmDeleteDialog';
import { ChangeRequestFormDialog } from '@/components/ChangeRequestFormDialog';
import { NotesPanel } from '@/components/NotesPanel';
import { FilesPanel } from '@/components/FilesPanel';
import { ProjectTicketsPanel } from '@/components/ProjectTicketsPanel';
import { PhasesPlan } from '@/components/PhasesPlan';
import { ProjectChatPanel } from '@/components/ProjectChatPanel';
import SprintsPanel from '@/components/SprintsPanel';
import { ParticipantsPanel } from '@/components/ParticipantsPanel';
import { ProjectTeamsPanel } from '@/components/ProjectTeamsPanel';
import { ProjectContactsPanel } from '@/components/ProjectContactsPanel';
import { TimeTrackingCard } from '@/components/TimeTrackingCard';
import { kindMeta as activityKindMeta } from '@/components/PlanActivities';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';

function formatDate(d) {
    if (!d) return '—';
    return format(new Date(d), 'MMM d, yyyy');
}

// Persist the open/closed state of each side-panel section per project.
// We key by projectId + section so different projects can keep different
// preferences without trampling on each other.
function useSectionCollapsed(projectId, key, defaultValue = false) {
    const storageKey = projectId
        ? `pm.projectDetails.section.${projectId}.${key}`
        : null;
    const [collapsed, setCollapsed] = useState(() => {
        if (typeof window === 'undefined' || !storageKey) return defaultValue;
        const raw = window.localStorage.getItem(storageKey);
        return raw == null ? defaultValue : raw === '1';
    });

    useEffect(() => {
        if (!storageKey) return;
        window.localStorage.setItem(storageKey, collapsed ? '1' : '0');
    }, [collapsed, storageKey]);

    return [collapsed, setCollapsed];
}

// A Card with a chevron-toggle header. We keep the same visual styling
// as the existing project cards (padding, border, title size) so the
// collapse animation feels native.
function CollapsibleCard({
    title,
    icon: Icon,
    rightSlot,
    collapsed,
    onToggle,
    children,
    contentClassName,
}) {
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
                        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
                        <CardTitle className="text-base">{title}</CardTitle>
                    </button>
                    {rightSlot}
                </div>
            </CardHeader>
            {!collapsed && (
                <CardContent className={contentClassName ?? 'space-y-4'}>
                    {children}
                </CardContent>
            )}
        </Card>
    );
}

function formatDateTime(d) {
    if (!d) return '—';
    return format(new Date(d), "MMM d, yyyy 'at' h:mm a");
}

const BASE_TABS = [
    { id: 'plan', label: 'Plan', icon: ListChecks },
    { id: 'sprints', label: 'Sprints', icon: Zap },
    // Change requests: chargeable additive scope, M2. The tab label
    // also surfaces a count badge — see `tabsWithCounts` below.
    { id: 'change-requests', label: 'Change requests', icon: GitPullRequest },
    // Estimation: scaffolding for the M1 placeholder. Surface is empty
    // by design — final fields/UI are co-designed with the user. Same
    // tab will be rendered on the CR detail page in M2.
    { id: 'estimation', label: 'Estimation', icon: Calculator },
    { id: 'notes', label: 'Notes', icon: StickyNote },
    { id: 'files', label: 'Files', icon: Paperclip },
    // Help-desk tickets linked to this project (projectId match).
    { id: 'tickets', label: 'Tickets', icon: LifeBuoy },
];
const CHAT_TAB = { id: 'chat', label: 'Chat', icon: MessageSquare };

// Task progress is always derived from the project's task list — no
// manual override anymore. Keeps the number honest as work moves on.
function taskProgress(project) {
    const total = project.tasks?.length ?? 0;
    const done = project.tasks?.filter((t) => t.status === 'DONE').length ?? 0;
    return total === 0 ? 0 : Math.round((done / total) * 100);
}

// Pick the activity that best represents "what's happening next on
// this project". We prefer the soonest upcoming non-done activity;
// if everything is in the past or completed we fall back to the most
// recent one (so the Timeline card never goes blank for a project
// that has activities).
function pickLatestActivity(project) {
    const list = project?.activities || [];
    if (!list.length) return null;
    const now = Date.now();
    const upcoming = list
        .filter((a) => !a.done && a.scheduledAt)
        .filter((a) => new Date(a.scheduledAt).getTime() >= now)
        .sort(
            (a, b) =>
                new Date(a.scheduledAt).getTime() -
                new Date(b.scheduledAt).getTime(),
        );
    if (upcoming.length) return { ...upcoming[0], _kind: 'upcoming' };
    const past = list
        .filter((a) => a.scheduledAt)
        .sort(
            (a, b) =>
                new Date(b.scheduledAt).getTime() -
                new Date(a.scheduledAt).getTime(),
        );
    if (past.length) return { ...past[0], _kind: 'past' };
    return { ...list[0], _kind: 'past' };
}

export default function ProjectDetail() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { user: currentUser } = useAuth();
    const [project, setProject] = useState(null);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editDialogOpen, setEditDialogOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [submittingProject, setSubmittingProject] = useState(false);
    const [activeTab, setActiveTab] = useState('plan');
    const [exporting, setExporting] = useState(false);
    const [togglingComplete, setTogglingComplete] = useState(false);
    // Persisted "left details panel" collapsed state. One toggle hides the
    // entire aside (Summary, Participants, Timeline, Description) and lets
    // the Plan/Notes/Files/Chat section take the full width.
    const [detailsCollapsed, setDetailsCollapsed] = useState(() => {
        try {
            return localStorage.getItem('pm.projectDetails.collapsed.v1') === '1';
        } catch {
            return false;
        }
    });
    useEffect(() => {
        try {
            localStorage.setItem(
                'pm.projectDetails.collapsed.v1',
                detailsCollapsed ? '1' : '0',
            );
        } catch {
            /* ignore quota errors */
        }
    }, [detailsCollapsed]);

    // Per-section collapse states. The aside-level collapse hides everything
    // at once; these let each card collapse individually so users can keep
    // only the panels they care about open.
    const [summaryCollapsed, setSummaryCollapsed] = useSectionCollapsed(id, 'summary');
    const [participantsCollapsed, setParticipantsCollapsed] = useSectionCollapsed(
        id,
        'participants',
    );
    const [teamsCollapsed, setTeamsCollapsed] = useSectionCollapsed(
        id,
        'teams',
        true,
    );
    const [contactsCollapsed, setContactsCollapsed] = useSectionCollapsed(
        id,
        'contacts',
        true,
    );
    const [timelineCollapsed, setTimelineCollapsed] = useSectionCollapsed(
        id,
        'timeline',
        true,
    );
    const [descriptionCollapsed, setDescriptionCollapsed] = useSectionCollapsed(
        id,
        'description',
    );
    const [billingCollapsed, setBillingCollapsed] = useSectionCollapsed(
        id,
        'billing',
    );
    // Time tracking card: collapsed by default so we don't make the
    // right rail any taller for users who don't actively track time.
    const [timeCollapsed, setTimeCollapsed] = useSectionCollapsed(
        id,
        'time',
        true,
    );

    const isAdmin = currentUser?.role === 'ADMIN';
    const isManager = currentUser?.role === 'MANAGER';
    const isOwner = project ? project.ownerId === currentUser?.id : false;
    const isPersonalProject = Boolean(project?.isPersonal);
    // Project edit/delete/close: admins on any project, plus the
    // owner of a personal project (their private organiser, full
    // control). Managers and other participants cannot touch the
    // project record itself on shared projects.
    const canManageProject = isAdmin || (isPersonalProject && isOwner);
    // Per-user capability overrides for the three "Projects" checkboxes
    // in the admin User dialog. Each unlocks a SLICE of project
    // management without granting full edit:
    //   - PROJECT_CLOSE → flip a shared project's status to/from DONE.
    //   - PROJECT_BILLING_MANAGE → edit the seven billing fields.
    //   - PROJECT_PARTICIPANTS_MANAGE → add / remove participants.
    // All three were previously dead code (catalogue-only) — the
    // backend now consults them and these flags drive the matching UI.
    const canCloseProjectCap = hasCapability(
        currentUser,
        CAPABILITIES_FRONT.PROJECT_CLOSE,
    );
    const canEditBillingCap = hasCapability(
        currentUser,
        CAPABILITIES_FRONT.PROJECT_BILLING_MANAGE,
    );
    const canManageParticipantsCap = hasCapability(
        currentUser,
        CAPABILITIES_FRONT.PROJECT_PARTICIPANTS_MANAGE,
    );
    // True when the user can flip a SHARED project between active and
    // DONE. Personal-owner / admin still goes through canManageProject;
    // this widens the gate to include the per-user cap.
    const canCloseProject = canManageProject || canCloseProjectCap;
    // True when the Edit-Project dialog should be reachable AT ALL. We
    // open the dialog for billing-cap holders so they can change their
    // allowed fields; the dialog itself hides everything else.
    const canOpenProjectEdit =
        canManageProject || canEditBillingCap;
    // Task/subtask CRUD inside the plan is allowed for:
    //   - admins on any project,
    //   - managers on projects they can already see,
    //   - the owner of a personal project (so individuals can fully
    //     manage their own organiser),
    //   - regular users to whom the admin has granted ANY of the
    //     three task capability checkboxes (create / edit / delete).
    //
    // We OR the three together here because PhasesPlan currently
    // toggles every per-row action (add, edit, delete) behind a single
    // `canManage` flag. A finer per-button gating (only Edit visible
    // for task:edit:any holders, etc.) is a planned P3 follow-up; for
    // now any of the three flags is enough to unlock the plan UI, and
    // the backend rejects whichever specific op the user actually
    // lacks if they try to use a button they shouldn't.
    // Closed (DONE) shared projects lock down writes for regular
    // users. Admins / managers keep their override so they can fix
    // records after the fact; personal-project owners keep editing
    // their own organiser regardless of status. This mirrors the
    // server-side `assertProjectWritable()` gate so the buttons we
    // hide here line up exactly with what the API would refuse.
    const isProjectClosed = project?.status === 'DONE';
    const isProjectLocked =
        isProjectClosed &&
        !isAdmin &&
        !isManager &&
        !(isPersonalProject && isOwner);
    const canCreateTaskCap =
        !isProjectLocked &&
        hasCapability(currentUser, CAPABILITIES_FRONT.TASK_CREATE_ANY);
    const canEditTaskCap =
        !isProjectLocked &&
        hasCapability(currentUser, CAPABILITIES_FRONT.TASK_EDIT_ANY);
    const canDeleteTaskCap =
        !isProjectLocked &&
        hasCapability(currentUser, CAPABILITIES_FRONT.TASK_DELETE_ANY);
    const canManageTasks =
        isAdmin ||
        isManager ||
        (isPersonalProject && isOwner) ||
        canCreateTaskCap ||
        canEditTaskCap ||
        canDeleteTaskCap;
    // Who may approve "specific" tasks: Admin, Manager, or holders of
    // the `task:approve` capability. Mirrors the backend's guard.
    const canApproveTasks =
        isAdmin ||
        isManager ||
        hasCapability(currentUser, CAPABILITIES_FRONT.TASK_APPROVE);
    // Who may RAISE a specific (approval-required) task.
    const canCreateSpecificTasks =
        isAdmin ||
        isManager ||
        hasCapability(currentUser, CAPABILITIES_FRONT.TASK_SPECIFIC_CREATE);
    // Narrower flag that is true ONLY when the user actually has the
    // right to MODIFY existing task records (admin, manager, personal
    // project owner, or holders of `task:edit:any`). A user with just
    // `task:create:any` or `task:delete:any` must NOT be routed into
    // the edit dialog when they click a task title — they get the
    // read-only quick-view instead.
    //
    // PhasesPlan also receives `canManageOwnTasks` (true when the
    // user holds `task:create:any`) and uses it together with each
    // task's `createdBy` to overlay per-row edit / delete on tasks
    // the user created themselves. So a `task:create:any`-only user
    // sees a clean read-only view of the plan AND full edit/delete
    // controls on the rows THEY made.
    const canEditExistingTask =
        isAdmin ||
        isManager ||
        (isPersonalProject && isOwner) ||
        canEditTaskCap;
    // Parallel flag for the Delete button. Same ladder but
    // substituting `task:delete:any` for `task:edit:any`. Own-task
    // overlay still applies on top via the per-row check inside
    // PhasesPlan / TaskRow.
    const canDeleteExistingTask =
        isAdmin ||
        isManager ||
        (isPersonalProject && isOwner) ||
        canDeleteTaskCap;
    const isParticipant = Boolean(project?.isParticipant) || isOwner;
    // Export is read-only, so admins or anyone who can see the project may
    // download a workbook for it.
    const canExportProject = isAdmin || isParticipant;
    const tabs = isParticipant ? [...BASE_TABS, CHAT_TAB] : BASE_TABS;

    // If a non-participant happens to land on the chat tab (e.g. they were
    // removed mid-session), bounce them back to Plan so the UI stays sane.
    useEffect(() => {
        if (activeTab === 'chat' && project && !isParticipant) {
            setActiveTab('plan');
        }
    }, [activeTab, project, isParticipant]);

    // Deep-link tab routing from the URL hash. Notification clicks land
    // here with hashes like `#task-<id>`, `#activity-<id>`, `#note-<id>`,
    // `#notes`, `#files`, `#chat` — switch to the right tab so the
    // corresponding panel is mounted before its own scroll-into-view
    // logic runs. Clears nothing — this only flips the tab, the
    // anchor-handlers inside each panel do the actual scrolling.
    const location = useLocation();

    // One-shot "pulse this task" trigger fed by clicks on a
    // task notification. NotificationBell appends a unique
    // `?pulse=<timestamp>` to the link on every click; we watch
    // that timestamp + the `#task-…` hash and flip a per-task
    // pulse counter that PhasesPlan / TaskRow turn into a brief
    // ring animation. The counter (rather than a static
    // taskId) is what lets the SAME task pulse again on a
    // second notification click — the value changes even when
    // the target is identical.
    const [pulseTask, setPulseTask] = useState({ taskId: null, nonce: 0 });

    // Shrink-on-stick logic for the project tab bar (Plan / Sprints /
    // Change requests / …). We attach a scroll listener to the nearest
    // scrollable ancestor (the <main> with overflow-auto in this
    // layout) and flip `tabsStuck` once the user has scrolled past
    // the top. A scroll listener is more reliable than an
    // IntersectionObserver with a zero-height sentinel — sentinels
    // smaller than 1px sometimes don't fire IO callbacks at all in
    // Chromium when the page hasn't fully laid out yet, which left
    // the bar permanently at "rest" size.
    //
    // The rAF gate coalesces rapid scroll events into one state
    // change per frame so React doesn't churn on fast wheel input.
    //
    // We expose the *current* bar height as a CSS variable so other
    // sticky elements lower on the page (e.g. PhasesPlan's filter
    // row) can sit flush under it regardless of which variant is
    // active — see the `--project-tabs-h` consumer in PhasesPlan.
    const tabsBarRef = useRef(null);
    const [tabsStuck, setTabsStuck] = useState(false);
    useEffect(() => {
        const el = tabsBarRef.current;
        if (!el) return undefined;
        // Walk up to find the nearest scrollable ancestor (<main>
        // in this layout). We don't hard-code it so the detection
        // still works if the layout is reorganised.
        let scrollRoot = el.parentElement;
        while (scrollRoot && scrollRoot !== document.body) {
            const style = window.getComputedStyle(scrollRoot);
            if (/(auto|scroll|overlay)/.test(style.overflowY)) break;
            scrollRoot = scrollRoot.parentElement;
        }
        const usingWindow =
            !scrollRoot ||
            scrollRoot === document.body ||
            scrollRoot === document.documentElement;
        const target = usingWindow ? window : scrollRoot;
        let rafId = 0;
        let lastStuck = false;
        const read = () => {
            rafId = 0;
            const top = usingWindow
                ? window.scrollY || document.documentElement.scrollTop || 0
                : scrollRoot.scrollTop;
            const next = top > 4;
            if (next !== lastStuck) {
                lastStuck = next;
                setTabsStuck(next);
            }
        };
        const onScroll = () => {
            if (rafId) return;
            rafId = requestAnimationFrame(read);
        };
        read();
        target.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            target.removeEventListener('scroll', onScroll);
            if (rafId) cancelAnimationFrame(rafId);
        };
        // Depend on project?.id so this effect runs AFTER the
        // loading spinner/early-return path resolves and the
        // sticky bar actually exists in the DOM with `tabsBarRef`
        // attached. With an empty dep array the effect would fire
        // once during the <Spinner /> render, find no ref, and
        // bail out for the rest of the page's lifetime — leaving
        // the bar stuck at "rest" size no matter how far the user
        // scrolled. Re-running on project change is cheap (one
        // event listener) and also correctly re-binds when the
        // user navigates between projects without unmounting the
        // route.
    }, [project?.id]);
    // Approximate measured heights for each variant. Hard-coded
    // because the wrapper height = padding + button height + 1px
    // border, all of which are driven by tailwind tokens we set
    // ourselves — no need to measure at runtime. PhasesPlan reads
    // this via `var(--project-tabs-h)` on its sticky filter row.
    const tabsBarHeightCss = tabsStuck ? '30px' : '62px';
    useEffect(() => {
        const params = new URLSearchParams(location.search);
        const pulse = params.get('pulse');
        if (!pulse) return;
        const m = /^#task-([^?#/]+)$/.exec(location.hash || '');
        if (!m) return;
        const taskId = m[1];
        // Use the timestamp from the URL so two clicks 1ms apart still
        // produce different nonces. Falls back to Date.now() if the
        // caller forgot to stamp one.
        const nonce = Number.parseInt(pulse, 10) || Date.now();
        setPulseTask({ taskId, nonce });
        markDeepLinkHandled(location.pathname, location.hash);

        // One-shot param — strip it so a reload doesn't replay the
        // pulse / spotlight / forced scroll sequence.
        params.delete('pulse');
        const qs = params.toString();
        navigate(
            {
                pathname: location.pathname,
                hash: location.hash,
                search: qs ? `?${qs}` : '',
            },
            { replace: true },
        );
    }, [location.search, location.hash, location.pathname, navigate]);

    useEffect(() => {
        const hash = location.hash || '';
        if (hash) {
            if (/^#task-/.test(hash) || /^#activity-/.test(hash) || hash === '#plan') {
                setActiveTab('plan');
            } else if (hash === '#sprints') {
                setActiveTab('sprints');
            } else if (/^#note-/.test(hash) || hash === '#notes') {
                setActiveTab('notes');
            } else if (/^#file-/.test(hash) || hash === '#files') {
                setActiveTab('files');
            } else if (hash === '#chat' && isParticipant) {
                setActiveTab('chat');
            }
            return;
        }
        // Also honour `?tab=` query params — the Activities feed deep-
        // links to /projects/:id?tab=sprints&sprint=<id> so admins can
        // jump from an audit row straight into the right sub-panel.
        const params = new URLSearchParams(location.search);
        const want = params.get('tab');
        if (
            want === 'sprints' ||
            want === 'plan' ||
            want === 'notes' ||
            want === 'files'
        ) {
            setActiveTab(want);
        } else if (want === 'chat' && isParticipant) {
            setActiveTab('chat');
        }
    }, [location.hash, location.search, isParticipant]);

    const load = async () => {
        try {
            const [projRes, userRes] = await Promise.all([
                api.get(`/projects/${id}`),
                api.get('/users'),
            ]);
            setProject(projRes.data.project);
            setUsers(userRes.data.users);
        } catch {
            toast.error('Failed to load project');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    const onUpdateProject = async (values) => {
        setSubmittingProject(true);
        try {
            await api.patch(`/projects/${id}`, values);
            toast.success('Project updated');
            setEditDialogOpen(false);
            load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Update failed');
        } finally {
            setSubmittingProject(false);
        }
    };

    const [deleteOpen, setDeleteOpen] = useState(false);
    // Actual delete — runs only after the checkbox-gated confirm. The
    // project is soft-deleted (data/time preserved, restorable from the
    // Activity log) and the backend records who deleted it.
    const performDeleteProject = async () => {
        if (!project) return;
        try {
            await api.delete(`/projects/${id}`);
            toast.success('Project deleted');
            navigate('/projects');
        } catch {
            toast.error('Could not delete project');
        }
    };

    const { find: findProjectPriority } = useProjectPriorities();
    const { find: findProjectStatus } = useProjectStatuses();
    const summary = useMemo(() => {
        if (!project) return null;
        // Prefer the admin-managed label/color (StatusOption). Falls
        // back to the static PROJECT_STATUS_MAP via findProjectStatus
        // if the row was hidden on the server but historical projects
        // still carry the key.
        const status =
            findProjectStatus(project.status) ||
            PROJECT_STATUS_MAP[project.status] ||
            PROJECT_STATUS_MAP.TODO;
        const priority =
            findProjectPriority(project.priority) ||
            PROJECT_PRIORITY_MAP[project.priority] ||
            PROJECT_PRIORITY_MAP.MEDIUM;
        const totalTasks = project.tasks?.length ?? 0;
        const doneTasks =
            project.tasks?.filter((t) => t.status === 'DONE').length ?? 0;
        const taskPct = taskProgress(project);
        const tPct = timeProgress(project.startDate, project.endDate);
        // Anchor the countdown to the project's start date so a project
        // that hasn't started yet shows the full duration as remaining
        // rather than something like "153 left of 90".
        const remaining = daysRemainingFromStart(
            project.startDate,
            project.endDate,
        );
        return { status, priority, totalTasks, doneTasks, taskPct, tPct, remaining };
    }, [project, findProjectPriority, findProjectStatus]);

    if (loading) {
        return (
            <>
                <TopBar title="Project" />
                <main className="flex-1 p-6 text-sm text-muted-foreground">
                    Loading...
                </main>
            </>
        );
    }

    if (!project) {
        return (
            <>
                <TopBar title="Project" />
                <main className="flex-1 p-6">
                    <p className="text-muted-foreground">Project not found.</p>
                    <Button asChild variant="link" className="mt-2 px-0">
                        <Link to="/projects">Back to projects</Link>
                    </Button>
                </main>
            </>
        );
    }

    const handleExport = async () => {
        if (!project) return;
        setExporting(true);
        try {
            await downloadFromApi(`/exports/projects/${project.id}/xlsx`, {
                filenameFallback: `${project.name || 'project'}.xlsx`,
            });
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not export project',
            );
        } finally {
            setExporting(false);
        }
    };

    const isCompleted = project?.status === 'DONE';

    const handleToggleComplete = async () => {
        if (!project) return;
        const nextStatus = isCompleted ? 'IN_PROGRESS' : 'DONE';
        const verb = isCompleted ? 'Reopen' : 'Mark complete';
        if (!window.confirm(`${verb} "${project.name}"?`)) return;
        setTogglingComplete(true);
        try {
            await api.patch(`/projects/${project.id}`, { status: nextStatus });
            toast.success(isCompleted ? 'Project reopened' : 'Project completed');
            load();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not update project status',
            );
        } finally {
            setTogglingComplete(false);
        }
    };

    // Inline title content rendered inside TopBar's <h1>: project name +
    // status pill. Kept inline (no <h1>) so we don't nest headings.
    const titleNode = (
        <span className="inline-flex items-center gap-3">
            {project.code && (
                <span
                    className="rounded-md border border-border bg-muted/60 px-2 py-0.5 font-mono text-xs uppercase tracking-wide text-muted-foreground"
                    title="Project code"
                >
                    {project.code}
                </span>
            )}
            <span>{project.name}</span>
            {project.isPersonal && (
                <span
                    className="inline-flex items-center rounded-full border border-purple-300 bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700 dark:border-purple-500/40 dark:bg-purple-500/15 dark:text-purple-200"
                    title="Personal project — visible only to you"
                >
                    Personal
                </span>
            )}
            {summary?.status && (
                <span
                    className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                        isCompleted
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                            : 'border-border bg-muted text-muted-foreground',
                    )}
                    title={`Status: ${summary.status.label}`}
                >
                    {isCompleted ? (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                        <Clock className="h-3.5 w-3.5" />
                    )}
                    {summary.status.label}
                </span>
            )}
            {/* Lifecycle pill — only show when it diverges from the
                default "ACTIVE" so the topbar stays uncluttered for
                the common case. Maintenance / planning / archived
                projects DO surface a pill so it's instantly obvious
                why the "Close project" affordance is missing. */}
            {project.projectType?.hideMarkComplete && (
                <span
                    className={cn(
                        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                        'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200',
                    )}
                    title={`Project type: ${project.projectType?.name || 'Ongoing'}`}
                >
                    <Wrench className="h-3.5 w-3.5" />
                    {project.projectType?.name || 'Ongoing'}
                </span>
            )}
        </span>
    );

    // Maintenance projects never "complete" — they're ongoing by
    // definition. Hide the Mark-complete / Reopen affordance for them
    // so admins don't accidentally close one out. Admins who really
    // need to close can switch the lifecycle first via the Edit dialog.
    const isMaintenance = Boolean(project?.projectType?.hideMarkComplete);

    const actions = (
            <div className="flex items-center gap-1.5 sm:gap-2">
                {/* Share is available to anyone who can see the project —
                    it only ever sends a link, never changes anything. */}
                <Button
                    variant="outline"
                    size="sm"
                    className="h-9 w-9 px-0 sm:h-9 sm:w-auto sm:gap-2 sm:px-3"
                    onClick={() => setShareOpen(true)}
                    title="Share project"
                    aria-label="Share project"
                >
                    <Share2 className="h-4 w-4" />
                    <span className="hidden sm:inline">Share</span>
                </Button>
                {canCloseProject && !isMaintenance && (
                    <Button
                        variant={isCompleted ? 'outline' : 'default'}
                        size="sm"
                        className={cn(
                            'h-9 w-9 px-0 sm:h-9 sm:w-auto sm:gap-2 sm:px-3',
                            !isCompleted &&
                            'bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-500',
                        )}
                        onClick={handleToggleComplete}
                        disabled={togglingComplete}
                        title={
                            isCompleted ? 'Reopen project' : 'Mark complete'
                        }
                        aria-label={
                            isCompleted ? 'Reopen project' : 'Mark complete'
                        }
                    >
                        {isCompleted ? (
                            <RotateCcw className="h-4 w-4" />
                        ) : (
                            <Check className="h-4 w-4" />
                        )}
                        <span className="hidden sm:inline">
                            {togglingComplete
                                ? 'Saving…'
                                : isCompleted
                                    ? 'Reopen project'
                                    : 'Mark complete'}
                        </span>
                    </Button>
                )}
                {canExportProject && (
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-9 w-9 px-0 sm:h-9 sm:w-auto sm:gap-2 sm:px-3"
                        onClick={handleExport}
                        disabled={exporting}
                        title="Export to Excel"
                        aria-label="Export to Excel"
                    >
                        <Download className="h-4 w-4" />
                        <span className="hidden sm:inline">
                            {exporting ? 'Exporting…' : 'Export to Excel'}
                        </span>
                    </Button>
                )}
                {canOpenProjectEdit && (
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-9 w-9 px-0 sm:h-9 sm:w-auto sm:gap-2 sm:px-3"
                        onClick={() => setEditDialogOpen(true)}
                        title={
                            canManageProject
                                ? 'Edit project'
                                : 'Edit billing details'
                        }
                        aria-label={
                            canManageProject
                                ? 'Edit project'
                                : 'Edit billing details'
                        }
                    >
                        <Pencil className="h-4 w-4" />
                        <span className="hidden sm:inline">
                            {canManageProject
                                ? 'Edit project'
                                : 'Edit billing'}
                        </span>
                    </Button>
                )}
            </div>
        );

    return (
        <>
            <TopBar title={titleNode} actions={actions} />
            {/* `<main>` deliberately has NO top padding so the sticky tab
                bar (rendered deeper in the tree) can pin flush against
                the TopBar with zero gap of `bg-muted/20` showing through.
                The natural top padding for the "Back to projects" button
                and the completed-project banner is restored via the
                `pt-3 sm:pt-6` wrapper below. */}
            <main className="flex-1 overflow-auto bg-muted/20 px-3 pb-3 sm:px-6 sm:pb-6">
                <div className="pt-3 sm:pt-6">
                {isCompleted && (
                    <div className="mb-4 flex items-center gap-3 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-100">
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
                        <span className="font-medium">
                            This project is complete.
                        </span>
                        {project.closedAt && (
                            <span className="text-emerald-800/80 dark:text-emerald-200/80">
                                Closed on {formatDate(project.closedAt)}.
                            </span>
                        )}
                        {canCloseProject && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="ml-auto gap-2 text-emerald-900 hover:bg-emerald-100 dark:text-emerald-100 dark:hover:bg-emerald-900/40"
                                onClick={handleToggleComplete}
                                disabled={togglingComplete}
                            >
                                <RotateCcw className="h-4 w-4" />
                                Reopen
                            </Button>
                        )}
                    </div>
                )}
                <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="mb-4 gap-1 px-2"
                >
                    <Link to="/projects">
                        <ArrowLeft className="h-4 w-4" />
                        Back to projects
                    </Link>
                </Button>
                </div>

                <div
                    className={cn(
                        'grid gap-6',
                        detailsCollapsed
                            ? 'lg:grid-cols-[44px_1fr]'
                            : 'lg:grid-cols-[340px_1fr]',
                    )}
                >
                    {detailsCollapsed ? (
                        <aside className="hidden lg:order-1 lg:block">
                            <button
                                type="button"
                                onClick={() => setDetailsCollapsed(false)}
                                className="sticky top-0 flex h-32 w-11 flex-col items-center justify-center gap-2 rounded-lg border bg-card text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
                                title="Show project details"
                                aria-label="Show project details"
                            >
                                <ChevronRight className="h-4 w-4" />
                                <span
                                    className="text-[10px] uppercase tracking-wide"
                                    style={{ writingMode: 'vertical-rl' }}
                                >
                                    Details
                                </span>
                            </button>
                        </aside>
                    ) : (
                        <aside className="order-2 space-y-4 lg:order-1">
                            <div className="flex justify-end">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                                    onClick={() => setDetailsCollapsed(true)}
                                    title="Hide project details panel"
                                >
                                    <ChevronLeft className="h-3.5 w-3.5" />
                                    Hide details
                                </Button>
                            </div>
                            <CollapsibleCard
                                title="Summary"
                                icon={TrendingUp}
                                collapsed={summaryCollapsed}
                                onToggle={() => setSummaryCollapsed((v) => !v)}
                            >
                                <SummaryRow label="Status">
                                    <Badge variant={summary.status.badge}>
                                        {summary.status.label}
                                    </Badge>
                                </SummaryRow>
                                {/* Priority is part of the shared-
                                        project workflow; for a personal
                                        organiser it just adds noise. */}
                                {!isPersonalProject && (
                                    <SummaryRow label="Priority">
                                        <Badge
                                            variant={summary.priority.badge}
                                        >
                                            {summary.priority.label}
                                        </Badge>
                                    </SummaryRow>
                                )}

                                <TimeProgressBlock
                                    pct={summary.tPct}
                                    remaining={summary.remaining}
                                    startDate={project.startDate}
                                    endDate={project.endDate}
                                    taskPct={summary.taskPct}
                                />

                                <div>
                                    <div className="mb-1 flex items-center justify-between text-xs">
                                        <span className="uppercase text-muted-foreground">
                                            Task progress
                                        </span>
                                        <span className="text-muted-foreground">
                                            {summary.taskPct}% · {summary.doneTasks}/
                                            {summary.totalTasks} tasks
                                        </span>
                                    </div>
                                    <Progress value={summary.taskPct} />
                                </div>

                                <Separator />

                                <div className="space-y-3 text-sm">
                                    {/* Project-level Phase is only
                                            meaningful for shared projects
                                            that follow the predefined
                                            phase workflow. */}
                                    {!isPersonalProject && (
                                        <DetailRow
                                            icon={Flag}
                                            label="Phase"
                                            value={project.phase}
                                        />
                                    )}
                                    <DetailRow
                                        icon={Tag}
                                        label="Labels"
                                        value={(() => {
                                            const tags =
                                                parseProjectLabels(project);
                                            if (tags.length === 0)
                                                return null;
                                            return (
                                                <div className="flex flex-wrap items-center gap-1">
                                                    {tags.map((tag, i) => (
                                                        <span
                                                            key={`${tag.text}-${i}`}
                                                            className={cn(
                                                                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1',
                                                                labelColorClass(
                                                                    tag.color,
                                                                ),
                                                            )}
                                                        >
                                                            {tag.text}
                                                        </span>
                                                    ))}
                                                </div>
                                            );
                                        })()}
                                    />
                                    <DetailRow
                                        icon={Briefcase}
                                        label="Client"
                                        value={project.client}
                                    />
                                    <DetailRow
                                        icon={Globe}
                                        label="Country"
                                        value={project.country}
                                    />
                                    {project.isPersonal ? (
                                        project.linkedProject && (
                                            <DetailRow
                                                icon={FolderKanban}
                                                label="Linked project"
                                                value={
                                                    project.linkedProject.code
                                                        ? `${project.linkedProject.code} · ${project.linkedProject.name}`
                                                        : project.linkedProject.name
                                                }
                                            />
                                        )
                                    ) : (
                                        <DetailRow
                                            icon={Hash}
                                            label="CRM ID"
                                            value={project.crmId}
                                        />
                                    )}
                                    {!project.isPersonal && (
                                        <DetailRow
                                            icon={FolderKanban}
                                            label="Project type"
                                            value={
                                                project.projectType?.name
                                            }
                                        />
                                    )}
                                    {project.product && (
                                        <DetailRow
                                            icon={Package}
                                            label="Product"
                                            value={
                                                project.product.code
                                                    ? `${project.product.code} · ${project.product.name}`
                                                    : project.product.name
                                            }
                                        />
                                    )}
                                    <DetailRow
                                        icon={CalendarDays}
                                        label="Start"
                                        value={formatDate(project.startDate)}
                                    />
                                    <DetailRow
                                        icon={CalendarDays}
                                        label="End"
                                        value={formatDate(project.endDate)}
                                    />
                                </div>

                                <Separator />

                                <div className="space-y-3 text-sm">
                                    <PersonRow
                                        icon={UserIcon}
                                        label="Owner"
                                        person={project.owner}
                                    />
                                    {/* Reporter is a shared-project
                                            concept — there's nobody to
                                            report to in a personal
                                            organiser, so hide the row. */}
                                    {!isPersonalProject && (
                                        <PersonRow
                                            icon={UserIcon}
                                            label="Reporter"
                                            person={project.reporter}
                                        />
                                    )}
                                </div>
                            </CollapsibleCard>

                            <ParticipantsPanel
                                project={project}
                                onChanged={load}
                                collapsed={participantsCollapsed}
                                onToggleCollapsed={() =>
                                    setParticipantsCollapsed((v) => !v)
                                }
                            />

                            {/* Teams and external contacts are
                                shared-project tooling — they don't
                                apply to a personal organiser. */}
                            {!isPersonalProject && (
                                <ProjectTeamsPanel
                                    project={project}
                                    onChanged={load}
                                    collapsed={teamsCollapsed}
                                    onToggleCollapsed={() =>
                                        setTeamsCollapsed((v) => !v)
                                    }
                                />
                            )}

                            {!isPersonalProject && (
                                <ProjectContactsPanel
                                    project={project}
                                    collapsed={contactsCollapsed}
                                    onToggleCollapsed={() =>
                                        setContactsCollapsed((v) => !v)
                                    }
                                />
                            )}

                            <CollapsibleCard
                                title="Timeline"
                                icon={Clock}
                                collapsed={timelineCollapsed}
                                onToggle={() => setTimelineCollapsed((v) => !v)}
                                contentClassName="space-y-3 text-sm"
                            >
                                <DetailRow
                                    icon={Clock}
                                    label="Created"
                                    value={formatDateTime(project.createdAt)}
                                />
                                <DetailRow
                                    icon={Clock}
                                    label="Status changed"
                                    value={formatDateTime(project.statusChangedAt)}
                                />
                                <DetailRow
                                    icon={Clock}
                                    label="Last updated"
                                    value={formatDateTime(
                                        project.statusUpdatedAt ||
                                        project.updatedAt,
                                    )}
                                />
                                <DetailRow
                                    icon={Clock}
                                    label="Closed/archived"
                                    value={formatDateTime(project.closedAt)}
                                />
                                <LatestActivityRow
                                    activity={pickLatestActivity(project)}
                                    onJump={() => setActiveTab('plan')}
                                />
                            </CollapsibleCard>

                            {project.description && (
                                <CollapsibleCard
                                    title="Description"
                                    icon={FileText}
                                    collapsed={descriptionCollapsed}
                                    onToggle={() =>
                                        setDescriptionCollapsed((v) => !v)
                                    }
                                    contentClassName="whitespace-pre-wrap text-sm text-muted-foreground"
                                >
                                    {project.description}
                                </CollapsibleCard>
                            )}

                            {isAdmin && !isPersonalProject && (
                                <BillingCard
                                    project={project}
                                    collapsed={billingCollapsed}
                                    onToggle={() =>
                                        setBillingCollapsed((v) => !v)
                                    }
                                    onChanged={(updated) =>
                                        setProject((prev) =>
                                            prev ? { ...prev, ...updated } : prev,
                                        )
                                    }
                                />
                            )}

                            <TimeTrackingCard
                                project={project}
                                collapsed={timeCollapsed}
                                onToggle={() => setTimeCollapsed((v) => !v)}
                            />

                            {canManageProject && (
                                <>
                                    <Button
                                        variant="outline"
                                        className="w-full gap-2 text-destructive hover:text-destructive"
                                        onClick={() => setDeleteOpen(true)}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                        Delete project
                                    </Button>
                                    <ConfirmDeleteDialog
                                        open={deleteOpen}
                                        onOpenChange={setDeleteOpen}
                                        title={`Delete "${project.name}"?`}
                                        description="The project and all its tasks are removed from view. Logged time and history are kept, and an admin can restore it from the Activity log. This is recorded against your account."
                                        ackLabel="I understand — delete this project."
                                        confirmLabel="Delete project"
                                        onConfirm={performDeleteProject}
                                    />
                                </>
                            )}
                        </aside>
                    )}

                    {/* `self-start` is the secret sauce that makes
                        the sticky tab bar inside this section
                        actually engage. Without it the section
                        stretches vertically to match the height of
                        the project-summary aside on the left (CSS
                        grid items default to `align-self: stretch`).
                        A stretched grid item still scrolls, but its
                        sticky children get pinned to the BOTTOM of
                        the stretched track, not the top of <main>'s
                        viewport — so the bar appears static. With
                        `self-start` the section's height equals its
                        natural content, and `position: sticky` ticks
                        on as expected. */}
                    <section
                        className="order-1 space-y-4 self-start lg:order-2"
                        style={{ '--project-tabs-h': tabsBarHeightCss }}
                    >
                        {/* Sticky tab bar.
                            The wrapper sticks to the top of <main>'s
                            scroll viewport so the user always knows
                            which tab they're on while paging through a
                            long phases plan. `-mx-3 sm:-mx-6` cancels
                            the <main> horizontal padding so the bar
                            bleeds edge-to-edge; the matching
                            `px-3 sm:px-6` restores the inset for its
                            content. z-30 sits above PhasesPlan's own
                            sticky filter row (z-20) and the per-row
                            hover shadows.

                            Background is fully opaque (`bg-background`)
                            so the muted page background never bleeds
                            through while scrolling — this used to be
                            `bg-background/95 backdrop-blur ...` and the
                            translucency was perceived as a visual gap
                            between the TopBar and the tabs. */}
                        {/* Sticky tab bar with shrink-on-stick behaviour.
                            At the top of the page the bar is at its
                            "comfortable" size (taller buttons, 13px
                            label, slightly larger icons + gaps). As
                            soon as the user scrolls past the bar it
                            sticks to the top of the <main> viewport
                            and smoothly shrinks to the compact variant
                            (py-1, 12px label, h-3 icons) so it takes
                            less vertical real estate and the user can
                            see more of the content beneath it. The
                            swap is driven by `tabsStuck`, toggled by
                            an IntersectionObserver on the 1px sentinel
                            rendered directly above the sticky div.
                            
                            The sentinel sits in document flow at
                            height 0 — when it scrolls out of view
                            above the viewport (well, the <main>
                            container, which is the scroll root) the
                            sticky div has just started "sticking",
                            so we flip the state. Walking up parents
                            to find the scroll container keeps this
                            self-contained — no need to thread a ref
                            from the page wrapper. */}
                        <div
                            ref={tabsBarRef}
                            className={cn(
                                'sticky top-0 z-30 -mx-3 border-b bg-background px-3 shadow-sm transition-[padding] duration-200 ease-out sm:-mx-6 sm:px-6',
                                tabsStuck ? 'py-0.5' : 'py-3',
                            )}
                        >
                            <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 [scrollbar-width:thin]">
                                {tabs.map((t) => {
                                    const TabIcon = t.icon;
                                    return (
                                        <button
                                            key={t.id}
                                            type="button"
                                            onClick={() => setActiveTab(t.id)}
                                            className={cn(
                                                'inline-flex shrink-0 items-center whitespace-nowrap border-b-2 font-medium transition-[padding,gap,font-size,color,border-color] duration-200 ease-out',
                                                tabsStuck
                                                    ? 'gap-1.5 px-2.5 py-1 text-[12px]'
                                                    : 'gap-1.5 px-2.5 py-2 text-[13px] sm:gap-2.5 sm:px-4 sm:py-2.5 sm:text-[15px]',
                                                activeTab === t.id
                                                    ? 'border-primary text-foreground'
                                                    : 'border-transparent text-muted-foreground hover:text-foreground',
                                            )}
                                        >
                                            {TabIcon && (
                                                <TabIcon
                                                    className={cn(
                                                        'transition-[width,height] duration-200 ease-out',
                                                        tabsStuck
                                                            ? 'h-3 w-3'
                                                            : 'h-4 w-4',
                                                    )}
                                                />
                                            )}
                                            {t.label}
                                            {t.id === 'notes' && project.noteCount ? (
                                                <span className="ml-1 text-[10px] text-muted-foreground">
                                                    {project.noteCount}
                                                </span>
                                            ) : null}
                                            {t.id === 'files' && project.fileCount ? (
                                                <span className="ml-1 text-[10px] text-muted-foreground">
                                                    {project.fileCount}
                                                </span>
                                            ) : null}
                                            {t.id === 'change-requests' && project.crCount ? (
                                                <span className="ml-1 text-[10px] text-muted-foreground">
                                                    {project.crCount}
                                                </span>
                                            ) : null}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {activeTab === 'plan' && (
                            <PhasesPlan
                                projectId={project.id}
                                projectName={project.name}
                                phases={project.phases || []}
                                tasks={project.tasks || []}
                                activities={project.activities || []}
                                users={users}
                                canManage={canManageTasks}
                                canEditTask={canEditExistingTask}
                                canDeleteTask={canDeleteExistingTask}
                                canManageOwnTasks={canCreateTaskCap}
                                canApprove={canApproveTasks}
                                canCreateSpecific={canCreateSpecificTasks}
                                canManagePhases={
                                    isAdmin || (isPersonalProject && isOwner)
                                }
                                currentUserId={currentUser?.id}
                                pulseTask={pulseTask}
                                onChanged={load}
                            />
                        )}
                        {activeTab === 'sprints' && (
                            <SprintsPanel
                                projectId={project.id}
                                projectName={project.name}
                                tasks={project.tasks || []}
                                users={users}
                                onTasksChanged={load}
                            />
                        )}
                        {activeTab === 'estimation' && (
                            <EstimationPlaceholder
                                projectId={project.id}
                                isOngoing={Boolean(
                                    project.projectType?.hideMarkComplete,
                                )}
                                canEdit={canManageTasks}
                            />
                        )}
                        {activeTab === 'change-requests' && (
                            <ChangeRequestsPanel
                                project={project}
                                onChanged={load}
                                currentUser={currentUser}
                            />
                        )}
                        {activeTab === 'notes' && (
                            <NotesPanel
                                projectId={project.id}
                                projectOwnerId={project.ownerId}
                            />
                        )}
                        {activeTab === 'files' && (
                            <FilesPanel
                                projectId={project.id}
                                projectOwnerId={project.ownerId}
                            />
                        )}
                        {activeTab === 'tickets' && (
                            <ProjectTicketsPanel projectId={project.id} />
                        )}
                        {activeTab === 'chat' && (
                            <ProjectChatPanel
                                projectId={project.id}
                                projectName={project.name}
                            />
                        )}
                    </section>
                </div>
            </main>

            <ProjectFormDialog
                open={editDialogOpen}
                onOpenChange={setEditDialogOpen}
                onSubmit={onUpdateProject}
                submitting={submittingProject}
                initialValues={project}
                users={users}
                title={
                    canManageProject ? 'Edit project' : 'Edit billing details'
                }
                description={
                    canManageProject
                        ? 'Update project details.'
                        : 'You can only edit the billing fields on this project.'
                }
                submitLabel="Save changes"
                // Per-user capability overrides. The dialog uses these to
                // decide which sections to show so a billing-cap holder
                // never sees fields they can't actually save.
                canEditBilling={canEditBillingCap}
                canCloseProject={canCloseProjectCap}
            />
            <ShareDialog
                open={shareOpen}
                onOpenChange={setShareOpen}
                item={{
                    kind: 'project',
                    id: project.id,
                    code: project.code,
                    title: project.name,
                }}
            />
        </>
    );
}

// Estimation tab placeholder. Reserves the route + sidebar slot so
// links / deep-links to ?tab=estimation already work in M1. The actual
// fields (effort breakdown, hours, complexity grid, contingency,
// commercial summary, etc.) are designed in M2 — until then we render
// an empty surface with a "coming soon" hint instead of a 404. The
// same component is reused on the CR detail page (M2) via prop swap.
function EstimationPlaceholder({ projectId, isOngoing, canEdit }) {
    return (
        <div className="rounded-lg border border-dashed bg-card p-8 text-center">
            <Calculator className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
            <h3 className="text-base font-semibold">Estimation</h3>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                The estimation surface for this project is being designed.
                It will live here without changing the URL — bookmark
                <code className="mx-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    ?tab=estimation
                </code>
                if you want it as a deep link already.
            </p>
            {isOngoing ? (
                <p className="mx-auto mt-3 max-w-md text-xs text-muted-foreground">
                    Maintenance projects will get a per-cycle estimation
                    view (monthly retainer, hour cap, burn).
                </p>
            ) : null}
            {!canEdit ? (
                <p className="mx-auto mt-3 max-w-md text-[11px] uppercase tracking-wide text-muted-foreground">
                    Read-only — only admins / managers / the project owner
                    will be able to edit estimates.
                </p>
            ) : null}
        </div>
    );
}

// ChangeRequestsPanel — fetches CRs for the project, renders a table
// + create button. The "Open" link sends the user to the full CR
// detail page (M2 route). Capability-gated: only managers / admins /
// the project owner see the New CR button.
//
// Status rendering reuses useProjectStatuses so admin-customized
// labels/colors apply here too. Edit/delete will land in a small
// per-row menu (M2.1) — for M1-of-M2 we keep the table read-mostly
// and route to the detail page for richer interactions.
function ChangeRequestsPanel({ project, onChanged, currentUser }) {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [editing, setEditing] = useState(null);
    const { find: findCrStatus } = useProjectStatuses();

    const isAdmin = currentUser?.role === 'ADMIN';
    const isOwner =
        !!project?.ownerId && currentUser?.id === project.ownerId;
    const canCreate =
        isAdmin ||
        isOwner ||
        hasCapability(currentUser, CAPABILITIES_FRONT.CR_CREATE);
    const canEdit =
        isAdmin ||
        isOwner ||
        hasCapability(currentUser, CAPABILITIES_FRONT.CR_EDIT);
    const canDelete =
        isAdmin ||
        hasCapability(currentUser, CAPABILITIES_FRONT.CR_DELETE);

    const load = async () => {
        if (!project?.id) return;
        setLoading(true);
        setError(null);
        try {
            const { data } = await api.get(
                `/projects/${project.id}/change-requests`,
            );
            setItems(data.changeRequests || []);
        } catch (err) {
            setError(
                err?.response?.data?.error || 'Failed to load change requests',
            );
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project?.id]);

    const submitCreate = async (payload) => {
        setSubmitting(true);
        try {
            await api.post(
                `/projects/${project.id}/change-requests`,
                payload,
            );
            toast.success('Change request created');
            setDialogOpen(false);
            await load();
            // The project's contracted totals + crCount changed —
            // refresh the parent project so the topbar chip + tab
            // badge stay in sync.
            onChanged?.();
        } catch (err) {
            toast.error(
                err?.response?.data?.error || 'Failed to create change request',
            );
        } finally {
            setSubmitting(false);
        }
    };

    const submitEdit = async (payload) => {
        if (!editing?.id) return;
        setSubmitting(true);
        try {
            await api.patch(`/change-requests/${editing.id}`, payload);
            toast.success('Change request updated');
            setDialogOpen(false);
            setEditing(null);
            await load();
            onChanged?.();
        } catch (err) {
            toast.error(
                err?.response?.data?.error || 'Failed to update change request',
            );
        } finally {
            setSubmitting(false);
        }
    };

    const remove = async (cr) => {
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
            await load();
            onChanged?.();
        } catch (err) {
            toast.error(
                err?.response?.data?.error || 'Failed to delete change request',
            );
        }
    };

    const internalCurrency = project?.internalCurrency || 'EUR';
    const clientCurrency = project?.clientCurrency || 'EUR';

    const totalInternal = project?.totalContractedInternal ?? 0;
    const totalClient = project?.totalContractedClient ?? 0;
    const baseInternal = Number(project?.internalAmount) || 0;
    const baseClient = Number(project?.clientAmount) || 0;
    const crInternal = totalInternal - baseInternal;
    const crClient = totalClient - baseClient;

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                    <div>
                        <CardTitle className="text-base">
                            Contracted value
                        </CardTitle>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Project total = original SOW + sum of all
                            change requests.
                        </p>
                    </div>
                    {canCreate ? (
                        <Button
                            size="sm"
                            className="gap-1.5"
                            onClick={() => {
                                setEditing(null);
                                setDialogOpen(true);
                            }}
                        >
                            <Plus className="h-4 w-4" />
                            New CR
                        </Button>
                    ) : null}
                </CardHeader>
                <CardContent>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <ContractedSummary
                            label="Internal"
                            currency={internalCurrency}
                            base={baseInternal}
                            crs={crInternal}
                            total={totalInternal}
                        />
                        <ContractedSummary
                            label="Client"
                            currency={clientCurrency}
                            base={baseClient}
                            crs={crClient}
                            total={totalClient}
                        />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">
                        Change requests
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <p className="text-sm text-muted-foreground">
                            Loading…
                        </p>
                    ) : error ? (
                        <p className="text-sm text-destructive">{error}</p>
                    ) : items.length === 0 ? (
                        <div className="rounded-md border border-dashed bg-muted/30 p-6 text-center">
                            <GitPullRequest className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
                            <p className="text-sm text-muted-foreground">
                                No change requests yet.
                                {canCreate
                                    ? ' Click "New CR" to add the first one.'
                                    : ''}
                            </p>
                        </div>
                    ) : (
                        <div className="-mx-3 overflow-x-auto">
                            <table className="w-full min-w-[640px] text-sm">
                                <thead className="text-xs uppercase text-muted-foreground">
                                    <tr className="border-b">
                                        <th className="px-3 py-2 text-left font-medium">
                                            Code
                                        </th>
                                        <th className="px-3 py-2 text-left font-medium">
                                            Title
                                        </th>
                                        <th className="px-3 py-2 text-left font-medium">
                                            Status
                                        </th>
                                        <th className="px-3 py-2 text-right font-medium">
                                            Client
                                        </th>
                                        <th className="px-3 py-2 text-right font-medium">
                                            Internal
                                        </th>
                                        <th className="px-3 py-2 text-right font-medium">
                                            Hours
                                        </th>
                                        <th className="px-3 py-2 text-right font-medium" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {items.map((cr) => {
                                        // find() resolves the admin-managed
                                        // status (label/color/badge) and
                                        // falls back for hidden/custom keys
                                        // so a CR badge never blanks out.
                                        const statusMeta = findCrStatus(
                                            cr.status,
                                        );
                                        return (
                                            <tr
                                                key={cr.id}
                                                className="border-b last:border-0 hover:bg-muted/40"
                                            >
                                                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                                                    {cr.code || '—'}
                                                </td>
                                                <td className="px-3 py-2">
                                                    <Link
                                                        to={`/projects/${project.id}/cr/${cr.id}`}
                                                        className="font-medium text-foreground hover:underline"
                                                    >
                                                        {cr.title}
                                                    </Link>
                                                </td>
                                                <td className="px-3 py-2">
                                                    {statusMeta ? (
                                                        <Badge
                                                            variant={
                                                                statusMeta.badge ||
                                                                'secondary'
                                                            }
                                                        >
                                                            {statusMeta.label}
                                                        </Badge>
                                                    ) : (
                                                        <span className="text-xs text-muted-foreground">
                                                            {cr.status}
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-3 py-2 text-right tabular-nums">
                                                    {formatMoney(
                                                        cr.clientAmount,
                                                        clientCurrency,
                                                    )}
                                                </td>
                                                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                                                    {formatMoney(
                                                        cr.internalAmount,
                                                        internalCurrency,
                                                    )}
                                                </td>
                                                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                                                    {cr.estimatedHours != null
                                                        ? cr.estimatedHours
                                                        : '—'}
                                                </td>
                                                <td className="px-3 py-2 text-right">
                                                    <div className="flex justify-end gap-1">
                                                        {canEdit && (
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-7 w-7"
                                                                onClick={() => {
                                                                    setEditing(cr);
                                                                    setDialogOpen(true);
                                                                }}
                                                                title="Edit"
                                                            >
                                                                <Pencil className="h-3.5 w-3.5" />
                                                            </Button>
                                                        )}
                                                        {canDelete && (
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-7 w-7 text-destructive hover:text-destructive"
                                                                onClick={() => remove(cr)}
                                                                title="Delete"
                                                            >
                                                                <Trash2 className="h-3.5 w-3.5" />
                                                            </Button>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </CardContent>
            </Card>

            <ChangeRequestFormDialog
                open={dialogOpen}
                onOpenChange={(open) => {
                    setDialogOpen(open);
                    if (!open) setEditing(null);
                }}
                onSubmit={editing ? submitEdit : submitCreate}
                submitting={submitting}
                initialValues={editing || undefined}
                internalCurrency={internalCurrency}
                clientCurrency={clientCurrency}
                title={editing ? 'Edit change request' : 'New change request'}
                submitLabel={editing ? 'Save changes' : 'Create'}
            />
        </div>
    );
}

function ContractedSummary({ label, currency, base, crs, total }) {
    return (
        <div className="rounded-md border bg-muted/30 p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {label}
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
                {formatMoney(total, currency)}
            </div>
            <div className="mt-1 grid grid-cols-2 gap-2 text-xs text-muted-foreground tabular-nums">
                <div>
                    <div className="uppercase">Original</div>
                    <div>{formatMoney(base, currency)}</div>
                </div>
                <div>
                    <div className="uppercase">+ CRs</div>
                    <div>{formatMoney(crs, currency)}</div>
                </div>
            </div>
        </div>
    );
}

function TimeProgressBlock({ pct, remaining, startDate, endDate, taskPct }) {
    if (pct == null) {
        return (
            <div>
                <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="uppercase text-muted-foreground">
                        Time progress
                    </span>
                    <span className="text-muted-foreground">
                        Set start &amp; end dates
                    </span>
                </div>
                <Progress value={0} indicatorClassName="bg-muted-foreground/40" />
            </div>
        );
    }
    // The colour scale flips to green once tasks are 100 % complete,
    // even if we're past the deadline — finished work shouldn't read
    // as a red warning.
    const indicator = timeProgressColorClass(pct, taskPct);
    const text = timeProgressTextClass(pct, taskPct);
    const totalDays = durationInDays(startDate, endDate);
    const remainingLabel = timeRemainingLabel(remaining, totalDays);
    const tasksDone = typeof taskPct === 'number' && taskPct >= 100;

    return (
        <div>
            <div className="mb-1 flex items-center justify-between text-xs">
                <span className="flex items-center gap-1 uppercase text-muted-foreground">
                    <TrendingUp className="h-3 w-3" /> Time progress
                </span>
                <span className={cn('font-medium', text)}>
                    {pct}%
                </span>
            </div>
            <Progress value={pct} indicatorClassName={indicator} />
            {remainingLabel && (
                <div
                    className={cn(
                        'mt-1 text-[11px] font-medium',
                        tasksDone ? 'text-emerald-600' : text,
                    )}
                >
                    {tasksDone
                        ? `Completed · ${remainingLabel}`
                        : remainingLabel}
                </div>
            )}
            {(startDate || endDate) && (
                <div className="mt-1 flex justify-between text-[10px] uppercase text-muted-foreground">
                    <span>{formatDate(startDate)}</span>
                    <span>{formatDate(endDate)}</span>
                </div>
            )}
        </div>
    );
}

function SummaryRow({ label, children }) {
    return (
        <div className="flex items-center justify-between">
            <span className="text-xs uppercase text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

function LatestActivityRow({ activity, onJump }) {
    if (!activity) {
        return (
            <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">Latest activity</span>
                <span className="ml-auto truncate text-right text-muted-foreground">
                    —
                </span>
            </div>
        );
    }
    const meta = activityKindMeta(activity.kind);
    const KindIcon = meta?.icon || Clock;
    const isUpcoming = activity._kind === 'upcoming';
    const dateLabel = activity.scheduledAt
        ? format(new Date(activity.scheduledAt), "MMM d, yyyy 'at' h:mm a")
        : '—';
    return (
        <div className="space-y-1">
            <div className="flex items-center gap-2">
                <KindIcon
                    className={cn(
                        'h-4 w-4 shrink-0',
                        meta?.tone || 'text-muted-foreground',
                    )}
                />
                <span className="text-muted-foreground">
                    {isUpcoming ? 'Next activity' : 'Latest activity'}
                </span>
                <span
                    className={cn(
                        'ml-auto inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                        activity.done
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                            : isUpcoming
                                ? 'bg-sky-500/10 text-sky-700 dark:text-sky-400'
                                : 'bg-muted text-muted-foreground',
                    )}
                >
                    {activity.done ? 'Done' : isUpcoming ? 'Upcoming' : 'Past'}
                </span>
            </div>
            <button
                type="button"
                onClick={onJump}
                className="block w-full rounded-md border bg-card/40 px-2 py-1.5 text-left text-xs hover:bg-card hover:shadow-sm"
                title="Open in plan"
            >
                <div className="font-medium text-foreground line-clamp-1">
                    {activity.title || meta?.label || 'Untitled activity'}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                    {dateLabel}
                </div>
            </button>
        </div>
    );
}

function DetailRow({ icon: Icon, label, value, multiline = false }) {
    // The default layout puts the icon, label and value on a single
    // truncated row (good for short values like dates / IDs). When
    // `multiline` is set, the label sits on its own row and the value
    // wraps underneath — kept for free-text fields that may need to
    // break across lines (notes, etc.).
    if (multiline) {
        return (
            <div className="space-y-0.5">
                <span className="flex items-center gap-2 text-muted-foreground">
                    <Icon className="h-4 w-4 shrink-0" />
                    {label}
                </span>
                <span className="ml-6 line-clamp-2 break-words text-foreground">
                    {value || '—'}
                </span>
            </div>
        );
    }
    // Tooltip the value when it's a plain string so a truncated long
    // value (e.g. a long project type or client name) is still
    // recoverable on hover without breaking the right-aligned layout.
    const titleAttr = typeof value === 'string' ? value : undefined;
    return (
        <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">{label}</span>
            <span
                className="ml-auto min-w-0 truncate text-right"
                title={titleAttr}
            >
                {value || '—'}
            </span>
        </div>
    );
}

function formatMoney(amount, currency) {
    if (amount == null) return '—';
    const n = typeof amount === 'number' ? amount : Number(amount);
    if (!Number.isFinite(n)) return '—';
    return `${n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })} ${currency || 'EUR'}`;
}

// Per-CR breakdown block for the right-rail Billing card.
//
// Layout choice: the project's own pricing (BillingRow above) is the
// visual anchor — full-size, with paid badges. Each CR is listed
// underneath in a denser, smaller-typography row that mirrors the
// same Internal/Client split. The final "Total contracted" line
// closes the block with project + Σ CRs for both sides. This matches
// how the user thinks about the deal: "the project costs X, plus
// these add-ons cost Y each, so the total is X+Y."
//
// CR rows are clickable — they jump straight to the CR detail page.
function CRBreakdownBlock({ project, crs }) {
    if (!crs.length) return null;
    const internalCurrency = project.internalCurrency;
    const clientCurrency = project.clientCurrency;
    // Show internal column only if either the project OR any CR has
    // an internal amount set — keeps the layout clean for client-only
    // engagements (and vice-versa).
    const showInternal =
        project.internalAmount != null ||
        crs.some((cr) => cr.internalAmount != null);
    const showClient =
        project.clientAmount != null ||
        crs.some((cr) => cr.clientAmount != null);
    return (
        <div className="space-y-2 border-t pt-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Change requests ({crs.length})
            </div>
            <ul className="space-y-1.5">
                {crs.map((cr) => (
                    <li key={cr.id}>
                        <Link
                            to={`/projects/${project.id}/cr/${cr.id}`}
                            className="block rounded-md border bg-background/60 px-2 py-1.5 text-xs transition-colors hover:bg-accent/40"
                            title={cr.title}
                        >
                            <div className="flex items-center justify-between gap-2">
                                <span className="flex min-w-0 items-center gap-1.5">
                                    {cr.code ? (
                                        <span className="shrink-0 rounded bg-amber-500/15 px-1 py-px font-mono text-[10px] uppercase text-amber-700 dark:text-amber-300">
                                            {cr.code.split('-CR-').slice(-1)[0]
                                                ? `CR-${cr.code.split('-CR-').slice(-1)[0]}`
                                                : cr.code}
                                        </span>
                                    ) : null}
                                    <span className="truncate font-medium">
                                        {cr.title}
                                    </span>
                                </span>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-3 tabular-nums text-muted-foreground">
                                {showClient ? (
                                    <span className="flex items-center gap-1">
                                        <DollarSign className="h-3 w-3" />
                                        {formatMoney(cr.clientAmount, clientCurrency)}
                                    </span>
                                ) : <span />}
                                {showInternal ? (
                                    <span className="flex items-center gap-1">
                                        <Wallet className="h-3 w-3" />
                                        {formatMoney(cr.internalAmount, internalCurrency)}
                                    </span>
                                ) : null}
                            </div>
                        </Link>
                    </li>
                ))}
            </ul>

            <div className="space-y-1 rounded-md border-2 border-primary/30 bg-primary/5 p-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
                    Total contracted
                </div>
                {showClient ? (
                    <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                            <DollarSign className="h-3.5 w-3.5" />
                            Client
                        </span>
                        <span className="tabular-nums font-semibold">
                            {formatMoney(
                                project.totalContractedClient,
                                clientCurrency,
                            )}
                        </span>
                    </div>
                ) : null}
                {showInternal ? (
                    <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                            <Wallet className="h-3.5 w-3.5" />
                            Internal
                        </span>
                        <span className="tabular-nums font-semibold">
                            {formatMoney(
                                project.totalContractedInternal,
                                internalCurrency,
                            )}
                        </span>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function BillingRow({
    icon: Icon,
    label,
    amount,
    currency,
    paid,
    paidAt,
    onTogglePaid,
    busy,
}) {
    const hasAmount = amount != null && amount !== '';
    return (
        <div className="rounded-md border bg-muted/30 p-2.5">
            <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs uppercase text-muted-foreground">
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                </span>
                {hasAmount &&
                    (paid ? (
                        <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400">
                            Paid
                        </Badge>
                    ) : (
                        <Badge className="bg-amber-500/15 text-amber-700 hover:bg-amber-500/20 dark:text-amber-400">
                            Unpaid
                        </Badge>
                    ))}
            </div>
            <p className="mt-1 text-base font-semibold tabular-nums">
                {formatMoney(amount, currency)}
            </p>
            {hasAmount && paid && paidAt && (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                    Paid {format(new Date(paidAt), "MMM d, yyyy 'at' h:mm a")}
                </p>
            )}
            {hasAmount && (
                <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 h-7 w-full text-xs"
                    disabled={busy}
                    onClick={onTogglePaid}
                >
                    {paid ? 'Mark as unpaid' : 'Mark as paid'}
                </Button>
            )}
        </div>
    );
}

function BillingCard({ project, collapsed, onToggle, onChanged }) {
    const [busy, setBusy] = useState(null);
    const togglePaid = async (which) => {
        const isInternal = which === 'internal';
        const currentlyPaid = isInternal
            ? project.internalPaid
            : project.clientPaid;
        setBusy(which);
        try {
            const { data } = await api.patch(`/projects/${project.id}`, {
                [isInternal ? 'internalPaid' : 'clientPaid']: !currentlyPaid,
            });
            onChanged?.(data.project);
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not update billing',
            );
        } finally {
            setBusy(null);
        }
    };

    const hasAny =
        project.internalAmount != null || project.clientAmount != null;

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
                        <Receipt className="h-4 w-4 text-muted-foreground" />
                        <CardTitle className="text-base">Billing</CardTitle>
                    </button>
                </div>
            </CardHeader>
            {!collapsed && (
                <CardContent className="space-y-2">
                    {hasAny ? (
                        <>
                            <BillingRow
                                icon={Wallet}
                                label="Internal settlement"
                                amount={project.internalAmount}
                                currency={project.internalCurrency}
                                paid={project.internalPaid}
                                paidAt={project.internalPaidAt}
                                onTogglePaid={() => togglePaid('internal')}
                                busy={busy === 'internal'}
                            />
                            <BillingRow
                                icon={DollarSign}
                                label="Client price"
                                amount={project.clientAmount}
                                currency={project.clientCurrency}
                                paid={project.clientPaid}
                                paidAt={project.clientPaidAt}
                                onTogglePaid={() => togglePaid('client')}
                                busy={busy === 'client'}
                            />
                            {project.crCount ? (
                                // CR breakdown: one row per CR, smaller
                                // type so the project's own prices stay
                                // the visual anchor. Each row is a link
                                // to the CR detail page. Below the list
                                // we show the grand-total contracted
                                // value (project + Σ CRs) which is what
                                // the user actually owes / will bill.
                                //
                                // Currency is inherited project-wide
                                // (CRs can't pick their own), so we
                                // render both internal + client amounts
                                // per row when either side has a value.
                                <CRBreakdownBlock
                                    project={project}
                                    crs={project.changeRequests || []}
                                />
                            ) : null}
                            {project.billingNotes && (
                                <p className="rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
                                    {project.billingNotes}
                                </p>
                            )}
                        </>
                    ) : (
                        <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                            No pricing recorded yet. Edit the project to add an
                            internal settlement or client price.
                        </p>
                    )}
                </CardContent>
            )}
        </Card>
    );
}

function PersonRow({ icon: Icon, label, person }) {
    return (
        <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">{label}</span>
            <span className="ml-auto flex items-center gap-2">
                {person ? (
                    <>
                        <Avatar className="h-5 w-5">
                            {person.avatarUrl && (
                                <AvatarImage
                                    src={resolveAssetUrl(person.avatarUrl)}
                                    alt={person.name}
                                />
                            )}
                            <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                                {initials(person.name)}
                            </AvatarFallback>
                        </Avatar>
                        <span className="truncate">{person.name}</span>
                    </>
                ) : (
                    <span className="text-muted-foreground">—</span>
                )}
            </span>
        </div>
    );
}
