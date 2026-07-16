// Builds data/registry.json — the canonical merged registry of Korea's "100대 명산".
// Sources:
//  - 산림청(Korea Forest Service) 100대 명산: names/elevation/location from ko.wikipedia
//    "대한민국 100대 명산 목록" (survey-grade elevations).
//  - 블랙야크(BAC) 명산100: membership cross-verified via codex agent against namu.wiki
//    comparison table (data/sources/bac_resolution.json). 79 overlap, 21 BAC-only,
//    21 산림청-only. 천마산(남양주)=BAC, 명성산=산림청-only.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/* ------------------------------------------------------------------ *
 * Hangul → Latin slug romanizer (syllable-wise, good enough for URLs) *
 * ------------------------------------------------------------------ */
const CHO = ['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
const JUNG = ['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i'];
const JONG = ['','k','kk','ks','n','nj','nh','t','l','lk','lm','lb','ls','lt','lp','lh','m','p','ps','t','t','ng','t','t','k','t','p','h'];
function romanize(str) {
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const s = code - 0xac00;
      const cho = Math.floor(s / 588);
      const jung = Math.floor((s % 588) / 28);
      const jong = s % 28;
      out += CHO[cho] + JUNG[jung] + JONG[jong];
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      out += ch.toLowerCase();
    }
    // drop spaces, punctuation, hanja
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '') || 'x';
}

/* ------------------------------------------------------------------ *
 * Region (권역) grouping                                              *
 * ------------------------------------------------------------------ */
const REGION_ORDER = ['수도권', '강원', '충청', '전라', '경상', '제주'];
function regionsOf(loc) {
  const found = new Set();
  if (/서울|인천|경기/.test(loc)) found.add('수도권');
  if (/강원/.test(loc)) found.add('강원');
  if (/대전|세종|충청|충남|충북/.test(loc)) found.add('충청');
  if (/광주|전라|전북|전남/.test(loc)) found.add('전라');
  if (/부산|대구|울산|경상|경북|경남/.test(loc)) found.add('경상');
  if (/제주/.test(loc)) found.add('제주');
  return [...found];
}
function primaryRegion(loc) {
  // region of the FIRST province token listed
  const first = loc.split(/[,，]/)[0];
  const r = regionsOf(first);
  return r[0] || regionsOf(loc)[0] || '기타';
}
// short province label for the primary province, for compact display
function provinceShort(loc) {
  const first = loc.split(/[,，]/)[0].trim();
  const m = first.match(/^(서울|인천|경기|강원|대전|세종|충청북도|충청남도|충북|충남|광주|전라북도|전라남도|전북|전남|부산|대구|울산|경상북도|경상남도|경북|경남|제주)/);
  const raw = m ? m[1] : first.split(/\s/)[0];
  const map = {
    '서울특별시':'서울','인천광역시':'인천','경기도':'경기','강원특별자치도':'강원','강원':'강원',
    '대전광역시':'대전','세종특별자치시':'세종','충청북도':'충북','충청남도':'충남',
    '광주광역시':'광주','전북특별자치도':'전북','전라북도':'전북','전라남도':'전남',
    '부산광역시':'부산','대구광역시':'대구','울산광역시':'울산','경상북도':'경북','경상남도':'경남',
    '제주특별자치도':'제주',
  };
  return map[raw] || map[first] || raw;
}

/* ------------------------------------------------------------------ *
 * 산림청 100대 명산 — [name, elevation(m), location]                  *
 * order = official Wikipedia listing (가나다)                         *
 * ------------------------------------------------------------------ */
