// Lightweight rich-text for ticket messages — no external deps.
//
//  - <RichTextEditor> : a contentEditable box with a formatting toolbar
//    (headings, bold / italic / underline / strikethrough, bullet &
//    numbered lists, inline code, clear formatting, and @-mentions of
//    people in the conversation). Uncontrolled; the parent reads the HTML
//    through onChange and clears it via the forwarded ref.
//  - <RichText>       : renders stored message HTML safely. The HTML is
//    run through `sanitizeHtml` (a strict allowlist built on the browser
//    DOM parser) before it ever touches dangerouslySetInnerHTML, so a
//    crafted message can't inject scripts / event handlers / styles.
//
// Messages are stored as HTML. Legacy plain-text messages (no tags) still
// render correctly — they're shown as escaped, newline-preserving text.
import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import {
    Bold,
    Italic,
    Underline,
    Strikethrough,
    List,
    ListOrdered,
    Heading1,
    Heading2,
    Code,
    Eraser,
    AtSign,
    Hash,
    Quote,
    Link as LinkIcon,
    Image as ImageIcon,
    ImagePlus,
    AlignLeft,
    AlignCenter,
    AlignRight,
    Link2,
} from 'lucide-react';

import { cn, resolveAssetUrl } from '@/lib/utils';

// Tags we keep when rendering a message. Everything else is unwrapped
// (its text is preserved, the tag dropped). Attributes are stripped
// except a validated href on links and data-mention on a mention span.
const ALLOWED_TAGS = new Set([
    'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
    'P', 'DIV', 'BR', 'SPAN', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A',
    'H1', 'H2', 'H3', 'CODE', 'PRE', 'IMG',
]);

const SAFE_HREF = /^(https?:|mailto:)/i;
// Absolute http(s) images OR same-origin uploads served by our own API
// (announcement images come back as a relative "/uploads/…" path). A
// path-relative URL can't carry a javascript:/data: payload, so allowing
// our own upload prefix is safe.
const SAFE_IMG_SRC = /^(https?:\/\/|\/uploads\/)/i;
const MENTION_ID = /^[a-z0-9_-]{1,48}$/i;
// Font-size tokens applied via <span data-size="…">.
const SIZE_TOKEN = /^(sm|lg|xl)$/;
// Image layout tokens (inert data-* attributes → CSS in RICH_STRUCTURE).
// Alignment mirrors the text align controls; size presets cap the width
// while height stays auto so the aspect ratio is always preserved.
const IMG_ALIGN_TOKEN = /^(left|center|right)$/;
const IMG_SIZE_TOKEN = /^(sm|md|lg|full)$/;

// Shared classes so mentions / code / headings look the same in the
// editor and in the rendered message. Structural rules are colour-agnostic;
// code + mention chips have a second "onPrimary" palette for when the text
// sits on a coloured (primary) message bubble — otherwise a blue mention on
// a blue sent-bubble is invisible.
const RICH_STRUCTURE =
    '[&_h1]:mb-1 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-medium ' +
    '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 ' +
    '[&_blockquote]:border-l-2 [&_blockquote]:border-current/30 [&_blockquote]:pl-2 [&_blockquote]:opacity-90 [&_a]:underline ' +
    // Inline images (announcements): scale a large image down to fit the
    // modal while keeping its aspect ratio (max width + max height, auto
    // dimensions → proportional). Rounded, small vertical gap.
    '[&_img]:my-1 [&_img]:h-auto [&_img]:max-h-[40vh] [&_img]:max-w-full [&_img]:rounded-md [&_img]:object-contain ' +
    // Image alignment — become a block and use auto margins so the image
    // sits left / centered / right, exactly like text alignment.
    '[&_img[data-align=left]]:block [&_img[data-align=left]]:mr-auto ' +
    '[&_img[data-align=center]]:block [&_img[data-align=center]]:mx-auto ' +
    '[&_img[data-align=right]]:block [&_img[data-align=right]]:ml-auto ' +
    // Image size presets — cap the width; height stays auto (set above) so
    // the aspect ratio is preserved at every size.
    '[&_img[data-size=sm]]:max-w-[25%] [&_img[data-size=md]]:max-w-[50%] ' +
    '[&_img[data-size=lg]]:max-w-[75%] [&_img[data-size=full]]:max-w-full ' +
    // Font-size tokens set via <span data-size="…">.
    '[&_[data-size=sm]]:text-xs [&_[data-size=lg]]:text-lg [&_[data-size=xl]]:text-2xl';

const RICH_CODE_DEFAULT =
    '[&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] dark:[&_code]:bg-white/15';
