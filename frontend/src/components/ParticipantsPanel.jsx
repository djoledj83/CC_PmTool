import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
    ChevronDown,
    ChevronRight,
    Crown,
    LogOut,
    Trash2,
    Users as UsersIcon,
    UserPlus,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import {
    CAPABILITIES as CAPABILITIES_FRONT,
    hasCapability,
} from '@/lib/capabilities';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export function ParticipantsPanel({
    project,
    onChanged,
    collapsed = false,
    onToggleCollapsed,
}) {
    const { user: currentUser } = useAuth();
    const { isOnline, subscribe } = useRealtime();
    const isAdmin = currentUser?.role === 'ADMIN';
    const projectId = project?.id;
    // Personal-project owners get full participant management on their
    // own personal projects so they can invite collaborators after the
    // initial create. The backend mirrors this rule.
    const isPersonalOwner =
        Boolean(project?.isPersonal) &&
        Boolean(currentUser?.id) &&
        project.ownerId === currentUser.id;
    // Per-user capability override: `project:participants:manage` lets
    // a non-admin add/remove participants on any project they can see.
    // Used to be dead — the backend now consults it in
    // `canManageParticipants` and this surfaces the matching UI.
    const canManageViaCap = hasCapability(
        currentUser,
        CAPABILITIES_FRONT.PROJECT_PARTICIPANTS_MANAGE,
    );

    const [participants, setParticipants] = useState([]);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showPicker, setShowPicker] = useState(false);
    const [query, setQuery] = useState('');
    const [highlight, setHighlight] = useState(0);
    const [adding, setAdding] = useState(false);
    const inputRef = useRef(null);

    const myMembership = useMemo(
        () => participants.find((p) => p.id === currentUser?.id),
        [participants, currentUser?.id],
    );
    const iAmParticipant = Boolean(myMembership);
    // Adding/removing participants: admins on any project, the owner
    // of a personal project, or any user the admin has granted
    // `project:participants:manage` to.
    const canAdd = isAdmin || isPersonalOwner || canManageViaCap;

    const load = async () => {
        if (!projectId) return;
        try {
            const [pRes, uRes] = await Promise.all([
                api.get(`/projects/${projectId}/participants`),
                api.get('/users'),
            ]);
            setParticipants(pRes.data.participants);
            setUsers(uRes.data.users);
        } catch {
            toast.error('Failed to load participants');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId]);

    // Refetch participants when other clients add/remove someone in real time.
    useEffect(() => {
        if (!projectId) return undefined;
        const off = subscribe('participants:changed', (payload) => {
            if (payload?.projectId === projectId) load();
        });
        return off;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId, subscribe]);

    const memberIds = useMemo(
        () => new Set(participants.map((p) => p.id)),
        [participants],
    );

    // Strip a leading "@" the user may have typed so the search just works.
    const rawQuery = query.startsWith('@') ? query.slice(1) : query;

    const candidates = useMemo(() => {
        const needle = rawQuery.trim().toLowerCase();
        return users
            .filter((u) => !memberIds.has(u.id))
            .filter((u) => {
                if (!needle) return true;
                const local = (u.email || '').split('@')[0].toLowerCase();
                return (
                    u.name.toLowerCase().includes(needle) ||
                    (u.email || '').toLowerCase().includes(needle) ||
                    local.startsWith(needle)
                );
            })
            .slice(0, 8);
    }, [users, memberIds, rawQuery]);

    useEffect(() => {
        setHighlight(0);
    }, [query, showPicker]);

    const openPicker = () => {
        setShowPicker(true);
        setQuery('@');
        setTimeout(() => inputRef.current?.focus(), 0);
    };
    const closePicker = () => {
        setShowPicker(false);
        setQuery('');
    };

    const addUser = async (user) => {
        if (!user || adding) return;
        setAdding(true);
        try {
            await api.post(`/projects/${projectId}/participants`, {
                userId: user.id,
            });
            toast.success(`${user.name} added`);
            await load();
            onChanged?.();
            closePicker();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add participant');
        } finally {
            setAdding(false);
        }
    };

    const removeUser = async (user) => {
        const confirmText =
            user.id === currentUser?.id
                ? 'Leave this project? You will no longer see notifications or chat.'
                : `Remove ${user.name} from this project?`;
        if (!window.confirm(confirmText)) return;
        try {
            await api.delete(`/projects/${projectId}/participants/${user.id}`);
            toast.success(
                user.id === currentUser?.id ? 'You left the project' : 'Participant removed',
            );
            await load();
            onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not remove');
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(candidates.length - 1, h + 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(0, h - 1));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const pick = candidates[highlight];
            if (pick) addUser(pick);
        } else if (e.key === 'Escape') {
            closePicker();
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
                        <UsersIcon className="h-4 w-4 text-muted-foreground" />
                        <CardTitle className="text-base">
                            Participants
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                                ({participants.length})
                            </span>
                        </CardTitle>
                    </button>
                ) : (
                    <CardTitle className="text-base">
                        Participants
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                            ({participants.length})
                        </span>
                    </CardTitle>
                )}
                {canAdd && !showPicker && !collapsed && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={openPicker}
                    >
                        <UserPlus className="h-3.5 w-3.5" />
                        Add
                    </Button>
                )}
            </CardHeader>
            {!collapsed && (
            <CardContent className="space-y-3">
                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading...</p>
                ) : (
                    <ul className="space-y-1.5">
                        {participants.map((p) => {
                            const online = isOnline(p.id);
                            const isMe = p.id === currentUser?.id;
                            const isProjectOwner = p.id === project?.ownerId;
                            // Removing participants: admins, personal-
                            // project owners, or the `project:participants:
                            // manage` capability holders. The project owner
                            // themselves still can't be removed — transfer
                            // ownership first (server enforces).
                            const canRemove =
                                !isProjectOwner &&
                                (isAdmin || isPersonalOwner || canManageViaCap);
                            return (
                                <li
                                    key={p.id}
                                    className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/50"
                                >
                                    <div className="relative">
                                        <Avatar className="h-7 w-7">
                                            {p.avatarUrl && (
                                                <AvatarImage
                                                    src={resolveAssetUrl(
                                                        p.avatarUrl,
                                                    )}
                                                    alt={p.name}
                                                />
                                            )}
                                            <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                                                {initials(p.name)}
                                            </AvatarFallback>
                                        </Avatar>
                                        <span
                                            className={cn(
                                                'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-background',
                                                online
                                                    ? 'bg-emerald-500'
                                                    : 'bg-muted-foreground/40',
                                            )}
                                            aria-hidden
                                        />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm">
                                            {p.name}
                                            {isMe && (
                                                <span className="ml-1 text-xs text-muted-foreground">
                                                    (you)
                                                </span>
                                            )}
                                        </p>
                                        <p className="truncate text-[11px] text-muted-foreground">
                                            {p.email}
                                        </p>
                                    </div>
                                    {isProjectOwner && (
                                        <Badge
                                            variant="secondary"
                                            className="gap-1 text-[10px]"
                                        >
                                            <Crown className="h-3 w-3" />
                                            Owner
                                        </Badge>
                                    )}
                                    {canRemove && (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className={cn(
                                                'h-6 w-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100',
                                                isMe && 'opacity-100',
                                            )}
                                            onClick={() => removeUser(p)}
                                            title={
                                                isMe
                                                    ? 'Leave project'
                                                    : 'Remove participant'
                                            }
                                        >
                                            {isMe ? (
                                                <LogOut className="h-3.5 w-3.5" />
                                            ) : (
                                                <Trash2 className="h-3.5 w-3.5" />
                                            )}
                                        </Button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}

                {showPicker && (
                    <div className="space-y-2 rounded-md border bg-background p-2">
                        <div className="flex items-center gap-2">
                            <Input
                                ref={inputRef}
                                value={query}
                                placeholder="Type @ followed by a name..."
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={handleKeyDown}
                                className="h-8 text-sm"
                            />
                            <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={closePicker}
                            >
                                <X className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                        <div className="max-h-[180px] overflow-y-auto">
                            {candidates.length === 0 ? (
                                <p className="px-1 py-2 text-xs text-muted-foreground">
                                    {rawQuery
                                        ? 'No matching users.'
                                        : 'Start typing a name or email.'}
                                </p>
                            ) : (
                                <ul>
                                    {candidates.map((u, i) => (
                                        <li key={u.id}>
                                            <button
                                                type="button"
                                                onMouseEnter={() => setHighlight(i)}
                                                onClick={() => addUser(u)}
                                                disabled={adding}
                                                className={cn(
                                                    'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm',
                                                    i === highlight
                                                        ? 'bg-accent'
                                                        : 'hover:bg-accent/50',
                                                )}
                                            >
                                                <div className="relative">
                                                    <Avatar className="h-6 w-6">
                                                        {u.avatarUrl && (
                                                            <AvatarImage
                                                                src={resolveAssetUrl(
                                                                    u.avatarUrl,
                                                                )}
                                                                alt={u.name}
                                                            />
                                                        )}
                                                        <AvatarFallback className="bg-primary/10 text-[9px] text-primary">
                                                            {initials(u.name)}
                                                        </AvatarFallback>
                                                    </Avatar>
                                                    <span
                                                        className={cn(
                                                            'absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full border border-background',
                                                            isOnline(u.id)
                                                                ? 'bg-emerald-500'
                                                                : 'bg-muted-foreground/40',
                                                        )}
                                                    />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <p className="truncate text-xs font-medium">
                                                        {u.name}
                                                    </p>
                                                    <p className="truncate text-[10px] text-muted-foreground">
                                                        {u.email}
                                                    </p>
                                                </div>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                            Enter to add · Esc to cancel
                        </p>
                    </div>
                )}

                {!iAmParticipant && !showPicker && (
                    <p className="rounded-md border border-dashed bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
                        You're not a participant on this project. You won't get
                        notifications about it and you can't open the chat.
                    </p>
                )}
            </CardContent>
            )}
        </Card>
    );
}
