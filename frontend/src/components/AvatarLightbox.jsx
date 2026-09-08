// Full-screen avatar viewer with a subtle parallax tilt. Opened by
// clicking a user's profile photo; closes on backdrop click or Escape.
// The image + caption tilt toward the cursor (3D parallax) and the
// caption sits on a raised Z-plane so it floats above the photo.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

const FLAT = { rx: 0, ry: 0, tx: 0, ty: 0 };

export default function AvatarLightbox({ open, src, name, subtitle, onClose }) {
    const frameRef = useRef(null);
    const [tilt, setTilt] = useState(FLAT);

    // Escape closes; also reset the tilt whenever we open/close.
    useEffect(() => {
        if (!open) {
            setTilt(FLAT);
            return;
        }
        const onKey = (e) => {
            if (e.key === 'Escape') onClose?.();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open || !src) return null;

    const handleMove = (e) => {
        const r = frameRef.current?.getBoundingClientRect();
        if (!r) return;
        const px = (e.clientX - r.left) / r.width - 0.5; // -0.5 … 0.5
        const py = (e.clientY - r.top) / r.height - 0.5;
        setTilt({ rx: -py * 14, ry: px * 14, tx: px * -20, ty: py * -20 });
    };

    return createPortal(
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm duration-200 animate-in fade-in-0"
            style={{ perspective: '1200px' }}
            onClick={onClose}
            onMouseMove={handleMove}
            onMouseLeave={() => setTilt(FLAT)}
        >
            <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
            >
                <X className="h-5 w-5" />
            </button>

            <div
                ref={frameRef}
                onClick={(e) => e.stopPropagation()}
                className="relative duration-300 animate-in zoom-in-95 fade-in-0"
                style={{
                    transform: `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
                    transformStyle: 'preserve-3d',
                    transition: 'transform .15s ease-out',
                }}
            >
                <div
                    className="overflow-hidden rounded-2xl border border-white/15 shadow-2xl"
                    style={{
                        transform: `translate(${tilt.tx}px, ${tilt.ty}px)`,
                        transition: 'transform .15s ease-out',
                    }}
                >
                    <img
                        src={src}
                        alt={name || ''}
                        draggable={false}
                        className="block max-h-[70vh] w-auto max-w-[85vw] object-cover"
                    />
                    {(name || subtitle) && (
                        <div
                            className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-5 pb-4 pt-12 text-white"
                            style={{ transform: 'translateZ(40px)' }}
                        >
                            {name && (
                                <div className="text-lg font-semibold leading-tight">
                                    {name}
                                </div>
                            )}
                            {subtitle && (
                                <div className="text-sm text-white/80">
                                    {subtitle}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
}
