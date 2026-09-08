// Checkbox-gated confirmation for destructive actions (delete a project
// or task). Unlike a browser confirm(), the delete button stays disabled
// until the user ticks the "I understand" acknowledgement, so an
// accidental click can't wipe anything. The action itself is still
// recorded server-side (who + when) in the activity log.
import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function ConfirmDeleteDialog({
    open,
    onOpenChange,
    title = 'Delete?',
    description,
    ackLabel = 'I understand this action.',
    confirmLabel = 'Delete',
    onConfirm,
}) {
    const [ack, setAck] = useState(false);
    const [busy, setBusy] = useState(false);

    // Reset the acknowledgement every time the dialog opens so it can't
    // carry a stale "checked" state into the next delete.
    useEffect(() => {
        if (open) {
            setAck(false);
            setBusy(false);
        }
    }, [open]);

    const confirm = async () => {
        if (!ack || busy) return;
        setBusy(true);
        try {
            await onConfirm?.();
            onOpenChange?.(false);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                if (!busy) onOpenChange?.(o);
            }}
        >
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-destructive">
                        <AlertTriangle className="h-4 w-4" /> {title}
                    </DialogTitle>
                    {description && (
                        <DialogDescription>{description}</DialogDescription>
                    )}
                </DialogHeader>
                <label className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-sm">
                    <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 shrink-0"
                        checked={ack}
                        onChange={(e) => setAck(e.target.checked)}
                    />
                    <span>{ackLabel}</span>
                </label>
                <DialogFooter>
                    <Button
                        variant="ghost"
                        onClick={() => onOpenChange?.(false)}
                        disabled={busy}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={confirm}
                        disabled={!ack || busy}
                        className="gap-1.5"
                    >
                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                        {confirmLabel}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default ConfirmDeleteDialog;
