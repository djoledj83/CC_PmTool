// Attachment building blocks for tickets, shared by the requester portal
// and the agent workspace.
//   - TicketAttachments : ticket-level section (list + immediate upload)
//   - AttachmentList     : read display of a list (download + remove),
//                          used to render a single comment's files
//   - PendingFilePicker  : local file picker for composers / the raise
//                          dialog; files are uploaded by the parent after
//                          the message / ticket exists
// The backend (ticketFileFilter) blocks executables / scripts / .svg /
// .html; everything else up to 50MB is accepted.
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Paperclip, Download, X, Loader2 } from 'lucide-react';

import { api } from '@/lib/api';
import { resolveAssetUrl } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// Image attachments get an inline thumbnail + click-to-zoom lightbox;
// everything else stays a plain file row.
const IMAGE_EXTS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif',
]);
export function isImageAttachment(att) {
    if (att?.mime && att.mime.startsWith('image/')) return true;
    const ext = (att?.originalName?.split('.').pop() || '').toLowerCase();
    return IMAGE_EXTS.has(ext);
}

// Image viewer. The modal box hugs the image: on load we measure the
// image and scale it (up or down) by its own proportions to fill ~92% of
// the screen, so there's no wasted dark space around small images. Click
// the backdrop or the × (or press Esc) to close.
export function ImageLightbox({ src, alt, onClose }) {
    const [dims, setDims] = useState(null);

    useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && onClose?.();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    // Reset measured size when the image source changes.
    useEffect(() => setDims(null), [src]);

    const fitToScreen = (e) => {
        const w = e.currentTarget.naturalWidth;
        const h = e.currentTarget.naturalHeight;
        if (!w || !h) return;
        const scale = Math.min(
            (window.innerWidth * 0.95) / w,
            (window.innerHeight * 0.92) / h,
        );
        setDims({ width: Math.round(w * scale), height: Math.round(h * scale) });
    };

    if (!src) return null;
    return (
        <div
            onClick={onClose}
            className="fixed inset-0 z-[60] flex items-center justify-center p-2 backdrop-blur-md"
        >
            <div className="relative" onClick={(e) => e.stopPropagation()}>
                <button
                    type="button"
                    onClick={onClose}
                    className="absolute -right-3 -top-3 z-10 rounded-full bg-white p-1.5 text-black shadow-lg ring-1 ring-black/10 hover:bg-white/90"
                    aria-label="Close"
                >
                    <X className="h-4 w-4" />
                </button>
                <img
                    src={src}
                    alt={alt || ''}
                    onLoad={fitToScreen}
                    style={
                        dims
                            ? { width: dims.width, height: dims.height }
                            : undefined
                    }
                    className="block max-h-[92vh] max-w-[95vw] rounded-lg object-contain shadow-2xl ring-1 ring-white/10"
                />
            </div>
        </div>
    );
}

export function formatBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Extensions the backend rejects — surfaced here only to give a clearer
// client-side message before the round-trip. The server is the source
// of truth.
const BLOCKED = new Set([
    'exe', 'bat', 'cmd', 'com', 'msi', 'scr', 'cpl',
    'ps1', 'vbs', 'js', 'mjs', 'jse', 'wsf', 'wsh',
    'html', 'htm', 'xhtml', 'svg', 'xml', 'xsl',
    'php', 'phtml', 'jsp', 'asp', 'aspx',
    'sh', 'bash', 'zsh', 'dll', 'so', 'dylib',
]);

export function isAllowedFile(file) {
    if (!file?.name?.includes('.')) return false;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return !BLOCKED.has(ext);
}

// Pasted images share the project-wide 50MB file cap.
export const PASTE_IMAGE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

// Pull image files out of a clipboard paste (screenshots, copied photos)
// and return them as named File objects within the size cap. Clipboard
// images usually arrive unnamed, so we synthesise a filename + extension.
export function imagesFromClipboard(e, maxBytes = PASTE_IMAGE_MAX_BYTES) {
    const items = Array.from(e.clipboardData?.items || []);
    const out = [];
    let tooBig = false;
    for (const it of items) {
        if (it.kind !== 'file' || !it.type.startsWith('image/')) continue;
        const file = it.getAsFile();
        if (!file) continue;
        if (file.size > maxBytes) {
            tooBig = true;
            continue;
        }
        const named =
            file.name && file.name.includes('.')
                ? file
                : new File(
                      [file],
                      `pasted-${Date.now()}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`,
                      { type: file.type },
                  );
        out.push(named);
    }
    if (tooBig) {
        toast.error('That image is too large to paste (max 50 MB).');
    }
    return out;
}

// Upload one File against a ticket, optionally pinned to a message.
export async function uploadTicketFile(ticketId, file, messageId) {
    const fd = new FormData();
    fd.append('file', file);
    if (messageId) fd.append('messageId', messageId);
    return api.post(`/tickets/${ticketId}/attachments`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
    });
}

