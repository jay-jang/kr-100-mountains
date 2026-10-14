// 대표 코스 모음 #/courses?q=&region= — 산 20곳씩 "더 보기". 행을 누르면 그 산의 경로 시트로 간다.
// 설정('대표 코스 모음')은 입구만 숨긴다. 이 페이지는 링크로 언제든 열린다.
import '../css/pages.css';
import { loadData } from '../data.js';
import { el, clear } from '../dom.js';
import { courseMatches } from '../famouscourses.js';
import { pageBar, fold, fmtM, dots } from './pagekit.js';
// 근거 문구는 산·경로 시트와 같은 함수로 — 공식 출처가 국립공원공단이 아니면(예: 한라산은 제주특별자치도)
// '공단 안내 확인'이 아니라 '공식 안내 확인'이다. 두 화면이 같은 코스를 다르게 부르지 않게 한다.
import { evidenceLabel } from '../mountain/format.js';

const REGIONS = ['수도권', '강원', '충청', '전라', '경상', '제주'];
const PAGE = 20;
const VERIFY = { verified: '교차검증 일치', mixed: '자료 간 이견', single: '단일 출처' };

function fmtHours(h) {
  const n = Number(h);
  if (!(n > 0)) return '';
  const whole = Math.floor(n), min = Math.round((n - whole) * 60);
  return min ? (whole ? `${whole}시간 ${min}분` : `${min}분`) : `${whole}시간`;
}

/** 경로 시트 키: 등산로와 연결된 대표 코스는 t:<등산로 번호>, 아니면 c:<코스 id>. */
export function courseRouteKey(c) {
  return c.trail_index != null ? `t:${c.trail_index}` : `c:${encodeURIComponent(c.id)}`;
}

