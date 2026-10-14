// 경로 시트 #/m/<id>?route=<key> — 산 시트와 같은 컨트롤러 안에서 내용만 바꿔 끼운다.
// peek: 제목 · 핵심 수치 · 선 출처 · [들머리 길찾기] [GPX 받기]
// half: 고도 단면 · [기본|대안] · 경유·근거·출처 · 선 출처 한 줄 · (설정 ON) 따라가기 · 이 길로 계획 · 실시간 길 찾기
import { el, clear } from '../dom.js';
import { icon } from '../icons.js';
import { pref } from '../prefs.js';
import { openModal } from '../modal.js';
import { directionsLinks, fmtDist, watchPosition } from '../geo.js';
import { notePosition } from '../position.js';
import { navInfo, haversine } from '../gpx.js';
import { profileFromTrack, fetchElevations, resample, buildProfile, profileStats } from '../elevation.js';
import { routeTrailheadToSummit } from '../routing.js';
import { routePlanner } from '../routeplanner.js';
import { walkGpx } from '../walkdata.js';
import { profileChart, pointAlong } from './chart.js';
import { isLoop, trackFromLines } from './model.js';
import { fmtHours, fmtMin, fmtKm, diffMark, verifyInfo, verifyDetail, evidenceLabel, PROVENANCE, dots } from './format.js';
import { noteItem, sortNotes } from './info.js';

/** 경로 시트 머리 숫자 줄: "5km · 오름 4시간 · 왕복 8시간 · 어려움". */
function numbers(row) {
  const parts = [];
  if (fmtKm(row.distanceKm)) parts.push(el('span', { class: 'tabular' }, fmtKm(row.distanceKm)));
  if (row.ascentH) parts.push(el('span', {}, `오름 ${fmtHours(row.ascentH)}`));
  if (row.roundH) parts.push(el('span', {}, `왕복 ${fmtHours(row.roundH)}`));
  else if (row.duration && !row.ascentH) parts.push(el('span', {}, row.duration));
  if (row.walkingMin) parts.push(el('span', {}, `표지 시간 ${fmtMin(row.walkingMin)}`));
  if (row.difficulty) parts.push(diffMark(row.difficulty));
  if (!parts.length && row.course?.via?.length) parts.push(el('span', {}, `경유 ${row.course.via.length}곳`), el('span', {}, '거리·시간 자료 없음'));
  return parts;
}

/** 들머리 길찾기 — 좌표 신뢰도 high만 좌표 목적지. 정상으로 자동차 안내는 하지 않는다. */
export function openDirections(m, row) {
  const label = row.start || row.course?.via?.[0] || row.name;
  const placeName = `${m.name_full} ${label}`;
  const ext = el('span', { class: 'mt-ext', html: icon('external', { size: 16 }) });
  const link = (href, text, note) => el('a', { class: 'mt-linkrow', href, target: '_blank', rel: 'noopener' },
    el('span', {}, el('strong', {}, text), note ? el('small', {}, note) : null), ext.cloneNode(true));
  let content;
  if (row.trailhead && row.trailheadConf === 'high') {
    const [lat, lng] = row.trailhead;
    const links = directionsLinks(placeName, lat, lng);
    content = el('div', { class: 'mt-dir' },
      el('p', { class: 'mt-fine' }, `목적지: ${label}(들머리 좌표). 주차장·정류장 위치와 다를 수 있습니다.`),
      link(links.kakao, '카카오맵에서 보기', '들머리까지 길찾기'),
      link(links.google, '자동차 경로', 'Google 지도'),
      link(links.google.replace('travelmode=driving', 'travelmode=transit'), '대중교통 경로', 'Google 지도'));
  } else if (row.kind === 'osm' && row.trailhead) {
    const [lat, lng] = row.trailhead;
    content = el('div', { class: 'mt-dir' },
      el('p', { class: 'mt-fine' }, 'OpenStreetMap 노선의 시작 지점입니다. 실제 들머리·주차장과 다를 수 있어 자동차 목적지로 지정하지 않습니다.'),
      link(`https://map.kakao.com/link/map/${encodeURIComponent(row.name)},${lat},${lng}`, '카카오맵에서 위치 보기'));
  } else {
    content = el('div', { class: 'mt-dir' },
      el('p', { class: 'mt-fine' }, '들머리 좌표가 충분히 확인되지 않아 장소 검색으로 안내합니다. 검색 결과에서 입구를 확인하세요.'),
      link(`https://map.kakao.com/link/search/${encodeURIComponent(placeName)}`, `‘${placeName}’ 장소 검색`, '카카오맵'));
  }
  content.append(el('p', { class: 'mt-fine' }, '산 정상으로는 자동차 경로를 안내하지 않습니다.'));
  openModal({ title: `${label} 길찾기`, content });
}

