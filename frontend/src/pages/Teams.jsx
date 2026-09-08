import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
    Pencil,
    Plus,
    Search,
    Trash2,
    UserMinus,
    UserPlus,
    Users2,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { TopBar } from '@/components/TopBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
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

// Radix's Select reserves the empty string for its internal "no value"
// sentinel and throws if any SelectItem is rendered with value="" — so
// we use an explicit `__default__` token in the dropdown and translate
// to/from null at the form / API boundary.
const DEFAULT_COLOR = '__default__';

// Same palette tokens we use elsewhere (priorities, labels). Keeps the
// chip colour story consistent across the app.
const TEAM_COLORS = [
    { value: DEFAULT_COLOR, label: 'Default', swatch: 'bg-muted' },
    { value: 'slate', label: 'Slate', swatch: 'bg-slate-400' },
    { value: 'sky', label: 'Sky', swatch: 'bg-sky-500' },
    { value: 'emerald', label: 'Emerald', swatch: 'bg-emerald-500' },
    { value: 'amber', label: 'Amber', swatch: 'bg-amber-500' },
    { value: 'rose', label: 'Rose', swatch: 'bg-rose-500' },
    { value: 'violet', label: 'Violet', swatch: 'bg-violet-500' },
    { value: 'indigo', label: 'Indigo', swatch: 'bg-indigo-500' },
];

export function teamColorClass(color) {
    switch (color) {
        case 'sky':
            return 'bg-sky-100 text-sky-800 ring-1 ring-sky-300 dark:bg-sky-500/15 dark:text-sky-200';
        case 'emerald':
            return 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-200';
        case 'amber':
            return 'bg-amber-100 text-amber-900 ring-1 ring-amber-300 dark:bg-amber-500/15 dark:text-amber-200';
        case 'rose':
            return 'bg-rose-100 text-rose-800 ring-1 ring-rose-300 dark:bg-rose-500/15 dark:text-rose-200';
        case 'violet':
            return 'bg-violet-100 text-violet-800 ring-1 ring-violet-300 dark:bg-violet-500/15 dark:text-violet-200';
        case 'indigo':
            return 'bg-indigo-100 text-indigo-800 ring-1 ring-indigo-300 dark:bg-indigo-500/15 dark:text-indigo-200';
        case 'slate':
            return 'bg-slate-100 text-slate-700 ring-1 ring-slate-300 dark:bg-slate-500/15 dark:text-slate-200';
        default:
            return 'bg-muted text-foreground ring-1 ring-border';
    }
}

