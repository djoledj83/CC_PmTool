import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    CloudMoon,
    HelpCircle,
    LogOut,
    Menu,
    Monitor,
    Moon,
    Search,
    Sun,
} from 'lucide-react';

import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useMobileSidebar } from '@/contexts/MobileSidebarContext';
import { NotificationBell } from '@/components/NotificationBell';
import { GlobalSearch } from '@/components/GlobalSearch';
import { ActiveTimerWidget } from '@/components/ActiveTimerWidget';
import { ChangelogPopover } from '@/components/ChangelogPopover';

// Theme cycle order + display meta for the TopBar toggle. Cycling a
// single button (light -> dark -> dim -> system -> light) keeps it one
// icon wide; the tooltip explains where the click lands next. "Dim" is
// a softer grey dark variant, grouped right after Dark.
const THEME_CYCLE = ['light', 'dark', 'dim', 'system'];
const THEME_META = {
    light: { icon: Sun, label: 'Light' },
    dark: { icon: Moon, label: 'Dark' },
    dim: { icon: CloudMoon, label: 'Dim' },
    system: { icon: Monitor, label: 'System' },
};

export function TopBar({ title, actions }) {
    const { logout } = useAuth();
    const { theme, setTheme } = useTheme();
    const navigate = useNavigate();
    const { setOpen: setMobileSidebarOpen } = useMobileSidebar();
    const [searchOpen, setSearchOpen] = useState(false);

    // Global keyboard shortcut to open the search palette. Cmd+K on
    // macOS / Ctrl+K elsewhere matches the convention everyone learnt
    // from VS Code, Linear, GitHub, etc. We also ignore the key when
    // the user is typing into a form so they don't accidentally
    // trigger it mid-sentence.
    useEffect(() => {
        const onKey = (e) => {
            if (e.key !== 'k' && e.key !== 'K') return;
            if (!(e.metaKey || e.ctrlKey)) return;
            const t = e.target;
            const inEditable =
                t?.isContentEditable ||
                t?.tagName === 'INPUT' ||
                t?.tagName === 'TEXTAREA' ||
                t?.tagName === 'SELECT';
            // Cmd/Ctrl+K should still work even from inside inputs —
            // that's the whole point of a global search shortcut.
            // But avoid swallowing events that originate from inside
            // already-open native dropdown menus.
            void inEditable;
            e.preventDefault();
            setSearchOpen(true);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const handleLogout = async () => {
        await logout();
        navigate('/login');
    };

    return (
        <header className="flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-background px-3 py-1.5 sm:h-14 sm:flex-nowrap sm:gap-2 sm:px-6 sm:py-0">
            {/* Title row — full width on mobile so it never gets crowded;
                the page actions + icons wrap to a second row below. */}
            <div className="order-1 flex w-full min-w-0 items-center gap-2 sm:w-auto sm:flex-1">
                <button
                    type="button"
                    onClick={() => setMobileSidebarOpen(true)}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
                    aria-label="Open menu"
                >
                    <Menu className="h-5 w-5" />
                </button>
                <h1 className="truncate text-base font-semibold sm:text-lg">
                    {title}
                </h1>
            </div>
            {actions ? (
                <div className="order-2 flex items-center gap-1.5 sm:gap-2">
                    {actions}
                </div>
            ) : null}
            <div className="order-3 ml-auto flex items-center gap-1.5 sm:ml-0 sm:gap-3">
                {/* Compact icon-only search trigger on phones, full
                    placeholder + Ctrl-K hint from sm and up. */}
                <button
                    type="button"
                    onClick={() => setSearchOpen(true)}
                    className="flex h-9 w-9 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:h-9 sm:w-56 sm:justify-start sm:gap-2 sm:px-2.5 sm:text-xs"
                    aria-label="Open global search"
                >
                    <Search className="h-3.5 w-3.5" />
                    <span className="hidden flex-1 text-left sm:inline">
                        Search projects…
                    </span>
                    <kbd className="hidden rounded border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-block">
                        Ctrl K
                    </kbd>
                </button>
                <ActiveTimerWidget />
                {(() => {
                    const next =
                        THEME_CYCLE[
                            (THEME_CYCLE.indexOf(theme) + 1) %
                                THEME_CYCLE.length
                        ];
                    const Icon = (THEME_META[theme] || THEME_META.system)
                        .icon;
                    return (
                        <button
                            type="button"
                            onClick={() => setTheme(next)}
                            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            title={`Theme: ${THEME_META[theme]?.label || 'System'} — click for ${THEME_META[next].label}`}
                            aria-label="Toggle color theme"
                        >
                            <Icon className="h-[18px] w-[18px]" />
                        </button>
                    );
                })()}
                <ChangelogPopover />
                <NotificationBell />
                {/* Help & guide sits just left of the way-out (logout)
                    icon. Profile / identity now lives at the top of the
                    sidebar instead of here. */}
                <button
                    type="button"
                    onClick={() => navigate('/help')}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title="Help & guide"
                    aria-label="Help & guide"
                >
                    <HelpCircle className="h-[18px] w-[18px]" />
                </button>
                <button
                    type="button"
                    onClick={handleLogout}
                    className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    title="Log out"
                    aria-label="Log out"
                >
                    <LogOut className="h-[18px] w-[18px]" />
                </button>
            </div>
            <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
        </header>
    );
}
