import Header from '../components/Header.jsx';
import { TYPE, OPEN, issues, daysOpen, resolutionDays, contractorName } from '../lib/model.js';
import { useUI } from '../context/UIContext.jsx';
import { useStore } from '../lib/useStore.js';

export default function PerformanceView() {
  useStore();
  const { openIssue } = useUI();
  const repairable = issues.filter(i => i.type !== 'waterlogging');
  const praise = repairable.filter(i => (i.status === 'resolved' || i.status === 'verified_fixed') && resolutionDays(i) <= 3)
    .sort((a, b) => resolutionDays(a) - resolutionDays(b));
  const misses = repairable.filter(i => OPEN.has(i.status) && daysOpen(i) > 7)
    .sort((a, b) => daysOpen(b) - daysOpen(a));

  return (
    <>
      <Header crumb={[{ t: 'Mumbai', to: '/' }, { t: 'Performance' }]} title="Performance"
        sub="Fast fixes worth recognizing, and issues that have sat open too long — same confirmed-issue set, both sides of the story." />
      <div className="content">
        <div className="row cols-2">
          <div className="card">
            <div className="ch"><h3>🎉 Praise</h3><span className="r">{praise.length} fixed in ≤3 days</span></div>
            {praise.length ? (
              <>
                <div className="tablewrap"><table>
                  <thead><tr><th>Location</th><th>Ward</th><th>Fixed in</th><th>Contractor</th></tr></thead>
                  <tbody>
                    {praise.slice(0, 25).map(i => (
                      <tr className="clk" key={i.id} onClick={() => openIssue(i.id)}>
                        <td><span className="tdot" style={{ background: TYPE[i.type].c, marginRight: 6 }} />{i.street} · {i.id}</td>
                        <td>{i.ward}</td><td>{resolutionDays(i) <= 0 ? '<1d' : resolutionDays(i) + 'd'}</td>
                        <td><span className="badge assigned">{contractorName(i)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
                {praise.length > 25 && <div className="hint">+{praise.length - 25} more fast fixes</div>}
              </>
            ) : <div className="cb"><div className="hint" style={{ padding: 4 }}>No fast fixes yet on this run.</div></div>}
          </div>
          <div className="card">
            <div className="ch"><h3>⏳ Misses</h3><span className="r">{misses.length} open 7+ days</span></div>
            {misses.length ? (
              <>
                <div className="tablewrap"><table>
                  <thead><tr><th>Location</th><th>Ward</th><th>Days open</th><th>Contractor</th></tr></thead>
                  <tbody>
                    {misses.slice(0, 25).map(i => (
                      <tr className="clk" key={i.id} onClick={() => openIssue(i.id)}>
                        <td><span className="tdot" style={{ background: TYPE[i.type].c, marginRight: 6 }} />{i.street} · {i.id}</td>
                        <td>{i.ward}</td><td>{daysOpen(i)}d</td>
                        <td><span className="badge shame">{contractorName(i)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
                {misses.length > 25 && <div className="hint">+{misses.length - 25} more overdue</div>}
              </>
            ) : <div className="cb"><div className="hint" style={{ padding: 4 }}>Nothing has gone unresolved for more than a week — clean sweep.</div></div>}
          </div>
        </div>
      </div>
    </>
  );
}
