import { useMemo } from 'react';
import Header from '../components/Header.jsx';
import { OPEN, SCORES, scoreColor, issues, wardsFC, crewById } from '../lib/model.js';
import { WARD_CREW } from '../lib/data.js';
import { useStore } from '../lib/useStore.js';

export default function WardsView({ go }) {
  useStore();
  const board = useMemo(() => Object.values(SCORES).sort((a, b) => a.score - b.score), [SCORES]);

  return (
    <>
      <Header
        crumb={[{ t: 'Mumbai', go: () => go('city') }, { t: 'Wards' }]}
        title="Wards"
        sub={`${wardsFC.features.length} BMC administrative wards — pick your area of responsibility.`}
      />
      <div className="content">
        <div className="card">
          <div className="ch"><h3>All wards</h3><span className="r">click to open the ward officer view</span></div>
          <table>
            <thead><tr><th></th><th>Ward</th><th>Area</th><th>Health</th><th>Open</th><th>High sev</th><th>Fixed</th><th>Contractor</th></tr></thead>
            <tbody>
              {board.map((w, i) => {
                const wi = issues.filter(x => x.ward === w.ward);
                const hs = wi.filter(x => OPEN.has(x.status) && x.severity >= 4).length;
                const fx = wi.filter(x => x.status === 'verified_fixed').length;
                const contractor = WARD_CREW[w.ward] && crewById(WARD_CREW[w.ward]);
                return (
                  <tr className="clk" key={w.ward} onClick={() => go('ward', { ward: w.ward })}>
                    <td className="rank">{i + 1}</td>
                    <td><b>{w.ward}</b></td>
                    <td>{w.area}</td>
                    <td><span className="scorepill" style={{ background: scoreColor(w.score) }}>{w.score}</span></td>
                    <td>{w.open}</td>
                    <td style={{ color: 'var(--pothole)', fontWeight: 700 }}>{hs}</td>
                    <td style={{ color: 'var(--good)', fontWeight: 700 }}>{fx}</td>
                    <td>{contractor ? contractor.name : <span style={{ color: 'var(--faint)' }}>—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
