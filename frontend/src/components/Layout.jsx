import { Outlet, Navigate } from 'react-router-dom';

import { Sidebar } from '@/components/Sidebar';
import { ChatLauncher } from '@/components/ChatLauncher';
import TimeLogReminder from '@/components/TimeLogReminder';
import AnnouncementModal from '@/components/AnnouncementModal';
import { RealtimeProvider } from '@/contexts/RealtimeContext';
import { MobileSidebarProvider } from '@/contexts/MobileSidebarContext';
import { ActiveTimerProvider } from '@/contexts/ActiveTimerContext';
import { useAuth } from '@/contexts/AuthContext';

export function Layout() {
    const { user } = useAuth();
    // Requesters never see the PM Tool — any PM route bounces them to
    // their portal.
    if (user?.role === 'REQUESTER') {
        return <Navigate to="/portal" replace />;
    }
    return (
        <RealtimeProvider>
            <ActiveTimerProvider>
                <MobileSidebarProvider>
                    <div className="flex h-screen bg-background">
                        <Sidebar />
                        <div className="flex flex-1 flex-col overflow-hidden">
                            <Outlet />
                        </div>
                        <ChatLauncher />
                        <TimeLogReminder />
                        <AnnouncementModal />
                    </div>
                </MobileSidebarProvider>
            </ActiveTimerProvider>
        </RealtimeProvider>
    );
}
