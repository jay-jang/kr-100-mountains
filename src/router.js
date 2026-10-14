// 해시 라우팅 도우미 — 화면 모듈이 main.js를 import하지 않고도 이동할 수 있게 한다.
//
// 앱 안에서 연 화면은 history.state.kr100.depth를 1씩 늘려 쌓는다. 그래서 [×]·Esc는
// "앱 안에서 왔으면 뒤로가기, 링크로 바로 들어왔으면 상위 화면으로 교체"를 구분할 수 있다.
let onRoute = () => {};
export function setRouteHandler(fn) { onRoute = fn; }

const depth = () => history.state?.kr100?.depth || 0;

// 뒤로가기는 비동기다 — history.back()을 부른 뒤 popstate가 오기 전까지 history.state는 그대로라서,
// [×]를 두 번 빨리 누르면(또는 긴 작업 중에 쌓인 두 번의 탭) 두 번 뒤로 가 앱 밖으로 나간다.
// 그래서 "이동 중" 표시를 두고 popstate(또는 bfcache 복원 pageshow)가 올 때까지 다음 뒤로가기를 무시한다.
// popstate가 끝내 오지 않는 경우(취소된 이동·다른 문서로의 이동)를 위해 시간 제한으로도 푼다.
let traversing = false;
let settleTimer = 0;
function settle() { traversing = false; clearTimeout(settleTimer); }
// router.js는 main.js가 route()를 popstate에 붙이기 전에 평가되므로 이 처리기가 먼저 돈다.
window.addEventListener('popstate', settle);
window.addEventListener('pageshow', settle);

/** 앱 안 기록을 steps만큼 뒤로. 이미 뒤로 가는 중이면 무시한다(이중 탭 보호). */
export function goBack(steps = 1) {
  if (traversing) return;
  traversing = true;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, 800);
  history.go(-Math.max(1, steps));
}

/** 앱 안 이동. replace=true면 기록을 쌓지 않는다(필터 변경 등). */
export function navigate(hash, { replace = false, state = {} } = {}) {
  if (!hash.startsWith('#')) hash = '#' + hash;
  // 뒤로 가는 중에 새 기록을 쌓으면 곧 도착할 popstate가 방금 쌓은 화면을 다시 걷어 낸다 — 이동이 끝난 뒤의 탭만 받는다.
  if (traversing && !replace) return;
  if (hash === location.hash && !replace) { onRoute(); return; }
  const next = { ...state, kr100: { depth: replace ? depth() : depth() + 1 } };
  if (replace) history.replaceState(next, '', hash);
  else history.pushState(next, '', hash);
  onRoute();
}

/** 한 단계 위로. 앱 안에서 쌓인 기록이 있으면 브라우저 뒤로가기와 같다. */
export function goUp(parentHash) {
  if (traversing) return;
  if (depth() > 0) goBack(1);
  else navigate(parentHash, { replace: true });
}

export function currentRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { path, parts, params: new URLSearchParams(query), hash: '#' + hash };
}

/** 문서 전체의 앱 내부 링크(#/…)를 navigate로 처리 — 깊이 기록이 일관되게 쌓인다. */
export function interceptLinks(root = document) {
  root.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('a[href^="#/"]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    e.preventDefault();
    navigate(a.getAttribute('href'), { replace: a.dataset.replace === '1' });
  });
}
