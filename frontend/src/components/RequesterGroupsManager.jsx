// Admin management of requester groups (Templates → Tickets → Requester
// groups). Create named groups and pick their members; requesters can
// then add a whole group to a ticket at once.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Pencil, Trash2, Users, Check } from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

export function RequesterGroupsManager() {
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(null);

    const load = async () => {
        try {
            setLoading(true);
            const { data } = await api.get('/requester-groups');
            setGroups(data.groups || []);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not load groups.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const remove = async (g) => {
        if (!window.confirm(`Delete group "${g.name}"?`)) return;
        try {
            await api.delete(`/requester-groups/${g.id}`);
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
                    Named groups of people. A requester can add a whole group
                    as participants on a ticket in one go.
                </p>
                <Button
                    size="sm"
                    className="shrink-0 gap-1.5"
                    onClick={() => setEditing({})}
                >
                    <Plus className="h-4 w-4" /> New group
                </Button>
            </div>
            {loading ? (
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </p>
            ) : groups.length === 0 ? (
                <p className="rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
                    No groups yet. Create one to bundle requesters together.
                </p>
            ) : (
                <div className="space-y-2">
                    {groups.map((g) => (
                        <div
                            key={g.id}
                            className="flex items-start gap-3 rounded-lg border bg-background p-3"
                        >
                            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                                <Users className="h-4 w-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="font-medium">{g.name}</div>
                                <div className="text-xs text-muted-foreground">
                                    {g.members.length === 0
                                        ? 'No members yet'
                                        : g.members
                                              .map((m) => m.name || m.email)
                                              .join(', ')}
                                </div>
                            </div>
                            <div className="flex shrink-0 gap-1">
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8"
                                    onClick={() => setEditing(g)}
                                >
                                    <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8 text-rose-600"
                                    onClick={() => remove(g)}
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <GroupDialog
                value={editing}
                onOpenChange={(open) => !open && setEditing(null)}
                onSaved={() => {
                    setEditing(null);
                    load();
                }}
            />
        </div>
    );
}

function GroupDialog({ value, onOpenChange, onSaved }) {
    const open = !!value;
    const editingId = value?.id || null;
    const [name, setName] = useState('');
    const [memberIds, setMemberIds] = useState([]);
    const [users, setUsers] = useState([]);
    const [q, setQ] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setName(value.name || '');
        setMemberIds((value.members || []).map((m) => m.id));
        setQ('');
        api.get('/requester-groups/candidates')
            .then(({ data }) => setUsers(data.users || []))
            .catch(() => setUsers([]));
    }, [open, value]);

    const toggle = (id) =>
        setMemberIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );

    const filtered = users.filter(
        (u) =>
            !q ||
            (u.name || u.email || '').toLowerCase().includes(q.toLowerCase()),
    );

    const save = async () => {
        if (!name.trim()) return toast.error('Enter a name.');
        try {
            setSaving(true);
            const payload = { name: name.trim(), memberIds };
            if (editingId) {
                await api.patch(`/requester-groups/${editingId}`, payload);
            } else {
                await api.post('/requester-groups', payload);
            }
            toast.success('Saved.');
            onSaved?.();
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
                        {editingId ? 'Edit group' : 'New group'}
                    </DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="space-y-1.5">
                        <Label className="text-xs">Name</Label>
                        <Input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Finance team"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                            <Label className="text-xs">Members</Label>
                            <span className="text-[10px] text-muted-foreground">
                                {memberIds.length} selected
                            </span>
                        </div>
                        <Input
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            placeholder="Search people…"
                            className="h-8 text-xs"
                        />
                        <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-1">
                            {filtered.length === 0 ? (
                                <p className="px-2 py-2 text-xs text-muted-foreground">
                                    No people found.
                                </p>
                            ) : (
                                filtered.map((u) => {
                                    const on = memberIds.includes(u.id);
                                    return (
                                        <button
                                            key={u.id}
                                            type="button"
                                            onClick={() => toggle(u.id)}
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

export default RequesterGroupsManager;
