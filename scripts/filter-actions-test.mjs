// 다른 동작이 조건을 지우거나 오래된 화면 상태를 덮어쓰지 않는지 실제 링크/이벤트로 검사한다.
import assert from 'node:assert/strict';
import { serve, launch, stubNetwork, watch, waitForShell } from './lib/ui-harness.mjs';
const {base,close}=await serve();
const browser=await launch();
const errors=[];
let passed=0;
const current=p=>new URLSearchParams(new URL(p.url()).hash.split('?')[1] || '');
function check(name,value) {assert.ok(value,name);console.log('PASS',name);passed++;}
const ready=async p=>{await waitForShell(p,{markers:false});await p.waitForFunction(()=>['명산','걷기길'].includes(document.querySelector('.sheet .sheet-title')?.textContent));};
const same=(params,want)=>Object.entries(want).every(([k,v])=>params.get(k)===v);
const filters={region:'수도권',list:'bac',easy:'1',hours:'4',distance:'10',sort:'near',walkkind:'forest'};
const seed=new URLSearchParams(filters).toString();
try {
  for(const width of [390,1440]) {
    const ctx=await browser.newContext({viewport:{width,height:900}});
    await stubNetwork(ctx);
    await ctx.addInitScript(()=>localStorage.setItem('kr100:pos',JSON.stringify({lat:37.5,lng:127,accuracy:10,ts:Date.now()})));
    await ctx.route('**/data/trekking/w/missing-filter-test.json',r=>r.fulfill({json:null}));
    const page=watch(await ctx.newPage(),errors,{label:String(width)});
    await page.goto(base+'/#/map?'+seed);await ready(page);
    await page.evaluate(()=>{const b=[...document.querySelectorAll('.tb-chips button')].find(n=>n.textContent==='둘레길 있는 산');b.click();b.click();});
    await page.waitForTimeout(100);
    check(`${width}: 둘레길 조건 연속 두 번 누르면 원래 상태, 나머지 조건 유지`,!current(page).has('dulle') && same(current(page),filters));
    await page.evaluate(()=>{[...document.querySelectorAll('.tb-chips button')].find(n=>n.textContent==='둘레길 있는 산').click();const input=document.querySelector('.tb-input');input.value='관악';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForTimeout(100);
    check(`${width}: 조건 변경 직후 검색해도 검색어와 조건이 모두 유지`,same(current(page),{...filters,dulle:'1',q:'관악'}) && await page.locator('.tb-input').inputValue()==='관악');
    await page.locator('.tb-input').press('Escape'); // 검색 제안 닫기
    await page.evaluate(()=>{const buttons=[...document.querySelectorAll('.seg button')];buttons.find(n=>n.textContent==='걷기길').click();buttons.find(n=>n.textContent==='명산').click();});
    await ready(page);
    check(`${width}: 빠른 모드 왕복에도 다른 조건 보존`,same(current(page),{...filters,dulle:'1',q:'관악'}) && !current(page).has('mode'));
    await page.evaluate(()=>{const b=[...document.querySelectorAll('.seg button')];b.find(n=>n.textContent==='걷기길').click();b.find(n=>n.textContent==='명산').click();const input=document.querySelector('.tb-input');input.value='수락';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForTimeout(100);
    check(`${width}: 모드 전환 직후 입력도 새 화면이 받아 조건 유지`,same(current(page),{...filters,dulle:'1',q:'수락'}) && !current(page).has('mode'));
    await page.locator('.tb-input').fill('관악');
    await page.locator('.tb-input').press('Escape');
    await page.getByRole('link',{name:'기록',exact:true}).click();await page.waitForSelector('.pg-track');
    await page.getByRole('link',{name:'지도에서 아직 안 간 산 보기'}).click();await ready(page);
    check(`${width}: 미등정 단축 동작은 등정 조건만 변경`,same(current(page),{...filters,dulle:'1',q:'관악',hiked:'0'}));
    const saved=current(page).toString();
    await page.goto(base+'/#/settings');await page.waitForSelector('.pg-settings');
    await page.locator('.pg-back').click();await ready(page);
    check(`${width}: 설정 화면 왕복 뒤에도 모든 조건 유지`,current(page).toString()===saved);
    await page.goto(base+'/#/m/no-such-mountain');
    // 오류 안내 시트는 본문을 펼친 뒤 복귀 링크를 누른다.
    await page.getByRole('link',{name:'명산 목록 보기'}).waitFor({state:'attached'});
    if(width<1024) {await page.locator('.sheet-grabber').press('ArrowUp');await page.locator('.sheet-grabber').press('ArrowUp');}
    await page.getByRole('link',{name:'명산 목록 보기'}).click();await ready(page);
    check(`${width}: 산 오류 안내의 목록 링크도 필터 유지`,current(page).toString()===saved);
    await page.goto(base+'/#/map');await ready(page);
    check(`${width}: 앱 실행 중 기본 지도 주소로 돌아와도 필터 유지`,current(page).toString()===saved);
    await page.goto(base+'/#/');await ready(page);
    check(`${width}: 홈 주소로 이동해도 필터 유지`,current(page).toString()===saved);
    await page.goto(base+'/#/walk/missing-filter-test');
    await page.getByRole('link',{name:'걷기길 지도 보기'}).waitFor({state:'attached'});
    if(width<1024) {await page.locator('.sheet-grabber').press('ArrowUp');await page.locator('.sheet-grabber').press('ArrowUp');}
    await page.getByRole('link',{name:'걷기길 지도 보기'}).click();await ready(page);
    check(`${width}: 걷기길 오류 안내는 모드만 변경`,same(current(page),{...Object.fromEntries(new URLSearchParams(saved)),mode:'walk'}));
    await page.reload();await ready(page);
    check(`${width}: 복귀 후 새로고침해도 조건 유지`,same(current(page),{...filters,dulle:'1',q:'관악',hiked:'0',mode:'walk'}));
    await page.goto(base+'/#/map?region=제주');await ready(page);
    check(`${width}: 외부의 명시적 조건 URL은 그대로 적용`,current(page).get('region')==='제주' && !current(page).has('list') && !current(page).has('q'));
    // 의도적인 초기화는 검색/권역/선정/코스/정렬 조건을 저장소에서도 해제한다.
    await page.goto(base+'/#/map?'+seed);await ready(page);
    if(width<1024 && await page.locator('.sheet').getAttribute('data-detent')==='full') await page.locator('.sheet-grabber').press('ArrowDown');
    await page.getByRole('button',{name:'조건 초기화',exact:true}).click();
    await page.goto(base+'/#/settings');await page.waitForSelector('.pg-settings');
    await page.goto(base+'/#/map');await ready(page);
    check(`${width}: 직접 초기화한 조건은 화면 이동 후 되살아나지 않음`,['region','list','easy','hours','distance','sort','q','hiked','dulle'].every(k=>!current(page).has(k)));
    await ctx.close();
  }
  check('화면 오류 없음',errors.length===0);
  console.log(`filter actions: ${passed} passed`);
} finally {await browser.close();await close();}
