// 홈 대시보드 — 지도 우선 대신 탐색·개인화·기록으로 이어지는 랜딩.
import { loadData, REGION_COLORS, LIST_KEYS, LIST_META, DIFF_CLASS } from '../data.js';
import { hikedMap, isHiked, recentViews, onChange } from '../store.js';
import { cachedPosition, requestPosition, onPositionChange, permissionState, geoAvailable,
  bearingLabel, positionAgeText, sortByDistance, FRESH_MS } from '../position.js';
import { fmtDistFine } from '../geo.js';
import { el, clear } from '../dom.js';

const REGIONS = ['수도권', '강원', '충청', '전라', '경상', '제주'];

// 계절 → 테마 키워드 (best_season·features 매칭용)
function seasonInfo(month) {
  if (month >= 2 && month <= 4) return { name: '봄', kw: ['진달래', '철쭉', '벚꽃', '봄꽃', '야생화', '연분홍'] };
  if (month >= 5 && month <= 7) return { name: '여름', kw: ['계곡', '폭포', '숲', '원시림', '피서', '녹음'] };
  if (month >= 8 && month <= 10) return { name: '가을', kw: ['단풍', '억새', '단풍명산'] };
  return { name: '겨울', kw: ['설경', '상고대', '눈꽃', '일출', '해맞이'] };
}

function difficultyOf(m) {
  // 대표 코스들의 난이도 최빈/최고를 요약
  const order = { '쉬움': 1, '보통': 2, '어려움': 3, '매우 어려움': 4 };
  const ds = (m.trails || []).map((t) => t.difficulty).filter(Boolean).map((d) => order[d] || 2);
  if (!ds.length) return null;
  const max = Math.max(...ds);
  return ['', '쉬움', '보통', '어려움', '매우 어려움'][max];
}

export async function renderHome(root) {
  const data = await loadData();
  const page = el('div', { class: 'dash' });
  root.append(page);

  const body = el('div');
  page.append(body);

  // "내 주변 명산" 상태 — 위치는 사용자가 눌렀을 때만 새로 측정한다.
  // force=true(위치 새로고침)면 캐시를 쓰지 않고 반드시 다시 측정한다.
  const near = { loading: false, error: null };
  async function locateForNearby({ force = false } = {}) {
    if (near.loading) return;
    near.loading = true; near.error = null; draw();
    try { await requestPosition({ maxAgeMs: force ? 0 : FRESH_MS }); }
    catch (e) { near.error = e.message; }
    finally { near.loading = false; draw(); }   // 성공 시엔 onPositionChange로도 갱신되지만 중복은 무해
  }

  function draw() {
    clear(body);
    const hiked = hikedMap();
    const hikedIds = new Set(Object.keys(hiked));
    const recent = recentViews().map((id) => data.byId.get(id)).filter(Boolean);
    const returning = hikedIds.size > 0 || recent.length > 0;
    const season = seasonInfo(new Date().getMonth());

    body.append(heroSection(data, season));
    body.append(returning ? progressSection(data, hikedIds) : introSection(data));
    body.append(quickExploreSection(data));
    body.append(recommendSection(data, hikedIds, recent, season));
    body.append(nearbySection(data, near, locateForNearby));
    body.append(curationSection(data, hikedIds, season));
    if (recent.length) body.append(recentSection(recent));
    body.append(footerSection());
  }

  draw();
  // 이미 권한을 허용한 사용자는 묻지 않고 바로 내 주변을 채운다.
  if (!cachedPosition() && geoAvailable()) {
    permissionState().then((s) => { if (s === 'granted') locateForNearby(); });
  }
  const off = onChange(draw);
  const offPos = onPositionChange(draw);
  window.scrollTo(0, 0);
  return () => { off(); offPos(); };
}

/* ---------- 섹션들 ---------- */

