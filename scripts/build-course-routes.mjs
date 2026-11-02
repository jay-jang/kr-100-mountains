#!/usr/bin/env node
// 공식 탐방코스 → OpenStreetMap 등산로 위 GPX.
//
// 무엇을 만드는가
//   국립공원공단 탐방로 통합검색의 공식 코스(scripts/collect-knps-courses.mjs가 받은 로컬 캐시)를
//   하나씩 OpenStreetMap 등산로 그물 위에 다시 그린다. 공단 지도의 코스 선형은 "어느 길을 따라가는
//   코스인가"를 고르는 기준으로만 쓰고, 파일에 들어가는 좌표는 전부 OSM way 위의 점이다.
//     · 공식 선형을 일정 간격의 기준점으로 나누고, 기준점 사이를 "공식 선에서 멀어질수록 비싼"
//       비용으로 최단경로를 찾아 잇는다(지도 맞춤, map matching).
//     · OSM에 길이 없는 구간은 직선으로 잇지 않고 선을 끊는다(<trkseg> 여러 개).
//     · 공식 선형 대비 일치율(공식 선을 얼마나 덮는가 / 우리 선이 얼마나 공식 선 위에 있는가)을
//       재서 승인(accepted)·검토(review)·폐기(rejected)를 정한다.
//
// 무엇을 공개하는가
//   · public/gpx/courses/<코스id>.gpx           OSM 선형(ODbL) + DEM 고도
//   · public/gpx/courses/m/<산id>.json          그 산의 공식 코스 선 목록(일치율·거리·고도)
//   · public/gpx/courses/index.json             산별 건수·출처·통계
//   · data/official-courses.json                코스의 사실 정보(이름·구간·거리·시간·난이도·출처 링크)
//   공단 원본 좌표는 어디에도 넣지 않는다(공공누리 표시가 없어 재배포 불가 — collect-knps-courses.mjs 참고).
//
// 사용법
//   node scripts/build-course-routes.mjs                 # 전체(캐시 재사용)
//   node scripts/build-course-routes.mjs --only=120700V007,121500V001
//   node scripts/build-course-routes.mjs --no-elevation
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversine, pathLength, simplify, dedupePoints, inKorea, bboxOf, pointToPolyline } from './lib/geo.mjs';
import { overpass } from './lib/overpass.mjs';
import { ElevationDEM, elevationStats, ELEVATION_SOURCE, ELEVATION_LINK } from './lib/elevation.mjs';
import { toGPX } from './lib/gpx-write.mjs';
import { localMeta, localWays } from './lib/osm-local.mjs';
import {
  densifyParts, graphFromJSON, matchCourse, agreement, statusOf, shortOfGuide, sectionWaypoints, trailLinkCandidate,
  SIMPLIFY_M, SUMMIT_M, SUMMIT_NAMED_M, NEAR_M, PARK_M,
} from './lib/course-match.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KNPS_CACHE = join(ROOT, '.cache', 'knps', 'courses.json');
const MOUNTAIN_OSM_DIR = join(ROOT, '.cache', 'routes', 'osm');
const COURSE_OSM_DIR = join(ROOT, '.cache', 'routes', 'osm-courses');
const DEM_DIR = join(ROOT, '.cache', 'routes', 'dem');
const OUT_DIR = join(ROOT, 'public', 'gpx', 'courses');
const FACTS_FILE = join(ROOT, 'data', 'official-courses.json');

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  if (argv[i].includes('=')) return argv[i].slice(n.length + 3);
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : d;
};
const ONLY = (opt('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const NO_ELEV = argv.includes('--no-elevation');
const DEBUG = argv.includes('--debug');
const DUMP = opt('dump');   // 확인용: 코스별 공식 선·맞춘 선·주변 OSM 길을 GeoJSON으로(로컬 전용, 공개 금지)
const log = (...a) => console.log(...a);
const nowISO = () => new Date().toISOString();
const TODAY = nowISO().slice(0, 10);

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

const OSM_LINK = { href: 'https://www.openstreetmap.org/copyright', text: '© OpenStreetMap contributors (ODbL 1.0)' };
const KNPS_LINK = { href: 'https://www.knps.or.kr/front/portal/trails/search.do?menuNo=8000754', text: '코스 정보: 국립공원공단 탐방로 통합검색' };
const DISCLAIMER = '국립공원공단 공식 탐방코스의 경로를 OpenStreetMap 등산로 선형 위에 다시 그린 선입니다. '
  + 'OSM 길 끝이 30m 안으로 맞붙지 않은 곳은 공단 코스 선이 지나는 경우에만 짧게 이었습니다. '
  + '공단 원본 좌표가 아니며 실제 GPS 기록도 아닙니다. 탐방로 통제·입산시간지정제는 산행 전 공단 안내를 확인하세요.';

// ── OSM 자료: 산별 캐시 재사용 + 코스 묶음 질의 ─────────────────────────
// collect-routes.mjs와 같은 길 분류(같은 그래프 규칙)를 쓴다.
const WALK_CLASSES = ['path', 'footway', 'track', 'steps', 'bridleway', 'pedestrian', 'cycleway',
  'service', 'unclassified', 'residential', 'living_street'];
const MAJOR_CLASSES = ['tertiary', 'tertiary_link', 'secondary', 'secondary_link',
  'primary', 'primary_link', 'trunk', 'trunk_link', 'road'];
const WAY_FILTER = [...WALK_CLASSES, ...MAJOR_CLASSES].join('|');

const mountains = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'mountains.json'), 'utf8')).mountains;

