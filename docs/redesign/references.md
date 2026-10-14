# 지도 우선 모바일 UI 레퍼런스 검증 (100대 명산 앱 개편용)

- 조사일: 2026-10-13
- 확인 방법: 각 페이지를 실제로 열어 본문을 읽었다. JS로 그려지는 사이트(m3.material.io, developer.apple.com, krds.go.kr, 각 앱 도움말)는 헤드리스 Chromium(Playwright)으로 렌더링한 뒤 본문 텍스트를 추출했고, NN/g·W3C는 웹 fetch로 읽었다. 국립공원 등급지도는 원본 JPG를 내려받아 범례를 직접 보고 색을 픽셀 샘플링했다.
- 확인 여부 표기
  - **열어봄**: 본문을 직접 읽고 수치를 옮겨 적음
  - **열어봄(2차)**: 열어봤지만 공식 문서가 아닌 언론·블로그·제3자 포털
  - **검색결과만**: 검색 스니펫만 확인, 원문 미확인 → 근거로 약하게만 사용
  - **실패**: 403/404/차단으로 본문 확인 불가

---

## 적용 체크리스트 (테스트 가능한 규칙 24개)

| # | 규칙 | 확인 방법 | 근거 |
|---|---|---|---|
| 1 | 첫 화면(`#/`)은 지도가 뷰포트 전체를 차지하고, 목록은 **비모달** 하단 시트(scrim 없음)에 둔다. 시트가 peek·half 상태일 때 지도 팬/줌이 그대로 된다. | 시트 half 상태에서 지도 영역 드래그 → 지도 중심 좌표가 바뀌는지 | M3 standard sheet, NN/g nonmodal, Apple nonmodal sheet |
| 2 | 시트는 3단(peek / half / full). **peek ≥ 120px**: 상단 48px(핸들 + "산 23곳" 결과 수) + 첫 행 1개(≥ 72px)가 잘리지 않고 보인다. | 360×640 뷰포트에서 peek 높이·첫 행 bottom 측정 | M3 a11y(상단 48dp), Apple medium detent |
| 3 | half는 뷰포트 높이의 약 50%, full에서도 상단에 **지도 띠 ≥ 72px**를 남긴다(시트 top ≥ 72px). | 각 detent에서 `sheet.getBoundingClientRect().top` | M3 specs top margin 72dp, Google Maps "sliver of the map" |
| 4 | 시트 상단 48px 전체가 드래그·탭 영역이다. 핸들(32×4px)은 `role="button"`과 aria-label을 갖고, 탭/Enter/Space로 detent를 순환한다. | 키보드 Tab → 핸들 포커스 → Enter 3회로 peek→half→full→peek | M3 bottom sheet a11y, Apple grabber, WCAG 2.5.7 |
| 5 | 시트에는 보이는 **접기/닫기 버튼**이 있고, 브라우저·안드로이드 뒤로가기는 앱을 떠나지 않고 시트를 한 단계 내린다(상세→목록→peek). | `history.back()` 후 URL·시트 상태 확인 | NN/g bottom sheet, KRDS 바텀시트 |
| 6 | 시트 위에 시트를 쌓지 않는다. 산 상세는 같은 시트 안에서 "목록 → 상세 → 뒤로" 화면 전환으로 처리한다. | 상세 열린 상태에서 `.sheet` 요소 수 = 1 | NN/g, Apple HIG Sheets, KRDS |
| 7 | 목록에서 산을 고르면 지도가 그 산으로 이동하되 직전 지도 범위(extent)를 저장하고, 상세에서 뒤로 오면 그 범위로 복원한다. | 이동 전후 `map.getBounds()` 비교 | mapuipatterns List and details |
| 8 | 지도를 움직였을 때 목록을 즉시 바꾸지 않고 상단 중앙에 **"이 지역에서 다시 찾기"** 버튼을 띄운다. 누르면 버튼은 사라진다. 결과 0건이면 빈 상태 문구와 "전체 보기"를 준다. | 팬 → 버튼 표시, 클릭 → 숨김, 목록 갱신 | mapuipatterns Search this area / Extent-driven content |
| 9 | 지도 위 컨트롤(내 위치, 레이어)은 **우측 하단**, 화면 끝에서 16px, 시트 상단에서 16px 위에 두고 시트 높이에 따라 같이 움직인다. full 상태에서는 숨긴다. | detent별 컨트롤 bottom = sheet top − 16 | mapuipatterns Locate me(엄지 닿는 하단 모서리), KRDS 최소 스크린 마진 16px |
| 10 | 탭 가능한 모든 요소는 **44×44 CSS px 이상**(최소선 24×24, AA), 인접 대상 사이 간격 ≥ 8px. | 스모크 테스트에서 모든 `button, a, [role=button]`의 rect 검사 | WCAG 2.5.5/2.5.8, Apple 44pt, M3 48dp·8dp, KRDS 아이콘 버튼 44px |
| 11 | 드래그로만 되는 기능이 없다: 시트 높이는 핸들 탭으로, 지도 줌은 +/− 버튼으로, 슬라이더는 트랙 탭이나 숫자 입력으로도 바꿀 수 있다. | 포인터 클릭만으로 각 기능 수행 | WCAG 2.5.7(AA), M3 a11y |
| 12 | 하단 탭바는 3~5개, 아이콘 + 한글 레이블(1~2단어, 잘림 없음). 선택 상태는 **채운 아이콘 + 인디케이터**로 표시하고 색만으로 구분하지 않는다. 스크롤해도 숨기지 않는다. 높이 64px + `env(safe-area-inset-bottom)`. | 320px 폭에서 레이블 `scrollWidth ≤ clientWidth`, 활성 탭 aria-current | M3 nav bar(64dp), Apple tab bars, KRDS 탭바 |
| 13 | 비모달 목록 시트는 탭바 **위에서** 움직이고 탭바를 가리지 않는다. 탭바를 가리는 것은 모달(필터 전체 보기, 레이어 선택)과 키보드뿐이다. | peek/half/full 모두에서 탭바 hit-test 가능 | M3 nav bar placement, Apple tab bars |
| 14 | 레이어 버튼 → 모달 하프 시트: **배경지도**(단일 선택, 썸네일 라디오: 일반/위성/지형)와 **겹쳐보기**(다중 선택 스위치: 등산로, 걷기길·둘레길, 국립공원 경계 등)를 구역으로 나눈다. 겹쳐보기 각 행 왼쪽에 실제 선 색·선 모양 견본을 붙여 범례를 겸한다. | 레이어 시트 DOM에 radiogroup 1개 + switch n개, 각 행에 swatch | mapuipatterns Layer list/Basemap toggle, komoot, Gaia GPS, OS Maps |
| 15 | 스위치는 **즉시 적용**(저장 버튼 없음)하고, 레이블은 명사형("등산로 표시")으로 상태와 무관하게 고정한다. 바뀐 결과는 2~3초 토스트로 알리고 "되돌리기" 하나만 준다. | 스위치 클릭 → 지도 레이어 즉시 변화, 토스트 role=status | NN/g toggle switch, KRDS 토글·모바일 설정 |
| 16 | 설정 화면은 상위 카테고리 6~9개 이내, 자주 바꾸는 항목을 위로, 드문 항목은 한 단계 아래로 접는다(공개 단계는 최대 2). 위치 권한처럼 OS 권한이 걸린 항목은 앱 내 스위치와 OS 권한을 구분해 안내하고 시스템 설정으로 가는 버튼을 준다. | 설정 화면 최상위 항목 수, 깊이 ≤ 2 | KRDS 모바일 설정, NN/g progressive disclosure |
| 17 | 등산로 난이도 색은 국립공원 등급지도 관례를 따른다: 매우쉬움 `#d9b12d`, 쉬움 `#7ba12a`, 보통 `#cf4c20`, 어려움 `#8a0b34`, 매우어려움 `#231508`. 색만으로 구분하지 않도록 범례·카드에 글자(쉬움/보통…)를 같이 쓴다. | 범례 텍스트 존재, 색 대비 검사 | 국립공원공단 탐방로 등급지도(북한산) 범례 |
| 18 | 산/코스 카드 필드는 **이름 · 지역 · 거리 · 소요시간 · 난이도** 순서로, 단위를 붙여 쓴다("11.8km", "4시간 30분"). | 카드 텍스트 정규식 검사 | 두루누비 코스 카드, 국립공원 탐방로 통합검색 |
| 19 | 필터는 시트 헤더의 가로 스크롤 칩 + "필터" 버튼(전체 필터 시트)으로 구성한다. 전체 필터 시트의 적용 버튼에 결과 수("23곳 보기")를 보여 주고, 결과 수는 스크롤해도 항상 보인다. 걸린 필터는 테두리로 강조하고 "초기화"를 둔다. 조건은 AND로 결합한다고 적는다. | 필터 조작마다 버튼 숫자 갱신, 0건이면 문구 | AllTrails filters, NN/g mobile faceted search, 두루누비 |
| 20 | 필터 구간은 국내 공공 서비스 관례를 따른다: 거리(5km 미만 / 5~10km / 10km 초과), 소요시간(2시간 미만 / 2~4시간 / 4시간 초과), 난이도(쉬움/보통/어려움), 지역(시·도). | 필터 옵션 값 비교 | 두루누비 코스 검색 |
| 21 | 마커에 내 상태를 담는다: 완등한 산은 체크, 관심 산은 하트(또는 별). 겹치는 마커는 클러스터로 묶고, 클러스터는 한 가지 색 + 숫자이며 탭하면 그 범위로 확대한다. 선택된 마커는 윤곽선과 색 변화로 구분한다. | 완등 산 마커 class, 클러스터 클릭 후 zoom 증가 | AllTrails Explore pins, mapuipatterns Cluster marker, Apple HIG Maps |
| 22 | 지도 위에 떠 있는 컨트롤·칩·검색창은 **불투명 배경**(유리/블러 효과 없음) + 1px 테두리나 옅은 그림자로 지도와 구분하고, 아이콘 대비 ≥ 3:1, 글자 대비 ≥ 4.5:1을 지킨다. | 위성 배경지도 위에서 대비 측정 | NN/g Liquid Glass, Apple HIG Maps, M3 nav bar 3:1 |
| 23 | OSM 출처 표기는 지도 모서리에 두고, 시트 peek 상단보다 위에 오도록 같이 움직인다. 접을 경우 (i) 버튼으로 다시 볼 수 있어야 한다. 시트가 출처를 계속 가리지 않는다. | 각 detent에서 `.leaflet-control-attribution` 가시성 | OSMF Attribution Guidelines, Apple HIG Maps(카드 최저 위치 10pt 위) |
| 24 | 본문 16px 이상(Pretendard 계열이면 17px), 줄 간격 150% 이상, 굵기 400/700(+500)만. 13px 이하는 주석에만. 이모지를 기능 아이콘이나 상태 표시로 쓰지 않는다(SVG + aria-label, 상태는 글자로). 보라/인디고 그라데이션, 유리 효과, 장식용 3열 카드 그리드를 쓰지 않는다. | CSS 감사: 최소 font-size, 이모지 텍스트 노드, `backdrop-filter` 사용처 | KRDS 타이포그래피, NN/g icon usability, Pope Tech, NN/g Liquid Glass, Anthropic·prg.sh 글 |

