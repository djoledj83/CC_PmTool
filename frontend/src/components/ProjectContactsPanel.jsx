import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
    Building2,
    ChevronDown,
    ChevronRight,
    Contact,
    Mail,
    Pencil,
    Phone,
    Plus,
    Trash2,
    User as UserIcon,
} from 'lucide-react';

import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

// "Important contacts" — external (non-system) people attached to a
// project. Lives next to participants/teams on the project detail page.
//
// Permissions mirror the backend: anyone with project access can read,
// admins/managers + the project owner can add/edit/delete. We hide the
// management buttons for everyone else so the UI doesn't lie about
// what's available.
export function ProjectContactsPanel({
    project,
    collapsed = false,
    onToggleCollapsed,
}) {
    const { user } = useAuth();
    const projectId = project?.id;
    const ownerId = project?.ownerId;

    const role = user?.role;
    const canManage =
        !!user &&
        (role === 'ADMIN' ||
            role === 'MANAGER' ||
            (ownerId && ownerId === user.id));

    const [contacts, setContacts] = useState([]);
    const [loading, setLoading] = useState(true);
    const [dialog, setDialog] = useState({ open: false, contact: null });

    const refresh = async () => {
        if (!projectId) return;
        try {
            const res = await api.get('/project-contacts', {
                params: { projectId },
            });
            setContacts(res.data?.contacts || []);
        } catch {
            toast.error('Could not load project contacts');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setLoading(true);
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectId]);

    const handleDelete = async (contact) => {
        const ok = window.confirm(
            `Remove "${contact.name}" from this project's contacts?`,
        );
        if (!ok) return;
        try {
            await api.delete(`/project-contacts/${contact.id}`);
            setContacts((prev) => prev.filter((c) => c.id !== contact.id));
            toast.success('Contact removed');
        } catch {
            toast.error('Could not remove contact');
        }
    };

    return (
        <>
            <Card>
                <CardHeader className="pb-2">
                    <div className="flex items-center justify-between gap-2">
                        <button
                            type="button"
                            onClick={onToggleCollapsed}
                            className="flex flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-accent/50"
                        >
                            {collapsed ? (
                                <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            ) : (
                                <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            )}
                            <Contact className="h-4 w-4 text-muted-foreground" />
                            <CardTitle className="text-sm font-semibold">
                                Important contacts
                            </CardTitle>
                            <span className="ml-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                                {contacts.length}
                            </span>
                        </button>
                        {canManage && !collapsed && (
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1 px-2 text-xs"
                                onClick={() =>
                                    setDialog({ open: true, contact: null })
                                }
                            >
                                <Plus className="h-3.5 w-3.5" />
                                Add
                            </Button>
                        )}
                    </div>
                </CardHeader>
                {!collapsed && (
                    <CardContent className="space-y-2">
                        {loading ? (
                            <p className="text-xs text-muted-foreground">
                                Loading…
                            </p>
                        ) : contacts.length === 0 ? (
                            <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                                No external contacts yet.
                                {canManage && (
                                    <>
                                        {' '}Use{' '}
                                        <span className="font-medium text-foreground">
                                            Add
                                        </span>{' '}
                                        to record a client representative,
                                        vendor PM, stakeholder, etc.
                                    </>
                                )}
                            </p>
                        ) : (
                            <ul className="space-y-2">
                                {contacts.map((c) => (
                                    <ContactRow
                                        key={c.id}
                                        contact={c}
                                        canManage={canManage}
                                        onEdit={() =>
                                            setDialog({ open: true, contact: c })
                                        }
                                        onDelete={() => handleDelete(c)}
                                    />
                                ))}
                            </ul>
                        )}
                    </CardContent>
                )}
            </Card>

            <ContactFormDialog
                open={dialog.open}
                contact={dialog.contact}
                projectId={projectId}
                onClose={() => setDialog({ open: false, contact: null })}
                onSaved={(saved, isCreate) => {
                    setContacts((prev) => {
                        if (isCreate) return [...prev, saved];
                        return prev.map((c) => (c.id === saved.id ? saved : c));
                    });
                    setDialog({ open: false, contact: null });
                }}
            />
        </>
    );
}

