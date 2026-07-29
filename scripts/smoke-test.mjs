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

  // ---- 지도 검색: 자동완성 → 지도에서 찾아가기 ----
  // 지도가 실제로 이동했는지는 로드된 타일의 z/x/y를 파싱해 경계로 확인한다.
  const mapViewport = (p) => p.evaluate(() => {
    const t = [];
    for (const img of document.querySelectorAll('#map img.leaflet-tile-loaded')) {
      const m = img.src.match(/\/(\d+)\/(\d+)\/(\d+)(?:@2x)?\.png/);
      if (m) t.push([+m[1], +m[2], +m[3]]);
    }
    if (!t.length) return null;
    const z = Math.max(...t.map((a) => a[0])), at = t.filter((a) => a[0] === z), n = 2 ** z;
    const lon = (x) => (x / n) * 360 - 180;
    const lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    const xs = at.map((a) => a[1]), ys = at.map((a) => a[2]);
    return { z, west: lon(Math.min(...xs)), east: lon(Math.max(...xs) + 1),
             north: lat(Math.min(...ys)), south: lat(Math.max(...ys) + 1) };
  });

  const searchCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const sPage = await searchCtx.newPage();
  sPage.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await sPage.goto(base + '/#/map', { waitUntil: 'networkidle', timeout: 30000 });
  await sPage.waitForSelector('.mtn-item', { timeout: 10000 });
  await sPage.mouse.move(1000, 850);              // 드롭다운이 커서 아래 떠서 hover 인덱스가 잡히지 않게
  await sPage.fill('.panel .search', '설악');
  await sPage.waitForSelector('.panel .map-suggest:not([hidden])', { timeout: 8000 });
  const sugNames = await sPage.locator('.panel .map-suggest-item .ms-name').allTextContents();
  check('search: 자동완성 제안', sugNames.length > 0 && sugNames[0].startsWith('설악산'), sugNames.join(' | '));
  await sPage.locator('.panel .map-suggest-item').first().click();
  await sPage.waitForTimeout(2200);
  const seorak = mountains.find((m) => m.name === '설악산');
  const vp = await mapViewport(sPage);
  const onTarget = vp && seorak.lat > vp.south && seorak.lat < vp.north && seorak.lon > vp.west && seorak.lon < vp.east;
  check('search: 선택하면 지도가 그 산으로 이동', onTarget && vp.z >= 11, `z=${vp?.z}`);
  check('search: 목록에서 강조', (await sPage.locator('.mtn-item.active .mtn-name').textContent()).includes('설악산'));
  check('search: 마커 팝업 열림', /설악산/.test(await sPage.locator('.leaflet-popup-content').textContent().catch(() => '')));
  await sPage.screenshot({ path: join(SHOTS, 'map-search.png') });

  // 칩을 눌러도(같은 검색어로 update 재발생) 자동 맞춤이 줌을 되돌리면 안 된다
  await sPage.locator('.chip', { hasText: '강원' }).first().click();
  await sPage.waitForTimeout(1600);
  check('search: 칩 토글해도 선택한 산의 줌 유지', (await mapViewport(sPage))?.z === (vp?.z ?? 13), `z=${(await mapViewport(sPage))?.z}`);

  // 한글 IME 조합 확정용 Enter를 제안 선택으로 오인하면 안 된다
  await sPage.fill('.panel .search', '한라');
  await sPage.waitForSelector('.map-suggest:not([hidden])', { timeout: 8000 });
  await sPage.waitForTimeout(1800);
  await sPage.evaluate(() => {
    const i = document.querySelector('.panel .search');
    i.focus();
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  });
  await sPage.waitForTimeout(800);
  check('search: IME 조합 중 Enter는 선택하지 않음',
    (await sPage.inputValue('.panel .search')) === '한라' && !(await sPage.locator('.panel .map-suggest').isHidden()),
    await sPage.inputValue('.panel .search'));
  await searchCtx.close();

  // ---- 전체화면 공용 모듈(mapfullscreen.js) + 전체화면 산 검색 ----
  // 필터 상태가 남지 않도록 새 페이지에서 진행한다.
  const fsCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const sPage2 = await fsCtx.newPage();
  sPage2.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await sPage2.goto(base + '/#/map', { waitUntil: 'networkidle', timeout: 30000 });
  await sPage2.waitForSelector('.mtn-item', { timeout: 15000 });
  check('fullscreen: 대상에 공용 .map-fs 클래스', (await sPage2.locator('.map-wrap.map-fs').count()) === 1);
  check('fullscreen: 전체화면 전엔 검색창 숨김', !(await sPage2.locator('.map-fs-search').isVisible()));
  await sPage2.locator('.map-fs-btn').click();               // 클릭 = 사용자 제스처(전체화면 요구조건)
  await sPage2.waitForTimeout(900);
  const fsOn = await sPage2.locator('.map-wrap.fs-on').count() === 1;
  check('fullscreen: 진입 시 fs-on 클래스', fsOn);
  if (fsOn) {
    check('fullscreen: 검색창 노출', await sPage2.locator('.map-fs-search').isVisible());
    await sPage2.fill('.map-fs-search .search', '한라');
    await sPage2.waitForSelector('.map-fs-search .map-suggest:not([hidden])', { timeout: 8000 });
    check('fullscreen: 제안 표시',
      (await sPage2.locator('.map-fs-search .map-suggest-item .ms-name').first().textContent()).startsWith('한라산'));
    await sPage2.locator('.map-fs-search .map-suggest-item').first().click();
    await sPage2.waitForTimeout(2200);
    const halla = mountains.find((m) => m.name === '한라산');
    const hv = await mapViewport(sPage2);
    check('fullscreen: 검색으로 지도 이동',
      hv && halla.lat > hv.south && halla.lat < hv.north && halla.lon > hv.west && halla.lon < hv.east, `z=${hv?.z}`);
    check('fullscreen: 선택 후에도 전체화면 유지', (await sPage2.locator('.map-wrap.fs-on').count()) === 1);
    await sPage2.screenshot({ path: join(SHOTS, 'map-fullscreen-search.png') });
    // Esc는 소비할 게 있을 때만 가로챈다 — 빈 상태에서 막으면 브라우저 전체화면 종료가 안 된다.
    // (헤드리스는 Escape로 전체화면을 종료하지 않으므로 defaultPrevented로 검증)
    const escFlags = await sPage2.evaluate(() => {
      const i = document.querySelector('.map-fs-search .search');
      i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
      const mk = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      const empty = mk(); i.dispatchEvent(empty);
      i.value = '설악'; i.dispatchEvent(new Event('input', { bubbles: true }));
      const busy = mk(); i.dispatchEvent(busy);
      return { empty: empty.defaultPrevented, busy: busy.defaultPrevented };
    });
    check('fullscreen: 빈 Esc는 브라우저에 넘김(종료 가능)', escFlags.empty === false && escFlags.busy === true, JSON.stringify(escFlags));
    await sPage2.locator('.map-fs-btn').click();
    await sPage2.waitForTimeout(700);
    check('fullscreen: 해제 시 fs-on 제거', (await sPage2.locator('.map-wrap.fs-on').count()) === 0);
  }

  // 상세 페이지 지도도 같은 모듈을 쓴다
  await sPage2.goto(base + '/#/m/seolaksan', { waitUntil: 'networkidle', timeout: 30000 });
  await sPage2.waitForSelector('#detail-map', { timeout: 15000 });
  await sPage2.waitForTimeout(800);
  check('fullscreen: 상세 지도도 .map-fs 공용', (await sPage2.locator('.detail-map-wrap.map-fs').count()) === 1);
  check('fullscreen: 상세에도 전체화면 검색 마운트', (await sPage2.locator('.detail-map-wrap .map-fs-search').count()) === 1);
  await sPage2.locator('.map-tools button', { hasText: '길찾기' }).click();
  await sPage2.waitForTimeout(250);
  await sPage2.locator('.map-fs-btn').click();
  await sPage2.waitForTimeout(800);
  if (await sPage2.evaluate(() => !!document.fullscreenElement)) {
    check('fullscreen: 진입 시 길찾기 메뉴 닫힘(검색창 가림 방지)', await sPage2.locator('.dir-menu').isHidden());
    await sPage2.locator('.map-fs-btn').click();
    await sPage2.waitForTimeout(500);
  }
  await fsCtx.close();

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
