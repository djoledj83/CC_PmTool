// Preset colour palette for ticket request types. An admin picks one of
// these (stored as the short `value` on TicketRequestType.color) so the
// type badge is tinted — making POS / SoftPOS / eCommerce / etc. easy to
// tell apart at a glance in the queue and the resolver.
//
// IMPORTANT: every Tailwind class below is written out in full as a
// literal string. Tailwind only ships classes it can see in the source,
// so we must NOT build class names dynamically (e.g. `bg-${c}-500`) —
// those would get purged and render as no-ops.

export const TICKET_TYPE_COLORS = [
    {
        value: 'slate',
        label: 'Slate',
        dot: 'bg-slate-500',
        badge: 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300',
        chip: 'bg-slate-500/15 text-slate-600 dark:text-slate-300',
    },
    {
        value: 'red',
        label: 'Red',
        dot: 'bg-red-500',
        badge: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
        chip: 'bg-red-500/15 text-red-600 dark:text-red-400',
    },
    {
        value: 'orange',
        label: 'Orange',
        dot: 'bg-orange-500',
        badge: 'border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400',
        chip: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
    },
    {
        value: 'amber',
        label: 'Amber',
        dot: 'bg-amber-500',
        badge: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
        chip: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    },
    {
        value: 'green',
        label: 'Green',
        dot: 'bg-green-500',
        badge: 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400',
        chip: 'bg-green-500/15 text-green-600 dark:text-green-400',
    },
    {
        value: 'teal',
        label: 'Teal',
        dot: 'bg-teal-500',
        badge: 'border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400',
        chip: 'bg-teal-500/15 text-teal-600 dark:text-teal-400',
    },
    {
        value: 'cyan',
        label: 'Cyan',
        dot: 'bg-cyan-500',
        badge: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
        chip: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
    },
    {
        value: 'blue',
        label: 'Blue',
        dot: 'bg-blue-500',
        badge: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
        chip: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
    },
    {
        value: 'indigo',
        label: 'Indigo',
        dot: 'bg-indigo-500',
        badge: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
        chip: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
    },
    {
        value: 'violet',
        label: 'Violet',
        dot: 'bg-violet-500',
        badge: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
        chip: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
    },
    {
        value: 'pink',
        label: 'Pink',
        dot: 'bg-pink-500',
        badge: 'border-pink-500/30 bg-pink-500/10 text-pink-600 dark:text-pink-400',
        chip: 'bg-pink-500/15 text-pink-600 dark:text-pink-400',
    },
    {
        value: 'rose',
        label: 'Rose',
        dot: 'bg-rose-500',
        badge: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400',
        chip: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
    },
];

const BY_VALUE = Object.fromEntries(
    TICKET_TYPE_COLORS.map((c) => [c.value, c]),
);

// Fallbacks match the previous (uncoloured) look, so a type with no colour
// set renders exactly as it did before this feature.
const DEFAULT_BADGE = 'border-primary/20 bg-primary/5 text-primary';
const DEFAULT_CHIP = 'bg-primary/10 text-primary';

// Classes for the inline type badge (border + bg + text). The caller keeps
// the layout classes (border width, padding, rounding, size).
export function getTicketTypeBadgeClasses(color) {
    return BY_VALUE[color]?.badge || DEFAULT_BADGE;
}

// Classes for the square icon chip shown in admin/portal lists (bg + text).
export function getTicketTypeChipClasses(color) {
    return BY_VALUE[color]?.chip || DEFAULT_CHIP;
}

// The small dot used inside the colour picker swatches.
export function getTicketTypeDotClass(color) {
    return BY_VALUE[color]?.dot || 'bg-primary';
}