function ContactRow({ contact, canManage, onEdit, onDelete }) {
    return (
        <li className="rounded-md border bg-card/50 px-3 py-2 text-xs">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm font-semibold text-foreground">
                            {contact.name}
                        </span>
                        {contact.role && (
                            <span className="text-[11px] text-muted-foreground">
                                {contact.role}
                            </span>
                        )}
                    </div>
                    {contact.company && (
                        <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Building2 className="h-3 w-3" />
                            {contact.company}
                        </div>
                    )}
                    <div className="mt-1 flex flex-col gap-1 text-[11px] text-foreground/80">
                        {contact.email && (
                            <a
                                href={`mailto:${contact.email}`}
                                className="inline-flex items-center gap-1 hover:underline"
                            >
                                <Mail className="h-3 w-3 text-muted-foreground" />
                                <span className="truncate">
                                    {contact.email}
                                </span>
                            </a>
                        )}
                        {contact.phone && (
                            <a
                                href={`tel:${contact.phone.replace(/\s+/g, '')}`}
                                className="inline-flex items-center gap-1 hover:underline"
                            >
                                <Phone className="h-3 w-3 text-muted-foreground" />
                                <span className="truncate">
                                    {contact.phone}
                                </span>
                            </a>
                        )}
                    </div>
                    {contact.notes && (
                        <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] leading-snug text-muted-foreground">
                            {contact.notes}
                        </p>
                    )}
                    {contact.createdBy?.name && (
                        <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground/80">
                            <UserIcon className="h-3 w-3" />
                            Added by {contact.createdBy.name}
                        </p>
                    )}
                </div>
                {canManage && (
                    <div className="flex shrink-0 items-center gap-1">
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="Edit contact"
                            onClick={onEdit}
                        >
                            <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            title="Remove contact"
                            onClick={onDelete}
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                )}
            </div>
        </li>
    );
}

function ContactFormDialog({ open, contact, projectId, onClose, onSaved }) {
    const isEdit = !!contact;
    const [form, setForm] = useState(() => ({
        name: '',
        role: '',
        company: '',
        email: '',
        phone: '',
        notes: '',
    }));
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open) return;
        setForm({
            name: contact?.name || '',
            role: contact?.role || '',
            company: contact?.company || '',
            email: contact?.email || '',
            phone: contact?.phone || '',
            notes: contact?.notes || '',
        });
    }, [open, contact]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!form.name.trim()) {
            toast.error('Contact name is required');
            return;
        }
        setSaving(true);
        try {
            if (isEdit) {
                const res = await api.patch(
                    `/project-contacts/${contact.id}`,
                    form,
                );
                toast.success('Contact updated');
                onSaved?.(res.data.contact, false);
            } else {
                const res = await api.post('/project-contacts', {
                    ...form,
                    projectId,
                });
                toast.success('Contact added');
                onSaved?.(res.data.contact, true);
            }
        } catch (err) {
            const msg =
                err.response?.data?.error?.message ||
                err.response?.data?.message ||
                'Could not save contact';
            toast.error(msg);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {isEdit ? 'Edit contact' : 'Add contact'}
                    </DialogTitle>
                    <DialogDescription>
                        External people relevant to this project — clients,
                        vendors, stakeholders. Visible to everyone with
                        project access.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="space-y-3"
                    onSubmit={handleSubmit}
                    autoComplete="off"
                >
                    <div className="space-y-1">
                        <Label htmlFor="contact-name">
                            Name <span className="text-destructive">*</span>
                        </Label>
                        <Input
                            id="contact-name"
                            value={form.name}
                            onChange={(e) =>
                                setForm((f) => ({ ...f, name: e.target.value }))
                            }
                            required
                            maxLength={200}
                            autoFocus
                        />
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="space-y-1">
                            <Label htmlFor="contact-role">Role / title</Label>
                            <Input
                                id="contact-role"
                                value={form.role}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        role: e.target.value,
                                    }))
                                }
                                placeholder="e.g. Client PM"
                                maxLength={2000}
                            />
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="contact-company">Company</Label>
                            <Input
                                id="contact-company"
                                value={form.company}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        company: e.target.value,
                                    }))
                                }
                                maxLength={2000}
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="space-y-1">
                            <Label htmlFor="contact-email">Email</Label>
                            <Input
                                id="contact-email"
                                type="email"
                                value={form.email}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        email: e.target.value,
                                    }))
                                }
                                maxLength={320}
                            />
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="contact-phone">Phone</Label>
                            <Input
                                id="contact-phone"
                                value={form.phone}
                                onChange={(e) =>
                                    setForm((f) => ({
                                        ...f,
                                        phone: e.target.value,
                                    }))
                                }
                                maxLength={2000}
                            />
                        </div>
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor="contact-notes">Notes</Label>
                        <Textarea
                            id="contact-notes"
                            value={form.notes}
                            onChange={(e) =>
                                setForm((f) => ({
                                    ...f,
                                    notes: e.target.value,
                                }))
                            }
                            placeholder="e.g. Prefers Slack, available CET mornings."
                            rows={3}
                            maxLength={2000}
                        />
                    </div>
                    <DialogFooter className="gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={onClose}
                            disabled={saving}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {saving
                                ? 'Saving…'
                                : isEdit
                                  ? 'Save'
                                  : 'Add contact'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
