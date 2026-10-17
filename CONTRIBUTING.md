# Contributing

Thanks for helping. This project is only useful if it stays legally clean, so these rules are firm.

## Hard rules

1. **Do not submit code, CSS, icons, fonts, translations or text copied or closely transliterated
   from Obsidian's proprietary application** (including its minified bundles), or from any
   decompiler output of it. Pull requests containing such material will be closed.
2. **Facts are fine, expression is not.** Public documentation, the `obsidian` typings, file
   formats, config key names, CSS variable and class names, and observable behavior can all be
   used. Write the implementation yourself.
3. **Disclose how you learned a behavior** in the PR if it came from analyzing the app, so it can be
   reviewed. Prefer docs, typings and black-box observation (inputs and outputs) over reading source.
4. **No circumvention.** No DRM/licence bypass, and nothing that accesses Obsidian's paid services.
5. Third-party code must be compatibly licensed and noted in the PR.

## Development

```
cargo test --workspace && cargo clippy --workspace --all-targets
cd ui && bun run typecheck && bun run test && bun run build
```

### The gate and shipping

`scripts/gate.sh` runs everything the CI lint/test job checks and stops at the first failure.
`scripts/ship.sh "message"` runs the gate, commits (the message as given, no trailers), pushes, waits for the
CI run of that commit and exits non-zero unless every job is green. `--no-push` stops after the commit.
Pick work from [ROADMAP.md](ROADMAP.md).

### The UI tests run the real Rust parser

`ui/test/helpers/backend.ts` is a fake desktop backend (file system and the rest), but note parsing and link
resolution come from `tachylite-core`: the vitest global setup runs `cargo build -p tachylite-cli`, and the helper
calls `tachy parse-json` (one note on stdin) and `tachy <vault> links-json`. So the UI tests need a Rust toolchain,
and a behavior that only exists in Rust (UTF-16 offsets, Unicode link matching, sections, list items) is visible
to them. `ui/test/helpers.real-core.test.ts` proves it.

### Seeing console output in tests

Vitest hides console output from passing tests in some environments (it does so when it detects an automated
agent). `bun run test:debug test/some.test.ts` runs with `--silent=false`, so `console.log` probes show up
without writing to files.

### Flaky tests we already know about

- **CodeMirror's 20 ms parse budget.** A state built without a view can end up with a partial syntax tree on a
  busy machine, so tests that read decorations flake under load. Build the state again until
  `syntaxTree(state).length >= doc.length` (see `mkstate` in `ui/test/editor.lp-extras.test.ts`).
- **Late CodeMirror timers.** A timer can fire after its test's happy-dom window is gone
  (`requestAnimationFrame is not a function`). `vite.config.ts` ignores exactly that error, and sessions detach
  their leaves in `dispose()` so most timers never fire.
- **happy-dom gaps.** `WheelEvent` ignores `ctrlKey`/`metaKey` in its init dict (define them on the event by
  hand), `posAtCoords` returns 0 (stub it), and there is no `indexedDB` (the "file recovery unavailable" line in
  test output is expected). `Proxy` objects in the app graph break vitest's deep equality, so use a `Map`
  subclass instead.
- **Layout saves are debounced.** Waiting for `workspace.json` needs `vi.waitFor(..., { timeout: 8000 })`.
- **Performance guards.** The graph timing test takes the best of several batches, because one slow batch on a
  loaded machine is not a regression.

Compatibility bugs are the most valuable contributions: a vault that behaves differently, or a
community plugin that fails to load. Include the plugin id/version and a minimal vault if you can.
