// 지도 우선 화면의 핵심 흐름 + 배포 자료 무결성 스모크 테스트.
// 사용: node scripts/smoke-test.mjs   (SMOKE_DIST=<빌드 폴더>, 기본 dist — 지도 검사는 OSM 빌드 기준)
// 바깥 요청(지도 타일·Overpass·open-meteo)은 모두 가로채 고정 응답을 주므로 네트워크와 무관하게 같은 결과가 나온다.
import { readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { filterMountains } from '../src/data.js';
import { ROOT, DIST, serve, launch, stubNetwork, watch, reporter, waitForShell } from './lib/ui-harness.mjs';

const SHOTS = process.env.SHOT_DIR || join(ROOT, 'shots');
const VIEW = { width: 390, height: 844 };
const { check, step, finish } = reporter('smoke');
const errors = [];
const { base, close } = await serve();
const browser = await launch();
console.log('serving', DIST, 'on', base);

/** 굵은 선택 경로(경로 시트의 선, stroke-width 5) 개수. 미리보기 선은 3, 겹쳐 보기는 4. */
const boldPaths = (page) => page.evaluate(() => document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="5"]').length);
/** 로드된 타일 z/x/y로 지금 지도 범위를 구한다(지도가 실제로 움직였는지 확인용). */
const mapViewport = (page) => page.evaluate(() => {
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
  return { z, west: lon(Math.min(...xs)), east: lon(Math.max(...xs) + 1), north: lat(Math.min(...ys)), south: lat(Math.max(...ys) + 1) };
});
const hashOf = (page) => decodeURIComponent(new URL(page.url()).hash);
/** 시트 내용이 바뀔 때까지(라우팅은 비동기) 기다린다. */
const waitList = (page) => page.waitForFunction(() => document.querySelector('.sheet .sheet-title')?.textContent === '명산' && !location.hash.startsWith('#/m/'));
const waitMountain = (page, name) => page.waitForFunction((n) => document.querySelector('.sheet .mt-title .mt-name')?.textContent === n && !location.hash.includes('route='), name);
const waitRoute = (page) => page.waitForFunction(() => location.hash.includes('route=') && !!document.querySelector('.sheet .rt-title'));

try {
  await mkdir(SHOTS, { recursive: true });
  const { mountains } = JSON.parse(await readFile(join(DIST, 'data/mountains.json'), 'utf8'));
  const byId = new Map(mountains.map((m) => [m.id, m]));

  // dist가 소스보다 오래됐으면 이 테스트는 "지금 코드"가 아니라 옛 빌드를 검사하는 셈이다.
  // 통과해도 의미가 없고 실패해도 원인을 엉뚱한 데서 찾게 되므로 먼저 걸러 낸다.
  await step('build', async () => {
    const newestMtime = async (dir) => {
      let newest = 0;
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        newest = Math.max(newest, e.isDirectory() ? await newestMtime(p) : (await stat(p)).mtimeMs);
      }
      return newest;
    };
    const srcAt = Math.max(await newestMtime(join(ROOT, 'src')), await newestMtime(join(ROOT, 'public')), (await stat(join(ROOT, 'index.html'))).mtimeMs);
    const distAt = existsSync(join(DIST, 'index.html')) ? (await stat(join(DIST, 'index.html'))).mtimeMs : 0;
    check('build: dist가 소스보다 최신 (아니면 옛 빌드를 검사하게 됨)', distAt >= srcAt,
      distAt ? `dist ${new Date(distAt).toISOString().slice(0, 19)} vs src ${new Date(srcAt).toISOString().slice(0, 19)}` : 'dist 없음');
  });

  const ctx = await browser.newContext({ viewport: VIEW, isMobile: true, hasTouch: true });
  const net = await stubNetwork(ctx);
  const page = watch(await ctx.newPage(), errors, { label: 'main' });

  // ---------- 첫 화면 = 지도 ----------
  await step('first screen', async () => {
    await page.goto(base + '/#/');
    await waitForShell(page);
    // 넓은 범위에서는 겹치는 기호를 숫자 묶음(.mk-cluster)으로 그린다 — 낱개 + 묶음 숫자 = 산 수.
    const represented = () => page.evaluate(() => document.querySelectorAll('#map .mk').length
      + [...document.querySelectorAll('#map .mk-cluster')].reduce((a, n) => a + Number(n.textContent), 0));
    await page.waitForFunction((n) => document.querySelectorAll('#map .mk').length
      + [...document.querySelectorAll('#map .mk-cluster')].reduce((a, c) => a + Number(c.textContent), 0) === n, mountains.length, { timeout: 10000 }).catch(() => {});
    const g = await page.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const map = r('#map'), tb = r('.tb'), sheet = r('.sheet');
      return { map: map && { top: map.top, bottom: map.bottom, w: map.width, h: map.height }, tbBottom: tb?.bottom, sheetTop: sheet?.top, vw: innerWidth, vh: innerHeight,
        detent: document.querySelector('.sheet')?.dataset.detent, scrollW: document.documentElement.scrollWidth };
    });
    check('first: 지도 요소가 화면을 채움', await page.locator('#map').isVisible() && g.map.w >= g.vw - 1 && g.map.top <= 0, JSON.stringify(g.map));
    const free = (Math.min(g.sheetTop, g.map.bottom) - g.tbBottom) / g.vh;
    check('first: 상단 바·시트(peek)에 가리지 않은 지도 ≥ 70%', free >= 0.7, `${Math.round(free * 100)}% (상단 바 ${Math.round(g.tbBottom)}px, 시트 ${Math.round(g.vh - g.sheetTop)}px)`);
    check('first: 시트는 peek에서 시작', g.detent === 'peek', g.detent);
    check('first: 가로 스크롤 없음', g.scrollW <= g.vw, `${g.scrollW}px`);
    const mk = await represented();
    const clusters = await page.locator('#map .mk-cluster').count();
    check('first: 산 기호 149곳(낱개 + 묶음 숫자)', mk === mountains.length && mountains.length === 149, `${mk}곳 · 낱개 ${await page.locator('#map .mk').count()} · 묶음 ${clusters}`);
    if (clusters) {
      const label = await page.locator('#map .mk-cluster').first().getAttribute('aria-label');
      check('first: 묶음 기호는 개수와 동작을 알림', /^산 \d+곳.*눌러서 확대/.test(label || ''), label);
    }
    check('first: 지도 타일(가로챈 응답)이 로드됨', (await page.locator('#map img.leaflet-tile').count()) > 0 && net.tiles.length > 0, `${net.tiles.length} tile requests`);
    check('first: 목록 시트 제목·개수', (await page.locator('.sheet .sheet-title').textContent()) === '명산'
      && (await page.locator('.sheet-count').textContent()) === `${mountains.length}곳`, await page.locator('.sheet-count').textContent());
    check('first: 목록 행 149개', (await page.locator('.sheet .rows a.row').count()) === mountains.length);
    check('first: 저작권 표시가 시트 위에 보임', await page.locator('.leaflet-control-attribution').isVisible()
      && (await page.locator('.leaflet-control-attribution').boundingBox()).y + 10 < g.sheetTop);
    await page.screenshot({ path: join(SHOTS, 'map-first.png') });
  });

  // ---------- 검색: 묶음 제안 → 산 시트 ----------
  await step('search', async () => {
    await page.locator('.tb-input').fill('설악');
    await page.waitForSelector('.suggest:not([hidden]) .suggest-item');
    const groups = await page.locator('.suggest .suggest-group').allTextContents();
    check('search: 제안이 명산/코스 묶음으로', groups[0] === '명산' && groups.includes('코스'), groups.join(' | '));
    const firstName = await page.locator('.suggest .suggest-item .si-name').first().textContent();
    check('search: 첫 명산 제안 = 설악산', firstName.startsWith('설악산'), firstName);
    const courseMetas = await page.evaluate(() => {
      const out = []; let g = '';
      for (const n of document.querySelectorAll('.suggest > *')) {
        if (n.classList.contains('suggest-group')) g = n.textContent;
        else if (g === '코스') out.push(n.querySelector('.si-meta')?.textContent || '');
      }
      return out;
    });
    check('search: 코스 제안에 소속 산 표시', courseMetas.length > 0 && courseMetas.every((t) => t.includes('설악산')), courseMetas.join(' | '));
    const want = filterMountains(mountains, { q: '설악' }).length;
    check('search: 입력하면 목록도 좁혀짐', (await page.locator('.sheet-count').textContent()) === `${want}곳` && hashOf(page).includes('q=설악'),
      `${await page.locator('.sheet-count').textContent()} / 기대 ${want}곳`);
    await page.locator('.suggest .suggest-item').first().click();
    await page.waitForFunction(() => location.hash.startsWith('#/m/seolaksan'));
    await page.waitForSelector('.mt-title .mt-name');
    check('search: 고르면 산 시트(제목)', (await page.locator('.mt-title .mt-name').textContent()) === '설악산' && hashOf(page) === '#/m/seolaksan', hashOf(page));
    check('search: 문서 제목도 그 산', (await page.title()).includes('설악산'), await page.title());
    check('search: 지도 기호가 선택 표시', (await page.locator('#map .mk.selected').getAttribute('data-id')) === 'seolaksan');
    await page.waitForTimeout(1500);   // flyTo 0.6초 + 타일
    const vp = await mapViewport(page);
    const s = byId.get('seolaksan');
    check('search: 지도가 그 산으로 이동', vp && s.lat > vp.south && s.lat < vp.north && s.lon > vp.west && s.lon < vp.east && vp.z >= 11, JSON.stringify(vp));
    const mk = await page.locator('#map .mk.selected').boundingBox();
    const band = await page.evaluate(() => [document.querySelector('.tb').getBoundingClientRect().bottom, document.querySelector('.sheet').getBoundingClientRect().top]);
    check('search: 선택한 산이 가려지지 않은 지도 영역 안에', mk && mk.y + mk.height / 2 > band[0] && mk.y + mk.height / 2 < band[1], `y=${mk && Math.round(mk.y)} 영역 ${band.map(Math.round)}`);
    await page.screenshot({ path: join(SHOTS, 'mountain-sheet.png') });
  });

  // ---------- 산 시트 ----------
  const s = byId.get('seolaksan');
  await step('mountain sheet', async () => {
    const tabs = await page.getByRole('tab').allTextContents();
    check('mountain: 코스·주변 길·정보 탭', tabs.length === 3 && /코스/.test(tabs[0]) && /주변 길/.test(tabs[1]) && /정보/.test(tabs[2]), tabs.join(' | '));
    check('mountain: 코스 탭이 기본 선택', (await page.getByRole('tab', { selected: true }).textContent()).startsWith('코스'));
    await page.waitForSelector('#mt-panel-courses .mt-crow');
    const rows = await page.locator('#mt-panel-courses .rows').first().locator('.mt-crow').count();
    const unlinked = s.famous_courses.filter((c) => c.trail_index == null).length;
    check('mountain: 등산로 행 + 연결 없는 대표 코스 행', rows === s.trails.length + unlinked, `${rows}행 (등산로 ${s.trails.length} + 대표 코스 ${unlinked})`);
    const honesty = await page.locator('#mt-panel-courses .mt-crow-honesty').first().textContent();
    check('mountain: 행에 선 상태(계산 경로) 표시', /계산 경로|수록 경로|지도 선 없음/.test(honesty), honesty);
    check('mountain: 정상 라벨이 지도에', /정상/.test(await page.locator('#map .map-label.summit').first().textContent().catch(() => '')));
    await page.getByRole('tab', { name: /정보/ }).click();
    const overview = await page.locator('#mt-panel-info .mt-sec').filter({ has: page.locator('h3', { hasText: /^개요$/ }) }).locator('.mt-prose').first().textContent();
    check('mountain: 정보 탭 개요', overview.length > 30, `${overview.length}자`);
    check('mountain: 탭이 주소에 기록됨', hashOf(page) === '#/m/seolaksan?tab=info', hashOf(page));
    await page.getByRole('tab', { name: /코스/ }).click();
    check('mountain: 코스 탭으로 돌아오면 주소 정리', hashOf(page) === '#/m/seolaksan', hashOf(page));
  });

  // ---------- 코스 행 → 경로 시트(선 그리기) ----------
  await step('route sheet', async () => {
    check('route: 고르기 전에는 굵은 선택 선 없음', (await boldPaths(page)) === 0);
    const firstRow = page.locator('#mt-panel-courses .mt-crow-link').first();
    const rowName = (await firstRow.locator('.row-title').textContent()).trim();
    await firstRow.click();
    await page.waitForFunction(() => location.hash.includes('route='));
    await page.waitForSelector('.rt-title');
    check('route: 코스 행 → 경로 시트', hashOf(page) === '#/m/seolaksan?route=t:0' && (await page.locator('.rt-title').textContent()) === rowName, `${hashOf(page)} · ${rowName}`);
    await page.waitForFunction(() => document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="5"]').length > 0, null, { timeout: 15000 }).catch(() => {});
    const bold = await boldPaths(page);
    check('route: 지도에 선택 선이 그려짐(선 개수 증가)', bold > 0, `굵은 선 ${bold}개`);
    const dashed = await page.evaluate(() => [...document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="5"]')].some((p) => p.getAttribute('stroke-dasharray')));
    check('route: 계산 경로는 점선', dashed);
    const prov = await page.locator('.rt-prov').textContent();
    check('route: 생성 방식 표시 "계산 경로"', prov.includes('계산 경로'), prov);
    check('route: 실측 기록 아님 고지', (await page.locator('.rt-provnote').textContent()).includes('실측 기록 아님'));
    check('route: OpenStreetMap 출처 표기', (await page.locator('.rt-body').textContent()).includes('© OpenStreetMap contributors'));
    check('route: 들머리 라벨이 지도에', (await page.locator('#map .map-label.trailhead').count()) >= 1);
    await page.waitForSelector('.rt-chart .pc', { timeout: 10000 }).catch(() => {});
    check('route: 고도 단면', (await page.locator('.rt-chart .mt-sec-h').textContent().catch(() => '')) === '고도 단면');
    check('route: 시트는 peek에서 열림', (await page.locator('.sheet').getAttribute('data-detent')) === 'peek');

    // GPX 받기 — 링크가 실제 파일이고, 파일에 "실측 아님"과 출처가 새겨져 있어야 한다.
    const gpx = page.locator('.rt-actions a[download]');
    check('route: GPX 받기 링크', (await gpx.count()) === 1 && (await gpx.textContent()).includes('GPX 받기'));
    const href = await gpx.getAttribute('href');
    const body = await (await page.request.get(new URL(href, base + '/').toString())).text();
    check('route: GPX 링크가 실제 GPX 파일을 반환', body.startsWith('<?xml') && body.includes('<trkpt'), href);
    check('route: GPX 파일에 실측 아님·생성 방식·출처 각인', body.includes('not_a_recorded_track') && body.includes('osm-routed') && body.includes('OpenStreetMap'));

    // 들머리 길찾기: 좌표 신뢰도 high면 들머리 좌표, 정상으로 자동차 안내는 하지 않는다.
    await page.getByRole('button', { name: '들머리 길찾기', exact: true }).click();
    await page.waitForSelector('dialog.modal[open] .mt-linkrow');
    const car = await page.locator('dialog.modal .mt-linkrow', { hasText: '자동차 경로' }).getAttribute('href');
    const th = s.trails[0].trailhead;
    check('route: 길찾기 목적지 = 확인된 들머리(정상 아님)', car.includes(`destination=${th[0]},${th[1]}`) && !car.includes(String(s.lat)), car);
    const transit = await page.locator('dialog.modal .mt-linkrow', { hasText: '대중교통 경로' }).getAttribute('href');
    check('route: 대중교통 경로 모드', transit.includes('travelmode=transit'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.modal', { state: 'detached' });
    check('route: 모달의 Esc는 모달만 닫음', hashOf(page) === '#/m/seolaksan?route=t:0');
    await page.screenshot({ path: join(SHOTS, 'route-sheet.png') });
  });

  // ---------- Esc·닫기·뒤로가기: 한 단계씩 ----------
  await step('escape and back', async () => {
    await page.locator('.rt-title').focus();
    await page.keyboard.press('Escape');
    await waitMountain(page, '설악산');
    check('esc: 경로 → 산 시트', hashOf(page) === '#/m/seolaksan' && (await page.locator('.mt-title .mt-name').textContent()) === '설악산');
    check('esc: 고른 경로가 "선택한 경로" 줄로 남음', await page.locator('.mt-selbar').isVisible() && (await page.locator('.mt-selbar').textContent()).includes('오색'));
    check('esc: 산 시트로 돌아와도 선은 남음', (await boldPaths(page)) > 0);
    await page.keyboard.press('Escape');
    await waitList(page);
    check('esc: 산 시트 → 목록', (await page.locator('.sheet .sheet-title').textContent()) === '명산', hashOf(page));
    check('esc: 제안을 고르면 입력 중 좁힌 목록 검색어는 되돌림', !hashOf(page).includes('q=') && (await page.locator('.sheet-count').textContent()) === `${mountains.length}곳`, hashOf(page));
    await page.goForward();
    await waitMountain(page, '설악산');
    check('back: 앞으로 가기 → 산 시트', hashOf(page) === '#/m/seolaksan');
    await page.goForward();
    await waitRoute(page);
    check('back: 앞으로 가기 → 경로 시트', (await page.locator('.rt-title').textContent()).includes('오색'));
    await page.goBack();
    await waitMountain(page, '설악산');
    check('back: 브라우저 뒤로 → 산 시트', hashOf(page) === '#/m/seolaksan');
    await page.locator('.mt-head-actions').getByRole('button', { name: '닫고 목록으로', exact: true }).click();
    await waitList(page);
    check('close: [×] → 목록', (await page.locator('.sheet .sheet-title').textContent()) === '명산', hashOf(page));

    // 링크로 바로 들어온 경로 시트: [‹ 산]·[×]는 기록을 쌓지 않고 상위 화면으로 바꾼다.
    await page.goto(base + '/#/m/seolaksan?route=t:2');
    await page.reload();          // 링크로 바로 들어온 상태(앱 안 기록 깊이 0)
    await waitRoute(page);
    const len = await page.evaluate(() => history.length);
    await page.locator('.rt-back').click();
    await waitMountain(page, '설악산');
    check('direct: [‹ 설악산] → 산 시트(기록 교체)', (await page.evaluate(() => history.length)) === len && hashOf(page) === '#/m/seolaksan',
      `history ${len} → ${await page.evaluate(() => history.length)}`);
    await page.goto(base + '/#/m/seolaksan?route=t:2');
    await page.reload();
    await waitRoute(page);
    await page.locator('.rt-top').getByRole('button', { name: '닫고 목록으로', exact: true }).click();
    await waitList(page);
    check('direct: [×] → 목록', (await page.locator('.sheet .sheet-title').textContent()) === '명산', hashOf(page));
  });

  // ---------- 등정 기록 ----------
  await step('hike record', async () => {
    await page.goto(base + '/#/m/seolaksan');
    await page.waitForSelector('.mt-hike');
    await page.locator('.mt-hike').click();
    await page.waitForSelector('dialog.record-dialog[open]');
    await page.getByRole('button', { name: '기록 저장', exact: true }).click();
    await page.waitForSelector('dialog.record-dialog', { state: 'detached' });
    check('hike: 등정 버튼이 켜짐', (await page.locator('.mt-hike').getAttribute('aria-pressed')) === 'true' && (await page.locator('.mt-hike').textContent()).includes('등정'));
    check('hike: 지도 기호가 등정(▲)으로', (await page.locator('#map .mk.hiked[data-id="seolaksan"]').count()) === 1);
    await page.keyboard.press('Escape');
    await waitList(page);
    const hikedLink = page.locator('.sheet-head a.sheet-sub-link[href="#/track"]');
    check('hike: 목록 헤더 "등정 1" → 기록 링크', (await hikedLink.textContent()).includes('등정 1') && await hikedLink.isVisible());
  });

  // ---------- 내 기록: 추가·수정·삭제 ----------
  await step('records page', async () => {
    await page.locator('.tb a[href="#/track"]').click();
    await page.waitForSelector('.pg-track .rec-row');
    check('records: 기록 버튼 → 내 기록', hashOf(page) === '#/track' && (await page.locator('.pg-title').textContent()) === '내 기록');
    check('records: 지도 셸은 숨김', !(await page.locator('.shell').isVisible()));
    check('records: 등정 수 반영', (await page.locator('.rec-num').textContent()) === `1 / ${mountains.length}`, await page.locator('.rec-num').textContent());
    await page.getByRole('button', { name: '다녀온 산 검색해서 기록 추가', exact: true }).click();
    const picker = page.getByRole('combobox', { name: '기록할 산 검색' });
    await picker.fill('한라');
    await picker.press('ArrowDown');
    await picker.press('Enter');
    await page.waitForSelector('dialog.record-dialog[open]');
    await page.getByLabel('산행일', { exact: true }).fill('2024-06-01');
    await page.getByRole('button', { name: '기록 저장', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.rec-rows .rec-row').length === 2);
    check('records: 검색해서 추가', (await page.locator('.rec-rows .rec-row').count()) === 2 && (await page.locator('.rec-rows').textContent()).includes('2024-06-01'));
    check('records: 저장 알림', (await page.locator('.record-toast').textContent()).includes('2024-06-01'));
    await page.getByRole('button', { name: '한라산 산행일 수정', exact: true }).click();
    await page.getByLabel('산행일', { exact: true }).fill('2024-06-02');
    await page.getByRole('button', { name: '기록 저장', exact: true }).click();
    await page.waitForSelector('dialog.record-dialog', { state: 'detached' });
    const halla = page.locator('.rec-row', { hasText: '한라산' });
    check('records: 날짜 수정', (await halla.textContent()).includes('2024-06-02'));
    await page.getByRole('button', { name: '한라산 기록 삭제', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.rec-rows .rec-row').length === 1);
    check('records: 삭제', (await page.locator('.rec-rows .rec-row').count()) === 1);
    await page.locator('.record-toast').getByRole('button', { name: '실행 취소', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.rec-rows .rec-row').length === 2);
    check('records: 실행 취소로 되살림(수정한 날짜 유지)', (await page.locator('.rec-row', { hasText: '한라산' }).textContent()).includes('2024-06-02'));
    await page.getByRole('button', { name: '한라산 기록 삭제', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.rec-rows .rec-row').length === 1);
    await page.reload();
    await page.waitForSelector('.pg-track .rec-row');
    check('records: 새로고침 후에도 유지', (await page.locator('.rec-rows .rec-row').count()) === 1
      && (await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('kr100:hiked'))).join())) === 'seolaksan');
    await page.screenshot({ path: join(SHOTS, 'records.png'), fullPage: true });
  });

  // ---------- 설정: 즉시 반영 + 새로고침 후 유지 ----------
  await step('settings', async () => {
    await page.goto(base + '/#/settings');
    const planner = page.getByRole('switch', { name: '경로 계획 만들기' });
    const zoom = page.getByRole('switch', { name: '확대·축소 버튼' });
    await planner.waitFor();
    check('settings: 경로 계획 기본 OFF, 확대 버튼 기본 ON', !(await planner.isChecked()) && await zoom.isChecked());
    await planner.click();
    await zoom.click();
    check('settings: 바꾸면 바로 저장', await page.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr100:prefs') || '{}'); return v.routePlanner === true && v.zoomButtons === false; }));
    await page.reload();
    await planner.waitFor();
    check('settings: 새로고침 후에도 유지', await planner.isChecked() && !(await zoom.isChecked()));
    await page.locator('.pg-back').click();
    await page.waitForSelector('.sheet .sheet-title');
    check('settings: 확대·축소 버튼이 숨겨짐', !(await page.getByRole('button', { name: '확대', exact: true }).isVisible()) && !(await page.getByRole('button', { name: '축소', exact: true }).isVisible()));
    check('settings: 레이어·내 위치 버튼은 그대로', await page.getByRole('button', { name: '지도 레이어', exact: true }).isVisible() && await page.getByRole('button', { name: '내 위치', exact: true }).isVisible());
    await page.goto(base + '/#/m/seolaksan?route=t:0');
    await page.waitForSelector('.rt-title');
    await page.getByRole('button', { name: '이 길로 계획', exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    check('settings: 경로 계획 ON → 경로 시트에 입구', await page.getByRole('button', { name: '이 길로 계획', exact: true }).isVisible());
    await page.reload();
    await page.waitForSelector('.rt-title');
    await page.getByRole('button', { name: '이 길로 계획', exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    check('settings: 새로고침한 경로 시트에도 입구 유지', await page.getByRole('button', { name: '이 길로 계획', exact: true }).isVisible()
      && !(await page.getByRole('button', { name: '확대', exact: true }).isVisible()));
    await page.goto(base + '/#/settings');
    await planner.waitFor();
    await planner.click();
    await zoom.click();
    await page.goto(base + '/#/m/seolaksan?route=t:0');
    await page.waitForSelector('.rt-title');
    await page.waitForFunction(() => document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="5"]').length > 0, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
    check('settings: 끄면 입구가 사라짐(OFF 도구 입구 없음)', (await page.getByRole('button', { name: '이 길로 계획', exact: true }).count()) === 0
      && await page.getByRole('button', { name: '확대', exact: true }).isVisible());
    check('settings: 기본값으로 돌리면 저장 항목 없음', await page.evaluate(() => localStorage.getItem('kr100:prefs') === null));
  });

  // ---------- 탐방 후기 · 현장 정보 ----------
  await step('reviews', async () => {
    const rv = await (await page.request.get(base + '/data/reviews/index.json')).json();
    check('reviews: 매니페스트', rv.schema_version === 1, `산 ${rv.stats?.mountains} · 항목 ${rv.stats?.notes}`);
    check('reviews: 원문 후기가 아님을 명시', /그대로 옮긴 것이 아니/.test(rv.what_this_is || ''));
    check('reviews: 검증 방법 기록', /반박/.test(rv.method || '') && /verified/.test(rv.method || ''));
    const sample = rv.mountains?.find((e) => e.notes > 0);
    check('reviews: 수집된 후기 존재', !!sample);
    if (!sample) return;
    const detail = await (await page.request.get(`${base}/data/reviews/${sample.id}.json`)).json();
    check('reviews: 산별 상세 파일', detail.notes?.length > 0, `${sample.id} ${detail.notes?.length}건`);
    const bad = detail.notes.filter((n) => !n.sources?.length || /�/.test(n.text));
    check('reviews: 모든 항목에 출처 URL · 인코딩 정상', bad.length === 0, `${bad.length}건 문제`);
    check('reviews: 출처가 http(s) URL', detail.notes.every((n) => n.sources.every((u) => /^https?:\/\//.test(u))));
    // 모든 산의 후기 파일도 깨진 글자·출처 없는 항목이 없어야 한다.
    const files = (await readdir(join(ROOT, 'public/data/reviews'))).filter((f) => f.endsWith('.json') && f !== 'index.json');
    let broken = 0, noSrc = 0;
    for (const f of files) {
      const text = await readFile(join(ROOT, 'public/data/reviews', f), 'utf8');
      if (text.includes('�')) broken++;
      for (const n of JSON.parse(text).notes || []) if (!n.sources?.length || !n.sources.every((u) => /^https?:\/\//.test(u))) noSrc++;
    }
    check('reviews: 전체 후기 파일 인코딩·출처', broken === 0 && noSrc === 0, `파일 ${files.length} · 깨짐 ${broken} · 출처 문제 ${noSrc}`);

    await page.goto(`${base}/#/m/${sample.id}?tab=info`);
    await page.waitForSelector('#mt-panel-info .mt-note', { timeout: 15000 });
    const shown = await page.locator('#mt-panel-info .mt-note').count();
    check('reviews: 정보 탭 현장 정보 렌더', shown === detail.notes.length, `${shown}건 / ${detail.notes.length}건`);
    const sec = await page.locator(`#mt-notes-${sample.id}`).textContent();
    check('reviews: 원문 인용 아님 고지', /원문 인용 아님/.test(sec));
    check('reviews: 검증 수준 표시', /교차검증|단일 확인/.test(sec));
    const rel = await page.locator(`#mt-notes-${sample.id} .mt-note-src a`).evaluateAll((n) => n.map((a) => a.getAttribute('rel') || ''));
    check('reviews: 출처 링크가 noopener·nofollow', rel.length > 0 && rel.every((r) => /noopener/.test(r) && /nofollow/.test(r)), `${rel.length} links`);
  });

  // ---------- 배포 자료 무결성(코스별 계산 경로) ----------
  await step('gpx routes', async () => {
    const man = JSON.parse(await readFile(join(ROOT, 'public/gpx/routes/index.json'), 'utf8'));
    check('gpx: routes 매니페스트', man.schema_version === 1, `산 ${man.stats.mountains} · 파일 ${man.stats.routed_files}`);
    check('gpx: 매니페스트가 실측 아님을 명시', /실측/.test(man.what_this_is || ''));
    check('gpx: 출처·라이선스 기록', man.sources?.some((x) => /ODbL/.test(x.license || '')));
    const served = await page.request.get(base + '/gpx/routes/index.json');
    check('gpx: 빌드에도 매니페스트 포함', served.ok());
    const listed = man.mountains.filter((e) => e.tracks > 0);
    let missing = 0, badKind = 0, files = 0;
    for (const e of listed) {
      const p = join(ROOT, 'public/gpx/routes/m', `${e.mountain_id}.json`);
      if (!existsSync(p)) { missing++; continue; }
      const entry = JSON.parse(await readFile(p, 'utf8'));
      for (const t of entry.tracks || []) { files++; if (t.kind !== 'osm-routed' || !existsSync(join(ROOT, 'public/gpx', t.file))) badKind++; }
    }
    check('gpx: 산별 상세 파일이 모두 있고 트랙은 계산 경로(osm-routed)·파일 존재', missing === 0 && badKind === 0 && files > 0, `산 ${listed.length} · 트랙 ${files} · 누락 ${missing} · 문제 ${badKind}`);
    // 깨진 글자(U+FFFD)는 어느 자료에도 없어야 한다.
    const scan = [join(ROOT, 'public/data/mountains.json'), join(ROOT, 'public/gpx/routes/index.json'),
      ...(await readdir(join(ROOT, 'public/gpx/routes/m'))).map((f) => join(ROOT, 'public/gpx/routes/m', f))];
    const withFffd = [];
    for (const f of scan) if ((await readFile(f, 'utf8')).includes('�')) withFffd.push(f.replace(ROOT + '/', ''));
    check('data: mountains.json·경로 매니페스트에 U+FFFD 없음', withFffd.length === 0, withFffd.slice(0, 5).join(', ') || `${scan.length} files`);
  });

  // ---------- 위치 권한이 없을 때: 자동 측정·프롬프트 없음 ----------
  await step('no location', async () => {
    const denyCtx = await browser.newContext({ viewport: VIEW });
    await stubNetwork(denyCtx);
    const p = watch(await denyCtx.newPage(), errors, { label: 'no-location' });
    await p.goto(base + '/#/map?sort=near');
    await waitForShell(p);
    await p.waitForTimeout(500);
    check('near: 권한이 없으면 가까운 순을 켜지 않고 안내만', (await p.locator('.sheet .chip', { hasText: '가까운 순' }).getAttribute('aria-pressed')) === 'false'
      && (await p.locator('.sheet-note').textContent()).includes('가까운 순'));
    check('near: 위치를 자동으로 재지 않음', (await p.evaluate(() => localStorage.getItem('kr100:pos'))) === null);
    await denyCtx.close();
  });

  check('network: 테스트가 모르는 외부 요청 없음', net.blocked.length === 0, net.blocked.slice(0, 3).join(' '));
  await ctx.close();
} catch (e) {
  errors.push('fatal: ' + (e?.stack || e));
} finally {
  const uniq = [...new Map(errors.map((e) => [e, errors.filter((x) => x === e).length])).entries()].map(([e, n]) => (n > 1 ? `${e} ×${n}` : e));
  check('콘솔 오류·페이지 예외 없음', errors.length === 0, uniq.slice(0, 8).join(' | '));
  console.log('screenshots in', SHOTS);
  await browser.close();
  await close();
  process.exit(finish());
}
