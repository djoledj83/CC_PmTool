import {
    AlertTriangle,
    Bug,
    Clock,
    Eye,
    EyeOff,
    HelpCircle,
    Inbox,
    Lock,
    Star,
    UserCheck,
} from 'lucide-react';

import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getTicketTypeIcon } from '@/lib/ticketTypeIcons';
import { getTicketTypeBadgeClasses } from '@/lib/ticketTypeColors';

// One ticket card used EVERYWHERE — resolver and portal, board and grid —
// so a ticket looks identical wherever it appears and every card is the
// same fixed size. Shows: type, an obvious status badge, code, one-line
// subject, the first line of the description, created date/time, the
// priority, and who opened vs. who handles the ticket.

const STATUS_STYLE = {
    NEW: { label: 'New', badge: 'bg-sky-500 text-white', bar: 'border-l-sky-500' },
    OPEN: { label: 'Open', badge: 'bg-blue-500 text-white', bar: 'border-l-blue-500' },
    IN_PROGRESS: {
        label: 'In progress',
        badge: 'bg-indigo-500 text-white',
        bar: 'border-l-indigo-500',
    },
    PENDING: {
        label: 'Pending',
        badge: 'bg-amber-500 text-white',
        bar: 'border-l-amber-500',
    },
    RESOLVED: {
        label: 'Resolved',
        badge: 'bg-emerald-500 text-white',
        bar: 'border-l-emerald-500',
    },
    CLOSED: {
        label: 'Closed',
        badge: 'bg-slate-400 text-white',
        bar: 'border-l-slate-400',
    },
};

const TYPE_META = {
    INCIDENT: { label: 'Incident', Icon: AlertTriangle },
    PROBLEM: { label: 'Problem', Icon: Bug },
    QUESTION: { label: 'Question', Icon: HelpCircle },
    REQUEST: { label: 'Request', Icon: Inbox },
};

const PRIORITY_DOT = {
    LOW: 'bg-slate-400',
    NORMAL: 'bg-sky-500',
    HIGH: 'bg-amber-500',
    URGENT: 'bg-rose-500',
};

const titleCase = (s) =>
    s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : s;

function fmtDateTime(v) {
    if (!v) return '';
    try {
        return new Date(v).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return '';
    }
}

