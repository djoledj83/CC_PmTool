import { cloneElement, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
    Check,
    ChevronDown,
    Download,
    Filter,
    Flag,
    FolderKanban,
    GripVertical,
    LayoutGrid,
    List,
    Minus,
    Package,
    MoreHorizontal,
    Pencil,
    Pin,
    Plus,
    Search,
    SlidersHorizontal,
    Trash2,
    X,
} from 'lucide-react';

import { api } from '@/lib/api';
import { formatApiError } from '@/lib/utils';
import { downloadFromApi } from '@/lib/download';
import { useAuth } from '@/contexts/AuthContext';
import {
    PROJECT_PRIORITY_MAP,
    PROJECT_STATUS_MAP,
    filterProjectStatuses,
} from '@/lib/constants';
import { useProjectPriorities } from '@/lib/priorities';
import { useProjectStatuses } from '@/lib/statuses';
import { useProjectTypes } from '@/lib/catalogs';
import { labelColorClass, labelColorSwatch } from '@/lib/labelColors';
import { parseProjectLabels } from '@/lib/projectLabels';
import {
    cn,
    initials,
    resolveAssetUrl,
    timeProgress,
    timeProgressColorClass,
    timeProgressTextClass,
    timeRemainingLabel,
    durationInDays,
    daysRemainingFromStart,
} from '@/lib/utils';
import { TopBar } from '@/components/TopBar';
import { ProjectFormDialog } from '@/components/ProjectFormDialog';
import ManageProjectGroupsDialog from '@/components/ManageProjectGroupsDialog';
import { PinButton } from '@/components/PinButton';
import { usePins } from '@/hooks/usePins';
import {
    InlineDateCell,
    InlinePersonCell,
    InlinePhaseCell,
    InlinePriorityCell,
    InlineStatusCell,
} from '@/components/ProjectInlineCells';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';

function formatDate(d) {
    if (!d) return '—';
    return format(new Date(d), 'MMM d, yyyy');
}

// Task progress is always computed from completed/total tasks — the
// project's manual `progress` column is no longer surfaced anywhere.
function taskProgress(project) {
    const total = project.totalTasks || 0;
    const done = project.doneTasks || 0;
    return total === 0 ? 0 : Math.round((done / total) * 100);
}

// `minWidth` is the smallest size each column will shrink to before the table
// starts horizontal scrolling. Used together with `table-fixed`-style sizing
// below so that headers stay fully visible regardless of which columns the
// user toggles on.
const ALL_COLUMNS = [
    { id: 'title', label: 'Title', required: true, minWidth: 220 },
    { id: 'status', label: 'Status', default: true, minWidth: 130 },
    { id: 'priority', label: 'Priority', default: true, minWidth: 120 },
    { id: 'timeProgress', label: 'Time progress', default: true, minWidth: 200 },
    { id: 'taskProgress', label: 'Task progress', default: true, minWidth: 200 },
    { id: 'phase', label: 'Phase', minWidth: 130 },
    { id: 'label', label: 'Label', minWidth: 120 },
    { id: 'client', label: 'Client', default: true, minWidth: 150 },
    { id: 'country', label: 'Country', minWidth: 120 },
    { id: 'crmId', label: 'CRM ID', minWidth: 130 },
    { id: 'projectType', label: 'Project type', minWidth: 140 },
    { id: 'startDate', label: 'Start date', minWidth: 130 },
    { id: 'endDate', label: 'End date', minWidth: 130 },
    { id: 'owner', label: 'Owner', default: true, minWidth: 170 },
    { id: 'reporter', label: 'Reporter', default: true, minWidth: 170 },
    { id: 'createdAt', label: 'Created', minWidth: 130 },
    { id: 'closedAt', label: 'Closed', minWidth: 130 },
];

const STORAGE_COLUMNS = 'pm.projects.columns.v1';
// Filters schema bumped to .v5 to introduce `teamIds`.
const STORAGE_FILTERS = 'pm.projects.filters.v5';
const REPORTER_NONE = '__none__';
const PROJECT_TYPE_NONE = '__none__';
const CLIENT_NONE = '__no_client__';
const PRODUCT_NONE = '__no_product__';

function defaultColumnState() {
    return Object.fromEntries(
        ALL_COLUMNS.map((c) => [c.id, c.required || c.default || false]),
    );
}

function loadJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch {
        return fallback;
    }
}

// Each filter is an array of selected values. An empty array means "no
// filter applied" for that field, which is easier to reason about than
// a sentinel value.
const DEFAULT_FILTERS = {
    search: '',
    statuses: [],
    priorities: [],
    ownerIds: [],
    reporterIds: [],
    projectTypeIds: [],
    clientIds: [],
    teamIds: [],
    productIds: [],
    // "Pinned only" — when true, hide every project the current user
    // hasn't pinned. Pin state lives in the shared UserPin table
    // (kind=PROJECT). Persisted to localStorage along with the rest
    // of the filter set so the view sticks across reloads.
    pinnedOnly: false,
};

// Visibility toggles for terminal-ish statuses. Kept separate from the
// `statuses` multi-select so the user can think of them as "always
// hide these" sticky preferences, independent of any ad-hoc filtering
// they're doing in the multi-select. Persisted to localStorage so the
// preference survives reloads.
// v2: reset any stale saved preference (some users had on-hold hidden),
// so the defaults below (show completed + on-hold) apply again.
const STORAGE_VISIBILITY = 'pm.projects.visibility.v2';
const DEFAULT_VISIBILITY = {
    showCompleted: true,
    showOnHold: true,
};