// collect-routes.mjs의 mountainBBox·질의와 글자 하나까지 같아야 같은 캐시 파일(질의 해시)을 찾는다.
function mountainBBox(m) {
  const pts = [[m.lat, m.lon], ...(m.trails || []).filter((t) => t.trailhead).map((t) => t.trailhead)];
  const b = bboxOf(pts);
  const spread = Math.max(b.north - b.south, b.east - b.west);
  const pad = Math.min(0.045, 0.014 + spread * 0.25);
  return { south: b.south - pad, west: b.west - pad, north: b.north + pad, east: b.east + pad };
}
const bboxStr = (b) => `${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)}`;

/** 쓸 수 있는 OSM 캐시 목록: [{ file, bbox }] — 질의 bbox를 알고 있는 것만. */
function knownCaches() {
  const out = [];
  for (const m of mountains) {
    if (m.lat == null) continue;
    const b = mountainBBox(m);
    const q = `[out:json][timeout:180];(`
      + `way["highway"~"^(${WAY_FILTER})$"](${bboxStr(b)});`
      + `relation["route"="hiking"](${bboxStr(b)});`
      + `);out geom;`;
    const file = join(MOUNTAIN_OSM_DIR, `${m.id}-${createHash('sha1').update(q).digest('hex').slice(0, 8)}.json`);
    if (existsSync(file)) out.push({ file, bbox: b });
  }
  const idxFile = join(COURSE_OSM_DIR, 'index.json');
  if (existsSync(idxFile)) {
    for (const c of JSON.parse(readFileSync(idxFile, 'utf8'))) if (existsSync(join(COURSE_OSM_DIR, c.file))) out.push({ file: join(COURSE_OSM_DIR, c.file), bbox: c.bbox });
  }
  return out;
}
const contains = (outer, inner) => outer.south <= inner.south && outer.west <= inner.west && outer.north >= inner.north && outer.east >= inner.east;
const pad = (b, d) => ({ south: b.south - d, west: b.west - d, north: b.north + d, east: b.east + d });
const union = (a, b) => ({ south: Math.min(a.south, b.south), west: Math.min(a.west, b.west), north: Math.max(a.north, b.north), east: Math.max(a.east, b.east) });
const span = (b) => Math.max(b.north - b.south, b.east - b.west);

const COURSE_PAD = 0.006;     // 코스 bbox 여유(≈600m) — 공식 선 바로 옆 길까지 들어오게
const GROUP_SPAN = 0.16;      // 한 번에 받는 질의 bbox의 최대 변(≈17km)

async function ensureOSM(courses) {
  const caches = knownCaches();
  const need = courses.filter((c) => !caches.some((k) => contains(k.bbox, pad(c.bbox, COURSE_PAD))));
  log(`OSM 자료: 코스 ${courses.length}건 중 ${courses.length - need.length}건은 기존 캐시로 충분, ${need.length}건은 새로 받음`);
  const idxFile = join(COURSE_OSM_DIR, 'index.json');
  const idx = existsSync(idxFile) ? JSON.parse(readFileSync(idxFile, 'utf8')) : [];
  const pending = need.slice();
  while (pending.length) {
    const first = pending.shift();
    let box = pad(first.bbox, COURSE_PAD);
    const group = [first];
    for (let i = 0; i < pending.length;) {
      const u = union(box, pad(pending[i].bbox, COURSE_PAD));
      if (pending[i].park === first.park && span(u) <= GROUP_SPAN) { box = u; group.push(pending.splice(i, 1)[0]); }
      else i++;
    }
    const q = `[out:json][timeout:180];way["highway"~"^(${WAY_FILTER})$"](${bboxStr(box)});out geom;`;
    const hash = createHash('sha1').update(q).digest('hex').slice(0, 10);
    const file = `c-${hash}.json`;
    log(`  · ${first.park} ${group.length}건 묶음 bbox ${span(box).toFixed(3)}° 받는 중…`);
    await overpass(q, { cacheFile: join(COURSE_OSM_DIR, file), log: (s) => log(`    ${s}`), timeoutMs: 200000, tries: 6 });
    idx.push({ file, bbox: box, courses: group.map((c) => c.id) });
    writeAtomic(idxFile, JSON.stringify(idx, null, 1));
  }
}

// 로컬 추출본(scripts/lib/osm-local.mjs)이 준비돼 있으면 Overpass 대신 그것을 쓴다 — 공용 서버가 과부하일 때도 돈다.
const LOCAL = localMeta();
const graphCache = new Map();   // file → graph (최근 몇 개만)
function graphFor(bbox) {
  if (LOCAL) return graphFromJSON(localWays(pad(bbox, COURSE_PAD)));
  const caches = knownCaches().filter((k) => contains(k.bbox, pad(bbox, COURSE_PAD)));
  if (!caches.length) return null;
  // 가장 작은(빠른) 캐시를 고른다.
  caches.sort((a, b) => (a.bbox.north - a.bbox.south) * (a.bbox.east - a.bbox.west) - (b.bbox.north - b.bbox.south) * (b.bbox.east - b.bbox.west));
  const { file } = caches[0];
  if (DEBUG) log(`    OSM 캐시: ${file.split('/').pop()}`);
  if (graphCache.has(file)) return graphCache.get(file);
  const g = graphFromJSON(JSON.parse(readFileSync(file, 'utf8')));
  if (graphCache.size >= 3) graphCache.delete(graphCache.keys().next().value);
  graphCache.set(file, g);
  return g;
}

