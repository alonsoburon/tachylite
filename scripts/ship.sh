#!/usr/bin/env bash
# Gate, commit, push and wait for CI. Stops at the first failure and exits non-zero unless every CI job is green.
# Usage: scripts/ship.sh "commit message"
#        scripts/ship.sh --no-push "commit message"   (gate and commit only)
#        scripts/ship.sh --no-commit                   (gate only, same as scripts/gate.sh)
# Commit messages are used as given. This script adds no trailers or attribution.
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

push=1
commit=1
msg=""
for arg in "$@"; do
  case "$arg" in
    --no-push) push=0 ;;
    --no-commit) push=0; commit=0 ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) msg="$arg" ;;
  esac
done
if [ "$commit" = 1 ] && [ -z "$msg" ]; then
  echo "usage: scripts/ship.sh [--no-push|--no-commit] \"commit message\"" >&2
  exit 2
fi

scripts/gate.sh
[ "$commit" = 1 ] || exit 0

if [ -z "$(git status --porcelain)" ]; then
  echo "Nothing to commit." >&2
  exit 3
fi

git add -A
git commit -q -m "$msg"
sha="$(git rev-parse HEAD)"
echo "Committed ${sha:0:7}: $msg"
[ "$push" = 1 ] || exit 0

branch="$(git rev-parse --abbrev-ref HEAD)"
git push origin "$branch"

# gh talks to the network; retry it instead of failing on a blip.
gh_retry() {
  local n
  for n in 1 2 3 4 5; do
    if out="$(gh "$@" 2>/dev/null)"; then printf '%s' "$out"; return 0; fi
    sleep $((n * 3))
  done
  echo "gh $* kept failing" >&2
  return 1
}

echo "Looking for the CI run of ${sha:0:7}..."
run=""
for _ in $(seq 1 24); do
  run="$(gh_retry run list --commit "$sha" --limit 1 --json databaseId --jq '.[0].databaseId // empty' || true)"
  [ -n "$run" ] && break
  sleep 5
done
if [ -z "$run" ]; then
  echo "No CI run appeared for ${sha:0:7}." >&2
  exit 4
fi
echo "Watching CI run $run"

# `gh run watch` can die with the connection, so poll the run status ourselves.
while :; do
  status="$(gh_retry run view "$run" --json status --jq .status)"
  [ "$status" = completed ] && break
  sleep 20
done

gh_retry run view "$run" --json jobs --jq '.jobs[] | "\(.conclusion)\t\(.name)"' | sort
conclusion="$(gh_retry run view "$run" --json conclusion --jq .conclusion)"
echo "CI conclusion: $conclusion"
[ "$conclusion" = success ] || exit 1
