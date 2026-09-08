// /applications — catalogue of internal/customer apps with releases.
//
// List view rendered as a responsive card grid. Each card shows the
// app's logo, name, optional description, and the LATEST release per
// phase (Test / Pilot / Approved) so reviewers can see at a glance
// what version is in each pipeline stage.
//
// Phase filter narrows by RELEASE phase (an app is shown when at least
// one of its releases is in the chosen phase).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    AppWindow,
    Calendar,
    Check,
    CheckCircle2,
    ChevronDown,
    ChevronsLeft,
    ChevronsRight,
    Clock,
    Download,
    FileText,
    Filter,
    GalleryHorizontal,
    History,
    Layers,
    LayoutList,
    Plus,
    Rocket,
    Search,
    Smartphone,
    StickyNote,
    Tag,
    Undo2,
    X,
} from 'lucide-react';
import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';
import { toast } from 'sonner';

import { TopBar } from '@/components/TopBar';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/contexts/AuthContext';
import { CAPABILITIES, hasCapability } from '@/lib/capabilities';
import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';

import {
    APPLICATION_PHASES,
    PHASE_LABEL,
    PHASE_BADGE_CLASS,
    ApplicationFormDialog,
} from '@/components/ApplicationFormDialog';

const ALL_PHASES = '__all__';

const TAB_OPTIONS = [
    { id: 'catalog', label: 'Catalog', icon: AppWindow },
    { id: 'timeline', label: 'Activity timeline', icon: History },
];

const TIMELINE_HIDDEN_APPS_KEY = 'pm.apps.timeline.hiddenAppIds';
const TIMELINE_PHASE_KEY = 'pm.apps.timeline.phaseFilter';
const TIMELINE_RANGE_KEY = 'pm.apps.timeline.rangeDays';
const TIMELINE_VIEW_MODE_KEY = 'pm.apps.timeline.viewMode';

const TIMELINE_VIEW_MODES = [
    { id: 'list', label: 'List', icon: LayoutList },
    { id: 'strip', label: 'Strip', icon: GalleryHorizontal },
];

const TIMELINE_PHASE_FILTERS = [
    { id: 'all', label: 'All events' },
    { id: 'APPROVED', label: 'Production' },
    { id: 'PILOT', label: 'Pilot' },
    { id: 'TEST', label: 'Test' },
    { id: 'CHECKPOINTS', label: 'Checkpoints only' },
];

const TIMELINE_RANGE_OPTIONS = [
    { id: 7, label: 'Last 7 days' },
    { id: 30, label: 'Last 30 days' },
    { id: 90, label: 'Last 90 days' },
    { id: 180, label: 'Last 6 months' },
    { id: 365, label: 'Last 12 months' },
    { id: 0, label: 'All time' },
];

const EVENT_BADGE = {
    TEST: {
        label: 'Test',
        dot: 'bg-sky-500',
        chip: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800/40 dark:bg-sky-950/40 dark:text-sky-200',
        icon: Smartphone,
    },
    PILOT: {
        label: 'Pilot',
        dot: 'bg-amber-500',
        chip: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/40 dark:bg-amber-950/40 dark:text-amber-200',
        icon: Layers,
    },
    APPROVED: {
        label: 'Production',
        dot: 'bg-emerald-500',
        chip: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-950/40 dark:text-emerald-200',
        icon: Rocket,
    },
    PROD_DEPLOY: {
        label: 'Deployed to prod',
        dot: 'bg-emerald-600',
        chip: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-950/40 dark:text-emerald-200',
        icon: CheckCircle2,
    },
    PROD_ROLLBACK: {
        label: 'Rolled back',
        dot: 'bg-rose-600',
        chip: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800/40 dark:bg-rose-950/40 dark:text-rose-200',
        icon: Undo2,
    },
    PILOT_DEPLOY: {
        label: 'Pilot deployment',
        dot: 'bg-amber-600',
        chip: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800/40 dark:bg-amber-950/40 dark:text-amber-200',
        icon: Layers,
    },
    TEST_DEPLOY: {
        label: 'Test deployment',
        dot: 'bg-sky-600',
        chip: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800/40 dark:bg-sky-950/40 dark:text-sky-200',
        icon: Smartphone,
    },
    NOTE: {
        label: 'Operational note',
        dot: 'bg-slate-500',
        chip: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700/40 dark:bg-slate-900/40 dark:text-slate-200',
        icon: StickyNote,
    },
};

// Reduce a release list (newest first as returned by the API) to a
// dictionary of `{ TEST: latest, PILOT: latest, APPROVED: latest }`.
// "Latest" is decided by phase-transition timestamp first (releaseDate
// fallback, then createdAt) so a release that was promoted to Pilot
// today wins over an older release that's been sitting in Pilot.
function latestByPhase(releases) {
    const out = { TEST: null, PILOT: null, APPROVED: null };
    if (!Array.isArray(releases)) return out;
    const stamp = (r, p) =>
        r[`${p.toLowerCase()}At`] || r.releaseDate || r.createdAt || null;
    for (const r of releases) {
        const p = r.phase;
        if (!p || !(p in out)) continue;
        if (!out[p]) {
            out[p] = r;
            continue;
        }
        const a = new Date(stamp(out[p], p) || 0).getTime();
        const b = new Date(stamp(r, p) || 0).getTime();
        if (b > a) out[p] = r;
    }
    return out;
}

