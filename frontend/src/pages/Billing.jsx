import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
    AlertCircle,
    Banknote,
    Check,
    ChevronDown,
    DollarSign,
    Download,
    Filter as FilterIcon,
    Search,
    SlidersHorizontal,
    Wallet,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { downloadFromApi } from '@/lib/download';
import { cn } from '@/lib/utils';
import { useProjectStatuses } from '@/lib/statuses';
import { TopBar } from '@/components/TopBar';
import AdminTabs from '@/components/AdminTabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Project status labels/colors now come from the admin-managed list
// via useProjectStatuses(); the status filter + badge below read from
// that hook so custom statuses show and can be filtered. The local map
// is kept only as a last-resort label lookup for the CSV/fallback path.
const STATUS_LABELS = {
    TODO: 'To do',
    IN_PROGRESS: 'In progress',
    DONE: 'Done',
    ON_HOLD: 'On hold',
};

// eslint-disable-next-line no-unused-vars
const STATUS_OPTIONS = Object.entries(STATUS_LABELS).map(([value, label]) => ({
    value,
    label,
}));

// "Payment" filter values. The id is `<state>:<scope>` so the row
// stays a single dropdown selection while we hand the right query
// param to the backend (`paid=` or `unpaid=`). `all` is the default.
const PAYMENT_OPTIONS = [
    { id: 'all', label: 'All projects' },
    { id: 'unpaid:internal', label: 'Internal unpaid' },
    { id: 'unpaid:client', label: 'Client unpaid' },
    { id: 'unpaid:any', label: 'Either unpaid' },
    { id: 'paid:internal', label: 'Internal paid' },
    { id: 'paid:client', label: 'Client paid' },
    { id: 'paid:both', label: 'Fully paid' },
];

// Single source of truth for the table columns. `required: true` means
// the column can't be hidden (the project name needs to stay so rows
// remain identifiable). `default: true` controls whether the column
// shows on first paint; users can toggle anything else on/off.
const ALL_COLUMNS = [
    { id: 'project', label: 'Project', required: true, align: 'left' },
    { id: 'client', label: 'Client', default: true, align: 'left' },
    { id: 'country', label: 'Country', align: 'left' },
    { id: 'owner', label: 'Owner', align: 'left' },
    { id: 'crmId', label: 'CRM ID', align: 'left' },
    { id: 'status', label: 'Status', default: true, align: 'left' },
    { id: 'internalAmount', label: 'Internal', default: true, align: 'right' },
    { id: 'internalPaid', label: 'Internal paid', default: true, align: 'center' },
    { id: 'internalPaidAt', label: 'Internal paid at', align: 'left' },
    { id: 'clientAmount', label: 'Client', default: true, align: 'right' },
    { id: 'clientPaid', label: 'Client paid', default: true, align: 'center' },
    { id: 'clientPaidAt', label: 'Client paid at', align: 'left' },
    { id: 'billingNotes', label: 'Notes', align: 'left' },
];

const STORAGE_COLUMNS = 'pm.billing.columns.v1';
// Bumped from .v1 — the payment filter renamed `unpaid` -> `payment`,
// and `countries` was added. Forcing a reset on load avoids users
// being stuck with an inactive filter from the previous schema.
const STORAGE_FILTERS = 'pm.billing.filters.v2';

function defaultColumnState() {
    return Object.fromEntries(
        ALL_COLUMNS.map((c) => [c.id, c.required || c.default || false]),
    );
}

const DEFAULT_FILTERS = {
    statuses: [],
    currencies: [],
    countries: [],
    payment: 'all',
    search: '',
};

function loadJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch {
        return fallback;
    }
}

function fmtMoney(amount, currency) {
    if (amount == null) return '—';
    const n = typeof amount === 'number' ? amount : Number(amount);
    if (!Number.isFinite(n)) return '—';
    return `${n.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })} ${currency || 'EUR'}`;
}

