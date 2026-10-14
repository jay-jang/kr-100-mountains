// 인라인 SVG 아이콘 — 지도 컨트롤 등 글자를 넣기 어려운 곳에만 쓴다.
// 20px, 선 굵기 1.5, currentColor. 모든 아이콘 버튼에는 aria-label을 단다.
const PATHS = {
  search: '<circle cx="9" cy="9" r="5.5"/><path d="M13.2 13.2 17 17"/>',
  layers: '<path d="M10 3 2.5 7 10 11l7.5-4Z"/><path d="m2.5 10.5 7.5 4 7.5-4"/><path d="m2.5 14 7.5 4 7.5-4"/>',
  locate: '<circle cx="10" cy="10" r="3"/><path d="M10 2v3M10 15v3M2 10h3M15 10h3"/><circle cx="10" cy="10" r="6"/>',
  locating: '<circle cx="10" cy="10" r="3" fill="currentColor"/><path d="M10 2v3M10 15v3M2 10h3M15 10h3"/><circle cx="10" cy="10" r="6"/>',
  close: '<path d="m5 5 10 10M15 5 5 15"/>',
  back: '<path d="M12.5 4 6.5 10l6 6"/>',
  next: '<path d="m7.5 4 6 6-6 6"/>',
  up: '<path d="m4 12.5 6-6 6 6"/>',
  down: '<path d="m4 7.5 6 6 6-6"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  minus: '<path d="M4 10h12"/>',
  // 톱니바퀴(테마 전환용 해 모양과 헷갈리지 않게 톱니가 붙은 윤곽으로 그린다)
  settings: '<path d="M8.6 2.5h2.8l.45 2.1 1.5.62 1.8-1.17 1.98 1.98-1.17 1.8.62 1.5 2.1.45v2.8l-2.1.45-.62 1.5 1.17 1.8-1.98 1.98-1.8-1.17-1.5.62-.45 2.1H8.6l-.45-2.1-1.5-.62-1.8 1.17-1.98-1.98 1.17-1.8-.62-1.5-2.1-.45V8.6l2.1-.45.62-1.5-1.17-1.8 1.98-1.98 1.8 1.17 1.5-.62Z"/><circle cx="10" cy="10" r="2.6"/>',
  record: '<path d="M5 3h8.5L16 5.5V17H5Z"/><path d="m7.5 10.5 2 2 3.5-4"/>',
  download: '<path d="M10 3v9M6 8.5l4 4 4-4M4 16h12"/>',
  external: '<path d="M8 4H4v12h12v-4"/><path d="M11 3h6v6M17 3l-8 8"/>',
  route: '<circle cx="5" cy="15" r="2"/><circle cx="15" cy="5" r="2"/><path d="M6.5 13.5C9 11 8 8 10.5 7.5S13 6.5 13.5 6.5"/>',
  filter: '<path d="M3 5h14M6 10h8M8.5 15h3"/>',
  mountain: '<path d="M2 16 8 6l3.5 5.5L13.5 9 18 16Z"/>',
  check: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
};

/** 아이콘 SVG 문자열. el(…, { html }) 또는 innerHTML로 넣는다. */
export function icon(name, { size = 20, cls = '' } = {}) {
  const body = PATHS[name] || '';
  return `<svg class="ic ic-${name}${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** 아이콘 하나를 담은 DOM 노드(span). */
export function iconNode(name, opts) {
  const span = document.createElement('span');
  span.className = 'ic-wrap';
  span.innerHTML = icon(name, opts);
  return span;
}

/** 산 기호(삼각형) — 미등정은 외곽선, 등정은 채움. 권역 색을 쓰지 않으면 잉크색. */
export function summitSymbol({ hiked = false, color = 'currentColor', size = 16 } = {}) {
  const fill = hiked ? color : 'var(--map-symbol-fill, #fffef9)';
  return `<svg class="summit-sym${hiked ? ' hiked' : ''}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2.2 14.6 13.6H1.4Z" fill="${fill}" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
}
