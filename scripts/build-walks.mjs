#!/usr/bin/env node
// 전국 걷기길 빌드 — 산별 파일의 합집합이 아니라, 남한의 OSM 도보 노선 관계(route=hiking|foot|walking)
// 전부를 노선 전체 선으로 받아 전국 목록·지역 타일·노선별 상세를 만든다.
//
// 입력
//   ① 전국 관계 목록(태그 + 경계상자): .cache/trekking/probe-relations.json
//      --refresh-probe 로 다시 받는다(실패하면 예전 목록을 그대로 쓴다).
//   ② 관계별 선형: Overpass에서 id 묶음으로 받아 .cache/trekking/rel/<id>.json 에 관계마다 저장
//      (다음 실행은 없는 것만 받는다 — 중간에 끊겨도 이어서 돈다).
//   ③ 산별 수집기(collect-trekking.mjs)의 상한 적용 전 전체 노선 .cache/trekking/all/<산id>.json
//      — 관계로 묶이지 않은 '이름 붙은 길'과, 목록에서 빠졌을 수 있는 관계 id를 여기서 더한다.
//
// 출력 (public/data/trekking/, 계약은 src/walkdata.js 머리 주석)
//   walks-index.json      [{ rid, name, kind, long, loop, km, total_km, near:[{id,km}], bbox, series? }]
//   tiles/<lat>_<lon>.json 1° 격자 거친 선(≈70 m 단순화) { routes:[{ rid, kind, long, lines }] }
//   w/<rid>.json          노선 상세(≈15 m 단순화) + 태그·링크·가까운 명산·같은 노선 다른 구간·출처
//   alias.json            산별 파일의 rid → 전국 rid(같은 노선이 다른 id로 묶인 경우)
//   + 산별 파일(m/<id>.json)의 관계 노선에 전체 길이(total_km)·순환(loop)·장거리(long)를 덧붙인다.
//
// 거르는 것: 이름 없는 관계, 일반명사뿐인 이름("2코스", "1.631 km"), 통제 구간 이름, 일본(규슈·쓰시마)·
//   북한(군사분계선 북쪽)에만 있는 관계, 0.8 km 미만. 같은 이름·같은 network 관계는 하나로 합치고,
//   구간 관계들에 80% 이상 덮이는 상위 관계("북한산둘레길" 전체)는 구간과 겹치므로 뺀다.
//
// 사용법
//   node scripts/build-walks.mjs                  # 캐시에 없는 관계만 받아서 빌드
//   node scripts/build-walks.mjs --offline        # 받지 않고 캐시만으로 빌드
//   node scripts/build-walks.mjs --refresh-probe  # 전국 관계 목록부터 다시
//
// 라이선스: © OpenStreetMap contributors, ODbL 1.0 — 산출물 attribution 필드에 적는다.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overpass, ENDPOINTS } from './lib/overpass.mjs';
import { inKorea } from './lib/geo.mjs';
import {
  classifyRoute, KIND_LABEL, displayName, normalizeName, isGenericName, isExcludedName, parseDistanceKm,
  chainWays, lengthKm, minDistToPoint, douglasPeucker, bbox, round5, wikipediaUrl, overlapFraction,
  loopFlag, isLongDistance, seriesKey, isJapaneseName, inSouthKorea, splitToTiles,
} from './lib/trekking.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'trekking');
const REL_DIR = join(CACHE, 'rel');
const ALL_DIR = join(CACHE, 'all');
const PROBE_FILE = join(CACHE, 'probe-relations.json');
const OUT = join(ROOT, 'public', 'data', 'trekking');

const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
const REFRESH_PROBE = argv.includes('--refresh-probe');

