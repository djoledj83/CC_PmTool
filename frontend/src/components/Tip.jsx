import { Lightbulb, Info, HelpCircle, Bug } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// Tiny, opinionated "info-icon button + popover" used to embed
// just-in-time guidance next to fields, controls or KPIs without
// blowing the layout up. Three flavours:
//
//   tip       → Lightbulb (the default; "here's a suggestion")
//   info      → Info       ("here's a definition / context")
//   help      → HelpCircle ("here's how this thing works")
//   debug     → Bug        ("admin-only diagnostic; expand for raw
//                            internals")
//
// Props:
//   children   : the body of the popover (string or JSX).
//   variant    : one of the keys above. Default "tip".
//   className  : passed through to the trigger button so callers can
//                tweak size / colour for context.
//   side       : popover side. Default "top".
//   align      : popover align. Default "center".
//   srLabel    : aria-label for the trigger button. Default depends
//                on variant so the icon has meaning for screen
//                readers.
//
// Usage:
//   <Tip variant="tip">Pick the first weekday you want sprints to
//     fall on.</Tip>
//
// Keep the popover content short (a sentence or two). For longer
// content link out to the Help page.
const VARIANTS = {
    tip: {
        Icon: Lightbulb,
        colour: 'text-amber-500',
        sr: 'Show tip',
    },
    info: {
        Icon: Info,
        colour: 'text-sky-500',
        sr: 'Show details',
    },
    help: {
        Icon: HelpCircle,
        colour: 'text-muted-foreground',
        sr: 'Show help',
    },
    debug: {
        Icon: Bug,
        colour: 'text-rose-500',
        sr: 'Show debug info',
    },
};

export function Tip({
    children,
    variant = 'tip',
    className,
    side = 'top',
    align = 'center',
    srLabel,
}) {
    const v = VARIANTS[variant] || VARIANTS.tip;
    const { Icon, colour, sr } = v;
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label={srLabel || sr}
                    className={cn(
                        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        colour,
                        className,
                    )}
                >
                    <Icon className="h-3.5 w-3.5" aria-hidden />
                </button>
            </PopoverTrigger>
            <PopoverContent
                side={side}
                align={align}
                className="w-72 text-xs leading-relaxed"
            >
                {children}
            </PopoverContent>
        </Popover>
    );
}

export default Tip;
