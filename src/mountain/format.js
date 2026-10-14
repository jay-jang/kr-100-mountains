// 산·경로 시트 공용 문구와 숫자 형식.
// 정직성 표시는 고정 문구만 쓴다(spec-final 11장): 검증 수준 · 선 상태 · 코스 근거.
import { el } from '../dom.js';
import { LIST_KEYS } from '../data.js';

/** 13.5 → "13시간 30분", 0.5 → "30분". */
export function fmtHours(h) {
  const v = Number(h);
  if (!Number.isFinite(v) || v <= 0) return '';
  const total = Math.round(v * 60);
  const hh = Math.floor(total / 60), mm = total % 60;
  if (!hh) return `${mm}분`;
  return mm ? `${hh}시간 ${mm}분` : `${hh}시간`;
}
export function fmtMin(min) { return fmtHours(Number(min) / 60); }

/** 5 → "5km", 9.24 → "9.2km", 0.6 → "0.6km". */
export function fmtKm(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${n >= 10 ? n.toFixed(1).replace(/\.0$/, '') : (Math.round(n * 10) / 10).toString()}km`;
}

export const fmtElev = (m) => `${Math.round(m).toLocaleString('ko-KR')}m`;

// 난이도 색 — 국립공원공단 탐방로 등급지도 범례(base.css --d1..--d5). 반드시 글자와 함께 쓴다.
const DIFF_TOKEN = { '매우 쉬움': '--d1', 쉬움: '--d2', 보통: '--d3', 어려움: '--d4', '매우 어려움': '--d5' };
export function diffMark(difficulty) {
  if (!difficulty) return null;
  const token = DIFF_TOKEN[difficulty];
  return el('span', { class: 'mt-diff' },
    token ? el('span', { class: 'mt-diff-mark', style: `--c: var(${token})`, 'aria-hidden': 'true' }) : null,
    difficulty);
}

const VERIFY = {
  verified: ['교차검증 일치', '독립된 자료 셋의 난이도가 일치합니다.', 'ok'],
  mixed: ['자료 간 이견', '자료마다 난이도 판정이 다릅니다.', 'mixed'],
  single: ['단일 출처', '한 자료에서만 확인했습니다.', 'single'],
  unverified: ['단일 출처', '한 자료에서만 확인했습니다.', 'single'],
};
export function verifyInfo(v) { return v && VERIFY[v.level] ? { text: VERIFY[v.level][0], title: VERIFY[v.level][1], tone: VERIFY[v.level][2] } : null; }

/** 자료별 난이도 — "웹 조사 어려움 · 교차검증① 어려움 · 교차검증② 매우 어려움". */
export function verifyDetail(v) {
  const d = v?.difficulties || {};
  return [d.survey && `웹 조사 ${d.survey}`, d.crosscheck1 && `교차검증① ${d.crosscheck1}`, d.crosscheck2 && `교차검증② ${d.crosscheck2}`]
    .filter(Boolean).join(' · ');
}

/** 대표 코스 근거: 공단 안내 확인 / 공식 안내 확인(공단 외 기관) / 자료 선정. */
export function evidenceLabel(course) {
  if (!course) return '';
  if (course.evidence === 'official') {
    const publisher = course.sources?.[0]?.title || '';
    return publisher.startsWith('국립공원공단') ? '공단 안내 확인' : '공식 안내 확인';
  }
  return '자료 선정';
}

export const PROVENANCE = {
  recorded: { status: '수록 경로', note: '선 출처: 기증·실측 GPS 기록' },
  'osm-routed': { status: '계산 경로', note: '선 출처: OpenStreetMap 등산로망 위 계산 · 실측 기록 아님' },
  'osm-relation': { status: 'OpenStreetMap 노선', note: '선 출처: OpenStreetMap 노선 · 운영 상태 미확인' },
  'user-file': { status: '내 파일', note: '선 출처: 내 GPX 파일 · 이 기기에서만 표시' },
  planned: { status: '내 계획', note: '선 출처: 내가 만든 계획 · 실측 기록 아님' },
  live: { status: '계산 경로', note: '선 출처: OpenStreetMap 등산로망에서 방금 계산 · 실측 기록 아님' },
  none: { status: '지도 선 없음', note: '이 코스는 지도에 그릴 선 자료가 없습니다.' },
};

/** 헤더 둘째 줄: "강원 · 산림청·BAC·한국의산하 2위·월간산 5부문". */
export function listLine(m) {
  const parts = LIST_KEYS.filter((k) => m.lists?.[k]).map((k) => {
    if (k === 'sanlim') return '산림청';
    if (k === 'bac') return 'BAC';
    if (k === 'hansanha') return m.hansanha_rank ? `한국의산하 ${m.hansanha_rank}위` : '한국의산하';
    return m.wolgansan_criteria ? `월간산 ${m.wolgansan_criteria.count}부문` : '월간산';
  });
  return parts.join('·');
}

/** 외부 링크 주소의 짧은 이름. */
export function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u); } }

/** 사실 나열 "A · B · C" — 구분점은 앞 항목에 붙여 줄바꿈이 구분점으로 시작하지 않게 한다. */
export function dots(items) {
  const out = [];
  items.filter(Boolean).forEach((it, i) => { if (i) out.push(' · '); out.push(it); });
  return out;
}

/** 지도 라벨용 짧은 이름: 괄호 설명을 빼고 16자까지. */
export function shortLabel(s) {
  const t = String(s || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  return t.length > 16 ? t.slice(0, 15) + '…' : t;
}
