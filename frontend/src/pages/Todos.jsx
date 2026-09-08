import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { format, formatDistanceToNowStrict, isToday, isPast } from 'date-fns';
import {
    AlertCircle,
    ArrowUpDown,
    CalendarClock,
    CalendarDays,
    Check,
    CheckCheck,
    CheckSquare,
    ChevronUp,
    ChevronDown,
    Clock,
    ExternalLink,
    Flag,
    FolderKanban,
    GitBranch,
    GripVertical,
    LifeBuoy,
    ListChecks,
    Loader2,
    MessageSquarePlus,
    Pencil,
    Plus,
    Search,
    Trash2,
    User as UserIcon,
    UserCog,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import {
    CAPABILITIES as CAPABILITIES_FRONT,
    hasCapability,
} from '@/lib/capabilities';
import TicketCardShared from '@/components/TicketCardShared';
import Tickets from '@/pages/Tickets';
import { TASK_STATUS_MAP, TASK_STATUSES } from '@/lib/constants';
import { useTaskStatuses } from '@/lib/statuses';
import { cn } from '@/lib/utils';
import { TopBar } from '@/components/TopBar';
import {
    Pagination,
    PageSizeControl,
    usePagination,
} from '@/components/Pagination';
import { PlanActivityList } from '@/components/PlanActivityList';
import TaskQuickViewDialog from '@/components/TaskQuickViewDialog';
import { NoteAttachmentsField } from '@/components/NoteAttachments';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Label } from '@/components/ui/label';
import { useRealtime } from '@/contexts/RealtimeContext';
import { useAuth } from '@/contexts/AuthContext';

const STATUS_TABS = [
    { id: 'open', label: 'Open' },
    { id: 'done', label: 'Done' },
    { id: 'all', label: 'All' },
];

const PRIORITY_META = {
    LOW: {
        label: 'Low',
        className:
            'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-500/10 dark:text-slate-300',
    },
    MEDIUM: {
        label: 'Medium',
        className:
            'bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-500/10 dark:text-sky-300',
    },
    HIGH: {
        label: 'High',
        className:
            'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-500/10 dark:text-rose-300',
    },
};

const TODO_SORT_KEY = 'pm-todo-sort';

const SORT_OPTIONS = [
    { id: 'manual', label: 'Manual order' },
    { id: 'recent', label: 'Recently added' },
    { id: 'priority', label: 'Priority (high first)' },
    { id: 'due', label: 'Due date (soonest first)' },
];

const PRIORITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function readTodoSortMode() {
    try {
        const saved = localStorage.getItem(TODO_SORT_KEY);
        if (SORT_OPTIONS.some((o) => o.id === saved)) return saved;
    } catch {
        /* ignore */
    }
    return 'manual';
}

function comparePriority(a, b) {
    const ra = PRIORITY_RANK[a.priority] ?? 1;
    const rb = PRIORITY_RANK[b.priority] ?? 1;
    return ra - rb;
}

function sortTodoItems(items, mode, { tab, kind }) {
    if (mode === 'manual' || !items.length) return items;

    const list = [...items];

    if (mode === 'recent') {
        return list.sort((a, b) => {
            const pick = (row) => {
                if (tab === 'done' && row.doneAt) {
                    return new Date(row.doneAt).getTime();
                }
                if (kind === 'task') {
                    return new Date(
                        row.updatedAt || row.createdAt,
                    ).getTime();
                }
                return new Date(row.createdAt).getTime();
            };
            return pick(b) - pick(a);
        });
    }

    if (mode === 'priority') {
        return list.sort((a, b) => {
            const p = comparePriority(a, b);
            if (p !== 0) return p;
            const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
            const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
            if (da !== db) return da - db;
            return (
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime()
            );
        });
    }

    if (mode === 'due') {
        return list.sort((a, b) => {
            const da = a.dueDate
                ? new Date(a.dueDate).getTime()
                : Number.POSITIVE_INFINITY;
            const db = b.dueDate
                ? new Date(b.dueDate).getTime()
                : Number.POSITIVE_INFINITY;
            if (da !== db) return da - db;
            const p = comparePriority(a, b);
            if (p !== 0) return p;
            return (
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime()
            );
        });
    }

    return list;
}

function dueLabel(d) {
    if (!d) return null;
    const date = new Date(d);
    if (isToday(date)) return 'Today';
    if (isPast(date)) {
        return `Overdue · ${formatDistanceToNowStrict(date, { addSuffix: true })}`;
    }
    return format(date, 'MMM d');
}

function dueClass(d, done) {
    if (!d || done) return 'text-muted-foreground';
    const date = new Date(d);
    if (isPast(date) && !isToday(date)) return 'text-destructive';
    if (isToday(date)) return 'text-amber-600 dark:text-amber-400';
    return 'text-muted-foreground';
}

function toDateInputValue(d) {
    if (!d) return '';
    const date = new Date(d);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
}

// Page shell: tab switcher across "My activities" (PlanActivity rows
// assigned to the user), "All activities" (every PlanActivity in
// projects the user can see) and "To-do" (the personal + assigned
// task list that has lived on this page from the start).
const PAGE_TABS = [
    {
        id: 'mine',
        label: 'My activities',
        icon: CalendarClock,
        description: 'Meetings, calls and reminders assigned to you.',
    },
    {
        id: 'all',
        label: 'All activities',
        icon: ListChecks,
        description:
            'Every scheduled activity across the projects you can access.',
    },
    {
        id: 'todo',
        label: 'To-do',
        icon: CheckSquare,
        description:
            'Your personal to-do list and project tasks assigned to you.',
    },
    {
        id: 'tickets',
        label: 'My tickets',
        icon: LifeBuoy,
        description: 'Help-desk tickets you took to resolve.',
    },
];

