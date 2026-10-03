import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrailNetwork, planTrailRoute, snapToTrail, plannedRouteGPX } from '../src/trailnetwork.js';
const p = (x, y = 0, ele = 100) => [36 + y / 1000, 128 + x / 1000, ele];
const route = (rid, points, extra = {}) => ({ rid, label: `경로 ${rid}`, latlngs: points, ...extra });

test('joins multiple routes at a shared junction and follows intermediate geometry', () => {
  const network = buildTrailNetwork([route(1, [p(0), p(1), p(2)]), route(2, [p(1), p(1, 1), p(2, 1)])]);
  const plan = planTrailRoute(network, [p(0), p(2, 1)]);
  assert.deepEqual(plan.latlngs, [p(0), p(1), p(1, 1), p(2, 1)].map(p => p.slice(0, 2)));
  assert.deepEqual(plan.sourceNames, ['경로 2', '경로 1']);
});
test('waypoint inside a long segment uses the partial length, not the nearest vertex', () => {
  const network = buildTrailNetwork([route(1, [p(0), p(10)])]);
  const partial = planTrailRoute(network, [p(2), p(8)]), whole = planTrailRoute(network, [p(0), p(10)]);
  assert.ok(Math.abs(partial.distance_m / whole.distance_m - 0.6) < 0.001);
  assert.ok(Math.abs(partial.points[0].lon - p(2)[1]) < 1e-8);
});
test('joins an endpoint that lies on another recorded segment', () => {
  const network = buildTrailNetwork([route(1, [p(0), p(2)]), route(2, [p(1), p(1, 1)])]);
  assert.equal(planTrailRoute(network, [p(0), p(1, 1)]).points.length, 3);
});
test('geometric crossings without a shared junction are not joined', () => {
  const network = buildTrailNetwork([route(1, [p(-1), p(1)]), route(2, [p(0, -1), p(0, 1)])]);
  assert.throws(() => planTrailRoute(network, [p(-1), p(0, 1)]), /잇는 경로가 없습니다/);
});
test('nearby but separated paths never gain a gap connector', () => {
  const network = buildTrailNetwork([route(1, [p(0), p(1)]), route(2, [p(1.1), p(2)])]);
  assert.throws(() => planTrailRoute(network, [p(0), p(2)]), /잇는 경로가 없습니다/);
});
test('plans correctly within a small component without snapping to the largest one', () => {
  const network = buildTrailNetwork([route(1, [p(0), p(1), p(2), p(3)]), route(2, [p(0, 5), p(1, 5)])]);
  assert.deepEqual(planTrailRoute(network, [p(0, 5), p(1, 5)]).sourceNames, ['경로 2']);
});
test('waypoint order supports a detour and return to the start', () => {
  const network = buildTrailNetwork([route(1, [p(0), p(1), p(2)])]);
  const outbound = planTrailRoute(network, [p(0), p(2)]);
  const roundtrip = planTrailRoute(network, [p(0), p(2), p(0)]);
  assert.ok(Math.abs(roundtrip.distance_m - 2 * outbound.distance_m) < 0.001);
  assert.equal(roundtrip.legs.length, 2);
  assert.deepEqual(roundtrip.latlngs[0], roundtrip.latlngs.at(-1));
});
test('rejects distant clicks instead of silently snapping across a valley', () => {
  const network = buildTrailNetwork([route(1, [p(0), p(1)])]);
  assert.throws(() => snapToTrail(network, p(0, 5)), /50m 이내/);
});
test('separate GPX segments and invalid geometry are not connected', () => {
  const network = buildTrailNetwork([route(1, [p(0), p(3)], { segments: [[p(0), p(1)], [p(2), p(3)]] })]);
  assert.throws(() => planTrailRoute(network, [p(0), p(3)]), /잇는 경로가 없습니다/);
  const invalid = buildTrailNetwork([route(1, [p(0), p(1), [NaN, 128], p(2), p(3)])]);
  assert.throws(() => planTrailRoute(invalid, [p(0), p(3)]), /잇는 경로가 없습니다/);
});
test('reference straight lines and previous plans are excluded from the network', () => {
  const network = buildTrailNetwork([route(1, [p(0), p(1)]), route(2, [p(1), p(2)], {planningEligible:false})]);
  assert.throws(() => planTrailRoute(network, [p(0), p(2)]), /50m 이내/);
});
test('deduplicates shared edges while retaining usable sources and elevations', () => {
  const network = buildTrailNetwork([route(1, [p(0, 0, 100), p(1, 0, 200)]), route(2, [p(0, 0, 100), p(1, 0, 200)])]);
  assert.equal(network.edges.length, 1);
  const plan = planTrailRoute(network, [p(0.25), p(0.75)]);
  assert.ok(Math.abs(plan.points[0].ele - 125) < 0.01);
  assert.ok(Math.abs(plan.points.at(-1).ele - 175) < 0.01);
});
test('exports escaped GPX with planned-route provenance and no fictitious elevation', () => {
  const network = buildTrailNetwork([route(1, [p(0).slice(0,2), p(1).slice(0,2)])]);
  const xml = plannedRouteGPX(planTrailRoute(network, [p(0), p(1)]), 'A & B <산>');
  assert.match(xml, /A &amp; B &lt;산&gt;/); assert.match(xml, /planned-hike/);
  assert.match(xml, /실측 기록이 아니며/); assert.match(xml, /OpenStreetMap contributors/);
  assert.doesNotMatch(xml, /<ele>/);
});