const SANLIM = [
  ['가리산', 1050.9, '강원특별자치도 홍천군·춘천시'],
  ['가리왕산', 1561.9, '강원특별자치도 정선군·평창군'],
  ['가야산', 1432.6, '경상남도 합천군·거창군, 경상북도 성주군'],
  ['가지산', 1240.9, '울산광역시 울주군, 경상북도 청도군, 경상남도 밀양시'],
  ['감악산', 674.9, '경기도 파주시·양주시·연천군'],
  ['강천산', 583.7, '전북특별자치도 순창군, 전라남도 담양군'],
  ['계룡산', 846.5, '대전광역시, 충청남도 공주시·논산시·계룡시'],
  ['계방산', 1579.1, '강원특별자치도 홍천군·평창군'],
  ['공작산', 887.4, '강원특별자치도 홍천군'],
  ['관악산', 632.2, '서울특별시 관악구, 경기도 안양시·과천시'],
  ['구병산', 876.3, '경상북도 상주시, 충청북도 보은군'],
  ['금산', 704.9, '경상남도 남해군'],
  ['금수산', 1015.8, '충청북도 제천시·단양군'],
  ['금오산', 976.5, '경상북도 구미시·칠곡군·김천시'],
  ['금정산', 800.8, '부산광역시 금정구·북구, 경상남도 양산시'],
  ['깃대봉', 360.7, '전라남도 신안군 흑산면 홍도'],
  ['남산', 495.1, '경상북도 경주시'],
  ['내연산', 711.3, '경상북도 포항시·영덕군'],
  ['내장산', 763.5, '전북특별자치도 정읍시·순창군'],
  ['대둔산', 878.9, '충청남도 논산시·금산군, 전북특별자치도 완주군'],
  ['대암산', 1312.6, '강원특별자치도 양구군·인제군'],
  ['대야산', 931.0, '경상북도 문경시, 충청북도 괴산군'],
  ['덕숭산', 495.2, '충청남도 예산군'],
  ['덕유산', 1614.2, '전북특별자치도 무주군·장수군, 경상남도 거창군·함양군'],
  ['덕항산', 1072.9, '강원특별자치도 삼척시·태백시'],
  ['도락산', 965.3, '충청북도 단양군'],
  ['도봉산', 740.2, '서울특별시 도봉구, 경기도 의정부시·양주시'],
  ['두륜산', 700.0, '전라남도 해남군'],
  ['두타산', 1357.0, '강원특별자치도 동해시·삼척시'],
  ['마니산', 472.1, '인천광역시 강화군'],
  ['마이산', 687.4, '전북특별자치도 진안군'],
  ['명성산', 922.0, '강원특별자치도 철원군, 경기도 포천시'],
  ['명지산', 1252.3, '경기도 가평군'],
  ['모악산', 795.2, '전북특별자치도 김제시·전주시·완주군'],
  ['무등산', 1186.8, '광주광역시 동구, 전라남도 담양군·화순군'],
  ['무학산', 761.4, '경상남도 창원시'],
  ['미륵산', 458.4, '경상남도 통영시'],
  ['민주지산', 1241.7, '충청북도 영동군, 전북특별자치도 무주군, 경상북도 김천시'],
  ['방장산', 733.6, '전라남도 장성군, 전북특별자치도 고창군·정읍시'],
  ['방태산', 1445.7, '강원특별자치도 인제군·홍천군'],
  ['백덕산', 1350.1, '강원특별자치도 평창군·횡성군·영월군'],
  ['백암산', 741.2, '전북특별자치도 순창군, 전라남도 장성군'],
  ['백운산', 1222.2, '전라남도 광양시·구례군'],           // 광양
  ['백운산', 883.5, '강원특별자치도 정선군·평창군'],        // 정선(동강)
  ['백운산', 903.0, '경기도 포천시, 강원특별자치도 화천군'],  // 포천
  ['변산', 459.0, '전북특별자치도 부안군'],
  ['북한산', 835.6, '서울특별시 강북구·성북구·종로구·은평구, 경기도 고양시·양주시'],
  ['비슬산', 1083.4, '대구광역시 달성군, 경상북도 청도군'],
  ['삼악산', 655.8, '강원특별자치도 춘천시'],
  ['서대산', 904.1, '충청남도 금산군, 충청북도 옥천군'],
  ['선운산', 334.7, '전북특별자치도 고창군'],
  ['설악산', 1708.1, '강원특별자치도 속초시·인제군·양양군'],
  ['성인봉', 986.5, '경상북도 울릉군'],
  ['소백산', 1439.7, '경상북도 영주시, 충청북도 단양군'],
  ['소요산', 587.5, '경기도 동두천시·포천시'],
  ['속리산', 1058.4, '경상북도 상주시, 충청북도 보은군'],
  ['신불산', 1159.3, '울산광역시 울주군'],
  ['연화산', 524.0, '경상남도 고성군'],
  ['오대산', 1565.4, '강원특별자치도 평창군·홍천군·강릉시'],
  ['오봉산', 777.9, '강원특별자치도 춘천시·화천군'],
  ['용문산', 1157.1, '경기도 양평군'],
  ['용화산', 877.8, '강원특별자치도 화천군·춘천시'],
  ['운문산', 1195.1, '경상북도 청도군, 경상남도 밀양시'],
  ['운악산', 934.7, '경기도 가평군·포천시'],
  ['운장산', 1125.8, '전북특별자치도 진안군·완주군'],
  ['월악산', 1095.3, '충청북도 제천시'],
  ['월출산', 810.7, '전라남도 영암군·강진군'],
  ['유명산', 864.0, '경기도 가평군·양평군'],
  ['응봉산', 999.7, '강원특별자치도 삼척시, 경상북도 울진군'],
  ['장안산', 1237.4, '전북특별자치도 장수군'],
  ['재약산', 1119.1, '경상남도 밀양시, 울산광역시 울주군'],
  ['적상산', 1030.6, '전북특별자치도 무주군'],
  ['점봉산', 1426.0, '강원특별자치도 양양군·인제군'],
  ['조계산', 887.3, '전라남도 순천시'],
  ['주왕산', 722.1, '경상북도 청송군·영덕군'],
  ['주흘산', 1108.4, '경상북도 문경시'],
  ['지리산', 1915.4, '전북특별자치도 남원시, 전라남도 구례군, 경상남도 하동군·산청군·함양군'], // 천왕봉
  ['지리산', 399.3, '경상남도 통영시'],                     // 통영 사량도
  ['천관산', 724.3, '전라남도 장흥군'],
  ['천마산', 810.3, '경기도 남양주시'],
  ['천성산', 920.2, '경상남도 양산시'],
  ['천태산', 715.2, '충청북도 영동군, 충청남도 금산군'],
  ['청량산', 869.7, '경상북도 봉화군·안동시'],
  ['추월산', 731.2, '전라남도 담양군, 전북특별자치도 순창군'],
  ['축령산', 887.1, '경기도 남양주시·가평군'],               // 남양주
  ['치악산', 1282.0, '강원특별자치도 원주시·횡성군·영월군'],
  ['칠갑산', 559.7, '충청남도 청양군'],
  ['태백산', 1566.7, '강원특별자치도 태백시, 경상북도 봉화군'],
  ['태화산', 1027.5, '강원특별자치도 영월군, 충청북도 단양군'],
  ['팔공산', 1192.3, '대구광역시 군위군·동구, 경상북도 영천시'],
  ['팔봉산', 328.2, '강원특별자치도 홍천군'],
  ['팔영산', 606.9, '전라남도 고흥군'],
  ['한라산', 1947.3, '제주특별자치도'],
  ['화악산', 1468.3, '경기도 가평군, 강원특별자치도 화천군'],   // 가평
  ['화왕산', 757.7, '경상남도 창녕군'],
  ['황매산', 1113.1, '경상남도 합천군·산청군'],
  ['황석산', 1192.5, '경상남도 함양군'],
  ['황악산', 1111.4, '경상북도 김천시'],
  ['황장산', 1078.9, '경상북도 문경시'],
  ['희양산', 996.4, '경상북도 문경시, 충청북도 괴산군'],
];

