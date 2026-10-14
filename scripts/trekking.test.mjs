import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRoute, KIND_LABEL, KINDS, displayName, isGenericName, isExcludedName, normalizeName, parseDistanceKm,
  chainWays, splitByGap, lengthKm, minDistToPoint, douglasPeucker, bbox, clipToRadius,
  overlapFraction, selectRoutes, wikipediaUrl,
  clipToCircles, nearestAnchor, loopFlag, isLongDistance, seriesKey, isJapaneseName, inSouthKorea,
  splitToTiles, tileKey,
} from './lib/trekking.mjs';
import { haversine } from './lib/geo.mjs';

// 위도 37° 근방에서 x·y를 미터로 주는 점 생성기.
const LAT0 = 37, LON0 = 127;
const mLon = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const P = (xM, yM = 0) => [LAT0 + yM / 111320, LON0 + xM / mLon];

test('classifyRoute — 이름 신호가 섞인 경우의 우선순위', () => {
  const cases = [
    ['치악산 둘레길', 'dulle'],
    ['지리산둘레길 (가탄-송정)', 'dulle'],
    ['백두대간 등산로', 'ridge'],
    ['백두대간', 'ridge'],
    ['호남정맥', 'ridge'],
    ['오대산 월정사 전나무숲길', 'forest'],
    ['성판악코스', 'trail'],
    ['관음사코스', 'trail'],
    ['계족산 황톳길', 'forest'],
    ['제주올레 7코스', 'dulle'],
    ['Jeju Olle trail 7', 'dulle'],
    ['Ollegil 8', 'dulle'],
    ['평화누리길 9코스(율곡길)', 'dulle'],
    ['평화누리길 9코스', 'dulle'],
    ['[북한산둘레길] 1구간 소나무숲길', 'dulle'],      // 숲길보다 둘레길이 우선
    ['[서울둘레길] 7코스 / 일자산 코스', 'dulle'],      // 코스보다 둘레길이 우선
    ['여수 금오도 비렁길 3코스', 'dulle'],
    ['외씨버선길', 'dulle'],
    ['가마바우길', 'dulle'],
    ['회촌달맞이길', 'dulle'],                           // '…길' 노선은 걷기길로
    ['치악산바람길', 'dulle'],
    ['대관령 옛길', 'dulle'],
    ['Seoul City Trail', 'dulle'],
    ['지리산 화대종주 코스', 'ridge'],                  // 종주가 코스보다 우선
    ['선재길', 'forest'],
    ['치유의 숲길 1코스', 'forest'],                    // 숲길이 코스보다 우선
    ['Iljasan Mountain Forest Trail', 'forest'],
    ['동학사1코스', 'trail'],
    ['불곡산 등산로', 'trail'],
    ['설악산 공룡능선 탐방로', 'trail'],
    ['서울로 7017', 'other'],
    ['건계정 - 망실봉', 'trail'],                       // 들머리 - 봉우리
    ['거창항노화힐링랜드 주차장 - 의상봉', 'trail'],     // '힐링'보다 구간 꼴이 우선
    ['도리 - 비계산#', 'trail'],
    ['넘터 - 취우령', 'trail'],
    ['한국 트레킹 노선', 'dulle'],
    ['일광산 테마임도', 'forest'],
    ['서울둘레길 1코스 수락-불암산코스', 'dulle'],
    ['Daedeok science path 1', 'other'],
  ];
  for (const [name, kind] of cases) assert.equal(classifyRoute({ name }), kind, name);
  // 이름이 인자로 안 오면 태그에서 읽는다(name:ko 우선).
  assert.equal(classifyRoute({ tags: { 'name:ko': '한북정맥', name: 'Hanbuk' } }), 'ridge');
  // 이름 없이 from/to만 있는 국립공원 탐방로 구간 관계
  const seg = { from: '오색', to: '대청봉', route: 'hiking', distance: '4.8 km' };
  assert.equal(displayName(seg), '오색 – 대청봉');
  assert.equal(classifyRoute({ name: displayName(seg), tags: seg }), 'trail');
  assert.equal(displayName({ name: 'Ollegil 8', 'name:ko': '올레길 8코스' }), '올레길 8코스');
  assert.equal(displayName({}), '');
  for (const k of KINDS) assert.ok(KIND_LABEL[k], `label for ${k}`);
});

