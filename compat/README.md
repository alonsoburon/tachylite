# Compatibility fixtures

Black-box fixture vaults with the behaviour Obsidian is expected to show on them. They are run by
`crates/tachylite-core/tests/compat.rs` (`cargo test -p tachylite-core --test compat`; set
`COMPAT_FIXTURE=<name>` to run one). Each fixture is a folder:

```
<name>/vault/...        the vault (copied to a temp dir before every run)
<name>/expected.json    what to check
```

## `expected.json`

All sections are optional.

| Key | Checks |
|---|---|
| `resolve` | `[{link, from, to}]`: `getFirstLinkpathDest(linkpath(link), from)`; `to: null` = unresolved |
| `metadata` | `{path: CachedMetadata}` compared as a **subset**: only keys written are checked, arrays must have the same length and match element-wise, `null` means "absent". Positions can be partial (`{"start": {"line": 3}}`). |
| `resolvedLinks` / `unresolvedLinks` | exact `{target: count}` maps for the listed source notes |
| `fileTags` | tags of a note including frontmatter `tags`/`tag`, as the tag pane and `tag:` search count them |
| `subpath` | `[{file, subpath, expect}]`: `resolveSubpath` result as a subset, `expect: null` = no match |
| `linktext` | `[{target, source, config?, expected}]`: `fileToLinktext` under `app.json` overrides |
| `rename` | `[{steps: [[from, to], ...], config?, files, resolve?, unresolvedLinks?}]`: renames with link updating on, then compares file contents (`null` = file must not exist) |

Entries may carry `confidence` (`high` when unmarked) and `why`. Keys starting with `//` are comments.

## Where the expectations come from

From the public plugin API typings (`obsidian.d.ts`: `CachedMetadata`, `ListItemCache.parent`,
`Reference.displayText`, `SectionCache.type`), the help site, the CommonMark and GFM specs (Obsidian's
metadata parser is CommonMark/GFM based: section types are mdast node names such as `thematicBreak`), and facts
about observable app behaviour noted during interoperability work (link resolution order, block id keys,
which frontmatter values count as links). **High** means documented or unambiguous; **medium** means
consistent with observed behaviour but not documented, so a real-Obsidian check would be welcome.
Corrections from people who compare against a real Obsidian install are the most useful contribution here.

## Fixtures

| Fixture | Asserts | Confidence |
|---|---|---|
| `link-resolution` | unique names from anywhere, case-insensitivity (incl. Unicode), explicit `.md`, exact vault paths beat same-folder matches, duplicates (source folder first, then shortest path), path-suffix links (plain string suffix, not segment-aware), `./` `../` `./../`, rooted `/Note`, attachments need their extension, dotted names, folders are not targets, `#subpath` ignored, `[[#heading]]` resolves to the source | high, except duplicate ordering, suffix/prefix quirks, rooted paths and Unicode case (medium) |
| `links-metadata` | `links`/`embeds` entries: `link`, `original`, `displayText` (`![](x)` has `""`), `[[a\|b\|c]]` alias keeps later pipes, percent-decoded and `<angle>` markdown destinations, titles dropped, embeds with size, links in headings, callouts, quotes and `%%comments%%` count; inline code (multi-backtick), escapes, `[[]]`, unclosed, external/`mailto:` URLs, `$$` blocks and `$inline math$` do not; positions in UTF-16 | high; comments, inline math and `#local` markdown links medium |
| `tags` | tag characters (letters incl. Unicode, digits, `_`, `-`, `/`), all-digit `#2024` is not a tag, `a#b`, URL fragments, entities, escapes and code are not tags, tags stop at `.` `,` `:`; tags in headings, lists, tables; frontmatter `tags` list / comma string / `tag`, `#` prefix kept as written in frontmatter | high |
| `headings` | ATX with closing `#`s and extra spaces, 0-3 space indent, `#NoSpace` is a tag, 7 hashes and `\#` are text, 4-space indent is code, setext `===`/`---` (heading starts at the text line), section list | high |
| `code-math` | backtick, tilde, nested longer and unclosed fences, indented code after a blank line, list continuation lines are not code, `$$` math sections | high |
| `lists-tasks` | `parent` line numbers (negative first line for roots), tab and space nesting, siblings with different indents, task chars ` x X / -`, a new list starts when the bullet char or ordered delimiter changes, blank lines inside a list, list item block ids (block position is the item), lists inside quotes | high; lists in quotes medium |
| `blocks` | block keys lowercased with `id` as written, only a trailing `^id` on the last line counts, `^id` on its own line after a quote or table names that block, `_` is not an id character | high; own-line ids medium (the block's exact range is not asserted) |
| `frontmatter` | YAML types (dates stay strings), `frontmatterPosition`, frontmatter links only for whole-value `"[[x]]"` / `"[t](x)"` strings with dotted keys (`related.0`, `nested.key`) and `displayText`, frontmatter not at line 0 is a thematic break + setext heading, CRLF, invalid YAML gives no frontmatter | high; invalid YAML medium |
| `callouts` | a callout or quote is one section including body lines, list items, lazy continuation lines and nested `> >` quotes; a new `[!type]` after a blank line starts a new callout | high |
| `tables` | tables with and without leading pipes (header + delimiter row with matching cell count), `\|` inside a wikilink in a cell is the alias separator, "a \| b" without a delimiter row is a paragraph | high |
| `unicode-positions` | `col`/`offset` count UTF-16 code units (astral emoji = 2), resolution of CJK names | high |
| `subpaths` | `#Heading` case-insensitive, `#A#B` must be nested, `next`/`end`, `#^block` case-insensitive, punctuation-insensitive heading match | high; punctuation folding medium |
| `linktext` | `shortest` (bare name unless ambiguous or shadowed by a root note), `relative` (`../`), `absolute`, attachments keep their extension | high |
| `rename` | renaming a note rewrites wikilinks (aliases and subpaths kept, case variants included), embeds, markdown links (`%20`, relative ones regenerated in the configured format) and frontmatter links; moving a note keeps shortest links; renaming a folder updates links to every file inside (regenerated, so `[[Folder/In]]` becomes `[[In]]` when unique); links inside a moved note that would break are regenerated | high for the first case; regeneration of folder-qualified and moved-note links medium |

## Not covered yet

Inline footnotes and footnote definitions, reference links (`[x][id]` / `[id]: url`), HTML blocks in
detail, tables inside quotes, links in canvas files, `userIgnoreFilters`, and two files whose names differ
only by case (behaviour depends on the file system).
