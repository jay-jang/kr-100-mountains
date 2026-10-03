# ⛰️ 대한민국 100대 명산 위키

**산림청 100대 명산**, **블랙야크 명산100**, **한국의산하 인기명산 100**, **월간산 100대 명산** — 네 개 기관·매체의 목록을 하나로 합쳐 지역별로 정리한 인터랙티브 지도·위키 웹앱입니다.

- 🗺️ **지도** — 149개 고유 명산을 지역(권역)별 색으로 표시. 목록·검색·필터와 연동.
- 🏷️ **분류** — 4개 목록 다중 선택(합집합)과 6개 권역(수도권·강원·충청·전라·경상·제주)으로 카테고라이즈. `★ 4대 공통` 토글 제공.
- 📄 **위키 문서** — 각 산별 개요·주요 등산로·교통·특징·출처 (OKF 스타일 마크다운으로도 생성).
- ⛰️ **코스별 난이도·등반시간** — 대표 등산로마다 난이도와 오름(편도)/왕복 시간을 정리. 웹 조사와 복수의 독립 자료를 **교차검증**한 값입니다.
- 🏅 **한국의산하 인기명산 순위** — 상세 페이지에 접속순위 기반 인기명산 순위(1~100위)를 함께 표시.
- 🧭 **월간산 선정기준** — 월간산은 공식 순위가 없어, 11개 세부 선정기준 중 해당 부문 수를 재집계해 표시.
- 🥾 **경로** — 상세 지도에서 OpenStreetMap 등산로 오버레이 + 실제 **GPX 파일 표시/업로드** + 고도 프로파일.
- **산행 계획** — 수록 코스 GPX·도보 경로·주변 OSM 등산로를 함께 불러와 출발·경유·도착 지점을 연결. 여러 GPX 동시 업로드, 지점 순서 변경·왕복 계획, 브라우저 저장 및 계획 GPX 내려받기 지원.
- 🏠 **홈 대시보드** — 지도 우선 대신, 통합 검색·개인 진행률·추천 산·빠른 탐색·계절 큐레이션으로 구성된 랜딩. 지도+목록 탐색은 별도 **지도(#/map)** 탭.
- 📍 **현재 위치 · 내비게이션** — 지도에서 내 위치를 실시간 추적(위치 점 + 정확도 원). 상세 페이지에서 **외부 지도 길찾기**(카카오맵·구글, 목적지=정상)와, GPX 경로를 따라가는 **인앱 내비게이션**(정상까지 남은 거리·진행률·현재 고도·경로 이탈 경고) 제공.
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

### 경로 GPX 수집 — `npm run routes`

`scripts/collect-routes.mjs`가 등록된 들머리 → 정상 경로를 OpenStreetMap 등산로망 위에서 계산해
코스별 GPX로 굽습니다(`public/gpx/routes/`). **실측 GPS 기록이 아니며** 실측 GPX와 자리를 나눠
저장합니다. 코스별 내려받기·지도 표시 또는 산행 계획의 **경로 모두 불러오기**로 사용할 수 있습니다. 자세한 내용은 `public/gpx/README.md`.

### 여러 경로로 산행 계획 만들기

산 상세의 **새 등산 경로 계획 → 경로 모두 불러오기**를 누르면 수록 GPX(코스·도보 경로)와 정상·등록 들머리 주변의 OSM 길을 함께 불러옵니다. 같은 파일은 한 번만 받고, 실패한 경로만 다시 시도할 수 있습니다. 주변 길 조회가 지연되거나 실패해도 먼저 불러온 GPX로 계획할 수 있습니다. OSM 조회는 정상에서 35km 이내에 있는 들머리·기존 경로 지점 주변으로 범위를 정합니다. 지도 제공자와 별개로 OSM 자료를 사용합니다.

**지도에서 지점 추가**로 길 위에 출발·경유·도착을 차례로 누르거나 경로의 시작·끝 지점을 선택하세요. 표시 중인 경로의 연결망을 따라 지점 사이 최단 거리를 계산합니다. 지점 순서 변경·진행 방향 뒤집기·출발점으로 돌아오기, 고도와 구간 거리 확인, **계획 GPX 내려받기** 및 등산로 목록에 추가가 가능합니다. 지점은 산별로 현재 브라우저에 저장되며, 다시 열면 경로를 불러와 재계산합니다. 업로드한 개인 GPX 파일 자체는 저장하지 않으므로 다시 올려야 합니다.

교차점은 공통 좌표 또는 다른 길 위에 놓인 끝점(좌표 반올림 오차 1m 이내)으로 연결을 확인합니다. 연결이 없는 경로와 분리된 GPX 조각 사이에는 직선 연결을 만들지 않습니다. 지도 지점은 표시된 길에서 50m 이내일 때만 길 위로 맞춥니다. 계획은 실측 GPS 기록이 아니며, 현장 통제·출입 제한은 공식 안내에서 별도로 확인해야 합니다.

### 탐방 후기 수집 — `npm run reviews`

`scripts/collect-reviews.mjs`가 공개된 산행기·후기·공식 공지에서 확인되는 현장 정보(난이도 체감,
혼잡, 주차·교통, 위험구간, 시기, 편의시설, 통제·예약)를 모읍니다.

```
독립적인 두 조사가 각자 수집  ─►  후보 주장 목록
                                   │
        같은 목록을 두 조사에게 다시 돌려 웹 근거로 판정
                                   ▼
   반박 1표라도 있으면 제외 · 확인 2표 verified · 1표 single · 0표 제외
                                   ▼
     data/reviews.verified.json  +  public/data/reviews/<id>.json
```

- 항목마다 **출처 URL이 반드시 있어야** 저장됩니다. 원문 후기를 그대로 옮긴 것이 아니라
  확인된 사실을 한 줄로 정리한 요약입니다.
- 문장 유사도로 "두 조사가 같은 말을 했는지" 세지 않습니다 — 한국어 요약문은 같은 사실이어도
  0.11~0.22, 다른 사실이 0.08로 구분이 되지 않아, 대신 위와 같이 **검증 라운드**를 돌립니다.
- 매일 한 번 자동으로 조금씩 갱신할 수 있습니다 → `ops/systemd/README.md`

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
npm run test:routing        # 연결망·최단 경로·분리 구간·GPX 내보내기 검사
npm run test:planner        # 동시 로딩·재시도·지도 편집·복원·모바일 계획 UI 검사
```
※ 이 저장소는 **arm64** 환경에서 개발되어 playwright(arm64 chromium)를 사용합니다. 최초 1회 `sudo npx playwright install-deps chromium` 필요.

UX 회귀 검사는 `npm run test:ux`로 실행합니다. 테마·코스 필터, 뒤로 가기와 지도 위치 복원, 들머리 길찾기, 산행일 수정·삭제 복구, 모바일/데스크톱 및 밝은/어두운 테마를 확인합니다. 브라우저 기록은 격리된 테스트 컨텍스트에만 저장합니다.

홈·지도 검색은 산 이름을 우선 표시하고 지역·계절·코스 정보도 함께 검색합니다. 홈 검색 제안은 방향키로 선택하고 Enter로 열 수 있으며, Enter만 누르면 전체 검색 결과로 이동합니다. 지도 화면의 적용 조건은 필터를 접어도 표시되며 하나씩 해제할 수 있습니다. 상세 화면의 돌아가기 링크는 탐색 조건을 유지합니다.

지도는 목록·코스 안내와 독립적으로 로드합니다. 지도 로딩이 지연되거나 실패해도 검색·상세 안내·등정 기록을 사용할 수 있습니다. 내 기록에서는 산을 바로 검색해 추가하고 기존 기록을 검색·정렬할 수 있습니다. 백업 가져오기는 기존 기록과 병합하며, 날짜·파일 형식 오류가 있으면 전체 반영을 취소합니다. 목록에 없는 산은 제외하고 그 개수를 안내합니다. 이 흐름과 오류 복구도 UX 검사에 포함됩니다.

카카오 도메인 등록에 의존하지 않는 테스트용 빌드:

```bash
npm run build:data
VITE_KAKAO_KEY='' npx vite build --outDir /tmp/kr100-ux-test
SMOKE_DIST=/tmp/kr100-ux-test npm test
SMOKE_DIST=/tmp/kr100-ux-test npm run test:ux
SMOKE_DIST=/tmp/kr100-ux-test npm run test:planner
```

등록된 로컬 카카오 주소에서도 UX 검사를 실행할 수 있습니다. 먼저 `npm run dev`로 서버를 실행한 뒤 `UX_BASE_URL=http://localhost:5173 npm run test:ux`를 사용합니다. 기존 스모크 검사의 지도 타일·선 검증은 Leaflet 전용입니다.

코스 필터의 시간은 **왕복 시간**, 거리는 **자료에 기록된 코스 거리**입니다. 같은 코스가 모든 조건을 만족해야 하며, 값이 없는 코스는 해당 제한 조건을 통과하지 않습니다. 길찾기는 신뢰도가 높은 들머리 좌표로 연결하고, 그 외에는 장소 검색을 제공합니다. 별도로 확인되지 않은 주차장·정류장 좌표를 추정하지 않습니다. 산행일 저장·수정·삭제 복구는 기존 로컬 기록 형식과 클라우드 동기화 훅을 유지합니다.

## 산별 대표·유명 코스

상단·모바일 메뉴의 **대표 코스** (`#/courses`)에서 149개 산의 304개 코스를 산별로 비교할 수 있습니다. 산 이름·코스·주요 경유지 검색과 지역 필터는 URL에 저장됩니다. 코스 이름을 누르면 해당 산 상세의 코스가 강조되며, 돌아가기 링크로 검색 조건을 유지합니다. 산 상세에도 기존 주요 등산로와 별도로 대표 코스를 표시합니다.

선정 원본은 `data/famous-courses.json`입니다. 정상 접근·능선 종주·경관 탐방을 기준으로 편집 선정한 목록이며 방문객 수에 따른 인기 순위가 아닙니다. 2026-10-03 확인한 공식 안내 69개에는 경유지와 개별 안내 출처·확인일을 붙였습니다. 나머지 235개는 기존 수록 코스에서 선정한 목록으로, 산 단위 참고자료를 보존하며 개별 코스의 인기도를 별도로 검증한 것으로 표시하지 않습니다. 통제·예약·운영 정보는 링크된 공식 안내에서 확인합니다.

`npm run build:data`는 전체 산의 누락·중복, 출처 범위, 기존 등산로 참조를 검사하고 공개 JSON 및 산별 위키에 반영합니다. 대표 코스에 새로운 GPS 경로를 추정해 붙이지 않으며, 정확히 연결된 기존 등산로만 추가 정보로 연결합니다. 한라산 백록담 코스와 영실·어리목의 윗세오름 코스도 분리합니다.

```bash
SMOKE_DIST=/tmp/kr100-ux-test npm run test:courses
UX_BASE_URL=http://localhost:5173 npm run test:courses
UX_BASE_URL=https://jay-jang.github.io/kr-100-mountains npm run test:courses
```

코스 검사는 149개 산의 수록 범위·출처와 동선의 주요 오류 사례, 검색·지역 조건·URL 복원, 상세 이동·기존 코스 연결, 모바일 탐색 및 밝은/어두운 테마를 확인합니다.
