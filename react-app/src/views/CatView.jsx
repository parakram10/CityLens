import Header from '../components/Header.jsx';
import KpiStrip from '../components/KpiStrip.jsx';
import QItem from '../components/QItem.jsx';
import LeafletMap from '../components/LeafletMap.jsx';
import { TYPE, OPEN, issues, priority } from '../lib/model.js';
import { tileLayer, drawWards, plot } from '../lib/maps.js';
import { SCORES, wardsFC } from '../lib/model.js';
import { useUI } from '../context/UIContext.jsx';
import { useStore } from '../lib/useStore.js';

export default function CatView({ state, go }) {
  useStore();
  const { openIssue } = useUI();
  const t = state.type;
  const list = issues.filter(i => i.type === t);
  const open = list.filter(i => OPEN.has(i.status)).sort((a, b) => priority(b) - priority(a));

  return (
    <>
      <Header
        crumb={[{ t: 'Mumbai', go: () => go('city') }, { t: TYPE[t].label }]}
        title={`${TYPE[t].label} — city-wide`}
        sub="One category across every ward, ranked for the responsible department."
      />
      <div className="content">
        <KpiStrip list={list} />
        <div className="row map-side">
          <div className="card">
            <div className="ch"><h3>{TYPE[t].label} map</h3><span className="r">{open.length} open</span></div>
            <LeafletMap
              mountKey={'cat-' + t}
              onMount={(L, m) => {
                m.setView([19.09, 72.87], 11);
                tileLayer(L, m);
                drawWards(L, m, wardsFC, SCORES, { fillByScore: false });
                plot(L, m, open, id => openIssue(id));
              }}
            />
          </div>
          <div className="card">
            <div className="ch"><h3>Priority list</h3><span className="r">severity × persistence</span></div>
            <div style={{ maxHeight: 512, overflowY: 'auto' }}>
              {open.slice(0, 60).map(i => <QItem key={i.id} issue={i} />)}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