### 현재 코드에서 바로 걸리는 곳 (2026-10-13 기준 grep 결과)

- 위치 버튼 상태를 이모지로 표시: `src/views/explore.js:193`(`🎯`), `:199`(`🚫`/`⚠️`), `src/views/detail.js:559`, `:565` → 규칙 24.
- 전체화면 버튼이 글리프 `⛶`/`✕`: `src/mapfullscreen.js:27`, `:41` → 이미 있는 `src/icons.js` SVG 세트로 교체 가능.
- 지도 위 컨트롤에 `backdrop-filter: blur(...)`: `src/style.css:84`, `:179`, `:205`, `:212`, `:224` → 규칙 22.
- 10~12px 글자: `src/style.css:90, 139, 140, 158, 159, 162, 187, 279` → 규칙 24. `.course-route-btn`(`style.css:279`, 12px·패딩 5px 10px)은 높이가 44px에 못 미칠 가능성이 높다 → 규칙 10.

---

## 1. 바텀시트

| 이름 | URL | 확인 여부 | 구체 가이드(수치 포함) | 이 앱에 적용할 점 |
|---|---|---|---|---|
| Material 3 Bottom sheets: Guidelines | https://m3.material.io/components/bottom-sheets/guidelines | 열어봄 | standard 시트는 메인 화면과 동시에 보고 조작할 수 있으며 "지도 위 위치 정보" 같은 보조 내용에 쓴다. full-screen부터 preview까지 미리 정한 높이들을 가진다. full 높이의 standard 시트에는 원래 위치로 돌아가는 접기 아이콘을 둔다. modal 시트는 처음 높이가 화면의 **50%를 넘지 않고**, scrim 탭·아래로 스와이프·닫기로 닫힌다. 드래그 핸들을 탭하면 높이를 순환하고, scrim 탭은 항상 닫는다. 큰 화면(expanded)에서는 side sheet로 바꿀 수 있다. | 탐색 목록은 standard(비모달), 필터·레이어는 modal(처음 ≤ 50%). 데스크톱 폭에서는 같은 내용을 왼쪽 패널로 보여 준다. |
| Material 3 Bottom sheets: Specs | https://m3.material.io/components/bottom-sheets/specs | 열어봄 | 폭은 최대 **640dp**까지 꽉 채운다. 창 폭이 640dp를 넘으면 위·좌우 여백 **56dp**. top margin **72dp**. 핸들 위아래 패딩 **22dp**. standard는 scrim 없음, modal만 scrim. 색: surface container low. | 시트 `max-width: 640px`, 넓은 화면에선 좌우 56px 여백. full 상태 top 72px. |
| M3 Compose 토큰(SheetBottomTokens, ShapeTokens) | https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/SheetBottomTokens.kt | 열어봄(원본 소스) | 핸들 **32×4dp**, 시트 위쪽 모서리 CornerExtraLargeTop = **28dp**. | 핸들 32×4px. 모서리는 KRDS 최대 12px과 충돌 → 12~16px 권장(아래 6장 참고). |
| Material 3 Bottom sheets: Accessibility | https://m3.material.io/components/bottom-sheets/accessibility | 열어봄 | 핸들이 있고 크기 조절이 되면 시트 **상단 48dp**가 상호작용 영역. 핸들은 탭 순서에 들어가고 role은 "button". Tab = 핸들 포커스, Space/Enter = 높이 순환. 드래그 동작에는 단일 포인터 대안 필수. 레이블은 핸들에만 단다. | 규칙 2·4·11. |
| Apple HIG: Sheets | https://developer.apple.com/design/human-interface-guidelines/sheets | 열어봄 | detent: large(완전 펼침), medium(약 절반). medium을 지원하면 점진적 공개에 유리. grabber는 드래그 표시이자 **탭하면 detent 순환**, VoiceOver로도 조작 가능. 스와이프로 닫기 지원(저장 안 한 변경이 있으면 확인). 한 번에 **시트 하나만**. iOS에서는 비모달 시트 가능. 단일 화면 시트에서 Cancel은 왼쪽, Done은 오른쪽(2026-03-24 개정). 복잡하거나 긴 작업에는 시트 대신 전체 화면. | 목록 시트는 비모달 + medium(half) 기본. 상세는 같은 시트 안 전환. |
| NN/g: Bottom Sheets: Definition and UX Guidelines (Page Laubheimer, 2023-06-11) | https://www.nngroup.com/articles/bottom-sheet/ | 열어봄 | modal vs nonmodal. 지도 위 목적지 상세 같은 경우는 nonmodal. 펼칠 수 있는 시트는 작을 때 nonmodal, 전체로 펼치면 modal처럼 동작. 권고: ① 뒤로가기로 닫힘 ② 보이는 닫기 버튼(핸들만 두지 말 것: 놓치기 쉽고 시스템 제스처와 충돌, 스크린리더·운동장애 사용자에게 어려움) ③ 시트 쌓기 금지 ④ 일시적 용도. 긴 내용·오래 볼 내용에는 쓰지 말 것. 바텀시트가 엄지 도달성을 높인다는 흔한 주장에 반대(화면 가운데가 가장 누르기 쉽다). | 규칙 5·6. 산 상세처럼 긴 내용은 full 상태에서 일반 페이지처럼 스크롤되게 하고, 뒤로가기를 history에 연결. |
| KRDS 바텀시트 (2025-01-15 등록) | https://www.krds.go.kr/html/site/component/component_12_03.html | 열어봄 | 구조: 오버레이, 헤더(선택), 핸들, 본문, 닫기 버튼. **닫기 버튼 포함 필수**(스와이프·탭 닫기를 모든 사용자가 알지 못함). 다중 바텀시트 금지(불가피하면 현재 단계 표시 + "이 시트만/전체 닫기" 구분). 짧은 상호작용에만. 항상 필요한 정보 표시에는 부적합. | KRDS의 바텀시트는 **모달** 정의다. 지도 탐색 목록은 M3 standard 시트로 보고, 필터·레이어·정렬 같은 모달에 KRDS 규칙을 그대로 적용한다. |

