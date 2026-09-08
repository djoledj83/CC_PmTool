import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useRealtime } from '@/contexts/RealtimeContext';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

function relativeTime(d) {
    if (!d) return '';
    try {
        return formatDistanceToNow(new Date(d), { addSuffix: true });
    } catch {
        return '';
    }
}

// Ticket notification types — the only ones the requester portal shows.
const TICKET_TYPES = new Set([
    'TICKET_CREATED',
    'TICKET_COMMENT',
    'TICKET_ASSIGNED',
]);

export function NotificationBell({ ticketsOnly = false }) {
    const navigate = useNavigate();
    const {
        unreadNotifications,
        recentNotifications,
        markNotificationsRead,
        refreshCounts,
    } = useRealtime();
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState(recentNotifications);

    useEffect(() => {
        setItems(recentNotifications);
    }, [recentNotifications]);

    useEffect(() => {
        if (!open) return;
        // When the popover opens, fetch a fresh list (in case the user came
        // back after the connection was idle).
        api.get('/notifications', { params: { limit: 20 } })
            .then((res) => setItems(res.data.notifications || []))
            .catch(() => {});
    }, [open]);

    // On the portal we only surface ticket notifications — nothing else.
    const visibleItems = ticketsOnly
        ? items.filter((n) => TICKET_TYPES.has(n.type))
        : items;
    const badgeCount = ticketsOnly
        ? visibleItems.filter((n) => !n.read).length
        : unreadNotifications;

    const handleOpen = (n) => {
        setOpen(false);
        if (!n.read) markNotificationsRead([n.id]);
        // Prefer a ticket deep-link when the notification carries a
        // ticketId but its stored link isn't already ticket-specific.
        // Older "new ticket" notifications linked to the plain /tickets
        // list (which just opened the page without the ticket); /t/:id
        // routes each recipient to the right surface and opens it.
        let link = n.link;
        if (
            n.meta?.ticketId &&
            !/(?:[?&]ticket=|\/t\/|\/portal\/requests\/)/.test(link || '')
        ) {
            link = `/t/${n.meta.ticketId}`;
        }
        if (!link) return;
        // Append a per-click cache-buster (`?pulse=<timestamp>`) so
        // the destination page can run a one-shot pulse animation on
        // the target row EVERY time the user clicks the notification
        // — even when they're already on the same URL. Without the
        // unique query param, react-router treats a click that
        // navigates to the page you're already viewing as a no-op
        // and the pulse effect never re-fires.
        //
        // CRITICAL: the cache-buster MUST live in the query string,
        // not inside the hash. Backend links look like
        // `/projects/X#task-Y` (path then fragment, no query); if we
        // naively appended `?pulse=…` to the end we'd produce
        // `/projects/X#task-Y?pulse=…` — and since everything after
        // `#` is the URL fragment, the question mark becomes part of
        // the hash. That means:
        //   • `location.search` stays empty → no pulse trigger fires
        //   • `location.hash` becomes `#task-Y?pulse=…` → the
        //     `#task-(.+)` regex captures `Y?pulse=…`, which never
        //     resolves to a real task id, so subtask deep-links
        //     silently break.
        // Splitting the link into base + hash and injecting the
        // query BETWEEN them keeps both halves intact.
        const hashIdx = link.indexOf('#');
        const base = hashIdx >= 0 ? link.slice(0, hashIdx) : link;
        const hash = hashIdx >= 0 ? link.slice(hashIdx) : '';
        const separator = base.includes('?') ? '&' : '?';
        navigate(`${base}${separator}pulse=${Date.now()}${hash}`);
    };

    const markAll = async () => {
        // On the portal, only clear the visible ticket notifications.
        await markNotificationsRead(
            ticketsOnly
                ? visibleItems.filter((n) => !n.read).map((n) => n.id)
                : undefined,
        );
        refreshCounts();
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="Notifications"
                >
                    <Bell className="h-4 w-4" />
                    {badgeCount > 0 && (
                        <span className="absolute right-1 top-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                            {badgeCount > 99 ? '99+' : badgeCount}
                        </span>
                    )}
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="end"
                className="w-[min(360px,calc(100vw-1rem))] p-0"
                sideOffset={8}
            >
                <div className="flex items-center justify-between border-b px-3 py-2">
                    <p className="text-sm font-semibold">Notifications</p>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={markAll}
                        disabled={badgeCount === 0}
                    >
                        <CheckCheck className="h-3.5 w-3.5" />
                        Mark all read
                    </Button>
                </div>

                <div className="max-h-[420px] overflow-y-auto">
                    {visibleItems.length === 0 ? (
                        <p className="p-6 text-center text-sm text-muted-foreground">
                            You're all caught up.
                        </p>
                    ) : (
                        <ul className="divide-y">
                            {visibleItems.map((n) => (
                                <li key={n.id}>
                                    <button
                                        type="button"
                                        onClick={() => handleOpen(n)}
                                        className={cn(
                                            'flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-accent',
                                            !n.read && 'bg-primary/5',
                                        )}
                                    >
                                        <Avatar className="mt-0.5 h-8 w-8 shrink-0">
                                            {n.actor?.avatarUrl && (
                                                <AvatarImage
                                                    src={resolveAssetUrl(
                                                        n.actor.avatarUrl,
                                                    )}
                                                    alt={n.actor.name}
                                                />
                                            )}
                                            <AvatarFallback className="bg-primary/10 text-xs text-primary">
                                                {initials(n.actor?.name || 'PM')}
                                            </AvatarFallback>
                                        </Avatar>
                                        <div className="min-w-0 flex-1">
                                            {/* Line 1: "[P… / T…] project name"
                                                (the code-prefixed title from
                                                the backend). */}
                                            <p className="truncate text-sm font-medium">
                                                {n.title}
                                            </p>
                                            {/* Line 2: the task name (and, for
                                                a subtask, the parent task it
                                                lives under) — the piece that
                                                was previously missing. */}
                                            {n.task?.title && (
                                                <p className="mt-0.5 truncate text-xs font-medium text-foreground/90">
                                                    {n.task.parent?.title
                                                        ? `${n.task.parent.title} › ${n.task.title}`
                                                        : n.task.title}
                                                </p>
                                            )}
                                            {/* Line 3+: all other details. */}
                                            {n.body && (
                                                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                                    {n.body}
                                                </p>
                                            )}
                                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                                                {relativeTime(n.createdAt)}
                                                {n.project?.name
                                                    ? ` · ${n.project.name}`
                                                    : ''}
                                            </p>
                                        </div>
                                        {!n.read && (
                                            <span
                                                className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary"
                                                aria-hidden
                                            />
                                        )}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}