// ── 산 배정 ───────────────────────────────────────────────────────────
/** 코스 선에서 maxM 안에 정상이 있는 산들: [{ id, summit_dist_m }] (가까운 순) */
function nearbyMountains(parts, maxM) {
  const out = [];
  const line = parts.flatMap((p) => p.pts);
  const b = bboxOf(line);
  const padDeg = maxM / 90000;
  for (const m of mountains) {
    if (m.lat == null) continue;
    if (m.lat < b.south - padDeg || m.lat > b.north + padDeg || m.lon < b.west - padDeg * 1.3 || m.lon > b.east + padDeg * 1.3) continue;
    let d = Infinity;
    for (const p of parts) d = Math.min(d, pointToPolyline([m.lat, m.lon], p.pts.filter((_, i) => i % 3 === 0 || i === p.pts.length - 1)));
    if (d <= maxM) out.push({ id: m.id, summit_dist_m: Math.round(d) });
  }
  return out.sort((a, b2) => a.summit_dist_m - b2.summit_dist_m);
}

/** 정상을 지나는 코스 → 지나는 산 모두(정상 경유). 아니면 assignAll의 규칙. */
const squash = (s) => String(s || '').replace(/\s+/g, '');
/** 산 이름 + 정상 봉우리 이름(좌표 출처에 적힌 ○○봉·○○대) */
function summitNames(m) {
  const base = squash(m.name);
  const names = new Set([base]);
  for (const x of String(m.coord_source || '').matchAll(/([가-힣]{1,5}(?:봉|대))(?![가-힣])/g)) {
    names.add(x[1]);
    // '팔공산비로봉' → '비로봉' (산 이름이 앞에 붙은 봉우리 이름)
    if (x[1].startsWith(base) && x[1].length > base.length + 1) names.add(x[1].slice(base.length));
  }
  ['정상봉', '최고봉', '주봉'].forEach((n) => names.delete(n));
  return [...names].filter((n) => n.length >= 2);
}
/** 공식 구간 설명의 경유지(~ - → 로 나뉜 이름)가 정상 이름과 **정확히** 같을 때만 인정한다.
 *  부분 일치를 쓰면 '바래봉삼거리', '북한산성탐방지원센터', '속리산 체험학습관'이 정상으로 잡힌다. */
// 이름 없이 거리만으로 "정상 경유"라 하려면: 정상 SUMMIT_CLOSE_M 안을 지나거나, SUMMIT_M 안을 지나면서
// 선의 가장 높은 곳이 정상 높이(SRTM)에 SUMMIT_TERRAIN_M 안으로 닿아야 한다 — 정상 300m 옆 갈림길·다른 봉우리에서
// 끝나는 코스(팔공산 동봉, 적상산 안국사, 월출산 광암터삼거리)를 정상 경유로 치지 않게.
const SUMMIT_CLOSE_M = 120;
const summitEle = new Map();   // 산 id → 정상 둘레 60m의 SRTM 최고 고도(아래 실행부에서 채운다)
const SUMMIT_TERRAIN_M = 15;
function reachesSummit(c, x) {
  if (x.summit_dist_m <= SUMMIT_CLOSE_M) return true;
  if (x.summit_dist_m <= SUMMIT_M && c.lineMaxEle != null && summitEle.get(x.id) != null
    && c.lineMaxEle >= summitEle.get(x.id) - SUMMIT_TERRAIN_M) return true;
  if (x.summit_dist_m > SUMMIT_NAMED_M) return false;
  const waypoints = sectionWaypoints(c.section);
  const names = summitNames(mountains.find((m) => m.id === x.id));
  return waypoints.some((w) => names.includes(w) || names.some((n) => w === `${n}정상`));
}
/**
 * 정상을 지나지 않는 코스는
 *  · 정상이 NEAR_M(3km) 안인 가장 가까운 산, 없으면 NEAR2_M(6km) 안의 가장 가까운 산 — 단 구간이 다른 봉우리로 가면(도명산·단석산·마패봉) 빼고
 *  · 그리고 공원 이름과 같은 산(지리산국립공원 → 지리산, 변산반도 → 변산)에 PARK_M 안이면 함께 싣는다(공원 코스 목록)
 */
const NEAR2_M = 6000;
const namesakeOf = (park) => mountains.find((m) => m.lat != null && park && (park === m.name || (park.startsWith(m.name) && m.name.length >= 2)));
function namesOtherSummit(c, x) {
  const last = sectionWaypoints(c.section).slice(-1)[0] || '';
  if (!/(산|봉)(정상)?$/.test(last)) return false;
  const names = summitNames(mountains.find((m) => m.id === x.id));
  return !names.some((n) => last === n || last === `${n}정상`);
}
function assignAll(list) {
  for (const c of list) c.near = nearbyMountains(c.parts, PARK_M);
  for (const c of list) {
    const summit = c.near.filter((x) => reachesSummit(c, x));
    if (summit.length) { c.mountains = summit.map((x) => ({ ...x, reaches_summit: true })); continue; }
    const out = [];
    const near = c.near.find((x) => x.summit_dist_m <= NEAR_M)
      || c.near.find((x) => x.summit_dist_m <= NEAR2_M && !namesOtherSummit(c, x));
    if (near) out.push({ ...near, reaches_summit: false });
    const ns = namesakeOf(c.park);
    const nsHit = ns && c.near.find((x) => x.id === ns.id);
    if (nsHit && !out.some((x) => x.id === nsHit.id)) out.push({ ...nsHit, reaches_summit: false, by: 'park' });
    c.mountains = out;
  }
}

