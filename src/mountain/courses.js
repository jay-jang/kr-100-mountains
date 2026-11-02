// 산 시트 코스 탭 — 등산로 행(대표 코스를 같은 행에 붙임) · 연결 없는 대표 코스 · OSM 등록 탐방로 · 내 경로.
// 행 = 이름 · 들머리 · 거리 · 왕복 · 난이도 · 검증 수준 · 선 상태 · 코스 근거. 행을 누르면 경로 시트.
import { el, clear } from '../dom.js';
import { pref } from '../prefs.js';
import { icon } from '../icons.js';
import { lineStatus } from './model.js';
import { fmtHours, fmtMin, fmtKm, diffMark, verifyInfo, evidenceLabel, officialLabel, fmtSection, PROVENANCE, dots } from './format.js';

const TOOL_KEYS = ['compareRoutes', 'gpxImport', 'routePlanner', 'followRoute', 'liveTrails'];

/**
 * @param {object} o
 * @param {object} o.m 산
 * @param {object} o.model loadCourseModel 결과
 * @param {()=>Array} o.userRows 내 GPX·계획 행
 * @param {(key:string)=>void} o.onOpen 경로 시트 열기
 * @param {{has:(k)=>boolean, color:(k)=>string|null, toggle:(row, on:boolean)=>void}} o.compare
 * @param {(files:File[])=>void} o.onFiles
 * @param {(btn:HTMLButtonElement)=>void} o.onNetwork
 */
