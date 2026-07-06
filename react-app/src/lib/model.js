// CityLens — core domain model (ported from the top portion of js/app.js).
// Pure logic + mutable module-level state; call notify() after any mutation so
// subscribed components re-render (see store.js).
import { DATA, CREW, CREW_CAPACITY, WARD_CREW, saveWardCrew } from './data.js';
import './live.js'; // side effect: trims seed pins + injects live detector output into DATA.issues
import { notify } from './store.js';

export const TYPE = {
  pothole: { label: 'Pothole', c: '#d32f2f' },
  waterlogging: { label: 'Waterlogging', c: '#3b6fc4' },
  garbage_pile: { label: 'Garbage', c: '#c98a12' },
  street_obstruction: { label: 'Obstruction', c: '#e56a00' },
};
export const SEVW = { 1: 1, 2: 2, 3: 3.5, 4: 5.5, 5: 8 };
export const SEVC = { 1: '#8a9099', 2: '#3b6fc4', 3: '#c98a12', 4: '#e56a00', 5: '#d32f2f' };
export const OPEN = new Set(['confirmed', 'reported', 'candidate']);
export const NOW = new Date(DATA.generated); // fixed "now" for the demo
export const fmtDate = s => new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
export const fmtDT = s => new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const daysOpen = i => Math.floor((NOW - new Date(i.first_seen)) / 864e5);
export const resolutionDays = i => Math.floor((new Date(i.last_seen) - new Date(i.first_seen)) / 864e5);

export const issues = DATA.issues; // mutable — resolve/verify/live-poll write here
export const wardsFC = DATA.wards;

function issueHash(id) { // stable pseudo-random per id (FNV-1a + finalizer)
  let h = 2166136261;
  for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
(function assignCrew() { // deterministic round-robin per category, respecting capacity
  const idx = {}, openLoad = {};
  const OPEN_ASSIGN_RATE = 0.2;
  issues.forEach(i => {
    if (i.type === 'waterlogging') return;
    if (WARD_CREW[i.ward] && crewById(WARD_CREW[i.ward])) { i.crew = WARD_CREW[i.ward]; return; }
    const isOpen = OPEN.has(i.status);
    if (isOpen && issueHash(i.id) >= OPEN_ASSIGN_RATE) return;
    const pool = CREW.filter(c => c.type === i.type); if (!pool.length) return;
    idx[i.type] = idx[i.type] || 0;
    let pick = null;
    for (let tries = 0; tries < pool.length; tries++) {
      const cand = pool[idx[i.type] % pool.length]; idx[i.type]++;
      if (!isOpen || (openLoad[cand.id] || 0) < CREW_CAPACITY) { pick = cand; break; }
    }
    if (!pick) return;
    i.crew = pick.id;
    if (isOpen) openLoad[pick.id] = (openLoad[pick.id] || 0) + 1;
  });
})();
export function crewById(id) { return CREW.find(c => c.id === id); }
export function crewOpenCount(id) { return issues.filter(i => i.crew === id && OPEN.has(i.status)).length; }
export function crewLoad() {
  return CREW.map(c => {
    const mine = issues.filter(i => i.crew === c.id);
    return { ...c, total: mine.length, open: mine.filter(i => OPEN.has(i.status)).length };
  });
}
export function assignWardToCrew(ward, crewId) {
  WARD_CREW[ward] = crewId;
  saveWardCrew(WARD_CREW);
  issues.forEach(i => { if (i.ward === ward && i.type !== 'waterlogging') i.crew = crewId; });
  Object.assign(SCORES, wardScores());
  notify();
}
export function unassignWardCrew(ward) {
  delete WARD_CREW[ward];
  saveWardCrew(WARD_CREW);
  notify();
}
export function removeCrew(id) {
  const idx = CREW.findIndex(c => c.id === id); if (idx < 0) return;
  const removed = CREW[idx];
  CREW.splice(idx, 1);
  const pool = CREW.filter(c => c.type === removed.type);
  const openLoad = {}; pool.forEach(c => openLoad[c.id] = crewOpenCount(c.id));
  let n = 0;
  issues.forEach(i => {
    if (i.crew !== id) return;
    const isOpen = OPEN.has(i.status);
    let pick = null;
    for (let tries = 0; tries < pool.length; tries++) {
      const cand = pool[n % pool.length]; n++;
      if (!isOpen || (openLoad[cand.id] || 0) < CREW_CAPACITY) { pick = cand; break; }
    }
    if (pick) { i.crew = pick.id; if (isOpen) openLoad[pick.id] = (openLoad[pick.id] || 0) + 1; }
    else i.crew = null;
  });
  notify();
}
export function addCrewMember(name, type) {
  const id = (function next() {
    const used = new Set(CREW.map(c => c.id)); let n = 1;
    while (used.has('CR-' + String(n).padStart(2, '0'))) n++;
    return 'CR-' + String(n).padStart(2, '0');
  })();
  CREW.push({ id, name, type });
  notify();
  return id;
}

/* ---------- scoring ---------- */
export function wardScores() {
  const by = {};
  wardsFC.features.forEach(f => by[f.properties.ward] = { ward: f.properties.ward, area: f.properties.area, open: 0, load: 0, resolved: 0, mttrSum: 0, mttrN: 0, total: 0 });
  issues.forEach(i => {
    const w = by[i.ward]; if (!w) return; w.total++;
    if (OPEN.has(i.status)) { w.open++; w.load += SEVW[i.severity]; }
    if (i.status === 'verified_fixed' || i.status === 'resolved') {
      w.resolved++;
      const d = (new Date(i.last_seen) - new Date(i.first_seen)) / 36e5; if (d > 0) { w.mttrSum += d; w.mttrN++; }
    }
  });
  Object.values(by).forEach(w => {
    const density = w.load / Math.max(6, w.total);
    const fixRate = w.total ? w.resolved / w.total : 0;
    w.score = Math.max(5, Math.min(100, Math.round(100 - density * 11 + fixRate * 8)));
    w.mttr = w.mttrN ? (w.mttrSum / w.mttrN) : 0;
    w.trend = (w.ward.charCodeAt(0) + w.open) % 2 ? +(Math.random() * 3 + 0.5).toFixed(1) : -(Math.random() * 3 + 0.5).toFixed(1);
  });
  return by;
}
export const SCORES = wardScores();
export function scoreColor(s) { return s >= 75 ? '#2e7d32' : s >= 55 ? '#c98a12' : s >= 40 ? '#e56a00' : '#d32f2f'; }
export function cityScore() {
  const v = Object.values(SCORES); let tot = 0, wt = 0;
  v.forEach(w => { tot += w.score * Math.max(1, w.total); wt += Math.max(1, w.total); });
  return Math.round(tot / wt);
}
export function priority(i) { return SEVW[i.severity] * Math.log2(1 + i.passes); }

export function contractorName(i) { return i.crew ? crewById(i.crew).name : 'Unassigned'; }

/* ---------- issue mutations (drawer actions) ---------- */
export function setIssueStatus(i, status) {
  i.status = status;
  if (status === 'verified_fixed' || status === 'resolved') i.last_seen = new Date().toISOString();
  Object.assign(SCORES, wardScores());
  notify();
}
export function setIssueCrew(i, crewId) {
  i.crew = crewId;
  Object.assign(SCORES, wardScores());
  notify();
}
