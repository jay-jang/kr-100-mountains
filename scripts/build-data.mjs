// build-data.mjs — merges data/registry.json + data/enrichment.json into:
//   - public/data/mountains.json  (consumed by the frontend)
//   - data/mountains/<id>.md      (OKF-style LLM-wiki source, one per mountain)
// Run: npm run build:data   (or node scripts/build-data.mjs)
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const registry = JSON.parse(readFileSync(join(ROOT, 'data', 'registry.json'), 'utf8'));

// enrichment: { results: [ {id, lat, lon, coord_confidence, summary, trails, transport, features, best_season, sources, elevation_m} ] }
// Prefer the cross-verified courses if present (data/enrichment.verified.json).
let enrichment = { results: [] };
const verifiedPath = join(ROOT, 'data', 'enrichment.verified.json');
const enrichPath = existsSync(verifiedPath) ? verifiedPath : join(ROOT, 'data', 'enrichment.json');
if (existsSync(enrichPath)) {
  enrichment = JSON.parse(readFileSync(enrichPath, 'utf8'));
  console.log(`using ${enrichPath.split('/').pop()}`);
}
const byId = new Map(enrichment.results.map(r => [r.id, r]));
const famous = JSON.parse(readFileSync(join(ROOT, 'data', 'famous-courses.json'), 'utf8'));
const famousById = new Map(famous.mountains.map(m => [m.mountain_id, m.courses]));
// 정상 좌표 보정(scripts/fix-summits.mjs) — OSM 정상 노드 + 위키데이터·지형으로 확인된 것만.
const summitPath = join(ROOT, 'data', 'summit-corrections.json');
const summitFix = new Map(existsSync(summitPath) ? JSON.parse(readFileSync(summitPath, 'utf8')).corrections.map((c) => [c.id, c]) : []);
const RULE_TEXT = { 'osm+wikidata': '위키데이터 좌표와 일치', 'osm-name-ele': '이름·고도 일치', 'osm-name-dem': '이름 일치·지형 고도 확인', 'wikidata+osm-ele': '위키데이터 좌표 옆·고도 일치' };
const mediaPath = join(ROOT, 'data', 'mountain-media.json');
const media = existsSync(mediaPath) ? JSON.parse(readFileSync(mediaPath, 'utf8')).mountains : {};

// 공식 탐방코스(국립공원공단 등) — scripts/build-course-routes.mjs가 만든 사실 정보. 지도 선은 public/gpx/courses/.
const officialPath = join(ROOT, 'data', 'official-courses.json');
const official = existsSync(officialPath) ? JSON.parse(readFileSync(officialPath, 'utf8')) : { courses: [] };
const officialByMountain = new Map();
{
  const ids = new Set();
  for (const c of official.courses) {
    if (!c.id || ids.has(c.id) || !c.name || c.name.includes('\uFFFD') || (c.section || '').includes('\uFFFD')) throw new Error(`invalid official course ${c.id}`);
    ids.add(c.id);
    if (new URL(c.url).protocol !== 'https:') throw new Error(`${c.id}: official course url must be https`);
    for (const mm of c.mountains || []) {
      if (!registry.mountains.some((m) => m.id === mm.id)) throw new Error(`${c.id}: unknown mountain ${mm.id}`);
      if (!officialByMountain.has(mm.id)) officialByMountain.set(mm.id, []);
      officialByMountain.get(mm.id).push({ c, mm });
    }
  }
}
if (famousById.size !== registry.mountains.length || famous.mountains.length !== famousById.size) {
  throw new Error('Representative courses must cover every mountain exactly once');
}

// Korea bounding box sanity check
const inKorea = (lat, lon) =>
  typeof lat === 'number' && typeof lon === 'number' &&
  lat >= 33.0 && lat <= 38.8 && lon >= 124.5 && lon <= 131.9;

