// Provider-agnostic map facade.
// Picks Kakao Maps when VITE_KAKAO_KEY is set at build time, otherwise Leaflet + OSM.
// Both providers implement the same MapView contract (see providers/*.js):
//   setView([lat,lng],zoom) · panTo([lat,lng]) · clearMarkers()
//   addMarker({lat,lng,color,star,popupHTML,onClick,title}) -> {openPopup(),remove()}
//   addDot({lat,lng,color,title}) -> {remove()}
//   addPolyline(latlngs,style) -> {remove()} · addPolylines(lines,style) -> {remove()}
//   removeLayer(token|token[]) · fitBounds(latlngs,pad) · refreshTheme() · destroy()

export const KAKAO_KEY = import.meta.env.VITE_KAKAO_KEY || '';
export const MAP_PROVIDER = KAKAO_KEY ? 'kakao' : 'osm';

export function isDark() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export async function createMapView(node, opts = {}) {
  try {
    if (MAP_PROVIDER === 'kakao') {
      const { createKakaoView } = await import('./providers/kakao.js');
      return await createKakaoView(node, opts);
    }
    const { createLeafletView } = await import('./providers/leaflet.js');
    return createLeafletView(node, opts);
  } catch (e) {
    // Map failure must never break the rest of the page — return a no-op stub.
    console.error('map provider failed:', e);
    return deadMapView(node, e);
  }
}

function deadMapView(node, err) {
  const hint = MAP_PROVIDER === 'kakao'
    ? '카카오맵 JS 키/도메인 등록을 확인하세요.'
    : (err?.message || '');
  node.innerHTML = `<div class="map-error">🗺️ 지도를 불러오지 못했습니다.<br><small>${hint}</small></div>`;
  const noop = () => {};
  const token = { remove: noop };
  return {
    setView: noop, panTo: noop, flyTo: noop, clearMarkers: noop,
    addMarker: () => ({ openPopup: noop, remove: noop }),
    addDot: () => token, addPolyline: () => token, addPolylines: () => token,
    addLabel: () => token,
    locate: () => ({ set: noop, remove: noop }),
    removeLayer: noop, fitBounds: noop, setBaseType: noop, relayout: noop,
    refreshTheme: noop, destroy: noop,
  };
}

// shared marker DOM (colored dot or gold star) — used by both providers
export function markerHTML(color, star) {
  return star
    ? `<div class="map-pin star"><svg width="22" height="22" viewBox="0 0 24 24"><path d="M12 2l2.9 6.2 6.8.8-5 4.6 1.3 6.7L12 17.8 5.9 20l1.3-6.7-5-4.6 6.8-.8z" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg></div>`
    : `<div class="map-pin dot" style="background:${color}"></div>`;
}

export function popupContent(m) {
  const badges = [m.lists.sanlim && '산림청', m.lists.bac && 'BAC', m.lists.hansanha && '한국의산하', m.lists.wolgansan && '월간산']
    .filter(Boolean).join(' · ');
  return `<div class="pop-title">${m.name_full}</div>
    <div class="pop-meta">${m.region} · ${m.province} · ${Math.round(m.elevation_m)}m${badges ? '<br>' + badges : ''}</div>
    <a class="pop-link" href="#/m/${m.id}">자세히 보기 →</a>`;
}

// Overpass hiking-path overlay (real OSM data) — returns array of [ [lat,lng], ... ] lines
export async function fetchTrails(lat, lon, radius = 3000) {
  const { overpassFetch } = await import('./osm.js');
  const q = `[out:json][timeout:25];(way["highway"~"path|footway|track|steps"](around:${radius},${lat},${lon}););out geom;`;
  const json = await overpassFetch(q);
  return (json.elements || [])
    .filter((e) => e.geometry?.length)
    .map((e) => e.geometry.map((g) => [g.lat, g.lon]));
}
