// Broadcast announcement modal. Mounted once in each app shell (main app +
// client portal). Shows the active announcements the current user hasn't
// acknowledged, one at a time, centered and styled by type:
//   IMPORTANT → red · INFO → green · TIP → orange
// Announcements with requireAck=false are informational: just a Close
// button (closing records that they saw it). requireAck=true ones offer an
// optional comment + "I understand"; "Later" defers (reappears next load).
// New activations arrive live over the realtime socket (no reload needed).
import { useCallback, useEffect, useState } from 'react';
import { Loader2, ExternalLink } from 'lucide-react';

import { api } from '@/lib/api';
import { useRealtime } from '@/contexts/RealtimeContext';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import AnnouncementView from '@/components/AnnouncementView';

export default function AnnouncementModal() {
    const { subscribe } = useRealtime();
    const [queue, setQueue] = useState([]);
    const [open, setOpen] = useState(false);
    const [comment, setComment] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const fetchActive = useCallback(() => {
        api.get('/announcements/active')
            .then((res) => {
                const list = res.data?.announcements || [];
                if (list.length) {
                    setQueue(list);
                    setOpen(true);
                }
            })
            .catch(() => {
                /* never block the app on this */
            });
    }, []);

    // Initial load.
    useEffect(() => {
        fetchActive();
    }, [fetchActive]);

    // Live push: when an announcement is activated for this user, refetch.
    useEffect(() => {
        if (!subscribe) return undefined;
        const off = subscribe('announcement:new', () => fetchActive());
        return off;
    }, [subscribe, fetchActive]);

    const current = queue[0] || null;

    const advance = () => {
        setComment('');
        setQueue((q) => {
            const rest = q.slice(1);
            if (rest.length === 0) setOpen(false);
            return rest;
        });
    };

    const commentRequired = Boolean(current?.requireComment);
    const commentMissing = commentRequired && !comment.trim();

    // Records a receipt (with comment for ack-required) then moves on.
    const acknowledge = async () => {
        if (!current) return;
        if (commentMissing) return; // guard: written response mandatory
        setSubmitting(true);
        try {
            await api.post(`/announcements/${current.id}/ack`, {
                comment: comment.trim() || undefined,
            });
            advance();
        } catch {
            // Even if the receipt fails, don't trap the user — move on.
            advance();
        } finally {
            setSubmitting(false);
        }
    };

    if (!current) return null;

    // A MANDATORY announcement is a service-migration notice: a blocking,
    // non-dismissible overlay whose ONLY action sends the user to the new
    // address. It trumps everything else in the queue and has no close /
    // ESC / outside-click affordance at all (it's not a Radix Dialog).
    const mandatory = queue.find((a) => a.type === 'MANDATORY');
    if (mandatory) {
        const go = () => {
            if (mandatory.redirectUrl) {
                window.location.assign(mandatory.redirectUrl);
            }
        };
        return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
                <div className="flex max-h-[90vh] w-[60vw] min-w-[320px] max-w-[92vw] flex-col items-center gap-5 overflow-y-auto rounded-lg border bg-card p-8 text-center shadow-2xl">
                    <AnnouncementView
                        plainTitle
                        type={mandatory.type}
                        title={mandatory.title}
                        body={mandatory.body}
                    />
                    <Button
                        size="lg"
                        className="mt-1 min-w-[240px] gap-2"
                        onClick={go}
                        disabled={!mandatory.redirectUrl}
                    >
                        <ExternalLink className="h-5 w-5" />
                        Go to the new address
                    </Button>
                    {mandatory.redirectUrl && (
                        <p className="max-w-full break-all text-xs text-muted-foreground">
                            {mandatory.redirectUrl}
                        </p>
                    )}
                </div>
            </div>
        );
    }

    // Closing behaviour differs by type: info-only records "seen" and
    // advances; ack-required defers (stays unacknowledged, reappears).
    const handleOpenChange = (v) => {
        if (v) return;
        if (current.requireAck) setOpen(false);
        else acknowledge();
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                style={{ width: '60vw', maxWidth: '92vw', minWidth: 320 }}
                className="flex flex-col items-center gap-4 p-8 text-center"
            >
                <AnnouncementView
                    type={current.type}
                    title={current.title}
                    body={current.body}
                />

                {current.requireAck && (
                    <div className="w-full space-y-1.5 text-left">
                        <Label htmlFor="ann-reply" className="text-xs">
                            Your response{' '}
                            {commentRequired ? (
                                <span className="text-destructive">
                                    (required)
                                </span>
                            ) : (
                                <span className="text-muted-foreground">
                                    (optional)
                                </span>
                            )}
                        </Label>
                        <Textarea
                            id="ann-reply"
                            value={comment}
                            rows={2}
                            maxLength={1000}
                            onChange={(e) => setComment(e.target.value)}
                            placeholder="Add a reply for the sender…"
                            disabled={submitting}
                        />
                    </div>
                )}

                <DialogFooter className="flex w-full items-center justify-center gap-2 sm:justify-center sm:space-x-0">
                    {current.requireAck ? (
                        <>
                            <Button
                                variant="ghost"
                                onClick={() => setOpen(false)}
                                disabled={submitting}
                            >
                                Later
                            </Button>
                            <Button
                                onClick={acknowledge}
                                disabled={submitting || commentMissing}
                                title={
                                    commentMissing
                                        ? 'A written response is required'
                                        : undefined
                                }
                            >
                                {submitting && (
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                )}
                                I understand
                            </Button>
                        </>
                    ) : (
                        <Button
                            onClick={acknowledge}
                            disabled={submitting}
                            className="min-w-[120px]"
                        >
                            {submitting && (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            )}
                            Close
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
