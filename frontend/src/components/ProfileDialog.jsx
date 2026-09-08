import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format } from 'date-fns';
import {
    Briefcase,
    Building2,
    Camera,
    Clock,
    Coins,
    Globe2,
    Info,
    KeyRound,
    Mail,
    Phone,
    Shield,
    Trash2,
    UserCog,
    User as UserIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useBusinessUnits, useCountries } from '@/lib/catalogs';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { AvatarCropDialog } from '@/components/AvatarCropDialog';
import ProfileStatsPanel from '@/components/ProfileStatsPanel';

// Profile dialog opened from the avatar in the TopBar. Lets the
// signed-in user edit their own basic details (avatar, name, phone,
// position) and change their password without leaving the chrome.
// Admin role-management lives elsewhere — this dialog never lets a
// user change their own role.

// Sentinel value used in the team-leader / business-unit selects to
// represent "no selection". <Select /> from shadcn refuses an empty
// string item value, so we route "" <-> NONE_VALUE at the form
// boundary instead.
const NONE_VALUE = '__none__';

const profileSchema = z.object({
    name: z.string().min(1, 'Name is required').max(100),
    email: z.string().email('Enter a valid email'),
    phone: z.string().max(40).optional().or(z.literal('')),
    position: z.string().max(120).optional().or(z.literal('')),
    country: z.string().max(80).optional().or(z.literal('')),
    currency: z.string().max(20).optional().or(z.literal('')),
    about: z.string().max(2000).optional().or(z.literal('')),
    teamLeaderId: z.string().optional().or(z.literal('')),
    businessUnitId: z.string().optional().or(z.literal('')),
});

const passwordSchema = z
    .object({
        currentPassword: z.string().min(1, 'Required'),
        newPassword: z
            .string()
            .min(8, 'New password must be at least 8 characters'),
        confirmPassword: z.string().min(1, 'Required'),
    })
    .refine((d) => d.newPassword === d.confirmPassword, {
        message: 'Passwords do not match',
        path: ['confirmPassword'],
    });

const ROLE_LABELS = { ADMIN: 'Admin', MANAGER: 'Manager', USER: 'User' };

// Role-specific styling so the badge actually telegraphs the level of
// access. ADMIN gets a strong primary tint, MANAGER a violet accent
// (matches the Users table styling), USER stays neutral.
const ROLE_BADGE_CLASSES = {
    ADMIN:
        'border-primary/40 bg-primary/15 text-primary dark:bg-primary/25',
    MANAGER:
        'border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/20 dark:text-violet-200',
    USER:
        'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-500/40 dark:bg-slate-500/15 dark:text-slate-200',
};

function formatStamp(d) {
    if (!d) return 'Never';
    try {
        return format(new Date(d), "MMM d, yyyy 'at' h:mm a");
    } catch {
        return '—';
    }
}

