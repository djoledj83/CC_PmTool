import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    FileText,
    FolderKanban,
    Layers,
    ListTodo,
    MessageSquare,
    Paperclip,
    Search,
    StickyNote,
    Tag,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { labelColorClass } from '@/lib/labelColors';
import { parseProjectLabels } from '@/lib/projectLabels';
import { Badge } from '@/components/ui/badge';

// Icons + display strings for each match-source the backend returns.
// Keeping this in one place makes adding a new source (e.g. comments)
// a one-line addition.
const MATCH_TYPE_META = {
    project: {
        label: 'Project',
        icon: FolderKanban,
        tone: 'text-sky-600 dark:text-sky-300',
    },
    task: {
        label: 'Task',
        icon: ListTodo,
        tone: 'text-amber-600 dark:text-amber-300',
    },
    subtask: {
        label: 'Subtask',
        icon: ListTodo,
        tone: 'text-indigo-600 dark:text-indigo-300',
    },
    note: {
        label: 'Note',
        icon: StickyNote,
        tone: 'text-emerald-600 dark:text-emerald-300',
    },
    file: {
        label: 'File',
        icon: Paperclip,
        tone: 'text-rose-600 dark:text-rose-300',
    },
    phase: {
        label: 'Phase',
        icon: Layers,
        tone: 'text-violet-600 dark:text-violet-300',
    },
    status: {
        label: 'Status',
        icon: Tag,
        tone: 'text-slate-600 dark:text-slate-300',
    },
    priority: {
        label: 'Priority',
        icon: Tag,
        tone: 'text-slate-600 dark:text-slate-300',
    },
};

