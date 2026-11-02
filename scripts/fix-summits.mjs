#!/usr/bin/env node
// 정상 좌표 보정안 — 웹 조사로 "지도 대조 추정"한 정상 좌표가 실제 정상에서 수 km 어긋난 산이 많다
// (예: 속리산 천왕봉 4.5km). 이 좌표로 계산한 경로는 정상이 아닌 곳에서 끝나고, 공식 코스의
// "정상 경유" 판정도 틀린다. OpenStreetMap 정상(peak) 노드와 위키데이터 좌표를 독립적으로 대조해
// 근거가 확실한 것만 data/summit-corrections.json에 남긴다(build-data.mjs가 적용).
//
// 받을 것(로컬 캐시):
//   .cache/osm/peaks.json        osmium으로 뽑은 natural=peak 노드(scripts/lib/osm-local.mjs 참고)
//   .cache/wikidata/mountains.json  한국(P17=Q884) 산(P31/P279*=Q8502)의 좌표·고도 SPARQL 결과
//
// 채택 규칙(아래 하나 + 지형 확인):
//   osm+wikidata  OSM 정상 노드가 같은 이름의 위키데이터 좌표와 600m 안에서 일치
//   osm-name-ele  OSM 정상 노드의 이름이 산·주봉 이름과 맞고 고도가 등록 고도와 2m 안에서 같다
//   osm-name-dem  이름이 맞고, 지형(SRTM)으로 본 새 자리가 등록 고도에 가깝고 옛 자리보다 확연히 높다
// 지형 확인: 새 자리 주변 60m의 SRTM 최고 고도가 등록 고도 −45m 이상이어야 한다(엉뚱한 낮은 봉우리 방지).
// 그 밖(근거 하나뿐·이름 불일치)은 고치지 않고 skipped에 이유를 남긴다.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversine } from './lib/geo.mjs';
import { ElevationDEM } from './lib/elevation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const verified = JSON.parse(readFileSync(join(ROOT, 'data', 'enrichment.verified.json'), 'utf8'));
const enrichById = new Map(verified.results.map((r) => [r.id, r]));
// 보정 전 좌표(조사 자료 enrichment.verified.json)에서 출발한다 — 보정이 적용된 mountains.json에서 다시 계산하면
// 모두 "이미 정상 근처"가 되어 보정 목록이 비고, build-data가 옛 좌표로 되돌아간다.
const registry = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'mountains.json'), 'utf8')).mountains.map((m) => {
  const e = enrichById.get(m.id);
  return e && Number.isFinite(e.lat) && Number.isFinite(e.lon) ? { ...m, lat: e.lat, lon: e.lon } : m;
});
const peaks = JSON.parse(readFileSync(join(ROOT, '.cache', 'osm', 'peaks.json'), 'utf8'));
const wd = JSON.parse(readFileSync(join(ROOT, '.cache', 'wikidata', 'mountains.json'), 'utf8')).results.bindings.map((b) => {
  const [lon, lat] = b.coord.value.replace(/^Point\(|\)$/g, '').split(' ').map(Number);
  return { qid: b.item.value.split('/').pop(), label: b.itemLabel?.value || '', lat, lon, ele: b.ele ? Number(b.ele.value) : null };
});

