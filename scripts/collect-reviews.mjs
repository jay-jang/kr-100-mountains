#!/usr/bin/env node
// 산·코스별 탐방 후기/현장 정보 수집기 — 모으고, 다시 검증한다.
//
// 어떻게 하는가
//   1) 수집 — 서로 독립적인 두 조사가 같은 질문에 각자 답한다(난이도 체감·혼잡·주차·
//      위험구간·시기·통제 등). 출처 URL이 없는 항목은 그 자리에서 버린다.
//   2) 검증 — 1)에서 모인 주장 목록을 **두 조사 모두에게 다시 돌려** 웹 근거로
//      confirmed / refuted / unclear 를 판정받는다. 누가 쓴 주장인지는 알려주지 않는다.
//   3) 판정 — 반박(refuted)이 하나라도 있으면 버린다. 확인 2표는 verified,
//      1표는 single, 0표는 버린다.
//
//   문장 유사도로 "두 조사가 같은 말을 했는지" 세는 방식은 쓰지 않는다. 실측해 보니
//   같은 사실을 다르게 쓴 쌍이 0.11~0.22, 다른 사실인 쌍이 0.08로 구분이 되지 않았다.
//   유사도는 명백한 중복을 지우는 데만 쓴다.
//
// 무엇이 아닌가  ★ 중요
//   원문 후기를 그대로 옮긴 것이 아니다. 공개된 산행기·공지에서 확인되는 사실을 한 줄로
//   정리한 요약이며, 항목마다 원문 URL을 달아 독자가 직접 확인할 수 있게 한다.
//
// 사용법
//   node scripts/collect-reviews.mjs                  # 오래 안 본 순으로 기본 8개 산
//   node scripts/collect-reviews.mjs --limit=20 --batch=4
//   node scripts/collect-reviews.mjs --only=bukhansan,jirisan
//   node scripts/collect-reviews.mjs --all            # 149개 전부(오래 걸림)
//   node scripts/collect-reviews.mjs --stale-days=30  # 이 기간 안에 모은 산은 건너뜀
//   node scripts/collect-reviews.mjs --no-verify      # 검증 라운드 생략(빠른 확인용)
//   node scripts/collect-reviews.mjs --publish-only   # 모아 둔 원본으로 결과만 다시 생성
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESEARCHERS, runResearcher, extractJSON, similarity, numericConflict, normalizeUrl } from './lib/research.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = join(ROOT, 'data', 'reviews-raw');          // gitignore 대상
const VERIFIED = join(ROOT, 'data', 'reviews.verified.json');
const PUB_DIR = join(ROOT, 'public', 'data', 'reviews');

const TOPICS = ['난이도', '혼잡', '주차·교통', '위험구간', '계절·시기', '조망·볼거리', '편의시설', '통제·예약'];
const SENTIMENTS = ['good', 'neutral', 'caution'];
const MAX_NOTES_PER_MOUNTAIN = 14;
const DUP_MIN = 0.8;        // 이 이상이어야 사실상 같은 문장으로 보고 합친다.
                            // 낮게 두면 수치만 다른 상반된 주장이 합쳐진다("50대" vs "500대").

// ── CLI ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  if (argv[i].includes('=')) return argv[i].slice(n.length + 3);
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : d;
};
const ONLY = (opt('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(opt('limit', '8')) || 8;
const BATCH = Math.max(1, Number(opt('batch', '4')) || 4);
const STALE_DAYS = Number(opt('stale-days', '21')) || 21;
const ALL = flag('all');
const NO_VERIFY = flag('no-verify');
const PUBLISH_ONLY = flag('publish-only');
const DRY = flag('dry-run');

const log = (...a) => console.log(...a);
const nowISO = () => new Date().toISOString();
const TODAY = nowISO().slice(0, 10);

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// ── 입력 ─────────────────────────────────────────────────────────────
const mountains = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'mountains.json'), 'utf8')).mountains;
const byId = new Map(mountains.map((m) => [m.id, m]));