const STATUS_BADGE = {
    TODO: { label: 'To do', cls: 'bg-slate-100 text-slate-700 dark:bg-slate-500/20' },
    IN_PROGRESS: { label: 'In progress', cls: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20' },
    DONE: { label: 'Done', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20' },
    ON_HOLD: { label: 'On hold', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20' },
};

// Highlights the substring `q` inside `text` so the matched portion of
// each snippet stands out without us having to send any markup over
// the wire.
function highlight(text, q) {
    if (!text || !q) return text || '';
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return text;
    return (
        <>
            {text.slice(0, i)}
            <mark className="rounded bg-amber-200/70 px-0.5 text-foreground dark:bg-amber-500/40">
                {text.slice(i, i + q.length)}
            </mark>
            {text.slice(i + q.length)}
        </>
    );
}

export function GlobalSearch({ open, onOpenChange }) {
    const [q, setQ] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef(null);
    const debounceRef = useRef(null);
    const navigate = useNavigate();

    // Reset on open: clear the previous query so the modal starts fresh
    // and focus the input straight away (Cmd+K should feel instant).
    useEffect(() => {
        if (!open) return;
        setQ('');
        setResults([]);
        setActiveIndex(0);
        setError(null);
        // setTimeout because the input isn't mounted on the first paint
        // when the dialog flips from closed to open.
        const t = setTimeout(() => inputRef.current?.focus(), 30);
        return () => clearTimeout(t);
    }, [open]);

    // Debounced fetch. Cancels in-flight requests by simply ignoring
    // their results when a newer query has been issued.
    useEffect(() => {
        if (!open) return;
        const trimmed = q.trim();
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (trimmed.length === 0) {
            setResults([]);
            setLoading(false);
            return;
        }
        setLoading(true);
        const myToken = Symbol('req');
        debounceRef.current = setTimeout(async () => {
            // Capture the request "owner" so a stale response can't
            // overwrite a newer one.
            inputRef.current?.setAttribute('data-token', String(myToken));
            try {
                const { data } = await api.get('/search', {
                    params: { q: trimmed },
                });
                if (
                    inputRef.current?.getAttribute('data-token') ===
                    String(myToken)
                ) {
                    setResults(data.results || []);
                    setActiveIndex(0);
                    setError(null);
                }
            } catch (err) {
                if (
                    inputRef.current?.getAttribute('data-token') ===
                    String(myToken)
                ) {
                    setError(
                        err.response?.data?.error || 'Search failed',
                    );
                    setResults([]);
                }
            } finally {
                if (
                    inputRef.current?.getAttribute('data-token') ===
                    String(myToken)
                ) {
                    setLoading(false);
                }
            }
        }, 200);
        return () => clearTimeout(debounceRef.current);
    }, [q, open]);

    // Flat list of {project, match} we can navigate with arrow keys.
    // First entry per project navigates to the project itself; the
    // remaining entries (one per match) deep-link to that match's
    // task/note/etc. when possible.
    const flatItems = useMemo(() => {
        const items = [];
        for (const r of results) {
            // Project header row (always present, matches[0] used for hint)
            items.push({
                kind: 'project',
                project: r.project,
                primaryMatch: r.matches[0],
                allMatches: r.matches,
                href: `/projects/${r.project.id}`,
            });
            // Inline rows for each task/subtask/note/file match so users
            // can jump straight to the matched item without scrolling
            // through the project first.
            for (const m of r.matches) {
                if (m.type === 'task' || m.type === 'subtask') {
                    items.push({
                        kind: 'match',
                        project: r.project,
                        match: m,
                        href: `/projects/${r.project.id}#task-${m.taskId}`,
                    });
                }
            }
        }
        return items;
    }, [results]);

    const goTo = (item) => {
        if (!item) return;
        navigate(item.href);
        onOpenChange(false);
    };

    const onKeyDown = (e) => {
        if (e.key === 'Escape') {
            onOpenChange(false);
            return;
        }
        if (!flatItems.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            goTo(flatItems[activeIndex]);
        }
    };

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
            role="dialog"
            aria-modal="true"
            aria-label="Search projects"
            onMouseDown={(e) => {
                // Click on backdrop -> close. Stop clicks inside the
                // panel from bubbling so they don't dismiss it.
                if (e.target === e.currentTarget) onOpenChange(false);
            }}
        >
            <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" />
            <div
                className="relative z-10 flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-2 border-b px-3">
                    <Search className="h-4 w-4 text-muted-foreground" />
                    <input
                        ref={inputRef}
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        onKeyDown={onKeyDown}
                        placeholder="Search anywhere — name, description, label, phase, task, note, file…"
                        className="flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
                    />
                    <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-block">
                        Esc
                    </kbd>
                    <button
                        type="button"
                        onClick={() => onOpenChange(false)}
                        className="ml-1 flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                        aria-label="Close search"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="max-h-[60vh] overflow-y-auto">
                    {loading && q.trim() && (
                        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                            Searching…
                        </div>
                    )}
                    {!loading && error && (
                        <div className="px-4 py-6 text-center text-xs text-destructive">
                            {error}
                        </div>
                    )}
                    {!loading &&
                        !error &&
                        q.trim() &&
                        flatItems.length === 0 && (
                            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                                <Search className="h-8 w-8 text-muted-foreground" />
                                <p className="text-sm font-medium">
                                    No matches for “{q}”.
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    Try a different word or shorter query.
                                </p>
                            </div>
                        )}
                    {!loading && !q.trim() && (
                        <div className="px-4 py-10 text-center text-xs text-muted-foreground">
                            Type to search across project names,
                            descriptions, labels, phases, tasks, subtasks,
                            notes and files. Use{' '}
                            <kbd className="rounded border bg-muted px-1 text-[10px]">
                                ↑
                            </kbd>{' '}
                            <kbd className="rounded border bg-muted px-1 text-[10px]">
                                ↓
                            </kbd>{' '}
                            to navigate and{' '}
                            <kbd className="rounded border bg-muted px-1 text-[10px]">
                                Enter
                            </kbd>{' '}
                            to open.
                        </div>
                    )}
                    {!loading && flatItems.length > 0 && (
                        <ul className="py-1">
                            {flatItems.map((item, idx) => {
                                const active = idx === activeIndex;
                                return (
                                    <li key={`${item.href}-${idx}`}>
                                        {item.kind === 'project' ? (
                                            <ProjectResultRow
                                                item={item}
                                                q={q.trim()}
                                                active={active}
                                                onActivate={() =>
                                                    setActiveIndex(idx)
                                                }
                                                onClick={() => goTo(item)}
                                            />
                                        ) : (
                                            <MatchResultRow
                                                item={item}
                                                q={q.trim()}
                                                active={active}
                                                onActivate={() =>
                                                    setActiveIndex(idx)
                                                }
                                                onClick={() => goTo(item)}
                                            />
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>

                <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                        <kbd className="rounded border bg-card px-1">↑</kbd>
                        <kbd className="rounded border bg-card px-1">↓</kbd>
                        navigate
                    </span>
                    <span className="flex items-center gap-1">
                        <kbd className="rounded border bg-card px-1">Enter</kbd>
                        open
                    </span>
                    <span className="flex items-center gap-1">
                        <kbd className="rounded border bg-card px-1">Esc</kbd>
                        close
                    </span>
                </div>
            </div>
        </div>
    );
}

function ProjectResultRow({ item, q, active, onActivate, onClick }) {
    const status = STATUS_BADGE[item.project.status] || STATUS_BADGE.TODO;
    const m = item.primaryMatch;
    const meta = m ? MATCH_TYPE_META[m.type] : null;
    const MetaIcon = meta?.icon;
    return (
        <button
            type="button"
            onMouseEnter={onActivate}
            onClick={onClick}
            className={cn(
                'flex w-full items-start gap-3 px-3 py-2 text-left transition-colors',
                active ? 'bg-accent' : 'hover:bg-accent/60',
            )}
        >
            <FolderKanban className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-300" />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    {item.project.code && (
                        <span
                            className="shrink-0 rounded border border-border bg-muted/60 px-1 py-px font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
                            title="Project code"
                        >
                            {highlight(item.project.code, q)}
                        </span>
                    )}
                    <span className="truncate text-sm font-semibold">
                        {highlight(item.project.name, q)}
                    </span>
                    <span
                        className={cn(
                            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                            status.cls,
                        )}
                    >
                        {status.label}
                    </span>
                    {parseProjectLabels(item.project).map((tag, i) => (
                        <span
                            key={`${tag.text}-${i}`}
                            className={cn(
                                'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1',
                                labelColorClass(tag.color),
                            )}
                        >
                            {tag.text}
                        </span>
                    ))}
                </div>
                {m && (
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        {MetaIcon && (
                            <MetaIcon
                                className={cn('h-3 w-3', meta.tone)}
                            />
                        )}
                        <span className="font-medium">
                            {meta?.label || m.type}:
                        </span>
                        <span className="truncate">
                            {highlight(m.snippet || '', q)}
                        </span>
                        {item.allMatches.length > 1 && (
                            <Badge
                                variant="outline"
                                className="ml-auto shrink-0 text-[10px]"
                            >
                                +{item.allMatches.length - 1} more
                            </Badge>
                        )}
                    </div>
                )}
            </div>
        </button>
    );
}

function MatchResultRow({ item, q, active, onActivate, onClick }) {
    const m = item.match;
    const meta = MATCH_TYPE_META[m.type] || MATCH_TYPE_META.task;
    const Icon = meta.icon || FileText;
    return (
        <button
            type="button"
            onMouseEnter={onActivate}
            onClick={onClick}
            className={cn(
                'flex w-full items-center gap-3 border-l-2 border-transparent px-3 py-1.5 pl-9 text-left text-xs transition-colors',
                active
                    ? 'border-l-primary bg-accent'
                    : 'hover:border-l-primary/40 hover:bg-accent/40',
            )}
        >
            <Icon className={cn('h-3.5 w-3.5 shrink-0', meta.tone)} />
            <span className="font-medium text-muted-foreground">
                {meta.label}:
            </span>
            <span className="min-w-0 flex-1 truncate">
                {highlight(m.snippet || '', q)}
            </span>
            <MessageSquare className="hidden h-3 w-3 text-muted-foreground sm:block" />
            <span className="hidden truncate text-muted-foreground sm:inline">
                in{' '}
                {item.project.code
                    ? `${item.project.code} · ${item.project.name}`
                    : item.project.name}
            </span>
        </button>
    );
}
