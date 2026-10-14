// 산 시트 #/m/<id> + 경로 시트 #/m/<id>?route=<key> — 하나의 컨트롤러가 둘을 오간다.
// 같은 산 안에서 ?route=·?tab=·?r=만 바뀌면 셸이 update(route)를 부르고, 여기서 시트 내용만 바꾼다.
//
// 지도 레이어 묶음
//   summit   정상 라벨(늘)
//   preview  코스 탭에서 흐린 코스 선(선을 누르면 경로 시트)
//   sel      고른 경로(굵게·외곽선, 색·점선은 생성 방식으로) + 들머리·정상 라벨. 산 시트로 돌아와도 남는다.
//   compare  여러 경로 겹쳐 보기(설정 ON)
//   network  등산로망 실시간 조회 결과(설정 ON)
//   chart    고도 단면에서 짚은 지점
import '../css/mountain.css';
import { el, clear } from '../dom.js';
import { icon } from '../icons.js';
import { goUp, goBack, navigate, currentRoute } from '../router.js';
import { isHiked, hikedMap, onChange as onStore, recordView } from '../store.js';
import { editHike } from '../hikerecord.js';
import { cachedPosition, distanceTo, bearingLabel } from '../position.js';
import { fmtDistFine } from '../geo.js';
import { pref, onPrefs, isDarkTheme } from '../prefs.js';
import { reviewsFor } from '../reviews.js';
import { parseGPX, haversine } from '../gpx.js';
import { nearbyRoutes } from '../mapselection.js';
import { fetchMountainTrailNetwork } from '../routing.js';
import { kindStyle } from '../walkdata.js';
import { loadCourseModel, resolveKey, legacyCourseKey, defaultLineIndex, resolveLine, trackLines } from '../mountain/model.js';
import { listLine, fmtElev, shortLabel } from '../mountain/format.js';
import { buildInfo, ALERT_TOPICS } from '../mountain/info.js';
import { createWalksTab, RADII } from '../mountain/walks.js';
import { createCoursesTab } from '../mountain/courses.js';
import { buildRouteSheet } from '../mountain/routesheet.js';

const TABS = [['courses', '코스'], ['walks', '주변 길'], ['info', '정보']];
const TOOL_KEYS = new Set(['compareRoutes', 'gpxImport', 'routePlanner', 'followRoute', 'liveTrails']);
const COMPARE_L = ['#2c5d9e', '#0b7285', '#a61e4d', '#8a5a00', '#495057', '#c2255c'];
const COMPARE_D = ['#7fa8e0', '#4fc1d4', '#ef7aa3', '#e0b04f', '#ced4da', '#f783ac'];
const USER_COLOR = { light: '#6d3fc0', dark: '#b79be0' };
const PLAN_COLOR = '#e37722';      // 경로 계획 도구(routeplanner.js)가 그리는 계획 선과 같은 주황

const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const courseColor = () => cssVar('--course', isDarkTheme() ? '#e07a5f' : '#b4432b');

/**
 * 고른 선의 모양 — 파일 위치가 아니라 생성 방식(provenance)으로 정한다(spec-final 8장).
 * 지도 범례(레이어 › 선 읽는 법)와 같은 약속이어야 한다: 적갈 실선 = 수록 경로, 적갈 점선 = 계산 경로,
 * 녹색 = OpenStreetMap 탐방로. 그래서 OSM 노선을 골랐을 때 적갈 실선으로 그리면 실측 기록처럼 읽힌다.
 * 내 파일은 보라, 내 계획은 계획 도구와 같은 주황. 굵기는 고른 선끼리 같게 둔다(흐린 미리보기 선은 3).
 */
function selectedStyle(prov) {
  const dark = isDarkTheme();
  if (prov === 'osm-relation') return { color: kindStyle('trail', { dark }).color, dash: null };
  if (prov === 'planned') return { color: PLAN_COLOR, dash: null };
  if (prov === 'user-file') return { color: dark ? USER_COLOR.dark : USER_COLOR.light, dash: null };
  return { color: courseColor(), dash: prov === 'osm-routed' || prov === 'live' ? 'dash' : null };
}

