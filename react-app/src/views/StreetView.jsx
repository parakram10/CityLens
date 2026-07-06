import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Header from '../components/Header.jsx';
import QItem from '../components/QItem.jsx';
import LeafletMap from '../components/LeafletMap.jsx';
import { TYPE, OPEN, SEVW, issues, priority, fmtDate, wardsFC } from '../lib/model.js';
import { DATA } from '../lib/data.js';
import { tileLayer, plot } from '../lib/maps.js';
import { tripsForStreet } from '../lib/fleet.js';
import { wardPath } from '../lib/routes.js';
import { useUI } from '../context/UIContext.jsx';
import { useStore } from '../lib/useStore.js';

export default function StreetView() {
  useStore();
  const { streetId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { openIssue } = useUI();
  const scopedWard = searchParams.get('ward');

  const allStreets = scopedWard ? DATA.streets.filter(s => s.wardId === scopedWard) : DATA.streets;
  const streets = allStreets.map(s => {
    const li = issues.filter(i => i.streetId === s.id);
    const open = li.filter(i => OPEN.has(i.status));
    return { ...s, total: li.length, open: open.length, load: open.reduce((a, i) => a + SEVW[i.severity], 0) };
  }).sort((a, b) => b.load - a.load);
  const sel = streets.find(s => s.id === streetId) || streets[0];
  const list = sel ? issues.filter(i => i.streetId === sel.id) : [];
  const trips = sel ? tripsForStreet(sel.id) : [];

  const crumb = scopedWard
    ? [{ t: 'Mumbai', to: '/' }, { t: 'Ward ' + scopedWard, to: wardPath(scopedWard) }, { t: 'Streets' }]
    : [{ t: 'Mumbai', to: '/' }, { t: 'Streets' }];

  const gotoStreet = id => navigate(`/streets/${id}${scopedWard ? `?ward=${scopedWard}` : ''}`);

  if (!sel) {
    return (
      <>
        <Header crumb={crumb} title="Streets & corridors" sub="No corridors found." />
        <div className="content"><div className="card cb"><div className="hint">No corridors in scope.</div></div></div>
      </>
    );
  }

  return (
    <>
      <Header
        crumb={crumb}
        title="Streets & corridors"
        sub={scopedWard
          ? `${allStreets.length} corridors in Ward ${scopedWard} — issues aggregated along each road segment.`
          : `${allStreets.length} corridors across ${wardsFC.features.length} wards — issues aggregated along each road segment.`}
      />
      <div className="content">
        <div className="row map-side">
          <div className="card">
            <div className="ch"><h3>{sel.name} <span style={{ fontWeight: 600, color: 'var(--muted)', fontSize: 15 }}>· Ward {sel.wardId}</span></h3><span className="r">{list.length} detections along corridor</span></div>
            <LeafletMap
              mountKey={'street-' + sel.id}
              onMount={(L, m) => {
                tileLayer(L, m);
                plot(L, m, list, id => openIssue(id));
                if (list.length) {
                  const g = L.featureGroup(list.map(i => L.marker([i.lat, i.lon])));
                  m.fitBounds(g.getBounds().pad(0.3));
                } else {
                  m.setView([19.09, 72.87], 12);
                }
              }}
            />
            <div className="legend">{Object.entries(TYPE).map(([k, v]) => <span className="it" key={k}><span className="sw" style={{ background: v.c }} />{v.label}</span>)}</div>
          </div>
          <div className="card">
            <div className="ch"><h3>Corridors by open load</h3><span className="r">worst first</span></div>
            <div style={{ maxHeight: 512, overflowY: 'auto' }}>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Street</th><th>Ward</th><th>Open</th><th>Load</th></tr></thead>
                  <tbody>
                    {streets.map(x => (
                      <tr className={`clk ${x.id === sel.id ? 'sel' : ''}`} key={x.id} onClick={() => gotoStreet(x.id)}>
                        <td><b>{x.name}</b></td><td>{x.wardId}</td><td>{x.open}</td>
                        <td><span className="scorepill" style={{ background: x.load > 18 ? '#d32f2f' : x.load > 10 ? '#e56a00' : '#c98a12' }}>{x.load.toFixed(0)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="ch"><h3>All issues on {sel.name}</h3><span className="r">{list.length} total · every status</span></div>
          <div style={{ maxHeight: 452, overflowY: 'auto' }}>
            {!list.length
              ? <div className="hint">No issues detected on this corridor yet.</div>
              : list.slice().sort((a, b) => priority(b) - priority(a)).map(i => <QItem key={i.id} issue={i} />)}
          </div>
        </div>

        <div className="card">
          <div className="ch"><h3>Fleet coverage</h3><span className="r">buses that have surveyed this corridor — click a trip to replay it</span></div>
          {trips.length ? (
            <div className="tablewrap">
              <table>
                <thead><tr><th>Bus</th><th>Trip date</th><th>Detections here</th></tr></thead>
                <tbody>
                  {trips.map(t => (
                    <tr className="clk" key={t.id} onClick={() => navigate(`/fleet/${t.bus}/${t.id}`)}>
                      <td><b>{t.bus}</b></td><td>{fmtDate(t.date)}</td><td>{t.detections}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="hint" style={{ padding: '12px 16px' }}>No fleet passes logged on this corridor yet.</div>}
        </div>
      </div>
    </>
  );
}
