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
  } else {
    issues.push(`${m.id}: no enrichment`);
    out.coord_confidence = 'none';
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
    return { ...c, ...(trailIndex >= 0 ? { trail_index: trailIndex } : {}) };
  });
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
