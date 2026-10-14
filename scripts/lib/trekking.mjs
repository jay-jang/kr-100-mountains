// 산 주변 트레킹·걷기길 수집용 순수 함수 모음 (입출력 없음 — 단위 테스트 대상).
// 좌표는 모두 [lat, lon] (WGS84). 거리 단위는 함수 이름·인자에 적힌 대로(m 또는 km).
import { haversine, planar, pathLength, simplify, pointToSegment } from './geo.mjs';

// ── 분류 ─────────────────────────────────────────────────────────────
// 정렬 우선순위 순서이기도 하다(둘레길 → 숲길 → 능선 → 등산 코스 → 기타).
export const KINDS = ['dulle', 'forest', 'ridge', 'trail', 'other'];
export const KIND_ORDER = Object.fromEntries(KINDS.map((k, i) => [k, i]));
export const KIND_LABEL = {
  dulle: '둘레길·걷기길',
  forest: '숲길·산책로',
  ridge: '능선 종주',
  trail: '등산 코스',
  other: '기타 도보길',
};

// 판정 순서가 곧 규칙이다 — 이름에 여러 신호가 섞이는 경우가 흔하다.
//   1) 둘레길·걷기길 브랜드가 가장 강하다: "북한산둘레길 1구간 소나무숲길"(숲길 포함)·
//      "[서울둘레길] 7코스 / 일자산 코스"(코스 포함)·"치악산 둘레길"은 모두 둘레길이다.
//      "낙동정맥트레일"·"백두대간트레일"은 산림청 걷기길이므로 '트레일'도 여기서 잡는다.
//   2) 능선 종주(백두대간·정맥·지맥…)는 등산로/코스보다 앞선다: "백두대간 등산로" → ridge.
//   3) 숲길·산책로 계열은 '코스'보다 앞선다: "치유의 숲길 1코스" → forest.
//   4) 코스·등산로·탐방로 → 공식 등산 코스.
//   5) 위 어디에도 안 걸리지만 '…길'로 끝나는 도보 노선(가마바우길·회촌달맞이길·700년노송길 등
//      치악산 둘레길 구간 이름들)은 걷기길로 본다.
const RE_DULLE = new RegExp([
  '둘레\\s*길', '자락\\s*길', '마실\\s*길', '누리\\s*길', '바우\\s*길', '옛\\s*길', '순례\\s*길', '올레',
  '해파랑', '남파랑', '서해랑', '평화\\s*누리', '코리아\\s*둘레', '외씨\\s*버선', '비렁\\s*길', '소리\\s*길',
  '트레일', '에움\\s*길', '해솔\\s*길', '갈맷\\s*길', '나들\\s*길', '이음\\s*길', '아라메\\s*길', '늠내\\s*길',
  '마중\\s*길', '산소\\s*길', '바람\\s*길', '강변\\s*길', '해안\\s*길', '둘레\\s*숲', '트레킹',
  '\\bolle', 'ollegil', 'dulle', 'haeparang', 'namparang', 'seohaerang', 'city\\s*trail', 'nuri-?gil',
].join('|'), 'i');
const RE_RIDGE = /대간|정맥|지맥|기맥|분맥|종주|마루금|baekdu-?daegan|jeongmaek/i;
const RE_FOREST = /숲\s*길|숲속\s*길|계곡\s*길|자연\s*관찰로|치유|산책\s*로|산책\s*길|황톳\s*길|맨발|선재\s*길|전나무\s*숲|생태\s*(탐방로|길)|힐링|임도|forest|nature\s*trail/i;
// "들머리 - 봉우리" 꼴 이름(거창 일대 탐방로 관계 등): 끝이 봉우리·고개·폭포·대피소면 등산 코스 구간이다.
const RE_FROM_TO_PEAK = /\S\s*[-–]\s*\S.*(산|봉|령|재|치|고개|폭포|대피소|삼거리|갈림길|정상)\s*#?\s*$/;
const RE_TRAIL = /코스|등산\s*로|탐방\s*로|등산\s*길|등반\s*로|course|hiking\s*trail|\btrail\b/i;
const RE_GIL = /길(\s*\d+\s*(코스|구간))?\s*(\(.*\))?\s*$|길\s*\d/;

