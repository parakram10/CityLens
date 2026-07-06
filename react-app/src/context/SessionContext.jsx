import { createContext, useContext, useState, useCallback } from 'react';
import { getSession, logout as authLogout } from '../lib/auth.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [session, setSession] = useState(() => getSession());

  const refresh = useCallback(() => setSession(getSession()), []);
  const logout = useCallback(() => { authLogout(); }, []); // reloads the page, same as original

  return (
    <SessionContext.Provider value={{ session, refresh, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  return useContext(SessionContext);
}
