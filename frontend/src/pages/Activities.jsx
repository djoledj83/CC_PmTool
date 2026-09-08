import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { format, isToday, isYesterday } from 'date-fns';
import {
    Activity as ActivityIcon,
    Archive,
    BadgeDollarSign,
    Box,
    Bug,
    CalendarClock,
    CheckCircle2,
    CheckSquare,
    CirclePlay,
    Download,
    Eye,
    FileUp,
    Flag,
    FlagOff,
    FolderPlus,
    GitBranch,
    Image as ImageIcon,
    KeyRound,
    Layers,
    ListChecks,
    LogIn,
    MapPin,
    Move,
    Package,
    Pencil,
    PencilLine,
    Pin,
    PowerOff,
    Receipt,
    RefreshCcw,
    Repeat,
    Rocket,
    Shield,
    Sparkles,
    SquareMinus,
    SquarePlus,
    StickyNote,
    Ticket,
    Timer,
    Trash2,
    Undo2,
    UserCheck,
    UserCog,
    UserMinus,
    UserPlus,
    UserX,
    Users,
    X,
    XCircle,
    Zap,
} from 'lucide-react';

import { toast } from 'sonner';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { downloadFromApi } from '@/lib/download';
import {
    CAPABILITIES as CAPABILITIES_FRONT,
    hasCapability,
} from '@/lib/capabilities';
import { TopBar } from '@/components/TopBar';
import {
    Pagination,
    PageSizeControl,
    usePagination,
} from '@/components/Pagination';
import { Tip } from '@/components/Tip';
import { PinButton } from '@/components/PinButton';
import { usePins } from '@/hooks/usePins';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
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
import { Filter, ChevronDown, Check } from 'lucide-react';

// -------- Feed (audit log) ---------------------------------------------------

const FEED_TYPE_OPTIONS = [
    { id: 'all', label: 'All activity' },
    { id: 'project_created', label: 'Projects created' },
    { id: 'project_archived', label: 'Projects archived' },
    { id: 'project_viewed', label: 'Project views' },
    { id: 'project_status_changed', label: 'Project status changes' },
    { id: 'project_owner_changed', label: 'Owner changes' },
    { id: 'project_details_updated', label: 'Project details edits' },
    { id: 'project_billing_changed', label: 'Billing edits' },
    { id: 'project_payment_changed', label: 'Paid / unpaid toggles' },
    { id: 'task_created', label: 'Tasks added' },
    { id: 'task_updated', label: 'Task details edits' },
    { id: 'task_assignee_changed', label: 'Task reassignments' },
    { id: 'task_due_date_changed', label: 'Task due-date changes' },
    { id: 'task_status_changed', label: 'Task status changes' },
    { id: 'task_phase_changed', label: 'Task phase changes' },
    { id: 'task_approved', label: 'Task approvals' },
    { id: 'task_disapproved', label: 'Task disapprovals' },
    { id: 'task_approval_requested', label: 'Approval re-requests' },
    { id: 'task_deleted', label: 'Tasks deleted' },
    { id: 'task_restored', label: 'Tasks restored' },
    { id: 'project_deleted', label: 'Projects deleted' },
    { id: 'project_restored', label: 'Projects restored' },
    { id: 'todo_status_changed', label: 'To-do status changes' },
    { id: 'project_activity_created', label: 'Activities scheduled' },
    { id: 'project_activity_completed', label: 'Activities completed' },
    { id: 'project_phase_changed', label: 'Project phase changes' },
    { id: 'note_added', label: 'Notes added' },
    { id: 'note_updated', label: 'Notes edited' },
    { id: 'note_deleted', label: 'Notes deleted' },
    { id: 'file_uploaded', label: 'File uploads' },
    { id: 'user_joined', label: 'New users (legacy)' },
    { id: 'user_approved', label: 'User approvals (legacy)' },
    // Account / user audit events. Admin-only on the backend.
    { id: 'user_registered', label: 'Sign-ups' },
    { id: 'user_login', label: 'Sign-ins' },
    { id: 'user_created', label: 'Users created' },
    { id: 'user_deleted', label: 'Users deleted' },
    { id: 'user_profile_updated', label: 'Profile edits' },
    { id: 'user_avatar_updated', label: 'Avatar changes' },
    { id: 'user_password_changed', label: 'Password changes' },
    { id: 'user_role_changed', label: 'Role changes' },
    { id: 'user_suspended', label: 'Suspensions' },
    { id: 'user_reactivated', label: 'Reactivations' },
    { id: 'task_reassign_proposed', label: 'Reassign proposed' },
    { id: 'task_reassign_approved', label: 'Reassign approved' },
    { id: 'task_reassign_rejected', label: 'Reassign declined' },
    { id: 'team_created', label: 'Teams created' },
    { id: 'team_updated', label: 'Teams updated' },
    { id: 'team_deleted', label: 'Teams deleted' },
    { id: 'team_member_added', label: 'Team members added' },
    { id: 'team_member_removed', label: 'Team members removed' },
    { id: 'project_team_added', label: 'Project teams added' },
    { id: 'project_team_removed', label: 'Project teams removed' },
    { id: 'phase_team_added', label: 'Phase teams added' },
    { id: 'phase_team_removed', label: 'Phase teams removed' },
    { id: 'time_entry_tracked', label: 'Time tracked (live timer)' },
    { id: 'time_entry_manual_added', label: 'Time logged (manual)' },
    // Application catalogue
    { id: 'app_created', label: 'Applications created' },
    { id: 'app_updated', label: 'Applications updated' },
    { id: 'app_deleted', label: 'Applications deleted' },
    { id: 'app_release_created', label: 'Releases added' },
    { id: 'app_release_updated', label: 'Releases edited' },
    { id: 'app_release_deleted', label: 'Releases deleted' },
    { id: 'app_release_phase_declared', label: 'Release phase declared' },
    { id: 'app_checkpoint_added', label: 'Release checkpoints added' },
    { id: 'app_checkpoint_deleted', label: 'Release checkpoints deleted' },
    // Sprints / iterations
    { id: 'sprint_created', label: 'Sprints created' },
    { id: 'sprint_updated', label: 'Sprints edited' },
    { id: 'sprint_started', label: 'Sprints started' },
    { id: 'sprint_closed', label: 'Sprints closed' },
    { id: 'sprint_reopened', label: 'Sprints reopened' },
    { id: 'sprint_deleted', label: 'Sprints deleted' },
    { id: 'sprint_bulk_deleted', label: 'Sprints bulk-deleted' },
    { id: 'task_added_to_sprint', label: 'Tasks added to sprint' },
    { id: 'task_removed_from_sprint', label: 'Tasks removed from sprint' },
    { id: 'sprint_schedule_updated', label: 'Sprint schedule changed' },
    { id: 'sprint_schedule_disabled', label: 'Sprint schedule removed' },
    { id: 'sprint_schedule_auto_run', label: 'Sprints auto-generated' },
    // Ticketing (help desk)
    { id: 'ticket_created', label: 'Tickets opened' },
    { id: 'ticket_status_changed', label: 'Ticket status changes' },
    { id: 'ticket_assigned', label: 'Ticket assignments' },
    { id: 'ticket_deleted', label: 'Tickets deleted' },
    { id: 'ticket_restored', label: 'Tickets restored' },
    // Broadcast announcements (admin)
    { id: 'announcement_created', label: 'Announcements created' },
    { id: 'announcement_activated', label: 'Announcements activated' },
    { id: 'announcement_deactivated', label: 'Announcements deactivated' },
    { id: 'announcement_deleted', label: 'Announcements deleted' },
    { id: 'announcement_acknowledged', label: 'Announcements acknowledged' },
];

