import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, Plus, Trash2, X } from 'lucide-react';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

// Personal tool to create project groups and choose which projects
// belong to each. Many-to-many: a project can be in several groups.
// Groups are private to the user. Calls /api/project-groups.
export default function ManageProjectGroupsDialog({
    open,
    onOpenChange,
    projects = [],
    groups = [],
    onChanged,
}) {
    const [newName, setNewName] = useState('');
    const [creating, setCreating] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [memberSet, setMemberSet] = useState(() => new Set());
    const [search, setSearch] = useState('');
    const [savingMembers, setSavingMembers] = useState(false);

    useEffect(() => {
        if (!open) {
            setNewName('');
            setEditingId(null);
            setSearch('');
        }
    }, [open]);

    const editingGroup = groups.find((g) => g.id === editingId) || null;
    useEffect(() => {
        if (editingGroup) {
            setMemberSet(new Set(editingGroup.projectIds || []));
        }
    }, [editingId]); // eslint-disable-line react-hooks/exhaustive-deps

    const createGroup = async () => {
        const name = newName.trim();
        if (!name) return;
        setCreating(true);
        try {
            await api.post('/project-groups', { name });
            setNewName('');
            toast.success('Group created.');
            onChanged?.();
        } catch (e) {
            toast.error(e.response?.data?.error || 'Could not create group.');
        } finally {
            setCreating(false);
        }
    };

    const deleteGroup = async (g) => {
        if (!window.confirm(`Delete group "${g.name}"? Projects are not deleted.`))
            return;
        try {
            await api.delete(`/project-groups/${g.id}`);
            if (editingId === g.id) setEditingId(null);
            toast.success('Group deleted.');
            onChanged?.();
        } catch (e) {
            toast.error(e.response?.data?.error || 'Could not delete group.');
        }
    };

    const saveMembers = async () => {
        if (!editingGroup) return;
        setSavingMembers(true);
        try {
            await api.put(`/project-groups/${editingGroup.id}/projects`, {
                projectIds: [...memberSet],
            });
            toast.success('Group updated.');
            onChanged?.();
            setEditingId(null);
        } catch (e) {
            toast.error(e.response?.data?.error || 'Could not save members.');
        } finally {
            setSavingMembers(false);
        }
    };

    const visibleProjects = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return projects;
        return projects.filter((p) =>
            (p.name || '').toLowerCase().includes(q),
        );
    }, [projects, search]);

    const toggleMember = (id) => {
        setMemberSet((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[560px]">
                <DialogHeader>
                    <DialogTitle>Project groups</DialogTitle>
                    <DialogDescription>
                        Organise projects into your own groups for a cleaner
                        list and sidebar. Groups are private to you, and a
                        project can belong to several groups.
                    </DialogDescription>
                </DialogHeader>

                {editingGroup ? (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium">
                                Projects in “{editingGroup.name}”
                            </p>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEditingId(null)}
                            >
                                ‹ Back
                            </Button>
                        </div>
                        <Input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search projects…"
                            className="h-8 text-sm"
                        />
                        <div className="max-h-[40vh] space-y-1 overflow-y-auto rounded-md border p-1">
                            {visibleProjects.map((p) => {
                                const checked = memberSet.has(p.id);
                                return (
                                    <button
                                        type="button"
                                        key={p.id}
                                        onClick={() => toggleMember(p.id)}
                                        className={cnRow(checked)}
                                    >
                                        <span
                                            className={cnBox(checked)}
                                        >
                                            {checked && (
                                                <Check className="h-3 w-3" />
                                            )}
                                        </span>
                                        <span className="truncate text-sm">
                                            {p.name}
                                        </span>
                                    </button>
                                );
                            })}
                            {visibleProjects.length === 0 && (
                                <p className="p-3 text-center text-xs text-muted-foreground">
                                    No projects match.
                                </p>
                            )}
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">
                                {memberSet.size} selected
                            </span>
                            <Button
                                onClick={saveMembers}
                                disabled={savingMembers}
                                size="sm"
                            >
                                {savingMembers ? (
                                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                ) : null}
                                Save
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2">
                            <Input
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder="New group name…"
                                className="h-9"
                                onKeyDown={(e) =>
                                    e.key === 'Enter' && createGroup()
                                }
                            />
                            <Button onClick={createGroup} disabled={creating}>
                                <Plus className="mr-1 h-4 w-4" /> Add
                            </Button>
                        </div>

                        <div className="max-h-[45vh] space-y-1.5 overflow-y-auto">
                            {groups.length === 0 ? (
                                <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                                    No groups yet. Create one above.
                                </p>
                            ) : (
                                groups.map((g) => (
                                    <div
                                        key={g.id}
                                        className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                                    >
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-medium">
                                                {g.name}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {g.projectCount} project
                                                {g.projectCount === 1 ? '' : 's'}
                                            </p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => setEditingId(g.id)}
                                            >
                                                Projects
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-8 w-8 text-destructive hover:text-destructive"
                                                onClick={() => deleteGroup(g)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

function cnRow(checked) {
    return [
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors',
        checked ? 'bg-primary/5' : 'hover:bg-muted/50',
    ].join(' ');
}
function cnBox(checked) {
    return [
        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
        checked
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-muted-foreground/40',
    ].join(' ');
}
