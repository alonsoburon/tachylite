# File recovery

The File recovery core plugin (`file-recovery`, on by default) keeps snapshots of edited notes so older versions
can be viewed, copied and restored. Code: `ui/src/app/core/fileRecovery.ts`.

## Options

Stored in `.obsidian/file-recovery.json` with Obsidian's keys:

| Key | Default | Meaning |
|---|---|---|
| `intervalMinutes` | `5` | Minimum time between two snapshots of the same file (`0` = every save). |
| `keepDays` | `7` | Snapshots older than this are deleted (at startup and when the value changes). |

Settings > File recovery also has **Snapshots: View** (opens the browser) and **Clear history**.

## When snapshots are taken

- On every save (`vault.on("modify")`) of a `.md` or `.canvas` file, if the newest snapshot of that path is older
  than the interval. Saves inside the interval are remembered and snapshotted once the interval has passed
  (checked every 30 seconds).
- Content identical to the newest snapshot is not stored again.
- Before **Restore** overwrites a file, its current content is snapshotted, so a restore can be undone.
- Renaming a file moves its snapshots to the new path. Deleting a file keeps them: a deleted note can be restored.

## Storage

Snapshots live **outside the vault**, in the IndexedDB of the app's webview, like Obsidian (which also keeps them in
IndexedDB rather than in the vault). Reasons:

- Snapshots must survive what happens to vault files (a sync tool or `git checkout` overwriting or deleting notes),
  and must not be synced, committed or indexed as vault content.
- No new backend command or file format is needed; IndexedDB handles indexing and pruning by time.

Layout: one database per vault named `tachylite-backup:<absolute vault path>`, version 1, with one object store
`backups` (auto-increment keys) of records `{ path, ts, data }` (vault-relative path, epoch milliseconds, full text)
and indexes `path` and `ts`. The webview keeps IndexedDB under the app's data directory
(`$XDG_DATA_HOME/<app identifier>/` on Linux), so snapshots are per user and per machine.

Consequences:

- Moving or renaming the vault folder starts a new, empty history (the database name contains the path); the old
  database stays until the webview data is cleared.
- Obsidian's own snapshots (in Obsidian's IndexedDB) are not visible here, and the other way around.

## The browser

`file-recovery:open` ("Open local file history") opens the modal on the active file; the settings button opens it
on the most recently snapshotted file. Left: files with snapshots (searchable; deleted files are marked). Middle:
versions of the selected file, newest first. Right: the selected version as text, or with **Show changes** a line
diff against the previous (older) snapshot. **Copy** puts the version on the clipboard; **Restore** writes it back
(recreating the file if it was deleted).
