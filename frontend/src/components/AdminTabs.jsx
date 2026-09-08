// Shared tab bar for the admin section — folder-style card tabs. Rendered
// under the TopBar on each admin page so Announcements / Templates / Time
// logging / Billing read as one tabbed panel. The active tab is a raised
// card that connects to the content below; inactive tabs are recessed.
import { NavLink } from 'react-router-dom';

import { cn } from '@/lib/utils';

const ADMIN_TABS = [
    { to: '/announcements', label: 'Announcements' },
    { to: '/templates', label: 'Templates' },
    { to: '/time-logging', label: 'Time logging' },
    { to: '/billing', label: 'Billing' },
];

export default function AdminTabs() {
    return (
        <div className="flex items-end gap-1.5 overflow-x-auto border-b bg-muted/30 px-3 pt-2 sm:px-6">
            {ADMIN_TABS.map((t) => (
                <NavLink
                    key={t.to}
                    to={t.to}
                    className={({ isActive }) =>
                        cn(
                            '-mb-px whitespace-nowrap rounded-t-lg border px-4 py-2 text-sm font-medium transition-colors',
                            isActive
                                ? 'border-border border-b-transparent bg-card text-foreground shadow-sm'
                                : 'border-transparent bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
                        )
                    }
                >
                    {t.label}
                </NavLink>
            ))}
        </div>
    );
}
