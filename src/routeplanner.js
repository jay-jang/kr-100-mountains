import { el, clear } from './dom.js';
import { buildTrailNetwork, snapToTrail, planTrailRoute, plannedRouteGPX } from './trailnetwork.js';
import { buildProfile, elevationChart, profileStats, fetchElevations, resample } from './elevation.js';

export function routePlanner(mountain, { loadAll, onPlan, showRoutes, showMap }) {
  const storageKey = `kr100:plan:${mountain.id}`;
  let waypoints = [], network = buildTrailNetwork([]), routes = [], view = null, offClick = null;
  let plan = null, picking = false, disposed = false, generation = 0, layers = [], loading = false;
  let saved = false;
  let signature = '';
  let registeredPlan = '';
  try {
    const value = JSON.parse(localStorage.getItem(storageKey));
    if (value?.version === 1 && Array.isArray(value.waypoints)) {
      waypoints = value.waypoints.filter(p => Array.isArray(p.point) && p.point.length === 2 && p.point.every(Number.isFinite) && Math.abs(p.point[0]) <= 90 && Math.abs(p.point[1]) <= 180)
        .map(p => ({ point: p.point, label: String(p.label || '저장한 지점') }));
      saved = waypoints.length > 0;
    }
  } catch {}

  const count = el('p', { class: 'planner-count', role: 'status' }, '경로를 함께 불러오면 계획을 시작할 수 있습니다.');
  const status = el('p', { class: 'planner-status', role: 'status', 'aria-live': 'polite' });
  const loadBtn = el('button', { class: 'btn primary', type: 'button', disabled: true, onClick: load }, '경로 모두 불러오기');
  const pickBtn = el('button', { class: 'btn', type: 'button', disabled: true, 'aria-pressed': 'false', onClick: () => {
    picking = !picking; paintPicking();
    if (picking) {
      status.textContent = '지도에서 표시된 길을 차례로 누르세요. 첫 지점은 출발, 마지막 지점은 도착입니다.';
      showMap?.();
    }
  } }, '지도에서 지점 추가');
  const choose = el('select', { 'aria-label': '경로 위 지점 선택', disabled: true });
  const addBtn = el('button', { class: 'btn', disabled: true, type: 'button', onClick: () => {
    const option = choose.selectedOptions[0];
    if (!option?.dataset.point) return;
    addPoint(JSON.parse(option.dataset.point), option.textContent);
  } }, '지점 추가');
  choose.addEventListener('change', () => { addBtn.disabled = !choose.value; });
  const waypointList = el('ol', { class: 'planner-waypoints', 'aria-label': '산행 지점 순서' });
  const summary = el('div', { class: 'planner-summary' });
  const chart = el('div', { class: 'planner-chart' });
  const download = el('button', { class: 'btn primary', disabled: true, type: 'button', onClick: () => {
    if (!plan) return;
    const blob = new Blob([plannedRouteGPX(plan, `${mountain.name_full} · 나의 산행 계획`)], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob), link = el('a', { href: url, download: `${mountain.id}-plan.gpx` });
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } }, '계획 GPX 내려받기');
  const useBtn = el('button', { class: 'btn', type: 'button', disabled: true, onClick: () => {
    if (!plan) return;
    registeredPlan = JSON.stringify(plan.latlngs);
    onPlan(plan); status.textContent = '계획 경로를 등산로 목록에 추가했습니다. 지도에서 경로를 비교할 수 있습니다.';
  } }, '등산로 목록에 추가');
  const reverseBtn = el('button', { class: 'btn', type: 'button', disabled: true, onClick: () => { waypoints.reverse(); changed(); } }, '진행 방향 뒤집기');
  const returnBtn = el('button', { class: 'btn', type: 'button', disabled: true, onClick: () => {
    const first = waypoints[0]; if (!first) return;
    addPoint(first.point, first.label);
  } }, '출발점으로 돌아오기');
  const clearBtn = el('button', { class: 'btn', type: 'button', disabled: true, onClick: () => { waypoints = []; changed(); } }, '계획 초기화');
  const mapStatus = el('span', { role: 'status' });
  const undoBtn = el('button', { class: 'btn', type: 'button', disabled: true, onClick: () => { waypoints.pop(); changed(); } }, '마지막 지점 취소');
  const mapTools = el('div', { class: 'planner-map-tools', hidden: true }, mapStatus, undoBtn,
    el('button', { class: 'btn primary', type: 'button', onClick: () => {
      picking = false; paintPicking(); root.scrollIntoView({ block: 'start', behavior: 'instant' }); download.focus({ preventScroll: true });
    } }, '지점 선택 완료'));
  const root = el('section', { class: 'route-planner', 'aria-label': '새 등산 경로 계획' },
    el('div', { class: 'planner-head' }, el('h4', {}, '새 등산 경로 계획'), loadBtn),
    el('p', { class: 'conf-note' }, '수록 GPX와 주변 등산로를 한꺼번에 열고, 서로 연결되는 길을 조합하세요. 표시한 경로를 따라 지점 사이의 최단 거리를 계산합니다.'),
    count, el('button', { class: 'btn', type: 'button', onClick: () => showRoutes?.() }, '경로 표시 선택'),
    el('div', { class: 'planner-point-tools' }, pickBtn,
      el('label', {}, '또는 경로의 시작·끝 지점 선택', choose), addBtn),
    waypointList, el('div', { class: 'planner-actions' }, reverseBtn, returnBtn, clearBtn), status, summary,
    chart, el('div', { class: 'planner-actions' }, download, useBtn),
    el('p', { class: 'conf-note' }, '연결되지 않는 구간은 계획으로 만들지 않습니다. 계획 경로는 실측 기록이 아니며, 현장 통제·출입 제한은 산행 전 공식 안내에서 확인하세요.'));

  function paintPicking() {
    pickBtn.setAttribute('aria-pressed', String(picking));
    pickBtn.textContent = picking ? '지도 지점 추가 중 · 완료' : '지도에서 지점 추가';
    mapTools.hidden = !picking;
    mapStatus.textContent = status.textContent || '길 위에서 출발·경유·도착 지점을 누르세요.';
    undoBtn.disabled = !waypoints.length;
  }
  const statusObserver = new MutationObserver(() => { if (picking) mapStatus.textContent = status.textContent; });
  statusObserver.observe(status, { childList: true });
  function save() {
    try {
      if (waypoints.length) localStorage.setItem(storageKey, JSON.stringify({ version: 1, waypoints }));
      else localStorage.removeItem(storageKey);
    } catch { status.textContent = '이 브라우저에서는 계획을 저장하지 못했습니다. GPX로 내려받아 보관하세요.'; }
  }
  function removeLayers() {
    if (view) view.removeLayer(layers); layers = [];
  }
  function draw() {
    removeLayers();
    if (!view || view.ready === false) return;
    // Once added to the route list, that route's selected/dim style owns the line.
    if (plan && JSON.stringify(plan.latlngs) !== registeredPlan) layers.push(view.addPolyline(plan.latlngs, { color: '#e37722', weight: 7, opacity: 1, outline: true }));
    waypoints.forEach((waypoint, i) => {
      const p = plan?.snaps[i]?.point || waypoint.point;
      const label = i === 0 ? '출발' : i === waypoints.length - 1 ? '도착' : `경유 ${i}`;
      layers.push(view.addDot({ lat: p[0], lng: p[1], color: '#e37722', title: `${i + 1}. ${label}` }),
        view.addLabel({ lat: p[0], lng: p[1], text: `${i + 1}. ${label}`, kind: 'planned-point' }));
    });
  }
  function paintWaypoints() {
    clear(waypointList);
    waypoints.forEach((waypoint, i) => {
      const label = i === 0 ? '출발' : i === waypoints.length - 1 ? '도착' : `경유 ${i}`;
      const move = delta => {
        [waypoints[i], waypoints[i + delta]] = [waypoints[i + delta], waypoints[i]];
        changed(); waypointList.children[i + delta]?.querySelector('button')?.focus();
      };
      waypointList.append(el('li', {}, el('div', {}, el('strong', {}, label), el('span', {}, waypoint.label),
        el('small', {}, waypoint.point.map(n => n.toFixed(5)).join(', '))),
        el('div', { class: 'planner-row-actions' },
          el('button', { class: 'btn', type: 'button', disabled: i === 0, 'aria-label': `${i + 1}번 지점 앞으로`, onClick: () => move(-1) }, '↑'),
          el('button', { class: 'btn', type: 'button', disabled: i === waypoints.length - 1, 'aria-label': `${i + 1}번 지점 뒤로`, onClick: () => move(1) }, '↓'),
          el('button', { class: 'btn', type: 'button', 'aria-label': `${i + 1}번 지점 삭제`, onClick: () => {
            waypoints.splice(i, 1); changed(); (waypointList.children[Math.min(i, waypoints.length - 1)]?.querySelector('button') || choose).focus();
          } }, '삭제'))));
    });
    clearBtn.disabled = !waypoints.length; reverseBtn.disabled = waypoints.length < 2;
    returnBtn.disabled = waypoints.length < 2;
  }
  function calculate() {
    const version = ++generation;
    plan = null; download.disabled = useBtn.disabled = true; clear(summary); clear(chart); draw();
    if (waypoints.length < 2) { status.textContent = waypoints.length ? '도착 지점을 추가하세요. 경유 지점도 순서대로 넣을 수 있습니다.' : ''; return; }
    if (!network.edges.length) { status.textContent = '저장된 지점이 있습니다. 경로를 불러오면 계획을 다시 계산합니다.'; return; }
    try {
      plan = planTrailRoute(network, waypoints);
      download.disabled = useBtn.disabled = false;
      status.textContent = `${plan.legs.length}개 구간을 연결했습니다. 주황색 선이 새 계획 경로입니다.`;
      summary.append(el('strong', {}, `총 ${(plan.distance_m / 1000).toFixed(2)}km`),
        el('p', {}, `사용 경로: ${plan.sourceNames.join(' · ')}`),
        el('p', { class: 'conf-note' }, `구간별 거리: ${plan.legs.map((leg, i) => `${i + 1}구간 ${(leg.distance_m / 1000).toFixed(2)}km`).join(' · ')}`));
      const maxSnap = Math.max(...plan.snaps.map(p => p.distance_m));
      if (maxSnap > 1) summary.append(el('p', { class: 'conf-note' }, `선택 지점을 표시된 경로 위로 맞췄습니다 (최대 ${Math.round(maxSnap)}m).`));
      draw();
      const direct = plan.points.every(p => Number.isFinite(p.ele)) ? buildProfile(plan.latlngs, plan.points.map(p => p.ele)) : null;
      const show = profile => {
        if (disposed || version !== generation || !profile) return;
        clear(chart).append(elevationChart(profile), profileStats(profile), el('p', { class: 'conf-note' }, '고도·누적 상승은 경로 자료 또는 지형 고도 기준의 추정값입니다.'));
      };
      if (direct) show(direct);
      else {
        chart.append(el('p', { class: 'conf-note' }, '계획 경로의 고도를 확인하는 중…'));
        const sampled = resample(plan.latlngs, 80);
        fetchElevations(sampled).then(elevations => show(buildProfile(sampled, elevations))).catch(() => {
          if (!disposed && version === generation) clear(chart).append(el('p', { class: 'conf-note' }, '고도를 확인하지 못했습니다. 경로 계획과 GPX 저장은 사용할 수 있습니다.'));
        });
      }
    } catch (err) { status.textContent = err.message; draw(); }
  }
  function changed() { paintWaypoints(); calculate(); paintPicking(); save(); }
  function addPoint(point, label) {
    try {
      const snap = snapToTrail(network, point);
      const previous = waypoints[waypoints.length - 1];
      if (previous && Math.abs(previous.point[0] - snap.point[0]) < 1e-7 && Math.abs(previous.point[1] - snap.point[1]) < 1e-7)
        throw new Error('마지막 지점과 다른 위치를 선택하세요.');
      waypoints.push({ point: snap.point, label: label || `${network.names.get([...snap.edge.sources][0])} 위 지점` }); changed();
    } catch (err) { status.textContent = err.message; }
  }
  async function load() {
    if (loading || disposed) return;
    loading = true; loadBtn.disabled = true; loadBtn.textContent = '모든 경로 불러오는 중…';
    status.textContent = '수록 GPX와 주변 등산로를 함께 확인하고 있습니다.';
    try {
      const result = await loadAll(); if (disposed) return;
      status.textContent = result.message;
      loadBtn.textContent = result.failed ? '누락된 경로 다시 불러오기' : '모든 경로 다시 보기';
    } catch (err) { if (!disposed) { status.textContent = err.message; loadBtn.textContent = '경로 다시 불러오기'; } }
    finally { loading = false; if (!disposed) loadBtn.disabled = !view || view.ready === false; }
  }
  function refresh(nextRoutes) {
    if (disposed) return;
    routes = nextRoutes.filter(r => r.planningEligible !== false);
    const nextSignature = routes.map(r => r.rid).join(',');
    if (signature === nextSignature) return;
    signature = nextSignature;
    network = buildTrailNetwork(routes);
    count.textContent = `${routes.length}개 경로 · ${network.edges.length.toLocaleString('ko')}개 연결 구간을 계획에 사용합니다. 선택을 해제한 흐린 경로는 계획에서 제외됩니다.`;
    const previous = choose.value; clear(choose).append(el('option', { value: '' }, '추가할 지점을 선택하세요'));
    const addOption = (id, label, point) => choose.append(el('option', { value: id, dataset: { point: JSON.stringify(point) } }, label));
    if (mountain.lat != null) addOption('summit', `${mountain.name} 정상 부근`, [mountain.lat, mountain.lon]);
    for (const route of routes) {
      const segments = route.track?.segments?.map(s => s.map(p => [p.lat, p.lon])) || route.segments || [route.latlngs];
      segments.forEach((line, i) => { if (line?.length > 1) {
        addOption(`${route.rid}:${i}:start`, `${route.label} · 시작 지점${segments.length > 1 ? ` (${i + 1})` : ''}`, line[0].slice(0, 2));
        addOption(`${route.rid}:${i}:end`, `${route.label} · 끝 지점${segments.length > 1 ? ` (${i + 1})` : ''}`, line[line.length - 1].slice(0, 2));
      } });
    }
    if ([...choose.options].some(o => o.value === previous)) choose.value = previous;
    pickBtn.disabled = choose.disabled = !network.edges.length;
    addBtn.disabled = !network.edges.length || !choose.value;
    if (!network.edges.length) { picking = false; paintPicking(); }
    paintWaypoints(); calculate();
  }
  paintWaypoints();
  if (saved) status.textContent = '이 산에 저장한 계획이 있습니다. 경로를 불러와 이어서 편집하세요.';
  return { root, mapTools, refresh, get picking() { return picking; }, get editing() { return picking || waypoints.length > 0; },
    attach(map) {
      view = map; loadBtn.disabled = map.ready === false;
      offClick = map.onClick(point => { if (picking) addPoint(point); }); draw();
      if (saved && map.ready !== false) load();
    },
    redraw: draw,
    destroy() { disposed = true; generation++; statusObserver.disconnect(); offClick?.(); removeLayers(); },
  };
}
