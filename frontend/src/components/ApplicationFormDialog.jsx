// Create / edit dialog for an Application catalogue entry.
//
// At this layer the application captures only its long-lived identity:
// name, description, optional logo, and three free-form panels
// (dependencies / important behaviour / important notes). Everything
// release-specific — phase, target OS, POS terminal type, minimum
// version, importantNotes — lives on `AppRelease` and is set inside
// the Release dialog instead.
//
// `app` is null when creating, or the existing application when editing.
// `onSaved(app)` fires with the freshly-saved application payload.

import { useEffect, useRef, useState } from 'react';
import { Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';

import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { cn, resolveAssetUrl } from '@/lib/utils';

// Phase metadata is consumed by Applications + ApplicationDetail (chip
// colours, label lookup) so it lives here as the canonical export.
export const APPLICATION_PHASES = ['TEST', 'PILOT', 'APPROVED'];

export const PHASE_LABEL = {
    TEST: 'Test',
    PILOT: 'Pilot',
    APPROVED: 'Approved',
};

export const PHASE_BADGE_CLASS = {
    TEST:
        'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700/40 dark:bg-amber-950/40 dark:text-amber-300',
    PILOT:
        'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700/40 dark:bg-sky-950/40 dark:text-sky-300',
    APPROVED:
        'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700/40 dark:bg-emerald-950/40 dark:text-emerald-300',
};

const EMPTY = {
    name: '',
    packageName: '',
    description: '',
    dependencies: '',
    importantBehaviour: '',
    importantNotes: '',
};

function fromApp(app) {
    if (!app) return EMPTY;
    return {
        name: app.name || '',
        packageName: app.packageName || '',
        description: app.description || '',
        dependencies: app.dependencies || '',
        importantBehaviour: app.importantBehaviour || '',
        importantNotes: app.importantNotes || '',
    };
}

export function ApplicationFormDialog({ open, onOpenChange, app, onSaved }) {
    const isEdit = Boolean(app);
    const [form, setForm] = useState(EMPTY);
    const [submitting, setSubmitting] = useState(false);
    // Logo state lives separately from the form payload — we upload it
    // as multipart only when the user picks a new file. The existing
    // logo (if any) keeps showing in the preview until the user
    // explicitly removes it.
    const [logoFile, setLogoFile] = useState(null);
    const [logoPreview, setLogoPreview] = useState(null);
    const [removeExistingLogo, setRemoveExistingLogo] = useState(false);
    const fileInputRef = useRef(null);

    useEffect(() => {
        if (!open) return;
        setForm(fromApp(app));
        setLogoFile(null);
        setLogoPreview(null);
        setRemoveExistingLogo(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, [open, app]);

    const handleLogoPick = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024) {
            toast.error('Logo must be 3 MB or smaller.');
            e.target.value = '';
            return;
        }
        setLogoFile(file);
        setLogoPreview(URL.createObjectURL(file));
        setRemoveExistingLogo(false);
    };

    const submit = async (e) => {
        e.preventDefault();
        if (!form.name.trim()) {
            toast.error('Give the application a name.');
            return;
        }
        setSubmitting(true);
        try {
            const payload = {
                ...form,
                name: form.name.trim(),
            };
            // Backend treats blanks as nulls — strip them so we don't
            // accidentally send an empty string for an optional field.
            for (const k of Object.keys(payload)) {
                if (typeof payload[k] === 'string' && payload[k].trim() === '') {
                    payload[k] = null;
                }
            }
            const res = isEdit
                ? await api.patch(`/applications/${app.id}`, payload)
                : await api.post('/applications', payload);
            const saved = res.data?.application;

            // Logo handling — sequenced after the main save so we have
            // an id either way. Errors here surface as toasts but
            // don't roll back the application save.
            if (saved && logoFile) {
                try {
                    const fd = new FormData();
                    fd.append('logo', logoFile);
                    await api.post(`/applications/${saved.id}/logo`, fd, {
                        headers: { 'Content-Type': 'multipart/form-data' },
                    });
                } catch (err) {
                    toast.error(
                        err.response?.data?.error || 'Could not upload logo',
                    );
                }
            } else if (saved && removeExistingLogo && app?.logoUrl) {
                try {
                    await api.delete(`/applications/${saved.id}/logo`);
                } catch (err) {
                    toast.error(
                        err.response?.data?.error || 'Could not remove logo',
                    );
                }
            }

            toast.success(isEdit ? 'Application updated.' : 'Application created.');
            onSaved?.(saved);
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    (isEdit
                        ? 'Could not update application.'
                        : 'Could not create application.'),
            );
        } finally {
            setSubmitting(false);
        }
    };

    const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {isEdit ? 'Edit application' : 'New application'}
                    </DialogTitle>
                </DialogHeader>
                <form onSubmit={submit} className="space-y-4">
                    {/* --- Identity --------------------------------- */}
                    <div className="flex items-start gap-3">
                        <LogoSlot
                            preview={logoPreview}
                            existing={
                                !removeExistingLogo ? app?.logoUrl : null
                            }
                            name={form.name || 'Logo'}
                            onPick={() => fileInputRef.current?.click()}
                            onRemove={() => {
                                setLogoFile(null);
                                setLogoPreview(null);
                                if (app?.logoUrl) {
                                    setRemoveExistingLogo(true);
                                }
                                if (fileInputRef.current) {
                                    fileInputRef.current.value = '';
                                }
                            }}
                        />
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={handleLogoPick}
                        />
                        <div className="flex-1 space-y-3">
                            <Field label="Name" required>
                                <Input
                                    value={form.name}
                                    onChange={(e) => set('name', e.target.value)}
                                    autoFocus
                                    placeholder="e.g. POS Companion"
                                />
                            </Field>
                            <Field label="Package name">
                                <Input
                                    value={form.packageName}
                                    onChange={(e) =>
                                        set('packageName', e.target.value)
                                    }
                                    placeholder="e.g. com.company.poscompanion"
                                />
                            </Field>
                            <Field label="Description">
                                <Textarea
                                    value={form.description}
                                    onChange={(e) =>
                                        set('description', e.target.value)
                                    }
                                    rows={3}
                                    placeholder="Short summary of what the app does..."
                                />
                            </Field>
                        </div>
                    </div>

                    {/* --- Important info --------------------------- */}
                    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                        <div className="flex items-center justify-between">
                            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                Important info
                            </div>
                            <p className="text-[10px] text-muted-foreground/80">
                                Phase, OS, terminal &amp; version are tracked
                                per release.
                            </p>
                        </div>
                        <Field label="Dependencies">
                            <Textarea
                                value={form.dependencies}
                                onChange={(e) =>
                                    set('dependencies', e.target.value)
                                }
                                rows={3}
                                placeholder="Other apps, services, network requirements, hardware..."
                            />
                        </Field>
                        <Field label="Important behaviour">
                            <Textarea
                                value={form.importantBehaviour}
                                onChange={(e) =>
                                    set('importantBehaviour', e.target.value)
                                }
                                rows={3}
                                placeholder="Edge cases, expected runtime quirks, things to watch out for..."
                            />
                        </Field>
                        <Field label="Important notes">
                            <Textarea
                                value={form.importantNotes}
                                onChange={(e) =>
                                    set('importantNotes', e.target.value)
                                }
                                rows={3}
                                placeholder="Anything operators / installers / support need to know..."
                            />
                        </Field>
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={submitting}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={submitting}>
                            {submitting && (
                                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                            )}
                            {isEdit ? 'Save changes' : 'Create application'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function LogoSlot({ preview, existing, name, onPick, onRemove }) {
    const src = preview || (existing ? resolveAssetUrl(existing) : null);
    return (
        <div className="flex flex-col items-center gap-1.5">
            <button
                type="button"
                onClick={onPick}
                className={cn(
                    'group relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-lg border bg-muted transition-colors hover:border-primary',
                    src ? 'bg-white' : 'bg-muted',
                )}
                title="Upload a logo"
            >
                {src ? (
                    <img
                        src={src}
                        alt={`${name} logo`}
                        className="h-full w-full object-cover"
                    />
                ) : (
                    <div className="flex flex-col items-center gap-0.5 text-muted-foreground">
                        <Upload className="h-4 w-4" />
                        <span className="text-[10px]">Logo</span>
                    </div>
                )}
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 text-[10px] font-semibold uppercase text-white opacity-0 transition-opacity group-hover:opacity-100">
                    Change
                </span>
            </button>
            {(preview || existing) && (
                <button
                    type="button"
                    onClick={onRemove}
                    className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-destructive"
                >
                    <Trash2 className="h-3 w-3" />
                    Remove
                </button>
            )}
        </div>
    );
}

function Field({ label, required, children }) {
    return (
        <div className="space-y-1.5">
            <Label className="text-xs">
                {label}
                {required && <span className="ml-0.5 text-destructive">*</span>}
            </Label>
            {children}
        </div>
    );
}
