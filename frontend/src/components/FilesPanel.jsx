import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
    Download,
    Eye,
    File as FileIcon,
    FileSpreadsheet,
    FileText,
    FileType2,
    GitBranch,
    Image as ImageIcon,
    MessageSquare,
    Presentation,
    Trash2,
    Upload,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, formatBytes, initials, resolveAssetUrl } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/contexts/AuthContext';

function formatTimestamp(d) {
    if (!d) return '';
    return format(new Date(d), 'MMM d, yyyy h:mm a');
}

// Office formats grouped by the desktop app users actually open them in.
// We deliberately treat them as a separate "office" kind because the
// browser can't render them natively — trying to fetch them as text
// (the way we do for plain text files) returns garbage and, for big
// xlsx files, just spins until it hits the size cap.
const OFFICE_TYPES = {
    spreadsheet: {
        exts: ['xls', 'xlsx', 'xlsm', 'xlsb', 'ods', 'csv', 'numbers'],
        // CSV is also handled as text below for small files; for >256KB
        // CSVs the office card kicks in instead so we never show "too
        // large to preview".
        mimes: [
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.oasis.opendocument.spreadsheet',
        ],
        appHint: 'Excel / Numbers / Sheets',
        Icon: FileSpreadsheet,
        accent: 'text-emerald-600 dark:text-emerald-400',
    },
    document: {
        exts: ['doc', 'docx', 'odt', 'rtf', 'pages'],
        mimes: [
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.oasis.opendocument.text',
            'application/rtf',
        ],
        appHint: 'Word / Pages / Docs',
        Icon: FileType2,
        accent: 'text-sky-600 dark:text-sky-400',
    },
    presentation: {
        exts: ['ppt', 'pptx', 'odp', 'key'],
        mimes: [
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'application/vnd.oasis.opendocument.presentation',
        ],
        appHint: 'PowerPoint / Keynote / Slides',
        Icon: Presentation,
        accent: 'text-amber-600 dark:text-amber-400',
    },
};

function detectOfficeType(ext, mt) {
    for (const [key, def] of Object.entries(OFFICE_TYPES)) {
        if (def.exts.includes(ext) || def.mimes.includes(mt)) {
            return key;
        }
    }
    return null;
}

