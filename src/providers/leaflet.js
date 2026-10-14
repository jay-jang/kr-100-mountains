// Leaflet + OpenStreetMap provider implementing the MapView contract (see map.js).
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { isDark, markerButton } from '../map.js';

// 다크 모드도 OSM 기본 타일을 쓰고 CSS 필터로 어둡게 한다(.tiles-dark).
// (예전 CARTO dark_all 타일은 이제 API 키를 요구해 "API KEY REQUIRED" 워터마크가 찍힌다.)
const LIGHT = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const TOPO = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png';
const SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

function tileFor(type) {
  if (type === 'terrain') return { url: TOPO, opts: { attribution: `${ATTR} · &copy; OpenTopoMap (CC-BY-SA)`, maxZoom: 17, subdomains: 'abc' } };
  if (type === 'satellite') return { url: SAT, opts: { attribution: 'Tiles &copy; Esri', maxZoom: 19 } };
  return { url: LIGHT, opts: { attribution: ATTR, maxZoom: 19, className: isDark() ? 'tiles-dark' : '' } };
}

const DASH = { dash: '8 7', dot: '1 7' };

export function createLeafletView(node, { center = [36.5, 127.9], zoom = 7 } = {}) {
  // 확대 버튼·저작권 위치는 앱이 정한다(오른쪽 컨트롤 묶음과 겹치지 않게 저작권은 왼쪽 아래).
  const map = L.map(node, { zoomControl: false, attributionControl: false, scrollWheelZoom: true, zoomSnap: 0.5 })
    .setView(center, zoom);
  L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
  let baseType = 'default';
  let tile;
  function applyBase(type) {
    baseType = type;
    node.dataset.basetype = type === 'default' && isDark() ? 'dark' : type;
    if (tile) map.removeLayer(tile);
    const { url, opts } = tileFor(type);
    tile = L.tileLayer(url, opts).addTo(map);
    tile.setZIndex(0);
  }
  applyBase('default');
  const markerGroup = L.layerGroup().addTo(map);

  // 시트에 가려지는 영역을 뺀 "보이는 영역"의 가운데에 점이 오도록 중심을 계산한다.
  function paddedCenter(latlng, z, pad) {
    if (!pad) return L.latLng(latlng);
    const dx = ((pad.right || 0) - (pad.left || 0)) / 2;
    const dy = ((pad.bottom || 0) - (pad.top || 0)) / 2;
    return map.unproject(map.project(latlng, z).add([dx, dy]), z);
  }

  return {
    provider: 'osm',
    setView([lat, lng], z, { padding } = {}) { const zz = z ?? map.getZoom(); map.setView(paddedCenter([lat, lng], zz, padding), zz, { animate: false }); },
    panTo([lat, lng], { padding } = {}) { map.panTo(paddedCenter([lat, lng], map.getZoom(), padding)); },
    flyTo([lat, lng], z, { padding } = {}) {
      if (!map.getSize().x) map.invalidateSize({ pan: false });   // 숨겨졌다 보인 직후
      const zz = z ?? map.getZoom();
      // 아직도 0×0(숨겨진 지도)이면 날아가는 계산이 0으로 나눠 NaN 좌표를 매 프레임 던진다 — 애니메이션 없이 옮긴다.
      const reduce = !map.getSize().x || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) map.setView(paddedCenter([lat, lng], zz, padding), zz, { animate: false });
      else map.flyTo(paddedCenter([lat, lng], zz, padding), zz, { duration: 0.6 });
    },
    zoomBy(delta) { map.setZoom(map.getZoom() + delta); },
    getZoom() { return map.getZoom(); },
    getBounds() { const b = map.getBounds(); return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }; },
    onMove(fn) {
      const handler = () => fn();
      map.on('moveend', handler);
      return () => map.off('moveend', handler);
    },
    onClick(fn) {
      const handler = e => fn([e.latlng.lat, e.latlng.lng]);
      map.on('click', handler); return () => map.off('click', handler);
    },
    project(point) { return map.latLngToContainerPoint(point); },

    clearMarkers() { map.closePopup(); markerGroup.clearLayers(); },
    /**
     * DOM 마커. node를 주면 그대로 쓰고(앱이 모양을 정함), 없으면 예전 핀을 만든다.
     * anchor는 [x,y] 픽셀(노드 왼쪽 위 기준), size는 [w,h].
     */
    addMarker({ lat, lng, node, size = [44, 44], anchor, onClick, color, star = false, title, subtitle, zIndex = 0 }) {
      const html = node || markerButton(color, star, title, subtitle);
      const icon = L.divIcon({ className: 'kr-pin', html, iconSize: node ? size : [44, 72], iconAnchor: anchor || (node ? [size[0] / 2, size[1] / 2] : [22, 50]) });
      const mk = L.marker([lat, lng], { icon, keyboard: false, riseOnHover: true, zIndexOffset: zIndex }).addTo(markerGroup);
      const button = mk.getElement()?.querySelector('button');
      button?.addEventListener('focusin', () => mk.setZIndexOffset(1000));
      button?.addEventListener('focusout', () => mk.setZIndexOffset(zIndex));
      if (onClick) mk.on('click', () => onClick());
      return {
        openPopup() {},
        setZIndex(z) { mk.setZIndexOffset(z); },
        element: () => mk.getElement(),
        remove() { markerGroup.removeLayer(mk); },
      };
    },
    addDot({ lat, lng, color, title, radius = 7 }) {
      const mk = L.circleMarker([lat, lng], { radius, color: '#fff', weight: 2.5, fillColor: color, fillOpacity: 1, interactive: !!title }).addTo(map);
      if (title) mk.bindTooltip(title);
      return { remove() { map.removeLayer(mk); } };
    },
    // 현재 위치용 갱신 가능한 레이어(파란 점 + 정확도 원)
    locate() {
      let dot = null, ring = null;
      return {
        set({ lat, lng, accuracy = 0 }) {
          const p = [lat, lng];
          if (!dot) {
            ring = L.circle(p, { radius: accuracy, color: '#1a73e8', weight: 1, opacity: 0.5, fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }).addTo(map);
            dot = L.circleMarker(p, { radius: 7, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }).addTo(map);
          } else { dot.setLatLng(p); ring.setLatLng(p); ring.setRadius(accuracy); }
        },
        remove() { if (dot) map.removeLayer(dot); if (ring) map.removeLayer(ring); dot = ring = null; },
      };
    },
    // 지도에 보이는 텍스트 라벨(주요 지점 이름)
    addLabel({ lat, lng, text, kind = '' }) {
      const tip = L.tooltip({ permanent: true, direction: 'top', className: 'map-label ' + kind, offset: [0, -3], opacity: 1 })
        .setLatLng([lat, lng]).setContent(text).addTo(map);
      return { remove() { map.removeLayer(tip); } };
    },
    addPolyline(latlngs, { color = '#b4432b', weight = 4, opacity = 0.95, outline = false, dash = null } = {}) {
      const g = L.layerGroup().addTo(map);
      if (outline) L.polyline(latlngs, { color: isDark() ? '#10140f' : '#fff', weight: weight + 3, opacity: opacity * 0.85, lineCap: 'round', interactive: false }).addTo(g);
      L.polyline(latlngs, { color, weight, opacity, lineCap: dash ? 'butt' : 'round', dashArray: DASH[dash] || null, interactive: false }).addTo(g);
      return { remove() { map.removeLayer(g); } };
    },
    addPolylines(lines, { color = '#1f7a74', weight = 2.2, opacity = 0.8, dash = null } = {}) {
      const g = L.layerGroup().addTo(map);
      for (const line of lines) L.polyline(line, { color, weight, opacity, dashArray: DASH[dash] || null, interactive: false }).addTo(g);
      return { remove() { map.removeLayer(g); } };
    },
    removeLayer(token) { (Array.isArray(token) ? token : [token]).forEach((t) => t?.remove?.()); },
    /** pad: 비율 여백(옛 방식). opts.padding: {top,right,bottom,left} 픽셀 — 시트·상단 바에 가리는 부분을 뺀다. */
    fitBounds(latlngs, pad = 0.15, { padding, maxZoom = 15 } = {}) {
      if (!latlngs?.length) return;
      if (!map.getSize().x) map.invalidateSize({ pan: false });
      if (!map.getSize().x) return;      // 숨겨진 0×0 지도: 맞출 크기가 없다(보일 때 화면이 다시 맞춘다)
      const b = L.latLngBounds(latlngs);
      if (padding) map.fitBounds(b, { paddingTopLeft: [padding.left || 0, padding.top || 0], paddingBottomRight: [padding.right || 0, padding.bottom || 0], animate: false, maxZoom });
      else map.fitBounds(b.pad(pad), { animate: false, maxZoom });
    },
    setBaseType(type) { if (type !== baseType) applyBase(type); },
    // 되돌릴 때는 중심이 아니라 왼쪽 위 모서리를 맞춘다. 지도 상자 높이는 시트 peek에 따라 바뀌고(목록 ≈84, 산 ≈132),
    // relayout(pan:false)은 왼쪽 위를 고정한 채 크기만 바꾼다 — 중심으로 되돌리면 그 뒤의 relayout이 화면을
    // 높이 차의 절반만큼 밀어 낸다. 왼쪽 위 기준이면 언제 relayout되든 사용자가 보던 자리가 그대로다.
    snapshot() {
      const c = map.getCenter(), b = map.getBounds(), size = map.getSize();
      const nw = size.x ? map.containerPointToLatLng([0, 0]) : null;
      return { center: [c.lat, c.lng], zoom: map.getZoom(), span: [b.getNorth() - b.getSouth(), b.getEast() - b.getWest()], nw: nw ? [nw.lat, nw.lng] : null };
    },
    restore(s) {
      if (!s?.center || s.zoom == null) return;
      if (!map.getSize().x) map.invalidateSize({ pan: false });
      const size = map.getSize();
      if (s.nw && size.x) {
        const c = map.unproject(map.project(s.nw, s.zoom).add(size.divideBy(2)), s.zoom);
        map.setView(c, s.zoom, { animate: false });
      } else map.setView(s.center, s.zoom, { animate: false });
    },
    relayout() { map.invalidateSize({ pan: false }); },
    refreshTheme() { if (baseType === 'default') applyBase('default'); },
    destroy() { map.remove(); },
  };
}
