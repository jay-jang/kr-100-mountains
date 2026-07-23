// 경로별 고도 프로파일 — 실제 데이터만 사용(GPX 고도, 또는 open-meteo로 실제 좌표의 고도 조회).
import { haversine } from './gpx.js';
import { el } from './dom.js';

// open-meteo 고도 API(무료·키 없음·CORS). latlngs → 고도 배열(m). 배치 100.
export async function fetchElevations(latlngs) {
  const out = new Array(latlngs.length).fill(null);
  const CH = 100;
  for (let i = 0; i < latlngs.length; i += CH) {
    const chunk = latlngs.slice(i, i + CH);
    const lat = chunk.map((p) => p[0].toFixed(5)).join(',');
    const lon = chunk.map((p) => p[1].toFixed(5)).join(',');
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    if (!res.ok) throw new Error('고도 데이터를 불러오지 못했습니다');
    const j = await res.json();
    (j.elevation || []).forEach((e, k) => { out[i + k] = e; });
  }
  return out;
}

// 선(latlngs)을 최대 maxPts개로 리샘플(모양 유지) — API 호출량 절감
export function resample(latlngs, maxPts = 60) {
  if (latlngs.length <= maxPts) return latlngs.slice();
  const step = (latlngs.length - 1) / (maxPts - 1);
  const out = [];
  for (let i = 0; i < maxPts; i++) out.push(latlngs[Math.round(i * step)]);
  return out;
}

// {누적거리 d(m), 고도 ele} 시리즈 + 통계
export function buildProfile(latlngs, eles) {
  const pts = []; let d = 0;
  for (let i = 0; i < latlngs.length; i++) {
    if (i) d += haversine(latlngs[i - 1][0], latlngs[i - 1][1], latlngs[i][0], latlngs[i][1]);
    if (eles[i] != null && Number.isFinite(eles[i])) pts.push({ d, ele: eles[i] });
  }
  if (pts.length < 2) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i < pts.length; i++) { const dz = pts[i].ele - pts[i - 1].ele; if (dz > 0) gain += dz; else loss -= dz; }
  const arr = pts.map((p) => p.ele);
  const dist = pts[pts.length - 1].d;
  return {
    pts, dist_m: dist, gain_m: Math.round(gain), loss_m: Math.round(loss),
    min: Math.round(Math.min(...arr)), max: Math.round(Math.max(...arr)),
    avgGrade: dist ? (gain / dist) * 100 : 0,
  };
}

// GPX 파싱 결과(track)에 고도가 있으면 바로 프로파일 생성
export function profileFromTrack(track) {
  if (!track?.hasEle) return null;
  return buildProfile(track.latlngs, track.points.map((p) => p.ele));
}

const fmtKm = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + 'km' : Math.round(m) + 'm');

// 인터랙티브 고도 차트 요소 반환(마우스/터치 시 거리·고도 표시)
export function elevationChart(profile) {
  const W = 760, H = 210, padL = 46, padR = 14, padT = 16, padB = 28;
  const { pts, dist_m, min, max } = profile;
  const span = Math.max(1, max - min);
  const X = (d) => padL + (d / dist_m) * (W - padL - padR);
  const Y = (e) => H - padB - ((e - min) / span) * (H - padT - padB);

  let line = '';
  pts.forEach((p, i) => { line += `${i ? 'L' : 'M'}${X(p.d).toFixed(1)},${Y(p.ele).toFixed(1)}`; });
  const area = `${line}L${X(dist_m).toFixed(1)},${H - padB}L${padL},${H - padB}Z`;

  // y축 눈금(최저/중간/최고), x축(0/중간/전체)
  const yTicks = [min, Math.round((min + max) / 2), max];
  const yLines = yTicks.map((e) => `<line x1="${padL}" y1="${Y(e).toFixed(1)}" x2="${W - padR}" y2="${Y(e).toFixed(1)}" class="elev-grid"/>`).join('');
  const yLabels = yTicks.map((e) => `<text x="${padL - 6}" y="${(Y(e) + 3).toFixed(1)}" text-anchor="end" class="elev-axis">${e}</text>`).join('');
  const xTicks = [0, dist_m / 2, dist_m];
  const xLabels = xTicks.map((d) => `<text x="${X(d).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="elev-axis">${fmtKm(d)}</text>`).join('');

  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="elev-svg" role="img" aria-label="고도 프로파일">
    ${yLines}
    <path d="${area}" class="elev-area"/>
    <path d="${line}" class="elev-line"/>
    ${yLabels}${xLabels}
    <g class="elev-cursor" style="display:none">
      <line class="elev-cursor-line" y1="${padT}" y2="${H - padB}"/>
      <circle class="elev-cursor-dot" r="4"/>
    </g>
  </svg>`;

  const HINT = '그래프를 누르거나 마우스를 올리면 지점별 거리·고도가 표시됩니다';
  const readout = el('div', { class: 'elev-readout' }, HINT);
  const wrap = el('div', { class: 'elev-chart' });
  wrap.innerHTML = svg;
  wrap.append(readout);
  const svgEl = wrap.querySelector('svg');
  const cursor = wrap.querySelector('.elev-cursor');
  const cLine = wrap.querySelector('.elev-cursor-line');
  const cDot = wrap.querySelector('.elev-cursor-dot');

  function move(clientX) {
    const r = svgEl.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    const dTarget = Math.min(dist_m, Math.max(0, ((px - padL) / (W - padL - padR)) * dist_m));
    // nearest point
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].d < dTarget) lo = mid; else hi = mid; }
    const p = (dTarget - pts[lo].d) < (pts[hi].d - dTarget) ? pts[lo] : pts[hi];
    cursor.style.display = '';
    cLine.setAttribute('x1', X(p.d)); cLine.setAttribute('x2', X(p.d));
    cDot.setAttribute('cx', X(p.d)); cDot.setAttribute('cy', Y(p.ele));
    readout.innerHTML = `거리 <b>${fmtKm(p.d)}</b> · 고도 <b>${Math.round(p.ele)}m</b>`;
  }
  const onPointer = (e) => { move(e.clientX); if (e.pointerType !== 'mouse') e.preventDefault(); };
  svgEl.addEventListener('pointerdown', onPointer);   // 터치 탭도 지점 표시
  svgEl.addEventListener('pointermove', onPointer);
  // 마우스가 벗어나면 초기화, 터치는 마지막 지점 유지(손을 떼도 값이 남도록)
  svgEl.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { cursor.style.display = 'none'; readout.innerHTML = HINT; } });
  return wrap;
}

export function profileStats(profile) {
  const stat = (v, l) => el('div', { class: 'elev-stat' }, el('b', {}, v), el('span', {}, l));
  return el('div', { class: 'elev-stats' },
    stat(fmtKm(profile.dist_m), '거리'),
    stat(`${profile.gain_m}m`, '누적 상승'),
    stat(`${profile.min}~${profile.max}m`, '고도 범위'),
    stat(`${profile.avgGrade.toFixed(1)}%`, '평균 경사'));
}
