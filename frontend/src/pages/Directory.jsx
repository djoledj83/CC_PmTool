// Read-only people roster — rendered by the /users route when the
// signed-in user is NOT an admin (see Users.jsx). Admins fall
// through to the full management table on the same URL, so there's
// a single sidebar entry, single URL, and single mental model for
// everyone.
//
// Data source: GET /api/users (non-admin callers automatically get the
// trimmed `directoryUser` payload — see backend/src/routes/users.js).
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
    Briefcase,
    Building2,
    Loader2,
    MessageSquare,
    Search,
    ShieldCheck,
    UserCircle,
    UsersRound,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { ROLE_LABELS } from '@/lib/capabilities';
import { useAuth } from '@/contexts/AuthContext';
import { TopBar } from '@/components/TopBar';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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

// Visual tone per role — mirrors the chips on UserProfile so the
// directory feels like the same product surface.
const ROLE_TONE = {
    ADMIN: 'bg-primary/15 text-primary border border-primary/30',
    MANAGER:
        'bg-sky-500/15 text-sky-700 border border-sky-500/30 dark:text-sky-300',
    APP_MODERATOR:
        'bg-violet-500/15 text-violet-700 border border-violet-500/30 dark:text-violet-300',
    USER: 'bg-muted text-muted-foreground border border-border',
};

// Hide PENDING / SUSPENDED accounts from the non-admin directory:
// admins still see the full list via /users, regular USERs only need
// people they can actually collaborate with.
const VISIBLE_STATUSES = new Set(['ACTIVE']);

const ROLE_FILTERS = [
    { value: 'ALL', label: 'All roles' },
    { value: 'ADMIN', label: 'Admins' },
    { value: 'MANAGER', label: 'Managers' },
    { value: 'APP_MODERATOR', label: 'App moderators' },
    { value: 'USER', label: 'Users' },
];

