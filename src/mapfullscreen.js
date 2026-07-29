// 지도 전체화면 — 모든 지도 뷰(#/map 탐색, #/m/:id 상세)가 공유하는 단일 모듈.
// 브라우저별 프리픽스와 fullscreenchange 처리를 한곳에 모으고, 전체화면 여부를
// 대상 요소의 `fs-on` 클래스로 알려 CSS가 뷰별 셀렉터(.map-wrap:fullscreen 등) 없이 대응하게 한다.
import { el } from './dom.js';

const reqFn = (n) => n.requestFullscreen || n.webkitRequestFullscreen || n.msRequestFullscreen;
const exitFn = () => (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen);
const currentEl = () =>
  document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;

const CHANGE_EVENTS = ['fullscreenchange', 'webkitfullscreenchange', 'MSFullscreenChange'];

/** 이 요소를 전체화면으로 만들 수 있는지 (iOS 아이폰 사파리는 요소 전체화면 미지원). */
export function fullscreenSupported(target) { return !!reqFn(target); }

/**
 * 지도 전체화면 토글.
 * @param {object} view  MapView (relayout 사용)
 * @param {HTMLElement} target  전체화면으로 띄울 래퍼
 * @param {{onChange?:(on:boolean)=>void}} opts  전체화면 진입/이탈 시 알림(오버레이 UI 토글용)
 * @returns {{button:HTMLElement, isOn:()=>boolean, exit:()=>void, cleanup:()=>void}}
 */
export function mapFullscreen(view, target, { onChange } = {}) {
  target.classList.add('map-fs');            // 공통 훅 — 뷰별 셀렉터를 대체한다
  const supported = fullscreenSupported(target);

  const button = el('button', { class: 'map-fs-btn', type: 'button', title: '전체화면', 'aria-label': '전체화면' }, '⛶');
  if (!supported) button.style.display = 'none';

  const isOn = () => currentEl() === target;
  const exit = () => { if (isOn()) exitFn()?.call(document); };

  button.addEventListener('click', () => {
    if (isOn()) exit();
    else reqFn(target)?.call(target);
  });

  const sync = () => {
    const on = isOn();
    target.classList.toggle('fs-on', on);
    button.textContent = on ? '✕' : '⛶';
    button.title = on ? '전체화면 종료' : '전체화면';
    button.setAttribute('aria-label', button.title);
    // 컨테이너 크기가 바뀐 뒤 지도에 알린다(프로바이더 공통 relayout).
    setTimeout(() => { try { view.relayout(); } catch {} }, 130);
    try { onChange?.(on); } catch (e) { console.error(e); }
  };
  CHANGE_EVENTS.forEach((e) => document.addEventListener(e, sync));

  return {
    button, isOn, exit,
    cleanup() {
      CHANGE_EVENTS.forEach((e) => document.removeEventListener(e, sync));
      exit();                                 // 라우트를 떠나며 전체화면이 남지 않게
      target.classList.remove('map-fs', 'fs-on');
    },
  };
}
