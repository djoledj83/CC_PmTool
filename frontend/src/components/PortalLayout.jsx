// Shell for the requester portal — a deliberately minimal chrome (just a
// "Help Center" header + sign out), with none of the PM Tool sidebar.
// REQUESTER-role users live entirely inside this; other roles can visit
// it too (e.g. to raise a request) but reach it explicitly.
import { useState } from 'react';
import { Outlet, Link, useNavigate } from 'react-router-dom';
import { LifeBuoy, LogOut } from 'lucide-react';

import { useAuth } from '@/contexts/AuthContext';
import { RealtimeProvider } from '@/contexts/RealtimeContext';
import { Button } from '@/components/ui/button';
import { NotificationBell } from '@/components/NotificationBell';
import { ProfileDialog } from '@/components/ProfileDialog';
import AnnouncementModal from '@/components/AnnouncementModal';

export function PortalLayout() {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    const [profileOpen, setProfileOpen] = useState(false);

    const signOut = async () => {
        await logout();
        navigate('/login');
    };

    // RealtimeProvider powers the notification bell (socket + counts) for
    // requesters, who otherwise have none of the PM-tool chrome.
    return (
        <RealtimeProvider>
            <div className="flex min-h-screen flex-col bg-muted/30">
                <header className="border-b bg-background">
                    <div className="mx-auto flex w-full max-w-[90vw] items-center justify-between px-4 py-3">
                        <Link
                            to="/portal"
                            className="flex items-center gap-2 text-base font-semibold"
                        >
                            <LifeBuoy className="h-5 w-5 text-primary" />
                            Home page
                        </Link>
                        <div className="flex items-center gap-2 text-sm">
                            <button
                                type="button"
                                onClick={() => setProfileOpen(true)}
                                className="hidden text-muted-foreground hover:text-foreground hover:underline sm:inline"
                                title="Edit your profile"
                            >
                                {user?.name || user?.email}
                            </button>
                            <NotificationBell ticketsOnly />
                            <Button
                                variant="ghost"
                                size="sm"
                                className="gap-1.5"
                                onClick={signOut}
                            >
                                <LogOut className="h-4 w-4" /> Sign out
                            </Button>
                        </div>
                    </div>
                </header>
                <main className="mx-auto w-full max-w-[90vw] flex-1 px-4 py-6">
                    <Outlet />
                </main>
            </div>
            <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
            <AnnouncementModal />
        </RealtimeProvider>
    );
}

export default PortalLayout;
