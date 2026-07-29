import { loadData, filterMountains, REGION_COLORS, regionColor, LIST_KEYS, LIST_META } from '../data.js';
import { createMapView, popupContent } from '../map.js';
import { mapControls } from '../mapcontrols.js';
import { isHiked, toggleHiked, onChange } from '../store.js';
import { watchPosition, fmtDistFine } from '../geo.js';
import { cachedPosition, requestPosition, notePosition, onPositionChange, permissionState,
  geoAvailable, distanceTo, bearingLabel, positionAgeText, sortByDistance, FRESH_MS } from '../position.js';
import { el, clear, esc } from '../dom.js';

const REGIONS = ['수도권', '강원', '충청', '전라', '경상', '제주'];
// 가까운 순 정렬 중 이만큼 이동하면 목록을 다시 정렬한다(스크롤 중 잦은 재정렬 방지).
const RESORT_MOVE_M = 500;

// URL 쿼리(#/map?region=강원&list=bac&q=설악&hiked=1&sort=near)에서 초기 필터 상태를 읽는다.
function parseQuery() {
  const p = new URLSearchParams(location.hash.split('?')[1] || '');
  const csv = (k) => (p.get(k) ? p.get(k).split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    q: p.get('q') || '',
    regions: new Set(csv('region').filter((r) => REGIONS.includes(r))),
    lists: new Set(csv('list').filter((k) => LIST_KEYS.includes(k))),
    allFour: p.get('all') === '4',
    hikedOnly: p.get('hiked') === '1',
    sort: p.get('sort') === 'near' ? 'near' : 'default',
    focus: p.get('focus') || null,
  };
}

