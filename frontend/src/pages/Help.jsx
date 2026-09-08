// Help page — a single, scannable reference that explains every module
// in the app, in plain language, with a "how to use it" paragraph per
// section and a few short tips. Lives at /help and is linked from the
// sidebar above the user card so it's always one click away.
//
// Mostly presentational — the only API surface is the "Contact admin"
// dialog at the bottom of the page (loads admins via /users and posts
// a direct message via /conversations/dm + /conversations/:id/messages).
// Anything the visiting user can't access is still described in this
// doc — that's intentional, the doc reads the same for everyone so
// admins / managers can use it for onboarding too.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
    Activity,
    AlarmClock,
    AlertTriangle,
    AppWindow,
    ArrowRight,
    AtSign,
    BadgeDollarSign,
    BarChart3,
    BellRing,
    Bug,
    CalendarRange,
    Check,
    CheckCircle2,
    CheckSquare,
    ChevronDown,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    CirclePlay,
    Clock,
    Copy,
    Download,
    Eye,
    FileQuestion,
    FileText,
    Filter,
    Flag,
    FolderKanban,
    GitBranch,
    GripVertical,
    HelpCircle,
    Hash,
    Highlighter,
    Info,
    Layers,
    LayoutDashboard,
    LayoutList,
    LifeBuoy,
    Lightbulb,
    LineChart,
    ListChecks,
    Loader2,
    Lock,
    Mail,
    MessageSquare,
    MessageSquarePlus,
    Paperclip,
    Pause,
    Pencil,
    Pin,
    Play,
    Plus,
    RefreshCw,
    Reply,
    Repeat,
    Search,
    Send,
    Settings2,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    Star,
    Stethoscope,
    Tag,
    TestTube2,
    Timer,
    Trash2,
    Undo2,
    UserCircle,
    UserCog,
    Users,
    Users2,
    UsersRound,
    Wrench,
    X,
    Zap,
} from 'lucide-react';

import { api } from '@/lib/api';
import { APP_NAME, APP_VERSION, APP_COPYRIGHT } from '@/lib/appInfo';
import { useAuth } from '@/contexts/AuthContext';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { TopBar } from '@/components/TopBar';
import {
    Avatar,
    AvatarFallback,
    AvatarImage,
} from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardTitle,
} from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

// Icon legend — grouped by intent so a new user can scan for what
// they're seeing on a page. Order matters: we keep the most common
// groups (status / actions) at the top. To add a new icon: import
// it from lucide-react above, then drop it in the right group with
// a one-line "what it means in this app" caption.
//
// Tone: describe the *semantics in this product*, not just the
// generic shape ("Active sprint" beats "Play button"). If the same
// icon means two things in two pages, list both meanings — that's
// useful disambiguation, not a contradiction.
const ICON_LEGEND_GROUPS = [
    {
        id: 'icons-status',
        title: 'Status & state',
        items: [
            {
                Icon: CheckCircle2,
                name: 'Done',
                desc: 'Task / subtask is in DONE status, or sprint task is complete.',
            },
            {
                Icon: CirclePlay,
                name: 'Active',
                desc: 'Sprint is currently running, or timer is live.',
            },
            {
                Icon: Pause,
                name: 'Paused',
                desc: 'Timer paused, or schedule disabled but not removed.',
            },
            {
                Icon: AlertTriangle,
                name: 'Warning / overdue',
                desc: 'Past due date, deadline alert, or destructive confirmation.',
            },
            {
                Icon: Flag,
                name: 'Priority flag',
                desc: 'Task priority indicator (color = severity).',
            },
            {
                Icon: Eye,
                name: 'Visibility / preview',
                desc: 'Show / preview a record without opening its full editor.',
            },
            {
                Icon: Lock,
                name: 'Locked / restricted',
                desc: 'Access requires a capability you don\u2019t hold, or the record is immutable (e.g. closed sprint).',
            },
        ],
    },
    {
        id: 'icons-actions',
        title: 'Common actions',
        items: [
            {
                Icon: Pencil,
                name: 'Edit',
                desc: 'Open the inline or modal editor for the row / card.',
            },
            {
                Icon: Plus,
                name: 'Add / create',
                desc: 'Create a new record (task, sprint, note, project, user, ...).',
            },
            {
                Icon: Trash2,
                name: 'Delete',
                desc: 'Permanent removal. Always asks for a confirmation step.',
            },
            {
                Icon: Copy,
                name: 'Copy / duplicate',
                desc: 'Copy text to the clipboard, or duplicate a record.',
            },
            {
                Icon: Repeat,
                name: 'Reassign / cycle',
                desc: 'Move ownership to a different user, or re-run a scheduled job.',
            },
            {
                Icon: Undo2,
                name: 'Undo / revert',
                desc: 'Roll the record back to a previous state (e.g. re-open a closed sprint).',
            },
            {
                Icon: Send,
                name: 'Send',
                desc: 'Send the message / submit the form.',
            },
            {
                Icon: Reply,
                name: 'Reply',
                desc: 'Reply inline to a note, message or comment.',
            },
            {
                Icon: Download,
                name: 'Download',
                desc: 'Download the file, the CSV export, or the release artifact.',
            },
            {
                Icon: X,
                name: 'Close / dismiss',
                desc: 'Close the dialog, clear the filter chip, or remove the inline tag.',
            },
        ],
    },
    {
        id: 'icons-nav',
        title: 'Navigation & layout',
        items: [
            {
                Icon: ChevronDown,
                name: 'Expand / show more',
                desc: 'Open a collapsed section, dropdown, or accordion card.',
            },
            {
                Icon: ChevronRight,
                name: 'Drill in',
                desc: 'Step into a child record (subtask, nested phase, ...).',
            },
            {
                Icon: ArrowRight,
                name: 'Path separator',
                desc: 'Used in breadcrumbs (Project \u2192 Task \u21b3 Subtask).',
            },
            {
                Icon: ChevronsLeft,
                name: 'Collapse sidebar',
                desc: 'Shrink the left nav to an icon-only rail.',
            },
            {
                Icon: ChevronsRight,
                name: 'Expand sidebar',
                desc: 'Restore the full sidebar with text labels.',
            },
            {
                Icon: GripVertical,
                name: 'Drag handle',
                desc: 'Drag to reorder a task, subtask, phase, or column item.',
            },
            {
                Icon: LayoutList,
                name: 'List view',
                desc: 'Switch to the row-per-item list layout.',
            },
            {
                Icon: LayoutDashboard,
                name: 'Dashboard / board view',
                desc: 'Switch to the card / board layout.',
            },
            {
                Icon: Search,
                name: 'Search / find',
                desc: 'Global search (top bar) or filter the current list.',
            },
            {
                Icon: Filter,
                name: 'Filter',
                desc: 'Open the filter dropdown / multi-select.',
            },
            {
                Icon: SlidersHorizontal,
                name: 'Settings / advanced filters',
                desc: 'Page-level settings, or expanded filter controls.',
            },
            {
                Icon: Settings2,
                name: 'Configure',
                desc: '"Schedule\u2026" button on the sprint banner, or any per-record config dialog.',
            },
        ],
    },
    {
        id: 'icons-sprints',
        title: 'Sprints',
        items: [
            {
                Icon: Zap,
                name: 'Sprints module',
                desc: 'Anywhere you see this, you\u2019re on or linking to the Sprints tab.',
            },
            {
                Icon: CalendarRange,
                name: 'Sprint window',
                desc: 'A date range for the sprint (start \u2192 end).',
            },
            {
                Icon: AlarmClock,
                name: 'Auto-generated sprint',
                desc: 'Created by the sprint scheduler, not by hand.',
            },
            {
                Icon: LineChart,
                name: 'Burndown',
                desc: 'Burndown chart view for the active or closed sprint.',
            },
            {
                Icon: ListChecks,
                name: 'Sprint task list',
                desc: 'The task / subtask roster attached to the sprint.',
            },
            {
                Icon: Play,
                name: 'Start sprint / generate now',
                desc: 'Move PLANNED \u2192 ACTIVE, or trigger an immediate scheduler run.',
            },
            {
                Icon: Layers,
                name: 'Phases / hierarchy',
                desc: 'Phase header in the Plan view, or nested-task grouping.',
            },
        ],
    },
    {
        id: 'icons-time',
        title: 'Time tracking',
        items: [
            {
                Icon: Timer,
                name: 'Time tracking module',
                desc: 'Top-bar pill = live timer running for you right now.',
            },
            {
                Icon: Clock,
                name: 'Log time',
                desc: 'Open the quick "log time" dialog from a task or subtask.',
            },
            {
                Icon: BarChart3,
                name: 'Time charts / Insights',
                desc: 'Aggregate views of hours by project / user / day.',
            },
        ],
    },
    {
        id: 'icons-work',
        title: 'Work objects',
        items: [
            {
                Icon: FolderKanban,
                name: 'Project',
                desc: 'Anywhere you see this you\u2019re looking at (or linking to) a project.',
            },
            {
                Icon: CheckSquare,
                name: 'Task / to-do',
                desc: 'A top-level task, or the To-do page in the sidebar.',
            },
            {
                Icon: AppWindow,
                name: 'Application',
                desc: 'An application record (Test \u2192 Pilot \u2192 Approved releases).',
            },
            {
                Icon: GitBranch,
                name: 'Release',
                desc: 'A release / version under an application.',
            },
            {
                Icon: Hash,
                name: 'Code / identifier',
                desc: 'Used inline with codes like P-25-007 / T-0042 / ST-0010.',
            },
            {
                Icon: Tag,
                name: 'Tag / label',
                desc: 'Free-form label attached to a record.',
            },
        ],
    },
    {
        id: 'icons-people',
        title: 'People',
        items: [
            {
                Icon: Users,
                name: 'Users',
                desc: 'User management page or the participants list.',
            },
            {
                Icon: Users2,
                name: 'Teams',
                desc: 'Teams / groups page.',
            },
            {
                Icon: UsersRound,
                name: 'Participants',
                desc: 'Project participants tab.',
            },
            {
                Icon: UserCog,
                name: 'Reassignment',
                desc: 'Reassign ownership of a record to another user.',
            },
            {
                Icon: ShieldCheck,
                name: 'Admin / permissions',
                desc: 'Admin-only action, or capabilities matrix.',
            },
            {
                Icon: AtSign,
                name: '@mention',
                desc: 'Mention a user in a note / message — they get a notification.',
            },
        ],
    },
    {
        id: 'icons-comm',
        title: 'Communication & alerts',
        items: [
            {
                Icon: MessageSquare,
                name: 'Messages / chat',
                desc: 'DM, group chat, or per-record discussion thread.',
            },
            {
                Icon: MessageSquarePlus,
                name: 'New note / comment',
                desc: 'Add a new inline note on a task or subtask.',
            },
            {
                Icon: BellRing,
                name: 'Notification',
                desc: 'Notification bell / alert preference.',
            },
            {
                Icon: Mail,
                name: 'Email / contact admin',
                desc: 'Email-based notification or the "Contact admin" action.',
            },
            {
                Icon: Paperclip,
                name: 'Attachment',
                desc: 'File or image attached to a note, task, or release.',
            },
            {
                Icon: FileText,
                name: 'Document',
                desc: 'A document-type file or a long-form note.',
            },
        ],
    },
    {
        id: 'icons-meta',
        title: 'Insights, audit & misc',
        items: [
            {
                Icon: Activity,
                name: 'Activity / audit feed',
                desc: 'Cross-record audit log; per-record activity timeline.',
            },
            {
                Icon: BadgeDollarSign,
                name: 'Billing',
                desc: 'Project billing tab and the dedicated Billing page.',
            },
            {
                Icon: Sparkles,
                name: 'Tips / highlights',
                desc: 'Recently shipped feature, or a "did you know" hint.',
            },
            {
                Icon: HelpCircle,
                name: 'Help',
                desc: 'This page, or contextual help affordances.',
            },
            {
                Icon: LifeBuoy,
                name: 'Support',
                desc: 'The Help page header / sidebar entry.',
            },
            {
                Icon: Bug,
                name: 'Debug panel',
                desc: 'Temporary developer-facing inspector (e.g. sprint "Logged" breakdown).',
            },
            {
                Icon: RefreshCw,
                name: 'Refresh / reload',
                desc: 'Re-fetch the current list without leaving the page.',
            },
            {
                Icon: Loader2,
                name: 'Loading',
                desc: 'Spinning while we fetch / save.',
            },
            {
                Icon: Check,
                name: 'Confirmed / saved',
                desc: 'Inline confirmation that a value was accepted.',
            },
        ],
    },
    {
        id: 'icons-tips-pins',
        title: 'Tips, debug & highlights',
        items: [
            {
                Icon: Lightbulb,
                name: 'Tip',
                desc: 'Just-in-time suggestion next to a field / control. Click to expand a short hint.',
            },
            {
                Icon: Info,
                name: 'Info',
                desc: 'Definition / context for the surrounding metric, chart or filter.',
            },
            {
                Icon: HelpCircle,
                name: 'How this works',
                desc: 'Explains the mechanics behind a heatmap, KPI or score.',
            },
            {
                Icon: Bug,
                name: 'Debug',
                desc: 'Power-user inspector (raw event payload, KPI breakdown, burndown internals). Often behind an admin gate or ?debug=1.',
            },
            {
                Icon: Stethoscope,
                name: 'Diagnose',
                desc: 'Runs sanity checks and shows where a number came from (e.g. burndown explain panel).',
            },
            {
                Icon: Wrench,
                name: 'Recalculate / repair',
                desc: 'Time tracking diagnostics — overlaps, zero-duration entries, orphan rows.',
            },
            {
                Icon: TestTube2,
                name: 'View as (read-only)',
                desc: 'Admin shortcut to inspect another user\u2019s time / activity feed. The audit trail still records YOUR session.',
            },
            {
                Icon: Pin,
                name: 'Pin / bookmark',
                desc: 'Pin a project to the top of the list, or bookmark an activity row for follow-up. Per-user.',
            },
            {
                Icon: Star,
                name: 'Star',
                desc: 'Star a sprint goal or flag a release as your current production target.',
            },
            {
                Icon: Highlighter,
                name: 'Today\u2019s focus',
                desc: 'Mark a task / subtask as today\u2019s focus. Renders a fuchsia stripe on the sprint board.',
            },
            {
                Icon: Sparkles,
                name: 'What\u2019s new',
                desc: 'Top-bar changelog popover. Pulses when RELEASE_NOTES has a new entry since you last looked.',
            },
        ],
    },
];