const RICH_MENTION_DEFAULT =
    '[&_[data-mention]]:rounded [&_[data-mention]]:bg-primary/15 [&_[data-mention]]:px-1 [&_[data-mention]]:font-medium [&_[data-mention]]:text-primary';

// On a primary-coloured bubble: tint chips with the bubble's FOREGROUND
// colour (so a white-on-blue message shows a light chip with white text)
// and underline the mention so it still reads as a distinct token.
const RICH_CODE_ON_PRIMARY =
    '[&_code]:rounded [&_code]:bg-primary-foreground/20 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]';
const RICH_MENTION_ON_PRIMARY =
    '[&_[data-mention]]:rounded [&_[data-mention]]:bg-primary-foreground/25 [&_[data-mention]]:px-1 [&_[data-mention]]:font-semibold [&_[data-mention]]:text-primary-foreground [&_[data-mention]]:underline';

function richClasses(variant) {
    const onPrimary = variant === 'onPrimary';
    return cn(
        RICH_STRUCTURE,
        onPrimary ? RICH_CODE_ON_PRIMARY : RICH_CODE_DEFAULT,
        onPrimary ? RICH_MENTION_ON_PRIMARY : RICH_MENTION_DEFAULT,
    );
}

// Back-compat alias for the editor (always the default palette).
const RICH_CLASSES = richClasses();

export function sanitizeHtml(html) {
    if (typeof html !== 'string' || html === '') return '';
    if (typeof window === 'undefined' || !window.DOMParser) return '';
    const doc = new DOMParser().parseFromString(
        `<body>${html}</body>`,
        'text/html',
    );

    const rebuild = (node, out) => {
        node.childNodes.forEach((child) => {
            if (child.nodeType === 3 /* text */) {
                out.appendChild(document.createTextNode(child.textContent));
                return;
            }
            if (child.nodeType !== 1 /* element */) return;
            const tag = child.tagName;
            if (ALLOWED_TAGS.has(tag)) {
                const el = document.createElement(tag);
                if (tag === 'A') {
                    const href = (child.getAttribute('href') || '').trim();
                    if (SAFE_HREF.test(href)) {
                        el.setAttribute('href', href);
                        el.setAttribute('target', '_blank');
                        el.setAttribute('rel', 'noopener noreferrer');
                    }
                } else if (tag === 'IMG') {
                    // Only http(s) or our own /uploads image sources; keep
                    // alt text. No other attributes (blocks onerror, style,
                    // srcset, etc.). A stored "/uploads/…" path is relative
                    // to the API origin, not the page origin, so resolve it
                    // the same way avatars are (resolveAssetUrl leaves an
                    // already-absolute URL untouched).
                    const src = (child.getAttribute('src') || '').trim();
                    if (SAFE_IMG_SRC.test(src)) {
                        el.setAttribute('src', resolveAssetUrl(src) || src);
                    }
                    const alt = child.getAttribute('alt');
                    if (alt) el.setAttribute('alt', alt);
                    // Inert layout hints (alignment + size preset). Both are
                    // validated tokens and only drive CSS — no script risk.
                    const iAlign = child.getAttribute('data-align');
                    if (iAlign && IMG_ALIGN_TOKEN.test(iAlign)) {
                        el.setAttribute('data-align', iAlign);
                    }
                    const iSize = child.getAttribute('data-size');
                    if (iSize && IMG_SIZE_TOKEN.test(iSize)) {
                        el.setAttribute('data-size', iSize);
                    }
                } else if (tag === 'SPAN') {
                    // Preserve a validated mention marker and/or size token.
                    const m = child.getAttribute('data-mention');
                    if (m && MENTION_ID.test(m)) {
                        el.setAttribute('data-mention', m);
                    }
                    const size = child.getAttribute('data-size');
                    if (size && SIZE_TOKEN.test(size)) {
                        el.setAttribute('data-size', size);
                    }
                }
                // Preserve validated inline layout styles — the only ones we
                // allow. `text-align` (from the align buttons) on any element,
                // plus a bounded `width`/`height` (px, %, or auto) that carry
                // an explicit image size with a locked aspect ratio.
                const align = child.style && child.style.textAlign;
                if (align && /^(left|right|center|justify)$/.test(align)) {
                    el.style.textAlign = align;
                }
                const w = child.style && child.style.width;
                if (w && /^(\d{1,5}px|\d{1,3}%|auto)$/.test(w)) {
                    el.style.width = w;
                }
                const h = child.style && child.style.height;
                if (h && /^(\d{1,5}px|auto)$/.test(h)) {
                    el.style.height = h;
                }
                rebuild(child, el);
                out.appendChild(el);
            } else {
                // Unknown / unsafe tag: drop the wrapper, keep its content.
                rebuild(child, out);
            }
        });
    };

    const container = document.createElement('div');
    rebuild(doc.body, container);
    return container.innerHTML;
}

