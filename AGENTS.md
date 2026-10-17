# Instructions for coding agents

These are the working conventions for this repo. [CONTRIBUTING.md](CONTRIBUTING.md) has the hard legal rules
(no Obsidian code or assets) and applies to everyone; read it first.

## Loop

- Pick the top unblocked item in [ROADMAP.md](ROADMAP.md). If none is left, or the next step needs data only a
  real Obsidian can give, stop and say so instead of guessing.
- `scripts/gate.sh` runs the full local gate (fmt, clippy, cargo test, ui typecheck, ui tests). `scripts/ship.sh
  "message"` runs it, commits, pushes and waits for the CI run of that commit. Both stop on the first failure.
- Commit messages are plain and carry no trailers or attribution. Commit as the repo's configured author.

## Tooling

- bun for the UI (`bun install`, `bun run test`), never npm. Node is only there because Vitest runs on it.
- `bun run test:debug <file>` shows console output from tests (Vitest hides it for passing tests in some
  environments).
- Cargo may not be on a non-login shell's PATH: `export PATH="$HOME/.cargo/bin:$PATH"` (the scripts do it).
- Do not capture or touch the user's desktop. Anything that needs a display uses its own Xvfb or headless compositor.

## Honesty

- Say which kind of evidence you have: "tested in happy-dom" is not "checked in the real window", and neither is
  "matches Obsidian". Command ids, hotkeys and menu entries written from memory are guesses until compared with
  `compat/obsidian-reference.json` (see `tools/obsidian-dump/README.md`, `scripts/compare-reference.sh`).
- Do not claim 1:1 compatibility. It is the goal, not a claim.
- The README is casual in tone but its legal and factual statements stay accurate (not affiliated with Obsidian,
  no Obsidian code or assets, the static-analysis disclosure).

## Releases

Publishing a release needs the user's explicit approval each time.
