import { loadData, DIFF_CLASS, regionColor, LIST_KEYS, LIST_META } from '../data.js';
import { createMapView, fetchTrails } from '../map.js';
import { mapControls } from '../mapcontrols.js';
import { isHiked, toggleHiked, onChange, recordView } from '../store.js';
import { parseGPX, drawTrack, navInfo, haversine } from '../gpx.js';
import { watchPosition, fmtDist, directionsLinks } from '../geo.js';
import { fetchElevations, resample, buildProfile, profileFromTrack, elevationChart, profileStats } from '../elevation.js';
import { routeTrailheadToSummit } from '../routing.js';
import { el, esc, clear } from '../dom.js';

export async function renderDetail(root, id) {
  const data = await loadData();
  const m = data.byId.get(id);
  if (!m) {
    root.append(el('div', { class: 'page' },
      el('p', { class: 'crumb' }, el('a', { href: '#/map' }, '← 지도로')),
      el('div', { class: 'empty' }, '산을 찾을 수 없습니다.')));
    return () => {};
  }
  recordView(m.id);

  const page = el('div', { class: 'page' });
  root.append(page);

  // ---- breadcrumb ----
  page.append(el('div', { class: 'crumb' },
    el('a', { href: '#/map' }, '지도'), ' / ',
    el('a', { href: `#/map?focus=${m.id}` }, m.region), ' / ', m.name_full));

  // ---- hero ----
  const hikeBtn = el('button', { class: 'hike-btn' + (isHiked(m.id) ? ' done' : '') });
  const paintHike = () => {
    const on = isHiked(m.id);
    hikeBtn.className = 'hike-btn' + (on ? ' done' : '');
    hikeBtn.textContent = on ? '★ 등정 완료' : '☆ 등정 기록';
    hikeBtn.setAttribute('aria-pressed', String(on));
  };
  paintHike();
  hikeBtn.addEventListener('click', () => { toggleHiked(m.id); paintHike(); });

  const sub = el('div', { class: 'sub' },
    el('span', {}, `${m.region} · ${m.location}`),
    el('span', { class: 'elev' }, `해발 ${m.elevation_m}m`),
    m.best_season ? el('span', {}, `🍂 ${m.best_season}`) : null);

  page.append(el('div', { class: 'hero' },
    el('div', {},
      el('h2', {}, m.name, m.disambig ? el('span', { class: 'han' }, `(${m.disambig})`) : null),
      sub),
    el('div', { class: 'hero-badges' },
      ...LIST_KEYS.filter((k) => m.lists[k]).map((k) => listPill(k, m))),
    hikeBtn));

  // ---- summary ----
  page.append(el('div', { class: 'section' },
    el('h3', {}, '개요'),
    m.summary
      ? el('p', { class: 'prose' }, m.summary)
      : el('p', { class: 'prose muted' }, '개요 정보를 준비 중입니다.')));

  // ---- 월간산 선정기준 (공식 순위 대신 11개 세부기준 중 해당 부문) ----
  if (m.wolgansan_criteria) {
    const wc = m.wolgansan_criteria;
    page.append(el('div', { class: 'section' },
      el('h3', {}, '월간산 선정기준 ', el('span', { class: 'crit-count' }, `${wc.count}개 부문`)),
      el('div', { class: 'tags crit-tags' }, ...wc.groups.map((g) => el('span', { class: 'tag crit' }, g))),
      el('p', { class: 'conf-note', style: 'margin-top:10px' },
        '월간산 「한국의 100대 명산」(2018)은 공식 순위·점수를 발표하지 않았습니다. 위 부문은 월간산이 제시한 5대·11개 세부 선정기준 표에서 이 산이 직접 언급된 항목을 재집계한 것입니다.')));
  }

  // ---- location · route · navigation ----
  const mapNode = el('div', { id: 'detail-map' });
  const fileInput = el('input', { type: 'file', accept: '.gpx', style: 'display:none' });
  const fileBtn = el('button', { type: 'button', onClick: () => fileInput.click() }, '📈 GPX 불러오기');
  const locateBtn = el('button', { type: 'button', title: '내 위치 실시간 표시' }, '📍 내 위치');
  const dirBtn = el('button', { type: 'button', title: '외부 지도 길찾기' }, '🧭 길찾기');
  const followBtn = el('button', { type: 'button', disabled: true, title: 'GPX 경로를 따라 실시간 안내' }, '➡️ 경로 따라가기');
  const dirMenu = el('div', { class: 'dir-menu', hidden: true });
  const tools = el('div', { class: 'map-tools' }, locateBtn, dirBtn, fileBtn, followBtn, fileInput);
  const navPanel = el('div', { class: 'nav-panel', hidden: true });
  const mapWrap = el('div', { class: 'detail-map-wrap' }, mapNode, tools, dirMenu);
  const gpxNote = el('div', { class: 'conf-note' });
  page.append(el('div', { class: 'section' }, el('h3', {}, '위치 · 경로 · 내비게이션'), mapWrap, navPanel, gpxNote));

  // ---- 등산로별 고도 (등산로 선택 → 그 경로만 지도 표시 + 고도 프로파일) ----
  const OSM_COLORS = ['#1a73e8', '#e2872a', '#8e44ad', '#16a085', '#c0392b'];
  const routeColor = (r, i) => (r.kind === 'gpx' ? '#d1495b' : OSM_COLORS[i % OSM_COLORS.length]);

  const routeList = el('div', { class: 'route-list' });
  const loadTrailsBtn = el('button', { class: 'btn', type: 'button' }, '🗻 실제 등산로 불러오기');
  const showOnMapChk = el('input', { type: 'checkbox', id: 'route-showmap', checked: true });
  const showOnMapLabel = el('label', { class: 'route-showmap', for: 'route-showmap' }, showOnMapChk, ' 선택 등산로 지도 표시');
  const elevChartBox = el('div', { class: 'elev-chart-box' });
  const elevNote = el('div', { class: 'conf-note', style: 'margin-top:8px' });
  page.append(el('div', { class: 'section' },
    el('h3', {}, '등산로별 고도'),
    el('p', { class: 'conf-note', style: 'margin:-4px 0 10px' },
      '등산로를 선택하면 그 경로만 지도에 표시되고 아래에 고도 단면이 나타납니다. GPX 파일 또는 OpenStreetMap 실제 등산로(고도: open-meteo 지형데이터) 기반입니다.'),
    el('div', { class: 'route-actions' }, loadTrailsBtn, showOnMapLabel),
    routeList, elevChartBox, elevNote));

  const routes = [];             // { label, latlngs, profile, track|null, kind }
  let activeRoute = -1, activeRouteLayer = null;

  function renderRouteList() {
    clear(routeList);
    if (!routes.length) { routeList.append(el('div', { class: 'conf-note' }, 'GPX를 불러오거나 “실제 등산로 불러오기”로 등산로를 추가하세요.')); return; }
    routes.forEach((r, i) => {
      const item = el('button', { class: 'route-item' + (i === activeRoute ? ' active' : ''), type: 'button' },
        el('span', { class: 'route-swatch', style: `background:${routeColor(r, i)}` }),
        el('span', { class: 'route-label' }, r.label),
        r.profile ? el('span', { class: 'route-meta' }, `↑${r.profile.gain_m}m · ${fmtDist(r.profile.dist_m)}`) : null);
      item.addEventListener('click', () => selectRoute(i));
      routeList.append(item);
    });
  }
  function drawActiveRoute() {
    if (activeRouteLayer && view) { view.removeLayer(activeRouteLayer); }
    activeRouteLayer = null;
    if (!view || activeRoute < 0 || !showOnMapChk.checked) return;
    const r = routes[activeRoute];
    activeRouteLayer = drawTrack(view, { latlngs: r.latlngs }, routeColor(r, activeRoute));
  }
  function selectRoute(i) {
    activeRoute = i; renderRouteList();
    const r = routes[i];
    clear(elevChartBox);
    if (r.profile) elevChartBox.append(elevationChart(r.profile), profileStats(r.profile));
    else elevChartBox.append(el('div', { class: 'conf-note' }, '이 등산로의 고도 데이터를 만들 수 없습니다.'));
    drawActiveRoute();
    setNavTrack(r.track || null);
  }
  showOnMapChk.addEventListener('change', drawActiveRoute);
  function addRoute(route) { routes.push(route); selectRoute(routes.length - 1); }

  function addGpxRoute(track, label) {
    const finish = (profile, note) => { addRoute({ label, latlngs: track.latlngs, profile, track, kind: 'gpx' }); if (note) elevNote.textContent = note; };
    const direct = profileFromTrack(track);
    if (direct) { finish(direct); return; }
    elevNote.textContent = 'GPX에 고도가 없어 지형 고도를 조회하는 중…';
    const line = resample(track.latlngs, 80);
    fetchElevations(line).then((eles) => finish(buildProfile(line, eles), '※ 고도는 open-meteo 지형 데이터로 보완했습니다.'))
      .catch(() => { finish(null); elevNote.textContent = '고도 조회 실패(경로는 지도에 표시됩니다).'; });
  }
  const lineLen = (l) => { let d = 0; for (let i = 1; i < l.length; i++) d += haversine(l[i - 1][0], l[i - 1][1], l[i][0], l[i][1]); return d; };

  // 주요 등산로 코스 → 들머리(codex·agy 검증)에서 정상까지 실제 경로 + 고도로 연결
  const scrollToRoutes = () => routeList.scrollIntoView({ behavior: 'smooth', block: 'center' });
  async function showCourseRoute(t, btn) {
    if (!t.trailhead || m.lat == null) return;
    const idx = routes.findIndex((r) => r.courseName === t.name);
    if (idx >= 0) { selectRoute(idx); scrollToRoutes(); return; }
    const orig = btn ? btn.textContent : ''; if (btn) { btn.disabled = true; btn.textContent = '경로 찾는 중…'; }
    elevNote.textContent = `“${t.name}” 실제 등산로 경로를 찾는 중입니다…`; scrollToRoutes();
    try {
      let route = null;
      try { route = await routeTrailheadToSummit(t.trailhead, [m.lat, m.lon]); } catch {}
      if (route && route.latlngs.length > 3) {
        const sampled = resample(route.latlngs, 90);
        const prof = buildProfile(sampled, await fetchElevations(sampled));
        addRoute({ label: t.name, courseName: t.name, latlngs: route.latlngs, profile: prof, track: null, kind: 'course' });
        elevNote.textContent = '※ 들머리(codex·agy 검증)에서 정상까지 실제 등산로 경로와 고도(open-meteo)입니다.';
      } else {
        const N = 30, a = t.trailhead, b = [m.lat, m.lon], line = [];
        for (let i = 0; i <= N; i++) { const f = i / N; line.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
        const prof = buildProfile(line, await fetchElevations(line));
        addRoute({ label: `${t.name} (직선참고)`, courseName: t.name, latlngs: [a, b], profile: prof, track: null, kind: 'course' });
        elevNote.textContent = '※ 실제 등산로 연결을 확인하지 못해 들머리→정상 직선 기준 지형 고도를 표시합니다.';
      }
    } catch (e) { elevNote.textContent = '경로 불러오기 실패: ' + (e.message || e); }
    finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
  }

  loadTrailsBtn.addEventListener('click', async () => {
    if (m.lat == null) { elevNote.textContent = '정상 좌표가 없어 불러올 수 없습니다.'; return; }
    loadTrailsBtn.disabled = true; const orig = loadTrailsBtn.textContent; loadTrailsBtn.textContent = '불러오는 중…';
    elevNote.textContent = '실제 등산로와 고도를 불러오는 중입니다… (최대 수십 초 걸릴 수 있어요)';
    try {
      const lines = await fetchTrails(m.lat, m.lon, 2500);
      const top = lines.map((l) => ({ l, len: lineLen(l) })).filter((o) => o.len > 400).sort((a, b) => b.len - a.len).slice(0, 4);
      if (!top.length) { elevNote.textContent = '인근에서 표시할 등산로를 찾지 못했습니다.'; return; }
      const base = routes.length;
      let n = 0;
      for (const { l, len } of top) {
        const line = resample(l, 55);
        let prof = null; try { prof = buildProfile(line, await fetchElevations(line)); } catch {}
        n++; routes.push({ label: `OSM 등산로 ${n} (${(len / 1000).toFixed(1)}km)`, latlngs: line, profile: prof, track: null, kind: 'osm' });
      }
      selectRoute(base); // 첫 신규 등산로 선택
      elevNote.textContent = '※ OpenStreetMap 등산로 좌표의 고도를 open-meteo로 조회한 실제 값입니다.';
    } catch (e) { elevNote.textContent = '불러오기 실패: ' + (e.message || e); }
    finally { loadTrailsBtn.disabled = false; loadTrailsBtn.textContent = orig; renderRouteList(); }
  });
  renderRouteList();

  let view, controls, navTrack = null, locLayer = null;
  let stopWatch = null, locateOn = false, following = false, firstFix = false, lastPos = null;

  if (m.lat != null) {
    view = await createMapView(mapNode, { center: [m.lat, m.lon], zoom: 13 });
    controls = mapControls(view, mapWrap);
    mapWrap.append(controls);
    view.addDot({ lat: m.lat, lng: m.lon, color: regionColor(m.region), title: `${m.name} 정상 ${m.elevation_m}m` });
    locLayer = view.locate();
    if (m.coord_confidence && m.coord_confidence !== 'high')
      gpxNote.textContent = `※ 정상 좌표는 근사값일 수 있습니다 (신뢰도: ${m.coord_confidence}).`;

    // 외부 지도 길찾기 (목적지=정상)
    const links = directionsLinks(m.name_full, m.lat, m.lon);
    dirMenu.append(
      el('a', { href: links.kakao, target: '_blank', rel: 'noopener' }, '카카오맵 길찾기'),
      el('a', { href: links.google, target: '_blank', rel: 'noopener' }, '구글 지도 길찾기'));
    dirBtn.addEventListener('click', () => { dirMenu.hidden = !dirMenu.hidden; });

    // 수록 GPX 자동 로드 → 등산로 목록에 추가(선택 시 지도 표시)
    tryLoadCuratedGPX(m.id, gpxNote).then((res) => { if (res) addGpxRoute(res.track, `수록 경로${res.track.name ? ': ' + res.track.name : ''}`); });

    locateBtn.addEventListener('click', toggleLocate);
    followBtn.addEventListener('click', toggleFollow);

    fileInput.addEventListener('change', async (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      try {
        const track = parseGPX(await f.text());
        gpxNote.textContent = `${track.name || f.name} · 거리 ${track.distance_km}km` +
          (track.gain_m ? ` · 누적 상승 ${track.gain_m}m` : '');
        addGpxRoute(track, `GPX: ${track.name || f.name}`);
      } catch (err) { gpxNote.textContent = 'GPX 오류: ' + err.message; }
    });
  } else {
    mapWrap.replaceWith(el('div', { class: 'empty' }, '정상 좌표 정보를 준비 중입니다.'));
  }

  function setNavTrack(track) { navTrack = track; followBtn.disabled = !track; }

  function onPos(p) {
    lastPos = p;
    locLayer.set(p);
    if (firstFix) { firstFix = false; (view.flyTo ? view.flyTo : view.setView).call(view, [p.lat, p.lng], 14); }
    locateBtn.classList.remove('loading'); locateOn && (locateBtn.textContent = '🎯 위치 추적중');
    if (following && navTrack) updateNav(p);
  }
  function onGeoErr(err) {
    if (stopWatch) { stopWatch(); stopWatch = null; }
    locLayer.remove(); locateOn = false; following = false; navPanel.hidden = true;
    locateBtn.classList.remove('loading', 'active'); locateBtn.textContent = err.code === 1 ? '🚫 권한 거부' : '⚠️ 위치 실패';
    followBtn.classList.remove('active'); followBtn.textContent = '➡️ 경로 따라가기';
    setTimeout(() => { locateBtn.textContent = '📍 내 위치'; }, 2200);
  }
  function ensureWatch() { if (!stopWatch) { firstFix = true; stopWatch = watchPosition(onPos, onGeoErr); } }
  function maybeStopWatch() { if (!locateOn && !following && stopWatch) { stopWatch(); stopWatch = null; locLayer.remove(); } }

  function toggleLocate() {
    if (locateOn) { locateOn = false; locateBtn.classList.remove('active'); locateBtn.textContent = '📍 내 위치'; maybeStopWatch(); return; }
    locateOn = true; locateBtn.classList.add('active', 'loading'); locateBtn.textContent = '⏳'; ensureWatch();
  }
  function toggleFollow() {
    if (!navTrack) return;
    if (following) {
      following = false; navPanel.hidden = true; followBtn.classList.remove('active'); followBtn.textContent = '➡️ 경로 따라가기'; maybeStopWatch(); return;
    }
    following = true; followBtn.classList.add('active'); followBtn.textContent = '⏹ 안내 중지'; navPanel.hidden = false;
    navPanel.textContent = '위치 확인 중…'; ensureWatch();
    if (lastPos) updateNav(lastPos); // 정지 상태에서도 즉시 안내(다음 이동 이벤트를 기다리지 않음)
  }
  function updateNav(p) {
    const info = navInfo(navTrack, p); if (!info) return;
    const off = info.offRoute_m;
    const offEl = off > 40
      ? el('div', { class: 'nav-off warn' }, `⚠ 경로에서 ${fmtDist(off)} 벗어남`)
      : el('div', { class: 'nav-off ok' }, `✓ 경로 위 (±${fmtDist(off)})`);
    clear(navPanel);
    navPanel.append(
      el('div', { class: 'nav-row' },
        el('div', { class: 'nav-stat' }, el('b', {}, fmtDist(info.remaining_m)), el('span', {}, '정상까지(경로상)')),
        el('div', { class: 'nav-stat' }, el('b', {}, `${Math.round(info.progress * 100)}%`), el('span', {}, '진행률')),
        el('div', { class: 'nav-stat' }, el('b', {}, p.altitude != null ? `${Math.round(p.altitude)}m` : '—'), el('span', {}, '현재 고도'))),
      offEl);
  }

  // ---- trails (난이도·시간: 웹 조사 + 복수 자료 교차검증) ----
  if (m.trails?.length) {
    const VBADGE = { verified: ['교차검증 일치', 'v-ok'], mixed: ['난이도 이견', 'v-mixed'], single: ['단일 확인', 'v-single'] };
    const grid = el('div', { class: 'trail-grid' });
    m.trails.forEach((t) => {
      const vb = t.verify && VBADGE[t.verify.level];
      const facts = el('div', { class: 't-facts' },
        t.start ? factSpan('들머리', t.start) : null,
        t.distance_km ? factSpan('거리', `${t.distance_km}km`) : null,
        t.ascent_hours ? factSpan('오름(편도)', `${t.ascent_hours}시간`) : null,
        t.round_trip_hours ? factSpan('왕복', `${t.round_trip_hours}시간`) : (t.duration && !t.ascent_hours ? factSpan('소요', t.duration) : null),
        t.difficulty ? el('span', { class: 'diff ' + (DIFF_CLASS[t.difficulty] || 'd2') }, t.difficulty) : null,
        vb ? el('span', { class: 'vbadge ' + vb[1], title: verifyTitle(t.verify) }, vb[0]) : null);
      const routeBtn = t.trailhead
        ? el('button', { class: 'course-route-btn', type: 'button', title: '이 코스를 지도·고도로 보기' }, '🗻 지도·고도')
        : null;
      if (routeBtn) routeBtn.addEventListener('click', () => showCourseRoute(t, routeBtn));
      grid.append(el('div', { class: 'trail-card' },
        el('div', { class: 't-name' }, t.name || '주요 코스', routeBtn), facts,
        t.note ? el('div', { class: 't-note' }, t.note) : null));
    });
    page.append(el('div', { class: 'section' },
      el('h3', {}, '주요 등산로'),
      el('p', { class: 'conf-note', style: 'margin:-4px 0 12px' }, '난이도·등반시간은 웹 조사와 복수의 독립 자료를 교차검증한 값입니다. “🗻 지도·고도”로 각 코스의 실제 경로와 고도를 볼 수 있습니다.'),
      grid));
  }

  // ---- transport ----
  if (m.transport)
    page.append(el('div', { class: 'section' }, el('h3', {}, '교통'), el('p', { class: 'prose' }, m.transport)));

  // ---- features ----
  if (m.features?.length)
    page.append(el('div', { class: 'section' }, el('h3', {}, '특징'),
      el('div', { class: 'tags' }, ...m.features.map((f) => el('span', { class: 'tag' }, `#${f}`)))));

  // ---- sources ----
  if (m.sources?.length)
    page.append(el('div', { class: 'section' }, el('h3', {}, '출처'),
      el('ul', { class: 'source-list' }, ...m.sources.map((s) =>
        el('li', {}, el('a', { href: s, target: '_blank', rel: 'noopener' }, s))))));

  page.append(el('div', { class: 'disclaimer' },
    'ⓘ 이 문서는 산림청 100대 명산·블랙야크 명산100·한국의산하 인기명산 100·월간산 100대 명산 공개 목록과 웹 조사를 바탕으로 자동 정리되었습니다. ' +
    (m.hansanha_rank ? '한국의산하 인기명산 순위는 koreasanha.net 접속순위 집계(2003~2004년 기준 아카이브)입니다. ' : '') +
    (m.wolgansan_criteria ? '월간산 선정기준 부문 수는 2018년 선정기준 표를 재집계한 값으로, 월간산 자체 집계(연봉 포함)와 다를 수 있습니다. ' : '') +
    '실제 산행 전에는 국립공원·지자체의 최신 탐방로·통제 정보를 반드시 확인하세요. ' +
    '지도의 등산로 선은 OpenStreetMap 데이터이며, GPX는 실제 기록 파일만 표시합니다.'));

  const off = onChange(paintHike);
  const onTheme = () => view && view.refreshTheme();
  window.addEventListener('kr100:theme', onTheme);
  window.scrollTo(0, 0);
  return () => { if (stopWatch) stopWatch(); off(); window.removeEventListener('kr100:theme', onTheme); controls?.cleanup?.(); view?.destroy(); };
}

function factSpan(label, val) {
  return el('span', {}, `${label} `, el('b', {}, val));
}

// 한국의산하 인기명산 순위 메달 (상위권 강조)
function rankMedal(rank) {
  const m = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank <= 10 ? '🏅' : '';
  return m ? el('span', { class: 'medal', 'aria-hidden': 'true' }, m + ' ') : null;
}

// 리스트 pill — 한국의산하는 인기명산 순위, 월간산은 선정기준 충족 개수를 함께 표시
function listPill(k, m) {
  if (k === 'hansanha' && m.hansanha_rank) {
    return el('span', { class: 'pill p-hansanha ranked', title: '한국의 산하(koreasanha.net) 인기명산 100 접속순위' },
      rankMedal(m.hansanha_rank), '한국의산하 인기명산', el('b', { class: 'pill-rank' }, ` ${m.hansanha_rank}위`));
  }
  if (k === 'wolgansan' && m.wolgansan_criteria) {
    const wc = m.wolgansan_criteria;
    return el('span', { class: 'pill p-wolgansan scored', title: `월간산 11개 세부 선정기준 중 해당 부문: ${wc.groups.join(' · ')}` },
      '월간산 선정기준', el('b', { class: 'pill-rank' }, ` ${wc.count}개 부문`));
  }
  return el('span', { class: `pill p-${k}` }, LIST_META[k].full);
}

function verifyTitle(v) {
  const d = v.difficulties || {};
  const parts = [d.survey && `웹조사:${d.survey}`, d.crosscheck1 && `교차검증①:${d.crosscheck1}`, d.crosscheck2 && `교차검증②:${d.crosscheck2}`].filter(Boolean);
  return parts.length ? `출처별 난이도 — ${parts.join(' · ')}` : '';
}

// 수록 GPX 목록(gpx/index.json). 목록에 없는 산은 아예 요청하지 않아 404 콘솔 오류를 없앤다.
let _gpxManifest;
async function curatedGpxIds() {
  if (_gpxManifest) return _gpxManifest;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}gpx/index.json`);
    _gpxManifest = new Set(res.ok ? await res.json() : []);
  } catch { _gpxManifest = new Set(); }
  return _gpxManifest;
}

async function tryLoadCuratedGPX(id, note) {
  try {
    if (!(await curatedGpxIds()).has(id)) return null; // 수록 경로 없음 → 조용히 종료
    const res = await fetch(`${import.meta.env.BASE_URL}gpx/${id}.gpx`);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (ct.includes('html') || text.trimStart().startsWith('<!')) return null; // dev server 200-fallback
    const track = parseGPX(text);
    note.textContent = `수록 경로: ${track.name || id} · 거리 ${track.distance_km}km` +
      (track.gain_m ? ` · 누적 상승 ${track.gain_m}m` : '');
    return { track };
  } catch { return null; }
}