test('일반명·통제구간 이름 거르기', () => {
  for (const n of ['산책로', '2코스', '자연관찰로 (Jayeongwanchalro)', '1.631 km', '1.1Km 00:37', '천연황톳길(지붕형)', '치유의 숲길', '계곡탐방로', '자락길'])
    assert.equal(isGenericName(n), true, n);
  for (const n of ['올레길7', '애기능 산책로', '[서울둘레길] 20코스', '지리산둘레길 (가탄-송정)', '소나무 힐링숲길', 'Seoul City Trail', '중산두류생태탐방로'])
    assert.equal(isGenericName(n), false, n);
  for (const n of ['비법정탐방로', '비범정탐방로', '출입금지 구간', 'Restricted trail'])
    assert.equal(isExcludedName(n), true, n);
  assert.equal(isExcludedName('북한산둘레길'), false);
  assert.equal(normalizeName('[북한산둘레길] 4구간 솔샘길'), normalizeName('북한산둘레길 4구간  솔샘길'));
});

test('parseDistanceKm / wikipediaUrl', () => {
  assert.equal(parseDistanceKm('7.3 km'), 7.3);
  assert.equal(parseDistanceKm('12,5'), 12.5);
  assert.equal(parseDistanceKm('850 m'), 0.9);
  assert.equal(parseDistanceKm('약 3km'), null);
  assert.equal(parseDistanceKm(null), null);
  assert.equal(wikipediaUrl('ko:서울로 7017'), `https://ko.wikipedia.org/wiki/${encodeURIComponent('서울로_7017')}`);
  assert.equal(wikipediaUrl('nonsense'), null);
});

test('chainWays — 방향이 뒤집힌 way를 뒤집어 하나로 잇는다', () => {
  const a = [P(0), P(100), P(200)];
  const b = [P(400), P(300), P(200)];          // 끝점이 a의 끝점과 같고 방향은 반대
  const c = [P(-200), P(-100), P(0)];          // a의 머리 쪽에 붙는다
  const out = chainWays([b, a, c]);
  assert.equal(out.length, 1);
  const line = out[0];
  assert.equal(line.length, 7);                 // 3+3+3 정점 − 공유 끝점 2개
  const xs = line.map(([, lo]) => Math.round((lo - LON0) * mLon));
  // 방향은 시드에 따라 정해지므로 오름차순이든 내림차순이든 단조이기만 하면 된다.
  const mono = xs.every((x, i) => i === 0 || x > xs[i - 1]) || xs.every((x, i) => i === 0 || x < xs[i - 1]);
  assert.ok(mono, `monotone: ${xs}`);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [-200, 400]);
  assert.ok(Math.abs(lengthKm(out) - 0.6) < 0.002);
});

test('chainWays — 15 m 이내 간격은 잇고, 그보다 먼 간격은 따로 둔다', () => {
  const a = [P(0), P(100)];
  const near = [P(110), P(200)];               // 10 m 틈
  const far = [P(260), P(400)];                // 60 m 틈
  const out = chainWays([a, near, far]);
  assert.equal(out.length, 2);
  assert.equal(out[0].length, 4);               // a + near (틈이 있어 두 끝점 모두 유지)
  assert.equal(out[1].length, 2);
  assert.equal(chainWays([a, near, far], 100).length, 1);
});

test('splitByGap — 1.5 km 넘게 떨어진 동명 무리는 나눈다', () => {
  const items = [
    { id: 1, line: [P(0), P(500)] },
    { id: 2, line: [P(900), P(1500)] },        // 400 m 떨어짐 → 같은 무리
    { id: 3, line: [P(5000), P(5600)] },       // 3.5 km 떨어짐 → 다른 무리
  ];
  const groups = splitByGap(items, 1.5, (x) => x.line);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map((x) => x.id).sort(), [1, 2]);
  assert.deepEqual(groups[1].map((x) => x.id), [3]);
  // 정점이 멀어도 선분이 가까우면 같은 무리(정점-정점이 아니라 정점-선분 거리).
  const g2 = splitByGap([[P(0, 0), P(10000, 0)], [P(5000, 1000), P(5000, 3000)]], 1.5);
  assert.equal(g2.length, 1);
});

