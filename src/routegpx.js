// 수집해 둔 코스별 경로 GPX 목록 — 상세 페이지의 내려받기 섹션.
// 가벼운 목록 gpx/routes/index.json → 산별 상세 gpx/routes/m/<산id>.json 순으로 받는다.
//
// 이 파일들은 **실측 GPS 기록이 아니다.** OSM 등산로망 위에서 계산한 경로이므로
// 지도에 자동으로 그리지 않고, 성격을 밝힌 채 내려받기만 제공한다.
// (지도에 그리는 것은 종전대로 실측 GPX와 사용자가 올린 GPX만.)
import { el } from './dom.js';
import { fmtDist } from './geo.js';

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (ct.includes('html') || text.trimStart().startsWith('<!')) return null;  // dev 서버 200 폴백
  return JSON.parse(text);
}

// 가벼운 목록(어느 산에 수록이 있는지)만 먼저 받고, 상세는 산별 파일로 따로 받는다.
// 전체를 한 파일에 담으면 149산 기준 590KB라 산 하나 보려고 전부 받게 된다.
let _index;
export async function routesManifest() {
  if (_index !== undefined) return _index;
  try { _index = await getJSON(`${import.meta.env.BASE_URL}gpx/routes/index.json`); }
  catch { _index = null; }
  return _index;
}

const _entries = new Map();
export async function routeEntryFor(mountainId) {
  if (_entries.has(mountainId)) return _entries.get(mountainId);
  const index = await routesManifest();
  // 목록에 없는 산은 아예 요청하지 않는다 — 404 콘솔 오류를 내지 않기 위해.
  const listed = index?.mountains?.find((e) => e.mountain_id === mountainId);
  let entry = null;
  if (listed && (listed.tracks || listed.relations)) {
    try { entry = await getJSON(`${import.meta.env.BASE_URL}gpx/routes/m/${mountainId}.json`); }
    catch { entry = null; }
  }
  _entries.set(mountainId, entry);
  return entry;
}

const km = (v) => (v == null ? null : `${v.toFixed(1)}km`);

function trackRow(t, base) {
  const meta = [
    km(t.distance_km),
    t.gain_m != null ? `↑${t.gain_m}m` : null,
    t.registry_distance_km != null ? `자료 ${t.registry_distance_km}km` : null,
  ].filter(Boolean).join(' · ');
  const warn = (t.warnings || []).join(' / ');
  return el('a', {
    class: 'gpxdl-item' + (t.status === 'review' ? ' review' : ''),
    href: `${base}gpx/${t.file}`,
    download: t.file.split('/').pop(),
    title: warn || '내려받기',
  },
    // 산 페이지 안이므로 산 이름은 빼고 코스명만 — 파일 안 <name>에는 산 이름이 들어 있다.
    el('span', { class: 'gpxdl-name' }, (t.route_name || `코스 ${t.route_index}`) + (t.variant ? ` (대안 ${t.variant})` : '')),
    el('span', { class: 'gpxdl-meta' }, meta),
    t.status === 'review' ? el('span', { class: 'gpxdl-badge' }, '검토 필요') : null,
    t.duplicate_of ? el('span', { class: 'gpxdl-badge dup' }, '동일 경로') : null,
    el('span', { class: 'gpxdl-arrow', 'aria-hidden': 'true' }, '⬇'));
}

/**
 * 내려받기 섹션 요소를 즉시 반환하고, 매니페스트가 오면 채운다.
 * 수록된 경로가 없으면 섹션을 통째로 감춘다.
 */
export function routeDownloadSection(mountainId) {
  const list = el('div', { class: 'gpxdl-list' });
  const section = el('div', { class: 'section', hidden: true },
    el('h3', {}, '코스별 경로 GPX 내려받기'),
    el('p', { class: 'conf-note', style: 'margin:-4px 0 10px' },
      '실측 GPS 기록이 아닙니다. 등록된 들머리에서 정상까지를 OpenStreetMap 등산로망 위에서 계산한 경로이며, '
      + '현장 통제·계절 통제·출입 제한을 반영하지 않을 수 있으니 산행 전 공식 안내를 함께 확인하세요.'),
    list);

  routeEntryFor(mountainId).then((entry) => {
    if (!entry) return;
    const tracks = entry.tracks || [];
    const rels = entry.relations || [];
    if (!tracks.length && !rels.length) return;
    const base = import.meta.env.BASE_URL;

    if (tracks.length) list.append(...tracks.map((t) => trackRow(t, base)));
    if (rels.length) {
      list.append(el('div', { class: 'gpxdl-sub' }, 'OpenStreetMap에 등록된 도보 경로(둘레길·순환길 등)'));
      list.append(...rels.map((r) => el('a', {
        class: 'gpxdl-item rel', href: `${base}gpx/${r.file}`,
        download: r.file.split('/').pop(), title: '내려받기',
      },
        el('span', { class: 'gpxdl-name' }, r.name),
        el('span', { class: 'gpxdl-meta' }, [km(r.distance_km), r.summit_dist_m != null ? `정상에서 ${fmtDist(r.summit_dist_m)}` : null].filter(Boolean).join(' · ')),
        el('span', { class: 'gpxdl-arrow', 'aria-hidden': 'true' }, '⬇'))));
    }
    section.append(el('p', { class: 'conf-note', style: 'margin-top:10px' },
      '선형 © OpenStreetMap contributors (ODbL 1.0) · 고도 SRTM 1 arc-second(NASA/USGS) 지형 DEM 추정값'));
    section.hidden = false;
  });

  return section;
}
