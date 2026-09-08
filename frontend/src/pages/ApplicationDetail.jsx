// /applications/:id — single-application view.
//
// Layout: a hero card with logo + identity + key metadata, a sidebar of
// long-form panels (description / dependencies / important behaviour /
// important notes), and a release timeline. Each release expands to
// show the "what was fixed" body, an optional artifact, and a notes
// thread mirroring the Project Notes pattern.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
    ArrowLeft,
    AlertTriangle,
    Calendar,
    CheckCircle2,
    ChevronsLeft,
    ChevronsRight,
    Clock,
    Download,
    Edit3,
    FileText,
    History,
    Layers,
    Loader2,
    MapPin,
    MessageSquarePlus,
    Pencil,
    Plus,
    Rocket,
    Smartphone,
    Star,
    StickyNote,
    Tag,
    Trash2,
    Upload,
    Undo2,
    UserCircle2,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

import { TopBar } from '@/components/TopBar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/lib/api';
import { cn, resolveAssetUrl } from '@/lib/utils';
import { PinButton } from '@/components/PinButton';
import { usePins } from '@/hooks/usePins';

import {
    ApplicationFormDialog,
    PHASE_BADGE_CLASS,
    PHASE_LABEL,
} from '@/components/ApplicationFormDialog';
import { ReleaseFormDialog } from '@/components/ReleaseFormDialog';
import { CAPABILITIES, hasCapability } from '@/lib/capabilities';

