// 마지막 목록 조건은 상세 화면을 새로고침한 뒤에도 같은 탭 안에서 복원한다.
const KEY = 'kr100:last-list';
export function savedListHash() {
  try {
    const hash = sessionStorage.getItem(KEY);
    if (/^#\/map(?:\?|$)/.test(hash || '')) return hash;
  } catch {}
  return '#/map';
}
export function rememberList(params) {
  const query = params.toString();
  const hash = '#/map' + (query ? '?' + query : '');
  try { sessionStorage.setItem(KEY, hash); } catch {}
  return hash;
}