// FEED_TYPE_OPTIONS minus the synthetic "all" entry — used everywhere
// that wants the concrete-types-only list (multi-select default,
// counting, grouping).
const ALL_TYPE_IDS = FEED_TYPE_OPTIONS.filter((o) => o.id !== 'all').map(
    (o) => o.id,
);

// High-volume event types that — on a busy workspace — generate
// hundreds of rows per day and crowd out everything else. We exclude
// them from the default filter selection so the audit feed defaults
// to "meaningful changes only". Users who actually want to inspect
// page views / status churn can still re-enable them from the
// multi-select popover. Time logging stays in the default feed.
const NOISY_TYPE_IDS = new Set([
    'project_viewed',
    'task_status_changed',
]);

// Default filter selection on first load — everything EXCEPT the
// noisy types. The user's last choice is not persisted across page
// loads; this default is what they see on every fresh visit.
const DEFAULT_TYPE_IDS = ALL_TYPE_IDS.filter((id) => !NOISY_TYPE_IDS.has(id));

// Visual grouping for the multi-select popover. Each entry pairs a
// human-readable section header with the ordered list of type ids
// it owns. A type that doesn't appear in any group falls into
// "Other" automatically. Keeping the list explicit (instead of
// inferring from the type id prefix) lets us re-order labels for
// readability and keep related concepts together — e.g. "Tasks
// deleted" / "Tasks restored" sit next to each other under Tasks.
const TYPE_GROUPS = [
    {
        label: 'Projects',
        ids: [
            'project_created',
            'project_archived',
            'project_viewed',
            'project_status_changed',
            'project_owner_changed',
            'project_details_updated',
            'project_billing_changed',
            'project_payment_changed',
            'project_phase_changed',
            'project_activity_created',
            'project_activity_completed',
        ],
    },
    {
        label: 'Tasks',
        ids: [
            'task_created',
            'task_updated',
            'task_assignee_changed',
            'task_due_date_changed',
            'task_status_changed',
            'task_phase_changed',
            'task_approved',
            'task_disapproved',
            'task_approval_requested',
            'task_deleted',
            'task_restored',
            'task_reassign_proposed',
            'task_reassign_approved',
            'task_reassign_rejected',
            'todo_status_changed',
        ],
    },
    {
        label: 'Notes & files',
        ids: ['note_added', 'note_updated', 'note_deleted', 'file_uploaded'],
    },
    {
        label: 'Time tracking',
        ids: ['time_entry_tracked', 'time_entry_manual_added'],
    },
    {
        label: 'Teams',
        ids: [
            'team_created',
            'team_updated',
            'team_deleted',
            'team_member_added',
            'team_member_removed',
            'project_team_added',
            'project_team_removed',
            'phase_team_added',
            'phase_team_removed',
        ],
    },
    {
        label: 'Sprints',
        ids: [
            'sprint_created',
            'sprint_updated',
            'sprint_started',
            'sprint_closed',
            'sprint_reopened',
            'sprint_deleted',
            'sprint_bulk_deleted',
            'task_added_to_sprint',
            'task_removed_from_sprint',
            'sprint_schedule_updated',
            'sprint_schedule_disabled',
            'sprint_schedule_auto_run',
        ],
    },
    {
        label: 'Applications',
        ids: [
            'app_created',
            'app_updated',
            'app_deleted',
            'app_release_created',
            'app_release_updated',
            'app_release_deleted',
            'app_release_phase_declared',
            'app_checkpoint_added',
            'app_checkpoint_deleted',
        ],
    },
    {
        label: 'Ticketing',
        ids: [
            'ticket_created',
            'ticket_status_changed',
            'ticket_assigned',
            'ticket_deleted',
            'ticket_restored',
        ],
    },
    {
        label: 'Account / users (admin)',
        ids: [
            'user_registered',
            'user_login',
            'user_created',
            'user_deleted',
            'user_profile_updated',
            'user_avatar_updated',
            'user_password_changed',
            'user_role_changed',
            'user_suspended',
            'user_reactivated',
            'user_joined',
            'user_approved',
        ],
    },
];

// Time-window options for the audit feed. Hours at the top help debug
// "what just happened?" investigations (logins, role flips, deletes),
// then days widen out to long-tail forensic use. Default is `10d`
// (set below in `useState`) — short enough to stay snappy on a busy
// workspace, long enough to surface rare events reliably. Keep this
// list in sync with `parseSinceParam` in `backend/src/routes/activities.js`
// — both the live feed and CSV export use the same parser.
//
// 'today' is a special token: we store it in state as a string, but
// before the API call we resolve it to the user's LOCAL midnight as
// an ISO timestamp via `resolveSinceParam` below. The backend parser
// accepts both relative tokens ('1h', '7d', …) and raw ISO strings,
// so a TZ-correct "today" never requires the server to know about
// the user's timezone.
const TIME_OPTIONS = [
    { id: '1h', label: 'Last hour' },
    { id: '3h', label: 'Last 3 hours' },
    { id: '12h', label: 'Last 12 hours' },
    { id: 'today', label: 'Today (from 00:00)' },
    { id: '1d', label: 'Last 24 hours' },
    { id: '7d', label: 'Last 7 days' },
    { id: 'all', label: 'All time' },
    // Special: when selected, reveals two datetime-local inputs
    // (from / to) right next to the dropdown. Both bounds are
    // sent to the BE as ISO strings — see `resolveSinceParam` and
    // the `until` param handling in the API effect.
    //
    // The Custom range option covers any "10 days", "15 days",
    // "30 days", "90 days" investigation the legacy presets used
    // to handle, so we don't need them as quick-pick presets.
    { id: 'custom', label: 'Custom range…' },
];

// Converts a TIME_OPTIONS id to the actual value sent over the wire.
// Most ids pass through unchanged (the BE knows how to parse '7d',
// 'all', etc.). Special ids:
//   - 'today'  → user's LOCAL midnight as ISO (TZ-correct without
//                the BE having to know the user's timezone)
//   - 'custom' → caller-supplied `customFrom`, converted from a
//                datetime-local input value to a full ISO string
//                (caller passes `{ custom: { from, to } }`)
// Anything else passes through verbatim — '1h', '7d', 'all', etc.
function resolveSinceParam(id, opts = {}) {
    if (id === 'today') {
        const now = new Date();
        const localMidnight = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate(),
            0,
            0,
            0,
            0,
        );
        return localMidnight.toISOString();
    }
    if (id === 'custom') {
        const from = opts.customFrom;
        if (!from) return null;
        const d = new Date(from);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    return id;
}

