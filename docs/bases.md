# Bases

Tachylite implements the Bases core plugin (`.base` files) in `ui/src/bases/`. This page says what works and what
does not, so nobody has to guess. Behaviour was matched against the public help pages (help.obsidian.md/bases and
its sub-pages) and the `obsidian` typings; the summaries below are written for this project.

## Files and where bases show up

- A `.base` file is YAML with `filters`, `formulas`, `properties`, `summaries` and `views`. Keys Tachylite does not
  know (plugin options, future keys) are kept when the UI writes the file back. YAML comments and the original
  quoting are not kept: the file is re-serialized.
- Opening a `.base` file uses the `bases` view. "Edit source" (the `</>` button in the view header) shows the raw YAML.
- `![[File.base]]` embeds the first view, `![[File.base#View name]]` a named one, in Reading view and Live Preview.
  Toolbar changes made in an embed are written to the `.base` file.
- A fenced `base` code block renders an inline base. Toolbar changes there stay in memory (not written to the note).
- `this` is the base file when the base is opened directly, and the embedding note for embeds and code blocks.
  Bases in the sidebar (where `this` is the active file) are not supported yet.
- Commands: `bases:new-file` (Create new base, makes `Untitled.base` next to the active file), `bases:insert`
  (Insert new base: create one and embed it at the cursor), `bases:add-view`. There is a ribbon button and a
  "New base" item in the folder context menu.
- Results refresh (debounced, 250 ms) when notes, metadata or files change.

## Views

| Layout | Status |
|---|---|
| Table | Column per property, header click cycles ascending/descending/no sort, drag the header edge to resize (stored as `columnSize`), right-click a header for sort, summaries and hide. Note-property cells are editable (text input; checkbox for booleans; comma-separated input for lists) and are written with `FileManager.processFrontMatter`. Group headings and a summary footer. Row height option. No cell selection, keyboard navigation, copy/paste or undo. |
| Cards | Grid with an optional cover from an image property (local attachment link, URL or hex colour), card size, image fit and aspect ratio options. |
| List | Bullets, numbers or no markers; properties inline with a separator or indented. |
| Kanban, Map | Not implemented: a warning is shown and the view falls back to a table. |
| Plugin views | `Plugin.registerBasesView(id, { name, icon, factory, options })` works. The factory gets the controller and the container; `BasesView` exposes `app`, `config`, `data`, `allProperties`, `onDataUpdated()`, `createFileForView()`. Options declared by the registration appear in View settings (text, dropdown, toggle, slider, property, multitext, formula, file, folder, groups). |

Toolbar: view switcher (switch, add, delete, view settings with name/layout/limit/options), result count (copy
as tab-separated text, export CSV), Sort and group dialog, Filter dialog, Properties dialog (visibility, order,
display names, add/edit/delete formulas), New (creates a note and opens it). The filter dialog edits each filter
as YAML and has an "Add condition" field; there is no point-and-click condition builder. No search field, no
group collapsing, no manual group-order editor (a `groupOrder` written by hand is honoured).

## Query semantics

- Every file in the vault is a row (attachments too) until filtered. Global and view filters are combined with AND.
  `and`, `or`, `not` (= none of the following) nest; a statement that fails to evaluate counts as false.
- Sort: multiple keys; empty values go last in both directions. Without a sort, rows are in path order.
- `limit` is applied after sorting. `groupBy` with `ASC`/`DESC`; entries without a value form the last group.
- Frontmatter wikilinks become links; strings in ISO date form (`2025-01-31`, `2025-01-31T10:00`) become dates unless
  `.obsidian/types.json` marks the property as text. Property names match case-insensitively.

## Expression language coverage

Implemented by our own tokenizer, parser and evaluator (`expr.ts`, `evaluate.ts`).

| Area | Item | Implemented |
|---|---|---|
| Literals | strings (single/double quotes), numbers, `true`/`false`, `null`, lists `[..]`, objects `{..}`, regex `/../flags` | yes |
| Access | `note.x`, bare `x`, `note["x"]`, `file.x`, `formula.x` (with cycle detection), `this`, `this.file`, `[index]` | yes |
| Operators | `+ - * / %`, `( )`, `== != > < >= <=`, `! && \|\|` | yes |
| Date arithmetic | date ± duration string (`"1M"`, `"2h"`, `"1 day"`, units y/M/w/d/h/m/s and words), date − date = milliseconds, date comparisons | yes |
| Durations | `duration()` × / ÷ number, + duration; ISO 8601 (`P1DT2H`) also accepted | yes |
| Global | `escapeHTML`, `date`, `duration`, `file`, `html`, `if`, `image`, `icon`, `link`, `list`, `max`, `min`, `now`, `number`, `today` | yes |
| Global | `random` | partial: a new number per evaluation, not per view load |
| Any | `isTruthy`, `isType`, `toString` | yes |
| Date | fields `year month day hour minute second millisecond`; `date`, `format`, `time`, `relative`, `isEmpty` | yes |
| String | `length`; `contains`, `containsAll`, `containsAny`, `endsWith`, `isEmpty`, `lower`, `replace` (string = all occurrences, regex honours `g` and `$1`), `repeat`, `reverse`, `slice`, `split` (string or regex, optional count), `startsWith`, `title`, `trim` | yes |
| Number | `abs`, `ceil`, `floor`, `isEmpty`, `round` (optional digits), `toFixed` | yes |
| List | `length`; `contains`, `containsAll`, `containsAny`, `filter`, `flat`, `isEmpty`, `join`, `map`, `reduce` (with `value`, `index`, `acc`), `reverse` (returns a copy), `slice`, `sort`, `unique` | yes |
| Link | `asFile`, `linksTo`; links equal files/links that resolve to the same file | yes |
| File | fields `name basename path folder ext size properties tags links ctime mtime`, plus `backlinks`, `embeds`, `file`; `asLink`, `hasLink`, `hasProperty`, `hasTag` (includes nested tags), `inFolder` (includes sub-folders) | yes |
| Object | `isEmpty`, `keys`, `values` | yes |
| Regular expression | `matches` | yes |
| Summaries | Average, Min, Max, Sum, Range (numbers and dates), Median, Stddev (population), Earliest, Latest, Checked, Unchecked, Empty, Filled, Unique; custom summaries over `values` | yes |
| Extras | `list.mean()`/`average()`, `sum()`, `min()`, `max()`, `median()` (used by summary formulas such as `values.mean()`, which the syntax page shows) | yes, not on the functions page |
| Plugins | plugin-added formula functions | no (no public API for it) |
| Editor | formula autocomplete | no; the Properties dialog only validates syntax |

Errors inside formulas render as "Error" in the cell (the message is in the tooltip); `BasesEntry.getValue`
returns an error value instead of throwing.