const MIN_KM = 0.8;
const JOIN_M = 15;
const DETAIL_DP_M = 15;          // 상세 선 단순화
const TILE_DP_M = 70;            // 타일(지도 레이어) 선 단순화
const NEAR_KM = 30;              // 가까운 명산 범위
const NEAR_INDEX = 5;            // 목록에 싣는 가까운 명산 수
const NEAR_DETAIL = 20;
const PASS_KM = 0.3;             // 정상 300 m 안을 지나면 '지나는 산'
const SIBLING_KM = 60;           // 같은 이름 구간이라도 경계상자끼리 이보다 멀면 형제로 보지 않는다(다른 고장의 동명 노선)
const PARENT_COVER = 0.8;
const NAMED_DUP = 0.6;           // 이름 붙은 길이 관계 노선 위에 이 비율 이상 겹치면 뺀다
const BATCH = 25;                // 작은 관계 묶음 크기
const BIG_SPAN_DEG = 0.5;        // 경계상자 한 변이 이보다 크면 혼자 받는다
const ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';
const NOTE_REL = 'OpenStreetMap에 등록된 노선 관계의 선을 그대로 옮겨 단순화한 것입니다. 실측 기록이 아니며 운영·통제 상태를 반영하지 않습니다.';
const NOTE_NAMED = 'OpenStreetMap에서 같은 이름이 붙은 길들을 이어 만든 선입니다. 공식 노선 전체와 다를 수 있으며, 실측 기록이 아니고 운영·통제 상태를 반영하지 않습니다.';
const MIRRORS = [ENDPOINTS[0], ENDPOINTS[1], ENDPOINTS[0], ENDPOINTS[1], ENDPOINTS[2]];
const TODAY = new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(...a);

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
const readJSON = (f) => JSON.parse(readFileSync(f, 'utf8'));
const r1 = (v) => Math.round(v * 10) / 10;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const nameOf = (tags) => displayName(tags || {});

// ── 입력 ─────────────────────────────────────────────────────────────
const mountains = readJSON(join(ROOT, 'public', 'data', 'mountains.json')).mountains.filter((m) => Number.isFinite(m.lat));

async function loadProbe() {
  if (REFRESH_PROBE && !OFFLINE) {
    const q = '[out:json][timeout:170];relation["type"="route"]["route"~"^(hiking|foot|walking)$"](33.0,124.5,38.7,131.0);out tags bb;';
    try {
      const json = await overpass(q, { log, tries: 6, timeoutMs: 180000, endpoints: MIRRORS });
      if (json?.elements?.length) { writeAtomic(PROBE_FILE, JSON.stringify(json)); log(`전국 관계 목록 새로 받음: ${json.elements.length}건`); }
    } catch (e) { log(`! 전국 관계 목록을 다시 받지 못해 예전 목록을 씁니다: ${e.message}`); }
  }
  if (!existsSync(PROBE_FILE)) throw new Error(`전국 관계 목록이 없습니다: ${PROBE_FILE} (--refresh-probe)`);
  return readJSON(PROBE_FILE).elements.filter((e) => e.type === 'relation');
}

/** 산별 수집기의 전체 노선(상한 전). 없으면 공개 산별 파일로 대신한다. */
function loadMountainRoutes() {
  const out = new Map();
  const dirs = [ALL_DIR, join(OUT, 'm')];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const id = f.slice(0, -5);
      if (out.has(id)) continue;
      try { out.set(id, readJSON(join(dir, f)).routes || []); } catch { /* 손상 파일은 건너뛴다 */ }
    }
  }
  return out;
}

/** 목록 단계에서 거를 수 있는 관계(태그·경계상자로). 이유 문자열, 통과면 null. */
function rejectByTags(tags, bounds) {
  const name = nameOf(tags);
  if (!name) return 'unnamed';
  if (isJapaneseName(name) || isJapaneseName(tags?.name || '')) return 'japan';
  if (isExcludedName(name) || isGenericName(name)) return 'generic';
  if (bounds && !inSouthKorea(bounds)) return 'outside';
  return null;
}

// ── 관계 선형 받기 ────────────────────────────────────────────────────
const relFile = (id) => join(REL_DIR, `${id}.json`);

