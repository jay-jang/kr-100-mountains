import { loadData, REGION_COLORS, LIST_KEYS, LIST_META } from '../data.js';
import { hikedMap, exportHiked, importHiked, clearHiked, onChange } from '../store.js';
import { CLOUD_ENABLED, currentUser, onAuthChange, authProviders, signInWithEmail, signInWithGoogle, signOut } from '../auth.js';
import { editHike, removeHikeWithUndo } from '../hikerecord.js';
import { mountainSearch } from '../mapsearch.js';
import { el, clear } from '../dom.js';

const REGIONS = ['수도권', '강원', '충청', '전라', '경상', '제주'];

export async function renderStats(root) {
  const data = await loadData();
  if (!root.isConnected) return () => {};
  const page = el('div', { class: 'page journal-page' });
  root.append(page);

  const authBox = el('div', { class: 'auth-box' });
  const body = el('div');
  const summary = el('div');
  const addSearch = mountainSearch({
    mountains: data.mountains, placeholder: '다녀온 산 이름을 검색하세요', ariaLabel: '기록할 산 검색',
    onPick: m => editHike(m),
  });
  const addSection = el('section', { class: 'record-add' },
    el('h3', {}, '산행 기록 추가'), addSearch.root,
    el('p', { class: 'conf-note' }, '산을 선택하고 다녀온 날짜를 입력하세요.'));
  const feedback = el('p', { class: 'data-feedback', role: 'status', 'aria-live': 'polite' });
  const importInput = el('input', { type: 'file', accept: '.json', hidden: true, 'aria-label': '기록 백업 파일' });
  let recordQuery = '', recordOrder = 'date';
  const recordSearch = el('input', { type: 'search', class: 'search', placeholder: '내 기록에서 산 찾기', 'aria-label': '내 기록 검색',
    onInput: e => { recordQuery = e.target.value; drawRecords(); } });
  const recordSort = el('select', { 'aria-label': '내 기록 정렬', onChange: e => { recordOrder = e.target.value; drawRecords(); } },
    el('option', { value: 'date' }, '최근 산행일순'), el('option', { value: 'name' }, '산 이름순'));
  const recordHeading = el('h3');
  const recordGrid = el('div', { class: 'mtn-list record-list' });
  const recordSection = el('section', { class: 'section' }, recordHeading,
    el('div', { class: 'record-tools' }, recordSearch, recordSort), recordGrid);
  page.append(
    el('div', { class: 'crumb' }, el('a', { href: '#/' }, '← 홈으로')),
    el('h2', { style: 'margin:.1em 0 .4em;letter-spacing:-.03em' }, '내 등정 기록'),
    el('p', { class: 'prose muted', style: 'margin-top:0' },
      CLOUD_ENABLED ? '로그인하면 여러 기기에서 기록이 동기화됩니다.' : '기록은 이 브라우저에 저장됩니다 (내보내기/가져오기로 이전 가능).'),
    authBox, addSection, summary, recordSection, body, feedback, importInput);

  let providers = {};
  if (CLOUD_ENABLED) authProviders().then(result => {
    if (!root.isConnected) return;
    providers = result; drawAuth(authBox, providers);
  }).catch(() => {});
  drawAuth(authBox, providers);
  const offAuth = onAuthChange(() => drawAuth(authBox, providers));

  function draw() {
    if (!root.isConnected) return;
    clear(body);
    clear(summary);
    const hiked = hikedMap();
    const ids = new Set(Object.keys(hiked));
    const all = data.mountains;
    const cards = LIST_KEYS.map((k) => {
      const inList = all.filter((m) => m.lists[k]);
      const done = inList.filter((m) => ids.has(m.id)).length;
      return statCard(LIST_META[k].full, done, inList.length, `card-${k}`);
    });
    cards.push(statCard('전체 명산', all.filter((m) => ids.has(m.id)).length, all.length));

    summary.append(el('div', { class: 'journal-summary' }, el('span', { class: 'eyebrow' }, '차곡차곡 쌓이는 산행'), el('p', {}, '지금까지 ', el('strong', {}, String(all.filter(m => ids.has(m.id)).length)), '개의 산을 올랐습니다.'), el('a', { href: '#/map' }, '다음 산 찾아보기 ↗')));
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

    drawRecords();

    // data actions
    const actions = el('div', { class: 'data-actions' },
      el('button', { class: 'btn primary', onClick: doExport }, '내보내기 (JSON)'),
      el('button', { class: 'btn', onClick: doImport }, '가져오기'),
      el('button', { class: 'btn', onClick: () => { if (confirm('모든 기록을 삭제할까요? 내보낸 파일이 없으면 복구할 수 없습니다.')) clearHiked(); } }, '전체 삭제'));
    body.append(el('div', { class: 'section' }, el('h3', {}, '기록 백업 · 이전'),
      el('p', { class: 'conf-note' }, '내보낸 파일을 다른 기기에서 가져오면 기록을 이어갈 수 있습니다. 같은 산의 산행일은 가져온 날짜로 갱신됩니다.'), actions));
  }

  function drawRecords() {
    clear(recordGrid);
    const hiked = hikedMap();
    const ids = new Set(Object.keys(hiked));
    const hikedMtns = data.mountains.filter((m) => ids.has(m.id))
      .map((m) => ({ m, date: hiked[m.id] }))
      .sort((a, b) => recordOrder === 'name' ? a.m.name_full.localeCompare(b.m.name_full, 'ko') : (b.date || '').localeCompare(a.date || ''));
    const query = recordQuery.trim().toLowerCase();
    const shown = hikedMtns.filter(({ m }) => `${m.name_full} ${m.province} ${m.region}`.toLowerCase().includes(query));
    recordHeading.textContent = `등정한 산 (${query ? `${shown.length} / ` : ''}${hikedMtns.length})`;
    if (!hikedMtns.length) {
      recordGrid.append(el('div', { class: 'empty' }, el('strong', {}, '첫 산행을 기록해 보세요.'), el('p', {}, '다녀온 산을 검색하고 날짜를 남기면 이곳에 모입니다.'), el('button', { class: 'btn', onClick: () => addSearch.focus() }, '다녀온 산 찾기 ↗')));
    } else if (!shown.length) {
      recordGrid.append(el('div', { class: 'empty' }, '검색에 맞는 기록이 없습니다.', el('button', { class: 'btn', onClick: () => { recordQuery = ''; recordSearch.value = ''; drawRecords(); recordSearch.focus(); } }, '기록 검색 초기화')));
    } else {
      shown.forEach(({ m, date }) => {
        recordGrid.append(el('div', { class: 'mtn-item' },
          el('span', { class: 'mtn-rank', style: `background:${REGION_COLORS[m.region]}` }),
          el('div', { class: 'mtn-body' },
            el('a', { class: 'mtn-name', href: `#/m/${m.id}` }, m.name_full),
            el('div', { class: 'mtn-meta' }, el('span', {}, `${Math.round(m.elevation_m)}m`),
              el('span', {}, m.province), el('span', {}, date))),
          el('div', { class: 'record-row-actions' }, el('button', { class: 'btn', onClick: () => editHike(m) }, '날짜 수정'), el('button', { class: 'btn', onClick: () => removeHikeWithUndo(m.id, m.name) }, '삭제'))));
      });
    }
  }

  function doExport() {
    const blob = new Blob([exportHiked()], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'kr100-hiked.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    feedback.textContent = '기록 파일을 내려받았습니다. 다른 기기에서 가져오기로 이어갈 수 있습니다.';
  }
  function doImport() {
    importInput.value = '';
    importInput.click();
  }
  importInput.addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (!root.isConnected) return;
    try {
      const text = await f.text();
      if (!root.isConnected) return;
      const { imported, skipped } = importHiked(text, new Set(data.byId.keys()));
      feedback.textContent = `${imported}개 산의 기록을 가져왔습니다.${skipped ? ` 목록에 없는 ${skipped}개 항목은 제외했습니다.` : ''}`;
    } catch (err) { feedback.textContent = `가져오지 못했습니다. ${err instanceof SyntaxError ? '올바른 JSON 기록 파일을 선택하세요.' : err.message}`; }
    feedback.scrollIntoView({ block: 'nearest' });
  });

  draw();
  const off = onChange(draw);
  const cleanup = () => { off(); offAuth(); addSearch.destroy(); };
  cleanup.origin = '#/track';
  return cleanup;
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
