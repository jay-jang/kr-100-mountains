// 수집해 둔 코스별 경로 GPX 목록(데이터 접근).
// 가벼운 목록 gpx/routes/index.json → 산별 상세 gpx/routes/m/<산id>.json 순으로 받는다.
//
// 이 파일들은 실측 GPS 기록이 아니라 OSM 등산로망 위에서 계산한 경로다. 화면은 이것을
// "계산 경로"(점선)로만 그린다 — src/mountain/model.js 참고.

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (ct.includes('html') || text.trimStart().startsWith('<!')) return null; // dev 서버 200 폴백
  return JSON.parse(text);
}

let _index;
let _indexLoading;
export async function routesManifest() {
  if (_index !== undefined) return _index;
  if (!_indexLoading) _indexLoading = getJSON(`${import.meta.env.BASE_URL}gpx/routes/index.json`).then(value => {
    if (!value) throw new Error('수록 경로 목록을 불러오지 못했습니다.');
    _index = value; return value;
  }).finally(() => { _indexLoading = null; });
  return _indexLoading;
}

const _entries = new Map();
const _entryLoading = new Map();
export async function routeEntryFor(mountainId) {
  if (_entries.has(mountainId)) return _entries.get(mountainId);
  if (!_entryLoading.has(mountainId)) {
    const job = (async () => {
      const index = await routesManifest();
      // 목록에 없는 산은 아예 요청하지 않는다 — 404 콘솔 오류를 내지 않기 위해.
      const listed = index?.mountains?.find((e) => e.mountain_id === mountainId);
      let entry = null;
      if (listed && (listed.tracks || listed.relations)) {
        entry = await getJSON(`${import.meta.env.BASE_URL}gpx/routes/m/${mountainId}.json`);
        if (!entry) throw new Error('산의 수록 경로를 불러오지 못했습니다. 다시 시도하세요.');
      }
      _entries.set(mountainId, entry); return entry;
    })().finally(() => { _entryLoading.delete(mountainId); });
    _entryLoading.set(mountainId, job);
  }
  return _entryLoading.get(mountainId);
}

export function routePayloads(entry) {
  return [...new Map([
    ...(entry?.tracks || []).map(t => ({ ...t, label: (t.route_name || `코스 ${t.route_index}`) + (t.variant ? ` (대안 ${t.variant})` : '') })),
    ...(entry?.relations || []).map(r => ({ ...r, label: r.name })),
  ].map(t => [t.file, t])).values()];
}
