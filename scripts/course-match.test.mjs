// scripts/lib/course-match.mjs — 공식 코스 선형을 OSM 길 위에 맞추는 규칙을 합성 그래프로 검사한다.
// 실행: node --test scripts/course-match.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathLength, pointToPolyline } from './lib/geo.mjs';
import {
  densifyParts, graphFromJSON, matchCourse, agreement, statusOf, shortOfGuide, sectionWaypoints, turnPoints, OFF_M,
} from './lib/course-match.mjs';

const turnPointsOf = (part) => turnPoints(part);

// 기준점(위도 37.5) 둘레를 미터 좌표로 그린다.
const LAT0 = 37.5, LON0 = 127.0;
const mLon = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const P = (x, y) => [LAT0 + y / 111320, LON0 + x / mLon];
/** 꺾은선 꼭짓점 → 촘촘한 점(약 step m 간격) */
function line(pts, step = 20) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push(P(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n));
  }
  return out;
}
const way = (id, pts, tags = { highway: 'path' }) => ({ type: 'way', id, tags, geometry: line(pts).map(([lat, lon]) => ({ lat, lon })) });
const osm = (...ways) => graphFromJSON({ elements: ways });
const lengthOf = (segs) => segs.reduce((s, x) => s + pathLength(x), 0);

test('공식 선이 돌아가는 길을 따르면, 더 짧은 지름길이 있어도 공식 선 쪽 길을 탄다', () => {
  const g = osm(way(1, [[0, 0], [1000, 0]]), way(2, [[0, 0], [250, 180], [500, 220], [750, 180], [1000, 0]]));
  const official = densifyParts(line([[0, 0], [250, 180], [500, 220], [750, 180], [1000, 0]], 5));
  const { segments, gaps } = matchCourse(g, official);
  assert.equal(segments.length, 1);
  assert.equal(gaps, 0);
  const ag = agreement(official, segments);
  assert.ok(ag.coverage > 0.95 && ag.precision > 0.95, JSON.stringify(ag));
  assert.ok(lengthOf(segments) > 1100, '지름길(1000m)이 아니라 돌아가는 길(약 1200m)');
});

test('왕복 코스(갔다가 같은 길로 돌아옴)를 지우지 않는다 — 칠불능선 0% 회귀 방지', () => {
  const g = osm(way(1, [[0, 0], [800, 0]]));
  const official = densifyParts(line([[0, 0], [800, 0], [0, 0]], 5));
  const { segments } = matchCourse(g, official);
  assert.equal(segments.length, 1);
  // 반환점(800m)까지 다녀와야 한다 — 반환점을 기준점으로 두지 않으면 앞뒤 기준점이 바로 이어져 끝이 잘린다.
  assert.ok(lengthOf(segments) > 1560, `왕복 길이 유지: ${Math.round(lengthOf(segments))}m`);
  const far = Math.max(...segments[0].map((p) => (p[1] - LON0) * mLon));
  assert.ok(far > 780, `반환점까지 감: ${Math.round(far)}m`);
});

test('반환점 찾기: 되돌아가는 곳 하나, 완만한 굽이는 아님', () => {
  const t = densifyParts(line([[0, 0], [500, 0], [0, 0]], 5)).flatMap(turnPointsOf);
  assert.equal(t.length, 1);
  assert.ok(Math.abs(t[0] - 500) <= 15, `반환점 ${Math.round(t[0])}m`);
  assert.equal(densifyParts(line([[0, 0], [300, 0], [500, 200], [500, 600]], 5)).flatMap(turnPointsOf).length, 0);
});

test('OSM에 길이 없는 구간은 직선으로 잇지 않고 선을 끊는다', () => {
  const g = osm(way(1, [[0, 0], [400, 0]]), way(2, [[1000, 0], [1400, 0]]));
  const official = densifyParts(line([[0, 0], [1400, 0]], 5));
  const { segments, gaps } = matchCourse(g, official);
  assert.equal(segments.length, 2);
  assert.ok(gaps >= 1);
  // 어느 조각도 400~1000m 빈 구간을 가로지르지 않는다
  for (const s of segments) assert.ok(pathLength(s) <= 450, `조각 ${Math.round(pathLength(s))}m`);
  const ag = agreement(official, segments);
  assert.ok(ag.coverage < 0.7 && ag.precision > 0.95, JSON.stringify(ag));
  assert.equal(statusOf(ag, gaps), 'rejected');
});

