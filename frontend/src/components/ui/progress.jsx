import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';

import { cn } from '@/lib/utils';

// Progress bar.
//
// - `value` is 0..100.
// - `indicatorClassName` overrides the fill colour (used for green
//   "complete" / red "overdue" states).
// - `segments` (default 5) draws hairline tick marks every `100/segments`
//   percent so the bar reads as a fuel gauge — each notch ≈ 20% — and a
//   "37%" bar is unmistakable from a "55%" one at a glance. Pass `0` to
//   disable the notches entirely (used in places where we only want a
//   smooth fill, e.g. the daily-hours mini-bars).
const Progress = React.forwardRef(
    (
        {
            className,
            value,
            indicatorClassName,
            segments = 5,
            ...props
        },
        ref,
    ) => (
        <ProgressPrimitive.Root
            ref={ref}
            className={cn(
                'relative h-2.5 w-full overflow-hidden rounded-full bg-secondary',
                className,
            )}
            {...props}
        >
            <ProgressPrimitive.Indicator
                className={cn(
                    'h-full w-full flex-1 bg-primary transition-all',
                    indicatorClassName,
                )}
                style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
            />
            {/* Notches sit on top of the indicator so they render as
                subtle background-coloured dividers between segments,
                regardless of which colour the indicator currently is.
                We render `segments - 1` lines so 10 segments = 9
                dividers at 10 / 20 / ... / 90 percent. */}
            {segments > 1 && (
                <div className="pointer-events-none absolute inset-0">
                    {Array.from({ length: segments - 1 }, (_, i) => (
                        <span
                            key={i}
                            aria-hidden
                            className="absolute top-0 h-full w-px bg-background/70"
                            style={{
                                left: `${((i + 1) / segments) * 100}%`,
                            }}
                        />
                    ))}
                </div>
            )}
        </ProgressPrimitive.Root>
    ),
);
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
