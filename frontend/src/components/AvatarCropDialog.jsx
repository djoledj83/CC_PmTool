import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import { Move, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

// Lightweight, dependency-free avatar cropper.
//
// Renders a square viewport with the chosen image inside it. The user
// can drag to pan and zoom with the slider / mouse wheel. On save the
// visible square is rasterised onto a fixed-size canvas (default
// 512×512) and exported as a JPEG `File`, ready to ship to multer.
//
// Props:
//   file        — the source File the user selected
//   open        — controlled open state
//   onOpenChange(open) — close handler
//   onCropped(file)    — fired with the resulting File on Save
//   outputSize  — square output edge in pixels (default 512)

const OUTPUT_DEFAULT = 512;
const MAX_ZOOM_MULT = 5;

function clamp(v, lo, hi) {
    if (lo > hi) return (lo + hi) / 2;
    return Math.max(lo, Math.min(hi, v));
}

export function AvatarCropDialog({
    file,
    open,
    onOpenChange,
    onCropped,
    outputSize = OUTPUT_DEFAULT,
    title = 'Crop your picture',
}) {
    const [src, setSrc] = useState(null);
    const [imgDims, setImgDims] = useState(null);
    const [vpSize, setVpSize] = useState(320);
    const [minZoom, setMinZoom] = useState(1);
    const [zoom, setZoom] = useState(1);
    const [tx, setTx] = useState(0);
    const [ty, setTy] = useState(0);
    const [saving, setSaving] = useState(false);

    const viewportRef = useRef(null);
    const imgRef = useRef(null);
    const dragRef = useRef(null);

    // Read the picked file into a data URL so the <img> can load it
    // without us touching the network.
    useEffect(() => {
        if (!file) {
            setSrc(null);
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => setSrc(e.target?.result || null);
        reader.onerror = () => setSrc(null);
        reader.readAsDataURL(file);
    }, [file]);

    // Reset crop state every time we get a new file.
    useEffect(() => {
        if (!file) return;
        setImgDims(null);
        setZoom(1);
        setTx(0);
        setTy(0);
    }, [file]);

    // Track the rendered viewport size so the math stays correct when
    // the dialog is responsive. Also re-clamps the offset whenever the
    // viewport resizes (e.g. rotating a phone).
    useLayoutEffect(() => {
        if (!open) return;
        const el = viewportRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => {
            const rect = el.getBoundingClientRect();
            const next = Math.round(rect.width);
            if (next > 0) setVpSize(next);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [open]);

    // Re-fit the image whenever the viewport size or natural image
    // dimensions change. Keeps the image covering the viewport (so the
    // user can never crop into empty space).
    useEffect(() => {
        if (!imgDims) return;
        const minZ = Math.max(vpSize / imgDims.w, vpSize / imgDims.h);
        setMinZoom(minZ);
        setZoom((z) => Math.max(z || minZ, minZ));
    }, [imgDims, vpSize]);

    // Re-clamp pan whenever zoom changes so we never expose empty
    // background past the image edges.
    useEffect(() => {
        if (!imgDims) return;
        const dispW = imgDims.w * zoom;
        const dispH = imgDims.h * zoom;
        setTx((v) => clamp(v, vpSize - dispW, 0));
        setTy((v) => clamp(v, vpSize - dispH, 0));
    }, [zoom, vpSize, imgDims]);

    const handleImgLoad = (e) => {
        const w = e.currentTarget.naturalWidth;
        const h = e.currentTarget.naturalHeight;
        if (!w || !h) return;
        setImgDims({ w, h });
        const minZ = Math.max(vpSize / w, vpSize / h);
        setMinZoom(minZ);
        setZoom(minZ);
        // Centre the image inside the viewport on first load.
        setTx((vpSize - w * minZ) / 2);
        setTy((vpSize - h * minZ) / 2);
    };

    const onPointerDown = (e) => {
        if (!imgDims) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = {
            id: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            startTx: tx,
            startTy: ty,
        };
    };

    const onPointerMove = (e) => {
        if (!dragRef.current || dragRef.current.id !== e.pointerId) return;
        if (!imgDims) return;
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        const dispW = imgDims.w * zoom;
        const dispH = imgDims.h * zoom;
        setTx(clamp(dragRef.current.startTx + dx, vpSize - dispW, 0));
        setTy(clamp(dragRef.current.startTy + dy, vpSize - dispH, 0));
    };

    const onPointerUp = (e) => {
        if (dragRef.current?.id === e.pointerId) {
            dragRef.current = null;
            try {
                e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
                // ignore — capture may already have been released
            }
        }
    };

    // Wheel zoom that keeps the point under the cursor stable. This is
    // the "Photoshop" feel users expect from any decent cropper.
    const onWheel = (e) => {
        if (!imgDims || !viewportRef.current) return;
        e.preventDefault();
        const max = minZoom * MAX_ZOOM_MULT;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const newZoom = clamp(zoom * factor, minZoom, max);
        if (newZoom === zoom) return;
        const rect = viewportRef.current.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const ix = (cx - tx) / zoom;
        const iy = (cy - ty) / zoom;
        const newTx = cx - ix * newZoom;
        const newTy = cy - iy * newZoom;
        const dispW = imgDims.w * newZoom;
        const dispH = imgDims.h * newZoom;
        setZoom(newZoom);
        setTx(clamp(newTx, vpSize - dispW, 0));
        setTy(clamp(newTy, vpSize - dispH, 0));
    };

    // Slider zooms toward the centre of the viewport.
    const handleSliderZoom = (raw) => {
        if (!imgDims) return;
        const max = minZoom * MAX_ZOOM_MULT;
        const newZoom = clamp(raw, minZoom, max);
        if (newZoom === zoom) return;
        const cx = vpSize / 2;
        const cy = vpSize / 2;
        const ix = (cx - tx) / zoom;
        const iy = (cy - ty) / zoom;
        const newTx = cx - ix * newZoom;
        const newTy = cy - iy * newZoom;
        const dispW = imgDims.w * newZoom;
        const dispH = imgDims.h * newZoom;
        setZoom(newZoom);
        setTx(clamp(newTx, vpSize - dispW, 0));
        setTy(clamp(newTy, vpSize - dispH, 0));
    };

    const handleReset = () => {
        if (!imgDims) return;
        setZoom(minZoom);
        setTx((vpSize - imgDims.w * minZoom) / 2);
        setTy((vpSize - imgDims.h * minZoom) / 2);
    };

    const handleSave = useCallback(async () => {
        if (!imgRef.current || !imgDims || !file) return;
        setSaving(true);
        try {
            // Source rectangle (in original image coordinates) that
            // corresponds to the visible viewport.
            const sx = -tx / zoom;
            const sy = -ty / zoom;
            const s = vpSize / zoom;

            const canvas = document.createElement('canvas');
            canvas.width = outputSize;
            canvas.height = outputSize;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Canvas not supported');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(
                imgRef.current,
                sx,
                sy,
                s,
                s,
                0,
                0,
                outputSize,
                outputSize,
            );

            const blob = await new Promise((resolve) =>
                canvas.toBlob(resolve, 'image/jpeg', 0.92),
            );
            if (!blob) throw new Error('Could not encode image');

            const baseName =
                (file.name || 'avatar').replace(/\.[a-z0-9]+$/i, '') ||
                'avatar';
            const out = new File([blob], `${baseName}-cropped.jpg`, {
                type: 'image/jpeg',
                lastModified: Date.now(),
            });
            onCropped?.(out);
            onOpenChange?.(false);
        } finally {
            setSaving(false);
        }
    }, [file, imgDims, tx, ty, zoom, vpSize, outputSize, onCropped, onOpenChange]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        Drag to position, scroll or use the slider to zoom.
                        The square area you see is what gets saved.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col items-center gap-3">
                    {/* Square viewport. Image is absolutely positioned
                        and translated/scaled to follow user input. The
                        outer ring + dimmed corners signal "this is what
                        will be cropped". */}
                    <div
                        ref={viewportRef}
                        className={cn(
                            'relative aspect-square w-full max-w-[320px] overflow-hidden rounded-md border bg-muted/40 select-none',
                            !src && 'animate-pulse',
                        )}
                        style={{ touchAction: 'none' }}
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerUp}
                        onWheel={onWheel}
                    >
                        {src && (
                            // The img element is positioned by transform;
                            // pointer events are disabled on it so the
                            // wrapper handles all drags uniformly.
                            //
                            // `maxWidth: 'none'` / `maxHeight: 'none'` are
                            // critical: Tailwind's preflight resets <img>
                            // to `max-width: 100%; height: auto`, which
                            // would otherwise cap our explicit pixel
                            // dimensions to the parent's width and squash
                            // the photo into a thin strip.
                            <img
                                ref={imgRef}
                                src={src}
                                alt=""
                                draggable={false}
                                onLoad={handleImgLoad}
                                style={{
                                    position: 'absolute',
                                    left: 0,
                                    top: 0,
                                    transformOrigin: '0 0',
                                    transform: `translate(${tx}px, ${ty}px) scale(${zoom})`,
                                    width: imgDims ? `${imgDims.w}px` : 'auto',
                                    height: imgDims ? `${imgDims.h}px` : 'auto',
                                    maxWidth: 'none',
                                    maxHeight: 'none',
                                    pointerEvents: 'none',
                                    userSelect: 'none',
                                }}
                            />
                        )}
                        {/* Circle preview overlay — most avatar
                            displays are round, so we softly dim the
                            corners and draw a thin outline marking the
                            circular crop. The dim is very light so the
                            user can still see what's outside the
                            circle while framing. */}
                        <div
                            className="pointer-events-none absolute inset-0 bg-black/15"
                            style={{
                                WebkitMaskImage:
                                    'radial-gradient(circle at center, transparent 49.5%, #000 50%)',
                                maskImage:
                                    'radial-gradient(circle at center, transparent 49.5%, #000 50%)',
                            }}
                        />
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                            <div className="h-[calc(100%-4px)] w-[calc(100%-4px)] rounded-full border-2 border-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]" />
                        </div>
                        <div className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white/90">
                            <Move className="mr-1 inline h-3 w-3 align-text-top" />
                            drag · scroll to zoom
                        </div>
                    </div>

                    {/* Zoom controls */}
                    <div className="flex w-full items-center gap-2 px-1">
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleSliderZoom(zoom * 0.85)}
                            disabled={!imgDims || zoom <= minZoom + 0.0001}
                            aria-label="Zoom out"
                        >
                            <ZoomOut className="h-4 w-4" />
                        </Button>
                        <input
                            type="range"
                            min={minZoom}
                            max={minZoom * MAX_ZOOM_MULT}
                            step={(minZoom * (MAX_ZOOM_MULT - 1)) / 100 || 0.01}
                            value={zoom}
                            onChange={(e) =>
                                handleSliderZoom(parseFloat(e.target.value))
                            }
                            disabled={!imgDims}
                            className="h-1 flex-1 cursor-pointer accent-primary"
                            aria-label="Zoom"
                        />
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleSliderZoom(zoom * 1.15)}
                            disabled={
                                !imgDims ||
                                zoom >= minZoom * MAX_ZOOM_MULT - 0.0001
                            }
                            aria-label="Zoom in"
                        >
                            <ZoomIn className="h-4 w-4" />
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1 px-2 text-xs"
                            onClick={handleReset}
                            disabled={!imgDims}
                        >
                            <RefreshCw className="h-3.5 w-3.5" />
                            Reset
                        </Button>
                    </div>
                </div>

                <DialogFooter>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => onOpenChange?.(false)}
                        disabled={saving}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        onClick={handleSave}
                        disabled={saving || !imgDims}
                    >
                        {saving ? 'Saving…' : 'Save picture'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
