// Admin → Logs. Two panels:
//   1. Sign-in log — the auth audit trail (DB): every login attempt with its
//      outcome + reason, filterable by email / outcome / date, paginated.
//   2. Server logs — read-only tail of the access / app / error log files.
//
// Layout: same shell as the other admin tabs — TopBar + AdminTabs stay put
// and only <main> scrolls. The table has fixed column widths and the log
// box a fixed height, so paging, filtering and switching files don't make
// the page jump around.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, ShieldAlert, FileText, Search, Download } from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { TopBar } from '@/components/TopBar';
import AdminTabs from '@/components/AdminTabs';
import { Pagination } from '@/components/Pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

const OUTCOME_META = {
    LOGIN_SUCCESS: { label: 'Success', variant: 'success' },
    LOGIN_FAILED: { label: 'Failed', variant: 'destructive' },
    LOGIN_BLOCKED: { label: 'Blocked', variant: 'warning' },
};

const REASON_LABEL = {
    ok: 'Signed in',
    wrong_password: 'Wrong password',
    unknown_email: 'Unknown email',
    pending: 'Awaiting approval',
    suspended: 'Suspended account',
};

const TYPE_FILTER = [
    { value: '__all__', label: 'All outcomes' },
    { value: 'LOGIN_SUCCESS', label: 'Success' },
    { value: 'LOGIN_FAILED', label: 'Failed (bad password / unknown)' },
    { value: 'LOGIN_BLOCKED', label: 'Blocked (pending / suspended)' },
];

const LOG_FILES = [
    { value: 'access', label: 'Access (every request)' },
    { value: 'app', label: 'Application' },
    { value: 'error', label: 'Errors' },
];

function fmt(ts) {
    if (!ts) return '';
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return String(ts);
    }
}

