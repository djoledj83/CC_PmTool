// Excel export utilities. We use exceljs for fine-grained styling and
// streaming-friendly output. Each builder returns a Workbook ready to be
// written to a response stream.

const ExcelJS = require('exceljs');

const APP_NAME = process.env.APP_NAME || 'PM Tool';

// ---------- shared helpers ----------

const STATUS_LABELS = {
    TODO: 'To do',
    IN_PROGRESS: 'In progress',
    DONE: 'Done',
    ON_HOLD: 'On hold',
};

const PRIORITY_LABELS = {
    LOW: 'Low',
    MEDIUM: 'Medium',
    HIGH: 'High',
    URGENT: 'Urgent',
};

const TASK_STATUS_LABELS = {
    TODO: 'To do',
    IN_PROGRESS: 'In progress',
    DONE: 'Done',
};

const TASK_PRIORITY_LABELS = {
    LOW: 'Low',
    MEDIUM: 'Medium',
    HIGH: 'High',
};

// User-facing names for the new ProjectActivity entity (Meeting / Call /
// Reminder / Comment / Document / Other). Mirrors the labels used in
// the frontend `ACTIVITY_KINDS` palette.
const ACTIVITY_KIND_LABELS = {
    CALL: 'Call',
    MEETING: 'Meeting',
    REMINDER: 'Reminder',
    COMMENT: 'Comment',
    DOCUMENT: 'Document',
    OTHER: 'Other',
};

function activityKindLabel(k) {
    return ACTIVITY_KIND_LABELS[k] || k || '';
}

function statusLabel(s) {
    return STATUS_LABELS[s] || s || '';
}
function priorityLabel(p) {
    return PRIORITY_LABELS[p] || p || '';
}
function taskStatusLabel(s) {
    return TASK_STATUS_LABELS[s] || s || '';
}
function taskPriorityLabel(p) {
    return TASK_PRIORITY_LABELS[p] || p || '';
}

function toDate(d) {
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(d);
    return Number.isNaN(date.getTime()) ? null : date;
}

function userLabel(user) {
    if (!user) return '';
    return user.name || user.email || user.id || '';
}

function bytesHuman(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    const kb = n / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(1)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
}

function moneyAmount(n) {
    if (n == null) return null;
    const num = typeof n === 'number' ? n : Number(n);
    return Number.isFinite(num) ? num : null;
}

// Apply a uniform header style and freeze the first row. Also sets sensible
// default widths based on the column metadata.
function styleHeader(sheet, columns) {
    sheet.columns = columns.map((c) => ({
        header: c.header,
        key: c.key,
        width: c.width || 18,
    }));
    const header = sheet.getRow(1);
    header.height = 22;
    header.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF1F2937' }, // slate-800
        };
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
        cell.border = {
            bottom: { style: 'thin', color: { argb: 'FF111827' } },
        };
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

// Stripe rows lightly so wide tables stay readable.
function applyZebra(sheet, startRow = 2) {
    const lastRow = sheet.lastRow ? sheet.lastRow.number : startRow;
    for (let r = startRow; r <= lastRow; r += 1) {
        if ((r - startRow) % 2 === 1) {
            sheet.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
                cell.fill = {
                    type: 'pattern',
                    pattern: 'solid',
                    fgColor: { argb: 'FFF8FAFC' }, // slate-50
                };
            });
        }
    }
}

function setBookMeta(workbook, subject) {
    workbook.creator = APP_NAME;
    workbook.created = new Date();
    workbook.subject = subject;
}

// ---------- single-project workbook ----------

// Builds an "Overview / Phases & Tasks / Notes / Files / Participants"
// workbook for one project. The project payload is expected to come pre-loaded
// with the relations referenced below (see exports route).
function buildProjectWorkbook(project, options = {}) {
    const includePrices = Boolean(options.includePrices);
    const workbook = new ExcelJS.Workbook();
    setBookMeta(workbook, `Project export: ${project.name}`);

    overviewSheet(workbook, project, { includePrices });
    plansSheet(workbook, project);
    activitiesSheet(workbook, project);
    approvalsSheet(workbook, project);
    notesSheet(workbook, project);
    filesSheet(workbook, project);
    participantsSheet(workbook, project);
    if (includePrices) {
        billingSheet(workbook, [project]);
    }

    return workbook;
}

// Human labels for the specific-task approval lifecycle events.
const APPROVAL_ACTION_LABEL = {
    TASK_APPROVED: 'Approved',
    TASK_DISAPPROVED: 'Disapproved',
    TASK_APPROVAL_REQUESTED: 'Re-requested',
};

// Audit trail of specific-task approvals / disapprovals / re-requests.
// Only rendered when the project has at least one such event so we don't
// litter every workbook with an empty sheet.
function approvalsSheet(workbook, project) {
    const events = (project.events || []).filter(
        (e) => APPROVAL_ACTION_LABEL[e.type],
    );
    if (events.length === 0) return null;

    // Resolve task codes from the tasks already loaded on the project so
    // each row can show the friendly "T-0042" alongside the title.
    const codeByTaskId = new Map(
        (project.tasks || []).map((t) => [t.id, t.code]),
    );

    const sheet = workbook.addWorksheet('Approvals');
    styleHeader(sheet, [
        { header: 'Task code', key: 'code', width: 14 },
        { header: 'Task', key: 'task', width: 40 },
        { header: 'Action', key: 'action', width: 14 },
        { header: 'By', key: 'actor', width: 24 },
        { header: 'When', key: 'when', width: 18 },
        { header: 'Reason', key: 'reason', width: 60 },
    ]);

    for (const e of events) {
        const row = sheet.addRow({
            code: codeByTaskId.get(e.taskId) || '',
            task: e.message || '',
            action: APPROVAL_ACTION_LABEL[e.type],
            actor: userLabel(e.actor),
            when: toDate(e.createdAt),
            reason:
                (e.meta && typeof e.meta === 'object' && e.meta.reason) || '',
        });
        row.getCell('when').numFmt = 'yyyy-mm-dd hh:mm';
        row.alignment = { vertical: 'top', wrapText: true };
    }
    applyZebra(sheet);
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: 6 },
    };
    return sheet;
}

