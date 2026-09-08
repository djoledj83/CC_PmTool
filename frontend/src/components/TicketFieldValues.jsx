// Read-only "Details" block showing the custom-field values captured when
// a ticket was raised: terminal (vendor / model / OS), client, and any
// free-text / multi-select values. Renders nothing if there's none.
const OS_LABEL = { LINUX: 'Linux', ANDROID: 'Android' };

export default function TicketFieldValues({ ticket }) {
    const items = [];
    if (ticket?.terminalModel) {
        const tm = ticket.terminalModel;
        const os = OS_LABEL[tm.osType] || tm.osType;
        items.push({
            label: 'Terminal',
            value: [tm.vendor?.name, tm.name].filter(Boolean).join(' ') +
                (os ? ` · ${os}` : ''),
        });
    }
    if (ticket?.client) {
        items.push({ label: 'Client', value: ticket.client.name });
    }
    for (const fv of ticket?.fieldValues || []) {
        let value;
        if (Array.isArray(fv.value)) value = fv.value.join(', ');
        else if (typeof fv.value === 'boolean') value = fv.value ? 'Yes' : 'No';
        else value = fv.value;
        items.push({ label: fv.label, value });
    }
    if (items.length === 0) return null;

    return (
        <div>
            <h3 className="mb-2 text-sm font-medium">Details</h3>
            {/* Fields flow in a row (Terminal · Client · UTMS Tid · …) and
                wrap to the next line when the panel is too narrow. */}
            <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
                {items.map((it, i) => (
                    <div key={i} className="flex min-w-0 flex-col gap-0.5">
                        <dt className="text-muted-foreground">{it.label}</dt>
                        <dd className="break-words font-medium text-foreground">
                            {it.value || '—'}
                        </dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
