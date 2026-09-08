import { Highlighter, Pin, PinOff, Star } from 'lucide-react';

import { cn } from '@/lib/utils';
import { usePins } from '@/hooks/usePins';

// One toggle button used for every "user marks X" affordance. The
// underlying storage is the shared UserPin table (see schema). The
// visual is picked by `variant`:
//
//   pin         → Pin / PinOff   (project / activity bookmark)
//   star        → Star (filled)  (sprint goal / prod release)
//   highlighter → Highlighter    (task "today's focus" stripe)
//
// Optimistic: clicking flips the state immediately and only rolls
// back if the network call fails (toast on failure is the caller's
// responsibility — we keep this component dumb).
const VARIANTS = {
    pin: {
        OnIcon: Pin,
        OffIcon: PinOff,
        onClass: 'text-emerald-600',
        offClass: 'text-muted-foreground',
        onLabel: 'Unpin',
        offLabel: 'Pin',
    },
    star: {
        OnIcon: Star,
        OffIcon: Star,
        onClass: 'fill-amber-400 text-amber-500',
        offClass: 'text-muted-foreground',
        onLabel: 'Unstar',
        offLabel: 'Star',
    },
    highlighter: {
        OnIcon: Highlighter,
        OffIcon: Highlighter,
        onClass: 'text-fuchsia-600',
        offClass: 'text-muted-foreground',
        onLabel: 'Clear focus',
        offLabel: 'Mark as focus',
    },
};

export function PinButton({
    kind,
    refId,
    variant = 'pin',
    size = 'sm',
    className,
    pinHookOverride,
    onLabel,
    offLabel,
}) {
    const v = VARIANTS[variant] || VARIANTS.pin;
    // The parent page often already loads pins via usePins for a
    // batch (the projects list, for instance, loads pins for every
    // visible project in one round-trip). In that case it passes the
    // hook result down so each button doesn't issue its own GET.
    // pinHookOverride: { isPinned, toggle, loading }
    //
    // Hooks can't be called conditionally, so we always call
    // usePins — but pass `enabled: false` when an override exists so
    // it doesn't fire a duplicate /pins request. Without this guard,
    // a page with N rows triggers N concurrent /pins requests on
    // mount and trips the rate limiter (429).
    const fallback = usePins(kind, { enabled: !pinHookOverride });
    const { isPinned, toggle, loading } = pinHookOverride || fallback;
    const active = isPinned(refId);
    const Icon = active ? v.OnIcon : v.OffIcon;
    const label = active
        ? onLabel || v.onLabel
        : offLabel || v.offLabel;
    const dimensions =
        size === 'xs'
            ? 'h-5 w-5'
            : size === 'lg'
                ? 'h-9 w-9'
                : 'h-7 w-7';
    const iconDim =
        size === 'xs' ? 'h-3 w-3' : size === 'lg' ? 'h-5 w-5' : 'h-3.5 w-3.5';
    return (
        <button
            type="button"
            aria-pressed={active}
            aria-label={label}
            title={label}
            disabled={loading}
            onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                toggle(refId);
            }}
            className={cn(
                'inline-flex shrink-0 items-center justify-center rounded-md border border-transparent transition-colors hover:border-border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                dimensions,
                active ? v.onClass : v.offClass,
                className,
            )}
        >
            <Icon
                className={cn(
                    iconDim,
                    active && variant === 'star' && 'fill-current',
                )}
                aria-hidden
            />
        </button>
    );
}

export default PinButton;
