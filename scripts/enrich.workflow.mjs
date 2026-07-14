export const meta = {
  name: 'enrich-mountains',
  description: 'Research summit coords, trails, transport for Korea 100대 명산 (batched, web-grounded)',
  phases: [{ title: 'Research', detail: 'batched web research, ~4 mountains/agent' }],
};

// args may arrive as a parsed array OR a JSON string depending on the harness — handle both.
const MOUNTAINS = Array.isArray(args) ? args : JSON.parse(args); // [{id,name,elev,loc,prov,region}, ...] (121)
if (!Array.isArray(MOUNTAINS)) throw new Error('args did not resolve to an array of mountains');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '입력으로 주어진 id 그대로' },
          lat: { type: 'number', description: '정상(주봉) 위도 (십진수, 예 38.1197)' },
          lon: { type: 'number', description: '정상(주봉) 경도 (십진수, 예 128.4655)' },
          coord_source: { type: 'string', description: '좌표를 얻은 출처 (예: 한국어 위키백과 좌표, 국토지리정보원 등)' },
          coord_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          elevation_m: { type: 'number' },
          summary: { type: 'string', description: '한국어 2~4문장 소개. 위치·특징·볼거리 위주. 위키 톤.' },
          trails: {
            type: 'array',
            description: '대표 등산 코스 1~3개',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', description: '코스명 (예: 오색-대청봉 코스)' },
                start: { type: 'string', description: '들머리/기점 (예: 오색탐방지원센터)' },
                distance_km: { type: 'number' },
                duration: { type: 'string', description: '예: "왕복 7시간", "편도 3시간 30분"' },
                difficulty: { type: 'string', enum: ['쉬움', '보통', '어려움', '매우 어려움'] },
                note: { type: 'string', description: '코스 특징 한 줄 (선택)' },
              },
              required: ['name', 'difficulty'],
            },
          },
          transport: { type: 'string', description: '대중교통 접근 요약 (가까운 기차역/버스터미널/시내버스 등). 자가용 주차 정보 포함 가능.' },
          features: { type: 'array', items: { type: 'string' }, description: '특징 태그 (예: 국립공원, 단풍, 억새, 암릉, 일출, 케이블카)' },
          best_season: { type: 'string', description: '추천 시기 (예: "가을(10~11월) 단풍")' },
          sources: { type: 'array', items: { type: 'string' }, description: '참고 URL 1~3개' },
        },
        required: ['id', 'lat', 'lon', 'coord_confidence', 'summary'],
      },
    },
  },
  required: ['results'],
};

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const batches = chunk(MOUNTAINS, 4);
log(`enriching ${MOUNTAINS.length} mountains in ${batches.length} batches`);

const prompt = (batch, bi) => `너는 대한민국 산악/등산 데이터 수집 전문가다. 아래 산들에 대해 각각 정확한 정보를 수집해 구조화 데이터로 반환하라.

**반드시 웹 검색을 사용**해 사실을 확인하라. 특히 **정상 좌표(위도/경도)**는 한국어 위키백과 문서의 좌표(infobox), 또는 신뢰할 수 있는 등산 정보 사이트에서 확인해 십진수로 반환하라. 좌표를 확실히 확인했으면 coord_confidence="high", 추정이면 "low".

각 산마다:
- lat/lon: 정상(주봉) 십진수 좌표. 대한민국 범위(위도 33~39, 경도 124~132) 안이어야 한다.
- summary: 한국어 2~4문장. 위치·특징·볼거리.
- trails: 대표 등산코스 1~3개 (코스명, 들머리, 거리 km, 소요시간, 난이도).
- transport: 대중교통 접근(가까운 기차역/버스터미널/시내버스). 자가용 주차도 가능.
- features: 특징 태그 배열 (예: 국립공원, 단풍, 억새, 암릉, 일출).
- best_season, sources(URL).

반드시 입력의 **모든 산**에 대해 결과를 반환하고, id는 입력값을 그대로 사용하라.

산 목록(배치 ${bi + 1}):
${batch.map(m => `- id=${m.id} | 이름=${m.name} | 해발=${m.elev}m | 소재지=${m.loc}`).join('\n')}`;

const out = await parallel(
  batches.map((batch, bi) => () =>
    agent(prompt(batch, bi), {
      label: `research:b${bi + 1}(${batch[0].id})`,
      phase: 'Research',
      schema: SCHEMA,
      effort: 'medium',
    }).then(r => (r && Array.isArray(r.results) ? r.results : []))
  )
);

const flat = out.filter(Boolean).flat();
log(`collected ${flat.length}/${MOUNTAINS.length} enriched entries`);
return { results: flat };
