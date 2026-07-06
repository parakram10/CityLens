import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SessionProvider, useSession } from './context/SessionContext.jsx';
import Login from './pages/Login.jsx';
import DashboardLayout from './pages/DashboardLayout.jsx';
import CityView from './views/CityView.jsx';
import WardsView from './views/WardsView.jsx';
import WardView from './views/WardView.jsx';
import StreetView from './views/StreetView.jsx';
import CatView from './views/CatView.jsx';
import CrewView from './views/CrewView.jsx';
import PerformanceView from './views/PerformanceView.jsx';
import MyWorkView from './views/MyWorkView.jsx';
import FleetList from './views/FleetList.jsx';
import TripReplay from './views/TripReplay.jsx';

function RequireAuth({ children }) {
  const { session } = useSession();
  if (!session) return <Navigate to="/login" replace />;
  return children;
}

function RedirectIfAuthed({ children }) {
  const { session } = useSession();
  if (session) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route path="/login" element={<RedirectIfAuthed><Login /></RedirectIfAuthed>} />
          <Route path="/" element={<RequireAuth><DashboardLayout /></RequireAuth>}>
            <Route index element={<CityView />} />
            <Route path="wards" element={<WardsView />} />
            <Route path="ward/:wardId" element={<WardView />} />
            <Route path="streets" element={<StreetView />} />
            <Route path="streets/:streetId" element={<StreetView />} />
            <Route path="category/:type" element={<CatView />} />
            <Route path="crew" element={<CrewView />} />
            <Route path="performance" element={<PerformanceView />} />
            <Route path="my-work" element={<MyWorkView />} />
            <Route path="fleet" element={<FleetList />} />
            <Route path="fleet/:bus/:trip" element={<TripReplay />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
