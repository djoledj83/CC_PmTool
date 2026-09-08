// Whitelist of Tailwind palette tokens we use to colour project labels.
// Storing the bare token (e.g. "rose") on the project row keeps the DB
// representation portable; rendering looks up the actual class strings
// here so we can adjust the visual without a migration.
export const LABEL_COLORS = [
    {
        value: 'slate',
        label: 'Slate',
        chip: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-500/15 dark:text-slate-200 dark:ring-slate-500/30',
        swatch: 'bg-slate-400',
    },
    {
        value: 'sky',
        label: 'Sky',
        chip: 'bg-sky-100 text-sky-800 ring-sky-200 dark:bg-sky-500/20 dark:text-sky-100 dark:ring-sky-500/30',
        swatch: 'bg-sky-500',
    },
    {
        value: 'emerald',
        label: 'Emerald',
        chip: 'bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-100 dark:ring-emerald-500/30',
        swatch: 'bg-emerald-500',
    },
    {
        value: 'amber',
        label: 'Amber',
        chip: 'bg-amber-100 text-amber-800 ring-amber-200 dark:bg-amber-500/20 dark:text-amber-100 dark:ring-amber-500/30',
        swatch: 'bg-amber-500',
    },
    {
        value: 'rose',
        label: 'Rose',
        chip: 'bg-rose-100 text-rose-800 ring-rose-200 dark:bg-rose-500/20 dark:text-rose-100 dark:ring-rose-500/30',
        swatch: 'bg-rose-500',
    },
    {
        value: 'violet',
        label: 'Violet',
        chip: 'bg-violet-100 text-violet-800 ring-violet-200 dark:bg-violet-500/20 dark:text-violet-100 dark:ring-violet-500/30',
        swatch: 'bg-violet-500',
    },
    {
        value: 'fuchsia',
        label: 'Fuchsia',
        chip: 'bg-fuchsia-100 text-fuchsia-800 ring-fuchsia-200 dark:bg-fuchsia-500/20 dark:text-fuchsia-100 dark:ring-fuchsia-500/30',
        swatch: 'bg-fuchsia-500',
    },
    {
        value: 'cyan',
        label: 'Cyan',
        chip: 'bg-cyan-100 text-cyan-800 ring-cyan-200 dark:bg-cyan-500/20 dark:text-cyan-100 dark:ring-cyan-500/30',
        swatch: 'bg-cyan-500',
    },
    {
        value: 'lime',
        label: 'Lime',
        chip: 'bg-lime-100 text-lime-800 ring-lime-200 dark:bg-lime-500/20 dark:text-lime-100 dark:ring-lime-500/30',
        swatch: 'bg-lime-500',
    },
];

const COLOR_BY_VALUE = Object.fromEntries(
    LABEL_COLORS.map((c) => [c.value, c]),
);

// Returns the chip class string for a given color token. Falls back to
// a neutral outline so unknown tokens stay readable.
export function labelColorClass(value) {
    if (!value) return 'bg-card text-foreground ring-border';
    return (
        COLOR_BY_VALUE[value]?.chip ||
        'bg-card text-foreground ring-border'
    );
}

export function labelColorSwatch(value) {
    return COLOR_BY_VALUE[value]?.swatch || 'bg-slate-300';
}