export default function Directory() {
    const { user: me } = useAuth();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();

    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState(searchParams.get('q') || '');
    const [roleFilter, setRoleFilter] = useState(
        ROLE_FILTERS.find((r) => r.value === searchParams.get('role'))?.value
            || 'ALL',
    );

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        api.get('/users')
            .then((res) => {
                if (cancelled) return;
                setUsers(Array.isArray(res.data?.users) ? res.data.users : []);
            })
            .catch((err) => {
                if (cancelled) return;
                setError(
                    err?.response?.data?.error
                        || err?.response?.data?.message
                        || 'Could not load the directory',
                );
            })
            .finally(() => {
                if (cancelled) return;
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Keep filters in the URL so the back button restores state and
    // links can deep-link to a specific filter (e.g. /users?role=MANAGER).
    useEffect(() => {
        const next = new URLSearchParams(searchParams);
        if (query) next.set('q', query);
        else next.delete('q');
        if (roleFilter && roleFilter !== 'ALL') next.set('role', roleFilter);
        else next.delete('role');
        const nextStr = next.toString();
        if (nextStr !== searchParams.toString()) {
            setSearchParams(next, { replace: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, roleFilter]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return users
            .filter((u) => {
                // status may be null/undefined for older API versions
                // — be permissive and let those through.
                if (u.status && !VISIBLE_STATUSES.has(u.status)) return false;
                if (roleFilter !== 'ALL' && u.role !== roleFilter) return false;
                if (!q) return true;
                const hay = [
                    u.name,
                    u.email,
                    u.position,
                    u.businessUnit?.name,
                ]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();
                return hay.includes(q);
            })
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }, [users, query, roleFilter]);

    const counts = useMemo(() => {
        const visible = users.filter(
            (u) => !u.status || VISIBLE_STATUSES.has(u.status),
        );
        const byRole = visible.reduce((acc, u) => {
            const k = u.role || 'USER';
            acc[k] = (acc[k] || 0) + 1;
            return acc;
        }, {});
        return { total: visible.length, byRole };
    }, [users]);

    return (
        <>
            <TopBar title="Users" />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="mx-auto flex max-w-6xl flex-col gap-4">
                    {/* Filter bar ----------------------------------- */}
                    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 shadow-sm sm:flex-row sm:items-center">
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search by name, email, position, business unit…"
                                className="h-9 pl-8 pr-8"
                            />
                            {query && (
                                <button
                                    type="button"
                                    onClick={() => setQuery('')}
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                                    aria-label="Clear search"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </button>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-1">
                            {ROLE_FILTERS.map((r) => (
                                <button
                                    key={r.value}
                                    type="button"
                                    onClick={() => setRoleFilter(r.value)}
                                    className={cn(
                                        'rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                                        roleFilter === r.value
                                            ? 'border-primary bg-primary/10 text-primary'
                                            : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
                                    )}
                                >
                                    {r.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Quick stats line ------------------------------ */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                            <UsersRound className="h-3 w-3" />
                            {counts.total} active teammate
                            {counts.total === 1 ? '' : 's'}
                        </span>
                        {Object.entries(counts.byRole)
                            .sort((a, b) => b[1] - a[1])
                            .map(([role, n]) => (
                                <span
                                    key={role}
                                    className="inline-flex items-center gap-1"
                                >
                                    <span
                                        className={cn(
                                            'inline-block h-1.5 w-1.5 rounded-full',
                                            role === 'ADMIN' && 'bg-primary',
                                            role === 'MANAGER' && 'bg-sky-500',
                                            role === 'APP_MODERATOR'
                                                && 'bg-violet-500',
                                            role === 'USER'
                                                && 'bg-muted-foreground/60',
                                        )}
                                    />
                                    {ROLE_LABELS[role] || role}: {n}
                                </span>
                            ))}
                    </div>

                    {/* Grid ----------------------------------------- */}
                    {loading ? (
                        <div className="flex items-center justify-center rounded-lg border bg-card p-12 shadow-sm">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                    ) : error ? (
                        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center text-sm text-destructive">
                            {error}
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground shadow-sm">
                            No teammates match those filters.
                        </div>
                    ) : (
                        <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
                            <Table>
                                <TableHeader>
                                    <TableRow className="bg-muted/60 hover:bg-muted/60">
                                        <TableHead className="w-[min(280px,40%)]">
                                            Name
                                        </TableHead>
                                        <TableHead className="hidden sm:table-cell">
                                            Email
                                        </TableHead>
                                        <TableHead>Role</TableHead>
                                        <TableHead className="hidden md:table-cell">
                                            Position
                                        </TableHead>
                                        <TableHead className="hidden lg:table-cell">
                                            Business unit
                                        </TableHead>
                                        <TableHead className="w-[120px] text-right">
                                            Actions
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filtered.map((u, idx) => (
                                        <DirectoryRow
                                            key={u.id}
                                            user={u}
                                            isSelf={me?.id === u.id}
                                            zebra={idx % 2 === 1}
                                            onOpenProfile={() =>
                                                navigate(`/users/${u.id}`)
                                            }
                                            onMessage={() =>
                                                navigate(`/messages?dm=${u.id}`)
                                            }
                                        />
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </div>
            </main>
        </>
    );
}

function DirectoryRow({
    user,
    isSelf,
    zebra,
    onOpenProfile,
    onMessage,
}) {
    const roleLabel = ROLE_LABELS[user.role] || user.role || 'User';
    const roleTone = ROLE_TONE[user.role] || ROLE_TONE.USER;
    const profileTo = `/users/${user.id}`;

    return (
        <TableRow
            className={cn(
                'cursor-pointer',
                zebra ? 'bg-muted/30' : 'bg-card',
                'hover:bg-accent/50',
            )}
            onClick={onOpenProfile}
        >
            <TableCell className="font-medium">
                <div className="flex items-center gap-3">
                    <Link
                        to={profileTo}
                        onClick={(e) => e.stopPropagation()}
                        className="shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        title={`Open ${user.name}'s profile`}
                    >
                        <Avatar className="h-9 w-9 border bg-muted">
                            <AvatarImage
                                src={resolveAssetUrl(user.avatarUrl)}
                                alt=""
                            />
                            <AvatarFallback className="text-xs">
                                {initials(user.name || user.email)}
                            </AvatarFallback>
                        </Avatar>
                    </Link>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <Link
                                to={profileTo}
                                onClick={(e) => e.stopPropagation()}
                                className="truncate text-sm font-semibold hover:text-primary hover:underline"
                            >
                                {user.name}
                            </Link>
                            {isSelf && (
                                <Badge
                                    variant="outline"
                                    className="border-emerald-500/40 bg-emerald-500/10 text-[9px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300"
                                >
                                    You
                                </Badge>
                            )}
                        </div>
                        {user.email && (
                            <p className="truncate text-xs text-muted-foreground sm:hidden">
                                {user.email}
                            </p>
                        )}
                    </div>
                </div>
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
                {user.email ? (
                    <a
                        href={`mailto:${user.email}`}
                        onClick={(e) => e.stopPropagation()}
                        className="truncate hover:text-foreground hover:underline"
                    >
                        {user.email}
                    </a>
                ) : (
                    '—'
                )}
            </TableCell>
            <TableCell>
                <Badge
                    variant="outline"
                    className={cn(
                        'px-1.5 py-0 text-[10px] font-medium',
                        roleTone,
                    )}
                >
                    {user.role === 'ADMIN' && (
                        <ShieldCheck className="mr-0.5 h-3 w-3" />
                    )}
                    {roleLabel}
                </Badge>
            </TableCell>
            <TableCell className="hidden text-muted-foreground md:table-cell">
                {user.position ? (
                    <span className="inline-flex max-w-[200px] items-center gap-1 truncate">
                        <Briefcase className="h-3 w-3 shrink-0" />
                        {user.position}
                    </span>
                ) : (
                    '—'
                )}
            </TableCell>
            <TableCell className="hidden text-muted-foreground lg:table-cell">
                {user.businessUnit?.name ? (
                    <span className="inline-flex max-w-[200px] items-center gap-1 truncate">
                        <Building2 className="h-3 w-3 shrink-0" />
                        {user.businessUnit.name}
                    </span>
                ) : (
                    '—'
                )}
            </TableCell>
            <TableCell className="text-right">
                <div
                    className="flex items-center justify-end gap-1"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                >
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        asChild
                    >
                        <Link to={profileTo}>
                            <UserCircle className="mr-1 h-3.5 w-3.5" />
                            Profile
                        </Link>
                    </Button>
                    {!isSelf && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={onMessage}
                        >
                            <MessageSquare className="mr-1 h-3.5 w-3.5" />
                            Message
                        </Button>
                    )}
                </div>
            </TableCell>
        </TableRow>
    );
}