/** 노선 종류 판정. tags는 OSM 태그(관계 또는 way), network는 관계의 network 태그. */
export function classifyRoute({ name = '', network = null, tags = {} } = {}) {
  const n = String(name || tags['name:ko'] || tags.name || tags['name:en'] || '').normalize('NFC');
  if (RE_DULLE.test(n)) return 'dulle';
  if (RE_RIDGE.test(n)) return 'ridge';
  if (RE_FROM_TO_PEAK.test(n) && !/[가-힣]길\s*$/.test(n)) return 'trail';
  if (RE_FOREST.test(n)) return 'forest';
  if (RE_TRAIL.test(n)) return 'trail';
  // 이름 없이 from/to만 달린 관계는 국립공원 탐방로 구간("오색 → 대청봉 4.8 km")이다.
  if (!(tags.name || tags['name:ko'] || tags['name:en']) && tags.from && tags.to) return 'trail';
  if (RE_GIL.test(n)) return 'dulle';
  // 이름으로 못 가르는 경우: 정맥·대간 관계는 network=nwn으로 묶여 있는 경우가 많지만
  // nwn이 곧 능선은 아니므로(국가 걷기길도 nwn) 신호로 쓰지 않는다.
  void network;
  return 'other';
}

// ── 이름 정리 ─────────────────────────────────────────────────────────
/**
 * 표시용 이름: name:ko > name > name:en > "from – to". 공백 정리.
 * 설악산·한라산 등의 탐방로 구간 관계는 이름 없이 from/to 태그만 있어서, 그 태그를 그대로 잇는다
 * (지어낸 이름이 아니라 OSM 태그 값).
 */
