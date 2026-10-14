// 경로 시트의 고도 단면 — 120px 높이, 실제 픽셀 폭으로 다시 그려 글자가 늘어나지 않게 한다.
// 자료(profile)는 elevation.js의 buildProfile/profileFromTrack 결과 { pts:[{d,ele}], dist_m, min, max, gain_m }.
// 누르고 끌거나(←/→ 키) 마우스를 올리면 그 지점의 거리·고도를 적고 onPoint(d)로 지도에 점을 찍게 한다.
import { el } from '../dom.js';

const H = 120, PAD = { l: 40, r: 10, t: 10, b: 20 };
const fmt = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`);

export function profileChart(profile, { onPoint } = {}) {
  const { pts, dist_m, min, max } = profile;
  const readout = el('p', { class: 'pc-readout', 'aria-live': 'polite' }, '단면을 누르고 끌면 지도에 그 지점이 표시됩니다.');
  const svgHost = el('div', { class: 'pc-svg' });
  const wrap = el('div', { class: 'pc', tabindex: '0', role: 'group',
    'aria-label': `고도 단면: 거리 ${fmt(dist_m)}, 최저 ${min}m, 최고 ${max}m. 왼쪽·오른쪽 화살표로 지점 이동` }, svgHost, readout);
  let W = 0, cursor = null, current = -1;
  const span = Math.max(1, max - min);
  const X = (d) => PAD.l + (d / dist_m) * (W - PAD.l - PAD.r);
  const Y = (e) => H - PAD.b - ((e - min) / span) * (H - PAD.t - PAD.b);

  function draw() {
    W = Math.max(200, Math.round(svgHost.clientWidth || 320));
    let line = '';
    pts.forEach((p, i) => { line += `${i ? 'L' : 'M'}${X(p.d).toFixed(1)},${Y(p.ele).toFixed(1)}`; });
    const area = `${line}L${X(dist_m).toFixed(1)},${H - PAD.b}L${PAD.l},${H - PAD.b}Z`;
    const yTicks = [min, max];
    const grid = yTicks.map((e) => `<line class="pc-grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(e).toFixed(1)}" y2="${Y(e).toFixed(1)}"/>`).join('');
    const yl = yTicks.map((e) => `<text class="pc-axis" x="${PAD.l - 5}" y="${(Y(e) + 4).toFixed(1)}" text-anchor="end">${e}</text>`).join('');
    const xl = [[0, 'start'], [dist_m / 2, 'middle'], [dist_m, 'end']]
      .map(([d, a]) => `<text class="pc-axis" x="${X(d).toFixed(1)}" y="${H - 5}" text-anchor="${a}">${fmt(d)}</text>`).join('');
    svgHost.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">
      ${grid}<path class="pc-area" d="${area}"/><path class="pc-line" d="${line}"/>${yl}${xl}
      <g class="pc-cursor" style="display:none"><line class="pc-cursor-line" y1="${PAD.t}" y2="${H - PAD.b}"/><circle class="pc-cursor-dot" r="4"/></g></svg>`;
    cursor = svgHost.querySelector('.pc-cursor');
    if (current >= 0) show(current, false);
  }

  function nearest(d) {
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].d < d) lo = mid; else hi = mid; }
    return d - pts[lo].d < pts[hi].d - d ? lo : hi;
  }
  function show(i, notify = true) {
    current = i;
    const p = pts[i];
    if (!cursor) return;
    cursor.style.display = '';
    const x = X(p.d).toFixed(1);
    const l = cursor.querySelector('line'), c = cursor.querySelector('circle');
    l.setAttribute('x1', x); l.setAttribute('x2', x);
    c.setAttribute('cx', x); c.setAttribute('cy', Y(p.ele).toFixed(1));
    readout.textContent = `거리 ${fmt(p.d)} · 고도 ${Math.round(p.ele).toLocaleString('ko-KR')}m`;
    if (notify) onPoint?.(p.d);
  }
  function fromPointer(e) {
    const r = svgHost.getBoundingClientRect();
    const d = Math.min(dist_m, Math.max(0, ((e.clientX - r.left - PAD.l) / (W - PAD.l - PAD.r)) * dist_m));
    show(nearest(d));
  }
  let pressed = false;
  svgHost.addEventListener('pointerdown', (e) => { pressed = true; try { svgHost.setPointerCapture(e.pointerId); } catch {} fromPointer(e); });
  svgHost.addEventListener('pointermove', (e) => { if (pressed || e.pointerType === 'mouse') fromPointer(e); });
  const up = () => { pressed = false; };
  svgHost.addEventListener('pointerup', up);
  svgHost.addEventListener('pointercancel', up);
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const step = Math.max(1, Math.round(pts.length / 40));
    const i = e.key === 'Home' ? 0 : e.key === 'End' ? pts.length - 1
      : Math.max(0, Math.min(pts.length - 1, (current < 0 ? 0 : current) + (e.key === 'ArrowRight' ? step : -step)));
    show(i);
  });

  const ro = new ResizeObserver(() => { if (Math.round(svgHost.clientWidth) !== W && svgHost.clientWidth > 0) draw(); });
  ro.observe(svgHost);
  requestAnimationFrame(draw);
  wrap.destroy = () => ro.disconnect();
  return wrap;
}

/** 누적 거리 d(m)에 해당하는 선 위의 점. */
export function pointAlong(latlngs, d) {
  if (!latlngs?.length) return null;
  const R = 6371000, rad = Math.PI / 180;
  let acc = 0;
  for (let i = 1; i < latlngs.length; i++) {
    const [a1, o1] = latlngs[i - 1], [a2, o2] = latlngs[i];
    const x = (o2 - o1) * rad * Math.cos(((a1 + a2) / 2) * rad), y = (a2 - a1) * rad;
    const seg = Math.sqrt(x * x + y * y) * R;
    if (acc + seg >= d) {
      const f = seg ? (d - acc) / seg : 0;
      return [a1 + (a2 - a1) * f, o1 + (o2 - o1) * f];
    }
    acc += seg;
  }
  return latlngs.at(-1);
}
