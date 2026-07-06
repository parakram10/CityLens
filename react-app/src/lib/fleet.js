// CityLens — fleet/trip helpers (ported from js/app.js).
import { DATA } from './data.js';
import { CITYLENS_LIVE } from './live.js';
import { issues } from './model.js';

// Detector runs from js/live.js -> CITYLENS_LIVE.runs. Each run is one Fleet trip:
// {id,label,bus,date,distance_km,video,motion,feed}. Its de-duplicated pins live in
// DATA.issues (tagged with runId); its feed/motion/video drive that trip's replay.
export function liveRuns() { return CITYLENS_LIVE.runs || []; }
export function runById(id) { return liveRuns().find(r => r.id === id) || null; }
export function busShort(b) { return b ? String(b).replace(/^.*-/, '') : ''; } // "MH01-BST-1423" -> "1423"

// Every distinct bus/trip that detected this spot — passes is the count of these.
export function tripBusesFor(i) {
  const ids = (i.runIds && i.runIds.length) ? i.runIds : (i.runId ? [i.runId] : []);
  const seen = new Set(), out = [];
  ids.forEach(rid => { const r = runById(rid), b = r && r.bus; if (b && !seen.has(b)) { seen.add(b); out.push(b); } });
  return out.length ? out : (i.bus ? [i.bus] : []);
}

export function tripsForBus(busId) { // one detector run assigned to this bus = one trip
  return liveRuns().filter(r => r.bus === busId).map(r => {
    const stops = issues.filter(i => (i.runIds || [i.runId]).includes(r.id));
    return {
      id: r.id, date: r.date, label: r.label, run: r, stops,
      wards: [...new Set(stops.map(i => i.ward))],
      detections: (r.feed || []).length,
    };
  }).sort((a, b) => b.date.localeCompare(a.date));
}

export function tripsForStreet(streetId) { // which bus+trip pairs detected something on this corridor
  const byKey = {};
  issues.filter(i => i.streetId === streetId).forEach(i => {
    (i.history || []).forEach(h => {
      const date = h.t.slice(0, 10);
      const run = liveRuns().find(r => r.bus === h.bus && r.date === date);
      if (!run) return;
      const key = run.id;
      (byKey[key] = byKey[key] || { bus: run.bus, date: run.date, id: run.id, issueIds: new Set() }).issueIds.add(i.id);
    });
  });
  return Object.values(byKey).map(x => ({ bus: x.bus, date: x.date, id: x.id, detections: x.issueIds.size }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function addRouteOverlay(L, map) { // fixed A-71 demo route, drawn only on the Fleet trip-replay map
  return L.polyline(DATA.routes['A-71'], { color: '#3b6fc4', weight: 4, opacity: .6 }).addTo(map);
}
export function haversineKm(a, b) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
