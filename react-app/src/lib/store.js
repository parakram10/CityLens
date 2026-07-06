// Tiny external store so React re-renders whenever the mutable model (issues/, SCORES,
// CREW, WARD_CREW) changes — mirrors the original app's "mutate then render()" pattern
// without introducing a full state-management library.
const listeners = new Set();
let version = 0;

export function notify() {
  version++;
  listeners.forEach(l => l());
}
export function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
export function getVersion() {
  return version;
}