test('douglasPeucker — 허용오차 안의 굴곡은 지우고 끝점은 남긴다', () => {
  const pts = [P(0), P(100, 3), P(200, -2), P(300, 4), P(400)];
  const s = douglasPeucker(pts, 8);
  assert.deepEqual(s, [pts[0], pts[4]]);
  const bent = [P(0), P(100, 50), P(200)];
  assert.equal(douglasPeucker(bent, 8).length, 3);
});

test('minDistToPoint — 선분 위 사영점과 거리', () => {
  const lines = [[P(-1000, 300), P(1000, 300)], [P(0, 2000), P(0, 3000)]];
  const { km, point } = minDistToPoint(lines, LAT0, LON0);
  assert.ok(Math.abs(km - 0.3) < 0.001, `km=${km}`);
  assert.ok(haversine(point[0], point[1], ...P(0, 300)) < 1);
  assert.equal(minDistToPoint([], LAT0, LON0).km, Infinity);
});

test('clipToRadius — 원 밖 부분을 교점에서 자른다', () => {
  const line = [P(-2000), P(2000)];             // 중심을 지나는 4 km 선, 반경 1 km
  const { lines, clipped } = clipToRadius([line], LAT0, LON0, 1000);
  assert.equal(clipped, true);
  assert.equal(lines.length, 1);
  assert.ok(Math.abs(lengthKm(lines) - 2) < 0.01);
  // 원 밖으로 나갔다 들어오는 선은 두 조각
  const u = [P(-500, 0), P(-500, 2000), P(500, 2000), P(500, 0)];
  const r2 = clipToRadius([u], LAT0, LON0, 1000);
  assert.equal(r2.lines.length, 2);
  const inside = clipToRadius([[P(0), P(100)]], LAT0, LON0, 1000);
  assert.equal(inside.clipped, false);
});

test('bbox / overlapFraction', () => {
  const b = bbox([[P(0, 0), P(100, 200)]]);
  assert.equal(b.length, 4);
  assert.ok(b[0] < b[2] && b[1] < b[3]);
  const base = [[P(0), P(1000)]];
  assert.equal(overlapFraction([[P(100, 5), P(500, 5), P(900, 5)]], base, 25), 1);
  assert.equal(overlapFraction([[P(100, 500), P(500, 500)]], base, 25), 0);
});

test('selectRoutes — 종류 우선 정렬 + 종류별 자리 확보 후 상한', () => {
  const mk = (kind, dist, i) => ({ rid: `${kind}${i}`, kind, dist_km: dist, length_km: 1 });
  const routes = [
    ...Array.from({ length: 30 }, (_, i) => mk('dulle', i, i)),
    mk('ridge', 5, 0), mk('trail', 1, 0), mk('trail', 2, 1), mk('other', 0.5, 0),
  ];
  const { kept, dropped } = selectRoutes(routes, 25, 3);
  assert.equal(kept.length, 25);
  assert.equal(dropped.length, routes.length - 25);
  assert.ok(kept.some((r) => r.kind === 'ridge'));
  assert.equal(kept.filter((r) => r.kind === 'trail').length, 2);
  assert.ok(!kept.some((r) => r.kind === 'other'));   // 기타는 자리 확보 대상이 아니다
  // 정렬: 종류 순서 → 거리
  const order = kept.map((r) => KINDS.indexOf(r.kind));
  assert.ok(order.every((k, i) => i === 0 || k >= order[i - 1]));
  assert.equal(kept[0].rid, 'dulle0');
  // 반경 밖(먼) 노선은 자리 확보를 받지 못한다.
  const far = selectRoutes([...routes.slice(0, 30), mk('ridge', 9, 1)], 25, 3, 6);
  assert.ok(!far.kept.some((r) => r.kind === 'ridge'));
});