function overviewSheet(workbook, project, options = {}) {
    const includePrices = Boolean(options.includePrices);
    const sheet = workbook.addWorksheet('Overview', {
        properties: { defaultColWidth: 24 },
    });

    // Two-column "label / value" layout — easier to read than a wide row.
    sheet.columns = [
        { width: 24 },
        { width: 60 },
    ];

    const title = sheet.addRow([project.name]);
    title.font = { bold: true, size: 16 };
    sheet.mergeCells(title.number, 1, title.number, 2);

    if (project.description) {
        const desc = sheet.addRow([project.description]);
        desc.alignment = { wrapText: true };
        desc.font = { italic: true, color: { argb: 'FF475569' } };
        sheet.mergeCells(desc.number, 1, desc.number, 2);
    }

    sheet.addRow([]);

    const fields = [
        ['Status', statusLabel(project.status)],
        ['Priority', priorityLabel(project.priority)],
        ['Owner', userLabel(project.owner)],
        ['Reporter', userLabel(project.reporter)],
        ['Country', project.country || ''],
        ['Client', project.client || ''],
        ['CRM ID', project.crmId || ''],
        ['Label', project.label || ''],
        ['Start date', toDate(project.startDate)],
        ['End date', toDate(project.endDate)],
        ['Created', toDate(project.createdAt)],
        ['Last updated', toDate(project.updatedAt)],
        ['Status changed', toDate(project.statusChangedAt)],
        ['Status updated', toDate(project.statusUpdatedAt)],
        ['Closed / archived', toDate(project.closedAt)],
    ];

    for (const [label, value] of fields) {
        const row = sheet.addRow([label, value]);
        row.getCell(1).font = { bold: true, color: { argb: 'FF334155' } };
        row.getCell(1).alignment = { vertical: 'middle' };
        if (value instanceof Date) {
            row.getCell(2).numFmt = 'yyyy-mm-dd hh:mm';
        }
    }

    sheet.addRow([]);

    // Task / note / file summary so the overview tells the whole story.
    const totals = sheet.addRow(['Counts']);
    totals.font = { bold: true, size: 12 };
    sheet.mergeCells(totals.number, 1, totals.number, 2);

    const tasks = project.tasks || [];
    const topTasks = tasks.filter((t) => !t.parentTaskId);
    const subtasks = tasks.filter((t) => t.parentTaskId);
    const doneTasks = tasks.filter((t) => t.status === 'DONE').length;

    const activities = project.activities || [];
    const doneActivities = activities.filter((a) => a.done).length;

    const counts = [
        ['Phases', (project.phases || []).length],
        ['Tasks (total)', tasks.length],
        ['  · top-level', topTasks.length],
        ['  · subtasks', subtasks.length],
        ['  · done', doneTasks],
        ['Activities (total)', activities.length],
        ['  · completed', doneActivities],
        ['Notes', (project.notes || []).length],
        ['Files', (project.files || []).length],
        ['Participants', (project.participants || []).length],
    ];

    for (const [label, value] of counts) {
        const row = sheet.addRow([label, value]);
        row.getCell(1).font = { color: { argb: 'FF334155' } };
    }

    if (includePrices) {
        sheet.addRow([]);
        const billingHeader = sheet.addRow(['Billing']);
        billingHeader.font = { bold: true, size: 12 };
        sheet.mergeCells(billingHeader.number, 1, billingHeader.number, 2);

        const billingRows = [
            [
                'Internal settlement',
                moneyAmount(project.internalAmount),
                project.internalCurrency || 'EUR',
            ],
            ['Internal paid', project.internalPaid ? 'Yes' : 'No'],
            ['Internal paid at', toDate(project.internalPaidAt)],
            [
                'Client price',
                moneyAmount(project.clientAmount),
                project.clientCurrency || 'EUR',
            ],
            ['Client paid', project.clientPaid ? 'Yes' : 'No'],
            ['Client paid at', toDate(project.clientPaidAt)],
            ['Billing notes', project.billingNotes || ''],
        ];

        for (const cells of billingRows) {
            const [label, value, currency] = cells;
            const row = sheet.addRow([
                label,
                value,
                currency || '',
            ]);
            row.getCell(1).font = { bold: true, color: { argb: 'FF334155' } };
            if (typeof value === 'number') {
                row.getCell(2).numFmt = '#,##0.00';
            }
            if (value instanceof Date) {
                row.getCell(2).numFmt = 'yyyy-mm-dd hh:mm';
            }
        }
    }

    return sheet;
}

