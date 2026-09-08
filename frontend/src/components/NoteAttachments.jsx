import { useRef, useState } from 'react';

import { ImageLightbox } from '@/components/ImageLightbox';
import { toast } from 'sonner';
import {
    Paperclip,
    Image as ImageIcon,
    File as FileIcon,
    Download,
    X,
    Loader2,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, formatBytes, resolveAssetUrl } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// Best-effort guess at whether a file is an image we can show inline.
// Falls back to extension when the server didn't record a useful mime.
export function isImageFile(file) {
    const mt = (file?.mimeType || '').toLowerCase();
    if (mt.startsWith('image/')) return true;
    const name = (file?.originalName || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext);
}

function downloadUrl(url) {
    if (!url) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}download=1`;
}

// Composer field used inside the new-note form (and the task note
// dialog). Files are uploaded as soon as they're picked so the parent
// only ever has to send a list of ready ids when submitting the note.
//
// Props:
//   projectId: required - where the file gets stored.
//   noteId:    optional - if the file should be pinned to an existing
//                          note immediately (edit flow).
//   files:     [{ id, originalName, size, mimeType, url }, ...] uploaded
//              so far, owned by the parent.
//   onChange:  (newFiles) => void
//   disabled:  disable the picker while the host form is submitting
export function NoteAttachmentsField({
    projectId,
    noteId = null,
    files = [],
    onChange,
    disabled = false,
}) {
    const inputRef = useRef(null);
    const [uploading, setUploading] = useState(false);

    const pick = () => inputRef.current?.click();

    const upload = async (event) => {
        const list = Array.from(event.target.files || []);
        event.target.value = '';
        if (list.length === 0) return;
        setUploading(true);
        const added = [];
        for (const file of list) {
            const fd = new FormData();
            fd.append('file', file);
            // projectId / noteId go on the URL too — the upload route's
            // pre-flight access check runs before multer parses the
            // multipart body, so it can only see query params at that
            // stage.
            fd.append('projectId', projectId);
            if (noteId) fd.append('noteId', noteId);
            try {
                const params = { projectId };
                if (noteId) params.noteId = noteId;
                const { data } = await api.post('/files', fd, {
                    params,
                    headers: { 'Content-Type': 'multipart/form-data' },
                });
                added.push(data.file);
            } catch (err) {
                toast.error(
                    err.response?.data?.error ||
                        `Could not upload "${file.name}"`,
                );
            }
        }
        setUploading(false);
        if (added.length) onChange?.([...files, ...added]);
    };

    const remove = (file) => {
        // Files are stored permanently in the project's Files panel even
        // if the user removes them from the note draft — that's the
        // safer default so an accidental click doesn't lose an upload.
        // The note's `fileIds` list just no longer contains this id.
        onChange?.(files.filter((f) => f.id !== file.id));
    };

    return (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
                <input
                    ref={inputRef}
                    type="file"
                    multiple
                    hidden
                    onChange={upload}
                />
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5"
                    onClick={pick}
                    disabled={disabled || uploading || !projectId}
                >
                    {uploading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <Paperclip className="h-3.5 w-3.5" />
                    )}
                    {uploading ? 'Uploading…' : 'Attach files'}
                </Button>
                {files.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                        {files.length} attached · also available in the project
                        Files tab
                    </span>
                )}
            </div>
            {files.length > 0 && (
                <ul className="grid gap-2 sm:grid-cols-2">
                    {files.map((file) => {
                        const isImg = isImageFile(file);
                        return (
                            <li
                                key={file.id}
                                className="flex items-center gap-2 rounded-md border bg-card/60 p-2"
                            >
                                <div
                                    className={cn(
                                        'flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-muted',
                                    )}
                                >
                                    {isImg && file.url ? (
                                        <img
                                            src={resolveAssetUrl(file.url)}
                                            alt={file.originalName}
                                            className="h-full w-full object-cover"
                                            style={{ maxWidth: 'none', maxHeight: 'none' }}
                                        />
                                    ) : (
                                        <FileIcon className="h-4 w-4 text-muted-foreground" />
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-xs font-medium">
                                        {file.originalName}
                                    </p>
                                    <p className="truncate text-[11px] text-muted-foreground">
                                        {formatBytes(file.size)}
                                    </p>
                                </div>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                    onClick={() => remove(file)}
                                    disabled={disabled}
                                    title="Remove"
                                    aria-label="Remove attachment"
                                >
                                    <X className="h-3.5 w-3.5" />
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

// Read-only renderer used to display a saved note's attachments inline.
// Images open in an in-app lightbox; other files keep the download link.
export function NoteAttachmentsList({ files = [] }) {
    const [preview, setPreview] = useState(null);
    if (!files || files.length === 0) return null;
    return (
        <>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {files.map((file) => {
                const isImg = isImageFile(file);
                const href = file.url ? resolveAssetUrl(file.url) : null;
                const dl = href ? downloadUrl(href) : null;
                return (
                    <li
                        key={file.id}
                        className="overflow-hidden rounded-md border bg-white"
                    >
                        {isImg && href ? (
                            <button
                                type="button"
                                onClick={() =>
                                    setPreview({
                                        src: file.url,
                                        alt: file.originalName,
                                    })
                                }
                                className="block w-full cursor-zoom-in bg-muted text-left"
                                title={`View ${file.originalName}`}
                            >
                                <img
                                    src={href}
                                    alt={file.originalName}
                                    className="block h-32 w-full object-cover"
                                    style={{ maxWidth: 'none', maxHeight: 'none' }}
                                />
                            </button>
                        ) : null}
                        <div className="flex items-center gap-2 px-2 py-1.5">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted/60">
                                {isImg ? (
                                    <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
                                ) : (
                                    <FileIcon className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-xs font-medium">
                                    {file.originalName}
                                </p>
                                <p className="truncate text-[11px] text-muted-foreground">
                                    {formatBytes(file.size)}
                                </p>
                            </div>
                            {dl && (
                                <Button
                                    asChild
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7"
                                    title="Download"
                                >
                                    <a
                                        href={dl}
                                        target="_blank"
                                        rel="noreferrer"
                                        download={file.originalName}
                                    >
                                        <Download className="h-3.5 w-3.5" />
                                    </a>
                                </Button>
                            )}
                        </div>
                    </li>
                );
            })}
        </ul>
        <ImageLightbox
            open={Boolean(preview)}
            src={preview?.src}
            alt={preview?.alt}
            onClose={() => setPreview(null)}
        />
        </>
    );
}
