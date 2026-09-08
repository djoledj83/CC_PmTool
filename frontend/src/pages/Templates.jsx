import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
    ArrowDown,
    ArrowUp,
    Building2,
    ChevronsLeft,
    ChevronsRight,
    FolderKanban,
    Globe,
    GripVertical,
    Layers,
    LifeBuoy,
    Monitor,
    Package,
    Pencil,
    Plus,
    Save,
    Settings2,
    Sparkles,
    Tag,
    Terminal,
    Trash2,
    Users,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { invalidatePriorities } from '@/lib/priorities';
import { invalidateStatuses } from '@/lib/statuses';
import { invalidateCatalog } from '@/lib/catalogs';
import { TicketTypesManager } from '@/pages/TicketRequestTypes';
import { RequesterGroupsManager } from '@/components/RequesterGroupsManager';
import { TerminalsManager } from '@/components/TerminalsManager';
import { TopBar } from '@/components/TopBar';
import AdminTabs from '@/components/AdminTabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const PRIORITY_COLORS = [
    { value: 'slate', label: 'Slate', swatch: 'bg-slate-400' },
    { value: 'sky', label: 'Sky', swatch: 'bg-sky-500' },
    { value: 'emerald', label: 'Emerald', swatch: 'bg-emerald-500' },
    { value: 'amber', label: 'Amber', swatch: 'bg-amber-500' },
    { value: 'rose', label: 'Rose', swatch: 'bg-rose-500' },
    { value: 'violet', label: 'Violet', swatch: 'bg-violet-500' },
];

// Sentinel value for "no colour token / use the auto hash". Radix
// `Select.Item` REFUSES to mount with `value=""` (it reserves that
// for the placeholder state), so we can't use the empty string for
// the "Auto" option here — picking it would still pass an empty
// string to onValueChange and React would warn. We translate the
// sentinel back to `''` / `null` at the network boundary.
const PHASE_AUTO_COLOR = '__auto__';

// Palette tokens for the Phase template colour picker. These mirror
// the PHASE_PALETTE in PhasesPlan.jsx exactly — adding a token here
// without also adding it in PhasesPlan would surface as "no colour"
// on the plan because the BE just stores the token and the FE looks
// it up in PHASE_COLOR_TOKEN_INDEX.
const PHASE_TEMPLATE_COLORS = [
    { value: PHASE_AUTO_COLOR, label: 'Auto', swatch: 'bg-muted' },
    { value: 'sky', label: 'Sky', swatch: 'bg-sky-500' },
    { value: 'emerald', label: 'Emerald', swatch: 'bg-emerald-500' },
    { value: 'violet', label: 'Violet', swatch: 'bg-violet-500' },
    { value: 'amber', label: 'Amber', swatch: 'bg-amber-500' },
    { value: 'rose', label: 'Rose', swatch: 'bg-rose-500' },
    { value: 'cyan', label: 'Cyan', swatch: 'bg-cyan-500' },
    { value: 'fuchsia', label: 'Fuchsia', swatch: 'bg-fuchsia-500' },
    { value: 'lime', label: 'Lime', swatch: 'bg-lime-500' },
];

const SCOPES = [
    { value: 'PROJECT', label: 'Projects' },
    { value: 'TASK', label: 'Tasks' },
];