function heroSection(data, season) {
  const search = el('input', {
    class: 'dash-search', type: 'search', 'aria-label': '산 이름·지역 검색',
    placeholder: '어느 산으로 떠날까요? 산 이름 또는 지역',
  });
  const results = el('div', { class: 'dash-suggest', hidden: true });

  const go = (q) => { location.hash = `#/map?q=${encodeURIComponent(q)}`; };
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && search.value.trim()) go(search.value.trim()); });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    clear(results);
    if (!q) { results.hidden = true; return; }
    const hits = data.mountains.filter((m) =>
      `${m.name} ${m.name_full} ${m.province} ${m.location}`.toLowerCase().includes(q)).slice(0, 6);
    if (!hits.length) { results.hidden = true; return; }
    hits.forEach((m) => results.append(el('a', { class: 'dash-suggest-item', href: `#/m/${m.id}` },
      el('span', { class: 'ds-dot', style: `background:${REGION_COLORS[m.region]}` }),
      el('span', { class: 'ds-name' }, m.name_full),
      el('span', { class: 'ds-meta' }, `${m.province} · ${Math.round(m.elevation_m)}m`))));
    results.hidden = false;
  });

  const chips = el('div', { class: 'dash-hero-chips' },
    el('a', { class: 'hchip', href: '#/map' }, ' 지도로 탐색'),
    el('a', { class: 'hchip', href: '#/map?sort=near' }, ' 가까운 순'),
    el('a', { class: 'hchip', href: `#/map?q=${encodeURIComponent(season.kw[0])}` }, `${season.name} 추천`),
    el('a', { class: 'hchip', href: '#/map?list=hansanha' }, ' 인기명산'),
    el('a', { class: 'hchip', href: '#/track' }, ' 내 기록'));

  const searchButton = el('button', { type: 'submit', 'aria-label': '산 검색' }, '검색 ↗');
  const form = el('form', { class: 'dash-search-wrap', onSubmit: (e) => { e.preventDefault(); if (search.value.trim()) go(search.value.trim()); } }, search, searchButton, results);
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') results.hidden = true; });
  form.addEventListener('focusout', (e) => { if (!form.contains(e.relatedTarget)) results.hidden = true; });
  return el('section', { class: 'dash-hero' },
    el('div', { class: 'hero-copy' },
      el('p', { class: 'eyebrow' }, '대한민국 명산 안내서'),
      el('h1', {}, '산으로 가는', el('br'), '나만의 길.'),
      el('p', { class: 'dash-hero-sub' }, '가까운 뒷산부터 오래 마음에 둔 능선까지.', el('br'), '다음에 오를 산을 찾고, 걸어온 길을 기록하세요.'),
      form, chips),
    el('a', { class: 'atlas-cover', href: '#/map', 'aria-label': '전국 명산 지도 펼치기' },
      el('span', { class: 'atlas-top' }, '전국 명산 지도', el('span', {}, '山 / 100')),
      el('div', { class: 'contour-art', 'aria-hidden': 'true', html: contourArt() }),
      el('div', { class: 'atlas-bottom' }, el('span', {}, '산을 만나는 또 하나의 방법', el('strong', {}, '지도를 펼쳐보세요')), el('span', { class: 'atlas-arrow' }, '↗'))));
}

// Decorative contour drawing; not geographic or navigational data.
function contourArt() {
  const paths = Array.from({ length: 18 }, (_, i) => {
    const scale = 0.20 + i * 0.065;
    return `<path transform="translate(230 210) scale(${scale})" d="M-150,-110 C-110,-170 -40,-122 12,-162 C95,-216 122,-93 175,-65 C236,-26 153,33 153,100 C148,158 56,128 4,160 C-52,197 -62,100 -136,99 C-215,90 -161,15 -186,-24 C-211,-67 -172,-73 -150,-110Z"/>`;
  }).join('');
  return `<svg viewBox="0 0 460 420" xmlns="http://www.w3.org/2000/svg" fill="none"><g stroke="currentColor" stroke-width="1">${paths}</g><path d="M115 355 Q160 265 220 235 T266 127" stroke="#d7ae71" stroke-width="2" stroke-dasharray="4 6"/><circle cx="266" cy="127" r="5" fill="#d7ae71"/><path d="M228 200l7-12 7 12z" stroke="#e9e8d8"/><g stroke="#e9e8d8"><path d="M395 35v35m-7-27 7-8 7 8"/></g><text x="390" y="25" fill="#e9e8d8" font-size="11">N</text></svg>`;
}



