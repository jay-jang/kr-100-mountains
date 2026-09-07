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
}
export function editHike(m) {
  activeDialog?.close();
  const previous = hikedMap()[m.id];
  const date = el('input', { type: 'date', required: true, max: localToday(), value: previous || localToday(), id: 'hike-date' });
  const error = el('p', { role: 'alert', class: 'record-error' });
  const dialog = el('dialog', { class: 'record-dialog', 'aria-labelledby': 'record-title' });
  const close = () => dialog.close();
  const form = el('form', { onSubmit: e => {
    e.preventDefault();
    try { setHikedDate(m.id, date.value); close(); }
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
  document.body.append(dialog);
  activeDialog = dialog;
  window.addEventListener('hashchange', close);
  dialog.addEventListener('close', () => {
    window.removeEventListener('hashchange', close);
    dialog.remove();
    if (activeDialog === dialog) activeDialog = null;
  }, { once: true });
  dialog.showModal();
  date.focus();
}
