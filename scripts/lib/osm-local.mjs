// 로컬 OpenStreetMap 추출본 — Overpass 공용 서버가 과부하(504)일 때도 돌 수 있게.
//
// 준비(한 번):
//   sudo apt-get install osmium-tool
//   curl -L -o .cache/osm/south-korea-latest.osm.pbf https://download.geofabrik.de/asia/south-korea-latest.osm.pbf
//   node scripts/lib/osm-local.mjs        # → .cache/osm/tiles/hw/<위도>_<경도>.json (0.1° 격자)
//
// 타일은 collect-routes.mjs가 Overpass에서 받는 것과 같은 길 분류(highway=…)만 담고,
// 읽을 때 Overpass `out geom` 응답과 같은 모양({ elements:[{type:'way', id, tags, geometry}] })으로 돌려준다.
// 라이선스: © OpenStreetMap contributors, ODbL 1.0 (Geofabrik 추출본).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, createReadStream, rmSync, renameSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOCAL_DIR = join(ROOT, '.cache', 'osm');
const TILE_DIR = join(LOCAL_DIR, 'tiles', 'hw');
const META = join(LOCAL_DIR, 'tiles', 'meta.json');
const TILE = 0.1;
const KEEP_TAGS = ['highway', 'access', 'foot', 'name', 'sac_scale', 'informal', 'trail_visibility'];
export const HIGHWAY_CLASSES = ['path', 'footway', 'track', 'steps', 'bridleway', 'pedestrian', 'cycleway',
  'service', 'unclassified', 'residential', 'living_street',
  'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link', 'trunk', 'trunk_link', 'road'];

/** 로컬 타일이 준비돼 있으면 메타({ pbf, snapshot, ways }), 아니면 null. */
export function localMeta() {
  try { return JSON.parse(readFileSync(META, 'utf8')); } catch { return null; }
}

// 이 모듈·다른 스크립트가 만드는 파생 파일(원본 추출본이 아님)
const DERIVED = /^(highways|peaks|named-nodes|named|trek)[.-]/;

