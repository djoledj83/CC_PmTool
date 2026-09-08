// A compact multi-select: a dropdown trigger that opens a checkbox list.
// Saves vertical space vs an inline checkbox grid. `options` is
// [{ id, label }]; `value` is an array of selected ids.
import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

export function MultiSelectDropdown({
    options = [],
    value = [],
    onChange,
    placeholder = 'Select…',
    emptyText = 'No options',
}) {
    const [open, setOpen] = useState(false);
    const selected = new Set(value);
    const toggle = (id) =>
        onChange(
            selected.has(id)
                ? value.filter((v) => v !== id)
                : [...value, id],
        );

    const labels = options
        .filter((o) => selected.has(o.id))
        .map((o) => o.label);
    const summary =
        labels.length === 0
            ? placeholder
            : labels.length <= 2
              ? labels.join(', ')
              : `${labels.length} selected`;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm"
                >
                    <span
                        className={cn(
                            'truncate',
                            labels.length === 0 && 'text-muted-foreground',
                        )}
                    >
                        {summary}
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                className="w-[--radix-popover-trigger-width] p-1"
            >
                {options.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-muted-foreground">
                        {emptyText}
                    </p>
                ) : (
                    <div className="max-h-60 overflow-y-auto">
                        {options.map((o) => {
                            const on = selected.has(o.id);
                            return (
                                <button
                                    key={o.id}
                                    type="button"
                                    onClick={() => toggle(o.id)}
                                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                                >
                                    <span
                                        className={cn(
                                            'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                            on
                                                ? 'border-primary bg-primary text-primary-foreground'
                                                : 'border-input',
                                        )}
                                    >
                                        {on && <Check className="h-3 w-3" />}
                                    </span>
                                    <span className="truncate">{o.label}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}

export default MultiSelectDropdown;
