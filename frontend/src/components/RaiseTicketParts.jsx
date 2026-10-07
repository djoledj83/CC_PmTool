// Building blocks of the "Raise new ticket" form — shared by the portal's
// Raise request dialog and the agent workspace's New ticket dialog:
//   RaiseShell        dialog frame: icon header, form + help column, footer
//   FormLabel         field caption with a red * / "(optional)"
//   IconInput         input with a leading icon (the title field)
//   DescriptionField  rich-text description with a Preview toggle
//   FileDropzone      drag & drop / click-to-browse attachments
//   RaiseHelpCards    the ticket type's help panel: Tips, Related
//                     resources, Need urgent help?
import { forwardRef, useState } from 'react';
import { toast } from 'sonner';
import {
    BookOpen,
    CheckCircle2,
    ExternalLink,
    Eye,
    FilePlus2,
    FileText,
    Info,
    LifeBuoy,
    Mail,
    Paperclip,
    Pencil,
    Phone,
    X,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RichText, RichTextEditor } from '@/components/RichText';
import {
    PendingFilePicker,
    imagesFromClipboard,
    isAllowedFile,
} from '@/components/TicketAttachments';

// Mirrors the server (lib/ticketHelp.js): a phone number, e-mail or
// http(s) link → the href the on-call button uses (null if unusable).
export function contactHref(contact) {
    const c = String(contact || '').trim();
    if (!c) return null;
    if (/^https?:\/\/\S+$/i.test(c)) return c;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return `mailto:${c}`;
    if (/^\+?[\d\s/().-]{3,30}$/.test(c) && (c.match(/\d/g) || []).length >= 3) {
        return `tel:${c.replace(/[^\d+]/g, '')}`;
    }
    return null;
}

// ---------------------------------------------------------------------
export function RaiseShell({
    open,
    onOpenChange,
    title,
    subtitle,
    badge,
    children,
    aside,
    footer,
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[94vh] flex-col gap-0 overflow-hidden p-0">
                <div className="flex shrink-0 items-start gap-4 border-b px-4 pb-4 pt-5 pr-12 sm:px-6 sm:pr-14">
                    <span className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary sm:flex">
                        <FilePlus2 className="h-6 w-6" />
                    </span>
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <DialogTitle className="text-xl font-bold leading-tight">
                                {title}
                            </DialogTitle>
                            {badge}
                        </div>
                        <DialogDescription className="mt-1 max-w-3xl text-sm">
                            {subtitle}
                        </DialogDescription>
                    </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <div className="grid gap-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_23rem]">
                        <div className="min-w-0 space-y-5">{children}</div>
                        {aside && (
                            <aside className="space-y-4 lg:sticky lg:top-0 lg:self-start">
                                {aside}
                            </aside>
                        )}
                    </div>
                </div>
                <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-background px-4 py-3 sm:px-6">
                    {footer}
                </div>
            </DialogContent>
        </Dialog>
    );
}

export function FormLabel({ children, required, optional, htmlFor, className }) {
    return (
        <Label htmlFor={htmlFor} className={cn('text-sm font-medium', className)}>
            {children}
            {required && <span className="text-rose-500"> *</span>}
            {optional && (
                <span className="font-normal text-muted-foreground"> (optional)</span>
            )}
        </Label>
    );
}

export function IconInput({ icon: Icon, className, ...props }) {
    return (
        <div className="relative">
            <Icon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className={cn('h-11 pl-10 text-sm', className)} {...props} />
        </div>
    );
}