export function displayName(tags = {}) {
  const ft = tags.from && tags.to ? `${String(tags.from).trim()} – ${String(tags.to).trim()}` : '';
  const raw = tags['name:ko'] || tags.name || tags['name:en'] || ft;
  return String(raw).normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** 비교용 정규화: 괄호 기호·공백·구두점 제거, 소문자. "[북한산둘레길] 4구간" ≡ "북한산둘레길 4구간". */
export function normalizeName(name = '') {
  return String(name).normalize('NFC').toLowerCase().replace(/[\s[\]{}()<>·•‧∙/\\|,.:;~_'"–—-]+/g, '');
}

// 위험·무의미 이름 — 목록에 올리면 안 되는 길.
//   비법정탐방로(국립공원 출입금지 샛길)는 OSM에 이름까지 달려 있어 그대로 두면 '추천 길'처럼 보인다.
const RE_EXCLUDED = /비\s*[법범]\s*정|폐쇄|출입\s*금지|출입\s*통제|통제\s*구간|공사\s*중|보수\s*공사|샛길|restricted|unofficial|closed/i;
export function isExcludedName(name = '') {
  return RE_EXCLUDED.test(String(name));
}

// 일반명사만으로 된 이름("산책로", "2코스", "자연관찰로 (Jayeongwanchalro)", "1.631 km")은
// 어느 길인지 알 수 없으므로 버린다. 고유명사가 한 글자라도 남으면 살린다("애기능 산책로").
// '올레길'은 제주올레라는 고유 브랜드라 일반명사 목록에서 뺀다("올레길7"을 살리기 위해).
const GENERIC_WORDS = /둘레길|자락길|옛길|숲속길|숲길|마실길|누리길|산책로|산책길|탐방로|등산로|등산길|계곡길|자연관찰로|관찰로|황톳길|데크길|무장애길|순환로|순환길|도보로|보행로|코스|구간|번길|길|\b(trail|path|course|walk(ing)?|hiking|km|m)\b/gi;
const GENERIC_MODS = /천연|지붕형|계곡|무장애|데크|순환|입구|연결|우회|임시|치유의|치유|힐링|생태|맨발|숲|소요\s*시간|시간|분|제(?=\s*\d)|\b(the|of|and|forest|nature|[a-z])\b/gi;
export function isGenericName(name = '') {
  // 괄호 속 한글은 이름의 일부로 보고("(가탄-송정)"), 로마자 병기("(Jayeongwanchalro)")는 무시한다.
  // 대괄호는 기호만 지운다 — "[서울둘레길] 20코스"의 '서울둘레길'이 고유명사다.
  let s = String(name).normalize('NFC')
    .replace(/\(([^)]*)\)/g, (_, inner) => (/[가-힣]/.test(inner) ? ` ${inner} ` : ' '))
    .replace(/[[\]]/g, ' ');
  s = s.replace(/(\d)\s*(km|m)\b/gi, '$1 ').replace(GENERIC_WORDS, ' ').replace(GENERIC_MODS, ' ');
  s = s.replace(/[\d\s.,:;~_/\\|()[\]{}<>·•'"–—-]+/g, '');
  return s.length === 0;
}

/** OSM distance 태그 → km. "7.3 km", "12,5", "4 mi", "850 m" 등을 받는다. 해석 불가면 null. */
export function parseDistanceKm(v) {
  if (v == null) return null;
  const m = String(v).trim().replace(',', '.').match(/^([\d.]+)\s*(km|mi|m)?\b/i);
  if (!m) return null;
  const x = Number(m[1]);
  if (!Number.isFinite(x) || x <= 0) return null;
  const unit = (m[2] || 'km').toLowerCase();
  const km = unit === 'mi' ? x * 1.609344 : unit === 'm' ? x / 1000 : x;
  return Math.round(km * 10) / 10;
}

// ── 기하 ─────────────────────────────────────────────────────────────
const isLine = (l) => Array.isArray(l) && l.length >= 2;

/** 여러 폴리라인의 총 길이(km). */
export function lengthKm(lines) {
  let m = 0;
  for (const l of lines || []) if (isLine(l)) m += pathLength(l);
  return m / 1000;
}

/** [south, west, north, east] */
export function bbox(lines) {
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const l of lines || []) for (const [la, lo] of l) {
    if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo;
  }
  return Number.isFinite(s) ? [s, w, n, e] : null;
}

/** Douglas–Peucker (허용오차 m). 끝점은 보존. */
export function douglasPeucker(points, toleranceMeters = 8) {
  return simplify(points, toleranceMeters);
}

/** 점에서 폴리라인 묶음까지 최단거리와 그 지점(선분 위 사영점). → { km, point:[lat,lon] } */
export function minDistToPoint(lines, lat, lon) {
  const prj = planar(lat);
  const Px = prj.x(lon), Py = prj.y(lat);
  let best = Infinity, bx = null, by = null;
  const consider = (x, y) => {
    const d = Math.hypot(Px - x, Py - y);
    if (d < best) { best = d; bx = x; by = y; }
  };
  for (const l of lines || []) {
    if (!l || !l.length) continue;
    if (l.length === 1) { consider(prj.x(l[0][1]), prj.y(l[0][0])); continue; }
    for (let i = 1; i < l.length; i++) {
      const Ax = prj.x(l[i - 1][1]), Ay = prj.y(l[i - 1][0]);
      const Bx = prj.x(l[i][1]), By = prj.y(l[i][0]);
      const ABx = Bx - Ax, ABy = By - Ay, ab2 = ABx * ABx + ABy * ABy;
      let t = ab2 ? ((Px - Ax) * ABx + (Py - Ay) * ABy) / ab2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      consider(Ax + t * ABx, Ay + t * ABy);
    }
  }
  if (bx == null) return { km: Infinity, point: null };
  const mLat = 111320, mLon = 111320 * Math.cos((lat * Math.PI) / 180);
  return { km: best / 1000, point: [by / mLat, bx / mLon] };
}

// 끝점 공간 색인(격자). cellM 크기 칸에 끝점을 넣고 이웃 3×3 칸만 본다.
function endpointIndex(segs, cellM, refLat) {
  const prj = planar(refLat);
  const key = (p) => `${Math.floor(prj.x(p[1]) / cellM)},${Math.floor(prj.y(p[0]) / cellM)}`;
  const grid = new Map();
  segs.forEach((s, i) => {
    for (const end of [0, 1]) {
      const p = end ? s[s.length - 1] : s[0];
      const k = key(p);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ i, end });
    }
  });
  const near = (p) => {
    const cx = Math.floor(prj.x(p[1]) / cellM), cy = Math.floor(prj.y(p[0]) / cellM);
    const out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const arr = grid.get(`${cx + dx},${cy + dy}`);
      if (arr) out.push(...arr);
    }
    return out;
  };
  return { near };
}

