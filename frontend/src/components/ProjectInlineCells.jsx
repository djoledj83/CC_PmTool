import { useEffect, useMemo, useRef, useState } from 'react';
import { format, isValid, parseISO } from 'date-fns';
import { Calendar, Check, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { labelColorSwatch } from '@/lib/labelColors';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

// Inline-edit cells used by the Projects list. Each one calls
// `onSaved(updatedProject)` after a successful PATCH so the page can
// merge the new row back into its state without refetching.
//
// A cell becomes interactive only when `editable` is true. Otherwise
// it falls back to the same read-only rendering used elsewhere.

function stop(e) {
    // Project rows navigate on click — cells must swallow their own
    // events so opening a popover or typing into a date input does
    // not also push the user into project detail.
    e.stopPropagation();
}

async function patchProject(projectId, payload) {
    const { data } = await api.patch(`/projects/${projectId}`, payload);
    return data.project;
}

function formatDateLabel(value) {
    if (!value) return '—';
    try {
        return format(typeof value === 'string' ? parseISO(value) : value, 'MMM d, yyyy');
    } catch {
        return '—';
    }
}

function toInputDate(value) {
    if (!value) return '';
    try {
        const d = typeof value === 'string' ? parseISO(value) : value;
        if (!isValid(d)) return '';
        return format(d, 'yyyy-MM-dd');
    } catch {
        return '';
    }
}

// Generic select-style inline editor. Renders the current label as a
// trigger; opens a popover with a checkable list. `options` is
// [{ value, label, badgeClass?, swatchClass? }].
function InlineSelect({
    triggerLabel,
    triggerExtraClass,
    options,
    value,
    onChange,
    align = 'start',
    width = 'w-56',
    disabled = false,
    placeholder = '—',
    saving = false,
}) {
    const [open, setOpen] = useState(false);
    return (
        <Popover open={open} onOpenChange={setOpen} modal>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    onClick={stop}
                    disabled={disabled || saving}
                    className={cn(
                        'group inline-flex max-w-full items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 text-left transition-colors',
                        !disabled &&
                            'hover:border-border hover:bg-accent/60 focus:border-border focus:bg-accent/60 focus:outline-none',
                        disabled && 'cursor-not-allowed opacity-80',
                        saving && 'opacity-60',
                        triggerExtraClass,
                    )}
                >
                    <span className="min-w-0 truncate">
                        {triggerLabel || (
                            <span className="text-muted-foreground">
                                {placeholder}
                            </span>
                        )}
                    </span>
                    {!disabled && (
                        <ChevronDown className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
                    )}
                </button>
            </PopoverTrigger>
            <PopoverContent
                align={align}
                className={cn('p-1', width)}
                onClick={stop}
                onInteractOutside={stop}
            >
                <div className="max-h-72 overflow-y-auto">
                    {options.length === 0 ? (
                        <p className="px-2 py-2 text-xs text-muted-foreground">
                            No options
                        </p>
                    ) : (
                        options.map((opt) => {
                            const selected = opt.value === value;
                            return (
                                <button
                                    key={opt.value ?? '__none__'}
                                    type="button"
                                    onClick={(e) => {
                                        stop(e);
                                        setOpen(false);
                                        if (opt.value !== value) {
                                            onChange(opt.value);
                                        }
                                    }}
                                    className={cn(
                                        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none',
                                        selected && 'bg-accent/60',
                                    )}
                                >
                                    {opt.swatch}
                                    <span className="flex-1 truncate">
                                        {opt.label}
                                    </span>
                                    {selected && (
                                        <Check className="h-3.5 w-3.5 text-primary" />
                                    )}
                                </button>
                            );
                        })
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}

export function InlineStatusCell({
    project,
    statuses,
    findStatus,
    fallbackMap,
    editable,
    onSaved,
}) {
    const [saving, setSaving] = useState(false);
    const current =
        findStatus?.(project.status) ||
        fallbackMap[project.status] ||
        fallbackMap.TODO;

    const apply = async (next) => {
        setSaving(true);
        try {
            const updated = await patchProject(project.id, { status: next });
            onSaved?.(updated);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not change status');
        } finally {
            setSaving(false);
        }
    };

    const trigger = (
        <Badge variant={current.badge} className="cursor-pointer">
            {current.label}
        </Badge>
    );

    if (!editable) return trigger;

    return (
        <InlineSelect
            triggerLabel={trigger}
            triggerExtraClass="px-1 py-0"
            options={statuses.map((s) => ({
                value: s.value,
                label: s.label,
                swatch: (
                    <span
                        className={cn(
                            'h-2.5 w-2.5 shrink-0 rounded-full',
                            // Colour comes from the admin-managed status
                            // (`.color` token) so custom statuses get a
                            // matching dot instead of a blank swatch.
                            labelColorSwatch(s.color),
                        )}
                    />
                ),
            }))}
            value={project.status}
            onChange={apply}
            saving={saving}
        />
    );
}

export function InlinePriorityCell({
    project,
    priorities,
    findPriority,
    fallbackMap,
    editable,
    onSaved,
}) {
    const [saving, setSaving] = useState(false);
    const current =
        findPriority(project.priority) ||
        fallbackMap[project.priority] ||
        fallbackMap.MEDIUM;

    const apply = async (next) => {
        setSaving(true);
        try {
            const updated = await patchProject(project.id, { priority: next });
            onSaved?.(updated);
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not change priority',
            );
        } finally {
            setSaving(false);
        }
    };

    const trigger = (
        <Badge variant={current.badge} className="cursor-pointer">
            {current.label}
        </Badge>
    );

    if (!editable) return trigger;

    return (
        <InlineSelect
            triggerLabel={trigger}
            triggerExtraClass="px-1 py-0"
            options={priorities.map((p) => ({
                value: p.value,
                label: p.label,
            }))}
            value={project.priority}
            onChange={apply}
            saving={saving}
        />
    );
}

// Phases are not in the projects list payload, so we fetch them on
// demand when the popover first opens.
export function InlinePhaseCell({ project, editable, onSaved }) {
    const [saving, setSaving] = useState(false);
    const [phases, setPhases] = useState(null);
    const [loading, setLoading] = useState(false);
    const fetched = useRef(false);

    const ensurePhases = async () => {
        if (fetched.current) return;
        fetched.current = true;
        setLoading(true);
        try {
            const { data } = await api.get('/phases', {
                params: { projectId: project.id },
            });
            setPhases(data.phases || []);
        } catch {
            setPhases([]);
        } finally {
            setLoading(false);
        }
    };

    const apply = async (next) => {
        setSaving(true);
        try {
            const updated = await patchProject(project.id, {
                phase: next || null,
            });
            onSaved?.(updated);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not change phase');
        } finally {
            setSaving(false);
        }
    };

    const triggerLabel = project.phase || (
        <span className="text-muted-foreground">No phase</span>
    );

    if (!editable) {
        return (
            <span className="text-muted-foreground">{project.phase || '—'}</span>
        );
    }

    return (
        <Popover modal onOpenChange={(o) => o && ensurePhases()}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    onClick={stop}
                    disabled={saving}
                    className={cn(
                        'group inline-flex max-w-full items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 text-left text-sm transition-colors',
                        'hover:border-border hover:bg-accent/60 focus:border-border focus:bg-accent/60 focus:outline-none',
                        saving && 'opacity-60',
                    )}
                >
                    <span className="min-w-0 truncate">{triggerLabel}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                className="w-56 p-1"
                onClick={stop}
                onInteractOutside={stop}
            >
                {loading ? (
                    <p className="px-2 py-2 text-xs text-muted-foreground">
                        Loading…
                    </p>
                ) : !phases || phases.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-muted-foreground">
                        No phases defined for this project. Add them on the
                        Plan tab first.
                    </p>
                ) : (
                    <div className="max-h-72 overflow-y-auto">
                        <button
                            type="button"
                            onClick={(e) => {
                                stop(e);
                                if (project.phase) apply('');
                            }}
                            className={cn(
                                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent',
                                !project.phase && 'bg-accent/60',
                            )}
                        >
                            <span className="flex-1">No phase</span>
                            {!project.phase && (
                                <Check className="h-3.5 w-3.5 text-primary" />
                            )}
                        </button>
                        {phases.map((p) => {
                            const selected = p.name === project.phase;
                            return (
                                <button
                                    key={p.id}
                                    type="button"
                                    onClick={(e) => {
                                        stop(e);
                                        if (p.name !== project.phase)
                                            apply(p.name);
                                    }}
                                    className={cn(
                                        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent',
                                        selected && 'bg-accent/60',
                                    )}
                                >
                                    <span className="flex-1 truncate">
                                        {p.name}
                                    </span>
                                    {selected && (
                                        <Check className="h-3.5 w-3.5 text-primary" />
                                    )}
                                </button>
                            );
                        })}
                    </div>
                )}
            </PopoverContent>
        </Popover>
    );
}

export function InlineDateCell({ project, field, editable, onSaved }) {
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [draft, setDraft] = useState(toInputDate(project[field]));
    const inputRef = useRef(null);

    useEffect(() => {
        setDraft(toInputDate(project[field]));
    }, [project, field]);

    useEffect(() => {
        if (open) {
            // Auto-focus the picker so it opens immediately.
            const t = setTimeout(() => inputRef.current?.focus(), 30);
            return () => clearTimeout(t);
        }
    }, [open]);

    if (!editable) {
        return (
            <span className="text-muted-foreground">
                {formatDateLabel(project[field])}
            </span>
        );
    }

    const apply = async (raw) => {
        const next = raw ? new Date(raw).toISOString() : null;
        const current = project[field]
            ? new Date(project[field]).toISOString()
            : null;
        if (next === current) {
            setOpen(false);
            return;
        }
        setSaving(true);
        try {
            const updated = await patchProject(project.id, {
                [field]: next,
            });
            onSaved?.(updated);
            setOpen(false);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save date');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Popover open={open} onOpenChange={setOpen} modal>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    onClick={stop}
                    disabled={saving}
                    className={cn(
                        'group inline-flex max-w-full items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 text-left text-sm transition-colors',
                        'hover:border-border hover:bg-accent/60 focus:border-border focus:bg-accent/60 focus:outline-none',
                        saving && 'opacity-60',
                    )}
                >
                    <Calendar className="h-3 w-3 shrink-0 text-muted-foreground opacity-60" />
                    <span className="min-w-0 truncate">
                        {project[field] ? (
                            formatDateLabel(project[field])
                        ) : (
                            <span className="text-muted-foreground">Pick</span>
                        )}
                    </span>
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                className="w-56 p-3"
                onClick={stop}
                onInteractOutside={stop}
            >
                <div className="flex flex-col gap-2">
                    <input
                        ref={inputRef}
                        type="date"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    />
                    <div className="flex items-center justify-between gap-2">
                        <button
                            type="button"
                            onClick={(e) => {
                                stop(e);
                                setDraft('');
                                apply('');
                            }}
                            className="text-xs text-muted-foreground hover:text-foreground"
                        >
                            Clear
                        </button>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={(e) => {
                                    stop(e);
                                    setOpen(false);
                                }}
                                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={(e) => {
                                    stop(e);
                                    apply(draft);
                                }}
                                disabled={saving}
                                className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                            >
                                {saving ? 'Saving…' : 'Save'}
                            </button>
                        </div>
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}

export function InlinePersonCell({
    project,
    field,
    users,
    editable,
    allowUnassigned,
    onSaved,
}) {
    const [saving, setSaving] = useState(false);
    const person = project[field === 'ownerId' ? 'owner' : 'reporter'];

    const apply = async (next) => {
        setSaving(true);
        try {
            const updated = await patchProject(project.id, {
                [field]: next || null,
            });
            onSaved?.(updated);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not change person');
        } finally {
            setSaving(false);
        }
    };

    const options = useMemo(() => {
        const base = users.map((u) => ({
            value: u.id,
            label: u.name,
            swatch: (
                <Avatar className="h-5 w-5">
                    {u.avatarUrl && (
                        <AvatarImage
                            src={resolveAssetUrl(u.avatarUrl)}
                            alt={u.name}
                        />
                    )}
                    <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                        {initials(u.name)}
                    </AvatarFallback>
                </Avatar>
            ),
        }));
        if (allowUnassigned) {
            return [
                {
                    value: '',
                    label: 'Unassigned',
                    swatch: (
                        <span className="h-5 w-5 rounded-full border border-dashed border-muted-foreground/40" />
                    ),
                },
                ...base,
            ];
        }
        return base;
    }, [users, allowUnassigned]);

    const triggerLabel = person ? (
        <span className="flex min-w-0 items-center gap-2">
            <Avatar className="h-6 w-6">
                {person.avatarUrl && (
                    <AvatarImage
                        src={resolveAssetUrl(person.avatarUrl)}
                        alt={person.name}
                    />
                )}
                <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                    {initials(person.name)}
                </AvatarFallback>
            </Avatar>
            <span className="truncate text-sm">{person.name}</span>
        </span>
    ) : (
        <span className="text-muted-foreground">Unassigned</span>
    );

    if (!editable) return triggerLabel;

    return (
        <InlineSelect
            triggerLabel={triggerLabel}
            options={options}
            value={person?.id || ''}
            onChange={apply}
            saving={saving}
            width="w-64"
        />
    );
}
