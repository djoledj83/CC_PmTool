// A single-select dropdown with a type-to-filter search box. Use where a
// plain <Select> gets unwieldy because the option list is long (e.g.
// picking a project). `options` is [{ value, label }].
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

export function SearchableSelect({
    value,
    onChange,
    options = [],
    placeholder = 'Select…',
    searchPlaceholder = 'Search…',
    emptyText = 'No matches',
    className,
    contentClassName,
    disabled = false,
}) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    // Index of the keyboard-highlighted option.
    const [active, setActive] = useState(0);
    const listRef = useRef(null);

    const selected = options.find((o) => o.value === value) || null;
    const query = q.trim().toLowerCase();
    const filtered = query
        ? options.filter((o) => (o.label || '').toLowerCase().includes(query))
        : options;

    // Reset the highlight to the top whenever the list changes or reopens.
    useEffect(() => {
        setActive(0);
    }, [q, open]);

    // Keep the highlighted row visible as you arrow through the list.
    useEffect(() => {
        if (!open) return;
        const el = listRef.current?.querySelector('[data-active="true"]');
        if (el) el.scrollIntoView({ block: 'nearest' });
    }, [active, open]);

    const choose = (o) => {
        onChange?.(o.value);
        setOpen(false);
        setQ('');
    };

    const onSearchKeyDown = (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, filtered.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const o = filtered[active];
            if (o) choose(o);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setOpen(false);
        }
    };

    return (
        <Popover
            open={open}
            onOpenChange={(o) => {
                if (disabled) return;
                setOpen(o);
                if (!o) setQ('');
            }}
        >
            <PopoverTrigger asChild>
                <button
                    type="button"
                    disabled={disabled}
                    className={cn(
                        'flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-background px-2.5 text-xs',
                        disabled && 'cursor-not-allowed opacity-50',
                        className,
                    )}
                >
                    {selected ? (
                        <span className="flex min-w-0 items-center gap-2">
                            {selected.icon}
                            <span className="truncate">{selected.label}</span>
                        </span>
                    ) : (
                        <span className="truncate text-muted-foreground">
                            {placeholder}
                        </span>
                    )}
                    <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                className={cn(
                    'w-[--radix-popover-trigger-width] p-1',
                    contentClassName,
                )}
            >
                <div className="flex items-center gap-1.5 border-b px-2 pb-1.5">
                    <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <input
                        autoFocus
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        onKeyDown={onSearchKeyDown}
                        placeholder={searchPlaceholder}
                        className="h-7 w-full bg-transparent text-xs outline-none"
                    />
                </div>
                <div ref={listRef} className="max-h-56 overflow-y-auto pt-1">
                    {filtered.length === 0 ? (
                        <p className="px-2 py-2 text-xs text-muted-foreground">
                            {emptyText}
                        </p>
                    ) : (
                        filtered.map((o, i) => (
                            <button
                                key={o.value}
                                type="button"
                                data-active={i === active}
                                onMouseEnter={() => setActive(i)}
                                onClick={() => choose(o)}
                                className={cn(
                                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs',
                                    i === active
                                        ? 'bg-accent'
                                        : 'hover:bg-accent',
                                )}
                            >
                                <Check
                                    className={cn(
                                        'h-3.5 w-3.5 shrink-0 text-primary',
                                        o.value === value
                                            ? 'opacity-100'
                                            : 'opacity-0',
                                    )}
                                />
                                {o.icon}
                                <span className="truncate">{o.label}</span>
                            </button>
                        ))
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}

export default SearchableSelect;