// ── 대상 선정 ─────────────────────────────────────────────────────────
// 매일 조금씩 갱신하는 게 목적이므로 "가장 오래 안 본 산"부터 고른다.
function pickTargets() {
  const last = new Map();
  if (existsSync(RAW_DIR)) {
    for (const day of readdirSync(RAW_DIR).sort()) {
      for (const f of safeReaddir(join(RAW_DIR, day))) {
        const j = safeJSON(join(RAW_DIR, day, f));
        for (const id of j?.mountain_ids || []) last.set(id, day);
      }
    }
  }
  let pool = mountains.filter((m) => (m.trails || []).length || m.summary);
  if (ONLY.length) return pool.filter((m) => ONLY.includes(m.id));
  if (!ALL) {
    const cutoff = Date.now() - STALE_DAYS * 86400000;
    pool = pool.filter((m) => { const t = last.get(m.id); return !t || new Date(t).getTime() < cutoff; });
  }
  pool.sort((a, b) => {
    const ta = last.get(a.id) || '', tb = last.get(b.id) || '';
    return ta !== tb ? (ta < tb ? -1 : 1) : a.id.localeCompare(b.id);
  });
  return ALL ? pool : pool.slice(0, LIMIT);
}

// 정렬은 필수 — 파일시스템 열거 순서는 보장되지 않는다. 같은 날 batch-00/batch-01 중
// 어느 쪽이 최종 결과가 될지가 실행마다 달라지면 안 된다.
const safeReaddir = (d) => { try { return readdirSync(d).filter((f) => f.endsWith('.json')).sort(); } catch { return []; } };
const safeJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// ── 프롬프트 ─────────────────────────────────────────────────────────
function collectPrompt(batch) {
  const list = batch.map((m) => {
    const courses = (m.trails || []).map((t) => t.name).filter(Boolean).slice(0, 6);
    return `- id: ${m.id}\n  산: ${m.name_full || m.name} (${m.location || m.province || ''}, ${m.elevation_m ?? '?'}m)\n`
      + `  등록된 코스: ${courses.length ? courses.join(' · ') : '(없음)'}`;
  }).join('\n');

  return `등산 코스 탐방 후기·현장 정보 조사 요청입니다.

아래 산들에 대해, **공개된 웹 문서(산행기·블로그 후기·국립공원/지자체 공지·뉴스)에서 실제로 확인되는 현장 정보**를 모아 주세요.

## 대상
${list}

## 모을 것 (topic 값으로 그대로 사용)
- 난이도 — 자료상 난이도와 체감이 다른 점, 실제로 힘든 구간
- 혼잡 — 요일·시간대·성수기 붐빔, 정상 인증 대기 등
- 주차·교통 — 주차장 규모/만차 시각, 대중교통 배차, 접근 난이도
- 위험구간 — 암릉·로프·계단·낙석·결빙 등 조심할 지점
- 계절·시기 — 단풍/설경/개화 시기, 계절 통제 기간
- 조망·볼거리 — 실제로 좋다고 반복 언급되는 지점
- 편의시설 — 화장실·식수·매점·대피소
- 통제·예약 — 탐방예약제, 입산통제, 출입 제한

## 규칙 (매우 중요)
1. **실제로 열어 본 웹 문서에서 확인한 것만** 쓴다. 기억·추측으로 쓰지 않는다.
2. 항목마다 **실제 URL을 1개 이상 반드시** 넣는다. URL을 댈 수 없으면 그 항목은 빼라.
3. 한 항목 = 한 가지 사실. 한국어 1~2문장, 구체적인 수치·지명을 살려서.
4. 정보 시점을 알 수 있으면 as_of에 "YYYY-MM"으로 적는다. 모르면 null.
5. 특정 코스 내용이면 scope="route"와 route에 위 "등록된 코스" 중 하나를 **그대로** 적고,
   산 전체에 해당하면 scope="mountain", route=null.
6. 광고·홍보 문구, 개인 신상, 업체 홍보는 넣지 않는다.
7. **확실하지 않으면 그 항목을 아예 빼라.** 빈 배열이 지어낸 항목보다 낫다.
8. 산 하나당 3~10개 항목이면 충분하다.
9. sentiment는 **안전·통제·제약처럼 실제로 조심해야 할 내용에만** "caution"을 쓴다.
   주차 대수·화장실 위치·배차 간격 같은 단순 정보는 "neutral", 좋다고 반복 언급되는 것은 "good".

## 출력
다른 설명 없이 아래 JSON 객체 **하나만** 출력하라.

{
  "mountains": [
    {
      "id": "<입력으로 준 id 그대로>",
      "notes": [
        {
          "scope": "mountain" | "route",
          "route": null 또는 "코스명",
          "topic": "${TOPICS.join('" | "')}",
          "text": "한국어 1~2문장",
          "sentiment": "good" | "neutral" | "caution",
          "as_of": "YYYY-MM" 또는 null,
          "sources": ["https://..."]
        }
      ]
    }
  ]
}`;
}

