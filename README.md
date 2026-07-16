# ⛰️ 대한민국 100대 명산 위키

**산림청 100대 명산**, **블랙야크 명산100**, **한국의산하 인기명산 100**, **월간산 100대 명산** — 네 개 기관·매체의 목록을 하나로 합쳐 지역별로 정리한 인터랙티브 지도·위키 웹앱입니다.

- 🗺️ **지도** — 149개 고유 명산을 지역(권역)별 색으로 표시. 목록·검색·필터와 연동.
- 🏷️ **분류** — 4개 목록 다중 선택(합집합)과 6개 권역(수도권·강원·충청·전라·경상·제주)으로 카테고라이즈. `★ 4대 공통` 토글 제공.
- 📄 **위키 문서** — 각 산별 개요·주요 등산로·교통·특징·출처 (OKF 스타일 마크다운으로도 생성).
- ⛰️ **코스별 난이도·등반시간** — 대표 등산로마다 난이도와 오름(편도)/왕복 시간을 정리. 웹 조사와 복수의 독립 자료를 **교차검증**한 값입니다.
- 🏅 **한국의산하 인기명산 순위** — 상세 페이지에 접속순위 기반 인기명산 순위(1~100위)를 함께 표시.
- 🧭 **월간산 선정기준** — 월간산은 공식 순위가 없어, 11개 세부 선정기준 중 해당 부문 수를 재집계해 표시.
- 🥾 **경로** — 상세 지도에서 OpenStreetMap 등산로 오버레이 + 실제 **GPX 파일 표시/업로드** + 고도 프로파일.
- 🏠 **홈 대시보드** — 지도 우선 대신, 통합 검색·개인 진행률·추천 산·빠른 탐색·계절 큐레이션으로 구성된 랜딩. 지도+목록 탐색은 별도 **지도(#/map)** 탭.
- 📍 **현재 위치** — 지도에서 내 위치를 표시하고 이동.
- ✅ **등정 기록** — 오른 산을 기록하고 목록별 진행률·지역별 통계 확인. 전용 **내 기록(#/track)** 페이지. 내보내기/가져오기 지원. **클라우드 로그인 설정 시 기기 간 동기화**(아래 참고), 미설정 시 브라우저 저장.

## 데이터 개요

| 구분 | 개수 |
| --- | --- |
| 전체 고유 명산 | 149 |
| 산림청 100대 명산 | 100 |
| 블랙야크 명산100 | 100 |
| 한국의산하 인기명산 100 | 100 |
| 월간산 100대 명산 | 100 |
| 네 목록 공통 | 58 |

- **목록 소속 판정**: 네 목록 비교표를 기준으로 병합. 목록별 각 100개, 4대 공통 58개로 정합성 확인. 근거: `data/sources/four_lists.txt`.
- **목록·소재지·해발**: 위키백과 「대한민국 100대 명산 목록」(산림청) 등 공개 자료 기준.
- **정상 좌표·등산로·교통·개요**: 산별 웹 조사로 수집하며 각 문서에 출처·좌표 신뢰도를 표기.
- **코스 난이도·시간**: 웹 조사 결과를 복수의 독립 자료와 교차검증해 합의값을 산출(`survey`·`crosscheck1`·`crosscheck2` 3원 대조). 상세 페이지에 `교차검증 일치`/`난이도 이견`/`단일 확인` 배지로 표기.
- **한국의산하 순위**: koreasanha.net 「인기명산 100」 접속순위 아카이브 기준. 근거: `data/sources/hansanha_ranking.json`.
- **월간산 선정기준**: 월간산 2018 「한국의 100대 명산」의 5대·11개 세부 선정기준 표에서 각 산의 해당 부문 수를 재집계(공식 순위·점수는 미발표). 근거: `data/sources/wolgansan_criteria.json`.

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
data/sources/*  ─► scripts/build-registry.mjs ─► data/registry.json
                                                     │  (149개, 슬러그·권역·4개 목록 플래그,
                                                     │   한국의산하 순위, 월간산 선정기준 개수 주입)
                                                     ▼
data/enrichment.verified.json ─► scripts/build-data.mjs ─► public/data/mountains.json  (프론트엔드)
                                                        └─► data/mountains/<id>.md       (OKF 위키 소스)
```

- `scripts/build-registry.mjs` — 4개 목록을 병합해 `data/registry.json` 생성. 한국의산하 순위(`hansanha_rank`)와 월간산 선정기준 개수(`wolgansan_criteria`)를 원자료에서 주입.
- `scripts/build-data.mjs` — 레지스트리와 검증된 조사 결과(`enrichment.verified.json`)를 합쳐 프론트 JSON + 위키 마크다운 생성(정상 좌표 범위 검증 포함).
- 원자료: `data/sources/four_lists.txt`(4개 목록 비교), `hansanha_ranking.json`(인기명산 순위), `wolgansan_criteria.json`(월간산 선정기준 표).

## GPX 추가

`public/gpx/<id>.gpx` 로 저장하면 해당 산 상세 페이지에 경로가 자동 표시됩니다. 자세한 내용은 `public/gpx/README.md`.

## 지도 제공자 전환 (OSM ↔ 카카오맵)

지도는 **제공자 전환식**입니다. `src/map.js`가 빌드 시 `VITE_KAKAO_KEY` 유무로 제공자를 고릅니다.

- 키 없음 → **OpenStreetMap(Leaflet)** (기본, 키 불필요)
- 키 있음 → **카카오맵**(일반지도/스카이뷰 전환, 전체화면 포함)

두 제공자는 동일한 `MapView` 인터페이스(`src/providers/leaflet.js`, `src/providers/kakao.js`)를 구현하므로 뷰 코드는 그대로입니다. 지도 로드 실패 시(잘못된 키·미등록 도메인 등) 목록·상세는 정상 표시되고 지도 영역만 오류 메시지로 대체됩니다.

**카카오맵으로 전환:**
```bash
cp .env.example .env         # VITE_KAKAO_KEY=<JavaScript 키> 입력
npm run build                # 키가 반영되려면 재빌드 필요
```
사전 준비: [Kakao Developers](https://developers.kakao.com)에서 **JavaScript 키** 발급 → **[카카오맵 > 사용 설정] ON** → **[플랫폼 > Web > 사이트 도메인]에 서빙 도메인 등록**. *미등록 도메인 요청은 거부됩니다.*

## 클라우드 로그인/기록 동기화 (선택)

기본은 등정 기록을 브라우저(localStorage)에 저장합니다. **정적 사이트**이므로 기기 간 동기화·사용자 계정은 외부 서비스가 필요하며, [Supabase](https://supabase.com)(무료 티어)를 **환경변수로 연결**하면 '내 기록' 페이지에 로그인(메일 링크·Google)이 나타나고 기록이 동기화됩니다. 값이 없으면 자동으로 브라우저 저장으로 동작합니다(코드 변경 불필요).

**설정 순서**

1. Supabase에서 프로젝트 생성 → **Settings > API**의 `Project URL`과 `anon public` 키 확인.
   - `anon` 키는 브라우저에 노출해도 안전합니다(접근은 아래 RLS로 보호). 서비스 롤 키는 절대 넣지 마세요.
2. **SQL Editor**에서 아래 스키마·정책 실행:

   ```sql
   create table if not exists public.hiked (
     user_id     uuid  not null references auth.users(id) on delete cascade,
     mountain_id text  not null,
     hiked_on    date,
     primary key (user_id, mountain_id)
   );
   alter table public.hiked enable row level security;
   create policy "own rows" on public.hiked
     for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
   ```
3. **Authentication > URL Configuration**에서 Site URL / Redirect URLs에 배포 주소 등록
   (예: `https://<사용자>.github.io/kr-100-mountains/`, 로컬 `http://localhost:5173`).
   Google 로그인을 쓰려면 **Authentication > Providers > Google**을 활성화(구글 OAuth 클라이언트 필요).
4. 값 주입:
   - 로컬: `.env`에 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` 입력 후 `npm run build`.
   - 배포: 저장소 **Secrets**에 동일 이름으로 추가(워크플로가 자동 주입).

동기화 동작: 로그인 시 클라우드↔로컬 기록을 병합(합집합)한 뒤, 이후 등정 토글·가져오기·삭제가 클라우드에 반영됩니다. 오프라인이거나 미로그인 시에는 로컬 저장으로 계속 동작합니다.

## 배포 (GitHub Pages)

`main` 브랜치에 push하면 GitHub Actions(`.github/workflows/deploy.yml`)가 자동으로 빌드·배포합니다. 카카오맵 키는 저장소 시크릿 `VITE_KAKAO_KEY`, 클라우드 로그인은 `VITE_SUPABASE_URL`·`VITE_SUPABASE_ANON_KEY` 시크릿으로 주입됩니다(없으면 각각 OSM·브라우저 저장으로 동작). 카카오맵·Supabase 모두 배포 도메인 등록이 필요합니다.

## 기술 스택

Vanilla JS + [Vite](https://vitejs.dev) · 지도: [Leaflet](https://leafletjs.com)+OpenStreetMap(기본) 또는 [카카오맵](https://apis.map.kakao.com)(키 설정 시) · localStorage · Overpass API(등산로).
기본 구성은 외부 유료 API·키 없이 동작합니다.

## 테스트

```bash
npm run build && npm test   # 헤드리스(playwright) 스모크 테스트 + 스크린샷(shots/)
```
※ 이 저장소는 **arm64** 환경에서 개발되어 playwright(arm64 chromium)를 사용합니다. 최초 1회 `sudo npx playwright install-deps chromium` 필요.
