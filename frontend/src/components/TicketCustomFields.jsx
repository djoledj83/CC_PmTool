// Renders the admin-defined custom fields on a raise-ticket form for a
// given request type (global fields + that type's fields). Lifts the
// collected values up via `onChange`:
//   { fields, clientId, terminalModelId, fieldValues: [{fieldId, value}] }
// The parent enforces the required ones and sends the values on submit.
//
// `trailing` (optional): extra form cells the parent wants on the LAST row
// — the Client field moves there too, so the raise form can show
// "Client | Share with | Attachments" on one line under the terminal.
import { useEffect, useMemo, useState } from 'react';
import { Box, Building2, Monitor, UserRound } from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

const OS_LABEL = { LINUX: 'Linux', ANDROID: 'Android' };

// Select trigger content with a leading icon. A <div>, not a <span>: the
// shadcn trigger line-clamps its direct <span> children (display:
// -webkit-box), which would stack the icon above the text.
function IconValue({ icon: Icon, placeholder }) {
    return (
        <div className="flex min-w-0 items-center gap-2 [&>span]:truncate">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <SelectValue placeholder={placeholder} />
        </div>
    );
}

export default function TicketCustomFields({
    requestTypeId,
    onChange,
    hideClientField = false,
    trailing = null,
    labelClassName = 'text-xs',
}) {
    const [fields, setFields] = useState([]);
    const [allModels, setAllModels] = useState([]); // every terminal model
    const [clients, setClients] = useState([]);

    const [osType, setOsType] = useState('');
    const [vendorId, setVendorId] = useState('');
    const [terminalModelId, setTerminalModelId] = useState('');
    const [clientId, setClientId] = useState('');
    const [values, setValues] = useState({}); // fieldId -> string | string[]

    // Load the effective field set for this type (global + type-specific),
    // then the catalogs the present field types need.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { data } = await api.get('/ticket-fields/effective', {
                    params: { requestTypeId: requestTypeId || 'none' },
                });
                if (cancelled) return;
                const list = data.fields || [];
                setFields(list);
                if (list.some((f) => f.type === 'TERMINAL')) {
                    api.get('/terminals/models')
                        .then(({ data: d }) =>
                            !cancelled && setAllModels(d.models || []),
                        )
                        .catch(() => {});
                }
                // External requesters never pick a client (theirs is used),
                // and the client list isn't theirs to see.
                if (!hideClientField && list.some((f) => f.type === 'CLIENT')) {
                    api.get('/clients')
                        .then(({ data: d }) =>
                            !cancelled && setClients(d.clients || []),
                        )
                        .catch(() => {});
                }
            } catch {
                if (!cancelled) setFields([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [requestTypeId, hideClientField]);

    // OS → Vendor → Model, all derived from the loaded models. Picking an
    // OS narrows the vendors; picking a vendor narrows the models.
    const vendorOptions = useMemo(() => {
        const seen = new Map();
        for (const m of allModels) {
            if (osType && m.osType !== osType) continue;
            if (m.vendor && !seen.has(m.vendor.id)) {
                seen.set(m.vendor.id, m.vendor);
            }
        }
        return [...seen.values()].sort((a, b) =>
            (a.name || '').localeCompare(b.name || ''),
        );
    }, [allModels, osType]);

    const modelOptions = useMemo(
        () =>
            allModels.filter(
                (m) =>
                    (!osType || m.osType === osType) &&
                    (!vendorId || m.vendor?.id === vendorId),
            ),
        [allModels, osType, vendorId],
    );

    // When the client is implied (requester's own org auto-tags the
    // ticket), drop the Client picker entirely.
    const visibleFields = useMemo(
        () =>
            hideClientField
                ? fields.filter((f) => f.type !== 'CLIENT')
                : fields,
        [fields, hideClientField],
    );

    // Lift the current selection up to the parent.
    useEffect(() => {
        onChange?.({
            fields: visibleFields,
            clientId,
            terminalModelId,
            fieldValues: Object.entries(values)
                .filter(([, v]) =>
                    Array.isArray(v) ? v.length > 0 : String(v ?? '').trim(),
                )
                .map(([fieldId, value]) => ({ fieldId, value })),
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visibleFields, clientId, terminalModelId, values]);

    const trailingCells = (Array.isArray(trailing) ? trailing : [trailing]).filter(
        Boolean,
    );
    if (visibleFields.length === 0 && trailingCells.length === 0) return null;

    const toggleOption = (fieldId, opt) =>
        setValues((prev) => {
            const cur = Array.isArray(prev[fieldId]) ? prev[fieldId] : [];
            return {
                ...prev,
                [fieldId]: cur.includes(opt)
                    ? cur.filter((x) => x !== opt)
                    : [...cur, opt],
            };
        });

    const labelFor = (f) => (
        <Label className={labelClassName}>
            {f.label}
            {f.required && <span className="text-rose-500"> *</span>}
        </Label>
    );

    const renderClient = (f) => (
        <div key={f.id} className="min-w-0 space-y-1.5">
            {labelFor(f)}
            <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger className="h-10 text-sm">
                    <IconValue icon={UserRound} placeholder="Select a client" />
                </SelectTrigger>
                <SelectContent>
                    {clients.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                            {c.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );

    // With `trailing`, the Client field joins the last row instead.
    const clientInTrailing = trailingCells.length > 0;
    const clientFields = clientInTrailing
        ? visibleFields.filter((f) => f.type === 'CLIENT')
        : [];
    const gridFields = clientInTrailing
        ? visibleFields.filter((f) => f.type !== 'CLIENT')
        : visibleFields;
    const lastRow = [...clientFields.map(renderClient), ...trailingCells];

    return (
        <div className="space-y-4">
            {gridFields.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {gridFields.map((f) => {
                        if (f.type === 'TERMINAL') {
                            return (
                                <div
                                    key={f.id}
                                    className="space-y-1.5 sm:col-span-2 lg:col-span-4"
                                >
                                    {labelFor(f)}
                                    <div className="grid gap-2 sm:grid-cols-3">
                                        <Select
                                            value={osType}
                                            onValueChange={(v) => {
                                                setOsType(v);
                                                setVendorId('');
                                                setTerminalModelId('');
                                            }}
                                        >
                                            <SelectTrigger className="h-10 text-sm">
                                                <IconValue icon={Monitor} placeholder="OS" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="LINUX">
                                                    {OS_LABEL.LINUX}
                                                </SelectItem>
                                                <SelectItem value="ANDROID">
                                                    {OS_LABEL.ANDROID}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                        <Select
                                            value={vendorId}
                                            onValueChange={(v) => {
                                                setVendorId(v);
                                                setTerminalModelId('');
                                            }}
                                            disabled={!osType}
                                        >
                                            <SelectTrigger className="h-10 text-sm">
                                                <IconValue icon={Building2} placeholder="Vendor" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {vendorOptions.map((v) => (
                                                    <SelectItem key={v.id} value={v.id}>
                                                        {v.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Select
                                            value={terminalModelId}
                                            onValueChange={setTerminalModelId}
                                            disabled={!vendorId}
                                        >
                                            <SelectTrigger className="h-10 text-sm">
                                                <IconValue icon={Box} placeholder="Model" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {modelOptions.map((m) => (
                                                    <SelectItem key={m.id} value={m.id}>
                                                        {m.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                            );
                        }
                        if (f.type === 'CLIENT') return renderClient(f);
                        if (f.type === 'SELECT') {
                            const opts = Array.isArray(f.options) ? f.options : [];
                            const sel = Array.isArray(values[f.id]) ? values[f.id] : [];
                            return (
                                <div
                                    key={f.id}
                                    className="space-y-1.5 sm:col-span-2 lg:col-span-4"
                                >
                                    {labelFor(f)}
                                    <div className="flex flex-wrap gap-1.5">
                                        {opts.map((o) => {
                                            const on = sel.includes(o);
                                            return (
                                                <button
                                                    key={o}
                                                    type="button"
                                                    onClick={() => toggleOption(f.id, o)}
                                                    className={
                                                        'rounded-full border px-2.5 py-1 text-xs transition-colors ' +
                                                        (on
                                                            ? 'border-primary bg-primary text-primary-foreground'
                                                            : 'hover:bg-accent')
                                                    }
                                                >
                                                    {o}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        }
                        if (f.type === 'YESNO') {
                            const v = values[f.id];
                            return (
                                <div key={f.id} className="space-y-1.5">
                                    {labelFor(f)}
                                    <div>
                                        {/* Compact segmented toggle — sized to
                                            its content, not full width. */}
                                        <div className="inline-flex rounded-md border p-0.5">
                                            {[
                                                { val: true, label: 'Yes' },
                                                { val: false, label: 'No' },
                                            ].map((opt) => {
                                                const on = v === opt.val;
                                                return (
                                                    <button
                                                        key={opt.label}
                                                        type="button"
                                                        onClick={() =>
                                                            setValues((prev) => ({
                                                                ...prev,
                                                                [f.id]: opt.val,
                                                            }))
                                                        }
                                                        className={cn(
                                                            'rounded px-4 py-1 text-xs font-medium transition-colors',
                                                            on
                                                                ? 'bg-primary text-primary-foreground'
                                                                : 'text-muted-foreground hover:text-foreground',
                                                        )}
                                                    >
                                                        {opt.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            );
                        }
                        // TEXT
                        return (
                            <div key={f.id} className="space-y-1.5">
                                {labelFor(f)}
                                <Input
                                    value={values[f.id] || ''}
                                    onChange={(e) =>
                                        setValues((prev) => ({
                                            ...prev,
                                            [f.id]: e.target.value,
                                        }))
                                    }
                                    placeholder={f.label}
                                    className="h-10"
                                />
                            </div>
                        );
                    })}
                </div>
            )}
            {lastRow.length > 0 && (
                <div
                    className={cn(
                        'grid items-start gap-3',
                        lastRow.length >= 3
                            ? 'md:grid-cols-3'
                            : lastRow.length === 2
                              ? 'md:grid-cols-2'
                              : '',
                    )}
                >
                    {lastRow}
                </div>
            )}
        </div>
    );
}