// Rich-text description: the compact toolbar (Normal text ▾, B / I / U,
// lists, link, code, emoji, attach) plus a Preview toggle on the right.
// The paperclip and pasted screenshots go to the form's attachments.
export const DescriptionField = forwardRef(function DescriptionField(
    {
        onChange,
        onAttachClick,
        onPasteFiles,
        placeholder,
        invalid = false,
        initialHtml = '',
        disabled = false,
    },
    ref,
) {
    const [preview, setPreview] = useState(false);
    const [html, setHtml] = useState(initialHtml);
    const [empty, setEmpty] = useState(!initialHtml);
    return (
        <RichTextEditor
            ref={ref}
            compact
            enableLink
            enableEmoji
            disabled={disabled}
            initialHtml={initialHtml}
            onAttachClick={onAttachClick}
            onChange={({ html: h, isEmpty }) => {
                setHtml(h);
                setEmpty(isEmpty);
                onChange?.({ html: h, isEmpty });
            }}
            onPaste={(e) => {
                const imgs = imagesFromClipboard(e);
                if (!imgs.length || !onPasteFiles) return;
                e.preventDefault();
                onPasteFiles(imgs);
                toast.success(
                    imgs.length === 1
                        ? 'Image added to the attachments.'
                        : `${imgs.length} images added to the attachments.`,
                );
            }}
            placeholder={placeholder}
            className={cn(invalid && 'border-rose-400 ring-1 ring-rose-400/40')}
            editorClassName="min-h-[160px] max-h-[50vh] resize-y"
            toolbarExtra={
                <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setPreview((p) => !p)}
                    aria-pressed={preview}
                    className={cn(
                        'flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors',
                        preview
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                >
                    {preview ? (
                        <>
                            <Pencil className="h-3.5 w-3.5" /> Edit
                        </>
                    ) : (
                        <>
                            <Eye className="h-3.5 w-3.5" /> Preview
                        </>
                    )}
                </button>
            }
            overlay={
                preview ? (
                    empty ? (
                        <p className="text-sm text-muted-foreground">
                            Nothing to preview yet.
                        </p>
                    ) : (
                        <RichText source={html} />
                    )
                ) : null
            }
        />
    );
});

// Attachments: drag & drop or click to browse; picked files listed below
// (with thumbnails for images). `inputRef` lets the description's
// paperclip open the same picker.
export function FileDropzone({
    files,
    onFiles,
    disabled = false,
    inputRef,
    hint = 'Images, PDFs, documents and logs — up to 50 MB each',
}) {
    const [over, setOver] = useState(false);
    const addFiles = (list) => {
        const ok = [];
        for (const f of Array.from(list || [])) {
            if (isAllowedFile(f)) ok.push(f);
            else toast.error(`"${f.name}" — that file type is not allowed.`);
        }
        if (ok.length) onFiles([...(files || []), ...ok]);
    };
    return (
        <div className="space-y-2">
            <button
                type="button"
                disabled={disabled}
                onClick={() => inputRef?.current?.click()}
                onDragEnter={(e) => {
                    e.preventDefault();
                    setOver(true);
                }}
                onDragOver={(e) => {
                    e.preventDefault();
                    setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                    e.preventDefault();
                    setOver(false);
                    if (!disabled) addFiles(e.dataTransfer?.files);
                }}
                data-dropzone=""
                className={cn(
                    'flex min-h-10 w-full items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-left transition-colors',
                    over
                        ? 'border-primary bg-primary/5'
                        : 'hover:border-primary/40 hover:bg-accent/40',
                    disabled && 'cursor-not-allowed opacity-60',
                )}
            >
                <Paperclip className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                    <span className="block text-sm">
                        Drag & drop files, or{' '}
                        <span className="font-medium text-primary">browse</span>
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                        {hint}
                    </span>
                </span>
            </button>
            <PendingFilePicker
                files={files}
                onFiles={onFiles}
                disabled={disabled}
                inputRef={inputRef}
                showButton={false}
            />
        </div>
    );
}

// A picked person / group with an × to drop it again.
export function RemovableChip({ icon: Icon, label, onRemove }) {
    return (
        <span className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2 pr-1 text-xs">
            {Icon && <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />}
            <span className="truncate">{label}</span>
            <button
                type="button"
                onClick={onRemove}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-rose-600"
                aria-label={`Remove ${label}`}
            >
                <X className="h-3 w-3" />
            </button>
        </span>
    );
}

// ---------------------------------------------------------------------
// The help panel — set per ticket type (Templates → Ticket types → Edit →
// Help panel) and sent with the type as `requestType.help`:
//   { tips: null | string[], resourcesIntro, resources: [{title, url}],
//     oncall: { text, label, contact, href } }
// tips null = these built-in tips; [] = no Tips card. Limits mirror the
// server (backend/src/lib/ticketHelp.js).
// ---------------------------------------------------------------------
export const DEFAULT_TIPS = [
    'Use a clear and concise title',
    'Describe what happened and the steps to reproduce it',
    'Include the terminal, client and any relevant context',
    'Attach screenshots, logs or related files',
    'Set the appropriate priority',
];
export const MAX_TIPS = 10;
export const MAX_TIP_LENGTH = 200;
export const MAX_LINKS = 10;
export const HTTP_URL = /^https?:\/\/\S+$/i;

export function cleanTips(list) {
    return (Array.isArray(list) ? list : [])
        .map((t) => String(t ?? '').trim())
        .filter(Boolean);
}

// The tips a help panel shows (built-in ones when the type has none set).
export function helpTips(help) {
    return Array.isArray(help?.tips) ? cleanTips(help.tips) : DEFAULT_TIPS;
}

function ContactIcon({ href, className }) {
    if (href?.startsWith('tel:')) return <Phone className={className} />;
    if (href?.startsWith('mailto:')) return <Mail className={className} />;
    return <ExternalLink className={className} />;
}

// Right-hand help column for a ticket type's `help` (null → built-in tips
// only, e.g. the agents' New ticket dialog, which has no type). "Related
// resources" and "Need urgent help?" only appear once they're filled in;
// Tips hide when the type's list is empty.
export function RaiseHelpCards({ help, showOncall = true }) {
    const resources = help?.resources || [];
    const oncall = help?.oncall;
    const tipList = helpTips(help);
    return (
        <>
            {tipList.length > 0 && (
                <section
                    className="rounded-xl border bg-primary/[0.04] p-4"
                    data-help="tips"
                >
                    <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                        <Info className="h-4 w-4 text-primary" />
                        Tips for a good ticket
                    </h3>
                    <ul className="space-y-2.5">
                        {tipList.map((t, i) => (
                            <li
                                key={`${i}-${t}`}
                                className="flex items-start gap-2 text-sm"
                            >
                                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                <span className="min-w-0 break-words">{t}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            {resources.length > 0 && (
                <section className="rounded-xl border bg-card p-4" data-help="resources">
                    <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                        <BookOpen className="h-4 w-4 text-primary" />
                        Related resources
                    </h3>
                    {help.resourcesIntro && (
                        <p className="mb-3 text-sm text-muted-foreground">
                            {help.resourcesIntro}
                        </p>
                    )}
                    <div className="space-y-2">
                        {resources.map((r) => (
                            <a
                                key={`${r.title}-${r.url}`}
                                href={r.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2.5 text-sm font-medium transition-colors hover:border-primary/40 hover:bg-accent/40"
                            >
                                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate">
                                    {r.title}
                                </span>
                                <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
                            </a>
                        ))}
                    </div>
                </section>
            )}
            {showOncall && oncall?.href && (
                <section className="rounded-xl border bg-card p-4" data-help="oncall">
                    <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                        <LifeBuoy className="h-4 w-4 text-primary" />
                        Need urgent help?
                    </h3>
                    {oncall.text && (
                        <p className="mb-3 text-sm text-muted-foreground">
                            {oncall.text}
                        </p>
                    )}
                    <a
                        href={oncall.href}
                        target={oncall.href.startsWith('http') ? '_blank' : undefined}
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5 transition-colors hover:border-primary/40 hover:bg-accent/40"
                    >
                        <ContactIcon
                            href={oncall.href}
                            className="h-4 w-4 shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                                {oncall.label || 'Contact on-call team'}
                            </span>
                            {oncall.contact && (
                                <span className="block truncate text-[11px] text-muted-foreground">
                                    {oncall.contact}
                                </span>
                            )}
                        </span>
                    </a>
                </section>
            )}
        </>
    );
}
