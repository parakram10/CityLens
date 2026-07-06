import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../context/SessionContext.jsx';
import { UIProvider } from '../context/UIContext.jsx';
import Sidebar from '../components/Sidebar.jsx';
import IssueDrawer from '../components/IssueDrawer.jsx';
import CrewModal from '../components/CrewModal.jsx';
import LiveToast from '../components/LiveToast.jsx';
import { startLivePolling } from '../lib/livePoll.js';

import CityView from '../views/CityView.jsx';
import WardsView from '../views/WardsView.jsx';
import WardView from '../views/WardView.jsx';
import StreetView from '../views/StreetView.jsx';
import CatView from '../views/CatView.jsx';
import CrewView from '../views/CrewView.jsx';
import PerformanceView from '../views/PerformanceView.jsx';
import MyWorkView from '../views/MyWorkView.jsx';
import FleetView from '../views/FleetView.jsx';

function initialStateFor(session) {
  const base = { view: 'city', ward: null, street: null, type: null, assignFilter: 'all', bus: null, trip: null };
  if (session?.role === 'ward_officer') return { ...base, view: 'ward', ward: session.ward };
  if (session?.role === 'crew') return { ...base, view: 'mywork' };
  return base;
}

export default function Dashboard() {
  const { session } = useSession();
  const [state, setState] = useState(() => initialStateFor(session));

  useEffect(() => {
    document.body.classList.remove('role-admin', 'role-ward_officer', 'role-user', 'role-crew');
    if (session) document.body.classList.add('role-' + session.role);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    return startLivePolling();
  }, [session]);

  const go = useCallback((view, patch = {}) => {
    setState(s => ({ ...s, view, ...patch }));
  }, []);

  return (
    <UIProvider>
      <div className="app">
        <Sidebar state={state} go={go} />
        <div className="main">
          <ViewRouter state={state} setState={setState} go={go} />
        </div>
      </div>
      <IssueDrawer />
      <CrewModal />
      <LiveToast />
    </UIProvider>
  );
}

function ViewRouter({ state, setState, go }) {
  switch (state.view) {
    case 'city': return <CityView go={go} />;
    case 'wards': return <WardsView go={go} />;
    case 'ward': return <WardView state={state} setState={setState} go={go} />;
    case 'street': return <StreetView state={state} setState={setState} go={go} />;
    case 'cat': return <CatView state={state} go={go} />;
    case 'crew': return <CrewView go={go} />;
    case 'performance': return <PerformanceView go={go} />;
    case 'mywork': return <MyWorkView go={go} />;
    case 'fleet': return <FleetView state={state} setState={setState} go={go} />;
    default: return null;
  }
}
