// Imperative "spotlight on this element" helper.
// ─────────────────────────────────────────────────────────────────
// Dims the whole viewport with a translucent black overlay while
// leaving a transparent cut-out over a target element, so a user who
// just clicked a notification (or any other deep-link) cannot miss
// what they were sent to look at. Designed to coexist with the
// existing in-row pulse animation (`task-pulse` class) — the pulse
// drives "this is the one" colour emphasis, the spotlight drives
// "ignore everything else" focus. Together they make notification
// targeting feel deliberate without being annoying.
//
// Effect:
//   - A fixed-position overlay is positioned exactly over the target
//     element's bounding rect (with a small padding so the row
//     "breathes" visually).
//   - A massive `box-shadow` extends from the overlay in every
//     direction, painting the rest of the viewport translucent dark
//     — Chrome / Firefox both clip box-shadows at the visible viewport
//     so we don't need a separate full-screen overlay element.
//   - The overlay itself has `pointer-events: none` so the target
//     element stays interactive.
//   - Auto-dismisses after `duration` ms (default 1300) or on the
//     next click / keypress, whichever comes first.
//   - Repositions on scroll and resize during its lifetime so the
//     dim stays glued to the target if the page shifts.
//
// Returns a cancel function the caller can use to dismiss early.
//
// Respects `prefers-reduced-motion` — if the user has the OS toggle
// on, we skip the spotlight entirely (the existing pulse already
// flags the target without animation that fills the viewport).

export function spotlightElement(target, opts = {}) {
    // Reduced-motion bail-out: any large viewport change can be
    // disorienting for users who chose this setting. The in-row
    // pulse keeps working — they just don't get the dim layer.
    if (
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
        return () => {};
    }

    const el =
        typeof target === 'string'
            ? document.getElementById(target)
            : target;
    if (!el) return () => {};

    const duration = opts.duration ?? 1300;
    const padding = opts.padding ?? 10;
    const radius = opts.radius ?? 10;
    // Default delay leaves room for the caller's
    // `scrollIntoView({ behavior: 'smooth' })` to settle so the
    // bounding rect we capture is the post-scroll position, not
    // wherever the row was before scrolling.
    const delay = opts.delay ?? 360;

    let mounted = false;
    let dismissed = false;
    let overlay = null;
    let autoTimer = null;
    let armTimer = null;
    let armed = false;

    const reposition = () => {
        if (!overlay) return;
        const r = el.getBoundingClientRect();
        overlay.style.left = `${r.left - padding}px`;
        overlay.style.top = `${r.top - padding}px`;
        overlay.style.width = `${r.width + padding * 2}px`;
        overlay.style.height = `${r.height + padding * 2}px`;
    };

    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        clearTimeout(autoTimer);
        clearTimeout(armTimer);
        if (overlay) {
            overlay.style.opacity = '0';
            const removed = overlay;
            // Match the CSS transition duration so the fade-out
            // completes before we yank the node out of the DOM.
            setTimeout(() => removed.remove(), 260);
        }
        window.removeEventListener('scroll', reposition, true);
        window.removeEventListener('resize', reposition);
        document.removeEventListener('click', onEarlyDismiss, true);
        document.removeEventListener('keydown', onEarlyDismiss, true);
    };

    // Only count clicks / keys AFTER the spotlight has been visible
    // long enough that the user could plausibly have seen it. Without
    // this guard, the very same click that triggered the navigation
    // (or a held-over keypress) would dismiss the spotlight before
    // the user notices it.
    const onEarlyDismiss = () => {
        if (armed) dismiss();
    };

    const mount = () => {
        if (mounted || dismissed) return;
        mounted = true;
        overlay = document.createElement('div');
        overlay.setAttribute('data-spotlight', '');
        // All styles inlined so the helper has zero CSS dependencies
        // — works on any page without requiring a stylesheet import.
        overlay.style.cssText = [
            'position: fixed',
            `border-radius: ${radius}px`,
            // The huge box-shadow IS the dim layer. `rgba(15,23,42,0.55)`
            // is a slightly cooler dark (slate-900-ish) than pure black
            // so it reads as "dimmed UI" rather than "modal scrim".
            'box-shadow: 0 0 0 9999px rgba(15,23,42,0.55)',
            'pointer-events: none',
            'z-index: 9998',
            'opacity: 0',
            'transition: opacity 240ms ease-out',
        ].join(';');
        document.body.appendChild(overlay);
        reposition();
        // Fade in on the next frame so the browser commits the
        // initial `opacity: 0` styles before transitioning.
        requestAnimationFrame(() => {
            if (overlay && !dismissed) overlay.style.opacity = '1';
        });
        window.addEventListener('scroll', reposition, {
            passive: true,
            capture: true,
        });
        window.addEventListener('resize', reposition);
        document.addEventListener('click', onEarlyDismiss, true);
        document.addEventListener('keydown', onEarlyDismiss, true);
        // Arm early-dismiss after 250ms so the originating click /
        // keypress (Enter on a notification row) doesn't immediately
        // dismiss what it just opened.
        armTimer = setTimeout(() => {
            armed = true;
        }, 250);
        autoTimer = setTimeout(dismiss, duration);
    };

    const scrollWait = setTimeout(mount, delay);

    // Cancel function: dismisses immediately whether or not the
    // overlay has mounted yet.
    return () => {
        clearTimeout(scrollWait);
        dismiss();
    };
}
