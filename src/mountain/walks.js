// 산 시트 주변 길 탭 — 이 산의 정상·들머리 기준 반경 안 걷기길(OpenStreetMap 노선).
// 정상 300m 안을 지나는 kind=trail 노선은 코스 탭에 있으므로 여기서 뺀다.
import { el, clear } from '../dom.js';
import { kindStyle, kindLabel } from '../walkdata.js';
import { isDarkTheme } from '../prefs.js';
import { navigate } from '../router.js';
import { nearbyRoutes } from '../mapselection.js';
import { isSummitTrail } from './model.js';
import { fmtKm, dots } from './format.js';

export const RADII = [5, 10, 15];

export function nearbyWalks(walks, r) {
  return walks.filter((w) => !isSummitTrail(w) && Number(w.dist_km) <= r && w.lines?.length)
    .sort((a, b) => a.dist_km - b.dist_km || a.name.localeCompare(b.name, 'ko'));
}

function anchorText(w) {
  const d = Number(w.dist_km);
  const where = w.anchor === 'summit' ? '정상' : w.anchor === 'trailhead' ? '들머리' : '정상·들머리';
  return d < 0.1 ? `${where} 근처` : `${where}에서 ${fmtKm(d)}`;
}
function lengthText(w) {
  const here = fmtKm(w.length_km);
  if (!here) return '';
  if (!w.partial) return here;
  const total = Number(w.total_km || w.declared_km);
  return Number.isFinite(total) && total > Number(w.length_km)
    ? `이 범위 ${here} (전체 ${fmtKm(total)})` : `이 범위 ${here} (일부 구간)`;
}

/**
 * @param {object} o
 * @param {object} o.ctx 셸 컨트롤러 ctx
 * @param {object} o.m 산
 * @param {Array} o.walks 산 주변 노선(loadMountainWalks().routes)
 * @param {number} o.radius 처음 반경
 * @param {(r:number)=>void} o.onRadius 반경 변경(주소에 쓰기)
 * @param {()=>object} o.group 지도 레이어 묶음 만들기
 */
export function createWalksTab({ ctx, m, walks, radius, onRadius, group }) {
  let r = RADII.includes(radius) ? radius : 10;
  let active = false;
  let shown = [];
  const lines = group();
  const hover = group();
  const chips = el('div', { class: 'mt-radius', role: 'group', 'aria-label': '찾는 범위' },
    ...RADII.map((v) => el('button', { type: 'button', class: 'chip small', 'aria-pressed': String(v === r), dataset: { r: v },
      onClick: () => setRadius(v, true) }, `${v}km`)));
  const list = el('div', { class: 'rows', role: 'list' });
  const note = el('p', { class: 'mt-fine mt-pad' }, '선은 OpenStreetMap에 등록된 노선입니다 · 운영·통제 상태 미확인');
  const head = el('div', { class: 'mt-walks-head', hidden: !walks.length }, el('span', { class: 'mt-walks-label' }, '정상·들머리에서'), chips);
  const root = el('div', { class: 'mt-walks' }, head, list, note);

  function paint() {
    shown = nearbyWalks(walks, r);
    [...chips.children].forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.r) === r)));
    clear(list);
    note.hidden = !shown.length;
    if (!shown.length) {
      list.append(el('div', { class: 'empty' },
        el('p', {}, walks.length ? `${r}km 안에 수록된 걷기길이 없습니다.` : '수록된 걷기길이 없습니다.'),
        el('p', { class: 'mt-fine' }, 'OpenStreetMap에 노선으로 등록된 길만 보여 줍니다.')));
    }
    const dark = isDarkTheme();
    for (const w of shown) {
      const st = kindStyle(w.kind, { long: w.long, dark });
      const loop = w.loop === true ? '순환' : w.loop === false ? '편도' : null;
      const row = el('a', { class: 'row mt-walk', href: `#/walk/${encodeURIComponent(w.rid)}?from=${encodeURIComponent(m.id)}` },
        el('div', { class: 'row-main' },
          el('span', { class: 'swatch', style: `--c:${st.color}`, 'aria-hidden': 'true' }),
          el('span', { class: 'row-title' }, w.name)),
        el('div', { class: 'row-meta mt-dots mt-walk-meta' }, ...dots([
          el('span', { class: 'row-kind' }, kindLabel(w)),
          loop ? el('span', {}, loop) : null,
          lengthText(w) ? el('span', { class: 'tabular' }, lengthText(w)) : null,
          el('span', { class: 'tabular' }, anchorText(w))])));
      row.addEventListener('mouseenter', () => highlight(w));
      row.addEventListener('mouseleave', () => highlight(null));
      row.addEventListener('focus', () => highlight(w));
      row.addEventListener('blur', () => highlight(null));
      // 항목은 <a>를 감싼 div — <a>에 listitem을 주면 링크라는 사실이 화면 읽기 프로그램에서 사라진다
      list.append(el('div', { role: 'listitem' }, row));
    }
    if (active) draw({ fit: true });
  }

  function draw({ fit = false } = {}) {
    lines.clear(); hover.clear();
    if (!active) return;
    ctx.whenMap((view) => {
      if (!active) return;
      lines.clear();
      const dark = isDarkTheme();
      for (const w of shown) {
        const st = kindStyle(w.kind, { long: w.long, dark });
        lines.add(view.addPolylines(w.lines, { color: st.color, weight: Math.max(2, st.weight - 1), opacity: Math.min(0.8, st.opacity) }));
      }
      if (fit) {
        const pts = m.lat != null ? [[m.lat, m.lon]] : [];
        for (const w of shown) if (w.bbox) pts.push([w.bbox[0], w.bbox[1]], [w.bbox[2], w.bbox[3]]);
        if (pts.length > 1) ctx.fit(pts, { maxZoom: 13 });
      }
    });
  }
  function highlight(w) {
    hover.clear();
    if (!w || !active || !ctx.view) return;
    const st = kindStyle(w.kind, { long: w.long, dark: isDarkTheme(), selected: true });
    hover.add(ctx.view.addPolylines(w.lines, { color: st.color, weight: st.weight, opacity: 1 }));
  }

  function setRadius(v, user) {
    if (v === r && !user) return;
    r = v; paint();
    if (user) onRadius?.(r);
  }

  paint();
  return {
    root,
    count: () => nearbyWalks(walks, r).length,
    get radius() { return r; },
    setRadius: (v) => setRadius(RADII.includes(v) ? v : 10, false),
    show() { if (active) return; active = true; ctx.setWalkLayerMode('off'); draw({ fit: true }); },
    hide() { if (!active) return; active = false; lines.clear(); hover.clear(); ctx.setWalkLayerMode('auto'); },
    redraw() { if (active) draw(); },
    /** 지도 탭: 그린 노선을 누르면 걷기길 시트로. */
    hitTest(pt) {
      if (!active || !ctx.view) return false;
      const hit = nearbyRoutes(ctx.view, shown.map((w) => ({ w, segments: w.lines })), pt)[0];
      if (!hit) return false;
      navigate(`#/walk/${encodeURIComponent(hit.w.rid)}?from=${encodeURIComponent(m.id)}`);
      return true;
    },
  };
}
