import { cityScore, scoreColor } from '../lib/model.js';
import { useSession } from '../context/SessionContext.jsx';
import { useStore } from '../lib/useStore.js';

export default function Header({ crumb, title, sub }) {
  useStore();
  const { session, logout } = useSession();
  const cs = cityScore();
  return (
    <div className="header">
      <div>
        <div className="crumb">
          {crumb.map((p, idx) => (
            <span key={idx} style={{ display: 'contents' }}>
              {idx > 0 && <span className="sep">/</span>}
              {p.go ? <a onClick={p.go}>{p.t}</a> : <span>{p.t}</span>}
            </span>
          ))}
        </div>
        <div className="h-title" dangerouslySetInnerHTML={{ __html: title }} />
        <div className="h-sub">{sub}</div>
      </div>
      <div className="live"><span className="dot" /> LIVE</div>
      <div className="scorechip">City health <span className="v" style={{ background: scoreColor(cs) }}>{cs}</span></div>
      {session && (
        <div className="userchip">
          <span className={`rolebadge role-${session.role}`}>{session.role.replace('_', ' ')}</span>
          <b>{session.username}</b>
          <button className="btn sm" onClick={logout}>Log out</button>
        </div>
      )}
    </div>
  );
}
