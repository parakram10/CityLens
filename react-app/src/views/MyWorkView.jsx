import Header from '../components/Header.jsx';
import QItem from '../components/QItem.jsx';
import { TYPE, OPEN, issues, priority, crewById } from '../lib/model.js';
import { CREW_CAPACITY } from '../lib/data.js';
import { useSession } from '../context/SessionContext.jsx';
import { useStore } from '../lib/useStore.js';

export default function MyWorkView() {
  useStore();
  const { session } = useSession();
  const cm = session && crewById(session.crewId);

  if (!cm) {
    return (
      <>
        <Header crumb={[{ t: 'My work' }]} title="My work" sub="Your account isn't linked to a crew record." />
        <div className="content"><div className="card cb"><div className="hint" style={{ padding: 4 }}>No matching crew record — ask an admin to check your account.</div></div></div>
      </>
    );
  }
  const mine = issues.filter(i => i.crew === cm.id);
  const open = mine.filter(i => OPEN.has(i.status)).sort((a, b) => priority(b) - priority(a));
  const done = mine.filter(i => !OPEN.has(i.status));

  return (
    <>
      <Header crumb={[{ t: 'My work' }]} title="My work"
        sub={`${cm.name} · ${TYPE[cm.type].label} specialist${cm.ward ? ' · Ward ' + cm.ward : ''} · your resolution queue and history.`} />
      <div className="content">
        <div className="card">
          <div className="ch"><h3>{cm.name}</h3><span className="r">{cm.id} · {TYPE[cm.type].label} specialist{cm.ward ? ' · Ward ' + cm.ward : ''}</span></div>
          <div className="section-t" style={{ margin: '14px 16px 6px' }}>
            Assigned to you — {open.length}/{CREW_CAPACITY} open
            {open.length >= CREW_CAPACITY && <span className="badge confirmed" style={{ textTransform: 'none', letterSpacing: 0 }}> worklist full</span>}
          </div>
          <div>{!open.length ? <div className="hint">No issue assigned.</div> : open.map(i => <QItem key={i.id} issue={i} opts={{ hideAssign: true }} />)}</div>
          {!!done.length && (
            <>
              <div className="section-t" style={{ margin: '18px 16px 6px' }}>Completed — {done.length}</div>
              <div>{done.map(i => <QItem key={i.id} issue={i} opts={{ hideAssign: true }} />)}</div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
