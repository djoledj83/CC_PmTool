import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

// Top-bar "What's new" trigger. The Sparkles icon pulses when the
// RELEASE_NOTES.md file on disk has been edited since the user last
// opened this popover. Opening the popover both shows the latest
// section titles and stamps `lastSeenReleaseNotesAt` on the user so
// the indicator stops pulsing.
//
// The full release notes live on the Help page (which also has the
// icon legend, capability matrix, etc.) — this popover is a quick
// "tell me what's changed since last time" surface.
export function ChangelogPopover() {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        let cancelled = false;
        api.get('/release-notes')
            .then((res) => {
                if (!cancelled) setData(res.data);
            })
            .catch(() => {
                // Silently degrade — the indicator just won't pulse
                // if the endpoint isn't reachable.
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const handleOpenChange = async (next) => {
        setOpen(next);
        if (!next) return;
        // Mark "seen" the moment the popover opens so the pulse
        // dies right away — don't wait for the user to read every
        // entry. Refresh the local view so the indicator state
        // updates without a page reload.
        if (data?.hasUpdates) {
            setLoading(true);
            try {
                await api.post('/release-notes/dismiss');
                setData((prev) =>
                    prev ? { ...prev, hasUpdates: false } : prev,
                );
            } catch {
                // ignore
            } finally {
                setLoading(false);
            }
        }
    };

    const sections = data?.sections || [];
    const hasUpdates = !!data?.hasUpdates;

    return (
        <Popover open={open} onOpenChange={handleOpenChange}>
            <PopoverTrigger
                aria-label="What's new"
                title={hasUpdates ? "What's new — new entries available" : "What's new"}
                className={cn(
                    'relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                    hasUpdates && 'text-amber-500 hover:text-amber-600',
                )}
            >
                <Sparkles
                    className={cn(
                        'h-4 w-4',
                        hasUpdates && 'animate-pulse',
                    )}
                />
                {hasUpdates && (
                    <span
                        aria-hidden
                        className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-amber-500"
                    />
                )}
            </PopoverTrigger>
            <PopoverContent
                align="end"
                side="bottom"
                className="w-80 max-w-[90vw] p-0"
            >
                <div className="flex items-center justify-between border-b px-3 py-2">
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium">
                        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                        What's new
                    </span>
                    <Link
                        to="/help"
                        onClick={() => setOpen(false)}
                        className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                    >
                        Open Help →
                    </Link>
                </div>
                {loading && (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                        Loading…
                    </p>
                )}
                {!loading && sections.length === 0 && (
                    <p className="px-3 py-4 text-xs text-muted-foreground">
                        No release notes available yet.
                    </p>
                )}
                {!loading && sections.length > 0 && (
                    <ul className="max-h-[60vh] overflow-y-auto divide-y">
                        {sections.map((s, idx) => (
                            <li
                                key={`${s.number}-${idx}`}
                                className="space-y-1 px-3 py-2"
                            >
                                <p className="flex items-baseline gap-1.5 text-xs font-semibold">
                                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                        {s.number}
                                    </span>
                                    <span className="line-clamp-2">
                                        {s.title}
                                    </span>
                                </p>
                                {s.preview && (
                                    <p className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                                        {s.preview}
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                {data?.lastModified && (
                    <p className="border-t px-3 py-1.5 text-[10px] text-muted-foreground tabular-nums">
                        Last edit:{' '}
                        {new Date(data.lastModified).toLocaleString()}
                    </p>
                )}
            </PopoverContent>
        </Popover>
    );
}

export default ChangelogPopover;
