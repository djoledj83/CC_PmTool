import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
} from 'react';
import { Link } from 'react-router-dom';
import { format, formatDistanceToNowStrict, isPast, isToday } from 'date-fns';
import {
    AlertTriangle,
    Archive,
    BarChart3,
    Briefcase,
    Building2,
    CalendarClock,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Clock,
    FolderKanban,
    Globe,
    Inbox,
    Layers,
    Package,
    PauseCircle,
    PieChart,
    Sparkles,
    Tag,
    Target,
    Ticket,
    Timer,
    Trophy,
    Users as UsersIcon,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { CAPABILITIES, hasCapability } from '@/lib/capabilities';
import { TopBar } from '@/components/TopBar';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import DonutChart from '@/components/DonutChart';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

// Maps the Tailwind bar classes used in the *_META tables to hex so the
// SVG donut slices match the existing bar colours exactly.
const BAR_HEX = {
    'bg-slate-400': '#94a3b8',
    'bg-sky-500': '#0ea5e9',
    'bg-blue-500': '#3b82f6',
    'bg-indigo-500': '#6366f1',
    'bg-violet-500': '#8b5cf6',
    'bg-emerald-500': '#10b981',
    'bg-amber-500': '#f59e0b',
    'bg-orange-500': '#f97316',
    'bg-rose-500': '#f43f5e',
    'bg-rose-600': '#e11d48',
};
const barHex = (bar) => BAR_HEX[bar] || '#94a3b8';

// Broadcasts a "collapse/expand all cards" command to every ChartCard on
// the current tab. `signal` bumps on each bulk action; `collapsed` is the
// desired state. Cards still keep their own per-card chevron.
const CollapseCtx = createContext(null);

// Rotating palettes for the generic breakdown charts (owner/client/etc.)
// where categories are dynamic and have no fixed colour meaning.
const BAR_PALETTE = [
    'bg-sky-500',
    'bg-emerald-500',
    'bg-amber-500',
    'bg-violet-500',
    'bg-rose-500',
    'bg-blue-500',
    'bg-orange-500',
    'bg-indigo-500',
    'bg-slate-400',
    'bg-rose-600',
];
const DONUT_PALETTE = [
    '#0ea5e9',
    '#10b981',
    '#f59e0b',
    '#8b5cf6',
    '#f43f5e',
    '#3b82f6',
    '#f97316',
    '#6366f1',
    '#94a3b8',
    '#e11d48',
];

const PROJECT_STATUS_META = {
    TODO: {
        label: 'To do',
        bar: 'bg-slate-400',
        ring: 'bg-slate-100 text-slate-700 dark:bg-slate-500/10 dark:text-slate-300',
    },
    IN_PROGRESS: {
        label: 'In progress',
        bar: 'bg-sky-500',
        ring: 'bg-sky-100 text-sky-800 dark:bg-sky-500/10 dark:text-sky-300',
    },
    DONE: {
        label: 'Done',
        bar: 'bg-emerald-500',
        ring: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300',
    },
    ON_HOLD: {
        label: 'On hold',
        bar: 'bg-amber-500',
        ring: 'bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300',
    },
};

const PROJECT_PRIORITY_META = {
    LOW: { label: 'Low', bar: 'bg-slate-400' },
    MEDIUM: { label: 'Medium', bar: 'bg-sky-500' },
    HIGH: { label: 'High', bar: 'bg-orange-500' },
    URGENT: { label: 'Urgent', bar: 'bg-rose-600' },
};

const TASK_STATUS_META = {
    TODO: { label: 'To do', bar: 'bg-slate-400' },
    IN_PROGRESS: { label: 'In progress', bar: 'bg-sky-500' },
    DONE: { label: 'Done', bar: 'bg-emerald-500' },
};

// Ticket dimension metadata — labels + bar colours mirror the agent
// workspace so the Insights dashboard reads the same as /tickets. Keys
// match the Prisma enums (TicketStatus / TicketPriority / TicketType).
const TICKET_STATUS_META = {
    NEW: { label: 'New', bar: 'bg-sky-500' },
    OPEN: { label: 'Open', bar: 'bg-blue-500' },
    IN_PROGRESS: { label: 'In progress', bar: 'bg-indigo-500' },
    PENDING: { label: 'Pending', bar: 'bg-amber-500' },
    RESOLVED: { label: 'Resolved', bar: 'bg-emerald-500' },
    CLOSED: { label: 'Closed', bar: 'bg-slate-400' },
};

const TICKET_PRIORITY_META = {
    LOW: { label: 'Low', bar: 'bg-slate-400' },
    NORMAL: { label: 'Normal', bar: 'bg-sky-500' },
    HIGH: { label: 'High', bar: 'bg-orange-500' },
    URGENT: { label: 'Urgent', bar: 'bg-rose-600' },
};

const TICKET_CATEGORY_META = {
    INCIDENT: { label: 'Incident', bar: 'bg-rose-500' },
    REQUEST: { label: 'Request', bar: 'bg-sky-500' },
    QUESTION: { label: 'Question', bar: 'bg-violet-500' },
    PROBLEM: { label: 'Problem', bar: 'bg-amber-500' },
};

// Seconds → compact human duration ("2d 4h", "5h 12m", "8m").
function fmtDuration(s) {
    if (s == null) return '—';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${Math.round(s)}s`;
}

// Turn an enum→count map into ordered BarBreakdown rows using the meta's
// key order (so statuses always render New→Closed, etc).
function ticketRows(obj, meta) {
    const order = Object.keys(meta);
    return Object.keys(obj || {})
        .sort((a, b) => {
            const ia = order.indexOf(a);
            const ib = order.indexOf(b);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        })
        .map((k) => ({
            key: k,
            label: meta[k]?.label || k,
            bar: meta[k]?.bar,
            count: obj[k],
        }));
}

// Same, but shaped for DonutChart (hex colour instead of a bar class).
function ticketDonutRows(obj, meta) {
    return ticketRows(obj, meta).map((r) => ({
        key: r.key,
        label: r.label,
        count: r.count,
        color: barHex(r.bar),
    }));
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

function dueClass(d) {
    if (!d) return 'text-muted-foreground';
    const date = new Date(d);
    if (isPast(date) && !isToday(date)) return 'text-destructive';
    if (isToday(date)) return 'text-amber-600 dark:text-amber-400';
    return 'text-muted-foreground';
}

export default function Insights() {
    const { user } = useAuth();
    // Admins ALWAYS get the workspace view + user picker. Plain users
    // with the `insights:view:all` capability override also get the
    // same powers — the backend already short-circuits that case in
    // /api/insights, so we just mirror the gate here so the picker
    // actually renders for capability holders too. Without this
    // mirror the cap was effectively dead UI-wise.
    const canViewAllInsights =
        user?.role === 'ADMIN' ||
        hasCapability(user, CAPABILITIES.INSIGHTS_VIEW_ALL);

    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    const [tab, setTab] = useState('projects');

    // User picker (admins + insights:view:all holders only). 'all'
    // means workspace-wide; any other value is a user id whose view we
    // want to inspect.
    const [scopeUserId, setScopeUserId] = useState('all');
    const [users, setUsers] = useState([]);

    // Team filter — applies to all three tabs. 'all' = no team filter.
    // Projects: the team is attached to the project; Tasks: assigned to a
    // team member; Tickets: the ticket's team.
    const [teamId, setTeamId] = useState('all');
    const [teams, setTeams] = useState([]);

    // Reporting period: 'all' | 'month' (this month) | 'last15' | 'custom'.
    // Applies to both tabs — figures count items created in the window.
    const [range, setRange] = useState('all');
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState('');

    // Bulk collapse/expand for all chart cards on the active tab. The signal
    // bumps on each click; ChartCards listen and sync. Reset to "expanded"
    // whenever the tab changes so a fresh tab always starts open.
    const [collapseSignal, setCollapseSignal] = useState(0);
    const [allCollapsed, setAllCollapsed] = useState(false);
    const toggleAll = () => {
        setAllCollapsed((c) => !c);
        setCollapseSignal((s) => s + 1);
    };
    useEffect(() => {
        setAllCollapsed(false);
    }, [tab]);
    const { from, to } = useMemo(() => {
        const now = new Date();
        const lastNDays = { last7: 7, last15: 15, last30: 30 }[range];
        if (lastNDays) {
            const start = new Date(now);
            start.setDate(start.getDate() - lastNDays);
            return { from: start.toISOString(), to: now.toISOString() };
        }
        if (range === 'custom') {
            return {
                from: customFrom
                    ? new Date(`${customFrom}T00:00:00`).toISOString()
                    : undefined,
                to: customTo
                    ? new Date(`${customTo}T23:59:59`).toISOString()
                    : undefined,
            };
        }
        return { from: undefined, to: undefined };
    }, [range, customFrom, customTo]);

    useEffect(() => {
        if (!canViewAllInsights) return;
        api.get('/users')
            .then((res) => setUsers(res.data.users || []))
            .catch(() => {});
    }, [canViewAllInsights]);

    // Teams for the Team filter. Available to everyone who can reach the
    // endpoint; if it's not accessible the list stays empty and the filter
    // simply doesn't render.
    useEffect(() => {
        api.get('/teams')
            .then((res) => setTeams(res.data.teams || res.data || []))
            .catch(() => setTeams([]));
    }, []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        const params = {};
        if (canViewAllInsights && scopeUserId !== 'all') {
            params.userId = scopeUserId;
        }
        if (from) params.from = from;
        if (to) params.to = to;
        if (teamId !== 'all') params.teamId = teamId;
        api.get('/insights', { params })
            .then((res) => {
                if (!cancelled) setData(res.data);
            })
            .catch((e) => {
                if (!cancelled) setErr(e.response?.data?.error || 'Failed to load');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [canViewAllInsights, scopeUserId, from, to, teamId]);

    // The "Viewing" picker applies to both tabs: on Projects it scopes
    // the /insights dashboard; on Tickets it scopes the "My tickets"
    // block (the workspace block stays workspace-wide).
    const headerActions = (
        <div className="flex flex-wrap items-center gap-2">
            {canViewAllInsights && (
                <>
                    <span className="hidden text-xs text-muted-foreground sm:block">
                        Viewing
                    </span>
                    <Select value={scopeUserId} onValueChange={setScopeUserId}>
                        <SelectTrigger className="h-9 w-[200px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">
                                All users (workspace)
                            </SelectItem>
                            {user?.id && (
                                <SelectItem value={user.id}>Just me</SelectItem>
                            )}
                            {users
                                .filter((u) => u.id !== user?.id)
                                .map((u) => (
                                    <SelectItem key={u.id} value={u.id}>
                                        {u.name || u.email}
                                    </SelectItem>
                                ))}
                        </SelectContent>
                    </Select>
                </>
            )}
            {teams.length > 0 && (
                <>
                    <span className="hidden text-xs text-muted-foreground sm:block">
                        Team
                    </span>
                    <Select value={teamId} onValueChange={setTeamId}>
                        <SelectTrigger className="h-9 w-[160px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All teams</SelectItem>
                            {teams.map((t) => (
                                <SelectItem key={t.id} value={t.id}>
                                    {t.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </>
            )}
            <span className="hidden text-xs text-muted-foreground sm:block">
                Period
            </span>
            <Select value={range} onValueChange={setRange}>
                <SelectTrigger className="h-9 w-[150px]">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="all">All time</SelectItem>
                    <SelectItem value="last7">Last 7 days</SelectItem>
                    <SelectItem value="last15">Last 15 days</SelectItem>
                    <SelectItem value="last30">Last 30 days</SelectItem>
                    <SelectItem value="custom">Custom range</SelectItem>
                </SelectContent>
            </Select>
            {range === 'custom' && (
                <div className="flex items-center gap-1.5">
                    <input
                        type="date"
                        value={customFrom}
                        max={customTo || undefined}
                        onChange={(e) => setCustomFrom(e.target.value)}
                        className="h-9 rounded-md border bg-background px-2 text-sm"
                    />
                    <span className="text-xs text-muted-foreground">to</span>
                    <input
                        type="date"
                        value={customTo}
                        min={customFrom || undefined}
                        onChange={(e) => setCustomTo(e.target.value)}
                        className="h-9 rounded-md border bg-background px-2 text-sm"
                    />
                </div>
            )}
        </div>
    );

    return (
        <>
            <TopBar title="Insights" actions={headerActions} />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <div className="inline-flex rounded-lg border bg-card p-1 shadow-sm">
                        <TabButton
                            active={tab === 'projects'}
                            onClick={() => setTab('projects')}
                            icon={Briefcase}
                        >
                            Projects
                        </TabButton>
                        <TabButton
                            active={tab === 'tasks'}
                            onClick={() => setTab('tasks')}
                            icon={Layers}
                        >
                            Tasks
                        </TabButton>
                        <TabButton
                            active={tab === 'tickets'}
                            onClick={() => setTab('tickets')}
                            icon={Ticket}
                        >
                            Tickets
                        </TabButton>
                    </div>
                    <button
                        type="button"
                        onClick={toggleAll}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-3 text-sm text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
                    >
                        {allCollapsed ? (
                            <ChevronDown className="h-4 w-4" />
                        ) : (
                            <ChevronUp className="h-4 w-4" />
                        )}
                        {allCollapsed ? 'Expand all' : 'Collapse all'}
                    </button>
                </div>

                <CollapseCtx.Provider
                    value={{ signal: collapseSignal, collapsed: allCollapsed }}
                >
                {tab === 'projects' || tab === 'tasks' ? (
                    loading ? (
                        <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground shadow-sm">
                            Crunching the numbers...
                        </div>
                    ) : err ? (
                        <div className="rounded-lg border bg-card p-10 text-center text-sm text-destructive shadow-sm">
                            {err}
                        </div>
                    ) : (
                        <Dashboard data={data} section={tab} />
                    )
                ) : (
                    <TicketInsights
                        from={from}
                        to={to}
                        teamId={teamId !== 'all' ? teamId : null}
                        scopeUserId={
                            canViewAllInsights && scopeUserId !== 'all'
                                ? scopeUserId
                                : null
                        }
                        scopeLabel={
                            canViewAllInsights &&
                            scopeUserId !== 'all' &&
                            scopeUserId !== user?.id
                                ? `${
                                      users.find((u) => u.id === scopeUserId)
                                          ?.name || 'User'
                                  }'s tickets`
                                : 'My tickets'
                        }
                    />
                )}
                </CollapseCtx.Provider>
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

