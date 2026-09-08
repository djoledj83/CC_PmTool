import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
    Check,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    ChevronUp,
    ChevronsDownUp,
    ChevronsUpDown,
    Clock,
    Eye,
    EyeOff,
    GitBranch,
    Layers,
    Loader2,
    Lock,
    Maximize2,
    Copy,
    MessageSquare,
    MessageSquareOff,
    MessageSquarePlus,
    Paperclip,
    Pencil,
    Plus,
    RefreshCw,
    Trash2,
    User as UserIcon,
    UserCog,
    XCircle,
} from 'lucide-react';

import { api } from '@/lib/api';
import { useRealtime } from '@/contexts/RealtimeContext';
import { useTaskPriorities } from '@/lib/priorities';
import { useTaskStatuses } from '@/lib/statuses';
import {
    TASK_PRIORITIES,
    TASK_PRIORITY_MAP,
    TASK_STATUSES,
    TASK_STATUS_MAP,
} from '@/lib/constants';
import { cn, flashDeepLinkTarget, initials, resolveAssetUrl, markDeepLinkHandled, wasDeepLinkHandled } from '@/lib/utils';
import { spotlightElement } from '@/lib/spotlight';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { MentionTextarea } from '@/components/MentionTextarea';
import { SearchableSelect } from '@/components/SearchableSelect';
import { PlanActivities } from '@/components/PlanActivities';
import {
    NoteAttachmentsField,
    NoteAttachmentsList,
    isImageFile,
} from '@/components/NoteAttachments';
import { ImageLightbox } from '@/components/ImageLightbox';
import LogTimeDialog from '@/components/LogTimeDialog';
import TaskQuickViewDialog from '@/components/TaskQuickViewDialog';
import { ConfirmDeleteDialog } from '@/components/ConfirmDeleteDialog';
import { Tip } from '@/components/Tip';
import { PinButton } from '@/components/PinButton';
import { usePins } from '@/hooks/usePins';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

const NO_ASSIGNEE = '__none__';
const NO_PHASE = '__nophase__';

// Small round avatar used inside assignee dropdowns (SearchableSelect
// option icons + the selected value).
function UserAvatar({ user, className }) {
    if (!user) return null;
    return (
        <Avatar className={cn('h-5 w-5 shrink-0', className)}>
            {user.avatarUrl && (
                <AvatarImage
                    src={resolveAssetUrl(user.avatarUrl)}
                    alt={user.name || ''}
                />
            )}
            <AvatarFallback className="bg-primary/10 text-[8px] text-primary">
                {initials(user.name || user.email || '?')}
            </AvatarFallback>
        </Avatar>
    );
}

// Phase colors. We use a *saturated* header band (e.g. bg-sky-200) plus
// a darker accent bar and matching column-header band so each phase
// reads as a clearly different chunk even with many phases on screen.
// Tuned for both light and dark mode — solid, not washed out.
const PHASE_PALETTE = [
    {
        bar: 'bg-sky-600',
        header:
            'bg-sky-200 text-sky-900 dark:bg-sky-500/40 dark:text-sky-50',
        ring: 'ring-sky-500/80 dark:ring-sky-400/60',
        column:
            'bg-sky-100 text-sky-800 dark:bg-sky-500/25 dark:text-sky-100',
    },
    {
        bar: 'bg-emerald-600',
        header:
            'bg-emerald-200 text-emerald-900 dark:bg-emerald-500/40 dark:text-emerald-50',
        ring: 'ring-emerald-500/80 dark:ring-emerald-400/60',
        column:
            'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/25 dark:text-emerald-100',
    },
    {
        bar: 'bg-violet-600',
        header:
            'bg-violet-200 text-violet-900 dark:bg-violet-500/40 dark:text-violet-50',
        ring: 'ring-violet-500/80 dark:ring-violet-400/60',
        column:
            'bg-violet-100 text-violet-800 dark:bg-violet-500/25 dark:text-violet-100',
    },
    {
        bar: 'bg-amber-600',
        header:
            'bg-amber-200 text-amber-900 dark:bg-amber-500/40 dark:text-amber-50',
        ring: 'ring-amber-500/80 dark:ring-amber-400/60',
        column:
            'bg-amber-100 text-amber-800 dark:bg-amber-500/25 dark:text-amber-100',
    },
    {
        bar: 'bg-rose-600',
        header:
            'bg-rose-200 text-rose-900 dark:bg-rose-500/40 dark:text-rose-50',
        ring: 'ring-rose-500/80 dark:ring-rose-400/60',
        column:
            'bg-rose-100 text-rose-800 dark:bg-rose-500/25 dark:text-rose-100',
    },
    {
        bar: 'bg-cyan-600',
        header:
            'bg-cyan-200 text-cyan-900 dark:bg-cyan-500/40 dark:text-cyan-50',
        ring: 'ring-cyan-500/80 dark:ring-cyan-400/60',
        column:
            'bg-cyan-100 text-cyan-800 dark:bg-cyan-500/25 dark:text-cyan-100',
    },
    {
        bar: 'bg-fuchsia-600',
        header:
            'bg-fuchsia-200 text-fuchsia-900 dark:bg-fuchsia-500/40 dark:text-fuchsia-50',
        ring: 'ring-fuchsia-500/80 dark:ring-fuchsia-400/60',
        column:
            'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-500/25 dark:text-fuchsia-100',
    },
    {
        bar: 'bg-lime-600',
        header:
            'bg-lime-200 text-lime-900 dark:bg-lime-500/40 dark:text-lime-50',
        ring: 'ring-lime-500/80 dark:ring-lime-400/60',
        column:
            'bg-lime-100 text-lime-800 dark:bg-lime-500/25 dark:text-lime-100',
    },
];

// "Unphased" sits outside the palette so it always looks neutral.
const UNPHASED_THEME = {
    bar: 'bg-muted-foreground/40',
    header: 'bg-muted text-muted-foreground',
    ring: 'ring-muted-foreground/20',
    column: 'bg-muted/60 text-muted-foreground',
};

// Token -> palette index. Lets us resolve an admin-picked colour
// (stored on Phase / PhaseTemplate as just "sky" / "emerald" / …)
// back into the full palette entry above. Order matches PHASE_PALETTE
// so adding a new colour to the palette only requires adding the
// token here too.
const PHASE_COLOR_TOKEN_INDEX = {
    sky: 0,
    emerald: 1,
    violet: 2,
    amber: 3,
    rose: 4,
    cyan: 5,
    fuchsia: 6,
    lime: 7,
};

