import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import {
    PROJECT_PRIORITIES,
    PROJECT_PRIORITY_MAP,
    TASK_PRIORITIES,
    TASK_PRIORITY_MAP,
} from '@/lib/constants';

// Map our admin-defined color tokens to the existing Badge variants so
// rendering doesn't need to know about Tailwind classes. Anything not
// listed falls back to "secondary".
const COLOR_TO_BADGE = {
    slate: 'outline',
    sky: 'secondary',
    emerald: 'success',
    amber: 'warning',
    rose: 'destructive',
    violet: 'default',
};

function colorToBadge(color) {
    return COLOR_TO_BADGE[color] || 'secondary';
}

// In-memory cache so multiple components don't re-fetch the list. We
// invalidate it from the admin Templates page after mutations using
// `invalidatePriorities()`.
let cache = { TASK: null, PROJECT: null };
let inflight = { TASK: null, PROJECT: null };
const subscribers = new Set();

function notify() {
    subscribers.forEach((cb) => {
        try {
            cb();
        } catch {
            /* ignore broken subscribers */
        }
    });
}

async function fetchScope(scope) {
    if (cache[scope]) return cache[scope];
    if (inflight[scope]) return inflight[scope];
    const promise = (async () => {
        try {
            const res = await api.get(`/templates/priorities?scope=${scope}`);
            const list = res.data.priorities
                .filter((p) => p.isActive)
                .sort((a, b) => a.order - b.order)
                .map((p) => ({
                    value: p.key,
                    label: p.label,
                    color: p.color,
                    badge: colorToBadge(p.color),
                }));
            cache[scope] = list;
            notify();
            return list;
        } finally {
            inflight[scope] = null;
        }
    })();
    inflight[scope] = promise;
    return promise;
}

export function invalidatePriorities() {
    cache = { TASK: null, PROJECT: null };
    inflight = { TASK: null, PROJECT: null };
    notify();
}

function fallbackForScope(scope) {
    return scope === 'TASK' ? TASK_PRIORITIES : PROJECT_PRIORITIES;
}

function fallbackMapForScope(scope) {
    return scope === 'TASK' ? TASK_PRIORITY_MAP : PROJECT_PRIORITY_MAP;
}

// React hook returning the active priority options for the given scope.
// Returns the static fallback list while the network request is in
// flight so the UI never flashes empty dropdowns.
export function usePriorities(scope) {
    const [list, setList] = useState(() => cache[scope] || fallbackForScope(scope));

    useEffect(() => {
        let cancelled = false;
        const onChange = () => {
            if (cancelled) return;
            setList(cache[scope] || fallbackForScope(scope));
        };
        subscribers.add(onChange);
        if (!cache[scope]) {
            fetchScope(scope).then(onChange).catch(onChange);
        } else {
            onChange();
        }
        return () => {
            cancelled = true;
            subscribers.delete(onChange);
        };
    }, [scope]);

    // `find()` always returns *something* sensible even if a stored
    // priority key has been deleted on the server (e.g. an old project
    // still on URGENT after admin removed that option).
    const find = (key) => {
        if (!key) return null;
        const direct = list.find((p) => p.value === key);
        if (direct) return direct;
        const fallback = fallbackMapForScope(scope)[key];
        if (fallback) return fallback;
        return { value: key, label: key, color: 'slate', badge: 'secondary' };
    };

    return { list, find };
}

export function useTaskPriorities() {
    return usePriorities('TASK');
}

export function useProjectPriorities() {
    return usePriorities('PROJECT');
}
