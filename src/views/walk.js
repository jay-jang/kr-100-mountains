// 걷기길 시트 #/walk/<rid>[?from=<산id>] — OpenStreetMap 노선 하나.
// peek: 제목 · "둘레길 · 순환 · 이 범위 20.5km (전체 270km)" · 출처·운영 상태 한 줄 · [카카오맵에서 위치 보기] [GPX 받기] · OpenStreetMap 링크
// half: (산에서 왔고 노선이 범위 밖으로 이어지면) [이 범위|전체 노선] · 고도 단면(누를 때 조회) · 지나는/가까운 명산 ·
//       같은 노선 다른 구간 · 노선 정보 · 출처(relation 번호, ODbL)
// 둘레길이라는 이유로 '쉬움'·소요 시간 추정을 붙이지 않는다(자료가 없다).
//
// 자료: 전국 상세 w/<rid>.json(노선 전체 선). 산에서 왔으면(?from) 그 산 파일의 같은 노선(정상·들머리 15km 안 부분)도
// 함께 읽어 "이 범위"를 보여 준다. 전국 상세가 없으면(alias.json의 'm:<산id>') 산 파일의 노선만으로 그린다.
import '../css/walk.css';
import { el, clear } from '../dom.js';
import { icon } from '../icons.js';
import { goUp, navigate } from '../router.js';
import { isDarkTheme } from '../prefs.js';
import { loadWalk, loadWalkAlias, loadWalkIndex, loadTrekIndex, loadMountainWalks, kindStyle, walkGpx, linesBounds, KIND_SHORT } from '../walkdata.js';
import { fetchElevations, resample, buildProfile, profileStats } from '../elevation.js';
import { profileChart, pointAlong } from '../mountain/chart.js';
import { setOwnDrawnWalk } from '../walklayer.js';
import { haversine } from '../gpx.js';

const kindShort = (w) => (w.kind === 'dulle' && w.long ? '장거리 걷기길' : KIND_SHORT[w.kind] || '걷기길');
const fmtKm = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n >= 100 ? `${Math.round(n)}km` : `${(Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '')}km`;
};
// 형태를 모르면 빼지 않고 "형태 미확인"이라고 적는다 — 왕복 계획에 필요한 정보가 비어 있다는 사실도 정보다.
const loopText = (w) => (w.loop === true ? '순환' : w.loop === false ? '편도' : '형태 미확인');

