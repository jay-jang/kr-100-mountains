// 지도 위 바텀시트 — 앱 전체에 하나. 내용(헤더·본문)만 화면마다 바뀐다.
//
// 단계: min(그래버만) · peek(헤더 실측 높이) · half(가용 높이의 절반) · full(검색 바 아래까지).
// 높이는 transform이 아니라 height로 바꾼다 — 그래야 어느 단계에서든 본문 스크롤이 정상 동작한다.
// 드래그는 그래버와 헤더에서만 받는다(본문은 스크롤). 그래버는 <button>이라 탭·키보드로도 단계를 바꾼다.
// 데스크톱(≥1024px)에서는 단계 없이 왼쪽 패널이 된다(CSS가 배치, 여기서는 높이 계산을 멈춘다).
import { el, clear } from './dom.js';

const DETENT_LABEL = { min: '접힘', peek: '낮음', half: '중간', full: '높음' };
const TOP_GAP = 72;          // full일 때 남겨 두는 상단 높이 — 검색 바 + 지도 띠(M3 top margin 72dp)
const MIN_H = 45;            // 그래버만 보이는 높이 — 그래버 44px(누르는 영역) + 시트 윗선 1px
const VELOCITY = 0.5;        // px/ms — 이보다 빠르게 놓으면 진행 방향의 다음 단계로

