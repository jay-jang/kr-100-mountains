// 목록과 상세 지도에 같은 필터 판정을 적용한다. 정렬·지도 선택 강조는 별도 상태다.
import { filterMountains, LIST_KEYS } from './data.js';

export const REGIONS = ['수도권', '강원', '충청', '전라', '경상', '제주'];
export const WALK_KINDS = [['', '전체'], ['dulle', '둘레길'], ['long', '장거리'], ['ridge', '마루금'], ['forest', '숲길'], ['trail', '탐방로']];

export function parseListParams(params) {
  const csv = (k) => (params.get(k) ? params.get(k).split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    mode: params.get('mode') === 'walk' ? 'walk' : 'mountain',
    q: params.get('q') || '',
    regions: new Set(csv('region').filter((r) => REGIONS.includes(r))),
    lists: new Set(params.get('all') === '4' ? [] : csv('list').filter((k) => LIST_KEYS.includes(k))),
    allFour: params.get('all') === '4',
    hiked: params.get('hiked') === '1' ? 'yes' : params.get('hiked') === '0' ? 'no' : '',
    sort: params.get('sort') === 'near' ? 'near' : 'default',
    easy: params.get('easy') === '1',
    maxHours: [2, 4, 6, 8].includes(Number(params.get('hours'))) ? Number(params.get('hours')) : 0,
    maxDistance: [5, 10, 15].includes(Number(params.get('distance'))) ? Number(params.get('distance')) : 0,
    dulle: params.get('dulle') === '1',
    walkKind: WALK_KINDS.some(([k]) => k === params.get('walkkind')) ? params.get('walkkind') : '',
    focus: params.get('focus') || null,
  };
}
export function filterListMountains(mountains, state, { isHiked, trekIndex = null }) {
  let list = filterMountains(mountains, {
    q: state.q, regions: state.regions, lists: state.lists, allFour: state.allFour,
    hikedOnly: state.hiked === 'yes', isHiked, easy: state.easy, maxHours: state.maxHours, maxDistance: state.maxDistance,
  });
  if (state.hiked === 'no') list = list.filter(m => !isHiked(m.id));
  if (state.dulle) list = list.filter(m => {
    const kinds = trekIndex?.[m.id]?.kinds || {};
    return ['dulle', 'forest', 'ridge', 'other'].some(kind => kinds[kind] > 0);
  });
  return list;
}
