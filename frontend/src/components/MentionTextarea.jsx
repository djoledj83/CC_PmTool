import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from 'react';
import { AtSign, Hash, Loader2 } from 'lucide-react';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

// Two trigger patterns share the same popover plumbing — only the
// query character and the result type differ.
//
//   `@` — participant mention. Query chars match the usual name set
//         (word chars + dot + dash) so `@anna-li` works.
//   `/` — task / subtask deep-link picker. Query chars allow letters,
//         digits and `-` / `/` so `/T-0042` and `/PRJ-USA-0001/T-0042`
//         both behave as expected. Restricting the character class
//         means the popover dismisses naturally once the user types
//         a space or any punctuation.
const TRIGGERS = {
    '@': /(^|\s)@([\w.-]*)$/,
    '/': /(^|\s)\/([\w/-]*)$/,
};

// Mention picker: filter `participants` against the typed query.
function filterParticipants(participants, query) {
    const q = query.toLowerCase();
    const seen = new Set();
    const all = [];
    for (const p of participants) {
        if (!p?.id || seen.has(p.id)) continue;
        seen.add(p.id);
        const name = p.name || p.email || '';
        all.push({
            id: p.id,
            name,
            email: p.email || '',
            avatarUrl: p.avatarUrl || null,
        });
    }
    if (!q) return all.slice(0, 8);
    return all
        .filter((p) => {
            const haystack = `${p.name} ${p.email}`.toLowerCase();
            return haystack.includes(q);
        })
        .slice(0, 8);
}