## 2. 하단 탭바 / 엄지 영역

| 이름 | URL | 확인 여부 | 구체 가이드(수치 포함) | 이 앱에 적용할 점 |
|---|---|---|---|---|
| Material 3 Navigation bar: Guidelines | https://m3.material.io/components/navigation-bar/guidelines | 열어봄 | 목적지 **3~5개**. 레이블 필수, **1~2단어**, 줄바꿈·말줄임·축소 금지. 활성은 채운 아이콘, 비활성은 외곽선(채운 버전이 없으면 굵기 증가). 아이콘과 컨테이너 대비 **3:1** 이상. FAB는 탭바 위 오른쪽. 탭바는 시트·키보드 등으로 **일시적으로만** 가릴 수 있다. 현재 탭 다시 누르면 맨 위로 스크롤. 좌우 스와이프로 탭 이동 금지. 상태 유지/초기화 중 선택. | 지도·기록 탭은 상태 유지(지도 위치·필터 기억), 지도 탭 재탭 시 시트를 peek로·현재 범위 유지. |
| Material 3 Navigation bar: Specs + Compose 토큰(NavigationBarTokens) | https://m3.material.io/components/navigation-bar/specs | 열어봄 | baseline 바는 비권장, flexible 바 권장. 토큰: ContainerHeight **64dp**(flexible), TallContainerHeight 80dp(baseline). 상태 레이어: hover 8%, focus·pressed 10%. 세로 아이템 폭은 컨테이너를 균등 분할. | 탭바 높이 64px + safe-area. |
| Apple HIG: Tab bars | https://developer.apple.com/design/human-interface-guidelines/tab-bars | 열어봄 | 탭바는 이동용, 동작(액션)용 아님. 모달이 덮을 때 외에는 항상 보이게. 탭을 비활성화하거나 숨기지 말고, 비어 있으면 이유를 설명. 레이블은 가능한 한 단어. 채운 아이콘 선호. 배지는 중요한 정보에만. "More" 넘침 탭 피하기. 사용자 지정 탭은 기본 5개 이하. | 비로그인 상태에서도 "기록" 탭을 숨기지 말고 빈 상태 설명을 보여 준다. |
| KRDS 탭바 (2025-01-15 등록) | https://www.krds.go.kr/html/site/component/component_12_07.html | 열어봄 | 모든 탭 같은 폭·높이. 선택 = 채운(글리프) 아이콘 + 인디케이터, 비선택 = 선 아이콘. **5개 이내**. 아이콘 + 레이블 함께, 레이블 1~2단어·잘림 금지. 홈은 맨 왼쪽, 전체 메뉴는 맨 오른쪽. **하단 고정, 스크롤 시 숨기지 않음**(하위 화면 진입 시 미제공은 허용). 특정 탭만 크게 강조하는 것은 지양. 접근성: 탭바 역할과 활성 메뉴를 스크린리더에 전달. | 탭 구성 예: 지도(맨 왼쪽, 사실상 홈) · 기록 · 설정. `aria-current="page"`. |
| NN/g: Basic Patterns for Mobile Navigation (Raluca Budiu, 2015-11-15) | https://www.nngroup.com/articles/mobile-navigation-patterns/ | 열어봄 | 탭바는 스크롤해도 남는다. 5개를 넘으면 터치 크기를 지키며 넣기 어렵다. 햄버거 메뉴는 발견성이 가장 낮다. 내비게이션만이 아니라 화면 위 크롬 전체 면적을 따져야 한다. | 지도 화면 크롬(검색창 + 칩 + 탭바 + 시트 peek)의 총 높이를 측정해 지도 가시 영역 ≥ 50% 유지. |
| NN/g: How to Make Navigation (Even a Hamburger) Discoverable on Mobile (Pernice·Budiu, 2016-07-24) | https://www.nngroup.com/articles/find-navigation-mobile-even-hamburger/ | 열어봄 | 노출+숨김 조합 내비 사용률 **89%**(첫 사용 24초) vs 숨김 메뉴 **44~56%**(33초). 보이는 내비는 상위 4~5개일 때 가장 잘 작동. | 주요 기능을 햄버거에 넣지 않는다. 설정만 탭으로 두고, 레이어는 지도 위 버튼으로 노출. |
| Steven Hoober: How Do Users Really Hold Mobile Devices? (UXmatters, 2013-02-18) | https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php | 열어봄 | 관찰 1,333건(화면 터치 중 780명). 한 손 **49%**, 받쳐 들기 36%, 양손 15%. 한 손 중 오른쪽 엄지 67%. 왼쪽 위 구석에 위험하거나 덜 중요한 기능 두지 말 것. 왼손 사용자 20~30% 무시하지 말 것. 저자가 2017년 댓글에서 이 글의 터치 위치 그림은 틀렸고 "화면 가운데를 더 자주, 빠르고, 정확하게 누른다"고 정정. | 위치·레이어 버튼은 우하단이지만, 왼손 사용자를 위해 시트 안에도 같은 동작(예: "내 위치 기준 정렬")을 둔다. |
| Steven Hoober: Design for Fingers, Touch, and People, Part 3 (UXmatters, 2017-07-10) | https://www.uxmatters.com/mt/archives/2017/07/design-for-fingers-touch-and-people-part-3.php | 열어봄 | 터치 정확도: 화면 가운데 **7mm** → 모서리 **12mm**. 좌우 가장자리 행은 높이 9~10mm 이상. 핵심 동작은 화면 가운데 1/2~2/3 영역에, 보조 동작·내비는 위/아래 가장자리에 소수만(iOS 4개, 큰 폰 5개). 되돌릴 수 없는 동작은 자주 쓰는 컨트롤과 떨어뜨린다. 배율 변동을 고려해 모든 것을 약 20% 크게. 인용 연구: 10mm 버튼 정확도 98~99.4%, 8mm 미만 오류율 40% 초과. | 목록 행 전체를 탭 영역으로(행 높이 ≥ 64px). "기록 삭제"는 시트 맨 아래, 자주 쓰는 버튼과 분리. |

## 3. 터치 타깃 크기

