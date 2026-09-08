// Statistics view for the requester portal — mirrors the Insights ticket
// dashboards (My tickets + workspace), but the three "My tickets" cards
// are clickable to filter the Requests list. Uses /api/tickets/stats,
// which now serves requesters (mine = reported by me; workspace = all).
import { useEffect, useState } from 'react';
import { Inbox, CheckCircle2, Timer, Ticket } from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const STATUS_META = {
    NEW: { label: 'New', bar: 'bg-sky-500' },
    OPEN: { label: 'Open', bar: 'bg-blue-500' },
    IN_PROGRESS: { label: 'In progress', bar: 'bg-indigo-500' },
    PENDING: { label: 'Pending', bar: 'bg-amber-500' },
    RESOLVED: { label: 'Resolved', bar: 'bg-emerald-500' },
    CLOSED: { label: 'Closed', bar: 'bg-slate-400' },
};
const CATEGORY_META = {
    INCIDENT: { label: 'Incident', bar: 'bg-rose-500' },
    REQUEST: { label: 'Request', bar: 'bg-sky-500' },
    QUESTION: { label: 'Question', bar: 'bg-violet-500' },
    PROBLEM: { label: 'Problem', bar: 'bg-amber-500' },
};

function fmtDuration(s) {
    if (s == null) return '—';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${Math.round(s || 0)}s`;
}

function StatCard({ label, value, sub, icon: Icon, tone, onClick }) {
    const tones = {
        default: 'border bg-card',
        sky: 'border-sky-200 bg-sky-50/60 dark:border-sky-500/30 dark:bg-sky-500/10',
        emerald:
            'border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/10',
        amber: 'border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10',
    };
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={!onClick}
            className={cn(
                'rounded-lg p-4 text-left shadow-sm transition-all',
                tones[tone] || tones.default,
                onClick && 'hover:-translate-y-px hover:shadow-md',
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
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Icon className="h-4 w-4" />
                    </span>
                )}
            </div>
        </button>
    );
}

function Bars({ obj, meta, total }) {
    const rows = Object.keys(meta)
        .filter((k) => obj?.[k])
        .map((k) => ({ key: k, label: meta[k].label, bar: meta[k].bar, count: obj[k] }));
    const max = Math.max(total || 0, ...rows.map((r) => r.count), 1);
    if (rows.length === 0)
        return <p className="text-sm text-muted-foreground">No data yet.</p>;
    return (
        <div className="space-y-3">
            {rows.map((r) => (
                <div key={r.key}>
                    <div className="mb-1.5 flex items-center justify-between text-xs">
                        <span className="font-medium">{r.label}</span>
                        <span className="tabular-nums text-muted-foreground">
                            {r.count}
                        </span>
                    </div>
                    <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
                        <div
                            className={cn('h-full rounded-full', r.bar)}
                            style={{
                                width: `${Math.max((r.count / max) * 100, 4)}%`,
                            }}
                        />
                    </div>
                </div>
            ))}
        </div>
    );
}

export function PortalStats({ onPick }) {
    const [stats, setStats] = useState(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let cancelled = false;
        api.get('/tickets/stats')
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
    }, []);

    if (!stats?.mine) {
        return (
            <div className="mt-3 rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground shadow-sm">
                {loaded ? 'No statistics yet.' : 'Loading statistics…'}
            </div>
        );
    }
    const { mine, workspace: ws } = stats;

    return (
        <div className="mt-3 space-y-6">
            {/* My tickets — clickable cards filter the list to your own. */}
            <section>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    <Ticket className="h-4 w-4" />
                    My tickets
                </h3>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                    <StatCard
                        label="Open"
                        value={mine.open}
                        sub="click to filter"
                        icon={Inbox}
                        tone={mine.open > 0 ? 'sky' : 'default'}
                        onClick={() =>
                            onPick?.({ scope: 'mine', status: 'OPEN_ONLY' })
                        }
                    />
                    <StatCard
                        label="Resolved"
                        value={mine.resolved}
                        sub={`${mine.resolvedLast30} in last 30d · click to filter`}
                        icon={CheckCircle2}
                        tone="emerald"
                        onClick={() =>
                            onPick?.({ scope: 'mine', status: 'RESOLVED' })
                        }
                    />
                    <StatCard
                        label="Avg resolution"
                        value={fmtDuration(mine.avgResolutionSeconds)}
                        sub="open → closed"
                        icon={Timer}
                        tone="default"
                    />
                </div>
            </section>

            {/* All tickets — workspace-wide, view only (no filtering). */}
            {ws && (
                <section>
                    <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        <Ticket className="h-4 w-4" />
                        All tickets
                    </h3>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                        <StatCard label="Total" value={ws.total} sub="all time" icon={Ticket} tone="default" />
                        <StatCard label="Open" value={ws.open} sub="not yet resolved" icon={Inbox} tone={ws.open > 0 ? 'sky' : 'default'} />
                        <StatCard label="Resolved" value={ws.resolved} sub="resolved or closed" icon={CheckCircle2} tone="emerald" />
                        <StatCard label="Unassigned" value={ws.unassigned} sub="waiting to be taken" icon={Ticket} tone={ws.unassigned > 0 ? 'amber' : 'default'} />
                    </div>
                    <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
                        <div className="rounded-lg border bg-card p-4 shadow-sm">
                            <h4 className="mb-3 text-sm font-semibold">
                                By status
                            </h4>
                            <Bars
                                obj={ws.byStatus}
                                meta={STATUS_META}
                                total={ws.total}
                            />
                        </div>
                        <div className="rounded-lg border bg-card p-4 shadow-sm">
                            <h4 className="mb-3 text-sm font-semibold">
                                By category
                            </h4>
                            <Bars
                                obj={ws.byCategory}
                                meta={CATEGORY_META}
                                total={ws.total}
                            />
                        </div>
                    </div>
                </section>
            )}
        </div>
    );
}

export default PortalStats;
