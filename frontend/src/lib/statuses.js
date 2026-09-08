// Runtime-resolved project status list. Mirrors lib/priorities.js
// almost line-for-line — kept separate so the cache / subscribers map
// can't leak across the two concepts (a priority invalidation
// shouldn't refetch statuses and vice versa).
//
// Source of truth: GET /api/templates/statuses?scope=PROJECT, backed by
// the StatusOption table. The underlying Prisma ProjectStatus enum is
// still the persistence layer — these rows only customise label /
// color / order / isActive for display.
//
// When a status key is encountered that no longer exists in the
// admin-managed list (admin hid it, but historical rows still use it),
// `find()` falls back to the static PROJECT_STATUSES list, then to a
// last-resort `{ value: key, label: key, badge: 'secondary' }` so the
// UI never blanks out.
import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import {
    PROJECT_STATUSES,
    PROJECT_STATUS_MAP,
    TASK_STATUSES,
    TASK_STATUS_MAP,
} from '@/lib/constants';

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

let cache = { TASK: null, PROJECT: null };
let inflight = { TASK: null, PROJECT: null };
const subscribers = new Set();

function notify() {
    subscribers.forEach((cb) => {
        try {
            cb();
        } catch {
            /* swallow broken subscribers */
        }
    });
}

async function fetchScope(scope) {
    if (cache[scope]) return cache[scope];
    if (inflight[scope]) return inflight[scope];
    const promise = (async () => {
        try {
            const res = await api.get(`/templates/statuses?scope=${scope}`);
            const list = (res.data?.statuses || [])
                .filter((s) => s.isActive)
                .sort((a, b) => a.order - b.order)
                .map((s) => ({
                    value: s.key,
                    label: s.label,
                    color: s.color,
                    badge: colorToBadge(s.color),
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

export function invalidateStatuses() {
    cache = { TASK: null, PROJECT: null };
    inflight = { TASK: null, PROJECT: null };
    notify();
}

function fallbackForScope(scope) {
    return scope === 'TASK' ? TASK_STATUSES : PROJECT_STATUSES;
}

function fallbackMapForScope(scope) {
    return scope === 'TASK' ? TASK_STATUS_MAP : PROJECT_STATUS_MAP;
}

export function useStatuses(scope) {
    // Task status is a FIXED enum (TODO / IN_PROGRESS / ON_HOLD / DONE) that
    // the task API validates against — custom task statuses aren't supported.
    // So for TASK we always use the built-in list and never fetch server
    // rows, otherwise a stray StatusOption(scope=TASK) with an invalid key
    // (e.g. "IN PROGRESS") would surface in the picker and get rejected on
    // save. Only PROJECT statuses are truly customisable.
    const isFixed = scope === 'TASK';
    const [list, setList] = useState(() =>
        isFixed ? fallbackForScope(scope) : cache[scope] || fallbackForScope(scope),
    );

    useEffect(() => {
        if (isFixed) {
            setList(fallbackForScope(scope));
            return undefined;
        }
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
    }, [scope, isFixed]);

    const find = (key) => {
        if (!key) return null;
        const direct = list.find((s) => s.value === key);
        if (direct) return direct;
        const fallback = fallbackMapForScope(scope)[key];
        if (fallback) return fallback;
        return { value: key, label: key, color: 'slate', badge: 'secondary' };
    };

    return { list, find };
}

export function useProjectStatuses() {
    return useStatuses('PROJECT');
}

export function useTaskStatuses() {
    return useStatuses('TASK');
}