| 이름 | URL | 확인 여부 | 구체 가이드(수치 포함) | 이 앱에 적용할 점 |
|---|---|---|---|---|
| WCAG 2.2 SC 2.5.8 Target Size (Minimum), AA | https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html | 열어봄 | 포인터 대상 **24×24 CSS px** 이상. 예외: 간격(대상 중심 기준 지름 24px 원이 다른 대상이나 다른 작은 대상의 원과 겹치지 않음), 문장 안 링크, UA 기본 컨트롤, 필수 표현, 같은 기능의 다른 컨트롤 존재. 중요한 컨트롤은 2.5.5 수준 권장. | 법적·접근성 하한선. 지도 팝업 안 작은 링크도 24px 이상. |
| WCAG 2.2 SC 2.5.5 Target Size (Enhanced), AAA | https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html | 열어봄 | **44×44 CSS px**. 예외: 동등 컨트롤, 인라인, UA 컨트롤, 필수. | 앱 목표치로 채택(규칙 10). |
| WCAG 2.2 SC 2.5.7 Dragging Movements, AA | https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html | 열어봄 | 드래그로 하는 모든 기능은 드래그 없이 단일 포인터로도 가능해야 함(필수이거나 UA 기능이면 예외). 예: 지도 드래그 + 상하좌우 버튼, 슬라이더는 트랙 탭 또는 숫자 입력. | 시트 핸들 탭 순환, 줌 +/− 버튼, 고도 그래프 슬라이더에 탭 이동(규칙 11). |
| Apple HIG: Accessibility | https://developer.apple.com/design/human-interface-guidelines/accessibility | 열어봄 | iOS 기본 컨트롤 **44×44pt**, 최소 28×28pt. 테두리 있는 요소 주변 약 **12pt**, 테두리 없는 요소는 약 **24pt** 여백. 대비: 17pt 이하 4.5:1, 18pt 이상 3:1. 자주 쓰는 동작은 가장 단순한 제스처로. | 테두리 없는 아이콘 버튼은 보이는 크기보다 넉넉한 hit 영역을 준다. |
| Material Design: Structure > Target sizes | https://m3.material.io/foundations/designing/structure | 열어봄 | 터치 대상 **48×48dp**(약 9mm, 권장 7~10mm). 아이콘 24dp여도 패딩 포함 48dp. 포인터 대상 44dp. 대상 간 간격 **8dp**. iOS는 44 권장이라고 명시. | 44px를 하한, 48px를 지도 컨트롤 기본값으로. |
| NN/g: Touch Targets on Touchscreens (Aurora Harley, 2019-05-05) | https://www.nngroup.com/articles/touch-target-size/ | 열어봄 | 최소 **1cm × 1cm**. 손가락 끝 1.6~2cm, 엄지 접촉면 약 2.5cm. 걸으며 쓰거나 고령자·주요 CTA는 더 크게(약 2cm). 간격은 작은 타깃을 보완하지 못함(흔한 권장 간격 약 2mm). | 산행 중(걸으며, 장갑) 쓰는 "경로 따라가기" 화면 버튼은 56px 이상. |
| KRDS 디지털 포용(접근성 표) | https://www.krds.go.kr/html/site/utility/utility_04.html | 열어봄 | KWCAG 2.2·WCAG 2.1 기준. 버튼·링크를 적절한 크기로, **아이콘 버튼 44px × 44px 이상** 고려. 토글 스위치 경로·핸들·상태 아이콘과 배경 대비 **3:1**. | 국내 공공 기준과도 44px로 일치. |

## 4. 지도 UI 패턴

| 이름 | URL | 확인 여부 | 구체 가이드(수치 포함) | 이 앱에 적용할 점 |
|---|---|---|---|---|
| Map UI Patterns: Layer list (Michael Gaigg) | https://www.mapuipatterns.com/layer-list/ | 열어봄 | 레이어별 체크박스/눈 아이콘. 레이어 이름 옆 심볼이 범례 역할. 그룹은 전체/없음/일부(중간 상태) 3상태. 계층 **2단계 이하**. 레이어 수를 줄이고, 기능용 레이어(그리기·필터)는 목록에서 빼거나 고정. | 규칙 14. "선택한 등산로" 같은 기능 레이어는 레이어 목록에 넣지 않는다. |
| Map UI Patterns: Legend | https://www.mapuipatterns.com/legend/ | 열어봄 | 현재 켜진 데이터의 범례만. 지도 위 플로팅 컨테이너, 지도 내비 옆 모서리. "범례" 제목은 대개 불필요. 수량은 단위 표시. | 별도 범례 패널 대신 레이어 시트 행 견본 + 난이도 색은 상세 고도 그래프 아래 한 줄. |
| Map UI Patterns: Basemap toggle | https://www.mapuipatterns.com/basemap-toggle/ | 열어봄 | 기본과 확연히 다른 대안(예: 회색 → 위성). 모서리 또는 서랍에. 대안 지도의 썸네일 표시. 썸네일 범위를 지도와 계속 동기화하면 산만함. | 배경지도 선택지는 정적 썸네일 3개. |
| Map UI Patterns: Search this area | https://www.mapuipatterns.com/search-this-area/ | 열어봄 | 범위가 바뀌면 "이 지역 검색" 버튼을 지도 **위 또는 아래 중앙**에 표시, 누르면 숨김. 대역폭이 괜찮으면 "지도 움직이면 갱신" 체크박스 옵션. 너무 축소하면 버튼 비활성화 같은 안전장치. | 규칙 8. 전국 단위로 축소되면 "전국 149곳" 기본 목록으로. |
| Map UI Patterns: Extent-driven content | https://www.mapuipatterns.com/extent-driven-content/ | 열어봄 | 지도 범위를 목록 필터로 쓸 때: 너무 확대 → 0건 빈 상태, 너무 축소 → 클러스터나 중심 반경 제한, 위치에서 멀어짐 → 내 위치 버튼, 관심 영역 밖 → 알림 + 홈 버튼. 동기화는 기대와 다를 수 있으니 opt-in/out 제공. | 한반도 밖으로 나가면 "대한민국 전체 보기" 버튼. |
| Map UI Patterns: Locate me | https://www.mapuipatterns.com/locate-me/ | 열어봄 | 과녁 모양 아이콘, 지도 모서리(모바일은 엄지가 닿는 **아래쪽**). 누르면 파란 점 + 충분한 맥락이 보이는 축척으로. 중심일 때 아이콘 변경(점 있음/없음). 위치를 왜 묻는지 설명. | 기존 위치 모듈 유지, 버튼 상태는 아이콘 변화 + aria-label로(이모지 대신). |
| Map UI Patterns: List and details | https://www.mapuipatterns.com/list-details/ | 열어봄 | 목록과 상세는 같은 패널 안에서 전환, 상세에는 뒤로 버튼. 이전/다음 이동 제공 가능. 항목 선택 시 현재 범위를 기억하고 선택 항목으로 이동, 목록으로 돌아오면 **이전 범위 복원**. 목록은 단순하게(구분선·줄무늬·그림자 제거). | 규칙 6·7. |
| Map UI Patterns: Cluster marker | https://www.mapuipatterns.com/cluster-marker/ | 열어봄 | 클러스터는 숫자가 든 원, 크기는 개수에 비례 가능, **모든 클러스터 같은 색**(개별 마커 색이 달라도). 클릭하면 클러스터 범위로 확대. 최대 확대에서도 겹치면 spider. 행정구역 경계로 묶지 말 것. | 규칙 21. 149곳이면 전국 축척에서 클러스터 필요. |
| Map UI Patterns: Info panel | https://www.mapuipatterns.com/info-panel/ | 열어봄 | 긴 내용은 팝업 대신 패널. 모바일에서는 전체 화면 모달처럼. 닫거나 접을 수 있게. 패널이 비었을 때의 내용(안내나 추천 목록) 설계, 없으면 기본은 닫힘. | 지도 마커 팝업은 이름·고도·완등 여부 정도만, 나머지는 시트 상세로. |
| Map UI Patterns: Zoom control / Kitchen sink | https://www.mapuipatterns.com/zoom-control/ , https://www.mapuipatterns.com/kitchen-sink | 열어봄 | 줌은 +/−, 모서리 아무 곳이나(레이아웃 균형). 모바일에서 생략은 가능하지만 권장하지 않음. Kitchen sink: 기능을 다 넣으면 Hick의 법칙대로 결정 시간이 늘어나고 혼란 → 데모용이 아니면 피하고 점진적 공개. | 지도 화면 버튼은 위치·레이어·줌 3종으로 제한. 전체화면·길찾기 등은 상세 시트로. |
| Apple HIG: Maps | https://developer.apple.com/design/human-interface-guidelines/maps | 열어봄 | 정보가 많은 오버레이에는 채도 낮춘 **muted** 지도 스타일. 검색 + 카테고리 필터. 선택한 요소는 윤곽선·색 변화로 구분. 겹치는 POI는 클러스터. 로고·법적 링크 주변 좌우 **7pt**, 위아래 **10pt** 여백, 아래에서 올라오는 카드가 있으면 카드의 **가장 낮은 정지 위치보다 10pt 위**. 커스텀 컨트롤은 얇은 테두리나 옅은 그림자로 지도와 대비. 장소 카드를 띄울 때 선택 위치가 보이도록 오프셋. | 기본 타일을 채도 낮춘 스타일로 쓰고, 등산로·난이도 색을 위에 올린다. 출처 표기 위치 = peek 상단 + 10px(규칙 23). |
| Google Maps 시트 개편(9to5Google, Abner Li) | https://9to5google.com/2024/07/31/google-maps-bottom-bar-redesign-rolling-out/ , https://9to5google.com/2025/01/21/google-maps-redesign-sheets/ | 열어봄(2차, 언론 보도) | 2024-07: 하단 탭 5개 → **3개**(탐색·나·기여). 2025-01: 탭을 누르면 시트가 펼쳐져도 위쪽에 **지도 띠가 남음**, 최소화하면 상단 검색창이 보임, 탐색 탭 시트는 완전히 숨길 수 없음. 공식 디자인 문서는 찾지 못함. | 탭 3개 구성의 근거. full 상태에서 지도 띠 유지(규칙 3). |
| OSMF Licence/Attribution Guidelines | https://osmfoundation.org/wiki/Licence/Attribution_Guidelines | 열어봄 | 지도 모서리(관례상 오른쪽 아래, 어느 모서리든 가능). "© OpenStreetMap" 또는 "© OpenStreetMap contributors" + 저작권 페이지 링크. 닫기 동작·지도 조작·**5초 후** 접기 허용, 접은 뒤에도 (i) 버튼이나 메뉴로 찾을 수 있어야 함. WCAG 수준 가독성. | 규칙 23. |
| NN/g: Mobile Faceted Search with a Tray (Kathryn Whitenton, 2015-07-26) | https://www.nngroup.com/articles/mobile-faceted-search/ | 열어봄 | 필터를 별도 페이지가 아닌 결과 위 패널로. 결과는 뒤에 보이게 두고 선택마다 즉시 갱신. **결과 수는 항상 보이게**(헤더 고정). 트리거는 아이콘보다 "필터" 같은 글자. | 규칙 19. 필터 시트가 열려도 뒤 지도·목록 수가 갱신되게. |
| Mapbox: Map design and styles | https://docs.mapbox.com/help/getting-started/map-design/ | 열어봄 | 스타일 정의(소스·레이어·글리프·스프라이트) 위주이고 화면 레이아웃·컨트롤 배치 지침은 없음. 별도로 GL JS 출처 컨트롤이 640px 미만에서 접힌다는 내용은 검색결과로만 확인. | Leaflet 사용 앱이라 직접 해당 사항 적음. 참고 없음으로 처리. |

