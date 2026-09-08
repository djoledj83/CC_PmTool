// Field picker for the time-tracking CSV export. Opens from "Export to
// CSV": the admin ticks which columns to include and orders them with
// the up/down arrows, then exports. The chosen columns + order are
// remembered in localStorage so the next export defaults to the same
// layout. Column catalogue comes from GET /exports/time/columns so it
// never drifts from the backend.
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
    ChevronDown,
    ChevronUp,
    Download,
    GripVertical,
    Loader2,
    RotateCcw,
    Save,
    Trash2,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { downloadFromApi } from '@/lib/download';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

const STORAGE_KEY = 'pm.time.export.cols';
const PRESETS_KEY = 'pm.time.export.presets';

// Ready-made presets. `keys: null` means "all columns, default order".
// Otherwise `keys` is the ordered list of columns to include (everything
// else is left unchecked).
const BUILTIN_PRESETS = [
    { id: 'all', name: 'All columns', keys: null },
    {
        id: 'payroll',
        name: 'Payroll',
        keys: ['employeeCode', 'period', 'activityCode', 'duration'],
    },
    {
        id: 'billing',
        name: 'Billing',
        keys: ['entityCode', 'product', 'crmId', 'duration'],
    },
];

function loadUserPresets() {
    try {
        const raw = localStorage.getItem(PRESETS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

// Build the ordered column list for a preset: its `keys` first (checked,
// in order), then any remaining catalogue columns left unchecked. `null`
// keys = every column checked in the catalogue's default order.
function applyPresetKeys(catalogue, keys) {
    if (!keys) return catalogue.map((c) => ({ ...c, checked: true }));
    const byKey = new Map(catalogue.map((c) => [c.key, c]));
    const out = [];
    const seen = new Set();
    for (const k of keys) {
        const col = byKey.get(k);
        if (col && !seen.has(k)) {
            out.push({ ...col, checked: true });
            seen.add(k);
        }
    }
    for (const c of catalogue) {
        if (!seen.has(c.key)) out.push({ ...c, checked: false });
    }
    return out;
}

// Merge the backend catalogue with any saved order/selection: keep the
// saved order for known keys, append new catalogue keys at the end, and
// drop keys that no longer exist.
function mergeSaved(catalogue, saved) {
    if (!Array.isArray(saved) || saved.length === 0) {
        return catalogue.map((c) => ({ ...c, checked: true }));
    }
    const byKey = new Map(catalogue.map((c) => [c.key, c]));
    const out = [];
    const seen = new Set();
    for (const s of saved) {
        const col = byKey.get(s.key);
        if (col && !seen.has(s.key)) {
            out.push({ ...col, checked: s.checked !== false });
            seen.add(s.key);
        }
    }
    for (const c of catalogue) {
        if (!seen.has(c.key)) out.push({ ...c, checked: true });
    }
    return out;
}

export default function TimeExportDialog({
    open,
    onOpenChange,
    params = {},
    filenameFallback = 'time.csv',
}) {
    const [catalogue, setCatalogue] = useState([]);
    const [cols, setCols] = useState([]);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [dragIndex, setDragIndex] = useState(null);
    const [userPresets, setUserPresets] = useState([]);
    // Which preset is currently applied (for the dropdown + delete). Empty
    // = custom/unsaved. Format: 'builtin:<id>' or 'user:<name>'.
    const [presetSel, setPresetSel] = useState('');

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setUserPresets(loadUserPresets());
        setPresetSel('');
        api.get('/exports/time/columns')
            .then(({ data }) => {
                if (cancelled) return;
                const cat = data?.columns || [];
                setCatalogue(cat);
                let saved = null;
                try {
                    const raw = localStorage.getItem(STORAGE_KEY);
                    saved = raw ? JSON.parse(raw) : null;
                } catch {
                    saved = null;
                }
                setCols(mergeSaved(cat, saved));
            })
            .catch(() => {
                if (!cancelled) toast.error('Could not load export columns.');
            })
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [open]);

    const selectedCount = useMemo(
        () => cols.filter((c) => c.checked).length,
        [cols],
    );

    // Any manual edit means the layout no longer matches a named preset.
    const markCustom = () => setPresetSel('');

    const toggle = (key) => {
        markCustom();
        setCols((prev) =>
            prev.map((c) =>
                c.key === key ? { ...c, checked: !c.checked } : c,
            ),
        );
    };

    const move = (index, dir) => {
        markCustom();
        setCols((prev) => {
            const next = [...prev];
            const j = index + dir;
            if (j < 0 || j >= next.length) return prev;
            [next[index], next[j]] = [next[j], next[index]];
            return next;
        });
    };

    // Reorder by drag: pull the item out of `from` and splice it in at
    // `to` (used for live reordering while dragging).
    const moveTo = (from, to) => {
        markCustom();
        setCols((prev) => {
            if (from === to || from == null || to == null) return prev;
            const next = [...prev];
            const [item] = next.splice(from, 1);
            next.splice(to, 0, item);
            return next;
        });
    };

    const setAll = (checked) => {
        markCustom();
        setCols((prev) => prev.map((c) => ({ ...c, checked })));
    };

    const resetDefault = () => {
        setCols(catalogue.map((c) => ({ ...c, checked: true })));
        setPresetSel('');
    };

    const applyPreset = (value) => {
        setPresetSel(value);
        if (!value) return;
        if (value.startsWith('builtin:')) {
            const p = BUILTIN_PRESETS.find((b) => `builtin:${b.id}` === value);
            if (p) setCols(applyPresetKeys(catalogue, p.keys));
        } else if (value.startsWith('user:')) {
            const name = value.slice('user:'.length);
            const p = userPresets.find((u) => u.name === name);
            if (p) setCols(applyPresetKeys(catalogue, p.keys));
        }
    };

    const savePreset = () => {
        const chosen = cols.filter((c) => c.checked).map((c) => c.key);
        if (chosen.length === 0) {
            toast.error('Pick at least one column first.');
            return;
        }
        const name = (window.prompt('Save this layout as a preset named:') || '')
            .trim();
        if (!name) return;
        const next = [
            ...userPresets.filter((p) => p.name !== name),
            { name, keys: chosen },
        ].sort((a, b) => a.name.localeCompare(b.name));
        setUserPresets(next);
        try {
            localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
        } catch {
            /* ignore */
        }
        setPresetSel(`user:${name}`);
        toast.success('Preset saved.');
    };

    const deleteSelectedPreset = () => {
        if (!presetSel.startsWith('user:')) return;
        const name = presetSel.slice('user:'.length);
        const next = userPresets.filter((p) => p.name !== name);
        setUserPresets(next);
        try {
            localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
        } catch {
            /* ignore */
        }
        setPresetSel('');
        toast.success('Preset deleted.');
    };

    const doExport = async () => {
        const chosen = cols.filter((c) => c.checked).map((c) => c.key);
        if (chosen.length === 0) {
            toast.error('Pick at least one column to export.');
            return;
        }
        setBusy(true);
        try {
            // Persist order + selection for next time.
            try {
                localStorage.setItem(
                    STORAGE_KEY,
                    JSON.stringify(
                        cols.map((c) => ({ key: c.key, checked: c.checked })),
                    ),
                );
            } catch {
                /* ignore */
            }
            await downloadFromApi('/exports/time/csv', {
                params: { ...params, fields: chosen.join(',') },
                filenameFallback,
            });
            onOpenChange(false);
        } catch (err) {
            console.warn('[time/export] failed:', err?.message);
            toast.error('Could not export to CSV.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[460px]">
                <DialogHeader>
                    <DialogTitle>Export to CSV</DialogTitle>
                    <DialogDescription>
                        Choose which columns to include and drag them into the
                        order you want (or use the arrows).
                    </DialogDescription>
                </DialogHeader>

                {/* Presets: pick a saved layout, or save the current one. */}
                <div className="mb-2 flex items-center gap-2">
                    <span className="shrink-0 text-xs font-medium text-muted-foreground">
                        Preset
                    </span>
                    <select
                        value={presetSel}
                        onChange={(e) => applyPreset(e.target.value)}
                        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
                    >
                        <option value="">Custom…</option>
                        <optgroup label="Built-in">
                            {BUILTIN_PRESETS.map((p) => (
                                <option key={p.id} value={`builtin:${p.id}`}>
                                    {p.name}
                                </option>
                            ))}
                        </optgroup>
                        {userPresets.length > 0 && (
                            <optgroup label="My presets">
                                {userPresets.map((p) => (
                                    <option
                                        key={p.name}
                                        value={`user:${p.name}`}
                                    >
                                        {p.name}
                                    </option>
                                ))}
                            </optgroup>
                        )}
                    </select>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0 gap-1.5"
                        onClick={savePreset}
                        title="Save the current columns & order as a preset"
                    >
                        <Save className="h-3.5 w-3.5" /> Save
                    </Button>
                    {presetSel.startsWith('user:') && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0 text-rose-600 hover:text-rose-600"
                            onClick={deleteSelectedPreset}
                            title="Delete this preset"
                        >
                            <Trash2 className="h-4 w-4" />
                        </Button>
                    )}
                </div>

                <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{selectedCount} selected</span>
                    <span className="flex items-center gap-1">
                        <button
                            type="button"
                            className="rounded px-1.5 py-0.5 hover:bg-accent"
                            onClick={() => setAll(true)}
                        >
                            Select all
                        </button>
                        <button
                            type="button"
                            className="rounded px-1.5 py-0.5 hover:bg-accent"
                            onClick={() => setAll(false)}
                        >
                            None
                        </button>
                        <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent"
                            onClick={resetDefault}
                            title="Reset to default columns & order"
                        >
                            <RotateCcw className="h-3 w-3" /> Reset
                        </button>
                    </span>
                </div>

                {loading ? (
                    <p className="flex items-center gap-1.5 p-4 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </p>
                ) : (
                    <ul className="max-h-[52vh] divide-y overflow-y-auto rounded-md border">
                        {cols.map((c, i) => (
                            <li
                                key={c.key}
                                draggable
                                onDragStart={(e) => {
                                    setDragIndex(i);
                                    e.dataTransfer.effectAllowed = 'move';
                                }}
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    e.dataTransfer.dropEffect = 'move';
                                    if (dragIndex === null || dragIndex === i)
                                        return;
                                    moveTo(dragIndex, i);
                                    setDragIndex(i);
                                }}
                                onDrop={(e) => e.preventDefault()}
                                onDragEnd={() => setDragIndex(null)}
                                className={cn(
                                    'flex items-center gap-2 px-2 py-1.5',
                                    dragIndex === i
                                        ? 'bg-primary/10'
                                        : 'hover:bg-muted/40',
                                )}
                            >
                                <span
                                    className="shrink-0 cursor-grab text-muted-foreground/50 active:cursor-grabbing"
                                    title="Drag to reorder"
                                >
                                    <GripVertical className="h-4 w-4" />
                                </span>
                                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                                    <input
                                        type="checkbox"
                                        className="h-4 w-4 rounded border"
                                        checked={c.checked}
                                        onChange={() => toggle(c.key)}
                                    />
                                    <span
                                        className={cn(
                                            'truncate text-sm',
                                            !c.checked &&
                                                'text-muted-foreground line-through',
                                        )}
                                    >
                                        {c.label}
                                    </span>
                                </label>
                                <span className="flex shrink-0 items-center">
                                    <button
                                        type="button"
                                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                                        onClick={() => move(i, -1)}
                                        disabled={i === 0}
                                        title="Move up"
                                    >
                                        <ChevronUp className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                                        onClick={() => move(i, 1)}
                                        disabled={i === cols.length - 1}
                                        title="Move down"
                                    >
                                        <ChevronDown className="h-3.5 w-3.5" />
                                    </button>
                                </span>
                            </li>
                        ))}
                    </ul>
                )}

                <DialogFooter>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => onOpenChange(false)}
                        disabled={busy}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        className="gap-1.5"
                        onClick={doExport}
                        disabled={busy || loading || selectedCount === 0}
                    >
                        {busy ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Download className="h-4 w-4" />
                        )}
                        Export ({selectedCount})
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
