// 경로 도구(설정 ON) 흐름: 경로 시트의 [이 길로 계획] · 코스 탭의 겹쳐 보기 · 내 GPX 열기 · 등산로망 실시간 조회.
// 사용: node scripts/planner-test.mjs   (SMOKE_DIST=<빌드 폴더>, 기본 dist — OSM 빌드 기준)
// 설악산의 경로 목록·GPX·걷기길 파일과 Overpass·open-meteo를 모두 고정 자료로 바꿔서, 좌표를 아는 작은 길 그물 위에서 검사한다.
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, DIST, serve, launch, stubNetwork, watch, reporter } from './lib/ui-harness.mjs';

const SHOTS = process.env.SHOT_DIR || join(ROOT, 'shots', 'planner');
const PREFS = { routePlanner: true, compareRoutes: true, gpxImport: true, v: 1 };
const { check, step, finish } = reporter('planner');
const errors = [];
const { base, close } = await serve();
const browser = await launch();

const { mountains } = JSON.parse(await readFile(join(DIST, 'data/mountains.json'), 'utf8'));
const m = mountains.find((x) => x.id === 'seolaksan');
const { lat, lon } = m;
// 정상 J를 가운데 둔 작은 길 그물:  A —west— J —east— B,  J —loop— C —retry— D
const A = [lat, lon - 0.01], J = [lat, lon], B = [lat, lon + 0.01], C = [lat + 0.006, lon + 0.005], D = [lat + 0.006, lon + 0.015];
const gpx = (name, segments) => `<?xml version="1.0"?><gpx version="1.1"><trk><name>${name}</name>${segments.map((pts) => `<trkseg>${pts.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"><ele>100</ele></trkpt>`).join('')}</trkseg>`).join('')}</trk></gpx>`;
const FILES = {
  'routes/seolaksan/west.gpx': gpx('서쪽', [[A, J]]),
  'routes/seolaksan/east.gpx': gpx('동쪽', [[J, B]]),
  'routes/seolaksan/retry.gpx': gpx('누락', [[C, D]]),
  'routes/osm-relations/loop.gpx': gpx('순환', [[J, C]]),
};
const track = (route_index, file, variant = 0) => ({ route_index, variant, file, kind: 'osm-routed', status: 'accepted', warnings: [], distance_hypothesis: 'one-way' });
// trails[0] 오색 = west(+대안 retry), trails[1] 소공원 = east, trails[2] 한계령 = west(같은 파일 중복)
const ENTRY = { mountain_id: 'seolaksan', tracks: [track(1, 'routes/seolaksan/west.gpx'), track(1, 'routes/seolaksan/retry.gpx', 1), track(2, 'routes/seolaksan/east.gpx'), track(3, 'routes/seolaksan/west.gpx')],
  relations: [{ osm_id: 999, name: 'hiking relation 999', file: 'routes/osm-relations/loop.gpx', kind: 'osm-relation' }] };
// 한계령(trails[2])에 선이 없는 경우 — 실시간 길 찾기 검사용
const ENTRY_NO_T2 = { ...ENTRY, tracks: ENTRY.tracks.filter((t) => t.route_index !== 3) };
const WALKS = { id: 'seolaksan', routes: [{ rid: 'r999', name: '순환 도보길', kind: 'trail', long: false, loop: false, length_km: 0.8, dist_km: 0, anchor: 'summit', lines: [[J, C]], bbox: [J[0], J[1], C[0], C[1]] }] };
const OSM_LINES = [[A, J], [J, B], [J, C], [C, D], [D, B], [A, [lat + 0.003, lon - 0.006], J]];
const osmJSON = (lines) => ({ elements: lines.map((line, i) => ({ type: 'way', id: 100 + i, tags: { highway: 'path', name: `주변 등산로 ${i + 1}` }, geometry: line.map(([la, lo]) => ({ lat: la, lon: lo })) })) });

/**
 * 컨텍스트 하나를 고정 자료로 꾸민다.
 * @param {{entry?:object, prefs?:object, failRetry?:boolean, failOSM?:boolean, gateGPX?:Promise, gateOSM?:Promise, osm?:(query:string)=>object}} o
 */
async function setup({ viewport = { width: 1440, height: 1000 }, mobile = false, entry = ENTRY, prefs = PREFS, failRetry = true, failOSM = false, gateGPX = null, gateOSM = null, osm = null, label = 'planner' } = {}) {
  const ctx = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const stats = { counts: new Map(), overpass: 0, active: 0, maxActive: 0 };
  const net = await stubNetwork(ctx, {
    overpass: async (route, query) => {
      stats.overpass++;
      if (gateOSM) await gateOSM;
      try {
        if (failOSM) await route.abort('failed');
        else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(osm ? osm(query) : osmJSON(OSM_LINES)) });
      } catch { /* 페이지가 닫힘 */ }
    },
  });
  await ctx.addInitScript((p) => { try { localStorage.setItem('kr100:prefs', JSON.stringify(p)); } catch {} }, prefs);
  await ctx.route('**/gpx/routes/m/seolaksan.json', (r) => r.fulfill({ json: entry }));
  await ctx.route('**/data/trekking/index.json', (r) => r.fulfill({ json: { mountains: { seolaksan: { count: 1, kinds: { trail: 1 }, names: ['순환 도보길'] } } } }));
  await ctx.route('**/data/trekking/m/seolaksan.json', (r) => r.fulfill({ json: WALKS }));
  let retryFailed = !failRetry;
  await ctx.route(/\/gpx\/routes\/(seolaksan|osm-relations)\/[^/]+\.gpx$/, async (r) => {
    const file = new URL(r.request().url()).pathname.split('/gpx/')[1];
    if (!FILES[file]) return r.continue();
    stats.counts.set(file, (stats.counts.get(file) || 0) + 1);
    stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      if (gateGPX && file.endsWith('/retry.gpx')) await gateGPX;
      await new Promise((res) => setTimeout(res, 60));
      if (file.endsWith('/retry.gpx') && !retryFailed) { retryFailed = true; await r.fulfill({ status: 503, body: 'temporary' }); }
      else await r.fulfill({ contentType: 'application/gpx+xml', body: FILES[file] });
    } catch { /* 페이지가 닫힘 */ } finally { stats.active--; }
  });
  // 고의로 503을 주는 재시도 파일과, 고의로 끊은 Overpass 요청은 제품 오류가 아니다.
  const page = watch(await ctx.newPage(), errors, { label, ignore: [/http 503 \/gpx\/routes\/seolaksan\/retry\.gpx/, ...(failOSM ? [/net::ERR_FAILED/] : [])] });
  return { ctx, page, stats, net };
}