/**
 * way 선형들을 끝점끼리(joinM 이내) 이어 붙여 가능한 한 적은 폴리라인으로 만든다.
 * 방향이 반대인 way는 뒤집어서 잇는다. 갈림길(끝점 3개 이상이 한 곳)에서는 가장 가까운
 * 하나와만 잇고 나머지는 별도 선으로 남긴다 — 없는 연결을 지어내지 않는다.
 * 입력: [[lat,lon],...] 배열들. 출력: 같은 형식의 배열들(긴 것부터).
 */
export function chainWays(ways, joinM = 15) {
  const segs = (ways || []).filter(isLine).map((l) => l.slice());
  if (!segs.length) return [];
  const used = new Uint8Array(segs.length);
  const idx = endpointIndex(segs, Math.max(joinM, 1), segs[0][0][0]);
  const order = segs.map((s, i) => [i, pathLength(s)]).sort((a, b) => b[1] - a[1]).map(([i]) => i);

  const findNext = (p) => {
    let best = null;
    for (const c of idx.near(p)) {
      if (used[c.i]) continue;
      const s = segs[c.i];
      const q = c.end ? s[s.length - 1] : s[0];
      const d = haversine(p[0], p[1], q[0], q[1]);
      if (d <= joinM && (!best || d < best.d)) best = { ...c, d };
    }
    return best;
  };

  const chains = [];
  for (const seed of order) {
    if (used[seed]) continue;
    used[seed] = 1;
    let chain = segs[seed].slice();
    // 꼬리 쪽으로 늘이기
    for (;;) {
      const tail = chain[chain.length - 1];
      const nx = findNext(tail);
      if (!nx) break;
      used[nx.i] = 1;
      const s = nx.end === 0 ? segs[nx.i] : segs[nx.i].slice().reverse();
      chain = chain.concat(nx.d < 0.5 ? s.slice(1) : s);
    }
    // 머리 쪽으로 늘이기
    for (;;) {
      const head = chain[0];
      const nx = findNext(head);
      if (!nx) break;
      used[nx.i] = 1;
      const s = nx.end === 1 ? segs[nx.i] : segs[nx.i].slice().reverse();
      chain = (nx.d < 0.5 ? s.slice(0, -1) : s).concat(chain);
    }
    chains.push(chain);
  }
  return chains.sort((a, b) => pathLength(b) - pathLength(a));
}

// 두 폴리라인이 gapM 이내로 가까운가(정점→선분 최단거리, 조기 종료).
function linesWithin(a, b, gapM, prj) {
  const test = (P, L) => {
    for (const p of P) {
      if (L.length === 1) { if (haversine(p[0], p[1], L[0][0], L[0][1]) <= gapM) return true; continue; }
      for (let i = 1; i < L.length; i++) if (pointToSegment(p, L[i - 1], L[i], prj) <= gapM) return true;
    }
    return false;
  };
  return test(a, b) || test(b, a);
}

/**
 * 같은 이름의 way들을 '서로 이어진 무리'로 나눈다. 가장 가까운 거리가 gapKm 이하인 것끼리
 * 한 무리(연결 요소)가 된다 — 다른 동네의 동명 "OO 산책로"를 한 노선으로 합치지 않기 위해.
 * items 각각에서 getLine(item)으로 폴리라인을 얻는다. 반환: items의 부분 배열들(큰 무리부터).
 */
export function splitByGap(items, gapKm = 1.5, getLine = (x) => x) {
  const list = (items || []).filter((it) => isLine(getLine(it)));
  if (!list.length) return [];
  const gapM = gapKm * 1000;
  const lines = list.map(getLine);
  const prj = planar(lines[0][0][0]);
  const padLat = gapM / 111320, padLon = gapM / (111320 * Math.cos((lines[0][0][0] * Math.PI) / 180));
  const boxes = lines.map((l) => bbox([l]));
  const parent = list.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const ri = find(i), rj = find(j);
      if (ri === rj) continue;
      const A = boxes[i], B = boxes[j];
      if (A[0] - padLat > B[2] || B[0] - padLat > A[2] || A[1] - padLon > B[3] || B[1] - padLon > A[3]) continue;
      if (linesWithin(lines[i], lines[j], gapM, prj)) parent[ri] = rj;
    }
  }
  const groups = new Map();
  list.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** 이름별 묶기: Map<name, items[]> (이름 없는 항목은 제외). */
export function groupByName(items, getName = (x) => x.name) {
  const m = new Map();
  for (const it of items || []) {
    const n = getName(it);
    if (!n) continue;
    if (!m.has(n)) m.set(n, []);
    m.get(n).push(it);
  }
  return m;
}

