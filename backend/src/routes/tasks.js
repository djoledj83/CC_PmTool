const express = require('express');
const { z } = require('zod');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { httpError } = require('../middleware/error');
const {
    notify,
    notifyAssigneePersonal,
    projectParticipantIds,
    ensureProjectParticipant,
    isProjectParticipant,
} = require('../lib/notify');
const { emitToProject } = require('../lib/realtime');
const {
    isAdmin,
    isAdminOrManager,
    isAdminOrManagerOrHasCapability,
    hasCapability,
    assertProjectRead,
    assertProjectWritable,
    accessibleProjectIds,
    CAPABILITIES,
} = require('../lib/permissions');
const { logActivityEvent } = require('../lib/activityLog');
const { isTaskApprovalLocked } = require('../lib/taskApproval');
const { generateTaskCode } = require('../lib/codes');

const TASK_STATUS_LABELS = {
    TODO: 'To do',
    IN_PROGRESS: 'In progress',
    DONE: 'Done',
};

const TASK_PRIORITY_LABELS = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High' };

// Friendly labels for the fields we collapse into a single
// TASK_UPDATED notification + activity event. Status / phase /
// assignee / due-date have their own dedicated events with richer
// context, so they are excluded from this catch-all diff.
const TASK_DETAIL_LABELS = {
    title: 'title',
    description: 'description',
    priority: 'priority',
};

function valueChanged(a, b) {
    const norm = (v) => {
        if (v == null || v === '') return null;
        if (v instanceof Date) return v.getTime();
        return v;
    };
    const av = norm(a);
    const bv = norm(b);
    return av !== bv;
}

function diffTaskDetailFields(existing, data) {
    const out = [];
    for (const key of Object.keys(TASK_DETAIL_LABELS)) {
        if (!(key in data)) continue;
        if (data[key] === undefined) continue;
        if (valueChanged(existing[key], data[key])) out.push(key);
    }
    return out;
}

// Push a "your local copy of this project's plan is stale" event into
// every socket that has joined the project room. The FE listens for
// this and either auto-refetches or surfaces a manual reload button.
// `kind` is one of: 'task-created' | 'task-updated' | 'task-deleted'
// | 'note-added' | 'note-updated' | 'note-deleted'.
function emitProjectPlanChanged(projectId, payload) {
    if (!projectId) return;
    emitToProject(projectId, 'project:plan-changed', {
        projectId,
        ...payload,
        at: new Date().toISOString(),
    });
}

const router = express.Router();

router.use(requireAuth);

const TaskStatus = z.enum(['TODO', 'IN_PROGRESS', 'ON_HOLD', 'DONE']);
const TaskPriority = z.enum(['LOW', 'MEDIUM', 'HIGH']);

const optionalDate = z
    .union([z.string().datetime(), z.literal(''), z.null()])
    .optional()
    .transform((v) => {
        if (v === undefined) return undefined;
        if (v === null || v === '') return null;
        return new Date(v);
    });

// Optional sprint-planning estimate, in hours (decimal allowed for
// half-hour granularity). Drives the burndown chart in SprintsPanel —
// without it, a sprint's totalHours is zero and the chart flatlines.
// Capped at 1000 to fence off accidental "hours from epoch" inputs.
const optionalEstimateHours = z
    .union([z.number(), z.string()])
    .transform((v) => {
        if (v === '' || v === null || v === undefined) return null;
        const n = typeof v === 'string' ? Number(v) : v;
        return Number.isFinite(n) ? n : null;
    })
    .refine((v) => v === null || (v >= 0 && v <= 1000), {
        message: 'estimateHours must be between 0 and 1000',
    })
    .optional()
    .nullable();

const createTaskSchema = z.object({
    projectId: z.string().min(1),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional().nullable(),
    status: TaskStatus.optional(),
    priority: TaskPriority.optional(),
    dueDate: optionalDate,
    phaseId: z.string().min(1).optional().nullable(),
    assigneeId: z.string().min(1).optional().nullable(),
    parentTaskId: z.string().min(1).optional().nullable(),
    // Optional CR scope. When set, the task is created inside that
    // Change Request and gets a CR-scoped code (<CR_CODE>-T-001).
    // Server validates the CR belongs to the same project.
    changeRequestId: z.string().min(1).optional().nullable(),
    estimateHours: optionalEstimateHours,
    // Optional link to the help-desk ticket this task was created from
    // (resolver's "Add as Task"). Purely informational on the task side.
    sourceTicketId: z.string().min(1).optional().nullable(),
    // "Specific" tasks require approval (admin/manager/task:approve) before
    // they can leave TODO, and can't be duplicated.
    specific: z.boolean().optional(),
});

const updateTaskSchema = z.object({
    // Length caps are enforced in the handler ONLY when the value actually
    // changes — otherwise editing one field (e.g. the due date) on a legacy
    // task whose title/description already exceeds today's cap (tasks made
    // from a long ticket subject/body via "Add as task") would fail
    // validation on an untouched field. New/changed values are still capped.
    title: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    status: TaskStatus.optional(),
    priority: TaskPriority.optional(),
    dueDate: optionalDate,
    phaseId: z.string().min(1).optional().nullable(),
    assigneeId: z.string().min(1).optional().nullable(),
    order: z.number().int().optional(),
    estimateHours: optionalEstimateHours,
    // Allow re-scoping a task to a different CR (or to no CR by
    // passing null). The server validates the CR belongs to the
    // same project. Codes are stable once stamped — moving a task
    // between CRs does NOT renumber its code.
    changeRequestId: z.string().min(1).optional().nullable(),
});

const taskInclude = {
    assignee: { select: { id: true, name: true, email: true, avatarUrl: true } },
    project: { select: { id: true, name: true, code: true } },
    // Surface enough of the CR for the UI to show a "CR-001" chip
    // and link to the CR detail page without an extra fetch.
    changeRequest: { select: { id: true, code: true, title: true } },
    // Surface the creator on every task payload so the FE can decide
    // whether to expose Edit / Delete buttons to a user holding only
    // `task:create:any` (cap is "you can manage tasks YOU created").
    createdBy: { select: { id: true, name: true, email: true, avatarUrl: true } },
    approvedBy: { select: { id: true, name: true, email: true, avatarUrl: true } },
    rejectedBy: { select: { id: true, name: true, email: true, avatarUrl: true } },
    // Count only live subtasks. Without this filter a parent shows a
    // stale subtask badge after a soft delete + restore round-trip.
    _count: {
        select: { subtasks: { where: { deletedAt: null } } },
    },
};

// Confirm a CR exists AND belongs to the given project. Used by
// create + update so we can never end up with a task pointing at a
// CR in a different project (which would break the rollup math and
// the audit story). Throws 400 if mismatched, 404 if missing.
async function ensureCRInProject(changeRequestId, projectId) {
    if (!changeRequestId) return null;
    const cr = await prisma.changeRequest.findUnique({
        where: { id: changeRequestId },
        select: { id: true, projectId: true },
    });
    if (!cr) throw httpError(404, 'Change request not found');
    if (cr.projectId !== projectId) {
        throw httpError(
            400,
            'Change request does not belong to this project',
        );
    }
    return cr;
}

// Subtasks must be assigned to a member of the parent project. Throws 400
// otherwise so the UI can surface a useful error.
async function ensureAssigneeIsParticipant(projectId, assigneeId) {
    if (!assigneeId) return;
    const member = await isProjectParticipant(projectId, assigneeId);
    if (!member) {
        throw httpError(
            400,
            'Subtask assignee must be a participant of the project',
        );
    }
}

async function loadTaskOr404(taskId) {
    const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: { project: true },
    });
    if (!task) throw httpError(404, 'Task not found');
    return task;
}

async function ensureProjectExists(projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw httpError(404, 'Project not found');
    return project;
}

async function ensurePhaseInProject(phaseId, projectId) {
    if (!phaseId) return;
    const phase = await prisma.phase.findUnique({ where: { id: phaseId } });
    if (!phase || phase.projectId !== projectId) {
        throw httpError(400, 'Phase does not belong to this project');
    }
}

router.get('/', async (req, res, next) => {
    try {
        const { projectId, changeRequestId } = req.query;

        let where;
        if (projectId) {
            // Specific project: verify the caller can read it (admins can,
            // others must be participants/owner).
            await assertProjectRead(req, projectId);
            where = { projectId };
        } else {
            // No project filter: admins get all tasks, others only see tasks
            // belonging to projects they're involved in.
            const ids = await accessibleProjectIds(req);
            where = { projectId: { in: ids } };
        }

        // M4: optional CR narrowing. Caller can pass `changeRequestId=none`
        // to get only project-level tasks (no CR), or a concrete id to
        // pull tasks scoped to that CR. The CR is not validated here;
        // an out-of-project id just returns an empty list, which is the
        // right shape for a picker.
        if (changeRequestId === 'none') {
            where.changeRequestId = null;
        } else if (changeRequestId) {
            where.changeRequestId = changeRequestId;
        }

        const tasks = await prisma.task.findMany({
            where,
            orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
            include: taskInclude,
        });
        res.json({ tasks });
    } catch (err) {
        next(err);
    }
});