/** 원본 추출본 중 가장 최근에 받은 것(파일 이름이 아니라 수정 시각으로 — 'latest' 이름이 날짜 붙은 새 파일을 이기지 않게). */
function newestPbf() {
  if (!existsSync(LOCAL_DIR)) return null;
  const f = readdirSync(LOCAL_DIR).filter((x) => x.endsWith('.osm.pbf') && !DERIVED.test(x))
    .map((x) => ({ x, t: statSync(join(LOCAL_DIR, x)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  return f ? join(LOCAL_DIR, f.x) : null;
}

/** 추출본의 자료 시점: osmium 헤더의 복제 시각 → 파일 이름의 YYMMDD → 파일 수정일 순으로. */
function snapshotOf(pbf) {
  try {
    const ts = execFileSync('osmium', ['fileinfo', '-g', 'header.option.osmosis_replication_timestamp', pbf], { encoding: 'utf8' }).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(ts)) return ts.slice(0, 10);
  } catch {}
  const m = pbf.match(/(\d{2})(\d{2})(\d{2})\.osm\.pbf$/);
  if (m) return `20${m[1]}-${m[2]}-${m[3]}`;
  return statSync(pbf).mtime.toISOString().slice(0, 10);
}

/** pbf → 길 타일. 이미 같은 pbf로 만든 타일이 있으면 건너뛴다. */
export async function buildLocalTiles({ pbf = newestPbf(), log = console.log } = {}) {
  if (!pbf) throw new Error('.cache/osm/*.osm.pbf 가 없습니다 (Geofabrik south-korea 추출본을 받으세요)');
  const meta = localMeta();
  const st = statSync(pbf);
  // 같은 이름으로 새 추출본을 받아도 다시 만들도록 이름·크기·수정 시각을 함께 본다.
  if (meta?.pbf === pbf.split('/').pop() && meta.size === st.size && meta.mtime_ms === Math.round(st.mtimeMs)) {
    log(`로컬 OSM 타일 준비됨 (${meta.pbf}, 스냅숏 ${meta.snapshot}, 길 ${meta.ways.toLocaleString()}개)`);
    return meta;
  }
  const hwPbf = join(LOCAL_DIR, 'highways.osm.pbf');
  const seq = join(LOCAL_DIR, 'highways.geojsonseq');
  log('osmium: 길 추출 중…');
  execFileSync('osmium', ['tags-filter', pbf, `w/highway=${HIGHWAY_CLASSES.join(',')}`, '-o', hwPbf, '--overwrite'], { stdio: 'inherit' });
  execFileSync('osmium', ['export', hwPbf, '-f', 'geojsonseq', '-o', seq, '--overwrite', '-a', 'type,id', '--geometry-types=linestring'], { stdio: 'inherit' });

  log('타일로 나누는 중…');
  rmSync(TILE_DIR, { recursive: true, force: true });
  mkdirSync(TILE_DIR, { recursive: true });
  const tiles = new Map();   // key → [way…]
  let ways = 0;
  const rl = createInterface({ input: createReadStream(seq), crlfDelay: Infinity });
  for await (let line of rl) {
    line = line.replace(/^\x1e/, '').trim();
    if (!line) continue;
    const f = JSON.parse(line);
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const tags = {};
    for (const k of KEEP_TAGS) if (f.properties[k] != null) tags[k] = f.properties[k];
    const flat = [];
    let s = 90, n = -90, w = 180, e = -180;
    for (const [lo, la] of coords) {
      flat.push(+la.toFixed(7), +lo.toFixed(7));
      if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo;
    }
    const way = [f.properties['@id'], tags, flat];
    for (let a = Math.floor(s / TILE); a <= Math.floor(n / TILE); a++) {
      for (let b = Math.floor(w / TILE); b <= Math.floor(e / TILE); b++) {
        const k = `${a}_${b}`;
        const t = tiles.get(k); if (t) t.push(way); else tiles.set(k, [way]);
      }
    }
    ways++;
  }
  for (const [k, list] of tiles) writeFileSync(join(TILE_DIR, `${k}.json`), JSON.stringify(list));
  const out = {
    pbf: pbf.split('/').pop(), size: st.size, mtime_ms: Math.round(st.mtimeMs),
    snapshot: snapshotOf(pbf),
    tile_deg: TILE, tiles: tiles.size, ways, built_at: new Date().toISOString(),
  };
  writeFileSync(`${META}.tmp`, JSON.stringify(out, null, 1));
  renameSync(`${META}.tmp`, META);
  rmSync(seq, { force: true });
  log(`로컬 OSM 타일 ${tiles.size}개 · 길 ${ways.toLocaleString()}개`);
  return out;
}

const tileCache = new Map();   // key → [way…] (최근 것만)
function readTile(k) {
  if (tileCache.has(k)) return tileCache.get(k);
  const f = join(TILE_DIR, `${k}.json`);
  const list = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
  if (tileCache.size > 24) tileCache.delete(tileCache.keys().next().value);
  tileCache.set(k, list);
  return list;
}

/** bbox 안을 지나는 길 — Overpass `out geom` 응답 모양으로. */
export function localWays(b) {
  const seen = new Set();
  const elements = [];
  for (let a = Math.floor(b.south / TILE); a <= Math.floor(b.north / TILE); a++) {
    for (let c = Math.floor(b.west / TILE); c <= Math.floor(b.east / TILE); c++) {
      for (const [id, tags, flat] of readTile(`${a}_${c}`)) {
        if (seen.has(id)) continue;
        // 길의 정점 하나라도 bbox 안에 있어야(Overpass bbox 질의와 같은 기준) 넣는다
        let inside = false;
        for (let i = 0; i < flat.length; i += 2) {
          if (flat[i] >= b.south && flat[i] <= b.north && flat[i + 1] >= b.west && flat[i + 1] <= b.east) { inside = true; break; }
        }
        if (!inside) continue;
        seen.add(id);
        const geometry = [];
        for (let i = 0; i < flat.length; i += 2) geometry.push({ lat: flat[i], lon: flat[i + 1] });
        elements.push({ type: 'way', id, tags, geometry });
      }
    }
  }
  return { elements };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildLocalTiles();
}
