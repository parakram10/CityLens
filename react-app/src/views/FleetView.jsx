import { useState } from 'react';
import Header from '../components/Header.jsx';
import { DATA } from '../lib/data.js';
import { OPEN, issues, fmtDate } from '../lib/model.js';
import { tripsForBus, liveRuns } from '../lib/fleet.js';
import { useUI } from '../context/UIContext.jsx';
import { useStore } from '../lib/useStore.js';
import TripReplay from './TripReplay.jsx';

export default function FleetView({ state, setState, go }) {
  if (state.bus && state.trip) return <TripReplay state={state} go={go} />;
  return <FleetList go={go} />;
}

function FleetList({ go }) {
  useStore();
  const [expanded, setExpanded] = useState(null);
  const perBus = DATA.buses.map(b => {
    const li = issues.filter(i => i.bus === b);
    return { b, total: li.length, open: li.filter(i => OPEN.has(i.status)).length, trips: tripsForBus(b) };
  }).sort((a, b) => b.total - a.total);

  return (
    <>
      <Header crumb={[{ t: 'Mumbai', go: () => go('city') }, { t: 'Fleet' }]} title="Fleet & route replay"
        sub={liveRuns().length
          ? 'Live detections from the on-bus model — open a trip below to watch the synced replay.'
          : 'Per-bus contribution — expand a bus to see its logged trips.'} />
      <div className="content">
        <div className="card">
          <div className="ch"><h3>Fleet contribution</h3><span className="r">{DATA.buses.length} buses · click a bus to expand its trip log</span></div>
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
                        <table>
                          <thead><tr><th>Date</th><th>Ward</th><th>Detections</th><th>Stops</th></tr></thead>
                          <tbody>
                            {x.trips.map(t => (
                              <tr className="clk" key={t.id} onClick={e => { e.stopPropagation(); go('fleet', { bus: x.b, trip: t.id }); }}>
                                <td><b>{fmtDate(t.date)}</b></td><td>{t.wards.join(', ')}</td><td>{t.detections}</td><td>{t.stops.length}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : <div className="hint" style={{ padding: '12px 16px' }}>No logged trips for this bus.</div>}
                    </td>
                  </tr>
                )}
              </tbody>
            ))}
          </table>
        </div>
      </div>
    </>
  );
}
