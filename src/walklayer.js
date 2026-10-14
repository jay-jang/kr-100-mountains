// 지도 위 걷기길 선 레이어 — 확대했을 때만 화면 안 노선을 종류색으로 얇게 그린다.
// 전국 축척에서는 그리지 않는다(산 기호가 선에 묻힌다). 공급자마다 줌 숫자의 뜻이 달라서
// 기준은 줌이 아니라 "보이는 범위의 폭(km)"이다.
import { loadWalkTiles, kindStyle } from './walkdata.js';

/** 화면이 자기 상세 선으로 직접 그리는 노선 — 거친 타일 선을 그 위에 겹쳐 그리지 않는다(걷기길 시트). */
const ownDrawn = new Set();
export function setOwnDrawnWalk(rid) { ownDrawn.clear(); if (rid) ownDrawn.add(rid); }

export const WALK_MAX_KM = 60;   // 보이는 범위 폭이 이보다 넓으면 그리지 않는다
const MAX_ROUTES = 80;           // 화면 중심에서 가까운 순으로 이만큼만
const HIT_PX = 14;

export function createWalkLayer(view, { onPick } = {}) {
  let tokens = [];
  let drawn = [];            // [{rid, lines}]
  let highlight = null;
  let seq = 0;
  let last = null;

  function clearAll() { tokens.forEach((t) => view.removeLayer(t)); tokens = []; drawn = []; }

  function draw(routes, dark) {
    clearAll();
    // 강조할 노선은 맨 나중에(위에) 그린다.
    const ordered = routes.slice().sort((a, b) => (a.rid === highlight) - (b.rid === highlight));
    // 강조할 노선이 화면에 있으면 나머지는 더 흐리게 — 같은 종류색끼리도 고른 길이 먼저 보이게.
    const focus = highlight && routes.some((w) => w.rid === highlight);
    for (const w of ordered) {
      if (ownDrawn.has(w.rid)) continue;
      const st = kindStyle(w.kind, { long: w.long, dark, selected: w.rid === highlight });
      const opacity = w.rid === highlight ? 1 : Math.min(focus ? 0.4 : 0.75, st.opacity);
      tokens.push(view.addPolylines(w.lines, { color: st.color, weight: Math.max(2, st.weight - 1.5), opacity }));
      drawn.push(w);
    }
  }

  async function update({ bounds, widthKm, enabled, dark }) {
    last = { bounds, widthKm, enabled, dark };
    const my = ++seq;
    // 폭이 0(또는 숫자 아님)이면 숨겨진 0×0 지도다 — 그 범위로 타일을 요청하지 않는다.
    if (!enabled || !(widthKm > 0) || widthKm > WALK_MAX_KM) { clearAll(); return; }
    const routes = await loadWalkTiles(bounds);
    if (my !== seq) return;           // 그사이 지도가 또 움직였다
    const cLat = (bounds.north + bounds.south) / 2, cLon = (bounds.east + bounds.west) / 2;
    const inView = routes.filter((w) => w.lines.some((l) => l.some(([la, lo]) => la >= bounds.south && la <= bounds.north && lo >= bounds.west && lo <= bounds.east)));
    const dist = (w) => Math.min(...w.lines.flatMap((l) => l.map(([la, lo]) => (la - cLat) ** 2 + ((lo - cLon) * 0.8) ** 2)));
    inView.sort((a, b) => dist(a) - dist(b));
    draw(inView.slice(0, MAX_ROUTES), dark);
  }

  /** 지도 탭 지점 근처(화면 14px)의 노선을 찾아 onPick. 찾으면 true. */
  function hitTest(pt) {
    if (!drawn.length) return false;
    const c = view.project(pt);
    let best = null, bestD = HIT_PX;
    for (const w of drawn) for (const line of w.lines) {
      let a = view.project(line[0]);
      for (let i = 1; i < line.length; i++) {
        const b = view.project(line[i]);
        const dx = b.x - a.x, dy = b.y - a.y;
        const t = dx || dy ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
        const d = Math.hypot(c.x - a.x - t * dx, c.y - a.y - t * dy);
        if (d < bestD) { bestD = d; best = w; }
        a = b;
      }
    }
    if (best) { onPick?.(best.rid); return true; }
    return false;
  }

  return {
    update,
    hitTest,
    setHighlight(rid) {
      if (highlight === rid) return;
      highlight = rid;
      if (last) update(last);
    },
    clear: clearAll,
  };
}
