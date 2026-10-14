// Kakao Maps provider implementing the MapView contract.
// Requires VITE_KAKAO_KEY (JavaScript key) and the serving domain registered in
// Kakao Developers (플랫폼 > Web > 사이트 도메인). Unregistered domains are rejected.
import { KAKAO_KEY, markerHTML, markerButton } from '../map.js';

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

// OSM zoom (7=국가 … 13=산 상세) → Kakao level (level↓ = 확대).
// 둘 다 한 단계마다 축척이 두 배라 기울기는 1이다(zoom 7 ≈ level 13: 남한 전체). 예전 기울기 1.333은
// 산 상세(z12~15)를 level 2~6으로 보내 Leaflet보다 2단계 이상 더 확대했고, maxZoom 상한도 뜻이 없었다.
const toLevel = (z) => Math.max(1, Math.min(14, Math.round(20 - z)));
const toZoom = (level) => 20 - level;
// 동작 줄이기 설정 — 부를 때마다 읽는다(설정을 바꾸면 바로 따르게). Leaflet 공급자와 같은 기준.
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const STROKE = { dash: 'shortdash', dot: 'shortdot' };

export async function createKakaoView(node, { center = [36.5, 127.9], zoom = 7 } = {}) {
  await loadSDK();
  const kakao = window.kakao;
  const ll = (lat, lng) => new kakao.maps.LatLng(lat, lng);
  const map = new kakao.maps.Map(node, { center: ll(center[0], center[1]), level: toLevel(zoom) });
  // 확대 버튼은 앱이 직접 그린다(오른쪽 컨트롤 묶음). 카카오 기본 컨트롤은 붙이지 않는다.

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
  const clickHandlers = new Set();
  const emitClick = e => {
    closePopup();
    clickHandlers.forEach(fn => fn([e.latLng.getLat(), e.latLng.getLng()]));
  };
  kakao.maps.event.addListener(map, 'click', emitClick);
  let openPopupOverlay = null;

  function closePopup() { if (openPopupOverlay) { openPopupOverlay.setMap(null); openPopupOverlay = null; } }

  function pinOverlay(lat, lng, color, star, title, subtitle) {
    const el = title ? markerButton(color, star, title, subtitle) : document.createElement('div');
    if (!title) el.innerHTML = markerHTML(color, star);
    el.style.cursor = 'pointer';
    const ov = new kakao.maps.CustomOverlay({ position: ll(lat, lng), content: el, xAnchor: 0.5, yAnchor: title ? 50 / 72 : 0.5, zIndex: 3 });
    ov.setMap(map);
    return { ov, el };
  }

  // 시트·상단 바에 가리는 부분을 뺀 "보이는 영역"의 가운데에 점이 오도록 지도 중심을 옮긴다.
  function paddedCenter(pos, pad) {
    if (!pad) return pos;
    const dx = ((pad.right || 0) - (pad.left || 0)) / 2;
    const dy = ((pad.bottom || 0) - (pad.top || 0)) / 2;
    if (!dx && !dy) return pos;
    const proj = map.getProjection();
    const p = proj.pointFromCoords(pos);
    return proj.coordsFromPoint(new kakao.maps.Point(p.x + dx, p.y + dy));
  }

  function setView([lat, lng], z, { padding } = {}) {
    if (z != null) map.setLevel(toLevel(z));
    map.setCenter(paddedCenter(ll(lat, lng), padding));
  }

  return {
    provider: 'kakao',
    setView,
    panTo([lat, lng], { padding } = {}) {
      if (reduceMotion()) { map.setCenter(paddedCenter(ll(lat, lng), padding)); return; }
      map.panTo(paddedCenter(ll(lat, lng), padding));
    },
    flyTo(pt, z, opts = {}) {
      // 카카오의 panTo는 스크립트로 프레임마다 옮겨서 CSS의 동작 줄이기 규칙이 닿지 않는다 — 여기서 직접 끈다.
      if (reduceMotion()) { setView(pt, z, opts); return; }
      const [lat, lng] = pt;
      if (z != null) map.setLevel(toLevel(z), { anchor: ll(lat, lng) });
      map.panTo(paddedCenter(ll(lat, lng), opts.padding));
    },
    zoomBy(delta) { map.setLevel(Math.max(1, Math.min(14, map.getLevel() - Math.sign(delta))), { animate: !reduceMotion() }); },
    getZoom() { return toZoom(map.getLevel()); },
    getBounds() { const b = map.getBounds(); const sw = b.getSouthWest(), ne = b.getNorthEast(); return { south: sw.getLat(), west: sw.getLng(), north: ne.getLat(), east: ne.getLng() }; },
    onMove(fn) {
      const handler = () => fn();
      kakao.maps.event.addListener(map, 'idle', handler);
      return () => kakao.maps.event.removeListener(map, 'idle', handler);
    },
    onClick(fn) { clickHandlers.add(fn); return () => clickHandlers.delete(fn); },
    project([lat, lng]) { return map.getProjection().containerPointFromCoords(ll(lat, lng)); },

    clearMarkers() { managedMarkers.forEach((m) => m.setMap(null)); managedMarkers.length = 0; closePopup(); },
    addMarker({ lat, lng, node, size = [44, 44], anchor, color, star = false, popupHTML, onClick, title, subtitle, zIndex = 0 }) {
      let ov, el;
      if (node) {
        el = node;
        const [w, h] = size, [ax, ay] = anchor || [w / 2, h / 2];
        ov = new kakao.maps.CustomOverlay({ position: ll(lat, lng), content: el, xAnchor: ax / w, yAnchor: ay / h, zIndex: 3 + zIndex, clickable: true });
        ov.setMap(map);
      } else ({ ov, el } = pinOverlay(lat, lng, color, star, title || '산 선택', subtitle));
      const baseZ = 3 + zIndex;
      const raise = () => ov.setZIndex(baseZ + 20);
      const lower = () => ov.setZIndex(el.matches(':hover, :focus-within') ? baseZ + 20 : baseZ);
      el.addEventListener('pointerenter', raise);
      el.addEventListener('pointerleave', lower);
      el.addEventListener('focusin', raise);
      el.addEventListener('focusout', lower);
      managedMarkers.push(ov);
      const open = () => {
        if (!popupHTML) return;
        closePopup();
        const box = document.createElement('div');
        box.className = 'kakao-pop';
        box.innerHTML = popupHTML;
        box.addEventListener('click', e => { e.stopPropagation(); kakao.maps.event.preventMap(); });
        openPopupOverlay = new kakao.maps.CustomOverlay({ position: ll(lat, lng), content: box, clickable: true, xAnchor: 0.5, yAnchor: 1.4, zIndex: 6 });
        openPopupOverlay.setMap(map);
      };
      el.addEventListener('click', e => { e.stopPropagation(); kakao.maps.event.preventMap(); if (onClick) onClick(); else open(); });
      return {
        openPopup: open,
        setZIndex(z) { ov.setZIndex(3 + z); },
        element: () => el,
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
    // 지도에 보이는 텍스트 라벨(주요 지점 이름)
    addLabel({ lat, lng, text, kind = '' }) {
      const box = document.createElement('div');
      box.className = 'map-label ' + kind;
      box.innerHTML = `<span>${text}</span>`;
      const ov = new kakao.maps.CustomOverlay({ position: ll(lat, lng), content: box, yAnchor: 1.5, xAnchor: 0.5, zIndex: 4 });
      ov.setMap(map);
      return { remove() { ov.setMap(null); } };
    },
    addPolyline(latlngs, { color = '#b4432b', weight = 4, opacity = 0.95, outline = false, dash = null } = {}) {
      const path = latlngs.map(([a, b]) => ll(a, b));
      const lines = [];
      if (outline) lines.push(new kakao.maps.Polyline({ map, path, strokeWeight: weight + 3, strokeColor: '#ffffff', strokeOpacity: opacity * 0.85, strokeStyle: 'solid' }));
      lines.push(new kakao.maps.Polyline({ map, path, strokeWeight: weight, strokeColor: color, strokeOpacity: opacity, strokeStyle: STROKE[dash] || 'solid' }));
      lines.forEach(line => kakao.maps.event.addListener(line, 'click', e => { kakao.maps.event.preventMap(); emitClick(e); }));
      return { remove() { lines.forEach((l) => l.setMap(null)); } };
    },
    addPolylines(lines, { color = '#1f7a74', weight = 2.2, opacity = 0.8, dash = null } = {}) {
      const objs = lines.map((line) => new kakao.maps.Polyline({
        map, path: line.map(([a, b]) => ll(a, b)), strokeWeight: weight, strokeColor: color, strokeOpacity: opacity, strokeStyle: STROKE[dash] || 'solid',
      }));
      return { remove() { objs.forEach((o) => o.setMap(null)); } };
    },
    removeLayer(token) { (Array.isArray(token) ? token : [token]).forEach((t) => t?.remove?.()); },
    /** maxZoom: 이보다 더 확대하지 않는다(Leaflet과 같은 계약). 짧은 코스·가까운 두 점이 골목 축척으로 열리지 않게. */
    fitBounds(latlngs, pad = 0.15, { padding, maxZoom = 15 } = {}) {
      if (!latlngs?.length) return;
      const b = new kakao.maps.LatLngBounds();
      latlngs.forEach(([a, c]) => b.extend(ll(a, c)));
      if (padding) map.setBounds(b, padding.top || 0, padding.right || 0, padding.bottom || 0, padding.left || 0);
      else map.setBounds(b);
      const minLevel = toLevel(maxZoom);
      if (map.getLevel() < minLevel) {
        // 상한까지 물러난 뒤 범위 가운데를 "보이는 영역"(여백을 뺀 곳)의 가운데에 둔다.
        map.setLevel(minLevel);
        const sw = b.getSouthWest(), ne = b.getNorthEast();
        map.setCenter(paddedCenter(ll((sw.getLat() + ne.getLat()) / 2, (sw.getLng() + ne.getLng()) / 2), padding));
      }
    },
    setBaseType(type) { if (type !== baseType) applyBase(type); },
    snapshot() { const c = map.getCenter(), b = map.getBounds(); return { center: [c.getLat(), c.getLng()], level: map.getLevel(), span: [b.getNorthEast().getLat() - b.getSouthWest().getLat(), b.getNorthEast().getLng() - b.getSouthWest().getLng()] }; },
    restore(s) { if (s?.center && s.level != null) { map.setLevel(s.level); map.setCenter(ll(...s.center)); } },
    relayout() { const c = map.getCenter(); map.relayout(); map.setCenter(c); },
    refreshTheme() { /* Kakao has no built-in dark skin; no-op */ },
    destroy() { clickHandlers.clear(); kakao.maps.event.removeListener(map, 'click', emitClick); closePopup(); managedMarkers.forEach((m) => m.setMap(null)); node.innerHTML = ''; },
  };
}
