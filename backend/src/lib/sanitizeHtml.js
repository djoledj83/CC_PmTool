// Server-side HTML sanitizer for stored rich text (ticket message bodies).
//
// Defense-in-depth: the React client already sanitizes on render, but a
// request sent straight to the API (bypassing the UI) could otherwise
// persist raw <script>/onerror/javascript: markup in the DB. We strip it on
// the way IN so the database only ever holds a safe, known allowlist — the
// same one the frontend editor produces (see frontend RichText.jsx).
//
// Allowlist mirrors the client:
//   tags   : basic formatting + lists + blockquote + headings + code/pre,
//            plus <a> (safe schemes only) and <span data-mention="…">.
//   attrs  : a[href,target,rel], span[data-mention].
//   schemes: http, https, mailto only (kills javascript:/data: URLs).
const sanitizeHtmlLib = require('sanitize-html');

const MENTION_ID = /^[a-z0-9_-]{1,48}$/i;

const OPTIONS = {
    allowedTags: [
        'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
        'p', 'div', 'br', 'span', 'ul', 'ol', 'li', 'blockquote', 'a',
        'h1', 'h2', 'h3', 'code', 'pre', 'img',
    ],
    allowedAttributes: {
        a: ['href', 'target', 'rel'],
        // `data-size` (sm|lg|xl) drives inline font-size; `data-mention`
        // marks an @-mention. Both are inert data attributes.
        span: ['data-mention', 'data-size'],
        // `data-align`/`data-size` are inert layout hints (validated tokens
        // on the client) that only drive CSS for the image — no script risk.
        img: ['src', 'alt', 'data-align', 'data-size'],
        // `style` is permitted on every tag but ruthlessly filtered by
        // `allowedStyles` below to ONLY text-align — that's the sole inline
        // style the align buttons emit. Everything else (position,
        // background, font, etc.) is dropped.
        '*': ['style'],
    },
    // Mirrors the client renderer: only these inert layout declarations
    // survive. `text-align` drives text/image alignment; `width`/`height`
    // (bounded px, %, or auto) carry an explicit image size with a locked
    // aspect ratio (one axis is a value, the other `auto`). Everything else
    // — position, background, font, url(), etc. — is stripped.
    allowedStyles: {
        '*': {
            'text-align': [/^(left|right|center|justify)$/],
            width: [/^\d{1,5}px$/, /^\d{1,3}%$/, /^auto$/],
            height: [/^\d{1,5}px$/, /^auto$/],
        },
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    // Images may only load over http(s) — no data:/mailto: on <img>.
    allowedSchemesByTag: { img: ['http', 'https'] },
    // Drop the contents of anything not allowed (e.g. <script>…</script>)
    // rather than leaving the inner text dangling.
    nonTextTags: ['style', 'script', 'textarea', 'noscript'],
    transformTags: {
        // Force external-safe link rels; the frontend does the same.
        a: sanitizeHtmlLib.simpleTransform('a', {
            target: '_blank',
            rel: 'noopener noreferrer',
        }),
    },
    exclusiveFilter(frame) {
        // Strip a <span> whose data-mention isn't a valid id (keep its text).
        if (
            frame.tag === 'span' &&
            frame.attribs['data-mention'] !== undefined &&
            !MENTION_ID.test(frame.attribs['data-mention'])
        ) {
            return true; // remove the tag (text is preserved by default)
        }
        return false;
    },
};

// Returns a sanitized HTML string. Non-string / empty input → ''.
function sanitizeRichText(html) {
    if (typeof html !== 'string' || html === '') return '';
    return sanitizeHtmlLib(html, OPTIONS);
}

// True when the string carries markup (vs a legacy plain-text value).
function looksLikeHtml(s) {
    return typeof s === 'string' && /<\/?[a-z][^>]*>/i.test(s);
}

// Readable plain text from stored rich text — for list previews, exports
// and notification snippets. Plain text passes through unchanged.
function htmlToPlainText(html) {
    if (!html) return '';
    const s = String(html);
    if (!looksLikeHtml(s)) return s.trim();
    return s
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<\/(p|div|li|h1|h2|h3|blockquote|pre)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Normalises a submitted ticket description:
//   - rich text (HTML) is sanitized; legacy plain text is kept as-is
//     (the client renders it escaped, so it's inert either way)
//   - an editor that's only empty paragraphs / <br> becomes null
function cleanDescription(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    if (!looksLikeHtml(raw)) return raw;
    const clean = sanitizeRichText(raw);
    const hasContent =
        htmlToPlainText(clean).trim().length > 0 || /<img\b/i.test(clean);
    return hasContent ? clean : null;
}

module.exports = {
    sanitizeRichText,
    looksLikeHtml,
    htmlToPlainText,
    cleanDescription,
};
