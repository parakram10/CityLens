// CityLens — Leaflet map helpers (ported from js/app.js map helpers section).
import { TYPE, scoreColor } from './model.js';

export function newMap(L, div) {
  const m = L.map(div, { zoomControl: true, attributionControl: false }).setView([19.09, 72.87], 11);
  tileLayer(L, m);
  return m;
}
export function plainMap(L, div) {
  const m = L.map(div, { zoomControl: true, attributionControl: false });
  tileLayer(L, m);
  return m;
}
export function tileLayer(L, m) {
  return L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd' }).addTo(m);
}
export function markerAt(L, i, pos, onClick) {
  const r = 3 + i.severity * 1.4;
  return L.circleMarker(pos, {
    radius: r, fillColor: TYPE[i.type].c, color: '#fff', weight: 1.4,
    fillOpacity: i.status === 'candidate' ? 0.4 : 0.9, dashArray: i.status === 'candidate' ? '2' : null,
  }).on('click', () => onClick && onClick(i.id));
}
export function markerFor(L, i, onClick) { return markerAt(L, i, [i.lat, i.lon], onClick); }
export function plot(L, m, list, onClick) { list.forEach(i => markerFor(L, i, onClick).addTo(m)); }
export function drawWards(L, m, wardsFC, SCORES, { fillByScore = false, only = null, onclick = null } = {}) {
  return L.geoJSON(wardsFC, {
    filter: f => !only || f.properties.ward === only,
    style: f => {
      const s = SCORES[f.properties.ward];
      return { color: '#8a9099', weight: 1, fillColor: fillByScore ? scoreColor(s.score) : '#8aa0c0', fillOpacity: fillByScore ? 0.5 : 0.06 };
    },
    onEachFeature: (f, l) => {
      l.bindTooltip(f.properties.ward + ' · ' + f.properties.area + (fillByScore ? ' · ' + SCORES[f.properties.ward].score : ''), { sticky: true });
      if (onclick) l.on('click', () => onclick(f.properties.ward));
    },
  }).addTo(m);
}
