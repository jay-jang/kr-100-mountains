// Minimal GPX parsing + rendering (provider-agnostic). Honest: renders only real
// track data (from a user file or a curated file under /public/gpx), never fabricated.

export function parseGPX(text) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('GPX 형식을 해석할 수 없습니다');
  const nodes = [...xml.querySelectorAll('trkpt, rtept')];
  const pts = nodes.map((n) => ({
    lat: parseFloat(n.getAttribute('lat')),
    lon: parseFloat(n.getAttribute('lon')),
    ele: parseFloat(n.querySelector('ele')?.textContent ?? 'NaN'),
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!pts.length) throw new Error('트랙 포인트가 없습니다');

  // stats
  let dist = 0, gain = 0, prev = null;
  const eles = [];
  for (const p of pts) {
    if (prev) {
      dist += haversine(prev.lat, prev.lon, p.lat, p.lon);
      if (Number.isFinite(p.ele) && Number.isFinite(prev.ele) && p.ele > prev.ele) gain += p.ele - prev.ele;
    }
    if (Number.isFinite(p.ele)) eles.push(p.ele);
    prev = p;
  }
  const name = xml.querySelector('trk > name, metadata > name')?.textContent?.trim() || null;
  return {
    name, points: pts,
    latlngs: pts.map((p) => [p.lat, p.lon]),
    distance_km: +(dist / 1000).toFixed(2),
    gain_m: Math.round(gain),
    min_ele: eles.length ? Math.round(Math.min(...eles)) : null,
    max_ele: eles.length ? Math.round(Math.max(...eles)) : null,
    hasEle: eles.length > 2,
  };
}

function haversine(la1, lo1, la2, lo2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLa = toRad(la2 - la1), dLo = toRad(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Draw a track on a provider-agnostic MapView. Returns a token array for removeLayer().
export function drawTrack(view, track, color = '#d1495b') {
  const tokens = [view.addPolyline(track.latlngs, { color, weight: 4, opacity: 0.95, outline: true })];
  const s = track.latlngs[0], e = track.latlngs[track.latlngs.length - 1];
  tokens.push(view.addDot({ lat: s[0], lng: s[1], color: '#2f7d4f', title: '출발' }));
  tokens.push(view.addDot({ lat: e[0], lng: e[1], color, title: '도착' }));
  view.fitBounds(track.latlngs, 0.15);
  return tokens;
}

// inline SVG elevation profile
export function elevationSVG(track) {
  if (!track.hasEle) return '';
  const pts = track.points.filter((p) => Number.isFinite(p.ele));
  const W = 600, H = 90, pad = 6;
  const minE = Math.min(...pts.map((p) => p.ele));
  const maxE = Math.max(...pts.map((p) => p.ele));
  const span = Math.max(1, maxE - minE);
  const step = (W - pad * 2) / (pts.length - 1);
  let d = '';
  pts.forEach((p, i) => {
    const x = pad + i * step;
    const y = H - pad - ((p.ele - minE) / span) * (H - pad * 2);
    d += `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `${d}L${(pad + (pts.length - 1) * step).toFixed(1)},${H - pad}L${pad},${H - pad}Z`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="고도 프로파일">
    <path d="${area}" fill="var(--accent-soft)"/>
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    <text x="${pad}" y="12" font-size="10" fill="var(--text-faint)">${maxE}m</text>
    <text x="${pad}" y="${H - 2}" font-size="10" fill="var(--text-faint)">${minE}m</text>
  </svg>`;
}