// 산림청 mountains NOT in BAC (1-based index into SANLIM). 21 entries.
const SANLIM_ONLY_IDX = new Set([6,9,12,16,21,23,32,36,37,45,50,53,58,63,72,73,78,84,85,99,100]);

// Disambiguators for 산림청 mountains whose base name repeats in the merged set.
const SANLIM_DISAMBIG = {
  3: '합천',   // 가야산
  5: '파주',   // 감악산
  17: '경주',  // 남산
  43: '광양',  // 백운산
  44: '정선',  // 백운산 (동강)
  45: '포천',  // 백운산
  78: '통영',  // 지리산 (사량도)
  85: '남양주', // 축령산
  94: '가평',  // 화악산
};

/* ------------------------------------------------------------------ *
 * BAC-only 21 — [name, elevation(m), location, disambig]             *
 * ------------------------------------------------------------------ */
const BAC_ONLY = [
  ['가야산', 678.0, '충청남도 예산군·서산시', '충남'],
  ['감악산', 930.0, '강원특별자치도 원주시, 충청북도 제천시', '원주'],
  ['광덕산', 699.3, '충청남도 천안시·아산시', '천안'],
  ['구봉산', 1002.0, '전북특별자치도 진안군', '진안'],
  ['노인봉', 1338.0, '강원특별자치도 강릉시·평창군', '오대산'],
  ['달마산', 489.0, '전라남도 해남군', '해남'],
  ['덕룡산', 433.0, '전라남도 강진군', '강진'],
  ['동악산', 735.0, '전라남도 곡성군', '곡성'],
  ['바래봉', 1165.0, '전북특별자치도 남원시', '지리산'],
  ['반야봉', 1732.0, '전북특별자치도 남원시, 전라남도 구례군', '지리산'],
  ['불갑산', 516.0, '전라남도 영광군·함평군', '영광'],
  ['수락산', 638.0, '서울특별시 노원구, 경기도 의정부시·남양주시', '서울'],
  ['연인산', 1068.2, '경기도 가평군', '가평'],
  ['오서산', 790.7, '충청남도 보령시·홍성군', '보령'],
  ['용봉산', 381.0, '충청남도 홍성군·예산군', '홍성'],
  ['조령산', 1026.0, '경상북도 문경시, 충청북도 괴산군', '문경'],
  ['청계산', 618.0, '서울특별시 서초구, 경기도 과천시·성남시·의왕시', '서울'],
  ['청화산', 984.0, '경상북도 상주시·문경시, 충청북도 괴산군', '상주'],
  ['축령산', 621.0, '전라남도 장성군, 전북특별자치도 고창군', '장성'],
  ['칠보산', 778.0, '충청북도 괴산군', '괴산'],
  ['함백산', 1572.9, '강원특별자치도 태백시·정선군', '태백'],
];

