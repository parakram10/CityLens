import { OPEN, issues, daysOpen, crewById } from '../lib/model.js';
import { DATA, CREW } from '../lib/data.js';
import { useSession } from '../context/SessionContext.jsx';
import { useStore } from '../lib/useStore.js';

const CAT_LABELS = {
  pothole: { label: 'Potholes', varc: 'var(--pothole)' },
  garbage_pile: { label: 'Sanitation', varc: 'var(--garbage)' },
  waterlogging: { label: 'Waterlogging', varc: 'var(--water)' },
  street_obstruction: { label: 'Obstructions', varc: 'var(--obstruction)' },
};

export default function Sidebar({ state, go }) {
  useStore();
  const { session } = useSession();
  const open = issues.filter(i => OPEN.has(i.status));
  const cm = session?.role === 'crew' ? crewById(session.crewId) : null;
  const counts = {
    city: open.length,
    wards: DATA.wards.features.length,
    bus: DATA.buses.length,
    crew: CREW.length,
    performance: issues.filter(i => i.type !== 'waterlogging' && OPEN.has(i.status) && daysOpen(i) > 7).length,
    mywork: cm ? crewById(cm.id) && issues.filter(i => i.crew === cm.id && OPEN.has(i.status)).length : '',
  };
  const passes = issues.reduce((a, i) => a + i.passes, 0);

  const isActive = (v, t) => v === state.view && (v !== 'cat' || t === state.type);

  return (
    <aside className="sidebar">
      <div className="brand"><div className="mark" /><div><b>CityLens</b><span>Mumbai · BMC</span></div></div>

      <div className="navgroup" id="navgroup-spatial">
        <div className="lbl">Spatial view</div>
        <nav className="nav" id="nav-spatial">
          <a data-view="city" className={isActive('city') ? 'active' : ''} onClick={() => go('city')}><span className="ic">◉</span> City overview <span className="ct">{counts.city}</span></a>
          <a data-view="wards" className={isActive('wards') ? 'active' : ''} onClick={() => go('wards')}><span className="ic">▦</span> Wards <span className="ct">{counts.wards}</span></a>
          <a id="nav-myward" data-view="ward" className={isActive('ward') ? 'active' : ''} onClick={() => go('ward', { ward: session?.role === 'ward_officer' ? session.ward : state.ward })}><span className="ic">▦</span> My ward</a>
          <a data-view="street" className={isActive('street') ? 'active' : ''} onClick={() => go('street', { street: null, ward: null })}><span className="ic">↔</span> Streets &amp; corridors</a>
          <a data-view="fleet" className={isActive('fleet') ? 'active' : ''} onClick={() => go('fleet', { bus: null, trip: null })}><span className="ic">▤</span> Fleet &amp; replay <span className="ct">{counts.bus}</span></a>
        </nav>
      </div>

      <div className="navgroup" id="navgroup-cat">
        <div className="lbl">By category</div>
        <nav className="nav" id="nav-cat">
          {Object.entries(CAT_LABELS).map(([type, meta]) => (
            <a key={type} data-view="cat" data-type={type} className={isActive('cat', type) ? 'active' : ''} onClick={() => go('cat', { type })}>
              <span className="ic" style={{ color: meta.varc }}>●</span> {meta.label}{' '}
              <span className="ct">{open.filter(i => i.type === type).length}</span>
            </a>
          ))}
        </nav>
      </div>

      <div className="navgroup">
        <div className="lbl">Field crew</div>
        <nav className="nav" id="nav-crew">
          <a data-view="crew" className={isActive('crew') ? 'active' : ''} onClick={() => go('crew')}><span className="ic">▣</span> Crew info <span className="ct">{counts.crew}</span></a>
          <a data-view="performance" className={isActive('performance') ? 'active' : ''} onClick={() => go('performance')}><span className="ic">★</span> Performance <span className="ct">{counts.performance}</span></a>
          <a id="nav-mywork" data-view="mywork" className={isActive('mywork') ? 'active' : ''} onClick={() => go('mywork')}><span className="ic">👤</span> My work <span className="ct">{counts.mywork}</span></a>
        </nav>
      </div>

      <div className="sensing"><div><span className="dot" /><b>{DATA.buses.length} buses sensing</b></div><small>{passes.toLocaleString('en-IN')} passes logged this survey</small></div>
    </aside>
  );
}
