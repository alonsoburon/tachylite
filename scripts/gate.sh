#!/usr/bin/env bash
# The full local gate: everything CI's lint/test job checks, stopping at the first failure.
# Usage: scripts/gate.sh        (also used by scripts/ship.sh)
set -euo pipefail

cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"

step() { printf '\n==> %s\n' "$*"; }

step "cargo fmt --check"
cargo fmt --all --check

step "cargo clippy"
cargo clippy --workspace --all-targets -- -D warnings

step "cargo test"
cargo test --workspace

step "ui: typecheck"
(cd ui && bunx tsc --noEmit)

step "ui: tests"
(cd ui && bun run test)

printf '\nGATE PASSED\n'