/* ------------------------------------------------------------------ *
 * Assemble                                                           *
 * ------------------------------------------------------------------ */
const mountains = [];
const usedSlugs = new Set();
function makeSlug(name, disambig) {
  let base = romanize(name) + (disambig ? '-' + romanize(disambig) : '');
  let slug = base, i = 2;
  while (usedSlugs.has(slug)) slug = `${base}-${i++}`;
  usedSlugs.add(slug);
  return slug;
}

SANLIM.forEach(([name, elev, loc], i) => {
  const idx = i + 1;
  const disambig = SANLIM_DISAMBIG[idx] || '';
  const inBac = !SANLIM_ONLY_IDX.has(idx);
  mountains.push({
    id: makeSlug(name, disambig),
    name,
    disambig,
    name_full: disambig ? `${name}(${disambig})` : name,
    elevation_m: elev,
    location: loc,
    province: provinceShort(loc),
    region: primaryRegion(loc),
    regions: regionsOf(loc),
    lists: { sanlim: true, bac: inBac, hansanha: false, wolgansan: false },
    lat: null, lon: null,
    // enrichment fields (filled by research step)
    summary: null, trails: [], transport: null, features: [], sources: [],
  });
});

BAC_ONLY.forEach(([name, elev, loc, disambig]) => {
  mountains.push({
    id: makeSlug(name, disambig),
    name,
    disambig: disambig || '',
    name_full: disambig ? `${name}(${disambig})` : name,
    elevation_m: elev,
    location: loc,
    province: provinceShort(loc),
    region: primaryRegion(loc),
    regions: regionsOf(loc),
    lists: { sanlim: false, bac: true, hansanha: false, wolgansan: false },
    lat: null, lon: null,
    summary: null, trails: [], transport: null, features: [], sources: [],
  });
});

