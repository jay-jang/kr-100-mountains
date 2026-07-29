// 산 검색 콤보박스 — 지도 페이지 패널과 전체화면 오버레이가 함께 쓰는 단일 구현.
// 타이핑은 onInput으로 넘기고(목록 필터 등 화면별 처리), 제안을 고르면 onPick으로 알린다.
import { el, clear } from './dom.js';
import { REGION_COLORS } from './data.js';
import { fmtDistFine } from './geo.js';
import { distanceTo } from './position.js';

let seq = 0;   // 인스턴스가 공존해도 aria id가 겹치지 않게

// 랭킹: 이름 완전일치 > 이름 접두 > 이름 포함 > 소재지·지역 포함. -1이면 비매칭.
// 매칭 필드는 data.js의 filterMountains와 동일하게 유지한다
// (다르면 "제안에는 뜨는데 목록에는 없는" 산이 생긴다).
export function searchRank(m, q) {
  const name = m.name.toLowerCase(), full = m.name_full.toLowerCase();
  if (name === q || full === q) return 0;
  if (name.startsWith(q) || full.startsWith(q)) return 1;
  if (name.includes(q) || full.includes(q)) return 2;
  return `${m.province} ${m.location} ${m.id}`.toLowerCase().includes(q) ? 3 : -1;
}

/**
 * @param {object} o
 * @param {Array} o.mountains  검색 대상(필터와 무관하게 전체 — 검색으로는 어떤 산이든 갈 수 있어야 한다)
 * @param {()=>object|null} o.getPos  거리 표시용 현재 위치
 * @param {(m)=>void} o.onPick  제안 선택
 * @param {(v:string)=>void} [o.onInput]  입력값 변경(타이핑·네이티브 지우기·Esc 비우기)
 * @returns {{root, input, close, setValue, focus, destroy}}
 */
export function mountainSearch({
  mountains, getPos = () => null, onPick, onInput,
  placeholder = '산 이름·지역 검색 (예: 설악, 지리, 경남)',
  ariaLabel = '산 이름 또는 지역 검색',
  value = '', limit = 8, className = '',
}) {
  const listId = `mtn-suggest-${++seq}`;
  const input = el('input', {
    class: 'search', type: 'search', 'aria-label': ariaLabel, placeholder, value,
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
    'aria-controls': listId, autocomplete: 'off',
  });
  const box = el('div', { class: 'map-suggest', role: 'listbox', id: listId, 'aria-label': '검색 제안', hidden: true });
  const root = el('div', { class: 'search-wrap' + (className ? ' ' + className : '') }, input, box);
  const mq = window.matchMedia('(max-width: 860px)');

  let items = [];        // [{ m, node }]
  let idx = -1;
  let destroyed = false;

  function close() {
    box.hidden = true; clear(box); items = []; idx = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function highlight(i) {
    idx = i;
    items.forEach((s, k) => {
      s.node.classList.toggle('active', k === i);
      s.node.setAttribute('aria-selected', String(k === i));
    });
    if (i >= 0) {
      input.setAttribute('aria-activedescendant', items[i].node.id);
      items[i].node.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    clear(box); items = []; idx = -1;
    if (!q) { close(); return; }
    const pos = getPos();
    const hits = mountains
      .map((m) => ({ m, r: searchRank(m, q) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => (a.r - b.r)
        || (pos ? distanceTo(pos, a.m.lat, a.m.lon) - distanceTo(pos, b.m.lat, b.m.lon) : 0)
        || a.m.name.localeCompare(b.m.name, 'ko'))
      .slice(0, limit);
    if (!hits.length) { close(); return; }
    hits.forEach(({ m }, i) => {
      const d = pos ? distanceTo(pos, m.lat, m.lon) : Infinity;
      const node = el('div', { class: 'map-suggest-item', role: 'option', id: `${listId}-${i}`, 'aria-selected': 'false' },
        el('span', { class: 'ms-dot', style: `background:${REGION_COLORS[m.region]}` }),
        el('span', { class: 'ms-name' }, m.name,
          m.disambig ? el('span', { class: 'disambig' }, m.disambig) : null),
        el('span', { class: 'ms-meta' }, `${m.province} · ${Math.round(m.elevation_m)}m`),
        Number.isFinite(d) ? el('span', { class: 'ms-dist' }, fmtDistFine(d)) : null);
      node.addEventListener('mousedown', (e) => { e.preventDefault(); pick(m); });  // blur보다 먼저 처리
      node.addEventListener('mouseenter', () => highlight(i));
      items.push({ m, node });
      box.append(node);
    });
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function pick(m) {
    close();
    // 모바일은 소프트 키보드를 내린다. 데스크톱은 포커스를 유지해야
    // 키보드 사용자가 Enter 선택 후 위치를 잃지 않는다.
    if (mq.matches) input.blur();
    onPick?.(m);
  }

  const emitInput = () => { onInput?.(input.value); render(); };
  input.addEventListener('input', emitInput);
  // type=search의 네이티브 "지우기"(× 버튼 등)도 상태와 어긋나지 않게 동기화한다.
  input.addEventListener('search', emitInput);
  input.addEventListener('focus', () => { if (input.value.trim()) render(); });
  input.addEventListener('blur', () => setTimeout(() => { if (!destroyed) close(); }, 120));
  input.addEventListener('keydown', (e) => {
    // 한글 IME 조합 중의 Enter는 "조합 확정"이지 제안 선택이 아니다(조합 중 keydown은 isComposing/keyCode 229).
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (box.hidden || !items.length) { if (input.value.trim()) render(); return; }
      e.preventDefault();
      const n = items.length;
      highlight(e.key === 'ArrowDown' ? (idx + 1) % n : (idx - 1 + n) % n);
    } else if (e.key === 'Enter') {
      if (!box.hidden && items.length) { e.preventDefault(); pick(items[Math.max(0, idx)].m); }
    } else if (e.key === 'Escape') {
      // type=search는 Esc에서 브라우저가 값을 지워 버린다 → 우리가 처리할 때만 막고
      // 2단계(닫기 → 지우기)를 직접 수행한다.
      // 닫을 제안도 지울 값도 없으면 **막지 않는다** — 전체화면 종료 같은 브라우저 기본 동작이 살아야 한다.
      if (!box.hidden) { e.preventDefault(); close(); }
      else if (input.value) { e.preventDefault(); input.value = ''; onInput?.(''); }
    }
  });

  return {
    root, input, close,
    /** 값 설정. silent=true면 onInput을 호출하지 않는다(호출부가 이미 상태를 갱신한 경우). */
    setValue(v, { silent = true } = {}) { input.value = v; if (!silent) onInput?.(v); },
    focus() { input.focus(); },
    destroy() { destroyed = true; close(); },
  };
}
