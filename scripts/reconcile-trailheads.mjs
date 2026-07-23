// data/verify-th/{codex,agy}_*.json 의 코스별 들머리 좌표를 병합·교차검증해
// enrichment.verified.json 각 코스에 trailhead([lat,lon]) + trailhead_conf 를 추가한다.
// Run: node scripts/reconcile-trailheads.mjs   (그 뒤 npm run build:data)
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VDIR = join(ROOT, 'data', 'verify-th');

function extractJSON(text) {
  if (!text) return null;
  const s = text.indexOf('{'); if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(text.slice(s, i + 1)); } catch { return null; } } }
  }
  return null;
}
function loadSource(prefix) {
  const byId = new Map();
  if (!existsSync(VDIR)) return byId;
  for (const f of readdirSync(VDIR).filter((x) => x.startsWith(prefix) && x.endsWith('.json'))) {
    const j = extractJSON(readFileSync(join(VDIR, f), 'utf8'));
    for (const m of j?.mountains || []) {
      if (!m.id) continue;
      const cmap = byId.get(m.id) || new Map();
      for (const c of m.courses || []) if (c.name && Array.isArray(c.trailhead) && c.trailhead.length === 2) cmap.set(c.name, c.trailhead.map(Number));
      byId.set(m.id, cmap);
    }
  }
  return byId;
}
const hav = (a, b) => { const R = 6371000, r = (d) => d * Math.PI / 180; const dLa = r(b[0] - a[0]), dLo = r(b[1] - a[1]); const x = Math.sin(dLa / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const inKorea = (p) => p && p[0] >= 33 && p[0] <= 39 && p[1] >= 124 && p[1] <= 132;
const norm = (s) => String(s || '').replace(/코스|종주|구간|원점회귀|왕복|편도|\s/g, '');
function pick(cmap, name) {
  if (!cmap) return null;
  if (cmap.has(name)) return cmap.get(name);
  const n = norm(name);
  for (const [k, v] of cmap) { const kk = norm(k); if (kk === n || kk.startsWith(n) || n.startsWith(kk)) return v; }
  return null;
}
function valid(th, summit) { return inKorea(th) && (() => { const d = hav(summit, th); return d > 200 && d < 26000; })(); }
function trailhead(cx, ay, summit) {
  const cv = valid(cx, summit), av = valid(ay, summit);
  if (cv && av) {
    const gap = hav(cx, ay);
    if (gap < 1500) return { th: [(cx[0] + ay[0]) / 2, (cx[1] + ay[1]) / 2], conf: 'high' }; // averaged
    // 불일치: 들머리다운(1~13km) 쪽 우선, 둘 다면 평균
    const pl = (p) => { const d = hav(summit, p); return d >= 800 && d <= 14000; };
    if (pl(cx) && !pl(ay)) return { th: cx, conf: 'mixed' };
    if (pl(ay) && !pl(cx)) return { th: ay, conf: 'mixed' };
    return { th: [(cx[0] + ay[0]) / 2, (cx[1] + ay[1]) / 2], conf: 'mixed' };
  }
  if (cv) return { th: cx, conf: 'single' };
  if (av) return { th: ay, conf: 'single' };
  return null;
}

const codex = loadSource('codex_');
const agy = loadSource('agy_');
const enr = JSON.parse(readFileSync(join(ROOT, 'data', 'enrichment.verified.json'), 'utf8'));
let n = 0, hi = 0, mid = 0, sg = 0;
for (const m of enr.results) {
  if (m.lat == null) continue;
  const summit = [m.lat, m.lon];
  const cmx = codex.get(m.id), amy = agy.get(m.id);
  for (const t of m.trails || []) {
    const r = trailhead(pick(cmx, t.name), pick(amy, t.name), summit);
    if (r) {
      t.trailhead = [Math.round(r.th[0] * 1e5) / 1e5, Math.round(r.th[1] * 1e5) / 1e5];
      t.trailhead_conf = r.conf; n++;
      if (r.conf === 'high') hi++; else if (r.conf === 'mixed') mid++; else sg++;
    } else { delete t.trailhead; delete t.trailhead_conf; }
  }
}
writeFileSync(join(ROOT, 'data', 'enrichment.verified.json'), JSON.stringify(enr, null, 1) + '\n');
console.log(`trailheads: codex ${codex.size} mtns · agy ${agy.size} mtns`);
console.log(`코스 들머리 기록: ${n}개 (일치 ${hi} · 이견 ${mid} · 단일 ${sg})`);