export function ProfileDialog({ open, onOpenChange }) {
    const { user, updateCurrentUser } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    const fileInputRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [savingProfile, setSavingProfile] = useState(false);
    const [savingPassword, setSavingPassword] = useState(false);
    const [savingEmailToggle, setSavingEmailToggle] = useState(false);
    const [previewUrl, setPreviewUrl] = useState(null);
    // Holds the file the user just picked while the crop dialog is
    // open. Once the user confirms the crop we hand the resulting
    // File to the regular upload flow.
    const [pendingCrop, setPendingCrop] = useState(null);

    // People + catalogs powering the new selects. We only fetch them
    // while the dialog is open to keep the cost off the home screen.
    const [teamLeaderOptions, setTeamLeaderOptions] = useState([]);
    const { items: countryOptions } = useCountries();
    const { items: businessUnitOptions } = useBusinessUnits();

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        api.get('/users')
            .then(({ data }) => {
                if (cancelled) return;
                const list = Array.isArray(data?.users) ? data.users : [];
                setTeamLeaderOptions(list);
            })
            .catch(() => !cancelled && setTeamLeaderOptions([]));
        return () => {
            cancelled = true;
        };
    }, [open]);

    const {
        register,
        handleSubmit,
        reset,
        watch,
        setValue,
        formState: { errors, isDirty },
    } = useForm({
        resolver: zodResolver(profileSchema),
        defaultValues: {
            name: '',
            email: '',
            phone: '',
            position: '',
            country: '',
            currency: '',
            about: '',
            teamLeaderId: '',
            businessUnitId: '',
        },
    });

    const {
        register: registerPwd,
        handleSubmit: handleSubmitPwd,
        reset: resetPwd,
        formState: { errors: pwdErrors },
    } = useForm({
        resolver: zodResolver(passwordSchema),
        defaultValues: {
            currentPassword: '',
            newPassword: '',
            confirmPassword: '',
        },
    });

    useEffect(() => {
        if (open && user) {
            reset({
                name: user.name || '',
                email: user.email || '',
                phone: user.phone || '',
                position: user.position || '',
                country: user.country || '',
                currency: user.currency || '',
                about: user.about || '',
                teamLeaderId: user.teamLeaderId || '',
                businessUnitId: user.businessUnitId || '',
            });
            resetPwd({
                currentPassword: '',
                newPassword: '',
                confirmPassword: '',
            });
            setPreviewUrl(resolveAssetUrl(user.avatarUrl) || null);
        }
    }, [open, user, reset, resetPwd]);

    // Self-references for team-leader are forbidden by the server, so
    // strip the current user from the dropdown — and also any
    // suspended teammates who would also get rejected.
    const teamLeaderChoices = useMemo(
        () =>
            (teamLeaderOptions || []).filter(
                (u) =>
                    u.id !== user?.id &&
                    (u.status === undefined || u.status === 'ACTIVE'),
            ),
        [teamLeaderOptions, user?.id],
    );

    if (!user) return null;

    const handlePickAvatar = () => fileInputRef.current?.click();

    const handleAvatarSelected = (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        // Defer the upload — first let the user crop and position
        // their picture in `AvatarCropDialog`.
        setPendingCrop(file);
    };

    const uploadAvatarFile = async (file) => {
        const fd = new FormData();
        fd.append('avatar', file);
        setUploading(true);
        try {
            const { data } = await api.post(`/users/${user.id}/avatar`, fd, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            setPreviewUrl(resolveAssetUrl(data.user.avatarUrl));
            updateCurrentUser({ avatarUrl: data.user.avatarUrl });
            toast.success('Picture updated');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not upload picture');
        } finally {
            setUploading(false);
        }
    };

    const handleRemoveAvatar = async () => {
        if (!user.avatarUrl) {
            setPreviewUrl(null);
            return;
        }
        try {
            const { data } = await api.delete(`/users/${user.id}/avatar`);
            setPreviewUrl(null);
            updateCurrentUser({ avatarUrl: data.user.avatarUrl });
            toast.success('Picture removed');
        } catch {
            toast.error('Could not remove picture');
        }
    };

    const submitProfile = async (values) => {
        setSavingProfile(true);
        try {
            const payload = {
                name: values.name,
                email: values.email,
                phone: values.phone || null,
                position: values.position || null,
                country: values.country?.trim() || null,
                currency: values.currency?.trim() || null,
                about: values.about?.trim() || null,
                teamLeaderId: values.teamLeaderId || null,
            };
            // Business unit can only be changed by an admin (per the
            // product spec). Don't include the field for non-admins so
            // a stale form value never silently overrides what an
            // admin previously set.
            if (isAdmin) {
                payload.businessUnitId = values.businessUnitId || null;
            }

            const { data } = await api.patch(`/users/${user.id}`, payload);
            updateCurrentUser({
                name: data.user.name,
                email: data.user.email,
                phone: data.user.phone,
                position: data.user.position,
                country: data.user.country,
                currency: data.user.currency,
                about: data.user.about,
                teamLeaderId: data.user.teamLeaderId,
                teamLeader: data.user.teamLeader,
                businessUnitId: data.user.businessUnitId,
                businessUnit: data.user.businessUnit,
            });
            toast.success('Profile saved');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save profile');
        } finally {
            setSavingProfile(false);
        }
    };

    // Tiny inline-save handler for the email-notifications toggle.
    // No form roundtrip — flipping the switch persists immediately and
    // updates the cached auth user so the rest of the app sees the
    // new value without a refresh.
    const handleEmailToggle = async (next) => {
        setSavingEmailToggle(true);
        const prev = user.emailNotifications !== false;
        // Optimistic update so the switch animates instantly.
        updateCurrentUser({ emailNotifications: next });
        try {
            await api.patch(`/users/${user.id}`, {
                emailNotifications: next,
            });
            toast.success(
                next
                    ? 'Email notifications turned on'
                    : 'Email notifications turned off',
            );
        } catch (err) {
            updateCurrentUser({ emailNotifications: prev });
            toast.error(
                err.response?.data?.error ||
                    'Could not update email notifications',
            );
        } finally {
            setSavingEmailToggle(false);
        }
    };

    const submitPassword = async (values) => {
        setSavingPassword(true);
        try {
            await api.post('/auth/change-password', {
                currentPassword: values.currentPassword,
                newPassword: values.newPassword,
            });
            resetPwd({
                currentPassword: '',
                newPassword: '',
                confirmPassword: '',
            });
            toast.success('Password changed');
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not change password',
            );
        } finally {
            setSavingPassword(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Your profile</DialogTitle>
                    <DialogDescription>
                        Update your personal details, profile picture and
                        password.
                    </DialogDescription>
                </DialogHeader>

                {/* Header card: big avatar, name, role pill, email, last login */}
                <div className="flex flex-col items-center gap-4 rounded-lg border bg-muted/30 p-4 sm:flex-row sm:items-start">
                    <div className="relative shrink-0">
                        <Avatar className="h-24 w-24 border-2 border-background shadow-sm">
                            {previewUrl && <AvatarImage src={previewUrl} alt="" />}
                            <AvatarFallback className="bg-primary/10 text-2xl text-primary">
                                {initials(user.name)}
                            </AvatarFallback>
                        </Avatar>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/png,image/jpeg,image/gif,image/webp"
                            hidden
                            onChange={handleAvatarSelected}
                        />
                        <button
                            type="button"
                            onClick={handlePickAvatar}
                            disabled={uploading}
                            className={cn(
                                'absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow transition-transform hover:scale-105',
                                uploading && 'opacity-60',
                            )}
                            title="Upload picture"
                            aria-label="Upload picture"
                        >
                            <Camera className="h-4 w-4" />
                        </button>
                    </div>
                    <div className="flex-1 text-center sm:text-left">
                        <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                            <h3 className="text-lg font-semibold leading-tight">
                                {user.name}
                            </h3>
                            <Badge
                                variant="outline"
                                className={cn(
                                    'gap-1 px-2 py-0.5 text-[11px] font-semibold',
                                    ROLE_BADGE_CLASSES[user.role] ||
                                        ROLE_BADGE_CLASSES.USER,
                                )}
                                title={`Your role: ${ROLE_LABELS[user.role] || user.role}`}
                            >
                                <Shield className="h-3 w-3" />
                                {ROLE_LABELS[user.role] || user.role}
                            </Badge>
                        </div>
                        {/* Compact info grid: role, position, email,
                            last login. Each row uses a tiny icon so
                            the user can scan it instantly. */}
                        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                            <div className="flex items-center gap-1.5 text-muted-foreground">
                                <Shield className="h-3 w-3" />
                                <dt className="font-medium">Role:</dt>
                                <dd className="text-foreground">
                                    {ROLE_LABELS[user.role] || user.role}
                                </dd>
                            </div>
                            {user.position && (
                                <div className="flex items-center gap-1.5 text-muted-foreground">
                                    <Briefcase className="h-3 w-3" />
                                    <dt className="font-medium">Position:</dt>
                                    <dd className="truncate text-foreground">
                                        {user.position}
                                    </dd>
                                </div>
                            )}
                            {user.businessUnit?.name && (
                                <div className="flex items-center gap-1.5 text-muted-foreground">
                                    <Building2 className="h-3 w-3" />
                                    <dt className="font-medium">
                                        Business unit:
                                    </dt>
                                    <dd className="truncate text-foreground">
                                        {user.businessUnit.name}
                                    </dd>
                                </div>
                            )}
                            <div className="flex items-center gap-1.5 text-muted-foreground">
                                <Mail className="h-3 w-3" />
                                <dt className="font-medium">Email:</dt>
                                <dd className="truncate text-foreground">
                                    {user.email}
                                </dd>
                            </div>
                            <div className="flex items-center gap-1.5 text-muted-foreground">
                                <Clock className="h-3 w-3" />
                                <dt className="font-medium">Last login:</dt>
                                <dd className="text-foreground">
                                    {formatStamp(user.lastLoginAt)}
                                </dd>
                            </div>
                        </dl>
                        {previewUrl && (
                            <div className="mt-2 flex justify-center sm:justify-start">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                                    onClick={handleRemoveAvatar}
                                    disabled={uploading}
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                    Remove picture
                                </Button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Personal time-tracking mini-dashboard (about you only) */}
                <ProfileStatsPanel />

                {/* Profile details form */}
                <form
                    onSubmit={handleSubmit(submitProfile)}
                    className="space-y-4"
                >
                    <div>
                        <h4 className="text-sm font-semibold">Details</h4>
                        <p className="text-xs text-muted-foreground">
                            Visible to teammates across the workspace.
                        </p>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label
                                htmlFor="profile-name"
                                className="flex items-center gap-1.5 text-xs"
                            >
                                <UserIcon className="h-3 w-3" /> Name
                            </Label>
                            <Input id="profile-name" {...register('name')} />
                            {errors.name && (
                                <p className="text-xs text-destructive">
                                    {errors.name.message}
                                </p>
                            )}
                        </div>
                        <div className="space-y-1.5">
                            <Label
                                htmlFor="profile-email"
                                className="flex items-center gap-1.5 text-xs"
                            >
                                <Mail className="h-3 w-3" /> Email
                            </Label>
                            <Input
                                id="profile-email"
                                type="email"
                                {...register('email')}
                            />
                            {errors.email && (
                                <p className="text-xs text-destructive">
                                    {errors.email.message}
                                </p>
                            )}
                        </div>
                        <div className="space-y-1.5">
                            <Label
                                htmlFor="profile-phone"
                                className="flex items-center gap-1.5 text-xs"
                            >
                                <Phone className="h-3 w-3" /> Phone
                            </Label>
                            <Input
                                id="profile-phone"
                                type="tel"
                                placeholder="+381 ..."
                                {...register('phone')}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label
                                htmlFor="profile-position"
                                className="flex items-center gap-1.5 text-xs"
                            >
                                <Briefcase className="h-3 w-3" /> Position
                            </Label>
                            <Input
                                id="profile-position"
                                placeholder="e.g. Senior Developer"
                                {...register('position')}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label className="flex items-center gap-1.5 text-xs">
                                <Briefcase className="h-3 w-3" /> Employee code
                            </Label>
                            {/* Admin-managed → read-only here. */}
                            <Input
                                value={user?.employeeCode || '—'}
                                readOnly
                                disabled
                                className="bg-muted/50"
                            />
                            <p className="text-[10px] text-muted-foreground">
                                Set by an administrator.
                            </p>
                        </div>
                    </div>

                    {/* Personal & business info — separated visually so
                        it reads like a "more about you" block instead
                        of being mixed in with the identity fields. */}
                    <Separator className="my-2" />
                    <div>
                        <h4 className="text-sm font-semibold">Personal &amp; business</h4>
                        <p className="text-xs text-muted-foreground">
                            Helps teammates know where you sit, who you report to,
                            and a bit about you.
                        </p>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {/* Country: free text but autocompletes against the
                            admin-maintained Country catalog used elsewhere
                            in the app (projects). */}
                        <div className="space-y-1.5">
                            <Label
                                htmlFor="profile-country"
                                className="flex items-center gap-1.5 text-xs"
                            >
                                <Globe2 className="h-3 w-3" /> Country
                            </Label>
                            <Input
                                id="profile-country"
                                list="profile-country-options"
                                placeholder="e.g. Serbia"
                                {...register('country')}
                            />
                            <datalist id="profile-country-options">
                                {countryOptions.map((c) => (
                                    <option key={c.id} value={c.name} />
                                ))}
                            </datalist>
                        </div>
                        <div className="space-y-1.5">
                            <Label
                                htmlFor="profile-currency"
                                className="flex items-center gap-1.5 text-xs"
                            >
                                <Coins className="h-3 w-3" /> Currency
                            </Label>
                            <Input
                                id="profile-currency"
                                list="profile-currency-options"
                                placeholder="e.g. EUR"
                                maxLength={20}
                                {...register('currency')}
                            />
                            {/* Common ISO 4217 tickers as a starting
                                point — the field stays free-text so we
                                don't need a separate admin catalog. */}
                            <datalist id="profile-currency-options">
                                {['EUR', 'USD', 'GBP', 'RSD', 'CHF', 'JPY', 'AUD', 'CAD'].map(
                                    (c) => (
                                        <option key={c} value={c} />
                                    ),
                                )}
                            </datalist>
                        </div>
                        <div className="space-y-1.5">
                            <Label
                                htmlFor="profile-teamleader"
                                className="flex items-center gap-1.5 text-xs"
                            >
                                <UserCog className="h-3 w-3" /> Team leader
                            </Label>
                            <Select
                                value={watch('teamLeaderId') || NONE_VALUE}
                                onValueChange={(v) =>
                                    setValue(
                                        'teamLeaderId',
                                        v === NONE_VALUE ? '' : v,
                                        { shouldDirty: true },
                                    )
                                }
                            >
                                <SelectTrigger
                                    id="profile-teamleader"
                                    className="h-9"
                                >
                                    <SelectValue placeholder="No team leader" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NONE_VALUE}>
                                        No team leader
                                    </SelectItem>
                                    {teamLeaderChoices.map((u) => (
                                        <SelectItem key={u.id} value={u.id}>
                                            {u.name}
                                            {u.position ? ` — ${u.position}` : ''}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label
                                htmlFor="profile-businessunit"
                                className="flex items-center gap-1.5 text-xs"
                            >
                                <Building2 className="h-3 w-3" /> Business unit
                                {!isAdmin && (
                                    <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                        Admin
                                    </span>
                                )}
                            </Label>
                            <Select
                                value={watch('businessUnitId') || NONE_VALUE}
                                onValueChange={(v) =>
                                    setValue(
                                        'businessUnitId',
                                        v === NONE_VALUE ? '' : v,
                                        { shouldDirty: true },
                                    )
                                }
                                disabled={!isAdmin}
                            >
                                <SelectTrigger
                                    id="profile-businessunit"
                                    className="h-9"
                                >
                                    <SelectValue
                                        placeholder={
                                            businessUnitOptions.length
                                                ? 'No business unit'
                                                : 'No business units yet'
                                        }
                                    />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NONE_VALUE}>
                                        No business unit
                                    </SelectItem>
                                    {businessUnitOptions.map((b) => (
                                        <SelectItem key={b.id} value={b.id}>
                                            {b.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {!isAdmin && (
                                <p className="text-[11px] text-muted-foreground">
                                    Ask an admin to assign or change your
                                    business unit.
                                </p>
                            )}
                        </div>
                        <div className="space-y-1.5 sm:col-span-2">
                            <Label
                                htmlFor="profile-about"
                                className="flex items-center gap-1.5 text-xs"
                            >
                                <Info className="h-3 w-3" /> About
                            </Label>
                            <Textarea
                                id="profile-about"
                                placeholder="A short bio so teammates know what you focus on…"
                                rows={3}
                                maxLength={2000}
                                {...register('about')}
                            />
                        </div>
                    </div>
                    <div className="flex justify-end">
                        <Button
                            type="submit"
                            size="sm"
                            disabled={savingProfile || !isDirty}
                        >
                            {savingProfile ? 'Saving…' : 'Save details'}
                        </Button>
                    </div>
                </form>

                <Separator />

                {/* Email notifications master switch. Lives between
                    the details form and the password form so it
                    catches the eye but doesn't disrupt the main
                    "edit your profile" flow. */}
                <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/30 p-3">
                    <div className="space-y-0.5">
                        <Label
                            htmlFor="profile-email-notifications"
                            className="text-sm font-semibold"
                        >
                            Email notifications
                        </Label>
                        <p className="text-xs text-muted-foreground">
                            When on, you receive emails for changes on
                            tasks and notes you participate in. The bell
                            badge always works regardless of this switch.
                        </p>
                    </div>
                    <Switch
                        id="profile-email-notifications"
                        checked={user.emailNotifications !== false}
                        onCheckedChange={handleEmailToggle}
                        disabled={savingEmailToggle}
                    />
                </div>

                {/* Password change form */}
                <form
                    onSubmit={handleSubmitPwd(submitPassword)}
                    className="space-y-4"
                >
                    <div>
                        <h4 className="flex items-center gap-1.5 text-sm font-semibold">
                            <KeyRound className="h-4 w-4" /> Change password
                        </h4>
                        <p className="text-xs text-muted-foreground">
                            You'll stay signed in on this device after the
                            change.
                        </p>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div className="space-y-1.5">
                            <Label htmlFor="profile-current" className="text-xs">
                                Current password
                            </Label>
                            <Input
                                id="profile-current"
                                type="password"
                                autoComplete="current-password"
                                {...registerPwd('currentPassword')}
                            />
                            {pwdErrors.currentPassword && (
                                <p className="text-xs text-destructive">
                                    {pwdErrors.currentPassword.message}
                                </p>
                            )}
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="profile-new" className="text-xs">
                                New password
                            </Label>
                            <Input
                                id="profile-new"
                                type="password"
                                autoComplete="new-password"
                                {...registerPwd('newPassword')}
                            />
                            {pwdErrors.newPassword && (
                                <p className="text-xs text-destructive">
                                    {pwdErrors.newPassword.message}
                                </p>
                            )}
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="profile-confirm" className="text-xs">
                                Confirm
                            </Label>
                            <Input
                                id="profile-confirm"
                                type="password"
                                autoComplete="new-password"
                                {...registerPwd('confirmPassword')}
                            />
                            {pwdErrors.confirmPassword && (
                                <p className="text-xs text-destructive">
                                    {pwdErrors.confirmPassword.message}
                                </p>
                            )}
                        </div>
                    </div>
                    <div className="flex justify-end">
                        <Button
                            type="submit"
                            size="sm"
                            variant="outline"
                            disabled={savingPassword}
                        >
                            {savingPassword ? 'Saving…' : 'Change password'}
                        </Button>
                    </div>
                </form>

                <DialogFooter>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => onOpenChange(false)}
                    >
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>

            <AvatarCropDialog
                open={Boolean(pendingCrop)}
                file={pendingCrop}
                onOpenChange={(o) => {
                    if (!o) setPendingCrop(null);
                }}
                onCropped={(croppedFile) => {
                    setPendingCrop(null);
                    uploadAvatarFile(croppedFile);
                }}
            />
        </Dialog>
    );
}
