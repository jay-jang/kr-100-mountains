// 브라우저 테스트(smoke·ux·courses·planner) 공용 도구.
//   serve(dist)      빌드 폴더를 여는 작은 정적 서버(없는 파일은 404 — GitHub Pages와 같다)
//   launch()         playwright chromium
//   stubNetwork(ctx) 바깥 요청을 모두 가로챈다: 지도 타일 → 작은 PNG, Overpass·open-meteo → 고정 JSON,
//                    그 밖의 외부 주소 → 차단하고 기록. 그래서 결과가 네트워크 상태에 좌우되지 않는다.
//   watch(page)      콘솔 오류·페이지 예외 수집
//   reporter(name)   PASS/FAIL 줄 출력, 실패가 있으면 종료 코드 1
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const DIST = resolve(process.env.SMOKE_DIST || join(ROOT, 'dist'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.gpx': 'application/gpx+xml', '.md': 'text/markdown',
};

// 테스트 대상 출처(로컬 서버 또는 UX_BASE_URL 배포본) — stubNetwork가 가로채지 않는다.
const LOCAL_ORIGINS = new Set();

/** dist 폴더를 연다. 경로 '/'만 index.html, 없는 파일은 404. UX_BASE_URL을 주면 그 배포본을 검사한다. */
export async function serve(dist = DIST) {
  if (!process.env.UX_BASE_URL && !existsSync(join(dist, 'index.html'))) {
    console.error(`FAIL build: ${dist}/index.html 이 없습니다. 먼저 빌드하세요 (SMOKE_DIST로 폴더 지정).`);
    process.exit(1);
  }
  const server = createServer(async (req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const file = resolve(dist, '.' + (p === '/' ? '/index.html' : p));
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    try {
      const buf = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = process.env.UX_BASE_URL?.replace(/\/$/, '') || `http://127.0.0.1:${server.address().port}`;
  LOCAL_ORIGINS.add(new URL(base).origin);
  return { base, close: () => new Promise((r) => server.close(r)) };
}

export function launch() {
  return chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
}

// 256×256 회색 PNG(지도 타일 대용).
export const TILE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQMAAABmvDolAAAAA1BMVEXd39M7UcEHAAAAH0lEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAvg0hAAABYOSdlwAAAABJRU5ErkJggg==',
  'base64');

const TILE_RE = /(^|\.)tile\.openstreetmap\.org$|(^|\.)opentopomap\.org$|(^|\.)arcgisonline\.com$|cartocdn\.com$|basemaps\./;

/**
 * 바깥 요청을 가로챈다. 같은 컨텍스트의 모든 페이지에 적용된다.
 * @param {import('playwright').BrowserContext} context
 * @param {{overpass?:(route, body:string)=>Promise<void>|void, meteo?:(lats:number[], lons:number[])=>number[]}} [o]
 */
export async function stubNetwork(context, { overpass, meteo } = {}) {
  const log = { tiles: [], overpass: [], meteo: 0, blocked: [], external: [] };
  await context.route((url) => /^https?:$/.test(url.protocol) && !LOCAL_ORIGINS.has(url.origin) && !/^(127\.0\.0\.1|localhost)$/.test(url.hostname), async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    log.external.push(req.url());
    try {
      if (TILE_RE.test(u.hostname)) { log.tiles.push(req.url()); await route.fulfill({ status: 200, contentType: 'image/png', body: TILE_PNG }); return; }
      if (/interpreter$/.test(u.pathname) || /overpass/.test(u.hostname + u.pathname)) {
        log.overpass.push(req.postData() || '');
        if (overpass) { await overpass(route, decodeURIComponent((req.postData() || '').replace(/^data=/, ''))); return; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ elements: [] }) });
        return;
      }
      if (u.hostname === 'api.open-meteo.com') {
        log.meteo++;
        const lats = (u.searchParams.get('latitude') || '').split(',').map(Number);
        const lons = (u.searchParams.get('longitude') || '').split(',').map(Number);
        const elevation = meteo ? meteo(lats, lons) : lats.map((_, i) => 300 + 10 * i);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ elevation }) });
        return;
      }
      log.blocked.push(req.url());
      await route.abort('blockedbyclient');
    } catch { /* 페이지가 닫힌 뒤 도착한 요청 */ }
  });
  return log;
}

/** 콘솔 오류·페이지 예외를 모은다. ignore: 무시할 오류 문구(정규식). */
export function watch(page, errors, { label = '', ignore = [] } = {}) {
  const tag = label ? `[${label}] ` : '';
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // 테스트가 일부러 막은 외부 요청(stubNetwork의 abort)은 제품 오류가 아니다.
    if (/net::ERR_BLOCKED_BY_CLIENT/.test(text)) return;
    // 404 등은 아래 response 기록이 주소까지 남긴다(콘솔 문구에는 주소가 없다).
    if (/^Failed to load resource: the server responded with a status of/.test(text)) return;
    if (ignore.some((re) => re.test(text))) return;
    errors.push(`${tag}console: ${text}`);
  });
  page.on('pageerror', (e) => errors.push(`${tag}pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const u = new URL(r.url());
    const text = `${tag}http ${r.status()} ${u.pathname}`;
    if (!ignore.some((re) => re.test(text))) errors.push(text);
  });
  return page;
}

/**
 * PASS/FAIL 줄을 찍고 결과를 모은다. step()은 예외를 실패 한 줄로 바꿔 다음 단계로 넘어가게 한다.
 * TEST_ONLY=이름1,이름2 를 주면 이름에 그 글자가 든 단계만 돌린다(앞 단계에 기대는 단계는 함께 지정).
 */
export function reporter(suite) {
  const results = [];
  const only = (process.env.TEST_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
  function check(name, cond, detail = '') {
    const ok = !!cond;
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== '' && detail != null ? `  (${detail})` : ''}`);
    return ok;
  }
  async function step(name, fn) {
    if (only.length && !only.some((o) => name.includes(o))) { console.log(`SKIP ${name}`); return; }
    try { await fn(); }
    catch (e) { check(`${name} — 단계가 예외 없이 끝남`, false, String(e?.message || e).split('\n')[0].slice(0, 300)); }
  }
  function finish() {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${suite}: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
      console.log('failed:');
      for (const r of failed) console.log(`  - ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    }
    return failed.length ? 1 : 0;
  }
  return { check, step, finish, results };
}

/** 지도 셸이 뜨고(시트 제목) 산 기호가 그려질 때까지 기다린다. */
export async function waitForShell(page, { markers = true, timeout = 20000 } = {}) {
  await page.waitForSelector('.sheet .sheet-title', { timeout });
  if (markers) await page.waitForFunction(() => document.querySelectorAll('#map .mk').length > 0, null, { timeout });
}

/** Leaflet 선(svg path) 개수. */
export function pathCount(page) {
  return page.evaluate(() => document.querySelectorAll('#map .leaflet-overlay-pane path').length);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
