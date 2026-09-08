import { useEffect, useMemo, useState } from 'react';
import {
    BarChart3,
    CalendarDays,
    Clock,
    FolderKanban,
    Loader2,
    Timer,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

// Personal time-tracking mini-dashboard shown inside the Profile dialog.
// It is entirely about the SIGNED-IN user: /api/time/stats scopes to the
// caller automatically when no `userId` param is passed (non-admins are
// always self-scoped; admins viewing their own profile pass no userId so
// they see their own numbers too). Self-contained, lightweight Tailwind
// bars — no charting library, matching the rest of the app.

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function fmtH(seconds) {
    const h = (seconds || 0) / 3600;
    if (h === 0) return '0h';
    if (h < 1) return `${Math.round(h * 60)}m`;
    return `${Math.round(h * 10) / 10}h`;
}

// Parse a "YYYY-MM-DD" key as a LOCAL date so weekday bucketing doesn't
// drift across timezones.
function localDate(key) {
    const [y, m, d] = String(key).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}

export default function ProfileStatsPanel() {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const to = new Date();
        const from = new Date(to.getTime() - 29 * DAY);
        from.setHours(0, 0, 0, 0);
        to.setHours(23, 59, 59, 999);
        setLoading(true);
        setError(false);
        api.get('/time/stats', {
            params: { from: from.toISOString(), to: to.toISOString() },
        })
            .then((res) => {
                if (!cancelled) setStats(res.data);
            })
            .catch(() => {
                if (!cancelled) setError(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const byDay = stats?.byDay || [];
    const total = stats?.total || 0;
    const trackedDays = byDay.filter((d) => d.seconds > 0).length;
    const avgActive = trackedDays ? Math.round(total / trackedDays) : 0;
    const maxDay = Math.max(1, ...byDay.map((d) => d.seconds || 0));

    // Busiest weekdays (Mon→Sun) computed from the daily buckets.
    const byWeekday = useMemo(() => {
        const buckets = new Array(7).fill(0);
        for (const d of byDay) {
            // getDay(): 0=Sun..6=Sat → shift so Mon=0..Sun=6.
            const wd = (localDate(d.date).getDay() + 6) % 7;
            buckets[wd] += d.seconds || 0;
        }
        return buckets.map((seconds, i) => ({
            label: WEEKDAY_LABELS[i],
            seconds,
        }));
    }, [byDay]);

    const topProjects = (stats?.byProject || []).slice(0, 6);
    const byType = (stats?.byType || []).slice(0, 6);

    if (loading) {
        return (
            <div className="flex items-center justify-center gap-2 rounded-lg border bg-muted/20 p-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading your stats…
            </div>
        );
    }
    if (error) {
        return (
            <div className="rounded-lg border bg-muted/20 p-4 text-center text-sm text-muted-foreground">
                Couldn't load your time stats right now.
            </div>
        );
    }
    if (total === 0) {
        return (
            <div className="rounded-lg border bg-muted/20 p-4 text-center text-sm text-muted-foreground">
                No time logged in the last 30 days — once you start logging
                time, your personal charts will appear here.
            </div>
        );
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-primary" />
                <h4 className="text-sm font-semibold">Your last 30 days</h4>
            </div>

            {/* KPI row */}
            <div className="grid grid-cols-3 gap-2">
                <Kpi icon={Clock} label="Total" value={fmtH(total)} primary />
                <Kpi
                    icon={CalendarDays}
                    label="Active days"
                    value={String(trackedDays)}
                />
                <Kpi
                    icon={Timer}
                    label="Avg / active day"
                    value={fmtH(avgActive)}
                />
            </div>

            {/* Daily activity sparkline-ish bars */}
            <Panel title="Daily activity">
                <div className="flex h-20 items-end gap-[3px]">
                    {byDay.map((d) => (
                        <div
                            key={d.date}
                            className="group relative flex-1"
                            title={`${d.date}: ${fmtH(d.seconds)}`}
                        >
                            <div
                                className={cn(
                                    'w-full rounded-sm transition-colors',
                                    d.seconds > 0
                                        ? 'bg-primary/70 group-hover:bg-primary'
                                        : 'bg-muted',
                                )}
                                style={{
                                    height: `${Math.max(
                                        d.seconds > 0 ? 6 : 2,
                                        Math.round(
                                            (d.seconds / maxDay) * 72,
                                        ),
                                    )}px`,
                                }}
                            />
                        </div>
                    ))}
                </div>
            </Panel>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Panel title="Top projects" icon={FolderKanban}>
                    <Bars
                        rows={topProjects.map((p) => ({
                            key: p.projectId,
                            label: p.name,
                            badge: p.code,
                            seconds: p.seconds,
                        }))}
                        accent="bg-primary"
                    />
                </Panel>
                <Panel title="Busiest weekdays">
                    <Bars
                        rows={byWeekday.map((w) => ({
                            key: w.label,
                            label: w.label,
                            seconds: w.seconds,
                        }))}
                        accent="bg-sky-500"
                    />
                </Panel>
            </div>

            {byType.length > 0 && (
                <Panel title="By project type">
                    <Bars
                        rows={byType.map((t) => ({
                            key: t.projectTypeId || t.name,
                            label: t.name,
                            seconds: t.seconds,
                        }))}
                        accent="bg-emerald-500"
                    />
                </Panel>
            )}
        </div>
    );
}

function Kpi({ icon: Icon, label, value, primary }) {
    return (
        <div
            className={cn(
                'rounded-lg border p-2.5',
                primary ? 'bg-primary/5' : 'bg-muted/20',
            )}
        >
            <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <Icon className="h-3 w-3" />
                {label}
            </div>
            <div className="mt-0.5 text-lg font-semibold tabular-nums">
                {value}
            </div>
        </div>
    );
}

function Panel({ title, icon: Icon, children }) {
    return (
        <div className="rounded-lg border bg-card p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                {Icon && <Icon className="h-3.5 w-3.5" />}
                {title}
            </div>
            {children}
        </div>
    );
}

// Lightweight horizontal bars. Each row scales to the largest value in
// the set so the longest bar fills the track.
function Bars({ rows = [], accent = 'bg-primary' }) {
    const max = Math.max(1, ...rows.map((r) => r.seconds || 0));
    if (rows.every((r) => (r.seconds || 0) === 0)) {
        return (
            <p className="py-2 text-center text-xs text-muted-foreground">
                Nothing here yet.
            </p>
        );
    }
    return (
        <ul className="space-y-1.5">
            {rows.map((r) => (
                <li key={r.key} className="space-y-0.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="flex min-w-0 items-center gap-1.5">
                            {r.badge && (
                                <span className="shrink-0 font-mono text-[9px] uppercase text-muted-foreground">
                                    {r.badge}
                                </span>
                            )}
                            <span className="truncate">{r.label}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                            {fmtH(r.seconds)}
                        </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                            className={cn('h-full rounded-full', accent)}
                            style={{
                                width: `${Math.max(
                                    r.seconds > 0 ? 4 : 0,
                                    Math.round((r.seconds / max) * 100),
                                )}%`,
                            }}
                        />
                    </div>
                </li>
            ))}
        </ul>
    );
}