const bold = (page) => page.evaluate(() => document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="5"]').length);
const pathsW = (page, w) => page.evaluate((x) => document.querySelectorAll(`#map .leaflet-overlay-pane path[stroke-width="${x}"]`).length, w);
async function openMountain(page) {
  await page.goto(base + '/#/m/seolaksan');
  await page.waitForFunction(() => document.querySelector('.sheet .mt-title .mt-name')?.textContent === '설악산');
  await page.waitForSelector('#mt-panel-courses .mt-crow');
}
async function openRoute(page, key) {
  await page.goto(`${base}/#/m/seolaksan?route=${encodeURIComponent(key)}`);
  await page.waitForFunction(() => location.hash.includes('route=') && !!document.querySelector('.sheet .rt-title'));
}
/** 경로 시트의 [이 길로 계획]을 눌러 계획 도구를 연다(선이 그려진 뒤에 입구가 생긴다). */
async function openPlanner(page) {
  // 모바일에서는 입구가 시트 본문에 있다 — peek이면 본문이 잘려 있으므로 먼저 펼친다.
  for (let i = 0; i < 3 && await page.locator('.sheet-grabber').isVisible() && ['peek', 'min'].includes(await page.locator('.sheet').getAttribute('data-detent')); i++) {
    await page.locator('.sheet-grabber').click();
    await page.waitForTimeout(350);
  }
  const btn = page.getByRole('button', { name: '이 길로 계획', exact: true });
  await btn.waitFor({ timeout: 15000 });
  await btn.click();
  await page.waitForSelector('.route-planner');
}
const loadBtn = (page) => page.locator('.planner-head button');
async function loadAll(page) {
  await loadBtn(page).click();
  await page.waitForFunction(() => !document.querySelector('.planner-head button').disabled && !/불러오는 중/.test(document.querySelector('.planner-head button').textContent));
}
async function add(page, label) {
  const select = page.getByLabel('경로 위 지점 선택', { exact: true });
  const value = await select.locator('option').evaluateAll((os, l) => os.find((o) => o.textContent === l)?.value, label);
  if (!value) throw new Error(`지점 없음: ${label} (있는 것: ${(await select.locator('option').allTextContents()).join(' / ')})`);
  await select.selectOption(value);
  await page.getByRole('button', { name: '지점 추가', exact: true }).click();
}
async function exportPlan(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '계획 GPX 내려받기', exact: true }).click()]);
  return readFile(await download.path(), 'utf8');
}
const exportBtn = (page) => page.getByRole('button', { name: '계획 GPX 내려받기', exact: true });
const wps = (page) => page.locator('.planner-waypoints li').count();

