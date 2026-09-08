// Reusable client-side pagination: a `usePagination` hook that slices an
// already-loaded array into pages, plus a <Pagination> footer with an
// "X–Y of Z" count, an optional page-size selector, and prev/next +
// numbered page buttons. Lists in this app load fully, so paging is done
// in memory — no backend changes needed.
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

// Manage page + pageSize for an array. Returns the current page's slice
// plus the controls the <Pagination> footer needs. The page auto-clamps
// when the list shrinks (e.g. after a search filter).
export function usePagination(items, initialSize = 10) {
    const list = items || [];
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(initialSize);
    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    useEffect(() => {
        if (page > totalPages) setPage(totalPages);
    }, [page, totalPages]);

    const pageItems = useMemo(
        () => list.slice((page - 1) * pageSize, page * pageSize),
        [list, page, pageSize],
    );

    const changePageSize = (n) => {
        setPageSize(n);
        setPage(1);
    };

    return {
        page,
        setPage,
        pageSize,
        setPageSize: changePageSize,
        total,
        totalPages,
        pageItems,
    };
}

// A compact window of page numbers: always show first + last, the current
// page and its neighbours, with "…" gaps. e.g. 1 … 4 5 6 … 20
function pageWindow(page, totalPages) {
    if (totalPages <= 7) {
        return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const out = [1];
    const start = Math.max(2, page - 1);
    const end = Math.min(totalPages - 1, page + 1);
    if (start > 2) out.push('…');
    for (let p = start; p <= end; p++) out.push(p);
    if (end < totalPages - 1) out.push('…');
    out.push(totalPages);
    return out;
}

// Standalone "Show [N] per page" selector, meant to sit ABOVE the list
// (the page navigation lives in <Pagination> at the bottom). Render this
// at the top of a paginated section.
export function PageSizeControl({
    pageSize,
    onPageSizeChange,
    options = [],
    className,
}) {
    if (!options.length || !onPageSizeChange) return null;
    return (
        <div
            className={cn(
                'flex items-center gap-1.5 text-xs text-muted-foreground',
                className,
            )}
        >
            <span>Show</span>
            <Select
                value={String(pageSize)}
                onValueChange={(v) => onPageSizeChange(Number(v))}
            >
                <SelectTrigger className="h-7 w-[70px] text-xs">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {options.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                            {n}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <span>per page</span>
        </div>
    );
}

function PagerButton({ children, active = false, disabled = false, ...props }) {
    return (
        <button
            type="button"
            disabled={disabled}
            className={cn(
                'inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-2 text-xs transition-colors',
                active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'bg-background hover:bg-accent',
                disabled && 'pointer-events-none opacity-40',
            )}
            {...props}
        >
            {children}
        </button>
    );
}

export function Pagination({
    page,
    pageSize,
    total,
    totalPages,
    onPageChange,
    onPageSizeChange = null,
    pageSizeOptions = [],
    className,
}) {
    if (!total) return null;
    const pages = Math.max(1, totalPages ?? Math.ceil(total / pageSize));
    const from = (page - 1) * pageSize + 1;
    const to = Math.min(total, page * pageSize);
    const window = pageWindow(page, pages);

    return (
        <div
            className={cn(
                // Selector + count on top, page navigation centered below.
                // Centering keeps the page buttons clear of the floating
                // chat icon that sits in the bottom-right corner.
                'flex flex-col items-center gap-2 border-t px-3 py-2 text-sm',
                className,
            )}
        >
            <div className="text-muted-foreground tabular-nums">
                {from}–{to} of {total}
            </div>
            {pages > 1 && (
                <div className="flex items-center gap-1">
                    <PagerButton
                        disabled={page <= 1}
                        onClick={() => onPageChange(page - 1)}
                        aria-label="Previous page"
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </PagerButton>
                    {window.map((p, i) =>
                        p === '…' ? (
                            <span
                                key={`gap-${i}`}
                                className="px-1 text-muted-foreground"
                            >
                                …
                            </span>
                        ) : (
                            <PagerButton
                                key={p}
                                active={p === page}
                                onClick={() => onPageChange(p)}
                            >
                                {p}
                            </PagerButton>
                        ),
                    )}
                    <PagerButton
                        disabled={page >= pages}
                        onClick={() => onPageChange(page + 1)}
                        aria-label="Next page"
                    >
                        <ChevronRight className="h-4 w-4" />
                    </PagerButton>
                </div>
            )}
        </div>
    );
}

export default Pagination;
