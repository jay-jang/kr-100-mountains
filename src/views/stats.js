// 내 기록 #/track (#/stats) — 등정 수 · 목록별 진행 · 기록 추가 · 등정 목록 ·
// 접힘(권역별 진행 / 백업·이전 / 기기 간 동기화) · 아직 안 간 산 보기.
import '../css/pages.css';
import { loadData, LIST_KEYS, LIST_META } from '../data.js';
import { hikedMap, exportHiked, importHiked, clearHiked, onChange } from '../store.js';
import { CLOUD_ENABLED, currentUser, onAuthChange, authProviders, signInWithEmail, signInWithGoogle, signOut } from '../auth.js';
import { editHike, removeHikeWithUndo } from '../hikerecord.js';
import { searchRank } from '../search.js';
import { el, clear } from '../dom.js';
import { icon } from '../icons.js';
import { pageBar, fold, confirmAction, fmtM, dots } from './pagekit.js';

const REGIONS = ['수도권', '강원', '충청', '전라', '경상', '제주'];
let seq = 0;

export async function renderStats(root) {
  const data = await loadData();
  if (!root.isConnected) return () => {};
  const all = data.mountains;

  // ---------- 골격 ----------
  const settingsLink = el('a', { class: 'pg-bar-link', href: '#/settings' }, '설정');
  const main = el('div', { class: 'pg-main' });
  root.append(el('div', { class: 'pg pg-track' }, pageBar({ title: '내 기록', end: settingsLink }), main));

  // 큰 숫자(앱에서 세리프를 쓰는 유일한 곳)
  const countNum = el('span', { class: 'rec-num', 'aria-hidden': 'true' });
  const countSr = el('span', { class: 'sr-only' });
  const countCap = el('p', { class: 'rec-cap' });
  const summary = el('section', { class: 'rec-summary', 'aria-labelledby': 'rec-sum-h' },
    el('h2', { class: 'sr-only', id: 'rec-sum-h' }, '등정 요약'),
    el('p', { class: 'rec-big' }, countNum, countSr), countCap);
  const progress = el('ul', { class: 'rp-list', 'aria-label': '목록별 등정 진행' });

  // 기록 추가: 버튼 → 산 검색(콤보박스) → 날짜 대화상자(editHike)
  const emptyLine = el('p', { class: 'rec-empty-line', hidden: true }, '아직 기록한 산이 없습니다.');
  const addBtn = el('button', { type: 'button', class: 'btn primary rec-add-btn', 'aria-expanded': 'false', 'aria-controls': 'rec-add-box' },
    '다녀온 산 검색해서 기록 추가');
  const picker = mountainPicker({
    mountains: all,
    onPick: (m) => editHike(m),
    onDismiss: () => closeAdd(true),
  });
  const addBox = el('div', { class: 'rec-add-box', id: 'rec-add-box', hidden: true },
    el('div', { class: 'rec-add-row' }, picker.root,
      el('button', { type: 'button', class: 'btn rec-add-close', onClick: () => closeAdd(true) }, '닫기')),
    el('p', { class: 'set-note rec-add-note' }, '산을 고르면 다녀온 날짜를 묻습니다. 이미 기록한 산은 날짜를 고칩니다.'));
  const addSec = el('section', { class: 'rec-add record-add', 'aria-label': '기록 추가' }, emptyLine, addBtn, addBox);
  addBtn.addEventListener('click', () => openAdd());
  function openAdd() {
    addBtn.hidden = true; addBtn.setAttribute('aria-expanded', 'true');
    addBox.hidden = false;
    picker.focus();
  }
  function closeAdd(restoreFocus) {
    picker.reset();
    addBox.hidden = true;
    addBtn.hidden = false; addBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) addBtn.focus();
  }

  // 등정 목록
  let recordQuery = '', recordOrder = 'date';
  const listHeading = el('h2', { class: 'pg-h2 rec-list-h', id: 'rec-list-h', tabindex: '-1' });
  const recordSearch = el('input', { type: 'search', class: 'input', placeholder: '기록에서 찾기', 'aria-label': '내 기록 검색', autocomplete: 'off' });
  recordSearch.addEventListener('input', () => { recordQuery = recordSearch.value; drawRecords(); });
  const recordSort = el('select', { class: 'rec-sort', 'aria-label': '내 기록 정렬' },
    el('option', { value: 'date' }, '최근 순'), el('option', { value: 'old' }, '오래된 순'), el('option', { value: 'name' }, '이름순'));
  recordSort.addEventListener('change', () => { recordOrder = recordSort.value; drawRecords(); });
  const tools = el('div', { class: 'rec-tools' }, recordSearch, recordSort);
  const recordList = el('ul', { class: 'rec-rows', 'aria-labelledby': 'rec-list-h' });
  const filterEmpty = el('div', { class: 'empty', hidden: true },
    el('p', {}, '검색에 맞는 기록이 없습니다.'),
    el('button', { type: 'button', class: 'btn', onClick: () => { recordQuery = ''; recordSearch.value = ''; drawRecords(); recordSearch.focus(); } }, '검색 지우기'));
  const listSec = el('section', { class: 'rec-list', 'aria-labelledby': 'rec-list-h' }, listHeading, tools, recordList, filterEmpty);

  // 접힘: 권역별 진행
  const regionList = el('ul', { class: 'rp-list', 'aria-label': '권역별 등정 진행' });
  const regionFold = fold('권역별 진행', regionList);

  // 접힘: 백업·이전
  const feedback = el('div', { class: 'rec-feedback', role: 'status', 'aria-live': 'polite' });
  const importInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': '기록 백업 파일' });
  const exportBtn = el('button', { type: 'button', class: 'btn' }, '파일로 내보내기');
  const importBtn = el('button', { type: 'button', class: 'btn' }, '파일 가져오기');
  const clearBtn = el('button', { type: 'button', class: 'pg-text-btn pg-danger' }, '기록 모두 삭제');
  const backupFold = fold('백업·이전',
    el('p', { class: 'set-note' }, CLOUD_ENABLED
      ? '기록은 이 브라우저에 저장되고, 로그인하면 기기 사이에 동기화됩니다. JSON 파일로 옮길 수도 있습니다.'
      : '기록은 이 브라우저에만 저장됩니다. 파일로 내보내 다른 기기에서 가져오면 이어서 쓸 수 있습니다.'),
    el('div', { class: 'rec-actions' }, exportBtn, importBtn),
    el('p', { class: 'set-note' }, '가져오면 같은 산의 산행일은 파일의 날짜로 바뀝니다.'),
    clearBtn, feedback, importInput);

  // 접힘: 기기 간 동기화(배포에 클라우드가 설정된 경우만)
  const authBox = el('div', { class: 'auth-box' });
  const syncFold = CLOUD_ENABLED ? fold('기기 간 동기화', authBox) : null;

  const foot = el('a', { class: 'pg-foot-link', href: '#/map?hiked=0' }, '지도에서 아직 안 간 산 보기');
  foot.insertAdjacentHTML('beforeend', icon('next', { size: 16 }));

  main.append(summary, progress, addSec, listSec,
    el('div', { class: 'pg-folds' }, regionFold, backupFold, syncFold), foot);

  // ---------- 그리기 ----------
  function progressRow(name, done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return el('li', { class: 'rp-row' },
      el('span', { class: 'rp-name' }, name),
      el('span', { class: 'rp-num' },
        el('span', { 'aria-hidden': 'true' }, `${done} / ${total}`),
        el('span', { class: 'sr-only' }, `${total}곳 중 ${done}곳`)),
      el('span', { class: 'rp-bar', 'aria-hidden': 'true' }, el('span', { style: `width:${pct}%` })));
  }

  function draw() {
    if (!root.isConnected) return;
    const hiked = hikedMap();
    const done = (list) => list.filter((m) => m.id in hiked).length;
    const total = done(all);
    countNum.textContent = `${total} / ${all.length}`;
    countSr.textContent = `${all.length}곳 중 ${total}곳 등정`;
    countCap.textContent = total
      ? `4개 목록을 합친 명산 ${all.length}곳 중 ${total}곳에 올랐습니다.`
      : `4개 목록을 합친 명산 ${all.length}곳`;

    clear(progress);
    LIST_KEYS.forEach((k) => {
      const inList = all.filter((m) => m.lists[k]);
      progress.append(progressRow(LIST_META[k].full, done(inList), inList.length));
    });
    clear(regionList);
    REGIONS.forEach((r) => {
      const inR = all.filter((m) => m.region === r);
      regionList.append(progressRow(r, done(inR), inR.length));
    });

    emptyLine.hidden = total > 0;
    listSec.hidden = total === 0;
    drawRecords();
  }

  function drawRecords() {
    const hiked = hikedMap();
    const rows = all.filter((m) => m.id in hiked).map((m) => ({ m, date: hiked[m.id] || '' }))
      .sort((a, b) => recordOrder === 'name'
        ? a.m.name_full.localeCompare(b.m.name_full, 'ko')
        : recordOrder === 'old'
          ? a.date.localeCompare(b.date) || a.m.name.localeCompare(b.m.name, 'ko')
          : b.date.localeCompare(a.date) || a.m.name.localeCompare(b.m.name, 'ko'));
    const q = recordQuery.trim().toLowerCase();
    const shown = q ? rows.filter(({ m }) => `${m.name_full} ${m.province} ${m.region}`.toLowerCase().includes(q)) : rows;
    listHeading.textContent = q ? `등정한 산 ${shown.length} / ${rows.length}` : `등정한 산 ${rows.length}`;
    tools.hidden = rows.length < 2;
    clear(recordList);
    filterEmpty.hidden = !(rows.length && !shown.length);
    shown.forEach(({ m, date }) => recordList.append(recordRow(m, date)));
  }

  function recordRow(m, date) {
    const name = m.name_full;
    const editBtn = el('button', { type: 'button', class: 'pg-text-btn', 'aria-label': `${name} 산행일 수정` }, '날짜 수정');
    const delBtn = el('button', { type: 'button', class: 'pg-text-btn', 'aria-label': `${name} 기록 삭제` }, '삭제');
    editBtn.addEventListener('click', () => editHike(m));
    delBtn.addEventListener('click', () => {
      const items = [...recordList.children];
      const idx = items.findIndex((li) => li.contains(delBtn));
      removeHikeWithUndo(m.id, m.name);   // 저장소 변경 → draw()가 곧바로 다시 그린다
      // 지운 행에 있던 포커스를 다음(없으면 이전) 기록으로 옮긴다.
      const next = recordList.children[idx] || recordList.children[idx - 1];
      (next?.querySelector('.rec-link') || (listSec.hidden ? addBtn : listHeading)).focus();
    });
    return el('li', { class: 'rec-row' },
      el('a', { class: 'rec-link', href: `#/m/${m.id}` },
        el('span', { class: 'rec-name' }, m.name, m.disambig ? el('span', { class: 'row-tag' }, m.disambig) : null),
        el('span', { class: 'rec-meta' }, ...dots(
          date ? el('time', { datetime: date }, date) : '날짜 없음', m.region, fmtM(m.elevation_m)))),
      el('span', { class: 'rec-acts' }, editBtn, delBtn));
  }

  // ---------- 백업·이전 ----------
  function say(...parts) { clear(feedback); feedback.append(el('p', {}, ...parts)); }
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([exportHiked()], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'kr100-hiked.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    say('기록 파일(kr100-hiked.json)을 내려받았습니다.');
  });
  importBtn.addEventListener('click', () => { importInput.value = ''; importInput.click(); });
  importInput.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    if (!f || !root.isConnected) return;
    try {
      const text = await f.text();
      if (!root.isConnected) return;
      const { imported, skipped } = importHiked(text, new Set(data.byId.keys()));
      say(`${imported}개 산의 기록을 가져왔습니다.${skipped ? ` 목록에 없는 ${skipped}개 항목은 뺐습니다.` : ''}`);
    } catch (err) {
      say(`가져오지 못했습니다. ${err instanceof SyntaxError ? '올바른 JSON 기록 파일을 고르세요.' : err.message}`);
    }
  });
  clearBtn.addEventListener('click', async () => {
    const n = Object.keys(hikedMap()).length;
    if (!n) { say('지울 기록이 없습니다.'); return; }
    const ok = await confirmAction({
      title: '기록 모두 삭제',
      message: `등정 기록 ${n}개를 모두 지웁니다. 내보낸 파일이 없으면 이 화면을 떠난 뒤에는 되살릴 수 없습니다.`,
      confirm: '모두 삭제', danger: true,
    });
    if (!ok || !root.isConnected) return;
    const snapshot = exportHiked();
    clearHiked();
    const undo = el('button', { type: 'button', class: 'pg-text-btn' }, '되돌리기');
    undo.addEventListener('click', () => {
      try { importHiked(snapshot); say(`기록 ${n}개를 되살렸습니다.`); }
      catch (err) { say(`되살리지 못했습니다. ${err.message}`); }
    });
    say(`기록 ${n}개를 지웠습니다. `, undo);
    undo.focus();
  });

  // ---------- 로그인·동기화 ----------
  let providers = {};
  if (CLOUD_ENABLED) {
    authProviders().then((p) => { if (root.isConnected) { providers = p || {}; drawAuth(authBox, providers); } }).catch(() => {});
    drawAuth(authBox, providers);
  }
  const offAuth = CLOUD_ENABLED ? onAuthChange(() => { if (root.isConnected) drawAuth(authBox, providers); }) : () => {};

  draw();
  const off = onChange(draw);
  const cleanup = () => { off(); offAuth(); picker.destroy(); };
  cleanup.origin = '#/track';
  return cleanup;
}

