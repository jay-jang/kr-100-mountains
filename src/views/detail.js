import { loadData, DIFF_CLASS, regionColor, LIST_KEYS, LIST_META } from '../data.js';
import { createMapView } from '../map.js';
import { mapControls } from '../mapcontrols.js';
import { isHiked, onChange, recordView } from '../store.js';
import { parseGPX, drawTrack, navInfo, haversine } from '../gpx.js';
import { watchPosition, fmtDist, fmtDistFine, directionsLinks } from '../geo.js';
import { cachedPosition, notePosition, distanceTo, bearingLabel } from '../position.js';
import { fetchElevations, resample, buildProfile, profileFromTrack, elevationChart, profileStats } from '../elevation.js';
import { routeTrailheadToSummit, fetchMountainTrailNetwork } from '../routing.js';
import { routeDownloadSection, routeEntryFor, routePayloads } from '../routegpx.js';
import { routePlanner } from '../routeplanner.js';
import { reviewSection } from '../reviews.js';
import { editHike } from '../hikerecord.js';
import { el, esc, clear } from '../dom.js';
import { famousCourseRow } from '../famouscourses.js';
import { nearbyRoutes } from '../mapselection.js';

export async function renderDetail(root, id, { returnTo = '#/map' } = {}) {
  const data = await loadData();
  if (!root.isConnected) return () => {};
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
  const routeAbort = new AbortController();

  // ---- breadcrumb ----
  page.append(el('div', { class: 'crumb' },
    el('a', { class: 'detail-return', href: returnTo }, returnTo.startsWith('#/courses') ? '← 대표 코스로 돌아가기' : returnTo === '#/track' ? '← 내 기록으로 돌아가기' : returnTo === '#/' ? '← 홈으로 돌아가기' : '← 탐색으로 돌아가기'),
    el('span', { 'aria-hidden': 'true' }, ' / '),
    el('a', { href: '#/map' }, '지도'), ' / ',
    el('a', { href: `#/map?region=${encodeURIComponent(m.region)}&focus=${m.id}` }, m.region), ' / ', m.name_full));

  // ---- hero ----
  const hikeBtn = el('button', { class: 'hike-btn' + (isHiked(m.id) ? ' done' : '') });
  const paintHike = () => {
    const on = isHiked(m.id);
    hikeBtn.className = 'hike-btn' + (on ? ' done' : '');
    hikeBtn.textContent = on ? '★ 등정 완료 · 수정' : '☆ 등정 기록';
    hikeBtn.setAttribute('aria-pressed', String(on));
  };
  paintHike();
  hikeBtn.addEventListener('click', () => editHike(m));

  // 현재 위치를 이미 알고 있으면(다른 화면에서 측정) 직선거리를 함께 보여준다. 새로 묻지는 않는다.
  const myPos = cachedPosition();
  const myDist = m.lat != null ? distanceTo(myPos, m.lat, m.lon) : Infinity;

  const sub = el('div', { class: 'sub' },
    el('span', {}, m.region),
    el('span', { class: 'elev' }, `해발 ${m.elevation_m}m`),
    Number.isFinite(myDist)
      ? el('span', { class: 'sub-dist', title: '현재 위치에서의 직선거리' }, `현 위치에서 ${bearingLabel(myPos, m.lat, m.lon)}쪽 ${fmtDistFine(myDist)}`)
      : null);

  const badges = el('div', { class: 'hero-badges' },
    ...LIST_KEYS.filter((k) => m.lists[k]).map((k) => listPill(k, m)));

  page.append(el('div', { class: 'hero' },
    el('div', {},
      el('h2', {}, m.name, m.disambig ? el('span', { class: 'han' }, `(${m.disambig})`) : null),
      sub),
    hikeBtn));

  const contents = el('nav', { class: 'detail-contents', 'aria-label': '산 정보 목차' });
  page.append(contents);

  // ---- summary ----
  page.append(el('div', { class: 'section' },
    el('h3', {}, '개요'),
    badges,
    el('p', { class: 'conf-note' }, m.location, m.best_season ? ` · 추천 계절: ${m.best_season}` : ''),
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
  const mapNode = el('div', { id: 'detail-map', 'aria-label': `${m.name} 위치 지도` }, el('p', { class: 'explore-loading', role: 'status' }, '지도를 불러오는 중…'));
  const fileInput = el('input', { type: 'file', accept: '.gpx', multiple: true, style: 'display:none' });
  const fileBtn = el('button', { disabled: true, type: 'button', onClick: () => fileInput.click() }, 'GPX 여러 개 불러오기');
  const locateBtn = el('button', { disabled: true, type: 'button', title: '내 위치 실시간 표시' }, '내 위치');
  const dirBtn = el('button', { disabled: true, type: 'button', title: '외부 지도 길찾기' }, '길찾기');
  const followBtn = el('button', { type: 'button', disabled: true, title: 'GPX 경로를 따라 실시간 안내' }, '경로 따라가기');
  const dirMenu = el('div', { class: 'dir-menu', hidden: true });
  const tools = el('div', { class: 'map-tools' }, locateBtn, dirBtn, fileBtn, followBtn, fileInput);
  const navPanel = el('div', { class: 'nav-panel', hidden: true });
  const mapWrap = el('div', { class: 'detail-map-wrap' }, mapNode, tools, dirMenu);
  const routeMapStatus = el('div', { class: 'route-map-status', hidden: true, role: 'status' });
  const routeMapChoices = el('div', { class: 'map-choice-list' });
  const routeMapPicker = el('div', { class: 'map-choice-panel route-map-picker', hidden: true, 'aria-label': '지도 경로 선택' },
    el('div', { class: 'map-choice-head' }, el('strong', {}, '이 위치의 경로'),
      el('button', { type: 'button', 'aria-label': '경로 선택 닫기', onClick: () => { routeMapPicker.hidden = true; } }, '닫기')),
    routeMapChoices);
  mapWrap.append(routeMapStatus, routeMapPicker);
  const gpxNote = el('div', { class: 'conf-note' });
  const planner = routePlanner(m, {
    loadAll: loadPlanningRoutes,
    showRoutes: () => scrollToRoutes(),
    showMap: () => { mapWrap.scrollIntoView({ block: 'center', behavior: 'instant' }); view?.relayout(); },
    onPlan: plan => {
      removeRoutes(r => r.kind === 'planned');
      const track = { ...plan, name: `${m.name} 산행 계획`, hasEle: plan.points.every(p => Number.isFinite(p.ele)), segments: [plan.points] };
      addRoute({ label: `${m.name} · 나의 계획 (${(plan.distance_m / 1000).toFixed(2)}km)`, latlngs: plan.latlngs,
        profile: profileFromTrack(track), track, kind: 'planned', planningEligible: false });
    },
  });
  mapWrap.append(planner.mapTools);
  const plannerDisclosure = el('details', { class: 'planner-disclosure' },
    el('summary', {}, el('span', {}, '경로 계획'), el('small', {}, '여러 등산로를 조합해 나의 코스 만들기')),
    planner.root);
  // 지도는 모든 설명·코스보다 먼저, 계획 도구는 필요할 때 펼친다.
  page.insertBefore(el('section', { class: 'section planning-section', 'aria-label': '산행 지도' },
    el('h3', { class: 'map-section-heading' }, '산행 지도'), mapWrap, navPanel, gpxNote, plannerDisclosure), contents);

  // ---- 등산로별 고도 (등산로 선택 → 그 경로만 지도 표시 + 고도 프로파일) ----
  const OSM_COLORS = ['#1a73e8', '#e2872a', '#8e44ad', '#16a085', '#c0392b'];
  // 수집한 계산 경로는 실측(빨강)·OSM 등산로와 한눈에 구분되도록 보라 계열로 따로 둔다.
  const COLLECTED_COLORS = ['#7048e8', '#0b7285', '#a61e4d', '#5c7cfa'];
  const routeList = el('div', { class: 'route-list' });
  const loadTrailsBtn = el('button', { class: 'btn', type: 'button' }, '실제 등산로 불러오기');
  const showOnMapChk = el('input', { type: 'checkbox', id: 'route-showmap', checked: true });
  const showOnMapLabel = el('label', { class: 'route-showmap', for: 'route-showmap' }, showOnMapChk, ' 선택 경로 강조');
  const routeLoading = el('div', { class: 'route-loading', hidden: true },
    el('span', { class: 'spinner', 'aria-hidden': 'true' }),
    el('span', {}, '실제 등산로와 고도를 불러오는 중… (최대 수십 초 걸릴 수 있어요)'));
  const elevChartBox = el('div', { class: 'elev-chart-box' });
  const elevNote = el('div', { class: 'conf-note', style: 'margin-top:8px' });
  page.append(el('div', { class: 'section' },
    el('h3', {}, '등산로별 고도'),
    el('p', { class: 'conf-note', style: 'margin:-4px 0 10px' },
      '지도에서 경로를 누르거나 목록의 선택 버튼으로 경로를 선택·해제하세요. 해제한 경로는 흐리게 남으며 계획에서 제외됩니다. '
      + '등산로 이름을 고르면 고도 단면을 볼 수 있습니다. GPX 파일 또는 OpenStreetMap 실제 등산로(고도: open-meteo 지형데이터) 기반이며, '
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
  const shown = new Set();               // 지도에서 강조하고 계획에 사용할 rid
  const layersById = new Map();          // rid → 지도 레이어 토큰
  let mapChoiceIds = [];

  function paintMapChoices() {
    const focusedRid = routeMapChoices.contains(document.activeElement) ? document.activeElement.dataset.rid : null;
    mapChoiceIds = mapChoiceIds.filter(rid => byRid.has(rid));
    if (!mapChoiceIds.length) routeMapPicker.hidden = true;
    routeMapStatus.hidden = routes.length === 0;
    routeMapStatus.textContent = `${shown.size}/${routes.length}개 경로 선택 · 선을 눌러 선택·해제`;
    clear(routeMapChoices);
    for (const rid of mapChoiceIds) {
      const r = byRid.get(rid); if (!r) continue;
      const selected = shown.has(rid);
      routeMapChoices.append(el('button', { type: 'button', class: 'map-route-choice', 'aria-pressed': String(selected), dataset: { rid },
        onClick: () => toggleShown(rid, { focus: true }) },
      el('span', { class: 'route-swatch', style: `background:${r.color}` }),
      el('span', {}, r.label), el('strong', {}, selected ? '선택됨' : '해제 · 흐리게')));
    }
    if (focusedRid) routeMapChoices.querySelector(`[data-rid="${focusedRid}"]`)?.focus({ preventScroll: true });
  }

  // 색은 만들 때 한 번 정해 둔다(인덱스로 계산하면 목록이 줄어들 때 색이 바뀐다).
  const colorSeq = { collected: 0, other: 0 };
  const pickColor = (kind) => (kind === 'planned' ? '#e37722' : kind === 'gpx' ? '#d1495b'
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
        r.kind === 'planned' ? el('span', { class: 'route-tag' }, '계획') : null,
        r.review ? el('span', { class: 'route-tag' }, '검토 필요') : null,
        r.profile ? el('span', { class: 'route-meta' }, `↑${r.profile.gain_m}m · ${fmtDist(r.profile.dist_m)}`) : null);
      pick.addEventListener('click', () => selectRoute(r.rid));
      const eye = el('button', {
        class: 'route-eye' + (on ? ' on' : ''), type: 'button',
        'aria-pressed': on ? 'true' : 'false',
        title: on ? '선택 해제 · 지도에서 흐리게 표시' : '경로 선택 · 지도에서 강조',
      }, on ? '선택됨' : '흐리게');
      eye.addEventListener('click', () => toggleShown(r.rid));
      routeList.append(el('div', { class: 'route-item' + (r.rid === activeId ? ' active' : '') }, pick, eye));
    }
  }

  function drawShownRoutes({ refit = false } = {}) {
    if (disposed || !view) return;
    for (const tokens of layersById.values()) view.removeLayer(tokens);
    layersById.clear();
    const all = [];
    // Draw dim routes first so selected routes remain clear at intersections.
    for (const r of [...routes].sort((a, b) => Number(shown.has(a.rid)) - Number(shown.has(b.rid)))) {
      const rid = r.rid, selected = shown.has(rid);
      if (!r?.latlngs?.length) continue;
      // 겹쳐 그리므로 여기서는 화면을 맞추지 않는다(아래에서 전체 기준으로 한 번만).
      const layers = [...drawTrack(view, r.track || { latlngs: r.latlngs }, r.color, { fit: false, endpoints: selected && (r.kind !== 'osm' || rid === activeId), weight: selected ? (r.kind === 'planned' ? 6 : 4) : 2.5, opacity: selected ? 0.85 : 0.25 })];
      // 지점 이름 라벨은 지금 보고 있는 경로에만 — 여러 개를 켜면 라벨이 지도를 덮는다.
      if (selected && rid === activeId) {
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
    planner.refresh(routes.filter(r => shown.has(r.rid)));
    planner.redraw();
    paintMapChoices();
  }

  // 전체 스위치와 개별 토글의 상태가 어긋나지 않게 맞춘다(프로그램적 변경은 change를 쏘지 않는다).
  const syncMasterSwitch = () => {
    showOnMapChk.checked = shown.size > 0;
    showOnMapChk.indeterminate = shown.size > 0 && shown.size < routes.length;
  };

  function toggleShown(rid, { focus = false } = {}) {
    if (shown.has(rid)) shown.delete(rid); else shown.add(rid);
    syncMasterSwitch();
    if (!shown.has(rid) && activeId === rid) { activeId = null; setNavTrack(null); }
    if (focus && shown.has(rid)) selectRoute(rid, { show: false });
    else { renderRouteList(); drawShownRoutes(); }
  }

  function showProfile(r) {
    clear(elevChartBox);
    if (r?.profile) elevChartBox.append(elevationChart(r.profile), profileStats(r.profile));
    else elevChartBox.append(el('div', { class: 'conf-note' }, r?.track?.segments?.length > 1
      ? '여러 조각으로 나뉜 GPX입니다. 연결된 구간으로 산행 계획을 만들면 해당 구간의 고도를 확인할 수 있습니다.'
      : '이 등산로의 고도 데이터를 만들 수 없습니다.'));
  }

  function selectRoute(rid, { show = true } = {}) {
    const r = byRid.get(rid);
    if (!r) return;
    activeId = rid;
    if (show) { shown.add(rid); syncMasterSwitch(); }
    renderRouteList();
    showProfile(r);
    drawShownRoutes({ refit: show });
    setNavTrack(r.track?.segments?.length > 1 ? null : r.track || null);
    if (!r.profile && !r.profileLoading && !(r.track?.segments?.length > 1)) {
      r.profileLoading = true;
      const sampled = resample(r.latlngs, 80);
      fetchElevations(sampled).then(elevations => {
        if (disposed || !byRid.has(r.rid)) return;
        r.profile = buildProfile(sampled, elevations);
        if (activeId === r.rid) showProfile(r);
      }).catch(() => {}).finally(() => { r.profileLoading = false; });
    }
  }

  // 체크박스는 전체 강조/흐림 스위치. 껐다 켜면 이전 선택을 그대로 되살린다
  // (rid로 담아 두므로 그 사이 목록이 바뀌어도 엉뚱한 경로가 복원되지 않는다).
  let stashedShown = null;
  showOnMapChk.addEventListener('change', () => {
    if (showOnMapChk.checked) {
      for (const rid of stashedShown || []) if (byRid.has(rid)) shown.add(rid);
      if (!shown.size) routes.forEach(r => shown.add(r.rid));
      stashedShown = null;
    } else {
      stashedShown = [...shown];
      shown.clear();
      setNavTrack(null);
    }
    syncMasterSwitch();
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
    const finish = (profile, note) => { if (disposed) return; addRoute({ label, latlngs: track.latlngs, profile, track, kind: 'gpx' }); if (note) elevNote.textContent = note; };
    if (track.segments?.length > 1) { finish(null); return; }
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
    if (inflight) {
      const rid = await inflight;
      if (!quiet && rid != null && !disposed) { selectRoute(rid); scrollToRoutes(); }
      return rid;
    }
    const job = (async () => {
      if (!quiet) { elevNote.textContent = ''; routeLoading.hidden = false; }
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}gpx/${t.file}`, { signal: routeAbort.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const track = parseGPX(await res.text());
        if (disposed) return null;                       // 이미 다른 화면으로 떠났다
        const label = t.label || `${t.route_name || '수집 경로'}${t.variant ? ` (대안 ${t.variant})` : ''}`;
        const rid = addRoute({ label, latlngs: track.latlngs, profile: profileFromTrack(track), track, kind: 'collected', sourceFile: t.file, review: t.status === 'review' }, { quiet });
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
  // At most six requests in flight; already loaded/in-flight files are reused.
  async function loadCollectedBatch(list) {
    const results = new Array(list.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, list.length) }, async () => {
      while (next < list.length && !disposed) {
        const i = next++;
        try { results[i] = { file: list[i].file, rid: await addCollectedRoute(list[i], { quiet: true }) }; }
        catch (error) { results[i] = { file: list[i].file, error }; }
      }
    }));
    return { loadedFiles: results.filter(r => r?.rid != null).map(r => r.file), failed: results.filter(r => r?.error).length };
  }
  async function addCollectedRoutes(list) {
    routeLoading.hidden = false;
    try {
      const result = await loadCollectedBatch(list); if (disposed) return result;
      syncMasterSwitch(); renderRouteList(); drawShownRoutes({ refit: true });
      elevNote.textContent = `${result.loadedFiles.length}개 수록 경로를 함께 표시했습니다.${result.failed ? ` ${result.failed}개는 실패했습니다. 다시 시도하세요.` : ''} 실측 기록이 아닌 OSM 경로 자료입니다.`;
      return result;
    } finally { routeLoading.hidden = true; }
  }

  let osmLoaded = false, osmLoading = null, planningLoading = null;
  async function loadOSMRoutes(points = []) {
    if (osmLoaded) { routes.filter(r => r.kind === 'osm').forEach(r => shown.add(r.rid)); return; }
    if (osmLoading) return osmLoading;
    osmLoading = (async () => {
      const result = await fetchMountainTrailNetwork(m, points, { signal: routeAbort.signal });
      if (disposed) return;
      if (!result.ways.length) throw new Error('조회 범위에서 OSM 등산로를 찾지 못했습니다.');
      for (const way of result.ways) {
        const rid = addRoute({ ...way, profile: null, track: null, kind: 'osm' }, { quiet: true });
        shown.add(rid);
      }
      osmLoaded = true;
    })().finally(() => { osmLoading = null; });
    return osmLoading;
  }
  async function loadPlanningRoutes() {
    if (planningLoading) return planningLoading;
    planningLoading = (async () => {
      let payloads = [], catalogError = null;
      try { payloads = routePayloads(await routeEntryFor(m.id)); } catch (err) { catalogError = err; }
      const points = routes.flatMap(r => [r.latlngs?.[0], r.latlngs?.at(-1)]).filter(Boolean);
      // Publish each source batch as it arrives so a slow Overpass mirror never
      // blocks planning with GPX. Fit once, without moving an ongoing edit.
      const publish = result => {
        if (!disposed) { syncMasterSwitch(); renderRouteList(); drawShownRoutes(); }
        return result;
      };
      const [stored, osm] = await Promise.allSettled([loadCollectedBatch(payloads).then(publish), loadOSMRoutes(points).then(publish)]);
      if (disposed) return { failed: true, message: '' };
      syncMasterSwitch(); renderRouteList(); drawShownRoutes({ refit: !planner.editing });
      const failures = [catalogError?.message,
        stored.status === 'rejected' ? stored.reason.message : stored.value.failed ? `수록 GPX ${stored.value.failed}개 불러오기 실패` : null,
        osm.status === 'rejected' ? `주변 등산로: ${osm.reason.message}` : null].filter(Boolean);
      const counts = `${routes.filter(r => r.kind === 'collected').length}개 수록 경로 · ${routes.filter(r => r.kind === 'osm').length}개 OSM 등산로`;
      return { failed: failures.length > 0, message: `${counts}를 함께 표시했습니다.${failures.length ? ` ${failures.join(' / ')} 다시 눌러 재시도할 수 있습니다.` : ''} OSM 조회는 정상과 35km 이내 들머리를 포함한 주변 범위입니다.` };
    })().finally(() => { planningLoading = null; });
    return planningLoading;
  }

  // 주요 등산로 코스 → 교차검증된 들머리에서 정상까지 실제 경로 + 고도로 연결
  const scrollToRoutes = () => { const disclosure = routeList.closest('details'); if (disclosure) disclosure.open = true; routeList.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
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
        addRoute({ label: `${t.name} (직선참고)`, courseName: t.name, latlngs: [a, b], profile: prof, track: null, kind: 'course', planningEligible: false, trailheadName: thName, peaks });
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
    const original = loadTrailsBtn.textContent;
    setBtnLoading(loadTrailsBtn, true, '모든 등산로 불러오는 중…'); routeLoading.hidden = false;
    try {
      await loadOSMRoutes(routes.flatMap(r => [r.latlngs?.[0], r.latlngs?.at(-1)]).filter(Boolean));
      if (disposed) return;
      syncMasterSwitch(); renderRouteList(); drawShownRoutes({ refit: true });
      elevNote.textContent = `범위 내 OSM 등산로 ${routes.filter(r => r.kind === 'osm').length}개를 모두 표시했습니다. 고도는 경로를 선택할 때 조회합니다.`;
    } catch (err) { if (!disposed) elevNote.textContent = '불러오기 실패: ' + err.message; }
    finally { routeLoading.hidden = true; setBtnLoading(loadTrailsBtn, false, null, original); }
  });
  renderRouteList();

  let view, controls, offRouteClick, navTrack = null, locLayer = null;
  let stopWatch = null, locateOn = false, following = false, firstFix = false, lastPos = null;

  // ---- trails (난이도·시간: 웹 조사 + 복수 자료 교차검증) ----
  if (m.trails?.length) {
    const VBADGE = { verified: ['교차검증 일치', 'v-ok'], mixed: ['난이도 이견', 'v-mixed'], single: ['단일 확인', 'v-single'] };
    const grid = el('div', { class: 'trail-grid' });
    m.trails.forEach((t, index) => {
      const vb = t.verify && VBADGE[t.verify.level];
      const directions = courseDirections(m, t);
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
      grid.append(el('div', { class: 'trail-card', dataset: { trailIndex: index }, tabindex: '-1' },
        el('div', { class: 't-name' }, t.name || '주요 코스', routeBtn), facts,
        t.note ? el('div', { class: 't-note' }, t.note) : null, directions));
    });
    page.insertBefore(el('div', { class: 'section course-section' },
      el('h3', {}, '주요 등산로'), grid,
      el('p', { class: 'conf-note' }, '난이도·등반시간은 자료 간 차이가 있을 수 있습니다. “지도·고도”에서 코스 경로와 고도를 확인하세요.')),
      contents.nextSibling);
  }

  if (m.famous_courses?.length) {
    const onInfo = index => {
      const card = page.querySelector(`[data-trail-index="${index}"]`);
      card?.focus({ preventScroll: true });
      card?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
    };
    page.insertBefore(el('section', { class: 'section famous-section' },
      el('h3', {}, '대표·유명 코스'),
      el('p', { class: 'conf-note' }, '정상 접근·능선 종주·경관 탐방을 대표하는 코스를 따로 모았습니다. 공식 안내 확인과 기존 자료 선정을 구분하며, 인기 순위는 아닙니다.'),
      el('ol', { class: 'famous-course-list' }, ...m.famous_courses.map(c => famousCourseRow(m, c, { detail: true, onInfo }))),
      el('a', { class: 'course-mountain-link', href: '#/courses' }, '전체 산별 대표 코스 모음 →')),
    contents.nextSibling);
  }

  function setNavTrack(track) {
    if (!track && following) toggleFollow();
    navTrack = track; followBtn.disabled = !track;
  }

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

  // ---- transport ----
  if (m.transport)
    page.insertBefore(el('div', { class: 'section transport-section' }, el('h3', {}, '교통 · 주차 · 대중교통'), el('p', { class: 'prose' }, m.transport)), page.querySelector('.course-section')?.nextSibling || contents.nextSibling);

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

  const folded = ['월간산 선정기준', '등산로별 고도', '코스별 경로 GPX', '탐방 후기', '출처'];
  page.querySelectorAll('.section').forEach(section => {
    const heading = section.querySelector('h3');
    if (!heading || !folded.some(prefix => heading.textContent.startsWith(prefix))) return;
    const summary = el('summary', {}, heading);
    const body = el('div', { class: 'disclosure-body' }, ...section.childNodes);
    section.append(el('details', { class: 'info-disclosure' }, summary, body));
  });
  page.querySelectorAll('.section').forEach((section, i) => {
    const title = section.querySelector('h3');
    if (!title) return;
    section.id = `mountain-section-${i}`;
    contents.append(el('button', { type: 'button', onClick: () => { const disclosure = section.querySelector('details'); if (disclosure) disclosure.open = true; section.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); } }, title.childNodes[0].textContent.trim()));
  });

  async function initializeMap() {
    if (m.lat != null) {
      view = await createMapView(mapNode, { center: [m.lat, m.lon], zoom: 13 });
      if (disposed || !page.isConnected) { view.destroy(); return; }
      if (view.ready === false) return;
      [fileBtn, locateBtn, dirBtn].forEach(b => { b.disabled = false; });
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
      planner.attach(view);
      offRouteClick = view.onClick(point => {
        if (disposed || planner.picking) { routeMapPicker.hidden = true; return; }
        const hits = nearbyRoutes(view, routes, point);
        mapChoiceIds = hits.map(r => r.rid);
        routeMapPicker.hidden = hits.length === 0;
        if (hits.length === 1) toggleShown(hits[0].rid, { focus: true });
        else paintMapChoices();
        if (hits.length) routeMapChoices.querySelector('button')?.focus({ preventScroll: true });
      });
      drawShownRoutes();
      if (m.coord_confidence && m.coord_confidence !== 'high')
        gpxNote.textContent = `※ 정상 좌표는 근사값일 수 있습니다 (신뢰도: ${m.coord_confidence}).`;

      // Choose a course destination; never send driving directions to the summit.
      (m.trails || []).forEach((t, i) => dirMenu.append(el('button', { type: 'button', onClick: () => {
        const target = page.querySelectorAll('.course-directions')[i];
        if (target) { target.open = true; target.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        dirMenu.hidden = true;
      } }, `${t.name} · ${t.start || '출발점 미확인'}`)));
      if (!m.trails?.length) dirMenu.append(el('p', {}, '확인된 코스 출발점이 없습니다.'));
      dirBtn.addEventListener('click', () => { dirMenu.hidden = !dirMenu.hidden; });

      // 수록 GPX 자동 로드 → 등산로 목록에 추가(선택 시 지도 표시)
      tryLoadCuratedGPX(m.id, gpxNote).then((res) => { if (!disposed && res) addGpxRoute(res.track, `수록 경로${res.track.name ? ': ' + res.track.name : ''}`); });

      locateBtn.addEventListener('click', toggleLocate);
      followBtn.addEventListener('click', toggleFollow);

      fileInput.addEventListener('change', async (e) => {
        const files = [...(e.target.files || [])]; if (!files.length) return;
        const parsed = await Promise.allSettled(files.map(async file => ({ file, track: parseGPX(await file.text()) })));
        if (disposed) return;
        for (const result of parsed) if (result.status === 'fulfilled') {
          const { file, track } = result.value;
          const rid = addRoute({ label: `GPX: ${track.name || file.name}`, latlngs: track.latlngs,
            profile: profileFromTrack(track), track, kind: 'gpx' }, { quiet: true }); shown.add(rid);
        }
        syncMasterSwitch(); renderRouteList(); drawShownRoutes({ refit: true });
        const failed = parsed.filter(r => r.status === 'rejected').length;
        gpxNote.textContent = `${files.length - failed}개 GPX를 함께 표시했습니다.${failed ? ` ${failed}개는 GPX 형식 오류로 제외했습니다.` : ''}`;
        fileInput.value = '';
      });
    } else {
      mapWrap.replaceWith(el('div', { class: 'empty' }, '정상 좌표 정보를 준비 중입니다.'));
    }
  }

  const off = onChange(paintHike);
  const onTheme = () => view && view.refreshTheme();
  window.addEventListener('kr100:theme', onTheme);
  window.scrollTo(0, 0);
  const selectedCourse = new URLSearchParams(location.hash.split('?')[1] || '').get('course');
  const selectedRow = [...page.querySelectorAll('.famous-course')].find(n => n.dataset.courseId === selectedCourse);
  if (selectedRow) requestAnimationFrame(() => {
    if (disposed) return;
    selectedRow.classList.add('selected-course');
    selectedRow.focus({ preventScroll: true });
    selectedRow.scrollIntoView({ block: 'center' });
  });
  initializeMap().catch(err => { if (!disposed) gpxNote.textContent = '지도를 불러오지 못했습니다. 코스 안내를 이용해 주세요.'; console.error(err); });
  const cleanup = () => {
    // 늦게 도착하는 fetch가 파괴된 지도를 건드리지 않도록 표식을 먼저 세우고 참조를 끊는다.
    disposed = true;
    routeAbort.abort(); planner.destroy();
    offRouteClick?.();
    if (stopWatch) stopWatch();
    off();
    window.removeEventListener('kr100:theme', onTheme);
    controls?.cleanup?.();
    layersById.clear();
    view?.destroy();
    view = null;
  };
  cleanup.origin = returnTo;
  return cleanup;
}

function factSpan(label, val) {
  return el('span', {}, `${label} `, el('b', {}, val));
}


function listPill(k, m) {
  if (k === 'hansanha' && m.hansanha_rank) {
    return el('span', { class: 'pill p-hansanha ranked', title: '한국의 산하(koreasanha.net) 인기명산 100 접속순위' },
      '한국의산하 인기명산 (2003–2004년 집계)', el('b', { class: 'pill-rank' }, ` ${m.hansanha_rank}위`));
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

// Coordinates describe a trail entrance, not a verified car park or bus stop.
function courseDirections(m, t) {
  const confirmed = Array.isArray(t.trailhead) && t.trailhead_conf === 'high';
  const name = `${m.name_full} ${t.start || t.name}`;
  const label = t.start || '출발점';
  const details = el('details', { class: 'course-directions' }, el('summary', {}, `${label}로 길찾기`));
  if (confirmed) {
    const links = directionsLinks(name, ...t.trailhead);
    details.append(el('p', { class: 'conf-note' }, `목적지: ${label} (들머리). 주차장·정류장 좌표와는 다를 수 있습니다.`),
      el('div', { class: 'direction-links' },
        el('a', { class: 'btn', href: links.kakao, target: '_blank', rel: 'noopener' }, '카카오맵에서 보기'),
        el('a', { class: 'btn', href: links.google, target: '_blank', rel: 'noopener' }, '자동차 경로 검색'),
        el('a', { class: 'btn', href: links.google.replace('travelmode=driving', 'travelmode=transit'), target: '_blank', rel: 'noopener' }, '대중교통 경로 검색')));
  } else {
    details.append(el('p', { class: 'conf-note' }, '정확한 출발점 좌표가 확인되지 않았습니다. 장소 검색 결과에서 입구를 확인해 주세요.'),
      el('a', { class: 'btn', href: `https://map.kakao.com/link/search/${encodeURIComponent(name)}`, target: '_blank', rel: 'noopener' }, `${label} 장소 검색`));
  }
  details.append(el('p', { class: 'conf-note' }, '주차: 전용 주차장 위치·운영 정보 미확인. 대중교통: 도착 정류장·운행 시간은 경로 검색 결과에서 확인하세요.'));
  return details;
}
