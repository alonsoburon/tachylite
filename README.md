# Tachylite

**A free and open-source desktop app, written in Rust, that aims to be a 1:1 compatible
alternative to [Obsidian](https://obsidian.md).** Open the same vault folder, get the same notes,
links and settings, and run the same community plugins and themes.

> **Status: early, pre-1.0.** It runs and is usable on Linux, but it is *not yet* a drop-in
> replacement. "1:1 compatible" is the goal, not a claim. See [Known gaps](#known-gaps).

## Goals

- **Same vault, no lock-in.** A vault is a plain folder of Markdown files plus a `.obsidian/`
  config directory. Tachylite reads and writes that format, so you can switch back and forth.
- **Same link behavior.** `[[wikilinks]]`, embeds, aliases, heading/block subpaths, tags,
  frontmatter, backlinks and automatic link updating on rename, resolved with the same rules.
- **Community plugins and themes.** Installs from the public community catalog and runs
  plugins written for the Obsidian plugin API (a compatible implementation of the API lives in
  `ui/src/obsidian`).
- **Free software, Rust core.** MIT licensed. The vault engine, plugin distribution and
  desktop shell are Rust ([Tauri 2](https://tauri.app)); the editor and plugin runtime run in a
  webview because community plugins are DOM/JavaScript code.

## Legal and provenance — please read

Tachylite is an **independent project. It is not affiliated with, endorsed by, or sponsored by
Obsidian / Dynalist Inc.** "Obsidian" is a trademark of its owner and is used here only to
describe compatibility.

- **No Obsidian code, CSS, icons, fonts, translations or other assets are included.** Everything
  in this repository is original work, except third-party open-source dependencies under their
  own licenses.
- **What it is built from:** the open, documented file formats (Markdown, YAML frontmatter,
  JSON config), the public plugin API type definitions (`obsidian` on npm, MIT), the public
  community catalog and release layout on GitHub, and observed application behavior.
- **Transparency about method:** to match behavior (link resolution rules, config file names
  and defaults, the plugin install protocol, DOM class names and CSS variable names that themes
  rely on), the maintainer studied the distributed desktop app, including static analysis of
  its JavaScript with [REA](https://github.com/morluto/rea), strictly for interoperability.
  This is **not** a certified clean-room implementation, and we don't claim it is. Behavioral
  facts and names were taken; code, styling and assets were not. Implementations are written
  from scratch.
- **Interoperability only.** There is no DRM or licensing circumvention, and nothing here
  touches Obsidian's paid services (Sync, Publish). Those are out of scope.
- Obsidian's own terms may restrict how you use or analyze its software. This is not legal
  advice; if you contribute, you are responsible for complying with the terms that apply to you.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules contributors must follow.

## Layout

| Path | What |
|---|---|
| `crates/tachylite-core` | Vault index, markdown metadata (links, tags, headings, blocks, frontmatter), link resolution, backlinks, search, `.obsidian` config |
| `crates/tachylite-plugins` | Community plugin/theme catalog, install, enable, version fallback |
| `crates/tachylite-cli` | `tachy`: headless inspection and plugin management |
| `crates/tachylite-app` | Tauri shell: the commands between the core and the webview |
| `ui/src/obsidian` | Implementation of the `obsidian` module for plugins, plus the plugin loader |
| `ui/src/markdown`, `ui/src/editor` | Reading-view renderer and CodeMirror 6 Live Preview |
| `ui/src/app` | Layout, core views, settings, community plugin browser |

## Build and run

Needs Rust, Node 20+, and on Linux WebKitGTK 4.1 (`webkit2gtk-4.1`). Only Linux has been run so far.

```
cd ui && npm install --legacy-peer-deps && npm run build
cd .. && cargo run -p tachylite-app                  # vault picker
cargo run -p tachylite-app -- --vault /path/to/vault # open a vault directly
cargo test --workspace && (cd ui && npx vitest run)
```

Community plugins start in restricted mode, as in Obsidian, until enabled in Settings.
`tachy <vault> plugin-search <query>` and `plugin-install <id>` work headlessly.

## Known gaps

Implemented but young (covered by tests; most were exercised in the real window only briefly, so
expect bugs): Canvas (`.canvas`), Bases (`.base`: table, cards and list views, partial formula
language), editable tables, Dataview-style inline and block widgets in Live Preview, code
syntax highlighting, Vim mode, popout windows, OS trash, Templates, Daily notes, Properties,
Note composer, File recovery, Workspaces, `tachylite://` links, and an opt-in Node bridge
(`child_process`, real `fs`) so desktop-only plugins can run. The Node bridge gives plugins full
user permissions, as Obsidian does, and sits behind a confirmation.

Still missing or unverified:

- Hover page previews and the local graph view (and graph filters/groups) are not implemented.
- `obsidian-git`, `omnisearch` and Excalidraw have not been verified end to end.
- Plugin compatibility is checked by loading real bundles in tests; that shows they load, not
  that every feature works. Report breakage as issues with the plugin id and version.
- Bases formulas and some Canvas details are incomplete.
- Packaging and CI are configured for Linux, macOS and Windows, but only Linux has been run.
- Sync and Publish are out of scope.

## License

[MIT](LICENSE).