// Gantt-style resource-planning timeline. One row per open task, a bar
// from creation → deadline positioned on a shared time axis. Tasks with no
// deadline run open-ended to today (dashed) and can be toggled off. Caps
// the visible list to ~10 rows then scrolls.
const GANTT_STATUS_BAR = {
    TODO: 'bg-slate-400',
    IN_PROGRESS: 'bg-sky-500',
    ON_HOLD: 'bg-amber-500',
    DONE: 'bg-emerald-500',
};
const GANTT_DAY = 86400000;
const GANTT_RANGES = [
    { key: 'auto', label: 'Fit all tasks' },
    { key: '7d', label: 'Next 7 days' },
    { key: 'month', label: 'This month' },
    { key: '4w', label: 'Next 4 weeks' },
    { key: '8w', label: 'Next 8 weeks' },
    { key: '12w', label: 'Next 12 weeks' },
    { key: '6m', label: 'Next 6 months' },
    { key: 'custom', label: 'Custom range…' },
];
// Monday-anchored week start.
function ganttWeekStart(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
}
function ganttDayStart(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
// yyyy-mm-dd for <input type="date">.
function ganttDateInput(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function TaskGanttCard({ tasks = [] }) {
    const [showUndated, setShowUndated] = useState(true);
    const [range, setRange] = useState('auto');
    const today = useMemo(() => Date.now(), []);
    const [customFrom, setCustomFrom] = useState(() =>
        ganttDateInput(Date.now()),
    );
    const [customTo, setCustomTo] = useState(() =>
        ganttDateInput(Date.now() + 30 * GANTT_DAY),
    );

    // Base rows: drop DONE tasks, derive create → (deadline | today) span.
    const baseRows = useMemo(
        () =>
            (tasks || [])
                .filter((t) => t.status !== 'DONE')
                .map((t) => {
                    const start = t.createdAt
                        ? new Date(t.createdAt).getTime()
                        : null;
                    const hasDue = Boolean(t.dueDate);
                    const end = hasDue ? new Date(t.dueDate).getTime() : today;
                    return { ...t, start, end, hasDue };
                })
                .filter((t) => t.start != null && (showUndated || t.hasDue)),
        [tasks, showUndated, today],
    );

    // Fit-to-tasks window (also the fallback when a custom range is invalid).
    const autoWindow = useMemo(() => {
        if (!baseRows.length) return { axisStart: null, axisEnd: null };
        let mn = baseRows[0].start;
        let mx = baseRows[0].end;
        for (const r of baseRows) {
            mn = Math.min(mn, r.start);
            mx = Math.max(mx, r.end);
        }
        mn = Math.min(mn, today);
        mx = Math.max(mx, today);
        const pad = Math.max((mx - mn) * 0.03, GANTT_DAY);
        return { axisStart: mn - pad, axisEnd: mx + pad };
    }, [baseRows, today]);

    // Visible time window: either fit-to-tasks (auto) or a chosen horizon.
    const { axisStart, axisEnd } = useMemo(() => {
        if (range === 'auto') return autoWindow;
        if (range === 'custom') {
            const s = customFrom
                ? new Date(`${customFrom}T00:00:00`).getTime()
                : null;
            const e = customTo
                ? new Date(`${customTo}T23:59:59`).getTime()
                : null;
            if (s != null && e != null && e > s) {
                return { axisStart: s, axisEnd: e };
            }
            return autoWindow; // incomplete/invalid → fall back
        }
        if (range === '7d') {
            const s = ganttDayStart(today);
            return { axisStart: s, axisEnd: s + 7 * GANTT_DAY };
        }
        if (range === 'month') {
            const d = new Date(today);
            return {
                axisStart: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
                axisEnd: new Date(
                    d.getFullYear(),
                    d.getMonth() + 1,
                    0,
                    23,
                    59,
                    59,
                ).getTime(),
            };
        }
        const weeks = { '4w': 4, '8w': 8, '12w': 12, '6m': 26 }[range] || 8;
        const s = ganttWeekStart(today);
        return { axisStart: s, axisEnd: s + weeks * 7 * GANTT_DAY };
    }, [range, autoWindow, customFrom, customTo, today]);

    // Keep only tasks whose span overlaps the visible window.
    const rows = useMemo(() => {
        if (axisStart == null) return [];
        return baseRows.filter(
            (r) => r.start <= axisEnd && r.end >= axisStart,
        );
    }, [baseRows, axisStart, axisEnd]);

    const span = axisStart != null ? Math.max(axisEnd - axisStart, 1) : 1;
    const pct = (t) =>
        ((Math.min(Math.max(t, axisStart), axisEnd) - axisStart) / span) * 100;
    const fmt = (ms) => new Date(ms).toLocaleDateString();
    const tickLabel = (ms) =>
        new Date(ms).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
        });

    // Axis tick lines/labels — daily for short windows (≤16 days, e.g. the
    // 7-day view), weekly otherwise; capped so a long horizon doesn't render
    // hundreds of gridlines.
    const daySpan =
        axisStart != null ? (axisEnd - axisStart) / GANTT_DAY : 0;
    const daily = daySpan <= 16;
    const ticks = useMemo(() => {
        if (axisStart == null) return [];
        const out = [];
        const step = daily ? GANTT_DAY : 7 * GANTT_DAY;
        let t = daily ? ganttDayStart(axisStart) : ganttWeekStart(axisStart);
        if (t < axisStart) t += step;
        while (t <= axisEnd && out.length < 60) {
            out.push(t);
            t += step;
        }
        return out;
    }, [axisStart, axisEnd, daily]);

    // Min chart width so long horizons scroll horizontally instead of
    // squishing (the label column is 208px = w-52).
    const chartMinWidth = 208 + ticks.length * (daily ? 46 : 64);

    const showToday =
        axisStart != null && today >= axisStart && today <= axisEnd;

    return (
        <ChartCard
            title="Task timeline"
            subtitle="creation → deadline · resource planning"
            icon={CalendarClock}
        >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                        type="checkbox"
                        className="h-3.5 w-3.5"
                        checked={showUndated}
                        onChange={(e) => setShowUndated(e.target.checked)}
                    />
                    Show tasks without a deadline
                </label>
                <div className="flex flex-wrap items-center gap-1.5">
                    {range === 'custom' && (
                        <>
                            <input
                                type="date"
                                value={customFrom}
                                max={customTo || undefined}
                                onChange={(e) => setCustomFrom(e.target.value)}
                                className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                                title="From"
                            />
                            <span className="text-xs text-muted-foreground">
                                →
                            </span>
                            <input
                                type="date"
                                value={customTo}
                                min={customFrom || undefined}
                                onChange={(e) => setCustomTo(e.target.value)}
                                className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                                title="To"
                            />
                        </>
                    )}
                    <select
                        value={range}
                        onChange={(e) => setRange(e.target.value)}
                        className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                        title="Time range"
                    >
                        {GANTT_RANGES.map((r) => (
                            <option key={r.key} value={r.key}>
                                {r.label}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
            {rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                    No open tasks to plan in this window.
                </p>
            ) : (
                <>
                    <div className="max-h-[360px] overflow-auto">
                        <div style={{ minWidth: `${chartMinWidth}px` }}>
                            {/* Axis header — sticky to the top while rows scroll */}
                            <div className="sticky top-0 z-20 mb-1 flex items-end gap-2 bg-card pb-1">
                                <div className="sticky left-0 z-30 w-52 shrink-0 bg-card" />
                                <div className="relative h-4 flex-1">
                                    {ticks.map((t) => (
                                        <span
                                            key={t}
                                            className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground"
                                            style={{ left: `${pct(t)}%` }}
                                        >
                                            {tickLabel(t)}
                                        </span>
                                    ))}
                                </div>
                            </div>
                            {rows.map((r) => {
                                const overdue = r.hasDue && r.end < today;
                                const left = pct(r.start);
                                const width = Math.max(pct(r.end) - left, 1.5);
                                const bar = overdue
                                    ? 'bg-rose-500'
                                    : GANTT_STATUS_BAR[r.status] ||
                                      'bg-slate-400';
                                return (
                                    <Link
                                        key={r.id}
                                        to={`/projects/${r.project?.id || ''}#task-${r.id}`}
                                        className="group flex items-center gap-2 border-b border-border/40 py-1.5 last:border-0"
                                        title="Open task"
                                    >
                                        <div
                                            className="sticky left-0 z-10 w-52 shrink-0 overflow-hidden bg-card text-xs group-hover:bg-muted/50"
                                            title={r.title}
                                        >
                                            <div className="flex items-center gap-1 truncate">
                                                {r.code && (
                                                    <span className="font-mono text-[10px] text-muted-foreground">
                                                        {r.code}
                                                    </span>
                                                )}
                                                <span className="truncate">
                                                    {r.title}
                                                </span>
                                            </div>
                                            {r.project?.name && (
                                                <div className="truncate text-[10px] text-muted-foreground">
                                                    {r.project.name}
                                                </div>
                                            )}
                                        </div>
                                        <div className="relative h-4 flex-1 rounded bg-muted/40 group-hover:bg-muted/70">
                                            {/* Axis gridlines */}
                                            {ticks.map((t) => (
                                                <div
                                                    key={t}
                                                    className="pointer-events-none absolute inset-y-0 w-px bg-border/60"
                                                    style={{
                                                        left: `${pct(t)}%`,
                                                    }}
                                                />
                                            ))}
                                            {/* Today marker */}
                                            {showToday && (
                                                <div
                                                    className="pointer-events-none absolute inset-y-0 w-px bg-foreground/50"
                                                    style={{
                                                        left: `${pct(today)}%`,
                                                    }}
                                                    title="Today"
                                                />
                                            )}
                                            <div
                                                className={cn(
                                                    'absolute top-0.5 h-3 rounded',
                                                    bar,
                                                    !r.hasDue &&
                                                        'border border-dashed border-foreground/40 opacity-70',
                                                )}
                                                style={{
                                                    left: `${left}%`,
                                                    width: `${width}%`,
                                                }}
                                                title={`${fmt(r.start)} → ${
                                                    r.hasDue
                                                        ? fmt(r.end)
                                                        : 'no deadline'
                                                }${overdue ? ' · overdue' : ''}${
                                                    r.assignee?.name
                                                        ? ` · ${r.assignee.name}`
                                                        : ''
                                                }`}
                                            />
                                        </div>
                                    </Link>
                                );
                            })}
                        </div>
                    </div>
                    <div className="mt-1 flex items-center justify-end text-[11px] tabular-nums text-muted-foreground">
                        {fmt(axisStart)} – {fmt(axisEnd)}
                    </div>
                </>
            )}
        </ChartCard>
    );
}

function Dashboard({ data, section = 'projects' }) {
    const { user: currentUser } = useAuth();
    const isAdmin = currentUser?.role === 'ADMIN';
    const showProjects = section === 'projects';
    const showTasks = section === 'tasks';
    const {
        viewer,
        canSeePeople,
        canSeeOwners,
        summary,
        projectsByStatus,
        projectsByPriority,
        tasksByStatus,
        newProjectsByWeek,
        projectsByOwner = [],
        projectsByClient = [],
        projectsByProduct = [],
        projectsByType = [],
        projectsByTeam = [],
        projectsByCountry = [],
        completionBuckets = [],
        topProjectsByTasks = [],
        tasksByUser = [],
        tasksByPriority = [],
        tasksMostSubtasks = [],
        notesPerTask = [],
        taskTimeline = [],
        upcomingDue = [],
        topOwners,
        myFocus,
        recentlyClosed,
    } = data;

    const overviewLabel =
        viewer?.mode === 'user' && viewer.user
            ? `${viewer.user.name || viewer.user.email}'s overview`
            : viewer?.mode === 'self'
                ? 'My overview'
                : 'Workspace overview';

    const focusLabel =
        viewer?.mode === 'user' && viewer.user
            ? `${viewer.user.name || viewer.user.email}'s focus`
            : 'Your focus';

    return (
        <div className="space-y-6">
            {showProjects && (
            <section>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    {overviewLabel}
                </h2>
                <div
                    className={cn(
                        'grid gap-3 grid-cols-2',
                        canSeePeople ? 'md:grid-cols-4' : 'md:grid-cols-3',
                    )}
                >
                    <StatCard
                        label="Active projects"
                        value={summary.activeProjects}
                        sub={`${summary.totalProjects} total`}
                        icon={Briefcase}
                        tone="sky"
                    />
                    <StatCard
                        label="Completed"
                        value={summary.completedProjects}
                        sub="DONE status"
                        icon={CheckCircle2}
                        tone="emerald"
                    />
                    <StatCard
                        label="On hold"
                        value={summary.onHoldProjects}
                        sub="paused work"
                        icon={PauseCircle}
                        tone="amber"
                    />
                    {canSeePeople && (
                        <StatCard
                            label="Active people"
                            value={summary.totalUsers}
                            sub="approved members"
                            icon={UsersIcon}
                            tone="default"
                        />
                    )}
                </div>
            </section>
            )}

            {/* New-projects trend, pulled to the top of the Projects tab. */}
            {showProjects && (
            <section>
                <Card>
                    <CardContent className="flex items-center gap-4 py-3">
                        <div className="min-w-0 shrink-0">
                            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                New projects · last 8 weeks
                            </p>
                            <p className="text-lg font-semibold tabular-nums leading-tight">
                                {newProjectsByWeek.reduce(
                                    (s, b) => s + b.count,
                                    0,
                                )}
                            </p>
                        </div>
                        <div className="min-w-0 flex-1">
                            <Sparkline series={newProjectsByWeek} compact />
                        </div>
                    </CardContent>
                </Card>
            </section>
            )}

            {showTasks && (
            <section>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    {focusLabel}
                </h2>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                    <StatCard
                        label="My open tasks"
                        value={summary.myOpenTasks}
                        sub="assigned to you"
                        icon={Layers}
                        tone="default"
                    />
                    <StatCard
                        label="Overdue"
                        value={summary.myOverdueTasks}
                        sub="needs attention"
                        icon={AlertTriangle}
                        tone={summary.myOverdueTasks > 0 ? 'red' : 'default'}
                    />
                    <StatCard
                        label="Due this week"
                        value={summary.myDueThisWeek}
                        sub="next 7 days"
                        icon={CalendarClock}
                        tone={summary.myDueThisWeek > 0 ? 'amber' : 'default'}
                    />
                </div>
            </section>
            )}

            {/* Pies on top, side by side. */}
            {showTasks && (
            <section className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <ChartCard
                    title="Tasks by status"
                    icon={Layers}
                    collapsible={false}
                >
                    <DonutChart
                        centerLabel="Tasks"
                        rows={tasksByStatus.map((r) => ({
                            key: r.status,
                            label:
                                TASK_STATUS_META[r.status]?.label || r.status,
                            color: barHex(TASK_STATUS_META[r.status]?.bar),
                            count: r.count,
                        }))}
                    />
                </ChartCard>
                <ChartCard
                    title="Tasks by priority"
                    icon={AlertTriangle}
                    collapsible={false}
                >
                    <DonutChart
                        centerLabel="Tasks"
                        rows={tasksByPriority.map((r) => ({
                            key: r.priority,
                            label:
                                PROJECT_PRIORITY_META[r.priority]?.label ||
                                r.priority,
                            color: barHex(PROJECT_PRIORITY_META[r.priority]?.bar),
                            count: r.count,
                        }))}
                    />
                </ChartCard>
            </section>
            )}

            {/* Gantt / resource-planning timeline — first thing on the tab. */}
            {showTasks && (
                <section>
                    <TaskGanttCard tasks={taskTimeline} />
                </section>
            )}

            {/* Bar sensors below — equal height, scrollable, collapsible. */}
            {showTasks && (
            <section className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                <BreakdownCard
                    title="Tasks by user"
                    icon={UsersIcon}
                    rows={tasksByUser}
                />
                <BreakdownCard
                    title="Tasks with the most subtasks"
                    icon={Layers}
                    rows={tasksMostSubtasks}
                />
                <BreakdownCard
                    title="Tasks with the most notes"
                    icon={Inbox}
                    rows={notesPerTask}
                />
            </section>
            )}

            {showTasks && (
            <section>
                <ChartCard
                    title="Closest to due"
                    subtitle="open tasks with the nearest due dates"
                    icon={CalendarClock}
                    scroll
                >
                        {upcomingDue.length === 0 ? (
                            <p className="py-6 text-center text-sm text-muted-foreground">
                                No upcoming due dates.
                            </p>
                        ) : (
                            <ul className="divide-y">
                                {upcomingDue.map((t) => {
                                    const due = t.dueDate
                                        ? new Date(t.dueDate)
                                        : null;
                                    return (
                                        <li
                                            key={t.id}
                                            className="flex items-center gap-3 py-2"
                                        >
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-medium">
                                                    {t.title}
                                                </p>
                                                <p className="truncate text-xs text-muted-foreground">
                                                    {t.project?.name || '—'}
                                                    {t.assignee
                                                        ? ` · ${t.assignee.name}`
                                                        : ''}
                                                </p>
                                            </div>
                                            {due ? (
                                                <span
                                                    className={cn(
                                                        'shrink-0 whitespace-nowrap text-xs font-medium tabular-nums',
                                                        isPast(due) &&
                                                            !isToday(due)
                                                            ? 'text-rose-600'
                                                            : isToday(due)
                                                                ? 'text-amber-600'
                                                                : 'text-muted-foreground',
                                                    )}
                                                    title={format(
                                                        due,
                                                        'd MMM yyyy',
                                                    )}
                                                >
                                                    {formatDistanceToNowStrict(
                                                        due,
                                                        { addSuffix: true },
                                                    )}
                                                </span>
                                            ) : null}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                </ChartCard>
            </section>
            )}

            {showProjects && (
            <section className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                <ChartCard
                    title="Projects by status"
                    icon={Briefcase}
                    collapsible={false}
                >
                    <DonutChart
                        centerLabel="Projects"
                        rows={projectsByStatus.map((r) => ({
                            key: r.status,
                            label:
                                PROJECT_STATUS_META[r.status]?.label ||
                                r.status,
                            color: barHex(PROJECT_STATUS_META[r.status]?.bar),
                            count: r.count,
                        }))}
                    />
                </ChartCard>
                <ChartCard
                    title="Projects by priority"
                    icon={AlertTriangle}
                    collapsible={false}
                >
                    <DonutChart
                        centerLabel="Projects"
                        rows={projectsByPriority.map((r) => ({
                            key: r.priority,
                            label:
                                PROJECT_PRIORITY_META[r.priority]?.label ||
                                r.priority,
                            color: barHex(
                                PROJECT_PRIORITY_META[r.priority]?.bar,
                            ),
                            count: r.count,
                        }))}
                    />
                </ChartCard>
                <ChartCard
                    title="Projects by country"
                    icon={Globe}
                    collapsible={false}
                >
                    <DonutChart
                        centerLabel="Projects"
                        legendMaxHeight={148}
                        rows={projectsByCountry.map((r, i) => ({
                            key: r.key,
                            label: r.label,
                            count: r.count,
                            color: DONUT_PALETTE[i % DONUT_PALETTE.length],
                        }))}
                    />
                </ChartCard>
            </section>
            )}

            {/* Breakdown bar charts: owner / client / product / type / team,
                plus the two-of-a-kind "task progress" + "most tasks". */}
            {showProjects && (
            <section className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <BreakdownCard
                    title="Projects by owner"
                    icon={UsersIcon}
                    rows={projectsByOwner}
                />
                <BreakdownCard
                    title="Projects by client"
                    icon={Building2}
                    rows={projectsByClient}
                />
                <BreakdownCard
                    title="Projects by product"
                    icon={Package}
                    rows={projectsByProduct}
                />
                <BreakdownCard
                    title="Projects by type"
                    icon={Tag}
                    rows={projectsByType}
                />
                <BreakdownCard
                    title="Projects by team"
                    icon={UsersIcon}
                    rows={projectsByTeam}
                />
                <BreakdownCard
                    title="Projects with the most tasks"
                    icon={Layers}
                    rows={topProjectsByTasks}
                />
            </section>
            )}

            {showTasks && (
            <section>
                <Card>
                    <CardHeader className="pb-2 flex-row items-center justify-between">
                        <CardTitle className="flex items-center gap-2 text-base font-semibold">
                            <Sparkles className="h-4 w-4 text-primary" />
                            {viewer?.mode === 'user' && viewer.user
                                ? `${viewer.user.name || viewer.user.email}: open tasks`
                                : 'My open tasks'}
                        </CardTitle>
                        <span className="text-xs text-muted-foreground">
                            sorted by due date
                        </span>
                    </CardHeader>
                    <CardContent>
                        {myFocus.length === 0 ? (
                            <p className="py-6 text-center text-sm text-muted-foreground">
                                Nothing on your plate. Nice.
                            </p>
                        ) : (
                            <ul className="divide-y">
                                {myFocus.map((t) => {
                                    // Whole row clickable: takes you to the
                                    // task's project. Admins can follow links
                                    // anywhere; non-admins only to projects
                                    // they're a participant of (the API
                                    // already enforces this so a 404 is the
                                    // worst case).
                                    const targetHref = t.project
                                        ? `/projects/${t.project.id}#task-${t.id}`
                                        : null;
                                    const Inner = (
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0 flex-1">
                                                <p className="truncate text-sm font-medium">
                                                    {t.title}
                                                </p>
                                                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                                                    {t.project && (
                                                        <span className="inline-flex items-center gap-1">
                                                            <FolderKanban className="h-3 w-3" />
                                                            {t.project.name}
                                                        </span>
                                                    )}
                                                    {t.dueDate && (
                                                        <span
                                                            className={cn(
                                                                'inline-flex items-center gap-1',
                                                                dueClass(t.dueDate),
                                                            )}
                                                        >
                                                            <Clock className="h-3 w-3" />
                                                            {dueLabel(t.dueDate)}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <Badge
                                                variant="outline"
                                                className="shrink-0 text-[10px]"
                                            >
                                                {t.status
                                                    .replace('_', ' ')
                                                    .toLowerCase()}
                                            </Badge>
                                        </div>
                                    );
                                    return (
                                        <li key={t.id} className="py-1">
                                            {targetHref ? (
                                                <Link
                                                    to={targetHref}
                                                    className="block rounded px-1.5 py-1.5 transition-colors hover:bg-accent/50"
                                                >
                                                    {Inner}
                                                </Link>
                                            ) : (
                                                <div className="px-1.5 py-1.5">
                                                    {Inner}
                                                </div>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </CardContent>
                </Card>
            </section>
            )}

            {/* Task progress paired with Top owners, equal height + scroll. */}
            {showProjects && (
            <section className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <BreakdownCard
                    title="Task progress"
                    subtitle="projects grouped by % of tasks done"
                    icon={Target}
                    rows={completionBuckets}
                    keepOrder
                />
                {canSeeOwners && (
                    <ChartCard title="Top project owners" icon={Trophy} scroll>
                            {topOwners.length === 0 ? (
                                <p className="py-6 text-center text-sm text-muted-foreground">
                                    No project owners yet.
                                </p>
                            ) : (
                                <ul className="space-y-1">
                                    {topOwners.map((row) => {
                                        const Inner = (
                                            <>
                                                <Avatar className="h-8 w-8">
                                                    {row.user.avatarUrl && (
                                                        <AvatarImage
                                                            src={resolveAssetUrl(
                                                                row.user.avatarUrl,
                                                            )}
                                                            alt={row.user.name}
                                                        />
                                                    )}
                                                    <AvatarFallback className="bg-primary/10 text-xs text-primary">
                                                        {initials(row.user.name)}
                                                    </AvatarFallback>
                                                </Avatar>
                                                <div className="min-w-0 flex-1">
                                                    <p className="truncate text-sm font-medium">
                                                        {row.user.name}
                                                    </p>
                                                    <p className="truncate text-xs text-muted-foreground">
                                                        {row.user.email}
                                                    </p>
                                                </div>
                                                <Badge
                                                    variant="secondary"
                                                    className="text-[10px]"
                                                >
                                                    {row.count} project
                                                    {row.count === 1 ? '' : 's'}
                                                </Badge>
                                            </>
                                        );
                                        return (
                                            <li key={row.user.id}>
                                                {isAdmin ? (
                                                    <Link
                                                        to={`/users?focus=${row.user.id}`}
                                                        className="flex items-center gap-3 rounded px-2 py-1.5 transition-colors hover:bg-accent/50"
                                                    >
                                                        {Inner}
                                                    </Link>
                                                ) : (
                                                    <div className="flex items-center gap-3 px-2 py-1.5">
                                                        {Inner}
                                                    </div>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                    </ChartCard>
                )}
            </section>
            )}

            {showProjects && recentlyClosed.length > 0 && (
                <section>
                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-base font-semibold">
                                <Archive className="h-4 w-4 text-primary" />
                                Recently archived
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <ul className="divide-y">
                                {recentlyClosed.map((p) => (
                                    <li
                                        key={p.id}
                                        className="flex items-center justify-between gap-3 py-2"
                                    >
                                        <Link
                                            to={`/projects/${p.id}`}
                                            className="text-sm font-medium hover:underline"
                                        >
                                            {p.name}
                                        </Link>
                                        <span className="text-xs text-muted-foreground">
                                            closed{' '}
                                            {formatDistanceToNowStrict(
                                                new Date(p.closedAt),
                                                { addSuffix: true },
                                            )}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </CardContent>
                    </Card>
                </section>
            )}
        </div>
    );
}

// Ticket dashboards on the Insights page (the "Tickets" tab). Self-
// contained: fetches /api/tickets/stats. "My tickets" shows for every
// agent; the workspace dashboard only when the backend returns
// `workspace` (admins / ticket:view:all). When the caller has no ticket
// access the endpoint 403s and we show a friendly empty state.
function TicketInsights({
    scopeUserId = null,
    scopeLabel = 'My tickets',
    from,
    to,
    teamId = null,
}) {
    const [stats, setStats] = useState(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoaded(false);
        const params = scopeUserId ? { userId: scopeUserId } : {};
        if (from) params.from = from;
        if (to) params.to = to;
        if (teamId) params.teamId = teamId;
        api.get('/tickets/stats', { params })
            .then((res) => {
                if (!cancelled) setStats(res.data);
            })
            .catch(() => {})
            .finally(() => {
                if (!cancelled) setLoaded(true);
            });
        return () => {
            cancelled = true;
        };
    }, [scopeUserId, from, to, teamId]);

    if (!stats?.mine) {
        return (
            <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground shadow-sm">
                {loaded
                    ? 'No ticket data to show yet.'
                    : 'Loading ticket insights…'}
            </div>
        );
    }
    const { mine, workspace } = stats;
    const ws = workspace;

    return (
        <div className="space-y-6">
            <section>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    <Ticket className="h-4 w-4" />
                    {scopeLabel}
                </h2>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <StatCard
                        label="Assigned & open"
                        value={mine.open}
                        sub="on your plate"
                        icon={Inbox}
                        tone={mine.open > 0 ? 'sky' : 'default'}
                    />
                    <StatCard
                        label="Resolved"
                        value={mine.resolved}
                        sub={`${mine.resolvedLast30} in last 30d`}
                        icon={CheckCircle2}
                        tone="emerald"
                    />
                    <StatCard
                        label="Avg resolution"
                        value={fmtDuration(mine.avgResolutionSeconds)}
                        sub="open → closed"
                        icon={Timer}
                        tone="default"
                    />
                    <StatCard
                        label="Unassigned queue"
                        value={mine.unassignedQueue}
                        sub="waiting to be taken"
                        icon={Ticket}
                        tone={mine.unassignedQueue > 0 ? 'amber' : 'default'}
                    />
                </div>
                {ticketRows(mine.byStatus, TICKET_STATUS_META).length > 0 && (
                    <div className="mt-3">
                        <ChartCard
                            title="My tickets by status"
                            icon={Ticket}
                            scroll
                            collapsible={false}
                        >
                            <BarBreakdown
                                rows={ticketRows(mine.byStatus, TICKET_STATUS_META)}
                            />
                        </ChartCard>
                    </div>
                )}
            </section>

            {ws && (
                <>
                    <section>
                        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                            <Ticket className="h-4 w-4" />
                            Ticket workspace
                        </h2>
                        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                            <StatCard
                                label="Total tickets"
                                value={ws.total}
                                sub="all time"
                                icon={Ticket}
                                tone="default"
                            />
                            <StatCard
                                label="Open"
                                value={ws.open}
                                sub="not yet resolved"
                                icon={Inbox}
                                tone={ws.open > 0 ? 'sky' : 'default'}
                            />
                            <StatCard
                                label="Resolved"
                                value={ws.resolved}
                                sub="resolved or closed"
                                icon={CheckCircle2}
                                tone="emerald"
                            />
                            <StatCard
                                label="Unassigned"
                                value={ws.unassigned}
                                sub="needs an owner"
                                icon={AlertTriangle}
                                tone={ws.unassigned > 0 ? 'amber' : 'default'}
                            />
                        </div>
                        {/* Response-time sensors, under Ticket workspace. */}
                        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                            <StatCard
                                label="Open → taken"
                                value={fmtDuration(ws.avgOpenToTakenSeconds)}
                                sub="avg time to pick up"
                                icon={Timer}
                                tone="sky"
                            />
                            <StatCard
                                label="Open → resolved"
                                value={fmtDuration(
                                    ws.avgOpenToResolvedSeconds,
                                )}
                                sub="avg time to resolve"
                                icon={Timer}
                                tone="emerald"
                            />
                            <StatCard
                                label="Avg resolution"
                                value={fmtDuration(ws.avgResolutionSeconds)}
                                sub="open → closed"
                                icon={Timer}
                                tone="default"
                            />
                        </div>
                    </section>

                    <section className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                        <ChartCard
                            title="By status"
                            icon={Ticket}
                            collapsible={false}
                        >
                            <DonutChart
                                centerLabel="Tickets"
                                rows={ticketDonutRows(
                                    ws.byStatus,
                                    TICKET_STATUS_META,
                                )}
                            />
                        </ChartCard>
                        <ChartCard
                            title="By priority"
                            icon={AlertTriangle}
                            collapsible={false}
                        >
                            <DonutChart
                                centerLabel="Tickets"
                                rows={ticketDonutRows(
                                    ws.byPriority,
                                    TICKET_PRIORITY_META,
                                )}
                            />
                        </ChartCard>
                        <ChartCard
                            title="By category"
                            icon={Tag}
                            collapsible={false}
                        >
                            <DonutChart
                                centerLabel="Tickets"
                                rows={ticketDonutRows(
                                    ws.byCategory,
                                    TICKET_CATEGORY_META,
                                )}
                            />
                        </ChartCard>
                    </section>

                    {/* Agent workload · By project · Most active clients —
                        three bar/pie breakdowns side by side. */}
                    <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                        <TogglableBreakdown
                            title="Agent workload"
                            icon={UsersIcon}
                            rows={ws.byAssignee || []}
                        />
                        <TogglableBreakdown
                            title="By project"
                            icon={FolderKanban}
                            rows={ws.byProject || []}
                        />
                        <TogglableBreakdown
                            title="Most active clients"
                            icon={Building2}
                            rows={ws.byClient || []}
                            centerLabel="Tickets"
                        />
                    </section>

                    {/* Per-ticket phase timing. */}
                    <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                        <ChartCard
                            title="Longest in current phase"
                            subtitle="open tickets, excluding resolved/closed"
                            icon={Clock}
                            scroll
                        >
                            <PhaseTimeList
                                rows={ws.timeInPhase || []}
                                empty="No open tickets."
                            />
                        </ChartCard>
                        <ChartCard
                            title="Pending time"
                            subtitle="tickets waiting on requester / third party"
                            icon={PauseCircle}
                            scroll
                        >
                            <PhaseTimeList
                                rows={ws.pendingTime || []}
                                empty="Nothing pending."
                            />
                        </ChartCard>
                    </section>

                    <section>
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="flex items-center justify-between gap-2 text-base font-semibold">
                                    <span className="flex items-center gap-2">
                                        <CalendarClock className="h-4 w-4 text-primary" />
                                        Created vs resolved · 30 days
                                    </span>
                                    <span className="text-xs font-normal text-muted-foreground">
                                        avg resolution{' '}
                                        {fmtDuration(ws.avgResolutionSeconds)}
                                    </span>
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <TicketTrendStrip trend={ws.trend || []} />
                                <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
                                    <span className="flex items-center gap-1.5">
                                        <span className="h-2.5 w-2.5 rounded-sm bg-sky-500/70" />
                                        Created
                                    </span>
                                    <span className="flex items-center gap-1.5">
                                        <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500/70" />
                                        Resolved
                                    </span>
                                </div>
                            </CardContent>
                        </Card>
                    </section>
                </>
            )}
        </div>
    );
}

// Slim twin-bar strip: per day a sky (created) and emerald (resolved) bar.
function TicketTrendStrip({ trend }) {
    if (!trend.length) {
        return (
            <p className="py-6 text-center text-sm text-muted-foreground">
                No ticket history yet.
            </p>
        );
    }
    const max = Math.max(
        1,
        ...trend.map((d) => Math.max(d.created, d.resolved)),
    );
    return (
        <div className="flex h-24 items-end gap-[3px]">
            {trend.map((d) => (
                <div
                    key={d.date}
                    className="flex flex-1 items-end justify-center gap-[1px]"
                    title={`${d.date}: +${d.created} created, ${d.resolved} resolved`}
                >
                    <div
                        className="w-1/2 rounded-t-sm bg-sky-500/70"
                        style={{
                            height: `${Math.max((d.created / max) * 100, d.created > 0 ? 6 : 1)}%`,
                        }}
                    />
                    <div
                        className="w-1/2 rounded-t-sm bg-emerald-500/70"
                        style={{
                            height: `${Math.max((d.resolved / max) * 100, d.resolved > 0 ? 6 : 1)}%`,
                        }}
                    />
                </div>
            ))}
        </div>
    );
}

function StatCard({ label, value, sub, icon: Icon, tone }) {
    const tones = {
        default: 'border bg-card',
        sky: 'border-sky-200 bg-sky-50/60 dark:border-sky-500/30 dark:bg-sky-500/10',
        emerald:
            'border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/10',
        amber: 'border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10',
        red: 'border-rose-200 bg-rose-50/60 dark:border-rose-500/30 dark:bg-rose-500/10',
    };
    const iconTones = {
        default: 'bg-primary/10 text-primary',
        sky: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
        emerald: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
        amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
        red: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    };
    return (
        <div
            className={cn(
                'rounded-lg p-4 shadow-sm',
                tones[tone] || tones.default,
            )}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {label}
                    </p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums">
                        {value ?? 0}
                    </p>
                    {sub && (
                        <p className="text-xs text-muted-foreground">{sub}</p>
                    )}
                </div>
                {Icon && (
                    <span
                        className={cn(
                            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                            iconTones[tone] || iconTones.default,
                        )}
                    >
                        <Icon className="h-4 w-4" />
                    </span>
                )}
            </div>
        </div>
    );
}

// A titled card wrapping BarBreakdown for the dynamic Projects-tab
// breakdowns. Colours cycle through BAR_PALETTE. `keepOrder` preserves the
// server order (used for the ordinal completion buckets); otherwise rows
// arrive pre-sorted by count from the backend.
// A chart card. `scroll` caps the body at ~5 rows with an internal
// scrollbar (so long bar lists don't dominate the page). `collapsible`
// (default) adds a collapse chevron and makes the card obey the tab's
// "collapse all" button. The top KPI stat tiles aren't ChartCards, so they
// stay put. `self-start` stops the grid stretching the card so the height
// cap actually holds.
function ChartCard({
    title,
    subtitle,
    icon: Icon,
    headerRight,
    scroll = false,
    collapsible = true,
    children,
}) {
    const bulk = useContext(CollapseCtx);
    const [open, setOpen] = useState(true);
    // Only collapsible cards react to "collapse/expand all". Skip the
    // initial signal (0) so cards keep their default expanded state.
    useEffect(() => {
        if (collapsible && bulk && bulk.signal > 0) setOpen(!bulk.collapsed);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bulk?.signal]);
    return (
        <Card className="flex flex-col self-start">
            <CardHeader className="flex-row items-start justify-between gap-2 space-y-0 pb-2">
                <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base font-semibold">
                        {Icon ? (
                            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        ) : null}
                        <span className="truncate">{title}</span>
                    </CardTitle>
                    {subtitle ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            {subtitle}
                        </p>
                    ) : null}
                </div>
                {(headerRight || collapsible) && (
                    <div className="flex shrink-0 items-center gap-1">
                        {headerRight}
                        {collapsible && (
                            <button
                                type="button"
                                onClick={() => setOpen((o) => !o)}
                                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                title={open ? 'Collapse' : 'Expand'}
                                aria-label={open ? 'Collapse' : 'Expand'}
                            >
                                {open ? (
                                    <ChevronUp className="h-4 w-4" />
                                ) : (
                                    <ChevronDown className="h-4 w-4" />
                                )}
                            </button>
                        )}
                    </div>
                )}
            </CardHeader>
            {open ? (
                <CardContent
                    className={cn(scroll && 'max-h-[236px] overflow-y-auto')}
                >
                    {children}
                </CardContent>
            ) : null}
        </Card>
    );
}

function BreakdownCard({ title, subtitle, icon, rows, keepOrder }) {
    void keepOrder;
    const mapped = (rows || []).map((r, i) => ({
        key: r.key,
        label: r.label,
        count: r.count,
        bar: BAR_PALETTE[i % BAR_PALETTE.length],
    }));
    const total = mapped.reduce((s, r) => s + r.count, 0);
    return (
        <ChartCard title={title} subtitle={subtitle} icon={icon} scroll>
            <BarBreakdown rows={mapped} total={total} />
        </ChartCard>
    );
}

// Bar/pie two-way card used on the Tickets tab (agent workload, by project).
// Holds its own view state so each card toggles independently.
function TogglableBreakdown({ title, icon, rows, centerLabel = 'Tickets' }) {
    const [view, setView] = useState('bar');
    const data = (rows || []).map((r, i) => ({
        key: r.key ?? r.name,
        label: r.label ?? r.name,
        count: r.count,
        bar: BAR_PALETTE[i % BAR_PALETTE.length],
        color: DONUT_PALETTE[i % DONUT_PALETTE.length],
    }));
    const total = data.reduce((s, r) => s + r.count, 0);
    const toggle = (
        <div className="flex rounded-md border p-0.5">
            <button
                type="button"
                onClick={() => setView('bar')}
                className={cn(
                    'flex h-6 w-6 items-center justify-center rounded transition-colors',
                    view === 'bar'
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                )}
                title="Bar chart"
                aria-label="Bar chart"
            >
                <BarChart3 className="h-3.5 w-3.5" />
            </button>
            <button
                type="button"
                onClick={() => setView('pie')}
                className={cn(
                    'flex h-6 w-6 items-center justify-center rounded transition-colors',
                    view === 'pie'
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                )}
                title="Pie chart"
                aria-label="Pie chart"
            >
                <PieChart className="h-3.5 w-3.5" />
            </button>
        </div>
    );
    return (
        <ChartCard
            title={title}
            icon={icon}
            headerRight={toggle}
            scroll={view === 'bar'}
            collapsible
        >
            {view === 'bar' ? (
                <BarBreakdown rows={data} total={total} />
            ) : (
                <DonutChart centerLabel={centerLabel} rows={data} />
            )}
        </ChartCard>
    );
}

// Per-ticket list showing how long each open ticket has sat in its current
// phase (or in Pending). `rows` come from the server with a sinceMs field.
function PhaseTimeList({ rows, empty }) {
    if (!rows || rows.length === 0) {
        return (
            <p className="py-6 text-center text-sm text-muted-foreground">
                {empty || 'Nothing here.'}
            </p>
        );
    }
    return (
        <ul className="divide-y">
            {rows.map((t) => {
                const meta = TICKET_STATUS_META[t.status];
                return (
                    <li key={t.id} className="flex items-center gap-3 py-2">
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                                <span className="text-muted-foreground">
                                    {t.code}
                                </span>{' '}
                                {t.subject}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                                <span
                                    className={cn(
                                        'mr-1.5 inline-block h-2 w-2 rounded-full align-middle',
                                        meta?.bar || 'bg-slate-400',
                                    )}
                                />
                                {meta?.label || t.status}
                                {t.assignee ? ` · ${t.assignee}` : ' · unassigned'}
                            </p>
                        </div>
                        <span
                            className="shrink-0 whitespace-nowrap text-xs font-medium tabular-nums text-muted-foreground"
                            title="Time in current phase"
                        >
                            {fmtDuration(Math.round(t.sinceMs / 1000))}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}

function BarBreakdown({ rows, total }) {
    const max = Math.max(total || 0, ...rows.map((r) => r.count), 1);
    return (
        <div className="space-y-3">
            {rows.map((r) => {
                const pct = Math.round((r.count / max) * 100);
                return (
                    <div key={r.key}>
                        <div className="mb-1.5 flex items-center justify-between text-xs">
                            <span className="font-medium">{r.label}</span>
                            <span className="tabular-nums text-muted-foreground">
                                {r.count}
                            </span>
                        </div>
                        <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
                            <div
                                className={cn(
                                    'h-full rounded-full transition-all',
                                    r.bar || 'bg-primary',
                                )}
                                style={{ width: `${Math.max(pct, r.count > 0 ? 4 : 0)}%` }}
                            />
                        </div>
                    </div>
                );
            })}
            {rows.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">
                    No data yet.
                </p>
            )}
        </div>
    );
}

function Sparkline({ series, compact = false }) {
    const max = useMemo(
        () => Math.max(1, ...series.map((b) => b.count)),
        [series],
    );

    if (!series || series.length === 0) {
        return (
            <p
                className={cn(
                    'text-center text-xs text-muted-foreground',
                    compact ? 'py-1' : 'py-6 text-sm',
                )}
            >
                No project history yet.
            </p>
        );
    }

    // Compact mode renders a slim inline strip — no big total, no
    // duplicate caption. Used inside the "trend strip" card on the
    // Insights page.
    if (compact) {
        return (
            <div>
                <div className="flex h-10 items-end gap-1">
                    {series.map((b) => {
                        const h = Math.round((b.count / max) * 100);
                        return (
                            <div
                                key={b.week}
                                className="group flex flex-1 flex-col items-center justify-end"
                            >
                                <div
                                    className={cn(
                                        'w-full rounded-sm bg-primary/30 transition-colors group-hover:bg-primary',
                                        b.count === 0 && 'bg-muted',
                                    )}
                                    style={{ height: `${Math.max(h, 6)}%` }}
                                    title={`${b.count} on ${format(
                                        new Date(b.week),
                                        'MMM d',
                                    )}`}
                                />
                            </div>
                        );
                    })}
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                    <span>{format(new Date(series[0].week), 'MMM d')}</span>
                    <span>
                        {format(
                            new Date(series[series.length - 1].week),
                            'MMM d',
                        )}
                    </span>
                </div>
            </div>
        );
    }

    const total = series.reduce((s, b) => s + b.count, 0);

    return (
        <div>
            <div className="mb-2 flex items-baseline justify-between">
                <p className="text-2xl font-semibold tabular-nums">{total}</p>
                <p className="text-xs text-muted-foreground">
                    new projects in the last 8 weeks
                </p>
            </div>
            <div className="flex h-32 items-end gap-1.5">
                {series.map((b) => {
                    const h = Math.round((b.count / max) * 100);
                    return (
                        <div
                            key={b.week}
                            className="group flex flex-1 flex-col items-center justify-end"
                        >
                            <div
                                className={cn(
                                    'w-full rounded-t bg-primary/20 transition-colors group-hover:bg-primary',
                                    b.count === 0 && 'bg-muted',
                                )}
                                style={{ height: `${Math.max(h, 4)}%` }}
                                title={`${b.count} on ${format(
                                    new Date(b.week),
                                    'MMM d',
                                )}`}
                            />
                        </div>
                    );
                })}
            </div>
            <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
                <span>
                    {format(new Date(series[0].week), 'MMM d')}
                </span>
                <span>
                    {format(new Date(series[series.length - 1].week), 'MMM d')}
                </span>
            </div>
        </div>
    );
}
