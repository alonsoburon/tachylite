# Node bridge for desktop plugins

Community plugins run in the webview, which has no Node.js. Plugins such as obsidian-git (simple-git spawns `git`) or
Templater (system commands, user scripts) need `child_process` and unconfined `fs`. Tachylite provides them through
a bridge to the Rust shell (`crates/tachylite-app/src/bridge.rs`, `ui/src/obsidian/nodeBridge.ts`).

## When it is on

Both conditions must hold, and the Rust side checks them on every call:

1. Community plugins are turned on (restricted mode off).
2. The user turned on **Settings > Community plugins > Allow plugins to run programs and access files outside the
   vault** and accepted the warning that plugins then run with the full permissions of their user account.

The choice is stored per vault and per computer in `<app config dir>/node-bridge.json` (on Linux
`~/.config/app.tachylite.desktop/node-bridge.json`), not inside the vault: a vault that is synced, cloned or
downloaded can never grant itself process access on another machine. Turning the switch off (no confirmation),
or turning on restricted mode, stops every running child process and watcher; plugins are reloaded on every change.

While off, `require("child_process")` still works but every call throws `ERR_BRIDGE_DISABLED` (with a one-time
notice), `fs` stays confined to the vault, and `process.env` is empty.

## What plugins get

- `child_process`: `spawn`, `exec`, `execFile` (callback and `util.promisify`, which resolves `{ stdout, stderr }`),
  `execSync`, `execFileSync`, `spawnSync`. `shell` runs `/bin/sh -c` (Unix) or `cmd.exe /d /s /c "..."` (Windows);
  `cwd`, `env` (replaces the environment, defaults to `process.env`), `stdio`, `timeout`, `killSignal`, `maxBuffer`,
  `encoding: "buffer"`, `signal` are honoured. `ChildProcess.pid` is set once the spawn request returns (Node sets
  it synchronously). `fork` is not supported.
- `fs`, `fs/promises`: promise, callback and `Sync` forms of readFile, writeFile, appendFile, readdir
  (`withFileTypes`), stat, lstat, access, exists, mkdir (`recursive`), rm, rmdir, unlink, rename, copyFile, cp,
  realpath, readlink, symlink, chmod, truncate, utimes, mkdtemp; `watch` / `promises.watch`; minimal
  `createReadStream` / `createWriteStream`. File-descriptor APIs (`open`, `read`, `FileHandle`) throw; `watchFile`
  never fires. Errors carry Node's `code`, `errno`, `syscall`, `path`.
- `process.platform`, `arch`, `pid`, `env` (the app's real environment) and `os.homedir()`, `tmpdir()`,
  `hostname()`, `EOL`, `userInfo()` report real values. `electron.shell.openPath` / `showItemInFolder` open files
  with the system handler.

`process.cwd()` is the vault root. Relative paths given to `fs` resolve against it and child processes start in it
by default. (Obsidian's own working directory is unrelated to the vault, so plugins already use absolute paths from
`FileSystemAdapter.getBasePath()`.)

Synchronous calls use a synchronous XHR to the `tachylite-bridge://` URI scheme, authenticated with a random token
created per app session and handed to the page only while the bridge is active.

## Security notes

This is the same trust model as Obsidian: enabled plugins are trusted code. The switch makes that explicit, and the
Rust gate means nothing in the webview can spawn processes or touch files outside the vault while it is off or in
restricted mode. Turning the switch on additionally needs a native OS confirmation dialog shown by the Rust side
(after the in-app explanation), which code in the webview cannot answer, so a script in a note or a plugin cannot
grant itself access silently. (Debug builds run with `TACHYLITE_DEV=1` skip that dialog for automation.) It does not
sandbox plugins once it is on: a malicious plugin you chose to run has your user's permissions, as in Obsidian.