function introSection(data) {
  const total = data.mountains.length;
  const stat = (n, l) => el('div', { class: 'intro-stat' }, el('b', {}, String(n)), el('span', {}, l));
  return el('section', { class: 'dash-section intro-card', 'aria-label': '명산 안내서 수록 현황' },
    el('div', { class: 'intro-label' }, '한곳에 모은', el('strong', {}, '우리나라 명산')),
    el('div', { class: 'intro-grid' }, stat(total, '수록 명산'), stat(4, '선정 목록'), stat(6, '전국 권역'),
      stat(data.mountains.filter(m => LIST_KEYS.every(k => m.lists[k])).length, '네 목록 공통')));

}

function progressSection(data, hikedIds) {
  const all = data.mountains;
  const done = all.filter((m) => hikedIds.has(m.id)).length;
  const pct = Math.round((done / all.length) * 100);

  // 목록별 진행 + 다음 목표
  const bars = LIST_KEYS.map((k) => {
    const inList = all.filter((m) => m.lists[k]);
    const d = inList.filter((m) => hikedIds.has(m.id)).length;
    const p = inList.length ? Math.round((d / inList.length) * 100) : 0;
    return el('div', { class: 'plist-row' },
      el('span', { class: 'plist-label' }, LIST_META[k].short),
      el('span', { class: `plist-track card-${k}` }, el('span', { style: `width:${p}%` })),
      el('span', { class: 'plist-num' }, `${d}/${inList.length}`));
  });

  // 다음 목표: 가장 진행이 많은 목록의 다음 10좌 이정표
  const next = LIST_KEYS.map((k) => {
    const d = all.filter((m) => m.lists[k] && hikedIds.has(m.id)).length;
    return { k, d, goal: Math.min(100, (Math.floor(d / 10) + 1) * 10) };
  }).filter((x) => x.d > 0).sort((a, b) => b.d - a.d)[0];

  return el('section', { class: 'dash-section progress-card' },
    el('div', { class: 'prog-head' },
      el('div', {},
        el('div', { class: 'prog-big' }, String(done), el('small', {}, ` / ${all.length}곳 등정`)),
        el('div', { class: 'muted', style: 'font-size:13px' }, `전체 진행률 ${pct}%` +
          (next ? ` · ${LIST_META[next.k].short} ${next.goal}좌까지 ${next.goal - next.d}곳` : ''))),
      el('a', { class: 'btn', href: '#/track' }, '내 기록 보기 →')),
    el('div', { class: 'prog-overall' }, el('span', { style: `width:${pct}%` })),
    el('div', { class: 'plist' }, ...bars));
}

