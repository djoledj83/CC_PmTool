import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
    BadgeCheck,
    Ban,
    Check,
    KeyRound,
    MessageSquare,
    MoreHorizontal,
    Pencil,
    Plus,
    Search,
    TestTube2,
    Trash2,
    Users as UsersIcon,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, flashDeepLinkTarget, initials, resolveAssetUrl } from '@/lib/utils';
import { TopBar } from '@/components/TopBar';
import { Pagination, usePagination } from '@/components/Pagination';
import { UserFormDialog } from '@/components/UserFormDialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import AvatarLightbox from '@/components/AvatarLightbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import Directory from '@/pages/Directory';

function formatDate(d) {
    if (!d) return '—';
    return format(new Date(d), 'MMM d, yyyy');
}

function formatDateTime(d) {
    if (!d) return '—';
    return format(new Date(d), "MMM d, yyyy 'at' h:mm a");
}

function relativeFromNow(d) {
    if (!d) return null;
    const diff = Date.now() - new Date(d).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    if (day < 30) return `${Math.floor(day / 7)}w ago`;
    return format(new Date(d), 'MMM d, yyyy');
}

const STATUS_FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'pending', label: 'Pending', value: 'PENDING' },
    { id: 'active', label: 'Active', value: 'ACTIVE' },
    { id: 'suspended', label: 'Suspended', value: 'SUSPENDED' },
];

// Surfaces pending users above everyone else, then suspended, then active.
const STATUS_RANK = { PENDING: 0, SUSPENDED: 1, ACTIVE: 2 };

// Role filter options for the Users page dropdown.
const ROLE_FILTERS = [
    { id: 'all', label: 'All roles', value: null },
    { id: 'ADMIN', label: 'Admin', value: 'ADMIN' },
    { id: 'MANAGER', label: 'Manager', value: 'MANAGER' },
    { id: 'APP_MODERATOR', label: 'App moderator', value: 'APP_MODERATOR' },
    { id: 'USER', label: 'User', value: 'USER' },
    { id: 'REQUESTER', label: 'Requester', value: 'REQUESTER' },
];

// Read-only "view as" menu items for the admin actions dropdown.
// We don't issue a real impersonation token — instead we deep-link
// to pages that already accept admin-scoped `?userId=…` (the time
// tracking and activity feed endpoints both honour this). This
// keeps the audit trail unambiguous: the admin's session is the one
// actually making the requests; nothing they do can write under
// the other user's identity.
function ViewAsMenuItems({ userId, userName }) {
    const navigate = useNavigate();
    const firstName = userName?.split(' ')[0] || 'user';
    return (
        <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                View as {firstName} (read-only)
            </DropdownMenuLabel>
            <DropdownMenuItem
                onClick={() => navigate(`/time?userId=${userId}`)}
            >
                <TestTube2 className="h-4 w-4" />
                Their time entries
            </DropdownMenuItem>
            <DropdownMenuItem
                onClick={() => navigate(`/activities?userId=${userId}`)}
            >
                <TestTube2 className="h-4 w-4" />
                Their activity feed
            </DropdownMenuItem>
        </>
    );
}

function StatusBadge({ status }) {
    const s = status || 'ACTIVE';
    const styles = {
        PENDING:
            'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400',
        ACTIVE:
            'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400',
        SUSPENDED:
            'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-500/10 dark:text-rose-400',
    }[s];
    return (
        <Badge variant="outline" className={cn('text-[10px] font-medium', styles)}>
            {s.toLowerCase()}
        </Badge>
    );
}

export default function Users() {
    const { user: currentUser } = useAuth();
    const isAdmin = currentUser?.role === 'ADMIN';
    // Non-admins land on the read-only people roster — same URL,
    // same sidebar entry, different surface. Admin keeps the full
    // management table below (create, approve, suspend, role,
    // capabilities, audit). One mental model, one entry point.
    if (!isAdmin) return <Directory />;
    return <UsersAdmin />;
}

