import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
    return twMerge(clsx(inputs));
}

import { spotlightElement } from './spotlight';

const DEEP_LINK_HANDLED_PREFIX = 'pm-deeplink-handled:';

export function deepLinkHandledKey(pathname, hash) {
    return `${DEEP_LINK_HANDLED_PREFIX}${pathname || ''}${hash || ''}`;
}

// Remember that a task/activity hash was already highlighted this
// browser-tab session so a plain reload doesn't replay the animation
// or force-scroll the user back to the row.
export function markDeepLinkHandled(pathname, hash) {
    if (!hash) return;
    try {
        sessionStorage.setItem(deepLinkHandledKey(pathname, hash), '1');
    } catch {
        /* private browsing / quota — non-fatal */
    }
}

export function wasDeepLinkHandled(pathname, hash) {
    if (!hash) return false;
    try {
        return (
            sessionStorage.getItem(deepLinkHandledKey(pathname, hash)) ===
            '1'
        );
    } catch {
        return false;
    }
}

// Adds the `.pm-deep-link-highlight` class to an element, scrolls it
// into view, then fades the highlight out after a short window. Used
// by every "you arrived from a notification / to-do" deep-link effect
// so the visual treatment stays consistent across pages.
//
// Also layers a brief background-dim spotlight (≤1.3s) on top of the
// row highlight so the rest of the page visually steps out of the
// way when the user lands here from a notification — matches the
// task-row treatment in PhasesPlan and keeps the focus signal
// consistent across notes / files / activities deep-links. The
// spotlight respects `prefers-reduced-motion` and auto-dismisses on
// the next click / keypress, so it never gets in the user's way.
//
// `holdMs` is how long the loud highlight stays before we begin the
// fade. `fadeMs` is the fade duration. `spotlight: false` opts out
// of the dim layer if a caller wants only the inline highlight.
// Returns a cleanup function suitable for use as a useEffect return.
export function flashDeepLinkTarget(
    el,
    { holdMs = 2600, fadeMs = 900, spotlight = true } = {},
) {
    if (!el) return () => {};
    el.classList.remove(
        'pm-deep-link-highlight',
        'pm-deep-link-highlight-fadeout',
    );
    // Force a reflow so the keyframe animation restarts when the
    // class is re-added (handled clicking the same notification twice).
    // eslint-disable-next-line no-unused-expressions
    el.offsetWidth;
    el.classList.add('pm-deep-link-highlight');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const cancelSpotlight = spotlight
        ? spotlightElement(el, { duration: 1300, padding: 4, delay: 500 })
        : () => {};

    const startFade = window.setTimeout(() => {
        el.classList.add('pm-deep-link-highlight-fadeout');
    }, holdMs);
    const cleanup = window.setTimeout(() => {
        el.classList.remove(
            'pm-deep-link-highlight',
            'pm-deep-link-highlight-fadeout',
        );
    }, holdMs + fadeMs);
    return () => {
        window.clearTimeout(startFade);
        window.clearTimeout(cleanup);
        cancelSpotlight();
        el.classList.remove(
            'pm-deep-link-highlight',
            'pm-deep-link-highlight-fadeout',
        );
    };
}

export function initials(name) {
    if (!name) return '?';
    return name
        .split(' ')
        .filter(Boolean)
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();
}

const API_URL =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) ||
    'http://localhost:5000';