// 로그인/동기화(CLOUD_ENABLED일 때만). providers = 켜진 외부 로그인 제공자.
function drawAuth(box, providers = {}) {
  clear(box);
  const user = currentUser();
  if (user) {
    box.append(
      el('p', { class: 'auth-state' }, el('strong', {}, '동기화 중'), ' · ', user.email || user.user_metadata?.name || '로그인됨'),
      el('p', { class: 'set-note' }, '이 기기에서 바꾼 기록이 같은 계정의 다른 기기에도 반영됩니다.'),
      el('button', { type: 'button', class: 'btn', onClick: () => signOut() }, '로그아웃'));
    return;
  }
  const id = `auth-email-${++seq}`;
  const email = el('input', { class: 'input', id, type: 'email', autocomplete: 'email', placeholder: 'name@example.com' });
  const msg = el('p', { class: 'set-note auth-msg', role: 'status', 'aria-live': 'polite' });
  const mailBtn = el('button', { type: 'button', class: 'btn primary' }, '로그인 링크 받기');
  mailBtn.addEventListener('click', async () => {
    const v = email.value.trim();
    if (!/.+@.+\..+/.test(v)) { msg.textContent = '올바른 이메일 주소를 입력하세요.'; email.focus(); return; }
    mailBtn.disabled = true; msg.textContent = '보내는 중…';
    try { await signInWithEmail(v); msg.textContent = '로그인 링크를 메일로 보냈습니다. 메일함을 확인하세요.'; }
    catch (e) { msg.textContent = `보내지 못했습니다. ${e.message || e}`; }
    finally { mailBtn.disabled = false; }
  });
  email.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); mailBtn.click(); }
  });
  const googleBtn = providers.google ? el('button', { type: 'button', class: 'btn' }, 'Google로 로그인') : null;
  googleBtn?.addEventListener('click', async () => {
    try { await signInWithGoogle(); } catch (e) { msg.textContent = `Google 로그인에 실패했습니다. ${e.message || e}`; }
  });
  box.append(...[
    el('p', { class: 'set-note' }, '로그인하면 여러 기기에서 같은 기록을 씁니다. 이 기기의 기록은 첫 로그인 때 합쳐집니다.'),
    el('label', { class: 'auth-label', for: id }, '이메일'),
    el('div', { class: 'auth-row' }, email, mailBtn),
    googleBtn ? el('div', { class: 'auth-row' }, googleBtn) : null,
    msg].filter(Boolean));
}

