// Clickable choices for a ticket's category and priority — clearer and
// quicker than a dropdown. Shared by the portal "Raise new ticket" form and
// the resolver "New ticket" dialog.
//   - <ChoiceCards> : the raise-form cards (icon, label, one-line hint)
//   - <ChoiceRow>   : the older compact chip row (kept for other callers)
import { cn } from '@/lib/utils';
import {
    AlertTriangle,
    Settings,
    HelpCircle,
    Inbox,
    ArrowDown,
    Minus,
    ArrowUp,
    Flame,
} from 'lucide-react';

export const CATEGORY_CHOICES = [
    {
        value: 'INCIDENT',
        label: 'Incident',
        hint: 'Service disruption or system down',
        Icon: AlertTriangle,
        active: 'border-rose-500 bg-rose-500/30 text-rose-700 dark:text-rose-300 shadow-sm',
        card: 'border-rose-400 bg-rose-500/10 text-rose-800 ring-1 ring-rose-400/40 dark:text-rose-200',
    },
    {
        value: 'PROBLEM',
        label: 'Problem',
        hint: 'Ongoing issue that needs investigation',
        Icon: Settings,
        active: 'border-amber-500 bg-amber-500/30 text-amber-700 dark:text-amber-300 shadow-sm',
        card: 'border-amber-400 bg-amber-500/10 text-amber-800 ring-1 ring-amber-400/40 dark:text-amber-200',
    },
    {
        value: 'QUESTION',
        label: 'Question',
        hint: 'Request for information or clarification',
        Icon: HelpCircle,
        active: 'border-sky-500 bg-sky-500/30 text-sky-700 dark:text-sky-300 shadow-sm',
        card: 'border-sky-400 bg-sky-500/10 text-sky-800 ring-1 ring-sky-400/40 dark:text-sky-200',
    },
    {
        value: 'REQUEST',
        label: 'Request',
        hint: 'New request or change',
        Icon: Inbox,
        active: 'border-violet-500 bg-violet-500/30 text-violet-700 dark:text-violet-300 shadow-sm',
        card: 'border-violet-400 bg-violet-500/10 text-violet-800 ring-1 ring-violet-400/40 dark:text-violet-200',
    },
];

export const PRIORITY_CHOICES = [
    {
        value: 'LOW',
        label: 'Low',
        hint: 'Non-urgent',
        Icon: ArrowDown,
        active: 'border-slate-500 bg-slate-500/30 text-slate-700 dark:text-slate-300 shadow-sm',
        card: 'border-slate-400 bg-slate-500/10 text-slate-800 ring-1 ring-slate-400/40 dark:text-slate-200',
    },
    {
        value: 'NORMAL',
        label: 'Normal',
        hint: 'Normal impact',
        Icon: Minus,
        active: 'border-sky-500 bg-sky-500/30 text-sky-700 dark:text-sky-300 shadow-sm',
        card: 'border-sky-400 bg-sky-500/10 text-sky-800 ring-1 ring-sky-400/40 dark:text-sky-200',
    },
    {
        value: 'HIGH',
        label: 'High',
        hint: 'High impact',
        Icon: ArrowUp,
        active: 'border-amber-500 bg-amber-500/30 text-amber-700 dark:text-amber-300 shadow-sm',
        card: 'border-amber-400 bg-amber-500/10 text-amber-800 ring-1 ring-amber-400/40 dark:text-amber-200',
    },
    {
        value: 'URGENT',
        label: 'Urgent',
        hint: 'Critical impact',
        Icon: Flame,
        // The flame stays red even when not selected (as in the design).
        iconIdle: 'text-rose-500',
        active: 'border-rose-500 bg-rose-500/30 text-rose-700 dark:text-rose-300 shadow-sm',
        card: 'border-rose-400 bg-rose-500/10 text-rose-800 ring-1 ring-rose-400/40 dark:text-rose-200',
    },
];

// Raise-form cards: icon, label and a one-line hint. One selection.
export function ChoiceCards({ value, onChange, choices, className, label }) {
    return (
        <div
            role="radiogroup"
            aria-label={label}
            className={cn('grid grid-cols-2 gap-2 sm:grid-cols-4', className)}
        >
            {choices.map((c) => {
                const Icon = c.Icon;
                const on = value === c.value;
                return (
                    <button
                        key={c.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => onChange(c.value)}
                        className={cn(
                            'flex min-w-0 flex-col items-center gap-1 rounded-xl border px-2 py-3 text-center transition-colors',
                            on
                                ? c.card
                                : 'bg-card text-foreground hover:border-primary/30 hover:bg-accent/50',
                        )}
                    >
                        <Icon
                            className={cn(
                                'h-5 w-5',
                                !on && (c.iconIdle || 'text-foreground/70'),
                            )}
                        />
                        <span className="text-sm font-semibold">{c.label}</span>
                        {c.hint && (
                            <span
                                className={cn(
                                    'text-[11px] leading-tight',
                                    on ? 'opacity-80' : 'text-muted-foreground',
                                )}
                            >
                                {c.hint}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}

// A row of selectable icon+label chips. One selection (radio-like).
export function ChoiceRow({ value, onChange, choices }) {
    return (
        <div className="flex flex-wrap gap-2 rounded-lg bg-muted/60 p-4">
            {choices.map((c) => {
                const Icon = c.Icon;
                const on = value === c.value;
                return (
                    <button
                        key={c.value}
                        type="button"
                        onClick={() => onChange(c.value)}
                        className={cn(
                            'flex flex-1 min-w-[72px] flex-col items-center gap-1 rounded-md border px-2 py-2 text-xs font-medium transition-colors',
                            on
                                ? c.active
                                : 'border-transparent bg-background text-muted-foreground hover:text-foreground',
                        )}
                    >
                        <Icon className="h-4 w-4" />
                        {c.label}
                    </button>
                );
            })}
        </div>
    );
}

export default ChoiceRow;
