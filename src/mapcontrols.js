// Shared map overlay controls: base-type switcher (일반/지형도/스카이뷰) + fullscreen toggle.
// Provider-agnostic — talks only to the MapView interface (setBaseType/relayout).
import { el } from './dom.js';
import { getMapType, setMapType } from './store.js';

const TYPES = [['default', '일반지도'], ['terrain', '지형도'], ['satellite', '스카이뷰']];

export function mapControls(view, fullscreenTarget) {
  const seg = el('div', { class: 'map-type-seg' });
  const cur = getMapType();
  view.setBaseType(cur);
  TYPES.forEach(([v, label]) => {
    const b = el('button', { type: 'button', 'aria-pressed': String(v === cur), dataset: { type: v } }, label);
    b.addEventListener('click', () => {
      view.setBaseType(v);
      setMapType(v);
      [...seg.children].forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.type === v)));
    });
    seg.append(b);
  });

  const fsBtn = el('button', { class: 'map-fs-btn', type: 'button', title: '전체화면', 'aria-label': '전체화면' }, '⛶');
  const fsSupported = !!fullscreenTarget.requestFullscreen;
  if (!fsSupported) fsBtn.style.display = 'none';
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else fullscreenTarget.requestFullscreen?.();
  });
  const onFsChange = () => {
    const on = document.fullscreenElement === fullscreenTarget;
    fsBtn.textContent = on ? '✕' : '⛶';
    fsBtn.title = on ? '전체화면 종료' : '전체화면';
    setTimeout(() => { try { view.relayout(); } catch {} }, 130);
  };
  document.addEventListener('fullscreenchange', onFsChange);

  const box = el('div', { class: 'map-ctrl' }, seg, fsBtn);
  box.cleanup = () => document.removeEventListener('fullscreenchange', onFsChange);
  return box;
}
