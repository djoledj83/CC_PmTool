// Popover for adding co-requesters to a ticket — individual people and/or
// admin-defined requester groups. Self-contained: fetches candidates +
// groups on open, lets the user tick several, and calls onConfirm with
// { userIds, groupIds } when they hit Add. Used on the raise-request
// dialog (collect for create) and the request detail (add immediately).
import { useEffect, useRef, useState } from 'react';
import { UserPlus, Users, Check, Search } from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

export function RequesterPicker({
    label = 'Add people',
    excludeUserIds = [],
    onConfirm,
}) {
    const [open, setOpen] = useState(false);
    const [users, setUsers] = useState([]);
    const [groups, setGroups] = useState([]);
    const [q, setQ] = useState('');
    const [selUsers, setSelUsers] = useState(() => new Set());
    const [selGroups, setSelGroups] = useState(() => new Set());
    const loaded = useRef(false);

    useEffect(() => {
        if (!open || loaded.current) return;
        loaded.current = true;
        api.get('/requester-groups/candidates')
            .then(({ data }) => setUsers(data.users || []))
            .catch(() => {});
        api.get('/requester-groups')
            .then(({ data }) => setGroups(data.groups || []))
            .catch(() => {});
    }, [open]);

    const exclude = new Set(excludeUserIds);
    const people = users.filter(
        (u) =>
            !exclude.has(u.id) &&
            (!q ||
                (u.name || u.email || '')
                    .toLowerCase()
                    .includes(q.toLowerCase())),
    );
    const toggle = (set, setter, id) => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setter(next);
    };
    const count = selUsers.size + selGroups.size;

    const confirm = () => {
        onConfirm?.({
            userIds: Array.from(selUsers),
            groupIds: Array.from(selGroups),
        });
        setSelUsers(new Set());
        setSelGroups(new Set());
        setQ('');
        setOpen(false);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 px-2 text-xs"
                >
                    <UserPlus className="h-3.5 w-3.5" />
                    {label}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-2">
                <div className="relative mb-2">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Search people…"
                        className="w-full rounded border bg-background py-1 pl-7 pr-2 text-xs outline-none focus:border-primary"
                    />
                </div>
                <div className="max-h-60 space-y-2 overflow-y-auto">
                    {groups.length > 0 && (
                        <div>
                            <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                Groups
                            </div>
                            {groups.map((g) => {
                                const on = selGroups.has(g.id);
                                return (
                                    <button
                                        key={g.id}
                                        type="button"
                                        onClick={() =>
                                            toggle(selGroups, setSelGroups, g.id)
                                        }
                                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                                    >
                                        <span
                                            className={cn(
                                                'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                                on
                                                    ? 'border-primary bg-primary text-primary-foreground'
                                                    : 'border-input',
                                            )}
                                        >
                                            {on && <Check className="h-3 w-3" />}
                                        </span>
                                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                                        <span className="truncate">
                                            {g.name}
                                        </span>
                                        <span className="ml-auto text-[10px] text-muted-foreground">
                                            {g.members?.length || 0}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    <div>
                        <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            People
                        </div>
                        {people.length === 0 ? (
                            <p className="px-2 py-2 text-xs text-muted-foreground">
                                No one to add.
                            </p>
                        ) : (
                            people.slice(0, 100).map((u) => {
                                const on = selUsers.has(u.id);
                                return (
                                    <button
                                        key={u.id}
                                        type="button"
                                        onClick={() =>
                                            toggle(selUsers, setSelUsers, u.id)
                                        }
                                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                                    >
                                        <span
                                            className={cn(
                                                'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                                on
                                                    ? 'border-primary bg-primary text-primary-foreground'
                                                    : 'border-input',
                                            )}
                                        >
                                            {on && <Check className="h-3 w-3" />}
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
                <div className="mt-2 flex justify-end border-t pt-2">
                    <Button
                        type="button"
                        size="sm"
                        className="h-7 px-3 text-xs"
                        disabled={count === 0}
                        onClick={confirm}
                    >
                        Add{count > 0 ? ` (${count})` : ''}
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}

export default RequesterPicker;
