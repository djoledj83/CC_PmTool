import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Pencil, Trash2, Check, X, GitBranch, ListChecks } from 'lucide-react';

import { api } from '@/lib/api';
import { cn, flashDeepLinkTarget, initials, resolveAssetUrl } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/contexts/AuthContext';
import { useRealtime } from '@/contexts/RealtimeContext';
import { MentionTextarea } from '@/components/MentionTextarea';
import { renderWithMentions } from '@/lib/mentions';
import { NoteAttachmentsField, NoteAttachmentsList } from '@/components/NoteAttachments';

function formatTimestamp(d) {
    if (!d) return '';
    return format(new Date(d), "MMM d, yyyy 'at' h:mm a");
}

export function NotesPanel({ projectId, changeRequestId = null }) {
    const { user: currentUser } = useAuth();
    const isAdmin = currentUser?.role === 'ADMIN';
    // CR mode collapses two ideas at once:
    //   - the GET filter narrows to notes "about" this CR
    //     (direct CR pin + notes on CR-scoped tasks)
    //   - new notes from this panel auto-stamp the CR id so they
    //     show up here on next reload too
    // Outside CR mode the panel keeps its original "whole project"
    // semantics — same code path, just no CR scoping.
    const crMode = Boolean(changeRequestId);
    const [notes, setNotes] = useState([]);
    const [loading, setLoading] = useState(true);
    const [draft, setDraft] = useState('');
    // Files staged for the new note. Each item is a saved FileAttachment
    // returned by /files (so it already has a signed URL). On submit we
    // pass their ids to /notes which "claims" them for the new note.
    const [draftFiles, setDraftFiles] = useState([]);
    const [submitting, setSubmitting] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [editingContent, setEditingContent] = useState('');
    const [editingFiles, setEditingFiles] = useState([]);
    const draftRef = useRef(null);

    // Task pinning: which task (or subtask) the new note is attached to.
    // 'project' means a project-wide note (no taskId on the backend) —
    // in CR mode the same sentinel means "whole CR" (no taskId, but
    // changeRequestId is still stamped on submit).
    const [draftTaskId, setDraftTaskId] = useState('project');
    // Filter the visible notes: 'all' | 'project' | <taskId>
    const [filterTaskId, setFilterTaskId] = useState('all');
    const [tasks, setTasks] = useState([]);
    // Project participants drive the @-mention picker. Loaded once
    // per project; failures degrade to "no suggestions".
    const [participants, setParticipants] = useState([]);

    // Deep-link from a notification: when the URL hash is `#note-<id>`,
    // scroll the matching row into view (after the notes have loaded)
    // and briefly highlight it. We track the last-handled hash so
    // re-renders don't keep re-scrolling.
    const location = useLocation();
    const handledNoteHashRef = useRef(null);
    useEffect(() => {
        if (!notes.length) return undefined;
        const hash = location.hash || '';
        const m = hash.match(/^#note-(.+)$/);
        if (!m) return undefined;
        if (handledNoteHashRef.current === hash) return undefined;
        const id = m[1];
        if (!notes.some((n) => n.id === id)) return undefined;
        handledNoteHashRef.current = hash;
        let cancelHighlight = () => {};
        const t = setTimeout(() => {
            const el = document.getElementById(`note-${id}`);
            if (!el) return;
            cancelHighlight = flashDeepLinkTarget(el);
        }, 60);
        return () => {
            clearTimeout(t);
            cancelHighlight();
        };
    }, [notes, location.hash]);
    useEffect(() => {
        // Reset on project switch so navigating away and back honours the hash.
        handledNoteHashRef.current = null;
    }, [projectId]);

    // Build a "parent + indented subtasks" list for the picker. Tasks come
    // back flat from /tasks, so we group children under their parent here.
    const taskTree = useMemo(() => {
        const parents = tasks.filter((t) => !t.parentTaskId);
        const childrenByParent = tasks.reduce((acc, t) => {
            if (t.parentTaskId) {
                if (!acc[t.parentTaskId]) acc[t.parentTaskId] = [];
                acc[t.parentTaskId].push(t);
            }
            return acc;
        }, {});
        return parents
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .flatMap((p) => [
                { ...p, depth: 0 },
                ...(childrenByParent[p.id] || [])
                    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
                    .map((c) => ({ ...c, depth: 1 })),
            ]);
    }, [tasks]);

    // Counter that we bump whenever the realtime layer tells us the
    // notes list might be stale (someone in another tab added / edited
    // / deleted a note). Adding it to the load effect's deps re-fetches.
    const [refreshTick, setRefreshTick] = useState(0);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            try {
                const params = { projectId };
                if (crMode) params.changeRequestId = changeRequestId;
                if (filterTaskId === 'project') params.taskId = 'none';
                else if (filterTaskId !== 'all') params.taskId = filterTaskId;
                const { data } = await api.get('/notes', { params });
                if (!cancelled) setNotes(data.notes);
            } catch (err) {
                toast.error(err.response?.data?.error || 'Failed to load notes');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [projectId, changeRequestId, crMode, filterTaskId, refreshTick]);

    // Live note updates. ProjectDetail joins/leaves the project room
    // already (via PhasesPlan), but we still subscribe directly so the
    // notes panel reacts even when the user opened straight to the
    // Notes tab. We debounce-via-tick so a burst of events triggers a
    // single refetch.
    const { subscribe } = useRealtime();
    useEffect(() => {
        if (!projectId) return undefined;
        const unsubscribe = subscribe('project:plan-changed', (payload) => {
            if (payload?.projectId !== projectId) return;
            if (
                payload.kind !== 'note-added' &&
                payload.kind !== 'note-updated' &&
                payload.kind !== 'note-deleted'
            ) {
                return;
            }
            setRefreshTick((n) => n + 1);
        });
        return unsubscribe;
    }, [projectId, subscribe]);

    // Tasks list for the picker. Loaded once per project. In CR mode
    // we filter down to tasks scoped to this CR so the "About" picker
    // doesn't offer pinning a CR note to an unrelated project task.
    useEffect(() => {
        let cancelled = false;
        const params = { projectId };
        if (crMode) params.changeRequestId = changeRequestId;
        api.get('/tasks', { params })
            .then((res) => {
                if (!cancelled) setTasks(res.data.tasks || []);
            })
            .catch(() => {
                /* picker just stays empty */
            });
        return () => {
            cancelled = true;
        };
    }, [projectId, changeRequestId, crMode]);

    // Project participants for the @-mention picker.
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

    const submitNote = async () => {
        const content = draft.trim();
        if (!content) return;
        setSubmitting(true);
        try {
            const payload = {
                projectId,
                content,
                taskId: draftTaskId === 'project' ? null : draftTaskId,
                // In CR mode every new note from this panel is stamped
                // with the CR id, even when the "About" picker points
                // at a CR task — the backend reconciles the two and
                // rejects mismatches.
                changeRequestId: crMode ? changeRequestId : undefined,
                fileIds: draftFiles.map((f) => f.id),
            };
            const { data } = await api.post('/notes', payload);
            // If the visible filter excludes this note, skip the optimistic
            // insert so the user sees a consistent list.
            const matchesFilter =
                filterTaskId === 'all' ||
                (filterTaskId === 'project' && !data.note.taskId) ||
                filterTaskId === data.note.taskId;
            if (matchesFilter) {
                setNotes((prev) => [data.note, ...prev]);
            }
            setDraft('');
            setDraftFiles([]);
            draftRef.current?.focus();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not save note');
        } finally {
            setSubmitting(false);
        }
    };

    const startEdit = (note) => {
        setEditingId(note.id);
        setEditingContent(note.content);
        setEditingFiles(note.files || []);
    };

    const cancelEdit = () => {
        setEditingId(null);
        setEditingContent('');
        setEditingFiles([]);
    };

    const saveEdit = async () => {
        const content = editingContent.trim();
        if (!content) return;
        try {
            const { data } = await api.patch(`/notes/${editingId}`, {
                content,
                fileIds: editingFiles.map((f) => f.id),
            });
            setNotes((prev) => prev.map((n) => (n.id === editingId ? data.note : n)));
            cancelEdit();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not update note');
        }
    };

    const deleteNote = async (note) => {
        if (!window.confirm('Delete this note?')) return;
        try {
            await api.delete(`/notes/${note.id}`);
            setNotes((prev) => prev.filter((n) => n.id !== note.id));
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not delete note');
        }
    };

    return (
        <div className="space-y-4">
            <div className="rounded-lg border bg-card p-3">
                <MentionTextarea
                    ref={draftRef}
                    rows={3}
                    placeholder="Take a note... type @ to mention a participant or / to link a task"
                    slashProjectId={projectId}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    participants={participants}
                    className="resize-none border-none px-1 shadow-none focus-visible:ring-0"
                />
                <div className="mt-2">
                    <NoteAttachmentsField
                        projectId={projectId}
                        files={draftFiles}
                        onChange={setDraftFiles}
                        disabled={submitting}
                    />
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                            About:
                        </span>
                        <Select
                            value={draftTaskId}
                            onValueChange={setDraftTaskId}
                        >
                            <SelectTrigger className="h-8 w-[260px] text-xs">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="project">
                                    {crMode ? 'Whole change request' : 'Whole project'}
                                </SelectItem>
                                {taskTree.map((t) => (
                                    <SelectItem key={t.id} value={t.id}>
                                        <span
                                            className={cn(
                                                'inline-flex items-center gap-1',
                                                t.depth === 1 && 'pl-3 text-muted-foreground',
                                            )}
                                        >
                                            {t.depth === 1 && (
                                                <GitBranch className="h-3 w-3" />
                                            )}
                                            {t.title}
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <Button
                        size="sm"
                        onClick={submitNote}
                        disabled={submitting || !draft.trim()}
                    >
                        {submitting ? 'Saving...' : 'Add note'}
                    </Button>
                </div>
            </div>

            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ListChecks className="h-3.5 w-3.5" />
                    <span>Show:</span>
                </div>
                <Select value={filterTaskId} onValueChange={setFilterTaskId}>
                    <SelectTrigger className="h-8 w-[260px] text-xs">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All notes</SelectItem>
                        <SelectItem value="project">
                            {crMode
                                ? 'CR-wide notes only'
                                : 'Project-wide notes only'}
                        </SelectItem>
                        {taskTree.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                                <span
                                    className={cn(
                                        'inline-flex items-center gap-1',
                                        t.depth === 1 && 'pl-3 text-muted-foreground',
                                    )}
                                >
                                    {t.depth === 1 && (
                                        <GitBranch className="h-3 w-3" />
                                    )}
                                    {t.title}
                                </span>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {loading ? (
                <p className="text-sm text-muted-foreground">Loading notes...</p>
            ) : notes.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No notes yet.
                </p>
            ) : (
                <ul className="space-y-3">
                    {notes.map((note) => {
                        // Edit/delete is admin-only under the new policy.
                        // Authors can still add new notes; corrections must
                        // go through a follow-up note.
                        const canEdit = isAdmin;
                        const canDelete = isAdmin;
                        const isEditing = editingId === note.id;
                        return (
                            <li
                                key={note.id}
                                id={`note-${note.id}`}
                                className="scroll-mt-24 rounded-md border border-amber-200 bg-amber-50 p-3 shadow-sm transition-shadow dark:border-amber-400/20 dark:bg-amber-400/10"
                            >
                                <div className="flex items-start gap-3">
                                    <Avatar className="h-8 w-8">
                                        {note.author?.avatarUrl && (
                                            <AvatarImage
                                                src={resolveAssetUrl(
                                                    note.author.avatarUrl,
                                                )}
                                                alt={note.author.name}
                                            />
                                        )}
                                        <AvatarFallback className="bg-primary/10 text-xs text-primary">
                                            {initials(note.author?.name)}
                                        </AvatarFallback>
                                    </Avatar>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                                            <span className="font-medium text-foreground">
                                                {note.author?.name || 'Unknown'}
                                            </span>
                                            <span>·</span>
                                            <span>{formatTimestamp(note.createdAt)}</span>
                                            {note.updatedAt &&
                                                note.updatedAt !== note.createdAt && (
                                                    <span className="italic">
                                                        (edited{' '}
                                                        {formatTimestamp(
                                                            note.updatedAt,
                                                        )}
                                                        )
                                                    </span>
                                                )}
                                            {note.task ? (
                                                <Link
                                                    to={`/projects/${projectId}#task-${note.task.id}`}
                                                    title="Open this task in the plan"
                                                    className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-amber-900 transition-colors hover:border-amber-400 hover:bg-amber-100 dark:border-amber-400/30 dark:bg-amber-400/15 dark:text-amber-200 dark:hover:bg-amber-400/25"
                                                >
                                                    {note.task.parent ? (
                                                        <GitBranch className="h-3 w-3" />
                                                    ) : (
                                                        <ListChecks className="h-3 w-3" />
                                                    )}
                                                    {note.task.parent
                                                        ? `${note.task.parent.title} / ${note.task.title}`
                                                        : note.task.title}
                                                </Link>
                                            ) : null}
                                        </div>
                                        {isEditing ? (
                                            <div className="mt-2 space-y-2">
                                                <MentionTextarea
                                                    rows={3}
                                                    value={editingContent}
                                                    onChange={(e) =>
                                                        setEditingContent(
                                                            e.target.value,
                                                        )
                                                    }
                                                    participants={participants}
                                                    slashProjectId={projectId}
                                                    className="bg-white dark:bg-background"
                                                />
                                                <NoteAttachmentsField
                                                    projectId={projectId}
                                                    noteId={note.id}
                                                    files={editingFiles}
                                                    onChange={setEditingFiles}
                                                />
                                                <div className="flex justify-end gap-2">
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="gap-1"
                                                        onClick={cancelEdit}
                                                    >
                                                        <X className="h-3.5 w-3.5" />
                                                        Cancel
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        className="gap-1"
                                                        onClick={saveEdit}
                                                    >
                                                        <Check className="h-3.5 w-3.5" />
                                                        Save
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : (
                                            <>
                                                <p className="mt-1 whitespace-pre-wrap text-sm">
                                                    {renderWithMentions(
                                                        note.content,
                                                        participants,
                                                    )}
                                                </p>
                                                <NoteAttachmentsList
                                                    files={note.files || []}
                                                />
                                            </>
                                        )}
                                    </div>
                                    {!isEditing && (canEdit || canDelete) && (
                                        <div className="flex shrink-0 items-center gap-1">
                                            {canEdit && (
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    className="h-7 w-7"
                                                    onClick={() => startEdit(note)}
                                                >
                                                    <Pencil className="h-3.5 w-3.5" />
                                                </Button>
                                            )}
                                            {canDelete && (
                                                <Button
                                                    size="icon"
                                                    variant="ghost"
                                                    className="h-7 w-7 text-destructive hover:text-destructive"
                                                    onClick={() => deleteNote(note)}
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </Button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