const issues = [];
const mountains = registry.mountains.map(m => {
  const e = byId.get(m.id);
  const out = { ...m };
  if (e) {
    const coordOk = inKorea(e.lat, e.lon);
    if (coordOk) { out.lat = e.lat; out.lon = e.lon; }
    else issues.push(`${m.id}: coord out of range (${e.lat},${e.lon})`);
    out.coord_confidence = e.coord_confidence || (coordOk ? 'medium' : 'low');
    out.summary = e.summary || null;
    out.trails = Array.isArray(e.trails) ? e.trails : [];
    out.transport = e.transport || null;
    out.features = Array.isArray(e.features) ? e.features : [];
    out.best_season = e.best_season || null;
    out.sources = Array.isArray(e.sources) ? e.sources : [];
    out.coord_source = e.coord_source || null;
    const fix = summitFix.get(m.id);
    if (fix) {
      if (Math.abs(fix.from[0] - out.lat) > 1e-6 || Math.abs(fix.from[1] - out.lon) > 1e-6) {
        throw new Error(`${m.id}: summit correction was made from a different coordinate — rerun scripts/fix-summits.mjs`);
      }
      out.lat = fix.to[0]; out.lon = fix.to[1];
      out.coord_confidence = 'high';
      out.summit_name = fix.osm.name || out.name;
      out.coord_source = `OpenStreetMap 정상 노드 ${fix.osm.node}(${fix.osm.name}${fix.osm.ele != null ? ` ${fix.osm.ele}m` : ''}) — ${RULE_TEXT[fix.rule] || fix.rule}. 이전 추정 좌표에서 ${fix.moved_m.toLocaleString('en-US')}m 보정`;
    }
  } else {
    issues.push(`${m.id}: no enrichment`);
    out.coord_confidence = 'none';
  }
  if (media[m.id]) {
    const image = media[m.id];
    if (!existsSync(join(ROOT, 'public', image.file)) || !image.author || !image.license || !image.source) throw new Error(`${m.id}: invalid mountain image`);
    out.image = image;
  }
  const courses = famousById.get(m.id);
  if (!courses?.length) throw new Error(`${m.id}: no representative courses`);
  const courseIds = new Set();
  out.famous_courses = courses.map(c => {
    if (!c.id || courseIds.has(c.id) || !c.name || c.name.includes('\uFFFD') || !c.selection_reason ||
        !['official', 'catalog'].includes(c.evidence) || !c.sources?.length) {
      throw new Error(`${m.id}: invalid representative course ${c.id}`);
    }
    courseIds.add(c.id);
    for (const s of c.sources) {
      const url = new URL(s.url);
      if (!['http:', 'https:'].includes(url.protocol) || !s.title ||
          s.scope !== (c.evidence === 'official' ? 'course' : 'mountain') ||
          (c.evidence === 'official' && !s.checked_at)) throw new Error(`${c.id}: invalid source`);
    }
    const trailIndex = c.trail_name ? out.trails.findIndex(t => t.name === c.trail_name) : -1;
    if (c.trail_name && trailIndex < 0) throw new Error(`${c.id}: missing referenced trail`);
    // 공단 코스 안내 링크(vcursId)가 같은 공식 코스가 있으면 잇는다 — 같은 코스를 두 행으로 보이지 않게.
    const vcurs = c.sources?.map((s) => new URL(s.url).searchParams.get('vcursId')).find(Boolean);
    const officialId = vcurs && (officialByMountain.get(m.id) || []).some(({ c: oc }) => oc.vcurs_id === vcurs) ? `knps-${vcurs.toLowerCase()}` : null;
    return { ...c, ...(trailIndex >= 0 ? { trail_index: trailIndex } : {}), ...(officialId ? { official_id: officialId } : {}) };
  });
  const linkedOfficial = new Set(out.famous_courses.map((c) => c.official_id).filter(Boolean));
  // 등록 등산로와 같은 코스(들머리가 공식 선 위) — 그 등산로에 대표 코스의 공식 선이 아직 없을 때만 잇는다.
  const trailsWithOfficial = new Set(out.famous_courses.filter((c) => c.official_id && c.trail_index != null).map((c) => c.trail_index));
  out.official_courses = (officialByMountain.get(m.id) || [])
    // 등산로 연결은 번호만 믿지 않고 이름까지 맞아야 한다 — 조사 자료의 등산로 순서가 바뀌면 다른 행에 붙는다.
    .map(({ c, mm }) => {
      let ti = !linkedOfficial.has(c.id) && mm.trail_index != null && !trailsWithOfficial.has(mm.trail_index) ? mm.trail_index : null;
      if (ti != null && out.trails[ti]?.name !== mm.trail_name) {
        issues.push(`${m.id}: official ${c.id} trail link #${ti} "${mm.trail_name}" no longer matches "${out.trails[ti]?.name}" — rerun scripts/build-course-routes.mjs`);
        ti = null;
      }
      return { c, mm, ti };
    })
    .map(({ c, mm, ti }) => ({
      id: c.id, source: c.source, name: c.name, park: c.park || null, section: c.section || null,
      schedule: c.schedule || null, distance_km: c.distance_km ?? null, minutes: c.minutes ?? null,
      difficulty: c.difficulty || null, level: c.level || null, starts: c.starts || [],
      url: c.url, checked_at: c.checked_at, reaches_summit: !!mm.reaches_summit, summit_dist_m: mm.summit_dist_m,
      has_line: !!c.line, ...(linkedOfficial.has(c.id) ? { famous_linked: true } : {}), ...(ti != null ? { trail_index: ti } : {}),
    }))
    // 정상 경유 → 선 있음 → 정상에서 가까운 순
    .sort((a, b) => (b.reaches_summit - a.reaches_summit) || (b.has_line - a.has_line) || (a.summit_dist_m - b.summit_dist_m) || a.name.localeCompare(b.name, 'ko'));
  return out;
});

