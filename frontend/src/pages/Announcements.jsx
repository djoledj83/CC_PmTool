// Admin broadcast announcements. Compose a message, choose its audience,
// and activate it — targeted users then see a modal until they acknowledge
// (optionally with a comment). This page also shows, per announcement, who
// has acknowledged (and what they replied) and who's still pending.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
    Megaphone,
    Loader2,
    Send,
    Power,
    Trash2,
    ChevronRight,
    Check,
    Eye,
    Pencil,
    Copy,
    RefreshCw,
    Repeat,
    X,
    ExternalLink,
} from 'lucide-react';

import { api } from '@/lib/api';
import { TopBar } from '@/components/TopBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogTitle,
} from '@/components/ui/dialog';
import AnnouncementView, {
    ANNOUNCEMENT_TYPE_META,
} from '@/components/AnnouncementView';
import { usePagination, Pagination } from '@/components/Pagination';
import AdminTabs from '@/components/AdminTabs';
import { RichTextEditor, RichText } from '@/components/RichText';

const AUDIENCE_LABEL = {
    ALL: 'All users',
    INTERNAL: 'Internal staff',
    EXTERNAL: 'External users',
    ROLES: 'By role',
    TEAMS: 'By team',
    USERS: 'Specific users',
};

const TYPE_META = {
    IMPORTANT: { label: 'Important', badge: 'destructive', dot: 'bg-red-500' },
    INFO: { label: 'Information', badge: 'success', dot: 'bg-emerald-500' },
    TIP: { label: 'Good to know', badge: 'warning', dot: 'bg-amber-500' },
    MANDATORY: { label: 'Mandatory (redirect)', badge: 'default', dot: 'bg-blue-500' },
};

const REPEAT_OPTIONS = [
    { value: 'none', label: 'No repeat' },
    { value: '1', label: 'Daily' },
    { value: '7', label: 'Weekly' },
    { value: '14', label: 'Every 2 weeks' },
    { value: '30', label: 'Every 30 days' },
    { value: 'custom', label: 'Custom…' },
];

// Short "Repeats every N days [until …]" label for the history list.
function repeatLabel(a) {
    if (!a.repeatIntervalDays) return null;
    const n = a.repeatIntervalDays;
    const every =
        n === 1
            ? 'daily'
            : n === 7
              ? 'weekly'
              : `every ${n} days`;
    const until = a.repeatUntil
        ? ` until ${new Date(a.repeatUntil).toLocaleDateString()}`
        : '';
    return `Repeats ${every}${until}`;
}

const ROLE_OPTIONS = [
    { value: 'ADMIN', label: 'Admin' },
    { value: 'MANAGER', label: 'Manager' },
    { value: 'APP_MODERATOR', label: 'App moderator' },
    { value: 'USER', label: 'User' },
    { value: 'REQUESTER', label: 'Requester' },
];

// Short human summary of an announcement's audience for the history list.
function describeAudience(a) {
    const base = AUDIENCE_LABEL[a.audience] || a.audience;
    if (a.audience === 'ROLES')
        return `${base}: ${(a.targetRoles || []).length}`;
    if (a.audience === 'TEAMS')
        return `${base}: ${(a.targetTeamIds || []).length}`;
    if (a.audience === 'USERS')
        return `${base}: ${(a.targetUserIds || []).length}`;
    return base;
}