// Per-currency totals come back as `{EUR: 1234.5, USD: 999}`. Render
// each currency on its own line so two currencies don't collide.
function CurrencyTotals({ totals, tone }) {
    const entries = Object.entries(totals || {}).filter(
        ([, v]) => v && Number(v) > 0,
    );
    if (!entries.length) {
        return <p className="text-xs text-muted-foreground">—</p>;
    }
    return (
        <div className="flex flex-col gap-0.5 text-sm font-semibold">
            {entries.map(([c, v]) => (
                <span
                    key={c}
                    className={cn(
                        'tabular-nums',
                        tone === 'good' && 'text-emerald-700 dark:text-emerald-400',
                        tone === 'bad' && 'text-rose-700 dark:text-rose-400',
                    )}
                >
                    {Number(v).toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                    })}{' '}
                    <span className="text-[10px] font-normal text-muted-foreground">
                        {c}
                    </span>
                </span>
            ))}
        </div>
    );
}

function StatCard({ icon: Icon, label, totals, tone, sub }) {
    return (
        <div className="rounded-lg border bg-card p-3 shadow-sm">
            <div className="flex items-start justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                </span>
            </div>
            <div className="mt-1.5">
                <CurrencyTotals totals={totals} tone={tone} />
                {sub && (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                        {sub}
                    </p>
                )}
            </div>
        </div>
    );
}