// ---- write mountains.json ----
mkdirSync(join(ROOT, 'public', 'data'), { recursive: true });
const enriched = mountains.filter(m => m.summary).length;
const withCoords = mountains.filter(m => m.lat != null).length;
const payload = {
  meta: {
    ...registry.meta,
    generated: 'build-data.mjs',
    enriched,
    with_coords: withCoords,
    famous_courses: {
      ...famous.meta,
      mountains: mountains.length,
      courses: mountains.reduce((n, m) => n + m.famous_courses.length, 0),
      official: mountains.reduce((n, m) => n + m.famous_courses.filter(c => c.evidence === 'official').length, 0),
    },
    official_courses: {
      ...(official.meta ? { source: official.meta.source, note: official.meta.note } : {}),
      courses: official.courses.length,
      mountains: mountains.filter((m) => m.official_courses.length).length,
      with_line: official.courses.filter((c) => c.line).length,
    },
  },
  mountains,
};
writeFileSync(join(ROOT, 'public', 'data', 'mountains.json'), JSON.stringify(payload));

// 수록 GPX 매니페스트 — 상세 페이지가 없는 GPX를 요청해 404를 내지 않도록 목록화
const gpxDir = join(ROOT, 'public', 'gpx');
const gpxIds = existsSync(gpxDir) ? readdirSync(gpxDir).filter((f) => f.endsWith('.gpx')).map((f) => f.replace(/\.gpx$/, '')) : [];
mkdirSync(gpxDir, { recursive: true });
writeFileSync(join(gpxDir, 'index.json'), JSON.stringify(gpxIds));
console.log(`gpx manifest: ${gpxIds.length} curated route(s)`);
writeFileSync(join(ROOT, 'public', 'data', 'mountains.pretty.json'), JSON.stringify(payload, null, 2) + '\n');

