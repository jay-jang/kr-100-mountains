// 산 하나의 코스 모델 — 코스 탭의 행과 경로 시트가 같은 자료를 쓴다.
//
// 행 키(?route=)
//   t:<i>    등산로 m.trails[i] (trail_index로 연결된 대표 코스를 같은 행에 붙인다)
//   c:<id>   trail_index가 없는 대표 코스
//   o:<id>   OpenStreetMap 등록 탐방로(정상 300m 안을 지나는 kind=trail 노선). 관계면 숫자 id, 아니면 rid(w…)
//   g:0      수록 GPX(gpx/<산id>.gpx)가 어느 등산로와도 맞지 않을 때
//   u:<n> · p:<n>  내 GPX 파일 · 내 계획(이 화면에서만)
//
// 선(provenance)은 파일 위치가 아니라 생성 방식으로 정한다.
//   recorded(gpx/<id>.gpx) > osm-routed accepted > osm-routed review("검토 필요") > 없음.
// 구운 계산 경로 목록(gpx/routes/m/<id>.json)의 track.route_index는 1부터 센다 → m.trails[route_index - 1].
// (2026-10-13 전체 자료 866건에서 route_name === trails[route_index-1].name 확인)
import { parseGPX, haversine } from '../gpx.js';
import { routeEntryFor } from '../routegpx.js';
import { loadMountainWalks, loadTrekIndex } from '../walkdata.js';

const BASE = import.meta.env.BASE_URL;
export const NEAR_SUMMIT_KM = 0.3;

/** 정상 근처를 지나는 OSM 탐방로(코스 탭에 들어가고 주변 길 탭에서는 빠진다). */
export function isSummitTrail(w) {
  return w.kind === 'trail' && Number(w.dist_km) <= NEAR_SUMMIT_KM && (!w.anchor || w.anchor === 'summit');
}

// ---------- 정적 파일 ----------
let curatedPromise = null;
/** 수록(실측·기증) GPX가 있는 산 id 목록. 목록에 없는 산은 요청하지 않는다(404 콘솔 오류 방지). */
function curatedIds() {
  if (!curatedPromise) curatedPromise = fetch(`${BASE}gpx/index.json`)
    .then(async (r) => {
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || ct.includes('html')) return new Set();
      const v = await r.json();
      return new Set(Array.isArray(v) ? v : Object.keys(v || {}));
    })
    .catch(() => new Set());
  return curatedPromise;
}

const trackCache = new Map();   // url → parsed track (성공한 것만)
const trackLoading = new Map(); // url → 받는 중인 Promise — 여러 행이 같은 파일을 쓰면 동시에 두 번 받지 않는다
/** GPX 파일을 받아 해석한다. 같은 파일은 한 번만 받는다. */
export async function loadTrack(url, { signal } = {}) {
  if (trackCache.has(url)) return trackCache.get(url);
  if (trackLoading.has(url)) return trackLoading.get(url);
  const job = (async () => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`경로 파일을 받지 못했습니다 (${res.status})`);
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (ct.includes('html') || text.trimStart().startsWith('<!')) throw new Error('경로 파일이 없습니다.');
    const track = parseGPX(text);
    trackCache.set(url, track);
    return track;
  })().finally(() => trackLoading.delete(url));
  trackLoading.set(url, job);
  return job;
}

/** 선 묶음(lines: [[lat,lng],…][]) → gpx.js 트랙 모양(고도 없음). */
export function trackFromLines(lines, name = null) {
  const segments = (lines || []).filter((l) => l?.length > 1).map((l) => l.map(([lat, lon]) => ({ lat, lon, ele: NaN })));
  const points = segments.flat();
  let dist = 0;
  for (const s of segments) for (let i = 1; i < s.length; i++) dist += haversine(s[i - 1].lat, s[i - 1].lon, s[i].lat, s[i].lon);
  return { name, points, segments, latlngs: points.map((p) => [p.lat, p.lon]), distance_km: +(dist / 1000).toFixed(2), gain_m: 0, hasEle: false };
}

// ---------- 모델 ----------
/**
 * @returns {Promise<{rows:Row[], byKey:Map, entry, walks, osmRows:Row[], warnings:string[]}>}
 */
