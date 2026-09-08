// History of saved time-tracking CSV exports. Each export was snapshotted
// on the server when it ran, so it can be re-downloaded byte-for-byte.
// Rows show when/who/what range, size, row count, a "time to live" badge
// (days until the 1-year retention deletes it), and re-download / delete.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Download, Loader2, Trash2, History } from 'lucide-react';
import { format } from 'date-fns';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { downloadFromApi } from '@/lib/download';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

function fmtBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    return `${Math.round((b / (1024 * 1024)) * 10) / 10} MB`;
}

function daysLeft(expiresAt) {
    const ms = new Date(expiresAt).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function rangeLabel(meta) {
    if (!meta) return 'All time';
    const f = meta.from ? format(new Date(meta.from), 'd MMM yyyy') : null;
    const t = meta.to ? format(new Date(meta.to), 'd MMM yyyy') : null;
    if (f && t) return `${f} – ${t}`;
    if (f) return `from ${f}`;
    if (t) return `until ${t}`;
    return 'All time';
}

export default function TimeExportHistoryDialog({ open, onOpenChange }) {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(false);
    const [busyId, setBusyId] = useState(null);

    const load = () => {
        setLoading(true);
        api.get('/exports/time/history')
            .then(({ data }) => setRows(data?.exports || []))
            .catch(() => toast.error('Could not load export history.'))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        if (open) load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const redownload = async (row) => {
        setBusyId(row.id);
        try {
            await downloadFromApi(`/exports/time/history/${row.id}/download`, {
                filenameFallback: row.filename,
            });
        } catch {
            toast.error('Could not download — the file may have expired.');
        } finally {
            setBusyId(null);
        }
    };

    const remove = async (row) => {
        if (!window.confirm('Delete this saved export? This cannot be undone.'))
            return;
        try {
            await api.delete(`/exports/time/history/${row.id}`);
            setRows((prev) => prev.filter((r) => r.id !== row.id));
        } catch {
            toast.error('Could not delete export.');
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[620px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <History className="h-4 w-4" />
                        Export history
                    </DialogTitle>
                    <DialogDescription>
                        Past time-tracking exports. Re-download the exact file
                        that was produced. Kept for one year.
                    </DialogDescription>
                </DialogHeader>

                {loading ? (
                    <p className="flex items-center gap-1.5 p-6 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </p>
                ) : rows.length === 0 ? (
                    <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                        No exports yet. Use “Export to CSV” and it'll appear
                        here.
                    </p>
                ) : (
                    <ul className="max-h-[60vh] divide-y overflow-y-auto rounded-md border">
                        {rows.map((r) => {
                            const dl = daysLeft(r.expiresAt);
                            return (
                                <li
                                    key={r.id}
                                    className="flex items-center gap-3 px-3 py-2 text-sm"
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="truncate font-medium">
                                                {format(
                                                    new Date(r.createdAt),
                                                    "d MMM yyyy 'at' HH:mm",
                                                )}
                                            </span>
                                            <span
                                                title={`Deleted in ${dl} day${dl === 1 ? '' : 's'}`}
                                                className={cn(
                                                    'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                                                    dl <= 14
                                                        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                                                        : 'bg-muted text-muted-foreground',
                                                )}
                                            >
                                                {dl}d left
                                            </span>
                                        </div>
                                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                            {rangeLabel(r.meta)} ·{' '}
                                            {r.rowCount != null
                                                ? `${r.rowCount} row${r.rowCount === 1 ? '' : 's'}`
                                                : '—'}{' '}
                                            · {fmtBytes(r.sizeBytes)}
                                            {r.createdBy
                                                ? ` · ${r.createdBy.name}`
                                                : ''}
                                        </div>
                                    </div>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-8 shrink-0 gap-1.5"
                                        onClick={() => redownload(r)}
                                        disabled={busyId === r.id}
                                    >
                                        {busyId === r.id ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Download className="h-3.5 w-3.5" />
                                        )}
                                        Download
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-8 w-8 shrink-0 text-rose-600 hover:text-rose-600"
                                        onClick={() => remove(r)}
                                        title="Delete"
                                        aria-label="Delete export"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </DialogContent>
        </Dialog>
    );
}
