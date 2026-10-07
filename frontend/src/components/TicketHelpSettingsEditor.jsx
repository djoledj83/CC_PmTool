// Help panel editor for ONE ticket type (Templates → Ticket types → Edit →
// Help panel): "Tips for a good ticket", "Related resources" (links) and
// "Need urgent help?" (on-call contact), with a live preview of the column
// requesters see next to that type's raise form.
//
// Controlled: `value` is the form state (helpFormFromType), `onChange`
// receives the next state; the type dialog saves it with the rest of the
// type (helpPayload). helpProblems() lists what would block saving.
import { Plus, RotateCcw, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
    DEFAULT_TIPS,
    HTTP_URL,
    MAX_LINKS,
    RaiseHelpCards,
    cleanTips,
    contactHref,
    helpTips,
} from '@/components/RaiseTicketParts';
import { TicketTipsEditor } from '@/components/TicketTipsEditor';

// Form state from a ticket type (`rt.help` as the API sends it). A type
// without its own tips starts from the built-in ones the form shows.
export function helpFormFromType(rt) {
    const h = rt?.help;
    return {
        tips: [...helpTips(h)],
        resourcesIntro: h?.resourcesIntro || '',
        resources: (h?.resources || []).map((r) => ({ title: r.title, url: r.url })),
        oncallText: h?.oncall?.text || '',
        oncallLabel: h?.oncall?.label || '',
        oncallContact: h?.oncall?.contact || '',
    };
}

const filledLinks = (form) =>
    form.resources.filter((r) => r.title.trim() || r.url.trim());

// The fields as the type routes expect them.
export function helpPayload(form) {
    return {
        tips: cleanTips(form.tips),
        resourcesIntro: form.resourcesIntro.trim() || null,
        resources: filledLinks(form).map((r) => ({
            title: r.title.trim(),
            url: r.url.trim(),
        })),
        oncallText: form.oncallText.trim() || null,
        oncallLabel: form.oncallLabel.trim() || null,
        oncallContact: form.oncallContact.trim() || null,
    };
}

const linkProblem = (r) => {
    const title = r.title.trim();
    const url = r.url.trim();
    if (!title && !url) return null;
    if (!title) return 'needs a title';
    if (!HTTP_URL.test(url)) return 'needs a link starting with http:// or https://';
    return null;
};

// Human-readable reasons the panel can't be saved yet ([] = fine).
export function helpProblems(form) {
    const out = [];
    form.resources.forEach((r, i) => {
        const p = linkProblem(r);
        if (p) out.push(`Link ${i + 1} ${p}.`);
    });
    if (form.oncallContact.trim() && !contactHref(form.oncallContact)) {
        out.push('The on-call contact must be a phone number, an e-mail address or an http(s) link.');
    }
    return out;
}

// What the raise form will show for these (unsaved) values.
export function previewHelp(form) {
    return {
        tips: cleanTips(form.tips),
        resourcesIntro: form.resourcesIntro.trim() || null,
        resources: filledLinks(form)
            .filter((r) => !linkProblem(r))
            .map((r) => ({ title: r.title.trim(), url: r.url.trim() })),
        oncall: {
            text: form.oncallText.trim() || null,
            label: form.oncallLabel.trim() || null,
            contact: form.oncallContact.trim() || null,
            href: contactHref(form.oncallContact),
        },
    };
}

// One-line summary for the ticket-type list, e.g. "5 tips · 2 links · on-call".
export function helpSummary(help) {
    const parts = [];
    if (!Array.isArray(help?.tips)) parts.push('built-in tips');
    else if (help.tips.length === 0) parts.push('no tips');
    else parts.push(`${help.tips.length} ${help.tips.length === 1 ? 'tip' : 'tips'}`);
    const links = help?.resources?.length || 0;
    if (links) parts.push(`${links} ${links === 1 ? 'link' : 'links'}`);
    if (help?.oncall?.href) parts.push('on-call');
    return parts.join(' · ');
}

const sameList = (a, b) =>
    a.length === b.length && a.every((x, i) => x === b[i]);

function contactHint(contact) {
    const c = contact.trim();
    if (!c) return { text: 'Leave empty to hide the "Need urgent help?" card.', bad: false };
    const href = contactHref(c);
    if (!href) return { text: 'Use a phone number, an e-mail address or an http(s) link.', bad: true };
    if (href.startsWith('tel:')) return { text: `Calls ${href.slice(4)}`, bad: false };
    if (href.startsWith('mailto:')) return { text: `Opens an e-mail to ${href.slice(7)}`, bad: false };
    return { text: 'Opens the link in a new tab', bad: false };
}

