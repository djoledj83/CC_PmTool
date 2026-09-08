// Reason block shown inside every "log time" form when the target task
// is assigned to someone else. An amber warning + a required category
// select + an optional note. Reused by LogTimeDialog, TaskQuickViewDialog
// and the Time Tracking page's manual form so the wording/behaviour stay
// identical everywhere.
import { AlertTriangle } from 'lucide-react';

import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { CROSS_USER_REASONS } from '@/lib/timeReason';

export default function CrossUserReasonFields({
    assigneeName = 'another user',
    reason,
    onReasonChange,
    note,
    onNoteChange,
    disabled = false,
    idPrefix = 'cross',
}) {
    return (
        <div className="space-y-2 rounded-md border border-amber-300/70 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
            <div className="flex items-start gap-2 text-xs text-amber-900 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p className="leading-relaxed">
                    This task is assigned to{' '}
                    <span className="font-medium">{assigneeName}</span>, not
                    you. If that's intentional, pick a reason below. Wrong
                    task? Just cancel and choose the correct one.
                </p>
            </div>
            <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-reason`} className="text-xs">
                    Reason <span className="text-destructive">*</span>
                </Label>
                <Select
                    value={reason || ''}
                    onValueChange={onReasonChange}
                    disabled={disabled}
                >
                    <SelectTrigger id={`${idPrefix}-reason`}>
                        <SelectValue placeholder="Why are you logging here?" />
                    </SelectTrigger>
                    <SelectContent>
                        {CROSS_USER_REASONS.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                                {r.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-reason-note`} className="text-xs">
                    Comment{' '}
                    <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Textarea
                    id={`${idPrefix}-reason-note`}
                    value={note}
                    onChange={(e) => onNoteChange(e.target.value)}
                    placeholder="Add context if helpful…"
                    rows={2}
                    disabled={disabled}
                />
            </div>
        </div>
    );
}
