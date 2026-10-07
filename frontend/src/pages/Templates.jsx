import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
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
    HelpCircle,
    Layers,
    LifeBuoy,
    Lock,
    Monitor,
    MoreHorizontal,
    Package,
    Pencil,
    Plus,
    Search,
    Slash,
    Sparkles,
    Tag,
    Terminal,
    Trash2,
    Users,
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

// Colour tokens stored on StatusOption / PriorityOption rows. The BE
// validates against this exact list (STATUS_COLORS === PRIORITY_COLORS),
// so the picker must only ever offer these values.
const PRIORITY_COLORS = [
    { value: 'slate', label: 'Slate', swatch: 'bg-slate-400' },
    { value: 'sky', label: 'Sky', swatch: 'bg-sky-500' },
    { value: 'emerald', label: 'Emerald', swatch: 'bg-emerald-500' },
    { value: 'amber', label: 'Amber', swatch: 'bg-amber-500' },
    { value: 'rose', label: 'Rose', swatch: 'bg-rose-500' },
    { value: 'violet', label: 'Violet', swatch: 'bg-violet-500' },
];

// Sentinel for "no colour token / use the auto hash" in the Phase
// colour picker. Phase rows store `null` for Auto; the picker needs a
// non-empty value to mark the selected swatch, so we map `'' | null`
// to this sentinel for display and translate it back to `''` / `null`
// at the network boundary. It is never sent to the API.
const PHASE_AUTO_COLOR = '__auto__';

// Palette tokens for the Phase template colour picker. These mirror
// the PHASE_PALETTE in PhasesPlan.jsx exactly — adding a token here
// without also adding it in PhasesPlan would surface as "no colour"
// on the plan because the BE just stores the token and the FE looks
// it up in PHASE_COLOR_TOKEN_INDEX. `auto: true` is display-only (the
// swatch gets a slash so it reads as "no override").
const PHASE_TEMPLATE_COLORS = [
    { value: PHASE_AUTO_COLOR, label: 'Auto', swatch: 'bg-muted', auto: true },
    { value: 'sky', label: 'Sky', swatch: 'bg-sky-500' },
    { value: 'emerald', label: 'Emerald', swatch: 'bg-emerald-500' },
    { value: 'violet', label: 'Violet', swatch: 'bg-violet-500' },
    { value: 'amber', label: 'Amber', swatch: 'bg-amber-500' },
    { value: 'rose', label: 'Rose', swatch: 'bg-rose-500' },
    { value: 'cyan', label: 'Cyan', swatch: 'bg-cyan-500' },
    { value: 'fuchsia', label: 'Fuchsia', swatch: 'bg-fuchsia-500' },
    { value: 'lime', label: 'Lime', swatch: 'bg-lime-500' },
];

// Scopes for statuses / priorities. Both tables keep one ordered list
// per scope; the segmented toggle in the section header switches which
// list is shown, created into and reordered.
const SCOPES = [
    { value: 'PROJECT', label: 'Project' },
    { value: 'TASK', label: 'Task' },
];

// Marker for the "new row" inline editor that sits at the top of a
// list while the admin is adding an item (vs. an existing row's id).
const NEW_ROW = '__new__';

