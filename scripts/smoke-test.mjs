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

  // ---- home ----
  await page.goto(base + '/#/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.mtn-item', { timeout: 10000 });
  const listCount = await page.$$eval('.mtn-item', (n) => n.length);
  check('home: mountain list renders', listCount > 100, `${listCount} items`);
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
