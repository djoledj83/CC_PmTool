import { X } from 'lucide-react';

import { resolveAssetUrl } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from '@/components/ui/dialog';

/**
 * Simple full-screen image preview for note / attachment thumbnails.
 * Replaces opening photos in a new browser tab.
 */
export function ImageLightbox({ open, src, alt, onClose }) {
    if (!src) return null;
    const url = resolveAssetUrl(src);
    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="max-w-[min(96vw,900px)] border-0 bg-black/95 p-2 sm:p-4">
                <DialogTitle className="sr-only">
                    {alt || 'Image preview'}
                </DialogTitle>
                <div className="relative flex max-h-[85vh] min-h-[200px] items-center justify-center">
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="absolute right-1 top-1 z-10 h-8 w-8 text-white hover:bg-white/20"
                        onClick={onClose}
                        aria-label="Close preview"
                    >
                        <X className="h-4 w-4" />
                    </Button>
                    <img
                        src={url}
                        alt={alt || 'Attachment'}
                        className="max-h-[85vh] w-auto max-w-full rounded object-contain"
                    />
                </div>
                {alt ? (
                    <p className="truncate px-2 pb-1 text-center text-xs text-white/70">
                        {alt}
                    </p>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}
