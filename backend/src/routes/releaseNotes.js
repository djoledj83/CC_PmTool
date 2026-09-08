const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const prisma = require('../lib/prisma');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

// Resolve the RELEASE_NOTES.md path that ships with the repo. The
// backend runs from /app inside Docker (see backend/dockerfile) and
// RELEASE_NOTES.md is mounted at the repo root, one level up from
// the backend directory. We try a few candidates so the route stays
// useful in local dev (npm run dev from /backend) and in the
// container layout.
const CANDIDATE_PATHS = [
    path.resolve(__dirname, '..', '..', '..', 'RELEASE_NOTES.md'),
    path.resolve(__dirname, '..', '..', 'RELEASE_NOTES.md'),
    path.resolve(process.cwd(), 'RELEASE_NOTES.md'),
    '/app/RELEASE_NOTES.md',
    '/RELEASE_NOTES.md',
];

function resolveNotesPath() {
    for (const p of CANDIDATE_PATHS) {
        try {
            if (fs.existsSync(p)) return p;
        } catch {
            // ignore
        }
    }
    return null;
}

// Parse a slim view of the file — the markdown is split on `\n## `
// headers (numbered sections — see existing RELEASE_NOTES.md
// convention). We return the section titles + a 200-char preview
// for each, sorted newest-first by their position in the file (we
// assume new sections are appended at the bottom; the existing
// file follows that convention).
function parseSections(md) {
    const lines = md.split(/\r?\n/);
    const sections = [];
    let current = null;
    for (const line of lines) {
        const m = line.match(/^##\s+(\d+[a-z]?)\.\s+(.+?)\s*$/);
        if (m) {
            if (current) sections.push(current);
            current = {
                number: m[1],
                title: m[2],
                body: [],
            };
        } else if (current) {
            current.body.push(line);
        }
    }
    if (current) sections.push(current);
    return sections.map((s, i) => ({
        // Higher index = newer (file is append-only).
        order: i,
        number: s.number,
        title: s.title,
        preview: s.body
            .join(' ')
            .replace(/\s+/g, ' ')
            .replace(/[*`#_>-]/g, '')
            .trim()
            .slice(0, 220),
    }));
}

// GET /api/release-notes
//   Returns:
//     - lastModified  : mtime of RELEASE_NOTES.md (ISO string)
//     - hasUpdates    : true if the user's `lastSeenReleaseNotesAt`
//                       is older than `lastModified` (or NULL)
//     - sections[]    : newest-first section summaries (number,
//                       title, preview)
//
// The TopBar uses `hasUpdates` to pulse a Sparkles indicator and
// the popover uses `sections[]` to render the list.
router.get('/', async (req, res, next) => {
    try {
        const filePath = resolveNotesPath();
        if (!filePath) {
            return res.json({
                lastModified: null,
                hasUpdates: false,
                sections: [],
            });
        }
        const [stat, md, user] = await Promise.all([
            fs.promises.stat(filePath),
            fs.promises.readFile(filePath, 'utf8'),
            prisma.user.findUnique({
                where: { id: req.user.id },
                select: { lastSeenReleaseNotesAt: true },
            }),
        ]);
        const sections = parseSections(md).reverse();
        const lastModified = stat.mtime.toISOString();
        const seen = user?.lastSeenReleaseNotesAt
            ? new Date(user.lastSeenReleaseNotesAt).getTime()
            : 0;
        const hasUpdates = seen < stat.mtime.getTime();
        res.json({
            lastModified,
            hasUpdates,
            sections: sections.slice(0, 12),
        });
    } catch (err) {
        next(err);
    }
});

// POST /api/release-notes/dismiss
//   Records that the user has seen the changelog popover. Stamps
//   `lastSeenReleaseNotesAt = now()` so the Sparkles indicator on
//   the TopBar stops pulsing until the file gets edited again.
router.post('/dismiss', async (req, res, next) => {
    try {
        const updated = await prisma.user.update({
            where: { id: req.user.id },
            data: { lastSeenReleaseNotesAt: new Date() },
            select: { lastSeenReleaseNotesAt: true },
        });
        res.json(updated);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
