import { useState } from 'react';

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
}) {
    const [active, setActive] = useState(null);

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
                            />
                        );
                    })}
                </svg>
                {/* Center readout */}
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-2xl font-semibold tabular-nums leading-none">
                        {centerBig}
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
                    return (
                        <li
                            key={r.key}
                            onMouseEnter={() => !zero && setActive(r.key)}
                            onMouseLeave={() => setActive(null)}
                            className={cn(
                                'flex items-center gap-2 rounded px-1.5 py-1 text-xs',
                                !zero && 'cursor-pointer hover:bg-accent/50',
                                isActive && 'bg-accent',
                                zero && 'opacity-50',
                            )}
                        >
                            <span
                                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                                style={{ backgroundColor: r.color }}
                            />
                            <span className="min-w-0 flex-1 truncate">
                                {r.label}
                            </span>
                            <span className="shrink-0 tabular-nums font-medium">
                                {r.count || 0}
                            </span>
                            <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground">
                                {pct}%
                            </span>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
