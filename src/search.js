// 상단 통합 검색 — 명산 / 코스 / 걷기길을 묶음별로 제안한다.
// 지도 화면 어디서나 같은 입력창 하나를 쓴다(예전의 홈 검색·패널 검색·전체화면 검색을 합쳤다).
import { el, clear } from './dom.js';
import { mountainSearchText } from './data.js';
import { recentViews } from './store.js';
import { pref } from './prefs.js';
import { distanceTo } from './position.js';
import { fmtDistFine } from './geo.js';
import { icon } from './icons.js';
import { loadWalkIndex, kindLabel } from './walkdata.js';

// 랭킹: 이름 완전일치 > 접두 > 포함 > 그 밖의 필드. -1이면 비매칭.
// (목록 필터 filterMountains와 같은 필드 — 제안엔 뜨는데 목록엔 없는 산이 생기지 않게)
export function searchRank(m, q) {
  const name = m.name.toLowerCase(), full = m.name_full.toLowerCase();
  if (name === q || full === q) return 0;
  if (name.startsWith(q) || full.startsWith(q)) return 1;
  if (name.includes(q) || full.includes(q)) return 2;
  return mountainSearchText(m).includes(q) ? 3 : -1;
}

function seasonKeywords(month = new Date().getMonth()) {
  if (month >= 2 && month <= 4) return ['진달래', '철쭉', '야생화'];
  if (month >= 5 && month <= 7) return ['계곡', '폭포', '숲'];
  if (month >= 8 && month <= 10) return ['단풍', '억새'];
  return ['설경', '상고대', '일출'];
}

/** 코스 색인: 등산로(trail)와 대표 코스(famous course)를 한 목록으로. */
function buildCourseIndex(mountains) {
  const out = [];
  for (const m of mountains) {
    const linked = new Set();
    (m.famous_courses || []).forEach((c) => {
      if (c.trail_index != null) linked.add(c.trail_index);
      out.push({ type: 'course', m, key: c.trail_index != null ? `t:${c.trail_index}` : `c:${c.id}`, name: c.name,
        text: `${c.name} ${(c.via || []).join(' ')} ${m.name}`.toLowerCase() });
    });
    (m.trails || []).forEach((t, i) => {
      if (linked.has(i)) return;     // 대표 코스와 같은 행이므로 한 번만
      out.push({ type: 'course', m, key: `t:${i}`, name: t.name || '주요 코스', text: `${t.name || ''} ${t.start || ''} ${m.name}`.toLowerCase() });
    });
  }
  return out;
}

let seq = 0;

/**
 * @param {object} o
 * @param {{mountains:Array, byId:Map}} o.data
 * @param {()=>object|null} o.getPos
 * @param {(item)=>void} o.onPick       {type:'mountain',m} | {type:'course',m,key} | {type:'walk',w}
 * @param {(q:string)=>void} o.onSubmit  제안을 고르지 않고 Enter(또는 키워드 제안)
 * @param {(q:string)=>void} [o.onInput]
 */
