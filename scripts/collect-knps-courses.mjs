#!/usr/bin/env node
// 국립공원공단(KNPS) 탐방로 통합검색의 공식 탐방코스 목록을 로컬 캐시로 받는다.
//
// 무엇을 받는가
//   · 탐방로 통합검색 목록(코스명·공원·일정·난이도·소요시간·vcursId)
//   · 공원별 코스 목록(visitCourseAjax.do) — 통합검색 목록에는 주왕산 등 일부 공원 코스가 빠져 있어 합친다
//   · 코스별 지도 자료(visitCourseCdn.do — 코스 선형 좌표, 상세구간, 거리, 시간, 난이도)
//   · 코스별 출발지점(courseTrafficLink.do — 출발 지점명·주소)
//
// 라이선스 ★ 중요
//   KNPS 누리집 저작권정책은 "공공누리 제1유형 표시가 붙은 저작물만 자유이용"이다.
//   코스 페이지에는 그 표시가 없다(2026-10-14 확인). 그래서 **선형 좌표는 재배포하지 않는다.**
//   여기서 받은 것은 .cache/knps/(gitignore)에만 두고, 공개 산출물에는
//     - 코스의 사실 정보(이름·구간·거리·시간·난이도, 출처 링크)와
//     - OpenStreetMap 등산로 위에서 다시 계산한 선형(ODbL)만 넣는다.
//   공식 선형은 "어느 OSM 길을 따라가는 코스인가"를 고르고 검증하는 기준으로만 쓴다
//   (scripts/build-course-routes.mjs).
//
// 사용법
//   node scripts/collect-knps-courses.mjs            # 받은 것은 건너뛰고 이어 받기
//   node scripts/collect-knps-courses.mjs --force    # 목록부터 다시
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'knps');
const RAW = join(CACHE, 'raw');
const BASE = 'https://www.knps.or.kr';
const UA = 'Mozilla/5.0 (kr-100-mountains course index; +https://github.com/jay-jang/kr-100-mountains)';
const FORCE = process.argv.includes('--force');
const DELAY_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

async function post(path, form, { json = false, tries = 4 } = {}) {
  const body = new URLSearchParams(form).toString();
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
        body,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return json ? JSON.parse(text) : text;
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const strip = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// ── 1. 목록 ───────────────────────────────────────────────────────────
function parseList(html) {
  const rows = [];
  const tbody = html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
  for (const tr of tbody.split(/<tr[\s>]/).slice(1)) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    const link = tr.match(/parkId=(\d+)&(?:amp;)?vcursId=([0-9A-Z]+)/);
    if (!link || tds.length < 7) continue;
    rows.push({
      no: Number(strip(tds[0])), region: strip(tds[1]), park: strip(tds[2]), name: strip(tds[3]),
      schedule: strip(tds[4]), level: strip(tds[5]), time: strip(tds[6]),
      parkId: link[1], vcursId: link[2],
    });
  }
  const total = Number((html.match(/총\s*:\s*(?:<[^>]+>)*\s*([\d,]+)\s*건/) || [])[1]?.replace(/,/g, '')) || null;
  return { rows, total };
}

