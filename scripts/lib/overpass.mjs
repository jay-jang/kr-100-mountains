// Overpass API 클라이언트 — 미러 순환 + 지수 백오프 + 디스크 캐시.
// OSMF API 사용 정책에 따라 식별 가능한 User-Agent를 보내고 동시성은 1로 제한한다.
// (호출측이 순차 실행하므로 여기서는 요청 간 최소 간격만 강제한다.)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const UA = 'kr-100-mountains-route-harvester/1.0 (+https://github.com/jay-jang/kr-100-mountains)';
const MIN_GAP_MS = 2500;          // 공용 서버 배려: 요청 사이 최소 간격
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

let lastCallAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

/**
 * Overpass 질의. cacheFile이 주어지면 성공 응답을 그대로 저장하고,
 * 다음 실행에서는 네트워크를 건너뛴다(재개 가능성).
 */
export async function overpass(query, { cacheFile = null, tries = 4, timeoutMs = 180000, log = () => {} } = {}) {
  if (cacheFile && existsSync(cacheFile)) {
    try { return JSON.parse(readFileSync(cacheFile, 'utf8')); }
    catch { log(`  캐시 손상 — 다시 받습니다: ${cacheFile}`); }
  }

  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    await throttle();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      clearTimeout(to);
      if (res.ok) {
        const text = await res.text();
        const json = JSON.parse(text);
        if (cacheFile) { mkdirSync(dirname(cacheFile), { recursive: true }); writeFileSync(cacheFile, text); }
        return json;
      }
      lastErr = new Error(`HTTP ${res.status} (${new URL(url).host})`);
      // 재시도 대상이 아닌 상태코드(예: 400)라도 곧바로 포기하지 않고 다음 미러를 시도한다.
      // 미러마다 Overpass 버전·질의 제한이 조금씩 달라 한 곳에서만 거절되는 경우가 있다.
      if (!RETRYABLE.has(res.status)) { log(`  ${lastErr.message} — 다음 미러로`); continue; }
      const ra = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : [3000, 8000, 20000, 45000][attempt] ?? 45000;
      log(`  ${lastErr.message} — ${Math.round(backoff / 1000)}초 후 재시도`);
      await sleep(backoff);
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      if (e.name === 'AbortError') log(`  타임아웃 (${new URL(url).host})`);
      else log(`  ${e.message} (${new URL(url).host})`);
      await sleep([2000, 5000, 12000, 30000][attempt] ?? 30000);
    }
  }
  throw lastErr || new Error('Overpass 요청 실패');
}

export function cachePath(root, ...parts) {
  return join(root, '.cache', 'routes', ...parts);
}
