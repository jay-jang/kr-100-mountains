// Cross-verifies each mountain's courses (난이도 + 등반시간) via two independent
// command-line research tools. Batched, concurrent, resumable. Writes raw JSON per batch
// to data/verify/ (one file per tool per batch, reconciled by merge-verify.mjs).
// Run: node scripts/verify-trails.mjs   (env: CONC=4 BATCH=5 TIMEOUT=360)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VDIR = join(ROOT, 'data', 'verify');
mkdirSync(VDIR, { recursive: true });

const BATCH = Number(process.env.BATCH || 5);
const CONC = Number(process.env.CONC || 4);
const TIMEOUT = Number(process.env.TIMEOUT || 360) * 1000;

// TAG: batch filename suffix tag so a focused re-run (e.g. new mountains) doesn't clobber
//      the original codex_<i>/agy_<i> files. merge-verify matches any codex_*/agy_* by id.
// ONLY: path to a JSON array of ids — restrict verification to just those mountains.
const TAG = process.env.TAG || '';
const ONLY = process.env.ONLY ? new Set(JSON.parse(readFileSync(process.env.ONLY, 'utf8'))) : null;

const mountains = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'mountains.json'), 'utf8')).mountains;
const items = mountains
  .filter((m) => !ONLY || ONLY.has(m.id))
  .map((m) => ({
    id: m.id, name: m.name_full, elev: m.elevation_m, loc: m.location,
    cur_courses: (m.trails || []).map((t) => t.name),
  }));
const batches = [];
for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));

const PROMPT = (batch) => `다음 대한민국 산들의 대표 등산 코스별 '난이도'와 '등반 시간'을 웹 조사로 확인해 JSON으로만 출력하라.

각 코스 필드:
- name: 코스명(들머리-정상 형태 권장)
- distance_km: 편도 거리(km, 숫자)
- ascent_hours: 정상까지 편도 오름 소요시간(시간 단위 소수, 예 4.5)
- round_trip_hours: 왕복(또는 대표 원점회귀) 총 소요시간(시간 단위 소수)
- difficulty: "쉬움" | "보통" | "어려움" | "매우 어려움" 중 하나

규칙:
- 산마다 대표 코스 2~4개. 주어진 cur_courses를 참고하되 실제와 다르면 정정/보완.
- 성인 일반 등산객 기준. 장거리 종주(예: 지리산 화대종주)는 "매우 어려움".
- 입력의 모든 id를 포함하라.
- 반드시 아래 JSON 하나만 출력(설명·마크다운·코드펜스 금지):
{"mountains":[{"id":"<id>","courses":[{"name":"","distance_km":0,"ascent_hours":0,"round_trip_hours":0,"difficulty":""}]}]}

대상 산 목록:
${JSON.stringify(batch)}`;

// balanced-brace JSON extractor (tolerates surrounding text / code fences)
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
function validFile(file, ids) {
  if (!existsSync(file)) return false;
  const j = extractJSON(readFileSync(file, 'utf8'));
  if (!j || !Array.isArray(j.mountains)) return false;
  const got = new Set(j.mountains.map((m) => m.id));
  return ids.every((id) => got.has(id)); // require full coverage
}

function runProc(cmd, args, { timeoutMs, captureStdout, outFile }) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
    let out = '';
    const to = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { if (captureStdout) out += d; });
    p.stderr.on('data', () => {});
    p.on('close', () => { clearTimeout(to); if (captureStdout && outFile) writeFileSync(outFile, out); resolve(); });
    p.on('error', () => { clearTimeout(to); resolve(); });
  });
}

async function runCodex(prompt, outFile) {
  await runProc('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-o', outFile, prompt],
    { timeoutMs: TIMEOUT, captureStdout: false });
}
async function runAgy(prompt, outFile) {
  await runProc('agy', ['-p', prompt, '--dangerously-skip-permissions'],
    { timeoutMs: TIMEOUT, captureStdout: true, outFile });
}

async function doSource(kind, prompt, outFile, ids) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (validFile(outFile, ids)) return true;
    if (kind === 'codex') await runCodex(prompt, outFile); else await runAgy(prompt, outFile);
    if (validFile(outFile, ids)) return true;
  }
  return validFile(outFile, ids);
}

let done = 0;
async function doBatch(i) {
  const batch = batches[i];
  const ids = batch.map((b) => b.id);
  const prompt = PROMPT(batch);
  const [cx, ay] = await Promise.all([
    doSource('codex', prompt, join(VDIR, `codex_${TAG}${i}.json`), ids),
    doSource('agy', prompt, join(VDIR, `agy_${TAG}${i}.json`), ids),
  ]);
  done++;
  console.log(`[batch ${i + 1}/${batches.length}] ${ids.join(',')} → src1:${cx ? 'ok' : 'MISS'} src2:${ay ? 'ok' : 'MISS'}  (${done}/${batches.length} done)`);
}

let next = 0;
async function worker() {
  while (next < batches.length) { const i = next++; await doBatch(i); }
}
console.log(`verify-trails: ${items.length} mountains, ${batches.length} batches (size ${BATCH}), concurrency ${CONC}`);
await Promise.all(Array.from({ length: CONC }, worker));
console.log('ALL DONE');
