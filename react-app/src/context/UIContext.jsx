import { createContext, useContext, useState, useCallback } from 'react';

// Centralizes the drawer/modal overlays that, in the original app, were opened by
// global functions (openIssue, openCrew, openAssignCrew, openAddCrew,
// openAssignWardCrew) callable from any view.
const UIContext = createContext(null);

export function UIProvider({ children }) {
  const [drawer, setDrawer] = useState(null); // { issueId, opts }
  const [modal, setModal] = useState(null); // { type, payload }

  const openIssue = useCallback((issueId, opts = {}) => {
    setModal(null);
    setDrawer({ issueId, opts });
  }, []);
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const openModal = useCallback((type, payload) => setModal({ type, payload }), []);
  const closeModal = useCallback(() => setModal(null), []);
  const closeAll = useCallback(() => { setDrawer(null); setModal(null); }, []);

  return (
    <UIContext.Provider value={{ drawer, modal, openIssue, closeDrawer, openModal, closeModal, closeAll }}>
      {children}
    </UIContext.Provider>
  );
}

export function useUI() {
  return useContext(UIContext);
}
