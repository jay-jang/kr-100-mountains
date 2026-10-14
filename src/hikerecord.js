import './css/pages.css';
import { el } from './dom.js';
import { hikedMap, setHikedDate, toggleHiked } from './store.js';

let activeDialog = null;
let activeToast = null;
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function removeHikeWithUndo(id, name) {
  const previous = hikedMap()[id];
  if (!previous) return;
  toggleHiked(id, false);
  activeToast?.remove();
  const toast = el('div', { class: 'record-toast', role: 'status' }, `${name} 기록을 삭제했습니다.`,
    el('button', { class: 'btn', onClick: () => { setHikedDate(id, previous); toast.remove(); } }, '실행 취소'),
    el('button', { class: 'btn', 'aria-label': '알림 닫기', onClick: () => toast.remove() }, '닫기'));
  activeToast = toast;
  document.body.append(toast);
  // 실행 취소할 시간을 넉넉히 준 뒤 스스로 닫는다(포커스가 알림 안에 있으면 기다린다).
  const hide = () => { if (!toast.isConnected) return; if (toast.contains(document.activeElement)) { setTimeout(hide, 3000); return; } toast.remove(); };
  setTimeout(hide, 8000);
}
export function editHike(m) {
  activeDialog?.close();
  const opener = document.activeElement;
  const previous = hikedMap()[m.id];
  const date = el('input', { type: 'date', required: true, max: localToday(), value: previous || localToday(), id: 'hike-date' });
  const error = el('p', { role: 'alert', class: 'record-error' });
  const dialog = el('dialog', { class: 'record-dialog', 'aria-labelledby': 'record-title' });
  const close = () => dialog.close();
  const form = el('form', { onSubmit: e => {
    e.preventDefault();
    try {
      setHikedDate(m.id, date.value); close();
      activeToast?.remove();
      const toast = el('div', { class: 'record-toast', role: 'status' }, `${m.name} · ${date.value} 산행을 저장했습니다.`,
        el('button', { class: 'btn', 'aria-label': '알림 닫기', onClick: () => toast.remove() }, '닫기'));
      activeToast = toast; document.body.append(toast);
      setTimeout(() => toast.remove(), 4500);
    }
    catch (err) { error.textContent = err.message; }
  } },
  el('h2', { id: 'record-title' }, `${m.name} 등정 기록`),
  el('p', {}, '실제로 다녀온 날짜를 남겨주세요.'),
  el('label', { for: 'hike-date' }, '산행일'), date, error,
  el('div', { class: 'record-actions' },
    previous ? el('button', { type: 'button', class: 'btn', onClick: () => { close(); removeHikeWithUndo(m.id, m.name); } }, '기록 삭제') : null,
    el('button', { type: 'button', class: 'btn', onClick: close }, '취소'),
    el('button', { type: 'submit', class: 'btn primary' }, '기록 저장')));
  dialog.append(form);
  // 이 대화상자는 modal.js를 거치지 않는다 — Esc가 문서까지 올라가면 지도 셸이 뒤의 산 시트까지 닫는다.
  // 대화상자 안에서 멈추게 한다(기본 동작인 대화상자 닫기는 그대로 일어난다).
  dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
  document.body.append(dialog);
  activeDialog = dialog;
  window.addEventListener('hashchange', close);
  dialog.addEventListener('close', () => {
    window.removeEventListener('hashchange', close);
    dialog.remove();
    if (activeDialog === dialog) activeDialog = null;
    const target = opener?.isConnected ? opener : document.querySelector('.hike-btn, .record-add input');
    target?.focus({ preventScroll: true });
  }, { once: true });
  dialog.showModal();
  date.focus();
}