## 5. 아웃도어 앱 (해외 · 국내)

| 이름 | URL | 확인 여부 | 구체 가이드(수치 포함) | 이 앱에 적용할 점 |
|---|---|---|---|---|
| AllTrails: How to use filters to find trails | https://support.alltrails.com/hc/en-us/articles/37227964040852-How-to-use-filters-to-find-trails | 열어봄(웹 fetch는 403, 헤드리스 렌더링으로 확인) | 앱: Explore 탭 → 검색창 바로 아래 필터 드롭다운, 각 필터 하단 흰색 **"Show xx trails"** 버튼으로 확정. 왼쪽 위 "All"은 모든 필터를 한 서랍에서. 필터는 **AND** 결합. 웹: 사용 중 필터는 초록 테두리. 정렬: 인기·가까운 순·계절·신규. 난이도 Easy/Moderate/Hard/Strenuous, 길이 0~50+mi, 고도 상승 0~5,000+ft, 최고점 0~15,000+ft. | 규칙 19. 칩 하나씩 바로 여는 방식 + 전체 필터 시트 병행. |
| AllTrails: How to use map view to search for trails | https://support.alltrails.com/hc/en-us/articles/360034969432-How-to-use-map-view-to-search-for-trails | 열어봄 | 화면 아래 지도 아이콘으로 지도 보기 전환. 핀을 누르면 **화면 아래 트레일 카드**, 지도에 경로 선 표시. 카드를 누르면 상세. | 마커 탭 → 시트 peek에 그 산 카드 1장 → 카드 탭 → 상세. |
| AllTrails: Updated Explore Pins | https://support.alltrails.com/hc/en-us/articles/46153616589204-Updated-Explore-Pins | 열어봄 | 핀에 상태 표시: **하트 = 저장한 목록, 체크 = 완료**. 지도 보기에서 트레일 → 카드의 하트로 저장. | 규칙 21. 완등 산 마커 체크. |
| AllTrails 웹 Explore 지도 | https://www.alltrails.com/explore | 실패(403) | — | 화면 구성은 도움말로만 확인. |
| komoot: Map Layers | https://support.komoot.com/hc/articles/10194649347098 | 열어봄(웹 fetch는 403, 렌더링으로 확인) | 지도 보기에서 Layers 아이콘. 조합 규칙: 배경 스타일 **1개**(Default/Satellite/OpenStreetMap/OpenCycleMap) + 종목별 지도 **1개**(Hiking/Cycling/MTB/None, 프리미엄) + 히트맵(선택). | 배경(단일) + 겹침(다중) 구조의 직접 근거. |
| komoot: 지도 범례(한국어) | https://www.komoot.com/help/map | 열어봄 | 트랙: **실선 = 단단한 노면, 점선 = 흙·자갈처럼 무른 노면**. 등산로(SAC 2~3)와 고산 트레일(SAC 4~6) 구분. 하이킹 지도: 장거리·지역 하이킹 경로, 번호 표지판, 난이도. | 선 색은 난이도, 선 모양(실선/점선)은 데이터 출처(실측 GPX vs OSM 추정 경로)로 나눠 쓸 수 있다. |
| komoot: Plan routes on the website | https://support.komoot.com/hc/articles/10194270667034 | 열어봄 | 레이어와 별개로 "Map content" 토글(트레일 뷰 사진, 저장한 장소, 거리 표시, 하이라이트, POI). 경로선 잠시 숨기기. 화면 아래 고도 프로필에서 노면·길 유형·날씨로 보기 전환. | "표시할 것"(사진 마커, 들머리, 대피소)은 레이어 시트 아래 구역으로. 고도 그래프는 상세 시트 하단. |
| Gaia GPS: Maps 101: Basemap vs. overlay | https://help.gaiagps.com/hc/en-us/articles/4405007039511-Maps-101-Basemap-vs-overlay | 열어봄 | basemap은 단독용, overlay는 투명 배경에 데이터(길·경계). 활성 basemap 최대 **5개**, overlay 무제한. 투명도 0이어도 활성으로 계산 → 비활성 목록으로 옮기라고 안내. | 배경지도는 동시에 1개만 허용(단순화). |
| Gaia GPS: Add, Layer, and Change Map Sources in the iOS app | https://help.gaiagps.com/hc/en-us/articles/115003640128-Add-Layer-and-Change-Map-Sources-in-the-iOS-app | 열어봄 | 왼쪽 아래 Map Menu. **Adventure Modes**(Hike/Off-Road/Snow) 프리셋: 배경 Topo/고해상 위성/최근 위성 중 선택, 트레일 데이터 켜고 끄기, 오버레이 켜기, Reset으로 기본값 복귀. Custom 모드: 스위치로 활성/비활성, 슬라이더로 투명도, 길게 눌러 순서 변경, 목록 위 = 지도 위. | 레이어 시트 맨 위에 "등산 기본"·"걷기길" 같은 프리셋 2~3개 + "기본값으로" 버튼. 세부 스위치는 그 아래. |
| Mapy.com: Map Types | https://napoveda.seznam.cz/en/outdoor-map-type-hiking-trails-and-cycle-routes | 열어봄 | 기본 지도 5종. 아웃도어 지도: 등고선 간격 **5m(체코)/10m(해외)**, 음영기복, 표식 색 그대로 **빨강·파랑·초록·노랑** 등산로. 앱에서 범례는 **왼쪽 아래 지도 종류 버튼 밑**, 웹은 오른쪽 사이드바 하단 링크. 기본 배경지도를 설정에서 고정 가능. | "기본 배경지도" 설정 항목. 범례는 레이어 버튼 안에서 찾게. |
| Mapy.com: Additional Layers | https://help.mapy.com/map/layers/ | 열어봄 | 추가 레이어 7종(지적, 사진, 웹캠, **경사도 30°/38°/45°+**, 등산로, 교통, 크로스컨트리). 여러 레이어 동시 켜기 가능. 켜는 방법·위치는 본문에 없음. | 경사도 레이어는 데이터가 없으면 넣지 않는다(빈 기능 금지). |
| Mapy.com: Map (지도 선택) | https://napoveda.seznam.cz/en/working-map-and-map-layers-mapy.cz-app. | 열어봄 | 웹은 왼쪽 위 "Change map"으로 지도 종류 창. | 참고만. |
| Outdooractive 지도 도움말 (Julian Alps 포털, Outdooractive 플랫폼) | https://julian-alps.com/en/knowledgepage/how-do-i-switch-between-maps-/54720139/ , https://julian-alps.com/en/r/37514052/ | 열어봄(2차: Outdooractive 기반 지역 포털). outdooractive.com 자체 도움말은 실패(헤드리스 404) | Map Layer Panel은 **오른쪽 아래**. 순서: 배경지도 → 스타일 → 길·활동 오버레이 → 추가 레이어(경사도). 경사도는 **5° 단위**, 축척 500m 수준부터 표시, 스키 투어 등 경로 계획 시 자동 표시, 수동 끄기 가능. | 레이어 시트 섹션 순서의 근거(배경 → 길 → 추가 정보). |
| OS Maps: Exploring Maps | https://osmaps.com/index.html/guide/1/exploring-maps | 열어봄 | **오른쪽 아래** "Map Types" 버튼(겹친 사각형 아이콘): 지도 종류와 오버레이를 한 곳에서, 누르면 미리보기, X로 복귀. Standard(무료)/Topographic(유료)/Aerial + 오버레이(National Cycle Network). 내 위치(십자선)도 **오른쪽 아래**, 다시 누르면 중심 고정 해제. Places 도구로 주차장·정류장·삼각점 등 POI 범주를 골라 표시. | 레이어·위치 버튼 우하단 배치의 근거(규칙 9). |
| 램블러 (App Store 한국) | https://apps.apple.com/kr/app/id531276104 | 열어봄(스토어 설명·리뷰만, 앱 화면 미확인) | 평점 4.4(637). 무료 오프라인 지도 + **네이버 지도(등고선·상세 지명)**. 산 정보 검색 → 경로 다운로드 → "내 지도에 경로 추가". 기록 중 사진·메모가 **촬영 지점 마커**로. 리뷰: 경로 이탈 시 진동만 있고 **음성 알림**이 없어 트랭글과 같이 쓴다는 요청. | 경로 따라가기의 이탈 경고를 소리/진동/화면 세 가지로 설정 가능하게. 사진 위치 마커는 "표시할 것" 토글 후보. |
| 트랭글 (App Store 한국, Kakao VX) | https://apps.apple.com/kr/app/id505902704 | 열어봄(스토어 설명·리뷰만) | 평점 2.5(1.4천). 기능: 홈 요약, 배지, 운동 내비(등산로·보행로·자전거길·둘레길), 경로 탐색, **주변 탐색**(내 위치 기준), **지도 정보**(탐방 시설·편의 시설·배지 위치), 장소·시기·난이도별 추천. 리뷰는 대부분 GPS 기록 오류·업데이트 후 불편. | 국내 사용자에게 익숙한 "주변 탐색"·"시설 표시"를 레이어 토글로. 업데이트로 기존 기록 수치가 바뀌는 일이 없게 데이터 호환 유지. |
| 국립공원공단: 탐방로 통합검색 | https://www.knps.or.kr/front/portal/trails/search.do?menuNo=8000754 | 열어봄 | 필터: 지역본부, 국립공원, 일정(당일/1박2일/2박3일), **난이도(상/중/하)**, 소요시간(1시간 이하 / 1~5시간 / 5~8시간 / 8~10시간 / 10시간 이상). 총 242건. 표 열: 지역본부·공원명·코스명·일정·난이도·소요시간. | 국립공원 코스 데이터를 붙일 때 난이도 3단계(상/중/하)와 등급지도 5단계가 섞여 있으니 표시 체계를 하나로 정한다. |
| 국립공원공단: 국립공원 지도(북한산 탐방로 등급지도 JPG) | https://www.knps.or.kr/portal/main/contents.do?menuNo=8000575 | 열어봄(원본 이미지 내려받아 범례 확인, 4252×6520px) | 범례 "탐방로 구간별 난이도" **5단계**: 매우쉬움(Easy) `#d9b12d` · 쉬움(Moderate) `#7ba12a` · 보통(Intermediate) `#cf4c20` · 어려움(Advanced) `#8a0b34` · 매우어려움(Expert) `#231508`(픽셀 샘플링 값). 주석: 거리·경사도·노면 상태·암릉/암반 유무로 산출. **구간마다 거리 라벨(예: 1.2km)**, 탐방지원센터·지킴터·대피소 아이콘. | 규칙 17. 선택한 등산로를 구간별로 색칠하고 구간 거리 라벨을 다는 방식이 국내 등산객에게 가장 익숙하다. |
| 국립공원 산행정보 앱 | https://apps.apple.com/kr/app/id481131714 | 실패(App Store 404). 앱 정보는 검색결과만 | (검색결과) 22개 공원 오프라인 지도, 주차장·대피소·샘터·위험지점 표시, 명칭 검색 또는 지도에서 코스 지정. | 근거로 쓰지 않음. |
| 국립공원 탐방로 혼잡도 / 탐방알리미 | http://visit.knps.or.kr:8080/congestion/main (링크만 확인) | 검색결과만 | (보도) 혼잡도 3단계 **여유=초록, 보통=노랑, 혼잡=빨강**, 21개 공원 291개 탐방로(2022). 통제 구간 색 표시(개인 블로그). | 통제·혼잡 정보를 붙인다면 난이도 색과 겹치지 않는 표현(아이콘+글자 배지)으로. |
| 두루누비 홈 / 해파랑길 코스 검색 | https://www.durunubi.kr/ , https://www.durunubi.kr/haeparang-course-list.do | 열어봄 | 코스 카드: **지역 · 코스명 · 거리 · 소요시간 · 난이도**(예: "울산 동구 · 해파랑길 8코스 · 11.8km · 4시간 30분 · 보통"). 필터: 지역(도/시 → 시/군), **거리(5km 미만/5~10km/10km 초과)**, **소요시간(2시간 미만/2~4시간/4시간 초과)**, **난이도(쉬움/보통/어려움)**, 초기화·검색 버튼. "지도에서 찾아보는 코리아둘레길", 총 약 4,500km. | 규칙 18·20. 걷기길·둘레길 레이어를 넣으면 같은 카드 형식 재사용. |

