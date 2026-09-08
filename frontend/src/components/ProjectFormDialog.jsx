import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Contact, Plus, Trash2, Users2, X as XIcon } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
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
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SearchableSelect } from '@/components/SearchableSelect';
import { PROJECT_STATUSES, PROJECT_PRIORITIES, filterProjectStatuses, ONGOING_HIDDEN_STATUSES } from '@/lib/constants';
import { useProjectStatuses } from '@/lib/statuses';
import { useProjectPriorities } from '@/lib/priorities';
import { useProjectTypes, usePhaseTemplates } from '@/lib/catalogs';
import { useAuth } from '@/contexts/AuthContext';
import { LABEL_COLORS, labelColorClass } from '@/lib/labelColors';
import {
    labelsToPayload,
    newContactKey,
    newLabelKey,
    parseProjectLabels,
} from '@/lib/projectLabels';
import { cn } from '@/lib/utils';
import PhasesMultiSelect from '@/components/PhasesMultiSelect';

// Sentinel value used in the country/client Selects so an empty
// string can still be a valid "no choice" option (Radix Select rejects
// empty values).
const NO_OPTION = '__none__';

const NO_REPORTER = '__none__';

const moneyField = z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v) => {
        if (v === '' || v == null) return '';
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isFinite(n) && n >= 0 ? String(n) : '';
    });

const schema = z.object({
    name: z.string().min(1, 'Name is required').max(150),
    description: z.string().max(2000).optional().or(z.literal('')),
    // Status is a free string now — the value comes from the
    // admin-managed StatusOption table (scope PROJECT), so admins can
    // add fully custom workflow states. The backend validates the key
    // against the known + admin-defined set.
    status: z.string().min(1),
    // Lifecycle mode removed from the form — ongoing vs completable
    // projects are expressed via Project type (hideMarkComplete flag).
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
    phase: z.string().max(100).optional().or(z.literal('')),
    label: z.string().max(100).optional().or(z.literal('')),
    labelColor: z.string().max(20).optional().or(z.literal('')),
    country: z.string().max(100).optional().or(z.literal('')),
    client: z.string().max(150).optional().or(z.literal('')),
    crmId: z.string().max(100).optional().or(z.literal('')),
    clientId: z.string().max(40).optional().or(z.literal('')),
    applicationId: z.string().max(40).optional().or(z.literal('')),
    productId: z.string().max(40).optional().or(z.literal('')),
    entityId: z.string().max(40).optional().or(z.literal('')),
    linkedProjectId: z.string().max(40).optional().or(z.literal('')),
    projectTypeId: z.string().max(40).optional().or(z.literal('')),
    startDate: z.string().optional().or(z.literal('')),
    endDate: z.string().optional().or(z.literal('')),
    reporterId: z.string().optional().or(z.literal('')),
    ownerId: z.string().optional().or(z.literal('')),
    // Billing — only edited by admins. Stored as strings in the form
    // (zero-or-positive number, blank = unset). Currencies default to
    // EUR but can be overridden per project.
    internalAmount: moneyField,
    internalCurrency: z.string().max(10).optional().or(z.literal('')),
    internalPaid: z.boolean().optional(),
    clientAmount: moneyField,
    clientCurrency: z.string().max(10).optional().or(z.literal('')),
    clientPaid: z.boolean().optional(),
    billingNotes: z.string().max(2000).optional().or(z.literal('')),
});

function toDateInputValue(iso) {
    if (!iso) return '';
    return new Date(iso).toISOString().slice(0, 10);
}

function toIsoOrNull(value) {
    if (!value) return null;
    return new Date(value).toISOString();
}

export { splitLabels } from '@/lib/projectLabels';

