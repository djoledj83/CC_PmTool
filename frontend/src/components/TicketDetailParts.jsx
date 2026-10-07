// Presentational building blocks for the ticket detail modal (agent
// workspace): info cards, field rows, conversation cards, the section nav,
// tab bar, Send split button and the Time / Related / Activity tabs.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
    ArrowDownLeft,
    ArrowLeftRight,
    ArrowUpRight,
    Barcode,
    Building2,
    CheckCheck,
    CheckCircle2,
    ChevronDown,
    CircleDot,
    Clock,
    Copy,
    ListChecks,
    Loader2,
    Lock,
    Mail,
    MessageSquare,
    MoreHorizontal,
    Phone,
    Plus,
    Quote,
    RotateCcw,
    Send,
    Server,
    Settings,
    Signal,
    Smartphone,
    Tag,
    User,
    UserCheck,
    UserMinus,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, copyText, initials, resolveAssetUrl } from '@/lib/utils';
import {
    STATUS_BADGE,
    STATUS_DOT,
    eventSegments,
    fmtDate,
    fmtDateTimeLong,
    fmtSeconds,
    htmlToText,
    statusLabel,
} from '@/lib/ticketMeta';
import { RichText } from '@/components/RichText';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export async function copyToClipboard(text, what = 'Text') {
    if (await copyText(text)) toast.success(`${what} copied.`);
    else toast.error('Could not copy — select the text and copy it manually.');
}

export function PersonAvatar({ user, className, fallbackClassName }) {
    return (
        <Avatar className={cn('h-8 w-8 shrink-0', className)}>
            {user?.avatarUrl && (
                <AvatarImage
                    src={resolveAssetUrl(user.avatarUrl)}
                    alt={user?.name || ''}
                />
            )}
            <AvatarFallback
                className={cn(
                    'bg-primary/10 text-[11px] font-semibold text-primary',
                    fallbackClassName,
                )}
            >
                {initials(user?.name || user?.email || '?')}
            </AvatarFallback>
        </Avatar>
    );
}

// A rounded card section. `highlight` flashes a ring (section nav jumps).
export function InfoCard({
    icon: Icon,
    title,
    action,
    children,
    className,
    highlight = false,
    sectionRef,
}) {
    return (
        <section
            ref={sectionRef}
            className={cn(
                'rounded-xl border bg-card p-4 shadow-sm transition-shadow duration-300',
                highlight && 'ring-2 ring-primary/40',
                className,
            )}
        >
            {(title || action) && (
                <div className="mb-3 flex items-center justify-between gap-2">
                    {title && (
                        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                            {Icon && (
                                <Icon className="h-4 w-4 shrink-0 text-primary" />
                            )}
                            <span className="truncate">{title}</span>
                        </h3>
                    )}
                    {action}
                </div>
            )}
            {children}
        </section>
    );
}

// Small caption above a control (Status / Priority / Assignee / Project).
export function FieldBlock({ label, action, children, className }) {
    return (
        <div className={cn('min-w-0 space-y-1.5', className)}>
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{label}</span>
                {action}
            </div>
            {children}
        </div>
    );
}

const FIELD_ICON = {
    client: Building2,
    terminal: Smartphone,
    barcode: Barcode,
    host: Server,
    device: Smartphone,
    person: User,
    phone: Phone,
    email: Mail,
    yesno: CheckCircle2,
    select: ListChecks,
    text: Tag,
};

