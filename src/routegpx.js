// 수집해 둔 코스별 경로 GPX 목록 — 상세 페이지의 "내려받기 + 지도에 표시" 섹션.
// 가벼운 목록 gpx/routes/index.json → 산별 상세 gpx/routes/m/<산id>.json 순으로 받는다.
//
// 이 파일들은 실측 GPS 기록이 아니라 OSM 등산로망 위에서 계산한 경로다. 그래서 자동으로
// 그리지 않고, 사용자가 "지도"를 눌렀을 때만 위쪽 등산로 목록에 합류시켜 주요 등산로와
// 겹쳐 볼 수 있게 한다. 목록·지도 어디서나 "계산" 표시가 따라붙는다.
import { el } from './dom.js';
import { fmtDist } from './geo.js';

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (ct.includes('html') || text.trimStart().startsWith('<!')) return null; // dev 서버 200 폴백
  return JSON.parse(text);
}

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
const fileName = (f) => f.split('/').pop();

// 누르면 위쪽 "등산로별 고도" 목록에 합류시킨다.
// 버튼 라벨은 "목록에 추가됨"까지만 말한다 — 지도 표시 여부는 그 목록의 토글이 주인이고,
// 거기서 끄면 여기 라벨이 "지도에 있음"으로 남아 거짓말이 되기 때문이다.
const markAdded = (btn) => { if (!btn) return; btn.textContent = '목록에 추가됨'; btn.classList.add('on'); btn.dataset.added = '1'; };

function showButton(onShow, payload, buttonsByFile) {
  if (!onShow) return null;
  const btn = el('button', { class: 'gpxdl-show', type: 'button', title: '위 등산로 목록에 올려 지도에 겹쳐 보기' }, '지도');
  // 같은 파일을 가리키는 행이 여럿일 수 있어(좌표가 같으면 파일을 공유) 파일별로 모아 둔다.
  const list = buttonsByFile.get(payload.file) || [];
  list.push(btn); buttonsByFile.set(payload.file, list);
  btn.addEventListener('click', async () => {
    if (btn.dataset.added) { await onShow(payload).catch(() => {}); return; }   // 다시 누르면 그 항목으로 이동
    btn.disabled = true;
    const before = btn.textContent;
    btn.textContent = '여는 중…';
    // 실패하면 상태를 바꾸지 않는다 — 목록에 없는데 "추가됨"이라고 하면 거짓말이 된다.
    try { await onShow(payload); (buttonsByFile.get(payload.file) || [btn]).forEach(markAdded); }
    catch { btn.textContent = before; }
    finally { btn.disabled = false; }
  });
  return btn;
}

function trackRow(t, base, onShow, buttonsByFile) {
  const meta = [
    km(t.distance_km),
    t.gain_m != null ? `↑${t.gain_m}m` : null,
    t.registry_distance_km != null ? `자료 ${t.registry_distance_km}km` : null,
  ].filter(Boolean).join(' · ');
  const label = (t.route_name || `코스 ${t.route_index}`) + (t.variant ? ` (대안 ${t.variant})` : '');
  return el('div', { class: 'gpxdl-item' + (t.status === 'review' ? ' review' : ''), title: (t.warnings || []).join(' / ') },
    // 산 페이지 안이므로 산 이름은 빼고 코스명만 — 파일 안 <name>에는 산 이름이 들어 있다.
    el('span', { class: 'gpxdl-name' }, label),
    el('span', { class: 'gpxdl-meta' }, meta),
    t.status === 'review' ? el('span', { class: 'gpxdl-badge' }, '검토 필요') : null,
    t.duplicate_of ? el('span', { class: 'gpxdl-badge dup' }, '동일 경로') : null,
    showButton(onShow, { file: t.file, label, route_name: t.route_name, variant: t.variant }, buttonsByFile),
    el('a', { class: 'gpxdl-dl', href: `${base}gpx/${t.file}`, download: fileName(t.file), title: '내려받기' }, '⬇'));
}

