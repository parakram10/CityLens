import Header from '../components/Header.jsx';
import { TYPE, crewLoad, removeCrew } from '../lib/model.js';
import { CREW, CREW_CAPACITY } from '../lib/data.js';
import { useSession } from '../context/SessionContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { useStore } from '../lib/useStore.js';

export default function CrewView() {
  useStore();
  const { session } = useSession();
  const { openModal } = useUI();
  const rows = crewLoad().sort((a, b) => b.open - a.open);
  const canManage = session && (session.role === 'admin' || session.role === 'ward_officer');

  return (
    <>
      <Header crumb={[{ t: 'Mumbai', to: '/' }, { t: 'Crew info' }]} title="Crew info"
        sub="Field repair & cleanup teams — one specialism each, worklist drawn from the same confirmed-issue set." />
      <div className="content">
        <div className="card">
          <div className="ch">
            <h3>Crew roster</h3><span className="r">{CREW.length} members · click a member to see their worklist</span>
            {canManage && <button className="btn primary sm" onClick={() => openModal('addCrew')}>+ Add crew member</button>}
          </div>
          <div className="tablewrap">
            <table>
              <thead><tr><th></th><th>Crew ID</th><th>Name</th><th>Specialism</th><th>Ward</th><th>Assigned</th><th>Completed</th><th></th></tr></thead>
              <tbody>
                {rows.map((cm, i) => (
                  <tr className="clk" key={cm.id} onClick={() => openModal('crew', { crewId: cm.id })}>
                    <td className="rank">{i + 1}</td>
                    <td><b>{cm.id}</b></td><td>{cm.name}</td>
                    <td><span className="tdot" style={{ background: TYPE[cm.type].c, display: 'inline-block', marginRight: 6, verticalAlign: 'middle' }} />{TYPE[cm.type].label}</td>
                    <td>{cm.ward ? 'Ward ' + cm.ward : '—'}</td>
                    <td>
                      <span className="scorepill" style={{ background: cm.open >= CREW_CAPACITY ? '#d32f2f' : cm.open ? '#e56a00' : '#2e7d32' }}>{cm.open}/{CREW_CAPACITY}</span>
                      {cm.open >= CREW_CAPACITY && <span className="badge confirmed" style={{ marginLeft: 6 }}>full</span>}
                    </td>
                    <td>{cm.total - cm.open}</td>
                    <td>
                      {canManage && (
                        <button className="btn sm danger" onClick={e => {
                          e.stopPropagation();
                          if (confirm(`Remove ${cm.name} (${cm.id})? Their open tasks will be reassigned to another ${TYPE[cm.type].label.toLowerCase()} specialist.`)) {
                            removeCrew(cm.id);
                          }
                        }}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
