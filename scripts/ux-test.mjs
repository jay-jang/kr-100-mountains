// 지도 우선 화면의 UX 회귀 검사(기본 390×844 + 320/390/768/1440 × 라이트/다크 배치 검사).
// 사용: node scripts/ux-test.mjs   (SMOKE_DIST=<빌드 폴더>, 기본 dist — 지도 검사는 OSM 빌드 기준)
// 바깥 요청은 모두 가로챈다(타일 → PNG, Overpass·open-meteo → 고정 JSON). 위치는 컨텍스트에서 흉내 낸다.
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { filterMountains, matchingCourses } from '../src/data.js';
import { ROOT, DIST, serve, launch, stubNetwork, watch, reporter, waitForShell } from './lib/ui-harness.mjs';

const SHOTS = process.env.SHOT_DIR || join(ROOT, 'shots', 'ux');
const VIEW = { width: 390, height: 844 };
const { check, step, finish } = reporter('ux');
const errors = [];
const { base, close } = await serve();
const browser = await launch();

const { mountains } = JSON.parse(await readFile(join(DIST, 'data/mountains.json'), 'utf8'));
const byId = new Map(mountains.map((m) => [m.id, m]));
const hashOf = (page) => decodeURIComponent(new URL(page.url()).hash);
const count = async (page) => Number((await page.locator('.sheet-count').textContent()).replace(/[^0-9]/g, ''));
const waitList = (page) => page.waitForFunction(() => document.querySelector('.sheet .sheet-title')?.textContent === '명산' && !location.hash.startsWith('#/m/'));
const waitMountain = (page, name) => page.waitForFunction((n) => document.querySelector('.sheet .mt-title .mt-name')?.textContent === n && !location.hash.includes('route='), name);
const waitRoute = (page) => page.waitForFunction(() => location.hash.includes('route=') && !!document.querySelector('.sheet .rt-title'));
const detent = (page) => page.locator('.sheet').getAttribute('data-detent');
const sheetH = async (page) => Math.round((await page.locator('.sheet').boundingBox()).height);
const settle = (page, ms = 350) => page.waitForTimeout(ms);    // 시트 높이 전환 .24s
const hav = (la1, lo1, la2, lo2) => {
  const R = 6371000, r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(la2 - la1) / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(r(lo2 - lo1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};
// 장식 이모지·기호(© ® ™는 저작권 표시라 제외). spec-final 11장 금지 목록 포함.
const EMOJI = /(?![©®™])\p{Extended_Pictographic}|[◐◎⛶★☆✓✔️]/u;

/**
 * 지도 셸·시트·모달 안에서 지금 화면에 보이는(맨 위에서 눌리는) 조작 요소의 누르는 영역을 잰다.
 * 누르는 영역 = 요소 상자 ∪ ::before/::after 확장(position:absolute + inset) ∪ 감싼 <label>.
 * 예외(기록만): display:inline 글자 링크(문장·메타 줄 안 링크, 지도 저작권 링크) — WCAG 2.5.8 inline 예외.
 */
function measureTargets(min) {
  const SEL = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="tab"], [role="option"], [role="switch"], [tabindex]:not([tabindex="-1"])';
  const roots = [...document.querySelectorAll('.shell:not([hidden]) .tb, .shell:not([hidden]) .ctl, .shell:not([hidden]) .sheet, .shell:not([hidden]) .chooser:not([hidden]), .shell:not([hidden]) #map, dialog[open]')];
  const seen = new Set(), small = [], exempt = [], boxes = [];
  let n = 0;
  const px = (v) => (/px$/.test(v) ? parseFloat(v) : null);
  const pseudoBox = (el, which, r) => {
    const cs = getComputedStyle(el, which);
    if (!cs.content || cs.content === 'none' || cs.display === 'none' || cs.position !== 'absolute') return null;
    const t = px(cs.top), b = px(cs.bottom), l = px(cs.left), rr = px(cs.right);
    if ([t, b, l, rr].some((v) => v == null)) return null;
    return { w: r.width - l - rr, h: r.height - t - b };
  };
  const desc = (el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`
    + `${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label').replace(/[.:].*$/, '').slice(0, 20)}]` : ''}`
    + `${el.getAttribute('aria-label') ? '' : ` "${(el.textContent || '').trim().slice(0, 12)}"`}`;
  for (const root of roots) for (const el of root.querySelectorAll(SEL)) {
    if (seen.has(el)) continue; seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(hit === el || el.contains(hit) || hit.contains(el) || (el.closest('label') && el.closest('label') === hit.closest('label')))) continue;
    n++;
    boxes.push({ el, r });
    if (getComputedStyle(el).display === 'inline') { exempt.push(desc(el)); continue; }
    let w = r.width, h = r.height;
    for (const which of ['::before', '::after']) { const p = pseudoBox(el, which, r); if (p) { w = Math.max(w, p.w); h = Math.max(h, p.h); } }
    const label = el.closest('label');
    if (label && label !== el) { const lr = label.getBoundingClientRect(); w = Math.max(w, lr.width); h = Math.max(h, lr.height); }
    if (w < min - 0.5 || h < min - 0.5) small.push({ el, r, text: `${desc(el)} ${Math.round(w)}×${Math.round(h)}` });
  }
  // 24px 기준(데스크톱 마우스 배치)에서는 WCAG 2.5.8 간격 예외: 작은 대상의 가운데 24×24 상자가 다른 대상과 겹치지 않으면 통과.
  const fails = small.filter(({ el, r }) => {
    if (min > 24) return true;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, q = { l: cx - 12, r: cx + 12, t: cy - 12, b: cy + 12 };
    return boxes.some((o) => o.el !== el && !o.el.contains(el) && !el.contains(o.el) && o.r.left < q.r && o.r.right > q.l && o.r.top < q.b && o.r.bottom > q.t);
  }).map((x) => x.text);
  return { n, fails: [...new Set(fails)], exempt: [...new Set(exempt)] };
}
const exemptions = new Set();
async function targetsOk(page, label, min = 44) {
  const r = await page.evaluate(measureTargets, min);
  r.exempt.forEach((e) => exemptions.add(e));
  return check(`targets ${label}: 보이는 조작 요소 ≥${min}×${min}`, r.fails.length === 0, r.fails.length ? r.fails.join(' | ') : `${r.n}개`);
}
/** 여러 화면을 재고 폭마다 한 줄로 보고한다(같은 요소가 화면마다 반복 보고되지 않게). */
function targetAggregator() {
  const byWidth = new Map();
  return {
    async add(page, width, screen, min) {
      const r = await page.evaluate(measureTargets, min);
      r.exempt.forEach((e) => exemptions.add(e));
      const w = byWidth.get(width) || { min, n: 0, fails: new Map() };
      w.n += r.n;
      for (const f of r.fails) w.fails.set(f, [...(w.fails.get(f) || []), screen]);
      byWidth.set(width, w);
    },
    report() {
      for (const [width, w] of byWidth) {
        const list = [...w.fails].map(([f, screens]) => `${f} @ ${[...new Set(screens)].length}화면`);
        check(`targets ${width}px: 지도 셸·시트의 보이는 조작 요소 ≥${w.min}×${w.min}${w.min < 44 ? ' (데스크톱 마우스 배치: WCAG 2.5.8)' : ''}`, list.length === 0, list.join(' | ') || `${w.n}개 측정`);
      }
    },
  };
}
/** 시트가 peek·min이면 half로(목록 행은 시트 본문 안에 있어 peek에서는 잘려 보이지 않는다). */
async function expand(page) {
  for (let i = 0; i < 3 && ['peek', 'min'].includes(await page.locator('.sheet').getAttribute('data-detent')); i++) {
    await page.locator('.sheet-grabber').click();
    await page.waitForTimeout(350);
  }
}
/** 시트 본문에서 지금 눈에 보이는 i번째 목록 행(시트 높이 전환이 끝나 행이 보일 때까지 기다린다). */
async function visibleRow(page, i = 0) {
  const handle = await page.waitForFunction((k) => {
    const sheet = document.querySelector('.sheet');
    if (sheet.classList.contains('dragging')) return null;
    const body = document.querySelector('.sheet-body').getBoundingClientRect();
    const rows = [...document.querySelectorAll('.sheet .rows a.row')].filter((n) => { const r = n.getBoundingClientRect(); return r.height && r.top >= body.top && r.bottom <= body.bottom; });
    return rows[k]?.dataset.id || null;
  }, i, { timeout: 5000 });
  const id = await handle.jsonValue();
  return page.locator(`.sheet .rows a.row[data-id="${id}"]`).first();
}
/** 지도 위 빈 곳(기호·선택창·컨트롤·시트·상단 바가 아닌 타일) 좌표. */
async function emptyMapPoint(page) {
  return page.evaluate(() => {
    for (const fy of [0.75, 0.6, 0.45, 0.3]) for (const fx of [0.2, 0.5, 0.8, 0.35, 0.65]) {
      const x = innerWidth * fx, y = innerHeight * fy;
      const n = document.elementFromPoint(x, y);
      if (n && n.closest('#map') && !n.closest('.mk, .leaflet-control-container, .leaflet-tooltip, .leaflet-marker-icon')) return { x, y };
    }
    return null;
  });
}
async function newPage(opts = {}, { stub = {}, label = '' } = {}) {
  const ctx = await browser.newContext({ viewport: VIEW, ...opts });
  const net = await stubNetwork(ctx, stub);
  const page = watch(await ctx.newPage(), errors, { label });
  return { ctx, page, net };
}

try {
  await mkdir(SHOTS, { recursive: true });

  // ---------- 순수 함수: 코스 조건은 같은 코스가 함께 만족해야 한다 ----------
  const fixture = { trails: [{ difficulty: '보통', round_trip_hours: 6, distance_km: 3 }, { difficulty: '어려움', round_trip_hours: 2, distance_km: 2 }] };
  check('filter: 조건은 같은 코스가 모두 만족해야 함', matchingCourses(fixture, { easy: true, maxHours: 4 }).length === 0);
  check('filter: 시간을 모르는 코스는 시간 조건에서 제외', matchingCourses({ trails: [{ difficulty: '쉬움' }] }, { maxHours: 4 }).length === 0);

  const { ctx, page, net } = await newPage({}, { label: 'main' });

  // ---------- 테마 검색어(키워드)가 목록을 같은 기준으로 좁힌다 ----------
  await step('theme keywords', async () => {
    for (const q of ['단풍', '억새', '계곡', '대중교통', '수도권']) {
      await page.goto(`${base}/#/map?q=${encodeURIComponent(q)}`);
      await waitForShell(page, { markers: false });
      const want = filterMountains(mountains, { q }).length;
      await page.waitForFunction((n) => document.querySelectorAll('.sheet .rows a.row').length === n, want, { timeout: 5000 }).catch(() => {});
      const got = await page.locator('.sheet .rows a.row').count();
      check(`theme ${q}: 목록 = filterMountains`, want > 0 && got === want && (await count(page)) === want, `${got} / ${want}`);
    }
  });

  // ---------- 상단 검색: 키보드·빈 결과·한글 IME·Esc 2단계 ----------
  await step('search keyboard', async () => {
    await page.goto(base + '/#/');
    await waitForShell(page);
    const input = page.getByRole('combobox', { name: '산·코스·걷기길 검색' });
    await input.fill('설악');
    await page.waitForSelector('.suggest:not([hidden]) .suggest-item');
    await input.press('ArrowDown');
    const active = await input.getAttribute('aria-activedescendant');
    check('search: 화살표 선택을 aria-activedescendant로 알림', !!active && (await page.locator(`#${active}`).getAttribute('aria-selected')) === 'true', active);
    await input.press('Enter');
    await waitMountain(page, '설악산');
    check('search: Enter로 고른 산 시트 열림', hashOf(page) === '#/m/seolaksan');
    await page.goBack();
    await waitList(page);

    await input.fill('찾을수없는산');
    check('search: 결과 없음 안내', await page.locator('.suggest-empty').isVisible());
    check('search: 결과 없음이면 목록도 0곳(조건 초기화 제공)', (await count(page)) === 0 && await page.locator('.sheet .empty .btn', { hasText: '조건 초기화' }).isVisible());

    // 한글 IME 조합 확정 Enter(isComposing·keyCode 229)는 제안 선택·제출이 아니다.
    await input.fill('한라');
    await page.waitForSelector('.suggest:not([hidden]) .suggest-item');
    await input.press('ArrowDown');        // 첫 제안이 골라진 상태 — 보통 Enter면 열린다
    const prevented = await page.evaluate(() => {
      const i = document.querySelector('.tb-input');
      const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true });
      i.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    await page.waitForTimeout(400);
    check('ime: 조합 중 Enter는 제안을 고르지 않음', !hashOf(page).startsWith('#/m/') && (await input.inputValue()) === '한라'
      && await page.locator('.suggest').isVisible() && !prevented, `${hashOf(page)} · "${await input.inputValue()}"`);
    await input.press('Enter');
    await waitMountain(page, '한라산');
    check('ime: 조합이 끝난 Enter는 고른 제안을 연다', hashOf(page) === '#/m/hanrasan');
    await page.goBack();
    await waitList(page);

    // Esc 2단계: 제안 닫기 → 값 지우기 → (둘 다 없으면) 기본 동작에 맡김
    await input.fill('설악');
    await page.waitForSelector('.suggest:not([hidden])');
    await input.press('Escape');
    check('esc: 1단계 — 제안만 닫고 검색어 유지', !(await page.locator('.suggest').isVisible()) && (await input.inputValue()) === '설악' && (await count(page)) === filterMountains(mountains, { q: '설악' }).length);
    await input.press('Escape');
    await page.waitForFunction(() => !location.hash.includes('q='));
    check('esc: 2단계 — 검색어 지움(목록도 전체로)', (await input.inputValue()) === '' && (await count(page)) === mountains.length, hashOf(page));
    const third = await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.querySelector('.tb-input').dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    check('esc: 3단계 — 지울 것이 없으면 막지 않음', third === false);
  });

  // ---------- 시트 단계: 그래버(클릭·Enter·화살표)·헤더 드래그 ----------
  await step('sheet detents', async () => {
    await page.goto(base + '/#/');
    await waitForShell(page);
    await page.locator('.tb-input').blur();
    const grab = page.locator('.sheet-grabber');
    const NAME = { min: '접힘', peek: '낮음', half: '중간', full: '높음' };
    const seen = [[await detent(page), await sheetH(page)]];
    for (let i = 0; i < 3; i++) { await grab.click(); await settle(page); seen.push([await detent(page), await sheetH(page)]); }
    check('grabber: 누를 때마다 peek→half→full로 커지고, full 다음은 낮은 단계로', seen.slice(0, 3).map((x) => x[0]).join('>') === 'peek>half>full' && ['peek', 'half'].includes(seen[3][0]),
      seen.map((x) => x.join(':')).join(' > '));
    check('grabber: 단계마다 높이가 커짐', seen[0][1] < seen[1][1] && seen[1][1] < seen[2][1], seen.slice(0, 3).map((x) => x[1]).join(' < '));
    check('grabber: 지금 단계를 이름으로 알림', (await grab.getAttribute('aria-label')).includes(`시트 크기: ${NAME[await detent(page)]}`), await grab.getAttribute('aria-label'));
    const next = { peek: seen[1][0], half: seen[2][0], full: seen[3][0] };
    await grab.focus();
    const d0 = await detent(page);
    await page.keyboard.press('Enter'); await settle(page);
    const d1 = await detent(page);
    await page.keyboard.press(' '); await settle(page);
    const d2 = await detent(page);
    check('grabber: Enter·Space는 누른 것과 같은 단계 전환', d1 === next[d0] && d2 === next[d1], `${d0} → ${d1} → ${d2}`);
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await settle(page);
    const keys = [await detent(page)];
    const minH = await sheetH(page);
    await page.keyboard.press('ArrowDown'); await settle(page); keys.push(await detent(page));
    for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowUp'); await settle(page); keys.push(await detent(page)); }
    check('grabber: ↓/↑는 한 단계씩(min·full에서 멈춤)', keys.join('>') === 'min>min>peek>half>full>full', keys.join('>'));
    check('grabber: min = 그래버만(44px 안팎)', minH >= 40 && minH <= 52, `${minH}px`);
    check('full: 칩 줄은 덮고 검색 바는 보임', !(await page.locator('.tb-chips').isVisible()) && await page.locator('.tb-input').isVisible());
    check('full: 지도 컨트롤 숨김', !(await page.locator('.ctl').isVisible()));
    for (const want of ['half', 'peek']) {
      await page.keyboard.press('ArrowDown'); await settle(page, 500);
      const g = await page.evaluate(() => [document.querySelector('.ctl').getBoundingClientRect().bottom, document.querySelector('.sheet').getBoundingClientRect().top]);
      check(`controls: ${want}에서 컨트롤 묶음 아래끝 = 시트 윗변 − 12px`, (await detent(page)) === want && Math.abs(g[0] - (g[1] - 12)) <= 2, `${Math.round(g[0])} vs ${Math.round(g[1] - 12)}`);
    }

    // 헤더 드래그: 위로 끌면 커지고, 아래 끝까지 끌면 min (지금 peek)
    const before = await sheetH(page);
    const head = await page.locator('.sheet-head').boundingBox();
    const x = head.x + head.width / 2, y = head.y + 12;
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 1; i <= 15; i++) { await page.mouse.move(x, y - i * 20); await page.waitForTimeout(16); }
    const during = await sheetH(page);
    await page.mouse.up(); await settle(page, 500);
    check('drag: 헤더를 끄는 동안 시트 높이가 따라옴', during > before + 200, `${before} → ${during}px`);
    check('drag: 놓으면 가까운/진행 방향 단계로', ['half', 'full'].includes(await detent(page)) && (await sheetH(page)) > before, `${await detent(page)} ${await sheetH(page)}px`);
    // 아래로 끌기는 헤더의 [가까운 순] 버튼 위에서 시작한다 — 놓은 뒤 따라오는 click이 버튼을 누르면 안 된다.
    const near = page.locator('.sheet-head .chip', { hasText: '가까운 순' });
    const nb = await near.boundingBox();
    await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2); await page.mouse.down();
    for (let i = 1; i <= 20; i++) { await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2 + i * 40); await page.waitForTimeout(16); }
    await page.mouse.up(); await settle(page, 500);
    check('drag: 아래 끝까지 끌면 min', (await detent(page)) === 'min', await detent(page));
    check('drag: 버튼 위에서 시작한 드래그는 그 버튼을 누르지 않음', (await near.getAttribute('aria-pressed')) === 'false' && !(await page.locator('.sheet-head .sheet-note').isVisible()) && !hashOf(page).includes('sort='),
      `${await near.getAttribute('aria-pressed')} ${hashOf(page)}`);
    await grab.click(); await settle(page);
    check('grabber: min에서 누르면 다시 펼침', (await detent(page)) !== 'min' && (await sheetH(page)) > minH, await detent(page));
    await page.screenshot({ path: join(SHOTS, 'sheet-half.png') });
  });

  // ---------- 필터 모달: 즉시 반영·개수·토큰·주소 ----------
  await step('filters', async () => {
    await page.goto(base + '/#/');
    await waitForShell(page);
    await page.getByRole('button', { name: '필터', exact: true }).click();
    const dlg = page.locator('dialog.modal[open]');
    await dlg.waitFor();
    check('filter: 모달(dialog)로 열림', (await dlg.locator('h2').textContent()) === '필터');
    await targetsOk(page, 'filter modal 390');
    const show = dlg.locator('.modal-foot .btn.primary');
    const regions = new Set(['강원']);
    await dlg.locator('.chip', { hasText: /^강원$/ }).click();
    let want = filterMountains(mountains, { regions });
    check('filter: 칩은 누르는 즉시 반영(모달 열린 채 주소·목록 갱신)', hashOf(page).includes('region=강원') && (await count(page)) === want.length && await dlg.isVisible(), `${await count(page)} / ${want.length}`);
    check('filter: "n곳 보기" = filterMountains', (await show.textContent()) === `${want.length}곳 보기`, await show.textContent());
    await dlg.locator('.chip', { hasText: '쉬움·보통 코스' }).click();
    await dlg.getByLabel('왕복 시간', { exact: true }).selectOption('4');
    await dlg.getByLabel('코스 거리', { exact: true }).selectOption('10');
    want = filterMountains(mountains, { regions, easy: true, maxHours: 4, maxDistance: 10 });
    check('filter: 코스 조건까지 개수 일치', (await show.textContent()) === `${want.length}곳 보기` && (await count(page)) === want.length, `${await show.textContent()} / ${want.length}`);
    const ids = await page.locator('.sheet .rows a.row').evaluateAll((ns) => ns.map((n) => n.dataset.id));
    check('filter: 남은 산마다 한 코스가 모든 조건을 만족', ids.length > 0 && ids.every((id) => byId.get(id).region === '강원' && matchingCourses(byId.get(id), { easy: true, maxHours: 4, maxDistance: 10 }).length));
    await show.click();
    await dlg.waitFor({ state: 'detached' });
    check('filter: 닫으면 필터 칩으로 포커스 복귀', await page.evaluate(() => document.activeElement?.textContent?.startsWith('필터')));
    check('filter: 칩에 적용 개수', (await page.locator('.tb-chips .chip', { hasText: '필터' }).textContent()) === '필터 4');
    const tokens = await page.locator('.tokens .token').allTextContents();
    check('tokens: 적용 조건이 토큰으로 보임', ['강원', '쉬움·보통', '왕복 4시간 이내', '10km 이내'].every((t) => tokens.some((x) => x.includes(t))) && tokens.some((x) => x.includes('조건 초기화')), tokens.join(' | '));
    await page.getByRole('button', { name: '왕복 4시간 이내 조건 해제', exact: true }).click();
    want = filterMountains(mountains, { regions, easy: true, maxDistance: 10 });
    const h = hashOf(page);
    check('tokens: 하나만 풀고 나머지 조건 유지', !h.includes('hours=') && h.includes('region=강원') && h.includes('easy=1') && h.includes('distance=10') && (await count(page)) === want.length, `${h} · ${await count(page)}/${want.length}`);
    check('tokens: 푼 뒤에도 키보드 포커스가 조건 묶음 안에', await page.evaluate(() => !!document.activeElement?.closest('.tokens')),
      await page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className}`));
    await page.reload();
    await waitForShell(page);
    check('url: 새로고침해도 조건 유지', (await count(page)) === want.length && (await page.locator('.tokens .token').count()) === 4, `${await count(page)}곳`);
    const filtered = hashOf(page);
    await expand(page);
    await (await visibleRow(page, 0)).click();
    await page.waitForFunction(() => location.hash.startsWith('#/m/'));
    await page.waitForSelector('.mt-title');
    await page.goBack();
    await waitList(page);
    check('url: 산을 열었다가 뒤로 와도 조건·결과 유지', hashOf(page) === filtered && (await count(page)) === want.length, hashOf(page));
    // 모순된 조건: 빈 결과가 회복 방법을 알려 준다
    await page.goto(`${base}/#/map?region=${encodeURIComponent('제주')}&q=${encodeURIComponent('설악')}`);
    await waitForShell(page, { markers: false });     // 결과 0곳 — 산 기호도 없다
    await page.waitForFunction(() => document.querySelector('.sheet-count')?.textContent === '0곳');
    check('empty: 빈 결과에 조건 초기화', (await count(page)) === 0 && await page.locator('.sheet .empty .btn', { hasText: '조건 초기화' }).isVisible());
    await page.getByRole('button', { name: '제주 조건 해제', exact: true }).click();
    check('empty: 충돌한 권역만 풀면 검색어 유지', (await count(page)) === filterMountains(mountains, { q: '설악' }).length && hashOf(page).includes('q=설악') && !hashOf(page).includes('region'), hashOf(page));
    await page.getByRole('button', { name: '“설악” 조건 해제', exact: true }).click();
    check('tokens: 검색어 토큰도 풀 수 있음(검색창도 비움)', (await count(page)) === mountains.length && (await page.locator('.tb-input').inputValue()) === '');
  });

  // ---------- 레이어 모달: 지도 종류(일반/지형/위성)는 여기로 옮겨졌다 ----------
  await step('layers modal', async () => {
    await page.goto(base + '/#/');
    await waitForShell(page);
    await page.getByRole('button', { name: '지도 레이어', exact: true }).click();
    const dlg = page.locator('dialog.modal[open]');
    await dlg.waitFor();
    const types = await dlg.getByRole('group', { name: '지도 종류' }).getByRole('button').allTextContents();
    check('layers: 지도 종류 일반·지형·위성', types.join() === '일반,지형,위성', types.join());
    await targetsOk(page, 'layers modal 390');
    const tilesBefore = net.tiles.length;
    await dlg.getByRole('button', { name: '위성', exact: true }).click();
    await page.waitForTimeout(500);
    check('layers: 위성으로 바꾸면 위성 타일·눌림 상태·기억', (await dlg.getByRole('button', { name: '위성', exact: true }).getAttribute('aria-pressed')) === 'true'
      && net.tiles.slice(tilesBefore).some((u) => u.includes('arcgisonline')) && (await page.evaluate(() => localStorage.getItem('kr100:maptype'))) === 'satellite');
    await dlg.getByRole('button', { name: '일반', exact: true }).click();
    check('layers: 기본(일반)으로 돌리면 저장값 지움', (await page.evaluate(() => localStorage.getItem('kr100:maptype'))) === null);
    check('layers: 선 읽는 법(계산 경로 점선 견본)', (await dlg.locator('.legend-line.dash').count()) >= 1 && (await dlg.textContent()).includes('계산 경로'));
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    check('layers: Esc로 닫고 버튼으로 포커스 복귀', await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '지도 레이어'));
  });

  // ---------- 예전 주소(딥링크) ----------
  await step('legacy links', async () => {
    const target = byId.get('gwanaksan');
    await page.evaluate(() => localStorage.setItem('kr100:hiked', JSON.stringify({ gwanaksan: '2024-03-01' })));
    const legacy = `#/map?region=${encodeURIComponent('수도권')}&list=sanlim&q=${encodeURIComponent('관악')}&hiked=1&sort=near&easy=1&hours=4&distance=5`;
    await page.goto(base + '/' + legacy);
    await page.reload();
    await waitForShell(page);
    const want = filterMountains(mountains, { q: '관악', regions: new Set(['수도권']), lists: new Set(['sanlim']), hikedOnly: true, isHiked: (id) => id === 'gwanaksan', easy: true, maxHours: 4, maxDistance: 5 });
    const h = hashOf(page);
    check('legacy: #/map?region&list&q&hiked&easy&hours&distance 해석', want.length === 1 && (await count(page)) === 1
      && (await page.locator('.sheet .rows a.row').first().getAttribute('data-id')) === target.id, `${await count(page)}곳`);
    check('legacy: 주소에 조건 유지(위치가 없으면 가까운 순만 해제)', ['region=수도권', 'list=sanlim', 'q=관악', 'hiked=1', 'easy=1', 'hours=4', 'distance=5'].every((k) => h.includes(k)), h);
    check('legacy: 조건이 모두 토큰으로', (await page.locator('.tokens .token:not(.reset)').count()) === 7, (await page.locator('.tokens .token').allTextContents()).join(' | '));
    await page.evaluate(() => localStorage.removeItem('kr100:hiked'));

    await page.goto(base + '/#/map?focus=bukhansan');
    await waitMountain(page, '북한산');
    check('legacy: #/map?focus=<id> → 산 시트', hashOf(page) === '#/m/bukhansan');
    await page.goBack();
    await waitList(page);
    check('legacy: focus에서 뒤로 → 목록(focus 반복 없음)', !hashOf(page).includes('focus'), hashOf(page));

    await page.goto(base + '/#/m/seolaksan?course=seolaksan-120400v016');
    await waitRoute(page);
    check('legacy: #/m/<id>?course=<대표 코스> → 경로 시트', (await page.locator('.rt-title').textContent()) === '공룡능선 종주' && hashOf(page) === '#/m/seolaksan?route=c:seolaksan-120400v016', hashOf(page));
    check('legacy: 선 없는 대표 코스는 "지도 선 없음"·GPX 없음', (await page.locator('.rt-prov').textContent()).includes('지도 선 없음') && (await page.locator('.rt-actions a[download], .rt-actions button', { hasText: 'GPX' }).count()) === 0);
    await page.goto(base + '/#/m/seolaksan?course=seolaksan-120400v012');
    await waitRoute(page);
    check('legacy: 등산로와 연결된 대표 코스 → 그 등산로 행(t:)', hashOf(page) === '#/m/seolaksan?route=t:0' && (await page.locator('.rt-title').textContent()) === '오색-대청봉 코스'
      && (await page.locator('.rt-details').textContent()).includes('대표 코스'), hashOf(page));
    await page.goto(base + '/#/stats');
    await page.waitForSelector('.pg-track');
    check('legacy: #/stats → 내 기록', (await page.locator('.pg-title').textContent()) === '내 기록' && (await page.title()).startsWith('내 기록'));
    await page.goto(base + '/#/courses?q=' + encodeURIComponent('윗세오름'));
    await page.waitForSelector('.pg-courses .crs-rows li');
    check('legacy: #/courses?q= → 대표 코스 모음 검색', (await page.locator('#crs-q').inputValue()) === '윗세오름' && (await page.locator('.crs-rows li').count()) === 2);
    await page.goto(base + '/#/m/no-such-mountain');
    await page.waitForSelector('.sheet .sheet-title');
    check('legacy: 없는 산 → 안내 시트', (await page.locator('.sheet .sheet-title').textContent()).includes('찾을 수 없습니다'));
  });

  // ---------- 상세에서 돌아오면 목록 스크롤·지도 범위 복원 ----------
  await step('restore', async () => {
    await page.goto(base + '/#/map');
    await waitForShell(page);
    await page.locator('.sheet-grabber').click(); await settle(page);
    await page.locator('.sheet-body').evaluate((n) => { n.scrollTop = 600; });
    await page.waitForTimeout(100);
    const scroll = await page.locator('.sheet-body').evaluate((n) => n.scrollTop);
    const row = await visibleRow(page, 1);
    const id = await row.getAttribute('data-id');
    await row.click();
    await waitMountain(page, byId.get(id).name);
    await page.goBack();
    await waitList(page);
    await page.waitForTimeout(250);
    const back = await page.locator('.sheet-body').evaluate((n) => n.scrollTop);
    check('restore: 뒤로 오면 목록 스크롤 복원', Math.abs(back - scroll) < 5, `${scroll} → ${back}`);
    check('restore: 뒤로 오면 시트 높이 복원', (await detent(page)) === 'half');

    // 지도를 옮긴 뒤 산을 열었다 돌아오면 옮긴 범위로. (넓은 범위는 기호가 묶이므로 두 단계 확대한 뒤 옮긴다)
    await page.goto(base + '/#/map');
    await waitForShell(page);
    await page.waitForTimeout(600);
    for (let i = 0; i < 2; i++) { await page.getByRole('button', { name: '확대', exact: true }).click(); await page.waitForTimeout(450); }
    const map = await page.locator('#map').boundingBox();
    const cx = map.x + map.width / 2, cy = map.y + map.height / 2;
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 50, { steps: 12 }); await page.mouse.up();
    await page.waitForTimeout(600);
    const ref = await page.evaluate(() => {
      const band = [document.querySelector('.tb').getBoundingClientRect().bottom + 30, document.querySelector('.sheet').getBoundingClientRect().top - 30];
      return [...document.querySelectorAll('#map .mk')].find((n) => { const r = n.getBoundingClientRect(); return r.top > band[0] && r.bottom < band[1] && r.left > 30 && r.right < innerWidth - 80; })?.dataset.id;
    });
    check('restore: (준비) 확대한 지도에 낱개 산 기호', !!ref, ref);
    const before = ref && await page.locator(`#map .mk[data-id="${ref}"]`).boundingBox();
    await expand(page);
    await (await visibleRow(page, 0)).click();
    await page.waitForFunction(() => location.hash.startsWith('#/m/') && !!document.querySelector('.sheet .mt-title'));
    await page.waitForTimeout(1000);
    await page.goBack();
    await waitList(page);
    await page.waitForTimeout(800);
    const after = ref && await page.locator(`#map .mk[data-id="${ref}"]`).boundingBox().catch(() => null);
    check('restore: 옮긴 지도 범위 복원(기호 위치 2px 이내)', before && after && Math.abs(before.x - after.x) <= 2 && Math.abs(before.y - after.y) <= 2,
      before && after ? `${Math.round(before.x)},${Math.round(before.y)} → ${Math.round(after.x)},${Math.round(after.y)}` : 'marker missing');
  });

  // ---------- 지도 줄 → 경로 시트 ----------
  await step('map line tap', async () => {
    await page.goto(base + '/#/m/seolaksan');
    await waitMountain(page, '설악산');
    // 코스 탭의 흐린 미리보기 선(굵기 3)을 지도에서 누르면 그 경로 시트가 열린다.
    await page.waitForFunction(() => document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="3"]').length > 0, null, { timeout: 15000 });
    await page.waitForTimeout(1200);
    const pt = await page.evaluate(() => {
      const band = [document.querySelector('.tb').getBoundingClientRect().bottom + 10, document.querySelector('.sheet').getBoundingClientRect().top - 10];
      for (const p of document.querySelectorAll('#map .leaflet-overlay-pane path[stroke-width="3"]')) {
        const len = p.getTotalLength();
        for (const f of [0.5, 0.4, 0.6, 0.3, 0.7]) {
          const xy = p.getPointAtLength(len * f).matrixTransform(p.getScreenCTM());
          if (xy.y > band[0] && xy.y < band[1] && xy.x > 20 && xy.x < innerWidth - 70 && !document.elementFromPoint(xy.x, xy.y)?.closest('.mk, .leaflet-tooltip')) return { x: xy.x, y: xy.y };
        }
      }
      return null;
    });
    check('map: 누를 수 있는 미리보기 선이 보임', !!pt);
    if (pt) {
      await page.mouse.click(pt.x, pt.y);
      await page.waitForFunction(() => location.hash.includes('route='), null, { timeout: 5000 }).catch(() => {});
      check('map: 지도 위 코스 선을 누르면 그 경로 시트', hashOf(page).includes('route=') && await page.locator('.rt-title').isVisible(), hashOf(page));
    }
  });

  // ---------- 다크 모드 타일 ----------
  await step('dark tiles', async () => {
    const dark = await newPage({ colorScheme: 'dark' }, { label: 'dark' });
    await dark.page.goto(base + '/#/');
    await waitForShell(dark.page);
    await dark.page.waitForTimeout(800);
    check('dark: OSM 타일에 .tiles-dark(키 없는 어두운 바탕)', (await dark.page.locator('#map .leaflet-layer.tiles-dark').count()) === 1, `${dark.net.tiles.length} tiles`);
    check('dark: CARTO 타일을 요청하지 않음', dark.net.external.every((u) => !/cartocdn|basemaps\./.test(u)) && dark.net.tiles.length > 0);
    check('dark: 지도 바탕 표시 dark', (await dark.page.locator('#map').getAttribute('data-basetype')) === 'dark');
    await dark.ctx.close();
    check('light: 밝은 모드는 tiles-dark 없음', (await page.locator('#map .leaflet-layer.tiles-dark').count()) === 0 || !(await page.locator('.shell').isVisible()));
  });

  // ---------- 가까운 순(위치 흉내) ----------
  await step('near sort', async () => {
    const ME = { lat: 37.5665, lng: 126.9780 };   // 서울시청
    const near = await newPage({ geolocation: { latitude: ME.lat, longitude: ME.lng, accuracy: 30 }, permissions: ['geolocation'] }, { label: 'near' });
    await near.page.goto(base + '/#/map?sort=near');
    await waitForShell(near.page);
    await near.page.waitForSelector('.sheet .row-rank', { timeout: 10000 });
    const ids = await near.page.locator('.sheet .rows a.row').evaluateAll((ns) => ns.map((n) => n.dataset.id));
    const d = ids.map((id) => hav(ME.lat, ME.lng, byId.get(id).lat, byId.get(id).lon));
    const bad = d.findIndex((v, i) => i && v + 1 < d[i - 1]);
    check('near: 목록 전체가 거리 오름차순', ids.length === mountains.filter((m) => m.lat != null).length && bad === -1, bad === -1 ? `${ids.length}곳, 첫 ${byId.get(ids[0]).name}` : `idx ${bad}`);
    check('near: 행마다 방위·거리', (await near.page.locator('.sheet .row-dist').count()) === ids.length);
    check('near: 기준 위치 시각 안내', (await near.page.locator('.sheet-note').textContent()).includes('측정한 위치 기준'));
    check('near: 토글 눌림 상태', (await near.page.locator('.sheet .chip', { hasText: '가까운 순' }).getAttribute('aria-pressed')) === 'true');
    await near.page.locator('.sheet .chip', { hasText: '가까운 순' }).click();
    check('near: 다시 누르면 기본순(주소에서도 해제)', (await near.page.locator('.sheet .row-rank').count()) === 0 && !hashOf(near.page).includes('sort='));
    await near.page.locator('.sheet .chip', { hasText: '가까운 순' }).click();
    await near.page.waitForSelector('.sheet .row-rank');
    check('near: 다시 켜면 주소에 기록', hashOf(near.page).includes('sort=near'));
    await near.page.screenshot({ path: join(SHOTS, 'near.png') });
    await near.ctx.close();
  });

  // ---------- 내 기록(전체 페이지) ----------
  await step('records', async () => {
    await page.goto(base + '/#/m/seolaksan');
    await waitMountain(page, '설악산');
    await page.locator('.mt-hike').click();
    await page.getByLabel('산행일', { exact: true }).fill('2024-05-12');
    await page.getByRole('button', { name: '기록 저장', exact: true }).click();
    check('record: 고른 산행일 저장', await page.evaluate(() => JSON.parse(localStorage.getItem('kr100:hiked')).seolaksan === '2024-05-12'));
    await page.goto(base + '/#/track');
    await page.waitForSelector('.rec-row');
    check('record: 기록 목록에 날짜', (await page.locator('.rec-rows').textContent()).includes('2024-05-12'));
    await page.getByRole('button', { name: '설악산 산행일 수정', exact: true }).click();
    await page.getByLabel('산행일', { exact: true }).fill('2999-01-01');
    await page.getByRole('button', { name: '기록 저장', exact: true }).click();
    check('record: 미래 날짜는 저장하지 않음', await page.locator('dialog.record-dialog').isVisible()
      && (await page.evaluate(() => JSON.parse(localStorage.getItem('kr100:hiked')).seolaksan)) === '2024-05-12');
    await page.getByLabel('산행일', { exact: true }).fill('2024-05-13');
    await page.getByRole('button', { name: '기록 저장', exact: true }).click();
    await page.getByRole('button', { name: '설악산 기록 삭제', exact: true }).click();
    check('record: 삭제', (await page.locator('.rec-rows .rec-row').count()) === 0);
    await page.getByRole('button', { name: '실행 취소', exact: true }).click();
    check('record: 실행 취소는 고친 날짜로 되살림', (await page.locator('.rec-rows').textContent()).includes('2024-05-13'));
    await page.reload();
    await page.waitForSelector('.rec-row');
    check('record: 되살린 기록이 새로고침 후에도', (await page.locator('.rec-rows').textContent()).includes('2024-05-13'));
    await page.getByRole('button', { name: '다녀온 산 검색해서 기록 추가', exact: true }).click();
    const add = page.getByRole('combobox', { name: '기록할 산 검색' });
    check('record: 추가 버튼 → 검색창에 포커스', await add.evaluate((n) => n === document.activeElement));
    await add.fill('한라'); await add.press('ArrowDown'); await add.press('Enter');
    await page.getByLabel('산행일', { exact: true }).fill('2024-06-01');
    await page.getByRole('button', { name: '기록 저장', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.rec-rows .rec-row').length === 2);
    check('record: 페이지를 떠나지 않고 추가', hashOf(page) === '#/track' && (await page.locator('.rec-rows .rec-row').count()) === 2);
    const search = page.getByLabel('내 기록 검색', { exact: true });
    await search.fill('설악');
    check('record: 기록 검색으로 좁힘', (await page.locator('.rec-rows .rec-row').count()) === 1);
    await search.type('없는산');
    check('record: 입력하는 동안 포커스 유지', await search.evaluate((n) => n === document.activeElement));
    check('record: 검색 결과 없음 안내', await page.locator('.rec-list .empty').isVisible());
    await page.getByRole('button', { name: '검색 지우기', exact: true }).click();
    check('record: 검색 지우기로 복원', (await page.locator('.rec-rows .rec-row').count()) === 2);
    await page.getByLabel('내 기록 정렬', { exact: true }).selectOption('name');
    const names = await page.locator('.rec-rows .rec-name').allTextContents();
    check('record: 이름순 정렬', names.join() === [...names].sort((a, b) => a.localeCompare(b, 'ko')).join() && names.length === 2, names.join(','));
    await page.locator('.rec-rows .rec-link').first().click();
    await page.waitForSelector('.mt-title');
    await page.locator('.mt-head-actions').getByRole('button', { name: '닫고 목록으로', exact: true }).click();
    await page.waitForSelector('.pg-track');
    check('record: 기록에서 연 산을 닫으면 기록으로', hashOf(page) === '#/track');

    // 백업·이전: 잘못된 파일은 기존 기록을 바꾸지 않는다
    await page.locator('.pg-fold summary', { hasText: '백업·이전' }).click();
    const importFile = async (value) => {
      await page.evaluate(() => { document.querySelector('.rec-feedback').textContent = ''; });
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '파일 가져오기', exact: true }).click()]);
      await chooser.setFiles({ name: 'hikes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
      await page.waitForFunction(() => document.querySelector('.rec-feedback')?.textContent.length > 0);
      return page.locator('.rec-feedback').textContent();
    };
    const before = await page.evaluate(() => localStorage.getItem('kr100:hiked'));
    for (const bad of [[], { version: 1, hiked: { seolaksan: '2020-01-01', hanrasan: '2024-02-30' } }, { version: 1, hiked: { seolaksan: '2999-01-01' } }, { version: 2, hiked: {} }]) {
      const msg = await importFile(bad);
      check(`import: 잘못된 파일(${JSON.stringify(bad).slice(0, 40)})은 기록 유지`, (await page.evaluate(() => localStorage.getItem('kr100:hiked'))) === before && msg.includes('가져오지 못했습니다'), msg);
    }
    const msg = await importFile({ version: 1, hiked: { bukhansan: '2024-07-01', unknown: '2024-07-01' } });
    check('import: 아는 산만 합치고 뺀 항목을 알림', (await page.locator('.rec-rows .rec-row').count()) === 3 && msg.includes('1개 항목은 뺐습니다'), msg);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '파일로 내보내기', exact: true }).click();
    const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'));
    check('export: 수정·가져온 기록 포함', exported.version === 1 && exported.hiked.seolaksan === '2024-05-13' && exported.hiked.bukhansan === '2024-07-01');
    await page.evaluate(() => localStorage.removeItem('kr100:hiked'));
  });

  // ---------- 이모지 없음(화면 글자·접근성 이름) ----------
  await step('no emoji', async () => {
    const screens = ['/', '/map?mode=walk', '/m/seolaksan', '/m/seolaksan?tab=walks', '/m/seolaksan?tab=info', '/m/seolaksan?route=t:0', '/track', '/settings', '/courses'];
    const hits = [];
    for (const p of screens) {
      await page.goto(base + '/#' + p);
      await page.waitForSelector(p.startsWith('/m/') || p.startsWith('/map') || p === '/' ? '.sheet .sheet-title' : '.pg-title');
      await page.waitForTimeout(900);
      const text = await page.evaluate(() => [document.title, document.body.innerText,
        ...[...document.querySelectorAll('[aria-label], [title], [placeholder]')].map((n) => `${n.getAttribute('aria-label') || ''} ${n.getAttribute('title') || ''} ${n.getAttribute('placeholder') || ''}`)].join('\n'));
      const m = text.match(new RegExp(EMOJI.source, 'gu'));
      if (m) hits.push(`${p}: ${[...new Set(m)].join(' ')}`);
    }
    check('emoji: 주요 화면 글자에 이모지·장식 기호 없음', hits.length === 0, hits.join(' | ') || `${screens.length} screens`);
    const icon = decodeURIComponent((await readFile(join(DIST, 'index.html'), 'utf8')).match(/<link rel="icon" href="([^"]+)"/)?.[1] || '');
    check('emoji: 파비콘에도 이모지 없음(spec 11장)', !EMOJI.test(icon), icon.slice(0, 80));
  });

  // ---------- 배치: 320/390/768/1440 × 라이트/다크 ----------
  await step('layout matrix', async () => {
    const paths = ['/', '/m/seolaksan', '/m/seolaksan?route=t:0', '/track', '/settings', '/courses'];
    const targets = targetAggregator();
    for (const theme of ['light', 'dark']) {
      for (const width of [320, 390, 768, 1440]) {
        const lay = await newPage({ viewport: { width, height: width >= 1024 ? 900 : 844 }, colorScheme: theme }, { label: `${theme}-${width}` });
        for (const p of paths) {
          await lay.page.goto(base + '/#' + p);
          const mapRoute = !/^\/(track|settings|courses)/.test(p);
          await lay.page.waitForSelector(mapRoute ? '.sheet .sheet-title' : '.pg-title');
          if (mapRoute) await lay.page.waitForFunction(() => document.querySelectorAll('#map .mk').length > 0, null, { timeout: 10000 });
          await lay.page.waitForTimeout(p.includes('route=') ? 1200 : 500);
          const o = await lay.page.evaluate(() => {
            const vw = document.documentElement.clientWidth;
            const wide = [...document.querySelectorAll('.sheet *, .tb *, .pg *')].filter((n) => { const r = n.getBoundingClientRect(); return r.width && r.right > vw + 1 && getComputedStyle(n).position !== 'fixed'; })
              .filter((n) => !n.closest('.tb-chips, .chips-row, .suggest, .sr-only'));
            return { sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, vw, wide: wide.slice(0, 3).map((n) => n.className || n.tagName) };
          });
          check(`layout ${theme} ${width} ${p}: 가로 넘침 없음`, o.sw <= o.vw && o.bw <= o.vw && o.wide.length === 0, `${o.sw}/${o.vw}${o.wide.length ? ' ' + o.wide.join(',') : ''}`);
          if (mapRoute) {
            // 터치 위주 폭(≤768)은 44×44. 1024 이상 데스크톱 패널은 마우스 배치라 WCAG 2.5.8 최소(24×24)로 본다.
            if (theme === 'light') await targets.add(lay.page, width, p, width >= 1024 ? 24 : 44);
            if (width < 1024 && theme === 'light') {
              await lay.page.locator('.sheet-grabber').click(); await settle(lay.page);
              await targets.add(lay.page, width, `${p} (half)`, 44);
            }
          }
          if (width === 390 || width === 1440) await lay.page.screenshot({ path: join(SHOTS, `${theme}-${width}-${p.replace(/[/?=:]/g, '_')}.png`) });
        }
        await lay.ctx.close();
      }
    }
    targets.report();
    console.log('  target exemptions (inline text links):', [...exemptions].join(' · ') || 'none');
  });

  // ---------- 겹친 산 기호: 선택창·키보드·터치 ----------
  await step('overlapping markers', async () => {
    const clustered = mountains.filter((m) => ['seolaksan', 'bukhansan', 'hanrasan'].includes(m.id))
      .map((m) => (m.id === 'hanrasan' ? m : { ...m, lat: 36.5, lon: 127.9 }));
    for (const width of [320, 390, 1440]) {
      const mk = await newPage({ viewport: { width, height: 900 } }, { label: `markers-${width}` });
      await mk.page.route('**/data/mountains.json', (r) => r.fulfill({ json: { meta: { famous_courses: {} }, mountains: clustered } }));
      await mk.page.goto(base + '/#/map');
      await waitForShell(mk.page);
      await mk.page.waitForTimeout(400);
      // 넓은 범위: 겹친 두 산은 숫자 묶음 → 누르면 그 범위로 확대되어 낱개 기호가 된다
      const cluster = mk.page.locator('#map .mk-cluster');
      check(`markers ${width}: 넓은 범위에서 겹친 산은 묶음 기호(2)`, (await cluster.count()) === 1 && (await cluster.textContent()) === '2'
        && /산 2곳/.test(await cluster.getAttribute('aria-label')), await cluster.getAttribute('aria-label').catch(() => ''));
      const cb = await cluster.boundingBox();
      check(`markers ${width}: 묶음 기호 누르는 영역 44×44`, cb.width >= 44 && cb.height >= 44, `${cb.width}×${cb.height}`);
      await cluster.click();
      await mk.page.locator('#map .mk[data-id="seolaksan"]').waitFor({ timeout: 5000 });
      await mk.page.waitForTimeout(400);
      check(`markers ${width}: 묶음을 누르면 확대되어 낱개 기호`, (await mk.page.locator('#map .mk-cluster').count()) === 0 && (await mk.page.locator('#map .mk[data-id="bukhansan"]').count()) === 1);
      const pin = mk.page.locator('#map .mk[data-id="seolaksan"]');
      const box = await pin.boundingBox();
      check(`markers ${width}: 기호 누르는 영역 44×44`, box.width >= 44 && box.height >= 44, `${box.width}×${box.height}`);
      const top = await mk.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.mk')?.dataset.id, [box.x + 22, box.y + 22]);
      await mk.page.mouse.click(box.x + 22, box.y + 22);
      check(`markers ${width}: 겹친 기호를 누르면 이 근처 산 선택창(2곳)`, await mk.page.locator('.chooser').isVisible() && (await mk.page.locator('.chooser-item').count()) === 2, top);
      check(`markers ${width}: 선택창 첫 항목에 포커스`, await mk.page.locator('.chooser-item').first().evaluate((n) => n === document.activeElement));
      await mk.page.keyboard.press('Escape');
      check(`markers ${width}: Esc로 선택창 닫힘`, !(await mk.page.locator('.chooser').isVisible()));
      await mk.page.locator(`#map .mk[data-id="${top}"]`).focus();
      await mk.page.keyboard.press('Enter');
      check(`markers ${width}: 키보드 Enter로도 선택창`, await mk.page.locator('.chooser').isVisible());
      await mk.page.locator('.chooser').getByRole('button', { name: '닫기', exact: true }).click();
      check(`markers ${width}: [닫기]`, !(await mk.page.locator('.chooser').isVisible()));
      await mk.page.mouse.click(box.x + 22, box.y + 22);
      await mk.page.locator('.chooser').waitFor();
      const empty = await emptyMapPoint(mk.page);
      await mk.page.mouse.click(empty.x, empty.y);
      check(`markers ${width}: 빈 지도를 누르면 선택창 닫힘`, !(await mk.page.locator('.chooser').isVisible()) && hashOf(mk.page) === '#/map', `${Math.round(empty.x)},${Math.round(empty.y)} ${hashOf(mk.page)}`);
      // 기호에서 시작한 드래그는 지도를 옮기고 산을 고르지 않는다
      await mk.page.mouse.move(box.x + 22, box.y + 22); await mk.page.mouse.down();
      await mk.page.mouse.move(box.x + 62, box.y + 82, { steps: 12 }); await mk.page.mouse.up();
      await mk.page.waitForTimeout(400);
      const moved = await pin.boundingBox();
      check(`markers ${width}: 기호에서 끌면 지도만 이동(선택 안 함)`, Math.abs(moved.y - box.y) > 20 && !(await mk.page.locator('.chooser').isVisible()) && !hashOf(mk.page).startsWith('#/m/'),
        `${Math.round(box.y)} → ${Math.round(moved.y)}`);
      await mk.page.mouse.click(moved.x + 22, moved.y + 22);
      await mk.page.locator('.chooser').waitFor();
      await mk.page.locator('.chooser-item[href="#/m/seolaksan"]').click();
      await waitMountain(mk.page, '설악산');
      check(`markers ${width}: 고른 산의 시트가 열림`, hashOf(mk.page) === '#/m/seolaksan');
      // 앞에서 확대한 범위가 목록 복원으로 되살아나지 않게 새로 연다(남한 전체 범위).
      await mk.page.evaluate(() => sessionStorage.clear());
      await mk.page.goto(base + '/#/map');
      await mk.page.reload();
      await waitForShell(mk.page);
      await mk.page.waitForTimeout(400);
      const single = await mk.page.locator('#map .mk[data-id="hanrasan"]').boundingBox();
      await mk.page.mouse.click(single.x + 22, single.y + 22);
      await waitMountain(mk.page, '한라산');
      check(`markers ${width}: 혼자 있는 기호는 바로 산 시트`, hashOf(mk.page) === '#/m/hanrasan' && !(await mk.page.locator('.chooser').isVisible()));
      await mk.ctx.close();
    }
    const touch = await newPage({ isMobile: true, hasTouch: true, colorScheme: 'dark' }, { label: 'touch' });
    await touch.page.route('**/data/mountains.json', (r) => r.fulfill({ json: { meta: { famous_courses: {} }, mountains: clustered } }));
    await touch.page.goto(base + '/#/map');
    await waitForShell(touch.page);
    await touch.page.waitForTimeout(400);
    await touch.page.locator('#map .mk-cluster').tap();
    await touch.page.locator('#map .mk[data-id="seolaksan"]').waitFor({ timeout: 5000 });
    await touch.page.waitForTimeout(400);
    const b = await touch.page.locator('#map .mk[data-id="seolaksan"]').boundingBox();
    await touch.page.touchscreen.tap(b.x + 22, b.y + 22);
    check('touch: 겹친 기호를 탭하면 선택창', await touch.page.locator('.chooser').isVisible() && (await touch.page.locator('.chooser-item').count()) === 2);
    await touch.page.locator('.chooser-item[href="#/m/bukhansan"]').tap();
    await waitMountain(touch.page, '북한산');
    check('touch: 탭으로 고른 산 시트(다크)', hashOf(touch.page) === '#/m/bukhansan');
    await touch.ctx.close();
  });

  // ---------- 지도 모듈이 늦을 때: 목록·시트는 먼저, 늦은 응답은 지금 화면을 건드리지 않음 ----------
  await step('slow map module', async () => {
    const slow = await newPage({}, { label: 'slow-map' });
    let release;
    const gate = new Promise((r) => { release = r; });
    await slow.page.route(/\/assets\/leaflet-[^/]+\.js$/, async (r) => { await gate; await r.continue().catch(() => {}); });
    try {
      await slow.page.goto(base + '/#/map');
      await slow.page.waitForSelector('.sheet .rows a.row');
      check('slow map: 지도 모듈 전에 목록이 뜸', await slow.page.locator('#map .map-loading').isVisible() && (await count(slow.page)) === mountains.length);
      await slow.page.locator('.tb-input').fill('설악');
      check('slow map: 검색으로 목록 좁히기', (await count(slow.page)) === filterMountains(mountains, { q: '설악' }).length && hashOf(slow.page).includes('q='));
      await slow.page.locator('.tb-input').press('Enter');      // 제안 없이 Enter = 목록 검색 확정(시트를 펼친다)
      check('slow map: Enter로 목록 검색 확정 → 시트 펼침', (await detent(slow.page)) === 'half');
      await (await visibleRow(slow.page, 0)).click();
      await slow.page.waitForSelector('.mt-title');
      await slow.page.waitForSelector('#mt-panel-courses .mt-crow');
      check('slow map: 산 시트·코스는 지도 없이도', (await slow.page.locator('#mt-panel-courses .mt-crow').count()) > 0);
      await slow.page.locator('.mt-hike').click();
      check('slow map: 등정 기록 대화상자', await slow.page.locator('dialog.record-dialog').isVisible());
      await slow.page.getByRole('button', { name: '취소', exact: true }).click();
      await slow.page.locator('.tb a[href="#/track"]').click();
      await slow.page.waitForSelector('.pg-track');
      release();
      await slow.page.waitForTimeout(1500);
      check('slow map: 늦게 온 지도가 지금 화면을 바꾸지 않음', hashOf(slow.page) === '#/track' && await slow.page.locator('.pg-track').isVisible() && !(await slow.page.locator('.shell').isVisible()));
      await slow.page.goBack();
      await slow.page.waitForSelector('.mt-title');
      await slow.page.waitForFunction(() => document.querySelectorAll('#map .mk').length > 0);
      check('slow map: 돌아오면 지도가 정상', (await slow.page.locator('#map .mk.selected').count()) === 1);
    } finally { release(); await slow.ctx.close(); }
  });

  // ---------- 자료·지도 실패에서 회복 ----------
  await step('failures', async () => {
    const fctx = await browser.newContext({ viewport: VIEW });
    await stubNetwork(fctx);
    const f = await fctx.newPage();
    f.on('pageerror', (e) => errors.push('[failure] pageerror: ' + e.message));
    let failData = true;
    await f.route('**/data/mountains.json', (r) => (failData ? r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : r.continue()));
    await f.goto(base + '/#/map');
    await f.getByRole('alert').waitFor();
    check('failure: 자료를 못 받으면 경고와 다시 불러오기', await f.getByRole('button', { name: '다시 불러오기', exact: true }).isVisible());
    failData = false;
    await f.getByRole('button', { name: '다시 불러오기', exact: true }).click();
    await waitForShell(f);
    check('failure: 다시 불러오면 지금 주소에서 복구', hashOf(f) === '#/map' && (await count(f)) === mountains.length);

    await f.route(/\/assets\/leaflet-[^/]+\.js$/, (r) => r.abort());
    await f.reload();
    await f.waitForSelector('.sheet .rows a.row');
    await f.waitForSelector('#map .map-error', { timeout: 10000 });
    check('failure: 지도 실패는 설명을 보여 줌', await f.locator('#map .map-error').isVisible() && (await f.locator('#map .map-error').textContent()).includes('지도를 불러오지 못했습니다'));
    await f.locator('.tb-input').fill('설악');
    check('failure: 지도가 없어도 검색·목록', (await count(f)) === filterMountains(mountains, { q: '설악' }).length);
    await f.locator('.tb-input').press('Enter');
    await (await visibleRow(f, 0)).click();
    await f.waitForSelector('#mt-panel-courses .mt-crow');
    check('failure: 지도가 없어도 코스 행', (await f.locator('#mt-panel-courses .mt-crow').count()) > 0);
    await f.locator('#mt-panel-courses .mt-crow-link').first().click();
    await waitRoute(f);
    check('failure: 지도가 없어도 경로 시트(수치·출처)', (await f.locator('.rt-prov').textContent()).length > 0);
    await f.locator('.rt-back').click();
    await f.locator('.mt-hike').click();
    check('failure: 지도가 없어도 등정 기록', await f.locator('dialog.record-dialog').isVisible());
    await fctx.close();
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
