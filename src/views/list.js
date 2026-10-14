// 목록 시트 — 명산 모드(필터·가까운 순·검색) / 걷기길 모드(지도 범위 안 노선).
// URL(#/map?…)이 상태의 원본이다. 바꿀 때마다 replaceState로 쓰고 셸의 칩에도 알린다.
import { el, clear } from '../dom.js';
import { filterMountains, representativeCourse, LIST_KEYS, LIST_META } from '../data.js';
import { isHiked, hikedCount, onChange as onStore } from '../store.js';
import { pref, onPrefs } from '../prefs.js';
import { cachedPosition, requestPosition, permissionState, geoAvailable, onPositionChange,
  distanceTo, bearingLabel, positionAgeText, sortByDistance, FRESH_MS } from '../position.js';
import { fmtDistFine } from '../geo.js';
import { searchRank } from '../search.js';
import { openModal } from '../modal.js';
import { navigate } from '../router.js';
import { loadTrekIndex, loadWalkIndex, kindLabel, kindStyle, KIND_SHORT } from '../walkdata.js';
import { WALK_MAX_KM } from '../walklayer.js';
import { isDarkTheme } from '../prefs.js';

const REGIONS = ['수도권', '강원', '충청', '전라', '경상', '제주'];
const WALK_KINDS = [['', '전체'], ['dulle', '둘레길'], ['long', '장거리'], ['ridge', '마루금'], ['forest', '숲길'], ['trail', '탐방로']];

function parse(params) {
  const csv = (k) => (params.get(k) ? params.get(k).split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    mode: params.get('mode') === 'walk' ? 'walk' : 'mountain',
    q: params.get('q') || '',
    regions: new Set(csv('region').filter((r) => REGIONS.includes(r))),
    lists: new Set(csv('list').filter((k) => LIST_KEYS.includes(k))),
    allFour: params.get('all') === '4',
    hiked: params.get('hiked') === '1' ? 'yes' : params.get('hiked') === '0' ? 'no' : '',
    sort: params.get('sort') === 'near' ? 'near' : 'default',
    easy: params.get('easy') === '1',
    maxHours: [2, 4, 6, 8].includes(Number(params.get('hours'))) ? Number(params.get('hours')) : 0,
    maxDistance: [5, 10, 15].includes(Number(params.get('distance'))) ? Number(params.get('distance')) : 0,
    dulle: params.get('dulle') === '1',
    walkKind: WALK_KINDS.some(([k]) => k === params.get('walkkind')) ? params.get('walkkind') : '',
    focus: params.get('focus') || null,
  };
}
function serialize(s) {
  const p = new URLSearchParams();
  if (s.mode === 'walk') p.set('mode', 'walk');
  if (s.q) p.set('q', s.q);
  if (s.regions.size) p.set('region', [...s.regions].join(','));
  if (s.lists.size) p.set('list', [...s.lists].join(','));
  if (s.allFour) p.set('all', '4');
  if (s.hiked) p.set('hiked', s.hiked === 'yes' ? '1' : '0');
  if (s.easy) p.set('easy', '1');
  if (s.maxHours) p.set('hours', String(s.maxHours));
  if (s.maxDistance) p.set('distance', String(s.maxDistance));
  if (s.dulle) p.set('dulle', '1');
  if (s.sort === 'near') p.set('sort', 'near');
  if (s.walkKind) p.set('walkkind', s.walkKind);
  return p;
}
const listKey = (p) => 'kr100:list:' + p.toString();
/** 4.5 → "4시간 30분", 3 → "3시간", 0.5 → "30분" */
function fmtHours(h) {
  const t = Math.round(Number(h) * 60), hh = Math.floor(t / 60), mm = t % 60;
  return hh ? `${hh}시간${mm ? ` ${mm}분` : ''}` : `${mm}분`;
}

