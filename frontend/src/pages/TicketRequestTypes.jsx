// Admin screen to manage ticket request types — the cards requesters see
// on the portal. Each type maps to a project (where its tickets land).
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Pencil, Trash2, Users, Check } from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
    getTicketTypeIcon,
    TICKET_TYPE_ICON_OPTIONS,
} from '@/lib/ticketTypeIcons';
import {
    TICKET_TYPE_COLORS,
    getTicketTypeChipClasses,
    getTicketTypeDotClass,
} from '@/lib/ticketTypeColors';
import { TopBar } from '@/components/TopBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { TicketFieldsManager } from '@/components/TicketFieldsManager';

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const titleCase = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s);

// Standalone page (kept for the /ticket-types route). The actual editor
// lives in TicketTypesManager so it can also be embedded as a section on
// the Templates page.
export default function TicketRequestTypes() {
    return (
        <>
            <TopBar title="Ticket types" />
            <main className="flex-1 overflow-auto bg-muted/20 p-4 sm:p-6">
                <div className="mx-auto max-w-3xl">
                    <TicketTypesManager />
                </div>
            </main>
        </>
    );
}

// The editor body — list + create/edit dialog + "New type" button.
// Self-contained so it renders identically on the standalone page and
// inside the Templates → Ticket types section.
export function TicketTypesManager() {
    const [types, setTypes] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(null);

    const load = async () => {
        try {
            setLoading(true);
            const { data } = await api.get('/ticket-request-types');
            setTypes(data.requestTypes || []);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not load.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const remove = async (rt) => {
        if (!window.confirm(`Delete request type "${rt.name}"?`)) return;
        try {
            await api.delete(`/ticket-request-types/${rt.id}`);
            toast.success('Deleted.');
            load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete.');
        }
    };

    return (
        <div>
            <div className="mb-4 flex items-start justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                    These appear as cards on the requester portal. Picking a
                    type files the ticket under the project the requester
                    chooses.
                </p>
                <Button
                    size="sm"
                    className="shrink-0 gap-1.5"
                    onClick={() => setEditing({})}
                >
                    <Plus className="h-4 w-4" /> New type
                </Button>
            </div>
            {loading ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </p>
            ) : types.length === 0 ? (
                <p className="rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
                    No request types yet. Create one so requesters have
                    something to pick.
                </p>
            ) : (
                <div className="space-y-2">
                    {types.map((rt) => {
                        const Icon = getTicketTypeIcon(rt.icon);
                        const agents = rt.agents || [];
                        return (
                        <div
                            key={rt.id}
                            className={cn(
                                'flex items-start gap-3 rounded-lg border bg-background p-3',
                                !rt.active && 'opacity-60',
                            )}
                        >
                            <span
                                className={cn(
                                    'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                                    getTicketTypeChipClasses(rt.color),
                                )}
                            >
                                <Icon className="h-4 w-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium">
                                        {rt.name}
                                    </span>
                                    {!rt.active && (
                                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                            Inactive
                                        </span>
                                    )}
                                </div>
                                <div className="truncate text-xs text-muted-foreground">
                                    {rt.description || 'No description'}
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                                    {rt.defaultPriority && (
                                        <span>
                                            Default priority:{' '}
                                            {titleCase(rt.defaultPriority)}
                                        </span>
                                    )}
                                    <span className="inline-flex items-center gap-1">
                                        <Users className="h-3 w-3" />
                                        {agents.length === 0
                                            ? 'Visible to all agents'
                                            : `Restricted to ${agents.length} ${
                                                  agents.length === 1
                                                      ? 'agent'
                                                      : 'agents'
                                              }`}
                                    </span>
                                </div>
                            </div>
                            <div className="flex shrink-0 gap-1">
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8"
                                    onClick={() => setEditing(rt)}
                                >
                                    <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8 text-rose-600"
                                    onClick={() => remove(rt)}
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                        );
                    })}
                </div>
            )}

            <TypeDialog
                value={editing}
                onOpenChange={(open) => !open && setEditing(null)}
                onSaved={(saved, opts) => {
                    load();
                    // After creating, keep the dialog open in edit mode so
                    // the admin can add custom fields right away (they need
                    // the new type's id to attach to).
                    if (opts?.created && saved?.id) setEditing(saved);
                    else setEditing(null);
                }}
            />
        </div>
    );
}

function TypeDialog({ value, onOpenChange, onSaved }) {
    const open = !!value;
    const editingId = value?.id || null;
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [defaultPriority, setDefaultPriority] = useState('NONE');
    const [active, setActive] = useState(true);
    const [icon, setIcon] = useState('life-buoy');
    const [color, setColor] = useState(null);
    const [agentIds, setAgentIds] = useState([]);
    const [users, setUsers] = useState([]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setName(value.name || '');
        setDescription(value.description || '');
        setDefaultPriority(value.defaultPriority || 'NONE');
        setActive(value.active ?? true);
        setIcon(value.icon || 'life-buoy');
        setColor(value.color || null);
        setAgentIds(value.agentIds || []);
    }, [open, value]);

    // Candidate agents = active, non-requester users.
    useEffect(() => {
        if (!open) return;
        api.get('/users')
            .then(({ data }) => {
                const list = (data.users || data || []).filter(
                    (u) => u.role !== 'REQUESTER',
                );
                setUsers(list);
            })
            .catch(() => setUsers([]));
    }, [open]);

    const toggleAgent = (id) =>
        setAgentIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );

    const save = async () => {
        if (!name.trim()) return toast.error('Enter a name.');
        const payload = {
            name: name.trim(),
            description: description.trim() || null,
            defaultPriority: defaultPriority === 'NONE' ? null : defaultPriority,
            active,
            icon,
            color,
            agentIds,
        };
        try {
            setSaving(true);
            const { data } = editingId
                ? await api.patch(
                      `/ticket-request-types/${editingId}`,
                      payload,
                  )
                : await api.post('/ticket-request-types', payload);
            toast.success(
                editingId
                    ? 'Saved.'
                    : 'Type created — add custom fields below, then close.',
            );
            onSaved?.(data.requestType, { created: !editingId });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save.');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[88vh] w-[90vw] max-w-[90vw] overflow-y-auto sm:w-[90vw] sm:max-w-[90vw]">
                <DialogHeader>
                    <DialogTitle>
                        {editingId ? 'Edit request type' : 'New request type'}
                    </DialogTitle>
                </DialogHeader>
                <div className="grid items-start gap-6 lg:grid-cols-2">
                    <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label className="text-xs">Name</Label>
                        <Input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Problem on page"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                            <Label className="text-xs">Description</Label>
                            <span className="text-[10px] text-muted-foreground">
                                {description.length}/255
                            </span>
                        </div>
                        <Textarea
                            value={description}
                            onChange={(e) =>
                                setDescription(e.target.value.slice(0, 255))
                            }
                            maxLength={255}
                            placeholder="Shown under the card on the portal"
                            rows={4}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Icon</Label>
                        <div className="grid grid-cols-9 gap-1.5">
                            {TICKET_TYPE_ICON_OPTIONS.map((opt) => {
                                const OptIcon = opt.Icon;
                                const sel = icon === opt.value;
                                return (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        title={opt.label}
                                        onClick={() => setIcon(opt.value)}
                                        className={cn(
                                            'flex h-9 items-center justify-center rounded-md border transition-colors',
                                            sel
                                                ? 'border-primary bg-primary/10 text-primary ring-1 ring-primary/40'
                                                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                                        )}
                                    >
                                        <OptIcon className="h-4 w-4" />
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Colour</Label>
                        <div className="flex flex-wrap gap-1.5">
                            {/* "Default" (no colour) first, then the palette. */}
                            <button
                                type="button"
                                title="Default"
                                onClick={() => setColor(null)}
                                className={cn(
                                    'flex h-7 w-7 items-center justify-center rounded-full border',
                                    !color
                                        ? 'ring-2 ring-primary ring-offset-1'
                                        : 'hover:opacity-80',
                                )}
                            >
                                <span className="h-4 w-4 rounded-full bg-primary/20" />
                            </button>
                            {TICKET_TYPE_COLORS.map((c) => (
                                <button
                                    key={c.value}
                                    type="button"
                                    title={c.label}
                                    onClick={() => setColor(c.value)}
                                    className={cn(
                                        'flex h-7 w-7 items-center justify-center rounded-full',
                                        color === c.value
                                            ? 'ring-2 ring-primary ring-offset-1'
                                            : 'hover:opacity-80',
                                    )}
                                >
                                    <span
                                        className={cn(
                                            'h-4 w-4 rounded-full',
                                            getTicketTypeDotClass(c.value),
                                        )}
                                    />
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label className="text-xs">Default priority</Label>
                            <Select
                                value={defaultPriority}
                                onValueChange={setDefaultPriority}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="NONE">None</SelectItem>
                                    {PRIORITIES.map((p) => (
                                        <SelectItem key={p} value={p}>
                                            {titleCase(p)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Status</Label>
                            <Select
                                value={active ? 'active' : 'inactive'}
                                onValueChange={(v) =>
                                    setActive(v === 'active')
                                }
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="active">
                                        Active
                                    </SelectItem>
                                    <SelectItem value="inactive">
                                        Inactive
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Who can see these tickets</Label>
                        <p className="text-[11px] text-muted-foreground">
                            Leave empty so every agent sees this type. Pick
                            users to make it a private queue — only they (and
                            admins) will see tickets of this type. Requesters
                            can&apos;t be added.
                        </p>
                        <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border p-1">
                            {users.length === 0 ? (
                                <p className="px-2 py-2 text-xs text-muted-foreground">
                                    No agents available.
                                </p>
                            ) : (
                                users.map((u) => {
                                    const on = agentIds.includes(u.id);
                                    return (
                                        <button
                                            key={u.id}
                                            type="button"
                                            onClick={() => toggleAgent(u.id)}
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
                                                {on && (
                                                    <Check className="h-3 w-3" />
                                                )}
                                            </span>
                                            <span className="truncate">
                                                {u.name || u.email}
                                            </span>
                                        </button>
                                    );
                                })
                            )}
                        </div>
                        {agentIds.length > 0 && (
                            <p className="text-[11px] text-muted-foreground">
                                Restricted to {agentIds.length}{' '}
                                {agentIds.length === 1 ? 'agent' : 'agents'}.
                            </p>
                        )}
                    </div>
                    </div>

                    {/* Per-type custom fields — right column. */}
                    <div className="space-y-1.5 lg:border-l lg:pl-6">
                        <Label className="text-xs">Custom fields</Label>
                        {editingId ? (
                            <TicketFieldsManager requestTypeId={editingId} />
                        ) : (
                            <p className="text-[11px] text-muted-foreground">
                                Save the type first, then reopen it to add the
                                fields requesters fill in when raising this type.
                            </p>
                        )}
                    </div>
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={saving}
                    >
                        Cancel
                    </Button>
                    <Button onClick={save} disabled={saving}>
                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
