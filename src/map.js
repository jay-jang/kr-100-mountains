// Provider-agnostic map facade.
// Picks Kakao Maps when VITE_KAKAO_KEY is set at build time, otherwise Leaflet + OSM.
// Both providers implement the same MapView contract (see providers/*.js):
//   setView([lat,lng],zoom,{padding}) · panTo · flyTo — padding {top,right,bottom,left}px는
//     시트·상단 바에 가리는 부분이다. 점이 "보이는 영역"의 가운데에 오게 한다.
//   zoomBy(±1) · getZoom() (OSM 기준 축척) · getBounds() -> {south,west,north,east} · onMove(fn) -> unsubscribe
//   clearMarkers() · addMarker({lat,lng,node,size,anchor,onClick,zIndex}) -> {setZIndex,element,remove}
//   addDot({lat,lng,color,title}) -> {remove()} · addLabel({lat,lng,text,kind})
//   addPolyline(latlngs,{color,weight,opacity,outline,dash:'dash'|'dot'}) · addPolylines(lines,style)
//   removeLayer(token|token[]) · fitBounds(latlngs,pad,{padding,maxZoom=15}) — maxZoom보다 더 확대하지 않는다
//   setBaseType · refreshTheme() · destroy() · snapshot()/restore(s) — 목록으로 돌아올 때 보던 범위 되돌리기
//   project([lat,lng]) -> {x,y} container pixels · onClick(fn) -> unsubscribe · relayout()
import { el, clear } from './dom.js';

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
      const view = await createKakaoView(node, opts);
      node.querySelector('.map-loading, .explore-loading')?.remove();
      return view;
    }
    const { createLeafletView } = await import('./providers/leaflet.js');
    const view = createLeafletView(node, opts);
    node.querySelector('.map-loading, .explore-loading')?.remove();
    return view;
  } catch (e) {
    // Map failure must never break the rest of the page — return a no-op stub.
    console.error('map provider failed:', e);
    return deadMapView(node);
  }
}

function deadMapView(node) {
  clear(node).append(el('div', { class: 'map-error', role: 'status' },
    el('strong', {}, '지도를 불러오지 못했습니다.'),
    el('p', {}, '연결 상태를 확인해 주세요. 산 목록과 코스 정보는 계속 이용할 수 있습니다.'),
    el('button', { class: 'btn', onClick: () => location.reload() }, '새로고침')));
  const noop = () => {};
  const token = { remove: noop };
  return {
    ready: false,
    provider: 'none',
    setView: noop, panTo: noop, flyTo: noop, clearMarkers: noop, zoomBy: noop,
    getZoom: () => 7, getBounds: () => ({ south: 33, west: 124.5, north: 38.7, east: 131 }), onMove: () => noop,
    addMarker: () => ({ openPopup: noop, remove: noop, setZIndex: noop, element: () => null }),
    addDot: () => token, addPolyline: () => token, addPolylines: () => token,
    addLabel: () => token,
    locate: () => ({ set: noop, remove: noop }),
    removeLayer: noop, fitBounds: noop, setBaseType: noop, relayout: noop,
    refreshTheme: noop, destroy: noop,
    onClick: () => noop,
    project: () => ({ x: NaN, y: NaN }),
  };
}

// shared marker DOM (colored dot or gold star) — used by both providers
export function markerHTML(color, star) {
  return star
    ? `<div class="map-pin star"><svg width="22" height="22" viewBox="0 0 24 24"><path d="M12 2l2.9 6.2 6.8.8-5 4.6 1.3 6.7L12 17.8 5.9 20l1.3-6.7-5-4.6 6.8-.8z" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg></div>`
    : `<div class="map-pin dot" style="background:${color}"></div>`;
}

export function markerButton(color, star, title, subtitle) {
  const button = el('button', { class: 'mountain-marker', type: 'button', 'aria-label': title || '산 선택' });
  button.innerHTML = markerHTML(color, star);
  // Keep the preview inside the button: moving from the pin to its name must
  // preserve hover and allow the same pointer/keyboard selection action.
  button.append(el('span', { class: 'mountain-marker-preview', 'aria-hidden': 'true' },
    el('strong', {}, title || '산 선택'), subtitle && el('span', {}, subtitle)));
  guardDragClick(button);
  return button;
}


/** 지도를 끌다가 마커 위에서 손을 떼면 일부 공급자가 마커 click을 보낸다 — 그 click만 버린다. */
export function guardDragClick(button) {
  let pointerStart = null;
  button.addEventListener('pointerdown', e => { pointerStart = { x: e.clientX, y: e.clientY }; });
  button.addEventListener('pointercancel', () => { pointerStart = null; });
  button.addEventListener('click', e => {
    // Some map providers still deliver a DOM click after dragging an overlay.
    // Let the map receive the drag, then discard only its trailing click.
    if (pointerStart && e.detail && Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y) > 6) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    pointerStart = null;
  }, { capture: true });
}