function relationRow(r, base, onShow, buttonsByFile) {
  const meta = [km(r.distance_km), r.summit_dist_m != null ? `정상에서 ${fmtDist(r.summit_dist_m)}` : null]
    .filter(Boolean).join(' · ');
  return el('div', { class: 'gpxdl-item rel' },
    el('span', { class: 'gpxdl-name' }, r.name),
    el('span', { class: 'gpxdl-meta' }, meta),
    showButton(onShow, { file: r.file, label: r.name }, buttonsByFile),
    el('a', { class: 'gpxdl-dl', href: `${base}gpx/${r.file}`, download: fileName(r.file), title: '내려받기' }, '⬇'));
}

/**
 * 섹션 요소를 즉시 반환하고 자료가 오면 채운다. 수록된 경로가 없으면 통째로 감춘다.
 * @param {object} [opts]
 * @param {(t:{file:string,label:string}) => Promise<void>} [opts.onShow]
 *        경로 하나를 등산로 목록에 올려 지도에 표시하는 콜백. 없으면 내려받기만 제공한다.
 * @param {(list:Array) => Promise<void>} [opts.onShowAll]
 *        여러 개를 한꺼번에 올리는 콜백. 목록·지도를 한 번만 갱신하도록 호출측이 모아 처리한다.
 */
export function routeDownloadSection(mountainId, { onShow, onShowAll } = {}) {
  const list = el('div', { class: 'gpxdl-list' });
  const actions = el('div', { class: 'gpxdl-actions' });
  const section = el('div', { class: 'section', hidden: true },
    el('h3', {}, '코스별 경로 GPX'),
    el('p', { class: 'conf-note', style: 'margin:-4px 0 10px' },
      '실측 GPS 기록이 아닙니다. 등록된 들머리에서 정상까지를 OpenStreetMap 등산로망 위에서 계산한 경로이며, '
      + '현장 통제·계절 통제·출입 제한을 반영하지 않을 수 있으니 산행 전 공식 안내를 함께 확인하세요. '
      + '“지도”를 누르면 위 “등산로별 고도” 목록에 더해져 주요 등산로와 겹쳐 볼 수 있습니다.'),
    actions, list);

  routeEntryFor(mountainId).then((entry) => {
    if (!entry) return;
    const tracks = entry.tracks || [];
    const rels = entry.relations || [];
    if (!tracks.length && !rels.length) return;
    const base = import.meta.env.BASE_URL;
    const buttonsByFile = new Map();   // 파일 → 그 파일을 가리키는 버튼들

    if (onShow && tracks.length) {
      // 파일이 같은 항목(좌표가 같아 공유하는 코스)은 한 번만 올린다.
      const uniq = [...new Map(tracks.map((t) => [t.file, t])).values()];
      const payloads = uniq.map((t) => ({
        file: t.file, route_name: t.route_name, variant: t.variant,
        label: (t.route_name || `코스 ${t.route_index}`) + (t.variant ? ` (대안 ${t.variant})` : ''),
      }));
      const allBtn = el('button', { class: 'btn', type: 'button' }, `계산 경로 ${uniq.length}개 모두 지도에 표시`);
      allBtn.addEventListener('click', async () => {
        allBtn.disabled = true;
        const before = allBtn.textContent;
        allBtn.textContent = '여는 중…';
        // 한꺼번에 넘겨 목록·지도를 한 번만 다시 그리게 한다(하나씩 부르면 그 횟수만큼 재생성된다).
        try {
          if (onShowAll) await onShowAll(payloads);
          else for (const p of payloads) await onShow(p).catch(() => {});
          for (const p of payloads) (buttonsByFile.get(p.file) || []).forEach(markAdded);
        } finally { allBtn.textContent = before; allBtn.disabled = false; }
      });
      actions.append(allBtn);
    }

    if (tracks.length) list.append(...tracks.map((t) => trackRow(t, base, onShow, buttonsByFile)));
    if (rels.length) {
      list.append(el('div', { class: 'gpxdl-sub' }, 'OpenStreetMap에 등록된 도보 경로(둘레길·순환길 등)'));
      list.append(...rels.map((r) => relationRow(r, base, onShow, buttonsByFile)));
    }
    section.append(el('p', { class: 'conf-note', style: 'margin-top:10px' },
      '선형 © OpenStreetMap contributors (ODbL 1.0) · 고도 SRTM 1 arc-second(NASA/USGS) 지형 DEM 추정값'));
    section.hidden = false;
  });

  return section;
}
