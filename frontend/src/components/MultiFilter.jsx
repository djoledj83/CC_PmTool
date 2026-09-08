import { Check, ChevronDown, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Multi-select filter dropdown with checkbox-style options. Empty
// `values` means "no filter".
export function MultiFilter({ label, values, onChange, options }) {
    const selected = values.length;
    const toggle = (v) => {
        const set = new Set(values);
        if (set.has(v)) set.delete(v);
        else set.add(v);
        onChange(Array.from(set));
    };
    const summary =
        selected === 0
            ? `Any ${label.toLowerCase()}`
            : selected === 1
              ? options.find((o) => o.value === values[0])?.label || values[0]
              : `${label}: ${selected}`;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(
                        'h-8 min-w-[130px] justify-between gap-2 px-3 text-xs font-normal',
                        selected > 0 && 'border-primary/50 bg-primary/5',
                    )}
                >
                    <span className="truncate">{summary}</span>
                    {selected > 0 ? (
                        <span
                            role="button"
                            tabIndex={-1}
                            onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onChange([]);
                            }}
                            className="-mr-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={`Clear ${label} filter`}
                            title={`Clear ${label} filter`}
                        >
                            <X className="h-3.5 w-3.5" />
                        </span>
                    ) : (
                        <ChevronDown className="h-4 w-4 opacity-60" />
                    )}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>{label}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {options.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        No options
                    </p>
                ) : (
                    options.map((opt) => {
                        const checked = values.includes(opt.value);
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                onClick={() => toggle(opt.value)}
                                className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent focus:bg-accent"
                            >
                                <span
                                    className={cn(
                                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                        checked
                                            ? 'border-primary bg-primary text-primary-foreground'
                                            : 'border-muted-foreground/40',
                                    )}
                                >
                                    {checked && <Check className="h-3 w-3" />}
                                </span>
                                <span className="truncate">{opt.label}</span>
                            </button>
                        );
                    })
                )}
                {selected > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => onChange([])}>
                            <X className="h-4 w-4" />
                            Clear selection
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
