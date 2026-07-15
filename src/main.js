import './style.css';
import { el, clear } from './dom.js';
import { initTheme, toggleTheme } from './store.js';
import { renderHome } from './views/home.js';
import { renderDetail } from './views/detail.js';
import { renderStats } from './views/stats.js';

initTheme();

const appRoot = document.getElementById('app');

// ---- header ----
const nav = el('nav', { class: 'nav', 'aria-label': '주요 메뉴' },
  el('a', { href: '#/', dataset: { route: 'home' } }, '지도'),
  el('a', { href: '#/stats', dataset: { route: 'stats' } }, '나의 기록'),
  el('a', { class: 'external-nav', href: 'https://ko.wikipedia.org/wiki/대한민국_100대_명산_목록', target: '_blank', rel: 'noopener' }, '원자료 ↗'));

const themeBtn = el('button', { class: 'icon-btn', title: '테마 전환', 'aria-label': '테마 전환' }, '◐');
themeBtn.addEventListener('click', () => { toggleTheme(); window.dispatchEvent(new Event('kr100:theme')); });

const header = el('header', { class: 'app-header' },
  el('a', { class: 'brand', href: '#/', style: 'color:inherit' },
    el('span', { class: 'logo' }, '⛰️'),
    el('div', {}, el('h1', {}, '대한민국 100대 명산'),
      el('small', {}, '산림청 · 블랙야크(BAC) 통합 위키'))),
  nav, themeBtn);

const main = el('main', { id: 'view' });
appRoot.append(header, main);

// ---- router ----
let cleanup = null;
async function route() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  clear(main);
  main.className = '';
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path] = hash.split('?');
  const parts = path.split('/').filter(Boolean); // [] | ['m', id] | ['stats']

  markActiveNav(parts[0] === 'stats' ? 'stats' : 'home');

  try {
    if (parts[0] === 'm' && parts[1]) {
      cleanup = await renderDetail(main, decodeURIComponent(parts[1]));
    } else if (parts[0] === 'stats') {
      main.className = '';
      cleanup = await renderStats(main);
    } else {
      main.className = 'home-mode';
      cleanup = await renderHome(main);
    }
  } catch (e) {
    console.error(e);
    clear(main);
    main.append(el('div', { class: 'page' }, el('div', { class: 'empty' }, '오류: ' + e.message)));
  }
}
function markActiveNav(route) {
  [...nav.querySelectorAll('a[data-route]')].forEach((a) => {
    const on = a.dataset.route === route;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

window.addEventListener('hashchange', route);
route();
