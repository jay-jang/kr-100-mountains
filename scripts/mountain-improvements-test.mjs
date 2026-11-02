// 요청한 개선의 회귀 검사: 전체 GPX·사진 자료, 실제 사진/대체 안내, 목록 복원과 지도 이름.
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { haversine } from './lib/geo.mjs';
import { ROOT, DIST, serve, launch, stubNetwork, watch, reporter, waitForShell } from './lib/ui-harness.mjs';

const { check, step, finish } = reporter('mountain improvements');
const json = async p => JSON.parse(await readFile(join(DIST, p), 'utf8'));
const { mountains } = await json('data/mountains.json');
const errors = [];
const { base, close } = await serve();
const browser = await launch();
try {
  await step('all route files', async () => {
    const index = await json('gpx/routes/index.json');
    const catalog = new Map(index.mountains.map(m => [m.mountain_id, m]));
    const files = new Set(), bad = [], geometry = new Set();
    let tracks = 0;
    for (const m of mountains) {
      if (!catalog.has(m.id)) { bad.push(`${m.id}: no routes`); continue; }
      const entry = await json(`gpx/routes/m/${m.id}.json`);
      if (!entry.tracks?.length) bad.push(`${m.id}: no summit route`);
      for (const t of entry.tracks || []) {
        tracks++;
        const xml = await readFile(join(DIST, 'gpx', t.file), 'utf8');
        const points = [...xml.matchAll(/<trkpt lat="([^"]+)" lon="([^"]+)"/g)].map(p => [+p[1], +p[2]]);
        if (points.length < 2 || points.some(([lat, lon]) => lat < 33 || lat > 38.8 || lon < 124.5 || lon > 131.9)) bad.push(`${t.file}: points`);
        if (!xml.includes('<k100:not_a_recorded_track>true') || !xml.includes('<k100:provenance>osm-routed')) bad.push(`${t.file}: provenance`);
        if (m.trails[t.route_index - 1]?.name !== t.route_name) bad.push(`${t.file}: wrong course`);
        const gap = Math.min(...points.map(p => haversine(m.lat, m.lon, ...p)));
        if (gap > 750) bad.push(`${t.file}: summit gap ${Math.round(gap)}m`);
        files.add(t.file); geometry.add(points.map(p => p.join(',')).join(';'));
      }
    }
    check('GPX: 149개 산 모두 실제 정상 경로 파일·코스 연결·출처·좌표 확인', mountains.length === 149 && bad.length === 0, bad.join(' | ') || `${tracks}개 경로 확인`);
    check('GPX: 중복을 제외해도 기존 681개보다 많은 계산 경로', files.size === index.stats.routed_files && geometry.size > 681, `파일 ${files.size} · 서로 다른 선 ${geometry.size}`);
    const officialIndex = await json('gpx/courses/index.json');
    const official = new Map();
    for (const id of Object.keys(officialIndex.mountains)) {
      for (const c of (await json(`gpx/courses/m/${id}.json`)).courses) official.set(c.file, c);
    }
    for (const [file] of official) {
      const xml = await readFile(join(DIST, 'gpx', file), 'utf8');
      if (!xml.includes('<trkpt') || !xml.includes('<k100:provenance>osm-matched') || !xml.includes('not_a_recorded_track')) bad.push(file);
    }
    check('GPX: 공식 코스 205개 선의 실제 파일·생성 방식 확인', official.size === 205 && bad.length === 0, `${official.size}개`);
  });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const net = await stubNetwork(ctx);
  const page = watch(await ctx.newPage(), errors);
  const waitList = () => page.waitForFunction(() => document.querySelector('.sheet-title')?.textContent === '명산');
  const waitMountain = () => page.waitForSelector('.mt-media');
  const currentHash = () => new URL(page.url()).hash;

  await step('filter persistence', async () => {
    const wanted = '#/map?region=%EA%B0%95%EC%9B%90&list=sanlim&easy=1&hours=4&distance=10';
    await page.goto(base + '/' + wanted);
    await waitForShell(page);
    await page.locator('.sheet-grabber').click();
    await page.waitForTimeout(350);
    const original = currentHash();
    const ids = await page.locator('.rows a.row').evaluateAll(nodes => nodes.map(n => n.dataset.id));
    const pick = ids[0];
    await page.locator(`.rows a.row[data-id="${pick}"]`).click();
    await waitMountain();
    await page.reload();
    await waitMountain();
    check('filters: 산 상세 새로고침 후 필터 칩 개수 유지', await page.locator('.tb-chips .chip.on').textContent() === '필터 5');
    // 새 문서로 들어온 상세 링크처럼 앱 내부 뒤로 기록이 없는 경우도 검증.
    await page.evaluate(() => history.replaceState({}, '', location.href));
    await page.getByRole('button', { name: '닫고 목록으로', exact: true }).click();
    await waitList();
    check('filters: 상세 새로고침·직접 진입 후 닫기에도 모든 조건·결과 유지', currentHash() === original && JSON.stringify(await page.locator('.rows a.row').evaluateAll(n => n.map(e => e.dataset.id))) === JSON.stringify(ids));
    await page.locator(`.rows a.row[data-id="${pick}"]`).click();
    await waitMountain();
    await page.reload(); await waitMountain();
    await page.getByRole('button', { name: '명산', exact: true }).click();
    await waitList();
    check('filters: 상세에서 명산 모드 버튼으로 돌아와도 유지', currentHash() === original);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(`.rows a.row[data-id="${pick}"]`).click(); await waitMountain();
    await page.locator('.tb-brand').click(); await waitList();
    check('filters: 제목 링크로 목록에 돌아와도 유지', currentHash() === original);
    await page.locator(`.rows a.row[data-id="${pick}"]`).click(); await waitMountain();
    await page.getByRole('tab', { name: '정보', exact: true }).click();
    const feature = page.locator('.mt-tags button').first();
    await feature.click(); await waitList();
    const featureParams = new URLSearchParams(currentHash().split('?')[1]);
    check('filters: 산 특징으로 다시 검색해도 기존 권역·목록·코스 조건 유지', featureParams.get('region') === '강원' && featureParams.get('list') === 'sanlim' && featureParams.get('easy') === '1' && featureParams.get('hours') === '4' && featureParams.get('distance') === '10' && !!featureParams.get('q'));
    await page.getByRole('button', { name: '조건 초기화', exact: true }).click();
    await page.locator('.rows a.row').first().click(); await waitMountain();
    await page.reload(); await waitMountain();
    await page.locator('.tb-brand').click(); await waitList();
    check('filters: 명시적으로 초기화한 조건은 되살아나지 않음', currentHash() === '#/map' && await page.locator('.tokens .token').count() === 0);
  });

  await step('mountain photos and summit', async () => {
    const photos = mountains.filter(m => m.image);
    let valid = true;
    for (const m of photos) {
      const image = m.image;
      if (!image.author || !image.license || !image.source?.startsWith('https://commons.wikimedia.org/wiki/File:') || !image.license_url?.startsWith('https://creativecommons.org/')) valid = false;
      if (!(await readFile(join(DIST, image.file))).length) valid = false;
    }
    check('photos: 수록 사진 모두 로컬 파일·저작자·원본·라이선스 포함', valid && photos.length >= 33, `${photos.length}개 산`);
    const decoded = await page.evaluate(async files => Promise.all(files.map(file => new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0);
      img.onerror = () => resolve(false);
      img.src = file;
    }))), photos.map(m => `${base}/${m.image.file}`));
    check('photos: 수록 사진 전체가 브라우저에서 실제로 표시 가능한 이미지', decoded.every(Boolean), `${decoded.filter(Boolean).length}/${photos.length}`);
    await page.goto(base + '/#/m/bukhansan'); await waitMountain();
    await page.waitForFunction(() => document.querySelector('.mt-photo img')?.naturalWidth > 0);
    check('photos: 상세 첫 화면에 실제 사진과 출처 표시', await page.locator('.mt-photo-open').isVisible() && (await page.locator('.mt-photo-credit').textContent()).includes('Wikimedia Commons'));
    await page.locator('.mt-photo-open').click();
    const dialog = page.locator('dialog.mt-photo-modal');
    await dialog.waitFor();
    check('photos: 사진 확대·저작자 표시', await dialog.locator('img').isVisible() && (await dialog.textContent()).includes('Wikimedia Commons'));
    await page.keyboard.press('Escape');
    check('photos: 확대 닫기 후 원래 사진 버튼으로 포커스 복원', await page.locator('.mt-photo-open').evaluate(n => n === document.activeElement));
    const noPhoto = mountains.find(m => !m.image);
    await page.goto(`${base}/#/m/${noPhoto.id}`); await waitMountain();
    check('summit: 사진 없는 산은 정상 도식·좌표·실물 미확인 안내', await page.locator('.mt-summit-stone').isVisible() && (await page.locator('.mt-photo-missing').textContent()).includes('실물 정보 미확인') && (await page.locator('.mt-summit-coord').textContent()).includes(noPhoto.lat.toFixed(5)));
    await page.locator('.mt-summit-place').click();
    await page.waitForTimeout(700);
    check('summit: 정상 위치 버튼은 지도 정상 라벨로 이동', (await page.locator('#map .mk.selected').getAttribute('data-id')) === noPhoto.id && await page.locator('#map .map-label.summit').isVisible());
    // 사진이 전송에 실패해도 빈 이미지 대신 정상 안내가 남는다.
    await page.route('**/media/mountains/bukhansan.jpg', r => r.abort());
    await page.goto(base + '/#/m/bukhansan'); await waitMountain();
    await page.locator('.mt-photo-missing').waitFor({ state: 'visible' });
    check('photos: 이미지 로드 실패 시 정상 위치 안내로 회복', await page.locator('.mt-summit-stone').isVisible());
    await page.unroute('**/media/mountains/bukhansan.jpg');
  });

  await step('marker labels and responsive', async () => {
    await mkdir(join(ROOT, 'shots/improvements'), { recursive: true });
    for (const width of [320, 390, 1440]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(t => { localStorage.setItem('kr100:theme', t); }, theme);
        await page.goto(base + '/#/map'); await page.reload(); await waitForShell(page);
        const visible = await page.locator('.mk.label-on .mk-name').evaluateAll(nodes => nodes.filter(n => {
          const r = n.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
        }).length);
        check(`markers ${width} ${theme}: 넓은 범위에서도 산 이름 표시`, visible > 0, `${visible}개`);
        await page.goto(base + '/#/m/bukhansan'); await waitMountain();
        await page.waitForFunction(() => document.querySelector('.mt-photo img')?.complete);
        check(`layout ${width} ${theme}: 사진·정상 안내 가로 넘침 없음`, await page.evaluate(() => {
          const media = document.querySelector('.mt-media'); return [...media.querySelectorAll('*')].every(n => n.getBoundingClientRect().right <= innerWidth + 1);
        }));
        await page.screenshot({ path: join(ROOT, `shots/improvements/${width}-${theme}.png`) });
      }
    }
  });
  check('known external requests only', net.blocked.length === 0, net.blocked.join(' | '));
  // 이미지 실패 회복 시나리오의 의도한 네트워크 실패는 제외.
  check('no runtime errors', errors.filter(e => !e.includes('ERR_FAILED')).length === 0, errors.join(' | '));
  await ctx.close();
} finally { await browser.close(); await close(); }
process.exitCode = finish();
