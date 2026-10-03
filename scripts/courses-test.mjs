// Representative-course coverage and browsing flows on local builds or Pages.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const dist = resolve(process.env.SMOKE_DIST || 'dist');
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(dist, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream'); res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = (process.env.UX_BASE_URL || `http://127.0.0.1:${server.address().port}`).replace(/\/$/, '');
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); console.log('PASS', name); checks++; };
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  // Fetch the actual target's dataset; the same checks validate the published release.
  const response = await page.request.get(base + '/data/mountains.json');
  const { mountains, meta } = await response.json();
  const byId = new Map(mountains.map(m => [m.id, m]));
  const courses = mountains.flatMap(m => m.famous_courses || []);
  check('all 149 mountains have a separate shortlist', mountains.length === 149 && mountains.every(m => m.famous_courses?.length));
  check('global course IDs are unique', new Set(courses.map(c => c.id)).size === courses.length);
  check('no corrupted course names or route points', courses.every(c => !JSON.stringify(c).includes('\uFFFD')));
  check('all course references retain their scope', courses.every(c => c.sources?.length && c.sources.every(s => s.scope === (c.evidence === 'official' ? 'course' : 'mountain') && /^https?:/.test(s.url))));
  check('official references include a confirmation date', courses.filter(c => c.evidence === 'official').every(c => c.sources.every(s => /^\d{4}-\d{2}-\d{2}$/.test(s.checked_at))));
  check('legacy trail links resolve exactly', mountains.every(m => m.famous_courses.every(c => c.trail_index == null || m.trails[c.trail_index]?.name === c.trail_name)));
  check('famous-course metadata matches coverage', meta.famous_courses.courses === courses.length && meta.famous_courses.official === courses.filter(c => c.evidence === 'official').length);
  check('Seoraksan includes Ulsanbawi and Gongryong', ['울산바위','공룡능선'].every(name => byId.get('seolaksan').famous_courses.some(c => c.name.includes(name))));
  check('Hwa-dae traverse starts at Hwaeomsa', byId.get('jirisan').famous_courses.filter(c => c.name.includes('화대')).every(c => c.name.startsWith('화엄사')));
  check('Hallasan plateau courses do not lead to Baengnokdam', byId.get('hanrasan').famous_courses.filter(c => /영실|어리목/.test(c.name)).length === 2 && byId.get('hanrasan').famous_courses.filter(c => /영실|어리목/.test(c.name)).every(c => !c.via.includes('백록담') && c.highlight.includes('연결되지')));
  await page.goto(base + '/#/courses');
  await page.waitForSelector('.famous-mountain');
  check('catalogue visibly covers every mountain', await page.locator('.famous-mountain').count() === 149 && await page.locator('.famous-course').count() === courses.length);
  check('catalogue is a discoverable active menu', await page.locator('.nav a[aria-current="page"]').textContent() === '대표 코스');
  check('catalogue page has a distinct document title', (await page.title()).includes('대표·유명 코스'));
  await page.locator('.courses-policy summary').click();
  check('selection policy distinguishes ranking and legacy scope', (await page.locator('.courses-policy').innerText()).includes('인기 순위는 아닙니다') && (await page.locator('.courses-policy').innerText()).includes('인기도를 별도로 검증하지 않았습니다'));
  await page.getByLabel('산·코스 검색', { exact:true }).fill('설악 공룡');
  check('multiword search narrows to a single named route', await page.locator('.famous-course').count() === 1 && await page.locator('.famous-mountain').getAttribute('data-mountain-id') === 'seolaksan');
  await page.getByLabel('지역', { exact:true }).selectOption('강원');
  const catalogHash = new URL(page.url()).hash;
  await page.reload(); await page.waitForSelector('.famous-course');
  check('query and region survive reload', await page.getByLabel('산·코스 검색',{exact:true}).inputValue() === '설악 공룡' && await page.getByLabel('지역',{exact:true}).inputValue() === '강원');
  await page.locator('.famous-course h4 a').click();
  await page.waitForSelector('.famous-section .selected-course');
  check('route link opens the specific course in mountain detail', (await page.locator('.selected-course h4').textContent()).includes('공룡능선'));
  check('selected route is focused', await page.locator('.selected-course').evaluate(n => n === document.activeElement));
  check('detail contains both shortlist and full trail catalogue', await page.locator('.famous-section .famous-course').count() === byId.get('seolaksan').famous_courses.length && await page.locator('.trail-card').count() === byId.get('seolaksan').trails.length);
  check('shortlist precedes full trails and planning', await page.evaluate(() => document.querySelector('.famous-section').offsetTop < document.querySelector('.course-section').offsetTop && document.querySelector('.course-section').offsetTop < document.querySelector('.planning-section').offsetTop));
  check('off-summit famous routes do not get a fake summit map button', await page.locator('.famous-section .course-route-btn').count() === 0);
  check('detail return preserves catalogue filters', await page.locator('.detail-return').getAttribute('href') === catalogHash);
  await page.locator('.detail-return').click(); await page.waitForSelector('.famous-mountain');
  check('return restores matching course', await page.locator('.famous-course').count() === 1);
  await page.getByLabel('지역',{exact:true}).selectOption('제주');
  check('region and text filters intersect', await page.locator('.famous-course').count() === 0 && (await page.locator('.empty').innerText()).includes('조건에 맞는'));
  await page.getByRole('button', { name:'조건 초기화',exact:true }).click();
  check('empty-result reset restores all mountains', await page.locator('.famous-mountain').count() === 149 && new URL(page.url()).hash === '#/courses');
  await page.getByLabel('산·코스 검색',{exact:true}).fill('백운산');
  check('same-named mountains remain separate', await page.locator('.famous-mountain').count() === mountains.filter(m => m.name === '백운산').length);
  await page.goto(base + '/#/courses?q=' + encodeURIComponent('윗세오름'));
  await page.waitForSelector('.famous-course');
  check('plateau destination finds both Hallasan trails', await page.locator('.famous-course').count() === 2);
  await page.locator('.famous-mountain-title h3 a').click(); await page.waitForSelector('.famous-section');
  check('Hallasan detail lists four distinct destinations', await page.locator('.famous-section .famous-course').count() === 4);
  const link = page.locator('.famous-section .course-info-link').first();
  await link.click();
  check('shortlist links to the matching legacy trail', (await page.locator('.trail-card:focus .t-name').textContent()).includes('성판악'));
  await page.goto(base + '/#/map?q=' + encodeURIComponent('울산바위'));
  await page.waitForSelector('.mtn-item');
  check('existing mountain search finds newly listed famous courses', await page.locator('.mtn-item').count() === 1 && (await page.locator('.mtn-item').innerText()).includes('설악산'));
  await page.goto(base + '/#/courses'); await page.waitForSelector('.famous-mountain');
  await mkdir('shots', { recursive:true });
  for (const width of [320,390,1440]) {
    await page.setViewportSize({ width,height:900 });
    for (const theme of ['light','dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      check(`catalogue fits ${width}px ${theme}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if(width < 760) check(`four navigation targets fit ${width}px ${theme}`, await page.locator('.nav a[data-route]').evaluateAll(nodes => nodes.every(n => { const r=n.getBoundingClientRect();return r.width>=44 && r.height>=44 && r.left>=0 && r.right<=innerWidth+1; })));
      await page.screenshot({ path:`shots/courses-${width}-${theme}.png` });
    }
  }
  check('no browser errors', errors.length === 0);
  console.log(`Representative courses: ${checks} checks passed`);
} finally { await browser.close(); await new Promise(r => server.close(r)); }
