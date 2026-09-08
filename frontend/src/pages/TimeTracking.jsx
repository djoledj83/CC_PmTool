// /time — standalone time tracking page.
//
// Purpose: organising MANUAL entries with a quick-pick duration (30
// minute granularity). The live start/stop timer lives elsewhere
// (top-bar pill + per-project card). This page is the place to log
// after-the-fact work and to review / edit / delete what you logged.
//
// Layout:
//   - Header strip with three at-a-glance totals (today, this week,
//     this month) — all your own time across every project.
//   - "Add time" panel with a tight horizontal form:
//       project · task (optional) · date · duration step · note · Add
//     Date defaults to today, duration defaults to 1h, note is free
//     text. Hitting "Add" posts a manual entry whose startedAt /
//     endedAt are derived from the chosen date + duration so the
//     existing /api/time endpoint accepts it unchanged.
//   - List of entries grouped by date, newest first. Each row has
//     an inline edit dialog and a delete button.
//
// Anyone can use this page; you only ever see your own entries here.
// Project totals + other people's entries continue to live on each
// project's Time tracking card.

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from 'react';
import { Link } from 'react-router-dom';
import { format, isToday, isYesterday } from 'date-fns';
import {
    ArrowRight,
    BarChart3,
    Building2,
    Calendar,
    CalendarX,
    ChevronDown,
    Clock,
    Download,
    ExternalLink,
    FolderKanban,
    AppWindow,
    History,
    Loader2,
    Pencil,
    Plus,
    RefreshCw,
    Timer,
    Trash2,
    Users as UsersIcon,
    User as UserIcon,
    Wrench,
    X,
} from 'lucide-react';
import { toast } from 'sonner';

import { TopBar } from '@/components/TopBar';
import {
    Pagination,
    PageSizeControl,
    usePagination,
} from '@/components/Pagination';
import {
    Avatar,
    AvatarFallback,
    AvatarImage,
} from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import TasksMultiSelect from '@/components/TasksMultiSelect';
import { SearchableSelect } from '@/components/SearchableSelect';
import { MultiSelectDropdown } from '@/components/MultiSelectDropdown';
import { Tip } from '@/components/Tip';
import { useActiveTimer } from '@/contexts/ActiveTimerContext';
import { useAuth } from '@/contexts/AuthContext';
import { CAPABILITIES, hasCapability } from '@/lib/capabilities';
import { api } from '@/lib/api';
import CrossUserReasonFields from '@/components/CrossUserReasonFields';
import { isOthersTask, assigneeLabel } from '@/lib/timeReason';
import TimeExportDialog from '@/components/TimeExportDialog';
import TimeExportHistoryDialog from '@/components/TimeExportHistoryDialog';
import { formatDuration } from '@/lib/time';
import { cn, formatApiError, resolveAssetUrl } from '@/lib/utils';

const NO_TASK = '__no_task__';

function entryTaskId(entry) {
    const id = entry?.taskId || entry?.task?.id;
    return id ? String(id) : NO_TASK;
}

function normalizeTaskPickerId(value) {
    if (!value || value === NO_TASK) return NO_TASK;
    return String(value);
}

// 30-minute step duration options up to 8 hours, then a few coarser
// values for the occasional long block. Keeping the list short keeps
// the picker scannable.
const DURATION_STEPS = (() => {
    const out = [];
    // 30m → 8h in 30m increments.
    for (let mins = 30; mins <= 8 * 60; mins += 30) {
        out.push(mins);
    }
    // Occasional longer blocks.
    out.push(9 * 60, 10 * 60, 12 * 60);
    return out;
})();

function durationLabel(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

function todayInputValue() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Compose ISO start / end for an entry on a given date with a duration
// in minutes. We anchor the entry around 12:00 local on that date so
// the row sits naturally in the day's middle. For "today", we end the
// block "now" so the entry feels like real-time work the user just
// finished.
function deriveStartEnd(dateString, durationMinutes) {
    const [y, m, d] = dateString.split('-').map((s) => parseInt(s, 10));
    if (!y || !m || !d) {
        throw new Error('Invalid date');
    }
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
        // Anchor at 12:00 so the entry sits mid-day; the exact clock
        // time isn't meaningful for after-the-fact tracking.
        endedAt = new Date(baseDate);
        endedAt.setHours(12, 0, 0, 0);
    }
    const startedAt = new Date(endedAt.getTime() - durationMinutes * 60 * 1000);
    return { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() };
}

function dayHeaderLabel(d) {
    // Accept ISO timestamps (from entries) *and* bare 'YYYY-MM-DD'
    // local date strings (from the day filter / picker). The latter
    // would parse as UTC midnight otherwise, which can roll back to
    // the previous local day in negative UTC offsets.
    if (d == null || d === '') return '—';
    const date =
        typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
            ? (() => {
                  const [y, m, dd] = d.split('-').map((n) => parseInt(n, 10));
                  return new Date(y, m - 1, dd);
              })()
            : new Date(d);
    if (Number.isNaN(date.getTime())) return '—';
    if (isToday(date)) return 'Today';
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'EEEE, MMM d');
}