## 6. 한국형 디자인 시스템(KRDS) · 서체

| 이름 | URL | 확인 여부 | 구체 가이드(수치 포함) | 이 앱에 적용할 점 |
|---|---|---|---|---|
| KRDS 타이포그래피 | https://www.krds.go.kr/html/site/style/style_03.html | 열어봄 | 서체 **Pretendard GOV**(확장형은 고딕 계열 권장: 노토 산스, 나눔고딕, 스포카 한 산스). 굵기 400/700 기본, 이상적 조합 400/500/700, 최대 4종. 줄 간격 **150% 이상**(WCAG 1.4.12). 본문 최소 **16px**, Pretendard GOV는 작아 보여 **17px** 기본. 모바일 크기: heading xlarge 28 / large 24 / medium 22 / small 19 / xsmall 17 / xxsmall 15, body large 19 / medium 17 / small 15 / xsmall 13. 제목:본문 비율 1.25~1.5배. 대비 AA: 일반 4.5:1, 큰 글씨(24px 이상 또는 굵게 18.66px 이상) 3:1. rem 사용. | 규칙 24. 목록 메타 정보 15px, 주석만 13px. |
| KRDS 레이아웃 | https://www.krds.go.kr/html/site/style/style_05.html | 열어봄 | 브레이크포인트: small **360px~**: 4열, 거터 16, 최소 스크린 마진 **16px**. medium 768px~: 8열, 마진 24. large 1024px~: 12열. 359px 이하도 마진 16px. 가장자리 터치 오류 방지를 위해 모바일 최소 마진 필수. | 지도 컨트롤 화면 끝 여백 16px, 시트 내부 좌우 패딩 16px. 768px 이상에서는 시트 → 좌측 패널. |
| KRDS 형태(래디어스) | https://www.krds.go.kr/html/site/style/style_04.html | 열어봄 | 2~12px만 사용, **최댓값 12px**("과하게 둥근 형태 방지"). 버튼·입력 6px, 카드·대화상자 10px, 배너·바텀시트 12px, 칩 4px. 같이 놓이는 비슷한 크기 요소는 같은 반경. | M3 시트 28dp 대신 12px. 모든 요소를 크게 둥글리는 인상을 피한다. |
| KRDS 토글 스위치 (2025-01-15) | https://www.krds.go.kr/html/site/component/component_06_07.html | 열어봄 | 쓰는 경우: 상반된 두 상태, 기능 켜고 끄기, **즉시 반영**. 쓰지 않는 경우: 계층 옵션(중간 상태 체크박스), 레이블이 직관적이지 않을 때(라디오), 기본 상태가 없을 때, 별도 제출이 필요할 때. 레이블은 명사형, **상태에 따라 레이블 바꾸지 않기**, 레이블과 스위치를 가깝게, 한 화면 안 같은 배열. 접근성: 대비 3:1, 키보드, 포커스 표시, 접근 가능한 이름. | 규칙 15. |
| KRDS 모바일 설정 (2025-01-15) | https://www.krds.go.kr/html/site/global/global_13.html | 열어봄 | 상위 카테고리 **6~9개**, 위험도·빈도 높은 항목 위로, 기술적·저빈도 항목은 하위로 접기. 즉시 전환은 저장 없는 토글, 상호배타는 라디오, 다중은 체크박스, 연속값은 슬라이더, 2~4개 모드 전환은 세그먼트. 변경은 즉시 적용 + **스낵바·토스트 2~3초**, 결과와 후속 행동 하나만("푸시 알림이 꺼졌습니다. 되돌리기"), 스크린리더로 읽히게. 되돌리기 어려운 작업은 재확인. OS 권한이 필요한 기능은 앱 토글과 OS 권한을 구분해 안내하고 시스템 설정 이동 버튼. 오프라인 변경은 로컬 큐. | 규칙 15·16. 위치 권한 거부 상태를 설정 화면에서 설명. |
| KRDS 디지털 포용 | https://www.krds.go.kr/html/site/utility/utility_04.html | 열어봄 | KWCAG 2.2·전자정부 품질관리 지침·WCAG 2.1 준수 지원. 아이콘 버튼 44×44px 이상 고려. KRDS 적용만으로 접근성을 완전히 충족한다고 볼 수 없다고 명시. | 3장 참조. |
| Pretendard (GitHub, LICENSE, 릴리스) | https://github.com/orioncactus/pretendard , https://raw.githubusercontent.com/orioncactus/pretendard/main/LICENSE | 열어봄 | **SIL Open Font License 1.1**, 예약 글꼴명(RFN) **'Pretendard'**(Source·Inter·M PLUS 1 RFN도 포함). 글꼴 단독 판매 외 상업적 사용·수정·재배포 허용. 최신 **v1.3.9**(2023-11-05). 웹용 동적 서브셋 CSS(`pretendard-dynamic-subset`), 가변 굵기(`Pretendard Variable`), 변형 JP·Std·**GOV**. | 공식 동적 서브셋 파일을 그대로 쓰면 이름 문제 없음. 직접 서브셋을 만들어 배포하면 OFL상 수정본이므로 RFN 조항(같은 이름 사용 제한)을 확인. 현재 앱은 시스템 고딕 + 일부 Noto Serif KR이므로, 바꿀 경우 Pretendard(GOV) 17px 기준으로 크기 재조정. |