// label | icon | value | copy — rows from groupTicketFields().
export function FieldRows({ rows }) {
    return (
        <dl className="space-y-2.5 text-sm">
            {rows.map((r) => {
                const Icon = FIELD_ICON[r.kind] || Tag;
                const href =
                    r.kind === 'phone'
                        ? `tel:${r.value.replace(/[^\d+]/g, '')}`
                        : r.kind === 'email'
                          ? `mailto:${r.value}`
                          : null;
                return (
                    <div
                        key={r.key}
                        className="group grid grid-cols-[6.5rem_1rem_minmax(0,1fr)_1.5rem] items-start gap-x-2.5"
                    >
                        <dt
                            className="truncate text-muted-foreground"
                            title={r.label}
                        >
                            {r.label}
                        </dt>
                        <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
                        <dd className="min-w-0 break-words font-medium">
                            {href ? (
                                <a
                                    href={href}
                                    className="hover:text-primary hover:underline"
                                >
                                    {r.value}
                                </a>
                            ) : (
                                r.value
                            )}
                        </dd>
                        {r.copy ? (
                            <button
                                type="button"
                                onClick={() => copyToClipboard(r.value, r.label)}
                                className="rounded p-0.5 text-muted-foreground/70 opacity-60 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                                title={`Copy ${r.label}`}
                                aria-label={`Copy ${r.label}`}
                            >
                                <Copy className="h-3.5 w-3.5" />
                            </button>
                        ) : (
                            <span />
                        )}
                    </div>
                );
            })}
        </dl>
    );
}

// Left section navigation (Details / People / Attachments / …).
export function SectionNav({ items, active, onSelect }) {
    return (
        <nav className="space-y-1" aria-label="Ticket sections">
            {items.map((it) => {
                const Icon = it.icon;
                const on = active === it.id;
                return (
                    <button
                        key={it.id}
                        type="button"
                        onClick={() => onSelect(it.id)}
                        aria-current={on ? 'true' : undefined}
                        className={cn(
                            'relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                            on
                                ? 'bg-primary/10 font-medium text-primary before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary'
                                : 'text-foreground/80 hover:bg-muted hover:text-foreground',
                        )}
                    >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{it.label}</span>
                    </button>
                );
            })}
        </nav>
    );
}