function dayKey(d) {
    const date = new Date(d);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
        2,
        '0',
    )}-${String(date.getDate()).padStart(2, '0')}`;
}

export default function TimeTracking() {
    const { user } = useAuth();
    // "All users" + cross-user charts are admin features by default,
    // but admins can delegate them per-user via the `time:view:all`
    // capability override. The backend already short-circuits that
    // case for /api/time/all — we mirror the gate here so granting
    // the cap actually surfaces the tab + the user picker on the
    // Charts view. Without this the checkbox was effectively
    // ornamental.
    const canViewAllTime =
        user?.role === 'ADMIN' ||
        hasCapability(user, CAPABILITIES.TIME_VIEW_ALL);
    const isStrictAdmin = user?.role === 'ADMIN';
    // Auto-jump to the "All users" tab when the URL has a
    // `?userId=…` query param — that's the deep-link the admin
    // Users page emits for read-only "view as" navigation. Falls
    // back to "My time" for every other entry point.
    const initialTab =
        typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('userId')
            ? 'all'
            : 'mine';
    const [tab, setTab] = useState(initialTab);

    // Every tab now uses the same wide layout — no centred reading
    // column. Charts and the All Users spreadsheet need the room and
    // the My time list looks fine wide too.
    return (
        <>
            <TopBar title="Time tracking" actions={null} />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="flex w-full flex-col gap-4">
                    <div className="rounded-lg border bg-card p-1 shadow-sm">
                        <div className="flex flex-wrap gap-1">
                            <PageTab
                                icon={UserIcon}
                                label="My time"
                                active={tab === 'mine'}
                                onClick={() => setTab('mine')}
                            />
                            <PageTab
                                icon={BarChart3}
                                label="Charts"
                                active={tab === 'charts'}
                                onClick={() => setTab('charts')}
                            />
                            {canViewAllTime && (
                                <PageTab
                                    icon={UsersIcon}
                                    label="All users"
                                    active={tab === 'all'}
                                    onClick={() => setTab('all')}
                                />
                            )}
                            {canViewAllTime && (
                                <PageTab
                                    icon={CalendarX}
                                    label="Timesheet gaps"
                                    active={tab === 'gaps'}
                                    onClick={() => setTab('gaps')}
                                />
                            )}
                        </div>
                    </div>
                    {tab === 'gaps' && canViewAllTime ? (
                        <GapsView isStrictAdmin={isStrictAdmin} />
                    ) : tab === 'all' && canViewAllTime ? (
                        <AllUsersView isStrictAdmin={isStrictAdmin} />
                    ) : tab === 'charts' ? (
                        <ChartsView
                            isAdmin={canViewAllTime}
                            isStrictAdmin={isStrictAdmin}
                        />
                    ) : (
                        <MineView />
                    )}
                </div>
            </main>
        </>
    );
}

function PageTab({ icon: Icon, label, active, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
        >
            {Icon && <Icon className="h-4 w-4" />}
            {label}
        </button>
    );
}

// Compact "Export to CSV" button shared by both tabs. Forwards the
// current filter set to /api/exports/time/csv; the backend mirrors the
// /api/time scope (admin gets all users + projects, non-admin gets
// their own only) and writes the CSV to the response.
function ExportTimeButton({ params = {}, disabled = false, filenameFallback = 'time.csv' }) {
    // Opens the field-picker dialog (choose columns + order), which does
    // the actual download. A secondary "History" button opens the list of
    // past exports for re-download.
    const [open, setOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    return (
        <>
            <div className="inline-flex items-center overflow-hidden rounded-md border">
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 rounded-none text-xs"
                    onClick={() => setOpen(true)}
                    disabled={disabled}
                    title={
                        disabled
                            ? 'No entries match the current filters'
                            : 'Export to CSV'
                    }
                >
                    <Download className="h-3.5 w-3.5" />
                    Export to CSV
                </Button>
                <button
                    type="button"
                    onClick={() => setHistoryOpen(true)}
                    title="Export history"
                    aria-label="Export history"
                    className="flex h-7 items-center border-l px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                    <History className="h-3.5 w-3.5" />
                </button>
            </div>
            <TimeExportDialog
                open={open}
                onOpenChange={setOpen}
                params={params}
                filenameFallback={filenameFallback}
            />
            <TimeExportHistoryDialog
                open={historyOpen}
                onOpenChange={setHistoryOpen}
            />
        </>
    );
}

// "Diagnose my time" debug button. Hits /api/time/diagnostics and
// renders the results in a dialog. Surfaces issues like overlapping
// entries, zero-duration manual rows, very-long blocks, and orphan
// entries with no project — handy for both users (who occasionally
// want to know why their totals look off) and support (who can use
// it without opening the network tab).
function TimeDiagnosticsButton({ targetUserId = null }) {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState(null);

    const run = async () => {
        setLoading(true);
        setData(null);
        try {
            const { data: payload } = await api.get('/time/diagnostics', {
                params: targetUserId ? { userId: targetUserId } : undefined,
            });
            setData(payload);
            setOpen(true);
        } catch (err) {
            toast.error(
                err?.response?.data?.message ||
                    'Could not run diagnostics',
            );
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={run}
                disabled={loading}
                title="Run sanity checks on your time entries"
            >
                {loading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                    <Wrench className="h-3.5 w-3.5" />
                )}
                Diagnose
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Wrench className="h-4 w-4 text-rose-500" />
                            Time tracking diagnostics
                        </DialogTitle>
                        <DialogDescription>
                            Read-only sanity checks. Nothing is modified
                            — fixes need to happen via the entry list.
                        </DialogDescription>
                    </DialogHeader>
                    {data && (
                        <div className="space-y-3 text-sm">
                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                                <DiagStat
                                    label="Entries"
                                    value={data.totalEntries}
                                />
                                <DiagStat
                                    label="Total hours"
                                    value={`${data.totalHours}h`}
                                />
                                <DiagStat
                                    label="Running"
                                    value={data.runningCount}
                                    tone={
                                        data.runningCount > 0
                                            ? 'text-amber-600'
                                            : 'text-emerald-600'
                                    }
                                />
                                <DiagStat
                                    label="Issues"
                                    value={data.issues.length}
                                    tone={
                                        data.issues.length > 0
                                            ? 'text-rose-600'
                                            : 'text-emerald-600'
                                    }
                                />
                            </div>
                            {data.issues.length > 0 && (
                                <div className="rounded border border-rose-200 bg-rose-50/50 p-2 text-xs dark:border-rose-900/40 dark:bg-rose-900/10">
                                    <p className="mb-1 font-semibold text-rose-700 dark:text-rose-300">
                                        Issues
                                    </p>
                                    <ul className="ml-4 list-disc space-y-1 text-rose-700 dark:text-rose-300">
                                        {data.issues.slice(0, 20).map(
                                            (it, idx) => (
                                                <li key={`${it.id}-${idx}`}>
                                                    <span className="font-mono text-[10px]">
                                                        {it.kind}
                                                    </span>{' '}
                                                    — {it.message}
                                                </li>
                                            ),
                                        )}
                                        {data.issues.length > 20 && (
                                            <li>
                                                +{data.issues.length - 20}{' '}
                                                more
                                            </li>
                                        )}
                                    </ul>
                                </div>
                            )}
                            <div className="rounded border bg-muted/30 p-2">
                                <p className="mb-1 text-xs font-semibold">
                                    Per-month bucket
                                </p>
                                <table className="w-full text-[11px]">
                                    <thead className="text-muted-foreground">
                                        <tr>
                                            <th className="text-left">
                                                Month
                                            </th>
                                            <th className="text-right">
                                                Hours
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.byMonth.map((b) => (
                                            <tr key={b.month}>
                                                <td>{b.month}</td>
                                                <td className="text-right font-mono tabular-nums">
                                                    {b.hours}h
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                                Earliest:{' '}
                                {data.earliestStartedAt || '—'} · Latest:{' '}
                                {data.latestEndedAt || '—'}
                            </p>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}

function DiagStat({ label, value, tone }) {
    return (
        <div className="rounded border bg-card p-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {label}
            </p>
            <p
                className={cn(
                    'text-base font-semibold tabular-nums',
                    tone || 'text-foreground',
                )}
            >
                {value}
            </p>
        </div>
    );
}

function MineView() {
    const { revision, notifyChanged } = useActiveTimer();
    const { user: currentUser } = useAuth();
    // Regular users may only log time on tasks assigned to them — the
    // server enforces this on POST /time, here we filter the picker so
    // they never even see a task they couldn't save against. Admins and
    // managers (already trusted with the project) see the full list,
    // and so does anyone who owns the project (covers personal projects
    // where the owner may not be the assignee of every task).
    const elevated =
        currentUser?.role === 'ADMIN' || currentUser?.role === 'MANAGER';
    const [projects, setProjects] = useState([]);
    const [tasksByProject, setTasksByProject] = useState({});
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(false);
    const [editing, setEditing] = useState(null);

    // Quick-add form state.
    const [projectId, setProjectId] = useState('');
    const [taskId, setTaskId] = useState(NO_TASK);
    const [dateValue, setDateValue] = useState(() => todayInputValue());
    const [durationMinutes, setDurationMinutes] = useState(60);
    const [description, setDescription] = useState('');
    const [crossReason, setCrossReason] = useState('');
    const [crossNote, setCrossNote] = useState('');
    const [submitting, setSubmitting] = useState(false);

    // The selected task (full object, for the assignee check) — elevated
    // callers can pick tasks assigned to other people, which requires a
    // reason. Unassigned / project-level entries never do.
    const selectedTask = useMemo(() => {
        if (taskId === NO_TASK) return null;
        return (tasksByProject[projectId] || []).find((t) => t.id === taskId) || null;
    }, [taskId, projectId, tasksByProject]);
    const othersTask = useMemo(
        () => isOthersTask(selectedTask, currentUser?.id),
        [selectedTask, currentUser?.id],
    );
    // Clear a stale reason whenever the picked task / project changes.
    useEffect(() => {
        setCrossReason('');
        setCrossNote('');
    }, [taskId, projectId]);

    // Initial load: every project the caller can see, plus their
    // entire entry history (capped server-side at 200, sorted newest
    // first). For most users that's many months of data.
    useEffect(() => {
        let cancelled = false;
        api.get('/projects')
            .then((res) => {
                if (cancelled) return;
                setProjects(res.data?.projects || []);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);

    const loadEntries = useCallback(async () => {
        setLoading(true);
        try {
            const { data } = await api.get('/time/me', {
                params: { limit: 200 },
            });
            setEntries(data?.entries || []);
        } catch (err) {
            console.warn(
                '[time-page] could not load entries:',
                err?.message,
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadEntries();
    }, [loadEntries, revision]);

    // Lazy-load tasks the first time a project is selected. We cache
    // by projectId so switching back to a previously-picked project
    // doesn't refetch.
    useEffect(() => {
        if (!projectId) {
            setTaskId(NO_TASK);
            return undefined;
        }
        if (tasksByProject[projectId]) {
            setTaskId(NO_TASK);
            return undefined;
        }
        let cancelled = false;
        api.get('/tasks', { params: { projectId } })
            .then((res) => {
                if (cancelled) return;
                setTasksByProject((prev) => ({
                    ...prev,
                    [projectId]: res.data?.tasks || [],
                }));
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [projectId, tasksByProject]);

    const taskOptions = useMemo(() => {
        const tasks = tasksByProject[projectId] || [];
        const project = projects.find((p) => p.id === projectId);
        const isOwner =
            project?.ownerId && project.ownerId === currentUser?.id;
        const seeAll = elevated || isOwner;
        // A finished task (DONE) is still selectable — you sometimes log
        // time against something you just closed — but we flag it so the
        // picker can show it dimmed with a "Done" tag.
        const isClosed = (t) => t?.status === 'DONE';

        const tasksById = new Map(tasks.map((t) => [t.id, t]));
        const childrenByParent = new Map();
        for (const t of tasks) {
            if (!t.parentTaskId) continue;
            if (!childrenByParent.has(t.parentTaskId)) {
                childrenByParent.set(t.parentTaskId, []);
            }
            childrenByParent.get(t.parentTaskId).push(t);
        }

        const out = [];
        if (seeAll) {
            // Elevated callers see the original nested layout.
            for (const top of tasks.filter((t) => !t.parentTaskId)) {
                out.push({
                    id: top.id,
                    label: top.title,
                    code: top.code,
                    closed: isClosed(top),
                });
                for (const c of childrenByParent.get(top.id) || []) {
                    out.push({
                        id: c.id,
                        label: `\u21B3 ${c.title}`,
                        code: c.code,
                        closed: isClosed(c),
                    });
                }
            }
            return out;
        }

        // Non-elevated: show only tasks assigned to the user. For an
        // orphaned subtask (parent isn't theirs) inline the parent
        // title so the row still reads as "Parent \u2192 Subtask" instead
        // of a dangling arrow that means nothing.
        const mine = tasks.filter((t) => t.assigneeId === currentUser?.id);
        for (const t of mine) {
            if (!t.parentTaskId) {
                out.push({
                    id: t.id,
                    label: t.title,
                    code: t.code,
                    closed: isClosed(t),
                });
                for (const c of childrenByParent.get(t.id) || []) {
                    if (c.assigneeId !== currentUser?.id) continue;
                    out.push({
                        id: c.id,
                        label: `\u21B3 ${c.title}`,
                        code: c.code,
                        closed: isClosed(c),
                    });
                }
            } else {
                const parent = tasksById.get(t.parentTaskId);
                if (parent && parent.assigneeId === currentUser?.id) {
                    // Already emitted via the parent loop above — skip.
                    continue;
                }
                const parentLabel = parent?.title || 'Task';
                out.push({
                    id: t.id,
                    label: `${parentLabel} \u2192 ${t.title}`,
                    code: t.code,
                    closed: isClosed(t),
                });
            }
        }
        return out;
    }, [projectId, tasksByProject, projects, currentUser?.id, elevated]);

    // -----------------------------------------------------------------
    // Totals: today / this week / this month, all from your own entries
    // We compute client-side from the loaded entry list (cheap; one
    // pass) so we don't need three extra API calls.
    // -----------------------------------------------------------------
    const totals = useMemo(() => {
        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const weekStart = (() => {
            const d = new Date(todayStart);
            const dow = d.getDay();
            const diff = (dow + 6) % 7; // Monday-anchored ISO week
            d.setDate(d.getDate() - diff);
            return d;
        })();
        const monthStart = new Date(
            now.getFullYear(),
            now.getMonth(),
            1,
        );
        let today = 0;
        let week = 0;
        let month = 0;
        for (const e of entries) {
            const start = new Date(e.startedAt);
            const seconds = e.durationSeconds || 0;
            if (start >= monthStart) month += seconds;
            if (start >= weekStart) week += seconds;
            if (start >= todayStart) today += seconds;
        }
        return { today, week, month };
    }, [entries]);

    // -----------------------------------------------------------------
    // Daily chart state. Two controls:
    //   - rangeMode: '7' / '15' / '30' presets, or 'custom' which
    //     unlocks the from/to date inputs.
    //   - chartProjectId: optional single-project filter, dropdown
    //     populated from the projects the user has actually logged on.
    // We keep custom range strings (YYYY-MM-DD) in state so the
    // <input type="date"> controls stay simple and the calendar math
    // never touches Date arithmetic across DST boundaries.
    // -----------------------------------------------------------------
    const [chartProjectId, setChartProjectId] = useState('__all__');
    const [rangeMode, setRangeMode] = useState('15');
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState(todayInputValue);

    // Day filter for the entries list. Either '' (no filter) or a
    // 'YYYY-MM-DD' local date string. Clicking a bar toggles it; the
    // <input type="date"> in the entries header sets it explicitly.
    // We use the SAME key format as `dayKey()` so the existing
    // grouped/filter logic can compare strings directly.
    const [dayFilter, setDayFilter] = useState('');
    const toggleDayFilter = useCallback((key) => {
        setDayFilter((current) => {
            const next = current === key ? '' : key;
            // Selecting a day also prefills the Log-time form's Date
            // (next to project / task / duration) so a new entry
            // defaults to the day you just clicked.
            if (next) setDateValue(next);
            return next;
        });
    }, []);

    const chartProjectOptions = useMemo(() => {
        const totals = new Map();
        const names = new Map();
        for (const e of entries) {
            const pid = e.project?.id;
            if (!pid) continue;
            totals.set(pid, (totals.get(pid) || 0) + (e.durationSeconds || 0));
            if (!names.has(pid)) {
                names.set(pid, e.project?.name || 'Unknown project');
            }
        }
        return Array.from(totals.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([id, sec]) => ({
                id,
                name: names.get(id) || 'Unknown project',
                seconds: sec,
            }));
    }, [entries]);

    const myDailyChart = useMemo(() => {
        // Resolve the window. For presets we always anchor at "today"
        // and walk back N-1 days. For custom we honour the from/to
        // inputs; if either is missing or invalid we fall back to a
        // 15-day window so the chart never goes blank.
        const dayKeyOf = (d) =>
            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const parseInput = (s) => {
            if (!s || typeof s !== 'string') return null;
            const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
            if (!y || !m || !d) return null;
            return new Date(y, m - 1, d);
        };

        let startDate;
        let endDate;
        if (rangeMode === 'custom') {
            const fromDate = parseInput(customFrom);
            const toDate = parseInput(customTo);
            if (fromDate && toDate && fromDate <= toDate) {
                startDate = fromDate;
                endDate = toDate;
            }
        }
        if (!startDate || !endDate) {
            const now = new Date();
            endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const presetDays = rangeMode === 'custom' ? 15 : parseInt(rangeMode, 10) || 15;
            startDate = new Date(endDate);
            startDate.setDate(endDate.getDate() - (presetDays - 1));
        }

        // Hard cap so a wild custom range can't blow up the DOM.
        const dayCount = Math.min(
            120,
            Math.round((endDate - startDate) / (24 * 60 * 60 * 1000)) + 1,
        );

        const today = new Date();
        const todayKey = dayKeyOf(today);

        const days = [];
        const indexByKey = new Map();
        for (let i = 0; i < dayCount; i += 1) {
            // Reconstruct each day from year/month/day, avoiding any
            // 24h arithmetic that could trip on DST.
            const d = new Date(
                startDate.getFullYear(),
                startDate.getMonth(),
                startDate.getDate() + i,
            );
            const key = dayKeyOf(d);
            days.push({
                key,
                date: d,
                seconds: 0,
                isToday: key === todayKey,
            });
            indexByKey.set(key, days.length - 1);
        }

        for (const e of entries) {
            if (
                chartProjectId !== '__all__' &&
                e.project?.id !== chartProjectId
            ) {
                continue;
            }
            const dt = new Date(e.startedAt);
            const key = dayKeyOf(dt);
            const idx = indexByKey.get(key);
            if (idx === undefined) continue;
            days[idx].seconds += e.durationSeconds || 0;
        }

        const overtimeDays = days.filter(
            (d) => d.seconds > WORKDAY_SECONDS,
        ).length;
        const activeDays = days.filter((d) => d.seconds > 0).length;
        const totalSeconds = days.reduce((s, d) => s + d.seconds, 0);
        const maxSeconds = days.reduce(
            (m, d) => (d.seconds > m ? d.seconds : m),
            0,
        );

        // Y axis ceiling: keep the 8h reference line clearly inside
        // the chart, never pinned to the top. Minimum 10h, growing
        // in 2h steps once a real day exceeds 10h.
        let yMaxHours = 10;
        const maxHours = maxSeconds / 3600;
        if (maxHours > yMaxHours) {
            yMaxHours = Math.ceil(maxHours / 2) * 2;
        }
        const yMaxSeconds = yMaxHours * 3600;

        return {
            days,
            overtimeDays,
            activeDays,
            totalSeconds,
            maxSeconds,
            yMaxHours,
            yMaxSeconds,
            hasAny: totalSeconds > 0,
            windowLabel:
                rangeMode === 'custom'
                    ? `${format(startDate, 'd MMM')} → ${format(endDate, 'd MMM')}`
                    : `Last ${dayCount} days`,
        };
    }, [entries, chartProjectId, rangeMode, customFrom, customTo]);

    // Group entries by day so the list reads like a journal. Newest
    // day first; entries inside a day stay newest-first as well. When
    // `dayFilter` is set, we keep only that single day so the user
    // can drill in by clicking a chart bar or picking a date.
    // Flat, newest-first list honouring the optional day filter. Paginated
    // (20/50/100); the current page is then grouped by day for display.
    const filteredEntries = useMemo(() => {
        const list = (
            dayFilter
                ? entries.filter((e) => dayKey(e.startedAt) === dayFilter)
                : entries
        ).slice();
        list.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
        return list;
    }, [entries, dayFilter]);

    const { page, setPage, pageSize, setPageSize, total, totalPages, pageItems } =
        usePagination(filteredEntries, 20);

    const grouped = useMemo(() => {
        const map = new Map();
        for (const e of pageItems) {
            const k = dayKey(e.startedAt);
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(e);
        }
        return Array.from(map.entries()).sort(([a], [b]) =>
            a < b ? 1 : -1,
        );
    }, [pageItems]);

    const filteredCount = filteredEntries.length;

    // Charts panel is collapsible on the My time tab.
    const [chartOpen, setChartOpen] = useState(true);

    const handleAdd = async (e) => {
        e.preventDefault();
        if (!projectId) {
            toast.error('Pick a project');
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
        setSubmitting(true);
        try {
            await api.post('/time', {
                projectId,
                taskId: taskId !== NO_TASK ? taskId : undefined,
                startedAt: scope.startedAt,
                endedAt: scope.endedAt,
                description: description.trim() || undefined,
                crossUserReason: othersTask ? crossReason : undefined,
                crossUserNote:
                    othersTask && crossNote.trim()
                        ? crossNote.trim()
                        : undefined,
            });
            toast.success('Time entry added');
            setDescription('');
            setCrossReason('');
            setCrossNote('');
            // Keep project / task / duration so quick repeated logging
            // (e.g. "I did 1h on this all morning") feels effortless.
            notifyChanged();
            loadEntries();
        } catch (err) {
            toast.error(formatApiError(err, 'Could not add entry'));
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (entryId) => {
        if (!window.confirm('Delete this time entry?')) return;
        try {
            await api.delete(`/time/${entryId}`);
            toast.success('Time entry deleted');
            notifyChanged();
            loadEntries();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not delete entry',
            );
        }
    };

    return (
        <>
            {/* --- Totals strip ----------------------------------- */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <SummaryStat
                    label="Today"
                    seconds={totals.today}
                    icon={Calendar}
                    primary
                />
                <SummaryStat
                    label="This week"
                    seconds={totals.week}
                    icon={Clock}
                />
                <SummaryStat
                    label="This month"
                    seconds={totals.month}
                    icon={Timer}
                />
            </div>

            {/* --- Daily overview chart (collapsible) ------------- */}
            <MyDailyChart
                chart={myDailyChart}
                projectId={chartProjectId}
                onProjectChange={setChartProjectId}
                projects={chartProjectOptions}
                rangeMode={rangeMode}
                onRangeModeChange={setRangeMode}
                customFrom={customFrom}
                onCustomFromChange={setCustomFrom}
                customTo={customTo}
                onCustomToChange={setCustomTo}
                selectedDay={dayFilter}
                onDayClick={toggleDayFilter}
                open={chartOpen}
                onToggle={() => setChartOpen((o) => !o)}
            />

            {/* --- Add manual entry ------------------------------ */}
            <form
                onSubmit={handleAdd}
                className="rounded-lg border bg-card p-3 shadow-sm sm:p-4"
            >
                <div className="mb-3 border-b pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Log time
                </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
                            <div className="space-y-1.5 lg:col-span-2">
                                <Label className="text-xs">Project</Label>
                                <SearchableSelect
                                    value={projectId}
                                    onChange={setProjectId}
                                    placeholder="Pick a project"
                                    searchPlaceholder="Search projects…"
                                    className="h-9"
                                    options={projects.map((p) => ({
                                        value: p.id,
                                        label:
                                            (p.code ? `${p.code} · ` : '') +
                                            p.name,
                                    }))}
                                />
                            </div>
                            <div className="space-y-1.5 lg:col-span-2">
                                <Label className="text-xs">
                                    Task (optional)
                                </Label>
                                <SearchableSelect
                                    value={taskId}
                                    onChange={setTaskId}
                                    disabled={!projectId}
                                    placeholder={
                                        !projectId
                                            ? 'Pick a project first'
                                            : 'Project-level time'
                                    }
                                    searchPlaceholder="Search tasks…"
                                    className="h-9"
                                    options={[
                                        {
                                            value: NO_TASK,
                                            label: '— Project-level time —',
                                        },
                                        ...taskOptions.map((opt) => ({
                                            value: opt.id,
                                            label:
                                                (opt.code
                                                    ? `${opt.code} · `
                                                    : '') +
                                                opt.label +
                                                (opt.closed ? ' · Done' : ''),
                                        })),
                                    ]}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs">Date</Label>
                                <Input
                                    type="date"
                                    value={dateValue}
                                    onChange={(e) =>
                                        setDateValue(e.target.value)
                                    }
                                    max={todayInputValue()}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs">Duration</Label>
                                <Select
                                    value={String(durationMinutes)}
                                    onValueChange={(v) =>
                                        setDurationMinutes(parseInt(v, 10))
                                    }
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent className="max-h-72">
                                        {DURATION_STEPS.map((mins) => (
                                            <SelectItem
                                                key={mins}
                                                value={String(mins)}
                                            >
                                                {durationLabel(mins)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                        {othersTask && (
                            <div className="mt-3">
                                <CrossUserReasonFields
                                    assigneeName={assigneeLabel(selectedTask)}
                                    reason={crossReason}
                                    onReasonChange={setCrossReason}
                                    note={crossNote}
                                    onNoteChange={setCrossNote}
                                    disabled={submitting}
                                    idPrefix="tt"
                                />
                            </div>
                        )}
                        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                            <div className="space-y-1.5">
                                <Label className="text-xs">
                                    Note (optional)
                                </Label>
                                <Input
                                    value={description}
                                    onChange={(e) =>
                                        setDescription(e.target.value)
                                    }
                                    placeholder="What did you work on?"
                                />
                            </div>
                            <Button
                                type="submit"
                                disabled={!projectId || submitting}
                                className="gap-2 sm:self-end"
                            >
                                {submitting ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Plus className="h-4 w-4" />
                                )}
                                Add entry
                            </Button>
                        </div>
                    </form>

            {/* --- Entry list ----------------------------------- */}
            <section className="rounded-lg border bg-card shadow-sm">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-sm font-semibold sm:px-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <span>Your entries</span>
                        {loading && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        )}
                        {dayFilter && (
                            <button
                                type="button"
                                onClick={() => setDayFilter('')}
                                className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20"
                                title="Clear day filter"
                            >
                                <Calendar className="h-3 w-3" />
                                {dayHeaderLabel(dayFilter)}
                                <span className="text-base leading-none">
                                    ×
                                </span>
                            </button>
                        )}
                        {!dayFilter && entries.length > 0 && (
                            <span className="text-[11px] font-normal text-muted-foreground">
                                {entries.length} entr
                                {entries.length === 1 ? 'y' : 'ies'}
                            </span>
                        )}
                        {dayFilter && (
                            <span className="text-[11px] font-normal text-muted-foreground">
                                {filteredCount} of {entries.length}
                            </span>
                        )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {total > 0 && (
                            <PageSizeControl
                                pageSize={pageSize}
                                onPageSizeChange={setPageSize}
                                options={[20, 50, 100]}
                            />
                        )}
                        <Label
                            htmlFor="entries-day-filter"
                            className="text-[11px] font-normal text-muted-foreground"
                        >
                            Day
                        </Label>
                        <Input
                            id="entries-day-filter"
                            type="date"
                            value={dayFilter}
                            max={todayInputValue()}
                            onChange={(e) => setDayFilter(e.target.value)}
                            className="h-7 w-[140px] text-xs"
                        />
                        <ExportTimeButton
                            disabled={entries.length === 0}
                            filenameFallback="my-time.csv"
                        />
                        <TimeDiagnosticsButton />
                    </div>
                </header>
                {entries.length === 0 && !loading ? (
                    <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                        No time entries yet. Use the form above to log
                        some time, or start a live timer from any
                        project.
                    </div>
                ) : dayFilter && grouped.length === 0 ? (
                    <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                        No entries logged on{' '}
                        <strong>{dayHeaderLabel(dayFilter)}</strong>.
                        {' '}
                        <button
                            type="button"
                            onClick={() => setDayFilter('')}
                            className="font-medium text-primary hover:underline"
                        >
                            Clear filter
                        </button>{' '}
                        to see everything.
                    </div>
                ) : (
                    <div className="divide-y">
                        {grouped.map(([day, rows]) => {
                            const daySeconds = rows.reduce(
                                (s, r) => s + (r.durationSeconds || 0),
                                0,
                            );
                            return (
                                <div key={day}>
                                    <div className="flex items-center justify-between px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:px-4">
                                        <span>{dayHeaderLabel(day)}</span>
                                        <span className="font-mono text-muted-foreground">
                                            {formatDuration(daySeconds)}
                                        </span>
                                    </div>
                                    <ul className="divide-y">
                                        {rows.map((row) => (
                                            <EntryRow
                                                key={row.id}
                                                entry={row}
                                                onEdit={() =>
                                                    setEditing(row)
                                                }
                                                onDelete={() =>
                                                    handleDelete(row.id)
                                                }
                                            />
                                        ))}
                                    </ul>
                                </div>
                            );
                        })}
                    </div>
                )}
                {total > 0 && (
                    <Pagination
                        page={page}
                        pageSize={pageSize}
                        total={total}
                        totalPages={totalPages}
                        onPageChange={setPage}
                        onPageSizeChange={setPageSize}
                        pageSizeOptions={[20, 50, 100]}
                    />
                )}
            </section>

            <EditEntryDialog
                key={editing?.id || 'none'}
                open={Boolean(editing)}
                onOpenChange={(open) => {
                    if (!open) setEditing(null);
                }}
                entry={editing}
                projects={projects}
                tasksByProject={tasksByProject}
                onTasksLoaded={(pid, tasks) =>
                    setTasksByProject((prev) => ({ ...prev, [pid]: tasks }))
                }
                onSaved={() => {
                    setEditing(null);
                    notifyChanged();
                    loadEntries();
                }}
            />
        </>
    );
}

// MyDailyChart — "where did my hours go?" panel on the My time tab.
//
// The chart uses ABSOLUTE PIXEL heights instead of percentages so the
// bars can never silently collapse to zero when the flex parent's
// height is in flux. The plot area is a fixed CHART_PX tall; every
// bar gets `height: ${(seconds / yMaxSeconds) * CHART_PX}px`. Y axis
// labels share the same fixed height so they stay perfectly aligned
// with the grid lines and the 8h reference line.
//
// Colour grades (1 decimal hour):
//   < 8h        → blue   (under target)
//   = 8h        → green  (exact workday)
//   8.1h – 9h   → orange (up to one hour over)
//   > 9h        → red    (heavy overtime)
//
// Controls on the header:
//   * 7 / 15 / 30 day presets and a "Custom" mode with two date
//     pickers (from / to) for arbitrary ranges.
//   * Project filter to narrow the view when one project is eating
//     the week.
const CHART_PX = 224; // total bar plot height (matches old h-56)

function MyDailyChart({
    chart,
    projectId,
    onProjectChange,
    projects,
    rangeMode,
    onRangeModeChange,
    customFrom,
    onCustomFromChange,
    customTo,
    onCustomToChange,
    selectedDay,
    onDayClick,
    open = true,
    onToggle,
}) {
    const {
        days,
        overtimeDays,
        activeDays,
        totalSeconds,
        yMaxHours,
        yMaxSeconds,
        hasAny,
        windowLabel,
    } = chart;

    // 8h reference line: pixel offset from the TOP of the plot.
    const workdayTopPx =
        ((yMaxHours - WORKDAY_HOURS) / yMaxHours) * CHART_PX;
    const midHours = Math.round(yMaxHours / 2);

    // Label every bar with its day. (Previously thinned to every 2nd/3rd
    // for long windows; the user prefers a day under every bar.)
    const labelEvery = 1;

    const presetOptions = [
        { value: '7', label: '7 days' },
        { value: '15', label: '15 days' },
        { value: '30', label: '30 days' },
        { value: 'custom', label: 'Custom' },
    ];

    return (
        <section className="rounded-lg border bg-card shadow-sm">
            <header
                onClick={onToggle}
                className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-sm font-semibold sm:px-4 cursor-pointer select-none"
            >
                <div className="flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-muted-foreground" />
                    <span>{windowLabel}</span>
                    <ChevronDown
                        className={cn(
                            'h-4 w-4 text-muted-foreground transition-transform',
                            !open && '-rotate-90',
                        )}
                    />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-normal">
                    {overtimeDays > 0 ? (
                        <span
                            className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-50 px-2 py-0.5 font-medium text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300"
                            title={`${overtimeDays} day${overtimeDays === 1 ? '' : 's'} over the ${WORKDAY_HOURS}h workday`}
                        >
                            <Timer className="h-3 w-3" />
                            {overtimeDays} over {WORKDAY_HOURS}h
                        </span>
                    ) : activeDays > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300">
                            ✓ No overtime days
                        </span>
                    ) : null}
                    <span className="font-mono tabular-nums text-muted-foreground">
                        {formatDuration(totalSeconds)} total
                    </span>
                </div>
            </header>

            {open && (
            <div className="space-y-3 p-3 sm:p-4">
                {/* --- Controls row: range + project filter --- */}
                <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                    <div className="flex flex-col gap-1">
                        <Label className="text-[11px] text-muted-foreground">
                            Range
                        </Label>
                        <div className="inline-flex overflow-hidden rounded-md border">
                            {presetOptions.map((p) => (
                                <button
                                    key={p.value}
                                    type="button"
                                    onClick={() => onRangeModeChange(p.value)}
                                    className={cn(
                                        'px-2.5 py-1 text-xs font-medium transition-colors',
                                        rangeMode === p.value
                                            ? 'bg-primary text-primary-foreground'
                                            : 'bg-background text-muted-foreground hover:bg-muted',
                                    )}
                                >
                                    {p.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {rangeMode === 'custom' && (
                        <>
                            <div className="flex flex-col gap-1">
                                <Label
                                    htmlFor="mydaily-from"
                                    className="text-[11px] text-muted-foreground"
                                >
                                    From
                                </Label>
                                <Input
                                    id="mydaily-from"
                                    type="date"
                                    value={customFrom}
                                    max={customTo || todayInputValue()}
                                    onChange={(e) =>
                                        onCustomFromChange(e.target.value)
                                    }
                                    className="h-7 w-[140px] text-xs"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <Label
                                    htmlFor="mydaily-to"
                                    className="text-[11px] text-muted-foreground"
                                >
                                    To
                                </Label>
                                <Input
                                    id="mydaily-to"
                                    type="date"
                                    value={customTo}
                                    min={customFrom || undefined}
                                    max={todayInputValue()}
                                    onChange={(e) =>
                                        onCustomToChange(e.target.value)
                                    }
                                    className="h-7 w-[140px] text-xs"
                                />
                            </div>
                        </>
                    )}

                    <div className="flex flex-col gap-1">
                        <Label className="text-[11px] text-muted-foreground">
                            Project
                        </Label>
                        <div className="flex items-center gap-2">
                            <Select
                                value={projectId}
                                onValueChange={onProjectChange}
                            >
                                <SelectTrigger className="h-7 w-auto min-w-[160px] gap-2 text-xs">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="__all__">
                                        All projects
                                    </SelectItem>
                                    {projects.map((p) => (
                                        <SelectItem key={p.id} value={p.id}>
                                            {p.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {projectId !== '__all__' && (
                                <button
                                    type="button"
                                    onClick={() => onProjectChange('__all__')}
                                    className="rounded text-[11px] text-muted-foreground hover:text-foreground"
                                >
                                    clear
                                </button>
                            )}
                        </div>
                    </div>
                    <div className="ml-auto self-end pb-1">
                        <Tip variant="info" side="left">
                            <p className="font-medium">Reading the chart</p>
                            <p className="mt-1 text-muted-foreground">
                                The dashed line marks one workday
                                ({WORKDAY_HOURS}h). Bars below it are
                                blue; exactly {WORKDAY_HOURS}h is green;
                                up to {WORKDAY_HOURS + 1}h turns orange;
                                above {WORKDAY_HOURS + 1}h turns red.
                                Click any bar to filter the entries
                                list below to just that day, or use the
                                date picker in the entries header to
                                drill into any past day directly.
                            </p>
                        </Tip>
                    </div>
                </div>

                {!hasAny ? (
                    <div className="rounded border border-dashed bg-muted/20 px-3 py-8 text-center text-xs text-muted-foreground">
                        No time logged in this window
                        {projectId !== '__all__'
                            ? ' for this project'
                            : ''}
                        . Bars will appear here as you log entries —
                        the dashed {WORKDAY_HOURS}h line marks one
                        workday so days that punch through are easy
                        to spot.
                    </div>
                ) : (
                    <div className="flex">
                        {/* Y axis: pixel-aligned with the plot area
                            so labels point at the right grid line. */}
                        <div
                            className="relative mr-2 flex w-9 flex-col justify-between text-right text-[10px] text-muted-foreground"
                            style={{ height: `${CHART_PX}px` }}
                        >
                            <span className="-translate-y-1">
                                {yMaxHours}h
                            </span>
                            <span>{midHours}h</span>
                            <span className="translate-y-1">0h</span>
                        </div>

                        {/* Plot area — fixed pixel height so every
                            child can rely on it for absolute bar
                            sizing. */}
                        <div
                            className="relative flex-1"
                            style={{ height: `${CHART_PX}px` }}
                        >
                            {/* Horizontal grid: top + midline + base */}
                            <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-muted-foreground/15" />
                            <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-muted-foreground/15" />
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-muted-foreground/30" />

                            {/* 8h workday reference line */}
                            <div
                                className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-dashed border-emerald-400/70"
                                style={{ top: `${workdayTopPx}px` }}
                            >
                                <span className="absolute -top-3 right-0 rounded-sm bg-card/90 px-1 text-[10px] font-medium uppercase tracking-wide text-emerald-600">
                                    {WORKDAY_HOURS}h
                                </span>
                            </div>

                            {/* Bars — every day column gets the FULL
                                plot height (`absolute inset-y-0`) and
                                we place the bar at the BOTTOM with an
                                absolute pixel height. This sidesteps
                                any % vs auto-height tug-of-war that
                                CSS flex layout can create.

                                Each column is a <button> so clicking
                                a bar filters the entries list to that
                                day. Selected day gets a strong ring
                                and a subtle tinted background so the
                                user can see which bar is "active". */}
                            <div className="absolute inset-0 flex items-stretch gap-1.5">
                                {days.map((d) => {
                                    const hours = d.seconds / 3600;
                                    const barPx =
                                        d.seconds > 0
                                            ? Math.max(
                                                  Math.round(
                                                      (d.seconds /
                                                          yMaxSeconds) *
                                                          CHART_PX,
                                                  ),
                                                  4,
                                              )
                                            : 0;
                                    const grade = myDailyBarGrade(d.seconds);
                                    const tone = MY_DAILY_BAR_TONE[grade].bar;
                                    const isOvertime =
                                        grade === 'warn' || grade === 'heavy';
                                    const label = hours
                                        ? hours >= 1
                                            ? `${Math.round(hours * 10) / 10}h`
                                            : `${Math.round(d.seconds / 60)}m`
                                        : '';
                                    const isSelected =
                                        selectedDay && selectedDay === d.key;
                                    return (
                                        <button
                                            type="button"
                                            key={d.key}
                                            onClick={() =>
                                                onDayClick &&
                                                onDayClick(d.key)
                                            }
                                            className={cn(
                                                'group relative flex-1 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                                                isSelected
                                                    ? 'rounded-sm bg-primary/10 ring-2 ring-primary'
                                                    : d.isToday
                                                        ? 'rounded-sm ring-1 ring-primary/40'
                                                        : 'rounded-sm hover:bg-muted/40',
                                            )}
                                            title={`${format(d.date, 'EEE d MMM')} · ${formatDuration(d.seconds)}${isOvertime ? ` · ${Math.round((hours - WORKDAY_HOURS) * 10) / 10}h over ${WORKDAY_HOURS}h` : grade === 'target' ? ` · ${WORKDAY_HOURS}h workday` : ''} · click to ${isSelected ? 'clear filter' : 'filter entries'}`}
                                        >
                                            {d.seconds > 0 ? (
                                                <div
                                                    className={cn(
                                                        'pointer-events-none absolute inset-x-0 bottom-0 rounded-t-sm transition-colors',
                                                        tone,
                                                    )}
                                                    style={{
                                                        height: `${barPx}px`,
                                                    }}
                                                >
                                                    {barPx >= 28 && (
                                                        <span className="absolute inset-x-0 top-1 text-center text-[10px] font-semibold leading-none text-white drop-shadow-sm">
                                                            {label}
                                                        </span>
                                                    )}
                                                </div>
                                            ) : (
                                                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] rounded-sm bg-muted/40" />
                                            )}
                                            {d.seconds > 0 && barPx < 28 && (
                                                <span
                                                    className={cn(
                                                        'pointer-events-none absolute inset-x-0 text-center text-[10px] font-semibold leading-none',
                                                        MY_DAILY_BAR_TONE[grade].text,
                                                    )}
                                                    style={{
                                                        bottom: `${barPx + 3}px`,
                                                    }}
                                                >
                                                    {label}
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}

                {/* X axis: weekday + day-of-month. Label cadence
                    adapts to the window length so 30 days don't
                    collide. */}
                {hasAny && (
                    <div className="ml-11 flex gap-1.5">
                        {days.map((d, i) => {
                            const showLabel = i % labelEvery === 0;
                            return (
                                <div
                                    key={d.key}
                                    className="flex flex-1 flex-col items-center gap-0 leading-tight"
                                >
                                    {showLabel ? (
                                        <>
                                            <span className="text-[10px] uppercase text-muted-foreground">
                                                {format(d.date, 'EEEEE')}
                                            </span>
                                            <span
                                                className={cn(
                                                    'text-[10px] tabular-nums',
                                                    d.isToday
                                                        ? 'font-semibold text-primary'
                                                        : 'text-muted-foreground',
                                                )}
                                            >
                                                {format(d.date, 'd')}
                                            </span>
                                        </>
                                    ) : (
                                        <span className="text-[10px] text-transparent">
                                            ·
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Legend / explainer */}
                {hasAny && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                            <span className="h-2 w-3 rounded-sm bg-sky-500/85" />
                            &lt; {WORKDAY_HOURS}h
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <span className="h-2 w-3 rounded-sm bg-emerald-500/85" />
                            {WORKDAY_HOURS}h
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <span className="h-2 w-3 rounded-sm bg-orange-500/85" />
                            &gt; {WORKDAY_HOURS}h – {WORKDAY_HOURS + 1}h
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <span className="h-2 w-3 rounded-sm bg-rose-500/85" />
                            &gt; {WORKDAY_HOURS + 1}h
                        </span>
                        <span className="ml-auto">
                            Click a bar to filter the entries list to
                            that day.
                        </span>
                    </div>
                )}
            </div>
            )}
        </section>
    );
}

function SummaryStat({ label, seconds, icon: Icon, primary, rawValue }) {
    // `rawValue` lets the All Users view reuse this card for non-duration
    // metrics like entry counts. When set, we render it verbatim instead
    // of formatting `seconds`.
    const display = rawValue != null ? rawValue : formatDuration(seconds);
    return (
        <div
            className={cn(
                'rounded-lg border bg-card p-3 shadow-sm sm:p-4',
                primary && 'border-primary/40 bg-primary/5',
            )}
        >
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {Icon && <Icon className="h-3.5 w-3.5" />}
                {label}
            </div>
            <div className="mt-1 font-mono text-2xl tabular-nums">
                {display}
            </div>
        </div>
    );
}

function EntryRow({ entry, onEdit, onDelete }) {
    const project = entry.project;
    const task = entry.task;
    const seconds = entry.durationSeconds || 0;
    const start = new Date(entry.startedAt);
    // When an entry was logged against a subtask we want the user to
    // see the full path "Project → Parent task → Subtask" instead of
    // just the subtask title (which can be ambiguous — multiple
    // tasks often share generic subtask names like "Testing" or
    // "Review"). The backend already returns `task.parent` on every
    // entry include, so this is a pure render-time concern.
    const hasSubtask = Boolean(task?.parent);
    return (
        <li className="flex items-center justify-between gap-2 px-3 py-2 text-sm sm:px-4">
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                    {project?.code && (
                        <span className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                            {project.code}
                        </span>
                    )}
                    <Link
                        to={
                            project?.id
                                ? `/projects/${project.id}`
                                : '/projects'
                        }
                        className="truncate font-medium hover:underline"
                    >
                        {project?.name || 'Project'}
                    </Link>
                    {hasSubtask && (
                        <>
                            <ArrowRight className="h-3 w-3 text-muted-foreground" />
                            {task.parent.code && (
                                <span className="rounded border bg-muted/30 px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                                    {task.parent.code}
                                </span>
                            )}
                            <span
                                className="truncate text-muted-foreground"
                                title={task.parent.title}
                            >
                                {task.parent.title}
                            </span>
                            <ArrowRight className="h-3 w-3 text-muted-foreground" />
                            <span className="text-muted-foreground/70">↳</span>
                            {task.code && (
                                <span className="rounded border bg-muted/30 px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                                    {task.code}
                                </span>
                            )}
                            <span
                                className="truncate text-foreground/80"
                                title={task.title}
                            >
                                {task.title}
                            </span>
                        </>
                    )}
                    {task && !hasSubtask && (
                        <>
                            <ArrowRight className="h-3 w-3 text-muted-foreground" />
                            {task.code && (
                                <span className="rounded border bg-muted/30 px-1 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
                                    {task.code}
                                </span>
                            )}
                            <span
                                className="truncate text-muted-foreground"
                                title={task.title}
                            >
                                {task.title}
                            </span>
                        </>
                    )}
                    {!task && (
                        <span className="rounded border bg-muted/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                            project-level
                        </span>
                    )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {format(start, 'h:mm a')}
                    </span>
                    {entry.description && (
                        <span className="truncate">
                            · {entry.description}
                        </span>
                    )}
                    {entry.source === 'TIMER' && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1 py-px text-[10px] uppercase tracking-wide">
                            timer
                        </span>
                    )}
                    {entry.fromPersonalProject && (
                        <span
                            className="inline-flex items-center gap-1 rounded border border-violet-200 bg-violet-50 px-1.5 py-px text-[10px] text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300"
                            title={`Logged from personal project: ${entry.fromPersonalProject.name}`}
                        >
                            <UserIcon className="h-2.5 w-2.5" />
                            Personal · {entry.fromPersonalProject.name}
                        </span>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-1">
                <span className="font-mono text-xs tabular-nums">
                    {formatDuration(seconds)}
                </span>
                <button
                    type="button"
                    onClick={onEdit}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="Edit entry"
                    title="Edit"
                >
                    <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                    type="button"
                    onClick={onDelete}
                    className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label="Delete entry"
                    title="Delete"
                >
                    <Trash2 className="h-3.5 w-3.5" />
                </button>
                {project?.id && (
                    <Link
                        to={`/projects/${project.id}`}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label="Open project"
                        title="Open project"
                    >
                        <ExternalLink className="h-3.5 w-3.5" />
                    </Link>
                )}
            </div>
        </li>
    );
}

function snapToStep(seconds) {
    // Round to the nearest 30-minute increment so the picker can display
    // a sensible value when editing an entry that was created with a
    // free-form duration (e.g. from the live timer).
    const minutes = Math.max(30, Math.round(seconds / 60));
    const stepped = Math.round(minutes / 30) * 30;
    // Clamp into the picker's range so nothing goes out of bounds.
    return Math.min(
        Math.max(stepped, DURATION_STEPS[0]),
        DURATION_STEPS[DURATION_STEPS.length - 1],
    );
}

// When opening the edit dialog we need to put the entry's existing
// duration into a 30-minute picker. If the original duration isn't
// a clean multiple of 30 (e.g. a stopwatch entry of 1h 17m) we'd
// otherwise round to the nearest step on display — and silently save
// the rounded value on submit, which is data loss. We work around it
// by injecting a one-off "exact" option into the picker just for that
// entry; the user sees their real duration and the rounded option is
// only used if they explicitly pick one. We also extend the picker
// when the original duration exceeds the catalogue's max so editing
// a 12h+ entry doesn't truncate it on save.
function buildDurationOptionsForEntry(entry) {
    const seconds = entry?.durationSeconds || 0;
    const minutes = Math.max(30, Math.round(seconds / 60));
    const set = new Set(DURATION_STEPS);
    set.add(minutes);
    return Array.from(set).sort((a, b) => a - b);
}

function EditEntryDialog({
    open,
    onOpenChange,
    entry,
    projects,
    tasksByProject,
    onTasksLoaded,
    onSaved,
}) {
    const { user: currentUser } = useAuth();
    const elevated =
        currentUser?.role === 'ADMIN' || currentUser?.role === 'MANAGER';
    const [taskId, setTaskId] = useState(NO_TASK);
    const [dateValue, setDateValue] = useState('');
    const [durationMinutes, setDurationMinutes] = useState(60);
    const [description, setDescription] = useState('');
    const [submitting, setSubmitting] = useState(false);
    // We remember the dialog's starting values so we can tell whether
    // the user actually edited a field. The PATCH only sends fields
    // that have changed — which means tweaking the description never
    // recomputes startedAt/endedAt (the old behaviour silently shifted
    // start/end every time the dialog was saved because the picker had
    // snapped to a 30-minute step on open).
    const [initial, setInitial] = useState(null);
    const [durationOptions, setDurationOptions] = useState(DURATION_STEPS);
    const [taskTouched, setTaskTouched] = useState(false);

    const projectId = entry?.projectId;
    const tasksKnown = projectId ? tasksByProject[projectId] : null;

    useEffect(() => {
        if (!open || !entry) return;
        const initialTaskId = entryTaskId(entry);
        const start = new Date(entry.startedAt);
        const pad = (n) => String(n).padStart(2, '0');
        const initialDate = `${start.getFullYear()}-${pad(
            start.getMonth() + 1,
        )}-${pad(start.getDate())}`;
        // Use the entry's exact duration as the picker value so a
        // submit-without-edits leaves the time untouched. We extend
        // the option list so the picker always contains the exact
        // value plus the standard 30-minute steps.
        const exactMinutes = Math.max(
            30,
            Math.round((entry.durationSeconds || 0) / 60),
        );
        setDurationOptions(buildDurationOptionsForEntry(entry));
        setTaskId(initialTaskId);
        setDateValue(initialDate);
        setDurationMinutes(exactMinutes);
        setDescription(entry.description || '');
        setTaskTouched(false);
        setInitial({
            taskId: initialTaskId,
            dateValue: initialDate,
            durationMinutes: exactMinutes,
            description: entry.description || '',
        });
    }, [open, entry]);

    // Make sure the task list for this project is loaded so the picker
    // shows the right options when editing.
    useEffect(() => {
        if (!open || !projectId || tasksKnown) return;
        api.get('/tasks', { params: { projectId } })
            .then((res) => {
                onTasksLoaded(projectId, res.data?.tasks || []);
            })
            .catch(() => {});
    }, [open, projectId, tasksKnown, onTasksLoaded]);

    const project = projects.find((p) => p.id === projectId);
    const isOwner =
        project?.ownerId && project.ownerId === currentUser?.id;

    const taskOptions = useMemo(() => {
        const tasks = tasksKnown || [];
        const entryLinkedId =
            entry?.taskId || entry?.task?.id
                ? String(entry.taskId || entry.task.id)
                : null;
        const seeAll = elevated || isOwner;
        const isClosed = (t) => t?.status === 'DONE';
        const tasksById = new Map(tasks.map((t) => [t.id, t]));
        const childrenByParent = new Map();
        for (const t of tasks) {
            if (!t.parentTaskId) continue;
            if (!childrenByParent.has(t.parentTaskId)) {
                childrenByParent.set(t.parentTaskId, []);
            }
            childrenByParent.get(t.parentTaskId).push(t);
        }
        const out = [];
        if (seeAll) {
            for (const top of tasks.filter((t) => !t.parentTaskId)) {
                out.push({
                    id: top.id,
                    label: top.title,
                    code: top.code,
                    closed: isClosed(top),
                });
                for (const c of childrenByParent.get(top.id) || []) {
                    out.push({
                        id: c.id,
                        label: `\u21B3 ${c.title}`,
                        code: c.code,
                        closed: isClosed(c),
                    });
                }
            }
        } else {
        // Non-elevated: only show tasks assigned to the caller; if the
        // entry is already pinned to a task they don't own (e.g. an
        // admin reassigned it later), keep that one selectable so they
        // don't get stuck unable to save a description change.
        const mine = tasks.filter(
            (t) =>
                t.assigneeId === currentUser?.id ||
                t.id === entryLinkedId,
        );
        for (const t of mine) {
            if (!t.parentTaskId) {
                out.push({
                    id: t.id,
                    label: t.title,
                    code: t.code,
                    closed: isClosed(t),
                });
                for (const c of childrenByParent.get(t.id) || []) {
                    if (
                        c.assigneeId !== currentUser?.id &&
                        c.id !== entryLinkedId
                    ) {
                        continue;
                    }
                    out.push({
                        id: c.id,
                        label: `\u21B3 ${c.title}`,
                        code: c.code,
                        closed: isClosed(c),
                    });
                }
            } else {
                const parent = tasksById.get(t.parentTaskId);
                if (
                    parent &&
                    (parent.assigneeId === currentUser?.id ||
                        parent.id === entryLinkedId)
                ) {
                    continue;
                }
                const parentLabel = parent?.title || 'Task';
                out.push({
                    id: t.id,
                    label: `${parentLabel} \u2192 ${t.title}`,
                    code: t.code,
                    closed: isClosed(t),
                });
            }
        }
        }
        if (
            entryLinkedId &&
            !out.some((o) => o.id === entryLinkedId) &&
            entry?.task
        ) {
            out.unshift({
                id: entryLinkedId,
                label: entry.task.title || 'Linked task',
                code: entry.task.code,
            });
        }
        return out;
    }, [
        tasksKnown,
        elevated,
        isOwner,
        currentUser?.id,
        entry?.taskId,
        entry?.task,
    ]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!entry || !initial) return;
        // Detect what actually changed. Recomputing startedAt/endedAt
        // every time would shift the entry's clock window on save (and
        // for "today" entries would even move them to "now"), so we
        // only touch the time fields when date or duration was edited.
        const timeChanged =
            dateValue !== initial.dateValue ||
            durationMinutes !== initial.durationMinutes;
        const taskChanged =
            taskTouched &&
            normalizeTaskPickerId(taskId) !==
                normalizeTaskPickerId(initial.taskId);
        const descriptionChanged =
            (description || '').trim() !== (initial.description || '').trim();

        if (!timeChanged && !taskChanged && !descriptionChanged) {
            toast.message('No changes to save');
            onOpenChange?.(false);
            return;
        }

        const payload = {};
        if (timeChanged) {
            let scope;
            try {
                scope = deriveStartEnd(dateValue, durationMinutes);
            } catch {
                toast.error('Invalid date');
                return;
            }
            payload.startedAt = scope.startedAt;
            payload.endedAt = scope.endedAt;
        }
        if (taskChanged) {
            const next = normalizeTaskPickerId(taskId);
            payload.taskId = next === NO_TASK ? null : next;
        }
        if (descriptionChanged) {
            payload.description = description.trim() || null;
        }

        setSubmitting(true);
        try {
            await api.patch(`/time/${entry.id}`, payload);
            toast.success('Entry updated');
            onSaved?.();
        } catch (err) {
            toast.error(formatApiError(err, 'Could not save entry'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Edit time entry</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-3">
                    <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
                        <span className="font-semibold uppercase tracking-wide text-muted-foreground">
                            Project
                        </span>
                        <div className="mt-0.5 truncate">
                            {project?.name || 'Project'}
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Task (optional)</Label>
                        <Select
                            value={normalizeTaskPickerId(taskId)}
                            onValueChange={(v) => {
                                setTaskTouched(true);
                                setTaskId(v);
                            }}
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="Project-level time" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={NO_TASK}>
                                    — Project-level time —
                                </SelectItem>
                                {taskOptions.map((opt) => (
                                    <SelectItem key={opt.id} value={opt.id}>
                                        <span
                                            className={cn(
                                                'inline-flex items-center gap-1.5',
                                                opt.closed &&
                                                    'text-muted-foreground line-through',
                                            )}
                                        >
                                            {opt.code ? (
                                                <span className="font-mono text-[10px] uppercase text-muted-foreground">
                                                    {opt.code}
                                                </span>
                                            ) : null}
                                            {opt.label}
                                            {opt.closed && (
                                                <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground no-underline">
                                                    Done
                                                </span>
                                            )}
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label className="text-xs">Date</Label>
                            <Input
                                type="date"
                                value={dateValue}
                                onChange={(e) => setDateValue(e.target.value)}
                                max={todayInputValue()}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Duration</Label>
                            <Select
                                value={String(durationMinutes)}
                                onValueChange={(v) =>
                                    setDurationMinutes(parseInt(v, 10))
                                }
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent className="max-h-72">
                                    {durationOptions.map((mins) => (
                                        <SelectItem
                                            key={mins}
                                            value={String(mins)}
                                        >
                                            {durationLabel(mins)}
                                            {initial?.durationMinutes === mins &&
                                            !DURATION_STEPS.includes(mins) ? (
                                                <span className="ml-1 text-[10px] text-muted-foreground">
                                                    (original)
                                                </span>
                                            ) : null}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Note</Label>
                        <Textarea
                            rows={2}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="Optional"
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={submitting}>
                            {submitting ? 'Saving…' : 'Save'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

// -----------------------------------------------------------------------------
// AllUsersView — admin-only spreadsheet of every time entry on every
// project the admin can see, with filters for user, project, and a
// from/to date range. Sorted newest first. Backed by the same
// /api/time endpoint we already gate appropriately on the server.
// -----------------------------------------------------------------------------

const ALL_OPTION = '__all__';

function metaFilterParams(clientId, applicationId, isStrictAdmin) {
    if (!isStrictAdmin) return {};
    const out = {};
    if (clientId && clientId !== ALL_OPTION) out.clientId = clientId;
    if (applicationId && applicationId !== ALL_OPTION) {
        out.applicationId = applicationId;
    }
    return out;
}

function useAdminClientApplicationCatalogs(enabled) {
    const [clients, setClients] = useState([]);
    const [applications, setApplications] = useState([]);
    useEffect(() => {
        if (!enabled) {
            setClients([]);
            setApplications([]);
            return undefined;
        }
        let cancelled = false;
        Promise.all([
            api.get('/clients').catch(() => ({ data: { clients: [] } })),
            api.get('/applications').catch(() => ({ data: { applications: [] } })),
        ]).then(([cRes, aRes]) => {
            if (cancelled) return;
            setClients(cRes.data?.clients || []);
            setApplications(aRes.data?.applications || []);
        });
        return () => {
            cancelled = true;
        };
    }, [enabled]);
    return { clients, applications };
}

function AdminMetaFilterFields({
    clients,
    applications,
    clientId,
    applicationId,
    onClientChange,
    onApplicationChange,
}) {
    return (
        <>
            <div className="space-y-1.5">
                <Label className="text-xs">Client</Label>
                <Select value={clientId} onValueChange={onClientChange}>
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL_OPTION}>All clients</SelectItem>
                        {clients.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                                {c.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="space-y-1.5">
                <Label className="text-xs">Application</Label>
                <Select
                    value={applicationId}
                    onValueChange={onApplicationChange}
                >
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL_OPTION}>
                            All applications
                        </SelectItem>
                        {applications.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                                {a.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
        </>
    );
}

// Load the task list that feeds the multi-select task filter on the
// Charts + All-users tabs.
//
// Behaviour:
//   - When a specific project is selected we scope the request to
//     that project — small list, fast load, intuitive.
//   - When "All projects" is selected we load every task the caller
//     can read (admin = workspace-wide, regular users = projects
//     they're a participant on). Could be large, so the dropdown
//     leans on its built-in search.
//
// Returns the list plus a loading flag and an option projectName
// lookup so the dropdown can label each task with its project when
// the filter is workspace-wide (helps disambiguate "Setup" across
// projects).
function useFilterableTasks(projectId, projects) {
    const [tasks, setTasks] = useState([]);
    const [loading, setLoading] = useState(false);

    const projectsById = useMemo(() => {
        const m = new Map();
        for (const p of projects || []) m.set(p.id, p);
        return m;
    }, [projects]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        const params = {};
        if (projectId && projectId !== ALL_OPTION) {
            params.projectId = projectId;
        }
        api.get('/tasks', { params })
            .then(({ data }) => {
                if (cancelled) return;
                const rows = (data?.tasks || []).map((t) => ({
                    id: t.id,
                    code: t.code,
                    title: t.title,
                    projectId: t.projectId,
                    // Only surface the project name when we're in
                    // "All projects" mode — otherwise it's redundant
                    // noise because everything in the list belongs
                    // to the selected project.
                    projectName:
                        projectId === ALL_OPTION
                            ? projectsById.get(t.projectId)?.name || ''
                            : '',
                }));
                setTasks(rows);
            })
            .catch((err) => {
                if (cancelled) return;
                console.warn(
                    '[time/tasks-filter] could not load tasks:',
                    err?.message,
                );
                setTasks([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId, projectsById]);

    return { tasks, loading };
}

function initials(name) {
    if (!name) return '?';
    return name
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();
}

function AllUsersView({ isStrictAdmin = false }) {
    const [users, setUsers] = useState([]);
    const [projects, setProjects] = useState([]);
    const [entries, setEntries] = useState([]);
    const [loading, setLoading] = useState(false);
    const { clients, applications } =
        useAdminClientApplicationCatalogs(isStrictAdmin);

    // Pre-seed the user filter from the URL so the admin "view as"
    // deep-link from the Users page lands on the right person.
    const initialUserId =
        typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search).get('userId') ||
              ALL_OPTION
            : ALL_OPTION;
    const [userId, setUserId] = useState(initialUserId);
    const [projectId, setProjectId] = useState(ALL_OPTION);
    const [clientId, setClientId] = useState(ALL_OPTION);
    const [applicationId, setApplicationId] = useState(ALL_OPTION);
    const [taskIds, setTaskIds] = useState([]);
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');

    // Tasks dropdown is scoped by the current project filter —
    // switching projects re-fetches the option list AND drops the
    // current selection so we never end up filtering on tasks that
    // don't belong to the visible project.
    const { tasks: taskOptions, loading: taskOptionsLoading } =
        useFilterableTasks(projectId, projects);

    const handleProjectChange = (next) => {
        setProjectId(next);
        setTaskIds([]);
    };

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            api.get('/users').catch(() => ({ data: { users: [] } })),
            api.get('/projects').catch(() => ({ data: { projects: [] } })),
        ]).then(([uRes, pRes]) => {
            if (cancelled) return;
            setUsers(uRes.data?.users || []);
            setProjects(pRes.data?.projects || []);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const reload = useCallback(async () => {
        setLoading(true);
        const params = { limit: 500 };
        if (userId !== ALL_OPTION) params.userId = userId;
        if (projectId !== ALL_OPTION) params.projectId = projectId;
        Object.assign(
            params,
            metaFilterParams(clientId, applicationId, isStrictAdmin),
        );
        if (taskIds.length > 0) params.taskIds = taskIds.join(',');
        if (from) {
            const d = new Date(from);
            d.setHours(0, 0, 0, 0);
            params.from = d.toISOString();
        }
        if (to) {
            const d = new Date(to);
            d.setHours(23, 59, 59, 999);
            params.to = d.toISOString();
        }
        try {
            const { data } = await api.get('/time', { params });
            setEntries(data?.entries || []);
        } catch (err) {
            console.warn(
                '[time/all] could not load entries:',
                err?.message,
            );
            setEntries([]);
        } finally {
            setLoading(false);
        }
    }, [userId, projectId, clientId, applicationId, isStrictAdmin, taskIds, from, to]);

    useEffect(() => {
        reload();
    }, [reload]);

    // Aggregate stats for the currently filtered slice. Useful at a
    // glance while reviewing a user's week or a project's month.
    const stats = useMemo(() => {
        const total = entries.reduce(
            (s, e) => s + (e.durationSeconds || 0),
            0,
        );
        const byUser = new Map();
        for (const e of entries) {
            const id = e.user?.id;
            if (!id) continue;
            byUser.set(
                id,
                (byUser.get(id) || 0) + (e.durationSeconds || 0),
            );
        }
        return { total, contributorCount: byUser.size };
    }, [entries]);

    const clearFilters = () => {
        setUserId(ALL_OPTION);
        setProjectId(ALL_OPTION);
        setClientId(ALL_OPTION);
        setApplicationId(ALL_OPTION);
        setTaskIds([]);
        setFrom('');
        setTo('');
    };

    const { page, setPage, pageSize, setPageSize, total, totalPages, pageItems } =
        usePagination(entries, 20);

    return (
        <>
            {/* --- Filter bar ------------------------------------ */}
            <section className="rounded-lg border bg-card p-3 shadow-sm sm:p-4">
                <div className="mb-3 flex items-center justify-between gap-2 border-b pb-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Filters
                    </span>
                    <button
                        type="button"
                        onClick={clearFilters}
                        className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
                    >
                        Clear
                    </button>
                </div>
                <div
                    className={cn(
                        'grid grid-cols-1 gap-3 sm:grid-cols-2',
                        isStrictAdmin
                            ? 'lg:grid-cols-3 xl:grid-cols-7'
                            : 'lg:grid-cols-5',
                    )}
                >
                    <div className="space-y-1.5">
                        <Label className="text-xs">User</Label>
                        <Select value={userId} onValueChange={setUserId}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL_OPTION}>
                                    All users
                                </SelectItem>
                                {users.map((u) => (
                                    <SelectItem key={u.id} value={u.id}>
                                        {u.name || u.email}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Project</Label>
                        <Select
                            value={projectId}
                            onValueChange={handleProjectChange}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL_OPTION}>
                                    All projects
                                </SelectItem>
                                {projects.map((p) => (
                                    <SelectItem key={p.id} value={p.id}>
                                        {p.code ? (
                                            <span className="font-mono text-[10px] uppercase text-muted-foreground">
                                                {p.code}
                                            </span>
                                        ) : null}{' '}
                                        {p.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {isStrictAdmin && (
                        <AdminMetaFilterFields
                            clients={clients}
                            applications={applications}
                            clientId={clientId}
                            applicationId={applicationId}
                            onClientChange={setClientId}
                            onApplicationChange={setApplicationId}
                        />
                    )}
                    <div className="space-y-1.5">
                        <Label className="text-xs">Tasks</Label>
                        <TasksMultiSelect
                            tasks={taskOptions}
                            value={taskIds}
                            onChange={setTaskIds}
                            loading={taskOptionsLoading}
                            placeholder={
                                projectId === ALL_OPTION
                                    ? 'All tasks (any project)'
                                    : 'All tasks'
                            }
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">From</Label>
                        <Input
                            type="date"
                            value={from}
                            onChange={(e) => setFrom(e.target.value)}
                            max={to || undefined}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">To</Label>
                        <Input
                            type="date"
                            value={to}
                            onChange={(e) => setTo(e.target.value)}
                            min={from || undefined}
                        />
                    </div>
                </div>
            </section>

            {/* --- Aggregate ---------------------------------- */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <SummaryStat
                    label="Total time"
                    seconds={stats.total}
                    icon={Clock}
                    primary
                />
                <SummaryStat
                    label="Entries"
                    seconds={null}
                    icon={Calendar}
                    rawValue={String(entries.length)}
                />
                <SummaryStat
                    label="Contributors"
                    seconds={null}
                    icon={UsersIcon}
                    rawValue={String(stats.contributorCount)}
                />
            </div>

            {/* --- Spreadsheet ---------------------------------- */}
            <section className="rounded-lg border bg-card shadow-sm">
                <header className="flex items-center justify-between gap-2 border-b px-3 py-2 text-sm font-semibold sm:px-4">
                    <div className="flex items-center gap-2">
                        <span>Entries</span>
                        {loading && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                        )}
                    </div>
                    <div className="flex items-center gap-3">
                        {total > 0 && (
                            <PageSizeControl
                                pageSize={pageSize}
                                onPageSizeChange={setPageSize}
                                options={[20, 50, 100]}
                            />
                        )}
                    <ExportTimeButton
                        disabled={entries.length === 0}
                        filenameFallback="time-entries.csv"
                        params={{
                            ...(userId !== ALL_OPTION ? { userId } : {}),
                            ...(projectId !== ALL_OPTION
                                ? { projectId }
                                : {}),
                            ...metaFilterParams(
                                clientId,
                                applicationId,
                                isStrictAdmin,
                            ),
                            ...(taskIds.length > 0
                                ? { taskIds: taskIds.join(',') }
                                : {}),
                            ...(from
                                ? (() => {
                                      const d = new Date(from);
                                      d.setHours(0, 0, 0, 0);
                                      return { from: d.toISOString() };
                                  })()
                                : {}),
                            ...(to
                                ? (() => {
                                      const d = new Date(to);
                                      d.setHours(23, 59, 59, 999);
                                      return { to: d.toISOString() };
                                  })()
                                : {}),
                        }}
                    />
                    </div>
                </header>
                {entries.length === 0 && !loading ? (
                    <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                        No time entries match the current filters.
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="w-48">User</TableHead>
                                    <TableHead className="w-36">When</TableHead>
                                    {/* "Project / task" cell now also surfaces
                                        personal-project mirror context inline
                                        for rows that originated on a linked
                                        personal project, so we widen it a
                                        touch. */}
                                    <TableHead className="w-[240px]">
                                        Project / task
                                    </TableHead>
                                    <TableHead className="w-24 text-right">
                                        Duration
                                    </TableHead>
                                    <TableHead className="w-24">Source</TableHead>
                                    <TableHead className="min-w-[300px]">
                                        Note
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {pageItems.map((e) => (
                                    <SpreadsheetRow
                                        key={e.id}
                                        entry={e}
                                        onPickUser={(id) => setUserId(id)}
                                        onPickProject={(id) => setProjectId(id)}
                                    />
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
                {total > 0 && (
                    <Pagination
                        page={page}
                        pageSize={pageSize}
                        total={total}
                        totalPages={totalPages}
                        onPageChange={setPage}
                        onPageSizeChange={setPageSize}
                        pageSizeOptions={[20, 50, 100]}
                    />
                )}
            </section>
        </>
    );
}

function SpreadsheetRow({ entry, onPickUser, onPickProject }) {
    const u = entry.user || {};
    const p = entry.project || {};
    const t = entry.task || null;
    // Subtasks come back with a `parent` object so we can render the
    // hierarchy "Parent task -> Subtask" inline. Top-level tasks have
    // a null `parent`.
    const parent = t?.parent || null;
    // Personal-project mirror context. Set only when this entry is a
    // mirror created from a personal project that is linked to a
    // shared project. We use it below to replace the otherwise
    // opaque "Project-level" label with the personal task title.
    const personalProj = entry.fromPersonalProject || null;
    const sourceEntry = entry.sourceEntry || null;
    const sourceTask = sourceEntry?.task || null;
    const sourceParent = sourceTask?.parent || null;
    const isPersonalMirror = !t && personalProj;
    const seconds = entry.durationSeconds || 0;
    const start = new Date(entry.startedAt);
    const avatar = resolveAssetUrl(u.avatarUrl);
    const isManual = entry.source === 'MANUAL';
    return (
        <TableRow className="[&_td]:py-1.5">
            <TableCell>
                <button
                    type="button"
                    onClick={() => onPickUser?.(u.id)}
                    className="flex min-w-0 items-center gap-2 text-left hover:underline"
                    title={`Filter to ${u.name || 'this user'}`}
                >
                    <Avatar className="h-6 w-6">
                        {avatar && (
                            <AvatarImage src={avatar} alt={u.name || ''} />
                        )}
                        <AvatarFallback className="text-[10px]">
                            {initials(u.name)}
                        </AvatarFallback>
                    </Avatar>
                    <span className="truncate text-sm">
                        {u.name || u.email || 'Unknown'}
                    </span>
                </button>
            </TableCell>
            <TableCell
                className="whitespace-nowrap text-xs"
                title={format(start, "EEEE, MMMM d yyyy 'at' h:mm a")}
            >
                {format(start, 'd MMM yyyy, HH:mm')}
            </TableCell>
            <TableCell>
                {/* Project + (parent task) + task on a single line so a
                    reviewer can see the hierarchy at a glance. The
                    project chip is the only clickable bit; the task
                    text is plain so the row stays scannable. */}
                <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
                    <button
                        type="button"
                        onClick={() => p.id && onPickProject?.(p.id)}
                        className="flex min-w-0 items-center gap-1 text-left hover:underline"
                        title={`Filter to ${p.name || 'this project'}`}
                    >
                        {p.code && (
                            <span className="rounded border bg-muted/40 px-1 py-px font-mono text-[10px] uppercase text-muted-foreground">
                                {p.code}
                            </span>
                        )}
                        <span className="truncate font-medium">
                            {p.name || '—'}
                        </span>
                    </button>
                    <span className="text-muted-foreground">·</span>
                    {t ? (
                        <span className="flex min-w-0 items-center gap-1">
                            {parent && (
                                <>
                                    {parent.code && (
                                        <span className="rounded border bg-muted/40 px-1 py-px font-mono text-[10px] uppercase text-muted-foreground">
                                            {parent.code}
                                        </span>
                                    )}
                                    <span className="truncate text-muted-foreground">
                                        {parent.title}
                                    </span>
                                    <span className="text-muted-foreground">
                                        →
                                    </span>
                                </>
                            )}
                            {t.code && (
                                <span className="rounded border bg-muted/40 px-1 py-px font-mono text-[10px] uppercase text-muted-foreground">
                                    {t.code}
                                </span>
                            )}
                            <span className="truncate">{t.title}</span>
                        </span>
                    ) : isPersonalMirror ? (
                        // Mirror entry — surface the originating personal
                        // project and its task inline where "Project-level"
                        // used to sit, so the admin can read the
                        // shared-project row AND see where it actually
                        // came from in one line.
                        <span
                            className="flex min-w-0 items-center gap-1"
                            title={`Mirrored from ${personalProj.name}`}
                        >
                            {personalProj.code && (
                                <span className="rounded border bg-muted/40 px-1 py-px font-mono text-[10px] uppercase text-muted-foreground">
                                    {personalProj.code}
                                </span>
                            )}
                            <span className="truncate text-muted-foreground">
                                {personalProj.name}
                            </span>
                            {sourceTask && (
                                <>
                                    <span className="text-muted-foreground">
                                        →
                                    </span>
                                    {sourceParent && (
                                        <>
                                            {sourceParent.code && (
                                                <span className="rounded border bg-muted/40 px-1 py-px font-mono text-[10px] uppercase text-muted-foreground">
                                                    {sourceParent.code}
                                                </span>
                                            )}
                                            <span className="truncate text-muted-foreground">
                                                {sourceParent.title}
                                            </span>
                                            <span className="text-muted-foreground">
                                                →
                                            </span>
                                        </>
                                    )}
                                    {sourceTask.code && (
                                        <span className="rounded border bg-muted/40 px-1 py-px font-mono text-[10px] uppercase text-muted-foreground">
                                            {sourceTask.code}
                                        </span>
                                    )}
                                    <span className="truncate">
                                        {sourceTask.title}
                                    </span>
                                </>
                            )}
                            {!sourceTask && (
                                <span className="text-[10px] italic text-muted-foreground">
                                    (project-level)
                                </span>
                            )}
                        </span>
                    ) : (
                        <span className="text-xs italic text-muted-foreground">
                            Project-level
                        </span>
                    )}
                </div>
            </TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums">
                {formatDuration(seconds)}
            </TableCell>
            <TableCell>
                <span
                    className={cn(
                        'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                        isManual
                            ? 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200'
                            : 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200',
                    )}
                    title={
                        isManual
                            ? 'Logged manually after the fact'
                            : 'Tracked with the live timer'
                    }
                >
                    {isManual ? 'Manual' : 'Tracked'}
                </span>
            </TableCell>
            <TableCell className="min-w-[300px] align-top">
                <span
                    className="block whitespace-pre-wrap break-words text-xs text-muted-foreground"
                    title={entry.description || undefined}
                >
                    {entry.description || '—'}
                </span>
            </TableCell>
        </TableRow>
    );
}

// ===========================================================================
// Timesheet gaps tab (admin / time:view:all)
// ===========================================================================
//
// "Who didn't enter their hours?" report. For each working day in the range
// it flags every active, non-requester user who logged LESS than a target
// (default 8h/day, adjustable). Built entirely from /api/time/stats
// (byDayUser = per-day per-user totals) + the full user roster, so no extra
// endpoint is needed. Weekends are excluded by default.
function GapsView() {
    const [users, setUsers] = useState([]);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(false);

    // Default range: Monday of the current week → today (the window an
    // admin most often checks: "did everyone log this week?").
    const today = new Date();
    const monday = (() => {
        const d = new Date(today);
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
        return d;
    })();
    const [from, setFrom] = useState(toDateInput(monday));
    const [to, setTo] = useState(toDateInput(today));
    // Default 7.5h (7:30) — the standard workday here.
    const [targetHours, setTargetHours] = useState(7.5);
    const [includeWeekends, setIncludeWeekends] = useState(false);
    // Which users to show, remembered per admin. `null` = not chosen yet
    // (we default to "everyone" once the roster loads).
    const [selectedUserIds, setSelectedUserIds] = useState(() => {
        try {
            const raw = localStorage.getItem('pm.time.gaps.users');
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    });

    useEffect(() => {
        api.get('/users')
            .then(({ data }) => setUsers(data?.users || data || []))
            .catch(() => setUsers([]));
    }, []);

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const params = {};
            if (from) {
                const d = new Date(from);
                d.setHours(0, 0, 0, 0);
                params.from = d.toISOString();
            }
            if (to) {
                const d = new Date(to);
                d.setHours(23, 59, 59, 999);
                params.to = d.toISOString();
            }
            const { data } = await api.get('/time/stats', { params });
            setStats(data);
        } catch (err) {
            console.warn('[time/gaps] failed:', err?.message);
            setStats(null);
        } finally {
            setLoading(false);
        }
    }, [from, to]);

    useEffect(() => {
        reload();
    }, [reload]);

    // Active staff only; portal requesters never log time so they'd be
    // false positives.
    const staff = useMemo(
        () =>
            (users || []).filter(
                (u) =>
                    u.role !== 'REQUESTER' &&
                    (u.status ? u.status === 'ACTIVE' : true),
            ),
        [users],
    );

    // First visit (nothing saved): show everyone. After that, respect
    // the admin's saved choice.
    useEffect(() => {
        if (selectedUserIds === null && staff.length > 0) {
            setSelectedUserIds(staff.map((u) => u.id));
        }
    }, [staff, selectedUserIds]);

    // Persist the selection so it sticks between visits.
    useEffect(() => {
        if (selectedUserIds === null) return;
        try {
            localStorage.setItem(
                'pm.time.gaps.users',
                JSON.stringify(selectedUserIds),
            );
        } catch {
            /* ignore */
        }
    }, [selectedUserIds]);

    const userOptions = useMemo(
        () =>
            staff.map((u) => ({ id: u.id, label: u.name || u.email })),
        [staff],
    );

    // The staff actually shown (selection applied). Falls back to all
    // staff until a selection exists.
    const visibleStaff = useMemo(() => {
        if (!selectedUserIds) return staff;
        const set = new Set(selectedUserIds);
        return staff.filter((u) => set.has(u.id));
    }, [staff, selectedUserIds]);

    const targetSec = Math.max(0, Number(targetHours) || 0) * 3600;

    const workingDays = useMemo(() => {
        const out = [];
        if (!from || !to) return out;
        const [fy, fm, fd] = from.split('-').map(Number);
        const [ty, tm, td] = to.split('-').map(Number);
        const cur = new Date(fy, fm - 1, fd);
        const end = new Date(ty, tm - 1, td);
        // Guard against a silly-large range locking the UI.
        let guard = 0;
        while (cur <= end && guard++ < 1000) {
            const dow = cur.getDay();
            const weekend = dow === 0 || dow === 6;
            if (includeWeekends || !weekend) {
                out.push({ key: toDateInput(cur), dateObj: new Date(cur) });
            }
            cur.setDate(cur.getDate() + 1);
        }
        return out;
    }, [from, to, includeWeekends]);

    const cell = useMemo(() => {
        const m = new Map();
        for (const c of stats?.byDayUser || []) {
            m.set(`${c.date}|${c.userId}`, c.seconds);
        }
        return m;
    }, [stats]);

    // One row per visible user: their per-day seconds (drives the bars)
    // plus gap count and total. Sorted by most gaps first.
    const rows = useMemo(() => {
        return visibleStaff
            .map((u) => {
                let missed = 0;
                let totalSec = 0;
                const days = workingDays.map((d) => {
                    const sec = cell.get(`${d.key}|${u.id}`) || 0;
                    totalSec += sec;
                    if (sec < targetSec) missed++;
                    return { key: d.key, dateObj: d.dateObj, seconds: sec };
                });
                return {
                    user: u,
                    days,
                    missed,
                    totalSec,
                    working: workingDays.length,
                };
            })
            .sort(
                (a, b) =>
                    b.missed - a.missed ||
                    (a.user.name || a.user.email || '').localeCompare(
                        b.user.name || b.user.email || '',
                    ),
            );
    }, [visibleStaff, workingDays, cell, targetSec]);

    // Shared vertical scale so bars are comparable across people. At
    // least the target (and 1h) so a lone short bar isn't full height.
    const yMaxSec = useMemo(() => {
        let max = targetSec;
        for (const r of rows)
            for (const d of r.days) if (d.seconds > max) max = d.seconds;
        return Math.max(max, 3600);
    }, [rows, targetSec]);

    const usersWithGaps = rows.filter((r) => r.missed > 0).length;

    const setRange = (f, t) => {
        setFrom(toDateInput(f));
        setTo(toDateInput(t));
    };

    return (
        <div className="flex flex-col gap-4">
            {/* --- Filters --------------------------------------- */}
            <section className="rounded-lg border bg-card p-3 shadow-sm sm:p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Timesheet gaps
                    </span>
                    <div className="flex flex-wrap items-center gap-1">
                        <RangeChip
                            onClick={() => {
                                const d = new Date();
                                const m = new Date(d);
                                m.setDate(d.getDate() - ((d.getDay() + 6) % 7));
                                setRange(m, d);
                            }}
                        >
                            This week
                        </RangeChip>
                        <RangeChip
                            onClick={() => {
                                const d = new Date();
                                const m = new Date(d);
                                m.setDate(
                                    d.getDate() - ((d.getDay() + 6) % 7) - 7,
                                );
                                const e = new Date(m);
                                e.setDate(m.getDate() + 6);
                                setRange(m, e);
                            }}
                        >
                            Last week
                        </RangeChip>
                        <RangeChip
                            onClick={() => {
                                const d = new Date();
                                setRange(
                                    new Date(d.getFullYear(), d.getMonth(), 1),
                                    d,
                                );
                            }}
                        >
                            This month
                        </RangeChip>
                        {/* Refetch the current range on demand — handy for
                            watching entries land while you wait for someone
                            to fill in their hours. */}
                        <button
                            type="button"
                            onClick={reload}
                            disabled={loading}
                            title="Reload this period"
                            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
                        >
                            <RefreshCw
                                className={cn(
                                    'h-3.5 w-3.5',
                                    loading && 'animate-spin',
                                )}
                            />
                            Reload
                        </button>
                    </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-1.5">
                        <Label className="text-xs">From</Label>
                        <Input
                            type="date"
                            value={from}
                            onChange={(e) => setFrom(e.target.value)}
                            max={to || undefined}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">To</Label>
                        <Input
                            type="date"
                            value={to}
                            onChange={(e) => setTo(e.target.value)}
                            min={from || undefined}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">
                            Target hours / day
                        </Label>
                        <Input
                            type="number"
                            min={0}
                            max={24}
                            step={0.5}
                            value={targetHours}
                            onChange={(e) => setTargetHours(e.target.value)}
                        />
                    </div>
                    <label className="flex items-end gap-2 pb-2 text-xs text-muted-foreground">
                        <input
                            type="checkbox"
                            className="h-4 w-4 rounded border"
                            checked={includeWeekends}
                            onChange={(e) =>
                                setIncludeWeekends(e.target.checked)
                            }
                        />
                        Include weekends
                    </label>
                    <div className="min-w-[200px] space-y-1.5">
                        <Label className="text-xs">People</Label>
                        <MultiSelectDropdown
                            options={userOptions}
                            value={selectedUserIds || []}
                            onChange={setSelectedUserIds}
                            placeholder="All people"
                            emptyText="No staff"
                        />
                    </div>
                </div>
            </section>

            {/* --- Daily hours by person (bars) ------------------ */}
            <section className="rounded-lg border bg-card p-3 shadow-sm sm:p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Daily hours by person
                    </span>
                    <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                            <span className="h-2 w-2 rounded-sm bg-emerald-500" />
                            met
                        </span>
                        <span className="flex items-center gap-1">
                            <span className="h-2 w-2 rounded-sm bg-amber-500" />
                            under
                        </span>
                        <span className="flex items-center gap-1">
                            <span className="h-2 w-2 rounded-sm border border-dashed border-rose-400/60 bg-rose-500/10" />
                            none
                        </span>
                        <span className="hidden sm:inline">
                            · target {targetHours}h
                        </span>
                    </span>
                </div>
                <div className="mb-2 text-[11px] text-muted-foreground">
                    {loading
                        ? 'Loading…'
                        : `${usersWithGaps} of ${rows.length} below target · ${workingDays.length} working day${workingDays.length === 1 ? '' : 's'}`}
                </div>
                {rows.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        No people selected — pick some in the People filter
                        above.
                    </p>
                ) : (
                    <ul className="divide-y">
                        {rows.map((r) => (
                            <GapUserRow
                                key={r.user.id}
                                row={r}
                                yMaxSec={yMaxSec}
                                targetSec={targetSec}
                            />
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}

// One person's row in the gaps view: name + gap badge on the left, a
// strip of daily bars on the right (green = hit target, amber = under,
// dashed red = nothing logged), with a dashed target reference line.
// Clicking a bar loads and lists that person's entries for that day.
function GapUserRow({ row, yMaxSec, targetSec }) {
    const { user, days, missed, working, totalSec } = row;
    const ok = missed === 0;
    const H = 44; // bar plot height in px
    const targetPct = yMaxSec > 0 ? (targetSec / yMaxSec) * 100 : 0;

    const [openKey, setOpenKey] = useState(null);
    const [entries, setEntries] = useState([]);
    const [loadingEntries, setLoadingEntries] = useState(false);

    const openDay = async (d) => {
        if (openKey === d.key) {
            setOpenKey(null);
            return;
        }
        setOpenKey(d.key);
        setEntries([]);
        setLoadingEntries(true);
        try {
            const from = new Date(d.dateObj);
            from.setHours(0, 0, 0, 0);
            const to = new Date(d.dateObj);
            to.setHours(23, 59, 59, 999);
            const { data } = await api.get('/time', {
                params: {
                    userId: user.id,
                    from: from.toISOString(),
                    to: to.toISOString(),
                    limit: 200,
                },
            });
            setEntries(data?.entries || []);
        } catch {
            setEntries([]);
        } finally {
            setLoadingEntries(false);
        }
    };

    const openDayObj = days.find((d) => d.key === openKey) || null;

    return (
        <li className="py-2">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                <div className="flex w-full items-center justify-between gap-2 sm:w-56 sm:shrink-0">
                    <span className="min-w-0 truncate text-sm font-medium">
                        {user.name || user.email}
                    </span>
                    <span
                        className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                            ok
                                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                : 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                        )}
                    >
                        {ok ? 'all logged' : `${missed}/${working} below`}
                    </span>
                </div>
                <div className="min-w-0 flex-1">
                    <div
                        className="relative flex items-end gap-[3px]"
                        style={{ height: H }}
                    >
                        <div
                            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-muted-foreground/40"
                            style={{ bottom: `${targetPct}%` }}
                        />
                        {days.map((d) => {
                            const none = d.seconds === 0;
                            const met = d.seconds >= targetSec;
                            const isOpen = openKey === d.key;
                            const px = none
                                ? 4
                                : Math.max(
                                      6,
                                      Math.round((d.seconds / yMaxSec) * H),
                                  );
                            return (
                                <button
                                    type="button"
                                    key={d.key}
                                    onClick={() => openDay(d)}
                                    className={cn(
                                        'flex min-w-0 flex-1 items-end self-stretch rounded-sm hover:bg-muted/50',
                                        isOpen && 'bg-muted ring-1 ring-primary',
                                    )}
                                    title={`${format(d.dateObj, 'EEE d MMM')} · ${none ? 'no time logged' : formatDuration(d.seconds)} · click for details`}
                                >
                                    <span
                                        className={cn(
                                            'block w-full rounded-sm',
                                            none
                                                ? 'border border-dashed border-rose-400/50 bg-rose-500/10'
                                                : met
                                                  ? 'bg-emerald-500'
                                                  : 'bg-amber-500',
                                        )}
                                        style={{ height: `${px}px` }}
                                    />
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-0.5 flex gap-[3px]">
                        {days.map((d) => (
                            <span
                                key={d.key}
                                className="min-w-0 flex-1 text-center text-[9px] leading-tight text-muted-foreground"
                            >
                                <span className="block">
                                    {format(d.dateObj, 'EEEEE')}
                                </span>
                                <span className="block tabular-nums">
                                    {format(d.dateObj, 'd.')}
                                </span>
                            </span>
                        ))}
                    </div>
                </div>
                <span className="hidden w-16 shrink-0 text-right tabular-nums text-[11px] text-muted-foreground sm:block">
                    {formatDuration(totalSec)}
                </span>
            </div>

            {/* Clicked-day detail: what this person logged that day */}
            {openDayObj && (
                <div className="mt-2 rounded-md border bg-muted/20 p-2.5 text-xs">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                        <span className="font-medium">
                            {format(openDayObj.dateObj, 'EEEE, d MMM yyyy')} ·{' '}
                            {user.name || user.email}
                        </span>
                        <span className="flex items-center gap-2 text-muted-foreground">
                            <span className="tabular-nums">
                                {formatDuration(openDayObj.seconds)} logged
                            </span>
                            <button
                                type="button"
                                onClick={() => setOpenKey(null)}
                                className="rounded p-0.5 hover:bg-accent"
                                title="Close"
                                aria-label="Close"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </span>
                    </div>
                    {loadingEntries ? (
                        <p className="flex items-center gap-1.5 py-1 text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading…
                        </p>
                    ) : entries.length === 0 ? (
                        <p className="py-1 text-muted-foreground">
                            No time logged this day.
                        </p>
                    ) : (
                        <ul className="divide-y">
                            {entries.map((e) => {
                                const taskLabel = e.task
                                    ? e.task.parent
                                        ? `${e.task.parent.title} › ${e.task.title}`
                                        : e.task.title
                                    : 'Project-level';
                                return (
                                    <li
                                        key={e.id}
                                        className="flex items-start justify-between gap-3 py-1.5"
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="flex flex-wrap items-center gap-1.5">
                                                {e.project?.code && (
                                                    <span className="font-mono text-[10px] uppercase text-muted-foreground">
                                                        {e.project.code}
                                                    </span>
                                                )}
                                                <span className="font-medium">
                                                    {e.project?.name ||
                                                        'Unknown project'}
                                                </span>
                                                <span className="text-muted-foreground">
                                                    · {taskLabel}
                                                </span>
                                            </span>
                                            {e.description && (
                                                <span className="mt-0.5 block break-words text-muted-foreground/80">
                                                    “{e.description}”
                                                </span>
                                            )}
                                        </span>
                                        <span className="shrink-0 tabular-nums text-muted-foreground">
                                            {formatDuration(e.durationSeconds)}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}
        </li>
    );
}

// ===========================================================================
// Charts tab
// ===========================================================================
//
// Lightweight workspace overview built from /api/time/stats. Defaults to the
// trailing 30 days; admins can pivot to a single user or project. Non-admins
// always see only their own data (the backend enforces the scope).

function ChartsView({ isAdmin, isStrictAdmin = false }) {
    const [users, setUsers] = useState([]);
    const [projects, setProjects] = useState([]);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(false);
    const { clients, applications } =
        useAdminClientApplicationCatalogs(isStrictAdmin);

    const [userId, setUserId] = useState(ALL_OPTION);
    const [projectId, setProjectId] = useState(ALL_OPTION);
    const [clientId, setClientId] = useState(ALL_OPTION);
    const [applicationId, setApplicationId] = useState(ALL_OPTION);
    const [taskIds, setTaskIds] = useState([]);
    // Default range = trailing 30 days. Stored as YYYY-MM-DD strings so
    // the inputs are simple to control.
    const today = new Date();
    const defaultFrom = new Date(today);
    defaultFrom.setDate(defaultFrom.getDate() - 29);
    const [from, setFrom] = useState(toDateInput(defaultFrom));
    const [to, setTo] = useState(toDateInput(today));

    // Tasks dropdown options follow the selected project, same as the
    // All-users tab. Switching project clears any active task picks.
    const { tasks: taskOptions, loading: taskOptionsLoading } =
        useFilterableTasks(projectId, projects);

    const handleProjectChange = (next) => {
        setProjectId(next);
        setTaskIds([]);
    };

    useEffect(() => {
        let cancelled = false;
        Promise.all([
            isAdmin
                ? api.get('/users').catch(() => ({ data: { users: [] } }))
                : Promise.resolve({ data: { users: [] } }),
            api.get('/projects').catch(() => ({ data: { projects: [] } })),
        ]).then(([uRes, pRes]) => {
            if (cancelled) return;
            setUsers(uRes.data?.users || []);
            setProjects(pRes.data?.projects || []);
        });
        return () => {
            cancelled = true;
        };
    }, [isAdmin]);

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            const params = {};
            if (isAdmin && userId !== ALL_OPTION) params.userId = userId;
            if (projectId !== ALL_OPTION) params.projectId = projectId;
            Object.assign(
                params,
                metaFilterParams(clientId, applicationId, isStrictAdmin),
            );
            if (taskIds.length > 0) params.taskIds = taskIds.join(',');
            if (from) {
                const d = new Date(from);
                d.setHours(0, 0, 0, 0);
                params.from = d.toISOString();
            }
            if (to) {
                const d = new Date(to);
                d.setHours(23, 59, 59, 999);
                params.to = d.toISOString();
            }
            const { data } = await api.get('/time/stats', { params });
            setStats(data);
        } catch (err) {
            console.warn('[time/charts] failed:', err?.message);
            setStats(null);
        } finally {
            setLoading(false);
        }
    }, [
        isAdmin,
        isStrictAdmin,
        userId,
        projectId,
        clientId,
        applicationId,
        taskIds,
        from,
        to,
    ]);

    useEffect(() => {
        reload();
    }, [reload]);

    const setRangePreset = (days) => {
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - (days - 1));
        setFrom(toDateInput(start));
        setTo(toDateInput(end));
    };

    const total = stats?.total || 0;
    const entryCount = stats?.entryCount || 0;
    const byDay = stats?.byDay || [];
    const trackedDays = byDay.filter((d) => d.seconds > 0).length;
    const avgPerActiveDay = trackedDays
        ? Math.round(total / trackedDays)
        : 0;
    const dayCount = byDay.length || 1;
    const avgPerDay = Math.round(total / dayCount);

    // Decide what to stack the daily bars by:
    //   - Admin viewing "All users"   → stack by USER (who worked when)
    //   - Otherwise (single user view, or non-admin) → stack by PROJECT
    //     (where my time went each day)
    // The legend / tooltip text adapts accordingly.
    const stackByUser = isAdmin && userId === ALL_OPTION;
    const dailyStack = useMemo(
        () =>
            buildDailyStack({
                stackByUser,
                stats,
            }),
        [stackByUser, stats],
    );

    // Hours-by-weekday rhythm (Mon→Sun) derived from the daily buckets.
    // Shows when the team (or the selected user) tends to log time. Dates
    // are parsed as LOCAL so the weekday bucketing doesn't drift by TZ.
    const byWeekday = useMemo(() => {
        const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const buckets = new Array(7).fill(0);
        for (const d of stats?.byDay || []) {
            const [y, m, dd] = String(d.date).split('-').map(Number);
            const wd = (new Date(y, (m || 1) - 1, dd || 1).getDay() + 6) % 7;
            buckets[wd] += d.seconds || 0;
        }
        return buckets.map((seconds, i) => ({
            key: labels[i],
            label: labels[i],
            seconds,
        }));
    }, [stats]);

    // Per-user "by day / by week" breakdown. Only meaningful when an admin
    // has picked ONE specific user — then stats.byDay is that person's
    // daily totals, which we also roll up into Monday-anchored weeks. Both
    // lists read most-recent-first.
    const selectedUserName = useMemo(() => {
        if (!isAdmin || userId === ALL_OPTION) return null;
        const u = users.find((x) => x.id === userId);
        return u ? u.name || u.email : null;
    }, [isAdmin, userId, users]);

    const dayBreakdown = useMemo(() => {
        return (stats?.byDay || [])
            .filter((d) => d.seconds > 0)
            .map((d) => {
                const [y, m, dd] = String(d.date).split('-').map(Number);
                return { ...d, dateObj: new Date(y, (m || 1) - 1, dd || 1) };
            })
            .sort((a, b) => (a.date < b.date ? 1 : -1));
    }, [stats]);

    const weekBreakdown = useMemo(() => {
        const map = new Map(); // key = Monday YYYY-MM-DD
        for (const d of stats?.byDay || []) {
            if (!d.seconds) continue;
            const [y, m, dd] = String(d.date).split('-').map(Number);
            const dt = new Date(y, (m || 1) - 1, dd || 1);
            const dow = (dt.getDay() + 6) % 7; // Monday = 0
            const monday = new Date(dt);
            monday.setDate(dt.getDate() - dow);
            const key = toDateInput(monday);
            const cur = map.get(key) || { start: monday, seconds: 0 };
            cur.seconds += d.seconds;
            map.set(key, cur);
        }
        return Array.from(map.entries())
            .map(([key, v]) => {
                const end = new Date(v.start);
                end.setDate(v.start.getDate() + 6);
                return { key, start: v.start, end, seconds: v.seconds };
            })
            .sort((a, b) => (a.key < b.key ? 1 : -1));
    }, [stats]);

    // Collapse / expand ALL charts at once. Each press bumps the signal;
    // ChartCards snap to `!chartsCollapsed` then can still be toggled
    // individually.
    const [chartsCollapsed, setChartsCollapsed] = useState(false);
    const [collapseSignal, setCollapseSignal] = useState(0);
    const collapseCtx = useMemo(
        () => ({ signal: collapseSignal, value: !chartsCollapsed }),
        [collapseSignal, chartsCollapsed],
    );
    const toggleAllCharts = () => {
        setChartsCollapsed((c) => !c);
        setCollapseSignal((s) => s + 1);
    };

    return (
        <ChartCollapseContext.Provider value={collapseCtx}>
            {/* --- Filter strip --------------------------------- */}
            <section className="rounded-lg border bg-card p-3 shadow-sm sm:p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Filters
                    </span>
                    <div className="flex flex-wrap items-center gap-1">
                        <RangeChip onClick={() => setRangePreset(7)}>
                            7 days
                        </RangeChip>
                        <RangeChip onClick={() => setRangePreset(30)}>
                            30 days
                        </RangeChip>
                        <RangeChip onClick={() => setRangePreset(90)}>
                            90 days
                        </RangeChip>
                        <RangeChip onClick={() => setRangePreset(365)}>
                            1 year
                        </RangeChip>
                    </div>
                </div>
                <div
                    className={cn(
                        'grid grid-cols-1 gap-3 sm:grid-cols-2',
                        isStrictAdmin
                            ? 'lg:grid-cols-3 xl:grid-cols-7'
                            : isAdmin
                              ? 'lg:grid-cols-5'
                              : 'lg:grid-cols-4',
                    )}
                >
                    {isAdmin && (
                        <div className="space-y-1.5">
                            <Label className="text-xs">User</Label>
                            <Select value={userId} onValueChange={setUserId}>
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={ALL_OPTION}>
                                        All users
                                    </SelectItem>
                                    {users.map((u) => (
                                        <SelectItem key={u.id} value={u.id}>
                                            {u.name || u.email}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                    <div className="space-y-1.5">
                        <Label className="text-xs">Project</Label>
                        <Select
                            value={projectId}
                            onValueChange={handleProjectChange}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL_OPTION}>
                                    All projects
                                </SelectItem>
                                {projects.map((p) => (
                                    <SelectItem key={p.id} value={p.id}>
                                        {p.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    {isStrictAdmin && (
                        <AdminMetaFilterFields
                            clients={clients}
                            applications={applications}
                            clientId={clientId}
                            applicationId={applicationId}
                            onClientChange={setClientId}
                            onApplicationChange={setApplicationId}
                        />
                    )}
                    <div className="space-y-1.5">
                        <Label className="text-xs">Tasks</Label>
                        <TasksMultiSelect
                            tasks={taskOptions}
                            value={taskIds}
                            onChange={setTaskIds}
                            loading={taskOptionsLoading}
                            placeholder={
                                projectId === ALL_OPTION
                                    ? 'All tasks (any project)'
                                    : 'All tasks'
                            }
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">From</Label>
                        <Input
                            type="date"
                            value={from}
                            onChange={(e) => setFrom(e.target.value)}
                            max={to || undefined}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">To</Label>
                        <Input
                            type="date"
                            value={to}
                            onChange={(e) => setTo(e.target.value)}
                            min={from || undefined}
                        />
                    </div>
                </div>
            </section>

            {/* --- KPI cards ------------------------------------ */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <SummaryStat
                    label="Total time"
                    seconds={total}
                    icon={Clock}
                    primary
                />
                <SummaryStat
                    label="Entries"
                    seconds={null}
                    icon={Calendar}
                    rawValue={String(entryCount)}
                />
                <SummaryStat
                    label="Avg / day"
                    seconds={avgPerDay}
                    icon={BarChart3}
                />
                <SummaryStat
                    label="Avg / active day"
                    seconds={avgPerActiveDay}
                    icon={Timer}
                />
            </div>

            {/* --- Per-user breakdown (by day / by week) --------
                Shown only when an admin has selected a single user, so
                the totals are that person's alone. */}
            {selectedUserName && (
                <section className="rounded-lg border bg-card p-3 shadow-sm sm:p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b pb-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {selectedUserName} — time by day &amp; week
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                            {formatDuration(total)} total ·{' '}
                            {from ? format(new Date(from), 'd MMM') : ''} –{' '}
                            {to ? format(new Date(to), 'd MMM yyyy') : ''}
                        </span>
                    </div>
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <div>
                            <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
                                By week (Mon–Sun)
                            </h4>
                            {weekBreakdown.length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                    No time logged in this range.
                                </p>
                            ) : (
                                <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
                                    {weekBreakdown.map((w) => (
                                        <li
                                            key={w.key}
                                            className="flex items-center justify-between px-3 py-1.5 text-sm"
                                        >
                                            <span className="text-muted-foreground">
                                                {format(w.start, 'd MMM')} –{' '}
                                                {format(w.end, 'd MMM')}
                                            </span>
                                            <span className="font-medium tabular-nums">
                                                {formatDuration(w.seconds)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        <div>
                            <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">
                                By day
                            </h4>
                            {dayBreakdown.length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                    No time logged in this range.
                                </p>
                            ) : (
                                <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
                                    {dayBreakdown.map((d) => (
                                        <li
                                            key={d.date}
                                            className="flex items-center justify-between px-3 py-1.5 text-sm"
                                        >
                                            <span className="text-muted-foreground">
                                                {format(
                                                    d.dateObj,
                                                    'EEE, d MMM yyyy',
                                                )}
                                            </span>
                                            <span className="font-medium tabular-nums">
                                                {formatDuration(d.seconds)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>
                </section>
            )}

            {/* --- Charts -------------------------------------- */}
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Charts
                </span>
                <button
                    type="button"
                    onClick={toggleAllCharts}
                    className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                    <ChevronDown
                        className={cn(
                            'h-3.5 w-3.5 transition-transform',
                            chartsCollapsed && '-rotate-90',
                        )}
                    />
                    {chartsCollapsed ? 'Expand all' : 'Collapse all'}
                </button>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <ChartCard
                    title={stackByUser ? 'Hours by user' : 'Hours by project'}
                    subtitle={
                        stackByUser
                            ? `${stats?.byUser?.length || 0} contributor${(stats?.byUser?.length || 0) === 1 ? '' : 's'} in this range`
                            : `${stats?.byProject?.length || 0} project${(stats?.byProject?.length || 0) === 1 ? '' : 's'} in this range`
                    }
                    loading={loading}
                    empty={
                        stackByUser
                            ? !stats?.byUser?.length
                            : !stats?.byProject?.length
                    }
                    emptyText="No time entries in this range yet."
                >
                    <ContributorBars
                        rows={
                            stackByUser
                                ? (stats?.byUser || []).map((u) => ({
                                      key: u.userId,
                                      name: u.name,
                                      avatarUrl: u.avatarUrl,
                                      seconds: u.seconds,
                                      color:
                                          dailyStack.lookup.get(u.userId)
                                              ?.color,
                                  }))
                                : (stats?.byProject || []).map((p) => ({
                                      key: p.projectId,
                                      name: p.name,
                                      badge: p.code || null,
                                      seconds: p.seconds,
                                      color:
                                          dailyStack.lookup.get(p.projectId)
                                              ?.color,
                                  }))
                        }
                        kind={stackByUser ? 'user' : 'project'}
                    />
                </ChartCard>

                <ChartCard
                    title="Top projects"
                    subtitle={
                        stats?.byProject?.length
                            ? `${stats.byProject.length} project${stats.byProject.length === 1 ? '' : 's'}`
                            : ''
                    }
                    loading={loading}
                    empty={!stats?.byProject?.length}
                    emptyText="No project activity in this range."
                >
                    <HorizontalBars
                        data={(stats?.byProject || []).map((p) => ({
                            key: p.projectId,
                            label: p.name,
                            badge: p.code || null,
                            seconds: p.seconds,
                        }))}
                        accent="bg-primary"
                    />
                </ChartCard>

                <ChartCard
                    title="By project type"
                    subtitle="Categorisation set in Templates"
                    loading={loading}
                    empty={!stats?.byType?.length}
                    emptyText="No project activity in this range."
                    icon={FolderKanban}
                >
                    <HorizontalBars
                        data={(stats?.byType || []).map((t) => ({
                            key: t.projectTypeId || '__none__',
                            label: t.name,
                            seconds: t.seconds,
                        }))}
                        showPercent
                        accent="bg-emerald-500"
                    />
                </ChartCard>

                <ChartCard
                    title="Hours by weekday"
                    subtitle={
                        stackByUser
                            ? "When the team logs time"
                            : 'When you log time'
                    }
                    loading={loading}
                    empty={!byWeekday.some((w) => w.seconds > 0)}
                    emptyText="No time entries in this range yet."
                    icon={Calendar}
                >
                    <HorizontalBars
                        data={byWeekday}
                        showPercent
                        accent="bg-amber-500"
                    />
                </ChartCard>

                {isStrictAdmin && (
                    <>
                        <ChartCard
                            title="Hours by client"
                            subtitle={
                                stats?.byClient?.length
                                    ? `${stats.byClient.length} client${stats.byClient.length === 1 ? '' : 's'}`
                                    : ''
                            }
                            loading={loading}
                            empty={!stats?.byClient?.length}
                            emptyText="No client-linked time in this range."
                            icon={Building2}
                        >
                            <HorizontalBars
                                data={(stats?.byClient || []).map((c) => ({
                                    key: c.clientId || c.name,
                                    label: c.name,
                                    seconds: c.seconds,
                                }))}
                                showPercent
                                accent="bg-orange-500"
                            />
                        </ChartCard>

                        <ChartCard
                            title="Hours by application"
                            subtitle={
                                stats?.byApplication?.length
                                    ? `${stats.byApplication.length} application${stats.byApplication.length === 1 ? '' : 's'}`
                                    : ''
                            }
                            loading={loading}
                            empty={!stats?.byApplication?.length}
                            emptyText="No application-linked time in this range."
                            icon={AppWindow}
                        >
                            <HorizontalBars
                                data={(stats?.byApplication || []).map((a) => ({
                                    key: a.applicationId || a.name,
                                    label: a.name,
                                    seconds: a.seconds,
                                }))}
                                showPercent
                                accent="bg-violet-500"
                            />
                        </ChartCard>
                    </>
                )}

                {isAdmin && (
                    <ChartCard
                        title="Top users"
                        subtitle={
                            stats?.byUser?.length
                                ? `${stats.byUser.length} contributor${stats.byUser.length === 1 ? '' : 's'} · ranked by total time`
                                : ''
                        }
                        loading={loading}
                        empty={!stats?.byUser?.length}
                        emptyText="No contributors in this range."
                        icon={UsersIcon}
                    >
                        <HorizontalBars
                            data={(stats?.byUser || []).map((u, i) => ({
                                key: u.userId,
                                rank: i + 1,
                                label: u.name,
                                avatarUrl: u.avatarUrl,
                                seconds: u.seconds,
                                colorHex: dailyStack.lookup.get(u.userId)
                                    ?.color,
                            }))}
                            accent="bg-sky-500"
                        />
                    </ChartCard>
                )}
            </div>
        </ChartCollapseContext.Provider>
    );
}

// ---------- chart primitives -----------------------------------------------

// Lets the Charts view drive every ChartCard's open state at once via a
// single "collapse / expand all" button. `signal` bumps on each press;
// `value` is the open-state to snap to. Cards stay individually
// toggleable afterwards.
const ChartCollapseContext = createContext({ signal: 0, value: true });

function ChartCard({
    title,
    subtitle,
    icon: Icon,
    loading,
    empty,
    emptyText,
    children,
}) {
    const { signal, value } = useContext(ChartCollapseContext);
    const [open, setOpen] = useState(true);
    useEffect(() => {
        if (!signal) return;
        setOpen(value);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signal]);
    return (
        <section
            className={cn(
                'flex flex-col rounded-lg border bg-card shadow-sm',
                open && 'min-h-[260px]',
            )}
        >
            <header
                onClick={() => setOpen((o) => !o)}
                className="flex cursor-pointer select-none items-center justify-between gap-2 border-b px-3 py-2 text-sm font-semibold sm:px-4"
            >
                <div className="flex items-center gap-2">
                    <ChevronDown
                        className={cn(
                            'h-4 w-4 text-muted-foreground transition-transform',
                            !open && '-rotate-90',
                        )}
                    />
                    {Icon && (
                        <Icon className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span>{title}</span>
                </div>
                <div className="flex items-center gap-2">
                    {subtitle && (
                        <span className="text-[11px] font-normal text-muted-foreground">
                            {subtitle}
                        </span>
                    )}
                    {loading && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                </div>
            </header>
            {open && (
                <div className="flex flex-1 flex-col p-3 sm:p-4">
                    {empty ? (
                        <div className="flex flex-1 items-center justify-center text-center text-sm text-muted-foreground">
                            {emptyText || 'No data.'}
                        </div>
                    ) : (
                        children
                    )}
                </div>
            )}
        </section>
    );
}

function RangeChip({ onClick, children }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="rounded-full border px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
            {children}
        </button>
    );
}

// "Standard workday" — bars at-or-below this stay blue, anything
// above is rendered as a red overtime overlay so the chart calls
// attention to days that ran long.
const WORKDAY_HOURS = 8;
const WORKDAY_SECONDS = WORKDAY_HOURS * 3600;

// My time tab — daily bar colour bands (rounded to 0.1h).
function myDailyBarGrade(seconds) {
    const h = Math.round((Number(seconds) / 3600) * 10) / 10;
    if (h < WORKDAY_HOURS) return 'under';
    if (h === WORKDAY_HOURS) return 'target';
    if (h > WORKDAY_HOURS + 1) return 'heavy';
    return 'warn';
}

const MY_DAILY_BAR_TONE = {
    under: {
        bar: 'bg-sky-500/85 group-hover:bg-sky-500',
        text: 'text-sky-600 dark:text-sky-400',
    },
    target: {
        bar: 'bg-emerald-500/85 group-hover:bg-emerald-500',
        text: 'text-emerald-600 dark:text-emerald-400',
    },
    warn: {
        bar: 'bg-orange-500/85 group-hover:bg-orange-500',
        text: 'text-orange-600 dark:text-orange-400',
    },
    heavy: {
        bar: 'bg-rose-500/85 group-hover:bg-rose-500',
        text: 'text-rose-600 dark:text-rose-400',
    },
};

// Vertical-bar chart with a proper Y axis (hours) and an X axis whose
// tick labels read "15 Apr" — never truncated to "15 A...". The chart
// area uses CSS for the bars (a percentage height per bar) and renders
// the axis tick labels in dedicated rows so they aren't clipped by the
// bar's column width.
//
// The Y axis is anchored to an 8-hour workday baseline. If nothing
// exceeds 8h the scale stays 0 → 8 (so a 5-hour bar visibly fills
// most of the column). The scale only grows beyond 8h when an actual
// day exceeds it, in 2-hour steps (10h, 12h, 14h…), so we never see
// a misleading 24h axis on a 6h day.
// ContributorBars — vertical bar chart with one bar per user (admin)
// or per project (non-admin / single-user view). The X-axis labels are
// the contributor names (with a tiny avatar / code chip), so a row of
// short summary cards sit underneath the chart and explain at a glance
// who logged how much.
//
// Picked over the previous "Daily hours" stacked-by-day rendering
// because that chart became unreadable with sparse data — when there's
// only one active day in a 30-day window, the chart looks empty and a
// single tiny segment appears at the right edge. This view collapses
// the time axis into per-contributor totals, which is what the user
// wanted in the first place.
function ContributorBars({ rows, kind }) {
    const sorted = [...(rows || [])].sort((a, b) => b.seconds - a.seconds);
    const total = sorted.reduce((s, r) => s + (r.seconds || 0), 0);
    const maxSeconds = Math.max(1, ...sorted.map((r) => r.seconds || 0));
    const maxHours = maxSeconds / 3600;
    const yMaxHours = niceWorkdayCeil(maxHours);
    const segments = Math.max(2, Math.min(8, Math.round(yMaxHours / 2)));
    const yTicks = buildYTicks(yMaxHours, segments);
    const yMaxSeconds = yMaxHours * 3600;
    const showWorkdayLine = yMaxHours > WORKDAY_HOURS;
    const workdayPctFromTop =
        ((yMaxHours - WORKDAY_HOURS) / yMaxHours) * 100;

    // Bars get visibly thinner as the contributor list grows. Capped so
    // even with one contributor we don't paint a full-width slab.
    const barCap = sorted.length <= 4 ? 96 : sorted.length <= 8 ? 64 : 40;

    if (sorted.length === 0) return null;

    return (
        <div className="flex flex-1 flex-col text-[10px] text-muted-foreground">
            {/* Plain-language summary so the meaning of the chart is
                visible without hovering anything. */}
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed bg-muted/20 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                <span>
                    Each bar = total hours logged in this range, one per{' '}
                    <span className="font-semibold text-foreground">
                        {kind === 'user' ? 'user' : 'project'}
                    </span>
                    . Dashed{' '}
                    <span className="font-semibold text-rose-500">
                        {WORKDAY_HOURS}h
                    </span>{' '}
                    line marks one workday for context.
                </span>
                <span className="font-medium text-foreground">
                    {(total / 3600).toFixed(1)}h total
                    <span className="font-normal text-muted-foreground">
                        {' · '}top: {sorted[0].name} (
                        {(sorted[0].seconds / 3600).toFixed(1)}h)
                    </span>
                </span>
            </div>

            {/* Plot area — Y-axis labels on the left, bars stretching
                across the rest. */}
            <div className="flex flex-1 gap-2">
                {/* The tick column is pinned to the SAME h-44 as the
                    plot area — if it stretched over the whole block
                    (which also contains the x-axis avatar labels), the
                    0h tick would land under the avatars and the bars
                    would appear to start mid-scale. */}
                <div className="relative flex h-44 w-8 shrink-0 flex-col justify-between text-right">
                    {yTicks.map((t) => (
                        <span key={t} className="font-mono leading-none">
                            {formatHourTick(t)}
                        </span>
                    ))}
                </div>
                <div className="relative flex-1 overflow-x-auto">
                    <div className="relative flex h-44 items-end justify-around gap-3">
                        {/* Horizontal gridlines live INSIDE the h-44
                            plot area so they line up with the ticks
                            AND the actual bar scale. */}
                        {yTicks.map((t, i) => (
                            <div
                                key={`grid-${t}`}
                                className="pointer-events-none absolute left-0 right-0 z-0 border-t border-dashed border-muted-foreground/20"
                                style={{
                                    top: `${((yTicks.length - 1 - i) / (yTicks.length - 1)) * 100}%`,
                                }}
                            />
                        ))}
                        {showWorkdayLine && (
                            <div
                                className="pointer-events-none absolute left-0 right-0 z-0 border-t border-dashed border-rose-400/70"
                                style={{ top: `${workdayPctFromTop}%` }}
                                title={`${WORKDAY_HOURS}h workday`}
                            >
                                <span className="absolute -top-3 right-0 rounded-sm bg-card/80 px-1 text-[9px] font-medium uppercase tracking-wide text-rose-500">
                                    {WORKDAY_HOURS}h
                                </span>
                            </div>
                        )}
                        {sorted.map((r) => {
                            const pct = (r.seconds / yMaxSeconds) * 100;
                            const hours = r.seconds / 3600;
                            const tooltip = `${r.name} · ${hours.toFixed(2)}h${r.badge ? ` · ${r.badge}` : ''}`;
                            const showInsideLabel = pct >= 12;
                            return (
                                <div
                                    key={r.key}
                                    className="group relative z-10 flex h-full flex-col items-center justify-end"
                                    style={{
                                        width: `${barCap}px`,
                                        maxWidth: `${barCap}px`,
                                    }}
                                    title={tooltip}
                                >
                                    {/* Hours label that hovers above
                                        the bar (or sits inside it for
                                        very tall bars). */}
                                    {!showInsideLabel && r.seconds > 0 && (
                                        <span
                                            className="mb-0.5 text-[10px] font-semibold text-foreground"
                                            style={{
                                                marginBottom: 2,
                                            }}
                                        >
                                            {hours.toFixed(1)}h
                                        </span>
                                    )}
                                    <div
                                        className="w-full rounded-t-md transition-all group-hover:opacity-90"
                                        style={{
                                            height: `${Math.max(pct, r.seconds > 0 ? 2 : 0)}%`,
                                            minHeight: r.seconds > 0 ? 4 : 0,
                                            background:
                                                r.color || 'hsl(var(--primary))',
                                        }}
                                    >
                                        {showInsideLabel && (
                                            <div className="flex h-full items-start justify-center pt-1 text-[10px] font-bold text-white drop-shadow-sm">
                                                {hours.toFixed(1)}h
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    {/* X-axis line under the bars. */}
                    <div className="h-1.5 border-t border-muted-foreground/40" />

                    {/* X-axis labels — one per bar, with a tiny
                        avatar for users / a code chip for projects so
                        admins can scan the chart visually as well as
                        textually. */}
                    <div className="mt-1 flex justify-around gap-3">
                        {sorted.map((r) => (
                            <div
                                key={`label-${r.key}`}
                                className="flex flex-col items-center gap-0.5 text-center"
                                style={{
                                    width: `${barCap}px`,
                                    maxWidth: `${barCap}px`,
                                }}
                                title={r.name}
                            >
                                {kind === 'user' ? (
                                    <Avatar className="h-5 w-5">
                                        {r.avatarUrl && (
                                            <AvatarImage
                                                src={resolveAssetUrl(
                                                    r.avatarUrl,
                                                )}
                                                alt=""
                                            />
                                        )}
                                        <AvatarFallback className="text-[8px]">
                                            {initials(r.name)}
                                        </AvatarFallback>
                                    </Avatar>
                                ) : (
                                    r.badge && (
                                        <span className="rounded border bg-muted/40 px-1 py-px font-mono text-[9px] uppercase text-muted-foreground">
                                            {r.badge}
                                        </span>
                                    )
                                )}
                                <span
                                    className="line-clamp-2 text-[10px] leading-tight text-foreground"
                                    style={{
                                        wordBreak: 'break-word',
                                    }}
                                >
                                    {r.name}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div className="mt-1 flex items-center justify-between gap-2 px-1 text-[9px] uppercase tracking-wide text-muted-foreground/70">
                <span>Hours</span>
                <span>{kind === 'user' ? 'User' : 'Project'}</span>
            </div>
        </div>
    );
}

function DailyBars({ data, breakdown, breakdownLookup, breakdownLabel }) {
    const maxSeconds = Math.max(1, ...data.map((d) => d.seconds));
    const maxHours = maxSeconds / 3600;
    const yMaxHours = niceWorkdayCeil(maxHours);
    const segments = Math.max(2, Math.min(8, Math.round(yMaxHours / 2)));
    const yTicks = buildYTicks(yMaxHours, segments);
    const yMaxSeconds = yMaxHours * 3600;
    const workdayPctFromTop = ((yMaxHours - WORKDAY_HOURS) / yMaxHours) * 100;
    const showWorkdayLine = yMaxHours > WORKDAY_HOURS;

    const targetTicks = 8;
    const ideal = Math.max(1, Math.round(data.length / targetTicks));
    const candidates = [1, 2, 3, 5, 7, 14, 30];
    const everyN =
        candidates.find((c) => c >= ideal) || candidates[candidates.length - 1];

    const totalSeconds = data.reduce((sum, d) => sum + (d.seconds || 0), 0);
    const totalHours = totalSeconds / 3600;
    const activeDays = data.filter((d) => (d.seconds || 0) > 0).length;
    const peak = data.reduce(
        (best, d) =>
            (d.seconds || 0) > (best?.seconds || 0) ? d : best,
        null,
    );

    // Legend entries sorted by total descending so the dominant
    // contributor reads first. We only render a legend when we
    // actually have a breakdown — otherwise we fall back to the simple
    // single-colour explainer of the original chart.
    const legendEntries = breakdownLookup
        ? Array.from(breakdownLookup.entries())
              .map(([key, meta]) => ({ key, ...meta }))
              .sort((a, b) => b.seconds - a.seconds)
        : [];
    const hasBreakdown = legendEntries.length > 0;
    const stackedNoun = breakdownLabel === 'user' ? 'users' : 'projects';

    return (
        <div className="flex flex-1 flex-col text-[10px] text-muted-foreground">
            {/* Top explainer + KPIs. */}
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed bg-muted/20 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                <span>
                    {hasBreakdown ? (
                        <>
                            Each bar = hours logged that day, stacked by{' '}
                            <span className="font-semibold text-foreground">
                                {stackedNoun}
                            </span>
                            . Hover a segment for the breakdown. Dashed{' '}
                            <span className="font-semibold text-rose-500">
                                {WORKDAY_HOURS}h
                            </span>{' '}
                            line marks one workday.
                        </>
                    ) : (
                        <>
                            Each bar = hours logged that day. Dashed{' '}
                            <span className="font-semibold text-rose-500">
                                {WORKDAY_HOURS}h
                            </span>{' '}
                            line marks one workday.
                        </>
                    )}
                </span>
                <span className="font-medium text-foreground">
                    {totalHours.toFixed(1)}h total
                    {activeDays > 0 && (
                        <span className="font-normal text-muted-foreground">
                            {' '}
                            · {activeDays} active day
                            {activeDays === 1 ? '' : 's'}
                        </span>
                    )}
                    {peak && peak.seconds > 0 && (
                        <span className="font-normal text-muted-foreground">
                            {' '}
                            · peak {(peak.seconds / 3600).toFixed(1)}h on{' '}
                            {format(
                                new Date(`${peak.date}T00:00:00`),
                                'd MMM',
                            )}
                        </span>
                    )}
                </span>
            </div>

            {/* Colour legend — only when stacked. Wraps freely so
                long names just continue on the next row. */}
            {hasBreakdown && (
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
                    {legendEntries.map((e) => (
                        <span
                            key={e.key}
                            className="inline-flex items-center gap-1"
                            title={`${e.name} · ${(e.seconds / 3600).toFixed(2)}h`}
                        >
                            <span
                                aria-hidden
                                className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                                style={{ background: e.color }}
                            />
                            <span className="text-foreground">{e.name}</span>
                            <span className="tabular-nums text-muted-foreground">
                                {(e.seconds / 3600).toFixed(1)}h
                            </span>
                        </span>
                    ))}
                </div>
            )}

            <div className="flex flex-1 gap-2">
                {/* Same h-44 pinning as the by-user chart: ticks and
                    gridlines must measure the PLOT area only, not the
                    block that also contains the x-axis labels. */}
                <div className="relative flex h-44 w-8 shrink-0 flex-col justify-between text-right">
                    {yTicks.map((t) => (
                        <span key={t} className="font-mono leading-none">
                            {formatHourTick(t)}
                        </span>
                    ))}
                </div>
                <div className="relative flex-1">
                    <div className="relative flex h-44 items-end gap-[2px]">
                        {yTicks.map((t, i) => (
                            <div
                                key={`grid-${t}`}
                                className="pointer-events-none absolute left-0 right-0 z-0 border-t border-dashed border-muted-foreground/20"
                                style={{
                                    top: `${((yTicks.length - 1 - i) / (yTicks.length - 1)) * 100}%`,
                                }}
                            />
                        ))}
                        {showWorkdayLine && (
                            <div
                                className="pointer-events-none absolute left-0 right-0 z-0 border-t border-dashed border-rose-400/70"
                                style={{ top: `${workdayPctFromTop}%` }}
                                title={`${WORKDAY_HOURS}h workday`}
                            >
                                <span className="absolute -top-3 right-0 rounded-sm bg-card/80 px-1 text-[9px] font-medium uppercase tracking-wide text-rose-500">
                                    {WORKDAY_HOURS}h
                                </span>
                            </div>
                        )}
                        {data.map((d) => {
                            const total = d.seconds || 0;
                            const totalHoursForDay = total / 3600;
                            const dt = new Date(`${d.date}T00:00:00`);
                            const segs =
                                hasBreakdown
                                    ? breakdown.get(d.date) || []
                                    : null;
                            const isOvertime = total > WORKDAY_SECONDS;
                            const tooltipLines = [
                                format(dt, 'EEE d MMM yyyy'),
                                `${totalHoursForDay.toFixed(2)}h total`,
                            ];
                            if (segs && segs.length > 0) {
                                for (const s of segs) {
                                    tooltipLines.push(
                                        `${s.name}: ${(s.seconds / 3600).toFixed(2)}h`,
                                    );
                                }
                            }
                            if (isOvertime) {
                                tooltipLines.push(
                                    `${((total - WORKDAY_SECONDS) / 3600).toFixed(2)}h over ${WORKDAY_HOURS}h`,
                                );
                            }
                            return (
                                <div
                                    key={d.date}
                                    className="group relative z-10 flex flex-1 flex-col items-stretch justify-end"
                                    title={tooltipLines.join('\n')}
                                >
                                    {/* When we have a breakdown, render
                                        each segment from the bottom up
                                        in the segment's own colour. The
                                        rose 8h reference line still
                                        sits behind the stack so days
                                        that exceed it are obvious. */}
                                    {segs && segs.length > 0
                                        ? (() => {
                                              // Top segment gets the
                                              // rounded corner; everyone
                                              // below stays square so
                                              // the stack reads as one
                                              // continuous bar.
                                              const lastIdx =
                                                  segs.length - 1;
                                              return segs.map(
                                                  (s, idx) => {
                                                      const pct =
                                                          (s.seconds /
                                                              yMaxSeconds) *
                                                          100;
                                                      return (
                                                          <div
                                                              key={s.key}
                                                              className={cn(
                                                                  'transition-all group-hover:opacity-90',
                                                                  idx ===
                                                                      lastIdx &&
                                                                      'rounded-t-sm',
                                                              )}
                                                              style={{
                                                                  background:
                                                                      s.color,
                                                                  height: `${Math.max(pct, s.seconds > 0 ? 1 : 0)}%`,
                                                                  minHeight:
                                                                      s.seconds >
                                                                      0
                                                                          ? 2
                                                                          : 0,
                                                              }}
                                                          />
                                                      );
                                                  },
                                              );
                                          })()
                                        : total > 0 && (
                                              // Fallback (no breakdown)
                                              // — the original blue
                                              // bar with a red overtime
                                              // cap, kept so the chart
                                              // still reads cleanly when
                                              // /stats hasn't been
                                              // refreshed yet.
                                              <>
                                                  {isOvertime && (
                                                      <div
                                                          className="rounded-t-sm bg-rose-500/80 transition-all group-hover:bg-rose-500"
                                                          style={{
                                                              height: `${((total - WORKDAY_SECONDS) / yMaxSeconds) * 100}%`,
                                                              minHeight: 2,
                                                          }}
                                                      />
                                                  )}
                                                  <div
                                                      className={cn(
                                                          'transition-all',
                                                          isOvertime
                                                              ? 'bg-primary/70 group-hover:bg-primary'
                                                              : 'rounded-t-sm bg-primary/70 group-hover:bg-primary',
                                                      )}
                                                      style={{
                                                          height: `${Math.max((Math.min(total, WORKDAY_SECONDS) / yMaxSeconds) * 100, 3)}%`,
                                                          minHeight: 2,
                                                      }}
                                                  />
                                              </>
                                          )}
                                    {total === 0 && (
                                        <div
                                            className="rounded-sm bg-muted/30"
                                            style={{ height: 1 }}
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <div className="relative h-1.5 border-t border-muted-foreground/40">
                        {data.map((d, i) => {
                            if (i % everyN !== 0 && i !== data.length - 1)
                                return null;
                            const left = ((i + 0.5) / data.length) * 100;
                            return (
                                <span
                                    key={`tick-${d.date}`}
                                    className="absolute top-0 h-1.5 w-px bg-muted-foreground/40"
                                    style={{ left: `${left}%` }}
                                />
                            );
                        })}
                    </div>
                    <div className="relative h-4">
                        {data.map((d, i) => {
                            if (i % everyN !== 0 && i !== data.length - 1)
                                return null;
                            const left = ((i + 0.5) / data.length) * 100;
                            const dt = new Date(`${d.date}T00:00:00`);
                            return (
                                <span
                                    key={`label-${d.date}`}
                                    className="absolute top-0 -translate-x-1/2 whitespace-nowrap font-mono"
                                    style={{ left: `${left}%` }}
                                >
                                    {format(dt, 'd MMM')}
                                </span>
                            );
                        })}
                    </div>
                </div>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 px-1 text-[9px] uppercase tracking-wide text-muted-foreground/70">
                <span>Hours</span>
                <span>Date</span>
            </div>
        </div>
    );
}

// Stable colour palette used by the stacked Daily Hours chart and the
// Top users / Top projects cards. Hand-picked for high contrast on
// both light and dark backgrounds; first colour goes to whoever has
// the most hours in the range so the dominant contributor always
// reads as the "primary" colour.
const STACK_PALETTE = [
    '#0ea5e9', // sky-500
    '#10b981', // emerald-500
    '#f59e0b', // amber-500
    '#8b5cf6', // violet-500
    '#ef4444', // rose-500
    '#06b6d4', // cyan-500
    '#84cc16', // lime-500
    '#d946ef', // fuchsia-500
    '#6366f1', // indigo-500
    '#f97316', // orange-500
];
const OTHERS_COLOR = '#94a3b8'; // slate-400, used for the "Others" bucket.
const MAX_LEGEND_KEYS = 8;

// Builds the data the stacked Daily Hours chart needs:
//   - `breakdown`: a Map<date, [{key, seconds, color}]> with one entry
//     per (day, key). Keys outside the top N are folded into a single
//     "__others__" bucket so the legend stays readable.
//   - `lookup`: a Map<key, { name, color, avatarUrl, seconds }> driving
//     the legend strip and tooltips. Includes an "__others__" entry
//     when there are more than MAX_LEGEND_KEYS contributors.
//
// `stackByUser` switches between the user and project axes; the data
// shape is identical so DailyBars doesn't need to care.
function buildDailyStack({ stackByUser, stats }) {
    const empty = { breakdown: new Map(), lookup: new Map(), label: 'project' };
    if (!stats) return empty;

    const dayRows = stackByUser ? stats.byDayUser : stats.byDayProject;
    if (!Array.isArray(dayRows) || dayRows.length === 0) return empty;

    const keyOf = (row) => (stackByUser ? row.userId : row.projectId);
    const refList = stackByUser ? stats.byUser : stats.byProject;
    const nameOf = (k) => {
        if (!Array.isArray(refList)) return 'Unknown';
        if (stackByUser) {
            const u = refList.find((r) => r.userId === k);
            return u?.name || 'Unknown';
        }
        const p = refList.find((r) => r.projectId === k);
        return p?.name || 'Unknown project';
    };
    const avatarOf = (k) => {
        if (!stackByUser || !Array.isArray(refList)) return null;
        const u = refList.find((r) => r.userId === k);
        return u?.avatarUrl || null;
    };

    // Aggregate totals per key so we can pick the top N.
    const totals = new Map();
    for (const row of dayRows) {
        const k = keyOf(row);
        if (!k) continue;
        totals.set(k, (totals.get(k) || 0) + (row.seconds || 0));
    }
    const sortedKeys = Array.from(totals.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k);

    const topKeys = sortedKeys.slice(0, MAX_LEGEND_KEYS);
    const topSet = new Set(topKeys);
    const overflow = sortedKeys.length > MAX_LEGEND_KEYS;

    const lookup = new Map();
    topKeys.forEach((k, i) => {
        lookup.set(k, {
            name: nameOf(k),
            color: STACK_PALETTE[i % STACK_PALETTE.length],
            avatarUrl: avatarOf(k),
            seconds: totals.get(k) || 0,
        });
    });
    if (overflow) {
        const othersTotal = sortedKeys
            .slice(MAX_LEGEND_KEYS)
            .reduce((s, k) => s + (totals.get(k) || 0), 0);
        lookup.set('__others__', {
            name: `Others (${sortedKeys.length - MAX_LEGEND_KEYS})`,
            color: OTHERS_COLOR,
            avatarUrl: null,
            seconds: othersTotal,
        });
    }

    // Pivot per-day per-key, folding overflow keys into __others__.
    const breakdown = new Map();
    for (const row of dayRows) {
        const k = keyOf(row);
        if (!k) continue;
        const target = topSet.has(k) ? k : '__others__';
        const meta = lookup.get(target);
        if (!meta) continue; // shouldn't happen — defensive
        const list = breakdown.get(row.date) || [];
        const existing = list.find((s) => s.key === target);
        if (existing) existing.seconds += row.seconds || 0;
        else
            list.push({
                key: target,
                seconds: row.seconds || 0,
                color: meta.color,
                name: meta.name,
            });
        breakdown.set(row.date, list);
    }
    // Sort segments inside each day by seconds desc — the largest
    // contributor always lives at the bottom of the stack.
    for (const [d, list] of breakdown) {
        list.sort((a, b) => b.seconds - a.seconds);
        breakdown.set(d, list);
    }

    return { breakdown, lookup, label: stackByUser ? 'user' : 'project' };
}

// Anchor the Y axis to a standard 8-hour workday. If nothing in the
// window exceeds 8h we keep 8h as the ceiling — this keeps a 6h day
// looking like a tall bar instead of a quarter-full one. The axis only
// grows when an actual day exceeds 8h, in 2h steps so labels stay on
// whole hours (10, 12, 14, 16…).
function niceWorkdayCeil(n) {
    if (n <= WORKDAY_HOURS) return WORKDAY_HOURS;
    return Math.ceil(n / 2) * 2;
}

// Build N+1 evenly spaced ticks from 0 to max, returned high-to-low so
// the topmost label is the maximum (matches the Y-axis rendering).
function buildYTicks(max, segments) {
    const ticks = [];
    for (let i = 0; i <= segments; i += 1) {
        ticks.push((max * (segments - i)) / segments);
    }
    return ticks;
}

// "8h" / "30m" / "1h 30m" — keeps the Y axis legible without duplicating
// the bigger formatDuration() format used in totals.
function formatHourTick(hours) {
    if (hours === 0) return '0h';
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (Number.isInteger(hours)) return `${hours}h`;
    return `${hours.toFixed(1)}h`;
}

// Horizontal-bar list. Each row: label on the left (with optional code
// chip / avatar / rank), bar in the middle, h:m duration on the right.
// When `row.colorHex` is provided the bar uses that exact colour
// (matches the colour the same key gets in the stacked Daily Hours
// chart so admins can scan across both at a glance).
function HorizontalBars({ data, accent = 'bg-primary', showPercent }) {
    const max = Math.max(1, ...data.map((d) => d.seconds));
    const total = data.reduce((s, d) => s + d.seconds, 0) || 1;
    return (
        <ul className="flex flex-1 flex-col gap-2">
            {data.map((row) => {
                const pct = (row.seconds / max) * 100;
                const share = Math.round((row.seconds / total) * 100);
                return (
                    <li
                        key={row.key}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm"
                    >
                        <div className="min-w-0 space-y-1">
                            <div className="flex min-w-0 items-center gap-1.5 text-xs">
                                {typeof row.rank === 'number' && (
                                    <span
                                        className={cn(
                                            'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold tabular-nums',
                                            row.rank === 1 &&
                                                'bg-amber-400 text-amber-950',
                                            row.rank === 2 &&
                                                'bg-slate-300 text-slate-900',
                                            row.rank === 3 &&
                                                'bg-amber-700/80 text-amber-50',
                                            row.rank > 3 &&
                                                'bg-muted text-muted-foreground',
                                        )}
                                    >
                                        {row.rank}
                                    </span>
                                )}
                                {row.colorHex && (
                                    <span
                                        aria-hidden
                                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                                        style={{
                                            background: row.colorHex,
                                        }}
                                    />
                                )}
                                {row.avatarUrl ? (
                                    <Avatar className="h-4 w-4">
                                        <AvatarImage
                                            src={resolveAssetUrl(
                                                row.avatarUrl,
                                            )}
                                            alt=""
                                        />
                                        <AvatarFallback className="text-[8px]">
                                            {initials(row.label)}
                                        </AvatarFallback>
                                    </Avatar>
                                ) : null}
                                {row.badge && (
                                    <span className="rounded border bg-muted/40 px-1 py-px font-mono text-[9px] uppercase text-muted-foreground">
                                        {row.badge}
                                    </span>
                                )}
                                <span className="truncate" title={row.label}>
                                    {row.label}
                                </span>
                                {showPercent && (
                                    <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                                        {share}%
                                    </span>
                                )}
                            </div>
                            <div className="h-2 w-full overflow-hidden rounded bg-muted/40">
                                <div
                                    className={cn(
                                        'h-full rounded',
                                        !row.colorHex && accent,
                                    )}
                                    style={{
                                        width: `${Math.max(pct, row.seconds > 0 ? 2 : 0)}%`,
                                        ...(row.colorHex
                                            ? { background: row.colorHex }
                                            : {}),
                                    }}
                                />
                            </div>
                        </div>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                            {formatDuration(row.seconds)}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}

function toDateInput(d) {
    const dt = d instanceof Date ? d : new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