export default function Applications() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    // Granular capability flags. The "New application" buttons are
    // gated by `canCreateApp` so admins can hand out `app:create` to
    // a regular user without making them a manager. Managers get
    // APP_CREATE via the role-default capability set in the shared
    // `lib/capabilities.js` mirror, so this also stays true for
    // them. The backend's `routes/applications.js` already enforces
    // capability checks on every mutation, so the UI just needs to
    // surface the controls.
    const canCreateApp =
        isAdmin || hasCapability(user, CAPABILITIES.APP_CREATE);

    const [tab, setTab] = useState('catalog');
    const [apps, setApps] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [phaseFilter, setPhaseFilter] = useState(ALL_PHASES);
    const [creating, setCreating] = useState(false);

    const reload = async () => {
        try {
            const { data } = await api.get('/applications');
            setApps(data?.applications || []);
        } catch {
            toast.error('Could not load applications');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        reload();
    }, []);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return apps.filter((a) => {
            if (phaseFilter !== ALL_PHASES) {
                const has = (a.releases || []).some(
                    (r) => r.phase === phaseFilter,
                );
                if (!has) return false;
            }
            if (!q) return true;
            const releaseHay = (a.releases || [])
                .map((r) => r.version)
                .join(' ');
            const hay = [a.name, a.packageName, a.description, releaseHay]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return hay.includes(q);
        });
    }, [apps, search, phaseFilter]);

    return (
        <>
            <TopBar title="Applications" />
            <main className="flex-1 overflow-auto bg-muted/20">
                <div className="flex w-full flex-col gap-4 p-3 sm:p-6">
                    {/* --- Header / toolbar -------------------------- */}
                    <div className="relative overflow-hidden rounded-xl border bg-gradient-to-br from-primary/10 via-card to-card p-4 shadow-sm sm:p-6">
                        <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
                        <div className="relative flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="flex items-start gap-3">
                                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary shadow-inner">
                                    <AppWindow className="h-5 w-5" />
                                </div>
                                <div className="space-y-1">
                                    <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                                        Applications
                                    </h1>
                                    <p className="max-w-2xl text-sm text-muted-foreground">
                                        Catalogue of every app the team
                                        ships. Each release is tracked
                                        through Test → Pilot → Approved
                                        with its own OS / terminal targets,
                                        minimum version and notes.
                                    </p>
                                </div>
                            </div>
                            {canCreateApp && tab === 'catalog' && (
                                <Button
                                    onClick={() => setCreating(true)}
                                    className="self-start"
                                >
                                    <Plus className="mr-1.5 h-4 w-4" />
                                    New application
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Tab strip — keeps the global picker for the
                        catalogue grid and the new cross-app timeline in
                        the same surface so the filters / search bar
                        below adapt without the user navigating away. */}
                    <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-card p-1 shadow-sm">
                        {TAB_OPTIONS.map((opt) => {
                            const Icon = opt.icon;
                            const active = tab === opt.id;
                            return (
                                <button
                                    key={opt.id}
                                    type="button"
                                    onClick={() => setTab(opt.id)}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                                        active
                                            ? 'bg-primary/10 text-primary'
                                            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                                    )}
                                    aria-pressed={active}
                                >
                                    <Icon className="h-4 w-4" />
                                    {opt.label}
                                </button>
                            );
                        })}
                    </div>

                    {tab === 'catalog' ? (
                        <>
                            <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3 shadow-sm">
                                <div className="relative flex-1 min-w-[220px] max-w-md">
                                    <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                    <Input
                                        value={search}
                                        onChange={(e) =>
                                            setSearch(e.target.value)
                                        }
                                        placeholder="Search by name, description or version..."
                                        className="pl-8"
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                        Release phase
                                    </Label>
                                    <Select
                                        value={phaseFilter}
                                        onValueChange={setPhaseFilter}
                                    >
                                        <SelectTrigger className="w-[180px]">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value={ALL_PHASES}>
                                                Any release phase
                                            </SelectItem>
                                            {APPLICATION_PHASES.map((p) => (
                                                <SelectItem key={p} value={p}>
                                                    Has {PHASE_LABEL[p]}{' '}
                                                    release
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="ml-auto text-xs text-muted-foreground">
                                    {filtered.length}{' '}
                                    {filtered.length === 1
                                        ? 'application'
                                        : 'applications'}
                                </div>
                            </div>

                            {loading ? (
                                <Card>
                                    <CardContent className="p-6 text-sm text-muted-foreground">
                                        Loading applications...
                                    </CardContent>
                                </Card>
                            ) : filtered.length === 0 ? (
                                <Card>
                                    <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                                        <AppWindow className="h-8 w-8 text-muted-foreground/60" />
                                        <p>
                                            No applications match the
                                            current filters.
                                        </p>
                                        {canCreateApp && (
                                            <Button
                                                size="sm"
                                                onClick={() =>
                                                    setCreating(true)
                                                }
                                            >
                                                <Plus className="mr-1.5 h-4 w-4" />
                                                Add the first application
                                            </Button>
                                        )}
                                    </CardContent>
                                </Card>
                            ) : (
                                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                                    {filtered.map((app) => (
                                        <ApplicationCard
                                            key={app.id}
                                            app={app}
                                        />
                                    ))}
                                </div>
                            )}
                        </>
                    ) : (
                        <CrossAppTimeline apps={apps} appsLoading={loading} />
                    )}
                </div>
            </main>

            <ApplicationFormDialog
                open={creating}
                onOpenChange={setCreating}
                onSaved={() => {
                    setCreating(false);
                    reload();
                }}
            />
        </>
    );
}

function ApplicationCard({ app }) {
    const latest = latestByPhase(app.releases);
    const releaseCount = app._count?.releases ?? (app.releases?.length || 0);
    return (
        <Link
            to={`/applications/${app.id}`}
            className="group flex h-full flex-col rounded-xl border bg-card shadow-sm transition-all hover:border-primary/40 hover:shadow-md"
        >
            <div className="flex items-start gap-3 p-4">
                <Logo url={app.logoUrl} name={app.name} />
                <div className="min-w-0 flex-1 space-y-1">
                    <h3 className="truncate text-base font-semibold tracking-tight group-hover:text-primary">
                        {app.name}
                    </h3>
                    {app.packageName && (
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                            {app.packageName}
                        </p>
                    )}
                    {app.description && (
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                            {app.description}
                        </p>
                    )}
                </div>
            </div>

            {/* Latest version per phase. Each row is its own line so we
                never collapse "Test v1.2.3" onto the same row as
                "Pilot v1.1.0" with a tiny separator that's hard to
                scan. Phases without a release in them render a muted
                "—" so the layout stays predictable across cards. */}
            <div className="space-y-1 px-4 pb-3 text-[11px]">
                {APPLICATION_PHASES.map((p) => (
                    <PhaseLatestRow
                        key={p}
                        phase={p}
                        release={latest[p]}
                    />
                ))}
            </div>

            <div className="mt-auto flex items-center justify-between border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                    <FileText className="h-3 w-3" />
                    {releaseCount}{' '}
                    {releaseCount === 1 ? 'release' : 'releases'}
                </span>
            </div>
        </Link>
    );
}

function PhaseLatestRow({ phase, release }) {
    const stamp = release
        ? release[`${phase.toLowerCase()}At`] ||
          release.releaseDate ||
          release.createdAt
        : null;
    return (
        <div className="flex items-center gap-2">
            <span
                className={cn(
                    'inline-flex w-16 shrink-0 items-center justify-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                    PHASE_BADGE_CLASS[phase],
                )}
            >
                {PHASE_LABEL[phase]}
            </span>
            {release ? (
                <>
                    <span className="font-mono text-foreground">
                        v{release.version}
                    </span>
                    {stamp && (
                        <span className="text-muted-foreground/70">
                            · {format(new Date(stamp), 'd MMM yyyy')}
                        </span>
                    )}
                </>
            ) : (
                <span className="text-muted-foreground/60 italic">
                    no release yet
                </span>
            )}
        </div>
    );
}

function Logo({ url, name }) {
    if (url) {
        return (
            <img
                src={resolveAssetUrl(url)}
                alt={`${name} logo`}
                className="h-12 w-12 shrink-0 rounded-lg border bg-white object-cover"
            />
        );
    }
    return (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border bg-muted text-base font-semibold text-muted-foreground">
            {(name || '?').slice(0, 2).toUpperCase()}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Cross-application activity timeline.
//
// One vertical feed showing phase transitions + checkpoints across the
// whole catalogue, newest first, grouped by day. The user can toggle
// individual apps on/off (persisted), filter by phase, and pick a
// recency window. Backed by GET /applications/timeline.
// ---------------------------------------------------------------------------
function readJsonStorage(key, fallback) {
    if (typeof window === 'undefined') return fallback;
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
    } catch {
        return fallback;
    }
}

function writeJsonStorage(key, value) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        /* quota / disabled storage — non-fatal */
    }
}