/** 확인용(--dump): 코스별 공식 선·맞춘 선·주변 OSM 길을 GeoJSON으로. 공단 좌표가 들어 있으므로 로컬에만 둔다. */
function dumpCourse(c, g, segs) {
  const b = pad(c.bbox, 0.004);
  const ways = [];
  const seen = new Set();
  for (const [k, p] of g.nodes) {
    if (p[0] < b.south || p[0] > b.north || p[1] < b.west || p[1] > b.east) continue;
    for (const [to, , ek] of g.adj.get(k)) {
      if (seen.has(ek)) continue; seen.add(ek);
      const q = g.nodes.get(to);
      ways.push([[p[1], p[0]], [q[1], q[0]]]);
    }
  }
  const fc = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { kind: 'osm' }, geometry: { type: 'MultiLineString', coordinates: ways } },
    ...c.parts.map((pt) => ({ type: 'Feature', properties: { kind: 'official' }, geometry: { type: 'LineString', coordinates: pt.pts.filter((_, i) => i % 3 === 0).map(([la, lo]) => [lo, la]) } })),
    ...segs.map((sg) => ({ type: 'Feature', properties: { kind: 'ours' }, geometry: { type: 'LineString', coordinates: sg.map(([la, lo]) => [lo, la]) } })),
    ...c.mountains.map((mm) => { const m = mountains.find((x) => x.id === mm.id); return { type: 'Feature', properties: { kind: 'summit', name: m.name }, geometry: { type: 'Point', coordinates: [m.lon, m.lat] } }; }),
  ] };
  mkdirSync(DUMP, { recursive: true });
  writeFileSync(join(DUMP, `${c.vcursId}.geojson`), JSON.stringify(fc));
}

// ── 실행 ─────────────────────────────────────────────────────────────
const knps = JSON.parse(readFileSync(KNPS_CACHE, 'utf8'));
// ── 선 방향 ───────────────────────────────────────────────────────────
// 공단 지도의 코스 선은 정상→들머리로 그려진 것도 있다(설악산 오색). 구간 설명의 첫 지점에서 시작하게 맞춘다(아래 orientCourse).
// 원점회귀(시작·끝 300m 안)는 두지 않는다.
function flip(c) {
  const l1 = (c.line || []).slice().reverse(), l2 = (c.line2 || []).slice().reverse();
  c.line = l2.length ? l2 : l1;
  c.line2 = l2.length ? l1 : [];
}
function lineEnds(c) {
  const all = [...(c.line || []), ...(c.line2 || [])];
  return all.length > 1 ? [all[0], all[all.length - 1]] : null;
}
const isLoopLine = (c) => { const e = lineEnds(c); return !e || haversine(e[0][0], e[0][1], e[1][0], e[1][1]) < 300; };
function shapeCourse(c) {
  c.parts = [...densifyParts(c.line), ...densifyParts(c.line2 || [])];
  const line = c.parts.flatMap((p) => p.pts);
  c.bbox = line.length ? bboxOf(line) : null;
  c.official_line_km = +(c.parts.reduce((x, p) => x + p.length, 0) / 1000).toFixed(2);
  return c;
}

const courses = knps.courses.map((raw) => {
  const c = { ...raw, id: `knps-${raw.vcursId.toLowerCase()}` };
  return shapeCourse(c);
}).filter((c) => c.parts.length && c.bbox && inKorea([c.bbox.south, c.bbox.west]));