/* ------------------------------------------------------------------ *
 * Merge 한국의산하(인기명산 100) + 월간산(100대 명산)                  *
 * 산림청/블랙야크 컬럼은 위 검증 데이터를 우선하고, 비교표에서         *
 * 한국의산하/월간산 멤버십만 취한다. 매칭 안 되는 행 = 신규 산.        *
 * ------------------------------------------------------------------ */
const PFULL = { 서울: '서울특별시', 인천: '인천광역시', 경기: '경기도', 강원: '강원특별자치도',
  대전: '대전광역시', 세종: '세종특별자치시', 충북: '충청북도', 충남: '충청남도',
  광주: '광주광역시', 전북: '전북특별자치도', 전남: '전라남도', 부산: '부산광역시',
  대구: '대구광역시', 울산: '울산광역시', 경북: '경상북도', 경남: '경상남도', 제주: '제주특별자치도' };
function regionOfProvince(p) {
  if (['서울', '인천', '경기'].includes(p)) return '수도권';
  if (p === '강원') return '강원';
  if (['대전', '세종', '충북', '충남'].includes(p)) return '충청';
  if (['광주', '전북', '전남'].includes(p)) return '전라';
  if (['부산', '대구', '울산', '경북', '경남'].includes(p)) return '경상';
  if (p === '제주') return '제주';
  return '기타';
}
// 신규 산의 해발/소재지/식별자 (좌표·정밀 해발은 이후 enrichment가 검증)
const NEW_INFO = {
  '불암산|서울': { elev: 508, loc: '서울특별시 노원구, 경기도 남양주시' },
  '고려산|인천': { elev: 436, loc: '인천광역시 강화군' },
  '남한산|경기': { elev: 522, loc: '경기도 광주시·성남시·하남시, 서울특별시 송파구' },
  '서리산|경기': { elev: 832, loc: '경기도 남양주시·가평군' },
  '광교산|경기': { elev: 582, loc: '경기도 수원시·용인시' },
  '수리산|경기': { elev: 475, loc: '경기도 안양시·군포시·안산시' },
  '검단산|경기': { elev: 657, loc: '경기도 하남시·광주시' },
  '마대산|강원': { elev: 1052, loc: '강원특별자치도 영월군, 충청북도 단양군' },
  '민둥산|강원': { elev: 1119, loc: '강원특별자치도 정선군' },
  '금대봉|강원': { elev: 1418, loc: '강원특별자치도 태백시·정선군' },
  '선자령|강원': { elev: 1157, loc: '강원특별자치도 평창군·강릉시' },
  '문암산|강원': { elev: 1146, loc: '강원특별자치도 인제군·홍천군' },
  '진악산|충남': { elev: 732, loc: '충청남도 금산군' },
  '만행산|전북': { elev: 910, loc: '전북특별자치도 남원시' },
  '신무산|전북': { elev: 897, loc: '전북특별자치도 장수군' },
  '백운산|전북': { elev: 1279, loc: '전북특별자치도 장수군·진안군', disambig: '장수' },
  '천상데미|전북': { elev: 1080, loc: '전북특별자치도 진안군·장수군' },
  '병풍산|전남': { elev: 822, loc: '전라남도 담양군·장성군' },
  '제암산|전남': { elev: 807, loc: '전라남도 보성군·장흥군' },
  '영취산|전남': { elev: 510, loc: '전라남도 여수시' },
  '토함산|경북': { elev: 745, loc: '경상북도 경주시' },
  '문수산|경북': { elev: 1207, loc: '경상북도 봉화군' },
  '일월산|경북': { elev: 1219, loc: '경상북도 영양군·봉화군' },
  '천주산|경남': { elev: 639, loc: '경상남도 창원시·함안군' },
  '천황산|경남': { elev: 1189, loc: '경상남도 밀양시, 울산광역시 울주군' },
  '남덕유산|경남': { elev: 1507, loc: '경상남도 함양군·거창군, 전북특별자치도 장수군' },
  '남산제일봉|경남': { elev: 1054, loc: '경상남도 합천군' },
  '계룡산|경남': { elev: 566, loc: '경상남도 거제시', disambig: '거제' },
};