/**
 * 원(중심 lat,lon · 반경 radiusM) 안쪽 부분만 남긴다. 경계를 가로지르는 선분은 교점에서 자른다.
 * → { lines, clipped } (clipped: 잘려 나간 부분이 있었는가)
 */
export function clipToRadius(lines, lat, lon, radiusM) {
  return clipToCircles(lines, [{ lat, lon, r: radiusM }]);
}

/**
 * 여러 원의 합집합(정상 + 들머리마다 같은 반경) 안쪽 부분만 남긴다. 원이 하나면 clipToRadius와 같다.
 * circles: [{ lat, lon, r(미터) }]. 투영은 첫 원 기준 국소 평면(한 산 주변 수십 km에서 오차 무시 가능).
 * → { lines, clipped }
 */
export function clipToCircles(lines, circles) {
  const cs = (circles || []).filter((c) => Number.isFinite(c?.lat) && Number.isFinite(c?.lon) && c.r > 0);
  if (!cs.length) return { lines: [], clipped: (lines || []).some(isLine) };
  const lat0 = cs[0].lat, lon0 = cs[0].lon;
  const mLat = 111320, mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const toXY = ([la, lo]) => [(lo - lon0) * mLon, (la - lat0) * mLat];
  const toLL = ([x, y]) => [lat0 + y / mLat, lon0 + x / mLon];
  const C = cs.map((c) => { const [x, y] = toXY([c.lat, c.lon]); return { x, y, R2: c.r * c.r }; });
  const inside = ([x, y]) => C.some((c) => (x - c.x) ** 2 + (y - c.y) ** 2 <= c.R2);
  const out = [];
  let clipped = false;
  for (const l of lines || []) {
    if (!isLine(l)) continue;
    let run = [];
    const flush = () => { if (run.length >= 2) out.push(run); run = []; };
    const P = l.map(toXY);
    if (inside(P[0])) run.push(l[0]); else clipped = true;
    for (let i = 1; i < P.length; i++) {
      const [ax, ay] = P[i - 1], [bx, by] = P[i];
      const dx = bx - ax, dy = by - ay;
      // 각 원에 대해 |A − O + t·D|² = R² 의 해(0<t<1) — 경계를 넘는 지점들
      const ts = [];
      const a = dx * dx + dy * dy;
      if (a > 0) {
        for (const c of C) {
          const ox = ax - c.x, oy = ay - c.y;
          const b = 2 * (ox * dx + oy * dy), cc = ox * ox + oy * oy - c.R2;
          const disc = b * b - 4 * a * cc;
          if (disc <= 0) continue;
          const sq = Math.sqrt(disc);
          for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) if (t > 1e-9 && t < 1 - 1e-9) ts.push(t);
        }
      }
      ts.sort((x, y) => x - y);
      let prevT = 0;
      for (const t of [...ts, 1]) {
        if (t - prevT < 1e-12) continue;
        const mid = (prevT + t) / 2;
        const midIn = inside([ax + mid * dx, ay + mid * dy]);
        const endPt = t === 1 ? l[i] : toLL([ax + t * dx, ay + t * dy]);
        if (midIn) {
          if (!run.length) run.push(toLL([ax + prevT * dx, ay + prevT * dy]));
          run.push(endPt);
        } else {
          clipped = true;
          flush();
        }
        prevT = t;
      }
    }
    flush();
  }
  return { lines: out, clipped };
}

/**
 * A 선형의 정점 중 B 선형에서 tolM 이내에 놓인 비율(0~1). 같은 길을 다른 이름으로 또 그린
 * way 묶음(예: 관계 노선과 겹치는 '무장애 탐방구간')을 걸러내는 데 쓴다.
 */
export function overlapFraction(linesA, linesB, tolM = 25) {
  const pts = (linesA || []).flat();
  if (!pts.length || !(linesB || []).length) return 0;
  const prj = planar(pts[0][0]);
  const padLat = tolM / 111320, padLon = tolM / (111320 * Math.cos((pts[0][0] * Math.PI) / 180));
  const B = linesB.filter(isLine).map((l) => ({ l, b: bbox([l]) }));
  let hit = 0;
  for (const p of pts) {
    let ok = false;
    for (const { l, b } of B) {
      if (p[0] < b[0] - padLat || p[0] > b[2] + padLat || p[1] < b[1] - padLon || p[1] > b[3] + padLon) continue;
      for (let i = 1; i < l.length && !ok; i++) if (pointToSegment(p, l[i - 1], l[i], prj) <= tolM) ok = true;
      if (ok) break;
    }
    if (ok) hit++;
  }
  return hit / pts.length;
}

