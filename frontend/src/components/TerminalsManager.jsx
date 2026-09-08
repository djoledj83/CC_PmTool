// Admin Terminals catalog (Templates → Tickets → Terminals).
// Master-detail: vendors on the left, the selected vendor's terminal
// models (each with an OS type) on the right. Consumed later by the
// raise-ticket form as cascading Vendor → Model → OS selects.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, Pencil, Check, X, Cpu } from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

const OS_OPTIONS = [
    { value: 'LINUX', label: 'Linux' },
    { value: 'ANDROID', label: 'Android' },
];
const osLabel = (v) => OS_OPTIONS.find((o) => o.value === v)?.label || v;

export function TerminalsManager() {
    const [vendors, setVendors] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedId, setSelectedId] = useState(null);
    const [newVendor, setNewVendor] = useState('');
    const [editingVendor, setEditingVendor] = useState(null); // {id, name}

    const [models, setModels] = useState([]);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [newModel, setNewModel] = useState({ name: '', osType: 'LINUX' });

    const loadVendors = async (selectAfter) => {
        try {
            setLoading(true);
            const { data } = await api.get('/terminals/vendors');
            const list = data.vendors || [];
            setVendors(list);
            setSelectedId((cur) => selectAfter ?? cur ?? list[0]?.id ?? null);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not load vendors.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadVendors();
    }, []);

    const loadModels = async (vendorId) => {
        if (!vendorId) {
            setModels([]);
            return;
        }
        try {
            setModelsLoading(true);
            const { data } = await api.get('/terminals/models', {
                params: { vendorId },
            });
            setModels(data.models || []);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not load models.');
        } finally {
            setModelsLoading(false);
        }
    };

    useEffect(() => {
        loadModels(selectedId);
    }, [selectedId]);

    const addVendor = async () => {
        const name = newVendor.trim();
        if (!name) return;
        try {
            const { data } = await api.post('/terminals/vendors', { name });
            setNewVendor('');
            await loadVendors(data.vendor?.id);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add vendor.');
        }
    };

    const renameVendor = async () => {
        const name = editingVendor?.name.trim();
        if (!name) return;
        try {
            await api.patch(`/terminals/vendors/${editingVendor.id}`, { name });
            setEditingVendor(null);
            await loadVendors();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not rename vendor.');
        }
    };

    const deleteVendor = async (v) => {
        if (
            !window.confirm(
                `Delete vendor "${v.name}" and its ${v._count?.models ?? 0} model(s)?`,
            )
        )
            return;
        try {
            await api.delete(`/terminals/vendors/${v.id}`);
            const next = vendors.filter((x) => x.id !== v.id);
            setSelectedId(next[0]?.id ?? null);
            await loadVendors(next[0]?.id ?? null);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete vendor.');
        }
    };

    const addModel = async () => {
        const name = newModel.name.trim();
        if (!name || !selectedId) return;
        try {
            await api.post('/terminals/models', {
                name,
                osType: newModel.osType,
                vendorId: selectedId,
            });
            setNewModel({ name: '', osType: newModel.osType });
            await Promise.all([loadModels(selectedId), loadVendors()]);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add model.');
        }
    };

    const deleteModel = async (m) => {
        if (!window.confirm(`Delete model "${m.name}"?`)) return;
        try {
            await api.delete(`/terminals/models/${m.id}`);
            await Promise.all([loadModels(selectedId), loadVendors()]);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete model.');
        }
    };

    const selected = vendors.find((v) => v.id === selectedId) || null;

    if (loading) {
        return (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
            </div>
        );
    }

    return (
        <div className="grid gap-4 md:grid-cols-[260px_1fr]">
            {/* Vendors */}
            <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Vendors
                </p>
                <div className="flex gap-1.5">
                    <Input
                        value={newVendor}
                        onChange={(e) => setNewVendor(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addVendor()}
                        placeholder="Add vendor…"
                        className="h-8 text-sm"
                    />
                    <Button
                        size="sm"
                        className="h-8 shrink-0 px-2"
                        onClick={addVendor}
                        disabled={!newVendor.trim()}
                    >
                        <Plus className="h-4 w-4" />
                    </Button>
                </div>
                <div className="space-y-1">
                    {vendors.length === 0 && (
                        <p className="px-1 py-2 text-xs text-muted-foreground">
                            No vendors yet.
                        </p>
                    )}
                    {vendors.map((v) => (
                        <div
                            key={v.id}
                            className={cn(
                                'group flex items-center gap-1 rounded-md border px-2 py-1.5',
                                v.id === selectedId
                                    ? 'border-primary/40 bg-primary/5'
                                    : 'hover:bg-accent',
                            )}
                        >
                            {editingVendor?.id === v.id ? (
                                <>
                                    <Input
                                        value={editingVendor.name}
                                        onChange={(e) =>
                                            setEditingVendor({
                                                ...editingVendor,
                                                name: e.target.value,
                                            })
                                        }
                                        onKeyDown={(e) =>
                                            e.key === 'Enter' && renameVendor()
                                        }
                                        autoFocus
                                        className="h-7 text-sm"
                                    />
                                    <button
                                        type="button"
                                        onClick={renameVendor}
                                        className="rounded p-1 text-emerald-600 hover:bg-accent"
                                    >
                                        <Check className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setEditingVendor(null)}
                                        className="rounded p-1 text-muted-foreground hover:bg-accent"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => setSelectedId(v.id)}
                                        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                                    >
                                        <span className="truncate font-medium">
                                            {v.name}
                                        </span>
                                        <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                                            {v._count?.models ?? 0}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        title="Rename"
                                        onClick={() =>
                                            setEditingVendor({
                                                id: v.id,
                                                name: v.name,
                                            })
                                        }
                                        className="rounded p-1 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100"
                                    >
                                        <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        type="button"
                                        title="Delete"
                                        onClick={() => deleteVendor(v)}
                                        className="rounded p-1 text-rose-600 opacity-0 hover:bg-accent group-hover:opacity-100"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {/* Models for the selected vendor */}
            <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {selected
                        ? `${selected.name} — models`
                        : 'Models'}
                </p>
                {!selected ? (
                    <p className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
                        Select or add a vendor to manage its models.
                    </p>
                ) : (
                    <>
                        <div className="flex flex-wrap gap-1.5">
                            <Input
                                value={newModel.name}
                                onChange={(e) =>
                                    setNewModel({
                                        ...newModel,
                                        name: e.target.value,
                                    })
                                }
                                onKeyDown={(e) =>
                                    e.key === 'Enter' && addModel()
                                }
                                placeholder="Model name (e.g. P200)…"
                                className="h-8 min-w-[160px] flex-1 text-sm"
                            />
                            <Select
                                value={newModel.osType}
                                onValueChange={(v) =>
                                    setNewModel({ ...newModel, osType: v })
                                }
                            >
                                <SelectTrigger className="h-8 w-[130px] text-sm">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {OS_OPTIONS.map((o) => (
                                        <SelectItem key={o.value} value={o.value}>
                                            {o.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Button
                                size="sm"
                                className="h-8 shrink-0 gap-1 px-2"
                                onClick={addModel}
                                disabled={!newModel.name.trim()}
                            >
                                <Plus className="h-4 w-4" /> Add
                            </Button>
                        </div>

                        {modelsLoading ? (
                            <div className="flex items-center justify-center py-8 text-muted-foreground">
                                <Loader2 className="h-4 w-4 animate-spin" />
                            </div>
                        ) : models.length === 0 ? (
                            <p className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
                                No models for this vendor yet.
                            </p>
                        ) : (
                            <div className="divide-y rounded-md border">
                                {models.map((m) => (
                                    <div
                                        key={m.id}
                                        className="group flex items-center gap-2 px-3 py-2 text-sm"
                                    >
                                        <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0 flex-1 truncate font-medium">
                                            {m.name}
                                        </span>
                                        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                            {osLabel(m.osType)}
                                        </span>
                                        <button
                                            type="button"
                                            title="Delete"
                                            onClick={() => deleteModel(m)}
                                            className="rounded p-1 text-rose-600 opacity-0 hover:bg-accent group-hover:opacity-100"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

export default TerminalsManager;
