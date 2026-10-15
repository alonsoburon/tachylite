# Tachylite

An open-source, Rust-based desktop app that tries to be a drop-in replacement for
[Obsidian](https://obsidian.md). Point it at the same vault folder and you get the same notes,
links and settings, and the same community plugins and themes should just work.

> **Heads up: this is early.** It runs and is usable on Linux, but it is not a drop-in
> replacement yet. "1:1 compatible" is the goal, not something I'm claiming. The
> [known gaps](#known-gaps) section is long and I tried to be honest about it.

## Why

I wanted an Obsidian-compatible app I could read, hack on and ship myself, without giving up the
vault format or the plugin ecosystem. So:

- **Your vault is just a folder.** Markdown files plus a `.obsidian/` config dir. Tachylite reads
  and writes the same format, so you can open a vault in either app and switch back and forth.
- **Links resolve the same way.** Wikilinks, embeds, aliases, heading and block subpaths, tags,
  frontmatter, backlinks, and rewriting links when you rename a file, all following the same rules.
- **Community plugins and themes.** It installs from the public catalog and runs plugins written
  against the Obsidian plugin API. The API shim lives in `ui/src/obsidian`.
- **MIT, Rust core.** The vault engine, plugin installer and desktop shell are Rust
  ([Tauri 2](https://tauri.app)). The editor and plugin runtime live in a webview, because
  community plugins are DOM and JavaScript and there's no way around that.

## Legal stuff, read this part

Tachylite is an independent project. It is **not affiliated with, endorsed by, or sponsored by
Obsidian / Dynalist Inc.** "Obsidian" is their trademark and I only use it to say what this is
compatible with.

- **There is no Obsidian code, CSS, icons, fonts, translations or other assets in this repo.**
  Everything here is original, apart from third-party open-source dependencies under their own
  licenses.
- **What it's built from:** open file formats (Markdown, YAML frontmatter, JSON config), the public
  plugin API typings (the `obsidian` package on npm, MIT), the public community catalog and
  release layout on GitHub, and watching how the app behaves.
- **How I matched behavior, plainly:** to get link resolution, config file names and defaults,
  the plugin install flow, and the DOM class names and CSS variables that themes depend on, I
  read through the shipped desktop app, including static analysis of its JavaScript with
  [REA](https://github.com/morluto/rea). That was strictly for interoperability. This is **not** a
  certified clean-room implementation and I'm not going to pretend it is. Facts and names were
  taken; code, styling and assets were not, and everything is written from scratch.
- **Interop only.** No DRM or licensing circumvention, and nothing touches Obsidian's paid
  services (Sync, Publish). Those are out of scope.
- Obsidian's terms may restrict how you use or analyze their software. This isn't legal advice,
  and if you contribute, complying with the terms that apply to you is on you.

Contributor rules are in [CONTRIBUTING.md](CONTRIBUTING.md). The short version: don't copy their
code or assets, ever.

## What's where

| Path | What |
|---|---|
| `crates/tachylite-core` | Vault index, metadata parsing (links, tags, headings, blocks, frontmatter), link resolution, backlinks, search, `.obsidian` config |
| `crates/tachylite-plugins` | Community plugin and theme catalog, install, enable, version fallback |
| `crates/tachylite-cli` | `tachy`, a headless CLI for poking at vaults and managing plugins |
| `crates/tachylite-app` | The Tauri shell: glue between the core and the webview |
| `ui/src/obsidian` | The `obsidian` module for plugins, plus the plugin loader |
| `ui/src/markdown`, `ui/src/editor` | Reading view renderer and the CodeMirror 6 Live Preview |
| `ui/src/app` | Layout, core views, settings, community plugin browser |
| `compat/` | Black-box fixtures checked by Rust tests |

## Build and run

You need Rust, bun, Node 20+, and on Linux the WebKitGTK 4.1 and GTK 3 dev packages
(`webkit2gtk-4.1` and friends; on Fedora that's `webkit2gtk4.1-devel gtk3-devel libsoup3-devel`).
Only Linux has actually been run so far.

```
cd ui && bun install && bun run build
cd .. && cargo run -p tachylite-app                  # vault picker
cargo run -p tachylite-app -- --vault /path/to/vault # open a vault directly
cargo test --workspace && (cd ui && bun run test)
```

The UI uses [bun](https://bun.sh) for installs and scripts (Node is still needed because Vitest runs on it).

Community plugins start in restricted mode like in Obsidian, until you enable them in Settings.
`tachy <vault> plugin-search <query>` and `tachy <vault> plugin-install <id>` work headlessly.

Prebuilt Linux AppImage and `.deb` builds are on the
[releases page](https://github.com/alonsoburon/tachylite/releases).

## Known gaps

**What exists, but is young.** It has tests and I've clicked around in the real Linux window, but
expect rough edges: Canvas (`.canvas`), Bases (`.base` with table, cards and list views, and only
part of the formula language), editable tables, Dataview-style inline and block widgets in Live
Preview, syntax highlighting, Vim mode, popout windows, OS trash, Templates, Daily notes,
Properties, Note composer, File recovery, Workspaces, Page preview (hover popovers, nested,
per-source Ctrl/Cmd setting, plus the `hover-link` API that Hover Editor builds on), the graph view
(global and local, filters, color groups, display and force settings in `graph.json`, still
interactive at 5k notes), `tachylite://` links, and an opt-in Node bridge (`child_process`, real
`fs`) so desktop-only plugins can run. The bridge gives plugins your full user permissions, same as
Obsidian, and sits behind a confirmation.

**Community plugins I've run end to end in the real window** (current releases): obsidian-git
(status, stage, commit, history, via the Node bridge), Excalidraw (create, edit, reopen, embed),
Omnisearch (index, search modal, in-file search), Calendar, Templater (templates with user
scripts), Dataview (queries and inline queries, in Live Preview and reading view), Tasks (queries,
completing tasks), Kanban (boards, adding cards), QuickAdd (capture choices) and Hover Editor.

**Still missing or unverified:**

- Omnisearch's local HTTP server can't listen, since there are no sockets in a webview. The rest
  of the plugin works.
- Templater's `<% %>` syntax highlighting is off. Obsidian's editor uses a CM5-mode parser that
  Templater overlays; ours is a Lezer parser, so its highlighter gets ignored.
- The graph is drawn on a 2D canvas (Obsidian uses WebGL). I measured it at 5k notes; bigger
  vaults lay out slower.
- Any plugin not listed above is only known to *load* (tests load real bundles), not to work in
  every corner. If one breaks, file an issue with the plugin id and version.
- Bases formulas and some Canvas details are incomplete.
- CI builds for Linux, macOS and Windows, but only Linux has been run by a human.
- Sync and Publish are out of scope.

## License

[MIT](LICENSE).