// ── 정렬·상한 ─────────────────────────────────────────────────────────
/** 종류 우선순위 → 정상까지 거리 → 길이(긴 것 먼저). */
export function compareRoutes(a, b) {
  return (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)
    || a.dist_km - b.dist_km
    || b.length_km - a.length_km;
}

/**
 * 상한 cap개로 추린다. 단순히 정렬 후 자르면 둘레길이 많은 산(북한산)에서 능선·등산 코스가
 * 통째로 빠지므로, 종류마다 가까운 순으로 reservePerKind개까지는 자리를 먼저 잡아 둔다.
 * 단, 정상에서 reserveWithinKm 안에 있는 노선만, 그리고 '기타(other)'는 자리 확보 대상이 아니다
 * — 멀리 있는 도심 산책로가 가까운 둘레길 구간을 밀어내지 않게.
 * → { kept(정렬됨), dropped }
 */
export function selectRoutes(routes, cap = 25, reservePerKind = 3, reserveWithinKm = Infinity) {
  const sorted = (routes || []).slice().sort(compareRoutes);
  if (sorted.length <= cap) return { kept: sorted, dropped: [] };
  const keep = new Set();
  for (const k of KINDS) {
    if (k === 'other') continue;
    const arr = sorted.filter((r) => r.kind === k && r.dist_km <= reserveWithinKm)
      .sort((a, b) => a.dist_km - b.dist_km);
    for (const r of arr.slice(0, reservePerKind)) if (keep.size < cap) keep.add(r);
  }
  for (const r of sorted) { if (keep.size >= cap) break; keep.add(r); }
  return { kept: sorted.filter((r) => keep.has(r)), dropped: sorted.filter((r) => !keep.has(r)) };
}

/** 좌표 반올림(소수 5자리 ≈ 1.1 m). */
export const round5 = (v) => Math.round(v * 1e5) / 1e5;
export const roundPt = ([la, lo]) => [round5(la), round5(lo)];

/** "ko:서울로 7017" → https://ko.wikipedia.org/wiki/서울로_7017 */
export function wikipediaUrl(tag) {
  if (!tag) return null;
  const m = String(tag).match(/^([a-z-]{2,12}):(.+)$/);
  if (!m) return null;
  return `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].trim().replace(/ /g, '_')).replace(/%2F/g, '/')}`;
}

// ── 기준점·순환·장거리 ────────────────────────────────────────────────
/**
 * 노선과 산의 기준점(정상 + 들머리들) 사이 거리.
 * anchors: [{ kind:'summit'|'trailhead', lat, lon }] (정상이 첫 번째일 필요는 없다).
 * → { dist_km, anchor, entry:[lat,lon], near_summit, summit_km }
 *   - near_summit: 노선이 정상 nearSummitKm(기본 0.3) 안을 지난다.
 *   - 정상 근처를 지나는 노선은 anchor='summit'·dist_km=정상까지 거리로 둔다(들머리가 더 가까워도).
 *     산 시트가 "정상 300m 안을 지나는 탐방로"를 anchor·dist_km로 가려내기 때문이다.
 *   - 그 밖에는 가장 가까운 기준점.
 */
export function nearestAnchor(lines, anchors, nearSummitKm = 0.3) {
  let best = null, summit = null;
  for (const a of anchors || []) {
    const d = minDistToPoint(lines, a.lat, a.lon);
    if (!Number.isFinite(d.km)) continue;
    const hit = { km: d.km, point: d.point, kind: a.kind };
    if (a.kind === 'summit' && (!summit || hit.km < summit.km)) summit = hit;
    if (!best || hit.km < best.km - 1e-9) best = hit;
  }
  if (!best) return { dist_km: Infinity, anchor: null, entry: null, near_summit: false, summit_km: null };
  const nearSummit = !!summit && summit.km <= nearSummitKm;
  const pick = nearSummit ? summit : best;
  return {
    dist_km: pick.km, anchor: pick.kind, entry: pick.point,
    near_summit: nearSummit, summit_km: summit ? summit.km : null,
  };
}