function plansSheet(workbook, project) {
    const sheet = workbook.addWorksheet('Phases & Tasks');

    styleHeader(sheet, [
        { header: 'Phase', key: 'phase', width: 22 },
        { header: 'Type', key: 'type', width: 10 },
        { header: 'Title', key: 'title', width: 42 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Priority', key: 'priority', width: 12 },
        { header: 'Assignee', key: 'assignee', width: 22 },
        { header: 'Due date', key: 'dueDate', width: 14 },
        { header: 'Created', key: 'createdAt', width: 18 },
        { header: 'Updated', key: 'updatedAt', width: 18 },
        { header: 'Description', key: 'description', width: 50 },
    ]);

    // Group tasks by phase, walking subtasks immediately after their parent
    // so the workbook reads top-to-bottom in the same order as the plan view.
    const tasks = project.tasks || [];
    const subsByParent = new Map();
    for (const t of tasks) {
        if (t.parentTaskId) {
            if (!subsByParent.has(t.parentTaskId))
                subsByParent.set(t.parentTaskId, []);
            subsByParent.get(t.parentTaskId).push(t);
        }
    }

    const writeTask = (task, type) => {
        const row = sheet.addRow({
            phase: task.phase?.name || (task.phaseId ? '' : 'Unphased'),
            type,
            title: type === 'Subtask' ? `    ↳ ${task.title}` : task.title,
            status: taskStatusLabel(task.status),
            priority: taskPriorityLabel(task.priority),
            assignee: userLabel(task.assignee),
            dueDate: toDate(task.dueDate),
            createdAt: toDate(task.createdAt),
            updatedAt: toDate(task.updatedAt),
            description: task.description || '',
        });
        row.getCell('dueDate').numFmt = 'yyyy-mm-dd';
        row.getCell('createdAt').numFmt = 'yyyy-mm-dd hh:mm';
        row.getCell('updatedAt').numFmt = 'yyyy-mm-dd hh:mm';
        row.alignment = { vertical: 'top', wrapText: true };
        if (type === 'Subtask') {
            row.font = { color: { argb: 'FF475569' } };
        }
    };

    const phases = project.phases || [];
    const tasksByPhase = new Map();
    for (const t of tasks) {
        if (t.parentTaskId) continue; // skip subtasks at top level
        const key = t.phaseId || '__nophase';
        if (!tasksByPhase.has(key)) tasksByPhase.set(key, []);
        tasksByPhase.get(key).push(t);
    }

    for (const phase of phases) {
        const phaseTasks = tasksByPhase.get(phase.id) || [];
        for (const task of phaseTasks) {
            writeTask(task, 'Task');
            for (const sub of subsByParent.get(task.id) || []) {
                writeTask(sub, 'Subtask');
            }
        }
    }
    const unphased = tasksByPhase.get('__nophase') || [];
    for (const task of unphased) {
        writeTask(task, 'Task');
        for (const sub of subsByParent.get(task.id) || []) {
            writeTask(sub, 'Subtask');
        }
    }

    applyZebra(sheet);
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: 10 },
    };

    return sheet;
}

function activitiesSheet(workbook, project) {
    const sheet = workbook.addWorksheet('Activities');
    styleHeader(sheet, [
        { header: 'Phase', key: 'phase', width: 20 },
        { header: 'Kind', key: 'kind', width: 12 },
        { header: 'Title', key: 'title', width: 40 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Scheduled', key: 'scheduledAt', width: 18 },
        { header: 'Assignee', key: 'assignee', width: 22 },
        { header: 'Created by', key: 'createdBy', width: 22 },
        { header: 'Created', key: 'createdAt', width: 18 },
        { header: 'Completed at', key: 'doneAt', width: 18 },
        { header: 'Details', key: 'details', width: 50 },
    ]);

    for (const a of project.activities || []) {
        const row = sheet.addRow({
            phase: a.phase?.name || '',
            kind: activityKindLabel(a.kind),
            title: a.title || '',
            status: a.done ? 'Done' : 'Open',
            scheduledAt: toDate(a.scheduledAt),
            assignee: userLabel(a.assignee),
            createdBy: userLabel(a.createdBy),
            createdAt: toDate(a.createdAt),
            doneAt: toDate(a.doneAt),
            details: a.details || '',
        });
        row.getCell('scheduledAt').numFmt = 'yyyy-mm-dd hh:mm';
        row.getCell('createdAt').numFmt = 'yyyy-mm-dd hh:mm';
        row.getCell('doneAt').numFmt = 'yyyy-mm-dd hh:mm';
        row.alignment = { vertical: 'top', wrapText: true };
    }
    applyZebra(sheet);
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: 10 },
    };
    return sheet;
}

function notesSheet(workbook, project) {
    const sheet = workbook.addWorksheet('Notes');
    styleHeader(sheet, [
        { header: 'Author', key: 'author', width: 22 },
        { header: 'Created', key: 'createdAt', width: 20 },
        { header: 'Updated', key: 'updatedAt', width: 20 },
        { header: 'Content', key: 'content', width: 80 },
        { header: 'Attachments', key: 'attachments', width: 18 },
    ]);

    for (const note of project.notes || []) {
        const row = sheet.addRow({
            author: userLabel(note.author),
            createdAt: toDate(note.createdAt),
            updatedAt: toDate(note.updatedAt),
            content: note.content || '',
            attachments: note._count?.files ?? note.files?.length ?? 0,
        });
        row.getCell('createdAt').numFmt = 'yyyy-mm-dd hh:mm';
        row.getCell('updatedAt').numFmt = 'yyyy-mm-dd hh:mm';
        row.alignment = { vertical: 'top', wrapText: true };
    }
    applyZebra(sheet);
    return sheet;
}