// 현재 위치에서 가까운 명산 — 위치를 알면 가까운 순 카드, 모르면 위치 요청 카드.
function nearbySection(data, near, onLocate) {
  const pos = cachedPosition();

  if (!pos) {
    const btn = el('button', { class: 'btn primary', type: 'button', disabled: near.loading });
    if (near.loading) btn.append(el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' 현재 위치 확인 중…');
    else btn.append(near.error ? ' 다시 시도' : ' 내 위치로 가까운 산 찾기');
    btn.addEventListener('click', () => onLocate());

    const unsupported = !geoAvailable();
    return el('section', { class: 'dash-section' },
      sectionHead('내 주변 명산', '현재 위치에서 가까운 순'),
      el('div', { class: 'near-cta' },
        el('div', { class: 'near-cta-text' },
          el('b', {}, '지금 있는 곳에서 가까운 명산부터 보여드려요.'),
          el('span', {}, '위치는 이 기기에만 저장되며 어디에도 전송되지 않습니다.')),
        unsupported
          ? el('div', { class: 'geo-note warn' }, '이 브라우저·연결에서는 위치 기능을 사용할 수 없습니다.')
          : btn),
      near.error ? el('div', { class: 'geo-note warn', style: 'margin-top:10px' }, near.error) : null);
  }

  const list = sortByDistance(data.mountains.filter((m) => m.lat != null), pos).slice(0, 4);

  const refresh = el('button', { class: 'near-refresh', type: 'button', disabled: near.loading },
    near.loading ? '측정 중…' : '↻ 위치 새로고침');
  refresh.addEventListener('click', () => onLocate({ force: true }));

  return el('section', { class: 'dash-section' },
    sectionHead('내 주변 명산', `현재 위치 기준 · ${positionAgeText(pos.ts)} 측정`, '#/map?sort=near'),
    el('div', { class: 'card-grid' },
      ...list.map(({ m, dist }) => mtnCard(m, `${bearingLabel(pos, m.lat, m.lon)}쪽 ${fmtDistFine(dist)}`))),
    el('div', { class: 'near-foot' },
      refresh,
      near.error ? el('span', { class: 'geo-note warn' }, near.error) : null,
      el('span', { class: 'near-hint' }, '직선거리 기준입니다.')));
}

