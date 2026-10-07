// The help panel next to the "Raise new ticket" form — configured per
// ticket type (Templates → Ticket types → Edit → Help panel):
//   tips        "Tips for a good ticket" — short plain-text lines.
//               null = the form's built-in tips, [] = no Tips card.
//   resources   "Related resources" — [{ title, url }] links (+ intro).
//   oncall*     "Need urgent help?" — text, button label and a contact
//               (phone number, e-mail address or http(s) link).
const { z } = require('zod');

const MAX_TIPS = 10;
const MAX_TIP_LENGTH = 200;
const MAX_LINKS = 10;
const HTTP_URL = /^https?:\/\/\S+$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s/().-]{3,30}$/;

// The on-call contact is free text the admin types: a phone number, an
// e-mail address or a link. Turn it into a safe href (or null).
function contactHref(contact) {
    const c = String(contact || '').trim();
    if (!c) return null;
    if (HTTP_URL.test(c)) return c;
    if (EMAIL.test(c)) return `mailto:${c}`;
    if (PHONE.test(c) && (c.match(/\d/g) || []).length >= 3) {
        return `tel:${c.replace(/[^\d+]/g, '')}`;
    }
    return null;
}

const tipsSchema = z
    .array(
        z
            .string()
            .trim()
            .max(MAX_TIP_LENGTH, `Keep each tip under ${MAX_TIP_LENGTH} characters.`),
    )
    .max(MAX_TIPS, `Up to ${MAX_TIPS} tips.`);

const resourceSchema = z.object({
    title: z.string().trim().min(1, 'Give the link a title.').max(80),
    url: z
        .string()
        .trim()
        .max(500)
        .regex(HTTP_URL, 'Links must start with http:// or https://'),
});

// The help fields as sent with a ticket type (all optional — omitted =
// unchanged on PATCH).
const helpFieldsSchema = {
    tips: tipsSchema.optional().nullable(),
    resourcesIntro: z.string().trim().max(300).optional().nullable(),
    resources: z.array(resourceSchema).max(MAX_LINKS, `Up to ${MAX_LINKS} links.`).optional().nullable(),
    oncallText: z.string().trim().max(300).optional().nullable(),
    oncallLabel: z.string().trim().max(60).optional().nullable(),
    oncallContact: z
        .string()
        .trim()
        .max(200)
        .optional()
        .nullable()
        .refine(
            (v) => !v || contactHref(v),
            'Use a phone number, an e-mail address or an http(s) link.',
        ),
};

// Whatever is stored (or sent) → a clean array of non-empty strings.
function cleanTips(value) {
    return (Array.isArray(value) ? value : [])
        .map((t) => (typeof t === 'string' ? t.trim() : ''))
        .filter(Boolean)
        .map((t) => t.slice(0, MAX_TIP_LENGTH))
        .slice(0, MAX_TIPS);
}

function cleanResources(value) {
    return (Array.isArray(value) ? value : [])
        .filter((r) => r && r.title && HTTP_URL.test(String(r.url || '').trim()))
        .map((r) => ({ title: String(r.title).trim(), url: String(r.url).trim() }))
        .slice(0, MAX_LINKS);
}

// Prisma `data` for the help fields present in a parsed body. A Json
// column can't take a plain null, so cleared lists are stored as [] —
// except tips, where null (built-in tips) and [] (none) differ: a null
// there is simply not written.
function helpData(data) {
    const out = {};
    if (data.tips !== undefined && data.tips !== null) out.tips = cleanTips(data.tips);
    if (data.resources !== undefined) out.resources = cleanResources(data.resources);
    for (const k of ['resourcesIntro', 'oncallText', 'oncallLabel', 'oncallContact']) {
        if (data[k] !== undefined) out[k] = data[k] || null;
    }
    return out;
}

// What the raise form needs (requesters get this with the type list).
function serializeHelp(row) {
    const contact = row?.oncallContact || null;
    return {
        tips: Array.isArray(row?.tips) ? cleanTips(row.tips) : null,
        resourcesIntro: row?.resourcesIntro || null,
        resources: cleanResources(row?.resources),
        oncall: {
            text: row?.oncallText || null,
            label: row?.oncallLabel || null,
            contact,
            href: contactHref(contact),
        },
    };
}

module.exports = {
    MAX_TIPS,
    MAX_TIP_LENGTH,
    MAX_LINKS,
    contactHref,
    tipsSchema,
    resourceSchema,
    helpFieldsSchema,
    cleanTips,
    cleanResources,
    helpData,
    serializeHelp,
};
