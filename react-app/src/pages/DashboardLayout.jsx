import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../context/SessionContext.jsx';
import { UIProvider } from '../context/UIContext.jsx';
import { LayoutProvider, useLayout } from '../context/LayoutContext.jsx';
import Sidebar from '../components/Sidebar.jsx';
import IssueDrawer from '../components/IssueDrawer.jsx';
import CrewModal from '../components/CrewModal.jsx';
import LiveToast from '../components/LiveToast.jsx';
import { startLivePolling } from '../lib/livePoll.js';
import { wardPath } from '../lib/routes.js';

export default function DashboardLayout() {
  return (
    <UIProvider>
      <LayoutProvider>
        <DashboardShell />
      </LayoutProvider>
    </UIProvider>
  );
}

function DashboardShell() {
  const { session } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const { sidebarOpen, closeSidebar } = useLayout();

  // Role-based landing view — only redirect from the bare "/" so a bookmarked/
  // shared URL to a specific view (e.g. /crew) still opens directly.
  useEffect(() => {
    if (location.pathname !== '/') return;
    if (session?.role === 'ward_officer' && session.ward) navigate(wardPath(session.ward), { replace: true });
    else if (session?.role === 'crew') navigate('/my-work', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, location.pathname]);

  useEffect(() => {
    document.body.classList.remove('role-admin', 'role-ward_officer', 'role-user', 'role-crew');
    if (session) document.body.classList.add('role-' + session.role);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    return startLivePolling();
  }, [session]);

  return (
    <div className="app">
      <Sidebar />
      {sidebarOpen && <div className="sidebar-backdrop" onClick={closeSidebar} />}
      <div className="main">
        <Outlet />
      </div>
      <IssueDrawer />
      <CrewModal />
      <LiveToast />
    </div>
  );
}
