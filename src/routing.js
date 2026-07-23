// 들머리(trailhead) → 정상(summit) 실제 등산로 경로 찾기.
// OpenStreetMap(Overpass)의 등산로 선들로 그래프를 만들고 최단 경로(Dijkstra)를 찾는다.
// 실제 좌표만 사용 — 경로를 지어내지 않는다(연결 실패 시 null 반환).
import { haversine } from './gpx.js';
import { overpassFetch } from './osm.js';

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) { const a = this.a; a.push(item); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a; const top = a[0]; const last = a.pop(); if (a.length) { a[0] = last; let i = 0; const n = a.length; for (;;) { const l = 2 * i + 1, r = l + 1; let s = i; if (l < n && a[l][0] < a[s][0]) s = l; if (r < n && a[r][0] < a[s][0]) s = r; if (s === i) break; [a[s], a[i]] = [a[i], a[s]]; i = s; } } return top; }
}

export async function routeTrailheadToSummit(trailhead, summit) {
  const pad = 0.008;
  const s = Math.min(trailhead[0], summit[0]) - pad, n = Math.max(trailhead[0], summit[0]) + pad;
  const w = Math.min(trailhead[1], summit[1]) - pad, e = Math.max(trailhead[1], summit[1]) + pad;
  const q = `[out:json][timeout:25];(way["highway"~"path|footway|track|steps"](${s},${w},${n},${e}););out geom;`;
  const json = await overpassFetch(q);
  const ways = (json.elements || []).filter((el) => el.geometry?.length >= 2).map((el) => el.geometry.map((g) => [g.lat, g.lon]));
  return pathfind(ways, trailhead, summit);
}

function pathfind(ways, start, goal) {
  const key = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  const nodes = new Map();
  const adj = new Map();
  const addNode = (p) => { const k = key(p); if (!nodes.has(k)) { nodes.set(k, p); adj.set(k, []); } return k; };
  const addEdge = (a, b) => { const ka = addNode(a), kb = addNode(b), wt = haversine(a[0], a[1], b[0], b[1]); adj.get(ka).push([kb, wt]); adj.get(kb).push([ka, wt]); };
  for (const way of ways) for (let i = 1; i < way.length; i++) addEdge(way[i - 1], way[i]);
  if (nodes.size < 2 || nodes.size > 20000) return null; // 데이터 없음/과다 → 포기

  const nearest = (p) => { let bk = null, bd = Infinity; for (const [k, q] of nodes) { const d = haversine(p[0], p[1], q[0], q[1]); if (d < bd) { bd = d; bk = k; } } return { k: bk, d: bd }; };
  const S = nearest(start), G = nearest(goal);
  if (!S.k || !G.k || S.d > 600 || G.d > 600) return null; // 등산로 그물이 들머리/정상에 닿지 않음

  const dist = new Map([[S.k, 0]]);
  const prev = new Map();
  const pq = new MinHeap(); pq.push([0, S.k]);
  while (pq.size) {
    const [d, u] = pq.pop();
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (u === G.k) break;
    for (const [to, wt] of adj.get(u)) { const nd = d + wt; if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); prev.set(to, u); pq.push([nd, to]); } }
  }
  if (!dist.has(G.k)) return null;

  const path = [];
  let u = G.k;
  while (u) { path.unshift(nodes.get(u)); if (u === S.k) break; u = prev.get(u); }
  // 실제 들머리/정상 좌표를 양끝에 이어 붙임(스냅 노드가 가까울 때)
  const full = [start, ...path, goal];
  return { latlngs: full, dist_m: Math.round(dist.get(G.k)), snapStart: Math.round(S.d), snapGoal: Math.round(G.d) };
}