export async function renderExplore(root) {
  const data = await loadData();
  const init = parseQuery();
  const state = { q: init.q, regions: init.regions, lists: init.lists, allFour: init.allFour, hikedOnly: init.hikedOnly, sort: 'default', activeId: null };
  let pos = cachedPosition();      // 목록 정렬·거리 표시에 쓰는 기준 위치
  let sortAnchor = null;           // 마지막으로 정렬한 시점의 위치(이동 재정렬 판단용)
  let disposed = false;            // 라우트 이탈 뒤 늦게 resolve되는 콜백이 파괴된 지도를 건드리지 않게
  let selfRequest = false;         // 내가 요청한 측정의 emit으로 이중 렌더되지 않게

  // ---- layout ----
  const search = el('input', { class: 'search', type: 'search', 'aria-label': '산 이름 또는 지역 검색', placeholder: '산 이름·지역 검색 (예: 설악, 지리, 경남)', value: state.q });
  const regionChips = el('div', { class: 'chips' });
  const listChips = el('div', { class: 'chips', 'aria-label': '명산 리스트' });
  const allFourChip = el('button', { class: 'chip', 'aria-pressed': String(state.allFour), title: '4개 리스트 모두에 든 산' }, '★ 4대 공통');
  const hikedChip = el('button', { class: 'chip', 'aria-pressed': String(state.hikedOnly) }, '⛰ 등정한 산만');
  const countEl = el('span', { 'aria-live': 'polite' });
  const resetBtn = el('button', {}, '필터 초기화');
  const listEl = el('div', { class: 'mtn-list' });
  const mapNode = el('div', { id: 'map' });

  // ---- 정렬(기본순 / 가까운 순) ----
  const sortDefaultBtn = el('button', { type: 'button', 'aria-pressed': 'true' }, '기본순');
  const sortNearBtn = el('button', { type: 'button', 'aria-pressed': 'false' }, '📍 가까운 순');
  const sortSeg = el('div', { class: 'seg sort-seg', role: 'group', 'aria-label': '목록 정렬' }, sortDefaultBtn, sortNearBtn);
  const geoNote = el('div', { class: 'geo-note', role: 'status', hidden: true });

  REGIONS.forEach((r) => {
    const chip = el('button', { class: 'chip', 'aria-pressed': String(state.regions.has(r)), dataset: { region: r } },
      el('span', { class: 'dot', style: `background:${REGION_COLORS[r]}` }), r);
    chip.addEventListener('click', () => {
      state.regions.has(r) ? state.regions.delete(r) : state.regions.add(r);
      chip.setAttribute('aria-pressed', state.regions.has(r));
      update();
    });
    regionChips.append(chip);
  });

  LIST_KEYS.forEach((k) => {
    const chip = el('button', { class: `chip list-${k}`, 'aria-pressed': String(state.lists.has(k)), dataset: { list: k } }, LIST_META[k].chip);
    chip.addEventListener('click', () => {
      state.lists.has(k) ? state.lists.delete(k) : state.lists.add(k);
      chip.setAttribute('aria-pressed', String(state.lists.has(k)));
      update();
    });
    listChips.append(chip);
  });

  allFourChip.addEventListener('click', () => {
    state.allFour = !state.allFour;
    allFourChip.setAttribute('aria-pressed', String(state.allFour));
    update();
  });
  hikedChip.addEventListener('click', () => {
    state.hikedOnly = !state.hikedOnly;
    hikedChip.setAttribute('aria-pressed', String(state.hikedOnly));
    update();
  });
  search.addEventListener('input', () => { state.q = search.value; update(); });
  resetBtn.addEventListener('click', () => {
    state.q = ''; state.regions.clear(); state.lists.clear(); state.allFour = false; state.hikedOnly = false;
    search.value = '';
    [...regionChips.children, ...listChips.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
    allFourChip.setAttribute('aria-pressed', 'false');
    hikedChip.setAttribute('aria-pressed', 'false');
    update();
  });

  const panel = el('aside', { class: 'panel' },
    el('div', { class: 'filters' }, search, sortSeg, geoNote, regionChips, listChips,
      el('div', { class: 'chips', style: 'margin-top:8px' }, allFourChip, hikedChip),
      el('div', { class: 'filters-foot' }, countEl, resetBtn)),
    listEl);

  const legend = el('div', { class: 'map-legend' },
    ...REGIONS.map((r) => el('div', { class: 'row' },
      el('span', { class: 'dot', style: `background:${REGION_COLORS[r]}` }), r)),
    el('div', { class: 'row' }, el('span', { class: 'hiked-star' }, '★'), '등정 완료'));

  // 현재 위치 버튼
  const locateBtn = el('button', { class: 'locate-btn', type: 'button', title: '내 위치 표시', 'aria-label': '내 위치 표시' }, '📍');

  const mapWrap = el('div', { class: 'map-wrap' }, mapNode, legend, locateBtn);
  const homeEl = el('div', { class: 'home', dataset: { view: 'list' } }, panel, mapWrap);
  root.append(homeEl);
  const mq = window.matchMedia('(max-width: 860px)');

  // ---- map ----
  const view = await createMapView(mapNode, { center: [36.5, 127.9], zoom: 7 });
  const controls = mapControls(view, mapWrap);
  mapWrap.append(controls);
  const markers = new Map();

  // ---- 현재 위치 실시간 추적 (Geolocation watchPosition) ----
  const locLayer = view.locate();
  let locShown = false;             // 지도에 내 위치 점이 그려져 있는지
  let stopWatch = null, firstFix = true;
  const showLoc = (p) => { locLayer.set(p); locShown = true; };
  locateBtn.addEventListener('click', () => {
    if (stopWatch) {
      stopWatch(); stopWatch = null; firstFix = true;
      locateBtn.classList.remove('active'); locateBtn.textContent = '📍';
      if (state.sort !== 'near') { locLayer.remove(); locShown = false; }  // 가까운 순일 땐 기준점 표시 유지
      return;
    }
    locateBtn.classList.add('loading'); locateBtn.textContent = '⏳';
    stopWatch = watchPosition(
      (p) => {
        showLoc(p);
        notePosition(p);            // 다른 화면(홈 "내 주변" 등)도 같은 위치를 쓰도록 캐시
        if (firstFix) { firstFix = false; (view.flyTo ? view.flyTo : view.setView).call(view, [p.lat, p.lng], 13); }
        locateBtn.classList.remove('loading'); locateBtn.classList.add('active'); locateBtn.textContent = '🎯';
      },
      (err) => {
        if (stopWatch) { stopWatch(); stopWatch = null; }
        if (state.sort !== 'near') { locLayer.remove(); locShown = false; }
        locateBtn.classList.remove('loading', 'active');
        locateBtn.textContent = err.code === 1 ? '🚫' : '⚠️';
        setTimeout(() => (locateBtn.textContent = '📍'), 1800);
      },
    );
  });

  // ---- 가까운 순 정렬 ----
  function paintSort() {
    sortDefaultBtn.setAttribute('aria-pressed', String(state.sort !== 'near'));
    sortNearBtn.setAttribute('aria-pressed', String(state.sort === 'near'));
  }
  function setNote(text, kind) {
    geoNote.className = 'geo-note' + (kind ? ' ' + kind : '');
    clear(geoNote);
    if (!text) { geoNote.hidden = true; return; }
    geoNote.hidden = false;
    geoNote.append(text);
  }
  function nearStatusNote() {
    if (state.sort !== 'near' || !pos) return;
    setNote(`현재 위치 기준 · ${positionAgeText(pos.ts)} 측정`, 'ok');
  }

  // 활성화. 캐시가 있으면 기다리지 않고 즉시 정렬해 보여준 뒤, 오래됐을 때만 백그라운드로 갱신한다.
  // (실내에서 GPS 측정이 실패하더라도 멀쩡한 직전 위치 기준 정렬은 유지된다)
  // 권한 프롬프트는 캐시가 없을 때, 사용자가 직접 눌러 호출했을 때만 뜬다.
  function applyNear(p, doFit) {
    pos = p; sortAnchor = p; state.sort = 'near';
    paintSort(); showLoc(p); update();
    if (doFit) fitToNearest();
  }
  async function activateNear({ fit = true } = {}) {
    if (!geoAvailable()) { setNote('이 브라우저·연결에서는 위치 기능을 사용할 수 없습니다.', 'warn'); return; }
    const cached = cachedPosition();
    if (cached) {
      applyNear(cached, fit);
      if (Date.now() - cached.ts <= FRESH_MS) { nearStatusNote(); return; }   // 충분히 최신 → 재측정 불필요
      setNote(`${positionAgeText(cached.ts)} 측정한 위치 기준 · 갱신 중…`, 'busy');
    } else {
      sortNearBtn.disabled = true;
      setNote('현재 위치를 확인하는 중…', 'busy');
    }
    try {
      selfRequest = true;
      const fresh = await requestPosition({ maxAgeMs: cached ? 0 : FRESH_MS });
      if (disposed) return;
      if (state.sort === 'near' || !cached) {   // 갱신 중 사용자가 기본순으로 돌아갔으면 되살리지 않는다
        applyNear(fresh, fit && !cached);       // 캐시로 이미 맞춘 지도는 다시 움직이지 않는다
        nearStatusNote();
      }
    } catch (err) {
      if (disposed) return;
      if (cached) setNote(`${positionAgeText(cached.ts)} 측정한 위치 기준 · 갱신하지 못했습니다.`, 'warn');
      else { state.sort = 'default'; paintSort(); setNote(err.message, 'warn'); }
    } finally {
      selfRequest = false;
      if (!disposed) sortNearBtn.disabled = false;
    }
  }

  // 내 위치 + 가장 가까운 산 몇 곳이 함께 보이도록 지도 범위를 맞춘다.
  function fitToNearest(n = 5) {
    if (!pos) return;
    const near = sortByDistance(
      filterMountains(data.mountains, { ...state, isHiked }).filter((m) => m.lat != null), pos).slice(0, n);
    if (!near.length) { (view.flyTo ? view.flyTo : view.setView).call(view, [pos.lat, pos.lng], 11); return; }
    view.fitBounds([[pos.lat, pos.lng], ...near.map(({ m }) => [m.lat, m.lon])], 0.18);
  }

  sortNearBtn.addEventListener('click', () => { if (state.sort !== 'near') activateNear(); });
  sortDefaultBtn.addEventListener('click', () => {
    if (state.sort === 'default') return;
    state.sort = 'default'; paintSort(); setNote(null);
    if (!stopWatch && locShown) { locLayer.remove(); locShown = false; }
    update();
  });

  // 실시간 추적으로 위치가 크게 바뀌면 다시 정렬한다.
  const offPos = onPositionChange((p) => {
    if (!p || disposed || selfRequest) return;   // selfRequest: activateNear가 곧 직접 반영한다
    pos = p;
    if (state.sort !== 'near') return;
    if (sortAnchor && distanceTo(sortAnchor, p.lat, p.lng) < RESORT_MOVE_M) return;
    sortAnchor = p; update(); nearStatusNote();
  });

  function focus(m, { pan = true, scroll = true } = {}) {
    state.activeId = m.id;
    [...listEl.querySelectorAll('.mtn-item')].forEach((n) =>
      n.classList.toggle('active', n.dataset.id === m.id));
    markers.get(m.id)?.openPopup();
    if (pan && m.lat != null) view.panTo([m.lat, m.lon]);
    if (scroll) listEl.querySelector('.mtn-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  function renderMarkers(list) {
    view.clearMarkers();
    markers.clear();
    list.forEach((m) => {
      if (m.lat == null) return;
      const mk = view.addMarker({
        lat: m.lat, lng: m.lon, color: regionColor(m.region), star: isHiked(m.id),
        popupHTML: popupContent(m), onClick: () => focus(m, { pan: false }),
      });
      markers.set(m.id, mk);
    });
  }

  function renderList(list) {
    clear(listEl);
    if (!list.length) { listEl.append(el('div', { class: 'empty' }, '조건에 맞는 산이 없습니다.')); return; }
    const near = state.sort === 'near' && !!pos;
    list.forEach((m, i) => {
      const d = pos ? distanceTo(pos, m.lat, m.lon) : Infinity;
      const item = el('a', {
        class: 'mtn-item' + (m.id === state.activeId ? ' active' : ''),
        href: `#/m/${m.id}`, dataset: { id: m.id },
        'aria-label': `${m.name_full} 상세`, 'aria-current': m.id === state.activeId ? 'true' : null,
      },
        near
          ? el('span', { class: 'mtn-rank num', style: `background:${REGION_COLORS[m.region]}` }, String(i + 1))
          : el('span', { class: 'mtn-rank', style: `background:${REGION_COLORS[m.region]}` }),
        el('div', { class: 'mtn-body' },
          el('div', { class: 'mtn-name' }, m.name,
            m.disambig ? el('span', { class: 'disambig' }, m.disambig) : null,
            isHiked(m.id) ? el('span', { class: 'hiked-star', title: '등정 완료' }, '★') : null),
          el('div', { class: 'mtn-meta' },
            Number.isFinite(d)
              ? el('span', { class: 'mtn-dist', title: '현재 위치에서의 직선거리' }, `📍 ${bearingLabel(pos, m.lat, m.lon)} ${fmtDistFine(d)}`)
              : null,
            el('span', {}, `${Math.round(m.elevation_m)}m`),
            el('span', {}, m.province))),
        el('div', { class: 'mtn-badges' },
          ...LIST_KEYS.filter((k) => m.lists[k]).map((k) =>
            el('span', { class: `badge b-${k}`, title: LIST_META[k].full }, LIST_META[k].badge))),
        el('span', { class: 'mtn-go', 'aria-hidden': 'true' }, '›'));
      if (!mq.matches) item.addEventListener('mouseenter', () => focus(m, { scroll: false }));
      listEl.append(item);
    });
  }

  function update() {
    let list = filterMountains(data.mountains, { ...state, isHiked });
    if (state.sort === 'near' && pos) list = sortByDistance(list, pos).map((x) => x.m);
    countEl.textContent = `${list.length}곳` + (state.sort === 'near' && pos ? ' · 가까운 순' : '');
    renderList(list);
    renderMarkers(list);
  }

  paintSort();
  update();
  const offStore = onChange(update);
  const onTheme = () => view.refreshTheme();
  window.addEventListener('kr100:theme', onTheme);

  // deep-link ?sort=near — 이미 위치를 알고 있으면 바로 정렬하고,
  // 모르면 권한 프롬프트를 갑자기 띄우지 않고 버튼을 눌러달라고 안내한다.
  if (init.sort === 'near') {
    if (pos) activateNear();
    else if (geoAvailable()) {
      permissionState().then((s) => {
        if (disposed) return;
        if (s === 'granted') activateNear();
        else setNote('‘📍 가까운 순’을 누르면 현재 위치를 확인해 가까운 산부터 보여드려요.', null);
      });
    }
  }

  // deep-link ?focus=id
  if (init.focus && data.byId.has(init.focus)) setTimeout(() => focus(data.byId.get(init.focus)), 100);

  return () => {
    disposed = true;
    if (stopWatch) stopWatch();
    offStore(); offPos();
    window.removeEventListener('kr100:theme', onTheme);
    controls.cleanup?.(); view.destroy();
  };
}
