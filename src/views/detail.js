import { loadData, DIFF_CLASS, regionColor, LIST_KEYS, LIST_META } from '../data.js';
import { createMapView, fetchTrails } from '../map.js';
import { mapControls } from '../mapcontrols.js';
import { isHiked, toggleHiked, onChange, recordView } from '../store.js';
import { parseGPX, drawTrack, elevationSVG, navInfo } from '../gpx.js';
import { watchPosition, fmtDist, directionsLinks } from '../geo.js';
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
  const trailBtn = el('button', { type: 'button' }, '🥾 등산로 표시');
  const fileInput = el('input', { type: 'file', accept: '.gpx', style: 'display:none' });
  const fileBtn = el('button', { type: 'button', onClick: () => fileInput.click() }, '📈 GPX 불러오기');
  const locateBtn = el('button', { type: 'button', title: '내 위치 실시간 표시' }, '📍 내 위치');
  const dirBtn = el('button', { type: 'button', title: '외부 지도 길찾기' }, '🧭 길찾기');
  const followBtn = el('button', { type: 'button', disabled: true, title: 'GPX 경로를 따라 실시간 안내' }, '➡️ 경로 따라가기');
  const dirMenu = el('div', { class: 'dir-menu', hidden: true });
  const tools = el('div', { class: 'map-tools' }, locateBtn, dirBtn, trailBtn, fileBtn, followBtn, fileInput);
  const navPanel = el('div', { class: 'nav-panel', hidden: true });
  const mapWrap = el('div', { class: 'detail-map-wrap' }, mapNode, tools, dirMenu);
  const elevBox = el('div', { class: 'elev-profile' });
  const gpxNote = el('div', { class: 'conf-note' });
  page.append(el('div', { class: 'section' }, el('h3', {}, '위치 · 경로 · 내비게이션'), mapWrap, navPanel, elevBox, gpxNote));

  let view, controls, trailLayer = null, gpxLayer = null, navTrack = null, locLayer = null;
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

    // 수록 GPX 자동 로드
    tryLoadCuratedGPX(m.id, view, elevBox, gpxNote).then((res) => { if (res) { gpxLayer = res.token; setNavTrack(res.track); } });

    locateBtn.addEventListener('click', toggleLocate);
    followBtn.addEventListener('click', toggleFollow);

    trailBtn.addEventListener('click', async () => {
      if (trailLayer) { view.removeLayer(trailLayer); trailLayer = null; trailBtn.textContent = '🥾 등산로 표시'; return; }
      trailBtn.textContent = '불러오는 중…'; trailBtn.disabled = true;
      try {
        const lines = await fetchTrails(m.lat, m.lon);
        trailLayer = view.addPolylines(lines, { color: '#e2872a', weight: 2.2, opacity: 0.8 });
        trailBtn.textContent = `🥾 등산로 숨기기 (${lines.length})`;
      } catch (e) { trailBtn.textContent = '실패 — 다시'; }
      finally { trailBtn.disabled = false; }
    });

    fileInput.addEventListener('change', async (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      try {
        const track = parseGPX(await f.text());
        if (gpxLayer) view.removeLayer(gpxLayer);
        gpxLayer = drawTrack(view, track, '#d1495b');
        elevBox.innerHTML = elevationSVG(track);
        gpxNote.textContent = `${track.name || f.name} · 거리 ${track.distance_km}km` +
          (track.gain_m ? ` · 누적 상승 ${track.gain_m}m` : '');
        setNavTrack(track);
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
      grid.append(el('div', { class: 'trail-card' },
        el('div', { class: 't-name' }, t.name || '주요 코스'), facts,
        t.note ? el('div', { class: 't-note' }, t.note) : null));
    });
    page.append(el('div', { class: 'section' },
      el('h3', {}, '주요 등산로'),
      el('p', { class: 'conf-note', style: 'margin:-4px 0 12px' }, '난이도·등반시간은 웹 조사와 복수의 독립 자료를 교차검증한 값입니다.'),
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

async function tryLoadCuratedGPX(id, view, elevBox, note) {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}gpx/${id}.gpx`);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (ct.includes('html') || text.trimStart().startsWith('<!')) return null; // dev server 200-fallback
    const track = parseGPX(text);
    const token = drawTrack(view, track, '#d1495b');
    elevBox.innerHTML = elevationSVG(track);
    note.textContent = `수록 경로: ${track.name || id} · 거리 ${track.distance_km}km` +
      (track.gain_m ? ` · 누적 상승 ${track.gain_m}m` : '');
    return { token, track };
  } catch { return null; }
}