router.post('/', async (req, res, next) => {
    try {
        // Managers may create tasks/subtasks just like admins, but only
        // inside projects they can already see.
        //
        // Regular users get the same privilege INSIDE their own personal
        // projects — those projects are private organisers, so the
        // owner needs full task CRUD without being elevated to
        // manager/admin globally.
        const data = createTaskSchema.parse(req.body);
        const project = await prisma.project.findUnique({
            where: { id: data.projectId },
            select: { id: true, isPersonal: true, ownerId: true },
        });
        if (!project) throw httpError(404, 'Project not found');

        const isOwnPersonal =
            project.isPersonal && project.ownerId === req.user.id;
        // Allow admins, managers, personal-project owners, OR any user
        // the admin has granted the `task:create:any` capability to.
        // The last is what enables a regular user with a checkbox in
        // their profile to act as a delegated task author without being
        // elevated to a manager globally.
        if (
            !isOwnPersonal &&
            !isAdminOrManagerOrHasCapability(req, CAPABILITIES.TASK_CREATE_ANY)
        ) {
            throw httpError(
                403,
                'Only admins, managers, or users with task-create permission can create tasks',
            );
        }

        // "specific" (approval-required) is a TOP-LEVEL-only flag. Subtasks
        // never carry it — strip it up front so a crafted payload can't
        // sneak an approval-locked subtask past the capability gate below.
        if (data.parentTaskId) {
            delete data.specific;
        }
        // Raising a specific task is gated on its own capability so admins
        // can decide exactly who may open one.
        if (
            data.specific &&
            !isAdminOrManagerOrHasCapability(
                req,
                CAPABILITIES.TASK_SPECIFIC_CREATE,
            )
        ) {
            throw httpError(
                403,
                'You are not allowed to create specific (approval-required) tasks.',
            );
        }

        // POST = create. Gate on writable: closed (DONE) projects
        // reject all non-admin / non-manager additions, with a clear
        // 403 message the FE can surface verbatim.
        await assertProjectWritable(
            req,
            data.projectId,
            data.parentTaskId ? 'add a subtask' : 'add a task',
        );

        let parent = null;
        if (data.parentTaskId) {
            parent = await prisma.task.findUnique({
                where: { id: data.parentTaskId },
                select: {
                    id: true,
                    projectId: true,
                    phaseId: true,
                    parentTaskId: true,
                    title: true,
                    // Needed so we can auto-reopen the parent if it's
                    // currently DONE — a freshly-added subtask means
                    // there's new work to do on the parent.
                    status: true,
                    assigneeId: true,
                    specific: true,
                    approvedAt: true,
                },
            });
            if (!parent || parent.projectId !== data.projectId) {
                throw httpError(
                    400,
                    'Parent task does not belong to this project',
                );
            }
            if (parent.parentTaskId) {
                throw httpError(400, 'Subtasks cannot be nested further');
            }
            if (isTaskApprovalLocked(parent)) {
                throw httpError(
                    403,
                    'This task must be approved before you can add subtasks to it.',
                );
            }
            // Subtasks must be assigned to a project member.
            await ensureAssigneeIsParticipant(data.projectId, data.assigneeId);
        }

        // Subtasks always inherit the parent's phase so they group together
        // visually inside the plan tab.
        const phaseId = parent ? parent.phaseId : data.phaseId || null;
        if (!parent) {
            await ensurePhaseInProject(phaseId, data.projectId);
        }

        // Resolve CR scope. Subtasks inherit their parent's CR — a
        // subtask can't belong to a different CR than its parent
        // (would split rollups confusingly).
        let changeRequestId = null;
        if (parent) {
            const parentFull = await prisma.task.findUnique({
                where: { id: parent.id },
                select: { changeRequestId: true },
            });
            changeRequestId = parentFull?.changeRequestId || null;
        } else if (data.changeRequestId) {
            await ensureCRInProject(data.changeRequestId, data.projectId);
            changeRequestId = data.changeRequestId;
        }

        // Only top-level tasks created via "Add as Task" carry a source
        // ticket. Guard against turning the same ticket into the same task
        // twice: a given ticket may produce at most ONE live task per
        // (project, phase). A null phase counts as its own slot. This is
        // enforced in-app rather than via a DB unique index because
        // Postgres treats NULL phaseIds as distinct (so a partial unique
        // index wouldn't catch the no-phase case).
        const sourceTicketId = parent ? null : data.sourceTicketId || null;
        if (sourceTicketId) {
            const dup = await prisma.task.findFirst({
                where: {
                    sourceTicketId,
                    projectId: data.projectId,
                    phaseId,
                    deletedAt: null,
                },
                select: { id: true, code: true },
            });
            if (dup) {
                throw httpError(
                    409,
                    `This ticket is already added as a task${dup.code ? ` (${dup.code})` : ''} in this phase.`,
                );
            }
        }

        const task = await prisma.task.create({
            data: {
                ...data,
                phaseId,
                assigneeId: data.assigneeId || null,
                parentTaskId: parent ? parent.id : null,
                changeRequestId,
                // Subtasks never carry a source ticket; only top-level
                // tasks created via "Add as Task" do.
                sourceTicketId,
                // Stamp the original creator so the
                // `task:create:any` cap can later authorise edit /
                // delete / restore on the rows THIS user made
                // without granting them blanket edit-any / delete-any
                // rights across the workspace.
                createdById: req.user.id,
            },
            include: taskInclude,
        });

        // Stamp a per-project task code ("T-0001" / "ST-0001"), or a
        // CR-scoped one ("<CR>-T-001") when the task belongs to a CR.
        // Done in a follow-up update so a code-generation hiccup
        // can't block task creation. On the rare race where two
        // creators land on the same number we recompute once and
        // retry; if that still fails we leave the row codeless and
        // let the startup backfill stamp it later.
        try {
            const code = await generateTaskCode(prisma, {
                projectId: task.projectId,
                parentTaskId: task.parentTaskId,
                changeRequestId: task.changeRequestId,
            });
            const stamped = await prisma.task.update({
                where: { id: task.id },
                data: { code },
            });
            task.code = stamped.code;
        } catch (codeErr) {
            if (codeErr?.code === 'P2002') {
                try {
                    const retry = await generateTaskCode(prisma, {
                        projectId: task.projectId,
                        parentTaskId: task.parentTaskId,
                        changeRequestId: task.changeRequestId,
                    });
                    const stamped = await prisma.task.update({
                        where: { id: task.id },
                        data: { code: retry },
                    });
                    task.code = stamped.code;
                } catch (retryErr) {
                    console.warn(
                        '[tasks] could not stamp task code after retry:',
                        retryErr.message,
                    );
                }
            } else {
                console.warn(
                    '[tasks] could not stamp task code:',
                    codeErr.message,
                );
            }
        }

        // The actor and the assignee are now part of the project conversation.
        await ensureProjectParticipant(task.projectId, req.user.id, req.user.id);
        if (task.assigneeId) {
            await ensureProjectParticipant(
                task.projectId,
                task.assigneeId,
                req.user.id,
            );
        }

        const isSubtask = Boolean(parent);

        // Auto-reopen a previously-DONE parent task when a new
        // subtask lands underneath it. A subtask only ever shows up
        // because there's still work to do on the parent — leaving
        // the parent DONE would visually contradict the plan and
        // also break the rollup ("Done with 1 incomplete subtask").
        // We pick IN_PROGRESS rather than TODO since the parent has
        // clearly been worked on before. Wrapped in try/catch so a
        // failure here can't block the actual subtask creation that
        // the user just submitted.
        if (isSubtask && parent.status === 'DONE') {
            try {
                await prisma.task.update({
                    where: { id: parent.id },
                    data: { status: 'IN_PROGRESS' },
                });
                await logActivityEvent({
                    type: 'TASK_STATUS_CHANGED',
                    actorId: req.user.id,
                    projectId: task.projectId,
                    taskId: parent.id,
                    fromValue: 'DONE',
                    toValue: 'IN_PROGRESS',
                    message: parent.title,
                    meta: {
                        parentTaskId: null,
                        isSubtask: false,
                        // Distinguish this from a manual status flip so
                        // any future "undo" / UI hint can tell the user
                        // why the parent reopened.
                        autoReopened: true,
                        triggeringSubtaskId: task.id,
                        triggeringSubtaskTitle: task.title,
                    },
                });
                // Surface the auto-reopen in the bell so the parent's
                // assignee (and the previous "completer", if any) know
                // their closed task is open again. We skip emailing —
                // the cascade is mostly noise for non-assignees.
                if (parent.assigneeId && parent.assigneeId !== req.user.id) {
                    await notify({
                        recipientIds: [parent.assigneeId],
                        actorId: req.user.id,
                        type: 'TASK_STATUS_CHANGED',
                        title: `Reopened: ${parent.title}`,
                        body: `${
                            req.user.email
                        } added subtask "${task.title}" — parent task reopened.`,
                        projectId: task.projectId,
                        // Deep-link to the new subtask (parent is expanded
                        // in the plan when the hash targets a subtask id).
                        meta: {
                            taskId: task.id,
                            parentTaskId: parent.id,
                        },
                        emailRecipientIds: [],
                    });
                }
            } catch (reopenErr) {
                // Best-effort. Log and continue — subtask is already
                // created and the user's POST should still succeed.
                console.warn(
                    '[tasks] could not auto-reopen DONE parent on subtask add:',
                    reopenErr.message,
                );
            }
        }

        const involved = await projectParticipantIds(task.projectId);
        // Bell to every participant, but no email — the assignee
        // (when one exists) is already getting the dedicated
        // TASK_ASSIGNED email below, and we don't want to spam every
        // other participant for a brand-new task.
        await notify({
            recipientIds: involved,
            actorId: req.user.id,
            type: 'TASK_CREATED',
            title: isSubtask
                ? `${task.project.name}: new subtask`
                : `${task.project.name}: new task`,
            body: isSubtask
                ? `${req.user.email} added "${task.title}" under "${parent.title}".`
                : `${req.user.email} added "${task.title}".`,
            projectId: task.projectId,
            meta: {
                taskId: task.id,
                parentTaskId: task.parentTaskId,
            },
            emailRecipientIds: [],
        });

        if (task.assigneeId && task.assigneeId !== req.user.id) {
            await notify({
                recipientIds: [task.assigneeId],
                actorId: req.user.id,
                type: 'TASK_ASSIGNED',
                title: `Assigned to you: ${task.title}`,
                body: `${req.user.email} assigned a ${
                    isSubtask ? 'subtask' : 'task'
                } to you on ${task.project.name}.`,
                projectId: task.projectId,
                meta: {
                    taskId: task.id,
                    parentTaskId: task.parentTaskId,
                },
            });
        }

        // Persist a TASK_CREATED audit row so the Activities feed shows
        // who added the task / subtask, even when the actor is the only
        // participant on the project.
        await logActivityEvent({
            type: 'TASK_CREATED',
            actorId: req.user.id,
            projectId: task.projectId,
            taskId: task.id,
            message: task.title,
            meta: {
                isSubtask,
                parentTaskId: task.parentTaskId,
                parentTitle: parent ? parent.title : null,
                assigneeId: task.assigneeId || null,
            },
        });

        // Live update for everyone with this project page open.
        emitProjectPlanChanged(task.projectId, {
            kind: isSubtask ? 'subtask-created' : 'task-created',
            taskId: task.id,
            parentTaskId: task.parentTaskId,
            actorId: req.user.id,
            actorName: req.user.name || req.user.email,
            title: task.title,
        });

        res.status(201).json({ task });
    } catch (err) {
        next(err);
    }
});

