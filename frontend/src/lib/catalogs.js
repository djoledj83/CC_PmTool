import { useEffect, useState } from 'react';

import { api } from '@/lib/api';

// Tiny in-memory cache + subscriber pattern shared by every catalog
// hook (countries, clients, …). Same idea as `lib/priorities.js`, just
// generalised so we don't reinvent the wheel for each list.
//
// Each catalog is keyed by (path, kind):
//   path = the URL segment under /templates (e.g. "countries")
//   kind = "active" or "all"  (only the admin Templates page asks for
//          the "all" set, dropdowns always use "active")

const cache = new Map();
const inflight = new Map();
const subscribers = new Map();

function key(path, kind) {
    return `${path}:${kind}`;
}

function getSubs(k) {
    let set = subscribers.get(k);
    if (!set) {
        set = new Set();
        subscribers.set(k, set);
    }
    return set;
}

function notify(k) {
    const subs = subscribers.get(k);
    if (!subs) return;
    for (const cb of subs) {
        try {
            cb();
        } catch {
            /* never let a broken subscriber bring everything down */
        }
    }
}

async function fetchCatalog(path, kind) {
    const k = key(path, kind);
    if (cache.has(k)) return cache.get(k);
    if (inflight.has(k)) return inflight.get(k);
    const params = kind === 'all' ? { includeInactive: 1 } : {};
    const promise = (async () => {
        try {
            const res = await api.get(`/templates/${path}`, { params });
            const items = (res.data?.[path] || [])
                .slice()
                .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
            cache.set(k, items);
            notify(k);
            return items;
        } finally {
            inflight.delete(k);
        }
    })();
    inflight.set(k, promise);
    return promise;
}

export function invalidateCatalog(path) {
    for (const k of Array.from(cache.keys())) {
        if (k.startsWith(`${path}:`)) {
            cache.delete(k);
            notify(k);
        }
    }
}

// Hook returning `{ items, loading, refresh }` for a catalog. Pass
// `{ all: true }` from the admin page to also include hidden rows.
function useCatalog(path, { all = false } = {}) {
    const kind = all ? 'all' : 'active';
    const k = key(path, kind);
    const [items, setItems] = useState(() => cache.get(k) || []);
    const [loading, setLoading] = useState(() => !cache.has(k));

    useEffect(() => {
        let cancelled = false;
        const handler = () => {
            if (cancelled) return;
            setItems(cache.get(k) || []);
            setLoading(false);
        };
        getSubs(k).add(handler);
        if (!cache.has(k)) {
            fetchCatalog(path, kind)
                .then(handler)
                .catch(() => !cancelled && setLoading(false));
        } else {
            handler();
        }
        return () => {
            cancelled = true;
            getSubs(k).delete(handler);
        };
    }, [k, path, kind]);

    return {
        items,
        loading,
        refresh: () => {
            invalidateCatalog(path);
            return fetchCatalog(path, kind);
        },
    };
}

export function useCountries(opts) {
    return useCatalog('countries', opts);
}

export function useClients(opts) {
    return useCatalog('clients', opts);
}

export function useProjectTypes(opts) {
    return useCatalog('project-types', opts);
}

export function usePhaseTemplates(opts) {
    return useCatalog('phases', opts);
}

export function useBusinessUnits(opts) {
    return useCatalog('business-units', opts);
}

// Application-side catalogues used by the Releases form.
export function useAppOsOptions(opts) {
    return useCatalog('app-os', opts);
}

export function useAppPosTerminalOptions(opts) {
    return useCatalog('app-pos-terminals', opts);
}