export async function renderList(ctx, route) {
  const { data, sheet } = ctx;
  const state = parse(route.params);

  // 예전 딥링크 ?focus=<id> → 그 산의 시트를 연다(뒤로가면 목록. 반복되지 않게 focus는 지운다).
  if (state.focus && data.byId.has(state.focus)) {
    const id = state.focus;
    state.focus = null;
    writeURL();
    navigate(`#/m/${id}`);
    return { dispose() {} };
  }

  let trekIndex = null;               // { id: {count, kinds} }
  let pos = cachedPosition();
  let nearNote = '';
  let lastFitQuery = state.q.trim() || null;
  let fitTimer = 0;
  if (state.sort === 'near' && !pos) state.sort = 'default';

  // ---------- 시트 골격 ----------
  const title = el('h2', { class: 'sheet-title', tabindex: '-1' });
  const count = el('span', { class: 'sheet-count', 'aria-live': 'polite' });
  const hikedLink = el('a', { class: 'sheet-sub-link', href: '#/track' });
  const catalogLink = el('a', { class: 'sheet-sub-link catalog-link', href: '#/courses', hidden: true }, '대표 코스 모음 ›');
  const nearBtn = el('button', { type: 'button', class: 'chip small', 'aria-pressed': 'false' }, '가까운 순');
  const head = el('div', { class: 'sheet-headline' }, el('div', { class: 'sheet-titles' }, title, el('p', { class: 'sheet-sub' }, count, hikedLink, catalogLink)), nearBtn);
  const note = el('p', { class: 'sheet-note', hidden: true });
  const tokens = el('div', { class: 'tokens', hidden: true, 'aria-label': '적용 중인 조건' });
  const kindChips = el('div', { class: 'chips-row', role: 'group', 'aria-label': '걷기길 종류', hidden: true });
  const header = el('div', {}, head, note, tokens, kindChips);
  // 행 묶음마다 role=list(항목은 <a>를 감싼 div — <a>에 listitem을 주면 링크라는 사실이 사라진다).
  // 묶음 제목(추천·전체)과 빈 결과 안내는 목록 항목이 아니므로 바깥 상자에 둔다.
  const listEl = el('div', { class: 'rows' });
  const rowGroup = (rows) => el('div', { role: 'list' }, rows.map((r) => el('div', { role: 'listitem' }, r)));
  const extra = el('div', { class: 'sheet-extra' });
  const content = el('div', {}, listEl, extra);

  WALK_KINDS.forEach(([k, label]) => {
    const b = el('button', { type: 'button', class: 'chip small', 'aria-pressed': String(state.walkKind === k) }, label);
    b.addEventListener('click', () => { state.walkKind = k; [...kindChips.children].forEach((c) => c.setAttribute('aria-pressed', String(c === b))); update(); });
    kindChips.append(b);
  });

  const saved = (() => { try { return JSON.parse(sessionStorage.getItem(listKey(serialize(state)))) || {}; } catch { return {}; } })();
  // 목록에 돌아오면 떠날 때의 높이로. 처음이면 앞 화면이 펼쳐 둔 full을 이어받지 않고 half로.
  ctx.setContent({ header, content, label: state.mode === 'walk' ? '걷기길 목록' : '명산 목록',
    detent: saved.detent || (sheet.detent === 'full' ? 'half' : undefined) });
  if (saved.scroll) requestAnimationFrame(() => { sheet.body.scrollTop = saved.scroll; });
  // 상세에서 돌아오면 떠날 때의 지도 범위로 되돌린다(목록 → 상세 → 뒤로).
  if (saved.viewport) ctx.whenMap((v) => v.restore?.(saved.viewport));

  // ---------- URL·칩 ----------
  function writeURL() {
    const p = serialize(state);
    const hash = '#/map' + (p.size ? '?' + p : '');
    // 다른 화면으로 막 이동했다면(산 시트 주소가 이미 쌓임) 그 주소를 목록 주소로 덮어쓰지 않는다 — 늦게 끝난
    // 위치 측정·자료 로드가 update()를 불러도 새 화면의 주소는 그대로. 첫 진입(빈 주소)은 #/map으로 맞춘다.
    const onList = !location.hash || /^#\/?(map)?(\?|$)/.test(location.hash);
    if (onList && location.hash !== hash) history.replaceState(history.state, '', hash);
    ctx.setListParams(p);
  }

  // ---------- 명산 모드 ----------
  function filtered() {
    let list = filterMountains(data.mountains, {
      q: state.q, regions: state.regions, lists: state.lists, allFour: state.allFour,
      hikedOnly: state.hiked === 'yes', isHiked, easy: state.easy, maxHours: state.maxHours, maxDistance: state.maxDistance,
    });
    if (state.hiked === 'no') list = list.filter((m) => !isHiked(m.id));
    if (state.dulle && trekIndex) list = list.filter((m) => walkCount(m.id) > 0);
    if (state.sort === 'near' && pos) list = sortByDistance(list.filter((m) => m.lat != null), pos).map((x) => x.m);
    else if (state.q.trim()) {
      const q = state.q.trim().toLowerCase();
      list.sort((a, b) => searchRank(a, q) - searchRank(b, q) || a.name.localeCompare(b.name, 'ko'));
    }
    return list;
  }
  function walkCount(id) {
    const e = trekIndex?.[id];
    if (!e) return 0;
    const k = e.kinds || {};
    return (k.dulle || 0) + (k.forest || 0) + (k.ridge || 0) + (k.other || 0);
  }

  function mountainRow(m, i) {
    const course = representativeCourse(m, state);
    const d = pos ? distanceTo(pos, m.lat, m.lon) : Infinity;
    const near = state.sort === 'near' && Number.isFinite(d);
    const hiked = isHiked(m.id);
    // 행: 이름 · 해발 · 등정 / 권역(·방위 거리) / 대표 코스 · 거리 · 왕복 · 난이도 — 코스명만 줄이고 수치는 늘 보이게.
    const row = el('a', { class: 'row', href: `#/m/${m.id}`, dataset: { id: m.id } },
      el('div', { class: 'row-main' },
        el('span', { class: 'row-title' }, near ? el('span', { class: 'row-rank' }, String(i + 1)) : null, m.name,
          m.disambig ? el('span', { class: 'row-tag' }, m.disambig) : null),
        el('span', { class: 'row-num' }, `${Math.round(m.elevation_m).toLocaleString()}m`),
        hiked ? el('span', { class: 'row-badge' }, '등정') : null),
      el('div', { class: 'row-meta' },
        near ? el('span', { class: 'row-dist' }, `${bearingLabel(pos, m.lat, m.lon)} ${fmtDistFine(d)}`) : null,
        el('span', {}, m.region),
        el('span', {}, m.province)),
      course ? el('div', { class: 'row-meta course' },
        el('span', {}, course.name),
        course.distance_km ? el('span', {}, `${course.distance_km}km`) : null,
        course.round_trip_hours ? el('span', {}, `왕복 ${fmtHours(course.round_trip_hours)}`) : null,
        course.difficulty ? el('span', {}, course.difficulty) : null) : null);
    row.addEventListener('mouseenter', () => ctx.highlightMarker(m.id, true));
    row.addEventListener('mouseleave', () => ctx.highlightMarker(m.id, false));
    return row;
  }

  function recommended(list) {
    const ids = new Set(list.map((m) => m.id));
    const month = new Date().getMonth();
    const kw = month >= 2 && month <= 4 ? ['진달래', '철쭉', '봄꽃'] : month >= 5 && month <= 7 ? ['계곡', '폭포', '숲'] : month >= 8 && month <= 10 ? ['단풍', '억새'] : ['설경', '상고대', '일출'];
    return data.mountains.filter((m) => ids.has(m.id) && !isHiked(m.id))
      .map((m) => {
        const hay = `${(m.features || []).join(' ')} ${m.best_season || ''}`;
        let s = 0;
        if (m.hansanha_rank) s += Math.max(0, 3 - Math.floor((m.hansanha_rank - 1) / 20));
        if (kw.some((k) => hay.includes(k))) s += 2.5;
        if (representativeCourse(m, { easy: true, maxHours: 4 })) s += 1;
        return { m, s };
      }).sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.m);
  }

  function paintTokens() {
    // 토큰은 통째로 다시 그린다 — 포커스가 토큰에 있었다면(토큰 [×]로 조건을 풀었을 때 등) 같은 자리의
    // 토큰(= 푼 것의 다음)으로 옮긴다. 남은 토큰이 없으면 [필터] 칩, 그것도 숨었으면 시트 제목으로.
    const focusAt = [...tokens.children].indexOf(document.activeElement);
    clear(tokens);
    const add = (label, remove) => tokens.append(el('button', { type: 'button', class: 'token', 'aria-label': `${label} 조건 해제`,
      onClick: () => { remove(); update(); } }, label, el('span', { 'aria-hidden': 'true' }, ' ×')));
    if (state.q.trim()) add(`“${state.q.trim()}”`, () => { state.q = ''; ctx.search.setValue(''); });
    [...state.regions].forEach((r) => add(r, () => state.regions.delete(r)));
    [...state.lists].forEach((k) => add(LIST_META[k].chip, () => state.lists.delete(k)));
    if (state.allFour) add('4개 목록 모두', () => { state.allFour = false; });
    if (state.hiked) add(state.hiked === 'yes' ? '등정한 산' : '미등정', () => { state.hiked = ''; });
    if (state.easy) add('쉬움·보통', () => { state.easy = false; });
    if (state.maxHours) add(`왕복 ${state.maxHours}시간 이내`, () => { state.maxHours = 0; });
    if (state.maxDistance) add(`${state.maxDistance}km 이내`, () => { state.maxDistance = 0; });
    if (state.dulle) add('둘레길 있는 산', () => { state.dulle = false; });
    if (tokens.children.length > 1) tokens.append(el('button', { type: 'button', class: 'token reset', onClick: () => { resetAll(); update(); } }, '조건 초기화'));
    tokens.hidden = !tokens.children.length;
    if (focusAt >= 0) {
      const next = tokens.children[Math.min(focusAt, tokens.children.length - 1)];
      if (next) next.focus({ preventScroll: true });
      else if (!ctx.focusFilterChip()) title.focus({ preventScroll: true });
    }
  }
  function resetAll() {
    state.q = ''; ctx.search.setValue('');
    state.regions.clear(); state.lists.clear(); state.allFour = false; state.hiked = '';
    state.easy = false; state.maxHours = 0; state.maxDistance = 0; state.dulle = false;
  }

  function updateMountains() {
    const list = filtered();
    title.textContent = '명산';
    count.textContent = `${list.length}곳`;
    const hc = hikedCount();
    hikedLink.textContent = hc ? ` · 등정 ${hc}` : '';
    hikedLink.hidden = !hc;
    nearBtn.hidden = false;
    nearBtn.setAttribute('aria-pressed', String(state.sort === 'near'));
    note.hidden = !nearNote; note.textContent = nearNote;
    paintTokens();
    kindChips.hidden = true;
    clear(listEl); clear(extra);
    if (!list.length) {
      // 누른 [조건 초기화]는 목록과 함께 사라진다 — 포커스를 시트 제목으로 옮겨 둔다.
      listEl.append(el('div', { class: 'empty' }, el('p', {}, '조건에 맞는 산이 없습니다.'),
        el('button', { type: 'button', class: 'btn', onClick: () => { resetAll(); update(); title.focus({ preventScroll: true }); } }, '조건 초기화')));
    } else {
      if (pref('recommendations') && state.sort !== 'near' && !state.q) {
        const rec = recommended(list);
        if (rec.length) {
          listEl.append(el('h3', { class: 'rows-h' }, '추천 · 인기·계절 기준'), rowGroup(rec.map((m, i) => mountainRow(m, i))),
            el('h3', { class: 'rows-h' }, '전체'));
        }
      }
      listEl.append(rowGroup(list.map((m, i) => mountainRow(m, i))));
    }
    catalogLink.hidden = !pref('courseCatalog');
    ctx.setMarkers({ ids: new Set(list.map((m) => m.id)) });
    scheduleAutoFit(list);
  }

  // 검색어로 결과가 좁혀지면(1~12곳) 지도도 그 범위로 맞춘다. 같은 검색어로 다시 그릴 때(칩 토글 등)는
  // 맞추지 않는다 — 안 그러면 사용자가 옮긴 지도가 계속 되돌아간다.
  function scheduleAutoFit(list) {
    clearTimeout(fitTimer);
    const q = state.q.trim();
    if (!q) { lastFitQuery = null; return; }
    if (q === lastFitQuery) return;
    const pts = list.filter((m) => m.lat != null).map((m) => [m.lat, m.lon]);
    if (!pts.length || pts.length > 12) return;
    lastFitQuery = q;
    fitTimer = setTimeout(() => { if (!ctx.disposed()) { if (pts.length === 1) ctx.focusPoint(pts[0], 12); else ctx.fit(pts, { maxZoom: 12 }); } }, 420);
  }

  // ---------- 걷기길 모드 ----------
  let walks = null, walkBounds = null, mapMoved = false;
  const redo = () => { walkBounds = ctx.view?.getBounds(); mapMoved = false; ctx.setMapAction(null); update(); };
  function updateWalks() {
    title.textContent = '걷기길';
    nearBtn.hidden = true;
    catalogLink.hidden = true;
    hikedLink.hidden = true;
    tokens.hidden = true;
    note.hidden = true;
    kindChips.hidden = false;
    clear(listEl); clear(extra);
    if (!walks) { count.textContent = '불러오는 중'; return; }
    if (!walks.length) {
      count.textContent = '';
      listEl.append(el('div', { class: 'empty' }, el('p', {}, '걷기길 자료를 불러오지 못했습니다.')));
      return;
    }
    const b = walkBounds || ctx.view?.getBounds();
    const inView = b ? walks.filter((w) => w.bbox && w.bbox[0] <= b.north && w.bbox[2] >= b.south && w.bbox[1] <= b.east && w.bbox[3] >= b.west) : walks;
    // '전체'는 걷기길만 — 정상으로 가는 탐방로 노선은 [탐방로]에서만 보인다(산 시트 코스 탭과 겹치지 않게).
    const kindOk = (w) => !state.walkKind ? w.kind !== 'trail'
      : (state.walkKind === 'long' ? w.kind === 'dulle' && w.long : w.kind === state.walkKind && !(state.walkKind === 'dulle' && w.long));
    const list = inView.filter(kindOk);
    if (b) {
      const cLat = (b.north + b.south) / 2, cLon = (b.east + b.west) / 2;
      const d = (w) => ((w.bbox[0] + w.bbox[2]) / 2 - cLat) ** 2 + (((w.bbox[1] + w.bbox[3]) / 2 - cLon) * 0.8) ** 2;
      list.sort((x, y) => d(x) - d(y));
    }
    count.textContent = `이 지역 ${list.length}개`;
    const widthKm = b ? (b.east - b.west) * 111 * Math.cos(((b.north + b.south) / 2) * Math.PI / 180) : Infinity;
    if (widthKm > WALK_MAX_KM) extra.append(el('p', { class: 'sheet-note' }, '지도를 확대하면 길이 선으로 보입니다.'));
    const dark = isDarkTheme();
    if (list.length) listEl.append(rowGroup(list.slice(0, 120).map((w) => {
      const st = kindStyle(w.kind, { long: w.long, dark });
      const nearM = (w.near || [])[0] && data.byId.get(w.near[0].id);
      const row = el('a', { class: 'row', href: `#/walk/${encodeURIComponent(w.rid)}` },
        el('div', { class: 'row-main' },
          el('span', { class: 'swatch', style: `--c:${st.color}` }),
          el('span', { class: 'row-title' }, w.name),
          el('span', { class: 'row-num' }, w.km ? `${w.km}km` : '')),
        el('div', { class: 'row-meta' },
          el('span', { class: 'row-kind' }, kindLabel(w)),
          w.loop != null ? el('span', {}, w.loop ? '순환' : '편도') : null,
          nearM ? el('span', {}, `${nearM.name} 근처`) : null));
      row.addEventListener('mouseenter', () => ctx.setWalkHighlight(w.rid));
      row.addEventListener('mouseleave', () => ctx.setWalkHighlight(null));
      return row;
    })));
    if (list.length > 120) extra.append(el('p', { class: 'sheet-note' }, `가까운 120개만 보여 줍니다. 지도를 옮기거나 확대하세요.`));
    if (!list.length) listEl.append(el('div', { class: 'empty' }, el('p', {}, '이 지역에 표시할 걷기길이 없습니다.'), el('p', { class: 'muted' }, '지도를 옮긴 뒤 지도 위의 “이 지역 다시 찾기”를 누르세요.')));
  }

  function update() {
    if (ctx.disposed()) return;
    writeURL();
    if (state.mode === 'walk') updateWalks(); else updateMountains();
  }

  // ---------- 가까운 순 ----------
  async function activateNear() {
    if (!geoAvailable()) { nearNote = '이 브라우저·연결에서는 위치를 쓸 수 없습니다.'; update(); return; }
    const cached = cachedPosition();
    if (cached) { pos = cached; state.sort = 'near'; nearNote = `${positionAgeText(cached.ts)} 측정한 위치 기준`; update(); fitNearest(); if (Date.now() - cached.ts <= FRESH_MS) return; }
    else { nearNote = '현재 위치를 확인하는 중…'; update(); }
    try {
      const p = await requestPosition({ maxAgeMs: cached ? 0 : FRESH_MS });
      if (ctx.disposed()) return;
      pos = p;
      if (state.sort === 'near' || !cached) { state.sort = 'near'; nearNote = `${positionAgeText(p.ts)} 측정한 위치 기준`; update(); if (!cached) fitNearest(); }
    } catch (err) {
      if (ctx.disposed()) return;
      nearNote = cached ? `${positionAgeText(cached.ts)} 측정한 위치 기준 · 새로 재지 못했습니다.` : err.message;
      if (!cached) state.sort = 'default';
      update();
    }
  }
  function fitNearest() {
    if (!pos) return;
    const near = sortByDistance(filtered().filter((m) => m.lat != null), pos).slice(0, 5);
    ctx.whenMap(() => ctx.fit([[pos.lat, pos.lng], ...near.map(({ m }) => [m.lat, m.lon])], { maxZoom: 12 }));
  }
  nearBtn.addEventListener('click', () => {
    if (state.sort === 'near') { state.sort = 'default'; nearNote = ''; update(); }
    else activateNear();
  });

  // ---------- 필터 모달 ----------
  // 조작 요소는 한 번만 만들고, 바꿀 때마다 눌림 상태·선택값·결과 수만 제자리에서 고친다.
  // 다시 만들면 누른 칩·고르던 select가 문서에서 빠져 키보드 포커스가 <body>로 떨어진다(화면 읽기도 처음부터).
  function openFilters() {
    const syncs = [];
    const chip = (label, isOn, onToggle) => {
      const b = el('button', { type: 'button', class: 'chip' }, label);
      syncs.push(() => b.setAttribute('aria-pressed', String(!!isOn())));
      b.addEventListener('click', () => { onToggle(); refresh(); update(); });
      return b;
    };
    function select(label, key, values, unit) {
      const s = el('select', { 'aria-label': label }, el('option', { value: '0' }, `${label} 제한 없음`), ...values.map((n) => el('option', { value: String(n) }, `${label} ${n}${unit} 이내`)));
      syncs.push(() => { if (s.value !== String(state[key])) s.value = String(state[key]); });
      s.addEventListener('change', () => { state[key] = Number(s.value); refresh(); update(); });
      return s;
    }
    const toggle = (set, k) => () => { set.has(k) ? set.delete(k) : set.add(k); };
    const group = (t, ...nodes) => el('fieldset', { class: 'fgroup' }, el('legend', {}, t), el('div', { class: 'chips-row' }, ...nodes));
    const body = el('div', { class: 'filters' },
      group('선정 목록', ...LIST_KEYS.map((k) => chip(LIST_META[k].chip, () => state.lists.has(k), toggle(state.lists, k))),
        chip('4개 목록 모두', () => state.allFour, () => { state.allFour = !state.allFour; })),
      group('권역', ...REGIONS.map((r) => chip(r, () => state.regions.has(r), toggle(state.regions, r)))),
      group('등정', ...[['', '전체'], ['yes', '등정한 산'], ['no', '미등정']].map(([v, l]) => chip(l, () => state.hiked === v, () => { state.hiked = v; }))),
      group('코스', chip('쉬움·보통 코스', () => state.easy, () => { state.easy = !state.easy; }),
        select('왕복 시간', 'maxHours', [2, 4, 6, 8], '시간'), select('코스 거리', 'maxDistance', [5, 10, 15], 'km')),
      group('주변 길', chip('둘레길·걷기길 있는 산', () => state.dulle, () => { state.dulle = !state.dulle; })),
      el('p', { class: 'fine' }, '코스 조건은 한 코스가 모든 조건을 함께 만족하는 산만 남깁니다. 시간·거리가 알려지지 않은 코스는 제외합니다.'));
    const showBtn = el('button', { type: 'button', class: 'btn primary' });
    const resetBtn = el('button', { type: 'button', class: 'btn' }, '초기화');
    function refresh() {
      syncs.forEach((f) => f());
      showBtn.textContent = `${filtered().length}곳 보기`;
    }
    refresh();
    const modal = openModal({ title: '필터', content: body, footer: el('div', { class: 'modal-actions' }, resetBtn, showBtn) });
    resetBtn.addEventListener('click', () => { const q = state.q; resetAll(); state.q = q; ctx.search.setValue(q); refresh(); update(); });
    showBtn.addEventListener('click', () => modal.close());
  }

  // ---------- 셸 이벤트 ----------
  const offStore = onStore(() => update());
  const offPrefs = onPrefs(() => update());
  const offPos = onPositionChange((p) => {
    if (!p || ctx.disposed()) return;
    const moved = !pos || distanceTo(pos, p.lat, p.lng) > 500;
    pos = p;
    if (state.sort === 'near' && moved) update();
  });
  const mountedAt = Date.now();
  ctx.onMove(() => {
    if (state.mode !== 'walk' || !walks) return;
    if (Date.now() - mountedAt < 1500) return;   // 들어올 때 코드가 옮긴 지도는 '사용자가 옮김'이 아니다
    if (!walkBounds) { update(); return; }
    if (!mapMoved) { mapMoved = true; ctx.setMapAction({ label: '이 지역 다시 찾기', onClick: redo }); }
  });

  ctx.search.setValue(state.q);
  if (state.mode === 'walk') {
    ctx.setWalkLayerMode('all');
    ctx.setMarkers({ dim: true });
    loadWalkIndex().then((w) => { walks = w; if (!ctx.disposed()) ctx.whenMap((v) => { walkBounds = v.getBounds(); update(); }); update(); });
  }
  loadTrekIndex().then((idx) => { trekIndex = idx; if (state.dulle && !ctx.disposed()) update(); });
  update();

  if (state.mode !== 'walk' && route.params.get('sort') === 'near') {
    if (pos) { nearNote = `${positionAgeText(pos.ts)} 측정한 위치 기준`; update(); fitNearest(); }
    else if (geoAvailable()) permissionState().then((s) => {
      if (ctx.disposed()) return;
      if (s === 'granted') activateNear();
      else { nearNote = '‘가까운 순’을 누르면 현재 위치를 확인해 가까운 산부터 보여 줍니다.'; update(); }
    });
  }
  if (ctx.consumeFilterRequest()) requestAnimationFrame(openFilters);

  let qBeforeTyping = null;
  return {
    openFilters,
    onSearchInput(q) {
      if (state.mode === 'walk') return;
      if (qBeforeTyping == null) qBeforeTyping = state.q;
      state.q = q; update();
    },
    onSearchPick() {
      if (qBeforeTyping != null) {
        state.q = qBeforeTyping; qBeforeTyping = null;
        lastFitQuery = state.q.trim() || null;
        writeURL();
      }
      return state.q;
    },
    onSearchSubmit(q) {
      qBeforeTyping = null;
      state.mode = 'mountain'; state.q = q; ctx.search.setValue(q);
      if (sheet.detent === 'peek' || sheet.detent === 'min') sheet.setDetent('half');
      update();
    },
    /** 같은 목록 화면에서 칩으로 URL이 바뀌면 다시 만들지 않고 상태만 갱신한다(모드가 바뀌면 새로 만든다). */
    update(next) {
      const n = parse(next.params);
      if (n.mode !== state.mode) return false;
      if (n.focus && data.byId.has(n.focus)) {     // 목록에 있는 채로 ?focus= 링크가 들어온 경우
        const id = n.focus; n.focus = null; Object.assign(state, n); writeURL(); navigate(`#/m/${id}`); return true;
      }
      qBeforeTyping = null;
      Object.assign(state, n);
      if (state.sort === 'near' && !pos) state.sort = 'default';
      ctx.search.setValue(state.q);
      update();
      return true;
    },
    dispose() {
      clearTimeout(fitTimer);
      offStore(); offPrefs(); offPos();
      try { sessionStorage.setItem(listKey(serialize(state)), JSON.stringify({ scroll: sheet.body.scrollTop, detent: sheet.detent, viewport: ctx.view?.snapshot?.() })); } catch {}
    },
  };
}