## 7. 토글 스위치 · 설정 · 점진적 공개

| 이름 | URL | 확인 여부 | 구체 가이드(수치 포함) | 이 앱에 적용할 점 |
|---|---|---|---|---|
| NN/g: Toggle-Switch Guidelines (Alita Kendrick, 2018-07-29) | https://www.nngroup.com/articles/toggle-switch-guidelines/ | 열어봄 | 토글은 **즉시 적용**. 즉시 반영이 안 되면 체크박스·라디오. 제출 버튼이 있는 폼에 섞지 말 것. 레이블은 짧게, 핵심어 먼저, 켰을 때 하는 일을 설명. "레이블 + 켬/끔"을 소리 내 읽어 말이 되는지 확인. 켬 상태는 고대비 색. 상태 문구를 쓰면 "끔"은 왼쪽, "켬"은 오른쪽. | 레이어 시트의 겹침 항목, 설정의 기능 켜기. 필터(적용 버튼 있는 시트)에는 스위치를 쓰지 않고 칩/체크박스. |
| Apple HIG: Toggles | https://developer.apple.com/design/human-interface-guidelines/toggles | 열어봄 | iOS에서 스위치는 **목록 행 안에서만**. 목록 밖에서는 배경이 바뀌는 토글 버튼(예: 전화 앱 필터 버튼). 상태 차이는 색만으로 표시하지 말 것. | 지도 위 "완등만 보기" 같은 즉석 토글은 스위치가 아닌 칩(눌림 상태 배경 + 체크 아이콘). |
| NN/g: Progressive Disclosure (Jakob Nielsen, 2006-12-03) | https://www.nngroup.com/articles/progressive-disclosure/ | 열어봄 | 처음엔 중요한 소수만, 요청 시 고급 옵션. 첫 화면에 있다는 것 자체가 중요하다는 신호. 다음 단계로 가는 방법이 분명하고 레이블이 기대를 정확히 설정해야 함. **2단계를 넘으면 사용성 저하**. 사용 빈도 데이터로 나눈다. | 지도 화면 = 검색·필터 칩·위치·레이어만. 경사도, 데이터 출처 상세, 실험 기능은 설정 2단계. |
| Gaia GPS Adventure Modes (위 5장 행) | https://help.gaiagps.com/hc/en-us/articles/115003640128-Add-Layer-and-Change-Map-Sources-in-the-iOS-app | 열어봄 | 활동별 프리셋 + Reset + 고급(Custom) 분리. | 레이어 시트의 점진적 공개 모델. |
| Map UI Patterns: Kitchen sink (위 4장 행) | https://www.mapuipatterns.com/kitchen-sink | 열어봄 | 기능 과다 → Hick의 법칙, 점진적 공개로 제한. | 같음. |

