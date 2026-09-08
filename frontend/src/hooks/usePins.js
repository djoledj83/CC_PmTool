import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';

// One generic table on the backend (UserPin) feeds every "starred /
// pinned / focused / bookmarked" toggle in the app. This hook gives
// callers a per-`kind` view of the current user's pins with cheap
// optimistic updates so the UI feels instant.
//
// Usage:
//   const { pinned, isPinned, toggle, loading } = usePins('PROJECT');
//   ...
//   <button onClick={() => toggle(project.id)}>
//     {isPinned(project.id) ? 'Unpin' : 'Pin'}
//   </button>
//
// `pinned` is the array of UserPin rows for the given kind (so the
// caller can render bookmark notes or sort by createdAt). `isPinned`
// is the O(1) lookup helper.
export function usePins(kind, { refIds = null, enabled = true } = {}) {
    const [pinned, setPinned] = useState([]);
    // When the hook is disabled (caller passes `enabled: false`) we
    // never fire a network request, so `loading` should stay false
    // from the start — otherwise downstream buttons would render as
    // disabled forever.
    const [loading, setLoading] = useState(Boolean(enabled));
    // Track the kind in a ref so the request-cancellation logic
    // doesn't go stale if the caller changes kinds. Same for refIds.
    const kindRef = useRef(kind);
    kindRef.current = kind;

    const fetchPins = useCallback(async () => {
        setLoading(true);
        try {
            const params = { kind };
            if (refIds && refIds.length > 0) {
                params.refIds = refIds.join(',');
            }
            const { data } = await api.get('/pins', { params });
            if (kindRef.current === kind) {
                setPinned(data.pins || []);
            }
        } catch {
            // Silent — the FE just degrades to "no pins" state.
            setPinned([]);
        } finally {
            setLoading(false);
        }
    }, [kind, refIds && refIds.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        // `enabled: false` is used by components that already receive
        // a pin hook from a parent (see PinButton's `pinHookOverride`
        // path). Skipping the fetch here prevents N duplicate
        // GET /pins?kind=... requests when a list renders N rows that
        // each instantiate a PinButton — which would otherwise hit
        // the rate limiter (429) on busy pages.
        if (!enabled) return;
        fetchPins();
    }, [fetchPins, enabled]);

    const isPinned = useCallback(
        (refId) => pinned.some((p) => p.refId === refId),
        [pinned],
    );

    const toggle = useCallback(
        async (refId, { note } = {}) => {
            const currently = pinned.find((p) => p.refId === refId);
            // Optimistic update: flip the local state first so the
            // UI is instant. We rollback on error.
            if (currently) {
                setPinned((prev) => prev.filter((p) => p.refId !== refId));
                try {
                    await api.delete('/pins', {
                        params: { kind, refId },
                    });
                } catch {
                    setPinned((prev) => [currently, ...prev]);
                }
            } else {
                const tempId = `tmp-${refId}`;
                const optimistic = {
                    id: tempId,
                    kind,
                    refId,
                    note: note || null,
                    createdAt: new Date().toISOString(),
                };
                setPinned((prev) => [optimistic, ...prev]);
                try {
                    const { data } = await api.post('/pins', {
                        kind,
                        refId,
                        note: note || null,
                    });
                    setPinned((prev) =>
                        prev.map((p) => (p.id === tempId ? data.pin : p)),
                    );
                } catch {
                    setPinned((prev) => prev.filter((p) => p.id !== tempId));
                }
            }
        },
        [kind, pinned],
    );

    return { pinned, isPinned, toggle, loading, refetch: fetchPins };
}

export default usePins;
