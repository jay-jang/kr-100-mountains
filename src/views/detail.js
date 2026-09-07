import { loadData, DIFF_CLASS, regionColor, LIST_KEYS, LIST_META } from '../data.js';
import { createMapView, fetchTrails } from '../map.js';
import { mapControls } from '../mapcontrols.js';
import { isHiked, toggleHiked, onChange, recordView } from '../store.js';
import { parseGPX, drawTrack, navInfo, haversine } from '../gpx.js';
import { watchPosition, fmtDist, fmtDistFine, directionsLinks } from '../geo.js';
import { cachedPosition, notePosition, distanceTo, bearingLabel } from '../position.js';
import { fetchElevations, resample, buildProfile, profileFromTrack, elevationChart, profileStats } from '../elevation.js';
import { routeTrailheadToSummit } from '../routing.js';
import { routeDownloadSection } from '../routegpx.js';
import { reviewSection } from '../reviews.js';
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

  const page = el('div', { class: 'page detail-page' });
  root.append(page);
  // 라우트를 떠난 뒤 늦게 도착한 응답이 파괴된 지도를 건드리지 않게 하는 표식.
  let disposed = false;

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

  // 현재 위치를 이미 알고 있으면(다른 화면에서 측정) 직선거리를 함께 보여준다. 새로 묻지는 않는다.
  const myPos = cachedPosition();
  const myDist = m.lat != null ? distanceTo(myPos, m.lat, m.lon) : Infinity;

  const sub = el('div', { class: 'sub' },
    el('span', {}, `${m.region} · ${m.location}`),
    el('span', { class: 'elev' }, `해발 ${m.elevation_m}m`),
    Number.isFinite(myDist)
      ? el('span', { class: 'sub-dist', title: '현재 위치에서의 직선거리' }, `현 위치에서 ${bearingLabel(myPos, m.lat, m.lon)}쪽 ${fmtDistFine(myDist)}`)
      : null,
    m.best_season ? el('span', {}, `${m.best_season}`) : null);

  page.append(el('div', { class: 'hero' },
    el('div', {},
      el('h2', {}, m.name, m.disambig ? el('span', { class: 'han' }, `(${m.disambig})`) : null),
      sub),
    el('div', { class: 'hero-badges' },
      ...LIST_KEYS.filter((k) => m.lists[k]).map((k) => listPill(k, m))),
    hikeBtn));

  const contents = el('nav', { class: 'detail-contents', 'aria-label': '산 정보 목차' });
  page.append(contents);

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
  const fileBtn = el('button', { type: 'button', onClick: () => fileInput.click() }, 'GPX 불러오기');
  const locateBtn = el('button', { type: 'button', title: '내 위치 실시간 표시' }, '내 위치');
  const dirBtn = el('button', { type: 'button', title: '외부 지도 길찾기' }, '길찾기');
  const followBtn = el('button', { type: 'button', disabled: true, title: 'GPX 경로를 따라 실시간 안내' }, '경로 따라가기');
  const dirMenu = el('div', { class: 'dir-menu', hidden: true });
  const tools = el('div', { class: 'map-tools' }, locateBtn, dirBtn, fileBtn, followBtn, fileInput);
  const navPanel = el('div', { class: 'nav-panel', hidden: true });
  const mapWrap = el('div', { class: 'detail-map-wrap' }, mapNode, tools, dirMenu);
  const gpxNote = el('div', { class: 'conf-note' });
  page.append(el('div', { class: 'section' }, el('h3', {}, '위치 · 경로 · 내비게이션'), mapWrap, navPanel, gpxNote));

  // ---- 등산로별 고도 (등산로 선택 → 그 경로만 지도 표시 + 고도 프로파일) ----
  const OSM_COLORS = ['#1a73e8', '#e2872a', '#8e44ad', '#16a085', '#c0392b'];
  // 수집한 계산 경로는 실측(빨강)·OSM 등산로와 한눈에 구분되도록 보라 계열로 따로 둔다.
  const COLLECTED_COLORS = ['#7048e8', '#0b7285', '#a61e4d', '#5c7cfa'];
  const routeList = el('div', { class: 'route-list' });
  const loadTrailsBtn = el('button', { class: 'btn', type: 'button' }, '실제 등산로 불러오기');
  const showOnMapChk = el('input', { type: 'checkbox', id: 'route-showmap', checked: true });
  const showOnMapLabel = el('label', { class: 'route-showmap', for: 'route-showmap' }, showOnMapChk, ' 지도에 겹쳐 표시');
  const routeLoading = el('div', { class: 'route-loading', hidden: true },
    el('span', { class: 'spinner', 'aria-hidden': 'true' }),
    el('span', {}, '실제 등산로와 고도를 불러오는 중… (최대 수십 초 걸릴 수 있어요)'));
  const elevChartBox = el('div', { class: 'elev-chart-box' });
  const elevNote = el('div', { class: 'conf-note', style: 'margin-top:8px' });
  page.append(el('div', { class: 'section' },
    el('h3', {}, '등산로별 고도'),
    el('p', { class: 'conf-note', style: 'margin:-4px 0 10px' },
      '등산로를 고르면 아래에 고도 단면이 나타납니다. 각 항목의 “지도”를 켜면 여러 경로를 지도에 '
      + '겹쳐 볼 수 있습니다. GPX 파일 또는 OpenStreetMap 실제 등산로(고도: open-meteo 지형데이터) 기반이며, '
      + '“계산” 표시가 붙은 것은 실측 기록이 아니라 등산로망 위에서 계산한 경로입니다.'),
    el('div', { class: 'route-actions' }, loadTrailsBtn, showOnMapLabel),
    routeLoading, routeList, elevChartBox, elevNote));

  // 수집해 둔 코스별 경로 GPX — 내려받기 + "지도에 표시"(있는 산에서만 나타난다).
  // 자동으로 그리지는 않는다. 사용자가 올릴 때만 위 등산로 목록에 합류시켜
  // 주요 등산로와 겹쳐 볼 수 있게 한다.
  page.append(routeDownloadSection(m.id, {
    onShow: (t) => addCollectedRoute(t),
    onShowAll: (list) => addCollectedRoutes(list),
  }));

  // 교차검증한 탐방 후기·현장 정보(수집된 산에서만 나타난다).
  page.append(reviewSection(m.id));

  // 경로는 배열 인덱스가 아니라 **고유 id로 식별**한다. OSM 등산로를 다시 불러오면 배열에서
  // 빠지면서 인덱스가 당겨지는데, 그때 표시 상태·수집 경로 매핑이 통째로 어긋나기 때문이다.
  const routes = [];                     // { rid, label, latlngs, profile, track|null, kind, color }
  const byRid = new Map();               // rid → route
  let routeSeq = 0;
  let activeId = null;                   // 고도 단면을 보여 주는 경로
  // 여러 경로를 동시에 지도에 올릴 수 있다 — 수집한 GPX를 주요 등산로와 나란히 겹쳐 보기 위해서다.
  const shown = new Set();               // 지도에 올라간 rid
  const layersById = new Map();          // rid → 지도 레이어 토큰

  // 색은 만들 때 한 번 정해 둔다(인덱스로 계산하면 목록이 줄어들 때 색이 바뀐다).
  const colorSeq = { collected: 0, other: 0 };
  const pickColor = (kind) => (kind === 'gpx' ? '#d1495b'
    : kind === 'collected' ? COLLECTED_COLORS[colorSeq.collected++ % COLLECTED_COLORS.length]
    : OSM_COLORS[colorSeq.other++ % OSM_COLORS.length]);

  function renderRouteList() {
    clear(routeList);
    if (!routes.length) { routeList.append(el('div', { class: 'conf-note' }, 'GPX를 불러오거나 “실제 등산로 불러오기”로 등산로를 추가하세요.')); return; }
    for (const r of routes) {
      const on = shown.has(r.rid);
      const pick = el('button', { class: 'route-pick', type: 'button', title: '고도 단면 보기' },
        el('span', { class: 'route-swatch', style: `background:${r.color}` }),
        el('span', { class: 'route-label' }, r.label),
        r.kind === 'collected' ? el('span', { class: 'route-tag', title: '실측 기록이 아니라 OSM 등산로망에서 계산한 경로' }, '계산') : null,
        r.profile ? el('span', { class: 'route-meta' }, `↑${r.profile.gain_m}m · ${fmtDist(r.profile.dist_m)}`) : null);
      pick.addEventListener('click', () => selectRoute(r.rid));
      const eye = el('button', {
        class: 'route-eye' + (on ? ' on' : ''), type: 'button',
        'aria-pressed': on ? 'true' : 'false',
        title: on ? '지도에서 숨기기' : '지도에 표시',
      }, on ? '표시중' : '지도');
      eye.addEventListener('click', () => toggleShown(r.rid));
      routeList.append(el('div', { class: 'route-item' + (r.rid === activeId ? ' active' : '') }, pick, eye));
    }
  }

  function drawShownRoutes({ refit = false } = {}) {
    if (disposed || !view) return;
    for (const tokens of layersById.values()) view.removeLayer(tokens);
    layersById.clear();
    const all = [];
    for (const rid of shown) {
      const r = byRid.get(rid);
      if (!r?.latlngs?.length) continue;
      // 겹쳐 그리므로 여기서는 화면을 맞추지 않는다(아래에서 전체 기준으로 한 번만).
      const layers = [...drawTrack(view, { latlngs: r.latlngs }, r.color, { fit: false })];
      // 지점 이름 라벨은 지금 보고 있는 경로에만 — 여러 개를 켜면 라벨이 지도를 덮는다.
      if (rid === activeId) {
        if (r.trailheadName && r.latlngs[0]) layers.push(view.addLabel({ lat: r.latlngs[0][0], lng: r.latlngs[0][1], text: r.trailheadName, kind: 'trailhead' }));
        if (r.peaks) for (const pk of r.peaks.slice(0, 8)) {
          if (haversine(pk.lat, pk.lon, m.lat, m.lon) < 200) continue; // 정상 라벨과 겹치는 봉우리는 생략
          layers.push(view.addLabel({ lat: pk.lat, lng: pk.lon, text: pk.name, kind: 'peak' }));
        }
      }
      layersById.set(rid, layers);
      all.push(...r.latlngs);
    }
    if (refit && all.length) view.fitBounds(all, 0.15);
  }

  // 전체 스위치와 개별 토글의 상태가 어긋나지 않게 맞춘다(프로그램적 변경은 change를 쏘지 않는다).
  const syncMasterSwitch = () => { showOnMapChk.checked = shown.size > 0; };

  function toggleShown(rid) {
    if (shown.has(rid)) shown.delete(rid); else shown.add(rid);
    syncMasterSwitch();
    renderRouteList();
    drawShownRoutes({ refit: shown.has(rid) });
  }

  function showProfile(r) {
    clear(elevChartBox);
    if (r?.profile) elevChartBox.append(elevationChart(r.profile), profileStats(r.profile));
    else elevChartBox.append(el('div', { class: 'conf-note' }, '이 등산로의 고도 데이터를 만들 수 없습니다.'));
  }

  function selectRoute(rid, { show = true } = {}) {
    const r = byRid.get(rid);
    if (!r) return;
    activeId = rid;
    if (show) { shown.add(rid); syncMasterSwitch(); }
    renderRouteList();
    showProfile(r);
    drawShownRoutes({ refit: show });
    setNavTrack(r.track || null);
  }

  // 체크박스는 전체 표시/숨김 스위치. 껐다 켜면 겹쳐 두었던 선택을 그대로 되살린다
  // (rid로 담아 두므로 그 사이 목록이 바뀌어도 엉뚱한 경로가 복원되지 않는다).
  let stashedShown = null;
  showOnMapChk.addEventListener('change', () => {
    if (showOnMapChk.checked) {
      for (const rid of stashedShown || []) if (byRid.has(rid)) shown.add(rid);
      if (!shown.size && activeId != null && byRid.has(activeId)) shown.add(activeId);
      stashedShown = null;
    } else {
      stashedShown = [...shown];
      shown.clear();
    }
    renderRouteList();
    drawShownRoutes({ refit: showOnMapChk.checked });
  });

  /** 경로를 목록에 추가하고 rid를 돌려준다. quiet=true면 그리기·선택을 호출측이 모아서 한다. */
  function addRoute(route, { quiet = false } = {}) {
    const rid = ++routeSeq;
    const r = { ...route, rid, color: pickColor(route.kind) };
    routes.push(r); byRid.set(rid, r);
    if (!quiet) selectRoute(rid);
    return rid;
  }

  /** 지도·목록에서 이 경로들을 완전히 걷어낸다(레이어까지). */
  function removeRoutes(pred) {
    for (const r of routes.filter(pred)) {
      const tokens = layersById.get(r.rid);
      if (tokens && view && !disposed) view.removeLayer(tokens);
      layersById.delete(r.rid); shown.delete(r.rid); byRid.delete(r.rid);
      if (activeId === r.rid) activeId = null;
    }
    for (let i = routes.length - 1; i >= 0; i--) if (pred(routes[i])) routes.splice(i, 1);
  }

  function addGpxRoute(track, label) {
    const finish = (profile, note) => { addRoute({ label, latlngs: track.latlngs, profile, track, kind: 'gpx' }); if (note) elevNote.textContent = note; };
    const direct = profileFromTrack(track);
    if (direct) { finish(direct); return; }
    elevNote.textContent = 'GPX에 고도가 없어 지형 고도를 조회하는 중…';
    const line = resample(track.latlngs, 80);
    fetchElevations(line).then((eles) => finish(buildProfile(line, eles), '※ 고도는 open-meteo 지형 데이터로 보완했습니다.'))
      .catch(() => { finish(null); elevNote.textContent = '고도 조회 실패(경로는 지도에 표시됩니다).'; });
  }
  // 수집해 둔 코스 GPX를 등산로 목록에 합류시킨다 — 주요 등산로와 같은 목록·같은 지도에서
  // 겹쳐 보기 위해서다. 파일에 고도가 들어 있으므로 고도 API를 부르지 않는다.
  // 이미 올린 파일을 다시 누르면 새로 받지 않고 그 항목을 선택만 한다.
  const collectedRid = new Map();        // 파일 경로 → 경로 rid
  const collectedLoading = new Map();    // 파일 경로 → 진행 중인 요청
  async function addCollectedRoute(t, { quiet = false } = {}) {
    const known = collectedRid.get(t.file);
    if (known != null && byRid.has(known)) { if (!quiet) { selectRoute(known); scrollToRoutes(); } else shown.add(known); return known; }
    // 좌표가 같아 파일을 공유하는 코스가 여러 행으로 보이므로, 서로 다른 행에서 같은 파일을
    // 동시에 열 수 있다. 진행 중인 요청에 합류시켜 같은 경로가 목록에 두 번 실리지 않게 한다.
    const inflight = collectedLoading.get(t.file);
    if (inflight) return inflight;
    const job = (async () => {
      if (!quiet) { elevNote.textContent = ''; routeLoading.hidden = false; }
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}gpx/${t.file}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const track = parseGPX(await res.text());
        if (disposed) return null;                       // 이미 다른 화면으로 떠났다
        const label = t.label || `${t.route_name || '수집 경로'}${t.variant ? ` (대안 ${t.variant})` : ''}`;
        const rid = addRoute({ label, latlngs: track.latlngs, profile: profileFromTrack(track), track, kind: 'collected' }, { quiet });
        collectedRid.set(t.file, rid);
        if (quiet) shown.add(rid);
        else {
          elevNote.textContent = '※ 실측 기록이 아니라 OpenStreetMap 등산로망 위에서 계산한 경로입니다. '
            + '현장 통제·계절 통제를 반영하지 않을 수 있으니 공식 안내를 함께 확인하세요.';
          scrollToRoutes();
        }
        return rid;
      } catch (e) {
        // 실패를 삼키면 버튼이 "추가됨"으로 바뀌어 거짓말이 된다. 알리고 다시 던진다.
        elevNote.textContent = '수집 경로를 불러오지 못했습니다: ' + (e.message || e);
        throw e;
      } finally {
        if (!quiet) routeLoading.hidden = true;
        collectedLoading.delete(t.file);
      }
    })();
    collectedLoading.set(t.file, job);
    return job;
  }

  // 여러 개를 한꺼번에 올릴 때는 파일을 다 받은 뒤 목록·지도를 **한 번만** 갱신한다.
  // 하나씩 그리면 코스가 많은 산에서 지도 재생성·화면 맞춤·스크롤이 그 횟수만큼 반복된다.
  async function addCollectedRoutes(list) {
    if (!list.length) return;
    routeLoading.hidden = false;
    elevNote.textContent = '';
    let firstRid = null, failed = 0;
    try {
      for (const t of list) {
        try { const rid = await addCollectedRoute(t, { quiet: true }); if (rid && firstRid == null) firstRid = rid; }
        catch { failed++; }
        if (disposed) return;
      }
    } finally { routeLoading.hidden = true; }
    syncMasterSwitch();
    renderRouteList();
    if (firstRid != null && activeId == null) { activeId = firstRid; showProfile(byRid.get(firstRid)); }
    drawShownRoutes({ refit: true });
    elevNote.textContent = `※ 계산 경로 ${list.length - failed}개를 지도에 겹쳐 표시했습니다`
      + (failed ? ` (${failed}개 실패)` : '')
      + '. 실측 기록이 아니라 OpenStreetMap 등산로망 위에서 계산한 경로입니다.';
    scrollToRoutes();
  }

  const lineLen = (l) => { let d = 0; for (let i = 1; i < l.length; i++) d += haversine(l[i - 1][0], l[i - 1][1], l[i][0], l[i][1]); return d; };

  // 주요 등산로 코스 → 교차검증된 들머리에서 정상까지 실제 경로 + 고도로 연결
  const scrollToRoutes = () => routeList.scrollIntoView({ behavior: 'smooth', block: 'center' });
  async function showCourseRoute(t, btn) {
    if (!t.trailhead || m.lat == null) return;
    const hit = routes.find((r) => r.courseName === t.name);
    if (hit) { selectRoute(hit.rid); scrollToRoutes(); return; }
    const orig = btn ? btn.textContent : '';
    if (btn) setBtnLoading(btn, true, '찾는 중…');
    routeLoading.hidden = false;
    elevNote.textContent = ''; scrollToRoutes();
    try {
      let route = null;
      try { route = await routeTrailheadToSummit(t.trailhead, [m.lat, m.lon]); } catch {}
      const peaks = route?.peaks || null;
      const thName = t.start ? `들머리 ${t.start}` : '들머리';
      if (route && route.latlngs && route.latlngs.length > 3) {
        const sampled = resample(route.latlngs, 90);
        const prof = buildProfile(sampled, await fetchElevations(sampled));
        addRoute({ label: t.name, courseName: t.name, latlngs: route.latlngs, profile: prof, track: null, kind: 'course', trailheadName: thName, peaks });
        elevNote.textContent = '※ 교차검증된 들머리에서 정상까지 실제 등산로 경로와 고도(open-meteo 지형데이터)입니다.';
      } else {
        const N = 30, a = t.trailhead, b = [m.lat, m.lon], line = [];
        for (let i = 0; i <= N; i++) { const f = i / N; line.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
        const prof = buildProfile(line, await fetchElevations(line));
        addRoute({ label: `${t.name} (직선참고)`, courseName: t.name, latlngs: [a, b], profile: prof, track: null, kind: 'course', trailheadName: thName, peaks });
        elevNote.textContent = '※ 실제 등산로 연결을 확인하지 못해 들머리→정상 직선 기준 지형 고도를 표시합니다.';
      }
    } catch (e) { elevNote.textContent = '경로 불러오기 실패: ' + (e.message || e); }
    finally { routeLoading.hidden = true; if (btn) setBtnLoading(btn, false, null, orig); }
  }

  const setBtnLoading = (btn, on, loadingText, restoreText) => {
    btn.disabled = on; btn.classList.toggle('loading', on);
    clear(btn);
    if (on) { btn.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' ' + loadingText); }
    else { btn.textContent = restoreText; }
  };

  loadTrailsBtn.addEventListener('click', async () => {
    if (m.lat == null) { elevNote.textContent = '정상 좌표가 없어 불러올 수 없습니다.'; return; }
    const orig = loadTrailsBtn.textContent;
    setBtnLoading(loadTrailsBtn, true, '불러오는 중…');
    routeLoading.hidden = false;
    elevNote.textContent = '';
    try {
      const lines = await fetchTrails(m.lat, m.lon, 2500);
      const top = lines.map((l) => ({ l, len: lineLen(l) })).filter((o) => o.len > 400).sort((a, b) => b.len - a.len).slice(0, 4);
      if (!top.length) { elevNote.textContent = '인근에서 표시할 등산로를 찾지 못했습니다.'; return; }
      // 이전에 불러온 OSM 등산로는 지도 레이어까지 걷어내고 교체한다(다시 눌러도 누적되지 않도록).
      // GPX·코스·수집 경로는 그대로 둔다.
      removeRoutes((r) => r.kind === 'osm');
      let first = null, n = 0;
      for (const { l, len } of top) {
        const line = resample(l, 55);
        let prof = null; try { prof = buildProfile(line, await fetchElevations(line)); } catch {}
        if (disposed) return;
        n++;
        const rid = addRoute({ label: `OSM 등산로 ${n} (${(len / 1000).toFixed(1)}km)`, latlngs: line, profile: prof, track: null, kind: 'osm' }, { quiet: true });
        if (first == null) first = rid;
      }
      if (first != null) selectRoute(first); // 첫 신규 등산로 선택
      elevNote.textContent = '※ OpenStreetMap 등산로 좌표의 고도를 open-meteo로 조회한 실제 값입니다.';
    } catch (e) { elevNote.textContent = '불러오기 실패: ' + (e.message || e); }
    finally {
      routeLoading.hidden = true;
      setBtnLoading(loadTrailsBtn, false, null, routes.some((r) => r.kind === 'osm') ? '실제 등산로 다시 불러오기' : orig);
      renderRouteList();
    }
  });
  renderRouteList();

  let view, controls, navTrack = null, locLayer = null;
  let stopWatch = null, locateOn = false, following = false, firstFix = false, lastPos = null;

  if (m.lat != null) {
    view = await createMapView(mapNode, { center: [m.lat, m.lon], zoom: 13 });
    // 전체화면에서는 상세 페이지에도 검색 경로가 없으므로 공용 검색을 붙인다.
    // 다른 산을 고르면 그 산의 상세로 이동한다(라우트 정리 과정에서 전체화면도 해제된다).
    controls = mapControls(view, mapWrap, {
      search: {
        mountains: data.mountains,
        getPos: () => cachedPosition(),
        onPick: (picked) => {
          if (picked.id === m.id) { view.panTo([m.lat, m.lon]); return; }
          location.hash = `#/m/${picked.id}`;
        },
      },
      // 전체화면에서 길찾기 메뉴가 열린 채 남으면 검색창을 가린다(모바일에서 특히).
      onFullscreenChange: () => { dirMenu.hidden = true; },
    });
    mapWrap.append(controls);
    view.addDot({ lat: m.lat, lng: m.lon, color: regionColor(m.region), title: `${m.name} 정상 ${m.elevation_m}m` });
    view.addLabel({ lat: m.lat, lng: m.lon, text: `${m.name} 정상`, kind: 'summit' }); // 주요 지점 이름(정상)
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
    notePosition(p);     // 공유 캐시 갱신 — 홈 "내 주변"·지도 "가까운 순"이 같은 위치를 쓴다
    locLayer.set(p);
    if (firstFix) { firstFix = false; (view.flyTo ? view.flyTo : view.setView).call(view, [p.lat, p.lng], 14); }
    locateBtn.classList.remove('loading'); locateOn && (locateBtn.textContent = '🎯 위치 추적중');
    if (following && navTrack) updateNav(p);
  }
  function onGeoErr(err) {
    if (stopWatch) { stopWatch(); stopWatch = null; }
    locLayer.remove(); locateOn = false; following = false; navPanel.hidden = true;
    locateBtn.classList.remove('loading', 'active'); locateBtn.textContent = err.code === 1 ? '🚫 권한 거부' : '⚠️ 위치 실패';
    followBtn.classList.remove('active'); followBtn.textContent = '경로 따라가기';
    setTimeout(() => { locateBtn.textContent = '내 위치'; }, 2200);
  }
  function ensureWatch() { if (!stopWatch) { firstFix = true; stopWatch = watchPosition(onPos, onGeoErr); } }
  function maybeStopWatch() { if (!locateOn && !following && stopWatch) { stopWatch(); stopWatch = null; locLayer.remove(); } }

  function toggleLocate() {
    if (locateOn) { locateOn = false; locateBtn.classList.remove('active'); locateBtn.textContent = '내 위치'; maybeStopWatch(); return; }
    locateOn = true; locateBtn.classList.add('active', 'loading'); locateBtn.textContent = '⏳'; ensureWatch();
  }
  function toggleFollow() {
    if (!navTrack) return;
    if (following) {
      following = false; navPanel.hidden = true; followBtn.classList.remove('active'); followBtn.textContent = '경로 따라가기'; maybeStopWatch(); return;
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
        ? el('button', { class: 'course-route-btn', type: 'button', title: '이 코스를 지도·고도로 보기' }, '지도·고도')
        : null;
      if (routeBtn) routeBtn.addEventListener('click', () => showCourseRoute(t, routeBtn));
      grid.append(el('div', { class: 'trail-card' },
        el('div', { class: 't-name' }, t.name || '주요 코스', routeBtn), facts,
        t.note ? el('div', { class: 't-note' }, t.note) : null));
    });
    page.append(el('div', { class: 'section' },
      el('h3', {}, '주요 등산로'),
      el('p', { class: 'conf-note', style: 'margin:-4px 0 12px' }, '난이도·등반시간은 웹 조사와 복수의 독립 자료를 교차검증한 값입니다. “지도·고도”로 각 코스의 실제 경로와 고도를 볼 수 있습니다.'),
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
    '지도의 등산로 선은 OpenStreetMap 데이터입니다. GPX는 실측 기록과 “계산 경로”를 구분해 표시하며, 계산 경로는 OpenStreetMap 등산로망 위에서 계산한 것이라 실제 기록이 아닙니다.'));

  page.querySelectorAll('.section').forEach((section, i) => {
    const title = section.querySelector('h3');
    if (!title) return;
    section.id = `mountain-section-${i}`;
    contents.append(el('button', { type: 'button', onClick: () => section.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }) }, title.childNodes[0].textContent.trim()));
  });

  const off = onChange(paintHike);
  const onTheme = () => view && view.refreshTheme();
  window.addEventListener('kr100:theme', onTheme);
  window.scrollTo(0, 0);
  return () => {
    // 늦게 도착하는 fetch가 파괴된 지도를 건드리지 않도록 표식을 먼저 세우고 참조를 끊는다.
    disposed = true;
    if (stopWatch) stopWatch();
    off();
    window.removeEventListener('kr100:theme', onTheme);
    controls?.cleanup?.();
    layersById.clear();
    view?.destroy();
    view = null;
  };
}

function factSpan(label, val) {
  return el('span', {}, `${label} `, el('b', {}, val));
}


function listPill(k, m) {
  if (k === 'hansanha' && m.hansanha_rank) {
    return el('span', { class: 'pill p-hansanha ranked', title: '한국의 산하(koreasanha.net) 인기명산 100 접속순위' },
      '한국의산하 인기명산', el('b', { class: 'pill-rank' }, ` ${m.hansanha_rank}위`));
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