export default function Todos() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    const [pageTab, setPageTab] = useState('todo');
    const activeMeta = PAGE_TABS.find((t) => t.id === pageTab) || PAGE_TABS[2];

    return (
        <>
            <TopBar
                title="My to-do"
                actions={null}
            />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="flex w-full flex-col gap-4">
                    <div className="rounded-lg border bg-card p-1 shadow-sm">
                        <div className="flex flex-wrap gap-1">
                            {PAGE_TABS.map((t) => {
                                const Icon = t.icon;
                                const isActive = t.id === pageTab;
                                return (
                                    <button
                                        key={t.id}
                                        type="button"
                                        onClick={() => setPageTab(t.id)}
                                        className={cn(
                                            'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                                            isActive
                                                ? 'bg-primary/10 text-primary'
                                                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                                        )}
                                    >
                                        <Icon className="h-4 w-4" />
                                        {t.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {activeMeta?.description && (
                        <p className="-mt-2 px-1 text-xs text-muted-foreground">
                            {activeMeta.description}
                        </p>
                    )}

                    {pageTab === 'mine' && (
                        <PlanActivityList
                            scope="mine"
                            currentUserId={user?.id}
                            isAdmin={isAdmin}
                        />
                    )}
                    {pageTab === 'all' && (
                        <PlanActivityList
                            scope="all"
                            currentUserId={user?.id}
                            isAdmin={isAdmin}
                        />
                    )}
                    {pageTab === 'todo' && <TodoListView />}
                    {pageTab === 'tickets' && <MyTicketsView />}
                </div>
            </main>
        </>
    );
}

// "My tickets" — the help-desk tickets assigned to the current resolver.
// Reuses the full Ticketing workspace (same list / grid / board views and
// filters) in `embedded` mode: no TopBar, its own localStorage prefix, and
// tickets open in a modal on THIS page (closing stays put — no redirect to
// /tickets). Scoped to "assigned to me" via baseParams.
const MY_TICKETS_PARAMS = { assigneeId: 'me' };
function MyTicketsView() {
    return (
        <Tickets
            embedded
            baseParams={MY_TICKETS_PARAMS}
            storagePrefix="todos.mytickets"
        />
    );
}

// Personal to-do view (project tasks assigned to me + my own list).
// Hosted inside the main `Todos` page shell, but exported as a
// separate component so the TopBar / outer chrome can be set by the
// shell.
function AssigneeBadge({ person }) {
    if (!person) return null;
    const name = person.name || person.email || 'Unknown';
    return (
        <span
            className="inline-flex max-w-[12rem] items-center gap-1 truncate font-medium text-foreground/80"
            title={`Assignee: ${name}`}
        >
            <UserIcon className="h-3 w-3 shrink-0" />
            {name}
        </span>
    );
}

function TodoListView() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    const isOverseer = isAdmin || user?.role === 'MANAGER';

    const { setTodoAlertCount, refreshCounts } = useRealtime();
    const [todos, setTodos] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState('open');
    const [sortMode, setSortMode] = useState(readTodoSortMode);
    const [query, setQuery] = useState('');
    const [counts, setCounts] = useState({
        open: 0,
        done: 0,
        overdue: 0,
        dueToday: 0,
        todoOpen: 0,
        todoDone: 0,
        taskOpen: 0,
        taskDone: 0,
    });
    const [newTitle, setNewTitle] = useState('');
    const [newProjectId, setNewProjectId] = useState(NO_PROJECT);
    const [creating, setCreating] = useState(false);
    const [editing, setEditing] = useState(null);
    const [projects, setProjects] = useState([]);
    const dragRef = useRef({ from: null });

    // Full task quick-view dialog (task title click). Defaults to the
    // 'logtime' tab — the icons next to the row already give a direct
    // path to the small Note / Reassign / Log-time dialogs, so the
    // big quick-view dialog opening to log-time first matches what
    // people actually do when they click the title (estimate /
    // record work done on the task).
    const [taskDialog, setTaskDialog] = useState({ open: false, task: null, tab: 'logtime' });
    // Small focused dialogs for icon clicks
    const [noteDialog, setNoteDialog] = useState({ open: false, task: null });
    const [reassignTask, setReassignTask] = useState({ open: false, task: null, participants: [] });
    const participantsCache = useRef({});

    const openTaskDialog = (task, tab = 'logtime') =>
        setTaskDialog({ open: true, task, tab });

    const openPersonalQuickView = (todo) =>
        openTaskDialog(
            { ...todo, kind: 'todo', description: todo.notes },
            'logtime',
        );

    const openTaskReassign = async (task) => {
        const projectId = task.project?.id;
        let participants = [];
        if (projectId) {
            if (participantsCache.current[projectId]) {
                participants = participantsCache.current[projectId];
            } else {
                try {
                    const { data } = await api.get(`/projects/${projectId}/participants`);
                    participants = (data.participants || []).map((p) => p.user || p);
                    participantsCache.current[projectId] = participants;
                } catch { /* ignore */ }
            }
        }
        setReassignTask({ open: true, task, participants });
    };

    // Admin-only: which user's to-do list to show. 'self' is a sentinel for
    // "the signed-in user" so that toggling between admin's own list and
    // a coworker's list stays explicit. The query param sent to the API is
    // resolved on the fly inside makeUserParams() below.
    const [viewedUserId, setViewedUserId] = useState('self');
    const [teamFilterId, setTeamFilterId] = useState('all');
    const [projectFilterId, setProjectFilterId] = useState('all');
    const [users, setUsers] = useState([]);
    const [teams, setTeams] = useState([]);
    const viewingAll = isOverseer && viewedUserId === 'all';
    const viewingOtherUser =
        isOverseer &&
        viewedUserId !== 'self' &&
        viewedUserId !== 'all' &&
        viewedUserId !== user?.id;
    const viewingSelf =
        !viewingAll &&
        (!isOverseer ||
            viewedUserId === 'self' ||
            viewedUserId === user?.id);
    const apiUserId =
        viewingSelf || viewingAll ? null : viewedUserId;
    const showAssignee = viewingAll || viewingOtherUser;
    const selectedTeam = useMemo(
        () => teams.find((t) => t.id === teamFilterId) || null,
        [teams, teamFilterId],
    );
    const selectedProject = useMemo(
        () => projects.find((p) => p.id === projectFilterId) || null,
        [projects, projectFilterId],
    );
    const viewedUser = useMemo(
        () =>
            viewingSelf
                ? null
                : users.find((u) => u.id === viewedUserId) || null,
        [users, viewedUserId, viewingSelf],
    );

    const userParams = useMemo(
        () => (apiUserId ? { userId: apiUserId } : {}),
        [apiUserId],
    );

    useEffect(() => {
        if (!isOverseer) return;
        api.get('/users')
            .then((res) => setUsers(res.data.users || []))
            .catch(() => {});
        api.get('/teams')
            .then((res) => setTeams(res.data.teams || []))
            .catch(() => {});
    }, [isOverseer]);

    const buildListParams = (which) => {
        const params = { status: which, include: 'counts' };
        if (viewingAll) {
            params.scope = 'all';
            if (teamFilterId !== 'all') params.teamId = teamFilterId;
            if (projectFilterId !== 'all') params.projectId = projectFilterId;
        } else if (apiUserId) {
            params.userId = apiUserId;
        }
        return params;
    };

    const load = async (which = tab) => {
        setLoading(true);
        try {
            const { data } = await api.get('/todos', {
                params: buildListParams(which),
            });
            setTodos(data.todos || []);
            setTasks(data.tasks || []);
            if (data.counts) {
                setCounts(data.counts);
                if (viewingSelf && !viewingAll) {
                    setTodoAlertCount(data.counts.alert || 0);
                }
            }
        } catch (err) {
            toast.error(err.response?.data?.error || 'Failed to load tasks');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load(tab);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, apiUserId, viewingAll, teamFilterId, projectFilterId]);

    useEffect(() => {
        api.get('/projects')
            .then((res) => setProjects(res.data.projects || []))
            .catch(() => {});
    }, []);

    const linkableProjects = useMemo(
        () => projects.filter((p) => !p.isPersonal),
        [projects],
    );

    const handleSortChange = (value) => {
        setSortMode(value);
        try {
            localStorage.setItem(TODO_SORT_KEY, value);
        } catch {
            /* ignore */
        }
    };

    const sortedTodos = useMemo(
        () => sortTodoItems(todos, sortMode, { tab, kind: 'todo' }),
        [todos, sortMode, tab],
    );

    const sortedTasks = useMemo(
        () => sortTodoItems(tasks, sortMode, { tab, kind: 'task' }),
        [tasks, sortMode, tab],
    );

    // Quick keyword filter across title / notes / code / project name.
    const matchesQuery = (it, q) => {
        const hay = [
            it.title,
            it.notes,
            it.code,
            it.project?.name,
            it.project?.code,
            it.parent?.title,
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        return hay.includes(q);
    };
    const trimmedQuery = query.trim().toLowerCase();
    const visibleTodos = useMemo(
        () =>
            trimmedQuery
                ? sortedTodos.filter((t) => matchesQuery(t, trimmedQuery))
                : sortedTodos,
        [sortedTodos, trimmedQuery],
    );
    const visibleTasks = useMemo(
        () =>
            trimmedQuery
                ? sortedTasks.filter((t) => matchesQuery(t, trimmedQuery))
                : sortedTasks,
        [sortedTasks, trimmedQuery],
    );
    const noMatches =
        trimmedQuery &&
        visibleTodos.length === 0 &&
        visibleTasks.length === 0;

    // Manual drag-reorder is index-based on the full list, so disable it
    // while a search filter is narrowing the rows.
    const canManualReorder =
        viewingSelf &&
        !viewingAll &&
        tab === 'open' &&
        sortMode === 'manual' &&
        !trimmedQuery;

    // Paginate each section (20/50/100). Manual reorder is only enabled
    // with no search, so the personal page's global index stays correct.
    const todoPager = usePagination(visibleTodos, 20);
    const taskPager = usePagination(visibleTasks, 20);

    const sortOptionLabel =
        SORT_OPTIONS.find((o) => o.id === sortMode)?.label || 'Sort';

    const personalSectionSubtitle = viewingAll
        ? `Personal to-dos · ${sortOptionLabel.toLowerCase()}`
        : tab === 'open'
          ? canManualReorder
              ? 'Drag to reorder your personal items.'
              : `Sorted by ${sortOptionLabel.toLowerCase()}.`
          : `Personal tasks you have completed · ${sortOptionLabel.toLowerCase()}.`;

    const projectSectionSubtitle = viewingAll
        ? `Assigned project tasks · ${sortOptionLabel.toLowerCase()}`
        : tab === 'done'
          ? `Project tasks you have completed · ${sortOptionLabel.toLowerCase()}.`
          : `Tasks assigned to you · ${sortOptionLabel.toLowerCase()}.`;

    useEffect(() => {
        if (!linkableProjects.length) {
            setNewProjectId(NO_PROJECT);
            return;
        }
        const saved = localStorage.getItem(TODO_LAST_PROJECT_KEY);
        if (saved && linkableProjects.some((p) => p.id === saved)) {
            setNewProjectId(saved);
            return;
        }
        setNewProjectId(linkableProjects[0].id);
    }, [linkableProjects]);

    const refreshCounts_ = async () => {
        try {
            const summary = await api.get('/todos/summary', {
                params: buildListParams(tab),
            });
            setCounts(summary.data.counts);
            if (viewingSelf && !viewingAll) {
                setTodoAlertCount(summary.data.counts.alert || 0);
            }
        } catch {
            /* ignore — sidebar badge will refresh on next event */
        }
    };

    const canManagePersonal = (todo) =>
        viewingSelf && !viewingAll && todo.ownerId === user?.id;

    const replaceTodo = (todo) =>
        setTodos((prev) => prev.map((t) => (t.id === todo.id ? todo : t)));
    const removeTodo = (id) =>
        setTodos((prev) => prev.filter((t) => t.id !== id));

    const replaceTask = (task) =>
        setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
    const removeTask = (id) =>
        setTasks((prev) => prev.filter((t) => t.id !== id));

    const handleCreate = async (e) => {
        e?.preventDefault?.();
        const title = newTitle.trim();
        if (!title) return;
        if (!newProjectId || newProjectId === NO_PROJECT) {
            toast.error('Pick the related project before adding a task.');
            return;
        }
        setCreating(true);
        try {
            const { data } = await api.post(
                '/todos',
                { title, projectId: newProjectId },
                { params: userParams },
            );
            setNewTitle('');
            localStorage.setItem(TODO_LAST_PROJECT_KEY, newProjectId);
            if (tab === 'open' || tab === 'all') {
                setTodos((prev) => [data.todo, ...prev]);
            }
            await refreshCounts_();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not create task');
        } finally {
            setCreating(false);
        }
    };

    const togglePersonalDone = async (todo) => {
        try {
            const { data } = await api.patch(
                `/todos/${todo.id}`,
                { done: !todo.done },
            );
            replaceTodo(data.todo);
            if (tab === 'open' && data.todo.done) removeTodo(todo.id);
            if (tab === 'done' && !data.todo.done) removeTodo(todo.id);
            await refreshCounts_();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update task');
        }
    };

    // Project tasks live in /api/tasks; we only need to flip the status, then
    // reshape the response to match what the to-do feed expects.
    const toggleTaskDone = async (task) => {
        const nextStatus = task.done ? 'TODO' : 'DONE';
        try {
            const { data } = await api.patch(`/tasks/${task.id}`, {
                status: nextStatus,
            });
            const t = data.task;
            const reshaped = {
                ...task,
                done: t.status === 'DONE',
                doneAt: t.status === 'DONE' ? t.updatedAt : null,
                status: t.status,
                updatedAt: t.updatedAt,
            };
            replaceTask(reshaped);
            if (tab === 'open' && reshaped.done) removeTask(task.id);
            if (tab === 'done' && !reshaped.done) removeTask(task.id);
            await refreshCounts_();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update task');
        }
    };

    const updateTaskStatus = async (task, nextStatus) => {
        try {
            const { data } = await api.patch(`/tasks/${task.id}`, {
                status: nextStatus,
            });
            const t = data.task;
            const reshaped = {
                ...task,
                done: t.status === 'DONE',
                doneAt: t.status === 'DONE' ? t.updatedAt : null,
                status: t.status,
                updatedAt: t.updatedAt,
            };
            replaceTask(reshaped);
            if (taskDialog.task?.id === task.id) {
                setTaskDialog((prev) =>
                    prev.open
                        ? { ...prev, task: { ...prev.task, ...reshaped } }
                        : prev,
                );
            }
            if (tab === 'open' && reshaped.done) removeTask(task.id);
            if (tab === 'done' && !reshaped.done) removeTask(task.id);
            await refreshCounts_();
            toast.success('Status updated');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update status');
        }
    };

    const handleDeletePersonal = async (todo) => {
        if (!window.confirm(`Delete "${todo.title}"?`)) return;
        try {
            await api.delete(`/todos/${todo.id}`);
            removeTodo(todo.id);
            if (viewingSelf) refreshCounts();
            await refreshCounts_();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete task');
        }
    };

    const handleClearDone = async () => {
        if (!window.confirm('Delete all completed personal to-dos? This cannot be undone.'))
            return;
        try {
            await api.post('/todos/clear-done', null, { params: userParams });
            await load('done');
            if (viewingSelf) refreshCounts();
            toast.success('Cleared completed items');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not clear');
        }
    };

    // Drag-and-drop reorder lives only in the personal section (open tab).
    const onDragStart = (idx) => (e) => {
        if (!canManualReorder) return;
        dragRef.current.from = idx;
        e.dataTransfer.effectAllowed = 'move';
    };

    const onDragOver = (idx) => (e) => {
        if (!canManualReorder || dragRef.current.from == null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (idx === dragRef.current.over) return;
        dragRef.current.over = idx;
    };

    const onDrop = (idx) => async (e) => {
        if (!canManualReorder) return;
        e.preventDefault();
        const from = dragRef.current.from;
        dragRef.current.from = null;
        if (from == null || from === idx) return;

        const next = [...sortedTodos];
        const [moved] = next.splice(from, 1);
        next.splice(idx, 0, moved);
        setTodos(next);

        try {
            await api.post(
                '/todos/reorder',
                { ids: next.map((t) => t.id) },
                { params: userParams },
            );
        } catch {
            toast.error('Reorder failed; reloading list');
            load(tab);
        }
    };

    const moveUp = async (idx) => {
        if (idx <= 0 || !canManualReorder) return;
        const next = [...sortedTodos];
        [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
        setTodos(next);
        try {
            await api.post(
                '/todos/reorder',
                { ids: next.map((t) => t.id) },
                { params: userParams },
            );
        } catch {
            load(tab);
        }
    };

    const moveDown = async (idx) => {
        if (idx >= sortedTodos.length - 1 || !canManualReorder) return;
        const next = [...sortedTodos];
        [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
        setTodos(next);
        try {
            await api.post(
                '/todos/reorder',
                { ids: next.map((t) => t.id) },
                { params: userParams },
            );
        } catch {
            load(tab);
        }
    };

    const empty = todos.length === 0 && tasks.length === 0;

    const inlineControls =
        isOverseer || (viewingSelf && tab === 'done' && counts.todoDone > 0) ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2 shadow-sm">
            {isOverseer && (
                <>
                    <Label className="ml-1 text-xs text-muted-foreground">
                        Viewing
                    </Label>
                    <Select
                        value={viewedUserId}
                        onValueChange={setViewedUserId}
                    >
                        <SelectTrigger className="h-8 w-[220px] text-xs">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="self">My to-do</SelectItem>
                            <SelectItem value="all">
                                All open to-dos
                            </SelectItem>
                            {users
                                .filter((u) => u.id !== user?.id)
                                .map((u) => (
                                    <SelectItem key={u.id} value={u.id}>
                                        {u.name || u.email}
                                    </SelectItem>
                                ))}
                        </SelectContent>
                    </Select>
                    {viewingAll && (
                        <>
                            <Label className="text-xs text-muted-foreground">
                                Team
                            </Label>
                            <Select
                                value={teamFilterId}
                                onValueChange={setTeamFilterId}
                            >
                                <SelectTrigger className="h-8 w-[200px] text-xs">
                                    <SelectValue placeholder="All teams" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">
                                        All teams
                                    </SelectItem>
                                    {teams.map((t) => (
                                        <SelectItem key={t.id} value={t.id}>
                                            {t.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Label className="text-xs text-muted-foreground">
                                Project
                            </Label>
                            <Select
                                value={projectFilterId}
                                onValueChange={setProjectFilterId}
                            >
                                <SelectTrigger className="h-8 w-[200px] text-xs">
                                    <SelectValue placeholder="All projects" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">
                                        All projects
                                    </SelectItem>
                                    {linkableProjects.map((p) => (
                                        <SelectItem key={p.id} value={p.id}>
                                            {p.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </>
                    )}
                </>
            )}
            {viewingSelf && tab === 'done' && counts.todoDone > 0 && (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleClearDone}
                    className="ml-auto h-8 gap-2 text-xs"
                >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear completed
                </Button>
            )}
        </div>
    ) : null;

    return (
        <div className="flex flex-col gap-4">
            {inlineControls}
            {viewingAll && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 shadow-sm dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
                    <span>
                        Showing{' '}
                        <strong>
                            {tab === 'open'
                                ? 'open'
                                : tab === 'done'
                                  ? 'completed'
                                  : 'all'}{' '}
                            to-dos
                        </strong>
                        {selectedTeam
                            ? ` for team ${selectedTeam.name}`
                            : ' for everyone'}
                        {selectedProject
                            ? ` in ${selectedProject.name}`
                            : ''}
                        . Assignee is shown on each row.
                    </span>
                    <button
                        type="button"
                        onClick={() => setViewedUserId('self')}
                        className="shrink-0 font-medium underline-offset-2 hover:underline"
                    >
                        Back to my list
                    </button>
                </div>
            )}
            {!viewingSelf && !viewingAll && viewedUser && (
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                            <span>
                                Viewing <strong>{viewedUser.name || viewedUser.email}</strong>'s
                                to-do list. Changes here apply to their account.
                            </span>
                            <button
                                type="button"
                                onClick={() => setViewedUserId('self')}
                                className="font-medium underline-offset-2 hover:underline"
                            >
                                Back to mine
                            </button>
                        </div>
                    )}
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <StatCard
                            label="Open"
                            value={counts.open}
                            sub={`${counts.todoOpen ?? 0} personal · ${counts.taskOpen ?? 0} assigned`}
                            tone="default"
                        />
                        <StatCard
                            label="Due today"
                            value={counts.dueToday}
                            tone={counts.dueToday > 0 ? 'amber' : 'default'}
                        />
                        <StatCard
                            label="Overdue"
                            value={counts.overdue}
                            tone={counts.overdue > 0 ? 'red' : 'default'}
                        />
                        <StatCard
                            label="Done"
                            value={counts.done}
                            tone="green"
                        />
                    </div>

                    {viewingSelf && !viewingAll && (
                    <>
                    <form
                        onSubmit={handleCreate}
                        className="flex flex-col gap-2 rounded-lg border bg-card p-2 shadow-sm sm:flex-row sm:items-center"
                    >
                        <Plus className="ml-2 hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" />
                        <Input
                            value={newTitle}
                            onChange={(e) => setNewTitle(e.target.value)}
                            placeholder={
                                viewingSelf
                                    ? 'Add a personal task...'
                                    : `Add a task for ${viewedUser?.name || 'this user'}...`
                            }
                            className="border-0 shadow-none focus-visible:ring-0"
                        />
                        <Select
                            value={newProjectId}
                            onValueChange={setNewProjectId}
                            disabled={!linkableProjects.length}
                        >
                            <SelectTrigger className="h-9 w-full shrink-0 sm:w-[220px]">
                                <SelectValue placeholder="Related project" />
                            </SelectTrigger>
                            <SelectContent>
                                {linkableProjects.map((p) => (
                                    <SelectItem key={p.id} value={p.id}>
                                        {p.code ? `${p.code} · ${p.name}` : p.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Button
                            type="submit"
                            size="sm"
                            className="shrink-0"
                            disabled={
                                !newTitle.trim() ||
                                creating ||
                                !linkableProjects.length ||
                                newProjectId === NO_PROJECT
                            }
                        >
                            Add
                        </Button>
                    </form>
                    {!linkableProjects.length && (
                        <p className="-mt-2 px-1 text-xs text-muted-foreground">
                            You need access to at least one shared project before
                            adding personal tasks.
                        </p>
                    )}
                    </>
                    )}

                    <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search your to-dos by keyword…"
                            className="h-9 pl-9 pr-9"
                        />
                        {query && (
                            <button
                                type="button"
                                onClick={() => setQuery('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                                aria-label="Clear search"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        )}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1 rounded-md border bg-card p-1 text-sm shadow-sm">
                            {STATUS_TABS.map((t) => {
                                const active = t.id === tab;
                                const cnt =
                                    t.id === 'open'
                                        ? counts.open
                                        : t.id === 'done'
                                            ? counts.done
                                            : counts.open + counts.done;
                                return (
                                    <button
                                        key={t.id}
                                        type="button"
                                        onClick={() => setTab(t.id)}
                                        className={cn(
                                            'flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors',
                                            active
                                                ? 'bg-primary text-primary-foreground'
                                                : 'text-muted-foreground hover:bg-accent',
                                        )}
                                    >
                                        {t.label}
                                        <span
                                            className={cn(
                                                'rounded-full px-1.5 text-[10px]',
                                                active
                                                    ? 'bg-primary-foreground/20 text-primary-foreground'
                                                    : 'bg-muted text-muted-foreground',
                                            )}
                                        >
                                            {cnt}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="flex items-center gap-2">
                            <Label
                                htmlFor="todo-sort"
                                className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                            >
                                <ArrowUpDown className="h-3.5 w-3.5" />
                                Sort
                            </Label>
                            <Select
                                value={sortMode}
                                onValueChange={handleSortChange}
                            >
                                <SelectTrigger
                                    id="todo-sort"
                                    className="h-8 w-[200px] text-xs"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {SORT_OPTIONS.map((o) => (
                                        <SelectItem key={o.id} value={o.id}>
                                            {o.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    {loading ? (
                        <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground shadow-sm">
                            Loading your tasks...
                        </div>
                    ) : empty ? (
                        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-card p-12 text-center shadow-sm">
                            <CheckSquare className="h-10 w-10 text-muted-foreground" />
                            <p className="font-medium">
                                {tab === 'done'
                                    ? 'Nothing checked off yet.'
                                    : 'You\u2019re all caught up.'}
                            </p>
                            <p className="text-sm text-muted-foreground">
                                {tab === 'open'
                                    ? 'Add something above, or wait to be assigned a project task.'
                                    : tab === 'done'
                                        ? 'Complete a task to see it here.'
                                        : 'Your to-do list is empty.'}
                            </p>
                        </div>
                    ) : noMatches ? (
                        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-card p-12 text-center shadow-sm">
                            <Search className="h-10 w-10 text-muted-foreground" />
                            <p className="font-medium">No matching to-dos.</p>
                            <p className="text-sm text-muted-foreground">
                                Nothing matches “{query.trim()}”. Try a
                                different keyword.
                            </p>
                            <Button
                                variant="outline"
                                size="sm"
                                className="mt-1"
                                onClick={() => setQuery('')}
                            >
                                Clear search
                            </Button>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {visibleTodos.length > 0 && (
                                <PageSizeControl
                                    pageSize={todoPager.pageSize}
                                    onPageSizeChange={todoPager.setPageSize}
                                    options={[20, 50, 100]}
                                    className="justify-end"
                                />
                            )}
                            <Section
                                title="My to-do"
                                subtitle={personalSectionSubtitle}
                                count={visibleTodos.length}
                                emptyText={
                                    trimmedQuery
                                        ? 'No personal tasks match your search.'
                                        : tab === 'open'
                                          ? 'No personal tasks yet.'
                                          : tab === 'done'
                                            ? 'No completed personal tasks.'
                                            : 'No personal tasks.'
                                }
                            >
                                {todoPager.pageItems.map((todo, i) => {
                                    const idx =
                                        (todoPager.page - 1) *
                                            todoPager.pageSize +
                                        i;
                                    return (
                                    <PersonalRow
                                        key={todo.id}
                                        todo={todo}
                                        idx={idx}
                                        total={visibleTodos.length}
                                        canReorder={canManualReorder}
                                        canLogTime={
                                            viewingSelf &&
                                            todo.ownerId === user?.id
                                        }
                                        showAssignee={showAssignee}
                                        canManage={canManagePersonal(todo)}
                                        onToggle={() => togglePersonalDone(todo)}
                                        onEdit={() => setEditing(todo)}
                                        onOpen={
                                            viewingSelf &&
                                            todo.projectId &&
                                            todo.ownerId === user?.id
                                                ? () => openPersonalQuickView(todo)
                                                : undefined
                                        }
                                        onDelete={() => handleDeletePersonal(todo)}
                                        onLogTime={() => openPersonalQuickView(todo)}
                                        onUp={() => moveUp(idx)}
                                        onDown={() => moveDown(idx)}
                                        onDragStart={onDragStart(idx)}
                                        onDragOver={onDragOver(idx)}
                                        onDrop={onDrop(idx)}
                                    />
                                    );
                                })}
                            </Section>
                            {visibleTodos.length > 0 && (
                                <Pagination
                                    page={todoPager.page}
                                    pageSize={todoPager.pageSize}
                                    total={todoPager.total}
                                    totalPages={todoPager.totalPages}
                                    onPageChange={todoPager.setPage}
                                    onPageSizeChange={todoPager.setPageSize}
                                    pageSizeOptions={[20, 50, 100]}
                                    className="rounded-lg border bg-card shadow-sm"
                                />
                            )}

                            {visibleTasks.length > 0 && (
                                <PageSizeControl
                                    pageSize={taskPager.pageSize}
                                    onPageSizeChange={taskPager.setPageSize}
                                    options={[20, 50, 100]}
                                    className="justify-end"
                                />
                            )}
                            <Section
                                title="From projects"
                                subtitle={projectSectionSubtitle}
                                icon={
                                    <FolderKanban className="h-3.5 w-3.5 text-muted-foreground" />
                                }
                                count={visibleTasks.length}
                                emptyText={
                                    trimmedQuery
                                        ? 'No project tasks match your search.'
                                        : tab === 'open'
                                          ? 'Nothing assigned to you right now.'
                                          : tab === 'done'
                                            ? 'No completed assignments yet.'
                                            : 'No project tasks assigned to you.'
                                }
                            >
                                {taskPager.pageItems.map((task) => (
                                    <TaskRow
                                        key={task.id}
                                        task={task}
                                        showAssignee={showAssignee}
                                        onToggle={() => toggleTaskDone(task)}
                                        onOpen={() => openTaskDialog(task, 'logtime')}
                                        onStatusChange={(status) =>
                                            updateTaskStatus(task, status)
                                        }
                                        onNote={() => setNoteDialog({ open: true, task })}
                                        onLogTime={() => openTaskDialog(task, 'logtime')}
                                        onReassign={() => openTaskReassign(task)}
                                    />
                                ))}
                            </Section>
                            {visibleTasks.length > 0 && (
                                <Pagination
                                    page={taskPager.page}
                                    pageSize={taskPager.pageSize}
                                    total={taskPager.total}
                                    totalPages={taskPager.totalPages}
                                    onPageChange={taskPager.setPage}
                                    onPageSizeChange={taskPager.setPageSize}
                                    pageSizeOptions={[20, 50, 100]}
                                    className="rounded-lg border bg-card shadow-sm"
                                />
                            )}
                        </div>
                    )}

            <TodoEditDialog
                key={editing?.id || 'new'}
                todo={editing}
                projects={linkableProjects}
                onClose={() => setEditing(null)}
                onSaved={async (saved) => {
                    replaceTodo(saved);
                    setEditing(null);
                    await refreshCounts_();
                }}
            />

            {/* Full task quick-view modal (task title click) */}
            <TaskQuickViewDialog
                open={taskDialog.open}
                task={taskDialog.task}
                defaultTab={taskDialog.tab}
                projectId={taskDialog.task?.projectId || taskDialog.task?.project?.id}
                projectName={taskDialog.task?.project?.name}
                onStatusChange={
                    taskDialog.task?.kind === 'todo'
                        ? undefined
                        : (status) => {
                              if (taskDialog.task) {
                                  updateTaskStatus(taskDialog.task, status);
                              }
                          }
                }
                canApprove={
                    isOverseer ||
                    hasCapability(user, CAPABILITIES_FRONT.TASK_APPROVE)
                }
                canRerequest={
                    isOverseer ||
                    taskDialog.task?.createdById === user?.id ||
                    taskDialog.task?.createdBy?.id === user?.id ||
                    taskDialog.task?.assignee?.id === user?.id ||
                    taskDialog.task?.assigneeId === user?.id
                }
                onApproved={() => {
                    // Reload the task list + counts so approval /
                    // disapproval / re-request state flows back in.
                    load();
                    refreshCounts_();
                }}
                onClose={() => setTaskDialog({ open: false, task: null, tab: 'logtime' })}
            />

            {/* Small focused note dialog (note icon click) */}
            <TodoNoteDialog
                open={noteDialog.open}
                task={noteDialog.task}
                onClose={() => setNoteDialog({ open: false, task: null })}
            />

            {/* Propose reassignment dialog for project tasks */}
            <TodoReassignDialog
                state={reassignTask}
                currentUserId={user?.id}
                onClose={() => setReassignTask({ open: false, task: null, participants: [] })}
                onSubmitted={() => setReassignTask({ open: false, task: null, participants: [] })}
            />
        </div>
    );
}

function StatCard({ label, value, sub, tone }) {
    const tones = {
        default: 'border bg-card',
        amber: 'border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10',
        red: 'border-rose-200 bg-rose-50 dark:border-rose-500/30 dark:bg-rose-500/10',
        green: 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10',
    };
    return (
        <div
            className={cn(
                'rounded-lg p-3 shadow-sm',
                tones[tone] || tones.default,
            )}
        >
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {label}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
                {value ?? 0}
            </p>
            {sub && (
                <p className="mt-1 text-[10px] text-muted-foreground">{sub}</p>
            )}
        </div>
    );
}

function Section({ title, subtitle, count, icon, emptyText, children }) {
    const items = Array.isArray(children) ? children : [children];
    const hasChildren = items.filter(Boolean).length > 0;
    return (
        <section className="overflow-hidden rounded-lg border bg-card shadow-sm">
            <header className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2">
                    {icon}
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {title}
                    </h2>
                    <span className="rounded-full bg-muted px-2 text-[10px] font-medium text-muted-foreground">
                        {count}
                    </span>
                </div>
                {subtitle && (
                    <span className="hidden text-[11px] text-muted-foreground sm:block">
                        {subtitle}
                    </span>
                )}
            </header>
            {hasChildren ? (
                <ul className="divide-y">{children}</ul>
            ) : (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                    {emptyText}
                </div>
            )}
        </section>
    );
}

function PersonalRow({
    todo,
    idx,
    total,
    canReorder,
    canLogTime,
    showAssignee,
    canManage,
    onToggle,
    onEdit,
    onOpen,
    onDelete,
    onLogTime,
    onUp,
    onDown,
    onDragStart,
    onDragOver,
    onDrop,
}) {
    const due = dueLabel(todo.dueDate);
    const dueCls = dueClass(todo.dueDate, todo.done);
    const meta = PRIORITY_META[todo.priority];
    return (
        <li
            draggable={canReorder}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            className={cn(
                'group flex items-start gap-2 px-3 py-2.5 transition-colors',
                todo.done && 'bg-muted/30',
            )}
        >
            {canReorder && (
                <span
                    className="mt-1.5 inline-flex cursor-grab text-muted-foreground hover:text-foreground"
                    aria-hidden
                >
                    <GripVertical className="h-4 w-4" />
                </span>
            )}
            <button
                type="button"
                onClick={onToggle}
                className={cn(
                    'mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
                    todo.done
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/30 hover:border-primary',
                )}
                aria-label={todo.done ? 'Mark as not done' : 'Mark as done'}
            >
                {todo.done && <Check className="h-3.5 w-3.5" />}
            </button>
            <div className="min-w-0 flex-1">
                {onOpen ? (
                    <button
                        type="button"
                        onClick={onOpen}
                        className={cn(
                            'text-left text-sm font-medium hover:text-primary hover:underline',
                            todo.done && 'text-muted-foreground line-through',
                        )}
                        title="View details and log time"
                    >
                        {todo.title}
                    </button>
                ) : (
                    <p
                        className={cn(
                            'text-sm font-medium',
                            todo.done && 'text-muted-foreground line-through',
                        )}
                    >
                        {todo.title}
                    </p>
                )}
                {todo.notes && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                        {todo.notes}
                    </p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                    {showAssignee && (
                        <AssigneeBadge person={todo.owner} />
                    )}
                    {due && (
                        <span
                            className={cn(
                                'inline-flex items-center gap-1',
                                dueCls,
                            )}
                        >
                            {dueCls.includes('destructive') ? (
                                <AlertCircle className="h-3 w-3" />
                            ) : (
                                <CalendarDays className="h-3 w-3" />
                            )}
                            {due}
                        </span>
                    )}
                    {meta && (
                        <Badge
                            variant="outline"
                            className={cn(
                                'gap-1 text-[10px]',
                                meta.className,
                            )}
                        >
                            <Flag className="h-2.5 w-2.5" />
                            {meta.label}
                        </Badge>
                    )}
                    {todo.project && (
                        <Link
                            to={`/projects/${todo.project.id}`}
                            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                        >
                            <FolderKanban className="h-3 w-3" />
                            {todo.project.name}
                        </Link>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                {canLogTime && onLogTime && todo.projectId && (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        onClick={onLogTime}
                        title="Log time"
                        aria-label="Log time"
                    >
                        <Clock className="h-3.5 w-3.5" />
                    </Button>
                )}
                {canReorder && (
                    <>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={onUp}
                            disabled={idx === 0}
                            aria-label="Move up"
                        >
                            <ChevronUp className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={onDown}
                            disabled={idx === total - 1}
                            aria-label="Move down"
                        >
                            <ChevronDown className="h-4 w-4" />
                        </Button>
                    </>
                )}
                {canManage && (
                    <>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={onEdit}
                            aria-label="Edit"
                        >
                            <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={onDelete}
                            aria-label="Delete"
                        >
                            <X className="h-4 w-4" />
                        </Button>
                    </>
                )}
            </div>
        </li>
    );
}

function TaskRow({
    task,
    showAssignee,
    onToggle,
    onOpen,
    onStatusChange,
    onNote,
    onLogTime,
    onReassign,
}) {
    const { list: taskStatusOptions } = useTaskStatuses();
    const taskStatusList = taskStatusOptions.length
        ? taskStatusOptions
        : TASK_STATUSES;
    const due = dueLabel(task.dueDate);
    const dueCls = dueClass(task.dueDate, task.done);
    const meta = PRIORITY_META[task.priority];
    const taskHref = task.project
        ? `/projects/${task.project.id}#task-${task.id}`
        : null;
    return (
        <li
            className={cn(
                'group flex items-start gap-2 px-3 py-2.5 transition-colors',
                task.done && 'bg-muted/30',
            )}
        >
            <button
                type="button"
                onClick={onToggle}
                className={cn(
                    'mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
                    task.done
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/30 hover:border-primary',
                )}
                aria-label={task.done ? 'Mark as not done' : 'Mark as done'}
            >
                {task.done && <Check className="h-3.5 w-3.5" />}
            </button>

            {/* Main body — clicking the title opens the quick-view sheet */}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    {task.code && (
                        <span
                            className="shrink-0 rounded border border-border bg-muted/60 px-1 py-px font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
                            title={task.parent ? 'Subtask code' : 'Task code'}
                        >
                            {task.code}
                        </span>
                    )}
                    {onOpen ? (
                        <button
                            type="button"
                            onClick={onOpen}
                            className={cn(
                                'truncate text-sm font-medium text-left hover:underline hover:text-primary transition-colors',
                                task.done && 'text-muted-foreground line-through',
                            )}
                            title="View task details"
                        >
                            {task.title}
                        </button>
                    ) : (
                        <span
                            className={cn(
                                'truncate text-sm font-medium',
                                task.done && 'text-muted-foreground line-through',
                            )}
                        >
                            {task.title}
                        </span>
                    )}
                    {task.parent && (
                        <Badge variant="outline" className="gap-1 text-[10px] shrink-0">
                            <GitBranch className="h-2.5 w-2.5" />
                            Subtask
                        </Badge>
                    )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                    {showAssignee && (
                        <AssigneeBadge person={task.assignee} />
                    )}
                    {due && (
                        <span
                            className={cn(
                                'inline-flex items-center gap-1',
                                dueCls,
                            )}
                        >
                            {dueCls.includes('destructive') ? (
                                <AlertCircle className="h-3 w-3" />
                            ) : (
                                <CalendarDays className="h-3 w-3" />
                            )}
                            {due}
                        </span>
                    )}
                    {meta && (
                        <Badge
                            variant="outline"
                            className={cn('gap-1 text-[10px]', meta.className)}
                        >
                            <Flag className="h-2.5 w-2.5" />
                            {meta.label}
                        </Badge>
                    )}
                    {onStatusChange && !task.done && (
                        <Select
                            value={task.status || 'TODO'}
                            onValueChange={onStatusChange}
                        >
                            <SelectTrigger
                                className="h-6 w-[7.5rem] border-dashed text-[10px]"
                                onClick={(e) => e.stopPropagation()}
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
                    )}
                    {task.status && task.done && (
                        <Badge variant="secondary" className="text-[10px]">
                            {TASK_STATUS_MAP[task.status]?.label || task.status}
                        </Badge>
                    )}
                    {task.project && (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <FolderKanban className="h-3 w-3" />
                            {task.project.code
                                ? `${task.project.code} · ${task.project.name}`
                                : task.project.name}
                            {task.phase ? ` / ${task.phase.name}` : ''}
                        </span>
                    )}
                    {task.parent && (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <UserIcon className="h-3 w-3" />
                            under "{task.parent.title}"
                        </span>
                    )}
                </div>
            </div>

            {/* Action icons — always visible */}
            <div className="flex shrink-0 items-center gap-0.5">
                {onNote && (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        onClick={onNote}
                        title="Leave a note"
                        aria-label="Leave a note"
                    >
                        <MessageSquarePlus className="h-3.5 w-3.5" />
                    </Button>
                )}
                {onLogTime && (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        onClick={onLogTime}
                        title="Log time"
                        aria-label="Log time"
                    >
                        <Clock className="h-3.5 w-3.5" />
                    </Button>
                )}
                {onReassign && (
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        onClick={onReassign}
                        title="Propose reassignment"
                        aria-label="Propose reassignment"
                    >
                        <UserCog className="h-3.5 w-3.5" />
                    </Button>
                )}
                {taskHref && (
                    <a
                        href={taskHref}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        title="Open in project plan"
                        aria-label="Open in project plan"
                    >
                        <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                )}
            </div>
        </li>
    );
}

// Lightweight note dialog for project tasks on the Todos page.
// Uses a plain Textarea (no @-mentions) to avoid needing to load
// project participants. The note is pinned to the task via POST /notes.
// Lightweight propose-reassignment dialog for the Todos page.
// Participants are loaded lazily before this dialog is opened.
// Sentinel value for the "Let manager decide" option in the assignee
// Select below. Radix UI (which shadcn's <Select> wraps) explicitly
// forbids an empty-string value on <SelectItem> — it reserves "" for
// the "no value selected" placeholder state. Passing value="" crashes
// the dialog, which is why the reassignment flow was inert on the
// Todos page. We send `null` to the API when the user picks this
// option (or leaves the selector untouched).
const LET_MANAGER_DECIDE = '__let_manager_decide__';
const NO_PROJECT = '__pick_project__';
const TODO_LAST_PROJECT_KEY = 'todo.lastProjectId';

function TodoReassignDialog({ state, currentUserId, onClose, onSubmitted }) {
    const [reason, setReason] = useState('');
    const [toAssigneeId, setToAssigneeId] = useState(LET_MANAGER_DECIDE);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (state.open) {
            setReason('');
            setToAssigneeId(LET_MANAGER_DECIDE);
        }
    }, [state.open, state.task?.id]);

    const currentAssigneeId = state.task?.assigneeId || null;
    const candidates = useMemo(
        () =>
            (state.participants || [])
                .filter((u) => u.id !== currentAssigneeId && u.id !== currentUserId)
                .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
        [state.participants, currentAssigneeId, currentUserId],
    );

    const submit = async (e) => {
        e.preventDefault();
        if (!state.task) return;
        if (reason.trim().length < 3) {
            toast.error('Add a short reason so the reviewer knows the context.');
            return;
        }
        setSaving(true);
        try {
            await api.post('/reassignments', {
                taskId: state.task.id,
                toAssigneeId:
                    toAssigneeId && toAssigneeId !== LET_MANAGER_DECIDE
                        ? toAssigneeId
                        : null,
                reason: reason.trim(),
            });
            toast.success('Proposal submitted. A manager will review it.');
            onSubmitted?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not submit the proposal.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={state.open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Propose reassignment</DialogTitle>
                    <DialogDescription>
                        Suggest a new assignee for{' '}
                        <strong className="text-foreground">{state.task?.title}</strong>.
                        A manager or admin must approve before the change takes effect.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="space-y-3">
                    {candidates.length > 0 && (
                        <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">
                                Suggest someone (optional)
                            </label>
                            <Select
                                value={toAssigneeId}
                                onValueChange={setToAssigneeId}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Let manager decide" />
                                </SelectTrigger>
                                <SelectContent>
                                    {/* Sentinel value because Radix
                                        forbids empty strings on
                                        SelectItem — see comment near
                                        LET_MANAGER_DECIDE above. */}
                                    <SelectItem value={LET_MANAGER_DECIDE}>
                                        Let manager decide
                                    </SelectItem>
                                    {candidates.map((u) => (
                                        <SelectItem key={u.id} value={u.id}>
                                            {u.name || u.email}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">
                            Reason <span className="text-destructive">*</span>
                        </label>
                        <Textarea
                            rows={3}
                            autoFocus
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="Briefly explain why you need this task reassigned…"
                            disabled={saving}
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving || reason.trim().length < 3}>
                            {saving ? 'Submitting…' : 'Submit proposal'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function TodoEditDialog({ todo, projects, onClose, onSaved }) {
    const open = Boolean(todo);
    const [title, setTitle] = useState(todo?.title || '');
    const [notes, setNotes] = useState(todo?.notes || '');
    const [dueDate, setDueDate] = useState(toDateInputValue(todo?.dueDate));
    const [priority, setPriority] = useState(todo?.priority || 'MEDIUM');
    const [projectId, setProjectId] = useState(
        todo?.projectId || projects[0]?.id || NO_PROJECT,
    );
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (todo) {
            setTitle(todo.title || '');
            setNotes(todo.notes || '');
            setDueDate(toDateInputValue(todo.dueDate));
            setPriority(todo.priority || 'MEDIUM');
            setProjectId(todo.projectId || projects[0]?.id || NO_PROJECT);
        }
    }, [todo, projects]);

    const submit = async () => {
        if (!todo) return;
        if (!title.trim()) {
            toast.error('Title is required');
            return;
        }
        if (!projectId || projectId === NO_PROJECT) {
            toast.error('Related project is required');
            return;
        }
        setSaving(true);
        try {
            const { data } = await api.patch(`/todos/${todo.id}`, {
                title: title.trim(),
                notes: notes ? notes.trim() : null,
                dueDate: dueDate || null,
                priority,
                projectId,
            });
            localStorage.setItem(TODO_LAST_PROJECT_KEY, projectId);
            onSaved(data.todo);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Edit task</DialogTitle>
                    <DialogDescription>
                        Adjust title, due date, priority and related project.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="space-y-2">
                        <Label htmlFor="todo-title">Title</Label>
                        <Input
                            id="todo-title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="todo-notes">Notes</Label>
                        <Textarea
                            id="todo-notes"
                            rows={3}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Optional details..."
                        />
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="todo-due">Due date</Label>
                            <Input
                                id="todo-due"
                                type="date"
                                value={dueDate}
                                onChange={(e) => setDueDate(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Priority</Label>
                            <Select
                                value={priority}
                                onValueChange={setPriority}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="LOW">Low</SelectItem>
                                    <SelectItem value="MEDIUM">Medium</SelectItem>
                                    <SelectItem value="HIGH">High</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="space-y-2">
                        <Label>
                            Related project{' '}
                            <span className="text-destructive">*</span>
                        </Label>
                        <Select
                            value={projectId}
                            onValueChange={setProjectId}
                            disabled={!projects.length}
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="Pick a project" />
                            </SelectTrigger>
                            <SelectContent>
                                {projects.map((p) => (
                                    <SelectItem key={p.id} value={p.id}>
                                        {p.code ? `${p.code} · ${p.name}` : p.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button onClick={submit} disabled={saving} className="gap-2">
                        <CheckCheck className="h-4 w-4" />
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// Small focused note dialog opened by the note icon on task rows.
// File attachments are supported via NoteAttachmentsField.
function TodoNoteDialog({ open, task, onClose }) {
    const [content, setContent] = useState('');
    const [files, setFiles] = useState([]);
    const [saving, setSaving] = useState(false);
    const pid = task?.projectId || task?.project?.id;

    useEffect(() => {
        if (open) {
            setContent('');
            setFiles([]);
        }
    }, [open, task?.id]);

    const submit = async (e) => {
        e.preventDefault();
        const text = content.trim();
        if (!text || !pid) return;
        setSaving(true);
        try {
            await api.post('/notes', {
                projectId: pid,
                taskId: task.id,
                content: text,
                fileIds: files.map((f) => f.id),
            });
            toast.success('Note saved');
            onClose();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save note');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Leave a note</DialogTitle>
                    {task && (
                        <DialogDescription>
                            Pinned to:{' '}
                            <strong className="text-foreground">{task.title}</strong>
                        </DialogDescription>
                    )}
                </DialogHeader>
                <form onSubmit={submit} className="space-y-3">
                    <Textarea
                        rows={4}
                        autoFocus
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="What's on your mind? Visible on the project's Notes tab."
                        disabled={saving}
                    />
                    {pid && (
                        <NoteAttachmentsField
                            projectId={pid}
                            files={files}
                            onChange={setFiles}
                            disabled={saving}
                        />
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving || !content.trim()}>
                            {saving ? 'Saving…' : 'Add note'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
