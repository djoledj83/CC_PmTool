// Approve a self-registered account — and decide what kind of account it
// is. Sign-ups arrive as customers (external requesters) with no
// organisation, the lowest access there is; the approver confirms that
// and picks the organisation, or makes them an employee requester or a
// staff user. Nothing is granted until this dialog is confirmed.
import { useEffect, useState } from 'react';
import { Building2, LifeBuoy, ShieldAlert, UserCog } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ROLE_LABELS } from '@/lib/capabilities';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
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
import { SearchableSelect } from '@/components/SearchableSelect';
import { MultiSelectDropdown } from '@/components/MultiSelectDropdown';

const KINDS = [
    {
        id: 'customer',
        icon: Building2,
        title: 'Customer',
        hint: 'External requester. Uses the portal and sees only their own and their organisation’s requests.',
    },
    {
        id: 'employee',
        icon: LifeBuoy,
        title: 'Employee requester',
        hint: 'Internal requester. Uses the portal, sees the shared (non-internal) tickets and raises the types you pick.',
    },
    {
        id: 'staff',
        icon: UserCog,
        title: 'Staff user',
        hint: 'Works in the workspace — projects, tickets, time tracking — per the role you pick.',
    },
];

const STAFF_ROLES = ['USER', 'MANAGER', 'APP_MODERATOR', 'ADMIN'];

// The pre-selected kind. A sign-up is an unknown person: always start
// from Customer (the lowest access), whatever role the account carries
// (older sign-ups were created as staff "User").
function initialKind(user) {
    if (!user || user.status === 'PENDING') return 'customer';
    if (user.role !== 'REQUESTER') return 'staff';
    return user.external ? 'customer' : 'employee';
}

export function ApproveUserDialog({ open, onOpenChange, user, onApproved }) {
    const [kind, setKind] = useState('customer');
    const [clientId, setClientId] = useState('');
    const [typeIds, setTypeIds] = useState([]);
    const [staffRole, setStaffRole] = useState('USER');
    const [clients, setClients] = useState([]);
    const [types, setTypes] = useState([]);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!open || !user) return;
        setKind(initialKind(user));
        setClientId(user.clientId || '');
        setTypeIds(user.ticketTypeIds || []);
        setStaffRole(
            user.role && user.role !== 'REQUESTER' ? user.role : 'USER',
        );
        api.get('/clients')
            .then(({ data }) => setClients(data.clients || []))
            .catch(() => setClients([]));
        api.get('/ticket-request-types', { params: { active: 1 } })
            .then(({ data }) => setTypes(data.requestTypes || []))
            .catch(() => setTypes([]));
    }, [open, user]);

    const approve = async () => {
        if (!user) return;
        let body;
        if (kind === 'customer') {
            if (!clientId) {
                toast.error('Pick the organisation this customer belongs to.');
                return;
            }
            body = { role: 'REQUESTER', external: true, clientId };
        } else if (kind === 'employee') {
            body = { role: 'REQUESTER', external: false, ticketTypeIds: typeIds };
        } else {
            body = { role: staffRole };
        }
        setSaving(true);
        try {
            const { data } = await api.post(`/users/${user.id}/approve`, body);
            toast.success(`${data.user.name} approved`);
            onApproved?.(data.user);
            onOpenChange(false);
        } catch (err) {
            toast.error(err.response?.data?.error || 'Could not approve user');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Approve {user?.name || 'account'}</DialogTitle>
                    <DialogDescription>
                        {user?.email} — choose what kind of account this is.
                        Nothing is granted until you approve.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-2" role="radiogroup" aria-label="Account type">
                    {KINDS.map((k) => {
                        const Icon = k.icon;
                        const on = kind === k.id;
                        return (
                            <button
                                key={k.id}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                onClick={() => setKind(k.id)}
                                className={cn(
                                    'flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                                    on
                                        ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                        : 'hover:bg-muted/50',
                                )}
                            >
                                <span
                                    className={cn(
                                        'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                                        on
                                            ? 'bg-primary text-primary-foreground'
                                            : 'bg-muted text-muted-foreground',
                                    )}
                                >
                                    <Icon className="h-4 w-4" />
                                </span>
                                <span className="min-w-0">
                                    <span className="block text-sm font-medium">
                                        {k.title}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">
                                        {k.hint}
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </div>

                {kind === 'customer' && (
                    <div className="space-y-1.5">
                        <Label className="text-xs">
                            Organisation <span className="text-rose-500">*</span>
                        </Label>
                        <SearchableSelect
                            value={clientId}
                            onChange={setClientId}
                            placeholder="Select an organisation…"
                            searchPlaceholder="Search clients…"
                            emptyText="No clients yet — add one under Clients."
                            options={clients.map((c) => ({
                                value: c.id,
                                label: c.name,
                            }))}
                        />
                        <p className="text-[11px] text-muted-foreground">
                            They can raise the request types enabled for this
                            organisation (Clients → edit → ticket types).
                        </p>
                    </div>
                )}

                {kind === 'employee' && (
                    <div className="space-y-1.5">
                        <Label className="text-xs">
                            Ticket types they can raise
                        </Label>
                        <MultiSelectDropdown
                            options={types.map((t) => ({ id: t.id, label: t.name }))}
                            value={typeIds}
                            onChange={setTypeIds}
                            placeholder="Select ticket types…"
                            emptyText="No active ticket types defined yet."
                        />
                        <p className="text-[11px] text-muted-foreground">
                            None picked means they can&apos;t raise anything yet
                            — you can add types later in Edit user.
                        </p>
                    </div>
                )}

                {kind === 'staff' && (
                    <div className="space-y-1.5">
                        <Label className="text-xs">Role</Label>
                        <Select value={staffRole} onValueChange={setStaffRole}>
                            <SelectTrigger className="h-9">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {STAFF_ROLES.map((r) => (
                                    <SelectItem key={r} value={r}>
                                        {ROLE_LABELS[r] || r}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <p className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                            <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                            Only for your own colleagues — a staff account sees
                            workspace data, including other customers&apos;
                            tickets.
                        </p>
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
                    <Button type="button" onClick={approve} disabled={saving}>
                        {saving ? 'Approving…' : 'Approve'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default ApproveUserDialog;
