// Global "find anywhere" search.
//
// Searches across multiple tables (project metadata, tasks, notes,
// files, phases) and returns the matching *projects* with a snippet of
// where the match came from so users see why each result is relevant.
//
// Visibility is enforced on every level: regular users only see their
// own accessible projects; admins see everything.

const express = require('express');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');
const { accessibleProjectIds } = require('../lib/permissions');

const router = express.Router();
router.use(requireAuth);

// Limit how many rows we pull per source table to keep this snappy even
// on large workspaces. The frontend doesn't need an exhaustive list —
// just enough hits to find what the user is looking for.
const PER_SOURCE_LIMIT = 25;
// Hard cap on the number of distinct projects returned to the client.
const MAX_RESULTS = 30;

// Cuts a snippet around the first occurrence of `q` so the UI can show
// just the relevant slice of a long description / note instead of the
// whole thing.
function snippet(text, q, max = 140) {
    if (!text) return '';
    const lower = text.toLowerCase();
    const i = lower.indexOf(q.toLowerCase());
    if (i < 0) return text.slice(0, max);
    const start = Math.max(0, i - 40);
    const end = Math.min(text.length, i + q.length + 80);
    let out = text.slice(start, end);
    if (start > 0) out = '…' + out;
    if (end < text.length) out = out + '…';
    return out.length > max ? out.slice(0, max) + '…' : out;
}

// Map a free-text query to the project status / priority enum tokens
// it could plausibly mean. Lets users type "completed" and find DONE
// projects, "urgent" and find URGENT, etc.
function statusesMatchingQuery(q) {
    const lower = q.toLowerCase();
    const map = {
        TODO: ['todo', 'to do', 'open', 'new', 'not started'],
        IN_PROGRESS: ['in progress', 'progress', 'doing', 'active', 'working'],
        DONE: ['done', 'complete', 'completed', 'finished', 'closed'],
        ON_HOLD: ['on hold', 'hold', 'paused', 'pause', 'blocked'],
    };
    return Object.entries(map)
        .filter(([, words]) => words.some((w) => w.includes(lower) || lower.includes(w)))
        .map(([k]) => k);
}

function prioritiesMatchingQuery(q) {
    const lower = q.toLowerCase();
    const map = {
        LOW: ['low'],
        MEDIUM: ['medium', 'normal', 'med'],
        HIGH: ['high'],
        URGENT: ['urgent', 'critical', 'asap'],
    };
    return Object.entries(map)
        .filter(([, words]) => words.some((w) => w.includes(lower) || lower.includes(w)))
        .map(([k]) => k);
}

