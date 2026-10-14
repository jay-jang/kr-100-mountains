# 대한민국 100대 명산

**산림청 100대 명산**, **블랙야크 명산100**, **한국의산하 인기명산 100**, **월간산 100대 명산** — 네 목록을 하나로 합친 149개 명산을 지도에서 찾고, 코스와 주변 걷기길을 확인하고, 다녀온 산을 기록하는 웹앱입니다.

## 화면 구성

모바일에서 **지도가 첫 화면**입니다. 지도는 앱이 떠 있는 동안 하나만 유지하고, 목록·산·경로·걷기길은 지도 위 **바텀시트 하나**의 내용만 바꿉니다. 설계 과정과 근거는 `docs/redesign/`에 있습니다.

| 화면 | 주소 | 내용 |
| --- | --- | --- |
| 지도 + 목록 | `#/`, `#/map?…` | 상단 검색(명산·코스·걷기길 묶음 제안), 칩 `[명산│걷기길]` `[필터]` `[둘레길 있는 산]`, 오른쪽 `+ − 레이어 내 위치`. 시트는 접힘·낮음·중간·높음 단계(그래버 탭·화살표 키·드래그). 목록 헤더에 결과 수·등정 수·`가까운 순` |
| 산 | `#/m/<id>` | 탭 3개 — **코스**(등산로와 대표 코스를 한 행으로, 난이도·교차검증·선 상태 표시) · **주변 길**(정상·들머리 기준 5/10/15km 안의 둘레길·숲길·능선 종주 노선) · **정보**(교통·현장 정보·개요·목록 근거·출처) |
| 경로 | `#/m/<id>?route=…` | 코스 행이나 지도 위 선을 누르면 열리는 **단일 진입점**. 선은 생성 방식으로 구분(수록 경로 실선 / 계산 경로 점선 / 지도 선 없음 — 직선 참고선은 그리지 않음). 고도 단면·들머리 길찾기·GPX 받기 |
| 걷기길 | `#/walk/<rid>` | OpenStreetMap 노선 하나 — 길이(이 범위/전체)·순환/편도·가까운 명산·고도 단면(요청 시)·GPX·OSM 링크 |
| 내 기록 | `#/track` | 등정 수와 4개 목록 진행, 기록 추가·검색·날짜 수정·삭제 되돌리기, 백업·가져오기, (설정 시) 기기 간 동기화 |
| 설정 | `#/settings` | 테마, 기본 지도 종류, 기능 켜기·끄기(아래) |
| 대표 코스 모음 | `#/courses` | 149개 산의 대표·유명 코스 전체(20곳씩 더 보기). 설정에서 입구를 켤 수 있고, 링크로는 항상 열림 |

데스크톱(1024px 이상)에서는 같은 시트 내용이 왼쪽 400px 패널이 되고 지도는 오른쪽에 둡니다. 예전 주소(`#/map?region=…&list=…&q=…&hiked=1&sort=near&easy=1&hours=4&distance=5&focus=<id>`, `#/m/<id>?course=<id>`, `#/stats`)는 그대로 동작합니다.

### 표시 설정 (기능 켜기·끄기)

자주 쓰지 않거나 다른 기능과 겹치는 것은 설정에서 켭니다. 토글은 **입구만** 숨기며, 꺼도 저장된 기록·계획은 지우지 않습니다. 값은 `localStorage['kr100:prefs']`에 기본값과 다른 항목만 저장합니다(`src/prefs.js`).

| 묶음 | 항목 | 기본 |
| --- | --- | --- |
| 지도 | 걷기길 선 표시(확대 시) · 산 이름 표시 · 확대·축소 버튼 | 켬 |
| 지도 | 권역별 색 구분 | 끔 |
| 목록 | 최근 본 산(검색 제안) | 켬 |
| 목록 | 추천 묶음(인기·계절·쉬운 코스) · 대표 코스 모음 입구 | 끔 |
| 경로 도구 | 여러 경로 겹쳐 보기 · 내 GPX 파일 열기 · 경로 계획 만들기 · 경로 따라가기 · 등산로망 실시간 조회 | 끔 |

출처·교차검증·계산 경로 표시와 현장 통제 정보는 끌 수 없습니다.

### 주요 내용

