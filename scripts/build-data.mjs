// build-data.mjs — merges data/registry.json + data/enrichment.json into:
//   - public/data/mountains.json  (consumed by the frontend)
//   - data/mountains/<id>.md      (OKF-style LLM-wiki source, one per mountain)
// Run: npm run build:data   (or node scripts/build-data.mjs)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const registry = JSON.parse(readFileSync(join(ROOT, 'data', 'registry.json'), 'utf8'));

// enrichment: { results: [ {id, lat, lon, coord_confidence, summary, trails, transport, features, best_season, sources, elevation_m} ] }
// Prefer the codex/agy cross-verified courses if present (data/enrichment.verified.json).
let enrichment = { results: [] };
const verifiedPath = join(ROOT, 'data', 'enrichment.verified.json');
const enrichPath = existsSync(verifiedPath) ? verifiedPath : join(ROOT, 'data', 'enrichment.json');
if (existsSync(enrichPath)) {
  enrichment = JSON.parse(readFileSync(enrichPath, 'utf8'));
  console.log(`using ${enrichPath.split('/').pop()}`);
}
const byId = new Map(enrichment.results.map(r => [r.id, r]));

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
  },
  mountains,
};
writeFileSync(join(ROOT, 'public', 'data', 'mountains.json'), JSON.stringify(payload));
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
  if (m.trails && m.trails.length) {
    const vmark = { verified: 'codex·agy 일치 ✓', mixed: '난이도 상이 ⚠', single: '단일 확인', unverified: '' };
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
