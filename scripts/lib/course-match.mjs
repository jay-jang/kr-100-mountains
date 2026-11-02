// 공식 탐방코스 선형 → OpenStreetMap 등산로 위 선(지도 맞춤, map matching) — scripts/build-course-routes.mjs가 쓴다.
// 순수 함수만 둔다(파일·네트워크 없음) — scripts/course-match.test.mjs가 합성 그래프로 검사한다.
//
// 원칙
//   · 결과 좌표는 전부 OSM way 위의 정점이다. 공식 선형 좌표는 "어느 길인가"를 고르는 기준으로만 쓴다.
//   · OSM에 길이 없는 구간은 직선으로 잇지 않고 선을 끊는다. 옆 능선·계곡으로 크게 돌아간 부분은 잘라 낸다.
//   · 이미 밟은 함정: 경로 전체에서 "되돌아오는 구간"을 지우면 왕복 코스가 통째로 사라진다(칠불능선 0%) —
//     되돌림은 기준점 이음매에서만 걷어 낸다.
import { haversine, pathLength } from './geo.mjs';
import { buildGraph, nearestPerComponent, shortestPath } from './route-graph.mjs';

// ── 매칭 상수 ─────────────────────────────────────────────────────────
export const STEP_M = 10;            // 공식 선·우리 선을 이 간격으로 촘촘히 나눠 비교한다
export const PART_GAP_M = 300;       // 공식 선 안에서 이만큼 튀면 다른 조각으로 본다
export const ANCHOR_M = 120;         // 기준점 간격(촘촘할수록 왕복 코스의 반환점이 덜 잘린다)
export const SNAP_M = 70;            // 기준점 → OSM 노드 스냅 허용
export const MAX_SKIP_M = 600;       // 스냅 실패로 건너뛸 수 있는 공식 구간 길이(넘으면 선을 끊는다)
export const SIGMA_M = 25;           // 공식 선에서 이만큼 떨어진 길은 비용 2배(제곱으로 커진다)
export const DEV_CAP = 40;           // 비용 배수 상한
export const DETOUR = 2.6;           // 기준점 사이 OSM 경로가 공식 구간의 이 배수(+150m)를 넘으면 끊긴 것으로 본다
export const MATCH_M = 40;           // 일치로 치는 거리
export const OFF_M = 60;             // 공식 선에서 이보다 멀면 "벗어남"
export const OFF_RUN_M = 120;        // 벗어난 채 이만큼 넘게 이어지면 그 구간을 잘라 낸다
export const STITCH_SPLIT_M = 10;   // 이보다 긴 보조 간선(OSM에서 이어지지 않은 끝점 잇기)을 지나면 선을 나눈다
export const STITCH_ON_LINE_M = 30; // …단 공단 코스 선이 그 이음의 가운데 이 거리 안을 지나면 잇는다(공단 선과 OSM 길의 흔한 어긋남 폭)
export const SIMPLIFY_M = 3;
export const SUMMIT_M = 300;         // 공식 선이 정상에서 이 안쪽을 지나면 "정상 경유"
export const SUMMIT_NAMED_M = 1500;  // 공식 구간 설명에 정상 이름이 있으면 선이 이 안쪽만 지나도 "정상 경유"(공단 선형이 정상 앞에서 끝나는 경우)
export const NEAR_M = 3000;          // 정상을 지나지 않는 코스: 이 안쪽의 가장 가까운 산에 싣는다
export const PARK_M = 30000;         // 공원 이름과 같은 산(지리산국립공원 → 지리산)에는 이 안쪽의 공원 코스를 함께 싣는다


// collect-routes.mjs와 같은 길 분류(같은 그래프 규칙)
export const WALK_CLASSES = ['path', 'footway', 'track', 'steps', 'bridleway', 'pedestrian', 'cycleway',
  'service', 'unclassified', 'residential', 'living_street'];
const WALK_SET = new Set(WALK_CLASSES);

