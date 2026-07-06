import { useSyncExternalStore } from 'react';
import { subscribe, getVersion } from './store.js';

// Subscribes a component to the mutable model store (issues/, SCORES, CREW). Any
// notify() call anywhere re-renders every subscriber — mirrors the original app's
// single full render() after each mutation.
export function useStore() {
  return useSyncExternalStore(subscribe, getVersion);
}
