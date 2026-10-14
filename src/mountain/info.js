// 산 시트 정보 탭: 교통·주차 → 현장 정보 → 개요·추천 계절 → 특징 → 목록 근거 → 출처 → 안내.
import { el } from '../dom.js';
import { LIST_KEYS, LIST_META } from '../data.js';
import { navigate } from '../router.js';
import { icon } from '../icons.js';
import { hostOf } from './format.js';

// 경고 톤은 sentiment가 아니라 topic으로만 정한다(reviews.js와 같은 기준).
export const ALERT_TOPICS = ['위험구간', '통제·예약'];
const LEVEL = {
  verified: ['교차검증', '독립된 두 조사가 모두 웹 근거로 확인한 항목', 'ok'],
  single: ['단일 확인', '한 조사만 웹 근거로 확인한 항목', ''],
  unverified: ['미검증', '수집만 되고 검증을 거치지 못한 항목', ''],
};

/** 경고 topic 먼저, 그다음 교차검증 먼저. */
export function sortNotes(notes) {
  const rank = (n) => (ALERT_TOPICS.includes(n.topic) ? 0 : 1) * 2 + (n.verify?.level === 'verified' ? 0 : 1);
  return notes.map((n, i) => [n, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([n]) => n);
}

// 자료 기준일(as_of, "YYYY-MM")이 이보다 오래되었거나 없으면 지금도 그런지 알 수 없다고 적는다.
const STALE_MONTHS = 24;

/** 자료 기준일 → { text, stale }. 날짜가 없거나 2년이 넘었으면 stale. */
export function noteAge(asOf, now = new Date()) {
  const m = /^(\d{4})-(\d{2})/.exec(String(asOf || ''));
  if (!m) return { text: '기준일 없음', stale: true };
  const months = (now.getFullYear() * 12 + now.getMonth()) - (Number(m[1]) * 12 + Number(m[2]) - 1);
  return { text: `${m[1]}-${m[2]} 기준`, stale: months > STALE_MONTHS };
}

/** 현장 정보 한 항목. */
export function noteItem(n, { showRoute = true } = {}) {
  const alert = ALERT_TOPICS.includes(n.topic);
  const lv = LEVEL[n.verify?.level] || LEVEL.unverified;
  // 오래된 위험·통제 기록이 지금 내려진 경고처럼 읽히지 않게 항목마다 자료 기준일을 붙인다.
  const age = noteAge(n.as_of);
  return el('li', { class: 'mt-note' + (alert ? ' alert' : '') + (age.stale ? ' stale' : '') },
    el('div', { class: 'mt-note-head' },
      el('span', { class: 'mt-note-topic' }, n.topic),
      showRoute && n.route ? el('span', { class: 'mt-note-route' }, n.route) : null,
      el('span', { class: 'mt-note-level' + (lv[2] ? ' ok' : ''), title: lv[1] }, lv[0]),
      el('span', { class: 'mt-note-date', title: '자료가 가리키는 시점(산행·공지 날짜)' }, age.text),
      age.stale ? el('span', { class: 'mt-note-stale' }, '현재 상태 미확인') : null),
    el('p', { class: 'mt-note-text' }, n.text),
    n.sources?.length ? el('p', { class: 'mt-note-src' }, '출처 ',
      ...n.sources.slice(0, 4).flatMap((u, i) => [i ? ' · ' : '',
        el('a', { href: u, target: '_blank', rel: 'noopener nofollow', title: u }, hostOf(u))])) : null);
}

function section(title, ...children) {
  return el('section', { class: 'mt-sec' }, el('h3', { class: 'mt-sec-h' }, title), ...children);
}
function disclosure(title, ...children) {
  return el('details', { class: 'mt-details' }, el('summary', {}, title), el('div', { class: 'mt-details-body' }, ...children));
}

/**
 * @param {object} m 산
 * @param {Promise<object|null>} reviewsPromise reviewsFor(m.id)
 * @returns {{root:HTMLElement, fieldNotes:HTMLElement}}
 */
export function buildInfo(m, reviewsPromise) {
  const root = el('div', { class: 'mt-info' });

  // 교통·주차
  if (m.transport) root.append(section('교통·주차', el('p', { class: 'mt-prose' }, m.transport),
    el('p', { class: 'mt-fine' }, '주차장 운영·대중교통 시간표는 공식 안내에서 다시 확인하세요.')));

  // 현장 정보(교차검증 후기) — 자료가 오면 채운다.
  const notesList = el('ul', { class: 'mt-notes' });
  const notesFoot = el('p', { class: 'mt-fine' });
  const fieldNotes = section('현장 정보',
    el('p', { class: 'mt-fine mt-sec-desc' }, '공개 산행기·공지에서 확인한 사실을 항목별로 정리했습니다(원문 인용 아님).'),
    notesList, notesFoot);
  fieldNotes.id = `mt-notes-${m.id}`;
  fieldNotes.hidden = true;
  root.append(fieldNotes);
  reviewsPromise.then((entry) => {
    const notes = entry?.notes || [];
    if (!notes.length) return;
    notesList.append(...sortNotes(notes).map((n) => noteItem(n)));
    notesFoot.textContent = `${entry.collected_at} 수집 · ${notes.length}건 중 교차검증 ${entry.verified ?? notes.filter((n) => n.verify?.level === 'verified').length}건 · 2년이 지났거나 기준일이 없는 자료는 '현재 상태 미확인'으로 적었습니다.`;
    fieldNotes.hidden = false;
  }).catch(() => {});

  // 개요·추천 계절
  root.append(section('개요',
    m.summary ? el('p', { class: 'mt-prose' }, m.summary) : el('p', { class: 'mt-prose muted' }, '개요 자료를 준비 중입니다.'),
    el('dl', { class: 'mt-facts' },
      m.location ? [el('dt', {}, '위치'), el('dd', {}, m.location)] : null,
      m.best_season ? [el('dt', {}, '추천 계절'), el('dd', {}, m.best_season)] : null,
      el('dt', {}, '해발'), el('dd', { class: 'tabular' }, `${m.elevation_m.toLocaleString('ko-KR')}m`))));

  // 특징 태그 — 누르면 그 단어로 목록 검색
  if (m.features?.length) root.append(section('특징',
    el('div', { class: 'mt-tags' }, ...m.features.map((f) => el('button', {
      type: 'button', class: 'chip small', 'aria-label': `‘${f}’로 산 찾기`,
      onClick: () => navigate(`#/map?q=${encodeURIComponent(f)}`),
    }, f)))));

  // 목록 근거(접힘)
  const listItems = LIST_KEYS.filter((k) => m.lists?.[k]).map((k) => {
    if (k === 'hansanha' && m.hansanha_rank) return el('li', {}, `${LIST_META[k].full} ${m.hansanha_rank}위`, el('span', { class: 'mt-fine-inline' }, ' (koreasanha.net 접속순위, 2003–2004년 집계 아카이브)'));
    if (k === 'wolgansan' && m.wolgansan_criteria) return el('li', {}, `${LIST_META[k].full} · 선정기준 ${m.wolgansan_criteria.count}개 부문`,
      el('span', { class: 'mt-fine-inline' }, ` (${m.wolgansan_criteria.groups.join(' · ')})`));
    return el('li', {}, LIST_META[k].full);
  });
  root.append(disclosure('목록 근거',
    el('ul', { class: 'mt-list' }, ...listItems),
    m.wolgansan_criteria ? el('p', { class: 'mt-fine' },
      '월간산 「한국의 100대 명산」(2018)은 공식 순위·점수를 발표하지 않았습니다. 위 부문은 월간산이 제시한 5대·11개 세부 선정기준 표에서 이 산이 직접 언급된 항목을 재집계한 것으로, 월간산 자체 집계(연봉 포함)와 다를 수 있습니다.') : null));

  // 출처(접힘)
  if (m.sources?.length) root.append(disclosure(`출처 ${m.sources.length}`,
    el('ul', { class: 'mt-list mt-sources' }, ...m.sources.map((s) => el('li', {},
      el('a', { href: s, target: '_blank', rel: 'noopener' }, safeDecode(s), el('span', { class: 'mt-ext', html: icon('external', { size: 14 }) })))))));

  // 안내
  root.append(section('안내',
    el('p', { class: 'mt-fine' },
      '이 문서는 산림청 100대 명산·블랙야크 명산100·한국의산하 인기명산 100·월간산 100대 명산 공개 목록과 웹 조사를 바탕으로 자동 정리했습니다. '
      + '산행 전에는 국립공원·지자체의 최신 탐방로·통제 정보를 반드시 확인하세요. '
      + '지도의 등산로 선은 OpenStreetMap 자료이며, 계산 경로는 실측 기록이 아닙니다.'),
    m.coord_confidence && m.coord_confidence !== 'high'
      ? el('p', { class: 'mt-fine' }, `정상 좌표는 근사값일 수 있습니다(신뢰도: ${m.coord_confidence === 'medium' ? '중간' : m.coord_confidence === 'low' ? '낮음' : m.coord_confidence}).`)
      : null,
    m.coord_source ? el('p', { class: 'mt-fine' }, `좌표 출처: ${m.coord_source}`) : null));

  return { root, fieldNotes };
}

function safeDecode(u) { try { return decodeURI(u); } catch { return u; } }