// ── 공간 색인(점 집합 → 최근접 거리) ───────────────────────────────────
export class PointIndex {
  constructor(points, cellDeg = 0.0005) {
    this.cell = cellDeg; this.grid = new Map();
    for (const p of points) {
      const k = `${Math.floor(p[0] / cellDeg)},${Math.floor(p[1] / cellDeg)}`;
      const b = this.grid.get(k); if (b) b.push(p); else this.grid.set(k, [p]);
    }
  }
  /** maxM 안에서 가장 가까운 점까지의 거리(없으면 Infinity). */
  nearest(p, maxM = 200) {
    const cellM = this.cell * 111320 * Math.cos((p[0] * Math.PI) / 180);
    const r = Math.ceil(maxM / cellM);
    const gx = Math.floor(p[0] / this.cell), gy = Math.floor(p[1] / this.cell);
    let best = Infinity;
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      for (const q of this.grid.get(`${gx + dx},${gy + dy}`) || []) {
        const d = haversine(p[0], p[1], q[0], q[1]);
        if (d < best) best = d;
      }
    }
    return best <= maxM ? best : Infinity;
  }
}

/** 선을 조각(큰 점프에서 끊음)으로 나누고 STEP_M 간격으로 촘촘히. 각 조각: { pts, cum } */
export function densifyParts(line, step = STEP_M, gap = PART_GAP_M) {
  const parts = [];
  let cur = [];
  for (const p of line) {
    const last = cur[cur.length - 1];
    if (last && haversine(last[0], last[1], p[0], p[1]) > gap) { if (cur.length > 1) parts.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length > 1) parts.push(cur);
  return parts.map((pl) => {
    const pts = [pl[0]]; const cum = [0];
    for (let i = 1; i < pl.length; i++) {
      const a = pl[i - 1], b = pl[i];
      const d = haversine(a[0], a[1], b[0], b[1]);
      const n = Math.max(1, Math.ceil(d / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        cum.push(cum[cum.length - 1] + d / n);
      }
    }
    return { pts, cum, length: cum[cum.length - 1] };
  }).filter((p) => p.length >= 50);
}

export const nk = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;   // route-graph.mjs의 노드 키와 같은 형식
export const pairKey = (a, b) => { const x = nk(a), y = nk(b); return x < y ? `${x}|${y}` : `${y}|${x}`; };

/** Overpass `out geom` 모양 JSON → 라우팅 그래프(+ g.restricted: OSM 출입 금지 표시 구간 집합) */
export function graphFromJSON(json) {
  // OSM에 출입 금지(access/foot=no)로 표시된 길도 그래프에 넣되 큰 도로처럼 비싸게 친다.
  // 공단 공식 코스가 지나는 길인데 OSM에는 금지로 남아 있는 경우가 있다(북한산 하루재~백운대피소 등).
  // 공식 선을 그대로 따르는 경우에만 쓰이고(편차 비용이 더 크다), 쓴 길이는 따로 재서 매니페스트에 남긴다.
  const walk = [], major = [];
  const restricted = new Set();
  for (const e of json.elements || []) {
    if (e.type !== 'way' || !(e.geometry?.length >= 2)) continue;
    const line = e.geometry.map((g) => [g.lat, g.lon]);
    const closed = e.tags?.access === 'no' || e.tags?.foot === 'no' || /비법정/.test(e.tags?.name || '');
    if (closed) {
      for (let i = 1; i < line.length; i++) restricted.add(pairKey(line[i - 1], line[i]));
      major.push(line);
      continue;
    }
    (WALK_SET.has(e.tags?.highway) ? walk : major).push(line);
  }
  const g = buildGraph(walk, major);
  g.restricted = restricted;
  return g;
}

/**
 * 공식 선이 되돌아가는 반환점(진행 방향이 150° 넘게 꺾이는 곳)의 누적 거리들.
 * 앞뒤 TURN_WIN m의 방향을 비교하고, 붙어 있는 후보는 가장 크게 꺾인 한 점으로 줄인다.
 */
const TURN_WIN = 30;
export function turnPoints(part) {
  const { pts, cum } = part;
  const out = [];
  let best = null;
  const idxAt = (s) => { let lo = 0, hi = cum.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < s) lo = mid + 1; else hi = mid; } return lo; };
  for (let i = 1; i < pts.length - 1; i++) {
    if (cum[i] < TURN_WIN || part.length - cum[i] < TURN_WIN) continue;
    const a = pts[idxAt(cum[i] - TURN_WIN)], b = pts[i], c = pts[idxAt(cum[i] + TURN_WIN)];
    const k = Math.cos((b[0] * Math.PI) / 180);
    const v1 = [(b[1] - a[1]) * k, b[0] - a[0]], v2 = [(c[1] - b[1]) * k, c[0] - b[0]];
    const n1 = Math.hypot(...v1), n2 = Math.hypot(...v2);
    if (!n1 || !n2) continue;
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2);
    if (cos < Math.cos((150 * Math.PI) / 180)) {
      // 붙어 있는 후보 중 앞뒤 점(a, c)이 가장 가까운 곳 = 실제 꼭짓점(왕복이면 a와 c가 겹친다)
      const gap = Math.hypot((c[1] - a[1]) * k, c[0] - a[0]);
      if (!best || cum[i] - best.s > TURN_WIN * 2) { if (best) out.push(best.s); best = { s: cum[i], gap }; }
      else if (gap < best.gap) best = { s: cum[i], gap };
    }
  }
  if (best) out.push(best.s);
  return out;
}

