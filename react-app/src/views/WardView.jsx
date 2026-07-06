import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Header from '../components/Header.jsx';
import KpiStrip from '../components/KpiStrip.jsx';
import QItem from '../components/QItem.jsx';
import LeafletMap from '../components/LeafletMap.jsx';
import { OPEN, SEVW, SCORES, issues, priority, crewById, unassignWardCrew, wardsFC } from '../lib/model.js';
import { DATA, WARD_CREW } from '../lib/data.js';
import { tileLayer, drawWards, plot } from '../lib/maps.js';
import { useSession } from '../context/SessionContext.jsx';
import { useUI } from '../context/UIContext.jsx';
import { useStore } from '../lib/useStore.js';

function StreetRow({ s, onOpen }) {
  return (
    <tr className="clk" onClick={onOpen}>
      <td><b>{s.name}</b></td><td>{s.open}</td>
      <td><span className="scorepill" style={{ background: s.load > 18 ? '#d32f2f' : s.load > 10 ? '#e56a00' : '#c98a12' }}>{s.load.toFixed(0)}</span></td>
    </tr>
  );
}

export default function WardView() {
  useStore();
  const { wardId } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  const { openIssue, openModal } = useUI();
  const [streetsExpanded, setStreetsExpanded] = useState(false);
  const [assignFilter, setAssignFilter] = useState('all');

  const w = SCORES[wardId];
  if (!w) {
    return (
      <>
        <Header crumb={[{ t: 'Mumbai', to: '/' }, { t: 'Wards', to: '/wards' }, { t: 'Not found' }]} title="Ward not found" sub="" />
        <div className="content"><div className="card cb"><div className="hint">No ward "{wardId}" — pick one from the Wards list.</div></div></div>
      </>
    );
  }
  const list = issues.filter(i => i.ward === wardId);
  const open = list.filter(i => OPEN.has(i.status)).sort((a, b) => priority(b) - priority(a));
  const showAssignFilter = session?.role !== 'crew';
  const assignable = open.filter(i => i.type !== 'waterlogging');
  const assignedN = assignable.filter(i => i.crew).length, unassignedN = assignable.length - assignedN;
  const filter = showAssignFilter ? assignFilter : 'all';
  const filtered = filter === 'assigned' ? assignable.filter(i => i.crew)
    : filter === 'unassigned' ? assignable.filter(i => !i.crew)
    : open;
  const contractorId = WARD_CREW[w.ward], contractor = contractorId && crewById(contractorId);
  const canManage = session && (session.role === 'admin' || session.role === 'ward_officer');
  const streets = DATA.streets.filter(s => s.wardId === wardId).map(s => {
    const li = issues.filter(i => i.streetId === s.id);
    const sOpen = li.filter(i => OPEN.has(i.status));
    return { ...s, total: li.length, open: sOpen.length, load: sOpen.reduce((a, i) => a + SEVW[i.severity], 0) };
  }).sort((a, b) => b.load - a.load);

  const crumb = session?.role === 'ward_officer'
    ? [{ t: 'Ward ' + w.ward }]
    : [{ t: 'Mumbai', to: '/' }, { t: 'Wards', to: '/wards' }, { t: 'Ward ' + w.ward }];

  return (
    <>
      <Header crumb={crumb} title={`Ward ${w.ward} <span style="font-weight:600;color:var(--muted);font-size:15px">· ${w.area}</span>`}
        sub="Ward officer view — resolution queue for open issues, highest priority first." />
      <div className="content">
        <KpiStrip list={list} />

        <div className="card">
          <div className="ch"><h3>Ward contractor</h3><span className="r">one crew responsible for every repairable issue in Ward {w.ward}</span></div>
          <div className="cb" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', flexWrap: 'wrap' }}>
            {contractor
              ? <span className="badge assigned">{contractor.name} · {contractor.id}</span>
              : <span className="badge unassigned">No ward contractor</span>}
            {canManage && (
              <>
                <button className="btn primary sm" onClick={() => openModal('assignWardCrew', { ward: w.ward })}>{contractor ? 'Change contractor' : 'Assign contractor'}</button>
                {contractor && (
                  <button className="btn sm danger" onClick={() => {
                    if (confirm(`Remove ${contractor.name} as contractor for Ward ${w.ward}? Existing assignments stay as-is; new issues fall back to per-type assignment.`)) {
                      unassignWardCrew(w.ward);
                    }
                  }}>Remove</button>
                )}
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="ch"><h3>Streets & corridors in Ward {w.ward}</h3><span className="r">click a corridor for its full issue list</span></div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Corridor</th><th>Open</th><th>Load</th></tr></thead>
              <tbody>{streets.slice(0, 3).map(s => <StreetRow key={s.id} s={s} onOpen={() => navigate(`/streets/${s.id}?ward=${wardId}`)} />)}</tbody>
              {streetsExpanded && <tbody>{streets.slice(3).map(s => <StreetRow key={s.id} s={s} onOpen={() => navigate(`/streets/${s.id}?ward=${wardId}`)} />)}</tbody>}
            </table>
          </div>
          {streets.length > 3 && (
            <div style={{ padding: '10px 16px' }}>
              <button className="btn sm" onClick={() => setStreetsExpanded(e => !e)}>
                {streetsExpanded ? 'Show fewer corridors' : `View ${streets.length - 3} more corridors`}
              </button>
            </div>
          )}
        </div>

        <div className="row map-side">
          <div className="card">
            <div className="ch"><h3>Resolution queue</h3><span className="r">{filtered.length} of {open.length} open · severity × persistence</span></div>
            {showAssignFilter && (
              <div style={{ display: 'flex', gap: 6, padding: '10px 16px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
                <button className={`btn sm ${filter === 'all' ? 'primary' : ''}`} onClick={() => setAssignFilter('all')}>All ({open.length})</button>
                <button className={`btn sm ${filter === 'assigned' ? 'primary' : ''}`} onClick={() => setAssignFilter('assigned')}>Assigned ({assignedN})</button>
                <button className={`btn sm ${filter === 'unassigned' ? 'primary' : ''}`} onClick={() => setAssignFilter('unassigned')}>Unassigned ({unassignedN})</button>
              </div>
            )}
            <div style={{ maxHeight: 452, overflowY: 'auto' }} id="queue">
              {!filtered.length
                ? <div className="hint">{open.length ? 'No issues match this filter.' : 'No open issues in this ward. All clear.'}</div>
                : filtered.map(i => <QItem key={i.id} issue={i} />)}
            </div>
          </div>
          <div className="card">
            <div className="ch"><h3>Ward {w.ward}</h3><span className="r">health {w.score}</span></div>
            <LeafletMap
              mountKey={'ward-' + wardId}
              onMount={(L, m) => {
                tileLayer(L, m);
                const wl = drawWards(L, m, wardsFC, SCORES, { only: wardId });
                m.fitBounds(wl.getBounds(), { padding: [20, 20] });
                plot(L, m, list, id => openIssue(id));
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}