// Tiny string hash (DJB2-style) — enough to deterministically map a
// phase id to a palette slot without bringing in a crypto dep. It
// must be:
//   1. stable across reloads — so a phase always carries the same
//      colour even after we reorder, archive, or rename siblings;
//   2. distribution-friendly — `% palette.length` collisions are
//      acceptable, but consecutive ids should land in different
//      slots so neighbouring phases stand apart visually;
//   3. cheap — we run it once per phase per render.
function phaseColorSeed(id) {
    if (!id) return 0;
    let h = 5381;
    for (let i = 0; i < id.length; i += 1) {
        h = ((h << 5) + h + id.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

function themeForPhase(phase) {
    if (phase._virtual) return UNPHASED_THEME;
    // Admin-picked colour takes precedence — that's the whole point
    // of letting templates carry a colour: it should "stick" to the
    // resulting phase. Fall back to the deterministic hash so legacy
    // rows without a colour token still get a stable visual.
    const token = phase.color ? String(phase.color).toLowerCase() : null;
    if (token && PHASE_COLOR_TOKEN_INDEX[token] !== undefined) {
        return PHASE_PALETTE[PHASE_COLOR_TOKEN_INDEX[token]];
    }
    return PHASE_PALETTE[phaseColorSeed(phase.id) % PHASE_PALETTE.length];
}

function formatDate(d) {
    if (!d) return null;
    return format(new Date(d), 'MMM d, yyyy');
}

// Single source of truth for the task/subtask grid layout. Headers use the
// SAME template so every label sits directly above its matching column,
// regardless of how wide the values inside it are.
//   col 1: expand chevron (40px)
//   col 2: done checkbox (40px)
//   col 3: title + description (flex)
//   col 4: due (140px)
//   col 5: status (130px)
//   col 6: priority (110px)
//   col 7: assignee (180px)
//   col 8: actions (FIXED 184px, right-anchored)
// NOTE: every row and the header are SEPARATE grid containers. The
// actions column must be a fixed width (not `auto`/`minmax(_,auto)`),
// otherwise rows with more action icons resolve a wider actions column,
// which shrinks the 1fr Task column and shifts Due/Status/Priority/
// Assignee left relative to the header. A fixed width keeps the 1fr
// column identical across the header and every data row, so the columns
// line up perfectly.
const TASK_GRID_COLS =
    'grid-cols-[40px_40px_minmax(0,1fr)_140px_130px_110px_180px_184px]';

// Shared cell wrapper class. Rendering each cell as a stretched flex
// container means the column dividers (`border-r`) span the full row
// height instead of just the inline content, which is what gives the
// task list a real "table" look. `align` chooses the horizontal text
// alignment per column.
function cellCls(align = 'center') {
    const justify =
        align === 'left'
            ? 'justify-start'
            : align === 'right'
                ? 'justify-end'
                : 'justify-center';
    return cn(
        'flex items-center border-r border-border/40 px-2 py-1 last:border-r-0',
        justify,
    );
}

// Compact priority dropdown shown inline on a task row. Reads from the
// admin-managed PriorityOption table so labels/colors stay in sync.
function PriorityRowSelect({ value, onChange, fallbackPriority }) {
    const { list, find } = useTaskPriorities();
    const current = find(value) || fallbackPriority;
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent px-1 text-xs">
                <Badge variant={current.badge} className="text-[10px]">
                    {current.label}
                </Badge>
            </SelectTrigger>
            <SelectContent>
                {list.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                        {p.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

// Full-width priority dropdown for the task create/edit dialog.
function PriorityFormSelect({ value, onChange }) {
    const { list } = useTaskPriorities();
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {list.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                        {p.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

// Compact status dropdown shown inline on a task row. Reads from the
// admin-managed StatusOption table (TASK scope) so labels/colors stay
// in sync; falls back to the static constant while the list loads.
function StatusRowSelect({ value, onChange, fallbackStatus }) {
    const { list, find } = useTaskStatuses();
    const options = list.length ? list : TASK_STATUSES;
    const current = find(value) || fallbackStatus;
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent px-1 text-xs">
                <Badge variant={current.badge} className="text-[10px]">
                    {current.label}
                </Badge>
            </SelectTrigger>
            <SelectContent>
                {options.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                        {s.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

// Full-width status dropdown for the task create/edit dialog.
function StatusFormSelect({ value, onChange }) {
    const { list } = useTaskStatuses();
    const options = list.length ? list : TASK_STATUSES;
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {options.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                        {s.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function dateToInput(d) {
    if (!d) return '';
    return new Date(d).toISOString().slice(0, 10);
}

function dateFromInput(v) {
    return v ? new Date(v).toISOString() : null;
}

export function PhasesPlan({
    projectId,
    projectName = null,
    phases: initialPhases,
    tasks: initialTasks,
    activities: initialActivities = [],
    users = [],
    // `canManage` controls task / subtask actions (add, edit, delete,
    // reorder, change priority/assignee/etc.). It's TRUE for both
    // ADMIN and MANAGER roles, AND for users granted ANY of the three
    // `task:*:any` capability checkboxes.
    canManage = false,
    // Narrower flag — true ONLY when the user can actually EDIT
    // existing tasks (admin / manager / personal project owner /
    // holder of `task:edit:any`). A user with just `task:create:any`
    // can press "Add task" but must NOT be routed into the edit
    // dialog when they click a task title — they get the read-only
    // quick-view instead. Defaults to `canManage` for backward
    // compatibility with callers that don't pass it.
    canEditTask = canManage,
    // Mirror of `canEditTask` but for the Delete button (admin /
    // manager / personal owner / `task:delete:any`). Falls back to
    // `canManage` so older callers keep the previous behaviour.
    canDeleteTask = canManage,
    // `canManagePhases` controls phase-level actions (add phase, edit
    // phase, delete phase, reorder phases). Phases describe the
    // project's structure, so this is ADMIN-only. Defaults to
    // `canManage` for backward compatibility with existing callers.
    canManagePhases = canManage,
    // `canManageOwnTasks` is TRUE when the user holds the
    // `task:create:any` capability checkbox. Combined with each
    // task's `createdBy` field this lets the row decide on a
    // per-task basis whether to expose the Edit / Delete buttons
    // for tasks the current user created — without granting them
    // blanket edit-any / delete-any rights across the project.
    canManageOwnTasks = false,
    // TRUE when the current user may approve "specific" tasks (Admin,
    // Manager, or `task:approve` capability holder). Passed straight
    // through to the quick-view dialog to gate its Approve button.
    canApprove = false,
    // TRUE when the current user may RAISE "specific" (approval-required)
    // tasks (Admin, Manager, or `task:specific:create` holder). Gates the
    // "Specific (needs approval)" toggle in the task dialog.
    canCreateSpecific = false,
    // One-shot pulse trigger from a notification click.
    // Shape: `{ taskId, nonce }`. ProjectDetail bumps `nonce` on
    // every notification-bell click that resolves to a task on
    // this project; TaskRow reacts by flashing a ring animation
    // for ~3s. Because we look at the (id, nonce) pair rather
    // than just the id, the same task pulses AGAIN if the user
    // clicks the same notification twice.
    pulseTask = null,
    currentUserId = null,
    // When set, every task created from this plan view is auto-scoped
    // to this Change Request (its `changeRequestId` is stamped on
    // create). Used when PhasesPlan is rendered inside a CR detail
    // page — there, the user is operating within the CR's scope and
    // can't accidentally drop tasks at project-level. Existing tasks
    // are NOT filtered here — the parent decides what to pass in via
    // `tasks` prop. NULL means "ordinary project-level plan view".
    changeRequestId = null,
    onChanged,
}) {
    const [phases, setPhases] = useState(initialPhases || []);
    const [tasks, setTasks] = useState(initialTasks || []);
    const [activities, setActivities] = useState(initialActivities || []);
    const [collapsed, setCollapsed] = useState(() => new Set());
    const [expandedTasks, setExpandedTasks] = useState(() => new Set());
    const [taskDialog, setTaskDialog] = useState({
        open: false,
        phaseId: null,
        task: null,
        parentTask: null,
    });
    const [phaseDialog, setPhaseDialog] = useState({ open: false, phase: null });
    const [participants, setParticipants] = useState([]);
    // Quick "leave a note on this task/subtask" dialog, opened from the
    // task row. The note is created via POST /notes with the taskId pinned.
    const [noteDialog, setNoteDialog] = useState({ open: false, task: null });
    // Quick "log time on this task/subtask" dialog, opened from the
    // task row's clock button. The entry is created via POST /time with
    // the task + project pre-filled — same path as the Time Tracking page.
    const [logTimeDialog, setLogTimeDialog] = useState({
        open: false,
        task: null,
    });
    // Quick-view dialog — opened when the user clicks a task title
    // without manage rights. Shows task details + tabbed note/log-time
    // forms. Default tab is 'logtime' because logging time is the more
    // common reason a row gets opened (notes have their own dedicated
    // icon next to the row and a smaller dedicated modal); the action
    // icons can still pass tab="note" explicitly to bias the dialog
    // the other way when needed.
    const [quickViewDialog, setQuickViewDialog] = useState({ open: false, task: null, tab: 'logtime' });
    const openTaskDialog = (task, tab = 'logtime') =>
        setQuickViewDialog({ open: true, task, tab });
    // Map from taskId -> latest pending TaskReassignment row, so we can
    // surface a small "Reassign requested" badge on rows that already
    // have an open proposal (and disable the Propose button).
    const [pendingReassignments, setPendingReassignments] = useState(
        () => new Map(),
    );
    // Recently-decided reassignment for the current user (proposer or
    // previous assignee). Lets us surface the reviewer's decision note
    // inline on the task so the requester actually sees the feedback.
    // Keyed by taskId.
    const [recentDecisions, setRecentDecisions] = useState(() => new Map());
    const [reassignDialog, setReassignDialog] = useState({
        open: false,
        task: null,
    });

    // Live-updates: pending broadcasts received since the user last
    // reloaded. We surface them as a small badge + "Reload" button at
    // the top of the plan so concurrent edits from another browser tab
    // / colleague are never silently lost.
    const [pendingChanges, setPendingChanges] = useState([]);
    const [reloading, setReloading] = useState(false);
    // After `onChanged()` (parent refetch), pull fresh phases/tasks from props.
    // CR-scoped views filter tasks in the parent — we can't refetch locally.
    const [syncFromParent, setSyncFromParent] = useState(false);
    const { joinProject, leaveProject, subscribe } = useRealtime();

    // View toggles, persisted per-project in localStorage so switching
    // tabs doesn't lose the user's preference. Declared AFTER
    // `pendingChanges` because the task-notes effect below depends on
    // its length, and a TDZ reference would crash the component.
    //
    // We track THREE things here:
    //   - `hideCompleted` / `showTaskNotes`: the project-wide globals
    //     that the toolbar switches drive. They act as the default for
    //     every phase.
    //   - `phaseOverrides`: a Map<phaseId, { hideCompleted?: boolean,
    //     showTaskNotes?: boolean }>. Each entry records an explicit
    //     override for a single phase. When a phase has no entry (or
    //     no entry for a specific key) it INHERITS the global value,
    //     so flipping the global toolbar still affects every phase
    //     that hasn't been customized — CSS-cascade style. This is
    //     what lets the user say "hide completed everywhere except in
    //     phase X" or "show task notes only in phase Y".
    const viewPrefKey = projectId ? `pm.plan.view.${projectId}` : null;
    const [hideCompleted, setHideCompleted] = useState(false);
    const [showTaskNotes, setShowTaskNotes] = useState(false);
    // Individual tasks the user has expanded notes for (independent of
    // the global / per-phase "Show task notes" toggles). Lets you read
    // one task's notes without flooding the whole plan.
    const [openNoteTaskIds, setOpenNoteTaskIds] = useState(() => new Set());
    const toggleTaskNotes = useCallback(
        (taskId, hasSubtasks = false) => {
            const turningOn = !openNoteTaskIds.has(taskId);
            setOpenNoteTaskIds((prev) => {
                const next = new Set(prev);
                if (turningOn) next.add(taskId);
                else next.delete(taskId);
                return next;
            });
            // Only auto-expand/collapse the subtask tree when the task
            // ACTUALLY has subtasks — otherwise toggling notes would pop
            // an empty "No subtasks yet" block, which looks like a bug.
            // The left chevron remains the way to show/hide subtasks.
            if (hasSubtasks) {
                setExpandedTasks((prev) => {
                    const next = new Set(prev);
                    if (turningOn) next.add(taskId);
                    else next.delete(taskId);
                    return next;
                });
            }
        },
        [openNoteTaskIds],
    );
    // Reassignment info (the amber "Reassign requested" pill on a row
    // and the green/rose decision banner beneath it) defaults to ON
    // because those badges actually signal pending work to reviewers —
    // hiding them silently would be a regression. The toolbar toggle
    // lets a user clean up the plan view when they don't need to see
    // them, and the per-phase override lets them hide them only in
    // phases that don't matter (e.g. completed phases).
    const [showReassignmentInfo, setShowReassignmentInfo] = useState(true);
    const [phaseOverrides, setPhaseOverrides] = useState(() => new Map());
    useEffect(() => {
        if (!viewPrefKey) return;
        try {
            const raw = localStorage.getItem(viewPrefKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (typeof parsed.hideCompleted === 'boolean') {
                setHideCompleted(parsed.hideCompleted);
            }
            if (typeof parsed.showTaskNotes === 'boolean') {
                setShowTaskNotes(parsed.showTaskNotes);
            }
            if (typeof parsed.showReassignmentInfo === 'boolean') {
                setShowReassignmentInfo(parsed.showReassignmentInfo);
            }
            // Older localStorage entries don't have phaseOverrides at
            // all — treat that as "no overrides yet" rather than an
            // error. New entries serialise the Map as a plain object
            // (`Object.fromEntries(map)`); rebuild the Map on load.
            if (parsed.phaseOverrides && typeof parsed.phaseOverrides === 'object') {
                const m = new Map();
                for (const [k, v] of Object.entries(parsed.phaseOverrides)) {
                    if (v && typeof v === 'object') m.set(k, v);
                }
                setPhaseOverrides(m);
            }
        } catch {
            // Ignore malformed localStorage values; the defaults are fine.
        }
    }, [viewPrefKey]);
    useEffect(() => {
        if (!viewPrefKey) return;
        try {
            localStorage.setItem(
                viewPrefKey,
                JSON.stringify({
                    hideCompleted,
                    showTaskNotes,
                    showReassignmentInfo,
                    phaseOverrides: Object.fromEntries(phaseOverrides),
                }),
            );
        } catch {
            // Storage quotas / private mode — non-fatal.
        }
    }, [
        viewPrefKey,
        hideCompleted,
        showTaskNotes,
        showReassignmentInfo,
        phaseOverrides,
    ]);

    // Resolves the effective toggle state for a specific phase.
    // Override wins; missing → global. Memoised so derived useMemos
    // (visibleTopTasksByPhase, visibleSubtasksByParent) get a stable
    // reference and don't re-compute when no relevant state changed.
    const phaseFlags = useCallback(
        (phaseId) => {
            const override = phaseOverrides.get(phaseId);
            return {
                hideCompleted:
                    override && typeof override.hideCompleted === 'boolean'
                        ? override.hideCompleted
                        : hideCompleted,
                showTaskNotes:
                    override && typeof override.showTaskNotes === 'boolean'
                        ? override.showTaskNotes
                        : showTaskNotes,
                showReassignmentInfo:
                    override &&
                    typeof override.showReassignmentInfo === 'boolean'
                        ? override.showReassignmentInfo
                        : showReassignmentInfo,
            };
        },
        [phaseOverrides, hideCompleted, showTaskNotes, showReassignmentInfo],
    );

    // Flip a single key for a phase. We AUTO-CLEAR the override when
    // the new value matches the current global, so the per-phase entry
    // never carries a redundant "this phase agrees with global" record.
    // That keeps the "Reset" link in the phase header hidden until the
    // phase actually deviates from the toolbar default — clicking the
    // eye/notes icon just toggles the phase's visible state without
    // surfacing a Reset affordance for a value that matches global.
    //
    // Trade-off: if a user toggles a phase to match global and THEN
    // flips the global, the phase follows the global change (it's no
    // longer pinned). That matches the mental model "I only care about
    // this phase if it looks different from the rest" — if a user
    // genuinely wants to pin a value, flipping it twice (away and back)
    // is not the path they'd take; they'd leave the override in place.
    const setPhaseOverride = useCallback(
        (phaseId, key, value) => {
            setPhaseOverrides((prev) => {
                let globalValue;
                if (key === 'hideCompleted') globalValue = hideCompleted;
                else if (key === 'showTaskNotes') globalValue = showTaskNotes;
                else if (key === 'showReassignmentInfo')
                    globalValue = showReassignmentInfo;
                const next = new Map(prev);
                const current = { ...(next.get(phaseId) || {}) };
                if (value === globalValue) {
                    delete current[key];
                } else {
                    current[key] = value;
                }
                if (Object.keys(current).length === 0) {
                    next.delete(phaseId);
                } else {
                    next.set(phaseId, current);
                }
                return next;
            });
        },
        [hideCompleted, showTaskNotes, showReassignmentInfo],
    );

    // Clear ALL overrides for a phase (re-inherit the global toolbar).
    const clearPhaseOverrides = useCallback((phaseId) => {
        setPhaseOverrides((prev) => {
            if (!prev.has(phaseId)) return prev;
            const next = new Map(prev);
            next.delete(phaseId);
            return next;
        });
    }, []);

    // True if "show task notes" is on globally OR for any individual
    // phase. We use this as the gate for the notes-fetch effect below
    // so a user who toggles task notes on for a SINGLE phase still
    // gets the inline data loaded (previously the effect only fired
    // when the global was on, leaving per-phase overrides empty).
    const anyShowTaskNotes = useMemo(() => {
        if (showTaskNotes) return true;
        if (openNoteTaskIds.size > 0) return true;
        for (const override of phaseOverrides.values()) {
            if (override?.showTaskNotes === true) return true;
        }
        return false;
    }, [showTaskNotes, phaseOverrides, openNoteTaskIds]);

    // Notes pinned to specific tasks/subtasks. Loaded once per project
    // and refreshed on plan-changed events so the inline preview stays
    // in sync with edits made in the Notes panel. Keyed by taskId ->
    // [note, ...].
    const [taskNotesByTask, setTaskNotesByTask] = useState(() => new Map());
    const [taskNotesLoading, setTaskNotesLoading] = useState(false);
    useEffect(() => {
        if (!projectId || !anyShowTaskNotes) return undefined;
        let cancelled = false;
        setTaskNotesLoading(true);
        api.get('/notes', { params: { projectId } })
            .then((res) => {
                if (cancelled) return;
                const grouped = new Map();
                for (const note of res.data?.notes || []) {
                    if (!note.taskId) continue;
                    if (!grouped.has(note.taskId)) {
                        grouped.set(note.taskId, []);
                    }
                    grouped.get(note.taskId).push(note);
                }
                setTaskNotesByTask(grouped);
            })
            .catch(() => {
                // Silent fail — the panel is a nicety, not critical.
            })
            .finally(() => {
                if (!cancelled) setTaskNotesLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // pendingChanges is intentionally a dep so a remote note added
        // while we're looking at the plan re-fetches the inline list.
    }, [projectId, anyShowTaskNotes, pendingChanges.length]);

    // React-router's `navigate('/projects/X#task-Y')` updates the URL
    // through the History API but does NOT fire a native `hashchange`
    // event, so listening on `window.hashchange` would silently miss
    // notification clicks made while we're already on this page. Using
    // `useLocation().hash` makes the deep-link useEffect re-run for
    // every router-driven hash change. We also keep a window listener
    // for the rare native back/forward hash navigation.
    const location = useLocation();
    const [nativeHashTick, setNativeHashTick] = useState(0);
    useEffect(() => {
        const onHash = () => setNativeHashTick((n) => n + 1);
        window.addEventListener('hashchange', onHash);
        return () => window.removeEventListener('hashchange', onHash);
    }, []);
    const hashTick = `${location.hash}|${nativeHashTick}`;

    // Join the project room while this plan is mounted so the backend
    // pushes us live `project:plan-changed` events. The handler bumps a
    // small "(N) reload" badge — we don't auto-refetch because the user
    // might be mid-edit in a dialog and a silent refetch could blow
    // their work away.
    useEffect(() => {
        if (!projectId) return undefined;
        joinProject(projectId);
        const unsubscribe = subscribe('project:plan-changed', (payload) => {
            // Filter to events for THIS project. The socket only pushes
            // joined-room events, but a stale subscription might still
            // deliver one — be defensive.
            if (payload?.projectId && payload.projectId !== projectId) return;
            // Skip "echo" events for actions the current user just
            // performed in this tab — the local state is already correct.
            if (payload?.actorId && payload.actorId === currentUserId) return;
            setPendingChanges((prev) =>
                [...prev, payload].slice(-20),
            );
        });
        return () => {
            unsubscribe();
            leaveProject(projectId);
        };
    }, [projectId, joinProject, leaveProject, subscribe, currentUserId]);

    const reloadPlan = useCallback(async () => {
        if (reloading || !projectId) return;
        setReloading(true);
        try {
            if (changeRequestId) {
                await onChanged?.();
                setSyncFromParent(true);
            } else {
                const { data } = await api.get(`/projects/${projectId}`);
                const p = data.project;
                setPhases(p.phases || []);
                setTasks(p.tasks || []);
                setActivities(p.activities || []);
                await onChanged?.();
            }
            setPendingChanges([]);
        } catch {
            toast.error('Could not reload plan');
        } finally {
            setReloading(false);
        }
    }, [reloading, projectId, changeRequestId, onChanged]);

    // Friendly summary line for the live-update banner. We show the
    // most recent change verbatim (with actor + kind) and aggregate
    // the rest into a count.
    const latestChange = pendingChanges[pendingChanges.length - 1];
    const pendingSummary = useMemo(() => {
        if (!latestChange) return null;
        const verb = {
            'task-created': 'added a task',
            'subtask-created': 'added a subtask',
            'task-updated': 'updated a task',
            'subtask-updated': 'updated a subtask',
            'task-deleted': 'deleted a task',
            'subtask-deleted': 'deleted a subtask',
            'note-added': 'added a note',
            'note-updated': 'edited a note',
            'note-deleted': 'deleted a note',
        }[latestChange.kind] || 'made a change';
        const actor = latestChange.actorName || 'Someone';
        const more =
            pendingChanges.length > 1
                ? ` · +${pendingChanges.length - 1} more`
                : '';
        const target = latestChange.title
            ? ` "${latestChange.title}"`
            : '';
        return `${actor} ${verb}${target}${more}`;
    }, [latestChange, pendingChanges.length]);

    // Reset local state only when the user navigates to a different project.
    useEffect(() => {
        setPhases(initialPhases || []);
        setTasks(initialTasks || []);
        setActivities(initialActivities || []);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId]);

    // Keep the local activities list in sync when the parent reloads
    // the project (e.g. after a task save). Tasks/phases are owned
    // locally for optimistic edits, except after an explicit Reload
    // (or CR-scoped reload via parent).
    useEffect(() => {
        setActivities(initialActivities || []);
    }, [initialActivities]);

    useEffect(() => {
        if (!syncFromParent) return;
        setPhases(initialPhases || []);
        setTasks(initialTasks || []);
        setActivities(initialActivities || []);
        setSyncFromParent(false);
    }, [syncFromParent, initialPhases, initialTasks, initialActivities]);

    // Deep-link: when the URL ends with `#task-<id>` (e.g. arriving from
    // the Insights dashboard or the My to-do page), scroll the matching
    // row into view and briefly highlight it. If the target is a subtask
    // we expand its parent first so the row actually exists in the DOM.
    //
    // We remember the last hash we handled so subsequent task edits
    // (which mutate `tasks`) don't keep re-scrolling the user back.
    const handledHashRef = useRef(null);
    const deepLinkReloadRef = useRef(null);
    const hashReloadAttemptedRef = useRef(null);
    useEffect(() => {
        const hash = location.hash || '';
        const m = hash.match(/^#task-([^?#/]+)/);
        if (!m) return;
        if (handledHashRef.current === hash) return;

        const pathname = location.pathname;
        if (wasDeepLinkHandled(pathname, hash)) {
            handledHashRef.current = hash;
            return;
        }

        const targetId = m[1];
        const target = tasks.find((t) => t.id === targetId);

        // Subtasks render only when the parent row is expanded. Do this
        // even for notification clicks (`?pulse=`) — otherwise the pulse
        // effect in TaskRow runs before the subtask row exists in the
        // DOM and the user lands on the collapsed parent with nothing
        // highlighted underneath.
        if (target?.parentTaskId) {
            setExpandedTasks((prev) => {
                if (prev.has(target.parentTaskId)) return prev;
                const next = new Set(prev);
                next.add(target.parentTaskId);
                return next;
            });
        }

        // Notification clicks carry `?pulse=` — TaskRow handles
        // scroll + ring animation for those; skip the hash flash so
        // we don't stack two spotlights and three scrollIntoView calls.
        const params = new URLSearchParams(location.search);
        if (params.get('pulse')) return;
        if (!target) {
            if (
                !reloading &&
                deepLinkReloadRef.current !== hash &&
                hashReloadAttemptedRef.current !== hash
            ) {
                hashReloadAttemptedRef.current = hash;
                deepLinkReloadRef.current = hash;
                reloadPlan().finally(() => {
                    deepLinkReloadRef.current = null;
                });
            }
            return;
        }
        hashReloadAttemptedRef.current = null;
        handledHashRef.current = hash;
        markDeepLinkHandled(pathname, hash);

        // Defer the scroll until React has had a chance to render the
        // (possibly newly expanded) target row.
        let cancelHighlight = () => {};
        const t = setTimeout(() => {
            const el = document.getElementById(`task-${targetId}`);
            if (!el) return;
            cancelHighlight = flashDeepLinkTarget(el);
        }, 60);
        return () => {
            clearTimeout(t);
            cancelHighlight();
        };
        // `hashTick` re-runs this when the user clicks a notification
        // while already on this page (which only changes location.hash,
        // not `tasks`). Without it the second click is a no-op.
    }, [tasks, hashTick, reloading, reloadPlan, location.hash, location.search, location.pathname]);

    // Reset the "already handled" flag whenever the project changes so
    // navigating away and back honours the hash again.
    useEffect(() => {
        handledHashRef.current = null;
        hashReloadAttemptedRef.current = null;
    }, [projectId]);

    // Subtasks live inside a collapsible parent — when a notification
    // click pulses a subtask, the row may not even be in the DOM yet
    // because the parent task is collapsed. The hash-driven deep-link
    // handler above already does the expand-then-scroll dance, but it
    // only fires on hash changes; the per-click `?pulse=<ts>` query
    // param changes WITHOUT a hash change, so we need a dedicated
    // effect to keep subtask pulses working after the first click.
    //
    // When `pulseTask.taskId` resolves to a subtask we expand its
    // parent (if not already expanded) and scroll the row into view
    // on the next paint so the `.task-pulse` ring animation in
    // TaskRow has something visible to attach to.
    useEffect(() => {
        if (!pulseTask?.taskId) return;
        const target = tasks.find((t) => t.id === pulseTask.taskId);
        if (!target) {
            if (
                tasks.length > 0 &&
                !reloading &&
                !deepLinkReloadRef.current
            ) {
                reloadPlan();
            }
            return;
        }
        if (target.parentTaskId) {
            setExpandedTasks((prev) => {
                if (prev.has(target.parentTaskId)) return prev;
                const next = new Set(prev);
                next.add(target.parentTaskId);
                return next;
            });
        }
        // Scroll + spotlight are handled once in TaskRow's pulse
        // effect — duplicating them here fought the user's scroll.
    }, [pulseTask?.taskId, pulseTask?.nonce, tasks, reloading, reloadPlan]);

    // Same idea as the task hash effect, but for activities: when the
    // URL is `#activity-<id>` we expand the activity's phase (if it
    // was collapsed) and scroll the row into view with a brief
    // highlight ring.
    const handledActivityHashRef = useRef(null);
    useEffect(() => {
        if (!activities.length) return;
        const hash = window.location.hash;
        const m = hash.match(/^#activity-(.+)$/);
        if (!m) return;
        if (handledActivityHashRef.current === hash) return;
        const target = activities.find((a) => a.id === m[1]);
        if (!target) return;
        handledActivityHashRef.current = hash;

        if (target.phaseId) {
            setCollapsed((prev) => {
                if (!prev.has(target.phaseId)) return prev;
                const next = new Set(prev);
                next.delete(target.phaseId);
                return next;
            });
        }

        let cancelHighlight = () => {};
        const t = setTimeout(() => {
            const el = document.getElementById(`activity-${target.id}`);
            if (!el) return;
            cancelHighlight = flashDeepLinkTarget(el);
        }, 60);
        return () => {
            clearTimeout(t);
            cancelHighlight();
        };
        // (See task hash effect for why hashTick is here.)
    }, [activities, hashTick]);

    useEffect(() => {
        handledActivityHashRef.current = null;
    }, [projectId]);

    // Subtask assignment is restricted to project participants, so we fetch
    // them once per project. The picker degrades gracefully (shows an empty
    // list) if the request fails.
    useEffect(() => {
        let cancelled = false;
        api.get(`/projects/${projectId}/participants`)
            .then((res) => {
                if (!cancelled) setParticipants(res.data.participants || []);
            })
            .catch(() => {
                if (!cancelled) setParticipants([]);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    // Workspace-wide teams. Used as the picker source for the per-phase
    // "+ team" affordance. Fetched once and refreshed on plan changes
    // (cheap; the list is short). Hidden if the caller can't manage.
    const [allTeams, setAllTeams] = useState([]);
    useEffect(() => {
        let cancelled = false;
        if (!canManage) {
            setAllTeams([]);
            return undefined;
        }
        api.get('/teams')
            .then((res) => {
                if (!cancelled) setAllTeams(res.data.teams || []);
            })
            .catch(() => {
                if (!cancelled) setAllTeams([]);
            });
        return () => {
            cancelled = true;
        };
    }, [canManage, pendingChanges.length]);

    // Pending reassignment requests for this project. We re-query on
    // pendingChanges (so live socket events refresh the badge) and
    // whenever the dialog closes (it might have just created one).
    const refreshReassignments = async () => {
        try {
            // Pull both buckets in one round-trip and split client-side.
            // Decided rows are filtered to "involves the current user
            // and was decided in the last 14 days" — older ones quietly
            // age out so the inline banner doesn't linger forever.
            const { data } = await api.get('/reassignments', {
                params: { projectId },
            });
            const pending = new Map();
            const decided = new Map();
            const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
            for (const r of data.reassignments || []) {
                if (!r.taskId) continue;
                if (r.status === 'PENDING') {
                    pending.set(r.taskId, r);
                    continue;
                }
                if (r.status !== 'APPROVED' && r.status !== 'REJECTED') continue;
                const decidedAt = r.decidedAt
                    ? new Date(r.decidedAt).getTime()
                    : 0;
                if (decidedAt < cutoff) continue;
                const involvesMe =
                    currentUserId &&
                    (r.proposerId === currentUserId ||
                        r.fromAssigneeId === currentUserId);
                if (!involvesMe) continue;
                // Keep the most recent decision per task.
                const prev = decided.get(r.taskId);
                if (!prev || (prev.decidedAt || 0) < decidedAt) {
                    decided.set(r.taskId, r);
                }
            }
            setPendingReassignments(pending);
            setRecentDecisions(decided);
        } catch {
            setPendingReassignments(new Map());
            setRecentDecisions(new Map());
        }
    };
    useEffect(() => {
        if (!projectId) return;
        refreshReassignments();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId, pendingChanges.length]);

    // Activities live alongside tasks but render in their own strip
    // beneath each phase. Group them so PlanActivities only sees its
    // phase's slice.
    const activitiesByPhase = useMemo(() => {
        const map = new Map();
        for (const a of activities) {
            const key = a.phaseId || NO_PHASE;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(a);
        }
        return map;
    }, [activities]);

    const refreshActivities = async () => {
        try {
            const { data } = await api.get('/plan-activities', {
                params: { projectId },
            });
            setActivities(data.activities || []);
        } catch {
            // Silent — the next full project reload will recover.
        }
        onChanged?.();
    };

    // Top-level tasks (those without a parent) are grouped by phase. Subtasks
    // are pulled out into a parent->children map and rendered nested under
    // their parent regardless of which phase they technically belong to.
    const { topTasksByPhase, subtasksByParent } = useMemo(() => {
        const byPhase = new Map();
        const byParent = new Map();
        for (const t of tasks) {
            if (t.parentTaskId) {
                if (!byParent.has(t.parentTaskId))
                    byParent.set(t.parentTaskId, []);
                byParent.get(t.parentTaskId).push(t);
            } else {
                const key = t.phaseId || NO_PHASE;
                if (!byPhase.has(key)) byPhase.set(key, []);
                byPhase.get(key).push(t);
            }
        }
        return { topTasksByPhase: byPhase, subtasksByParent: byParent };
    }, [tasks]);

    // Master "Show task notes" switch in the toolbar. It's a reset:
    // flipping it drops every per-phase notes override AND every
    // per-task notes toggle, so the whole plan follows this one switch.
    // Turning it ON also expands every subtask tree (so subtask notes
    // are visible everywhere); turning it OFF collapses them all again.
    const handleGlobalNotesToggle = useCallback(
        (value) => {
            setShowTaskNotes(value);
            setOpenNoteTaskIds(new Set());
            setPhaseOverrides((prev) => {
                const next = new Map();
                for (const [pid, ov] of prev) {
                    const rest = { ...ov };
                    delete rest.showTaskNotes;
                    if (Object.keys(rest).length) next.set(pid, rest);
                }
                return next;
            });
            const parentIds = Array.from(subtasksByParent.keys());
            setExpandedTasks((prev) => {
                if (value) return new Set([...prev, ...parentIds]);
                const next = new Set(prev);
                for (const id of parentIds) next.delete(id);
                return next;
            });
        },
        [subtasksByParent],
    );

    const toggleCollapsed = (id) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleExpandedTask = (id) => {
        setExpandedTasks((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // ----- Phase actions -----
    const openCreatePhase = () => setPhaseDialog({ open: true, phase: null });
    const openEditPhase = (phase) => setPhaseDialog({ open: true, phase });

    const submitPhase = async ({ id, name, color }) => {
        try {
            if (id) {
                // We intentionally only PATCH name + color on rename;
                // we don't expose a colour swatch in the rename dialog
                // yet, so `color` is always null/undefined here today,
                // but we forward it so a future swatch-on-edit
                // affordance lights up without another route trip.
                const patchBody = { name };
                if (color !== undefined) patchBody.color = color;
                const { data } = await api.patch(
                    `/phases/${id}`,
                    patchBody,
                );
                setPhases((prev) =>
                    prev.map((p) => (p.id === id ? { ...p, ...data.phase } : p)),
                );
                toast.success('Phase updated');
            } else {
                const { data } = await api.post('/phases', {
                    projectId,
                    name,
                    color: color || undefined,
                });
                setPhases((prev) => [...prev, data.phase]);
                toast.success('Phase added');
            }
            setPhaseDialog({ open: false, phase: null });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save phase');
        }
    };

    const deletePhase = async (phase) => {
        const used = topTasksByPhase.get(phase.id)?.length || 0;
        const msg = used
            ? `Delete phase "${phase.name}"? ${used} task(s) will become unphased.`
            : `Delete phase "${phase.name}"?`;
        if (!window.confirm(msg)) return;
        try {
            await api.delete(`/phases/${phase.id}`);
            setPhases((prev) => prev.filter((p) => p.id !== phase.id));
            setTasks((prev) =>
                prev.map((t) =>
                    t.phaseId === phase.id ? { ...t, phaseId: null, phase: null } : t,
                ),
            );
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete phase');
        }
    };

    const movePhase = async (phase, direction) => {
        const idx = phases.findIndex((p) => p.id === phase.id);
        const target = idx + direction;
        if (target < 0 || target >= phases.length) return;
        const reordered = [...phases];
        [reordered[idx], reordered[target]] = [reordered[target], reordered[idx]];
        setPhases(reordered);
        try {
            await api.post('/phases/reorder', {
                projectId,
                order: reordered.map((p) => p.id),
            });
        } catch {
            toast.error('Could not reorder');
        }
    };

    // ----- Task / subtask actions -----
    const openCreateTask = (phaseId) =>
        setTaskDialog({ open: true, phaseId, task: null, parentTask: null });
    const openEditTask = (task) =>
        setTaskDialog({
            open: true,
            phaseId: task.phaseId,
            task,
            parentTask: null,
        });
    const openCreateSubtask = (parentTask) => {
        // Make sure the parent shows its newly created subtask.
        setExpandedTasks((prev) => new Set(prev).add(parentTask.id));
        setTaskDialog({
            open: true,
            phaseId: parentTask.phaseId,
            task: null,
            parentTask,
        });
    };

    const submitTask = async (values) => {
        try {
            if (values.id) {
                const { data } = await api.patch(`/tasks/${values.id}`, values.payload);
                setTasks((prev) => prev.map((t) => (t.id === values.id ? data.task : t)));
                toast.success(values.parentTaskId ? 'Subtask updated' : 'Task updated');
            } else {
                const { data } = await api.post('/tasks', {
                    ...values.payload,
                    projectId,
                    // Stamp the CR scope when the plan is rendered
                    // inside a CR context. Subtasks inherit their
                    // parent's CR on the backend so we don't need to
                    // override here for the parentTaskId case.
                    ...(changeRequestId && !values.parentTaskId
                        ? { changeRequestId }
                        : {}),
                });
                setTasks((prev) => [...prev, data.task]);
                toast.success(values.parentTaskId ? 'Subtask added' : 'Task created');
            }
            setTaskDialog({
                open: false,
                phaseId: null,
                task: null,
                parentTask: null,
            });
            onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Save failed');
        }
    };

    const updateTaskField = async (task, patch) => {
        try {
            const { data } = await api.patch(`/tasks/${task.id}`, patch);
            // Mirror the backend's parent → subtasks status cascade in
            // local state so the UI updates without a refresh. The
            // backend returns `affectedSubtasks` listing every subtask
            // it auto-modified (whether the cascade flipped them to
            // DONE on parent completion or restored them to their prior
            // status on parent re-open). We splice each one in.
            const affected = Array.isArray(data.affectedSubtasks)
                ? data.affectedSubtasks
                : [];
            const affectedById = new Map(affected.map((s) => [s.id, s.status]));
            setTasks((prev) =>
                prev.map((t) => {
                    if (t.id === task.id) return data.task;
                    if (affectedById.has(t.id)) {
                        return { ...t, status: affectedById.get(t.id) };
                    }
                    return t;
                }),
            );
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update task');
        }
    };

    const openNoteForTask = (task) =>
        setNoteDialog({ open: true, task });

    // Opens the quick "log time" dialog (rendered at the bottom of the
    // panel alongside the note + reassign dialogs). We pass through to
    // the LogTimeDialog component which handles the POST itself and
    // calls onLogged on success.
    const openLogTimeDialog = (task) =>
        setLogTimeDialog({ open: true, task });

    const submitTaskNote = async ({ content, fileIds }) => {
        const task = noteDialog.task;
        if (!task) return;
        try {
            await api.post('/notes', {
                projectId,
                content,
                taskId: task.id,
                fileIds: fileIds || [],
            });
            toast.success('Note added — see the Notes tab');
            setNoteDialog({ open: false, task: null });
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save note');
        }
    };

    // Deleting a task is checkbox-gated (see ConfirmDeleteDialog) instead
    // of a browser confirm — an accidental click can't wipe work. The
    // task is soft-deleted (restorable from the Activity log) and the
    // backend records who deleted it.
    const [deleteTaskState, setDeleteTaskState] = useState({
        open: false,
        task: null,
    });
    const deleteTask = (task) => setDeleteTaskState({ open: true, task });
    const performDeleteTask = async () => {
        const task = deleteTaskState.task;
        if (!task) return;
        try {
            await api.delete(`/tasks/${task.id}`);
            setTasks((prev) =>
                prev.filter((t) => t.id !== task.id && t.parentTaskId !== task.id),
            );
        } catch {
            toast.error('Could not delete task');
        }
    };

    // Clone a task once (title + " (copy)", status reset to To do). The
    // new copy keeps the same assignee — the user re-points it at whoever
    // should do the same work. Subtasks/notes/time are NOT copied.
    const duplicateTask = async (task) => {
        // Specific tasks can't be duplicated — the backend rejects it
        // with a 400, so we short-circuit for a cleaner message.
        if (task.specific) {
            toast.error("Specific tasks can't be duplicated");
            return;
        }
        try {
            const { data } = await api.post(`/tasks/${task.id}/duplicate`);
            setTasks((prev) => [...prev, data.task]);
            toast.success(
                task.parentTaskId ? 'Subtask duplicated' : 'Task duplicated',
            );
            onChanged?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not duplicate task',
            );
        }
    };

    // Lookup map: top-level task id -> its phase id (or NO_PHASE).
    // Used by the subtask filter below to figure out which phase a
    // given subtask belongs to without re-scanning the full task list.
    const parentTaskPhaseLookup = useMemo(() => {
        const m = new Map();
        for (const t of tasks) {
            if (!t.parentTaskId) m.set(t.id, t.phaseId || NO_PHASE);
        }
        return m;
    }, [tasks]);

    // When "Hide completed" is on, drop top-level tasks and subtasks
    // whose status is DONE. We filter top-level tasks here and the
    // subtask map below so the row tree never even sees them — no
    // empty placeholders, no flicker.
    //
    // The filter now reads `hideCompleted` PER PHASE via `phaseFlags`,
    // so each phase header's override is respected. Phases without
    // an override use the global value (same as before).
    const visibleTopTasksByPhase = useMemo(() => {
        const filtered = new Map();
        for (const [phaseKey, list] of topTasksByPhase.entries()) {
            const { hideCompleted: hideHere } = phaseFlags(phaseKey);
            filtered.set(
                phaseKey,
                hideHere ? list.filter((t) => t.status !== 'DONE') : list,
            );
        }
        return filtered;
    }, [topTasksByPhase, phaseFlags]);

    const visibleSubtasksByParent = useMemo(() => {
        const filtered = new Map();
        for (const [parentId, subs] of subtasksByParent.entries()) {
            const parentPhaseId =
                parentTaskPhaseLookup.get(parentId) || NO_PHASE;
            const { hideCompleted: hideHere } = phaseFlags(parentPhaseId);
            filtered.set(
                parentId,
                hideHere ? subs.filter((s) => s.status !== 'DONE') : subs,
            );
        }
        return filtered;
    }, [subtasksByParent, parentTaskPhaseLookup, phaseFlags]);

    const phaseSections = useMemo(() => {
        const sections = phases.map((p) => ({
            ...p,
            tasks: visibleTopTasksByPhase.get(p.id) || [],
        }));
        const unphased = visibleTopTasksByPhase.get(NO_PHASE);
        if (unphased && unphased.length > 0) {
            sections.push({
                id: NO_PHASE,
                name: 'Unphased',
                tasks: unphased,
                _virtual: true,
            });
        }
        return sections;
    }, [phases, visibleTopTasksByPhase]);

    // Bottom-most real-phase index in phaseSections. Used by the
    // "Move down" arrow on each phase header to disable it on the
    // last real phase — we can't compare against
    // `phaseSections.length - 1` directly because a virtual
    // "Unphased" bucket may live at the very end, and we don't want
    // it to look like the second-to-last real phase still has room
    // to move down.
    const lastRealPhaseIdx = useMemo(() => {
        for (let i = phaseSections.length - 1; i >= 0; i -= 1) {
            if (!phaseSections[i]._virtual) return i;
        }
        return -1;
    }, [phaseSections]);

    const totalsForPhase = (phase) =>
        phase.tasks.reduce(
            (acc, t) => {
                acc.total += 1;
                if (t.status === 'DONE') acc.done += 1;
                const subs = subtasksByParent.get(t.id) || [];
                acc.subtasks += subs.length;
                acc.subtasksDone += subs.filter((s) => s.status === 'DONE').length;
                return acc;
            },
            { total: 0, done: 0, subtasks: 0, subtasksDone: 0 },
        );

    return (
        <div className="space-y-3">
            {/* Sticky filter / actions header.
                Sits directly under the sticky tab bar that
                ProjectDetail renders above us. The tab bar now
                shrinks on scroll (comfortable ~62px → compact
                ~30px), so we read its current height from the
                `--project-tabs-h` CSS variable that ProjectDetail
                publishes on the surrounding <section>. Falls back
                to 30px (the stuck/compact height) when the variable
                isn't set — that's the size the bar settles into
                once you've scrolled past it, which is the only
                state where this toolbar is actually pinned.
                Bleeds full-width via the same negative-margin
                trick so the solid backdrop covers everything that
                scrolls behind it. z-20 keeps it below the tab bar
                (z-30) but above the plan grid.

                Background is fully opaque so the muted page
                background never bleeds through while scrolling —
                translucency here used to leave a visible "stripe"
                between the tabs and the filter row. */}
            <div
                className="sticky z-20 -mx-3 border-b bg-background px-3 py-1 sm:-mx-6 sm:px-6"
                style={{ top: 'var(--project-tabs-h, 30px)' }}
            >
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                        Group tasks by phase. Expand a task to see or add subtasks.
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch
                            checked={hideCompleted}
                            onCheckedChange={setHideCompleted}
                            aria-label="Hide completed tasks and subtasks"
                        />
                        <span>Hide completed</span>
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch
                            checked={showTaskNotes}
                            onCheckedChange={handleGlobalNotesToggle}
                            aria-label="Show notes inline under each task"
                        />
                        <span className="inline-flex items-center gap-1">
                            <MessageSquare className="h-3 w-3" />
                            Show task notes
                            {taskNotesLoading && (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                        </span>
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch
                            checked={showReassignmentInfo}
                            onCheckedChange={setShowReassignmentInfo}
                            aria-label="Show reassignment badges and decision banners"
                        />
                        <span className="inline-flex items-center gap-1">
                            <UserCog className="h-3 w-3" />
                            Show reassignment info
                        </span>
                    </label>
                    <Button
                        size="sm"
                        variant="outline"
                        className="relative gap-2"
                        onClick={reloadPlan}
                        disabled={reloading}
                        title={
                            pendingChanges.length
                                ? `${pendingChanges.length} change${
                                      pendingChanges.length === 1 ? '' : 's'
                                  } available — click to reload`
                                : 'Reload the plan'
                        }
                    >
                        {reloading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <RefreshCw className="h-4 w-4" />
                        )}
                        Reload
                        {pendingChanges.length > 0 && (
                            <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                                {pendingChanges.length > 9
                                    ? '9+'
                                    : pendingChanges.length}
                            </span>
                        )}
                    </Button>
                    {canManagePhases && (
                        <Button
                            size="sm"
                            variant="outline"
                            className="gap-2"
                            onClick={openCreatePhase}
                        >
                            <Plus className="h-4 w-4" />
                            Add phase
                        </Button>
                    )}
                </div>
                </div>
            </div>

            {pendingChanges.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
                    <div className="flex items-center gap-2 text-foreground/80">
                        <RefreshCw className="h-3.5 w-3.5 text-primary" />
                        <span>
                            <span className="font-medium">
                                {pendingSummary}
                            </span>{' '}
                            <span className="text-muted-foreground">
                                · your view is out of date.
                            </span>
                        </span>
                    </div>
                    <Button
                        size="sm"
                        variant="default"
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={reloadPlan}
                        disabled={reloading}
                    >
                        {reloading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        Reload now
                    </Button>
                </div>
            )}

            {phaseSections.length === 0 ? (
                <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                    No phases yet. Add your first phase to start organizing tasks.
                </div>
            ) : (
                <ul className="space-y-2">
                    {phaseSections.map((phase, idx) => {
                        const isCollapsed = collapsed.has(phase.id);
                        const totals = totalsForPhase(phase);
                        const theme = themeForPhase(phase);
                        // Per-phase effective view flags. These either
                        // mirror the global toolbar (no override) or
                        // reflect whatever the user has flipped for this
                        // phase via the header switches below.
                        const phaseFlagsResolved = phaseFlags(phase.id);
                        const phaseHideCompleted =
                            phaseFlagsResolved.hideCompleted;
                        const phaseShowTaskNotes =
                            phaseFlagsResolved.showTaskNotes;
                        const phaseShowReassignmentInfo =
                            phaseFlagsResolved.showReassignmentInfo;
                        const phaseOverride = phaseOverrides.get(phase.id);
                        // The header indicator pulses gently when ANY
                        // key has been customised, so the user can see
                        // at a glance which phases deviate from the
                        // global toolbar.
                        const hasOverride = Boolean(
                            phaseOverride &&
                                (typeof phaseOverride.hideCompleted ===
                                    'boolean' ||
                                    typeof phaseOverride.showTaskNotes ===
                                        'boolean' ||
                                    typeof phaseOverride.showReassignmentInfo ===
                                        'boolean'),
                        );
                        return (
                            <li
                                key={phase.id}
                                className={cn(
                                    'overflow-hidden rounded-lg border bg-card shadow-sm ring-1',
                                    theme.ring,
                                )}
                            >
                                {/* Coloured accent bar so each phase reads as a distinct chunk */}
                                <div className={cn('h-1.5 w-full', theme.bar)} />
                                <div
                                    className={cn(
                                        'flex items-center gap-2 border-b px-2 py-2',
                                        theme.header,
                                    )}
                                >
                                    {/* Phase reorder: two compact chevron
                                        buttons replace the older
                                        GripVertical drag handle. Drag-and-drop
                                        on a row that's also clickable
                                        (the whole header is a collapse
                                        toggle) was easy to mis-trigger;
                                        explicit up/down arrows make the
                                        ordering action discoverable and
                                        keyboard-accessible. We compute
                                        `lastRealIdx` once per render so
                                        the "Down" button correctly
                                        disables on the bottom-most real
                                        phase even when a virtual
                                        "Unphased" bucket follows it. */}
                                    {!phase._virtual && canManagePhases && (
                                        <div className="flex flex-col">
                                            <button
                                                type="button"
                                                className="flex h-3.5 w-5 items-center justify-center rounded-t text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                                                onClick={() => movePhase(phase, -1)}
                                                title="Move phase up"
                                                aria-label={`Move "${phase.name}" up`}
                                                disabled={idx === 0}
                                            >
                                                <ChevronUp className="h-3 w-3" />
                                            </button>
                                            <button
                                                type="button"
                                                className="flex h-3.5 w-5 items-center justify-center rounded-b text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                                                onClick={() => movePhase(phase, 1)}
                                                title="Move phase down"
                                                aria-label={`Move "${phase.name}" down`}
                                                disabled={idx === lastRealPhaseIdx}
                                            >
                                                <ChevronDown className="h-3 w-3" />
                                            </button>
                                        </div>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => toggleCollapsed(phase.id)}
                                        className="flex flex-1 items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent/50"
                                    >
                                        {isCollapsed ? (
                                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                        ) : (
                                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                                        )}
                                        <Layers className="h-4 w-4 text-muted-foreground" />
                                        <span className="text-sm font-semibold">
                                            {phase.name}
                                        </span>
                                        {totals.total > 0 &&
                                        totals.done === totals.total &&
                                        totals.subtasksDone === totals.subtasks ? (
                                            <CheckCircle2
                                                className="h-4 w-4 text-emerald-600 dark:text-emerald-400"
                                                title="All tasks complete"
                                            />
                                        ) : null}
                                        <Badge
                                            variant="secondary"
                                            className="h-5 px-1.5 text-[10px]"
                                            title={`${totals.done}/${totals.total} tasks complete`}
                                        >
                                            {totals.total
                                                ? `${totals.done}/${totals.total}`
                                                : 0}
                                        </Badge>
                                        {totals.subtasks > 0 && (
                                            <span className="text-[10px] text-muted-foreground">
                                                +{totals.subtasksDone}/
                                                {totals.subtasks} subtasks
                                            </span>
                                        )}
                                    </button>
                                    {/* Per-phase view overrides.
                                        Two compact icon-buttons sit
                                        between the phase title and the
                                        per-phase action buttons. Each
                                        button shows the EFFECTIVE state
                                        (global value or override). Click
                                        to flip just this phase; the
                                        global toolbar above is
                                        untouched. The third button (a
                                        tiny "Reset") only renders when
                                        there's an active override, so
                                        users can re-inherit the global
                                        without a multi-step menu.

                                        We don't render these for the
                                        virtual "Unphased" bucket — that
                                        section is just an overflow
                                        catch and persisting overrides
                                        against its synthetic id would
                                        carry across reloads in
                                        confusing ways. */}
                                    {!phase._virtual && (
                                        <div className="flex items-center gap-0.5 pr-1">
                                            {/* Reset link sits PERMANENTLY
                                                to the left of the eye/notes
                                                icons and reserves its slot
                                                in the layout even when
                                                there's nothing to reset.
                                                We toggle visibility +
                                                pointer-events instead of
                                                rendering conditionally, so
                                                the icons don't slide around
                                                when an override appears or
                                                disappears — the previous
                                                behaviour was visually
                                                disorienting on every
                                                click. `aria-hidden` and
                                                `tabIndex=-1` keep screen
                                                readers and keyboard nav
                                                from announcing/focusing
                                                the invisible state. */}
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    clearPhaseOverrides(
                                                        phase.id,
                                                    )
                                                }
                                                title="Clear per-phase overrides (inherit the global toolbar)"
                                                className={cn(
                                                    'rounded px-1 text-[10px] font-medium text-primary transition-opacity hover:underline',
                                                    hasOverride
                                                        ? 'opacity-100'
                                                        : 'pointer-events-none opacity-0',
                                                )}
                                                aria-hidden={!hasOverride}
                                                tabIndex={hasOverride ? 0 : -1}
                                            >
                                                Reset
                                            </button>
                                            <Button
                                                size="icon"
                                                variant={
                                                    phaseHideCompleted
                                                        ? 'secondary'
                                                        : 'ghost'
                                                }
                                                className={cn(
                                                    'h-7 w-7 transition-colors',
                                                    phaseOverride &&
                                                        typeof phaseOverride.hideCompleted ===
                                                            'boolean' &&
                                                        'ring-1 ring-primary/40',
                                                )}
                                                onClick={() =>
                                                    setPhaseOverride(
                                                        phase.id,
                                                        'hideCompleted',
                                                        !phaseHideCompleted,
                                                    )
                                                }
                                                title={
                                                    phaseHideCompleted
                                                        ? `Hide completed: ON for "${phase.name}"${
                                                              phaseOverride &&
                                                              typeof phaseOverride.hideCompleted ===
                                                                  'boolean'
                                                                  ? ' (overrides global)'
                                                                  : ' (matches global)'
                                                          }`
                                                        : `Hide completed: OFF for "${phase.name}"${
                                                              phaseOverride &&
                                                              typeof phaseOverride.hideCompleted ===
                                                                  'boolean'
                                                                  ? ' (overrides global)'
                                                                  : ' (matches global)'
                                                          }`
                                                }
                                                aria-label={`Toggle hide completed for ${phase.name}`}
                                            >
                                                {phaseHideCompleted ? (
                                                    <EyeOff className="h-3.5 w-3.5" />
                                                ) : (
                                                    <Eye className="h-3.5 w-3.5" />
                                                )}
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant={
                                                    phaseShowTaskNotes
                                                        ? 'secondary'
                                                        : 'ghost'
                                                }
                                                className={cn(
                                                    'h-7 w-7 transition-colors',
                                                    phaseOverride &&
                                                        typeof phaseOverride.showTaskNotes ===
                                                            'boolean' &&
                                                        'ring-1 ring-primary/40',
                                                )}
                                                onClick={() => {
                                                    const turningOn =
                                                        !phaseShowTaskNotes;
                                                    setPhaseOverride(
                                                        phase.id,
                                                        'showTaskNotes',
                                                        turningOn,
                                                    );
                                                    // Auto-expand/collapse
                                                    // this phase's subtask
                                                    // trees so subtask notes
                                                    // are visible when notes
                                                    // are turned on.
                                                    const ids = (
                                                        visibleTopTasksByPhase.get(
                                                            phase.id,
                                                        ) || []
                                                    )
                                                        .filter(
                                                            (t) =>
                                                                (
                                                                    subtasksByParent.get(
                                                                        t.id,
                                                                    ) || []
                                                                ).length,
                                                        )
                                                        .map((t) => t.id);
                                                    setExpandedTasks((prev) => {
                                                        const next = new Set(
                                                            prev,
                                                        );
                                                        for (const id of ids) {
                                                            if (turningOn)
                                                                next.add(id);
                                                            else
                                                                next.delete(id);
                                                        }
                                                        return next;
                                                    });
                                                }}
                                                title={
                                                    phaseShowTaskNotes
                                                        ? `Show task notes: ON for "${phase.name}"${
                                                              phaseOverride &&
                                                              typeof phaseOverride.showTaskNotes ===
                                                                  'boolean'
                                                                  ? ' (overrides global)'
                                                                  : ' (matches global)'
                                                          }`
                                                        : `Show task notes: OFF for "${phase.name}"${
                                                              phaseOverride &&
                                                              typeof phaseOverride.showTaskNotes ===
                                                                  'boolean'
                                                                  ? ' (overrides global)'
                                                                  : ' (matches global)'
                                                          }`
                                                }
                                                aria-label={`Toggle show task notes for ${phase.name}`}
                                            >
                                                {phaseShowTaskNotes ? (
                                                    <MessageSquare className="h-3.5 w-3.5" />
                                                ) : (
                                                    <MessageSquareOff className="h-3.5 w-3.5" />
                                                )}
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant={
                                                    phaseShowReassignmentInfo
                                                        ? 'secondary'
                                                        : 'ghost'
                                                }
                                                className={cn(
                                                    'h-7 w-7 transition-colors',
                                                    phaseOverride &&
                                                        typeof phaseOverride.showReassignmentInfo ===
                                                            'boolean' &&
                                                        'ring-1 ring-primary/40',
                                                )}
                                                onClick={() =>
                                                    setPhaseOverride(
                                                        phase.id,
                                                        'showReassignmentInfo',
                                                        !phaseShowReassignmentInfo,
                                                    )
                                                }
                                                title={
                                                    phaseShowReassignmentInfo
                                                        ? `Show reassignment info: ON for "${phase.name}"${
                                                              phaseOverride &&
                                                              typeof phaseOverride.showReassignmentInfo ===
                                                                  'boolean'
                                                                  ? ' (overrides global)'
                                                                  : ' (matches global)'
                                                          }`
                                                        : `Show reassignment info: OFF for "${phase.name}"${
                                                              phaseOverride &&
                                                              typeof phaseOverride.showReassignmentInfo ===
                                                                  'boolean'
                                                                  ? ' (overrides global)'
                                                                  : ' (matches global)'
                                                          }`
                                                }
                                                aria-label={`Toggle reassignment info for ${phase.name}`}
                                            >
                                                {/* Same icon for ON/OFF — there's
                                                    no clean lucide "user-cog-off"
                                                    glyph, so we let the active
                                                    variant (secondary fill vs
                                                    ghost) communicate state.
                                                    The tooltip spells out the
                                                    current state for clarity. */}
                                                <UserCog className="h-3.5 w-3.5" />
                                            </Button>
                                            {/* Per-phase Expand / Collapse all.
                                                Scoped to the parents in THIS
                                                phase — the global toolbar used
                                                to carry one button that flipped
                                                every parent across every phase
                                                at once, which buried important
                                                rows when the project had many
                                                phases. We compute the phase's
                                                expandable parent ids from
                                                `subtasksByParent` filtered to
                                                tasks belonging to this phase,
                                                then derive `allExpandedHere`
                                                from the SHARED expandedTasks
                                                set (one set per project; we
                                                add/remove parents in chunks
                                                instead of using one set per
                                                phase, so the existing per-row
                                                expand chevrons keep working
                                                unchanged).
                                                
                                                Subtask notes pinned to a
                                                collapsed parent are invisible
                                                until that parent expands, so
                                                this button is also the
                                                discoverability path for the
                                                "Show task notes" toggle — the
                                                two work hand-in-hand. */}
                                            {(() => {
                                                const phaseParents =
                                                    visibleTopTasksByPhase.get(
                                                        phase.id,
                                                    ) || [];
                                                const expandableIds = [];
                                                for (const t of phaseParents) {
                                                    const subs =
                                                        subtasksByParent.get(t.id);
                                                    if (subs && subs.length) {
                                                        expandableIds.push(t.id);
                                                    }
                                                }
                                                const hasExpandableHere =
                                                    expandableIds.length > 0;
                                                const allExpandedHere =
                                                    hasExpandableHere &&
                                                    expandableIds.every((id) =>
                                                        expandedTasks.has(id),
                                                    );
                                                return (
                                                    <Button
                                                        size="icon"
                                                        variant="ghost"
                                                        className="h-7 w-7 transition-colors"
                                                        disabled={!hasExpandableHere}
                                                        onClick={() => {
                                                            setExpandedTasks(
                                                                (prev) => {
                                                                    const next =
                                                                        new Set(
                                                                            prev,
                                                                        );
                                                                    if (
                                                                        allExpandedHere
                                                                    ) {
                                                                        for (const id of expandableIds) {
                                                                            next.delete(
                                                                                id,
                                                                            );
                                                                        }
                                                                    } else {
                                                                        for (const id of expandableIds) {
                                                                            next.add(
                                                                                id,
                                                                            );
                                                                        }
                                                                    }
                                                                    return next;
                                                                },
                                                            );
                                                        }}
                                                        title={
                                                            !hasExpandableHere
                                                                ? `No subtasks in "${phase.name}"`
                                                                : allExpandedHere
                                                                  ? `Collapse all subtasks in "${phase.name}"`
                                                                  : `Expand all subtasks in "${phase.name}"`
                                                        }
                                                        aria-label={
                                                            allExpandedHere
                                                                ? `Collapse all subtasks in ${phase.name}`
                                                                : `Expand all subtasks in ${phase.name}`
                                                        }
                                                    >
                                                        {allExpandedHere ? (
                                                            <ChevronsDownUp className="h-3.5 w-3.5" />
                                                        ) : (
                                                            <ChevronsUpDown className="h-3.5 w-3.5" />
                                                        )}
                                                    </Button>
                                                );
                                            })()}
                                        </div>
                                    )}
                                    {!phase._virtual && canManage && (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            className="h-7 gap-1 px-2 text-xs"
                                            onClick={() => openCreateTask(phase.id)}
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                            Task
                                        </Button>
                                    )}
                                    {!phase._virtual && canManagePhases && (
                                        <>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7"
                                                onClick={() => openEditPhase(phase)}
                                                title="Rename phase"
                                            >
                                                <Pencil className="h-3.5 w-3.5" />
                                            </Button>
                                            <Button
                                                size="icon"
                                                variant="ghost"
                                                className="h-7 w-7 text-destructive hover:text-destructive"
                                                onClick={() => deletePhase(phase)}
                                                title="Delete phase"
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </>
                                    )}
                                </div>

                                {!phase._virtual && (
                                    <PhaseTeamsBar
                                        phaseId={phase.id}
                                        canManage={canManage}
                                        allTeams={allTeams}
                                        refreshSignal={pendingChanges.length}
                                    />
                                )}

                                {!isCollapsed && (
                                    <div>
                                        {phase.tasks.length === 0 ? (
                                            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                                                No tasks in this phase yet.
                                            </div>
                                        ) : (
                                            <div className="overflow-x-auto">
                                                {/* min-width keeps the fixed
                                                    columns of the header and
                                                    the rows perfectly aligned
                                                    even when the viewport
                                                    is narrow. */}
                                                <div className="min-w-[900px]">
                                                    <TaskColumnHeader theme={theme} />
                                                    <ul className="divide-y">
                                                        {phase.tasks.map((task) => (
                                                            <TaskTree
                                                                key={task.id}
                                                                task={task}
                                                                projectId={projectId}
                                                                subtasks={
                                                                    visibleSubtasksByParent.get(
                                                                        task.id,
                                                                    ) || []
                                                                }
                                                                taskNotes={
                                                                    phaseShowTaskNotes ||
                                                                    openNoteTaskIds.has(
                                                                        task.id,
                                                                    )
                                                                        ? taskNotesByTask.get(
                                                                              task.id,
                                                                          ) || []
                                                                        : null
                                                                }
                                                                subtaskNotes={
                                                                    phaseShowTaskNotes ||
                                                                    openNoteTaskIds.has(
                                                                        task.id,
                                                                    )
                                                                        ? taskNotesByTask
                                                                        : null
                                                                }
                                                                notesOpen={
                                                                    phaseShowTaskNotes ||
                                                                    openNoteTaskIds.has(
                                                                        task.id,
                                                                    )
                                                                }
                                                                onToggleNotes={() =>
                                                                    toggleTaskNotes(
                                                                        task.id,
                                                                        (
                                                                            visibleSubtasksByParent.get(
                                                                                task.id,
                                                                            ) ||
                                                                            []
                                                                        )
                                                                            .length >
                                                                            0,
                                                                    )
                                                                }
                                                                showReassignmentInfo={
                                                                    phaseShowReassignmentInfo
                                                                }
                                                                users={users}
                                                                participants={participants}
                                                                canManage={canManage}
                                                                canEditTask={canEditTask}
                                                                canDeleteTask={canDeleteTask}
                                                                canManageOwnTasks={canManageOwnTasks}
                                                                pulseTask={pulseTask}
                                                                currentUserId={currentUserId}
                                                                expanded={expandedTasks.has(
                                                                    task.id,
                                                                )}
                                                                onToggleExpand={() =>
                                                                    toggleExpandedTask(
                                                                        task.id,
                                                                    )
                                                                }
                                                                onAddSubtask={() =>
                                                                    openCreateSubtask(task)
                                                                }
                                                                onUpdateTask={updateTaskField}
                                                                onEditTask={openEditTask}
                                                                onDeleteTask={deleteTask}
                                                                onDuplicateTask={duplicateTask}
                                                                onAddNote={openNoteForTask}
                                                                onLogTime={openLogTimeDialog}
                                                                onOpen={openTaskDialog}
                                                                viewerChangeRequestId={changeRequestId}
                                                                onProposeReassign={(t) =>
                                                                    setReassignDialog({
                                                                        open: true,
                                                                        task: t,
                                                                    })
                                                                }
                                                                pendingReassignments={
                                                                    pendingReassignments
                                                                }
                                                                recentDecisions={
                                                                    recentDecisions
                                                                }
                                                            />
                                                        ))}
                                                    </ul>
                                                </div>
                                            </div>
                                        )}
                                        {!phase._virtual && (
                                            <PlanActivities
                                                projectId={projectId}
                                                phaseId={phase.id}
                                                phaseName={phase.name}
                                                activities={
                                                    activitiesByPhase.get(
                                                        phase.id,
                                                    ) || []
                                                }
                                                participants={participants}
                                                canManage={canManage}
                                                currentUserId={currentUserId}
                                                onMutated={refreshActivities}
                                            />
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            <TaskDialog
                state={taskDialog}
                phases={phases}
                users={users}
                participants={participants}
                canCreateSpecific={canCreateSpecific}
                onClose={() =>
                    setTaskDialog({
                        open: false,
                        phaseId: null,
                        task: null,
                        parentTask: null,
                    })
                }
                onSubmit={submitTask}
            />
            <PhaseDialog
                state={phaseDialog}
                existingPhases={phases}
                onClose={() => setPhaseDialog({ open: false, phase: null })}
                onSubmit={submitPhase}
            />
            <TaskNoteDialog
                state={noteDialog}
                projectId={projectId}
                participants={participants}
                onClose={() => setNoteDialog({ open: false, task: null })}
                onSubmit={submitTaskNote}
            />
            <ProposeReassignDialog
                state={reassignDialog}
                participants={participants}
                currentUserId={currentUserId}
                onClose={() => setReassignDialog({ open: false, task: null })}
                onSubmitted={() => {
                    setReassignDialog({ open: false, task: null });
                    refreshReassignments();
                }}
            />
            <LogTimeDialog
                open={logTimeDialog.open}
                task={logTimeDialog.task}
                projectId={projectId}
                projectName={projectName}
                onClose={() =>
                    setLogTimeDialog({ open: false, task: null })
                }
                onLogged={() => {
                    // Reload the plan so any "actuals" surface the new
                    // entry. onChanged is the same callback the parent
                    // wires to every other mutation, so this stays
                    // consistent with note/reassign behaviour.
                    onChanged?.();
                }}
            />
            <TaskQuickViewDialog
                open={quickViewDialog.open}
                task={quickViewDialog.task}
                defaultTab={quickViewDialog.tab}
                projectId={projectId}
                projectName={projectName}
                onClose={() => setQuickViewDialog({ open: false, task: null, tab: 'logtime' })}
                onNoteSubmitted={onChanged}
                onTimeLogged={onChanged}
                canApprove={canApprove}
                onApproved={onChanged}
                // Re-request approval is allowed for approvers OR the
                // task's creator / assignee (mirrors the backend rule).
                canRerequest={
                    canApprove ||
                    (currentUserId &&
                        (quickViewDialog.task?.createdById === currentUserId ||
                            quickViewDialog.task?.createdBy?.id ===
                                currentUserId ||
                            quickViewDialog.task?.assignee?.id ===
                                currentUserId))
                }
                // Eligibility mirrors the backend's `assertCanLogOnScope`:
                // anyone who can manage tasks at all (admin/manager/personal
                // owner/cap holder) can also log time, plus the assignee
                // of the specific task. We don't separately surface
                // "shared-project owner" because they'd already be an
                // admin/manager in practice.
                canLogTime={
                    canManage ||
                    quickViewDialog.task?.assignee?.id === currentUserId
                }
                // Edit access uses the NARROWER edit-only flag plus a
                // per-row overlay: a user who only has
                // `task:create:any` or `task:delete:any` must NOT see
                // the "Edit" button here unless THEY created the
                // task that's open in the quick-view. Otherwise they
                // could reach the edit dialog through a back door
                // even though their title click correctly drops them
                // into the quick-view.
                canEdit={
                    canEditTask ||
                    (canManageOwnTasks &&
                        currentUserId &&
                        (quickViewDialog.task?.createdBy?.id ===
                            currentUserId ||
                            quickViewDialog.task?.createdById ===
                                currentUserId))
                }
                onEdit={() => {
                    // Snapshot the task BEFORE closing the dialog — the
                    // onClose callback resets quickViewDialog.task to
                    // null, which would race against openEditTask.
                    const t = quickViewDialog.task;
                    setQuickViewDialog({ open: false, task: null, tab: 'logtime' });
                    if (t) openEditTask(t);
                }}
            />

            <ConfirmDeleteDialog
                open={deleteTaskState.open}
                onOpenChange={(o) =>
                    setDeleteTaskState((s) => ({ ...s, open: o }))
                }
                title="Delete this task?"
                description={(() => {
                    const subCount = deleteTaskState.task
                        ? subtasksByParent.get(deleteTaskState.task.id)
                              ?.length || 0
                        : 0;
                    return subCount
                        ? `This task and its ${subCount} subtask(s) will be removed. It can be restored from the Activity log, and the deletion is recorded against your account.`
                        : 'The task will be removed. It can be restored from the Activity log, and the deletion is recorded against your account.';
                })()}
                ackLabel="I understand — delete this task."
                confirmLabel="Delete task"
                onConfirm={performDeleteTask}
            />
        </div>
    );
}

// Strip of team chips beneath each phase header. Any team assigned
// here is also a project-wide participant, but the chip lives next to
// the phase to communicate "this team owns this phase". Admin /
// Manager can attach an extra team or detach one inline.
function PhaseTeamsBar({ phaseId, canManage, allTeams, refreshSignal }) {
    const [attached, setAttached] = useState([]);
    const [loading, setLoading] = useState(true);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [working, setWorking] = useState(false);

    const refresh = async () => {
        try {
            const { data } = await api.get(`/teams/by-phase/${phaseId}`);
            setAttached(data.teams || []);
        } catch {
            setAttached([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!phaseId) return;
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phaseId, refreshSignal]);

    const attachedIds = new Set(attached.map((a) => a.team?.id).filter(Boolean));
    const candidates = (allTeams || []).filter((t) => !attachedIds.has(t.id));

    const attach = async (team) => {
        try {
            setWorking(true);
            await api.post(`/teams/by-phase/${phaseId}`, { teamId: team.id });
            toast.success(`Team "${team.name}" assigned to phase.`);
            await refresh();
            setPickerOpen(false);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not assign team.');
        } finally {
            setWorking(false);
        }
    };

    const detach = async (team) => {
        if (!window.confirm(`Remove team "${team.name}" from this phase?`))
            return;
        try {
            await api.delete(`/teams/by-phase/${phaseId}/${team.id}`);
            toast.success('Team removed from phase.');
            await refresh();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not detach team.');
        }
    };

    if (loading && attached.length === 0 && !canManage) return null;
    if (!loading && attached.length === 0 && !canManage) return null;

    return (
        <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/20 px-2 py-1.5">
            <UserCog className="h-3 w-3 text-muted-foreground" />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Owners
            </span>
            {attached.length === 0 ? (
                <span className="text-xs text-muted-foreground">
                    No team assigned
                </span>
            ) : (
                attached.map(({ team }) => (
                    <PhaseTeamChip
                        key={team.id}
                        team={team}
                        canDetach={canManage}
                        onDetach={() => detach(team)}
                    />
                ))
            )}
            {canManage && (
                <div className="relative ml-auto">
                    <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() => setPickerOpen((v) => !v)}
                        disabled={candidates.length === 0}
                        title={
                            candidates.length === 0
                                ? 'All teams are already assigned'
                                : 'Assign a team to this phase'
                        }
                    >
                        <Plus className="h-3 w-3" /> Team
                    </Button>
                    {pickerOpen && candidates.length > 0 && (
                        <div className="absolute right-0 z-20 mt-1 w-56 rounded-md border bg-card p-1 shadow-md">
                            {candidates.map((t) => (
                                <button
                                    type="button"
                                    key={t.id}
                                    onClick={() => attach(t)}
                                    disabled={working}
                                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                                >
                                    <span className="truncate font-medium">
                                        {t.name}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground">
                                        {t.memberCount}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function PhaseTeamChip({ team, canDetach, onDetach }) {
    const tone = teamColorClassPlan(team.color);
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                tone,
            )}
            title={`${team.memberCount} member${team.memberCount === 1 ? '' : 's'}`}
        >
            {team.name}
            <span className="text-[9px] font-normal opacity-80">
                · {team.memberCount}
            </span>
            {canDetach && (
                <button
                    type="button"
                    className="ml-0.5 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                    onClick={onDetach}
                    title="Remove team"
                    aria-label="Remove team"
                >
                    <Trash2 className="h-3 w-3" />
                </button>
            )}
        </span>
    );
}

// Inline copy of the chip-tone helper from pages/Teams.jsx — duplicated
// here to keep PhasesPlan free of cross-package import cycles. The
// canonical version lives next to the Teams page.
function teamColorClassPlan(color) {
    switch (color) {
        case 'sky':
            return 'bg-sky-100 text-sky-800 ring-1 ring-sky-300 dark:bg-sky-500/15 dark:text-sky-200';
        case 'emerald':
            return 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-200';
        case 'amber':
            return 'bg-amber-100 text-amber-900 ring-1 ring-amber-300 dark:bg-amber-500/15 dark:text-amber-200';
        case 'rose':
            return 'bg-rose-100 text-rose-800 ring-1 ring-rose-300 dark:bg-rose-500/15 dark:text-rose-200';
        case 'violet':
            return 'bg-violet-100 text-violet-800 ring-1 ring-violet-300 dark:bg-violet-500/15 dark:text-violet-200';
        case 'indigo':
            return 'bg-indigo-100 text-indigo-800 ring-1 ring-indigo-300 dark:bg-indigo-500/15 dark:text-indigo-200';
        case 'slate':
            return 'bg-slate-100 text-slate-700 ring-1 ring-slate-300 dark:bg-slate-500/15 dark:text-slate-200';
        default:
            return 'bg-muted text-foreground ring-1 ring-border';
    }
}

// "Propose to reassign this task" dialog. Anyone with read access to
// the project can submit one — typically the current assignee, but a
// teammate can step in too. Managers / admins approve from
// /reassignments.
function ProposeReassignDialog({
    state,
    participants = [],
    currentUserId = null,
    onClose,
    onSubmitted,
}) {
    const [reason, setReason] = useState('');
    const [toAssigneeId, setToAssigneeId] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (state.open) {
            setReason('');
            setToAssigneeId('');
        }
    }, [state.open, state.task?.id]);

    // The reassign suggestion list is "any project participant other
    // than the person currently holding it and the proposer themselves"
    // — those two would either be a no-op or a self-assignment, neither
    // of which is what the workflow is for.
    const currentAssigneeId = state.task?.assigneeId || null;
    const candidateOptions = useMemo(() => {
        return participants
            .filter((u) => u.id !== currentAssigneeId && u.id !== currentUserId)
            .sort((a, b) =>
                (a.name || a.email || '').localeCompare(
                    b.name || b.email || '',
                ),
            );
    }, [participants, currentAssigneeId, currentUserId]);
    const currentAssignee = useMemo(
        () => participants.find((u) => u.id === currentAssigneeId) || null,
        [participants, currentAssigneeId],
    );

    const submit = async (e) => {
        e.preventDefault();
        if (!state.task) return;
        const trimmed = reason.trim();
        if (trimmed.length < 3) {
            toast.error('Add a short reason so the reviewer knows the context.');
            return;
        }
        try {
            setSaving(true);
            await api.post('/reassignments', {
                taskId: state.task.id,
                toAssigneeId: toAssigneeId || null,
                reason: trimmed,
            });
            toast.success('Proposal submitted. A manager will review it.');
            onSubmitted?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    'Could not submit the proposal.',
            );
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={state.open} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Propose reassignment</DialogTitle>
                    <DialogDescription>
                        Suggest a new assignee for{' '}
                        <span className="font-medium">
                            {state.task?.title || 'this task'}
                        </span>
                        . A manager or admin needs to approve before the change
                        sticks.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="grid gap-3">
                    {currentAssignee && (
                        <p className="text-xs text-muted-foreground">
                            Currently assigned to{' '}
                            <span className="font-medium text-foreground">
                                {currentAssignee.name || currentAssignee.email}
                            </span>
                            .
                        </p>
                    )}
                    <div className="grid gap-1">
                        <Label>Suggested new assignee (optional)</Label>
                        <Select
                            value={toAssigneeId || NO_ASSIGNEE}
                            onValueChange={(v) =>
                                setToAssigneeId(v === NO_ASSIGNEE ? '' : v)
                            }
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="Anyone — let the reviewer pick" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={NO_ASSIGNEE}>
                                    Anyone (reviewer picks)
                                </SelectItem>
                                {candidateOptions.length === 0 ? (
                                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                        No other participants on this project yet.
                                    </div>
                                ) : (
                                    candidateOptions.map((u) => (
                                        <SelectItem key={u.id} value={u.id}>
                                            {u.name || u.email}
                                        </SelectItem>
                                    ))
                                )}
                            </SelectContent>
                        </Select>
                        <p className="text-[11px] text-muted-foreground">
                            Pick anyone from this project's participants — or
                            leave blank to let a reviewer choose.
                        </p>
                    </div>
                    <div className="grid gap-1">
                        <Label htmlFor="reassign-reason">Reason</Label>
                        <Textarea
                            id="reassign-reason"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="e.g. I'm out next week, can someone else take this over?"
                            rows={4}
                            required
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {saving ? 'Submitting...' : 'Submit proposal'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

// Sticky-looking header row that labels the columns of the task grid
// below. Uses the SAME `TASK_GRID_COLS` template as `TaskRow` so each
// label sits directly above its column. When a `theme` is passed it
// inherits the phase's column band so the whole stack reads as one
// coloured group.
function TaskColumnHeader({ theme }) {
    return (
        <div
            className={cn(
                'grid items-stretch border-b border-border/60 text-[10px] font-semibold uppercase tracking-wide',
                TASK_GRID_COLS,
                theme?.column ||
                    'bg-slate-100/80 text-muted-foreground dark:bg-slate-800/60',
            )}
            role="row"
        >
            <div className={cellCls('center')} aria-hidden />
            <div className={cellCls('center')} aria-hidden />
            <div className={cellCls('left')}>Task</div>
            <div className={cellCls('left')}>Due</div>
            <div className={cellCls('left')}>Status</div>
            <div className={cellCls('left')}>Priority</div>
            <div className={cellCls('left')}>Assignee</div>
            <div className={cellCls('right')}>Actions</div>
        </div>
    );
}

// Renders one top-level task plus, when expanded, its subtasks indented
// underneath. Encapsulates the expand chevron + "add subtask" affordance so
// the phase list stays tidy.
function TaskTree({
    task,
    subtasks,
    users,
    participants,
    canManage = false,
    // Narrower edit-only flag — controls whether the title link opens
    // the edit dialog (cap holder of `task:edit:any` / admin / manager
    // / personal owner) or just the read-only quick-view. See the
    // matching prop in <PhasesPlan> above.
    canEditTask = canManage,
    // Delete-button gate. Mirrors `canEditTask` but for delete-any.
    canDeleteTask = canManage,
    // TRUE iff the user holds `task:create:any`. TaskRow combines
    // this with `task.createdBy.id === currentUserId` to flip per-row
    // Edit / Delete buttons on for the rows the current user
    // created — no schema-wide edit-any rights required.
    canManageOwnTasks = false,
    // One-shot pulse trigger — see prop doc on <PhasesPlan>.
    pulseTask = null,
    currentUserId = null,
    expanded,
    onToggleExpand,
    onAddSubtask,
    onUpdateTask,
    onEditTask,
    onDeleteTask,
    onDuplicateTask,
    onAddNote,
    onLogTime,
    onOpen,
    onProposeReassign,
    pendingReassignments,
    recentDecisions,
    // Notes pinned to this specific task. `null` means the user has the
    // "Show task notes" toggle off — we render nothing in that case.
    // An empty array still triggers a "no notes yet" hint so the user
    // gets feedback that the toggle is on.
    taskNotes = null,
    // Per-task notes toggle (independent of the global/phase switch).
    notesOpen = false,
    onToggleNotes,
    // Map of taskId -> notes[], used so nested subtasks can pull their
    // own pinned notes without us having to re-thread props per row.
    subtaskNotes = null,
    // Project id — used so each inline note can deep-link the user
    // straight to that note inside the Notes panel.
    projectId = null,
    // Propagated to every TaskRow so it knows whether to hide its
    // CR chip (already inside that CR's plan view).
    viewerChangeRequestId = null,
    // When false, the per-phase override (or global toolbar) has asked
    // us to suppress the "Reassign requested" pill on the row AND the
    // decision-banner beneath it. Pending data is still loaded — we
    // just don't render it. Defaults to true so a TaskTree used in
    // contexts that don't pass the prop keeps the old behaviour.
    showReassignmentInfo = true,
}) {
    const subCount = subtasks.length;
    const showInline = taskNotes !== null;
    return (
        <li>
            <TaskRow
                task={task}
                users={users}
                canManage={canManage}
                canEditTask={canEditTask}
                canDeleteTask={canDeleteTask}
                canManageOwnTasks={canManageOwnTasks}
                pulseTask={pulseTask}
                currentUserId={currentUserId}
                onStatus={(v) => onUpdateTask(task, { status: v })}
                onPriority={(v) => onUpdateTask(task, { priority: v })}
                onAssignee={(v) =>
                    onUpdateTask(task, {
                        assigneeId: v === NO_ASSIGNEE ? null : v,
                    })
                }
                onEdit={() => onEditTask(task)}
                onDelete={() => onDeleteTask(task)}
                onDuplicate={
                    onDuplicateTask ? () => onDuplicateTask(task) : undefined
                }
                onAddNote={() => onAddNote?.(task)}
                notesOpen={notesOpen}
                onToggleNotes={onToggleNotes}
                noteCount={
                    subtaskNotes?.get
                        ? (subtaskNotes.get(task.id) || []).length
                        : Array.isArray(taskNotes)
                            ? taskNotes.length
                            : 0
                }
                onLogTime={onLogTime ? () => onLogTime(task) : undefined}
                onOpen={onOpen ? (tab) => onOpen(task, tab) : undefined}
                onProposeReassign={() => onProposeReassign?.(task)}
                pendingReassignment={pendingReassignments?.get(task.id) || null}
                recentDecision={recentDecisions?.get(task.id) || null}
                showReassignmentInfo={showReassignmentInfo}
                expandable
                expanded={expanded}
                subCount={subCount}
                onToggleExpand={onToggleExpand}
                onAddSubtask={onAddSubtask}
                viewerChangeRequestId={viewerChangeRequestId}
            />

            {showInline && (
                <InlineTaskNotes
                    notes={taskNotes}
                    onAddNote={() => onAddNote?.(task)}
                    projectId={projectId}
                />
            )}

            {expanded && (
                /* Visually nest the subtask block so collapsed
                   rows still read as CHILDREN of the parent task,
                   not as siblings. The wrapper is shifted right
                   with `ml-6` and carries a tinted left-tree-line
                   (`border-l-4 border-l-indigo-300`) plus a
                   soft tinted background that matches the
                   subtask zebra tones. Combined with the
                   per-row indigo tints inside SubtaskColumnHeader
                   / TaskRow, the indent communicates hierarchy
                   without needing a separate column-shifted
                   grid (the grid stays aligned with itself —
                   it's the entire group that moves inward). */
                <div className="ml-6 mt-1 mb-2 overflow-hidden rounded-md border-l-4 border-l-indigo-400 bg-indigo-50/40 ring-1 ring-indigo-200/60 dark:border-l-indigo-500 dark:bg-indigo-500/[0.05] dark:ring-indigo-500/30">
                    {subCount > 0 && <SubtaskColumnHeader />}
                    {subCount === 0 ? (
                        <div className="px-3 py-3 pl-12 text-xs text-muted-foreground">
                            No subtasks yet.
                        </div>
                    ) : (
                        <ul className="divide-y divide-indigo-200/60 dark:divide-indigo-500/20">
                            {subtasks.map((sub, i) => (
                                <li key={sub.id}>
                                    <TaskRow
                                        task={sub}
                                        users={participants}
                                        canManage={canManage}
                                        canEditTask={canEditTask}
                                        canDeleteTask={canDeleteTask}
                                        canManageOwnTasks={canManageOwnTasks}
                                        pulseTask={pulseTask}
                                        currentUserId={currentUserId}
                                        viewerChangeRequestId={viewerChangeRequestId}
                                        isSubtask
                                        zebraIndex={i}
                                        onStatus={(v) =>
                                            onUpdateTask(sub, { status: v })
                                        }
                                        onPriority={(v) =>
                                            onUpdateTask(sub, { priority: v })
                                        }
                                        onAssignee={(v) =>
                                            onUpdateTask(sub, {
                                                assigneeId:
                                                    v === NO_ASSIGNEE
                                                        ? null
                                                        : v,
                                            })
                                        }
                                        onEdit={() => onEditTask(sub)}
                                        onDelete={() => onDeleteTask(sub)}
                                        onDuplicate={
                                            onDuplicateTask
                                                ? () => onDuplicateTask(sub)
                                                : undefined
                                        }
                                        onAddNote={() => onAddNote?.(sub)}
                                        onLogTime={
                                            onLogTime
                                                ? () => onLogTime(sub)
                                                : undefined
                                        }
                                        onOpen={
                                            onOpen
                                                ? (tab) => onOpen(sub, tab)
                                                : undefined
                                        }
                                        onProposeReassign={() =>
                                            onProposeReassign?.(sub)
                                        }
                                        pendingReassignment={
                                            pendingReassignments?.get(sub.id) ||
                                            null
                                        }
                                        recentDecision={
                                            recentDecisions?.get(sub.id) || null
                                        }
                                        showReassignmentInfo={
                                            showReassignmentInfo
                                        }
                                    />
                                    {subtaskNotes && (
                                        <InlineTaskNotes
                                            notes={
                                                subtaskNotes.get(sub.id) || []
                                            }
                                            onAddNote={() =>
                                                onAddNote?.(sub)
                                            }
                                            projectId={projectId}
                                            indented
                                        />
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {canManage && (
                        <div className="border-t bg-card/50 px-3 py-1.5 pl-12">
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                                onClick={onAddSubtask}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                Add subtask
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </li>
    );
}

// Inline preview of notes pinned to a specific task / subtask. Rendered
// directly under the row when the "Show task notes" toggle is on, so
// the conversation living on each item is one glance away.
//
// Each note row is a Link to /projects/<projectId>#note-<noteId>, which
// the Notes panel watches for and uses to scroll to (and briefly
// flash) the corresponding full note. That solves the "I attached an
// image but the inline preview only shows text" problem two ways at
// once:
//   1. We render up to three thumbnail-sized image attachments
//      directly in the inline preview so the user sees something at
//      a glance.
//   2. Clicking anywhere on the note card jumps to the Notes tab with
//      the note focused, so all attachments + full content are one
//      click away.
//
// Non-image attachments get a small "+N file" badge so the user knows
// there are more pieces to the note than the text alone.
function InlineTaskNotes({ notes = [], onAddNote, indented = false, projectId = null }) {
    if (!Array.isArray(notes)) return null;
    return (
        <div
            className={cn(
                'border-t bg-amber-50/40 px-3 py-2 dark:bg-amber-500/5',
                indented ? 'pl-12' : '',
            )}
        >
            <div className="mb-1 flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
                    <MessageSquare className="h-3 w-3" />
                    {notes.length === 0
                        ? 'No notes'
                        : `${notes.length} note${notes.length === 1 ? '' : 's'}`}
                </span>
                {onAddNote && (
                    <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 gap-1 px-2 text-[11px] text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-500/10"
                        onClick={onAddNote}
                    >
                        <Plus className="h-3 w-3" />
                        Add note
                    </Button>
                )}
            </div>
            {notes.length === 0 ? null : (
                <ul className="space-y-1.5">
                    {notes.map((n) => (
                        <InlineTaskNoteCard
                            key={n.id}
                            note={n}
                            projectId={projectId}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
}

// Single note row inside InlineTaskNotes. Split into its own component
// so the deep-link wrapper / image strip stay readable.
function InlineTaskNoteCard({ note, projectId }) {
    const [lightbox, setLightbox] = useState(null);
    const [open, setOpen] = useState(false);
    const files = Array.isArray(note.files) ? note.files : [];
    const images = files.filter((f) => isImageFile(f));
    const otherFiles = files.length - images.length;
    const visibleImages = images.slice(0, 3);
    const extraImages = images.length - visibleImages.length;

    // Clicking the card opens the note in a modal (full text +
    // attachments), with footer shortcuts to the task plan row and the
    // Notes panel. This keeps the user in the plan instead of navigating
    // away just to read a note.
    const InnerTag = 'button';
    const innerProps = {
        type: 'button',
        onClick: () => setOpen(true),
        title: 'Open note',
        className:
            'group block w-full rounded border border-amber-200/70 bg-white/70 px-2 py-1.5 text-left text-[11px] leading-snug text-foreground/90 shadow-sm transition-colors hover:border-amber-400 hover:bg-amber-50/80 dark:border-amber-500/20 dark:bg-amber-500/5 dark:hover:border-amber-400/60 dark:hover:bg-amber-500/10',
    };

    // The card body is clamped to 3 lines so the task row stays
    // compact. Whenever the actual text overflows that clamp we
    // surface a small "expand" button anchored to the top-right of
    // the card so the user can read the whole note without leaving
    // the plan view (or even navigating to the Notes panel).
    //
    // Detection runs whenever the note's content changes AND when the
    // card itself resizes (column width tweaks, sidebar collapse,
    // etc.) so the button appears/disappears correctly.
    const contentRef = useRef(null);
    const [overflowing, setOverflowing] = useState(false);
    useEffect(() => {
        const el = contentRef.current;
        if (!el) return undefined;
        const check = () => {
            // 1px slop accounts for sub-pixel rounding so a perfectly
            // fitting 3-line note doesn't false-positive.
            setOverflowing(el.scrollHeight - el.clientHeight > 1);
        };
        check();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(check);
        ro.observe(el);
        return () => ro.disconnect();
    }, [note.content]);

    return (
        <li className="relative">
            <InnerTag {...innerProps}>
                <div
                    ref={contentRef}
                    className={cn(
                        'line-clamp-3 whitespace-pre-wrap break-words',
                        // Soft fade at the bottom when clamped so the
                        // eye picks up the "more text" cue even
                        // before noticing the expand button.
                        overflowing &&
                            '[mask-image:linear-gradient(to_bottom,black_70%,transparent)]',
                        overflowing && 'pr-7',
                    )}
                >
                    {note.content || (
                        <span className="italic text-muted-foreground">
                            (empty note)
                        </span>
                    )}
                </div>

                {/* Inline image strip — thumbnails open in a lightbox. */}
                {(visibleImages.length > 0 || otherFiles > 0) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {visibleImages.map((img) => (
                            <button
                                key={img.id}
                                type="button"
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setLightbox({
                                        src: img.url,
                                        alt: img.originalName,
                                    });
                                }}
                                className="block h-12 w-12 cursor-zoom-in overflow-hidden rounded border border-amber-200/60 bg-muted shadow-sm dark:border-amber-500/20"
                                title={img.originalName}
                            >
                                <img
                                    src={resolveAssetUrl(img.url)}
                                    alt={img.originalName}
                                    className="h-full w-full object-cover"
                                    loading="lazy"
                                />
                            </button>
                        ))}
                        {extraImages > 0 && (
                            <span className="inline-flex h-12 min-w-[3rem] items-center justify-center rounded border border-dashed border-amber-300/70 bg-amber-50/60 px-1.5 text-[10px] font-semibold text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                                +{extraImages}
                            </span>
                        )}
                        {otherFiles > 0 && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/60 bg-amber-50/60 px-2 py-0.5 text-[10px] font-medium text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                                <Paperclip className="h-3 w-3" />
                                {otherFiles} file{otherFiles === 1 ? '' : 's'}
                            </span>
                        )}
                    </div>
                )}

                <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                    <span className="truncate">
                        {note.author?.name || 'Someone'}
                    </span>
                    <span className="flex items-center gap-1.5">
                        {note.createdAt
                            ? format(
                                  new Date(note.createdAt),
                                  'MMM d, HH:mm',
                              )
                            : ''}
                        <span
                            className="hidden text-amber-700 group-hover:inline dark:text-amber-300"
                            aria-hidden
                        >
                            · open ↗
                        </span>
                    </span>
                </div>
            </InnerTag>

            <ImageLightbox
                open={Boolean(lightbox)}
                src={lightbox?.src}
                alt={lightbox?.alt}
                onClose={() => setLightbox(null)}
            />

            {/* Small "expand" affordance, shown only when the inline
                preview is clamped — purely a visual cue; clicking
                anywhere on the card opens the same modal. */}
            {overflowing && (
                <span
                    aria-hidden
                    className="pointer-events-none absolute right-1 top-1 z-10 inline-flex h-5 w-5 items-center justify-center rounded border border-amber-300/70 bg-white/95 text-amber-700 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/20 dark:text-amber-200"
                >
                    <Maximize2 className="h-3 w-3" />
                </span>
            )}

            {/* Full-note modal — opened by clicking the card. */}
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-[480px]">
                    <DialogHeader>
                        <DialogTitle className="text-base">Note</DialogTitle>
                        <DialogDescription>
                            {note.author?.name || 'Someone'}
                            {note.createdAt &&
                                ` · ${format(
                                    new Date(note.createdAt),
                                    'MMM d, yyyy HH:mm',
                                )}`}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                        {note.content || (
                            <span className="italic text-muted-foreground">
                                (empty note)
                            </span>
                        )}
                    </div>

                    {images.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {images.map((img) => (
                                <button
                                    key={img.id}
                                    type="button"
                                    onClick={() =>
                                        setLightbox({
                                            src: img.url,
                                            alt: img.originalName,
                                        })
                                    }
                                    className="block h-16 w-16 cursor-zoom-in overflow-hidden rounded border bg-muted"
                                    title={img.originalName}
                                >
                                    <img
                                        src={resolveAssetUrl(img.url)}
                                        alt={img.originalName}
                                        className="h-full w-full object-cover"
                                        loading="lazy"
                                    />
                                </button>
                            ))}
                        </div>
                    )}

                    {otherFiles > 0 && (
                        <div className="border-t pt-2">
                            <NoteAttachmentsList
                                files={files.filter((f) => !isImageFile(f))}
                            />
                        </div>
                    )}

                    <DialogFooter className="flex-row justify-end gap-3">
                        {projectId && note.taskId && (
                            <Link
                                to={`/projects/${projectId}#task-${note.taskId}`}
                                onClick={() => setOpen(false)}
                                className="text-xs font-medium text-primary hover:underline"
                            >
                                Open task ↗
                            </Link>
                        )}
                        {projectId && (
                            <Link
                                to={`/projects/${projectId}#note-${note.id}`}
                                onClick={() => setOpen(false)}
                                className="text-xs font-medium text-primary hover:underline"
                            >
                                Open in Notes panel ↗
                            </Link>
                        )}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </li>
    );
}

// Same labels as TaskColumnHeader but rendered with the subtask palette
// so it visually flags the expanded sub-list.
function SubtaskColumnHeader() {
    return (
        <div
            className={cn(
                'grid items-stretch border-b border-indigo-300/60 bg-indigo-100 text-[10px] font-semibold uppercase tracking-wide text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-200',
                TASK_GRID_COLS,
            )}
            role="row"
        >
            <div className={cellCls('center')} aria-hidden />
            <div className={cellCls('center')} aria-hidden />
            <div className={cellCls('left')}>Subtask</div>
            <div className={cellCls('left')}>Due</div>
            <div className={cellCls('left')}>Status</div>
            <div className={cellCls('left')}>Priority</div>
            <div className={cellCls('left')}>Assignee</div>
            <div className={cellCls('right')}>Actions</div>
        </div>
    );
}

function TaskRow({
    task,
    users,
    canManage = false,
    // Narrower edit-only flag. When false the title click opens the
    // read-only quick-view dialog instead of the edit dialog —
    // important for users who hold ONLY `task:create:any` or
    // `task:delete:any` (they can manage tasks generally, but
    // shouldn't be able to MODIFY existing rows). Defaults to
    // `canManage` for callers that don't differentiate.
    canEditTask = canManage,
    // Delete-button gate (admin / manager / personal owner /
    // `task:delete:any`). Defaults to `canManage` for callers that
    // don't differentiate.
    canDeleteTask = canManage,
    // TRUE iff the user holds `task:create:any`. Combined with
    // `task.createdBy.id === currentUserId` lets THIS row decide
    // whether to expose Edit / Delete for tasks the current user
    // created themselves — no global edit-any rights needed.
    canManageOwnTasks = false,
    // `{ taskId, nonce }` — when `taskId === this row's task.id`
    // and the nonce changes, flash a 3-second ring animation so
    // the user can spot the task they just clicked from a
    // notification. See the matching prop doc on <PhasesPlan>.
    pulseTask = null,
    currentUserId = null,
    onStatus,
    onPriority,
    onAssignee,
    onEdit,
    onDuplicate,
    onDelete,
    onAddNote,
    // Per-task inline-notes toggle (independent of global/phase switch).
    onToggleNotes,
    notesOpen = false,
    noteCount = 0,
    onLogTime,
    onOpen,
    onProposeReassign,
    pendingReassignment = null,
    recentDecision = null,
    // When false, the row suppresses the inline reassignment surface:
    // the amber "Reassign requested" pill in the assignee cell AND
    // the decision banner beneath the row. The pending / decision
    // DATA is still received so the row can still drive the propose
    // button's disabled state — we just hide the visual badges. The
    // "Propose reassignment" button itself is intentionally NOT gated
    // by this flag (it's an action, not info), so users with rights
    // can still kick off a new proposal while badges are hidden.
    showReassignmentInfo = true,
    expandable = false,
    expanded = false,
    subCount = 0,
    onToggleExpand,
    onAddSubtask,
    isSubtask = false,
    zebraIndex = 0,
    // The CR currently being viewed (if any). When this matches the
    // task's `changeRequestId` we suppress the CR chip — it'd be
    // redundant noise inside a CR-scoped plan view. NULL means
    // we're rendering inside a project-level plan view and every
    // CR-bound task should show its chip.
    viewerChangeRequestId = null,
}) {
    const { find: findTaskStatus } = useTaskStatuses();
    const status =
        findTaskStatus(task.status) ||
        TASK_STATUS_MAP[task.status] ||
        TASK_STATUSES[0];
    const { find: findTaskPriority } = useTaskPriorities();
    const priority =
        findTaskPriority(task.priority) ||
        TASK_PRIORITY_MAP[task.priority] ||
        TASK_PRIORITIES[1];
    const due = formatDate(task.dueDate);
    const isAssignee = currentUserId && task.assigneeId === currentUserId;
    // "Did I create this row?" → unlocks Edit / Delete for
    // `task:create:any` holders on a per-row basis. We accept either
    // the embedded `createdBy.id` (from taskInclude) or the raw
    // `createdById` column so optimistic payloads stay compatible.
    const isOwnCreation =
        canManageOwnTasks &&
        currentUserId &&
        (task.createdBy?.id === currentUserId ||
            task.createdById === currentUserId);
    // Pulse this row whenever ProjectDetail tells us to (a
    // notification click landed on this task). We trigger on
    // (taskId, nonce) so a second click on the same notification
    // still pulses — without the nonce we'd only pulse on the
    // first navigation. The 4.7s window matches the 4.5s
    // `taskPulse` keyframe duration in `index.css` plus a small
    // buffer so the class is removed only after the animation
    // has fully wound down.
    const [pulsing, setPulsing] = useState(false);
    useEffect(() => {
        if (!pulseTask || pulseTask.taskId !== task.id) return;
        // Don't re-enter mid-animation — re-trigger by toggling
        // the class off then back on inside the same effect.
        setPulsing(false);
        const showTimer = requestAnimationFrame(() => setPulsing(true));
        const hideTimer = setTimeout(() => setPulsing(false), 4700);
        // Best-effort scroll into view so the pulse is actually
        // visible even when the task lives far below the fold.
        // Subtasks mount only after the parent expand state updates,
        // so retry briefly instead of giving up on the first frame.
        let cancelSpotlight = () => {};
        let scrollTimer = 0;
        let retryTimer = 0;
        let attempts = 0;
        const maxAttempts = task.parentTaskId ? 16 : 4;
        const runScrollAndSpotlight = () => {
            const el = document.getElementById(`task-${task.id}`);
            if (!el) {
                if (attempts < maxAttempts) {
                    attempts += 1;
                    retryTimer = window.setTimeout(runScrollAndSpotlight, 50);
                }
                return;
            }
            const r = el.getBoundingClientRect();
            const margin = 96;
            const inView =
                r.top >= -margin &&
                r.bottom <= window.innerHeight + margin;
            if (!inView) {
                el.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                });
            }
            cancelSpotlight = spotlightElement(el, {
                duration: 1300,
                padding: 4,
                delay: 500,
            });
        };
        scrollTimer = requestAnimationFrame(runScrollAndSpotlight);
        return () => {
            cancelAnimationFrame(showTimer);
            cancelAnimationFrame(scrollTimer);
            clearTimeout(hideTimer);
            clearTimeout(retryTimer);
            cancelSpotlight();
        };
    }, [pulseTask?.taskId, pulseTask?.nonce, task.id, task.parentTaskId]);

    // Effective edit / delete flags for THIS specific row.
    //   - rowCanEdit  -> title click goes to the edit dialog, the
    //                    inline priority / assignee dropdowns are
    //                    interactive, and the "Edit task" button on
    //                    the description popover is shown.
    //   - rowCanDelete -> the trash icon is rendered.
    // Both fall through to the broader project-wide flag; the
    // own-creation overlay unlocks BOTH for the rows the user
    // actually created themselves.
    const rowCanEdit = canEditTask || isOwnCreation;
    const rowCanDelete = canDeleteTask || isOwnCreation;
    // Status can be toggled by admins OR by the task's assignee.
    // For status the broad `canManage` flag is fine — any cap holder
    // (create / edit / delete) is allowed to flip a status the BE
    // also lets through.
    // A "specific" task is locked in To-do until an approver signs off:
    // the backend rejects any status change (403) while it's unapproved,
    // so we disable the status controls up front for a clean UX.
    const isApprovalLocked = Boolean(task.specific && !task.approvedAt);
    const canChangeStatus =
        !isApprovalLocked && (canManage || isOwnCreation || isAssignee);

    // Distinct row tones so the user can pick out tasks vs subtasks at a
    // glance. Tasks get a clearly-tinted amber stripe; subtasks
    // alternate between two indigo tints with much stronger contrast
    // so the zebra effect is impossible to miss.
    const rowTone = isSubtask
        ? zebraIndex % 2 === 0
            ? 'bg-indigo-50 dark:bg-indigo-500/[0.12]'
            : 'bg-indigo-100 dark:bg-indigo-500/[0.22]'
        : 'bg-amber-100/70 dark:bg-amber-500/[0.14]';

    const isDone = task.status === 'DONE';

    // Task descriptions render single-line-truncated next to the
    // title so the row stays compact. For non-trivial descriptions
    // that's a problem — even the assignee can't read the full
    // text without opening the edit dialog (and read-only users
    // can't open it at all). We detect horizontal overflow on the
    // truncated <p> and surface a "Read full description" popover
    // anchored to the description itself, so clicking it shows the
    // whole content inline without leaving the plan view.
    //
    // We deliberately use a CALLBACK ref (not useRef + useEffect)
    // because the ref target swaps between a <p> and a <button>
    // when overflow transitions; a callback ref re-runs on every
    // mount/unmount, which is the only way to keep the
    // ResizeObserver attached to whichever node is currently in
    // the DOM. The same code also re-checks on column resize
    // (sidebar collapse, viewport changes, etc.) so the affordance
    // appears/disappears as the available width changes — not just
    // when the description text itself changes.
    const [descOverflowing, setDescOverflowing] = useState(false);
    const descObserverRef = useRef(null);
    const descRef = useCallback((node) => {
        if (descObserverRef.current) {
            descObserverRef.current.disconnect();
            descObserverRef.current = null;
        }
        if (!node) {
            setDescOverflowing(false);
            return;
        }
        const check = () => {
            setDescOverflowing(node.scrollWidth - node.clientWidth > 1);
        };
        check();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(check);
        ro.observe(node);
        descObserverRef.current = ro;
    }, []);
    useEffect(() => () => descObserverRef.current?.disconnect(), []);

    // Recent reassignment decision the current user is involved in
    // (proposer or previous assignee). When set, render a small banner
    // beneath the row so the reviewer's note actually reaches them.
    // Respect the per-phase / global "Show reassignment info" toggle —
    // when it's off the banner is suppressed even if a decision exists.
    const decisionBanner =
        recentDecision && showReassignmentInfo ? (
            <ReassignDecisionBanner decision={recentDecision} />
        ) : null;

    return (
        <div
            id={`task-${task.id}`}
            className={cn(
                'scroll-mt-24 rounded-md',
                rowTone,
                // "Specific" (approval-required) tasks get a subtle
                // violet left-accent stripe plus a very faint tint so
                // they read as distinct from normal tasks at a glance.
                // Subtasks are never specific, so this only ever hits
                // top-level task rows. Kept deliberately understated so
                // it doesn't fight the status chip or selected/hover.
                task.specific &&
                    'border-l-2 border-l-violet-400 dark:border-l-violet-500/70',
                task.specific &&
                    'bg-violet-500/[0.04] dark:bg-violet-500/[0.07]',
                // The `task-pulse` animation is defined in
                // index.css — see `@keyframes taskPulse`. It runs
                // for 3s, drawing a primary-coloured outline that
                // ramps up then fades. The outer wrapper carries
                // it so the highlight visually contains the whole
                // grid row (including subtasks below it would be
                // wrong — we keep this scoped to THIS task div).
                pulsing && 'task-pulse',
            )}
        >
        <div
            className={cn(
                'grid items-stretch transition-colors hover:bg-muted/40',
                TASK_GRID_COLS,
            )}
        >
            <div className={cellCls('center')}>
                {expandable ? (
                    <button
                        type="button"
                        onClick={onToggleExpand}
                        className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                        title={
                            expanded ? 'Collapse subtasks' : 'Expand subtasks'
                        }
                        aria-label={
                            expanded ? 'Collapse subtasks' : 'Expand subtasks'
                        }
                    >
                        {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                        )}
                    </button>
                ) : (
                    <span className="flex h-6 w-6 items-center justify-center text-muted-foreground/50">
                        <GitBranch className="h-3 w-3" />
                    </span>
                )}
            </div>

            {/*
              Checkbox affordance for "done". Reuses the existing
              status-change permission so admins (and a task's own
              assignee) can flip it; everyone else sees a read-only
              checkbox. Clicking toggles DONE <-> TODO.
            */}
            <div className={cellCls('center')}>
                <button
                    type="button"
                    onClick={() =>
                        canChangeStatus && onStatus(isDone ? 'TODO' : 'DONE')
                    }
                    disabled={!canChangeStatus}
                    className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors',
                        isDone
                            ? 'border-emerald-500 bg-emerald-500 text-white'
                            : 'border-muted-foreground/40 bg-card hover:border-emerald-500',
                        !canChangeStatus && 'cursor-not-allowed opacity-60',
                    )}
                    aria-pressed={isDone}
                    aria-label={isDone ? 'Mark as not done' : 'Mark as done'}
                    title={isDone ? 'Mark as not done' : 'Mark as done'}
                >
                    {isDone && <Check className="h-3.5 w-3.5" />}
                </button>
            </div>

            <div className={cn(cellCls('left'), 'min-w-0')}>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                        {task.code && (
                            <span
                                className="shrink-0 rounded border border-border bg-muted/60 px-1 py-px font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
                                title={
                                    task.parentTaskId
                                        ? 'Subtask code'
                                        : 'Task code'
                                }
                            >
                                {task.code}
                            </span>
                        )}
                        {task.sprintId && task.sprint && (
                            <span
                                className="inline-flex shrink-0 items-center gap-0.5 rounded border border-violet-500/30 bg-violet-500/10 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-violet-700 dark:text-violet-300"
                                title={`In sprint: ${task.sprint.name}`}
                            >
                                <span className="font-mono">↯</span>
                                <span className="max-w-[110px] truncate">
                                    {task.sprint.name}
                                </span>
                            </span>
                        )}
                        {/* "Specific" chip: emerald once approved,
                            rose if disapproved (still locked, with the
                            reason as a tooltip), amber while pending. */}
                        {task.specific &&
                            (task.approvedAt ? (
                                <span
                                    className="inline-flex shrink-0 items-center gap-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300"
                                    title={
                                        task.approvedBy
                                            ? `Approved by ${task.approvedBy.name} on ${format(new Date(task.approvedAt), 'd MMM yyyy')}`
                                            : 'Approved'
                                    }
                                >
                                    <CheckCircle2 className="h-3 w-3" />
                                    Approved
                                </span>
                            ) : task.rejectedAt ? (
                                <span
                                    className="inline-flex shrink-0 items-center gap-0.5 rounded border border-rose-500/30 bg-rose-500/10 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300"
                                    title={
                                        task.rejectionReason
                                            ? `Disapproved${task.rejectedBy ? ` by ${task.rejectedBy.name}` : ''} — ${task.rejectionReason}`
                                            : 'Disapproved — locked in To-do until approved'
                                    }
                                >
                                    <XCircle className="h-3 w-3" />
                                    Disapproved
                                </span>
                            ) : (
                                <span
                                    className="inline-flex shrink-0 items-center gap-0.5 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300"
                                    title="Specific task — locked in To-do until approved"
                                >
                                    <Lock className="h-3 w-3" />
                                    Pending approval
                                </span>
                            ))}
                        {/* CR chip: only shown when this task belongs
                            to a CR AND we're not already viewing that
                            CR (would be redundant). Clickable — jumps
                            to the CR detail page. Uses task.projectId
                            for the URL since the parent project id is
                            always present on a task row. */}
                        {task.changeRequestId &&
                        task.changeRequest &&
                        task.changeRequestId !== viewerChangeRequestId ? (
                            <Link
                                to={`/projects/${task.projectId}/cr/${task.changeRequestId}`}
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex shrink-0 items-center gap-0.5 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
                                title={`In change request: ${task.changeRequest.title}`}
                            >
                                <span className="font-mono">CR</span>
                                <span className="max-w-[110px] truncate">
                                    {task.changeRequest.code
                                        ? task.changeRequest.code
                                              .split('-CR-')
                                              .slice(-1)[0]
                                        : task.changeRequest.title}
                                </span>
                            </Link>
                        ) : null}
                        {rowCanEdit ? (
                            <button
                                type="button"
                                onClick={onEdit}
                                className={cn(
                                    'block min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline',
                                    isDone &&
                                        'text-muted-foreground line-through',
                                )}
                            >
                                {task.title}
                            </button>
                        ) : onOpen ? (
                            <button
                                type="button"
                                onClick={() => onOpen('note')}
                                className={cn(
                                    'block min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline hover:text-primary',
                                    isDone &&
                                        'text-muted-foreground line-through',
                                )}
                                title="View task details"
                            >
                                {task.title}
                            </button>
                        ) : (
                            <span
                                className={cn(
                                    'block min-w-0 flex-1 truncate text-left text-sm font-medium',
                                    isDone &&
                                        'text-muted-foreground line-through',
                                )}
                            >
                                {task.title}
                            </span>
                        )}
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        {task.description && (
                            <div className="flex min-w-0 max-w-full items-center gap-1">
                                {/* The <p> is always rendered (with the
                                  ref attached) so we can measure
                                  overflow. When overflow is detected
                                  the same node becomes a Popover
                                  trigger; otherwise it stays a plain
                                  paragraph and behaves exactly like
                                  before. */}
                                {descOverflowing ? (
                                    <Popover>
                                        <PopoverTrigger asChild>
                                            <button
                                                type="button"
                                                className="block min-w-0 max-w-full truncate cursor-help rounded text-left text-xs text-muted-foreground decoration-dotted underline-offset-2 hover:text-foreground hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                                title="Read full description"
                                            >
                                                <span ref={descRef} className="block truncate">
                                                    {task.description}
                                                </span>
                                            </button>
                                        </PopoverTrigger>
                                        <PopoverContent
                                            side="bottom"
                                            align="start"
                                            className="w-80 max-w-[90vw]"
                                            onOpenAutoFocus={(e) => e.preventDefault()}
                                        >
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between gap-2 border-b pb-2">
                                                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                                        Description
                                                    </span>
                                                    {rowCanEdit && (
                                                        <button
                                                            type="button"
                                                            onClick={onEdit}
                                                            className="text-[11px] text-primary hover:underline"
                                                        >
                                                            Edit task
                                                        </button>
                                                    )}
                                                </div>
                                                <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                                                    {task.description}
                                                </div>
                                            </div>
                                        </PopoverContent>
                                    </Popover>
                                ) : (
                                    <p
                                        ref={descRef}
                                        className="block min-w-0 max-w-full truncate text-xs text-muted-foreground"
                                    >
                                        {task.description}
                                    </p>
                                )}
                            </div>
                        )}
                        {expandable && subCount > 0 && (
                            <span className="text-[10px] text-muted-foreground">
                                {subCount} subtask{subCount === 1 ? '' : 's'}
                            </span>
                        )}
                        {/* Creator chip — ALWAYS surfaces the user
                            who created this task / subtask. The
                            user explicitly asked for this pill to be
                            mandatory on every row (parents + sub-
                            tasks) so accountability is visible at a
                            glance without opening the row. We pull
                            from `task.createdBy` (joined into
                            taskInclude on the BE); for the rare
                            legacy row predating the column we still
                            render the pill but with an "unknown"
                            label so the column doesn't visually
                            drop out for some rows but not others —
                            consistency beats prettiness here. The
                            tooltip carries the full name, email
                            and exact timestamp so the chip stays
                            tiny while remaining auditable on
                            hover. */}
                        {(() => {
                            const creatorName =
                                task.createdBy?.name ||
                                task.createdBy?.email ||
                                '';
                            const firstName =
                                creatorName.split(' ')[0] || 'unknown';
                            const creatorId =
                                task.createdBy?.id ||
                                task.createdById ||
                                null;
                            const tooltip = task.createdBy
                                ? `Created by ${
                                      task.createdBy.name ||
                                      task.createdBy.email ||
                                      'Unknown'
                                  }${
                                      task.createdAt
                                          ? ` · ${new Date(
                                                task.createdAt,
                                            ).toLocaleString()}`
                                          : ''
                                  }${
                                      creatorId
                                          ? ' · click to open profile'
                                          : ''
                                  }`
                                : `Creator unknown${
                                      task.createdAt
                                          ? ` · ${new Date(
                                                task.createdAt,
                                            ).toLocaleString()}`
                                          : ''
                                  }`;
                            // When we have a creator ID the pill links
                            // to that user's profile page; the link
                            // form stops row-click bubbling so the
                            // task quick-view doesn't open at the same
                            // time. When we don't have an ID (legacy
                            // row pre-backfill) we render the plain
                            // pill so the layout stays consistent.
                            const className =
                                'inline-flex items-center gap-1 rounded border border-border/60 bg-muted/40 px-1 py-px text-[10px] text-muted-foreground';
                            const createdOn = task.createdAt
                                ? new Date(task.createdAt).toLocaleDateString(
                                      undefined,
                                      { day: '2-digit', month: 'short' },
                                  )
                                : '';
                            const body = (
                                <>
                                    <UserIcon className="h-2.5 w-2.5" />
                                    <span className="max-w-[110px] truncate">
                                        by {firstName}
                                    </span>
                                    {createdOn && (
                                        <span className="opacity-70">
                                            · {createdOn}
                                        </span>
                                    )}
                                </>
                            );
                            if (creatorId) {
                                return (
                                    <Link
                                        to={`/users/${creatorId}`}
                                        title={tooltip}
                                        className={cn(
                                            className,
                                            'transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary',
                                        )}
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {body}
                                    </Link>
                                );
                            }
                            return (
                                <span className={className} title={tooltip}>
                                    {body}
                                </span>
                            );
                        })()}
                    </div>
                </div>
            </div>

            <div className={cellCls('left')}>
                <span className="truncate text-xs text-muted-foreground">
                    {due || '—'}
                </span>
            </div>

            <div className={cellCls('left')}>
                {canChangeStatus ? (
                    <StatusRowSelect
                        value={task.status}
                        onChange={onStatus}
                        fallbackStatus={status}
                    />
                ) : (
                    <Badge
                        variant={status.badge}
                        className="text-[10px]"
                        title={
                            isApprovalLocked
                                ? 'Approve to unlock the status'
                                : undefined
                        }
                    >
                        {status.label}
                    </Badge>
                )}
            </div>

            <div className={cellCls('left')}>
                {rowCanEdit ? (
                    <PriorityRowSelect
                        value={task.priority}
                        onChange={onPriority}
                        fallbackPriority={priority}
                    />
                ) : (
                    <Badge variant={priority.badge} className="text-[10px]">
                        {priority.label}
                    </Badge>
                )}
            </div>

            <div
                className={cn(
                    cellCls('left'),
                    'flex-col items-start justify-center gap-1',
                )}
            >
                {pendingReassignment && showReassignmentInfo && (
                    <span
                        className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 ring-1 ring-amber-300 dark:bg-amber-500/15 dark:text-amber-200"
                        title={`Reassignment proposed by ${pendingReassignment.proposer?.name || pendingReassignment.proposer?.email || 'someone'} — awaiting review`}
                    >
                        <UserCog className="h-3 w-3" />
                        Reassign requested
                    </span>
                )}
                {rowCanEdit ? (
                    <SearchableSelect
                        value={task.assigneeId || NO_ASSIGNEE}
                        onChange={onAssignee}
                        searchPlaceholder="Search users…"
                        placeholder={isSubtask ? 'No participant' : 'Unassigned'}
                        emptyText={
                            isSubtask
                                ? 'Add a project participant first'
                                : 'No users available'
                        }
                        className="h-7 w-auto gap-1 border-none bg-transparent px-1"
                        contentClassName="w-56"
                        options={[
                            {
                                value: NO_ASSIGNEE,
                                label: isSubtask
                                    ? 'No participant'
                                    : 'Unassigned',
                            },
                            ...users.map((u) => ({
                                value: u.id,
                                label: u.name,
                                icon: <UserAvatar user={u} />,
                            })),
                        ]}
                    />
                ) : task.assignee ? (
                    // Read-only view (e.g. USER role): make the
                    // assignee chip a profile link so any signed-in
                    // teammate can jump straight to who's on this
                    // task. Editors get the Select dropdown above
                    // instead, which is a separate interaction.
                    <Link
                        to={`/users/${task.assignee.id}`}
                        title={`View ${task.assignee.name}'s profile`}
                        className="flex min-w-0 items-center gap-1.5 rounded px-1 text-xs hover:bg-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <Avatar className="h-5 w-5 shrink-0">
                            {task.assignee.avatarUrl && (
                                <AvatarImage
                                    src={resolveAssetUrl(task.assignee.avatarUrl)}
                                    alt={task.assignee.name}
                                />
                            )}
                            <AvatarFallback className="bg-primary/10 text-[8px] text-primary">
                                {initials(task.assignee.name)}
                            </AvatarFallback>
                        </Avatar>
                        <span className="truncate">{task.assignee.name}</span>
                    </Link>
                ) : (
                    <span className="px-1 text-xs text-muted-foreground">
                        Unassigned
                    </span>
                )}
            </div>

            <div className={cn(cellCls('right'), 'gap-0.5')}>
                {/* Anyone with project read access can leave a note pinned
                    to this task or subtask — both manage and read-only
                    users use the same small TaskNoteDialog. */}
                {onAddNote && (
                    <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        onClick={onAddNote}
                        title="Leave a note about this task"
                        aria-label="Leave a note"
                    >
                        <MessageSquarePlus className="h-3.5 w-3.5" />
                    </Button>
                )}
                {/* Per-task show/hide notes — read this task's notes
                    inline without turning on notes for the whole plan. */}
                {onToggleNotes && (
                    <Button
                        size="icon"
                        variant="ghost"
                        className={cn(
                            'relative h-7 w-7 text-muted-foreground hover:text-primary',
                            notesOpen && 'text-primary',
                        )}
                        onClick={onToggleNotes}
                        title={notesOpen ? 'Hide notes' : 'Show notes'}
                        aria-label={notesOpen ? 'Hide notes' : 'Show notes'}
                    >
                        {notesOpen ? (
                            <MessageSquareOff className="h-3.5 w-3.5" />
                        ) : (
                            <MessageSquare className="h-3.5 w-3.5" />
                        )}
                        {!notesOpen && noteCount > 0 && (
                            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-bold text-primary-foreground">
                                {noteCount}
                            </span>
                        )}
                    </Button>
                )}
                {/* Log time: shown for admins/managers and for the
                    task's own assignee. Both use the standalone
                    LogTimeDialog (small focused form). */}
                {(canManage || isAssignee) && onLogTime && (
                    <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        onClick={onLogTime}
                        title="Log time on this task"
                        aria-label="Log time"
                    >
                        <Clock className="h-3.5 w-3.5" />
                    </Button>
                )}
                {/* Reassignment proposal — anyone with read access can
                    suggest a new assignee. The button hides while a
                    proposal is already pending review (the badge near
                    the assignee column carries the same info). */}
                {onProposeReassign && !pendingReassignment && (
                    <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-primary"
                        onClick={onProposeReassign}
                        title="Propose to reassign this task"
                        aria-label="Propose reassignment"
                    >
                        <UserCog className="h-3.5 w-3.5" />
                    </Button>
                )}
                {canManage && expandable && (
                    <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        onClick={onAddSubtask}
                        title="Add subtask"
                        aria-label="Add subtask"
                    >
                        <Plus className="h-3.5 w-3.5" />
                    </Button>
                )}
                {rowCanEdit && onDuplicate && (
                    <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-primary disabled:opacity-40"
                        onClick={onDuplicate}
                        disabled={Boolean(task.specific)}
                        title={
                            task.specific
                                ? "Specific tasks can't be duplicated"
                                : 'Duplicate this task'
                        }
                        aria-label="Duplicate task"
                    >
                        <Copy className="h-3.5 w-3.5" />
                    </Button>
                )}
                {rowCanDelete && (
                    <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={onDelete}
                        aria-label="Delete"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                )}
            </div>
        </div>
        {decisionBanner}
        </div>
    );
}

// Inline strip beneath a task showing the reviewer's decision on a
// recent reassignment proposal involving the current user. Approved
// rows go green, declined go rose. The reason / decision note is
// rendered verbatim so the requester actually sees the feedback.
function ReassignDecisionBanner({ decision }) {
    const approved = decision.status === 'APPROVED';
    const reviewer = decision.decidedBy;
    const reviewerName =
        reviewer?.name || reviewer?.email || 'A reviewer';
    const target =
        decision.toAssignee?.name || decision.toAssignee?.email || null;
    const note = (decision.decisionNote || '').trim();
    const tone = approved
        ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200'
        : 'border-rose-300 bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200';
    return (
        <div
            className={cn(
                'flex flex-wrap items-start gap-2 border-t px-3 py-1.5 text-xs',
                tone,
            )}
        >
            <UserCog className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 flex-1 space-y-0.5">
                <div className="font-medium">
                    {approved
                        ? `Reassignment approved${
                              target ? ` — now assigned to ${target}` : ''
                          }`
                        : 'Reassignment declined'}
                    <span className="ml-1 font-normal opacity-75">
                        by {reviewerName}
                    </span>
                </div>
                {note ? (
                    <div className="whitespace-pre-wrap">
                        <span className="opacity-70">Note:</span> {note}
                    </div>
                ) : (
                    <div className="opacity-70">No note from the reviewer.</div>
                )}
            </div>
        </div>
    );
}

// Quick "leave a note about this task" dialog. The created note lives on
// the project's notes panel with the task pinned to it (see backend
// notes.js).
function TaskNoteDialog({
    state,
    projectId,
    participants = [],
    onClose,
    onSubmit,
}) {
    const [content, setContent] = useState('');
    const [files, setFiles] = useState([]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (state.open) {
            setContent('');
            setFiles([]);
        }
    }, [state.open, state.task?.id]);

    const submit = async (e) => {
        e.preventDefault();
        const text = content.trim();
        if (!text) return;
        setSaving(true);
        try {
            await onSubmit({ content: text, fileIds: files.map((f) => f.id) });
        } finally {
            setSaving(false);
        }
    };

    const task = state.task;
    return (
        <Dialog open={state.open} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Note about this task</DialogTitle>
                    <DialogDescription>
                        Pinned to{' '}
                        <strong className="text-foreground">
                            {task?.title}
                        </strong>
                        . Visible on the project's Notes tab.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="space-y-3">
                    <MentionTextarea
                        rows={4}
                        autoFocus
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        participants={participants}
                        slashProjectId={projectId}
                        placeholder="What's on your mind? Type @ to mention a participant or / to link a task."
                    />
                    <NoteAttachmentsField
                        projectId={projectId}
                        files={files}
                        onChange={setFiles}
                        disabled={saving}
                    />
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving || !content.trim()}>
                            {saving ? 'Saving…' : 'Add note'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

// Sentinel value for the "Custom name…" dropdown option.
const CUSTOM_PHASE_VALUE = '__custom__';

function PhaseDialog({ state, existingPhases = [], onClose, onSubmit }) {
    const [name, setName] = useState('');
    // Names that already exist in this project — used to grey them out
    // so admins don't accidentally duplicate a phase.
    const existingNames = useMemo(
        () => new Set(existingPhases.map((p) => (p.name || '').toLowerCase())),
        [existingPhases],
    );
    // Library of phase templates the admin defined globally. Loaded once
    // when the dialog opens so the dropdown is fresh.
    const [templates, setTemplates] = useState([]);
    const [picked, setPicked] = useState(CUSTOM_PHASE_VALUE);

    useEffect(() => {
        if (!state.open) return;
        setName(state.phase?.name || '');
        setPicked(CUSTOM_PHASE_VALUE);
        // For an "Add phase" flow we offer the template dropdown; for
        // rename we just need a free-text field, so skip the fetch.
        if (state.phase) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await api.get('/templates/phases');
                if (!cancelled) setTemplates(res.data.phases || []);
            } catch {
                /* dropdown is optional — silent failure */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [state.open, state.phase]);

    const isEditing = Boolean(state.phase);

    const submit = (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        // Forward the template's colour if the admin picked one from
        // the library — that way new phases inherit the admin-picked
        // template colour instead of falling back to the hash-derived
        // auto colour. `null` is fine for "custom name"; the BE treats
        // missing/null as "use auto".
        const pickedTemplate =
            picked !== CUSTOM_PHASE_VALUE
                ? templates.find((t) => t.id === picked)
                : null;
        onSubmit({
            id: state.phase?.id,
            name: name.trim(),
            color: pickedTemplate?.color || null,
        });
    };

    return (
        <Dialog open={state.open} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {isEditing ? 'Rename phase' : 'New phase'}
                    </DialogTitle>
                    <DialogDescription>
                        {isEditing
                            ? 'Update the phase name for this project.'
                            : 'Pick from the workspace library or type a custom name.'}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="space-y-4">
                    {!isEditing && templates.length > 0 && (
                        <div className="space-y-2">
                            <Label>From library</Label>
                            <Select
                                value={picked}
                                onValueChange={(v) => {
                                    setPicked(v);
                                    if (v !== CUSTOM_PHASE_VALUE) {
                                        const found = templates.find(
                                            (t) => t.id === v,
                                        );
                                        if (found) setName(found.name);
                                    } else {
                                        setName('');
                                    }
                                }}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Pick a template" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={CUSTOM_PHASE_VALUE}>
                                        Custom name…
                                    </SelectItem>
                                    {templates.map((t) => {
                                        const taken = existingNames.has(
                                            t.name.toLowerCase(),
                                        );
                                        return (
                                            <SelectItem
                                                key={t.id}
                                                value={t.id}
                                                disabled={taken}
                                            >
                                                {t.name}
                                                {taken ? ' (already added)' : ''}
                                            </SelectItem>
                                        );
                                    })}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                    <div className="space-y-2">
                        <Label htmlFor="phase-name">Name</Label>
                        <Input
                            id="phase-name"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Implementation"
                            autoFocus
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit">
                            {isEditing ? 'Save' : 'Add phase'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function TaskDialog({
    state,
    phases,
    users,
    participants,
    canCreateSpecific = false,
    onClose,
    onSubmit,
}) {
    const isEdit = Boolean(state.task);
    const isSubtaskCreate = Boolean(state.parentTask);
    const editingSubtask = Boolean(state.task?.parentTaskId);
    const isSubtaskMode = isSubtaskCreate || editingSubtask;

    const parentPhase = useMemo(() => {
        if (state.parentTask) {
            return phases.find((p) => p.id === state.parentTask.phaseId) || null;
        }
        if (state.task?.parentTaskId) {
            return phases.find((p) => p.id === state.task.phaseId) || null;
        }
        return null;
    }, [state.parentTask, state.task, phases]);

    // Subtask assignees are limited to project participants per the spec, so
    // the dropdown swaps its source list when creating/editing a subtask.
    const assigneeOptions = isSubtaskMode ? participants : users;

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [status, setStatus] = useState('TODO');
    const [priority, setPriority] = useState('MEDIUM');
    const [phaseId, setPhaseId] = useState('');
    const [assigneeId, setAssigneeId] = useState(NO_ASSIGNEE);
    const [dueDate, setDueDate] = useState('');
    // Sprint-planning estimate, in hours. Stored as a string in form
    // state so an empty input round-trips to `null` on the wire (the
    // backend coerces "" → null). Drives the burndown chart's
    // totalHours — without it, a sprint can never burn down.
    const [estimateHours, setEstimateHours] = useState('');
    // "Specific" tasks need an approval before they can leave To-do.
    // Subtasks are never specific — the flag lives on top-level tasks.
    const [specific, setSpecific] = useState(false);
    // Once approved, the "specific" flag is frozen (a decision of record)
    // — the toggle goes read-only for everyone, requester included.
    const specificLocked = Boolean(state.task?.specific && state.task?.approvedAt);

    useEffect(() => {
        if (!state.open) return;
        const t = state.task;
        setTitle(t?.title || '');
        setDescription(t?.description || '');
        setStatus(t?.status || 'TODO');
        setPriority(t?.priority || 'MEDIUM');
        setPhaseId(t?.phaseId || state.phaseId || '');
        setAssigneeId(t?.assigneeId || NO_ASSIGNEE);
        setDueDate(dateToInput(t?.dueDate));
        setEstimateHours(
            t?.estimateHours != null ? String(t.estimateHours) : '',
        );
        setSpecific(Boolean(t?.specific));
    }, [state]);

    const submit = (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        const payload = {
            title: title.trim(),
            description: description || null,
            status,
            priority,
            assigneeId: assigneeId === NO_ASSIGNEE ? null : assigneeId,
            dueDate: dateFromInput(dueDate),
            // Empty string → null so the task is treated as
            // "unestimated" rather than "0 hours of work".
            estimateHours:
                estimateHours.trim() === '' ? null : Number(estimateHours),
        };
        if (isSubtaskCreate) {
            payload.parentTaskId = state.parentTask.id;
        } else if (!editingSubtask) {
            payload.phaseId = phaseId || null;
            // Only top-level tasks carry the "specific / needs approval"
            // flag — subtasks inherit their parent's workflow.
            payload.specific = specific;
        }
        onSubmit({
            id: state.task?.id,
            payload,
            parentTaskId: payload.parentTaskId || state.task?.parentTaskId || null,
        });
    };

    const titleLabel = isSubtaskCreate
        ? `New subtask under "${state.parentTask?.title}"`
        : isEdit
            ? editingSubtask
                ? 'Edit subtask'
                : 'Edit task'
            : 'New task';

    return (
        <Dialog open={state.open} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{titleLabel}</DialogTitle>
                    <DialogDescription>
                        {isSubtaskMode
                            ? 'Subtasks inherit the parent task\u2019s phase and can only be assigned to project participants.'
                            : isEdit
                                ? 'Update task details.'
                                : 'Add a new task to this project.'}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="t-title">Title</Label>
                        <Input
                            id="t-title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            autoFocus
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="t-desc">Description</Label>
                        <Textarea
                            id="t-desc"
                            rows={3}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                        />
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label>Phase</Label>
                            {isSubtaskMode ? (
                                <Input
                                    value={parentPhase?.name || 'No phase'}
                                    readOnly
                                    className="bg-muted/40"
                                />
                            ) : (
                                <Select
                                    value={phaseId || NO_PHASE}
                                    onValueChange={(v) =>
                                        setPhaseId(v === NO_PHASE ? '' : v)
                                    }
                                >
                                    <SelectTrigger>
                                        <SelectValue placeholder="No phase" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={NO_PHASE}>No phase</SelectItem>
                                        {phases.map((p) => (
                                            <SelectItem key={p.id} value={p.id}>
                                                {p.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label>Assignee</Label>
                            <SearchableSelect
                                value={assigneeId}
                                onChange={setAssigneeId}
                                searchPlaceholder="Search users…"
                                placeholder="Unassigned"
                                className="h-9"
                                contentClassName="w-64"
                                emptyText={
                                    isSubtaskMode
                                        ? 'No project participants yet'
                                        : 'No users available'
                                }
                                options={[
                                    { value: NO_ASSIGNEE, label: 'Unassigned' },
                                    ...assigneeOptions.map((u) => ({
                                        value: u.id,
                                        label: u.name,
                                        icon: <UserAvatar user={u} />,
                                    })),
                                ]}
                            />
                            {isSubtaskMode && (
                                <p className="text-[11px] text-muted-foreground">
                                    Limited to project participants.
                                </p>
                            )}
                        </div>
                    </div>
                    {/* Status + Priority on row one, Due date +
                        Estimate on row two. A 4-column layout would
                        squeeze the native date picker too narrow to
                        be usable on smaller modals — splitting into
                        two rows keeps each input at a sensible width
                        without growing the dialog. */}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label>Status</Label>
                            <StatusFormSelect value={status} onChange={setStatus} />
                        </div>
                        <div className="space-y-2">
                            <Label>Priority</Label>
                            <PriorityFormSelect
                                value={priority}
                                onChange={setPriority}
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="t-due">Due date</Label>
                            <Input
                                id="t-due"
                                type="date"
                                value={dueDate}
                                onChange={(e) => setDueDate(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label
                                htmlFor="t-est"
                                className="flex items-center gap-1.5"
                            >
                                Estimate (h)
                                <Tip variant="tip" side="top">
                                    <p className="font-medium">
                                        Drives both burndown and capacity.
                                    </p>
                                    <p className="mt-1 text-muted-foreground">
                                        The sprint burndown chart uses
                                        this as the total work-to-do
                                        baseline. The capacity heatmap
                                        sums it per assignee. Leave
                                        blank for spikes / research
                                        tasks where the goal is to
                                        discover the estimate.
                                    </p>
                                </Tip>
                            </Label>
                            <Input
                                id="t-est"
                                type="number"
                                min={0}
                                max={1000}
                                step="0.25"
                                placeholder="e.g. 2.5"
                                value={estimateHours}
                                onChange={(e) =>
                                    setEstimateHours(e.target.value)
                                }
                            />
                            <p className="text-[10px] text-muted-foreground">
                                Drives the sprint burndown. Leave
                                empty if not estimated.
                            </p>
                        </div>
                    </div>
                    {!isSubtaskMode && (canCreateSpecific || specific) && (
                        <label
                            className={cn(
                                'flex items-start gap-2.5 rounded-md border bg-muted/30 px-3 py-2',
                                (specificLocked || !canCreateSpecific) &&
                                    'opacity-90',
                            )}
                        >
                            <Switch
                                checked={specific}
                                onCheckedChange={setSpecific}
                                className="mt-0.5"
                                // Frozen once approved (a decision of record),
                                // and unavailable to users who lack the
                                // `task:specific:create` capability (they can
                                // still SEE the state on an existing specific
                                // task, just not change it).
                                disabled={specificLocked || !canCreateSpecific}
                                aria-label="Mark as a specific task that needs approval"
                            />
                            <span className="min-w-0 space-y-0.5 text-left">
                                <span className="block text-sm font-medium">
                                    Specific (needs approval)
                                </span>
                                {specificLocked ? (
                                    <span className="block text-[11px] text-emerald-600 dark:text-emerald-400">
                                        Approved
                                        {state.task?.approvedBy
                                            ? ` by ${state.task.approvedBy.name}`
                                            : ''}
                                        {state.task?.approvedAt
                                            ? ` on ${format(new Date(state.task.approvedAt), 'd MMM yyyy')}`
                                            : ''}
                                        {' '}— this can no longer be changed.
                                    </span>
                                ) : (
                                    <span className="block text-[11px] text-muted-foreground">
                                        Locks the task in To-do until an approver
                                        signs off. Specific tasks can't be
                                        duplicated.
                                    </span>
                                )}
                            </span>
                        </label>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit">
                            {isEdit
                                ? 'Save'
                                : isSubtaskCreate
                                    ? 'Add subtask'
                                    : 'Create task'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
