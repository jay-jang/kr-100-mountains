import { loadData, REGION_COLORS, LIST_KEYS, LIST_META } from '../data.js';
import { hikedMap, hikedCount, toggleHiked, exportHiked, importHiked, clearHiked, onChange } from '../store.js';
import { CLOUD_ENABLED, currentUser, onAuthChange, authProviders, signInWithEmail, signInWithGoogle, signOut } from '../auth.js';
import { el, clear } from '../dom.js';

const REGIONS = ['수도권', '강원', '충청', '전라', '경상', '제주'];

export async function renderStats(root) {
  const data = await loadData();
  const page = el('div', { class: 'page' });
  root.append(page);

  const authBox = el('div', { class: 'auth-box' });
  const body = el('div');
  page.append(
    el('div', { class: 'crumb' }, el('a', { href: '#/' }, '← 홈으로')),
    el('h2', { style: 'margin:.1em 0 .4em;letter-spacing:-.03em' }, '내 등정 기록'),
    el('p', { class: 'prose muted', style: 'margin-top:0' },
      CLOUD_ENABLED ? '로그인하면 여러 기기에서 기록이 동기화됩니다.' : '기록은 이 브라우저에 저장됩니다 (내보내기/가져오기로 이전 가능).'),
    authBox, body);

  const providers = CLOUD_ENABLED ? await authProviders() : {};
  drawAuth(authBox, providers);
  const offAuth = onAuthChange(() => drawAuth(authBox, providers));

  function draw() {
    clear(body);
    const hiked = hikedMap();
    const ids = new Set(Object.keys(hiked));
    const all = data.mountains;
    const cards = LIST_KEYS.map((k) => {
      const inList = all.filter((m) => m.lists[k]);
      const done = inList.filter((m) => ids.has(m.id)).length;
      return statCard(LIST_META[k].full, done, inList.length, `card-${k}`);
    });
    cards.push(statCard('전체 명산', all.filter((m) => ids.has(m.id)).length, all.length));

    body.append(el('div', { class: 'stat-grid' }, ...cards));

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
  return () => { off(); offAuth(); };
}

// 로그인/동기화 UI (CLOUD_ENABLED 일 때만 표시). providers = 활성화된 외부 제공자.
function drawAuth(box, providers = {}) {
  clear(box);
  if (!CLOUD_ENABLED) return; // 미설정 배포: 로컬 저장만 (아래 내보내기/가져오기 사용)
  const user = currentUser();
  if (user) {
    box.append(el('div', { class: 'auth-signed' },
      el('span', { class: 'auth-badge' }, '✓ 동기화됨'),
      el('span', { class: 'auth-email' }, user.email || user.user_metadata?.name || '로그인됨'),
      el('button', { class: 'btn', onClick: () => signOut() }, '로그아웃')));
    return;
  }
  const email = el('input', { class: 'auth-input', type: 'email', placeholder: '이메일 주소', 'aria-label': '이메일' });
  const msg = el('span', { class: 'auth-msg' });
  const mailBtn = el('button', { class: 'btn primary', onClick: async () => {
    const v = email.value.trim();
    if (!/.+@.+\..+/.test(v)) { msg.textContent = '올바른 이메일을 입력하세요.'; return; }
    mailBtn.disabled = true; msg.textContent = '전송 중…';
    try { await signInWithEmail(v); msg.textContent = '로그인 링크를 메일로 보냈습니다. 메일함을 확인하세요.'; }
    catch (e) { msg.textContent = '전송 실패: ' + (e.message || e); }
    finally { mailBtn.disabled = false; }
  } }, '메일로 로그인 링크 받기');
  const googleBtn = el('button', { class: 'btn', onClick: async () => {
    try { await signInWithGoogle(); } catch (e) { msg.textContent = '구글 로그인 실패: ' + (e.message || e); }
  } }, 'Google로 로그인');

  box.append(el('div', { class: 'auth-signin' },
    el('div', { class: 'auth-row' }, email, mailBtn),
    providers.google ? el('div', { class: 'auth-row' }, googleBtn) : null,
    msg));
}

function statCard(label, done, total, cls = '') {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return el('div', { class: 'stat-card' + (cls ? ' ' + cls : '') },
    el('div', { class: 'label' }, label),
    el('div', { class: 'big' }, String(done), el('small', {}, ` / ${total}`)),
    el('div', { class: 'progress', role: 'progressbar', 'aria-label': `${label} 진행률`,
      'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) },
      el('span', { style: `width:${pct}%` })),
    el('div', { class: 'num', style: 'margin-top:6px;font-size:12px;color:var(--text-faint)' }, `${pct}% 완료`));
}
