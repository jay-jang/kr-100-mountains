// extract-osm-trekking.py의 전국 도보 관계 + osm-local의 이름 붙은 길.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_DIR, localMeta, localWays } from './osm-local.mjs';
import { haversine } from './geo.mjs';
let cached;
export function localTrekking() {
  if (!cached) {
    cached = JSON.parse(readFileSync(join(LOCAL_DIR, 'trekking-relations.json'), 'utf8'));
    if (cached.pbf !== localMeta()?.pbf) throw new Error('도보 관계와 길 타일의 PBF가 다릅니다. extract-osm-trekking.py를 먼저 실행하세요.');
    cached.waysById = new Map(cached.ways.map(w => [w.id, w]));
  }
  return cached;
}
export function trekkingInCircles(circles, namePattern) {
  const local = localTrekking();
  const b = { south: 90, north: -90, west: 180, east: -180 };
  for (const c of circles) {
    const dy = c.r / 110000, dx = dy / Math.cos(c.lat * Math.PI / 180);
    b.south = Math.min(b.south,c.lat-dy); b.north = Math.max(b.north,c.lat+dy);
    b.west = Math.min(b.west,c.lon-dx); b.east = Math.max(b.east,c.lon+dx);
  }
  const inside = w => w.geometry?.some(p => circles.some(c => haversine(c.lat,c.lon,p.lat,p.lon) <= c.r));
  const ways = new Map();
  const relations = local.relations.filter(r => {
    if (r.bounds.maxlat < b.south || r.bounds.minlat > b.north || r.bounds.maxlon < b.west || r.bounds.minlon > b.east) return false;
    const members = r.members.filter(m => m.type === 'way').map(m => local.waysById.get(m.ref)).filter(Boolean);
    if (!members.some(inside)) return false;
    for (const w of members) if (inside(w)) ways.set(w.id,w);
    return true;
  });
  for (const w of localWays(b).elements) if (namePattern.test(w.tags?.name || '') && inside(w)) ways.set(w.id,w);
  return { elements: [...relations,...ways.values()] };
}