export function createCoursesTab({ m, model, userRows, onOpen, compare, onFiles, onNetwork }) {
  const root = el('div', { class: 'mt-courses' });
  const status = el('p', { class: 'mt-fine mt-pad', role: 'status', 'aria-live': 'polite' });
  let selectedKey = null;
  let moreOpen = null;     // 사용자가 연 "정상을 지나지 않는 공원 코스" 묶음 상태 — 다시 그려도 유지(null = 아직 안 건드림)

  function hrefFor(key) { return `#/m/${encodeURIComponent(m.id)}?route=${encodeURIComponent(key)}`; }

  function meta(row) {
    const parts = [];
    if (row.kind === 'course' && row.course?.via?.length) {
      parts.push(el('span', { class: 'mt-via' }, row.course.via.join(' → ')));
      return parts;
    }
    if (row.kind === 'official') {
      if (row.official.section) parts.push(el('span', { class: 'mt-via' }, fmtSection(row.official.section)));
      if (fmtKm(row.distanceKm)) parts.push(el('span', { class: 'tabular' }, fmtKm(row.distanceKm)));
      if (row.official.schedule && row.official.schedule !== '당일') parts.push(el('span', {}, row.official.schedule));
      if (row.guideMin) parts.push(el('span', { class: 'tabular' }, `안내 ${fmtMin(row.guideMin)}`));
      if (row.difficulty) parts.push(diffMark(row.difficulty));
      return parts;
    }
    if (row.start) parts.push(el('span', {}, `들머리 ${row.start}`));
    if (fmtKm(row.distanceKm)) parts.push(el('span', { class: 'tabular' }, fmtKm(row.distanceKm)));
    if (row.roundH) parts.push(el('span', { class: 'tabular' }, `왕복 ${fmtHours(row.roundH)}`));
    else if (row.duration) parts.push(el('span', {}, row.duration));
    if (row.walkingMin) parts.push(el('span', { class: 'tabular' }, `표지 시간 ${fmtMin(row.walkingMin)}`));
    if (row.gainM) parts.push(el('span', { class: 'tabular' }, `오름 ${row.gainM.toLocaleString('ko-KR')}m`));
    if (row.difficulty) parts.push(diffMark(row.difficulty));
    return parts;
  }
  function honesty(row) {
    const vi = verifyInfo(row.verify);
    const ls = lineStatus(row);
    return [
      vi ? el('span', { class: `mt-verify ${vi.tone}`, title: vi.title }, vi.text) : null,
      el('span', { class: 'mt-line-' + ls.provenance }, PROVENANCE[ls.provenance].status),
      ls.review ? el('span', { class: 'mt-review' }, '검토 필요') : null,
      // 공식 코스와 이어진 행은 공단 확인이 더 강한 근거다 — 그것을 먼저 보인다.
      row.official ? el('span', {}, officialLabel(row.official)) : row.course ? el('span', {}, evidenceLabel(row.course)) : null,
      row.kind === 'official' && !row.reachesSummit ? el('span', {}, '정상 미경유') : null,
      row.kind === 'osm' ? el('span', {}, '운영 상태 미확인') : null,
    ].filter(Boolean);
  }

  function rowNode(row) {
    const hasLine = row.lines.length > 0;
    const link = el('a', { class: 'row mt-crow-link', href: hrefFor(row.key),
      'aria-current': row.key === selectedKey ? 'true' : null,
      onClick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); onOpen(row.key); } },
    el('div', { class: 'row-main' },
      el('span', { class: 'row-title' }, row.name),
      row.kind === 'course' ? el('span', { class: 'row-tag' }, '대표 코스') : null),
    row.altName ? el('div', { class: 'mt-crow-alt' }, `대표 코스명 ${row.altName}`) : null,
    el('div', { class: 'row-meta mt-dots' }, ...dots(meta(row))),
    el('div', { class: 'row-meta mt-dots mt-crow-honesty' }, ...dots(honesty(row))));
    const wrap = el('div', { class: 'mt-crow' + (row.key === selectedKey ? ' selected' : ''), role: 'listitem', dataset: { key: row.key } });
    if (pref('compareRoutes')) {
      if (hasLine) {
        const on = compare.has(row.key);
        const box = el('input', { type: 'checkbox', checked: on, 'aria-label': `${row.name} 겹쳐 보기` });
        box.addEventListener('change', () => compare.toggle(row, box.checked));
        wrap.append(el('label', { class: 'mt-cmp', title: '지도에 겹쳐 보기' }, box,
          el('span', { class: 'mt-cmp-sw', style: on && compare.color(row.key) ? `--c:${compare.color(row.key)}` : null, 'aria-hidden': 'true' })));
      } else wrap.append(el('span', { class: 'mt-cmp mt-cmp-empty', 'aria-hidden': 'true' }));
    }
    wrap.append(link);
    return wrap;
  }

  function paint() {
    clear(root);
    const main = el('div', { class: 'rows', role: 'list', 'aria-label': '코스' }, ...model.rows.map(rowNode));
    if (!model.rows.length) main.append(el('div', { class: 'empty' }, el('p', {}, '수록된 코스가 없습니다.')));
    root.append(main);
    if (model.officialRows.length) {
      const parks = [...new Set(model.officialRows.map((r) => r.official.park).filter(Boolean))];
      const title = parks.length === 1 ? `${parks[0]}국립공원 공식 탐방코스` : '국립공원 공식 탐방코스';
      const up = model.officialRows.filter((r) => r.reachesSummit);
      const other = model.officialRows.filter((r) => !r.reachesSummit);
      root.append(el('h3', { class: 'rows-h' }, title));
      if (up.length) root.append(el('div', { class: 'rows', role: 'list', 'aria-label': `${title} · 정상 경유` }, ...up.map(rowNode)));
      if (other.length) {
        // 정상을 지나지 않는 공원 코스(계곡·둘레·다른 봉우리)는 접어 둔다 — 정상 코스 목록이 길어지지 않게.
        // 고른 코스가 이 안에 있으면 펼친 채로 둔다.
        const open = moreOpen ?? (other.some((r) => r.key === selectedKey) || !up.length);
        const det = el('details', { class: 'mt-details mt-more', open: open || null },
          el('summary', {}, `정상을 지나지 않는 공원 코스 ${other.length}개`),
          el('div', { class: 'rows', role: 'list', 'aria-label': `${title} · 정상 미경유` }, ...other.map(rowNode)));
        det.addEventListener('toggle', () => { moreOpen = det.open; });
        root.append(det);
      }
    }
    if (model.osmRows.length) {
      root.append(el('h3', { class: 'rows-h' }, 'OpenStreetMap 등록 탐방로'),
        el('div', { class: 'rows', role: 'list', 'aria-label': 'OpenStreetMap 등록 탐방로' }, ...model.osmRows.map(rowNode)));
    }
    const mine = userRows();
    if (mine.length) {
      root.append(el('h3', { class: 'rows-h' }, '내 경로'),
        el('div', { class: 'rows', role: 'list', 'aria-label': '내 경로' }, ...mine.map(rowNode)));
    }

    // 도구(설정 ON일 때만 입구가 보인다)
    const tools = el('div', { class: 'mt-tools' });
    if (pref('gpxImport')) {
      const input = el('input', { type: 'file', accept: '.gpx,application/gpx+xml', multiple: true, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
      input.addEventListener('change', () => { const files = [...(input.files || [])]; input.value = ''; if (files.length) onFiles(files); });
      tools.append(el('button', { type: 'button', class: 'btn', onClick: () => input.click() },
        el('span', { html: icon('plus', { size: 18 }) }), 'GPX 파일 열기'), input);
    }
    if (pref('liveTrails')) {
      const b = el('button', { type: 'button', class: 'btn' }, 'OSM 등산로 더 불러오기');
      b.addEventListener('click', () => onNetwork(b));
      tools.append(b);
    }
    if (tools.children.length) root.append(tools);
    root.append(status);
    root.append(el('p', { class: 'mt-fine mt-pad' }, '난이도·시간은 자료마다 다를 수 있습니다. 공식 코스 선과 계산 경로는 실측 기록이 아닙니다.'));
    if (TOOL_KEYS.some((k) => !pref(k))) {
      root.append(el('a', { class: 'text-link block mt-settings-hint', href: '#/settings' }, 'GPX 열기·경로 계획·겹쳐 보기는 설정에서 켤 수 있습니다 ›'));
    }
  }

  paint();
  return {
    root,
    paint,
    setStatus(text) { status.textContent = text || ''; },
    setSelected(key) {
      selectedKey = key;
      // 고른 코스가 접힌 묶음 안에 있으면 펼친다(돌아왔을 때 고른 행이 보이게).
      const det = root.querySelector('details.mt-more');
      if (det && key && det.querySelector(`.mt-crow[data-key="${CSS.escape(key)}"]`)) { det.open = true; moreOpen = true; }
      root.querySelectorAll('.mt-crow').forEach((n) => {
        const on = n.dataset.key === key;
        n.classList.toggle('selected', on);
        n.querySelector('.mt-crow-link')?.toggleAttribute('aria-current', on);
        if (on) n.querySelector('.mt-crow-link')?.setAttribute('aria-current', 'true');
      });
    },
    count: () => model.rows.length + model.officialRows.length + model.osmRows.length + userRows().length,
  };
}