// ── 지도 맞춤 ─────────────────────────────────────────────────────────
export function matchCourse(g, parts, { debug = false, log = () => {} } = {}) {
  const official = new PointIndex(parts.flatMap((p) => p.pts));
  const devCache = new Map();
  const dev = (k) => {
    let d = devCache.get(k);
    if (d === undefined) { d = official.nearest(g.nodes.get(k), 250); devCache.set(k, d); }
    return d;
  };
  const cost = (u, v, w, mult) => {
    const d = Math.min(250, (Math.min(dev(u), 250) + Math.min(dev(v), 250)) / 2);
    return w * mult * Math.min(DEV_CAP, 1 + (d / SIGMA_M) ** 2);
  };

  const segments = [];   // 노드 키 배열들
  const partEnd = new Set();   // 공식 선 조각이 끝난 자리(segments 인덱스)
  let gaps = 0, joinedParts = 0, cutM = 0;
  for (const part of parts) {
    // 기준점: 조각의 시작·끝 + ANCHOR_M 간격
    // 기준점: 일정 간격 + 공식 선이 되돌아가는 반환점(왕복 코스의 끝·봉우리 찍고 돌아오기).
    // 반환점을 기준점으로 두지 않으면 앞뒤 기준점끼리 바로 이어져 반환점 앞 구간이 통째로 빠진다.
    const turns = turnPoints(part);
    const anchors = [];
    for (let s = 0; s <= part.length; s += ANCHOR_M) anchors.push({ s, turn: false });
    if (part.length - anchors[anchors.length - 1].s > 30) anchors.push({ s: part.length, turn: false });
    for (const t of turns) {
      const near = anchors.findIndex((a) => Math.abs(a.s - t) < 40);
      if (near >= 0) anchors[near] = { s: t, turn: true }; else anchors.push({ s: t, turn: true });
    }
    anchors.sort((a, b) => a.s - b.s);
    const at = (s) => { let i = part.cum.findIndex((c) => c >= s); if (i < 0) i = part.pts.length - 1; return part.pts[i]; };
    const snapped = anchors.map(({ s, turn }) => {
      const p = at(s);
      const cands = [...nearestPerComponent(g, p, SNAP_M).values()];
      if (!cands.length) { if (debug) log(`    스냅 실패 @${Math.round(s)}m ${p[0].toFixed(5)},${p[1].toFixed(5)}`); return null; }
      // 큰 그물(파편 아님)을 우선하되 너무 멀면 가까운 쪽
      cands.sort((a, b) => (a.dist + (g.compSize.get(g.comp.get(a.key)) < 20 ? 60 : 0)) - (b.dist + (g.compSize.get(g.comp.get(b.key)) < 20 ? 60 : 0)));
      return { s, turn, key: cands[0].key };
    });
    if (debug) log(`    조각 ${Math.round(part.length)}m · 기준점 ${anchors.length} · 스냅 실패 ${snapped.filter((x) => !x).length}`);
    let cur = null, prev = null;
    const plain = (u, v, w, mult) => w * mult;
    const breakHere = (a, why) => {
      if (debug) log(`    끊김 @${Math.round(prev.s)}–${Math.round(a.s)}m: ${why}`);
      gaps++;
      if (cur && cur.length > 1) segments.push(cur);
      cur = [a.key]; prev = a;
    };
    // 스냅에 실패한 기준점은 건너뛰고 다음 기준점으로 잇는다. 건너뛴 구간이 길면(OSM에 길이 없다) 끊는다.
    for (const a of snapped.filter(Boolean)) {
      if (!prev) { cur = [a.key]; prev = a; continue; }
      if (a.key === prev.key) { prev = a; continue; }
      const arc = a.s - prev.s;
      const limit = arc * DETOUR + 150;
      if (arc > MAX_SKIP_M) { breakHere(a, `기준점 ${Math.round(arc)}m 공백`); continue; }
      if (g.comp.get(a.key) !== g.comp.get(prev.key)) { breakHere(a, '다른 그물'); continue; }
      let r = shortestPath(g, prev.key, a.key, cost, { maxCost: arc * 12 + 600 });
      // 공식 선과 OSM 길이 통째로 50m 넘게 어긋난 구간은 편차 비용으로는 한도를 넘는다 —
      // 그때는 거리만으로 다시 찾고, 우회가 지나치지 않을 때만 쓴다(일치율에 그대로 드러난다).
      if (!r || r.dist_m > limit) r = shortestPath(g, prev.key, a.key, plain, { maxCost: limit });
      if (!r || r.dist_m > limit) { breakHere(a, r ? `우회 ${r.dist_m}m` : '경로 없음'); continue; }
      // 기준점이 갈림길을 살짝 지나 스냅되면 "갔다가 되돌아오는" 꼬리가 생긴다 — 이음매에서만 걷어 낸다.
      // (경로 전체에서 되돌림을 지우면 왕복 코스가 통째로 사라진다.)
      // 반환점에서 떠나는 길은 다듬지 않고(되돌아가는 게 코스다), 그 밖에서도 스냅 허용치(SNAP_M)만큼만 다듬는다.
      const next = r.keys.slice(1);
      let trimmed = 0;
      while (!prev.turn && cur.length > 1 && next.length > 1 && cur[cur.length - 2] === next[0]) {
        const x = g.nodes.get(cur[cur.length - 1]), y = g.nodes.get(cur[cur.length - 2]);
        trimmed += haversine(x[0], x[1], y[0], y[1]);
        if (trimmed > SNAP_M) break;
        cur.pop(); next.shift();
      }
      cur.push(...next);
      prev = a;
    }
    if (cur && cur.length > 1) segments.push(cur);
    partEnd.add(segments.length - 1);
  }

  // 공식 선이 여러 조각(자료상 끊김, 오르는 길·내려오는 길을 따로 그린 것 등)이면, 앞 조각 끝과 다음 조각 시작이
  // 가까울 때 OSM 길로 잇는다. 같은 조각 안에서 끊긴 곳(OSM에 길이 없는 구간)은 잇지 않는다.
  const plainCost = (u, v, w, mult) => w * mult;
  for (let i = segments.length - 2; i >= 0; i--) {
    if (!partEnd.has(i)) continue;
    const a = segments[i], b = segments[i + 1];
    const p = g.nodes.get(a[a.length - 1]), q = g.nodes.get(b[0]);
    const straight = haversine(p[0], p[1], q[0], q[1]);
    if (straight > 1000) continue;
    let joint = a[a.length - 1] === b[0] ? { keys: [b[0]] } : null;
    if (!joint && g.comp.get(a[a.length - 1]) === g.comp.get(b[0])) {
      const r = shortestPath(g, a[a.length - 1], b[0], plainCost, { maxCost: straight * 2.5 + 300 });
      if (r && r.dist_m <= straight * 2.5 + 300) joint = r;
    }
    if (!joint) continue;
    const next = [...joint.keys.slice(1), ...b.slice(1)];
    while (a.length > 1 && next.length > 1 && a[a.length - 2] === next[0]) { a.pop(); next.shift(); }
    a.push(...next);
    segments.splice(i + 1, 1);
    joinedParts++;
  }

  // 그래프의 "이어붙임" 간선(OSM에서는 이어지지 않은 끝점끼리 30m 안을 잇는 보조 간선)을 STITCH_SPLIT_M 넘게 건너면
  // 그 자리에서 선을 나눈다 — OSM에 없는 길을 직선으로 그리지 않는다. 다만 ① 몇 m짜리 꼭짓점 맞춤, ② OSM 길로
  // 조금 돌아가면 이어지는 모퉁이 깎기, ③ 공단 코스 선이 바로 그 자리(STITCH_ON_LINE_M 안)를 지나는 짧은 이음
  // (등산로는 이어져 있는데 OSM 자료에서 길 끝이 맞붙지 않은 곳 — 북한산 오봉코스 15~24m)은 나누지 않는다.
  const ek = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);   // route-graph.mjs edgeKey와 같은 형식
  let stitchSplits = 0;
  // 보조 간선 양 끝이 OSM 길(보조 간선 빼고)로 2배·+40m 안에 이어지면 모퉁이를 깎은 것일 뿐 — 나누지 않는다.
  const noStitch = (u, v, w, mult) => (g.stitched.has(ek(u, v)) ? Infinity : w * mult);
  const realGap = (u, v) => {
    const a = g.nodes.get(u), b = g.nodes.get(v);
    const chord = haversine(a[0], a[1], b[0], b[1]);
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (official.nearest(mid, STITCH_ON_LINE_M) <= STITCH_ON_LINE_M) return false;
    const lim = Math.max(chord * 2, chord + 40);
    const r = shortestPath(g, u, v, noStitch, { maxCost: lim });
    return !r || r.dist_m > lim;
  };
  if (g.stitched?.size) {
    for (let si = segments.length - 1; si >= 0; si--) {
      const keys = segments[si];
      const pieces = [[keys[0]]];
      for (let k = 1; k < keys.length; k++) {
        const a = g.nodes.get(keys[k - 1]), b = g.nodes.get(keys[k]);
        if (g.stitched.has(ek(keys[k - 1], keys[k])) && haversine(a[0], a[1], b[0], b[1]) > STITCH_SPLIT_M && realGap(keys[k - 1], keys[k])) { pieces.push([keys[k]]); stitchSplits++; }
        else pieces[pieces.length - 1].push(keys[k]);
      }
      if (pieces.length > 1) segments.splice(si, 1, ...pieces.filter((x) => x.length > 1));
    }
  }

  // 공식 선에서 OFF_M 넘게 떨어진 채 OFF_RUN_M 넘게 이어지는 구간은 잘라 낸다 — OSM에 공식 길이 없어
  // 옆 능선·계곡으로 돌아간 부분이다. 비워 두는 편이 다른 길을 공식 코스처럼 그리는 것보다 정직하다.
  const cleaned = [];
  for (const keys of segments) {
    const pts = keys.map((k) => g.nodes.get(k));
    const off = keys.map((k) => dev(k) > OFF_M);
    let run = [];
    let i = 0;
    while (i < pts.length) {
      if (!off[i]) { run.push(pts[i]); i++; continue; }
      let j = i; let len = 0;
      while (j < pts.length && off[j]) { if (j > i) len += haversine(pts[j - 1][0], pts[j - 1][1], pts[j][0], pts[j][1]); j++; }
      if (len > OFF_RUN_M) {
        if (run.length > 1) cleaned.push(run);
        run = [];
        cutM += len;
        i = j;
      } else { for (let t = i; t < j; t++) run.push(pts[t]); i = j; }
    }
    if (run.length > 1) cleaned.push(run);
  }
  for (let k = cleaned.length - 1; k >= 0; k--) if (pathLength(cleaned[k]) < 60) cleaned.splice(k, 1);
  if (cleaned.length > segments.length) gaps += cleaned.length - segments.length;
  let restrictedM = 0;
  for (const sg of cleaned) for (let i = 1; i < sg.length; i++) {
    if (g.restricted?.has(pairKey(sg[i - 1], sg[i]))) restrictedM += haversine(sg[i - 1][0], sg[i - 1][1], sg[i][0], sg[i][1]);
  }
  return { segments: cleaned, gaps, joinedParts, stitchSplits, cutM: Math.round(cutM), restrictedM: Math.round(restrictedM) };
}