// 공단 원자료 오류 걸러내기: 같은 공원의 다른 코스가 똑같은 구간 설명을 갖고 있고, 그 설명에 코스 이름의 지명이
// 하나도 없으면 다른 코스의 설명이 잘못 붙은 것이다(속리산 '법주사 ~ 수정봉'에 '천왕봉 주차장 ∼ 도화리 안부 ∼ 천왕봉').
// 그런 구간 설명은 싣지도, 정상 경유·방향 판단에 쓰지도 않는다.
{
  const groups = new Map();
  for (const c of courses) {
    if (!c.section) continue;
    const k = `${c.park}|${squash(c.section)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  for (const g of groups.values()) {
    if (g.length < 2 || new Set(g.map((c) => c.official_name)).size < 2) continue;
    for (const c of g) {
      const toks = String(c.official_name).split(/[~∼\-→/\s,]+/).map((w) => w.replace(/(코스|\(.*\))$/g, '')).filter((w) => w.length >= 2);
      if (toks.some((t) => squash(c.section).includes(t))) continue;
      log(`  구간 설명 제외(다른 코스와 같고 코스 이름과 무관): ${c.vcursId} ${c.official_name} — "${c.section}"`);
      c.section = null;
      c.section_dropped = true;
    }
  }
}

// 지형 고도: 정상 둘레의 최고 고도와 공식 선의 최고 고도(정상 경유 판단용, reachesSummit)
{
  const dem = new ElevationDEM(DEM_DIR);
  const around = ([la, lo], r = 60) => {
    const out = [];
    const dLa = r / 111320, dLo = r / (111320 * Math.cos((la * Math.PI) / 180));
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) out.push([la + (dLa * i) / 2, lo + (dLo * j) / 2]);
    return out;
  };
  const maxOf = (arr) => { const v = arr.filter(Number.isFinite); return v.length ? Math.max(...v) : null; };
  for (const m of mountains) if (m.lat != null) summitEle.set(m.id, maxOf(await dem.lookup(around([m.lat, m.lon]))));
  for (const c of courses) c.lineMaxEle = maxOf(await dem.lookup(c.parts.flatMap((p) => p.pts.filter((_, i) => i % 5 === 0))));
  dem.save();
}

// 산 배정은 언제나 전체 코스로 한다 — --only로 거른 뒤 배정하면 "같은 공원 안의 산" 규칙이 달라져
// 전체 실행과 다른 결과가 나온다(디버그 실행이 재현이 안 된다).
assignAll(courses);
// 대표 코스(data/famous-courses.json)가 공단 코스 안내(vcursId)를 근거로 든 경우, 그 산에도 반드시 싣는다 —
// 거리 규칙만으로는 지리산 '성삼재-노고단고개'가 반야봉에만 붙는 식으로 대표 코스와 공식 선이 갈라진다.
const vcursOf = (fc) => (fc.sources || []).map((x) => { try { return new URL(x.url).searchParams.get('vcursId'); } catch { return null; } }).find(Boolean) || null;
const famousRefs = new Map();     // 산 id → Set(그 산 대표 코스가 근거로 든 vcursId)
{
  const famous = JSON.parse(readFileSync(join(ROOT, 'data', 'famous-courses.json'), 'utf8'));
  const byV = new Map(courses.map((c) => [c.vcursId, c]));
  for (const fm of famous.mountains) for (const fc of fm.courses) {
    const v = vcursOf(fc);
    if (!v) continue;
    if (!famousRefs.has(fm.mountain_id)) famousRefs.set(fm.mountain_id, new Set());
    famousRefs.get(fm.mountain_id).add(v);
    const c = byV.get(v);
    if (!c || c.mountains.some((x) => x.id === fm.mountain_id)) continue;
    const m = mountains.find((x) => x.id === fm.mountain_id);
    let d = Infinity;
    for (const pt of c.parts) d = Math.min(d, pointToPolyline([m.lat, m.lon], pt.pts.filter((_, i) => i % 3 === 0 || i === pt.pts.length - 1)));
    const x = { id: m.id, summit_dist_m: Math.round(d) };
    c.mountains.push({ ...x, reaches_summit: reachesSummit(c, x), by: 'famous-course' });
    log(`  대표 코스 근거로 추가 배정: ${c.vcursId} ${c.official_name} → ${m.id}`);
  }
}

// 구간의 첫·끝 지점 위치를 찾아 방향을 정한다. 위치 후보는 이름이 **정확히** 같은 것만:
//   공단 출발 지점(.cache/knps, 싣지 않음) · 공단 시설 · OpenStreetMap 지명(.cache/osm/named-pois.json·peaks.json)
// 부분 일치는 쓰지 않는다 — '피아골삼거리'(능선 갈림길)를 '피아골탐방지원센터'(계곡 들머리)로 읽어 뒤집은 일이 있다.
// 공단 출발 지점 좌표는 수십 km 틀린 것도 있어(월출산) 선 끝 1.5km 안의 후보만 투표에 넣는다.
// 위치를 못 찾으면 정상 규칙: 구간이 정상에서 끝나면 정상에서 끝나게, 정상에서 시작하면 정상에서 시작하게,
// 원점회귀 구간을 한 방향만 그린 선은 오르는 방향으로, 정상 이름 없이 들머리(주차장·탐방지원센터…)로 시작하는 구간은
// 정상에서 먼 쪽에서 시작하게.
const FAC_SUFFIX = /(탐방지원센터|탐방안내소|공원지킴터|지킴터|분소|주차장\d*|소형|대형|야영장|입구|지구|매표소|광장)/g;
const facTok = (w) => squash(w).replace(/\([^)]*\)/g, '').replace(FAC_SUFFIX, '');
const TRAILHEADISH = /(주차장|탐방지원센터|탐방안내소|공원지킴터|지킴터|분소|매표소|입구|마을|야영장|지구|버스|정류장)$/;
const POIS = (() => {
  const out = [];
  try { for (const [, name, lat, lon] of JSON.parse(readFileSync(join(ROOT, '.cache', 'osm', 'named-pois.json'), 'utf8'))) out.push({ name, lat, lon }); } catch {}
  try { for (const p of JSON.parse(readFileSync(join(ROOT, '.cache', 'osm', 'peaks.json'), 'utf8'))) if (p.name) out.push({ name: p.name, lat: p.lat, lon: p.lon }); } catch {}
  return out;
})();
function locate(c, w) {
  const t = facTok(w), sq = squash(w).replace(/\([^)]*\)/g, '');
  if (sq.length < 2) return [];
  // 공단 시설·출발 지점은 '…탐방지원센터/분소/주차장' 꼬리를 뗀 이름까지 같으면 같은 곳으로 본다(도갑지구 ↔ 도갑탐방지원센터).
  // OSM 지명은 이름 전체가 같을 때만 — 꼬리를 떼면 '제비봉공원지킴터'가 봉우리 '제비봉'과, '갓바위탐방지원센터'가 '갓바위'와 같아진다.
  const exact = (name) => squash(name).replace(/\([^)]*\)/g, '') === sq;
  const same = (name) => exact(name) || (t.length >= 2 && facTok(name) === t);
  const b = pad(c.bbox, 0.03);
  return [
    ...(c.starts || []).filter((x) => Number.isFinite(x.lat) && same(x.name)),
    ...(c.facilities || []).filter((x) => same(x.name)),
    ...POIS.filter((x) => x.lat >= b.south && x.lat <= b.north && x.lon >= b.west && x.lon <= b.east && exact(x.name)),
  ];
}
function orientCourse(c) {
  if (isLoopLine(c)) return null;
  const wps = sectionWaypoints(c.section);
  const [a, b] = lineEnds(c);
  let votes = 0;
  const vote = (w, wantStart) => {
    for (const p of locate(c, w)) {
      const da = haversine(a[0], a[1], p.lat, p.lon), db = haversine(b[0], b[1], p.lat, p.lon);
      if (Math.min(da, db) > 1500 || Math.abs(da - db) < 300) continue;
      const nearStart = da < db;
      votes += nearStart === wantStart ? -1 : 1;     // +1 = 뒤집어야 한다
    }
  };
  // 원점회귀 구간(첫·끝 지점이 같은 곳 — 공단 표기 오타 '…세터/…센터'까지 앞 세 글자 이상 같으면)을 한 방향만 그린 선은
  // 두 지점 모두 출발 쪽이다 — 끝 지점을 "도착"으로 읽으면 오르는 선을 정상→들머리로 뒤집는다(지리산 백무동코스).
  const first = facTok(wps[0] || ''), lastT = facTok(wps[wps.length - 1] || '');
  let pre = 0; while (pre < first.length && pre < lastT.length && first[pre] === lastT[pre]) pre++;
  // 단, 끝 지점이 정상 이름 그대로면 원점회귀가 아니다('천왕봉 주차장 ∼ … ∼ 천왕봉').
  const summitM = c.mountains.find((x) => x.reaches_summit);
  const endIsSummit = !!summitM && summitNames(mountains.find((x) => x.id === summitM.id)).includes(wps[wps.length - 1]);
  const roundTrip = wps.length > 2 && !endIsSummit && (wps[0] === wps[wps.length - 1] || pre >= 3 || (first === lastT && first.length >= 2));
  if (wps.length >= 2) { vote(wps[0], true); vote(wps[wps.length - 1], roundTrip); }
  if (votes > 0) { flip(c); return 'name-flip'; }
  if (votes < 0) return 'name-ok';
  const mm = c.mountains.find((x) => x.reaches_summit);
  if (!mm || wps.length < 2) return null;
  const m = mountains.find((x) => x.id === mm.id);
  const names = summitNames(m);
  const da = haversine(a[0], a[1], m.lat, m.lon), db = haversine(b[0], b[1], m.lat, m.lon);
  const endsUp = names.includes(wps[wps.length - 1]), startsUp = names.includes(wps[0]);
  const midUp = wps.slice(1, -1).some((w) => names.includes(w));
  let flipIt = false;
  if (endsUp && !startsUp) flipIt = da < db;
  else if (startsUp && !endsUp) flipIt = db < da;
  else if (roundTrip) flipIt = da < db;
  else if (!midUp && TRAILHEADISH.test(wps[0]) && !TRAILHEADISH.test(wps[wps.length - 1])) flipIt = da < db;
  else if (!midUp && TRAILHEADISH.test(wps[wps.length - 1]) && !TRAILHEADISH.test(wps[0])) flipIt = db < da;
  if (flipIt) { flip(c); return 'summit-flip'; }
  return null;
}
for (const c of courses) {
  c.orient = orientCourse(c);
  if (c.orient === 'name-flip' || c.orient === 'summit-flip') shapeCourse(c);
}
log(`선 방향: 지명 기준 ${courses.filter((c) => c.orient === 'name-flip').length}건 뒤집음·${courses.filter((c) => c.orient === 'name-ok').length}건 확인 · 정상 기준 ${courses.filter((c) => c.orient === 'summit-flip').length}건 뒤집음 · 판단 못 함 ${courses.filter((c) => !c.orient && !isLoopLine(c)).length}건`);

const relevantAll = courses.filter((c) => c.mountains.length);
const relevant = ONLY.length ? relevantAll.filter((c) => ONLY.includes(c.vcursId) || ONLY.includes(c.id)) : relevantAll;

// ── 등록 등산로(m.trails)와 같은 코스 잇기 ────────────────────────────
// 같은 코스를 "등산로 행"과 "공식 코스 행"으로 두 번 보이지 않게 등산로 행에 공식 코스 선을 붙인다. 다른 코스를 붙이면
// 그 행이 남의 선을 실선으로 보이게 되므로 엄격하게: 들머리가 공식 선의 **앞부분**(처음 20%) 가까이 있고,
// 출발지·목적지 이름이나 거리가 맞아야 한다. 대표 코스가 근거로 든 코스는 대표 코스 행이 맡으므로 여기서 잇지 않는다.
{
  const cands = [];
  for (const c of relevantAll) for (const mm of c.mountains) {
    if (!mm.reaches_summit || famousRefs.get(mm.id)?.has(c.vcursId)) continue;
    const m = mountains.find((x) => x.id === mm.id);
    const officialTrails = new Set((m.famous_courses || []).filter((fc) => fc.trail_index != null && vcursOf(fc)).map((fc) => fc.trail_index));
    (m.trails || []).forEach((t, i) => {
      if (!Array.isArray(t.trailhead) || officialTrails.has(i)) return;
      const hit = trailLinkCandidate(c, t);
      if (hit) cands.push({ c, mm, i, t, ...hit });
    });
  }
  // 점수 → 코스 id → 등산로 번호 순(동점이 실행마다 뒤바뀌지 않게)
  cands.sort((a, b) => a.score - b.score || a.c.id.localeCompare(b.c.id) || a.i - b.i);
  const usedTrail = new Set();
  for (const x of cands) {
    const tk = `${x.mm.id}#${x.i}`;
    if (usedTrail.has(tk) || x.mm.trail_index != null) continue;
    usedTrail.add(tk);
    x.mm.trail_index = x.i;
    x.mm.trail_name = x.t.name;
    x.mm.trailhead_dist_m = Math.round(x.dHead);
  }
}
log(`공식 코스 ${courses.length}건 중 우리 산과 관련 ${relevantAll.length}건 (정상 경유 ${relevantAll.filter((c) => c.mountains.some((x) => x.reaches_summit)).length}건, 등산로 연결 ${relevantAll.reduce((n, c) => n + c.mountains.filter((x) => x.trail_index != null).length, 0)}건)${ONLY.length ? ` · 이번 실행 ${relevant.length}건` : ''}`);