export function createSheet({ onChange } = {}) {
  const grabber = el('button', { class: 'sheet-grabber', type: 'button', 'aria-label': '시트 크기' },
    el('span', { class: 'sheet-grabber-bar', 'aria-hidden': 'true' }));
  const head = el('div', { class: 'sheet-head' });
  const body = el('div', { class: 'sheet-body' });
  const root = el('section', { class: 'sheet', 'aria-label': '목록', dataset: { detent: 'peek' } }, grabber, head, body);
  const desktopMq = window.matchMedia('(min-width: 1024px)');

  let detent = 'peek';
  let peekPx = 96;
  let dragging = null;
  let destroyed = false;

  const viewportH = () => (window.visualViewport?.height || window.innerHeight);
  // safe-area(아이폰 홈 막대)는 시트의 padding-bottom(env())으로 들어가 있다 — 계산된 값을 읽는다.
  const safeBottom = () => parseFloat(getComputedStyle(root).paddingBottom) || 0;

  function heightFor(d) {
    const vh = viewportH();
    const avail = vh - TOP_GAP;
    if (d === 'min') return MIN_H + safeBottom();
    if (d === 'peek') return Math.min(peekPx + safeBottom(), avail);
    if (d === 'half') return Math.max(Math.min(peekPx + safeBottom() + 40, avail), Math.round(avail * 0.5));
    return avail;
  }
  const isDesktop = () => desktopMq.matches;

  function apply({ animate = true } = {}) {
    if (destroyed) return;
    root.dataset.detent = detent;
    grabber.setAttribute('aria-label', `시트 크기: ${DETENT_LABEL[detent]}. 눌러서 바꾸기`);
    if (isDesktop()) { root.style.height = ''; root.classList.remove('no-anim'); notify(); return; }
    root.classList.toggle('no-anim', !animate);
    root.style.height = `${heightFor(detent)}px`;
    notify();
  }
  function notify() {
    const h = isDesktop() ? 0 : heightFor(detent);
    onChange?.({ detent, height: h, peek: isDesktop() ? 0 : heightFor('peek'), desktop: isDesktop() });
  }

  function setDetent(d, opts) {
    if (!DETENT_LABEL[d]) return;
    detent = d;
    apply(opts);
  }

  // 그래버: 탭 = peek→half→full→peek 순환(탭만으로 다시 접을 수 있게), ↑↓ = 한 단계씩.
  const ORDER = ['min', 'peek', 'half', 'full'];
  const CYCLE = { min: 'peek', peek: 'half', half: 'full', full: 'peek' };
  grabber.addEventListener('click', () => { setDetent(CYCLE[detent] || 'half'); });
  grabber.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const i = ORDER.indexOf(detent) + (e.key === 'ArrowUp' ? 1 : -1);
      setDetent(ORDER[Math.max(0, Math.min(ORDER.length - 1, i))]);
    }
  });

  // ---- 드래그(그래버 + 헤더) ----
  // 움직임·놓음은 끄는 동안만 window에서 받는다. 마우스는 터치와 달리 누른 요소에 포인터가 묶이지 않아서,
  // 시트에서만 들으면 6px 문턱을 넘기 전에 커서가 시트 밖으로 나간 빠른 드래그는 시작도 못 하고,
  // 놓음(pointerup)도 놓쳐 버튼을 뗀 뒤에도 시트가 커서를 따라다닌다.
  function listen(on) {
    const f = on ? window.addEventListener : window.removeEventListener;
    f.call(window, 'pointermove', onMove);
    f.call(window, 'pointerup', onUp);
    f.call(window, 'pointercancel', onUp);
  }
  function onDown(e) {
    if (isDesktop() || e.button > 0) return;
    // 헤더 안의 버튼·입력·링크를 누른 것은 드래그가 아니다(움직이기 시작하면 드래그로 바꾼다).
    dragging = { y0: e.clientY, h0: root.getBoundingClientRect().height, t0: e.timeStamp, last: [], moved: false, id: e.pointerId, target: e.target };
    listen(false); listen(true);
  }
  function onMove(e) {
    if (!dragging || e.pointerId !== dragging.id) return;
    // 안전장치: 버튼을 뗀 마우스인데 놓음을 못 받았다 — 끄기를 끝낸다.
    if (e.pointerType === 'mouse' && e.buttons === 0) { onUp(e); return; }
    const dy = e.clientY - dragging.y0;
    if (!dragging.moved) {
      if (Math.abs(dy) < 6) return;
      dragging.moved = true;
      try { root.setPointerCapture(e.pointerId); } catch {}
      root.classList.add('dragging', 'no-anim');
    }
    const h = Math.max(MIN_H, Math.min(heightFor('full'), dragging.h0 - dy));
    root.style.height = `${h}px`;
    dragging.last.push([e.timeStamp, e.clientY]);
    if (dragging.last.length > 5) dragging.last.shift();
    onChange?.({ detent, height: h, peek: heightFor('peek'), desktop: false, dragging: true });
  }
  function onUp(e) {
    if (!dragging || e.pointerId !== dragging.id) return;
    const d = dragging; dragging = null;
    listen(false);
    root.classList.remove('dragging');
    if (!d.moved) return;
    // 드래그가 끝난 뒤 따라오는 click(헤더 버튼 등)이 동작하지 않게 한 번 막는다.
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    root.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => root.removeEventListener('click', swallow, { capture: true }), 0);
    const h = root.getBoundingClientRect().height;
    let v = 0;
    if (d.last.length >= 2) {
      const [t1, y1] = d.last[0], [t2, y2] = d.last[d.last.length - 1];
      v = (y2 - y1) / Math.max(1, t2 - t1);      // +면 아래로
    }
    const stops = ORDER.map(k => [k, heightFor(k)]);
    let target;
    if (Math.abs(v) > VELOCITY) {
      // 진행 방향의 다음 단계
      const sorted = stops.slice().sort((a, b) => a[1] - b[1]);
      target = v > 0 ? [...sorted].reverse().find(([, sh]) => sh < h - 4)?.[0] || 'min'
        : sorted.find(([, sh]) => sh > h + 4)?.[0] || 'full';
    } else {
      target = stops.reduce((best, s) => (Math.abs(s[1] - h) < Math.abs(best[1] - h) ? s : best))[0];
    }
    setDetent(target);
  }
  for (const n of [grabber, head]) n.addEventListener('pointerdown', onDown);

  // 본문을 half에서 위로 밀면(터치) full로 펼친다. full에서 맨 위인데 아래로 당기면 half로.
  // 세로가 주된 몸짓만 시트 몸짓으로 본다 — 고도 단면을 가로로 훑다가(손가락이 조금 위로 흘러도) 시트가
  // full로 튀어 오르면 훑던 지점이 지도에서 가려진다.
  let touchY = null, touchX = 0;
  body.addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; touchX = e.touches[0].clientX; }, { passive: true });
  body.addEventListener('touchmove', (e) => {
    if (touchY == null || isDesktop()) return;
    const dy = e.touches[0].clientY - touchY, dx = e.touches[0].clientX - touchX;
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { touchY = null; return; }   // 가로 몸짓(단면 훑기·가로 스크롤)
    if (detent !== 'full' && dy < -24 && body.scrollHeight > body.clientHeight + 2) { touchY = null; setDetent('full'); }
    else if (detent === 'full' && dy > 48 && body.scrollTop <= 0) { touchY = null; setDetent('half'); }
  }, { passive: true });
  body.addEventListener('touchend', () => { touchY = null; }, { passive: true });

  // peek에서 본문은 높이가 0px인데 행·링크는 Tab 순서에 남는다 — 키보드·보조기기 포커스가 본문으로 들어오면
  // 시트를 half로 올려 포커스가 보이게 한다(min에서는 본문이 visibility:hidden이라 포커스가 들어오지 않는다).
  body.addEventListener('focusin', (e) => {
    if (isDesktop() || (detent !== 'peek' && detent !== 'min')) return;
    setDetent('half');
    // 본문이 0px일 때 브라우저가 이미 스크롤해 버렸다 — 높이가 자리 잡은 뒤 다시 보이게 한다.
    // (축소 동작 설정이면 전환이 없어 transitionend가 오지 않으므로 시간으로 기다린다)
    const t = e.target;
    setTimeout(() => { if (t.isConnected && document.activeElement === t) t.scrollIntoView({ block: 'nearest' }); }, 260);
  });

  // 헤더 높이가 바뀌면(내용 교체·글자 확대) peek을 다시 잰다.
  const ro = new ResizeObserver(() => measure());
  ro.observe(head);
  function measure() {
    if (destroyed) return;
    const gh = grabber.offsetHeight || 20;
    const next = Math.ceil(gh + head.offsetHeight);
    if (next && Math.abs(next - peekPx) > 1) { peekPx = next; if (!dragging) apply({ animate: false }); }
  }
  const onViewport = () => { if (!dragging) apply({ animate: false }); };
  window.addEventListener('resize', onViewport);
  window.visualViewport?.addEventListener('resize', onViewport);
  desktopMq.addEventListener('change', onViewport);

  return {
    root, head, body, grabber,
    get detent() { return detent; },
    setDetent,
    /** 헤더·본문 교체. label은 시트의 접근성 이름. detent를 주면 그 단계로. */
    setContent({ header, content, label, detent: d } = {}) {
      clear(head); clear(body);
      if (header) head.append(header);
      if (content) body.append(content);
      body.scrollTop = 0;
      if (label) root.setAttribute('aria-label', label);
      measure();
      if (d) setDetent(d, { animate: true }); else apply({ animate: false });
    },
    /** 지금 시트가 지도를 가리는 높이(px). 데스크톱은 0. */
    visibleHeight() { return isDesktop() ? 0 : heightFor(detent); },
    peekHeight() { return isDesktop() ? 0 : heightFor('peek'); },
    isDesktop,
    refresh() { measure(); apply({ animate: false }); },
    destroy() {
      destroyed = true; ro.disconnect(); listen(false);
      window.removeEventListener('resize', onViewport);
      window.visualViewport?.removeEventListener('resize', onViewport);
      desktopMq.removeEventListener('change', onViewport);
      root.remove();
    },
  };
}
