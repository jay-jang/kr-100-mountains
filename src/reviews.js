// 탐방 후기·현장 정보 — 상세 페이지 섹션.
//
// 가벼운 목록 data/reviews/index.json → 산별 상세 data/reviews/<산id>.json 순으로 받는다.
// 항목은 원문 후기를 그대로 옮긴 것이 아니라 공개 문서에서 확인된 사실을 정리한 요약이며,
// 출처 URL을 함께 보여 준다. 교차검증 등급(✓✓ / ✓)도 그대로 노출한다.
import { el } from './dom.js';

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (ct.includes('html') || text.trimStart().startsWith('<!')) return null;  // dev 서버 200 폴백
  return JSON.parse(text);
}

let _index;
export async function reviewsIndex() {
  if (_index !== undefined) return _index;
  try { _index = await getJSON(`${import.meta.env.BASE_URL}data/reviews/index.json`); }
  catch { _index = null; }
  return _index;
}

const _entries = new Map();
export async function reviewsFor(mountainId) {
  if (_entries.has(mountainId)) return _entries.get(mountainId);
  const index = await reviewsIndex();
  // 목록에 없는 산은 아예 요청하지 않는다 — 404 콘솔 오류를 내지 않기 위해.
  const listed = index?.mountains?.find((e) => e.id === mountainId);
  let entry = null;
  if (listed?.notes) {
    try { entry = await getJSON(`${import.meta.env.BASE_URL}data/reviews/${mountainId}.json`); }
    catch { entry = null; }
  }
  _entries.set(mountainId, entry);
  return entry;
}

// 주의 톤은 sentiment가 아니라 topic으로만 정한다. 조사 결과의 sentiment는
// 주차 대수·화장실 위치 같은 단순 정보에도 caution이 붙는 편차가 커서(실측),
// 그대로 쓰면 화면이 온통 경고색이 되어 진짜 위험 항목이 묻힌다.
const ALERT_TOPICS = new Set(['위험구간', '통제·예약']);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

const LEVEL = {
  verified: { text: '✓✓ 교차검증', title: '독립적인 두 조사가 모두 웹 근거로 확인한 항목', ok: true },
  single: { text: '✓ 단일확인', title: '한 조사만 웹 근거로 확인한 항목', ok: false },
  unverified: { text: '· 미검증', title: '수집만 되고 검증 라운드를 거치지 못한 항목', ok: false },
};

function noteRow(n) {
  const alert = ALERT_TOPICS.has(n.topic);
  const lv = LEVEL[n.verify?.level] || LEVEL.unverified;
  return el('li', { class: 'rv-item' + (alert ? ' alert' : '') },
    el('div', { class: 'rv-head' },
      el('span', { class: 'rv-topic' }, n.topic),
      n.route ? el('span', { class: 'rv-route' }, n.route) : null,
      el('span', { class: 'rv-badge' + (lv.ok ? ' ok' : ''), title: lv.title }, lv.text),
      n.as_of ? el('span', { class: 'rv-asof' }, n.as_of) : null),
    el('p', { class: 'rv-text' }, n.text),
    el('div', { class: 'rv-src' },
      el('span', {}, '출처'),
      ...(n.sources || []).slice(0, 4).map((u, i) =>
        el('a', { href: u, target: '_blank', rel: 'noopener nofollow', title: u }, `${i + 1}. ${hostOf(u)}`))));
}

/**
 * 섹션 요소를 즉시 반환하고 자료가 오면 채운다. 수집된 항목이 없으면 통째로 감춘다.
 */
export function reviewSection(mountainId) {
  const list = el('ul', { class: 'rv-list' });
  const foot = el('p', { class: 'conf-note', style: 'margin-top:10px' });
  const section = el('div', { class: 'section', hidden: true },
    el('h3', {}, '탐방 후기 · 현장 정보'),
    el('p', { class: 'conf-note', style: 'margin:-4px 0 12px' },
      '원문 후기를 그대로 옮긴 것이 아닙니다. 공개된 산행기·후기·공식 공지에서 확인된 사실만 항목으로 정리했고, '
      + '항목마다 출처를 달았습니다. 독립적인 두 조사가 각자 모은 뒤 서로의 주장을 웹 근거로 다시 검증해, '
      + '반박된 항목은 싣지 않습니다.'),
    list, foot);

  reviewsFor(mountainId).then((entry) => {
    const notes = entry?.notes || [];
    if (!notes.length) return;
    list.append(...notes.map(noteRow));
    foot.textContent = `${entry.collected_at} 수집 · 항목 ${notes.length}건 중 교차검증 ${entry.verified}건`
      + ' · 현장 상황은 바뀔 수 있으니 산행 전 공식 안내를 확인하세요.';
    section.hidden = false;
  });

  return section;
}