async function fetchRelations(ids) {
  const q = `[out:json][timeout:180];relation(id:${ids.join(',')})->.r;.r out body;way(r.r);out skel geom;`;
  const json = await overpass(q, { log, tries: 8, timeoutMs: 200000, endpoints: MIRRORS });
  const ways = new Map();
  for (const e of json.elements || []) {
    if (e.type === 'way' && Array.isArray(e.geometry)) {
      const pts = e.geometry.filter((g) => g && Number.isFinite(g.lat)).map((g) => [Math.round(g.lat * 1e6) / 1e6, Math.round(g.lon * 1e6) / 1e6]);
      if (pts.length >= 2) ways.set(e.id, pts);
    }
  }
  const got = new Set();
  for (const r of (json.elements || []).filter((e) => e.type === 'relation')) {
    got.add(r.id);
    const w = {};
    for (const m of r.members || []) if (m.type === 'way' && ways.has(m.ref)) w[m.ref] = ways.get(m.ref);
    writeAtomic(relFile(r.id), JSON.stringify({
      id: r.id, fetched: TODAY, tags: r.tags || {},
      members: (r.members || []).map((m) => ({ type: m.type, ref: m.ref, role: m.role || '' })), ways: w,
    }));
  }
  // 응답에 없는 id = 삭제된 관계. 다시 묻지 않도록 빈 기록을 남긴다.
  for (const id of ids) if (!got.has(id)) writeAtomic(relFile(id), JSON.stringify({ id, fetched: TODAY, deleted: true }));
}

