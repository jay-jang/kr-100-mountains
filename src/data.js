// Loads and indexes the compiled mountain dataset.
let _data = null;

export async function loadData() {
  if (_data) return _data;
  const res = await fetch(`${import.meta.env.BASE_URL}data/mountains.json`);
  if (!res.ok) throw new Error(`데이터를 불러오지 못했습니다 (${res.status})`);
  const raw = await res.json();
  _data = {
    meta: raw.meta,
    mountains: raw.mountains,
    byId: new Map(raw.mountains.map((m) => [m.id, m])),
  };
  return _data;
}

export const REGION_COLORS = {
  수도권: 'var(--r-capital)',
  강원: 'var(--r-gangwon)',
  충청: 'var(--r-chungcheong)',
  전라: 'var(--r-jeolla)',
  경상: 'var(--r-gyeongsang)',
  제주: 'var(--r-jeju)',
};
// resolve a CSS var to a concrete color for Leaflet (which can't use CSS vars)
export function regionColor(region) {
  const varName = { 수도권: '--r-capital', 강원: '--r-gangwon', 충청: '--r-chungcheong',
    전라: '--r-jeolla', 경상: '--r-gyeongsang', 제주: '--r-jeju' }[region] || '--accent';
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || '#2f7d4f';
}

export const DIFF_CLASS = { '쉬움': 'd1', '보통': 'd2', '어려움': 'd3', '매우 어려움': 'd4' };

// filter predicate factory
export function filterMountains(mountains, { q, regions, list, hikedOnly, isHiked }) {
  const query = (q || '').trim().toLowerCase();
  return mountains.filter((m) => {
    if (regions && regions.size && !regions.has(m.region)) return false;
    if (list === 'sanlim' && !m.lists.sanlim) return false;
    if (list === 'bac' && !m.lists.bac) return false;
    if (list === 'both' && !(m.lists.sanlim && m.lists.bac)) return false;
    if (hikedOnly && !isHiked(m.id)) return false;
    if (query) {
      const hay = `${m.name} ${m.name_full} ${m.province} ${m.location} ${m.id}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}