function filesSheet(workbook, project) {
    const sheet = workbook.addWorksheet('Files');
    styleHeader(sheet, [
        { header: 'File name', key: 'name', width: 40 },
        { header: 'Size', key: 'size', width: 14 },
        { header: 'Mime type', key: 'mime', width: 24 },
        { header: 'Uploaded by', key: 'uploadedBy', width: 22 },
        { header: 'Uploaded at', key: 'uploadedAt', width: 20 },
    ]);

    for (const file of project.files || []) {
        const row = sheet.addRow({
            name: file.originalName || file.filename || file.name || '',
            size: bytesHuman(file.size),
            mime: file.mimeType || '',
            uploadedBy: userLabel(file.uploadedBy || file.uploader),
            uploadedAt: toDate(file.createdAt),
        });
        row.getCell('uploadedAt').numFmt = 'yyyy-mm-dd hh:mm';
    }
    applyZebra(sheet);
    return sheet;
}

function participantsSheet(workbook, project) {
    const sheet = workbook.addWorksheet('Participants');
    styleHeader(sheet, [
        { header: 'Name', key: 'name', width: 24 },
        { header: 'Email', key: 'email', width: 32 },
        { header: 'Role', key: 'role', width: 12 },
        { header: 'Added at', key: 'addedAt', width: 20 },
        { header: 'Added by', key: 'addedBy', width: 22 },
    ]);

    for (const p of project.participants || []) {
        const row = sheet.addRow({
            name: userLabel(p.user || p),
            email: (p.user || p).email || '',
            role: (p.user || p).role || '',
            addedAt: toDate(p.addedAt),
            addedBy: userLabel(p.addedBy),
        });
        row.getCell('addedAt').numFmt = 'yyyy-mm-dd hh:mm';
    }
    applyZebra(sheet);
    return sheet;
}

// ---------- multi-project list workbook ----------

