// Clickable icon choices for a ticket's category and priority — clearer
// and quicker than a dropdown. Shared by the portal raise form and the
// resolver "New ticket" dialog.
import { cn } from '@/lib/utils';
import {
    AlertTriangle,
    Bug,
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
        Icon: AlertTriangle,
        active: 'border-rose-500 bg-rose-500/30 text-rose-700 dark:text-rose-300 shadow-sm',
    },
    {
        value: 'PROBLEM',
        label: 'Problem',
        Icon: Bug,
        active: 'border-amber-500 bg-amber-500/30 text-amber-700 dark:text-amber-300 shadow-sm',
    },
    {
        value: 'QUESTION',
        label: 'Question',
        Icon: HelpCircle,
        active: 'border-sky-500 bg-sky-500/30 text-sky-700 dark:text-sky-300 shadow-sm',
    },
    {
        value: 'REQUEST',
        label: 'Request',
        Icon: Inbox,
        active: 'border-violet-500 bg-violet-500/30 text-violet-700 dark:text-violet-300 shadow-sm',
    },
];

export const PRIORITY_CHOICES = [
    {
        value: 'LOW',
        label: 'Low',
        Icon: ArrowDown,
        active: 'border-slate-500 bg-slate-500/30 text-slate-700 dark:text-slate-300 shadow-sm',
    },
    {
        value: 'NORMAL',
        label: 'Normal',
        Icon: Minus,
        active: 'border-sky-500 bg-sky-500/30 text-sky-700 dark:text-sky-300 shadow-sm',
    },
    {
        value: 'HIGH',
        label: 'High',
        Icon: ArrowUp,
        active: 'border-amber-500 bg-amber-500/30 text-amber-700 dark:text-amber-300 shadow-sm',
    },
    {
        value: 'URGENT',
        label: 'Urgent',
        Icon: Flame,
        active: 'border-rose-500 bg-rose-500/30 text-rose-700 dark:text-rose-300 shadow-sm',
    },
];

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
