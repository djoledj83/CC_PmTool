// /users/:id — public-ish user profile view.
//
// Open to any signed-in user (the data is already exposed piecemeal
// elsewhere — this just packages it into one nice surface). Renders:
//
//   - Hero card with avatar / name / role / position / business unit
//   - Contact strip (email, phone, country, currency)
//   - About / bio panel
//   - Team panel: leader + direct reports + Teams membership
//   - Work stats KPIs (projects, tasks, sprints, applications, hours)
//   - 12-week time-tracking heatmap (GitHub-style)
//   - Recent activity timeline
//   - Personal highlights summary (only on own profile)
//
// All of the above comes from a single GET /api/users/:id/profile call.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { format, formatDistanceToNow } from 'date-fns';
import {
    Activity,
    AppWindow,
    ArrowLeft,
    BadgeCheck,
    Briefcase,
    Building2,
    CheckCircle2,
    Clock,
    Crown,
    FolderKanban,
    Globe2,
    Highlighter,
    ListChecks,
    Loader2,
    Mail,
    MessageSquare,
    Pencil,
    Phone,
    Pin,
    RotateCcw,
    Rocket,
    ShieldCheck,
    Sparkles,
    Star,
    Target,
    Timer,
    Users as UsersIcon,
    XCircle,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { ROLE_LABELS } from '@/lib/capabilities';
import { formatHoursAsHM } from '@/lib/time';
import { useAuth } from '@/contexts/AuthContext';
import { TopBar } from '@/components/TopBar';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import AvatarLightbox from '@/components/AvatarLightbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tip } from '@/components/Tip';

const ROLE_TONE = {
    ADMIN:
        'bg-primary/15 text-primary border border-primary/30',
    MANAGER:
        'bg-sky-500/15 text-sky-700 border border-sky-500/30 dark:text-sky-300',
    APP_MODERATOR:
        'bg-violet-500/15 text-violet-700 border border-violet-500/30 dark:text-violet-300',
    USER:
        'bg-muted text-muted-foreground border border-border',
};

const STATUS_TONE = {
    ACTIVE:
        'bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 dark:text-emerald-300',
    PENDING:
        'bg-amber-500/15 text-amber-700 border border-amber-500/30 dark:text-amber-300',
    SUSPENDED:
        'bg-rose-500/15 text-rose-700 border border-rose-500/30 dark:text-rose-300',
};

// Activity-feed type → small icon for the recent-activity timeline.
// We keep this list short (the per-page activity feed has the full
// taxonomy); anything not listed falls back to a generic dot.
const ACTIVITY_ICON = {
    PROJECT_CREATED: FolderKanban,
    PROJECT_ARCHIVED: FolderKanban,
    PROJECT_UNARCHIVED: FolderKanban,
    TASK_CREATED: ListChecks,
    TASK_STATUS_CHANGED: ListChecks,
    TASK_APPROVED: CheckCircle2,
    TASK_DISAPPROVED: XCircle,
    TASK_APPROVAL_REQUESTED: RotateCcw,
    SPRINT_STARTED: Rocket,
    SPRINT_CLOSED: Rocket,
    SPRINT_REOPENED: Rocket,
    SPRINT_BULK_DELETED: Rocket,
    APPLICATION_CREATED: AppWindow,
    APP_RELEASE_UPLOADED: Rocket,
    USER_APPROVED: BadgeCheck,
    TIME_ENTRY_TRACKED: Timer,
    TIME_ENTRY_MANUAL_ADDED: Timer,
};

export default function UserProfile() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { user: me } = useAuth();
    const isAdmin = me?.role === 'ADMIN';
    const isSelf = me?.id === id;

    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    // Avatar parallax lightbox (header photo).
    const [photoOpen, setPhotoOpen] = useState(false);
    // Heatmap period in days. Stored at the page level so changing it
    // triggers a single refetch (server bucketing keeps the FE simple).
    const [heatmapDays, setHeatmapDays] = useState(84);
    const [heatmapLoading, setHeatmapLoading] = useState(false);

    useEffect(() => {
        let cancelled = false;
        // Only show the page-wide spinner on the first load. Period
        // switches just dim the heatmap card instead of nuking the
        // whole page.
        if (!data) setLoading(true);
        else setHeatmapLoading(true);
        setError(null);
        api.get(`/users/${id}/profile`, { params: { heatmapDays } })
            .then((res) => {
                if (cancelled) return;
                setData(res.data);
            })
            .catch((err) => {
                if (cancelled) return;
                setError(
                    err?.response?.data?.message || 'Could not load profile',
                );
            })
            .finally(() => {
                if (cancelled) return;
                setLoading(false);
                setHeatmapLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id, heatmapDays]);

    if (loading) {
        return (
            <>
                <TopBar title="Profile" />
                <main className="flex flex-1 items-center justify-center bg-muted/20 p-6">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </main>
            </>
        );
    }

    if (error || !data) {
        return (
            <>
                <TopBar title="Profile" />
                <main className="flex flex-1 items-center justify-center bg-muted/20 p-6">
                    <div className="max-w-md rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground shadow-sm">
                        <p>{error || 'Profile not found.'}</p>
                        <Button
                            variant="outline"
                            size="sm"
                            className="mt-4"
                            onClick={() => navigate(-1)}
                        >
                            <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                            Go back
                        </Button>
                    </div>
                </main>
            </>
        );
    }

    const {
        user,
        teams,
        directReports,
        stats,
        timeHeatmap,
        recentActivity,
        pinCounts,
        projects = [],
    } = data;
    const roleLabel = ROLE_LABELS[user.role] || user.role;
    const memberSince = user.createdAt
        ? format(new Date(user.createdAt), 'MMM yyyy')
        : '—';
    const lastSeen = user.lastLoginAt
        ? formatDistanceToNow(new Date(user.lastLoginAt), { addSuffix: true })
        : 'never';

    return (
        <>
            <TopBar
                title={user.name}
                actions={
                    <>
                        {isAdmin && !isSelf && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => navigate(`/users?edit=${id}`)}
                            >
                                <Pencil className="mr-1 h-3.5 w-3.5" />
                                Edit
                            </Button>
                        )}
                        {!isSelf && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                    navigate(`/messages?dm=${id}`)
                                }
                            >
                                <MessageSquare className="mr-1 h-3.5 w-3.5" />
                                Message
                            </Button>
                        )}
                    </>
                }
            />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="mx-auto flex max-w-6xl flex-col gap-4">
                    {/* Hero card --------------------------------------- */}
                    <Card className="overflow-hidden">
                        <div
                            className="h-20 bg-gradient-to-r from-primary/15 via-sky-500/10 to-emerald-500/10"
                            aria-hidden
                        />
                        <CardContent className="-mt-12 flex flex-col gap-4 sm:flex-row sm:items-end">
                            <span
                                className={cn(
                                    'inline-block rounded-full',
                                    user.avatarUrl &&
                                        'cursor-zoom-in transition-shadow hover:ring-2 hover:ring-primary/50',
                                )}
                                title={user.avatarUrl ? 'View photo' : undefined}
                                onClick={() => {
                                    if (user.avatarUrl) setPhotoOpen(true);
                                }}
                            >
                                <Avatar className="h-24 w-24 ring-4 ring-background sm:h-28 sm:w-28">
                                    {user.avatarUrl && (
                                        <AvatarImage
                                            src={resolveAssetUrl(user.avatarUrl)}
                                            alt={user.name}
                                        />
                                    )}
                                    <AvatarFallback className="bg-primary/10 text-2xl font-semibold text-primary">
                                        {initials(user.name || '?')}
                                    </AvatarFallback>
                                </Avatar>
                            </span>
                            <AvatarLightbox
                                open={photoOpen}
                                src={
                                    user.avatarUrl
                                        ? resolveAssetUrl(user.avatarUrl)
                                        : null
                                }
                                name={user.name}
                                subtitle={user.position || user.email}
                                onClose={() => setPhotoOpen(false)}
                            />
                            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 className="truncate text-xl font-semibold sm:text-2xl">
                                        {user.name}
                                    </h2>
                                    <span
                                        className={cn(
                                            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                                            ROLE_TONE[user.role] ||
                                                ROLE_TONE.USER,
                                        )}
                                    >
                                        {user.role === 'ADMIN' && (
                                            <ShieldCheck className="h-3 w-3" />
                                        )}
                                        {roleLabel}
                                    </span>
                                    <span
                                        className={cn(
                                            'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                                            STATUS_TONE[user.status] ||
                                                STATUS_TONE.ACTIVE,
                                        )}
                                    >
                                        {user.status.toLowerCase()}
                                    </span>
                                    {isSelf && (
                                        <span className="rounded-full border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                            you
                                        </span>
                                    )}
                                </div>
                                {(user.position ||
                                    user.businessUnit?.name) && (
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
                                        {user.position && (
                                            <span className="inline-flex items-center gap-1">
                                                <Briefcase className="h-3.5 w-3.5" />
                                                {user.position}
                                            </span>
                                        )}
                                        {user.businessUnit?.name && (
                                            <span className="inline-flex items-center gap-1">
                                                <Building2 className="h-3.5 w-3.5" />
                                                {user.businessUnit.name}
                                            </span>
                                        )}
                                    </div>
                                )}
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                                    <a
                                        href={`mailto:${user.email}`}
                                        className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                                    >
                                        <Mail className="h-3 w-3" />
                                        {user.email}
                                    </a>
                                    {user.phone && (
                                        <a
                                            href={`tel:${user.phone}`}
                                            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                                        >
                                            <Phone className="h-3 w-3" />
                                            {user.phone}
                                        </a>
                                    )}
                                    {user.country && (
                                        <span className="inline-flex items-center gap-1">
                                            <Globe2 className="h-3 w-3" />
                                            {user.country}
                                        </span>
                                    )}
                                    {user.currency && (
                                        <span className="inline-flex items-center gap-1 rounded border bg-muted/40 px-1.5 py-px font-mono text-[10px] uppercase">
                                            {user.currency}
                                        </span>
                                    )}
                                </div>
                                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                                    <span>
                                        Member since{' '}
                                        <strong className="text-foreground">
                                            {memberSince}
                                        </strong>
                                    </span>
                                    <span>
                                        Last seen{' '}
                                        <strong className="text-foreground">
                                            {lastSeen}
                                        </strong>
                                    </span>
                                </div>
                            </div>
                        </CardContent>
                    </Card>

                    {/* About + sidebar layout ------------------------ */}
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
                        <div className="space-y-4">
                            {/* Work stats KPIs */}
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                                        <Activity className="h-3.5 w-3.5" />
                                        Work stats
                                    </CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                                        <KpiTile
                                            icon={FolderKanban}
                                            label="Projects owned"
                                            value={stats.projectsOwned}
                                            tone="text-primary"
                                        />
                                        <KpiTile
                                            icon={UsersIcon}
                                            label="Participating in"
                                            value={stats.projectsParticipating}
                                            tone="text-sky-600"
                                        />
                                        <KpiTile
                                            icon={ListChecks}
                                            label="Tasks assigned"
                                            value={stats.tasksAssigned}
                                            sublabel={`${stats.tasksDone} done · ${stats.tasksInProgress} in progress`}
                                            tone="text-violet-600"
                                        />
                                        <KpiTile
                                            icon={Rocket}
                                            label="Sprints created"
                                            value={stats.sprintsCreated}
                                            tone="text-emerald-600"
                                        />
                                        <KpiTile
                                            icon={AppWindow}
                                            label="Apps created"
                                            value={stats.applicationsCreated}
                                            tone="text-fuchsia-600"
                                        />
                                        <KpiTile
                                            icon={Sparkles}
                                            label="Releases uploaded"
                                            value={stats.releasesUploaded}
                                            tone="text-amber-600"
                                        />
                                        <KpiTile
                                            icon={Clock}
                                            label="Total logged"
                                            value={formatHoursAsHM(
                                                stats.totalHours,
                                            )}
                                            sublabel={`${stats.totalEntries} entries`}
                                            tone="text-rose-600"
                                        />
                                        <KpiTile
                                            icon={Timer}
                                            label="Last 7 / 30 days"
                                            value={`${formatHoursAsHM(stats.hoursLast7d)} · ${formatHoursAsHM(stats.hoursLast30d)}`}
                                            sublabel="this week · this month"
                                            tone="text-cyan-600"
                                        />
                                    </div>
                                </CardContent>
                            </Card>

                            {/* About / bio */}
                            {user.about && (
                                <Card>
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                                            About
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                                            {user.about}
                                        </p>
                                    </CardContent>
                                </Card>
                            )}

                            {/* Time-tracking heatmap with period switcher */}
                            <Card>
                                <CardHeader className="flex flex-col gap-2 space-y-0 pb-2 sm:flex-row sm:items-center sm:justify-between">
                                    <CardTitle className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                                        <Clock className="h-3.5 w-3.5" />
                                        Time tracking
                                        <span className="ml-1 normal-case text-[10px] font-normal text-muted-foreground/80">
                                            ({HEATMAP_PERIODS.find((p) => p.days === heatmapDays)?.label || `${heatmapDays}d`})
                                        </span>
                                    </CardTitle>
                                    <div className="flex items-center gap-2">
                                        <PeriodPicker
                                            value={heatmapDays}
                                            onChange={setHeatmapDays}
                                            disabled={heatmapLoading}
                                        />
                                        <Tip variant="info" side="left">
                                            <p className="font-medium">
                                                Reading the grid
                                            </p>
                                            <p className="mt-1 text-muted-foreground">
                                                Each cell is one day.
                                                Rows are weekdays
                                                (Mon → Sun), columns
                                                are weeks (oldest → newest).
                                                Hover any cell for the
                                                exact total. Cells use
                                                fixed hour buckets so
                                                colours are comparable
                                                across periods.
                                            </p>
                                        </Tip>
                                    </div>
                                </CardHeader>
                                <CardContent
                                    className={cn(
                                        heatmapLoading && 'opacity-60',
                                    )}
                                >
                                    <TimeHeatmap data={timeHeatmap} />
                                </CardContent>
                            </Card>

                            {/* Recent activity */}
                            <Card>
                                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                    <CardTitle className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                                        <Activity className="h-3.5 w-3.5" />
                                        Recent activity
                                    </CardTitle>
                                    {isAdmin && (
                                        <Link
                                            to={`/activities?userId=${id}`}
                                            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                                        >
                                            Open feed →
                                        </Link>
                                    )}
                                </CardHeader>
                                <CardContent>
                                    {recentActivity.length === 0 ? (
                                        <p className="rounded border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                                            No tracked activity yet.
                                        </p>
                                    ) : (
                                        <ul className="space-y-2">
                                            {recentActivity.map((evt) => {
                                                const Icon =
                                                    ACTIVITY_ICON[evt.type] ||
                                                    Activity;
                                                return (
                                                    <li
                                                        key={evt.id}
                                                        className="flex items-start gap-3 text-sm"
                                                    >
                                                        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                                                            <Icon className="h-3.5 w-3.5" />
                                                        </span>
                                                        <div className="min-w-0 flex-1">
                                                            <p className="truncate text-sm">
                                                                <span className="text-muted-foreground">
                                                                    {evt.type
                                                                        .toLowerCase()
                                                                        .replace(/_/g, ' ')}
                                                                </span>
                                                                {evt.message && (
                                                                    <>
                                                                        {' — '}
                                                                        <span className="font-medium">
                                                                            {evt.message}
                                                                        </span>
                                                                    </>
                                                                )}
                                                            </p>
                                                            <p className="text-[11px] text-muted-foreground">
                                                                {evt.project && (
                                                                    <Link
                                                                        to={`/projects/${evt.project.id}`}
                                                                        className="hover:text-foreground hover:underline"
                                                                    >
                                                                        {evt.project.name}
                                                                    </Link>
                                                                )}
                                                                {evt.project && ' · '}
                                                                {formatDistanceToNow(
                                                                    new Date(
                                                                        evt.createdAt,
                                                                    ),
                                                                    {
                                                                        addSuffix: true,
                                                                    },
                                                                )}
                                                            </p>
                                                        </div>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </CardContent>
                            </Card>
                        </div>

                        {/* Sidebar -------------------------------------- */}
                        <aside className="space-y-4">
                            {/* Team leader + direct reports */}
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                                        <UsersIcon className="h-3.5 w-3.5" />
                                        Team
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <div>
                                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                            Reports to
                                        </p>
                                        {user.teamLeader ? (
                                            <UserChip
                                                user={user.teamLeader}
                                                icon={Crown}
                                            />
                                        ) : (
                                            <p className="text-xs italic text-muted-foreground">
                                                No team leader set
                                            </p>
                                        )}
                                    </div>
                                    <div>
                                        <p className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                            <span>Direct reports</span>
                                            {directReports.length > 0 && (
                                                <Badge
                                                    variant="outline"
                                                    className="h-4 px-1 text-[9px]"
                                                >
                                                    {directReports.length}
                                                </Badge>
                                            )}
                                        </p>
                                        {directReports.length === 0 ? (
                                            <p className="text-xs italic text-muted-foreground">
                                                None
                                            </p>
                                        ) : (
                                            <ul className="space-y-1.5">
                                                {directReports.map((r) => (
                                                    <li key={r.id}>
                                                        <UserChip user={r} />
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Team memberships */}
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                                        <Target className="h-3.5 w-3.5" />
                                        Teams
                                    </CardTitle>
                                </CardHeader>
                                <CardContent>
                                    {teams.length === 0 ? (
                                        <p className="text-xs italic text-muted-foreground">
                                            Not a member of any team yet.
                                        </p>
                                    ) : (
                                        <ul className="space-y-2">
                                            {teams.map((t) => (
                                                <li
                                                    key={t.id}
                                                    className="rounded-md border bg-muted/20 p-2 text-xs"
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <p className="truncate font-medium text-foreground">
                                                            {t.name}
                                                        </p>
                                                        {typeof t.memberCount ===
                                                            'number' && (
                                                            <Badge
                                                                variant="outline"
                                                                className="h-4 px-1 text-[9px]"
                                                            >
                                                                {t.memberCount}
                                                            </Badge>
                                                        )}
                                                    </div>
                                                    {t.description && (
                                                        <p className="line-clamp-2 text-[11px] text-muted-foreground">
                                                            {t.description}
                                                        </p>
                                                    )}
                                                    <p className="text-[10px] text-muted-foreground">
                                                        Joined{' '}
                                                        {format(
                                                            new Date(
                                                                t.joinedAt,
                                                            ),
                                                            'd MMM yyyy',
                                                        )}
                                                    </p>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </CardContent>
                            </Card>

                            {/* Projects the user owns or participates in —
                                each links straight to the project. */}
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                                        <FolderKanban className="h-3.5 w-3.5" />
                                        Projects
                                        {projects.length > 0 && (
                                            <Badge
                                                variant="outline"
                                                className="ml-auto h-4 px-1 text-[9px]"
                                            >
                                                {projects.length}
                                            </Badge>
                                        )}
                                    </CardTitle>
                                </CardHeader>
                                <CardContent>
                                    {projects.length === 0 ? (
                                        <p className="text-xs italic text-muted-foreground">
                                            Not involved in any projects yet.
                                        </p>
                                    ) : (
                                        <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                                            {projects.map((p) => (
                                                <li key={p.id}>
                                                    <Link
                                                        to={`/projects/${p.id}`}
                                                        className="group flex items-center gap-2 rounded-md border bg-muted/20 p-2 text-xs transition-colors hover:border-primary/40 hover:bg-primary/5"
                                                        title={p.name}
                                                    >
                                                        {p.code && (
                                                            <span className="shrink-0 rounded border bg-background px-1 py-px font-mono text-[9px] uppercase text-muted-foreground">
                                                                {p.code}
                                                            </span>
                                                        )}
                                                        <span className="min-w-0 flex-1 truncate font-medium text-foreground group-hover:text-primary group-hover:underline">
                                                            {p.name}
                                                        </span>
                                                        {p.isOwner && (
                                                            <Badge
                                                                variant="secondary"
                                                                className="h-4 shrink-0 px-1 text-[9px]"
                                                            >
                                                                Owner
                                                            </Badge>
                                                        )}
                                                    </Link>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </CardContent>
                            </Card>

                            {/* Personal highlights — only on own profile */}
                            {isSelf && pinCounts && (
                                <Card>
                                    <CardHeader className="pb-2">
                                        <CardTitle className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                                            <Star className="h-3.5 w-3.5" />
                                            Personal highlights
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <ul className="space-y-1.5 text-xs">
                                            <HighlightRow
                                                icon={Pin}
                                                tone="text-emerald-600"
                                                label="Pinned projects"
                                                count={pinCounts.PROJECT || 0}
                                            />
                                            <HighlightRow
                                                icon={Highlighter}
                                                tone="text-fuchsia-600"
                                                label="Today's focus tasks"
                                                count={
                                                    pinCounts.TASK_FOCUS || 0
                                                }
                                            />
                                            <HighlightRow
                                                icon={Star}
                                                tone="text-amber-500"
                                                label="Starred sprint goals"
                                                count={
                                                    pinCounts.SPRINT_GOAL || 0
                                                }
                                            />
                                            <HighlightRow
                                                icon={Star}
                                                tone="text-amber-500"
                                                label="Prod-target releases"
                                                count={
                                                    pinCounts.RELEASE_PROD || 0
                                                }
                                            />
                                            <HighlightRow
                                                icon={Pin}
                                                tone="text-emerald-600"
                                                label="Bookmarked activities"
                                                count={
                                                    pinCounts.ACTIVITY || 0
                                                }
                                            />
                                        </ul>
                                    </CardContent>
                                </Card>
                            )}
                        </aside>
                    </div>
                </div>
            </main>
        </>
    );
}

// One KPI tile for the work-stats grid.
function KpiTile({ icon: Icon, label, value, sublabel, tone }) {
    return (
        <div className="rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {Icon && <Icon className={cn('h-3 w-3', tone)} />}
                <span className="truncate">{label}</span>
            </div>
            <p
                className={cn(
                    'mt-1 text-lg font-semibold leading-tight tabular-nums',
                    tone || 'text-foreground',
                )}
            >
                {value}
            </p>
            {sublabel && (
                <p className="text-[10px] leading-tight text-muted-foreground">
                    {sublabel}
                </p>
            )}
        </div>
    );
}

// Single avatar + name + email chip. Optional leading icon (e.g.
// Crown for the team leader).
function UserChip({ user, icon: Icon }) {
    return (
        <Link
            to={`/users/${user.id}`}
            className="group flex items-center gap-2 rounded-md p-1 transition-colors hover:bg-accent"
        >
            <Avatar className="h-7 w-7">
                {user.avatarUrl && (
                    <AvatarImage
                        src={resolveAssetUrl(user.avatarUrl)}
                        alt={user.name}
                    />
                )}
                <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                    {initials(user.name || '?')}
                </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium leading-tight group-hover:text-primary">
                    {Icon && (
                        <Icon className="-mt-0.5 mr-1 inline h-3 w-3 text-amber-500" />
                    )}
                    {user.name}
                </p>
                <p className="truncate text-[10px] text-muted-foreground">
                    {user.position || user.email}
                </p>
            </div>
        </Link>
    );
}

function HighlightRow({ icon: Icon, label, count, tone }) {
    return (
        <li className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
                <Icon className={cn('h-3.5 w-3.5', tone)} />
                <span>{label}</span>
            </span>
            <span className="font-mono tabular-nums text-muted-foreground">
                {count}
            </span>
        </li>
    );
}

// Available heatmap windows. Kept in one place so the period
// picker, the card subtitle and the API call stay in sync.
const HEATMAP_PERIODS = [
    { days: 28, label: '4w' },
    { days: 84, label: '12w' },
    { days: 182, label: '26w' },
    { days: 365, label: '52w' },
];

// Absolute hour buckets. Using fixed thresholds (instead of a relative
// scale) means colours are directly comparable across users and across
// period changes — "dark emerald" always means "6-8 hours" regardless
// of what window you're looking at.
const HEATMAP_BUCKETS = [
    {
        label: '0',
        tooltip: 'No time logged',
        className: 'bg-muted',
        max: 0,
    },
    {
        label: '< 2h',
        tooltip: 'Less than 2h',
        className: 'bg-emerald-200 dark:bg-emerald-900/50',
        max: 2,
    },
    {
        label: '2–4h',
        tooltip: '2 to 4 hours',
        className: 'bg-emerald-300 dark:bg-emerald-800/70',
        max: 4,
    },
    {
        label: '4–6h',
        tooltip: '4 to 6 hours',
        className: 'bg-emerald-400 dark:bg-emerald-700/80',
        max: 6,
    },
    {
        label: '6–8h',
        tooltip: '6 to 8 hours (full workday)',
        className: 'bg-emerald-600 dark:bg-emerald-500',
        max: 8,
    },
    {
        label: '> 8h',
        tooltip: 'Over 8 hours — overwork',
        className: 'bg-amber-500 dark:bg-amber-400',
        max: Infinity,
    },
];

function bucketFor(hours) {
    if (!hours || hours <= 0) return HEATMAP_BUCKETS[0];
    return (
        HEATMAP_BUCKETS.find((b) => hours <= b.max) ||
        HEATMAP_BUCKETS[HEATMAP_BUCKETS.length - 1]
    );
}

// Small segmented control for the heatmap window. Highlights the
// active option, disabled while a refetch is in flight so the user
// can't double-fire.
function PeriodPicker({ value, onChange, disabled }) {
    return (
        <div
            className="inline-flex rounded-md border bg-muted/40 p-0.5"
            role="group"
            aria-label="Heatmap period"
        >
            {HEATMAP_PERIODS.map((p) => {
                const active = p.days === value;
                return (
                    <button
                        key={p.days}
                        type="button"
                        disabled={disabled}
                        onClick={() => onChange(p.days)}
                        className={cn(
                            'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
                            active
                                ? 'bg-background text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground',
                            disabled && 'cursor-not-allowed opacity-60',
                        )}
                    >
                        {p.label}
                    </button>
                );
            })}
        </div>
    );
}

// GitHub-style time-tracking heatmap. Rows are calendar weekdays
// (Mon → Sun), columns are weeks (oldest → newest). The first column
// may have leading blank cells when the window's first day isn't a
// Monday — that keeps every cell in the row it actually belongs to so
// the user can read the grid as a real calendar.
function TimeHeatmap({ data }) {
    const days = data?.days || [];

    // Aggregate stats for the legend header so the user can see at a
    // glance "this period totalled X hours over Y active days".
    const summary = useMemo(() => {
        let active = 0;
        let total = 0;
        let max = 0;
        for (const d of days) {
            if (d.hours > 0) {
                active += 1;
                total += d.hours;
                if (d.hours > max) max = d.hours;
            }
        }
        return { active, total, max };
    }, [days]);

    if (days.length === 0) {
        return (
            <p className="rounded border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                No time logged in this period.
            </p>
        );
    }

    // Build the week-column grid. dayOfWeekMon is 0=Mon … 6=Sun so
    // the visual matches how people read a planner.
    const dayOfWeekMon = (jsDay) => (jsDay + 6) % 7;
    const firstDate = new Date(days[0].date);
    const lead = dayOfWeekMon(firstDate.getDay());
    const totalSlots = lead + days.length;
    const colCount = Math.ceil(totalSlots / 7);
    const cols = Array.from({ length: colCount }, () =>
        new Array(7).fill(null),
    );
    days.forEach((d, idx) => {
        const slot = lead + idx;
        const col = Math.floor(slot / 7);
        const row = slot % 7;
        cols[col][row] = d;
    });

    // Month labels: print a label above the first column where each
    // month starts so the user can orient at a glance.
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthLabels = cols.map((rows, ci) => {
        const firstReal = rows.find(Boolean);
        if (!firstReal) return '';
        const d = new Date(firstReal.date);
        // Only label when this week introduces a new month.
        const prevCol = cols[ci - 1];
        const prevReal = prevCol ? prevCol.find(Boolean) : null;
        const prevMonth = prevReal ? new Date(prevReal.date).getMonth() : -1;
        return d.getMonth() !== prevMonth ? MONTHS[d.getMonth()] : '';
    });

    // Weekday gutter: full row labels are too tight when cells are 12px,
    // so we show Mon / Wed / Fri only (rows 0, 2, 4 in Mon-indexed grid).
    const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

    return (
        <div className="space-y-2">
            {/* Top stats line ------------------------------------- */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                <span>
                    <strong className="font-semibold text-foreground tabular-nums">
                        {formatHoursAsHM(summary.total)}
                    </strong>{' '}
                    logged over{' '}
                    <strong className="font-semibold text-foreground tabular-nums">
                        {summary.active}
                    </strong>{' '}
                    active day{summary.active === 1 ? '' : 's'}
                </span>
                <span>
                    Busiest day:{' '}
                    <strong className="font-semibold text-foreground tabular-nums">
                        {summary.max > 0 ? formatHoursAsHM(summary.max) : '—'}
                    </strong>
                </span>
            </div>

            {/* Grid + month labels --------------------------------- */}
            <div className="overflow-x-auto pb-1">
                <div className="inline-flex flex-col gap-1 align-top">
                    {/* Month strip */}
                    <div className="flex pl-7 text-[10px] leading-none text-muted-foreground">
                        {monthLabels.map((m, ci) => (
                            <span
                                key={ci}
                                className="w-[15px] text-left tabular-nums"
                            >
                                {m}
                            </span>
                        ))}
                    </div>
                    {/* Grid */}
                    <div className="flex">
                        {/* Weekday gutter */}
                        <div className="mr-1 flex w-6 flex-col gap-[3px] text-[10px] leading-[12px] text-muted-foreground">
                            {WEEKDAY_LABELS.map((w, i) => (
                                <span
                                    key={i}
                                    className="h-3 text-right pr-1"
                                >
                                    {w}
                                </span>
                            ))}
                        </div>
                        {/* Day cells */}
                        <div className="flex gap-[3px]">
                            {cols.map((rows, ci) => (
                                <div
                                    key={ci}
                                    className="flex flex-col gap-[3px]"
                                >
                                    {rows.map((d, ri) => {
                                        if (!d) {
                                            return (
                                                <span
                                                    key={`empty-${ci}-${ri}`}
                                                    className="block h-3 w-3 rounded-sm bg-muted/40"
                                                />
                                            );
                                        }
                                        const b = bucketFor(d.hours);
                                        return (
                                            <span
                                                key={d.date}
                                                title={`${d.date} · ${formatHoursAsHM(d.hours)} (${b.tooltip})`}
                                                className={cn(
                                                    'block h-3 w-3 rounded-sm transition-colors hover:ring-1 hover:ring-foreground/60',
                                                    b.className,
                                                )}
                                            />
                                        );
                                    })}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Legend — absolute hour buckets ---------------------- */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                <span className="font-medium uppercase tracking-wide">
                    Hours per day
                </span>
                {HEATMAP_BUCKETS.map((b) => (
                    <span
                        key={b.label}
                        className="inline-flex items-center gap-1"
                        title={b.tooltip}
                    >
                        <span
                            className={cn(
                                'block h-2.5 w-2.5 rounded-sm',
                                b.className,
                            )}
                        />
                        {b.label}
                    </span>
                ))}
                <span className="text-muted-foreground/70">
                    · amber = overwork
                </span>
            </div>
        </div>
    );
}
