import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useCallback,
} from 'react';

import { api, setAccessToken, setUnauthorizedHandler } from '@/lib/api';

// How often to silently re-run the refresh handshake while the user
// is logged in. This keeps effectiveCapabilities in sync after an
// admin changes roles / permissions — without requiring a re-login.
const CAPABILITY_REFRESH_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

const AuthContext = createContext(null);

// The periodic silent refresh re-fetches the user on a timer and on tab
// focus. If we blindly `setUser(data.user)` each time we hand every
// consumer a brand-new object reference — re-rendering the whole tree
// (and, downstream, refetching screens, collapsing panels, and dropping
// half-typed input) even when nothing actually changed. Compare the
// serialized shape and keep the previous reference when it's identical.
function sameUserShape(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    const logout = useCallback(async () => {
        try {
            await api.post('/auth/logout');
        } catch {
            // ignore
        }
        setAccessToken(null);
        setUser(null);
    }, []);

    useEffect(() => {
        setUnauthorizedHandler(() => {
            setAccessToken(null);
            setUser(null);
        });
    }, []);

    useEffect(() => {
        let cancelled = false;

        async function bootstrap() {
            try {
                const { data } = await api.post('/auth/refresh');
                setAccessToken(data.accessToken);
                if (!cancelled) setUser(data.user);
            } catch {
                if (!cancelled) setUser(null);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        bootstrap();
        return () => {
            cancelled = true;
        };
    }, []);

    const login = useCallback(async (email, password) => {
        const { data } = await api.post('/auth/login', { email, password });
        setAccessToken(data.accessToken);
        setUser(data.user);
        return data.user;
    }, []);

    const register = useCallback(async (payload) => {
        const { data } = await api.post('/auth/register', payload);
        // First-user bootstrap auto-logs them in; everyone else is PENDING
        // and stays signed-out until an admin approves their account.
        if (data.accessToken) {
            setAccessToken(data.accessToken);
            setUser(data.user);
        }
        return data;
    }, []);

    // Lets components that just edited the current user (Profile dialog,
    // avatar uploader, …) push the fresh row back into the auth state
    // without round-tripping through /auth/refresh again.
    const updateCurrentUser = useCallback((next) => {
        setUser((prev) => {
            if (!prev) return prev;
            if (typeof next === 'function') return next(prev);
            return { ...prev, ...next };
        });
    }, []);

    // Re-runs the refresh handshake so the auth state picks up any
    // server-side changes (role/capabilities edits, profile updates)
    // without requiring a full logout/login cycle.
    const refreshCurrentUser = useCallback(async () => {
        try {
            const { data } = await api.post('/auth/refresh');
            setAccessToken(data.accessToken);
            setUser(data.user);
        } catch {
            // Non-fatal — stale state is still usable
        }
    }, []);

    // Silently refresh capabilities while the user is logged in.
    // Two triggers:
    //   1. A periodic timer (every CAPABILITY_REFRESH_INTERVAL_MS).
    //   2. The tab becoming visible after being hidden — catches the
    //      common scenario where an admin changed another user's
    //      permissions in a different window/tab.
    const userRef = useRef(user);
    userRef.current = user;

    useEffect(() => {
        const silentRefresh = async () => {
            if (!userRef.current) return; // not logged in — skip
            try {
                const { data } = await api.post('/auth/refresh');
                setAccessToken(data.accessToken);
                // Only swap the reference when something actually changed,
                // so an unchanged refresh doesn't re-render every consumer.
                setUser((prev) =>
                    sameUserShape(prev, data.user) ? prev : data.user,
                );
            } catch {
                // ignore — don't log out on a silent refresh failure
            }
        };

        const timer = setInterval(silentRefresh, CAPABILITY_REFRESH_INTERVAL_MS);

        const onVisible = () => {
            if (document.visibilityState === 'visible') silentRefresh();
        };
        document.addEventListener('visibilitychange', onVisible);

        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, []); // intentionally empty — refs hold current values

    // Memoize so the context value keeps a stable reference between
    // renders. Without this, every render handed consumers a fresh
    // object and re-rendered the whole subtree.
    const value = useMemo(
        () => ({
            user,
            loading,
            login,
            register,
            logout,
            updateCurrentUser,
            refreshCurrentUser,
        }),
        [
            user,
            loading,
            login,
            register,
            logout,
            updateCurrentUser,
            refreshCurrentUser,
        ],
    );

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
    return ctx;
}
