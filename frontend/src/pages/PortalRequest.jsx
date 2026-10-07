// Requester's view of one request — the same ticket window agents use
// (components/TicketDetail), in requester mode: only what a requester can
// do (comment, attach files, add people or groups, change priority, and
// edit / delete the request until an agent picks it up). Used two ways:
//   - as a routed page (/portal/requests/:id) — id from the URL, "back"
//     goes to /portal.
//   - inside a modal on the portal home — the caller passes `idProp` and
//     `onClose`; `onChanged` lets the portal list refresh after edits.
import { useCallback, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';

import { useAuth } from '@/contexts/AuthContext';
import { hasCapability, CAPABILITIES } from '@/lib/capabilities';
import { TicketDetail } from '@/components/TicketDetail';

export default function PortalRequest({
    idProp = null,
    onClose = null,
    onChanged = null,
}) {
    const params = useParams();
    const id = idProp || params.id;
    const navigate = useNavigate();
    const { user } = useAuth();
    const inModal = !!onClose;
    // Leave the detail: close the modal if embedded, else go home.
    const goBack = useCallback(() => {
        if (onClose) onClose();
        else navigate('/portal');
    }, [onClose, navigate]);

    // Ticket-managers (agents/admins) who land on this routed portal page
    // — e.g. from a notification on a ticket they raised internally — have
    // no way back to their workspace. Bounce them to /tickets, which opens
    // the same ticket in the resolver window. Requesters stay on the portal.
    const canManageTickets =
        user?.role === 'ADMIN' ||
        hasCapability(user, CAPABILITIES.TICKET_MANAGE);
    useEffect(() => {
        if (!inModal && canManageTickets && id) {
            navigate(`/tickets?ticket=${id}`, { replace: true });
        }
    }, [inModal, canManageTickets, id, navigate]);
    if (!inModal && canManageTickets) return null;

    const detail = (
        <TicketDetail
            key={id}
            ticketId={id}
            canManage={false}
            currentUser={user}
            onChanged={onChanged}
            // removeTicket already refreshes the list (onChanged).
            onDeleted={goBack}
            onLoadError={goBack}
        />
    );

    if (inModal) return detail;

    return (
        <div className="space-y-3">
            <Link
                to="/portal"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
                <ChevronLeft className="h-3.5 w-3.5" /> Back to home page
            </Link>
            {/* Desktop: a fixed-height frame so the conversation and the
                details column scroll on their own, like in the modal. */}
            <div className="flex flex-col overflow-hidden rounded-xl border bg-background shadow-sm lg:h-[calc(100vh-9rem)] lg:min-h-[32rem]">
                {detail}
            </div>
        </div>
    );
}
