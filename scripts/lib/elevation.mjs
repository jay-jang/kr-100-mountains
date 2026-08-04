// 고도 조회 — SRTM 1 arc-second DEM 타일을 내려받아 **로컬에서** 샘플링한다.
//
// 왜 API가 아니라 타일인가
//   경로 500여 개 × 점 100~400개면 좌표가 수만 개다. 무료 고도 API는 시간·일 단위 한도에
//   금방 걸려(open-meteo에서 `Hourly API request limit exceeded` 확인) 고도가 통째로 빠진 채
//   수집이 끝나 버린다. 1°×1° 타일 몇 십 개를 한 번 받아 두면 한도도, 실패도, 지연도 없다.
//
// 원자료: SRTM 1 arc-second (NASA/USGS, public domain) — AWS Terrain Tiles 배포본
//         https://registry.opendata.aws/terrain-tiles/
// 형식:   skadi = gzip된 .hgt, 3601×3601 big-endian int16, 행 0이 북쪽 끝, -32768은 공백(void).
// 성격:   지형 DEM에서 읽은 **추정 고도**이며 기압·GPS 실측 고도가 아니다.
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/skadi';
const UA = 'kr-100-mountains-route-harvester/1.0';
const SIDE = 3601;          // 1 arc-second 타일 한 변의 표본 수
const VOID = -32768;
const MEM_TILES = 4;        // 메모리에 두는 압축 해제 타일 수(1장 ≈ 26MB)

export const ELEVATION_SOURCE = 'SRTM 1 arc-second (NASA/USGS) — AWS Terrain Tiles 배포본. 지형 DEM 추정 고도이며 실측 아님';
export const ELEVATION_LINK = {
  href: 'https://registry.opendata.aws/terrain-tiles/',
  text: 'Elevation: SRTM 1 arc-second (NASA/USGS) via AWS Terrain Tiles',
};

const tileName = (lat, lon) => {
  const la = Math.floor(lat), lo = Math.floor(lon);
  const ns = la < 0 ? 'S' : 'N', ew = lo < 0 ? 'W' : 'E';
  return `${ns}${String(Math.abs(la)).padStart(2, '0')}${ew}${String(Math.abs(lo)).padStart(3, '0')}`;
};

export class ElevationDEM {
  constructor(dir) {
    this.dir = dir;
    this.mem = new Map();       // 타일이름 → Int16 접근용 Buffer (LRU)
    this.missing = new Set();   // 없는 타일(바다 등) — 다시 받지 않는다
    this.downloads = 0;
    mkdirSync(dir, { recursive: true });
  }

  // 매니페스트 호환용(디스크에 바로 쓰므로 따로 저장할 것이 없다)
  save() {}
  get calls() { return this.downloads; }

  async tile(name, log) {
    if (this.mem.has(name)) {
      const buf = this.mem.get(name);           // LRU 갱신
      this.mem.delete(name); this.mem.set(name, buf);
      return buf;
    }
    if (this.missing.has(name)) return null;

    const gz = join(this.dir, `${name}.hgt.gz`);
    if (!existsSync(gz)) {
      const url = `${BASE}/${name.slice(0, 3)}/${name}.hgt.gz`;
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const res = await fetch(url, { headers: { 'User-Agent': UA } });
          if (res.status === 404) { this.missing.add(name); log?.(`  DEM 타일 없음(바다 등): ${name}`); return null; }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = Buffer.from(await res.arrayBuffer());
          const tmp = `${gz}.tmp`;
          writeFileSync(tmp, body); renameSync(tmp, gz);   // 원자적 교체
          this.downloads++;
          log?.(`  DEM 타일 내려받음: ${name} (${(body.length / 1048576).toFixed(1)}MB)`);
          ok = true;
        } catch (e) {
          if (attempt === 2) { log?.(`  DEM 타일 실패: ${name} — ${e.message}`); this.missing.add(name); return null; }
          await new Promise((r) => setTimeout(r, [2000, 6000][attempt]));
        }
      }
    }

    let buf;
    try { buf = gunzipSync(readFileSync(gz)); }
    catch (e) { log?.(`  DEM 타일 손상: ${name} — ${e.message}`); this.missing.add(name); return null; }
    if (buf.length !== SIDE * SIDE * 2) { log?.(`  DEM 타일 크기 이상: ${name} ${buf.length}B`); this.missing.add(name); return null; }

    this.mem.set(name, buf);
    while (this.mem.size > MEM_TILES) this.mem.delete(this.mem.keys().next().value);
    return buf;
  }

  /** latlngs: [[lat,lon],...] → [고도(m) | null, ...]. 4점 이중선형 보간, void는 건너뛴다. */
  async lookup(latlngs, { log } = {}) {
    const out = new Array(latlngs.length).fill(null);
    // 같은 타일에 속한 점을 모아 타일 교체를 최소화한다.
    const byTile = new Map();
    latlngs.forEach(([la, lo], i) => {
      const n = tileName(la, lo);
      const arr = byTile.get(n);
      if (arr) arr.push(i); else byTile.set(n, [i]);
    });

    for (const [name, idxs] of byTile) {
      const buf = await this.tile(name, log);
      if (!buf) continue;
      const baseLat = Math.floor(latlngs[idxs[0]][0]), baseLon = Math.floor(latlngs[idxs[0]][1]);
      for (const i of idxs) {
        const [la, lo] = latlngs[i];
        // 행 0 = 북쪽 끝(baseLat+1), 열 0 = 서쪽 끝(baseLon)
        const y = (baseLat + 1 - la) * (SIDE - 1);
        const x = (lo - baseLon) * (SIDE - 1);
        const r0 = Math.floor(y), c0 = Math.floor(x);
        const fy = y - r0, fx = x - c0;
        let sum = 0, wsum = 0;
        for (const [dr, dc, w] of [
          [0, 0, (1 - fy) * (1 - fx)], [0, 1, (1 - fy) * fx],
          [1, 0, fy * (1 - fx)], [1, 1, fy * fx],
        ]) {
          if (w <= 0) continue;
          const r = r0 + dr, c = c0 + dc;
          if (r < 0 || r >= SIDE || c < 0 || c >= SIDE) continue;
          const v = buf.readInt16BE(2 * (r * SIDE + c));
          if (v === VOID) continue;                 // 공백 표본은 가중치에서 제외
          sum += v * w; wsum += w;
        }
        if (wsum > 0) out[i] = Math.round((sum / wsum) * 10) / 10;
      }
    }
    return out;
  }
}

// 고도 배열 → 누적 상승/하강. DEM 잡음에 의한 미세 진동은 임계값으로 걸러낸다.
export function elevationStats(eles) {
  const vals = eles.filter((e) => Number.isFinite(e));
  if (vals.length < 2) return { gain_m: null, loss_m: null, min_ele: null, max_ele: null };
  let gain = 0, loss = 0, ref = vals[0];
  const THRESH = 3;          // 3m 미만 변화는 DEM 잡음으로 보고 무시
  for (const e of vals) {
    const dz = e - ref;
    if (Math.abs(dz) < THRESH) continue;
    if (dz > 0) gain += dz; else loss -= dz;
    ref = e;
  }
  return {
    gain_m: Math.round(gain), loss_m: Math.round(loss),
    min_ele: Math.round(Math.min(...vals)), max_ele: Math.round(Math.max(...vals)),
  };
}