export async function loadCourseModel(m) {
  const [entry, walks, curated] = await Promise.all([
    routeEntryFor(m.id).catch(() => null),
    // 노선이 없는 산은 산별 파일 자체가 없다(색인에만 없는 게 아니라 파일 생략) — 색인에 있는 산만 받는다(404 콘솔 오류 방지).
    loadTrekIndex().then((idx) => (idx?.[m.id] ? loadMountainWalks(m.id) : { routes: [] })).catch(() => ({ routes: [] })),
    curatedIds(),
  ]);
  let recorded = null;
  if (curated.has(m.id)) {
    try { recorded = await loadTrack(`${BASE}gpx/${m.id}.gpx`); } catch { recorded = null; }
  }
  return buildModel(m, { entry, walks, recorded });
}

function trailLines(entry, index) {
  const list = (entry?.tracks || []).filter((t) => t.route_index === index + 1)
    .sort((a, b) => (a.variant || 0) - (b.variant || 0));
  return list.map((t) => ({
    provenance: t.kind || 'osm-routed',
    url: `${BASE}gpx/${t.file}`,
    file: t.file,
    variant: t.variant || 0,
    label: t.variant ? `대안 ${t.variant}` : '기본',
    review: t.status === 'review',
    warnings: t.warnings || [],
    distance_km: t.distance_km, gain_m: t.gain_m, max_ele: t.max_ele,
    oneWay: t.distance_hypothesis !== 'round-trip',
  }));
}

/** 기본으로 보여 줄 선: 수록 > 계산(검토 통과) > 계산(검토 필요). */
export function defaultLineIndex(row) {
  if (!row.lines.length) return -1;
  const rec = row.lines.findIndex((l) => l.provenance === 'recorded');
  if (rec >= 0) return rec;
  const ok = row.lines.findIndex((l) => !l.review);
  return ok >= 0 ? ok : 0;
}

function buildModel(m, { entry, walks, recorded }) {
  const rows = [];
  const famous = m.famous_courses || [];
  const linked = new Map();
  famous.forEach((c) => { if (c.trail_index != null && m.trails?.[c.trail_index] && !linked.has(c.trail_index)) linked.set(c.trail_index, c); });

  // 수록 GPX가 어느 등산로의 들머리에서 시작(또는 끝)하는지 — 500m 안이면 그 행의 선으로 쓴다.
  let recordedTrail = -1;
  if (recorded) {
    const s = recorded.latlngs[0], e = recorded.latlngs.at(-1);
    (m.trails || []).forEach((t, i) => {
      if (recordedTrail >= 0 || !Array.isArray(t.trailhead)) return;
      const near = (p) => p && haversine(p[0], p[1], t.trailhead[0], t.trailhead[1]) <= 500;
      if (near(s) || near(e)) recordedTrail = i;
    });
  }
  const recordedLine = recorded && {
    provenance: 'recorded', url: `${BASE}gpx/${m.id}.gpx`, file: `${m.id}.gpx`, variant: 0, label: '수록',
    review: false, warnings: [], distance_km: recorded.distance_km, gain_m: recorded.gain_m, oneWay: true,
  };

  (m.trails || []).forEach((t, i) => {
    const course = linked.get(i) || null;
    const lines = trailLines(entry, i);
    if (recordedTrail === i) lines.unshift(recordedLine);
    const altName = course && normalize(course.name) !== normalize(t.name) ? course.name : null;
    rows.push({
      key: `t:${i}`, group: 'main', kind: 'trail', name: t.name || course?.name || '주요 코스', altName,
      trail: t, course, trailIndex: i,
      start: t.start || null, distanceKm: t.distance_km, ascentH: t.ascent_hours, roundH: t.round_trip_hours,
      duration: t.duration || null, difficulty: t.difficulty || null, verify: t.verify || null,
      trailhead: Array.isArray(t.trailhead) ? t.trailhead : null, trailheadConf: t.trailhead_conf || null,
      lines,
    });
  });
  if (recorded && recordedTrail < 0) {
    rows.push({ key: 'g:0', group: 'main', kind: 'recorded', name: recorded.name || '수록 경로', altName: null,
      trail: null, course: null, start: null, distanceKm: recorded.distance_km, lines: [recordedLine],
      trailhead: recorded.latlngs[0], trailheadConf: null });
  }
  famous.forEach((c) => {
    if (c.trail_index != null && linked.get(c.trail_index) === c) return;
    rows.push({
      key: `c:${c.id}`, group: 'main', kind: 'course', name: c.name, altName: null, trail: null, course: c,
      start: c.via?.[0] || null, lines: [], trailhead: null, trailheadConf: null,
    });
  });

  // OpenStreetMap 등록 탐방로(정상 300m 안). 구운 OSM 관계 GPX가 있으면 그 파일(고도 포함)을 쓴다.
  const relFiles = new Map((entry?.relations || []).map((r) => [String(r.osm_id), r]));
  const osmRows = (walks?.routes || []).filter(isSummitTrail).map((w) => {
    const relId = /^r\d+$/.test(w.rid) ? w.rid.slice(1) : null;
    const rel = relId ? relFiles.get(relId) : null;
    return {
      key: `o:${relId || w.rid}`, group: 'osm', kind: 'osm', name: w.name, altName: null, osm: w,
      start: null, distanceKm: w.length_km, walkingMin: w.walking_min || null,
      trailhead: w.entry || w.lines?.[0]?.[0] || null, trailheadConf: null,
      lines: [{ provenance: 'osm-relation', variant: 0, label: '기본', review: false, warnings: [],
        url: rel ? `${BASE}gpx/${rel.file}` : null, file: rel?.file || null, latlngsLines: w.lines, distance_km: w.length_km,
        oneWay: w.loop === true ? false : true, loop: w.loop === true }],
    };
  });

  const all = [...rows, ...osmRows];
  return { rows, osmRows, byKey: new Map(all.map((r) => [r.key, r])), entry, walks: walks?.routes || [], walksMeta: walks };
}

