# ⛰️ 대한민국 100대 명산 위키

**산림청 100대 명산**과 **블랙야크(BAC) 명산100**을 하나로 합쳐, 지역별로 정리한 인터랙티브 지도·위키 웹앱입니다.

- 🗺️ **지도** — 121개 명산을 지역(권역)별 색으로 표시. 목록·검색·필터와 연동.
- 🏷️ **분류** — 산림청 / 블랙야크 / 공통 여부와 6개 권역(수도권·강원·충청·전라·경상·제주)으로 카테고라이즈.
- 📄 **위키 문서** — 각 산별 개요·주요 등산로·교통·특징·출처 (OKF 스타일 마크다운으로도 생성).
- 🥾 **경로** — 상세 지도에서 OpenStreetMap 등산로 오버레이 + 실제 **GPX 파일 표시/업로드** + 고도 프로파일.
- ✅ **등정 기록** — 오른 산을 브라우저에 저장하고 진행률(산림청 X/100, BAC Y/100)·지역별 통계 확인. 내보내기/가져오기 지원.

## 데이터 개요

| 구분 | 개수 |
| --- | --- |
| 전체 고유 명산 | 121 |
| 산림청 100대 명산 | 100 |
| 블랙야크 명산100 | 100 |
| 두 목록 공통 | 79 |
| 산림청 단독 | 21 |
| 블랙야크 단독 | 21 |

- **목록·소재지·해발**: 위키백과 「대한민국 100대 명산 목록」(산림청 2002 선정) 기준.
- **목록 소속 판정**: 산림청 vs 블랙야크 비교표를 교차 검증(2건은 별도 확인). 근거: `data/sources/bac_resolution.json`.
- **정상 좌표·등산로·교통·개요**: 산별 웹 조사로 수집하며 각 문서에 출처·좌표 신뢰도를 표기.

> ⚠️ 자동 정리된 참고 자료입니다. 실제 산행 전 국립공원·지자체의 최신 탐방로/통제 정보를 확인하세요.

## 실행

```bash
npm install
npm run build:data   # data/registry.json (+enrichment) → public/data/mountains.json, data/mountains/*.md
npm run dev          # 개발 서버 (http://localhost:5173)
npm run build        # 정적 빌드 → dist/
npm run preview      # 빌드 미리보기
```

## 데이터 파이프라인

```
data/registry.json ─┐
                    ├─ scripts/build-data.mjs ─► public/data/mountains.json  (프론트엔드)
data/enrichment.json┘                         └─► data/mountains/<id>.md     (LLM/OKF 위키 소스)
```

- `scripts/build-registry.mjs` — 두 목록을 병합해 `data/registry.json` 생성(121개, 슬러그·권역·목록 플래그).
- `scripts/enrich.workflow.mjs` — 산별 좌표·등산로·교통·개요를 웹 조사로 수집(구조화 JSON).
- `scripts/collect-enrichment.mjs` — 조사 결과를 `data/enrichment.json`으로 취합.
- `scripts/build-data.mjs` — 위 둘을 합쳐 프론트 JSON + 위키 마크다운 생성(좌표 범위 검증 포함).

## GPX 추가

`public/gpx/<id>.gpx` 로 저장하면 해당 산 상세 페이지에 경로가 자동 표시됩니다. 자세한 내용은 `public/gpx/README.md`.

## 지도 제공자 전환 (OSM ↔ 카카오맵)

지도는 **제공자 전환식**입니다. `src/map.js`가 빌드 시 `VITE_KAKAO_KEY` 유무로 제공자를 고릅니다.

- 키 없음 → **OpenStreetMap(Leaflet)** (기본, 키 불필요)
- 키 있음 → **카카오맵**(지형도 오버레이 포함)

두 제공자는 동일한 `MapView` 인터페이스(`src/providers/leaflet.js`, `src/providers/kakao.js`)를 구현하므로 뷰 코드는 그대로입니다. 지도 로드 실패 시(잘못된 키·미등록 도메인 등) 목록·상세는 정상 표시되고 지도 영역만 오류 메시지로 대체됩니다.

**카카오맵으로 전환:**
```bash
cp .env.example .env         # VITE_KAKAO_KEY=<JavaScript 키> 입력
npm run build                # 키가 반영되려면 재빌드 필요
```
사전 준비: [Kakao Developers](https://developers.kakao.com)에서 **JavaScript 키** 발급 → **[카카오맵 > 사용 설정] ON** → **[플랫폼 > Web > 사이트 도메인]에 서빙 도메인 등록**(예: `http://localhost:5173`, 터널은 `https://*.trycloudflare.com` 와일드카드). *미등록 도메인 요청은 거부됩니다.*

## 기술 스택

Vanilla JS + [Vite](https://vitejs.dev) · 지도: [Leaflet](https://leafletjs.com)+OpenStreetMap(기본) 또는 [카카오맵](https://apis.map.kakao.com)(키 설정 시) · localStorage · Overpass API(등산로).
기본 구성은 외부 유료 API·키 없이 동작합니다.

## 테스트

```bash
npm run build && npm test   # 헤드리스(playwright) 스모크 테스트 12종 + 스크린샷(shots/)
```
※ 이 저장소는 **arm64** 환경에서 개발되어 playwright(arm64 chromium)를 사용합니다. 최초 1회 `sudo npx playwright install-deps chromium` 필요.