export default function TicketCardShared({
    t,
    onOpen,
    onTogglePin = null,
    onToggleHide = null,
    hidden = false,
    selected = false,
}) {
    const status = STATUS_STYLE[t.status] || STATUS_STYLE.NEW;
    const type = TYPE_META[t.type] || TYPE_META.REQUEST;
    const TypeIcon = type.Icon;
    // The named request type (e.g. "SoftPOS") with its own icon, shown
    // alongside the generic category so it's clear what the ticket is about.
    const RequestTypeIcon = t.requestType
        ? getTicketTypeIcon(t.requestType.icon)
        : null;

    return (
        <button
            type="button"
            onClick={() => onOpen?.(t)}
            className={cn(
                'flex w-full flex-col gap-1.5 rounded-lg border border-l-4 bg-card p-3 text-left shadow-sm transition-all hover:-translate-y-px hover:shadow-md',
                status.bar,
                t.unread && 'bg-primary/5 shadow-md ring-2 ring-primary',
                selected && 'ring-2 ring-primary',
                hidden && 'opacity-55',
            )}
        >
            {/* Header: type · obvious status · code · pin. Wraps so the pin
                never spills outside the card in narrow board columns. */}
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    <TypeIcon className="h-3 w-3" />
                    {type.label}
                </span>
                <span
                    className={cn(
                        'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                        status.badge,
                    )}
                >
                    {status.label}
                </span>
                {t.requestType && (
                    <span
                        title={t.requestType.name}
                        className={cn(
                            'inline-flex min-w-0 shrink items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
                            getTicketTypeBadgeClasses(t.requestType.color),
                        )}
                    >
                        {RequestTypeIcon && (
                            <RequestTypeIcon className="h-3 w-3 shrink-0" />
                        )}
                        <span className="truncate">{t.requestType.name}</span>
                    </span>
                )}
                {t.internal && (
                    <span
                        title="Raised internally (not by a requester)"
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                    >
                        <Lock className="h-3 w-3" />
                        Internal
                    </span>
                )}
                <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                    {t.code}
                </span>
                {onTogglePin && (
                    <span
                        role="button"
                        tabIndex={0}
                        title={t.pinned ? 'Unpin' : 'Pin'}
                        onClick={(e) => {
                            e.stopPropagation();
                            onTogglePin();
                        }}
                        className={cn(
                            'shrink-0 rounded p-0.5 hover:bg-accent',
                            t.pinned
                                ? 'text-amber-500'
                                : 'text-muted-foreground/40',
                        )}
                    >
                        <Star
                            className="h-3.5 w-3.5"
                            fill={t.pinned ? 'currentColor' : 'none'}
                        />
                    </span>
                )}
                {onToggleHide && (
                    <span
                        role="button"
                        tabIndex={0}
                        title={
                            hidden
                                ? 'Unhide this ticket'
                                : 'Hide this ticket from your list'
                        }
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleHide();
                        }}
                        className="shrink-0 rounded p-0.5 text-muted-foreground/40 hover:bg-accent hover:text-foreground"
                    >
                        {hidden ? (
                            <Eye className="h-3.5 w-3.5" />
                        ) : (
                            <EyeOff className="h-3.5 w-3.5" />
                        )}
                    </span>
                )}
            </div>

            {/* Subject — one line */}
            <div
                className={cn(
                    'line-clamp-1 text-sm leading-snug',
                    t.unread ? 'font-bold' : 'font-semibold',
                )}
            >
                {t.subject}
            </div>

            {/* First line of the description (placeholder when empty) */}
            <div className="line-clamp-1 text-xs text-muted-foreground">
                {t.descriptionPreview || (
                    <span className="italic opacity-60">No description</span>
                )}
            </div>

            {/* Created date/time + priority */}
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <Clock className="h-3 w-3 shrink-0" />
                <span className="truncate">{fmtDateTime(t.createdAt)}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1">
                    <span
                        className={cn(
                            'h-1.5 w-1.5 rounded-full',
                            PRIORITY_DOT[t.priority] || PRIORITY_DOT.NORMAL,
                        )}
                    />
                    {titleCase(t.priority)}
                </span>
            </div>

            {/* Footer: who opened it (left) · who handles it (right) */}
            <div className="flex items-center justify-between gap-3 border-t pt-2 text-[10px] text-muted-foreground">
                <PersonLine label="Opened" person={t.reporter} />
                <PersonLine
                    label="Handled"
                    person={t.assignee}
                    icon={UserCheck}
                    emptyLabel="Unassigned"
                    align="right"
                />
            </div>
        </button>
    );
}

function PersonLine({
    label,
    person,
    icon: Icon,
    emptyLabel = 'Unknown',
    align = 'left',
}) {
    return (
        <span
            className={cn(
                'flex min-w-0 items-center gap-1',
                align === 'right' && 'justify-end text-right',
            )}
        >
            <span className="shrink-0 text-muted-foreground/70">{label}:</span>
            {person ? (
                <>
                    <Avatar className="h-4 w-4 shrink-0">
                        {person.avatarUrl && (
                            <AvatarImage
                                src={resolveAssetUrl(person.avatarUrl)}
                                alt={person.name}
                            />
                        )}
                        <AvatarFallback className="bg-primary/10 text-[7px] text-primary">
                            {initials(person.name || person.email || '?')}
                        </AvatarFallback>
                    </Avatar>
                    <span className="truncate font-medium text-foreground">
                        {person.name || person.email}
                    </span>
                </>
            ) : (
                <span className="flex items-center gap-1 italic opacity-70">
                    {Icon && <Icon className="h-3 w-3" />}
                    {emptyLabel}
                </span>
            )}
        </span>
    );
}