// The 13 template sections shown in the side rail, in 5 groups. Each
// entry's `id` is shared by the rail (button), the persisted
// active-section key (localStorage) and renderSection() below, which
// mounts the matching editor in the right-hand pane. `label`,
// `icon`, `accent` and `description` feed both the rail item and the
// single compact header at the top of each section.
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
                    'Default lanes seeded onto every new project and offered in the "Add phase" dropdown.',
            },
            {
                id: 'statuses',
                label: 'Statuses',
                icon: Layers,
                accent: 'from-sky-500 to-violet-500',
                description:
                    'Labels and colours for project & task status badges. Each scope keeps its own ordered list.',
            },
            {
                id: 'priorities',
                label: 'Priorities',
                icon: Tag,
                accent: 'from-rose-500 to-amber-500',
                description:
                    'Labels and colours for project & task priority badges. Each scope keeps its own ordered list.',
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
                    'Categories like Internal, Consulting, Maintenance — surfaced in dropdowns and time-tracking exports. Turn on "Hide complete" for ongoing types to drop Completed, Client test and Billing from the status options and hide Mark complete.',
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
                    'Pickable list of countries on the project form. Each has a 3-letter code used in new project codes (e.g. P26-USA-0001) — the ISO code by default, or your own.',
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
                    "Org units / departments users belong to. Only admins can change a user's business unit from the profile dialog.",
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
                    'Request types requesters pick from on the portal (e.g. IPS Problems, POS Problems), each with its own form fields and help panel (tips, resource links, on-call contact).',
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

// Sections rendered by managers that live in other files (dialog-based
// editors). They don't report their own row count, so the page fetches
// it for the rail and refreshes it whenever the admin leaves the section.
const EXTERNAL_SECTIONS = new Set([
    'ticket-types',
    'requester-groups',
    'terminals',
]);

// Where the rail's per-section count comes from: the existing list
// endpoint for each section and the response key holding the array.
// These are the same cheap GETs the sections themselves issue — no
// dedicated count endpoint exists (or is needed) for these tiny tables.
const COUNT_SOURCES = {
    phases: ['/templates/phases?includeInactive=1', 'phases'],
    statuses: ['/templates/statuses', 'statuses'],
    priorities: ['/templates/priorities', 'priorities'],
    products: ['/templates/products?includeInactive=1', 'products'],
    entities: ['/templates/entities?includeInactive=1', 'entities'],
    'project-types': [
        '/templates/project-types?includeInactive=1',
        'project-types',
    ],
    countries: ['/templates/countries?includeInactive=1', 'countries'],
    'business-units': [
        '/templates/business-units?includeInactive=1',
        'business-units',
    ],
    'app-os': ['/templates/app-os?includeInactive=1', 'app-os'],
    'app-pos-terminals': [
        '/templates/app-pos-terminals?includeInactive=1',
        'app-pos-terminals',
    ],
    'ticket-types': ['/ticket-request-types', 'requestTypes'],
    'requester-groups': ['/requester-groups', 'groups'],
    terminals: ['/terminals/vendors', 'vendors'],
};

async function fetchSectionCount(id) {
    const src = COUNT_SOURCES[id];
    if (!src) return null;
    try {
        const { data } = await api.get(src[0]);
        const list = data?.[src[1]];
        return Array.isArray(list) ? list.length : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------
// Small helpers shared by every list-style section
// ---------------------------------------------------------------------

function capitalise(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// "Target OS options" → "target OS options": lower-cases a section
// label for use mid-sentence while keeping acronyms (OS, POS) intact.
function lowerNoun(label) {
    return label
        .split(' ')
        .map((w) =>
            w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase(),
        )
        .join(' ');
}

// Client-side search used by the section header. Matches when any of
// the listed fields contains the query (case-insensitive). Never hits
// the network — the full list is already loaded.
function matchesQuery(item, query, fields) {
    const q = String(query || '')
        .trim()
        .toLowerCase();
    if (!q) return true;
    return fields.some((f) =>
        String(item?.[f] ?? '')
            .toLowerCase()
            .includes(q),
    );
}

// Pure reorder used by both drag-and-drop and the Move up / Move down
// menu items so they produce byte-identical `ids` payloads. Returns the
// same array instance when nothing changes so callers can bail early.
function moveItem(list, from, to) {
    if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= list.length ||
        to >= list.length
    ) {
        return list;
    }
    const next = list.slice();
    const [removed] = next.splice(from, 1);
    next.splice(to, 0, removed);
    return next;
}

// Radix closes the menu and restores focus right after `onSelect`; a
// blocking `window.confirm` inside that handler can wedge the close
// animation. Deferring one tick lets the menu finish closing first.
function deferred(fn) {
    return () => window.setTimeout(fn, 0);
}

// Local state for the inline row editor. `editingId` is either an
// existing row id, NEW_ROW (the blank row at the top of the list) or
// null. `draft` holds the field values being edited.
function useRowEditor(blank) {
    const [editingId, setEditingId] = useState(null);
    const [draft, setDraft] = useState(blank);
    const [saving, setSaving] = useState(false);
    const startAdd = () => {
        setDraft(blank);
        setEditingId(NEW_ROW);
    };
    const startEdit = (id, values) => {
        setDraft({ ...blank, ...values });
        setEditingId(id);
    };
    const cancel = () => {
        setEditingId(null);
        setDraft(blank);
    };
    const patch = (partial) => setDraft((d) => ({ ...d, ...partial }));
    return {
        editingId,
        adding: editingId === NEW_ROW,
        draft,
        saving,
        setSaving,
        startAdd,
        startEdit,
        cancel,
        patch,
    };
}

// HTML5 drag-and-drop reorder for a list of rows. The list owns the
// drag state; each row receives `rowDnd(idx)` with the handlers to
// spread on its <li> plus flags for the visual placeholder. Dropping
// calls `onReorder(from, to)` with indexes into the rendered list —
// the same function the Move up / Move down menu items call.
function useDragReorder({ enabled, onReorder }) {
    const [dragIdx, setDragIdx] = useState(null);
    const [overIdx, setOverIdx] = useState(null);
    const reset = () => {
        setDragIdx(null);
        setOverIdx(null);
    };
    const rowDnd = (idx) => ({
        enabled,
        isDragging: dragIdx === idx,
        isOver: dragIdx !== null && overIdx === idx && dragIdx !== idx,
        // The placeholder line sits above the hovered row when the
        // dragged row comes from below it, otherwise below.
        overBefore: dragIdx !== null && dragIdx > idx,
        props: enabled
            ? {
                  onDragStart: (e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      // Firefox refuses to start a drag without data.
                      try {
                          e.dataTransfer.setData('text/plain', String(idx));
                      } catch {
                          /* ignore */
                      }
                      // Browsers snapshot the drag ghost after this
                      // handler returns; fading the row synchronously
                      // would fade the ghost too, so mark it a tick later.
                      window.setTimeout(() => setDragIdx(idx), 0);
                  },
                  onDragEnter: (e) => {
                      if (dragIdx === null) return;
                      e.preventDefault();
                      setOverIdx(idx);
                  },
                  onDragOver: (e) => {
                      if (dragIdx === null) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                  },
                  onDrop: (e) => {
                      e.preventDefault();
                      const from = dragIdx;
                      reset();
                      if (from === null || from === idx) return;
                      onReorder(from, idx);
                  },
                  onDragEnd: reset,
              }
            : {},
    });
    return { rowDnd, dragging: dragIdx !== null };
}

// ---------------------------------------------------------------------
// Shared presentational building blocks
// ---------------------------------------------------------------------

// White surface every section renders into (matches the rail card).
function SectionShell({ children }) {
    return (
        <Card className="rounded-xl">
            <CardContent className="space-y-4 p-4 sm:p-5">{children}</CardContent>
        </Card>
    );
}

// The ONE compact header per section:
// [accent icon] [title] [count badge] [extra controls] … [search] [+ Add]
// followed by a single muted description line.
function SectionHeader({
    section,
    count,
    search,
    onSearch,
    onAdd,
    addLabel = 'Add',
    hideDescription = false,
    children,
}) {
    const Icon = section.icon;
    const noun = lowerNoun(section.label);
    return (
        <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <span
                        className={cn(
                            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br text-white shadow-sm',
                            section.accent,
                        )}
                    >
                        <Icon className="h-3.5 w-3.5" />
                    </span>
                    <h2 className="truncate text-sm font-semibold tracking-tight">
                        {section.label}
                    </h2>
                    {typeof count === 'number' && (
                        <Badge
                            variant="secondary"
                            className="h-5 rounded-full px-2 font-mono text-[11px] font-medium tabular-nums"
                            title={`${count} ${count === 1 ? 'row' : 'rows'}`}
                        >
                            {count}
                        </Badge>
                    )}
                    {/* Every option of this section explained on Help. */}
                    <Link
                        to={`/help#templates-${section.id}`}
                        className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-primary"
                        title="Open the Help for this section"
                        data-help-link=""
                    >
                        <HelpCircle className="h-3.5 w-3.5" />
                        How it works
                    </Link>
                </div>
                {children}
                {(onSearch || onAdd) && (
                    <div className="ml-auto flex items-center gap-2">
                        {onSearch && (
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    type="search"
                                    value={search}
                                    onChange={(e) => onSearch(e.target.value)}
                                    placeholder={`Search ${noun}`}
                                    aria-label={`Search ${noun}`}
                                    className="h-8 w-40 pl-8 text-xs sm:w-56"
                                />
                            </div>
                        )}
                        {onAdd && (
                            <Button
                                size="sm"
                                className="h-8 gap-1.5"
                                onClick={onAdd}
                            >
                                <Plus className="h-4 w-4" />
                                {addLabel}
                            </Button>
                        )}
                    </div>
                )}
            </div>
            {!hideDescription && section.description && (
                <p className="text-xs text-muted-foreground">
                    {section.description}
                </p>
            )}
        </div>
    );
}

// Project | Task segmented toggle used by Statuses and Priorities.
function ScopeToggle({ value, onChange }) {
    return (
        <div
            role="tablist"
            aria-label="Scope"
            className="inline-flex h-8 items-center rounded-md border bg-muted/40 p-0.5 text-xs"
        >
            {SCOPES.map((s) => {
                const on = s.value === value;
                return (
                    <button
                        key={s.value}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        onClick={() => onChange(s.value)}
                        className={cn(
                            'h-7 rounded-[5px] px-3 font-medium transition-colors',
                            on
                                ? 'bg-background text-foreground shadow-sm'
                                : 'text-muted-foreground hover:text-foreground',
                        )}
                    >
                        {s.label}
                    </button>
                );
            })}
        </div>
    );
}

// Shared swatch picker: a row of small square swatches, the selected
// one ringed. Purely presentational — each section passes its own
// allowed `tokens` (PHASE_TEMPLATE_COLORS vs PRIORITY_COLORS) and keeps
// its own stored values, so unifying the UI never changes what is sent
// to the API.
function ColorSwatchPicker({ tokens, value, onChange, className }) {
    return (
        <div
            role="radiogroup"
            className={cn('flex flex-wrap items-center gap-1.5', className)}
        >
            {tokens.map((t) => {
                const selected = t.value === value;
                return (
                    <button
                        key={t.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={t.label}
                        title={t.label}
                        onClick={() => onChange(t.value)}
                        className={cn(
                            'flex h-6 w-6 items-center justify-center rounded-sm ring-1 ring-border transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            t.swatch,
                            selected &&
                                'ring-2 ring-primary ring-offset-1 ring-offset-background',
                        )}
                    >
                        {t.auto && (
                            <Slash className="h-3 w-3 text-muted-foreground" />
                        )}
                    </button>
                );
            })}
        </div>
    );
}

// Static swatch shown at the start of a coloured row.
function ColorDot({ tokens, value, className }) {
    const token = tokens.find((t) => t.value === value) || tokens[0];
    return (
        <span
            className={cn(
                'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm ring-1 ring-border',
                token.swatch,
                className,
            )}
            title={token.label}
        >
            {token.auto && <Slash className="h-2.5 w-2.5 text-muted-foreground" />}
        </span>
    );
}

// Row swatch. When `onChange` is given the swatch is a button that
// opens the shared picker in a popover so admins can recolour a row
// without entering edit mode (keeps the old one-click quick-pick).
function RowSwatch({ tokens, value, onChange }) {
    const [open, setOpen] = useState(false);
    const dot = <ColorDot tokens={tokens} value={value} />;
    if (!onChange) return dot;
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="flex shrink-0 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title="Change colour"
                    aria-label="Change colour"
                >
                    {dot}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-2">
                <ColorSwatchPicker
                    tokens={tokens}
                    value={value}
                    onChange={(v) => {
                        setOpen(false);
                        onChange(v);
                    }}
                />
            </PopoverContent>
        </Popover>
    );
}

// The ⋯ menu at the end of every row.
function RowMenu({
    onEdit,
    onDelete,
    reorderable,
    canMoveUp,
    canMoveDown,
    onMoveUp,
    onMoveDown,
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="Row actions"
                    title="Actions"
                >
                    <MoreHorizontal className="h-4 w-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem onSelect={onEdit}>
                    <Pencil /> Edit
                </DropdownMenuItem>
                {reorderable && (
                    <>
                        <DropdownMenuItem
                            onSelect={onMoveUp}
                            disabled={!canMoveUp}
                        >
                            <ArrowUp /> Move up
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onSelect={onMoveDown}
                            disabled={!canMoveDown}
                        >
                            <ArrowDown /> Move down
                        </DropdownMenuItem>
                    </>
                )}
                {/* Built-in rows (e.g. task statuses) can't be deleted. */}
                {onDelete && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onSelect={deferred(onDelete)}
                            className="text-destructive focus:text-destructive"
                        >
                            <Trash2 /> Delete
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// The unified list row:
// [grip] [swatch | neutral icon] [mono code pill] [label — secondary] …
// [extra] [Active switch] [⋯]
// When `editing` is true the row renders `editor` in place instead.
function TemplateRow({
    label,
    labelFallback = 'Untitled',
    secondary,
    code,
    swatch,
    icon: Icon,
    active,
    onToggleActive,
    toggleLabel,
    extra,
    reorderable = false,
    canMoveUp,
    canMoveDown,
    onMoveUp,
    onMoveDown,
    onEdit,
    onDelete,
    editing,
    editor,
    dnd,
}) {
    // Drag only starts from the grip: pressing it arms `draggable` on
    // the row, so clicking the label / switch / menu never kicks off an
    // accidental drag. Released on mouseup anywhere or when the drag ends.
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        if (!armed) return undefined;
        const disarm = () => setArmed(false);
        window.addEventListener('mouseup', disarm);
        return () => window.removeEventListener('mouseup', disarm);
    }, [armed]);

    if (editing) {
        return <li className="bg-muted/30 px-3 py-3">{editor}</li>;
    }

    const canDrag = Boolean(reorderable && dnd?.enabled);
    const dragProps = canDrag ? dnd.props : {};

    return (
        <li
            {...dragProps}
            draggable={canDrag && armed}
            onDragEnd={(e) => {
                setArmed(false);
                dragProps.onDragEnd?.(e);
            }}
            className={cn(
                'group relative flex items-center gap-3 px-3 py-2 text-sm transition-colors',
                !active && 'opacity-60',
                dnd?.isDragging && 'opacity-40',
                dnd?.isOver && 'bg-primary/5',
            )}
        >
            {dnd?.isOver && (
                <span
                    aria-hidden="true"
                    className={cn(
                        'pointer-events-none absolute inset-x-0 h-0.5 bg-primary',
                        dnd.overBefore ? 'top-0' : 'bottom-0',
                    )}
                />
            )}
            {reorderable && (
                <button
                    type="button"
                    aria-label="Drag to reorder"
                    title={
                        canDrag
                            ? 'Drag to reorder'
                            : 'Reordering is paused while searching or adding'
                    }
                    onMouseDown={() => canDrag && setArmed(true)}
                    className={cn(
                        '-ml-1 flex h-6 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70',
                        canDrag
                            ? 'cursor-grab hover:text-foreground active:cursor-grabbing'
                            : 'cursor-default opacity-40',
                    )}
                >
                    <GripVertical className="h-4 w-4" />
                </button>
            )}
            {swatch ? (
                <RowSwatch {...swatch} />
            ) : Icon ? (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="h-3.5 w-3.5" />
                </span>
            ) : null}
            {code && (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                    {code}
                </span>
            )}
            <button
                type="button"
                onClick={onEdit}
                title="Edit"
                className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <span
                    className={cn(
                        'max-w-full shrink-0 truncate font-medium',
                        !label && 'font-normal italic text-muted-foreground',
                    )}
                >
                    {label || labelFallback}
                </span>
                {secondary && (
                    <span
                        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                        title={secondary}
                    >
                        — {secondary}
                    </span>
                )}
            </button>
            {extra}
            {onToggleActive && (
                <Switch
                    checked={Boolean(active)}
                    onCheckedChange={onToggleActive}
                    aria-label={
                        toggleLabel ||
                        (active
                            ? 'Active — click to hide'
                            : 'Hidden — click to activate')
                    }
                    title={active ? 'Active' : 'Hidden'}
                />
            )}
            <RowMenu
                onEdit={onEdit}
                onDelete={onDelete}
                reorderable={reorderable}
                canMoveUp={canMoveUp}
                canMoveDown={canMoveDown}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
            />
        </li>
    );
}

// Frame for the inline editor (both "new row" and "edit row"). Enter
// saves (except inside a textarea / on a button), Esc cancels. Focuses
// the first editable input when it opens.
function InlineEditor({
    title,
    onSave,
    onCancel,
    saving,
    canSave = true,
    saveLabel = 'Save',
    children,
}) {
    const ref = useRef(null);
    useEffect(() => {
        const el = ref.current?.querySelector(
            'input:not([disabled]), textarea:not([disabled])',
        );
        el?.focus();
    }, []);
    return (
        <div
            ref={ref}
            className="w-full space-y-3"
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    onCancel();
                    return;
                }
                if (
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    !e.nativeEvent?.isComposing &&
                    e.target.tagName !== 'TEXTAREA' &&
                    e.target.tagName !== 'BUTTON'
                ) {
                    e.preventDefault();
                    if (canSave && !saving) onSave();
                }
            }}
        >
            {title && (
                <p className="text-xs font-medium text-muted-foreground">
                    {title}
                </p>
            )}
            <div className="flex flex-wrap items-start gap-3">{children}</div>
            <div className="flex items-center justify-end gap-1.5">
                <span className="mr-auto hidden text-[11px] text-muted-foreground sm:inline">
                    Enter to save · Esc to cancel
                </span>
                <Button
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    onClick={onCancel}
                    disabled={saving}
                >
                    Cancel
                </Button>
                <Button
                    size="sm"
                    className="h-8"
                    onClick={onSave}
                    disabled={saving || !canSave}
                >
                    {saveLabel}
                </Button>
            </div>
        </div>
    );
}

function EditorField({ label, hint, className, children }) {
    return (
        <div className={cn('space-y-1', className)}>
            <Label className="text-xs text-muted-foreground">{label}</Label>
            {children}
            {hint && (
                <p className="text-[11px] text-muted-foreground">{hint}</p>
            )}
        </div>
    );
}

// Immutable key shown in the editor (statuses / priorities keys can't
// be renamed — the BE update schema doesn't accept `key`).
function LockedKey({ value }) {
    return (
        <span
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-dashed bg-muted/40 px-2.5 font-mono text-xs uppercase text-muted-foreground"
            title="The key cannot be changed"
        >
            <Lock className="h-3 w-3" />
            {value}
        </span>
    );
}

// Dashed empty state shared by every list.
function EmptyState({ label, addLabel, onAdd }) {
    return (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">{label}</p>
            {onAdd && (
                <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5"
                    onClick={onAdd}
                >
                    <Plus className="h-4 w-4" />
                    {addLabel}
                </Button>
            )}
        </div>
    );
}

// Bordered, divided list that hosts the rows. Owns the drag state and
// renders the "new row" editor at the top while adding. `items` is the
// already-filtered visible list; `total` is the unfiltered count so the
// empty state can tell "nothing yet" from "no search matches".
function TemplateList({
    loading,
    items,
    total,
    query,
    emptyLabel,
    addLabel,
    onAdd,
    adding,
    addEditor,
    reorderable = false,
    onReorder,
    renderRow,
}) {
    const { rowDnd } = useDragReorder({
        enabled: Boolean(reorderable && !adding && onReorder),
        onReorder: onReorder || (() => {}),
    });

    if (loading) {
        return <p className="px-1 text-sm text-muted-foreground">Loading…</p>;
    }
    if (items.length === 0 && !adding) {
        if (total > 0 && String(query || '').trim()) {
            return <EmptyState label={`No matches for “${query.trim()}”`} />;
        }
        return (
            <EmptyState label={emptyLabel} addLabel={addLabel} onAdd={onAdd} />
        );
    }
    return (
        <ul className="divide-y rounded-lg border">
            {adding && <li className="bg-muted/30 px-3 py-3">{addEditor}</li>}
            {items.map((item, idx) => renderRow(item, idx, rowDnd(idx)))}
        </ul>
    );
}

// ---------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------

// Phase templates: name + optional colour token (Auto = null), ordered.
function PhaseTemplates({ section, onCount }) {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    // `color` in the draft is `'' | token` — '' means Auto and is sent
    // to the BE as `null`, exactly like the old create / edit forms.
    const ed = useRowEditor({ name: '', color: '' });

    const load = async () => {
        try {
            const res = await api.get('/templates/phases?includeInactive=1');
            setItems(res.data.phases);
            onCount?.(res.data.phases.length);
        } catch {
            toast.error('Failed to load phase templates');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const save = async () => {
        const name = ed.draft.name.trim();
        if (!name) return;
        ed.setSaving(true);
        try {
            if (ed.adding) {
                await api.post('/templates/phases', {
                    name,
                    // BE accepts `null` to mean "auto colour".
                    color: ed.draft.color || null,
                });
                toast.success('Phase added');
            } else {
                await api.patch(`/templates/phases/${ed.editingId}`, {
                    name,
                    color: ed.draft.color || null,
                });
            }
            ed.cancel();
            await load();
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    (ed.adding ? 'Could not add phase' : 'Could not save'),
            );
        } finally {
            ed.setSaving(false);
        }
    };

    // Colour-only change from the row swatch (no rename). We send just
    // `color` so the BE's "name already exists" guard can't false-positive.
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

    // Optimistic reorder shared by drag-and-drop and Move up / down.
    const reorder = async (from, to) => {
        const next = moveItem(items, from, to);
        if (next === items) return;
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

    const visible = items.filter((p) => matchesQuery(p, query, ['name']));
    // Reordering a filtered subset is ambiguous, so it's only offered
    // while the full list is showing.
    const canReorder = !query.trim();

    const editor = (
        <InlineEditor
            title={ed.adding ? 'New phase' : 'Edit phase'}
            onSave={save}
            onCancel={ed.cancel}
            saving={ed.saving}
            canSave={Boolean(ed.draft.name.trim())}
        >
            <EditorField label="Name" className="min-w-[14rem] flex-1">
                <Input
                    value={ed.draft.name}
                    onChange={(e) => ed.patch({ name: e.target.value })}
                    placeholder="e.g. Discovery"
                    className="h-9"
                />
            </EditorField>
            <EditorField label="Colour">
                <ColorSwatchPicker
                    tokens={PHASE_TEMPLATE_COLORS}
                    value={ed.draft.color || PHASE_AUTO_COLOR}
                    onChange={(v) =>
                        ed.patch({ color: v === PHASE_AUTO_COLOR ? '' : v })
                    }
                    className="h-9"
                />
            </EditorField>
        </InlineEditor>
    );

    return (
        <SectionShell>
            <SectionHeader
                section={section}
                count={items.length}
                search={query}
                onSearch={setQuery}
                onAdd={ed.startAdd}
                addLabel="Add phase"
            />
            <TemplateList
                loading={loading}
                items={visible}
                total={items.length}
                query={query}
                emptyLabel="No phases yet"
                addLabel="Add phase"
                onAdd={ed.startAdd}
                adding={ed.adding}
                addEditor={editor}
                reorderable={canReorder}
                onReorder={reorder}
                renderRow={(item, idx, dnd) => (
                    <TemplateRow
                        key={item.id}
                        label={item.name}
                        swatch={{
                            tokens: PHASE_TEMPLATE_COLORS,
                            value: item.color || PHASE_AUTO_COLOR,
                            onChange: (v) =>
                                handleQuickColor(
                                    item,
                                    v === PHASE_AUTO_COLOR ? '' : v,
                                ),
                        }}
                        active={item.isActive}
                        onToggleActive={() => handleToggleActive(item)}
                        toggleLabel={
                            item.isActive ? 'Disable phase' : 'Enable phase'
                        }
                        reorderable
                        canMoveUp={canReorder && idx > 0}
                        canMoveDown={canReorder && idx < visible.length - 1}
                        onMoveUp={() => reorder(idx, idx - 1)}
                        onMoveDown={() => reorder(idx, idx + 1)}
                        onEdit={() =>
                            ed.startEdit(item.id, {
                                name: item.name,
                                color: item.color || '',
                            })
                        }
                        onDelete={() => handleDelete(item)}
                        editing={ed.editingId === item.id}
                        editor={editor}
                        dnd={dnd}
                    />
                )}
            />
        </SectionShell>
    );
}

// Statuses and priorities share one shape: { scope, key, label, color,
// order, isActive } with an immutable key and per-scope ordering. One
// component drives both; the wrappers below pin the endpoint details.
const STATUS_KIND = {
    path: 'statuses',
    dataKey: 'statuses',
    noun: 'status',
    plural: 'statuses',
    keyPlaceholder: 'e.g. IN_REVIEW',
    labelPlaceholder: 'e.g. In review',
    invalidate: invalidateStatuses,
    // The task-status SET is fixed by the backend (Task.status is an
    // enum), so on the Task tab you can rename / recolour / reorder the
    // four built-in ones — not add, hide or delete them. The API agrees.
    fixedScopes: ['TASK'],
    fixedHint:
        'Task statuses are a fixed set (To do, In progress, On hold, Done) — rename, recolour or reorder them here and every task picker and badge follows. They can’t be hidden, deleted or added to.',
};

const PRIORITY_KIND = {
    path: 'priorities',
    dataKey: 'priorities',
    noun: 'priority',
    plural: 'priorities',
    keyPlaceholder: 'e.g. CRITICAL',
    labelPlaceholder: 'e.g. Critical',
    invalidate: invalidatePriorities,
    // Task.priority / Project.priority are enums: only the built-in keys
    // can be saved, so both scopes are closed (rename / recolour /
    // reorder / hide only).
    fixedScopes: ['TASK', 'PROJECT'],
    fixedHint:
        'Priorities are a fixed set (projects: Low, Medium, High, Urgent · tasks: Low, Medium, High) — rename, recolour, reorder or hide them; new ones can’t be added.',
};

function ScopedOptions({ section, onCount, kind }) {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [scope, setScope] = useState('PROJECT');
    const [query, setQuery] = useState('');
    const ed = useRowEditor({ key: '', label: '', color: 'slate' });
    const Noun = capitalise(kind.noun);

    const load = async () => {
        try {
            const res = await api.get(`/templates/${kind.path}`);
            const all = res.data[kind.dataKey] || [];
            setItems(all);
            // Rail count = every row across both scopes.
            onCount?.(all.length);
            kind.invalidate();
        } catch {
            toast.error(`Failed to load ${kind.plural}`);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const filtered = items.filter((p) => p.scope === scope);
    const visible = filtered.filter((p) =>
        matchesQuery(p, query, ['label', 'key']),
    );
    const canReorder = !query.trim();

    const changeScope = (next) => {
        if (next === scope) return;
        setScope(next);
        ed.cancel();
    };

    const save = async () => {
        const label = ed.draft.label.trim();
        const key = ed.draft.key.trim();
        if (!label || (ed.adding && !key)) return;
        ed.setSaving(true);
        try {
            if (ed.adding) {
                await api.post(`/templates/${kind.path}`, {
                    scope,
                    key: key.toUpperCase(),
                    label,
                    color: ed.draft.color,
                });
                toast.success(`${Noun} added`);
            } else {
                await api.patch(`/templates/${kind.path}/${ed.editingId}`, {
                    label,
                    color: ed.draft.color,
                });
            }
            ed.cancel();
            await load();
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    (ed.adding
                        ? `Could not add ${kind.noun}`
                        : 'Could not save'),
            );
        } finally {
            ed.setSaving(false);
        }
    };

    const handleQuickColor = async (item, color) => {
        try {
            await api.patch(`/templates/${kind.path}/${item.id}`, { color });
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save colour');
        }
    };

    const handleToggleActive = async (item) => {
        try {
            await api.patch(`/templates/${kind.path}/${item.id}`, {
                isActive: !item.isActive,
            });
            await load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update');
        }
    };

    const handleDelete = async (item) => {
        if (!window.confirm(`Delete ${kind.noun} "${item.label}"?`)) return;
        try {
            await api.delete(`/templates/${kind.path}/${item.id}`);
            await load();
            toast.success(`${Noun} removed`);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete');
        }
    };

    // Reorder within the current scope only; rows of the other scope
    // are left untouched in local state and not sent to the BE.
    const reorder = async (from, to) => {
        const next = moveItem(filtered, from, to);
        if (next === filtered) return;
        setItems((prev) => {
            const others = prev.filter((p) => p.scope !== scope);
            return [...others, ...next];
        });
        try {
            await api.post(`/templates/${kind.path}/reorder`, {
                scope,
                ids: next.map((p) => p.id),
            });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not reorder');
            await load();
        }
    };

    const scopeLabel = SCOPES.find((s) => s.value === scope)?.label || scope;

    const editor = (
        <InlineEditor
            title={
                ed.adding
                    ? `New ${scopeLabel.toLowerCase()} ${kind.noun}`
                    : `Edit ${kind.noun}`
            }
            onSave={save}
            onCancel={ed.cancel}
            saving={ed.saving}
            canSave={Boolean(
                ed.draft.label.trim() && (!ed.adding || ed.draft.key.trim()),
            )}
        >
            <EditorField label="Key" className="w-44">
                {ed.adding ? (
                    <Input
                        value={ed.draft.key}
                        onChange={(e) => ed.patch({ key: e.target.value })}
                        placeholder={kind.keyPlaceholder}
                        className="h-9 font-mono uppercase"
                        autoCapitalize="characters"
                        spellCheck={false}
                    />
                ) : (
                    <LockedKey value={ed.draft.key} />
                )}
            </EditorField>
            <EditorField label="Label" className="min-w-[12rem] flex-1">
                <Input
                    value={ed.draft.label}
                    onChange={(e) => ed.patch({ label: e.target.value })}
                    placeholder={kind.labelPlaceholder}
                    className="h-9"
                />
            </EditorField>
            <EditorField label="Colour">
                <ColorSwatchPicker
                    tokens={PRIORITY_COLORS}
                    value={ed.draft.color}
                    onChange={(v) => ed.patch({ color: v })}
                    className="h-9"
                />
            </EditorField>
        </InlineEditor>
    );

    // Some scopes have a backend-fixed set (task statuses): no "Add"
    // there, just a hint — editing / reordering the existing rows works.
    const scopeFixed = Boolean(kind.fixedScopes?.includes(scope));

    return (
        <SectionShell>
            <SectionHeader
                section={section}
                count={filtered.length}
                search={query}
                onSearch={setQuery}
                onAdd={scopeFixed ? undefined : ed.startAdd}
                addLabel={`Add ${kind.noun}`}
            >
                <ScopeToggle value={scope} onChange={changeScope} />
            </SectionHeader>
            {scopeFixed && kind.fixedHint && (
                <p className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    {kind.fixedHint}
                </p>
            )}
            <TemplateList
                loading={loading}
                items={visible}
                total={filtered.length}
                query={query}
                emptyLabel={`No ${scopeLabel.toLowerCase()} ${kind.plural} yet`}
                addLabel={`Add ${kind.noun}`}
                onAdd={scopeFixed ? undefined : ed.startAdd}
                adding={ed.adding}
                addEditor={editor}
                reorderable={canReorder}
                onReorder={reorder}
                renderRow={(item, idx, dnd) => (
                    <TemplateRow
                        key={item.id}
                        label={item.label}
                        code={item.key}
                        swatch={{
                            tokens: PRIORITY_COLORS,
                            value: item.color,
                            onChange: (v) => handleQuickColor(item, v),
                        }}
                        active={item.alwaysVisible ? true : item.isActive}
                        onToggleActive={
                            item.alwaysVisible
                                ? undefined
                                : () => handleToggleActive(item)
                        }
                        toggleLabel={
                            item.isActive
                                ? `Disable ${kind.noun}`
                                : `Enable ${kind.noun}`
                        }
                        extra={
                            item.supported === false ? (
                                <span
                                    className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
                                    title={`Not a built-in key — nothing can be saved with it and it isn’t offered anywhere. Safe to delete.`}
                                >
                                    Not used
                                </span>
                            ) : item.builtIn ? (
                                <span
                                    className="shrink-0 text-muted-foreground/70"
                                    title="Built in — can’t be deleted"
                                >
                                    <Lock className="h-3.5 w-3.5" />
                                </span>
                            ) : null
                        }
                        reorderable
                        canMoveUp={canReorder && idx > 0}
                        canMoveDown={canReorder && idx < visible.length - 1}
                        onMoveUp={() => reorder(idx, idx - 1)}
                        onMoveDown={() => reorder(idx, idx + 1)}
                        onEdit={() =>
                            ed.startEdit(item.id, {
                                key: item.key,
                                label: item.label,
                                color: item.color,
                            })
                        }
                        onDelete={
                            item.builtIn ? undefined : () => handleDelete(item)
                        }
                        editing={ed.editingId === item.id}
                        editor={editor}
                        dnd={dnd}
                    />
                )}
            />
        </SectionShell>
    );
}

function StatusOptions(props) {
    return <ScopedOptions {...props} kind={STATUS_KIND} />;
}

function PriorityOptions(props) {
    return <ScopedOptions {...props} kind={PRIORITY_KIND} />;
}

// Shared editor for any catalog with the simple {name, order, isActive}
// shape (countries, business units, target OS, POS terminal types and
// project types — the latter also carry `activityCode` + a per-row
// "Hide complete" switch).
function CatalogCard({
    section,
    onCount,
    path,
    singular,
    placeholder,
    showHideComplete = false,
    showActivityCode = false,
    // Countries: optional 3-letter code for project codes (P26-USA-0001).
    showCountryCode = false,
}) {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const ed = useRowEditor({ name: '', activityCode: '', code: '' });
    const plural = lowerNoun(section.label);

    const load = async () => {
        try {
            const res = await api.get(`/templates/${path}?includeInactive=1`);
            const list = res.data[path] || [];
            setItems(list);
            onCount?.(list.length);
            // Drop the cached "active-only" list so dropdowns
            // elsewhere refresh next time they're opened.
            invalidateCatalog(path);
        } catch {
            toast.error(`Failed to load ${plural}`);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [path]);

    const payload = () => ({
        name: ed.draft.name.trim(),
        ...(showActivityCode
            ? { activityCode: ed.draft.activityCode.trim() || null }
            : {}),
        ...(showCountryCode
            ? { code: (ed.draft.code || '').trim().toUpperCase() || null }
            : {}),
    });
    const codeDraft = (ed.draft.code || '').trim();
    const codeInvalid = showCountryCode && codeDraft !== '' && !/^[A-Za-z]{3}$/.test(codeDraft);

    const save = async () => {
        if (!ed.draft.name.trim() || codeInvalid) return;
        ed.setSaving(true);
        try {
            if (ed.adding) {
                await api.post(`/templates/${path}`, payload());
                toast.success(`${capitalise(singular)} added`);
            } else {
                await api.patch(
                    `/templates/${path}/${ed.editingId}`,
                    payload(),
                );
            }
            ed.cancel();
            await load();
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    (ed.adding ? `Could not add ${singular}` : 'Could not save'),
            );
        } finally {
            ed.setSaving(false);
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

    const reorder = async (from, to) => {
        const next = moveItem(items, from, to);
        if (next === items) return;
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

    const visible = items.filter((p) =>
        matchesQuery(
            p,
            query,
            showActivityCode
                ? ['name', 'activityCode']
                : showCountryCode
                  ? ['name', 'code', 'autoCode']
                  : ['name'],
        ),
    );
    // The code a country row will put in project codes.
    const effectiveCode = (item) => item.code || item.autoCode || null;
    const canReorder = !query.trim();

    const editor = (
        <InlineEditor
            title={ed.adding ? `New ${singular}` : `Edit ${singular}`}
            onSave={save}
            onCancel={ed.cancel}
            saving={ed.saving}
            canSave={Boolean(ed.draft.name.trim()) && !codeInvalid}
        >
            <EditorField label="Name" className="min-w-[14rem] flex-1">
                <Input
                    value={ed.draft.name}
                    onChange={(e) => ed.patch({ name: e.target.value })}
                    placeholder={placeholder}
                    className="h-9"
                />
            </EditorField>
            {showCountryCode && (
                <EditorField label="Code (3 letters)" className="w-40">
                    <Input
                        value={ed.draft.code}
                        onChange={(e) =>
                            ed.patch({ code: e.target.value.toUpperCase().slice(0, 3) })
                        }
                        placeholder="Auto (ISO)"
                        aria-invalid={codeInvalid || undefined}
                        className={cn(
                            'h-9 font-mono uppercase',
                            codeInvalid && 'border-destructive',
                        )}
                        spellCheck={false}
                        maxLength={3}
                        title="Used in project codes, e.g. P26-USA-0001. Leave empty to use the ISO 3166 code for the name."
                    />
                </EditorField>
            )}
            {showActivityCode && (
                <EditorField label="Activity code" className="w-44">
                    <Input
                        value={ed.draft.activityCode}
                        onChange={(e) =>
                            ed.patch({ activityCode: e.target.value })
                        }
                        placeholder="e.g. ACT-01"
                        className="h-9 font-mono"
                        spellCheck={false}
                    />
                </EditorField>
            )}
        </InlineEditor>
    );

    return (
        <SectionShell>
            <SectionHeader
                section={section}
                count={items.length}
                search={query}
                onSearch={setQuery}
                onAdd={ed.startAdd}
                addLabel={`Add ${singular}`}
            />
            <TemplateList
                loading={loading}
                items={visible}
                total={items.length}
                query={query}
                emptyLabel={`No ${plural} yet`}
                addLabel={`Add ${singular}`}
                onAdd={ed.startAdd}
                adding={ed.adding}
                addEditor={editor}
                reorderable={canReorder}
                onReorder={reorder}
                renderRow={(item, idx, dnd) => (
                    <TemplateRow
                        key={item.id}
                        label={item.name}
                        code={
                            showActivityCode
                                ? item.activityCode
                                : showCountryCode
                                  ? effectiveCode(item)
                                  : undefined
                        }
                        secondary={
                            showCountryCode && !item.code && item.autoCode
                                ? 'code set automatically (ISO)'
                                : undefined
                        }
                        icon={section.icon}
                        active={item.isActive}
                        onToggleActive={() => handleToggleActive(item)}
                        toggleLabel={
                            item.isActive
                                ? `Disable ${singular}`
                                : `Enable ${singular}`
                        }
                        extra={
                            showHideComplete ? (
                                <span
                                    className="flex shrink-0 items-center gap-1.5"
                                    title="Hide Completed / Client test / Billing statuses and the Mark complete action for this type"
                                >
                                    <Switch
                                        checked={Boolean(item.hideMarkComplete)}
                                        onCheckedChange={() =>
                                            handleToggleHideComplete(item)
                                        }
                                        aria-label="Hide mark complete"
                                    />
                                    <span className="text-[11px] text-muted-foreground">
                                        Hide complete
                                    </span>
                                </span>
                            ) : null
                        }
                        reorderable
                        canMoveUp={canReorder && idx > 0}
                        canMoveDown={canReorder && idx < visible.length - 1}
                        onMoveUp={() => reorder(idx, idx - 1)}
                        onMoveDown={() => reorder(idx, idx + 1)}
                        onEdit={() =>
                            ed.startEdit(item.id, {
                                name: item.name,
                                activityCode: item.activityCode || '',
                                code: item.code || '',
                            })
                        }
                        onDelete={() => handleDelete(item)}
                        editing={ed.editingId === item.id}
                        editor={editor}
                        dnd={dnd}
                    />
                )}
            />
        </SectionShell>
    );
}

// Products catalogue: name + optional code + description, with create /
// edit / activate / delete. No reorder endpoint, so no grip. Projects
// pick from the active set.
function ProductsManager({ section, onCount }) {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const ed = useRowEditor({ name: '', code: '', description: '' });

    // Only the first load shows "Loading…"; later reloads (after a
    // save / toggle / delete) swap the rows in place without a flash.
    const load = () => {
        api.get('/templates/products?includeInactive=1')
            .then(({ data }) => {
                const list = data.products || [];
                setItems(list);
                onCount?.(list.length);
            })
            .catch(() => setItems([]))
            .finally(() => setLoading(false));
    };
    useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

    const payload = () => ({
        name: ed.draft.name.trim(),
        code: ed.draft.code.trim() || null,
        description: ed.draft.description.trim() || null,
    });

    const save = async () => {
        if (!ed.draft.name.trim()) return toast.error('Enter a product name.');
        ed.setSaving(true);
        try {
            if (ed.adding) {
                await api.post('/templates/products', payload());
                toast.success('Product added.');
            } else {
                await api.patch(`/templates/products/${ed.editingId}`, payload());
                toast.success('Saved.');
            }
            ed.cancel();
            load();
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    (ed.adding ? 'Could not add product.' : 'Could not save.'),
            );
        } finally {
            ed.setSaving(false);
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

    const visible = items.filter((p) =>
        matchesQuery(p, query, ['name', 'code', 'description']),
    );

    const editor = (
        <InlineEditor
            title={ed.adding ? 'New product' : 'Edit product'}
            onSave={save}
            onCancel={ed.cancel}
            saving={ed.saving}
            canSave={Boolean(ed.draft.name.trim())}
        >
            <EditorField label="Product name" className="min-w-[14rem] flex-1">
                <Input
                    value={ed.draft.name}
                    onChange={(e) => ed.patch({ name: e.target.value })}
                    placeholder="e.g. POS Suite"
                    className="h-9"
                />
            </EditorField>
            <EditorField label="Code" className="w-40">
                <Input
                    value={ed.draft.code}
                    onChange={(e) => ed.patch({ code: e.target.value })}
                    placeholder="e.g. POS"
                    className="h-9 font-mono"
                    spellCheck={false}
                />
            </EditorField>
            <EditorField label="Description" className="w-full">
                <Textarea
                    rows={2}
                    value={ed.draft.description}
                    onChange={(e) => ed.patch({ description: e.target.value })}
                    placeholder="Optional short description"
                />
            </EditorField>
        </InlineEditor>
    );

    return (
        <SectionShell>
            <SectionHeader
                section={section}
                count={items.length}
                search={query}
                onSearch={setQuery}
                onAdd={ed.startAdd}
                addLabel="Add product"
            />
            <TemplateList
                loading={loading}
                items={visible}
                total={items.length}
                query={query}
                emptyLabel="No products yet"
                addLabel="Add product"
                onAdd={ed.startAdd}
                adding={ed.adding}
                addEditor={editor}
                renderRow={(p) => (
                    <TemplateRow
                        key={p.id}
                        label={p.name}
                        secondary={p.description}
                        code={p.code}
                        icon={Package}
                        active={p.isActive}
                        onToggleActive={() => toggleActive(p)}
                        onEdit={() =>
                            ed.startEdit(p.id, {
                                name: p.name || '',
                                code: p.code || '',
                                description: p.description || '',
                            })
                        }
                        onDelete={() => remove(p)}
                        editing={ed.editingId === p.id}
                        editor={editor}
                    />
                )}
            />
        </SectionShell>
    );
}

// Entities catalogue: code + optional description, with create / edit /
// activate / delete. No reorder endpoint, so no grip. Projects pick
// from the active set.
function EntityManager({ section, onCount }) {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const ed = useRowEditor({ code: '', description: '' });

    // Only the first load shows "Loading…" (see ProductsManager).
    const load = () => {
        api.get('/templates/entities?includeInactive=1')
            .then(({ data }) => {
                const list = data.entities || [];
                setItems(list);
                onCount?.(list.length);
            })
            .catch(() => setItems([]))
            .finally(() => setLoading(false));
    };
    useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

    const payload = () => ({
        code: ed.draft.code.trim(),
        description: ed.draft.description.trim() || null,
    });

    const save = async () => {
        if (!ed.draft.code.trim()) return toast.error('Enter an entity code.');
        ed.setSaving(true);
        try {
            if (ed.adding) {
                await api.post('/templates/entities', payload());
                toast.success('Entity added.');
            } else {
                await api.patch(`/templates/entities/${ed.editingId}`, payload());
                toast.success('Saved.');
            }
            ed.cancel();
            load();
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    (ed.adding ? 'Could not add entity.' : 'Could not save.'),
            );
        } finally {
            ed.setSaving(false);
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

    const visible = items.filter((e) =>
        matchesQuery(e, query, ['code', 'description']),
    );

    const editor = (
        <InlineEditor
            title={ed.adding ? 'New entity' : 'Edit entity'}
            onSave={save}
            onCancel={ed.cancel}
            saving={ed.saving}
            canSave={Boolean(ed.draft.code.trim())}
        >
            <EditorField label="Entity code" className="w-44">
                <Input
                    value={ed.draft.code}
                    onChange={(e) => ed.patch({ code: e.target.value })}
                    placeholder="e.g. RS-01"
                    className="h-9 font-mono"
                    spellCheck={false}
                />
            </EditorField>
            <EditorField label="Description" className="min-w-[14rem] flex-1">
                <Input
                    value={ed.draft.description}
                    onChange={(e) => ed.patch({ description: e.target.value })}
                    placeholder="Optional description"
                    className="h-9"
                />
            </EditorField>
        </InlineEditor>
    );

    return (
        <SectionShell>
            <SectionHeader
                section={section}
                count={items.length}
                search={query}
                onSearch={setQuery}
                onAdd={ed.startAdd}
                addLabel="Add entity"
            />
            <TemplateList
                loading={loading}
                items={visible}
                total={items.length}
                query={query}
                emptyLabel="No entities yet"
                addLabel="Add entity"
                onAdd={ed.startAdd}
                adding={ed.adding}
                addEditor={editor}
                renderRow={(e) => (
                    <TemplateRow
                        key={e.id}
                        // Entities have no name — the code is the identity
                        // and the description is the human-readable text.
                        label={e.description}
                        labelFallback="No description"
                        code={e.code}
                        icon={Building2}
                        active={e.isActive}
                        onToggleActive={() => toggleActive(e)}
                        onEdit={() =>
                            ed.startEdit(e.id, {
                                code: e.code || '',
                                description: e.description || '',
                            })
                        }
                        onDelete={() => remove(e)}
                        editing={ed.editingId === e.id}
                        editor={editor}
                    />
                )}
            />
        </SectionShell>
    );
}

// Wrapper for the dialog-based managers that live in their own files
// (ticket types, requester groups, terminals). They keep their own
// intro text and "New …" buttons, so the header here is just the icon,
// title and the prefetched row count.
function ExternalSection({ section, count, children }) {
    return (
        <SectionShell>
            <SectionHeader section={section} count={count} hideDescription />
            {children}
        </SectionShell>
    );
}

// Maps a section id to its editor. The right pane renders only the
// active one (master-detail), instead of stacking every section. The
// `key` forces a remount on switch so each section loads fresh state.
function renderSection(id, common) {
    switch (id) {
        case 'phases':
            return <PhaseTemplates key={id} {...common} />;
        case 'statuses':
            return <StatusOptions key={id} {...common} />;
        case 'priorities':
            return <PriorityOptions key={id} {...common} />;
        case 'products':
            return <ProductsManager key={id} {...common} />;
        case 'entities':
            return <EntityManager key={id} {...common} />;
        case 'project-types':
            return (
                <CatalogCard
                    key={id}
                    {...common}
                    path="project-types"
                    singular="project type"
                    showActivityCode
                    placeholder="e.g. Internal, Consulting, Maintenance"
                    showHideComplete
                />
            );
        case 'countries':
            return (
                <CatalogCard
                    key={id}
                    {...common}
                    path="countries"
                    singular="country"
                    placeholder="e.g. Germany"
                    showCountryCode
                />
            );
        case 'business-units':
            return (
                <CatalogCard
                    key={id}
                    {...common}
                    path="business-units"
                    singular="business unit"
                    placeholder="e.g. Engineering, Finance, Sales"
                />
            );
        case 'app-os':
            return (
                <CatalogCard
                    key={id}
                    {...common}
                    path="app-os"
                    singular="target OS"
                    placeholder="e.g. Android 12+"
                />
            );
        case 'app-pos-terminals':
            return (
                <CatalogCard
                    key={id}
                    {...common}
                    path="app-pos-terminals"
                    singular="POS terminal"
                    placeholder="e.g. Verifone P200"
                />
            );
        case 'ticket-types':
            return (
                <ExternalSection key={id} {...common}>
                    <TicketTypesManager />
                </ExternalSection>
            );
        case 'requester-groups':
            return (
                <ExternalSection key={id} {...common}>
                    <RequesterGroupsManager />
                </ExternalSection>
            );
        case 'terminals':
            return (
                <ExternalSection key={id} {...common}>
                    <TerminalsManager />
                </ExternalSection>
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
        // "Raise-ticket help" moved into each ticket type.
        if (saved === 'ticket-help') return 'ticket-types';
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
    // Per-section row counts for the rail. Internal sections report
    // theirs on every load; the rest are fetched via COUNT_SOURCES.
    const [counts, setCounts] = useState({});

    const reportCount = useCallback((id, n) => {
        if (typeof n !== 'number') return;
        setCounts((c) => (c[id] === n ? c : { ...c, [id]: n }));
    }, []);

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

    // Prefetch counts once. The active section is skipped when it
    // reports its own count (it's about to issue the same GET anyway).
    useEffect(() => {
        let cancelled = false;
        const ids = SECTION_GROUPS.flatMap((g) => g.items.map((i) => i.id));
        ids.forEach((id) => {
            if (id === active && !EXTERNAL_SECTIONS.has(id)) return;
            fetchSectionCount(id).then((n) => {
                if (!cancelled) reportCount(id, n);
            });
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // External managers don't report their count, so refresh it when
    // the admin leaves one of them (they may have added / deleted rows).
    const prevActive = useRef(active);
    useEffect(() => {
        const prev = prevActive.current;
        prevActive.current = active;
        if (prev && prev !== active && EXTERNAL_SECTIONS.has(prev)) {
            fetchSectionCount(prev).then((n) => reportCount(prev, n));
        }
    }, [active, reportCount]);

    const activeSection = findSection(active);
    const onCount = useCallback(
        (n) => reportCount(active, n),
        [active, reportCount],
    );

    return (
        <>
            <TopBar title="Templates" />
            <AdminTabs />
            <main className="flex-1 overflow-auto bg-muted/20">
                <div className="flex w-full items-start gap-4 p-3 sm:p-6">
                    <TemplatesNav
                        active={active}
                        onSelect={setActive}
                        collapsed={navCollapsed}
                        onToggleCollapsed={() => setNavCollapsed((v) => !v)}
                        counts={counts}
                    />
                    {/* Master-detail: only the selected section's editor
                        renders here, with its own single compact header. */}
                    <div className="min-w-0 flex-1">
                        {activeSection &&
                            renderSection(active, {
                                section: activeSection,
                                onCount,
                                count: counts[active],
                            })}
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

// Section navigator rail. Clicking an item swaps the right-hand editor
// (master-detail). Collapses to an icon-only strip (like the main app
// sidebar) via the chevrons toggle; the choice is remembered. Each
// item shows a small muted row count once it's known.
function TemplatesNav({
    active,
    onSelect,
    collapsed,
    onToggleCollapsed,
    counts = {},
}) {
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
                                const count = counts[item.id];
                                const hasCount = typeof count === 'number';
                                return (
                                    <li key={item.id}>
                                        <button
                                            type="button"
                                            onClick={() => onSelect(item.id)}
                                            title={
                                                hasCount
                                                    ? `${item.label} · ${count}`
                                                    : item.label
                                            }
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
                                                <>
                                                    <span className="min-w-0 flex-1 truncate text-left">
                                                        {item.label}
                                                    </span>
                                                    {hasCount && (
                                                        <span
                                                            className={cn(
                                                                'shrink-0 text-[11px] font-normal tabular-nums',
                                                                isActive
                                                                    ? 'text-primary/70'
                                                                    : 'text-muted-foreground/70',
                                                            )}
                                                        >
                                                            {count}
                                                        </span>
                                                    )}
                                                </>
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
