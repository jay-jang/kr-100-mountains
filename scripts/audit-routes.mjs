// 공개 경로 전체 검사. --write=파일로 산별 갱신/중복 보고서도 저장한다.
// 이전 배포 데이터는 --baseline-ref=HEAD (기본값)에서 읽는다.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const read=p=>JSON.parse(readFileSync(join(root,p),'utf8'));
const opt=k=>process.argv.find(x=>x.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const ref=execFileSync('git',['rev-parse',opt('baseline-ref') || 'HEAD'],{cwd:root,encoding:'utf8'}).trim();
const prior=p=>JSON.parse(execFileSync('git',['show',`${ref}:${p}`],{cwd:root,encoding:'utf8',maxBuffer:20*1024*1024}));
const data=read('public/data/mountains.json');
const catalog=read('public/gpx/routes/catalog.json');
const oldCatalog=prior('public/gpx/routes/catalog.json');
const oldById=new Map(oldCatalog.mountains.map(m=>[m.mountain_id,m]));
const trek=read('public/data/trekking/index.json');
const oldTrek=prior('public/data/trekking/index.json');
const snapshot=catalog.mountains[0].osm_snapshot;
assert.match(snapshot,/^\d{4}-\d{2}-\d{2}$/);
assert.equal(catalog.mountains.length,data.mountains.length);
const geometries=new Map(), files=new Map();
function inspect(file) {
  if(files.has(file)) return files.get(file);
  const xml=readFileSync(join(root,'public/gpx',file),'utf8');
  const pts=[...xml.matchAll(/<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"/g)].map(m=>[Number(m[1]),Number(m[2])]);
  assert.ok(pts.length>=2,file+': empty GPX');
  assert.ok(pts.every(([a,b])=>a>=32.5 && a<=39 && b>=124 && b<=132),file+': coordinates');
  assert.ok(xml.includes('not_a_recorded_track') && xml.includes('ODbL'),file+': provenance');
  assert.ok(xml.includes(snapshot),file+': wrong OSM snapshot');
  const seq=pts.map(p=>p.map(n=>n.toFixed(6)).join(',')).join(';');
  const geom=createHash('sha256').update(seq).digest('hex');
  files.set(file,{geom,points:pts.length});
  return files.get(file);
}
const rows=[];
for(const m of data.mountains) {
  const entry=catalog.mountains.find(e=>e.mountain_id===m.id);
  assert.ok(entry?.tracks.length,m.id+': no calculated route');
  assert.equal(entry.osm_snapshot,snapshot);
  assert.ok(entry.collected_at.startsWith(catalog.generated_at.slice(0,10)),m.id+': stale result');
  const detail=read(`public/gpx/routes/m/${m.id}.json`);
  assert.deepEqual(detail,entry);
  const previous=oldById.get(m.id);
  const before=new Set((previous?.tracks || []).map(t=>t.geom_sha1));
  const newGeometry=new Set(entry.tracks.filter(t=>!before.has(t.geom_sha1)).map(t=>t.geom_sha1));
  for(const t of entry.tracks) {
    assert.equal(m.trails[t.route_index-1]?.name,t.route_name,m.id+': trail link');
    const {geom}=inspect(t.file);
    const key=m.id+'|'+geom;
    if(geometries.has(key)) assert.equal(t.file,geometries.get(key),m.id+': duplicate geometry in different files');
    else geometries.set(key,t.file);
    if(t.duplicate_of) assert.ok(entry.tracks.some(o=>o.route_id===t.duplicate_of && o.file===t.file && !o.duplicate_of),m.id+': broken duplicate reference');
  }
  for(const r of entry.relations) inspect(r.file);
  const current=trek.mountains[m.id] ? read(`public/data/trekking/m/${m.id}.json`) : {routes:[]};
  assert.ok(!current.routes.length || current.osm_snapshot===snapshot,m.id+': old trekking');
  assert.equal(new Set(current.routes.map(r=>r.rid)).size,current.routes.length,m.id+': duplicate rid');
  const old=oldTrek.mountains[m.id] ? prior(`public/data/trekking/m/${m.id}.json`).routes : [];
  const oldIds=new Set(old.map(r=>r.rid)),newIds=new Set(current.routes.map(r=>r.rid));
  rows.push({id:m.id,name:m.name_full,osm_snapshot:entry.osm_snapshot,tracks:entry.tracks.length,shared_tracks:entry.tracks.filter(t=>t.duplicate_of).length,
    new_or_changed_geometries:newGeometry.size,trekking:current.routes.length,
    added_trekking:current.routes.filter(r=>!oldIds.has(r.rid)).map(r=>({id:r.rid,name:r.name})),
    removed_trekking:old.filter(r=>!newIds.has(r.rid)).map(r=>({id:r.rid,name:r.name}))});
}
const officials=read('data/official-courses.json');
assert.equal(new Set(officials.courses.map(c=>c.id)).size,officials.courses.length);
assert.ok(officials.courses.every(c=>c.checked_at===catalog.generated_at.slice(0,10)),'stale KNPS facts');
for(const m of data.mountains) {
  const used=new Set();
  for(const c of m.official_courses) {
    if(c.trail_index!=null) { assert.ok(!used.has(c.trail_index),m.id+': ambiguous official trail'); used.add(c.trail_index); }
    if(c.famous_linked) assert.ok(m.famous_courses.some(f=>f.official_id===c.id));
  }
}
const officialIndex=read('public/gpx/courses/index.json');
for(const f of readdirSync(join(root,'public/gpx/courses/m'))) {
  const d=read('public/gpx/courses/m/'+f);
  for(const c of d.courses) inspect(c.file);
}
const walks=read('public/data/trekking/walks-index.json');
const routes=Array.isArray(walks)?walks:walks.routes;
assert.equal(new Set(routes.map(r=>r.rid)).size,routes.length);
for(const r of routes) assert.ok(existsSync(join(root,`public/data/trekking/w/${r.rid}.json`)),r.rid+': missing detail');
const sum=k=>rows.reduce((n,r)=>n+r[k],0);
const report={checked_at:new Date().toISOString(),baseline_ref:ref,osm_snapshot:snapshot,
  sources:[{name:'Geofabrik South Korea',url:`https://download.geofabrik.de/asia/south-korea-${snapshot.replaceAll('-','').slice(2)}.osm.pbf`,snapshot},
    {name:'KNPS',url:'https://www.knps.or.kr/front/portal/trails/search.do?menuNo=8000754',checked_at:officials.meta.source.fetched_at}],
  stats:{mountains:rows.length,tracks:sum('tracks'),shared_tracks:sum('shared_tracks'),unique_calculated_files:catalog.stats.routed_files,
    new_or_changed_geometries:sum('new_or_changed_geometries'),trekking_before:Object.values(oldTrek.mountains).reduce((n,m)=>n+m.count,0),trekking:sum('trekking'),
    added_trekking:rows.reduce((n,r)=>n+r.added_trekking.length,0),removed_trekking:rows.reduce((n,r)=>n+r.removed_trekking.length,0),
    national_walks:routes.length,official_courses:officials.courses.length,official_lines:officialIndex.stats.lines,checked_gpx_files:files.size},
  mountains:rows};
report.note='신규·변경은 이전 공개 데이터와의 차이입니다. 계산 경로와 OSM 등록 선형이며 실측 GPS 기록이 아닙니다. 제외된 주변 길은 최신 원본·중복 제거·거리/길이·표시 상한 기준 재적용 결과입니다.';
if(opt('write')) writeFileSync(resolve(root,opt('write')),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.stats,null,2));
console.log('PASS: every mountain, GPX, duplicate reference, freshness, official link, walking detail');
