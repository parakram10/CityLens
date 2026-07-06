import { TYPE, SEVC, fmtDT, daysOpen, resolutionDays, crewById, contractorName, issues, setIssueStatus, setIssueCrew } from '../lib/model.js';
import { tripBusesFor } from '../lib/fleet.js';
import { useSession } from '../context/SessionContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { useStore } from '../lib/useStore.js';
import Evidence from './Evidence.jsx';

function CrewPerformanceNote({ i }) {
  if (i.type === 'waterlogging') return null;
  if (i.status === 'resolved' || i.status === 'verified_fixed') {
    const days = resolutionDays(i);
    if (days <= 3) {
      return (
        <div className="hint" style={{ background: 'var(--good-bg)', color: 'var(--good)', borderRadius: 10, padding: '10px 14px', margin: '14px 0', fontWeight: 700 }}>
          🎉 Fixed in {days <= 0 ? 'under a day' : days + 'd'} by {contractorName(i)} — fast turnaround, nice work.
        </div>
      );
    }
    return null;
  }
  if ((i.status === 'confirmed' || i.status === 'reported' || i.status === 'candidate') && daysOpen(i) > 7) {
    return (
      <div className="hint" style={{ background: 'var(--bad-bg)', color: 'var(--pothole)', borderRadius: 10, padding: '10px 14px', margin: '14px 0', fontWeight: 700 }}>
        ⏳ Open {daysOpen(i)} days, unresolved — logged as a miss for {contractorName(i)}.
      </div>
    );
  }
  return null;
}

function DrawerActions({ i, opts }) {
  const { session } = useSession();
  const { closeDrawer, openModal } = useUI();
  if (i.type === 'waterlogging') {
    return <div className="hint" style={{ padding: 4 }}>Waterlogging clears with weather, not a repair crew — no assignment needed. Recurring flooding at this spot is flagged for drainage/disaster-management review.</div>;
  }
  const canEdit = session && (session.role === 'admin' || session.role === 'ward_officer');
  if (!canEdit) return <div className="hint" style={{ padding: 4 }}>Read-only access — sign in as an admin or ward officer to update this issue.</div>;
  if (i.status === 'verified_fixed') return <div style={{ color: 'var(--good)', fontWeight: 700, padding: 4 }}>✓ Verified fixed — cleared on a later pass with no re-detection.</div>;
  if (i.status === 'resolved') {
    return (
      <>
        <button className="btn good" onClick={() => setIssueStatus(i, 'verified_fixed')}>Confirm fixed</button>
        <button className="btn" onClick={() => setIssueStatus(i, 'confirmed')}>Reopen</button>
      </>
    );
  }
  return (
    <>
      <button className="btn primary" onClick={() => setIssueStatus(i, 'resolved')}>Mark resolved</button>
      {opts.hideAssign
        ? (i.crew && (
          <button className="btn danger" onClick={() => {
            const cid = i.crew;
            setIssueCrew(i, null);
            closeDrawer();
            openModal('crew', { crewId: cid });
          }}>Unassign</button>
        ))
        : (
          <button className={`btn ${i.crew ? 'good' : ''}`} onClick={() => openModal('assignCrew', { issueId: i.id })}>
            {i.crew ? 'Assigned ✓' : 'Assign crew'}
          </button>
        )}
    </>
  );
}

export default function IssueDrawer() {
  useStore();
  const { drawer, closeDrawer } = useUI();
  const isOpen = !!drawer;
  const i = drawer ? issues.find(x => x.id === drawer.issueId) : null;

  if (!i) {
    return (
      <>
        <div className={`scrim ${isOpen ? 'on' : ''}`} onClick={closeDrawer} />
        <div className="drawer" />
      </>
    );
  }
  const hist = (i.history && i.history.length) ? i.history : [{ t: i.first_seen, bus: i.bus, detected: true }, { t: i.last_seen, bus: i.bus, detected: i.status !== 'verified_fixed' }];
  const buses = tripBusesFor(i);
  return (
    <>
      <div className={`scrim ${isOpen ? 'on' : ''}`} onClick={closeDrawer} />
      <div className={`drawer ${isOpen ? 'on' : ''}`}>
        <div className="dh">
          <span className="tdot" style={{ background: TYPE[i.type].c, width: 14, height: 14 }} />
          <div>
            <b style={{ fontSize: 15 }}>{TYPE[i.type].label}</b>
            <div style={{ fontSize: 12, color: 'var(--faint)' }}>{i.id} · Ward {i.ward}</div>
          </div>
          <button className="x" onClick={closeDrawer}>×</button>
        </div>
        <div className="db">
          <div className="evidence"><Evidence issue={i} /></div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <span className="sev" style={{ background: SEVC[i.severity], padding: '4px 9px' }}>SEVERITY {i.severity}</span>
            <span className={`badge ${i.status}`} style={{ padding: '4px 11px' }}>{i.status.replace('_', ' ')}</span>
            <span className="badge" style={{ background: '#f0f1f4', color: 'var(--muted)', padding: '4px 11px' }}>{Math.round(i.confidence * 100)}% confidence</span>
          </div>
          <dl className="dl">
            <dt>Location</dt><dd>{i.street}, Ward {i.ward}</dd>
            <dt>GPS</dt><dd>{i.lat.toFixed(5)}, {i.lon.toFixed(5)}</dd>
            <dt>Route / {buses.length > 1 ? 'buses' : 'bus'}</dt><dd>{i.route} · {buses.length > 1 ? buses.join(', ') : i.bus}</dd>
            <dt>First seen</dt><dd>{fmtDT(i.first_seen)}</dd>
            <dt>Independent passes</dt>
            <dd>{i.passes}{buses.length > 1 ? ` · ${buses.length} trips (${buses.map(b => b.replace(/^.*-/, '')).join(', ')})` : ''} {i.passes >= 3 ? '✓ confirmed' : (i.passes === 2 ? '· reported' : '· awaiting gate')}</dd>
            {i.type !== 'waterlogging' && (<><dt>Assigned crew</dt><dd>{i.crew ? crewById(i.crew).name + ' · ' + i.crew : 'Unassigned · backlog'}</dd></>)}
          </dl>
          <CrewPerformanceNote i={i} />
          <div className="section-t" style={{ marginTop: 4 }}>Pass history</div>
          <ul className="tl">
            {hist.map((h, idx) => (
              <li key={idx} className={h.detected ? '' : 'miss'}>
                <b>{h.detected ? 'Detected' : 'Not detected'}</b>
                <span className="w"> · {fmtDT(h.t)} · {h.bus}</span>
              </li>
            ))}
          </ul>
          <div className="hint" style={{ padding: '8px 0' }}>Severity is an estimated triage score from detection size + confidence — calibrate against crew feedback.</div>
        </div>
        <div className="df">
          <DrawerActions i={i} opts={drawer.opts || {}} />
        </div>
      </div>
    </>
  );
}
