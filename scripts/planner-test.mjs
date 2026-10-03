import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const dist=resolve(process.env.SMOKE_DIST || 'dist');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.gpx':'application/gpx+xml'};
const server=createServer(async(req,res)=>{
  try { const path=resolve(dist,'.'+(req.url.split('?')[0]==='/'?'/index.html':decodeURIComponent(req.url.split('?')[0])));res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.end(await readFile(path)); }
  catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=process.env.UX_BASE_URL || `http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({args:['--no-sandbox']});
let checks=0;const check=(name,condition)=>{assert.ok(condition,name);checks++;console.log('PASS',name);};
const {mountains}=JSON.parse(await readFile(dist+'/data/mountains.json'));
const mountain=mountains.find(m=>m.id==='seolaksan'),lat=mountain.lat,lon=mountain.lon;
const A=[lat,lon-.01],J=[lat,lon],B=[lat,lon+.01],C=[lat+.006,lon+.005],D=[lat+.006,lon+.015];
const gpx=(name,segments)=>`<?xml version="1.0"?><gpx version="1.1"><trk><name>${name}</name>${segments.map(points=>`<trkseg>${points.map(p=>`<trkpt lat="${p[0]}" lon="${p[1]}"><ele>100</ele></trkpt>`).join('')}</trkseg>`).join('')}</trk></gpx>`;
const records=[
  {file:'routes/seolaksan/west.gpx',route_name:'서쪽 코스'},
  {file:'routes/seolaksan/east.gpx',route_name:'동쪽 코스'},
  {file:'routes/seolaksan/west.gpx',route_name:'서쪽 중복 코스'},
  {file:'routes/seolaksan/retry.gpx',route_name:'누락 코스'},
];
const entry={tracks:records,relations:[{file:'routes/osm-relations/loop.gpx',name:'순환 도보길'}]};
const files={'routes/seolaksan/west.gpx':gpx('서쪽',[[A,J]]),'routes/seolaksan/east.gpx':gpx('동쪽',[[J,B]]),'routes/seolaksan/retry.gpx':gpx('누락',[[C,D]]),'routes/osm-relations/loop.gpx':gpx('순환',[[J,C]])};
const osmLines=[[A,J],[J,B],[J,C],[C,D],[D,B],[A,[lat+.003,lon-.006],J]];
const fixture={elements:osmLines.map((line,i)=>({type:'way',id:100+i,tags:{highway:'path',name:`주변 등산로 ${i+1}`},geometry:line.map(([lat,lon])=>({lat,lon}))}))};
const errors=[];
async function configure(page,{failOSM=false,block=null,blockOSM=null}={}) {
  const counts=new Map();let active=0,maxActive=0,overpassCount=0,failRetry=true;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/gpx/routes/index.json',r=>r.fulfill({json:{mountains:[{mountain_id:'seolaksan',tracks:4,relations:1}]}}));
  await page.route('**/gpx/routes/m/seolaksan.json',r=>r.fulfill({json:entry}));
  await page.route('**/gpx/**/*.gpx',async r=>{
    const file=new URL(r.request().url()).pathname.split('/gpx/')[1];
    if(!files[file]) return r.continue();
    counts.set(file,(counts.get(file)||0)+1);active++;maxActive=Math.max(active,maxActive);
    try {
      if(block) await block;
      await new Promise(resolve=>setTimeout(resolve,100));
      if(file.endsWith('/retry.gpx')&&failRetry){failRetry=false;await r.fulfill({status:503,body:'temporary'});}
      else await r.fulfill({contentType:'application/gpx+xml',body:files[file]});
    } catch {} finally {active--;}
  });
  await page.route(/\/overpass\/.*interpreter$|\/api\/interpreter$/,async r=>{overpassCount++;if(block||blockOSM) await (block||blockOSM);try {if(failOSM) await r.abort();else await r.fulfill({json:fixture});}catch{}});
  await page.route('https://api.open-meteo.com/**',r=>{const u=new URL(r.request().url());return r.fulfill({json:{elevation:u.searchParams.get('latitude').split(',').map(()=>100)}});});
  return {counts,get maxActive(){return maxActive;},get overpassCount(){return overpassCount;}};
}
async function loaded(page){await page.waitForSelector('.map-ctrl');await page.getByRole('button',{name:'경로 모두 불러오기',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.planner-head button').disabled);}
async function add(page,label){const select=page.getByLabel('경로 위 지점 선택',{exact:true});const value=await select.locator('option').evaluateAll((options,label)=>options.find(o=>o.textContent===label)?.value,label);assert.ok(value,label);await select.selectOption(value);await page.getByRole('button',{name:'지점 추가',exact:true}).click();}
async function exportPlan(page){const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'계획 GPX 내려받기',exact:true}).click()]);return readFile(await download.path(),'utf8');}
try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();const requests=await configure(page);
  await page.goto(base+'/#/m/seolaksan');await loaded(page);
  check('loads tracks AND relations, deduplicating files',await page.locator('.route-tag').count()===3&&requests.counts.size===4&&requests.counts.get('routes/seolaksan/west.gpx')===1);
  check('GPX files load concurrently with bounded requests',requests.maxActive>=3&&requests.maxActive<=6);
  check('loads all six OSM ways instead of the old four-path limit',await page.locator('.route-item').count()===9&&requests.overpassCount===1);
  check('partial failure leaves available routes and explains retry',(await page.locator('.planner-status').textContent()).includes('1개 불러오기 실패'));
  await page.getByRole('button',{name:'누락된 경로 다시 불러오기',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.planner-head button').disabled);
  check('retry loads only missing files and reuses OSM network',await page.locator('.route-item').count()===10&&requests.counts.get('routes/seolaksan/retry.gpx')===2&&requests.counts.get('routes/seolaksan/west.gpx')===1&&requests.overpassCount===1);
  await add(page,'서쪽 중복 코스 · 시작 지점');await add(page,'순환 도보길 · 끝 지점');await add(page,'동쪽 코스 · 끝 지점');
  check('combines paths through ordered waypoints',await page.locator('.planner-waypoints li').count()===3&&(await page.locator('.planner-summary').textContent()).includes('2구간')&&await page.getByRole('button',{name:'계획 GPX 내려받기',exact:true}).isEnabled());
  const xml=await exportPlan(page);check('export contains the requested detour and planned provenance',xml.includes(C[0].toFixed(7))&&xml.includes('planned-hike')&&xml.includes('실측 기록이 아니며'));
  await mkdir('/tmp/mountain-planner',{recursive:true});await page.locator('.route-planner').scrollIntoViewIfNeeded();await page.screenshot({path:'/tmp/mountain-planner/connected-plan.png',fullPage:true});
  await page.getByRole('button',{name:'출발점으로 돌아오기',exact:true}).click();const round=await exportPlan(page);const points=[...round.matchAll(/trkpt lat="([^"]+)" lon="([^"]+)"/g)].map(m=>m.slice(1));
  check('round trip returns to the starting point',JSON.stringify(points[0])===JSON.stringify(points.at(-1))&&await page.locator('.planner-waypoints li').count()===4);
  await page.getByRole('button',{name:'4번 지점 삭제',exact:true}).click();await page.getByRole('button',{name:'진행 방향 뒤집기',exact:true}).click();
  check('reverse changes start without losing waypoint geometry',(await page.locator('.planner-waypoints li').first().textContent()).includes('동쪽 코스'));
  await page.getByRole('button',{name:'2번 지점 앞으로',exact:true}).click();check('waypoints can be reordered',(await page.locator('.planner-waypoints li').first().textContent()).includes('순환 도보길'));
  await page.reload();await page.waitForSelector('.map-ctrl');await page.waitForFunction(()=>!document.querySelector('.planner-head button').disabled&&document.querySelector('.planner-summary')?.textContent.includes('총'));
  check('plan persists and recalculates after reload',await page.locator('.planner-waypoints li').count()===3);
  await page.getByRole('button',{name:'등산로 목록에 추가',exact:true}).click();check('calculated plan can join the comparison list',await page.locator('.route-item').filter({hasText:'나의 계획'}).count()===1);
  await page.getByRole('button',{name:'등산로 목록에 추가',exact:true}).click();check('adding an edited plan replaces its previous copy',await page.locator('.route-item').filter({hasText:'나의 계획'}).count()===1);
  await page.getByRole('button',{name:'계획 초기화',exact:true}).click();
  check('reset clears waypoints and disables stale GPX export',await page.locator('.planner-waypoints li').count()===0&&!await page.getByRole('button',{name:'계획 GPX 내려받기',exact:true}).isEnabled());
  // Map center lies on a loaded branch; use the real provider's click.
  await page.getByRole('button',{name:'모든 경로 다시 보기',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.planner-head button').disabled);
  await page.getByRole('button',{name:'지도에서 지점 추가',exact:true}).click();
  const box=await page.locator('#detail-map').boundingBox();await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await page.waitForFunction(()=>document.querySelectorAll('.planner-waypoints li').length===1);
  check('map click adds a snapped waypoint',await page.locator('.planner-waypoints li').count()===1);
  check('map editing exposes inline status and undo',await page.locator('.planner-map-tools').isVisible()&&await page.getByRole('button',{name:'마지막 지점 취소',exact:true}).isEnabled());
  await page.getByRole('button',{name:'마지막 지점 취소',exact:true}).click();
  check('map editing can undo without leaving the map',await page.locator('.planner-waypoints li').count()===0&&!await page.getByRole('button',{name:'마지막 지점 취소',exact:true}).isEnabled());
  await page.getByRole('button',{name:'지점 선택 완료',exact:true}).click();
  check('finishing map editing restores normal map tools',!await page.locator('.planner-map-tools').isVisible()&&await page.locator('.map-tools').isVisible());
  // Two disconnected trkseg pieces must not silently become a synthetic crossing.
  const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'GPX 여러 개 불러오기',exact:true}).click()]);
  const remoteA=[lat+.05,lon],remoteB=[lat+.05,lon+.003],remoteC=[lat+.05,lon+.006],remoteD=[lat+.05,lon+.009];
  await chooser.setFiles([
    {name:'segments.gpx',mimeType:'application/gpx+xml',buffer:Buffer.from(gpx('분리 경로',[[remoteA,remoteB],[remoteC,remoteD]]))},
    {name:'other.gpx',mimeType:'application/gpx+xml',buffer:Buffer.from(gpx('별도 경로',[[[lat+.07,lon],[lat+.07,lon+.003]]]))},
  ]);
  await page.waitForFunction(()=>document.querySelector('.planner-count').textContent.startsWith('12개'));
  check('multiple uploaded GPX files are added together',(await page.locator('.detail-map-wrap').locator('..').textContent()).includes('2개 GPX를 함께'));
  await add(page,'GPX: 분리 경로 · 시작 지점 (1)');await add(page,'GPX: 분리 경로 · 끝 지점 (2)');
  check('disconnected GPX segments reject planning without exporting a bridge',(await page.locator('.planner-status').textContent()).includes('잇는 경로가 없습니다')&&!await page.getByRole('button',{name:'계획 GPX 내려받기',exact:true}).isEnabled());
  await mkdir('/tmp/mountain-planner',{recursive:true});
  for(const theme of ['light','dark']){await page.emulateMedia({colorScheme:theme});for(const width of [320,390,1440]){
    await page.setViewportSize({width,height:1000});
    check(`planner layout ${theme} ${width}`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('.route-planner').scrollIntoViewIfNeeded();await page.screenshot({path:`/tmp/mountain-planner/${theme}-${width}.png`});
  }}
  await context.close();
  const offline=await browser.newPage({viewport:{width:390,height:844}});await configure(offline,{failOSM:true});await offline.goto(base+'/#/m/seolaksan');await loaded(offline);
  check('OSM failure still permits planning from stored GPX',(await offline.locator('.planner-status').textContent()).includes('주변 등산로:')&&await offline.locator('.route-item').count()===3);
  await add(offline,'서쪽 중복 코스 · 시작 지점');await add(offline,'동쪽 코스 · 끝 지점');check('GPX-only connected route is exportable',await offline.getByRole('button',{name:'계획 GPX 내려받기',exact:true}).isEnabled());
  await offline.getByRole('button',{name:'경로 표시 선택',exact:true}).click();const west=offline.locator('.route-item').filter({hasText:'서쪽 중복 코스'});
  await west.locator('.route-eye').click();check('hiding a source excludes it from planning',!await offline.getByRole('button',{name:'계획 GPX 내려받기',exact:true}).isEnabled());
  await west.locator('.route-eye').click();check('restoring a source recalculates the plan',await offline.getByRole('button',{name:'계획 GPX 내려받기',exact:true}).isEnabled());await offline.close();
  const slow=await browser.newPage({viewport:{width:390,height:844}});let releaseOSM;const osmGate=new Promise(r=>releaseOSM=r);await configure(slow,{blockOSM:osmGate});
  await slow.goto(base+'/#/m/seolaksan');await slow.waitForSelector('.map-ctrl');await slow.getByRole('button',{name:'경로 모두 불러오기',exact:true}).click();
  await slow.waitForFunction(()=>document.querySelectorAll('.route-item').length===3);
  await add(slow,'서쪽 중복 코스 · 시작 지점');await add(slow,'동쪽 코스 · 끝 지점');
  check('a slow OSM request does not block GPX planning',await slow.locator('.planner-head button').isDisabled()&&await slow.getByRole('button',{name:'계획 GPX 내려받기',exact:true}).isEnabled());
  releaseOSM();await slow.waitForFunction(()=>!document.querySelector('.planner-head button').disabled);
  check('late network data preserves selected waypoints',await slow.locator('.planner-waypoints li').count()===2&&await slow.getByRole('button',{name:'계획 GPX 내려받기',exact:true}).isEnabled());await slow.close();
  const late=await browser.newPage();let release;const gate=new Promise(r=>release=r);await configure(late,{block:gate});
  await late.goto(base+'/#/m/seolaksan');await late.waitForSelector('.map-ctrl');await late.getByRole('button',{name:'경로 모두 불러오기',exact:true}).click();
  await late.locator('.nav [data-route="track"]').click();await late.waitForSelector('.stat-card');release();await late.waitForTimeout(300);
  check('leaving during batch loading cannot mount the old planner',await late.locator('.route-planner').count()===0&&await late.locator('.stat-card').count()===5);await late.close();
  check('no runtime errors',errors.length===0);console.log(`${checks} planner checks passed`);
}finally{await browser.close();await new Promise(r=>server.close(r));}