// ---- write OKF-style wiki markdown, one per mountain ----
const MD_DIR = join(ROOT, 'data', 'mountains');
mkdirSync(MD_DIR, { recursive: true });
const yamlList = (arr) => arr && arr.length ? '[' + arr.map(x => JSON.stringify(x)).join(', ') + ']' : '[]';
for (const m of mountains) {
  const fm = [
    '---',
    `id: ${m.id}`,
    `name: ${m.name}`,
    `name_full: ${JSON.stringify(m.name_full)}`,
    `elevation_m: ${m.elevation_m}`,
    `region: ${m.region}`,
    `province: ${m.province}`,
    `location: ${JSON.stringify(m.location)}`,
    `lists: [${['sanlim', 'bac', 'hansanha', 'wolgansan'].filter((k) => m.lists[k]).join(', ')}]`,
    `coordinates: ${m.lat != null ? `[${m.lat}, ${m.lon}]` : 'null'}`,
    `coord_confidence: ${m.coord_confidence || 'none'}`,
    `features: ${yamlList(m.features)}`,
    `best_season: ${JSON.stringify(m.best_season || '')}`,
    '---',
  ].join('\n');

  const body = [];
  body.push(`# ${m.name_full}`, '');
  const LIST_LABEL = { sanlim: '산림청 100대 명산', bac: '블랙야크 명산100', hansanha: '한국의산하 인기명산 100', wolgansan: '월간산 100대 명산' };
  body.push(`> ${m.region} · ${m.location} · 해발 ${m.elevation_m}m` +
    ` · ${['sanlim', 'bac', 'hansanha', 'wolgansan'].filter((k) => m.lists[k]).map((k) => LIST_LABEL[k]).join(' / ')}`, '');
  if (m.summary) body.push('## 개요', '', m.summary, '');
  body.push('## 대표·유명 코스', '', famous.meta.policy, '', famous.meta.catalog_note, '');
  for (const c of m.famous_courses) {
    body.push(`### ${c.name}`, '', `- 선정 유형: ${c.selection_reason}`);
    if (c.via?.length) body.push(`- 주요 동선: ${c.via.join(' → ')}`);
    if (c.highlight) body.push(`- 특징: ${c.highlight}`);
    body.push(`- 근거: ${c.evidence === 'official' ? '공식 코스 안내 확인' : '기존 자료 선정 (산 단위 참고자료)'}`,
      ...c.sources.map(s => `- [${s.title}](${s.url})${s.checked_at ? ` (확인: ${s.checked_at})` : ''}`), '');
  }
  if (m.official_courses.length) {
    body.push('## 공식 탐방코스', '', official.meta?.note || '', '');
    for (const c of m.official_courses) {
      const facts = [c.park && `${c.park}국립공원`, c.distance_km && `${c.distance_km}km`, c.minutes && `${Math.floor(c.minutes / 60) ? `${Math.floor(c.minutes / 60)}시간 ` : ''}${c.minutes % 60 ? `${c.minutes % 60}분` : ''}`.trim(), c.level && `난이도 ${c.level}`, c.reaches_summit ? '정상 경유' : '정상 미경유'].filter(Boolean);
      body.push(`- **${c.name}** — ${facts.join(' · ')}${c.section ? `<br>구간: ${c.section}` : ''} ([공단 안내](${c.url}))`);
    }
    body.push('');
  }
  if (m.trails && m.trails.length) {
    const vmark = { verified: '교차검증 일치 ✓', mixed: '난이도 상이 ⚠', single: '단일 확인', unverified: '' };
    body.push('## 주요 등산로', '');
    body.push('| 코스 | 거리 | 오름(편도) | 왕복 | 난이도 | 교차검증 |',
      '| --- | --- | --- | --- | --- | --- |');
    for (const t of m.trails) {
      const a = t.ascent_hours ? `${t.ascent_hours}시간` : '-';
      const r = t.round_trip_hours ? `${t.round_trip_hours}시간` : (t.duration || '-');
      const v = t.verify ? (vmark[t.verify.level] || '') : '';
      body.push(`| ${t.name || '-'} | ${t.distance_km ? t.distance_km + 'km' : '-'} | ${a} | ${r} | ${t.difficulty || '-'} | ${v} |`);
    }
    body.push('');
    for (const t of m.trails) if (t.start || t.note) body.push(`- **${t.name}** — ${[t.start && '들머리: ' + t.start, t.note].filter(Boolean).join(' · ')}`);
    body.push('');
  }
  if (m.transport) body.push('## 교통', '', m.transport, '');
  if (m.features && m.features.length) body.push('## 특징', '', m.features.map(f => `#${f}`).join(' '), '');
  if (m.sources && m.sources.length) {
    body.push('## 출처', '', ...m.sources.map(s => `- ${s}`), '');
  }
  writeFileSync(join(MD_DIR, `${m.id}.md`), fm + '\n\n' + body.join('\n'));
}

console.log(`mountains.json: ${mountains.length} mountains | enriched ${enriched} | with_coords ${withCoords}`);
console.log(`wiki markdown: ${mountains.length} files in data/mountains/`);
if (issues.length) {
  console.log(`\n${issues.length} issue(s):`);
  console.log(issues.slice(0, 40).join('\n'));
}
