import { loadData, REGION_COLORS } from '../data.js';
import { hikedMap, hikedCount, toggleHiked, exportHiked, importHiked, clearHiked, onChange } from '../store.js';
import { el, clear } from '../dom.js';

const REGIONS = ['수도권', '강원', '충청', '전라', '경상', '제주'];

export async function renderStats(root) {
  const data = await loadData();
  const page = el('div', { class: 'page' });
  root.append(page);

  const body = el('div');
  page.append(
    el('div', { class: 'crumb' }, el('a', { href: '#/' }, '← 지도로')),
    el('h2', { style: 'margin:.1em 0 .4em;letter-spacing:-.03em' }, '나의 등정 기록'),
    el('p', { class: 'prose muted', style: 'margin-top:0' }, '기록은 이 브라우저에만 저장됩니다 (localStorage).'),
    body);

  function draw() {
    clear(body);
    const hiked = hikedMap();
    const ids = new Set(Object.keys(hiked));
    const all = data.mountains;
    const sanlim = all.filter((m) => m.lists.sanlim);
    const bac = all.filter((m) => m.lists.bac);
    const cS = sanlim.filter((m) => ids.has(m.id)).length;
    const cB = bac.filter((m) => ids.has(m.id)).length;
    const cAll = all.filter((m) => ids.has(m.id)).length;

    body.append(el('div', { class: 'stat-grid' },
      statCard('산림청 100대 명산', cS, sanlim.length),
      statCard('블랙야크 명산100', cB, bac.length),
      statCard('전체 명산', cAll, all.length)));

    // region breakdown
    const bars = el('div', { class: 'region-bars' });
    REGIONS.forEach((r) => {
      const inR = all.filter((m) => m.region === r);
      const done = inR.filter((m) => ids.has(m.id)).length;
      const pct = inR.length ? (done / inR.length) * 100 : 0;
      bars.append(el('div', { class: 'region-bar' },
        el('span', {}, r),
        el('span', { class: 'track' }, el('span', { style: `width:${pct}%;background:${REGION_COLORS[r]}` })),
        el('span', { class: 'num' }, `${done}/${inR.length}`)));
    });
    body.append(el('div', { class: 'section' }, el('h3', {}, '지역별 진행'), bars));

    // hiked list
    const hikedMtns = all.filter((m) => ids.has(m.id))
      .map((m) => ({ m, date: hiked[m.id] }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const listSec = el('div', { class: 'section' }, el('h3', {}, `등정한 산 (${hikedMtns.length})`));
    if (!hikedMtns.length) {
      listSec.append(el('div', { class: 'empty' }, '아직 기록이 없습니다. 산 상세 페이지에서 “등정 기록”을 눌러 보세요.'));
    } else {
      const grid = el('div', { class: 'mtn-list', style: 'max-height:none' });
      hikedMtns.forEach(({ m, date }) => {
        grid.append(el('div', { class: 'mtn-item' },
          el('span', { class: 'mtn-rank', style: `background:${REGION_COLORS[m.region]}` }),
          el('div', { class: 'mtn-body' },
            el('a', { class: 'mtn-name', href: `#/m/${m.id}` }, m.name_full),
            el('div', { class: 'mtn-meta' }, el('span', {}, `${Math.round(m.elevation_m)}m`),
              el('span', {}, m.province), el('span', {}, date))),
          el('button', { class: 'btn', onClick: () => toggleHiked(m.id, false) }, '해제')));
      });
      listSec.append(grid);
    }
    body.append(listSec);

    // data actions
    const actions = el('div', { class: 'data-actions' },
      el('button', { class: 'btn primary', onClick: doExport }, '내보내기 (JSON)'),
      el('button', { class: 'btn', onClick: doImport }, '가져오기'),
      el('button', { class: 'btn', onClick: () => { if (confirm('모든 기록을 삭제할까요?')) clearHiked(); } }, '전체 삭제'));
    body.append(el('div', { class: 'section' }, el('h3', {}, '데이터'), actions));
  }

  function doExport() {
    const blob = new Blob([exportHiked()], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'kr100-hiked.json' });
    document.body.append(a); a.click(); a.remove();
  }
  function doImport() {
    const inp = el('input', { type: 'file', accept: '.json' });
    inp.addEventListener('change', async (e) => {
      const f = e.target.files?.[0]; if (!f) return;
      try { importHiked(await f.text()); } catch { alert('가져오기 실패: 올바른 JSON이 아닙니다.'); }
    });
    inp.click();
  }

  draw();
  const off = onChange(draw);
  return () => off();
}

function statCard(label, done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return el('div', { class: 'stat-card' },
    el('div', { class: 'label' }, label),
    el('div', { class: 'big' }, String(done), el('small', {}, ` / ${total}`)),
    el('div', { class: 'progress', role: 'progressbar', 'aria-label': `${label} 진행률`,
      'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) },
      el('span', { style: `width:${pct}%` })),
    el('div', { class: 'num', style: 'margin-top:6px;font-size:12px;color:var(--text-faint)' }, `${pct}% 완료`));
}
