// 현재 위치 공유 모듈.
// 여러 화면(홈 "내 주변", 지도 "가까운 순", 상세 거리 표시)이 같은 위치를 쓰도록
// 마지막 측정값을 메모리+localStorage에 캐시한다. 권한 요청은 사용자가 명시적으로
// 누를 때만 발생하고, 캐시가 있으면 즉시 거리를 보여준 뒤 백그라운드로 갱신하지 않는다.

import { haversine } from './gpx.js';

const KEY = 'kr100:pos';            // { lat, lng, accuracy, ts }
export const FRESH_MS = 10 * 60 * 1000;   // 10분 이내면 "방금 측정" 취급
export const STALE_MS = 24 * 60 * 60 * 1000; // 24시간 넘으면 캐시 폐기
const PERSIST_MS = 15000;           // 실시간 추적 중 localStorage 쓰기 최소 간격
const EMIT_MOVE_M = 25;             // 이만큼 움직여야 구독자에게 알린다

let mem;                            // undefined = 아직 localStorage를 읽지 않음
let lastWriteTs = 0, lastEmit = null;
const listeners = new Set();

/** 위치가 갱신/삭제될 때마다 호출. 반환값을 호출하면 구독 해제. */
export function onPositionChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { listeners.forEach((fn) => { try { fn(mem || null); } catch (e) { console.error(e); } }); }

/** 캐시된 마지막 위치 (없거나 24시간 초과면 null). */
export function cachedPosition() {
  if (mem === undefined) {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY));
      mem = raw && Number.isFinite(raw.lat) && Number.isFinite(raw.lng) ? raw : null;
    } catch { mem = null; }
  }
  if (mem && Date.now() - mem.ts > STALE_MS) { mem = null; try { localStorage.removeItem(KEY); } catch {} }
  return mem;
}

function store(p) {
  mem = { lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null, ts: Date.now() };
  try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch {}
  lastEmit = mem; lastWriteTs = mem.ts;   // 스로틀 기준점도 함께 갱신
  emit();
  return mem;
}

/**
 * 실시간 추적(watchPosition) 중에도 캐시를 최신으로 유지하기 위해 호출.
 * 추적은 초당 한 번꼴로 콜백하므로(geo.js의 maximumAge=1500) 매번 저장·통지하면
 * localStorage 동기 쓰기와 재렌더가 계속 쌓인다. 25m 이상 움직였을 때만 알리고,
 * 저장은 그 밖에도 15초에 한 번은 해 둔다(탭이 갑자기 닫혀도 위치가 남도록).
 */
export function notePosition(p) {
  if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
  const next = { lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null, ts: Date.now() };
  mem = next;                                   // 메모리 캐시는 항상 최신
  const moved = !lastEmit || haversine(lastEmit.lat, lastEmit.lng, next.lat, next.lng) >= EMIT_MOVE_M;
  if (moved || next.ts - lastWriteTs >= PERSIST_MS) {
    lastWriteTs = next.ts;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  }
  if (moved) { lastEmit = next; emit(); }
  return next;
}

export function clearPosition() {
  mem = null;
  try { localStorage.removeItem(KEY); } catch {}
  emit();
}

/** 위치 기능 자체를 쓸 수 있는 환경인지(HTTPS 또는 localhost + Geolocation 지원). */
export function geoAvailable() {
  return !!navigator.geolocation && (window.isSecureContext !== false);
}

/** 권한 상태: 'granted' | 'prompt' | 'denied' | 'unknown' (미지원 브라우저). */
export async function permissionState() {
  try {
    if (!navigator.permissions?.query) return 'unknown';
    const s = await navigator.permissions.query({ name: 'geolocation' });
    return s.state;
  } catch { return 'unknown'; }
}

/**
 * 현재 위치를 한 번 측정한다.
 * @param {{maxAgeMs?:number, timeout?:number, highAccuracy?:boolean}} opts
 *   maxAgeMs 이내의 캐시가 있으면 측정 없이 그대로 돌려준다(기본 0 = 항상 새로 측정).
 * @returns {Promise<{lat,lng,accuracy,ts}>} 실패 시 GeoError를 throw.
 */
export function requestPosition(opts = {}) {
  const { maxAgeMs = 0, timeout = 12000, highAccuracy = false } = opts;
  const c = cachedPosition();
  if (c && maxAgeMs > 0 && Date.now() - c.ts <= maxAgeMs) return Promise.resolve(c);
  if (!navigator.geolocation) return Promise.reject(geoError({ code: 0 }));
  if (window.isSecureContext === false) return Promise.reject(geoError({ code: -1 }));
  // 브라우저 자체 캐시도 요청한 허용 나이에 맞춘다.
  // (maxAgeMs=0 "강제 재측정"인데 maximumAge를 남겨두면 브라우저가 옛 위치를 그대로 돌려준다)
  const maximumAge = Math.min(maxAgeMs, 60000);
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(store({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy })),
      (err) => reject(geoError(err)),
      { enableHighAccuracy: highAccuracy, maximumAge, timeout },
    );
  });
}

// 브라우저 오류 코드 → 사람이 읽는 한국어 메시지.
function geoError(err) {
  const code = err?.code;
  const msg =
    code === -1 ? '보안 연결(HTTPS)에서만 위치를 사용할 수 있습니다.'
    : code === 1 ? '위치 권한이 거부되었습니다. 브라우저 주소창의 자물쇠 아이콘에서 위치 권한을 허용해 주세요.'
    : code === 2 ? '위치를 확인할 수 없습니다. GPS·네트워크 상태를 확인해 주세요.'
    : code === 3 ? '위치 확인이 오래 걸립니다. 잠시 후 다시 시도해 주세요.'
    : '이 브라우저에서는 위치 기능을 사용할 수 없습니다.';
  const e = new Error(msg);
  e.code = code ?? 0;
  e.denied = code === 1;
  return e;
}

/** 캐시 시각 → "방금 전 / 12분 전 / 3시간 전" */
export function positionAgeText(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return '방금 전';
  const min = Math.round(s / 60);
  if (min < 60) return `${min}분 전`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}

/** 위치에서 산 정상까지 직선거리(m). 좌표가 없으면 Infinity(정렬 시 항상 뒤로). */
export function distanceTo(pos, lat, lon) {
  if (!pos || lat == null || lon == null) return Infinity;
  return haversine(pos.lat, pos.lng, lat, lon);
}

const DIRS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
/** 위치 기준 방위(8방위 한글). */
export function bearingLabel(pos, lat, lon) {
  if (!pos || lat == null || lon == null) return '';
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(pos.lat), φ2 = toRad(lat), Δλ = toRad(lon - pos.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return DIRS[Math.round(deg / 45) % 8];
}

/** 산 목록을 현재 위치에서 가까운 순으로 정렬해 [{ m, dist }] 배열로 돌려준다. */
export function sortByDistance(mountains, pos) {
  return mountains
    .map((m) => ({ m, dist: distanceTo(pos, m.lat, m.lon) }))
    .sort((a, b) => {
      // 좌표 없는 산끼리는 둘 다 Infinity라 뺄셈이 NaN이 된다 → 비교 연산으로 처리
      if (a.dist !== b.dist) return a.dist < b.dist ? -1 : 1;
      return a.m.name.localeCompare(b.m.name, 'ko');   // 동률은 이름순 → 재렌더해도 순서 고정
    });
}