test('clipToCircles — 정상·들머리 원의 합집합 안쪽만 남긴다', () => {
  // 원 두 개(중심 0과 3 km, 반경 1 km) 사이를 지나는 직선: 원 안 두 토막만 남는다.
  const line = [P(-2000), P(5000)];
  const circles = [{ lat: LAT0, lon: LON0, r: 1000 }, { lat: P(3000)[0], lon: P(3000)[1], r: 1000 }];
  const { lines, clipped } = clipToCircles([line], circles);
  assert.equal(clipped, true);
  assert.equal(lines.length, 2);
  assert.ok(Math.abs(lengthKm(lines) - 4) < 0.01, `len=${lengthKm(lines)}`);
  // 겹치는 원은 한 토막으로 이어진다.
  const overlap = clipToCircles([line], [{ lat: LAT0, lon: LON0, r: 1000 }, { lat: P(1500)[0], lon: P(1500)[1], r: 1000 }]);
  assert.equal(overlap.lines.length, 1);
  assert.ok(Math.abs(lengthKm(overlap.lines) - 3.5) < 0.01);
  // 원 하나면 clipToRadius와 같다.
  const one = clipToCircles([line], [{ lat: LAT0, lon: LON0, r: 1000 }]);
  assert.deepEqual(one, clipToRadius([line], LAT0, LON0, 1000));
});

test('nearestAnchor — 정상·들머리 중 가까운 쪽, 정상 300 m 안을 지나면 정상 기준', () => {
  const summit = { kind: 'summit', lat: LAT0, lon: LON0 };
  const th = { kind: 'trailhead', lat: P(5000)[0], lon: P(5000)[1] };
  // 들머리 옆(정상에서 4.6 km)을 지나는 길 → 들머리 기준 0.4 km
  const a = nearestAnchor([[P(4600, -500), P(4600, 500)]], [summit, th]);
  assert.equal(a.anchor, 'trailhead');
  assert.ok(Math.abs(a.dist_km - 0.4) < 0.01);
  assert.equal(a.near_summit, false);
  assert.ok(haversine(a.entry[0], a.entry[1], ...P(4600, 0)) < 1);
  // 정상 200 m 옆을 지나 들머리까지 가는 길 → 들머리가 0 km여도 정상 기준(near_summit)
  const b = nearestAnchor([[P(0, 200), P(5000, 0)]], [summit, th]);
  assert.equal(b.near_summit, true);
  assert.equal(b.anchor, 'summit');
  assert.ok(b.dist_km < 0.3);
  assert.equal(nearestAnchor([], [summit]).anchor, null);
});

test('loopFlag — roundtrip 태그 우선, 없으면 시작·끝 200 m', () => {
  const ring = [P(0), P(1000), P(1000, 1000), P(0, 1000), P(0, 150)];
  const open = [P(0), P(1000), P(2000)];
  assert.equal(loopFlag({ roundtrip: 'yes', lines: [open] }), true);
  assert.equal(loopFlag({ roundtrip: 'no', lines: [ring] }), false);
  assert.equal(loopFlag({ lines: [ring] }), true);
  assert.equal(loopFlag({ lines: [open] }), false);
  assert.equal(loopFlag({ lines: [ring], complete: false }), null);          // 범위 밖으로 이어짐 → 판단 안 함
  // 60 m 틈으로 갈라진 두 조각은 100 m로 다시 이어 판단한다.
  assert.equal(loopFlag({ lines: [[P(0), P(1000), P(1000, 1000)], [P(1000, 1060), P(0, 1000), P(0, 100)]] }), true);
  // 서로 먼 두 조각은 판단하지 않는다.
  assert.equal(loopFlag({ lines: [[P(0), P(1000)], [P(5000), P(6000)]] }), null);
});

