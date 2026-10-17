#!/usr/bin/env bash
# Produce compat/obsidian-reference.json from a real Obsidian, with no manual steps: starts Obsidian on a private X
# server in a throwaway vault, enables the dump plugin through the DevTools port and runs its command.
# Usage: scripts/obsidian-reference.sh /path/to/Obsidian-x.y.z.AppImage-extracted/obsidian
#   (get the app from https://github.com/obsidianmd/obsidian-releases/releases, then `./Obsidian-x.y.z.AppImage
#    --appimage-extract`; the binary is squashfs-root/obsidian). Needs xvfb-run, openbox and Node 22+.
# Obsidian runs fully isolated: own X server, own config and data dirs, no Wayland socket or session bus. Do not run the
# binary any other way from a script: a session that exports GDK_BACKEND=wayland would open it on the real desktop.
set -euo pipefail

cd "$(dirname "$0")/.."
bin="$(realpath "${1:?usage: scripts/obsidian-reference.sh /path/to/squashfs-root/obsidian}")"
[ -x "$bin" ] || { echo "no executable at $bin" >&2; exit 2; }

# shellcheck source=lib/isolated.sh
source scripts/lib/isolated.sh
isolated_reexec "$0" "$bin"
isolated_setup
trap isolated_cleanup EXIT

port=19222
vault="$work/vault"
plugin="$vault/.obsidian/plugins/tachylite-reference-dump"
mkdir -p "$plugin" "$vault/tachylite-corpus" "$vault/Folder" "$work/config/obsidian"
cp tools/obsidian-dump/main.js tools/obsidian-dump/manifest.json "$plugin/"
cp tools/obsidian-dump/corpus/*.md "$vault/tachylite-corpus/"
printf '# Welcome\n\nSome text.\n' > "$vault/Welcome.md"
printf '# Inside a folder\n' > "$vault/Folder/Inside.md"
# Open this vault at start (Obsidian reads its vault list from the config dir).
printf '{"vaults":{"tachyref0000000001":{"path":"%s","ts":%s,"open":true}}}' "$vault" "$(date +%s)000" > "$work/config/obsidian/obsidian.json"

"$bin" --no-sandbox --ozone-platform=x11 --disable-gpu --remote-debugging-port="$port" --user-data-dir="$work/config/obsidian" >"$work/obsidian.out" 2>&1 &
app=$!

OBSIDIAN_EVAL="${OBSIDIAN_EVAL:-}" node tools/obsidian-dump/drive.mjs "$port" || { echo "driving Obsidian failed; app output:" >&2; tail -20 "$work/obsidian.out" >&2; exit 1; }

# OBSIDIAN_EVAL=file.js: only evaluate that JavaScript inside Obsidian and print the result (for exploring its API).
if [ -n "${OBSIDIAN_EVAL:-}" ]; then exit 0; fi

for _ in $(seq 1 300); do
  [ -s "$vault/tachylite-reference.json" ] && break
  sleep 0.2
done
[ -s "$vault/tachylite-reference.json" ] || { echo "the dump file never appeared" >&2; tail -20 "$work/obsidian.out" >&2; exit 1; }
mkdir -p compat
cp "$vault/tachylite-reference.json" compat/obsidian-reference.json
echo "wrote compat/obsidian-reference.json ($(wc -c < compat/obsidian-reference.json) bytes)"
