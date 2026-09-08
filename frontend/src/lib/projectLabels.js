import { LABEL_COLORS } from '@/lib/labelColors';

const ALLOWED_COLORS = new Set(LABEL_COLORS.map((c) => c.value));

/** @typedef {{ text: string, color?: string }} ProjectLabel */

// Splits the comma-separated legacy `label` field into individual chips.
export function splitLabels(value) {
    if (!value || typeof value !== 'string') return [];
    const seen = new Set();
    const out = [];
    for (const raw of value.split(',')) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
    }
    return out;
}

/**
 * Normalise stored project labels for rendering. Prefers the `labels`
 * JSON array; falls back to legacy comma-separated `label` + single
 * `labelColor`.
 * @param {object} project
 * @returns {ProjectLabel[]}
 */
export function parseProjectLabels(project) {
    if (!project) return [];
    const raw = project.labels;
    if (Array.isArray(raw) && raw.length) {
        return raw
            .filter((l) => l && String(l.text || '').trim())
            .map((l) => ({
                text: String(l.text).trim(),
                color: ALLOWED_COLORS.has(l.color) ? l.color : 'slate',
            }));
    }
    if (project.label) {
        const color = ALLOWED_COLORS.has(project.labelColor)
            ? project.labelColor
            : 'slate';
        return splitLabels(project.label).map((text) => ({ text, color }));
    }
    return [];
}

/**
 * @param {ProjectLabel[]} items
 */
export function labelsToPayload(items) {
    const cleaned = (items || [])
        .map((l) => ({
            text: (l.text || '').trim(),
            color: ALLOWED_COLORS.has(l.color) ? l.color : 'slate',
        }))
        .filter((l) => l.text);
    if (!cleaned.length) {
        // Omit legacy label fields — the API accepts null/undefined for
        // `labels` but rejects null for `label` / `labelColor`.
        return { labels: null };
    }
    return {
        labels: cleaned,
        label: cleaned.map((l) => l.text).join(', '),
        labelColor: cleaned[0].color,
    };
}

export function newLabelKey() {
    return `lbl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function newContactKey() {
    return `ct-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
