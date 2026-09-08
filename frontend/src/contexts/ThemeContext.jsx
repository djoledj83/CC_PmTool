// Theme (dark / light / system) provider.
//
// Resolution order:
//   1. Logged-in user's `themePreference` from the server (synced
//      across devices — the TopBar toggle PATCHes it).
//   2. localStorage 'theme' (covers the login page and the gap before
//      /auth/me resolves; also what the no-flash snippet in
//      index.html reads).
//   3. 'system' — follows the OS via prefers-color-scheme, live.
//
// Applying = toggling the `dark` class on <html>; Tailwind is
// configured with darkMode: ['class'] and index.css carries the full
// dark variable palette, so everything else is already wired.
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
} from 'react';

import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

const ThemeContext = createContext(null);

const VALID = ['light', 'dark', 'dim', 'system'];

function systemPrefersDark() {
    return (
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
    );
}

// `dim` is a softer grey variant of dark. It rides on TOP of the `dark`
// class (so every `dark:` Tailwind utility still applies) and layers a
// `dim` class that overrides the surface colours — see index.css.
function applyTheme(pref) {
    const root = document.documentElement;
    const dark =
        pref === 'dark' ||
        pref === 'dim' ||
        (pref === 'system' && systemPrefersDark());
    root.classList.toggle('dark', dark);
    root.classList.toggle('dim', pref === 'dim');
}

function storedTheme() {
    try {
        const v = localStorage.getItem('theme');
        return VALID.includes(v) ? v : 'system';
    } catch {
        return 'system';
    }
}

export function ThemeProvider({ children }) {
    const { user } = useAuth();
    const [theme, setThemeState] = useState(storedTheme);

    // Server preference wins once the user is known. This is what
    // makes the choice follow the user across devices.
    useEffect(() => {
        const pref = user?.themePreference;
        if (pref && VALID.includes(pref)) {
            setThemeState(pref);
            try {
                localStorage.setItem('theme', pref);
            } catch {
                /* private mode etc. — non-fatal */
            }
        }
    }, [user?.themePreference]);

    // Apply on every change + follow the OS live while on 'system'.
    useEffect(() => {
        applyTheme(theme);
        if (theme !== 'system' || !window.matchMedia) return undefined;
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => applyTheme('system');
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, [theme]);

    const setTheme = useCallback(
        (pref) => {
            if (!VALID.includes(pref)) return;
            setThemeState(pref);
            try {
                localStorage.setItem('theme', pref);
            } catch {
                /* non-fatal */
            }
            // Persist to the profile (fire-and-forget — the UI has
            // already switched; a failed PATCH just means another
            // device won't see the change).
            if (user?.id) {
                api.patch(`/users/${user.id}`, {
                    themePreference: pref,
                }).catch(() => {});
            }
        },
        [user?.id],
    );

    return (
        <ThemeContext.Provider value={{ theme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
    return ctx;
}
