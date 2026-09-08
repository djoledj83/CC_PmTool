// Renders the admin-defined custom fields on a raise-ticket form for a
// given request type (global fields + that type's fields). Lifts the
// collected values up via `onChange`:
//   { fields, clientId, terminalModelId, fieldValues: [{fieldId, value}] }
// The parent enforces the required ones and sends the values on submit.
import { useEffect, useMemo, useState } from 'react';

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

export default function TicketCustomFields({
    requestTypeId,
    onChange,
    hideClientField = false,
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
                if (list.some((f) => f.type === 'CLIENT')) {
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
    }, [requestTypeId]);

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

    if (visibleFields.length === 0) return null;

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

    return (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {visibleFields.map((f) => {
                const req = f.required && (
                    <span className="text-rose-500"> *</span>
                );
                if (f.type === 'TERMINAL') {
                    return (
                        <div
                            key={f.id}
                            className="space-y-1.5 sm:col-span-2 lg:col-span-4"
                        >
                            <Label className="text-xs">
                                {f.label}
                                {req}
                            </Label>
                            <div className="grid grid-cols-3 gap-2">
                                <Select
                                    value={osType}
                                    onValueChange={(v) => {
                                        setOsType(v);
                                        setVendorId('');
                                        setTerminalModelId('');
                                    }}
                                >
                                    <SelectTrigger className="text-sm">
                                        <SelectValue placeholder="OS" />
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
                                    <SelectTrigger className="text-sm">
                                        <SelectValue placeholder="Vendor" />
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
                                    <SelectTrigger className="text-sm">
                                        <SelectValue placeholder="Model" />
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
                if (f.type === 'CLIENT') {
                    return (
                        <div key={f.id} className="space-y-1.5">
                            <Label className="text-xs">
                                {f.label}
                                {req}
                            </Label>
                            <Select
                                value={clientId}
                                onValueChange={setClientId}
                            >
                                <SelectTrigger className="text-sm">
                                    <SelectValue placeholder="Select a client" />
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
                }
                if (f.type === 'SELECT') {
                    const opts = Array.isArray(f.options) ? f.options : [];
                    const sel = Array.isArray(values[f.id]) ? values[f.id] : [];
                    return (
                        <div
                            key={f.id}
                            className="space-y-1.5 sm:col-span-2 lg:col-span-4"
                        >
                            <Label className="text-xs">
                                {f.label}
                                {req}
                            </Label>
                            <div className="flex flex-wrap gap-1.5">
                                {opts.map((o) => {
                                    const on = sel.includes(o);
                                    return (
                                        <button
                                            key={o}
                                            type="button"
                                            onClick={() =>
                                                toggleOption(f.id, o)
                                            }
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
                            <Label className="text-xs">
                                {f.label}
                                {req}
                            </Label>
                            <div>
                                {/* Compact segmented toggle — sized to its
                                    content, not full width. */}
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
                        <Label className="text-xs">
                            {f.label}
                            {req}
                        </Label>
                        <Input
                            value={values[f.id] || ''}
                            onChange={(e) =>
                                setValues((prev) => ({
                                    ...prev,
                                    [f.id]: e.target.value,
                                }))
                            }
                            placeholder={f.label}
                        />
                    </div>
                );
            })}
        </div>
    );
}