// Small presentational helper for one icon row. Kept inline so the
// Help page stays self-contained and we don't grow a tiny component
// library for a single use site.
function LegendItem({ Icon, name, desc }) {
    return (
        <li className="flex items-start gap-2.5 rounded-md border bg-card/60 px-2.5 py-2 transition-colors hover:bg-accent/40">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground">
                <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 space-y-0.5">
                <span className="block text-xs font-semibold text-foreground">
                    {name}
                </span>
                <span className="block text-[11px] leading-snug text-muted-foreground">
                    {desc}
                </span>
            </span>
        </li>
    );
}

// One source of truth for the page contents. Easy to extend / reorder
// without touching JSX.
const SECTIONS = [
    {
        id: 'overview',
        icon: LayoutDashboard,
        accent: 'text-primary',
        title: 'Welcome',
        lead: `${APP_NAME} is a single workspace for projects, application releases, time tracking and the SDLC procedure around them.`,
        body: (
            <>
                <p>
                    The app is organised around four pillars: project
                    management, application release management, time
                    tracking, and an audit trail across everything that
                    changes. The sidebar groups every feature by intent
                    — <strong>Work</strong>, <strong>People</strong>,{' '}
                    <strong>Insights</strong> and{' '}
                    <strong>Admin</strong> — so you can collapse
                    sections you don&apos;t use and keep the navigation
                    short.
                </p>
                <p>
                    What you see in the sidebar depends on your role
                    (Admin / Manager / App Moderator / User) and on the
                    granular capabilities an administrator has granted
                    you. If something looks missing, ask an admin to
                    tick the right capability on your profile.
                </p>
            </>
        ),
    },
    {
        id: 'about',
        icon: Info,
        accent: 'text-slate-600',
        title: 'About & version',
        lead: 'The version you are running, how releases are numbered, and where to see what changed.',
        body: (
            <>
                <p>
                    <strong>{APP_NAME}</strong> — version{' '}
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        v{APP_VERSION}
                    </span>
                    . Releases follow <em>semantic versioning</em>{' '}
                    (<span className="font-mono">MAJOR.MINOR.PATCH</span>): the
                    major number bumps for big milestones, the minor for new
                    backwards-compatible features, and the patch for fixes.
                </p>
                <p>
                    To see what changed, open the{' '}
                    <strong>What&apos;s new</strong> popover — the{' '}
                    <Sparkles className="inline h-3.5 w-3.5 align-text-bottom text-amber-500" />{' '}
                    sparkle in the top bar. It lists the latest entries, and
                    the full numbered release notes live there too.
                </p>
                <p className="text-xs text-muted-foreground">{APP_COPYRIGHT}</p>
            </>
        ),
    },
    {
        id: 'projects',
        icon: FolderKanban,
        accent: 'text-sky-600',
        title: 'Projects',
        lead: 'Plan work, organise it into phases, tasks and subtasks, and keep notes / files / billing all on one page.',
        body: (
            <>
                <p>
                    Open <Link to="/projects" className="text-primary hover:underline">Projects</Link>
                    {' '}to browse the catalogue. Multi-select filters
                    let you slice by status, priority, owner, reporter
                    and project type. The toolbar has two sticky
                    show/hide switches for <em>Completed</em> and{' '}
                    <em>On hold</em> so you can keep them out of view
                    until you need them. Your filter + column choices
                    persist in your browser, no save button needed.
                </p>
                <p>
                    Click any row to enter the project. Inside, the
                    tabs cover everything from the plan (phases →
                    tasks → subtasks) to notes (with @-mentions and
                    image/file embeds), files, contacts, activity,
                    billing and the project timeline.
                </p>
                <p>
                    <strong>Tip — codes:</strong> every project gets a
                    short code like <code>P-25-USA-0001</code>, every
                    task <code>T-0001</code>, every subtask{' '}
                    <code>ST-0001</code>. Codes are globally searchable
                    from the top bar, and any code typed in a note
                    becomes a clickable deep-link automatically — see
                    the section below.
                </p>
            </>
        ),
    },
    {
        id: 'project-organization',
        icon: Layers,
        accent: 'text-emerald-600',
        title: 'Project groups & ordering',
        lead: 'Two personal ways to tame a long Projects list — bundle projects into your own colour-tagged groups, and drag the list into the order you like.',
        body: (
            <>
                <p>
                    <strong>Groups</strong> are your own private way to
                    bundle related projects. Open{' '}
                    <strong>Manage groups</strong> from the Projects page
                    to create a group, give it a name and colour, and tick
                    which projects belong to it. A project can live in
                    several groups at once, and groups never change the
                    project itself — they&apos;re just an organising layer.
                </p>
                <ul className="ml-5 list-disc space-y-1">
                    <li>
                        <strong>Private to you</strong> — every user has
                        their own groups and only ever sees their own.
                        There&apos;s no shared or org-wide group.
                    </li>
                    <li>
                        <strong>Filter from the sidebar</strong> — your
                        groups show as a nested list under Projects.
                        Click one to filter the Projects page to just
                        that group; a chip at the top clears the filter.
                    </li>
                </ul>
                <p>
                    <strong>Ordering:</strong> drag any project row in the
                    list to reorder it. Your order is saved to your
                    account and follows you to any device after login —
                    it&apos;s personal, so it never affects anyone
                    else&apos;s list. Reordering is available when the
                    list isn&apos;t being narrowed by a filter, so a drag
                    can&apos;t accidentally reshuffle a filtered subset.
                </p>
            </>
        ),
    },
    {
        id: 'notes-linked-codes',
        icon: Hash,
        accent: 'text-primary',
        title: 'Linked codes in notes',
        lead: 'Type / in any note to pop a task picker, or paste a code directly — the rendered note turns matching codes into clickable links.',
        body: (
            <>
                <p>
                    Inside the project Notes panel and the per-task
                    note dialog, the composer recognises two trigger
                    keys:
                </p>
                <ul className="ml-5 list-disc space-y-1">
                    <li>
                        <code>@</code> — pops a participant picker
                        scoped to this project. Pick a name and they
                        get a notification when the note is saved.
                    </li>
                    <li>
                        <code>/</code> — pops a task / subtask picker
                        scoped to this project. Type a few digits of a
                        code (<code>/T-04</code>) or a few letters of
                        a title (<code>/payment</code>) and arrow-key
                        through the matches. <kbd>Enter</kbd> inserts
                        the bare code (e.g. <code>T-0042</code>);{' '}
                        <kbd>Esc</kbd> dismisses.
                    </li>
                </ul>
                <p>
                    When the note is later <em>rendered</em>, every
                    <code>T-####</code> / <code>ST-####</code> token
                    becomes a clickable chip that takes the reader
                    straight to that task and pulses the row on arrival.
                    You can also write a cross-project reference like{' '}
                    <code>P-25-USA-0001/T-0042</code> by hand — the
                    renderer resolves it the same way.
                </p>
                <p>
                    Codes you reference but can&apos;t access (or that
                    don&apos;t exist) stay readable but are shown as a
                    muted, struck-through chip — so a copy-pasted note
                    that crosses project boundaries degrades gracefully
                    instead of producing dead links.
                </p>
            </>
        ),
    },
    {
        id: 'notes-feed',
        icon: MessageSquarePlus,
        accent: 'text-amber-600',
        title: 'Notes & updates',
        lead: 'A task’s running commentary now follows it everywhere — expand it inline, read the full history, or add one while you log time.',
        body: (
            <>
                <p>
                    Every task and subtask keeps a feed of notes /
                    status updates. The same feed shows up across the
                    app so you don&apos;t have to hunt for it:
                </p>
                <ul className="ml-5 list-disc space-y-1">
                    <li>
                        <strong>On the project Plan</strong> — each task
                        or subtask row has its own{' '}
                        <em>show / hide notes</em> toggle, so you can pop
                        open just the rows you care about without
                        expanding the whole plan.
                    </li>
                    <li>
                        <strong>Subtasks too</strong> — subtask rows
                        carry their own notes the same way their parent
                        does.
                    </li>
                    <li>
                        <strong>While logging time</strong> — the Time
                        tracking views let you attach a note as you log
                        hours, so the context lands with the entry.
                    </li>
                    <li>
                        <strong>From My to-do</strong> — opening a task
                        to leave a note now also lets you read its full
                        notes history, not just add a new one.
                    </li>
                    <li>
                        <strong>On the planning-sprint backlog</strong> —
                        backlog cards show the task name in bold plus the
                        first line of its description, so you can
                        recognise a card at a glance.
                    </li>
                </ul>
                <p>
                    Notes still support <code>@</code>-mentions and{' '}
                    <code>/</code> code links (see{' '}
                    <em>Linked codes in notes</em> above), and posting an{' '}
                    <em>Update</em> on a sprint row can flip the
                    task&apos;s status in the same action.
                </p>
            </>
        ),
    },
    {
        id: 'sprints',
        icon: Zap,
        accent: 'text-violet-600',
        title: 'Sprints',
        lead: 'Scrum-style iterations on top of any project. Plan a sprint, drag tasks into it, run it, then close with a burndown.',
        body: (
            <>
                <p>
                    Open any project and switch to the{' '}
                    <strong>Sprints</strong> tab. Three subviews:
                </p>
                <ul className="ml-5 list-disc space-y-1">
                    <li>
                        <strong>List</strong> — Planned, Active, and
                        Closed columns. Each card shows the sprint
                        dates, goal and a small progress bar
                        (completed vs total tasks).
                    </li>
                    <li>
                        <strong>Board</strong> — appears as soon as
                        any sprint exists (planned, active, or
                        closed). A picker at the top of the board
                        lets you switch between sprints — useful for
                        pre-populating a planned sprint, scanning a
                        closed sprint's task snapshot, or jumping
                        between two active iterations on different
                        teams. The picker groups options by status:
                        active first, then planned chronologically,
                        then closed most-recent-first. Two columns:
                        Backlog vs the selected sprint. Drag a task to
                        commit it; drag it back out to send it to the
                        backlog. CLOSED sprints are{' '}
                        <strong>read-only</strong> — the picker still
                        works but drag, add, remove, and Close buttons
                        all hide, and a small chip next to the picker
                        labels the view as such (so you don't acci-
                        dentally try to "fix" a historical snapshot).
                        The header shows a per-user capacity heatmap
                        (planned vs estimated hours), so overload
                        jumps out in red. Subtasks ride along with
                        their parent automatically and render nested
                        underneath with their own status pill plus a{' '}
                        <code>done/total</code> counter on the parent
                        chip so you can track per-subtask progress
                        without leaving the Sprint tab.
                    </li>
                    <li>
                        <strong>Burndown</strong> — line chart with
                        the ideal straight-line trajectory + the
                        actual remaining hours, including a live
                        "today" point even before the nightly snapshot
                        runs.
                    </li>
                </ul>
                <p>
                    <strong>Lifecycle:</strong> PLANNED → ACTIVE → CLOSED.
                    Only one sprint can be active per project. On
                    close, you pick what happens to incomplete tasks
                    (push to next sprint, back to backlog, or keep for
                    retrospective reporting).
                </p>
                <p>
                    <strong>Capacity:</strong> in the active sprint's
                    header, click <em>Capacity</em> to enter planned
                    hours per project member. The board shows planned
                    vs estimated load per user as horizontal bars;
                    actual logged time rolls up automatically from the
                    Time tracking module via each task's time entries.
                </p>
                <p>
                    <strong>Schedule (auto-generate):</strong> on the
                    Sprints tab, the <em>Schedule</em> button next to{' '}
                    <em>New sprint</em> lets you set up a recurring
                    cadence — daily, weekly, bi-weekly, or monthly.
                    Pick a
                    cadence, an anchor date, a lookahead count (how
                    many future PLANNED sprints to keep on the timeline)
                    and an optional name pattern with tokens like{' '}
                    <code>{'{n}'}</code>, <code>{'{start}'}</code>,{' '}
                    <code>{'{month}'}</code>. A background job sweeps
                    every hour and appends new PLANNED sprints starting
                    where the latest sprint ends (or from the anchor
                    if the project has no sprints yet). Disable to
                    pause without losing the config; remove to clear
                    it entirely. Hit <em>Generate now</em> in the
                    schedule banner if you don't want to wait for the
                    next sweep. Two ways to clean up if the generator
                    rolled out too many planned sprints:{' '}
                    <strong>(a)</strong> the Schedule dialog's{' '}
                    <em>Danger zone</em> with a "Keep first N" input
                    that previews the range to delete and commits it
                    on <em>Save</em> (the button label morphs to{' '}
                    <em>Save · delete X</em>); Lookahead auto-clamps
                    to your keep-count so the generator can't
                    immediately refill what you removed.{' '}
                    <strong>(b)</strong> the rose{' '}
                    <em>Delete schedule</em> button on the schedule
                    banner above the list — one click + a confirm row
                    wipes the schedule AND every planned sprint for
                    the project in a single request. Active and
                    closed sprints are never touched; tasks pinned to
                    deleted sprints return to the backlog.
                </p>
                <p>
                    <strong>Log time on a task:</strong> every task and
                    subtask in the Plan view has a small <em>clock</em>{' '}
                    icon next to its actions (note / reassign / +
                    subtask / delete). It opens a 2-line dialog —
                    pick a duration (15 min to 8 hours), an optional
                    note, and save. The entry shows up in your Time
                    tracking page and rolls into the sprint's actual
                    burndown.
                </p>
                <p>
                    <strong>Permissions:</strong> admins and managers
                    hold all sprint powers by default. Regular users
                    can be granted any subset of{' '}
                    <code>sprint:create</code>, <code>sprint:edit</code>,
                    <code>sprint:delete</code>, <code>sprint:start</code>,
                    <code>sprint:close</code>, and a lighter{' '}
                    <code>sprint:assign-task</code> (so an IC can pull
                    their own work in/out of the active sprint without
                    full edit rights). The scheduler is gated by{' '}
                    <code>sprint:edit</code>.
                </p>
            </>
        ),
    },
    {
        id: 'planning-sprints',
        icon: CalendarRange,
        accent: 'text-violet-600',
        title: 'Planning sprints (cross-project)',
        lead: 'Admin/manager planning boards that pull tasks from ANY project into one time-boxed window — independent of each project’s own sprints.',
        body: (
            <>
                <p>
                    Open <strong>Planning sprints</strong> from the
                    sidebar. Unlike project sprints, a planning sprint
                    is not tied to one project: it groups tasks from
                    every project you can access, optionally scoped to
                    a team (or org-wide). A task can sit in its
                    project&apos;s sprint AND a planning sprint at the
                    same time — membership is independent.
                </p>
                <ul className="ml-5 list-disc space-y-1">
                    <li>
                        <strong>Backlog column</strong> (violet) —
                        every open task across your projects that
                        isn&apos;t in this sprint yet, grouped by
                        project with its own search box. Drag a card
                        into the sprint (or hit <em>+</em>) to commit
                        it; drag it back to remove. On an{' '}
                        <strong>active</strong> sprint the board adds
                        To&nbsp;do / In&nbsp;progress / Done columns —
                        dropping a backlog card straight onto a status
                        column also sets that status.
                    </li>
                    <li>
                        <strong>Project trees</strong> — both columns
                        group tasks under a project header, and every
                        project has a stable color shown as a dot in
                        the header and a left stripe on each of its
                        cards, so one project&apos;s work is traceable
                        across all columns. Subtasks render nested
                        under their parent (display-only — adding the
                        parent is what commits the family).
                    </li>
                    <li>
                        <strong>Task name = quick view</strong> — click
                        any task title to open the same dialog as the
                        project Plan: details, leave a note, log time,
                        and (for managers) change status. The priority
                        label on each row is an inline picker too.
                    </li>
                    <li>
                        <strong>Notes</strong> — each row expands to
                        its amber notes feed (including notes pinned to
                        its subtasks, badged with{' '}
                        <code>↳ code</code>). The{' '}
                        <em>Show notes / Hide notes</em> button next to{' '}
                        <em>Add tasks</em> expands or collapses all
                        rows at once. <em>Update</em> posts a note and
                        optionally flips the status in one action — it
                        also lands in the project&apos;s Notes panel.
                    </li>
                    <li>
                        <strong>Collapsible columns</strong> — on an
                        active sprint, the chevron in each column header
                        folds Backlog / To&nbsp;do / In&nbsp;progress /
                        Done down to a slim labelled strip (you can still
                        drop a card onto it); the columns you leave open
                        grow to fill the freed space. Your fold choices
                        are remembered in this browser. Task and subtask
                        titles wrap across the full card width, so long
                        names read in full instead of being clipped.
                    </li>
                    <li>
                        <strong>Lifecycle &amp; analytics</strong> —
                        PLANNED → ACTIVE → CLOSED with a close strategy
                        for incomplete tasks (keep / push to next /
                        back to backlog). The Analytics tab shows
                        completion, load by assignee, a per-project
                        breakdown and a burndown chart. A per-team
                        scheduler can auto-generate recurring planning
                        sprints (daily standup windows, weekly plans…).
                    </li>
                </ul>
                <p>
                    <strong>Permissions:</strong> the whole page is
                    admin/manager only. Managers see tasks only from
                    projects they can access; closed sprints are
                    read-only snapshots.
                </p>
            </>
        ),
    },
    {
        id: 'todos',
        icon: CheckSquare,
        accent: 'text-sky-600',
        title: 'My to-do',
        lead: 'The personal feed of tasks and subtasks assigned to you, with a deadline-aware urgency view.',
        body: (
            <>
                <p>
                    Open <Link to="/todos" className="text-primary hover:underline">My to-do</Link>
                    {' '}to see everything assigned to you across every
                    project. The badge in the sidebar lights up when
                    you have items due soon. Click any item to jump
                    straight to the task in its project.
                </p>
                <p>
                    The <em>My activities</em> tab inside this page
                    shows the activity feed scoped to events you
                    participated in — useful when you want a quick
                    "what did I do this week" read.
                </p>
            </>
        ),
    },
    {
        id: 'messages',
        icon: MessageSquare,
        accent: 'text-sky-600',
        title: 'Messages',
        lead: 'Real-time chat in two tabs: per-project conversations and direct messages between users.',
        body: (
            <>
                <p>
                    <Link to="/messages" className="text-primary hover:underline">Messages</Link>
                    {' '}has two tabs:{' '}
                    <strong>Project messages</strong> (one
                    conversation per project, scoped to its
                    participants) and <strong>Direct messages</strong>{' '}
                    (1-on-1 chats with anyone in the workspace). You
                    can attach images and files; attachments live for
                    30 days and are then garbage-collected
                    automatically.
                </p>
                <p>
                    <strong>Tip:</strong> the unread badge clears as
                    soon as you open a conversation — no page reload
                    needed.
                </p>
            </>
        ),
    },
    {
        id: 'time',
        icon: Timer,
        accent: 'text-sky-600',
        title: 'Time tracking',
        lead: 'Live timer and manual entries, rolled up per project / per task / per subtask, with charts and CSV export.',
        body: (
            <>
                <p>
                    <Link to="/time" className="text-primary hover:underline">Time tracking</Link>
                    {' '}has a live timer in the sidebar — start it
                    when you begin work, stop it when you finish. For
                    historical entries use <em>Log time</em> with
                    30-minute steps.
                </p>
                <p>
                    Time rolls up automatically: subtask → task →
                    project → application. Switch to the{' '}
                    <strong>Charts</strong> tab for daily / per-user /
                    per-project bars. Admins see an extra <em>All
                    users</em> spreadsheet with filters and CSV
                    export.
                </p>
                <p>
                    Both the <strong>Charts</strong> and{' '}
                    <strong>All users</strong> tabs include a{' '}
                    <em>Tasks</em> multi-select filter — open the
                    dropdown, search by code or title, and tick any
                    number of tasks to narrow stats / entries down to
                    just those. The task list follows the{' '}
                    <em>Project</em> filter (specific project →
                    that project's tasks; "All projects" → every task
                    you can see). The CSV export honours whatever's
                    selected so you can download exactly the slice
                    you're looking at.
                </p>
                <p>
                    Entries logged against a subtask now render the
                    full path on <strong>My time</strong>:{' '}
                    <em>Project → Parent task ↳ Subtask</em>, so
                    you can tell two "Testing" subtasks under
                    different parents apart. The running-timer pill
                    in the top bar also includes the parent name
                    when you're timing a subtask.
                </p>
                <p>
                    A note on hour formatting: the app uses 30-minute
                    steps for manual entries, but the live timer
                    records actual wall-clock seconds, so summed
                    totals on the <strong>Sprint board</strong>{' '}
                    (Est. hours, Logged) are no longer rendered as
                    "12.5h" — they read as <em>"12h 30m"</em>{' '}
                    instead, matching the units you typed in. The{' '}
                    <em>Log time</em> dialog (clock icon next to any
                    task or subtask) follows the same convention: 15 /
                    30 / 45 min for short entries, then strict
                    30-minute steps from <em>1h</em> all the way to{' '}
                    <em>8h</em> — no more "1.5 hr" stragglers, and no
                    more jumping straight from 2h to 3h.
                </p>
                <p>
                    <strong>My time</strong> also includes a{' '}
                    <em>daily-load chart</em>: one bar per day, blue
                    under 8h, amber at or over 8h, rose at or over
                    10h, with a dashed reference line at the 8h
                    workday boundary. Use the{' '}
                    <em>7 / 15 / 30 days</em> presets to switch
                    windows or pick <em>Custom</em> to drop in a{' '}
                    <em>from → to</em> range for a specific stretch
                    (handy for billing periods or sprint
                    retrospectives). A small project filter scopes
                    the chart when you want to see which project ate
                    the week. <strong>Click any bar</strong> to
                    filter the entries list below to just that day —
                    the selected bar gets a strong ring so you can
                    see what's active, and a chip in the entries
                    header shows the active date with an{' '}
                    <em>×</em> to clear. The same header has a date
                    picker so you can drill into any past day
                    directly without scrolling the chart.
                </p>
                <p>
                    <strong>CSV export, your way.</strong> The{' '}
                    <em>Export to CSV</em> button opens a field picker: tick
                    exactly which columns you want (including a{' '}
                    <em>Ticket</em> column for time logged against tickets) and{' '}
                    <strong>drag</strong> them into the order you need. Save a
                    layout as a <em>preset</em> for next time — there are
                    built-in starters (all fields, payroll, billing) plus your
                    own. Empty values export as sensible defaults
                    (<em>NO_PROJECT</em> / <em>NO PRODUCT</em>). Every export is
                    snapshotted: the <em>History</em> button lists past exports
                    with a &quot;days left&quot; badge (kept for a year) so you
                    can re-download the exact file byte-for-byte.
                </p>
            </>
        ),
    },
    {
        id: 'applications',
        icon: AppWindow,
        accent: 'text-violet-600',
        title: 'Applications & releases (SDLC)',
        lead: 'The catalogue of every app the team ships, each release tracked through Test → Pilot → Approved with artifacts and operational checkpoints.',
        body: (
            <>
                <p>
                    Open <Link to="/applications" className="text-primary hover:underline">Applications</Link>
                    {' '}for the catalogue grid. Each card shows the
                    latest release per phase (Test / Pilot /
                    Approved). Click in for the full detail page with
                    release form, file artifact uploads, release
                    notes, and a per-application timeline.
                </p>
                <p>
                    Switch to the <strong>Activity timeline</strong>{' '}
                    tab on the same page for a cross-app feed. You can
                    toggle individual apps on/off, filter by phase,
                    pick a time window, and choose between a{' '}
                    <em>List</em> (vertical, grouped by day) or{' '}
                    <em>Strip</em> (horizontal cards) view. Every
                    choice is remembered in your browser.
                </p>
                <p>
                    <strong>Roles:</strong> Admins and Managers can
                    create / edit applications and releases.{' '}
                    <em>App Moderators</em> can declare phase
                    transitions. Anyone with the{' '}
                    <code>app:checkpoint:add</code> capability can log
                    a deployment / rollback checkpoint against a
                    release (operator-level audit trail, separate from
                    the formal phase change).
                </p>
            </>
        ),
    },
    {
        id: 'tickets',
        icon: LifeBuoy,
        accent: 'text-sky-600',
        title: 'Tickets & help desk',
        lead: 'A full help-desk: requesters raise tickets from a self-service portal; resolvers triage, answer and close them from a dedicated workspace.',
        body: (
            <>
                <p>
                    The ticketing module has two sides. Requesters use the{' '}
                    <strong>portal</strong> (Home page) to raise and follow
                    their requests; agents/resolvers use the{' '}
                    <Link
                        to="/tickets"
                        className="text-primary hover:underline"
                    >
                        Tickets
                    </Link>{' '}
                    workspace to handle them. Both show the same ticket in
                    list, grid or board views, and open it in a modal with the
                    full conversation on the left and people / attachments /
                    captured details on the right.
                </p>

                <p>
                    <strong>Raising a request.</strong> On the portal a
                    requester picks a <em>request type</em> card, then fills a
                    short form: a title, a category (Incident / Problem /
                    Question / Request) and priority chosen as icon chips, a
                    description, plus any <em>custom fields</em> the admin
                    attached to that type. They can attach files and share the
                    ticket with extra people or a group. They never pick a
                    project — a resolver assigns it later.
                </p>

                <p>
                    <strong>Statuses &amp; lifecycle.</strong> Tickets move
                    through <em>New → In progress → Pending → Resolved →
                    Closed</em>. Taking a ticket or replying moves it to In
                    progress. <em>Resolved</em> still accepts replies — a
                    requester reply reopens it. <em>Closed</em> is a locked,
                    terminal state: no comments, attachments, people or
                    priority changes — only a resolver can reopen it (by
                    changing its status), after which it&apos;s editable
                    again.
                </p>

                <p>
                    <strong>Resolver tools.</strong> Agents can take a ticket,
                    change status / priority / assignee, post replies or
                    internal notes (notes are never shown to the requester),
                    log time, add watchers, and create a new <em>ticket</em>
                    {' '}as either External (visible in the shared queue) or
                    Internal (private to the people they pick). They can also
                    turn a ticket into a project task with{' '}
                    <em>Add as task</em> — it lands in the project/phase they
                    choose, prefilled from the ticket and linked back to it.
                </p>

                <p>
                    <strong>Taking &amp; ownership.</strong> A ticket must be
                    assigned to a <em>project</em> before a resolver can take
                    it — the <em>Take it</em> button and the reply{' '}
                    <em>Send</em> button stay disabled until you pick one. The
                    first resolver to reply automatically becomes the owner:
                    sending a reply assigns the ticket to you (and moves a new
                    ticket to In progress), so ownership follows whoever engages
                    first. You can still claim it explicitly with{' '}
                    <em>Take it</em> without replying.
                </p>

                <p>
                    <strong>Deleting is reversible.</strong> Deleting a ticket
                    is a <em>soft delete</em> — it vanishes from every queue,
                    board and report, but nothing is really lost. An admin (or
                    anyone with ticket-manage permission) can restore it from
                    the{' '}
                    <Link
                        to="/activities"
                        className="text-primary hover:underline"
                    >
                        Activity feed
                    </Link>{' '}
                    (the <em>Tickets deleted</em> entry gets a{' '}
                    <em>Restore</em> button), bringing back the full
                    conversation, events and attachments intact.
                </p>

                <p>
                    <strong>Custom fields per type.</strong> When editing a
                    ticket type (Templates → Tickets → Ticket types), admins
                    add the fields requesters must fill for that type:{' '}
                    <em>Terminal</em> (cascading Vendor → Model → OS, drawn
                    from the Terminals catalog), <em>Client</em>,{' '}
                    <em>Text</em> (e.g. Merchant ID, Host TID),{' '}
                    <em>Multi-select</em>, and <em>Yes / No</em>. Any field can
                    be marked required. The captured values show in the
                    ticket&apos;s Details panel.
                </p>

                <p>
                    <strong>Internal vs external requesters.</strong> A
                    Requester is either <em>Internal</em> (an employee who
                    sees the whole shared queue) or <em>External</em>, who
                    belongs to an organisation (client) and only sees their own
                    tickets plus their organisation&apos;s. Tickets an external
                    user raises are auto-tagged to their organisation, and each
                    client can be limited (on its edit screen) to just the
                    ticket types its users may raise.
                </p>

                <p>
                    <strong>Admin setup</strong> lives under Templates →
                    Tickets: <em>Ticket types</em> (the portal cards, with
                    icon, default priority, agent visibility and custom
                    fields), <em>Requester groups</em> (add many people to a
                    ticket at once), and <em>Terminals</em> (vendors and their
                    models with OS type). Every project also has a{' '}
                    <em>Tickets</em> tab listing the tickets linked to it.
                </p>
            </>
        ),
    },
    {
        id: 'insights',
        icon: BarChart3,
        accent: 'text-violet-600',
        title: 'Insights',
        lead: 'Roll-up dashboards across three tabs — project health, task throughput, who is overloaded, and full ticket analytics.',
        body: (
            <>
                <p>
                    <Link to="/insights" className="text-primary hover:underline">Insights</Link>
                    {' '}rolls the workspace up into three tabs —{' '}
                    <em>Projects</em>, <em>Tasks</em> and <em>Tickets</em>.
                    Each mixes KPI tiles, donut charts (status, priority,
                    country / category) and ranked bar lists (owners, clients,
                    products, teams, tasks by user, most subtasks / notes, and
                    more). Hover any donut slice or legend row to highlight it
                    and read its share.
                </p>
                <p>
                    The <em>Tickets</em> tab adds response-time sensors —{' '}
                    <em>open → taken</em>, <em>open → resolved</em> and average
                    resolution — an <em>Agent workload</em> and{' '}
                    <em>By project</em> chart with a bar / pie toggle,
                    most-active clients, and per-ticket <em>time in current
                    phase</em> and <em>pending time</em> lists. Long bar lists
                    cap at a few rows and scroll; use{' '}
                    <em>Collapse all</em> (or a card&apos;s chevron) to fold the
                    breakdowns you don&apos;t need.
                </p>
                <p>
                    A <em>Period</em> filter (All time / Last 7 / 15 / 30 days
                    / Custom range) scopes every figure to items created in that
                    window, and admins get a <em>Viewing</em> picker to inspect
                    a single user&apos;s numbers.
                </p>
            </>
        ),
    },
    {
        id: 'activities',
        icon: Activity,
        accent: 'text-violet-600',
        title: 'Activity feed (admin)',
        lead: 'A full audit log across the workspace — every user action, project change, file upload, task move, deployment, etc.',
        body: (
            <>
                <p>
                    Admins can open <Link to="/activities" className="text-primary hover:underline">Activity feed</Link>
                    {' '}to scrub through everything that has happened.
                    Filter by event type, search by free text, and
                    click any row to jump into the underlying entity.
                </p>
                <p>
                    The feed is append-only — entries are never edited
                    or deleted. Use it for compliance reviews,
                    post-mortems, or when you need to know "who
                    changed that?".
                </p>
            </>
        ),
    },
    {
        id: 'announcements',
        icon: BellRing,
        accent: 'text-rose-600',
        title: 'Announcements (admin)',
        lead: 'Broadcast a message as a modal to a chosen audience, track who has seen it, and repeat or re-send it.',
        body: (
            <>
                <p>
                    Admins open{' '}
                    <Link to="/announcements" className="text-primary hover:underline">
                        Announcements
                    </Link>{' '}
                    to compose a message. Pick a <strong>type</strong> —
                    Important (red), Information (green) or Good to know
                    (orange) — and an <strong>audience</strong>: everyone,
                    internal staff, external users, or specific roles, teams
                    or people.
                </p>
                <p>
                    Choose how people respond: informational (just a Close
                    button), require an acknowledgement, or require a written
                    response. When active it appears as a centered modal —
                    live, without a reload, for anyone online. Each
                    acknowledgement (and any reply) is recorded so you can see
                    who&apos;s seen it and who&apos;s still pending.
                </p>
                <p>
                    <strong>Repeat</strong> on a schedule, <strong>Re-send</strong>{' '}
                    to clear acknowledgements and show it again,{' '}
                    <strong>Duplicate</strong> to a new draft, or{' '}
                    <strong>Edit</strong> in place. <strong>Preview</strong>{' '}
                    shows exactly how it will look. Every action is written to
                    the activity feed.
                </p>
            </>
        ),
    },
    {
        id: 'time-logging',
        icon: AlarmClock,
        accent: 'text-amber-600',
        title: 'Time-logging policy (admin)',
        lead: 'Remind selected people to keep their working log filled, on a recurring monthly deadline.',
        body: (
            <>
                <p>
                    Admins open{' '}
                    <Link to="/time-logging" className="text-primary hover:underline">
                        Time logging
                    </Link>{' '}
                    to set a monthly <strong>cutoff day</strong>, a{' '}
                    <strong>minimum hours per day</strong> for a day to count,
                    and how many days before the deadline to start reminding.
                    The target is the number of working days (Mon–Fri) in the
                    enforced month, computed automatically.
                </p>
                <p>
                    Only users with <strong>Time logging mandatory</strong>{' '}
                    ticked on their profile are affected. If they&apos;re short
                    as the deadline nears they get a daily, dismissible
                    &ldquo;Please fill your working log&rdquo; reminder (and an
                    optional bell notification).
                </p>
            </>
        ),
    },
    {
        id: 'users',
        icon: Users,
        accent: 'text-emerald-600',
        title: 'Users (admin)',
        lead: 'Manage everyone in the workspace, approve new sign-ups, and grant granular capabilities on top of the base role.',
        body: (
            <>
                <p>
                    Admins can open <Link to="/users" className="text-primary hover:underline">Users</Link>
                    {' '}to approve pending registrations, edit
                    profiles, change roles (Admin / Manager / App
                    Moderator / User), and tick the granular
                    capability checkboxes when a user needs a
                    specific power their base role doesn&apos;t grant
                    by default.
                </p>
                <p>
                    Pending sign-ups show a badge in the sidebar so
                    you don&apos;t miss them. When you approve a user
                    they receive a welcome email and can sign in
                    immediately.
                </p>
                <p>
                    Click any name (or pick <em>Open profile</em> from
                    the row menu) to land on the public profile page —
                    see the next section.
                </p>
            </>
        ),
    },
    {
        id: 'user-profile',
        icon: UserCircle,
        accent: 'text-sky-600',
        title: 'User profile page',
        lead: 'A dedicated page per user with their bio, team, KPIs, a 12-week time-tracking heatmap and recent activity.',
        body: (
            <>
                <p>
                    Click any teammate&apos;s name (Users list, sprint
                    cards, comments, mentions) or pick{' '}
                    <em>View profile</em> from your own avatar menu in
                    the top-bar. The page is read-only to teammates and
                    editable by admins via the <em>Edit</em> action.
                </p>
                <p>
                    The page packages everything we know about a user
                    into one surface — identity (role, status, position,
                    business unit, country / currency), the team they
                    report to and their direct reports, every Team they
                    belong to, KPI tiles for projects / tasks / sprints
                    / applications / releases / logged hours (last 7d
                    and last 30d), and a GitHub-style time-tracking
                    heatmap of the last 12 weeks.
                </p>
                <p>
                    On your own profile a <em>Personal highlights</em>
                    panel also counts the items you&apos;ve pinned,
                    starred or highlighted so you can see at a glance
                    what you&apos;re tracking.
                </p>
                <p>
                    <strong>Appearance / theme:</strong> the theme button
                    in the top bar cycles{' '}
                    <em>Light → Dark → Dim → System</em>. <strong>Dim</strong>{' '}
                    is a softer, grey dark theme for anyone who finds the
                    standard Dark too black; <em>System</em> follows your OS
                    setting live. Your choice is saved on your profile, so it
                    follows you to any browser or device you log in from.
                </p>
            </>
        ),
    },
    {
        id: 'teams',
        icon: Users2,
        accent: 'text-emerald-600',
        title: 'Teams',
        lead: 'Group users into teams and attach a team to a project (or to a specific project phase) in one click.',
        body: (
            <>
                <p>
                    <Link to="/teams" className="text-primary hover:underline">Teams</Link>
                    {' '}lets admins and managers create named teams
                    with a coloured chip, add members, then assign the
                    whole team to a project from the project form.
                    Useful when the same five people work together
                    across many projects — you only have to add the
                    team once.
                </p>
            </>
        ),
    },
    {
        id: 'reassignments',
        icon: UserCog,
        accent: 'text-emerald-600',
        title: 'Reassignments',
        lead: 'A lightweight approval workflow for moving a task between assignees, with rationale notes visible to both sides.',
        body: (
            <>
                <p>
                    Any participant can <em>propose</em> a
                    reassignment from inside the task. The current
                    assignee, the project owner and any admin /
                    manager can review pending proposals at{' '}
                    <Link to="/reassignments" className="text-primary hover:underline">Reassignments</Link>
                    {' '}and approve or decline with a comment. The
                    proposer sees the decision + comment too.
                </p>
            </>
        ),
    },
    {
        id: 'billing',
        icon: BadgeDollarSign,
        accent: 'text-amber-600',
        title: 'Billing (admin)',
        lead: 'Internal vs client settlement amounts, paid / unpaid status, notes, and export.',
        body: (
            <>
                <p>
                    Admins can open <Link to="/billing" className="text-primary hover:underline">Billing</Link>
                    {' '}for a cross-project view of every project&apos;s
                    pricing, paid status, settlement amounts and
                    billing notes. Filter by country / paid-status and
                    export filtered subsets to Excel.
                </p>
            </>
        ),
    },
    {
        id: 'templates',
        icon: SlidersHorizontal,
        accent: 'text-amber-600',
        title: 'Templates (admin)',
        lead: 'Configure the option catalogues used everywhere in the app: project phases, priorities, types, countries, app OS / POS terminals, business units.',
        body: (
            <>
                <p>
                    Open <Link to="/templates" className="text-primary hover:underline">Templates</Link>
                    {' '}to add, rename, reorder or deactivate the
                    values that populate the dropdowns across the app.
                    Anything you add here is available immediately in
                    the relevant form — no restart required.
                </p>
            </>
        ),
    },
    {
        id: 'notifications',
        icon: BellRing,
        accent: 'text-rose-600',
        title: 'Notifications & emails',
        lead: 'In-app realtime notifications + personalised emails for the assignee, with per-user opt-out.',
        body: (
            <>
                <p>
                    The bell icon in the top bar shows your
                    notifications. Click an entry to deep-link
                    straight to the underlying task / note / file.
                </p>
                <p>
                    Emails are tailored per event:
                </p>
                <ul className="ml-5 list-disc space-y-1">
                    <li>
                        <strong>Task assignee</strong> gets a
                        personal "Your task — …" email for any
                        change to a task they own (status, due date,
                        new note, new file, reassignment).
                    </li>
                    <li>
                        <strong>Project participants</strong> get the
                        in-app notification but not duplicate emails
                        when the assignee already gets a personal
                        one.
                    </li>
                    <li>
                        <strong>Project-level events</strong> (status,
                        billing, owner) email every participant.
                    </li>
                    <li>
                        <strong>Daily digest:</strong> a single
                        consolidated email is sent each day if you
                        have tasks that are overdue or due in less
                        than 3 days.
                    </li>
                </ul>
                <p>
                    Open <strong>Edit profile</strong> from the
                    sidebar to toggle email notifications off
                    entirely if you prefer.
                </p>
            </>
        ),
    },
    {
        id: 'permissions',
        icon: ShieldCheck,
        accent: 'text-rose-600',
        title: 'Roles & permissions',
        lead: 'Four base roles, then granular capability checkboxes on top — admins decide who can do what at the verb level.',
        body: (
            <>
                <p>
                    Base roles:
                </p>
                <ul className="ml-5 list-disc space-y-1">
                    <li>
                        <strong>Admin</strong> — everything.
                    </li>
                    <li>
                        <strong>Manager</strong> — full read +
                        most-write across all projects.
                    </li>
                    <li>
                        <strong>App Moderator</strong> — phase
                        transitions on Application releases + read
                        elsewhere.
                    </li>
                    <li>
                        <strong>User</strong> — read everything they
                        participate in, edit what their role + per-
                        user capabilities allow.
                    </li>
                </ul>
                <p>
                    On top of the base role, admins can tick any
                    subset of ~31 capabilities on a user&apos;s
                    profile (<code>project:edit</code>,{' '}
                    <code>task:reassign</code>,{' '}
                    <code>app:checkpoint:add</code>,{' '}
                    <code>time:export-all</code>, etc.). Changes take
                    effect within a few seconds — the server caches
                    the user row for 30 s and invalidates the entry on
                    every edit.
                </p>
            </>
        ),
    },
    {
        id: 'security',
        icon: Lock,
        accent: 'text-rose-600',
        title: 'Security in two paragraphs',
        lead: 'Short on time? Here is what protects your data and what you should still do before launching.',
        body: (
            <>
                <p>
                    <strong>What&apos;s on by default:</strong> JWT
                    auth with httpOnly refresh cookie, bcrypt password
                    hashing, helmet headers, CORS locked to your
                    origin, rate-limiters on auth + on every API
                    route, Zod validation on every write, Prisma
                    parameterised queries (no SQL injection surface),
                    HMAC-signed download URLs with a 10-minute TTL
                    bound to the user id, explicit allow + block
                    lists on file uploads, WebSocket membership
                    re-checks on every join.
                </p>
                <p>
                    <strong>What you should do before flipping to
                    production traffic:</strong> set{' '}
                    <code>NODE_ENV=production</code>, terminate HTTPS
                    in front of the app, lock the Postgres port to
                    the docker network or your backend host, rotate
                    the JWT secrets, set up daily backups of the DB
                    and the <code>pm_uploads</code> volume. The full
                    checklist with file references is in{' '}
                    <code>RELEASE_NOTES.md</code> at the repo root.
                </p>
            </>
        ),
    },
    {
        id: 'icons',
        icon: HelpCircle,
        accent: 'text-violet-600',
        title: 'Icon legend',
        lead: 'Every icon you\u2019ll meet across the app, with the meaning it carries in this product.',
        body: (
            <>
                <p>
                    PM Tool uses the same icon vocabulary
                    everywhere — once you learn it on one page,
                    you can read all the others at a glance.
                    The list below is grouped by intent (status,
                    actions, navigation, modules) so you can
                    scan for what you&apos;re looking at without
                    reading top-to-bottom.
                </p>
                <p className="text-[11px] text-muted-foreground">
                    Hover any icon in the real UI to see its
                    tooltip too — that&apos;s usually a one-line
                    version of the meaning below, with the
                    specific context for the row it sits on.
                </p>
                <div className="space-y-4">
                    {ICON_LEGEND_GROUPS.map((g) => (
                        <div key={g.id} id={g.id} className="space-y-2 scroll-mt-20">
                            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {g.title}
                            </h3>
                            <ul className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                                {g.items.map((it) => (
                                    <LegendItem
                                        key={it.name}
                                        Icon={it.Icon}
                                        name={it.name}
                                        desc={it.desc}
                                    />
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                    Missing something? Tell an admin via{' '}
                    <em>Contact admin</em> below and we&apos;ll add
                    it to the legend in the next release.
                </p>
            </>
        ),
    },
    {
        id: 'tips',
        icon: Sparkles,
        accent: 'text-primary',
        title: 'Power-user tips',
        lead: 'A small collection of "did you know" shortcuts.',
        body: (
            <>
                <ul className="ml-5 list-disc space-y-1">
                    <li>
                        Search bar in the top bar accepts project /
                        task / subtask codes (<code>P-25-…</code>,{' '}
                        <code>T-…</code>, <code>ST-…</code>) and
                        labels.
                    </li>
                    <li>
                        Sidebar group headers are clickable — click
                        them to collapse a whole section.
                    </li>
                    <li>
                        The collapse button at the top-left turns the
                        sidebar into an icon-only rail. Hover any
                        icon to see its label as a tooltip.
                    </li>
                    <li>
                        In Notes you can <strong>@mention</strong>{' '}
                        any project participant and embed images /
                        files inline.
                    </li>
                    <li>
                        Type <code>/</code> in any note composer to pop
                        a picker of tasks and subtasks — pick one and
                        the code (e.g. <code>T-0042</code>) is inserted
                        at the cursor. Saved notes show those codes as
                        clickable links.
                    </li>
                    <li>
                        On any release card, the small{' '}
                        <em>Download</em> chip lets you grab the
                        uploaded artifact without expanding the card.
                    </li>
                    <li>
                        Time entry edits respect dirty-tracking — the
                        original duration is kept exactly, even if you
                        only change the note.
                    </li>
                </ul>
            </>
        ),
    },
];

// Persist collapsed sections in the browser so a returning user lands on
// the same view. We store the collapsed IDs (not the open ones) so any
// brand-new section we ship in the future defaults to open.
const COLLAPSED_STORAGE_KEY = 'pm-help-collapsed-sections';

function readCollapsed() {
    if (typeof window === 'undefined') return new Set();
    try {
        const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set();
    } catch {
        return new Set();
    }
}

function writeCollapsed(set) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(
            COLLAPSED_STORAGE_KEY,
            JSON.stringify(Array.from(set)),
        );
    } catch {
        // ignore — localStorage may be unavailable (private mode, etc.)
    }
}

export default function Help() {
    const [query, setQuery] = useState('');
    const [collapsed, setCollapsed] = useState(() => readCollapsed());
    const [contactOpen, setContactOpen] = useState(false);

    useEffect(() => {
        writeCollapsed(collapsed);
    }, [collapsed]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return SECTIONS;
        return SECTIONS.filter((s) =>
            [s.title, s.lead].some((t) =>
                (t || '').toLowerCase().includes(q),
            ),
        );
    }, [query]);

    // When the user is searching, force-expand every match so the body
    // they're looking for is visible immediately — they shouldn't have
    // to click into each card.
    const isSearching = query.trim().length > 0;

    const toggle = useCallback((id) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const expandAll = useCallback(() => setCollapsed(new Set()), []);
    const collapseAll = useCallback(
        () => setCollapsed(new Set(SECTIONS.map((s) => s.id))),
        [],
    );

    // Quick-index chip click — make sure the target section is open
    // before the browser scrolls to it, otherwise the user lands on a
    // collapsed header with no body in sight.
    const handleJump = useCallback((id) => {
        setCollapsed((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    }, []);

    const allCollapsed = collapsed.size >= SECTIONS.length;

    return (
        <>
            <TopBar title="Help" />
            <main className="flex-1 overflow-auto bg-muted/20">
                <div className="flex w-full flex-col gap-4 p-3 sm:p-6">
                    {/* Hero */}
                    <div className="relative overflow-hidden rounded-xl border bg-gradient-to-br from-primary/10 via-card to-card p-4 shadow-sm sm:p-6">
                        <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-primary/10 blur-3xl" />
                        <div className="relative flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="flex items-start gap-3">
                                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary shadow-inner">
                                    <LifeBuoy className="h-5 w-5" />
                                </div>
                                <div className="space-y-1">
                                    <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                                        Help & guide
                                    </h1>
                                    <p className="max-w-2xl text-sm text-muted-foreground">
                                        A short tour of every module
                                        in PM Tool, with a "how to
                                        use it" paragraph for each.
                                        Bookmark this page or come
                                        back any time from the
                                        sidebar.
                                    </p>
                                </div>
                            </div>
                            <div className="relative w-full sm:w-72">
                                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                <Input
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    placeholder="Search the help topics..."
                                    className="pl-8"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Quick index + bulk-toggle */}
                    {filtered.length > 0 && (
                        <Card>
                            <CardContent className="flex flex-wrap items-center gap-1.5 p-3">
                                {filtered.map((s) => {
                                    const Icon = s.icon;
                                    return (
                                        <a
                                            key={s.id}
                                            href={`#${s.id}`}
                                            onClick={() => handleJump(s.id)}
                                            className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                        >
                                            <Icon
                                                className={cn(
                                                    'h-3.5 w-3.5',
                                                    s.accent,
                                                )}
                                            />
                                            {s.title}
                                        </a>
                                    );
                                })}
                                <div className="ml-auto flex items-center gap-1">
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 px-2 text-xs"
                                        onClick={allCollapsed ? expandAll : collapseAll}
                                    >
                                        {allCollapsed ? 'Expand all' : 'Collapse all'}
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {filtered.length === 0 ? (
                        <Card>
                            <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                                <FileQuestion className="h-7 w-7 text-muted-foreground/60" />
                                <p>
                                    No help topic matches &ldquo;
                                    {query}&rdquo;.
                                </p>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setQuery('')}
                                >
                                    Clear search
                                </Button>
                            </CardContent>
                        </Card>
                    ) : (
                        filtered.map((s) => {
                            const Icon = s.icon;
                            const isOpen = isSearching || !collapsed.has(s.id);
                            const panelId = `help-section-panel-${s.id}`;
                            return (
                                <Card key={s.id} id={s.id} className="scroll-mt-20">
                                    <button
                                        type="button"
                                        onClick={() => toggle(s.id)}
                                        aria-expanded={isOpen}
                                        aria-controls={panelId}
                                        className="group flex w-full items-start gap-3 rounded-t-lg p-6 pb-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
                                    >
                                        <div
                                            className={cn(
                                                'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-background shadow-sm',
                                                s.accent,
                                            )}
                                        >
                                            <Icon className="h-5 w-5" />
                                        </div>
                                        <div className="min-w-0 flex-1 space-y-1">
                                            <CardTitle className="text-base font-semibold tracking-tight">
                                                {s.title}
                                            </CardTitle>
                                            <p className="text-sm text-muted-foreground">
                                                {s.lead}
                                            </p>
                                        </div>
                                        <ChevronDown
                                            className={cn(
                                                'mt-1 h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground',
                                                isOpen ? '' : '-rotate-90',
                                            )}
                                            aria-hidden="true"
                                        />
                                    </button>
                                    {isOpen && (
                                        <CardContent
                                            id={panelId}
                                            className="space-y-3 border-t pt-4 text-sm leading-relaxed text-foreground/90"
                                        >
                                            {s.body}
                                        </CardContent>
                                    )}
                                </Card>
                            );
                        })
                    )}

                    {/* Closing footer */}
                    <Card>
                        <CardContent className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                            <div className="inline-flex items-center gap-2">
                                <HelpCircle className="h-4 w-4 text-primary" />
                                Still stuck? Reach an administrator
                                directly without leaving this page.
                            </div>
                            <Button
                                size="sm"
                                variant="default"
                                onClick={() => setContactOpen(true)}
                            >
                                <Mail className="mr-1.5 h-4 w-4" />
                                Contact admin
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            </main>

            <ContactAdminDialog
                open={contactOpen}
                onClose={() => setContactOpen(false)}
            />
        </>
    );
}

// Dialog used by the "Contact admin" button at the bottom of the page.
// Loads the list of active admins, lets the user pick one from a
// dropdown, write a short message, and on submit creates (or reuses)
// the 1-on-1 conversation and posts the message. The user is then
// navigated to the conversation in /messages so they can continue the
// chat normally.
function ContactAdminDialog({ open, onClose }) {
    const { user } = useAuth();
    const navigate = useNavigate();
    const [admins, setAdmins] = useState([]);
    const [loadingAdmins, setLoadingAdmins] = useState(false);
    const [selectedId, setSelectedId] = useState('');
    const [message, setMessage] = useState('');
    const [sending, setSending] = useState(false);

    // Reset internal state whenever the dialog is closed so the next
    // open starts clean (no stale draft, no leftover selection).
    useEffect(() => {
        if (open) return;
        setSelectedId('');
        setMessage('');
        setSending(false);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoadingAdmins(true);
        (async () => {
            try {
                // /users returns every workspace user. We filter
                // client-side to active admins, and exclude the
                // current user so they can't DM themselves if they're
                // an admin viewing the help page.
                const { data } = await api.get('/users');
                if (cancelled) return;
                const list = (data.users || [])
                    .filter(
                        (u) =>
                            u.role === 'ADMIN' &&
                            u.status !== 'SUSPENDED' &&
                            u.id !== user?.id,
                    )
                    .sort((a, b) =>
                        (a.name || '').localeCompare(b.name || ''),
                    );
                setAdmins(list);
                if (list.length === 1) setSelectedId(list[0].id);
            } catch {
                if (!cancelled) toast.error('Could not load admins');
            } finally {
                if (!cancelled) setLoadingAdmins(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, user?.id]);

    const trimmed = message.trim();
    const canSend = !!selectedId && trimmed.length > 0 && !sending;

    const handleSend = async (e) => {
        e?.preventDefault?.();
        if (!canSend) return;
        setSending(true);
        try {
            // Get or create the 1-on-1 conversation with the chosen
            // admin, then post the message text into it. We rely on
            // the same endpoints the Messages page uses, so the new
            // conversation shows up in the admin's direct-messages
            // tab in real time via the existing socket plumbing.
            const { data: dmData } = await api.post('/conversations/dm', {
                userId: selectedId,
            });
            const conversationId = dmData?.conversation?.id;
            if (!conversationId) throw new Error('No conversation id');
            await api.post(`/conversations/${conversationId}/messages`, {
                content: trimmed,
            });
            toast.success('Message sent — opening the conversation…');
            onClose();
            navigate(`/messages?tab=direct&c=${conversationId}`);
        } catch (err) {
            toast.error(
                err?.response?.data?.message ||
                    'Could not send the message',
            );
            setSending(false);
        }
    };

    const selectedAdmin = admins.find((a) => a.id === selectedId) || null;

    return (
        <Dialog open={open} onOpenChange={(o) => !o && !sending && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="inline-flex items-center gap-2">
                        <Mail className="h-5 w-5 text-primary" />
                        Contact an administrator
                    </DialogTitle>
                    <DialogDescription>
                        Pick an admin from the list and send them a
                        direct message. The conversation will open in
                        the messages area afterwards so you can keep
                        chatting.
                    </DialogDescription>
                </DialogHeader>

                <form className="space-y-3" onSubmit={handleSend}>
                    <div className="space-y-1.5">
                        <Label htmlFor="contact-admin-select">
                            Send to
                        </Label>
                        {loadingAdmins ? (
                            <p className="text-sm text-muted-foreground">
                                Loading administrators…
                            </p>
                        ) : admins.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                No other administrator is available to
                                contact right now.
                            </p>
                        ) : (
                            <Select
                                value={selectedId}
                                onValueChange={setSelectedId}
                            >
                                <SelectTrigger id="contact-admin-select">
                                    <SelectValue placeholder="Pick an administrator" />
                                </SelectTrigger>
                                <SelectContent>
                                    {admins.map((a) => (
                                        <SelectItem key={a.id} value={a.id}>
                                            <span className="inline-flex items-center gap-2">
                                                <Avatar className="h-5 w-5">
                                                    {a.avatarUrl && (
                                                        <AvatarImage
                                                            src={resolveAssetUrl(
                                                                a.avatarUrl,
                                                            )}
                                                            alt={a.name}
                                                        />
                                                    )}
                                                    <AvatarFallback className="bg-primary/10 text-[9px] text-primary">
                                                        {initials(a.name || '?')}
                                                    </AvatarFallback>
                                                </Avatar>
                                                <span className="truncate">
                                                    {a.name || a.email}
                                                </span>
                                            </span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                        {selectedAdmin?.email && (
                            <p className="text-xs text-muted-foreground">
                                {selectedAdmin.email}
                            </p>
                        )}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="contact-admin-message">Message</Label>
                        <Textarea
                            id="contact-admin-message"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder="Type your question or request for the admin…"
                            rows={5}
                            autoFocus
                        />
                        <p className="text-[11px] text-muted-foreground">
                            Sends as a direct message — the admin will
                            see it in their messages bell and inbox.
                        </p>
                    </div>

                    <DialogFooter className="gap-2 sm:gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => !sending && onClose()}
                            disabled={sending}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!canSend}>
                            <Send className="mr-1.5 h-4 w-4" />
                            {sending ? 'Sending…' : 'Send message'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
