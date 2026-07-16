import { loadData, filterMountains, REGION_COLORS, regionColor, LIST_KEYS, LIST_META } from '../data.js';
import { createMapView, popupContent } from '../map.js';
import { mapControls } from '../mapcontrols.js';
import { isHiked, toggleHiked, onChange } from '../store.js';
import { el, clear, esc } from '../dom.js';

const REGIONS = ['수도권', '강원', '충청', '전라', '경상', '제주'];

// URL 쿼리(#/map?region=강원&list=bac&q=설악&hiked=1)에서 초기 필터 상태를 읽는다.
function parseQuery() {
  const p = new URLSearchParams(location.hash.split('?')[1] || '');
  const csv = (k) => (p.get(k) ? p.get(k).split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    q: p.get('q') || '',
    regions: new Set(csv('region').filter((r) => REGIONS.includes(r))),
    lists: new Set(csv('list').filter((k) => LIST_KEYS.includes(k))),
    allFour: p.get('all') === '4',
    hikedOnly: p.get('hiked') === '1',
    focus: p.get('focus') || null,
  };
}

export async function renderExplore(root) {
  const data = await loadData();
  const init = parseQuery();
  const state = { q: init.q, regions: init.regions, lists: init.lists, allFour: init.allFour, hikedOnly: init.hikedOnly, activeId: null };

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
    el('div', { class: 'filters' }, search, regionChips, listChips,
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
  let locDot = null;

  // ---- 현재 위치 (Geolocation) ----
  locateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) { locateBtn.textContent = '⚠️'; setTimeout(() => (locateBtn.textContent = '📍'), 1500); return; }
    locateBtn.classList.add('loading'); locateBtn.textContent = '⏳';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        if (locDot) view.removeLayer(locDot);
        locDot = view.addDot({ lat, lng, color: '#1a73e8', title: '현재 위치' });
        view.flyTo ? view.flyTo([lat, lng], 11) : view.setView([lat, lng], 11);
        locateBtn.classList.remove('loading'); locateBtn.textContent = '📍';
      },
      (err) => {
        locateBtn.classList.remove('loading');
        locateBtn.textContent = err.code === err.PERMISSION_DENIED ? '🚫' : '⚠️';
        setTimeout(() => (locateBtn.textContent = '📍'), 1800);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
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
    list.forEach((m) => {
      const item = el('a', {
        class: 'mtn-item' + (m.id === state.activeId ? ' active' : ''),
        href: `#/m/${m.id}`, dataset: { id: m.id },
        'aria-label': `${m.name_full} 상세`, 'aria-current': m.id === state.activeId ? 'true' : null,
      },
        el('span', { class: 'mtn-rank', style: `background:${REGION_COLORS[m.region]}` }),
        el('div', { class: 'mtn-body' },
          el('div', { class: 'mtn-name' }, m.name,
            m.disambig ? el('span', { class: 'disambig' }, m.disambig) : null,
            isHiked(m.id) ? el('span', { class: 'hiked-star', title: '등정 완료' }, '★') : null),
          el('div', { class: 'mtn-meta' },
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
    const list = filterMountains(data.mountains, { ...state, isHiked });
    countEl.textContent = `${list.length}곳`;
    renderList(list);
    renderMarkers(list);
  }

  update();
  const offStore = onChange(update);
  const onTheme = () => view.refreshTheme();
  window.addEventListener('kr100:theme', onTheme);

  // deep-link ?focus=id
  if (init.focus && data.byId.has(init.focus)) setTimeout(() => focus(data.byId.get(init.focus)), 100);

  return () => { offStore(); window.removeEventListener('kr100:theme', onTheme); controls.cleanup?.(); view.destroy(); };
}