// Read display of a list of attachments with download + optional remove.
export function AttachmentList({
    items,
    ticketId,
    currentUserId,
    canManage = false,
    onChanged,
    className,
}) {
    const [lightbox, setLightbox] = useState(null);
    if (!items || items.length === 0) return null;
    const remove = async (att) => {
        if (!window.confirm(`Remove "${att.originalName}"?`)) return;
        try {
            await api.delete(`/tickets/${ticketId}/attachments/${att.id}`);
            await onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not remove.');
        }
    };
    return (
        <>
        <ul className={className || 'space-y-1.5'}>
            {items.map((att) => {
                const canRemove =
                    canManage || att.uploader?.id === currentUserId;
                const img = isImageAttachment(att);
                const url = resolveAssetUrl(att.url);
                return (
                    <li
                        key={att.id}
                        // text-foreground is explicit so the filename stays
                        // readable even when this row sits inside a coloured
                        // message bubble (e.g. a sent reply), where it would
                        // otherwise inherit white text on its white background.
                        className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-sm text-foreground"
                    >
                        {img ? (
                            <button
                                type="button"
                                onClick={() => setLightbox(att)}
                                className="shrink-0 overflow-hidden rounded border"
                                title="View image"
                            >
                                <img
                                    src={url}
                                    alt={att.originalName}
                                    className="h-9 w-9 object-cover"
                                />
                            </button>
                        ) : (
                            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                            {att.originalName}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                            {formatBytes(att.size)}
                        </span>
                        <a
                            href={resolveAssetUrl(att.url)}
                            target="_blank"
                            rel="noreferrer"
                            download={att.originalName}
                            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                            title="Download"
                        >
                            <Download className="h-3.5 w-3.5" />
                        </a>
                        {canRemove && onChanged && (
                            <button
                                type="button"
                                onClick={() => remove(att)}
                                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-rose-600"
                                title="Remove"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </li>
                );
            })}
        </ul>
        {lightbox && (
            <ImageLightbox
                src={resolveAssetUrl(lightbox.url)}
                alt={lightbox.originalName}
                onClose={() => setLightbox(null)}
            />
        )}
        </>
    );
}

// Local file picker for composers / dialogs. Files are held in parent
// state and uploaded by the parent once the message / ticket exists.
export function PendingFilePicker({
    files = [],
    onFiles,
    disabled = false,
    label = 'Attach file',
}) {
    const inputRef = useRef(null);
    const [preview, setPreview] = useState(null);
    // Object URLs so pasted/picked images get an inline thumbnail before
    // they're uploaded. Revoked when the file set changes / unmounts.
    const previews = useMemo(
        () =>
            files.map((f) =>
                f.type?.startsWith('image/') ? URL.createObjectURL(f) : null,
            ),
        [files],
    );
    useEffect(
        () => () => previews.forEach((u) => u && URL.revokeObjectURL(u)),
        [previews],
    );
    const add = (e) => {
        const picked = Array.from(e.target.files || []);
        e.target.value = '';
        const ok = [];
        for (const f of picked) {
            if (isAllowedFile(f)) ok.push(f);
            else toast.error(`"${f.name}" — that file type is not allowed.`);
        }
        if (ok.length) onFiles([...(files || []), ...ok]);
    };
    const removeAt = (i) => onFiles(files.filter((_, idx) => idx !== i));
    return (
        <div className="space-y-1.5">
            <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => inputRef.current?.click()}
                disabled={disabled}
            >
                <Paperclip className="h-3.5 w-3.5" />
                {label}
            </Button>
            <input
                ref={inputRef}
                type="file"
                multiple
                className="hidden"
                onChange={add}
            />
            {files.length > 0 && (
                <ul className="space-y-1">
                    {files.map((f, i) => (
                        <li
                            key={`${f.name}-${i}`}
                            className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs"
                        >
                            {previews[i] ? (
                                <button
                                    type="button"
                                    onClick={() =>
                                        setPreview({
                                            src: previews[i],
                                            alt: f.name,
                                        })
                                    }
                                    className="shrink-0 overflow-hidden rounded border"
                                    title="View image"
                                >
                                    <img
                                        src={previews[i]}
                                        alt={f.name}
                                        className="h-8 w-8 object-cover"
                                    />
                                </button>
                            ) : (
                                <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1 truncate">
                                {f.name}
                            </span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                                {formatBytes(f.size)}
                            </span>
                            <button
                                type="button"
                                onClick={() => removeAt(i)}
                                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-rose-600"
                                title="Remove"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {preview && (
                <ImageLightbox
                    src={preview.src}
                    alt={preview.alt}
                    onClose={() => setPreview(null)}
                />
            )}
        </div>
    );
}

// Ticket-level attachments section: list + an Attach button that uploads
// immediately (messageId stays null).
export function TicketAttachments({
    ticketId,
    attachments = [],
    currentUserId,
    canManage = false,
    canUpload = true,
    onChanged,
}) {
    const inputRef = useRef(null);
    const [uploading, setUploading] = useState(false);

    const onFile = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        if (!isAllowedFile(file)) {
            toast.error('That file type is not allowed (no executables or scripts).');
            return;
        }
        setUploading(true);
        try {
            await uploadTicketFile(ticketId, file);
            await onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Upload failed.');
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-muted-foreground">
                    Attachments
                </h3>
                {canUpload && (
                    <>
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1.5 px-2 text-xs"
                            onClick={() => inputRef.current?.click()}
                            disabled={uploading}
                        >
                            {uploading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Paperclip className="h-3.5 w-3.5" />
                            )}
                            Attach file
                        </Button>
                        <input
                            ref={inputRef}
                            type="file"
                            className="hidden"
                            onChange={onFile}
                        />
                    </>
                )}
            </div>
            {attachments.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    No files attached yet.
                </p>
            ) : (
                <AttachmentList
                    items={attachments}
                    ticketId={ticketId}
                    currentUserId={currentUserId}
                    canManage={canManage}
                    onChanged={onChanged}
                />
            )}
        </div>
    );
}

export default TicketAttachments;
