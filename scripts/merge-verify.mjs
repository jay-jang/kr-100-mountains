// Reconciles course data from 3 independent sources — web research (survey) plus two
// independent cross-checks — into a verified per-course list with difficulty + climbing
// times and an agreement flag. Writes data/enrichment.verified.json (consumed by build-data.mjs).
// Run: node scripts/merge-verify.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VDIR = join(ROOT, 'data', 'verify');

// ---- tolerant JSON extractor ----
function extractJSON(text) {
  if (!text) return null;
  const s = text.indexOf('{');
  if (s < 0) return null;
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
      if (m.id && Array.isArray(m.courses)) byId.set(m.id, m.courses.filter((c) => c && c.name));
    }
  }
  return byId;
}

// ---- course matching (들머리 기반: 코스는 트레일헤드로 식별) ----
const STOP = /코스|종주|구간|원점회귀|왕복|편도|등산로|탐방로|정상|방면/g;
const SUFFIX = /(탐방안내소|탐방지원센터|공원지킴터|안내소|지원센터|분소|대피소|주차장|버스정류장|정류장|삼거리|입구|휴게소|계곡)$/;
const norm = (t) => String(t || '').replace(STOP, '').replace(SUFFIX, '').trim();
const head = (str) => norm(String(str || '').split(/[\s\-·~(),\/]+/)[0]); // 들머리(첫 지명)
const isThru = (name) => /종주|횡단|화대|태극/.test(String(name || ''));
function tokset(name) {
  return new Set(String(name || '').replace(STOP, '').split(/[\s\-·~(),\/]+/).map(norm).filter((s) => s.length >= 2));
}
function jaccard(a, b) {
  const A = tokset(a), B = tokset(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
function startTokens(course) {
  const s = new Set();
  const nh = head(course.name); if (nh) s.add(nh);
  if (course.start) { s.add(head(course.start)); for (const t of tokset(course.start)) s.add(t); }
  s.delete('');
  return s;
}
function startMatch(a, b) {
  for (const t of a) if (b.has(t)) return true;
  for (const x of a) for (const y of b) if (x.length >= 2 && y.length >= 2 && (x.startsWith(y) || y.startsWith(x))) return true;
  return false;
}
function score(base, cand) {
  if (!startMatch(startTokens(base), startTokens(cand))) return 0; // 같은 들머리?
  if (isThru(base.name) !== isThru(cand.name)) return 0.25;         // 종주↔단일 불일치 → 거부
  return 0.55 + 0.45 * jaccard(base.name, cand.name);
}
function bestMatch(base, list, used) {
  let best = null, bs = 0.5; // 들머리 일치 + 종주 일관성 필요
  for (const c of list) { if (used.has(c)) continue; const s = score(base, c); if (s > bs) { bs = s; best = c; } }
  return best;
}

// ---- difficulty consensus ----
const DORD = { '쉬움': 1, '보통': 2, '어려움': 3, '매우 어려움': 4 };
const DNAME = ['', '쉬움', '보통', '어려움', '매우 어려움'];
function consensusDiff(vals) {
  const nums = vals.map((v) => DORD[v]).filter(Boolean);
  if (!nums.length) return null;
  const count = {};
  nums.forEach((n) => { count[n] = (count[n] || 0) + 1; });
  const maxc = Math.max(...Object.values(count));
  const modes = Object.keys(count).filter((k) => count[k] === maxc).map(Number);
  return DNAME[Math.max(...modes)]; // tie → 더 어려운 쪽(보수적)
}

// ---- korean duration text → hours (fallback when 교차검증 자료 미커버) ----
function parseDur(text) {
  if (!text) return {};
  const hm = (seg) => { const h = seg.match(/(\d+(?:\.\d+)?)\s*시간/); const min = seg.match(/(\d+)\s*분/);
    let v = h ? parseFloat(h[1]) : 0; if (min) v += parseInt(min[1]) / 60; return v || null; };
  const t = String(text);
  const out = {};
  if (/왕복|원점|round/i.test(t)) out.round_trip_hours = hm(t);
  if (/편도|정상까지|오름|up/i.test(t)) out.ascent_hours = hm(t);
  if (!out.round_trip_hours && !out.ascent_hours) out.round_trip_hours = hm(t); // 단일 표기
  return out;
}

const avg = (a, b) => {
  const xs = [a, b].filter((x) => typeof x === 'number' && x > 0);
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
};
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const rHalf = (x) => (x == null ? null : Math.round(x * 2) / 2);

function buildCourse(base, cx, ay) {
  const name = base?.name || cx?.name || ay?.name;
  const fromDur = parseDur(base?.duration);
  const ascent = rHalf(avg(cx?.ascent_hours, ay?.ascent_hours) ?? fromDur.ascent_hours);
  const round = rHalf(avg(cx?.round_trip_hours, ay?.round_trip_hours) ?? fromDur.round_trip_hours);
  const diffs = [base?.difficulty, cx?.difficulty, ay?.difficulty].filter(Boolean);
  const sources = [base && 'survey', cx && 'crosscheck1', ay && 'crosscheck2'].filter(Boolean);
  let level = 'unverified';
  if (cx && ay) level = cx.difficulty === ay.difficulty ? 'verified' : 'mixed';
  else if (cx || ay) level = 'single';
  return {
    name,
    start: base?.start || null,
    note: base?.note || null,
    distance_km: r1(base?.distance_km ?? avg(cx?.distance_km, ay?.distance_km)),
    ascent_hours: ascent,
    round_trip_hours: round,
    duration: base?.duration || (round ? `왕복 약 ${round}시간` : ascent ? `편도 약 ${ascent}시간` : null),
    difficulty: consensusDiff(diffs) || base?.difficulty || cx?.difficulty || ay?.difficulty || null,
    verify: {
      sources,
      difficulty_agree: cx && ay ? cx.difficulty === ay.difficulty : null,
      level, // verified(교차검증 일치) / mixed(상이) / single(한쪽만) / unverified
      difficulties: { survey: base?.difficulty || null, crosscheck1: cx?.difficulty || null, crosscheck2: ay?.difficulty || null },
    },
  };
}

function reconcile(trails, codexC, agyC) {
  const usedCx = new Set(), usedAy = new Set();
  const out = (trails || []).map((t) => {
    const cx = bestMatch(t, codexC, usedCx); if (cx) usedCx.add(cx);
    const ay = bestMatch(t, agyC, usedAy); if (ay) usedAy.add(ay);
    return buildCourse(t, cx, ay);
  });
  for (const cx of codexC) {
    if (usedCx.has(cx)) continue; usedCx.add(cx);
    const ay = bestMatch(cx, agyC, usedAy); if (ay) usedAy.add(ay);
    out.push(buildCourse(null, cx, ay));
  }
  for (const ay of agyC) { if (usedAy.has(ay)) continue; usedAy.add(ay); out.push(buildCourse(null, null, ay)); }
  return out;
}

// ---- main ----
const enrichment = JSON.parse(readFileSync(join(ROOT, 'data', 'enrichment.json'), 'utf8'));
const codex = loadSource('codex_');
const agy = loadSource('agy_');
console.log(`sources: crosscheck1 ${codex.size} mtns · crosscheck2 ${agy.size} mtns · survey ${enrichment.results.length}`);

let stat = { verified: 0, mixed: 0, single: 0, unverified: 0, courses: 0, mtns_both: 0 };
for (const m of enrichment.results) {
  const cx = codex.get(m.id) || [];
  const ay = agy.get(m.id) || [];
  if (cx.length && ay.length) stat.mtns_both++;
  const courses = reconcile(m.trails || [], cx, ay);
  m.trails = courses; // replace with verified courses
  for (const c of courses) { stat.courses++; stat[c.verify.level]++; }
}

writeFileSync(join(ROOT, 'data', 'enrichment.verified.json'), JSON.stringify(enrichment, null, 2) + '\n');
console.log('enrichment.verified.json written');
console.log(`mountains cross-checked by BOTH independent sources: ${stat.mtns_both}/${enrichment.results.length}`);
console.log(`courses: ${stat.courses} | verified(교차검증 일치) ${stat.verified} · mixed(상이) ${stat.mixed} · single ${stat.single} · unverified ${stat.unverified}`);
