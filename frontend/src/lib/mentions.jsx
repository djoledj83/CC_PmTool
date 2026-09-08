// Renders a body of plain text and turns:
//   1. `@<participant name>` occurrences into styled mention chips, and
//   2. `T-####` / `ST-####` (with optional `PRJ-…/` prefix) task codes
//      into clickable links via `<TaskCodeLink/>`.
//
// The renderer runs the mention pass first (because real names can
// contain spaces and only a known-participant list resolves them
// safely) and only walks the leftover plain-text segments for code
// tokens — so a name like `T-Rex Patel` would never accidentally
// linkify, but `T-0042` in the same line still does.

import { Fragment } from 'react';
import { Link } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { TaskCodeLink } from '@/components/TaskCodeLink';

const MENTION_CLASS =
    'rounded bg-primary/10 px-1 text-primary font-medium dark:bg-primary/20';
// When the matched participant carries an `id` we render the chip as
// a Link to their profile so any signed-in user can jump straight from
// a note/chat mention to the person's profile (and from there, the
// "Message" button). Without an id we fall back to the static span.
const MENTION_LINK_CLASS = cn(
    MENTION_CLASS,
    'hover:bg-primary/20 hover:underline cursor-pointer',
);

// `T-0042`, `ST-0007`, `PRJ-USA-0001/T-0042`, `PRJ-USA-0001/ST-0007`.
// Uppercase prefix on the task code keeps us from accidentally
// linkifying timestamps like `t-23:00`. The project prefix segment
// is intentionally permissive (uppercase, digits, dash) so it can
// match the various project-code shapes the backend mints.
// Matches, in priority order:
//   1. a task / subtask code with an optional project prefix
//      (`T-0042`, `ST-0007`, `PRJ-USA-0001/T-0042`), and
//   2. a standalone PROJECT code (`P26-USA-0001`) — `P` + 2-digit year
//      + country slug + sequence. Anchored tightly so it doesn't
//      swallow arbitrary capitalised words. The task alternative is
//      listed first so a project-prefixed task code matches as a whole.
const CODE_TOKEN_REGEX =
    /(?:\b[A-Z][A-Z0-9-]+\/)?(?:T|ST)-\d+\b|\bP\d{2}-[A-Z]{2,4}-\d{3,}\b/g;

export function renderWithMentions(text, participants = [], options = {}) {
    return renderWithRichTokens(text, participants, options);
}

// Primary public entry point. The legacy `renderWithMentions` name is
// kept as a thin alias for callers that imported it directly.
export function renderWithRichTokens(text, participants = [], options = {}) {
    if (!text) return text;
    // Lookup map by lowercased name so we can resolve the matched
    // chip back to its participant record (carrying an `id`) when
    // rendering — that's how a chip becomes a profile link.
    const byName = new Map();
    const names = [];
    for (const p of participants || []) {
        if (!p || typeof p.name !== 'string') continue;
        const trimmed = p.name.trim();
        if (!trimmed) continue;
        names.push(trimmed);
        byName.set(trimmed.toLowerCase(), p);
    }
    // Longest-first so "Anna Marie" wins over "Anna" when both
    // could match at the same position.
    names.sort((a, b) => b.length - a.length);
    return splitTokens(text, names, byName, options);
}

// Two-pass tokeniser. First we walk for `@`-mentions (using the
// existing participant-list-aware logic), then we re-walk the
// leftover plain-text segments for task code tokens.
function splitTokens(text, names, byName, options) {
    const out = [];
    let key = 0;

    const pushPlain = (chunk) => {
        if (!chunk) return;
        const pieces = linkifyCodes(chunk, options);
        for (const piece of pieces) {
            if (typeof piece === 'string') {
                out.push(<Fragment key={key++}>{piece}</Fragment>);
            } else {
                // `piece.node` is a TaskCodeLink — clone with a key
                // so React's reconciler keeps its identity stable
                // across re-renders.
                out.push(
                    <Fragment key={key++}>{piece.node}</Fragment>,
                );
            }
        }
    };

    const mentionClass = cn(MENTION_CLASS, options.className);
    const unknownMentionClass = cn(
        'rounded bg-muted px-1 text-muted-foreground',
        options.className,
    );

    let i = 0;
    while (i < text.length) {
        const at = text.indexOf('@', i);
        if (at < 0) {
            pushPlain(text.slice(i));
            break;
        }
        if (at > i) pushPlain(text.slice(i, at));

        const prevChar = at === 0 ? '' : text[at - 1];
        const isBoundary = at === 0 || /\s/.test(prevChar);

        let matched = null;
        if (isBoundary) {
            for (const name of names) {
                if (
                    text.slice(at + 1, at + 1 + name.length).toLowerCase() ===
                    name.toLowerCase()
                ) {
                    matched = name;
                    break;
                }
            }
        }
        if (matched) {
            const participant = byName?.get(matched.toLowerCase());
            const profileId = participant?.id || null;
            if (profileId && !options.disableProfileLinks) {
                out.push(
                    <Link
                        key={key++}
                        to={`/users/${profileId}`}
                        title={`Open ${matched}'s profile`}
                        className={cn(MENTION_LINK_CLASS, options.className)}
                        // Prevent the click from bubbling to a parent
                        // <Link>/button (e.g. clickable note cards),
                        // which would override the navigation target.
                        onClick={(e) => e.stopPropagation()}
                    >
                        @{matched}
                    </Link>,
                );
            } else {
                out.push(
                    <span key={key++} className={mentionClass}>
                        @{matched}
                    </span>,
                );
            }
            i = at + 1 + matched.length;
            continue;
        }
        // No participant matched — fall back to a generic `@word`
        // chip if it still looks like a mention attempt, otherwise
        // emit the bare `@` and keep going.
        const tail = text.slice(at + 1);
        const m = tail.match(/^([\w.-]+)/);
        if (isBoundary && m) {
            out.push(
                <span key={key++} className={unknownMentionClass}>
                    @{m[1]}
                </span>,
            );
            i = at + 1 + m[1].length;
        } else {
            pushPlain('@');
            i = at + 1;
        }
    }
    return out;
}

// Walks a plain-text chunk and returns a mixed array of strings and
// JSX descriptors. The descriptors are wrapped in fragments by the
// caller so React's key assignment stays under control.
function linkifyCodes(chunk, options) {
    if (!chunk) return [];
    if (options.disableCodeLinks) return [chunk];

    const out = [];
    let i = 0;
    CODE_TOKEN_REGEX.lastIndex = 0;
    let m;
    while ((m = CODE_TOKEN_REGEX.exec(chunk)) != null) {
        const token = m[0];
        const start = m.index;
        const end = start + token.length;
        if (start > i) out.push(chunk.slice(i, start));
        out.push({
            type: 'taskCode',
            token,
        });
        i = end;
    }
    if (i < chunk.length) out.push(chunk.slice(i));
    return out.map((piece) =>
        typeof piece === 'string'
            ? piece
            : {
                  // React node placeholder. Caller fills the `key`
                  // when pushing into the final array.
                  node: <TaskCodeLink token={piece.token} />,
              },
    );
}

// Re-export for direct use by callers that want a single linked code
// without going through the full token pass (e.g. a tooltip).
export { TaskCodeLink };