function UsersAdmin() {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const { user: currentUser, updateCurrentUser, refreshCurrentUser } = useAuth();
    const { refreshCounts } = useRealtime();
    const isAdmin = currentUser?.role === 'ADMIN';

    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    // Avatar parallax lightbox — { src, name, subtitle } or null.
    const [lightbox, setLightbox] = useState(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [pendingAvatar, setPendingAvatar] = useState(null);
    const [resetUrl, setResetUrl] = useState(null);
    const [query, setQuery] = useState('');

    const statusFilter = searchParams.get('status') || 'all';
    const roleFilter = searchParams.get('role') || 'all';
    const focusUserId = searchParams.get('focus') || null;
    const editUserId = searchParams.get('edit') || null;

    // When the page is loaded with ?focus=<id> (e.g. from the Insights
    // dashboard or a notification deep-link) scroll the matching row
    // into view and run the shared "you arrived from a deep link"
    // highlight so the admin can immediately spot the right row.
    useEffect(() => {
        if (!focusUserId) return undefined;
        const el = document.getElementById(`user-row-${focusUserId}`);
        if (!el) return undefined;
        return flashDeepLinkTarget(el);
    }, [focusUserId, users]);

    // When the page is loaded with ?edit=<id> (the "Edit" button on a
    // user's profile page navigates here) open the edit dialog for that
    // user and drop the param from the URL so a refresh or back-button
    // doesn't re-open it. We wait for the users list to load before
    // resolving, otherwise the lookup races the initial fetch.
    useEffect(() => {
        if (!editUserId) return;
        if (loading) return;
        const target = users.find((u) => u.id === editUserId);
        if (target) {
            setEditing(target);
            setPendingAvatar(null);
            setDialogOpen(true);
        } else {
            toast.error('User no longer exists');
        }
        const next = new URLSearchParams(searchParams);
        next.delete('edit');
        setSearchParams(next, { replace: true });
    }, [editUserId, loading, users]);

    const setStatusFilter = (id) => {
        const next = new URLSearchParams(searchParams);
        if (id === 'all') next.delete('status');
        else next.set('status', id);
        setSearchParams(next, { replace: true });
    };

    const setRoleFilter = (id) => {
        const next = new URLSearchParams(searchParams);
        if (id === 'all') next.delete('role');
        else next.set('role', id);
        setSearchParams(next, { replace: true });
    };

    const startDm = async (user) => {
        try {
            const { data } = await api.post('/conversations/dm', {
                userId: user.id,
            });
            navigate(`/messages?c=${data.conversation.id}`);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not open chat');
        }
    };

    const load = async () => {
        try {
            const { data } = await api.get('/users');
            setUsers(data.users);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Failed to load users');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const handleCreate = () => {
        setEditing(null);
        setPendingAvatar(null);
        setDialogOpen(true);
    };

    const handleEdit = (user) => {
        setEditing(user);
        setPendingAvatar(null);
        setDialogOpen(true);
    };

    const handleDelete = async (user) => {
        const verb = user.status === 'PENDING' ? 'Reject' : 'Delete';
        if (
            !window.confirm(
                `${verb} user "${user.name}"? This permanently removes the account.`,
            )
        ) {
            return;
        }
        try {
            await api.delete(`/users/${user.id}`);
            toast.success(verb === 'Reject' ? 'Registration rejected' : 'User deleted');
            setUsers((prev) => prev.filter((u) => u.id !== user.id));
            if (user.status === 'PENDING') refreshCounts();
        } catch (err) {
            toast.error(err.response?.data?.error || `Could not ${verb.toLowerCase()} user`);
        }
    };

    const handleApprove = async (user) => {
        try {
            const { data } = await api.post(`/users/${user.id}/approve`);
            const verb = user.status === 'PENDING' ? 'approved' : 'reactivated';
            toast.success(`${data.user.name} ${verb}`);
            setUsers((prev) => prev.map((u) => (u.id === user.id ? data.user : u)));
            refreshCounts();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not approve user');
        }
    };

    const handleSuspend = async (user) => {
        if (!window.confirm(`Suspend "${user.name}"? They will be unable to sign in.`))
            return;
        try {
            const { data } = await api.post(`/users/${user.id}/suspend`);
            toast.success(`${data.user.name} suspended`);
            setUsers((prev) => prev.map((u) => (u.id === user.id ? data.user : u)));
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not suspend user');
        }
    };

    const handleSubmit = async (values) => {
        setSubmitting(true);
        try {
            if (editing) {
                const { data } = await api.patch(`/users/${editing.id}`, values);
                toast.success('User updated');
                setUsers((prev) =>
                    prev.map((u) => (u.id === editing.id ? data.user : u)),
                );
                // If an admin just changed the currently-logged-in
                // user's own capabilities/role, re-run the token
                // refresh so the AuthContext gets the fresh user
                // object (including effectiveCapabilities) without
                // requiring a re-login.
                if (editing.id === currentUser?.id) {
                    await refreshCurrentUser();
                }
                setDialogOpen(false);
            } else {
                const { data } = await api.post('/users', values);

                if (pendingAvatar) {
                    const fd = new FormData();
                    fd.append('avatar', pendingAvatar);
                    try {
                        const res = await api.post(
                            `/users/${data.user.id}/avatar`,
                            fd,
                            {
                                headers: {
                                    'Content-Type': 'multipart/form-data',
                                },
                            },
                        );
                        setUsers((prev) => [...prev, res.data.user]);
                    } catch {
                        toast.error('User created, but avatar upload failed');
                        setUsers((prev) => [...prev, data.user]);
                    }
                } else {
                    setUsers((prev) => [...prev, data.user]);
                }

                toast.success('User created');
                setDialogOpen(false);
            }
        } catch (err) {
            toast.error(err.response?.data?.error || 'Save failed');
        } finally {
            setSubmitting(false);
        }
    };

    const handleAvatarChanged = ({ user, pendingFile } = {}) => {
        if (user) {
            setUsers((prev) => prev.map((u) => (u.id === user.id ? user : u)));
            if (editing?.id === user.id) setEditing(user);
        }
        if (pendingFile !== undefined) setPendingAvatar(pendingFile);
    };

    const handleSendReset = async (user) => {
        try {
            const { data } = await api.post(`/users/${user.id}/reset-link`);
            setResetUrl(data.resetUrl);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not generate link');
        }
    };

    const counts = useMemo(() => {
        const c = { all: users.length, pending: 0, active: 0, suspended: 0 };
        for (const u of users) {
            const s = (u.status || 'ACTIVE').toLowerCase();
            if (c[s] !== undefined) c[s] += 1;
        }
        return c;
    }, [users]);

    const filteredUsers = useMemo(() => {
        const targetStatus = STATUS_FILTERS.find((f) => f.id === statusFilter)?.value;
        const targetRole = ROLE_FILTERS.find((f) => f.id === roleFilter)?.value;
        let list = targetStatus
            ? users.filter((u) => (u.status || 'ACTIVE') === targetStatus)
            : users;
        if (targetRole) {
            list = list.filter((u) => (u.role || 'USER') === targetRole);
        }
        const q = query.trim().toLowerCase();
        if (q) {
            list = list.filter((u) =>
                [u.name, u.email, u.phone, u.position]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase()
                    .includes(q),
            );
        }

        return [...list].sort((a, b) => {
            const ra = STATUS_RANK[a.status || 'ACTIVE'] ?? 9;
            const rb = STATUS_RANK[b.status || 'ACTIVE'] ?? 9;
            if (ra !== rb) return ra - rb;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });
    }, [users, statusFilter, roleFilter, query]);

    const { page, setPage, pageSize, total, totalPages, pageItems } =
        usePagination(filteredUsers, 10);

    const headerActions = useMemo(
        () =>
            isAdmin ? (
                <Button onClick={handleCreate} className="gap-2">
                    <Plus className="h-4 w-4" />
                    New user
                </Button>
            ) : null,
        [isAdmin],
    );

    return (
        <>
            <TopBar title="Users" actions={headerActions} />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                {isAdmin && counts.pending > 0 && statusFilter !== 'pending' && (
                    <div className="mb-4 flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
                        <div className="flex items-center gap-2 text-amber-900 dark:text-amber-200">
                            <BadgeCheck className="h-4 w-4" />
                            <span>
                                {counts.pending} user
                                {counts.pending === 1 ? '' : 's'} waiting for your
                                approval.
                            </span>
                        </div>
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-7"
                            onClick={() => setStatusFilter('pending')}
                        >
                            Review pending
                        </Button>
                    </div>
                )}

                {isAdmin && (
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                    <div className="flex flex-wrap items-center gap-1 rounded-md border bg-card p-1 text-sm shadow-sm">
                        {STATUS_FILTERS.map((f) => {
                            const active = f.id === statusFilter;
                            const count =
                                f.id === 'all' ? counts.all : counts[f.id] ?? 0;
                            return (
                                <button
                                    key={f.id}
                                    type="button"
                                    onClick={() => setStatusFilter(f.id)}
                                    className={cn(
                                        'flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
                                        active
                                            ? 'bg-primary text-primary-foreground'
                                            : 'text-muted-foreground hover:bg-accent',
                                    )}
                                >
                                    {f.label}
                                    <span
                                        className={cn(
                                            'rounded-full px-1.5 text-[10px] leading-tight',
                                            active
                                                ? 'bg-primary-foreground/20 text-primary-foreground'
                                                : 'bg-muted text-muted-foreground',
                                        )}
                                    >
                                        {count}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <Select value={roleFilter} onValueChange={setRoleFilter}>
                        <SelectTrigger className="h-9 w-[170px] text-sm">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {ROLE_FILTERS.map((r) => (
                                <SelectItem key={r.id} value={r.id}>
                                    {r.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <div className="relative w-full sm:w-64">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search name, email, phone…"
                            className="h-9 pl-9 pr-8 text-sm"
                        />
                        {query && (
                            <button
                                type="button"
                                onClick={() => setQuery('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                aria-label="Clear search"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                    </div>
                )}

                <div className="rounded-lg border bg-card shadow-sm">
                    {loading ? (
                        <div className="p-10 text-center text-sm text-muted-foreground">
                            Loading users...
                        </div>
                    ) : filteredUsers.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-3 p-16 text-center">
                            <UsersIcon className="h-10 w-10 text-muted-foreground" />
                            <div>
                                <p className="font-medium">
                                    {statusFilter === 'pending'
                                        ? 'No users waiting for approval'
                                        : statusFilter === 'suspended'
                                            ? 'No suspended users'
                                            : 'No users yet'}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    {isAdmin
                                        ? statusFilter === 'all'
                                            ? 'Create your first user to get started.'
                                            : 'Try a different filter.'
                                        : 'Ask an administrator to invite users.'}
                                </p>
                            </div>
                            {isAdmin && statusFilter === 'all' && (
                                <Button onClick={handleCreate} className="mt-2 gap-2">
                                    <Plus className="h-4 w-4" />
                                    New user
                                </Button>
                            )}
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow className="hover:bg-transparent">
                                    <TableHead className="w-[28%]">Name</TableHead>
                                    <TableHead>Email</TableHead>
                                    <TableHead className="w-[100px]">Status</TableHead>
                                    <TableHead className="w-[90px]">Role</TableHead>
                                    <TableHead>Phone</TableHead>
                                    <TableHead className="w-[90px]">Projects</TableHead>
                                    <TableHead className="w-[140px]">
                                        Last login
                                    </TableHead>
                                    <TableHead className="w-[80px]" />
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {pageItems.map((u) => {
                                    const status = u.status || 'ACTIVE';
                                    const isMe = currentUser?.id === u.id;
                                    const canEdit = isAdmin || isMe;
                                    const canDelete = isAdmin && !isMe;
                                    const canSendReset = isAdmin;
                                    const canMessage = !isMe && status === 'ACTIVE';
                                    const canApprove =
                                        isAdmin && status !== 'ACTIVE';
                                    const canSuspend =
                                        isAdmin && !isMe && status === 'ACTIVE';
                                    const showMenu =
                                        canEdit ||
                                        canDelete ||
                                        canSendReset ||
                                        canMessage ||
                                        canApprove ||
                                        canSuspend;

                                    return (
                                        <TableRow
                                            key={u.id}
                                            id={`user-row-${u.id}`}
                                            className={cn(
                                                status === 'PENDING' &&
                                                    'bg-amber-50/50 dark:bg-amber-500/5',
                                            )}
                                        >
                                            <TableCell className="font-medium">
                                                <div
                                                    className="group flex cursor-pointer items-center gap-3"
                                                    onClick={() =>
                                                        navigate(
                                                            `/users/${u.id}`,
                                                        )
                                                    }
                                                    title="Open profile"
                                                >
                                                    <span
                                                        className={cn(
                                                            'inline-block rounded-full',
                                                            u.avatarUrl &&
                                                                'cursor-zoom-in transition-shadow hover:ring-2 hover:ring-primary/50',
                                                        )}
                                                        title={
                                                            u.avatarUrl
                                                                ? 'View photo'
                                                                : undefined
                                                        }
                                                        onClick={(e) => {
                                                            // Only photos open the viewer;
                                                            // otherwise let the row open the
                                                            // full profile as before.
                                                            if (!u.avatarUrl)
                                                                return;
                                                            e.stopPropagation();
                                                            setLightbox({
                                                                src: resolveAssetUrl(
                                                                    u.avatarUrl,
                                                                ),
                                                                name: u.name,
                                                                subtitle:
                                                                    u.position ||
                                                                    u.email,
                                                            });
                                                        }}
                                                    >
                                                    <Avatar className="h-10 w-10">
                                                        {u.avatarUrl && (
                                                            <AvatarImage
                                                                src={resolveAssetUrl(
                                                                    u.avatarUrl,
                                                                )}
                                                                alt={u.name}
                                                            />
                                                        )}
                                                        <AvatarFallback className="bg-primary/10 text-xs text-primary">
                                                            {initials(u.name)}
                                                        </AvatarFallback>
                                                    </Avatar>
                                                    </span>
                                                    <div className="min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className="truncate group-hover:text-primary group-hover:underline">
                                                                {u.name}
                                                            </span>
                                                            {isMe && (
                                                                <Badge
                                                                    variant="secondary"
                                                                    className="text-[10px]"
                                                                >
                                                                    You
                                                                </Badge>
                                                            )}
                                                        </div>
                                                        {u.position && (
                                                            <div className="truncate text-xs text-muted-foreground">
                                                                {u.position}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-muted-foreground">
                                                {u.email}
                                            </TableCell>
                                            <TableCell>
                                                <StatusBadge status={status} />
                                            </TableCell>
                                            <TableCell>
                                                <Badge
                                                    variant={
                                                        u.role === 'ADMIN'
                                                            ? 'default'
                                                            : u.role ===
                                                                  'MANAGER'
                                                              ? 'outline'
                                                              : 'secondary'
                                                    }
                                                    className={cn(
                                                        'text-[10px]',
                                                        u.role === 'MANAGER' &&
                                                            'border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-200',
                                                        u.role ===
                                                            'APP_MODERATOR' &&
                                                            'border-cyan-300 bg-cyan-100 text-cyan-800 dark:border-cyan-500/40 dark:bg-cyan-500/15 dark:text-cyan-200',
                                                    )}
                                                >
                                                    {u.role === 'APP_MODERATOR'
                                                        ? 'App moderator'
                                                        : u.role || 'USER'}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-muted-foreground">
                                                {u.phone || '—'}
                                            </TableCell>
                                            <TableCell className="text-muted-foreground">
                                                {u.projectCount ?? 0}
                                            </TableCell>
                                            <TableCell
                                                className="text-muted-foreground"
                                                title={`Joined ${formatDate(u.createdAt)}${u.lastLoginAt ? ` · Last login ${formatDateTime(u.lastLoginAt)}` : ''}`}
                                            >
                                                {u.lastLoginAt ? (
                                                    <span className="text-xs">
                                                        {relativeFromNow(
                                                            u.lastLoginAt,
                                                        )}
                                                    </span>
                                                ) : (
                                                    <span className="text-xs italic">
                                                        Never
                                                    </span>
                                                )}
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex items-center justify-end gap-1">
                                                    {isAdmin && status === 'PENDING' && (
                                                        <Button
                                                            size="sm"
                                                            variant="default"
                                                            className="h-7 gap-1 px-2 text-xs"
                                                            onClick={() => handleApprove(u)}
                                                        >
                                                            <Check className="h-3.5 w-3.5" />
                                                            Approve
                                                        </Button>
                                                    )}
                                                    {showMenu && (
                                                        <DropdownMenu>
                                                            <DropdownMenuTrigger asChild>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-8 w-8"
                                                                >
                                                                    <MoreHorizontal className="h-4 w-4" />
                                                                </Button>
                                                            </DropdownMenuTrigger>
                                                            <DropdownMenuContent align="end">
                                                                <DropdownMenuItem
                                                                    onClick={() =>
                                                                        navigate(
                                                                            `/users/${u.id}`,
                                                                        )
                                                                    }
                                                                >
                                                                    <UsersIcon className="h-4 w-4" />
                                                                    Open profile
                                                                </DropdownMenuItem>
                                                                {canApprove && (
                                                                    <DropdownMenuItem
                                                                        onClick={() =>
                                                                            handleApprove(u)
                                                                        }
                                                                    >
                                                                        <BadgeCheck className="h-4 w-4" />
                                                                        {status ===
                                                                        'PENDING'
                                                                            ? 'Approve account'
                                                                            : 'Reactivate account'}
                                                                    </DropdownMenuItem>
                                                                )}
                                                                {canSuspend && (
                                                                    <DropdownMenuItem
                                                                        onClick={() =>
                                                                            handleSuspend(u)
                                                                        }
                                                                    >
                                                                        <Ban className="h-4 w-4" />
                                                                        Suspend
                                                                    </DropdownMenuItem>
                                                                )}
                                                                {canMessage && (
                                                                    <DropdownMenuItem
                                                                        onClick={() =>
                                                                            startDm(u)
                                                                        }
                                                                    >
                                                                        <MessageSquare className="h-4 w-4" />
                                                                        Message
                                                                    </DropdownMenuItem>
                                                                )}
                                                                {canEdit && (
                                                                    <DropdownMenuItem
                                                                        onClick={() =>
                                                                            handleEdit(u)
                                                                        }
                                                                    >
                                                                        <Pencil className="h-4 w-4" />
                                                                        Edit
                                                                    </DropdownMenuItem>
                                                                )}
                                                                {isAdmin && (
                                                                    <ViewAsMenuItems
                                                                        userId={u.id}
                                                                        userName={u.name}
                                                                    />
                                                                )}
                                                                {canSendReset && (
                                                                    <DropdownMenuItem
                                                                        onClick={() =>
                                                                            handleSendReset(
                                                                                u,
                                                                            )
                                                                        }
                                                                    >
                                                                        <KeyRound className="h-4 w-4" />
                                                                        Send reset link
                                                                    </DropdownMenuItem>
                                                                )}
                                                                {canDelete && (
                                                                    <DropdownMenuItem
                                                                        className="text-destructive focus:text-destructive"
                                                                        onClick={() =>
                                                                            handleDelete(u)
                                                                        }
                                                                    >
                                                                        <Trash2 className="h-4 w-4" />
                                                                        {status ===
                                                                        'PENDING'
                                                                            ? 'Reject'
                                                                            : 'Delete'}
                                                                    </DropdownMenuItem>
                                                                )}
                                                            </DropdownMenuContent>
                                                        </DropdownMenu>
                                                    )}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    )}
                    {!loading && total > 0 && (
                        <Pagination
                            page={page}
                            pageSize={pageSize}
                            total={total}
                            totalPages={totalPages}
                            onPageChange={setPage}
                        />
                    )}
                </div>
            </main>

            <UserFormDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                initialValues={editing}
                onSubmit={handleSubmit}
                submitting={submitting}
                onAvatarChanged={handleAvatarChanged}
            />

            <Dialog open={Boolean(resetUrl)} onOpenChange={() => setResetUrl(null)}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Password reset link</DialogTitle>
                        <DialogDescription>
                            Share this link with the user. It expires in 30 minutes.
                            (In production this would be sent by email.)
                        </DialogDescription>
                    </DialogHeader>
                    <div className="rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs break-all">
                        {resetUrl}
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => {
                                navigator.clipboard?.writeText(resetUrl || '');
                                toast.success('Copied to clipboard');
                            }}
                        >
                            Copy link
                        </Button>
                        <Button onClick={() => setResetUrl(null)}>Done</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <AvatarLightbox
                open={Boolean(lightbox)}
                src={lightbox?.src}
                name={lightbox?.name}
                subtitle={lightbox?.subtitle}
                onClose={() => setLightbox(null)}
            />
        </>
    );
}
