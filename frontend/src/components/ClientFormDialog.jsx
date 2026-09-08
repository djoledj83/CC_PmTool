import { useEffect, useState } from 'react';
import { Plus, Star, Trash2, Check } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
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
import { useCountries } from '@/lib/catalogs';
import { MultiSelectDropdown } from '@/components/MultiSelectDropdown';

const emptyContact = () => ({
    name: '',
    email: '',
    phone: '',
    role: '',
    isPrimary: false,
});

export function ClientFormDialog({
    open,
    onOpenChange,
    initialValues,
    onSaved,
    submitting,
    setSubmitting,
}) {
    const { items: countryOptions } = useCountries();
    const isEdit = Boolean(initialValues?.id);

    const [name, setName] = useState('');
    const [address, setAddress] = useState('');
    const [city, setCity] = useState('');
    const [postalCode, setPostalCode] = useState('');
    const [country, setCountry] = useState('');
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const [website, setWebsite] = useState('');
    const [notes, setNotes] = useState('');
    const [isActive, setIsActive] = useState(true);
    const [contacts, setContacts] = useState([emptyContact()]);
    // Ticket types this client's external users may raise.
    const [ticketTypes, setTicketTypes] = useState([]);
    const [ticketTypeIds, setTicketTypeIds] = useState([]);

    useEffect(() => {
        if (!open) return;
        api.get('/ticket-request-types', { params: { active: 1 } })
            .then(({ data }) => setTicketTypes(data.requestTypes || []))
            .catch(() => setTicketTypes([]));
        setTicketTypeIds(initialValues?.ticketTypeIds || []);
        // The client list payload omits the allowed types — fetch the
        // detail when editing to get the current selection.
        if (initialValues?.id) {
            api.get(`/clients/${initialValues.id}`)
                .then(({ data }) =>
                    setTicketTypeIds(data.client?.ticketTypeIds || []),
                )
                .catch(() => {});
        }
    }, [open, initialValues]);

    const toggleTicketType = (id) =>
        setTicketTypeIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );

    useEffect(() => {
        if (!open) return;
        setName(initialValues?.name || '');
        setAddress(initialValues?.address || '');
        setCity(initialValues?.city || '');
        setPostalCode(initialValues?.postalCode || '');
        setCountry(initialValues?.country || '');
        setPhone(initialValues?.phone || '');
        setEmail(initialValues?.email || '');
        setWebsite(initialValues?.website || '');
        setNotes(initialValues?.notes || '');
        setIsActive(initialValues?.isActive !== false);
        const list = initialValues?.contacts?.length
            ? initialValues.contacts.map((c) => ({
                  name: c.name || '',
                  email: c.email || '',
                  phone: c.phone || '',
                  role: c.role || '',
                  isPrimary: Boolean(c.isPrimary),
              }))
            : [emptyContact()];
        setContacts(list);
    }, [open, initialValues]);

    const updateContact = (idx, patch) => {
        setContacts((prev) =>
            prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
        );
    };

    const setPrimaryContact = (idx) => {
        setContacts((prev) =>
            prev.map((c, i) => ({ ...c, isPrimary: i === idx })),
        );
    };

    const addContact = () => {
        setContacts((prev) => [...prev, emptyContact()]);
    };

    const removeContact = (idx) => {
        setContacts((prev) =>
            prev.length <= 1 ? [emptyContact()] : prev.filter((_, i) => i !== idx),
        );
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!name.trim()) {
            toast.error('Client name is required');
            return;
        }
        const payload = {
            name: name.trim(),
            address: address.trim() || null,
            city: city.trim() || null,
            postalCode: postalCode.trim() || null,
            country: country.trim() || null,
            phone: phone.trim() || null,
            email: email.trim() || null,
            website: website.trim() || null,
            notes: notes.trim() || null,
            isActive,
            contacts: contacts
                .map((c) => ({
                    name: c.name.trim(),
                    email: c.email.trim() || null,
                    phone: c.phone.trim() || null,
                    role: c.role.trim() || null,
                    isPrimary: Boolean(c.isPrimary),
                }))
                .filter((c) => c.name),
            ticketTypeIds,
        };
        setSubmitting(true);
        try {
            const { data } = isEdit
                ? await api.patch(`/clients/${initialValues.id}`, payload)
                : await api.post('/clients', payload);
            toast.success(isEdit ? 'Client updated' : 'Client created');
            onSaved(data.client);
            onOpenChange(false);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Save failed');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{isEdit ? 'Edit client' : 'New client'}</DialogTitle>
                    <DialogDescription>
                        Company client record used when creating projects.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    {/* Entity 1 — client info. */}
                    <div className="space-y-3 rounded-lg border border-emerald-500/15 bg-emerald-500/5 p-3">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Client info
                        </p>
                        <div className="space-y-1.5">
                            <Label htmlFor="client-name">Name *</Label>
                            <Input
                                id="client-name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                autoFocus
                            />
                        </div>
                        {/* Address (tall, left) · Country + City/Postal (right). */}
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="flex flex-col space-y-1.5">
                                <Label htmlFor="client-address">Address</Label>
                                <Textarea
                                    id="client-address"
                                    value={address}
                                    onChange={(e) => setAddress(e.target.value)}
                                    className="flex-1"
                                    rows={5}
                                />
                            </div>
                            <div className="space-y-3">
                                <div className="space-y-1.5">
                                    <Label>Country</Label>
                                    <Select
                                        value={country || '__none__'}
                                        onValueChange={(v) =>
                                            setCountry(v === '__none__' ? '' : v)
                                        }
                                    >
                                        <SelectTrigger>
                                            <SelectValue placeholder="Select country" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="__none__">
                                                — None —
                                            </SelectItem>
                                            {countryOptions.map((c) => (
                                                <SelectItem
                                                    key={c.id}
                                                    value={c.name}
                                                >
                                                    {c.name}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <Label htmlFor="client-city">City</Label>
                                        <Input
                                            id="client-city"
                                            value={city}
                                            onChange={(e) =>
                                                setCity(e.target.value)
                                            }
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label htmlFor="client-postal">
                                            Postal code
                                        </Label>
                                        <Input
                                            id="client-postal"
                                            value={postalCode}
                                            onChange={(e) =>
                                                setPostalCode(e.target.value)
                                            }
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                        {/* Phone · Email · Website — one row. */}
                        <div className="grid gap-3 sm:grid-cols-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="client-phone">Phone</Label>
                                <Input
                                    id="client-phone"
                                    value={phone}
                                    onChange={(e) => setPhone(e.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="client-email">Email</Label>
                                <Input
                                    id="client-email"
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="client-website">Website</Label>
                                <Input
                                    id="client-website"
                                    value={website}
                                    onChange={(e) => setWebsite(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>

                    {/* Entity 2 — main contacts. */}
                    <div className="space-y-2 rounded-lg border border-amber-500/15 bg-amber-500/5 p-3">
                        <div className="flex items-center justify-between">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                Main contacts
                            </p>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 gap-1"
                                onClick={addContact}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                Add
                            </Button>
                        </div>
                        <ul className="space-y-2">
                            {contacts.map((c, idx) => (
                                <li
                                    key={idx}
                                    className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2"
                                >
                                    <Input
                                        placeholder="Name *"
                                        className="min-w-[120px] flex-1"
                                        value={c.name}
                                        onChange={(e) =>
                                            updateContact(idx, {
                                                name: e.target.value,
                                            })
                                        }
                                    />
                                    <Input
                                        placeholder="Role / title"
                                        className="min-w-[110px] flex-1"
                                        value={c.role}
                                        onChange={(e) =>
                                            updateContact(idx, {
                                                role: e.target.value,
                                            })
                                        }
                                    />
                                    <Input
                                        placeholder="Email"
                                        className="min-w-[140px] flex-1"
                                        value={c.email}
                                        onChange={(e) =>
                                            updateContact(idx, {
                                                email: e.target.value,
                                            })
                                        }
                                    />
                                    <Input
                                        placeholder="Phone"
                                        className="min-w-[110px] flex-1"
                                        value={c.phone}
                                        onChange={(e) =>
                                            updateContact(idx, {
                                                phone: e.target.value,
                                            })
                                        }
                                    />
                                    <Button
                                        type="button"
                                        variant={
                                            c.isPrimary ? 'default' : 'outline'
                                        }
                                        size="icon"
                                        className="h-9 w-9 shrink-0"
                                        title={
                                            c.isPrimary
                                                ? 'Primary contact'
                                                : 'Set as primary'
                                        }
                                        onClick={() => setPrimaryContact(idx)}
                                    >
                                        <Star
                                            className="h-4 w-4"
                                            fill={
                                                c.isPrimary
                                                    ? 'currentColor'
                                                    : 'none'
                                            }
                                        />
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="h-9 w-9 shrink-0"
                                        onClick={() => removeContact(idx)}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    </div>

                    {/* Entity 3 — ticket types + notes. */}
                    <div className="space-y-3 rounded-lg border bg-muted/40 p-3">
                        <div className="space-y-1.5">
                            <Label>Ticket types this client can raise</Label>
                            <MultiSelectDropdown
                                options={ticketTypes.map((t) => ({
                                    id: t.id,
                                    label: t.name,
                                }))}
                                value={ticketTypeIds}
                                onChange={setTicketTypeIds}
                                placeholder="Select ticket types…"
                                emptyText="No active ticket types defined yet."
                            />
                            <p className="text-[11px] text-muted-foreground">
                                External users of this client only see these
                                type cards on the portal. Pick none and they
                                can&apos;t raise anything until you grant some.
                            </p>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="client-notes">Notes</Label>
                            <Textarea
                                id="client-notes"
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                rows={3}
                            />
                        </div>
                    </div>

                    {isEdit && (
                        <div className="flex items-center gap-2">
                            <Switch
                                id="client-active"
                                checked={isActive}
                                onCheckedChange={setIsActive}
                            />
                            <Label htmlFor="client-active">Active</Label>
                        </div>
                    )}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={submitting}>
                            {submitting ? 'Saving…' : isEdit ? 'Save' : 'Create'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
