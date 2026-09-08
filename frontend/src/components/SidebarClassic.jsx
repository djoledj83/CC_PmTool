// SidebarClassic — pre-redesign backup of the sidebar. Kept so the new
// design can be rolled back with a one-line import swap in App.jsx
// (or `git revert` of the redesign commit). Not imported by default.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
    Activity,
    BadgeDollarSign,
    BarChart3,
    Building2,
    Briefcase,
    CalendarRange,
    CheckSquare,
    ChevronDown,
    ChevronsLeft,
    ChevronsRight,
    FolderKanban,
    AppWindow,
    Inbox,
    LayoutDashboard,
    LifeBuoy,
    LogOut,
    MessageSquare,
    ShieldCheck,
    Sparkles,
    SlidersHorizontal,
    Timer,
    UserCircle,
    UserCog,
    UsersRound,
    Users,
    Users2,
} from 'lucide-react';

import { api } from '@/lib/api';
import { cn, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { useMobileSidebar } from '@/contexts/MobileSidebarContext';
import {
    Avatar,
    AvatarFallback,
    AvatarImage,
} from '@/components/ui/avatar';
import {
    Sheet,
    SheetContent,
    SheetTitle,
} from '@/components/ui/sheet';
import { ProfileDialog } from '@/components/ProfileDialog';
import { APP_NAME, APP_VERSION, APP_COPYRIGHT } from '@/lib/appInfo';
import { Logo } from '@/components/Logo';
import { CAPABILITIES, ROLE_LABELS, hasCapability } from '@/lib/capabilities';

// Tone palette for role pills, kept in sync with the top-bar dropdown
// so the same "Admin" chip looks identical in every corner of the UI.
const ROLE_PILL_TONE = {
    ADMIN:
        'bg-primary/15 text-primary border border-primary/30',
    MANAGER:
        'bg-sky-500/15 text-sky-700 border border-sky-500/30 dark:text-sky-300',
    APP_MODERATOR:
        'bg-violet-500/15 text-violet-700 border border-violet-500/30 dark:text-violet-300',
    USER:
        'bg-muted text-muted-foreground border border-border',
};

function initials(name) {
    if (!name) return '?';
    return name
        .split(' ')
        .map((n) => n[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();
}

// Groups the sidebar renders in order. Each item below declares a
// `group` field that matches one of these ids. Order matters: groups
// render top-to-bottom in the order they appear here.
//
// Each group carries an icon + a subtle accent colour used by both the
// expanded header (icon tint + left rail) and the collapsed letter
// pill so the four sections are visually distinct at a glance.
const NAV_GROUPS = [
    {
        id: 'work',
        label: 'Work',
        icon: Briefcase,
        accent: 'text-sky-600 dark:text-sky-400',
        rail: 'bg-sky-500/40',
    },
    {
        id: 'people',
        label: 'People',
        icon: UsersRound,
        accent: 'text-emerald-600 dark:text-emerald-400',
        rail: 'bg-emerald-500/40',
    },
    {
        id: 'insights',
        label: 'Insights',
        icon: Sparkles,
        accent: 'text-violet-600 dark:text-violet-400',
        rail: 'bg-violet-500/40',
    },
    {
        id: 'admin',
        label: 'Admin',
        icon: ShieldCheck,
        accent: 'text-amber-600 dark:text-amber-400',
        rail: 'bg-amber-500/40',
    },
];

const NAV_ITEMS = [
    // ---- Work --------------------------------------------------------
    { to: '/projects', label: 'Projects', icon: FolderKanban, group: 'work' },
    {
        to: '/todos',
        label: 'My to-do',
        icon: CheckSquare,
        badge: 'todoAlerts',
        group: 'work',
    },
    {
        to: '/messages',
        label: 'Messages',
        icon: MessageSquare,
        badge: 'messages',
        group: 'work',
    },
    { to: '/time', label: 'Time tracking', icon: Timer, group: 'work' },
    {
        to: '/planning-sprints',
        label: 'Planning sprints',
        icon: CalendarRange,
        adminOrManagerOnly: true,
        group: 'work',
    },
    {
        to: '/tickets',
        label: 'Ticketing',
        icon: LifeBuoy,
        // Visible to anyone who can open tickets (Requester) or manage
        // them (agents). A plain USER with no ticket capability won't
        // see it until granted one.
        capabilityGrants: [
            CAPABILITIES.TICKET_CREATE,
            CAPABILITIES.TICKET_MANAGE,
        ],
        group: 'work',
    },
    {
        to: '/clients',
        label: 'Clients',
        icon: Building2,
        adminOnly: true,
        group: 'work',
    },

    // ---- People ------------------------------------------------------
    // ONE "Users" entry for everyone — the page itself renders a
    // read-only roster for non-admins and the full management table
    // for admins. The "pendingUsers" badge is admin-only by design
    // (see badgeFor() in useNavBadges) so it doesn't show up for
    // regular users either.
    {
        to: '/users',
        label: 'Users',
        icon: Users,
        badge: 'pendingUsers',
        group: 'people',
    },
    {
        to: '/teams',
        label: 'Teams',
        icon: Users2,
        adminOrManagerOnly: true,
        // Capability override: admins / managers always see the
        // entry, and any user who's been granted `team:manage` (or
        // any future per-user override granting access to this page)
        // also gets it. Without this, granting the cap from the User
        // edit dialog appeared to do nothing because the entry was
        // still hidden behind the role gate.
        capabilityGrants: [CAPABILITIES.TEAM_MANAGE],
        group: 'people',
    },
    {
        // Tabbed hub combining reassignment requests, specific-task
        // approvals, and (surface-only) user approvals. Replaces the
        // old standalone "Reassignments" entry.
        to: '/requests',
        label: 'Requests',
        icon: Inbox,
        badge: 'pendingReassignments',
        group: 'people',
    },

    // ---- Insights ----------------------------------------------------
    {
        to: '/applications',
        label: 'Applications',
        icon: AppWindow,
        group: 'insights',
    },
    { to: '/insights', label: 'Insights', icon: BarChart3, group: 'insights' },
    // Activities = workspace audit feed (admin-only). User-facing
    // meetings / calls / reminders moved to the My to-do page tabs.
    {
        to: '/activities',
        label: 'Activity feed',
        icon: Activity,
        adminOnly: true,
        group: 'insights',
    },

    // ---- Admin -------------------------------------------------------
    {
        to: '/billing',
        label: 'Billing',
        icon: BadgeDollarSign,
        adminOnly: true,
        group: 'admin',
    },
    {
        to: '/templates',
        label: 'Templates',
        icon: SlidersHorizontal,
        adminOnly: true,
        capabilityGrants: [CAPABILITIES.TEMPLATE_MANAGE],
        group: 'admin',
    },
    // Ticket types now live inside Templates → Tickets, so the standalone
    // sidebar entry was removed. The /ticket-types route still resolves.
];

const STORAGE_KEY = 'pm.sidebar.collapsed.v1';
// Separate key for per-group fold state so wiping one doesn't reset
// the other. Keys are group ids; value is `true` when the user has
// manually collapsed that group.
// v2: groups now default to COLLAPSED, so the stored map tracks which
// groups the user has explicitly EXPANDED (bumped from v1 to reset the
// old "folded" semantics cleanly).
const GROUPS_STORAGE_KEY = 'pm.sidebar.groups.v2';

function useNavBadges() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    const isManager = user?.role === 'MANAGER';
    const isAdminOrManager = isAdmin || isManager;
    const {
        unreadMessages,
        pendingUserCount,
        todoAlertCount,
        pendingReassignmentCount,
    } = useRealtime();
    const location = useLocation();
    // Pending "specific" task approvals. Fetched here (alongside the
    // realtime reassignment count) so the Requests badge can show the
    // COMBINED queue — reassignments + task approvals — without
    // double-counting user approvals (those keep their own Users badge).
    const [taskApprovalCount, setTaskApprovalCount] = useState(0);
    useEffect(() => {
        let cancelled = false;
        api.get('/tasks/pending-approval/count')
            .then((res) => {
                if (!cancelled) setTaskApprovalCount(res.data?.count || 0);
            })
            .catch(() => {
                if (!cancelled) setTaskApprovalCount(0);
            });
        return () => {
            cancelled = true;
        };
    }, [location.pathname]);
    const visibleItems = NAV_ITEMS.filter((item) => {
        // Capability shortcut runs BEFORE the role filters so a user
        // granted e.g. `team:manage` keeps the Teams entry even when
        // their role is plain USER. `capabilityGrants` is an array of
        // capability keys; any single match is enough.
        const capList = Array.isArray(item.capabilityGrants)
            ? item.capabilityGrants
            : [];
        const grantedByCap = capList.some((cap) => hasCapability(user, cap));
        if (grantedByCap) return true;
        if (item.adminOnly && !isAdmin) return false;
        if (item.adminOrManagerOnly && !isAdminOrManager) return false;
        return true;
    });

    const badgeFor = (item) => {
        if (item.badge === 'messages' && unreadMessages > 0) {
            if (location.pathname.startsWith('/messages')) return null;
            return unreadMessages;
        }
        if (item.badge === 'pendingUsers' && isAdmin && pendingUserCount > 0) {
            if (location.pathname.startsWith('/users')) return null;
            return pendingUserCount;
        }
        if (item.badge === 'todoAlerts' && todoAlertCount > 0) {
            if (location.pathname.startsWith('/todos')) return null;
            return todoAlertCount;
        }
        if (item.badge === 'pendingReassignments') {
            const total = pendingReassignmentCount + taskApprovalCount;
            if (total <= 0) return null;
            if (location.pathname.startsWith('/requests')) return null;
            return total;
        }
        return null;
    };

    return { visibleItems, badgeFor };
}

// Groups the visible nav items by their `group` field, in the order
// defined by NAV_GROUPS. Empty groups are dropped entirely so the UI
// doesn't render a section header with nothing under it (e.g. a
// non-admin user sees no "Admin" header at all).
function groupItems(visibleItems) {
    const byId = new Map();
    for (const item of visibleItems) {
        const id = item.group || 'work';
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(item);
    }
    return NAV_GROUPS
        .map((g) => ({ ...g, items: byId.get(g.id) || [] }))
        .filter((g) => g.items.length > 0);
}

// Hook owning the per-group fold state. Groups are COLLAPSED by default
// to keep the menu compact; the stored map tracks which ones the user has
// explicitly expanded. The active route's group is always force-expanded
// so the user can see where they are.
function useGroupFolds(groups) {
    const location = useLocation();
    const [expanded, setExpanded] = useState(() => {
        try {
            const raw = localStorage.getItem(GROUPS_STORAGE_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    });

    useEffect(() => {
        try {
            localStorage.setItem(
                GROUPS_STORAGE_KEY,
                JSON.stringify(expanded),
            );
        } catch {
            // ignore quota errors
        }
    }, [expanded]);

    const toggle = useCallback((id) => {
        setExpanded((cur) => ({ ...cur, [id]: !cur[id] }));
    }, []);

    // Force-open any group whose item matches the current route. This
    // way navigating to "/billing" still shows the Billing row
    // highlighted under its (otherwise collapsed) header.
    const activeGroupId = useMemo(() => {
        for (const g of groups) {
            if (
                g.items.some((it) =>
                    location.pathname.startsWith(it.to),
                )
            ) {
                return g.id;
            }
        }
        return null;
    }, [groups, location.pathname]);

    const isOpen = useCallback(
        (id) => {
            if (id === activeGroupId) return true;
            return !!expanded[id];
        },
        [activeGroupId, expanded],
    );

    return { isOpen, toggle };
}

// Standalone "Help & guide" entry that sits just above the user card
// at the bottom of the sidebar — visible to every signed-in user
// regardless of role. Visually distinct from the grouped nav items
// (lives in its own bordered strip) so it reads as a permanent help
// affordance, not as another navigation item that might scroll out
// of view.
function SidebarHelpEntry({ collapsed, onNavigate }) {
    return (
        <div className={cn('border-t', collapsed ? 'p-2' : 'p-2')}>
            <NavLink
                to="/help"
                onClick={onNavigate}
                title={collapsed ? 'Help & guide' : undefined}
                className={({ isActive }) =>
                    cn(
                        'flex items-center rounded-md text-sm font-medium transition-colors',
                        collapsed
                            ? 'h-10 w-10 justify-center'
                            : 'gap-2.5 px-2 py-2',
                        isActive
                            ? 'bg-primary/10 text-primary'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    )
                }
            >
                <span
                    className={cn(
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background text-primary shadow-sm',
                    )}
                >
                    <LifeBuoy className="h-3.5 w-3.5" />
                </span>
                {!collapsed && (
                    <span className="truncate text-sm font-semibold">
                        Help &amp; guide
                    </span>
                )}
            </NavLink>
        </div>
    );
}

function NavRow({ item, collapsed, onNavigate, badge }) {
    const { to, label, icon: Icon } = item;
    return (
        <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            title={
                collapsed
                    ? badge
                        ? `${label} (${badge})`
                        : label
                    : undefined
            }
            className={({ isActive }) =>
                cn(
                    'relative flex items-center rounded-md text-sm font-medium transition-all',
                    collapsed
                        ? 'h-10 w-10 justify-center'
                        : 'gap-3 px-3 py-2',
                    isActive
                        ? 'bg-primary/10 font-semibold text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )
            }
        >
            {({ isActive }) => (
                <>
                    {/* Accent bar marks the active row at a glance. */}
                    {isActive && !collapsed && (
                        <span
                            aria-hidden
                            className="absolute inset-y-1 left-0 w-1 rounded-full bg-primary"
                        />
                    )}
                    <Icon className="h-4 w-4 shrink-0" />
                    {!collapsed && (
                        <span className="truncate">{label}</span>
                    )}
                    {badge != null &&
                        (collapsed ? (
                            <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                                {badge > 99 ? '99+' : badge}
                            </span>
                        ) : (
                            <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-none text-primary-foreground">
                                {badge > 99 ? '99+' : badge}
                            </span>
                        ))}
                </>
            )}
        </NavLink>
    );
}

// Marker shown between groups when the sidebar is collapsed to
// icon-only. The group's own icon (with its accent tint) sits on top
// of a thin divider so the user can tell which section they're
// looking at without any text. Hovering the icon surfaces the full
// group name as a native tooltip.
function CollapsedGroupMarker({ group, isFirst }) {
    const { label, icon: Icon, accent } = group;
    return (
        <div
            className={cn(
                'relative flex w-full items-center justify-center',
                isFirst ? 'pb-1' : 'py-1.5',
            )}
            aria-hidden
        >
            {!isFirst && (
                <div className="absolute inset-x-1.5 top-1/2 h-px bg-border/60" />
            )}
            <span
                className={cn(
                    'relative inline-flex h-6 w-6 items-center justify-center rounded-md border border-border/70 bg-background shadow-sm',
                    accent,
                )}
                title={label}
            >
                <Icon className="h-3.5 w-3.5" />
            </span>
        </div>
    );
}

function NavList({ collapsed = false, onNavigate }) {
    const { visibleItems, badgeFor } = useNavBadges();
    const groups = useMemo(() => groupItems(visibleItems), [visibleItems]);
    const { isOpen, toggle } = useGroupFolds(groups);

    // Admin-defined project groups, shown nested under "Projects" (only
    // in the expanded sidebar). Fetched on mount; a window event lets
    // the manage dialog refresh it without a full reload.
    const [projectGroups, setProjectGroups] = useState([]);
    const loadProjectGroups = useCallback(() => {
        api.get('/project-groups')
            .then((res) =>
                setProjectGroups(
                    Array.isArray(res.data?.groups) ? res.data.groups : [],
                ),
            )
            .catch(() => setProjectGroups([]));
    }, []);
    useEffect(() => {
        loadProjectGroups();
        const onChange = () => loadProjectGroups();
        window.addEventListener('project-groups:changed', onChange);
        return () =>
            window.removeEventListener('project-groups:changed', onChange);
    }, [loadProjectGroups]);

    return (
        <nav
            className={cn(
                'flex-1 overflow-y-auto p-2',
                collapsed ? 'space-y-0' : 'space-y-2',
            )}
        >
            {groups.map((group, idx) => {
                // Collapsed sidebar: render a tiny "section marker"
                // (letter + divider) then the icon rows. There's no
                // expand/collapse interaction because there are no
                // labels to hide anyway — all items always show.
                if (collapsed) {
                    return (
                        <div
                            key={group.id}
                            className="flex flex-col items-center"
                        >
                            <CollapsedGroupMarker
                                group={group}
                                isFirst={idx === 0}
                            />
                            <div className="flex flex-col items-center gap-0.5">
                                {group.items.map((item) => (
                                    <NavRow
                                        key={item.to}
                                        item={item}
                                        collapsed
                                        onNavigate={onNavigate}
                                        badge={badgeFor(item)}
                                    />
                                ))}
                            </div>
                        </div>
                    );
                }

                // Expanded sidebar: icon + title-case header that
                // doubles as a fold toggle. A tinted "rail" on the
                // left edge tags each item beneath it with the
                // group's accent colour without screaming for
                // attention.
                const open = isOpen(group.id);
                const GroupIcon = group.icon;
                return (
                    <div key={group.id} className="flex flex-col">
                        <button
                            type="button"
                            onClick={() => toggle(group.id)}
                            className="group/header mb-1 flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm font-semibold text-foreground/85 transition-colors hover:bg-accent hover:text-foreground"
                            aria-expanded={open}
                            title={open ? 'Collapse section' : 'Expand section'}
                        >
                            <span
                                className={cn(
                                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background shadow-sm',
                                    group.accent,
                                )}
                            >
                                <GroupIcon className="h-3.5 w-3.5" />
                            </span>
                            <span className="flex-1 text-left text-sm font-semibold leading-none tracking-tight">
                                {group.label}
                            </span>
                            {!open && (
                                <span
                                    className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground/80"
                                    aria-label={`${group.items.length} hidden items`}
                                >
                                    {group.items.length}
                                </span>
                            )}
                            <ChevronDown
                                className={cn(
                                    'h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform',
                                    open ? 'rotate-0' : '-rotate-90',
                                )}
                            />
                        </button>
                        {open && (
                            <div className="relative space-y-0.5 pl-3">
                                <span
                                    aria-hidden
                                    className={cn(
                                        'absolute left-[7px] top-1 bottom-1 w-px rounded-full',
                                        group.rail,
                                    )}
                                />
                                {group.items.map((item) => (
                                    <div key={item.to}>
                                        <NavRow
                                            item={item}
                                            collapsed={false}
                                            onNavigate={onNavigate}
                                            badge={badgeFor(item)}
                                        />
                                        {/* Project groups nest under the
                                            Projects entry. */}
                                        {item.to === '/projects' &&
                                            projectGroups.length > 0 && (
                                                <div className="ml-7 mt-0.5 space-y-0.5 border-l border-border/60 pl-2">
                                                    {projectGroups.map((g) => (
                                                        <NavLink
                                                            key={g.id}
                                                            to={`/projects?group=${g.id}`}
                                                            onClick={onNavigate}
                                                            className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                                                            title={g.name}
                                                        >
                                                            <span className="truncate">
                                                                {g.name}
                                                            </span>
                                                            <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium">
                                                                {g.projectCount}
                                                            </span>
                                                        </NavLink>
                                                    ))}
                                                </div>
                                            )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </nav>
    );
}

// Identity header at the TOP of the sidebar: avatar + name (click to
// view profile) + position + role chip + edit / view profile icons.
// Replaces the old bottom user card and the top-bar profile menu.
function SidebarUserHeader({ collapsed, onNavigate }) {
    const { user } = useAuth();
    const navigate = useNavigate();
    const [profileOpen, setProfileOpen] = useState(false);

    if (!user) return null;

    const avatarSrc = resolveAssetUrl(user.avatarUrl);
    const roleLabel = ROLE_LABELS[user.role] || user.role || 'User';
    const roleTone = ROLE_PILL_TONE[user.role] || ROLE_PILL_TONE.USER;
    const viewProfile = () => {
        if (user.id) navigate(`/users/${user.id}`);
        onNavigate?.();
    };
    const editProfile = () => setProfileOpen(true);

    const avatarEl = (
        <Avatar className="h-9 w-9">
            {avatarSrc && <AvatarImage src={avatarSrc} alt={user.name || ''} />}
            <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                {initials(user.name)}
            </AvatarFallback>
        </Avatar>
    );

    if (collapsed) {
        return (
            <div className="flex flex-col items-center gap-1.5 border-b p-2">
                <button
                    type="button"
                    onClick={viewProfile}
                    title={`${user.name} · ${roleLabel} — View profile`}
                    aria-label="View profile"
                    className="rounded-full ring-1 ring-border transition-shadow hover:ring-primary/50"
                >
                    {avatarEl}
                </button>
                <button
                    type="button"
                    onClick={editProfile}
                    title="Edit profile"
                    aria-label="Edit profile"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                    <UserCog className="h-3.5 w-3.5" />
                </button>
                <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
            </div>
        );
    }

    return (
        <div className="border-b bg-card/40 p-2">
            <div className="flex items-center gap-2.5 rounded-lg border bg-background/80 p-2 shadow-sm">
                <button
                    type="button"
                    onClick={viewProfile}
                    title="View profile"
                    aria-label="View profile"
                    className="shrink-0 rounded-full ring-1 ring-border transition-shadow hover:ring-primary/50"
                >
                    {avatarEl}
                </button>
                <div className="min-w-0 flex-1">
                    <button
                        type="button"
                        onClick={viewProfile}
                        title="View profile"
                        className="block max-w-full truncate text-left text-sm font-semibold leading-tight text-foreground hover:underline"
                    >
                        {user.name}
                    </button>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {user.position || 'No position set'}
                    </div>
                    <span
                        className={cn(
                            'mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                            roleTone,
                        )}
                    >
                        <ShieldCheck className="h-2.5 w-2.5" />
                        {roleLabel}
                    </span>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                    <button
                        type="button"
                        onClick={editProfile}
                        title="Edit profile"
                        aria-label="Edit profile"
                        className="flex h-7 w-7 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                        <UserCog className="h-3.5 w-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={viewProfile}
                        title="View profile"
                        aria-label="View profile"
                        className="flex h-7 w-7 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                        <UserCircle className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
            <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
        </div>
    );
}

// Bottom footer for the sidebar — name + role chip + edit-profile +
// log-out buttons. Lives below the nav so it stays anchored even when
// the nav is tall enough to scroll. Collapsed sidebar shrinks the
// whole thing to a stacked column of icons.
function SidebarUserCard({ collapsed, onNavigate }) {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const [profileOpen, setProfileOpen] = useState(false);

    if (!user) return null;

    const handleEditProfile = () => {
        setProfileOpen(true);
        onNavigate?.();
    };
    const handleLogout = async () => {
        await logout();
        navigate('/login');
        onNavigate?.();
    };

    const avatarSrc = resolveAssetUrl(user.avatarUrl);
    const roleLabel = ROLE_LABELS[user.role] || user.role || 'User';
    const roleTone = ROLE_PILL_TONE[user.role] || ROLE_PILL_TONE.USER;

    if (collapsed) {
        return (
            <div className="border-t p-2">
                <div className="flex flex-col items-center gap-1.5">
                    <button
                        type="button"
                        onClick={handleEditProfile}
                        className="rounded-full ring-1 ring-border transition-shadow hover:ring-primary/50"
                        title={`${user.name} · ${roleLabel} — Edit profile`}
                        aria-label="Edit profile"
                    >
                        <Avatar className="h-9 w-9">
                            {avatarSrc && (
                                <AvatarImage src={avatarSrc} alt={user.name || ''} />
                            )}
                            <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                                {initials(user.name)}
                            </AvatarFallback>
                        </Avatar>
                    </button>
                    <button
                        type="button"
                        onClick={handleLogout}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title="Log out"
                        aria-label="Log out"
                    >
                        <LogOut className="h-3.5 w-3.5" />
                    </button>
                </div>
                <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
            </div>
        );
    }

    return (
        <div className="border-t bg-card/40 p-2">
            <div className="rounded-lg border bg-background/80 p-2 shadow-sm">
                <div className="flex items-center gap-2.5">
                    <Avatar className="h-9 w-9 ring-1 ring-border">
                        {avatarSrc && (
                            <AvatarImage src={avatarSrc} alt={user.name || ''} />
                        )}
                        <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                            {initials(user.name)}
                        </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold leading-tight text-foreground">
                            {user.name}
                        </div>
                        <span
                            className={cn(
                                'mt-0.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                roleTone,
                            )}
                        >
                            <ShieldCheck className="h-2.5 w-2.5" />
                            {roleLabel}
                        </span>
                    </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1">
                    <button
                        type="button"
                        onClick={handleEditProfile}
                        className="flex items-center justify-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-[11px] font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
                    >
                        <UserCog className="h-3.5 w-3.5" />
                        Edit profile
                    </button>
                    <button
                        type="button"
                        onClick={handleLogout}
                        className="flex items-center justify-center gap-1.5 rounded-md border border-destructive/30 bg-background px-2 py-1.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10"
                    >
                        <LogOut className="h-3.5 w-3.5" />
                        Log out
                    </button>
                </div>
            </div>
            <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
        </div>
    );
}

// Small identity footer pinned to the bottom of the sidebar: app name +
// version (links to Help → About) and the copyright line. Collapses to just
// the version when the rail is collapsed.
function SidebarFooter({ collapsed = false, onNavigate }) {
    if (collapsed) {
        return (
            <div className="mt-auto border-t p-2 text-center">
                <NavLink
                    to="/help"
                    onClick={onNavigate}
                    title={`${APP_NAME} v${APP_VERSION} — ${APP_COPYRIGHT}`}
                    className="text-[10px] tabular-nums text-muted-foreground hover:text-foreground"
                >
                    v{APP_VERSION}
                </NavLink>
            </div>
        );
    }
    return (
        <div className="mt-auto border-t px-3 py-2">
            <NavLink
                to="/help"
                onClick={onNavigate}
                title="About & release notes"
                className="block truncate text-[11px] leading-tight text-muted-foreground hover:text-foreground"
            >
                <span className="font-medium">{APP_NAME}</span> · v
                {APP_VERSION}
            </NavLink>
            <p className="mt-0.5 truncate text-[10px] leading-tight text-muted-foreground/70">
                {APP_COPYRIGHT}
            </p>
        </div>
    );
}

export function Sidebar() {
    const { open: mobileOpen, setOpen: setMobileOpen } = useMobileSidebar();

    const [collapsed, setCollapsed] = useState(() => {
        try {
            return localStorage.getItem(STORAGE_KEY) === '1';
        } catch {
            return false;
        }
    });

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
        } catch {
            // ignore quota errors
        }
    }, [collapsed]);

    return (
        <>
            {/* Desktop / tablet sidebar — hidden below md so we can
                hand off to the slide-in Sheet on phones. */}
            <aside
                className={cn(
                    'hidden h-screen shrink-0 flex-col border-r bg-muted/30 transition-[width] duration-150 md:flex',
                    collapsed ? 'w-14' : 'w-60',
                )}
            >
                <div
                    className={cn(
                        'flex h-16 items-center border-b px-2 py-2',
                        collapsed
                            ? 'justify-center'
                            : 'justify-between gap-2 px-4',
                    )}
                >
                    {collapsed ? (
                        // Collapsed rail: the icon mark doubles as the
                        // "expand" control so we don't need a separate chevron.
                        <button
                            type="button"
                            onClick={() => setCollapsed(false)}
                            className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent"
                            title="Expand sidebar"
                            aria-label="Expand sidebar"
                        >
                            <Logo variant="icon" className="h-6 w-6" />
                        </button>
                    ) : (
                        <>
                            <Logo
                                variant="full"
                                className="h-11 w-auto max-w-[180px]"
                            />
                            <button
                                type="button"
                                onClick={() => setCollapsed(true)}
                                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                                title="Collapse sidebar"
                                aria-label="Collapse sidebar"
                            >
                                <ChevronsLeft className="h-4 w-4" />
                            </button>
                        </>
                    )}
                </div>

                <SidebarUserHeader collapsed={collapsed} />
                <NavList collapsed={collapsed} />
                <SidebarFooter collapsed={collapsed} />
            </aside>

            {/* Mobile drawer — same nav contents, slides in from the
                left. Tapping a link auto-closes the sheet. */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetContent
                    side="left"
                    className="flex w-64 max-w-[85%] flex-col p-0"
                >
                    <div className="flex h-16 items-center border-b px-4 py-2">
                        <Logo variant="full" className="h-11 w-auto max-w-[200px]" />
                        <SheetTitle className="sr-only">{APP_NAME}</SheetTitle>
                    </div>
                    <SidebarUserHeader
                        collapsed={false}
                        onNavigate={() => setMobileOpen(false)}
                    />
                    <NavList onNavigate={() => setMobileOpen(false)} />
                    <SidebarFooter onNavigate={() => setMobileOpen(false)} />
                </SheetContent>
            </Sheet>
        </>
    );
}
