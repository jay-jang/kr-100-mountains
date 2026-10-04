// Screen-space hit testing keeps touch targets consistent at every zoom level.
export function nearbyRoutes(view, routes, point, tolerance = 16) {
  const click = view.project(point);
  const hits = [];
  for (const route of routes) {
    const segments = route.track?.segments?.map(s => s.map(p => [p.lat, p.lon])) || route.segments || [route.latlngs];
    let distance = Infinity;
    for (const segment of segments) {
      if (!segment?.length) continue;
      let a = view.project(segment[0]);
      for (let i = 1; i < segment.length; i++) {
        const b = view.project(segment[i]), dx = b.x - a.x, dy = b.y - a.y;
        const t = dx || dy ? Math.max(0, Math.min(1, ((click.x - a.x) * dx + (click.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
        distance = Math.min(distance, Math.hypot(click.x - a.x - t * dx, click.y - a.y - t * dy));
        a = b;
      }
    }
    if (distance <= tolerance) hits.push({ route, distance });
  }
  return hits.sort((a, b) => a.distance - b.distance).map(hit => hit.route);
}

export function nearbyMountains(view, mountains, mountain, tolerance = 44) {
  const origin = view.project([mountain.lat, mountain.lon]);
  return mountains.filter(m => {
    if (m.lat == null) return false;
    const p = view.project([m.lat, m.lon]);
    return Math.hypot(p.x - origin.x, p.y - origin.y) <= tolerance;
  }).sort((a, b) => a.name_full.localeCompare(b.name_full, 'ko'));
}