function descriptionPreview(text, max = 220) {
    if (!text || typeof text !== 'string') return '';
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Multi-project workbook. `detail` switches between:
//   - 'summary' (default): single Projects sheet with counts + key fields.
//   - 'full': adds Phases, Tasks, Activities, Notes, Files and
//     Participants sheets, each listing every row across the exported
//     projects with a leading `Project` column so admins can filter,
//     pivot or chart in Excel.
function buildProjectsListWorkbook(projects, options = {}) {
    const detail = options.detail === 'full' ? 'full' : 'summary';
    const includePrices = Boolean(options.includePrices);
    const workbook = new ExcelJS.Workbook();
    setBookMeta(
        workbook,
        detail === 'full' ? 'Projects export (detailed)' : 'Projects export',
    );

    summarySheet(workbook, projects, { includePrices });

    if (detail === 'full') {
        phasesAcrossSheet(workbook, projects);
        tasksAcrossSheet(workbook, projects);
        activitiesAcrossSheet(workbook, projects);
        notesAcrossSheet(workbook, projects);
        filesAcrossSheet(workbook, projects);
        participantsAcrossSheet(workbook, projects);
    }

    if (includePrices) {
        billingSheet(workbook, projects);
    }

    return workbook;
}

function summarySheet(workbook, projects, options = {}) {
    const includePrices = Boolean(options.includePrices);
    const sheet = workbook.addWorksheet('Projects');
    const baseColumns = [
        { header: 'Name', key: 'name', width: 32 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Priority', key: 'priority', width: 12 },
        { header: 'Phase', key: 'phase', width: 18 },
        { header: 'Owner', key: 'owner', width: 22 },
        { header: 'Reporter', key: 'reporter', width: 22 },
        { header: 'Country', key: 'country', width: 14 },
        { header: 'Client', key: 'client', width: 22 },
        { header: 'CRM ID', key: 'crmId', width: 16 },
        { header: 'Label', key: 'label', width: 16 },
        { header: 'Tasks', key: 'tasks', width: 10 },
        { header: 'To do', key: 'todo', width: 10 },
        { header: 'In progress', key: 'inProgress', width: 12 },
        { header: 'Done', key: 'done', width: 10 },
        { header: 'Overdue', key: 'overdue', width: 10 },
        { header: 'Activities', key: 'activities', width: 12 },
        { header: 'Notes', key: 'notes', width: 10 },
        { header: 'Files', key: 'files', width: 10 },
        { header: 'Participants', key: 'participants', width: 14 },
        { header: 'Start date', key: 'startDate', width: 14 },
        { header: 'End date', key: 'endDate', width: 14 },
        { header: 'Created', key: 'createdAt', width: 20 },
        { header: 'Updated', key: 'updatedAt', width: 20 },
        { header: 'Closed / archived', key: 'closedAt', width: 20 },
        { header: 'Description', key: 'description', width: 60 },
    ];
    const priceColumns = includePrices
        ? [
              { header: 'Internal amount', key: 'internalAmount', width: 16 },
              {
                  header: 'Internal currency',
                  key: 'internalCurrency',
                  width: 10,
              },
              { header: 'Internal paid', key: 'internalPaid', width: 12 },
              { header: 'Internal paid at', key: 'internalPaidAt', width: 18 },
              { header: 'Client amount', key: 'clientAmount', width: 16 },
              { header: 'Client currency', key: 'clientCurrency', width: 10 },
              { header: 'Client paid', key: 'clientPaid', width: 12 },
              { header: 'Client paid at', key: 'clientPaidAt', width: 18 },
          ]
        : [];
    styleHeader(sheet, [...baseColumns, ...priceColumns]);

    const now = new Date();
    for (const p of projects) {
        const tasks = p.tasks || [];
        const totalTasks = p.totalTasks ?? tasks.length;
        const todoTasks = tasks.filter((t) => t.status === 'TODO').length;
        const inProgressTasks = tasks.filter(
            (t) => t.status === 'IN_PROGRESS',
        ).length;
        const doneTasks =
            p.doneTasks ?? tasks.filter((t) => t.status === 'DONE').length;
        const overdueTasks = tasks.filter(
            (t) =>
                t.status !== 'DONE' &&
                t.dueDate &&
                new Date(t.dueDate).getTime() < now.getTime(),
        ).length;
        const activitiesCount =
            p.activityCount ?? (p.activities ? p.activities.length : 0);

        const baseRow = {
            name: p.name,
            status: statusLabel(p.status),
            priority: priorityLabel(p.priority),
            phase: p.phase || '',
            owner: userLabel(p.owner),
            reporter: userLabel(p.reporter),
            country: p.country || '',
            client: p.client || '',
            crmId: p.crmId || '',
            label: p.label || '',
            tasks: totalTasks,
            todo: todoTasks,
            inProgress: inProgressTasks,
            done: doneTasks,
            overdue: overdueTasks,
            activities: activitiesCount,
            notes: p.noteCount ?? p._count?.notes ?? 0,
            files: p.fileCount ?? p._count?.files ?? 0,
            participants:
                p.participantCount ?? p._count?.participants ?? 0,
            startDate: toDate(p.startDate),
            endDate: toDate(p.endDate),
            createdAt: toDate(p.createdAt),
            updatedAt: toDate(p.updatedAt),
            closedAt: toDate(p.closedAt),
            description: descriptionPreview(p.description),
        };
        if (includePrices) {
            baseRow.internalAmount = moneyAmount(p.internalAmount);
            baseRow.internalCurrency = p.internalCurrency || '';
            baseRow.internalPaid = p.internalPaid ? 'Yes' : 'No';
            baseRow.internalPaidAt = toDate(p.internalPaidAt);
            baseRow.clientAmount = moneyAmount(p.clientAmount);
            baseRow.clientCurrency = p.clientCurrency || '';
            baseRow.clientPaid = p.clientPaid ? 'Yes' : 'No';
            baseRow.clientPaidAt = toDate(p.clientPaidAt);
        }
        const row = sheet.addRow(baseRow);
        row.getCell('startDate').numFmt = 'yyyy-mm-dd';
        row.getCell('endDate').numFmt = 'yyyy-mm-dd';
        row.getCell('createdAt').numFmt = 'yyyy-mm-dd hh:mm';
        row.getCell('updatedAt').numFmt = 'yyyy-mm-dd hh:mm';
        row.getCell('closedAt').numFmt = 'yyyy-mm-dd hh:mm';
        row.alignment = { vertical: 'top', wrapText: true };
        if (overdueTasks > 0) {
            row.getCell('overdue').font = {
                bold: true,
                color: { argb: 'FFB91C1C' }, // rose-700
            };
        }
        if (includePrices) {
            row.getCell('internalAmount').numFmt = '#,##0.00';
            row.getCell('clientAmount').numFmt = '#,##0.00';
            row.getCell('internalPaidAt').numFmt = 'yyyy-mm-dd hh:mm';
            row.getCell('clientPaidAt').numFmt = 'yyyy-mm-dd hh:mm';
            if (p.internalAmount != null && !p.internalPaid) {
                row.getCell('internalPaid').font = {
                    bold: true,
                    color: { argb: 'FFB91C1C' },
                };
            }
            if (p.clientAmount != null && !p.clientPaid) {
                row.getCell('clientPaid').font = {
                    bold: true,
                    color: { argb: 'FFB91C1C' },
                };
            }
        }
    }

    applyZebra(sheet);
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
    };
    return sheet;
}

// ----- "Across" sheets used by the full-detail export ---------------------

function phasesAcrossSheet(workbook, projects) {
    const sheet = workbook.addWorksheet('Phases');
    styleHeader(sheet, [
        { header: 'Project', key: 'project', width: 28 },
        { header: 'Phase', key: 'phase', width: 24 },
        { header: 'Order', key: 'order', width: 8 },
        { header: 'Tasks', key: 'tasks', width: 10 },
        { header: 'Done', key: 'done', width: 10 },
        { header: 'Created', key: 'createdAt', width: 18 },
    ]);

    for (const p of projects) {
        const tasks = p.tasks || [];
        for (const phase of p.phases || []) {
            const phaseTasks = tasks.filter(
                (t) => t.phaseId === phase.id && !t.parentTaskId,
            );
            const done = phaseTasks.filter((t) => t.status === 'DONE').length;
            const row = sheet.addRow({
                project: p.name,
                phase: phase.name,
                order: phase.order ?? 0,
                tasks: phaseTasks.length,
                done,
                createdAt: toDate(phase.createdAt),
            });
            row.getCell('createdAt').numFmt = 'yyyy-mm-dd hh:mm';
        }
    }
    applyZebra(sheet);
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
    };
    return sheet;
}

