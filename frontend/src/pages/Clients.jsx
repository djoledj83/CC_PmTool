import { useEffect, useMemo, useState } from 'react';
import { Building2, Mail, MapPin, Pencil, Phone, Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { TopBar } from '@/components/TopBar';
import { ClientFormDialog } from '@/components/ClientFormDialog';
import { Pagination, usePagination } from '@/components/Pagination';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';

export default function Clients() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'ADMIN';
    const canManage = isAdmin;

    const [clients, setClients] = useState([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState(null);
    const [submitting, setSubmitting] = useState(false);

    const load = async () => {
        setLoading(true);
        try {
            const { data } = await api.get('/clients', {
                params: canManage ? { includeInactive: 1 } : {},
            });
            setClients(data.clients || []);
        } catch {
            toast.error('Failed to load clients');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return clients;
        return clients.filter((c) => {
            const hay = [
                c.name,
                c.country,
                c.city,
                c.email,
                ...(c.contacts || []).map((x) => `${x.name} ${x.email}`),
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return hay.includes(q);
        });
    }, [clients, query]);

    const handleCreate = () => {
        setEditing(null);
        setDialogOpen(true);
    };

    const handleEdit = (client) => {
        setEditing(client);
        setDialogOpen(true);
    };

    const handleDelete = async (client) => {
        if (
            !window.confirm(
                `Delete client "${client.name}"? This cannot be undone.`,
            )
        ) {
            return;
        }
        try {
            await api.delete(`/clients/${client.id}`);
            toast.success('Client deleted');
            load();
        } catch (err) {
            toast.error(err.response?.data?.error || 'Delete failed');
        }
    };

    const primaryContact = (client) =>
        (client.contacts || []).find((c) => c.isPrimary) ||
        client.contacts?.[0] ||
        null;

    const { page, setPage, pageSize, total, totalPages, pageItems } =
        usePagination(filtered, 10);

    return (
        <>
            <TopBar
                title="Clients"
                actions={
                    canManage ? (
                        <Button onClick={handleCreate} className="gap-2">
                            <Plus className="h-4 w-4" />
                            New client
                        </Button>
                    ) : null
                }
            />
            <main className="flex-1 overflow-auto bg-muted/20 p-3 sm:p-6">
                <div className="w-full space-y-4">
                    <p className="text-sm text-muted-foreground">
                        Company clients linked to projects. Selecting a client
                        when creating a project fills country automatically.
                    </p>
                    <div className="relative max-w-md">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search clients…"
                            className="pl-9"
                        />
                    </div>

                    <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
                        {loading ? (
                            <p className="p-8 text-center text-sm text-muted-foreground">
                                Loading clients…
                            </p>
                        ) : filtered.length === 0 ? (
                            <div className="flex flex-col items-center gap-2 p-12 text-center">
                                <Building2 className="h-10 w-10 text-muted-foreground/50" />
                                <p className="text-sm font-medium">No clients yet</p>
                                {canManage && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleCreate}
                                    >
                                        Add your first client
                                    </Button>
                                )}
                            </div>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow className="bg-muted/60 hover:bg-muted/60">
                                        <TableHead>Client</TableHead>
                                        <TableHead>Location</TableHead>
                                        <TableHead>Main contact</TableHead>
                                        <TableHead className="text-right">
                                            Projects
                                        </TableHead>
                                        {canManage && (
                                            <TableHead className="w-[100px]" />
                                        )}
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {pageItems.map((c, idx) => {
                                        const contact = primaryContact(c);
                                        return (
                                            <TableRow
                                                key={c.id}
                                                className={
                                                    idx % 2 === 1
                                                        ? 'bg-muted/30'
                                                        : undefined
                                                }
                                            >
                                                <TableCell>
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-medium">
                                                            {c.name}
                                                        </span>
                                                        {!c.isActive && (
                                                            <Badge
                                                                variant="outline"
                                                                className="text-[10px]"
                                                            >
                                                                Inactive
                                                            </Badge>
                                                        )}
                                                    </div>
                                                    {c.email && (
                                                        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                                                            <Mail className="h-3 w-3" />
                                                            {c.email}
                                                        </p>
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-sm text-muted-foreground">
                                                    {[c.city, c.country]
                                                        .filter(Boolean)
                                                        .join(', ') || '—'}
                                                    {c.address && (
                                                        <p className="mt-0.5 flex items-start gap-1 text-xs">
                                                            <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                                                            <span className="line-clamp-2">
                                                                {c.address}
                                                            </span>
                                                        </p>
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-sm">
                                                    {contact ? (
                                                        <div>
                                                            <p>{contact.name}</p>
                                                            {contact.phone && (
                                                                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                                                                    <Phone className="h-3 w-3" />
                                                                    {contact.phone}
                                                                </p>
                                                            )}
                                                        </div>
                                                    ) : (
                                                        '—'
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-right tabular-nums">
                                                    {c._count?.projects ?? 0}
                                                </TableCell>
                                                {canManage && (
                                                    <TableCell className="text-right">
                                                        <div className="flex justify-end gap-1">
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-8 w-8"
                                                                onClick={() =>
                                                                    handleEdit(c)
                                                                }
                                                            >
                                                                <Pencil className="h-4 w-4" />
                                                            </Button>
                                                            {user?.role ===
                                                                'ADMIN' && (
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-8 w-8 text-destructive"
                                                                    onClick={() =>
                                                                        handleDelete(
                                                                            c,
                                                                        )
                                                                    }
                                                                >
                                                                    <Trash2 className="h-4 w-4" />
                                                                </Button>
                                                            )}
                                                        </div>
                                                    </TableCell>
                                                )}
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        )}
                        {!loading && total > 0 && (
                            <Pagination
                                page={page}
                                pageSize={pageSize}
                                total={total}
                                totalPages={totalPages}
                                onPageChange={setPage}
                            />
                        )}
                    </div>
                </div>
            </main>

            <ClientFormDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                initialValues={editing}
                onSaved={() => load()}
                submitting={submitting}
                setSubmitting={setSubmitting}
            />
        </>
    );
}
