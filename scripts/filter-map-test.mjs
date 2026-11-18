// 필터 선택 → 산 선택 → 지도 축소. URL뿐 아니라 실제 마커·묶음과 상세 재방문을 검사한다.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { ROOT, serve, launch, stubNetwork, watch } from './lib/ui-harness.mjs';
const {base,close}=await serve();
const browser=await launch();
const errors=[];let passed=0;
const count=page=>page.evaluate(()=>document.querySelectorAll('#map .mk').length+
  [...document.querySelectorAll('#map .mk-cluster > span')].reduce((n,e)=>n+Number(e.textContent),0));
async function waitCount(page,n) {
  await page.waitForFunction(expected=>document.querySelectorAll('#map .mk').length+
    [...document.querySelectorAll('#map .mk-cluster > span')].reduce((sum,e)=>sum+Number(e.textContent),0)===expected,n);
}
function check(label,ok) {assert.ok(ok,label);console.log('PASS',label);passed++;}
async function zoomOut(page) {
  for(let i=0;i<6;i++){await page.getByRole('button',{name:'축소',exact:true}).click();await page.waitForTimeout(120);}
}
async function markersMatch(page,ids,label) {
  await waitCount(page,ids.length);
  const shown=await page.locator('#map .mk').evaluateAll(nodes=>nodes.map(n=>n.dataset.id));
  check(label,(await count(page))===ids.length && shown.every(id=>ids.includes(id)));
}
const records={seolaksan:'2026-01-01',gwanaksan:'2026-01-02'};
try {
  await mkdir(ROOT+'/shots/filter-map',{recursive:true});
  const netContext=await browser.newContext();const netPage=await netContext.newPage();
  const {mountains}=await (await netPage.request.get(base+'/data/mountains.json')).json();
  // 독립적인 원본 데이터 판정: UI/지도에서 쓰는 필터 함수를 다시 호출하지 않는다.
  const trek=await (await netPage.request.get(base+'/data/trekking/index.json')).json();await netContext.close();
  const cases=[
    {name:'권역',params:{region:'제주'},matches:m=>m.region==='제주'},
    {name:'복합',params:{region:'강원,충청',list:'sanlim,bac',easy:'1',hours:'4',distance:'10',hiked:'0',dulle:'1'},
      matches:m=>['강원','충청'].includes(m.region) && (m.lists.sanlim||m.lists.bac) && !(m.id in records) &&
        m.trails.some(t=>['쉬움','보통'].includes(t.difficulty)&&t.round_trip_hours>0&&t.round_trip_hours<=4&&t.distance_km>0&&t.distance_km<=10) &&
        ['dulle','forest','ridge','other'].some(k=>trek.mountains[m.id]?.kinds[k]>0)},
  ];
  for(const width of [390,1440]) for(const scenario of cases) {
    const label=`${width} ${scenario.name}`;
    const expected=mountains.filter(scenario.matches).map(m=>m.id);
    assert.ok(expected.length>0&&expected.length<mountains.length);
    const ctx=await browser.newContext({viewport:{width,height:900},colorScheme:width===390?'dark':'light'});await stubNetwork(ctx);
    await ctx.addInitScript(value=>localStorage.setItem('kr100:hiked',JSON.stringify(value)),records);
    const p=watch(await ctx.newPage(),errors,{label});
    if(scenario.name==='권역') {
      await p.goto(base+'/#/map?');await p.waitForSelector('.sheet .sheet-title');
      await p.getByRole('button',{name:'필터',exact:true}).click();
      await p.locator('dialog').getByRole('button',{name:'제주',exact:true}).click();
      await p.locator('dialog .primary').click();
    } else await p.goto(base+'/#/map?'+new URLSearchParams(scenario.params));
    await markersMatch(p,expected,label+': 목록 필터와 지도 범위 일치');
    const listIds=await p.locator('.sheet .row[data-id]').evaluateAll(nodes=>[...new Set(nodes.map(n=>n.dataset.id))]);
    assert.deepEqual(listIds.slice().sort(),expected.slice().sort());
    const hash=new URL(p.url()).hash;
    if(width<1024) await p.locator('.sheet-grabber').press('ArrowUp');
    const row=p.locator('.sheet .row[data-id]').first();const selected=await row.getAttribute('data-id');
    await row.click();await p.waitForSelector('.mt-title');
    await markersMatch(p,expected,label+': 산 선택 직후에도 같은 필터 범위');
    await zoomOut(p);
    await markersMatch(p,expected,label+': 지도 축소 후에도 제외된 산이 나타나지 않음');
    check(label+': 선택한 산 강조 유지',await p.locator(`#map .mk.selected[data-id="${selected}"]`).count()===1);
    await p.reload();await p.waitForSelector('.mt-title');
    await zoomOut(p);
    await markersMatch(p,expected,label+': 상세 새로고침·축소 후 필터 복원');
    // 재도색(테마 변경)에서도 범위를 유지한다.
    await p.evaluate(()=>{document.documentElement.dataset.theme='dark';window.dispatchEvent(new Event('kr100:theme'));});
    await markersMatch(p,expected,label+': 테마 변경 뒤에도 같은 지도 범위');
    const storage=await ctx.storageState();
    await p.getByRole('button',{name:'닫고 목록으로',exact:true}).click();
    await p.waitForFunction(()=>document.querySelector('.sheet .sheet-title')?.textContent==='명산');
    await markersMatch(p,expected,label+': 목록 복귀 후 필터 일치');
    check(label+': 필터 주소·선택 해제 유지',new URL(p.url()).hash===hash&&await p.locator('#map .mk.selected').count()===0);
    // 목록을 먼저 열지 않은 새 탭도 저장된 필터를 지도에 적용한다. 외부 링크로 고른 산만 예외로 강조한다.
    const directCtx=await browser.newContext({storageState:storage,viewport:{width,height:900}});await stubNetwork(directCtx);
    const direct=watch(await directCtx.newPage(),errors,{label:label+' direct'});
    const outside=mountains.find(m=>m.lat!=null&&!expected.includes(m.id));
    await direct.goto(base+'/#/m/'+outside.id);await direct.waitForSelector('.mt-title');
    await zoomOut(direct);
    await markersMatch(direct,[...expected,outside.id],label+': 새 탭 상세에서도 필터+선택 산만 표시');
    if(scenario.name==='권역') {
      await p.locator('.tb-input').fill('관악산');
      await p.locator('.suggest-item').filter({hasText:'관악산'}).first().click();await p.waitForSelector('.mt-title');
      await zoomOut(p);
      await markersMatch(p,[...expected,'gwanaksan'],label+': 검색 제안 선택 후에도 원래 필터 범위 유지');
    }
    await direct.screenshot({path:`${ROOT}/shots/filter-map/${width}-${scenario.name}.png`});
    await directCtx.close();
    // 사용자 초기화는 전체 표시로 돌아가야 한다.
    await p.goto(base+'/#/map?');await p.waitForFunction(()=>document.querySelector('.sheet .sheet-title')?.textContent==='명산');
    await markersMatch(p,mountains.filter(m=>m.lat!=null).map(m=>m.id),label+': 명시적 초기화 후 전체 표시 복원');
    await ctx.close();
  }
  // 상세로 바로 재방문할 때 걷기길 색인이 늦어도 잠깐 전체 산을 보여 주지 않는다.
  const pendingCtx=await browser.newContext({viewport:{width:1440,height:900}});await stubNetwork(pendingCtx);
  const pendingParams=new URLSearchParams(cases[1].params).toString();
  await pendingCtx.addInitScript(({query,records})=>{
    localStorage.setItem('kr100:last-list','#/map?'+query);
    localStorage.setItem('kr100:hiked',JSON.stringify(records));
  },{query:pendingParams,records});
  let releaseIndex;const indexGate=new Promise(resolve=>{releaseIndex=resolve;});
  await pendingCtx.route('**/data/trekking/index.json',async route=>{await indexGate;await route.continue();});
  const pending=watch(await pendingCtx.newPage(),errors,{label:'pending index'});
  try {
    await pending.goto(base+'/#/m/hanrasan');await pending.waitForSelector('.mt-title');
    await markersMatch(pending,['hanrasan'],'색인 대기 중에도 선택한 산 외 전체 산이 노출되지 않음');
    releaseIndex();
    const afterIndex=[...mountains.filter(cases[1].matches).map(m=>m.id),'hanrasan'];
    await markersMatch(pending,afterIndex,'늦게 받은 걷기길 조건도 상세 지도에 적용');
    await zoomOut(pending);
    await markersMatch(pending,afterIndex,'색인 응답 후 축소해도 필터 유지');
  } finally {releaseIndex();await pendingCtx.close();}
  check('브라우저 오류 없음',errors.length===0);
  console.log(`filter map: ${passed} passed`);
} finally {await browser.close();await close();}