/**
 * 순환/편도. OSM roundtrip 태그가 있으면 그것을 따른다. 없으면 노선 전체 선이 손에 있을 때만
 * (complete) 시작·끝이 tolM(기본 200m) 안이면 순환으로 본다. 선이 여러 조각이면 joinM(100m)로
 * 한 번 더 이어 보고, 그래도 여러 조각이면 판단하지 않는다(null) — 지어내지 않는다.
 */
export function loopFlag({ roundtrip = null, lines = [], complete = true, tolM = 200, joinM = 100 } = {}) {
  const rt = String(roundtrip ?? '').trim().toLowerCase();
  if (rt === 'yes') return true;
  if (rt === 'no') return false;
  if (!complete) return null;
  let ls = (lines || []).filter(isLine);
  if (ls.length > 1) ls = chainWays(ls, joinM);
  if (ls.length !== 1) return null;
  const l = ls[0];
  if (pathLength(l) < tolM * 2) return null;
  const a = l[0], b = l[l.length - 1];
  return haversine(a[0], a[1], b[0], b[1]) <= tolM;
}

// 장거리 걷기길 — 여러 날에 걸쳐 걷는 국가·광역 단위 노선(구간 하나만 지나도 그 노선의 일부다).
//   network=nwn/iwn(국가·국제 도보망) 또는 아래 브랜드 이름. '가마바우길'·'고바우길'처럼 이름 속에
//   '바우길'이 든 동네 길은 강릉바우길이 아니므로 앞이 단어 경계일 때만 잡는다.
const RE_LONG = new RegExp([
  '(?:^|[\\s\\[(])올레', '제주\\s*올레', '해파랑', '남파랑', '서해랑', '평화\\s*누리', '코리아\\s*둘레', 'DMZ', '디엠지',
  '백두대간\\s*트레일', '낙동정맥\\s*트레일', '외씨\\s*버선', '서울\\s*둘레\\s*길', '지리산\\s*둘레\\s*길',
  '경기\\s*둘레\\s*길', '강화\\s*나들\\s*길', '갈맷\\s*길', '(?:^|[\\s\\[(])(?:강릉\\s*)?바우\\s*길', '소백산\\s*자락\\s*길',
  '대전\\s*둘레\\s*산길', '내포\\s*문화\\s*숲길', '한국\\s*트레킹', '영남\\s*알프스\\s*둘레',
  '\\bolle', 'haeparang', 'namparang', 'seohaerang', 'korea\\s*dulle', 'korea\\s*trail', 'seoul\\s*trail\\b', 'jirisan\\s*trail',
].join('|'), 'i');
export function isLongDistance({ name = '', network = null, nameEn = '' } = {}) {
  if (/^(nwn|iwn)$/i.test(String(network || '').trim())) return true;
  const n = String(name || '').normalize('NFC');
  if (/seoul\s*city\s*trail/i.test(n)) return false;          // 도심 산책 노선(서울 한양도성 쪽)
  return RE_LONG.test(n) || (!!nameEn && RE_LONG.test(String(nameEn)) && !/city\s*trail/i.test(nameEn));
}

/**
 * 같은 노선의 구간끼리 묶는 열쇠: 구간 표기(N구간·N코스·괄호 속 구간명·대괄호)를 지운 이름.
 *   "지리산둘레길 (금계-동강)" → "지리산둘레길", "[북한산둘레길] 12구간 - 충의길" → "북한산둘레길",
 *   "[서울둘레길] 7코스 / 일자산 코스" → "서울둘레길", "올레길7"·"Ollegil 8" → "올레길".
 * 구간 표기가 없으면 null(형제 구간이 없는 단독 노선).
 */
