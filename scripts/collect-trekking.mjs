#!/usr/bin/env node
// 산 주변 트레킹·걷기길 수집기.
//
// 무엇을 만드는가
//   각 산의 정상과 등산로 들머리(mountains.json trails[].trailhead)마다 반경 R km(기본 15) 안을 지나는
//   도보 노선을 OpenStreetMap에서 모아
//   산별 JSON(public/data/trekking/m/<id>.json)과 가벼운 색인(index.json)으로 내보낸다.
//     ① 노선 관계(route=hiking|foot|walking) — 지리산둘레길·북한산둘레길·제주올레·평화누리길·
//        백두대간·정맥, 국립공원 탐방 코스 관계 등. 반경 안의 멤버 way만 받아 잇는다
//        (1,000 km짜리 백두대간 관계를 통째로 받지 않기 위해). 전체 길이·순환 여부는 전국 노선 빌드
//        (scripts/build-walks.mjs)가 노선 전체 선으로 계산해 산별 파일에 덧붙인다.
//     ② 이름 붙은 길 — 관계로 묶이지 않았지만 "OO 둘레길·숲길·자락길·산책로" 같은 이름이 달린
//        way들을 이름별로 모으고, 서로 1.5 km 넘게 떨어진 동명 무리는 별개 노선으로 나눈다.
//
// 무엇이 아닌가  ★ 중요
//   사람이 걸으며 기록한 실측 트랙이 아니다. OSM에 등록된 노선·이름을 그대로 옮긴 것이며
//   통제·폐쇄·계절 출입 제한은 반영하지 않는다. 산출물의 note에 그대로 적는다.
//   OSM의 '비법정탐방로'(국립공원 출입금지 샛길)처럼 이름 자체가 통제 구간인 길은 뺀다.
//
// 라이선스
//   OpenStreetMap contributors, ODbL 1.0 — 재배포 시 출처 표시 필요(산출물 attribution 필드).
//
// 노선마다 붙는 거리 정보
//   dist_km·anchor  정상·들머리 중 가장 가까운 기준점까지 직선거리와 그 종류('summit'|'trailhead').
//                   정상 300 m 안을 지나는 노선은 near_summit:true, anchor:'summit'(정상까지 거리).
//   entry           노선 위에서 그 기준점에 가장 가까운 지점(지도 '위치 보기'용).
//   loop            OSM roundtrip 태그, 없으면 시작·끝 200 m 이내(노선 전체가 반경 안일 때만 판단).
//   long            장거리 걷기길(network=nwn/iwn 또는 올레·해파랑·지리산둘레길 등 이름).
//
// 사용법
//   node scripts/collect-trekking.mjs                         # 전체(Overpass 응답 캐시 → 재실행은 거의 공짜)
//   ONLY=bukhansan,jirisan node scripts/collect-trekking.mjs  # 일부 산만 (--only=… 도 가능)
//   LIMIT=5 node scripts/collect-trekking.mjs                 # 앞에서 n개만 (--limit=… 도 가능)
//   RADIUS_KM=8 node scripts/collect-trekking.mjs             # 반경 변경(질의가 바뀌므로 새로 받는다)
//   다음 단계: node scripts/build-walks.mjs                    # 전국 노선 목록·타일·상세(+ 산별 파일 보강)
//   node scripts/collect-trekking.mjs --force                 # 캐시를 무시하고 다시 받기
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overpass, ENDPOINTS } from './lib/overpass.mjs';
import { inKorea } from './lib/geo.mjs';
import {
  classifyRoute, KIND_LABEL, KINDS, displayName, normalizeName, isGenericName, isExcludedName,
  parseDistanceKm, chainWays, splitByGap, groupByName, clipToCircles, overlapFraction, lengthKm,
  minDistToPoint, douglasPeucker, bbox, selectRoutes, roundPt, round5, wikipediaUrl,
  nearestAnchor, loopFlag, isLongDistance,
} from './lib/trekking.mjs';
import { haversine } from './lib/geo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OSM_DIR = join(ROOT, '.cache', 'trekking', 'osm');          // gitignore 대상(.cache/)
const ALL_DIR = join(ROOT, '.cache', 'trekking', 'all');          // 상한 적용 전 전체 노선(전국 빌드 입력)
const OUT_DIR = join(ROOT, 'public', 'data', 'trekking');
const M_DIR = join(OUT_DIR, 'm');