router.get('/', async (req, res, next) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 1) {
            return res.json({ query: q, results: [] });
        }

        const limit = Math.min(
            Math.max(parseInt(req.query.limit, 10) || MAX_RESULTS, 1),
            MAX_RESULTS,
        );

        // Build the visibility scope: a hard projectId allowlist used
        // in every per-table query below. Always an array now — admins
        // are scoped too so they don't see other users' personal
        // projects accidentally.
        const visibleIds = await accessibleProjectIds(req);
        if (visibleIds.length === 0) {
            // Caller has zero accessible projects -> nothing to find.
            return res.json({ query: q, results: [] });
        }
        const projectScope = { id: { in: visibleIds } };
        const projectIdScope = { projectId: { in: visibleIds } };

        // Fire all the per-table searches in parallel for low latency.
        // Each query fetches just enough columns to render the snippet
        // and link, never the full row.
        const ilike = { contains: q, mode: 'insensitive' };
        const statusEnums = statusesMatchingQuery(q);
        const priorityEnums = prioritiesMatchingQuery(q);

        const [
            projectHits,
            taskHits,
            noteHits,
            fileHits,
            phaseHits,
        ] = await Promise.all([
            prisma.project.findMany({
                where: {
                    AND: [
                        projectScope,
                        {
                            OR: [
                                { name: ilike },
                                { description: ilike },
                                { client: ilike },
                                { crmId: ilike },
                                { country: ilike },
                                { label: ilike },
                                { phase: ilike },
                                // Project codes ("P26-USA-0001") —
                                // type any prefix and the project
                                // surfaces.
                                { code: ilike },
                                ...(statusEnums.length
                                    ? [{ status: { in: statusEnums } }]
                                    : []),
                                ...(priorityEnums.length
                                    ? [{ priority: { in: priorityEnums } }]
                                    : []),
                            ],
                        },
                    ],
                },
                select: {
                    id: true,
                    code: true,
                    name: true,
                    description: true,
                    client: true,
                    crmId: true,
                    country: true,
                    label: true,
                    phase: true,
                    status: true,
                    priority: true,
                },
                take: PER_SOURCE_LIMIT,
            }),
            prisma.task.findMany({
                where: {
                    AND: [
                        projectIdScope,
                        {
                            OR: [
                                { title: ilike },
                                { description: ilike },
                                // Task / subtask codes ("T-0001" /
                                // "ST-0007") — same idea as project
                                // codes above.
                                { code: ilike },
                            ],
                        },
                    ],
                },
                select: {
                    id: true,
                    code: true,
                    title: true,
                    description: true,
                    projectId: true,
                    parentTaskId: true,
                },
                take: PER_SOURCE_LIMIT,
            }),
            prisma.note.findMany({
                where: {
                    AND: [projectIdScope, { content: ilike }],
                },
                select: {
                    id: true,
                    content: true,
                    projectId: true,
                },
                take: PER_SOURCE_LIMIT,
            }),
            prisma.fileAttachment.findMany({
                where: {
                    AND: [
                        projectIdScope,
                        {
                            OR: [
                                { originalName: ilike },
                                { filename: ilike },
                            ],
                        },
                    ],
                },
                select: {
                    id: true,
                    originalName: true,
                    filename: true,
                    projectId: true,
                },
                take: PER_SOURCE_LIMIT,
            }),
            prisma.phase.findMany({
                where: {
                    AND: [projectIdScope, { name: ilike }],
                },
                select: { id: true, name: true, projectId: true },
                take: PER_SOURCE_LIMIT,
            }),
        ]);

        // Collect all the project IDs that had at least one hit, plus
        // map each project to the list of "matches" we found inside it.
        const matchesByProjectId = new Map();
        const addMatch = (projectId, match) => {
            if (!projectId) return;
            if (!matchesByProjectId.has(projectId)) {
                matchesByProjectId.set(projectId, []);
            }
            matchesByProjectId.get(projectId).push(match);
        };

        for (const p of projectHits) {
            // Pick the most informative field that actually contained
            // the query so the UI can show a meaningful snippet.
            const fields = [
                // Code first so a code match beats a fuzzy name match
                // when both apply.
                ['code', p.code],
                ['name', p.name],
                ['description', p.description],
                ['client', p.client],
                ['crmId', p.crmId],
                ['country', p.country],
                ['label', p.label],
                ['phase', p.phase],
            ];
            const found = fields.find(
                ([, v]) =>
                    typeof v === 'string' &&
                    v.toLowerCase().includes(q.toLowerCase()),
            );
            if (found) {
                addMatch(p.id, {
                    type: 'project',
                    field: found[0],
                    snippet: snippet(found[1], q),
                });
            } else if (statusEnums.includes(p.status)) {
                addMatch(p.id, {
                    type: 'status',
                    field: 'status',
                    snippet: p.status,
                });
            } else if (priorityEnums.includes(p.priority)) {
                addMatch(p.id, {
                    type: 'priority',
                    field: 'priority',
                    snippet: p.priority,
                });
            }
        }
        for (const t of taskHits) {
            // If the user typed a code, lead the snippet with it so
            // they can confirm the match at a glance.
            const matchedCode =
                t.code && t.code.toLowerCase().includes(q.toLowerCase());
            addMatch(t.projectId, {
                type: t.parentTaskId ? 'subtask' : 'task',
                taskId: t.id,
                code: t.code || null,
                snippet: matchedCode
                    ? `${t.code} — ${t.title}`
                    : snippet(t.title, q) || snippet(t.description || '', q),
            });
        }
        for (const n of noteHits) {
            addMatch(n.projectId, {
                type: 'note',
                snippet: snippet(n.content, q),
            });
        }
        for (const f of fileHits) {
            addMatch(f.projectId, {
                type: 'file',
                snippet: f.originalName || f.filename,
            });
        }
        for (const ph of phaseHits) {
            addMatch(ph.projectId, {
                type: 'phase',
                snippet: ph.name,
            });
        }

        if (matchesByProjectId.size === 0) {
            return res.json({ query: q, results: [] });
        }

        // Fetch the actual project rows for the unique project ids and
        // rejoin them with their match annotations. Re-applies the
        // visibility scope as a defence-in-depth sanity check.
        const ids = Array.from(matchesByProjectId.keys()).slice(0, limit);
        const projects = await prisma.project.findMany({
            where: {
                AND: [{ id: { in: ids } }, projectScope],
            },
            select: {
                id: true,
                code: true,
                name: true,
                status: true,
                priority: true,
                phase: true,
                client: true,
                label: true,
                labelColor: true,
                updatedAt: true,
            },
        });

        // Sort: projects with the most matches first, ties broken by
        // most recently updated.
        const results = projects
            .map((p) => ({
                project: p,
                matches: matchesByProjectId.get(p.id) || [],
            }))
            .sort((a, b) => {
                if (b.matches.length !== a.matches.length) {
                    return b.matches.length - a.matches.length;
                }
                return new Date(b.project.updatedAt) - new Date(a.project.updatedAt);
            });

        res.json({ query: q, results });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
