// Tiny pub-sub for the "processing complete / N new detections" toast (ported from
// js/app.js liveToast()).
const listeners = new Set();
export function subscribeToast(cb) { listeners.add(cb); return () => listeners.delete(cb); }
export function showToast(msg) { listeners.forEach(l => l(msg)); }
