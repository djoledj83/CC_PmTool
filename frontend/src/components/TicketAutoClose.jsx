// Auto-close for resolved tickets, in the ticket window's side panel.
//   AutoCloseCard    agents: "Close automatically after N days" (switch +
//                    days), shown while the status (draft) is Resolved.
//                    Part of the staged edits — saved with "Save changes".
//   AutoCloseNotice  requesters: when it will close and that a reply
//                    reopens it.
import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { InfoCard } from '@/components/TicketDetailParts';
import {
    AUTO_CLOSE_DEFAULT_DAYS,
    MAX_AUTO_CLOSE_DAYS,
    autoCloseFromNow,
    daysLabel,
    fmtCountdown,
    fmtDateTimeLong,
    readAutoCloseDays,
} from '@/lib/ticketMeta';

const QUICK_DAYS = [1, 2, 3, 5, 7];
const clampDays = (n) => Math.min(MAX_AUTO_CLOSE_DAYS, Math.max(1, n));

export function AutoCloseCard({
    days, // draft: number of days, or null = don't auto-close
    onChange,
    savedDays = null, // what the server has (null = none)
    savedAt = null, // when it's due on the server
    disabled = false,
}) {
    const on = days != null;
    // The input keeps its own text so it can be briefly empty while typing.
    const [text, setText] = useState(on ? String(days) : '');
    useEffect(() => {
        setText(on ? String(days) : '');
    }, [on, days]);

    const unchanged = on && days === savedDays && !!savedAt;
    const when = unchanged ? savedAt : on ? autoCloseFromNow(days) : null;

    return (
        <div data-auto-close="">
        <InfoCard className="space-y-2.5 p-3">
            <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Timer className="h-3.5 w-3.5" />
                    Close automatically
                </span>
                <Switch
                    checked={on}
                    disabled={disabled}
                    aria-label="Close automatically"
                    onCheckedChange={(next) =>
                        onChange(
                            next ? savedDays || readAutoCloseDays() || AUTO_CLOSE_DEFAULT_DAYS : null,
                        )
                    }
                />
            </div>
            {on ? (
                <>
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                        <span className="text-muted-foreground">after</span>
                        <Input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={MAX_AUTO_CLOSE_DAYS}
                            value={text}
                            disabled={disabled}
                            aria-label="Days until it closes"
                            onChange={(e) => {
                                setText(e.target.value);
                                const n = parseInt(e.target.value, 10);
                                if (Number.isFinite(n)) onChange(clampDays(n));
                            }}
                            onBlur={() => setText(String(days))}
                            className="h-8 w-16 px-2 text-center text-sm"
                        />
                        <span className="text-muted-foreground">
                            {days === 1 ? 'day' : 'days'}
                        </span>
                        <span className="ml-auto flex gap-1">
                            {QUICK_DAYS.map((n) => (
                                <button
                                    key={n}
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => onChange(n)}
                                    aria-pressed={days === n}
                                    title={daysLabel(n)}
                                    className={cn(
                                        'h-7 min-w-7 rounded-md border px-1.5 text-xs transition-colors',
                                        days === n
                                            ? 'border-primary bg-primary text-primary-foreground'
                                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                                    )}
                                >
                                    {n}
                                </button>
                            ))}
                        </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground" data-auto-close-when="">
                        {unchanged ? (
                            <>
                                Closes {fmtDateTimeLong(when)} ·{' '}
                                <span className="font-medium text-foreground">
                                    {fmtCountdown(when)}
                                </span>
                            </>
                        ) : (
                            <>
                                Will close {fmtDateTimeLong(when)} — counted from
                                when you save.
                            </>
                        )}{' '}
                        A requester reply reopens it and cancels this.
                    </p>
                </>
            ) : (
                <p className="text-[11px] text-muted-foreground">
                    Stays resolved until someone closes it.
                </p>
            )}
        </InfoCard>
        </div>
    );
}

export function AutoCloseNotice({ at }) {
    return (
        <div data-auto-close-notice="">
        <InfoCard className="space-y-1 border-emerald-500/30 bg-emerald-500/5 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-800 dark:text-emerald-200">
                <Timer className="h-3.5 w-3.5" />
                Closes automatically {fmtCountdown(at)}
            </p>
            <p className="text-[11px] text-muted-foreground">
                This request was resolved and will close on{' '}
                {fmtDateTimeLong(at)}. Still need help? Reply below — that
                reopens it.
            </p>
        </InfoCard>
        </div>
    );
}
