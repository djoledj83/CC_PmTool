// Create / edit dialog for an AppRelease.
//
// A release captures everything that varies between builds of the same
// application:
//   - version (free-text), release date, "what was fixed" body
//   - pipeline phase (Test / Pilot / Approved). The backend stamps the
//     transition timestamp the first time a release lands in each phase.
//   - target OS (multi-select, admin catalogue)
//   - POS terminal type (multi-select, admin catalogue)
//   - minimum version
//   - importantNotes — release-specific gotchas, mirroring the
//     application-level Important notes panel
//   - optional release artifact (zip / installer)
//
// The artifact uploads after the main save so we always have a release
// id to attach to.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Check,
    ChevronDown,
    Download,
    Loader2,
    Paperclip,
    Trash2,
    X,
} from 'lucide-react';
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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import {
    useAppOsOptions,
    useAppPosTerminalOptions,
} from '@/lib/catalogs';
import { cn, resolveAssetUrl } from '@/lib/utils';

import {
    APPLICATION_PHASES,
    PHASE_LABEL,
} from '@/components/ApplicationFormDialog';

const EMPTY = {
    version: '',
    releaseDate: '',
    phase: 'TEST',
    targetOs: [],
    posTerminalType: [],
    minimumVersion: '',
    fixes: '',
    importantNotes: '',
};

function fromRelease(release) {
    if (!release) return EMPTY;
    return {
        version: release.version || '',
        // <input type="date"> needs YYYY-MM-DD.
        releaseDate: release.releaseDate
            ? new Date(release.releaseDate).toISOString().slice(0, 10)
            : '',
        phase: release.phase || 'TEST',
        targetOs: Array.isArray(release.targetOs) ? [...release.targetOs] : [],
        posTerminalType: Array.isArray(release.posTerminalType)
            ? [...release.posTerminalType]
            : [],
        minimumVersion: release.minimumVersion || '',
        fixes: release.fixes || '',
        importantNotes: release.importantNotes || '',
    };
}