const tableRows = readFileSync(join(ROOT, 'data', 'sources', 'four_lists.txt'), 'utf8')
  .split('\n').filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => {
    const [name, region, flags] = l.split('|').map((s) => s.trim());
    const [, , hansanha, wolgansan] = flags.split(/\s+/);
    return { name, region, hansanha: hansanha === 'O', wolgansan: wolgansan === 'O' };
  });

const byName = new Map();
for (const m of mountains) { (byName.get(m.name) || byName.set(m.name, []).get(m.name)).push(m); }
const matchedSet = new Set();
const newRows = [];
const listWarnings = [];
for (const row of tableRows) {
  const cands = (byName.get(row.name) || []).filter((c) => !matchedSet.has(c));
  const m = cands.find((c) => c.province === row.region)
    || cands.find((c) => c.location.includes(PFULL[row.region]));
  if (m) { m.lists.hansanha = row.hansanha; m.lists.wolgansan = row.wolgansan; matchedSet.add(m); }
  else newRows.push(row);
}
for (const row of newRows) {
  const key = `${row.name}|${row.region}`;
  const info = NEW_INFO[key];
  if (!info) { listWarnings.push(`신규 산 정보 없음: ${key}`); continue; }
  const loc = info.loc;
  mountains.push({
    id: makeSlug(row.name, info.disambig || ''),
    name: row.name, disambig: info.disambig || '',
    name_full: info.disambig ? `${row.name}(${info.disambig})` : row.name,
    elevation_m: info.elev, location: loc, province: provinceShort(loc),
    region: regionOfProvince(row.region), regions: regionsOf(loc),
    lists: { sanlim: false, bac: false, hansanha: row.hansanha, wolgansan: row.wolgansan },
    lat: null, lon: null, summary: null, trails: [], transport: null, features: [], sources: [],
  });
}
// 기존 산(산림청/블랙야크) 중 비교표에서 매칭 안 된 경우 = 두 새 리스트에 모두 없음(플래그 false 유지). 참고 로그.
const unmatchedBase = mountains.filter((m) => (m.lists.sanlim || m.lists.bac) && !matchedSet.has(m));

// sort: region order, then elevation desc
mountains.sort((a, b) => {
  const ra = REGION_ORDER.indexOf(a.region), rb = REGION_ORDER.indexOf(b.region);
  if (ra !== rb) return ra - rb;
  return b.elevation_m - a.elevation_m;
});

const nList = (k) => mountains.filter((m) => m.lists[k]).length;
const counts = {
  total: mountains.length,
  sanlim: nList('sanlim'),
  bac: nList('bac'),
  hansanha: nList('hansanha'),
  wolgansan: nList('wolgansan'),
  all_four: mountains.filter((m) => m.lists.sanlim && m.lists.bac && m.lists.hansanha && m.lists.wolgansan).length,
  by_region: REGION_ORDER.map((r) => [r, mountains.filter((m) => m.region === r).length]),
  by_list_membership: [1, 2, 3, 4].map((n) => [`${n}개 리스트`, mountains.filter((m) => [m.lists.sanlim, m.lists.bac, m.lists.hansanha, m.lists.wolgansan].filter(Boolean).length === n).length]),
};

const registry = {
  meta: {
    title: '대한민국 100대 명산 위키',
    description: '산림청·블랙야크(BAC)·한국의산하·월간산 100대 명산 통합 데이터셋',
    lists: {
      sanlim: { label: '산림청 100대 명산', short: '산림청', year: 2002, source: 'ko.wikipedia 대한민국 100대 명산 목록' },
      bac: { label: '블랙야크 명산100', short: 'BAC', org: 'BLACKYAK ALPINE CLUB', since: 2013 },
      hansanha: { label: '한국의산하 인기명산 100', short: '한국의산하', source: 'koreasanha 인기명산 100 (조회수 기반)' },
      wolgansan: { label: '월간산 100대 명산', short: '월간산', year: 2018, source: '월간山 창간 49주년 선정' },
    },
    region_order: REGION_ORDER,
    counts,
  },
  mountains,
};