// POST /api/tasks/:id/duplicate — clone a single task so the same work
// can be handed to another user. Copies the editable fields (title +
// " (copy)", description, priority, due date, phase, sprint, estimate,
// parent, CR), resets status to TODO, and stamps a fresh per-project
// code. It intentionally does NOT copy subtasks, comments, time entries,
// attachments, or the source-ticket link. The new copy keeps the source
// assignee so the caller can simply re-point it at whoever should do it.
router.post('/:id/duplicate', async (req, res, next) => {
    try {
        const source = await loadTaskOr404(req.params.id);
        const project = source.project;
        const isOwnPersonal =
            project?.isPersonal && project.ownerId === req.user.id;
        if (
            !isOwnPersonal &&
            !isAdminOrManagerOrHasCapability(req, CAPABILITIES.TASK_CREATE_ANY)
        ) {
            throw httpError(
                403,
                'Only admins, managers, or users with task-create permission can duplicate tasks',
            );
        }
        await assertProjectWritable(req, source.projectId, 'duplicate a task');

        // Specific (approval-required) tasks can't be copied — each must be
        // raised and approved on its own.
        if (source.specific) {
            throw httpError(
                400,
                'Specific (approval-required) tasks cannot be duplicated.',
            );
        }

        const task = await prisma.task.create({
            data: {
                title: `${source.title} (copy)`,
                description: source.description,
                status: 'TODO',
                priority: source.priority,
                dueDate: source.dueDate,
                projectId: source.projectId,
                assigneeId: source.assigneeId || null,
                phaseId: source.phaseId,
                sprintId: source.sprintId,
                estimateHours: source.estimateHours,
                parentTaskId: source.parentTaskId,
                changeRequestId: source.changeRequestId,
                sourceTicketId: null,
                order: source.order,
                createdById: req.user.id,
            },
            include: taskInclude,
        });

        // Stamp a fresh code, same approach as create (best-effort).
        try {
            const code = await generateTaskCode(prisma, {
                projectId: task.projectId,
                parentTaskId: task.parentTaskId,
                changeRequestId: task.changeRequestId,
            });
            const stamped = await prisma.task.update({
                where: { id: task.id },
                data: { code },
            });
            task.code = stamped.code;
        } catch (codeErr) {
            console.warn(
                '[tasks] could not stamp duplicated task code:',
                codeErr.message,
            );
        }

        await ensureProjectParticipant(task.projectId, req.user.id, req.user.id);
        if (task.assigneeId) {
            await ensureProjectParticipant(
                task.projectId,
                task.assigneeId,
                req.user.id,
            );
        }

        await logActivityEvent({
            type: 'TASK_CREATED',
            actorId: req.user.id,
            projectId: task.projectId,
            taskId: task.id,
            message: task.title,
            meta: {
                isSubtask: Boolean(task.parentTaskId),
                parentTaskId: task.parentTaskId,
                duplicatedFromId: source.id,
                duplicatedFromCode: source.code || null,
            },
        });

        // Tell the assignee (when it isn't the actor) they have a new task.
        if (task.assigneeId && task.assigneeId !== req.user.id) {
            await notify({
                recipientIds: [task.assigneeId],
                actorId: req.user.id,
                type: 'TASK_ASSIGNED',
                title: `Assigned to you: ${task.title}`,
                body: `${req.user.email} duplicated a task to you on ${task.project.name}.`,
                projectId: task.projectId,
                meta: { taskId: task.id, parentTaskId: task.parentTaskId },
            });
        }

        emitProjectPlanChanged(task.projectId, {
            kind: task.parentTaskId ? 'subtask-created' : 'task-created',
            taskId: task.id,
            parentTaskId: task.parentTaskId,
            actorId: req.user.id,
            actorName: req.user.name || req.user.email,
            title: task.title,
        });

        res.status(201).json({ task });
    } catch (err) {
        next(err);
    }
});

// GET /api/tasks/lookup?q=…&projectId=…&limit=8
//
// Lightweight picker endpoint used by the `/` deep-link slash menu in
// MentionTextarea. Returns at most 12 rows of the smallest task shape
// the popover needs ({ id, code, title, projectId, projectName,
// isSubtask, parentCode }). Capped at 12 rows so the popover stays
// snappy and one request fits in a single network frame.
//
// Search strategy: prefix-match on code (most useful when the user
// already knows it — they typed e.g. `/T-04`), then substring-match
// on title. Code matches always lead the result list because that's
// what users typically reach for first.
router.get('/lookup', async (req, res, next) => {
    try {
        const rawQ = String(req.query.q || '').trim();
        const limit = Math.max(
            1,
            Math.min(12, Number.parseInt(req.query.limit, 10) || 8),
        );

        // Opt-in: also surface matching PROJECTS in the results (chat
        // references pass `includeProjects=1`; the notes `/` picker
        // omits it so its behaviour is unchanged). Read-only + additive.
        const includeProjects = /^(1|true|yes)$/i.test(
            String(req.query.includeProjects || ''),
        );

        let where;
        let scopeIds;
        if (req.query.projectId) {
            await assertProjectRead(req, String(req.query.projectId));
            scopeIds = [String(req.query.projectId)];
            where = { projectId: String(req.query.projectId) };
        } else {
            scopeIds = await accessibleProjectIds(req);
            where = { projectId: { in: scopeIds } };
        }

        const findProjects = async () => {
            if (!includeProjects) return [];
            const pWhere = !rawQ
                ? { id: { in: scopeIds } }
                : {
                      id: { in: scopeIds },
                      OR: [
                          { code: { startsWith: rawQ, mode: 'insensitive' } },
                          { name: { contains: rawQ, mode: 'insensitive' } },
                      ],
                  };
            const rows = await prisma.project.findMany({
                where: pWhere,
                orderBy: { updatedAt: 'desc' },
                take: limit,
                select: { id: true, code: true, name: true },
            });
            return rows.map(toProjectLookupRow);
        };

        // Empty query: just return the most recently updated rows in
        // the caller's scope so the picker is useful on the very
        // first `/` keystroke. Most users will type something though.
        const baseSelect = {
            id: true,
            code: true,
            title: true,
            projectId: true,
            parentTaskId: true,
            // Relation on parentTaskId is named `parent` (see Task model
            // in schema.prisma — `@relation("Subtasks")`). Using the
            // wrong name throws a Prisma validation error.
            parent: { select: { code: true } },
            project: { select: { name: true, code: true } },
            updatedAt: true,
        };

        if (!rawQ) {
            const [rows, projects] = await Promise.all([
                prisma.task.findMany({
                    where,
                    orderBy: { updatedAt: 'desc' },
                    take: limit,
                    select: baseSelect,
                }),
                findProjects(),
            ]);
            return res.json({
                results: [...rows.map(toLookupRow), ...projects].slice(
                    0,
                    limit,
                ),
            });
        }

        // Two-step search: codes first (so typing `/T-` and a few
        // digits ranks code matches at the top), then titles. We
        // dedupe by id so a row that matches both shows up once.
        const [byCode, byTitle] = await Promise.all([
            prisma.task.findMany({
                where: {
                    ...where,
                    code: { startsWith: rawQ, mode: 'insensitive' },
                },
                orderBy: { code: 'asc' },
                take: limit,
                select: baseSelect,
            }),
            prisma.task.findMany({
                where: {
                    ...where,
                    title: { contains: rawQ, mode: 'insensitive' },
                },
                orderBy: { updatedAt: 'desc' },
                take: limit,
                select: baseSelect,
            }),
        ]);

        const projects = await findProjects();
        const seen = new Set();
        const merged = [];
        for (const r of [...byCode, ...byTitle]) {
            if (seen.has(r.id)) continue;
            seen.add(r.id);
            merged.push(toLookupRow(r));
        }
        // Task code/title matches first, then any project matches, capped
        // to `limit` so the popover stays snappy.
        res.json({ results: [...merged, ...projects].slice(0, limit) });
    } catch (err) {
        next(err);
    }
});

