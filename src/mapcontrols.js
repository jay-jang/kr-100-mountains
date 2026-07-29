// Shared map overlay controls: base-type switcher (일반/지형도/스카이뷰) + fullscreen + 전체화면 검색.
// Provider-agnostic — talks only to the MapView interface (setBaseType/relayout).
// 전체화면 자체는 mapfullscreen.js 한 모듈이 담당한다(모든 지도 뷰 공통).
import { el } from './dom.js';
import { getMapType, setMapType } from './store.js';
import { mapFullscreen } from './mapfullscreen.js';
import { mountainSearch } from './mapsearch.js';

const TYPES = [['default', '일반지도'], ['terrain', '지형도'], ['satellite', '스카이뷰']];

/**
 * @param {object} view MapView
 * @param {HTMLElement} fullscreenTarget 전체화면 대상(지도 래퍼)
 * @param {{search?:{mountains:Array,getPos?:Function,onPick:Function},
 *          onFullscreenChange?:(on:boolean)=>void}} [opts]
 *   search를 주면 전체화면일 때 지도 위에 산 검색창이 나타난다.
 *   (전체화면에서는 사이드 패널이 보이지 않아 검색 경로가 사라지기 때문)
 *   onFullscreenChange로 호출부가 열려 있는 오버레이(길찾기 메뉴 등)를 정리할 수 있다.
 * @returns {HTMLElement} `.map-ctrl` 박스. `cleanup()`을 갖는다.
 */
export function mapControls(view, fullscreenTarget, opts = {}) {
  const seg = el('div', { class: 'map-type-seg', role: 'group', 'aria-label': '지도 종류' });
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

  // 전체화면 검색 — 전체화면일 때만 보이도록 대상 요소 안에 붙인다(CSS: .fs-on .map-fs-search).
  let fsSearch = null;
  if (opts.search) {
    fsSearch = mountainSearch({
      mountains: opts.search.mountains,
      getPos: opts.search.getPos,
      onPick: (m) => opts.search.onPick(m),
      placeholder: '산 검색 — 지도에서 찾아가기',
      className: 'fs-search-inner',
    });
    const wrap = el('div', { class: 'map-fs-search' }, fsSearch.root);
    fullscreenTarget.append(wrap);
  }

  const fs = mapFullscreen(view, fullscreenTarget, {
    onChange: (on) => {
      if (fsSearch) {
        if (on) fsSearch.setValue('');        // 들어갈 때마다 깨끗한 상태로
        else fsSearch.close();
      }
      opts.onFullscreenChange?.(on);
    },
  });

  const box = el('div', { class: 'map-ctrl' }, seg, fs.button);
  box.cleanup = () => { fs.cleanup(); fsSearch?.destroy(); };
  return box;
}
