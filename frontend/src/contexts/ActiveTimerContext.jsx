// Single source of truth for "is the current user's timer running, and
// if so on what?". Both the TopBar pill and the per-project Time card
// subscribe to this context so a Stop on one immediately reflects on
// the other without a page refresh.
//
// Implementation notes:
// - We poll /api/time/running once a minute as a backstop for the
//   case where another tab / device started or stopped a timer.
// - All mutating helpers (start / stop) update local state
//   optimistically using the entry the server returns, so the UI
//   never lags a network round-trip behind the user's click.

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

const ActiveTimerContext = createContext(null);

const POLL_INTERVAL_MS = 60_000;

export function ActiveTimerProvider({ children }) {
    const { user } = useAuth();
    const [entry, setEntry] = useState(null);
    const [loading, setLoading] = useState(false);

    // Tick used to broadcast "something changed about time tracking"
    // to subscribers that maintain their own derived state (e.g. the
    // project Time card refetches its summary). Bumped after every
    // start/stop/manual edit so listeners don't have to know exactly
    // what changed — they just refetch.
    const [revision, setRevision] = useState(0);
    const bumpRevision = useCallback(() => setRevision((r) => r + 1), []);

    // Avoid a stale closure: helpers reference whatever entry was
    // current at call-time, not the snapshot from when the provider
    // first mounted.
    const entryRef = useRef(entry);
    useEffect(() => {
        entryRef.current = entry;
    }, [entry]);

    const fetchRunning = useCallback(async () => {
        if (!user) {
            setEntry(null);
            return null;
        }
        try {
            const { data } = await api.get('/time/running');
            setEntry(data?.entry || null);
            return data?.entry || null;
        } catch (err) {
            // Auth interceptors will surface real auth issues; for a
            // transient network blip we just keep the previous state
            // so the pill doesn't flicker.
            console.warn('[active-timer] could not refresh:', err?.message);
            return entryRef.current;
        }
    }, [user]);

    // Mount: pull initial state. Then poll every minute while the user
    // is logged in. We also refetch when the tab regains focus so the
    // UI matches reality after a long idle.
    useEffect(() => {
        if (!user) {
            setEntry(null);
            return undefined;
        }
        let cancelled = false;
        setLoading(true);
        fetchRunning().finally(() => {
            if (!cancelled) setLoading(false);
        });
        const id = setInterval(fetchRunning, POLL_INTERVAL_MS);
        const onFocus = () => fetchRunning();
        window.addEventListener('focus', onFocus);
        return () => {
            cancelled = true;
            clearInterval(id);
            window.removeEventListener('focus', onFocus);
        };
    }, [user, fetchRunning]);

    const startTimer = useCallback(
        async ({ projectId, taskId, description }) => {
            const payload = {};
            if (projectId) payload.projectId = projectId;
            if (taskId) payload.taskId = taskId;
            if (description) payload.description = description;
            const { data } = await api.post('/time/start', payload);
            setEntry(data?.entry || null);
            bumpRevision();
            return data?.entry || null;
        },
        [bumpRevision],
    );

    const stopTimer = useCallback(async () => {
        const { data } = await api.post('/time/stop');
        setEntry(null);
        bumpRevision();
        return data?.entry || null;
    }, [bumpRevision]);

    // Convenience: check if the running timer is on a specific project /
    // task. The project Time card uses this to render "Stop timer" in
    // the right place without re-deriving state itself.
    const isRunningFor = useCallback(
        ({ projectId, taskId } = {}) => {
            if (!entry) return false;
            if (projectId && entry.projectId !== projectId) return false;
            if (taskId && entry.taskId !== taskId) return false;
            return true;
        },
        [entry],
    );

    const value = useMemo(
        () => ({
            entry,
            loading,
            revision,
            refresh: fetchRunning,
            startTimer,
            stopTimer,
            isRunningFor,
            // Lets non-timer code (e.g. manual entry creation, deletion)
            // signal "summaries should refetch" without owning a timer.
            notifyChanged: bumpRevision,
        }),
        [
            entry,
            loading,
            revision,
            fetchRunning,
            startTimer,
            stopTimer,
            isRunningFor,
            bumpRevision,
        ],
    );

    return (
        <ActiveTimerContext.Provider value={value}>
            {children}
        </ActiveTimerContext.Provider>
    );
}

export function useActiveTimer() {
    const ctx = useContext(ActiveTimerContext);
    if (!ctx) {
        throw new Error(
            'useActiveTimer must be used inside <ActiveTimerProvider>',
        );
    }
    return ctx;
}