export function createSearch({ data, getPos = () => null, onPick, onSubmit, onInput, placeholder = '산·코스·걷기길 검색' }) {
  const listId = `search-suggest-${++seq}`;
  const input = el('input', {
    class: 'tb-input', type: 'search', placeholder, 'aria-label': '산·코스·걷기길 검색',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
    autocomplete: 'off', enterkeyhint: 'search',
  });
  const box = el('div', { class: 'suggest', id: listId, role: 'listbox', 'aria-label': '검색 제안', hidden: true });
  const root = el('div', { class: 'tb-search' },
    el('span', { class: 'tb-search-ic', html: icon('search', { size: 18 }) }), input, box);
  const courses = buildCourseIndex(data.mountains);
  let walks = null;
  let options = [];   // [{item|keyword, node}]
  let idx = -1;
  let destroyed = false;
  const mq = window.matchMedia('(max-width: 1023px)');

  function close() {
    box.hidden = true; clear(box); options = []; idx = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function highlight(i) {
    idx = i;
    options.forEach((o, k) => { o.node.classList.toggle('active', k === i); o.node.setAttribute('aria-selected', String(k === i)); });
    if (i >= 0) { input.setAttribute('aria-activedescendant', options[i].node.id); options[i].node.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function addGroup(title, rows) {
    if (!rows.length) return;
    box.append(el('div', { class: 'suggest-group', role: 'presentation' }, title));
    rows.forEach((r) => {
      const i = options.length;
      const node = el('div', { class: 'suggest-item', role: 'option', id: `${listId}-${i}`, 'aria-selected': 'false' },
        el('span', { class: 'si-name' }, r.title, r.tag ? el('span', { class: 'si-tag' }, r.tag) : null),
        r.meta ? el('span', { class: 'si-meta' }, r.meta) : null);
      node.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      node.addEventListener('mousemove', () => { if (idx !== i) highlight(i); });
      options.push({ ...r, node });
      box.append(node);
    });
  }
  function open() {
    if (!box.children.length) { close(); return; }
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function renderEmpty() {
    clear(box); options = []; idx = -1;
    if (pref('recentMountains')) {
      const recent = recentViews().map((id) => data.byId.get(id)).filter(Boolean).slice(0, 5);
      addGroup('최근 본 산', recent.map((m) => ({ item: { type: 'mountain', m }, title: m.name, tag: m.disambig, meta: `${m.region} · ${Math.round(m.elevation_m).toLocaleString()}m` })));
    }
    if (pref('recommendations')) {
      addGroup('지금 계절', seasonKeywords().map((k) => ({ keyword: k, title: k, meta: '이 단어로 찾기' })));
    }
    open();
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    if (!q) { renderEmpty(); return; }
    clear(box); options = []; idx = -1;
    const pos = getPos();
    const ms = data.mountains.map((m) => ({ m, r: searchRank(m, q) })).filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || (pos ? distanceTo(pos, a.m.lat, a.m.lon) - distanceTo(pos, b.m.lat, b.m.lon) : 0) || a.m.name.localeCompare(b.m.name, 'ko'))
      .slice(0, 5);
    addGroup('명산', ms.map(({ m }) => {
      const d = pos ? distanceTo(pos, m.lat, m.lon) : Infinity;
      return { item: { type: 'mountain', m }, title: m.name, tag: m.disambig,
        meta: [m.province, `${Math.round(m.elevation_m).toLocaleString()}m`, Number.isFinite(d) ? fmtDistFine(d) : null].filter(Boolean).join(' · ') };
    }));
    const cs = courses.filter((c) => c.text.includes(q)).slice(0, 4);
    addGroup('코스', cs.map((c) => ({ item: c, title: c.name, meta: c.m.name_full })));
    if (walks) {
      const ws = walks.filter((w) => w.name.toLowerCase().includes(q)).slice(0, 4);
      addGroup('걷기길', ws.map((w) => ({ item: { type: 'walk', w }, title: w.name, meta: [kindLabel(w), w.km ? `${w.km}km` : null].filter(Boolean).join(' · ') })));
    }
    if (!options.length) box.append(el('p', { class: 'suggest-empty', role: 'status' }, '맞는 산·코스·걷기길이 없습니다.'));
    open();
  }

  function choose(i) {
    const o = options[i];
    if (!o) return;
    close();
    if (mq.matches) input.blur();   // 모바일은 키보드를 내린다. 데스크톱은 포커스를 지킨다.
    if (o.keyword) { input.value = o.keyword; onInput?.(o.keyword); onSubmit?.(o.keyword); return; }
    onPick?.(o.item);
  }

  function ensureWalks() {
    if (walks) return;
    loadWalkIndex().then((w) => { if (destroyed) return; walks = w || []; if (document.activeElement === input && input.value.trim()) render(); }).catch(() => { walks = []; });
  }

  input.addEventListener('input', () => { onInput?.(input.value); render(); });
  input.addEventListener('search', () => { onInput?.(input.value); render(); });  // 네이티브 지우기
  input.addEventListener('focus', () => { ensureWalks(); render(); });
  input.addEventListener('blur', () => setTimeout(() => { if (!destroyed && document.activeElement !== input) close(); }, 150));
  input.addEventListener('keydown', (e) => {
    // 한글 IME 조합 중 Enter는 "조합 확정"이다 — 제안 선택·제출로 처리하면 안 된다.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (box.hidden) { render(); return; }
      if (!options.length) return;
      e.preventDefault();
      const n = options.length;
      highlight(e.key === 'ArrowDown' ? (idx + 1) % n : (idx - 1 + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!box.hidden && idx >= 0) choose(idx);
      else { close(); if (mq.matches) input.blur(); onSubmit?.(input.value.trim()); }
    } else if (e.key === 'Escape') {
      // 2단계: 제안 닫기 → 값 지우기. 둘 다 없으면 막지 않는다(상위가 시트 닫기 등에 쓴다).
      if (!box.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
      else if (input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; onInput?.(''); }
    }
  });

  return {
    root, input, close,
    setValue(v) { input.value = v || ''; },
    focus() { input.focus(); },
    destroy() { destroyed = true; close(); },
  };
}
