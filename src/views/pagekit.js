// 전체 페이지(기록·설정·대표 코스 모음) 공용 부품 — 상단 바, 확인 대화상자, 접는 구역.
import '../css/pages.css';
import { el } from '../dom.js';
import { icon } from '../icons.js';
import { goUp } from '../router.js';
import { openModal } from '../modal.js';

/**
 * 52px 상단 바: [‹ 지도] · 제목 · (오른쪽 링크).
 * 뒤로는 앱 안 기록이 있으면 뒤로가기(router goUp — 이중 탭에 두 번 가지 않게 막혀 있다), 링크로 바로 들어왔으면 지도로 교체.
 */
export function pageBar({ title, end = null, titleId = 'page-title' }) {
  const back = el('a', { class: 'pg-back', href: '#/map', html: icon('back') });
  back.append(document.createTextNode('지도'));
  back.addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    goUp('#/map');
  });
  return el('header', { class: 'pg-bar' },
    el('div', { class: 'pg-bar-in' },
      back,
      el('h1', { class: 'pg-title', id: titleId }, title),
      el('div', { class: 'pg-bar-end' }, end)));
}

/** 접는 구역 <details>. summary는 52px 행, 오른쪽에 펼침 표시 아이콘. */
export function fold(title, ...children) {
  const summary = el('summary', { class: 'pg-fold-sum' },
    el('span', { class: 'pg-fold-title' }, title),
    el('span', { class: 'pg-fold-ic', html: icon('down', { size: 18 }) }));
  return el('details', { class: 'pg-fold' }, summary, el('div', { class: 'pg-fold-body' }, ...children));
}

/**
 * 확인 대화상자(모달 시트). 확인을 누르면 true, 취소·Esc·바깥 클릭이면 false.
 * 기본 포커스는 [취소] — 되돌릴 수 없는 동작을 Enter 한 번으로 실행하지 않게.
 */
export function confirmAction({ title, message, confirm = '확인', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const cancelBtn = el('button', { type: 'button', class: 'btn' }, '취소');
    const okBtn = el('button', { type: 'button', class: 'btn primary' + (danger ? ' pg-danger-fill' : '') }, confirm);
    const handle = openModal({
      title,
      className: 'pg-confirm',
      content: el('p', { class: 'pg-confirm-msg' }, message),
      footer: el('div', { class: 'modal-actions' }, cancelBtn, okBtn),
      onClose: () => resolve(result),
    });
    cancelBtn.addEventListener('click', () => handle.close());
    okBtn.addEventListener('click', () => { result = true; handle.close(); });
    cancelBtn.focus();
  });
}

/** 바깥으로 나가는 링크(새 탭). 아이콘은 장식, 새 탭 안내는 화면 낭독기용 글자로. */
export function extLink(href, text, cls = 'pg-ext') {
  const a = el('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' }, text);
  a.insertAdjacentHTML('beforeend', icon('external', { size: 14 }));
  a.append(el('span', { class: 'sr-only' }, ' (새 창)'));
  return a;
}

/** 메타 줄: 항목 사이에 ' · '를 글자로 넣는다(줄바꿈 때 구분점이 줄 머리에 오지 않게). */
export function dots(...parts) {
  const out = [];
  parts.filter((p) => p != null && p !== false && p !== '').forEach((p, i) => {
    if (i) out.push(el('span', { class: 'pg-dot' }, '\u00a0· '));   // 앞은 붙는 공백 — 구분점이 줄 머리로 가지 않게
    out.push(p);
  });
  return out;
}

export const fmtM = (n) => `${Math.round(n).toLocaleString('ko-KR')}m`;