try {
  await mkdir(SHOTS, { recursive: true });

  // =============== 1. 기본 흐름(데스크톱, 등산로망 실시간 조회 OFF) ===============
  const one = await setup({ label: 'desktop' });
  const { page, stats } = one;

  await step('entry points', async () => {
    await openMountain(page);
    check('tools: 설정 ON → 코스 탭에 [GPX 파일 열기]', await page.getByRole('button', { name: 'GPX 파일 열기', exact: true }).isVisible());
    const boxes = await page.locator('#mt-panel-courses .mt-cmp input[type=checkbox]').count();
    check('tools: 선이 있는 행마다 겹쳐 보기 선택 상자', boxes === 4, `${boxes}개 (등산로 3 + OSM 노선 1)`);
    check('tools: OSM 등록 탐방로 행(정상 근처 노선 → 구운 관계 GPX)', (await page.locator('#mt-panel-courses .rows-h', { hasText: 'OpenStreetMap 등록 탐방로' }).count()) === 1
      && (await page.locator('.mt-crow[data-key="o:999"]').textContent()).includes('OpenStreetMap 노선'));
    await page.waitForFunction(() => document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="3"]').length >= 4, null, { timeout: 15000 }).catch(() => {});
    const dup = [...stats.counts].filter(([, n]) => n > 1);
    check('files: 산을 열 때 같은 GPX 파일은 한 번만 받음', dup.length === 0, dup.map(([f, n]) => `${f}×${n}`).join(' ') || [...stats.counts.keys()].length + ' files');
    check('network: 실시간 조회 OFF면 Overpass를 부르지 않음', stats.overpass === 0);
  });

  await step('compare', async () => {
    const box = (key) => page.locator(`.mt-crow[data-key="${key}"] .mt-cmp input`);
    const before = await pathsW(page, 4);
    await box('t:0').check();
    await box('t:1').check();
    await page.waitForFunction((n) => document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="4"]').length >= n + 2, before, { timeout: 8000 }).catch(() => {});
    const on = await pathsW(page, 4);
    check('compare: 두 경로를 겹쳐 그림', on >= before + 2, `${before} → ${on}`);
    const sw = await page.locator('.mt-crow[data-key="t:1"] .mt-cmp-sw').getAttribute('style');
    check('compare: 행에 지도 선 색 견본', /--c:#/.test(sw || ''), sw);
    await box('t:0').uncheck();
    await page.waitForTimeout(300);
    check('compare: 하나를 끄면 그 선만 내려감', (await pathsW(page, 4)) === on - 1, `${on} → ${await pathsW(page, 4)}`);
    await box('t:1').uncheck();
    await page.waitForTimeout(200);
    check('compare: 모두 끄면 겹친 선 없음', (await pathsW(page, 4)) === before);
  });

  await step('planner load', async () => {
    await page.locator('.mt-crow[data-key="t:0"] .mt-crow-link').click();
    await page.waitForFunction(() => !!document.querySelector('.sheet .rt-title'));
    await page.waitForFunction(() => document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="5"]').length > 0);
    await openPlanner(page);
    check('planner: [이 길로 계획] → 계획 도구', await page.locator('.route-planner').isVisible() && (await page.getByRole('button', { name: '이 길로 계획', exact: true }).getAttribute('aria-expanded')) === 'true');
    check('planner: 고른 경로만으로 바로 계획 가능', (await page.locator('.planner-count').textContent()).startsWith('1개 경로'), await page.locator('.planner-count').textContent());
    const fetched = new Map(stats.counts);
    await loadAll(page);
    const status = await page.locator('.planner-status').textContent();
    check('planner: 수록·계산 경로 + OSM 노선을 함께 불러옴(실패분 제외)', (await page.locator('.planner-count').textContent()).startsWith('4개 경로'), await page.locator('.planner-count').textContent());
    check('planner: 일부 실패를 알리고 재시도 안내', status.includes('일부는 불러오지 못했습니다') && (await loadBtn(page).textContent()) === '누락된 경로 다시 불러오기', status);
    const refetched = [...stats.counts].filter(([f, n]) => !f.endsWith('retry.gpx') && n !== fetched.get(f));
    check('planner: 이미 받은 파일은 다시 받지 않음', refetched.length === 0, refetched.map(([f, n]) => `${f}×${n}`).join(' '));
    await loadAll(page);
    check('planner: 다시 누르면 빠진 파일만 받아 채움', (await page.locator('.planner-count').textContent()).startsWith('5개 경로') && stats.counts.get('routes/seolaksan/retry.gpx') === 2
      && stats.counts.get('routes/seolaksan/east.gpx') === fetched.get('routes/seolaksan/east.gpx') && (await loadBtn(page).textContent()) === '모든 경로 다시 보기', await page.locator('.planner-count').textContent());
    check('planner: 실시간 조회 OFF면 Overpass를 부르지 않음', stats.overpass === 0);
  });

  await step('planner plan', async () => {
    await add(page, '한계령-대청봉 코스 · 시작 지점');
    await add(page, '순환 도보길 · 끝 지점');
    await add(page, '소공원-천불동-대청봉 코스 · 끝 지점');
    check('plan: 순서대로 지점을 이어 경로를 만듦', (await wps(page)) === 3 && (await page.locator('.planner-summary').textContent()).includes('2구간') && await exportBtn(page).isEnabled(),
      await page.locator('.planner-summary').textContent());
    check('plan: 지도에 계획 선(주황, 굵기 7)', (await pathsW(page, 7)) >= 1);
    const xml = await exportPlan(page);
    check('plan: GPX에 돌아가는 지점·계획 표시·실측 아님', xml.includes(C[0].toFixed(7)) && xml.includes('planned-hike') && xml.includes('실측 기록이 아니며'));
    await page.getByRole('button', { name: '출발점으로 돌아오기', exact: true }).click();
    const round = await exportPlan(page);
    const pts = [...round.matchAll(/trkpt lat="([^"]+)" lon="([^"]+)"/g)].map((x) => x.slice(1).join());
    check('plan: 출발점으로 돌아오는 원점 회귀', pts[0] === pts.at(-1) && (await wps(page)) === 4);
    await page.getByRole('button', { name: '4번 지점 삭제', exact: true }).click();
    await page.getByRole('button', { name: '진행 방향 뒤집기', exact: true }).click();
    check('plan: 방향 뒤집기', (await page.locator('.planner-waypoints li').first().textContent()).includes('소공원'));
    await page.getByRole('button', { name: '2번 지점 앞으로', exact: true }).click();
    check('plan: 지점 순서 바꾸기', (await page.locator('.planner-waypoints li').first().textContent()).includes('순환 도보길'));
    await page.locator('.route-planner').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, 'plan-desktop.png') });
  });

  await step('planner persist', async () => {
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector('.sheet .rt-title'));
    await openPlanner(page);
    await page.waitForFunction(() => document.querySelector('.planner-summary')?.textContent.includes('총'), null, { timeout: 15000 });
    check('persist: 새로고침 뒤 저장한 계획을 자동으로 불러와 다시 계산', (await wps(page)) === 3 && (await page.locator('.planner-waypoints li').first().textContent()).includes('순환 도보길'));
    await page.getByRole('button', { name: '등산로 목록에 추가', exact: true }).click();
    check('persist: 계획을 코스 탭 내 경로에 추가', (await page.locator('.rt-body > p[role=status]').textContent()).includes('내 경로'));
    await page.locator('.rt-back').click();
    await page.waitForFunction(() => !!document.querySelector('.sheet .mt-title') && !location.hash.includes('route='));
    const mine = page.locator('#mt-panel-courses .rows[aria-label="내 경로"] .mt-crow');
    check('persist: 코스 탭 "내 경로"에 내 계획 행', (await mine.count()) === 1 && (await mine.textContent()).includes('설악산 내 계획') && (await mine.textContent()).includes('내 계획'));
    await mine.locator('.mt-crow-link').click();
    await page.waitForFunction(() => !!document.querySelector('.sheet .rt-title'));
    await page.waitForFunction(() => document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="5"]').length > 0, null, { timeout: 8000 }).catch(() => {});
    check('persist: 내 계획 경로 시트(생성 방식 "내 계획", GPX 받기 없음)', (await page.locator('.rt-prov').textContent()).includes('내 계획')
      && (await page.locator('.rt-actions', { hasText: 'GPX 받기' }).count()) === 0 && (await bold(page)) > 0);
    await page.locator('.rt-back').click();
    await page.waitForFunction(() => !!document.querySelector('.sheet .mt-title') && !location.hash.includes('route='));
    await page.locator('.mt-crow[data-key="t:0"] .mt-crow-link').click();
    await page.waitForFunction(() => !!document.querySelector('.sheet .rt-title'));
    await openPlanner(page);
    await page.waitForFunction(() => document.querySelector('.planner-summary')?.textContent.includes('총'), null, { timeout: 15000 });
    await page.getByRole('button', { name: '진행 방향 뒤집기', exact: true }).click();
    await page.getByRole('button', { name: '등산로 목록에 추가', exact: true }).click();
    await page.locator('.rt-back').click();
    await page.waitForFunction(() => !!document.querySelector('.sheet .mt-title') && !location.hash.includes('route='));
    check('persist: 고친 계획을 다시 추가하면 이전 것을 바꿈(한 행)', (await page.locator('#mt-panel-courses .rows[aria-label="내 경로"] .mt-crow').count()) === 1);
  });

  await step('planner reset and map pick', async () => {
    await page.locator('.mt-crow[data-key="t:0"] .mt-crow-link').click();
    await page.waitForFunction(() => !!document.querySelector('.sheet .rt-title'));
    await openPlanner(page);
    await page.waitForFunction(() => document.querySelector('.planner-summary')?.textContent.includes('총'), null, { timeout: 15000 });
    await page.getByRole('button', { name: '계획 초기화', exact: true }).click();
    check('reset: 지점을 지우고 GPX 내려받기 비활성', (await wps(page)) === 0 && !(await exportBtn(page).isEnabled()) && (await page.evaluate(() => localStorage.getItem('kr100:plan:seolaksan'))) === null);
    await page.getByRole('button', { name: '지도에서 지점 추가', exact: true }).click();
    const tools = page.locator('.planner-map-tools');
    check('pick: 지도 편집 줄(상태·마지막 지점 취소·완료)이 시트 머리에', await tools.isVisible() && await page.locator('.rt-head .planner-map-tools').isVisible()
      && !(await page.getByRole('button', { name: '마지막 지점 취소', exact: true }).isEnabled()));
    const pt = await page.evaluate(() => {
      const p = document.querySelector('#map .leaflet-overlay-pane path[stroke-width="5"]');
      const xy = p.getPointAtLength(p.getTotalLength() * 0.5).matrixTransform(p.getScreenCTM());
      return { x: xy.x, y: xy.y };
    });
    await page.mouse.click(pt.x, pt.y);
    await page.waitForFunction(() => document.querySelectorAll('.planner-waypoints li').length === 1, null, { timeout: 5000 }).catch(() => {});
    check('pick: 지도에서 길을 누르면 길 위로 맞춘 지점 추가', (await wps(page)) === 1 && hashOf(page).includes('route=t:0'));
    await page.getByRole('button', { name: '마지막 지점 취소', exact: true }).click();
    check('pick: 지도를 떠나지 않고 마지막 지점 취소', (await wps(page)) === 0 && !(await page.getByRole('button', { name: '마지막 지점 취소', exact: true }).isEnabled()));
    await page.getByRole('button', { name: '지점 선택 완료', exact: true }).click();
    check('pick: 완료하면 지도 편집 줄이 사라짐', !(await tools.isVisible()) && (await page.getByRole('button', { name: '지도에서 지점 추가', exact: true }).getAttribute('aria-pressed')) === 'false');
    const empty = await page.evaluate(() => {
      const r = document.querySelector('#map').getBoundingClientRect();
      return { x: r.left + r.width * 0.9, y: r.top + r.height * 0.15 };
    });
    await page.mouse.click(empty.x, empty.y);
    await page.waitForTimeout(300);
    check('pick: 완료 뒤 지도 클릭은 지점을 더하지 않음', (await wps(page)) === 0);
  });

  await step('gpx import', async () => {
    await page.locator('.rt-back').click();
    await page.waitForFunction(() => !!document.querySelector('.sheet .mt-title') && !location.hash.includes('route='));
    const far = (d) => [[lat + 0.05, lon + d], [lat + 0.05, lon + d + 0.003]];
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'GPX 파일 열기', exact: true }).click()]);
    await chooser.setFiles([
      { name: 'segments.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx('분리 경로', [far(0), far(0.006)])) },
      { name: 'other.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx('별도 경로', [[[lat + 0.07, lon], [lat + 0.07, lon + 0.003]]])) },
      { name: 'broken.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from('<gpx><trk><trkseg><trkpt lat="1"') },
    ]);
    await page.waitForFunction(() => /GPX를 열었습니다/.test(document.querySelector('#mt-panel-courses p[role=status]')?.textContent || ''));
    const msg = await page.locator('#mt-panel-courses p[role=status]').textContent();
    check('import: 여러 GPX를 한 번에 열고 실패분을 알림', msg.includes('2개 GPX를 열었습니다') && msg.includes('1개는 GPX 형식이 아니라서 제외') && msg.includes('기기 밖으로 보내지 않습니다'), msg);
    const mine = await page.locator('#mt-panel-courses .rows[aria-label="내 경로"]').textContent();
    check('import: 내 경로에 파일 이름(트랙 이름) 행', mine.includes('분리 경로') && mine.includes('별도 경로') && mine.includes('내 파일'));
    await page.locator('#mt-panel-courses .mt-crow', { hasText: '분리 경로' }).locator('.mt-crow-link').click();
    await page.waitForFunction(() => !!document.querySelector('.sheet .rt-title'));
    await page.waitForFunction(() => document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="5"]').length >= 2, null, { timeout: 8000 }).catch(() => {});
    check('import: 내 파일 경로 시트(조각마다 선, GPX 받기 없음)', (await page.locator('.rt-prov').textContent()).includes('내 파일') && (await bold(page)) === 2
      && (await page.locator('.rt-actions', { hasText: 'GPX 받기' }).count()) === 0);
    await openPlanner(page);
    await add(page, '분리 경로 · 시작 지점 (1)');
    await add(page, '분리 경로 · 끝 지점 (2)');
    check('import: 끊긴 조각 사이를 지어내 잇지 않음(내려받기 비활성)', (await page.locator('.planner-status').textContent()).includes('잇는 경로가 없습니다') && !(await exportBtn(page).isEnabled()),
      await page.locator('.planner-status').textContent());
    await page.getByRole('button', { name: '계획 초기화', exact: true }).click();
  });

  await step('planner layout', async () => {
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForTimeout(250);
        const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: innerWidth,
          wide: [...document.querySelectorAll('.route-planner *')].filter((n) => n.getBoundingClientRect().right > innerWidth + 1).length }));
        check(`layout ${theme} ${width}: 계획 도구 가로 넘침 없음`, o.sw <= o.vw && o.wide === 0, `${o.sw}/${o.vw} wide ${o.wide}`);
        await page.locator('.route-planner').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(SHOTS, `planner-${theme}-${width}.png`) });
      }
    }
  });
  await one.ctx.close();

  // =============== 2. 등산로망 실시간 조회 ON ===============
  await step('live trails', async () => {
    const live = await setup({ entry: ENTRY_NO_T2, prefs: { ...PREFS, liveTrails: true }, failRetry: false, label: 'live',
      osm: (q) => (/natural"="peak/.test(q) ? (live.connect ? osmJSON([[m.trails[2].trailhead, A], ...OSM_LINES]) : osmJSON(OSM_LINES)) : osmJSON(OSM_LINES)) });
    const p = live.page;
    await openMountain(p);
    const before = await pathsW(p, 2);
    await p.getByRole('button', { name: 'OSM 등산로 더 불러오기', exact: true }).click();
    await p.waitForFunction(() => /주변 등산로 \d+개|찾지 못했습니다|연결하지 못했습니다/.test(document.querySelector('#mt-panel-courses p[role=status]')?.textContent || ''));
    check('live: 주변 등산로를 불러와 지도에 얇게', (await p.locator('#mt-panel-courses p[role=status]').textContent()).includes('주변 등산로 6개') && (await pathsW(p, 2)) >= before + 6,
      `${before} → ${await pathsW(p, 2)}`);
    await p.locator('.mt-crow[data-key="t:0"] .mt-crow-link').click();
    await p.waitForFunction(() => !!document.querySelector('.sheet .rt-title'));
    await openPlanner(p);
    await loadAll(p);
    check('live: 계획에 수록 경로와 주변 등산로를 함께(조회는 한 번만)', (await p.locator('.planner-status').textContent()).includes('주변 등산로 6개') && live.stats.overpass === 1
      && (await p.locator('.planner-count').textContent()).startsWith('10개 경로'), `${await p.locator('.planner-count').textContent()} · overpass ${live.stats.overpass}`);
    await add(p, '오색-대청봉 코스 · 시작 지점');
    await add(p, '주변 등산로 4 · 끝 지점');
    check('live: 주변 등산로를 거쳐 계획', (await p.locator('.planner-summary').textContent()).includes('총') && await exportBtn(p).isEnabled());
    await p.getByRole('button', { name: '계획 초기화', exact: true }).click();

    // 선이 없는 등산로: [실시간으로 길 찾기]는 이어지지 않으면 직선을 지어내지 않는다
    await p.locator('.rt-back').click();
    await p.waitForFunction(() => !!document.querySelector('.sheet .mt-title') && !location.hash.includes('route='));
    await p.locator('.mt-crow[data-key="t:2"] .mt-crow-link').click();
    await p.waitForFunction(() => !!document.querySelector('.sheet .rt-title'));
    check('live: 선 없는 코스는 "지도 선 없음" + 들머리 점만', (await p.locator('.rt-prov').textContent()).includes('지도 선 없음') && (await bold(p)) === 0);
    const liveBtn = p.getByRole('button', { name: '실시간으로 길 찾기(느림)', exact: true });
    await liveBtn.click();
    await p.waitForFunction(() => /직선으로 대신 그리지 않습니다/.test(document.querySelector('.rt-body > p[role=status]')?.textContent || ''), null, { timeout: 15000 });
    check('live: 이어지지 않으면 직선 대체 없이 알림', (await bold(p)) === 0 && (await p.getByRole('button', { name: '다시 시도', exact: true }).isVisible()));
    live.connect = true;
    await p.getByRole('button', { name: '다시 시도', exact: true }).click();
    await p.waitForFunction(() => /방금 계산/.test(document.querySelector('.rt-provnote')?.textContent || ''), null, { timeout: 15000 });
    await p.waitForFunction(() => document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="5"]').length > 0, null, { timeout: 8000 }).catch(() => {});
    check('live: 이어지면 계산 경로(점선)로 그리고 출처 표시', (await p.locator('.rt-prov').textContent()).includes('계산 경로') && (await bold(p)) > 0
      && (await p.locator('.rt-body').textContent()).includes('© OpenStreetMap contributors'));
    await live.ctx.close();
  });

  // =============== 3. 모바일 · 등산로망 서버 실패 ===============
  await step('osm failure (mobile)', async () => {
    const off = await setup({ viewport: { width: 390, height: 844 }, mobile: true, prefs: { ...PREFS, liveTrails: true }, failRetry: false, failOSM: true, label: 'osm-fail' });
    const p = off.page;
    await openRoute(p, 't:0');
    await openPlanner(p);
    await loadAll(p);
    const st = await p.locator('.planner-status').textContent();
    check('offline: 등산로망 실패를 알리고 수록 경로로는 계획 가능', st.includes('주변 등산로 조회 실패') && (await p.locator('.planner-count').textContent()).startsWith('5개 경로'), st);
    await add(p, '오색-대청봉 코스 · 시작 지점');
    await add(p, '소공원-천불동-대청봉 코스 · 끝 지점');
    check('offline: 수록 경로만으로 내보낼 수 있는 계획', await exportBtn(p).isEnabled());
    await p.getByRole('button', { name: '계획 초기화', exact: true }).click();
    await p.getByRole('button', { name: '지도에서 지점 추가', exact: true }).click();
    await p.waitForTimeout(400);
    check('mobile: 지도에서 고르기 시작하면 시트를 낮춰 지도를 보여 줌', (await p.locator('.sheet').getAttribute('data-detent')) === 'peek');
    const pt = await p.evaluate(() => {
      const path = document.querySelector('#map .leaflet-overlay-pane path[stroke-width="5"]');
      const xy = path.getPointAtLength(path.getTotalLength() * 0.5).matrixTransform(path.getScreenCTM());
      return { x: xy.x, y: xy.y };
    });
    await p.touchscreen.tap(pt.x, pt.y);
    await p.waitForFunction(() => document.querySelectorAll('.planner-waypoints li').length === 1, null, { timeout: 5000 }).catch(() => {});
    check('mobile: 지도를 탭해 지점 추가', (await wps(p)) === 1);
    await p.getByRole('button', { name: '지점 선택 완료', exact: true }).click();
    await p.waitForTimeout(400);
    const back = await p.evaluate(() => {
      const r = document.querySelector('.route-planner').getBoundingClientRect(), body = document.querySelector('.sheet-body').getBoundingClientRect();
      return { detent: document.querySelector('.sheet').dataset.detent, visible: r.top < body.bottom - 40 && r.bottom > body.top && body.height > 80 };
    });
    check('mobile: [지점 선택 완료] 뒤 계획 도구가 다시 보임', back.visible, JSON.stringify(back));
    // [경로 표시 선택]은 본문에 있다 — 시트를 full로 올린 뒤 누르면 지도가 보이는 half로 내려온다.
    for (let i = 0; i < 3 && (await p.locator('.sheet').getAttribute('data-detent')) !== 'full'; i++) { await p.locator('.sheet-grabber').click(); await p.waitForTimeout(350); }
    await p.getByRole('button', { name: '경로 표시 선택', exact: true }).click();
    await p.waitForTimeout(400);
    check('mobile: [경로 표시 선택]은 시트를 half로', (await p.locator('.sheet').getAttribute('data-detent')) === 'half');
    await p.getByRole('button', { name: '계획 초기화', exact: true }).click();
    await off.ctx.close();
  });

  // =============== 4. 느린 등산로망: GPX 계획은 기다리지 않는다 ===============
  await step('slow osm', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = await setup({ viewport: { width: 390, height: 844 }, prefs: { ...PREFS, liveTrails: true }, failRetry: false, gateOSM: gate, label: 'slow-osm' });
    const p = slow.page;
    try {
      await openRoute(p, 't:0');
      await openPlanner(p);
      await loadBtn(p).click();
      await p.waitForFunction(() => document.querySelector('.planner-head button').disabled);
      await add(p, '오색-대청봉 코스 · 시작 지점');
      await add(p, '오색-대청봉 코스 · 끝 지점');
      check('slow: 등산로망을 기다리는 동안에도 고른 경로로 계획', await loadBtn(p).isDisabled() && await exportBtn(p).isEnabled());
      release();
      await p.waitForFunction(() => !document.querySelector('.planner-head button').disabled, null, { timeout: 15000 });
      check('slow: 늦게 온 자료가 고른 지점을 지우지 않음', (await wps(p)) === 2 && await exportBtn(p).isEnabled() && (await p.locator('.planner-count').textContent()).startsWith('11개 경로'),
        await p.locator('.planner-count').textContent());
      await p.getByRole('button', { name: '계획 초기화', exact: true }).click();
    } finally { release(); await slow.ctx.close(); }
  });

  // =============== 5. 불러오는 중에 떠나면 옛 계획 도구가 붙지 않음 ===============
  await step('leave while loading', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const late = await setup({ viewport: { width: 390, height: 844 }, prefs: { ...PREFS, liveTrails: true }, failRetry: false, gateGPX: gate, gateOSM: gate, label: 'leave' });
    const p = late.page;
    try {
      await openRoute(p, 't:0');
      await openPlanner(p);
      await loadBtn(p).click();
      const countText = await p.locator('.planner-count').textContent();
      await p.locator('.tb a[href="#/track"]').click();
      await p.waitForSelector('.pg-track');
      release();
      await p.waitForTimeout(800);
      // 지도 셸은 숨겨질 뿐 남아 있다 — 떠난 화면의 계획 도구가 늦은 자료로 갱신되거나 보이면 안 된다.
      const st = await p.evaluate(() => ({ visible: [...document.querySelectorAll('.route-planner')].some((n) => n.getClientRects().length),
        count: document.querySelector('.route-planner .planner-count')?.textContent ?? null }));
      check('leave: 떠난 뒤 도착한 자료가 옛 계획 도구를 갱신·표시하지 않음', !st.visible && (st.count === null || st.count === countText) && await p.locator('.pg-track').isVisible() && hashOf(p) === '#/track',
        JSON.stringify(st));
      await p.goBack();
      await p.waitForFunction(() => !!document.querySelector('.sheet .rt-title') && !!document.querySelector('.shell:not([hidden])'));
      check('leave: 돌아오면 새 경로 시트(계획 도구는 닫힌 상태)', !(await p.locator('.route-planner').isVisible()) && (await p.locator('.rt-title').textContent()) === '오색-대청봉 코스');
    } finally { release(); await late.ctx.close(); }
  });
} catch (e) {
  errors.push('fatal: ' + (e?.stack || e));
} finally {
  const uniq = [...new Map(errors.map((e) => [e, errors.filter((x) => x === e).length])).entries()].map(([e, n]) => (n > 1 ? `${e} ×${n}` : e));
  check('콘솔 오류·페이지 예외 없음', errors.length === 0, uniq.slice(0, 8).join(' | '));
  await browser.close();
  await close();
  process.exit(finish());
}

function hashOf(page) { return decodeURIComponent(new URL(page.url()).hash); }