/** 메뉴의 국립공원 링크에서 parkId → 공원 이름("가야산") */
function parseParks(html) {
  const parks = {};
  for (const m of html.matchAll(/visitCourseMain\.do\?parkId=(\d+)&(?:amp;)?menuNo=\d+"[^>]*>\s*([^<]+?)국립공원\s*</g)) parks[m[1]] = m[2].trim();
  return parks;
}

async function collectList() {
  const file = join(CACHE, 'list.json');
  if (!FORCE && existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (cached.parks) return cached;          // 공원별 목록까지 합친 판본만 재사용
  }
  const all = new Map();
  let total = null;
  let parks = {};
  for (let page = 1; page < 100; page++) {
    const html = await post('/front/portal/trails/search.do?menuNo=8000754', { page: String(page), menuNo: '8000754' });
    if (page === 1) parks = parseParks(html);
    const { rows, total: t } = parseList(html);
    total ??= t;
    if (!rows.length) break;
    for (const r of rows) all.set(r.vcursId, r);
    log(`· 목록 ${page}쪽 — ${rows.length}건 (누적 ${all.size}${total ? `/${total}` : ''})`);
    if (total && all.size >= total) break;
    await sleep(DELAY_MS);
  }
  if (total && all.size !== total) log(`! 목록 수 ${all.size} ≠ 표시 총계 ${total}`);
  // 공원별 코스 목록으로 통합검색에서 빠진 코스를 채운다.
  let added = 0;
  for (const [parkId, park] of Object.entries(parks)) {
    let res;
    try { res = await post('/front/portal/visit/visitCourseAjax.do', { parkId, vcursId: `${parkId}V001` }, { json: true }); }
    catch (e) { log(`  ✗ ${park} 공원별 목록: ${e.message}`); continue; }
    for (const v of res?.vcCodeList || []) {
      if (!v.vcursId || all.has(v.vcursId)) continue;
      all.set(v.vcursId, { no: null, region: null, park, name: (v.cursNm || '').trim(), schedule: null, level: null, time: null, parkId, vcursId: v.vcursId, from: 'park-list' });
      added++;
    }
    await sleep(DELAY_MS);
  }
  log(`· 공원별 목록으로 ${added}건 추가 (공원 ${Object.keys(parks).length}곳)`);
  const list = { fetched_at: new Date().toISOString(), total, parks, courses: [...all.values()].sort((a, b) => a.vcursId.localeCompare(b.vcursId)) };
  writeAtomic(file, JSON.stringify(list, null, 1));
  return list;
}

// ── 2. 코스별 자료 ────────────────────────────────────────────────────
async function collectCourse(c) {
  const cdnFile = join(RAW, `${c.vcursId}.cdn.json`);
  const trafficFile = join(RAW, `${c.vcursId}.traffic.json`);
  let fetched = false;
  if (FORCE || !existsSync(cdnFile)) {
    const cdn = await post('/front/portal/visit/visitCourseCdn.do', { vcursId: c.vcursId }, { json: true });
    writeAtomic(cdnFile, JSON.stringify(cdn));
    fetched = true;
  }
  if (FORCE || !existsSync(trafficFile)) {
    const tr = await post('/front/portal/visit/courseTrafficLink.do', { vcursId: c.vcursId }, { json: true });
    writeAtomic(trafficFile, JSON.stringify(tr));
    fetched = true;
  }
  return {
    cdn: JSON.parse(readFileSync(cdnFile, 'utf8')),
    traffic: JSON.parse(readFileSync(trafficFile, 'utf8')),
    fetched,
    // 이 코스 자료를 실제로 받은 시각 — 화면의 "확인 <날짜>"는 빌드 날짜가 아니라 이것이어야 한다.
    fetched_at: statSync(cdnFile).mtime.toISOString(),
  };
}

// 빈 문자열·null을 0으로 읽지 않는다(Number('') === 0). 좌표는 한반도 범위 밖이면 버린다(단위가 틀린 값 36706382 등).
const num = (v) => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const okLat = (v) => (v != null && v >= 32.5 && v <= 39 ? v : null);
const okLon = (v) => (v != null && v >= 124 && v <= 132 ? v : null);
const pts = (arr) => (arr || []).map((d) => [okLat(num(d.latitu)), okLon(num(d.longit))]).filter(([a, b]) => a != null && b != null);

function normalize(c, { cdn, traffic, fetched_at }) {
  const line = pts(cdn.vcLineCdn);
  const line2 = pts(cdn.vcLineCdn1);
  const facilities = [];
  const fac = (arr, kind) => (arr || []).forEach((f) => {
    const la = okLat(num(f.latitu)), lo = okLon(num(f.longit));
    if (la != null && lo != null) facilities.push({ kind, name: f.facNm, lat: la, lon: lo });
  });
  fac(cdn.vcOfficeCdn, 'office'); fac(cdn.vcShelterCdn, 'shelter'); fac(cdn.vcCampCdn, 'camp');
  fac(cdn.vcCenterCdn, 'center'); fac(cdn.vcTempleCdn, 'temple'); fac(cdn.vcParkingCdn, 'parking');
  const starts = (traffic?.traffic || []).map((t) => ({ name: t.spNm, address: t.spAddr || null, lat: okLat(num(t.latitu)), lon: okLon(num(t.longit)) }))
    .filter((s) => s.name);
  const h = num(cdn.reqH), m = num(cdn.reqM);
  return {
    ...c,
    official_name: cdn.cursNm || c.name,
    section: cdn.dtlSection || null,
    schedule_name: cdn.scheduleNm || c.schedule,
    distance_km: num(cdn.dist),
    minutes: h != null || m != null ? (h || 0) * 60 + (m || 0) : null,
    level_name: cdn.lvlNm || c.level,
    control: cdn.ctlCd && cdn.ctlCd !== 'null' ? cdn.ctlCd : null,
    contact: cdn.conno || null,
    line, line2,
    starts,
    facilities,
    url: `${BASE}/front/portal/visit/visitCourseSubMain.do?parkId=${c.parkId}&vcursId=${c.vcursId}&parkNavGb=guide`,
    fetched_at,
  };
}

// ── 실행 ─────────────────────────────────────────────────────────────
const list = await collectList();
log(`공식 탐방코스 ${list.courses.length}건`);
const out = [];
let n = 0;
for (const c of list.courses) {
  n++;
  try {
    const raw = await collectCourse(c);
    const norm = normalize(c, raw);
    out.push(norm);
    if (raw.fetched) {
      log(`  ${n}/${list.courses.length} ${c.vcursId} ${c.park} · ${norm.official_name} — 선형 ${norm.line.length}점, 출발점 ${norm.starts.length}`);
      await sleep(DELAY_MS);
    }
  } catch (e) {
    log(`  ✗ ${c.vcursId} ${c.name}: ${e.message}`);
  }
}
writeAtomic(join(CACHE, 'courses.json'), JSON.stringify({
  fetched_at: list.fetched_at, source: `${BASE}/front/portal/trails/search.do?menuNo=8000754`,
  license_note: 'KNPS 누리집 자료. 공공누리 표시 없음 → 재배포 금지, 로컬 기준 자료로만 사용',
  courses: out,
}, null, 1));
const noLine = out.filter((c) => c.line.length < 2).length;
log(`완료: ${out.length}건 (선형 없는 코스 ${noLine}건) → .cache/knps/courses.json`);