function CrossAppTimeline({ apps, appsLoading }) {
    // Per-app on/off lives in localStorage so the user's curation
    // sticks across page reloads.
    const [hiddenApps, setHiddenApps] = useState(() => {
        const stored = readJsonStorage(TIMELINE_HIDDEN_APPS_KEY, []);
        return Array.isArray(stored) ? stored : [];
    });
    const [phase, setPhase] = useState(
        () => readJsonStorage(TIMELINE_PHASE_KEY, 'all') || 'all',
    );
    const [rangeDays, setRangeDays] = useState(() => {
        const n = Number(readJsonStorage(TIMELINE_RANGE_KEY, 30));
        return Number.isFinite(n) ? n : 30;
    });
    const [viewMode, setViewMode] = useState(() => {
        const stored = readJsonStorage(TIMELINE_VIEW_MODE_KEY, 'list');
        return stored === 'strip' ? 'strip' : 'list';
    });

    useEffect(() => writeJsonStorage(TIMELINE_HIDDEN_APPS_KEY, hiddenApps), [
        hiddenApps,
    ]);
    useEffect(() => writeJsonStorage(TIMELINE_PHASE_KEY, phase), [phase]);
    useEffect(() => writeJsonStorage(TIMELINE_RANGE_KEY, rangeDays), [
        rangeDays,
    ]);
    useEffect(() => writeJsonStorage(TIMELINE_VIEW_MODE_KEY, viewMode), [
        viewMode,
    ]);

    const hiddenSet = useMemo(() => new Set(hiddenApps), [hiddenApps]);
    const visibleApps = useMemo(
        () => apps.filter((a) => !hiddenSet.has(a.id)),
        [apps, hiddenSet],
    );

    const [events, setEvents] = useState([]);
    const [loading, setLoading] = useState(false);
    const [truncated, setTruncated] = useState(false);

    // Fetch events whenever filters change. We pass `appIds` so the
    // backend doesn't have to ship events for apps the user just hid.
    // Falling back to "no apps visible" short-circuits the request.
    useEffect(() => {
        if (visibleApps.length === 0) {
            setEvents([]);
            setTruncated(false);
            return undefined;
        }
        let cancelled = false;
        const params = new URLSearchParams();
        params.set('appIds', visibleApps.map((a) => a.id).join(','));
        if (phase !== 'all') {
            if (phase === 'CHECKPOINTS') {
                params.set(
                    'kinds',
                    'PROD_DEPLOY,PROD_ROLLBACK,PILOT_DEPLOY,TEST_DEPLOY,NOTE',
                );
            } else {
                // Include both the phase transition AND any checkpoint
                // tied to that environment — they read together as one
                // story.
                params.set('phases', phase);
                const cpKind =
                    phase === 'APPROVED'
                        ? 'PROD_DEPLOY,PROD_ROLLBACK'
                        : phase === 'PILOT'
                            ? 'PILOT_DEPLOY'
                            : phase === 'TEST'
                                ? 'TEST_DEPLOY'
                                : '';
                params.set(
                    'kinds',
                    cpKind ? `phase,${cpKind}` : 'phase',
                );
            }
        }
        if (rangeDays > 0) {
            const since = new Date(
                Date.now() - rangeDays * 24 * 60 * 60 * 1000,
            ).toISOString();
            params.set('since', since);
        }
        params.set('limit', '500');

        setLoading(true);
        api.get(`/applications/timeline?${params.toString()}`)
            .then((res) => {
                if (cancelled) return;
                setEvents(res?.data?.events || []);
                setTruncated(Boolean(res?.data?.truncated));
            })
            .catch(() => {
                if (cancelled) return;
                toast.error('Could not load the activity timeline.');
                setEvents([]);
                setTruncated(false);
            })
            .finally(() => {
                if (cancelled) return;
                setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [visibleApps, phase, rangeDays]);

    // Group events by calendar day so the feed gets a date heading and
    // doesn't read as one undifferentiated list.
    const grouped = useMemo(() => groupEventsByDay(events), [events]);

    const toggleApp = (appId) => {
        setHiddenApps((prev) =>
            prev.includes(appId)
                ? prev.filter((id) => id !== appId)
                : [...prev, appId],
        );
    };

    const showAllApps = () => setHiddenApps([]);
    const hideAllApps = () => setHiddenApps(apps.map((a) => a.id));

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3 shadow-sm">
                <AppPickerDropdown
                    apps={apps}
                    hiddenSet={hiddenSet}
                    onToggle={toggleApp}
                    onShowAll={showAllApps}
                    onHideAll={hideAllApps}
                />

                <div className="flex flex-col gap-1">
                    <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Filter
                    </Label>
                    <div className="flex flex-wrap items-center gap-1">
                        {TIMELINE_PHASE_FILTERS.map((f) => {
                            const active = phase === f.id;
                            return (
                                <button
                                    key={f.id}
                                    type="button"
                                    onClick={() => setPhase(f.id)}
                                    className={cn(
                                        'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                                        active
                                            ? 'border-primary/40 bg-primary/10 text-primary'
                                            : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                                    )}
                                >
                                    {f.label}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="flex flex-col gap-1">
                    <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Range
                    </Label>
                    <Select
                        value={String(rangeDays)}
                        onValueChange={(v) => setRangeDays(Number(v))}
                    >
                        <SelectTrigger className="w-[170px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {TIMELINE_RANGE_OPTIONS.map((opt) => (
                                <SelectItem
                                    key={opt.id}
                                    value={String(opt.id)}
                                >
                                    {opt.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex flex-col gap-1">
                    <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        View
                    </Label>
                    <div
                        className="inline-flex rounded-md border bg-card p-0.5"
                        role="tablist"
                        aria-label="Timeline layout"
                    >
                        {TIMELINE_VIEW_MODES.map((m) => {
                            const Icon = m.icon;
                            const active = viewMode === m.id;
                            return (
                                <button
                                    key={m.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={active}
                                    onClick={() => setViewMode(m.id)}
                                    className={cn(
                                        'inline-flex h-8 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors',
                                        active
                                            ? 'bg-primary/10 text-primary'
                                            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                                    )}
                                    title={
                                        m.id === 'list'
                                            ? 'Vertical list grouped by day'
                                            : 'Horizontally scrollable card strip'
                                    }
                                >
                                    <Icon className="h-3.5 w-3.5" />
                                    {m.label}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                    <span>
                        {events.length}{' '}
                        {events.length === 1 ? 'event' : 'events'}
                        {truncated && ' (capped at 500)'}
                    </span>
                    <span className="hidden sm:inline">
                        {apps.length - hiddenSet.size}/{apps.length} apps
                    </span>
                </div>
            </div>

            {appsLoading || (loading && events.length === 0) ? (
                <Card>
                    <CardContent className="p-6 text-sm text-muted-foreground">
                        Loading activity...
                    </CardContent>
                </Card>
            ) : visibleApps.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                        <Filter className="h-7 w-7 text-muted-foreground/60" />
                        <p>
                            Every application is currently hidden. Use
                            the &ldquo;Applications&rdquo; picker above
                            to bring some back into view.
                        </p>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={showAllApps}
                        >
                            Show all applications
                        </Button>
                    </CardContent>
                </Card>
            ) : events.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                        <History className="h-7 w-7 text-muted-foreground/60" />
                        <p>
                            No activity matches the current filters.
                            Widen the range, change the phase, or
                            include more applications.
                        </p>
                    </CardContent>
                </Card>
            ) : viewMode === 'strip' ? (
                <TimelineStripView events={events} />
            ) : (
                <Card>
                    <CardContent className="p-0">
                        {grouped.map((group) => (
                            <div key={group.dayKey}>
                                <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-y bg-muted/60 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                                    <span className="inline-flex items-center gap-1.5">
                                        <Calendar className="h-3.5 w-3.5" />
                                        {group.dayLabel}
                                    </span>
                                    <span className="font-normal">
                                        {group.events.length}{' '}
                                        {group.events.length === 1
                                            ? 'event'
                                            : 'events'}
                                    </span>
                                </div>
                                <ul className="divide-y">
                                    {group.events.map((evt) => (
                                        <TimelineEventRow
                                            key={evt.id}
                                            event={evt}
                                        />
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

function groupEventsByDay(events) {
    const map = new Map();
    for (const e of events) {
        const d = new Date(e.at);
        if (Number.isNaN(d.getTime())) continue;
        const key = format(d, 'yyyy-MM-dd');
        if (!map.has(key)) {
            map.set(key, {
                dayKey: key,
                dayDate: d,
                dayLabel: prettyDayLabel(d),
                events: [],
            });
        }
        map.get(key).events.push(e);
    }
    return Array.from(map.values()).sort(
        (a, b) => b.dayDate.getTime() - a.dayDate.getTime(),
    );
}

function prettyDayLabel(d) {
    if (isToday(d)) return `Today · ${format(d, 'EEEE, d MMM yyyy')}`;
    if (isYesterday(d)) {
        return `Yesterday · ${format(d, 'EEEE, d MMM yyyy')}`;
    }
    return format(d, 'EEEE, d MMM yyyy');
}

function badgeFor(event) {
    if (event.kind === 'phase') return EVENT_BADGE[event.phase];
    return EVENT_BADGE[event.checkpointKind] || EVENT_BADGE.NOTE;
}

function TimelineEventRow({ event }) {
    const badge = badgeFor(event) || EVENT_BADGE.NOTE;
    const Icon = badge.icon || StickyNote;
    const at = new Date(event.at);
    const application = event.application || {};
    const release = event.release || {};
    const cp = event.checkpoint;

    return (
        <li className="group flex flex-col gap-2 px-4 py-3 hover:bg-muted/40 sm:flex-row sm:items-start">
            <div className="flex shrink-0 items-start gap-2 sm:w-[26%] sm:min-w-[180px]">
                <span
                    className={cn(
                        'mt-1.5 inline-flex h-2 w-2 shrink-0 rounded-full',
                        badge.dot,
                    )}
                    aria-hidden
                />
                <Link
                    to={`/applications/${application.id}`}
                    className="flex min-w-0 items-center gap-2 text-sm font-medium hover:text-primary"
                    title={application.name}
                >
                    {application.logoUrl ? (
                        <img
                            src={resolveAssetUrl(application.logoUrl)}
                            alt=""
                            className="h-7 w-7 shrink-0 rounded-md border bg-white object-cover"
                        />
                    ) : (
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-muted text-[10px] font-semibold text-muted-foreground">
                            {(application.name || '?')
                                .slice(0, 2)
                                .toUpperCase()}
                        </span>
                    )}
                    <span className="truncate">{application.name}</span>
                </Link>
            </div>

            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span
                        className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                            badge.chip,
                        )}
                    >
                        <Icon className="h-3 w-3" />
                        {badge.label}
                    </span>
                    {release.version && (
                        <Link
                            to={`/applications/${application.id}`}
                            className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 font-mono text-[11px] font-semibold text-primary hover:bg-primary/5"
                            title={`Open ${application.name}`}
                        >
                            <Tag className="h-3 w-3" />v{release.version}
                        </Link>
                    )}
                    {cp?.environment && (
                        <span className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
                            {cp.environment}
                        </span>
                    )}
                    {release.hasFile && (
                        <span
                            className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-[11px] text-muted-foreground"
                            title={release.fileName || 'Artifact attached'}
                        >
                            <Download className="h-3 w-3" />
                            artifact
                        </span>
                    )}
                </div>
                {(cp?.note ||
                    release.fixesPreview ||
                    release.importantNotesPreview) && (
                    <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
                        {cp?.note ||
                            release.fixesPreview ||
                            release.importantNotesPreview}
                    </p>
                )}
            </div>

            <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground sm:flex-col sm:items-end sm:gap-0.5">
                <span title={format(at, 'EEEE, d MMM yyyy HH:mm')}>
                    {format(at, 'HH:mm')}
                </span>
                <span className="text-[11px] text-muted-foreground/80">
                    {formatDistanceToNow(at, { addSuffix: true })}
                </span>
                {cp?.author && (
                    <span className="inline-flex items-center gap-1 text-[11px]">
                        <Avatar className="h-4 w-4">
                            {cp.author.avatarUrl && (
                                <AvatarImage
                                    src={resolveAssetUrl(cp.author.avatarUrl)}
                                    alt=""
                                />
                            )}
                            <AvatarFallback className="text-[8px]">
                                {initials(cp.author.name || cp.author.email)}
                            </AvatarFallback>
                        </Avatar>
                        <span className="truncate max-w-[160px]">
                            {cp.author.name || cp.author.email}
                        </span>
                    </span>
                )}
            </div>
        </li>
    );
}

function AppPickerDropdown({
    apps,
    hiddenSet,
    onToggle,
    onShowAll,
    onHideAll,
}) {
    const visibleCount = apps.length - hiddenSet.size;
    const allVisible = hiddenSet.size === 0;
    return (
        <div className="flex flex-col gap-1">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Applications
            </Label>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        type="button"
                        variant="outline"
                        className={cn(
                            'h-9 min-w-[220px] justify-between gap-2 px-3 text-sm font-normal',
                            !allVisible && 'border-primary/40 bg-primary/5',
                        )}
                    >
                        <span className="inline-flex items-center gap-1.5">
                            <Filter className="h-3.5 w-3.5" />
                            {apps.length === 0
                                ? 'No applications'
                                : allVisible
                                    ? `All ${apps.length} apps`
                                    : `${visibleCount} of ${apps.length} apps`}
                        </span>
                        <ChevronDown className="h-4 w-4 opacity-60" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="start"
                    className="w-72 max-w-[calc(100vw-2rem)]"
                >
                    <DropdownMenuLabel className="flex items-center justify-between text-xs">
                        <span>Show / hide applications</span>
                        <div className="flex gap-2 text-[11px] font-normal">
                            <button
                                type="button"
                                onClick={onShowAll}
                                className="text-primary hover:underline"
                            >
                                Show all
                            </button>
                            <button
                                type="button"
                                onClick={onHideAll}
                                className="text-muted-foreground hover:underline"
                            >
                                Hide all
                            </button>
                        </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {apps.length === 0 ? (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">
                            No applications yet.
                        </p>
                    ) : (
                        <div className="max-h-72 overflow-y-auto py-1">
                            {apps.map((app) => {
                                const checked = !hiddenSet.has(app.id);
                                return (
                                    <button
                                        key={app.id}
                                        type="button"
                                        onClick={() => onToggle(app.id)}
                                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                                    >
                                        <span
                                            className={cn(
                                                'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                                checked
                                                    ? 'border-primary bg-primary text-primary-foreground'
                                                    : 'border-muted-foreground/40',
                                            )}
                                        >
                                            {checked && (
                                                <Check className="h-3 w-3" />
                                            )}
                                        </span>
                                        {app.logoUrl ? (
                                            <img
                                                src={resolveAssetUrl(
                                                    app.logoUrl,
                                                )}
                                                alt=""
                                                className="h-5 w-5 shrink-0 rounded border bg-white object-cover"
                                            />
                                        ) : (
                                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border bg-muted text-[9px] font-semibold text-muted-foreground">
                                                {(app.name || '?')
                                                    .slice(0, 2)
                                                    .toUpperCase()}
                                            </span>
                                        )}
                                        <span className="truncate">
                                            {app.name}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Horizontally scrollable card strip for the cross-app timeline.
//
// Mirrors the per-application timeline tab inside ApplicationDetail.jsx:
//   - mouse-wheel scrolls horizontally
//   - grab-and-pan with the primary pointer button
//   - left/right chevrons jump to the start / end
//   - edge fade masks keep the cards from bleeding under the chevrons
//
// Implementation kept self-contained so it doesn't import internals
// from ApplicationDetail.jsx (which would create a circular page-to-
// page coupling).
// ---------------------------------------------------------------------------
function TimelineStripView({ events }) {
    const scrollerRef = useRef(null);
    const [openId, setOpenId] = useState(null);
    const [isDragging, setIsDragging] = useState(false);

    // Wheel-to-scroll-horizontally. Only hijack when the strip actually
    // has overflow, otherwise let the page take the scroll naturally.
    useEffect(() => {
        const el = scrollerRef.current;
        if (!el) return undefined;
        const onWheel = (e) => {
            if (e.deltaY === 0) return;
            if (el.scrollWidth <= el.clientWidth) return;
            e.preventDefault();
            el.scrollBy({ left: e.deltaY, behavior: 'auto' });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [events.length]);

    // Drag-to-pan. We swallow the synthetic click that fires after a
    // drag of more than a few pixels so the card the user happened to
    // start on doesn't toggle open at the end of every pan.
    useEffect(() => {
        const el = scrollerRef.current;
        if (!el) return undefined;
        let active = false;
        let startX = 0;
        let startScroll = 0;
        let moved = 0;

        const onPointerDown = (e) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            const target = e.target;
            if (
                target instanceof Element &&
                (target.closest('[data-no-drag]') ||
                    target.closest('a') ||
                    target.closest('button'))
            ) {
                return;
            }
            active = true;
            startX = e.clientX;
            startScroll = el.scrollLeft;
            moved = 0;
            setIsDragging(true);
            el.setPointerCapture?.(e.pointerId);
        };
        const onPointerMove = (e) => {
            if (!active) return;
            const dx = e.clientX - startX;
            moved = Math.max(moved, Math.abs(dx));
            el.scrollLeft = startScroll - dx;
        };
        const stop = (e) => {
            if (!active) return;
            active = false;
            setIsDragging(false);
            if (moved > 5) {
                const swallow = (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    el.removeEventListener('click', swallow, true);
                };
                el.addEventListener('click', swallow, true);
                setTimeout(
                    () => el.removeEventListener('click', swallow, true),
                    250,
                );
            }
            try {
                el.releasePointerCapture?.(e.pointerId);
            } catch {
                /* pointer was already released */
            }
        };

        el.addEventListener('pointerdown', onPointerDown);
        el.addEventListener('pointermove', onPointerMove);
        el.addEventListener('pointerup', stop);
        el.addEventListener('pointercancel', stop);
        el.addEventListener('pointerleave', stop);
        return () => {
            el.removeEventListener('pointerdown', onPointerDown);
            el.removeEventListener('pointermove', onPointerMove);
            el.removeEventListener('pointerup', stop);
            el.removeEventListener('pointercancel', stop);
            el.removeEventListener('pointerleave', stop);
        };
    }, [events.length]);

    const scrollToEdge = (where) => {
        const el = scrollerRef.current;
        if (!el) return;
        el.scrollTo({
            left: where === 'start' ? 0 : el.scrollWidth,
            behavior: 'smooth',
        });
    };

    return (
        <div className="relative rounded-lg border bg-card p-2 shadow-sm">
            {/* Edge fade masks behind the chevrons so cards don't
                appear to bleed through. Pointer-events-none keeps
                them from swallowing clicks intended for cards. */}
            <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-0 z-10 hidden w-14 rounded-l-lg bg-gradient-to-r from-card via-card/85 to-transparent sm:block"
            />
            <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 right-0 z-10 hidden w-14 rounded-r-lg bg-gradient-to-l from-card via-card/85 to-transparent sm:block"
            />
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    scrollToEdge('start');
                }}
                onPointerDown={(e) => e.stopPropagation()}
                data-no-drag
                className="absolute left-2 top-1/2 z-20 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground sm:flex"
                aria-label="Jump to the beginning"
                title="Jump to the beginning"
            >
                <ChevronsLeft className="h-4 w-4" />
            </button>
            <button
                type="button"
                onClick={(e) => {
                    e.stopPropagation();
                    scrollToEdge('end');
                }}
                onPointerDown={(e) => e.stopPropagation()}
                data-no-drag
                className="absolute right-2 top-1/2 z-20 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground sm:flex"
                aria-label="Jump to the end"
                title="Jump to the end"
            >
                <ChevronsRight className="h-4 w-4" />
            </button>

            <div
                ref={scrollerRef}
                className={cn(
                    'relative overflow-x-scroll select-none pb-3 pt-2',
                    isDragging ? 'cursor-grabbing' : 'cursor-grab',
                )}
                style={{ scrollbarGutter: 'stable' }}
            >
                <div
                    className="pointer-events-none absolute inset-x-0 top-1/2 -z-0 h-px border-t-2 border-dotted border-muted-foreground/30"
                    aria-hidden
                />
                <ul className="relative z-10 flex items-stretch gap-4 px-[52px]">
                    {events.map((evt) => (
                        <li
                            key={evt.id}
                            className="shrink-0"
                            style={{
                                width: openId === evt.id ? 340 : 220,
                            }}
                        >
                            <TimelineStripCard
                                event={evt}
                                isOpen={openId === evt.id}
                                onToggle={() =>
                                    setOpenId((cur) =>
                                        cur === evt.id ? null : evt.id,
                                    )
                                }
                            />
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}

function TimelineStripCard({ event, isOpen, onToggle }) {
    const badge = badgeFor(event) || EVENT_BADGE.NOTE;
    const Icon = badge.icon || StickyNote;
    const at = new Date(event.at);
    const application = event.application || {};
    const release = event.release || {};
    const cp = event.checkpoint;
    const isCheckpoint = event.kind === 'checkpoint';

    return (
        <Card className="relative h-full overflow-hidden transition-all">
            <div className={cn('h-1 w-full', badge.dot)} />
            <CardContent className="space-y-2 p-3">
                <div className="flex items-start gap-2">
                    <button
                        type="button"
                        onClick={onToggle}
                        className={cn(
                            'relative -ml-1 -mt-1 shrink-0 rounded-xl border p-1 transition-transform hover:scale-105',
                            badge.chip,
                        )}
                        aria-expanded={isOpen}
                        aria-label={
                            isOpen
                                ? 'Collapse event details'
                                : 'Expand event details'
                        }
                    >
                        {application.logoUrl ? (
                            <img
                                src={resolveAssetUrl(application.logoUrl)}
                                alt={application.name || ''}
                                className="h-9 w-9 rounded-lg bg-white object-cover"
                            />
                        ) : (
                            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-xs font-bold uppercase text-foreground">
                                {(application.name || '?').slice(0, 2)}
                            </span>
                        )}
                        <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-white shadow ring-1 ring-border">
                            <Icon className="h-2.5 w-2.5 text-foreground" />
                        </span>
                    </button>

                    <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {format(at, 'd MMM yyyy · HH:mm')}
                        </div>
                        <Link
                            to={`/applications/${application.id}`}
                            data-no-drag
                            onClick={(e) => e.stopPropagation()}
                            className="block truncate text-sm font-semibold hover:text-primary"
                            title={application.name}
                        >
                            {application.name}
                        </Link>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span
                                className={cn(
                                    'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                    badge.chip,
                                )}
                            >
                                {badge.label}
                            </span>
                            {release.version && (
                                <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground">
                                    v{release.version}
                                </span>
                            )}
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {isCheckpoint ? 'checkpoint' : 'phase'}
                            </span>
                        </div>
                    </div>
                </div>

                {isOpen && (
                    <div className="space-y-2 border-t pt-2 text-xs">
                        {cp?.environment && (
                            <div>
                                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    Environment
                                </div>
                                <p className="break-words text-foreground">
                                    {cp.environment}
                                </p>
                            </div>
                        )}
                        {(cp?.note ||
                            release.fixesPreview ||
                            release.importantNotesPreview) && (
                            <div>
                                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    {cp?.note
                                        ? 'Note'
                                        : release.fixesPreview
                                            ? 'What changed'
                                            : 'Important notes'}
                                </div>
                                <p className="whitespace-pre-wrap break-words text-foreground">
                                    {cp?.note ||
                                        release.fixesPreview ||
                                        release.importantNotesPreview}
                                </p>
                            </div>
                        )}
                        <div className="flex flex-wrap items-center gap-1 border-t pt-2 text-[10px] text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            <span>
                                {format(at, 'EEEE, d MMM yyyy HH:mm')}
                            </span>
                            {release.hasFile && (
                                <span className="inline-flex items-center gap-1 rounded-full border bg-card px-1.5 py-0.5">
                                    <Download className="h-3 w-3" />
                                    artifact
                                </span>
                            )}
                        </div>
                        {cp?.author && (
                            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                <Avatar className="h-4 w-4">
                                    {cp.author.avatarUrl && (
                                        <AvatarImage
                                            src={resolveAssetUrl(
                                                cp.author.avatarUrl,
                                            )}
                                            alt=""
                                        />
                                    )}
                                    <AvatarFallback className="text-[8px]">
                                        {initials(
                                            cp.author.name ||
                                                cp.author.email,
                                        )}
                                    </AvatarFallback>
                                </Avatar>
                                <span className="truncate">
                                    {cp.author.name || cp.author.email}
                                </span>
                            </div>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
