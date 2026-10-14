// 탐방 후기·현장 정보 데이터 — 산 시트 정보 탭(src/mountain/info.js)이 그린다.
//
// 가벼운 목록 data/reviews/index.json → 산별 상세 data/reviews/<산id>.json 순으로 받는다.
// 항목은 원문 후기를 그대로 옮긴 것이 아니라 공개 문서에서 확인된 사실을 정리한 요약이며,
// 출처 URL을 함께 보여 준다.

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