function gpxFromTrack(track, name, desc) {
  const x = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const segs = track.segments.map((s) => `<trkseg>${s.map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}">${Number.isFinite(p.ele) ? `<ele>${p.ele}</ele>` : ''}</trkpt>`).join('')}</trkseg>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="kr-100-mountains" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${x(name)}</name><desc>${x(desc)}</desc></metadata><trk><name>${x(name)}</name>${segs}</trk></gpx>`;
}
function saveBlob(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * @param {object} env 컨트롤러가 넘기는 도구
 * @param {object} row 코스 행
 * @param {number} lineIdx 보여 줄 선(-1 = 없음)
 */
export function buildRouteSheet(env, row, lineIdx) {
  const { ctx, m } = env;
  let disposed = false;
  let chart = null;
  let follow = null;
  let planner = null;
  const line = lineIdx >= 0 ? row.lines[lineIdx] : null;
  const prov = line ? line.provenance : 'none';

  // ---------- 머리(peek) ----------
  const title = el('h2', { class: 'sheet-title rt-title', tabindex: '-1' }, row.name);
  const back = el('button', { type: 'button', class: 'rt-back', 'aria-label': `${m.name} 시트로 돌아가기`, onClick: () => env.back() },
    el('span', { class: 'rt-back-ic', html: icon('back') }), el('span', { class: 'rt-back-name' }, m.name));
  // ‹ 는 산 시트로 한 단계, [×]는 산 시트를 건너뛰고 목록으로 — 이름으로 그 차이를 밝힌다(지도 앱의 닫기 관례).
  const close = el('button', { type: 'button', class: 'icon-btn', 'aria-label': '닫고 목록으로', title: '닫고 목록으로', html: icon('close'), onClick: () => env.close() });
  const vi = verifyInfo(row.verify);
  const provLine = el('p', { class: 'rt-prov mt-dots' }, ...dots([
    // 견본 선의 색·점선은 지도에 그린 고른 선과 같은 약속(생성 방식)으로 — mountain.css .rt-prov-tag.p-*
    el('span', { class: `rt-prov-tag p-${row.kind === 'osm' && prov === 'none' ? 'osm-relation' : prov}` + (prov === 'osm-routed' || prov === 'live' ? ' dash' : prov === 'none' ? ' none' : '') }, PROVENANCE[prov].status),
    line?.review ? el('span', { class: 'mt-review' }, '검토 필요') : null,
    vi ? el('span', { class: `mt-verify ${vi.tone}`, title: vi.title }, vi.text) : null,
    row.course ? el('span', {}, evidenceLabel(row.course)) : null,
    row.kind === 'osm' ? el('span', {}, '운영 상태 미확인') : null]));

  const dirBtn = el('button', { type: 'button', class: 'btn small', onClick: () => openDirections(m, row) }, '들머리 길찾기');
  const gpxBtn = gpxButton();
  // 따라가기 수치판은 눈으로 보는 판일 뿐 라이브 영역이 아니다 — 위치가 들어올 때마다(대략 1초) 다시 그려서,
  // 라이브 영역이면 화면 낭독기가 숫자를 끝없이 읽는다. 상태가 바뀔 때만 아래 두 sr-only 영역으로 알린다.
  const navPanel = el('div', { class: 'rt-nav', hidden: true });
  const navLive = el('p', { class: 'sr-only', role: 'status' });     // 시작·25% 단위 진행·경로 복귀·신호 약함
  const navAlert = el('p', { class: 'sr-only', role: 'alert' });     // 경로 이탈만(급한 알림)
  const toolsBar = el('div', { class: 'rt-maptools' });
  const header = el('div', { class: 'rt-head' },
    el('div', { class: 'rt-top' }, back, title, close),
    row.altName ? el('p', { class: 'rt-alt' }, `대표 코스명: ${row.altName}`) : null,
    el('p', { class: 'sheet-sub rt-nums mt-dots' }, ...dots(numbers(row))),
    provLine,
    el('div', { class: 'rt-actions' }, dirBtn, gpxBtn),
    navPanel, navLive, navAlert, toolsBar);

  function gpxButton() {
    if (!line || prov === 'user-file' || prov === 'planned') return null;
    const name = `${m.name_full} ${row.name}`;
    if (line.file) {
      return el('a', { class: 'btn small', href: line.url, download: line.file.split('/').pop(), title: 'GPX 파일 받기' },
        el('span', { html: icon('download', { size: 18 }) }), 'GPX 받기');
    }
    return el('button', { type: 'button', class: 'btn small', onClick: () => {
      const track = env.selection()?.track;
      if (row.kind === 'osm') { saveBlob(walkGpx({ name: row.name, lines: row.osm.lines, partial: row.osm.partial }), `${row.osm.rid}.gpx`); return; }
      if (!track) return;
      saveBlob(gpxFromTrack(track, name, 'OpenStreetMap 등산로망 위에서 계산한 경로입니다(© OpenStreetMap contributors, ODbL). 실측 기록이 아니며 통제·출입 제한을 반영하지 않습니다.'),
        `${m.id}-${row.key.replace(/[^a-z0-9]/gi, '')}.gpx`);
    } }, el('span', { html: icon('download', { size: 18 }) }), 'GPX 받기');
  }

  // ---------- 본문(half) ----------
  const chartBox = el('div', { class: 'rt-chart' }, el('p', { class: 'mt-fine' }, line ? '고도 단면을 준비하는 중…' : '선 자료가 없어 고도 단면을 그릴 수 없습니다.'));
  const variants = row.lines.length > 1 ? el('div', { class: 'seg rt-variants', role: 'group', 'aria-label': '경로 선택' },
    ...row.lines.map((l, i) => el('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(i === lineIdx),
      title: [l.distance_km ? `${l.distance_km}km` : '', l.review ? '검토 필요' : ''].filter(Boolean).join(' · ') || null,
      onClick: () => { if (i !== lineIdx) env.setVariant(row, i); } }, l.label))) : null;

  const c = row.course;
  const kv = (k, ...v) => el('div', { class: 'rt-kv' }, el('span', { class: 'rt-k' }, k), el('span', { class: 'rt-v' }, ...v));
  const details = el('div', { class: 'rt-details' },
    c?.via?.length ? kv('경유', c.via.join(' → ')) : null,
    c ? kv('대표 코스', `${c.selection_reason || '대표 코스'} · ${evidenceLabel(c)}${c.evidence === 'official' && c.sources?.[0]?.checked_at ? ` ${c.sources[0].checked_at}` : ''}`) : null,
    c?.sources?.length ? kv('근거', ...c.sources.flatMap((s, i) => [i ? ' · ' : '', el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.title)])) : null,
    row.start && row.kind !== 'course' ? kv('들머리', row.start, row.trailheadConf === 'high' ? '' : ' (좌표 미확정)') : null,
    row.verify && verifyDetail(row.verify) ? kv('난이도 자료', verifyDetail(row.verify)) : null,
    row.trail?.duration && (row.ascentH || row.roundH) ? kv('시간 자료', row.trail.duration) : null,
    c?.highlight ? el('p', { class: 'mt-prose' }, c.highlight) : null,
    row.trail?.note ? el('p', { class: 'mt-prose' }, row.trail.note) : null);

  const provNote = el('p', { class: 'rt-provnote' }, PROVENANCE[prov].note,
    prov === 'none' && row.trailhead ? ' 들머리 위치만 지도에 표시합니다.' : '');
  const warn = line?.warnings?.length ? el('p', { class: 'mt-fine rt-warn' }, `${line.review ? '검토 필요: ' : '참고: '}${line.warnings.join(' / ')}`) : null;
  const attribution = line && (prov === 'osm-routed' || prov === 'osm-relation' || prov === 'live')
    ? el('p', { class: 'mt-fine' }, `선형 © OpenStreetMap contributors (ODbL)${prov === 'osm-routed' ? ' · 고도 SRTM 지형 추정값' : ''}`) : null;

  const notesBox = el('div', { class: 'rt-notes', hidden: true });
  const toolsBox = el('div', { class: 'rt-tools' });
  const plannerBox = el('div', { class: 'rt-planner', hidden: true });
  const toolStatus = el('p', { class: 'mt-fine', role: 'status', 'aria-live': 'polite' });
  const content = el('div', { class: 'rt-body' }, chartBox, variants, details, provNote, warn, attribution, notesBox, toolsBox, toolStatus, plannerBox);

  // 이 코스에 붙은 현장 정보(교차검증 후기)
  env.reviews.then((entry) => {
    if (disposed) return;
    const name = row.trail?.name;
    const notes = name ? (entry?.notes || []).filter((n) => n.route === name) : [];
    if (!notes.length) return;
    notesBox.append(el('h3', { class: 'mt-sec-h' }, '이 코스 현장 정보'),
      el('ul', { class: 'mt-notes' }, ...sortNotes(notes).slice(0, 3).map((n) => noteItem(n, { showRoute: false }))),
      el('button', { type: 'button', class: 'text-link', onClick: () => env.showNotes() }, `현장 정보 전체 보기 (${entry.notes.length}건)`));
    notesBox.hidden = false;
  }).catch(() => {});

  // ---------- 선 그리기 + 고도 ----------
  env.select(row, lineIdx, { fit: true }).then((track) => {
    if (disposed) return;
    if (!line) return;
    if (!track) { clear(chartBox).append(el('p', { class: 'mt-fine' }, '경로 파일을 불러오지 못했습니다. 다시 열어 보세요.')); return; }
    showProfile(track);
    paintTools();
  });

  function showProfile(track) {
    const direct = profileFromTrack(track);
    if (direct) { direct.latlngs = track.latlngs; renderChart(direct); return; }
    if (track.segments?.length > 1) { clear(chartBox).append(el('p', { class: 'mt-fine' }, '여러 조각으로 나뉜 선이라 고도 단면을 그리지 않습니다.')); return; }
    clear(chartBox).append(el('p', { class: 'mt-fine' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' 지형 고도를 조회하는 중…'));
    const sampled = resample(track.latlngs, 80);
    fetchElevations(sampled).then((eles) => {
      if (disposed) return;
      const p = buildProfile(sampled, eles);
      if (!p) throw new Error('no profile');
      p.latlngs = sampled; p.estimated = true;
      renderChart(p);
    }).catch(() => { if (!disposed) clear(chartBox).append(el('p', { class: 'mt-fine' }, '고도를 확인하지 못했습니다. 선과 GPX는 그대로 쓸 수 있습니다.')); });
  }
  function renderChart(profile) {
    chart?.destroy?.();
    let raf = 0;
    chart = profileChart(profile, { onPoint: (d) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => env.chartPoint(pointAlong(profile.latlngs, d)));
    } });
    clear(chartBox).append(el('h3', { class: 'mt-sec-h' }, '고도 단면'), chart, profileStats(profile),
      el('p', { class: 'mt-fine' }, profile.estimated ? '고도: open-meteo 지형 고도 추정값' : prov === 'recorded' || prov === 'user-file' ? '고도: GPX 파일 기록값' : '고도: SRTM 지형 추정값(실측 아님)'));
  }

  // ---------- 도구(설정 ON일 때만) ----------
  function paintTools() {
    clear(toolsBox);
    const track = env.selection()?.track;
    const btns = [];
    if (pref('followRoute') && track) {
      const fb = el('button', { type: 'button', class: 'btn', 'aria-pressed': String(!!follow) }, follow ? '안내 중지' : '따라가기');
      fb.addEventListener('click', () => { if (follow) stopFollow(); else startFollow(track); paintTools(); });
      btns.push(fb);
    }
    if (pref('routePlanner') && m.lat != null) {
      btns.push(el('button', { type: 'button', class: 'btn', 'aria-expanded': String(!plannerBox.hidden), onClick: togglePlanner }, '이 길로 계획'));
    }
    if (pref('liveTrails') && !line && row.trailhead && m.lat != null) {
      const lb = el('button', { type: 'button', class: 'btn' }, '실시간으로 길 찾기(느림)');
      lb.addEventListener('click', () => liveRoute(lb));
      btns.push(lb);
    }
    if (btns.length) toolsBox.append(el('div', { class: 'rt-toolrow' }, ...btns));
  }
  if (!line) paintTools();

  async function liveRoute(btn) {
    btn.disabled = true;
    clear(btn).append(el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' 찾는 중…');
    toolStatus.textContent = 'OpenStreetMap 등산로망에서 들머리–정상 경로를 계산합니다. 수십 초 걸릴 수 있습니다.';
    let result = null;
    try { result = await routeTrailheadToSummit(row.trailhead, [m.lat, m.lon]); } catch { result = null; }
    if (disposed) return;
    if (result?.latlngs?.length > 3) {
      env.addLiveLine(row, { track: trackFromLines([result.latlngs]), peaks: result.peaks || [] });
      return;   // 컨트롤러가 시트를 새 선으로 다시 그린다
    }
    btn.disabled = false; btn.textContent = '다시 시도';
    toolStatus.textContent = '등산로망으로 들머리와 정상을 잇지 못했습니다. 직선으로 대신 그리지 않습니다.';
  }

  // ---------- 따라가기 ----------
  function startFollow(track) {
    const loop = isLoop(track);
    const end = track.latlngs.at(-1);
    const atSummit = m.lat != null && end && haversine(end[0], end[1], m.lat, m.lon) <= 300;
    const target = loop ? '출발점' : atSummit ? '정상' : '끝점';
    navPanel.hidden = false;
    navPanel.textContent = '위치를 확인하는 중…';
    announce(`${target}까지 따라가기를 시작합니다. 위치를 확인하는 중…`);
    // 알릴 상태: 경로 이탈 여부(40m에서 켜고 30m 아래로 돌아와야 끈다 — 경계에서 깜박이지 않게), 진행 25% 단계, 신호 약함.
    let wasOff = null, step = -1, weak = false, weakSaidAt = 0;
    let layer = null;
    ctx.whenMap((view) => { if (!disposed && follow) { layer = view.locate(); ctx.layers.add(layer); } });
    const stop = watchPosition((p) => {
      if (disposed) return;
      notePosition(p);
      layer?.set(p);
      const info = navInfo(track, p);
      if (!info) return;
      const total = track._cum?.at(-1) || 0;
      const remaining = Math.max(0, total * (1 - info.progress));
      const off = info.offRoute_m;
      const isOff = wasOff ? off > 30 : off > 40;
      clear(navPanel).append(
        el('div', { class: 'rt-nav-row' },
          el('span', {}, el('b', { class: 'tabular' }, fmtDist(remaining)), `${target}까지`),
          el('span', {}, el('b', { class: 'tabular' }, `${Math.round(info.progress * 100)}%`), '진행'),
          el('span', {}, el('b', { class: 'tabular' }, p.altitude != null ? `${Math.round(p.altitude)}m` : '–'), '현재 고도')),
        el('p', { class: 'rt-nav-off' + (isOff ? ' warn' : '') },
          isOff ? `경로에서 ${fmtDist(off)} 벗어났습니다` : `경로 위(±${fmtDist(off)})`));
      weak = false;
      if (isOff !== wasOff) {
        if (isOff) navAlert.textContent = `경로에서 ${fmtDist(off)} 벗어났습니다.`;
        else if (wasOff) { navAlert.textContent = ''; announce('경로로 돌아왔습니다.'); }   // 비워 두어야 다음 이탈이 다시 읽힌다
        wasOff = isOff;
      }
      const s = Math.min(4, Math.floor(info.progress * 4));
      if (s !== step) {
        // 첫 위치에서는 지금 상태를 한 번, 그다음은 25% 단계가 바뀔 때만.
        if (step < 0 || s > step) announce(`${target}까지 ${fmtDist(remaining)}, ${s * 25}% 진행.`);
        step = s;
      }
    }, (err) => {
      if (disposed || !follow) return;
      // 권한 거부·미지원만 멈춘다. 신호가 약한 것(시간 초과·위치 없음)은 추적이 계속되므로 알리기만 한다.
      if (err?.code === 1 || err?.code === 0) {
        stopFollow();
        navPanel.hidden = false;
        navPanel.textContent = err.code === 1 ? '위치 권한이 거부되어 따라가기를 멈췄습니다.' : '이 브라우저에서는 위치를 쓸 수 없습니다.';
        announce(navPanel.textContent);
        paintTools();
        return;
      }
      // 신호가 약하다는 알림은 이탈 경고를 덮어쓰지 않는다(이탈 중이면 그 문구를 남긴다). 다음 좋은 위치까지 한 번만 알린다.
      const offLine = navPanel.querySelector('.rt-nav-off');
      if (!offLine) navPanel.textContent = '위치 신호가 약합니다. 계속 확인하는 중…';
      else if (!wasOff) { offLine.textContent = '위치 신호가 약합니다. 계속 확인하는 중…'; offLine.classList.add('warn'); }
      // 산에서는 시간 초과와 위치 수신이 번갈아 올 수 있다 — 약한 신호 안내는 20초에 한 번까지만.
      if (!weak) {
        weak = true;
        if (Date.now() - weakSaidAt > 20000) { weakSaidAt = Date.now(); announce('위치 신호가 약합니다. 계속 확인하는 중입니다.'); }
      }
    });
    follow = { stop: () => { stop(); if (layer) { ctx.layers.remove(layer); layer = null; } } };
  }
  function stopFollow() {
    follow?.stop(); follow = null;
    navPanel.hidden = true; clear(navPanel);
    navLive.textContent = ''; navAlert.textContent = '';
  }
  /** 상태 변화만 화면 낭독기에 알린다(같은 문구라도 다시 읽히게 비운 뒤 다음 프레임에 쓴다). */
  function announce(text) {
    navLive.textContent = '';
    requestAnimationFrame(() => { if (!disposed) navLive.textContent = text; });
  }

  // ---------- 경로 계획 ----------
  function togglePlanner(e) {
    const open = plannerBox.hidden;
    plannerBox.hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
    if (!open) return;
    if (!planner) {
      planner = routePlanner(m, {
        loadAll: () => env.planningRoutes().then((res) => { if (!disposed && planner) planner.refresh(res.routes); return res; }),
        onPlan: (plan) => { env.addPlan(plan); toolStatus.textContent = '계획 경로를 코스 탭 ‘내 경로’에 추가했습니다.'; },
        showRoutes: () => ctx.sheet.setDetent('half'),
        showMap: () => ctx.sheet.setDetent('peek'),
        showPlanner: () => { if (ctx.sheet.detent === 'peek' || ctx.sheet.detent === 'min') ctx.sheet.setDetent('half'); },
      });
      plannerBox.append(planner.root);
      toolsBar.append(planner.mapTools);
      const track = env.selection()?.track;
      if (track) planner.refresh([{ rid: `sel-${row.key}`, label: row.name, latlngs: track.latlngs, track }]);
      ctx.whenMap((view) => { if (!disposed && planner) planner.attach(view); });
    }
    plannerBox.scrollIntoView({ block: 'nearest' });
  }

  return {
    header, content, title,
    label: `${row.name} 경로`,
    get picking() { return !!planner?.picking; },
    repaintTools: () => { if (env.selection()?.track || !line) paintTools(); },
    dispose() {
      disposed = true;
      stopFollow();
      chart?.destroy?.();
      planner?.destroy(); planner = null;
      env.chartPoint(null);
    },
  };
}