// Underlined tab strip.
export function TabBar({ tabs, active, onChange }) {
    return (
        // The divider is an inset shadow (not a border + -mb-px tabs): the
        // overlap then stays inside the box, so overflow-x-auto doesn't
        // grow a stray vertical scrollbar (visible on Windows).
        <div
            role="tablist"
            className="flex shrink-0 gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_hsl(var(--border))]"
        >
            {tabs.map((t) => {
                const Icon = t.icon;
                const on = active === t.id;
                return (
                    <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        onClick={() => onChange(t.id)}
                        className={cn(
                            'flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
                            on
                                ? 'border-primary font-medium text-primary'
                                : 'border-transparent text-muted-foreground hover:text-foreground',
                        )}
                    >
                        <Icon className="h-4 w-4" />
                        {t.label}
                        {t.count > 0 && (
                            <span
                                className={cn(
                                    'rounded-full px-1.5 text-[10px] font-medium',
                                    on
                                        ? 'bg-primary/15 text-primary'
                                        : 'bg-muted text-muted-foreground',
                                )}
                            >
                                {t.count}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}

function Pill({ children }) {
    return (
        <span className="mx-0.5 inline-flex items-center rounded-md border bg-background px-1.5 py-px text-xs font-medium text-foreground">
            {children}
        </span>
    );
}

function Segments({ segs }) {
    return (
        <>
            {segs.map((s, i) =>
                typeof s === 'string' ? (
                    <span key={i}>{s}</span>
                ) : (
                    <Pill key={i}>{s.pill}</Pill>
                ),
            )}
        </>
    );
}

// ⋯ menu on a message card.
function MessageMenu({ body, onQuote }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    aria-label="Message actions"
                >
                    <MoreHorizontal className="h-4 w-4" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                    onSelect={() => copyToClipboard(htmlToText(body), 'Text')}
                >
                    <Copy className="mr-2 h-4 w-4" />
                    Copy text
                </DropdownMenuItem>
                {onQuote && (
                    <DropdownMenuItem onSelect={onQuote}>
                        <Quote className="mr-2 h-4 w-4" />
                        Quote in reply
                    </DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// One message (reply or internal note) as a chat bubble: the caller's own
// messages sit on the RIGHT on a blue tint, everyone else's on the LEFT on
// grey; internal notes keep their amber tint (on either side).
export function MessageCard({ message, mine = false, attachments, seen, onQuote }) {
    const internal = message.direction === 'INTERNAL';
    const author = message.author || {};
    return (
        <div
            className={cn('flex items-start gap-2.5', mine && 'flex-row-reverse')}
            data-message-side={mine ? 'mine' : 'theirs'}
        >
            <PersonAvatar user={author} className="mt-0.5 h-8 w-8" />
            <article
                className={cn(
                    'min-w-0 max-w-[85%] rounded-2xl border px-3.5 py-2.5 sm:max-w-[78%]',
                    mine ? 'rounded-tr-md' : 'rounded-tl-md',
                    internal
                        ? 'border-amber-300/70 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10'
                        : mine
                          ? 'border-primary/25 bg-primary/10 dark:bg-primary/20'
                          : 'border-border bg-muted/60',
                )}
            >
                <div
                    className={cn(
                        'flex items-start gap-2',
                        mine ? 'flex-row-reverse' : 'justify-between',
                    )}
                >
                    <div
                        className={cn(
                            'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5',
                            mine && 'justify-end text-right',
                        )}
                    >
                        <span className="text-sm font-semibold">
                            {mine ? 'You' : author.name || 'Someone'}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                            {fmtDateTimeLong(message.createdAt)}
                        </span>
                        {internal && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-px text-[11px] font-medium text-amber-700 dark:text-amber-300">
                                <Lock className="h-3 w-3" />
                                Internal note
                            </span>
                        )}
                    </div>
                    <MessageMenu body={message.body} onQuote={onQuote} />
                </div>
                {message.body && (
                    <div className="mt-1 break-words text-sm">
                        <RichText source={message.body} />
                    </div>
                )}
                {attachments}
                {seen}
            </article>
        </div>
    );
}

// Status / priority / assignment change — a small centred line between
// the messages (keeps the thread compact).
export function SystemEventCard({ event, nameById }) {
    const segs = eventSegments(event, nameById);
    if (!segs) return null;
    return (
        <div className="flex justify-center" data-system-event="">
            <p className="inline-flex max-w-[92%] flex-wrap items-center justify-center gap-x-1 gap-y-0.5 rounded-full border bg-muted/40 px-3 py-1 text-center text-xs text-muted-foreground">
                <Settings className="h-3.5 w-3.5 shrink-0" />
                <Segments segs={segs} />
                {event.actor?.name && <span>· by {event.actor.name}</span>}
                <span className="opacity-80">· {fmtDateTimeLong(event.createdAt)}</span>
            </p>
        </div>
    );
}

// "Seen by …" receipt under the caller's last read message.
export function SeenReceipt({ label, title }) {
    return (
        <p
            className="mt-2 flex items-center justify-end gap-1 text-[11px] font-medium text-primary"
            title={title}
        >
            <CheckCheck className="h-3.5 w-3.5" />
            {label}
        </p>
    );
}

export function EmptyState({ icon: Icon, title, hint }) {
    return (
        <div className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-10 text-center">
            {Icon && <Icon className="h-6 w-6 text-muted-foreground/60" />}
            <p className="text-sm font-medium">{title}</p>
            {hint && (
                <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>
            )}
        </div>
    );
}

// [Send][▾] — the menu sends and then sets a status in one go.
export function SendSplitButton({
    onSend,
    statusOptions = [],
    disabled,
    sending,
    title,
}) {
    const hasMenu = statusOptions.length > 0;
    return (
        <div className="flex shrink-0" title={title}>
            <Button
                type="button"
                className={cn('gap-1.5', hasMenu && 'rounded-r-none')}
                disabled={disabled}
                onClick={() => onSend(null)}
            >
                {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                    <Send className="h-4 w-4" />
                )}
                Send
            </Button>
            {hasMenu && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            type="button"
                            disabled={disabled}
                            className="rounded-l-none border-l border-primary-foreground/25 px-2"
                            aria-label="Send and change status"
                        >
                            <ChevronDown className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                        {statusOptions.map((s) => (
                            <DropdownMenuItem
                                key={s}
                                onSelect={() => onSend(s)}
                            >
                                <span
                                    className={cn(
                                        'mr-2 h-2 w-2 shrink-0 rounded-full',
                                        STATUS_DOT[s] || 'bg-slate-400',
                                    )}
                                />
                                Send &amp; set {statusLabel(s)}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
    );
}

function StatusChip({ status }) {
    return (
        <span
            className={cn(
                'inline-flex shrink-0 rounded-md border px-1.5 py-px text-[10px] font-medium',
                STATUS_BADGE[status] || STATUS_BADGE.NEW,
            )}
        >
            {statusLabel(status)}
        </span>
    );
}

// ---------------------------------------------------------------------
// Time tracking tab
// ---------------------------------------------------------------------
export function TicketTimeTab({ ticketId, reloadKey, onLogTime, canLog, logHint }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        api.get(`/tickets/${ticketId}/time`)
            .then(({ data: d }) => {
                if (!cancelled) setData(d);
            })
            .catch(() => {
                if (!cancelled) setData({ entries: [], totalSeconds: 0 });
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [ticketId, reloadKey]);

    const entries = data?.entries || [];
    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/30 px-4 py-3">
                <p className="text-sm">
                    <span className="text-muted-foreground">Total </span>
                    <span className="font-semibold">
                        {fmtSeconds(data?.totalSeconds || 0)}
                    </span>
                    <span className="text-muted-foreground">
                        {' '}
                        · {entries.length}{' '}
                        {entries.length === 1 ? 'entry' : 'entries'}
                    </span>
                </p>
                <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5"
                    onClick={onLogTime}
                    disabled={!canLog}
                    title={canLog ? undefined : logHint}
                >
                    <Clock className="h-4 w-4" />
                    Log time
                </Button>
            </div>
            {loading ? (
                <p className="flex items-center gap-1.5 px-1 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </p>
            ) : entries.length === 0 ? (
                <EmptyState
                    icon={Clock}
                    title="No time logged on this ticket yet"
                    hint="Time logged with “Log time” here — and on tasks created from this ticket — shows up in this list."
                />
            ) : (
                <ul className="divide-y rounded-xl border">
                    {entries.map((e) => (
                        <li
                            key={e.id}
                            className="flex items-start gap-3 px-4 py-3"
                        >
                            <PersonAvatar user={e.user} />
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-x-2">
                                    <span className="text-sm font-medium">
                                        {e.user?.name || e.user?.email || 'Someone'}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {fmtDate(e.startedAt)}
                                    </span>
                                    {e.task && (
                                        <span
                                            className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-px text-[10px]"
                                            title={e.task.title}
                                        >
                                            <ListChecks className="h-3 w-3 text-emerald-600" />
                                            <span className="font-mono">
                                                {e.task.code || 'Task'}
                                            </span>
                                        </span>
                                    )}
                                </div>
                                {e.note && (
                                    <p className="mt-0.5 break-words text-sm text-muted-foreground">
                                        {e.note}
                                    </p>
                                )}
                            </div>
                            <span className="shrink-0 text-sm font-semibold tabular-nums">
                                {e.running ? (
                                    <span className="inline-flex items-center gap-1 text-emerald-600">
                                        <CircleDot className="h-3.5 w-3.5 animate-pulse" />
                                        {fmtSeconds(e.seconds)}
                                    </span>
                                ) : (
                                    fmtSeconds(e.seconds)
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------
// Related tickets tab
// ---------------------------------------------------------------------
const LINK_DIRECTION = {
    out: { icon: ArrowUpRight, label: 'Referenced here' },
    in: { icon: ArrowDownLeft, label: 'References this ticket' },
    both: { icon: ArrowLeftRight, label: 'Linked both ways' },
};

function RelatedRow({ t, onOpen, extra }) {
    return (
        <li>
            <button
                type="button"
                onClick={() => onOpen?.(t.id)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50"
            >
                <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                    {t.code}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                    {t.subject}
                </span>
                {extra}
                <StatusChip status={t.status} />
                <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground sm:inline">
                    {fmtDate(t.createdAt)}
                </span>
            </button>
        </li>
    );
}

export function TicketRelatedTab({ ticketId, onOpenTicket }) {
    const [data, setData] = useState(null);
    useEffect(() => {
        let cancelled = false;
        api.get(`/tickets/${ticketId}/related`)
            .then(({ data: d }) => {
                if (!cancelled) setData(d);
            })
            .catch(() => {
                if (!cancelled) setData({ linked: [], sameClient: [] });
            });
        return () => {
            cancelled = true;
        };
    }, [ticketId]);

    if (!data) {
        return (
            <p className="flex items-center gap-1.5 px-1 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
        );
    }
    const linked = data.linked || [];
    const sameClient = data.sameClient || [];
    if (linked.length === 0 && sameClient.length === 0) {
        return (
            <EmptyState
                icon={ArrowLeftRight}
                title="No related tickets"
                hint="Tickets from the same client, and tickets linked to this one with # in a message, appear here."
            />
        );
    }
    return (
        <div className="space-y-4">
            {linked.length > 0 && (
                <div>
                    <h4 className="mb-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Linked with #
                    </h4>
                    <ul className="divide-y overflow-hidden rounded-xl border">
                        {linked.map((t) => {
                            const dir = LINK_DIRECTION[t.direction] || LINK_DIRECTION.out;
                            const DirIcon = dir.icon;
                            return (
                                <RelatedRow
                                    key={t.id}
                                    t={t}
                                    onOpen={onOpenTicket}
                                    extra={
                                        <span title={dir.label}>
                                            <DirIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        </span>
                                    }
                                />
                            );
                        })}
                    </ul>
                </div>
            )}
            {sameClient.length > 0 && (
                <div>
                    <h4 className="mb-1.5 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Same client{data.client?.name ? ` — ${data.client.name}` : ''}
                    </h4>
                    <ul className="divide-y overflow-hidden rounded-xl border">
                        {sameClient.map((t) => (
                            <RelatedRow
                                key={t.id}
                                t={t}
                                onOpen={onOpenTicket}
                                extra={
                                    t.sameTerminal ? (
                                        <span
                                            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary"
                                            title="Same terminal ID as this ticket"
                                        >
                                            <Smartphone className="h-3 w-3" />
                                            Same terminal
                                        </span>
                                    ) : null
                                }
                            />
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------
// Activity log tab — every event and message, newest first.
// ---------------------------------------------------------------------
const EVENT_ICON = {
    CREATED: Plus,
    STATUS_CHANGED: CircleDot,
    REOPENED: RotateCcw,
    PRIORITY_CHANGED: Signal,
    ASSIGNED: UserCheck,
    UNASSIGNED: UserMinus,
};

export function TicketActivityTab({ events, messages, nameById }) {
    const items = [];
    for (const e of events || []) {
        const segs = eventSegments(e, nameById);
        if (!segs) continue;
        items.push({
            key: `e-${e.id}`,
            at: e.createdAt,
            icon: EVENT_ICON[e.kind] || Settings,
            who: e.actor?.name || 'System',
            body: <Segments segs={segs} />,
        });
    }
    for (const m of messages || []) {
        const internal = m.direction === 'INTERNAL';
        items.push({
            key: `m-${m.id}`,
            at: m.createdAt,
            icon: internal ? Lock : MessageSquare,
            who: m.author?.name || 'Someone',
            body: internal ? 'added an internal note' : 'replied',
        });
    }
    items.sort((a, b) => new Date(b.at) - new Date(a.at));
    if (items.length === 0) {
        return <EmptyState icon={Clock} title="Nothing logged yet" />;
    }
    return (
        <ol className="relative space-y-4 pl-1">
            <span
                aria-hidden
                className="absolute bottom-2 left-[1.05rem] top-2 w-px bg-border"
            />
            {items.map((it) => {
                const Icon = it.icon;
                return (
                    <li key={it.key} className="relative flex items-start gap-3">
                        <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground">
                            <Icon className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0 flex-1 pt-1">
                            <p className="text-sm">
                                <span className="font-medium">{it.who}</span>{' '}
                                <span className="text-muted-foreground">
                                    {typeof it.body === 'string'
                                        ? it.body
                                        : null}
                                </span>
                                {typeof it.body === 'string' ? null : (
                                    <span className="text-muted-foreground">
                                        {' — '}
                                        {it.body}
                                    </span>
                                )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {fmtDateTimeLong(it.at)}
                            </p>
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}
