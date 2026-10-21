#!/usr/bin/env bash
# Real-window smoke test: launches the built app on its own virtual display against a fixture vault, drives it with real
# key presses (xdotool) plus a script running inside the app, and checks the milestones in the frontend log.
# Needs: xvfb-run, openbox, xdotool (apt: xvfb openbox xdotool). Runs fully isolated from your session (own X server,
# own config and data dirs, no single-instance forwarding), so it never touches your desktop or your running Tachylite.
# Usage: scripts/smoke.sh [path/to/tachylite]   (default: target/debug/tachylite, which embeds ui/dist)
set -euo pipefail

cd "$(dirname "$0")/.."
bin="$(realpath "${1:-target/debug/tachylite}")"
[ -x "$bin" ] || { echo "no executable at $bin (build it first: see the Smoke test section of CONTRIBUTING.md)" >&2; exit 2; }

# shellcheck source=lib/isolated.sh
source scripts/lib/isolated.sh
isolated_reexec "$0" "$bin"
isolated_setup
vault="$work/vault"
log="$work/frontend.log"
mkdir -p "$vault/.obsidian"
printf '# Smoke\nSee [[Target]]\n' > "$vault/Note.md"
printf '# Target\n' > "$vault/Target.md"
shots="${SMOKE_SHOTS:-/tmp/tachylite-smoke-shots}"
mkdir -p "$shots"
{ printf 'const SMOKE_SHOTS = %s;\n' "\"$shots\""; cat scripts/smoke-script.js; } > "$work/script.js"

trap isolated_cleanup EXIT

: > "$log"
TACHYLITE_DEV=1 TACHYLITE_SCRIPT="$work/script.js" TACHYLITE_LOG="$log" \
  "$bin" --vault "$vault" >"$work/app.out" 2>&1 &
app=$!

fail() {
  echo "SMOKE FAILED: $1" >&2
  echo "--- frontend log" >&2; cat "$log" >&2
  echo "--- app output (tail)" >&2; tail -20 "$work/app.out" >&2
  exit 1
}

wait_for() { # <pattern> <seconds>
  local i
  for i in $(seq 1 $(( $2 * 10 ))); do
    grep -q "SMOKE FAIL" "$log" && fail "the in-app script reported: $(grep 'SMOKE FAIL' "$log" | head -1)"
    grep -q "$1" "$log" && return 0
    kill -0 "$app" 2>/dev/null || fail "the app exited before '$1'"
    sleep 0.1
  done
  fail "timed out waiting for '$1'"
}

focus() {
  # Find the app's window several ways (GTK sets _NET_WM_PID late, and the class differs between builds); fall back to
  # whatever window the window manager has focused, which for a freshly started app is the app.
  local id="" i
  for i in $(seq 1 150); do
    id="$(xdotool search --onlyvisible --pid "$app" 2>/dev/null | head -1)" || true
    [ -z "$id" ] && id="$(xdotool search --onlyvisible --class tachylite 2>/dev/null | head -1)" || true
    [ -z "$id" ] && id="$(xdotool search --onlyvisible --name Tachylite 2>/dev/null | head -1)" || true
    [ -n "$id" ] && break
    sleep 0.2
  done
  [ -z "$id" ] && id="$(xdotool getactivewindow 2>/dev/null)" || true
  [ -n "$id" ] || fail "no window of the app appeared on the private display"
  xdotool windowfocus "$id" 2>/dev/null || true
  sleep 0.3
}

wait_for "SMOKE OK note-open" 60
wait_for "SMOKE OK live-preview" 30
wait_for "SMOKE OK status-bar" 15
wait_for "SMOKE READY palette" 15
focus
xdotool key ctrl+p
wait_for "SMOKE OK palette" 15
xdotool key Escape
wait_for "SMOKE OK palette-closed" 15
wait_for "SMOKE READY typing" 15
focus
xdotool type --delay 40 " hello smoke"
wait_for "SMOKE OK typing" 15
wait_for "SMOKE OK rename" 15
wait_for "SMOKE OK stacked-tabs" 90
wait_for "SMOKE DONE" 90

# The app must exit by itself after quitApp.
for _ in $(seq 1 100); do kill -0 "$app" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$app" 2>/dev/null; then fail "the app did not exit after quit"; fi
wait "$app" 2>/dev/null || fail "the app exited with an error"

echo "screenshots: $shots"
echo "SMOKE PASSED (features: tables, highlights, rename heading, menu, backlinks, stacked and linked tabs, PDF modal, canvas, bases, graph; note opened, Live Preview, status bar, Ctrl+P palette, typing, rename rewrote the link, clean exit)"
grep '^\[warn\] SMOKE' "$log" || true