function fmt(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export default function Announcements() {
    const [list, setList] = useState([]);
    const [loading, setLoading] = useState(true);

    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [type, setType] = useState('');
    const [redirectUrl, setRedirectUrl] = useState('');
    const [requireAck, setRequireAck] = useState(false);
    const [requireComment, setRequireComment] = useState(false);
    // Repeat: mode is 'none' | '1' | '7' | '14' | '30' | 'custom'; custom
    // days + optional end date drive repeatIntervalDays / repeatUntil.
    const [repeatMode, setRepeatMode] = useState('none');
    const [repeatCustom, setRepeatCustom] = useState(3);
    const [repeatUntil, setRepeatUntil] = useState('');
    // When set, the compose form is EDITING this announcement (PATCH),
    // otherwise it creates a new one (POST).
    const [editingId, setEditingId] = useState(null);
    // Bumped on reset / load so the (uncontrolled) rich-text editor
    // remounts and re-seeds from the current body.
    const [formKey, setFormKey] = useState(0);
    const [audience, setAudience] = useState('');
    const [targetRoles, setTargetRoles] = useState([]);
    const [targetTeamIds, setTargetTeamIds] = useState([]);
    const [targetUserIds, setTargetUserIds] = useState([]);
    const [activateNow, setActivateNow] = useState(false);
    const [creating, setCreating] = useState(false);

    // Option lists for team / user targeting.
    const [teams, setTeams] = useState([]);
    const [users, setUsers] = useState([]);
    const [userSearch, setUserSearch] = useState('');

    // Cached acknowledgement detail, keyed by announcement id.
    const [acks, setAcks] = useState({});

    // Preview dialog — holds {type,title,body,requireAck,requireComment}.
    const [preview, setPreview] = useState(null);
    // Detail dialog — the announcement whose full info + acks are open.
    const [detail, setDetail] = useState(null);

    // Pagination over the sent/drafts list.
    const {
        page,
        setPage,
        pageSize,
        setPageSize,
        total,
        totalPages,
        pageItems,
    } = usePagination(list, 10);

    const toggle = (arr, setter, val) =>
        setter(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);

    const load = () => {
        setLoading(true);
        api.get('/announcements')
            .then((res) => setList(res.data?.announcements || []))
            .catch((err) =>
                toast.error(
                    err?.response?.data?.error || 'Could not load announcements',
                ),
            )
            .finally(() => setLoading(false));
    };

    useEffect(load, []);

    // Targeting option lists (best-effort; empty lists just hide the picker).
    useEffect(() => {
        api.get('/teams')
            .then((r) => setTeams(r.data?.teams || r.data || []))
            .catch(() => setTeams([]));
        api.get('/users')
            .then((r) => setUsers(r.data?.users || []))
            .catch(() => setUsers([]));
    }, []);

    // Upload an inline image for the rich-text body; returns its URL.
    // `onProgress(pct)` (optional) is called with 0–100 as the bytes upload
    // so the editor can show a progress bar.
    const uploadAnnouncementImage = async (file, onProgress) => {
        const form = new FormData();
        form.append('image', file);
        try {
            const res = await api.post('/announcements/upload-image', form, {
                headers: { 'Content-Type': 'multipart/form-data' },
                onUploadProgress: (e) => {
                    if (onProgress && e.total) {
                        onProgress(
                            Math.min(100, Math.round((e.loaded * 100) / e.total)),
                        );
                    }
                },
            });
            return res.data?.url || null;
        } catch (err) {
            toast.error(
                err?.response?.data?.error || 'Could not upload image',
            );
            return null;
        }
    };

    const intervalFromMode = () => {
        if (repeatMode === 'none') return null;
        if (repeatMode === 'custom') return Number(repeatCustom) || 1;
        return Number(repeatMode);
    };

    const resetForm = () => {
        setTitle('');
        setBody('');
        setType('');
        setRedirectUrl('');
        setRequireAck(false);
        setRequireComment(false);
        setRepeatMode('none');
        setRepeatCustom(3);
        setRepeatUntil('');
        setAudience('');
        setTargetRoles([]);
        setTargetTeamIds([]);
        setTargetUserIds([]);
        setActivateNow(false);
        setEditingId(null);
        setFormKey((k) => k + 1);
    };

    // Load an existing announcement into the compose form — either to edit
    // it in place (asEdit=true → PATCH) or as a prefilled new draft
    // (asEdit=false → duplicate → POST).
    const loadIntoForm = (a, asEdit) => {
        setTitle(a.title || '');
        setBody(a.body || '');
        setType(a.type || 'INFO');
        setRedirectUrl(a.redirectUrl || '');
        setRequireAck(a.requireAck !== false);
        setRequireComment(Boolean(a.requireComment));
        const interval = a.repeatIntervalDays || null;
        if (!interval) {
            setRepeatMode('none');
        } else if (['1', '7', '14', '30'].includes(String(interval))) {
            setRepeatMode(String(interval));
        } else {
            setRepeatMode('custom');
            setRepeatCustom(interval);
        }
        setRepeatUntil(
            a.repeatUntil
                ? new Date(a.repeatUntil).toISOString().slice(0, 10)
                : '',
        );
        setAudience(a.audience || 'ALL');
        setTargetRoles(a.targetRoles || []);
        setTargetTeamIds(a.targetTeamIds || []);
        setTargetUserIds(a.targetUserIds || []);
        setEditingId(asEdit ? a.id : null);
        setFormKey((k) => k + 1);
        if (typeof window !== 'undefined') {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    };

    const create = async () => {
        const bodyText = body
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .trim();
        if (!title.trim() || !bodyText) {
            toast.error('Add a title and a message');
            return;
        }
        if (!type) {
            toast.error('Pick a type');
            return;
        }
        if (type === 'MANDATORY' && !/^https?:\/\//i.test(redirectUrl.trim())) {
            toast.error('Enter the new address (http/https URL)');
            return;
        }
        if (!audience) {
            toast.error('Choose an audience');
            return;
        }
        if (audience === 'ROLES' && targetRoles.length === 0) {
            toast.error('Pick at least one role');
            return;
        }
        if (audience === 'TEAMS' && targetTeamIds.length === 0) {
            toast.error('Pick at least one team');
            return;
        }
        if (audience === 'USERS' && targetUserIds.length === 0) {
            toast.error('Pick at least one user');
            return;
        }
        setCreating(true);
        const isMandatory = type === 'MANDATORY';
        const payload = {
            title: title.trim(),
            body: body.trim(),
            type,
            redirectUrl: isMandatory ? redirectUrl.trim() : null,
            requireAck: isMandatory ? false : requireAck,
            requireComment: isMandatory ? false : requireAck ? requireComment : false,
            audience,
            targetRoles: audience === 'ROLES' ? targetRoles : [],
            targetTeamIds: audience === 'TEAMS' ? targetTeamIds : [],
            targetUserIds: audience === 'USERS' ? targetUserIds : [],
            repeatIntervalDays: intervalFromMode(),
            repeatUntil: repeatUntil
                ? new Date(`${repeatUntil}T23:59:59`).toISOString()
                : null,
        };
        try {
            if (editingId) {
                await api.patch(`/announcements/${editingId}`, payload);
                toast.success('Announcement updated');
            } else {
                await api.post('/announcements', {
                    ...payload,
                    active: activateNow,
                });
                toast.success(activateNow ? 'Announcement sent' : 'Draft saved');
            }
            resetForm();
            load();
        } catch (err) {
            toast.error(err?.response?.data?.error || 'Could not save');
        } finally {
            setCreating(false);
        }
    };

    const resend = async (a) => {
        if (
            !window.confirm(
                `Re-send "${a.title}"? This clears all acknowledgements and shows it to everyone again.`,
            )
        )
            return;
        try {
            await api.post(`/announcements/${a.id}/resend`);
            toast.success('Announcement re-sent');
            load();
        } catch (err) {
            toast.error(err?.response?.data?.error || 'Could not re-send');
        }
    };

    const toggleActive = async (a) => {
        try {
            await api.patch(`/announcements/${a.id}`, { active: !a.active });
            load();
        } catch (err) {
            toast.error(err?.response?.data?.error || 'Could not update');
        }
    };

    const remove = async (a) => {
        if (!window.confirm(`Delete "${a.title}"? This can't be undone.`))
            return;
        try {
            await api.delete(`/announcements/${a.id}`);
            load();
        } catch (err) {
            toast.error(err?.response?.data?.error || 'Could not delete');
        }
    };

    const fetchAcks = async (id) => {
        try {
            const res = await api.get(`/announcements/${id}/acks`);
            setAcks((m) => ({ ...m, [id]: res.data }));
        } catch {
            toast.error('Could not load acknowledgements');
        }
    };
    const openDetail = (a) => {
        setDetail(a);
        if (!acks[a.id]) fetchAcks(a.id);
    };

    // Readable "who is this going to" for a row, resolving team / user ids
    // to names from the loaded lists.
    const recipientsLabel = (a) => {
        const teamName = (id) =>
            teams.find((t) => t.id === id)?.name || 'team';
        const userName = (id) => {
            const u = users.find((x) => x.id === id);
            return u ? u.name || u.email : 'user';
        };
        switch (a.audience) {
            case 'INTERNAL':
                return 'Internal staff';
            case 'EXTERNAL':
                return 'External users';
            case 'ROLES':
                return `Roles: ${(a.targetRoles || [])
                    .map(
                        (r) =>
                            ROLE_OPTIONS.find((o) => o.value === r)?.label || r,
                    )
                    .join(', ') || '—'}`;
            case 'TEAMS':
                return `Teams: ${(a.targetTeamIds || [])
                    .map(teamName)
                    .join(', ') || '—'}`;
            case 'USERS': {
                const names = (a.targetUserIds || []).map(userName);
                if (names.length <= 4)
                    return `Users: ${names.join(', ') || '—'}`;
                return `Users: ${names.slice(0, 4).join(', ')} +${names.length - 4} more`;
            }
            case 'ALL':
            default:
                return 'All users';
        }
    };

    return (
        <>
            <TopBar title="Announcements" />
            <AdminTabs />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="flex w-full flex-col gap-6">
                    {/* Compose */}
                    <Card>
                        <CardHeader className="pb-3">
                            <CardTitle className="flex items-center gap-2 text-base font-semibold">
                                <Megaphone className="h-4 w-4 text-primary" />
                                {editingId ? 'Edit announcement' : 'New announcement'}
                            </CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {editingId
                                    ? 'Editing an existing announcement. Changes apply to everyone who hasn’t acknowledged yet.'
                                    : 'Shows as a modal to the chosen audience until each person acknowledges it.'}
                            </p>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {/* Left 80% = title + message · right 20% = type */}
                            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
                                <div className="space-y-3 lg:col-span-4">
                                    <div className="space-y-1.5">
                                        <Label htmlFor="ann-title" className="text-xs">
                                            Title
                                        </Label>
                                        <Input
                                            id="ann-title"
                                            value={title}
                                            maxLength={200}
                                            onChange={(e) => setTitle(e.target.value)}
                                            placeholder="e.g. Planned maintenance this Friday"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label className="text-xs">Message</Label>
                                        <RichTextEditor
                                            key={formKey}
                                            initialHtml={body}
                                            onChange={({ html }) => setBody(html)}
                                            placeholder="What do you want everyone to know?"
                                            enableQuote
                                            enableLink
                                            enableImage
                                            enableSize
                                            enableAlign
                                            onImageUpload={uploadAnnouncementImage}
                                        />
                                    </div>
                                </div>
                                <div className="space-y-1.5 lg:col-span-1">
                                    <Label className="text-xs">Type</Label>
                                    <div className="flex flex-col gap-2">
                                        {['IMPORTANT', 'INFO', 'TIP', 'MANDATORY'].map((t) => {
                                            const m = ANNOUNCEMENT_TYPE_META[t];
                                            const Icon = m.Icon;
                                            const selected = type === t;
                                            return (
                                                <button
                                                    key={t}
                                                    type="button"
                                                    onClick={() =>
                                                        setType(selected ? '' : t)
                                                    }
                                                    aria-pressed={selected}
                                                    className={`flex w-full items-center gap-2 rounded-lg border p-3 text-left transition ${
                                                        selected
                                                            ? `border-2 ${m.ring} ${m.bg}`
                                                            : 'border-input hover:bg-accent'
                                                    }`}
                                                >
                                                    <Icon
                                                        className={`h-5 w-5 shrink-0 ${m.fg}`}
                                                    />
                                                    <span className="text-sm font-medium">
                                                        {m.label}
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>

                            {/* MANDATORY: the new address users get redirected to. */}
                            {type === 'MANDATORY' && (
                                <div className="space-y-1.5 rounded-md border border-blue-500/40 bg-blue-50/60 p-3 dark:bg-blue-500/10">
                                    <Label className="flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-400">
                                        <ExternalLink className="h-3.5 w-3.5" />
                                        New address (redirect URL)
                                    </Label>
                                    <Input
                                        type="url"
                                        value={redirectUrl}
                                        onChange={(e) =>
                                            setRedirectUrl(e.target.value)
                                        }
                                        placeholder="https://new-address.example.com"
                                    />
                                    <p className="text-[11px] text-muted-foreground">
                                        This one can’t be dismissed — everyone
                                        targeted sees a blocking modal whose only
                                        button sends them to this address. Use it
                                        when the service moves.
                                    </p>
                                </div>
                            )}

                            {/* Repeat + Send to, side by side under the split */}
                            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                            <div className="flex flex-wrap items-end gap-4">
                                <div className="space-y-1.5">
                                    <Label className="flex items-center gap-1 text-xs">
                                        <Repeat className="h-3.5 w-3.5" /> Repeat
                                    </Label>
                                    <Select
                                        value={repeatMode}
                                        onValueChange={setRepeatMode}
                                    >
                                        <SelectTrigger className="h-9 w-[180px]">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {REPEAT_OPTIONS.map((o) => (
                                                <SelectItem
                                                    key={o.value}
                                                    value={o.value}
                                                >
                                                    {o.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                {repeatMode === 'custom' && (
                                    <div className="space-y-1.5">
                                        <Label className="text-xs">
                                            Every N days
                                        </Label>
                                        <Input
                                            type="number"
                                            min={1}
                                            max={365}
                                            value={repeatCustom}
                                            onChange={(e) =>
                                                setRepeatCustom(e.target.value)
                                            }
                                            className="h-9 w-[120px]"
                                        />
                                    </div>
                                )}
                                {repeatMode !== 'none' && (
                                    <div className="space-y-1.5">
                                        <Label className="text-xs">
                                            Repeat until{' '}
                                            <span className="text-muted-foreground">
                                                (optional)
                                            </span>
                                        </Label>
                                        <Input
                                            type="date"
                                            value={repeatUntil}
                                            onChange={(e) =>
                                                setRepeatUntil(e.target.value)
                                            }
                                            className="h-9 w-[170px]"
                                        />
                                    </div>
                                )}
                            </div>

                            <div className="space-y-1.5">
                                <Label className="text-xs">Send to</Label>
                                <Select
                                    value={audience}
                                    onValueChange={setAudience}
                                >
                                    <SelectTrigger className="h-9 w-[260px]">
                                        <SelectValue placeholder="Choose audience…" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="ALL">
                                            {AUDIENCE_LABEL.ALL}
                                        </SelectItem>
                                        <SelectItem value="INTERNAL">
                                            {AUDIENCE_LABEL.INTERNAL}
                                        </SelectItem>
                                        <SelectItem value="EXTERNAL">
                                            {AUDIENCE_LABEL.EXTERNAL}
                                        </SelectItem>
                                        <SelectItem value="ROLES">
                                            {AUDIENCE_LABEL.ROLES}
                                        </SelectItem>
                                        {teams.length > 0 && (
                                            <SelectItem value="TEAMS">
                                                {AUDIENCE_LABEL.TEAMS}
                                            </SelectItem>
                                        )}
                                        <SelectItem value="USERS">
                                            {AUDIENCE_LABEL.USERS}
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            </div>

                            {audience === 'ROLES' && (
                                <div className="flex flex-wrap gap-3 rounded-md border bg-muted/30 p-3">
                                    {ROLE_OPTIONS.map((r) => (
                                        <label
                                            key={r.value}
                                            className="flex items-center gap-1.5 text-sm"
                                        >
                                            <input
                                                type="checkbox"
                                                className="h-4 w-4"
                                                checked={targetRoles.includes(r.value)}
                                                onChange={() =>
                                                    toggle(targetRoles, setTargetRoles, r.value)
                                                }
                                            />
                                            {r.label}
                                        </label>
                                    ))}
                                </div>
                            )}

                            {audience === 'TEAMS' && (
                                <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-3">
                                    {teams.length === 0 ? (
                                        <p className="text-xs text-muted-foreground">
                                            No teams found.
                                        </p>
                                    ) : (
                                        teams.map((t) => (
                                            <label
                                                key={t.id}
                                                className="flex items-center gap-1.5 text-sm"
                                            >
                                                <input
                                                    type="checkbox"
                                                    className="h-4 w-4"
                                                    checked={targetTeamIds.includes(t.id)}
                                                    onChange={() =>
                                                        toggle(targetTeamIds, setTargetTeamIds, t.id)
                                                    }
                                                />
                                                {t.name}
                                            </label>
                                        ))
                                    )}
                                </div>
                            )}

                            {audience === 'USERS' && (
                                <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <Input
                                            value={userSearch}
                                            onChange={(e) => setUserSearch(e.target.value)}
                                            placeholder="Search users…"
                                            className="h-8"
                                        />
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            {targetUserIds.length} selected
                                        </span>
                                    </div>
                                    <div className="max-h-44 space-y-1 overflow-y-auto">
                                        {users
                                            .filter((u) => {
                                                const q = userSearch.trim().toLowerCase();
                                                if (!q) return true;
                                                return (
                                                    (u.name || '').toLowerCase().includes(q) ||
                                                    (u.email || '').toLowerCase().includes(q)
                                                );
                                            })
                                            .slice(0, 100)
                                            .map((u) => (
                                                <label
                                                    key={u.id}
                                                    className="flex items-center gap-1.5 text-sm"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        className="h-4 w-4"
                                                        checked={targetUserIds.includes(u.id)}
                                                        onChange={() =>
                                                            toggle(targetUserIds, setTargetUserIds, u.id)
                                                        }
                                                    />
                                                    <span className="truncate">
                                                        {u.name || u.email}
                                                        {u.name && (
                                                            <span className="text-muted-foreground">
                                                                {' '}· {u.email}
                                                            </span>
                                                        )}
                                                    </span>
                                                </label>
                                            ))}
                                    </div>
                                </div>
                            )}

                            {/* One-line options: ack · written response · activate */}
                            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-4">
                                {type !== 'MANDATORY' && (
                                    <>
                                        <label className="flex items-center gap-2 text-sm">
                                            <input
                                                type="checkbox"
                                                className="h-4 w-4"
                                                checked={requireAck}
                                                onChange={(e) =>
                                                    setRequireAck(e.target.checked)
                                                }
                                            />
                                            Requires acknowledgement
                                            <span className="text-xs text-muted-foreground">
                                                (off = info only)
                                            </span>
                                        </label>
                                        {requireAck && (
                                            <label className="flex items-center gap-2 text-sm">
                                                <input
                                                    type="checkbox"
                                                    className="h-4 w-4"
                                                    checked={requireComment}
                                                    onChange={(e) =>
                                                        setRequireComment(
                                                            e.target.checked,
                                                        )
                                                    }
                                                />
                                                Require a written response
                                            </label>
                                        )}
                                    </>
                                )}
                                {!editingId && (
                                    <label className="flex items-center gap-2 text-sm">
                                        <input
                                            type="checkbox"
                                            className="h-4 w-4"
                                            checked={activateNow}
                                            onChange={(e) =>
                                                setActivateNow(e.target.checked)
                                            }
                                        />
                                        Activate immediately
                                    </label>
                                )}
                            </div>

                            <div className="flex items-center justify-end gap-2">
                                {editingId && (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        className="gap-2"
                                        onClick={resetForm}
                                    >
                                        <X className="h-4 w-4" />
                                        Cancel
                                    </Button>
                                )}
                                <Button
                                    type="button"
                                    variant="outline"
                                    className="gap-2"
                                    onClick={() =>
                                        setPreview({
                                            type,
                                            title: title.trim() || 'Untitled',
                                            body: body.trim(),
                                            redirectUrl: redirectUrl.trim(),
                                            requireAck:
                                                type === 'MANDATORY'
                                                    ? false
                                                    : requireAck,
                                            requireComment:
                                                type === 'MANDATORY'
                                                    ? false
                                                    : requireComment,
                                        })
                                    }
                                >
                                    <Eye className="h-4 w-4" />
                                    Preview
                                </Button>
                                <Button
                                    onClick={create}
                                    disabled={creating}
                                    className="gap-2"
                                >
                                    {creating ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Send className="h-4 w-4" />
                                    )}
                                    {editingId
                                        ? 'Save changes'
                                        : activateNow
                                          ? 'Send'
                                          : 'Save draft'}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Sent / history */}
                    <Card>
                        <CardHeader className="pb-2">
                            <CardTitle className="text-base font-semibold">
                                Sent &amp; drafts
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            {loading ? (
                                <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Loading…
                                </div>
                            ) : list.length === 0 ? (
                                <p className="py-6 text-center text-sm text-muted-foreground">
                                    No announcements yet.
                                </p>
                            ) : (
                                <div className="overflow-hidden rounded-md border">
                                    {pageItems.map((a) => (
                                    <button
                                        key={a.id}
                                        type="button"
                                        onClick={() => openDetail(a)}
                                        className="flex w-full items-center gap-2.5 border-b px-3 py-2.5 text-left odd:bg-muted/40 last:border-0 hover:bg-accent"
                                    >
                                        <span
                                            className={`h-2.5 w-2.5 shrink-0 rounded-full ${TYPE_META[a.type]?.dot || 'bg-slate-400'}`}
                                            title={TYPE_META[a.type]?.label || a.type}
                                        />
                                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                            {a.title}
                                        </span>
                                        {a.active ? (
                                            <Badge variant="success" className="text-[10px]">
                                                Active
                                            </Badge>
                                        ) : (
                                            <Badge variant="outline" className="text-[10px]">
                                                Draft
                                            </Badge>
                                        )}
                                        {!a.requireAck && (
                                            <Badge variant="outline" className="hidden text-[10px] sm:inline-flex">
                                                Info
                                            </Badge>
                                        )}
                                        {a.repeatIntervalDays ? (
                                            <Repeat
                                                className="hidden h-3.5 w-3.5 shrink-0 text-muted-foreground sm:block"
                                                title={repeatLabel(a)}
                                            />
                                        ) : null}
                                        <span className="hidden max-w-[16rem] truncate text-xs text-muted-foreground md:inline">
                                            {recipientsLabel(a)}
                                        </span>
                                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                            Seen {a.ackCount}/{a.targetCount}
                                        </span>
                                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                                    </button>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                        {total > 0 && (
                            <Pagination
                                page={page}
                                pageSize={pageSize}
                                total={total}
                                totalPages={totalPages}
                                onPageChange={setPage}
                                onPageSizeChange={setPageSize}
                                pageSizeOptions={[10, 25, 50, 100]}
                            />
                        )}
                    </Card>
                </div>
            </main>

            {/* Preview — renders exactly how the modal appears to users. */}
            <Dialog
                open={!!preview}
                onOpenChange={(v) => (!v ? setPreview(null) : null)}
            >
                <DialogContent
                    style={{ width: '60vw', maxWidth: '92vw', minWidth: 320 }}
                    className="flex flex-col items-center gap-4 p-8 text-center"
                >
                    {preview && (
                        <AnnouncementView
                            type={preview.type}
                            title={preview.title || 'Untitled'}
                            body={preview.body || ''}
                        />
                    )}
                    {preview?.requireAck && (
                        <div className="w-full space-y-1.5 text-left opacity-70">
                            <Label className="text-xs">
                                Your response{' '}
                                {preview?.requireComment ? (
                                    <span className="text-destructive">
                                        (required)
                                    </span>
                                ) : (
                                    <span className="text-muted-foreground">
                                        (optional)
                                    </span>
                                )}
                            </Label>
                            <Textarea
                                rows={2}
                                disabled
                                placeholder="Add a reply for the sender…"
                            />
                        </div>
                    )}
                    <DialogFooter className="flex w-full items-center justify-center gap-2 sm:justify-center sm:space-x-0">
                        {preview?.type === 'MANDATORY' ? (
                            <Button disabled className="min-w-[240px] gap-2">
                                <ExternalLink className="h-4 w-4" />
                                Go to the new address
                            </Button>
                        ) : preview?.requireAck ? (
                            <>
                                <Button variant="ghost" disabled>
                                    Later
                                </Button>
                                <Button disabled>I understand</Button>
                            </>
                        ) : (
                            <Button disabled className="min-w-[120px]">
                                Close
                            </Button>
                        )}
                    </DialogFooter>
                    <p className="text-[11px] text-muted-foreground">
                        Preview · buttons are disabled here
                    </p>
                </DialogContent>
            </Dialog>

            {/* Detail — full info + acknowledgements + actions. */}
            <Dialog
                open={!!detail}
                onOpenChange={(v) => (!v ? setDetail(null) : null)}
            >
                <DialogContent
                    style={{ width: '60vw', maxWidth: '92vw', minWidth: 320 }}
                    className="max-h-[85vh] overflow-y-auto"
                >
                    {detail && (
                        <>
                            <div className="flex flex-wrap items-center gap-2 pr-6">
                                <Badge
                                    variant={TYPE_META[detail.type]?.badge || 'secondary'}
                                    className="text-[10px]"
                                >
                                    {TYPE_META[detail.type]?.label || detail.type}
                                </Badge>
                                <DialogTitle className="text-lg font-semibold leading-snug">
                                    {detail.title}
                                </DialogTitle>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                {detail.active ? (
                                    <Badge variant="success" className="text-[10px]">
                                        Active
                                    </Badge>
                                ) : (
                                    <Badge variant="outline" className="text-[10px]">
                                        Draft
                                    </Badge>
                                )}
                                <Badge variant="outline" className="text-[10px]">
                                    {detail.requireAck
                                        ? detail.requireComment
                                            ? 'Response required'
                                            : 'Acknowledge'
                                        : 'Info only'}
                                </Badge>
                                {detail.repeatIntervalDays ? (
                                    <Badge variant="outline" className="gap-1 text-[10px]">
                                        <Repeat className="h-3 w-3" />
                                        {repeatLabel(detail)}
                                    </Badge>
                                ) : null}
                            </div>

                            <p className="text-xs font-medium text-foreground">
                                To: {recipientsLabel(detail)}
                            </p>

                            <div className="rounded-md border bg-muted/30 p-3 text-sm">
                                <RichText source={detail.body} />
                            </div>

                            <p className="text-[11px] text-muted-foreground">
                                {detail.createdBy?.name
                                    ? `By ${detail.createdBy.name} · `
                                    : ''}
                                {detail.activatedAt
                                    ? `sent ${fmt(detail.activatedAt)}`
                                    : `created ${fmt(detail.createdAt)}`}
                            </p>

                            {/* Acknowledgements */}
                            <div className="space-y-2 border-t pt-3">
                                <p className="text-xs font-semibold text-foreground">
                                    Seen by {detail.ackCount} of{' '}
                                    {detail.targetCount}
                                </p>
                                {!acks[detail.id] ? (
                                    <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        Loading…
                                    </div>
                                ) : (
                                    <>
                                        {acks[detail.id].acknowledged.length ===
                                        0 ? (
                                            <p className="text-xs text-muted-foreground">
                                                Nobody has acknowledged yet.
                                            </p>
                                        ) : (
                                            <ul className="space-y-1">
                                                {acks[detail.id].acknowledged.map(
                                                    (r) => (
                                                        <li
                                                            key={r.user.id}
                                                            className="flex items-start gap-2 text-xs"
                                                        >
                                                            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                                                            <span>
                                                                <span className="font-medium text-foreground">
                                                                    {r.user.name ||
                                                                        r.user.email}
                                                                </span>{' '}
                                                                <span className="text-muted-foreground">
                                                                    ·{' '}
                                                                    {fmt(
                                                                        r.acknowledgedAt,
                                                                    )}
                                                                </span>
                                                                {r.comment && (
                                                                    <span className="mt-0.5 block italic text-muted-foreground">
                                                                        “{r.comment}”
                                                                    </span>
                                                                )}
                                                            </span>
                                                        </li>
                                                    ),
                                                )}
                                            </ul>
                                        )}
                                        {acks[detail.id].pending.length > 0 && (
                                            <p className="text-xs text-muted-foreground">
                                                <span className="font-semibold text-foreground">
                                                    Pending (
                                                    {acks[detail.id].pending.length}
                                                    ):{' '}
                                                </span>
                                                {acks[detail.id].pending
                                                    .map((u) => u.name || u.email)
                                                    .join(', ')}
                                            </p>
                                        )}
                                    </>
                                )}
                            </div>

                            <div className="space-y-2 border-t pt-3">
                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="w-full gap-1.5"
                                        onClick={() => {
                                            const d = detail;
                                            setDetail(null);
                                            setPreview(d);
                                        }}
                                    >
                                        <Eye className="h-3.5 w-3.5" /> Preview
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="w-full gap-1.5"
                                        onClick={() => {
                                            loadIntoForm(detail, true);
                                            setDetail(null);
                                        }}
                                    >
                                        <Pencil className="h-3.5 w-3.5" /> Edit
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="w-full gap-1.5"
                                        onClick={() => {
                                            loadIntoForm(detail, false);
                                            setDetail(null);
                                        }}
                                    >
                                        <Copy className="h-3.5 w-3.5" /> Duplicate
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="w-full gap-1.5"
                                        onClick={() => {
                                            resend(detail);
                                            setDetail(null);
                                        }}
                                    >
                                        <RefreshCw className="h-3.5 w-3.5" /> Re-send
                                    </Button>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <Button
                                        variant={detail.active ? 'outline' : 'default'}
                                        size="sm"
                                        className="w-full gap-1.5"
                                        onClick={() => {
                                            toggleActive(detail);
                                            setDetail(null);
                                        }}
                                    >
                                        <Power className="h-3.5 w-3.5" />
                                        {detail.active ? 'Deactivate' : 'Activate'}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="w-full gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                                        onClick={() => {
                                            const d = detail;
                                            setDetail(null);
                                            remove(d);
                                        }}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" /> Delete
                                    </Button>
                                </div>
                            </div>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </>
    );
}
