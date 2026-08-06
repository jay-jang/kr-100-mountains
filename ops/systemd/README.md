# 탐방 후기 매일 수집 — systemd 사용자 타이머

`scripts/collect-reviews.mjs`를 하루에 한 번 돌려 산별 후기·현장 정보를 조금씩 갱신합니다.

이 호스트에는 `crontab`이 없어 systemd 사용자 타이머를 씁니다. 로그인 세션이 없어도 돌도록
`loginctl enable-linger`가 필요합니다(이 호스트는 이미 `Linger=yes`).

## 설치

```bash
mkdir -p ~/.config/systemd/user
cp ops/systemd/kr100-reviews.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now kr100-reviews.timer

# 로그인 세션 없이도 돌게 (한 번만)
loginctl enable-linger "$USER"
```

## 확인·조작

```bash
systemctl --user list-timers kr100-reviews.timer   # 다음 실행 시각
systemctl --user status kr100-reviews.service      # 마지막 실행 결과
systemctl --user start kr100-reviews.service       # 지금 바로 한 번 돌리기
journalctl --user -u kr100-reviews.service -n 50   # systemd 쪽 로그
tail -f .cache/reviews-logs/$(date -u +%F).log     # 작업 자체 로그
systemctl --user disable --now kr100-reviews.timer # 중지
```

## 동작

- **시각**: 매일 18:20 UTC(= 03:20 KST) ± 최대 15분. 꺼져 있어 걸렀으면 켜진 뒤 한 번 돌립니다.
- **분량**: 하루 `KR100_REVIEWS_LIMIT`(기본 8)개 산. **가장 오래 안 본 산부터** 고르므로
  149개 산이 약 3주에 한 바퀴 돕니다. 최근 `KR100_REVIEWS_STALE_DAYS`(기본 21)일 안에 본 산은
  건너뜁니다.
- **결과**: `data/reviews.verified.json`과 `public/data/reviews/`를 갱신하고, 바뀐 게 있으면
  **로컬에 커밋**합니다.
- **push: 켜져 있습니다(`KR100_REVIEWS_PUSH=1`).** `main`에 push하면 GitHub Pages 배포가
  자동으로 돌아 그날 모은 후기가 그대로 공개됩니다. 즉 **사람이 검토하지 않은 웹 조사 결과가
  매일 사이트에 올라갑니다.** 대신 이런 장치가 걸려 있습니다.
  - 출처 URL 없는 항목은 애초에 저장하지 않음
  - 두 조사가 서로의 주장을 웹 근거로 다시 검증하고, **반박이 하나라도 나오면 싣지 않음**
  - 확인 0표 항목도 싣지 않음 · 화면에 교차검증/단일확인 등급과 출처 링크를 그대로 노출

  끄려면 서비스 파일에서 `Environment=KR100_REVIEWS_PUSH=0`으로 바꾸고
  `systemctl --user daemon-reload`.

  무엇이 올라갔는지 확인:
  ```bash
  git log --oneline --grep='chore(reviews)'
  git show --stat $(git log -1 --format=%H --grep='chore(reviews)')
  ```
- **로그**: `.cache/reviews-logs/<날짜>.log` (30일치 보관, gitignore 대상)

## 설정 바꾸기

`~/.config/systemd/user/kr100-reviews.service`의 `Environment=` 줄을 고치고

```bash
systemctl --user daemon-reload
```

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `KR100_REVIEWS_LIMIT` | 8 | 하루에 갱신할 산 수 |
| `KR100_REVIEWS_BATCH` | 4 | 한 번의 조사 요청에 묶을 산 수 |
| `KR100_REVIEWS_STALE_DAYS` | 21 | 이 기간 안에 수집한 산은 건너뜀 |
| `KR100_REVIEWS_PUSH` | 0 | 1이면 커밋 후 origin에 push |
| `KR100_REPO` | `%h/workspace/100-kr-mountain` | 리포 경로 |

실행 시각은 `kr100-reviews.timer`의 `OnCalendar`에서 바꿉니다(UTC 기준).

**리포를 다른 경로에 두었다면** `KR100_REPO` 하나만 바꿔서는 안 됩니다. systemd는 절대경로만
받으므로 서비스 파일의 `WorkingDirectory`·`ExecStart`·`Environment=KR100_REPO` **세 줄을 함께**
고쳐야 합니다(`%h`는 그 사용자의 홈 디렉터리로 치환됩니다).

## 안전장치

- **중복 실행 차단** — 스크립트가 `flock`으로 잠급니다. 타이머가 도는 중에 손으로 또 돌리면
  두 번째는 조용히 물러납니다.
- **커밋 범위 한정** — `data/reviews.verified.json`과 `public/data/reviews`만 커밋합니다.
  작업 중이던 다른 파일이 stage에 올라와 있어도 함께 커밋되지 않습니다.
- **실패 전파** — 수집·커밋·push 중 하나라도 실패하면 종료코드가 0이 아니고,
  `systemctl --user status kr100-reviews.service`에 실패로 남습니다.
- **자료 보존** — 조사가 빈손으로 끝난 산은 이전에 모아 둔 자료를 덮어쓰지 않습니다.