export default function Billing() {
    // Admin-managed project statuses drive both the status filter options
    // and each row's status badge (label + color), so custom statuses
    // render and are filterable instead of the hardcoded 4-value map.
    const { list: statusList, find: findProjectStatus } = useProjectStatuses();
    const [projects, setProjects] = useState([]);
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState(null);
    const [exporting, setExporting] = useState(false);

    // Persisted column visibility + filter state.
    const [columns, setColumns] = useState(() =>
        loadJson(STORAGE_COLUMNS, defaultColumnState()),
    );
    const [filters, setFilters] = useState(() =>
        loadJson(STORAGE_FILTERS, DEFAULT_FILTERS),
    );

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_COLUMNS, JSON.stringify(columns));
        } catch {
            /* ignore quota errors */
        }
    }, [columns]);
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_FILTERS, JSON.stringify(filters));
        } catch {
            /* ignore quota errors */
        }
    }, [filters]);

    const updateFilter = (patch) => setFilters((f) => ({ ...f, ...patch }));

    // Translate the single "payment" select into the right query param
    // (`paid=…` vs `unpaid=…`). Keeping the FE state collapsed into one
    // dropdown is friendlier than two separate "paid" + "unpaid" selects.
    const buildPaymentParams = () => {
        if (!filters.payment || filters.payment === 'all') return {};
        const [state, scope] = filters.payment.split(':');
        if (state === 'paid') return { paid: scope };
        if (state === 'unpaid') return { unpaid: scope };
        return {};
    };

    const buildQueryParams = () => {
        const params = {};
        if (filters.search.trim()) params.search = filters.search.trim();
        if (filters.statuses.length)
            params.status = filters.statuses.join(',');
        if (filters.countries.length)
            params.country = filters.countries.join(',');
        Object.assign(params, buildPaymentParams());
        return params;
    };

    const load = async () => {
        setLoading(true);
        try {
            const { data } = await api.get('/billing', {
                params: buildQueryParams(),
            });
            setProjects(data.projects || []);
            setSummary(data.summary || null);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not load billing');
        } finally {
            setLoading(false);
        }
    };

    // Debounce so we don't hammer the API while the user types.
    useEffect(() => {
        const t = setTimeout(load, 250);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        filters.search,
        filters.payment,
        filters.statuses,
        filters.countries,
    ]);

    // Currency filter is applied client-side because it's just a
    // visibility filter on already-loaded rows. The dropdown is
    // populated from the currencies actually present in the data
    // (instead of a hardcoded list) so users only see options that
    // exist for them.
    const availableCurrencies = useMemo(() => {
        const set = new Set();
        for (const p of projects) {
            if (p.internalAmount != null && p.internalCurrency) {
                set.add(p.internalCurrency);
            }
            if (p.clientAmount != null && p.clientCurrency) {
                set.add(p.clientCurrency);
            }
        }
        return Array.from(set).sort();
    }, [projects]);

    // We populate the country filter from the loaded data so the
    // dropdown only ever lists values that actually appear in the
    // current result set.
    const availableCountries = useMemo(() => {
        const set = new Set();
        for (const p of projects) {
            if (p.country) set.add(p.country);
        }
        return Array.from(set).sort();
    }, [projects]);

    const visibleProjects = useMemo(() => {
        if (!filters.currencies.length) return projects;
        const set = new Set(filters.currencies);
        return projects.filter(
            (p) =>
                (p.internalAmount != null && set.has(p.internalCurrency)) ||
                (p.clientAmount != null && set.has(p.clientCurrency)),
        );
    }, [projects, filters.currencies]);

    const togglePaid = async (project, whichOrCR, maybeWhich) => {
        // Two call shapes:
        //   togglePaid(project, 'internal' | 'client')         -> project-level
        //   togglePaid(project, cr, 'internal' | 'client')     -> CR-level
        // (Detected by whether the 2nd arg is a string or an object.)
        const isCR =
            whichOrCR && typeof whichOrCR === 'object' && whichOrCR.id;
        const which = isCR ? maybeWhich : whichOrCR;
        const isInternal = which === 'internal';

        if (isCR) {
            const cr = whichOrCR;
            const currentlyPaid = isInternal ? cr.internalPaid : cr.clientPaid;
            setBusyId(`cr:${cr.id}:${which}`);
            try {
                const { data } = await api.patch(`/change-requests/${cr.id}`, {
                    [isInternal ? 'internalPaid' : 'clientPaid']:
                        !currentlyPaid,
                });
                // Splice the updated CR into the parent project's
                // `changeRequests` array in local state so the row
                // re-renders without a full refetch.
                setProjects((prev) =>
                    prev.map((p) => {
                        if (p.id !== project.id) return p;
                        return {
                            ...p,
                            changeRequests: (p.changeRequests || []).map((c) =>
                                c.id === cr.id
                                    ? {
                                        ...c,
                                        internalPaid:
                                            data.changeRequest.internalPaid,
                                        internalPaidAt:
                                            data.changeRequest.internalPaidAt,
                                        clientPaid:
                                            data.changeRequest.clientPaid,
                                        clientPaidAt:
                                            data.changeRequest.clientPaidAt,
                                    }
                                    : c,
                            ),
                        };
                    }),
                );
                const refresh = await api.get('/billing', {
                    params: buildQueryParams(),
                });
                setSummary(refresh.data.summary || null);
            } catch (err) {
                toast.error(
                    err.response?.data?.error ||
                        'Could not update change request',
                );
            } finally {
                setBusyId(null);
            }
            return;
        }

        const currentlyPaid = isInternal
            ? project.internalPaid
            : project.clientPaid;
        setBusyId(`${project.id}:${which}`);
        try {
            const { data } = await api.post(
                `/billing/${project.id}/${which}/pay`,
                { paid: !currentlyPaid },
            );
            setProjects((prev) =>
                prev.map((p) =>
                    p.id === project.id
                        ? // Preserve the CR list — /billing/:id/:which/pay
                          // returns the bare project, so splice it on top
                          // of the existing row to keep nested data.
                          { ...p, ...data.project, changeRequests: p.changeRequests }
                        : p,
                ),
            );
            const refresh = await api.get('/billing', {
                params: buildQueryParams(),
            });
            setSummary(refresh.data.summary || null);
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not update billing',
            );
        } finally {
            setBusyId(null);
        }
    };

    const handleExport = async () => {
        setExporting(true);
        try {
            const params = { prices: 1, ...buildQueryParams() };
            await downloadFromApi('/exports/projects/xlsx', {
                params,
                filenameFallback: `billing-${new Date()
                    .toISOString()
                    .slice(0, 10)}.xlsx`,
            });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not export');
        } finally {
            setExporting(false);
        }
    };

    const headerActions = (
        <Button
            variant="outline"
            className="gap-2"
            onClick={handleExport}
            disabled={exporting}
        >
            <Download className="h-4 w-4" />
            {exporting ? 'Exporting…' : 'Export billing'}
        </Button>
    );

    const stats = useMemo(() => {
        if (!summary) return null;
        return [
            {
                key: 'internal',
                label: 'Internal — paid',
                icon: Wallet,
                totals: summary.internalPaid,
                tone: 'good',
            },
            {
                key: 'internal-unpaid',
                label: 'Internal — unpaid',
                icon: AlertCircle,
                totals: summary.internalUnpaid,
                tone: 'bad',
                sub: `${summary.internalUnpaidCount} project${
                    summary.internalUnpaidCount === 1 ? '' : 's'
                }`,
            },
            {
                key: 'client',
                label: 'Client — paid',
                icon: DollarSign,
                totals: summary.clientPaid,
                tone: 'good',
            },
            {
                key: 'client-unpaid',
                label: 'Client — unpaid',
                icon: AlertCircle,
                totals: summary.clientUnpaid,
                tone: 'bad',
                sub: `${summary.clientUnpaidCount} project${
                    summary.clientUnpaidCount === 1 ? '' : 's'
                }`,
            },
        ];
    }, [summary]);

    const visibleColumns = ALL_COLUMNS.filter((c) => columns[c.id]);
    const activeFilterCount =
        filters.statuses.length +
        filters.currencies.length +
        filters.countries.length +
        (filters.payment !== 'all' ? 1 : 0) +
        (filters.search.trim() ? 1 : 0);
    const resetFilters = () => setFilters(DEFAULT_FILTERS);
    const resetColumns = () => setColumns(defaultColumnState());

    return (
        <>
            <TopBar title="Billing" actions={headerActions} />
            <AdminTabs />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="flex w-full flex-col gap-4">
                    {stats && (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            {stats.map((s) => (
                                <StatCard key={s.key} {...s} />
                            ))}
                        </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 shadow-sm">
                        <div className="relative flex-1 min-w-[220px] max-w-sm">
                            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={filters.search}
                                onChange={(e) =>
                                    updateFilter({ search: e.target.value })
                                }
                                placeholder="Search project, client or CRM ID…"
                                className="h-9 pl-8 text-sm"
                            />
                        </div>

                        <FilterIcon className="ml-1 h-4 w-4 text-muted-foreground" />

                        <MultiFilter
                            label="Status"
                            values={filters.statuses}
                            onChange={(v) => updateFilter({ statuses: v })}
                            options={statusList.map((s) => ({
                                value: s.value,
                                label: s.label,
                            }))}
                        />

                        <MultiFilter
                            label="Country"
                            values={filters.countries}
                            onChange={(v) => updateFilter({ countries: v })}
                            options={availableCountries.map((c) => ({
                                value: c,
                                label: c,
                            }))}
                        />

                        <MultiFilter
                            label="Currency"
                            values={filters.currencies}
                            onChange={(v) => updateFilter({ currencies: v })}
                            options={availableCurrencies.map((c) => ({
                                value: c,
                                label: c,
                            }))}
                        />

                        <SingleFilter
                            label="Payment"
                            value={filters.payment}
                            onChange={(v) => updateFilter({ payment: v })}
                            options={PAYMENT_OPTIONS.map((o) => ({
                                value: o.id,
                                label: o.label,
                            }))}
                        />

                        {activeFilterCount > 0 && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-9 gap-1 text-xs"
                                onClick={resetFilters}
                            >
                                <X className="h-3.5 w-3.5" />
                                Clear ({activeFilterCount})
                            </Button>
                        )}

                        <div className="flex-1" />

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-9 gap-2"
                                >
                                    <SlidersHorizontal className="h-4 w-4" />
                                    Columns
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                                <DropdownMenuLabel>
                                    Visible columns
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {ALL_COLUMNS.map((col) => (
                                    <DropdownMenuCheckboxItem
                                        key={col.id}
                                        checked={Boolean(columns[col.id])}
                                        disabled={col.required}
                                        onCheckedChange={(v) =>
                                            setColumns((prev) => ({
                                                ...prev,
                                                [col.id]: Boolean(v),
                                            }))
                                        }
                                        onSelect={(e) => e.preventDefault()}
                                    >
                                        <span className="flex w-full items-center justify-between gap-2">
                                            <span>{col.label}</span>
                                            {col.required && (
                                                <span className="text-[9px] uppercase text-muted-foreground">
                                                    required
                                                </span>
                                            )}
                                        </span>
                                    </DropdownMenuCheckboxItem>
                                ))}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={resetColumns}>
                                    Reset to defaults
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <span className="text-xs text-muted-foreground">
                            {visibleProjects.length} of {projects.length}{' '}
                            project{projects.length === 1 ? '' : 's'}
                        </span>
                    </div>

                    <div className="overflow-auto rounded-lg border bg-card shadow-sm">
                        <table className="w-full text-sm">
                            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                                <tr>
                                    {visibleColumns.map((col) => (
                                        <th
                                            key={col.id}
                                            className={cn(
                                                'whitespace-nowrap px-3 py-2',
                                                col.align === 'right' &&
                                                    'text-right',
                                                col.align === 'center' &&
                                                    'text-center',
                                                col.align === 'left' &&
                                                    'text-left',
                                            )}
                                        >
                                            {col.label}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    <tr>
                                        <td
                                            colSpan={visibleColumns.length}
                                            className="px-3 py-12 text-center text-sm text-muted-foreground"
                                        >
                                            Loading billing…
                                        </td>
                                    </tr>
                                ) : visibleProjects.length === 0 ? (
                                    <tr>
                                        <td
                                            colSpan={visibleColumns.length}
                                            className="px-3 py-16 text-center text-sm text-muted-foreground"
                                        >
                                            <Banknote className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
                                            No projects match the filters.
                                        </td>
                                    </tr>
                                ) : (
                                    visibleProjects.map((p, i) => (
                                        <BillingRow
                                            key={p.id}
                                            project={p}
                                            zebra={i % 2 === 1}
                                            visibleColumns={visibleColumns}
                                            busyId={busyId}
                                            onTogglePaid={togglePaid}
                                            findProjectStatus={findProjectStatus}
                                        />
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </main>
        </>
    );
}

// Per-CR row rendered immediately below its parent project row.
// Shares the same column layout (so amounts stay aligned with the
// project's amount column) but only fills the cells that make sense
// for a CR (Project = indented CR label + amount/paid columns).
// All other cells render as a thin empty placeholder so the table
// keeps its visual rhythm.
function CRSubRow({
    cr,
    project: p,
    zebra,
    visibleColumns,
    busyId,
    onTogglePaid,
}) {
    const crCode =
        cr.code?.split('-CR-').slice(-1)[0]
            ? `CR-${cr.code.split('-CR-').slice(-1)[0]}`
            : cr.code || 'CR';
    const cellMap = {
        project: (
            <td className="px-3 py-1.5 pl-8">
                <Link
                    to={`/projects/${p.id}/cr/${cr.id}`}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                    title={cr.title}
                >
                    <span className="rounded bg-amber-500/15 px-1 py-px font-mono text-[10px] uppercase text-amber-700 dark:text-amber-300">
                        {crCode}
                    </span>
                    <span className="truncate hover:underline">
                        {cr.title}
                    </span>
                </Link>
            </td>
        ),
        // Reuse the project's contextual values where it makes sense
        // (client/country/owner/crmId/status all belong to the parent
        // project), but render them dimmed so the eye reads them as
        // "inherited from above".
        client: <td className="px-3 py-1.5 text-[11px] text-muted-foreground/60">↳</td>,
        country: <td className="px-3 py-1.5 text-[11px] text-muted-foreground/60" />,
        owner: <td className="px-3 py-1.5 text-[11px] text-muted-foreground/60" />,
        crmId: <td className="px-3 py-1.5 text-[11px] text-muted-foreground/60" />,
        status: <td className="px-3 py-1.5 text-[11px] text-muted-foreground/60" />,
        internalAmount: (
            <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs tabular-nums text-muted-foreground">
                {cr.internalAmount != null
                    ? fmtMoney(cr.internalAmount, p.internalCurrency)
                    : '—'}
            </td>
        ),
        internalPaid: (
            <td className="px-3 py-1.5 text-center">
                {cr.internalAmount == null ? (
                    <span className="text-[10px] text-muted-foreground/50">—</span>
                ) : (
                    <PaidToggle
                        paid={cr.internalPaid}
                        busy={busyId === `cr:${cr.id}:internal`}
                        onClick={() => onTogglePaid(p, cr, 'internal')}
                    />
                )}
            </td>
        ),
        internalPaidAt: (
            <td className="whitespace-nowrap px-3 py-1.5 text-[10px] text-muted-foreground">
                {cr.internalPaid && cr.internalPaidAt
                    ? format(new Date(cr.internalPaidAt), 'MMM d, yyyy')
                    : '—'}
            </td>
        ),
        clientAmount: (
            <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs tabular-nums text-muted-foreground">
                {cr.clientAmount != null
                    ? fmtMoney(cr.clientAmount, p.clientCurrency)
                    : '—'}
            </td>
        ),
        clientPaid: (
            <td className="px-3 py-1.5 text-center">
                {cr.clientAmount == null ? (
                    <span className="text-[10px] text-muted-foreground/50">—</span>
                ) : (
                    <PaidToggle
                        paid={cr.clientPaid}
                        busy={busyId === `cr:${cr.id}:client`}
                        onClick={() => onTogglePaid(p, cr, 'client')}
                    />
                )}
            </td>
        ),
        clientPaidAt: (
            <td className="whitespace-nowrap px-3 py-1.5 text-[10px] text-muted-foreground">
                {cr.clientPaid && cr.clientPaidAt
                    ? format(new Date(cr.clientPaidAt), 'MMM d, yyyy')
                    : '—'}
            </td>
        ),
        billingNotes: <td className="px-3 py-1.5" />,
    };
    return (
        <tr
            className={cn(
                'border-t border-dashed border-border/40',
                zebra && 'bg-muted/20',
            )}
        >
            {visibleColumns.map((col) => (
                <Fragment key={col.id}>{cellMap[col.id]}</Fragment>
            ))}
        </tr>
    );
}

// "Total contracted" row — the SOW + Σ CRs grand total, shown
// directly below the CR rows. Bordered + bold so it reads as the
// definitive number. Only rendered when at least one CR exists.
function ProjectContractedTotalRow({
    project: p,
    zebra,
    visibleColumns,
}) {
    const sumInternal = (p.changeRequests || []).reduce(
        (acc, cr) => acc + (Number(cr.internalAmount) || 0),
        0,
    );
    const sumClient = (p.changeRequests || []).reduce(
        (acc, cr) => acc + (Number(cr.clientAmount) || 0),
        0,
    );
    const totalInternal = (Number(p.internalAmount) || 0) + sumInternal;
    const totalClient = (Number(p.clientAmount) || 0) + sumClient;
    const cellMap = {
        project: (
            <td className="px-3 py-1.5 pl-8 text-[11px] font-semibold uppercase tracking-wide text-foreground">
                Total contracted
            </td>
        ),
        client: <td />,
        country: <td />,
        owner: <td />,
        crmId: <td />,
        status: <td />,
        internalAmount: (
            <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs font-semibold tabular-nums">
                {p.internalAmount != null || sumInternal > 0
                    ? fmtMoney(totalInternal, p.internalCurrency)
                    : '—'}
            </td>
        ),
        internalPaid: <td />,
        internalPaidAt: <td />,
        clientAmount: (
            <td className="whitespace-nowrap px-3 py-1.5 text-right text-xs font-semibold tabular-nums">
                {p.clientAmount != null || sumClient > 0
                    ? fmtMoney(totalClient, p.clientCurrency)
                    : '—'}
            </td>
        ),
        clientPaid: <td />,
        clientPaidAt: <td />,
        billingNotes: <td />,
    };
    return (
        <tr
            className={cn(
                'border-t-2 border-primary/20',
                zebra ? 'bg-primary/[0.04]' : 'bg-primary/[0.03]',
            )}
        >
            {visibleColumns.map((col) => (
                <Fragment key={col.id}>{cellMap[col.id]}</Fragment>
            ))}
        </tr>
    );
}

// One project row. Columns are rendered conditionally so toggles in
// the "Columns" dropdown above immediately affect the table.
function BillingRow({
    project: p,
    zebra,
    visibleColumns,
    busyId,
    onTogglePaid,
    findProjectStatus,
}) {
    // Resolve label + Badge variant from the admin-managed status so
    // custom statuses render their own colour (falls back for unknown
    // keys via find()).
    const statusMeta = findProjectStatus?.(p.status);
    const cellMap = {
        project: (
            <td className="whitespace-nowrap px-3 py-2">
                <Link
                    to={`/projects/${p.id}`}
                    className="font-medium hover:underline"
                >
                    {p.name}
                </Link>
            </td>
        ),
        client: (
            <td className="px-3 py-2 text-xs text-muted-foreground">
                {p.client || '—'}
            </td>
        ),
        country: (
            <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                {p.country || '—'}
            </td>
        ),
        owner: (
            <td className="px-3 py-2 text-xs text-muted-foreground">
                {p.owner?.name || p.owner?.email || '—'}
            </td>
        ),
        crmId: (
            <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                {p.crmId || '—'}
            </td>
        ),
        status: (
            <td className="px-3 py-2 text-xs">
                <Badge
                    variant={statusMeta?.badge || 'outline'}
                    className="text-[10px]"
                >
                    {statusMeta?.label || STATUS_LABELS[p.status] || p.status}
                </Badge>
            </td>
        ),
        internalAmount: (
            <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                {fmtMoney(p.internalAmount, p.internalCurrency)}
            </td>
        ),
        internalPaid: (
            <td className="px-3 py-2 text-center">
                {p.internalAmount == null ? (
                    <span className="text-xs text-muted-foreground">—</span>
                ) : (
                    <PaidToggle
                        paid={p.internalPaid}
                        busy={busyId === `${p.id}:internal`}
                        onClick={() => onTogglePaid(p, 'internal')}
                    />
                )}
            </td>
        ),
        internalPaidAt: (
            <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                {p.internalPaid && p.internalPaidAt
                    ? format(new Date(p.internalPaidAt), 'MMM d, yyyy')
                    : '—'}
            </td>
        ),
        clientAmount: (
            <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                {fmtMoney(p.clientAmount, p.clientCurrency)}
            </td>
        ),
        clientPaid: (
            <td className="px-3 py-2 text-center">
                {p.clientAmount == null ? (
                    <span className="text-xs text-muted-foreground">—</span>
                ) : (
                    <PaidToggle
                        paid={p.clientPaid}
                        busy={busyId === `${p.id}:client`}
                        onClick={() => onTogglePaid(p, 'client')}
                    />
                )}
            </td>
        ),
        clientPaidAt: (
            <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                {p.clientPaid && p.clientPaidAt
                    ? format(new Date(p.clientPaidAt), 'MMM d, yyyy')
                    : '—'}
            </td>
        ),
        billingNotes: (
            <td className="max-w-xs px-3 py-2 text-xs text-muted-foreground">
                {p.billingNotes ? (
                    <span className="line-clamp-2">{p.billingNotes}</span>
                ) : (
                    '—'
                )}
            </td>
        ),
    };
    const crs = p.changeRequests || [];
    return (
        <Fragment>
            <tr className={cn('border-t', zebra && 'bg-muted/20')}>
                {visibleColumns.map((col) => (
                    <Fragment key={col.id}>{cellMap[col.id]}</Fragment>
                ))}
            </tr>
            {crs.map((cr) => (
                <CRSubRow
                    key={cr.id}
                    cr={cr}
                    project={p}
                    zebra={zebra}
                    visibleColumns={visibleColumns}
                    busyId={busyId}
                    onTogglePaid={onTogglePaid}
                />
            ))}
            {crs.length > 0 ? (
                <ProjectContractedTotalRow
                    project={p}
                    zebra={zebra}
                    visibleColumns={visibleColumns}
                />
            ) : null}
        </Fragment>
    );
}

function PaidToggle({ paid, busy, onClick }) {
    return (
        <button
            type="button"
            disabled={busy}
            onClick={onClick}
            title={paid ? 'Mark as unpaid' : 'Mark as paid'}
            className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors',
                paid
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-400',
                busy && 'opacity-50',
            )}
        >
            {paid ? (
                <>
                    <Check className="h-3 w-3" /> Paid
                </>
            ) : (
                <>
                    <AlertCircle className="h-3 w-3" /> Unpaid
                </>
            )}
        </button>
    );
}

// Multi-select filter trigger with checkbox options. Empty `values`
// means "no filter" — the trigger summarises the selection either as a
// count badge or the single selected label. Mirrors the filter UI on
// the Projects page.
function MultiFilter({ label, values, onChange, options }) {
    const selected = values.length;
    const toggle = (v) => {
        const set = new Set(values);
        if (set.has(v)) set.delete(v);
        else set.add(v);
        onChange(Array.from(set));
    };
    const summary =
        selected === 0
            ? `Any ${label.toLowerCase()}`
            : selected === 1
                ? options.find((o) => o.value === values[0])?.label || values[0]
                : `${label}: ${selected}`;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(
                        'h-9 min-w-[140px] justify-between gap-2 px-3 text-sm font-normal',
                        selected > 0 && 'border-primary/50 bg-primary/5',
                    )}
                >
                    <span className="truncate">{summary}</span>
                    {selected > 0 ? (
                        <span
                            role="button"
                            tabIndex={-1}
                            onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onChange([]);
                            }}
                            className="-mr-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={`Clear ${label} filter`}
                            title={`Clear ${label} filter`}
                        >
                            <X className="h-3.5 w-3.5" />
                        </span>
                    ) : (
                        <ChevronDown className="h-4 w-4 opacity-60" />
                    )}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>{label}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {options.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        No options
                    </p>
                ) : (
                    options.map((opt) => {
                        const checked = values.includes(opt.value);
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                onClick={() => toggle(opt.value)}
                                className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent focus:bg-accent"
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
                                <span className="flex-1 text-left">
                                    {opt.label}
                                </span>
                            </button>
                        );
                    })
                )}
                {selected > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => onChange([])}>
                            Clear selection
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// Single-select filter trigger that mirrors MultiFilter's look. Used
// for the "Payment" status filter where the four options are mutually
// exclusive.
function SingleFilter({ label, value, onChange, options }) {
    const isDefault = options[0]?.value === value;
    const current = options.find((o) => o.value === value);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(
                        'h-9 min-w-[140px] justify-between gap-2 px-3 text-sm font-normal',
                        !isDefault && 'border-primary/50 bg-primary/5',
                    )}
                >
                    <span className="truncate">
                        {isDefault
                            ? `Any ${label.toLowerCase()}`
                            : current?.label || value}
                    </span>
                    <ChevronDown className="h-4 w-4 opacity-60" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>{label}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {options.map((opt) => (
                    <button
                        key={opt.value}
                        type="button"
                        onClick={() => onChange(opt.value)}
                        className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent focus:bg-accent"
                    >
                        <span
                            className={cn(
                                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                                value === opt.value
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-muted-foreground/40',
                            )}
                        >
                            {value === opt.value && (
                                <Check className="h-3 w-3" />
                            )}
                        </span>
                        <span className="flex-1 text-left">{opt.label}</span>
                    </button>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
