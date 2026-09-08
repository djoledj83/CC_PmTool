// Multi-select dropdown for filtering by tasks. Used on the Time
// tracking page (both Charts tab and All-users tab) so the user can
// narrow stats / spreadsheet entries to any combination of tasks.
//
// UX:
//   - Trigger button reads "Tasks" when nothing is selected,
//     "Tasks (3)" when 3 are picked, or "T-0023 + 2 more" when there's
//     room to preview.
//   - Popover contains a search input (filters by code OR title), a
//     scrollable checkbox list, and a footer with "Select all" /
//     "Clear" shortcuts. Selecting "Select all" only selects whatever
//     is currently visible (after the search filter), which lets you
//     bulk-pick all tasks of a given project.
//   - Selected ids are surfaced both as the controlled `value` prop
//     and as small inline chips beneath the trigger so the user always
//     sees what's active without re-opening the popover.
//
// The component is fully controlled — the parent owns the selected
// id array and the option list. Loading the task list is up to the
// caller (typically scoped to the current project / user filter).
import { useMemo, useState } from 'react';
import { Check, ChevronDown, ListChecks, Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

function taskLabel(t) {
    const code = t.code ? `${t.code} · ` : '';
    return `${code}${t.title || 'Untitled task'}`;
}

export default function TasksMultiSelect({
    tasks = [],
    value = [],
    onChange,
    disabled = false,
    loading = false,
    placeholder = 'All tasks',
    triggerClassName,
    maxVisibleChips = 0,
    align = 'start',
    width = 360,
}) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');

    const selectedSet = useMemo(() => new Set(value || []), [value]);
    const byId = useMemo(() => {
        const m = new Map();
        for (const t of tasks) m.set(t.id, t);
        return m;
    }, [tasks]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return tasks;
        return tasks.filter((t) => {
            const code = (t.code || '').toLowerCase();
            const title = (t.title || '').toLowerCase();
            const project = (t.projectName || '').toLowerCase();
            return (
                code.includes(q) || title.includes(q) || project.includes(q)
            );
        });
    }, [tasks, search]);

    const toggle = (id) => {
        const next = new Set(selectedSet);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        onChange?.(Array.from(next));
    };

    const selectAll = () => {
        // Select-all only selects what's currently visible (post-
        // search) so the user can bulk-pick a project's tasks etc.
        const merged = new Set(selectedSet);
        for (const t of filtered) merged.add(t.id);
        onChange?.(Array.from(merged));
    };

    const clear = () => onChange?.([]);

    const triggerLabel = (() => {
        if (selectedSet.size === 0) return placeholder;
        if (selectedSet.size === 1) {
            const t = byId.get(Array.from(selectedSet)[0]);
            return t ? taskLabel(t) : '1 task';
        }
        return `${selectedSet.size} tasks`;
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
                            <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="truncate">{triggerLabel}</span>
                        </span>
                        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent
                    align={align}
                    className="p-0"
                    style={{ width }}
                >
                    <div className="border-b p-2">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search tasks…"
                                className="h-8 pl-7 text-xs"
                            />
                        </div>
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                        {loading ? (
                            <div className="p-4 text-center text-xs text-muted-foreground">
                                Loading tasks…
                            </div>
                        ) : filtered.length === 0 ? (
                            <div className="p-4 text-center text-xs text-muted-foreground">
                                {tasks.length === 0
                                    ? 'No tasks available for the current scope.'
                                    : 'No tasks match your search.'}
                            </div>
                        ) : (
                            <ul className="py-1 text-xs">
                                {filtered.map((t) => {
                                    const checked = selectedSet.has(t.id);
                                    return (
                                        <li key={t.id}>
                                            <button
                                                type="button"
                                                onClick={() => toggle(t.id)}
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
                                                        {t.code && (
                                                            <span className="shrink-0 whitespace-nowrap font-mono text-[10px] uppercase text-muted-foreground">
                                                                {t.code}
                                                            </span>
                                                        )}
                                                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                                                            {t.title ||
                                                                'Untitled task'}
                                                        </span>
                                                    </span>
                                                    {t.projectName && (
                                                        <span className="block truncate text-[10px] text-muted-foreground">
                                                            {t.projectName}
                                                        </span>
                                                    )}
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
                            {filtered.length !== tasks.length && (
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
                                {filtered.length !== tasks.length
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

            {/* Inline chips so the user always sees the selection
                without having to reopen the popover. Capped via
                maxVisibleChips (0 = no chip row, just the trigger
                count). */}
            {maxVisibleChips > 0 && selectedSet.size > 0 && (
                <div className="flex flex-wrap gap-1">
                    {Array.from(selectedSet)
                        .slice(0, maxVisibleChips)
                        .map((id) => {
                            const t = byId.get(id);
                            if (!t) return null;
                            return (
                                <span
                                    key={id}
                                    className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-[10px]"
                                >
                                    {t.code && (
                                        <span className="whitespace-nowrap font-mono uppercase text-muted-foreground">
                                            {t.code}
                                        </span>
                                    )}
                                    <span className="max-w-[140px] truncate">
                                        {t.title || 'Untitled'}
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
