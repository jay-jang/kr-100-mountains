// URL의 명시적 조건이 우선. 빈 첫 방문과 앱의 복귀 링크만 마지막 조건을 사용한다.
const KEY = 'kr100:last-list';
const COURSE_KEY = 'kr100:last-courses';
const memory = new Map();
function saved(key, path) {
  for (const read of [() => memory.get(key), () => localStorage.getItem(key), () => sessionStorage.getItem(key)]) {
    try {
      const hash = read();
      if (hash === path || hash?.startsWith(path + '?')) {
        memory.set(key, hash);
        try { if (localStorage.getItem(key) !== hash) localStorage.setItem(key, hash); } catch {}
        return hash;
      }
    } catch {}
  }
  return path;
}
function remember(key, path, params) {
  const query = params.toString();
  const hash = path + (query ? '?' + query : '');
  memory.set(key, hash);
  try { localStorage.setItem(key, hash); } catch {}
  try { sessionStorage.setItem(key, hash); } catch {}
  return hash;
}
export const savedListHash = () => saved(KEY, '#/map');
export const rememberList = (params) => remember(KEY, '#/map', params);
// 앱 안의 단축 동작은 자신이 바꾸는 조건만 덮는다. 외부의 명시적 URL에는 적용하지 않는다.
export function listHashWith(changes, hash = savedListHash()) {
  const params = new URLSearchParams(hash.split('?')[1] || '');
  params.delete('focus');
  for (const [key, value] of Object.entries(changes)) {
    if (value == null || value === '') params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return '#/map' + (query ? '?' + query : '');
}
export const savedCoursesHash = () => saved(COURSE_KEY, '#/courses');
export const rememberCourses = (params) => remember(COURSE_KEY, '#/courses', params);