function toLookupRow(r) {
    return {
        id: r.id,
        code: r.code || null,
        title: r.title,
        projectId: r.projectId,
        projectName: r.project?.name || null,
        projectCode: r.project?.code || null,
        isSubtask: Boolean(r.parentTaskId),
        parentCode: r.parent?.code || null,
    };
}

// GET /api/tasks/pending-approval
//
// Central list of "specific" tasks that are awaiting approval (specific
// && approvedAt === null) inside projects the caller can see. Feeds the
// Requests hub's "Task approvals" tab. Approving still goes through
// POST /:id/approve (admin / manager / task:approve), but everyone who
// can read the project can SEE what's pending here.
router.get('/pending-approval', async (req, res, next) => {
    try {
        const scopeIds = await accessibleProjectIds(req);
        const tasks = await prisma.task.findMany({
            where: {
                projectId: { in: scopeIds },
                specific: true,
                approvedAt: null,
            },
            orderBy: { createdAt: 'asc' },
            include: taskInclude,
        });
        res.json({
            tasks,
            canApprove: isAdminOrManagerOrHasCapability(
                req,
                CAPABILITIES.TASK_APPROVE,
            ),
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/tasks/pending-approval/count — sidebar badge helper.
router.get('/pending-approval/count', async (req, res, next) => {
    try {
        const scopeIds = await accessibleProjectIds(req);
        const count = await prisma.task.count({
            where: {
                projectId: { in: scopeIds },
                specific: true,
                approvedAt: null,
            },
        });
        res.json({ count });
    } catch (err) {
        next(err);
    }
});

// Lookup row for a PROJECT match (when includeProjects is set). Shaped
// to mirror toLookupRow so the picker renders it uniformly; `isProject`
// lets the UI badge it and the renderer link it to the project page.
function toProjectLookupRow(p) {
    return {
        id: p.id,
        code: p.code || null,
        title: p.name,
        projectId: p.id,
        projectName: null,
        projectCode: p.code || null,
        isSubtask: false,
        isProject: true,
        parentCode: null,
    };
}

// GET /api/tasks/resolve?codes=T-0042,ST-0007,PRJ-USA-0001/T-0001
//
// Batch resolver behind the inline `T-####` / `ST-####` linkifier in
// rendered notes. Given a comma-separated list of codes the renderer
// returns `{ codes: { "T-0042": { id, projectId, title, accessible }
// or null } }`. Null means "no such task in the caller's scope" — the
// renderer falls back to plain text in that case so notes copy-pasted
// across projects degrade gracefully.
//
// Codes may carry an optional project prefix joined by `/` (e.g.
// `PRJ-USA-0001/T-0042`). When present we constrain the lookup to
// that project; when absent we search across every project the
// caller can see, returning the first match.
router.get('/resolve', async (req, res, next) => {
    try {
        const raw = String(req.query.codes || '').trim();
        if (!raw) return res.json({ codes: {} });

        const requested = Array.from(
            new Set(
                raw
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .slice(0, 64),
            ),
        );

        const accessibleIds = await accessibleProjectIds(req);
        const accessibleSet = new Set(accessibleIds);

        // Split each request into (optional project ref, task code).
        const parts = requested.map((token) => {
            const idx = token.lastIndexOf('/');
            if (idx > 0) {
                return {
                    token,
                    projectCode: token.slice(0, idx),
                    taskCode: token.slice(idx + 1),
                };
            }
            return { token, projectCode: null, taskCode: token };
        });

        const uniqueTaskCodes = Array.from(
            new Set(parts.map((p) => p.taskCode)),
        );
        const uniqueProjectCodes = Array.from(
            new Set(parts.map((p) => p.projectCode).filter(Boolean)),
        );

        const [tasks, projects, standaloneProjects] = await Promise.all([
            prisma.task.findMany({
                where: {
                    code: { in: uniqueTaskCodes },
                    projectId: { in: accessibleIds },
                },
                select: {
                    id: true,
                    code: true,
                    title: true,
                    projectId: true,
                    project: { select: { code: true } },
                },
            }),
            uniqueProjectCodes.length > 0
                ? prisma.project.findMany({
                      where: { code: { in: uniqueProjectCodes } },
                      select: { id: true, code: true },
                  })
                : Promise.resolve([]),
            // Standalone project references: a bare token that is itself
            // a project code (e.g. `P26-USA-0001`) resolves to the
            // project page. Scoped to accessible projects only.
            prisma.project.findMany({
                where: {
                    code: { in: uniqueTaskCodes },
                    id: { in: accessibleIds },
                },
                select: { id: true, code: true, name: true },
            }),
        ]);

        const projectByCode = new Map(projects.map((p) => [p.code, p.id]));
        const standaloneProjectByCode = new Map(
            standaloneProjects.map((p) => [p.code, p]),
        );

        const result = {};
        for (const { token, projectCode, taskCode } of parts) {
            const candidates = tasks.filter((t) => t.code === taskCode);
            let pick = null;
            if (projectCode) {
                const wantedProjectId = projectByCode.get(projectCode);
                pick =
                    wantedProjectId &&
                    candidates.find((t) => t.projectId === wantedProjectId);
            } else {
                // No project prefix: pick the first accessible
                // candidate. Ambiguity is rare in practice (codes are
                // per-project, so two collisions only happen when the
                // same task number exists in multiple projects the
                // user can see).
                pick = candidates.find((t) => accessibleSet.has(t.projectId));
            }
            if (pick) {
                result[token] = {
                    id: pick.id,
                    projectId: pick.projectId,
                    title: pick.title,
                    code: pick.code,
                    projectCode: pick.project?.code || null,
                };
                continue;
            }
            // No task matched — if the bare token is itself a project
            // code, resolve it to the project page instead.
            if (!projectCode) {
                const proj = standaloneProjectByCode.get(taskCode);
                if (proj) {
                    result[token] = {
                        isProject: true,
                        id: proj.id,
                        projectId: proj.id,
                        title: proj.name,
                        code: proj.code,
                        projectCode: proj.code,
                    };
                    continue;
                }
            }
            result[token] = null;
        }
        res.json({ codes: result });
    } catch (err) {
        next(err);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        const task = await loadTaskOr404(req.params.id);
        await assertProjectRead(req, task.projectId);
        res.json({ task });
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', async (req, res, next) => {
    try {
        const existing = await loadTaskOr404(req.params.id);
        const data = updateTaskSchema.parse(req.body);
        const isSubtask = Boolean(existing.parentTaskId);

        // Cap title / description only when they're actually being CHANGED,
        // so a legacy over-limit value doesn't block edits to other fields.
        if (
            data.title !== undefined &&
            data.title !== existing.title &&
            data.title.length > 200
        ) {
            throw httpError(400, 'Title is too long (max 200 characters).');
        }
        if (
            data.description !== undefined &&
            (data.description || '') !== (existing.description || '') &&
            (data.description || '').length > 5000
        ) {
            throw httpError(
                400,
                'Description is too long (max 5000 characters).',
            );
        }

        // A "specific" task is FROZEN until approved: no field can be
        // edited (status, title, dates, assignee — anything) until an
        // approver signs off via POST /:id/approve. Only the approval
        // endpoint and deletion are allowed while locked.
        if (isTaskApprovalLocked(existing)) {
            throw httpError(
                403,
                'This task must be approved before it can be edited.',
            );
        }

        // Owners of personal projects get admin-equivalent edit rights
        // inside their own personal project (they need to be able to
        // rename / reschedule / delete their own organiser items).
        const isOwnPersonal =
            existing.project.isPersonal &&
            existing.project.ownerId === req.user.id;

        // Permission ladder:
        //   - ADMIN / MANAGER -> can edit any field on any task they
        //     can read (the project-read check below acts as a fence
        //     so managers can't poke at tasks in projects they're not
        //     in).
        //   - User with `task:edit:any` capability -> same edit rights
        //     as a manager. Lets admins delegate task curation to a
        //     trusted teammate via the capability checkbox without
        //     promoting their role globally.
        //   - Personal-project owner -> same as admin within that
        //     project.
        //   - User with `task:create:any` who CREATED this row ->
        //     same as admin for THIS row only. The cap is "manage
        //     tasks you create" so the creator can fix typos /
        //     re-assign / re-prioritise their own work without
        //     bothering an admin. Other users' tasks stay locked.
        //   - Anyone else -> can only flip `status`, and only on tasks
        //     they are the assignee of.
        const hasTaskEditAny = hasCapability(req, CAPABILITIES.TASK_EDIT_ANY);
        const isOwnCreation =
            existing.createdById &&
            existing.createdById === req.user.id &&
            hasCapability(req, CAPABILITIES.TASK_CREATE_ANY);
        if (
            !isAdminOrManager(req) &&
            !isOwnPersonal &&
            !hasTaskEditAny &&
            !isOwnCreation
        ) {
            const allowedKeys = new Set(['status']);
            const submittedKeys = Object.keys(data).filter(
                (k) => data[k] !== undefined,
            );
            const onlyStatus =
                submittedKeys.length > 0 &&
                submittedKeys.every((k) => allowedKeys.has(k));
            const isAssignee = existing.assigneeId === req.user.id;
            if (!onlyStatus || !isAssignee) {
                throw httpError(
                    403,
                    isAssignee
                        ? 'You can only change the status of tasks assigned to you'
                        : 'Only an administrator or manager can edit tasks',
                );
            }
            // Even an assignee must currently be a participant/owner of
            // the task's project. Without this check, a user who was
            // assigned a task and later removed from the project's
            // participant list could still flip its status (assignee
            // rows aren't cleared on participant removal).
            // `assertProjectWritable` additionally refuses edits when
            // the project is DONE/closed (admins/managers still pass).
            await assertProjectWritable(req, existing.projectId, 'edit this task');
        } else {
            // Managers must still be participants/owners of the project
            // the task lives in. Admins pass through unconditionally.
            // Closed-project writes are still gated through
            // `assertProjectWritable` so managers keep their override
            // but regular users (handled in the if-branch above) don't.
            await assertProjectWritable(req, existing.projectId, 'edit this task');
        }

        if (data.phaseId !== undefined) {
            if (isSubtask) {
                // Phase is dictated by the parent task; ignore client overrides
                // so the row keeps grouping under its parent.
                delete data.phaseId;
            } else {
                await ensurePhaseInProject(data.phaseId, existing.projectId);
            }
        }

        if (isSubtask && data.assigneeId !== undefined && data.assigneeId) {
            await ensureAssigneeIsParticipant(existing.projectId, data.assigneeId);
        }

        // CR re-scoping: validate the new CR belongs to the same
        // project; subtasks ignore client overrides — they always
        // inherit their parent's CR scope (set when the subtask was
        // created and silently kept in sync if the parent's CR
        // changes via the patch below). Passing `changeRequestId:
        // null` is the explicit way to detach a task from a CR.
        if (data.changeRequestId !== undefined) {
            if (isSubtask) {
                delete data.changeRequestId;
            } else if (data.changeRequestId) {
                await ensureCRInProject(
                    data.changeRequestId,
                    existing.projectId,
                );
            }
        }

        const updateData = { ...data };
        if (data.phaseId !== undefined) updateData.phaseId = data.phaseId || null;
        if (data.assigneeId !== undefined)
            updateData.assigneeId = data.assigneeId || null;
        if (data.changeRequestId !== undefined) {
            updateData.changeRequestId = data.changeRequestId || null;
        }

        const task = await prisma.task.update({
            where: { id: req.params.id },
            data: updateData,
            include: taskInclude,
        });

        // If a parent task's CR scope changed, cascade the new scope
        // to all its subtasks so the family stays together (subtasks
        // belong to whichever CR the parent belongs to). No-op when
        // the value didn't change or when the row IS a subtask
        // (subtasks can't drive cascade by design).
        if (
            !isSubtask &&
            updateData.changeRequestId !== undefined &&
            updateData.changeRequestId !== existing.changeRequestId
        ) {
            await prisma.task.updateMany({
                where: { parentTaskId: task.id },
                data: { changeRequestId: updateData.changeRequestId },
            });
        }

        if (
            data.assigneeId !== undefined &&
            data.assigneeId &&
            data.assigneeId !== existing.assigneeId
        ) {
            await ensureProjectParticipant(
                task.projectId,
                data.assigneeId,
                req.user.id,
            );
        }

        // Tracks subtask rows that were touched by an automatic
        // parent → subtask cascade (in either direction). Returned to
        // the client at the end of the request so the FE can splice
        // the updates into local state without a refetch.
        let affectedSubtasks = [];

        if (data.status && data.status !== existing.status) {
            const isParent = !existing.parentTaskId;
            // Compute the cascade BEFORE we write the parent's audit
            // row so we can record exactly which subtasks were touched
            // (and what their previous status was). When the user later
            // un-completes the parent, we read this list back to revert
            // only the subtasks the cascade actually changed — leaving
            // pre-existing "done" subtasks alone.
            let cascadedSubtasksMeta = [];
            if (isParent && data.status === 'DONE') {
                const openSubtasks = await prisma.task.findMany({
                    where: {
                        parentTaskId: task.id,
                        status: { not: 'DONE' },
                    },
                    select: { id: true, title: true, status: true },
                });
                if (openSubtasks.length) {
                    await prisma.task.updateMany({
                        where: { id: { in: openSubtasks.map((s) => s.id) } },
                        data: { status: 'DONE' },
                    });
                    cascadedSubtasksMeta = openSubtasks.map((s) => ({
                        id: s.id,
                        previousStatus: s.status,
                    }));
                    affectedSubtasks = openSubtasks.map((s) => ({
                        id: s.id,
                        status: 'DONE',
                    }));
                    // One audit row per cascaded subtask so the
                    // Activities feed / per-task history stays accurate.
                    await Promise.all(
                        openSubtasks.map((sub) =>
                            logActivityEvent({
                                type: 'TASK_STATUS_CHANGED',
                                actorId: req.user.id,
                                projectId: task.projectId,
                                taskId: sub.id,
                                fromValue: sub.status,
                                toValue: 'DONE',
                                message: sub.title,
                                meta: {
                                    parentTaskId: task.id,
                                    isSubtask: true,
                                    cascadedFromParent: true,
                                },
                            }),
                        ),
                    );
                }
            }

            // Reverse cascade: un-completing a parent should undo only
            // the subtasks the matching cascade-DONE event auto-checked.
            // We look up the most recent TASK_STATUS_CHANGED audit row
            // for THIS parent that flipped it to DONE, read its
            // `cascadedSubtasks` meta, and revert each subtask to its
            // recorded previous status — but only if the subtask is
            // still DONE (otherwise the user already manually moved it
            // and we shouldn't second-guess them).
            let revertedSubtasksMeta = [];
            if (isParent && existing.status === 'DONE' && data.status !== 'DONE') {
                const lastDoneEvent = await prisma.activityEvent.findFirst({
                    where: {
                        type: 'TASK_STATUS_CHANGED',
                        taskId: task.id,
                        toValue: 'DONE',
                    },
                    orderBy: { createdAt: 'desc' },
                    select: { meta: true },
                });
                const cascadeList = Array.isArray(
                    lastDoneEvent?.meta?.cascadedSubtasks,
                )
                    ? lastDoneEvent.meta.cascadedSubtasks
                    : [];
                if (cascadeList.length) {
                    const subIds = cascadeList.map((c) => c.id).filter(Boolean);
                    const liveSubs = subIds.length
                        ? await prisma.task.findMany({
                              where: {
                                  id: { in: subIds },
                                  parentTaskId: task.id,
                                  status: 'DONE',
                              },
                              select: { id: true, title: true, status: true },
                          })
                        : [];
                    const prevById = new Map(
                        cascadeList.map((c) => [c.id, c.previousStatus]),
                    );
                    // Group reverts by target status so each revert
                    // happens in a single updateMany.
                    const buckets = new Map();
                    for (const sub of liveSubs) {
                        const target = prevById.get(sub.id) || 'TODO';
                        if (!buckets.has(target)) buckets.set(target, []);
                        buckets.get(target).push(sub);
                    }
                    for (const [target, subs] of buckets) {
                        await prisma.task.updateMany({
                            where: { id: { in: subs.map((s) => s.id) } },
                            data: { status: target },
                        });
                        revertedSubtasksMeta.push(
                            ...subs.map((s) => ({
                                id: s.id,
                                fromStatus: 'DONE',
                                toStatus: target,
                            })),
                        );
                        affectedSubtasks.push(
                            ...subs.map((s) => ({ id: s.id, status: target })),
                        );
                    }
                    // Per-subtask audit rows so the feed shows the
                    // revert symmetrically with the cascade.
                    await Promise.all(
                        revertedSubtasksMeta.map((entry) =>
                            logActivityEvent({
                                type: 'TASK_STATUS_CHANGED',
                                actorId: req.user.id,
                                projectId: task.projectId,
                                taskId: entry.id,
                                fromValue: entry.fromStatus,
                                toValue: entry.toStatus,
                                message:
                                    liveSubs.find((s) => s.id === entry.id)
                                        ?.title || null,
                                meta: {
                                    parentTaskId: task.id,
                                    isSubtask: true,
                                    cascadedFromParent: true,
                                    cascadeReverted: true,
                                },
                            }),
                        ),
                    );
                }
            }

            const involved = await projectParticipantIds(task.projectId);
            const cascadeSuffix =
                cascadedSubtasksMeta.length > 0
                    ? ` (${cascadedSubtasksMeta.length} subtask${
                          cascadedSubtasksMeta.length === 1 ? '' : 's'
                      } auto-completed)`
                    : revertedSubtasksMeta.length > 0
                        ? ` (${revertedSubtasksMeta.length} subtask${
                              revertedSubtasksMeta.length === 1 ? '' : 's'
                          } reopened)`
                        : '';
            // Bell to every participant; email only the assignee
            // (delivered via notifyAssigneePersonal below).
            await notify({
                recipientIds: involved,
                actorId: req.user.id,
                type: 'TASK_STATUS_CHANGED',
                title: `${task.project.name}: ${task.title}`,
                body: `${req.user.email} moved status to ${
                    TASK_STATUS_LABELS[data.status] || data.status
                }${cascadeSuffix}.`,
                projectId: task.projectId,
                meta: { taskId: task.id },
                emailRecipientIds: [],
            });

            await notifyAssigneePersonal({
                taskId: task.id,
                actorId: req.user.id,
                actorLabel: req.user.name || req.user.email,
                type: 'TASK_STATUS_CHANGED',
                actionDescription: 'changed the status of',
                detail: `Now ${TASK_STATUS_LABELS[data.status] || data.status}.`,
                projectId: task.projectId,
                meta: { taskId: task.id },
            });

            // Persist a durable audit row so the Activities feed picks
            // it up even when the actor is the only participant (notify
            // skips fan-out to the actor themselves). For a parent
            // that just transitioned into DONE, attach the cascade
            // descriptor so the inverse transition can undo exactly
            // what we just did.
            await logActivityEvent({
                type: 'TASK_STATUS_CHANGED',
                actorId: req.user.id,
                projectId: task.projectId,
                taskId: task.id,
                fromValue: existing.status,
                toValue: data.status,
                message: task.title,
                meta: {
                    parentTaskId: task.parentTaskId,
                    isSubtask: Boolean(task.parentTaskId),
                    cascadedSubtasks: cascadedSubtasksMeta,
                    revertedSubtasks: revertedSubtasksMeta,
                },
            });
        }

        // Top-level tasks only — subtasks inherit their parent's phase
        // and we strip phaseId from `data` above, so this branch never
        // triggers for subtasks.
        if (
            data.phaseId !== undefined &&
            (data.phaseId || null) !== (existing.phaseId || null)
        ) {
            const phaseIds = [existing.phaseId, data.phaseId].filter(Boolean);
            const phases = phaseIds.length
                ? await prisma.phase.findMany({
                      where: { id: { in: phaseIds } },
                      select: { id: true, name: true },
                  })
                : [];
            const nameById = new Map(phases.map((p) => [p.id, p.name]));
            const fromName = existing.phaseId
                ? nameById.get(existing.phaseId) || 'Unphased'
                : 'Unphased';
            const toName = data.phaseId
                ? nameById.get(data.phaseId) || 'Unphased'
                : 'Unphased';

            const involved = await projectParticipantIds(task.projectId);
            // Bell to every participant; email only the assignee.
            await notify({
                recipientIds: involved,
                actorId: req.user.id,
                type: 'TASK_STATUS_CHANGED',
                title: `${task.project.name}: ${task.title}`,
                body: `${req.user.email} moved this task from "${fromName}" to "${toName}".`,
                projectId: task.projectId,
                meta: { taskId: task.id, phaseChange: true },
                emailRecipientIds: [],
            });

            await notifyAssigneePersonal({
                taskId: task.id,
                actorId: req.user.id,
                actorLabel: req.user.name || req.user.email,
                type: 'TASK_STATUS_CHANGED',
                actionDescription: 'moved the phase of',
                detail: `From "${fromName}" to "${toName}".`,
                projectId: task.projectId,
                meta: { taskId: task.id, phaseChange: true },
            });

            await logActivityEvent({
                type: 'TASK_PHASE_CHANGED',
                actorId: req.user.id,
                projectId: task.projectId,
                taskId: task.id,
                fromValue: fromName,
                toValue: toName,
                message: task.title,
                meta: {
                    fromPhaseId: existing.phaseId || null,
                    toPhaseId: data.phaseId || null,
                },
            });
        }

        // Assignee change: notify the new assignee directly AND fan out
        // a TASK_ASSIGNEE_CHANGED activity row so the audit feed shows
        // who was reassigned (and from whom). Clearing the assignee
        // (data.assigneeId === null/'') is also worth recording.
        if (
            data.assigneeId !== undefined &&
            (data.assigneeId || null) !== (existing.assigneeId || null)
        ) {
            if (data.assigneeId && data.assigneeId !== req.user.id) {
                await notify({
                    recipientIds: [data.assigneeId],
                    actorId: req.user.id,
                    type: 'TASK_ASSIGNED',
                    title: `Assigned to you: ${task.title}`,
                    body: `${req.user.email} assigned a ${
                        isSubtask ? 'subtask' : 'task'
                    } to you on ${task.project.name}.`,
                    projectId: task.projectId,
                    meta: { taskId: task.id },
                });
            }

            const personIds = [existing.assigneeId, data.assigneeId].filter(
                Boolean,
            );
            const persons = personIds.length
                ? await prisma.user.findMany({
                      where: { id: { in: personIds } },
                      select: { id: true, name: true, email: true },
                  })
                : [];
            const nameById = new Map(
                persons.map((p) => [p.id, p.name || p.email || p.id]),
            );
            const fromName = existing.assigneeId
                ? nameById.get(existing.assigneeId) || 'Unassigned'
                : 'Unassigned';
            const toName = data.assigneeId
                ? nameById.get(data.assigneeId) || 'Unassigned'
                : 'Unassigned';

            const involved = await projectParticipantIds(task.projectId);
            // Bell to every participant; no email here — the new
            // assignee already received the TASK_ASSIGNED email above
            // and that's the only email the user wants for a
            // reassignment.
            await notify({
                recipientIds: involved,
                actorId: req.user.id,
                type: 'TASK_UPDATED',
                title: `${task.project.name}: ${task.title}`,
                body: `${req.user.email} reassigned this ${
                    isSubtask ? 'subtask' : 'task'
                } from ${fromName} to ${toName}.`,
                projectId: task.projectId,
                meta: { taskId: task.id, assigneeChange: true },
                emailRecipientIds: [],
            });

            await logActivityEvent({
                type: 'TASK_ASSIGNEE_CHANGED',
                actorId: req.user.id,
                projectId: task.projectId,
                taskId: task.id,
                fromValue: fromName,
                toValue: toName,
                message: task.title,
                meta: {
                    fromAssigneeId: existing.assigneeId || null,
                    toAssigneeId: data.assigneeId || null,
                    isSubtask,
                },
            });
        }

        if (
            data.dueDate !== undefined &&
            String(data.dueDate || '') !== String(existing.dueDate || '')
        ) {
            const involved = await projectParticipantIds(task.projectId);
            const fromValue = existing.dueDate
                ? new Date(existing.dueDate).toDateString()
                : 'no due date';
            const toValue = data.dueDate
                ? new Date(data.dueDate).toDateString()
                : 'no due date';
            // Option 1: assignee gets the personalised email below
            // (notifyAssigneePersonal). Suppress the duplicate
            // participant email for them so they receive one inbox
            // message per change, not two.
            await notify({
                recipientIds: involved,
                actorId: req.user.id,
                type: 'TASK_DUE_DATE_CHANGED',
                title: `${task.project.name}: ${task.title}`,
                body: data.dueDate
                    ? `${req.user.email} set due date to ${toValue}.`
                    : `${req.user.email} cleared the due date.`,
                projectId: task.projectId,
                meta: { taskId: task.id },
                emailRecipientIds: task.assigneeId
                    ? involved.filter((id) => id !== task.assigneeId)
                    : undefined,
            });

            await notifyAssigneePersonal({
                taskId: task.id,
                actorId: req.user.id,
                actorLabel: req.user.name || req.user.email,
                type: 'TASK_DUE_DATE_CHANGED',
                actionDescription: data.dueDate
                    ? 'changed the due date of'
                    : 'cleared the due date of',
                detail: data.dueDate
                    ? `Now due ${toValue} (was ${fromValue}).`
                    : `Previously ${fromValue}.`,
                projectId: task.projectId,
                meta: { taskId: task.id },
            });

            await logActivityEvent({
                type: 'TASK_DUE_DATE_CHANGED',
                actorId: req.user.id,
                projectId: task.projectId,
                taskId: task.id,
                fromValue,
                toValue,
                message: task.title,
                meta: { isSubtask },
            });
        }

        // Catch-all for the "free text" fields (title, description,
        // priority). Without this, edits to a task body silently went
        // unnoticed by the rest of the team. We collapse all changed
        // fields into a single notification + activity row to avoid
        // spamming people when an editor saves several at once.
        const detailFields = diffTaskDetailFields(existing, data);
        if (detailFields.length) {
            const noun = isSubtask ? 'subtask' : 'task';

            const fromSnapshot = {};
            const toSnapshot = {};
            for (const key of detailFields) {
                if (key === 'priority') {
                    fromSnapshot[key] =
                        TASK_PRIORITY_LABELS[existing[key]] ||
                        existing[key] ||
                        null;
                    toSnapshot[key] =
                        TASK_PRIORITY_LABELS[data[key]] || data[key] || null;
                } else {
                    fromSnapshot[key] = existing[key] || null;
                    toSnapshot[key] = data[key] || null;
                }
            }

            // Friendly-print a single field's before/after so the bell
            // notification reads "renamed task from A to B" instead of
            // the abstract "updated the title of this task". For
            // multi-field saves we fall back to a list of the field
            // labels (printing the full diff would blow past two lines
            // in the bell popover).
            const trim = (v, max = 80) => {
                if (v == null) return '—';
                const s = String(v).replace(/\s+/g, ' ').trim();
                if (!s) return '—';
                return s.length > max ? `${s.slice(0, max - 1)}…` : s;
            };
            let body;
            if (detailFields.length === 1) {
                const key = detailFields[0];
                const label = TASK_DETAIL_LABELS[key];
                const from = trim(fromSnapshot[key]);
                const to = trim(toSnapshot[key]);
                if (key === 'title') {
                    body = `${req.user.email} renamed ${noun} from "${from}" to "${to}".`;
                } else if (key === 'description') {
                    body = fromSnapshot[key]
                        ? `${req.user.email} edited the description of this ${noun}.`
                        : `${req.user.email} added a description to this ${noun}.`;
                } else {
                    body = `${req.user.email} changed ${label} from ${from} to ${to}.`;
                }
            } else {
                const labelList = detailFields
                    .map((k) => TASK_DETAIL_LABELS[k])
                    .join(', ');
                body = `${req.user.email} updated the ${labelList} of this ${noun}.`;
            }

            const involved = await projectParticipantIds(task.projectId);
            // Option 1: assignee gets the personalised email below;
            // skip them in the participant email batch so they only
            // get one inbox message per edit.
            await notify({
                recipientIds: involved,
                actorId: req.user.id,
                type: 'TASK_UPDATED',
                title: `${task.project.name}: ${task.title}`,
                body,
                projectId: task.projectId,
                meta: {
                    taskId: task.id,
                    fields: detailFields,
                    fieldLabels: detailFields.map(
                        (k) => TASK_DETAIL_LABELS[k],
                    ),
                    from: fromSnapshot,
                    to: toSnapshot,
                    isSubtask,
                },
                emailRecipientIds: task.assigneeId
                    ? involved.filter((id) => id !== task.assigneeId)
                    : undefined,
            });

            // Personalised heads-up for the assignee. We summarise as
            // either "edited <field>" or "updated <list>" so the bell
            // entry stays compact even when many fields changed.
            const assigneeAction =
                detailFields.length === 1
                    ? `edited the ${TASK_DETAIL_LABELS[detailFields[0]]} of`
                    : 'updated';
            await notifyAssigneePersonal({
                taskId: task.id,
                actorId: req.user.id,
                actorLabel: req.user.name || req.user.email,
                type: 'TASK_UPDATED',
                actionDescription: assigneeAction,
                detail:
                    detailFields.length > 1
                        ? `Fields: ${detailFields.map((k) => TASK_DETAIL_LABELS[k]).join(', ')}.`
                        : undefined,
                projectId: task.projectId,
                meta: { taskId: task.id, fields: detailFields, isSubtask },
            });

            await logActivityEvent({
                type: 'TASK_UPDATED',
                actorId: req.user.id,
                projectId: task.projectId,
                taskId: task.id,
                message: task.title,
                meta: {
                    fields: detailFields,
                    fieldLabels: detailFields.map(
                        (k) => TASK_DETAIL_LABELS[k],
                    ),
                    from: fromSnapshot,
                    to: toSnapshot,
                    isSubtask,
                },
            });
        }

        // `affectedSubtasks` carries any rows that were auto-modified
        // by a parent → subtasks cascade (in either direction). The FE
        // uses it to splice updates into local state without refetching.

        // Broadcast to every other client viewing this project so their
        // local copy of the plan picks up the edit (or shows the
        // reload button). Single event regardless of how many fields
        // changed in this PATCH — the FE just needs to know the plan
        // shape moved.
        emitProjectPlanChanged(task.projectId, {
            kind: isSubtask ? 'subtask-updated' : 'task-updated',
            taskId: task.id,
            parentTaskId: task.parentTaskId,
            actorId: req.user.id,
            actorName: req.user.name || req.user.email,
            title: task.title,
            affectedSubtaskIds: affectedSubtasks.map((s) => s.id),
        });

        res.json({ task, affectedSubtasks });
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', async (req, res, next) => {
    try {
        const existing = await loadTaskOr404(req.params.id);
        // Personal-project owners can delete their own tasks; for
        // everyone else this stays admin/manager only.
        const isOwnPersonal =
            existing.project.isPersonal &&
            existing.project.ownerId === req.user.id;
        // Admins, managers, the personal-project owner, the original
        // creator (when they hold `task:create:any` — same "manage
        // tasks you create" deal as the edit ladder), OR a user who
        // has been granted the `task:delete:any` capability checkbox.
        // assertProjectRead below still fences managers / capability
        // holders to projects they actually belong to.
        const isOwnCreation =
            existing.createdById &&
            existing.createdById === req.user.id &&
            hasCapability(req, CAPABILITIES.TASK_CREATE_ANY);
        if (
            !isOwnPersonal &&
            !isOwnCreation &&
            !isAdminOrManagerOrHasCapability(req, CAPABILITIES.TASK_DELETE_ANY)
        ) {
            throw httpError(
                403,
                'Only admins, managers, the task creator, or users with task-delete permission can delete tasks',
            );
        }
        await assertProjectWritable(req, existing.projectId, 'delete this task');

        const isSubtask = Boolean(existing.parentTaskId);
        const projectName = existing.project?.name || 'project';

        // SOFT-DELETE — set deletedAt instead of physically removing
        // the row. This:
        //   - preserves the task's notes, time entries and
        //     reassignment history so a restore brings them back
        //     automatically;
        //   - cascades to any live subtasks via a single transaction
        //     keyed on the SAME deletedAt timestamp, so the restore
        //     endpoint can later identify "what got deleted with
        //     this parent" precisely;
        //   - keeps the parent's `deletedAt` IDENTICAL to its
        //     subtasks' to make the cascade restore SQL trivial.
        // The Prisma client extension auto-filters deletedAt=null on
        // every Task read so the row stays invisible to the regular
        // plan / sprint / search views until restored.
        const deletedAt = new Date();
        await prisma.$transaction(async (tx) => {
            await tx.task.update({
                where: { id: existing.id },
                data: { deletedAt },
            });
            // For top-level tasks: also soft-delete their live
            // subtasks so the deletion presents as a single
            // operation. For subtask deletions the parent stays
            // alive — only this specific row is marked.
            if (!isSubtask) {
                await tx.task.updateMany({
                    where: {
                        parentTaskId: existing.id,
                        deletedAt: null,
                    },
                    data: { deletedAt },
                });
            }
        });

        const involved = await projectParticipantIds(existing.projectId);
        await notify({
            recipientIds: involved,
            actorId: req.user.id,
            type: 'TASK_DELETED',
            title: `${projectName}: ${
                isSubtask ? 'subtask' : 'task'
            } deleted`,
            body: `${req.user.email} deleted "${existing.title}".`,
            projectId: existing.projectId,
            // The task no longer exists; intentionally omit taskId from
            // meta so clients don't try to deep-link into a 404.
            meta: {
                isSubtask,
                parentTaskId: existing.parentTaskId || null,
            },
        });

        await logActivityEvent({
            type: 'TASK_DELETED',
            actorId: req.user.id,
            projectId: existing.projectId,
            // Same reason as above: the row is gone, so don't FK-reference
            // it from the audit row.
            taskId: null,
            message: existing.title,
            meta: {
                isSubtask,
                parentTaskId: existing.parentTaskId || null,
                deletedTaskId: existing.id,
            },
        });

        emitProjectPlanChanged(existing.projectId, {
            kind: isSubtask ? 'subtask-deleted' : 'task-deleted',
            taskId: existing.id,
            parentTaskId: existing.parentTaskId || null,
            actorId: req.user.id,
            actorName: req.user.name || req.user.email,
            title: existing.title,
        });

        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
});

// ---------------------------------------------------------------------------
// POST /tasks/:id/restore — undo a previous soft delete.
// ---------------------------------------------------------------------------
// Anyone who could have DELETED the task is allowed to put it back
// (admin / manager / personal-project owner / `task:delete:any` holder /
// the task's original creator if they hold `task:create:any`). The
// restore looks specifically at SOFT-DELETED rows by passing an
// explicit `deletedAt: { not: null }` filter — the client extension
// only auto-injects `deletedAt: null` when the caller hasn't said
// otherwise, so this lookup bypasses the regular invisibility.
//
// Subtasks that were soft-deleted in the SAME transaction (matching
// parent id + identical deletedAt timestamp) are restored together
// so the user gets back the full sub-tree they accidentally trashed.
router.post('/:id/restore', async (req, res, next) => {
    try {
        // Bypass the soft-delete read filter so we can find the row.
        const existing = await prisma.task.findFirst({
            where: { id: req.params.id, deletedAt: { not: null } },
            include: {
                project: {
                    select: { id: true, name: true, isPersonal: true, ownerId: true },
                },
            },
        });
        if (!existing) {
            // Look up the row WITHOUT the deletedAt filter so we can
            // tell the caller WHY the restore failed instead of a
            // generic 404 — was the task hard-deleted (truly missing),
            // already restored (live row exists), or did the id never
            // exist at all? Each path gets a distinct message so the
            // FE toast is actually actionable.
            const probe = await prisma.task.findFirst({
                where: { id: req.params.id, deletedAt: undefined },
                select: { id: true, deletedAt: true, projectId: true },
            });
            if (!probe) {
                console.warn(
                    `[tasks.restore] id=${req.params.id} not found in DB at all (hard-deleted or wrong id)`,
                );
                throw httpError(
                    404,
                    'Task has been permanently removed and can no longer be restored.',
                );
            }
            if (probe.deletedAt === null) {
                console.warn(
                    `[tasks.restore] id=${req.params.id} already restored (deletedAt=null)`,
                );
                throw httpError(
                    409,
                    'This task has already been restored — refresh the activity feed to see it again.',
                );
            }
            throw httpError(404, 'Task not found or not in deleted state');
        }

        const isOwnPersonal =
            existing.project.isPersonal &&
            existing.project.ownerId === req.user.id;
        const isOwnCreation =
            existing.createdById &&
            existing.createdById === req.user.id &&
            hasCapability(req, CAPABILITIES.TASK_CREATE_ANY);
        const isAdminCaller = isAdmin(req);
        if (
            !isOwnPersonal &&
            !isOwnCreation &&
            !isAdminOrManagerOrHasCapability(
                req,
                CAPABILITIES.TASK_DELETE_ANY,
            )
        ) {
            throw httpError(
                403,
                'Only admins, managers, users with task-delete permission, or the task creator can restore tasks',
            );
        }
        // Admins can restore from ANY project — including personal
        // projects they don't own / aren't a participant on. The
        // activities feed surfaces those events to admins for audit
        // purposes (see the comment in activities.js about admins
        // seeing personal-project events), so it'd be a UX trap to
        // show the restore button and then block the call when they
        // click it. Same goes for personal-project OWNERS: skip the
        // generic writable check (which 404s if a personal project's
        // visibility rules see "this isn't yours") and trust the
        // ownership match we made above. Everyone else gets the
        // normal access guard.
        if (!isAdminCaller && !isOwnPersonal) {
            await assertProjectWritable(req, existing.projectId, 'restore this task');
        } else if (isAdminCaller && !existing.project.isPersonal) {
            // Admins still hit the closed-project guard for SHARED
            // projects (the guard's "DONE = locked" logic skips
            // admins anyway, but we run it so closure-related errors
            // surface consistently).
            await assertProjectWritable(req, existing.projectId, 'restore this task');
        }

        const isSubtask = Boolean(existing.parentTaskId);
        const restoreStamp = existing.deletedAt;

        // Restore in a transaction so a parent + its cascade-deleted
        // subtasks come back together. Cascade match: same parentId
        // AND identical deletedAt (down to the millisecond). This
        // avoids accidentally un-deleting subtasks that were
        // manually deleted at a different time before the parent.
        await prisma.$transaction(async (tx) => {
            // Opt out of the soft-delete client extension here by
            // mentioning `deletedAt: undefined` explicitly — without
            // it, the extension would inject `deletedAt: null` and
            // refuse to match the still-soft-deleted row we're about
            // to revive. Same opt-out pattern used by `lib/codes.js`
            // when scanning across live + deleted rows. We already
            // verified the row is soft-deleted via `findFirst` above
            // (with `deletedAt: { not: null }`), so this update is
            // safe to run unconditionally on the unique id.
            await tx.task.update({
                where: { id: existing.id, deletedAt: undefined },
                data: { deletedAt: null },
            });
            if (!isSubtask) {
                // The subtask cascade already filters on the original
                // `deletedAt` timestamp, which the extension treats as
                // an explicit opt-out (any `deletedAt` key wins) — so
                // this side of the cascade doesn't need adjustment.
                await tx.task.updateMany({
                    where: {
                        parentTaskId: existing.id,
                        deletedAt: restoreStamp,
                    },
                    data: { deletedAt: null },
                });
            }
        });

        const task = await prisma.task.findUnique({
            where: { id: existing.id },
            include: taskInclude,
        });

        const projectName = existing.project?.name || 'project';
        const involved = await projectParticipantIds(existing.projectId);
        await notify({
            recipientIds: involved,
            actorId: req.user.id,
            type: 'TASK_RESTORED',
            title: `${projectName}: ${
                isSubtask ? 'subtask' : 'task'
            } restored`,
            body: `${req.user.email} restored "${existing.title}".`,
            projectId: existing.projectId,
            taskId: existing.id,
            meta: {
                isSubtask,
                parentTaskId: existing.parentTaskId || null,
            },
        });

        await logActivityEvent({
            type: 'TASK_RESTORED',
            actorId: req.user.id,
            projectId: existing.projectId,
            taskId: existing.id,
            message: existing.title,
            meta: {
                isSubtask,
                parentTaskId: existing.parentTaskId || null,
                restoredTaskId: existing.id,
            },
        });

        emitProjectPlanChanged(existing.projectId, {
            kind: isSubtask ? 'subtask-restored' : 'task-restored',
            taskId: existing.id,
            parentTaskId: existing.parentTaskId || null,
            actorId: req.user.id,
            actorName: req.user.name || req.user.email,
            title: existing.title,
        });

        res.json({ task });
    } catch (err) {
        // Surface the full stack to the docker logs so we can trace
        // restore failures end-to-end. The error still propagates via
        // next(err) so the regular error middleware sends the JSON
        // response — this is purely an observability hook.
        if (err.status !== 404 && err.status !== 403 && err.status !== 409) {
            console.error(
                `[tasks.restore] id=${req.params.id} unexpected failure:`,
                err?.message || err,
                err?.stack,
            );
        }
        next(err);
    }
});

// POST /api/tasks/:id/approve — sign off a "specific" task so it can leave
// TODO. Allowed for admins, managers, or holders of `task:approve`.
// Records who approved and when; idempotent if already approved.
router.post('/:id/approve', async (req, res, next) => {
    try {
        if (!isAdminOrManagerOrHasCapability(req, CAPABILITIES.TASK_APPROVE)) {
            throw httpError(403, 'You are not allowed to approve tasks.');
        }
        const existing = await loadTaskOr404(req.params.id);
        // The task:approve capability is workspace-wide; still restrict to
        // projects the caller can actually see so it can't reach tasks in
        // projects they have no access to.
        await assertProjectRead(req, existing.projectId);
        if (!existing.specific) {
            throw httpError(400, 'Only specific tasks require approval.');
        }
        if (existing.approvedAt) {
            const already = await prisma.task.findUnique({
                where: { id: existing.id },
                include: taskInclude,
            });
            return res.json({ task: already });
        }
        const task = await prisma.task.update({
            where: { id: existing.id },
            data: {
                approvedAt: new Date(),
                approvedById: req.user.id,
                // Approving overrides any prior disapproval — clear it so
                // the task reads as cleanly approved.
                rejectedAt: null,
                rejectedById: null,
                rejectionReason: null,
            },
            include: taskInclude,
        });
        await logActivityEvent({
            type: 'TASK_APPROVED',
            actorId: req.user.id,
            projectId: existing.projectId,
            taskId: existing.id,
            message: existing.title,
        });
        emitProjectPlanChanged(existing.projectId, {
            kind: 'task-approved',
            taskId: existing.id,
            actorId: req.user.id,
            actorName: req.user.name || req.user.email,
        });
        res.json({ task });
    } catch (err) {
        next(err);
    }
});

// POST /api/tasks/:id/disapprove — reject a "specific" task with a required
// reason. Allowed for admins, managers, or holders of `task:approve`. The
// task stays visible but locked (approvedAt remains null); who/when/why are
// recorded and surfaced in the UI. Approving later (or a re-request) clears
// the rejection.
router.post('/:id/disapprove', async (req, res, next) => {
    try {
        if (!isAdminOrManagerOrHasCapability(req, CAPABILITIES.TASK_APPROVE)) {
            throw httpError(403, 'You are not allowed to approve tasks.');
        }
        const reason = String(req.body?.reason ?? '').trim();
        if (reason.length < 3) {
            throw httpError(
                400,
                'A reason is required to disapprove a task.',
            );
        }
        if (reason.length > 1000) {
            throw httpError(400, 'The reason is too long (max 1000 chars).');
        }
        const existing = await loadTaskOr404(req.params.id);
        await assertProjectRead(req, existing.projectId);
        if (!existing.specific) {
            throw httpError(400, 'Only specific tasks require approval.');
        }
        if (existing.approvedAt) {
            throw httpError(
                400,
                'This task is already approved. Re-request approval before disapproving.',
            );
        }
        const task = await prisma.task.update({
            where: { id: existing.id },
            data: {
                rejectedAt: new Date(),
                rejectedById: req.user.id,
                rejectionReason: reason,
            },
            include: taskInclude,
        });
        await logActivityEvent({
            type: 'TASK_DISAPPROVED',
            actorId: req.user.id,
            projectId: existing.projectId,
            taskId: existing.id,
            message: existing.title,
            meta: { reason },
        });
        emitProjectPlanChanged(existing.projectId, {
            kind: 'task-disapproved',
            taskId: existing.id,
            actorId: req.user.id,
            actorName: req.user.name || req.user.email,
        });
        res.json({ task });
    } catch (err) {
        next(err);
    }
});

// POST /api/tasks/:id/request-approval — put a disapproved specific task
// back to "pending" so an approver can review it again. Allowed for the
// task creator/assignee and for admins / managers / `task:approve` holders.
// Clears the rejection fields (the task is already locked while unapproved,
// so nothing else changes).
router.post('/:id/request-approval', async (req, res, next) => {
    try {
        const existing = await loadTaskOr404(req.params.id);
        await assertProjectRead(req, existing.projectId);
        if (!existing.specific) {
            throw httpError(400, 'Only specific tasks require approval.');
        }
        const isOwner =
            existing.createdById === req.user.id ||
            existing.assigneeId === req.user.id;
        if (
            !isOwner &&
            !isAdminOrManagerOrHasCapability(req, CAPABILITIES.TASK_APPROVE)
        ) {
            throw httpError(
                403,
                'You are not allowed to re-request approval for this task.',
            );
        }
        if (existing.approvedAt) {
            throw httpError(400, 'This task is already approved.');
        }
        if (!existing.rejectedAt) {
            // Already pending — nothing to reset. Return current shape.
            const current = await prisma.task.findUnique({
                where: { id: existing.id },
                include: taskInclude,
            });
            return res.json({ task: current });
        }
        const task = await prisma.task.update({
            where: { id: existing.id },
            data: {
                rejectedAt: null,
                rejectedById: null,
                rejectionReason: null,
            },
            include: taskInclude,
        });
        await logActivityEvent({
            type: 'TASK_APPROVAL_REQUESTED',
            actorId: req.user.id,
            projectId: existing.projectId,
            taskId: existing.id,
            message: existing.title,
        });
        emitProjectPlanChanged(existing.projectId, {
            kind: 'task-approval-requested',
            taskId: existing.id,
            actorId: req.user.id,
            actorName: req.user.name || req.user.email,
        });
        res.json({ task });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