// Best-effort classification so we can pick the right viewer. Falls back
// to inspecting the filename extension when the server didn't record a
// useful mimeType (older uploads, generic application/octet-stream).
function classifyFile(file) {
    const mt = (file.mimeType || '').toLowerCase();
    const name = (file.originalName || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    const SMALL = 256 * 1024;

    if (mt.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
        return { kind: 'image', ext };
    }
    if (mt === 'application/pdf' || ext === 'pdf') {
        return { kind: 'pdf', ext };
    }
    const officeKind = detectOfficeType(ext, mt);
    // CSVs and similar small "text-ish" office files can still preview as
    // text below the size cap. Large ones fall through to the office card
    // so we don't try to fetch a 15MB spreadsheet as a string.
    if (officeKind && (officeKind !== 'spreadsheet' || file.size > SMALL || ext !== 'csv')) {
        return { kind: 'office', ext, office: officeKind };
    }
    if (
        mt.startsWith('text/') ||
        ['txt', 'md', 'log', 'json', 'csv', 'xml', 'yml', 'yaml', 'js', 'ts', 'tsx', 'jsx', 'css', 'html', 'sql'].includes(
            ext,
        )
    ) {
        return { kind: 'text', ext };
    }
    return { kind: 'other', ext };
}

function fileIconFor(meta) {
    if (!meta) return FileIcon;
    if (meta.kind === 'office' && meta.office) {
        return OFFICE_TYPES[meta.office].Icon;
    }
    switch (meta.kind) {
        case 'image':
            return ImageIcon;
        case 'pdf':
        case 'text':
            return FileText;
        default:
            return FileIcon;
    }
}

function fileIconAccent(meta) {
    if (meta?.kind === 'office' && meta.office) {
        return OFFICE_TYPES[meta.office].accent;
    }
    if (meta?.kind === 'image') return 'text-violet-600 dark:text-violet-400';
    if (meta?.kind === 'pdf') return 'text-rose-600 dark:text-rose-400';
    if (meta?.kind === 'text') return 'text-slate-600 dark:text-slate-300';
    return 'text-muted-foreground';
}

// Returns the upload URL with ?download=1 appended so the server forces
// an attachment Content-Disposition regardless of file type. Used for
// explicit Download buttons.
function downloadUrl(url) {
    if (!url) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}download=1`;
}

export function FilesPanel({ projectId, changeRequestId = null }) {
    const { user: currentUser } = useAuth();
    const isAdmin = currentUser?.role === 'ADMIN';
    // CR mode collapses two ideas at once (mirrors NotesPanel):
    //   - GET narrows to files "about" this CR (direct CR pin + files
    //     on CR-pinned notes + files on notes pinned to CR-scoped
    //     tasks)
    //   - POST auto-stamps the CR id so new uploads from this panel
    //     show up in the CR Files tab without an extra step
    // Outside CR mode the panel keeps its original "whole project"
    // semantics — same code path, just no CR scoping.
    const crMode = Boolean(changeRequestId);
    const [files, setFiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    // The file currently shown in the preview modal, or null when closed.
    const [previewing, setPreviewing] = useState(null);
    const inputRef = useRef(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const params = { projectId };
                if (crMode) params.changeRequestId = changeRequestId;
                const { data } = await api.get('/files', { params });
                if (!cancelled) setFiles(data.files);
            } catch (err) {
                toast.error(err.response?.data?.error || 'Failed to load files');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [projectId, changeRequestId, crMode]);

    const handlePick = () => inputRef.current?.click();

    const handleSelected = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;

        const fd = new FormData();
        fd.append('file', file);
        // Also keep it in the body in case some other middleware
        // wants it post-multer. The route's pre-flight access gate
        // reads from req.query though — that's the one that matters.
        fd.append('projectId', projectId);
        // In CR mode, stamp every new upload with the CR id so it
        // surfaces in the CR Files tab. The backend reconciles the
        // pin against any note pin and rejects mismatches.
        const uploadParams = { projectId };
        if (crMode) {
            fd.append('changeRequestId', changeRequestId);
            uploadParams.changeRequestId = changeRequestId;
        }

        setUploading(true);
        try {
            const { data } = await api.post('/files', fd, {
                params: uploadParams,
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            setFiles((prev) => [data.file, ...prev]);
            toast.success('File uploaded');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Upload failed');
        } finally {
            setUploading(false);
        }
    };

    const handleDelete = async (file) => {
        if (!window.confirm(`Delete "${file.originalName}"?`)) return;
        try {
            await api.delete(`/files/${file.id}`);
            setFiles((prev) => prev.filter((f) => f.id !== file.id));
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete file');
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border bg-card p-3">
                <div>
                    <p className="text-sm font-medium">Files</p>
                    <p className="text-xs text-muted-foreground">
                        Upload documents, images, and other attachments (max 50&nbsp;MB).
                    </p>
                </div>
                <input
                    ref={inputRef}
                    type="file"
                    hidden
                    onChange={handleSelected}
                />
                <Button
                    size="sm"
                    className="gap-2"
                    onClick={handlePick}
                    disabled={uploading}
                >
                    <Upload className="h-4 w-4" />
                    {uploading ? 'Uploading...' : 'Upload file'}
                </Button>
            </div>

            {loading ? (
                <p className="text-sm text-muted-foreground">Loading files...</p>
            ) : files.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No files yet. Upload your first attachment above.
                </p>
            ) : (
                <ul className="divide-y rounded-lg border bg-card">
                    {files.map((file) => {
                        // Delete is admin-only under the new policy.
                        const canDelete = isAdmin;
                        const meta = classifyFile(file);
                        // Office docs always open the modal (which shows a
                        // friendly "open in <app>" card) rather than trying
                        // to download or guess. Plain "other" files fall
                        // through to download in a new tab.
                        const previewable = meta.kind !== 'other';
                        const Icon = fileIconFor(meta);
                        const iconAccent = fileIconAccent(meta);
                        return (
                            <li
                                key={file.id}
                                className="flex items-center gap-3 px-4 py-3"
                            >
                                <button
                                    type="button"
                                    onClick={() =>
                                        previewable
                                            ? setPreviewing(file)
                                            : window.open(
                                                  downloadUrl(
                                                      resolveAssetUrl(file.url),
                                                  ),
                                                  '_blank',
                                                  'noreferrer',
                                              )
                                    }
                                    className={cn(
                                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted/60 transition-colors hover:bg-primary/10',
                                        iconAccent,
                                        previewable && 'cursor-pointer',
                                    )}
                                    title={previewable ? 'Preview' : 'Open file'}
                                    aria-label={
                                        previewable ? 'Preview file' : 'Open file'
                                    }
                                >
                                    <Icon className="h-5 w-5" />
                                </button>
                                <div className="min-w-0 flex-1">
                                    {previewable ? (
                                        <button
                                            type="button"
                                            onClick={() => setPreviewing(file)}
                                            className="block w-full truncate text-left text-sm font-medium hover:underline"
                                        >
                                            {file.originalName}
                                        </button>
                                    ) : (
                                        <p className="truncate text-sm font-medium">
                                            {file.originalName}
                                        </p>
                                    )}
                                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                                        <span>{formatBytes(file.size)}</span>
                                        <span>·</span>
                                        <span>{formatTimestamp(file.createdAt)}</span>
                                        <span>·</span>
                                        <span className="flex items-center gap-1">
                                            <Avatar className="h-4 w-4">
                                                {file.uploader?.avatarUrl && (
                                                    <AvatarImage
                                                        src={resolveAssetUrl(
                                                            file.uploader.avatarUrl,
                                                        )}
                                                        alt={file.uploader.name}
                                                    />
                                                )}
                                                <AvatarFallback className="bg-primary/10 text-[8px] text-primary">
                                                    {initials(file.uploader?.name)}
                                                </AvatarFallback>
                                            </Avatar>
                                            {file.uploader?.name}
                                        </span>
                                        {(() => {
                                            // A file can be "about" a CR in three
                                            // ways: a direct CR pin, a note pin
                                            // where the note itself targets a
                                            // CR, or a note pin where the note
                                            // targets a CR-scoped task. We
                                            // collapse them into ONE chip
                                            // because surfacing two/three
                                            // overlapping CR badges per row
                                            // becomes visual noise. The chip
                                            // deep-links into the CR's Files
                                            // tab so the user lands where the
                                            // file is most discoverable. We
                                            // intentionally suppress the chip
                                            // in CR-mode (the panel is already
                                            // scoped to that CR — repeating
                                            // the badge on every row is just
                                            // chrome).
                                            if (crMode) return null;
                                            const cr =
                                                file.changeRequest ||
                                                file.note?.changeRequest ||
                                                file.note?.task?.changeRequest ||
                                                null;
                                            if (!cr) return null;
                                            return (
                                                <Link
                                                    to={`/projects/${projectId}/cr/${cr.id}#file-${file.id}`}
                                                    title={`Change request ${cr.code}: ${cr.title}`}
                                                    className="inline-flex items-center gap-1 rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-800 transition-colors hover:border-violet-400 hover:bg-violet-100 dark:border-violet-500/50 dark:bg-violet-500/15 dark:text-violet-200 dark:hover:bg-violet-500/25"
                                                >
                                                    <GitBranch className="h-3 w-3" />
                                                    {cr.code || 'CR'}
                                                </Link>
                                            );
                                        })()}
                                        {file.note ? (
                                            <Link
                                                /* Route to the CR notes tab when
                                                   the source note is itself
                                                   CR-scoped — either directly
                                                   pinned to a CR or pinned to a
                                                   task that lives in a CR — so
                                                   the "From note" chip lands
                                                   the user on the right
                                                   surface instead of the
                                                   project-wide Notes tab where
                                                   the note doesn't appear. */
                                                to={(() => {
                                                    const noteCrId =
                                                        file.note.changeRequestId ||
                                                        file.note.changeRequest?.id ||
                                                        file.note.task?.changeRequestId ||
                                                        file.note.task?.changeRequest?.id ||
                                                        null;
                                                    if (noteCrId) {
                                                        return `/projects/${projectId}/cr/${noteCrId}#note-${file.note.id}`;
                                                    }
                                                    return `/projects/${projectId}#note-${file.note.id}`;
                                                })()}
                                                title={
                                                    file.note.preview ||
                                                    'Open the source note'
                                                }
                                                className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 transition-colors hover:border-amber-300 hover:bg-amber-100 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200 dark:hover:bg-amber-400/20"
                                            >
                                                <MessageSquare className="h-3 w-3" />
                                                From note
                                            </Link>
                                        ) : null}
                                    </div>
                                </div>
                                <div className="flex items-center gap-1">
                                    {previewable && (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-8 w-8"
                                            onClick={() => setPreviewing(file)}
                                            title="Preview"
                                            aria-label="Preview"
                                        >
                                            <Eye className="h-4 w-4" />
                                        </Button>
                                    )}
                                    <Button
                                        asChild
                                        size="icon"
                                        variant="ghost"
                                        className="h-8 w-8"
                                    >
                                        <a
                                            href={downloadUrl(
                                                resolveAssetUrl(file.url),
                                            )}
                                            target="_blank"
                                            rel="noreferrer"
                                            download={file.originalName}
                                            title="Download"
                                        >
                                            <Download className="h-4 w-4" />
                                        </a>
                                    </Button>
                                    {canDelete && (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-8 w-8 text-destructive hover:text-destructive"
                                            onClick={() => handleDelete(file)}
                                            title="Delete"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            <FilePreviewDialog
                file={previewing}
                onClose={() => setPreviewing(null)}
            />
        </div>
    );
}

