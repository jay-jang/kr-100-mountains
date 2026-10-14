// 주변 하이킹·트레킹(걷기길) 데이터 접근 — 빌드 때 구운 정적 JSON만 읽는다(실시간 Overpass 없음).
//
// 파일 계약 (scripts/collect-trekking.mjs가 만든다):
//   data/trekking/index.json           { mountains: { <산id>: { count, kinds:{kind:n}, names:[…] } } }
//   data/trekking/m/<산id>.json         { routes:[{ rid, name, kind, long, loop, length_km, declared_km, partial,
//                                          dist_km, anchor, entry, bbox, lines, links, osm_ids }], radius_km, … }
//   data/trekking/walks-index.json     [{ rid, name, kind, long, loop, km, total_km, near:[{id,km}], bbox:[s,w,n,e] }]
//   data/trekking/tiles/<lat>_<lon>.json  1°격자 거친 선 { routes:[{ rid, kind, long, lines }] }
//   data/trekking/w/<rid>.json         노선 하나 { rid, name, kind, long, loop, km, total_km, partial, lines,
//                                          near, links, tags, attribution, note,
//                                          (추가) declared_km, source:'relation'|'named-ways', osm_ids, start, end,
//                                          bbox, series, siblings:[{rid,name,kind,long,km}] }
//   data/trekking/alias.json           { <산별 rid>: <전국 rid> | 'm:<산id>' }  (전국 상세가 다른 rid이거나 없을 때)
//   산별 노선의 추가 필드: anchor('summit'|'trailhead'), near_summit, loop, long, total_km
// 파일이 없으면 빈 값으로 조용히 넘어간다(데이터가 아직 없는 배포에서도 앱이 동작해야 한다).
const BASE = `${import.meta.env.BASE_URL}data/trekking/`;

export const KIND_LABEL = {
  dulle: '둘레길·걷기길',
  forest: '숲길·산책로',
  ridge: '능선 종주',
  trail: '등산 코스',
  other: '걷기길',
};
export const KIND_SHORT = { dulle: '둘레길', forest: '숲길', ridge: '마루금', trail: '탐방로', other: '걷기길' };

/** 종류별 선 모양. 색만으로 구분하지 않도록 굵기·투명도도 다르게 한다(목록엔 글자 라벨이 함께 붙는다). */
export function kindStyle(kind, { long = false, dark = false, selected = false } = {}) {
  const L = dark
    ? { dulle: '#4fb3ab', long: '#7fa8e0', ridge: '#c49a6c', forest: '#6cc4b5', trail: '#8cc47f', other: '#a7b0a5' }
    : { dulle: '#1f7a74', long: '#2c5d9e', ridge: '#6b4e2e', forest: '#2f8a7e', trail: '#3f7d3a', other: '#6b736a' };
  const color = kind === 'dulle' && long ? L.long : (L[kind] || L.other);
  const base = { dulle: 4, ridge: 5, forest: 3, trail: 3, other: 2.5 }[kind] || 3;
  return {
    color,
    weight: selected ? base + 2 : base,
    opacity: selected ? 1 : kind === 'forest' || kind === 'other' ? 0.7 : 0.85,
    dash: kind === 'ridge' ? null : null,
  };
}
export function kindLabel(w) {
  if (w.kind === 'dulle' && w.long) return '장거리 걷기길';
  return KIND_LABEL[w.kind] || '걷기길';
}

const cache = new Map();
async function getJSON(path) {
  if (cache.has(path)) return cache.get(path);
  const job = (async () => {
    try {
      const res = await fetch(BASE + path);
      if (!res.ok) return null;
      const ct = res.headers.get('content-type') || '';
      const text = await res.text();
      if (ct.includes('html') || text.trimStart().startsWith('<')) return null;   // 개발 서버 200 폴백
      return JSON.parse(text);
    } catch { return null; }
  })();
  cache.set(path, job);
  const v = await job;
  if (v == null) cache.delete(path);   // 실패는 캐시하지 않는다(다음에 다시 시도)
  return v;
}