// Mirror of resolveSinceParam for the upper bound. Only Custom range
// produces an `until`; relative presets implicitly end at "now"
// (the BE leaves `lte` off when `until` is missing).
function resolveUntilParam(id, opts = {}) {
    if (id !== 'custom') return null;
    const to = opts.customTo;
    if (!to) return null;
    const d = new Date(to);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Formats a Date for a `<input type="datetime-local">` value, which
// requires `YYYY-MM-DDTHH:MM` without seconds or timezone. We render
// in LOCAL time on purpose — the field shows the user the time they'd
// recognise on their wall clock, not a UTC offset.
function toDateTimeLocalValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
        date.getDate(),
    )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const FEED_TYPE_META = {
    project_created: {
        icon: FolderPlus,
        tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    },
    project_archived: {
        icon: Archive,
        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    task_created: {
        icon: CheckSquare,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    task_updated: {
        icon: PencilLine,
        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    task_assignee_changed: {
        icon: UserCog,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    task_reassign_proposed: {
        icon: UserCog,
        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    task_reassign_approved: {
        icon: UserCog,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    task_reassign_rejected: {
        icon: UserCog,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    task_due_date_changed: {
        icon: CalendarClock,
        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    task_deleted: {
        icon: Trash2,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    task_restored: {
        icon: Undo2,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    project_deleted: {
        icon: Trash2,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    project_restored: {
        icon: Undo2,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    task_status_changed: {
        icon: CheckCircle2,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    task_phase_changed: {
        icon: Move,
        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    task_approved: {
        icon: CheckCircle2,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    task_disapproved: {
        icon: XCircle,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    task_approval_requested: {
        icon: RefreshCcw,
        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    todo_status_changed: {
        icon: ListChecks,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    project_phase_changed: {
        icon: GitBranch,
        tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    },
    project_activity_created: {
        icon: CalendarClock,
        tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
    },
    project_activity_completed: {
        icon: RefreshCcw,
        tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
    },
    note_added: {
        icon: StickyNote,
        tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
    },
    note_updated: {
        icon: PencilLine,
        tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
    },
    note_deleted: {
        icon: Trash2,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    file_uploaded: {
        icon: FileUp,
        tone: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-400',
    },
    user_joined: {
        icon: UserPlus,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    user_approved: {
        icon: UserCheck,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    project_viewed: {
        icon: Eye,
        tone: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
    },
    project_status_changed: {
        icon: Repeat,
        tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    },
    project_owner_changed: {
        icon: UserCog,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    project_details_updated: {
        icon: Pencil,
        tone: 'bg-muted text-foreground/70',
    },
    project_billing_changed: {
        icon: Receipt,
        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    project_payment_changed: {
        icon: BadgeDollarSign,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    user_registered: {
        icon: UserPlus,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    user_login: {
        icon: LogIn,
        tone: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
    },
    user_created: {
        icon: UserPlus,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    user_deleted: {
        icon: UserX,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    user_profile_updated: {
        icon: Pencil,
        tone: 'bg-muted text-foreground/70',
    },
    user_avatar_updated: {
        icon: ImageIcon,
        tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    },
    user_password_changed: {
        icon: KeyRound,
        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    user_role_changed: {
        icon: Shield,
        tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
    },
    user_suspended: {
        icon: UserMinus,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    user_reactivated: {
        icon: UserCheck,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    time_entry_tracked: {
        icon: Timer,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    time_entry_manual_added: {
        icon: Timer,
        tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    },
    app_created: {
        icon: Package,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    app_updated: {
        icon: Pencil,
        tone: 'bg-muted text-foreground/70',
    },
    app_deleted: {
        icon: Trash2,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    app_release_created: {
        icon: Rocket,
        tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
    },
    app_release_updated: {
        icon: PencilLine,
        tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
    },
    app_release_deleted: {
        icon: Trash2,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    app_release_phase_declared: {
        icon: GitBranch,
        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    app_checkpoint_added: {
        icon: MapPin,
        tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    },
    sprint_created: {
        icon: Zap,
        tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
    },
    sprint_updated: {
        icon: Pencil,
        tone: 'bg-muted text-foreground/70',
    },
    sprint_started: {
        icon: CirclePlay,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    sprint_closed: {
        icon: Flag,
        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    sprint_reopened: {
        icon: FlagOff,
        tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    },
    sprint_deleted: {
        icon: Trash2,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    sprint_bulk_deleted: {
        icon: Trash2,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    task_added_to_sprint: {
        icon: SquarePlus,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    task_removed_from_sprint: {
        icon: SquareMinus,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    sprint_schedule_updated: {
        icon: Repeat,
        tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
    },
    sprint_schedule_disabled: {
        icon: PowerOff,
        tone: 'bg-muted text-foreground/70',
    },
    sprint_schedule_auto_run: {
        icon: Sparkles,
        tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
    },
    app_checkpoint_deleted: {
        icon: Undo2,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    app_event: {
        icon: Box,
        tone: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
    },
    // Team membership + project/phase team links. All grouped under
    // the same "people" colour so they're visually consistent in the
    // filter dropdown (and so a single Users-shaped icon column reads
    // as "this is a team-related event").
    team_created: {
        icon: Users,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    team_updated: {
        icon: Users,
        tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    },
    team_deleted: {
        icon: Users,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    team_member_added: {
        icon: UserPlus,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    team_member_removed: {
        icon: UserMinus,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    project_team_added: {
        icon: Users,
        tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    },
    project_team_removed: {
        icon: Users,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    phase_team_added: {
        icon: Layers,
        tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    },
    phase_team_removed: {
        icon: Layers,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    // Ticketing (help desk).
    ticket_created: {
        icon: Ticket,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    ticket_status_changed: {
        icon: RefreshCcw,
        tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    },
    ticket_assigned: {
        icon: UserCheck,
        tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
    },
    ticket_deleted: {
        icon: Trash2,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    ticket_restored: {
        icon: Ticket,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    ticket_event: {
        icon: Ticket,
        tone: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
    },
    announcement_created: {
        icon: ActivityIcon,
        tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
    },
    announcement_activated: {
        icon: ActivityIcon,
        tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    },
    announcement_deactivated: {
        icon: ActivityIcon,
        tone: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
    },
    announcement_deleted: {
        icon: Trash2,
        tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
    },
    announcement_acknowledged: {
        icon: UserCheck,
        tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
    },
    announcement_event: {
        icon: ActivityIcon,
        tone: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
    },
    // Fallback for the "All activity" filter row — the dropdown shows
    // this generic pulse icon so the trigger always has a glyph next
    // to the label.
    all: {
        icon: ActivityIcon,
        tone: 'bg-muted text-foreground/70',
    },
};

function dayLabel(date) {
    const d = new Date(date);
    if (isToday(d)) return 'Today';
    if (isYesterday(d)) return 'Yesterday';
    return format(d, 'EEEE, MMM d');
}

function dayKey(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function targetLink(item) {
    // Ticketing events open the ticket in the help-desk workspace. A
    // deleted ticket has no detail to land on, so we drop the focus
    // hint and just open the queue.
    if (item.type?.startsWith('ticket_')) {
        if (item.type === 'ticket_deleted' || !item.target?.id) {
            return '/tickets';
        }
        return `/tickets?ticket=${item.target.id}`;
    }
    // Account / user events don't belong to a project — they point at
    // the affected user record so the admin can jump straight to their
    // row in the Users page.
    if (item.type?.startsWith('user_') && item.target?.id) {
        return `/users?focus=${item.target.id}`;
    }
    // Application catalogue events deep-link to the application page
    // (and the timeline tab for checkpoint events, which is where the
    // operator will want to land).
    if (item.type?.startsWith('app_') && item.target?.id) {
        if (
            item.type === 'app_checkpoint_added' ||
            item.type === 'app_checkpoint_deleted' ||
            item.type === 'app_release_phase_declared'
        ) {
            return `/applications/${item.target.id}?tab=timeline`;
        }
        return `/applications/${item.target.id}`;
    }
    // Sprint scheduler events also live on the Sprints tab — they
    // don't reference any individual sprint, so we drop the focus hint
    // and just open the tab so the user lands on the schedule banner.
    if (
        (item.type === 'sprint_schedule_updated' ||
            item.type === 'sprint_schedule_disabled' ||
            item.type === 'sprint_schedule_auto_run') &&
        item.target?.projectId
    ) {
        return `/projects/${item.target.projectId}?tab=sprints`;
    }
    // Sprint events deep-link to the parent project's Sprints tab,
    // with the sprint id as a focus hint so the FE can scroll/expand
    // the right card.
    if (
        (item.type?.startsWith('sprint_') ||
            item.type === 'task_added_to_sprint' ||
            item.type === 'task_removed_from_sprint') &&
        item.target?.projectId
    ) {
        return `/projects/${item.target.projectId}?tab=sprints&sprint=${item.target.id}`;
    }
    if (!item.project) return null;
    if (
        (item.type === 'task_status_changed' ||
            item.type === 'task_phase_changed' ||
            item.type === 'task_created' ||
            item.type === 'task_updated' ||
            item.type === 'task_assignee_changed' ||
            item.type === 'task_due_date_changed') &&
        item.target?.id
    ) {
        return `/projects/${item.project.id}#task-${item.target.id}`;
    }
    // Deleted tasks have no target row to scroll to — fall back to
    // the project page so the user has somewhere meaningful to land.
    if (item.type === 'task_deleted') {
        return `/projects/${item.project.id}`;
    }
    // Restored tasks deep-link straight to the row so the user can
    // verify everything came back correctly.
    if (item.type === 'task_restored' && item.target?.id) {
        return `/projects/${item.project.id}#task-${item.target.id}`;
    }
    // A restored project can be opened again; a deleted one is hidden
    // until restored, so there's nowhere to navigate.
    if (item.type === 'project_restored' && item.target?.id) {
        return `/projects/${item.target.id}`;
    }
    if (item.type === 'project_deleted') {
        return null;
    }
    if (
        (item.type === 'note_added' ||
            item.type === 'note_updated' ||
            item.type === 'note_deleted') &&
        item.project
    ) {
        return `/projects/${item.project.id}#notes`;
    }
    if (
        (item.type === 'project_activity_created' ||
            item.type === 'project_activity_completed') &&
        item.target?.id
    ) {
        return `/projects/${item.project.id}#activity-${item.target.id}`;
    }
    if (item.type === 'todo_status_changed') return '/todos';
    return `/projects/${item.project.id}`;
}

// Multi-select popover for the activity-type filter. Replaces the
// legacy single-select dropdown so users can untick high-volume
// event types (project views, status churn) and keep
// the rare events they actually came to audit. Each group has a
// "select-all" toggle for the section so power users can flip an
// entire category in one click. Quick actions at the top: All /
// Recommended (the default — everything except noisy types) / None.
//
// The empty-set case is handled by the parent: sending `types=__none__`
// makes the BE return zero rows rather than its "no filter = all"
// fallback, so unchecking everything reads as "show me nothing" —
// otherwise the user could be confused by a populated feed after
// clicking the "None" button.
function ActivityTypeFilter({ selected, onChange }) {
    const [open, setOpen] = useState(false);
    // Derive the trigger label / count from the selection. We show
    // a friendly name ("All activity" / "Recommended" / specific
    // group name when the selection matches a single section) so the
    // collapsed control reads naturally instead of "47 selected".
    const isAll = selected.size === ALL_TYPE_IDS.length;
    const isRecommended =
        selected.size === DEFAULT_TYPE_IDS.length &&
        DEFAULT_TYPE_IDS.every((id) => selected.has(id));
    const isEmpty = selected.size === 0;
    let triggerLabel;
    if (isAll) {
        triggerLabel = 'All activity';
    } else if (isRecommended) {
        triggerLabel = 'Recommended';
    } else if (isEmpty) {
        triggerLabel = 'No activity';
    } else if (selected.size === 1) {
        const onlyId = Array.from(selected)[0];
        const found = FEED_TYPE_OPTIONS.find((o) => o.id === onlyId);
        triggerLabel = found ? found.label : '1 type';
    } else {
        triggerLabel = `${selected.size} types`;
    }

    const toggleOne = (id) => {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        onChange(next);
    };

    const setExactly = (ids) => {
        onChange(new Set(ids));
    };

    const toggleGroup = (groupIds) => {
        // If every id in the group is already selected, untick all of
        // them; otherwise tick every missing one. Matches the "smart"
        // group-checkbox behaviour users expect from GitHub-style
        // filter UIs.
        const allOn = groupIds.every((id) => selected.has(id));
        const next = new Set(selected);
        if (allOn) {
            for (const id of groupIds) next.delete(id);
        } else {
            for (const id of groupIds) next.add(id);
        }
        onChange(next);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-[220px] justify-between gap-2 px-3 text-xs font-normal"
                >
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
                        <Filter
                            aria-hidden
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        />
                        <span className="truncate">{triggerLabel}</span>
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                className="w-[320px] p-0"
                sideOffset={6}
            >
                {/* Quick-action header. Border separates it from the
                    scrollable group list below so the buttons don't
                    scroll out of view on a long page. */}
                <div className="flex items-center gap-1 border-b p-2">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 flex-1 text-xs"
                        onClick={() => setExactly(ALL_TYPE_IDS)}
                    >
                        All
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 flex-1 text-xs"
                        onClick={() => setExactly(DEFAULT_TYPE_IDS)}
                        title="Everything except high-volume events (project views, time tracking, status changes)"
                    >
                        Recommended
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 flex-1 text-xs"
                        onClick={() => setExactly([])}
                    >
                        None
                    </Button>
                </div>
                <div className="max-h-[60vh] overflow-y-auto p-1">
                    {TYPE_GROUPS.map((group) => {
                        // Only render the group if at least one of its
                        // ids is a known option. Defensive guard for a
                        // typo in TYPE_GROUPS so the UI doesn't render
                        // an empty section.
                        const visibleIds = group.ids.filter((id) =>
                            ALL_TYPE_IDS.includes(id),
                        );
                        if (visibleIds.length === 0) return null;
                        const allOn = visibleIds.every((id) =>
                            selected.has(id),
                        );
                        const someOn =
                            !allOn &&
                            visibleIds.some((id) => selected.has(id));
                        return (
                            <div key={group.label} className="py-1">
                                {/* Group header doubles as a
                                    "toggle entire section" control.
                                    The indeterminate visual ("partial"
                                    state) is approximated with a
                                    dash icon since native checkbox
                                    indeterminate doesn't render
                                    consistently in all browsers. */}
                                <button
                                    type="button"
                                    onClick={() => toggleGroup(visibleIds)}
                                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-xs font-semibold text-muted-foreground hover:bg-accent"
                                >
                                    <span
                                        className={cn(
                                            'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                            allOn
                                                ? 'border-primary bg-primary text-primary-foreground'
                                                : someOn
                                                  ? 'border-primary text-primary'
                                                  : 'border-input',
                                        )}
                                        aria-hidden
                                    >
                                        {allOn ? (
                                            <Check className="h-3 w-3" />
                                        ) : someOn ? (
                                            <span className="h-0.5 w-2 bg-primary" />
                                        ) : null}
                                    </span>
                                    <span className="truncate">
                                        {group.label}
                                    </span>
                                </button>
                                <div className="mt-0.5">
                                    {visibleIds.map((id) => {
                                        const opt = FEED_TYPE_OPTIONS.find(
                                            (o) => o.id === id,
                                        );
                                        if (!opt) return null;
                                        const isChecked = selected.has(id);
                                        const isNoisy = NOISY_TYPE_IDS.has(id);
                                        const Meta = FEED_TYPE_META[id] || {
                                            icon: ActivityIcon,
                                        };
                                        const Icon = Meta.icon;
                                        return (
                                            <label
                                                key={id}
                                                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 pl-6 text-xs hover:bg-accent"
                                            >
                                                <input
                                                    type="checkbox"
                                                    className="h-3.5 w-3.5 cursor-pointer accent-primary"
                                                    checked={isChecked}
                                                    onChange={() => toggleOne(id)}
                                                />
                                                <Icon
                                                    aria-hidden
                                                    className="h-3 w-3 shrink-0 text-muted-foreground"
                                                />
                                                <span className="flex-1 truncate">
                                                    {opt.label}
                                                </span>
                                                {isNoisy && (
                                                    <span
                                                        className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400"
                                                        title="High-volume — disabled by default to keep the feed readable"
                                                    >
                                                        Noisy
                                                    </span>
                                                )}
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </PopoverContent>
        </Popover>
    );
}

function FeedView() {
    // Seed state from the URL so admin "View as X" deep-links work
    // out of the box. The Select onChange still drives state from
    // here on out; URL ↔ state isn't kept in sync for the rest of
    // the lifecycle.
    const initialUrlUserId =
        typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search).get('userId') ||
              'all'
            : 'all';
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    // Multi-select of event types — replaces the legacy single
    // `type` string. Stored as a Set for O(1) toggle checks. Default
    // is DEFAULT_TYPE_IDS (everything EXCEPT noisy types) so
    // the feed surfaces meaningful changes out-of-the-box without
    // needing the server-side bucket gymnastics. Users can re-add
    // noisy types from the filter popover anytime — see the
    // ActivityTypeFilter component below the page render.
    const [selectedTypes, setSelectedTypes] = useState(
        () => new Set(DEFAULT_TYPE_IDS),
    );
    const [since, setSince] = useState('7d');
    // Custom range bounds, only rendered / sent when since === 'custom'.
    // Defaults are seeded lazily on first switch into Custom mode (see
    // the onValueChange handler on the time Select below) — we don't
    // pre-fill them here so a user who never opens Custom range
    // doesn't pay the "useState re-renders on every Date.now()" cost.
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState('');
    const [projectId, setProjectId] = useState('all');
    const [userId, setUserId] = useState(initialUrlUserId);
    const [projects, setProjects] = useState([]);
    const [users, setUsers] = useState([]);
    // Change Request narrowing. Only meaningful once a specific
    // project is picked — a CR belongs to exactly one project, so
    // a global "CR across all projects" filter would force us to
    // list every CR in the workspace just to find unique codes.
    // We fetch the project's CRs lazily on `projectId` change and
    // auto-reset the selection so navigating between projects
    // doesn't keep an irrelevant CR id in the request URL.
    const [changeRequestId, setChangeRequestId] = useState('all');
    const [crs, setCrs] = useState([]);
    useEffect(() => {
        if (projectId === 'all') {
            setCrs([]);
            setChangeRequestId('all');
            return;
        }
        let cancelled = false;
        api.get(`/projects/${projectId}/change-requests`)
            .then((res) => {
                if (cancelled) return;
                setCrs(res.data.changeRequests || []);
            })
            .catch(() => {
                if (cancelled) return;
                setCrs([]);
            });
        // Re-evaluate the current selection — if the previously
        // selected CR doesn't belong to the new project, drop it.
        setChangeRequestId((prev) => (prev === 'all' ? prev : 'all'));
        return () => {
            cancelled = true;
        };
    }, [projectId]);
    // ?debug=1 in the URL flips on raw-event inspector on each row
    // so admins / support can see the e.type / e.meta JSON without
    // touching backend logs. Read once on mount — flipping the URL
    // requires a refresh, which is fine since this is a power-user
    // affordance.
    const debugMode =
        typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search).get('debug') === '1'
            : false;
    // Pull every "ACTIVITY" pin in one call so each row can render
    // its pinned-state without N round-trips. usePins handles the
    // optimistic toggle locally.
    const pinHook = usePins('ACTIVITY');

    // Export — admin-only. Pulls a CSV of the raw ActivityEvent rows
    // matching the current filters and triggers a browser download.
    const { user: viewer } = useAuth();
    const canExport = viewer?.role === 'ADMIN';
    const [exporting, setExporting] = useState(false);
    const handleExport = async () => {
        if (!canExport || exporting) return;
        setExporting(true);
        try {
            const resolvedSince = resolveSinceParam(since, {
                customFrom,
                customTo,
            });
            const resolvedUntil = resolveUntilParam(since, {
                customFrom,
                customTo,
            });
            const params = {};
            if (resolvedSince) params.since = resolvedSince;
            if (resolvedUntil) params.until = resolvedUntil;
            // Only send `types` when the user has narrowed the
            // selection. An empty set is interpreted by the BE as
            // "no events match"; the all-selected case is sent as
            // no `types` param so the BE falls back to its full
            // type list — same shape the legacy single-select used.
            if (
                selectedTypes.size > 0 &&
                selectedTypes.size < ALL_TYPE_IDS.length
            ) {
                params.types = Array.from(selectedTypes).join(',');
            } else if (selectedTypes.size === 0) {
                params.types = '__none__';
            }
            if (projectId !== 'all') params.projectId = projectId;
            if (userId !== 'all') params.userId = userId;
            if (changeRequestId !== 'all')
                params.changeRequestId = changeRequestId;
            await downloadFromApi('/activities/export.csv', {
                params,
                filenameFallback: `activities-${new Date()
                    .toISOString()
                    .slice(0, 10)}.csv`,
            });
        } catch (err) {
            toast.error(
                err?.response?.data?.error ||
                    'Could not export activities. Try a narrower filter.',
            );
        } finally {
            setExporting(false);
        }
    };

    useEffect(() => {
        api.get('/projects')
            .then((res) => setProjects(res.data.projects || []))
            .catch(() => {});
        api.get('/users')
            .then((res) => setUsers(res.data.users || []))
            .catch(() => {});
    }, []);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        // We request 500 rows as the SOFT cap on noisy events. The
        // backend now protects important events (TASK_DELETED,
        // TASK_RESTORED, sprint events, user audit, CR events, …)
        // from being sliced off the bottom — those are ALWAYS
        // returned regardless of `limit`, with the limit applied
        // only to high-volume noisy types (PROJECT_VIEWED,
        // TIME_ENTRY_*, TASK_STATUS_CHANGED). So the response can
        // legitimately exceed 500 on a workspace with many recent
        // important events, and `items.length` below reflects the
        // true returned count.
        // Custom range with an incomplete pair → don't fire the
        // request at all. The user is mid-typing; firing now would
        // either 4xx or return a misleading empty list.
        if (since === 'custom' && (!customFrom || !customTo)) {
            setLoading(false);
            return () => {};
        }
        const resolvedSince = resolveSinceParam(since, {
            customFrom,
            customTo,
        });
        const resolvedUntil = resolveUntilParam(since, {
            customFrom,
            customTo,
        });
        const params = { limit: 500 };
        if (resolvedSince) params.since = resolvedSince;
        if (resolvedUntil) params.until = resolvedUntil;
        // Build the `types` query param from the multi-select.
        //
        //   - all selected   → omit (BE defaults to "all types")
        //   - subset         → comma-joined list of ids
        //   - none selected  → send a sentinel so the BE returns []
        //                      instead of falling back to the full set;
        //                      a "literally everything" call when the
        //                      user has unchecked everything would be
        //                      confusing
        if (
            selectedTypes.size > 0 &&
            selectedTypes.size < ALL_TYPE_IDS.length
        ) {
            params.types = Array.from(selectedTypes).join(',');
        } else if (selectedTypes.size === 0) {
            params.types = '__none__';
        }
        if (projectId !== 'all') params.projectId = projectId;
        if (userId !== 'all') params.userId = userId;
        if (changeRequestId !== 'all')
            params.changeRequestId = changeRequestId;

        api.get('/activities', { params })
            .then((res) => {
                if (!cancelled) setItems(res.data.activities || []);
            })
            .catch(() => {
                if (!cancelled) setItems([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [
        selectedTypes,
        since,
        customFrom,
        customTo,
        projectId,
        userId,
        changeRequestId,
    ]);

    // "Pinned only" filter — when on, hides every row except the
    // ones the current user has bookmarked. Useful for keeping
    // follow-up items in one view.
    const [pinnedOnly, setPinnedOnly] = useState(false);

    const filteredItems = useMemo(
        () =>
            pinnedOnly
                ? items.filter((it) => pinHook.isPinned(it.id))
                : items,
        [items, pinnedOnly, pinHook],
    );

    // Paginate the flat feed (20/50/100), then group only the current
    // page's entries by day for display.
    const { page, setPage, pageSize, setPageSize, total, totalPages, pageItems } =
        usePagination(filteredItems, 20);

    const grouped = useMemo(() => {
        const map = new Map();
        for (const it of pageItems) {
            const k = dayKey(it.createdAt);
            if (!map.has(k)) map.set(k, { date: it.createdAt, items: [] });
            map.get(k).items.push(it);
        }
        return Array.from(map.values());
    }, [pageItems]);

    // Detect whether the user has diverged from the recommended
    // defaults. We treat "selectedTypes === DEFAULT_TYPE_IDS" as the
    // baseline (matches what they see on first load), so checking a
    // noisy type or unchecking a default one both flip this on.
    const isDefaultTypeSelection =
        selectedTypes.size === DEFAULT_TYPE_IDS.length &&
        DEFAULT_TYPE_IDS.every((id) => selectedTypes.has(id));
    const filtersActive =
        !isDefaultTypeSelection ||
        since !== '7d' ||
        projectId !== 'all' ||
        userId !== 'all' ||
        changeRequestId !== 'all';

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 shadow-sm">
                <ActivityTypeFilter
                    selected={selectedTypes}
                    onChange={setSelectedTypes}
                />
                <Select
                    value={since}
                    onValueChange={(next) => {
                        // Switching INTO Custom range for the first
                        // time? Seed sensible defaults — today's
                        // window — so the inputs aren't blank (which
                        // would otherwise suppress the request via
                        // the guard in the API effect).
                        if (next === 'custom' && (!customFrom || !customTo)) {
                            const now = new Date();
                            const midnight = new Date(
                                now.getFullYear(),
                                now.getMonth(),
                                now.getDate(),
                                0,
                                0,
                                0,
                                0,
                            );
                            setCustomFrom(toDateTimeLocalValue(midnight));
                            setCustomTo(toDateTimeLocalValue(now));
                        }
                        setSince(next);
                    }}
                >
                    <SelectTrigger className="h-8 w-[180px] text-xs">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {TIME_OPTIONS.map((o) => (
                            <SelectItem key={o.id} value={o.id}>
                                {o.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {since === 'custom' && (
                    <div
                        className="flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs"
                        title="Pick the from/to bounds for the audit window. Times are interpreted in your local timezone."
                    >
                        <span className="text-muted-foreground">From</span>
                        <input
                            type="datetime-local"
                            value={customFrom}
                            max={customTo || undefined}
                            onChange={(e) => setCustomFrom(e.target.value)}
                            className="h-6 rounded border bg-background px-1.5 text-xs"
                        />
                        <span className="text-muted-foreground">to</span>
                        <input
                            type="datetime-local"
                            value={customTo}
                            min={customFrom || undefined}
                            onChange={(e) => setCustomTo(e.target.value)}
                            className="h-6 rounded border bg-background px-1.5 text-xs"
                        />
                    </div>
                )}
                <Select value={projectId} onValueChange={setProjectId}>
                    <SelectTrigger className="h-8 w-[180px] text-xs">
                        <SelectValue placeholder="Project" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All projects</SelectItem>
                        {projects.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                                {p.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {/* CR narrowing picker — only meaningful once a
                    specific project is selected. We render it
                    disabled (with a hint) while "All projects" is
                    active so users still see the affordance and
                    learn it exists, instead of it appearing/dis-
                    appearing magically. Once a project is picked
                    the dropdown lists every CR in that project. */}
                <Select
                    value={changeRequestId}
                    onValueChange={setChangeRequestId}
                    disabled={projectId === 'all' || crs.length === 0}
                >
                    <SelectTrigger
                        className="h-8 w-[180px] text-xs"
                        title={
                            projectId === 'all'
                                ? 'Pick a project first to filter by change request'
                                : crs.length === 0
                                  ? 'This project has no change requests'
                                  : undefined
                        }
                    >
                        <SelectValue placeholder="Change request" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All CRs</SelectItem>
                        {crs.map((cr) => (
                            <SelectItem key={cr.id} value={cr.id}>
                                {cr.code} — {cr.title}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Select value={userId} onValueChange={setUserId}>
                    <SelectTrigger className="h-8 w-[180px] text-xs">
                        <SelectValue placeholder="Person" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">Everyone</SelectItem>
                        {users.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                                {u.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                {filtersActive && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1 text-xs"
                        onClick={() => {
                            setSelectedTypes(new Set(DEFAULT_TYPE_IDS));
                            setSince('7d');
                            // Clear the custom range so a later
                            // switch back to Custom mode picks up
                            // fresh defaults instead of stale ones.
                            setCustomFrom('');
                            setCustomTo('');
                            setProjectId('all');
                            setUserId('all');
                            setChangeRequestId('all');
                        }}
                    >
                        <X className="h-3.5 w-3.5" />
                        Reset
                    </Button>
                )}
                <Button
                    variant={pinnedOnly ? 'default' : 'outline'}
                    size="sm"
                    className="h-8 gap-1 text-xs"
                    onClick={() => setPinnedOnly((v) => !v)}
                    title={
                        pinnedOnly
                            ? 'Show all activity'
                            : 'Show only rows you have pinned'
                    }
                >
                    <Pin className="h-3.5 w-3.5" />
                    {pinnedOnly
                        ? `Pinned only (${pinHook.pinned.length})`
                        : 'Pinned only'}
                </Button>
                {canExport && (
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 text-xs"
                        onClick={handleExport}
                        disabled={exporting}
                        title="Export the raw audit-log rows that match the current filters (CSV, admin only)"
                    >
                        <Download className="h-3.5 w-3.5" />
                        {exporting ? 'Exporting…' : 'Export CSV'}
                    </Button>
                )}
                <Tip variant="info" side="bottom" className="ml-auto">
                    <p className="font-medium">About the feed</p>
                    <p className="mt-1 text-muted-foreground">
                        Account-level events (sign-ups, logins, role
                        changes, suspensions, …) are admin-only and
                        only render if you have the admin role. Sprint
                        scheduler events go into the per-project feed.
                        Click the pin icon on any row to bookmark it
                        and use <em>Pinned only</em> to focus on
                        follow-ups. Add <code>?debug=1</code> to the
                        URL to inspect each row's raw event type and
                        meta payload.
                    </p>
                </Tip>
            </div>

            {/* Small diagnostic line — tells the user how many
                events the API returned and (separately) how many of
                them are task deletions. Useful when investigating
                "I deleted a task, why isn't the Restore button
                showing?" — if the deletion count is zero we know
                the row didn't even make it into the merged feed
                window. The count respects current filters so it
                also doubles as a quick "is my filter too narrow?"
                indicator. */}
            {!loading && items.length > 0 && (
                <p className="-mt-1 text-[11px] text-muted-foreground">
                    {items.length} event{items.length === 1 ? '' : 's'}
                    {(() => {
                        const deletions = items.filter(
                            (it) => it.type === 'task_deleted',
                        ).length;
                        return deletions > 0
                            ? ` · ${deletions} deletion${
                                  deletions === 1 ? '' : 's'
                              } (eligible for restore)`
                            : '';
                    })()}
                </p>
            )}

            {!loading && total > 0 && (
                <PageSizeControl
                    pageSize={pageSize}
                    onPageSizeChange={setPageSize}
                    options={[20, 50, 100]}
                    className="justify-end"
                />
            )}

            {loading ? (
                <div className="rounded-lg border bg-card p-10 text-center text-sm text-muted-foreground shadow-sm">
                    Loading activity...
                </div>
            ) : grouped.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-card p-12 text-center shadow-sm">
                    <ActivityIcon className="h-10 w-10 text-muted-foreground" />
                    <p className="font-medium">No activity to show</p>
                    <p className="text-sm text-muted-foreground">
                        {filtersActive
                            ? 'Try widening your filters or extending the time range.'
                            : 'Once people create projects, tasks or notes they\u2019ll show up here.'}
                    </p>
                </div>
            ) : (
                <div className="space-y-5">
                    {grouped.map((group) => (
                        <div key={group.date}>
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {dayLabel(group.date)}
                            </h3>
                            <ul className="space-y-2">
                                {group.items.map((it) => (
                                    <FeedRow
                                        onRestored={(taskId) => {
                                            // Hide the soft-delete event
                                            // from the live feed once the
                                            // task is restored. The
                                            // backend will log a fresh
                                            // TASK_RESTORED entry that
                                            // shows up on the next
                                            // refresh, so the audit
                                            // history stays complete.
                                            setItems((curr) =>
                                                curr.filter(
                                                    (row) =>
                                                        !(
                                                            (row.type ===
                                                                'task_deleted' ||
                                                                row.type ===
                                                                    'project_deleted') &&
                                                            row.target?.id ===
                                                                taskId
                                                        ),
                                                ),
                                            );
                                        }}
                                        key={it.id}
                                        item={it}
                                        debugMode={debugMode}
                                        pinHook={pinHook}
                                    />
                                ))}
                            </ul>
                        </div>
                    ))}
                    <Pagination
                        page={page}
                        pageSize={pageSize}
                        total={total}
                        totalPages={totalPages}
                        onPageChange={setPage}
                        onPageSizeChange={setPageSize}
                        pageSizeOptions={[20, 50, 100]}
                        className="rounded-lg border bg-card shadow-sm"
                    />
                </div>
            )}
        </div>
    );
}

function FeedRow({ item, debugMode = false, pinHook, onRestored }) {
    const { user } = useAuth();
    const meta = FEED_TYPE_META[item.type] || {
        icon: ActivityIcon,
        tone: 'bg-muted text-muted-foreground',
    };
    const Icon = meta.icon;
    const link = targetLink(item);
    // Pin state for THIS row. The shared pinHook (one round-trip for
    // the whole feed) tells us instantly without a per-row request.
    const pinned = pinHook?.isPinned ? pinHook.isPinned(item.id) : false;

    // Restore eligibility for soft-deleted tasks. Mirrors the
    // backend `POST /tasks/:id/restore` permission ladder:
    //   - ADMIN / MANAGER role           → always allowed
    //   - `task:delete:any` capability   → always allowed
    //   - `task:create:any` capability   → allowed if the actor on
    //                                      the deleted-row event was
    //                                      also the creator
    //                                      (server re-checks with the
    //                                      row's `createdById`).
    //   - Personal-project OWNERS        → always allowed for tasks
    //                                      inside their personal
    //                                      project, regardless of
    //                                      role / capabilities. We now
    //                                      detect this client-side via
    //                                      `item.project.isPersonal` +
    //                                      `item.project.ownerId`
    //                                      (added to the activities
    //                                      payload for this exact
    //                                      reason) so a regular user
    //                                      who owns a personal project
    //                                      can still see the button.
    //
    // The button used to be hidden from `task:create:any`-only users
    // entirely, which made them think the feature had been removed.
    // We optimistically show it for creators of their OWN deletions
    // and let the API have the final say if anything has changed.
    const isOwnDeletion =
        item.actor?.id && user?.id && item.actor.id === user.id;
    const isOwnPersonalProject =
        item.project?.isPersonal && item.project?.ownerId === user?.id;
    const canRestore =
        (item.type === 'task_deleted' &&
            item.target?.id &&
            (user?.role === 'ADMIN' ||
                user?.role === 'MANAGER' ||
                hasCapability(user, CAPABILITIES_FRONT.TASK_DELETE_ANY) ||
                isOwnPersonalProject ||
                (isOwnDeletion &&
                    hasCapability(
                        user,
                        CAPABILITIES_FRONT.TASK_CREATE_ANY,
                    )))) ||
        // Restoring a deleted PROJECT: admins, project:delete holders, or
        // the owner of a deleted personal project.
        (item.type === 'project_deleted' &&
            item.target?.id &&
            (user?.role === 'ADMIN' ||
                hasCapability(user, CAPABILITIES_FRONT.PROJECT_DELETE) ||
                isOwnPersonalProject)) ||
        // Restoring a deleted TICKET: admins or ticket managers (the roles
        // that can delete). The server re-checks with canManage.
        (item.type === 'ticket_deleted' &&
            item.target?.id &&
            (user?.role === 'ADMIN' ||
                hasCapability(user, CAPABILITIES_FRONT.TICKET_MANAGE)));
    const [restoring, setRestoring] = useState(false);
    const handleRestore = async () => {
        if (!item.target?.id || restoring) return;
        const isProject = item.type === 'project_deleted';
        const isTicket = item.type === 'ticket_deleted';
        const id = item.target.id;
        const noun = isProject
            ? 'Project'
            : isTicket
              ? 'Ticket'
              : item.target.isSubtask
                ? 'Subtask'
                : 'Task';
        if (
            !window.confirm(
                `${noun} "${item.target.title || ''}" will be restored. Continue?`,
            )
        ) {
            return;
        }
        setRestoring(true);
        try {
            await api.post(
                isProject
                    ? `/projects/${id}/restore`
                    : isTicket
                      ? `/tickets/${id}/restore`
                      : `/tasks/${id}/restore`,
            );
            toast.success(`${noun} restored.`);
            onRestored?.(id);
        } catch (err) {
            // 404 == already restored or hard-deleted; 403 ==
            // permission was revoked since the page loaded.
            const msg =
                err?.response?.data?.message ||
                err?.response?.data?.error ||
                'Could not restore — it may have been removed permanently.';
            toast.error(msg);
        } finally {
            setRestoring(false);
        }
    };
    return (
        <li
            className={cn(
                'flex items-start gap-3 rounded-lg border bg-card p-3 shadow-sm transition-colors',
                pinned && 'border-emerald-500/50 bg-emerald-500/5',
            )}
        >
            <span
                className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                    meta.tone,
                )}
            >
                <Icon className="h-4 w-4" />
            </span>

            <div className="min-w-0 flex-1">
                <div className="flex items-start gap-3">
                    {item.actor && (
                        <Avatar className="h-6 w-6 shrink-0">
                            {item.actor.avatarUrl && (
                                <AvatarImage
                                    src={resolveAssetUrl(item.actor.avatarUrl)}
                                    alt={item.actor.name}
                                />
                            )}
                            <AvatarFallback className="bg-primary/10 text-[10px] text-primary">
                                {initials(item.actor.name || '?')}
                            </AvatarFallback>
                        </Avatar>
                    )}
                    <div className="min-w-0 flex-1">
                        <p className="text-sm">
                            <span className="font-medium">
                                {item.actor?.name || 'Someone'}
                            </span>{' '}
                            {link && item.target?.title ? (
                                <Link
                                    to={link}
                                    className="text-muted-foreground hover:text-foreground hover:underline"
                                >
                                    {item.summary}
                                </Link>
                            ) : (
                                <span className="text-muted-foreground">
                                    {item.summary}
                                </span>
                            )}
                            {item.project && (
                                <>
                                    {' '}
                                    <span className="text-muted-foreground">
                                        in
                                    </span>{' '}
                                    <Link
                                        to={`/projects/${item.project.id}`}
                                        className="font-medium hover:underline"
                                    >
                                        {item.project.name}
                                    </Link>
                                </>
                            )}
                        </p>
                        {item.preview && (
                            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                {item.preview}
                            </p>
                        )}
                        <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                            {format(
                                new Date(item.createdAt),
                                "yyyy-MM-dd 'at' HH:mm:ss",
                            )}
                        </p>
                        {debugMode && (
                            <details className="mt-2 rounded border border-dashed border-rose-300 bg-rose-50/40 px-2 py-1 text-[11px] dark:bg-rose-900/10">
                                <summary className="cursor-pointer text-rose-700 dark:text-rose-300">
                                    <Bug className="-mt-0.5 mr-1 inline h-3 w-3" />
                                    debug · raw
                                </summary>
                                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                                    {JSON.stringify(
                                        {
                                            id: item.id,
                                            type: item.type,
                                            target: item.target,
                                            project: item.project,
                                            actor: item.actor,
                                        },
                                        null,
                                        2,
                                    )}
                                </pre>
                            </details>
                        )}
                    </div>
                    {/* Restore button for soft-deleted tasks. The
                        BE keeps the row alive (deletedAt timestamp)
                        for as long as it lives in the DB so admins
                        can put it back together with any subtasks
                        that were deleted in the same operation. */}
                    {canRestore && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={handleRestore}
                            disabled={restoring}
                            className="h-7 shrink-0 gap-1 self-start text-xs"
                            title="Restore this task and any subtasks deleted with it"
                        >
                            <Undo2 className="h-3.5 w-3.5" />
                            {restoring ? 'Restoring…' : 'Restore'}
                        </Button>
                    )}
                    {/* Bookmark / pin button — per-row, fires the
                        optimistic toggle on the shared pin hook. */}
                    {pinHook && (
                        <PinButton
                            kind="ACTIVITY"
                            refId={item.id}
                            variant="pin"
                            size="xs"
                            pinHookOverride={pinHook}
                            className="self-start"
                        />
                    )}
                </div>
            </div>
        </li>
    );
}

// The Activities page used to host three tabs (My / All activities + Feed).
// "My activities" and "All activities" now live alongside the personal
// to-do list under /todos, so this page is just the audit feed — and
// the audit feed is admin-only.
export default function Activities() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';

    return (
        <>
            <TopBar title="Activity feed" />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="flex w-full flex-col gap-4">
                    <p className="px-1 text-xs text-muted-foreground">
                        Workspace audit log: projects, tasks, notes, files,
                        status changes and approvals.
                    </p>
                    {isAdmin ? (
                        <FeedView />
                    ) : (
                        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-card p-12 text-center shadow-sm">
                            <ActivityIcon className="h-10 w-10 text-muted-foreground" />
                            <p className="font-medium">
                                The activity feed is admin-only
                            </p>
                            <p className="text-sm text-muted-foreground">
                                Looking for your meetings, calls and reminders?
                                {"They\u2019re on the "}
                                <Link
                                    to="/todos"
                                    className="font-medium text-primary hover:underline"
                                >
                                    My to-do
                                </Link>{' '}
                                page.
                            </p>
                        </div>
                    )}
                </div>
            </main>
        </>
    );
}
