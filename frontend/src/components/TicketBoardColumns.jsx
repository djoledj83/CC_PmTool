import { useCallback, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

// Shared ticket board used by BOTH the resolver workspace and the
// requester portal so they look and behave identically.
//
// Behaviour:
//   - Fills the available height (columns are full-height; each column's
//     card list scrolls on its own).
//   - Expanded columns share the width evenly (flex-1), so collapsing one
//     or more columns lets the rest spread to fill the freed space.
//   - Each column header has a collapse toggle; a collapsed column shrinks
//     to a thin vertical strip (label + count) that expands on click.
//     The collapsed set is remembered per board via `storageKey`.
//
// Props:
//   statuses       - ordered list of status keys
//   items          - all tickets (grouped here by `t.status`)
//   labelFor(s)    - column title
//   badgeClassFor(s) - tailwind classes for the header tint
//   renderCard(t)  - renders one ticket card
//   storageKey     - localStorage key for the collapsed set
export default function TicketBoardColumns({
    statuses = [],
    items = [],
    labelFor = (s) => s,
    badgeClassFor = () => '',
    renderCard,
    storageKey = 'tickets.board.collapsed',
}) {
    const [collapsed, setCollapsed] = useState(() => {
        try {
            const raw = localStorage.getItem(storageKey);
            return new Set(raw ? JSON.parse(raw) : []);
        } catch {
            return new Set();
        }
    });

    const persist = useCallback(
        (next) => {
            try {
                localStorage.setItem(storageKey, JSON.stringify([...next]));
            } catch {
                /* ignore */
            }
        },
        [storageKey],
    );

    const toggle = useCallback(
        (s) => {
            setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(s)) next.delete(s);
                else next.add(s);
                persist(next);
                return next;
            });
        },
        [persist],
    );

    const byStatus = useMemo(() => {
        const map = new Map(statuses.map((s) => [s, []]));
        for (const t of items) {
            if (map.has(t.status)) map.get(t.status).push(t);
        }
        return map;
    }, [statuses, items]);

    return (
        // Fills its parent's height — callers give it a height context
        // (the resolver flexes it; the portal wraps it at a fixed height)
        // so each column's card list can scroll on its own.
        <div className="flex h-full gap-3 overflow-x-auto pb-2">
            {statuses.map((s) => {
                const list = byStatus.get(s) || [];
                const isCollapsed = collapsed.has(s);

                if (isCollapsed) {
                    return (
                        <button
                            key={s}
                            type="button"
                            onClick={() => toggle(s)}
                            title={`Expand ${labelFor(s)}`}
                            className="flex h-full w-11 shrink-0 flex-col items-center gap-2 rounded-lg border bg-muted/30 py-2 transition-colors hover:bg-muted/60"
                        >
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            <span className="rounded-full bg-background/70 px-1.5 text-[10px] font-medium">
                                {list.length}
                            </span>
                            <span className="[writing-mode:vertical-rl] rotate-180 text-xs font-semibold text-muted-foreground">
                                {labelFor(s)}
                            </span>
                        </button>
                    );
                }

                return (
                    <div
                        key={s}
                        className="flex h-full min-w-[240px] flex-1 flex-col rounded-lg border bg-muted/30"
                    >
                        <div
                            className={cn(
                                'flex items-center justify-between gap-1 rounded-t-lg border-b px-3 py-2 text-xs font-semibold',
                                badgeClassFor(s),
                            )}
                        >
                            <span className="truncate">{labelFor(s)}</span>
                            <span className="flex shrink-0 items-center gap-1">
                                <span className="rounded-full bg-background/60 px-1.5 text-[10px]">
                                    {list.length}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => toggle(s)}
                                    title={`Collapse ${labelFor(s)}`}
                                    aria-label={`Collapse ${labelFor(s)}`}
                                    className="rounded p-0.5 opacity-70 hover:bg-background/60 hover:opacity-100"
                                >
                                    <ChevronLeft className="h-3.5 w-3.5" />
                                </button>
                            </span>
                        </div>
                        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                            {list.length === 0 ? (
                                <p className="px-1 py-3 text-center text-[11px] text-muted-foreground">
                                    Nothing here.
                                </p>
                            ) : (
                                list.map((t) => renderCard(t))
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
