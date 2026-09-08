import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
    Camera,
    Check,
    ChevronDown,
    Info,
    ShieldAlert,
    Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { cn, initials, resolveAssetUrl } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import {
    CAPABILITY_GROUPS,
    ROLE_LABELS,
    roleDefaults,
} from '@/lib/capabilities';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { AvatarCropDialog } from '@/components/AvatarCropDialog';
import { MultiSelectDropdown } from '@/components/MultiSelectDropdown';
import { useBusinessUnits } from '@/lib/catalogs';

function buildSchema(isEdit) {
    return z.object({
        name: z.string().min(1, 'Name is required').max(100),
        email: z.string().email('Enter a valid email'),
        phone: z.string().max(40).optional().or(z.literal('')),
        position: z.string().max(120).optional().or(z.literal('')),
        employeeCode: z.string().max(60).optional().or(z.literal('')),
        password: isEdit
            ? z
                  .string()
                  .optional()
                  .or(z.literal(''))
                  .refine((v) => !v || v.length >= 8, 'Min 8 characters')
            : z.string().min(8, 'Min 8 characters'),
    });
}

export function UserFormDialog({
    open,
    onOpenChange,
    initialValues,
    onSubmit,
    submitting,
    onAvatarChanged,
}) {
    const isEdit = Boolean(initialValues?.id);
    const { user: currentUser } = useAuth();
    const isAdmin = currentUser?.role === 'ADMIN';
    const fileInputRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [role, setRole] = useState('REQUESTER');
    // Per-user capability override toggles. Only admins can set these;
    // we keep the state regardless so the UI logic is uniform.
    const [capabilities, setCapabilities] = useState([]);
    // Requester type: internal (employee, sees all) vs external
    // (org-scoped). Only meaningful for the REQUESTER role.
    const [external, setExternal] = useState(false);
    // External requester's organisation (client). 'none' = unset.
    const [clientId, setClientId] = useState('none');
    const [clients, setClients] = useState([]);
    // Internal requester's allowed ticket types (per-user).
    const [ticketTypes, setTicketTypes] = useState([]);
    const [userTypeIds, setUserTypeIds] = useState([]);
    // Holds the file the user just picked from disk while the crop
    // dialog is open. Once they confirm the crop, the resulting File
    // takes the same path the original file would have taken (immediate
    // upload for existing users, deferred for new ones).
    const [pendingCrop, setPendingCrop] = useState(null);
    // Organisation → Business unit the user belongs to. 'none' = unset.
    const { items: businessUnitOptions } = useBusinessUnits();
    const [businessUnitId, setBusinessUnitId] = useState('none');
    // Admin-managed: opt this user into the mandatory time-log reminder.
    const [timeLogMandatory, setTimeLogMandatory] = useState(false);

    const {
        register,
        handleSubmit,
        reset,
        formState: { errors },
    } = useForm({
        resolver: zodResolver(buildSchema(isEdit)),
        defaultValues: {
            name: '',
            email: '',
            phone: '',
            position: '',
            employeeCode: '',
            password: '',
        },
    });

    useEffect(() => {
        if (open) {
            reset({
                name: initialValues?.name ?? '',
                email: initialValues?.email ?? '',
                phone: initialValues?.phone ?? '',
                position: initialValues?.position ?? '',
                employeeCode: initialValues?.employeeCode ?? '',
                password: '',
            });
            setPreviewUrl(resolveAssetUrl(initialValues?.avatarUrl) || null);
            // New users default to Requester (lowest-privilege); editing an
            // existing user keeps their current role.
            setRole(initialValues?.role || 'REQUESTER');
            setCapabilities(
                Array.isArray(initialValues?.capabilities)
                    ? [...initialValues.capabilities]
                    : [],
            );
            setExternal(Boolean(initialValues?.external));
            setClientId(initialValues?.clientId || 'none');
            setUserTypeIds(initialValues?.ticketTypeIds || []);
            setBusinessUnitId(initialValues?.businessUnitId || 'none');
            setTimeLogMandatory(Boolean(initialValues?.timeLogMandatory));
            if (isAdmin) {
                api.get('/clients')
                    .then(({ data }) => setClients(data.clients || []))
                    .catch(() => setClients([]));
                api.get('/ticket-request-types', { params: { active: 1 } })
                    .then(({ data }) =>
                        setTicketTypes(data.requestTypes || []),
                    )
                    .catch(() => setTicketTypes([]));
            }
        }
    }, [open, initialValues, reset, isAdmin]);

    const toggleUserType = (id) =>
        setUserTypeIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );

    const submit = (values) => {
        const isExternalReq = role === 'REQUESTER' && external;
        if (isAdmin && isExternalReq && clientId === 'none') {
            toast.error('Pick an organization for an external requester.');
            return;
        }
        onSubmit({
            name: values.name,
            email: values.email,
            phone: values.phone || null,
            position: values.position || null,
            ...(values.password ? { password: values.password } : {}),
            ...(isAdmin
                ? {
                      // Employee code is admin-managed; only send it from the
                      // admin dialog (the backend also gates it to admins).
                      employeeCode: values.employeeCode || null,
                      timeLogMandatory,
                      role,
                      capabilities,
                      businessUnitId:
                          businessUnitId === 'none' ? null : businessUnitId,
                      external: role === 'REQUESTER' ? external : false,
                      clientId:
                          isExternalReq && clientId !== 'none'
                              ? clientId
                              : null,
                      // Per-user allowed types apply to internal requesters
                      // only; cleared otherwise.
                      ticketTypeIds:
                          role === 'REQUESTER' && !external ? userTypeIds : [],
                  }
                : {}),
        });
    };

    const roleDefaultsSet = useMemo(
        () => new Set(roleDefaults(role)),
        [role],
    );
    const toggleCapability = (key) => {
        setCapabilities((prev) =>
            prev.includes(key)
                ? prev.filter((k) => k !== key)
                : [...prev, key],
        );
    };

    const handlePickAvatar = () => fileInputRef.current?.click();

    const handleAvatarSelected = (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        // Always go through the cropper first; the resulting File then
        // takes the same path as the original would have.
        setPendingCrop(file);
    };

    const applyCroppedAvatar = async (file) => {
        if (!isEdit) {
            // New-user flow: stash the cropped file so it can be
            // uploaded after the user record is created.
            setPreviewUrl(URL.createObjectURL(file));
            onAvatarChanged?.({ pendingFile: file });
            return;
        }

        const fd = new FormData();
        fd.append('avatar', file);
        setUploading(true);
        try {
            const { data } = await api.post(
                `/users/${initialValues.id}/avatar`,
                fd,
                { headers: { 'Content-Type': 'multipart/form-data' } },
            );
            setPreviewUrl(resolveAssetUrl(data.user.avatarUrl));
            onAvatarChanged?.({ user: data.user });
            toast.success('Avatar updated');
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not upload avatar');
        } finally {
            setUploading(false);
        }
    };

    const handleRemoveAvatar = async () => {
        if (!isEdit) {
            setPreviewUrl(null);
            onAvatarChanged?.({ pendingFile: null });
            return;
        }
        if (!initialValues?.avatarUrl) {
            setPreviewUrl(null);
            return;
        }
        try {
            const { data } = await api.delete(`/users/${initialValues.id}/avatar`);
            setPreviewUrl(null);
            onAvatarChanged?.({ user: data.user });
        } catch {
            toast.error('Could not remove avatar');
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
                <DialogHeader>
                    <DialogTitle>{isEdit ? 'Edit user' : 'Create user'}</DialogTitle>
                    <DialogDescription>
                        {isEdit
                            ? 'Update profile details. Leave password blank to keep it unchanged.'
                            : 'Fill out the basic details. The user will be able to log in with the password you set.'}
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit(submit)} className="space-y-4">
                    <div className="flex items-center gap-4">
                        <Avatar className="h-16 w-16">
                            {previewUrl && <AvatarImage src={previewUrl} alt="" />}
                            <AvatarFallback className="bg-primary/10 text-primary">
                                {initials(initialValues?.name)}
                            </AvatarFallback>
                        </Avatar>
                        <div className="flex flex-col gap-2">
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                hidden
                                onChange={handleAvatarSelected}
                            />
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="gap-2"
                                onClick={handlePickAvatar}
                                disabled={uploading}
                            >
                                <Camera className="h-4 w-4" />
                                {uploading ? 'Uploading...' : 'Upload picture'}
                            </Button>
                            {previewUrl && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className={cn(
                                        'gap-2 text-destructive hover:text-destructive',
                                    )}
                                    onClick={handleRemoveAvatar}
                                >
                                    <Trash2 className="h-4 w-4" />
                                    Remove
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Entity 1 — profile (name, email, phone, position). */}
                    <div className="space-y-4 rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-3">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Profile
                        </p>
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <div className="space-y-2">
                            <Label htmlFor="name">Name</Label>
                            <Input id="name" {...register('name')} />
                            {errors.name && (
                                <p className="text-xs text-destructive">
                                    {errors.name.message}
                                </p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="email">Email</Label>
                            <Input id="email" type="email" {...register('email')} />
                            {errors.email && (
                                <p className="text-xs text-destructive">
                                    {errors.email.message}
                                </p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="phone">Phone</Label>
                            <Input
                                id="phone"
                                type="tel"
                                placeholder="+381 ..."
                                {...register('phone')}
                            />
                            {errors.phone && (
                                <p className="text-xs text-destructive">
                                    {errors.phone.message}
                                </p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="position">Position</Label>
                            <Input
                                id="position"
                                placeholder="e.g. Project Manager"
                                {...register('position')}
                            />
                            {errors.position && (
                                <p className="text-xs text-destructive">
                                    {errors.position.message}
                                </p>
                            )}
                        </div>
                        {isAdmin && (
                            <div className="space-y-2">
                                <Label htmlFor="employeeCode">
                                    Employee code
                                </Label>
                                <Input
                                    id="employeeCode"
                                    placeholder="e.g. EMP-042"
                                    {...register('employeeCode')}
                                />
                                <p className="text-[11px] text-muted-foreground">
                                    Used in the logged-time export.
                                </p>
                            </div>
                        )}
                        {isAdmin && (
                            <div className="space-y-1.5 sm:col-span-2">
                                <label className="flex items-start gap-2.5">
                                    <input
                                        type="checkbox"
                                        className="mt-0.5 h-4 w-4"
                                        checked={timeLogMandatory}
                                        onChange={(e) =>
                                            setTimeLogMandatory(
                                                e.target.checked,
                                            )
                                        }
                                    />
                                    <span className="text-sm">
                                        <span className="font-medium">
                                            Time logging mandatory
                                        </span>
                                        <span className="block text-[11px] text-muted-foreground">
                                            Reminds this user to keep their
                                            working log filled per the Admin →
                                            Time logging policy.
                                        </span>
                                    </span>
                                </label>
                            </div>
                        )}
                        <div className="space-y-2">
                            <Label htmlFor="password">
                                {isEdit ? 'New password' : 'Password'}
                            </Label>
                            <Input
                                id="password"
                                type="password"
                                placeholder={isEdit ? 'Leave blank to keep' : ''}
                                autoComplete="new-password"
                                {...register('password')}
                            />
                            {errors.password && (
                                <p className="text-xs text-destructive">
                                    {errors.password.message}
                                </p>
                            )}
                        </div>
                    </div>
                    </div>

                    {/* Entity 2 — role & access. */}
                    {isAdmin && (
                        <div className="space-y-2 rounded-lg border border-amber-500/15 bg-amber-500/5 p-3">
                            <div className="grid gap-4 sm:grid-cols-2">
                                {/* Left: role, and requester type beneath it. */}
                                <div className="space-y-3">
                                    <div className="space-y-2">
                                        <Label htmlFor="role">Role</Label>
                                        <Select
                                            value={role}
                                            onValueChange={setRole}
                                        >
                                            <SelectTrigger id="role">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="USER">
                                                    {ROLE_LABELS.USER}
                                                </SelectItem>
                                                <SelectItem value="APP_MODERATOR">
                                                    {ROLE_LABELS.APP_MODERATOR}
                                                </SelectItem>
                                                <SelectItem value="MANAGER">
                                                    {ROLE_LABELS.MANAGER}
                                                </SelectItem>
                                                <SelectItem value="ADMIN">
                                                    {ROLE_LABELS.ADMIN}
                                                </SelectItem>
                                                <SelectItem value="REQUESTER">
                                                    {ROLE_LABELS.REQUESTER}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="businessUnit">
                                            Business unit
                                        </Label>
                                        <Select
                                            value={businessUnitId}
                                            onValueChange={setBusinessUnitId}
                                        >
                                            <SelectTrigger id="businessUnit">
                                                <SelectValue placeholder="No business unit" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">
                                                    No business unit
                                                </SelectItem>
                                                {businessUnitOptions.map((b) => (
                                                    <SelectItem
                                                        key={b.id}
                                                        value={b.id}
                                                    >
                                                        {b.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    {role === 'REQUESTER' && (
                                        <div className="space-y-2">
                                            <Label htmlFor="reqType">
                                                Requester type
                                            </Label>
                                            <Select
                                                value={
                                                    external
                                                        ? 'external'
                                                        : 'internal'
                                                }
                                                onValueChange={(v) =>
                                                    setExternal(v === 'external')
                                                }
                                            >
                                                <SelectTrigger id="reqType">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="internal">
                                                        Internal (sees all
                                                        tickets)
                                                    </SelectItem>
                                                    <SelectItem value="external">
                                                        External (their org only)
                                                    </SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    )}
                                </div>
                                {/* Right: ticket types (internal) or the
                                    organization (external). */}
                                {role === 'REQUESTER' && (
                                    <div className="space-y-2">
                                        {external ? (
                                            <>
                                                <Label htmlFor="clientId">
                                                    Organization{' '}
                                                    <span className="text-rose-500">
                                                        *
                                                    </span>
                                                </Label>
                                                <Select
                                                    value={clientId}
                                                    onValueChange={setClientId}
                                                >
                                                    <SelectTrigger id="clientId">
                                                        <SelectValue placeholder="Select an organization" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="none">
                                                            Select an
                                                            organization…
                                                        </SelectItem>
                                                        {clients.map((c) => (
                                                            <SelectItem
                                                                key={c.id}
                                                                value={c.id}
                                                            >
                                                                {c.name}
                                                            </SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                                <p className="text-[11px] text-muted-foreground">
                                                    Sees only their own tickets
                                                    plus this organization&apos;s;
                                                    their tickets auto-tag to it.
                                                </p>
                                            </>
                                        ) : (
                                            <>
                                                <Label>
                                                    Ticket types this user can
                                                    raise
                                                </Label>
                                                <MultiSelectDropdown
                                                    options={ticketTypes.map(
                                                        (t) => ({
                                                            id: t.id,
                                                            label: t.name,
                                                        }),
                                                    )}
                                                    value={userTypeIds}
                                                    onChange={setUserTypeIds}
                                                    placeholder="Select ticket types…"
                                                    emptyText="No active ticket types defined yet."
                                                />
                                                <p className="text-[11px] text-muted-foreground">
                                                    Internal requester — pick the
                                                    type cards they may raise.
                                                    None picked means they
                                                    can&apos;t raise anything.
                                                </p>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                <strong>Admins</strong> can manage users,
                                projects and settings.{' '}
                                <strong>Managers</strong> can create, edit and
                                delete tasks and subtasks inside projects they
                                are part of (but cannot create, edit, close or
                                delete projects). <strong>App moderators</strong>{' '}
                                are like Users for projects but can manage the
                                application catalog and post comments on
                                releases. <strong>Users</strong> can comment,
                                upload files and update their own assignments
                                only.
                            </p>
                        </div>
                    )}

                    {isAdmin && (
                        <CapabilityEditor
                            role={role}
                            roleDefaultsSet={roleDefaultsSet}
                            capabilities={capabilities}
                            onToggle={toggleCapability}
                        />
                    )}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={submitting}>
                            {submitting
                                ? 'Saving...'
                                : isEdit
                                  ? 'Save changes'
                                  : 'Create user'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>

            <AvatarCropDialog
                open={Boolean(pendingCrop)}
                file={pendingCrop}
                onOpenChange={(o) => {
                    if (!o) setPendingCrop(null);
                }}
                onCropped={(croppedFile) => {
                    setPendingCrop(null);
                    applyCroppedAvatar(croppedFile);
                }}
            />
        </Dialog>
    );
}

// ---------------------------------------------------------------------------
// Capability override editor — admin-only.
//
// Admins can grant fine-grained per-user capabilities on top of the
// role's defaults. We render each capability group as its own little
// card with checkboxes; capabilities the role already grants are still
// visible (and ticked) but disabled, with a "via role" label. That way
// admins always see the full effective set without having to remember
// the role-default mapping.
// ---------------------------------------------------------------------------
function CapabilityEditor({
    role,
    roleDefaultsSet,
    capabilities,
    onToggle,
}) {
    // Each capability group collapses; all start closed to save space.
    const [openGroups, setOpenGroups] = useState(() => new Set());
    const toggleGroup = (id) =>
        setOpenGroups((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    if (role === 'ADMIN') {
        return (
            <div className="rounded-md border bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                <Info className="-mt-0.5 mr-1 inline h-3.5 w-3.5" />
                Admins always have every capability. Per-user overrides
                only apply to non-admin roles.
            </div>
        );
    }
    return (
        <div className="space-y-3">
            <div>
                <h4 className="text-sm font-semibold">
                    Capability overrides
                </h4>
                <p className="text-xs text-muted-foreground">
                    Hand out specific powers without promoting the user
                    to a higher role. Items already granted by the
                    selected role are shown ticked but disabled.
                </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
                {CAPABILITY_GROUPS.map((group) => {
                    const isOpen = openGroups.has(group.id);
                    const grantedCount = group.items.filter(
                        (i) =>
                            roleDefaultsSet.has(i.key) ||
                            capabilities.includes(i.key),
                    ).length;
                    return (
                    <div
                        key={group.id}
                        className="flex flex-col rounded-md border bg-muted/30"
                    >
                        <button
                            type="button"
                            onClick={() => toggleGroup(group.id)}
                            className="flex w-full items-center justify-between gap-2 p-3 text-left"
                        >
                            <div className="min-w-0">
                                <div className="text-xs font-semibold uppercase tracking-wide">
                                    {group.label}
                                </div>
                                <p className="truncate text-xs text-muted-foreground">
                                    {group.description}
                                </p>
                            </div>
                            <span className="flex shrink-0 items-center gap-1.5">
                                {grantedCount > 0 && (
                                    <span className="rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">
                                        {grantedCount}
                                    </span>
                                )}
                                <ChevronDown
                                    className={cn(
                                        'h-4 w-4 text-muted-foreground transition-transform',
                                        isOpen && 'rotate-180',
                                    )}
                                />
                            </span>
                        </button>
                        {isOpen && (
                        <ul className="space-y-1.5 px-3 pb-3">
                            {group.items.map((item) => {
                                const fromRole = roleDefaultsSet.has(
                                    item.key,
                                );
                                const checkedExplicit =
                                    capabilities.includes(item.key);
                                const effective = fromRole || checkedExplicit;
                                return (
                                    <li
                                        key={item.key}
                                        className="flex items-start gap-2 rounded px-1 py-1"
                                    >
                                        <input
                                            id={`cap-${item.key}`}
                                            type="checkbox"
                                            className="mt-0.5 h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
                                            checked={effective}
                                            disabled={fromRole}
                                            onChange={() =>
                                                onToggle(item.key)
                                            }
                                        />
                                        <label
                                            htmlFor={`cap-${item.key}`}
                                            className={cn(
                                                'flex-1 cursor-pointer select-none text-xs',
                                                fromRole && 'cursor-default',
                                            )}
                                        >
                                            <div className="flex flex-wrap items-center gap-1">
                                                <span className="font-medium text-foreground">
                                                    {item.label}
                                                </span>
                                                {fromRole && (
                                                    <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
                                                        via role
                                                    </span>
                                                )}
                                                {item.risk === 'danger' && (
                                                    <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-destructive">
                                                        <ShieldAlert className="h-2.5 w-2.5" />
                                                        destructive
                                                    </span>
                                                )}
                                                {item.risk === 'sensitive' && (
                                                    <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-300">
                                                        sensitive
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-[11px] text-muted-foreground">
                                                {item.hint}
                                            </div>
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                        )}
                    </div>
                    );
                })}
            </div>
        </div>
    );
}
