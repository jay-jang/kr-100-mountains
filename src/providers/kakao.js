// Kakao Maps provider implementing the MapView contract.
// Requires VITE_KAKAO_KEY (JavaScript key) and the serving domain registered in
// Kakao Developers (플랫폼 > Web > 사이트 도메인). Unregistered domains are rejected.
import { KAKAO_KEY, markerHTML } from '../map.js';

let sdkPromise = null;
function loadSDK() {
  if (window.kakao?.maps) return Promise.resolve();
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_KEY}&autoload=false&libraries=services`;
    s.onload = () => window.kakao.maps.load(resolve);
    s.onerror = () => reject(new Error('카카오맵 SDK 로드 실패 — JS 키/도메인 등록을 확인하세요.'));
    document.head.appendChild(s);
  });
  return sdkPromise;
}

// OSM zoom (7=국가 … 13=산 상세) → Kakao level (level↓ = 확대), 대략적 대응
const toLevel = (z) => Math.max(1, Math.min(14, Math.round(13 - (z - 7) * 1.333)));

export async function createKakaoView(node, { center = [36.5, 127.9], zoom = 7 } = {}) {
  await loadSDK();
  const kakao = window.kakao;
  const ll = (lat, lng) => new kakao.maps.LatLng(lat, lng);
  const map = new kakao.maps.Map(node, { center: ll(center[0], center[1]), level: toLevel(zoom) });
  map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);

  // base type: 'default'(일반) / 'terrain'(지형도 오버레이) / 'satellite'(스카이뷰+라벨)
  let baseType = 'default';
  let terrainOn = false;
  function applyBase(type) {
    baseType = type;
    map.setMapTypeId(type === 'satellite' ? kakao.maps.MapTypeId.HYBRID : kakao.maps.MapTypeId.ROADMAP);
    const wantTerrain = type === 'terrain';
    if (wantTerrain && !terrainOn) { map.addOverlayMapTypeId(kakao.maps.MapTypeId.TERRAIN); terrainOn = true; }
    else if (!wantTerrain && terrainOn) { map.removeOverlayMapTypeId(kakao.maps.MapTypeId.TERRAIN); terrainOn = false; }
  }

  const managedMarkers = [];   // addMarker() overlays (cleared by clearMarkers)
  let openPopupOverlay = null;

  function closePopup() { if (openPopupOverlay) { openPopupOverlay.setMap(null); openPopupOverlay = null; } }

  function pinOverlay(lat, lng, color, star) {
    const el = document.createElement('div');
    el.innerHTML = markerHTML(color, star);
    el.style.cursor = 'pointer';
    const ov = new kakao.maps.CustomOverlay({ position: ll(lat, lng), content: el, xAnchor: 0.5, yAnchor: 0.5, zIndex: 3 });
    ov.setMap(map);
    return { ov, el };
  }

  return {
    setView([lat, lng], z) { map.setCenter(ll(lat, lng)); if (z != null) map.setLevel(toLevel(z)); },
    panTo([lat, lng]) { map.panTo(ll(lat, lng)); },
    flyTo([lat, lng], z) { map.panTo(ll(lat, lng)); if (z != null) map.setLevel(toLevel(z), { anchor: ll(lat, lng) }); },

    clearMarkers() { managedMarkers.forEach((m) => m.setMap(null)); managedMarkers.length = 0; closePopup(); },
    addMarker({ lat, lng, color, star = false, popupHTML, onClick, title }) {
      const { ov, el } = pinOverlay(lat, lng, color, star);
      if (title) el.title = title;
      managedMarkers.push(ov);
      const open = () => {
        if (!popupHTML) return;
        closePopup();
        const box = document.createElement('div');
        box.className = 'kakao-pop';
        box.innerHTML = popupHTML;
        openPopupOverlay = new kakao.maps.CustomOverlay({ position: ll(lat, lng), content: box, xAnchor: 0.5, yAnchor: 1.4, zIndex: 6 });
        openPopupOverlay.setMap(map);
      };
      el.addEventListener('click', () => { onClick?.(); open(); });
      return {
        openPopup: open,
        remove() { ov.setMap(null); const i = managedMarkers.indexOf(ov); if (i >= 0) managedMarkers.splice(i, 1); },
      };
    },
    addDot({ lat, lng, color, title }) {
      const { ov, el } = pinOverlay(lat, lng, color, false);
      if (title) el.title = title;
      return { remove() { ov.setMap(null); } };
    },
    // 현재 위치용 갱신 가능한 레이어(파란 점 + 정확도 원)
    locate() {
      let ov = null, circle = null;
      return {
        set({ lat, lng, accuracy = 0 }) {
          const pos = ll(lat, lng);
          if (!ov) {
            const el = document.createElement('div');
            el.className = 'geo-dot';
            ov = new kakao.maps.CustomOverlay({ position: pos, content: el, xAnchor: 0.5, yAnchor: 0.5, zIndex: 5 });
            ov.setMap(map);
            circle = new kakao.maps.Circle({ map, center: pos, radius: accuracy, strokeWeight: 1, strokeColor: '#1a73e8', strokeOpacity: 0.5, fillColor: '#1a73e8', fillOpacity: 0.12 });
          } else { ov.setPosition(pos); circle.setPosition(pos); circle.setRadius(accuracy); }
        },
        remove() { if (ov) ov.setMap(null); if (circle) circle.setMap(null); ov = circle = null; },
      };
    },
    addPolyline(latlngs, { color = '#d1495b', weight = 4, opacity = 0.95, outline = false } = {}) {
      const path = latlngs.map(([a, b]) => ll(a, b));
      const lines = [];
      if (outline) lines.push(new kakao.maps.Polyline({ map, path, strokeWeight: weight + 3, strokeColor: '#ffffff', strokeOpacity: 0.85, strokeStyle: 'solid' }));
      lines.push(new kakao.maps.Polyline({ map, path, strokeWeight: weight, strokeColor: color, strokeOpacity: opacity, strokeStyle: 'solid' }));
      return { remove() { lines.forEach((l) => l.setMap(null)); } };
    },
    addPolylines(lines, { color = '#e2872a', weight = 2.2, opacity = 0.8 } = {}) {
      const objs = lines.map((line) => new kakao.maps.Polyline({
        map, path: line.map(([a, b]) => ll(a, b)), strokeWeight: weight, strokeColor: color, strokeOpacity: opacity, strokeStyle: 'solid',
      }));
      return { remove() { objs.forEach((o) => o.setMap(null)); } };
    },
    removeLayer(token) { (Array.isArray(token) ? token : [token]).forEach((t) => t?.remove?.()); },
    fitBounds(latlngs, pad = 0.15) {
      const b = new kakao.maps.LatLngBounds();
      latlngs.forEach(([a, c]) => b.extend(ll(a, c)));
      map.setBounds(b);
    },
    setBaseType(type) { if (type !== baseType) applyBase(type); },
    relayout() { const c = map.getCenter(); map.relayout(); map.setCenter(c); },
    refreshTheme() { /* Kakao has no built-in dark skin; no-op */ },
    destroy() { closePopup(); managedMarkers.forEach((m) => m.setMap(null)); node.innerHTML = ''; },
  };
}