- **분류** — 4개 목록 다중 선택(합집합), `4개 목록 모두`, 6개 권역, 등정/미등정, 코스 조건(쉬움·보통, 왕복 시간, 코스 거리), 둘레길·걷기길 있는 산.
- **코스별 난이도·등반시간** — 대표 등산로마다 난이도와 오름(편도)/왕복 시간을 정리. 웹 조사와 복수의 독립 자료를 **교차검증**한 값입니다. 난이도 색은 국립공원 탐방로 등급지도 관례를 따르고 늘 글자와 함께 씁니다.
- **주변 하이킹·트레킹** — 정상 등정 외에 산 주변의 둘레길·자락길·숲길·능선 종주(백두대간·정맥)·장거리 걷기길을 OpenStreetMap에서 모아 지도 레이어·산 시트·걷기길 모드로 보여 줍니다(`npm run trekking`).
- **한국의산하 인기명산 순위 · 월간산 선정기준** — 산 시트 정보 탭의 목록 근거에 표시(월간산은 공식 순위가 없어 선정기준 부문 수를 재집계).
- **현재 위치** — `내 위치`는 한 번 측정해 이동하고, 이어서 `계속 추적`을 누를 때만 실시간 추적합니다. 위치는 이 기기에만 저장됩니다.
- **등정 기록** — 브라우저 저장, 내보내기/가져오기, 클라우드 로그인 설정 시 기기 간 동기화.

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

### 주변 걷기길 수집 — `npm run trekking` · `npm run walks`

정상 등정 외에 산 주변의 둘레길·자락길·숲길·능선 종주(백두대간·정맥)·장거리 걷기길을 OpenStreetMap(© OpenStreetMap contributors, ODbL)에서 모읍니다. **실측 기록이 아니며 운영·통제 상태를 반영하지 않습니다** — 화면과 GPX에 그렇게 적습니다.

- `scripts/collect-trekking.mjs` — 산마다 Overpass 한 번: 정상과 정상 10km 안의 들머리를 기준으로 반경 15km 안의 도보 노선 관계(`route=hiking|foot`)와 이름 붙은 길(…둘레길·…자락길·…옛길·…숲길 등)을 모아 종류(`dulle` 둘레길·걷기길 / `forest` 숲길·산책로 / `ridge` 능선 종주 / `trail` 탐방로 / `other`)를 붙이고, 정상·들머리에서의 직선거리, 순환/편도, 장거리 여부를 계산해 `public/data/trekking/m/<산id>.json`과 `index.json`에 씁니다. 비법정탐방로·출입금지 길, 0.8km 미만 조각, 일반명사뿐인 이름은 뺍니다.
- `scripts/build-walks.mjs` — 산별 파일의 합집합이 아니라 남한의 도보 노선 관계 **전부**를 받아 전국 목록(`walks-index.json`), 1° 격자 거친 선(`tiles/`, 확대 시 지도 레이어), 노선별 상세(`w/<rid>.json`)를 만듭니다.
- Overpass 응답은 `.cache/trekking/`에 저장되어 중간에 끊겨도 이어서 돌고, 다시 돌리는 비용이 거의 없습니다. 공용 서버가 붐비면(504) 산당 1~5분 걸릴 수 있습니다.

### 여러 경로로 산행 계획 만들기

설정에서 **경로 계획 만들기**를 켜면 경로 시트에 **이 길로 계획**이 생깁니다. **경로 모두 불러오기**를 누르면 수록 GPX(코스·도보 경로)와 정상·등록 들머리 주변의 OSM 길을 함께 불러옵니다. 같은 파일은 한 번만 받고, 실패한 경로만 다시 시도할 수 있습니다. 주변 길 조회가 지연되거나 실패해도 먼저 불러온 GPX로 계획할 수 있습니다. OSM 조회는 정상에서 35km 이내에 있는 들머리·기존 경로 지점 주변으로 범위를 정합니다. 지도 제공자와 별개로 OSM 자료를 사용합니다.

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

`public/gpx/<id>.gpx`(실측·기증 기록)로 저장하면 그 산의 경로 시트가 계산 경로보다 먼저 이 선을 **수록 경로**로 씁니다. 자세한 내용은 `public/gpx/README.md`.

## 지도 제공자 전환 (OSM ↔ 카카오맵)