async function ensureRelations(cands) {
  const missing = [...cands.values()].filter((c) => !existsSync(relFile(c.id)));
  if (!missing.length) { log(`관계 선형: 모두 캐시에 있음 (${cands.size}건)`); return; }
  if (OFFLINE) { log(`! --offline: 캐시에 없는 관계 ${missing.length}건은 빼고 만듭니다`); return; }
  const span = (c) => (c.bounds ? Math.max(c.bounds.maxlat - c.bounds.minlat, c.bounds.maxlon - c.bounds.minlon) : 0);
  const big = missing.filter((c) => span(c) > BIG_SPAN_DEG);
  const small = missing.filter((c) => span(c) <= BIG_SPAN_DEG).sort((a, b) => a.id - b.id);
  const batches = [...big.map((c) => [c.id]), ...Array.from({ length: Math.ceil(small.length / BATCH) }, (_, i) => small.slice(i * BATCH, (i + 1) * BATCH).map((c) => c.id))];
  log(`관계 선형 받기: ${missing.length}건 → ${batches.length}회 질의 (큰 노선 ${big.length}건은 따로)`);
  let n = 0;
  const failed = [];
  for (const ids of batches) {
    n++;
    const t0 = Date.now();
    try {
      await fetchRelations(ids);
      log(`  [${n}/${batches.length}] ${ids.length}건 ${ids.length === 1 ? `(r${ids[0]} ${nameOf(cands.get(ids[0])?.tags)})` : ''} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      failed.push(...ids);
      log(`  ✗ [${n}/${batches.length}] ${ids.length}건 실패: ${e.message}`);
    }
  }
  if (failed.length) log(`! 받지 못한 관계 ${failed.length}건 — 다시 실행하면 이것만 받습니다: ${failed.slice(0, 20).join(',')}${failed.length > 20 ? ' …' : ''}`);
}

// ── 노선 만들기 ───────────────────────────────────────────────────────
function relationWalks(cands, stats) {
  const rels = [];
  for (const c of cands.values()) {
    if (!existsSync(relFile(c.id))) { stats.notFetched++; continue; }
    let j;
    try { j = readJSON(relFile(c.id)); } catch { stats.notFetched++; continue; }
    if (j.deleted) { stats.deleted++; continue; }
    const tags = j.tags || {};
    if (tags.type === 'superroute') { stats.superroute++; continue; }
    const wayIds = (j.members || []).filter((m) => m.type === 'way').map((m) => m.ref);
    const present = wayIds.filter((id) => j.ways[id]);
    if (!present.length) { stats.noGeom++; continue; }
    const lines = present.map((id) => j.ways[id]);
    const b = bbox(lines);
    const why = rejectByTags(tags, { minlat: b[0], minlon: b[1], maxlat: b[2], maxlon: b[3] });
    if (why) { stats[why] = (stats[why] || 0) + 1; continue; }
    rels.push({ id: j.id, tags, name: nameOf(tags), wayIds: present, missing: wayIds.length - present.length, ways: j.ways });
  }

  // 같은 이름·같은 network 관계는 한 노선으로(산별 수집기와 같은 규칙 → 같은 rid).
  const groups = new Map();
  for (const r of rels) {
    const key = `${normalizeName(r.name)}|${r.tags.network || ''}`;
    if (!groups.has(key)) groups.set(key, { name: r.name, rels: [], wayIds: new Set(), ways: {}, missing: 0 });
    const g = groups.get(key);
    g.rels.push(r);
    r.wayIds.forEach((id) => { g.wayIds.add(id); g.ways[id] = r.ways[id]; });
    g.missing += r.missing;
  }
  let list = [...groups.values()];

  // 상위 관계 빼기(구간 관계들에 대부분 덮이면).
  const parents = new Set();
  for (const a of list) {
    const an = normalizeName(a.name);
    const child = new Set();
    for (const b of list) {
      if (b === a) continue;
      const bn = normalizeName(b.name);
      if (bn.length > an.length && bn.includes(an)) b.wayIds.forEach((id) => child.add(id));
    }
    if (!child.size) continue;
    let hit = 0;
    a.wayIds.forEach((id) => { if (child.has(id)) hit++; });
    if (hit / a.wayIds.size >= PARENT_COVER) parents.add(a);
  }
  stats.parent = parents.size;
  list = list.filter((g) => !parents.has(g));

  const walks = [];
  for (const g of list) {
    const rs = g.rels.slice().sort((a, b) => a.id - b.id);
    const first = rs[0];
    const merged = (k) => rs.map((r) => r.tags?.[k]).find(Boolean) || null;
    const chained = chainWays([...g.wayIds].map((id) => g.ways[id]), JOIN_M).map((l) => l.filter(inKorea)).filter((l) => l.length >= 2);
    const km = lengthKm(chained);
    if (km < MIN_KM) { stats.short++; continue; }
    const declared = rs.length === 1 ? parseDistanceKm(first.tags.distance) : null;
    const plausible = declared && Math.abs(declared - km) / declared <= 0.35;
    const partial = g.missing > 0 || (!!declared && km < declared * 0.8);
    const kind = classifyRoute({ name: g.name, network: merged('network'), tags: first.tags });
    const long = isLongDistance({ name: g.name, network: merged('network'), nameEn: merged('name:en') }) || (kind === 'dulle' && km >= 100);
    const tags = {};
    for (const k of ['from', 'to', 'operator', 'network', 'ref', 'distance', 'roundtrip', 'website', 'wikipedia', 'name:en', 'description']) {
      const v = merged(k);
      if (v) tags[k] = String(v).slice(0, 300);
    }
    const links = { osm: `https://www.openstreetmap.org/relation/${first.id}` };
    const wp = wikipediaUrl(merged('wikipedia'));
    if (wp) links.wikipedia = wp;
    const web = merged('website') || merged('url') || merged('contact:website');
    if (web && /^https?:\/\//i.test(web)) links.website = web;
    walks.push({
      rid: `r${first.id}`, src: 'relation', name: g.name, kind, long,
      loop: loopFlag({ roundtrip: merged('roundtrip'), lines: chained, complete: !partial }),
      km: r1(km), total_km: r1(plausible ? declared : km), declared_km: declared, partial,
      pieces: chained.length, osm_ids: rs.map((r) => r.id), tags, links, chained,
    });
  }
  return walks;
}

/** 산별 수집기의 '이름 붙은 길'(관계 아님)을 전국 노선으로 — 여러 산 파일에 같은 길이 있으면 가장 긴 판을 쓴다. */
function namedWalks(byMountain, relWalks, stats) {
  const versions = [];
  for (const [mid, routes] of byMountain) {
    for (const r of routes) if (r.source === 'named-ways' && r.lines?.length) versions.push({ ...r, mid });
  }
  // 이름별로 모은 뒤, 서로 겹치는 판끼리 한 노선으로.
  const byName = new Map();
  for (const v of versions) {
    const k = normalizeName(v.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(v);
  }
  const relLines = relWalks.map((w) => ({ w, b: bbox(w.chained), lines: w.chained }));
  const out = [];
  const alias = {};
  for (const list of byName.values()) {
    list.sort((a, b) => b.length_km - a.length_km || a.rid.localeCompare(b.rid));
    const clusters = [];
    for (const v of list) {
      const c = clusters.find((cl) => cl[0].rid === v.rid || overlapFraction(v.lines, cl[0].lines, 30) >= 0.5 || overlapFraction(cl[0].lines, v.lines, 30) >= 0.5);
      if (c) c.push(v); else clusters.push([v]);
    }
    for (const cl of clusters) {
      const best = cl[0];
      // 관계 노선과 대부분 겹치면 같은 길의 다른 표기 — 뺀다.
      const b = best.bbox;
      const near = relLines.filter((x) => x.b[0] <= b[2] + 0.01 && x.b[2] >= b[0] - 0.01 && x.b[1] <= b[3] + 0.01 && x.b[3] >= b[1] - 0.01);
      if (near.length && overlapFraction(best.lines, near.flatMap((x) => x.lines), 25) >= NAMED_DUP) {
        stats.namedDup++;
        const host = near.find((x) => overlapFraction(best.lines, x.lines, 25) >= 0.3);
        if (host) for (const v of cl) alias[v.rid] = host.w.rid;
        continue;
      }
      for (const v of cl) if (v.rid !== best.rid) alias[v.rid] = best.rid;
      const km = lengthKm(best.lines);
      if (km < MIN_KM) { stats.short++; continue; }
      const links = { ...(best.links || {}) };
      if (!links.osm) links.osm = `https://www.openstreetmap.org/way/${best.osm_ids?.[0] || best.rid.slice(1)}`;
      out.push({
        rid: best.rid, src: 'named-ways', name: best.name, kind: best.kind,
        long: !!best.long || isLongDistance({ name: best.name }),
        loop: best.loop ?? null, km: r1(km), total_km: best.partial ? null : r1(km), declared_km: null,
        partial: !!best.partial, pieces: best.lines.length, osm_ids: best.osm_ids || [],
        tags: best.operator ? { operator: best.operator } : {}, links, chained: best.lines,
      });
    }
  }
  stats.named = out.length;
  return { walks: out, alias };
}

// ── 가까운 명산·형제 구간 ─────────────────────────────────────────────
function nearMountains(lines, b) {
  const padLat = NEAR_KM / 111, padLon = NEAR_KM / (111 * Math.cos((((b[0] + b[2]) / 2) * Math.PI) / 180));
  const out = [];
  for (const m of mountains) {
    if (m.lat < b[0] - padLat || m.lat > b[2] + padLat || m.lon < b[1] - padLon || m.lon > b[3] + padLon) continue;
    const d = minDistToPoint(lines, m.lat, m.lon).km;
    if (d <= NEAR_KM) out.push({ id: m.id, km: r1(d) });
  }
  return out.sort((a, b2) => a.km - b2.km || a.id.localeCompare(b2.id));
}

function bboxGapKm(a, b) {
  const dLat = Math.max(0, a[0] - b[2], b[0] - a[2]) * 111;
  const midLat = ((a[0] + a[2] + b[0] + b[2]) / 4) * Math.PI / 180;
  const dLon = Math.max(0, a[1] - b[3], b[1] - a[3]) * 111 * Math.cos(midLat);
  return Math.hypot(dLat, dLon);
}
const sectionNo = (name) => { const m = String(name).match(/(\d+)\s*(구간|코스)|(\d+)/); return m ? Number(m[1] || m[3]) : Infinity; };

// ── 산별 파일 보강 ────────────────────────────────────────────────────
function enrichMountainFiles(walkByRel, walkByRid, alias) {
  const dir = join(OUT, 'm');
  if (!existsSync(dir)) return 0;
  let changed = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const file = join(dir, f);
    let j;
    try { j = readJSON(file); } catch { continue; }
    let dirty = false;
    for (const r of j.routes || []) {
      const w = r.source === 'relation'
        ? (r.osm_ids || []).map((id) => walkByRel.get(id)).find(Boolean)
        : walkByRid.get(alias[r.rid] || r.rid);
      if (!w) continue;
      const patch = {};
      if (r.partial && w.total_km != null && r.total_km !== w.total_km) patch.total_km = w.total_km;
      if (r.loop == null && w.loop != null && !w.partial) patch.loop = w.loop;
      if (w.long && !r.long) patch.long = true;
      if (Object.keys(patch).length) { Object.assign(r, patch); dirty = true; }
    }
    if (dirty) { writeAtomic(file, JSON.stringify(j)); changed++; }
  }
  return changed;
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const probe = await loadProbe();
  const stats = { notFetched: 0, deleted: 0, superroute: 0, noGeom: 0, short: 0, parent: 0, namedDup: 0 };
  const cands = new Map();
  const pre = {};
  for (const e of probe) {
    const why = rejectByTags(e.tags, e.bounds);
    if (why) { pre[why] = (pre[why] || 0) + 1; continue; }
    cands.set(e.id, { id: e.id, tags: e.tags, bounds: e.bounds });
  }
  // 산별 수집에서 나온 관계 id(목록에 없던 것 — route=walking 등)도 더한다.
  const byMountain = loadMountainRoutes();
  let extra = 0;
  for (const routes of byMountain.values()) for (const r of routes) {
    if (r.source !== 'relation') continue;
    for (const id of r.osm_ids || []) if (!cands.has(id) && !probe.some((e) => e.id === id)) { cands.set(id, { id, tags: null, bounds: null }); extra++; }
  }
  log(`전국 관계 목록 ${probe.length}건 → 후보 ${cands.size}건 (목록 단계 제외 ${JSON.stringify(pre)}, 산별 수집에서 더한 관계 ${extra}건)`);

  await ensureRelations(cands);
  const rel = relationWalks(cands, stats);
  const { walks: named, alias } = namedWalks(byMountain, rel, stats);
  const walks = [...rel, ...named];
  log(`노선: 관계 ${rel.length}건 + 이름 붙은 길 ${named.length}건 = ${walks.length}건`);

  // 선 단순화·가까운 명산·형제 구간
  for (const w of walks) {
    w.detail = w.chained.map((l) => douglasPeucker(l, DETAIL_DP_M).map(([a, b]) => [round5(a), round5(b)])).filter((l) => l.length >= 2);
    w.coarse = w.chained.map((l) => douglasPeucker(l, TILE_DP_M).map(([a, b]) => [r4(a), r4(b)])).filter((l) => l.length >= 2);
    w.bbox = bbox(w.detail).map(round5);
    w.near = nearMountains(w.coarse, w.bbox);
    w.series = seriesKey(w.name);
    const longest = w.detail.slice().sort((a, b) => lengthKm([b]) - lengthKm([a]))[0];
    w.start = longest[0]; w.end = longest[longest.length - 1];
  }
  const bySeries = new Map();
  for (const w of walks) if (w.series) { if (!bySeries.has(w.series)) bySeries.set(w.series, []); bySeries.get(w.series).push(w); }
  for (const w of walks) {
    const sib = (bySeries.get(w.series) || []).filter((x) => x !== w && bboxGapKm(x.bbox, w.bbox) <= SIBLING_KM);
    w.siblings = sib.sort((a, b) => sectionNo(a.name) - sectionNo(b.name) || a.name.localeCompare(b.name, 'ko'))
      .slice(0, 40).map((x) => ({ rid: x.rid, name: x.name, kind: x.kind, long: x.long, km: x.km }));
    if (!w.siblings.length) w.series = null;
  }

  // 쓰기 — 지난 실행의 파일 중 이번에 없는 것은 지운다.
  const wDir = join(OUT, 'w'), tDir = join(OUT, 'tiles');
  const keepW = new Set(), keepT = new Set();
  let wBytes = 0, tBytes = 0;
  for (const w of walks) {
    const detail = {
      rid: w.rid, name: w.name, kind: w.kind, kind_label: KIND_LABEL[w.kind], long: w.long, loop: w.loop,
      km: w.km, total_km: w.total_km, declared_km: w.declared_km, partial: w.partial, pieces: w.detail.length,
      source: w.src, osm_ids: w.osm_ids, tags: w.tags, links: w.links,
      start: w.start, end: w.end, bbox: w.bbox,
      near: w.near.slice(0, NEAR_DETAIL).map((n) => (n.km <= PASS_KM ? { ...n, passes: true } : n)),
      series: w.series, siblings: w.siblings,
      generated: TODAY, attribution: ATTRIBUTION, note: w.src === 'relation' ? NOTE_REL : NOTE_NAMED,
      lines: w.detail,
    };
    const text = JSON.stringify(detail);
    writeAtomic(join(wDir, `${w.rid}.json`), text);
    keepW.add(`${w.rid}.json`); wBytes += text.length;
  }
  const tiles = new Map();
  for (const w of walks) {
    for (const [k, lines] of splitToTiles(w.coarse)) {
      if (!tiles.has(k)) tiles.set(k, []);
      tiles.get(k).push({ rid: w.rid, kind: w.kind, long: w.long, lines });
    }
  }
  // 남한 범위의 빈 칸도 빈 타일로 둔다 — 지도가 바다·노선 없는 지역을 비출 때 404가 나지 않게.
  for (let la = 33; la <= 38; la++) for (let lo = 124; lo <= 130; lo++) if (!tiles.has(`${la}_${lo}`)) tiles.set(`${la}_${lo}`, []);
  for (const [k, routes] of tiles) {
    const text = JSON.stringify({ tile: k, generated: TODAY, attribution: ATTRIBUTION, routes });
    writeAtomic(join(tDir, `${k}.json`), text);
    keepT.add(`${k}.json`); tBytes += text.length;
  }
  for (const [dir, keep] of [[wDir, keepW], [tDir, keepT]]) {
    for (const f of readdirSync(dir)) if (f.endsWith('.json') && !keep.has(f)) rmSync(join(dir, f));
  }
  const kindOrder = { dulle: 0, ridge: 1, forest: 2, trail: 3, other: 4 };
  const index = walks.slice().sort((a, b) => (kindOrder[a.kind] - kindOrder[b.kind]) || a.name.localeCompare(b.name, 'ko')).map((w) => {
    const o = { rid: w.rid, name: w.name, kind: w.kind, long: w.long, loop: w.loop, km: w.km, total_km: w.total_km,
      near: w.near.slice(0, NEAR_INDEX), bbox: w.bbox };
    if (w.series) o.series = w.series;
    if (w.src !== 'relation') o.src = 'named';
    return o;
  });
  const indexText = JSON.stringify(index);
  writeAtomic(join(OUT, 'walks-index.json'), indexText);
  // 산별 파일 rid → 전국 rid (관계 묶음이 산 범위에 따라 다른 id로 시작하는 경우 포함)
  const walkByRel = new Map();
  for (const w of rel) for (const id of w.osm_ids) walkByRel.set(id, w);
  const walkByRid = new Map(walks.map((w) => [w.rid, w]));
  for (const routes of byMountain.values()) for (const r of routes) {
    if (r.source !== 'relation' || walkByRid.has(r.rid)) continue;
    const w = (r.osm_ids || []).map((id) => walkByRel.get(id)).find(Boolean);
    if (w) alias[r.rid] = w.rid;
  }
  for (const k of Object.keys(alias)) if (alias[k] === k || !walkByRid.has(alias[k])) delete alias[k];
  // 공개 산별 파일에만 있는 노선(전국 목록에서 겹침·상위 노선으로 빠진 것) → 'm:<산id>'
  const mDir = join(OUT, 'm');
  let localOnly = 0;
  if (existsSync(mDir)) for (const f of readdirSync(mDir).filter((x) => x.endsWith('.json')).sort()) {
    let j;
    try { j = readJSON(join(mDir, f)); } catch { continue; }
    for (const r of j.routes || []) {
      if (walkByRid.has(r.rid) || alias[r.rid]) continue;
      alias[r.rid] = `m:${f.slice(0, -5)}`;
      localOnly++;
    }
  }
  writeAtomic(join(OUT, 'alias.json'), JSON.stringify(alias));
  if (localOnly) log(`산별 파일에만 있는 노선 ${localOnly}건(전국 상세 없음 → 산 파일로 연결)`);
  const enriched = enrichMountainFiles(walkByRel, walkByRid, alias);

  const kinds = {};
  for (const w of walks) { const k = w.kind === 'dulle' && w.long ? 'long' : w.kind; kinds[k] = (kinds[k] || 0) + 1; }
  log(`종류: ${JSON.stringify(kinds)} · 순환 ${walks.filter((w) => w.loop === true).length} · 편도 ${walks.filter((w) => w.loop === false).length} · 미상 ${walks.filter((w) => w.loop == null).length}`);
  log(`제외: ${JSON.stringify(stats)}`);
  log(`walks-index.json ${(indexText.length / 1024).toFixed(0)}KB · tiles ${tiles.size}개 ${(tBytes / 1024 / 1024).toFixed(2)}MB · w ${walks.length}개 ${(wBytes / 1024 / 1024).toFixed(2)}MB · alias ${Object.keys(alias).length}건 · 산별 파일 보강 ${enriched}개`);
  log(`완료 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
