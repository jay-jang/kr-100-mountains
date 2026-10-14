// 모달 시트(필터·레이어 등) — 네이티브 <dialog>.showModal()을 쓴다.
// 포커스 가두기·배경 비활성·Esc 닫기를 브라우저가 처리하고, 닫으면 연 버튼으로 포커스를 돌려준다.
// 모달 위에 모달을 띄우지 않는다(이미 열려 있으면 먼저 닫는다).
import { el } from './dom.js';
import { icon } from './icons.js';

let current = null;

/**
 * @param {{title:string, content:Node, footer?:Node, onClose?:()=>void, className?:string}} o
 * @returns {{dialog:HTMLDialogElement, close:()=>void}}
 */
export function openModal({ title, content, footer = null, onClose, className = '' }) {
  current?.close();
  const opener = document.activeElement;
  const titleId = `modal-title-${Math.random().toString(36).slice(2, 8)}`;
  const closeBtn = el('button', { class: 'icon-btn modal-close', type: 'button', 'aria-label': '닫기', html: icon('close') });
  const dialog = el('dialog', { class: 'modal' + (className ? ' ' + className : ''), 'aria-labelledby': titleId },
    el('div', { class: 'modal-head' }, el('h2', { id: titleId }, title), closeBtn),
    el('div', { class: 'modal-body' }, content),
    footer ? el('div', { class: 'modal-foot' }, footer) : null);
  document.body.append(dialog);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (current?.dialog === dialog) current = null;
    onClose?.();
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
  }
  closeBtn.addEventListener('click', close);
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });   // Esc
  // 바깥(배경) 클릭으로 닫기 — 대화상자 상자 밖 좌표일 때만.
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  });
  dialog.showModal();
  const handle = { dialog, close };
  current = handle;
  return handle;
}

export function closeModal() { current?.close(); }
/**
 * 모달이 열려 있는가. openModal로 연 것뿐 아니라 다른 모듈이 직접 showModal()한 <dialog>(등정 기록 등)도 센다 —
 * 셸의 Esc·'/' 단축키가 대화상자 뒤의 시트에 닿지 않게.
 */
export function modalOpen() { return !!current || !!document.querySelector('dialog[open]'); }