export function resolveAssetUrl(url) {
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    return `${API_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

// Turns the standard backend error shape into something human-readable
// for a toast. The API returns either `{ error }` for ad-hoc errors or
// `{ error: 'Validation failed', details: { field: ['msg', ...] } }`
// for zod failures — without flattening the details the user only ever
// saw "Validation failed" with no hint as to which field was at fault.
export function formatApiError(err, fallback = 'Request failed') {
    const payload = err?.response?.data;
    if (!payload) return err?.message || fallback;
    const base = payload.error || fallback;
    const details = payload.details;
    if (details && typeof details === 'object') {
        const pieces = [];
        for (const [field, msgs] of Object.entries(details)) {
            if (!msgs) continue;
            const list = Array.isArray(msgs) ? msgs : [msgs];
            const text = list.filter(Boolean).join(', ');
            if (!text) continue;
            pieces.push(`${field}: ${text}`);
        }
        if (pieces.length > 0) {
            return `${base} — ${pieces.join('; ')}`;
        }
    }
    return base;
}

export function formatBytes(bytes) {
    if (bytes === 0 || bytes == null) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Time-based progress: how far between startDate and endDate we are right now.
// Returns 0-100, or null when either date is missing/invalid.
export function timeProgress(startDate, endDate, now = Date.now()) {
    if (!startDate || !endDate) return null;
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
    const ratio = (now - start) / (end - start);
    return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

// Returns Tailwind classes for the time-progress indicator.
//
// Default scale (taskPct unknown): 0-50 % green, 50-80 % amber,
// 80-100 % red.
//
// If `taskPct` is supplied:
//   - taskPct >= 100  → always green, regardless of how late we are.
//     The work is finished; the "we're past the deadline" warning
//     would only be misleading.
//   - taskPct < 100   → fall back to the date-driven scale above so
//     the bar still warns about looming deadlines.
export function timeProgressColorClass(pct, taskPct) {
    if (pct == null) return 'bg-muted-foreground/40';
    if (typeof taskPct === 'number' && taskPct >= 100) return 'bg-emerald-500';
    if (pct < 50) return 'bg-emerald-500';
    if (pct < 80) return 'bg-amber-500';
    return 'bg-red-500';
}

export function timeProgressTextClass(pct, taskPct) {
    if (pct == null) return 'text-muted-foreground';
    if (typeof taskPct === 'number' && taskPct >= 100) return 'text-emerald-600';
    if (pct < 50) return 'text-emerald-600';
    if (pct < 80) return 'text-amber-600';
    return 'text-red-600';
}

// Days remaining until endDate. Negative when overdue.
export function daysUntil(endDate, now = Date.now()) {
    if (!endDate) return null;
    const end = new Date(endDate).getTime();
    if (Number.isNaN(end)) return null;
    return Math.ceil((end - now) / (1000 * 60 * 60 * 24));
}

// Total whole-day span between startDate and endDate. Returns null
// when either is missing/invalid; >= 1 otherwise (inclusive).
export function durationInDays(startDate, endDate) {
    if (!startDate || !endDate) return null;
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
    return Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
}

// Days-left counter that is anchored to the project's lifecycle rather
// than to "now". Use this for the "X days left of Y" caption under the
// time-progress bar so the count matches the total span:
//   - Before the start date  → returns the full duration (the countdown
//                              hasn't begun yet; "90 of 90 days left").
//   - Between start and end  → returns ceil((end - now) / day).
//   - After the end date     → negative (overdue), exactly like
//                              daysUntil.
//
// Falls back to plain daysUntil(endDate) when startDate is missing so
// it stays useful for projects with only an end date set.
export function daysRemainingFromStart(startDate, endDate, now = Date.now()) {
    if (!endDate) return null;
    const end = new Date(endDate).getTime();
    if (Number.isNaN(end)) return null;
    if (!startDate) {
        return Math.ceil((end - now) / (1000 * 60 * 60 * 24));
    }
    const start = new Date(startDate).getTime();
    if (Number.isNaN(start)) {
        return Math.ceil((end - now) / (1000 * 60 * 60 * 24));
    }
    // Treat anything before the start date as "just about to start" so
    // the remaining count never exceeds the total span. Equivalent to
    // clamping now to >= start.
    const effectiveNow = Math.max(now, start);
    return Math.ceil((end - effectiveNow) / (1000 * 60 * 60 * 24));
}

// Compact "23 days left of 80" / "Due today (of 80)" / "5 days overdue
// (of 80)" caption used under the time-progress bar.
//   - `remaining` is from `daysRemainingFromStart(startDate, endDate)`
//     (preferred — anchors the countdown to the project's start so it
//     can't exceed the total span). Falls back to `daysUntil(endDate)`
//     when no start date is configured.
//   - `total` is from `durationInDays(startDate, endDate)`.
// Returns null when there isn't enough information to render anything.
export function timeRemainingLabel(remaining, total) {
    if (remaining == null) return null;
    const ofTotal =
        typeof total === 'number' && total > 0
            ? ` of ${total} day${total === 1 ? '' : 's'}`
            : '';
    if (remaining < 0) {
        const n = Math.abs(remaining);
        return `${n} day${n === 1 ? '' : 's'} overdue${ofTotal}`;
    }
    if (remaining === 0) return `Due today${ofTotal}`;
    return `${remaining} day${remaining === 1 ? '' : 's'} left${ofTotal}`;
}
