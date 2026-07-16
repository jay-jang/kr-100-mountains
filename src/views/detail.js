import { loadData, DIFF_CLASS, regionColor, LIST_KEYS, LIST_META } from '../data.js';
import { createMapView, fetchTrails } from '../map.js';
import { mapControls } from '../mapcontrols.js';
import { isHiked, toggleHiked, onChange } from '../store.js';
import { parseGPX, drawTrack, elevationSVG } from '../gpx.js';
import { el, esc } from '../dom.js';

export async function renderDetail(root, id) {
  const data = await loadData();
  const m = data.byId.get(id);
  if (!m) {
    root.append(el('div', { class: 'page' },
      el('p', { class: 'crumb' }, el('a', { href: '#/' }, '← 지도로')),
      el('div', { class: 'empty' }, '산을 찾을 수 없습니다.')));
    return () => {};
  }

  const page = el('div', { class: 'page' });
  root.append(page);

  // ---- breadcrumb ----
  page.append(el('div', { class: 'crumb' },
    el('a', { href: '#/' }, '지도'), ' / ',
    el('a', { href: `#/?focus=${m.id}` }, m.region), ' / ', m.name_full));

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
      ...LIST_KEYS.filter((k) => m.lists[k]).map((k) =>
        (k === 'hansanha' && m.hansanha_rank)
          ? el('span', { class: 'pill p-hansanha ranked', title: '한국의 산하(koreasanha.net) 인기명산 100 접속순위' },
              rankMedal(m.hansanha_rank), '한국의산하 인기명산', el('b', { class: 'pill-rank' }, ` ${m.hansanha_rank}위`))
          : el('span', { class: `pill p-${k}` }, LIST_META[k].full))),
    hikeBtn));

  // ---- summary ----
  page.append(el('div', { class: 'section' },
    el('h3', {}, '개요'),
    m.summary
      ? el('p', { class: 'prose' }, m.summary)
      : el('p', { class: 'prose muted' }, '개요 정보를 준비 중입니다.')));

  // ---- location map ----
  const mapNode = el('div', { id: 'detail-map' });
  const trailBtn = el('button', { type: 'button' }, '🥾 등산로 표시');
  const fileInput = el('input', { type: 'file', accept: '.gpx', style: 'display:none' });
  const fileBtn = el('button', { type: 'button', onClick: () => fileInput.click() }, '📈 GPX 불러오기');
  const tools = el('div', { class: 'map-tools' }, trailBtn, fileBtn, fileInput);
  const mapWrap = el('div', { class: 'detail-map-wrap' }, mapNode, tools);
  const elevBox = el('div', { class: 'elev-profile' });
  const gpxNote = el('div', { class: 'conf-note' });
  page.append(el('div', { class: 'section' }, el('h3', {}, '위치 · 경로'), mapWrap, elevBox, gpxNote));

  let view, controls, trailLayer = null, gpxLayer = null;
  if (m.lat != null) {
    view = await createMapView(mapNode, { center: [m.lat, m.lon], zoom: 13 });
    controls = mapControls(view, mapWrap);
    mapWrap.append(controls);
    view.addDot({ lat: m.lat, lng: m.lon, color: regionColor(m.region), title: `${m.name} 정상 ${m.elevation_m}m` });
    if (m.coord_confidence && m.coord_confidence !== 'high')
      gpxNote.textContent = `※ 정상 좌표는 근사값일 수 있습니다 (신뢰도: ${m.coord_confidence}).`;

    // auto-load curated GPX if present
    tryLoadCuratedGPX(m.id, view, elevBox, gpxNote).then((token) => { if (token) gpxLayer = token; });

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
      } catch (err) { gpxNote.textContent = 'GPX 오류: ' + err.message; }
    });
  } else {
    mapWrap.replaceWith(el('div', { class: 'empty' }, '정상 좌표 정보를 준비 중입니다.'));
  }

  // ---- trails (난이도·시간: 웹조사 + codex + agy 교차검증) ----
  if (m.trails?.length) {
    const VBADGE = { verified: ['codex·agy 교차검증', 'v-ok'], mixed: ['난이도 이견', 'v-mixed'], single: ['단일 확인', 'v-single'] };
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
      el('p', { class: 'conf-note', style: 'margin:-4px 0 12px' }, '난이도·등반시간은 웹 조사와 codex·agy를 교차검증한 값입니다.'),
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
    '실제 산행 전에는 국립공원·지자체의 최신 탐방로·통제 정보를 반드시 확인하세요. ' +
    '지도의 등산로 선은 OpenStreetMap 데이터이며, GPX는 실제 기록 파일만 표시합니다.'));

  const off = onChange(paintHike);
  const onTheme = () => view && view.refreshTheme();
  window.addEventListener('kr100:theme', onTheme);
  window.scrollTo(0, 0);
  return () => { off(); window.removeEventListener('kr100:theme', onTheme); controls?.cleanup?.(); view?.destroy(); };
}

function factSpan(label, val) {
  return el('span', {}, `${label} `, el('b', {}, val));
}

// 한국의산하 인기명산 순위 메달 (상위권 강조)
function rankMedal(rank) {
  const m = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank <= 10 ? '🏅' : '';
  return m ? el('span', { class: 'medal', 'aria-hidden': 'true' }, m + ' ') : null;
}

function verifyTitle(v) {
  const d = v.difficulties || {};
  const parts = [d.enrichment && `조사:${d.enrichment}`, d.codex && `codex:${d.codex}`, d.agy && `agy:${d.agy}`].filter(Boolean);
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
    return token;
  } catch { return null; }
}