function tasksAcrossSheet(workbook, projects) {
    const sheet = workbook.addWorksheet('Tasks');
    styleHeader(sheet, [
        { header: 'Project', key: 'project', width: 28 },
        { header: 'Phase', key: 'phase', width: 20 },
        { header: 'Type', key: 'type', width: 10 },
        { header: 'Parent task', key: 'parent', width: 32 },
        { header: 'Title', key: 'title', width: 40 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Priority', key: 'priority', width: 10 },
        { header: 'Assignee', key: 'assignee', width: 22 },
        { header: 'Due date', key: 'dueDate', width: 14 },
        { header: 'Created', key: 'createdAt', width: 18 },
        { header: 'Updated', key: 'updatedAt', width: 18 },
        { header: 'Description', key: 'description', width: 50 },
    ]);

    for (const p of projects) {
        const tasks = p.tasks || [];
        const tasksById = new Map(tasks.map((t) => [t.id, t]));
        for (const t of tasks) {
            const parent = t.parentTaskId
                ? tasksById.get(t.parentTaskId)
                : null;
            const phase =
                t.phase?.name ||
                (parent && parent.phase?.name) ||
                '';
            const row = sheet.addRow({
                project: p.name,
                phase,
                type: t.parentTaskId ? 'Subtask' : 'Task',
                parent: parent?.title || '',
                title: t.title || '',
                status: taskStatusLabel(t.status),
                priority: taskPriorityLabel(t.priority),
                assignee: userLabel(t.assignee),
                dueDate: toDate(t.dueDate),
                createdAt: toDate(t.createdAt),
                updatedAt: toDate(t.updatedAt),
                description: t.description || '',
            });
            row.getCell('dueDate').numFmt = 'yyyy-mm-dd';
            row.getCell('createdAt').numFmt = 'yyyy-mm-dd hh:mm';
            row.getCell('updatedAt').numFmt = 'yyyy-mm-dd hh:mm';
            row.alignment = { vertical: 'top', wrapText: true };
        }
    }
    applyZebra(sheet);
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
    };
    return sheet;
}

function activitiesAcrossSheet(workbook, projects) {
    const sheet = workbook.addWorksheet('Activities');
    styleHeader(sheet, [
        { header: 'Project', key: 'project', width: 28 },
        { header: 'Phase', key: 'phase', width: 20 },
        { header: 'Kind', key: 'kind', width: 12 },
        { header: 'Title', key: 'title', width: 40 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Scheduled', key: 'scheduledAt', width: 18 },
        { header: 'Assignee', key: 'assignee', width: 22 },
        { header: 'Created by', key: 'createdBy', width: 22 },
        { header: 'Created', key: 'createdAt', width: 18 },
        { header: 'Completed at', key: 'doneAt', width: 18 },
        { header: 'Details', key: 'details', width: 50 },
    ]);

    for (const p of projects) {
        for (const a of p.activities || []) {
            const row = sheet.addRow({
                project: p.name,
                phase: a.phase?.name || '',
                kind: activityKindLabel(a.kind),
                title: a.title || '',
                status: a.done ? 'Done' : 'Open',
                scheduledAt: toDate(a.scheduledAt),
                assignee: userLabel(a.assignee),
                createdBy: userLabel(a.createdBy),
                createdAt: toDate(a.createdAt),
                doneAt: toDate(a.doneAt),
                details: a.details || '',
            });
            row.getCell('scheduledAt').numFmt = 'yyyy-mm-dd hh:mm';
            row.getCell('createdAt').numFmt = 'yyyy-mm-dd hh:mm';
            row.getCell('doneAt').numFmt = 'yyyy-mm-dd hh:mm';
            row.alignment = { vertical: 'top', wrapText: true };
        }
    }
    applyZebra(sheet);
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
    };
    return sheet;
}

function notesAcrossSheet(workbook, projects) {
    const sheet = workbook.addWorksheet('Notes');
    styleHeader(sheet, [
        { header: 'Project', key: 'project', width: 28 },
        { header: 'Author', key: 'author', width: 22 },
        { header: 'Created', key: 'createdAt', width: 20 },
        { header: 'Updated', key: 'updatedAt', width: 20 },
        { header: 'Pinned task', key: 'task', width: 30 },
        { header: 'Content', key: 'content', width: 80 },
    ]);

    for (const p of projects) {
        for (const note of p.notes || []) {
            const row = sheet.addRow({
                project: p.name,
                author: userLabel(note.author),
                createdAt: toDate(note.createdAt),
                updatedAt: toDate(note.updatedAt),
                task: note.task?.title || '',
                content: note.content || '',
            });
            row.getCell('createdAt').numFmt = 'yyyy-mm-dd hh:mm';
            row.getCell('updatedAt').numFmt = 'yyyy-mm-dd hh:mm';
            row.alignment = { vertical: 'top', wrapText: true };
        }
    }
    applyZebra(sheet);
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
    };
    return sheet;
}

function filesAcrossSheet(workbook, projects) {
    const sheet = workbook.addWorksheet('Files');
    styleHeader(sheet, [
        { header: 'Project', key: 'project', width: 28 },
        { header: 'File name', key: 'name', width: 40 },
        { header: 'Size', key: 'size', width: 14 },
        { header: 'Mime type', key: 'mime', width: 24 },
        { header: 'Uploaded by', key: 'uploadedBy', width: 22 },
        { header: 'Uploaded at', key: 'uploadedAt', width: 20 },
    ]);

    for (const p of projects) {
        for (const f of p.files || []) {
            const row = sheet.addRow({
                project: p.name,
                name: f.originalName || f.filename || '',
                size: bytesHuman(f.size),
                mime: f.mimeType || '',
                uploadedBy: userLabel(f.uploadedBy || f.uploader),
                uploadedAt: toDate(f.createdAt),
            });
            row.getCell('uploadedAt').numFmt = 'yyyy-mm-dd hh:mm';
        }
    }
    applyZebra(sheet);
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
    };
    return sheet;
}

function participantsAcrossSheet(workbook, projects) {
    const sheet = workbook.addWorksheet('Participants');
    styleHeader(sheet, [
        { header: 'Project', key: 'project', width: 28 },
        { header: 'Name', key: 'name', width: 24 },
        { header: 'Email', key: 'email', width: 32 },
        { header: 'Role', key: 'role', width: 12 },
        { header: 'Added at', key: 'addedAt', width: 20 },
        { header: 'Added by', key: 'addedBy', width: 22 },
    ]);

    for (const p of projects) {
        for (const part of p.participants || []) {
            const u = part.user || part;
            const row = sheet.addRow({
                project: p.name,
                name: userLabel(u),
                email: u.email || '',
                role: u.role || '',
                addedAt: toDate(part.addedAt),
                addedBy: userLabel(part.addedBy),
            });
            row.getCell('addedAt').numFmt = 'yyyy-mm-dd hh:mm';
        }
    }
    applyZebra(sheet);
    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
    };
    return sheet;
}

