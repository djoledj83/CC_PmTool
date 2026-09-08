// Tiny duration / clock helpers shared by every time-tracking surface.
// Keeping them in one place so the pill in the TopBar, the project
// card, and the (future) timesheet page all format the same way.

// Render a duration in seconds as "Xh Ym" / "Ym Zs" / "Zs". Used when
// the value is "elapsed time" rather than a clock time. Always fits
// in two segments so it stays compact in pills and chips.
export function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

// Same as formatDuration but always renders with hours and minutes,
// padding to 2 digits. Used inside the running-timer pill so the
// number doesn't visually jitter every second.
export function formatTickerHM(totalSeconds) {
    const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }
    return `${m}:${String(sec).padStart(2, '0')}`;
}

// Render a decimal-hours value (e.g. 12.5) as "Xh Ym" so the user
// sees the same units they typed when logging time. Specifically
// avoids "12.5h" because that reads like a fractional 30-second
// number, when it actually means 12h 30m. Used for KPI cards and
// estimates on the sprint board / capacity heatmap.
//
// Behaviour:
//   - 0           -> "0h"
//   - 1.5         -> "1h 30m"
//   - 7           -> "7h"
//   - 0.25        -> "15m"
//   - 0.05        -> "3m"
//   - undefined / NaN / negative -> "0h"
//
// We round to the nearest minute on the way in so floating-point noise
// (e.g. 1.4999999999) doesn't render as "1h 29m" when the user meant
// "1h 30m".
export function formatHoursAsHM(hoursValue) {
    const h = Number(hoursValue);
    if (!Number.isFinite(h) || h <= 0) return '0h';
    const totalMinutes = Math.round(h * 60);
    const hh = Math.floor(totalMinutes / 60);
    const mm = totalMinutes % 60;
    if (hh === 0) return `${mm}m`;
    if (mm === 0) return `${hh}h`;
    return `${hh}h ${mm}m`;
}

// Number of seconds elapsed between `startedAt` and now. Returns 0 if
// `startedAt` is missing / invalid so the UI never renders NaN.
export function elapsedSecondsSince(startedAt) {
    if (!startedAt) return 0;
    const start = new Date(startedAt).getTime();
    if (Number.isNaN(start)) return 0;
    return Math.max(0, Math.floor((Date.now() - start) / 1000));
}