export function seriesKey(name = '') {
  const raw = String(name).normalize('NFC').replace(/\s+/g, ' ').trim();
  let base = null, m;
  if ((m = raw.match(/^\[([^\]]+)\]\s*\S/))) base = m[1];                                   // [북한산둘레길] 12구간 …
  else if ((m = raw.match(/^(.+?)\s*(?:제\s*)?\d+(?:\s*[-–~]\s*\d+)?\s*(?:구간|코스)/))) base = m[1];   // 평화누리길11코스 · 비렁길 3코스
  else if ((m = raw.match(/^(.+?)\s*(?:course|section|route)\s*\d+/i))) base = m[1];       // … Course 2
  else if ((m = raw.match(/^(.+?)\s*\d+[A-Za-z]?\s*(?:[(（][^)）]*[)）])?\s*$/))) base = m[1];      // 올레길7 · 올레길6(A) · Ollegil 8
  else if ((m = raw.match(/^(.*길)\s*[(（][^)）]+[)）]\s*$/))) base = m[1];                 // 지리산둘레길 (금계-동강)
  if (!base) return null;
  base = base.replace(/[\s\-–—/·:]+$/, '').trim();
  if (/^(olle(gil)?|olle\s*trail|jeju\s*olle(\s*trail)?|올레|올레길|제주\s*올레(길)?)$/i.test(base)) base = '올레길';
  const k = normalizeName(base);
  return k.length >= 2 ? k : null;
}

// ── 전국 노선 거르기 ──────────────────────────────────────────────────
const RE_HANGUL = /[가-힣]/;
const RE_JA = /[぀-ヿㇰ-ㇿｦ-ﾟ]|[一-鿿]/;
/** 한글 없이 가나·한자만 있는 이름(일본 노선). */
export function isJapaneseName(name = '') {
  const n = String(name || '');
  return !RE_HANGUL.test(n) && RE_JA.test(n);
}

// 군사분계선 근사(경도, 위도) — 경계상자 전체가 이 선 북쪽에 있는 노선(금강산 등)은 뺀다.
const MDL = [[124.5, 37.6], [126.1, 37.7], [126.55, 37.76], [126.68, 37.95], [127.0, 38.2], [127.3, 38.31],
  [127.8, 38.33], [128.1, 38.45], [128.36, 38.61], [131.0, 38.62]];
function mdlLat(lon) {
  if (lon <= MDL[0][0]) return MDL[0][1];
  for (let i = 1; i < MDL.length; i++) {
    const [x0, y0] = MDL[i - 1], [x1, y1] = MDL[i];
    if (lon <= x1) return y0 + ((lon - x0) / (x1 - x0)) * (y1 - y0);
  }
  return MDL[MDL.length - 1][1];
}
/**
 * 경계상자 {minlat,minlon,maxlat,maxlon}가 남한에 걸치는가.
 * 남한 범위(33.0–38.7N, 124.5–131.0E) 밖이거나, 규슈·쓰시마 쪽(위도 35 아래·경도 129.3 동쪽 등)이거나,
 * 군사분계선 북쪽에만 있으면 false.
 */
export function inSouthKorea(b) {
  if (!b) return false;
  const cLat = (b.minlat + b.maxlat) / 2, cLon = (b.minlon + b.maxlon) / 2;
  if (cLat < 33.0 || cLat > 38.7 || cLon < 124.5 || cLon > 131.0) return false;
  if ((cLat < 34.8 && cLon > 129.1) || (cLat < 35.0 && cLon > 129.3)) return false;      // 쓰시마·규슈
  if (b.minlat > Math.max(mdlLat(b.minlon), mdlLat(b.maxlon))) return false;            // 북한
  return true;
}

// ── 1° 격자 타일 ──────────────────────────────────────────────────────
export const tileKey = (la, lo) => `${Math.floor(la)}_${Math.floor(lo)}`;
/**
 * 선 묶음을 1° 격자 타일별로 나눈다. 경계를 넘는 선분은 양쪽 타일에 모두 넣어(꼭짓점 하나씩 겹침)
 * 타일을 따로 받아도 선이 끊겨 보이지 않게 한다. → Map<tileKey, lines>
 */
export function splitToTiles(lines) {
  const out = new Map();
  const push = (k, run) => { if (run.length < 2) return; if (!out.has(k)) out.set(k, []); out.get(k).push(run); };
  for (const l of lines || []) {
    if (!isLine(l)) continue;
    let key = tileKey(l[0][0], l[0][1]);
    let run = [l[0]];
    for (let i = 1; i < l.length; i++) {
      const k = tileKey(l[i][0], l[i][1]);
      run.push(l[i]);
      if (k !== key) {
        push(key, run);
        run = [l[i - 1], l[i]];
        key = k;
      }
    }
    push(key, run);
  }
  return out;
}