function pathLen(line) {
  let d = 0;
  for (let i = 1; i < line.length; i++) d += haversine(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
  return d;
}
const longest = (lines) => (lines || []).reduce((best, l) => (!best || pathLen(l) > pathLen(best) ? l : best), null);

/** 항목 사이에 ' · '를 글자로 끼운다(줄이 바뀌면 줄 끝에 남는다 — 다음 줄 첫머리에 점이 오지 않게). */
function dotted(nodes) {
  const out = [];
  nodes.forEach((n, i) => { if (i) out.push(el('span', { class: 'wk-sep', 'aria-hidden': 'true' }, ' · ')); out.push(n); });
  return out;
}

function saveText(text, filename, type = 'application/gpx+xml') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 산 파일의 노선 하나 → 상세 모양(전국 상세가 없을 때). */
function fromLocal(r, mid) {
  return {
    rid: r.rid, name: r.name, kind: r.kind, long: !!r.long, loop: r.loop ?? null,
    km: r.length_km, total_km: r.total_km ?? null, declared_km: r.declared_km ?? null, partial: !!r.partial,
    source: r.source, osm_ids: r.osm_ids || [], tags: r.operator ? { operator: r.operator } : {},
    links: r.links || {}, lines: r.lines || [], near: [{ id: mid, km: r.dist_km }], siblings: [],
    attribution: '© OpenStreetMap contributors (ODbL)', localOnly: true,
  };
}

async function findWalk(rid, fromId) {
  const [alias, index, trek] = await Promise.all([loadWalkAlias(), loadWalkIndex().catch(() => []), loadTrekIndex().catch(() => ({}))]);
  const target = alias[rid] || rid;
  // from 산의 파일이 없으면(색인에 없음) 읽지 않는다 — 없는 파일 404를 내지 않게.
  let localMid = fromId && (!Object.keys(trek).length || trek[fromId]) ? fromId : null;
  let walk = null;
  if (String(target).startsWith('m:')) localMid = localMid || target.slice(2);
  // 전국 목록에 없는 rid는 상세 파일을 요청하지 않는다(없는 파일 404를 내지 않게). 목록을 못 읽었으면 그냥 시도.
  else if (!index.length || index.some((x) => x.rid === target)) walk = await loadWalk(target);
  let local = null;
  if (localMid) {
    const mw = await loadMountainWalks(localMid);
    local = mw.routes.find((r) => r.rid === rid) || (walk ? mw.routes.find((r) => r.rid === walk.rid) : null) || null;
  }
  if (!walk && local) walk = fromLocal(local, localMid);
  return { walk, local, localMid };
}

export async function renderWalk(ctx, route) {
  const rid = route.id;
  const fromId = route.params.get('from');
  const fromM = fromId ? ctx.data.byId.get(fromId) : null;
  const back = () => goUp(fromM ? `#/m/${fromM.id}?tab=walks` : ctx.listHash());
  const close = () => (fromM ? navigate(ctx.listHash(), { replace: true }) : goUp(ctx.listHash()));

  ctx.setContent({
    header: el('div', { class: 'wk-head' }, el('p', { class: 'wk-loading', role: 'status' },
      el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' 걷기길을 불러오는 중…')),
    content: el('div'), label: '걷기길', detent: 'peek',
  });

  let found;
  try { found = await findWalk(rid, fromM?.id || null); } catch { found = { walk: null }; }
  if (ctx.disposed()) return {};
  const { walk: w, local } = found;
  if (!w || !w.lines?.length) return notFound(ctx, rid, back);

  // 산에서 왔고, 그 산 범위 밖으로 이어지는 노선이면 "이 범위"(산 파일의 잘린 선)를 먼저 보여 준다.
  const hasRange = !!(local && local.partial && local.lines?.length && !w.localOnly);
  let view = hasRange ? 'range' : 'full';
  const shown = () => (view === 'range' ? local.lines : w.lines);
  const totalKm = Number(w.total_km || w.km || local?.total_km) || null;

  // ---------- 머리(peek) ----------
  const title = el('h2', { class: 'sheet-title wk-title', tabindex: '-1' }, w.name);
  const backBtn = fromM ? el('button', { type: 'button', class: 'wk-back', 'aria-label': `${fromM.name} 시트로 돌아가기`, onClick: back },
    el('span', { class: 'wk-back-ic', html: icon('back') }), el('span', { class: 'wk-back-name' }, fromM.name)) : null;
  const closeBtn = el('button', { type: 'button', class: 'icon-btn', 'aria-label': '닫고 목록으로', title: '닫고 목록으로', html: icon('close'), onClick: close });
  const facts = el('p', { class: 'wk-facts' });
  const swatchStyle = () => kindStyle(w.kind, { long: w.long, dark: isDarkTheme() });
  const prov = el('p', { class: 'wk-prov' }, ...dotted([
    el('span', { class: 'wk-prov-tag', style: `--c:${swatchStyle().color}` }, w.source === 'named-ways' ? 'OpenStreetMap 이름 붙은 길' : 'OpenStreetMap 노선'),
    el('span', {}, '운영·통제 상태 미확인')]));

  const kakaoBtn = el('a', { class: 'btn small', target: '_blank', rel: 'noopener' }, '카카오맵에서 위치 보기');
  const gpxBtn = el('button', { type: 'button', class: 'btn small' }, el('span', { html: icon('download', { size: 18 }) }), 'GPX 받기');
  const osmUrl = w.links?.osm || (w.osm_ids?.[0] ? `https://www.openstreetmap.org/${w.source === 'named-ways' ? 'way' : 'relation'}/${w.osm_ids[0]}` : null);
  const osmLink = osmUrl ? el('a', { class: 'text-link wk-osm', href: osmUrl, target: '_blank', rel: 'noopener' },
    'OpenStreetMap에서 보기', el('span', { class: 'wk-ext', html: icon('external', { size: 16 }) })) : null;
  const header = el('div', { class: 'wk-head' },
    el('div', { class: 'wk-top' + (backBtn ? '' : ' no-back') }, backBtn, title, closeBtn),
    facts, prov,
    el('div', { class: 'wk-actions' }, kakaoBtn, gpxBtn, osmLink));

  function paintHead() {
    const parts = [kindShort(w), loopText(w)];
    if (view === 'range') {
      const here = fmtKm(local.length_km);
      parts.push(totalKm && totalKm > Number(local.length_km) ? `이 범위 ${here} (전체 ${fmtKm(totalKm)})` : `이 범위 ${here} (일부 구간)`);
    } else if (w.localOnly && w.partial) {
      parts.push(`이 범위 ${fmtKm(w.km)}${totalKm && totalKm > w.km ? ` (전체 ${fmtKm(totalKm)})` : ' (일부 구간)'}`);
    } else {
      parts.push(fmtKm(totalKm || w.km));
    }
    clear(facts).append(...dotted(parts.filter(Boolean).map((t) => el('span', { class: 'tabular' }, t))));
    const pt = entryPoint();
    kakaoBtn.href = pt ? `https://map.kakao.com/link/map/${encodeURIComponent(w.name.replace(/,/g, ' '))},${pt[0]},${pt[1]}` : 'https://map.kakao.com/';
    kakaoBtn.title = view === 'range' && fromM ? `${fromM.name}에서 가장 가까운 지점` : '노선 시작 지점';
  }
  /** 카카오맵 위치: 산에서 왔으면 그 산에 가장 가까운 지점, 아니면 노선 시작점. 목적지로 지정하지 않고 위치만 보여 준다. */
  function entryPoint() {
    if (view === 'range' && local?.entry) return local.entry;
    if (w.localOnly && local?.entry) return local.entry;
    return w.start || longest(shown())?.[0] || null;
  }
  gpxBtn.addEventListener('click', () => {
    const range = view === 'range';
    saveText(walkGpx({ name: range && fromM ? `${w.name} (${fromM.name} 주변)` : w.name, lines: shown(), partial: range || w.partial }),
      `${w.rid}${range ? `-${fromM?.id || 'range'}` : ''}.gpx`);
  });

  // ---------- 본문(half) ----------
  const rangeSeg = hasRange ? el('div', { class: 'seg wk-range', role: 'group', 'aria-label': '보여 줄 구간' },
    ...[['range', `${fromM?.name || '산'} 주변`], ['full', '전체 노선']].map(([k, label]) =>
      el('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(view === k), dataset: { v: k },
        onClick: () => setView(k) }, label))) : null;
  const elevBox = el('div', { class: 'wk-sec wk-elev' });
  const nearBox = el('div', { class: 'wk-sec' });
  const sibBox = el('div', { class: 'wk-sec' });
  const infoBox = el('div', { class: 'wk-sec' });
  const srcBox = el('div', { class: 'wk-sec wk-src' });
  const content = el('div', { class: 'wk-body' }, rangeSeg, elevBox, nearBox, sibBox, infoBox, srcBox);

  let elevSeq = 0, chart = null, chartTok = null;
  function chartPoint(pt) {
    if (chartTok) { ctx.layers.remove(chartTok); chartTok = null; }
    if (!pt || !ctx.view || ctx.disposed()) return;
    chartTok = ctx.layers.add(ctx.view.addDot({ lat: pt[0], lng: pt[1], color: isDarkTheme() ? '#e7eadd' : '#23332b', title: '단면에서 고른 지점', radius: 6 }));
  }
  function paintElev() {
    const my = ++elevSeq;
    chart?.destroy?.(); chart = null; chartPoint(null);
    const btn = el('button', { type: 'button', class: 'btn small' }, '고도 단면 보기');
    clear(elevBox).append(el('h3', { class: 'wk-h' }, '고도 단면'), btn,
      el('p', { class: 'wk-fine' }, '누르면 지형 고도를 조회합니다(open-meteo, 추정값).'));
    btn.addEventListener('click', async () => {
      const lines = shown();
      const main = longest(lines);
      if (!main || main.length < 2) return;
      btn.disabled = true;
      clear(btn).append(el('span', { class: 'spinner', 'aria-hidden': 'true' }), ' 조회하는 중…');
      // 표본 수: 0.5 km마다 하나(60~300개). 고도 API는 100개씩 묶어 부른다.
      const mainM = pathLen(main);
      const n = Math.max(60, Math.min(300, Math.ceil(mainM / 500)));
      const sampled = resample(main, n);
      try {
        const eles = await fetchElevations(sampled);
        if (ctx.disposed() || my !== elevSeq) return;
        const p = buildProfile(sampled, eles);
        if (!p) throw new Error('no profile');
        // 표본 사이를 직선으로 이으면 길이가 줄어든다 → 가로축을 실제 선 길이에 맞춘다.
        const k = p.dist_m > 0 ? mainM / p.dist_m : 1;
        p.pts.forEach((q) => { q.d *= k; });
        p.dist_m = mainM;
        p.avgGrade = mainM ? (p.gain_m / mainM) * 100 : 0;
        const total = lines.reduce((acc, l) => acc + pathLen(l), 0);
        const spacing = mainM / Math.max(1, sampled.length - 1);
        let raf = 0;
        chart = profileChart(p, { onPoint: (d) => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => chartPoint(pointAlong(sampled, d / k)));
        } });
        clear(elevBox).append(el('h3', { class: 'wk-h' }, '고도 단면'), chart, profileStats(p),
          el('p', { class: 'wk-fine' }, [
            '고도: open-meteo 지형 고도 추정값(실측 아님)',
            spacing > 300 ? `표본 간격 약 ${fmtKm(spacing / 1000)}라 누적 상승은 실제보다 작게 나옵니다` : null,
            lines.length > 1 && mainM < total * 0.98 ? `선이 ${lines.length}조각으로 나뉘어 가장 긴 조각(${fmtKm(mainM / 1000)})만 그렸습니다` : null,
          ].filter(Boolean).join(' · ')));
      } catch {
        if (ctx.disposed() || my !== elevSeq) return;
        btn.disabled = false; btn.textContent = '다시 시도';
        elevBox.append(el('p', { class: 'wk-fine', role: 'status' }, '고도를 확인하지 못했습니다. 선과 GPX는 그대로 쓸 수 있습니다.'));
      }
    });
  }

  function paintNear() {
    const near = (w.near || []).map((n) => ({ ...n, m: ctx.data.byId.get(n.id) })).filter((n) => n.m);
    clear(nearBox);
    if (!near.length) return;
    const passes = near.filter((n) => n.passes || n.km <= 0.3);
    const rows = el('div', { class: 'rows', role: 'list' });
    const SHOW = 6;
    const row = (n) => el('a', { class: 'row wk-row', href: `#/m/${n.m.id}` },
      el('div', { class: 'row-main' },
        el('span', { class: 'row-title' }, n.m.name_full),
        el('span', { class: 'row-num' }, `${Math.round(n.m.elevation_m).toLocaleString()}m`)),
      el('div', { class: 'row-meta' },
        el('span', {}, n.m.region),
        el('span', { class: 'tabular' }, n.passes || n.km <= 0.3 ? '정상을 지남' : `노선에서 ${fmtKm(n.km)}`)));
    // 항목은 <a>를 감싼 div — <a>에 listitem을 주면 링크라는 사실이 화면 읽기 프로그램에서 사라진다
    const item = (node) => el('div', { role: 'listitem' }, node);
    near.slice(0, SHOW).forEach((n) => rows.append(item(row(n))));
    nearBox.append(el('h3', { class: 'wk-h' }, passes.length ? '지나는·가까운 명산' : '가까운 명산'), rows);
    if (near.length > SHOW) {
      const more = el('button', { type: 'button', class: 'text-link block' }, `모두 보기 (${near.length}곳)`);
      more.addEventListener('click', () => { near.slice(SHOW).forEach((n) => rows.append(item(row(n)))); more.remove(); });
      nearBox.append(more);
    }
    nearBox.append(el('p', { class: 'wk-fine' }, '정상에서 노선까지 직선거리(30km 안)'));
  }

  function paintSiblings() {
    clear(sibBox);
    const sib = w.siblings || [];
    if (!sib.length) return;
    const dark = isDarkTheme();
    const rows = el('div', { class: 'rows', role: 'list' });
    const SHOW = 8;
    const q = fromM ? `?from=${encodeURIComponent(fromM.id)}` : '';
    const row = (s) => el('a', { class: 'row wk-row', href: `#/walk/${encodeURIComponent(s.rid)}${q}` },
      el('div', { class: 'row-main' },
        el('span', { class: 'swatch', style: `--c:${kindStyle(s.kind, { long: s.long, dark }).color}`, 'aria-hidden': 'true' }),
        el('span', { class: 'row-title' }, s.name),
        el('span', { class: 'row-num' }, fmtKm(s.km))));
    const item = (node) => el('div', { role: 'listitem' }, node);
    sib.slice(0, SHOW).forEach((s) => rows.append(item(row(s))));
    sibBox.append(el('h3', { class: 'wk-h' }, `같은 노선 다른 구간 ${sib.length}`), rows);
    if (sib.length > SHOW) {
      const more = el('button', { type: 'button', class: 'text-link block' }, `모두 보기 (${sib.length}구간)`);
      more.addEventListener('click', () => { sib.slice(SHOW).forEach((s) => rows.append(item(row(s)))); more.remove(); });
      sibBox.append(more);
    }
  }

  function paintInfo() {
    clear(infoBox);
    const t = w.tags || {};
    const kv = (k, ...v) => el('div', { class: 'wk-kv' }, el('span', { class: 'wk-k' }, k), el('span', { class: 'wk-v' }, ...v));
    const ext = (href, text) => el('a', { href, target: '_blank', rel: 'noopener' }, text);
    const items = [
      t.from && t.to ? kv('시작·끝', `${t.from} – ${t.to}`) : null,
      t.operator ? kv('관리', t.operator) : null,
      w.declared_km && Math.abs(w.declared_km - w.km) / w.declared_km > 0.1 ? kv('표기 거리', `${fmtKm(w.declared_km)} (OSM distance 태그) · 지도 선 ${fmtKm(w.km)}`) : null,
      w.links?.website ? kv('누리집', ext(w.links.website, w.links.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))) : null,
      w.links?.wikipedia ? kv('위키백과', ext(w.links.wikipedia, decodeURIComponent(w.links.wikipedia.split('/wiki/')[1] || '').replace(/_/g, ' '))) : null,
      w.partial && !w.localOnly ? kv('선 상태', 'OpenStreetMap에 일부 구간만 등록되어 있습니다') : null,
      (w.pieces || w.lines.length) > 1 ? kv('선 조각', `${w.pieces || w.lines.length}개로 나뉘어 있습니다(등록 자료의 끊긴 곳)`) : null,
    ].filter(Boolean);
    if (items.length) infoBox.append(el('h3', { class: 'wk-h' }, '노선 정보'), ...items);
  }

  function paintSource() {
    clear(srcBox);
    const ids = w.osm_ids || [];
    const kind = w.source === 'named-ways' ? 'way' : 'relation';
    const idLinks = ids.slice(0, 3).flatMap((id, i) => [i ? ', ' : '', el('a', { href: `https://www.openstreetmap.org/${kind}/${id}`, target: '_blank', rel: 'noopener' }, String(id))]);
    srcBox.append(el('h3', { class: 'wk-h' }, '출처'),
      el('p', { class: 'wk-fine' }, `OpenStreetMap ${kind === 'way' ? '길(way)' : '노선 관계(relation)'} `, ...idLinks,
        ids.length > 3 ? ` 외 ${ids.length - 3}개` : '', ` · ${w.attribution || '© OpenStreetMap contributors (ODbL)'}`),
      el('p', { class: 'wk-fine' }, w.note || '실측 기록이 아니며 운영·통제 상태를 반영하지 않습니다. 나서기 전에 현지 안내와 통제 공지를 확인하세요.'),
      hasRange ? el('p', { class: 'wk-fine' }, `${fromM.name} 주변: 정상·들머리에서 ${local.dist_km ?? '–'}km, 반경 15km 안 부분`) : null);
  }

  // ---------- 지도 ----------
  let layerToks = [];
  const nearIds = new Set((w.near || []).filter((n) => n.km <= 15).slice(0, 12).map((n) => n.id));
  if (fromM) nearIds.add(fromM.id);
  function markNear() {
    for (const id of nearIds) document.querySelectorAll(`.mk[data-id="${CSS.escape(id)}"]`).forEach((n) => n.classList.add('walk-near'));
  }
  function draw({ fit = false } = {}) {
    ctx.whenMap((map) => {
      if (ctx.disposed()) return;
      layerToks.forEach((t) => ctx.layers.remove(t)); layerToks = [];
      const dark = isDarkTheme();
      const st = kindStyle(w.kind, { long: w.long, dark, selected: true });
      const base = kindStyle(w.kind, { long: w.long, dark });
      const add = (t) => { if (t) layerToks.push(ctx.layers.add(t)); };
      if (view === 'range') add(map.addPolylines(w.lines, { color: base.color, weight: Math.max(2, base.weight - 1), opacity: 0.45 }));
      const lines = shown();
      if (lines.length <= 400) for (const l of lines) add(map.addPolyline(l, { color: st.color, weight: st.weight, opacity: 1, outline: true }));
      else add(map.addPolylines(lines, { color: st.color, weight: st.weight, opacity: 1 }));
      const main = longest(lines);
      const total = lines.reduce((acc, l) => acc + pathLen(l), 0);
      if (view === 'range' && local?.entry) {
        // 범위 끝은 원으로 자른 자리라 '시작·끝'이 아니다 — 산에서 가장 가까운 지점만 찍는다.
        add(map.addDot({ lat: local.entry[0], lng: local.entry[1], color: st.color, title: '가까운 지점' }));
        add(map.addLabel({ lat: local.entry[0], lng: local.entry[1], text: '가까운 지점', kind: 'peak' }));
      } else if (main && pathLen(main) >= total * 0.9) {
        // 선이 여러 조각이면(가장 긴 조각이 90% 미만) 어디가 시작인지 알 수 없어 표시하지 않는다.
        const a = main[0], b = main[main.length - 1];
        const isLoop = w.loop === true;
        add(map.addDot({ lat: a[0], lng: a[1], color: st.color, title: isLoop ? '시작·끝' : '시작' }));
        add(map.addLabel({ lat: a[0], lng: a[1], text: isLoop ? '시작·끝' : '시작', kind: 'peak' }));
        if (!isLoop && haversine(a[0], a[1], b[0], b[1]) > 150) {
          add(map.addDot({ lat: b[0], lng: b[1], color: dark ? '#e7eadd' : '#23332b', title: '끝' }));
          add(map.addLabel({ lat: b[0], lng: b[1], text: '끝', kind: 'peak' }));
        }
      }
      if (fit) {
        const bb = linesBounds(lines);
        if (bb) ctx.fit(bb, { maxZoom: 14 });
      }
    });
  }

  function setView(v) {
    if (v === view) return;
    view = v;
    rangeSeg?.querySelectorAll('.seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === view)));
    paintHead();
    paintElev();
    draw({ fit: true });
  }

  paintHead(); paintElev(); paintNear(); paintSiblings(); paintInfo(); paintSource();
  ctx.setContent({ header, content, label: `${w.name} 걷기길`, detent: 'peek' });
  document.title = `${w.name} · 대한민국 100대 명산`;
  const a = document.activeElement;
  if (!(a && a.matches?.('input, textarea, select'))) requestAnimationFrame(() => title.focus({ preventScroll: true }));

  ctx.setMarkers({ dim: true, selectedId: null });
  markNear();
  ctx.onMove(markNear);
  setOwnDrawnWalk(w.rid);          // 이 노선은 아래 draw()가 상세 선으로 그린다
  ctx.setWalkHighlight(w.rid);
  draw({ fit: true });
  const onTheme = () => { draw(); paintSiblings(); prov.querySelector('.wk-prov-tag')?.style.setProperty('--c', swatchStyle().color); };
  window.addEventListener('kr100:theme', onTheme);

  return {
    onEscape: back,
    update: () => false,
    dispose() {
      elevSeq++;
      chart?.destroy?.();
      setOwnDrawnWalk(null);
      window.removeEventListener('kr100:theme', onTheme);
      document.querySelectorAll('.mk.walk-near').forEach((n) => n.classList.remove('walk-near'));
    },
  };
}

function notFound(ctx, rid, back) {
  const header = el('div', { class: 'wk-head' }, el('div', { class: 'sheet-headline' },
    el('div', { class: 'sheet-titles' }, el('h2', { class: 'sheet-title', tabindex: '-1' }, '걷기길을 찾을 수 없습니다'),
      el('p', { class: 'sheet-sub' }, `‘${rid}’ 노선 자료가 없습니다. 자료가 갱신되며 바뀌었을 수 있습니다.`)),
    el('button', { type: 'button', class: 'icon-btn', 'aria-label': '닫기', html: icon('close'), onClick: back })));
  ctx.setContent({ header, content: el('div', { class: 'empty' }, el('a', { class: 'btn', href: '#/map?mode=walk' }, '걷기길 지도 보기')), label: '걷기길을 찾을 수 없음', detent: 'peek' });
  return { onEscape: back };
}