/** 일치율: coverage = 공식 선 중 우리 선 MATCH_M 안 비율, precision = 우리 선 중 공식 선 MATCH_M 안 비율 */
export function agreement(parts, segs) {
  const ourPts = segs.flatMap((s) => densifyParts(s, STEP_M, 1e9).flatMap((p) => p.pts));
  if (!ourPts.length) return { coverage: 0, precision: 0 };
  const offPts = parts.flatMap((p) => p.pts);
  const ourIdx = new PointIndex(ourPts);
  const offIdx = new PointIndex(offPts);
  const cov = offPts.filter((p) => ourIdx.nearest(p, MATCH_M) <= MATCH_M).length / offPts.length;
  const prec = ourPts.filter((p) => offIdx.nearest(p, MATCH_M) <= MATCH_M).length / ourPts.length;
  return { coverage: +cov.toFixed(3), precision: +prec.toFixed(3) };
}

// gaps = 같은 공식 선 조각 안에서 OSM 길이 없어 끊긴 곳 수. 공식 선 자체가 나뉜 것은 끊김으로 치지 않는다.
/** 공단 지도의 코스 선이 안내 거리보다 확연히 짧은가(선형이 일부 구간만 담은 경우).
 *  공단 안내 거리는 코스에 따라 편도이기도 왕복이기도 해서(백무동 15km = 편도 7.5km의 두 배), 선이 안내 거리의
 *  절반 언저리면 왕복 표기로 보고 넘어간다. 45%보다 짧을 때만 "일부 구간만"이라고 알린다. */