function SignInLog() {
    const [events, setEvents] = useState([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(25);
    const [loading, setLoading] = useState(true);

    const [email, setEmail] = useState('');
    const [type, setType] = useState('__all__');
    // Only the latest request may update the table — an older, slower
    // response (e.g. while typing an email) must not overwrite it.
    const reqId = useRef(0);

    const load = useCallback(async () => {
        const id = ++reqId.current;
        setLoading(true);
        try {
            const params = { page, pageSize };
            if (email.trim()) params.email = email.trim();
            if (type !== '__all__') params.type = type;
            const { data } = await api.get('/admin/auth-events', { params });
            if (id !== reqId.current) return;
            setEvents(data.events || []);
            setTotal(data.total || 0);
        } catch (err) {
            if (id !== reqId.current) return;
            toast.error(err?.response?.data?.error || 'Could not load sign-in log');
        } finally {
            if (id === reqId.current) setLoading(false);
        }
    }, [page, pageSize, email, type]);

    // Debounce so typing an email doesn't fire a request per keystroke.
    useEffect(() => {
        const t = setTimeout(load, 300);
        return () => clearTimeout(t);
    }, [load]);

    const exportCsv = async () => {
        try {
            const params = {};
            if (email.trim()) params.email = email.trim();
            if (type !== '__all__') params.type = type;
            const res = await api.get('/admin/auth-events.csv', {
                params,
                responseType: 'blob',
            });
            const url = URL.createObjectURL(
                new Blob([res.data], { type: 'text/csv;charset=utf-8' }),
            );
            const a = document.createElement('a');
            a.href = url;
            a.download = `sign-in-log-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch {
            toast.error('Could not export the sign-in log');
        }
    };

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return (
        <Card>
            <CardHeader className="gap-3">
                <div className="flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-primary" />
                    <CardTitle className="text-base">Sign-in log</CardTitle>
                    <Badge variant="secondary" className="text-[10px] tabular-nums">
                        {total}
                    </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={email}
                            onChange={(e) => {
                                setPage(1);
                                setEmail(e.target.value);
                            }}
                            placeholder="Filter by email"
                            className="h-8 w-56 pl-8 text-xs"
                        />
                    </div>
                    <Select
                        value={type}
                        onValueChange={(v) => {
                            setPage(1);
                            setType(v);
                        }}
                    >
                        <SelectTrigger className="h-8 w-[240px] text-xs">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {TYPE_FILTER.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                    {o.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5"
                        onClick={load}
                        disabled={loading}
                    >
                        <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                        Refresh
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5"
                        onClick={exportCsv}
                        disabled={!total}
                        title="Export the filtered sign-in log as CSV"
                    >
                        <Download className="h-3.5 w-3.5" />
                        Export CSV
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="p-0">
                <div className="overflow-x-auto">
                    {/* Fixed layout + column widths: the columns no longer
                        resize to each page's longest email / IP. */}
                    <table className="w-full min-w-[55rem] table-fixed text-sm">
                        <colgroup>
                            <col className="w-48" />
                            <col />
                            <col className="w-28" />
                            <col className="w-40" />
                            <col className="w-44" />
                        </colgroup>
                        <thead>
                            <tr className="border-y bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                                <th className="px-3 py-2 font-medium">When</th>
                                <th className="px-3 py-2 font-medium">Email</th>
                                <th className="px-3 py-2 font-medium">Outcome</th>
                                <th className="px-3 py-2 font-medium">Reason</th>
                                <th className="px-3 py-2 font-medium">IP</th>
                            </tr>
                        </thead>
                        <tbody
                            aria-busy={loading}
                            className={cn(
                                'transition-opacity',
                                loading && events.length > 0 && 'opacity-60',
                            )}
                        >
                            {events.length === 0 ? (
                                <tr>
                                    <td
                                        colSpan={5}
                                        className="px-3 py-8 text-center text-xs text-muted-foreground"
                                    >
                                        {loading ? 'Loading…' : 'No sign-in attempts match.'}
                                    </td>
                                </tr>
                            ) : (
                                events.map((e) => {
                                    const meta =
                                        OUTCOME_META[e.type] || {
                                            label: e.type,
                                            variant: 'secondary',
                                        };
                                    return (
                                        <tr
                                            key={e.id}
                                            className="border-b last:border-0 odd:bg-muted/20"
                                        >
                                            <td
                                                className="truncate px-3 py-2 tabular-nums text-muted-foreground"
                                                title={fmt(e.createdAt)}
                                            >
                                                {fmt(e.createdAt)}
                                            </td>
                                            <td
                                                className="truncate px-3 py-2"
                                                title={e.email || undefined}
                                            >
                                                {e.email || '—'}
                                            </td>
                                            <td className="px-3 py-2">
                                                <Badge
                                                    variant={meta.variant}
                                                    className="text-[10px]"
                                                >
                                                    {meta.label}
                                                </Badge>
                                            </td>
                                            <td
                                                className="truncate px-3 py-2 text-muted-foreground"
                                                title={REASON_LABEL[e.reason] || e.reason || undefined}
                                            >
                                                {REASON_LABEL[e.reason] || e.reason || '—'}
                                            </td>
                                            <td
                                                className="truncate px-3 py-2 font-mono text-xs text-muted-foreground"
                                                title={e.ip || undefined}
                                            >
                                                {e.ip || '—'}
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
                <Pagination
                    page={page}
                    pageSize={pageSize}
                    total={total}
                    totalPages={totalPages}
                    onPageChange={setPage}
                    onPageSizeChange={(s) => {
                        setPage(1);
                        setPageSize(s);
                    }}
                    pageSizeOptions={[25, 50, 100]}
                />
            </CardContent>
        </Card>
    );
}

function ServerLogs() {
    const [name, setName] = useState('access');
    const [lines, setLines] = useState('200');
    const [data, setData] = useState({ lines: [], file: null, enabled: true, dir: '' });
    const [loading, setLoading] = useState(false);
    const reqId = useRef(0);
    const boxRef = useRef(null);

    const load = useCallback(async () => {
        const id = ++reqId.current;
        setLoading(true);
        try {
            const res = await api.get(`/admin/logs/${name}`, {
                params: { lines: Number(lines) || 200 },
            });
            if (id !== reqId.current) return; // switched file meanwhile
            const d = res.data || {};
            setData({ ...d, lines: Array.isArray(d.lines) ? d.lines : [] });
        } catch (err) {
            if (id !== reqId.current) return;
            toast.error(err?.response?.data?.error || 'Could not read log file');
            setData({ lines: [], file: null, enabled: true });
        } finally {
            if (id === reqId.current) setLoading(false);
        }
    }, [name, lines]);

    useEffect(() => {
        load();
    }, [load]);

    // It's a tail — the newest lines are at the end, so show those.
    // (Scrolls the log box only, never the page.)
    useLayoutEffect(() => {
        const box = boxRef.current;
        if (box) box.scrollTop = box.scrollHeight;
    }, [data]);

    return (
        <Card>
            <CardHeader className="gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    <CardTitle className="text-base">Server logs</CardTitle>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                        <Select value={name} onValueChange={setName}>
                            <SelectTrigger className="h-8 w-[220px] text-xs">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {LOG_FILES.map((o) => (
                                    <SelectItem key={o.value} value={o.value}>
                                        {o.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select value={lines} onValueChange={setLines}>
                            <SelectTrigger className="h-8 w-[110px] text-xs">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {['200', '500', '1000'].map((n) => (
                                    <SelectItem key={n} value={n}>
                                        {n} lines
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5"
                            onClick={load}
                            disabled={loading}
                        >
                            <RefreshCw
                                className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
                            />
                            Refresh
                        </Button>
                    </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                    {data.enabled === false
                        ? 'File logging is disabled (no writable log folder) — showing stdout only.'
                        : data.file
                          ? `Showing the last ${data.lines.length} lines of ${data.file}`
                          : 'No log file yet — it appears once there is activity.'}
                </p>
            </CardHeader>
            <CardContent>
                {/* Fixed height, so switching to a short (or empty) log
                    doesn't collapse the card and shift the page. */}
                <pre
                    ref={boxRef}
                    aria-busy={loading}
                    className={cn(
                        'h-[60vh] min-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-[11px] leading-relaxed transition-opacity',
                        loading && data.lines.length > 0 && 'opacity-60',
                    )}
                >
                    {data.lines.length
                        ? data.lines.join('\n')
                        : loading
                          ? 'Loading…'
                          : '(empty)'}
                </pre>
            </CardContent>
        </Card>
    );
}

// Same shell as Announcements / Templates / Time logging / Billing. The
// page used to be a single min-h-full block inside the layout's
// overflow-hidden column, so it had no real scroll area: the lower part
// got cut off, and focus / text selection could shift the whole page
// (top bar and tabs included) out of place.
export default function AdminLogs() {
    return (
        <>
            <TopBar title="Logs" />
            <AdminTabs />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="flex w-full flex-col gap-6">
                    <SignInLog />
                    <ServerLogs />
                </div>
            </main>
        </>
    );
}
