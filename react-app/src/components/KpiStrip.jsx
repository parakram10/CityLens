import { OPEN } from '../lib/model.js';

export default function KpiStrip({ list }) {
  const open = list.filter(i => OPEN.has(i.status));
  const conf = list.filter(i => i.status === 'confirmed').length;
  const sev45 = open.filter(i => i.severity >= 4).length;
  const fixed = list.filter(i => i.status === 'verified_fixed').length;
  const mttrN = list.filter(i => i.status === 'verified_fixed' || i.status === 'resolved');
  let mt = 0, mn = 0;
  mttrN.forEach(i => { const d = (new Date(i.last_seen) - new Date(i.first_seen)) / 864e5; if (d > 0) { mt += d; mn++; } });
  const mttr = mn ? (mt / mn).toFixed(1) : '—';
  return (
    <div className="kpis">
      <div className="kpi"><div className="k">Open issues</div><div className="v">{open.length}</div><div className="d">{conf} confirmed · {open.length - conf} pending gate</div></div>
      <div className="kpi"><div className="k">High severity (4–5)</div><div className="v" style={{ color: 'var(--pothole)' }}>{sev45}</div><div className="d down">needs priority action</div></div>
      <div className="kpi"><div className="k">Verified fixed</div><div className="v" style={{ color: 'var(--good)' }}>{fixed}</div><div className="d up">re-checked on later passes</div></div>
      <div className="kpi"><div className="k">Avg. resolution</div><div className="v">{mttr}<span style={{ fontSize: 15, color: 'var(--faint)' }}> d</span></div><div className="d">first-seen → cleared</div></div>
    </div>
  );
}