## 8. "AI가 만든 듯한" UI 특징과 피할 점

| 이름 | URL | 확인 여부 | 구체 가이드(수치 포함) | 이 앱에 적용할 점 |
|---|---|---|---|---|
| Anthropic: Improving frontend design through Skills (2025-11-12) | https://claude.com/blog/improving-frontend-design-through-skills | 열어봄 | 지시 없이 만들면 거의 항상 **Inter 글꼴, 흰 배경 위 보라 그라데이션, 최소한의 애니메이션**으로 수렴한다("분포 수렴": 학습 데이터의 무난한 중심값을 고름). 이런 획일성 때문에 AI 생성 화면을 바로 알아본다. 명시적 제약을 주면 개선된다. | "AI스럽지 않게"의 출처 있는 정의. 다만 이 글의 처방(분위기 있는 배경, 레이어드 그라데이션, 화려한 서체)은 랜딩 페이지 기준이라 지도 도구에는 맞지 않는다(아래 주의 참고). |
| prg.sh: Why Your AI Keeps Building the Same Purple Gradient Website (2025-10-26) | https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website | 열어봄(2차, 개인 블로그) | 특징 목록: Inter/Roboto, 보라·인디고 강조색, 가운데 정렬 히어로 + CTA, 아이콘 달린 기능 상자 3개, 흰색·연회색 배경, **모든 요소에 둥근 모서리**, 0.1 불투명도 그림자. 빠지기 쉬운 것: 크기 외의 위계, 필수 입력 표시·검증, 접근성(ARIA, 키보드). 기원으로 Tailwind UI 기본 버튼 `bg-indigo-500`과 Adam Wathan의 2025-08 사과 글을 든다. | 체크리스트 24. 기능 상자 3열 대신 실제 데이터(거리·시간·고도·난이도)를 화면 주인공으로. |
| Adam Wathan의 X 게시물(인디고 기본값 사과) | (원문 링크 미확보) | 검색결과만 | 여러 블로그가 같은 내용을 인용하나 원문은 확인하지 못함. | 근거로 인용하지 않음. |
| NN/g: Liquid Glass Is Cracked, and Usability Suffers in iOS 26 (Raluca Budiu, 2025-10-10) | https://www.nngroup.com/articles/liquid-glass/ | 열어봄 | 반투명 컨트롤은 복잡한 배경 위에서 대비를 잃어 읽기 어렵다. 떠 있는 제목·검색창·탭바가 내용과 주의를 다툰다. 건드리지 않은 컨트롤의 움직임은 산만함. 실제로 바뀌지 않은 상태를 색으로 암시하면 오해. 탭바 아이템 간격·크기가 지침보다 좁다. 컨트롤 위치가 바뀌면 학습이 어렵다. | 지도(특히 위성)는 대표적인 "복잡한 배경"이다. 지도 위 컨트롤은 불투명 배경, 고정 위치, 상태 변화만 색으로 표현(규칙 22). |
| NN/g: Icon Usability (Aurora Harley, 2014-07-27) | https://www.nngroup.com/articles/icon-usability/ | 열어봄 | 누구나 아는 아이콘은 홈·인쇄·검색 정도로 적다. **텍스트 레이블을 항상 보이게**(호버로 띄우기 금지). 5초 안에 아이콘이 떠오르지 않으면 그 개념에 아이콘을 쓰지 말 것. 같은 아이콘은 같은 기능으로. | 탭바·레이어 항목은 아이콘 + 글자. 지도 위 단독 아이콘은 과녁(위치)·겹친 사각형(레이어)·+/−만. |
| Pope Tech: Making emojis and icons screen reader accessible (2026-04-21 갱신) | https://blog.pope.tech/2026/04/01/making-emojis-and-icons-screen-reader-accessible/ | 열어봄 | 스크린리더는 이모지를 **유니코드 이름**으로 읽어 의도가 사라진다(예: 🚩 → 깃발 이름). 장식·중복 이모지는 `aria-hidden="true"`, 아이콘만 있는 버튼은 버튼에 `aria-label`, span에 aria-label을 달면 `role="img"` 필요. | 위치 버튼의 🎯/🚫/⚠️를 SVG + 상태 글자(토스트·aria-live)로 교체. |
| 글래스모피즘 관련 글(ramotion, clay.global, axesslab 등) | 검색결과 다수 | 검색결과만(axesslab 원문은 404) | NN/g 글은 찾지 못함. 업체 블로그의 블러 12~20px·불투명도 12~25% 같은 수치는 근거가 약함. | 채택하지 않음. 대신 NN/g Liquid Glass 결과를 근거로 사용. |
| 925studios, noqta, superdesign 등 "AI slop" 글 | 검색결과 다수 | 검색결과만 | 의견성 목록, 측정 근거 없음. | 근거로 쓰지 않음. |

---

## 근거끼리 부딪히는 곳과 판단

1. **바텀시트에 목록을 둬도 되나**: KRDS·NN/g는 "항상 필요한 정보에는 바텀시트 부적합, 짧은 상호작용만"이라고 한다. 이는 **모달** 시트 기준이다. M3 standard 시트("지도 위 위치 정보"), Apple 비모달 시트, Google Maps 탐색 시트가 지도 위 상시 목록의 근거다. → 탐색 목록 = 비모달 standard 시트, 필터·레이어·정렬 = KRDS 규칙을 따르는 모달 시트로 나눈다.
2. **엄지 도달성**: Hoober 2013 그림(하단이 쉬움)은 저자가 2017년에 정정했다. 가운데가 가장 정확하고(7mm), 모서리가 가장 부정확하다(12mm). NN/g도 "바텀시트가 도달성을 높인다"는 주장에 반대한다. → 지도 컨트롤을 우하단에 두는 근거는 "엄지가 닿아서"보다 OS Maps·Outdooractive·mapuipatterns의 관례와 시트·탭바와의 동선이다. 목록 행처럼 자주 누르는 대상은 화면 가운데 높이로 오도록 half detent를 기본으로 한다.
3. **모서리 반경**: M3 시트 28dp vs KRDS 최대 12px. 국내 공공 관례와 "모든 요소가 둥근" AI 인상 회피를 함께 고려해 12px로 한다.
4. **"AI스럽지 않게"의 처방**: Anthropic·prg.sh 글은 랜딩 페이지에 대해 "분위기 있는 배경, 그라데이션, 개성 있는 서체"를 권한다. 지도 도구에서 배경은 지도이고, 장식 그라데이션은 Liquid Glass 결과처럼 지도 가독성을 떨어뜨린다. 이 앱에서 "AI 같지 않음"은 장식이 아니라 다음으로 만든다: 국립공원 등급지도 색·두루누비 카드 필드 같은 **국내 실사용 관례**, 등고선·수계 같은 **지도 관례 색**, 실측 데이터(거리·소요시간·고도·완등 여부)를 크게 보여 주는 정보 위계, 이모지 대신 일관된 SVG 아이콘과 글자 레이블.
5. **난이도 체계**: 국립공원 통합검색은 3단계(상/중/하), 등급지도는 5단계, 두루누비는 3단계(쉬움/보통/어려움), AllTrails는 4단계다. 앱 데이터에 맞는 하나를 정하고, 5단계 색을 쓸 경우 3단계와의 대응(쉬움 = 매우쉬움+쉬움 등)을 범례에 밝힌다.
6. **확인 못 한 것**: 램블러·트랭글·국립공원 산행정보 앱의 실제 화면(앱 실행 불가, 스토어 설명만), Google·Apple 지도 앱의 공식 디자인 문서(언론 보도로 대체), Outdooractive 본사 도움말(지역 포털로 대체), NN/g 글래스모피즘 글(찾지 못함).