export function TicketHelpSettingsEditor({ value, onChange, disabled = false }) {
    const form = value;
    const set = (patch) => onChange?.({ ...form, ...patch });
    const setLink = (i, patch) =>
        set({
            resources: form.resources.map((r, idx) =>
                idx === i ? { ...r, ...patch } : r,
            ),
        });
    const hint = contactHint(form.oncallContact);

    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="space-y-6">
                <p className="text-sm text-muted-foreground">
                    Shown next to this type’s “Raise new ticket” form on the
                    portal. Related resources and Need urgent help? stay
                    hidden until they’re filled in.
                </p>

                <section className="space-y-3" data-section="tips">
                    <div>
                        <h3 className="text-sm font-semibold">
                            Tips for a good ticket
                        </h3>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            What a good ticket of this type should contain.
                        </p>
                    </div>
                    <TicketTipsEditor
                        value={form.tips}
                        onChange={(tips) => set({ tips })}
                        disabled={disabled}
                        emptyText="No tips — the Tips card is hidden for this type."
                        actions={
                            !sameList(cleanTips(form.tips), DEFAULT_TIPS) && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="gap-1.5 text-muted-foreground"
                                    onClick={() => set({ tips: [...DEFAULT_TIPS] })}
                                    disabled={disabled}
                                >
                                    <RotateCcw className="h-3.5 w-3.5" /> Use the
                                    built-in tips
                                </Button>
                            )
                        }
                    />
                </section>

                <section className="space-y-3" data-section="resources">
                    <h3 className="text-sm font-semibold">Related resources</h3>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Intro text</Label>
                        <Textarea
                            value={form.resourcesIntro}
                            onChange={(e) => set({ resourcesIntro: e.target.value })}
                            rows={2}
                            maxLength={300}
                            disabled={disabled}
                            placeholder="Check our documentation for quick answers to common issues."
                        />
                    </div>
                    <div className="space-y-2">
                        <Label className="text-xs">Links</Label>
                        {form.resources.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                                No links yet.
                            </p>
                        )}
                        {form.resources.map((r, i) => {
                            const problem = linkProblem(r);
                            return (
                                <div
                                    key={i}
                                    className="grid gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_auto]"
                                >
                                    <Input
                                        value={r.title}
                                        onChange={(e) => setLink(i, { title: e.target.value })}
                                        placeholder="IPS Troubleshooting Guide"
                                        maxLength={80}
                                        disabled={disabled}
                                        aria-label={`Link ${i + 1} title`}
                                        className={cn(
                                            problem === 'needs a title' && 'border-rose-400',
                                        )}
                                    />
                                    <Input
                                        value={r.url}
                                        onChange={(e) => setLink(i, { url: e.target.value })}
                                        placeholder="https://…"
                                        maxLength={500}
                                        disabled={disabled}
                                        aria-label={`Link ${i + 1} URL`}
                                        className={cn(
                                            problem && problem !== 'needs a title' && 'border-rose-400',
                                        )}
                                    />
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() =>
                                            set({
                                                resources: form.resources.filter(
                                                    (_, idx) => idx !== i,
                                                ),
                                            })
                                        }
                                        disabled={disabled}
                                        aria-label={`Remove link ${i + 1}`}
                                        className="text-muted-foreground hover:text-rose-600"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            );
                        })}
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            disabled={disabled || form.resources.length >= MAX_LINKS}
                            onClick={() =>
                                set({
                                    resources: [...form.resources, { title: '', url: '' }],
                                })
                            }
                        >
                            <Plus className="h-4 w-4" /> Add link
                        </Button>
                    </div>
                </section>

                <section className="space-y-3" data-section="oncall">
                    <h3 className="text-sm font-semibold">Need urgent help?</h3>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Text</Label>
                        <Textarea
                            value={form.oncallText}
                            onChange={(e) => set({ oncallText: e.target.value })}
                            rows={2}
                            maxLength={300}
                            disabled={disabled}
                            placeholder="If this is a critical issue and you need immediate assistance, please contact the on-call team."
                        />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label className="text-xs">Button label</Label>
                            <Input
                                value={form.oncallLabel}
                                onChange={(e) => set({ oncallLabel: e.target.value })}
                                maxLength={60}
                                disabled={disabled}
                                placeholder="Contact on-call team"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="text-xs">Phone, e-mail or link</Label>
                            <Input
                                value={form.oncallContact}
                                onChange={(e) => set({ oncallContact: e.target.value })}
                                maxLength={200}
                                disabled={disabled}
                                placeholder="+381 11 123 4567"
                                aria-label="On-call contact"
                                className={cn(hint.bad && 'border-rose-400')}
                            />
                            <p
                                className={cn(
                                    'text-[11px]',
                                    hint.bad ? 'text-rose-600' : 'text-muted-foreground',
                                )}
                            >
                                {hint.text}
                            </p>
                        </div>
                    </div>
                </section>
            </div>

            <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Preview
                </p>
                <div className="space-y-4" data-help-preview="">
                    <RaiseHelpCards help={previewHelp(form)} />
                </div>
            </div>
        </div>
    );
}

export default TicketHelpSettingsEditor;
