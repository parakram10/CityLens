import { useEffect, useRef } from 'react';
import L from 'leaflet';

// Thin React wrapper around an imperative Leaflet map — Leaflet owns the DOM inside
// this div, same as the original app's per-view `L.map(id)` calls. `onMount(L, map)`
// builds the layers for one view and may return a cleanup function.
export default function LeafletMap({ height = 460, onMount, mountKey }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    const map = L.map(divRef.current, { zoomControl: true, attributionControl: false });
    mapRef.current = map;
    const cleanup = onMount ? onMount(L, map) : undefined;
    // Leaflet needs a size recompute once its container has real layout dimensions.
    requestAnimationFrame(() => map.invalidateSize());
    return () => {
      if (typeof cleanup === 'function') cleanup();
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountKey]);

  return <div ref={divRef} style={{ width: '100%', height }} />;
}
