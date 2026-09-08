// CSV helpers for export endpoints. Tiny on purpose — we only need a
// RFC-4180-ish writer and a couple of formatters the time-entries
// export uses. Anything more elaborate (multiple sheets, formatting,
// totals row) belongs in the Excel pipeline instead.

// Wraps a single field value in CSV quoting rules:
//   - null / undefined -> empty string
//   - anything containing a comma, quote, CR or LF gets double-quoted
//   - inner double-quotes are escaped by doubling them
// Booleans and numbers are stringified plainly.
function escapeCell(value) {
    if (value === null || value === undefined) return '';
    let str;
    if (value instanceof Date) {
        // Use a sortable, locale-free format. Seconds precision is
        // plenty for time-tracking exports.
        const pad = (n) => String(n).padStart(2, '0');
        str =
            `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(
                value.getDate(),
            )} ${pad(value.getHours())}:${pad(
                value.getMinutes(),
            )}:${pad(value.getSeconds())}`;
    } else if (typeof value === 'object') {
        // Don't accidentally serialise [object Object] into a CSV row;
        // make the caller surface what they actually want.
        str = JSON.stringify(value);
    } else {
        str = String(value);
    }
    if (/[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

// Builds an RFC-4180 CSV string from a list of header keys and row
// objects. We prefix the output with a UTF-8 BOM so Excel / LibreOffice
// open the file as UTF-8 (and not Windows-1252) without prompting —
// matters for users / projects with non-ASCII names.
function buildCsv(headers, rows) {
    const headerLine = headers.map((h) => escapeCell(h.label)).join(',');
    const bodyLines = (rows || []).map((row) =>
        headers.map((h) => escapeCell(row[h.key])).join(','),
    );
    return `\uFEFF${[headerLine, ...bodyLines].join('\r\n')}\r\n`;
}

// Formats a duration in seconds as "Hh Mm" (e.g. "2h 15m" / "45m").
// Used by the time-entries export so the column reads naturally even
// for non-Excel viewers (text editors, terminals, GitHub previews).
function formatDurationHm(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
}

// Decimal hours for the export "Time spent" column: a plain number so
// the value is easy to sum / pivot in a spreadsheet. 1h -> "1",
// 1h 30m -> "1.5", 15m -> "0.25". Rounded to 2 decimals, trailing
// zeros stripped.
function formatDurationHours(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const rounded = Math.round((s / 3600) * 100) / 100;
    return String(rounded);
}

// Build the time-entries CSV. Mirrors the column layout of
// `buildTimeEntriesWorkbook` so users can switch between formats
// without retraining downstream parsers.
// Period = the two-digit calendar month (01..12) that the export mostly
// covers. When the exported range spans two months we attribute it to the
// month holding the most days (e.g. 24 Feb–23 Mar → "03"). Same value on
// every row. `range` carries the requested from/to; if absent we fall back
// to the span of the entries themselves.
function computeExportPeriod(entries, range) {
    const dates = (entries || [])
        .map((e) => (e.startedAt ? new Date(e.startedAt) : null))
        .filter((d) => d && !Number.isNaN(d.getTime()));
    let start = range?.from ? new Date(range.from) : null;
    let end = range?.to ? new Date(range.to) : null;
    if ((!start || Number.isNaN(start.getTime())) && dates.length) {
        start = new Date(Math.min(...dates.map((d) => d.getTime())));
    }
    if ((!end || Number.isNaN(end.getTime())) && dates.length) {
        end = new Date(Math.max(...dates.map((d) => d.getTime())));
    }
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return '';
    }
    if (end < start) [start, end] = [end, start];
    // Tally days per (year, month) across the span, then pick the winner.
    const counts = new Map();
    const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    let guard = 0;
    while (cur <= end && guard++ < 4000) {
        const key = cur.getMonth(); // 0..11 — Period is month-only
        counts.set(key, (counts.get(key) || 0) + 1);
        cur.setDate(cur.getDate() + 1);
    }
    let bestMonth = null;
    let bestDays = -1;
    for (const [m, n] of counts) {
        if (n > bestDays) {
            bestDays = n;
            bestMonth = m;
        }
    }
    if (bestMonth == null) return '';
    return String(bestMonth + 1).padStart(2, '0');
}

// The full catalogue of columns the time-entries export can produce, in
// the default order. The export dialog lets the user pick a subset and
// reorder them; the frontend fetches this list from
// GET /api/exports/time/columns so the labels never drift from here.
const TIME_EXPORT_COLUMNS = [
    { key: 'period', label: 'Period' },
    { key: 'user', label: 'User' },
    { key: 'employeeCode', label: 'Employee code' },
    { key: 'entityCode', label: 'Entity code' },
    { key: 'entityDescription', label: 'Entity description' },
    { key: 'productCode', label: 'Product code' },
    { key: 'product', label: 'Product' },
    { key: 'projectType', label: 'Project type' },
    { key: 'activityCode', label: 'Activity code' },
    { key: 'crmId', label: 'CRM ID' },
    { key: 'project', label: 'Project' },
    { key: 'date', label: 'Date' },
    { key: 'duration', label: 'Time spent (h)' },
    { key: 'task', label: 'Task' },
    { key: 'note', label: 'Log comment' },
    { key: 'crossReason', label: 'Logged-for reason' },
    { key: 'crossReasonNote', label: 'Logged-for note' },
    { key: 'codes', label: 'IDs (Project / Task / Subtask)' },
    { key: 'ticket', label: 'Ticket' },
];

// Human labels for the "logged on someone else's task" reason codes.
// Kept in sync with backend routes/time.js CROSS_USER_REASONS and the
// frontend lib/timeReason.js.
const CROSS_USER_REASON_LABELS = {
    HELPING: 'Helping',
    PARTICIPATING: 'Participating',
    COVERING: 'Covering',
    CORRECTING: 'Correcting',
    OTHER: 'Other',
};

// `options.fields` (optional) is an ordered list of column keys the
// caller wants; unknown keys are ignored and, if nothing valid is
// given, we fall back to the full default set/order.
function buildTimeEntriesCsv(entries, range, options = {}) {
    const period = computeExportPeriod(entries, range);
    const byKey = new Map(TIME_EXPORT_COLUMNS.map((c) => [c.key, c]));
    const requested = Array.isArray(options.fields)
        ? options.fields.map((k) => byKey.get(k)).filter(Boolean)
        : null;
    const headers = requested && requested.length ? requested : TIME_EXPORT_COLUMNS;

    const rows = (entries || []).map((entry) => {
        const project = entry.project || {};
        const task = entry.task || null;
        const parent = task?.parent || null;

        // Mirror entries (time logged on a personal project that is
        // linked to a shared project) arrive here with `task == null`
        // because the mirror row itself is project-level on the
        // shared project. Surface the personal-project context
        // inline so the Task column reads
        //     "P26-SER-006 Personal proj → T-001 personal task title"
        // instead of an opaque "Project-level". The "Log comment"
        // column already carries the description (we copy it from
        // the source on create), so a reviewer sees both the
        // origin AND what the user noted, side by side.
        const sourceEntry = entry.sourceEntry || null;
        const personalProj = entry.fromPersonalProject || null;
        const sourceTask = sourceEntry?.task || null;
        const sourceParent = sourceTask?.parent || null;

        let taskLabel;
        if (task && parent) {
            taskLabel = `${parent.title} → ${task.title}`;
        } else if (task) {
            taskLabel = task.title || '';
        } else if (personalProj) {
            const personalProjLabel = personalProj.code
                ? `${personalProj.code} ${personalProj.name}`
                : personalProj.name;
            if (sourceTask && sourceParent) {
                const parentLabel = sourceParent.code
                    ? `${sourceParent.code} ${sourceParent.title}`
                    : sourceParent.title;
                const childLabel = sourceTask.code
                    ? `${sourceTask.code} ${sourceTask.title}`
                    : sourceTask.title;
                taskLabel = `${personalProjLabel} → ${parentLabel} → ${childLabel}`;
            } else if (sourceTask) {
                const childLabel = sourceTask.code
                    ? `${sourceTask.code} ${sourceTask.title}`
                    : sourceTask.title;
                taskLabel = `${personalProjLabel} → ${childLabel}`;
            } else {
                taskLabel = `${personalProjLabel} (project-level)`;
            }
        } else {
            taskLabel = 'Project-level';
        }

        // Code trail. For mirror entries we also append the personal
        // project / task codes so the "IDs" column lines up with the
        // Task column above.
        const codes = [];
        if (project.code) codes.push(project.code);
        if (task && parent && parent.code) codes.push(parent.code);
        if (task && task.code) codes.push(task.code);
        if (!task && personalProj?.code) codes.push(personalProj.code);
        if (!task && sourceParent?.code) codes.push(sourceParent.code);
        if (!task && sourceTask?.code) codes.push(sourceTask.code);

        const user = entry.user || {};
        return {
            period,
            user: user.name || user.email || '',
            employeeCode: user.employeeCode || '',
            entityCode: project.entity?.code || '',
            entityDescription: project.entity?.description || '',
            // Fall back to explicit placeholders so blank cells don't get
            // lost when the export is filtered / pivoted.
            productCode: project.product?.code || 'NO_PRODUCT',
            product: project.product?.name || 'NO PRODUCT',
            projectType: project.projectType?.name || '',
            activityCode: project.projectType?.activityCode || '',
            crmId: project.crmId || 'NO_PROJECT',
            project: project.name || '',
            date: entry.startedAt ? new Date(entry.startedAt) : '',
            duration: formatDurationHours(entry.durationSeconds),
            task: taskLabel,
            note: entry.description || '',
            crossReason:
                CROSS_USER_REASON_LABELS[entry.crossUserReason] ||
                (entry.crossUserReason ? String(entry.crossUserReason) : ''),
            crossReasonNote: entry.crossUserNote || '',
            codes: codes.join(' / '),
            // The help-desk ticket this work traces back to, if the task
            // was created from a ticket (or the mirror's source task was).
            ticket:
                task?.sourceTicket?.code ||
                sourceTask?.sourceTicket?.code ||
                '',
        };
    });

    return buildCsv(headers, rows);
}

module.exports = {
    buildCsv,
    buildTimeEntriesCsv,
    TIME_EXPORT_COLUMNS,
    formatDurationHm,
    escapeCell,
};