const SEARCH_M = 8000;
const MOVE_MIN_M = 150;       // 이보다 가까우면 고치지 않는다(이미 정상 근처)
const WD_AGREE_M = 600;
const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/\([^)]*\)/g, '');
const baseName = (s) => norm(s).replace(/\(.*$/, '');

/** 산 이름 + 기록에 나오는 주봉 이름(○○봉·○○대) — 정상 노드 이름 대조용 */
function expectedNames(m) {
  const e = enrichById.get(m.id) || {};
  const text = `${e.coord_source || ''} ${m.coord_source || ''}`;
  const names = new Set([baseName(m.name)]);
  for (const x of text.matchAll(/([가-힣]{1,5}(?:봉|대))(?![가-힣])/g)) names.add(x[1]);
  names.delete('정상봉'); names.delete('최고봉'); names.delete('주봉'); names.delete('국립공원대');
  return [...names].filter((n) => n.length >= 2);
}

const dem = new ElevationDEM(join(ROOT, '.cache', 'routes', 'dem'));
/** 점 주변 r m 안(격자 표본)의 SRTM 최고 고도 */
async function demMax([lat, lon], r = 60) {
  const pts = [];
  const dLat = r / 111320, dLon = r / (111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) pts.push([lat + (dLat * i) / 2, lon + (dLon * j) / 2]);
  const e = (await dem.lookup(pts)).filter(Number.isFinite);
  return e.length ? Math.round(Math.max(...e)) : null;
}

const corrections = [], skipped = [];
for (const m of registry) {
  if (m.lat == null) continue;
  const names = expectedNames(m);
  // 찾는 중심: 지금 정상 좌표 + 등록 들머리들의 중앙값. 정상 좌표가 10km 넘게 어긋난 산(운악산 12km, 금오산 15km)은
  // 실제 정상이 들머리 쪽에 있다 — 정상 좌표 둘레만 찾으면 놓친다.
  const th = (m.trails || []).map((t) => t.trailhead).filter((x) => Array.isArray(x) && Number.isFinite(x[0]));
  const centers = [[m.lat, m.lon]];
  if (th.length) {
    const med = (arr) => arr.slice().sort((a, b) => a - b)[arr.length >> 1];
    centers.push([med(th.map((x) => x[0])), med(th.map((x) => x[1]))]);
  }
  const cand = peaks.map((p) => ({ ...p, d: haversine(m.lat, m.lon, p.lat, p.lon) }))
    .filter((p) => centers.some(([la, lo]) => haversine(la, lo, p.lat, p.lon) <= SEARCH_M));
  const nameOk = (p) => {
    const n = norm(p.name) + '|' + norm(p.nameko);
    return names.some((x) => n.includes(x));
  };
  const eleDiff = (p) => (Number.isFinite(p.ele) ? Math.abs(p.ele - m.elevation_m) : Infinity);
  // 이름이 맞는 노드를 먼저, 그다음 고도 차, 그다음 거리
  const ranked = cand.filter(nameOk).sort((a, b) => (eleDiff(a) - eleDiff(b)) || (a.d - b.d));
  const best = ranked[0] || null;
  const wdSame = wd.filter((w) => baseName(w.label) === baseName(m.name) && centers.some(([la, lo]) => haversine(la, lo, w.lat, w.lon) <= 20000));

  if (!best) { skipped.push({ id: m.id, name: m.name, reason: 'OSM에 이름이 맞는 정상 노드 없음', names }); continue; }
  const moved = best.d;
  const wdHit = wdSame.map((w) => ({ ...w, dist: haversine(best.lat, best.lon, w.lat, w.lon) })).sort((a, b) => a.dist - b.dist)[0] || null;
  // 같은 이름 위키데이터 좌표 바로 옆(150m)에 등록 고도와 5m 안의 OSM 정상 노드가 있으면, 이름이 다른 노드라도 그것이
  // 그 산의 정상이다(문암산: 기록상 1,146m 봉 = OSM '석화산' 1149, 위키데이터 문암산 좌표 30m 옆. 이름만 같은 1,165m 봉이 아님).
  // 이름이 맞는 노드가 위키데이터·고도로 확인되면 그쪽이 우선이고, 아니면 이름+지형 규칙보다 이것을 먼저 쓴다.
  const wdPeak = (() => {
    for (const w of wdSame) {
      const p = peaks.filter((x) => Number.isFinite(x.ele) && Math.abs(x.ele - m.elevation_m) <= 5)
        .map((x) => ({ ...x, dw: haversine(w.lat, w.lon, x.lat, x.lon) })).filter((x) => x.dw <= 150).sort((a, b) => a.dw - b.dw)[0];
      if (p) return { p, w };
    }
    return null;
  })();
  const nameStrong = (wdHit0) => (wdHit0 && wdHit0.dist <= WD_AGREE_M) || eleDiff(best) <= 2;
  const wdHit0 = wdSame.map((w) => ({ ...w, dist: haversine(best.lat, best.lon, w.lat, w.lon) })).sort((a, b) => a.dist - b.dist)[0] || null;
  // 이름이 다른 봉우리로 옮길 때는 우리 기록이 그 이름을 "같은 봉우리"로 적어 두었을 때만 — '문암산(석화산)'.
  // '지리산-불모산(달바위)'처럼 별개 봉우리로 적힌 경우(사량도)는 옮기지 않는다.
  const sameAs = (alt) => {
    const e = enrichById.get(m.id) || {};
    const text = `${e.summary || ''} ${(e.trails || []).map((t) => t.name).join(' ')}`.replace(/\s+/g, '');   // 괄호는 남긴다
    const a = baseName(alt), b = baseName(m.name);
    return a === b || text.includes(`${b}(${a}`) || text.includes(`${a}(${b}`);
  };
  if (wdPeak && !nameStrong(wdHit0) && (wdPeak.p.lat !== best.lat || wdPeak.p.lon !== best.lon) && sameAs(wdPeak.p.name)) {
    const p = wdPeak.p;
    const demP = await demMax([p.lat, p.lon]);
    const movedP = haversine(m.lat, m.lon, p.lat, p.lon);
    const infoP = {
      id: m.id, name: m.name, elevation_m: m.elevation_m,
      from: [m.lat, m.lon], to: [+p.lat.toFixed(6), +p.lon.toFixed(6)], moved_m: Math.round(movedP),
      osm: { node: p.id, name: p.name, ele: p.ele }, wikidata: { qid: wdPeak.w.qid, label: wdPeak.w.label, dist_m: Math.round(p.dw) },
      srtm: { new_max_m: demP, old_max_m: await demMax([m.lat, m.lon]) },
      note: `이름이 같은 OSM 노드 ${best.name}(${best.ele}m)는 등록 고도와 맞지 않아 쓰지 않음`,
    };
    if (movedP < MOVE_MIN_M) { skipped.push({ ...infoP, reason: `이미 정상 ${Math.round(movedP)}m 안` }); continue; }
    if (demP == null || demP < m.elevation_m - 45) { skipped.push({ ...infoP, reason: `지형 불일치(새 자리 SRTM 최고 ${demP}m)` }); continue; }
    corrections.push({ ...infoP, rule: 'wikidata+osm-ele' });
    continue;
  }
  const demNew = await demMax([best.lat, best.lon]);
  const demOld = await demMax([m.lat, m.lon]);
  const demOk = demNew != null && demNew >= m.elevation_m - 45;
  let rule = null;
  if (wdHit && wdHit.dist <= WD_AGREE_M) rule = 'osm+wikidata';
  else if (eleDiff(best) <= 2) rule = 'osm-name-ele';
  else if (demOk && demOld != null && demNew - demOld >= 50 && demNew >= m.elevation_m - 30) rule = 'osm-name-dem';
  const info = {
    id: m.id, name: m.name, elevation_m: m.elevation_m,
    from: [m.lat, m.lon], to: [+best.lat.toFixed(6), +best.lon.toFixed(6)], moved_m: Math.round(moved),
    osm: { node: best.id, name: best.name, ele: Number.isFinite(best.ele) ? best.ele : null },
    wikidata: wdHit ? { qid: wdHit.qid, label: wdHit.label, dist_m: Math.round(wdHit.dist) } : null,
    srtm: { new_max_m: demNew, old_max_m: demOld },
  };
  if (moved < MOVE_MIN_M) { skipped.push({ ...info, reason: `이미 정상 ${Math.round(moved)}m 안` }); continue; }
  if (!rule) { skipped.push({ ...info, reason: `근거 부족(고도 차 ${Number.isFinite(eleDiff(best)) ? eleDiff(best).toFixed(1) : '?'}m, 위키데이터 ${wdHit ? `${Math.round(wdHit.dist)}m` : '없음'}, 지형 새 ${demNew}m/옛 ${demOld}m)` }); continue; }
  if (!demOk) { skipped.push({ ...info, reason: `지형 불일치(새 자리 SRTM 최고 ${demNew}m < 등록 ${m.elevation_m}m − 45)` }); continue; }
  corrections.push({ ...info, rule });
}

dem.save();
const out = {
  meta: {
    generated_at: new Date().toISOString(), generator: 'scripts/fix-summits.mjs',
    rules: {
      'osm+wikidata': `OpenStreetMap 정상 노드가 같은 이름의 위키데이터 좌표와 ${WD_AGREE_M}m 안에서 일치`,
      'osm-name-ele': 'OpenStreetMap 정상 노드의 이름이 산·주봉 이름과 맞고 고도가 등록 고도와 2m 안',
      'osm-name-dem': '이름이 맞고, SRTM 지형으로 본 새 자리가 등록 고도 30m 안이며 옛 자리보다 50m 넘게 높음',
      'wikidata+osm-ele': '같은 이름의 위키데이터 좌표 150m 안에 등록 고도와 5m 안인 OSM 정상 노드(노드 이름은 다를 수 있음)',
      terrain_check: '모든 보정은 새 자리 주변 60m의 SRTM 최고 고도가 등록 고도 −45m 이상일 때만 채택',
    },
    sources: [
      { name: 'OpenStreetMap', license: 'ODbL 1.0', attribution: '© OpenStreetMap contributors' },
      { name: 'Wikidata', license: 'CC0' },
      { name: 'SRTM 1 arc-second (NASA/USGS) — AWS Terrain Tiles', role: '지형 고도 확인(osm-name-dem 규칙·모든 보정의 지형 검사)', license: 'public domain' },
    ],
  },
  corrections: corrections.sort((a, b) => b.moved_m - a.moved_m),
  skipped: skipped.sort((a, b) => a.id.localeCompare(b.id)),
};
writeFileSync(join(ROOT, 'data', 'summit-corrections.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`보정 ${corrections.length}곳 (위키데이터 일치 ${corrections.filter((c) => c.rule === 'osm+wikidata').length} · 이름·고도 일치 ${corrections.filter((c) => c.rule === 'osm-name-ele').length}) · 건너뜀 ${skipped.length}곳`);
for (const c of corrections) console.log(`  ${c.id.padEnd(26)} ${String(c.moved_m).padStart(5)}m → ${c.osm.name}(${c.osm.ele}) ${c.rule}${c.wikidata ? ` wd ${c.wikidata.dist_m}m` : ''} · SRTM 새 ${c.srtm.new_max_m}/옛 ${c.srtm.old_max_m} (등록 ${c.elevation_m})`);
console.log('건너뜀:');
for (const s of skipped.filter((x) => !String(x.reason).startsWith('이미'))) console.log(`  ${s.id.padEnd(26)} ${s.reason}${s.osm ? ` · 후보 ${s.osm.name}(${s.osm.ele}) ${s.moved_m}m` : ''}`);
