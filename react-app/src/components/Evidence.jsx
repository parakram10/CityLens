import { useState } from 'react';
import { TYPE } from '../lib/model.js';

const EVIDENCE_PHOTOS = {
  pothole: [
    'https://res.cloudinary.com/dk1uns1nz/image/upload/v1783174326/AI_lu8g4o.png',
    'https://res.cloudinary.com/dk1uns1nz/image/upload/v1783174325/pothhole-detection-500x500_n3moul.webp',
  ],
  garbage_pile: [
    'https://res.cloudinary.com/dk1uns1nz/image/upload/v1783175036/images_3_garjvs.jpg',
    'https://res.cloudinary.com/dk1uns1nz/image/upload/v1783175036/images_2_btrf63.jpg',
  ],
};
function pickEvidencePhoto(type, id) { // deterministic per issue
  const photos = EVIDENCE_PHOTOS[type]; if (!photos) return null;
  let hash = 0; for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return photos[hash % photos.length];
}

// Real detector evidence (annotated frame / crop) when the pipeline provides it (issue.photo),
// falling back to the curated stock photo / schematic below when it's absent or fails to load.
export default function Evidence({ issue: i }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  if (i.photo && !photoFailed) {
    return (
      <>
        <img src={`/${i.photo}`} alt={`${TYPE[i.type].label} detection`} className="evimg" onError={() => setPhotoFailed(true)} />
        <span className="evtag">detected frame · {Math.round(i.confidence * 100)}% · {i.id}</span>
      </>
    );
  }
  const stock = pickEvidencePhoto(i.type, i.id);
  if (stock) {
    return (
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        <img src={stock} alt={`${TYPE[i.type].label} evidence`} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        <span style={{ position: 'absolute', left: 10, top: 10, background: TYPE[i.type].c, color: '#fff', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 3 }}>
          {TYPE[i.type].label} {Math.round(i.confidence * 100)}%
        </span>
        <span style={{ position: 'absolute', left: 10, bottom: 8, color: '#fff', fontSize: 9, textShadow: '0 1px 2px rgba(0,0,0,.8)' }}>
          dashcam frame · {i.id}
        </span>
      </div>
    );
  }
  const c = TYPE[i.type].c;
  return (
    <svg viewBox="0 0 320 200" width="100%" height="100%" style={{ display: 'block' }}>
      <rect width="320" height="200" fill="#2b2f36" />
      <polygon points="0,200 130,96 190,96 320,200" fill="#3a3f47" />
      <polygon points="150,96 156,96 176,200 120,200" fill="#4a4f57" />
      <rect x="140" y="60" width="40" height="36" fill="#31363d" />
      <line x1="153" y1="112" x2="150" y2="200" stroke="#c9ccd1" strokeWidth="2" strokeDasharray="10 12" opacity=".5" />
      <rect x={110 + i.severity * 4} y={150 - i.severity * 3} width={26 + i.severity * 10} height={16 + i.severity * 7} fill="none" stroke={c} strokeWidth="3" rx="3" />
      <rect x={108 + i.severity * 4} y={134 - i.severity * 3} width={64} height={15} fill={c} />
      <text x={112 + i.severity * 4} y={145 - i.severity * 3} fill="#fff" fontSize="10" fontWeight="700">{TYPE[i.type].label} {Math.round(i.confidence * 100)}%</text>
      <text x="10" y="188" fill="#8b9099" fontSize="9">frame evidence · schematic · {i.id}</text>
    </svg>
  );
}