/**
 * 기록할 산 검색 콤보박스(명산만). 고르면 onPick(m).
 * Esc: 제안 닫기 → 값 지우기 → onDismiss(). 한글 조합 중 Enter는 무시한다.
 */
function mountainPicker({ mountains, onPick, onDismiss }) {
  const n = ++seq;
  const listId = `rec-pick-${n}`;
  const input = el('input', {
    type: 'search', class: 'input', id: `rec-pick-input-${n}`, placeholder: '산 이름 (예: 설악, 지리)',
    'aria-label': '기록할 산 검색', role: 'combobox', 'aria-autocomplete': 'list',
    'aria-expanded': 'false', 'aria-controls': listId, autocomplete: 'off', enterkeyhint: 'search',
  });
  const box = el('ul', { class: 'rec-suggest', id: listId, role: 'listbox', 'aria-label': '검색 결과', hidden: true });
  const status = el('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const root = el('div', { class: 'rec-pick' }, input, box, status);
  let options = [], idx = -1, destroyed = false;

  function close() {
    box.hidden = true; clear(box); options = []; idx = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function highlight(i) {
    idx = i;
    options.forEach((o, k) => { o.node.classList.toggle('active', k === i); o.node.setAttribute('aria-selected', String(k === i)); });
    if (i >= 0) { input.setAttribute('aria-activedescendant', options[i].node.id); options[i].node.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function render() {
    const q = input.value.trim().toLowerCase();
    close();
    if (!q) { status.textContent = ''; return; }
    const hiked = hikedMap();
    const hits = mountains.map((m) => ({ m, r: searchRank(m, q) })).filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.m.name.localeCompare(b.m.name, 'ko')).slice(0, 8);
    if (!hits.length) {
      box.append(el('li', { class: 'rec-suggest-empty', role: 'presentation' }, '맞는 산이 없습니다.'));
      status.textContent = '맞는 산이 없습니다.';
    }
    hits.forEach(({ m }, i) => {
      const date = hiked[m.id];
      const node = el('li', { class: 'rec-suggest-item', role: 'option', id: `${listId}-${i}`, 'aria-selected': 'false' },
        el('span', { class: 'rec-name' }, m.name, m.disambig ? el('span', { class: 'row-tag' }, m.disambig) : null),
        el('span', { class: 'rec-meta' }, ...dots(m.province, fmtM(m.elevation_m),
          date ? el('span', { class: 'rec-had' }, `${date} 기록됨`) : null)));
      node.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      node.addEventListener('mousemove', () => { if (idx !== i) highlight(i); });
      options.push({ m, node });
      box.append(node);
    });
    if (hits.length) status.textContent = `결과 ${hits.length}개`;
    box.hidden = false;
    input.setAttribute('aria-expanded', String(hits.length > 0));
  }
  function pick(i) {
    const o = options[i];
    if (!o) return;
    close();
    input.value = '';
    onPick?.(o.m);
  }
  input.addEventListener('input', render);
  input.addEventListener('search', render);
  input.addEventListener('focus', () => { if (input.value.trim()) render(); });
  input.addEventListener('blur', () => setTimeout(() => { if (!destroyed && document.activeElement !== input) close(); }, 150));
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (box.hidden) { render(); return; }
      if (!options.length) return;
      e.preventDefault();
      const k = options.length;
      highlight(e.key === 'ArrowDown' ? (idx + 1) % k : (idx - 1 + k) % k);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!box.hidden && options.length) pick(Math.max(0, idx));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!box.hidden) close();
      else if (input.value) input.value = '';
      else onDismiss?.();
    }
  });
  return {
    root,
    focus() { input.focus(); },
    reset() { input.value = ''; close(); status.textContent = ''; },
    destroy() { destroyed = true; close(); },
  };
}