export default function ApplicationDetail() {
    const { id } = useParams();
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    // Granular capability flags. Each control on this page maps to a
    // specific capability that an admin can hand out via the user
    // edit dialog. We keep the coarser `canEdit` flag for spots that
    // genuinely need "user can do SOMETHING on this app" (e.g. the
    // outermost toolbar visibility), but every individual button is
    // now gated by its own flag so the UI matches the backend's
    // already-cap-aware checks in `routes/applications.js`.
    const canCreateApp =
        isAdmin || hasCapability(user, CAPABILITIES.APP_CREATE);
    const canEditApp = isAdmin || hasCapability(user, CAPABILITIES.APP_EDIT);
    const canDeleteApp =
        isAdmin || hasCapability(user, CAPABILITIES.APP_DELETE);
    const canCreateRelease =
        isAdmin || hasCapability(user, CAPABILITIES.APP_RELEASE_CREATE);
    const canEditRelease =
        isAdmin || hasCapability(user, CAPABILITIES.APP_RELEASE_EDIT);
    const canDeleteRelease =
        isAdmin || hasCapability(user, CAPABILITIES.APP_RELEASE_DELETE);
    // Whether this user can declare a release's pipeline phase
    // (Test / Pilot / Approved). Without this capability the backend
    // silently forces TEST regardless of what the form sent — so we
    // mirror that on the frontend by locking the phase select.
    const canDeclarePhase = hasCapability(
        user,
        CAPABILITIES.APP_PHASE_DECLARE,
    );

    const [app, setApp] = useState(null);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(false);
    const [creatingRelease, setCreatingRelease] = useState(false);
    const [editingRelease, setEditingRelease] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(null);
    // Per-release expansion. Default: most-recent release expanded.
    const [expanded, setExpanded] = useState(() => new Set());
    // Active body tab — Releases (the existing detailed list) vs the
    // new Timeline view that surfaces production deployments as
    // horizontally-scrollable cards.
    const [tab, setTab] = useState('releases');
    // Personal "prod target" flag — backed by the shared UserPin
    // table (kind=RELEASE_PROD). Lets each user pin the release
    // they consider the current production build, so the timeline
    // visually pops it out and downstream features (compare hints,
    // newer-than-current changelog) can lean on it.
    const releasePinHook = usePins('RELEASE_PROD');

    const reload = useCallback(async () => {
        try {
            const { data } = await api.get(`/applications/${id}`);
            setApp(data?.application || null);
            setExpanded((prev) => {
                if (prev.size > 0) return prev;
                const next = new Set();
                const first = data?.application?.releases?.[0]?.id;
                if (first) next.add(first);
                return next;
            });
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not load application',
            );
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        reload();
    }, [reload]);

    const onDeleteApp = async () => {
        try {
            await api.delete(`/applications/${id}`);
            toast.success('Application deleted.');
            window.history.back();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not delete application',
            );
        }
    };

    const onDeleteRelease = async (releaseId) => {
        try {
            await api.delete(`/applications/${id}/releases/${releaseId}`);
            toast.success('Release deleted.');
            reload();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete release');
        }
    };

    if (loading) {
        return (
            <>
                <TopBar title="Application" />
                <main className="flex-1 overflow-auto bg-muted/20 p-4">
                    <Card>
                        <CardContent className="p-6 text-sm text-muted-foreground">
                            Loading application...
                        </CardContent>
                    </Card>
                </main>
            </>
        );
    }

    if (!app) {
        return (
            <>
                <TopBar title="Application" />
                <main className="flex-1 overflow-auto bg-muted/20 p-4">
                    <Card>
                        <CardContent className="p-6 text-sm text-muted-foreground">
                            Application not found.
                        </CardContent>
                    </Card>
                </main>
            </>
        );
    }

    return (
        <>
            <TopBar title={app.name} />
            <main className="flex-1 overflow-auto bg-muted/20">
                <div className="flex w-full flex-col gap-4 p-3 sm:p-6">
                    <div>
                        <Link
                            to="/applications"
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                            <ArrowLeft className="h-3 w-3" />
                            All applications
                        </Link>
                    </div>

                    {/* --- Hero ------------------------------------- */}
                    <div className="relative overflow-hidden rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="flex flex-1 items-start gap-4">
                                <Logo
                                    url={app.logoUrl}
                                    name={app.name}
                                    size="lg"
                                />
                                <div className="min-w-0 flex-1 space-y-2">
                                    <h1 className="text-2xl font-semibold tracking-tight">
                                        {app.name}
                                    </h1>
                                    {app.packageName && (
                                        <p className="font-mono text-xs text-muted-foreground">
                                            {app.packageName}
                                        </p>
                                    )}
                                    {app.description && (
                                        <p className="max-w-3xl text-sm text-muted-foreground">
                                            {app.description}
                                        </p>
                                    )}
                                    <div className="flex flex-wrap gap-1.5 pt-1 text-[11px] text-muted-foreground">
                                        <Chip
                                            icon={FileText}
                                            label={`${
                                                app.releases?.length ?? 0
                                            } release${
                                                (app.releases?.length ?? 0) ===
                                                1
                                                    ? ''
                                                    : 's'
                                            }`}
                                        />
                                    </div>
                                </div>
                            </div>
                            {(canEditApp || canDeleteApp) && (
                                <div className="flex flex-wrap gap-2">
                                    {canEditApp && (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => setEditing(true)}
                                        >
                                            <Edit3 className="mr-1.5 h-3.5 w-3.5" />
                                            Edit
                                        </Button>
                                    )}
                                    {canDeleteApp && (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                            onClick={() =>
                                                setConfirmDelete({
                                                    type: 'app',
                                                })
                                            }
                                        >
                                            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                                            Delete
                                        </Button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* --- Body tabs -------------------------------- */}
                    <TabBar
                        tabs={[
                            {
                                id: 'releases',
                                label: 'Releases',
                                icon: FileText,
                            },
                            {
                                id: 'timeline',
                                label: 'Timeline',
                                icon: History,
                            },
                        ]}
                        active={tab}
                        onChange={setTab}
                    />

                    {tab === 'timeline' ? (
                        <ReleaseTimelineTab
                            app={app}
                            canCreateRelease={canCreateRelease}
                            onCreate={() => setCreatingRelease(true)}
                            onReload={reload}
                        />
                    ) : (
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
                        {/* Releases timeline */}
                        <section className="space-y-3">
                            <div className="flex items-center justify-between">
                                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                                    Releases
                                </h2>
                                {canCreateRelease && (
                                    <Button
                                        size="sm"
                                        onClick={() =>
                                            setCreatingRelease(true)
                                        }
                                    >
                                        <Plus className="mr-1.5 h-4 w-4" />
                                        New release
                                    </Button>
                                )}
                            </div>
                            <ProdTargetCompareHint
                                releases={app.releases || []}
                                releasePinHook={releasePinHook}
                            />
                            {(app.releases?.length || 0) === 0 ? (
                                <Card>
                                    <CardContent className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
                                        <Upload className="h-6 w-6 text-muted-foreground/60" />
                                        <p>
                                            No releases tracked yet for this
                                            application.
                                        </p>
                                        {canCreateRelease && (
                                            <Button
                                                size="sm"
                                                onClick={() =>
                                                    setCreatingRelease(true)
                                                }
                                            >
                                                <Plus className="mr-1.5 h-4 w-4" />
                                                Add the first release
                                            </Button>
                                        )}
                                    </CardContent>
                                </Card>
                            ) : (
                                <ol className="relative space-y-3 border-l pl-4">
                                    {app.releases.map((r) => (
                                        <ReleaseRow
                                            key={r.id}
                                            applicationId={app.id}
                                            release={r}
                                            isExpanded={expanded.has(r.id)}
                                            onToggle={() =>
                                                setExpanded((prev) => {
                                                    const next = new Set(prev);
                                                    if (next.has(r.id)) {
                                                        next.delete(r.id);
                                                    } else {
                                                        next.add(r.id);
                                                    }
                                                    return next;
                                                })
                                            }
                                            canEditRelease={canEditRelease}
                                            canDeleteRelease={
                                                canDeleteRelease
                                            }
                                            isAdmin={isAdmin}
                                            currentUserId={user?.id}
                                            onEdit={() =>
                                                setEditingRelease(r)
                                            }
                                            onDelete={() =>
                                                setConfirmDelete({
                                                    type: 'release',
                                                    releaseId: r.id,
                                                    label: `release v${r.version}`,
                                                })
                                            }
                                            onChanged={reload}
                                            releasePinHook={releasePinHook}
                                        />
                                    ))}
                                </ol>
                            )}
                        </section>

                        {/* Side panels */}
                        <aside className="space-y-3">
                            <SidePanel
                                title="Dependencies"
                                content={app.dependencies}
                            />
                            <SidePanel
                                title="Important behaviour"
                                content={app.importantBehaviour}
                            />
                            <SidePanel
                                title="Important notes"
                                content={app.importantNotes}
                            />
                            {app.createdBy && (
                                <Card>
                                    <CardContent className="space-y-1 p-3 text-xs text-muted-foreground">
                                        <div>
                                            Added by{' '}
                                            <span className="font-medium text-foreground">
                                                {app.createdBy.name}
                                            </span>
                                        </div>
                                        <div>
                                            {format(
                                                new Date(app.createdAt),
                                                'd MMM yyyy',
                                            )}
                                        </div>
                                    </CardContent>
                                </Card>
                            )}
                        </aside>
                    </div>
                    )}
                </div>
            </main>

            <ApplicationFormDialog
                open={editing}
                onOpenChange={setEditing}
                app={app}
                onSaved={() => {
                    setEditing(false);
                    reload();
                }}
            />

            <ReleaseFormDialog
                open={creatingRelease || Boolean(editingRelease)}
                onOpenChange={(open) => {
                    if (!open) {
                        setCreatingRelease(false);
                        setEditingRelease(null);
                    }
                }}
                applicationId={app.id}
                release={editingRelease}
                canDeclarePhase={canDeclarePhase}
                onSaved={() => {
                    setCreatingRelease(false);
                    setEditingRelease(null);
                    reload();
                }}
            />

            <Dialog
                open={Boolean(confirmDelete)}
                onOpenChange={(open) => {
                    if (!open) setConfirmDelete(null);
                }}
            >
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {confirmDelete?.type === 'app'
                                ? `Delete "${app.name}"?`
                                : `Delete ${confirmDelete?.label || 'release'}?`}
                        </DialogTitle>
                        <DialogDescription>
                            {confirmDelete?.type === 'app'
                                ? 'This permanently removes the application along with every release, note and uploaded file.'
                                : 'This permanently removes the release along with its notes and any uploaded artifact.'}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setConfirmDelete(null)}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={async () => {
                                const c = confirmDelete;
                                setConfirmDelete(null);
                                if (c?.type === 'app') {
                                    await onDeleteApp();
                                } else if (c?.type === 'release') {
                                    await onDeleteRelease(c.releaseId);
                                }
                            }}
                        >
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

// ---------------------------------------------------------------------------
// Release row + notes thread
// ---------------------------------------------------------------------------

// Tiny "you have N newer releases than your prod target" banner that
// only renders when the user has starred a release as their prod
// target. Counts how many entries appear *above* the starred row
// (the list is sorted newest-first by the backend), so reviewers
// see at a glance how far behind production is from the tip.
function ProdTargetCompareHint({ releases, releasePinHook }) {
    if (!releasePinHook?.pinned || releasePinHook.pinned.length === 0) {
        return null;
    }
    if (!releases || releases.length === 0) return null;
    const pinnedSet = new Set(releasePinHook.pinned.map((p) => p.refId));
    const idx = releases.findIndex((r) => pinnedSet.has(r.id));
    if (idx < 0) return null;
    const newer = idx;
    const prodRelease = releases[idx];
    return (
        <div className="flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500" />
            <span>
                Production target: <strong>v{prodRelease.version}</strong>.{' '}
                {newer === 0
                    ? 'You are on the tip.'
                    : newer === 1
                        ? '1 newer release exists.'
                        : `${newer} newer releases exist.`}
            </span>
        </div>
    );
}

function ReleaseRow({
    applicationId,
    release,
    isExpanded,
    onToggle,
    // Split into edit vs delete so an admin can grant
    // `app:release:edit` without also granting delete (and vice
    // versa). The Edit button used to be visible to anyone with the
    // broader `canEdit` flag and Delete was admin-only; now both are
    // capability-gated independently.
    canEditRelease = false,
    canDeleteRelease = false,
    isAdmin,
    currentUserId,
    onEdit,
    onDelete,
    onChanged,
    releasePinHook,
}) {
    const isProdTarget = releasePinHook?.isPinned
        ? releasePinHook.isPinned(release.id)
        : false;
    const dateLabel = release.releaseDate
        ? format(new Date(release.releaseDate), 'd MMM yyyy')
        : null;
    const created = release.createdAt
        ? formatDistanceToNow(new Date(release.createdAt), { addSuffix: true })
        : '';

    const phase = release.phase || 'TEST';
    const targetOs = Array.isArray(release.targetOs) ? release.targetOs : [];
    const terminals = Array.isArray(release.posTerminalType)
        ? release.posTerminalType
        : [];

    return (
        <li className="relative">
            <span
                className={cn(
                    'absolute -left-[21px] top-3 flex h-3 w-3 items-center justify-center rounded-full border-2 border-background',
                    isProdTarget ? 'bg-amber-400' : 'bg-primary',
                )}
            />
            <Card
                className={cn(
                    isProdTarget && 'border-amber-400/60 bg-amber-50/30 dark:bg-amber-500/5',
                )}
            >
                <CardContent className="space-y-3 p-3">
                    <button
                        type="button"
                        onClick={onToggle}
                        className="flex w-full flex-wrap items-center gap-2 text-left"
                        aria-expanded={isExpanded}
                    >
                        <span className="rounded-full border bg-primary/10 px-2 py-0.5 text-xs font-mono font-semibold text-primary">
                            v{release.version}
                        </span>
                        <PhaseBadge phase={phase} />
                        {isProdTarget && (
                            <span
                                className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-200"
                                title="You marked this as the current production target."
                            >
                                <Star className="h-3 w-3 fill-current" />
                                Prod target
                            </span>
                        )}
                        {dateLabel && (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                <Calendar className="h-3 w-3" />
                                {dateLabel}
                            </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">
                            added {created}
                        </span>
                        {releasePinHook && (
                            <span
                                onClick={(e) => e.stopPropagation()}
                                className="ml-auto"
                            >
                                <PinButton
                                    kind="RELEASE_PROD"
                                    refId={release.id}
                                    variant="star"
                                    size="xs"
                                    pinHookOverride={releasePinHook}
                                    offLabel="Flag as current production target"
                                    onLabel="Clear production-target flag"
                                />
                            </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">
                            {isExpanded ? 'Hide details' : 'Show details'}
                        </span>
                    </button>

                    {/* Per-release metadata strip — visible even when
                        collapsed so reviewers can scan the timeline
                        without expanding every entry. The artifact
                        download lives here too so users don't have
                        to expand the card just to grab the file. */}
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        {targetOs.map((os) => (
                            <Chip
                                key={`os-${os}`}
                                icon={Smartphone}
                                label={os}
                            />
                        ))}
                        {terminals.map((t) => (
                            <Chip
                                key={`term-${t}`}
                                icon={Layers}
                                label={t}
                            />
                        ))}
                        {release.minimumVersion && (
                            <Chip
                                icon={Tag}
                                label={`Min ${release.minimumVersion}`}
                            />
                        )}
                        {release.fileUrl && (
                            <a
                                href={resolveAssetUrl(release.fileUrl)}
                                target="_blank"
                                rel="noreferrer"
                                download={
                                    release.fileName ||
                                    `release-${release.version}`
                                }
                                onClick={(e) => e.stopPropagation()}
                                className="ml-auto inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent hover:text-primary"
                                title={
                                    release.fileName
                                        ? `Download ${release.fileName}${typeof release.fileSize === 'number' ? ` (${formatBytes(release.fileSize)})` : ''}`
                                        : 'Download release artifact'
                                }
                            >
                                <Download className="h-3 w-3" />
                                Download
                            </a>
                        )}
                    </div>

                    {isExpanded && (
                        <div className="space-y-3 border-t pt-3">
                            <PhaseTimeline release={release} />

                            {release.fixes ? (
                                <div>
                                    <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                        What changed
                                    </h4>
                                    <div className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm leading-relaxed">
                                        {release.fixes}
                                    </div>
                                </div>
                            ) : (
                                <p className="text-xs italic text-muted-foreground">
                                    No fix log recorded for this release.
                                </p>
                            )}

                            {release.importantNotes && (
                                <div>
                                    <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                        Important notes
                                    </h4>
                                    <div className="whitespace-pre-wrap rounded-md border border-amber-200/60 bg-amber-50/50 p-3 text-sm leading-relaxed text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200">
                                        {release.importantNotes}
                                    </div>
                                </div>
                            )}

                            {release.fileUrl && (
                                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-xs">
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate font-medium">
                                            {release.fileName ||
                                                'Release artifact'}
                                        </div>
                                        {typeof release.fileSize === 'number' && (
                                            <div className="text-[10px] text-muted-foreground">
                                                {formatBytes(release.fileSize)}
                                            </div>
                                        )}
                                    </div>
                                    <Button
                                        asChild
                                        size="sm"
                                        variant="outline"
                                    >
                                        <a
                                            href={resolveAssetUrl(release.fileUrl)}
                                            target="_blank"
                                            rel="noreferrer"
                                            download={
                                                release.fileName ||
                                                `release-${release.version}`
                                            }
                                        >
                                            <Download className="mr-1 h-3 w-3" />
                                            Download
                                        </a>
                                    </Button>
                                </div>
                            )}

                            <ReleaseNotes
                                applicationId={applicationId}
                                release={release}
                                isAdmin={isAdmin}
                                currentUserId={currentUserId}
                                onChanged={onChanged}
                            />

                            {(canEditRelease || canDeleteRelease) && (
                                <div className="flex flex-wrap gap-2 border-t pt-2">
                                    {canEditRelease && (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={onEdit}
                                        >
                                            <Pencil className="mr-1.5 h-3 w-3" />
                                            Edit release
                                        </Button>
                                    )}
                                    {canDeleteRelease && (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                            onClick={onDelete}
                                        >
                                            <Trash2 className="mr-1.5 h-3 w-3" />
                                            Delete release
                                        </Button>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>
        </li>
    );
}

function ReleaseNotes({
    applicationId,
    release,
    isAdmin,
    currentUserId,
    onChanged,
}) {
    const [draft, setDraft] = useState('');
    const [posting, setPosting] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [editingDraft, setEditingDraft] = useState('');

    const post = async (e) => {
        e.preventDefault();
        if (!draft.trim()) return;
        setPosting(true);
        try {
            await api.post(
                `/applications/${applicationId}/releases/${release.id}/notes`,
                { content: draft.trim() },
            );
            setDraft('');
            onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not post note');
        } finally {
            setPosting(false);
        }
    };

    const save = async (noteId) => {
        if (!editingDraft.trim()) return;
        try {
            await api.patch(
                `/applications/${applicationId}/releases/${release.id}/notes/${noteId}`,
                { content: editingDraft.trim() },
            );
            setEditingId(null);
            setEditingDraft('');
            onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save note');
        }
    };

    const remove = async (noteId) => {
        try {
            await api.delete(
                `/applications/${applicationId}/releases/${release.id}/notes/${noteId}`,
            );
            onChanged?.();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete note');
        }
    };

    const notes = release.notes || [];

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <MessageSquarePlus className="h-3.5 w-3.5" />
                Notes
                <span className="text-[10px] font-normal normal-case text-muted-foreground/70">
                    {notes.length} {notes.length === 1 ? 'note' : 'notes'}
                </span>
            </div>

            <form onSubmit={post} className="flex flex-col gap-2">
                <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={2}
                    placeholder="Leave a note about this release..."
                />
                <div className="flex justify-end">
                    <Button
                        type="submit"
                        size="sm"
                        disabled={posting || !draft.trim()}
                    >
                        {posting && (
                            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                        )}
                        Post note
                    </Button>
                </div>
            </form>

            {notes.length === 0 ? (
                <p className="text-xs italic text-muted-foreground">
                    No notes on this release yet.
                </p>
            ) : (
                <ul className="space-y-2">
                    {notes.map((n) => {
                        const canModify =
                            isAdmin || n.author?.id === currentUserId;
                        const isEditing = editingId === n.id;
                        return (
                            <li
                                key={n.id}
                                className="rounded-md border bg-muted/20 p-2 text-sm"
                            >
                                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                                    <Avatar
                                        url={n.author?.avatarUrl}
                                        name={n.author?.name}
                                    />
                                    <span className="font-medium text-foreground">
                                        {n.author?.name || n.author?.email}
                                    </span>
                                    <span>·</span>
                                    <span>
                                        {formatDistanceToNow(
                                            new Date(n.createdAt),
                                            { addSuffix: true },
                                        )}
                                    </span>
                                </div>
                                {isEditing ? (
                                    <div className="mt-1.5 space-y-1.5">
                                        <Textarea
                                            value={editingDraft}
                                            onChange={(e) =>
                                                setEditingDraft(e.target.value)
                                            }
                                            rows={2}
                                        />
                                        <div className="flex justify-end gap-2">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => {
                                                    setEditingId(null);
                                                    setEditingDraft('');
                                                }}
                                            >
                                                Cancel
                                            </Button>
                                            <Button
                                                size="sm"
                                                onClick={() => save(n.id)}
                                            >
                                                Save
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <p className="mt-1 whitespace-pre-wrap text-sm">
                                        {n.content}
                                    </p>
                                )}
                                {canModify && !isEditing && (
                                    <div className="mt-1 flex justify-end gap-1.5 text-[11px]">
                                        <button
                                            type="button"
                                            className="text-muted-foreground hover:text-foreground"
                                            onClick={() => {
                                                setEditingId(n.id);
                                                setEditingDraft(n.content);
                                            }}
                                        >
                                            Edit
                                        </button>
                                        <span className="text-muted-foreground/40">
                                            ·
                                        </span>
                                        <button
                                            type="button"
                                            className="text-muted-foreground hover:text-destructive"
                                            onClick={() => remove(n.id)}
                                        >
                                            Delete
                                        </button>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Compact horizontal track showing the three pipeline phases with the
// timestamp recorded the first time the release entered each one.
// Phases the release hasn't reached yet render muted with a "—".
function PhaseTimeline({ release }) {
    const stops = [
        { phase: 'TEST', at: release.testAt },
        { phase: 'PILOT', at: release.pilotAt },
        { phase: 'APPROVED', at: release.approvedAt },
    ];
    const current = release.phase || 'TEST';
    return (
        <div>
            <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Pipeline
            </h4>
            <ol className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {stops.map((s) => {
                    const reached = Boolean(s.at);
                    const isCurrent = s.phase === current;
                    return (
                        <li
                            key={s.phase}
                            className={cn(
                                'rounded-md border px-2 py-1.5 text-[11px]',
                                reached
                                    ? PHASE_BADGE_CLASS[s.phase]
                                    : 'border-dashed text-muted-foreground/70',
                                isCurrent && reached && 'ring-1 ring-primary/40',
                            )}
                        >
                            <div className="flex items-center justify-between gap-1 font-semibold uppercase tracking-wide">
                                <span>{PHASE_LABEL[s.phase]}</span>
                                {isCurrent && reached && (
                                    <span className="rounded-sm bg-primary/15 px-1 text-[9px] text-primary">
                                        now
                                    </span>
                                )}
                            </div>
                            <div className="mt-0.5">
                                {reached ? (
                                    <span className="text-foreground/80">
                                        {format(
                                            new Date(s.at),
                                            'd MMM yyyy',
                                        )}
                                    </span>
                                ) : (
                                    '—'
                                )}
                            </div>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

function SidePanel({ title, content }) {
    if (!content) {
        return (
            <Card>
                <CardContent className="space-y-1 p-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {title}
                    </h3>
                    <p className="text-xs italic text-muted-foreground">
                        Nothing recorded yet.
                    </p>
                </CardContent>
            </Card>
        );
    }
    return (
        <Card>
            <CardContent className="space-y-1.5 p-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {title}
                </h3>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {content}
                </p>
            </CardContent>
        </Card>
    );
}

function Logo({ url, name, size = 'md' }) {
    const dim =
        size === 'lg'
            ? 'h-16 w-16 text-lg'
            : 'h-12 w-12 text-base';
    if (url) {
        return (
            <img
                src={resolveAssetUrl(url)}
                alt={`${name} logo`}
                className={cn(
                    'shrink-0 rounded-xl border bg-white object-cover',
                    dim,
                )}
            />
        );
    }
    return (
        <div
            className={cn(
                'flex shrink-0 items-center justify-center rounded-xl border bg-muted font-semibold text-muted-foreground',
                dim,
            )}
        >
            {(name || '?').slice(0, 2).toUpperCase()}
        </div>
    );
}

function PhaseBadge({ phase }) {
    return (
        <span
            className={cn(
                'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                PHASE_BADGE_CLASS[phase] ||
                    'border-muted-foreground/30 text-muted-foreground',
            )}
        >
            {PHASE_LABEL[phase] || phase}
        </span>
    );
}

function Chip({ icon: Icon, label }) {
    return (
        <span className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-1.5 py-0.5">
            {Icon && <Icon className="h-3 w-3" />}
            {label}
        </span>
    );
}

function Avatar({ url, name }) {
    if (url) {
        return (
            <img
                src={resolveAssetUrl(url)}
                alt={name || 'user'}
                className="h-5 w-5 rounded-full object-cover"
            />
        );
    }
    const initials = (name || '?')
        .split(/\s+/)
        .slice(0, 2)
        .map((p) => p[0])
        .join('')
        .toUpperCase();
    return (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-[9px] font-semibold text-primary">
            {initials}
        </span>
    );
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Tab navigation — small wrapper that mirrors the look used on the Todos
// page so the application detail blends in with the rest of the app.
// ---------------------------------------------------------------------------
function TabBar({ tabs, active, onChange }) {
    return (
        <div className="rounded-lg border bg-card p-1 shadow-sm">
            <div className="flex flex-wrap gap-1">
                {tabs.map((t) => {
                    const Icon = t.icon;
                    const isActive = t.id === active;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            onClick={() => onChange(t.id)}
                            className={cn(
                                'flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                                isActive
                                    ? 'bg-primary/10 text-primary'
                                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                            )}
                        >
                            {Icon && <Icon className="h-4 w-4" />}
                            {t.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Timeline tab — horizontally scrollable, card-based history of phase
// transitions for an application's releases. The "production" filter is
// the default since the user's primary use-case is post-mortem rollback:
// "we know when some release went to prod and if there's some problem we
// can rollback in first place and then fix it."
// ---------------------------------------------------------------------------
// Two kinds of timeline events flow through this component:
//   - "phase" events: an admin/manager declared a release moved to
//     TEST / PILOT / APPROVED. Stamped on the release row itself.
//   - "checkpoint" events: an operator (anyone with the
//     APP_CHECKPOINT_ADD capability) recorded a real-world deployment
//     against a release ("deployed v1.2.3 to prod cluster A at 02:13").
//     Lives in its own ReleaseCheckpoint row.
const PHASE_FILTERS = [
    { id: 'all', label: 'All events', match: () => true },
    {
        id: 'APPROVED',
        label: 'Production',
        match: (e) =>
            e.phase === 'APPROVED' ||
            e.kind === 'PROD_DEPLOY' ||
            e.kind === 'PROD_ROLLBACK',
    },
    {
        id: 'PILOT',
        label: 'Pilot',
        match: (e) => e.phase === 'PILOT' || e.kind === 'PILOT_DEPLOY',
    },
    {
        id: 'TEST',
        label: 'Test',
        match: (e) => e.phase === 'TEST' || e.kind === 'TEST_DEPLOY',
    },
    {
        id: 'CHECKPOINTS',
        label: 'Checkpoints only',
        match: (e) => e.type === 'checkpoint',
    },
];

const PHASE_ACCENT = {
    APPROVED: 'from-emerald-500 to-emerald-400',
    PILOT: 'from-amber-500 to-amber-400',
    TEST: 'from-sky-500 to-sky-400',
    PROD_DEPLOY: 'from-emerald-600 to-emerald-500',
    PROD_ROLLBACK: 'from-rose-600 to-rose-500',
    PILOT_DEPLOY: 'from-amber-600 to-amber-500',
    TEST_DEPLOY: 'from-sky-600 to-sky-500',
    NOTE: 'from-slate-500 to-slate-400',
};

const PHASE_RING = {
    APPROVED:
        'ring-emerald-200 bg-emerald-50 text-emerald-700 dark:ring-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300',
    PILOT:
        'ring-amber-200 bg-amber-50 text-amber-700 dark:ring-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300',
    TEST:
        'ring-sky-200 bg-sky-50 text-sky-700 dark:ring-sky-400/30 dark:bg-sky-400/10 dark:text-sky-300',
    PROD_DEPLOY:
        'ring-emerald-300 bg-emerald-50 text-emerald-700 dark:ring-emerald-400/40 dark:bg-emerald-400/10 dark:text-emerald-300',
    PROD_ROLLBACK:
        'ring-rose-300 bg-rose-50 text-rose-700 dark:ring-rose-400/40 dark:bg-rose-400/10 dark:text-rose-300',
    PILOT_DEPLOY:
        'ring-amber-300 bg-amber-50 text-amber-700 dark:ring-amber-400/40 dark:bg-amber-400/10 dark:text-amber-300',
    TEST_DEPLOY:
        'ring-sky-300 bg-sky-50 text-sky-700 dark:ring-sky-400/40 dark:bg-sky-400/10 dark:text-sky-300',
    NOTE:
        'ring-slate-300 bg-slate-50 text-slate-700 dark:ring-slate-400/40 dark:bg-slate-400/10 dark:text-slate-300',
};

const PHASE_ICON = {
    APPROVED: Rocket,
    PILOT: Layers,
    TEST: Smartphone,
    PROD_DEPLOY: CheckCircle2,
    PROD_ROLLBACK: Undo2,
    PILOT_DEPLOY: Layers,
    TEST_DEPLOY: Smartphone,
    NOTE: StickyNote,
};

const CHECKPOINT_KIND_LABEL = {
    PROD_DEPLOY: 'Deployed to prod',
    PROD_ROLLBACK: 'Rolled back from prod',
    PILOT_DEPLOY: 'Pilot deployment',
    TEST_DEPLOY: 'Test deployment',
    NOTE: 'Operational note',
};

function buildPhaseEvents(release) {
    // One release can produce multiple events (one per phase transition).
    // We surface every stamped transition so the timeline reads like an
    // honest deployment log.
    const events = [];
    if (release.testAt) {
        events.push({
            id: `${release.id}:TEST`,
            type: 'phase',
            release,
            phase: 'TEST',
            at: new Date(release.testAt),
        });
    }
    if (release.pilotAt) {
        events.push({
            id: `${release.id}:PILOT`,
            type: 'phase',
            release,
            phase: 'PILOT',
            at: new Date(release.pilotAt),
        });
    }
    if (release.approvedAt) {
        events.push({
            id: `${release.id}:APPROVED`,
            type: 'phase',
            release,
            phase: 'APPROVED',
            at: new Date(release.approvedAt),
        });
    }
    return events;
}

function buildCheckpointEvents(release) {
    return (release.checkpoints || []).map((cp) => ({
        id: `cp:${cp.id}`,
        type: 'checkpoint',
        release,
        checkpoint: cp,
        kind: cp.kind,
        at: new Date(cp.occurredAt),
    }));
}

function ReleaseTimelineTab({
    app,
    // Gate for the trailing "New release" button. Checkpoint
    // add/delete already use their own capability checks below
    // (`APP_CHECKPOINT_ADD` / `APP_CHECKPOINT_DELETE`).
    canCreateRelease = false,
    onCreate,
    onReload,
}) {
    const { user } = useAuth();
    const [filter, setFilter] = useState('APPROVED');
    const [openId, setOpenId] = useState(null);
    const [checkpointDialog, setCheckpointDialog] = useState(null);
    const scrollerRef = useRef(null);

    const canAddCheckpoint = hasCapability(
        user,
        CAPABILITIES.APP_CHECKPOINT_ADD,
    );
    const canDeleteAnyCheckpoint = hasCapability(
        user,
        CAPABILITIES.APP_CHECKPOINT_DELETE,
    );

    const events = useMemo(() => {
        const phaseEvents = (app.releases || []).flatMap(buildPhaseEvents);
        const checkpointEvents = (app.releases || []).flatMap(
            buildCheckpointEvents,
        );
        const all = [...phaseEvents, ...checkpointEvents];
        const matcher =
            PHASE_FILTERS.find((f) => f.id === filter)?.match ||
            (() => true);
        return all
            .filter(matcher)
            .sort((a, b) => b.at.getTime() - a.at.getTime());
    }, [app.releases, filter]);

    // Scroll horizontally with the mouse wheel — feels much more natural
    // for a timeline than holding shift.
    useEffect(() => {
        const el = scrollerRef.current;
        if (!el) return;
        const onWheel = (e) => {
            if (e.deltaY === 0) return;
            // Only hijack vertical scroll if the strip can actually scroll
            // horizontally; otherwise let the page scroll normally.
            if (el.scrollWidth <= el.clientWidth) return;
            e.preventDefault();
            el.scrollBy({ left: e.deltaY, behavior: 'auto' });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [events.length]);

    // "Grab-and-pan" drag-to-scroll. The user holds the left mouse
    // button down anywhere on the strip and drags horizontally; we
    // suppress click on direct children that received pointer-down so
    // the drag doesn't open the card they happened to start on. The
    // wheel handler and ChevronsLeft/Right buttons stay available, as
    // does the regular native scrollbar underneath.
    const [isDragging, setIsDragging] = useState(false);
    useEffect(() => {
        const el = scrollerRef.current;
        if (!el) return undefined;
        let active = false;
        let startX = 0;
        let startScroll = 0;
        let moved = 0;

        const onPointerDown = (e) => {
            // Only react to primary mouse / pen / touch. Ignore right-
            // clicks, middle-clicks, and modifier-key clicks (those are
            // shortcuts like ctrl-click "open in new tab").
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            // Don't initiate the drag on form controls / scrollbars so
            // the user can still click "Delete" on a card or grab the
            // native scrollbar.
            const target = e.target;
            if (
                target instanceof Element &&
                target.closest('button, a, input, textarea, select, [data-no-drag]')
            ) {
                return;
            }
            active = true;
            moved = 0;
            startX = e.clientX;
            startScroll = el.scrollLeft;
            setIsDragging(true);
            try {
                el.setPointerCapture(e.pointerId);
            } catch {
                // setPointerCapture can throw if the pointer is already
                // captured — non-fatal, drag still works.
            }
        };
        const onPointerMove = (e) => {
            if (!active) return;
            const dx = e.clientX - startX;
            moved = Math.max(moved, Math.abs(dx));
            el.scrollLeft = startScroll - dx;
        };
        const stop = (e) => {
            if (!active) return;
            active = false;
            setIsDragging(false);
            try {
                el.releasePointerCapture(e.pointerId);
            } catch {
                /* ignore */
            }
            // If the drag actually moved (vs. a stationary click on
            // empty strip space), swallow the next click event so a
            // card-toggle doesn't fire as a side-effect of releasing
            // the mouse on a card. CRITICAL: also auto-detach the
            // swallower after a short timeout so it can't sit around
            // eating the user's *next* deliberate click (which is how
            // the chevron buttons looked permanently dead after one
            // drag).
            if (moved > 4) {
                const swallow = (ev) => {
                    ev.stopPropagation();
                    ev.preventDefault();
                    window.removeEventListener('click', swallow, true);
                    clearTimeout(detach);
                };
                const detach = setTimeout(() => {
                    window.removeEventListener('click', swallow, true);
                }, 200);
                window.addEventListener('click', swallow, true);
            }
        };
        el.addEventListener('pointerdown', onPointerDown);
        el.addEventListener('pointermove', onPointerMove);
        el.addEventListener('pointerup', stop);
        el.addEventListener('pointercancel', stop);
        return () => {
            el.removeEventListener('pointerdown', onPointerDown);
            el.removeEventListener('pointermove', onPointerMove);
            el.removeEventListener('pointerup', stop);
            el.removeEventListener('pointercancel', stop);
        };
    }, [events.length]);

    // The chevron buttons jump the strip all the way to either edge.
    // Stepping by a screen-width felt arbitrary on a timeline whose
    // useful "ends" are the newest and oldest events — those are the
    // two locations users actually want to teleport to.
    const scrollToEdge = (edge) => {
        const el = scrollerRef.current;
        if (!el) return;
        el.scrollTo({
            left: edge === 'start' ? 0 : el.scrollWidth,
            behavior: 'smooth',
        });
    };

    return (
        <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        Deployment timeline
                    </h2>
                    <p className="text-xs text-muted-foreground">
                        Every phase transition for this application.
                        {filter === 'APPROVED' &&
                            ' Showing production deployments — useful for rollback decisions.'}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <div className="flex flex-wrap gap-1 rounded-lg border bg-card p-1 shadow-sm">
                        {PHASE_FILTERS.map((f) => {
                            const isActive = f.id === filter;
                            return (
                                <button
                                    key={f.id}
                                    type="button"
                                    onClick={() => setFilter(f.id)}
                                    className={cn(
                                        'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                                        isActive
                                            ? 'bg-primary/10 text-primary'
                                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                                    )}
                                >
                                    {f.label}
                                </button>
                            );
                        })}
                    </div>
                    {canAddCheckpoint && (app.releases?.length || 0) > 0 && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                                setCheckpointDialog({
                                    releaseId: app.releases[0].id,
                                })
                            }
                        >
                            <CheckCircle2 className="mr-1.5 h-4 w-4" />
                            Add checkpoint
                        </Button>
                    )}
                    {canCreateRelease && (
                        <Button size="sm" onClick={onCreate}>
                            <Plus className="mr-1.5 h-4 w-4" />
                            New release
                        </Button>
                    )}
                </div>
            </div>

            {events.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
                        <History className="h-6 w-6 text-muted-foreground/60" />
                        <p>
                            {filter === 'APPROVED'
                                ? 'No releases have been approved for production yet.'
                                : 'No phase transitions match this filter yet.'}
                        </p>
                    </CardContent>
                </Card>
            ) : (
                <div className="relative">
                    {/* The two chevrons jump straight to the newest /
                        oldest end of the strip. `stopPropagation` on
                        pointerdown isn't strictly necessary (the
                        buttons are siblings of the scroller, not
                        children) but it makes absolutely sure the
                        drag-to-pan handler can never see the event
                        and consume the click. */}
                    {/* Edge fade masks — gradient from the page
                        background to transparent, sitting between the
                        cards (z-0) and the chevron buttons (z-20).
                        Without them the (slightly transparent) buttons
                        showed a ghost of whichever card was scrolling
                        underneath, which read as "the button is
                        overlapping the card". Pointer-events-none so
                        they never swallow clicks intended for cards. */}
                    <div
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0 left-0 z-10 hidden w-14 bg-gradient-to-r from-background via-background/85 to-transparent sm:block"
                    />
                    <div
                        aria-hidden
                        className="pointer-events-none absolute inset-y-0 right-0 z-10 hidden w-14 bg-gradient-to-l from-background via-background/85 to-transparent sm:block"
                    />
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            scrollToEdge('start');
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        data-no-drag
                        className="absolute left-1 top-1/2 z-20 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md ring-1 ring-background transition-colors hover:bg-accent hover:text-foreground sm:flex"
                        aria-label="Jump to the beginning"
                        title="Jump to the beginning"
                    >
                        <ChevronsLeft className="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            scrollToEdge('end');
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        data-no-drag
                        className="absolute right-1 top-1/2 z-20 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md ring-1 ring-background transition-colors hover:bg-accent hover:text-foreground sm:flex"
                        aria-label="Jump to the end"
                        title="Jump to the end"
                    >
                        <ChevronsRight className="h-4 w-4" />
                    </button>
                    <div
                        ref={scrollerRef}
                        className={cn(
                            'relative overflow-x-scroll select-none pb-4 pt-2',
                            isDragging ? 'cursor-grabbing' : 'cursor-grab',
                        )}
                        style={{ scrollbarGutter: 'stable' }}
                    >
                        {/* Connecting dotted line behind the cards */}
                        <div
                            className="pointer-events-none absolute inset-x-0 top-1/2 -z-0 h-px border-t-2 border-dotted border-muted-foreground/30"
                            aria-hidden
                        />
                        {/* Wide inner padding so the first/last
                            cards can't slide under the absolute
                            "jump to start/end" chevron buttons.
                            Each button occupies roughly 4..36px from
                            its edge, so a 52px (px-13) gutter leaves
                            a comfortable buffer on both sides. */}
                        <ul className="relative z-10 flex items-stretch gap-4 px-[52px]">
                            {events.map((evt) => (
                                <li
                                    key={evt.id}
                                    className="shrink-0"
                                    style={{
                                        width:
                                            openId === evt.id ? 360 : 220,
                                    }}
                                >
                                    <TimelineCard
                                        event={evt}
                                        appName={app.name}
                                        appLogoUrl={app.logoUrl}
                                        isOpen={openId === evt.id}
                                        onToggle={() =>
                                            setOpenId((cur) =>
                                                cur === evt.id ? null : evt.id,
                                            )
                                        }
                                        currentUserId={user?.id}
                                        canDeleteAnyCheckpoint={
                                            canDeleteAnyCheckpoint
                                        }
                                        canAddCheckpoint={canAddCheckpoint}
                                        appId={app.id}
                                        onChanged={onReload}
                                    />
                                </li>
                            ))}
                        </ul>
                    </div>
                </div>
            )}

            <CheckpointDialog
                open={Boolean(checkpointDialog)}
                onOpenChange={(o) => {
                    if (!o) setCheckpointDialog(null);
                }}
                appId={app.id}
                releases={app.releases || []}
                initialReleaseId={checkpointDialog?.releaseId}
                onSaved={() => {
                    setCheckpointDialog(null);
                    onReload?.();
                }}
            />
        </section>
    );
}

function TimelineCard({
    event,
    appName,
    appLogoUrl,
    isOpen,
    onToggle,
    currentUserId,
    canDeleteAnyCheckpoint,
    canAddCheckpoint,
    appId,
    onChanged,
}) {
    if (event.type === 'checkpoint') {
        return (
            <CheckpointCard
                event={event}
                appName={appName}
                appLogoUrl={appLogoUrl}
                isOpen={isOpen}
                onToggle={onToggle}
                currentUserId={currentUserId}
                canDeleteAnyCheckpoint={canDeleteAnyCheckpoint}
                canAddCheckpoint={canAddCheckpoint}
                appId={appId}
                onChanged={onChanged}
            />
        );
    }
    const { release, phase, at } = event;
    const Icon = PHASE_ICON[phase] || Rocket;
    return (
        <Card className="relative h-full overflow-hidden transition-all">
            <div
                className={cn(
                    'h-1 w-full bg-gradient-to-r',
                    PHASE_ACCENT[phase] || 'from-muted to-muted',
                )}
            />
            <CardContent className="space-y-2 p-3">
                <div className="flex items-start gap-2">
                    <button
                        type="button"
                        onClick={onToggle}
                        className={cn(
                            'group relative -ml-1 -mt-1 shrink-0 rounded-xl p-1 ring-2 transition-transform hover:scale-105',
                            PHASE_RING[phase] ||
                                'ring-muted bg-muted text-muted-foreground',
                        )}
                        aria-expanded={isOpen}
                        aria-label={
                            isOpen
                                ? 'Collapse release details'
                                : 'Expand release details'
                        }
                    >
                        {appLogoUrl ? (
                            <img
                                src={resolveAssetUrl(appLogoUrl)}
                                alt={appName}
                                className="h-9 w-9 rounded-lg bg-white object-cover"
                            />
                        ) : (
                            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-xs font-bold uppercase">
                                {(appName || '?').slice(0, 2)}
                            </span>
                        )}
                        <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-white shadow ring-1 ring-border">
                            <Icon className="h-2.5 w-2.5" />
                        </span>
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {format(at, 'd MMM yyyy')}
                        </div>
                        <div className="truncate text-sm font-semibold">
                            v{release.version}
                        </div>
                        <div className="mt-1 flex items-center gap-1">
                            <PhaseBadge phase={phase} />
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                                phase
                            </span>
                        </div>
                    </div>
                </div>

                {isOpen && (
                    <div className="space-y-2 border-t pt-2 text-xs">
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <div>
                                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    What changed
                                </div>
                                <p className="whitespace-pre-wrap break-words text-foreground">
                                    {release.fixes?.trim() || (
                                        <span className="text-muted-foreground">
                                            —
                                        </span>
                                    )}
                                </p>
                            </div>
                            <div>
                                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    Important notes
                                </div>
                                <p className="whitespace-pre-wrap break-words text-foreground">
                                    {release.importantNotes?.trim() || (
                                        <span className="text-muted-foreground">
                                            —
                                        </span>
                                    )}
                                </p>
                            </div>
                        </div>

                        {(release.targetOs?.length > 0 ||
                            release.posTerminalType?.length > 0 ||
                            release.minimumVersion) && (
                            <div className="flex flex-wrap gap-1 border-t pt-2">
                                {release.targetOs?.map((os) => (
                                    <Chip
                                        key={`os-${os}`}
                                        icon={Smartphone}
                                        label={os}
                                    />
                                ))}
                                {release.posTerminalType?.map((t) => (
                                    <Chip
                                        key={`pos-${t}`}
                                        icon={Tag}
                                        label={t}
                                    />
                                ))}
                                {release.minimumVersion && (
                                    <Chip
                                        icon={Layers}
                                        label={`min ${release.minimumVersion}`}
                                    />
                                )}
                            </div>
                        )}

                        <PhaseStampRow release={release} highlight={phase} />
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function PhaseStampRow({ release, highlight }) {
    const stamps = [
        { phase: 'TEST', at: release.testAt, label: 'Test' },
        { phase: 'PILOT', at: release.pilotAt, label: 'Pilot' },
        { phase: 'APPROVED', at: release.approvedAt, label: 'Prod' },
    ];
    return (
        <div className="flex items-center gap-1 border-t pt-2 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            {stamps.map((s, i) => (
                <span key={s.phase} className="flex items-center gap-1">
                    <span
                        className={cn(
                            'rounded-full px-1.5 py-0.5',
                            s.at && s.phase === highlight
                                ? 'bg-foreground text-background'
                                : s.at
                                  ? 'bg-muted text-foreground'
                                  : 'opacity-40',
                        )}
                    >
                        {s.label}
                        {s.at ? ` · ${format(new Date(s.at), 'd MMM')}` : ''}
                    </span>
                    {i < stamps.length - 1 && <span>›</span>}
                </span>
            ))}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Checkpoint card — operator-authored deployment / rollback events.
// Visually distinct from phase cards so the timeline reads "phase
// transitions in normal palette, real-world ops in saturated colours
// with author + environment labels".
// ---------------------------------------------------------------------------
function CheckpointCard({
    event,
    appName,
    appLogoUrl,
    isOpen,
    onToggle,
    currentUserId,
    canDeleteAnyCheckpoint,
    canAddCheckpoint,
    appId,
    onChanged,
}) {
    const { release, checkpoint, kind, at } = event;
    const Icon = PHASE_ICON[kind] || CheckCircle2;
    const accent = PHASE_ACCENT[kind] || 'from-slate-500 to-slate-400';
    const ring = PHASE_RING[kind] || 'ring-slate-200 bg-slate-50';
    const label = CHECKPOINT_KIND_LABEL[kind] || kind;
    const isAuthor = checkpoint.authorId === currentUserId;
    const canDelete =
        canDeleteAnyCheckpoint || (isAuthor && canAddCheckpoint);
    const isRollback = kind === 'PROD_ROLLBACK';

    const handleDelete = async () => {
        if (
            !window.confirm(
                'Delete this checkpoint? The phase transition stamps on the release row will not change.',
            )
        ) {
            return;
        }
        try {
            await api.delete(
                `/applications/${appId}/releases/${release.id}/checkpoints/${checkpoint.id}`,
            );
            toast.success('Checkpoint removed.');
            onChanged?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not delete checkpoint',
            );
        }
    };

    return (
        <Card
            className={cn(
                'relative h-full overflow-hidden transition-all',
                isRollback && 'ring-1 ring-rose-200',
            )}
        >
            <div className={cn('h-1 w-full bg-gradient-to-r', accent)} />
            <CardContent className="space-y-2 p-3">
                <div className="flex items-start gap-2">
                    <button
                        type="button"
                        onClick={onToggle}
                        className={cn(
                            'group relative -ml-1 -mt-1 shrink-0 rounded-xl p-1 ring-2 transition-transform hover:scale-105',
                            ring,
                        )}
                        aria-expanded={isOpen}
                        aria-label={
                            isOpen ? 'Collapse checkpoint' : 'Expand checkpoint'
                        }
                    >
                        {appLogoUrl ? (
                            <img
                                src={resolveAssetUrl(appLogoUrl)}
                                alt={appName}
                                className="h-9 w-9 rounded-lg bg-white object-cover"
                            />
                        ) : (
                            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-xs font-bold uppercase">
                                {(appName || '?').slice(0, 2)}
                            </span>
                        )}
                        <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-white shadow ring-1 ring-border">
                            <Icon className="h-2.5 w-2.5" />
                        </span>
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {format(at, 'd MMM yyyy · HH:mm')}
                        </div>
                        <div className="truncate text-sm font-semibold">
                            v{release.version}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span
                                className={cn(
                                    'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                    isRollback
                                        ? 'border-rose-300 bg-rose-50 text-rose-700'
                                        : 'border-emerald-300 bg-emerald-50 text-emerald-700',
                                )}
                            >
                                {label}
                            </span>
                            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                                checkpoint
                            </span>
                        </div>
                    </div>
                </div>

                {isOpen && (
                    <div className="space-y-2 border-t pt-2 text-xs">
                        {checkpoint.environment && (
                            <div className="flex items-start gap-1 text-foreground">
                                <MapPin className="mt-0.5 h-3 w-3 text-muted-foreground" />
                                <span className="break-words">
                                    {checkpoint.environment}
                                </span>
                            </div>
                        )}
                        {checkpoint.note && (
                            <p className="whitespace-pre-wrap break-words text-foreground">
                                {checkpoint.note}
                            </p>
                        )}
                        {!checkpoint.environment && !checkpoint.note && (
                            <p className="text-muted-foreground">
                                No additional details.
                            </p>
                        )}
                        <div className="flex items-center justify-between gap-2 border-t pt-2 text-[10px] text-muted-foreground">
                            <div className="flex items-center gap-1">
                                <UserCircle2 className="h-3 w-3" />
                                <span>
                                    {checkpoint.author?.name ||
                                        'Unknown author'}
                                </span>
                            </div>
                            {canDelete && (
                                <button
                                    type="button"
                                    onClick={handleDelete}
                                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-destructive hover:bg-destructive/10"
                                >
                                    <Trash2 className="h-3 w-3" />
                                    Delete
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

// ---------------------------------------------------------------------------
// Add-checkpoint dialog. Used by anyone with APP_CHECKPOINT_ADD —
// typically a regular USER who's been granted that one capability so
// they can log "I deployed v1.2.3 to prod cluster A at 02:13" without
// being able to declare phase changes themselves.
// ---------------------------------------------------------------------------
function CheckpointDialog({
    open,
    onOpenChange,
    appId,
    releases,
    initialReleaseId,
    onSaved,
}) {
    const [releaseId, setReleaseId] = useState('');
    const [kind, setKind] = useState('PROD_DEPLOY');
    const [environment, setEnvironment] = useState('');
    const [note, setNote] = useState('');
    const [occurredAt, setOccurredAt] = useState('');
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (!open) return;
        setReleaseId(initialReleaseId || releases?.[0]?.id || '');
        setKind('PROD_DEPLOY');
        setEnvironment('');
        setNote('');
        // Default to "now" in the local timezone, formatted for the
        // datetime-local input.
        const now = new Date();
        const tzOffset = now.getTimezoneOffset() * 60_000;
        setOccurredAt(
            new Date(now.getTime() - tzOffset)
                .toISOString()
                .slice(0, 16),
        );
    }, [open, initialReleaseId, releases]);

    const submit = async (e) => {
        e.preventDefault();
        if (!releaseId) {
            toast.error('Pick a release first');
            return;
        }
        setSubmitting(true);
        try {
            await api.post(
                `/applications/${appId}/releases/${releaseId}/checkpoints`,
                {
                    kind,
                    environment: environment.trim() || undefined,
                    note: note.trim() || undefined,
                    occurredAt: occurredAt
                        ? new Date(occurredAt).toISOString()
                        : undefined,
                },
            );
            toast.success('Checkpoint logged.');
            onSaved?.();
        } catch (err) {
            toast.error(
                err.response?.data?.error || 'Could not log checkpoint',
            );
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Add timeline checkpoint</DialogTitle>
                    <DialogDescription>
                        Record a real-world deployment, rollback, or
                        operational note against a specific release.
                        Useful for rollback decisions during incidents.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={submit} className="space-y-3 text-sm">
                    <div className="space-y-1">
                        <label className="text-xs font-medium">
                            Release
                        </label>
                        <select
                            value={releaseId}
                            onChange={(e) => setReleaseId(e.target.value)}
                            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                            required
                        >
                            {releases.map((r) => (
                                <option key={r.id} value={r.id}>
                                    v{r.version}
                                    {r.phase
                                        ? ` (${PHASE_LABEL[r.phase] || r.phase})`
                                        : ''}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="space-y-1">
                        <label className="text-xs font-medium">
                            Event type
                        </label>
                        <select
                            value={kind}
                            onChange={(e) => setKind(e.target.value)}
                            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                        >
                            <option value="PROD_DEPLOY">
                                Deployed to production
                            </option>
                            <option value="PROD_ROLLBACK">
                                Rolled back from production
                            </option>
                            <option value="PILOT_DEPLOY">
                                Pilot deployment
                            </option>
                            <option value="TEST_DEPLOY">
                                Test deployment
                            </option>
                            <option value="NOTE">
                                Operational note
                            </option>
                        </select>
                    </div>
                    <div className="space-y-1">
                        <label className="text-xs font-medium">
                            When did it happen?
                        </label>
                        <input
                            type="datetime-local"
                            value={occurredAt}
                            onChange={(e) => setOccurredAt(e.target.value)}
                            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                            required
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-xs font-medium">
                            Environment / network (optional)
                        </label>
                        <input
                            value={environment}
                            onChange={(e) => setEnvironment(e.target.value)}
                            placeholder="e.g. EU-prod cluster A, merchant fleet 1200"
                            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-xs font-medium">
                            Note (optional)
                        </label>
                        <Textarea
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="Anything worth knowing for a future rollback investigation."
                            rows={3}
                        />
                    </div>
                    {kind === 'PROD_ROLLBACK' && (
                        <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
                            <AlertTriangle className="-mt-0.5 mr-1 inline h-3.5 w-3.5" />
                            Rollback checkpoints are highlighted in red on
                            the timeline so they're easy to spot during
                            post-mortems.
                        </div>
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
                            {submitting && (
                                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            )}
                            Log checkpoint
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
