// Shared, framework-free ticket display helpers: labels, colours, date
// formatting, timeline-event wording and grouping of the custom fields
// captured on a ticket. Used by the ticket workspace (list + detail modal).

// Selectable statuses (Open retired — legacy OPEN tickets still render,
// they just can't be set again) and priorities.
export const STATUSES = ['NEW', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED'];
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

// Human label for a status enum (handles IN_PROGRESS → "In progress").
export const statusLabel = (s) =>
    s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : s;

export const titleCase = (s) =>
    s ? s.charAt(0) + s.slice(1).toLowerCase() : s;

// "Jun 18, 14:05" — compact, for timelines.
export function fmtDateTime(value) {
    if (!value) return '';
    try {
        return new Date(value).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return '';
    }
}

// "Oct 1, 2023, 01:21 PM" — with the year, for headers and message cards.
export function fmtDateTimeLong(value) {
    if (!value) return '';
    try {
        return new Date(value).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return '';
    }
}

export function fmtDate(value) {
    if (!value) return '';
    try {
        return new Date(value).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    } catch {
        return '';
    }
}

// 5400 → "1h 30m", 900 → "15m", 0 → "0m".
export function fmtSeconds(sec) {
    const mins = Math.round((Number(sec) || 0) / 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
}

// ---------------------------------------------------------------------
// Auto-close: a resolved ticket can close by itself N days later. The
// resolver's last choice is remembered per browser ('off' = don't).
// Limits mirror the server (backend/src/lib/ticketAutoClose.js).
// ---------------------------------------------------------------------
export const AUTO_CLOSE_DEFAULT_DAYS = 2;
export const MAX_AUTO_CLOSE_DAYS = 90;
const AUTO_CLOSE_KEY = 'pm.ticket.autoCloseDays.v1';
const DAY_MS = 24 * 60 * 60 * 1000;

export function readAutoCloseDays() {
    try {
        const v = localStorage.getItem(AUTO_CLOSE_KEY);
        if (v === 'off') return null;
        const n = parseInt(v, 10);
        if (n >= 1 && n <= MAX_AUTO_CLOSE_DAYS) return n;
    } catch {
        /* storage disabled */
    }
    return AUTO_CLOSE_DEFAULT_DAYS;
}

export function rememberAutoCloseDays(days) {
    try {
        localStorage.setItem(AUTO_CLOSE_KEY, days ? String(days) : 'off');
    } catch {
        /* storage disabled — still works for this ticket */
    }
}

export const daysLabel = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;

// When a timer started now would fire.
export const autoCloseFromNow = (days, now = Date.now()) =>
    new Date(now + days * DAY_MS);

// "in 2 days" / "in 5 hours" / "in 40 min" / "any minute now".
export function fmtCountdown(at, now = Date.now()) {
    const ms = new Date(at).getTime() - now;
    if (!Number.isFinite(ms) || ms <= 60 * 1000) return 'any minute now';
    const min = Math.round(ms / 60000);
    if (min < 60) return `in ${min} min`;
    const h = Math.round(ms / 3600000);
    if (h < 36) return `in ${h} ${h === 1 ? 'hour' : 'hours'}`;
    const d = Math.round(ms / DAY_MS);
    return `in ${daysLabel(d)}`;
}

// Compact version for cards: "2d" / "5h" / "40m" / "soon".
export function fmtCountdownShort(at, now = Date.now()) {
    const ms = new Date(at).getTime() - now;
    if (!Number.isFinite(ms) || ms <= 60 * 1000) return 'soon';
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    if (ms < 36 * 3600000) return `${Math.round(ms / 3600000)}h`;
    return `${Math.round(ms / DAY_MS)}d`;
}

export const STATUS_BADGE = {
    NEW: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30',
    OPEN: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30',
    IN_PROGRESS:
        'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/30',
    PENDING:
        'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
    RESOLVED:
        'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    CLOSED: 'bg-muted text-muted-foreground border-border',
};

// Solid dot per status (status select + lists).
export const STATUS_DOT = {
    NEW: 'bg-sky-500',
    OPEN: 'bg-blue-500',
    IN_PROGRESS: 'bg-indigo-500',
    PENDING: 'bg-amber-500',
    RESOLVED: 'bg-emerald-500',
    CLOSED: 'bg-slate-400',
};

// Soft tint behind the status select trigger.
export const STATUS_TINT = {
    NEW: 'border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-200',
    OPEN: 'border-blue-500/30 bg-blue-500/10 text-blue-800 dark:text-blue-200',
    IN_PROGRESS:
        'border-indigo-500/30 bg-indigo-500/10 text-indigo-800 dark:text-indigo-200',
    PENDING:
        'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200',
    RESOLVED:
        'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
    CLOSED: 'border-border bg-muted text-muted-foreground',
};

// A timeline event as display segments: plain strings plus { pill } values
// that render as small value chips — e.g.
//   ['Status changed from ', { pill: 'Open' }, ' to ', { pill: 'New' }].
// ASSIGNED stores the previous assignee's NAME in fromValue and the new
// assignee's ID in toValue (see routes/tickets.js), hence `nameById`.
// Returns null for kinds we don't show.
export function eventSegments(e, nameById) {
    const pill = (v) => ({ pill: v });
    switch (e?.kind) {
        case 'CREATED':
            return ['Ticket opened'];
        case 'STATUS_CHANGED':
            return e.fromValue
                ? [
                      'Status changed from ',
                      pill(statusLabel(e.fromValue)),
                      ' to ',
                      pill(statusLabel(e.toValue)),
                  ]
                : ['Status set to ', pill(statusLabel(e.toValue))];
        case 'REOPENED':
            return e.toValue
                ? ['Ticket reopened as ', pill(statusLabel(e.toValue))]
                : ['Ticket reopened'];
        case 'PRIORITY_CHANGED':
            return [
                'Priority changed from ',
                pill(titleCase(e.fromValue) || '—'),
                ' to ',
                pill(titleCase(e.toValue) || '—'),
            ];
        case 'ASSIGNED': {
            const to = nameById?.get?.(e.toValue) || 'someone';
            return e.fromValue
                ? ['Reassigned from ', pill(e.fromValue), ' to ', pill(to)]
                : ['Assigned to ', pill(to)];
        }
        case 'UNASSIGNED':
            return e.fromValue
                ? ['Unassigned from ', pill(e.fromValue)]
                : ['Unassigned'];
        case 'AUTO_CLOSED': {
            // fromValue = how many days it waited in Resolved.
            const n = parseInt(e.fromValue, 10);
            return n > 0
                ? ['Closed automatically ', pill(daysLabel(n)), ' after it was resolved']
                : ['Closed automatically after it was resolved'];
        }
        default:
            return null;
    }
}

// Plain-text version of eventSegments (tooltips, copy).
export function eventText(e, nameById) {
    const segs = eventSegments(e, nameById);
    if (!segs) return null;
    return segs.map((s) => (typeof s === 'string' ? s : s.pill)).join('');
}

// ---------------------------------------------------------------------
// Captured details → the modal's "Client & Terminal" / "Contact" /
// "Other details" cards. Custom fields are admin-defined, so we sort them
// by label: contact-ish labels go to Contact, terminal-ish ones (TIDs,
// serials, host, device…) next to the client and terminal model.
// ---------------------------------------------------------------------

const OS_LABEL = { LINUX: 'Linux', ANDROID: 'Android' };
const CONTACT_LABEL =
    /contact|kontakt|phone|telefon|\btel\b|mobile|mobil|e-?mail|person|osoba/i;
const PHONE_LABEL = /phone|telefon|\btel\b|mobile|mobil/i;
const EMAIL_LABEL = /e-?mail/i;
const TERMINAL_LABEL =
    /tid\b|terminal|serial|s\/n|\bsn\b|imei|\bmid\b|merchant|host|\bpos\b|device|ure[đd]aj|model/i;
const ID_LABEL = /tid\b|serial|s\/n|\bsn\b|imei|\bmid\b/i;

export function fieldValueText(fv) {
    const v = fv?.value;
    if (Array.isArray(v)) return v.filter(Boolean).join(', ');
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (v == null) return '';
    return String(v).trim();
}

// Inside the Contact card "Contact phone" reads better as "Phone", and a
// bare "Contact" / "Contact person" is the person's name.
function contactLabel(label) {
    const rest = label.replace(/^(contact|kontakt)\b\s*[-:]?\s*/i, '').trim();
    if (!rest || /^(person|osoba|name|ime)$/i.test(rest)) return 'Name';
    return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export function groupTicketFields(ticket) {
    const terminal = [];
    const contact = [];
    const other = [];
    if (ticket?.client?.name) {
        terminal.push({
            key: 'client',
            label: 'Client',
            value: ticket.client.name,
            kind: 'client',
            copy: true,
        });
    }
    if (ticket?.terminalModel) {
        const tm = ticket.terminalModel;
        const os = OS_LABEL[tm.osType] || tm.osType;
        const name = [tm.vendor?.name, tm.name].filter(Boolean).join(' ');
        terminal.push({
            key: 'terminal',
            label: 'Terminal',
            value: name + (os ? ` - ${os}` : ''),
            kind: 'terminal',
            copy: true,
        });
    }
    for (const fv of Array.isArray(ticket?.fieldValues) ? ticket.fieldValues : []) {
        const value = fieldValueText(fv);
        if (!value) continue;
        const label = String(fv.label || 'Field').trim();
        const key = fv.fieldId || label;
        if (CONTACT_LABEL.test(label)) {
            contact.push({
                key,
                label: contactLabel(label),
                value,
                kind: PHONE_LABEL.test(label)
                    ? 'phone'
                    : EMAIL_LABEL.test(label)
                      ? 'email'
                      : 'person',
                copy: true,
            });
        } else if (TERMINAL_LABEL.test(label)) {
            terminal.push({
                key,
                label,
                value,
                kind: /host/i.test(label)
                    ? 'host'
                    : ID_LABEL.test(label)
                      ? 'barcode'
                      : 'device',
                copy: true,
            });
        } else {
            other.push({
                key,
                label,
                value,
                kind:
                    fv.type === 'YESNO'
                        ? 'yesno'
                        : fv.type === 'SELECT'
                          ? 'select'
                          : 'text',
                copy: fv.type === 'TEXT',
            });
        }
    }
    return { terminal, contact, other };
}

export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// What to seed a rich-text editor with: stored HTML as-is; a legacy
// plain-text description escaped, keeping its line breaks.
export function toEditorHtml(value) {
    if (!value) return '';
    const s = String(value);
    if (/<\/?[a-z][^>]*>/i.test(s)) return s;
    return escapeHtml(s).replace(/\n/g, '<br>');
}

// Plain text of a stored message body (for "Copy text" / quoting).
export function htmlToText(html) {
    if (!html) return '';
    if (typeof DOMParser === 'undefined') {
        return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    doc.querySelectorAll('p,div,li,h1,h2,h3,blockquote').forEach((el) =>
        el.append('\n'),
    );
    return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}
