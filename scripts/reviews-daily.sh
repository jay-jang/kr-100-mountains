#!/usr/bin/env bash
# 매일 한 번 도는 탐방 후기 수집 작업. systemd 사용자 타이머(kr100-reviews.timer)가 부른다.
#
# 하는 일
#   1) 오래 안 본 산 몇 개를 골라 후기·현장 정보를 모으고 교차검증한다
#   2) public/data/reviews/ 와 data/reviews.verified.json 을 갱신한다
#   3) 바뀐 게 있으면 **그 두 경로만** 로컬에 커밋한다
#
# push 는 기본으로 하지 않는다. 웹 조사 결과를 사람이 보지 않고 공개 사이트에 바로 올리는 건
# 되돌리기 어려우므로, 원할 때만 KR100_REVIEWS_PUSH=1 로 켠다.
#
# set -e 는 쓰지 않는다 — 수집이 실패해도 로그 정리와 종료코드 전파는 끝까지 해야 한다.
# 대신 중요한 명령은 하나씩 결과를 확인한다.
set -uo pipefail

REPO="${KR100_REPO:-/home/ubuntu/workspace/100-kr-mountain}"
LIMIT="${KR100_REVIEWS_LIMIT:-8}"
BATCH="${KR100_REVIEWS_BATCH:-4}"
STALE="${KR100_REVIEWS_STALE_DAYS:-21}"
LOGDIR="${KR100_REVIEWS_LOGDIR:-$REPO/.cache/reviews-logs}"
PATHS=(data/reviews.verified.json public/data/reviews)

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

cd "$REPO" 2>/dev/null || { echo "리포를 찾을 수 없습니다: $REPO" >&2; exit 1; }
mkdir -p "$LOGDIR"
LOG="$LOGDIR/$(date -u +%Y-%m-%d).log"
exec >>"$LOG" 2>&1

# 중복 실행 방지 — 타이머가 도는 중에 사람이 손으로 또 돌리면 같은 배치 번호·같은 파일·
# 같은 git index를 두 프로세스가 건드린다. 이미 돌고 있으면 조용히 물러난다.
exec 9>"$LOGDIR/.lock"
if ! flock -n 9; then
  echo "[$(date -u +%FT%TZ)] 이미 실행 중이라 건너뜁니다"
  exit 0
fi

echo "=========================================================="
echo "[$(date -u +%FT%TZ)] 후기 수집 시작 (limit=$LIMIT batch=$BATCH stale=$STALE)"

for bin in node git flock; do
  command -v "$bin" >/dev/null || { echo "필수 실행 파일 없음: $bin" >&2; exit 1; }
done
for bin in codex agy; do
  command -v "$bin" >/dev/null || echo "경고: 조사 도구 '$bin' 를 찾을 수 없습니다 — 그 조사 결과는 빠집니다"
done

node scripts/collect-reviews.mjs --limit="$LIMIT" --batch="$BATCH" --stale-days="$STALE"
STATUS=$?
echo "[$(date -u +%FT%TZ)] 수집 종료코드 $STATUS"

FINAL=$STATUS

# 결과가 실제로 바뀌었을 때만 커밋한다.
if [ -n "$(git status --porcelain -- "${PATHS[@]}" 2>/dev/null)" ]; then
  COUNT=$(node -e "try{const d=require('./data/reviews.verified.json');console.log(\`산 \${d.stats.mountains}개 · 항목 \${d.stats.notes}건(교차검증 \${d.stats.verified})\`)}catch(e){console.log('집계 실패')}")
  NAME="${KR100_GIT_NAME:-$(git config user.name || true)}"; NAME="${NAME:-kr100-reviews-bot}"
  EMAIL="${KR100_GIT_EMAIL:-$(git config user.email || true)}"; EMAIL="${EMAIL:-kr100-reviews-bot@localhost}"

  if ! git add -- "${PATHS[@]}"; then
    echo "[$(date -u +%FT%TZ)] git add 실패" >&2; FINAL=1
  # 커밋 대상 경로를 명시한다 — 안 그러면 다른 작업이 미리 stage 해 둔 파일까지 함께 커밋된다.
  elif git -c user.name="$NAME" -c user.email="$EMAIL" \
        commit -q -- "${PATHS[@]}" -m "chore(reviews): 탐방 후기 정기 수집 $(date -u +%F)

$COUNT

매일 도는 수집 작업(scripts/reviews-daily.sh)이 자동으로 갱신했습니다.
독립적인 두 조사가 각자 모은 뒤 서로의 주장을 웹 근거로 검증하며,
반박된 항목은 싣지 않습니다."; then
    echo "[$(date -u +%FT%TZ)] 커밋 완료: $COUNT"
    if [ "${KR100_REVIEWS_PUSH:-0}" = "1" ]; then
      BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
      if [ -n "$BRANCH" ] && git push origin "$BRANCH"; then
        echo "[$(date -u +%FT%TZ)] push 완료 ($BRANCH)"
      else
        echo "[$(date -u +%FT%TZ)] push 실패 (branch=${BRANCH:-?})" >&2; FINAL=1
      fi
    else
      echo "push 안 함 (켜려면 KR100_REVIEWS_PUSH=1)"
    fi
  else
    echo "[$(date -u +%FT%TZ)] git commit 실패 — 변경은 작업트리에 남아 있습니다" >&2; FINAL=1
  fi
else
  echo "[$(date -u +%FT%TZ)] 바뀐 내용 없음 — 커밋하지 않음"
fi

# 로그는 30일치만 남긴다.
find "$LOGDIR" -name '*.log' -mtime +30 -delete 2>/dev/null

echo "[$(date -u +%FT%TZ)] 끝 (exit $FINAL)"
exit $FINAL