export function shortOfGuide(c) {
  const guide = Number(c.distance_km);
  return guide > 0 && c.official_line_km < guide * 0.45;
}

export function statusOf({ coverage, precision }, gaps) {
  if (coverage >= 0.92 && precision >= 0.92 && gaps === 0) return 'accepted';
  if (coverage >= 0.96 && precision >= 0.95 && gaps <= 2) return 'accepted';   // 끝자락 몇십 m만 빈 경우
  if (coverage >= 0.75 && precision >= 0.85 && gaps <= 3) return 'review';
  return 'rejected';
}


/** 공식 구간 설명 "A~B-C∼D→E/F" → 경유지 이름 배열(공백·괄호 설명 제거). */
export function sectionWaypoints(section) {
  return String(section || '').split(/[~∼\-→/]/).map((w) => w.replace(/\s+/g, '').replace(/\([^)]*\)/g, '')).filter(Boolean);
}

// ── 공식 코스 ↔ 등록 등산로 연결 ──────────────────────────────────────
// 다른 코스를 붙이면 그 등산로 행이 남의 선을 실선으로 보이게 되므로 엄격하게:
//   · 들머리가 (방향을 맞춘) 공식 선의 앞부분(처음 20%)에서 800m 안
//   · 등산로 이름의 마지막 지점이 공단 구간의 경유지에 있다(향로봉까지 가는 등산로에 안국사에서 끝나는 코스 X)
//   · 거리가 둘 다 있으면 ±33% 안(공단·등록 거리가 편도/왕복으로 다를 수 있어 2배·절반도 본다) — 일주문-서래봉 2.8km ≠ 능선일주 11.7km
//   · 들머리가 300m 안이거나 출발지 이름이 맞는다
const STRIP = /(탐방지원센터|탐방안내소|공원지킴터|지킴터|분소|주차장|매표소|입구|광장|야영장|탐방로|코스|원점회귀|왕복|종주|순환|정상)/g;
const tok = (w) => String(w || '').replace(/\s+/g, '').replace(/\([^)]*\)/g, '').replace(STRIP, '');
function headDist(c, p) {
  const part = c.parts[0];
  const lim = part.length * 0.2;
  let d = Infinity;
  for (let i = 0; i < part.pts.length && part.cum[i] <= lim; i += 2) d = Math.min(d, haversine(p[0], p[1], part.pts[i][0], part.pts[i][1]));
  return d;
}
function distErr(c, t) {
  const a = Number(c.distance_km), b = Number(t.distance_km);
  if (!(a > 0 && b > 0)) return null;
  const r = a / b;
  return Math.min(Math.abs(Math.log(r)), Math.abs(Math.log(r / 2)), Math.abs(Math.log(r * 2)));
}
/**
 * 공식 코스 c(parts·section·starts·distance_km)와 등록 등산로 t(name·start·distance_km·trailhead)가 같은 코스인가.
 * @returns {{dHead:number, score:number}|null} 낮은 score가 더 잘 맞음
 */
