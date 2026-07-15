import { loadData, filterMountains, REGION_COLORS, regionColor } from '../data.js';
import { createMapView, popupContent } from '../map.js';
import { mapControls } from '../mapcontrols.js';
import { isHiked, toggleHiked, onChange } from '../store.js';
import { el, clear, esc } from '../dom.js';

const REGIONS = ['수도권', '강원', '충청', '전라', '경상', '제주'];

export async function renderHome(root) {
  const data = await loadData();
  const state = { q: '', regions: new Set(), list: 'all', hikedOnly: false, activeId: null };

  // ---- layout ----
  const search = el('input', { class: 'search', type: 'search', 'aria-label': '산 이름 또는 지역 검색', placeholder: '산 이름·지역 검색 (예: 설악, 지리, 경남)' });
  const regionChips = el('div', { class: 'chips' });
  const listSeg = el('div', { class: 'seg' });
  const hikedChip = el('button', { class: 'chip', 'aria-pressed': 'false' }, '⛰ 등정한 산만');
  const countEl = el('span', { 'aria-live': 'polite' });
  const resetBtn = el('button', {}, '필터 초기화');
  const listEl = el('div', { class: 'mtn-list' });
  const mapNode = el('div', { id: 'map' });

  REGIONS.forEach((r) => {
    const chip = el('button', { class: 'chip', 'aria-pressed': 'false', dataset: { region: r } },
      el('span', { class: 'dot', style: `background:${REGION_COLORS[r]}` }), r);
    chip.addEventListener('click', () => {
      state.regions.has(r) ? state.regions.delete(r) : state.regions.add(r);
      chip.setAttribute('aria-pressed', state.regions.has(r));
      update();
    });
    regionChips.append(chip);
  });

  [['all', '전체'], ['both', '공통'], ['sanlim', '산림청'], ['bac', 'BAC']].forEach(([v, label]) => {
    const b = el('button', { 'aria-pressed': String(v === 'all'), dataset: { list: v } }, label);
    b.addEventListener('click', () => {
      state.list = v;
      [...listSeg.children].forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.list === v)));
      update();
    });
    listSeg.append(b);
  });

  hikedChip.addEventListener('click', () => {
    state.hikedOnly = !state.hikedOnly;
    hikedChip.setAttribute('aria-pressed', String(state.hikedOnly));
    update();
  });
  search.addEventListener('input', () => { state.q = search.value; update(); });
  resetBtn.addEventListener('click', () => {
    state.q = ''; state.regions.clear(); state.list = 'all'; state.hikedOnly = false;
    search.value = '';
    [...regionChips.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
    [...listSeg.children].forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.list === 'all')));
    hikedChip.setAttribute('aria-pressed', 'false');
    update();
  });

  const panel = el('aside', { class: 'panel' },
    el('div', { class: 'filters' }, search, regionChips, listSeg,
      el('div', { style: 'margin-top:10px' }, hikedChip),
      el('div', { class: 'filters-foot' }, countEl, resetBtn)),
    listEl);

  const legend = el('div', { class: 'map-legend' },
    ...REGIONS.map((r) => el('div', { class: 'row' },
      el('span', { class: 'dot', style: `background:${REGION_COLORS[r]}` }), r)),
    el('div', { class: 'row' }, el('span', { class: 'hiked-star' }, '★'), '등정 완료'));

  const mapWrap = el('div', { class: 'map-wrap' }, mapNode, legend);
  const homeEl = el('div', { class: 'home', dataset: { view: 'list' } }, panel, mapWrap);
  root.append(homeEl);
  const mq = window.matchMedia('(max-width: 860px)');

  // ---- map ----
  const view = await createMapView(mapNode, { center: [36.5, 127.9], zoom: 7 });
  const controls = mapControls(view, mapWrap);
  mapWrap.append(controls);
  const markers = new Map();

  // mobile 목록 ↔ 지도 전환 (좁은 화면에서 각 뷰가 전체 높이 사용)
  const viewToggle = el('button', { class: 'view-toggle', type: 'button' }, '🗺️ 지도 보기');
  viewToggle.addEventListener('click', () => {
    const next = homeEl.dataset.view === 'list' ? 'map' : 'list';
    homeEl.dataset.view = next;
    viewToggle.textContent = next === 'list' ? '🗺️ 지도 보기' : '☰ 목록 보기';
    if (next === 'map') setTimeout(() => view.relayout(), 60);
  });
  root.append(viewToggle);

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
      // 항목 전체가 상세로 가는 실제 링크 → 탭/키보드/스크린리더 모두 자연스럽게 동작.
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
          m.lists.sanlim ? el('span', { class: 'badge sanlim' }, '산림청') : null,
          m.lists.bac ? el('span', { class: 'badge bac' }, 'BAC') : null),
        el('span', { class: 'mtn-go', 'aria-hidden': 'true' }, '›'));
      // 넓은 화면: 마우스 오버 시 지도에서 위치 미리보기(내비게이션은 클릭=상세).
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
  const focusId = new URLSearchParams(location.hash.split('?')[1] || '').get('focus');
  if (focusId && data.byId.has(focusId)) setTimeout(() => focus(data.byId.get(focusId)), 100);

  return () => { offStore(); window.removeEventListener('kr100:theme', onTheme); controls.cleanup?.(); view.destroy(); };
}
