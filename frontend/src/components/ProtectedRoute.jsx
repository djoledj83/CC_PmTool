import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { hasCapability } from '@/lib/capabilities';

export function ProtectedRoute({
    children,
    adminOnly = false,
    adminOrManagerOnly = false,
    // Optional capability override. When set, any user holding the
    // listed capability (string OR array of strings — any single match
    // is enough) passes the gate REGARDLESS of `adminOnly` /
    // `adminOrManagerOnly`. Lets us keep the existing role flags as
    // sensible defaults while granting access to capability holders
    // an admin has explicitly toggled on in the User edit dialog.
    // Without this, granting e.g. `team:manage` to a USER did nothing
    // because they were still bounced at /teams by the role gate.
    requiredCapability = null,
}) {
    const { user, loading } = useAuth();
    const location = useLocation();

    if (loading) {
        return (
            <div className="flex h-screen items-center justify-center text-muted-foreground">
                Loading...
            </div>
        );
    }

    if (!user) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    // Capability shortcut: any matching cap unblocks the route even
    // when the role gates below would have bounced the user.
    const capList = Array.isArray(requiredCapability)
        ? requiredCapability
        : requiredCapability
          ? [requiredCapability]
          : [];
    const capabilityGrants = capList.some((cap) => hasCapability(user, cap));

    if (adminOnly && user.role !== 'ADMIN' && !capabilityGrants) {
        return <Navigate to="/projects" replace />;
    }

    if (
        adminOrManagerOnly &&
        user.role !== 'ADMIN' &&
        user.role !== 'MANAGER' &&
        !capabilityGrants
    ) {
        return <Navigate to="/projects" replace />;
    }

    return children;
}