function verifyPrompt(claims) {
  const list = claims.map((c, i) =>
    `${i + 1}. [${c.mountain_name} / ${c.route || '산 전체'} / ${c.topic}] ${c.text}`).join('\n');

  return `등산 현장 정보 검증 요청입니다.

아래 주장들이 **공개된 웹 문서에서 실제로 확인되는지** 하나씩 검증해 주세요.
누가 쓴 주장인지는 중요하지 않습니다. 웹 근거만 보고 판단하세요.

## 주장 목록
${list}

## 판정 규칙
- **confirmed** — 웹에서 근거를 찾았고 주장과 부합한다. 근거 URL 필수.
- **refuted** — 웹 근거가 주장과 명백히 어긋난다(수치가 다르거나 사실이 아님). 근거 URL 필수.
- **unclear** — 근거를 못 찾았거나 판단할 수 없다.

지켜야 할 것:
1. **근거를 못 찾았으면 confirmed로 쓰지 마라. 모르면 unclear다.** 이게 가장 중요하다.
2. 주장에 든 구체적 수치(거리·정원·시각·요금·배차)는 반드시 대조하라. 수치가 다르면 refuted다.
3. 폐지·변경된 제도(예: 지난 시즌에만 있던 예약제)를 현재 사실처럼 쓴 주장은 refuted다.
4. confirmed / refuted 에는 반드시 근거 URL을 넣어라. 없으면 unclear로 낮춰라.

## 출력
다른 설명 없이 아래 JSON 객체 **하나만** 출력하라. 모든 번호에 대해 답하라.

{ "verdicts": [ { "n": 1, "verdict": "confirmed" | "refuted" | "unclear", "url": "https://..." 또는 null, "note": "다르면 무엇이 다른지 한 줄" 또는 null } ] }`;
}

// ── 정규화 ───────────────────────────────────────────────────────────
function cleanNote(n, m) {
  if (!n || typeof n.text !== 'string') return null;
  const text = n.text.trim().replace(/\s+/g, ' ');
  if (text.length < 8 || text.length > 400) return null;
  if (text.includes('�')) return null;      // 인코딩이 깨진 문장은 고칠 수 없으니 버린다

  const sources = [...new Set((Array.isArray(n.sources) ? n.sources : []).map(normalizeUrl).filter(Boolean))].slice(0, 4);
  if (!sources.length) return null;                       // 출처 없는 항목은 버린다
  if (!TOPICS.includes(n.topic)) return null;

  // route는 등록된 코스명과 맞을 때만 인정한다(없는 코스명을 만들어 붙이지 못하게).
  let route = null, scope = 'mountain';
  if (n.scope === 'route' && typeof n.route === 'string' && n.route.trim()) {
    const want = n.route.trim();
    const names = (m.trails || []).map((t) => t.name).filter(Boolean);
    const exact = names.find((name) => name === want);
    if (exact) { route = exact; scope = 'route'; }
    else {
      // 유사도로 붙일 때는 1등이 유일하고 2등과 충분히 벌어졌을 때만.
      // 그냥 "0.6 넘는 첫 항목"으로 하면 "백련사 코스"와 "청련사 코스"(유사도 정확히 0.600)
      // 처럼 실제로 다른 코스에 잘못 붙는다.
      const scored = names.map((name) => ({ name, s: similarity(name, want) })).sort((a, b) => b.s - a.s);
      if (scored.length && scored[0].s >= 0.75 && (scored.length === 1 || scored[0].s - scored[1].s >= 0.15)) {
        route = scored[0].name; scope = 'route';
      }
      // 어느 코스인지 확신할 수 없으면 산 전체(scope=mountain)로 둔다 — 엉뚱한 코스에 붙는 것보다 낫다.
    }
  }

  return {
    scope, route, topic: n.topic, text,
    sentiment: SENTIMENTS.includes(n.sentiment) ? n.sentiment : 'neutral',
    as_of: typeof n.as_of === 'string' && /^\d{4}-\d{2}$/.test(n.as_of) ? n.as_of : null,
    sources,
  };
}