if (LOCAL) log(`OSM 자료: 로컬 추출본 ${LOCAL.pbf} (스냅숏 ${LOCAL.snapshot})`);
else await ensureOSM(relevant);

const elev = NO_ELEV ? null : new ElevationDEM(DEM_DIR);
if (!ONLY.length) rmSync(OUT_DIR, { recursive: true, force: true });
const results = [];
let n = 0;
let stitchSplitCourses = 0;
for (const c of relevant) {
  n++;
  const g = graphFor(c.bbox);
  if (!g) { log(`  ✗ ${c.vcursId} OSM 자료 없음`); results.push({ c, status: 'rejected', reason: 'no-osm' }); continue; }
  const { segments, gaps, restrictedM, stitchSplits } = matchCourse(g, c.parts, { debug: DEBUG, log });
  if (stitchSplits) stitchSplitCourses++;
  const segs = segments.map((s) => simplify(dedupePoints(s), SIMPLIFY_M));
  if (DUMP) dumpCourse(c, g, segs);
  const ag = agreement(c.parts, segments);
  let status = segs.length ? statusOf(ag, gaps) : 'rejected';
  // 공단 지도의 코스 선이 안내 거리보다 훨씬 길면(대승폭포 0.9km 안내에 2.6km 선 — 대승령까지 그려짐) 승인하지 않는다.
  // 왕복을 한 선으로 그린 경우(안내의 2배)는 허용한다.
  const longOfGuide = Number(c.distance_km) > 0 && c.official_line_km > c.distance_km * 2.2;
  if (longOfGuide && status === 'accepted') status = 'review';
  const lenKm = +(segs.reduce((s, x) => s + pathLength(x), 0) / 1000).toFixed(2);
  const head = `  ${String(n).padStart(3)}/${relevant.length} ${c.vcursId} ${c.park} · ${c.official_name}`;
  if (status === 'rejected') {
    log(`${head} ✗ 덮음 ${Math.round(ag.coverage * 100)}% · 위 ${Math.round(ag.precision * 100)}% · 조각 ${segs.length}`);
    results.push({ c, status, agreement: ag, segments: segs.length });
    continue;
  }
  let eles = [];
  if (elev) {
    try { eles = await elev.lookup(segs.flat(), { log: () => {} }); } catch (e) { log(`    고도 실패: ${e.message}`); }
  }
  const segEles = []; let off = 0;
  for (const s of segs) { segEles.push(eles.slice(off, off + s.length)); off += s.length; }
  // 오름·내림은 조각마다 따로 재서 더한다 — 그리지 않은 빈 구간의 높이 차를 오르막으로 세지 않게.
  const per = segEles.map(elevationStats).filter((x) => x.gain_m != null);
  const es = per.length ? {
    gain_m: per.reduce((a, x) => a + x.gain_m, 0), loss_m: per.reduce((a, x) => a + x.loss_m, 0),
    min_ele: Math.min(...per.map((x) => x.min_ele)), max_ele: Math.max(...per.map((x) => x.max_ele)),
  } : elevationStats([]);
  const file = `courses/${c.id}.gpx`;
  const gpx = toGPX({
    name: `${c.park} · ${c.official_name}`,
    desc: DISCLAIMER,
    segments: segs.map((s, i) => ({ latlngs: s, eles: segEles[i] })),
    // OSM 스냅숏 날짜로 고정 — 다시 구워도 같은 선이면 파일이 바뀌지 않게(커밋 잡음 방지).
    time: LOCAL?.snapshot ? `${LOCAL.snapshot}T00:00:00Z` : nowISO(),
    links: [KNPS_LINK, OSM_LINK, ...(es.gain_m != null ? [ELEVATION_LINK] : [])],
    meta: {
      provenance: 'osm-matched', not_a_recorded_track: 'true',
      course_id: c.id, course_source: 'KNPS', course_name: c.official_name, park: c.park,
      mountain_ids: c.mountains.map((x) => x.id).join(','),
      geometry: 'OpenStreetMap ways matched to the official course path; no official coordinates included; short connectors (<=30 m) only where OSM way ends do not meet and the official course passes',
      match_coverage: ag.coverage, match_precision: ag.precision, segments: segs.length,
      osm_restricted_m: restrictedM || '',
      license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors',
      elevation_source: es.gain_m != null ? ELEVATION_SOURCE : '',
      osm_snapshot: LOCAL?.snapshot || TODAY, validation_status: status,
    },
  });
  writeAtomic(join(ROOT, 'public', 'gpx', file), gpx);
  log(`${head} ✓ ${status} 덮음 ${Math.round(ag.coverage * 100)}% · 위 ${Math.round(ag.precision * 100)}% · ${lenKm}km(공식 선 ${c.official_line_km}km)${segs.length > 1 ? ` · 조각 ${segs.length}` : ''}${restrictedM ? ` · OSM 금지표시 ${restrictedM}m` : ''}`);
  results.push({
    c, status, agreement: ag, segments: segs.length, gaps, segs,
    track: {
      file, kind: 'osm-matched', status,
      coverage: ag.coverage, precision: ag.precision, segments: segs.length,
      distance_km: lenKm, official_line_km: c.official_line_km, osm_restricted_m: restrictedM,
      ...(shortOfGuide(c) ? { guide_km: c.distance_km } : {}),
      ...(longOfGuide ? { guide_long_km: c.distance_km } : {}),
      points: segs.reduce((s, x) => s + x.length, 0),
      gain_m: es.gain_m, loss_m: es.loss_m, min_ele: es.min_ele, max_ele: es.max_ele,
      bytes: Buffer.byteLength(gpx),
    },
  });
}
elev?.save();
if (ONLY.length) { log('(--only 실행: 매니페스트·사실 파일은 갱신하지 않음)'); process.exit(0); }