// Modal that shows the file inline whenever the browser can render it
// natively (images, PDFs, small plain text). Office documents and any
// other binary formats get a friendly "Open in <desktop app>" card with
// a download button, so we never try to fetch them as text.
function FilePreviewDialog({ file, onClose }) {
    const [textBody, setTextBody] = useState(null);
    const [textErr, setTextErr] = useState(null);

    const open = Boolean(file);
    const meta = file ? classifyFile(file) : null;
    const kind = meta?.kind || null;
    const url = file ? resolveAssetUrl(file.url) : null;
    const dlUrl = url ? downloadUrl(url) : null;

    useEffect(() => {
        setTextBody(null);
        setTextErr(null);
        if (!file || kind !== 'text' || !url) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                if (blob.size > 256 * 1024) {
                    if (!cancelled)
                        setTextErr(
                            'File is too large to preview. Please download it instead.',
                        );
                    return;
                }
                const txt = await blob.text();
                if (!cancelled) setTextBody(txt);
            } catch (err) {
                if (!cancelled) setTextErr(err.message || 'Failed to load preview');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [file, kind, url]);

    if (!file) return null;

    const HeaderIcon = fileIconFor(meta);
    const headerAccent = fileIconAccent(meta);

    return (
        <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="max-h-[90vh] w-[min(95vw,1000px)] max-w-none overflow-hidden p-0 sm:rounded-lg">
                <DialogHeader className="border-b px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                            <span
                                className={cn(
                                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted/60',
                                    headerAccent,
                                )}
                            >
                                <HeaderIcon className="h-5 w-5" />
                            </span>
                            <div className="min-w-0">
                                <DialogTitle className="truncate text-base">
                                    {file.originalName}
                                </DialogTitle>
                                <DialogDescription className="text-xs">
                                    {formatBytes(file.size)}
                                    {file.mimeType ? ` · ${file.mimeType}` : ''}
                                </DialogDescription>
                            </div>
                        </div>
                        <Button asChild size="sm" variant="outline" className="gap-2">
                            <a
                                href={dlUrl}
                                target="_blank"
                                rel="noreferrer"
                                download={file.originalName}
                            >
                                <Download className="h-4 w-4" />
                                Download
                            </a>
                        </Button>
                    </div>
                </DialogHeader>
                <div className="max-h-[75vh] overflow-auto bg-muted/30">
                    {kind === 'image' && (
                        <div className="flex items-center justify-center p-4">
                            <img
                                src={url}
                                alt={file.originalName}
                                className="max-h-[70vh] max-w-full rounded shadow"
                            />
                        </div>
                    )}
                    {kind === 'pdf' && (
                        <iframe
                            src={url}
                            title={file.originalName}
                            className="h-[75vh] w-full border-0 bg-white"
                        />
                    )}
                    {kind === 'text' && (
                        <div className="p-4">
                            {textErr ? (
                                <p className="text-sm text-destructive">
                                    {textErr}
                                </p>
                            ) : textBody == null ? (
                                <p className="text-sm text-muted-foreground">
                                    Loading preview…
                                </p>
                            ) : (
                                <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded border bg-card p-3 text-xs">
                                    {textBody}
                                </pre>
                            )}
                        </div>
                    )}
                    {kind === 'office' && (
                        <OfficeDocCard meta={meta} file={file} dlUrl={dlUrl} />
                    )}
                    {kind === 'other' && (
                        <div className="space-y-3 p-8 text-center">
                            <p className="text-sm">
                                This file type can't be previewed in the browser.
                            </p>
                            <Button asChild className="gap-2">
                                <a
                                    href={dlUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    download={file.originalName}
                                >
                                    <Download className="h-4 w-4" />
                                    Download
                                </a>
                            </Button>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

// Friendly "open in your desktop app" card for Office documents. We
// deliberately don't try to render xlsx/docx/pptx in the browser — they
// need their native app or an online viewer the user is signed into.
function OfficeDocCard({ meta, file, dlUrl }) {
    const def = OFFICE_TYPES[meta.office];
    const Icon = def.Icon;
    return (
        <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
            <span
                className={cn(
                    'flex h-20 w-20 items-center justify-center rounded-2xl bg-card shadow-sm ring-1 ring-border',
                    def.accent,
                )}
            >
                <Icon className="h-10 w-10" />
            </span>
            <div className="space-y-1">
                <h3 className="text-base font-semibold">
                    {file.originalName}
                </h3>
                <p className="text-sm text-muted-foreground">
                    {formatBytes(file.size)} ·{' '}
                    {meta.office === 'spreadsheet'
                        ? 'Spreadsheet'
                        : meta.office === 'document'
                            ? 'Document'
                            : 'Presentation'}
                </p>
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
                Browsers can't preview {def.appHint.split(' / ')[0]}-style files
                directly. Download it to open in {def.appHint}.
            </p>
            <Button asChild className="gap-2">
                <a
                    href={dlUrl}
                    target="_blank"
                    rel="noreferrer"
                    download={file.originalName}
                >
                    <Download className="h-4 w-4" />
                    Download to view
                </a>
            </Button>
        </div>
    );
}
