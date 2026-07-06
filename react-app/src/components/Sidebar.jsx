import { NavLink, useLocation } from 'react-router-dom';
import { OPEN, issues, daysOpen, crewById, SCORES } from '../lib/model.js';
import { DATA, CREW } from '../lib/data.js';
import { wardPath } from '../lib/routes.js';
import { useSession } from '../context/SessionContext.jsx';
import { useLayout } from '../context/LayoutContext.jsx';
import { useStore } from '../lib/useStore.js';

const CAT_LABELS = {
  pothole: { label: 'Potholes', varc: 'var(--pothole)' },
  garbage_pile: { label: 'Sanitation', varc: 'var(--garbage)' },
  waterlogging: { label: 'Waterlogging', varc: 'var(--water)' },
  street_obstruction: { label: 'Obstructions', varc: 'var(--obstruction)' },
};

const navClass = ({ isActive }) => (isActive ? 'active' : '');

export default function Sidebar() {
  useStore();
  const { session } = useSession();
  const { sidebarOpen } = useLayout();
  const location = useLocation();
  const open = issues.filter(i => OPEN.has(i.status));
  const cm = session?.role === 'crew' ? crewById(session.crewId) : null;
  const counts = {
    city: open.length,
    wards: DATA.wards.features.length,
    bus: DATA.buses.length,
    crew: CREW.length,
    performance: issues.filter(i => i.type !== 'waterlogging' && OPEN.has(i.status) && daysOpen(i) > 7).length,
    mywork: cm ? issues.filter(i => i.crew === cm.id && OPEN.has(i.status)).length : '',
  };
  const passes = issues.reduce((a, i) => a + i.passes, 0);
  const myWard = session?.role === 'ward_officer' ? session.ward : Object.keys(SCORES)[0];
  const isWardActive = location.pathname.startsWith('/ward/');

  return (
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="brand"><div className="mark" /><div><b>CityLens</b><span>Mumbai · BMC</span></div></div>

      <div className="navgroup" id="navgroup-spatial">
        <div className="lbl">Spatial view</div>
        <nav className="nav" id="nav-spatial">
          <NavLink to="/" end data-view="city" className={navClass}><span className="ic">◉</span> City overview <span className="ct">{counts.city}</span></NavLink>
          <NavLink to="/wards" data-view="wards" className={navClass}><span className="ic">▦</span> Wards <span className="ct">{counts.wards}</span></NavLink>
          <NavLink id="nav-myward" to={myWard ? wardPath(myWard) : '/wards'} data-view="ward" className={() => isWardActive ? 'active' : ''}><span className="ic">▦</span> My ward</NavLink>
          <NavLink to="/streets" data-view="street" className={navClass}><span className="ic">↔</span> Streets &amp; corridors</NavLink>
          <NavLink to="/fleet" data-view="fleet" className={navClass}><span className="ic">▤</span> Fleet &amp; replay <span className="ct">{counts.bus}</span></NavLink>
        </nav>
      </div>

      <div className="navgroup" id="navgroup-cat">
        <div className="lbl">By category</div>
        <nav className="nav" id="nav-cat">
          {Object.entries(CAT_LABELS).map(([type, meta]) => (
            <NavLink key={type} to={`/category/${type}`} data-view="cat" data-type={type} className={navClass}>
              <span className="ic" style={{ color: meta.varc }}>●</span> {meta.label}{' '}
              <span className="ct">{open.filter(i => i.type === type).length}</span>
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="navgroup">
        <div className="lbl">Field crew</div>
        <nav className="nav" id="nav-crew">
          <NavLink to="/crew" data-view="crew" className={navClass}><span className="ic">▣</span> Crew info <span className="ct">{counts.crew}</span></NavLink>
          <NavLink to="/performance" data-view="performance" className={navClass}><span className="ic">★</span> Performance <span className="ct">{counts.performance}</span></NavLink>
          <NavLink id="nav-mywork" to="/my-work" data-view="mywork" className={navClass}><span className="ic">👤</span> My work <span className="ct">{counts.mywork}</span></NavLink>
        </nav>
      </div>

      <div className="sensing"><div><span className="dot" /><b>{DATA.buses.length} buses sensing</b></div><small>{passes.toLocaleString('en-IN')} passes logged this survey</small></div>
    </aside>
  );
}
