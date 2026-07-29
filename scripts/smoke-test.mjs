// Headless smoke test: serves ./dist, drives it with playwright chromium, checks core flows.
// Usage: node scripts/smoke-test.mjs
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIST = process.env.SMOKE_DIST || join(ROOT, 'dist');
const SHOTS = process.env.SHOT_DIR || join(ROOT, 'shots');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.gpx': 'application/gpx+xml' };

const server = createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  let file = join(DIST, p);
  if (p === '/' || !existsSync(file) || !extname(file)) file = join(DIST, 'index.html');
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;
console.log('serving dist on', base);

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

try {
  await mkdir(SHOTS, { recursive: true });

  // ---- home dashboard ----
  await page.goto(base + '/#/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.dash-hero', { timeout: 10000 });
  const dashSections = await page.$$eval('.dash-section', (n) => n.length);
  check('home: dashboard sections render', dashSections >= 3, `${dashSections} sections`);
  const regionCards = await page.$$eval('.region-card', (n) => n.length);
  check('home: region quick-explore', regionCards === 6, `${regionCards} regions`);
  await page.fill('.dash-search', '설악');
  await page.waitForTimeout(250);
  const suggest = await page.$$eval('.dash-suggest-item', (n) => n.length);
  check('home: search suggestions', suggest >= 1, `${suggest} for "설악"`);
  await page.screenshot({ path: join(SHOTS, 'home.png') });

  // ---- map explore ----
  await page.goto(base + '/#/map', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.mtn-item', { timeout: 10000 });
  const listCount = await page.$$eval('.mtn-item', (n) => n.length);
  check('map: mountain list renders', listCount > 100, `${listCount} items`);
  await page.waitForTimeout(800);
  const mapMarkers = await page.$$eval('#map path.leaflet-interactive, #map .leaflet-marker-icon', (n) => n.length);
  check('home: map markers render', mapMarkers > 100, `${mapMarkers} markers`);
  const tiles = await page.$$eval('#map img.leaflet-tile', (n) => n.length);
  check('home: map tiles load', tiles > 0, `${tiles} tiles`);
  await page.screenshot({ path: join(SHOTS, 'home.png') });

  // search filter
  await page.fill('.search', '설악');
  await page.waitForTimeout(400);
  const filtered = await page.$$eval('.mtn-item', (n) => n.length);
  check('home: search filters list', filtered >= 1 && filtered < 12, `${filtered} for "설악"`);

  // region chip filter
  await page.fill('.search', '');
  await page.click('.chip[data-region="제주"]');
  await page.waitForTimeout(300);
  const jeju = await page.$$eval('.mtn-item', (n) => n.length);
  check('home: region filter works', jeju === 1, `${jeju} in 제주`);

  // map-type switcher + fullscreen control
  const typeBtns = await page.$$eval('.map-type-seg button', (n) => n.length);
  check('home: map-type switcher (일반/지형도/스카이뷰)', typeBtns === 3, `${typeBtns} buttons`);
  const fsBtn = await page.$$eval('.map-fs-btn', (n) => n.length);
  check('home: fullscreen button present', fsBtn === 1);
  await page.click('.map-type-seg button[data-type="satellite"]');
  await page.waitForTimeout(400);
  const pressed = await page.$eval('.map-type-seg button[data-type="satellite"]', (n) => n.getAttribute('aria-pressed'));
  check('home: map-type switch works', pressed === 'true');
  await page.click('.map-type-seg button[data-type="default"]'); // reset

  // ---- detail ----
  await page.goto(base + '/#/m/seolaksan', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.hero h2', { timeout: 10000 });
  const title = await page.$eval('.hero h2', (n) => n.textContent);
  check('detail: hero title', title.includes('설악'), title);
  const summary = await page.$eval('.section .prose', (n) => n.textContent.length);
  check('detail: summary present', summary > 30, `${summary} chars`);
  const hasTrails = await page.$$eval('.trail-card', (n) => n.length);
  check('detail: trail cards render', hasTrails >= 1, `${hasTrails} trails`);
  const hasElevSection = await page.$$eval('h3', (hs) => hs.some((h) => h.textContent.includes('등산로별 고도')));
  check('detail: 등산로별 고도 section (지도와 별도)', hasElevSection);
  const noTrailOverlayBtn = await page.$$eval('.map-tools button', (n) => !n.some((b) => b.textContent.includes('등산로 표시')));
  check('detail: 지도 등산로 오버레이 버튼 제거됨', noTrailOverlayBtn);
  const courseRouteBtns = await page.$$eval('.course-route-btn', (n) => n.length);
  check('detail: 코스→등산로 연결 버튼(들머리 검증)', courseRouteBtns >= 1, `${courseRouteBtns} buttons`);
  const hasNavTools = await page.$$eval('.map-tools button', (n) => n.some((b) => b.textContent.includes('길찾기')) && n.some((b) => b.textContent.includes('경로 따라가기')));
  check('detail: 내비게이션 도구(길찾기·경로 따라가기)', hasNavTools);
  await page.waitForTimeout(800);
  const summitMarker = await page.$$eval('#detail-map .leaflet-marker-icon, #detail-map path.leaflet-interactive', (n) => n.length);
  check('detail: summit marker on map', summitMarker >= 1, `${summitMarker} markers`);
  await page.click('.hike-btn');
  const hikeOn = await page.$eval('.hike-btn', (n) => n.classList.contains('done'));
  check('detail: hike toggle works', hikeOn);
  await page.screenshot({ path: join(SHOTS, 'detail.png'), fullPage: true });

  // ---- stats ----
  await page.goto(base + '/#/stats', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.stat-card', { timeout: 10000 });
  const cards = await page.$$eval('.stat-card', (n) => n.length);
  check('stats: cards render', cards >= 3, `${cards} cards`);
  const recorded = await page.$eval('.stat-card .big', (n) => n.textContent.trim());
  check('stats: reflects hiked toggle', parseInt(recorded, 10) >= 1, `count=${recorded}`);
  await page.screenshot({ path: join(SHOTS, 'stats.png') });

  // ---- 현재 위치 기준 "가까운 순" (위치를 목으로 주입한 별도 컨텍스트) ----
  const ME = { lat: 37.5665, lng: 126.9780 };  // 서울시청
  const hav = (la1, lo1, la2, lo2) => {
    const R = 6371000, r = (d) => (d * Math.PI) / 180;
    const dLa = r(la2 - la1), dLo = r(lo2 - lo1);
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  const mountains = JSON.parse(await readFile(join(DIST, 'data/mountains.json'), 'utf8')).mountains;
  const wantIds = mountains.map((m) => ({ id: m.id, d: hav(ME.lat, ME.lng, m.lat, m.lon), n: m.name }))
    .sort((a, b) => (a.d - b.d) || a.n.localeCompare(b.n, 'ko')).map((x) => x.id);

  const geoCtx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    geolocation: { latitude: ME.lat, longitude: ME.lng, accuracy: 30 },
    permissions: ['geolocation'],
  });
  const geoPage = await geoCtx.newPage();
  geoPage.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const idsOf = (root, sel) => root.locator(sel).evaluateAll((ns) => ns.map((n) => (n.getAttribute('href') || '').replace('#/m/', '')));

  await geoPage.goto(base + '/#/', { waitUntil: 'networkidle', timeout: 30000 });
  await geoPage.waitForSelector('.mc-reason', { timeout: 10000 }).catch(() => {});
  const nearSec = geoPage.locator('section.dash-section').filter({ hasText: '내 주변 명산' }).first();
  const homeIds = await idsOf(nearSec, '.mtn-card');
  check('near: 홈 "내 주변 명산" 최근접순', JSON.stringify(homeIds) === JSON.stringify(wantIds.slice(0, 4)), homeIds.join(','));

  await geoPage.goto(base + '/#/map?sort=near', { waitUntil: 'networkidle', timeout: 30000 });
  await geoPage.waitForSelector('.mtn-rank.num', { timeout: 10000 });
  const nearIds = await idsOf(geoPage, '.mtn-item');
  const diff = nearIds.findIndex((v, i) => v !== wantIds[i]);
  check('near: 지도 목록 전체가 거리 오름차순', diff === -1 && nearIds.length === wantIds.length,
    diff === -1 ? `${nearIds.length}곳` : `idx ${diff}: ${nearIds[diff]} != ${wantIds[diff]}`);
  check('near: 항목마다 거리 표시', (await geoPage.locator('.mtn-dist').count()) === wantIds.length);
  await geoPage.locator('.sort-seg button', { hasText: '기본순' }).click();
  await geoPage.waitForTimeout(250);
  check('near: 기본순 복귀', (await geoPage.locator('.mtn-rank.num').count()) === 0);
  await geoPage.screenshot({ path: join(SHOTS, 'near-sort.png') });
  await geoCtx.close();

  // 위치 권한이 없을 때: 자동 프롬프트 없이 안내만 (홈이 깨지지 않아야 한다)
  const denyCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const denyPage = await denyCtx.newPage();
  denyPage.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await denyPage.goto(base + '/#/', { waitUntil: 'networkidle', timeout: 30000 });
  check('near: 위치 없을 때 홈에 요청 카드', (await denyPage.locator('.near-cta').count()) === 1);
  check('near: 위치 없을 때 자동 측정 안 함', (await denyPage.evaluate(() => localStorage.getItem('kr100:pos'))) === null);
  await denyCtx.close();
} catch (e) {
  errors.push('fatal: ' + e.message);
} finally {
  console.log('\n=== checks ===');
  let pass = 0;
  for (const r of results) { console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`); if (r.ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  if (errors.length) { console.log('\n=== console/page errors ==='); errors.forEach((e) => console.log(' •', e)); }
  console.log('screenshots in', SHOTS);
  await browser.close();
  server.close();
  process.exit(errors.length || pass < results.length ? 1 : 0);
}