// ── 설정 ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return null;
  if (argv[i].includes('=')) return argv[i].slice(n.length + 3);
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : null;
};
const ONLY = (opt('only') || process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(opt('limit') || process.env.LIMIT || 0) || 0;
const RADIUS_KM = Number(opt('radius') || process.env.RADIUS_KM || 15) || 15;
const FORCE = argv.includes('--force') || process.env.FORCE === '1';

const R_M = Math.round(RADIUS_KM * 1000);
const MIN_KM = 0.8;              // 반경 안 길이가 이보다 짧은 노선은 버린다
const JOIN_M = 15;               // way 끝점 잇기 허용 거리
const GAP_KM = 1.5;              // 동명 way 무리 분리 기준
const DP_M = 8;                  // 선형 단순화 허용오차
const CAP = 30;                  // 산당 노선 상한
const TH_MAX_KM = 10;            // 정상에서 이보다 먼 들머리 좌표는 기준점으로 쓰지 않는다(지명 좌표·종주 끝점)
const TH_DEDUPE_M = 300;         // 이보다 가까운 들머리들은 기준점 하나로
const QUERY_SPACING_KM = 1.5;    // 질의 원: 이미 고른 원 중심에서 이보다 가까운 들머리는 원을 더하지 않는다
const MAX_QUERY_CIRCLES = 6;
const NEAR_SUMMIT_KM = 0.3;
const RESERVE_PER_KIND = 3;      // 상한을 적용할 때 종류별로 먼저 확보해 두는 자리(반경 절반 안의 노선만)
const PARENT_COVER = 0.8;        // 상위 노선의 way가 이 비율 이상 구간 노선들에 포함되면 상위 노선은 뺀다
const OVERLAP_DROP = 0.6;        // 이름 붙은 길 무리가 이 비율 이상 이미 고른 노선 위에 겹치면 뺀다
const ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';
const NOTE = `경로 선은 OpenStreetMap에 등록된 노선·이름 붙은 길을 정상·들머리 반경 ${RADIUS_KM} km 안에서 모은 것입니다. `
  + '실측 기록이 아니며, 통제·폐쇄 여부는 반영하지 않습니다.';

// 질의의 이름 패턴. 같은 정규식을 응답 해석에도 써서, 관계 멤버로 딸려 온 일반 도로
// ("호국로1114번길" 등)가 관계가 탈락했을 때 '이름 붙은 길'로 둔갑하지 않게 한다.
const NAME_PATTERN = '둘레길|자락길|옛길|숲길|올레|마실길|누리길|바우길|해파랑|남파랑|서해랑|소리길|순례길|선재길|비렁길|황톳길|자연관찰로|치유|산책로|계곡길|탐방로';
const NAME_RE = new RegExp(NAME_PATTERN);
// 걸을 수 없는 길 유형 — 이름이 패턴에 걸려도 제외.
const NON_WALK = /^(proposed|construction|abandoned|disused|razed|raceway|motorway|motorway_link|trunk|trunk_link|bus_guideway|platform|elevator|corridor)$/;

// 미러 순서: 이 질의는 서버 계산은 수 초면 끝나고 504는 대개 '혼잡'이라 곧 풀린다(2026-10-13 측정:
// 같은 질의가 504 → 몇십 초 뒤 2.9초에 성공). 그래서 응답이 빠른 두 곳을 번갈아 자주 두드리고,
// 매번 170초를 다 쓰고 끝나던 느린 미러는 맨 끝에, 연결 자체가 안 되던 미러는 뺀다.
// 같은 날 오후에는 maps.mail.ru가 매번 504라(2026-10-13 09시 UTC) 기본 서버 비중을 높였다.
const MIRRORS = [ENDPOINTS[0], ENDPOINTS[0], ENDPOINTS[1], ENDPOINTS[0], ENDPOINTS[0], ENDPOINTS[1], ENDPOINTS[0], ENDPOINTS[2]];

const log = (...a) => console.log(...a);
const TODAY = new Date().toISOString().slice(0, 10);

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// ── 입력 ─────────────────────────────────────────────────────────────
const data = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'mountains.json'), 'utf8'));
const mountains = data.mountains;