// Extract mentioned user ids from a stored body. Used client-side only as
// a helper; the backend re-parses independently before notifying.
export function mentionIdsFromHtml(html) {
    if (!html) return [];
    return Array.from(
        new Set(
            [...String(html).matchAll(/data-mention="([^"]+)"/g)].map(
                (m) => m[1],
            ),
        ),
    ).filter((id) => MENTION_ID.test(id));
}

function looksLikeHtml(s) {
    // A tag, OR a named/numeric HTML entity (e.g. &nbsp; &amp; &#39;).
    // Entity-only content (no tags) still needs the HTML path so the
    // entity is decoded instead of shown literally as "&nbsp;".
    return /<[a-z][\s\S]*>/i.test(s) || /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s);
}

// Read-only renderer for a stored message body. Pass variant="onPrimary"
// when the text sits on a coloured (primary) bubble so mentions / code
// stay legible instead of blending into the background.
export function RichText({ source, className, variant }) {
    if (!source) return null;
    if (!looksLikeHtml(source)) {
        // Legacy / plain text — render as-is, newlines preserved, escaped
        // automatically because it goes through React (not innerHTML).
        return (
            <p className={cn('whitespace-pre-wrap break-words', className)}>
                {source}
            </p>
        );
    }
    return (
        <div
            className={cn('break-words', richClasses(variant), className)}
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(source) }}
        />
    );
}