export default function Teams() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    const [teams, setTeams] = useState([]);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [editingId, setEditingId] = useState(null);
    const [creatingOpen, setCreatingOpen] = useState(false);

    const refresh = async () => {
        try {
            setLoading(true);
            const [teamRes, userRes] = await Promise.all([
                api.get('/teams'),
                api.get('/users'),
            ]);
            setTeams(teamRes.data.teams || []);
            setUsers(userRes.data.users || []);
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not load teams.',
            );
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
    }, []);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return teams;
        return teams.filter(
            (t) =>
                t.name.toLowerCase().includes(q) ||
                (t.description || '').toLowerCase().includes(q) ||
                (t.members || []).some(
                    (m) =>
                        (m.name || '').toLowerCase().includes(q) ||
                        (m.email || '').toLowerCase().includes(q),
                ),
        );
    }, [teams, query]);

    const editing = useMemo(
        () => teams.find((t) => t.id === editingId) || null,
        [teams, editingId],
    );

    const onCreated = (team) => {
        setTeams((prev) => {
            const without = prev.filter((t) => t.id !== team.id);
            return [...without, team].sort((a, b) =>
                a.name.localeCompare(b.name),
            );
        });
        setCreatingOpen(false);
    };

    const onUpdated = (team) => {
        setTeams((prev) =>
            prev.map((t) => (t.id === team.id ? team : t)),
        );
    };

    const onDeleted = (id) => {
        setTeams((prev) => prev.filter((t) => t.id !== id));
        setEditingId((cur) => (cur === id ? null : cur));
    };

    return (
        <>
            <TopBar title="Teams" />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="w-full space-y-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <p className="text-sm text-muted-foreground">
                                Bundle people into teams that can be added to a
                                project, or assigned to a single phase, in one
                                click. Adding a team adds every member as a
                                project participant.
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    placeholder="Search teams or members..."
                                    className="w-[220px] pl-8"
                                />
                            </div>
                            <Button onClick={() => setCreatingOpen(true)}>
                                <Plus className="mr-1.5 h-4 w-4" /> New team
                            </Button>
                        </div>
                    </div>

                    {loading ? (
                        <Card>
                            <CardContent className="p-6 text-sm text-muted-foreground">
                                Loading teams...
                            </CardContent>
                        </Card>
                    ) : filtered.length === 0 ? (
                        <Card>
                            <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                                <Users2 className="h-8 w-8 text-muted-foreground/60" />
                                <p>
                                    No teams yet. Create one to start grouping
                                    people for projects and phases.
                                </p>
                            </CardContent>
                        </Card>
                    ) : (
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                            {filtered.map((team) => (
                                <TeamCard
                                    key={team.id}
                                    team={team}
                                    canEdit
                                    canDelete={isAdmin}
                                    onEdit={() => setEditingId(team.id)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </main>

            <TeamFormDialog
                open={creatingOpen}
                onOpenChange={setCreatingOpen}
                users={users}
                onSaved={onCreated}
            />

            <TeamEditorDialog
                team={editing}
                open={Boolean(editing)}
                onOpenChange={(open) => !open && setEditingId(null)}
                users={users}
                canDelete={isAdmin}
                onUpdated={onUpdated}
                onDeleted={onDeleted}
            />
        </>
    );
}

function TeamCard({ team, canEdit, onEdit }) {
    return (
        <Card className="flex h-full min-h-[260px] flex-col">
            <CardContent className="flex flex-1 flex-col gap-3 p-4">
                {/* --- header strip ------------------------------------ */}
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <span
                            className={cn(
                                'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',
                                teamColorClass(team.color),
                            )}
                        >
                            <Users2 className="mr-1 h-3 w-3" />{' '}
                            <span className="truncate">{team.name}</span>
                        </span>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                            {team.memberCount}{' '}
                            {team.memberCount === 1 ? 'member' : 'members'}
                            {team.projectCount
                                ? ` · ${team.projectCount} project${team.projectCount === 1 ? '' : 's'}`
                                : ''}
                            {team.phaseCount
                                ? ` · ${team.phaseCount} phase${team.phaseCount === 1 ? '' : 's'}`
                                : ''}
                        </div>
                    </div>
                    {canEdit && (
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={onEdit}
                            className="h-7 w-7 shrink-0"
                            title="Edit team"
                        >
                            <Pencil className="h-3.5 w-3.5" />
                        </Button>
                    )}
                </div>

                {team.description && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                        {team.description}
                    </p>
                )}

                {/* --- members panel — scrollable so the card stays
                    square regardless of how many members are on the
                    team. Fixed max height keeps every card aligned in
                    the responsive grid. -------------------------- */}
                <div className="flex flex-1 flex-col rounded-md border bg-muted/20">
                    <div className="flex items-center justify-between border-b px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        <span>Members</span>
                        <span>{team.members?.length || 0}</span>
                    </div>
                    {team.members?.length ? (
                        <div className="flex max-h-40 min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
                            {team.members.map((m) => (
                                <MemberRow key={m.id} user={m} />
                            ))}
                        </div>
                    ) : (
                        <div className="flex flex-1 items-center justify-center px-2 py-3 text-[11px] text-muted-foreground">
                            No members yet.
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}

function MemberRow({ user }) {
    return (
        <div className="flex min-w-0 items-center gap-2 rounded px-1.5 py-0.5 text-xs hover:bg-accent">
            {user.avatarUrl ? (
                <img
                    src={resolveAssetUrl(user.avatarUrl)}
                    alt={user.name}
                    className="h-5 w-5 rounded-full object-cover"
                />
            ) : (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-[9px] font-semibold text-primary">
                    {initials(user.name)}
                </span>
            )}
            <span className="min-w-0 truncate">
                {user.name || user.email}
            </span>
        </div>
    );
}

function MemberChip({ user }) {
    return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-2 py-0.5 text-xs">
            {user.avatarUrl ? (
                <img
                    src={resolveAssetUrl(user.avatarUrl)}
                    alt={user.name}
                    className="h-4 w-4 rounded-full object-cover"
                />
            ) : (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/20 text-[9px] font-semibold text-primary">
                    {initials(user.name)}
                </span>
            )}
            <span>{user.name || user.email}</span>
        </span>
    );
}

function TeamFormDialog({ open, onOpenChange, users, onSaved }) {
    const [form, setForm] = useState({ name: '', description: '', color: '' });
    const [memberIds, setMemberIds] = useState([]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (open) {
            setForm({ name: '', description: '', color: '' });
            setMemberIds([]);
        }
    }, [open]);

    const submit = async (e) => {
        e.preventDefault();
        if (!form.name.trim()) {
            toast.error('Give the team a name.');
            return;
        }
        try {
            setSaving(true);
            const { data } = await api.post('/teams', {
                name: form.name.trim(),
                description: form.description.trim() || null,
                color: form.color || null,
                memberIds,
            });
            toast.success('Team created.');
            onSaved?.(data.team);
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not create team.',
            );
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>New team</DialogTitle>
                    <DialogDescription>
                        Bundle people that frequently work together so you can
                        attach them all to a project in one step.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="grid gap-3">
                    <div className="grid gap-1">
                        <Label htmlFor="team-name">Name</Label>
                        <Input
                            id="team-name"
                            value={form.name}
                            onChange={(e) =>
                                setForm((f) => ({ ...f, name: e.target.value }))
                            }
                            placeholder="e.g. Platform engineering"
                            required
                        />
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="team-description">Description</Label>
                        <Textarea
                            id="team-description"
                            value={form.description}
                            onChange={(e) =>
                                setForm((f) => ({
                                    ...f,
                                    description: e.target.value,
                                }))
                            }
                            placeholder="What does this team do?"
                            rows={3}
                        />
                    </div>
                    <div className="grid gap-1">
                        <Label>Colour</Label>
                        <Select
                            value={form.color || DEFAULT_COLOR}
                            onValueChange={(v) =>
                                setForm((f) => ({
                                    ...f,
                                    color: v === DEFAULT_COLOR ? '' : v,
                                }))
                            }
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="Pick a chip colour" />
                            </SelectTrigger>
                            <SelectContent>
                                {TEAM_COLORS.map((c) => (
                                    <SelectItem key={c.value} value={c.value}>
                                        <span className="flex items-center gap-2">
                                            <span
                                                className={cn(
                                                    'h-3 w-3 rounded-full',
                                                    c.swatch,
                                                )}
                                            />
                                            {c.label}
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="grid gap-1">
                        <Label>Members</Label>
                        <MemberMultiPicker
                            users={users}
                            selectedIds={memberIds}
                            onChange={setMemberIds}
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {saving ? 'Creating...' : 'Create team'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function TeamEditorDialog({
    team,
    open,
    onOpenChange,
    users,
    canDelete,
    onUpdated,
    onDeleted,
}) {
    const [form, setForm] = useState({ name: '', description: '', color: '' });
    const [savingDetails, setSavingDetails] = useState(false);
    const [savingMember, setSavingMember] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);

    useEffect(() => {
        if (team) {
            setForm({
                name: team.name,
                description: team.description || '',
                color: team.color || '',
            });
        }
    }, [team?.id]);

    if (!team) return null;

    const saveDetails = async (e) => {
        e.preventDefault();
        try {
            setSavingDetails(true);
            const { data } = await api.patch(`/teams/${team.id}`, {
                name: form.name.trim(),
                description: form.description.trim() || null,
                color: form.color || null,
            });
            toast.success('Team updated.');
            onUpdated?.(data.team);
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not update team.',
            );
        } finally {
            setSavingDetails(false);
        }
    };

    const removeMember = async (userId) => {
        try {
            setSavingMember(true);
            const { data } = await api.delete(
                `/teams/${team.id}/members/${userId}`,
            );
            onUpdated?.(data.team);
            toast.success('Removed from team.');
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not remove member.',
            );
        } finally {
            setSavingMember(false);
        }
    };

    const addMember = async (userId) => {
        try {
            setSavingMember(true);
            const { data } = await api.post(`/teams/${team.id}/members`, {
                userId,
            });
            onUpdated?.(data.team);
            toast.success('Added to team.');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add member.');
        } finally {
            setSavingMember(false);
        }
    };

    const deleteTeam = async () => {
        if (!window.confirm(`Delete team "${team.name}"?`)) return;
        try {
            await api.delete(`/teams/${team.id}`);
            toast.success('Team deleted.');
            onDeleted?.(team.id);
            onOpenChange(false);
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not delete team.',
            );
        }
    };

    const memberIds = new Set((team.members || []).map((m) => m.id));
    const candidates = users.filter((u) => !memberIds.has(u.id));

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Edit team</DialogTitle>
                    <DialogDescription>
                        Update the name and members. Adding someone here will
                        also add them to every project this team is currently
                        attached to.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={saveDetails} className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1 sm:col-span-2">
                        <Label htmlFor="edit-name">Name</Label>
                        <Input
                            id="edit-name"
                            value={form.name}
                            onChange={(e) =>
                                setForm((f) => ({ ...f, name: e.target.value }))
                            }
                            required
                        />
                    </div>
                    <div className="grid gap-1 sm:col-span-2">
                        <Label htmlFor="edit-description">Description</Label>
                        <Textarea
                            id="edit-description"
                            value={form.description}
                            onChange={(e) =>
                                setForm((f) => ({
                                    ...f,
                                    description: e.target.value,
                                }))
                            }
                            rows={3}
                        />
                    </div>
                    <div className="grid gap-1">
                        <Label>Colour</Label>
                        <Select
                            value={form.color || DEFAULT_COLOR}
                            onValueChange={(v) =>
                                setForm((f) => ({
                                    ...f,
                                    color: v === DEFAULT_COLOR ? '' : v,
                                }))
                            }
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {TEAM_COLORS.map((c) => (
                                    <SelectItem key={c.value} value={c.value}>
                                        <span className="flex items-center gap-2">
                                            <span
                                                className={cn(
                                                    'h-3 w-3 rounded-full',
                                                    c.swatch,
                                                )}
                                            />
                                            {c.label}
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex items-end justify-end gap-2 sm:col-span-2">
                        {canDelete && (
                            <Button
                                type="button"
                                variant="destructive"
                                onClick={deleteTeam}
                            >
                                <Trash2 className="mr-1.5 h-4 w-4" /> Delete
                            </Button>
                        )}
                        <Button type="submit" disabled={savingDetails}>
                            {savingDetails ? 'Saving...' : 'Save changes'}
                        </Button>
                    </div>
                </form>

                <div className="mt-2">
                    <div className="mb-2 flex items-center justify-between">
                        <Label className="text-sm">Members</Label>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setPickerOpen((v) => !v)}
                            disabled={candidates.length === 0}
                        >
                            <UserPlus className="mr-1 h-3.5 w-3.5" /> Add
                            member
                        </Button>
                    </div>
                    {pickerOpen && candidates.length > 0 && (
                        <div className="mb-2 max-h-48 overflow-auto rounded-md border bg-card p-1">
                            {candidates.map((u) => (
                                <button
                                    type="button"
                                    key={u.id}
                                    onClick={() => addMember(u.id)}
                                    disabled={savingMember}
                                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                                >
                                    <span className="flex items-center gap-2">
                                        <MemberChip user={u} />
                                    </span>
                                    <UserPlus className="h-3.5 w-3.5 text-muted-foreground" />
                                </button>
                            ))}
                        </div>
                    )}
                    {team.members?.length === 0 ? (
                        <p className="rounded-md border border-dashed p-3 text-center text-sm text-muted-foreground">
                            No members yet. Add some so the team is useful.
                        </p>
                    ) : (
                        <ul className="divide-y rounded-md border">
                            {team.members.map((m) => (
                                <li
                                    key={m.id}
                                    className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                                >
                                    <MemberChip user={m} />
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => removeMember(m.id)}
                                        disabled={savingMember}
                                        className="h-7 text-muted-foreground hover:text-destructive"
                                    >
                                        <UserMinus className="h-3.5 w-3.5" />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function MemberMultiPicker({ users, selectedIds, onChange }) {
    const [filter, setFilter] = useState('');
    const filtered = useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return users;
        return users.filter(
            (u) =>
                (u.name || '').toLowerCase().includes(q) ||
                (u.email || '').toLowerCase().includes(q),
        );
    }, [users, filter]);

    const toggle = (id) => {
        onChange(
            selectedIds.includes(id)
                ? selectedIds.filter((x) => x !== id)
                : [...selectedIds, id],
        );
    };

    return (
        <div className="rounded-md border bg-card">
            <div className="border-b p-2">
                <Input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter people..."
                    className="h-8"
                />
            </div>
            <div className="max-h-56 overflow-auto p-1">
                {filtered.length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                        No matches.
                    </p>
                ) : (
                    filtered.map((u) => {
                        const selected = selectedIds.includes(u.id);
                        return (
                            <button
                                type="button"
                                key={u.id}
                                onClick={() => toggle(u.id)}
                                className={cn(
                                    'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent',
                                    selected && 'bg-primary/10',
                                )}
                            >
                                <MemberChip user={u} />
                                {selected ? (
                                    <X className="h-3.5 w-3.5 text-muted-foreground" />
                                ) : (
                                    <UserPlus className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                            </button>
                        );
                    })
                )}
            </div>
        </div>
    );
}