// Two grouped sections in the side rail. Each entry maps to an anchor
// id used by both the rail (link target) and the right-hand column
// (section element).
// Products catalogue manager: name + optional code + description, with
// create / edit / activate / delete. Projects pick from the active set.
function ProductsManager() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [form, setForm] = useState({ name: '', code: '', description: '' });
    const [editingId, setEditingId] = useState(null);
    const [edit, setEdit] = useState({ name: '', code: '', description: '' });
    const [saving, setSaving] = useState(false);

    const load = () => {
        setLoading(true);
        api.get('/templates/products?includeInactive=1')
            .then(({ data }) => setItems(data.products || []))
            .catch(() => setItems([]))
            .finally(() => setLoading(false));
    };
    useEffect(load, []);

    const create = async () => {
        if (!form.name.trim()) return toast.error('Enter a product name.');
        setSaving(true);
        try {
            await api.post('/templates/products', {
                name: form.name.trim(),
                code: form.code.trim() || null,
                description: form.description.trim() || null,
            });
            setForm({ name: '', code: '', description: '' });
            toast.success('Product added.');
            load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add product.');
        } finally {
            setSaving(false);
        }
    };

    const startEdit = (p) => {
        setEditingId(p.id);
        setEdit({
            name: p.name || '',
            code: p.code || '',
            description: p.description || '',
        });
    };

    const saveEdit = async () => {
        if (!edit.name.trim()) return toast.error('Enter a product name.');
        setSaving(true);
        try {
            await api.patch(`/templates/products/${editingId}`, {
                name: edit.name.trim(),
                code: edit.code.trim() || null,
                description: edit.description.trim() || null,
            });
            setEditingId(null);
            toast.success('Saved.');
            load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save.');
        } finally {
            setSaving(false);
        }
    };

    const toggleActive = async (p) => {
        try {
            await api.patch(`/templates/products/${p.id}`, {
                isActive: !p.isActive,
            });
            load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update.');
        }
    };

    const remove = async (p) => {
        if (!window.confirm(`Delete product "${p.name}"?`)) return;
        try {
            await api.delete(`/templates/products/${p.id}`);
            load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete.');
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <Package className="h-4 w-4" /> Products
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                {/* Add form */}
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <div className="space-y-1 sm:col-span-2">
                            <Label className="text-xs">Product name</Label>
                            <Input
                                value={form.name}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        name: e.target.value,
                                    }))
                                }
                                placeholder="e.g. POS Suite"
                            />
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs">Code</Label>
                            <Input
                                value={form.code}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        code: e.target.value,
                                    }))
                                }
                                placeholder="e.g. POS"
                            />
                        </div>
                    </div>
                    <div className="space-y-1">
                        <Label className="text-xs">Description</Label>
                        <Textarea
                            rows={2}
                            value={form.description}
                            onChange={(e) =>
                                setForm((f) => ({
                                    ...f,
                                    description: e.target.value,
                                }))
                            }
                            placeholder="Optional short description"
                        />
                    </div>
                    <div className="flex justify-end">
                        <Button
                            size="sm"
                            className="gap-1.5"
                            onClick={create}
                            disabled={saving}
                        >
                            <Plus className="h-4 w-4" /> Add product
                        </Button>
                    </div>
                </div>

                {/* List */}
                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                ) : items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        No products yet.
                    </p>
                ) : (
                    <ul className="divide-y rounded-lg border">
                        {items.map((p) => (
                            <li key={p.id} className="p-3">
                                {editingId === p.id ? (
                                    <div className="space-y-2">
                                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                            <Input
                                                className="sm:col-span-2"
                                                value={edit.name}
                                                onChange={(e) =>
                                                    setEdit((s) => ({
                                                        ...s,
                                                        name: e.target.value,
                                                    }))
                                                }
                                                placeholder="Product name"
                                            />
                                            <Input
                                                value={edit.code}
                                                onChange={(e) =>
                                                    setEdit((s) => ({
                                                        ...s,
                                                        code: e.target.value,
                                                    }))
                                                }
                                                placeholder="Code"
                                            />
                                        </div>
                                        <Textarea
                                            rows={2}
                                            value={edit.description}
                                            onChange={(e) =>
                                                setEdit((s) => ({
                                                    ...s,
                                                    description: e.target.value,
                                                }))
                                            }
                                            placeholder="Description"
                                        />
                                        <div className="flex justify-end gap-1.5">
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() =>
                                                    setEditingId(null)
                                                }
                                            >
                                                Cancel
                                            </Button>
                                            <Button
                                                size="sm"
                                                className="gap-1.5"
                                                onClick={saveEdit}
                                                disabled={saving}
                                            >
                                                <Save className="h-4 w-4" /> Save
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-between gap-3">
                                        {/* One line: code · name · first bit
                                            of description (truncated, no wrap). */}
                                        <div className="flex min-w-0 flex-1 items-center gap-2">
                                            {p.code && (
                                                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                                                    {p.code}
                                                </span>
                                            )}
                                            <span
                                                className={cn(
                                                    'shrink-0 font-medium',
                                                    !p.isActive &&
                                                        'text-muted-foreground line-through',
                                                )}
                                            >
                                                {p.name}
                                            </span>
                                            {p.description && (
                                                <span
                                                    className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                                                    title={p.description}
                                                >
                                                    — {p.description}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1">
                                            <span
                                                className="mr-1"
                                                title={
                                                    p.isActive
                                                        ? 'Active'
                                                        : 'Inactive'
                                                }
                                            >
                                                <Switch
                                                    checked={p.isActive}
                                                    onCheckedChange={() =>
                                                        toggleActive(p)
                                                    }
                                                />
                                            </span>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-8 w-8"
                                                onClick={() => startEdit(p)}
                                            >
                                                <Pencil className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-8 w-8 text-rose-600"
                                                onClick={() => remove(p)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

// Entities catalogue manager: code + optional description, with create /
// edit / activate / delete. Projects pick from the active set.
function EntityManager() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [form, setForm] = useState({ code: '', description: '' });
    const [editingId, setEditingId] = useState(null);
    const [edit, setEdit] = useState({ code: '', description: '' });
    const [saving, setSaving] = useState(false);

    const load = () => {
        setLoading(true);
        api.get('/templates/entities?includeInactive=1')
            .then(({ data }) => setItems(data.entities || []))
            .catch(() => setItems([]))
            .finally(() => setLoading(false));
    };
    useEffect(load, []);

    const create = async () => {
        if (!form.code.trim()) return toast.error('Enter an entity code.');
        setSaving(true);
        try {
            await api.post('/templates/entities', {
                code: form.code.trim(),
                description: form.description.trim() || null,
            });
            setForm({ code: '', description: '' });
            toast.success('Entity added.');
            load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add entity.');
        } finally {
            setSaving(false);
        }
    };

    const startEdit = (e) => {
        setEditingId(e.id);
        setEdit({ code: e.code || '', description: e.description || '' });
    };

    const saveEdit = async () => {
        if (!edit.code.trim()) return toast.error('Enter an entity code.');
        setSaving(true);
        try {
            await api.patch(`/templates/entities/${editingId}`, {
                code: edit.code.trim(),
                description: edit.description.trim() || null,
            });
            setEditingId(null);
            toast.success('Saved.');
            load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save.');
        } finally {
            setSaving(false);
        }
    };

    const toggleActive = async (e) => {
        try {
            await api.patch(`/templates/entities/${e.id}`, {
                isActive: !e.isActive,
            });
            load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update.');
        }
    };

    const remove = async (e) => {
        if (!window.confirm(`Delete entity "${e.code}"?`)) return;
        try {
            await api.delete(`/templates/entities/${e.id}`);
            load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete.');
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <Building2 className="h-4 w-4" /> Entities
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <div className="space-y-1">
                            <Label className="text-xs">Entity code</Label>
                            <Input
                                value={form.code}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        code: e.target.value,
                                    }))
                                }
                                placeholder="e.g. RS-01"
                            />
                        </div>
                        <div className="space-y-1 sm:col-span-2">
                            <Label className="text-xs">Description</Label>
                            <Input
                                value={form.description}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        description: e.target.value,
                                    }))
                                }
                                placeholder="Optional description"
                            />
                        </div>
                    </div>
                    <div className="flex justify-end">
                        <Button
                            size="sm"
                            className="gap-1.5"
                            onClick={create}
                            disabled={saving}
                        >
                            <Plus className="h-4 w-4" /> Add entity
                        </Button>
                    </div>
                </div>

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                ) : items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        No entities yet.
                    </p>
                ) : (
                    <ul className="divide-y rounded-lg border">
                        {items.map((e) => (
                            <li key={e.id} className="p-3">
                                {editingId === e.id ? (
                                    <div className="space-y-2">
                                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                            <Input
                                                value={edit.code}
                                                onChange={(ev) =>
                                                    setEdit((s) => ({
                                                        ...s,
                                                        code: ev.target.value,
                                                    }))
                                                }
                                                placeholder="Code"
                                            />
                                            <Input
                                                className="sm:col-span-2"
                                                value={edit.description}
                                                onChange={(ev) =>
                                                    setEdit((s) => ({
                                                        ...s,
                                                        description:
                                                            ev.target.value,
                                                    }))
                                                }
                                                placeholder="Description"
                                            />
                                        </div>
                                        <div className="flex justify-end gap-1.5">
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() =>
                                                    setEditingId(null)
                                                }
                                            >
                                                Cancel
                                            </Button>
                                            <Button
                                                size="sm"
                                                className="gap-1.5"
                                                onClick={saveEdit}
                                                disabled={saving}
                                            >
                                                <Save className="h-4 w-4" /> Save
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                                                    {e.code}
                                                </span>
                                                {!e.isActive && (
                                                    <span className="text-[10px] text-muted-foreground">
                                                        (hidden)
                                                    </span>
                                                )}
                                            </div>
                                            {e.description && (
                                                <p className="mt-0.5 text-xs text-muted-foreground">
                                                    {e.description}
                                                </p>
                                            )}
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1">
                                            <span className="mr-1">
                                                <Switch
                                                    checked={e.isActive}
                                                    onCheckedChange={() =>
                                                        toggleActive(e)
                                                    }
                                                />
                                            </span>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-8 w-8"
                                                onClick={() => startEdit(e)}
                                            >
                                                <Pencil className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-8 w-8 text-rose-600"
                                                onClick={() => remove(e)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

const SECTION_GROUPS = [
    {
        title: 'Workflow',
        description:
            'How work flows through a project — phases and priorities.',
        items: [
            {
                id: 'phases',
                label: 'Phase templates',
                icon: Layers,
                accent: 'from-violet-500 to-indigo-500',
                description:
                    'The default lanes a brand-new project starts with.',
            },
            {
                id: 'statuses',
                label: 'Statuses',
                icon: Layers,
                accent: 'from-sky-500 to-violet-500',
                description:
                    'Custom labels and colours for project & task statuses.',
            },
            {
                id: 'priorities',
                label: 'Priorities',
                icon: Tag,
                accent: 'from-rose-500 to-amber-500',
                description:
                    'Custom labels and colours for project & task priorities.',
            },
        ],
    },
    {
        title: 'Catalogues',
        description:
            'Pickable values that show up in the project form dropdowns.',
        items: [
            {
                id: 'project-types',
                label: 'Project types',
                icon: FolderKanban,
                accent: 'from-emerald-500 to-teal-500',
                description:
                    'Categories like Internal, Consulting, R&D — surfaced in dropdowns and time-tracking exports.',
            },
            {
                id: 'products',
                label: 'Products',
                icon: Package,
                accent: 'from-amber-500 to-orange-500',
                description:
                    'The products a project relates to (name, code, description). Picked on the project form in place of an application.',
            },
            {
                id: 'entities',
                label: 'Entities',
                icon: Building2,
                accent: 'from-teal-500 to-cyan-500',
                description:
                    'Billing/accounting entities (code + description) tagged on each project and grouped in the logged-time export.',
            },
            {
                id: 'countries',
                label: 'Countries',
                icon: Globe,
                accent: 'from-fuchsia-500 to-purple-500',
                description:
                    'Country tags used by the project codes (e.g. P-26-USA-0001).',
            },
        ],
    },
    {
        title: 'Organization',
        description: 'Org-chart values surfaced on each user profile.',
        items: [
            {
                id: 'business-units',
                label: 'Business units',
                icon: Building2,
                accent: 'from-indigo-500 to-violet-500',
                description:
                    'Org units / departments users belong to. Selectable from their profile dialog.',
            },
        ],
    },
    {
        title: 'Apps',
        description:
            'Pickable values used by the Releases form on the Applications page.',
        items: [
            {
                id: 'app-os',
                label: 'Target OS options',
                icon: Monitor,
                accent: 'from-cyan-500 to-blue-500',
                description:
                    'OS values releases can target (Android 12+, Windows 10, iOS 16…). Multi-select on each release.',
            },
            {
                id: 'app-pos-terminals',
                label: 'POS terminal types',
                icon: Terminal,
                accent: 'from-orange-500 to-red-500',
                description:
                    'Terminal models a release supports (Verifone P200, Ingenico iSC250…). Multi-select on each release.',
            },
        ],
    },
    {
        title: 'Tickets',
        description:
            'Help-desk request types shown as cards on the requester portal.',
        items: [
            {
                id: 'ticket-types',
                label: 'Ticket types',
                icon: LifeBuoy,
                accent: 'from-sky-500 to-cyan-500',
                description:
                    'Request types requesters pick from on the portal (e.g. IPS Problems, POS Problems).',
            },
            {
                id: 'requester-groups',
                label: 'Requester groups',
                icon: Users,
                accent: 'from-teal-500 to-emerald-500',
                description:
                    'Named groups of people a requester can add to a ticket all at once.',
            },
            {
                id: 'terminals',
                label: 'Terminals',
                icon: Terminal,
                accent: 'from-violet-500 to-fuchsia-500',
                description:
                    'Vendors and their terminal models (with OS type), used when raising tickets.',
            },
        ],
    },
];

// Maps a section id to its editor. The right pane renders only the
// active one (master-detail), instead of stacking every section.
function renderSection(id) {
    switch (id) {
        case 'phases':
            return <PhaseTemplates />;
        case 'statuses':
            return <StatusOptions />;
        case 'priorities':
            return <PriorityOptions />;
        case 'products':
            return <ProductsManager />;
        case 'entities':
            return <EntityManager />;
        case 'project-types':
            return (
                <CatalogCard
                    title="Project types"
                    icon={FolderKanban}
                    path="project-types"
                    singular="project type"
                    showActivityCode
                    placeholder="e.g. Internal, Consulting, Maintenance"
                    description="Categories for projects. Enable Hide complete for ongoing types (e.g. Maintenance) to remove Completed, Client test, and Billing from status options and hide Mark complete."
                    showHideComplete
                />
            );
        case 'countries':
            return (
                <CatalogCard
                    title="Countries"
                    icon={Globe}
                    path="countries"
                    singular="country"
                    placeholder="e.g. Germany"
                    description="Pickable list of countries on the project form."
                />
            );
        case 'business-units':
            return (
                <CatalogCard
                    title="Business units"
                    icon={Building2}
                    path="business-units"
                    singular="business unit"
                    placeholder="e.g. Engineering, Finance, Sales"
                    description="Pickable list of org units on the user profile. Only admins can change a user's business unit."
                />
            );
        case 'app-os':
            return (
                <CatalogCard
                    title="Target OS options"
                    icon={Monitor}
                    path="app-os"
                    singular="target OS"
                    placeholder="e.g. Android 12+"
                    description="Multi-select values offered when adding or editing a release."
                />
            );
        case 'app-pos-terminals':
            return (
                <CatalogCard
                    title="POS terminal types"
                    icon={Terminal}
                    path="app-pos-terminals"
                    singular="POS terminal"
                    placeholder="e.g. Verifone P200"
                    description="Multi-select terminal models offered when adding or editing a release."
                />
            );
        case 'ticket-types':
            return (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <LifeBuoy className="h-4 w-4 text-muted-foreground" />
                            Ticket types
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <TicketTypesManager />
                    </CardContent>
                </Card>
            );
        case 'requester-groups':
            return (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Users className="h-4 w-4 text-muted-foreground" />
                            Requester groups
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <RequesterGroupsManager />
                    </CardContent>
                </Card>
            );
        case 'terminals':
            return (
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Terminal className="h-4 w-4 text-muted-foreground" />
                            Terminals
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <TerminalsManager />
                    </CardContent>
                </Card>
            );
        default:
            return null;
    }
}

const ACTIVE_STORAGE = 'pm.templates.activeSection.v1';
const NAV_COLLAPSE_STORAGE = 'pm.templates.navCollapsed.v1';

function readActiveSection() {
    try {
        const saved = localStorage.getItem(ACTIVE_STORAGE);
        if (saved && findSection(saved)) return saved;
    } catch {
        /* ignore */
    }
    return 'phases';
}

function readNavCollapsed() {
    try {
        return localStorage.getItem(NAV_COLLAPSE_STORAGE) === '1';
    } catch {
        return false;
    }
}

export default function Templates() {
    const [active, setActive] = useState(readActiveSection);
    const [navCollapsed, setNavCollapsed] = useState(readNavCollapsed);

    useEffect(() => {
        try {
            localStorage.setItem(ACTIVE_STORAGE, active);
        } catch {
            /* ignore */
        }
    }, [active]);

    useEffect(() => {
        try {
            localStorage.setItem(
                NAV_COLLAPSE_STORAGE,
                navCollapsed ? '1' : '0',
            );
        } catch {
            /* ignore */
        }
    }, [navCollapsed]);

    const activeSection = findSection(active);

    return (
        <>
            <TopBar title="Templates" />
            <AdminTabs />
            <main className="flex-1 overflow-auto bg-muted/20">
                <div className="flex w-full flex-col gap-4 p-3 sm:p-6">
                    <TemplatesHeader />
                    <div className="flex items-start gap-4">
                        <TemplatesNav
                            active={active}
                            onSelect={setActive}
                            collapsed={navCollapsed}
                            onToggleCollapsed={() =>
                                setNavCollapsed((v) => !v)
                            }
                        />
                        {/* Master-detail: only the selected section's
                            editor renders here, instead of stacking
                            every section's card. */}
                        <div className="min-w-0 flex-1 space-y-3">
                            {activeSection && (
                                <div className="flex items-start gap-3 px-1">
                                    <div
                                        className={cn(
                                            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-sm',
                                            activeSection.accent,
                                        )}
                                    >
                                        <activeSection.icon className="h-4 w-4" />
                                    </div>
                                    <div className="min-w-0">
                                        <h2 className="text-sm font-semibold tracking-tight">
                                            {activeSection.label}
                                        </h2>
                                        <p className="text-xs text-muted-foreground">
                                            {activeSection.description}
                                        </p>
                                    </div>
                                </div>
                            )}
                            {renderSection(active)}
                        </div>
                    </div>
                </div>
            </main>
        </>
    );
}

function findSection(id) {
    for (const group of SECTION_GROUPS) {
        const hit = group.items.find((s) => s.id === id);
        if (hit) return hit;
    }
    return null;
}

// Hero band. Pure presentation — gives the page a clear identity.
function TemplatesHeader() {
    return (
        <div className="relative overflow-hidden rounded-xl border bg-gradient-to-br from-primary/10 via-card to-card p-4 shadow-sm sm:p-6">
            <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
            <div className="relative flex items-start gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary shadow-inner">
                    <Settings2 className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                    <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                        Workspace templates
                    </h1>
                    <p className="max-w-2xl text-sm text-muted-foreground">
                        Curate the phases, priorities, project types and
                        picklists that everyone in the workspace gets to
                        choose from. Pick a section on the left to edit it.
                    </p>
                </div>
            </div>
        </div>
    );
}

// Section navigator rail. Clicking an item swaps the right-hand editor
// (master-detail). Collapses to an icon-only strip (like the main app
// sidebar) via the chevrons toggle; the choice is remembered.
function TemplatesNav({ active, onSelect, collapsed, onToggleCollapsed }) {
    return (
        <aside
            className={cn(
                'shrink-0 transition-[width] duration-200',
                collapsed ? 'w-14' : 'w-60',
            )}
        >
            <nav className="sticky top-3 space-y-3 rounded-xl border bg-card p-2 shadow-sm">
                <button
                    type="button"
                    onClick={onToggleCollapsed}
                    className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                        collapsed && 'justify-center',
                    )}
                    title={collapsed ? 'Expand sections' : 'Collapse sections'}
                    aria-label={
                        collapsed ? 'Expand sections' : 'Collapse sections'
                    }
                >
                    {collapsed ? (
                        <ChevronsRight className="h-4 w-4" />
                    ) : (
                        <>
                            <Sparkles className="h-3 w-3" />
                            <span className="flex-1 text-left">Sections</span>
                            <ChevronsLeft className="h-4 w-4" />
                        </>
                    )}
                </button>
                {SECTION_GROUPS.map((group) => (
                    <div key={group.title} className="space-y-1">
                        {!collapsed && (
                            <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                                {group.title}
                            </div>
                        )}
                        <ul className="space-y-0.5">
                            {group.items.map((item) => {
                                const isActive = item.id === active;
                                return (
                                    <li key={item.id}>
                                        <button
                                            type="button"
                                            onClick={() => onSelect(item.id)}
                                            title={item.label}
                                            aria-current={
                                                isActive ? 'true' : undefined
                                            }
                                            className={cn(
                                                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors',
                                                collapsed && 'justify-center',
                                                isActive
                                                    ? 'bg-primary/10 text-primary'
                                                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                                            )}
                                        >
                                            <span
                                                className={cn(
                                                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br text-white shadow-sm',
                                                    item.accent,
                                                )}
                                            >
                                                <item.icon className="h-3.5 w-3.5" />
                                            </span>
                                            {!collapsed && (
                                                <span className="truncate">
                                                    {item.label}
                                                </span>
                                            )}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                ))}
            </nav>
        </aside>
    );
}

// Shared card for any catalog with the simple {name, order, isActive}
// shape (countries, clients). Mirrors the look of PhaseTemplates so
// admins get a familiar editing surface for every list.
function CatalogCard({
    title,
    icon: Icon,
    path,
    singular,
    placeholder,
    description,
    showHideComplete = false,
    showActivityCode = false,
}) {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [name, setName] = useState('');
    const [activityCode, setActivityCode] = useState('');
    const [creating, setCreating] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [editingName, setEditingName] = useState('');
    const [editingActivityCode, setEditingActivityCode] = useState('');

    const load = async () => {
        try {
            const res = await api.get(`/templates/${path}?includeInactive=1`);
            setItems(res.data[path] || []);
            // Drop the cached "active-only" list so dropdowns
            // elsewhere refresh next time they're opened.
            invalidateCatalog(path);
        } catch {
            toast.error(`Failed to load ${title.toLowerCase()}`);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path]);

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setCreating(true);
        try {
            await api.post(`/templates/${path}`, {
                name: name.trim(),
                ...(showActivityCode
                    ? { activityCode: activityCode.trim() || null }
                    : {}),
            });
            setName('');
            setActivityCode('');
            await load();
            toast.success(`${capitalise(singular)} added`);
        } catch (err) {
            toast.error(
                err.response?.data?.error || `Could not add ${singular}`,
            );
        } finally {
            setCreating(false);
        }
    };

    const handleSaveEdit = async (id) => {
        if (!editingName.trim()) return;
        try {
            await api.patch(`/templates/${path}/${id}`, {
                name: editingName.trim(),
                ...(showActivityCode
                    ? { activityCode: editingActivityCode.trim() || null }
                    : {}),
            });
            setEditingId(null);
            setEditingName('');
            setEditingActivityCode('');
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save');
        }
    };

    const handleToggleActive = async (item) => {
        try {
            await api.patch(`/templates/${path}/${item.id}`, {
                isActive: !item.isActive,
            });
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update');
        }
    };

    const handleToggleHideComplete = async (item) => {
        try {
            await api.patch(`/templates/${path}/${item.id}`, {
                hideMarkComplete: !item.hideMarkComplete,
            });
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update');
        }
    };

    const handleDelete = async (item) => {
        if (!window.confirm(`Delete ${singular} "${item.name}"?`)) return;
        try {
            await api.delete(`/templates/${path}/${item.id}`);
            await load();
            toast.success(`${capitalise(singular)} removed`);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete');
        }
    };

    const move = async (idx, dir) => {
        const target = idx + dir;
        if (target < 0 || target >= items.length) return;
        const next = items.slice();
        const [removed] = next.splice(idx, 1);
        next.splice(target, 0, removed);
        setItems(next);
        try {
            await api.post(`/templates/${path}/reorder`, {
                ids: next.map((p) => p.id),
            });
            invalidateCatalog(path);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not reorder');
            await load();
        }
    };

    return (
        <Card className="flex h-full min-h-0 flex-col">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {title}
                </CardTitle>
                <p className="text-xs text-muted-foreground">{description}</p>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
                <form
                    onSubmit={handleCreate}
                    className="flex flex-col gap-2 sm:flex-row sm:items-end"
                >
                    <div className="flex-1 space-y-1.5">
                        <Label htmlFor={`${path}-name`}>
                            New {singular}
                        </Label>
                        <Input
                            id={`${path}-name`}
                            placeholder={placeholder}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </div>
                    {showActivityCode && (
                        <div className="space-y-1.5 sm:w-40">
                            <Label htmlFor={`${path}-code`}>
                                Activity code
                            </Label>
                            <Input
                                id={`${path}-code`}
                                placeholder="e.g. ACT-01"
                                value={activityCode}
                                onChange={(e) =>
                                    setActivityCode(e.target.value)
                                }
                            />
                        </div>
                    )}
                    <Button
                        type="submit"
                        className="gap-2"
                        disabled={creating || !name.trim()}
                    >
                        <Plus className="h-4 w-4" />
                        Add {singular}
                    </Button>
                </form>

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                ) : items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        No {title.toLowerCase()} yet. Add one above.
                    </p>
                ) : (
                    <ul className="min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border">
                        {items.map((item, idx) => {
                            const isEditing = editingId === item.id;
                            return (
                                <li
                                    key={item.id}
                                    className={cn(
                                        'flex items-center gap-3 px-3 py-2',
                                        !item.isActive && 'opacity-60',
                                    )}
                                >
                                    <div className="flex items-center text-muted-foreground">
                                        <GripVertical className="h-4 w-4" />
                                    </div>
                                    {isEditing ? (
                                        <>
                                            <Input
                                                autoFocus
                                                value={editingName}
                                                onChange={(e) =>
                                                    setEditingName(
                                                        e.target.value,
                                                    )
                                                }
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter')
                                                        handleSaveEdit(item.id);
                                                    if (e.key === 'Escape') {
                                                        setEditingId(null);
                                                        setEditingName('');
                                                    }
                                                }}
                                                className="h-8 max-w-xs"
                                            />
                                            {showActivityCode && (
                                                <Input
                                                    value={editingActivityCode}
                                                    onChange={(e) =>
                                                        setEditingActivityCode(
                                                            e.target.value,
                                                        )
                                                    }
                                                    placeholder="Activity code"
                                                    className="h-8 w-32"
                                                />
                                            )}
                                        </>
                                    ) : (
                                        <span className="flex flex-1 items-center gap-2 text-sm font-medium">
                                            {item.name}
                                            {showActivityCode &&
                                                item.activityCode && (
                                                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                                                        {item.activityCode}
                                                    </span>
                                                )}
                                        </span>
                                    )}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        title="Move up"
                                        onClick={() => move(idx, -1)}
                                        disabled={idx === 0}
                                    >
                                        <ArrowUp className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        title="Move down"
                                        onClick={() => move(idx, 1)}
                                        disabled={idx === items.length - 1}
                                    >
                                        <ArrowDown className="h-3.5 w-3.5" />
                                    </Button>
                                    <div className="flex items-center gap-2 px-2">
                                        <Switch
                                            checked={item.isActive}
                                            onCheckedChange={() =>
                                                handleToggleActive(item)
                                            }
                                            aria-label={
                                                item.isActive
                                                    ? `Disable ${singular}`
                                                    : `Enable ${singular}`
                                            }
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            {item.isActive
                                                ? 'Active'
                                                : 'Hidden'}
                                        </span>
                                    </div>
                                    {showHideComplete && (
                                        <div className="flex items-center gap-2 px-1">
                                            <Switch
                                                checked={Boolean(
                                                    item.hideMarkComplete,
                                                )}
                                                onCheckedChange={() =>
                                                    handleToggleHideComplete(
                                                        item,
                                                    )
                                                }
                                                aria-label="Hide mark complete"
                                            />
                                            <span className="text-[10px] text-muted-foreground">
                                                Hide complete
                                            </span>
                                        </div>
                                    )}
                                    {isEditing ? (
                                        <>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() =>
                                                    handleSaveEdit(item.id)
                                                }
                                                title="Save"
                                            >
                                                <Save className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() => {
                                                    setEditingId(null);
                                                    setEditingName('');
                                                }}
                                                title="Cancel"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </Button>
                                        </>
                                    ) : (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-7 w-7"
                                            onClick={() => {
                                                setEditingId(item.id);
                                                setEditingName(item.name);
                                                setEditingActivityCode(
                                                    item.activityCode || '',
                                                );
                                            }}
                                            title="Rename"
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                        </Button>
                                    )}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7 text-destructive hover:text-destructive"
                                        onClick={() => handleDelete(item)}
                                        title="Delete"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

function capitalise(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// Compact / inline colour picker used by the Phase templates list.
// `compact: true` shrinks the trigger to a square swatch so it fits
// next to the GripVertical handle without pushing the row name out
// of view. Empty value === "Auto" (deterministic hash colour on
// the plan; no override). Closing the popover commits the click —
// no separate confirm button.
function PhaseColorPicker({ value, onChange, compact = false }) {
    // External `value` is `'' | null | token`. We map both falsy
    // states to the AUTO sentinel for Radix, then translate back at
    // the onValueChange boundary so callers keep seeing the same
    // shape they pass in.
    const internalValue = value ? value : PHASE_AUTO_COLOR;
    const current =
        PHASE_TEMPLATE_COLORS.find((c) => c.value === internalValue) ||
        PHASE_TEMPLATE_COLORS[0];
    return (
        <Select
            value={internalValue}
            onValueChange={(v) =>
                onChange(v === PHASE_AUTO_COLOR ? '' : v)
            }
        >
            <SelectTrigger
                className={cn(
                    compact ? 'h-8 w-32' : 'h-9 w-full',
                    'gap-2',
                )}
                aria-label="Phase colour"
            >
                <span className="flex items-center gap-2">
                    <span
                        className={cn(
                            'inline-block h-3.5 w-3.5 rounded-sm ring-1 ring-border',
                            current.swatch,
                        )}
                    />
                    <span className="text-xs">{current.label}</span>
                </span>
            </SelectTrigger>
            <SelectContent>
                {PHASE_TEMPLATE_COLORS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                        <span className="flex items-center gap-2">
                            <span
                                className={cn(
                                    'inline-block h-3.5 w-3.5 rounded-sm ring-1 ring-border',
                                    c.swatch,
                                )}
                            />
                            {c.label}
                        </span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function PhaseTemplates() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [name, setName] = useState('');
    // Color for the NEW-phase form. Empty string === "Auto" (no
    // colour stored on the row — the FE will fall back to the
    // deterministic hash-derived palette slot). Anything else is a
    // colour token from PHASE_TEMPLATE_COLORS above.
    const [draftColor, setDraftColor] = useState('');
    const [creating, setCreating] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [editingName, setEditingName] = useState('');
    const [editingColor, setEditingColor] = useState('');

    const load = async () => {
        try {
            const res = await api.get('/templates/phases?includeInactive=1');
            setItems(res.data.phases);
        } catch {
            toast.error('Failed to load phase templates');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setCreating(true);
        try {
            await api.post('/templates/phases', {
                name: name.trim(),
                // BE accepts `null` to mean "auto colour"; we send the
                // empty-string state as null so the same picker drives
                // both create and edit without an extra branch.
                color: draftColor || null,
            });
            setName('');
            setDraftColor('');
            await load();
            toast.success('Phase added');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add phase');
        } finally {
            setCreating(false);
        }
    };

    const handleSaveEdit = async (id) => {
        if (!editingName.trim()) return;
        try {
            await api.patch(`/templates/phases/${id}`, {
                name: editingName.trim(),
                color: editingColor || null,
            });
            setEditingId(null);
            setEditingName('');
            setEditingColor('');
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save');
        }
    };

    // Edit a colour swatch only (no rename). Renders inline next to
    // each row so admins can swap colours without entering edit mode
    // for every change. We send `name` unchanged so the BE's "value
    // already exists" guard doesn't false-positive.
    const handleQuickColor = async (item, color) => {
        try {
            await api.patch(`/templates/phases/${item.id}`, {
                color: color || null,
            });
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save colour');
        }
    };

    const handleToggleActive = async (item) => {
        try {
            await api.patch(`/templates/phases/${item.id}`, {
                isActive: !item.isActive,
            });
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update');
        }
    };

    const handleDelete = async (item) => {
        if (!window.confirm(`Delete phase "${item.name}"?`)) return;
        try {
            await api.delete(`/templates/phases/${item.id}`);
            await load();
            toast.success('Phase removed');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete');
        }
    };

    const move = async (idx, dir) => {
        const target = idx + dir;
        if (target < 0 || target >= items.length) return;
        const next = items.slice();
        const [removed] = next.splice(idx, 1);
        next.splice(target, 0, removed);
        setItems(next);
        try {
            await api.post('/templates/phases/reorder', {
                ids: next.map((p) => p.id),
            });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not reorder');
            await load();
        }
    };

    return (
        <Card className="flex h-full min-h-0 flex-col">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <Layers className="h-4 w-4 text-muted-foreground" />
                    Phase templates
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                    Active phases are seeded onto every new project and
                    available in the "Add phase" dropdown.
                </p>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
                <form
                    onSubmit={handleCreate}
                    className="flex flex-col gap-2 sm:flex-row sm:items-end"
                >
                    <div className="flex-1 space-y-1.5">
                        <Label htmlFor="phase-template-name">New phase</Label>
                        <Input
                            id="phase-template-name"
                            placeholder="e.g. Discovery"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                        />
                    </div>
                    <div className="w-full space-y-1.5 sm:w-48">
                        <Label>Colour</Label>
                        <PhaseColorPicker
                            value={draftColor}
                            onChange={setDraftColor}
                        />
                    </div>
                    <Button
                        type="submit"
                        className="gap-2"
                        disabled={creating || !name.trim()}
                    >
                        <Plus className="h-4 w-4" />
                        Add phase
                    </Button>
                </form>

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                ) : items.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        No phase templates yet. Add one above.
                    </p>
                ) : (
                    <ul className="min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border">
                        {items.map((item, idx) => {
                            const isEditing = editingId === item.id;
                            return (
                                <li
                                    key={item.id}
                                    className={cn(
                                        'flex items-center gap-3 px-3 py-2',
                                        !item.isActive && 'opacity-60',
                                    )}
                                >
                                    <div className="flex items-center text-muted-foreground">
                                        <GripVertical className="h-4 w-4" />
                                    </div>
                                    {/* Per-row colour swatch. In edit mode
                                        the picker writes to local state
                                        (saved with the row); outside edit
                                        mode it's a one-click quick-pick
                                        that PATCHes immediately so admins
                                        can recolour without entering
                                        edit-rename mode. */}
                                    {isEditing ? (
                                        <PhaseColorPicker
                                            value={editingColor}
                                            onChange={setEditingColor}
                                            compact
                                        />
                                    ) : (
                                        <PhaseColorPicker
                                            value={item.color || ''}
                                            onChange={(c) =>
                                                handleQuickColor(item, c)
                                            }
                                            compact
                                        />
                                    )}
                                    {isEditing ? (
                                        <Input
                                            autoFocus
                                            value={editingName}
                                            onChange={(e) =>
                                                setEditingName(e.target.value)
                                            }
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter')
                                                    handleSaveEdit(item.id);
                                                if (e.key === 'Escape') {
                                                    setEditingId(null);
                                                    setEditingName('');
                                                    setEditingColor('');
                                                }
                                            }}
                                            className="h-8 max-w-xs"
                                        />
                                    ) : (
                                        <span className="flex-1 text-sm font-medium">
                                            {item.name}
                                        </span>
                                    )}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        title="Move up"
                                        onClick={() => move(idx, -1)}
                                        disabled={idx === 0}
                                    >
                                        <ArrowUp className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        title="Move down"
                                        onClick={() => move(idx, 1)}
                                        disabled={idx === items.length - 1}
                                    >
                                        <ArrowDown className="h-3.5 w-3.5" />
                                    </Button>
                                    <div className="flex items-center gap-2 px-2">
                                        <Switch
                                            checked={item.isActive}
                                            onCheckedChange={() =>
                                                handleToggleActive(item)
                                            }
                                            aria-label={
                                                item.isActive
                                                    ? 'Disable phase'
                                                    : 'Enable phase'
                                            }
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            {item.isActive ? 'Active' : 'Hidden'}
                                        </span>
                                    </div>
                                    {isEditing ? (
                                        <>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() =>
                                                    handleSaveEdit(item.id)
                                                }
                                                title="Save"
                                            >
                                                <Save className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() => {
                                                    setEditingId(null);
                                                    setEditingName('');
                                                    setEditingColor('');
                                                }}
                                                title="Cancel"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </Button>
                                        </>
                                    ) : (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-7 w-7"
                                            onClick={() => {
                                                setEditingId(item.id);
                                                setEditingName(item.name);
                                                setEditingColor(
                                                    item.color || '',
                                                );
                                            }}
                                            title="Rename"
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                        </Button>
                                    )}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7 text-destructive hover:text-destructive"
                                        onClick={() => handleDelete(item)}
                                        title="Delete"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

function StatusOptions() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [scope, setScope] = useState('PROJECT');
    const [draft, setDraft] = useState({ key: '', label: '', color: 'slate' });
    const [creating, setCreating] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [editingDraft, setEditingDraft] = useState({
        label: '',
        color: 'slate',
    });

    const load = async () => {
        try {
            const res = await api.get('/templates/statuses');
            setItems(res.data.statuses);
            invalidateStatuses();
        } catch {
            toast.error('Failed to load statuses');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const filtered = items.filter((p) => p.scope === scope);

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!draft.key.trim() || !draft.label.trim()) return;
        setCreating(true);
        try {
            await api.post('/templates/statuses', {
                scope,
                key: draft.key.trim().toUpperCase(),
                label: draft.label.trim(),
                color: draft.color,
            });
            setDraft({ key: '', label: '', color: 'slate' });
            await load();
            toast.success('Status added');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add status');
        } finally {
            setCreating(false);
        }
    };

    const handleSaveEdit = async (id) => {
        try {
            await api.patch(`/templates/statuses/${id}`, {
                label: editingDraft.label.trim(),
                color: editingDraft.color,
            });
            setEditingId(null);
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save');
        }
    };

    const handleToggleActive = async (item) => {
        try {
            await api.patch(`/templates/statuses/${item.id}`, {
                isActive: !item.isActive,
            });
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update');
        }
    };

    const handleDelete = async (item) => {
        if (!window.confirm(`Delete status "${item.label}"?`)) return;
        try {
            await api.delete(`/templates/statuses/${item.id}`);
            await load();
            toast.success('Status removed');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete');
        }
    };

    const move = async (idx, dir) => {
        const target = idx + dir;
        if (target < 0 || target >= filtered.length) return;
        const next = filtered.slice();
        const [removed] = next.splice(idx, 1);
        next.splice(target, 0, removed);
        setItems((prev) => {
            const others = prev.filter((p) => p.scope !== scope);
            return [...others, ...next];
        });
        try {
            await api.post('/templates/statuses/reorder', {
                scope,
                ids: next.map((p) => p.id),
            });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not reorder');
            await load();
        }
    };

    return (
        <Card className="flex h-full min-h-0 flex-col">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <Layers className="h-4 w-4 text-muted-foreground" />
                    Statuses
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                    Customize the labels and colors used for project status
                    badges. (Task statuses are fixed for now.)
                </p>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
                <form
                    onSubmit={handleCreate}
                    className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_1fr_160px_auto] sm:items-end"
                >
                    <div className="space-y-1.5">
                        <Label className="text-xs">Key</Label>
                        <Input
                            placeholder="e.g. IN_REVIEW"
                            value={draft.key}
                            onChange={(e) =>
                                setDraft((d) => ({ ...d, key: e.target.value }))
                            }
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Label</Label>
                        <Input
                            placeholder="e.g. In review"
                            value={draft.label}
                            onChange={(e) =>
                                setDraft((d) => ({
                                    ...d,
                                    label: e.target.value,
                                }))
                            }
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Color</Label>
                        <ColorSelect
                            value={draft.color}
                            onChange={(v) =>
                                setDraft((d) => ({ ...d, color: v }))
                            }
                        />
                    </div>
                    <Button
                        type="submit"
                        className="gap-2"
                        disabled={
                            creating ||
                            !draft.key.trim() ||
                            !draft.label.trim()
                        }
                    >
                        <Plus className="h-4 w-4" />
                        Add
                    </Button>
                </form>

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                ) : filtered.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        No statuses yet for this scope.
                    </p>
                ) : (
                    <ul className="min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border">
                        {filtered.map((item, idx) => {
                            const isEditing = editingId === item.id;
                            return (
                                <li
                                    key={item.id}
                                    className={cn(
                                        'flex flex-wrap items-center gap-3 px-3 py-2',
                                        !item.isActive && 'opacity-60',
                                    )}
                                >
                                    <PrioritySwatch color={item.color} />
                                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                                        {item.key}
                                    </code>
                                    {isEditing ? (
                                        <>
                                            <Input
                                                value={editingDraft.label}
                                                onChange={(e) =>
                                                    setEditingDraft((d) => ({
                                                        ...d,
                                                        label: e.target.value,
                                                    }))
                                                }
                                                className="h-8 max-w-xs"
                                            />
                                            <ColorSelect
                                                value={editingDraft.color}
                                                onChange={(v) =>
                                                    setEditingDraft((d) => ({
                                                        ...d,
                                                        color: v,
                                                    }))
                                                }
                                                className="h-8 w-40"
                                            />
                                        </>
                                    ) : (
                                        <span className="flex-1 text-sm font-medium">
                                            {item.label}
                                        </span>
                                    )}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        title="Move up"
                                        onClick={() => move(idx, -1)}
                                        disabled={idx === 0}
                                    >
                                        <ArrowUp className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        title="Move down"
                                        onClick={() => move(idx, 1)}
                                        disabled={idx === filtered.length - 1}
                                    >
                                        <ArrowDown className="h-3.5 w-3.5" />
                                    </Button>
                                    <div className="flex items-center gap-2 px-2">
                                        <Switch
                                            checked={item.isActive}
                                            onCheckedChange={() =>
                                                handleToggleActive(item)
                                            }
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            {item.isActive ? 'Active' : 'Hidden'}
                                        </span>
                                    </div>
                                    {isEditing ? (
                                        <>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() =>
                                                    handleSaveEdit(item.id)
                                                }
                                                title="Save"
                                            >
                                                <Save className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() => setEditingId(null)}
                                                title="Cancel"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </Button>
                                        </>
                                    ) : (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-7 w-7"
                                            onClick={() => {
                                                setEditingId(item.id);
                                                setEditingDraft({
                                                    label: item.label,
                                                    color: item.color,
                                                });
                                            }}
                                            title="Edit"
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                        </Button>
                                    )}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7 text-destructive hover:text-destructive"
                                        onClick={() => handleDelete(item)}
                                        title="Delete"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

function PriorityOptions() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [scope, setScope] = useState('PROJECT');
    const [draft, setDraft] = useState({
        key: '',
        label: '',
        color: 'slate',
    });
    const [creating, setCreating] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [editingDraft, setEditingDraft] = useState({ label: '', color: 'slate' });

    const load = async () => {
        try {
            const res = await api.get('/templates/priorities');
            setItems(res.data.priorities);
            invalidatePriorities();
        } catch {
            toast.error('Failed to load priorities');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const filtered = items.filter((p) => p.scope === scope);

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!draft.key.trim() || !draft.label.trim()) return;
        setCreating(true);
        try {
            await api.post('/templates/priorities', {
                scope,
                key: draft.key.trim().toUpperCase(),
                label: draft.label.trim(),
                color: draft.color,
            });
            setDraft({ key: '', label: '', color: 'slate' });
            await load();
            toast.success('Priority added');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not add priority');
        } finally {
            setCreating(false);
        }
    };

    const handleSaveEdit = async (id) => {
        try {
            await api.patch(`/templates/priorities/${id}`, {
                label: editingDraft.label.trim(),
                color: editingDraft.color,
            });
            setEditingId(null);
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save');
        }
    };

    const handleToggleActive = async (item) => {
        try {
            await api.patch(`/templates/priorities/${item.id}`, {
                isActive: !item.isActive,
            });
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update');
        }
    };

    const handleDelete = async (item) => {
        if (!window.confirm(`Delete priority "${item.label}"?`)) return;
        try {
            await api.delete(`/templates/priorities/${item.id}`);
            await load();
            toast.success('Priority removed');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete');
        }
    };

    const move = async (idx, dir) => {
        const target = idx + dir;
        if (target < 0 || target >= filtered.length) return;
        const next = filtered.slice();
        const [removed] = next.splice(idx, 1);
        next.splice(target, 0, removed);
        // Optimistically reorder the local list, then sync via the
        // dedicated reorder endpoint so the server state matches.
        setItems((prev) => {
            const others = prev.filter((p) => p.scope !== scope);
            return [...others, ...next];
        });
        try {
            await api.post('/templates/priorities/reorder', {
                scope,
                ids: next.map((p) => p.id),
            });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not reorder');
            await load();
        }
    };

    return (
        <Card className="flex h-full min-h-0 flex-col">
            <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                    <Tag className="h-4 w-4 text-muted-foreground" />
                    Priorities
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                    Customize the labels and colors used for priority badges.
                    Each scope has its own list.
                </p>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-4">
                <div className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground">
                        Scope
                    </Label>
                    <Select value={scope} onValueChange={setScope}>
                        <SelectTrigger className="h-9 w-40">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {SCOPES.map((s) => (
                                <SelectItem key={s.value} value={s.value}>
                                    {s.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <form
                    onSubmit={handleCreate}
                    className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_1fr_160px_auto] sm:items-end"
                >
                    <div className="space-y-1.5">
                        <Label className="text-xs">Key</Label>
                        <Input
                            placeholder="e.g. CRITICAL"
                            value={draft.key}
                            onChange={(e) =>
                                setDraft((d) => ({
                                    ...d,
                                    key: e.target.value,
                                }))
                            }
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Label</Label>
                        <Input
                            placeholder="e.g. Critical"
                            value={draft.label}
                            onChange={(e) =>
                                setDraft((d) => ({
                                    ...d,
                                    label: e.target.value,
                                }))
                            }
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label className="text-xs">Color</Label>
                        <ColorSelect
                            value={draft.color}
                            onChange={(v) =>
                                setDraft((d) => ({ ...d, color: v }))
                            }
                        />
                    </div>
                    <Button
                        type="submit"
                        className="gap-2"
                        disabled={
                            creating ||
                            !draft.key.trim() ||
                            !draft.label.trim()
                        }
                    >
                        <Plus className="h-4 w-4" />
                        Add
                    </Button>
                </form>

                {loading ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                ) : filtered.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        No priorities yet for this scope.
                    </p>
                ) : (
                    <ul className="min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border">
                        {filtered.map((item, idx) => {
                            const isEditing = editingId === item.id;
                            return (
                                <li
                                    key={item.id}
                                    className={cn(
                                        'flex flex-wrap items-center gap-3 px-3 py-2',
                                        !item.isActive && 'opacity-60',
                                    )}
                                >
                                    <PrioritySwatch color={item.color} />
                                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                                        {item.key}
                                    </code>
                                    {isEditing ? (
                                        <>
                                            <Input
                                                value={editingDraft.label}
                                                onChange={(e) =>
                                                    setEditingDraft((d) => ({
                                                        ...d,
                                                        label: e.target.value,
                                                    }))
                                                }
                                                className="h-8 max-w-xs"
                                            />
                                            <ColorSelect
                                                value={editingDraft.color}
                                                onChange={(v) =>
                                                    setEditingDraft((d) => ({
                                                        ...d,
                                                        color: v,
                                                    }))
                                                }
                                                className="h-8 w-40"
                                            />
                                        </>
                                    ) : (
                                        <span className="flex-1 text-sm font-medium">
                                            {item.label}
                                        </span>
                                    )}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        title="Move up"
                                        onClick={() => move(idx, -1)}
                                        disabled={idx === 0}
                                    >
                                        <ArrowUp className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7"
                                        title="Move down"
                                        onClick={() => move(idx, 1)}
                                        disabled={
                                            idx === filtered.length - 1
                                        }
                                    >
                                        <ArrowDown className="h-3.5 w-3.5" />
                                    </Button>
                                    <div className="flex items-center gap-2 px-2">
                                        <Switch
                                            checked={item.isActive}
                                            onCheckedChange={() =>
                                                handleToggleActive(item)
                                            }
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            {item.isActive ? 'Active' : 'Hidden'}
                                        </span>
                                    </div>
                                    {isEditing ? (
                                        <>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() =>
                                                    handleSaveEdit(item.id)
                                                }
                                                title="Save"
                                            >
                                                <Save className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() => setEditingId(null)}
                                                title="Cancel"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </Button>
                                        </>
                                    ) : (
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-7 w-7"
                                            onClick={() => {
                                                setEditingId(item.id);
                                                setEditingDraft({
                                                    label: item.label,
                                                    color: item.color,
                                                });
                                            }}
                                            title="Edit"
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                        </Button>
                                    )}
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-7 w-7 text-destructive hover:text-destructive"
                                        onClick={() => handleDelete(item)}
                                        title="Delete"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

function PrioritySwatch({ color }) {
    const swatch =
        PRIORITY_COLORS.find((c) => c.value === color)?.swatch ||
        'bg-slate-400';
    return (
        <span
            className={cn('inline-block h-4 w-4 rounded-full ring-1 ring-border', swatch)}
            title={color}
        />
    );
}

function ColorSelect({ value, onChange, className }) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger className={className}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {PRIORITY_COLORS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                        <span className="flex items-center gap-2">
                            <span
                                className={cn(
                                    'inline-block h-3 w-3 rounded-full',
                                    c.swatch,
                                )}
                            />
                            {c.label}
                        </span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