export function ReleaseFormDialog({
    open,
    onOpenChange,
    applicationId,
    release,
    // When false the Phase select is locked to TEST. The backend
    // already enforces this for users without the
    // `app:phase:declare` capability — the silent force-to-TEST on
    // save was confusing because the form let users PICK a value
    // that would then be discarded. Defaulting to true preserves
    // existing behaviour for callers that don't pass the prop yet.
    canDeclarePhase = true,
    onSaved,
}) {
    const isEdit = Boolean(release);
    const [form, setForm] = useState(EMPTY);
    const [submitting, setSubmitting] = useState(false);

    // Optional release artifact (see header comment for the lifecycle).
    const [pendingFile, setPendingFile] = useState(null);
    const [removeExisting, setRemoveExisting] = useState(false);
    const fileInputRef = useRef(null);

    const { items: osOptions } = useAppOsOptions();
    const { items: terminalOptions } = useAppPosTerminalOptions();

    useEffect(() => {
        if (!open) return;
        setForm(fromRelease(release));
        setPendingFile(null);
        setRemoveExisting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, [open, release]);

    const set = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

    const onPickFile = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 50 * 1024 * 1024) {
            toast.error('Release file must be 50 MB or smaller.');
            e.target.value = '';
            return;
        }
        setPendingFile(file);
        setRemoveExisting(false);
    };

    const submit = async (e) => {
        e.preventDefault();
        if (!form.version.trim()) {
            toast.error('Version is required (e.g. 1.2.3).');
            return;
        }
        setSubmitting(true);
        try {
            const payload = {
                version: form.version.trim(),
                phase: form.phase || 'TEST',
                targetOs: form.targetOs,
                posTerminalType: form.posTerminalType,
                minimumVersion: form.minimumVersion.trim() || null,
                fixes: form.fixes.trim() || null,
                importantNotes: form.importantNotes.trim() || null,
                releaseDate: form.releaseDate
                    ? new Date(`${form.releaseDate}T00:00:00.000Z`).toISOString()
                    : null,
            };
            const res = isEdit
                ? await api.patch(
                      `/applications/${applicationId}/releases/${release.id}`,
                      payload,
                  )
                : await api.post(
                      `/applications/${applicationId}/releases`,
                      payload,
                  );
            const saved = res.data?.release;

            if (saved && pendingFile) {
                try {
                    const fd = new FormData();
                    fd.append('file', pendingFile);
                    await api.post(
                        `/applications/${applicationId}/releases/${saved.id}/file`,
                        fd,
                        {
                            headers: {
                                'Content-Type': 'multipart/form-data',
                            },
                        },
                    );
                } catch (err) {
                    toast.error(
                        err.response?.data?.error ||
                            'Could not attach release file.',
                    );
                }
            } else if (saved && removeExisting && release?.fileUrl) {
                try {
                    await api.delete(
                        `/applications/${applicationId}/releases/${saved.id}/file`,
                    );
                } catch (err) {
                    toast.error(
                        err.response?.data?.error ||
                            'Could not remove release file.',
                    );
                }
            }

            toast.success(isEdit ? 'Release updated.' : 'Release added.');
            onSaved?.(saved);
        } catch (err) {
            toast.error(
                err.response?.data?.error ||
                    (isEdit
                        ? 'Could not update release.'
                        : 'Could not add release.'),
            );
        } finally {
            setSubmitting(false);
        }
    };

    const showExistingChip =
        isEdit && release?.fileName && !removeExisting && !pendingFile;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>
                        {isEdit ? 'Edit release' : 'New release'}
                    </DialogTitle>
                </DialogHeader>
                <form onSubmit={submit} className="space-y-4">
                    {/* --- Version + date + phase ---------------------- */}
                    <div className="grid gap-3 sm:grid-cols-[1fr_160px_140px]">
                        <Field label="Version" required>
                            <Input
                                value={form.version}
                                onChange={(e) => set('version', e.target.value)}
                                placeholder="1.2.3"
                                autoFocus
                            />
                        </Field>
                        <Field label="Release date">
                            <Input
                                type="date"
                                value={form.releaseDate}
                                onChange={(e) =>
                                    set('releaseDate', e.target.value)
                                }
                            />
                        </Field>
                        <Field label="Phase">
                            <Select
                                value={form.phase}
                                onValueChange={(v) => set('phase', v)}
                                disabled={!canDeclarePhase}
                            >
                                <SelectTrigger
                                    title={
                                        canDeclarePhase
                                            ? undefined
                                            : "You don't have permission to promote a release past Test. The backend will save this as Test regardless of the picker."
                                    }
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {APPLICATION_PHASES.map((p) => (
                                        <SelectItem key={p} value={p}>
                                            {PHASE_LABEL[p]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {!canDeclarePhase && (
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                    Locked to Test — you need the
                                    "Declare release phase" permission to
                                    promote releases.
                                </p>
                            )}
                        </Field>
                    </div>

                    {/* --- Targets (multi-select) + min version ----- */}
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Target OS">
                            <MultiCheckSelect
                                placeholder="Pick OS targets"
                                options={osOptions}
                                values={form.targetOs}
                                onChange={(v) => set('targetOs', v)}
                                emptyHint="No OS options yet — add some in Templates → Apps."
                            />
                        </Field>
                        <Field label="POS terminal type">
                            <MultiCheckSelect
                                placeholder="Pick terminal types"
                                options={terminalOptions}
                                values={form.posTerminalType}
                                onChange={(v) => set('posTerminalType', v)}
                                emptyHint="No terminal options yet — add some in Templates → Apps."
                            />
                        </Field>
                    </div>

                    <Field label="Minimum version">
                        <Input
                            value={form.minimumVersion}
                            onChange={(e) =>
                                set('minimumVersion', e.target.value)
                            }
                            placeholder="e.g. 1.0.0 — required runtime / OS / firmware version"
                        />
                    </Field>

                    {/* --- What was fixed --------------------------- */}
                    <Field label="What was fixed / changed">
                        <Textarea
                            value={form.fixes}
                            onChange={(e) => set('fixes', e.target.value)}
                            rows={5}
                            placeholder={
                                'One bullet per fix or change.\n- Fixed receipt printer hang on cold start\n- Updated card reader firmware compatibility'
                            }
                        />
                    </Field>

                    {/* --- Important notes -------------------------- */}
                    <Field label="Important notes">
                        <Textarea
                            value={form.importantNotes}
                            onChange={(e) =>
                                set('importantNotes', e.target.value)
                            }
                            rows={3}
                            placeholder="Release-specific gotchas, rollback caveats, deploy order..."
                        />
                    </Field>

                    {/* --- Optional artifact ------------------------ */}
                    <Field label="Release artifact (optional)">
                        <input
                            ref={fileInputRef}
                            type="file"
                            className="hidden"
                            onChange={onPickFile}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <Paperclip className="mr-1.5 h-3.5 w-3.5" />
                                {pendingFile || showExistingChip
                                    ? 'Replace file'
                                    : 'Attach file'}
                            </Button>
                            {pendingFile && (
                                <FileChip
                                    label={pendingFile.name}
                                    onRemove={() => {
                                        setPendingFile(null);
                                        if (fileInputRef.current) {
                                            fileInputRef.current.value = '';
                                        }
                                    }}
                                />
                            )}
                            {showExistingChip && (
                                <FileChip
                                    label={release.fileName}
                                    muted
                                    downloadUrl={resolveAssetUrl(release.fileUrl)}
                                    downloadName={release.fileName}
                                    onRemove={() => setRemoveExisting(true)}
                                    removeLabel="Remove"
                                    removeIcon={Trash2}
                                />
                            )}
                            {removeExisting && release?.fileName && (
                                <span className="text-xs italic text-muted-foreground">
                                    Existing file will be removed on save.
                                </span>
                            )}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                            Up to 50 MB. Use this for installers,
                            changelogs, signed APKs, etc.
                        </p>
                    </Field>

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
                            {isEdit ? 'Save changes' : 'Add release'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

// ---------------------------------------------------------------------------
// Multi-select dropdown with check-mark items.
// ---------------------------------------------------------------------------
//
// Uses the existing DropdownMenu primitive so the styling matches every
// other dropdown in the app. Each option renders as a checkbox row.
// Selected values render as small chips inside the trigger so the
// current selection is visible without opening the menu.

function MultiCheckSelect({
    placeholder,
    options,
    values,
    onChange,
    emptyHint,
}) {
    const valueSet = useMemo(() => new Set(values), [values]);
    const selectedLabels = useMemo(
        () =>
            values
                .map((v) => {
                    const opt = options.find((o) => o.name === v);
                    return opt ? opt.name : v;
                })
                .slice(0, 4),
        [values, options],
    );

    const toggle = (name) => {
        const next = new Set(values);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        onChange(Array.from(next));
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    className={cn(
                        'h-auto min-h-9 w-full justify-between gap-2 px-3 text-sm font-normal',
                        values.length > 0 && 'border-primary/40 bg-primary/5',
                    )}
                >
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1 text-left">
                        {values.length === 0 ? (
                            <span className="text-muted-foreground">
                                {placeholder}
                            </span>
                        ) : (
                            <>
                                {selectedLabels.map((label) => (
                                    <span
                                        key={label}
                                        className="inline-flex items-center gap-1 rounded-full border bg-card px-1.5 py-0.5 text-[11px]"
                                    >
                                        {label}
                                        <span
                                            role="button"
                                            tabIndex={-1}
                                            onPointerDown={(e) => {
                                                // Prevent the dropdown
                                                // from opening when the
                                                // user clicks the chip's
                                                // remove icon.
                                                e.preventDefault();
                                                e.stopPropagation();
                                                toggle(label);
                                            }}
                                            className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                                            aria-label={`Remove ${label}`}
                                        >
                                            <X className="h-3 w-3" />
                                        </span>
                                    </span>
                                ))}
                                {values.length > selectedLabels.length && (
                                    <span className="text-[11px] text-muted-foreground">
                                        +{values.length - selectedLabels.length}{' '}
                                        more
                                    </span>
                                )}
                            </>
                        )}
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel className="text-xs">
                    {placeholder}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {options.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        {emptyHint || 'No options available.'}
                    </p>
                ) : (
                    <div className="max-h-64 overflow-y-auto py-1">
                        {options.map((opt) => {
                            const checked = valueSet.has(opt.name);
                            return (
                                <button
                                    key={opt.id}
                                    type="button"
                                    onClick={() => toggle(opt.name)}
                                    className="flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-accent focus:bg-accent"
                                >
                                    <span
                                        className={cn(
                                            'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                            checked
                                                ? 'border-primary bg-primary text-primary-foreground'
                                                : 'border-muted-foreground/40',
                                        )}
                                    >
                                        {checked && (
                                            <Check className="h-3 w-3" />
                                        )}
                                    </span>
                                    <span className="truncate">{opt.name}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
                {values.length > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <button
                            type="button"
                            onClick={() => onChange([])}
                            className="flex w-full items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent"
                        >
                            <X className="h-3.5 w-3.5" />
                            Clear all
                        </button>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function FileChip({
    label,
    onRemove,
    muted = false,
    removeLabel,
    removeIcon: RemoveIcon = X,
    downloadUrl,
    downloadName,
}) {
    return (
        <span
            className={
                'inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card px-2 py-1 text-xs ' +
                (muted ? 'text-muted-foreground' : '')
            }
        >
            <Paperclip className="h-3 w-3" />
            <span className="max-w-[180px] truncate" title={label}>
                {label}
            </span>
            {downloadUrl && (
                <a
                    href={downloadUrl}
                    download={downloadName || label || 'release-artifact'}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-0.5 inline-flex items-center gap-0.5 text-muted-foreground hover:text-primary"
                    title="Download"
                    onClick={(e) => e.stopPropagation()}
                >
                    <Download className="h-3 w-3" />
                </a>
            )}
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    className="ml-0.5 inline-flex items-center gap-0.5 text-muted-foreground hover:text-destructive"
                    title={removeLabel || 'Remove'}
                >
                    <RemoveIcon className="h-3 w-3" />
                </button>
            )}
        </span>
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
