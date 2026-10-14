import './css/base.css';
import './css/shell.css';
import { el, clear } from './dom.js';
import { applyTheme } from './prefs.js';
import { getShell } from './shell.js';
import { setRouteHandler, interceptLinks, currentRoute } from './router.js';
import { initSync } from './sync.js';
import { closeModal } from './modal.js';

applyTheme();
initSync(); // 클라우드 동기화(설정된 경우) — 실패해도 앱은 로컬로 동작

const appRoot = document.getElementById('app');
const mapHost = el('div', { class: 'map-app' });
const page = el('main', { id: 'page', class: 'page-host', tabindex: '-1', hidden: true });
appRoot.append(
  el('a', { class: 'skip-link', href: '#page', onClick: (e) => { e.preventDefault(); skipToMain(); } }, '본문으로 건너뛰기'),
  mapHost, page);

// 화면 모듈은 필요할 때 불러온다(첫 화면 = 지도 + 목록만 즉시).
const MAP_ROUTES = {
  list: () => import('./views/list.js').then((m) => m.renderList),
  mountain: () => import('./views/mountain.js').then((m) => m.renderMountain),
  walk: () => import('./views/walk.js').then((m) => m.renderWalk),
};
const PAGES = {
  track: () => import('./views/stats.js').then((m) => m.renderStats),
  settings: () => import('./views/settings.js').then((m) => m.renderSettings),
  courses: () => import('./views/courses.js').then((m) => m.renderCourses),
};

let pageCleanup = null;
let routeVersion = 0;
let shownPage = null;   // 지금 보이는 전체 페이지(track·settings·courses) — 지도로 돌아올 때 포커스를 돌려줄 곳을 고른다

/** 본문으로 건너뛰기: 전체 페이지면 그 페이지, 지도 화면이면 시트 제목(상단 바·지도 컨트롤을 건너뛴다). */
function skipToMain() {
  if (!page.hidden) { page.focus(); return; }
  const t = document.querySelector('.shell:not([hidden]) .sheet .sheet-title');
  if (!t) return;
  if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');
  t.focus();
}

function resolve(r) {
  const [a, b] = r.parts;
  if (!a || a === 'map') return { kind: 'map', name: 'list', key: 'list' };
  if (a === 'm' && b) return { kind: 'map', name: 'mountain', key: b };
  if (a === 'walk' && b) return { kind: 'map', name: 'walk', key: b };
  if (a === 'track' || a === 'stats') return { kind: 'page', name: 'track', title: '내 기록' };
  if (a === 'settings') return { kind: 'page', name: 'settings', title: '설정' };
  if (a === 'courses') return { kind: 'page', name: 'courses', title: '대표 코스 모음' };
  return { kind: 'map', name: 'list', key: 'list' };
}

async function route() {
  const version = ++routeVersion;
  // 화면이 바뀌면(뒤로가기 포함) 열려 있던 필터·레이어 모달을 닫는다 — 남으면 다음 화면을 가린다.
  // 다른 모듈이 직접 연 <dialog>(등정 기록 등)도 같이 닫는다(replaceState 이동은 hashchange를 내지 않는다).
  closeModal();
  document.querySelectorAll('dialog[open]').forEach((d) => { try { d.close(); } catch {} });
  const r = currentRoute();
  const target = resolve(r);
  try {
    if (target.kind === 'map') {
      // 전체 페이지에서 돌아오는가, 그 페이지가 포커스를 갖고 있었는가 — 페이지를 지우기 전에 기억한다.
      const fromPage = page.hidden ? null : shownPage;
      const pageHadFocus = !!fromPage && !!document.activeElement && (document.activeElement === page || page.contains(document.activeElement));
      if (pageCleanup) { try { pageCleanup(); } catch {} pageCleanup = null; }
      page.hidden = true; clear(page); shownPage = null;
      mapHost.hidden = false;
      document.body.classList.remove('page-mode');
      const shell = await getShell(mapHost);
      if (version !== routeVersion) return;
      // 다음 화면 모듈을 받는 동안(첫 방문은 네트워크) 이전 컨트롤러가 주소·지도를 건드리지 않게 먼저 끝낸다.
      shell.leave(target.name, target.key);
      const factory = await MAP_ROUTES[target.name]();
      if (version !== routeVersion) return;
      // 페이지에서 돌아오면 그 페이지로 가는 상단 바 버튼(기록·설정)으로, 없으면(대표 코스 모음) 시트 제목으로.
      const returnFocus = pageHadFocus ? (shell.root.querySelector(`.tb a[href="#/${fromPage}"]`) || true) : null;
      await shell.open(target.name, target.key, factory, { ...r, id: target.key }, { returnFocus });
      document.title = docTitle(target, r, shell);
    } else {
      const shell = await getShell(mapHost).catch(() => null);
      // 셸을 기다리는 사이 더 새 이동(예: 뒤로가기로 지도)이 시작됐다 — 지도를 숨기거나 페이지를 띄우면 안 된다.
      if (version !== routeVersion) return;
      shell?.hide();
      mapHost.hidden = true;
      document.body.classList.add('page-mode');
      if (pageCleanup) { try { pageCleanup(); } catch {} pageCleanup = null; }
      clear(page); page.hidden = false; shownPage = target.name;
      const mount = el('div', { class: 'page-mount' }, el('p', { class: 'page-loading', role: 'status' }, '불러오는 중…'));
      page.append(mount);
      const render = await PAGES[target.name]();
      if (version !== routeVersion) return;
      clear(mount);
      const cleanup = await render(mount, r);
      if (version !== routeVersion) { cleanup?.(); return; }
      pageCleanup = cleanup || null;
      document.title = `${target.title} · 대한민국 100대 명산`;
      window.scrollTo(0, 0);
      page.focus({ preventScroll: true });
    }
  } catch (e) {
    if (version !== routeVersion) return;
    console.error(e);
    mapHost.hidden = true;
    clear(page); page.hidden = false; shownPage = null;
    page.append(el('div', { class: 'page-error', role: 'alert' },
      el('strong', {}, '화면을 불러오지 못했습니다.'),
      el('p', {}, '연결 상태를 확인한 뒤 다시 시도해 주세요.'),
      el('button', { class: 'btn primary', type: 'button', onClick: () => location.reload() }, '다시 불러오기')));
  }
}

function docTitle(target, r, shell) {
  const base = '대한민국 100대 명산';
  if (target.name === 'mountain') { const m = shell.data.byId.get(target.key); if (m) return `${m.name_full} · ${base}`; }
  if (target.name === 'walk') { const h = document.querySelector('.sheet .sheet-title'); if (h?.textContent) return `${h.textContent} · ${base}`; }
  if (target.name === 'list' && r.params.get('mode') === 'walk') return `걷기길 지도 · ${base}`;
  return `${base} · 지도`;
}

setRouteHandler(route);
interceptLinks(document);
// 해시 이동(뒤로가기·주소창 수정·location.hash 대입)은 모두 popstate를 낸다. hashchange까지 들으면 두 번 그린다.
window.addEventListener('popstate', route);
route();