// ── 기준점 ───────────────────────────────────────────────────────────
// 정상 + 들머리(정상 TH_MAX_KM 안, 서로 300 m 넘게 떨어진 것). 질의·자르기 원은 그중 서로 1.5 km 넘게
// 떨어진 것만(최대 6개) — 원이 거의 겹치면 질의만 무거워진다.
function anchorsFor(m) {
  const anchors = [{ kind: 'summit', lat: m.lat, lon: m.lon }];
  for (const t of m.trails || []) {
    const th = t.trailhead;
    if (!Array.isArray(th) || th.length !== 2 || !th.every(Number.isFinite)) continue;
    const [lat, lon] = th;
    if (haversine(m.lat, m.lon, lat, lon) > TH_MAX_KM * 1000) continue;
    if (anchors.some((a) => haversine(a.lat, a.lon, lat, lon) < TH_DEDUPE_M)) continue;
    anchors.push({ kind: 'trailhead', lat, lon });
  }
  const circles = [];
  for (const a of anchors) {
    if (circles.length >= MAX_QUERY_CIRCLES) break;
    if (circles.some((c) => haversine(c.lat, c.lon, a.lat, a.lon) < QUERY_SPACING_KM * 1000)) continue;
    circles.push({ lat: a.lat, lon: a.lon, r: R_M });
  }
  return { anchors, circles };
}

// ── Overpass ─────────────────────────────────────────────────────────
// 산당 1회. 관계는 태그+멤버 목록만(out body), 멤버 way는 원 안에 걸치는 것만 선형까지 받는다.
// 전국 단위 이름 정규식 질의는 504로 죽으므로 반드시 around 원(정상·들머리)의 합집합으로 좁힌다.
function buildQuery(circles) {
  const ats = circles.map((c) => `(around:${c.r},${c.lat.toFixed(5)},${c.lon.toFixed(5)})`);
  const union = (stmt) => (ats.length === 1 ? `${stmt}${ats[0]}` : `(${ats.map((a) => `${stmt}${a};`).join(' ')})`);
  return `[out:json][timeout:170];
${union('relation["type"~"^(route|superroute)$"]["route"~"^(hiking|foot|walking)$"]')}->.r;
.r out body;
${union('way(r.r)')}->.rw;
.rw out geom;
${union(`way["highway"]["name"~"${NAME_PATTERN}"]`)};
out tags geom;`;
}

async function fetchOSM(m, circles) {
  const q = buildQuery(circles);
  // 질의(반경·패턴)가 바뀌면 예전 캐시를 쓰면 안 되므로 파일명에 질의 해시를 넣는다.
  const qhash = createHash('sha1').update(q).digest('hex').slice(0, 8);
  const file = join(OSM_DIR, `${m.id}-${qhash}.json`);
  const cached = existsSync(file);
  if (FORCE && cached) rmSync(file);
  const json = await overpass(q, { cacheFile: file, log, tries: 8, timeoutMs: 170000, endpoints: MIRRORS });
  return { json, cached: cached && !FORCE };
}

// ── 노선 만들기 ───────────────────────────────────────────────────────
const toLine = (w) => w.geometry.map((g) => [g.lat, g.lon]);

