// Admin-only settings for the time-log compliance policy. Recurring
// monthly model: pick a cutoff (deadline) day of the month. Each cycle
// enforces the most-recently-completed calendar month; the target is the
// number of working days (Mon–Fri) in that month, computed automatically
// (so it lands at ~20–23 without manual edits). Users flagged "time
// logging mandatory" who are short get a daily dismissible reminder in
// the last N days before the cutoff (and a bell notification when "send
// notification" is on). Reads/writes GET|PUT /api/time/policy.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CalendarClock, Clock3, Loader2, Save } from 'lucide-react';

import { api } from '@/lib/api';
import { TopBar } from '@/components/TopBar';
import AdminTabs from '@/components/AdminTabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';

const ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export default function TimeLoggingSettings() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [enabled, setEnabled] = useState(false);
    const [cutoffDay, setCutoffDay] = useState(24);
    const [reminderLeadDays, setReminderLeadDays] = useState(7);
    const [minHoursPerDay, setMinHoursPerDay] = useState(6);
    const [notify, setNotify] = useState(false);
    const [updatedAt, setUpdatedAt] = useState(null);
    const [preview, setPreview] = useState(null);

    useEffect(() => {
        let cancelled = false;
        api.get('/time/policy')
            .then((res) => {
                if (cancelled) return;
                const p = res.data?.policy || {};
                setEnabled(Boolean(p.enabled));
                setCutoffDay(p.cutoffDay ?? 24);
                setReminderLeadDays(p.reminderLeadDays ?? 7);
                setMinHoursPerDay(p.minHoursPerDay ?? 6);
                setNotify(Boolean(p.notify));
                setUpdatedAt(p.updatedAt || null);
                setPreview(res.data?.preview || null);
            })
            .catch((err) => {
                toast.error(
                    err?.response?.data?.error || 'Could not load policy',
                );
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await api.put('/time/policy', {
                enabled,
                cutoffDay: Number(cutoffDay) || 24,
                reminderLeadDays: Number(reminderLeadDays) || 7,
                minHoursPerDay: Number(minHoursPerDay) || 0,
                notify,
            });
            setUpdatedAt(
                res.data?.policy?.updatedAt || new Date().toISOString(),
            );
            setPreview(res.data?.preview || null);
            toast.success('Time-logging policy saved');
        } catch (err) {
            toast.error(err?.response?.data?.error || 'Could not save policy');
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <TopBar title="Time logging" />
            <AdminTabs />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="flex w-full flex-col gap-6">
                    <Card>
                        <CardHeader className="pb-3">
                            <CardTitle className="flex items-center gap-2 text-base font-semibold">
                                <Clock3 className="h-4 w-4 text-primary" />
                                Working-log compliance
                            </CardTitle>
                            <p className="text-sm text-muted-foreground">
                                Each month, users flagged{' '}
                                <span className="font-medium">
                                    Time logging mandatory
                                </span>{' '}
                                must fill their working log for the previous
                                month by the cutoff day. The target is the
                                number of working days (Mon–Fri) in that month,
                                counted automatically.
                            </p>
                        </CardHeader>
                        <CardContent className="space-y-5">
                            {loading ? (
                                <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Loading…
                                </div>
                            ) : (
                                <>
                                    <label className="flex items-start gap-2.5">
                                        <input
                                            type="checkbox"
                                            className="mt-0.5 h-4 w-4"
                                            checked={enabled}
                                            onChange={(e) =>
                                                setEnabled(e.target.checked)
                                            }
                                        />
                                        <span className="text-sm">
                                            <span className="font-medium">
                                                Enable the reminder
                                            </span>
                                            <span className="block text-xs text-muted-foreground">
                                                Turns the whole policy on or
                                                off. When off, nobody is
                                                reminded.
                                            </span>
                                        </span>
                                    </label>

                                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                        <div className="space-y-1.5">
                                            <Label htmlFor="tlp-cutoff" className="text-xs">
                                                Cutoff day of month
                                            </Label>
                                            <Input
                                                id="tlp-cutoff"
                                                type="number"
                                                min={1}
                                                max={28}
                                                value={cutoffDay}
                                                onChange={(e) =>
                                                    setCutoffDay(e.target.value)
                                                }
                                            />
                                            <p className="text-[11px] text-muted-foreground">
                                                Deadline to have the previous
                                                month fully logged (1–28).
                                            </p>
                                        </div>
                                        <div className="space-y-1.5">
                                            <Label htmlFor="tlp-lead" className="text-xs">
                                                Remind within (days before)
                                            </Label>
                                            <Input
                                                id="tlp-lead"
                                                type="number"
                                                min={1}
                                                max={31}
                                                value={reminderLeadDays}
                                                onChange={(e) =>
                                                    setReminderLeadDays(
                                                        e.target.value,
                                                    )
                                                }
                                            />
                                            <p className="text-[11px] text-muted-foreground">
                                                Stay quiet until this many days
                                                before the cutoff.
                                            </p>
                                        </div>
                                        <div className="space-y-1.5">
                                            <Label htmlFor="tlp-hours" className="text-xs">
                                                Minimum hours per day
                                            </Label>
                                            <Input
                                                id="tlp-hours"
                                                type="number"
                                                min={0}
                                                max={24}
                                                step={0.5}
                                                value={minHoursPerDay}
                                                onChange={(e) =>
                                                    setMinHoursPerDay(
                                                        e.target.value,
                                                    )
                                                }
                                            />
                                            <p className="text-[11px] text-muted-foreground">
                                                A day only counts once logged
                                                time reaches this many hours.
                                            </p>
                                        </div>
                                    </div>

                                    <label className="flex items-start gap-2.5">
                                        <input
                                            type="checkbox"
                                            className="mt-0.5 h-4 w-4"
                                            checked={notify}
                                            onChange={(e) =>
                                                setNotify(e.target.checked)
                                            }
                                        />
                                        <span className="text-sm">
                                            <span className="font-medium">
                                                Also send a notification
                                            </span>
                                            <span className="block text-xs text-muted-foreground">
                                                In addition to the daily pop-up,
                                                send a bell notification (at
                                                most once per day) to users who
                                                are behind.
                                            </span>
                                        </span>
                                    </label>

                                    {preview && (
                                        <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs">
                                            <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                            <div className="leading-relaxed">
                                                <span className="font-medium text-foreground">
                                                    Current cycle (saved):
                                                </span>{' '}
                                                enforcing{' '}
                                                <span className="font-medium">
                                                    {preview.month}
                                                </span>{' '}
                                                — target{' '}
                                                <span className="font-medium">
                                                    {preview.requiredDays} working
                                                    days
                                                </span>
                                                , due{' '}
                                                <span className="font-medium">
                                                    {fmtDate(preview.deadline)}
                                                </span>{' '}
                                                (the {ordinal(cutoffDay)}). Change
                                                the cutoff and Save to refresh
                                                this.
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex items-center justify-between gap-2 border-t pt-4">
                                        <span className="text-[11px] text-muted-foreground">
                                            {updatedAt
                                                ? `Last saved ${new Date(updatedAt).toLocaleString()}`
                                                : 'Not configured yet'}
                                        </span>
                                        <Button
                                            onClick={handleSave}
                                            disabled={saving}
                                            className="gap-2"
                                        >
                                            {saving ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                                <Save className="h-4 w-4" />
                                            )}
                                            Save
                                        </Button>
                                    </div>
                                </>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </main>
        </>
    );
}
