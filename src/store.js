// Hiked-mountain tracking + theme, persisted in localStorage.
const HIKED_KEY = 'kr100:hiked';   // { [id]: ISOdate }
const THEME_KEY = 'kr100:theme';   // 'light' | 'dark' | null(=system)

const listeners = new Set();
function emit() { listeners.forEach((fn) => fn()); }
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function read() {
  try { return JSON.parse(localStorage.getItem(HIKED_KEY)) || {}; }
  catch { return {}; }
}
function write(obj) { localStorage.setItem(HIKED_KEY, JSON.stringify(obj)); emit(); }

export function isHiked(id) { return id in read(); }
export function hikedMap() { return read(); }
export function hikedCount() { return Object.keys(read()).length; }

export function toggleHiked(id, on) {
  const obj = read();
  const next = on === undefined ? !(id in obj) : on;
  if (next) obj[id] = obj[id] || new Date().toISOString().slice(0, 10);
  else delete obj[id];
  write(obj);
  return next;
}

export function setHikedDate(id, date) {
  const obj = read();
  if (id in obj) { obj[id] = date; write(obj); }
}

export function exportHiked() {
  return JSON.stringify({ version: 1, hiked: read() }, null, 2);
}
export function importHiked(json) {
  const parsed = JSON.parse(json);
  const incoming = parsed.hiked || parsed; // tolerate raw map
  const obj = read();
  for (const [id, date] of Object.entries(incoming)) obj[id] = date || obj[id] || '1970-01-01';
  write(obj);
}
export function clearHiked() { write({}); }

/* ---- 최근 본 산 (홈 추천·이어서 보기용) ---- */
const RECENT_KEY = 'kr100:recent';   // [id, ...] 최신순, 최대 12
export function recentViews() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
  catch { return []; }
}
export function recordView(id) {
  if (!id) return;
  const next = [id, ...recentViews().filter((x) => x !== id)].slice(0, 12);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  emit();
}

/* ---- map base type (일반/지형도/스카이뷰) ---- */
const MAPTYPE_KEY = 'kr100:maptype';
export function getMapType() { return localStorage.getItem(MAPTYPE_KEY) || 'default'; }
export function setMapType(t) { localStorage.setItem(MAPTYPE_KEY, t); }

/* ---- theme ---- */
export function initTheme() {
  const t = localStorage.getItem(THEME_KEY);
  if (t) document.documentElement.setAttribute('data-theme', t);
}
export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = cur ? (cur === 'dark' ? 'light' : 'dark') : (sysDark ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_KEY, next);
  emit();
  return next;
}
