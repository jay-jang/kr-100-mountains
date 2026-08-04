// 웹 조사 러너 — 서로 독립적인 두 조사 도구를 같은 질문으로 돌리고 결과를 교차검증한다.
//
// 도구 이름은 이 파일 밖으로 나가지 않는다. 산출 데이터·UI·문서에서는
// `crosscheck1` / `crosscheck2` 같은 중립적인 이름만 쓴다.
import { spawn } from 'node:child_process';

// 조사원 정의. cmd/args만 바꾸면 다른 도구로 교체할 수 있다.
//
// timeoutMs 는 **도구 자신의 내부 제한보다 넉넉해야 한다.** 둘이 같으면 도구가 결과를 뱉기
// 직전에 이쪽에서 죽여 버려 20분을 쓰고도 빈손이 된다(실제로 겪음: 종료코드 null, JSON 없음).
const HARD_TIMEOUT_MS = 18 * 60 * 1000;

export const RESEARCHERS = [
  {
    key: 'crosscheck1',
    cmd: 'codex',
    args: (prompt, outFile) => ['exec', '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check', '-o', outFile, prompt],
    readsOutFile: true,
    timeoutMs: HARD_TIMEOUT_MS,
  },
  {
    key: 'crosscheck2',
    cmd: 'agy',
    args: (prompt) => ['-p', prompt, '--dangerously-skip-permissions', '--effort', 'high',
      '--print-timeout', '14m'],          // 강제 종료(18분)보다 확실히 짧게
    readsOutFile: false,
    timeoutMs: HARD_TIMEOUT_MS,
  },
];

/**
 * 조사원 하나를 돌린다.
 * stdin은 반드시 닫아 준다 — 프롬프트가 '/'로 시작하면 슬래시 명령으로 읽고
 * stdin에서 추가 입력을 기다리며 멈추는 도구가 있다.
 */
export function runResearcher(r, prompt, outFile, { timeoutMs = r.timeoutMs || HARD_TIMEOUT_MS, log = () => {} } = {}) {
  return new Promise((resolve) => {
    const args = r.args(prompt, outFile);
    // detached: true 로 별도 프로세스 그룹을 만든다. 조사 도구가 손자 프로세스를 띄우므로
    // 타임아웃 때 대표 PID만 죽이면 손자들이 남아 CPU·메모리를 계속 문다.
    const child = spawn(r.cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); }     // 그룹 전체
      catch { try { child.kill('SIGKILL'); } catch { /* 이미 죽음 */ } }
    }, timeoutMs);
    // setEncoding을 쓰지 않고 Buffer를 문자열로 이어붙이면 한 글자가 청크 경계에 걸릴 때
    // 깨진다("성판악" → "성판��"). StringDecoder가 경계를 물고 가도록 맡긴다.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, stdout: out, stderr: err }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) log(`    ${r.key} 종료코드 ${code}${err ? ' · ' + err.trim().slice(0, 160) : ''}`);
      resolve({ ok: code === 0, code, stdout: out, stderr: err });
    });
  });
}

/**
 * 모델 응답에서 첫 번째 완전한 JSON 객체를 꺼낸다.
 * 앞뒤 설명글·```json 펜스가 섞여 와도 견디게(기존 merge-verify.mjs와 같은 방식).
 */
export function extractJSON(text) {
  if (!text) return null;
  for (let s = text.indexOf('{'); s >= 0; s = text.indexOf('{', s + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = s; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(s, i + 1)); } catch { break; }   // 이 후보는 실패 → 다음 '{'부터 다시
        }
      }
    }
  }
  return null;
}

// ── 한국어 문장 유사도 ────────────────────────────────────────────────
// 두 조사원이 같은 사실을 다른 말로 적어도 같은 항목으로 묶기 위한 것.
const NOISE = /[()\[\]{}<>"'`·,.!?~\-—/|]+/g;
const STOP = new Set(['그리고', '하지만', '있다', '있음', '없다', '없음', '정도', '경우', '때문', '이다', '한다', '된다', '수도', '많이', '조금']);

export function tokens(s) {
  return new Set(String(s || '')
    .replace(NOISE, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP.has(t)));
}

const jaccard = (A, B) => {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
};

// 문자 bigram 집합. 한국어는 조사·어미가 붙어 어절이 그대로 겹치는 일이 드물어
// ("정상까지" vs "정상으로") 어절 Jaccard만으로는 같은 문장도 0.03까지 떨어진다.
function bigrams(s) {
  const t = String(s || '').replace(/[()[\]{}<>"'`·,.!?~\-—/|\s]+/g, '');
  const g = new Set();
  for (let i = 0; i + 2 <= t.length; i++) g.add(t.slice(i, i + 2));
  return g;
}

/**
 * 두 한국어 문장의 유사도(0~1). 어절·문자 bigram 중 큰 값.
 * **주의:** 이 값은 "같은 사실인가"를 판정하기엔 약하다(실측: 같은 사실 0.11~0.22,
 * 다른 사실 0.08 — 구분이 안 된다). 그래서 교차검증은 이 값이 아니라 별도 검증
 * 라운드로 하고, 이 함수는 **명백한 중복 제거**(높은 임계값)에만 쓴다.
 */
export function similarity(a, b) {
  return Math.max(jaccard(tokens(a), tokens(b)), jaccard(bigrams(a), bigrams(b)));
}

// 문장에 든 수치 표현(거리·정원·시각·요금·배차). 유사도가 높아도 이 값들이 다르면
// 서로 다른 주장이다 — "50대 수용"과 "500대 수용"은 합치면 안 된다.
export function numericTokens(s) {
  const out = new Set();
  for (const m of String(s || '').matchAll(/\d[\d,]*(?:\.\d+)?\s*(?:km|m|분|시간|시|일|명|대|원|회|월|%)?/g)) {
    out.add(m[0].replace(/[\s,]/g, ''));
  }
  return out;
}

/** 두 문장의 수치 표현이 서로 어긋나는가(한쪽에만 있는 건 무시, 값이 다른 것만 본다). */
export function numericConflict(a, b) {
  const A = numericTokens(a), B = numericTokens(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  // 양쪽 다 수치를 말하는데 겹치는 게 하나도 없으면 다른 사실로 본다.
  return shared === 0;
}

// URL 정규화 — 같은 출처를 추적 파라미터 차이로 다르게 세지 않도록.
export function normalizeUrl(u) {
  try {
    const url = new URL(String(u).trim());
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|source)/i.test(k)) url.searchParams.delete(k);
    }
    let s = url.toString();
    if (s.endsWith('/') && url.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch { return null; }
}