// Dedicated Billing sheet — one row per project with internal and
// client pricing side by side, plus a totals block at the bottom
// summed per currency. Currencies are kept distinct because mixing
// EUR and USD into one number would be misleading.
function billingSheet(workbook, projects) {
    const sheet = workbook.addWorksheet('Billing');
    styleHeader(sheet, [
        { header: 'Project', key: 'project', width: 30 },
        { header: 'Client', key: 'client', width: 22 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Internal amount', key: 'internalAmount', width: 16 },
        { header: 'Internal currency', key: 'internalCurrency', width: 10 },
        { header: 'Internal paid', key: 'internalPaid', width: 12 },
        { header: 'Internal paid at', key: 'internalPaidAt', width: 18 },
        { header: 'Client amount', key: 'clientAmount', width: 16 },
        { header: 'Client currency', key: 'clientCurrency', width: 10 },
        { header: 'Client paid', key: 'clientPaid', width: 12 },
        { header: 'Client paid at', key: 'clientPaidAt', width: 18 },
        { header: 'Notes', key: 'notes', width: 40 },
    ]);

    const totals = {
        internal: {},
        internalUnpaid: {},
        client: {},
        clientUnpaid: {},
    };

    for (const p of projects) {
        const ia = moneyAmount(p.internalAmount);
        const ca = moneyAmount(p.clientAmount);
        const ic = p.internalCurrency || 'EUR';
        const cc = p.clientCurrency || 'EUR';
        if (ia != null) {
            totals.internal[ic] = (totals.internal[ic] || 0) + ia;
            if (!p.internalPaid)
                totals.internalUnpaid[ic] =
                    (totals.internalUnpaid[ic] || 0) + ia;
        }
        if (ca != null) {
            totals.client[cc] = (totals.client[cc] || 0) + ca;
            if (!p.clientPaid)
                totals.clientUnpaid[cc] =
                    (totals.clientUnpaid[cc] || 0) + ca;
        }

        const row = sheet.addRow({
            project: p.name,
            client: p.client || '',
            status: statusLabel(p.status),
            internalAmount: ia,
            internalCurrency: p.internalCurrency || '',
            internalPaid: p.internalPaid ? 'Yes' : ia == null ? '' : 'No',
            internalPaidAt: toDate(p.internalPaidAt),
            clientAmount: ca,
            clientCurrency: p.clientCurrency || '',
            clientPaid: p.clientPaid ? 'Yes' : ca == null ? '' : 'No',
            clientPaidAt: toDate(p.clientPaidAt),
            notes: p.billingNotes || '',
        });
        row.getCell('internalAmount').numFmt = '#,##0.00';
        row.getCell('clientAmount').numFmt = '#,##0.00';
        row.getCell('internalPaidAt').numFmt = 'yyyy-mm-dd hh:mm';
        row.getCell('clientPaidAt').numFmt = 'yyyy-mm-dd hh:mm';
        row.alignment = { vertical: 'top', wrapText: true };
        if (ia != null && !p.internalPaid) {
            row.getCell('internalPaid').font = {
                bold: true,
                color: { argb: 'FFB91C1C' },
            };
        }
        if (ca != null && !p.clientPaid) {
            row.getCell('clientPaid').font = {
                bold: true,
                color: { argb: 'FFB91C1C' },
            };
        }
    }

    applyZebra(sheet);

    // Totals rows — one per currency for internal + client.
    sheet.addRow([]);
    const all = new Set([
        ...Object.keys(totals.internal),
        ...Object.keys(totals.client),
    ]);
    for (const c of all) {
        const row = sheet.addRow({
            project: `Totals (${c})`,
            internalAmount: totals.internal[c]
                ? Math.round(totals.internal[c] * 100) / 100
                : null,
            internalCurrency: c,
            internalPaid: totals.internalUnpaid[c]
                ? `unpaid: ${Math.round(totals.internalUnpaid[c] * 100) / 100}`
                : '',
            clientAmount: totals.client[c]
                ? Math.round(totals.client[c] * 100) / 100
                : null,
            clientCurrency: c,
            clientPaid: totals.clientUnpaid[c]
                ? `unpaid: ${Math.round(totals.clientUnpaid[c] * 100) / 100}`
                : '',
        });
        row.font = { bold: true };
        row.getCell('internalAmount').numFmt = '#,##0.00';
        row.getCell('clientAmount').numFmt = '#,##0.00';
    }

    sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
    };
    return sheet;
}

