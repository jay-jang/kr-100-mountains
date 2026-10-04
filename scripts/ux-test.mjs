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
  for(const q of ['단풍','억새','계곡','대중교통','수도권']) {
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
  const homeSearch = page.getByRole('combobox', { name: '산 이름·지역 검색' });
  await homeSearch.fill('설악');
  await homeSearch.press('ArrowDown');
  check('home search announces keyboard selection', await homeSearch.getAttribute('aria-activedescendant') === 'home-suggestion-0');
  await page.getByRole('button', { name: '테마 전환', exact: true }).click();
  check('theme update preserves home search query', await homeSearch.inputValue() === '설악');
  // Leave later light/dark checks controlled by the system setting.
  await page.evaluate(() => { document.documentElement.removeAttribute('data-theme'); localStorage.removeItem('kr100:theme'); });
  await homeSearch.focus(); await homeSearch.press('ArrowDown'); await homeSearch.press('Enter');
  await page.waitForSelector('.detail-return');
  check('home search keyboard opens selected mountain', page.url().endsWith('/m/seolaksan'));
  check('home detail returns to home', await page.locator('.detail-return').getAttribute('href') === '#/');
  await page.locator('.detail-return').click(); await page.waitForSelector('.dash-search');
  await homeSearch.fill('찾을수없는산');
  check('home search explains no matches', await page.locator('.search-empty').isVisible());
  await homeSearch.press('Escape');
  check('escape closes suggestions and preserves query', !await page.locator('.dash-suggest').isVisible() && await homeSearch.inputValue() === '찾을수없는산');
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
  await page.locator('.filter-details summary').click();
  check('applied filters remain visible when collapsed', await page.getByRole('button', { name: '왕복 4시간 이내 조건 해제', exact: true }).isVisible());
  await page.getByRole('button', { name: '왕복 4시간 이내 조건 해제', exact: true }).click();
  check('individual filter removal preserves other constraints', !page.url().includes('hours=') && page.url().includes('easy=1') && page.url().includes('distance=5'));
  check('removed filter retains keyboard focus', await page.locator('.active-filters').evaluate(n => n.contains(document.activeElement)));
  await go('/map?region='+encodeURIComponent('제주')+'&q='+encodeURIComponent('설악'));
  check('empty results explain recovery', await page.getByRole('button', { name: '모든 조건 초기화', exact: true }).isVisible());
  await page.getByRole('button', { name: '제주 조건 해제', exact: true }).click();
  check('remove conflicting region keeps search', await page.locator('.mtn-item').count() === filterMountains(mountains,{q:'설악'}).length && page.url().includes('q='));
  await go('/map');
  check('mobile filters collapsed',!await page.locator('.filter-details').evaluate(n=>n.open));
  check('at least three result rows visible',await page.locator('.mtn-item').evaluateAll(ns=>ns.filter(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<786;}).length)>=3);
  await page.locator('.filter-details summary').click();await page.locator('[data-region="제주"]').click();
  const filteredURL=page.url();check('region persisted in URL',decodeURIComponent(filteredURL).includes('제주'));
  await page.locator('.mtn-item').click();await page.waitForSelector('.detail-contents button');await page.goBack();await page.waitForSelector('.mtn-item');
  check('back preserves region and results',await page.locator('.mtn-item').count()===1&&await page.locator('[data-region="제주"]').getAttribute('aria-pressed')==='true');
  await page.reload();await page.waitForSelector('.mtn-item');check('reload preserves filters',await page.locator('.mtn-item').count()===1);
  await page.locator('.mtn-item').click(); await page.waitForSelector('.detail-return');
  check('detail return link preserves complete search URL', await page.locator('.detail-return').getAttribute('href') === new URL(filteredURL).hash);
  await page.reload(); await page.waitForSelector('.detail-return');
  check('detail reload retains return context', await page.locator('.detail-return').getAttribute('href') === new URL(filteredURL).hash);
  await page.locator('.detail-return').click(); await page.waitForSelector('.mtn-item');
  check('detail return link restores region results', await page.locator('.mtn-item').count() === 1);
  await go('/map');await page.locator('.panel').evaluate(n=>n.scrollTop=600);
  const scroll=await page.locator('.panel').evaluate(n=>n.scrollTop);
  const visible=page.locator('.mtn-item').nth(5);await visible.click();await page.waitForSelector('.detail-contents button');await page.goBack();await page.waitForSelector('.mtn-item');await page.waitForTimeout(200);
  check('back restores list scroll',Math.abs(await page.locator('.panel').evaluate(n=>n.scrollTop)-scroll)<5);
  await page.getByRole('button',{name:'지도 보기',exact:true}).click();check('map mode visible',await page.locator('#map').isVisible()&&!await page.locator('.panel').isVisible());
  await page.getByRole('button',{name:'목록 보기',exact:true}).click();check('list mode returns',await page.locator('.panel').isVisible());
  await go('/m/seolaksan');
  check('map precedes contents, courses and overview',await page.evaluate(()=>{
    const map=document.querySelector('.detail-map-wrap');
    return [...document.querySelectorAll('.detail-contents, .detail-page > .section:not(.planning-section)')].every(n=>map.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  check('map dominates the initial mobile screen',await page.locator('#detail-map').evaluate(n=>{const b=n.getBoundingClientRect();return scrollY===0&&b.top<innerHeight*.4&&b.height>=innerHeight*.45&&b.width>=innerWidth*.85;}));
  check('route planner starts collapsed beneath map',await page.locator('.planner-disclosure').evaluate(n=>!n.open));
  await page.locator('.planner-disclosure > summary').click();
  check('route planner can be opened',await page.locator('.route-planner').isVisible());
  await page.locator('.planner-disclosure > summary').click();
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
  const addSearch = page.getByRole('combobox', { name: '기록할 산 검색' });
  await addSearch.fill('한라'); await addSearch.press('ArrowDown'); await addSearch.press('Enter');
  await page.getByLabel('산행일', { exact: true }).fill('2024-06-01');
  await page.getByRole('button', { name: '기록 저장', exact: true }).click();
  check('journal adds a hike without leaving page', page.url().endsWith('#/track') && await page.locator('.record-list .mtn-item').count() === 2);
  check('saved record has visible confirmation', (await page.locator('.record-toast').innerText()).includes('2024-06-01'));
  const recordSearch = page.getByLabel('내 기록 검색', { exact: true });
  await recordSearch.fill('설악');
  check('journal search narrows existing hikes', await page.locator('.record-list .mtn-item').count() === 1);
  await recordSearch.type('없는산');
  check('journal typing preserves input focus', await recordSearch.evaluate(n => document.activeElement === n));
  await page.getByRole('button', { name: '기록 검색 초기화', exact: true }).click();
  check('journal search reset restores hikes', await page.locator('.record-list .mtn-item').count() === 2);
  await page.getByLabel('내 기록 정렬', { exact: true }).selectOption('name');
  const expectedNames = ['설악산', '한라산'].sort((a,b) => a.localeCompare(b, 'ko'));
  check('journal sort uses mountain names', (await page.locator('.record-list .mtn-name').allTextContents()).every((name,i) => name.includes(expectedNames[i])));
  await page.locator('.record-list .mtn-name').first().click(); await page.waitForSelector('.detail-return');
  check('journal detail returns to records', await page.locator('.detail-return').getAttribute('href') === '#/track');
  await page.locator('.detail-return').click(); await page.waitForSelector('.stat-card');
  const importFile = async value => {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: '가져오기', exact: true }).click(),
    ]);
    await chooser.setFiles({ name: 'hikes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
    await page.waitForFunction(() => document.querySelector('.data-feedback')?.textContent.length > 0);
  };
  const beforeImport = await page.evaluate(() => localStorage.getItem('kr100:hiked'));
  for (const bad of [[], { version:1, hiked:{seolaksan:'2020-01-01',hanrasan:'2024-02-30'} }, {version:1,hiked:{seolaksan:'2999-01-01'}}, {version:2,hiked:{}}]) {
    await page.evaluate(() => { document.querySelector('.data-feedback').textContent = ''; });
    await importFile(bad);
    check('invalid import leaves existing hikes unchanged', await page.evaluate(() => localStorage.getItem('kr100:hiked')) === beforeImport && (await page.locator('.data-feedback').innerText()).includes('가져오지 못했습니다'));
  }
  await page.evaluate(() => { document.querySelector('.data-feedback').textContent = ''; });
  await importFile({version:1,hiked:{bukhansan:'2024-07-01', unknown:'2024-07-01'}});
  check('import merges known hikes and explains skipped entries', await page.locator('.record-list .mtn-item').count() === 3 && (await page.locator('.data-feedback').innerText()).includes('1개 항목은 제외'));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '내보내기 (JSON)', exact: true }).click();
  const exported = JSON.parse(await readFile(await (await download).path(), 'utf8'));
  check('export contains current edited and imported hikes', exported.version === 1 && exported.hiked.seolaksan === '2024-05-13' && exported.hiked.bukhansan === '2024-07-01');
  // Preserve a user-panned viewport, not just the filter's default map extent.
  await page.setViewportSize({width:1440,height:900});await go('/map');
  await page.waitForSelector('.map-ctrl');
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
  await page.goBack();await page.waitForSelector('.map-ctrl');
  await page.locator('.panel .search').fill('한라');await page.waitForTimeout(1400);
  await page.locator('.panel .mtn-item').first().evaluate(n=>n.click());await page.waitForSelector('.detail-contents button');
  const searchMap=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('kr100:explore:#/map?q='+encodeURIComponent('한라'))).viewport);
  const hallasan=mountains.find(m=>m.name==='한라산');
  check('restored map responds to a new search',Math.abs(searchMap.center[0]-hallasan.lat)<0.5 && Math.abs(searchMap.center[1]-hallasan.lon)<0.5);
  await mkdir('/tmp/ux-complete',{recursive:true});
  for(const theme of ['light','dark']) {await page.emulateMedia({colorScheme:theme});for(const width of [320,390,768,1440]) {await page.setViewportSize({width,height:900});for(const path of ['/','/map','/m/seolaksan','/track']) {await go(path);check(`layout ${theme} ${width} ${path}`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(path.startsWith('/m/')) check(`map first screen ${theme} ${width}`,await page.locator('#detail-map').evaluate(n=>{const b=n.getBoundingClientRect();return scrollY===0&&b.top<innerHeight*.4&&b.height>=innerHeight*.45&&b.width>=innerWidth*.8;}));if(width===390||width===1440) await page.screenshot({path:`/tmp/ux-complete/${theme}-${width}-${path.replaceAll('/','_')}.png`});}}}
  // Late map initialization must not replace the route the user has moved to.
  const slowContext = await browser.newContext({viewport:{width:390,height:844}});
  const slow = await slowContext.newPage(); slow.on('pageerror',e=>errors.push(e.message));
  let releaseMap;
  const mapGate = new Promise(resolve=>{releaseMap=resolve;});
  await slow.route(/(?:providers\/(?:kakao|leaflet)|assets\/(?:kakao|leaflet)-[^/]+)\.js(?:\?.*)?$/,async route=>{await mapGate;await route.continue().catch(()=>{});});
  try {
    await slow.goto(base+'/#/map',{waitUntil:'domcontentloaded'});
    await slow.waitForSelector('.mtn-item');
    await slow.waitForSelector('.explore-loading', {state:'attached'});
    await slow.locator('.panel .search').fill('설악');
    check('list filters work while map module is pending', await slow.locator('.mtn-item').count() === filterMountains(mountains,{q:'설악'}).length && slow.url().includes('q='));
    await slow.locator('.mtn-item').first().click(); await slow.waitForSelector('.detail-contents button');
    check('detail and contents available before map module', await slow.locator('.course-section').isVisible() && await slow.locator('#detail-map .explore-loading').count() === 1);
    await slow.locator('.hike-btn').click();
    check('record dialog works while map module is pending', await slow.locator('dialog').isVisible());
    await slow.getByRole('button', {name:'취소',exact:true}).click();
    await slow.locator('.nav a[data-route="track"]').click();
    await slow.waitForSelector('.stat-card');
    releaseMap(); await slow.waitForTimeout(1500);
    check('late map response preserves current route',slow.url().endsWith('#/track')&&await slow.locator('.stat-card').count()===5);
    check('late map response cannot mount an old page',await slow.locator('.home').count()===0);
  } finally {releaseMap();await slowContext.close();}
  const failureContext = await browser.newContext({viewport:{width:390,height:844}});
  const failure = await failureContext.newPage(); failure.on('pageerror',e=>errors.push(e.message));
  let failData = true;
  await failure.route('**/data/mountains.json', async route => {
    if (failData) await route.fulfill({status:503,contentType:'application/json',body:'{}'});
    else await route.continue();
  });
  await failure.route(/(?:providers\/(?:kakao|leaflet)|assets\/(?:kakao|leaflet)-[^/]+)\.js(?:\?.*)?$/,route=>route.abort());
  try {
    await failure.goto(base+'/#/map');
    await failure.getByRole('button',{name:'다시 시도',exact:true}).waitFor();
    check('data load failure has a recovery action',await failure.getByRole('alert').isVisible());
    failData = false;
    await failure.getByRole('button',{name:'다시 시도',exact:true}).click();
    await failure.waitForSelector('.mtn-item');
    check('retry recovers the current route',failure.url().endsWith('#/map') && await failure.locator('.mtn-item').count()===mountains.length);
    await failure.waitForSelector('.map-error',{state:'attached'});
    await failure.getByRole('button',{name:'지도 보기',exact:true}).click();
    check('map failure shows a usable explanation',await failure.locator('.map-error').isVisible());
    await failure.getByRole('button',{name:'목록 보기',exact:true}).click();
    await failure.locator('.panel .search').fill('설악');
    check('failed map does not disable list search',await failure.locator('.mtn-item').count()===filterMountains(mountains,{q:'설악'}).length);
    await failure.locator('.mtn-item').first().click();await failure.waitForSelector('.detail-contents button');
    check('failed map preserves course details',await failure.locator('.trail-card').count()>0);
    await failure.locator('.hike-btn').click();
    check('failed map preserves record entry',await failure.locator('dialog').isVisible());
  } finally {await failureContext.close();}
  // Real pointer and keyboard interaction with deliberately overlapping mountains.
  for(const width of [320,390,1440]) {
    const context=await browser.newContext({viewport:{width,height:900}});
    const mapPage=await context.newPage();mapPage.on('pageerror',e=>errors.push(e.message));
    const clustered=mountains.filter(m=>['seolaksan','bukhansan','hallasan'].includes(m.id)).map(m=>({...m,lat:m.id==='hallasan'?39:36.5,lon:m.id==='hallasan'?130:127.9}));
    await mapPage.route('**/data/mountains.json',r=>r.fulfill({json:{mountains:clustered}}));
    try {
      await mapPage.goto(base+'/#/map');await mapPage.waitForSelector('.map-ctrl',{state:'attached'});
      if(width<860) await mapPage.getByRole('button',{name:'지도 보기',exact:true}).click();
      await mapPage.waitForTimeout(250);
      // Choose the topmost of the two coincident pins, away from its visible dot.
      const topPin=await mapPage.locator('#map .mountain-marker').evaluateAll(ns=>ns.filter(n=>['설악산','북한산'].includes(n.getAttribute('aria-label'))).at(-1).getAttribute('aria-label'));
      const target=mapPage.getByRole('button',{name:topPin,exact:true});
      check(`mountain touch target ${width}`,await target.evaluate(n=>{const b=n.getBoundingClientRect();return b.width>=44&&b.height>=44;}));
      await target.click({position:{x:4,y:22}});
      check(`marker edge opens overlapping mountain choices ${width}`,await mapPage.locator('.mountain-map-picker').isVisible()&&await mapPage.locator('.map-mountain-choice').count()===2);
      await mapPage.locator('.map-mountain-choice[data-id="seolaksan"]').click();
      check(`overlapping mountain can be chosen by name ${width}`,await mapPage.locator('.pop-link[href="#/m/seolaksan"]').isVisible());
      await target.focus();await target.press('Enter');
      check(`mountain markers work from keyboard ${width}`,await mapPage.locator('.mountain-map-picker').isVisible());
      check(`mountain chooser receives keyboard focus ${width}`,await mapPage.locator('.map-mountain-choice').first().evaluate(n=>n===document.activeElement));
      await mapPage.locator('.map-mountain-choice[data-id="seolaksan"]').press('Enter');
      await target.focus();await target.press('Enter');
      await mapPage.getByRole('button',{name:'산 선택 닫기',exact:true}).click();
      await mapPage.getByRole('button',{name:'전체화면',exact:true}).click();await mapPage.waitForFunction(()=>document.fullscreenElement!==null);
      await mapPage.waitForTimeout(250);
      await target.click({position:{x:4,y:22}});
      check(`mountain choices work in fullscreen ${width}`,await mapPage.locator('.mountain-map-picker').isVisible());
      await mapPage.locator('.map-mountain-choice[data-id="seolaksan"]').click();
      await mapPage.locator('.pop-link[href="#/m/seolaksan"]').click();await mapPage.waitForSelector('.hero h2');
      check(`chosen mountain opens correct detail ${width}`,(await mapPage.locator('.hero h2').textContent())==='설악산');
    } finally {await context.close();}
  }
  check('no runtime errors',errors.length===0);console.log(`${count} UX checks passed`);
} finally {await browser.close();await new Promise(r=>server.close(r));}