test('공식 길이 OSM에 없어 옆으로 크게 돌아간 부분은 잘라 내고 빈칸으로 둔다', () => {
  const g = osm(
    way(1, [[0, 0], [400, 0]]), way(2, [[800, 0], [1200, 0]]),
    way(3, [[400, 0], [400, 300], [800, 300], [800, 0]]),        // 300m 북쪽으로 돌아가는 다른 길
  );
  const official = densifyParts(line([[0, 0], [1200, 0]], 5));
  const { segments } = matchCourse(g, official);
  const off = official.flatMap((p) => p.pts);
  for (const s of segments) for (const p of s) assert.ok(pointToPolyline(p, off) <= OFF_M + 5, `공식 선에서 ${Math.round(pointToPolyline(p, off))}m`);
  assert.ok(segments.length >= 2, '돌아간 부분을 잘라 두 조각');
});

test('OSM 출입 금지 표시 길도 공식 선이 지나면 쓰고, 그 길이를 따로 잰다', () => {
  const g = osm(way(1, [[0, 0], [300, 0]]), way(2, [[300, 0], [700, 0]], { highway: 'path', access: 'no' }), way(3, [[700, 0], [1000, 0]]));
  const official = densifyParts(line([[0, 0], [1000, 0]], 5));
  const r = matchCourse(g, official);
  assert.equal(r.segments.length, 1);
  assert.ok(r.restrictedM >= 350 && r.restrictedM <= 450, `${r.restrictedM}m`);
});

test('판정 규칙', () => {
  assert.equal(statusOf({ coverage: 0.99, precision: 0.99 }, 0), 'accepted');
  assert.equal(statusOf({ coverage: 0.97, precision: 0.96 }, 1), 'accepted');   // 끝자락 몇십 m만 빈 경우
  assert.equal(statusOf({ coverage: 0.9, precision: 0.93 }, 1), 'review');
  assert.equal(statusOf({ coverage: 0.7, precision: 0.99 }, 0), 'rejected');
  // 안내 거리의 절반 언저리는 왕복 표기로 보고 넘어가고, 45%보다 짧을 때만 "일부 구간"
  assert.equal(shortOfGuide({ distance_km: 2, official_line_km: 0.83 }), true);
  assert.equal(shortOfGuide({ distance_km: 15, official_line_km: 7.4 }), false);
  assert.equal(shortOfGuide({ distance_km: null, official_line_km: 1 }), false);
});

test('구간 설명 → 경유지(물결표·하이픈·화살표 섞임, 괄호 설명 제거)', () => {
  assert.deepEqual(sectionWaypoints('노고단고개~임걸령~노루목~반야봉'), ['노고단고개', '임걸령', '노루목', '반야봉']);
  assert.deepEqual(sectionWaypoints('천왕봉 주차장 ∼ 도화리 안부 ∼ 천왕봉'), ['천왕봉주차장', '도화리안부', '천왕봉']);
  assert.deepEqual(sectionWaypoints('백담사-영시암→봉정암(대피소)/소청봉'), ['백담사', '영시암', '봉정암', '소청봉']);
});

test('공단 선이 지나지 않는 곳의 OSM 끊김(25m 틈)은 선을 나눈다 — 직선을 그리지 않는다', () => {
  // 공식 선은 북쪽으로 돌아가는 길(y=150)을 지나고, OSM에는 그 길 대신 y=0에 25m 끊긴 두 길만 있다
  const g = osm(way(1, [[0, 0], [500, 0]]), way(2, [[525, 0], [1000, 0]]));
  const official = densifyParts(line([[0, 0], [250, 40], [500, 40], [525, 40], [750, 40], [1000, 0]], 5));
  const { segments, stitchSplits } = matchCourse(g, official);
  assert.equal(stitchSplits, 1);
  assert.equal(segments.length, 2);
  for (const s of segments) for (let i = 1; i < s.length; i++) {
    const gap = Math.abs((s[i][1] - s[i - 1][1]) * mLon);
    assert.ok(gap < 24, `조각 안에 ${Math.round(gap)}m 직선`);
  }
});

test('공단 선이 바로 지나는 짧은 OSM 끊김(25m)은 잇는다 — 등산로는 이어져 있고 자료만 끊긴 곳', () => {
  const g = osm(way(1, [[0, 0], [500, 0]]), way(2, [[525, 0], [1000, 0]]));
  const official = densifyParts(line([[0, 0], [1000, 0]], 5));
  const { segments, stitchSplits } = matchCourse(g, official);
  assert.equal(stitchSplits, 0);
  assert.equal(segments.length, 1);
});