export async function renderCourses(root, route) {
  const data = await loadData();
  if (!root.isConnected) return () => {};
  const meta = data.meta.famous_courses || {};
  const params = route?.params || new URLSearchParams(location.hash.split('?')[1] || '');

  // ---------- 조건 ----------
  const search = el('input', { type: 'search', class: 'input', id: 'crs-q', placeholder: '산 이름 또는 코스 이름',
    value: params.get('q') || '', autocomplete: 'off', enterkeyhint: 'search' });
  const region = el('select', { id: 'crs-region', class: 'crs-select' },
    el('option', { value: '' }, '전국'), ...REGIONS.map((r) => el('option', { value: r }, r)));
  region.value = REGIONS.includes(params.get('region')) ? params.get('region') : '';
  const count = el('p', { class: 'crs-count', role: 'status', 'aria-live': 'polite' });
  const resetBtn = el('button', { type: 'button', class: 'pg-text-btn', hidden: true }, '조건 초기화');
  const list = el('div', { class: 'crs-list' });
  const moreNote = el('p', { class: 'crs-more-note' });
  const moreBtn = el('button', { type: 'button', class: 'btn crs-more-btn' }, '더 보기');
  const more = el('div', { class: 'crs-more', hidden: true }, moreNote, moreBtn);

  const policy = fold('코스 선정 기준과 출처',
    meta.policy ? el('p', { class: 'set-para' }, meta.policy) : null,
    el('p', { class: 'set-para' },
      `공식 코스 안내를 확인한 ${meta.official ?? ''}개 코스는 확인일과 함께 '공단 안내 확인'(국립공원공단) 또는 '공식 안내 확인'(지자체 등 그 밖의 기관)으로, 나머지는 '자료 선정'으로 적었습니다. ${meta.catalog_note || ''}`),
    el('p', { class: 'set-para' }, '거리·왕복 시간·난이도는 같은 산의 수록 등산로와 연결된 코스에만 붙습니다.'));
  policy.classList.add('pg-fold-quiet');

  const main = el('div', { class: 'pg-main' },
    policy,
    el('div', { class: 'crs-filters', role: 'search', 'aria-label': '대표 코스 찾기' },
      el('label', { class: 'crs-field crs-field-q', for: 'crs-q' }, el('span', { class: 'crs-field-label' }, '산·코스 검색'), search),
      el('label', { class: 'crs-field', for: 'crs-region' }, el('span', { class: 'crs-field-label' }, '권역'), region)),
    el('div', { class: 'crs-status' }, count, resetBtn),
    list, more);
  root.append(el('div', { class: 'pg pg-courses' }, pageBar({ title: '대표 코스 모음' }), main));

  const mountains = [...data.mountains].sort((a, b) =>
    REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region) || a.name_full.localeCompare(b.name_full, 'ko'));

  // 산 시트에서 뒤로 돌아오면 펼쳐 둔 개수와 스크롤 위치를 되살린다(이 기록 항목에 저장).
  const saved = history.state?.kr100courses;
  let shown = PAGE;
  let restoreY = 0;
  if (saved && saved.hash === location.hash) { shown = Math.max(PAGE, saved.shown || PAGE); restoreY = saved.y || 0; }

  let matches = [];   // [{ m, courses }]

  function compute() {
    const q = search.value;
    matches = [];
    for (const m of mountains) {
      if (region.value && m.region !== region.value) continue;
      const courses = (m.famous_courses || []).filter((c) => courseMatches(m, c, q));
      if (courses.length) matches.push({ m, courses });
    }
  }

  function courseRow(m, c) {
    const t = c.trail_index != null ? m.trails?.[c.trail_index] : null;
    const official = c.evidence === 'official';
    const checked = official ? (c.sources || []).find((s) => s.checked_at)?.checked_at : null;
    const facts = [
      t?.distance_km ? `${t.distance_km}km` : null,
      t?.round_trip_hours ? `왕복 ${fmtHours(t.round_trip_hours)}` : null,
      t?.difficulty ? `${t.difficulty}${VERIFY[t.verify?.level] ? ` (${VERIFY[t.verify.level]})` : ''}` : null,
    ].filter(Boolean);
    return el('li', { dataset: { courseId: c.id } },
      el('a', { class: 'crs-row', href: `#/m/${m.id}?route=${courseRouteKey(c)}` },
        el('span', { class: 'crs-name' }, c.name),
        c.via?.length ? el('span', { class: 'crs-via' }, c.via.join(' → ')) : null,
        el('span', { class: 'crs-meta' }, ...dots(
          c.selection_reason, ...facts,
          el('span', { class: official ? 'crs-ev ok' : 'crs-ev' },
            `${evidenceLabel(c)}${checked ? ` ${checked}` : ''}`)))));
  }

  function mountainSection({ m, courses }) {
    return el('section', { class: 'crs-m', 'aria-labelledby': `crs-h-${m.id}`, dataset: { mountainId: m.id } },
      el('h2', { class: 'crs-m-h', id: `crs-h-${m.id}`, tabindex: '-1' },
        el('a', { href: `#/m/${m.id}` }, m.name_full)),
      el('p', { class: 'crs-m-meta' }, ...dots(m.region, m.province !== m.region ? m.province : null, fmtM(m.elevation_m), `코스 ${courses.length}`)),
      el('ul', { class: 'crs-rows' }, ...courses.map((c) => courseRow(m, c))));
  }

  function paintMore() {
    const rest = matches.length - Math.min(shown, matches.length);
    more.hidden = rest <= 0;
    moreNote.textContent = `${matches.length}곳 중 ${Math.min(shown, matches.length)}곳 표시`;
    moreBtn.textContent = `${Math.min(PAGE, rest)}곳 더 보기`;
  }

  function paint() {
    clear(list);
    const courseCount = matches.reduce((n, x) => n + x.courses.length, 0);
    count.textContent = `${matches.length}개 산 · ${courseCount}개 코스`;
    resetBtn.hidden = !(search.value.trim() || region.value);
    if (!matches.length) {
      list.append(el('div', { class: 'empty' },
        el('p', {}, '조건에 맞는 대표 코스가 없습니다.'),
        el('button', { type: 'button', class: 'btn', onClick: reset }, '조건 초기화')));
    }
    matches.slice(0, shown).forEach((x) => list.append(mountainSection(x)));
    paintMore();
  }

  function writeURL() {
    const p = new URLSearchParams();
    if (search.value.trim()) p.set('q', search.value.trim());
    if (region.value) p.set('region', region.value);
    const hash = `#/courses${p.size ? '?' + p : ''}`;
    if (location.hash !== hash) history.replaceState(history.state, '', hash);
  }

  function update() {
    shown = PAGE;
    compute(); paint(); writeURL();
  }
  function reset() {
    search.value = ''; region.value = '';
    update();
    search.focus();
  }

  moreBtn.addEventListener('click', () => {
    const from = shown;
    shown += PAGE;
    const added = matches.slice(from, shown).map(mountainSection);
    added.forEach((s) => list.append(s));
    paintMore();
    // 새로 붙은 첫 산 제목으로 포커스 — 키보드·화면 낭독기 사용자가 이어서 읽는다.
    added[0]?.querySelector('.crs-m-h')?.focus({ preventScroll: false });
  });
  search.addEventListener('input', update);
  region.addEventListener('change', update);
  resetBtn.addEventListener('click', reset);
  search.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); search.blur(); }
  });
  // 행을 눌러 떠나기 직전에 펼친 개수·스크롤을 지금 기록 항목에 적는다.
  list.addEventListener('click', (e) => {
    if (!e.target.closest?.('a[href^="#/"]')) return;
    try {
      history.replaceState({ ...(history.state || {}), kr100courses: { hash: location.hash, shown, y: window.scrollY } }, '', location.hash);
    } catch {}
  });

  compute(); paint();
  if (restoreY) requestAnimationFrame(() => window.scrollTo(0, restoreY));

  const cleanup = () => {};
  cleanup.origin = '#/courses';
  return cleanup;
}