// Composable textarea that pops up a picker on `@` (participants) or
// `/` (tasks/subtasks). Drop-in for the shadcn Textarea; the parent
// owns the value via the standard `value` / `onChange` pair.
export const MentionTextarea = forwardRef(function MentionTextarea(
    {
        value,
        onChange,
        participants = [],
        // Scope the slash-task lookup to a single project (when known).
        // When omitted, the backend falls back to every project the
        // caller can see.
        slashProjectId = null,
        // When true, the slash lookup also returns matching PROJECTS
        // (used in chat so you can reference a whole project, not just
        // tasks). Notes leave this off, so their picker is unchanged.
        slashIncludeProjects = false,
        // Where the suggestion popover opens. Notes have room below the
        // composer ('bottom', the default); a bottom-anchored chat
        // composer must open 'top' or the list is hidden under the input.
        popoverPlacement = 'bottom',
        // Insert project-qualified codes (`PROJECT/T-0006`) so a slash
        // reference is unambiguous across projects. Chat sets this;
        // project-scoped notes leave it off and keep bare codes.
        qualifySlashCodes = false,
        // Opt-out switch so a future surface can have just `@` without
        // the slash menu (e.g. a chat composer where `/foo` means
        // something else).
        enableSlashLookup = true,
        className,
        // Forwarded so callers can keep their existing focus / blur etc.
        onKeyDown: parentKeyDown,
        onBlur: parentBlur,
        ...rest
    },
    ref,
) {
    const innerRef = useRef(null);
    useImperativeHandle(ref, () => innerRef.current, []);

    // Active session: `{ kind: '@' | '/', start, query }`. `null` =
    // no popover.
    const [session, setSession] = useState(null);
    const [activeIdx, setActiveIdx] = useState(0);

    // Async results for the slash session (the participants picker
    // is synchronous and lives in `mentionCandidates` below).
    const [slashCandidates, setSlashCandidates] = useState([]);
    const [slashLoading, setSlashLoading] = useState(false);
    const [slashError, setSlashError] = useState(null);

    const mentionCandidates = useMemo(
        () =>
            session?.kind === '@'
                ? filterParticipants(participants, session.query)
                : [],
        [session, participants],
    );

    const candidates =
        session?.kind === '/' ? slashCandidates : mentionCandidates;
    const showSpinner = session?.kind === '/' && slashLoading;

    // Recompute the active session based on the text immediately to
    // the left of the cursor. Iterates over each enabled trigger and
    // picks the rightmost one (the user might have an old `@` earlier
    // in the line but currently be typing `/`).
    const updateSession = useCallback(
        (text, cursor) => {
            if (cursor == null) {
                setSession(null);
                return;
            }
            const left = text.slice(0, cursor);
            let best = null;
            for (const [kind, regex] of Object.entries(TRIGGERS)) {
                if (kind === '/' && !enableSlashLookup) continue;
                const m = left.match(regex);
                if (!m) continue;
                const triggerPos = m.index + m[1].length;
                if (!best || triggerPos > best.start) {
                    best = { kind, start: triggerPos, query: m[2] };
                }
            }
            if (!best) {
                setSession(null);
                return;
            }
            setSession(best);
            setActiveIdx(0);
        },
        [enableSlashLookup],
    );

    // Race-protection token for the slash lookup: any in-flight
    // response whose token no longer matches `current` is dropped on
    // the floor so a slow earlier query can't overwrite a fresher one.
    const slashTokenRef = useRef(null);

    // Fetch slash results when the session is active. Debounced so a
    // rapid burst of keystrokes only fires the last request.
    useEffect(() => {
        if (session?.kind !== '/') {
            setSlashCandidates([]);
            setSlashLoading(false);
            setSlashError(null);
            return;
        }
        const token = Symbol('req');
        slashTokenRef.current = token;
        setSlashLoading(true);
        setSlashError(null);
        const t = setTimeout(async () => {
            try {
                const { data } = await api.get('/tasks/lookup', {
                    params: {
                        q: session.query || '',
                        projectId: slashProjectId || undefined,
                        includeProjects: slashIncludeProjects
                            ? 1
                            : undefined,
                        limit: 8,
                    },
                });
                if (slashTokenRef.current === token) {
                    setSlashCandidates(data.results || []);
                }
            } catch (err) {
                if (slashTokenRef.current === token) {
                    setSlashCandidates([]);
                    setSlashError(
                        err?.response?.status === 404
                            ? 'Task lookup endpoint missing — restart the backend?'
                            : err?.response?.data?.error ||
                                  'Task lookup failed',
                    );
                }
            } finally {
                if (slashTokenRef.current === token) {
                    setSlashLoading(false);
                }
            }
        }, 150);
        return () => clearTimeout(t);
    }, [session, slashProjectId]);

    // Whenever the parent-controlled value changes externally (e.g.
    // the form is reset), sync the session against the textarea's
    // current cursor position so we don't show a stale popover.
    useEffect(() => {
        const el = innerRef.current;
        if (!el) return;
        const t = setTimeout(() => {
            updateSession(el.value, el.selectionStart);
        }, 0);
        return () => clearTimeout(t);
    }, [value, updateSession]);

    // Replace the trigger + query with the picked text. Works for
    // both `@name` (participant) and `T-0042` (task code).
    const insertAtSession = (insertion) => {
        const el = innerRef.current;
        if (!el || !session) return;
        const before = value.slice(0, session.start);
        const afterCursor = value.slice(el.selectionEnd);
        const text = `${insertion} `;
        const next = `${before}${text}${afterCursor}`;
        const caret = before.length + text.length;
        onChange?.({ target: { value: next } });
        setSession(null);
        requestAnimationFrame(() => {
            const node = innerRef.current;
            if (!node) return;
            node.focus();
            node.setSelectionRange(caret, caret);
        });
    };

    const insertCandidate = (c) => {
        if (!session) return;
        if (session.kind === '@') {
            insertAtSession(`@${c.name}`);
        } else if (
            qualifySlashCodes &&
            c.code &&
            c.projectCode &&
            !c.isProject
        ) {
            // Cross-project surfaces (chat) must insert the
            // project-qualified code — a bare `T-0006` is ambiguous
            // because task codes are only unique within a project.
            // `PROJECT/T-0006` resolves to exactly one task. Projects'
            // own codes are already globally unique, so they're left
            // bare.
            insertAtSession(`${c.projectCode}/${c.code}`);
        } else {
            // Bare code (project-scoped notes) or a project code. The
            // "TITLE" fallback covers a row that somehow has no code.
            insertAtSession(c.code || c.title);
        }
    };

    const onKeyDown = (e) => {
        // Let the popover claim arrow / enter / esc only when we
        // actually have suggestions to show.
        if (session && candidates.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIdx((i) =>
                    Math.min(i + 1, candidates.length - 1),
                );
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx((i) => Math.max(i - 1, 0));
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                insertCandidate(candidates[activeIdx]);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setSession(null);
                return;
            }
        }
        parentKeyDown?.(e);
    };

    const handleChange = (e) => {
        onChange?.(e);
        updateSession(e.target.value, e.target.selectionStart);
    };

    const handleSelect = (e) => {
        updateSession(e.target.value, e.target.selectionStart);
    };

    const handleBlur = (e) => {
        setTimeout(() => setSession(null), 100);
        parentBlur?.(e);
    };

    // The `/` picker is async + project-scoped, so the user gets a
    // useful "Type a code or title…" / spinner / error / empty state
    // for free if we just always keep the popover mounted while the
    // session is active. The `@` picker stays demand-driven (only
    // opens when there's something to mention) since the participant
    // list is synchronous and an empty popover would feel noisy.
    const popoverOpen = Boolean(
        session &&
            (session.kind === '/' ||
                candidates.length > 0 ||
                (session.kind === '@' && session.query)),
    );

    return (
        <div className="relative">
            <Textarea
                ref={innerRef}
                value={value ?? ''}
                onChange={handleChange}
                onKeyDown={onKeyDown}
                onSelect={handleSelect}
                onClick={handleSelect}
                onBlur={handleBlur}
                className={className}
                {...rest}
            />
            {popoverOpen && (
                <div
                    className={cn(
                        'absolute left-2 right-2 z-50 max-h-72 overflow-auto rounded-md border bg-popover p-1 shadow-lg',
                        popoverPlacement === 'top'
                            ? 'bottom-full mb-1'
                            : 'top-full mt-1',
                    )}
                    onMouseDown={(e) => e.preventDefault()}
                    role="listbox"
                    aria-label={
                        session.kind === '@'
                            ? 'Mention a project participant'
                            : 'Link a task or subtask'
                    }
                >
                    <div className="flex items-center justify-between gap-1 px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        <span className="flex items-center gap-1">
                            {session.kind === '@' ? (
                                <>
                                    <AtSign className="h-3 w-3" />
                                    Mention a participant
                                </>
                            ) : (
                                <>
                                    <Hash className="h-3 w-3" />
                                    Link a task or subtask
                                </>
                            )}
                        </span>
                        {showSpinner && (
                            <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                    </div>
                    {slashError && session.kind === '/' ? (
                        <div className="px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                            {slashError}
                        </div>
                    ) : candidates.length === 0 && !showSpinner ? (
                        <div className="px-3 py-2 text-xs text-muted-foreground">
                            {session.kind === '@'
                                ? `No participant matches “${session.query}”.`
                                : session.query
                                  ? `No task matches “${session.query}”.`
                                  : 'Start typing a code or title…'}
                        </div>
                    ) : (
                        candidates.map((c, idx) => {
                            const active = idx === activeIdx;
                            if (session.kind === '@') {
                                return (
                                    <button
                                        key={c.id}
                                        type="button"
                                        onMouseEnter={() => setActiveIdx(idx)}
                                        onClick={() => insertCandidate(c)}
                                        className={cn(
                                            'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                                            active
                                                ? 'bg-accent'
                                                : 'hover:bg-accent/60',
                                        )}
                                        role="option"
                                        aria-selected={active}
                                    >
                                        <Avatar className="h-6 w-6">
                                            {c.avatarUrl && (
                                                <AvatarImage
                                                    src={resolveAssetUrl(
                                                        c.avatarUrl,
                                                    )}
                                                    alt={c.name}
                                                />
                                            )}
                                            <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                                                {initials(c.name)}
                                            </AvatarFallback>
                                        </Avatar>
                                        <span className="min-w-0 flex-1 truncate font-medium">
                                            {c.name}
                                        </span>
                                        {c.email && (
                                            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                                                {c.email}
                                            </span>
                                        )}
                                    </button>
                                );
                            }
                            return (
                                <button
                                    key={c.id}
                                    type="button"
                                    onMouseEnter={() => setActiveIdx(idx)}
                                    onClick={() => insertCandidate(c)}
                                    className={cn(
                                        'flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                                        active
                                            ? 'bg-accent'
                                            : 'hover:bg-accent/60',
                                    )}
                                    role="option"
                                    aria-selected={active}
                                >
                                    <span
                                        className={cn(
                                            'mt-0.5 inline-flex shrink-0 items-center rounded border bg-muted/40 px-1.5 py-px font-mono text-[10px] uppercase tracking-wide',
                                            c.isSubtask
                                                ? 'border-violet-300 text-violet-700 dark:border-violet-700 dark:text-violet-300'
                                                : 'border-primary/30 text-primary',
                                        )}
                                    >
                                        {c.code || '—'}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate font-medium">
                                            {c.title}
                                        </span>
                                        <span className="block truncate text-[10px] text-muted-foreground">
                                            {c.projectName || 'Project'}
                                            {c.isSubtask &&
                                                c.parentCode &&
                                                ` · subtask of ${c.parentCode}`}
                                        </span>
                                    </span>
                                </button>
                            );
                        })
                    )}
                </div>
            )}
        </div>
    );
});