// 같은 문장을 두 번 싣지 않는다(임계값을 높게 둬 서로 다른 사실이 합쳐지지 않게).
function mergeInto(list, n, fromKey) {
  const dup = list.find((o) => o.topic === n.topic && o.route === n.route
    && similarity(o.text, n.text) >= DUP_MIN && !numericConflict(o.text, n.text));
  if (dup) {
    dup.sources = [...new Set([...dup.sources, ...n.sources])].slice(0, 6);
    if (n.text.length > dup.text.length) dup.text = n.text;
    if (!dup.as_of && n.as_of) dup.as_of = n.as_of;
    if (dup.sentiment === 'neutral' && n.sentiment !== 'neutral') dup.sentiment = n.sentiment;
    if (!dup.from.includes(fromKey)) dup.from.push(fromKey);
    return dup;
  }
  const fresh = { ...n, from: [fromKey] };
  list.push(fresh);
  return fresh;
}

// ── 배치 실행 ─────────────────────────────────────────────────────────
async function runBatch(batch, bi, dayDir) {
  const prompt = collectPrompt(batch);
  log(`[배치 ${bi + 1}] ${batch.map((m) => m.name).join(', ')}`);

  // 두 조사는 서로의 답을 보지 않아야 독립적이므로 동시에 돌린다.
  const collected = await Promise.all(RESEARCHERS.map(async (r) => {
    const outFile = join(dayDir, `.${r.key}-c${bi}.out`);
    const t0 = Date.now();
    const res = await runResearcher(r, prompt, outFile, { log });
    let text = res.stdout;
    if (r.readsOutFile && existsSync(outFile)) { try { text = readFileSync(outFile, 'utf8'); } catch { /* stdout 사용 */ } }
    const json = extractJSON(text);
    const n = (json?.mountains || []).reduce((s, e) => s + (e.notes?.length || 0), 0);
    log(`    수집 ${r.key}: ${json ? `산 ${json.mountains?.length || 0} · 항목 ${n}` : 'JSON 없음'} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    return { key: r.key, json };
  }));

  // 후보 주장 목록 만들기 (번호는 검증 라운드의 키가 된다)
  const perMountain = new Map(batch.map((m) => [m.id, []]));
  for (const { key, json } of collected) {
    for (const entry of json?.mountains || []) {
      const m = byId.get(entry?.id);
      if (!m || !perMountain.has(m.id) || !Array.isArray(entry.notes)) continue;
      for (const raw of entry.notes) {
        const n = cleanNote(raw, m);
        if (n) mergeInto(perMountain.get(m.id), n, key);
      }
    }
  }
  const claims = [];
  for (const m of batch) {
    for (const n of perMountain.get(m.id) || []) claims.push({ ...n, id: m.id, mountain_name: m.name_full || m.name });
  }
  log(`    후보 주장 ${claims.length}건`);

  const record = {
    day: TODAY, batch: bi, mountain_ids: batch.map((m) => m.id),
    collected_by: collected.filter((c) => c.json).map((c) => c.key),
    claims, verdicts: {},
  };

  // ── 검증 라운드 ──
  if (!NO_VERIFY && claims.length) {
    const vprompt = verifyPrompt(claims);
    const verdicts = await Promise.all(RESEARCHERS.map(async (r) => {
      const outFile = join(dayDir, `.${r.key}-v${bi}.out`);
      const t0 = Date.now();
      const res = await runResearcher(r, vprompt, outFile, { log });
      let text = res.stdout;
      if (r.readsOutFile && existsSync(outFile)) { try { text = readFileSync(outFile, 'utf8'); } catch { /* stdout */ } }
      const json = extractJSON(text);
      const arr = Array.isArray(json?.verdicts) ? json.verdicts : [];
      const c = arr.filter((v) => v.verdict === 'confirmed').length;
      const x = arr.filter((v) => v.verdict === 'refuted').length;
      log(`    검증 ${r.key}: 판정 ${arr.length}건 (확인 ${c} · 반박 ${x}) (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      return { key: r.key, arr };
    }));
    for (const { key, arr } of verdicts) record.verdicts[key] = arr;
  }

  writeAtomic(join(dayDir, `batch-${String(bi).padStart(2, '0')}.json`), JSON.stringify(record, null, 2) + '\n');
  return record;
}

// ── 판정 + 결과 쓰기 ──────────────────────────────────────────────────
function judge(record) {
  const claims = Array.isArray(record.claims) ? record.claims : [];
  const total = claims.length;

  // 조사별 판정을 번호 → 판정 **배열**로 모은다.
  //  · n 이 "1" 같은 문자열로 와도 받는다(그냥 버리면 그 조사의 판정이 통째로 증발한다).
  //  · 범위를 벗어난 번호는 버린다.
  //  · 같은 번호에 여러 판정을 줘도 잃지 않는다(Map에 마지막 것만 남기면 반박이 사라진다).
  //  · 아무 판정도 못 낸 조사는 검증자로 세지 않는다 — 그러면 남은 한 명이 확인해도
  //    영원히 2표가 안 나와 모든 항목이 single로 깎인다.
  const byN = {};
  for (const [key, arr] of Object.entries(record.verdicts || {})) {
    if (!Array.isArray(arr) || !arr.length) continue;
    const m = new Map();
    for (const v of arr) {
      const n = Number(v?.n);
      if (!Number.isInteger(n) || n < 1 || n > total) continue;
      if (!m.has(n)) m.set(n, []);
      m.get(n).push(v);
    }
    if (m.size) byN[key] = m;
  }
  const verifiers = Object.keys(byN);

  const out = new Map();
  claims.forEach((c, i) => {
    const n = i + 1;
    let confirms = 0, refutedBy = 0;
    const evidence = [];
    for (const k of verifiers) {
      const vs = byN[k].get(n) || [];
      // 반박은 URL이 없어도 받아들인다 — 잘못된 정보를 싣는 쪽이 안 싣는 쪽보다 나쁘다.
      // 반대로 확인(confirmed)은 근거 URL이 있어야 인정한다. 실패는 안전한 쪽으로 기울인다.
      if (vs.some((v) => v.verdict === 'refuted')) { refutedBy++; continue; }
      const con = vs.map((v) => (v.verdict === 'confirmed' ? normalizeUrl(v.url) : null)).find(Boolean);
      if (con) { confirms++; evidence.push(con); }
    }
    if (refutedBy) return;                                // 반박 1표라도 있으면 싣지 않는다

    // 검증을 못 돌린 경우(--no-verify, 검증 라운드 실패)는 'unverified'다.
    // 두 조사가 비슷한 문장을 썼다는 것만으로 verified를 주면 안 된다 — 그 유사도는
    // 같은 사실인지 가릴 만큼 신뢰할 수 없다는 걸 실측으로 확인했다.
    const level = verifiers.length === 0
      ? 'unverified'
      : confirms >= 2 ? 'verified' : confirms === 1 ? 'single' : null;
    if (!level) return;                                   // 검증은 돌았는데 아무도 확인 못 함 → 버린다

    const list = out.get(c.id) || [];
    list.push({
      scope: c.scope, route: c.route, topic: c.topic, text: c.text,
      sentiment: c.sentiment, as_of: c.as_of,
      // 검증에서 나온 근거 URL을 앞에 둔다 — 뒤에 붙이면 상한(6개)에서 잘려
      // 배지는 "교차검증"인데 근거 링크는 안 보이는 상태가 된다.
      sources: [...new Set([...evidence, ...c.sources])].slice(0, 6),
      verify: { level, confirmed: confirms, checked_by: verifiers.length, found_by: (c.from || []).length },
    });
    out.set(c.id, list);
  });
  return { notes: out, verifiers: verifiers.length };
}

function publish() {
  // 날짜 폴더를 오래된 → 최신 순으로 읽어 같은 산은 최신 것이 이긴다.
  const perMountain = new Map();
  if (existsSync(RAW_DIR)) {
    for (const day of readdirSync(RAW_DIR).sort()) {
      for (const f of safeReaddir(join(RAW_DIR, day))) {
        const rec = safeJSON(join(RAW_DIR, day, f));
        if (!rec?.claims) continue;
        const judged = judge(rec);
        for (const id of rec.mountain_ids || []) {
          if (!byId.has(id)) continue;
          const notes = judged.notes.get(id) || [];
          // 오늘 수집이 빈손이었다고 해서 지난번에 잘 모은 것을 지우지는 않는다
          // (조사 실패·JSON 파싱 실패 한 번에 그 산의 자료가 사라지면 안 된다).
          if (!notes.length && perMountain.has(id)) continue;
          perMountain.set(id, { day, notes, checked: judged.verifiers });
        }
      }
    }
  }

  const entries = [];
  for (const m of mountains) {
    const got = perMountain.get(m.id);
    if (!got || !got.notes.length) continue;
    const rank = (n) => (n.verify.level === 'verified' ? 0 : 1) * 10 + (n.sentiment === 'caution' ? 0 : 1);
    const notes = got.notes.slice().sort((a, b) => rank(a) - rank(b) || b.sources.length - a.sources.length)
      .slice(0, MAX_NOTES_PER_MOUNTAIN);
    entries.push({
      id: m.id, name: m.name_full || m.name, collected_at: got.day,
      checked_by: got.checked,
      verified: notes.filter((n) => n.verify.level === 'verified').length,
      notes,
    });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));

  const head = {
    schema_version: 1,
    generated_at: nowISO(),
    generator: 'scripts/collect-reviews.mjs',
    what_this_is: '공개된 산행기·후기·공지에서 확인된 현장 정보를 항목별로 정리한 요약입니다. '
      + '원문 후기를 그대로 옮긴 것이 아니며, 항목마다 출처 URL을 달아 두었습니다.',
    method: '서로 독립적인 두 조사가 같은 질문에 각자 답한 뒤, 모인 주장 목록을 두 조사 모두에게 '
      + '다시 돌려 웹 근거로 확인·반박·판단불가를 판정합니다. 반박이 하나라도 나온 항목은 싣지 않고, '
      + '확인 2표는 교차검증(verified), 1표는 단일확인(single)으로 표시합니다. '
      + '출처 URL이 없는 항목은 애초에 저장하지 않습니다.',
    topics: TOPICS,
    stats: {
      mountains: entries.length,
      notes: entries.reduce((s, e) => s + e.notes.length, 0),
      verified: entries.reduce((s, e) => s + e.verified, 0),
    },
  };

  writeAtomic(VERIFIED, JSON.stringify({ ...head, mountains: entries }, null, 2) + '\n');
  mkdirSync(PUB_DIR, { recursive: true });
  writeAtomic(join(PUB_DIR, 'index.json'), JSON.stringify({
    ...head,
    mountains: entries.map((e) => ({ id: e.id, name: e.name, collected_at: e.collected_at, notes: e.notes.length, verified: e.verified })),
  }));
  for (const e of entries) writeAtomic(join(PUB_DIR, `${e.id}.json`), JSON.stringify(e));
  // 더 이상 목록에 없는 산의 파일은 지운다 — 안 그러면 매니페스트엔 없는데 파일만 남아
  // 서로 어긋난 산출물이 배포된다.
  const keep = new Set(['index.json', ...entries.map((e) => `${e.id}.json`)]);
  for (const f of safeReaddir(PUB_DIR)) {
    if (!keep.has(f)) { rmSync(join(PUB_DIR, f), { force: true }); log(`  오래된 파일 정리: ${f}`); }
  }

  log(`\n후기 자료: 산 ${head.stats.mountains}개 · 항목 ${head.stats.notes}건`
    + ` (교차검증 ${head.stats.verified} / 단일확인 ${head.stats.notes - head.stats.verified})`);
  return head.stats;
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  if (PUBLISH_ONLY) { publish(); return; }

  const targets = pickTargets();
  if (!targets.length) {
    log(`갱신할 산이 없습니다 (최근 ${STALE_DAYS}일 안에 모두 수집됨). --limit / --stale-days / --all 로 조정하세요.`);
    publish();
    return;
  }
  log(`대상 ${targets.length}개 산 · 배치 ${BATCH}개씩 · 조사 ${RESEARCHERS.length}건\n`
    + targets.map((m) => m.id).join(' ') + '\n');
  if (DRY) return;

  const dayDir = join(RAW_DIR, TODAY);
  mkdirSync(dayDir, { recursive: true });
  // 오늘 이미 돌린 배치가 있으면 이어서 번호를 매긴다(하루에 두 번 돌려도 덮어쓰지 않게).
  let bi = safeReaddir(dayDir).filter((f) => f.startsWith('batch-')).length;

  let okBatches = 0, failBatches = 0;
  for (let i = 0; i < targets.length; i += BATCH, bi++) {
    try {
      const rec = await runBatch(targets.slice(i, i + BATCH), bi, dayDir);
      if (rec.collected_by.length) okBatches++; else failBatches++;
    } catch (e) { failBatches++; log(`  ✗ 배치 실패: ${e.message}`); }
  }
  publish();
  // 전부 실패했는데 0으로 끝나면 자동화가 "성공"으로 기록하고 넘어간다.
  if (okBatches === 0 && failBatches > 0) {
    log(`\n모든 배치(${failBatches}개)에서 조사 결과를 얻지 못했습니다.`);
    process.exitCode = 2;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
