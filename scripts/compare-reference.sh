#!/usr/bin/env bash
# Compare Tachylite with a dump from a real Obsidian (compat/obsidian-reference.json, made by tools/obsidian-dump).
# Prints the reports for the metadata cache (Rust) and for commands, menus, core plugins and config (UI).
# TACHYLITE_STRICT_REFERENCE=1 makes any difference a failure.
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

if [ ! -f compat/obsidian-reference.json ]; then
  echo "compat/obsidian-reference.json not found." >&2
  echo "Produce it with the plugin in tools/obsidian-dump (steps in its README), then copy it here." >&2
  exit 2
fi

echo "==> metadata cache (Rust core)"
cargo test -p tachylite-core --test reference -- --nocapture --test-threads=1 metadata_cache_matches_the_obsidian_reference

echo
echo "==> commands, hotkeys, core plugins, config and menus (UI)"
(cd ui && bun run test:debug test/compat.reference.test.ts)

echo
echo "Reports: compat/reference-report-cache.txt and compat/reference-report.txt"
