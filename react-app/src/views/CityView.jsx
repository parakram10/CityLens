import { useNavigate } from 'react-router-dom';
import Header from '../components/Header.jsx';
import KpiStrip from '../components/KpiStrip.jsx';
import LeafletMap from '../components/LeafletMap.jsx';
import { TYPE, OPEN, SCORES, scoreColor, issues, wardsFC } from '../lib/model.js';
import { tileLayer, drawWards, plot } from '../lib/maps.js';
import { wardPath } from '../lib/routes.js';
import { useUI } from '../context/UIContext.jsx';
import { useStore } from '../lib/useStore.js';

export default function CityView() {
  useStore();
  const navigate = useNavigate();
  const { openIssue } = useUI();
  const open = issues.filter(i => OPEN.has(i.status));
  const board = Object.values(SCORES).sort((a, b) => a.score - b.score);

  return (
    <>
      <Header crumb={[{ t: 'Mumbai' }]} title="Mumbai — street-condition survey" sub="Every BMC ward, sensed by the bus fleet. Click a ward to drill in." />
      <div className="content">
        <KpiStrip list={issues} />
        <div className="row map-side">
          <div className="card">
            <div className="ch"><h3>Live detection map</h3><span className="r">{open.length} open · wards shaded by health score</span></div>
            <LeafletMap
              mountKey="city"
              onMount={(L, m) => {
                m.setView([19.09, 72.87], 11);
                tileLayer(L, m);
                drawWards(L, m, wardsFC, SCORES, { fillByScore: true, onclick: w => navigate(wardPath(w)) });
                plot(L, m, open, id => openIssue(id));
              }}
            />
            <div className="legend">
              {Object.entries(TYPE).map(([k, v]) => (
                <span className="it" key={k}><span className="sw" style={{ background: v.c }} />{v.label}</span>
              ))}
              <span className="it" style={{ marginLeft: 'auto' }}><span className="sw" style={{ background: '#2e7d32' }} />healthy ward</span>
              <span className="it"><span className="sw" style={{ background: '#d32f2f' }} />at-risk ward</span>
            </div>
          </div>
          <div className="card">
            <div className="ch"><h3>Ward health leaderboard</h3><span className="r">worst first</span></div>
            <div style={{ maxHeight: 512, overflowY: 'auto' }}>
              <div className="tablewrap">
                <table>
                  <thead><tr><th></th><th>Ward</th><th>Score</th><th>Open</th><th>7-day</th></tr></thead>
                  <tbody>
                    {board.map((w, i) => (
                      <tr className="clk" key={w.ward} onClick={() => navigate(wardPath(w.ward))}>
                        <td className="rank">{i + 1}</td>
                        <td><b>{w.ward}</b><div style={{ fontSize: 11, color: 'var(--faint)' }}>{w.area}</div></td>
                        <td><span className="scorepill" style={{ background: scoreColor(w.score) }}>{w.score}</span></td>
                        <td>{w.open}</td>
                        <td className={`trend ${w.trend >= 0 ? 'up' : 'down'}`}>{w.trend >= 0 ? '▲' : '▼'} {Math.abs(w.trend)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