function linksFor(tags, osmUrl) {
  const links = {};
  const wp = wikipediaUrl(tags?.wikipedia);
  if (wp) links.wikipedia = wp;
  const web = tags?.website || tags?.url || tags?.['contact:website'];
  if (web && /^https?:\/\//i.test(web)) links.website = web;
  links.osm = osmUrl;
  return links;
}

function buildRoutes(m, json, stats, { anchors, circles }) {
  const els = json.elements || [];
  const ways = new Map();                    // 같은 way가 관계 멤버 + 이름 질의로 두 번 올 수 있다
  for (const e of els) {
    if (e.type === 'way' && e.geometry?.length >= 2 && !ways.has(e.id)) ways.set(e.id, e);
  }
  const relEls = [...new Map(els.filter((e) => e.type === 'relation').map((e) => [e.id, e])).values()];

  // ① 관계 노선 ----------------------------------------------------------
  // 이름이 같은 관계(예: '북한산둘레길' 관계 4개)는 한 노선으로 합친다.
  const relGroups = new Map();
  for (const r of relEls) {
    const tags = r.tags || {};
    const name = displayName(tags);
    if (!name) { stats.unnamed++; continue; }
    if (isExcludedName(name) || isGenericName(name)) { stats.generic++; continue; }
    const wayMembers = (r.members || []).filter((mm) => mm.type === 'way').map((mm) => mm.ref);
    const got = wayMembers.filter((id) => ways.has(id));
    if (!got.length) continue;               // 상위 묶음(superroute)이거나 반경 안에 선이 없음
    const key = `${normalizeName(name)}|${tags.network || ''}`;
    if (!relGroups.has(key)) relGroups.set(key, { name, rels: [], wayIds: new Set(), allWays: new Set() });
    const g = relGroups.get(key);
    g.rels.push(r);
    got.forEach((id) => g.wayIds.add(id));
    wayMembers.forEach((id) => g.allWays.add(id));
  }
  let relCands = [...relGroups.values()];

  // 상위 노선 정리: "북한산둘레길"의 way 대부분이 "[북한산둘레길] N구간 …" 관계들에 이미 들어 있으면
  // 상위 노선은 빼고 구간 노선을 남긴다(같은 선을 두 번 그리지 않게, 구간 이름이 더 쓸모 있다).
  const parents = new Set();
  for (const a of relCands) {
    const an = normalizeName(a.name);
    const childWays = new Set();
    for (const b of relCands) {
      if (b === a) continue;
      const bn = normalizeName(b.name);
      if (bn.length > an.length && bn.includes(an)) b.wayIds.forEach((id) => childWays.add(id));
    }
    if (!childWays.size) continue;
    let hit = 0;
    a.wayIds.forEach((id) => { if (childWays.has(id)) hit++; });
    if (hit / a.wayIds.size >= PARENT_COVER) parents.add(a);
  }
  if (parents.size) {
    stats.parentDropped += parents.size;
    relCands = relCands.filter((a) => !parents.has(a));
  }

  // ② 이름 붙은 길 --------------------------------------------------------
  const relWayIds = new Set(relCands.flatMap((g) => [...g.wayIds]));
  const named = [];
  for (const w of ways.values()) {
    if (relWayIds.has(w.id)) continue;
    const t = w.tags || {};
    const name = displayName(t);
    if (!name || !NAME_RE.test(name)) continue;
    if (!t.highway || NON_WALK.test(t.highway)) continue;
    if (/^(no|private)$/.test(t.access || '') || t.foot === 'no') { stats.restricted++; continue; }
    if (isExcludedName(name) || isGenericName(name)) { stats.generic++; continue; }
    named.push({ id: w.id, name, tags: t, line: toLine(w) });
  }

  // 같은 노선이 관계 이름과 표기만 다른 이름으로 더 그려진 경우("인왕산 둘레길" way ↔ "인왕산둘레길"
  // 관계)는 관계 노선에 흡수한다 — 관계에 빠진 구간을 메워 주고 목록에 같은 길이 두 번 뜨지 않는다.
  const relByNorm = new Map(relCands.map((g) => [normalizeName(g.name), g]));
  const relLinesOf = new Map();
  const namedClusters = [];
  // 띄어쓰기·괄호만 다른 표기("한라산 둘레길 2구간 (돌오름길)" ↔ "한라산둘레길 2구간(돌오름길)")는
  // 같은 길로 묶고, 표시 이름은 그 무리에서 가장 많이 쓰인 표기를 쓴다.
  const commonName = (items) => {
    const cnt = new Map();
    for (const x of items) cnt.set(x.name, (cnt.get(x.name) || 0) + 1);
    return [...cnt].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  };
  for (const [norm, items] of groupByName(named, (x) => normalizeName(x.name))) {
    for (const cluster of splitByGap(items, GAP_KM, (x) => x.line)) {
      const name = commonName(cluster);
      const rel = relByNorm.get(norm);
      if (rel) {
        if (!relLinesOf.has(rel)) relLinesOf.set(rel, [...rel.wayIds].map((id) => toLine(ways.get(id))));
        const relLines = relLinesOf.get(rel);
        const ends = cluster.flatMap((x) => [x.line[0], x.line[x.line.length - 1]]);
        const near = ends.some((p) => minDistToPoint(relLines, p[0], p[1]).km <= GAP_KM);
        if (near) {
          rel.absorbed = (rel.absorbed || []).concat(cluster.map((x) => x.id));
          stats.absorbed += cluster.length;
          continue;
        }
      }
      namedClusters.push({ name, items: cluster });
    }
  }

  // ③ 마무리: 잇기 → 반경 자르기 → 길이·거리 → 단순화 ----------------------
  const finish = (base, rawLines, { roundtrip = null } = {}) => {
    const chained = chainWays(rawLines, JOIN_M);
    const { lines: clippedLines, clipped } = clipToCircles(chained, circles);
    const len = lengthKm(clippedLines);
    if (len < MIN_KM) return null;
    const near = nearestAnchor(clippedLines, anchors, NEAR_SUMMIT_KM);
    if (!(near.dist_km <= RADIUS_KM)) return null;
    const lines = clippedLines
      .map((l) => douglasPeucker(l, DP_M).map(roundPt))
      .filter((l) => l.length >= 2 && l.every(inKorea));
    if (!lines.length) return null;
    const partial = base.partial || clipped;
    const lenKm = Math.round(len * 10) / 10;
    // 전체 길이: 노선 전체가 범위 안이면 잰 길이(OSM distance 태그가 25% 안으로 맞으면 태그 값),
    // 범위 밖으로 이어지면 태그 값만(없으면 null — 전국 빌드가 전체 선으로 채운다).
    const declared = base.declared_km;
    return {
      ...base,
      length_km: lenKm,
      total_km: partial ? (declared || null) : (declared && Math.abs(declared - lenKm) / lenKm < 0.25 ? declared : lenKm),
      partial,
      loop: loopFlag({ roundtrip, lines: chained, complete: !partial }),
      dist_km: Math.round(near.dist_km * 10) / 10,
      anchor: near.anchor,
      near_summit: near.near_summit,
      entry: roundPt(near.entry),
      bbox: bbox(lines).map(round5),
      lines,
      _clipped: clippedLines,                 // 겹침 판정용(출력 전에 지운다)
    };
  };

  const routes = [];
  for (const g of relCands) {
    const rels = g.rels.slice().sort((a, b) => a.id - b.id);
    const first = rels[0], tags = first.tags || {};
    const merged = (k) => rels.map((r) => r.tags?.[k]).find(Boolean) || null;
    const wayIdList = [...g.wayIds, ...(g.absorbed || [])];
    const r = finish({
      rid: `r${first.id}`,
      name: g.name,
      kind: classifyRoute({ name: g.name, network: tags.network || null, tags }),
      long: isLongDistance({ name: g.name, network: merged('network'), nameEn: merged('name:en') }),
      network: merged('network'),
      operator: merged('operator'),
      source: 'relation',
      osm_ids: rels.map((x) => x.id),
      declared_km: parseDistanceKm(merged('distance')),
      walking_min: rels.length === 1 && /^\d{1,4}$/.test(tags.walking_time || '') ? Number(tags.walking_time) : null,
      partial: g.allWays.size > g.wayIds.size,      // 반경 밖으로 이어지는 멤버가 있다
      links: linksFor({ wikipedia: merged('wikipedia'), website: merged('website') || merged('url') }, `https://www.openstreetmap.org/relation/${first.id}`),
      ...(g.absorbed?.length ? { named_ways: g.absorbed.length } : {}),
    }, wayIdList.map((id) => toLine(ways.get(id))), { roundtrip: merged('roundtrip') });
    if (r) routes.push(r); else stats.short++;
  }

  // 관계 노선을 먼저 확정한 뒤, 거기에 대부분 겹치는 이름 붙은 길 무리는 뺀다
  // (예: "북한산둘레길 18코스 도봉옛길 (무장애 탐방구간)" ↔ 18구간 관계).
  const relLinesAll = routes.flatMap((r) => r._clipped);
  for (const c of namedClusters) {
    const ids = c.items.map((x) => x.id).sort((a, b) => a - b);
    const tags = c.items[0].tags;
    const r = finish({
      rid: `w${ids[0]}`,
      name: c.name,
      kind: classifyRoute({ name: c.name, network: null, tags }),
      long: isLongDistance({ name: c.name, network: null, nameEn: tags['name:en'] }),
      network: null,
      operator: c.items.map((x) => x.tags.operator).find(Boolean) || null,
      source: 'named-ways',
      osm_ids: ids,
      declared_km: null,
      partial: false,
      links: linksFor(c.items.find((x) => x.tags.wikipedia || x.tags.website)?.tags || {}, `https://www.openstreetmap.org/way/${ids[0]}`),
    }, c.items.map((x) => x.line));
    if (!r) { stats.short++; continue; }
    if (relLinesAll.length && overlapFraction(r._clipped, relLinesAll, 25) >= OVERLAP_DROP) { stats.overlap++; continue; }
    routes.push(r);
  }

  for (const r of routes) {
    delete r._clipped;
    r.kind_label = KIND_LABEL[r.kind];
  }
  return routes;
}

// 출력 필드 순서를 고정(diff가 읽기 쉽도록).
function shape(r) {
  const o = {
    rid: r.rid, name: r.name, kind: r.kind, kind_label: r.kind_label, long: !!r.long,
    network: r.network, operator: r.operator, source: r.source, osm_ids: r.osm_ids,
    length_km: r.length_km, total_km: r.total_km ?? null, declared_km: r.declared_km, partial: r.partial,
    loop: r.loop ?? null,
    dist_km: r.dist_km, anchor: r.anchor, near_summit: !!r.near_summit, entry: r.entry, bbox: r.bbox,
  };
  if (r.walking_min) o.walking_min = r.walking_min;     // OSM walking_time 태그(분), 있을 때만
  if (r.named_ways) o.named_ways = r.named_ways;
  o.links = r.links;
  o.lines = r.lines;
  return o;
}

// ── 산 하나 ──────────────────────────────────────────────────────────
async function processMountain(m) {
  const t0 = Date.now();
  const geo = anchorsFor(m);
  let res;
  try { res = await fetchOSM(m, geo.circles); }
  catch (e) { log(`✗ ${m.id} — Overpass 실패: ${e.message}`); return { id: m.id, error: e.message }; }

  const stats = { unnamed: 0, generic: 0, restricted: 0, parentDropped: 0, absorbed: 0, short: 0, overlap: 0 };
  const all = buildRoutes(m, res.json, stats, geo);
  // 상한 적용 전 전체 노선 — 전국 노선 빌드가 '이름 붙은 길'과 관계 id를 여기서 모은다.
  writeAtomic(join(ALL_DIR, `${m.id}.json`), JSON.stringify({
    id: m.id, generated: TODAY, radius_km: RADIUS_KM,
    anchors: geo.anchors.map((a) => ({ kind: a.kind, lat: round5(a.lat), lon: round5(a.lon) })),
    routes: all.map((r) => shape({ ...r, kind_label: KIND_LABEL[r.kind] })),
  }));
  const { kept, dropped } = selectRoutes(all, CAP, RESERVE_PER_KIND, RADIUS_KM / 2);
  const file = join(M_DIR, `${m.id}.json`);

  const notes = [];
  if (stats.parentDropped) notes.push(`상위노선 ${stats.parentDropped}건→구간으로 대체`);
  if (stats.absorbed) notes.push(`동명 way ${stats.absorbed}개 관계에 흡수`);
  if (stats.overlap) notes.push(`겹침 ${stats.overlap}건 제외`);
  if (stats.short) notes.push(`${MIN_KM}km 미만 ${stats.short}건 제외`);
  if (stats.generic) notes.push(`일반명·통제구간 이름 ${stats.generic}건 제외`);
  if (stats.restricted) notes.push(`출입금지 way ${stats.restricted}개 제외`);
  if (stats.unnamed) notes.push(`이름 없는 관계 ${stats.unnamed}건 제외`);
  if (dropped.length) notes.push(`상한 ${CAP}개 초과로 ${dropped.length}건 생략`);

  if (!kept.length) {
    if (existsSync(file)) rmSync(file);      // 예전 실행의 결과가 남아 색인에 잡히지 않게
    log(`  ${m.id} — 노선 0건 (파일 생략)${res.cached ? ' [캐시]' : ''}${notes.length ? ' · ' + notes.join(', ') : ''}`);
    return { id: m.id, count: 0 };
  }

  const out = {
    id: m.id,
    name: m.name_full || m.name,
    generated: TODAY,
    radius_km: RADIUS_KM,
    anchors: geo.anchors.length,
    attribution: ATTRIBUTION,
    note: NOTE,
    ...(dropped.length ? { omitted: dropped.length } : {}),
    routes: kept.map(shape),
  };
  const text = JSON.stringify(out);
  writeAtomic(file, text);
  const byKind = Object.fromEntries(KINDS.map((k) => [k, kept.filter((r) => r.kind === k).length]).filter(([, n]) => n));
  log(`  ${m.id} — 노선 ${kept.length}건 ${JSON.stringify(byKind)} · ${(text.length / 1024).toFixed(0)}KB`
    + `${res.cached ? ' [캐시]' : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (notes.length) log(`    ↳ ${notes.join(', ')}`);
  if (dropped.length) log(`    ↳ 생략: ${dropped.slice(0, 8).map((r) => `${r.name}(${r.kind_label}, ${r.dist_km}km)`).join(' · ')}${dropped.length > 8 ? ' …' : ''}`);
  return { id: m.id, count: kept.length };
}

// ── 색인 ─────────────────────────────────────────────────────────────
// 일부 산만 돌려도 나머지 산 결과가 날아가지 않도록, 디스크의 산별 파일 전체에서 다시 만든다.
function writeIndex() {
  const known = new Set(mountains.map((m) => m.id));
  const entries = {};
  if (existsSync(M_DIR)) {
    for (const f of readdirSync(M_DIR).filter((x) => x.endsWith('.json')).sort()) {
      const id = f.slice(0, -5);
      if (!known.has(id)) continue;
      try {
        const j = JSON.parse(readFileSync(join(M_DIR, f), 'utf8'));
        const kinds = {};
        for (const r of j.routes) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
        entries[id] = { count: j.routes.length, kinds, names: j.routes.slice(0, 5).map((r) => r.name) };
      } catch { log(`  산별 파일 손상, 색인에서 제외: ${f}`); }
    }
  }
  const index = { generated: TODAY, radius_km: RADIUS_KM, attribution: ATTRIBUTION, mountains: entries };
  writeAtomic(join(OUT_DIR, 'index.json'), JSON.stringify(index));
  return index;
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  let targets = mountains.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon));
  if (ONLY.length) {
    const unknown = ONLY.filter((id) => !targets.some((m) => m.id === id));
    if (unknown.length) log(`! 알 수 없는 산 id: ${unknown.join(', ')}`);
    targets = targets.filter((m) => ONLY.includes(m.id));
  }
  if (LIMIT) targets = targets.slice(0, LIMIT);
  log(`트레킹·걷기길 수집 — 대상 ${targets.length}개 산, 정상·들머리 반경 ${RADIUS_KM}km${FORCE ? ' (캐시 무시)' : ''}\n`);

  const failed = [];
  let total = 0, n = 0;
  for (const m of targets) {
    n++;
    log(`[${n}/${targets.length}] ${m.name_full || m.name} (${m.id})`);
    try {
      const r = await processMountain(m);
      if (r.error) failed.push(m.id); else total += r.count;
    } catch (e) {
      failed.push(m.id);
      log(`✗ ${m.id} — ${e.stack || e.message}`);
    }
    if (n % 10 === 0) writeIndex();          // 중간에 끊겨도 여태 결과로 색인이 맞아 있게
  }
  // 실패한 산은 잠시 쉬었다가 한 번 더 — 504 혼잡은 대개 몇십 초면 풀린다.
  if (failed.length) {
    log(`\n실패한 ${failed.length}개 산을 60초 뒤 한 번 더 시도합니다: ${failed.join(', ')}`);
    await new Promise((r) => setTimeout(r, 60000));
    for (const id of failed.splice(0)) {
      const m = targets.find((x) => x.id === id);
      log(`[재시도] ${m.name_full || m.name} (${m.id})`);
      try {
        const r = await processMountain(m);
        if (r.error) failed.push(m.id); else total += r.count;
      } catch (e) { failed.push(m.id); log(`✗ ${m.id} — ${e.stack || e.message}`); }
    }
  }
  const index = writeIndex();
  const withRoutes = Object.keys(index.mountains).length;
  log(`\n완료: 이번 실행 노선 ${total}건 · 색인 ${withRoutes}개 산 (public/data/trekking/index.json)`);
  if (failed.length) {
    log(`실패 ${failed.length}개 산: ${failed.join(', ')} — 다시 실행하면 받아 둔 산은 캐시로 넘어가고 실패한 산만 다시 받습니다.`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
