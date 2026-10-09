// Templates → Tickets → Wallboards: secret links for the big-screen ticket
// board (/wallboard/<key>). A link opens without signing in, so each
// screen gets its own link that can be paused, regenerated or deleted.
import { useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
    Check,
    Copy,
    ExternalLink,
    MoreHorizontal,
    Pause,
    Pencil,
    Play,
    Plus,
    RefreshCw,
    Trash2,
    Tv,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, copyText } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Let the menu close before a confirm() opens (Radix focus handling).
const later = (fn) => () => window.setTimeout(fn, 0);

const boardUrl = (key) =>
    `${typeof window !== 'undefined' ? window.location.origin : ''}/wallboard/${key}`;

function seen(at) {
    if (!at) return 'Never opened';
    try {
        return `Seen ${formatDistanceToNow(new Date(at), { addSuffix: true })}`;
    } catch {
        return '—';
    }
}

export function WallboardsManager() {
    const [boards, setBoards] = useState([]);
    const [loading, setLoading] = useState(true);
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(null); // { id, name }

    const load = async () => {
        try {
            const { data } = await api.get('/wallboard/boards');
            setBoards(data.boards || []);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not load wallboards.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const replace = (board) =>
        setBoards((prev) => prev.map((b) => (b.id === board.id ? board : b)));

    const create = async () => {
        const n = name.trim();
        if (!n) return;
        setBusy(true);
        try {
            const { data } = await api.post('/wallboard/boards', { name: n });
            setBoards((prev) => [...prev, data.board]);
            setName('');
            toast.success('Wallboard link created — copy it to the screen.');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not create the link.');
        } finally {
            setBusy(false);
        }
    };

    const copy = async (b) => {
        const ok = await copyText(boardUrl(b.key));
        if (ok) toast.success('Link copied');
        else toast.error('Could not copy — select the link and copy it by hand.');
    };

    const rename = async () => {
        const n = editing?.name.trim();
        if (!n) return;
        try {
            const { data } = await api.patch(`/wallboard/boards/${editing.id}`, { name: n });
            replace(data.board);
            setEditing(null);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not rename.');
        }
    };

    const setActive = async (b, active) => {
        try {
            const { data } = await api.patch(`/wallboard/boards/${b.id}`, { active });
            replace(data.board);
            toast.success(active ? 'Link active again' : 'Link paused — its screens go dark');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update.');
        }
    };

    const regenerate = async (b) => {
        if (
            !window.confirm(
                `Make a new link for "${b.name}"? The current link stops working right away — open the new one on the screen.`,
            )
        )
            return;
        try {
            const { data } = await api.post(`/wallboard/boards/${b.id}/regenerate`);
            replace(data.board);
            toast.success('New link ready — the old one no longer works.');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not regenerate.');
        }
    };

    const remove = async (b) => {
        if (!window.confirm(`Delete the wallboard "${b.name}"? Its link stops working.`)) return;
        try {
            await api.delete(`/wallboard/boards/${b.id}`);
            setBoards((prev) => prev.filter((x) => x.id !== b.id));
            toast.success('Wallboard deleted');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete.');
        }
    };

    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                A wallboard is a big-screen view of all open tickets — for a TV
                in the support room. Its link opens <strong>without signing
                in</strong>, so anyone who has the link sees the board: ticket
                code, title, type, priority, status, age and who is handling
                it. Internal tickets are never shown. New tickets pop up with a
                sound. Give every screen its own link; pause or regenerate it
                to cut a screen off.
            </p>

            <div className="flex flex-wrap items-center gap-2">
                <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && create()}
                    placeholder="Screen name, e.g. Support room TV"
                    maxLength={80}
                    className="h-9 max-w-sm"
                />
                <Button onClick={create} disabled={busy || !name.trim()} className="h-9 gap-1.5">
                    <Plus className="h-4 w-4" /> Create link
                </Button>
            </div>

            {loading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
            ) : boards.length === 0 ? (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    <Tv className="mx-auto mb-2 h-8 w-8 opacity-60" />
                    No wallboards yet — name a screen above and create its link.
                </div>
            ) : (
                <ul className="divide-y rounded-lg border">
                    {boards.map((b) => (
                        <li key={b.id} data-board={b.id} className={cn('flex flex-wrap items-center gap-3 px-3 py-2.5', !b.active && 'opacity-70')}>
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                <Tv className="h-4 w-4" />
                            </span>
                            <div className="min-w-[12rem] flex-1">
                                {editing?.id === b.id ? (
                                    <div className="flex items-center gap-1.5">
                                        <Input
                                            autoFocus
                                            value={editing.name}
                                            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') rename();
                                                if (e.key === 'Escape') setEditing(null);
                                            }}
                                            maxLength={80}
                                            className="h-8"
                                        />
                                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={rename} aria-label="Save name">
                                            <Check className="h-4 w-4" />
                                        </Button>
                                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditing(null)} aria-label="Cancel">
                                            <X className="h-4 w-4" />
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2">
                                        <span className="truncate font-medium">{b.name}</span>
                                        <span
                                            className={cn(
                                                'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                                b.active
                                                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                                    : 'bg-muted text-muted-foreground',
                                            )}
                                        >
                                            {b.active ? 'Active' : 'Paused'}
                                        </span>
                                    </div>
                                )}
                                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                                    <code className="truncate" title={boardUrl(b.key)}>
                                        {boardUrl(b.key)}
                                    </code>
                                    <span className="shrink-0">· {seen(b.lastSeenAt)}</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-1">
                                <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => copy(b)} disabled={!b.active}>
                                    <Copy className="h-3.5 w-3.5" /> Copy link
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 gap-1.5"
                                    onClick={() => window.open(boardUrl(b.key), '_blank', 'noopener')}
                                    disabled={!b.active}
                                >
                                    <ExternalLink className="h-3.5 w-3.5" /> Open
                                </Button>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="More actions">
                                            <MoreHorizontal className="h-4 w-4" />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-48">
                                        <DropdownMenuItem onSelect={() => setEditing({ id: b.id, name: b.name })}>
                                            <Pencil /> Rename
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onSelect={() => setActive(b, !b.active)}>
                                            {b.active ? <Pause /> : <Play />} {b.active ? 'Pause link' : 'Resume link'}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onSelect={later(() => regenerate(b))}>
                                            <RefreshCw /> New link
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            onSelect={later(() => remove(b))}
                                            className="text-destructive focus:text-destructive"
                                        >
                                            <Trash2 /> Delete
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export default WallboardsManager;
