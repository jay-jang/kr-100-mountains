// 지도 셸 — 앱 수명 동안 지도 하나와 시트 하나를 유지하고, 화면(목록·산·경로·걷기길)은
// 시트 내용과 지도 레이어만 바꾸는 "컨트롤러"로 붙였다 뗀다.
//
// 컨트롤러 계약: factory(ctx, route) → { dispose?(), update?(route) → boolean, onEscape?() }
//   ctx.layers.add(token)  — 이 화면에서 그린 레이어. 화면을 떠나면 자동으로 지운다.
//   ctx.whenMap(fn)        — 지도 준비 후 실행(이미 준비됐으면 바로). 화면을 떠난 뒤에는 실행하지 않는다.
//   ctx.onMapClick(fn)     — fn([lat,lng]) → true면 처리 완료(걷기길 선 탭 판정으로 넘기지 않음).
//   ctx.signal             — 화면을 떠나면 abort되는 AbortSignal(fetch에 넘긴다).
import { el, clear } from './dom.js';
import { loadData, regionColor } from './data.js';
import { createMapView, guardDragClick } from './map.js';
import { createSheet } from './sheet.js';
import { createSearch } from './search.js';
import { icon, summitSymbol } from './icons.js';
import { pref, setPref, onPrefs, getMapType, setMapType, isDarkTheme, MAP_TYPES } from './prefs.js';
import { isHiked, onChange as onStore } from './store.js';
import { cachedPosition, notePosition, requestPosition, geoAvailable, onPositionChange } from './position.js';
import { watchPosition } from './geo.js';
import { navigate, currentRoute } from './router.js';
import { openModal, modalOpen } from './modal.js';
import { createWalkLayer } from './walklayer.js';
import { kindStyle, loadWalkIndex } from './walkdata.js';

const KOREA = [36.3, 127.8];
const NAME_MAX_KM = 150;      // 보이는 범위 폭이 이보다 좁으면 산 이름을 적는다
const CLUSTER_KM = 200;       // 보이는 범위 폭이 이보다 넓으면 겹치는 산 기호를 숫자 묶음으로
const CLUSTER_PX = 34;        // 묶음 반경(화면 px)
const AIM_GRACE_MS = 1500;    // 코드가 지도를 옮긴 뒤 이 시간 안의 이동은 사용자 이동으로 세지 않는다

let shellPromise = null;
export function getShell(host) {
  if (!shellPromise) shellPromise = createShell(host);
  return shellPromise;
}

