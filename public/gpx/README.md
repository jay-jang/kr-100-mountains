# 등산 경로 GPX 폴더

이 폴더에 실제 GPS 트랙 파일(`.gpx`)을 넣으면 해당 산의 상세 페이지 지도에 **자동으로 경로가 표시**됩니다.

## 파일 이름 규칙

산의 `id`와 똑같은 이름을 사용하세요. 예:

- 설악산 오색–대청봉 → `seolaksan.gpx`
- 지리산 천왕봉 → `jirisan.gpx`
- 북한산 → `bukhansan.gpx`

각 산의 `id`는 `data/registry.json` 또는 `public/data/mountains.pretty.json`에서 확인할 수 있습니다.

## 원칙

- 이 프로젝트는 **실제 기록된 GPX만** 표시합니다. 좌표를 지어내지 않습니다.
- 상세 페이지에서 사용자가 직접 `.gpx` 파일을 업로드해 미리 볼 수도 있습니다(브라우저 내 처리, 서버 전송 없음).
- 지도의 주황색 "등산로" 선은 OpenStreetMap의 `highway=path/footway/track` 데이터를 Overpass API로 불러온 것입니다.

## GPX를 구할 수 있는 곳(참고)

트랭글(Tranggle), 램블러(Ramblr), 국립공원공단 등에서 본인이 기록했거나 공유가 허용된 트랙을 사용하세요.
