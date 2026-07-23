// 코스별 들머리(트레일헤드) 좌표를 codex AND agy로 확인·교차검증한다.
// 배치·동시·재개 가능. data/verify-th/{codex,agy}_<i>.json 에 원시 JSON 저장.
// reconcile-trailheads.mjs 가 이를 병합해 enrichment.verified.json 의 각 코스에 trailhead 추가.
// Run: node scripts/verify-trailheads.mjs   (env: CONC=3 BATCH=4 TIMEOUT=420)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VDIR = join(ROOT, 'data', 'verify-th');
mkdirSync(VDIR, { recursive: true });

const BATCH = Number(process.env.BATCH || 4);
const CONC = Number(process.env.CONC || 3);
const TIMEOUT = Number(process.env.TIMEOUT || 420) * 1000;
const ONLY = process.env.ONLY ? new Set(JSON.parse(readFileSync(process.env.ONLY, 'utf8'))) : null;

const mountains = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'mountains.json'), 'utf8')).mountains;
const items = mountains
  .filter((m) => !ONLY || ONLY.has(m.id))
  .filter((m) => m.lat != null && (m.trails || []).length)
  .map((m) => ({
    id: m.id, name: m.name_full, elev: m.elevation_m, loc: m.location,
    summit: [Math.round(m.lat * 1e5) / 1e5, Math.round(m.lon * 1e5) / 1e5],
    courses: (m.trails || []).map((t) => ({ name: t.name, start: t.start || null })),
  }));
const batches = [];
for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));

const PROMPT = (batch) => `다음 대한민국 산들의 각 등산 코스별 '들머리(트레일헤드) 좌표'를 웹 조사로 확인해 JSON으로만 출력하라.
들머리 = 그 코스의 산행 시작 지점(탐방지원센터·주차장·버스종점·마을 입구 등). 정상이 아니라 '출발점' 좌표다.

규칙:
- 각 산의 summit(정상 좌표)와 courses(코스명·start들머리명)를 참고하라.
- 각 코스마다 들머리의 위도/경도를 십진수(WGS84)로 반환. 대한민국 범위(위도 33~39, 경도 124~132).
- 들머리는 보통 정상에서 2~12km 이내의 산기슭 지점이다. 정상 좌표를 그대로 쓰지 마라.
- 확실치 않으면 해당 코스의 trailhead를 null 로 두라(추측 금지).
- 입력의 모든 id와 각 코스 name을 그대로 포함하라.
- 반드시 아래 JSON 하나만 출력(설명·마크다운·코드펜스 금지):
{"mountains":[{"id":"<id>","courses":[{"name":"<코스명>","trailhead":[lat,lon]}]}]}

대상 산 목록:
${JSON.stringify(batch)}`;

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
  return ids.every((id) => got.has(id));
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
  await runProc('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-o', outFile, prompt], { timeoutMs: TIMEOUT });
}
async function runAgy(prompt, outFile) {
  await runProc('agy', ['-p', prompt, '--dangerously-skip-permissions'], { timeoutMs: TIMEOUT, captureStdout: true, outFile });
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
    doSource('codex', prompt, join(VDIR, `codex_${i}.json`), ids),
    doSource('agy', prompt, join(VDIR, `agy_${i}.json`), ids),
  ]);
  done++;
  console.log(`[batch ${i + 1}/${batches.length}] ${ids.join(',')} → codex:${cx ? 'ok' : 'MISS'} agy:${ay ? 'ok' : 'MISS'}  (${done}/${batches.length})`);
}
let next = 0;
async function worker() { while (next < batches.length) { const i = next++; await doBatch(i); } }
console.log(`verify-trailheads: ${items.length} mountains, ${batches.length} batches (size ${BATCH}), conc ${CONC}`);
await Promise.all(Array.from({ length: CONC }, worker));
console.log('ALL DONE');
