// No-flash theme bootstrap: apply the saved theme before the bundle
// loads so a dark-mode user never sees a white flash. Lives as a real
// file (not an inline <script>) because the nginx CSP is
// `script-src 'self'` — inline scripts are rightly blocked.
// Mirrors the logic in src/contexts/ThemeContext.jsx.
(function () {
    try {
        var t = localStorage.getItem('theme');
        var dim = t === 'dim';
        var dark =
            t === 'dark' ||
            dim ||
            ((!t || t === 'system') &&
                window.matchMedia('(prefers-color-scheme: dark)').matches);
        if (dark) document.documentElement.classList.add('dark');
        if (dim) document.documentElement.classList.add('dim');
    } catch (e) {
        /* ignore */
    }
})();
