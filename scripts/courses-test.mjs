// 대표·유명 코스 자료 검사 + 대표 코스 모음(#/courses) 화면 흐름.
// 사용: node scripts/courses-test.mjs   (SMOKE_DIST=<빌드 폴더>, 기본 dist. UX_BASE_URL을 주면 배포본 자료도 같은 검사)
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, serve, launch, stubNetwork, watch, reporter } from './lib/ui-harness.mjs';

const SHOTS = process.env.SHOT_DIR || join(ROOT, 'shots', 'courses');
const { check, step, finish } = reporter('courses');
const errors = [];
const { base, close } = await serve();
const browser = await launch();
const hashOf = (page) => decodeURIComponent(new URL(page.url()).hash);
/** 해시의 경로와 조건(URLSearchParams는 공백을 +로 쓴다 — 문자열 대신 값으로 비교). */
const route = (page) => {
  const [path, query = ''] = new URL(page.url()).hash.slice(1).split('?');
  const p = new URLSearchParams(query);
  return { path, q: p.get('q'), region: p.get('region'), keys: [...p.keys()].join(',') };
};

try {
  await mkdir(SHOTS, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const net = await stubNetwork(ctx);
  const page = watch(await ctx.newPage(), errors, { label: 'courses' });

  // 대상 빌드(또는 배포본)의 자료를 그대로 받아 검사한다.
  const { mountains, meta } = await (await page.request.get(base + '/data/mountains.json')).json();
  const byId = new Map(mountains.map((m) => [m.id, m]));
  const courses = mountains.flatMap((m) => m.famous_courses || []);

  // ---------- 자료 ----------
  await step('data', async () => {
    check('data: 149개 산 모두 대표 코스 목록 보유', mountains.length === 149 && mountains.every((m) => m.famous_courses?.length));
    check('data: 코스 id 전역 고유', new Set(courses.map((c) => c.id)).size === courses.length, `${courses.length}개`);
    check('data: 코스 이름·경유지에 깨진 글자 없음', courses.every((c) => !JSON.stringify(c).includes('�')));
    check('data: 근거마다 범위(scope)·http(s) 주소', courses.every((c) => c.sources?.length && c.sources.every((s) => s.scope === (c.evidence === 'official' ? 'course' : 'mountain') && /^https?:/.test(s.url))));
    check('data: 공식 근거에는 확인일', courses.filter((c) => c.evidence === 'official').every((c) => c.sources.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.checked_at))));
    check('data: 등산로 연결(trail_index)이 정확', mountains.every((m) => m.famous_courses.every((c) => c.trail_index == null || m.trails[c.trail_index]?.name === c.trail_name)));
    check('data: 메타 집계가 실제와 일치', meta.famous_courses.courses === courses.length && meta.famous_courses.official === courses.filter((c) => c.evidence === 'official').length);
    check('data: 설악산에 울산바위·공룡능선', ['울산바위', '공룡능선'].every((n) => byId.get('seolaksan').famous_courses.some((c) => c.name.includes(n))));
    check('data: 화대종주는 화엄사에서 시작', byId.get('jirisan').famous_courses.filter((c) => c.name.includes('화대')).every((c) => c.name.startsWith('화엄사')));
    const plateau = byId.get('hanrasan').famous_courses.filter((c) => /영실|어리목/.test(c.name));
    check('data: 한라산 영실·어리목 코스는 백록담으로 가지 않음', plateau.length === 2 && plateau.every((c) => !c.via.includes('백록담') && c.highlight.includes('연결되지')));
  });

  // ---------- 모음 화면: 20곳씩 더 보기 ----------
  await step('catalogue', async () => {
    await page.goto(base + '/#/courses');
    await page.waitForSelector('.pg-courses .crs-m');
    check('catalogue: 문서 제목', (await page.title()).startsWith('대표 코스 모음'), await page.title());
    check('catalogue: 전체 개수 안내', (await page.locator('.crs-count').textContent()) === `${mountains.length}개 산 · ${courses.length}개 코스`, await page.locator('.crs-count').textContent());
    check('catalogue: 처음엔 20곳', (await page.locator('.crs-m').count()) === 20 && (await page.locator('.crs-more-note').textContent()) === `${mountains.length}곳 중 20곳 표시`);
    const more = page.locator('.crs-more-btn');
    check('catalogue: "20곳 더 보기"', (await more.textContent()) === '20곳 더 보기');
    await more.click();
    check('catalogue: 더 보기 → 40곳', (await page.locator('.crs-m').count()) === 40);
    check('catalogue: 새로 붙은 첫 산 제목으로 포커스', await page.evaluate(() => document.activeElement?.classList.contains('crs-m-h')
      && document.activeElement === document.querySelectorAll('.crs-m')[20].querySelector('.crs-m-h')));
    while (await more.isVisible()) await more.click();
    check('catalogue: 끝까지 펼치면 149곳·모든 코스', (await page.locator('.crs-m').count()) === mountains.length && (await page.locator('.crs-rows li').count()) === courses.length,
      `${await page.locator('.crs-m').count()}곳 · ${await page.locator('.crs-rows li').count()}개`);
    await page.locator('.pg-fold summary', { hasText: '코스 선정 기준' }).click();
    const policy = await page.locator('.pg-fold', { hasText: '코스 선정 기준' }).innerText();
    check('catalogue: 선정 기준이 인기 순위가 아님을 밝힘', policy.includes('인기 순위는 아닙니다') && policy.includes('인기도를 별도로 검증하지 않았습니다'));
    check('catalogue: 근거 표시(공단 안내 확인/자료 선정)', (await page.locator('.crs-ev.ok').count()) === courses.filter((c) => c.evidence === 'official').length);
  });

  // ---------- 검색·권역: 주소와 동기화 ----------
  await step('filters', async () => {
    await page.locator('#crs-q').fill('설악 공룡');
    check('filters: 여러 단어 검색으로 한 코스', (await page.locator('.crs-rows li').count()) === 1 && (await page.locator('.crs-m').getAttribute('data-mountain-id')) === 'seolaksan');
    check('filters: 검색어가 주소에', route(page).path === '/courses' && route(page).q === '설악 공룡' && route(page).keys === 'q', hashOf(page));
    await page.locator('#crs-region').selectOption('강원');
    check('filters: 권역도 주소에', route(page).q === '설악 공룡' && route(page).region === '강원', hashOf(page));
    await page.reload();
    await page.waitForSelector('.crs-rows li');
    check('filters: 새로고침해도 검색·권역 유지', (await page.locator('#crs-q').inputValue()) === '설악 공룡'
      && (await page.locator('#crs-region').inputValue()) === '강원' && (await page.locator('.crs-rows li').count()) === 1);
  });

  // ---------- 행 → 경로 시트 ----------
  await step('row opens route', async () => {
    const link = page.locator('.crs-rows li a.crs-row').first();
    const href = await link.getAttribute('href');
    const course = byId.get('seolaksan').famous_courses.find((c) => c.name.includes('공룡능선'));
    check('route: 행 링크 = #/m/<id>?route=…', href === `#/m/seolaksan?route=c:${course.id}`, href);
    await link.click();
    await page.waitForFunction(() => location.hash.includes('route=') && !!document.querySelector('.sheet .rt-title'));
    check('route: 그 코스의 경로 시트', (await page.locator('.rt-title').textContent()).includes('공룡능선'), await page.locator('.rt-title').textContent());
    await page.waitForTimeout(100);
    check('route: 경로 제목으로 포커스', await page.locator('.rt-title').evaluate((n) => n === document.activeElement));
    check('route: 경유지·근거 표시', (await page.locator('.rt-details').textContent()).includes(course.via[0]) && (await page.locator('.rt-details').textContent()).includes('공단 안내 확인'));
    check('route: 정상 코스 선이 없는 대표 코스에 가짜 선·GPX 없음', (await page.locator('.rt-prov').textContent()).includes('지도 선 없음')
      && (await page.locator('.rt-actions', { hasText: 'GPX' }).count()) === 0
      && (await page.evaluate(() => document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="5"]').length)) === 0);
    await page.goBack();
    await page.waitForSelector('.pg-courses .crs-rows li');
    check('route: 뒤로 → 조건 그대로인 모음', route(page).path === '/courses' && route(page).q === '설악 공룡' && route(page).region === '강원' && (await page.locator('.crs-rows li').count()) === 1, hashOf(page));
    await page.goForward();
    await page.waitForFunction(() => !!document.querySelector('.sheet .rt-title'));
    await page.locator('.rt-title').focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !!document.querySelector('.sheet .mt-title') && !location.hash.includes('route='));
    check('route: Esc → 산 시트(한 단계)', hashOf(page) === '#/m/seolaksan');
    const s = byId.get('seolaksan');
    const tabText = await page.locator('#mt-panel-courses').innerText();
    check('route: 산 시트 코스 탭에 대표 코스와 등산로 모두', s.famous_courses.every((c) => tabText.includes(c.name)) && s.trails.every((t) => tabText.includes(t.name)));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.pg-courses .crs-rows li');
    check('route: 한 번 더 Esc → 모음(조건 유지)', route(page).path === '/courses' && route(page).q === '설악 공룡' && route(page).region === '강원', hashOf(page));
    await page.locator('#crs-region').selectOption('제주');
    check('filters: 권역·검색은 교집합(빈 결과 안내)', (await page.locator('.crs-rows li').count()) === 0 && (await page.locator('.pg-courses .empty').innerText()).includes('조건에 맞는'));
    await page.locator('.pg-courses .empty').getByRole('button', { name: '조건 초기화', exact: true }).click();
    check('filters: 초기화하면 전부·주소도 정리', (await page.locator('.crs-count').textContent()).startsWith(`${mountains.length}개 산`) && hashOf(page) === '#/courses');
    await page.locator('#crs-q').fill('백운산');
    check('filters: 같은 이름 산은 따로', (await page.locator('.crs-m').count()) === mountains.filter((m) => m.name === '백운산').length);
  });

  // ---------- 한라산: 목적지 넷, 등산로 연결 ----------
  await step('hallasan', async () => {
    await page.goto(base + '/#/courses?q=' + encodeURIComponent('윗세오름'));
    await page.waitForSelector('.crs-rows li');
    check('hallasan: 윗세오름 → 영실·어리목 두 코스', (await page.locator('.crs-rows li').count()) === 2);
    await page.locator('.crs-m-h a').first().click();
    await page.waitForFunction(() => document.querySelector('.sheet .mt-title .mt-name')?.textContent === '한라산');
    await page.waitForSelector('#mt-panel-courses .mt-crow');
    const h = byId.get('hanrasan');
    const tab = await page.locator('#mt-panel-courses').innerText();
    check('hallasan: 산 시트에 대표 코스 4개 모두', h.famous_courses.length === 4 && h.famous_courses.every((c) => tab.includes(c.name)));
    await page.goto(base + '/#/courses?q=' + encodeURIComponent('성판악'));
    await page.waitForSelector('.crs-rows li');
    await page.locator('.crs-rows li a.crs-row').first().click();
    await page.waitForFunction(() => !!document.querySelector('.sheet .rt-title'));
    check('hallasan: 등산로와 연결된 대표 코스 → 그 등산로 경로 시트', hashOf(page) === '#/m/hanrasan?route=t:0' && (await page.locator('.rt-title').textContent()).includes('성판악')
      && (await page.locator('.rt-alt').textContent()).includes('성판악-백록담'), hashOf(page));
  });

  // ---------- 목록 검색도 대표 코스를 찾는다 · 입구는 설정 ----------
  await step('entry points', async () => {
    await page.goto(base + '/#/map?q=' + encodeURIComponent('울산바위'));
    await page.waitForSelector('.sheet .rows a.row');
    check('list: 산 검색이 대표 코스 이름도 찾음', (await page.locator('.sheet .rows a.row').count()) === 1 && (await page.locator('.sheet .rows a.row').innerText()).includes('설악산'));
    check('entry: 설정 OFF면 목록에 모음 입구가 보이지 않음', (await page.locator('.sheet a[href="#/courses"]').filter({ visible: true }).count()) === 0);
    await page.goto(base + '/#/settings');
    await page.getByRole('switch', { name: '대표 코스 모음' }).click();
    await page.goto(base + '/#/map');
    await page.waitForSelector('.sheet .rows a.row');
    const entry = page.locator('.sheet a[href="#/courses"]').filter({ visible: true });
    await page.waitForTimeout(200);
    if (!(await entry.count())) { await page.locator('.sheet-grabber').click(); await page.waitForTimeout(350); }
    check('entry: 설정 ON → 목록 시트에 "대표 코스 모음 ›"', (await entry.count()) === 1 && (await entry.textContent()).includes('대표 코스 모음'));
    await entry.scrollIntoViewIfNeeded();
    await entry.click();
    await page.waitForSelector('.pg-courses');
    check('entry: 입구를 누르면 모음', hashOf(page) === '#/courses');
    await page.locator('.pg-back').click();
    await page.waitForSelector('.sheet .rows a.row');
    check('entry: [‹ 지도]로 돌아감', !hashOf(page).startsWith('#/courses'));
    await page.evaluate(() => localStorage.removeItem('kr100:prefs'));
  });

  // ---------- 더 보기 상태는 뒤로 오면 복원 ----------
  await step('restore', async () => {
    await page.goto(base + '/#/courses');
    await page.waitForSelector('.crs-m');
    await page.locator('.crs-more-btn').click();
    const target = page.locator('.crs-m').nth(30).locator('a.crs-row').first();
    await target.scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => scrollY);
    await target.click();
    await page.waitForFunction(() => !!document.querySelector('.sheet .rt-title'));
    await page.goBack();
    await page.waitForSelector('.crs-m');
    await page.waitForTimeout(200);
    check('restore: 펼친 개수(40곳) 복원', (await page.locator('.crs-m').count()) === 40);
    check('restore: 스크롤 위치 복원', Math.abs((await page.evaluate(() => scrollY)) - y) < 30, `${y}`);
  });

  // ---------- 배치 ----------
  await step('layout', async () => {
    await page.goto(base + '/#/courses');
    await page.waitForSelector('.crs-m');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme });
        await page.waitForTimeout(100);
        check(`layout ${width} ${theme}: 가로 넘침 없음`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const t = await page.evaluate(() => [...document.querySelectorAll('.pg-back, .crs-more-btn, #crs-q, #crs-region, .crs-row')]
          .filter((n) => n.getClientRects().length).map((n) => { const r = n.getBoundingClientRect(); return [n.className || n.id, Math.round(r.width), Math.round(r.height)]; })
          .filter(([, w, h]) => w < 44 || h < 44));
        check(`layout ${width} ${theme}: 뒤로·검색·권역·더 보기·행 ≥44px`, t.length === 0, t.slice(0, 3).map((x) => x.join(' ')).join(' | '));
        if (width === 390 || width === 1440) await page.screenshot({ path: join(SHOTS, `courses-${width}-${theme}.png`) });
      }
    }
  });

  check('network: 테스트가 모르는 외부 요청 없음', net.blocked.length === 0, net.blocked.slice(0, 3).join(' '));
  await ctx.close();
} catch (e) {
  errors.push('fatal: ' + (e?.stack || e));
} finally {
  const uniq = [...new Map(errors.map((e) => [e, errors.filter((x) => x === e).length])).entries()].map(([e, n]) => (n > 1 ? `${e} ×${n}` : e));
  check('콘솔 오류·페이지 예외 없음', errors.length === 0, uniq.slice(0, 8).join(' | '));
  await browser.close();
  await close();
  process.exit(finish());
}