export function trailLinkCandidate(c, t) {
  if (!Array.isArray(t.trailhead) || !c.parts?.length) return null;
  const dHead = headDist(c, t.trailhead);
  if (dHead > 2500) return null;
  const wps = sectionWaypoints(c.section).map(tok).filter((w) => w.length >= 2);
  const startToks = [wps[0], ...(c.starts || []).map((x) => tok(x.name))].filter((w) => w && w.length >= 2);
  const tName = String(t.name || '').split(/[-~→]/).map(tok).filter((w) => w.length >= 2);
  const tText = tok(`${t.name || ''} ${t.start || ''}`);
  const courseTok = tok(c.official_name || c.name);     // '능선일주코스' → '능선일주'
  const nameOk = startToks.some((w) => tText.includes(w)) || !!(tName[0] && wps[0] && (wps[0].includes(tName[0]) || tName[0].includes(wps[0])))
    || (courseTok.length >= 3 && tText.includes(courseTok));
  const last = tName[tName.length - 1];
  const de = distErr(c, t);
  // 이름에 목적지가 없는 등산로('내장산 능선 일주 코스')는 거리가 거의 같을 때(±3%)만 목적지가 맞는 것으로 본다
  const destOk = tName.length > 1 ? wps.slice(1).some((x) => x === last || x.includes(last) || last.includes(x)) : de != null && de <= 0.03;
  const distOk = de == null ? dHead <= 300 && nameOk : de <= 0.29;
  if (!destOk || !distOk || !(dHead <= 300 || nameOk)) return null;
  // 들머리 좌표가 미덥지 않아 800m 넘게 어긋난 등산로는 거리까지 거의 같고(±3%) 출발지 이름이 맞을 때만
  // (내장산 능선 일주 11.7km, 화북-문장대-천왕봉 종주 12.9km, 어의곡-비로봉 5.1km)
  if (dHead > 800 && !(nameOk && de != null && de <= 0.03)) return null;
  // 거리 오차를 무겁게 친다 — 들머리가 조금 더 가까운 다른 길이(8.8km)보다 거리가 같은 길(11.7km)이 같은 코스다
  return { dHead, score: Math.min(dHead, 800) + (nameOk ? 0 : 300) + (de == null ? 150 : de * 3000) };
}
