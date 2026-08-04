#!/usr/bin/env node
// 산별·코스별 등산 경로 GPX 수집기.
//
// 무엇을 만드는가
//   각 산의 등록된 들머리(trailhead) → 정상까지, OpenStreetMap 등산로 선형 위에서
//   실제로 이어지는 경로를 계산해 GPX로 굽는다. 코스마다 최단경로 1개 + 대안 경로 최대 2개.
//   덤으로 그 산을 지나는 OSM `route=hiking` 관계(둘레길·순환길 등)도 별도로 내보낸다.
//
// 무엇이 아닌가  ★ 중요
//   여기서 나오는 파일은 **사람이 GPS로 기록한 실측 트랙이 아니다.** 모든 좌표는 OSM에 실제로
//   등록된 등산로 선형 위의 점이지만, 경로 자체는 계산 결과다. 그래서 파일·매니페스트·디렉터리
//   어디에서도 "실측"으로 표기하지 않으며, 사용자가 직접 올리는 실측 GPX와 섞지 않는다.
//   (실측 GPX는 종전대로 public/gpx/<산id>.gpx 자리에 둔다.)
//
// 라이선스
//   선형: OpenStreetMap contributors, ODbL 1.0 — 재배포 시 출처 표시 필요
//   고도: SRTM 1 arc-second (NASA/USGS, public domain) — AWS Terrain Tiles 배포본.
//         무료 고도 API는 시간당 한도에 걸려 고도가 통째로 빠지므로 DEM 타일을 받아 로컬 샘플링한다.
//
// 사용법
//   node scripts/collect-routes.mjs                 # 전체(재개 가능)
//   node scripts/collect-routes.mjs --only=bukhansan,jirisan
//   node scripts/collect-routes.mjs --limit=10
//   node scripts/collect-routes.mjs --force         # 캐시·완료 표시 무시하고 다시
//   node scripts/collect-routes.mjs --no-elevation  # 고도 조회 생략(빠른 확인용)
//   node scripts/collect-routes.mjs --publish-only  # 이미 받은 결과로 매니페스트만 재생성
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversine, pathLength, simplify, dedupePoints, dropJumps, inKorea, pointToPolyline, bboxOf } from './lib/geo.mjs';
import { overpass, cachePath } from './lib/overpass.mjs';
import { buildGraph, findRoutes } from './lib/route-graph.mjs';
import { ElevationDEM, elevationStats, ELEVATION_SOURCE, ELEVATION_LINK } from './lib/elevation.mjs';
import { toGPX } from './lib/gpx-write.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = cachePath(ROOT);                          // .cache/routes  (gitignore 대상)
const OSM_DIR = join(CACHE, 'osm');
const RESULT_DIR = join(CACHE, 'results');
const DEM_DIR = join(CACHE, 'dem');
const OUT_DIR = join(ROOT, 'public', 'gpx', 'routes');
const REL_DIR = join(OUT_DIR, 'osm-relations');

const OSM_LINK = { href: 'https://www.openstreetmap.org/copyright', text: '© OpenStreetMap contributors (ODbL 1.0)' };
const DISCLAIMER = '실제 GPS 기록이 아닙니다. OpenStreetMap에 등록된 등산로 선형 위에서 계산한 경로이며, '
  + '현장 통제·훼손·출입 제한·계절 통제를 반영하지 않을 수 있습니다. 산행 전 공식 안내를 확인하세요.';

const ALGORITHM = 'dijkstra-grid-v1';
const SIMPLIFY_M = 3;            // 계산 경로 단순화 허용오차
const REL_SIMPLIFY_M = 8;        // 장거리 관계(둘레길 등)는 조금 더 과감히
const MAX_POINTS = 1200;
const REL_SUMMIT_MAX_M = 3000;   // 관계가 정상에서 이만큼 안쪽을 지나야 그 산 것으로 본다
const REL_PER_MOUNTAIN = 8;