// ── 사실 파일 + 매니페스트 ─────────────────────────────────────────────
const levelName = { 상: '어려움', 중: '보통', 하: '쉬움' };
const facts = {
  meta: {
    generated_at: nowISO(), generator: 'scripts/build-course-routes.mjs',
    source: { name: '국립공원공단 탐방로 통합검색', url: KNPS_LINK.href, fetched_at: knps.fetched_at },
    note: '코스 이름·구간·거리·시간·난이도는 공단 안내를 옮긴 사실 정보입니다. 지도 선은 OpenStreetMap 등산로 위에 다시 그린 것이며 공단 원본 좌표는 싣지 않습니다.',
  },
  courses: results.map(({ c, status, agreement: ag }) => ({
    id: c.id, source: 'knps', vcurs_id: c.vcursId, park: c.park,
    name: c.official_name, section: c.section,
    schedule: c.schedule_name, distance_km: c.distance_km, minutes: c.minutes,
    level: c.level_name, difficulty: levelName[c.level_name] || null,
    starts: [...new Set(c.starts.map((s) => s.name))],
    // 확인일 = 이 코스 자료를 공단에서 받은 날(빌드한 날이 아니다)
    url: c.url, checked_at: (c.fetched_at || knps.fetched_at || nowISO()).slice(0, 10),
    mountains: c.mountains,
    line: status === 'rejected' ? null : { status, coverage: ag.coverage, precision: ag.precision },
  })).sort((a, b) => a.id.localeCompare(b.id)),
};
writeAtomic(FACTS_FILE, JSON.stringify(facts, null, 1) + '\n');

