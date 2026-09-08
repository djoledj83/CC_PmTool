// Checkbox multi-select for picking which phase templates a new
// project should include. Used on the create-project dialog.
import { useMemo, useState } from 'react';
import { Check, ChevronDown, Layers, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

export default function PhasesMultiSelect({
    phases = [],
    value = [],
    onChange,
    disabled = false,
    loading = false,
    placeholder = 'Select phases',
    triggerClassName,
    align = 'start',
    width = 320,
}) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');

    const selectedSet = useMemo(() => new Set(value || []), [value]);
    const byId = useMemo(() => {
        const m = new Map();
        for (const p of phases) m.set(p.id, p);
        return m;
    }, [phases]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return phases;
        return phases.filter((p) => (p.name || '').toLowerCase().includes(q));
    }, [phases, search]);

    const toggle = (id) => {
        const next = new Set(selectedSet);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        onChange?.(Array.from(next));
    };

    const selectAll = () => {
        const merged = new Set(selectedSet);
        for (const p of filtered) merged.add(p.id);
        onChange?.(Array.from(merged));
    };

    const clear = () => onChange?.([]);

    const triggerLabel = (() => {
        if (selectedSet.size === 0) return placeholder;
        if (selectedSet.size === 1) {
            const p = byId.get(Array.from(selectedSet)[0]);
            return p?.name || '1 phase';
        }
        return `${selectedSet.size} phases`;
    })();

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={open}
                    disabled={disabled}
                    className={cn(
                        'w-full justify-between font-normal',
                        selectedSet.size === 0 && 'text-muted-foreground',
                        triggerClassName,
                    )}
                >
                    <span className="inline-flex min-w-0 items-center gap-2">
                        <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{triggerLabel}</span>
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Button>
            </PopoverTrigger>
            <PopoverContent align={align} className="p-0" style={{ width }}>
                <div className="border-b p-2">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search phases…"
                            className="h-8 pl-7 text-xs"
                        />
                    </div>
                </div>
                <div className="max-h-72 overflow-y-auto">
                    {loading ? (
                        <div className="p-4 text-center text-xs text-muted-foreground">
                            Loading phases…
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="p-4 text-center text-xs text-muted-foreground">
                            {phases.length === 0
                                ? 'No phase templates defined yet.'
                                : 'No phases match your search.'}
                        </div>
                    ) : (
                        <ul className="py-1 text-xs">
                            {filtered.map((p) => {
                                const checked = selectedSet.has(p.id);
                                return (
                                    <li key={p.id}>
                                        <button
                                            type="button"
                                            onClick={() => toggle(p.id)}
                                            className={cn(
                                                'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent',
                                                checked && 'bg-accent/50',
                                            )}
                                        >
                                            <span
                                                className={cn(
                                                    'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                                    checked
                                                        ? 'border-primary bg-primary text-primary-foreground'
                                                        : 'border-input bg-background',
                                                )}
                                                aria-hidden
                                            >
                                                {checked && (
                                                    <Check className="h-3 w-3" />
                                                )}
                                            </span>
                                            <span className="truncate font-medium text-foreground">
                                                {p.name}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
                <div className="flex items-center justify-between border-t px-2 py-1.5">
                    <button
                        type="button"
                        onClick={selectAll}
                        className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    >
                        Select all
                    </button>
                    <button
                        type="button"
                        onClick={clear}
                        className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    >
                        Clear
                    </button>
                </div>
            </PopoverContent>
        </Popover>
    );
}