// Generates a safe-ish filename for HTTP Content-Disposition.
function safeFilename(s, fallback = 'export') {
    const base = String(s || fallback)
        .normalize('NFKD')
        .replace(/[^\w\d._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return base || fallback;
}

// ---------- time tracking workbook ----------
//
// Single-sheet workbook with the columns the team agreed on:
//   User · Project type · CRM ID · Project · Date · Time spent ·
//   Task · Log comment (note) · IDs (project/task/subtask codes)
//
// `entries` is the list returned from `/api/time` (admin-wide or
// "mine") with `user`, `project` (incl. projectType + crmId + code)
// and `task` (with `parent` for subtasks) eagerly hydrated.
function buildTimeEntriesWorkbook(entries, options = {}) {
    const workbook = new ExcelJS.Workbook();
    setBookMeta(workbook, 'Time entries export');

    const sheet = workbook.addWorksheet('Time entries');
    styleHeader(sheet, [
        { header: 'User', key: 'user', width: 24 },
        { header: 'Project type', key: 'projectType', width: 18 },
        { header: 'CRM ID', key: 'crmId', width: 14 },
        { header: 'Project', key: 'project', width: 32 },
        { header: 'Date', key: 'date', width: 18 },
        { header: 'Time spent', key: 'duration', width: 14 },
        // Task is widened because mirror entries now render the full
        // personal-project path inline (project → optional parent →
        // task) instead of an opaque "Project-level".
        { header: 'Task', key: 'task', width: 52 },
        { header: 'Log comment', key: 'note', width: 50 },
        { header: 'IDs (Project / Task / Subtask)', key: 'codes', width: 42 },
    ]);

    let totalSeconds = 0;
    for (const entry of entries || []) {
        const seconds = Number(entry.durationSeconds) || 0;
        totalSeconds += seconds;

        const project = entry.project || {};
        const task = entry.task || null;
        const parent = task?.parent || null;
        // Build the "task" column. For top-level tasks it's just the
        // title; for subtasks we include the parent so the row reads
        // naturally without flipping to the IDs column.
        let taskLabel = '';
        if (task && parent) {
            taskLabel = `${parent.title} → ${task.title}`;
        } else if (task) {
            taskLabel = task.title || '';
        }

        // Codes column. Always include the project code; append task
        // and (if present) parent so subtask rows render
        // "P26-USA-0001 / T-0007 / ST-0003".
        const codes = [];
        if (project.code) codes.push(project.code);
        if (task && parent && parent.code) codes.push(parent.code);
        if (task && task.code) codes.push(task.code);

        // Mirror entries (time logged on a personal project linked to
        // a shared project) arrive here with `task == null`. Surface
        // the personal-project context inline in the Task column so
        // it reads "P26-SER-006 Personal proj → T-001 personal task"
        // instead of "Project-level". The original log comment is
        // already preserved on the mirror entry (we copy it from the
        // source on create), so the existing Note column still shows
        // what the user wrote.
        const personalProj = entry.fromPersonalProject || null;
        const sourceEntry = entry.sourceEntry || null;
        const sourceTask = sourceEntry?.task || null;
        const sourceParent = sourceTask?.parent || null;

        let finalTaskLabel = taskLabel;
        if (!finalTaskLabel) {
            if (personalProj) {
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
                    finalTaskLabel = `${personalProjLabel} → ${parentLabel} → ${childLabel}`;
                } else if (sourceTask) {
                    const childLabel = sourceTask.code
                        ? `${sourceTask.code} ${sourceTask.title}`
                        : sourceTask.title;
                    finalTaskLabel = `${personalProjLabel} → ${childLabel}`;
                } else {
                    finalTaskLabel = `${personalProjLabel} (project-level)`;
                }
            } else if (!task) {
                finalTaskLabel = 'Project-level';
            }
        }

        // Append personal-project / task codes to the IDs column too
        // so the trailing column still mirrors the Task column for
        // every row.
        if (!task && personalProj?.code) codes.push(personalProj.code);
        if (!task && sourceParent?.code) codes.push(sourceParent.code);
        if (!task && sourceTask?.code) codes.push(sourceTask.code);

        const row = sheet.addRow({
            user: userLabel(entry.user),
            projectType: project.projectType?.name || '',
            crmId: project.crmId || '',
            project: project.name || '',
            date: toDate(entry.startedAt),
            duration: seconds / 86400, // Excel time is fractions of a day
            task: finalTaskLabel,
            note: entry.description || '',
            codes: codes.join(' / '),
        });
        row.getCell('date').numFmt = 'yyyy-mm-dd hh:mm';
        row.getCell('duration').numFmt = '[h]:mm';
        row.alignment = { vertical: 'top', wrapText: true };
    }

    // Totals footer — number of rows + summed time so the reader
    // doesn't have to recompute it manually.
    if ((entries || []).length > 0) {
        const totalsRow = sheet.addRow({
            user: 'TOTAL',
            duration: totalSeconds / 86400,
        });
        totalsRow.getCell('duration').numFmt = '[h]:mm';
        totalsRow.font = { bold: true };
        totalsRow.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFEFF6FF' },
        };
    } else {
        sheet.addRow({ user: 'No entries match the selected filters.' });
    }

    // Filter strip with the criteria that were applied — gives the
    // export auditability without parsing the filename.
    const meta = workbook.addWorksheet('Filters');
    styleHeader(meta, [
        { header: 'Filter', key: 'k', width: 22 },
        { header: 'Value', key: 'v', width: 80 },
    ]);
    const f = options.filters || {};
    const fmt = (d) =>
        d ? `${toDate(d) ? toDate(d).toISOString().slice(0, 10) : d}` : '';
    meta.addRow({ k: 'User', v: f.userLabel || 'All users' });
    meta.addRow({ k: 'Project', v: f.projectLabel || 'All projects' });
    meta.addRow({ k: 'From', v: fmt(f.from) || 'Earliest' });
    meta.addRow({ k: 'To', v: fmt(f.to) || 'Latest' });
    meta.addRow({ k: 'Total entries', v: (entries || []).length });
    meta.addRow({
        k: 'Generated',
        v: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
    applyZebra(meta);

    return workbook;
}

module.exports = {
    buildProjectWorkbook,
    buildProjectsListWorkbook,
    buildTimeEntriesWorkbook,
    safeFilename,
};