export async function loadTrekIndex() { return (await getJSON('index.json'))?.mountains || {}; }

/** 산 주변 노선. 각 노선에 rid·kind·dist_km·lines가 있다. */
export async function loadMountainWalks(id) {
  const v = await getJSON(`m/${encodeURIComponent(id)}.json`);
  return v ? { ...v, routes: v.routes || [] } : { routes: [], radius_km: null };
}

/** 전국 노선 목록(검색·걷기길 모드). */
export async function loadWalkIndex() {
  const v = await getJSON('walks-index.json');
  return Array.isArray(v) ? v : (v?.walks || []);
}

export async function loadWalk(rid) { return getJSON(`w/${encodeURIComponent(rid)}.json`); }

/**
 * 산별 파일의 rid → 전국 상세 rid 연결표(data/trekking/alias.json, scripts/build-walks.mjs가 만든다).
 * 값이 'm:<산id>'이면 전국 상세가 없고 그 산 파일에만 있는 노선이다. 없으면 {}.
 */
export async function loadWalkAlias() { return (await getJSON('alias.json')) || {}; }

// 타일이 있는 격자 범위 — scripts/build-walks.mjs가 남한 범위(위도 33~38°, 경도 124~130°의 1° 칸)는
// 노선이 없어도 빈 타일을 꼭 써 둔다. 그 밖(바다·북한·일본)은 파일이 없으니 요청하지 않는다(404를 내지 않게).
const TILE_LAT = [33, 38], TILE_LON = [124, 130];

/** 보이는 범위의 1° 격자 타일을 받아 노선을 rid로 합친다. 범위가 너무 넓으면 빈 배열. */
export async function loadWalkTiles({ south, west, north, east }, { maxTiles = 9 } = {}) {
  if (![south, west, north, east].every(Number.isFinite)) return [];
  const tiles = [];
  // 타일 수 제한은 자르기 전 범위로 센다(넓은 범위를 잘라서 몇 칸만 받는 일이 없게).
  if ((Math.floor(north) - Math.floor(south) + 1) * (Math.floor(east) - Math.floor(west) + 1) > maxTiles) return [];
  const la0 = Math.max(TILE_LAT[0], Math.floor(south)), la1 = Math.min(TILE_LAT[1], Math.floor(north));
  const lo0 = Math.max(TILE_LON[0], Math.floor(west)), lo1 = Math.min(TILE_LON[1], Math.floor(east));
  for (let la = la0; la <= la1; la++)
    for (let lo = lo0; lo <= lo1; lo++) tiles.push(`${la}_${lo}`);
  if (!tiles.length) return [];
  const results = await Promise.all(tiles.map((t) => getJSON(`tiles/${t}.json`)));
  const byRid = new Map();
  for (const r of results) for (const w of r?.routes || []) {
    const prev = byRid.get(w.rid);
    if (prev) prev.lines = prev.lines.concat(w.lines);   // 타일 경계에서 잘린 조각 합치기
    else byRid.set(w.rid, { ...w, lines: [...w.lines] });
  }
  return [...byRid.values()];
}

/** 선 묶음의 경계상자 [[s,w],[n,e]]. */
export function linesBounds(lines) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const line of lines || []) for (const [la, lo] of line) {
    if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo;
  }
  return s <= n ? [[s, w], [n, e]] : null;
}

/** 표시 구간 GPX(1.1) 문자열. 실측 기록이 아님을 desc에 적는다. */
export function walkGpx(w) {
  const escx = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const segs = (w.lines || []).map((line) => `<trkseg>${line.map(([la, lo]) => `<trkpt lat="${la}" lon="${lo}"/>`).join('')}</trkseg>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="kr-100-mountains" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${escx(w.name)}</name><desc>OpenStreetMap 노선(© OpenStreetMap contributors, ODbL)을 단순화한 선입니다. 실측 기록이 아니며 운영·통제 상태를 반영하지 않습니다.${w.partial ? ' 전체 노선 중 일부 구간만 담았습니다.' : ''}</desc></metadata>
<trk><name>${escx(w.name)}</name>${segs}</trk>
</gpx>`;
}
