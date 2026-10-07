// Multi-select dropdown for filtering by projects. Used on the Time
// tracking Charts tab so the user can narrow stats to any combination of
// projects. Mirrors the TasksMultiSelect pattern (search + checkbox list
// + select-all / clear) so the two filters feel identical.
//
// Fully controlled — the parent owns the selected id array and the option
// list.
import { useMemo, useState } from 'react';
import { Check, ChevronDown, FolderKanban, Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

function projectLabel(p) {
    const code = p.code ? `${p.code} · ` : '';
    return `${code}${p.name || 'Untitled project'}`;
}

export default function ProjectsMultiSelect({
    projects = [],
    value = [],
    onChange,
    disabled = false,
    loading = false,
    placeholder = 'All projects',
    triggerClassName,
    maxVisibleChips = 0,
    align = 'start',
    width = 320,
}) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');

    const selectedSet = useMemo(() => new Set(value || []), [value]);
    const byId = useMemo(() => {
        const m = new Map();
        for (const p of projects) m.set(p.id, p);
        return m;
    }, [projects]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return projects;
        return projects.filter((p) => {
            const code = (p.code || '').toLowerCase();
            const name = (p.name || '').toLowerCase();
            return code.includes(q) || name.includes(q);
        });
    }, [projects, search]);

    const toggle = (id) => {
        const next = new Set(selectedSet);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        onChange?.(Array.from(next));
    };

    const selectAll = () => {
        // Select-all only picks what's currently visible (post-search).
        const merged = new Set(selectedSet);
        for (const p of filtered) merged.add(p.id);
        onChange?.(Array.from(merged));
    };

    const clear = () => onChange?.([]);

    const triggerLabel = (() => {
        if (selectedSet.size === 0) return placeholder;
        if (selectedSet.size === 1) {
            const p = byId.get(Array.from(selectedSet)[0]);
            return p ? projectLabel(p) : '1 project';
        }
        return `${selectedSet.size} projects`;
    })();

    return (
        <div className="space-y-1.5">
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
                            <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                                placeholder="Search projects…"
                                className="h-8 pl-7 text-xs"
                            />
                        </div>
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                        {loading ? (
                            <div className="p-4 text-center text-xs text-muted-foreground">
                                Loading projects…
                            </div>
                        ) : filtered.length === 0 ? (
                            <div className="p-4 text-center text-xs text-muted-foreground">
                                {projects.length === 0
                                    ? 'No projects available.'
                                    : 'No projects match your search.'}
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
                                                    'flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent',
                                                    checked && 'bg-accent/50',
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border',
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
                                                <span className="min-w-0 flex-1">
                                                    <span className="flex items-baseline gap-1.5">
                                                        {p.code && (
                                                            <span className="shrink-0 whitespace-nowrap font-mono text-[10px] uppercase text-muted-foreground">
                                                                {p.code}
                                                            </span>
                                                        )}
                                                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                                                            {p.name ||
                                                                'Untitled project'}
                                                        </span>
                                                    </span>
                                                </span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                    <div className="flex items-center justify-between border-t bg-muted/30 px-2 py-1.5 text-[11px]">
                        <span className="text-muted-foreground">
                            {selectedSet.size} selected
                            {filtered.length !== projects.length && (
                                <> · {filtered.length} shown</>
                            )}
                        </span>
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={selectAll}
                                disabled={filtered.length === 0}
                                className="rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent"
                            >
                                Select all{' '}
                                {filtered.length !== projects.length
                                    ? `(${filtered.length})`
                                    : ''}
                            </button>
                            <button
                                type="button"
                                onClick={clear}
                                disabled={selectedSet.size === 0}
                                className="rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-accent disabled:text-muted-foreground disabled:hover:bg-transparent"
                            >
                                Clear
                            </button>
                        </div>
                    </div>
                </PopoverContent>
            </Popover>

            {maxVisibleChips > 0 && selectedSet.size > 0 && (
                <div className="flex flex-wrap gap-1">
                    {Array.from(selectedSet)
                        .slice(0, maxVisibleChips)
                        .map((id) => {
                            const p = byId.get(id);
                            if (!p) return null;
                            return (
                                <span
                                    key={id}
                                    className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-[10px]"
                                >
                                    {p.code && (
                                        <span className="whitespace-nowrap font-mono uppercase text-muted-foreground">
                                            {p.code}
                                        </span>
                                    )}
                                    <span className="max-w-[140px] truncate">
                                        {p.name || 'Untitled'}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => toggle(id)}
                                        className="rounded-full text-muted-foreground hover:text-foreground"
                                        aria-label="Remove"
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                </span>
                            );
                        })}
                    {selectedSet.size > maxVisibleChips && (
                        <span className="rounded-full border bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">
                            +{selectedSet.size - maxVisibleChips} more
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
