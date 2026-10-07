import { useState } from 'react';
import { ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

// A small SVG donut/pie chart with a legend.
//
//   rows: [{ key, label, count, color }]   (color = CSS/hex color)
//
// Hovering a slice (or a legend row) highlights that slice and shows its
// label + count in the middle of the ring; the legend lists every slice
// with a colour swatch, its label, count and share of the total. Zero-
// count rows are dropped from the ring but still listed (greyed) in the
// legend so the categories stay visible.
export default function DonutChart({
    rows = [],
    size = 148,
    thickness = 22,
    centerLabel = 'Total',
    // When set, the legend list caps at this pixel height and scrolls —
    // keeps a chart with many categories the same size as its neighbours.
    legendMaxHeight = null,
    // Optional formatter for the value shown in the centre + legend
    // (e.g. seconds → "12h 30m"). Defaults to the raw number, so existing
    // callers that pass integer counts are unaffected.
    formatValue = (v) => v,
}) {
    const [active, setActive] = useState(null);
    // Which legend rows are expanded. Only rows carrying an `items` array
    // (e.g. an "Other" bucket) are expandable; others ignore this.
    const [openKeys, setOpenKeys] = useState(() => new Set());
    const toggleOpen = (key) =>
        setOpenKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    const total = rows.reduce((s, r) => s + (r.count || 0), 0);
    const slices = rows.filter((r) => (r.count || 0) > 0);

    const radius = (size - thickness) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const circumference = 2 * Math.PI * radius;

    // Build the stroke segments around the ring.
    let offsetAcc = 0;
    const segments = slices.map((r) => {
        const frac = total > 0 ? r.count / total : 0;
        const seg = {
            ...r,
            frac,
            dash: frac * circumference,
            offset: offsetAcc,
        };
        offsetAcc += frac * circumference;
        return seg;
    });

    const activeRow = active != null ? rows.find((r) => r.key === active) : null;
    const centerBig = activeRow ? activeRow.count : total;
    const centerSmall = activeRow ? activeRow.label : centerLabel;

    // Fit the centre readout to the ring. The component was built for short
    // integer counts (kept large); longer strings — e.g. a "1534h 45m"
    // duration from formatValue — step down so they don't overflow the hole.
    const centerText = formatValue(centerBig);
    const centerLen = String(centerText).length;
    const centerSizeClass =
        centerLen <= 4
            ? 'text-2xl'
            : centerLen <= 6
              ? 'text-xl'
              : centerLen <= 9
                ? 'text-lg'
                : 'text-sm';

    return (
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
            <div className="relative shrink-0" style={{ width: size, height: size }}>
                <svg
                    width={size}
                    height={size}
                    viewBox={`0 0 ${size} ${size}`}
                    className="-rotate-90"
                >
                    {/* Track */}
                    <circle
                        cx={cx}
                        cy={cy}
                        r={radius}
                        fill="none"
                        strokeWidth={thickness}
                        className="stroke-muted"
                    />
                    {segments.map((s) => {
                        const isActive = active === s.key;
                        const dim = active != null && !isActive;
                        return (
                            <circle
                                key={s.key}
                                cx={cx}
                                cy={cy}
                                r={radius}
                                fill="none"
                                stroke={s.color}
                                strokeWidth={
                                    isActive ? thickness + 4 : thickness
                                }
                                strokeDasharray={`${s.dash} ${circumference - s.dash}`}
                                strokeDashoffset={-s.offset}
                                strokeLinecap="butt"
                                className="cursor-pointer transition-all"
                                style={{ opacity: dim ? 0.35 : 1 }}
                                onMouseEnter={() => setActive(s.key)}
                                onMouseLeave={() => setActive(null)}
                                onClick={
                                    s.items ? () => toggleOpen(s.key) : undefined
                                }
                            />
                        );
                    })}
                </svg>
                {/* Center readout */}
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span
                        className={cn(
                            'max-w-full px-1 font-semibold tabular-nums leading-none',
                            centerSizeClass,
                        )}
                    >
                        {centerText}
                    </span>
                    <span className="mt-0.5 max-w-[80%] truncate text-[11px] text-muted-foreground">
                        {centerSmall}
                    </span>
                </div>
            </div>

            {/* Legend */}
            <ul
                className={cn(
                    'min-w-0 flex-1 space-y-1',
                    legendMaxHeight && 'overflow-y-auto pr-1',
                )}
                style={
                    legendMaxHeight ? { maxHeight: legendMaxHeight } : undefined
                }
            >
                {rows.map((r) => {
                    const pct =
                        total > 0
                            ? Math.round(((r.count || 0) / total) * 100)
                            : 0;
                    const isActive = active === r.key;
                    const zero = (r.count || 0) === 0;
                    const items = Array.isArray(r.items) ? r.items : null;
                    const open = items ? openKeys.has(r.key) : false;
                    return (
                        <li key={r.key}>
                            <div
                                onMouseEnter={() => !zero && setActive(r.key)}
                                onMouseLeave={() => setActive(null)}
                                onClick={
                                    items ? () => toggleOpen(r.key) : undefined
                                }
                                className={cn(
                                    'flex items-center gap-2 rounded px-1.5 py-1 text-xs',
                                    (!zero || items) &&
                                        'cursor-pointer hover:bg-accent/50',
                                    isActive && 'bg-accent',
                                    zero && !items && 'opacity-50',
                                )}
                            >
                                <span
                                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                                    style={{ backgroundColor: r.color }}
                                />
                                <span className="min-w-0 flex-1 truncate">
                                    {r.label}
                                </span>
                                {items && (
                                    <ChevronRight
                                        className={cn(
                                            'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
                                            open && 'rotate-90',
                                        )}
                                    />
                                )}
                                <span className="shrink-0 tabular-nums font-medium">
                                    {formatValue(r.count || 0)}
                                </span>
                                <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">
                                    {pct}%
                                </span>
                            </div>
                            {items && open && (
                                <ul className="mb-1 ml-4 max-h-40 space-y-0.5 overflow-y-auto border-l pl-2 pt-0.5">
                                    {items.map((it, idx) => (
                                        <li
                                            key={idx}
                                            className="flex items-center gap-2 text-[11px] text-muted-foreground"
                                        >
                                            <span className="min-w-0 flex-1 truncate">
                                                {it.label}
                                            </span>
                                            <span className="shrink-0 tabular-nums">
                                                {formatValue(it.seconds)}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