// ---- 한국의산하 인기명산 순위 주입 (data/sources/hansanha_ranking.json) ----
// 출처: koreasanha.net "인기명산 100" 접속순위 (Wayback 아카이브). hansanha 소속 산에만 순위 기록.
try {
  const rankSrc = JSON.parse(readFileSync(join(ROOT, 'data', 'sources', 'hansanha_ranking.json'), 'utf8'));
  const id2rank = new Map(rankSrc.ranking.filter((e) => e.id).map((e) => [e.id, e.rank]));
  let ranked = 0;
  for (const m of mountains) {
    if (m.lists.hansanha && id2rank.has(m.id)) { m.hansanha_rank = id2rank.get(m.id); ranked++; }
  }
  console.log(`한국의산하 인기명산 순위 주입: ${ranked}개`);
} catch (e) {
  console.log('ℹ️ hansanha_ranking.json 없음 — 순위 미주입');
}

// ---- 월간산 선정기준 충족 개수 주입 (data/sources/wolgansan_criteria.json) ----
// 월간산 2018 '한국의 100대 명산'은 공식 순위가 없다. 대신 11개 세부 선정기준 표에서
// 각 산이 직접 등장한 세부기준 수를 재집계해 wolgansan_criteria(개수 + 부문 목록)로 기록.
try {
  const critSrc = JSON.parse(readFileSync(join(ROOT, 'data', 'sources', 'wolgansan_criteria.json'), 'utf8'));
  const wolIds = new Set(mountains.filter((m) => m.lists.wolgansan).map((m) => m.id));
  const byName = new Map();
  for (const m of mountains) { if (!byName.has(m.name)) byName.set(m.name, []); byName.get(m.name).push(m); }
  const GLABEL = { '오악': '오악', '조선 사고지': '사고지', '십승지': '십승지', '산신제': '산신제',
    '야생화': '야생화', '생태': '생태', '조망': '조망', '발원지': '발원지', '지형지질': '지형·지질',
    '많이 찾는 산': '대중성', '지정 자연공원': '자연공원' };
  const findId = (entry) => {
    const mo = entry.match(/^(.+?)\((.+?)\)$/);
    const nm = mo ? mo[1] : entry, hint = mo ? mo[2] : null;
    const cands = byName.get(nm) || [];
    if (cands.length === 1) return cands[0].id;
    if (hint) {
      const pm = cands.filter((c) => c.location.includes(hint) || (c.disambig || '').includes(hint));
      if (pm.length === 1) return pm[0].id;
    }
    const main = cands.filter((c) => !(c.disambig || '') && wolIds.has(c.id));
    if (main.length === 1) return main[0].id;
    const wf = cands.filter((c) => wolIds.has(c.id));
    if (wf.length === 1) return wf[0].id;
    return null;
  };
  const critOf = new Map();
  for (const c of critSrc.criteria) {
    const seen = new Set();
    for (const e of c.mountains) {
      const id = findId(e);
      if (id && wolIds.has(id) && !seen.has(id)) { seen.add(id); (critOf.get(id) || critOf.set(id, []).get(id)).push(GLABEL[c.key] || c.key); }
    }
  }
  let injected = 0;
  for (const m of mountains) {
    if (m.lists.wolgansan && critOf.has(m.id)) {
      const cs = critOf.get(m.id);
      m.wolgansan_criteria = { count: cs.length, groups: cs };
      injected++;
    }
  }
  console.log(`월간산 선정기준 충족 개수 주입: ${injected}개`);
} catch (e) {
  console.log('ℹ️ wolgansan_criteria.json 없음 — 기준 개수 미주입', e.message);
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'registry.json'), JSON.stringify(registry, null, 2) + '\n');

console.log('registry.json written');
console.log(counts);
console.log(`신규 산 추가: ${newRows.filter((r) => NEW_INFO[`${r.name}|${r.region}`]).length}개`);
if (listWarnings.length) console.log('⚠️ 경고:', listWarnings);
if (unmatchedBase.length) console.log(`ℹ️ 비교표 미매칭 기존 산 ${unmatchedBase.length}개(한국의산하·월간산 모두 미포함):`,
  unmatchedBase.map((m) => m.name_full).join(', '));
// slug sanity
const dup = mountains.map(m => m.id).filter((v, i, a) => a.indexOf(v) !== i);
if (dup.length) console.error('DUPLICATE SLUGS:', dup);
