import { el } from './dom.js';

export function courseMatches(m, course, query) {
  const text = [m.name, m.name_full, m.region, m.location, course.name,
    course.selection_reason, course.highlight, ...(course.via || [])].filter(Boolean).join(' ').toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(word => text.includes(word));
}

// Course references are kept separate from mountain-level legacy references.
export function famousCourseRow(m, c, { detail = false, onInfo } = {}) {
  const title = detail ? el('h4', {}, c.name)
    : el('h4', {}, el('a', { href: `#/m/${m.id}?course=${encodeURIComponent(c.id)}` }, c.name));
  const official = c.evidence === 'official';
  const row = el('li', { class: 'famous-course', dataset: { courseId: c.id }, tabindex: '-1' },
    el('div', { class: 'famous-course-heading' }, title, el('span', { class: 'course-type' }, c.selection_reason)),
    c.via?.length ? el('p', { class: 'course-itinerary' }, c.via.join(' → ')) : null,
    c.highlight ? el('p', { class: 'course-highlight' }, c.highlight) : null,
    el('div', { class: 'course-evidence', dataset: { evidence: c.evidence } },
      el('span', {}, official ? '공식 코스 안내 확인' : '기존 자료 선정 · 산별 참고자료'),
      ...c.sources.map(s => el('a', { href: s.url, target: '_blank', rel: 'noopener',
        title: `${s.title}${s.checked_at ? ` · 확인 ${s.checked_at}` : ' · 개별 코스 인기도 미확인'}` },
      official ? `${s.title} ↗` : '참고자료 ↗')),
      official ? el('time', { datetime: c.sources[0].checked_at }, `${c.sources[0].checked_at} 확인`) : null),
    detail && c.trail_index != null ? el('button', { type: 'button', class: 'course-info-link',
      onClick: () => onInfo(c.trail_index) }, '수록 등산로 정보 보기 →') : null);
  return row;
}