// 규칙 기반 "다음에 오를 산" 추천
function recommendSection(data, hikedIds, recent, season) {
  const recentRegions = new Set(recent.map((m) => m.region));
  const scored = data.mountains
    .filter((m) => !hikedIds.has(m.id) && m.lat != null)
    .map((m) => {
      let s = 0; const reasons = [];
      if (recentRegions.has(m.region) && recent.length) { s += 3; reasons.push(`최근 본 ${m.region} 인근`); }
      if (m.hansanha_rank) { s += Math.max(0, 3 - Math.floor((m.hansanha_rank - 1) / 20)); if (m.hansanha_rank <= 30) reasons.push(`인기명산 ${m.hansanha_rank}위`); }
      const hay = `${(m.features || []).join(' ')} ${m.best_season || ''}`;
      if (season.kw.some((k) => hay.includes(k))) { s += 2.5; reasons.push(`${season.name} 추천`); }
      if (m.lists.sanlim && m.lists.bac && m.lists.hansanha && m.lists.wolgansan) { s += 1; reasons.push('4대 공통'); }
      s += (m.id.charCodeAt(0) % 5) * 0.12; // 약한 변주(결정적)
      return { m, s, reason: reasons[0] || `${m.region} 명산` };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);

  return el('section', { class: 'dash-section' },
    sectionHead('다음에 오르면 좋은 산', recent.length ? '내 기록 기준 추천' : '인기·계절 기준 추천'),
    el('div', { class: 'card-grid' }, ...scored.map(({ m, reason }) => mtnCard(m, reason))));
}

function quickExploreSection(data) {
  const counts = {}; REGIONS.forEach((r) => (counts[r] = 0));
  data.mountains.forEach((m) => { if (counts[m.region] != null) counts[m.region]++; });
  const regionCards = REGIONS.map((r) => el('a', { class: 'region-card', href: `#/map?region=${encodeURIComponent(r)}`, style: `--rc:${REGION_COLORS[r]}` },
    el('span', { class: 'rc-dot' }), el('span', { class: 'rc-name' }, r), el('span', { class: 'rc-count' }, `${counts[r]}곳`)));

  const themes = [
    [' 봄꽃', 'q', '진달래'], [' 단풍', 'q', '단풍'], [' 억새', 'q', '억새'],
    [' 계곡', 'q', '계곡'], [' 일출', 'q', '일출'], [' 암릉', 'q', '암릉'],
    [' 대중교통', 'q', '대중교통'],
  ];
  const themeChips = themes.map(([label, key, val]) =>
    el('a', { class: 'chip', href: `#/map?${key}=${encodeURIComponent(val)}` }, label));

  const listChips = LIST_KEYS.map((k) => el('a', { class: `chip list-${k}`, href: `#/map?list=${k}` }, LIST_META[k].chip));

  return el('section', { class: 'dash-section' },
    sectionHead('어디로 떠나볼까요', '지역과 테마로 찾는 산', '#/map'),
    el('div', { class: 'region-scroller' }, ...regionCards),
    el('div', { class: 'explore-groups' },
      el('div', { class: 'eg' }, el('span', { class: 'eg-label' }, '목록별'), el('div', { class: 'chips' }, ...listChips)),
      el('div', { class: 'eg' }, el('span', { class: 'eg-label' }, '테마별'), el('div', { class: 'chips' }, ...themeChips))));
}

function curationSection(data, hikedIds, season) {
  // 인기명산 TOP (한국의산하 순위)
  const popular = data.mountains.filter((m) => m.hansanha_rank).sort((a, b) => a.hansanha_rank - b.hansanha_rank).slice(0, 4);
  // 초보자 추천: 쉬운/보통 + 저고도 미등정
  const easy = data.mountains
    .filter((m) => !hikedIds.has(m.id) && ['쉬움', '보통'].includes(difficultyOf(m)) && m.elevation_m <= 700)
    .sort((a, b) => a.elevation_m - b.elevation_m).slice(0, 4);
  // 계절 큐레이션
  const seasonal = data.mountains
    .filter((m) => season.kw.some((k) => `${(m.features || []).join(' ')} ${m.best_season || ''}`.includes(k)))
    .slice(0, 4);

  const groups = [
    [' 한국의산하 인기명산 TOP', popular, '#/map?list=hansanha'],
    [' 초보자에게 좋은 산', easy, '#/map'],
    [`지금 오르기 좋은 ${season.name} 명산`, seasonal, `#/map?q=${encodeURIComponent(season.kw[0])}`],
  ].filter(([, arr]) => arr.length);

  return el('section', { class: 'dash-section' },
    ...groups.map(([title, arr, href]) => el('div', { class: 'curation' },
      sectionHead(title, null, href),
      el('div', { class: 'card-grid' }, ...arr.map((m) => mtnCard(m))))));
}

function recentSection(recent) {
  return el('section', { class: 'dash-section' },
    sectionHead('최근 본 산', null),
    el('div', { class: 'card-grid' }, ...recent.slice(0, 4).map((m) => mtnCard(m))));
}

function footerSection() {
  return el('section', { class: 'dash-foot' },
    el('p', { class: 'disclaimer' },
      'ⓘ 산림청·블랙야크·한국의산하·월간산 공개 목록과 웹 조사를 바탕으로 자동 정리한 참고 자료입니다. ' +
      '실제 산행 전 국립공원·지자체의 최신 탐방로·통제 정보를 반드시 확인하세요.'));
}

/* ---------- 공용 요소 ---------- */

function sectionHead(title, sub, moreHref) {
  return el('div', { class: 'sec-head' },
    el('h2', {}, title, sub ? el('span', { class: 'sec-sub' }, sub) : null),
    moreHref ? el('a', { class: 'sec-more', href: moreHref }, '전체 보기 →') : null);
}

function mtnCard(m, reason) {
  const diff = difficultyOf(m);
  return el('a', { class: 'mtn-card', href: `#/m/${m.id}` },
    el('span', { class: 'mc-index' }, `${Math.round(m.elevation_m).toLocaleString()} `, el('small', {}, 'm')),
    el('div', { class: 'mc-body' },
      el('div', { class: 'mc-top' },
        el('span', { class: 'mc-name' }, m.name, m.disambig ? el('span', { class: 'disambig' }, m.disambig) : null),
        isHiked(m.id) ? el('span', { class: 'hiked-star', title: '등정 완료' }, '') : null),
      el('div', { class: 'mc-meta' },
        el('span', {}, `${m.region} · ${Math.round(m.elevation_m)}m`),
        diff ? el('span', { class: 'mc-diff ' + (DIFF_CLASS[diff] || 'd2') }, diff) : null),
      el('div', { class: 'mc-description' }, (m.features || []).slice(0, 3).join(' · ')),
      reason ? el('div', { class: 'mc-reason' }, reason) : null));
}