function escapeText(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// For a value placed inside a double-quoted attribute.
function escapeAttr(s) {
    return escapeText(s).replace(/"/g, '&quot;');
}

const TOOLS = [
    { kind: 'block', arg: '<h1>', Icon: Heading1, label: 'Heading' },
    { kind: 'block', arg: '<h2>', Icon: Heading2, label: 'Subheading' },
    { kind: 'sep' },
    { kind: 'cmd', cmd: 'bold', Icon: Bold, label: 'Bold' },
    { kind: 'cmd', cmd: 'italic', Icon: Italic, label: 'Italic' },
    { kind: 'cmd', cmd: 'underline', Icon: Underline, label: 'Underline' },
    {
        kind: 'cmd',
        cmd: 'strikeThrough',
        Icon: Strikethrough,
        label: 'Strikethrough',
    },
    { kind: 'sep' },
    {
        kind: 'cmd',
        cmd: 'insertUnorderedList',
        Icon: List,
        label: 'Bullet list',
    },
    {
        kind: 'cmd',
        cmd: 'insertOrderedList',
        Icon: ListOrdered,
        label: 'Numbered list',
    },
    { kind: 'code', Icon: Code, label: 'Inline code' },
    { kind: 'sep' },
    { kind: 'clear', Icon: Eraser, label: 'Clear formatting' },
];

export const RichTextEditor = forwardRef(function RichTextEditor(
    {
        onChange,
        onSubmit,
        onPaste,
        placeholder = '',
        className,
        disabled = false,
        mentions = [],
        references = [],
        // Preload existing HTML (edit / duplicate). Applied once on mount —
        // remount via a changing `key` to load a different value.
        initialHtml = '',
        // Opt-in extra tools (used by announcements, off for ticket chat).
        enableQuote = false,
        enableLink = false,
        enableImage = false,
        enableSize = false,
        enableAlign = false,
        // async (file) => url. When provided, an "upload image" button
        // appears alongside the "image from URL" one.
        onImageUpload = null,
    },
    ref,
) {
    const elRef = useRef(null);
    const fileInputRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    // Upload progress (0–100) while an image is being sent; null when idle.
    const [uploadPct, setUploadPct] = useState(null);
    // The image the user last clicked inside the editor — the floating
    // image toolbar (align + size) acts on it. `imgBar` holds its on-screen
    // rect so we can position the toolbar / selection ring over it;
    // `imgDim` mirrors the current pixel W×H shown in the size inputs.
    const activeImgRef = useRef(null);
    const imgBarRef = useRef(null);
    const [imgBar, setImgBar] = useState(null);
    const [imgDim, setImgDim] = useState({ w: '', h: '' });

    // Seed the editor with existing content on mount.
    useEffect(() => {
        if (elRef.current && initialHtml) {
            elRef.current.innerHTML = initialHtml;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const [mentionOpen, setMentionOpen] = useState(false);
    const [refOpen, setRefOpen] = useState(false);
    const [refQuery, setRefQuery] = useState('');
    // Inline "#" autocomplete: pops up at the caret as you type `#…`.
    const [inlineRef, setInlineRef] = useState(null); // { query, left, top }
    // The reference dropdown has a search box that steals focus from the
    // editor, so we stash the caret position and restore it on insert.
    const savedRangeRef = useRef(null);

    const emit = useCallback(() => {
        const el = elRef.current;
        if (!el) return;
        onChange?.({
            html: el.innerHTML,
            isEmpty: (el.textContent || '').trim().length === 0,
        });
    }, [onChange]);

    useImperativeHandle(
        ref,
        () => ({
            clear() {
                if (elRef.current) {
                    elRef.current.innerHTML = '';
                    emit();
                }
            },
            focus() {
                elRef.current?.focus();
            },
        }),
        [emit],
    );

    const insertHtml = (html) => {
        elRef.current?.focus();
        document.execCommand('insertHTML', false, html);
        emit();
    };

    const apply = (tool) => {
        if (disabled) return;
        elRef.current?.focus();
        if (tool.kind === 'cmd') {
            document.execCommand(tool.cmd, false, null);
        } else if (tool.kind === 'block') {
            document.execCommand('formatBlock', false, tool.arg);
        } else if (tool.kind === 'clear') {
            document.execCommand('removeFormat', false, null);
            document.execCommand('formatBlock', false, '<p>');
        } else if (tool.kind === 'code') {
            const text = window.getSelection?.()?.toString() || '';
            insertHtml(
                text ? `<code>${escapeText(text)}</code>` : '<code>code</code>',
            );
            return;
        }
        emit();
    };

    const applyQuote = () => {
        if (disabled) return;
        elRef.current?.focus();
        document.execCommand('formatBlock', false, '<blockquote>');
        emit();
    };

    const insertLink = () => {
        if (disabled) return;
        const url = window.prompt('Link URL (https://…)');
        if (!url) return;
        const safe = url.trim();
        if (!/^(https?:|mailto:)/i.test(safe)) return;
        const text = window.getSelection?.()?.toString();
        insertHtml(
            `<a href="${escapeAttr(safe)}">${escapeText(text || safe)}</a>&nbsp;`,
        );
    };

    const insertImage = () => {
        if (disabled) return;
        const url = window.prompt('Image URL (https://…)');
        if (!url) return;
        const safe = url.trim();
        if (!/^https?:/i.test(safe)) return;
        insertHtml(`<img src="${escapeAttr(safe)}" alt="" />`);
    };

    const applySize = (token) => {
        if (disabled) return;
        const text = window.getSelection?.()?.toString();
        if (!text) return; // size wraps the current selection
        insertHtml(`<span data-size="${token}">${escapeText(text)}</span>`);
    };

    // Natural aspect ratio (w/h); falls back to the rendered box.
    const imgRatio = (img) => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            return img.naturalWidth / img.naturalHeight;
        }
        const r = img.getBoundingClientRect();
        return r.height > 0 ? r.width / r.height : 1;
    };

    const renderedDim = (img) => {
        const r = img.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
    };

    // Track / position the floating toolbar over the clicked image.
    const positionImgBar = (img) => {
        if (!img || !elRef.current?.contains(img)) {
            setImgBar(null);
            return;
        }
        const r = img.getBoundingClientRect();
        setImgBar({ left: r.left, top: r.top, width: r.width, height: r.height });
    };

    const selectImage = (img) => {
        activeImgRef.current = img || null;
        if (img) setImgDim(renderedDim(img));
        positionImgBar(img);
    };

    const clearImage = () => {
        activeImgRef.current = null;
        setImgBar(null);
    };

    // Apply a preset align/size hint. A % size preset clears any explicit
    // pixel size so the two sizing mechanisms don't fight.
    const setImgLayout = (attr, value) => {
        const img = activeImgRef.current;
        if (!img) return;
        img.setAttribute(attr, value);
        if (attr === 'data-size') {
            img.style.width = '';
            img.style.height = '';
        }
        emit();
        // Wait a frame so the size change is reflected before re-measuring.
        requestAnimationFrame(() => {
            positionImgBar(img);
            setImgDim(renderedDim(img));
        });
    };

    // Set an explicit pixel width or height on the active image with the
    // aspect ratio locked: the edited axis gets the px value, the other is
    // computed and left `auto` so the browser scales it proportionally.
    // Clears any % size preset.
    const setImgPx = (axis, raw) => {
        const img = activeImgRef.current;
        if (!img) return;
        if (raw === '') {
            setImgDim((d) => ({ ...d, [axis]: '' }));
            return;
        }
        const n = Math.max(1, Math.min(5000, Math.round(Number(raw) || 0)));
        if (!Number.isFinite(n) || n <= 0) return;
        const ratio = imgRatio(img) || 1;
        img.removeAttribute('data-size');
        if (axis === 'w') {
            img.style.width = `${n}px`;
            img.style.height = 'auto';
            setImgDim({ w: n, h: Math.round(n / ratio) });
        } else {
            img.style.height = `${n}px`;
            img.style.width = 'auto';
            setImgDim({ w: Math.round(n * ratio), h: n });
        }
        emit();
        requestAnimationFrame(() => positionImgBar(img));
    };

    const applyAlign = (cmd) => {
        if (disabled) return;
        const map = {
            justifyLeft: 'left',
            justifyCenter: 'center',
            justifyRight: 'right',
        };
        // If an image is selected, align the image itself (same buttons work
        // for both text and images, as requested).
        if (activeImgRef.current) {
            setImgLayout('data-align', map[cmd] || 'left');
            return;
        }
        elRef.current?.focus();
        // Emit inline `style="text-align:…"` instead of a legacy `align`
        // attribute or <center> wrapper — the latter are stripped by both
        // sanitizers, so alignment wouldn't survive a save. Restore the
        // flag afterwards so bold/italic keep producing <b>/<i> tags (which
        // CSS-mode would otherwise turn into <span style> and lose too).
        try {
            document.execCommand('styleWithCSS', false, true);
            document.execCommand(cmd, false, null);
        } finally {
            document.execCommand('styleWithCSS', false, false);
        }
        emit();
    };

    const onFilePicked = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-picking the same file
        if (!file || !onImageUpload) return;
        setUploading(true);
        setUploadPct(0);
        try {
            const url = await onImageUpload(file, (pct) => setUploadPct(pct));
            // Insert the API-resolved URL so the image renders in the
            // editor immediately (a bare "/uploads/…" path would resolve
            // against the frontend origin and 404).
            const shown = resolveAssetUrl(url) || url;
            if (shown) insertHtml(`<img src="${escapeAttr(shown)}" alt="" />`);
        } catch {
            /* parent surfaces the error toast */
        } finally {
            setUploading(false);
            setUploadPct(null);
        }
    };

    const pickMention = (m) => {
        insertHtml(
            `<span data-mention="${escapeText(m.id)}">@${escapeText(
                m.name || 'user',
            )}</span>&nbsp;`,
        );
        setMentionOpen(false);
    };

    const saveRange = () => {
        const sel = window.getSelection?.();
        if (
            sel &&
            sel.rangeCount &&
            elRef.current?.contains(sel.anchorNode)
        ) {
            savedRangeRef.current = sel.getRangeAt(0).cloneRange();
        } else {
            savedRangeRef.current = null;
        }
    };

    const pickReference = (r) => {
        const el = elRef.current;
        if (el) {
            el.focus();
            const sel = window.getSelection();
            if (savedRangeRef.current) {
                sel.removeAllRanges();
                sel.addRange(savedRangeRef.current);
            }
            document.execCommand(
                'insertHTML',
                false,
                `<a href="${escapeText(r.href)}">${escapeText(
                    r.label,
                )}</a>&nbsp;`,
            );
            emit();
        }
        setRefOpen(false);
        setRefQuery('');
    };

    const filteredRefs = refQuery.trim()
        ? references.filter((r) =>
              (r.label || '')
                  .toLowerCase()
                  .includes(refQuery.trim().toLowerCase()),
          )
        : references;

    // Detect a `#query` being typed just before the caret and show the
    // inline picker anchored at the caret.
    const detectInline = () => {
        if (!references.length) return;
        const sel = window.getSelection?.();
        if (!sel || !sel.isCollapsed || !sel.rangeCount) {
            setInlineRef(null);
            return;
        }
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        if (
            !elRef.current ||
            !elRef.current.contains(node) ||
            node.nodeType !== 3
        ) {
            setInlineRef(null);
            return;
        }
        const before = node.textContent.slice(0, range.startOffset);
        const m = before.match(/(?:^|\s)#([^\s#]*)$/);
        if (!m) {
            setInlineRef(null);
            return;
        }
        const caret = range.cloneRange();
        caret.collapse(true);
        const rects = caret.getClientRects();
        const rect = rects[0] || caret.getBoundingClientRect();
        // Open above the caret when there isn't room below (the reply box
        // sits near the bottom of the modal), so the list stays on screen.
        const spaceBelow = window.innerHeight - rect.bottom;
        const next = { query: m[1], left: rect.left };
        if (spaceBelow < 260) {
            next.bottom = window.innerHeight - rect.top + 4;
        } else {
            next.top = rect.bottom + 4;
        }
        setInlineRef(next);
    };

    const inlineMatches = inlineRef
        ? references
              .filter((r) =>
                  (r.label || '')
                      .toLowerCase()
                      .includes(inlineRef.query.toLowerCase()),
              )
              .slice(0, 50)
        : [];

    const pickInline = (r) => {
        const sel = window.getSelection?.();
        if (sel && sel.rangeCount) {
            const range = sel.getRangeAt(0);
            const node = range.startContainer;
            if (node.nodeType === 3) {
                const caret = range.startOffset;
                const before = node.textContent.slice(0, caret);
                const m = before.match(/(?:^|\s)#([^\s#]*)$/);
                if (m) {
                    const del = document.createRange();
                    del.setStart(node, caret - m[1].length - 1);
                    del.setEnd(node, caret);
                    sel.removeAllRanges();
                    sel.addRange(del);
                }
            }
        }
        elRef.current?.focus();
        document.execCommand(
            'insertHTML',
            false,
            `<a href="${escapeText(r.href)}">${escapeText(r.label)}</a>&nbsp;`,
        );
        setInlineRef(null);
        emit();
    };

    return (
        <div
            className={cn(
                'flex flex-col rounded-md border bg-background',
                disabled && 'opacity-60',
                className,
            )}
        >
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={onFilePicked}
            />
            <div className="flex flex-wrap items-center gap-0.5 border-b px-1 py-1">
                {TOOLS.map((t, i) => {
                    if (t.kind === 'sep') {
                        return (
                            <span
                                key={`sep-${i}`}
                                className="mx-0.5 h-5 w-px bg-border"
                            />
                        );
                    }
                    const Icon = t.Icon;
                    return (
                        <button
                            key={t.label}
                            type="button"
                            title={t.label}
                            aria-label={t.label}
                            // Keep the editor's selection on mousedown so the
                            // command applies to what the user highlighted.
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => apply(t)}
                            className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                            <Icon className="h-3.5 w-3.5" />
                        </button>
                    );
                })}
                {(enableQuote || enableLink || enableImage || enableSize) && (
                    <span className="mx-0.5 h-5 w-px bg-border" />
                )}
                {enableQuote && (
                    <button
                        type="button"
                        title="Quote"
                        aria-label="Quote"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={applyQuote}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                        <Quote className="h-3.5 w-3.5" />
                    </button>
                )}
                {enableLink && (
                    <button
                        type="button"
                        title="Insert link"
                        aria-label="Insert link"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={insertLink}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                        <LinkIcon className="h-3.5 w-3.5" />
                    </button>
                )}
                {enableImage && onImageUpload && (
                    <button
                        type="button"
                        title="Upload image"
                        aria-label="Upload image"
                        disabled={uploading}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => fileInputRef.current?.click()}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                    >
                        <ImagePlus className="h-3.5 w-3.5" />
                    </button>
                )}
                {enableImage && (
                    <button
                        type="button"
                        title="Image from URL"
                        aria-label="Image from URL"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={insertImage}
                        className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                        <ImageIcon className="h-3.5 w-3.5" />
                    </button>
                )}
                {enableAlign && (
                    <>
                        <span className="mx-0.5 h-5 w-px bg-border" />
                        {[
                            { cmd: 'justifyLeft', Icon: AlignLeft, label: 'Align left' },
                            { cmd: 'justifyCenter', Icon: AlignCenter, label: 'Align center' },
                            { cmd: 'justifyRight', Icon: AlignRight, label: 'Align right' },
                        ].map(({ cmd, Icon, label }) => (
                            <button
                                key={cmd}
                                type="button"
                                title={label}
                                aria-label={label}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => applyAlign(cmd)}
                                className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                                <Icon className="h-3.5 w-3.5" />
                            </button>
                        ))}
                    </>
                )}
                {enableSize && (
                    <span className="flex items-center gap-0.5">
                        {[
                            { t: 'sm', label: 'Small text', cls: 'text-[10px]' },
                            { t: 'lg', label: 'Large text', cls: 'text-sm' },
                            { t: 'xl', label: 'X-large text', cls: 'text-base' },
                        ].map((s) => (
                            <button
                                key={s.t}
                                type="button"
                                title={`${s.label} (select text first)`}
                                aria-label={s.label}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => applySize(s.t)}
                                className={cn(
                                    'flex h-7 min-w-[1.75rem] items-center justify-center rounded px-1 font-semibold leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                                    s.cls,
                                )}
                            >
                                A
                            </button>
                        ))}
                    </span>
                )}
                {mentions.length > 0 && (
                    <span className="relative">
                        <button
                            type="button"
                            title="Mention someone"
                            aria-label="Mention someone"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setMentionOpen((o) => !o)}
                            className={cn(
                                'flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                                mentionOpen && 'bg-accent text-foreground',
                            )}
                        >
                            <AtSign className="h-3.5 w-3.5" />
                        </button>
                        {mentionOpen && (
                            <div className="absolute bottom-full left-0 z-50 mb-1 w-52 rounded-md border bg-popover p-1 shadow-md">
                                <div className="max-h-60 overflow-y-auto">
                                    {mentions.length === 0 ? (
                                        <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                            No people
                                        </p>
                                    ) : (
                                        mentions.map((m) => (
                                            <button
                                                key={m.id}
                                                type="button"
                                                onMouseDown={(e) =>
                                                    e.preventDefault()
                                                }
                                                onClick={() => pickMention(m)}
                                                className="flex w-full items-center gap-2 truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                                            >
                                                <AtSign className="h-3 w-3 shrink-0 text-muted-foreground" />
                                                <span className="truncate">
                                                    {m.name}
                                                </span>
                                            </button>
                                        ))
                                    )}
                                </div>
                            </div>
                        )}
                    </span>
                )}
                {references.length > 0 && (
                    <span className="relative">
                        <button
                            type="button"
                            title="Reference a ticket"
                            aria-label="Reference a ticket"
                            onMouseDown={(e) => {
                                e.preventDefault();
                                saveRange();
                            }}
                            onClick={() => setRefOpen((o) => !o)}
                            className={cn(
                                'flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                                refOpen && 'bg-accent text-foreground',
                            )}
                        >
                            <Hash className="h-3.5 w-3.5" />
                        </button>
                        {refOpen && (
                            <div className="absolute bottom-full left-0 z-50 mb-1 w-64 rounded-md border bg-popover p-1 shadow-md">
                                <input
                                    autoFocus
                                    value={refQuery}
                                    onChange={(e) => setRefQuery(e.target.value)}
                                    placeholder="Search tickets…"
                                    className="mb-1 h-7 w-full rounded border bg-background px-2 text-xs outline-none"
                                />
                                <div className="max-h-48 overflow-y-auto">
                                    {filteredRefs.length === 0 ? (
                                        <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                            No tickets
                                        </p>
                                    ) : (
                                        filteredRefs.slice(0, 50).map((r) => (
                                            <button
                                                key={r.id}
                                                type="button"
                                                onClick={() =>
                                                    pickReference(r)
                                                }
                                                className="flex w-full items-center gap-2 truncate rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                                            >
                                                <Hash className="h-3 w-3 shrink-0 text-muted-foreground" />
                                                <span className="truncate">
                                                    {r.label}
                                                </span>
                                            </button>
                                        ))
                                    )}
                                </div>
                            </div>
                        )}
                    </span>
                )}
            </div>
            {uploadPct != null && (
                <div
                    className="h-1 w-full overflow-hidden bg-muted"
                    role="progressbar"
                    aria-valuenow={uploadPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Uploading image"
                >
                    <div
                        className="h-full bg-primary transition-[width] duration-150 ease-out"
                        style={{ width: `${uploadPct}%` }}
                    />
                </div>
            )}
            <div
                ref={elRef}
                contentEditable={!disabled}
                role="textbox"
                aria-multiline="true"
                data-placeholder={placeholder}
                onInput={() => {
                    emit();
                    detectInline();
                    // Image was deleted while selected → drop the toolbar.
                    if (
                        activeImgRef.current &&
                        !elRef.current?.contains(activeImgRef.current)
                    ) {
                        clearImage();
                    }
                }}
                onKeyUp={detectInline}
                onClick={(e) => {
                    const t = e.target;
                    if (t && t.tagName === 'IMG') selectImage(t);
                    else clearImage();
                }}
                onScroll={() => {
                    if (activeImgRef.current) {
                        positionImgBar(activeImgRef.current);
                    }
                }}
                onBlur={() =>
                    setTimeout(() => {
                        setInlineRef(null);
                        // Keep the image toolbar open if focus moved into it
                        // (e.g. the user clicked a W/H size input).
                        if (
                            !imgBarRef.current?.contains(document.activeElement)
                        ) {
                            clearImage();
                        }
                    }, 200)
                }
                onPaste={onPaste}
                onKeyDown={(e) => {
                    if (inlineRef && inlineMatches.length) {
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            setInlineRef(null);
                            return;
                        }
                        if (
                            e.key === 'Enter' &&
                            !e.ctrlKey &&
                            !e.metaKey
                        ) {
                            e.preventDefault();
                            pickInline(inlineMatches[0]);
                            return;
                        }
                    }
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                        e.preventDefault();
                        onSubmit?.();
                    }
                }}
                className={cn(
                    'max-h-48 min-h-[60px] overflow-y-auto px-3 py-2 text-sm outline-none',
                    RICH_CLASSES,
                    'empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]',
                )}
            />
            {inlineRef && inlineMatches.length > 0 && (
                <div
                    style={{
                        position: 'fixed',
                        left: inlineRef.left,
                        ...(inlineRef.top != null
                            ? { top: inlineRef.top }
                            : { bottom: inlineRef.bottom }),
                        zIndex: 60,
                    }}
                    className="max-h-60 w-72 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
                >
                    {inlineMatches.map((r) => (
                        <button
                            key={r.id}
                            type="button"
                            // Keep the editor's caret so the replace works.
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pickInline(r)}
                            className="flex w-full items-center gap-2 truncate rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                        >
                            <Hash className="h-3 w-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{r.label}</span>
                        </button>
                    ))}
                </div>
            )}
            {imgBar && (
                <>
                    {/* Selection ring over the clicked image. */}
                    <div
                        style={{
                            position: 'fixed',
                            left: imgBar.left,
                            top: imgBar.top,
                            width: imgBar.width,
                            height: imgBar.height,
                            zIndex: 55,
                            pointerEvents: 'none',
                        }}
                        className="rounded-md ring-2 ring-primary/70"
                    />
                    {/* Floating align + size toolbar for the image. */}
                    <div
                        ref={imgBarRef}
                        style={{
                            position: 'fixed',
                            left: imgBar.left,
                            top: Math.max(4, imgBar.top - 42),
                            zIndex: 60,
                        }}
                        className="flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-md"
                    >
                        {[
                            { v: 'left', Icon: AlignLeft, label: 'Align left' },
                            {
                                v: 'center',
                                Icon: AlignCenter,
                                label: 'Align center',
                            },
                            {
                                v: 'right',
                                Icon: AlignRight,
                                label: 'Align right',
                            },
                        ].map(({ v, Icon, label }) => (
                            <button
                                key={v}
                                type="button"
                                title={label}
                                aria-label={label}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => setImgLayout('data-align', v)}
                                className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                                <Icon className="h-3.5 w-3.5" />
                            </button>
                        ))}
                        <span className="mx-0.5 h-5 w-px bg-border" />
                        {[
                            { v: 'sm', label: 'Small (25%)', t: 'S' },
                            { v: 'md', label: 'Medium (50%)', t: 'M' },
                            { v: 'lg', label: 'Large (75%)', t: 'L' },
                            { v: 'full', label: 'Full width', t: 'Full' },
                        ].map(({ v, label, t }) => (
                            <button
                                key={v}
                                type="button"
                                title={label}
                                aria-label={label}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => setImgLayout('data-size', v)}
                                className="flex h-7 min-w-[1.75rem] items-center justify-center rounded px-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                                {t}
                            </button>
                        ))}
                        <span className="mx-0.5 h-5 w-px bg-border" />
                        {/* Explicit pixel size with a locked aspect ratio:
                            typing one axis recomputes the other. */}
                        <span
                            className="flex items-center gap-1 pl-0.5"
                            title="Pixel size — aspect ratio locked"
                        >
                            <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                            <input
                                type="number"
                                min="1"
                                value={imgDim.w}
                                onChange={(e) => setImgPx('w', e.target.value)}
                                aria-label="Width in pixels"
                                className="h-6 w-12 rounded border bg-background px-1 text-xs outline-none"
                            />
                            <span className="text-xs text-muted-foreground">
                                ×
                            </span>
                            <input
                                type="number"
                                min="1"
                                value={imgDim.h}
                                onChange={(e) => setImgPx('h', e.target.value)}
                                aria-label="Height in pixels"
                                className="h-6 w-12 rounded border bg-background px-1 text-xs outline-none"
                            />
                            <span className="text-[10px] text-muted-foreground">
                                px
                            </span>
                        </span>
                    </div>
                </>
            )}
        </div>
    );
});

export default RichText;