// ── CLI ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
// `--only=a,b` 와 `--only a,b` 둘 다 받는다. 후자를 못 읽으면 사용자가 한 산만 돌리려다
// 149개 전체를 돌리게 된다(조용한 오작동이라 더 나쁘다).
const opt = (n, d = null) => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  if (argv[i].includes('=')) return argv[i].slice(n.length + 3);
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : d;
};
const ONLY = (opt('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(opt('limit', '0')) || 0;
const FORCE = flag('force');
const NO_ELEV = flag('no-elevation');
const PUBLISH_ONLY = flag('publish-only');

// --force로 다시 굽는 동안 같은 관계 파일을 여러 산이 참조해도 한 번만 쓰도록.
const relWritten = new Set();

const log = (...a) => console.log(...a);
// 중간에 죽어도 반쯤 쓰인 JSON이 남지 않도록 임시 파일 → rename.
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
const nowISO = () => new Date().toISOString();
const TODAY = nowISO().slice(0, 10);

// ── 입력 ─────────────────────────────────────────────────────────────
const data = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'mountains.json'), 'utf8'));
const mountains = data.mountains;

// 코스 식별자 — 코스명이 바뀌거나 순서가 바뀌어도 같은 파일을 가리키도록 이름+들머리 해시로 고정.
function routeKey(mountainId, trail) {
  const basis = `${mountainId}|${(trail.name || '').normalize('NFC')}|${(trail.trailhead || []).map((v) => v.toFixed(4)).join(',')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) { h ^= basis.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// ── Overpass ─────────────────────────────────────────────────────────
// 등산로·소로와 "큰 도로"를 나눠 받는다.
//   · 등산로 + 임도·마을길(service/track/unclassified/residential)은 같은 가중치.
//     실제 코스 초입이 포장 임도인 경우가 흔해(북한산성 코스) 벌점을 주면 오히려 경로가 나빠진다.
//   · tertiary 이상 큰 도로는 넣되 비싸게 친다 — 없으면 등산로망이 조각나 들머리와 정상이
//     다른 컴포넌트에 갇히고(금오산 컴포넌트 240 → 24), 같은 값으로 넣으면 차도로 크게 우회한다.
const WALK_CLASSES = ['path', 'footway', 'track', 'steps', 'bridleway', 'pedestrian', 'cycleway',
  'service', 'unclassified', 'residential', 'living_street'];
const MAJOR_CLASSES = ['tertiary', 'tertiary_link', 'secondary', 'secondary_link',
  'primary', 'primary_link', 'trunk', 'trunk_link', 'road'];
const WAY_FILTER = [...WALK_CLASSES, ...MAJOR_CLASSES].join('|');
const WALK_SET = new Set(WALK_CLASSES);

function mountainBBox(m) {
  const pts = [[m.lat, m.lon], ...(m.trails || []).filter((t) => t.trailhead).map((t) => t.trailhead)];
  const b = bboxOf(pts);
  // 코스가 길수록 실제 등산로가 직선 회랑을 벗어나므로 여유를 넉넉히 준다.
  const spread = Math.max(b.north - b.south, b.east - b.west);
  const pad = Math.min(0.045, 0.014 + spread * 0.25);
  return { south: b.south - pad, west: b.west - pad, north: b.north + pad, east: b.east + pad };
}

async function fetchMountainOSM(m) {
  const b = mountainBBox(m);
  const bbox = `${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)}`;
  const q = `[out:json][timeout:180];(`
    + `way["highway"~"^(${WAY_FILTER})$"](${bbox});`
    + `relation["route"="hiking"](${bbox});`
    + `);out geom;`;
  // 질의(필터·bbox)가 바뀌면 예전 캐시를 그대로 쓰면 안 되므로 파일명에 질의 해시를 넣는다.
  const qhash = createHash('sha1').update(q).digest('hex').slice(0, 8);
  const file = join(OSM_DIR, `${m.id}-${qhash}.json`);
  if (FORCE && existsSync(file)) rmSync(file);
  return overpass(q, { cacheFile: file, log });
}

// ── OSM 응답 해석 ─────────────────────────────────────────────────────
function extractWays(json) {
  const trails = [], roads = [];
  for (const e of json.elements || []) {
    if (e.type !== 'way' || !(e.geometry?.length >= 2)) continue;
    const line = e.geometry.map((g) => [g.lat, g.lon]);
    (WALK_SET.has(e.tags?.highway) ? trails : roads).push(line);
  }
  return { trails, roads };
}

// relation 멤버 way를 순서대로 이어 붙인다. 끊긴 곳은 건너뛰지 않고 조각으로 남겨
// 가장 긴 조각만 쓴다(없는 길을 이어 붙여 지어내지 않기 위해).
function stitchRelation(rel) {
  const segs = (rel.members || [])
    .filter((mm) => mm.type === 'way' && mm.geometry?.length >= 2)
    .map((mm) => mm.geometry.map((g) => [g.lat, g.lon]));
  if (!segs.length) return null;
  const chains = [];
  let cur = segs[0].slice();
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    const tail = cur[cur.length - 1];
    const dHead = haversine(tail[0], tail[1], s[0][0], s[0][1]);
    const dTail = haversine(tail[0], tail[1], s[s.length - 1][0], s[s.length - 1][1]);
    if (dHead <= 40) cur.push(...s.slice(1));
    else if (dTail <= 40) cur.push(...s.slice().reverse().slice(1));
    else { chains.push(cur); cur = s.slice(); }
  }
  chains.push(cur);
  chains.sort((a, b) => pathLength(b) - pathLength(a));
  return chains[0];
}

// ── 검증 ─────────────────────────────────────────────────────────────
// 단일 기준으로 자동 승인하지 않는다. 공간·거리를 합산해 점수를 매기고 상태를 남긴다.
function validate({ latlngs, dist_m, snapStart, snapGoal, trail, mountain }) {
  // 치명적 결격(fatal)과 참고 경고(warnings)를 나눈다.
  // 경고 하나로 쓸 만한 경로를 버리면 수확이 급감하므로, 경고는 점수에만 반영하고
  // 값 자체를 매니페스트에 남겨 사용자가 판단할 수 있게 한다.
  const fatal = [], warnings = [];
  if (latlngs.length < 2) fatal.push('점이 2개 미만');
  if (!latlngs.every(inKorea)) fatal.push('한반도 범위 밖 좌표');
  if (dist_m < 250) fatal.push('총거리 250m 미만');
  if (dist_m > 80000) fatal.push('총거리 80km 초과');

  // 정상 근접도 (30점) — 등산로 그물이 정상에 닿지 않으면 '정상 등정 경로'가 아니다.
  let score = 0;
  const sg = snapGoal;
  score += sg < 100 ? 30 : sg < 300 ? 24 : sg < 700 ? 14 : 0;
  if (sg >= 700) fatal.push(`정상에서 등산로까지 ${sg}m — 정상 미도달`);
  else if (sg >= 300) warnings.push(`정상 스냅 ${sg}m`);

  // 들머리 근접도 (25점) — 멀면 코스 앞부분이 빠진 것일 뿐, 트랙 자체는 실제 등산로다.
  const ss = snapStart;
  score += ss < 150 ? 25 : ss < 500 ? 19 : ss < 1000 ? 11 : ss < 1500 ? 4 : 0;
  if (ss >= 500) warnings.push(`들머리에서 ${ss}m 떨어진 지점에서 시작(앞 구간 누락)`);

  // 등록 거리와의 비교 (25점). 등록값이 편도인지 왕복인지 데이터에 정의가 없으므로
  // 세 가설을 모두 평가하고 가장 잘 맞는 것을 기록만 한다 — 등록값을 덮어쓰지 않는다.
  let distRatio = null, distHypothesis = null, distFarOff = false;
  const claim = Number(trail.distance_km);
  if (Number.isFinite(claim) && claim > 0) {
    const km = dist_m / 1000;
    // 이 트랙은 들머리→정상 편도다. 따라서 등록값이 편도이거나(≈1배), 왕복이거나(≈절반)
    // 둘 중 하나여야 한다. "등록값의 2배"는 편도 트랙에서 성립할 수 없으므로 가설에서 뺀다
    // — 넣어 두면 2배 길게 잘못 잡힌 경로가 만점을 받는다(운악산에서 확인).
    const cands = [['one-way', claim], ['registry-is-round-trip', claim / 2]];
    let best = null;
    for (const [hyp, target] of cands) {
      const r = km / target;
      const err = Math.abs(Math.log(r));
      if (!best || err < best.err) best = { hyp, r, err };
    }
    distRatio = +best.r.toFixed(3);
    distHypothesis = best.hyp;
    const dev = Math.abs(1 - best.r);
    score += dev <= 0.15 ? 25 : dev <= 0.3 ? 18 : dev <= 0.5 ? 9 : 0;
    if (dev > 0.35) warnings.push(`등록 거리와 ${Math.round(dev * 100)}% 차이(${best.hyp} 기준)`);
    distFarOff = dev > 0.5;
  } else {
    score += 12;   // 비교할 등록 거리가 없으면 중립 처리
  }

  // 정상 실제 좌표와 경로의 최단거리 (20점) — 스냅 지점이 아니라 선 전체 기준
  const dSummit = pointToPolyline([mountain.lat, mountain.lon], latlngs);
  score += dSummit < 100 ? 20 : dSummit < 300 ? 15 : dSummit < 700 ? 8 : 0;

  // 정상 근접(30)과 경로–정상 최단거리(20)는 계산 경로에서 사실상 같은 것을 두 번 재는 셈이라,
  // 끝점만 정확하면 거리가 크게 어긋나도 75점(=accepted)에 닿는다. 등록 거리와 50% 넘게
  // 다르면 "다른 코스일 가능성"이므로 자동 승인은 막고 사람 확인으로 내린다.
  const status = fatal.length ? 'rejected'
    : score >= 75 && !distFarOff ? 'accepted' : score >= 50 ? 'review' : 'rejected';

  return { score, status, fatal, warnings, distRatio, distHypothesis, summit_dist_m: Math.round(dSummit) };
}

// ── 산 하나 처리 ──────────────────────────────────────────────────────
async function processMountain(m, elev, relIndex) {
  const resultFile = join(RESULT_DIR, `${m.id}.json`);
  if (!FORCE && existsSync(resultFile)) {
    // 쓰다가 끊겨 잘린 JSON이면 건너뛰지 말고 다시 처리한다(예외로 이 산을 영영 못 하게 되는 것 방지).
    try {
      const prev = JSON.parse(readFileSync(resultFile, 'utf8'));
      log(`· ${m.id} — 이미 처리됨 (${prev.tracks.length}트랙) 건너뜀`);
      return prev;
    } catch { log(`· ${m.id} — 이전 결과가 손상됨, 다시 처리합니다`); }
  }

  // 다시 구울 때는 이 산의 이전 산출물을 먼저 비운다 — 이번에 rejected로 바뀐 코스의
  // 예전 GPX가 고아로 남아 매니페스트에 없는 파일이 커밋되는 것을 막는다.
  if (FORCE) rmSync(join(OUT_DIR, m.id), { recursive: true, force: true });

  const t0 = Date.now();
  let json;
  try {
    json = await fetchMountainOSM(m);
  } catch (e) {
    log(`✗ ${m.id} — Overpass 실패: ${e.message}`);
    return { id: m.id, error: `overpass: ${e.message}`, tracks: [], relations: [] };
  }

  const { trails: walkWays, roads: majorWays } = extractWays(json);
  const g = buildGraph(walkWays, majorWays);
  log(`· ${m.id} — 보행가능 way ${walkWays.length} + 큰도로 ${majorWays.length}, 노드 ${g.nodes.size}, 이어붙임 ${g.stitchedCount}`);

  const tracks = [];
  // 같은 들머리를 공유하는 코스가 흔해(명지산 #1·#2 등) 완전히 같은 트랙이 여러 번 나온다.
  // 좌표열 해시로 잡아 파일은 한 번만 쓰고, 매니페스트에서는 두 코스가 같은 파일을 가리키게 한다.
  const seenGeom = new Map();   // 좌표 해시 → { file, route_id, name }
  const trails = (m.trails || []);
  for (const [idx, trail] of trails.entries()) {
    if (!trail.trailhead) { log(`    #${idx + 1} "${(trail.name || '').slice(0, 26)}" — 들머리 좌표 없음, 건너뜀`); continue; }
    const { routes, reason } = findRoutes(g, trail.trailhead, [m.lat, m.lon]);
    if (!routes.length) { log(`    #${idx + 1} "${(trail.name || '').slice(0, 26)}" — 경로 없음 (${reason})`); continue; }

    let primaryAccepted = false;
    for (const r of routes) {
      // 최단경로부터 미덥지 않으면(들머리 좌표 오류 등) 대안은 더 멀리 헤맨 결과일 뿐이다.
      // 수가 아니라 쓸 만한 경로를 모으는 게 목적이므로 여기서 끊는다.
      if (r.variant > 0 && !primaryAccepted) {
        log(`    #${idx + 1}  ↳ 최단경로가 accepted가 아니라 대안 ${routes.length - 1}개 생략`);
        break;
      }
      let pts = dedupePoints(dropJumps(r.latlngs));
      pts = simplify(pts, SIMPLIFY_M);
      if (pts.length > MAX_POINTS) pts = simplify(pts, SIMPLIFY_M * 3);
      const dist_m = Math.round(pathLength(pts));
      const v = validate({ latlngs: pts, dist_m, snapStart: r.snapStart, snapGoal: r.snapGoal, trail, mountain: m });
      const rk = routeKey(m.id, trail);
      const variantSuffix = r.variant ? String.fromCharCode(97 + r.variant) : '';   // a, b
      const fileName = `${m.id}-${String(idx + 1).padStart(2, '0')}${variantSuffix}.gpx`;
      const label = `${m.name} · ${trail.name || `코스 ${idx + 1}`}${r.variant ? ` (대안 ${r.variant})` : ''}`;

      if (v.status === 'rejected') {
        const why = [...v.fatal, ...v.warnings].join(', ');
        log(`    #${idx + 1}${variantSuffix || ' '} ✗ ${v.score}점 — ${why}`);
        tracks.push({ route_id: `${m.id}-${rk}`, variant: r.variant, status: 'rejected', score: v.score, fatal: v.fatal, warnings: v.warnings, file: null, name: label });
        continue;
      }

      // 같은 좌표열이 이미 나왔으면 파일을 또 쓰지 않고 같은 파일을 가리킨다.
      // (고도 조회도 건너뛰므로 API 호출이 크게 준다)
      const geomHash = createHash('sha1')
        .update(pts.map(([la, lo]) => `${la.toFixed(6)},${lo.toFixed(6)}`).join(';')).digest('hex').slice(0, 16);
      const dup = seenGeom.get(geomHash);
      if (dup) {
        if (r.variant === 0) primaryAccepted = v.status === 'accepted';
        log(`    #${idx + 1}${variantSuffix || ' '} = ${dup.file.split('/').pop()} 와 동일 — 파일 재사용`);
        tracks.push({
          route_id: `${m.id}-${rk}`, route_index: idx + 1, route_name: trail.name || null,
          variant: r.variant, name: label, file: dup.file, kind: 'osm-routed',
          status: v.status, score: v.score, warnings: v.warnings,
          duplicate_of: dup.route_id, geom_sha1: geomHash,
          distance_km: +(dist_m / 1000).toFixed(2),
          registry_distance_km: Number.isFinite(Number(trail.distance_km)) ? Number(trail.distance_km) : null,
          distance_ratio: v.distRatio, distance_hypothesis: v.distHypothesis,
          points: pts.length,
          snap_trailhead_m: r.snapStart, snap_summit_m: r.snapGoal, summit_dist_m: v.summit_dist_m,
        });
        continue;
      }

      let eles = [];
      if (!NO_ELEV) { try { eles = await elev.lookup(pts, { log }); } catch (e) { log(`      고도 실패: ${e.message}`); } }
      const es = elevationStats(eles);

      const gpx = toGPX({
        name: `${label} (OSM 계산 경로)`,
        desc: DISCLAIMER,
        latlngs: pts,
        eles,
        time: nowISO(),
        links: [OSM_LINK, ...(es.gain_m != null ? [ELEVATION_LINK] : [])],
        meta: {
          provenance: 'osm-routed',
          not_a_recorded_track: 'true',
          mountain_id: m.id, mountain_name: m.name_full || m.name,
          route_id: `${m.id}-${rk}`, route_index: idx + 1, route_name: trail.name || '',
          variant: r.variant,
          source: 'OpenStreetMap via Overpass API',
          license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors',
          elevation_source: es.gain_m != null ? ELEVATION_SOURCE : '',
          algorithm: ALGORITHM, osm_snapshot: TODAY,
          snap_trailhead_m: r.snapStart, snap_summit_m: r.snapGoal,
          validation_score: v.score, validation_status: v.status,
        },
      });

      const outPath = join(OUT_DIR, m.id, fileName);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, gpx);

      tracks.push({
        route_id: `${m.id}-${rk}`, route_index: idx + 1, route_name: trail.name || null,
        variant: r.variant, name: label,
        file: `routes/${m.id}/${fileName}`,
        kind: 'osm-routed',
        status: v.status, score: v.score, warnings: v.warnings, geom_sha1: geomHash,
        distance_km: +(dist_m / 1000).toFixed(2),
        registry_distance_km: Number.isFinite(Number(trail.distance_km)) ? Number(trail.distance_km) : null,
        distance_ratio: v.distRatio, distance_hypothesis: v.distHypothesis,
        points: pts.length,
        gain_m: es.gain_m, loss_m: es.loss_m, min_ele: es.min_ele, max_ele: es.max_ele,
        snap_trailhead_m: r.snapStart, snap_summit_m: r.snapGoal, summit_dist_m: v.summit_dist_m,
        bytes: Buffer.byteLength(gpx),
      });
      seenGeom.set(geomHash, { file: `routes/${m.id}/${fileName}`, route_id: `${m.id}-${rk}`, name: label });
      if (r.variant === 0 && v.status === 'accepted') primaryAccepted = true;
      log(`    #${idx + 1}${variantSuffix || ' '} ✓ ${v.status} ${v.score}점 · ${(dist_m / 1000).toFixed(2)}km · ${pts.length}pt`
        + (es.gain_m != null ? ` · +${es.gain_m}m` : '') + ` → ${fileName}`);
    }
  }

  // ── 이 산을 지나는 OSM hiking 관계 ──────────────────────────────────
  const relations = [];
  const rels = (json.elements || []).filter((e) => e.type === 'relation' && e.members?.length);
  const cands = [];
  for (const rel of rels) {
    const line = stitchRelation(rel);
    if (!line || line.length < 4) continue;
    const d = pointToPolyline([m.lat, m.lon], line);
    if (d > REL_SUMMIT_MAX_M) continue;
    cands.push({ rel, line, d });
  }
  cands.sort((a, b) => a.d - b.d);
  for (const { rel, line, d } of cands.slice(0, REL_PER_MOUNTAIN)) {
    const relName = rel.tags?.name || rel.tags?.ref || `hiking relation ${rel.id}`;
    const file = `routes/osm-relations/r${rel.id}.gpx`;
    // 색인만 믿으면 안 된다 — 산출물 디렉터리를 지우고 다시 돌리면 색인에는 있는데 파일은
    // 없는 상태가 되고, 매니페스트가 없는 파일을 가리켜 404가 난다. 파일 존재를 직접 확인한다.
    const onDisk = existsSync(join(ROOT, 'public', 'gpx', file));
    if (!onDisk || !relIndex.has(rel.id) || (FORCE && !relWritten.has(rel.id))) {
      relWritten.add(rel.id);
      let pts = dedupePoints(dropJumps(line, 5000));
      pts = simplify(pts, REL_SIMPLIFY_M);
      if (pts.length > MAX_POINTS * 2) pts = simplify(pts, REL_SIMPLIFY_M * 3);
      if (pts.length < 4 || !pts.every(inKorea)) continue;
      const gpx = toGPX({
        name: relName,
        desc: 'OpenStreetMap에 등록된 도보 경로(route=hiking) 관계를 그대로 내보낸 선형입니다. 실측 GPS 기록이 아닙니다.',
        latlngs: pts, eles: [], time: nowISO(), links: [OSM_LINK],
        meta: {
          provenance: 'osm-relation', not_a_recorded_track: 'true',
          osm_type: 'relation', osm_id: rel.id, osm_name: relName,
          network: rel.tags?.network || '', operator: rel.tags?.operator || '',
          source: 'OpenStreetMap via Overpass API',
          license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors',
          osm_snapshot: TODAY,
        },
      });
      const outPath = join(ROOT, 'public', 'gpx', file);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, gpx);
      relIndex.set(rel.id, { name: relName, file, points: pts.length, distance_km: +(pathLength(pts) / 1000).toFixed(2), bytes: Buffer.byteLength(gpx) });
    }
    const info = relIndex.get(rel.id);
    // bytes를 빠뜨리면 매니페스트 total_bytes에서 관계 파일이 통째로 빠진다.
    if (info) relations.push({ osm_id: rel.id, name: relName, file: info.file, kind: 'osm-relation', distance_km: info.distance_km, points: info.points, bytes: info.bytes, summit_dist_m: Math.round(d) });
  }
  if (relations.length) log(`    ↳ hiking 관계 ${relations.length}건`);

  const result = {
    id: m.id, name: m.name_full || m.name,
    osm_walk_ways: walkWays.length, osm_major_road_ways: majorWays.length, graph_nodes: g.nodes.size,
    collected_at: nowISO(), tracks, relations,
  };
  mkdirSync(RESULT_DIR, { recursive: true });
  writeAtomic(resultFile, JSON.stringify(result, null, 2));
  elev.save();
  log(`  ${m.id} 완료 — 트랙 ${tracks.filter((t) => t.file).length}개, 관계 ${relations.length}개 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  return result;
}

// ── 매니페스트 생성 ───────────────────────────────────────────────────
function publish({ quiet = false } = {}) {
  // 손상된 결과 파일 하나 때문에 매니페스트 생성 전체가 죽지 않게 한다.
  const results = [];
  if (existsSync(RESULT_DIR)) {
    for (const f of readdirSync(RESULT_DIR).filter((x) => x.endsWith('.json'))) {
      try { results.push(JSON.parse(readFileSync(join(RESULT_DIR, f), 'utf8'))); }
      catch { log(`  결과 파일 손상, 매니페스트에서 제외: ${f}`); }
    }
  }
  const byId = new Map(mountains.map((m) => [m.id, m]));
  // 좌표가 같아 파일을 공유하는 항목은 고도 통계를 다시 계산하지 않았으므로,
  // 같은 좌표열(geom_sha1)을 가진 원본 항목의 값을 그대로 물려준다.
  const inheritStats = (tracks) => {
    const src = new Map();
    for (const t of tracks) if (!t.duplicate_of && t.geom_sha1 && t.gain_m != null) src.set(t.geom_sha1, t);
    return tracks.map((t) => {
      if (!t.duplicate_of) return t;
      const o = src.get(t.geom_sha1);
      return o ? { ...t, gain_m: o.gain_m, loss_m: o.loss_m, min_ele: o.min_ele, max_ele: o.max_ele, bytes: o.bytes } : t;
    });
  };
  const entries = results
    .filter((r) => byId.has(r.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({
      mountain_id: r.id,
      mountain_name: byId.get(r.id).name_full || byId.get(r.id).name,
      collected_at: r.collected_at,
      tracks: inheritStats(r.tracks.filter((t) => t.file)),
      relations: r.relations || [],
    }))
    .filter((e) => e.tracks.length || e.relations.length);

  const tracks = entries.flatMap((e) => e.tracks);
  const relFiles = new Map();
  entries.forEach((e) => e.relations.forEach((rl) => relFiles.set(rl.file, rl)));

  const head = {
    schema_version: 1,
    generated_at: nowISO(),
    generator: 'scripts/collect-routes.mjs',
    what_this_is: 'OpenStreetMap 등산로 선형 위에서 계산한 산별·코스별 경로. 사람이 GPS로 기록한 실측 트랙이 아닙니다.',
    sources: [
      { name: 'OpenStreetMap (Overpass API)', license: 'ODbL 1.0', url: 'https://www.openstreetmap.org/copyright', attribution: '© OpenStreetMap contributors' },
      { name: 'SRTM 1 arc-second (NASA/USGS) — AWS Terrain Tiles', note: '고도값. 지형 DEM에서 읽은 추정 고도이며 기압·GPS 실측 고도가 아닙니다', url: 'https://registry.opendata.aws/terrain-tiles/' },
    ],
    kinds: {
      'osm-routed': '등록 들머리 → 정상 최단경로를 OSM 등산로망 위에서 계산한 결과',
      'osm-relation': 'OSM에 route=hiking 관계로 등록된 도보 경로 선형 원본',
    },
    stats: {
      mountains: entries.length,
      routed_tracks: tracks.length,                                     // 코스 항목 수(중복 참조 포함)
      routed_files: new Set(tracks.map((t) => t.file)).size,            // 실제 파일 수
      duplicates: tracks.filter((t) => t.duplicate_of).length,          // 다른 코스와 좌표가 같아 파일을 공유
      accepted: tracks.filter((t) => t.status === 'accepted').length,
      review: tracks.filter((t) => t.status === 'review').length,
      relation_files: relFiles.size,
      // 파일을 공유하는 항목의 bytes는 한 번만 센다.
      total_bytes: [...new Map(tracks.filter((t) => t.bytes).map((t) => [t.file, t.bytes])).values()].reduce((s, b) => s + b, 0)
        + [...relFiles.values()].reduce((s, r) => s + (r.bytes || 0), 0),
    },
  };

  // index.json은 "어느 산에 무엇이 있는지"만 담는 가벼운 목록으로 둔다(149산 전체 상세를
  // 한 파일에 넣으면 590KB가 되어 상세 페이지가 산 하나 보려고 전부 받게 된다).
  // 상세는 산별 파일로 쪼개고, 사람이 통째로 읽을 판본은 catalog.json에 따로 둔다.
  const manifest = {
    ...head,
    layout: { per_mountain: 'routes/m/<mountain_id>.json', full_catalog: 'routes/catalog.json' },
    mountains: entries.map((e) => ({
      mountain_id: e.mountain_id, mountain_name: e.mountain_name, collected_at: e.collected_at,
      tracks: e.tracks.length, relations: e.relations.length,
    })),
  };
  mkdirSync(join(OUT_DIR, 'm'), { recursive: true });
  writeAtomic(join(OUT_DIR, 'index.json'), JSON.stringify(manifest));
  writeAtomic(join(OUT_DIR, 'catalog.json'), JSON.stringify({ ...head, mountains: entries }, null, 2) + '\n');
  for (const e of entries) writeAtomic(join(OUT_DIR, 'm', `${e.mountain_id}.json`), JSON.stringify(e));
  // 예전 판본에서 남은 파일 정리
  rmSync(join(OUT_DIR, 'index.pretty.json'), { force: true });
  if (quiet) return manifest;
  log(`\n매니페스트: 산 ${manifest.stats.mountains}개 · 코스경로 ${manifest.stats.routed_tracks}건`
    + ` (파일 ${manifest.stats.routed_files}개, 공유 ${manifest.stats.duplicates}건)`
    + ` · 승인 ${manifest.stats.accepted} / 검토 ${manifest.stats.review}`
    + ` · 관계 ${manifest.stats.relation_files}개 · ${(manifest.stats.total_bytes / 1048576).toFixed(1)}MB`);
  return manifest;
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  if (PUBLISH_ONLY) { publish(); return; }

  mkdirSync(OSM_DIR, { recursive: true });
  mkdirSync(RESULT_DIR, { recursive: true });
  mkdirSync(REL_DIR, { recursive: true });

  let targets = mountains.filter((m) => m.lat != null && (m.trails || []).length);
  if (ONLY.length) targets = targets.filter((m) => ONLY.includes(m.id));
  if (LIMIT) targets = targets.slice(0, LIMIT);

  const elev = new ElevationDEM(DEM_DIR);
  // 이미 만들어 둔 관계 파일은 다시 쓰지 않는다(재개 시 중복 작업 방지).
  // 파일 목록이 아니라 색인을 저장해 둔다 — 재개 시에도 거리·점수 같은 메타를 잃지 않게.
  // --force 여도 색인은 읽어 온다. 비우고 시작하면 `--force --only=한 산`이 나머지 산의
  // 관계 색인을 통째로 날려버린다(다시 쓰기는 relWritten이 따로 관리한다).
  const relIndexFile = join(CACHE, 'relations-index.json');
  let relSeed = [];
  try {
    if (existsSync(relIndexFile)) relSeed = Object.entries(JSON.parse(readFileSync(relIndexFile, 'utf8'))).map(([k, v]) => [Number(k), v]);
  } catch { log('  관계 색인이 손상되어 새로 만듭니다'); }
  const relIndex = new Map(relSeed);
  const saveRelIndex = () => writeAtomic(relIndexFile, JSON.stringify(Object.fromEntries(relIndex), null, 2));

  log(`대상 ${targets.length}개 산 (코스 ${targets.reduce((s, m) => s + (m.trails || []).length, 0)}개)\n`);
  let n = 0;
  for (const m of targets) {
    n++;
    log(`[${n}/${targets.length}] ${m.name_full || m.name} (${m.id})`);
    try { await processMountain(m, elev, relIndex); }
    catch (e) { log(`✗ ${m.id} — ${e.stack || e.message}`); }
    elev.save(); saveRelIndex();
    // 매니페스트를 산마다 갱신한다 — 중간에 끊겨도 여태 모은 것이 그대로 쓸 수 있는 상태로 남는다.
    if (n % 5 === 0) publish({ quiet: true });
  }
  elev.save(); saveRelIndex();
  log(`\nDEM 타일 ${elev.downloads}개 내려받음 (.cache/routes/dem)`);
  publish();
}

main().catch((e) => { console.error(e); process.exit(1); });
