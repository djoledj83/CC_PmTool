// Create / Edit Change Request dialog.
//
// Scope mirrors the CR backend (backend/src/routes/changeRequests.js):
// title + description + status + per-side amounts + estimated hours.
// Currency is NOT editable here — every CR inherits its parent
// project's currency by policy. We surface the inherited symbol
// inline next to the amount inputs so users see the unit without
// being able to change it.
//
// Permissioning is the caller's job (the dialog only opens if the
// user has cr:create / cr:edit). We still gate the Submit button on
// `submitting` to prevent double-submits.
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { PROJECT_STATUSES } from '@/lib/constants';
import { useProjectStatuses } from '@/lib/statuses';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
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
import { Switch } from '@/components/ui/switch';

// Money string -> empty | numeric string. Same shape as the project
// form's moneyField so the backend's optional-money coercion accepts
// both unchanged.
const moneyField = z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v) => {
        if (v === '' || v == null) return '';
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) && n >= 0 ? String(n) : '';
    });

const schema = z.object({
    title: z.string().min(1, 'Title is required').max(200),
    description: z.string().max(4000).optional().or(z.literal('')),
    status: z.enum([
        'TODO',
        'IN_PROGRESS',
        'CLIENT_TEST',
        'BILLING',
        'DONE',
        'ON_HOLD',
    ]),
    internalAmount: moneyField,
    internalPaid: z.boolean().optional(),
    clientAmount: moneyField,
    clientPaid: z.boolean().optional(),
    estimatedHours: moneyField, // same numeric-string shape as money
});

export function ChangeRequestFormDialog({
    open,
    onOpenChange,
    onSubmit,
    submitting,
    initialValues,
    // Currencies shown next to amount inputs (read-only — inherited
    // from the parent project). Defaults keep the UI sensible if a
    // parent doesn't have currency explicitly set.
    internalCurrency = 'EUR',
    clientCurrency = 'EUR',
    title = 'Create change request',
    description = 'A CR is chargeable scope on this project. Values roll into the project total.',
    submitLabel = 'Create',
}) {
    const isEdit = Boolean(initialValues?.id);
    const { list: statusOptions } = useProjectStatuses();
    const statusList = statusOptions.length ? statusOptions : PROJECT_STATUSES;

    const {
        register,
        handleSubmit,
        reset,
        setValue,
        watch,
        formState: { errors },
    } = useForm({
        resolver: zodResolver(schema),
        defaultValues: {
            title: '',
            description: '',
            status: 'TODO',
            internalAmount: '',
            internalPaid: false,
            clientAmount: '',
            clientPaid: false,
            estimatedHours: '',
        },
    });

    const status = watch('status');
    const internalPaid = watch('internalPaid');
    const clientPaid = watch('clientPaid');

    useEffect(() => {
        if (open) {
            reset({
                title: initialValues?.title ?? '',
                description: initialValues?.description ?? '',
                status: initialValues?.status ?? 'TODO',
                internalAmount:
                    initialValues?.internalAmount != null
                        ? String(initialValues.internalAmount)
                        : '',
                internalPaid: Boolean(initialValues?.internalPaid),
                clientAmount:
                    initialValues?.clientAmount != null
                        ? String(initialValues.clientAmount)
                        : '',
                clientPaid: Boolean(initialValues?.clientPaid),
                estimatedHours:
                    initialValues?.estimatedHours != null
                        ? String(initialValues.estimatedHours)
                        : '',
            });
        }
    }, [open, initialValues, reset]);

    const submit = (values) => {
        // Convert money / hours strings back to nullable numbers
        // before handing to the API. Empty string => null; valid
        // number => Number. Backend re-coerces but we keep payloads
        // small and explicit.
        const toMoney = (s) => {
            if (s === '' || s == null) return null;
            const n = Number(s);
            return Number.isFinite(n) && n >= 0 ? n : null;
        };
        onSubmit({
            title: values.title.trim(),
            description: values.description?.trim() || null,
            status: values.status,
            internalAmount: toMoney(values.internalAmount),
            internalPaid: !!values.internalPaid,
            clientAmount: toMoney(values.clientAmount),
            clientPaid: !!values.clientPaid,
            estimatedHours: toMoney(values.estimatedHours),
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[560px]">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <form
                    onSubmit={handleSubmit(submit)}
                    className="space-y-4"
                >
                    <div className="space-y-1.5">
                        <Label htmlFor="cr-title">Title</Label>
                        <Input
                            id="cr-title"
                            placeholder="What the client asked for"
                            {...register('title')}
                        />
                        {errors.title && (
                            <p className="text-xs text-destructive">
                                {errors.title.message}
                            </p>
                        )}
                    </div>

                    <div className="space-y-1.5">
                        <Label htmlFor="cr-description">Description</Label>
                        <Textarea
                            id="cr-description"
                            rows={3}
                            placeholder="Context, acceptance criteria, links to email / Jira / Slack."
                            {...register('description')}
                        />
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr]">
                        <div className="space-y-1.5">
                            <Label>Status</Label>
                            <Select
                                value={status}
                                onValueChange={(v) => setValue('status', v)}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {statusList.map((s) => (
                                        <SelectItem key={s.value} value={s.value}>
                                            {s.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="cr-hours">
                                Estimated hours{' '}
                                <span className="text-muted-foreground">
                                    (optional)
                                </span>
                            </Label>
                            <Input
                                id="cr-hours"
                                type="number"
                                min="0"
                                step="0.5"
                                inputMode="decimal"
                                placeholder="e.g. 8"
                                {...register('estimatedHours')}
                            />
                        </div>
                    </div>

                    <fieldset className="space-y-3 rounded-md border bg-muted/30 p-3">
                        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Billing
                        </legend>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label htmlFor="cr-internal">
                                    Internal amount
                                </Label>
                                <div className="flex items-center gap-2">
                                    <Input
                                        id="cr-internal"
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        inputMode="decimal"
                                        placeholder="0.00"
                                        {...register('internalAmount')}
                                    />
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {internalCurrency}
                                    </span>
                                </div>
                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Switch
                                        checked={!!internalPaid}
                                        onCheckedChange={(v) =>
                                            setValue('internalPaid', !!v)
                                        }
                                    />
                                    Internal settlement paid
                                </label>
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="cr-client">
                                    Client amount
                                </Label>
                                <div className="flex items-center gap-2">
                                    <Input
                                        id="cr-client"
                                        type="number"
                                        min="0"
                                        step="0.01"
                                        inputMode="decimal"
                                        placeholder="0.00"
                                        {...register('clientAmount')}
                                    />
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {clientCurrency}
                                    </span>
                                </div>
                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Switch
                                        checked={!!clientPaid}
                                        onCheckedChange={(v) =>
                                            setValue('clientPaid', !!v)
                                        }
                                    />
                                    Client invoice paid
                                </label>
                            </div>
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                            Currency is inherited from the parent project
                            and can't be changed here. To use a different
                            currency, update it on the project first.
                        </p>
                    </fieldset>

                    <DialogFooter className="gap-2 sm:gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange?.(false)}
                            disabled={submitting}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={submitting}>
                            {submitting ? 'Saving…' : isEdit ? 'Save' : submitLabel}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export default ChangeRequestFormDialog;