const byMountain = new Map();
for (const r of results) {
  if (!r.track) continue;
  for (const mm of r.c.mountains) {
    if (!byMountain.has(mm.id)) byMountain.set(mm.id, []);
    // 그린 선과 그 산 정상 사이 가장 가까운 거리(80m 넘을 때만). 정상 경유 코스·정상 이름을 단 등산로·대표 코스 행에서
    // "지도 선이 정상까지 닿지 않습니다"로 알린다(바래봉 '정령치-바래봉-용산리'의 공단 선은 바래봉삼거리로 비켜 간다).
    const m = mountains.find((x) => x.id === mm.id);
    const gap = Math.round(Math.min(...r.segs.map((sg) => pointToPolyline([m.lat, m.lon], sg))));
    byMountain.get(mm.id).push({ course_id: r.c.id, name: r.c.official_name, reaches_summit: mm.reaches_summit,
      ...(gap > 80 ? { summit_gap_m: gap } : {}), ...r.track });
  }
}
for (const [id, list] of byMountain) writeAtomic(join(OUT_DIR, 'm', `${id}.json`), JSON.stringify({ mountain_id: id, courses: list }));
const tracks = results.filter((r) => r.track);
writeAtomic(join(OUT_DIR, 'index.json'), JSON.stringify({
  schema_version: 1, generated_at: nowISO(), generator: 'scripts/build-course-routes.mjs',
  what_this_is: '공식 탐방코스의 경로를 OpenStreetMap 등산로 선형 위에 다시 그린 선. 실측 기록도, 공단 원본 좌표도 아닙니다.',
  sources: [
    { name: '국립공원공단 탐방로 통합검색', role: '코스 목록·경로 기준(좌표는 싣지 않음)', url: KNPS_LINK.href },
    { name: LOCAL ? `OpenStreetMap (Geofabrik 추출본 ${LOCAL.snapshot || LOCAL.pbf})` : 'OpenStreetMap (Overpass API)', license: 'ODbL 1.0', url: 'https://www.openstreetmap.org/copyright', attribution: '© OpenStreetMap contributors' },
    { name: 'SRTM 1 arc-second (NASA/USGS) — AWS Terrain Tiles', role: '고도(추정)', url: 'https://registry.opendata.aws/terrain-tiles/' },
  ],
  stats: {
    official_courses: courses.length, related: relevant.length,
    lines: tracks.length, accepted: tracks.filter((r) => r.status === 'accepted').length, review: tracks.filter((r) => r.status === 'review').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
    total_bytes: tracks.reduce((s, r) => s + r.track.bytes, 0),
  },
  mountains: Object.fromEntries([...byMountain].map(([id, l]) => [id, l.length]).sort()),
}));
const st = { accepted: 0, review: 0, rejected: 0 };
results.forEach((r) => st[r.status]++);
log(`OSM 끊김(공단 선이 지나지 않는 30m 안 이음)에서 나눈 코스 ${stitchSplitCourses}건`);
log(`\n완료: 관련 코스 ${relevant.length}건 → 승인 ${st.accepted} · 검토 ${st.review} · 폐기 ${st.rejected} · 산 ${byMountain.size}곳 · ${(tracks.reduce((s, r) => s + r.track.bytes, 0) / 1048576).toFixed(2)}MB`);
