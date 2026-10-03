import { loadData } from '../data.js';
import { el, clear } from '../dom.js';
import { courseMatches, famousCourseRow } from '../famouscourses.js';

const REGIONS = ['수도권', '강원', '충청', '전라', '경상', '제주'];

export async function renderCourses(root) {
  const data = await loadData();
  if (!root.isConnected) return () => {};
  const meta = data.meta.famous_courses;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const search = el('input', { type: 'search', id: 'course-search', placeholder: '산 이름 또는 코스 이름',
    value: params.get('q') || '', autocomplete: 'off' });
  const region = el('select', { id: 'course-region', 'aria-label': '지역' }, el('option', { value: '' }, '전국'),
    ...REGIONS.map(r => el('option', { value: r }, r)));
  region.value = REGIONS.includes(params.get('region')) ? params.get('region') : '';
  const count = el('p', { class: 'courses-count', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'famous-mountains' });
  const reset = () => { search.value = ''; region.value = ''; update(); search.focus(); };
  const page = el('div', { class: 'page courses-page' },
    el('p', { class: 'course-eyebrow' }, '산별 코스 모음'), el('h2', {}, '대표·유명 코스'),
    el('p', { class: 'courses-intro' }, `${meta.mountains}개 산의 ${meta.courses}개 코스. 정상으로 오르는 길부터 능선 종주와 경관 탐방까지, 산별로 따로 모았습니다.`),
    el('details', { class: 'courses-policy' }, el('summary', {}, '코스 선정 기준과 출처'),
      el('p', {}, meta.policy), el('p', {}, `공식 코스 안내를 확인한 ${meta.official}개는 동선과 확인일을 표시했습니다. ${meta.catalog_note}`)),
    el('div', { class: 'courses-filters' }, el('label', { for: 'course-search' }, '산·코스 검색', search),
      el('label', { for: 'course-region' }, '지역', region),
      el('button', { type: 'button', class: 'btn', onClick: reset }, '초기화')),
    count, list);
  root.append(page);
  const cleanup = () => {};
  const mountains = [...data.mountains].sort((a, b) => REGIONS.indexOf(a.region) - REGIONS.indexOf(b.region) || a.name_full.localeCompare(b.name_full, 'ko'));
  function update({ writeURL = true } = {}) {
    clear(list);
    let mountainCount = 0, courseCount = 0;
    for (const m of mountains) {
      if (region.value && m.region !== region.value) continue;
      const courses = m.famous_courses.filter(c => courseMatches(m, c, search.value));
      if (!courses.length) continue;
      mountainCount++; courseCount += courses.length;
      list.append(el('section', { class: 'famous-mountain', dataset: { mountainId: m.id } },
        el('div', { class: 'famous-mountain-title' },
          el('h3', {}, el('a', { href: `#/m/${m.id}` }, m.name_full)),
          el('p', {}, `${m.region} · ${m.location}`),
          el('a', { class: 'course-mountain-link', href: `#/m/${m.id}` }, '산 정보·경로 계획 →')),
        el('ol', { class: 'famous-course-list' }, ...courses.map(c => famousCourseRow(m, c)))));
    }
    count.textContent = `${mountainCount}개 산 · ${courseCount}개 코스`;
    if (!mountainCount) list.append(el('div', { class: 'empty' },
      el('p', {}, '조건에 맞는 대표 코스가 없습니다.'), el('button', { class: 'btn', type: 'button', onClick: reset }, '조건 초기화')));
    if (writeURL) {
      const p = new URLSearchParams();
      if (search.value.trim()) p.set('q', search.value.trim());
      if (region.value) p.set('region', region.value);
      history.replaceState(history.state, '', `#/courses${p.size ? '?' + p : ''}`);
    }
    cleanup.origin = location.hash;
  }
  search.addEventListener('input', () => update());
  region.addEventListener('change', () => update());
  update({ writeURL: false });
  window.scrollTo(0, 0);
  return cleanup;
}
