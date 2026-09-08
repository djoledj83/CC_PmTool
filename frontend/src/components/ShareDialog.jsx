// Share a project / task / subtask with a teammate — either by copying a
// deep-link to the clipboard or by sending it straight into a direct
// message. Self-contained: it talks to /users (recipient picker),
// /conversations/dm (get-or-create the DM) and /conversations/:id/messages
// (post the link). The message body leads with the item's code (e.g.
// `T-0042`), which the chat renderer turns into a clickable link.
//
// Usage:
//   <ShareDialog
//       open={open}
//       onOpenChange={setOpen}
//       item={{ kind: 'task', id, code, title, projectId }}
//   />
// `kind` is 'project' | 'task' | 'subtask'. For a project, `id` is the
// project id and `projectId` may be omitted.
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy, Link2, Loader2, Search, Send } from 'lucide-react';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

// Build the in-app deep link for an item. Tasks and subtasks both use the
// project plan's `#task-<id>` hash convention (PhasesPlan scrolls/pulses
// the row on arrival); a project links to its detail page.
function buildUrl(item) {
    if (typeof window === 'undefined' || !item) return '';
    const origin = window.location.origin;
    if (item.kind === 'project') {
        return `${origin}/projects/${item.id}`;
    }
    const pid = item.projectId || '';
    return `${origin}/projects/${pid}#task-${item.id}`;
}

export default function ShareDialog({ open, onOpenChange, item }) {
    const { user } = useAuth();
    const [users, setUsers] = useState([]);
    const [loadingUsers, setLoadingUsers] = useState(false);
    const [search, setSearch] = useState('');
    const [recipient, setRecipient] = useState(null);
    const [note, setNote] = useState('');
    const [sending, setSending] = useState(false);
    const [copied, setCopied] = useState(false);

    const url = useMemo(() => buildUrl(item), [item]);
    const codeLabel = item?.code ? `${item.code} — ${item.title || ''}` : item?.title || '';

    // Reset transient state whenever the dialog (re)opens for an item.
    useEffect(() => {
        if (!open) return;
        setSearch('');
        setRecipient(null);
        setNote('');
        setCopied(false);
    }, [open, item?.id]);

    // Load the teammate list lazily on first open.
    useEffect(() => {
        if (!open || users.length || loadingUsers) return;
        setLoadingUsers(true);
        api.get('/users')
            .then(({ data }) => setUsers(data.users || data || []))
            .catch(() => setUsers([]))
            .finally(() => setLoadingUsers(false));
    }, [open, users.length, loadingUsers]);

    const candidates = useMemo(() => {
        const q = search.trim().toLowerCase();
        return (users || [])
            .filter((u) => u.id !== user?.id)
            .filter((u) => {
                if (!q) return true;
                return (
                    (u.name || '').toLowerCase().includes(q) ||
                    (u.email || '').toLowerCase().includes(q)
                );
            })
            .slice(0, 30);
    }, [users, search, user?.id]);

    const copyLink = async () => {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            toast.success('Link copied to clipboard.');
            setTimeout(() => setCopied(false), 1500);
        } catch {
            toast.error('Could not copy — select and copy the link manually.');
        }
    };

    const send = async () => {
        if (!recipient || sending) return;
        setSending(true);
        try {
            // Get-or-create the DM, then post the message.
            const { data: dm } = await api.post('/conversations/dm', {
                userId: recipient.id,
            });
            const conversationId = dm.conversation.id;
            const lead = note.trim() ? `${note.trim()}\n\n` : '';
            const content = `${lead}\u{1F4CC} ${codeLabel}\n${url}`;
            await api.post(`/conversations/${conversationId}/messages`, {
                content,
            });
            toast.success(`Shared with ${recipient.name || 'teammate'}.`);
            onOpenChange(false);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not send.');
        } finally {
            setSending(false);
        }
    };

    return (
        <Dialog open={!!open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-[460px] overflow-hidden sm:max-w-[460px]">
                <DialogHeader>
                    <DialogTitle>Share</DialogTitle>
                    <DialogDescription className="break-words text-xs">
                        {codeLabel || 'Share a link with your team.'}
                    </DialogDescription>
                </DialogHeader>

                <div className="min-w-0 space-y-4">
                    {/* Copy link */}
                    <div className="space-y-1.5">
                        <p className="text-xs font-medium text-muted-foreground">
                            Link
                        </p>
                        <div className="flex items-center gap-2">
                            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1.5 text-xs">
                                <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <span className="truncate" title={url}>
                                    {url}
                                </span>
                            </div>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 shrink-0 gap-1.5"
                                onClick={copyLink}
                            >
                                {copied ? (
                                    <Check className="h-3.5 w-3.5" />
                                ) : (
                                    <Copy className="h-3.5 w-3.5" />
                                )}
                                {copied ? 'Copied' : 'Copy'}
                            </Button>
                        </div>
                    </div>

                    {/* Send in a direct message */}
                    <div className="space-y-1.5">
                        <p className="text-xs font-medium text-muted-foreground">
                            Send in a direct message
                        </p>
                        {recipient ? (
                            <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
                                <Avatar className="h-6 w-6">
                                    {recipient.avatarUrl && (
                                        <AvatarImage
                                            src={resolveAssetUrl(
                                                recipient.avatarUrl,
                                            )}
                                            alt={recipient.name}
                                        />
                                    )}
                                    <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                                        {initials(recipient.name || '?')}
                                    </AvatarFallback>
                                </Avatar>
                                <span className="min-w-0 flex-1 truncate text-sm">
                                    {recipient.name}
                                </span>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => setRecipient(null)}
                                >
                                    Change
                                </Button>
                            </div>
                        ) : (
                            <>
                                <div className="relative">
                                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                                    <Input
                                        value={search}
                                        onChange={(e) =>
                                            setSearch(e.target.value)
                                        }
                                        placeholder="Search teammates…"
                                        className="h-8 pl-7 text-xs"
                                    />
                                </div>
                                <div className="max-h-40 overflow-y-auto rounded-md border">
                                    {loadingUsers ? (
                                        <p className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted-foreground">
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                            Loading…
                                        </p>
                                    ) : candidates.length === 0 ? (
                                        <p className="px-2 py-2 text-xs text-muted-foreground">
                                            No teammates found.
                                        </p>
                                    ) : (
                                        candidates.map((u) => (
                                            <button
                                                key={u.id}
                                                type="button"
                                                onClick={() => setRecipient(u)}
                                                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
                                            >
                                                <Avatar className="h-6 w-6">
                                                    {u.avatarUrl && (
                                                        <AvatarImage
                                                            src={resolveAssetUrl(
                                                                u.avatarUrl,
                                                            )}
                                                            alt={u.name}
                                                        />
                                                    )}
                                                    <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                                                        {initials(
                                                            u.name || '?',
                                                        )}
                                                    </AvatarFallback>
                                                </Avatar>
                                                <span className="min-w-0 flex-1 truncate">
                                                    {u.name}
                                                </span>
                                            </button>
                                        ))
                                    )}
                                </div>
                            </>
                        )}
                        <Textarea
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="Add a note (optional)…"
                            rows={2}
                            className="text-sm"
                        />
                        <div className="flex justify-end">
                            <Button
                                type="button"
                                size="sm"
                                className="gap-1.5"
                                disabled={!recipient || sending}
                                onClick={send}
                            >
                                {sending ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Send className="h-3.5 w-3.5" />
                                )}
                                Send
                            </Button>
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
