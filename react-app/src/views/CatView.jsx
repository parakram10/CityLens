import { useParams } from 'react-router-dom';
import Header from '../components/Header.jsx';
import KpiStrip from '../components/KpiStrip.jsx';
import QItem from '../components/QItem.jsx';
import LeafletMap from '../components/LeafletMap.jsx';
import { TYPE, OPEN, issues, priority, SCORES, wardsFC } from '../lib/model.js';
import { tileLayer, drawWards, plot } from '../lib/maps.js';
import { useUI } from '../context/UIContext.jsx';
import { useStore } from '../lib/useStore.js';

export default function CatView() {
  useStore();
  const { type: t } = useParams();
  const { openIssue } = useUI();
  const meta = TYPE[t];

  if (!meta) {
    return (
      <>
        <Header crumb={[{ t: 'Mumbai', to: '/' }, { t: 'Not found' }]} title="Unknown category" sub="" />
        <div className="content"><div className="card cb"><div className="hint">No such category.</div></div></div>
      </>
    );
  }

  const list = issues.filter(i => i.type === t);
  const open = list.filter(i => OPEN.has(i.status)).sort((a, b) => priority(b) - priority(a));

  return (
    <>
      <Header
        crumb={[{ t: 'Mumbai', to: '/' }, { t: meta.label }]}
        title={`${meta.label} — city-wide`}
        sub="One category across every ward, ranked for the responsible department."
      />
      <div className="content">
        <KpiStrip list={list} />
        <div className="row map-side">
          <div className="card">
            <div className="ch"><h3>{meta.label} map</h3><span className="r">{open.length} open</span></div>
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
