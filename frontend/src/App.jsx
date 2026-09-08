import { Routes, Route, Navigate, useParams } from 'react-router-dom';

import { Layout } from '@/components/Layout';
import { PortalLayout } from '@/components/PortalLayout';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { useAuth } from '@/contexts/AuthContext';
import Portal from '@/pages/Portal';
import PortalRequest from '@/pages/PortalRequest';
import Login from '@/pages/Login';
import Register from '@/pages/Register';
import ForgotPassword from '@/pages/ForgotPassword';
import ResetPassword from '@/pages/ResetPassword';
import Projects from '@/pages/Projects';
import ProjectDetail from '@/pages/ProjectDetail';
import ChangeRequestDetail from '@/pages/ChangeRequestDetail';
import Messages from '@/pages/Messages';
import Todos from '@/pages/Todos';
import Users from '@/pages/Users';
import UserProfile from '@/pages/UserProfile';
import Insights from '@/pages/Insights';
import Applications from '@/pages/Applications';
import ApplicationDetail from '@/pages/ApplicationDetail';
import Clients from '@/pages/Clients';
import Activities from '@/pages/Activities';
import Billing from '@/pages/Billing';
import Templates from '@/pages/Templates';
import TimeLoggingSettings from '@/pages/TimeLoggingSettings';
import Announcements from '@/pages/Announcements';
import Teams from '@/pages/Teams';
import Requests from '@/pages/Requests';
import TimeTracking from '@/pages/TimeTracking';
import PlanningSprints from '@/pages/PlanningSprints';
import Tickets from '@/pages/Tickets';
import TicketRequestTypes from '@/pages/TicketRequestTypes';
import Help from '@/pages/Help';
import { CAPABILITIES } from '@/lib/capabilities';

function RedirectProductsDetail() {
    const { id } = useParams();
    return <Navigate to={`/applications/${id}`} replace />;
}

// Landing redirect: requesters go to their portal, everyone else to the
// PM Tool home.
function HomeRedirect() {
    const { user } = useAuth();
    return (
        <Navigate
            to={user?.role === 'REQUESTER' ? '/portal' : '/projects'}
            replace
        />
    );
}

// Role-agnostic ticket deep-link. Notification links and in-message
// "#" ticket references point here (/t/:id) instead of a hard-coded
// surface, so the SAME link opens the right view for whoever clicks it:
// requesters land on their portal request page, agents/managers on the
// workspace ticket. This is what lets a shared ticket actually open for
// a requester — previously the link went straight to /tickets?ticket=…
// (the agent workspace), which a requester can't use.
function TicketRedirect() {
    const { user } = useAuth();
    const { id } = useParams();
    const toPortal = user?.role === 'REQUESTER' || user?.external;
    return (
        <Navigate
            to={toPortal ? `/portal/requests/${id}` : `/tickets?ticket=${id}`}
            replace
        />
    );
}

export default function App() {
    return (
        <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            {/* Role-agnostic ticket deep-link — redirects to the portal
                or the workspace ticket depending on who's signed in. */}
            <Route
                path="/t/:id"
                element={
                    <ProtectedRoute>
                        <TicketRedirect />
                    </ProtectedRoute>
                }
            />
            <Route
                element={
                    <ProtectedRoute>
                        <Layout />
                    </ProtectedRoute>
                }
            >
                <Route index element={<HomeRedirect />} />
                <Route path="/projects" element={<Projects />} />
                <Route path="/projects/:id" element={<ProjectDetail />} />
                {/* Change Request detail. URL shape chosen so the
                    parent project is always present in the path —
                    breadcrumbs, "back to project" links, and audit
                    deep-links all benefit. */}
                <Route
                    path="/projects/:projectId/cr/:crId"
                    element={<ChangeRequestDetail />}
                />
                <Route path="/messages" element={<Messages />} />
                <Route path="/todos" element={<Todos />} />
                <Route path="/tickets" element={<Tickets />} />
                {/* /users is open to every signed-in user. The Users
                    page itself short-circuits to a read-only roster
                    (Directory) for non-admins; admins see the full
                    management table. One URL, one sidebar entry. */}
                <Route path="/users" element={<Users />} />
                {/* Public-ish user profile — every signed-in user can
                    view any teammate's profile (admins can also edit
                    from this page via the action in the TopBar). */}
                <Route path="/users/:id" element={<UserProfile />} />
                {/* Back-compat: anyone with an old /directory bookmark
                    or link lands on /users (which renders the right
                    surface for their role). */}
                <Route
                    path="/directory"
                    element={<Navigate to="/users" replace />}
                />
                <Route path="/insights" element={<Insights />} />
                <Route
                    path="/clients"
                    element={
                        <ProtectedRoute adminOnly>
                            <Clients />
                        </ProtectedRoute>
                    }
                />
                <Route path="/applications" element={<Applications />} />
                <Route path="/applications/:id" element={<ApplicationDetail />} />
                <Route
                    path="/products"
                    element={<Navigate to="/applications" replace />}
                />
                <Route
                    path="/products/:id"
                    element={<RedirectProductsDetail />}
                />
                {/* Activities is now the audit feed (admin-only). The
                    "My / All activities" tabs moved to /todos so every
                    user has them next to their personal to-do list. */}
                <Route
                    path="/activities"
                    element={
                        <ProtectedRoute adminOnly>
                            <Activities />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path="/billing"
                    element={
                        <ProtectedRoute adminOnly>
                            <Billing />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path="/templates"
                    element={
                        <ProtectedRoute
                            adminOnly
                            requiredCapability={CAPABILITIES.TEMPLATE_MANAGE}
                        >
                            <Templates />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path="/ticket-types"
                    element={
                        <ProtectedRoute adminOnly>
                            <TicketRequestTypes />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path="/time-logging"
                    element={
                        <ProtectedRoute adminOnly>
                            <TimeLoggingSettings />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path="/admin"
                    element={<Navigate to="/announcements" replace />}
                />
                <Route
                    path="/announcements"
                    element={
                        <ProtectedRoute adminOnly>
                            <Announcements />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path="/teams"
                    element={
                        <ProtectedRoute
                            adminOrManagerOnly
                            requiredCapability={CAPABILITIES.TEAM_MANAGE}
                        >
                            <Teams />
                        </ProtectedRoute>
                    }
                />
                <Route path="/requests" element={<Requests />} />
                {/* Back-compat: the standalone Reassignments page is now
                    the first tab of the Requests hub. Old bookmarks and
                    notification links to /reassignments land there. */}
                <Route
                    path="/reassignments"
                    element={<Navigate to="/requests" replace />}
                />
                <Route path="/time" element={<TimeTracking />} />
                <Route
                    path="/planning-sprints"
                    element={
                        <ProtectedRoute adminOrManagerOnly>
                            <PlanningSprints />
                        </ProtectedRoute>
                    }
                />
                <Route path="/help" element={<Help />} />
                <Route path="*" element={<Navigate to="/projects" replace />} />
            </Route>
            {/* Requester portal — its own shell (no PM sidebar). */}
            <Route
                element={
                    <ProtectedRoute>
                        <PortalLayout />
                    </ProtectedRoute>
                }
            >
                <Route path="/portal" element={<Portal />} />
                <Route
                    path="/portal/requests/:id"
                    element={<PortalRequest />}
                />
            </Route>
        </Routes>
    );
}
