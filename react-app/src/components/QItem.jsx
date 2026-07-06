import { TYPE, SEVC, priority } from '../lib/model.js';
import { tripBusesFor, busShort } from '../lib/fleet.js';
import { useSession } from '../context/SessionContext.jsx';
import { useUI } from '../context/UIContext.jsx';

export default function QItem({ issue: i, opts = {} }) {
  const { session } = useSession();
  const { openIssue } = useUI();
  const buses = tripBusesFor(i);
  const busTxt = buses.length > 1 ? `${buses.length} trips: ${buses.map(busShort).join(', ')}` : (i.bus || buses[0] || '');
  return (
    <div className="qitem" onClick={() => openIssue(i.id, opts)}>
      <span className="tdot" style={{ background: TYPE[i.type].c }} />
      <div className="meta">
        <div className="t1">
          {TYPE[i.type].label}
          <span className="sev" style={{ background: SEVC[i.severity] }}>SEV {i.severity}</span>
          <span className={`badge ${i.status}`}>{i.status.replace('_', ' ')}</span>
          {i.type !== 'waterlogging' && session?.role !== 'crew' && (
            <span className={`badge ${i.crew ? 'assigned' : 'unassigned'}`}>{i.crew ? 'Assigned' : 'Unassigned'}</span>
          )}
        </div>
        <div className="t2">{i.street} · {i.id} · {i.passes} passes · {Math.round(i.confidence * 100)}% conf · {i.route} · {busTxt}</div>
      </div>
      <div className="pri">P {priority(i).toFixed(1)}</div>
    </div>
  );
}
