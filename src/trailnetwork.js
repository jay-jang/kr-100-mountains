// Plans use only connected, loaded geometry. Crossings without a shared vertex
// are not junctions; separated GPX segments never become invented connectors.
import { haversine } from './gpx.js';

const valid = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
const key = p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
const distance = (a, b) => haversine(a[0], a[1], b[0], b[1]);

class Heap {
  a = [];
  push(value) {
    const a = this.a; a.push(value); let i = a.length - 1;
    while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, first = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0;
      for (;;) { const l = i * 2 + 1, r = l + 1; let s = i;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === i) break; [a[i], a[s]] = [a[s], a[i]]; i = s;
      }
    }
    return first;
  }
}

function project(p, a, b) {
  const x = 111320 * Math.cos(p[0] * Math.PI / 180), y = 111320;
  const dx = (b[1] - a[1]) * x, dy = (b[0] - a[0]) * y;
  const t = Math.max(0, Math.min(1, (((p[1] - a[1]) * x * dx + (p[0] - a[0]) * y * dy) / (dx * dx + dy * dy || 1))));
  const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { point, t, distance_m: distance(p, point) };
}

export function buildTrailNetwork(routes) {
  const nodes = new Map(), edges = [], names = new Map(), ends = new Set(), edgeKeys = new Map();
  const nodeFor = p => {
    const id = key(p);
    if (!nodes.has(id)) nodes.set(id, { point: p.slice(0, 2), ele: Number.isFinite(p[2]) ? p[2] : null });
    else if (nodes.get(id).ele == null && Number.isFinite(p[2])) nodes.get(id).ele = p[2];
    return id;
  };
  for (const route of routes) {
    if (route.planningEligible === false) continue;
    names.set(route.rid, route.label);
    const segments = route.segments || route.track?.segments?.map(s => s.map(p => [p.lat, p.lon, p.ele])) || [route.latlngs];
    for (const segment of segments) {
      if (!Array.isArray(segment)) continue;
      let previous = null, first = null;
      for (const p of segment) {
        if (!valid(p)) { if (previous) ends.add(previous); previous = first = null; continue; }
        const id = nodeFor(p); if (!first) { first = id; ends.add(id); }
        if (previous && previous !== id) {
          const edgeKey = [previous, id].sort().join('|');
          const existing = edgeKeys.get(edgeKey);
          if (existing) existing.sources.add(route.rid);
          else { const edge = { id: edges.length, a: previous, b: id, sources: new Set([route.rid]) }; edges.push(edge); edgeKeys.set(edgeKey, edge); }
        }
        previous = id;
      }
      if (previous) ends.add(previous);
    }
  }

  // Match a track endpoint lying ON another recorded segment, within GPX
  // coordinate rounding (one metre). Never join merely nearby trail ends.
  const grid = new Map(), longEdges = [];
  const reference = nodes.values().next().value?.point || [36, 128];
  const scaleX = 111320 * Math.cos(reference[0] * Math.PI / 180), cell = 100;
  const xy = p => [Math.floor(p[1] * scaleX / cell), Math.floor(p[0] * 111320 / cell)];
  for (const edge of edges) {
    const a = xy(nodes.get(edge.a).point), b = xy(nodes.get(edge.b).point);
    const width = Math.abs(a[0] - b[0]) + 3, height = Math.abs(a[1] - b[1]) + 3;
    if (width * height > 2000) { longEdges.push(edge); continue; }
    for (let x = Math.min(a[0], b[0]) - 1; x <= Math.max(a[0], b[0]) + 1; x++)
      for (let y = Math.min(a[1], b[1]) - 1; y <= Math.max(a[1], b[1]) + 1; y++) {
        const id = `${x},${y}`; if (!grid.has(id)) grid.set(id, []); grid.get(id).push(edge);
      }
  }
  const splits = new Map();
  for (const id of ends) {
    const point = nodes.get(id).point, candidates = [...(grid.get(xy(point).join(',')) || []), ...longEdges];
    for (const edge of candidates) {
      if (edge.a === id || edge.b === id) continue;
      const snap = project(point, nodes.get(edge.a).point, nodes.get(edge.b).point);
      if (snap.t <= 1e-7 || snap.t >= 1 - 1e-7 || snap.distance_m > 1) continue;
      if (!splits.has(edge.id)) splits.set(edge.id, []);
      splits.get(edge.id).push({ id, t: snap.t });
    }
  }
  const connected = [];
  for (const edge of edges) {
    const cut = [{ id: edge.a, t: 0 }, ...(splits.get(edge.id) || []), { id: edge.b, t: 1 }].sort((a, b) => a.t - b.t);
    for (let i = 1; i < cut.length; i++) {
      if (cut[i - 1].id === cut[i].id) continue;
      const a = cut[i - 1].id, b = cut[i].id;
      connected.push({ id: connected.length, a, b, sources: edge.sources, distance_m: distance(nodes.get(a).point, nodes.get(b).point) });
    }
  }
  const adjacency = new Map([...nodes.keys()].map(id => [id, []]));
  for (const edge of connected) {
    adjacency.get(edge.a).push({ to: edge.b, edge }); adjacency.get(edge.b).push({ to: edge.a, edge });
  }
  return { nodes, edges: connected, adjacency, names };
}