const normalize = (s) => String(s || '').replace(/\s+|코스$/g, '').replace(/[–—-]/g, '-');

/** ?route= 값을 행으로. o:는 관계 숫자 id와 rid 둘 다 받는다. */
export function resolveKey(model, key) {
  if (!key) return null;
  if (model.byKey.has(key)) return model.byKey.get(key);
  if (key.startsWith('o:')) {
    const v = key.slice(2);
    return model.osmRows.find((r) => r.osm.rid === v || r.osm.rid === `r${v}`) || null;
  }
  return null;
}

/** 옛 ?course=<courseId> → 연결된 등산로가 있으면 t:<i>, 없으면 c:<id>. */
export function legacyCourseKey(m, courseId) {
  const c = (m.famous_courses || []).find((x) => x.id === courseId);
  if (!c) return null;
  return c.trail_index != null && m.trails?.[c.trail_index] ? `t:${c.trail_index}` : `c:${c.id}`;
}

/** 선 하나를 실제 좌표로. 파일이 있으면 받고, 없으면 노선 선 묶음을 쓴다. */
export async function resolveLine(line, { signal } = {}) {
  if (line.track) return line.track;
  if (line.url) {
    try { line.track = await loadTrack(line.url, { signal }); return line.track; }
    catch (e) { if (!line.latlngsLines) throw e; }
  }
  if (line.latlngsLines) { line.track = trackFromLines(line.latlngsLines); return line.track; }
  throw new Error('선 자료가 없습니다.');
}

/** 행의 선 상태 글자: 수록 경로 / 계산 경로 / OpenStreetMap 노선 / 지도 선 없음. */
export function lineStatus(row) {
  const i = defaultLineIndex(row);
  if (i < 0) return { provenance: 'none', review: false };
  const l = row.lines[i];
  return { provenance: l.provenance, review: l.review };
}

/** 트랙을 지도 선 묶음으로(여러 조각이면 조각마다). */
export function trackLines(track) {
  return track.segments?.length ? track.segments.map((s) => s.map((p) => [p.lat, p.lon])) : [track.latlngs];
}

/** 순환 여부(시작·끝 200m 안). */
export function isLoop(track) {
  const s = track.latlngs?.[0], e = track.latlngs?.at(-1);
  return !!(s && e && haversine(s[0], s[1], e[0], e[1]) <= 200);
}
