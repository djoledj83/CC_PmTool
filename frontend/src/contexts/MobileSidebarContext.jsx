import { createContext, useContext, useMemo, useState } from 'react';

// Tiny coordinator so the TopBar's hamburger button (rendered on
// every page) can open/close the same mobile sidebar drawer that
// `Sidebar` renders. Desktop layouts ignore it entirely.

const MobileSidebarContext = createContext({
    open: false,
    setOpen: () => {},
});

export function MobileSidebarProvider({ children }) {
    const [open, setOpen] = useState(false);
    const value = useMemo(() => ({ open, setOpen }), [open]);
    return (
        <MobileSidebarContext.Provider value={value}>
            {children}
        </MobileSidebarContext.Provider>
    );
}

export function useMobileSidebar() {
    return useContext(MobileSidebarContext);
}
