// 들머리(trailhead) → 정상(summit) 실제 등산로 경로 찾기 + 주요 지점(봉우리/고개) 이름.
// OpenStreetMap(Overpass)의 등산로로 그래프를 만들고 최단 경로(Dijkstra)를 찾는다.
// 실제 좌표만 사용 — 경로를 지어내지 않는다(연결 실패 시 null 반환, 직선 폴백은 호출측에서).
import { haversine } from './gpx.js';
import { overpassFetch } from './osm.js';

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; const n = a.length; for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < n && a[l][0] < a[s][0]) s = l; if (r < n && a[r][0] < a[s][0]) s = r; if (s === i) break; [a[s], a[i]] = [a[i], a[s]]; i = s; } } return top; }
}

export async function routeTrailheadToSummit(trailhead, summit) {
  const straight = haversine(trailhead[0], trailhead[1], summit[0], summit[1]);
  if (straight > 15000) return null; // 아주 긴 종주 → 무거운 쿼리 회피(직선 폴백)
  // 코스가 길수록 실제 등산로가 직선 회랑을 벗어나 굽어지므로 여유 폭을 넉넉히
  const pad = Math.min(0.03, 0.012 + straight / 1e5 * 0.006);
  const s = Math.min(trailhead[0], summit[0]) - pad, n = Math.max(trailhead[0], summit[0]) + pad;
  const w = Math.min(trailhead[1], summit[1]) - pad, e = Math.max(trailhead[1], summit[1]) + pad;
  const bbox = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:25];(` +
    `way["highway"~"path|footway|track|steps|cycleway|pedestrian|service|bridleway|unclassified"](${bbox});` +
    `node["natural"="peak"]["name"](${bbox});node["natural"="saddle"]["name"](${bbox});node["mountain_pass"="yes"]["name"](${bbox});` +
    `);out geom;`;
  const json = await overpassFetch(q);
  const els = json.elements || [];
  const ways = els.filter((el) => el.type === 'way' && el.geometry?.length >= 2).map((el) => el.geometry.map((g) => [g.lat, g.lon]));
  const peaks = els.filter((el) => el.type === 'node' && el.tags?.name && el.lat != null).map((el) => ({ lat: el.lat, lon: el.lon, name: el.tags.name }));
  const route = pathfind(ways, trailhead, summit);
  return route ? { ...route, peaks } : (peaks.length ? { latlngs: null, peaks } : null);
}

function pathfind(ways, start, goal) {
  const key = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  const nodes = new Map();
  const adj = new Map();
  const addNode = (p) => { const k = key(p); if (!nodes.has(k)) { nodes.set(k, p); adj.set(k, []); } return k; };
  const addEdge = (a, b) => { const ka = addNode(a), kb = addNode(b), wt = haversine(a[0], a[1], b[0], b[1]); adj.get(ka).push([kb, wt]); adj.get(kb).push([ka, wt]); };
  const ends = new Set();
  for (const way of ways) { for (let i = 1; i < way.length; i++) addEdge(way[i - 1], way[i]); if (way.length) { ends.add(key(way[0])); ends.add(key(way[way.length - 1])); } }
  if (nodes.size < 2 || nodes.size > 40000) return null;

  // 끝점끼리 아주 가까우면(≤30m) 이어 붙여 데이터상의 미세한 끊김을 메운다(끝점 수가 많으면 생략)
  const endArr = [...ends];
  if (endArr.length <= 3000) {
    for (let i = 0; i < endArr.length; i++) for (let j = i + 1; j < endArr.length; j++) {
      const a = nodes.get(endArr[i]), c = nodes.get(endArr[j]); const d = haversine(a[0], a[1], c[0], c[1]);
      if (d > 0 && d < 30) { adj.get(endArr[i]).push([endArr[j], d]); adj.get(endArr[j]).push([endArr[i], d]); }
    }
  }

  // 연결 요소(BFS)를 구해 가장 큰 요소를 찾는다(작은 파편에 스냅되어 경로가 안 잡히는 문제 방지)
  const comp = new Map(); let cid = 0; const size = {};
  for (const k of nodes.keys()) {
    if (comp.has(k)) continue;
    cid++; const st = [k]; comp.set(k, cid); size[cid] = 0;
    while (st.length) { const u = st.pop(); size[cid]++; for (const [to] of adj.get(u)) if (!comp.has(to)) { comp.set(to, cid); st.push(to); } }
  }
  const big = +Object.keys(size).sort((a, b) => size[b] - size[a])[0];
  const nearestIn = (p, cc) => { let bk = null, bd = Infinity; for (const [k, q] of nodes) { if (comp.get(k) !== cc) continue; const d = haversine(p[0], p[1], q[0], q[1]); if (d < bd) { bd = d; bk = k; } } return { k: bk, d: bd }; };
  const S = nearestIn(start, big), G = nearestIn(goal, big);
  if (!S.k || !G.k || S.d > 1500 || G.d > 1500) return null; // 등산로 그물이 들머리/정상에 닿지 않음

  const dist = new Map([[S.k, 0]]); const prev = new Map();
  const pq = new MinHeap(); pq.push([0, S.k]);
  while (pq.size) {
    const [d, u] = pq.pop();
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (u === G.k) break;
    for (const [to, wt] of adj.get(u)) { const nd = d + wt; if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); prev.set(to, u); pq.push([nd, to]); } }
  }
  if (!dist.has(G.k)) return null;
  const path = [];
  let u = G.k; while (u) { path.unshift(nodes.get(u)); if (u === S.k) break; u = prev.get(u); }
  return { latlngs: [start, ...path, goal], dist_m: Math.round(dist.get(G.k)), snapStart: Math.round(S.d), snapGoal: Math.round(G.d) };
}
