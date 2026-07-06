import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// Drives the off-canvas sidebar on narrow viewports (see app.css @media rules).
// Kept as context so the hamburger button (in Header, rendered per-view) and the
// sidebar itself (in the layout) can share open/close state without prop drilling.
const LayoutContext = createContext(null);

export function LayoutProvider({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  // Close the mobile nav automatically whenever the route changes.
  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  const toggleSidebar = useCallback(() => setSidebarOpen(v => !v), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return (
    <LayoutContext.Provider value={{ sidebarOpen, toggleSidebar, closeSidebar }}>
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayout() {
  return useContext(LayoutContext);
}