export async function renderMountain(ctx, route) {
  const m = ctx.data.byId.get(route.id);
  if (!m) return notFound(ctx, route.id);
  try { recordView(m.id); } catch {}

  const id = m.id;
  const offs = [];
  const reviews = reviewsFor(id).catch(() => null);
  let model = null;
  let mode = null;                 // 'mountain' | 'route'
  let tab = 'courses';
  let radius = 10;
  let routeView = null;
  let mountainScroll = 0;
  let pendingNotes = false;
  let firstShow = true;
  const sel = { key: null, row: null, lineIdx: -1, track: null };
  let selSeq = 0;
  const compare = new Map();       // key → { idx, group }
  const userRows = [];
  let userSeq = 0;
  let previews = [];               // [{ key, segments, style }]
  let network = null;

  // ---------- 지도 레이어 묶음 ----------
  function group() {
    let toks = [];
    return {
      add(t) { if (!t) return t; ctx.layers.add(t); toks.push(t); return t; },
      clear() { toks.forEach((t) => ctx.layers.remove(t)); toks = []; },
      get size() { return toks.length; },
    };
  }
  const G = { summit: group(), preview: group(), sel: group(), compare: group(), network: group(), chart: group() };

  // ---------- 주소 ----------
  function mountainHash() {
    const p = new URLSearchParams();
    if (tab !== 'courses') p.set('tab', tab);
    if (radius !== 10) p.set('r', String(radius));
    const s = p.toString();
    return `#/m/${encodeURIComponent(id)}${s ? '?' + s : ''}`;
  }
  function routeHash(key, v) {
    const p = new URLSearchParams({ route: key });
    if (v != null) p.set('v', String(v));
    return `#/m/${encodeURIComponent(id)}?${p}`;
  }
  // 이미 다른 화면으로 떠났으면(다음 화면 조각을 받는 중에 늦게 온 갱신 등) 그 화면의 주소를 덮어쓰지 않는다.
  function replaceURL(hash) {
    const cur = currentRoute();
    if (cur.parts[0] !== 'm' || cur.parts[1] !== id) return;
    if (location.hash !== hash) history.replaceState(history.state, '', hash);
  }
  const depth = () => history.state?.kr100?.depth || 0;

  // ---------- 산 시트 머리 ----------
  const titleEl = el('h2', { class: 'sheet-title mt-title', tabindex: '-1' },
    el('span', { class: 'mt-name' }, m.name), m.disambig ? el('span', { class: 'mt-dis' }, m.disambig) : null,
    el('span', { class: 'mt-elev tabular' }, fmtElev(m.elevation_m)));
  const pos = cachedPosition();
  const dist = pos && m.lat != null ? distanceTo(pos, m.lat, m.lon) : Infinity;
  const sub = el('p', { class: 'sheet-sub mt-sub' },
    [m.region, listLine(m)].filter(Boolean).join(' · '),
    Number.isFinite(dist) ? [' · ', el('span', { class: 'mt-dist', title: '마지막으로 확인한 내 위치에서 직선거리' }, `${bearingLabel(pos, m.lat, m.lon)}쪽 ${fmtDistFine(dist)}`)] : null);
  const hikeBtn = el('button', { type: 'button', class: 'btn small mt-hike', onClick: () => editHike(m) });
  function paintHike() {
    const on = isHiked(id);
    clear(hikeBtn);
    if (on) hikeBtn.append(el('span', { class: 'mt-hike-ic', html: icon('check', { size: 16 }) }), '등정');
    else hikeBtn.append('등정 기록');
    hikeBtn.classList.toggle('done', on);
    hikeBtn.setAttribute('aria-pressed', String(on));
    hikeBtn.title = on ? `${hikedMap()[id]} 등정 · 기록 수정` : '다녀온 날짜 기록';
  }
  paintHike();
  offs.push(onStore(paintHike));
  // [×]는 산 시트에서 목록으로 한 단계 — 경로·걷기길 시트의 [×]와 같은 이름("닫고 목록으로")을 쓴다.
  const closeBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': '닫고 목록으로', title: '닫고 목록으로', html: icon('close'), onClick: () => goUp(ctx.listHash()) });
  // "선택한 경로" 줄은 머리(peek)에 둔다 — 본문에 두면 시트를 접었을 때 무엇이 지도에 그려져 있는지 보이지 않는다.
  const selName = el('strong', {});
  const selBar = el('div', { class: 'mt-selbar', hidden: true },
    el('span', { class: 'mt-selbar-text' }, '선택한 경로: ', selName),
    el('button', { type: 'button', class: 'btn small', onClick: () => sel.key && openRoute(sel.key) }, '보기'),
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': '선택한 경로 지우기', title: '선택 해제', html: icon('close', { size: 18 }), onClick: () => clearSelection() }));
  const mtnHeader = el('div', { class: 'mt-head' },
    el('div', { class: 'sheet-headline' }, el('div', { class: 'sheet-titles' }, titleEl),
      el('div', { class: 'mt-head-actions' }, hikeBtn, closeBtn)),
    sub, selBar);

  // ---------- 산 시트 본문: 탭 ----------
  const tabBtns = new Map();
  const panels = new Map();
  const tablist = el('div', { class: 'mt-tabs', role: 'tablist', 'aria-label': `${m.name} 정보` });
  for (const [k, label] of TABS) {
    const b = el('button', { type: 'button', role: 'tab', class: 'mt-tab', id: `mt-tab-${k}`, 'aria-controls': `mt-panel-${k}`, 'aria-selected': 'false', tabindex: '-1',
      onClick: () => setTab(k, { write: true }) }, el('span', { class: 'mt-tab-label' }, label), el('span', { class: 'mt-tab-n tabular' }));
    tabBtns.set(k, b); tablist.append(b);
    panels.set(k, el('div', { class: 'mt-panel', role: 'tabpanel', id: `mt-panel-${k}`, 'aria-labelledby': `mt-tab-${k}`, hidden: true },
      k === 'info' ? null : el('p', { class: 'mt-loading', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' 불러오는 중…')));
  }
  tablist.addEventListener('keydown', (e) => {
    const keys = TABS.map(([k]) => k);
    let i = keys.indexOf(tab);
    if (e.key === 'ArrowRight') i = (i + 1) % keys.length;
    else if (e.key === 'ArrowLeft') i = (i - 1 + keys.length) % keys.length;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = keys.length - 1;
    else return;
    e.preventDefault();
    setTab(keys[i], { write: true });
    tabBtns.get(keys[i]).focus();
  });
  const warnBtn = el('button', { type: 'button', class: 'mt-warnline', hidden: true, onClick: () => showNotes() });
  const mtnBody = el('div', { class: 'mt-body' },
    el('div', { class: 'mt-sticky' }, tablist),
    warnBtn,
    ...panels.values());

  // 정보 탭(바로 만든다 — 자료는 들어오는 대로 채워진다)
  const info = buildInfo(m, reviews);
  panels.get('info').append(info.root);
  reviews.then((entry) => {
    const notes = entry?.notes || [];
    const counts = ALERT_TOPICS.map((t) => [t, notes.filter((n) => n.topic === t).length]).filter(([, n]) => n);
    if (!counts.length || ctx.disposed()) return;
    // 지금 내려진 경고가 아니라 산행기·공지에서 모은 "자료"의 개수다 — 오래된 기록이 현재 통제처럼 읽히지 않게
    // "자료"라고 적고, 날짜·현재 상태 미확인 여부는 정보 탭의 항목마다 붙인다.
    const parts = counts.map(([t, n]) => `${t} 자료 ${n}건`);
    // 좁은 화면에서 "자료 / 1건"처럼 항목 중간이 끊기지 않게 항목 안은 붙는 공백, 줄바꿈은 구분점에서만.
    clear(warnBtn).append(el('span', { class: 'mt-warn-text' }, el('span', { class: 'mt-warn-k' }, '주의'), parts.map((t) => ` · ${t.replace(/ /g, '\u00a0')}`).join('')),
      el('span', { class: 'mt-warn-go', html: icon('next', { size: 16 }) }));
    warnBtn.setAttribute('aria-label', `주의: ${parts.join(', ')}. 현장 정보 보기`);
    warnBtn.hidden = false;
  });
  function showNotes() {
    if (mode === 'route') { pendingNotes = true; back(); return; }
    setTab('info', { write: true });
    requestAnimationFrame(() => {
      ctx.sheet.setDetent('full');
      const target = info.fieldNotes;
      if (!target.hidden) {
        const body = ctx.sheet.body;
        const sticky = mtnBody.querySelector('.mt-sticky');
        body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - (sticky?.offsetHeight || 0) - 4;
      }
    });
  }

  let coursesTab = null, walksTab = null;
  function setCount(k, n) { tabBtns.get(k).querySelector('.mt-tab-n').textContent = n ? String(n) : ''; }

  function setTab(k, { write = false } = {}) {
    if (!panels.has(k)) k = 'courses';
    tab = k;
    for (const [key, b] of tabBtns) {
      const on = key === k;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      panels.get(key).hidden = !on;
    }
    if (write && mode === 'mountain') replaceURL(mountainHash());
    if (mode === 'mountain') paintMapForTab();
  }
  function paintMapForTab() {
    if (tab === 'walks') walksTab?.show(); else walksTab?.hide();
    drawPreviews();
  }

  // ---------- 고른 경로 ----------
  function paintSelBar() {
    selBar.hidden = !sel.row;
    selName.textContent = sel.row?.name || '';
    coursesTab?.setSelected(sel.key);
  }
  function clearSelection() {
    selSeq++;
    Object.assign(sel, { key: null, row: null, lineIdx: -1, track: null });
    G.sel.clear();
    paintSelBar();
    drawPreviews();
  }
  /** 경로를 고르고 지도에 그린다. 선이 있으면 해석한 트랙을 돌려준다. */
  async function select(row, lineIdx, { fit = false } = {}) {
    const my = ++selSeq;
    Object.assign(sel, { key: row.key, row, lineIdx, track: null });
    drawSelection({ fit: fit && lineIdx < 0 });
    drawPreviews();
    if (lineIdx < 0) return null;
    let track = null;
    try { track = await resolveLine(row.lines[lineIdx], { signal: ctx.signal }); } catch { track = null; }
    if (my !== selSeq || ctx.disposed()) return null;
    sel.track = track;
    drawSelection({ fit });
    return track;
  }
  function drawSelection({ fit = false } = {}) {
    G.sel.clear();
    const { row, track, lineIdx } = sel;
    if (!row) return;
    ctx.whenMap((view) => {
      if (sel.row !== row || sel.track !== track) return;
      G.sel.clear();
      const line = lineIdx >= 0 ? row.lines[lineIdx] : null;
      // 선이 없는 OSM 행의 시작점도 노선 색으로(행 종류가 곧 생성 방식이다).
      const st = selectedStyle(line?.provenance || (row.kind === 'osm' ? 'osm-relation' : null));
      const color = st.color;
      const pts = [];
      if (track) {
        for (const seg of trackLines(track)) {
          G.sel.add(view.addPolyline(seg, { color, weight: 5, opacity: 0.95, outline: true, dash: st.dash }));
          pts.push(...seg);
        }
        const s = track.latlngs[0], e = track.latlngs.at(-1);
        const nearSummit = (p) => m.lat != null && haversine(p[0], p[1], m.lat, m.lon) <= 300;
        const startText = row.kind === 'osm' ? '노선 끝' : shortLabel(row.start) || '출발';
        if (!nearSummit(s)) {
          G.sel.add(view.addDot({ lat: s[0], lng: s[1], color, title: row.start ? `들머리 ${row.start}` : startText }));
          G.sel.add(view.addLabel({ lat: s[0], lng: s[1], text: startText, kind: 'trailhead' }));
        }
        // 등산로 행의 계산 경로는 정상에서 끝난다 — 끝점 라벨은 노선·내 파일처럼 끝이 정상이 아닐 수 있을 때만.
        if (row.kind !== 'trail' && !nearSummit(e) && haversine(e[0], e[1], s[0], s[1]) > 200) {
          G.sel.add(view.addLabel({ lat: e[0], lng: e[1], text: row.kind === 'osm' ? '노선 끝' : '도착', kind: 'peak' }));
        }
        for (const pk of (line?.peaks || []).slice(0, 8)) {
          if (m.lat != null && haversine(pk.lat, pk.lon, m.lat, m.lon) < 200) continue;
          G.sel.add(view.addLabel({ lat: pk.lat, lng: pk.lon, text: pk.name, kind: 'peak' }));
        }
      } else if (row.trailhead) {
        G.sel.add(view.addDot({ lat: row.trailhead[0], lng: row.trailhead[1], color, title: row.start ? `들머리 ${row.start}` : '들머리' }));
        G.sel.add(view.addLabel({ lat: row.trailhead[0], lng: row.trailhead[1], text: shortLabel(row.start) || '들머리', kind: 'trailhead' }));
        pts.push(row.trailhead);
      }
      if (fit) {
        if (m.lat != null) pts.push([m.lat, m.lon]);
        // 시트 내용이 바뀌면 peek 높이와 지도 크기가 다음 프레임에 바뀐다 — 그 뒤에 맞춘다.
        afterLayout(() => {
          if (sel.row !== row || ctx.disposed()) return;
          if (pts.length > 1) ctx.fit(padBounds(pts), { maxZoom: 15 });
          else if (pts.length) ctx.focusPoint(pts[0], 14);
        });
      }
    });
  }
  /** 라벨(점 위쪽에 붙는다)이 상단 바에 걸리지 않게 경계를 넓힌다 — 북쪽은 조금 더. */
  function padBounds(pts) {
    let s = 90, n = -90, w = 180, e = -180;
    for (const [la, lo] of pts) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
    const dy = Math.max(n - s, 0.003), dx = Math.max(e - w, 0.003);
    return [[s - dy * 0.04, w - dx * 0.05], [n + dy * 0.12, e + dx * 0.05]];
  }
  function afterLayout(fn) { requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(fn, 30))); }
  function chartPoint(p) {
    G.chart.clear();
    if (!p || !ctx.view) return;
    G.chart.add(ctx.view.addDot({ lat: p[0], lng: p[1], color: isDarkTheme() ? '#e7eadd' : '#233c32', radius: 6 }));
  }

  // ---------- 코스 탭 미리보기 선 ----------
  function drawPreviews() {
    G.preview.clear();
    if (mode !== 'mountain' || tab !== 'courses' || !previews.length) return;
    ctx.whenMap((view) => {
      if (mode !== 'mountain' || tab !== 'courses') return;
      G.preview.clear();
      const dark = isDarkTheme();
      for (const p of previews) {
        if (p.key === sel.key && sel.track) continue;
        const style = p.style === 'osm' ? { ...kindStyle('trail', { dark }), dash: null }
          : p.style === 'user' ? { color: dark ? USER_COLOR.dark : USER_COLOR.light, weight: 3, opacity: 0.7, dash: null }
            : p.style === 'planned' ? { color: PLAN_COLOR, weight: 3, opacity: 0.8, dash: null }
              : { color: courseColor(), weight: 3, opacity: 0.6, dash: p.style === 'computed' ? 'dash' : null };
        for (const seg of p.segments) G.preview.add(view.addPolyline(seg, { color: style.color, weight: style.weight, opacity: style.opacity, dash: style.dash }));
      }
      if (sel.row) drawSelection();   // 고른 선이 흐린 선 위에 오게 다시 그린다
    });
  }
  async function loadPreviews() {
    const rows = [...model.rows, ...model.osmRows, ...userRows].filter((r) => r.lines.length).slice(0, 14);
    const out = await Promise.all(rows.map(async (row) => {
      const line = row.lines[defaultLineIndex(row)];
      try {
        const track = await resolveLine(line, { signal: ctx.signal });
        const style = row.kind === 'osm' ? 'osm' : line.provenance === 'user-file' ? 'user' : line.provenance === 'planned' ? 'planned'
          : line.provenance === 'osm-routed' || line.provenance === 'live' ? 'computed' : 'solid';
        return { key: row.key, segments: trackLines(track), style };
      } catch { return null; }
    }));
    if (ctx.disposed()) return;
    previews = out.filter(Boolean);
    drawPreviews();
  }

  // ---------- 겹쳐 보기 ----------
  const compareApi = {
    has: (k) => compare.has(k),
    color: (k) => (compare.has(k) ? (isDarkTheme() ? COMPARE_D : COMPARE_L)[compare.get(k).idx % COMPARE_L.length] : null),
    async toggle(row, on) {
      if (!on) { compare.get(row.key)?.group.clear(); compare.delete(row.key); coursesTab?.paint(); return; }
      const used = new Set([...compare.values()].map((c) => c.idx));
      let idx = 0; while (used.has(idx)) idx++;
      const entry = { idx, group: group(), track: null };
      compare.set(row.key, entry);
      coursesTab?.paint();
      try { entry.track = await resolveLine(row.lines[defaultLineIndex(row)], { signal: ctx.signal }); } catch { entry.track = null; }
      if (compare.get(row.key) !== entry || ctx.disposed()) return;
      if (!entry.track) { compare.delete(row.key); coursesTab?.paint(); coursesTab?.setStatus(`${row.name}: 선을 불러오지 못했습니다.`); return; }
      drawCompare();
      const pts = [...compare.values()].flatMap((c) => c.track?.latlngs || []);
      if (pts.length) ctx.fit(pts, { maxZoom: 14 });
    },
  };
  function drawCompare() {
    for (const c of compare.values()) c.group.clear();
    ctx.whenMap((view) => {
      for (const [k, c] of compare) {
        c.group.clear();
        if (!c.track) continue;
        const color = compareApi.color(k);
        for (const seg of trackLines(c.track)) c.group.add(view.addPolyline(seg, { color, weight: 4, opacity: 0.9, outline: true }));
      }
    });
  }
  function clearCompare() { for (const c of compare.values()) c.group.clear(); compare.clear(); }

  // ---------- 내 GPX 파일 · 등산로망 ----------
  async function onFiles(files) {
    const parsed = await Promise.allSettled(files.map(async (f) => ({ f, track: parseGPX(await f.text()) })));
    if (ctx.disposed()) return;
    const added = [];
    for (const r of parsed) {
      if (r.status !== 'fulfilled') continue;
      const { f, track } = r.value;
      const row = { key: `u:${++userSeq}`, group: 'user', kind: 'user', name: track.name || f.name.replace(/\.gpx$/i, ''), altName: null,
        distanceKm: track.distance_km, gainM: track.gain_m || null, trailhead: track.latlngs[0], trailheadConf: null,
        lines: [{ provenance: 'user-file', label: '기본', variant: 0, review: false, warnings: [], track }] };
      userRows.push(row); added.push(row);
    }
    const failed = parsed.length - added.length;
    coursesTab?.paint();
    coursesTab?.setStatus(`${added.length}개 GPX를 열었습니다.${failed ? ` ${failed}개는 GPX 형식이 아니라서 제외했습니다.` : ''} 파일은 이 기기 밖으로 보내지 않습니다.`);
    setCount('courses', coursesTab?.count());
    if (added.length) {
      await loadPreviews();
      // 미리보기 선을 기다리는 사이 시트를 닫았을 수 있다 — 다음 화면의 지도를 내 파일 범위로 옮기지 않는다.
      if (ctx.disposed()) return;
      ctx.fit(added.flatMap((r) => r.lines[0].track.latlngs), { maxZoom: 15 });
    }
  }
  async function loadNetwork() {
    if (network) return network;
    const pts = [...model.rows, ...model.osmRows].map((r) => r.trailhead).filter(Boolean);
    const result = await fetchMountainTrailNetwork(m, pts, { signal: ctx.signal });
    if (ctx.disposed()) return null;
    network = result.ways;
    drawNetwork();
    return network;
  }
  function drawNetwork() {
    G.network.clear();
    if (!network?.length) return;
    ctx.whenMap((view) => {
      G.network.clear();
      const st = kindStyle('trail', { dark: isDarkTheme() });
      G.network.add(view.addPolylines(network.map((w) => w.latlngs), { color: st.color, weight: 2, opacity: 0.55 }));
    });
  }
  async function onNetwork(btn) {
    btn.disabled = true;
    const before = btn.textContent;
    clear(btn).append(el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' 불러오는 중…');
    coursesTab?.setStatus('OpenStreetMap에서 주변 등산로를 불러옵니다. 수십 초 걸릴 수 있습니다.');
    try {
      const ways = await loadNetwork();
      if (!ways || ctx.disposed()) return;
      coursesTab?.setStatus(ways.length ? `주변 등산로 ${ways.length}개를 지도에 얇게 표시했습니다(OpenStreetMap 실시간 조회).` : '조회 범위에서 OpenStreetMap 등산로를 찾지 못했습니다.');
    } catch (err) {
      if (!ctx.disposed()) coursesTab?.setStatus(err.name === 'AbortError' ? '' : (err.message || '등산로를 불러오지 못했습니다.'));
    } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = before; } }
  }

  // ---------- 경로 계획용 선 모으기 ----------
  async function planningRoutes() {
    const rows = [...model.rows, ...model.osmRows, ...userRows].filter((r) => r.lines.length);
    const jobs = rows.flatMap((row) => row.lines.map((line, i) => ({ row, line, i })));
    const routes = [];
    let failed = 0, next = 0;
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, async () => {
      while (next < jobs.length && !ctx.disposed()) {
        const { row, line, i } = jobs[next++];
        try {
          const track = await resolveLine(line, { signal: ctx.signal });
          routes.push({ rid: `${row.key}#${i}`, label: row.name + (i && line.label ? ` (${line.label})` : ''), latlngs: track.latlngs, track });
        } catch { failed++; }
      }
    }));
    const stored = routes.length;
    let netMsg = '';
    if (pref('liveTrails')) {
      try { const ways = await loadNetwork(); for (const w of ways || []) routes.push({ rid: `osm-${w.osmId}`, label: w.label, latlngs: w.latlngs }); netMsg = ` · 주변 등산로 ${routes.length - stored}개`; }
      catch (err) { netMsg = ` · 주변 등산로 조회 실패(${err.message})`; failed++; }
    }
    return { routes, failed: failed > 0, message: `수록·계산 경로 ${stored}개${netMsg}를 계획에 씁니다.${failed ? ' 일부는 불러오지 못했습니다. 다시 누르면 재시도합니다.' : ''}` };
  }
  function addPlan(plan) {
    const track = { name: `${m.name} 내 계획`, points: plan.points, segments: [plan.points], latlngs: plan.latlngs,
      hasEle: plan.points.every((p) => Number.isFinite(p.ele)), distance_km: +(plan.distance_m / 1000).toFixed(2), gain_m: 0 };
    for (let i = userRows.length - 1; i >= 0; i--) if (userRows[i].kind === 'planned') userRows.splice(i, 1);
    userRows.push({ key: 'p:1', group: 'user', kind: 'planned', name: `${m.name} 내 계획`, altName: null,
      distanceKm: track.distance_km, trailhead: plan.latlngs[0], trailheadConf: null,
      lines: [{ provenance: 'planned', label: '기본', variant: 0, review: false, warnings: [], track }] });
    coursesTab?.paint();
    setCount('courses', coursesTab?.count());
    loadPreviews();
  }

  // ---------- 화면 전환 ----------
  function focusTitle(node) {
    const a = document.activeElement;
    if (a && a.matches?.('input, textarea, select')) return;   // 입력 중에는 포커스를 옮기지 않는다
    requestAnimationFrame(() => node?.focus({ preventScroll: true }));
  }
  function openRoute(key) {
    navigate(routeHash(key), { state: { mtnFrom: id } });
  }
  // 기록 이동은 router의 goBack으로만 — 두 번 누름(더블 탭)에 뒤로가기가 두 번 겹쳐 앱 밖으로 나가지 않게 막아 준다.
  function back() {
    if (history.state?.mtnFrom === id) goBack(1);
    else navigate(mountainHash(), { replace: true });
  }
  function closeAll() {
    if (history.state?.mtnFrom === id && depth() >= 2) goBack(2);
    else navigate(ctx.listHash(), { replace: true });
  }

  function showMountain() {
    const wasRoute = mode === 'route';
    if (routeView) { routeView.dispose(); routeView = null; }
    mode = 'mountain';
    ctx.setContent({ header: mtnHeader, content: mtnBody, label: m.name_full, detent: pendingNotes ? 'full' : 'half' });
    if (mountainScroll && !pendingNotes) { const s = mountainScroll; requestAnimationFrame(() => { ctx.sheet.body.scrollTop = s; }); }
    paintSelBar();
    setTab(tab);
    if (pendingNotes) { pendingNotes = false; showNotes(); }
    if (wasRoute || firstShow) focusTitle(titleEl);
    if (firstShow) {
      firstShow = false;
      if (m.lat != null) ctx.whenMap(() => ctx.focusPoint([m.lat, m.lon], 12));
    }
  }

  async function showRoute(key, v) {
    if (!model) {
      ctx.setContent({ header: el('div', { class: 'mt-head' }, el('p', { class: 'mt-loading', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' 경로를 불러오는 중…')), content: el('div'), label: '경로', detent: 'peek' });
      await modelReady;
      if (ctx.disposed() || currentKey !== key) return;
    }
    const row = model ? resolveKey(model, key) || userRows.find((r) => r.key === key) : null;
    if (!row) {
      ctx.toast('이 경로를 찾을 수 없습니다. 산 정보를 보여 드립니다.');
      replaceURL(mountainHash());
      currentKey = null;
      showMountain();
      return;
    }
    const idx = Number.isInteger(v) && row.lines[v] ? v : defaultLineIndex(row);
    renderRoute(row, idx);
  }
  function renderRoute(row, idx) {
    if (mode === 'mountain') mountainScroll = ctx.sheet.body.scrollTop;
    const first = mode !== 'route';
    if (routeView) routeView.dispose();
    mode = 'route';
    walksTab?.hide();
    G.preview.clear();
    routeView = buildRouteSheet(env, row, idx);
    ctx.setContent({ header: routeView.header, content: routeView.content, label: routeView.label, detent: first || firstShow ? 'peek' : undefined });
    firstShow = false;
    focusTitle(routeView.title);
  }

  const env = {
    ctx, m, reviews,
    select,
    selection: () => sel,
    chartPoint,
    back, close: closeAll,
    showNotes,
    planningRoutes,
    addPlan,
    setVariant(row, i) {
      replaceURL(routeHash(row.key, i === defaultLineIndex(row) ? null : i));
      renderRoute(row, i);
    },
    addLiveLine(row, { track, peaks }) {
      row.lines.push({ provenance: 'live', label: '실시간', variant: row.lines.length, review: false, warnings: [], track, peaks, oneWay: true });
      renderRoute(row, row.lines.length - 1);
      coursesTab?.paint();
      loadPreviews();
    },
  };

  // ---------- 주소 → 화면 ----------
  let currentKey = null;
  function applyRoute(r) {
    const p = r.params;
    let key = p.get('route');
    const legacy = p.get('course');
    if (!key && legacy) {
      key = legacyCourseKey(m, legacy);
      replaceURL(key ? routeHash(key) : mountainHash());
    }
    const rr = Number(p.get('r'));
    if (RADII.includes(rr) && rr !== radius) { radius = rr; walksTab?.setRadius(rr); if (walksTab) setCount('walks', walksTab.count()); }
    if (!key) {
      const t = p.get('tab');
      tab = TABS.some(([k]) => k === t) ? t : (mode === 'route' ? tab : 'courses');
      currentKey = null;
      showMountain();
      return;
    }
    currentKey = key;
    const v = p.get('v') != null ? Number(p.get('v')) : null;
    showRoute(key, v);
  }

  // ---------- 지도 ----------
  ctx.setMarkers({ selectedId: id });
  function drawSummit() {
    G.summit.clear();
    if (m.lat == null) return;
    ctx.whenMap((view) => { G.summit.clear(); G.summit.add(view.addLabel({ lat: m.lat, lng: m.lon, text: `정상 ${fmtElev(m.elevation_m)}`, kind: 'summit' })); });
  }
  drawSummit();
  ctx.onMapClick((pt) => {
    if (routeView?.picking) return true;
    if (mode === 'mountain' && tab === 'walks') return walksTab?.hitTest(pt) || false;
    if (!ctx.view) return false;
    const cands = [];
    if (mode === 'mountain' && tab === 'courses') cands.push(...previews);
    if (sel.track && mode === 'mountain') cands.push({ key: sel.key, segments: trackLines(sel.track) });
    for (const [k, c] of compare) if (c.track && k !== (mode === 'route' ? sel.key : null)) cands.push({ key: k, segments: trackLines(c.track) });
    const hit = nearbyRoutes(ctx.view, cands, pt)[0];
    if (!hit) return false;
    openRoute(hit.key);
    return true;
  });

  // ---------- 설정·테마 ----------
  offs.push(onPrefs((key) => {
    if (key != null && !TOOL_KEYS.has(key)) return;
    if (!pref('compareRoutes')) clearCompare();
    coursesTab?.paint();
    routeView?.repaintTools();
  }));
  const onTheme = () => { drawPreviews(); drawSelection(); drawCompare(); drawNetwork(); walksTab?.redraw(); drawSummit(); coursesTab?.paint(); };
  window.addEventListener('kr100:theme', onTheme);
  offs.push(() => window.removeEventListener('kr100:theme', onTheme));

  // ---------- 시작 ----------
  const modelReady = loadCourseModel(m).then((mod) => {
    if (ctx.disposed()) return;
    model = mod;
    coursesTab = createCoursesTab({ m, model, userRows: () => userRows, onOpen: openRoute, compare: compareApi, onFiles, onNetwork });
    clear(panels.get('courses')).append(coursesTab.root);
    setCount('courses', coursesTab.count());
    walksTab = createWalksTab({ ctx, m, walks: model.walks, radius, group,
      onRadius: (r) => { radius = r; setCount('walks', walksTab.count()); if (mode === 'mountain') replaceURL(mountainHash()); } });
    clear(panels.get('walks')).append(walksTab.root);
    setCount('walks', walksTab.count());
    paintSelBar();
    if (mode === 'mountain') paintMapForTab();
    loadPreviews();
  }).catch((err) => {
    console.error(err);
    if (ctx.disposed()) return;
    for (const k of ['courses', 'walks']) clear(panels.get(k)).append(el('div', { class: 'empty' }, el('p', {}, '코스 자료를 불러오지 못했습니다.'),
      el('button', { type: 'button', class: 'btn', onClick: () => location.reload() }, '다시 불러오기')));
  });

  applyRoute(route);

  return {
    update(r) {
      if (r.id !== id) return false;
      applyRoute(r);
      return true;
    },
    onEscape() {
      if (mode === 'route') back();
      else goUp(ctx.listHash());
    },
    dispose() {
      routeView?.dispose(); routeView = null;
      walksTab?.hide();
      offs.forEach((f) => { try { f(); } catch {} });
    },
  };
}

function notFound(ctx, id) {
  const header = el('div', { class: 'mt-head' }, el('div', { class: 'sheet-headline' },
    el('div', { class: 'sheet-titles' }, el('h2', { class: 'sheet-title', tabindex: '-1' }, '산을 찾을 수 없습니다'),
      el('p', { class: 'sheet-sub' }, `‘${id}’에 해당하는 산이 목록에 없습니다.`)),
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': '닫고 목록으로', title: '닫고 목록으로', html: icon('close'), onClick: () => goUp(ctx.listHash()) })));
  ctx.setContent({ header, content: el('div', { class: 'empty' }, el('a', { class: 'btn', href: '#/map' }, '명산 목록 보기')), label: '산을 찾을 수 없음', detent: 'peek' });
  return { onEscape: () => goUp(ctx.listHash()) };
}
