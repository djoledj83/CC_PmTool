// Renders a single `T-####` / `ST-####` (with optional project
// prefix) token in a note body. When the code resolves to a task the
// caller can see, the component renders a `<Link>` to
// `/projects/<projectId>#task-<taskId>`. Otherwise the bare code is
// shown in a muted chip so the reader can still see what the author
// typed.
//
// Resolution is shared across the whole page via a module-level
// promise cache. A 4-second window batches multiple instances that
// mount in the same render into a single `/api/tasks/resolve?codes=…`
// request — handy for a note body with many references.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

// Map<token, { promise, resolution? }>. `promise` settles to either
// the resolved task info or `null` (unknown / not accessible). The
// cache is module-level so it survives page navigation within a
// session — once we've resolved `T-0042` we never re-fetch it.
const cache = new Map();

// Pending tokens scheduled for the next batch. Cleared on flush.
let pendingTokens = new Set();
let pendingResolvers = new Map(); // token -> [resolve, ...]
let flushTimer = null;

function schedule(token) {
    if (cache.has(token)) return cache.get(token).promise;

    if (!pendingTokens.has(token)) {
        pendingTokens.add(token);
    }
    const promise = new Promise((resolve) => {
        const arr = pendingResolvers.get(token) || [];
        arr.push(resolve);
        pendingResolvers.set(token, arr);
    });
    cache.set(token, { promise });

    if (!flushTimer) {
        flushTimer = setTimeout(flush, 30);
    }
    return promise;
}

async function flush() {
    const tokens = Array.from(pendingTokens);
    const resolvers = pendingResolvers;
    pendingTokens = new Set();
    pendingResolvers = new Map();
    flushTimer = null;

    if (tokens.length === 0) return;

    let data = null;
    try {
        const res = await api.get('/tasks/resolve', {
            params: { codes: tokens.join(',') },
        });
        data = res.data?.codes || {};
    } catch {
        data = {};
    }
    for (const token of tokens) {
        const resolution = data[token] || null;
        const entry = cache.get(token);
        if (entry) entry.resolution = resolution;
        const arr = resolvers.get(token) || [];
        arr.forEach((r) => r(resolution));
    }
}

export function TaskCodeLink({ token, className }) {
    // `token` is the raw text matched by the regex — e.g. "T-0042"
    // or "PRJ-USA-0001/T-0042". We pass it through to the resolver
    // verbatim so the server can disambiguate by project prefix.
    const cached = cache.get(token)?.resolution;
    const [resolution, setResolution] = useState(cached ?? undefined);
    const navigate = useNavigate();

    useEffect(() => {
        if (resolution !== undefined) return;
        let cancelled = false;
        schedule(token).then((r) => {
            if (!cancelled) setResolution(r);
        });
        return () => {
            cancelled = true;
        };
    }, [token, resolution]);

    // Visual chip — always the same outer shape so a row of codes
    // doesn't reflow when one resolves.
    const baseChip =
        'inline-flex items-baseline rounded border px-1 font-mono text-[11px] tabular-nums leading-snug';

    if (resolution === undefined) {
        return (
            <span
                className={cn(
                    baseChip,
                    'border-muted bg-muted/30 text-muted-foreground/70',
                    className,
                )}
                aria-busy
            >
                {token}
            </span>
        );
    }

    if (!resolution) {
        return (
            <span
                className={cn(
                    baseChip,
                    'border-muted bg-muted/30 text-muted-foreground line-through decoration-muted-foreground/30',
                    className,
                )}
                title="No matching task in your scope"
            >
                {token}
            </span>
        );
    }

    // A standalone project code links to the project page; a task /
    // subtask code links to the row inside the project plan.
    const to = resolution.isProject
        ? `/projects/${resolution.projectId}`
        : `/projects/${resolution.projectId}#task-${resolution.id}`;

    // Navigate the same way a notification click does: inject a fresh
    // `?pulse=<ts>` before the hash so the destination's deep-link
    // effect re-fires (scroll to + highlight the row) even when you're
    // already on that project page. Plain modifier-clicks still open in
    // a new tab via the underlying href.
    const handleClick = (e) => {
        if (
            e.defaultPrevented ||
            e.button !== 0 ||
            e.metaKey ||
            e.ctrlKey ||
            e.shiftKey ||
            e.altKey
        ) {
            return;
        }
        e.preventDefault();
        const hashIdx = to.indexOf('#');
        const base = hashIdx >= 0 ? to.slice(0, hashIdx) : to;
        const hash = hashIdx >= 0 ? to.slice(hashIdx) : '';
        const sep = base.includes('?') ? '&' : '?';
        navigate(`${base}${sep}pulse=${Date.now()}${hash}`);
    };

    return (
        <Link
            to={to}
            onClick={handleClick}
            title={resolution.title}
            className={cn(
                baseChip,
                'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 hover:underline',
                className,
            )}
        >
            {token}
        </Link>
    );
}

export default TaskCodeLink;
