// Daily "please fill your working log" reminder. Mounted once in the
// authenticated Layout. On load it asks the server whether the current
// user is behind the admin TimeLogPolicy; if so it shows a dismissible
// modal at most once per calendar day (tracked in localStorage).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogTitle,
} from '@/components/ui/dialog';

const DISMISS_KEY = 'pm.timeLogReminder.dismissedOn';

function todayKey() {
    return new Date().toISOString().slice(0, 10); // yyyy-mm-dd
}

function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export default function TimeLogReminder() {
    const navigate = useNavigate();
    const [info, setInfo] = useState(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        let cancelled = false;
        // Already dismissed today? Don't even ask.
        let dismissed = null;
        try {
            dismissed = localStorage.getItem(DISMISS_KEY);
        } catch {
            /* private mode / storage disabled — just proceed */
        }
        if (dismissed === todayKey()) return undefined;

        api.get('/time/compliance')
            .then((res) => {
                if (cancelled) return;
                const data = res.data || {};
                // `remind` is true only when the user is behind AND inside
                // the lead-up window before the cutoff.
                if (data.remind) {
                    setInfo(data);
                    setOpen(true);
                }
            })
            .catch(() => {
                /* never block the app on the reminder */
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const dismiss = () => {
        try {
            localStorage.setItem(DISMISS_KEY, todayKey());
        } catch {
            /* ignore */
        }
        setOpen(false);
    };

    if (!info) return null;

    return (
        <Dialog open={open} onOpenChange={(v) => (!v ? dismiss() : null)}>
            <DialogContent
                style={{ width: 440, maxWidth: '92vw' }}
                className="flex flex-col items-center gap-5 p-8 text-center"
            >
                {/* Accessible title (visually replaced by the big heading). */}
                <DialogTitle className="sr-only">Attention</DialogTitle>

                {/* Big red "!" sign. */}
                <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-red-500/30 bg-red-100 dark:bg-red-500/15">
                    <AlertCircle className="h-16 w-16 text-red-600 dark:text-red-500" />
                </div>

                <div className="space-y-1">
                    <h2 className="text-4xl font-black uppercase tracking-tight text-red-600 dark:text-red-500">
                        Attention
                    </h2>
                    <p className="text-lg font-semibold text-foreground">
                        Please fill your working log
                    </p>
                </div>

                {/* Big, obvious progress. */}
                <div className="w-full rounded-xl bg-muted/50 p-4">
                    <div className="text-3xl font-extrabold tabular-nums text-foreground">
                        {info.filledDays}{' '}
                        <span className="text-muted-foreground">/</span>{' '}
                        {info.requiredDays}
                    </div>
                    <div className="mt-0.5 text-sm text-muted-foreground">
                        working days logged for{' '}
                        <span className="font-semibold text-foreground">
                            {info.periodMonth}
                        </span>
                        {info.minHoursPerDay
                            ? ` (≥ ${info.minHoursPerDay}h each)`
                            : ''}
                    </div>
                </div>

                <p className="text-base font-semibold text-red-600 dark:text-red-500">
                    {info.shortBy > 0
                        ? `${info.shortBy} more day${info.shortBy === 1 ? '' : 's'} to log`
                        : 'Please complete your log'}
                    {' — '}due {fmtDate(info.deadline)}
                    {typeof info.daysUntilDeadline === 'number'
                        ? ` (${info.daysUntilDeadline} day${info.daysUntilDeadline === 1 ? '' : 's'} left)`
                        : ''}
                </p>

                <DialogFooter className="mt-1 flex w-full flex-col items-center gap-2 sm:flex-col sm:space-x-0">
                    <Button
                        size="lg"
                        className="w-full"
                        onClick={() => {
                            dismiss();
                            navigate('/time');
                        }}
                    >
                        Go to Time tracking
                    </Button>
                    <Button
                        variant="ghost"
                        className="w-full text-muted-foreground"
                        onClick={dismiss}
                    >
                        Remind me tomorrow
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