export default function Projects() {
    const { user: currentUser } = useAuth();
    const isAdmin = currentUser?.role === 'ADMIN';
    const isManager = currentUser?.role === 'MANAGER';
    // Inline quick-edit is open to admins on every project, and to
    // managers on projects they can already see (the list endpoint
    // already scopes to their participating projects, so visibility
    // implies edit access for them).
    const canInlineEdit = isAdmin || isManager;
    const { list: projectPriorityList, find: findProjectPriority } =
        useProjectPriorities();
    const { list: projectStatusList, find: findProjectStatus } =
        useProjectStatuses();
    const { items: projectTypeOptions } = useProjectTypes();
    const [projects, setProjects] = useState([]);
    const [users, setUsers] = useState([]);
    const [teams, setTeams] = useState([]);
    const [loading, setLoading] = useState(true);
    // Personal "pinned project" toggles — backed by the shared
    // UserPin table (kind=PROJECT). One fetch per page mount; the
    // optimistic toggle on each row points back at this hook.
    const projectPinHook = usePins('PROJECT');
    const [dialogOpen, setDialogOpen] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [editing, setEditing] = useState(null);
    const navigate = useNavigate();
    const location = useLocation();

    const [columns, setColumns] = useState(() =>
        loadJson(STORAGE_COLUMNS, defaultColumnState()),
    );
    const [filters, setFilters] = useState(() =>
        loadJson(STORAGE_FILTERS, DEFAULT_FILTERS),
    );
    const [visibility, setVisibility] = useState(() =>
        loadJson(STORAGE_VISIBILITY, DEFAULT_VISIBILITY),
    );
    // Set of project IDs the admin has explicitly ticked. When this is
    // non-empty, the Export action operates on these IDs and ignores
    // the visible filters (the toolbar makes that distinction clear).
    const [selectedIds, setSelectedIds] = useState(() => new Set());

    // Personal drag order (array of project IDs), seeded from the
    // logged-in user and persisted back to their account so it follows
    // them across devices. `null` while we wait for the user to load.
    const [order, setOrder] = useState(null);
    const [dragId, setDragId] = useState(null);

    // How to render the project list: 'table' (columns + zebra + inline edit,
    // the original) or 'cards' (the redesigned card rows). Remembered per
    // browser. Defaults to 'table' so all its features are the baseline.
    const [view, setView] = useState(() => {
        try {
            return localStorage.getItem('projects.view') || 'table';
        } catch {
            return 'table';
        }
    });
    const changeView = (v) => {
        setView(v);
        try {
            localStorage.setItem('projects.view', v);
        } catch {
            /* ignore */
        }
    };

    // Admin-defined project groups + the active group filter (also
    // driven by the ?group= URL param so sidebar links land filtered).
    const [groups, setGroups] = useState([]);
    const [groupIds, setGroupIds] = useState([]);
    const [manageGroupsOpen, setManageGroupsOpen] = useState(false);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const loadGroups = useMemo(
        () => async () => {
            try {
                const res = await api.get('/project-groups');
                setGroups(Array.isArray(res.data?.groups) ? res.data.groups : []);
            } catch {
                setGroups([]);
            }
            // Nudge the sidebar to refresh its nested group list.
            window.dispatchEvent(new Event('project-groups:changed'));
        },
        [],
    );
    useEffect(() => {
        loadGroups();
    }, [loadGroups]);
    // Sync the group filter from ?group= — re-runs when the sidebar
    // links change the query string (even without a remount). Clearing
    // the param (e.g. navigating to plain /projects) clears the filter.
    useEffect(() => {
        const g = new URLSearchParams(location.search).get('group');
        setGroupIds(g ? [g] : []);
    }, [location.search]);
    useEffect(() => {
        if (currentUser && order === null) {
            setOrder(
                Array.isArray(currentUser.projectOrder)
                    ? currentUser.projectOrder
                    : [],
            );
        }
    }, [currentUser, order]);

    const persistOrder = async (ids) => {
        if (!currentUser?.id) return;
        try {
            await api.patch(`/users/${currentUser.id}`, { projectOrder: ids });
        } catch {
            // Non-fatal: the local order still applies this session.
            toast.error('Could not save the new order.');
        }
    };

    useEffect(() => {
        localStorage.setItem(STORAGE_COLUMNS, JSON.stringify(columns));
    }, [columns]);
    useEffect(() => {
        localStorage.setItem(STORAGE_FILTERS, JSON.stringify(filters));
    }, [filters]);
    useEffect(() => {
        localStorage.setItem(STORAGE_VISIBILITY, JSON.stringify(visibility));
    }, [visibility]);

    const load = async () => {
        try {
            const [projRes, userRes, teamRes] = await Promise.all([
                api.get('/projects'),
                api.get('/users'),
                api.get('/teams'),
            ]);
            setProjects(projRes.data.projects);
            setUsers(userRes.data.users);
            setTeams(teamRes.data.teams || []);
        } catch {
            toast.error('Failed to load projects');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    // Drop selections that point at projects which no longer exist in
    // the loaded list (e.g. after a delete). We *don't* clear when the
    // user just changes filters — the explicit selection should outlive
    // a filter tweak so the export action always honours their intent.
    useEffect(() => {
        if (selectedIds.size === 0) return;
        const valid = new Set(projects.map((p) => p.id));
        let changed = false;
        const next = new Set();
        for (const id of selectedIds) {
            if (valid.has(id)) next.add(id);
            else changed = true;
        }
        if (changed) setSelectedIds(next);
    }, [projects]); // eslint-disable-line react-hooks/exhaustive-deps

    const clientFilterOptions = useMemo(() => {
        const byKey = new Map();
        for (const p of projects) {
            const id = p.clientId || p.clientRecord?.id || null;
            const name = (p.clientRecord?.name || p.client || '').trim();
            if (id && name) byKey.set(id, name);
            else if (name) byKey.set(`name:${name}`, name);
        }
        return Array.from(byKey.entries())
            .map(([value, label]) => ({ value, label }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }, [projects]);

    // Product options derived from the loaded projects (products actually
    // in use). Code is prepended when present so "SP · SoftPOS" reads well.
    const productFilterOptions = useMemo(() => {
        const byId = new Map();
        for (const p of projects) {
            const prod = p.product;
            if (prod?.id && !byId.has(prod.id)) {
                byId.set(
                    prod.id,
                    prod.code ? `${prod.code} · ${prod.name}` : prod.name,
                );
            }
        }
        return Array.from(byId.entries())
            .map(([value, label]) => ({ value, label }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }, [projects]);

    // Apply the personal drag order: projects listed in `order` come
    // first in that order; anything not yet ordered (e.g. brand-new
    // projects) follows in the API's default order.
    const orderedProjects = useMemo(() => {
        if (!order || order.length === 0) return projects;
        const pos = new Map(order.map((id, i) => [id, i]));
        return [...projects].sort((a, b) => {
            const ai = pos.has(a.id) ? pos.get(a.id) : Infinity;
            const bi = pos.has(b.id) ? pos.get(b.id) : Infinity;
            if (ai !== bi) return ai - bi;
            return 0; // keep original relative order for un-ordered tail
        });
    }, [projects, order]);

    // Union of project ids across the selected groups (null = no filter).
    const groupProjectIds = useMemo(() => {
        if (!groupIds.length) return null;
        const set = new Set();
        for (const gid of groupIds) {
            const g = groups.find((x) => x.id === gid);
            for (const pid of g?.projectIds || []) set.add(pid);
        }
        return set;
    }, [groupIds, groups]);

    const filtered = useMemo(() => {
        const search = filters.search.trim().toLowerCase();
        return orderedProjects.filter((p) => {
            // Group filter (from the toolbar / sidebar) — narrow to the
            // projects in the chosen group.
            if (groupProjectIds && !groupProjectIds.has(p.id)) return false;
            // "Pinned only" gate — wins over every other filter so
            // the user can collapse the list down to just their
            // bookmarks at any point.
            if (filters.pinnedOnly && !projectPinHook.isPinned(p.id)) {
                return false;
            }
            // Visibility toggles act as sticky overrides. If the user
            // has flipped "Show completed" off, DONE projects are
            // hidden regardless of what the Status multi-select says.
            // Same idea for "Show on hold".
            if (!visibility.showCompleted && p.status === 'DONE') return false;
            if (!visibility.showOnHold && p.status === 'ON_HOLD') return false;
            if (filters.statuses.length && !filters.statuses.includes(p.status))
                return false;
            if (
                filters.priorities.length &&
                !filters.priorities.includes(p.priority)
            )
                return false;
            if (
                filters.ownerIds.length &&
                !filters.ownerIds.includes(p.ownerId)
            )
                return false;
            if (filters.reporterIds.length) {
                const wantsNone = filters.reporterIds.includes(REPORTER_NONE);
                const matchedNone = wantsNone && !p.reporterId;
                const matchedSomeone =
                    p.reporterId && filters.reporterIds.includes(p.reporterId);
                if (!matchedNone && !matchedSomeone) return false;
            }
            if (filters.projectTypeIds.length) {
                const wantsNone = filters.projectTypeIds.includes(
                    PROJECT_TYPE_NONE,
                );
                const projectType =
                    p.projectTypeId || p.projectType?.id || null;
                const matchedNone = wantsNone && !projectType;
                const matchedType =
                    projectType &&
                    filters.projectTypeIds.includes(projectType);
                if (!matchedNone && !matchedType) return false;
            }
            if (filters.clientIds.length) {
                const wantsNone = filters.clientIds.includes(CLIENT_NONE);
                const clientId = p.clientId || p.clientRecord?.id || null;
                const clientName = (p.clientRecord?.name || p.client || '').trim();
                const matchedNone = wantsNone && !clientId && !clientName;
                const matchedId =
                    clientId && filters.clientIds.includes(clientId);
                const matchedLegacy =
                    !clientId &&
                    clientName &&
                    filters.clientIds.includes(`name:${clientName}`);
                if (!matchedNone && !matchedId && !matchedLegacy) return false;
            }
            if (filters.teamIds.length) {
                const involved = p.teamIds || [];
                if (!filters.teamIds.some((tid) => involved.includes(tid))) {
                    return false;
                }
            }
            if (filters.productIds.length) {
                const wantsNone = filters.productIds.includes(PRODUCT_NONE);
                const productId = p.product?.id || p.productId || null;
                const matchedNone = wantsNone && !productId;
                const matchedId =
                    productId && filters.productIds.includes(productId);
                if (!matchedNone && !matchedId) return false;
            }
            if (search) {
                // Search across every text-y field plus the human-readable
                // status / priority labels so typing "completed" finds DONE
                // projects, "urgent" finds URGENT, etc.
                const status =
                    findProjectStatus(p.status)?.label ||
                    PROJECT_STATUS_MAP[p.status]?.label ||
                    p.status ||
                    '';
                const priority =
                    findProjectPriority(p.priority)?.label ||
                    PROJECT_PRIORITY_MAP[p.priority]?.label ||
                    p.priority ||
                    '';
                const haystack = [
                    p.name,
                    p.description,
                    p.client,
                    p.crmId,
                    p.country,
                    p.label,
                    p.phase,
                    p.projectType?.name,
                    p.owner?.name,
                    p.owner?.email,
                    p.reporter?.name,
                    p.reporter?.email,
                    status,
                    priority,
                ]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();
                if (!haystack.includes(search)) return false;
            }
            return true;
        });
    }, [orderedProjects, filters, visibility, findProjectPriority, findProjectStatus, projectPinHook, groupProjectIds]);

    // Reordering is only safe when nothing is hidden — otherwise a drag
    // could move a row past projects the user can't see. So drag is
    // enabled only when the visible list is the whole list.
    const reorderEnabled = filtered.length === orderedProjects.length;

    const handleRowDrop = (targetId) => {
        if (!dragId || dragId === targetId) {
            setDragId(null);
            return;
        }
        const ids = orderedProjects.map((p) => p.id);
        const from = ids.indexOf(dragId);
        const to = ids.indexOf(targetId);
        if (from === -1 || to === -1) {
            setDragId(null);
            return;
        }
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        setOrder(ids);
        setDragId(null);
        persistOrder(ids);
    };

    const visibleColumns = ALL_COLUMNS.filter((c) => columns[c.id]);

    const activeFilterCount =
        (filters.search ? 1 : 0) +
        (filters.statuses.length ? 1 : 0) +
        (filters.priorities.length ? 1 : 0) +
        (filters.ownerIds.length ? 1 : 0) +
        (filters.reporterIds.length ? 1 : 0) +
        (filters.projectTypeIds.length ? 1 : 0) +
        (filters.clientIds.length ? 1 : 0) +
        (filters.teamIds.length ? 1 : 0) +
        (filters.productIds.length ? 1 : 0);

    const handleCreate = () => {
        setEditing(null);
        setDialogOpen(true);
    };

    const handleEdit = (project) => {
        setEditing(project);
        setDialogOpen(true);
    };

    const handleSubmit = async (values) => {
        setSubmitting(true);
        // Pull the optional builder payloads off before we ship the
        // rest to the project endpoint — the backend doesn't know
        // about these keys and would reject them via Zod.
        const {
            _pendingContacts: pendingContacts,
            _pendingCollaborators: pendingCollaborators,
            ...projectPayload
        } = values || {};
        try {
            if (editing) {
                await api.patch(`/projects/${editing.id}`, projectPayload);
                toast.success('Project updated');
            } else {
                const res = await api.post('/projects', projectPayload);
                toast.success('Project created');
                const newId = res?.data?.project?.id || res?.data?.id;

                // Fan out contacts in parallel. Failures are reported
                // but don't block the success of the create itself —
                // the project is already saved at this point.
                if (
                    newId &&
                    Array.isArray(pendingContacts) &&
                    pendingContacts.length
                ) {
                    const results = await Promise.allSettled(
                        pendingContacts.map((c) =>
                            api.post('/project-contacts', {
                                projectId: newId,
                                ...c,
                            }),
                        ),
                    );
                    const failed = results.filter(
                        (r) => r.status === 'rejected',
                    ).length;
                    if (failed > 0) {
                        toast.error(
                            `Project created, but ${failed} contact${
                                failed === 1 ? '' : 's'
                            } could not be saved`,
                        );
                    } else {
                        toast.success(
                            `${pendingContacts.length} contact${
                                pendingContacts.length === 1 ? '' : 's'
                            } added`,
                        );
                    }
                }

                // Personal projects can ship a list of collaborators
                // to invite in the same dialog. Same fan-out pattern
                // — non-blocking, with a per-batch toast.
                if (
                    newId &&
                    Array.isArray(pendingCollaborators) &&
                    pendingCollaborators.length
                ) {
                    const results = await Promise.allSettled(
                        pendingCollaborators.map((userId) =>
                            api.post(`/projects/${newId}/participants`, {
                                userId,
                            }),
                        ),
                    );
                    const failed = results.filter(
                        (r) => r.status === 'rejected',
                    ).length;
                    if (failed > 0) {
                        toast.error(
                            `Project created, but ${failed} collaborator${
                                failed === 1 ? '' : 's'
                            } could not be invited`,
                        );
                    } else {
                        toast.success(
                            `${pendingCollaborators.length} collaborator${
                                pendingCollaborators.length === 1 ? '' : 's'
                            } invited`,
                        );
                    }
                }
            }
            setDialogOpen(false);
            load();
        } catch (err) {
            toast.error(formatApiError(err, 'Something went wrong'));
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (project) => {
        if (!window.confirm(`Delete "${project.name}" and all its tasks?`)) return;
        try {
            await api.delete(`/projects/${project.id}`);
            toast.success('Project deleted');
            load();
        } catch {
            toast.error('Could not delete project');
        }
    };

    // Merges the row returned by an inline-edit PATCH back into the
    // local list so we don't have to refetch every time. The PATCH
    // endpoint returns the same shape as `forList` consumed elsewhere,
    // so we can drop it straight in.
    const handleInlineSaved = (updated) => {
        if (!updated?.id) return;
        setProjects((prev) =>
            prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)),
        );
    };

    const [exporting, setExporting] = useState(false);

    // Mirrors the visible list filters into query params so the server-side
    // export sees the same slice the user is looking at.
    //
    // - `detail`: 'summary' (one sheet) or 'full' (adds Phases / Tasks /
    //   Activities / Notes / Files / Participants).
    // - `scope` : 'selected' uses the explicit selection (`projectIds=`
    //   query param). Anything else uses the current filter state.
    // The "Include prices" toggle is held in component state below
    // and threaded into the request via `?prices=1`.
    const [includePrices, setIncludePrices] = useState(false);
    const handleExport = async (detail = 'summary', scope = 'auto') => {
        setExporting(true);
        try {
            const params = {};
            const useSelection =
                scope === 'selected' ||
                (scope === 'auto' && selectedIds.size > 0);

            if (useSelection) {
                params.projectIds = Array.from(selectedIds).join(',');
            } else {
                if (filters.search.trim()) params.search = filters.search.trim();
                // Multi-select filters are flattened to comma-separated
                // values. The backend splits and treats them as `IN (...)`
                // clauses.
                if (filters.statuses.length)
                    params.status = filters.statuses.join(',');
                if (filters.priorities.length)
                    params.priority = filters.priorities.join(',');
                if (filters.ownerIds.length)
                    params.ownerId = filters.ownerIds.join(',');
                if (filters.reporterIds.length)
                    params.reporterId = filters.reporterIds.join(',');
            }
            if (detail === 'full') params.detail = 'full';
            if (includePrices) params.prices = 1;
            const suffix = detail === 'full' ? '-detailed' : '';
            await downloadFromApi('/exports/projects/xlsx', {
                params,
                filenameFallback: `projects${suffix}-${new Date()
                    .toISOString()
                    .slice(0, 10)}.xlsx`,
            });
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not export projects',
            );
        } finally {
            setExporting(false);
        }
    };

    const headerActions = useMemo(
        () => {
            const selCount = selectedIds.size;
            const scopeLabel = selCount > 0
                ? `${selCount} selected`
                : 'filtered projects';
            return (
                <div className="flex items-center gap-2">
                    {isAdmin && (
                        <DropdownMenu>
                            {/* Export is desktop-only — hidden on phones
                                where it's never used and would crowd the
                                header against the burger menu. */}
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="outline"
                                    disabled={exporting}
                                    className="hidden gap-2 sm:inline-flex"
                                >
                                    <Download className="h-4 w-4" />
                                    {exporting ? 'Exporting…' : 'Export'}
                                    {selCount > 0 && (
                                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                                            {selCount}
                                        </span>
                                    )}
                                    <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-80">
                                <DropdownMenuLabel className="flex items-center justify-between gap-2">
                                    <span>Export to Excel</span>
                                    <span className="text-[10px] font-normal text-muted-foreground">
                                        Scope: {scopeLabel}
                                    </span>
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuCheckboxItem
                                    checked={includePrices}
                                    onSelect={(e) => e.preventDefault()}
                                    onCheckedChange={(v) =>
                                        setIncludePrices(Boolean(v))
                                    }
                                >
                                    <div className="flex flex-col items-start gap-0.5">
                                        <span className="font-medium">
                                            Include prices
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            Adds internal settlement, client
                                            price and paid status columns plus
                                            a dedicated Billing sheet.
                                        </span>
                                    </div>
                                </DropdownMenuCheckboxItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    onClick={() => handleExport('summary')}
                                    className="flex flex-col items-start gap-0.5"
                                >
                                    <span className="font-medium">Summary</span>
                                    <span className="text-xs text-muted-foreground">
                                        One sheet with{' '}
                                        {selCount > 0
                                            ? `the ${selCount} selected project${selCount === 1 ? '' : 's'}`
                                            : 'the visible projects'}
                                        , counts and basic fields
                                        {includePrices ? ' + prices' : ''}.
                                    </span>
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={() => handleExport('full')}
                                    className="flex flex-col items-start gap-0.5"
                                >
                                    <span className="font-medium">
                                        Full detail
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        Adds Phases, Tasks, Activities, Notes,
                                        Files and Participants sheets covering
                                        every row across{' '}
                                        {selCount > 0
                                            ? 'the selected projects'
                                            : 'the filtered projects'}
                                        {includePrices
                                            ? ', including pricing'
                                            : ''}
                                        .
                                    </span>
                                </DropdownMenuItem>
                                {selCount > 0 && (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            onClick={() => setSelectedIds(new Set())}
                                            className="text-xs text-muted-foreground"
                                        >
                                            Clear selection
                                        </DropdownMenuItem>
                                    </>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                    {/* Anyone can create a project — admins get the
                        full shared-project create flow, regular users
                        get the personal-project toggle inside the
                        dialog (and the backend gate enforces that
                        non-admins can only flip isPersonal=true). */}
                    {/* Icon-only on phones (fits the wrapped header row),
                        full label from sm up. */}
                    <Button
                        onClick={handleCreate}
                        className="gap-2"
                        title="New project"
                    >
                        <Plus className="h-4 w-4" />
                        <span className="hidden sm:inline">New project</span>
                    </Button>
                </div>
            );
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [isAdmin, exporting, filters, selectedIds, includePrices],
    );

    const resetFilters = () => setFilters(DEFAULT_FILTERS);
    const resetColumns = () => setColumns(defaultColumnState());

    return (
        <>
            <TopBar title="Projects" actions={headerActions} />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <div className="relative flex-1 min-w-[220px] max-w-sm">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={filters.search}
                            onChange={(e) =>
                                setFilters((f) => ({ ...f, search: e.target.value }))
                            }
                            placeholder="Search name, client, CRM ID..."
                            className="pl-8"
                        />
                        {filters.search && (
                            <button
                                type="button"
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                onClick={() =>
                                    setFilters((f) => ({ ...f, search: '' }))
                                }
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>

                    {/* All the column filters live in a dropdown panel so
                        the toolbar stays clean and works on mobile. */}
                    <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
                        <PopoverTrigger asChild>
                            <Button
                                variant="outline"
                                size="sm"
                                className="gap-1.5"
                            >
                                <SlidersHorizontal className="h-4 w-4" />
                                Filters
                                {activeFilterCount > 0 && (
                                    <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                                        {activeFilterCount}
                                    </span>
                                )}
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent
                            align="start"
                            className="w-[280px] p-0"
                        >
                            <div className="flex items-center justify-between gap-2 border-b p-3">
                                <span className="flex items-center gap-1.5 text-sm font-semibold">
                                    <SlidersHorizontal className="h-4 w-4" />
                                    Filters
                                </span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={resetFilters}
                                    disabled={activeFilterCount === 0}
                                    className="h-7 gap-1 px-2 text-xs"
                                >
                                    <X className="h-3.5 w-3.5" /> Clear
                                </Button>
                            </div>
                            <div className="max-h-[60vh] space-y-3 overflow-y-auto p-3">
                                <FilterField label="Status">
                                    <MultiFilter
                                        label="Status"
                                        values={filters.statuses}
                                        onChange={(next) =>
                                            setFilters((f) => ({
                                                ...f,
                                                statuses: next,
                                            }))
                                        }
                                        options={projectStatusList.map((s) => ({
                                            value: s.value,
                                            label: s.label,
                                        }))}
                                    />
                                </FilterField>
                                <FilterField label="Priority">
                                    <MultiFilter
                                        label="Priority"
                                        values={filters.priorities}
                                        onChange={(next) =>
                                            setFilters((f) => ({
                                                ...f,
                                                priorities: next,
                                            }))
                                        }
                                        options={projectPriorityList.map(
                                            (p) => ({
                                                value: p.value,
                                                label: p.label,
                                            }),
                                        )}
                                    />
                                </FilterField>
                                <FilterField label="Owner">
                                    <MultiFilter
                                        label="Owner"
                                        values={filters.ownerIds}
                                        onChange={(next) =>
                                            setFilters((f) => ({
                                                ...f,
                                                ownerIds: next,
                                            }))
                                        }
                                        options={users.map((u) => ({
                                            value: u.id,
                                            label: u.name || u.email,
                                        }))}
                                    />
                                </FilterField>
                                <FilterField label="Client">
                                    <MultiFilter
                                        label="Client"
                                        values={filters.clientIds}
                                        onChange={(next) =>
                                            setFilters((f) => ({
                                                ...f,
                                                clientIds: next,
                                            }))
                                        }
                                        options={[
                                            {
                                                value: CLIENT_NONE,
                                                label: 'No client',
                                            },
                                            ...clientFilterOptions,
                                        ]}
                                    />
                                </FilterField>
                                <FilterField label="Product">
                                    <MultiFilter
                                        label="Product"
                                        values={filters.productIds}
                                        onChange={(next) =>
                                            setFilters((f) => ({
                                                ...f,
                                                productIds: next,
                                            }))
                                        }
                                        options={[
                                            {
                                                value: PRODUCT_NONE,
                                                label: 'No product',
                                            },
                                            ...productFilterOptions,
                                        ]}
                                    />
                                </FilterField>
                                <FilterField label="Project type">
                                    <MultiFilter
                                        label="Project type"
                                        values={filters.projectTypeIds}
                                        onChange={(next) =>
                                            setFilters((f) => ({
                                                ...f,
                                                projectTypeIds: next,
                                            }))
                                        }
                                        options={[
                                            {
                                                value: PROJECT_TYPE_NONE,
                                                label: 'Uncategorised',
                                            },
                                            ...projectTypeOptions.map((t) => ({
                                                value: t.id,
                                                label: t.name,
                                            })),
                                        ]}
                                    />
                                </FilterField>
                                <FilterField label="Team">
                                    <MultiFilter
                                        label="Team"
                                        values={filters.teamIds}
                                        onChange={(next) =>
                                            setFilters((f) => ({
                                                ...f,
                                                teamIds: next,
                                            }))
                                        }
                                        options={teams.map((t) => ({
                                            value: t.id,
                                            label: t.name,
                                        }))}
                                    />
                                </FilterField>
                            </div>
                        </PopoverContent>
                    </Popover>

                    {/* Groups are personal: any user can create and manage
                        their own. */}
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setManageGroupsOpen(true)}
                        className="gap-1"
                        title="Create and manage your project groups"
                    >
                        <FolderKanban className="h-4 w-4" />
                        Groups
                    </Button>

                    {/* Active group filter chip (set from the sidebar). */}
                    {groupIds.length > 0 && (
                        <button
                            type="button"
                            onClick={() => navigate('/projects')}
                            className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20"
                            title="Clear group filter"
                        >
                            <FolderKanban className="h-3.5 w-3.5" />
                            {groups.find((g) => g.id === groupIds[0])?.name ||
                                'Group'}
                            <X className="h-3 w-3" />
                        </button>
                    )}

                    {activeFilterCount > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={resetFilters}
                            className="gap-1"
                        >
                            <X className="h-4 w-4" />
                            Clear ({activeFilterCount})
                        </Button>
                    )}

                    <Button
                        variant={filters.pinnedOnly ? 'default' : 'outline'}
                        size="sm"
                        onClick={() =>
                            setFilters((f) => ({
                                ...f,
                                pinnedOnly: !f.pinnedOnly,
                            }))
                        }
                        className="gap-1"
                        title={
                            filters.pinnedOnly
                                ? 'Show all projects'
                                : 'Only show projects you have pinned'
                        }
                    >
                        <Pin className="h-3.5 w-3.5" />
                        {filters.pinnedOnly
                            ? `Pinned only (${projectPinHook.pinned.length})`
                            : 'Pinned'}
                    </Button>

                    {/* View controls grouped + right-aligned (ml-auto) so
                        they stay on the right edge even when the toolbar
                        wraps to a new line on smaller screens, instead of
                        jumping to the left. */}
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                    {/* Visibility toggles — sticky preferences for
                        "always hide DONE / ON_HOLD". Kept on the
                        toolbar (not inside the Status multi-select)
                        so the user can flip them in one click and see
                        the row count change instantly. Persisted to
                        localStorage so the choice survives reloads. */}
                    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-1.5 text-xs">
                        <Label
                            htmlFor="projects-show-completed"
                            className="flex cursor-pointer items-center gap-1.5 text-xs font-normal text-muted-foreground"
                            title="Show completed projects (off = hide them)"
                        >
                            <Switch
                                id="projects-show-completed"
                                checked={visibility.showCompleted}
                                onCheckedChange={(v) =>
                                    setVisibility((prev) => ({
                                        ...prev,
                                        showCompleted: Boolean(v),
                                    }))
                                }
                            />
                            <span className="text-foreground">
                                Completed
                            </span>
                        </Label>
                        <Label
                            htmlFor="projects-show-onhold"
                            className="flex cursor-pointer items-center gap-1.5 text-xs font-normal text-muted-foreground"
                            title="Show on-hold projects (off = hide them)"
                        >
                            <Switch
                                id="projects-show-onhold"
                                checked={visibility.showOnHold}
                                onCheckedChange={(v) =>
                                    setVisibility((prev) => ({
                                        ...prev,
                                        showOnHold: Boolean(v),
                                    }))
                                }
                            />
                            <span className="text-foreground">On hold</span>
                        </Label>
                    </div>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className="gap-2">
                                <SlidersHorizontal className="h-4 w-4" />
                                {view === 'cards' ? 'Fields' : 'Columns'}
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {ALL_COLUMNS.map((col) => (
                                <DropdownMenuCheckboxItem
                                    key={col.id}
                                    checked={Boolean(columns[col.id])}
                                    disabled={col.required}
                                    onCheckedChange={(v) =>
                                        setColumns((prev) => ({
                                            ...prev,
                                            [col.id]: Boolean(v),
                                        }))
                                    }
                                    onSelect={(e) => e.preventDefault()}
                                >
                                    {col.label}
                                </DropdownMenuCheckboxItem>
                            ))}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={resetColumns}>
                                Reset to defaults
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    {/* View switcher — Table (columns/zebra/inline edit) vs
                        Cards (redesigned rows), like the Tickets workspace. */}
                    <div className="flex items-center rounded-md border bg-card p-0.5">
                        {[
                            { id: 'table', Icon: List, label: 'Table view' },
                            { id: 'cards', Icon: LayoutGrid, label: 'Card view' },
                        ].map((v) => (
                            <button
                                key={v.id}
                                type="button"
                                title={v.label}
                                aria-label={v.label}
                                onClick={() => changeView(v.id)}
                                className={cn(
                                    'flex h-8 w-8 items-center justify-center rounded transition-colors',
                                    view === v.id
                                        ? 'bg-primary text-primary-foreground'
                                        : 'text-muted-foreground hover:bg-accent',
                                )}
                            >
                                <v.Icon className="h-4 w-4" />
                            </button>
                        ))}
                    </div>
                    </div>
                </div>

                {isAdmin && selectedIds.size > 0 && (
                    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                        <Check className="h-4 w-4 text-primary" />
                        <span className="font-medium">
                            {selectedIds.size} project
                            {selectedIds.size === 1 ? '' : 's'} selected
                        </span>
                        <span className="text-xs text-muted-foreground">
                            Export will use this selection instead of the
                            current filters.
                        </span>
                        <div className="flex-1" />
                        {(() => {
                            const visibleSelectable = filtered.length;
                            const allVisibleSelected =
                                visibleSelectable > 0 &&
                                filtered.every((p) => selectedIds.has(p.id));
                            return (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs"
                                    onClick={() => {
                                        if (allVisibleSelected) return;
                                        setSelectedIds((prev) => {
                                            const next = new Set(prev);
                                            for (const p of filtered)
                                                next.add(p.id);
                                            return next;
                                        });
                                    }}
                                    disabled={allVisibleSelected}
                                >
                                    Select all visible ({visibleSelectable})
                                </Button>
                            );
                        })()}
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={() => setSelectedIds(new Set())}
                        >
                            <X className="h-3.5 w-3.5" />
                            Clear
                        </Button>
                    </div>
                )}

                <div
                    className={cn(
                        // The redesigned card rows are self-contained (each
                        // has its own border/shadow), so in card view we drop
                        // the outer frame — otherwise it draws a second border
                        // that reads as a stray line down the left edge next
                        // to the coloured status spine. The table view still
                        // needs the frame.
                        view === 'cards'
                            ? 'rounded-lg'
                            : 'rounded-lg border bg-card shadow-sm',
                    )}
                >
                    {loading ? (
                        <div className="p-10 text-center text-sm text-muted-foreground">
                            Loading projects...
                        </div>
                    ) : projects.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-3 p-16 text-center">
                            <FolderKanban className="h-10 w-10 text-muted-foreground" />
                            <div>
                                <p className="font-medium">No projects yet</p>
                                <p className="text-sm text-muted-foreground">
                                    Create your first project to get started.
                                </p>
                            </div>
                            <Button onClick={handleCreate} className="mt-2 gap-2">
                                <Plus className="h-4 w-4" />
                                New project
                            </Button>
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-3 p-16 text-center">
                            <Filter className="h-10 w-10 text-muted-foreground" />
                            <p className="font-medium">No matches</p>
                            <p className="text-sm text-muted-foreground">
                                No projects match your current filters.
                            </p>
                            <Button variant="outline" size="sm" onClick={resetFilters}>
                                Clear filters
                            </Button>
                        </div>
                    ) : view === 'cards' ? (
                        <div className="space-y-2.5">
                            {isAdmin && (
                                <div className="flex items-center gap-2.5 px-1 py-1.5 text-sm">
                                    <SelectAllCheckbox
                                        filtered={filtered}
                                        selectedIds={selectedIds}
                                        setSelectedIds={setSelectedIds}
                                    />
                                    <span className="font-medium">
                                        {selectedIds.size > 0
                                            ? `${selectedIds.size} selected`
                                            : 'Select all'}
                                    </span>
                                    <span className="ml-auto text-xs text-muted-foreground">
                                        {filtered.length} project
                                        {filtered.length === 1 ? '' : 's'}
                                    </span>
                                </div>
                            )}
                            {filtered.map((project) => {
                                // Edit / delete: admins on any project, plus the
                                // owner of a personal project.
                                const canManage =
                                    isAdmin ||
                                    (project.isPersonal &&
                                        project.ownerId === currentUser?.id);
                                const selected = selectedIds.has(project.id);
                                return (
                                    <ProjectCard
                                        key={project.id}
                                        project={project}
                                        columns={columns}
                                        isAdmin={isAdmin}
                                        canManage={canManage}
                                        findProjectPriority={findProjectPriority}
                                        findProjectStatus={findProjectStatus}
                                        selected={selected}
                                        onToggleSelect={() =>
                                            setSelectedIds((prev) => {
                                                const next = new Set(prev);
                                                if (next.has(project.id)) {
                                                    next.delete(project.id);
                                                } else {
                                                    next.add(project.id);
                                                }
                                                return next;
                                            })
                                        }
                                        reorderEnabled={reorderEnabled}
                                        dragging={dragId === project.id}
                                        onDragStartRow={() =>
                                            setDragId(project.id)
                                        }
                                        onDropRow={() => handleRowDrop(project.id)}
                                        pinHook={projectPinHook}
                                        onOpen={() =>
                                            navigate(`/projects/${project.id}`)
                                        }
                                        onEdit={() => handleEdit(project)}
                                        onDelete={() => handleDelete(project)}
                                    />
                                );
                            })}
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <Table className="w-full">
                                {/* Distinct, darker band for the header so
                                    it never blends with the zebra-striped
                                    rows below. */}
                                <TableHeader className="bg-slate-200/90 [&_tr]:border-b dark:bg-slate-800">
                                    <TableRow className="hover:bg-transparent">
                                        <TableHead
                                            style={{ width: '28px', minWidth: '28px' }}
                                            className="bg-slate-200/90 dark:bg-slate-800"
                                        />
                                        {isAdmin && (
                                            <TableHead
                                                style={{ width: '40px', minWidth: '40px' }}
                                                className="bg-slate-200/90 dark:bg-slate-800"
                                            >
                                                <SelectAllCheckbox
                                                    filtered={filtered}
                                                    selectedIds={selectedIds}
                                                    setSelectedIds={setSelectedIds}
                                                />
                                            </TableHead>
                                        )}
                                        {visibleColumns.map((col) => (
                                            <TableHead
                                                key={col.id}
                                                style={{
                                                    minWidth: `${col.minWidth || 140}px`,
                                                }}
                                                className="whitespace-nowrap text-[11px] font-bold uppercase tracking-wider text-slate-700 dark:text-slate-200"
                                            >
                                                {col.label}
                                            </TableHead>
                                        ))}
                                        <TableHead
                                            className="sticky right-0 bg-slate-200/90 dark:bg-slate-800"
                                            style={{ minWidth: '48px', width: '48px' }}
                                        />
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filtered.map((project, idx) => {
                                        const canManage =
                                            isAdmin ||
                                            (project.isPersonal &&
                                                project.ownerId ===
                                                    currentUser?.id);
                                        const selected = selectedIds.has(project.id);
                                        return (
                                            <ProjectRow
                                                key={project.id}
                                                project={project}
                                                visibleColumns={visibleColumns}
                                                users={users}
                                                canManage={canManage}
                                                isAdmin={isAdmin}
                                                reorderEnabled={reorderEnabled}
                                                dragging={dragId === project.id}
                                                onDragStartRow={() =>
                                                    setDragId(project.id)
                                                }
                                                onDropRow={() =>
                                                    handleRowDrop(project.id)
                                                }
                                                inlineEditable={
                                                    canInlineEdit || canManage
                                                }
                                                onInlineSaved={handleInlineSaved}
                                                projectPriorityList={
                                                    projectPriorityList
                                                }
                                                findProjectPriority={
                                                    findProjectPriority
                                                }
                                                projectStatusList={
                                                    projectStatusList
                                                }
                                                findProjectStatus={
                                                    findProjectStatus
                                                }
                                                selected={selected}
                                                onToggleSelect={() =>
                                                    setSelectedIds((prev) => {
                                                        const next = new Set(prev);
                                                        if (next.has(project.id)) {
                                                            next.delete(project.id);
                                                        } else {
                                                            next.add(project.id);
                                                        }
                                                        return next;
                                                    })
                                                }
                                                zebraTone={
                                                    idx % 2 === 0
                                                        ? 'bg-card'
                                                        : 'bg-slate-100 dark:bg-slate-800/40'
                                                }
                                                onOpen={() =>
                                                    navigate(
                                                        `/projects/${project.id}`,
                                                    )
                                                }
                                                onEdit={() => handleEdit(project)}
                                                onDelete={() =>
                                                    handleDelete(project)
                                                }
                                                pinHook={projectPinHook}
                                            />
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </div>
            </main>

            <ProjectFormDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                onSubmit={handleSubmit}
                submitting={submitting}
                initialValues={editing}
                users={users}
                title={editing ? 'Edit project' : 'Create project'}
                submitLabel={editing ? 'Save changes' : 'Create'}
            />

            <ManageProjectGroupsDialog
                open={manageGroupsOpen}
                onOpenChange={setManageGroupsOpen}
                projects={projects}
                groups={groups}
                onChanged={loadGroups}
            />

        </>
    );
}

// Multi-select filter trigger that lists checkbox options. Empty
// `values` means "no filter" — the trigger summarises the selection
// either as a count badge or the single selected label.
// Labeled wrapper for a filter control inside the filters drawer.
function FilterField({ label, children }) {
    return (
        <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
                {label}
            </span>
            <div>{children}</div>
        </div>
    );
}

function MultiFilter({ label, values, onChange, options }) {
    const selected = values.length;
    const toggle = (v) => {
        const set = new Set(values);
        if (set.has(v)) set.delete(v);
        else set.add(v);
        onChange(Array.from(set));
    };
    const summary =
        selected === 0
            ? `Any ${label.toLowerCase()}`
            : selected === 1
                ? options.find((o) => o.value === values[0])?.label || values[0]
                : `${label}: ${selected}`;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn(
                        'h-9 min-w-[140px] justify-between gap-2 px-3 text-sm font-normal',
                        selected > 0 && 'border-primary/50 bg-primary/5',
                    )}
                >
                    <span className="truncate">{summary}</span>
                    {selected > 0 ? (
                        <span
                            role="button"
                            tabIndex={-1}
                            onPointerDown={(e) => {
                                // Stop the dropdown from opening when
                                // the user clicks the clear chip.
                                e.preventDefault();
                                e.stopPropagation();
                                onChange([]);
                            }}
                            className="-mr-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={`Clear ${label} filter`}
                            title={`Clear ${label} filter`}
                        >
                            <X className="h-3.5 w-3.5" />
                        </span>
                    ) : (
                        <ChevronDown className="h-4 w-4 opacity-60" />
                    )}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>{label}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {options.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        No options
                    </p>
                ) : (
                    options.map((opt) => {
                        const checked = values.includes(opt.value);
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                onClick={() => toggle(opt.value)}
                                className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent focus:bg-accent"
                            >
                                <span
                                    className={cn(
                                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                        checked
                                            ? 'border-primary bg-primary text-primary-foreground'
                                            : 'border-muted-foreground/40',
                                    )}
                                >
                                    {checked && <Check className="h-3 w-3" />}
                                </span>
                                <span className="truncate">{opt.label}</span>
                            </button>
                        );
                    })
                )}
                {selected > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => onChange([])}>
                            <X className="h-4 w-4" />
                            Clear selection
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// Dot / stripe / text tones for the redesigned card rows. Keyed by the
// canonical status/priority values (admin labels/colours drive the pills
// elsewhere; here we just want a consistent accent per state).
const CARD_STATUS_TONE = {
    TODO: 'bg-slate-400',
    IN_PROGRESS: 'bg-sky-500',
    CLIENT_TEST: 'bg-indigo-500',
    BILLING: 'bg-amber-500',
    DONE: 'bg-emerald-500',
    ON_HOLD: 'bg-amber-500',
};
const CARD_STATUS_TEXT = {
    TODO: 'text-slate-500',
    IN_PROGRESS: 'text-sky-600 dark:text-sky-400',
    CLIENT_TEST: 'text-indigo-600 dark:text-indigo-400',
    BILLING: 'text-amber-600 dark:text-amber-400',
    DONE: 'text-emerald-600 dark:text-emerald-400',
    ON_HOLD: 'text-amber-600 dark:text-amber-400',
};
const CARD_PRIORITY_TEXT = {
    LOW: 'text-slate-500',
    MEDIUM: 'text-sky-600 dark:text-sky-400',
    HIGH: 'text-amber-600 dark:text-amber-400',
    URGENT: 'text-rose-600 dark:text-rose-400',
};

// Modern card-style project row for the list view (replaces the pill/table
// row). Whole card opens the project; hover reveals edit/delete; a left
// stripe + status dot encode state without pills.
function ProjectCard({
    project,
    columns = {},
    isAdmin = false,
    canManage = false,
    findProjectPriority,
    findProjectStatus,
    selected = false,
    onToggleSelect,
    reorderEnabled = false,
    dragging = false,
    onDragStartRow,
    onDropRow,
    pinHook,
    onOpen,
    onEdit,
    onDelete,
}) {
    const pct = taskProgress(project);
    const hasTasks = (project.totalTasks || 0) > 0;
    // Prefer the admin-managed status (label + color token) so custom
    // statuses render their own colour. The static CARD_STATUS_TONE map
    // is only a last resort for the built-in keys before the admin list
    // resolves / when no colour is set.
    const statusMeta = findProjectStatus?.(project.status);
    const stripe = statusMeta?.color
        ? labelColorSwatch(statusMeta.color)
        : CARD_STATUS_TONE[project.status] || 'bg-slate-400';
    const statusLabel = statusMeta?.label || project.status || '—';
    const priorityLabel =
        findProjectPriority?.(project.priority)?.label ||
        PROJECT_PRIORITY_MAP[project.priority]?.label ||
        project.priority;
    // Which fields to show is driven by the shared Columns/Fields picker.
    const col = (id) => Boolean(columns[id]);
    const fmt = (d) => (d ? format(new Date(d), 'd MMM yyyy') : null);
    const owner = project.owner;
    const reporter = project.reporter;
    const client = project.clientRecord?.name || project.client;
    const tPct = timeProgress(project.startDate, project.endDate);
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={(e) => {
                if (e.key === 'Enter') onOpen?.();
            }}
            draggable={reorderEnabled}
            onDragStart={onDragStartRow}
            onDragOver={
                reorderEnabled ? (e) => e.preventDefault() : undefined
            }
            onDrop={onDropRow}
            className={cn(
                'group flex min-h-[96px] cursor-pointer overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md hover:ring-1 hover:ring-primary/30 dark:border-white/10',
                selected && 'ring-2 ring-primary',
                dragging && 'opacity-50',
            )}
        >
            {/* Left banner: status colour with the status label set
                vertically (like a spine), so state reads at a glance. */}
            <div
                className={cn(
                    'relative flex w-8 shrink-0 items-center justify-center',
                    stripe,
                )}
            >
                {col('status') && (
                    <span className="rotate-180 whitespace-nowrap px-1 text-[10px] font-semibold uppercase tracking-wider text-white [writing-mode:vertical-rl]">
                        {statusLabel}
                    </span>
                )}
            </div>

            <div className="min-w-0 flex-1 p-3 sm:p-4">
                    {project.code && (
                        <div className="mb-1 text-[11px] text-muted-foreground">
                            <span className="uppercase tracking-wide">
                                Project code:
                            </span>{' '}
                            <span className="font-mono">{project.code}</span>
                        </div>
                    )}

                    {/* Name row — grip, checkbox, pin, type icon, name. */}
                    <div className="flex items-center gap-2">
                        {reorderEnabled && (
                            <GripVertical
                                className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground/50"
                                onClick={(e) => e.stopPropagation()}
                            />
                        )}
                        {isAdmin && (
                            <input
                                type="checkbox"
                                checked={selected}
                                onClick={(e) => e.stopPropagation()}
                                onChange={onToggleSelect}
                                className="h-4 w-4 shrink-0 rounded border-border accent-primary"
                                aria-label="Select project"
                            />
                        )}
                        {pinHook && (
                            <PinButton
                                kind="PROJECT"
                                refId={project.id}
                                variant="pin"
                                size="xs"
                                pinHookOverride={pinHook}
                                offLabel="Pin this project"
                                onLabel="Unpin this project"
                            />
                        )}
                        <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-[15px] font-semibold">
                            {project.name}
                        </span>
                        {project.isPersonal && (
                            <span
                                className="inline-flex shrink-0 items-center rounded-full border border-purple-300 bg-purple-100 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-purple-700 dark:border-purple-500/40 dark:bg-purple-500/15 dark:text-purple-200"
                                title="Personal project — visible only to you"
                            >
                                Personal
                            </span>
                        )}
                        {canManage && (
                            <span className="ml-auto flex shrink-0 items-center gap-1">
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEdit?.();
                                    }}
                                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                                    title="Edit project"
                                    aria-label="Edit project"
                                >
                                    <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDelete?.();
                                    }}
                                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                                    title="Delete project"
                                    aria-label="Delete project"
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </span>
                        )}
                    </div>

                    {/* Meta — each field labelled so it's clear what's what. */}
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                        {col('priority') && priorityLabel && (
                            <span
                                className={cn(
                                    'inline-flex items-center gap-1',
                                    CARD_PRIORITY_TEXT[project.priority] ||
                                        'text-muted-foreground',
                                )}
                            >
                                <Flag className="h-3.5 w-3.5" />
                                {priorityLabel}
                            </span>
                        )}
                        {col('projectType') && project.projectType?.name && (
                            <span className="inline-flex items-center gap-1 text-muted-foreground">
                                <Package className="h-3.5 w-3.5" />
                                {project.projectType.name}
                            </span>
                        )}
                        {col('phase') && project.phase && (
                            <span className="text-muted-foreground">
                                <span className="font-medium text-foreground/80">
                                    Phase:
                                </span>{' '}
                                {project.phase}
                            </span>
                        )}
                        {col('client') && client && (
                            <span className="text-muted-foreground">
                                <span className="font-medium text-foreground/80">
                                    Client:
                                </span>{' '}
                                {client}
                            </span>
                        )}
                        {col('country') && project.country && (
                            <span className="text-muted-foreground">
                                <span className="font-medium text-foreground/80">
                                    Country:
                                </span>{' '}
                                {project.country}
                            </span>
                        )}
                        {col('crmId') && project.crmId && (
                            <span className="text-muted-foreground">
                                <span className="font-medium text-foreground/80">
                                    CRM ID:
                                </span>{' '}
                                <span className="font-mono">{project.crmId}</span>
                            </span>
                        )}
                        {col('reporter') && reporter && (
                            <span className="text-muted-foreground">
                                <span className="font-medium text-foreground/80">
                                    Reporter:
                                </span>{' '}
                                {reporter.name}
                            </span>
                        )}
                        {col('startDate') && project.startDate && (
                            <span className="text-muted-foreground">
                                <span className="font-medium text-foreground/80">
                                    Start:
                                </span>{' '}
                                {fmt(project.startDate)}
                            </span>
                        )}
                        {col('endDate') && project.endDate && (
                            <span className="text-muted-foreground">
                                <span className="font-medium text-foreground/80">
                                    Due:
                                </span>{' '}
                                {fmt(project.endDate)}
                            </span>
                        )}
                        {col('createdAt') && project.createdAt && (
                            <span className="text-muted-foreground">
                                <span className="font-medium text-foreground/80">
                                    Created:
                                </span>{' '}
                                {fmt(project.createdAt)}
                            </span>
                        )}
                        {col('closedAt') && project.closedAt && (
                            <span className="text-muted-foreground">
                                <span className="font-medium text-foreground/80">
                                    Closed:
                                </span>{' '}
                                {fmt(project.closedAt)}
                            </span>
                        )}
                        {col('label') &&
                            parseProjectLabels(project).map((tag, i) => (
                                <span
                                    key={`${tag.text}-${i}`}
                                    className={cn(
                                        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1',
                                        labelColorClass(tag.color),
                                    )}
                                >
                                    {tag.text}
                                </span>
                            ))}
                    </div>

                    {/* Progress — Time + Task, each on ONE line (label · bar
                        · %) so cards stay short; bars a touch taller. */}
                    {((col('timeProgress') && tPct != null) ||
                        (col('taskProgress') && hasTasks)) && (
                        <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-1.5">
                            {col('timeProgress') && tPct != null && (
                                <div className="flex min-w-[190px] flex-1 items-center gap-2">
                                    <span className="w-10 shrink-0 text-[11px] font-medium text-muted-foreground">
                                        Time
                                    </span>
                                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                                        <div
                                            className="h-full rounded-full bg-sky-500 transition-all"
                                            style={{ width: `${tPct}%` }}
                                        />
                                    </div>
                                    <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                                        {tPct}%
                                    </span>
                                </div>
                            )}
                            {col('taskProgress') && hasTasks && (
                                <div
                                    className="flex min-w-[190px] flex-1 items-center gap-2"
                                    title={`${project.doneTasks || 0} of ${
                                        project.totalTasks || 0
                                    } tasks`}
                                >
                                    <span className="w-10 shrink-0 text-[11px] font-medium text-muted-foreground">
                                        Tasks
                                    </span>
                                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                                        <div
                                            className={cn(
                                                'h-full rounded-full transition-all',
                                                pct >= 100
                                                    ? 'bg-emerald-500'
                                                    : 'bg-primary',
                                            )}
                                            style={{ width: `${pct}%` }}
                                        />
                                    </div>
                                    <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                                        {pct}%
                                    </span>
                                </div>
                            )}
                        </div>
                    )}
                </div>

            {/* Owner — "hero avatar": a large, ringed avatar as the focal
                point, centered, with the name beneath and a small caption.
                Fixed width so every card's right edge lines up; long names
                wrap to two lines then truncate. */}
            {col('owner') && owner && (
                    <div
                        className="flex w-40 shrink-0 flex-col items-center justify-center gap-1.5 self-stretch border-l border-primary/10 bg-gradient-to-b from-primary/[0.06] to-primary/[0.02] px-3 py-3"
                        title={`Owner: ${owner.name || ''}`}
                    >
                        <Avatar className="h-14 w-14 shrink-0 ring-2 ring-primary/30 ring-offset-2 ring-offset-card">
                            {owner.avatarUrl && (
                                <AvatarImage
                                    src={resolveAssetUrl(owner.avatarUrl)}
                                    alt={owner.name || ''}
                                />
                            )}
                            <AvatarFallback className="bg-primary text-base font-semibold text-primary-foreground">
                                {initials(owner.name)}
                            </AvatarFallback>
                        </Avatar>
                        <div className="text-[9px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                            Owner
                        </div>
                        <div className="line-clamp-2 text-center text-[13px] font-semibold leading-tight">
                            {owner.name}
                        </div>
                    </div>
                )}
        </div>
    );
}

function ProjectRow({
    project,
    visibleColumns,
    users = [],
    canManage,
    isAdmin = false,
    inlineEditable = false,
    onInlineSaved,
    projectPriorityList = [],
    findProjectPriority: findProjectPriorityProp,
    projectStatusList = [],
    findProjectStatus: findProjectStatusProp,
    selected = false,
    onToggleSelect,
    zebraTone = 'bg-card',
    onOpen,
    onEdit,
    onDelete,
    pinHook,
    reorderEnabled = false,
    dragging = false,
    onDragStartRow,
    onDropRow,
}) {
    // Fall back to the hook when the parent didn't pass the find
    // helper (kept for the few other callers that still construct
    // ProjectRow directly).
    const { find: findFromHook, list: priorityListFromHook } =
        useProjectPriorities();
    const findProjectPriority = findProjectPriorityProp || findFromHook;
    const priorityList = projectPriorityList?.length
        ? projectPriorityList
        : priorityListFromHook;
    // Same fallback shape as priorities: prefer the list/find passed by
    // the parent, otherwise subscribe to the admin-managed statuses hook
    // (which itself falls back to the static PROJECT_STATUSES constant).
    const { find: findStatusFromHook, list: statusListFromHook } =
        useProjectStatuses();
    const findProjectStatus = findProjectStatusProp || findStatusFromHook;
    const statusList = projectStatusList?.length
        ? projectStatusList
        : statusListFromHook;
    const rowStatuses = useMemo(
        () =>
            filterProjectStatuses(
                statusList,
                Boolean(project.projectType?.hideMarkComplete),
            ),
        [statusList, project.projectType?.hideMarkComplete],
    );
    const tPct = timeProgress(project.startDate, project.endDate);
    const taskPct = taskProgress(project);

    const cells = {
        title: (
            <TableCell className="font-medium">
                <div className="flex min-w-0 items-center gap-2">
                    {pinHook && (
                        <PinButton
                            kind="PROJECT"
                            refId={project.id}
                            variant="pin"
                            size="xs"
                            pinHookOverride={pinHook}
                            offLabel="Pin this project"
                            onLabel="Unpin this project"
                        />
                    )}
                    <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="flex min-w-0 flex-col leading-tight">
                        <span className="line-clamp-1 inline-flex flex-wrap items-center gap-1.5">
                            {project.name}
                            {project.isPersonal && (
                                <span
                                    className="inline-flex items-center rounded-full border border-purple-300 bg-purple-100 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-purple-700 dark:border-purple-500/40 dark:bg-purple-500/15 dark:text-purple-200"
                                    title="Personal project — visible only to you"
                                >
                                    Personal
                                </span>
                            )}
                        </span>
                        {project.code && (
                            <span
                                className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
                                title="Project code"
                            >
                                {project.code}
                            </span>
                        )}
                    </div>
                </div>
            </TableCell>
        ),
        status: (
            <TableCell>
                <InlineStatusCell
                    project={project}
                    statuses={rowStatuses}
                    findStatus={findProjectStatus}
                    fallbackMap={PROJECT_STATUS_MAP}
                    editable={inlineEditable}
                    onSaved={onInlineSaved}
                />
            </TableCell>
        ),
        priority: (
            <TableCell>
                <InlinePriorityCell
                    project={project}
                    priorities={priorityList}
                    findPriority={findProjectPriority}
                    fallbackMap={PROJECT_PRIORITY_MAP}
                    editable={inlineEditable}
                    onSaved={onInlineSaved}
                />
            </TableCell>
        ),
        timeProgress: (
            <TableCell>
                {tPct == null ? (
                    <span className="text-xs text-muted-foreground">
                        Set start &amp; end
                    </span>
                ) : (
                    (() => {
                        // Local block keeps the row tidy. Once tasks are
                        // 100 % done the bar flips green even past the
                        // deadline, and the caption shows "X days left
                        // of Y" / "X overdue" so the user has both the
                        // bar and the absolute number at a glance. We
                        // anchor the countdown to the project's start
                        // (not "now") so it can never exceed the total
                        // span before work has even begun.
                        const remaining = daysRemainingFromStart(
                            project.startDate,
                            project.endDate,
                        );
                        const total = durationInDays(
                            project.startDate,
                            project.endDate,
                        );
                        const remainingLabel = timeRemainingLabel(
                            remaining,
                            total,
                        );
                        const tasksDone =
                            typeof taskPct === 'number' && taskPct >= 100;
                        return (
                            <div className="flex flex-col gap-1">
                                <div className="flex items-center gap-2">
                                    <Progress
                                        value={tPct}
                                        className="h-2.5 w-36"
                                        indicatorClassName={timeProgressColorClass(
                                            tPct,
                                            taskPct,
                                        )}
                                    />
                                    <span
                                        className={cn(
                                            'text-xs font-medium',
                                            timeProgressTextClass(
                                                tPct,
                                                taskPct,
                                            ),
                                        )}
                                    >
                                        {tPct}%
                                    </span>
                                </div>
                                {remainingLabel && (
                                    <span
                                        className={cn(
                                            'text-[10px] font-medium',
                                            tasksDone
                                                ? 'text-emerald-600'
                                                : timeProgressTextClass(
                                                      tPct,
                                                      taskPct,
                                                  ),
                                        )}
                                    >
                                        {tasksDone
                                            ? `Completed · ${remainingLabel}`
                                            : remainingLabel}
                                    </span>
                                )}
                            </div>
                        );
                    })()
                )}
            </TableCell>
        ),
        taskProgress: (
            <TableCell>
                <div className="flex items-center gap-2">
                    <Progress value={taskPct} className="h-2.5 w-36" />
                    <span className="text-xs text-muted-foreground">{taskPct}%</span>
                </div>
            </TableCell>
        ),
        phase: (
            <TableCell>
                <InlinePhaseCell
                    project={project}
                    editable={inlineEditable}
                    onSaved={onInlineSaved}
                />
            </TableCell>
        ),
        label: (
            <TableCell>
                {(() => {
                    const tags = parseProjectLabels(project);
                    if (tags.length === 0) {
                        return <span className="text-muted-foreground">—</span>;
                    }
                    return (
                        <div className="flex flex-wrap items-center gap-1">
                            {tags.map((tag, i) => (
                                <span
                                    key={`${tag.text}-${i}`}
                                    className={cn(
                                        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1',
                                        labelColorClass(tag.color),
                                    )}
                                >
                                    {tag.text}
                                </span>
                            ))}
                        </div>
                    );
                })()}
            </TableCell>
        ),
        client: (
            <TableCell className="text-muted-foreground">
                {project.client || '—'}
            </TableCell>
        ),
        country: (
            <TableCell className="text-muted-foreground">
                {project.country || '—'}
            </TableCell>
        ),
        crmId: (
            <TableCell className="text-muted-foreground">
                {project.crmId || '—'}
            </TableCell>
        ),
        projectType: (
            <TableCell>
                {project.projectType?.name ? (
                    <span className="inline-flex items-center rounded-full border bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        {project.projectType.name}
                    </span>
                ) : (
                    <span className="text-muted-foreground">—</span>
                )}
            </TableCell>
        ),
        startDate: (
            <TableCell>
                <InlineDateCell
                    project={project}
                    field="startDate"
                    editable={inlineEditable}
                    onSaved={onInlineSaved}
                />
            </TableCell>
        ),
        endDate: (
            <TableCell>
                <InlineDateCell
                    project={project}
                    field="endDate"
                    editable={inlineEditable}
                    onSaved={onInlineSaved}
                />
            </TableCell>
        ),
        owner: (
            <TableCell>
                {inlineEditable ? (
                    <InlinePersonCell
                        project={project}
                        field="ownerId"
                        users={users}
                        editable
                        onSaved={onInlineSaved}
                    />
                ) : (
                    <PersonCell person={project.owner} />
                )}
            </TableCell>
        ),
        reporter: (
            <TableCell>
                {inlineEditable ? (
                    <InlinePersonCell
                        project={project}
                        field="reporterId"
                        users={users}
                        editable
                        allowUnassigned
                        onSaved={onInlineSaved}
                    />
                ) : (
                    <PersonCell person={project.reporter} />
                )}
            </TableCell>
        ),
        createdAt: (
            <TableCell className="text-muted-foreground">
                {formatDate(project.createdAt)}
            </TableCell>
        ),
        closedAt: (
            <TableCell className="text-muted-foreground">
                {formatDate(project.closedAt)}
            </TableCell>
        ),
    };

    return (
        <TableRow
            // [&_td]:py-1.5 trims the per-cell vertical padding from
            // the default p-3 (12px) down to 6px, so each project row
            // is meaningfully shorter without sacrificing scan-ability.
            className={cn(
                'cursor-pointer transition-colors hover:bg-accent/40 [&_td]:py-1.5',
                zebraTone,
                selected && 'bg-primary/5 hover:bg-primary/10',
                dragging && 'opacity-50',
            )}
            onClick={onOpen}
            onDragOver={
                reorderEnabled
                    ? (e) => e.preventDefault()
                    : undefined
            }
            onDrop={
                reorderEnabled
                    ? (e) => {
                          e.preventDefault();
                          onDropRow?.();
                      }
                    : undefined
            }
        >
            <TableCell
                className={cn(zebraTone, 'px-1')}
                onClick={(e) => e.stopPropagation()}
            >
                <div
                    draggable={reorderEnabled}
                    onDragStart={
                        reorderEnabled ? () => onDragStartRow?.() : undefined
                    }
                    title={
                        reorderEnabled
                            ? 'Drag to reorder'
                            : 'Clear search & filters to reorder'
                    }
                    className={cn(
                        'flex items-center justify-center',
                        reorderEnabled
                            ? 'cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing'
                            : 'cursor-not-allowed text-muted-foreground/30',
                    )}
                >
                    <GripVertical className="h-4 w-4" />
                </div>
            </TableCell>
            {isAdmin && (
                <TableCell
                    className={cn(zebraTone, selected && 'bg-primary/5')}
                    onClick={(e) => e.stopPropagation()}
                >
                    <RowCheckbox
                        checked={selected}
                        onChange={onToggleSelect}
                        label={`Select project ${project.name}`}
                    />
                </TableCell>
            )}
            {visibleColumns.map((col) =>
                cells[col.id] ? cloneElement(cells[col.id], { key: col.id }) : null,
            )}
            <TableCell
                className={cn('sticky right-0', zebraTone)}
                onClick={(e) => e.stopPropagation()}
            >
                {canManage ? (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                            >
                                <MoreHorizontal className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={onEdit}>
                                <Pencil className="h-4 w-4" />
                                Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={onDelete}
                            >
                                <Trash2 className="h-4 w-4" />
                                Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : null}
            </TableCell>
        </TableRow>
    );
}

function PersonCell({ person }) {
    if (!person) return <span className="text-muted-foreground">—</span>;
    return (
        <div className="flex items-center gap-2">
            <Avatar className="h-6 w-6">
                {person.avatarUrl && (
                    <AvatarImage
                        src={resolveAssetUrl(person.avatarUrl)}
                        alt={person.name}
                    />
                )}
                <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                    {initials(person.name)}
                </AvatarFallback>
            </Avatar>
            <span className="text-sm">{person.name}</span>
        </div>
    );
}

// Inline three-state checkbox for the table header. Empty when nothing
// in the visible list is selected, fully checked when every visible row
// is selected, and indeterminate when only some are.
function SelectAllCheckbox({ filtered, selectedIds, setSelectedIds }) {
    const visible = filtered.length;
    const selectedVisible = filtered.reduce(
        (n, p) => (selectedIds.has(p.id) ? n + 1 : n),
        0,
    );
    const allSelected = visible > 0 && selectedVisible === visible;
    const someSelected = selectedVisible > 0 && !allSelected;

    const onClick = (e) => {
        e.stopPropagation();
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (allSelected) {
                for (const p of filtered) next.delete(p.id);
            } else {
                for (const p of filtered) next.add(p.id);
            }
            return next;
        });
    };

    return (
        <button
            type="button"
            onClick={onClick}
            title={
                allSelected
                    ? 'Clear selection of visible projects'
                    : someSelected
                      ? 'Select all visible projects'
                      : 'Select all visible projects'
            }
            aria-checked={
                allSelected ? 'true' : someSelected ? 'mixed' : 'false'
            }
            role="checkbox"
            className={cn(
                'flex h-4 w-4 items-center justify-center rounded border transition-colors',
                allSelected || someSelected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted-foreground/40 bg-background hover:border-primary',
            )}
        >
            {allSelected ? (
                <Check className="h-3 w-3" />
            ) : someSelected ? (
                <Minus className="h-3 w-3" />
            ) : null}
        </button>
    );
}

// Per-row checkbox. Kept as a button (not a real <input>) so we can
// fully control the visual + ignore the row's `onClick` open handler
// via the parent cell's stopPropagation.
function RowCheckbox({ checked, onChange, label }) {
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={checked ? 'true' : 'false'}
            aria-label={label}
            onClick={(e) => {
                e.stopPropagation();
                onChange?.();
            }}
            className={cn(
                'flex h-4 w-4 items-center justify-center rounded border transition-colors',
                checked
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted-foreground/40 bg-background hover:border-primary',
            )}
        >
            {checked && <Check className="h-3 w-3" />}
        </button>
    );
}