지도는 **제공자 전환식**입니다. `src/map.js`가 빌드 시 `VITE_KAKAO_KEY` 유무로 제공자를 고릅니다.

- 키 없음 → **OpenStreetMap(Leaflet)** (기본, 키 불필요)
- 키 있음 → **카카오맵**(일반·지형·위성 전환. 카카오에서는 지형이 기본)

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

브라우저 테스트는 빌드된 정적 파일을 작은 서버로 띄워 playwright(chromium)로 조작합니다. 지도 타일·Overpass·open-meteo 같은 외부 요청은 테스트 안에서 가짜 응답으로 바꾸고, 그 밖의 외부 요청은 막고 셉니다 — 네트워크 상태와 무관하게 같은 결과가 나옵니다(`scripts/lib/ui-harness.mjs`).

```bash
npm run build:data
VITE_KAKAO_KEY='' npx vite build --outDir /tmp/kr100-test     # 카카오 도메인 등록과 무관한 OSM 빌드
SMOKE_DIST=/tmp/kr100-test npm test              # 스모크: 첫 화면=지도, 검색 묶음, 산·경로 시트, 데이터 무결성, 설정 유지, 기록
SMOKE_DIST=/tmp/kr100-test npm run test:ux       # 320/390/768/1440 × 밝게/어둡게 배치, 44px 터치 대상, 시트 단계, 필터, 딥링크, 한글 IME
SMOKE_DIST=/tmp/kr100-test npm run test:courses  # 대표 코스 데이터·모음 페이지·경로 시트 연결
SMOKE_DIST=/tmp/kr100-test npm run test:planner  # 경로 계획(설정에서 켠 상태): 지점·순서·왕복·GPX·복원
npm run test:routing                             # 등산로 연결망·최단 경로·분리 구간
npm run test:trekking                            # 걷기길 분류·이어 붙이기·단순화
```

`TEST_ONLY=<단계 이름 일부>`로 일부 단계만 실행할 수 있습니다. ※ 이 저장소는 **arm64** 환경에서 개발되어 playwright(arm64 chromium)를 씁니다. 처음 한 번 `sudo npx playwright install-deps chromium`이 필요합니다.

## 산별 대표·유명 코스

산 시트의 **코스** 탭은 등산로와 대표 코스를 한 행으로 합쳐 보여 줍니다(`trail_index`로 연결된 277개는 같은 행, 연결 없는 27개는 따로). 149개 산의 304개 코스를 한 화면에서 비교하려면 **대표 코스 모음**(`#/courses`, 설정에서 입구를 켜거나 주소로 바로)을 씁니다. 산·코스·경유지 검색과 지역 필터는 URL에 저장되고 20곳씩 더 볼 수 있으며, 코스를 누르면 그 산의 경로 시트가 열립니다.

선정 원본은 `data/famous-courses.json`입니다. 정상 접근·능선 종주·경관 탐방을 기준으로 편집 선정한 목록이며 방문객 수에 따른 인기 순위가 아닙니다. 2026-10-03 확인한 공식 안내 69개에는 경유지와 개별 안내 출처·확인일을 붙였습니다. 나머지 235개는 기존 수록 코스에서 선정한 목록으로, 산 단위 참고자료를 보존하며 개별 코스의 인기도를 별도로 검증한 것으로 표시하지 않습니다. 통제·예약·운영 정보는 링크된 공식 안내에서 확인합니다.

`npm run build:data`는 전체 산의 누락·중복, 출처 범위, 기존 등산로 참조를 검사하고 공개 JSON 및 산별 위키에 반영합니다. 대표 코스에 새로운 GPS 경로를 추정해 붙이지 않으며, 정확히 연결된 기존 등산로만 추가 정보로 연결합니다. 한라산 백록담 코스와 영실·어리목의 윗세오름 코스도 분리합니다.

```bash
SMOKE_DIST=/tmp/kr100-ux-test npm run test:courses
UX_BASE_URL=http://localhost:5173 npm run test:courses
UX_BASE_URL=https://jay-jang.github.io/kr-100-mountains npm run test:courses
```

코스 검사는 149개 산의 수록 범위·출처와 동선의 주요 오류 사례, 검색·지역 조건·URL 복원, 상세 이동·기존 코스 연결, 모바일 탐색 및 밝은/어두운 테마를 확인합니다.