async function createShell(host) {
  const data = await loadData();

  // ---------- DOM ----------
  const mapNode = el('div', { class: 'map', id: 'map', role: 'region', 'aria-label': '명산 지도' },
    el('p', { class: 'map-loading', role: 'status' }, '지도를 불러오는 중…'));
  const mapHost = el('div', { class: 'map-host' }, mapNode);

  const search = createSearch({
    data,
    getPos: () => cachedPosition(),
    onPick: (item) => pickSearchItem(item),
    onSubmit: (q) => submitSearch(q),
    onInput: (q) => current?.ctl?.onSearchInput?.(q),
  });
  const recordBtn = el('a', { class: 'tb-btn', href: '#/track' }, '기록');
  const settingsBtn = el('a', { class: 'tb-btn icon', href: '#/settings', 'aria-label': '설정', title: '설정', html: icon('settings') });
  const brand = el('a', { class: 'tb-brand', href: '#/map' }, '대한민국 100대 명산');

  const modeMtn = el('button', { type: 'button', class: 'seg-btn', 'aria-pressed': 'true' }, '명산');
  const modeWalk = el('button', { type: 'button', class: 'seg-btn', 'aria-pressed': 'false' }, '걷기길');
  const modeSeg = el('div', { class: 'seg', role: 'group', 'aria-label': '찾을 대상' }, modeMtn, modeWalk);
  const filterChip = el('button', { type: 'button', class: 'chip', 'aria-haspopup': 'dialog' }, '필터');
  const dulleChip = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', title: '주변에 둘레길·걷기길이 있는 산만' }, '둘레길 있는 산');
  const chips = el('div', { class: 'tb-chips' }, modeSeg, filterChip, dulleChip);
  const topbar = el('header', { class: 'tb' },
    el('div', { class: 'tb-row' }, brand, search.root, recordBtn, settingsBtn), chips);

  const zoomIn = el('button', { type: 'button', class: 'ctl-btn', 'aria-label': '확대', title: '확대', html: icon('plus') });
  const zoomOut = el('button', { type: 'button', class: 'ctl-btn', 'aria-label': '축소', title: '축소', html: icon('minus') });
  const layersBtn = el('button', { type: 'button', class: 'ctl-btn', 'aria-label': '지도 레이어', title: '지도 레이어', 'aria-haspopup': 'dialog', html: icon('layers') });
  const locateBtn = el('button', { type: 'button', class: 'ctl-btn', 'aria-label': '내 위치', title: '내 위치', html: icon('locate') });
  const trackBtn = el('button', { type: 'button', class: 'ctl-text', hidden: true, 'aria-pressed': 'false' }, '계속 추적');
  const zoomGroup = el('div', { class: 'ctl-group' }, zoomIn, zoomOut);
  const controls = el('div', { class: 'ctl' }, zoomGroup, layersBtn, el('div', { class: 'ctl-locate' }, trackBtn, locateBtn));
  const status = el('div', { class: 'map-toast', role: 'status', 'aria-live': 'polite', hidden: true });
  // 지도 위 가운데 떠 있는 동작 버튼(예: 걷기길 모드의 "이 지역 다시 찾기") — 화면이 바뀌면 사라진다.
  const mapAction = el('button', { type: 'button', class: 'map-action', hidden: true });
  let mapActionFn = null;
  mapAction.addEventListener('click', () => { const fn = mapActionFn; mapAction.hidden = true; fn?.(); });

  const chooserList = el('div', { class: 'chooser-list' });
  const chooser = el('div', { class: 'chooser', hidden: true, role: 'dialog', 'aria-label': '가까이 있는 산 선택' },
    el('div', { class: 'chooser-head' }, el('strong', {}, '이 근처 산'),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': '닫기', html: icon('close'), onClick: () => { chooser.hidden = true; } })),
    chooserList);

  let current = null;     // { name, key, ctx, ctl }
  const sheet = createSheet({ onChange: onSheetChange });
  // DOM 순서 = 키보드 순서: 상단 바 → 지도 컨트롤 → 시트 → 지도(산 기호 149개)를 맨 끝에.
  // 지도가 앞에 있으면 검색창까지 Tab을 150번 넘게 눌러야 한다. 겹침은 모두 z-index로 정해 화면 배치는 그대로다.
  const root = el('div', { class: 'shell', dataset: { detent: 'peek', mode: 'mountain' } },
    topbar, controls, status, mapAction, chooser, sheet.root, mapHost);
  host.append(root);
  // 상단 바 높이(글자 확대·줄바꿈 반영) → 데스크톱 패널 위치·토스트·선택창 위치에 쓴다.
  new ResizeObserver(() => root.style.setProperty('--tb-h', `${topbar.offsetHeight}px`)).observe(topbar);

  // ---------- 시트 ↔ 지도 ----------
  let lastPeek = -1, relayoutRaf = 0, pendingFit = null, inRelayout = false;
  /** 지도 컨테이너 크기를 다시 잰다. 이때 나는 이동 이벤트는 사용자가 옮긴 것이 아니다(다시 맞춤을 막지 않게). */
  function relayout() {
    if (!view) return;
    inRelayout = true;
    try { view.relayout(); } finally { inRelayout = false; }
  }
  function onSheetChange({ detent, height, peek, desktop, dragging }) {
    root.dataset.detent = desktop ? 'desktop' : detent;
    root.style.setProperty('--sheet-h', `${height}px`);
    // 끄는 동안에는 시트를 따라 움직이는 컨트롤·출처의 전환 애니메이션을 끈다(손가락보다 늦게 따라오지 않게).
    root.classList.toggle('sheet-dragging', !!dragging);
    if (peek !== lastPeek) {
      lastPeek = peek;
      root.style.setProperty('--map-bottom', `${peek}px`);
      cancelAnimationFrame(relayoutRaf);
      relayoutRaf = requestAnimationFrame(relayout);
    }
    if (detent !== 'full' && pendingFit) { const f = pendingFit; pendingFit = null; requestAnimationFrame(f); }
    else if (!desktop && detent !== lastDetent && detent !== 'full' && lastAim && !userMoved) {
      // 시트 높이가 바뀌어 가려지는 영역이 달라졌다 — 사용자가 지도를 직접 옮기지 않았다면 마지막 맞춤을 새 여백으로 다시.
      const aim = lastAim;
      requestAnimationFrame(() => { if (lastAim === aim) aim(); });   // 그사이 화면이 바뀌었으면(맞춤 해제) 하지 않는다
    }
    lastDetent = detent;
  }
  let lastDetent = 'peek', lastAim = null, userMoved = false, aimAt = 0;
  function aimed(fn) { lastAim = fn; userMoved = false; aimAt = Date.now(); fn(); }
  /** 지도에서 시트·상단 바에 가려지는 픽셀. 지도 컨테이너는 peek 위에서 끝나므로 peek은 빼고 센다. */
  function padding() {
    if (sheet.isDesktop()) return { top: 24, right: 72, bottom: 24, left: 24 };
    const over = Math.max(0, sheet.visibleHeight() - sheet.peekHeight());
    return { top: topbar.offsetHeight + 12, right: 64, bottom: over + 16, left: 16 };
  }
  // 시트가 full이면 지도가 거의 다 가려진다 — 맞춤을 미뤘다가 시트가 내려올 때 한다.
  // 미룬 맞춤은 그것을 부른 화면이 아직 살아 있을 때만 실행한다(떠난 화면의 맞춤이 다음 화면 카메라를 덮지 않게).
  function whenVisible(fn) {
    if (sheet.detent === 'full' && !sheet.isDesktop()) pendingFit = fn; else fn();
  }
  const always = () => true;
  function fit(latlngs, { maxZoom = 15 } = {}, alive = always) {
    if (!view || !latlngs?.length) return;
    whenVisible(() => { if (alive()) aimed(() => { aimAt = Date.now(); view?.fitBounds(latlngs, 0, { padding: padding(), maxZoom }); }); });
  }
  function focusPoint(pt, zoom, { animate = true } = {}, alive = always) {
    if (!view || !pt) return;
    let first = true;
    whenVisible(() => {
      if (!alive()) return;
      aimed(() => {
        aimAt = Date.now();
        // 다시 맞출 때는 애니메이션 없이(시트가 움직이는 동안 지도가 날아다니지 않게)
        (animate && first ? view.flyTo : view.setView).call(view, pt, zoom, { padding: padding() });
        first = false;
      });
    });
  }

  // ---------- 지도 ----------
  let view = null;
  // 첫 화면: 남한 전체가 보이도록(화면 크기·시트 높이에 맞춰). 컨트롤러가 곧 다른 곳으로 옮길 수 있다.
  // 전체 페이지(#/settings 등)로 바로 들어오면 지도는 숨겨진 0×0 상자 안에서 만들어진다 — 그 크기로 맞추면
  // 나라 가운데가 왼쪽 위 구석에 놓인다. 그래서 크기가 없으면 미뤘다가 지도가 보일 때(show) 맞춘다.
  let homeFitPending = false;
  function homeFit() {
    if (!view) return;
    homeFitPending = root.hidden || !mapNode.clientWidth;
    if (homeFitPending) return;
    aimed(() => { aimAt = Date.now(); view.fitBounds([[33.1, 125.0], [38.6, 129.6]], 0, { padding: padding(), maxZoom: 8 }); });
  }
  const mapReady = createMapView(mapNode, { center: KOREA, zoom: 7 }).then((v) => {
    view = v;
    root.dataset.provider = v.provider || 'osm';
    view.setBaseType(getMapType());
    view.onMove(onMove);
    view.onClick(onMapClick);
    walkLayer = createWalkLayer(view, { onPick: (rid) => navigate(`#/walk/${encodeURIComponent(rid)}`) });
    // 카카오 바탕지도 위에도 OpenStreetMap에서 온 선(걷기길·계산 경로·OSM 노선)을 그린다 — ODbL 출처를 지도에 늘 적는다.
    // (카카오 SDK가 지도 노드 안을 관리하므로 그 바깥, 지도 상자 위에 붙인다)
    if (v.provider === 'kakao') {
      mapHost.append(el('a', { class: 'map-attr', href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, '© OpenStreetMap'));
    }
    renderMarkers();
    if (!current || current.name === 'list') homeFit();
    onMove();
    return v;
  });

  // ---------- 산 기호(마커) ----------
  let markerOpts = { ids: null, selectedId: null, dim: false };
  const markers = new Map();
  function markerNode(m, { selected }) {
    const hiked = isHiked(m.id);
    const color = pref('regionColors') ? regionColor(m.region) : 'var(--map-ink)';
    const node = el('button', {
      type: 'button', class: 'mk' + (hiked ? ' hiked' : '') + (selected ? ' selected' : ''),
      'aria-label': `${m.name_full} ${Math.round(m.elevation_m).toLocaleString()}m${hiked ? ' 등정' : ''}`,
      dataset: { id: m.id },
    });
    node.innerHTML = summitSymbol({ hiked, color, size: selected ? 22 : 16 });
    node.append(el('span', { class: 'mk-name' }, m.name));
    guardDragClick(node);
    return node;
  }
  let clustered = false, markersStale = false;
  function renderMarkers() {
    if (!view) return;
    // 숨겨진(0×0) 지도에서는 묶음 여부(보이는 폭)를 잴 수 없다 — 다시 보일 때(onMove) 그린다.
    if (root.hidden || !mapNode.clientWidth) { markersStale = true; return; }
    markersStale = false;
    view.clearMarkers(); markers.clear();
    const { ids, selectedId } = markerOpts;
    const visible = data.mountains.filter((m) => m.lat != null && (!ids || ids.has(m.id) || m.id === selectedId));
    clustered = boundsWidthKm() > CLUSTER_KM && view.provider !== 'none';
    const groups = clustered ? clusterize(visible, selectedId) : visible.map((m) => [m]);
    for (const g of groups) {
      if (g.length === 1) {
        const m = g[0], selected = m.id === selectedId;
        const node = markerNode(m, { selected });
        const tok = view.addMarker({ lat: m.lat, lng: m.lon, node, size: [44, 44], anchor: [22, 22], zIndex: selected ? 500 : 0,
          onClick: () => onMarkerClick(m) });
        markers.set(m.id, tok);
      } else {
        const lat = g.reduce((a, m) => a + m.lat, 0) / g.length, lng = g.reduce((a, m) => a + m.lon, 0) / g.length;
        const hiked = g.filter((m) => isHiked(m.id)).length;
        const node = el('button', { type: 'button', class: 'mk-cluster', 'aria-label': `산 ${g.length}곳${hiked ? `(등정 ${hiked})` : ''} — 눌러서 확대` }, String(g.length));
        guardDragClick(node);
        view.addMarker({ lat, lng, node, size: [44, 44], anchor: [22, 22], zIndex: 100,
          onClick: () => aimed(() => { aimAt = Date.now(); view.fitBounds(g.map((m) => [m.lat, m.lon]), 0, { padding: padding(), maxZoom: 11 }); }) });
      }
    }
    root.classList.toggle('dim-mountains', !!markerOpts.dim);
  }
  /** 화면 거리 기준 묶기. 선택한 산은 묶지 않는다(늘 그 자리에 보이게). */
  function clusterize(list, selectedId) {
    const pts = list.map((m) => ({ m, p: view.project([m.lat, m.lon]) }));
    const used = new Set(), out = [];
    // 산이 많은 곳부터 씨앗이 되도록 이웃 수로 정렬 — 묶음 중심이 자연스럽게 잡힌다.
    const near = (a, b) => Math.abs(a.p.x - b.p.x) <= CLUSTER_PX && Math.abs(a.p.y - b.p.y) <= CLUSTER_PX;
    const deg = new Map(pts.map((a) => [a.m.id, pts.filter((q) => near(q, a)).length]));
    const order = pts.slice().sort((a, b) => deg.get(b.m.id) - deg.get(a.m.id));
    for (const a of order) {
      if (used.has(a.m.id)) continue;
      used.add(a.m.id);
      if (a.m.id === selectedId) { out.push([a.m]); continue; }
      const g = [a.m];
      for (const b of pts) if (!used.has(b.m.id) && b.m.id !== selectedId && near(a, b)) { used.add(b.m.id); g.push(b.m); }
      out.push(g);
    }
    return out;
  }
  function setMarkers(opts) {
    markerOpts = { ids: null, selectedId: null, dim: false, ...opts };
    renderMarkers();
  }
  function highlightMarker(id, on) {
    const e = markers.get(id)?.element?.();
    const mk = e?.classList?.contains('mk') ? e : e?.querySelector?.('.mk');
    mk?.classList.toggle('hover', on);
    markers.get(id)?.setZIndex?.(on ? 400 : (id === markerOpts.selectedId ? 500 : 0));
  }
  function onMarkerClick(m) {
    chooser.hidden = true;
    const visible = data.mountains.filter((x) => x.lat != null && (!markerOpts.ids || markerOpts.ids.has(x.id) || x.id === markerOpts.selectedId));
    const o = view.project([m.lat, m.lon]);
    const near = visible.filter((x) => { const p = view.project([x.lat, x.lon]); return Math.abs(p.x - o.x) <= 22 && Math.abs(p.y - o.y) <= 22; });
    if (near.length <= 1) { navigate(`#/m/${m.id}`); return; }
    clear(chooserList);
    near.sort((a, b) => a.name_full.localeCompare(b.name_full, 'ko')).forEach((x) => chooserList.append(
      el('a', { class: 'chooser-item', href: `#/m/${x.id}`, onClick: () => { chooser.hidden = true; } },
        el('strong', {}, x.name_full), el('span', {}, `${x.region} · ${Math.round(x.elevation_m).toLocaleString()}m`))));
    chooser.hidden = false;
    chooserList.querySelector('a')?.focus({ preventScroll: true });
  }

  // ---------- 지도 이동 → 이름 표시·걷기길 레이어 ----------
  let walkLayer = null, walkMode = 'auto';
  function boundsWidthKm() {
    const b = view.getBounds();
    return (b.east - b.west) * 111 * Math.cos(((b.north + b.south) / 2) * Math.PI / 180);
  }
  let lastZoom = null;
  function onMove() {
    // 전체 페이지로 가 지도가 숨겨진 동안에는 아무것도 하지 않는다. 숨겨진 지도는 0×0으로 다시 재지면서
    // 중심이 옛 왼쪽 위로 옮겨지고 폭이 0km로 계산된다 — 그대로 두면 걷기길 타일을 엉뚱한 곳에 요청한다.
    if (!view || root.hidden || !mapNode.clientWidth) return;
    if (!inRelayout && Date.now() - aimAt > AIM_GRACE_MS) userMoved = true;
    const w = boundsWidthKm();
    const z = view.getZoom();
    if (markersStale || z !== lastZoom) { const wasClustered = clustered; lastZoom = z; if (markersStale || wasClustered || w > CLUSTER_KM) renderMarkers(); }
    root.classList.toggle('names', pref('mountainNames') && w <= NAME_MAX_KM);
    const enabled = walkMode === 'all' || (walkMode === 'auto' && pref('walkLines'));
    walkLayer?.update({ bounds: view.getBounds(), widthKm: w, enabled, dark: isDarkTheme() });
    moveListeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  }
  const moveListeners = new Set();

  function onMapClick(pt) {
    chooser.hidden = true;
    for (const fn of clickHandlers) { try { if (fn(pt)) return; } catch (e) { console.error(e); } }
    walkLayer?.hitTest(pt);
  }
  const clickHandlers = new Set();

  // ---------- 컨트롤 ----------
  zoomIn.addEventListener('click', () => view?.zoomBy(1));
  zoomOut.addEventListener('click', () => view?.zoomBy(-1));
  const applyZoomPref = () => { zoomGroup.hidden = !pref('zoomButtons'); };
  applyZoomPref();
  layersBtn.addEventListener('click', openLayers);

  let locLayer = null, stopWatch = null;
  function toast(text, ms = 2600) {
    status.textContent = text; status.hidden = !text;
    clearTimeout(toast.t);
    if (text) toast.t = setTimeout(() => { status.hidden = true; }, ms);
  }
  function showPos(p) {
    if (!view) return;
    if (!locLayer) locLayer = view.locate();
    locLayer.set(p);
  }
  let pendingPos = null;   // 위치가 도착했을 때 지도가 숨겨져 있었다 — 다시 보일 때 점만 찍는다
  function placePos(pos) {
    showPos(pos);
    trackBtn.hidden = false;
    locateBtn.classList.add('active');
  }
  locateBtn.addEventListener('click', async () => {
    if (!geoAvailable()) { toast('이 브라우저·연결에서는 위치를 쓸 수 없습니다.'); return; }
    locateBtn.classList.add('busy'); locateBtn.setAttribute('aria-busy', 'true');
    try {
      const p = await requestPosition({ maxAgeMs: 60 * 1000 });
      const pos = { lat: p.lat, lng: p.lng ?? p.lon, accuracy: p.accuracy };
      await mapReady;
      // 기다리는 사이 전체 페이지로 떠났다 — 0×0 지도로 날아가면 계산이 깨진다(NaN). 돌아오면 점만 보여 준다.
      if (root.hidden) { pendingPos = pos; return; }
      placePos(pos);
      focusPoint([pos.lat, pos.lng], Math.max(view.getZoom(), 12));
    } catch (err) {
      // 위치 모듈의 오류(code 있음)만 그대로 보여 준다. 지도 라이브러리 내부 문구는 사용자에게 뜻이 없다.
      toast(err?.code != null && err.message ? err.message : '위치를 확인하지 못했습니다.');
    } finally { locateBtn.classList.remove('busy'); locateBtn.removeAttribute('aria-busy'); }
  });
  function stopTracking() {
    if (stopWatch) { stopWatch(); stopWatch = null; }
    trackBtn.setAttribute('aria-pressed', 'false'); trackBtn.textContent = '계속 추적';
  }
  trackBtn.addEventListener('click', () => {
    if (stopWatch) { stopTracking(); toast('위치 추적을 멈췄습니다.'); return; }
    trackBtn.setAttribute('aria-pressed', 'true'); trackBtn.textContent = '추적 중지';
    toast('이동하면 지도 위 내 위치가 따라 움직입니다.');
    stopWatch = watchPosition((p) => { showPos(p); notePosition(p); },
      (err) => { stopTracking(); toast(err.code === 1 ? '위치 권한이 거부되었습니다.' : '위치를 확인하지 못했습니다.'); });
  });
  // 다른 화면에서 위치를 새로 재면(가까운 순 등) 지도 점도 맞춘다.
  onPositionChange((p) => { if (p && locLayer) showPos({ lat: p.lat, lng: p.lng ?? p.lon, accuracy: p.accuracy }); });

  function openLayers() {
    const typeSeg = el('div', { class: 'seg wide', role: 'group', 'aria-label': '지도 종류' },
      ...MAP_TYPES.map(([k, label]) => el('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(getMapType() === k),
        onClick: (e) => { setMapType(k); view?.setBaseType(k); [...typeSeg.children].forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } }, label)));
    const sw = (key, label) => {
      const input = el('input', { type: 'checkbox', role: 'switch', checked: !!pref(key) });
      input.addEventListener('change', () => setPref(key, input.checked));
      return el('label', { class: 'switch-row' }, el('span', {}, label), input);
    };
    const dark = isDarkTheme();
    const legendRow = (style, label, dash) => el('div', { class: 'legend-row' },
      el('span', { class: 'legend-line' + (dash ? ' dash' : ''), style: `--c:${style.color};--w:${Math.min(style.weight, 5)}px` }), label);
    const legend = el('div', { class: 'legend' },
      legendRow({ color: dark ? '#e07a5f' : '#b4432b', weight: 4 }, '정상 코스 · 수록 경로'),
      legendRow({ color: dark ? '#e07a5f' : '#b4432b', weight: 4 }, '정상 코스 · 계산 경로', true),
      legendRow(kindStyle('dulle', { dark }), '둘레길·걷기길'),
      legendRow(kindStyle('dulle', { dark, long: true }), '장거리 걷기길'),
      legendRow(kindStyle('forest', { dark }), '숲길·산책로'),
      legendRow(kindStyle('ridge', { dark }), '능선 종주(대간·정맥)'),
      legendRow(kindStyle('trail', { dark }), 'OpenStreetMap 탐방로'),
      el('div', { class: 'legend-row' }, el('span', { class: 'legend-sym', html: summitSymbol({ color: 'var(--map-ink)' }) }), '산(미등정)'),
      el('div', { class: 'legend-row' }, el('span', { class: 'legend-sym', html: summitSymbol({ hiked: true, color: 'var(--map-ink)' }) }), '산(등정)'));
    const m = openModal({
      title: '지도',
      content: el('div', { class: 'layers' },
        el('h3', { class: 'mini-h' }, '지도 종류'), typeSeg,
        el('h3', { class: 'mini-h' }, '표시'),
        sw('walkLines', '걷기길 선(확대 시)'), sw('mountainNames', '산 이름'), sw('regionColors', '권역별 색 구분'),
        el('h3', { class: 'mini-h' }, '선 읽는 법'), legend,
        el('a', { class: 'text-link', href: '#/settings', onClick: () => m.close() }, '기능 설정 ›')),
    });
  }

  // ---------- 칩(찾을 대상·필터·둘레길) ----------
  let listParams = new URLSearchParams();
  function listHash(mut) {
    const p = new URLSearchParams(listParams);
    mut?.(p);
    const s = p.toString();
    return '#/map' + (s ? '?' + s : '');
  }
  function goList(mut, extra = {}) {
    const onList = current?.name === 'list';
    if (extra.openFilters) filterRequested = true;
    navigate(listHash(mut), { replace: onList });
  }
  modeMtn.addEventListener('click', () => goList((p) => { p.delete('mode'); p.delete('walkkind'); }));
  modeWalk.addEventListener('click', () => goList((p) => { p.set('mode', 'walk'); }));
  dulleChip.addEventListener('click', () => goList((p) => { p.delete('mode'); if (p.get('dulle') === '1') p.delete('dulle'); else p.set('dulle', '1'); }));
  let filterRequested = false;
  filterChip.addEventListener('click', () => {
    if (current?.name === 'list' && current.ctl?.openFilters) current.ctl.openFilters();
    else goList((p) => p.delete('mode'), { openFilters: true });
  });
  function paintChips() {
    const walk = listParams.get('mode') === 'walk';
    root.dataset.mode = walk ? 'walk' : 'mountain';
    modeMtn.setAttribute('aria-pressed', String(!walk));
    modeWalk.setAttribute('aria-pressed', String(walk));
    dulleChip.setAttribute('aria-pressed', String(listParams.get('dulle') === '1'));
    dulleChip.hidden = walk;
    const n = ['region', 'list'].reduce((a, k) => a + (listParams.get(k) ? listParams.get(k).split(',').filter(Boolean).length : 0), 0)
      + ['all', 'hiked', 'easy', 'hours', 'distance'].filter((k) => listParams.get(k)).length;
    filterChip.textContent = n ? `필터 ${n}` : '필터';
    filterChip.classList.toggle('on', n > 0);
    filterChip.hidden = walk;
  }

  // ---------- 검색 ----------
  function pickSearchItem(item) {
    // 제안에서 특정 항목을 골랐다 = 이동이지 목록 필터가 아니다. 타이핑하며 바뀐 목록 검색어를 되돌린다.
    const restored = current?.ctl?.onSearchPick?.();
    search.setValue(typeof restored === 'string' ? restored : '');
    if (item.type === 'mountain') navigate(`#/m/${item.m.id}`);
    else if (item.type === 'course') navigate(`#/m/${item.m.id}?route=${encodeURIComponent(item.key)}`);
    else if (item.type === 'walk') navigate(`#/walk/${encodeURIComponent(item.w.rid)}`);
  }
  function submitSearch(q) {
    if (current?.name === 'list' && current.ctl?.onSearchSubmit) { current.ctl.onSearchSubmit(q); return; }
    goList((p) => { p.delete('mode'); if (q) p.set('q', q); else p.delete('q'); });
  }

  // ---------- 화면 컨트롤러 ----------
  let left = null;   // 마지막으로 떠난 화면 { name, key, hadFocus } — 다음 화면이 포커스를 어디에 둘지 정할 때 쓴다
  function dispose() {
    if (!current) return;
    const c = current; current = null;
    const a = document.activeElement;
    left = { name: c.name, key: c.key, hadFocus: !!a && a !== document.body && root.contains(a) };
    c.ctx._dispose();
    try { c.ctl?.dispose?.(); } catch (e) { console.error(e); }
  }
  /**
   * 다른 화면으로 떠나는 중: 다음 화면 모듈을 받는 동안(첫 방문은 네트워크) 이전 컨트롤러가
   * URL(replaceState)·지도를 건드리지 않게 먼저 끝낸다. 같은 화면·같은 대상이면 update로 넘길 수 있게 둔다.
   */
  function leave(name, key) {
    if (current && (current.name !== name || current.key !== key)) dispose();
  }
  function makeCtx() {
    const ac = new AbortController();
    const tokens = [];
    const offs = [];
    let disposed = false;
    const ctx = {
      data, sheet, search, shell: api,
      get view() { return view; },
      signal: ac.signal,
      disposed: () => disposed,
      whenMap(fn) { mapReady.then((v) => { if (!disposed && v.ready !== false) fn(v); }).catch(() => {}); },
      layers: {
        add(t) { if (disposed) { view?.removeLayer(t); return t; } tokens.push(t); return t; },
        remove(t) { const i = tokens.indexOf(t); if (i >= 0) tokens.splice(i, 1); view?.removeLayer(t); },
        clear() { tokens.splice(0).forEach((t) => view?.removeLayer(t)); },
      },
      onMapClick(fn) { clickHandlers.add(fn); offs.push(() => clickHandlers.delete(fn)); },
      onMove(fn) { moveListeners.add(fn); offs.push(() => moveListeners.delete(fn)); },
      setMarkers, highlightMarker, padding,
      // 떠난 화면이 늦게 부른 맞춤은 무시한다 — 미뤄 둔 맞춤도 실행 직전에 다시 확인한다.
      fit(latlngs, opts) { if (!disposed) fit(latlngs, opts, () => !disposed); },
      focusPoint(pt, zoom, opts) { if (!disposed) focusPoint(pt, zoom, opts, () => !disposed); },
      /** 상단 [필터] 칩으로 포커스(조건 토큰을 모두 풀어 포커스를 둘 곳이 없어졌을 때). 숨겨져 있으면 false. */
      focusFilterChip() { if (filterChip.hidden) return false; filterChip.focus({ preventScroll: true }); return true; },
      setWalkLayerMode(mode) { walkMode = mode; onMove(); },
      setWalkHighlight(rid) { walkLayer?.setHighlight(rid); },
      /** 지도 위 가운데 동작 버튼. null이면 숨김. */
      setMapAction(o) { mapActionFn = o?.onClick || null; mapAction.textContent = o?.label || ''; mapAction.hidden = !o; },
      setContent(o) { sheet.setContent(o); },
      setListParams(p) { listParams = new URLSearchParams(p); paintChips(); },
      /** 마지막 목록 화면 URL(#/map?…) — 산·걷기길 시트의 [×]가 돌아갈 곳. */
      listHash: () => listHash(),
      consumeFilterRequest() { const v = filterRequested; filterRequested = false; return v; },
      toast,
      _dispose() {
        disposed = true; ac.abort();
        tokens.splice(0).forEach((t) => view?.removeLayer(t));
        offs.splice(0).forEach((f) => f());
        walkMode = 'auto'; walkLayer?.setHighlight(null);
        chooser.hidden = true;
        mapAction.hidden = true; mapActionFn = null;
        lastAim = null;
        pendingFit = null;   // 시트가 full이던 동안 이 화면이 미뤄 둔 맞춤 — 다음 화면에 적용되면 안 된다
      },
    };
    return ctx;
  }

  /**
   * 화면 열기. 같은 화면·같은 대상이면 컨트롤러의 update로 넘긴다(시트를 다시 만들지 않는다).
   * opts.returnFocus: 전체 페이지에서 돌아올 때 포커스를 줄 요소(true면 시트 제목).
   */
  async function open(name, key, factory, route, { returnFocus = null } = {}) {
    show();
    search.close();      // 뒤로가기 등으로 화면이 바뀌면 열려 있던 검색 제안을 닫는다
    chooser.hidden = true;
    if (current && current.name === name && current.key === key && current.ctl?.update?.(route)) return;
    dispose();
    const from = left; left = null;
    const ctx = makeCtx();
    const slot = { name, key, ctx, ctl: null };
    current = slot;
    const ctl = await factory(ctx, route);
    if (current !== slot) { try { ctl?.dispose?.(); } catch {} return; }
    slot.ctl = ctl;
    // 닫은 시트의 [×]·전체 페이지가 사라지면 포커스가 <body>로 떨어진다(화면 읽기 프로그램은 아무 말도 하지 않는다).
    // 이미 앱 안에 포커스가 있던 경우에만 되돌린다 — 첫 화면에서 포커스를 빼앗지 않게.
    // 화면 쪽 포커스 이동(제목으로)도 rAF에서 하므로 그 뒤에 확인한다.
    if (returnFocus || from?.hadFocus) requestAnimationFrame(() => placeFocus(slot, from, returnFocus));
  }
  function placeFocus(slot, from, returnFocus) {
    if (current !== slot || root.hidden) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected && (root.contains(a) || a.closest?.('dialog[open]'))) return;   // 화면이 이미 포커스를 옮겼다
    const bodyShown = sheet.isDesktop() || sheet.detent === 'half' || sheet.detent === 'full';
    let target = returnFocus instanceof Element && returnFocus.isConnected && !returnFocus.closest('[hidden]') ? returnFocus : null;
    // 산 시트를 닫고 목록으로 왔으면 그 산의 행으로(본문이 보이는 높이일 때만 — peek에서는 0px라 포커스가 보이지 않는다)
    if (!target && from?.name === 'mountain' && slot.name === 'list' && bodyShown) {
      target = sheet.body.querySelector(`a.row[data-id="${CSS.escape(from.key)}"]`);
    }
    if (!target) {
      target = sheet.head.querySelector('.sheet-title');
      if (target && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    }
    if (!target) return;
    target.focus({ preventScroll: true });
    if (sheet.body.contains(target)) {
      const r = target.getBoundingClientRect(), b = sheet.body.getBoundingClientRect();
      if (r.top < b.top || r.bottom > b.bottom) target.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---------- 보이기·숨기기(전체 페이지로 갈 때) ----------
  function show() {
    if (!root.hidden) return;
    root.hidden = false;
    // 숨겨져 있던 동안 지도 크기는 0×0으로 기억돼 있다 — 바로 다시 재야 다음 이동(flyTo)이 NaN을 내지 않는다.
    relayout();
    sheet.refresh();
    // 지도가 숨겨진 채 만들어졌다면 미뤄 둔 첫 맞춤(남한 전체). 산·걷기길 화면은 곧 자기 위치로 옮긴다.
    if (homeFitPending && (!current || current.name === 'list')) homeFit();
    requestAnimationFrame(() => {
      relayout(); sheet.refresh();
      if (root.hidden) return;
      if (pendingPos) { const p = pendingPos; pendingPos = null; placePos(p); }
      onMove();      // 숨겨진 동안 멈춰 둔 이름 표시·걷기길 선을 지금 범위로
    });
  }
  function hide() {
    dispose();
    left = null;     // 전체 페이지에서 돌아올 때의 포커스는 main.js가 정한다(returnFocus)
    stopTracking();
    root.hidden = true;
    chooser.hidden = true;
  }

  // ---------- 전역 이벤트 ----------
  const onKey = (e) => {
    // 대화상자(필터·레이어 모달, 등정 기록 같은 다른 모듈의 showModal())가 열려 있으면 Esc는 그 대화상자 몫이다.
    // 여기서 preventDefault하면 브라우저의 대화상자 닫기까지 막혀 대화상자만 남고 뒤의 시트가 닫힌다.
    if (root.hidden || e.defaultPrevented || modalOpen()) return;
    if (e.key === 'Escape') {
      if (e.isComposing || e.keyCode === 229) return;    // 한글 조합 취소 Esc는 사용자의 "닫기"가 아니다
      if (!chooser.hidden) { chooser.hidden = true; e.preventDefault(); return; }
      // 입력 중의 Esc는 입력란 몫이다. 단, 상단 검색창은 제안 닫기 → 값 지우기를 스스로 처리하고(그때는 전파를 멈춘다)
      // 지울 것이 없을 때만 넘긴다 — 그 Esc는 시트 닫기(spec 6장 "둘 다 없을 때만 기본 동작").
      if (e.target.closest?.('input, textarea, select') && e.target !== search.input) return;
      if (current?.ctl?.onEscape) { e.preventDefault(); current.ctl.onEscape(); }
    } else if (e.key === '/' && !e.target.closest?.('input, textarea, select, [contenteditable]')) {
      e.preventDefault(); search.focus();
    }
  };
  document.addEventListener('keydown', onKey);
  // 검색에서 걷기길을 바로 찾을 수 있도록 전국 걷기길 목록을 한가할 때 미리 받아 둔다.
  (window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => { loadWalkIndex().catch(() => {}); });
  window.addEventListener('kr100:theme', () => { view?.refreshTheme(); renderMarkers(); onMove(); });
  onStore(() => renderMarkers());
  onPrefs((key) => {
    if (key === 'zoomButtons' || key == null) applyZoomPref();
    if (key === 'regionColors' || key == null) renderMarkers();
    onMove();
  });

  const api = {
    root, sheet, search, data, mapReady,
    get view() { return view; },
    open, leave, hide, show, padding, fit, focusPoint, setMarkers, highlightMarker, toast,
    get current() { return current?.name || null; },
    route: currentRoute,
  };
  return api;
}