test('isLongDistance — 국가 도보망·장거리 브랜드', () => {
  for (const n of ['지리산둘레길 (금계-동강)', '[서울둘레길] 7코스 / 일자산 코스', '올레길7', '제주올레 7코스', 'Ollegil 8', '해파랑길 10코스',
    '평화누리길 9코스(율곡길)', '외씨버선길', 'DMZ 평화의 길', '백두대간트레일 1구간', '바우길 3구간', '남파랑길 1코스', '코리아둘레길'])
    assert.equal(isLongDistance({ name: n }), true, n);
  for (const n of ['[북한산둘레길] 12구간 - 충의길', '가마바우길', '고바우길', '구로올레길 하천형 2코스', 'Seoul City Trail', '치악산 둘레길', '불곡산 등산로'])
    assert.equal(isLongDistance({ name: n }), false, n);
  assert.equal(isLongDistance({ name: '한북정맥', network: 'nwn' }), true);
  assert.equal(isLongDistance({ name: '무명 노선', nameEn: 'Jirisan Trail (Inwol-Geumgye)' }), true);
});

test('seriesKey — 같은 노선의 구간끼리 같은 열쇠', () => {
  const same = (a, b) => assert.equal(seriesKey(a), seriesKey(b), `${a} ~ ${b}`);
  same('지리산둘레길 (금계-동강)', '지리산둘레길 (인월-금계)');
  same('[북한산둘레길] 12구간 - 충의길', '[북한산둘레길] 1구간 소나무숲길');
  same('[서울둘레길] 7코스 / 일자산 코스', '서울둘레길 1코스 수락-불암산코스');
  same('올레길7', 'Ollegil 8');
  same('올레길 16코스', '올레길6(A)');
  same('평화누리길11코스', '평화누리길 9코스(율곡길)');
  same('한라산 둘레길 2구간 (돌오름길)', '한라산둘레길 (수악길)');
  assert.equal(seriesKey('지리산둘레길 (금계-동강)'), '지리산둘레길');
  for (const n of ['백두대간', '오색 – 대청봉', '성판악코스', '외씨버선길', '가마바우길']) assert.equal(seriesKey(n), null, n);
});

test('전국 노선 거르기 — 일본·북한·이름', () => {
  for (const n of ['九州自然歩道 (Kyushu Nature Trail)', '油山登山道Aコース', '昭和池　健康ウォーキングコース', '観潮コース']) assert.equal(isJapaneseName(n), true, n);
  for (const n of ['지리산둘레길', 'Ollegil 8', '서울로 7017', '臨空里海ロード 한글']) assert.equal(isJapaneseName(n), false, n);
  const b = (minlat, minlon, maxlat, maxlon) => ({ minlat, minlon, maxlat, maxlon });
  assert.equal(inSouthKorea(b(35.2, 127.5, 35.4, 127.9)), true);          // 지리산
  assert.equal(inSouthKorea(b(33.2, 126.2, 33.5, 126.9)), true);          // 제주
  assert.equal(inSouthKorea(b(37.4, 130.8, 37.55, 130.95)), true);        // 울릉도
  assert.equal(inSouthKorea(b(35.04, 128.96, 37.22, 129.29)), true);      // 낙동정맥(부산~)
  assert.equal(inSouthKorea(b(33.43, 130.48, 33.84, 130.8)), false);      // 규슈
  assert.equal(inSouthKorea(b(34.2, 129.2, 34.6, 129.4)), false);         // 쓰시마
  assert.equal(inSouthKorea(b(38.67, 128.14, 38.68, 128.16)), false);     // 금강산(북한)
  assert.equal(inSouthKorea(b(38.1, 127.02, 38.24, 127.16)), true);       // 평화누리길 12코스(분계선 남쪽)
  assert.equal(inSouthKorea(b(35.3, 127.49, 38.27, 129.02)), true);       // 백두대간
});

test('splitToTiles — 1° 경계를 넘는 선은 양쪽 타일에 겹쳐 담는다', () => {
  const line = [[36.9, 127.5], [36.95, 127.6], [37.05, 127.7], [37.1, 127.8]];
  const t = splitToTiles([line]);
  assert.deepEqual([...t.keys()].sort(), ['36_127', '37_127']);
  assert.deepEqual(t.get('36_127')[0], [[36.9, 127.5], [36.95, 127.6], [37.05, 127.7]]);
  assert.deepEqual(t.get('37_127')[0], [[36.95, 127.6], [37.05, 127.7], [37.1, 127.8]]);
  assert.equal(tileKey(-0.5, 127.2), '-1_127');
});
