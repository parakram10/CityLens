import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { DATA } from '../lib/data.js';
import { OPEN, issues, fmtDate } from '../lib/model.js';
import { tripsForBus, liveRuns } from '../lib/fleet.js';
import { useStore } from '../lib/useStore.js';

export default function FleetList() {
  useStore();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(null);
  const perBus = DATA.buses.map(b => {
    const li = issues.filter(i => i.bus === b);
    return { b, total: li.length, open: li.filter(i => OPEN.has(i.status)).length, trips: tripsForBus(b) };
  }).sort((a, b) => b.total - a.total);

  return (
    <>
      <Header crumb={[{ t: 'Mumbai', to: '/' }, { t: 'Fleet' }]} title="Fleet & route replay"
        sub={liveRuns().length
          ? 'Live detections from the on-bus model — open a trip below to watch the synced replay.'
          : 'Per-bus contribution — expand a bus to see its logged trips.'} />
      <div className="content">
        <div className="card">
          <div className="ch"><h3>Fleet contribution</h3><span className="r">{DATA.buses.length} buses · click a bus to expand its trip log</span></div>
          <div className="tablewrap">
            <table>
              <thead><tr><th></th><th>Bus</th><th>Detections</th><th>Open</th><th>Trips</th></tr></thead>
              {perBus.map(x => (
                <tbody key={x.b}>
                  <tr className="clk" onClick={() => setExpanded(e => e === x.b ? null : x.b)}>
                    <td className="chev">{expanded === x.b ? '▾' : '▸'}</td><td><b>{x.b}</b></td><td>{x.total}</td><td>{x.open}</td><td>{x.trips.length}</td>
                  </tr>
                  {expanded === x.b && (
                    <tr>
                      <td colSpan={5} style={{ padding: '10px 0', background: '#f0f1f4' }}>
                        {x.trips.length ? (
                          <div className="tablewrap">
                            <table>
                              <thead><tr><th>Date</th><th>Ward</th><th>Detections</th><th>Stops</th></tr></thead>
                              <tbody>
                                {x.trips.map(t => (
                                  <tr className="clk" key={t.id} onClick={e => { e.stopPropagation(); navigate(`/fleet/${x.b}/${t.id}`); }}>
                                    <td><b>{fmtDate(t.date)}</b></td><td>{t.wards.join(', ')}</td><td>{t.detections}</td><td>{t.stops.length}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : <div className="hint" style={{ padding: '12px 16px' }}>No logged trips for this bus.</div>}
                      </td>
                    </tr>
                  )}
                </tbody>
              ))}
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