export function snapToTrail(network, point, maxDistance = 50) {
  if (!valid(point)) throw new Error('올바른 위치를 선택하세요.');
  let best = null;
  for (const edge of network.edges) {
    const snap = project(point, network.nodes.get(edge.a).point, network.nodes.get(edge.b).point);
    if (!best || snap.distance_m < best.distance_m) best = { ...snap, edge };
  }
  if (!best || best.distance_m > maxDistance) throw new Error(`표시된 경로에서 ${maxDistance}m 이내의 지점을 선택하세요.`);
  return best;
}

export function planTrailRoute(network, waypoints) {
  if (waypoints.length < 2) throw new Error('출발과 도착 지점을 지정하세요.');
  const snaps = waypoints.map(p => snapToTrail(network, p.point || p));
  const nodes = new Map(network.nodes), adjacency = new Map([...network.adjacency].map(([id, links]) => [id, links.slice()]));
  const cuts = new Map();
  const ids = snaps.map(snap => {
    const edge = snap.edge;
    if (snap.t < 1e-7) return edge.a;
    if (snap.t > 1 - 1e-7) return edge.b;
    const id = `waypoint:${edge.id}:${snap.t.toFixed(8)}`;
    if (!nodes.has(id)) {
      const a = nodes.get(edge.a).ele, b = nodes.get(edge.b).ele;
      nodes.set(id, { point: snap.point, ele: a != null && b != null ? a + (b - a) * snap.t : null }); adjacency.set(id, []);
      if (!cuts.has(edge.id)) cuts.set(edge.id, []); cuts.get(edge.id).push({ id, t: snap.t });
    }
    return id;
  });
  for (const [edgeId, points] of cuts) {
    const edge = network.edges[edgeId];
    const chain = [{ id: edge.a, t: 0 }, ...points, { id: edge.b, t: 1 }].sort((a, b) => a.t - b.t);
    adjacency.set(edge.a, adjacency.get(edge.a).filter(link => link.edge !== edge));
    adjacency.set(edge.b, adjacency.get(edge.b).filter(link => link.edge !== edge));
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1].id, b = chain[i].id;
      const part = { ...edge, distance_m: distance(nodes.get(a).point, nodes.get(b).point) };
      adjacency.get(a).push({ to: b, edge: part }); adjacency.get(b).push({ to: a, edge: part });
    }
  }
  const path = [], used = new Set(), legs = []; let total = 0;
  for (let i = 1; i < ids.length; i++) {
    const start = ids[i - 1], goal = ids[i];
    const dist = new Map([[start, 0]]), prev = new Map(), heap = new Heap(); heap.push([0, start]);
    while (heap.a.length) {
      const [d, id] = heap.pop(); if (d !== dist.get(id)) continue; if (id === goal) break;
      for (const link of adjacency.get(id) || []) {
        const next = d + link.edge.distance_m;
        if (next < (dist.get(link.to) ?? Infinity)) { dist.set(link.to, next); prev.set(link.to, { from: id, edge: link.edge }); heap.push([next, link.to]); }
      }
    }
    if (!dist.has(goal)) throw new Error(`${i}번 지점과 ${i + 1}번 지점을 잇는 경로가 없습니다. 다른 지점을 선택하거나 연결 경로를 더 불러오세요.`);
    const leg = [goal]; let id = goal;
    while (id !== start) { const link = prev.get(id); used.add([...link.edge.sources][0]); id = link.from; leg.push(id); }
    leg.reverse(); path.push(...(path.length ? leg.slice(1) : leg)); total += dist.get(goal); legs.push({ distance_m: dist.get(goal) });
  }
  if (total < 1) throw new Error('서로 다른 출발·도착 지점을 선택하세요.');
  const points = path.map(id => { const n = nodes.get(id); return { lat: n.point[0], lon: n.point[1], ele: n.ele }; });
  return { points, latlngs: points.map(p => [p.lat, p.lon]), distance_m: total, legs, snaps, sourceIds: [...used], sourceNames: [...used].map(id => network.names.get(id)) };
}

const xmlEscape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export function plannedRouteGPX(plan, name) {
  if (!plan?.points?.length || !plan.distance_m) throw new Error('계산된 계획 경로가 없습니다.');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="대한민국 명산 안내서" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${xmlEscape(name)}</name><desc>산행 계획용 계산 경로. 실측 기록이 아니며 통제·출입 제한을 확인해야 합니다. 기반 경로: ${xmlEscape(plan.sourceNames.join(' / '))}. OpenStreetMap contributors (ODbL 1.0).</desc></metadata><trk><name>${xmlEscape(name)}</name><type>planned-hike</type><trkseg>${plan.points.map(p => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${Number.isFinite(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : ''}</trkpt>`).join('')}</trkseg></trk></gpx>`;
}
