// 경로 수집 파이프라인 공용 기하 유틸 (Node ESM, 의존성 없음).
// 좌표는 모두 [lat, lon] (WGS84 / EPSG:4326).

export const R_EARTH = 6371000;

export function haversine(la1, lo1, la2, lo2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLa = toRad(la2 - la1), dLo = toRad(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

// 위도 기준 국소 평면 근사(미터). 한국(위도 33~39°)에서 오차 무시 가능.
export function planar(refLat) {
  const mLat = 111320, mLon = 111320 * Math.cos((refLat * Math.PI) / 180);
  return { x: (lon) => lon * mLon, y: (lat) => lat * mLat };
}

export function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return d;
}

export function bboxOf(pts) {
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const [la, lo] of pts) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
  return { south: s, west: w, north: n, east: e };
}

// 점 → 선분 최단거리(미터).
export function pointToSegment(p, a, b, prj) {
  const Px = prj.x(p[1]), Py = prj.y(p[0]);
  const Ax = prj.x(a[1]), Ay = prj.y(a[0]);
  const Bx = prj.x(b[1]), By = prj.y(b[0]);
  const ABx = Bx - Ax, ABy = By - Ay;
  const ab2 = ABx * ABx + ABy * ABy;
  let t = ab2 ? ((Px - Ax) * ABx + (Py - Ay) * ABy) / ab2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = Ax + t * ABx, qy = Ay + t * ABy;
  return Math.hypot(Px - qx, Py - qy);
}

// 점 → 폴리라인 최단거리(미터).
export function pointToPolyline(p, line) {
  if (!line.length) return Infinity;
  if (line.length === 1) return haversine(p[0], p[1], line[0][0], line[0][1]);
  const prj = planar(p[0]);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d = pointToSegment(p, line[i - 1], line[i], prj);
    if (d < best) best = d;
  }
  return best;
}

// Douglas–Peucker 단순화. tolerance는 미터.
// 끝점은 항상 보존된다.
export function simplify(pts, toleranceM = 4) {
  if (pts.length <= 2) return pts.slice();
  const prj = planar(pts[0][0]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    let far = -1, maxD = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = pointToSegment(pts[i], pts[lo], pts[hi], prj);
      if (d > maxD) { maxD = d; far = i; }
    }
    if (maxD > toleranceM && far > 0) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// 인접 중복점(1m 미만) 제거 — 그래프 스냅 때문에 생기는 0길이 구간 정리.
export function dedupePoints(pts, minM = 1) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || haversine(last[0], last[1], p[0], p[1]) >= minM) out.push(p);
  }
  if (out.length < 2 && pts.length >= 2) return [pts[0], pts[pts.length - 1]];
  return out;
}

// GPS 튐(비현실적 점프) 제거 — 연속 두 점 간격이 maxJumpM를 넘으면 뒤 점을 버린다.
export function dropJumps(pts, maxJumpM = 2000) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const last = out[out.length - 1];
    if (haversine(last[0], last[1], pts[i][0], pts[i][1]) <= maxJumpM) out.push(pts[i]);
  }
  return out;
}

// 한반도 범위 밖 좌표는 즉시 폐기.
export const KR_BOUNDS = { south: 32.5, west: 124.0, north: 39.0, east: 132.0 };
export function inKorea([la, lo]) {
  return la >= KR_BOUNDS.south && la <= KR_BOUNDS.north && lo >= KR_BOUNDS.west && lo <= KR_BOUNDS.east;
}
