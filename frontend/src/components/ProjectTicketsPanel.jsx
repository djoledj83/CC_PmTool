// Project detail → "Tickets" tab. Lists every help-desk ticket linked
// to this project (Ticket.projectId === project.id). Read-only here:
// clicking a card jumps to the agent Tickets workspace with the ticket
// opened (deep-link `?ticket=<id>`), where the full conversation and
// actions (take, status, "Add as Task") live.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Loader2, Search, LifeBuoy } from 'lucide-react';

import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import TicketCardShared from '@/components/TicketCardShared';

export function ProjectTicketsPanel({ projectId }) {
    const navigate = useNavigate();
    const [tickets, setTickets] = useState([]);
    const [loading, setLoading] = useState(true);
    const [q, setQ] = useState('');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                setLoading(true);
                const { data } = await api.get('/tickets', {
                    params: { projectId },
                });
                if (!cancelled) setTickets(data.tickets || []);
            } catch (err) {
                if (!cancelled)
                    toast.error(
                        err.response?.data?.error ||
                            'Could not load tickets for this project.',
                    );
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    const filtered = useMemo(() => {
        const term = q.trim().toLowerCase();
        if (!term) return tickets;
        return tickets.filter(
            (t) =>
                t.subject?.toLowerCase().includes(term) ||
                t.code?.toLowerCase().includes(term),
        );
    }, [tickets, q]);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                    {tickets.length} ticket{tickets.length === 1 ? '' : 's'}{' '}
                    linked to this project
                </p>
                {tickets.length > 0 && (
                    <div className="relative w-full max-w-xs">
                        <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={q}
                            onChange={(e) => setQ(e.target.value)}
                            placeholder="Search tickets…"
                            className="pl-8"
                        />
                    </div>
                )}
            </div>

            {filtered.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center text-muted-foreground">
                    <LifeBuoy className="h-8 w-8 opacity-40" />
                    <p className="text-sm">
                        {tickets.length === 0
                            ? 'No tickets are linked to this project yet.'
                            : 'No tickets match your search.'}
                    </p>
                </div>
            ) : (
                <div className="grid content-start items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {filtered.map((t) => (
                        <TicketCardShared
                            key={t.id}
                            t={t}
                            onOpen={() => navigate(`/tickets?ticket=${t.id}`)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export default ProjectTicketsPanel;
