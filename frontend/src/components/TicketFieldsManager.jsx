// Admin "Ticket fields" config (Templates → Tickets → Ticket fields).
// Defines the GLOBAL set of extra fields shown on the raise-ticket form:
//   • Terminal  — cascading Vendor → Model → OS picker (built-in, once)
//   • Client    — picker from the client catalog (built-in, once)
//   • Text      — free name/value field (e.g. Merchant ID, Host TID)
//   • Multi-select — choices the requester ticks (stored in `options`)
// Each field can be marked required and reordered. The raise form +
// ticket detail consume this in the next slice.
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
    Loader2,
    Plus,
    Trash2,
    ArrowUp,
    ArrowDown,
    Pencil,
    Check,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

const TYPE_META = {
    TERMINAL: { label: 'Terminal', hint: 'Vendor → Model → OS picker' },
    CLIENT: { label: 'Client', hint: 'Pick from the client catalog' },
    TEXT: { label: 'Text', hint: 'Free name / value field' },
    SELECT: { label: 'Multi-select', hint: 'Requester ticks one or more' },
    YESNO: { label: 'Yes / No', hint: 'A single yes-or-no answer' },
};

// `requestTypeId` scopes the fields: omit it for the global set (shown on
// every raise form), or pass a ticket-type id to manage that type's own
// fields. The two are independent lists.
export function TicketFieldsManager({ requestTypeId = null }) {
    const scope = requestTypeId || 'none';
    const perType = scope !== 'none';
    const [fields, setFields] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [editing, setEditing] = useState(null); // {id, label}

    // Add-field form state.
    const [type, setType] = useState('TEXT');
    const [label, setLabel] = useState('');
    const [optionsText, setOptionsText] = useState('');

    const load = async () => {
        try {
            setLoading(true);
            const { data } = await api.get('/ticket-fields', {
                params: { requestTypeId: scope },
            });
            setFields(data.fields || []);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not load fields.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope]);

    const hasTerminal = useMemo(
        () => fields.some((f) => f.type === 'TERMINAL'),
        [fields],
    );
    const hasClient = useMemo(
        () => fields.some((f) => f.type === 'CLIENT'),
        [fields],
    );

    // Built-in fields auto-label; only text/select need a typed label.
    const builtinDefaultLabel = (t) => (t === 'TERMINAL' ? 'Terminal' : 'Client');

    const addField = async () => {
        const isBuiltin = type === 'TERMINAL' || type === 'CLIENT';
        const finalLabel = isBuiltin ? builtinDefaultLabel(type) : label.trim();
        if (!finalLabel) {
            toast.error('Enter a field label.');
            return;
        }
        let options;
        if (type === 'SELECT') {
            options = optionsText
                .split(/[\n,]/)
                .map((s) => s.trim())
                .filter(Boolean);
            if (options.length === 0) {
                toast.error('Add at least one option for a multi-select.');
                return;
            }
        }
        try {
            setSaving(true);
            await api.post('/ticket-fields', {
                type,
                label: finalLabel,
                options,
                requestTypeId: scope,
            });
            setLabel('');
            setOptionsText('');
            setType('TEXT');
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add field.');
        } finally {
            setSaving(false);
        }
    };

    const patchField = async (id, body) => {
        try {
            await api.patch(`/ticket-fields/${id}`, body);
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update field.');
        }
    };

    const removeField = async (f) => {
        if (!window.confirm(`Delete field "${f.label}"?`)) return;
        try {
            await api.delete(`/ticket-fields/${f.id}`);
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete field.');
        }
    };

    const move = async (index, dir) => {
        const next = [...fields];
        const j = index + dir;
        if (j < 0 || j >= next.length) return;
        [next[index], next[j]] = [next[j], next[index]];
        setFields(next); // optimistic
        try {
            await api.post('/ticket-fields/reorder', {
                ids: next.map((f) => f.id),
            });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not reorder.');
            load();
        }
    };

    const saveLabel = async () => {
        const text = editing?.label.trim();
        if (!text) return;
        await patchField(editing.id, { label: text });
        setEditing(null);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
            </div>
        );
    }

    const isBuiltin = type === 'TERMINAL' || type === 'CLIENT';

    return (
        <div className="space-y-5">
            <p className="text-sm text-muted-foreground">
                {perType
                    ? 'These fields appear when a requester raises a ticket of this type (in addition to the global fields). Mark the ones they must fill in as required.'
                    : 'These fields appear on every raise-ticket form. Mark the ones requesters must fill in as required.'}
            </p>

            {/* Add a field */}
            <div className="rounded-lg border bg-muted/20 p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Add a field
                </p>
                <div className="flex flex-wrap items-start gap-2">
                    <div className="w-[150px]">
                        <Select value={type} onValueChange={setType}>
                            <SelectTrigger className="h-9 text-sm">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem
                                    value="TERMINAL"
                                    disabled={hasTerminal}
                                >
                                    Terminal
                                </SelectItem>
                                <SelectItem value="CLIENT" disabled={hasClient}>
                                    Client
                                </SelectItem>
                                <SelectItem value="TEXT">Text</SelectItem>
                                <SelectItem value="SELECT">
                                    Multi-select
                                </SelectItem>
                                <SelectItem value="YESNO">Yes / No</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    {!isBuiltin && (
                        <Input
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            placeholder="Label (e.g. Merchant ID)"
                            className="h-9 min-w-[180px] flex-1 text-sm"
                        />
                    )}
                    {type === 'SELECT' && (
                        <Input
                            value={optionsText}
                            onChange={(e) => setOptionsText(e.target.value)}
                            placeholder="Options, comma-separated"
                            className="h-9 min-w-[200px] flex-1 text-sm"
                        />
                    )}
                    <Button
                        className="h-9 shrink-0 gap-1"
                        onClick={addField}
                        disabled={saving}
                    >
                        <Plus className="h-4 w-4" /> Add
                    </Button>
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {TYPE_META[type]?.hint}
                    {isBuiltin && ' — can be added once.'}
                </p>
            </div>

            {/* Configured fields */}
            {fields.length === 0 ? (
                <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                    No fields configured yet.
                </p>
            ) : (
                <div className="divide-y rounded-lg border">
                    {fields.map((f, i) => (
                        <div
                            key={f.id}
                            className="group flex items-center gap-3 px-3 py-2.5"
                        >
                            <div className="flex flex-col">
                                <button
                                    type="button"
                                    onClick={() => move(i, -1)}
                                    disabled={i === 0}
                                    className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30"
                                >
                                    <ArrowUp className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => move(i, 1)}
                                    disabled={i === fields.length - 1}
                                    className="rounded p-0.5 text-muted-foreground hover:bg-accent disabled:opacity-30"
                                >
                                    <ArrowDown className="h-3.5 w-3.5" />
                                </button>
                            </div>

                            <div className="min-w-0 flex-1">
                                {editing?.id === f.id ? (
                                    <div className="flex items-center gap-1.5">
                                        <Input
                                            value={editing.label}
                                            onChange={(e) =>
                                                setEditing({
                                                    ...editing,
                                                    label: e.target.value,
                                                })
                                            }
                                            onKeyDown={(e) =>
                                                e.key === 'Enter' && saveLabel()
                                            }
                                            autoFocus
                                            className="h-8 max-w-[260px] text-sm"
                                        />
                                        <button
                                            type="button"
                                            onClick={saveLabel}
                                            className="rounded p-1 text-emerald-600 hover:bg-accent"
                                        >
                                            <Check className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setEditing(null)}
                                            className="rounded p-1 text-muted-foreground hover:bg-accent"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2">
                                        <span className="truncate text-sm font-medium">
                                            {f.label}
                                        </span>
                                        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                            {TYPE_META[f.type]?.label || f.type}
                                        </span>
                                        {!f.active && (
                                            <span className="shrink-0 text-[10px] text-muted-foreground">
                                                inactive
                                            </span>
                                        )}
                                    </div>
                                )}
                                {f.type === 'SELECT' &&
                                    Array.isArray(f.options) &&
                                    f.options.length > 0 && (
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            {f.options.map((o) => (
                                                <span
                                                    key={o}
                                                    className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                                >
                                                    {o}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                            </div>

                            <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                                <Switch
                                    checked={f.required}
                                    onCheckedChange={(v) =>
                                        patchField(f.id, { required: v })
                                    }
                                />
                                Required
                            </label>
                            <button
                                type="button"
                                title="Rename"
                                onClick={() =>
                                    setEditing({ id: f.id, label: f.label })
                                }
                                className="rounded p-1 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100"
                            >
                                <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                                type="button"
                                title="Delete"
                                onClick={() => removeField(f)}
                                className="rounded p-1 text-rose-600 opacity-0 hover:bg-accent group-hover:opacity-100"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default TicketFieldsManager;