export function ProjectFormDialog({
    open,
    onOpenChange,
    onSubmit: onSubmitProp,
    submitting,
    initialValues,
    users = [],
    title = 'Create project',
    description = 'Fill in the details. You can edit anything later.',
    submitLabel = 'Create',
    // Per-user capability overrides. When true, a non-admin user is
    // allowed to edit the matching subset of fields. Both default to
    // false so the legacy admin-only behaviour is preserved for
    // callers that don't pass them.
    canEditBilling = false,
    canCloseProject = false,
}) {
    const { user: currentUser } = useAuth();
    const isAdmin = currentUser?.role === 'ADMIN';
    const isManager = currentUser?.role === 'MANAGER';
    // Effective "can change billing fields" flag used by the form. The
    // billing block (and the payload-build branch below) used to gate
    // strictly on `isAdmin`. We OR the per-user cap in so admins and
    // capability holders both see the same UX. Personal projects
    // never expose billing.
    const billingAllowed = isAdmin || canEditBilling;
    // Only admins and managers can choose between a shared and a
    // personal project. Regular users always get a personal project
    // — no toggle, no shared-project sections.
    const canPickProjectScope = isAdmin || isManager;
    const isEdit = Boolean(initialValues?.id);
    const { list: priorityOptions } = useProjectPriorities();
    const priorityList = priorityOptions.length
        ? priorityOptions
        : PROJECT_PRIORITIES;
    const { list: statusOptions } = useProjectStatuses();
    const statusList = statusOptions.length ? statusOptions : PROJECT_STATUSES;

    const {
        register,
        handleSubmit,
        reset,
        setValue,
        watch,
        setFocus,
        formState: { errors },
    } = useForm({
        resolver: zodResolver(schema),
        defaultValues: {
            name: '',
            description: '',
            status: 'TODO',
            priority: 'MEDIUM',
            phase: '',
            label: '',
            labelColor: '',
            country: '',
            client: '',
            crmId: '',
            clientId: '',
            applicationId: '',
            productId: '',
            entityId: '',
            linkedProjectId: '',
            projectTypeId: '',
            startDate: '',
            endDate: '',
            reporterId: '',
            ownerId: '',
            internalAmount: '',
            internalCurrency: 'EUR',
            internalPaid: false,
            clientAmount: '',
            clientCurrency: 'EUR',
            clientPaid: false,
            billingNotes: '',
        },
    });

    const status = watch('status');
    const priority = watch('priority');
    const reporterId = watch('reporterId');
    const ownerId = watch('ownerId');
    const phaseValue = watch('phase');
    const countryValue = watch('country');
    const clientIdValue = watch('clientId');
    const productIdValue = watch('productId');
    const entityIdValue = watch('entityId');
    const projectTypeValue = watch('projectTypeId');
    const linkedProjectValue = watch('linkedProjectId');
    const internalPaid = watch('internalPaid');
    const clientPaid = watch('clientPaid');

    const hasClientSelected =
        Boolean(clientIdValue) && clientIdValue !== NO_OPTION;

    const [pendingLabels, setPendingLabels] = useState([]);
    const [labelDraft, setLabelDraft] = useState('');
    const [labelDraftColor, setLabelDraftColor] = useState('sky');

    const { items: projectTypeOptions } = useProjectTypes();
    const { items: phaseTemplateOptions, loading: phaseTemplatesLoading } =
        usePhaseTemplates();

    const [selectedPhaseTemplateIds, setSelectedPhaseTemplateIds] = useState(
        [],
    );
    const phaseSelectionInitRef = useRef(false);

    const selectedPhaseTemplates = useMemo(() => {
        const idSet = new Set(selectedPhaseTemplateIds);
        return phaseTemplateOptions.filter((p) => idSet.has(p.id));
    }, [selectedPhaseTemplateIds, phaseTemplateOptions]);

    const hideCompleteStatus = useMemo(() => {
        if (projectTypeValue && projectTypeValue !== NO_OPTION) {
            const fromList = projectTypeOptions.find(
                (t) => t.id === projectTypeValue,
            );
            if (fromList) return Boolean(fromList.hideMarkComplete);
        }
        return Boolean(initialValues?.projectType?.hideMarkComplete);
    }, [
        projectTypeValue,
        projectTypeOptions,
        initialValues?.projectType?.hideMarkComplete,
    ]);

    const formStatusList = useMemo(
        () => filterProjectStatuses(statusList, hideCompleteStatus),
        [statusList, hideCompleteStatus],
    );

    const [companyClients, setCompanyClients] = useState([]);
    const [products, setProducts] = useState([]);
    const [entities, setEntities] = useState([]);

    // Teams the admin can attach when creating the project. We don't
    // expose this on the edit form — Edit relies on the existing
    // ProjectTeamsPanel for ongoing roster management. The picker is
    // also admin-gated server-side, so non-admins won't see it open
    // anyway.
    const [allTeams, setAllTeams] = useState([]);
    // For personal projects: list of shared projects the user participates
    // in, used for the "Linked project" dropdown.
    const [participatingProjects, setParticipatingProjects] = useState([]);
    const [teamIds, setTeamIds] = useState([]);
    // Personal-project toggle. Only meaningful on create — once a
    // project exists its scope is fixed (changing it would silently
    // change visibility for every participant).
    //
    // - Admins / managers: see the toggle and can choose. Defaults
    //   to off (shared project, the legacy behaviour).
    // - Regular users: don't see the toggle at all and ALWAYS create
    //   personal projects. We seed `isPersonal=true` directly so the
    //   slim layout kicks in immediately.
    const [isPersonal, setIsPersonal] = useState(!canPickProjectScope);
    // True when the *form is currently editing a personal project*,
    // either because the user just toggled it on (create) or because
    // the underlying project was created as personal (edit). Drives
    // the slim layout — hiding status/priority/phase/owner/reporter/
    // teams/billing/contacts that don't apply to a self-organiser.
    const isPersonalMode = isPersonal || Boolean(initialValues?.isPersonal);
    const showTeamPicker = !isEdit && isAdmin && !isPersonalMode;
    // Toggle is shown only to admins / managers on the create form.
    // Editing never shows it (scope is locked after create).
    const showPersonalToggle = !isEdit && canPickProjectScope;

    // Initial collaborators for a brand-new personal project. Owner
    // can invite teammates up-front; the parent fans out
    // /participants POSTs once the project is created. After creation
    // ongoing collaborator management happens through the
    // ParticipantsPanel on the project page.
    const [pendingCollaborators, setPendingCollaborators] = useState([]);
    const showCollaboratorsPicker = !isEdit && isPersonalMode;

    // Important / external contacts collected up-front during project
    // creation. We keep them entirely client-side here (no projectId
    // yet) and the parent's handleSubmit fans out POSTs to
    // /project-contacts after the project is created.
    //
    // For the edit flow we leave this hidden — ongoing contact CRUD
    // happens through the dedicated panel on the Project Detail page.
    // Personal projects skip this section entirely; the field set is
    // intentionally minimal for self-organiser use.
    const [pendingContacts, setPendingContacts] = useState([]);
    const showContactsBuilder = !isEdit && !isPersonalMode;
    const canPickOwnerOnCreate =
        (isAdmin || isManager) && !isEdit && !isPersonalMode;
    const canChangeOwnerOnEdit = isAdmin && isEdit && !isPersonalMode;
    const addLabel = () => {
        const text = labelDraft.trim();
        if (!text) return;
        const key = text.toLowerCase();
        if (pendingLabels.some((l) => l.text.toLowerCase() === key)) {
            toast.error('That label is already added');
            return;
        }
        setPendingLabels((prev) => [
            ...prev,
            {
                _key: newLabelKey(),
                text,
                color: labelDraftColor || 'sky',
            },
        ]);
        setLabelDraft('');
    };

    const removeLabel = (key) => {
        setPendingLabels((prev) => prev.filter((l) => l._key !== key));
    };

    const addPendingContact = () => {
        setPendingContacts((prev) => [
            ...prev,
            {
                _key: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                name: '',
                role: '',
                company: '',
                email: '',
                phone: '',
                notes: '',
            },
        ]);
    };
    const updatePendingContact = (key, patch) => {
        setPendingContacts((prev) =>
            prev.map((c) => (c._key === key ? { ...c, ...patch } : c)),
        );
    };
    const removePendingContact = (key) => {
        setPendingContacts((prev) => prev.filter((c) => c._key !== key));
    };
    useEffect(() => {
        if (!open || !showTeamPicker) return undefined;
        let cancelled = false;
        (async () => {
            try {
                const { data } = await api.get('/teams');
                if (!cancelled) setAllTeams(data.teams || []);
            } catch {
                if (!cancelled) setAllTeams([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, showTeamPicker]);

    // Load shared projects the user participates in for the personal
    // project "Linked project" dropdown. Only fetched when the form
    // is in personal-project mode.
    useEffect(() => {
        if (!open || !isPersonalMode) return undefined;
        let cancelled = false;
        (async () => {
            try {
                const { data } = await api.get('/projects', {
                    params: { type: 'shared', limit: 200 },
                });
                if (!cancelled) {
                    setParticipatingProjects(
                        (data.projects || []).filter((p) => !p.isPersonal),
                    );
                }
            } catch {
                if (!cancelled) setParticipatingProjects([]);
            }
        })();
        return () => { cancelled = true; };
    }, [open, isPersonalMode]);

    const fullProductOptions = useMemo(() => {
        const seen = new Set(products.map((p) => p.id));
        const labelFor = (p) => (p.code ? `${p.code} · ${p.name}` : p.name);
        const out = products.map((p) => ({
            value: p.id,
            label: labelFor(p),
        }));
        // Keep the project's current product selectable even if it was since
        // deactivated / isn't in the active list.
        const fallback = initialValues?.product;
        if (fallback?.id && !seen.has(fallback.id)) {
            out.unshift({
                value: fallback.id,
                label: labelFor(fallback),
            });
        }
        return out;
    }, [products, initialValues?.product]);

    const fullEntityOptions = useMemo(() => {
        const seen = new Set(entities.map((e) => e.id));
        const labelFor = (e) =>
            e.description ? `${e.code} · ${e.description}` : e.code;
        const out = entities.map((e) => ({ value: e.id, label: labelFor(e) }));
        const fallback = initialValues?.entity;
        if (fallback?.id && !seen.has(fallback.id)) {
            out.unshift({ value: fallback.id, label: labelFor(fallback) });
        }
        return out;
    }, [entities, initialValues?.entity]);

    // Project type options. The catalogue hook only returns active
    // entries; if the project already has an inactive (or otherwise
    // missing) type assigned we still want to surface it so the form
    // doesn't silently clear the choice on save.
    const fullProjectTypeOptions = useMemo(() => {
        const seen = new Set(projectTypeOptions.map((t) => t.id));
        const out = projectTypeOptions.map((t) => ({
            value: t.id,
            label: t.name,
        }));
        const fallback = initialValues?.projectType;
        if (fallback?.id && !seen.has(fallback.id)) {
            out.unshift({
                value: fallback.id,
                label: `${fallback.name} (inactive)`,
            });
        }
        return out;
    }, [projectTypeOptions, initialValues?.projectType]);

    // Client options with the same missing-option fallback the Application
    // and Project-type Selects use: GET /clients returns active clients only,
    // so a project whose assigned client is inactive (or a transient fetch
    // hiccup) would otherwise leave the Select with no matching item and it'd
    // render the placeholder — i.e. the client looks "wiped" on every edit,
    // even though the value is still set. Seeding the current client from
    // initialValues.clientRecord guarantees a matching option.
    const fullClientOptions = useMemo(() => {
        const seen = new Set(companyClients.map((c) => c.id));
        const out = companyClients.map((c) => ({
            value: c.id,
            label: c.name,
        }));
        const fallback = initialValues?.clientRecord;
        if (fallback?.id && !seen.has(fallback.id)) {
            out.unshift({ value: fallback.id, label: fallback.name });
        }
        return out;
    }, [companyClients, initialValues?.clientRecord]);

    // The "current phase" of a project is one of its own Phase rows. We
    // surface them as a dropdown so users don't have to retype names. New
    // projects (no phases yet) fall back to a free-text input.
    const projectPhases = initialValues?.phases || [];

    useEffect(() => {
        if (!open) return;
        Promise.all([
            api.get('/clients'),
            api.get('/templates/products'),
            api.get('/templates/entities'),
        ])
            .then(([clientRes, prodRes, entRes]) => {
                setCompanyClients(clientRes.data.clients || []);
                setProducts(prodRes.data.products || []);
                setEntities(entRes.data.entities || []);
            })
            .catch(() => {});
    }, [open]);

    useEffect(() => {
        if (!clientIdValue || clientIdValue === NO_OPTION) {
            setValue('country', '');
            if (showContactsBuilder) {
                setPendingContacts((prev) =>
                    prev.filter((c) => !c._fromClient),
                );
            }
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const { data } = await api.get(`/clients/${clientIdValue}`);
                if (cancelled) return;
                const client = data.client;
                if (!client) return;
                setValue('client', client.name, { shouldDirty: true });
                setValue('country', client.country || '', {
                    shouldDirty: true,
                });
                if (!showContactsBuilder) return;
                const fromClient = (client.contacts || []).map((c) => ({
                    _key: `client-${c.id || newContactKey()}`,
                    _fromClient: true,
                    name: c.name || '',
                    role: c.role || '',
                    company: client.name || '',
                    email: c.email || '',
                    phone: c.phone || '',
                    notes: '',
                }));
                setPendingContacts((prev) => {
                    const manual = prev.filter((c) => !c._fromClient);
                    return [...fromClient, ...manual];
                });
            } catch {
                // Non-fatal — user can still save without auto-fill.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [clientIdValue, showContactsBuilder, setValue]);

    useEffect(() => {
        if (!hideCompleteStatus || !ONGOING_HIDDEN_STATUSES.has(status)) {
            return;
        }
        setValue('status', 'IN_PROGRESS', { shouldDirty: true });
    }, [hideCompleteStatus, status, setValue]);

    useEffect(() => {
        if (!open) {
            phaseSelectionInitRef.current = false;
            return;
        }
        if (isEdit || isPersonalMode || phaseSelectionInitRef.current) return;
        if (phaseTemplateOptions.length === 0) {
            setSelectedPhaseTemplateIds([]);
            return;
        }
        setSelectedPhaseTemplateIds(phaseTemplateOptions.map((p) => p.id));
        phaseSelectionInitRef.current = true;
    }, [open, isEdit, isPersonalMode, phaseTemplateOptions]);

    useEffect(() => {
        if (isEdit || isPersonalMode) return;
        const names = selectedPhaseTemplates.map((p) => p.name);
        if (names.length === 0) {
            if (phaseValue) setValue('phase', '');
            return;
        }
        if (!phaseValue || !names.includes(phaseValue)) {
            setValue('phase', names[0], { shouldDirty: true });
        }
    }, [
        selectedPhaseTemplates,
        isEdit,
        isPersonalMode,
        phaseValue,
        setValue,
    ]);

    useEffect(() => {
        if (open) {
            reset({
                name: initialValues?.name ?? '',
                description: initialValues?.description ?? '',
                status: initialValues?.status ?? 'TODO',
                priority: initialValues?.priority ?? 'MEDIUM',
                phase: initialValues?.phase ?? '',
                label: initialValues?.label ?? '',
                labelColor: initialValues?.labelColor ?? '',
                country: initialValues?.country ?? '',
                client: initialValues?.client ?? '',
                crmId: initialValues?.crmId ?? '',
                clientId:
                    initialValues?.clientId ??
                    initialValues?.clientRecord?.id ??
                    '',
                applicationId:
                    initialValues?.applicationId ??
                    initialValues?.application?.id ??
                    '',
                productId:
                    initialValues?.productId ??
                    initialValues?.product?.id ??
                    '',
                entityId:
                    initialValues?.entityId ??
                    initialValues?.entity?.id ??
                    '',
                linkedProjectId: initialValues?.linkedProjectId ?? '',
                projectTypeId:
                    initialValues?.projectTypeId ??
                    initialValues?.projectType?.id ??
                    '',
                startDate: toDateInputValue(initialValues?.startDate),
                endDate: toDateInputValue(initialValues?.endDate),
                reporterId: initialValues?.reporterId ?? '',
                ownerId:
                    initialValues?.ownerId ??
                    (isEdit ? '' : currentUser?.id ?? ''),
                internalAmount:
                    initialValues?.internalAmount != null
                        ? String(initialValues.internalAmount)
                        : '',
                internalCurrency:
                    initialValues?.internalCurrency ?? 'EUR',
                internalPaid: Boolean(initialValues?.internalPaid),
                clientAmount:
                    initialValues?.clientAmount != null
                        ? String(initialValues.clientAmount)
                        : '',
                clientCurrency: initialValues?.clientCurrency ?? 'EUR',
                clientPaid: Boolean(initialValues?.clientPaid),
                billingNotes: initialValues?.billingNotes ?? '',
            });
            setPendingLabels(
                parseProjectLabels(initialValues).map((l) => ({
                    _key: newLabelKey(),
                    text: l.text,
                    color: l.color || 'sky',
                })),
            );
            setLabelDraft('');
            setLabelDraftColor('sky');
            setPendingContacts([]);
            setSelectedPhaseTemplateIds([]);
            phaseSelectionInitRef.current = false;
            // Regular users always get a personal project; admins
            // and managers default to the shared layout and can flip
            // the toggle on for personal.
            setIsPersonal(!canPickProjectScope);
            setPendingCollaborators([]);
        }
    }, [open, initialValues, reset, currentUser?.id, isEdit, canPickProjectScope]);

    const reporterOptions = useMemo(
        () => [{ id: NO_REPORTER, name: '— None —' }, ...users],
        [users],
    );

    const submit = (values) => {
        // Personal projects MUST be linked to a shared parent. We
        // enforce this server-side too, but doing it here gives the
        // user instant feedback instead of a backend 400 popping up
        // after the round-trip.
        if (isPersonalMode && !values.linkedProjectId) {
            toast.error(
                'A personal project must be linked to a shared project. Pick one before saving.',
            );
            setFocus('linkedProjectId');
            return;
        }
        if (!isPersonalMode && !isEdit && !values.ownerId) {
            toast.error('Assigned to is required.');
            return;
        }
        if (
            !isPersonalMode &&
            !isEdit &&
            selectedPhaseTemplates.length === 0
        ) {
            toast.error('Select at least one project phase.');
            return;
        }
        // Shared projects must carry an Entity (used to group the time
        // export). The backend enforces this too.
        if (
            !isPersonalMode &&
            (!values.entityId || values.entityId === NO_OPTION)
        ) {
            toast.error('Select an entity for this project.');
            return;
        }
        const payload = {
            name: values.name,
            description: values.description || null,
            // Personal projects skip status/priority/phase entirely;
            // the backend defaults TODO/MEDIUM/null and we don't want
            // to surface those fields in the slim form.
            status: isPersonalMode ? 'TODO' : values.status,
            priority: isPersonalMode ? 'MEDIUM' : values.priority,
            phase: isPersonalMode ? null : values.phase || null,
            ...labelsToPayload(
                pendingLabels.map((l) => ({
                    text: l.text,
                    color: l.color,
                })),
            ),
            country: values.country || null,
            client: values.client || null,
            crmId: isPersonalMode ? null : values.crmId || null,
            clientId: isPersonalMode
                ? null
                : values.clientId && values.clientId !== NO_OPTION
                  ? values.clientId
                  : null,
            // Projects now link to a Product (not an Application). We
            // deliberately do NOT send applicationId, so any legacy
            // application link on an existing project is left untouched.
            productId: isPersonalMode
                ? null
                : values.productId && values.productId !== NO_OPTION
                  ? values.productId
                  : null,
            entityId: isPersonalMode
                ? null
                : values.entityId && values.entityId !== NO_OPTION
                  ? values.entityId
                  : null,
            linkedProjectId: isPersonalMode
                ? values.linkedProjectId || null
                : null,
            // Personal projects skip the project-type categorisation —
            // it's a workspace-level concept aimed at shared work.
            projectTypeId: isPersonalMode
                ? null
                : values.projectTypeId && values.projectTypeId !== NO_OPTION
                  ? values.projectTypeId
                  : null,
            startDate: toIsoOrNull(values.startDate),
            endDate: toIsoOrNull(values.endDate),
            reporterId: isPersonalMode
                ? null
                : values.reporterId && values.reporterId !== NO_REPORTER
                  ? values.reporterId
                  : null,
        };

        // Only admins are allowed to set/change ownerId. For everyone else
        // we omit the field entirely so the backend keeps the original owner
        // (or sets the creator on POST). Personal projects never let
        // the owner be reassigned — the backend forces `ownerId = req.user.id`.
        if (!isPersonalMode && values.ownerId) {
            if (!isEdit || isAdmin) {
                payload.ownerId = values.ownerId;
            }
        }

        // Billing fields — admins and per-user `project:billing:manage`
        // holders, never on personal projects (they're a self-organiser,
        // not a billable engagement).
        if (billingAllowed && !isPersonalMode) {
            payload.internalAmount =
                values.internalAmount === '' || values.internalAmount == null
                    ? null
                    : Number(values.internalAmount);
            payload.internalCurrency =
                (values.internalCurrency || '').trim() || 'EUR';
            payload.internalPaid = Boolean(values.internalPaid);
            payload.clientAmount =
                values.clientAmount === '' || values.clientAmount == null
                    ? null
                    : Number(values.clientAmount);
            payload.clientCurrency =
                (values.clientCurrency || '').trim() || 'EUR';
            payload.clientPaid = Boolean(values.clientPaid);
            payload.billingNotes = values.billingNotes || null;
        }

        // Only ship teamIds when creating — the edit endpoint ignores
        // it, and we manage attachments through ProjectTeamsPanel after
        // the fact. Personal projects never get teams.
        if (showTeamPicker && teamIds.length) {
            payload.teamIds = teamIds;
        }

        if (!isPersonalMode && !isEdit) {
            payload.phaseNames = selectedPhaseTemplates.map((p) => p.name);
        }

        // Only on create — once the project exists its scope is fixed
        // and the backend ignores any further isPersonal updates.
        // Non-admin/manager users always create personal projects —
        // isPersonal must be sent even when showPersonalToggle is false
        // (regular users never see the toggle, so we must force it).
        if (!isEdit) {
            if (showPersonalToggle) {
                payload.isPersonal = isPersonal;
            } else if (!canPickProjectScope) {
                payload.isPersonal = true;
            }
        }

        // Hand the parent the list of contacts to fan-out after the
        // project is created. We strip empty rows here so the caller
        // doesn't have to think about validation.
        if (showContactsBuilder) {
            const cleaned = pendingContacts
                .map((c) => ({
                    name: (c.name || '').trim(),
                    role: (c.role || '').trim(),
                    company: (c.company || '').trim(),
                    email: (c.email || '').trim(),
                    phone: (c.phone || '').trim(),
                    notes: (c.notes || '').trim(),
                }))
                .filter((c) => c.name.length > 0);
            if (cleaned.length) {
                payload._pendingContacts = cleaned;
            }
        }

        // Personal projects: pass the collaborator picks back to the
        // parent so it can POST /participants for each. Owner is
        // automatically a participant — we drop them here defensively
        // so the parent doesn't double-add.
        if (showCollaboratorsPicker && pendingCollaborators.length) {
            const ids = pendingCollaborators.filter(
                (id) => id && id !== currentUser?.id,
            );
            if (ids.length) {
                payload._pendingCollaborators = ids;
            }
        }

        onSubmitProp(payload);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
                <DialogHeader className="space-y-1">
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit(submit)} className="space-y-3">
                    {showPersonalToggle && (
                        <div className="flex items-start gap-3 rounded-lg border bg-muted/40 px-3 py-2">
                            <Switch
                                id="project-is-personal"
                                checked={isPersonal}
                                onCheckedChange={setIsPersonal}
                                aria-label="Personal project"
                            />
                            <div className="min-w-0 flex-1">
                                <Label
                                    htmlFor="project-is-personal"
                                    className="cursor-pointer text-sm"
                                >
                                    Personal project
                                </Label>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                    Visible only to you and anyone you
                                    invite. No teams, no billing — great
                                    for organising your own work.
                                </p>
                            </div>
                        </div>
                    )}
                    {!showPersonalToggle &&
                        !isEdit &&
                        isPersonalMode && (
                            <div className="rounded-lg border border-purple-300/70 bg-purple-50 px-3 py-2 text-xs text-purple-800 dark:border-purple-500/40 dark:bg-purple-500/10 dark:text-purple-200">
                                <span className="font-semibold">
                                    Personal project.
                                </span>{' '}
                                Visible only to you and anyone you invite.
                                You can manage everything inside it
                                yourself.
                            </div>
                        )}
                    <div className="space-y-1.5">
                        <Label htmlFor="name">Name</Label>
                        <Input id="name" {...register('name')} />
                        {errors.name && (
                            <p className="text-xs text-destructive">
                                {errors.name.message}
                            </p>
                        )}
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="description">Description</Label>
                        <Textarea
                            id="description"
                            rows={2}
                            {...register('description')}
                        />
                    </div>

                    {/* Status / Priority / Phase as a tight 3-up.
                        Hidden for personal projects — those are slim
                        organisers without status workflow / phases. */}
                    {!isPersonalMode && (
                    <>
                    <div
                        className={cn(
                            'grid grid-cols-1 gap-3',
                            isEdit ? 'sm:grid-cols-3' : 'sm:grid-cols-2',
                        )}
                    >
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
                                    {formStatusList.map((s) => (
                                        <SelectItem key={s.value} value={s.value}>
                                            {s.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-1.5">
                            <Label>Priority</Label>
                            <Select
                                value={priority}
                                onValueChange={(v) => setValue('priority', v)}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {priorityList.map((p) => (
                                        <SelectItem key={p.value} value={p.value}>
                                            {p.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        {isEdit && (
                        <div className="space-y-1.5">
                            <Label htmlFor="phase">Current phase</Label>
                            {projectPhases.length > 0 ? (
                                <Select
                                    value={phaseValue || '__none__'}
                                    onValueChange={(v) =>
                                        setValue(
                                            'phase',
                                            v === '__none__' ? '' : v,
                                        )
                                    }
                                >
                                    <SelectTrigger id="phase">
                                        <SelectValue placeholder="Pick a phase" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="__none__">
                                            — None —
                                        </SelectItem>
                                        {projectPhases.map((p) => (
                                            <SelectItem key={p.id} value={p.name}>
                                                {p.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            ) : (
                                <Input
                                    id="phase"
                                    placeholder="No phases on this project"
                                    {...register('phase')}
                                />
                            )}
                        </div>
                        )}
                    </div>
                    {!isEdit && (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label>Project phases</Label>
                                <PhasesMultiSelect
                                    phases={phaseTemplateOptions}
                                    value={selectedPhaseTemplateIds}
                                    onChange={setSelectedPhaseTemplateIds}
                                    loading={phaseTemplatesLoading}
                                    placeholder="Select phases"
                                />
                                <p className="text-[11px] text-muted-foreground">
                                    Choose which plan phases this project
                                    includes. Manage templates under Admin →
                                    Templates.
                                </p>
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="phase">Starting phase</Label>
                                {selectedPhaseTemplates.length > 0 ? (
                                    <Select
                                        value={phaseValue || '__none__'}
                                        onValueChange={(v) =>
                                            setValue(
                                                'phase',
                                                v === '__none__' ? '' : v,
                                            )
                                        }
                                    >
                                        <SelectTrigger id="phase">
                                            <SelectValue placeholder="Pick starting phase" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {selectedPhaseTemplates.map(
                                                (p) => (
                                                    <SelectItem
                                                        key={p.id}
                                                        value={p.name}
                                                    >
                                                        {p.name}
                                                    </SelectItem>
                                                ),
                                            )}
                                        </SelectContent>
                                    </Select>
                                ) : (
                                    <Input
                                        id="phase"
                                        value=""
                                        readOnly
                                        disabled
                                        placeholder="Select phases first"
                                        className="bg-muted/50"
                                    />
                                )}
                                <p className="text-[11px] text-muted-foreground">
                                    Initial active phase for this project.
                                </p>
                            </div>
                        </div>
                    )}
                    </>
                    )}

                    {/* Labels — add one at a time, each with its own colour. */}
                    <div className="space-y-2">
                        <Label>Labels</Label>
                        <div className="flex flex-wrap items-center gap-2">
                            <Input
                                placeholder="Add a label…"
                                value={labelDraft}
                                onChange={(e) => setLabelDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        addLabel();
                                    }
                                }}
                                className="min-w-[140px] flex-1"
                            />
                            <LabelColorPicker
                                value={labelDraftColor}
                                onChange={setLabelDraftColor}
                            />
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="gap-1"
                                onClick={addLabel}
                                disabled={!labelDraft.trim()}
                            >
                                <Plus className="h-3.5 w-3.5" />
                                Add
                            </Button>
                        </div>
                        {pendingLabels.length > 0 ? (
                            <ul className="flex flex-wrap gap-2">
                                {pendingLabels.map((l) => (
                                    <li
                                        key={l._key}
                                        className="inline-flex items-center gap-1 rounded-full border bg-card py-0.5 pl-2 pr-1"
                                    >
                                        <span
                                            className={cn(
                                                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1',
                                                labelColorClass(l.color),
                                            )}
                                        >
                                            {l.text}
                                        </span>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 text-muted-foreground hover:text-destructive"
                                            onClick={() => removeLabel(l._key)}
                                            aria-label={`Remove label ${l.text}`}
                                        >
                                            <XIcon className="h-3 w-3" />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-[11px] text-muted-foreground">
                                No labels yet — type a name, pick a colour,
                                and press Add (or Enter).
                            </p>
                        )}
                    </div>

                    {/* Client / country, then CRM ID / application */}
                    {!isPersonalMode && (
                        <>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div className="space-y-1.5">
                                    <Label htmlFor="clientId">Client</Label>
                                    <SearchableSelect
                                        value={clientIdValue || NO_OPTION}
                                        onChange={(v) =>
                                            setValue(
                                                'clientId',
                                                v === NO_OPTION ? '' : v,
                                                { shouldDirty: true },
                                            )
                                        }
                                        placeholder="Select client"
                                        searchPlaceholder="Search clients…"
                                        options={[
                                            { value: NO_OPTION, label: '— None —' },
                                            ...fullClientOptions,
                                        ]}
                                    />
                                    {companyClients.length === 0 && (
                                        <p className="text-[11px] text-muted-foreground">
                                            Add clients under Work → Clients.
                                        </p>
                                    )}
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="country">Country</Label>
                                    {hasClientSelected ? (
                                        <>
                                            <Input
                                                id="country"
                                                value={countryValue || '—'}
                                                readOnly
                                                disabled
                                                className="bg-muted/50"
                                            />
                                            <p className="text-[11px] text-muted-foreground">
                                                Taken from the selected client.
                                            </p>
                                        </>
                                    ) : (
                                        <Input
                                            id="country"
                                            value=""
                                            readOnly
                                            disabled
                                            placeholder="Select a client first"
                                            className="bg-muted/50"
                                        />
                                    )}
                                </div>
                            </div>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div className="space-y-1.5">
                                    <Label htmlFor="crmId">CRM ID</Label>
                                    <Input
                                        id="crmId"
                                        {...register('crmId')}
                                        placeholder="Opportunity / deal reference"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="productId">Product</Label>
                                    <Select
                                        value={productIdValue || NO_OPTION}
                                        onValueChange={(v) =>
                                            setValue(
                                                'productId',
                                                v === NO_OPTION ? '' : v,
                                                { shouldDirty: true },
                                            )
                                        }
                                    >
                                        <SelectTrigger id="productId">
                                            <SelectValue placeholder="Select product" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value={NO_OPTION}>
                                                — None —
                                            </SelectItem>
                                            {fullProductOptions.map((p) => (
                                                <SelectItem
                                                    key={p.value}
                                                    value={p.value}
                                                >
                                                    {p.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="entityId">
                                        Entity{' '}
                                        <span className="text-destructive">
                                            *
                                        </span>
                                    </Label>
                                    <Select
                                        value={entityIdValue || NO_OPTION}
                                        onValueChange={(v) =>
                                            setValue(
                                                'entityId',
                                                v === NO_OPTION ? '' : v,
                                                { shouldDirty: true },
                                            )
                                        }
                                    >
                                        <SelectTrigger id="entityId">
                                            <SelectValue placeholder="Select entity" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value={NO_OPTION}>
                                                — None —
                                            </SelectItem>
                                            {fullEntityOptions.map((e) => (
                                                <SelectItem
                                                    key={e.value}
                                                    value={e.value}
                                                >
                                                    {e.label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <p className="text-[11px] text-muted-foreground">
                                        Required — groups hours in the time
                                        export.
                                    </p>
                                </div>
                            </div>
                        </>
                    )}

                    {isPersonalMode && (
                        <div className="space-y-1.5">
                            <Label htmlFor="linkedProjectId">
                                Linked project{' '}
                                <span
                                    className="text-rose-500"
                                    title="Required for personal projects"
                                >
                                    *
                                </span>
                            </Label>
                            <Select
                                value={linkedProjectValue || ''}
                                onValueChange={(v) =>
                                    setValue(
                                        'linkedProjectId',
                                        v,
                                        { shouldDirty: true },
                                    )
                                }
                            >
                                <SelectTrigger
                                    id="linkedProjectId"
                                    aria-invalid={!linkedProjectValue}
                                    className={
                                        !linkedProjectValue
                                            ? 'border-rose-500/60 focus-visible:ring-rose-500'
                                            : undefined
                                    }
                                >
                                    <SelectValue placeholder="Pick a shared project to link to…" />
                                </SelectTrigger>
                                <SelectContent>
                                    {participatingProjects.length === 0 ? (
                                        <div className="px-2 py-3 text-[11px] text-muted-foreground">
                                            You aren't a participant on any
                                            shared project yet — ask an admin
                                            to add you to one before creating a
                                            personal project.
                                        </div>
                                    ) : (
                                        participatingProjects.map((p) => (
                                            <SelectItem
                                                key={p.id}
                                                value={p.id}
                                            >
                                                {p.code
                                                    ? `${p.code} · ${p.name}`
                                                    : p.name}
                                            </SelectItem>
                                        ))
                                    )}
                                </SelectContent>
                            </Select>
                            <p
                                className={
                                    linkedProjectValue
                                        ? 'text-[11px] text-muted-foreground'
                                        : 'text-[11px] text-rose-600 dark:text-rose-400'
                                }
                            >
                                {linkedProjectValue
                                    ? 'Time logged here will mirror to the linked project.'
                                    : 'Required — every personal project must point at a shared parent so time logged on it appears under the actual project.'}
                            </p>
                        </div>
                    )}

                    {/* Project type — admin-curated category. Hidden on
                        personal projects (slim layout) since it's a
                        workspace categorisation rather than something
                        an individual self-organiser needs. */}
                    {!isPersonalMode && (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label htmlFor="projectTypeId">
                                    Project type
                                </Label>
                                <Select
                                    value={projectTypeValue || NO_OPTION}
                                    onValueChange={(v) =>
                                        setValue(
                                            'projectTypeId',
                                            v === NO_OPTION ? '' : v,
                                            { shouldDirty: true },
                                        )
                                    }
                                >
                                    <SelectTrigger id="projectTypeId">
                                        <SelectValue placeholder="Uncategorised" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={NO_OPTION}>
                                            — None —
                                        </SelectItem>
                                        {fullProjectTypeOptions.map((t) => (
                                            <SelectItem
                                                key={t.value}
                                                value={t.value}
                                            >
                                                {t.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                {fullProjectTypeOptions.length === 0 && (
                                    <p className="text-[11px] text-muted-foreground">
                                        No project types defined yet — admins
                                        can add them in Templates.
                                    </p>
                                )}
                            </div>
                            <p className="self-end text-xs text-muted-foreground">
                                Types marked <strong>Hide complete</strong> in
                                Templates (e.g. Maintenance) hide Completed,
                                Client test, and Billing from status options.
                            </p>
                        </div>
                    )}

                    {/* Start / End — always shown, including for
                        personal projects (it's part of the slim
                        organiser field set). */}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="startDate">Start date</Label>
                            <Input
                                id="startDate"
                                type="date"
                                {...register('startDate')}
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="endDate">End date</Label>
                            <Input
                                id="endDate"
                                type="date"
                                {...register('endDate')}
                            />
                        </div>
                    </div>

                    {/* Owner / Reporter — shared projects only. The
                        owner of a personal project is always the
                        creator and there's nobody to "report" to in
                        a self-organiser. */}
                    {!isPersonalMode && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label>
                                Assigned to
                                {!isEdit && (
                                    <span className="text-rose-500"> *</span>
                                )}
                            </Label>
                            {canPickOwnerOnCreate || canChangeOwnerOnEdit ? (
                                <Select
                                    value={ownerId || ''}
                                    onValueChange={(v) =>
                                        setValue('ownerId', v)
                                    }
                                >
                                    <SelectTrigger
                                        aria-invalid={!isEdit && !ownerId}
                                    >
                                        <SelectValue placeholder="Select assignee" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {users.map((u) => (
                                            <SelectItem key={u.id} value={u.id}>
                                                {u.name}
                                                {u.email ? ` · ${u.email}` : ''}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            ) : (
                                <Input
                                    value={
                                        users.find((u) => u.id === ownerId)
                                            ?.name ||
                                        initialValues?.owner?.name ||
                                        currentUser?.name ||
                                        ''
                                    }
                                    disabled
                                />
                            )}
                            {isEdit && !isAdmin && (
                                <p className="text-xs text-muted-foreground">
                                    Only an administrator can change the
                                    assignee.
                                </p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label>Reporter</Label>
                            <Select
                                value={reporterId || NO_REPORTER}
                                onValueChange={(v) => setValue('reporterId', v)}
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {reporterOptions.map((u) => (
                                        <SelectItem key={u.id} value={u.id}>
                                            {u.name}
                                            {u.email ? ` · ${u.email}` : ''}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    )}

                    {showCollaboratorsPicker && (
                        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                            <div className="flex items-center justify-between">
                                <Label className="flex items-center gap-1.5 text-sm font-semibold">
                                    <Users2 className="h-4 w-4" />
                                    Invite collaborators
                                </Label>
                                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                    Optional
                                </span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Personal projects are private to you. If
                                you'd like help, invite specific people —
                                they'll see and be able to work in this
                                project, but it stays hidden from anyone
                                else (including admins).
                            </p>
                            <CollaboratorPicker
                                allUsers={users}
                                excludeIds={[currentUser?.id].filter(Boolean)}
                                selectedIds={pendingCollaborators}
                                onChange={setPendingCollaborators}
                            />
                        </div>
                    )}

                    {showTeamPicker && (
                        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                            <div className="flex items-center justify-between">
                                <Label className="flex items-center gap-1.5 text-sm font-semibold">
                                    <Users2 className="h-4 w-4" />
                                    Teams
                                </Label>
                                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                    Optional
                                </span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Attach one or more teams. Every member of an
                                attached team is automatically added as a
                                project participant.
                            </p>
                            <ProjectTeamsPicker
                                teams={allTeams}
                                selectedIds={teamIds}
                                onChange={setTeamIds}
                            />
                        </div>
                    )}

                    {showContactsBuilder && (
                        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                            <div className="flex items-center justify-between">
                                <Label className="flex items-center gap-1.5 text-sm font-semibold">
                                    <Contact className="h-4 w-4" />
                                    Important contacts
                                </Label>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-7 gap-1 px-2 text-xs"
                                    onClick={addPendingContact}
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    Add
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Pulled from the selected client when you pick
                                one; add extra people below as needed.
                            </p>
                            {pendingContacts.length === 0 ? (
                                <p className="text-[11px] text-muted-foreground">
                                    {hasClientSelected
                                        ? 'This client has no contacts on file — use Add to enter one.'
                                        : 'Select a client to import contacts, or add manually.'}
                                </p>
                            ) : (
                                <ul className="space-y-2">
                                    {pendingContacts.map((c) => (
                                        <ContactDraftRow
                                            key={c._key}
                                            contact={c}
                                            onChange={(patch) =>
                                                updatePendingContact(
                                                    c._key,
                                                    patch,
                                                )
                                            }
                                            onRemove={() =>
                                                removePendingContact(c._key)
                                            }
                                        />
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    {billingAllowed && !isPersonalMode && (
                        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
                            <div className="flex items-center justify-between">
                                <Label className="text-sm font-semibold">
                                    Billing
                                </Label>
                                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {isAdmin ? 'Admin only' : 'Billing manager'}
                                </span>
                            </div>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div className="rounded-md border bg-card p-3 space-y-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <Label
                                            htmlFor="internalAmount"
                                            className="text-xs font-medium"
                                        >
                                            Internal settlement
                                        </Label>
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-[10px] text-muted-foreground">
                                                Paid
                                            </span>
                                            <Switch
                                                checked={Boolean(internalPaid)}
                                                onCheckedChange={(v) =>
                                                    setValue('internalPaid', v)
                                                }
                                            />
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Input
                                            id="internalAmount"
                                            type="number"
                                            min={0}
                                            step="0.01"
                                            placeholder="0.00"
                                            {...register('internalAmount')}
                                            className="flex-1"
                                        />
                                        <Input
                                            aria-label="Internal currency"
                                            placeholder="EUR"
                                            maxLength={10}
                                            {...register('internalCurrency')}
                                            className="w-20"
                                        />
                                    </div>
                                    <p className="text-[10px] text-muted-foreground">
                                        Cost to be settled internally
                                        between teams.
                                    </p>
                                </div>
                                <div className="rounded-md border bg-card p-3 space-y-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <Label
                                            htmlFor="clientAmount"
                                            className="text-xs font-medium"
                                        >
                                            Client price
                                        </Label>
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-[10px] text-muted-foreground">
                                                Paid
                                            </span>
                                            <Switch
                                                checked={Boolean(clientPaid)}
                                                onCheckedChange={(v) =>
                                                    setValue('clientPaid', v)
                                                }
                                            />
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Input
                                            id="clientAmount"
                                            type="number"
                                            min={0}
                                            step="0.01"
                                            placeholder="0.00"
                                            {...register('clientAmount')}
                                            className="flex-1"
                                        />
                                        <Input
                                            aria-label="Client currency"
                                            placeholder="EUR"
                                            maxLength={10}
                                            {...register('clientCurrency')}
                                            className="w-20"
                                        />
                                    </div>
                                    <p className="text-[10px] text-muted-foreground">
                                        Amount invoiced to the client.
                                    </p>
                                </div>
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="billingNotes" className="text-xs">
                                    Billing notes
                                </Label>
                                <Textarea
                                    id="billingNotes"
                                    rows={2}
                                    placeholder="PO numbers, payment terms, anything to remember…"
                                    {...register('billingNotes')}
                                />
                            </div>
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
                            {submitting ? 'Saving...' : submitLabel}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

// Compact swatch grid for picking a label color. Shown next to the
// label input; disables itself when the label is empty so users can't
// "colour nothing".
function LabelColorPicker({ value, onChange, disabled }) {
    return (
        <Select
            value={value || '__none__'}
            onValueChange={(v) => onChange(v === '__none__' ? '' : v)}
            disabled={disabled}
        >
            <SelectTrigger className="w-[110px]">
                <span className="flex items-center gap-2">
                    <span
                        className={cn(
                            'inline-block h-3 w-3 shrink-0 rounded-full ring-1 ring-border',
                            value
                                ? LABEL_COLORS.find((c) => c.value === value)?.swatch
                                : 'bg-card',
                        )}
                    />
                    <span className="truncate text-xs">
                        {value
                            ? LABEL_COLORS.find((c) => c.value === value)?.label
                            : 'Color'}
                    </span>
                </span>
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="__none__">
                    <span className="flex items-center gap-2">
                        <span className="inline-block h-3 w-3 rounded-full ring-1 ring-border bg-card" />
                        Default
                    </span>
                </SelectItem>
                {LABEL_COLORS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                        <span className="flex items-center gap-2">
                            <span
                                className={cn(
                                    'inline-block h-3 w-3 rounded-full',
                                    c.swatch,
                                )}
                            />
                            {c.label}
                        </span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

// Single-pick dropdown for inviting collaborators to a personal
// project. Selected users render as removable chips above the picker.
// Used in the create flow only; ParticipantsPanel handles ongoing
// invites/removals once the project exists.
function CollaboratorPicker({
    allUsers,
    excludeIds = [],
    selectedIds,
    onChange,
}) {
    const excludeSet = useMemo(() => new Set(excludeIds), [excludeIds]);
    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
    const candidates = useMemo(() => {
        return (allUsers || [])
            .filter((u) => !excludeSet.has(u.id) && !selectedSet.has(u.id))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }, [allUsers, excludeSet, selectedSet]);
    const selectedUsers = useMemo(
        () =>
            selectedIds
                .map((id) => allUsers.find((u) => u.id === id))
                .filter(Boolean),
        [allUsers, selectedIds],
    );
    return (
        <div className="space-y-2">
            {selectedUsers.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                    {selectedUsers.map((u) => (
                        <span
                            key={u.id}
                            className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs"
                        >
                            <span className="truncate">{u.name}</span>
                            <button
                                type="button"
                                onClick={() =>
                                    onChange(
                                        selectedIds.filter(
                                            (id) => id !== u.id,
                                        ),
                                    )
                                }
                                className="text-muted-foreground hover:text-foreground"
                                aria-label={`Remove ${u.name}`}
                            >
                                <XIcon className="h-3 w-3" />
                            </button>
                        </span>
                    ))}
                </div>
            )}
            {candidates.length > 0 ? (
                <Select
                    value=""
                    onValueChange={(v) => {
                        if (!v) return;
                        onChange([...selectedIds, v]);
                    }}
                >
                    <SelectTrigger>
                        <SelectValue placeholder="Add a collaborator…" />
                    </SelectTrigger>
                    <SelectContent>
                        {candidates.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                                {u.name}
                                {u.email ? ` · ${u.email}` : ''}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            ) : (
                <p className="rounded-md border border-dashed p-2 text-center text-[11px] text-muted-foreground">
                    No more users to invite.
                </p>
            )}
        </div>
    );
}

// Compact inline editor for one pending project contact. Only used in
// the create flow — edits / adds for an existing project happen via
// the ProjectContactsPanel, which talks straight to the API.
function ContactDraftRow({ contact, onChange, onRemove }) {
    return (
        <li className="rounded-md border bg-card p-2.5">
            {contact._fromClient && (
                <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    From client
                </p>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <Input
                    placeholder="Name *"
                    value={contact.name}
                    onChange={(e) => onChange({ name: e.target.value })}
                    maxLength={200}
                    className="h-8 text-sm"
                />
                <Input
                    placeholder="Role / title"
                    value={contact.role}
                    onChange={(e) => onChange({ role: e.target.value })}
                    maxLength={2000}
                    className="h-8 text-sm"
                />
                <Input
                    placeholder="Company"
                    value={contact.company}
                    onChange={(e) => onChange({ company: e.target.value })}
                    maxLength={2000}
                    className="h-8 text-sm"
                />
                <div className="flex items-center gap-1">
                    <Input
                        placeholder="Email"
                        type="email"
                        value={contact.email}
                        onChange={(e) =>
                            onChange({ email: e.target.value })
                        }
                        maxLength={320}
                        className="h-8 text-sm"
                    />
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                        onClick={onRemove}
                        title="Remove contact"
                        aria-label="Remove contact"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                </div>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Input
                    placeholder="Phone"
                    value={contact.phone}
                    onChange={(e) => onChange({ phone: e.target.value })}
                    maxLength={2000}
                    className="h-8 text-sm"
                />
                <Input
                    placeholder="Notes (optional)"
                    value={contact.notes}
                    onChange={(e) => onChange({ notes: e.target.value })}
                    maxLength={2000}
                    className="h-8 text-sm"
                />
            </div>
        </li>
    );
}

// Dropdown picker for attaching teams to a brand-new project. The
// Select stays single-pick — choosing a team adds it to the chip list
// above and the dropdown immediately resets to the placeholder so the
// admin can pick another. Picked teams are removable via the X on
// each chip. Reused by the create flow only — once the project
// exists, ProjectTeamsPanel takes over.
function ProjectTeamsPicker({ teams, selectedIds, onChange }) {
    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
    const selectedTeams = useMemo(
        () =>
            selectedIds
                .map((id) => teams.find((t) => t.id === id))
                .filter(Boolean),
        [teams, selectedIds],
    );
    const candidates = useMemo(() => {
        return teams
            .filter((t) => !selectedSet.has(t.id))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }, [teams, selectedSet]);

    if (teams.length === 0) {
        return (
            <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                No teams defined yet. Create one under <strong>Teams</strong>.
            </p>
        );
    }

    return (
        <div className="space-y-2">
            <Select
                // Always-controlled with a sentinel "" string so the
                // Select renders the placeholder after each pick. The
                // onValueChange handler appends to selectedIds and the
                // re-render naturally clears the trigger label.
                value=""
                onValueChange={(v) => {
                    if (!v || selectedSet.has(v)) return;
                    onChange([...selectedIds, v]);
                }}
            >
                <SelectTrigger>
                    <SelectValue
                        placeholder={
                            candidates.length === 0
                                ? 'All teams attached'
                                : 'Add a team…'
                        }
                    />
                </SelectTrigger>
                <SelectContent>
                    {candidates.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            All teams already attached.
                        </div>
                    ) : (
                        candidates.map((t) => {
                            const memberCount =
                                t.memberCount ?? t.members?.length ?? 0;
                            return (
                                <SelectItem key={t.id} value={t.id}>
                                    <span className="flex items-center gap-2">
                                        <Users2 className="h-3.5 w-3.5 text-muted-foreground" />
                                        {t.name}
                                        <span className="text-[11px] text-muted-foreground">
                                            · {memberCount} member
                                            {memberCount === 1 ? '' : 's'}
                                        </span>
                                    </span>
                                </SelectItem>
                            );
                        })
                    )}
                </SelectContent>
            </Select>
            {selectedTeams.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {selectedTeams.map((t) => {
                        const memberCount =
                            t.memberCount ?? t.members?.length ?? 0;
                        return (
                            <span
                                key={t.id}
                                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                            >
                                <Users2 className="h-3 w-3" />
                                {t.name}
                                <span className="text-[10px] text-muted-foreground">
                                    · {memberCount}
                                </span>
                                <button
                                    type="button"
                                    className="ml-0.5 text-primary/70 hover:text-destructive"
                                    onClick={() =>
                                        onChange(
                                            selectedIds.filter(
                                                (x) => x !== t.id,
                                            ),
                                        )
                                    }
                                    aria-label={`Remove ${t.name}`}
                                >
                                    <XIcon className="h-3 w-3" />
                                </button>
                            </span>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
