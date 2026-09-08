import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
    ChevronDown,
    ChevronRight,
    Plus,
    Trash2,
    Users2,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { teamColorClass } from '@/pages/Teams';

// Lists the teams attached to a project. Admins can attach (and
// detach) teams. Adding a team upserts every team member as a
// participant of the project.
export function ProjectTeamsPanel({
    project,
    onChanged,
    collapsed = false,
    onToggleCollapsed,
}) {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    const projectId = project?.id;

    const [attached, setAttached] = useState([]);
    const [allTeams, setAllTeams] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showPicker, setShowPicker] = useState(false);
    const [filter, setFilter] = useState('');
    const [working, setWorking] = useState(false);

    const refresh = async () => {
        if (!projectId) return;
        try {
            const [attachedRes, listRes] = await Promise.all([
                api.get(`/teams/by-project/${projectId}`),
                isAdmin ? api.get('/teams') : Promise.resolve({ data: { teams: [] } }),
            ]);
            setAttached(attachedRes.data.teams || []);
            setAllTeams(listRes.data.teams || []);
        } catch {
            // silent — keeps the card visible even when request fails
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId]);

    const attachedIds = useMemo(
        () => new Set(attached.map((a) => a.team?.id).filter(Boolean)),
        [attached],
    );

    const candidates = useMemo(() => {
        const q = filter.trim().toLowerCase();
        return allTeams
            .filter((t) => !attachedIds.has(t.id))
            .filter(
                (t) =>
                    !q ||
                    t.name.toLowerCase().includes(q) ||
                    (t.description || '').toLowerCase().includes(q),
            )
            .slice(0, 8);
    }, [allTeams, attachedIds, filter]);

    const attach = async (team) => {
        if (working) return;
        try {
            setWorking(true);
            await api.post(`/teams/by-project/${projectId}`, { teamId: team.id });
            toast.success(`Attached "${team.name}".`);
            setShowPicker(false);
            setFilter('');
            await refresh();
            onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not attach team.');
        } finally {
            setWorking(false);
        }
    };

    const detach = async (team) => {
        if (!window.confirm(`Detach team "${team.name}" from this project?`))
            return;
        try {
            await api.delete(`/teams/by-project/${projectId}/${team.id}`);
            toast.success('Team detached.');
            await refresh();
            onChanged?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not detach team.',
            );
        }
    };

    return (
        <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                {onToggleCollapsed ? (
                    <button
                        type="button"
                        onClick={onToggleCollapsed}
                        className="-ml-1 flex flex-1 items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-accent/40"
                        aria-expanded={!collapsed}
                    >
                        {collapsed ? (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        ) : (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                        <Users2 className="h-4 w-4 text-muted-foreground" />
                        <CardTitle className="text-base">
                            Teams
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                                ({attached.length})
                            </span>
                        </CardTitle>
                    </button>
                ) : (
                    <CardTitle className="text-base">Teams</CardTitle>
                )}
                {isAdmin && !collapsed && !showPicker && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={() => setShowPicker(true)}
                    >
                        <Plus className="h-3.5 w-3.5" /> Add team
                    </Button>
                )}
            </CardHeader>
            {!collapsed && (
                <CardContent className="space-y-2">
                    {loading ? (
                        <p className="text-sm text-muted-foreground">
                            Loading teams...
                        </p>
                    ) : attached.length === 0 ? (
                        <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                            No teams attached. Adding a team adds all of its
                            members as participants in one click.
                        </p>
                    ) : (
                        <ul className="flex flex-wrap gap-1.5">
                            {attached.map(({ team }) => (
                                <li
                                    key={team.id}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
                                        teamColorClass(team.color),
                                    )}
                                    title={`${team.memberCount} member${team.memberCount === 1 ? '' : 's'}`}
                                >
                                    <Users2 className="h-3 w-3" />
                                    {team.name}
                                    <span className="text-[10px] font-normal opacity-80">
                                        · {team.memberCount}
                                    </span>
                                    {isAdmin && (
                                        <button
                                            type="button"
                                            onClick={() => detach(team)}
                                            className="ml-0.5 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                                            title="Detach team"
                                            aria-label="Detach team"
                                        >
                                            <X className="h-3 w-3" />
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}

                    {showPicker && isAdmin && (
                        <div className="space-y-2 rounded-md border bg-background p-2">
                            <div className="flex items-center gap-2">
                                <Input
                                    value={filter}
                                    onChange={(e) => setFilter(e.target.value)}
                                    placeholder="Filter teams..."
                                    className="h-8 text-sm"
                                />
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    onClick={() => {
                                        setShowPicker(false);
                                        setFilter('');
                                    }}
                                >
                                    <X className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                            {candidates.length === 0 ? (
                                <p className="px-1 py-2 text-xs text-muted-foreground">
                                    No matching teams. Create one in the Teams
                                    page first.
                                </p>
                            ) : (
                                <ul className="max-h-[200px] overflow-auto">
                                    {candidates.map((t) => (
                                        <li key={t.id}>
                                            <button
                                                type="button"
                                                onClick={() => attach(t)}
                                                disabled={working}
                                                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                                            >
                                                <span
                                                    className={cn(
                                                        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold',
                                                        teamColorClass(t.color),
                                                    )}
                                                >
                                                    <Users2 className="h-3 w-3" />
                                                    {t.name}
                                                </span>
                                                <span className="text-xs text-muted-foreground">
                                                    {t.memberCount}{' '}
                                                    {t.memberCount === 1
                                                        ? 'member'
                                                        : 'members'}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}
                </CardContent>
            )}
        </Card>
    );
}
