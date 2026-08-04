# 등산 경로 GPX 폴더

이 폴더에는 **성격이 다른 두 종류**의 경로 파일이 들어 있습니다. 섞이지 않도록 자리를 나눠 두었습니다.

```
public/gpx/
├── <산id>.gpx              ← ① 실측 GPS 트랙 (사람이 직접 기록/기증)
├── index.json              ← ① 의 목록 (빌드가 자동 생성)
└── routes/                 ← ② 수집한 산별·코스별 경로
    ├── index.json          ← 어느 산에 몇 건이 있는지만 담은 가벼운 목록
    ├── m/<산id>.json       ← 그 산의 트랙 상세 (상세 페이지가 이것만 받는다)
    ├── catalog.json        ← 전체를 한 파일로 모은 판본 (사람이 읽는 용도)
    ├── <산id>/<산id>-NN[a|b].gpx
    └── osm-relations/r<osm관계id>.gpx
```

## ① 실측 GPX — `public/gpx/<산id>.gpx`

산의 `id`와 똑같은 이름을 쓰면 상세 페이지 지도에 자동으로 표시됩니다.

- 설악산 오색–대청봉 → `seolaksan.gpx` / 지리산 → `jirisan.gpx` / 북한산 → `bukhansan.gpx`
- 각 산의 `id`는 `data/registry.json` 또는 `public/data/mountains.pretty.json`에서 확인할 수 있습니다.
- 상세 페이지에서 사용자가 직접 `.gpx`를 업로드해 미리 볼 수도 있습니다(브라우저 안에서만 처리, 서버 전송 없음).

**본인이 기록했거나 재배포가 명시적으로 허용된 트랙만** 넣으세요. 트랭글·램블러·Wikiloc·
AllTrails·Strava 등에서 받은 남의 트랙은 다운로드가 가능하더라도 재배포 권리가 따라오지
않습니다. 공개 트랙에는 시작·끝점으로 기록자의 집·숙소가 남아 있을 수 있으니, 기증받은
트랙은 들머리 바깥 접근 구간을 잘라내고 시간·기기 정보를 지운 뒤 넣으세요.

## ② 수집 경로 — `public/gpx/routes/`

`npm run routes`(= `scripts/collect-routes.mjs`)가 만들어 넣는 파일들입니다.

| 종류 | 무엇인가 | 파일 |
|---|---|---|
| `osm-routed` | 등록된 **들머리 → 정상**을 OpenStreetMap 등산로망 위에서 계산한 경로. 코스마다 최단 1개 + 대안 최대 2개(`a`, `b` 접미사) | `routes/<산id>/<산id>-NN[a\|b].gpx` |
| `osm-relation` | OSM에 `route=hiking` 관계로 등록된 도보 경로 선형 원본(둘레길·순환길 등) | `routes/osm-relations/r<id>.gpx` |

### ★ 이 파일들은 실측 기록이 아닙니다

모든 좌표는 OSM에 실제로 등록된 등산로 위의 점이지만, **경로 자체는 계산 결과**입니다.
그래서 파일마다 `<k100:provenance>`와 `<k100:not_a_recorded_track>true</...>`를 넣고
`<desc>`에도 그 사실을 적어 두었습니다. ①의 실측 트랙과 섞어 쓰지 마세요.

현장 통제·훼손·계절 통제·출입 제한을 반영하지 않으므로, 실제 산행 계획에는 국립공원공단·
산림청 등 **공식 안내를 함께 확인**해야 합니다.

### 매니페스트

- `routes/index.json` — 어느 산에 몇 건이 수록됐는지, 출처·라이선스, 전체 통계
- `routes/m/<산id>.json` — 그 산의 트랙 상세. 상세 페이지는 이 파일 하나만 받습니다
- `routes/catalog.json` — 전부를 한 파일에 모아 사람이 읽기 좋게 정리한 판본

트랙마다 판단에 필요한 수치가 함께 들어 있습니다.

- `status` — `accepted`(자동 승인) / `review`(사람 확인 권장). `rejected`는 파일을 쓰지 않습니다.
- `score` — 정상 근접도 30 + 들머리 근접도 25 + 등록 거리 일치 25 + 경로–정상 최단거리 20
- `snap_trailhead_m` / `snap_summit_m` — 등록 좌표에서 등산로망까지의 거리. 이 값이 크면
  코스 앞부분이 빠졌거나 정상까지 길이 이어지지 않았다는 뜻입니다.
- `distance_ratio` / `distance_hypothesis` — 등록 `distance_km`와의 비교. 등록값이 편도인지
  왕복인지 데이터에 정의가 없어 두 가설을 모두 평가한 뒤 **더 잘 맞는 쪽을 기록만** 합니다.
  등록값을 덮어쓰지 않습니다.
- `warnings` — 승인은 됐지만 알아둘 점

### 출처와 라이선스

| 항목 | 출처 | 라이선스 |
|---|---|---|
| 등산로 선형 | OpenStreetMap (Overpass API) | ODbL 1.0 — 재배포 시 `© OpenStreetMap contributors` 표기 필요 |
| 고도값 | SRTM 1 arc-second (NASA/USGS, public domain) — [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) 배포본 | 지형 DEM에서 읽은 **추정 고도**이며 기압·GPS 실측 고도가 아닙니다 |

고도는 무료 API 대신 1°×1° DEM 타일 20장을 `.cache/routes/dem/`에 받아 로컬에서 샘플링합니다.
좌표가 수만 개라 공개 고도 API로는 시간당 한도에 걸려 고도가 통째로 빠집니다(실제로 겪음).
DEM 해상도가 30m라 뾰족한 정상은 실제 표고보다 낮게 읽힙니다.

지도의 주황색 "등산로" 선도 같은 OSM `highway=path/footway/track` 데이터입니다.

## 수집 다시 돌리기

```bash
npm run routes                       # 전체(이미 끝난 산은 건너뜀 — 재개 가능)
node scripts/collect-routes.mjs --only=bukhansan,jirisan
node scripts/collect-routes.mjs --limit=10
node scripts/collect-routes.mjs --force          # 캐시 무시하고 다시
node scripts/collect-routes.mjs --no-elevation   # 고도 조회 생략(빠른 확인)
node scripts/collect-routes.mjs --publish-only   # 받아둔 결과로 매니페스트만 재생성
```

원본 Overpass 응답·고도 캐시·중간 결과는 `.cache/routes/`에 쌓이며 **커밋하지 않습니다**
(`.gitignore`). 리포에는 정규화된 결과 GPX와 매니페스트만 들어갑니다.

공용 Overpass 서버를 쓰므로 산당 1회만 조회하고 요청 사이에 최소 간격을 둡니다.

## 아직 넣지 않은 소스

산림청 등산로 SHP, 국토교통부 등산로(VWorld WFS), 국립공원공단 탐방로는 공공데이터포털
서비스키가 있어야 받을 수 있어 이번 수집에는 넣지 않았습니다. 키를 발급받으면
`osm-routed`와 같은 자리에 별도 `kind`로 추가할 수 있도록 매니페스트에 필드를 열어 두었습니다.
각 데이터셋의 **이용허락범위(공공누리 유형)를 내려받는 시점에 확인**해서 기록해야 합니다 —
제3·4유형은 변경·재배포가 막혀 있어 이 리포에 넣을 수 없습니다.
