// UX regression checks against a built site; defaults to dist (use an OSM build for map checks).
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { filterMountains, matchingCourses } from '../src/data.js';
const dist = resolve(process.env.SMOKE_DIST || 'dist');
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' };
const server = createServer(async (req,res) => {
  const path = resolve(dist, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  try { res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');res.end(await readFile(path)); }
  catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base = process.env.UX_BASE_URL || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({args:['--no-sandbox']});
const page = await browser.newPage({viewport:{width:390,height:844}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let count=0;
const check=(name,condition)=>{assert.ok(condition,name);console.log('PASS',name);count++;};
const go=async path=>{await page.goto(base+'/#'+path);await page.waitForSelector(path.startsWith('/m/')?'.detail-contents button':path==='/track'?'.stat-card':path.startsWith('/map')?'.mtn-item, .mtn-list .empty':'.mtn-card');};
try {
  const {mountains}=JSON.parse(await readFile(dist+'/data/mountains.json'));
  for(const q of ['단풍','억새','계곡','대중교통']) {
    await go('/map?q='+encodeURIComponent(q));
    const expected=filterMountains(mountains,{q});
    check('theme '+q,expected.length>0 && await page.locator('.mtn-item').count()===expected.length);
  }
  const fixture={trails:[{difficulty:'보통',round_trip_hours:6,distance_km:3},{difficulty:'어려움',round_trip_hours:2,distance_km:2}]};
  check('conditions must match the SAME course',matchingCourses(fixture,{easy:true,maxHours:4}).length===0);
  check('unknown duration excluded',matchingCourses({trails:[{difficulty:'쉬움'}]},{maxHours:4}).length===0);
  await go('/');
  check('first mountain on initial mobile screen',await page.locator('.mtn-card').first().evaluate(n=>n.getBoundingClientRect().top<700));
  check('mobile shortcuts are 44px targets',await page.locator('.hchip').evaluateAll(ns=>ns.every(n=>n.getBoundingClientRect().height>=44)));
  const easySection=page.locator('.curation').filter({hasText:'4시간 이내 쉬움·보통 코스'});
  const easyNames=await easySection.locator('.mtn-card').evaluateAll(ns=>ns.map(n=>n.getAttribute('href')));
  await easySection.locator('.sec-more').click();await page.waitForSelector('.mtn-item');
  check('beginner view retains criteria',page.url().includes('easy=1')&&page.url().includes('hours=4'));
  const easyResults=await page.locator('.mtn-item').evaluateAll(ns=>ns.map(n=>n.getAttribute('href')));
  check('beginner cards included in all results',easyNames.every(h=>easyResults.includes(h)));
  await page.locator('.filter-details summary').click();await page.getByLabel('코스 거리',{exact:true}).selectOption('5');
  check('distance filter updates URL',page.url().includes('distance=5'));
  const ids=await page.locator('.mtn-item').evaluateAll(ns=>ns.map(n=>n.dataset.id));
  check('course constraints respected',ids.length>0&&ids.every(id=>matchingCourses(mountains.find(m=>m.id===id),{easy:true,maxHours:4,maxDistance:5}).length));
  await go('/map');
  check('mobile filters collapsed',!await page.locator('.filter-details').evaluate(n=>n.open));
  check('at least three result rows visible',await page.locator('.mtn-item').evaluateAll(ns=>ns.filter(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<786;}).length)>=3);
  await page.locator('.filter-details summary').click();await page.locator('[data-region="제주"]').click();
  const filteredURL=page.url();check('region persisted in URL',decodeURIComponent(filteredURL).includes('제주'));
  await page.locator('.mtn-item').click();await page.waitForSelector('.detail-contents button');await page.goBack();await page.waitForSelector('.mtn-item');
  check('back preserves region and results',await page.locator('.mtn-item').count()===1&&await page.locator('[data-region="제주"]').getAttribute('aria-pressed')==='true');
  await page.reload();await page.waitForSelector('.mtn-item');check('reload preserves filters',await page.locator('.mtn-item').count()===1);
  await go('/map');await page.locator('.panel').evaluate(n=>n.scrollTop=600);
  const scroll=await page.locator('.panel').evaluate(n=>n.scrollTop);
  const visible=page.locator('.mtn-item').nth(5);await visible.click();await page.waitForSelector('.detail-contents button');await page.goBack();await page.waitForSelector('.mtn-item');await page.waitForTimeout(200);
  check('back restores list scroll',Math.abs(await page.locator('.panel').evaluate(n=>n.scrollTop)-scroll)<5);
  await page.getByRole('button',{name:'지도 보기',exact:true}).click();check('map mode visible',await page.locator('#map').isVisible()&&!await page.locator('.panel').isVisible());
  await page.getByRole('button',{name:'목록 보기',exact:true}).click();check('list mode returns',await page.locator('.panel').isVisible());
  await go('/m/seolaksan');
  check('courses precede map and GPX',await page.evaluate(()=>document.querySelector('.course-section').offsetTop<document.querySelector('.detail-map-wrap').offsetTop));
  check('advanced sections collapsed',await page.locator('.info-disclosure').evaluateAll(ns=>ns.length>=4&&ns.every(n=>!n.open)));
  await page.locator('.course-directions summary').first().click();
  const road=await page.getByRole('link',{name:'자동차 경로 검색',exact:true}).getAttribute('href');
  check('directions use verified trailhead, not summit',road.includes('destination=38.08208,128.45043')&&!road.includes('38.119546'));
  const transit=await page.getByRole('link',{name:'대중교통 경로 검색',exact:true}).getAttribute('href');check('transit mode explicit',transit.includes('travelmode=transit'));
  check('uncertain trailhead uses place search',await page.locator('.course-directions').nth(1).locator('a').getAttribute('href').then(h=>h.includes('/link/search/')));
  await page.getByRole('button',{name:'코스별 경로 GPX',exact:true}).click();await page.waitForSelector('.gpxdl-item');check('contents opens collapsed GPX',await page.locator('.gpxdl-item').first().isVisible());
  await page.locator('.hike-btn').click();await page.getByLabel('산행일',{exact:true}).fill('2024-05-12');await page.getByRole('button',{name:'기록 저장',exact:true}).click();
  check('selected hike date persisted',await page.evaluate(()=>JSON.parse(localStorage.getItem('kr100:hiked')).seolaksan==='2024-05-12'));
  await go('/track');check('journal shows selected date',(await page.locator('.mtn-meta').innerText()).includes('2024-05-12'));
  await page.getByRole('button',{name:'날짜 수정',exact:true}).click();await page.getByLabel('산행일',{exact:true}).fill('2024-05-13');await page.getByRole('button',{name:'기록 저장',exact:true}).click();
  await page.getByRole('button',{name:'삭제',exact:true}).click();check('deleted record removed',await page.locator('.journal-page .mtn-item').count()===0);
  await page.getByRole('button',{name:'실행 취소',exact:true}).click();check('undo restores edited date',(await page.locator('.mtn-meta').innerText()).includes('2024-05-13'));
  await page.reload();await page.waitForSelector('.mtn-meta');check('restored record survives reload',(await page.locator('.mtn-meta').innerText()).includes('2024-05-13'));
  await page.getByRole('button',{name:'날짜 수정',exact:true}).click();await page.getByLabel('산행일',{exact:true}).fill('2999-01-01');await page.getByRole('button',{name:'기록 저장',exact:true}).click();check('future date rejected',await page.locator('dialog').isVisible());await page.getByRole('button',{name:'취소',exact:true}).click();
  // Preserve a user-panned viewport, not just the filter's default map extent.
  await page.setViewportSize({width:1440,height:900});await go('/map');
  await page.locator('.panel .mtn-item').first().evaluate(n=>n.click());await page.waitForSelector('.detail-contents button');
  const initialMap=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('kr100:explore:#/map')).viewport);
  await page.goBack();await page.waitForSelector('.mtn-item');await page.waitForTimeout(250);
  const box=await page.locator('#map').boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+170,box.y+box.height/2+90,{steps:12});await page.mouse.up();await page.waitForTimeout(800);
  await page.locator('.panel .mtn-item').first().evaluate(n=>n.click());await page.waitForSelector('.detail-contents button');
  const movedMap=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('kr100:explore:#/map')).viewport);
  check('test pans map to a different center',JSON.stringify(initialMap.center)!==JSON.stringify(movedMap.center));
  await page.goBack();await page.waitForSelector('.mtn-item');await page.waitForTimeout(250);
  await page.locator('.panel .mtn-item').first().evaluate(n=>n.click());await page.waitForSelector('.detail-contents button');
  const restoredMap=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('kr100:explore:#/map')).viewport);
  // Kakao projects centers to screen pixels; allow at most two pixels of rounding.
  check('back restores map viewport within two pixels',Math.abs(restoredMap.center[0]-movedMap.center[0])<=2*movedMap.span[0]/box.height&&Math.abs(restoredMap.center[1]-movedMap.center[1])<=2*movedMap.span[1]/box.width&&(restoredMap.zoom??restoredMap.level)===(movedMap.zoom??movedMap.level));
  await mkdir('/tmp/ux-complete',{recursive:true});
  for(const theme of ['light','dark']) {await page.emulateMedia({colorScheme:theme});for(const width of [320,390,768,1440]) {await page.setViewportSize({width,height:900});for(const path of ['/','/map','/m/seolaksan','/track']) {await go(path);check(`layout ${theme} ${width} ${path}`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(width===390||width===1440) await page.screenshot({path:`/tmp/ux-complete/${theme}-${width}-${path.replaceAll('/','_')}.png`});}}}
  // Late map initialization must not replace the route the user has moved to.
  const slowContext = await browser.newContext({viewport:{width:390,height:844}});
  const slow = await slowContext.newPage(); slow.on('pageerror',e=>errors.push(e.message));
  let releaseMap;
  const mapGate = new Promise(resolve=>{releaseMap=resolve;});
  await slow.route(/(?:providers\/(?:kakao|leaflet)|assets\/(?:kakao|leaflet)-[^/]+)\.js(?:\?.*)?$/,async route=>{await mapGate;await route.continue().catch(()=>{});});
  try {
    await slow.goto(base+'/#/map',{waitUntil:'domcontentloaded'});
    await slow.waitForSelector('.explore-loading');
    await slow.locator('.panel .search').fill('설악');
    await slow.locator('.nav a[data-route="track"]').click();
    await slow.waitForSelector('.stat-card');
    releaseMap(); await slow.waitForTimeout(1500);
    check('late map response preserves current route',slow.url().endsWith('#/track')&&await slow.locator('.stat-card').count()===5);
    check('late map response cannot mount an old page',await slow.locator('.home').count()===0);
  } finally {releaseMap();await slowContext.close();}
  check('no runtime errors',errors.length===0);console.log(`${count} UX checks passed`);
} finally {await browser.close();await new Promise(r=>server.close(r));}
