#!/usr/bin/env bash
# Screenshot of the app's webview, on a private display (never your desktop). Needs a debug build (the screenshot
# command only exists there): cargo build -p tachylite-app, after `cd ui && bun run build`, and touch
# crates/tachylite-app/src/main.rs when the UI changed so it is embedded again.
# Needs xvfb-run, openbox. Usage:
#   scripts/screenshot.sh out.png                      a note in Live Preview in a fixture vault
#   scripts/screenshot.sh out.png my-script.js         run my-script.js in the app first (`app`, `shell`, `ipc` in scope),
#                                                       then capture; the script may call `await shot()` itself
#   scripts/screenshot.sh out.png my-script.js /path/to/vault
# The window is captured by WebKit's own snapshot, so it works without a compositor.
set -euo pipefail

cd "$(dirname "$0")/.."
out="${1:?usage: scripts/screenshot.sh out.png [script.js] [vault]}"
out="$(realpath -m "$out")"
user_script="${2:-}"
user_vault="${3:-}"
bin="$(realpath "${TACHYLITE_BIN:-target/debug/tachylite}")"
[ -x "$bin" ] || { echo "no executable at $bin (debug build needed)" >&2; exit 2; }

# shellcheck source=lib/isolated.sh
source scripts/lib/isolated.sh
isolated_reexec "$0" "$out" "$user_script" "$user_vault"
isolated_setup
trap isolated_cleanup EXIT

if [ -n "$user_vault" ]; then
  vault="$user_vault"
else
  vault="$work/vault"
  mkdir -p "$vault/.obsidian"
  printf '# Screenshot\n\nSome **bold** text, a [[Target]] link and a #tag.\n\n- [ ] a task\n- [x] done\n\n> [!note] A callout\n> with a body\n' > "$vault/Note.md"
  printf '# Target\n' > "$vault/Target.md"
fi

{
  echo 'const shot = () => window.__TAURI__.core.invoke("dev_screenshot", { path: '"$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"' });'
  echo 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));'
  if [ -n "$user_script" ]; then
    cat "$user_script"
  else
    echo 'await app.workspace.openLinkText("Note", "", false); await sleep(1500);'
  fi
  echo 'await shot(); await ipc.quitApp();'
} > "$work/script.js"

TACHYLITE_DEV=1 TACHYLITE_SCRIPT="$work/script.js" TACHYLITE_LOG="$work/frontend.log" "$bin" --vault "$vault" >"$work/app.out" 2>&1 &
app=$!

for _ in $(seq 1 600); do
  kill -0 "$app" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$app" 2>/dev/null; then echo "timed out; frontend log:" >&2; cat "$work/frontend.log" >&2; exit 1; fi
[ -s "$out" ] || { echo "no screenshot was written; frontend log:" >&2; cat "$work/frontend.log" >&2; tail -10 "$work/app.out" >&2; exit 1; }
echo "wrote $out"
