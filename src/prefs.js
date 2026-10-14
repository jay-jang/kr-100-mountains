// 표시 설정(기능 켜기·끄기). 기본값과 다른 항목만 localStorage에 저장한다.
// 토글은 기능의 "입구"만 숨긴다 — 링크로 들어온 내용은 설정과 무관하게 열린다.
// 꺼도 저장된 기록·계획은 지우지 않는다.
import { MAP_PROVIDER } from './map.js';

const KEY = 'kr100:prefs';
const THEME_KEY = 'kr100:theme';      // 기존 키 — 테마는 이 키를 그대로 쓴다(이전 사용자 설정 보존)
const MAPTYPE_KEY = 'kr100:maptype';  // 기존 키 — 지도 종류도 그대로

/** 설정 정의. 화면(설정 페이지)은 이 배열 순서대로 그린다. */
export const PREF_GROUPS = [
  { title: '지도', items: [
    { key: 'walkLines', label: '걷기길 선 표시', note: '지도를 확대하면 둘레길·숲길·마루금 선을 함께 그립니다.', def: true },
    { key: 'mountainNames', label: '산 이름 표시', note: '확대하면 산 기호 옆에 이름을 적습니다.', def: true },
    { key: 'regionColors', label: '권역별 색 구분', note: '산 기호를 권역 색(수도권·강원·충청·전라·경상·제주)으로 칠합니다.', def: false },
    { key: 'zoomButtons', label: '확대·축소 버튼', note: '두 손가락 확대가 어려울 때 쓰는 + − 버튼입니다.', def: true },
  ] },
  { title: '목록', items: [
    { key: 'recentMountains', label: '최근 본 산', note: '빈 검색창을 누르면 최근에 본 산을 제안합니다.', def: true },
    { key: 'recommendations', label: '추천 묶음', note: '목록 맨 위에 인기·계절·쉬운 코스 기준 추천을 보여 줍니다.', def: false },
    { key: 'courseCatalog', label: '대표 코스 모음', note: '149개 산의 대표·유명 코스 전체 목록으로 가는 입구를 보여 줍니다.', def: false },
  ] },
  { title: '경로 도구', items: [
    { key: 'compareRoutes', label: '여러 경로 겹쳐 보기', note: '코스 목록에 선택 상자가 생겨 여러 경로를 함께 그립니다.', def: false },
    { key: 'gpxImport', label: '내 GPX 파일 열기', note: '기기에 있는 GPX 파일을 지도에 올립니다.', def: false },
    { key: 'routePlanner', label: '경로 계획 만들기', note: '등산로를 이어 붙여 나만의 산행 경로와 GPX를 만듭니다.', def: false },
    { key: 'followRoute', label: '경로 따라가기', note: '선택한 경로 위 내 위치·남은 거리를 안내합니다. 화면이 켜져 있는 동안만 동작합니다.', def: false },
    { key: 'liveTrails', label: '등산로망 실시간 조회', note: '외부 서버(OpenStreetMap)에서 주변 등산로를 직접 불러옵니다. 수십 초 걸릴 수 있습니다.', def: false },
  ] },
];

const DEFS = Object.fromEntries(PREF_GROUPS.flatMap(g => g.items).map(i => [i.key, i.def]));
const listeners = new Set();

function readStored() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    // 버전 표식(v)과 지금은 없는 항목은 버린다.
    return Object.fromEntries(Object.entries(v).filter(([k]) => k in DEFS));
  } catch { return {}; }
}
let stored = readStored();
// 다른 탭에서 바꾼 설정도 반영한다.
window.addEventListener('storage', (e) => {
  if (e.key === KEY) { stored = readStored(); emit(); }
});

function emit(key) { listeners.forEach(fn => { try { fn(key); } catch (err) { console.error(err); } }); }

export function pref(key) {
  return key in stored ? stored[key] : DEFS[key];
}
export function prefDefault(key) { return DEFS[key]; }
export function isPrefChanged(key) { return key in stored; }

/** 저장 성공 여부를 돌려준다(사생활 보호 모드 등에서 실패하면 이번 세션에만 적용). */
export function setPref(key, value) {
  if (!(key in DEFS)) throw new Error(`알 수 없는 설정: ${key}`);
  if (value === DEFS[key]) delete stored[key]; else stored[key] = value;
  let saved = true;
  try {
    if (Object.keys(stored).length) localStorage.setItem(KEY, JSON.stringify({ ...stored, v: 1 }));
    else localStorage.removeItem(KEY);
  } catch { saved = false; }
  emit(key);
  return saved;
}
export function resetPrefs() {
  stored = {};
  try { localStorage.removeItem(KEY); } catch {}
  emit(null);
}
export function onPrefs(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** 마우스 같은 정밀 포인터가 있는 기기인지. */
export function hasFinePointer() {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/* ---- 테마 (시스템 / 밝게 / 어둡게) ---- */
export function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}
export function applyTheme(t = getTheme()) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}
export function setTheme(t) {
  try { if (t === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch {}
  applyTheme(t);
  window.dispatchEvent(new Event('kr100:theme'));
  emit('theme');
}
export function isDarkTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t) return t === 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/* ---- 기본 지도 종류 ----
   고르지 않았으면 공급자별 기본: 카카오 = 지형(가벼운 지형 오버레이), OSM = 일반(OpenTopoMap 타일은 느리고 사용량 제한이 있다). */
export const MAP_TYPES = [['default', '일반'], ['terrain', '지형'], ['satellite', '위성']];
export function defaultMapType() { return MAP_PROVIDER === 'kakao' ? 'terrain' : 'default'; }
export function getMapType() {
  try { const v = localStorage.getItem(MAPTYPE_KEY); return MAP_TYPES.some(([k]) => k === v) ? v : defaultMapType(); }
  catch { return defaultMapType(); }
}
export function setMapType(t) {
  try { if (t === defaultMapType()) localStorage.removeItem(MAPTYPE_KEY); else localStorage.setItem(MAPTYPE_KEY, t); } catch {}
  emit('mapType');
}
