import { useEffect, useRef, useState } from 'react';
import { subscribeToast } from '../lib/liveToast.js';

export default function LiveToast() {
  const [msg, setMsg] = useState(null);
  const [show, setShow] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => subscribeToast(m => {
    setMsg(m); setShow(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setShow(false), 4200);
  }), []);

  if (!msg) return null;
  return (
    <div className={`livetoast ${show ? 'show' : ''}`} dangerouslySetInnerHTML={{ __html: msg }} />
  );
}
