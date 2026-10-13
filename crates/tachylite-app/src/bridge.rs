//! Node.js bridge for desktop community plugins: real (unconfined) file system access and child processes.
//!
//! Community plugins run in the webview, so Node's `fs` / `child_process` are emulated in `ui/src/obsidian/nodeBridge.ts`
//! on top of the commands below. Everything here is gated: the bridge only works while community plugins are on
//! (restricted mode off) AND the user accepted the "full permissions" warning for this vault. Consent is stored
//! per vault, outside the vault (`<app config dir>/node-bridge.json`), so a vault copied from elsewhere can never
//! grant itself process access; the gate is enforced here, not only in the UI.
//!
//! Synchronous Node APIs (`fs.readFileSync`, `execSync`...) use a sync XHR to the `tachylite-bridge` URI scheme,
//! authenticated with a random per-session token that is only handed out while the bridge is active.

// Node-shaped errors are only built on failure paths; boxing them would just add noise.
#![allow(clippy::result_large_err)]

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

type Res<T> = Result<T, String>;

/// Name of the custom URI scheme serving the synchronous channel.
pub const SCHEME: &str = "tachylite-bridge";
const DISABLED: &str = "ERR_BRIDGE_DISABLED: plugins are not allowed to run programs or access files outside the vault \
                        (Settings > Community plugins > Allow plugins to run programs and access files outside the vault)";

// ------------------------------------------------------------------ gate

#[derive(Default)]
struct GateState {
    /// Vault root the bridge was activated for (default cwd of processes, base of `process.cwd()`).
    root: Option<PathBuf>,
    active: bool,
}

/// Bridge state managed by Tauri.
pub struct Bridge {
    gate: Mutex<GateState>,
    token: String,
    procs: Mutex<HashMap<u64, Arc<Proc>>>,
    watchers: Mutex<HashMap<u64, notify::RecommendedWatcher>>,
}

impl Default for Bridge {
    fn default() -> Self {
        let mut b = [0u8; 24];
        // Should the OS RNG fail, fall back to std's randomly keyed SipHash (still unpredictable from the webview).
        if getrandom::fill(&mut b).is_err() {
            use std::hash::{BuildHasher, Hasher};
            for c in b.chunks_mut(8) {
                let mut h = std::collections::hash_map::RandomState::new().build_hasher();
                h.write_u128(std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos());
                c.copy_from_slice(&h.finish().to_le_bytes()[..c.len()]);
            }
        }
        Bridge { gate: Mutex::default(), token: b.iter().map(|x| format!("{x:02x}")).collect(), procs: Mutex::default(), watchers: Mutex::default() }
    }
}

impl Bridge {
    /// Default cwd when active; the error every gated command returns otherwise.
    pub fn check(&self) -> Res<PathBuf> {
        let g = self.gate.lock().map_err(|e| e.to_string())?;
        match (&g.root, g.active) {
            (Some(r), true) => Ok(r.clone()),
            _ => Err(DISABLED.into()),
        }
    }
    pub fn is_active(&self) -> bool {
        self.check().is_ok()
    }
    /// Turn the bridge on/off for `root`. Activation requires `consented`; deactivation stops every process and watcher.
    pub fn set_active(&self, root: &Path, active: bool, consented: bool) -> bool {
        let on = active && consented;
        if let Ok(mut g) = self.gate.lock() {
            g.root = Some(root.to_path_buf());
            g.active = on;
        }
        if !on {
            self.stop_all();
        }
        on
    }
    fn stop_all(&self) {
        if let Ok(mut w) = self.watchers.lock() {
            w.clear();
        }
        let procs: Vec<_> = self.procs.lock().map(|p| p.values().cloned().collect()).unwrap_or_default();
        for p in procs {
            let _ = p.kill(Some("SIGKILL"));
        }
    }
}

/// Vault roots whose user accepted the warning, in `file` (`{"vaults": [...]}`).
pub fn consent_load(file: &Path, root: &Path) -> bool {
    let key = root.to_string_lossy();
    fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("vaults").and_then(|a| a.as_array()).map(|a| a.iter().any(|x| x.as_str() == Some(&key))))
        .unwrap_or(false)
}

pub fn consent_save(file: &Path, root: &Path, enabled: bool) -> io::Result<()> {
    let key = root.to_string_lossy().into_owned();
    let mut list: Vec<String> = fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("vaults").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()))
        .unwrap_or_default();
    list.retain(|p| *p != key);
    if enabled {
        list.push(key);
    }
    if let Some(d) = file.parent() {
        fs::create_dir_all(d)?;
    }
    fs::write(file, serde_json::to_string_pretty(&json!({ "vaults": list }))?)
}

// ------------------------------------------------------------------ errors (Node's shape: code, errno, syscall, path)

#[derive(Serialize, Debug, PartialEq)]
pub struct NodeErr {
    pub code: String,
    pub errno: i32,
    pub message: String,
    pub syscall: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dest: Option<String>,
}

impl NodeErr {
    pub fn new(code: &str, syscall: &str, path: Option<&Path>) -> Self {
        let (errno, desc) = describe(code);
        NodeErr { code: code.into(), errno, message: desc.into(), syscall: syscall.into(), path: path.map(|p| p.to_string_lossy().into_owned()), dest: None }
    }
    pub fn io(e: &io::Error, syscall: &str, path: &Path) -> Self {
        NodeErr::new(io_code(e), syscall, Some(path))
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| self.code.clone())
    }
}

/// libuv's errno (negative on Unix) and description for a code.
fn describe(code: &str) -> (i32, &'static str) {
    #[cfg(unix)]
    let n = |x: i32| -x;
    #[cfg(not(unix))]
    let n = |_x: i32| -1;
    #[cfg(unix)]
    use libc::*;
    #[cfg(not(unix))]
    const ENOENT: i32 = 2;
    #[cfg(not(unix))]
    const EEXIST: i32 = 17;
    #[cfg(not(unix))]
    const EACCES: i32 = 13;
    #[cfg(not(unix))]
    const EPERM: i32 = 1;
    #[cfg(not(unix))]
    const ENOTDIR: i32 = 20;
    #[cfg(not(unix))]
    const EISDIR: i32 = 21;
    #[cfg(not(unix))]
    const ENOTEMPTY: i32 = 39;
    #[cfg(not(unix))]
    const EINVAL: i32 = 22;
    #[cfg(not(unix))]
    const EXDEV: i32 = 18;
    #[cfg(not(unix))]
    const EBUSY: i32 = 16;
    #[cfg(not(unix))]
    const ELOOP: i32 = 40;
    #[cfg(not(unix))]
    const ENAMETOOLONG: i32 = 36;
    #[cfg(not(unix))]
    const EROFS: i32 = 30;
    #[cfg(not(unix))]
    const EMFILE: i32 = 24;
    #[cfg(not(unix))]
    const ETIMEDOUT: i32 = 110;
    #[cfg(not(unix))]
    const ENOBUFS: i32 = 105;
    match code {
        "ENOENT" => (n(ENOENT), "no such file or directory"),
        "EEXIST" => (n(EEXIST), "file already exists"),
        "EACCES" => (n(EACCES), "permission denied"),
        "EPERM" => (n(EPERM), "operation not permitted"),
        "ENOTDIR" => (n(ENOTDIR), "not a directory"),
        "EISDIR" => (n(EISDIR), "illegal operation on a directory"),
        "ENOTEMPTY" => (n(ENOTEMPTY), "directory not empty"),
        "EINVAL" => (n(EINVAL), "invalid argument"),
        "EXDEV" => (n(EXDEV), "cross-device link not permitted"),
        "EBUSY" => (n(EBUSY), "resource busy or locked"),
        "ELOOP" => (n(ELOOP), "too many symbolic links encountered"),
        "ENAMETOOLONG" => (n(ENAMETOOLONG), "name too long"),
        "EROFS" => (n(EROFS), "read-only file system"),
        "EMFILE" => (n(EMFILE), "too many open files"),
        "ETIMEDOUT" => (n(ETIMEDOUT), "connection timed out"),
        "ENOBUFS" => (n(ENOBUFS), "no buffer space available"),
        _ => (-1, "unknown error"),
    }
}

fn io_code(e: &io::Error) -> &'static str {
    #[cfg(unix)]
    if let Some(n) = e.raw_os_error() {
        use libc::*;
        let c = match n {
            ENOENT => "ENOENT",
            EEXIST => "EEXIST",
            EACCES => "EACCES",
            EPERM => "EPERM",
            ENOTDIR => "ENOTDIR",
            EISDIR => "EISDIR",
            ENOTEMPTY => "ENOTEMPTY",
            EINVAL => "EINVAL",
            EXDEV => "EXDEV",
            EBUSY => "EBUSY",
            ELOOP => "ELOOP",
            ENAMETOOLONG => "ENAMETOOLONG",
            EROFS => "EROFS",
            EMFILE => "EMFILE",
            _ => "",
        };
        if !c.is_empty() {
            return c;
        }
    }
    use io::ErrorKind::*;
    match e.kind() {
        NotFound => "ENOENT",
        AlreadyExists => "EEXIST",
        PermissionDenied => "EPERM",
        NotADirectory => "ENOTDIR",
        IsADirectory => "EISDIR",
        DirectoryNotEmpty => "ENOTEMPTY",
        InvalidInput => "EINVAL",
        TimedOut => "ETIMEDOUT",
        _ => "EIO",
    }
}

// ------------------------------------------------------------------ file system

/// One file-system call. Paths must be absolute (the JS side resolves relative paths against `process.cwd()`);
/// binary payloads are base64.
#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FsOp {
    ReadFile { path: String },
    WriteFile { path: String, data: String, flag: Option<String>, mode: Option<u32> },
    Readdir { path: String },
    Stat { path: String, lstat: Option<bool> },
    Exists { path: String },
    Access { path: String, mode: Option<u32> },
    Mkdir { path: String, recursive: Option<bool> },
    Rm { path: String, recursive: Option<bool>, force: Option<bool> },
    Rmdir { path: String, recursive: Option<bool> },
    Unlink { path: String },
    Rename { from: String, to: String },
    CopyFile { from: String, to: String, excl: Option<bool> },
    Cp { from: String, to: String, recursive: Option<bool>, force: Option<bool> },
    Realpath { path: String },
    Readlink { path: String },
    Symlink { target: String, path: String },
    Chmod { path: String, mode: u32 },
    Truncate { path: String, len: Option<u64> },
    Utimes { path: String, atime: f64, mtime: f64 },
    Mkdtemp { prefix: String },
}

fn abs(p: &str, syscall: &str) -> Result<PathBuf, NodeErr> {
    let pb = PathBuf::from(p);
    if pb.is_absolute() {
        Ok(pb)
    } else {
        Err(NodeErr { message: "path must be absolute".into(), ..NodeErr::new("EINVAL", syscall, Some(&pb)) })
    }
}

fn ms(t: io::Result<std::time::SystemTime>) -> f64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

pub fn stat_json(m: &fs::Metadata) -> Value {
    let ft = m.file_type();
    let kind = if ft.is_symlink() {
        "symlink"
    } else if ft.is_dir() {
        "dir"
    } else if ft.is_file() {
        "file"
    } else {
        "other"
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let ctime = m.ctime() as f64 * 1000.0 + m.ctime_nsec() as f64 / 1e6;
        json!({ "kind": kind, "dev": m.dev(), "ino": m.ino(), "mode": m.mode(), "nlink": m.nlink(), "uid": m.uid(), "gid": m.gid(),
            "rdev": m.rdev(), "size": m.size(), "blksize": m.blksize(), "blocks": m.blocks(),
            "atimeMs": ms(m.accessed()), "mtimeMs": ms(m.modified()), "ctimeMs": ctime, "birthtimeMs": ms(m.created()) })
    }
    #[cfg(not(unix))]
    {
        let mode: u32 = if ft.is_dir() {
            0o40755
        } else if ft.is_symlink() {
            0o120777
        } else {
            0o100644
        } & if m.permissions().readonly() { !0o222 } else { !0 };
        json!({ "kind": kind, "dev": 0, "ino": 0, "mode": mode, "nlink": 1, "uid": 0, "gid": 0, "rdev": 0, "size": m.len(), "blksize": 4096,
            "blocks": m.len().div_ceil(512), "atimeMs": ms(m.accessed()), "mtimeMs": ms(m.modified()), "ctimeMs": ms(m.modified()), "birthtimeMs": ms(m.created()) })
    }
}

fn kind_of(ft: fs::FileType) -> &'static str {
    if ft.is_symlink() {
        "symlink"
    } else if ft.is_dir() {
        "dir"
    } else if ft.is_file() {
        "file"
    } else {
        "other"
    }
}

fn copy_tree(from: &Path, to: &Path, force: bool) -> io::Result<()> {
    let m = fs::symlink_metadata(from)?;
    if m.is_dir() {
        fs::create_dir_all(to)?;
        for ent in fs::read_dir(from)? {
            let ent = ent?;
            copy_tree(&ent.path(), &to.join(ent.file_name()), force)?;
        }
        Ok(())
    } else if to.exists() && !force {
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

fn strip_verbatim(p: PathBuf) -> String {
    let s = p.to_string_lossy().into_owned();
    s.strip_prefix(r"\\?\").map(String::from).unwrap_or(s)
}

/// Execute one file-system call (no gate check: callers check the gate first).
pub fn fs_op(op: FsOp) -> Result<Value, NodeErr> {
    macro_rules! io {
        ($e:expr, $sys:expr, $p:expr) => {
            $e.map_err(|e| NodeErr::io(&e, $sys, &$p))?
        };
    }
    Ok(match op {
        FsOp::ReadFile { path } => {
            let p = abs(&path, "open")?;
            if p.is_dir() {
                return Err(NodeErr::new("EISDIR", "read", None));
            }
            Value::String(B64.encode(io!(fs::read(&p), "open", p)))
        }
        FsOp::WriteFile { path, data, flag, mode } => {
            let p = abs(&path, "open")?;
            let bytes = B64.decode(data.as_bytes()).map_err(|_| NodeErr::new("EINVAL", "write", Some(&p)))?;
            let flag = flag.unwrap_or_else(|| "w".into());
            let mut o = fs::OpenOptions::new();
            if flag.starts_with('a') {
                o.append(true).create(true);
            } else {
                o.write(true).truncate(true).create(true);
            }
            if flag.contains('x') {
                o.create_new(true);
            }
            #[cfg(unix)]
            if let Some(m) = mode {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(m);
            }
            #[cfg(not(unix))]
            let _ = mode;
            let mut f = io!(o.open(&p), "open", p);
            io!(f.write_all(&bytes), "write", p);
            Value::Null
        }
        FsOp::Readdir { path } => {
            let p = abs(&path, "scandir")?;
            let mut out: Vec<(String, &str)> = vec![];
            for ent in io!(fs::read_dir(&p), "scandir", p) {
                let ent = io!(ent, "scandir", p);
                let kind = ent.file_type().map(kind_of).unwrap_or("other");
                out.push((ent.file_name().to_string_lossy().into_owned(), kind));
            }
            out.sort();
            Value::Array(out.into_iter().map(|(name, kind)| json!({ "name": name, "kind": kind })).collect())
        }
        FsOp::Stat { path, lstat } => {
            let lstat = lstat.unwrap_or(false);
            let p = abs(&path, if lstat { "lstat" } else { "stat" })?;
            let m = if lstat { fs::symlink_metadata(&p) } else { fs::metadata(&p) };
            stat_json(&io!(m, if lstat { "lstat" } else { "stat" }, p))
        }
        FsOp::Exists { path } => Value::Bool(abs(&path, "access").map(|p| p.exists()).unwrap_or(false)),
        FsOp::Access { path, mode } => {
            let p = abs(&path, "access")?;
            let mode = mode.unwrap_or(0);
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                let c = std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|_| NodeErr::new("EINVAL", "access", Some(&p)))?;
                // SAFETY: `c` is a valid NUL-terminated path for the duration of the call.
                if unsafe { libc::access(c.as_ptr(), mode as libc::c_int) } != 0 {
                    return Err(NodeErr::io(&io::Error::last_os_error(), "access", &p));
                }
            }
            #[cfg(not(unix))]
            {
                let m = io!(fs::metadata(&p), "access", p);
                if mode & 2 != 0 && m.permissions().readonly() {
                    return Err(NodeErr::new("EPERM", "access", Some(&p)));
                }
            }
            Value::Null
        }
        FsOp::Mkdir { path, recursive } => {
            let p = abs(&path, "mkdir")?;
            if recursive.unwrap_or(false) {
                // Node returns the first directory created (undefined when nothing was created).
                let mut first = None;
                let mut cur = p.as_path();
                while !cur.exists() {
                    first = Some(cur.to_path_buf());
                    match cur.parent() {
                        Some(par) => cur = par,
                        None => break,
                    }
                }
                if p.exists() && !p.is_dir() {
                    return Err(NodeErr::new("EEXIST", "mkdir", Some(&p)));
                }
                io!(fs::create_dir_all(&p), "mkdir", p);
                first.map_or(Value::Null, |f| Value::String(f.to_string_lossy().into_owned()))
            } else {
                io!(fs::create_dir(&p), "mkdir", p);
                Value::Null
            }
        }
        FsOp::Rm { path, recursive, force } => {
            let p = abs(&path, "rm")?;
            match fs::symlink_metadata(&p) {
                Err(e) if e.kind() == io::ErrorKind::NotFound && force.unwrap_or(false) => {}
                Err(e) => return Err(NodeErr::io(&e, "rm", &p)),
                Ok(m) if m.is_dir() => {
                    if !recursive.unwrap_or(false) {
                        return Err(NodeErr { code: "ERR_FS_EISDIR".into(), message: "Path is a directory".into(), ..NodeErr::new("EISDIR", "rm", Some(&p)) });
                    }
                    io!(fs::remove_dir_all(&p), "rm", p)
                }
                Ok(_) => io!(fs::remove_file(&p), "rm", p),
            }
            Value::Null
        }
        FsOp::Rmdir { path, recursive } => {
            let p = abs(&path, "rmdir")?;
            if recursive.unwrap_or(false) {
                io!(fs::remove_dir_all(&p), "rmdir", p)
            } else {
                io!(fs::remove_dir(&p), "rmdir", p)
            }
            Value::Null
        }
        FsOp::Unlink { path } => {
            let p = abs(&path, "unlink")?;
            io!(fs::remove_file(&p), "unlink", p);
            Value::Null
        }
        FsOp::Rename { from, to } => {
            let (a, b) = (abs(&from, "rename")?, abs(&to, "rename")?);
            fs::rename(&a, &b).map_err(|e| NodeErr { dest: Some(to.clone()), ..NodeErr::io(&e, "rename", &a) })?;
            Value::Null
        }
        FsOp::CopyFile { from, to, excl } => {
            let (a, b) = (abs(&from, "copyfile")?, abs(&to, "copyfile")?);
            if excl.unwrap_or(false) && b.exists() {
                return Err(NodeErr { dest: Some(to), ..NodeErr::new("EEXIST", "copyfile", Some(&a)) });
            }
            fs::copy(&a, &b).map_err(|e| NodeErr { dest: Some(to.clone()), ..NodeErr::io(&e, "copyfile", &a) })?;
            Value::Null
        }
        FsOp::Cp { from, to, recursive, force } => {
            let (a, b) = (abs(&from, "cp")?, abs(&to, "cp")?);
            if a.is_dir() && !recursive.unwrap_or(false) {
                return Err(NodeErr {
                    code: "ERR_FS_EISDIR".into(),
                    message: "Recursive option is required to copy a directory".into(),
                    ..NodeErr::new("EISDIR", "cp", Some(&a))
                });
            }
            io!(copy_tree(&a, &b, force.unwrap_or(true)), "cp", a);
            Value::Null
        }
        FsOp::Realpath { path } => {
            let p = abs(&path, "realpath")?;
            Value::String(strip_verbatim(io!(fs::canonicalize(&p), "realpath", p)))
        }
        FsOp::Readlink { path } => {
            let p = abs(&path, "readlink")?;
            Value::String(io!(fs::read_link(&p), "readlink", p).to_string_lossy().into_owned())
        }
        FsOp::Symlink { target, path } => {
            let p = abs(&path, "symlink")?;
            #[cfg(unix)]
            io!(std::os::unix::fs::symlink(&target, &p), "symlink", p);
            #[cfg(windows)]
            {
                let t = p.parent().map(|d| d.join(&target)).unwrap_or_else(|| PathBuf::from(&target));
                if t.is_dir() {
                    io!(std::os::windows::fs::symlink_dir(&target, &p), "symlink", p)
                } else {
                    io!(std::os::windows::fs::symlink_file(&target, &p), "symlink", p)
                }
            }
            Value::Null
        }
        FsOp::Chmod { path, mode } => {
            let p = abs(&path, "chmod")?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                io!(fs::set_permissions(&p, fs::Permissions::from_mode(mode)), "chmod", p);
            }
            #[cfg(not(unix))]
            {
                let mut perm = io!(fs::metadata(&p), "chmod", p).permissions();
                perm.set_readonly(mode & 0o200 == 0);
                io!(fs::set_permissions(&p, perm), "chmod", p);
            }
            Value::Null
        }
        FsOp::Truncate { path, len } => {
            let p = abs(&path, "open")?;
            let f = io!(fs::OpenOptions::new().write(true).open(&p), "open", p);
            io!(f.set_len(len.unwrap_or(0)), "ftruncate", p);
            Value::Null
        }
        FsOp::Utimes { path, atime, mtime } => {
            let p = abs(&path, "utime")?;
            let t = |s: f64| UNIX_EPOCH + Duration::from_secs_f64(s.max(0.0));
            let f = io!(fs::OpenOptions::new().write(true).open(&p).or_else(|_| fs::File::open(&p)), "utime", p);
            io!(f.set_times(fs::FileTimes::new().set_accessed(t(atime)).set_modified(t(mtime))), "utime", p);
            Value::Null
        }
        FsOp::Mkdtemp { prefix } => {
            let base = abs(&prefix, "mkdtemp")?;
            const CH: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            for _ in 0..100 {
                let mut r = [0u8; 6];
                let _ = getrandom::fill(&mut r);
                let suffix: String = r.iter().map(|b| CH[*b as usize % CH.len()] as char).collect();
                let p = PathBuf::from(format!("{prefix}{suffix}"));
                match fs::create_dir(&p) {
                    Ok(()) => return Ok(Value::String(p.to_string_lossy().into_owned())),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(NodeErr::io(&e, "mkdtemp", &base)),
                }
            }
            return Err(NodeErr::new("EEXIST", "mkdtemp", Some(&base)));
        }
    })
}

// ------------------------------------------------------------------ processes

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpawnReq {
    /// Caller-chosen id (the JS side registers its event handlers before spawning).
    #[serde(default)]
    pub id: u64,
    pub file: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// Full environment of the child (Node semantics); `None` inherits Tachylite's environment.
    pub env: Option<BTreeMap<String, String>>,
    /// `["pipe"|"ignore"|"inherit"; 3]`, default all `pipe`.
    pub stdio: Option<Vec<String>>,
    /// Windows: pass arguments verbatim (`cmd.exe /d /s /c "..."`), like Node's `windowsVerbatimArguments`.
    #[serde(default)]
    #[cfg_attr(not(windows), allow(dead_code))]
    pub windows_verbatim_arguments: bool,
}

/// Events streamed to the webview (`bridge-process`).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProcEvent {
    Stdout { id: u64, data: String },
    Stderr { id: u64, data: String },
    Exit { id: u64, code: Option<i32>, signal: Option<String> },
    Close { id: u64, code: Option<i32>, signal: Option<String> },
}

pub struct Proc {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    pid: u32,
}

impl Proc {
    /// Send `signal` (default SIGTERM) if the process has not been reaped yet. Returns whether a signal was sent.
    pub fn kill(&self, signal: Option<&str>) -> io::Result<bool> {
        let mut c = self.child.lock().map_err(|_| io::Error::other("poisoned"))?;
        if c.try_wait()?.is_some() {
            return Ok(false);
        }
        #[cfg(unix)]
        {
            let sig = signal_number(signal.unwrap_or("SIGTERM")).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "unknown signal"))?;
            // SAFETY: the child is not reaped (we hold its lock and try_wait returned None), so the pid is still ours.
            if unsafe { libc::kill(self.pid as libc::pid_t, sig) } != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(true)
        }
        #[cfg(not(unix))]
        {
            let _ = signal;
            c.kill().map(|_| true)
        }
    }
}

#[cfg(unix)]
fn signal_number(name: &str) -> Option<i32> {
    use libc::*;
    if let Ok(n) = name.parse::<i32>() {
        return Some(n);
    }
    Some(match name {
        "SIGHUP" => SIGHUP,
        "SIGINT" => SIGINT,
        "SIGQUIT" => SIGQUIT,
        "SIGKILL" => SIGKILL,
        "SIGTERM" => SIGTERM,
        "SIGUSR1" => SIGUSR1,
        "SIGUSR2" => SIGUSR2,
        "SIGSTOP" => SIGSTOP,
        "SIGCONT" => SIGCONT,
        "SIGPIPE" => SIGPIPE,
        "SIGALRM" => SIGALRM,
        "SIGABRT" => SIGABRT,
        _ => return None,
    })
}

fn signal_name(st: &ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        st.signal().map(|s| {
            use libc::*;
            match s {
                SIGHUP => "SIGHUP".into(),
                SIGINT => "SIGINT".into(),
                SIGQUIT => "SIGQUIT".into(),
                SIGKILL => "SIGKILL".into(),
                SIGTERM => "SIGTERM".into(),
                SIGUSR1 => "SIGUSR1".into(),
                SIGUSR2 => "SIGUSR2".into(),
                SIGPIPE => "SIGPIPE".into(),
                SIGALRM => "SIGALRM".into(),
                SIGABRT => "SIGABRT".into(),
                SIGSEGV => "SIGSEGV".into(),
                n => format!("SIG{n}"),
            }
        })
    }
    #[cfg(not(unix))]
    {
        let _ = st;
        None
    }
}

fn command(req: &SpawnReq, default_cwd: &Path) -> Command {
    let mut cmd = Command::new(&req.file);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if req.windows_verbatim_arguments {
            for a in &req.args {
                cmd.raw_arg(a);
            }
        } else {
            cmd.args(&req.args);
        }
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW (Node's windowsHide)
    }
    #[cfg(not(windows))]
    cmd.args(&req.args);
    let cwd = req.cwd.as_deref().filter(|c| !c.is_empty()).map(|c| default_cwd.join(c)).unwrap_or_else(|| default_cwd.to_path_buf());
    cmd.current_dir(cwd);
    if let Some(env) = &req.env {
        cmd.env_clear().envs(env);
    }
    let stdio = |i: usize| match req.stdio.as_ref().and_then(|s| s.get(i)).map(String::as_str) {
        Some("ignore") => Stdio::null(),
        Some("inherit") => Stdio::inherit(),
        _ => Stdio::piped(),
    };
    cmd.stdin(stdio(0)).stdout(stdio(1)).stderr(stdio(2));
    cmd
}

fn spawn_err(e: &io::Error, req: &SpawnReq) -> NodeErr {
    let mut err = NodeErr::new(io_code(e), &format!("spawn {}", req.file), Some(Path::new(&req.file)));
    err.message = format!("{} {}", err.syscall, err.code);
    err
}

fn pump(mut r: impl Read + Send + 'static, f: impl Fn(Vec<u8>) + Send + 'static) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match r.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => f(buf[..n].to_vec()),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    })
}

/// Start a process and stream its output to `sink` from background threads: stdout/stderr chunks, then `Exit`,
/// then `Close` once both pipes are drained (Node's event order).
pub fn spawn_process(req: &SpawnReq, default_cwd: &Path, sink: impl Fn(ProcEvent) + Send + Sync + 'static) -> Result<Arc<Proc>, NodeErr> {
    let mut child = command(req, default_cwd).spawn().map_err(|e| spawn_err(&e, req))?;
    let id = req.id;
    let sink = Arc::new(sink);
    let mut readers = vec![];
    if let Some(out) = child.stdout.take() {
        let s = sink.clone();
        readers.push(pump(out, move |d| s(ProcEvent::Stdout { id, data: B64.encode(d) })));
    }
    if let Some(err) = child.stderr.take() {
        let s = sink.clone();
        readers.push(pump(err, move |d| s(ProcEvent::Stderr { id, data: B64.encode(d) })));
    }
    let stdin = child.stdin.take();
    let proc = Arc::new(Proc { pid: child.id(), child: Mutex::new(child), stdin: Mutex::new(stdin) });
    let p2 = proc.clone();
    thread::spawn(move || {
        let mut delay = Duration::from_millis(1);
        let status = loop {
            let r = p2.child.lock().map(|mut c| c.try_wait());
            match r {
                Ok(Ok(Some(st))) => break Some(st),
                Ok(Ok(None)) => {}
                _ => break None,
            }
            thread::sleep(delay);
            delay = (delay * 2).min(Duration::from_millis(20));
        };
        let (code, signal) = status.map_or((None, None), |st| (st.code(), signal_name(&st)));
        // The child is gone: drop our end of stdin so writers get EPIPE instead of blocking.
        if let Ok(mut s) = p2.stdin.lock() {
            s.take();
        }
        sink(ProcEvent::Exit { id, code, signal: signal.clone() });
        for r in readers {
            let _ = r.join();
        }
        sink(ProcEvent::Close { id, code, signal });
    });
    Ok(proc)
}

/// Write to (and optionally close) a child's stdin.
pub fn write_stdin(p: &Proc, data: &[u8], end: bool) -> io::Result<()> {
    let mut g = p.stdin.lock().map_err(|_| io::Error::other("poisoned"))?;
    if !data.is_empty() {
        match g.as_mut() {
            Some(s) => s.write_all(data)?,
            None => return Err(io::Error::new(io::ErrorKind::BrokenPipe, "stdin is closed")),
        }
    }
    if end {
        g.take();
    }
    Ok(())
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpawnSyncReq {
    #[serde(flatten)]
    pub spawn: SpawnReq,
    /// base64
    pub input: Option<String>,
    pub timeout: Option<u64>,
    pub kill_signal: Option<String>,
    pub max_buffer: Option<usize>,
}

/// `spawnSync`: run to completion. Returns Node's result shape (`pid, status, signal, stdout, stderr, error?`).
pub fn spawn_sync(req: SpawnSyncReq, default_cwd: &Path) -> Value {
    let mut spawn = req.spawn.clone();
    if req.input.is_none() && spawn.stdio.is_none() {
        spawn.stdio = Some(vec!["ignore".into(), "pipe".into(), "pipe".into()]);
    }
    let mut child = match command(&spawn, default_cwd).spawn() {
        Ok(c) => c,
        Err(e) => return json!({ "pid": 0, "status": null, "signal": null, "stdout": "", "stderr": "", "error": spawn_err(&e, &spawn) }),
    };
    let pid = child.id();
    if let (Some(mut stdin), Some(inp)) = (child.stdin.take(), req.input.as_deref()) {
        let data = B64.decode(inp.as_bytes()).unwrap_or_default();
        thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
    }
    let max = req.max_buffer.unwrap_or(1024 * 1024);
    let collect = |r: Option<Box<dyn Read + Send>>| {
        r.map(|mut r| {
            thread::spawn(move || {
                let mut v = vec![];
                let _ = r.read_to_end(&mut v);
                v
            })
        })
    };
    let out = collect(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let err = collect(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let deadline = req.timeout.filter(|t| *t > 0).map(|t| Instant::now() + Duration::from_millis(t));
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {}
            Err(_) => break None,
        }
        if deadline.is_some_and(|d| Instant::now() >= d) && !timed_out {
            timed_out = true;
            #[cfg(unix)]
            // SAFETY: not reaped yet (try_wait returned None above).
            unsafe {
                libc::kill(pid as libc::pid_t, signal_number(req.kill_signal.as_deref().unwrap_or("SIGTERM")).unwrap_or(libc::SIGTERM));
            }
            #[cfg(not(unix))]
            let _ = child.kill();
        }
        thread::sleep(Duration::from_millis(2));
    };
    let join = |h: Option<thread::JoinHandle<Vec<u8>>>| h.and_then(|h| h.join().ok()).unwrap_or_default();
    let (mut so, mut se) = (join(out), join(err));
    let mut error = if timed_out { Some(NodeErr::new("ETIMEDOUT", &format!("spawnSync {}", spawn.file), None)) } else { None };
    if so.len() > max || se.len() > max {
        so.truncate(max);
        se.truncate(max);
        error.get_or_insert_with(|| NodeErr::new("ENOBUFS", &format!("spawnSync {}", spawn.file), None));
    }
    if let Some(e) = error.as_mut() {
        e.message = format!("{} {}", e.syscall, e.code);
    }
    let (code, signal) = status.map_or((None, None), |st| (st.code(), signal_name(&st)));
    json!({ "pid": pid, "status": code, "signal": signal, "stdout": B64.encode(so), "stderr": B64.encode(se), "error": error })
}

// ------------------------------------------------------------------ platform info

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    platform: &'static str,
    arch: &'static str,
    cwd: String,
    homedir: String,
    tmpdir: String,
    hostname: String,
    username: String,
    env: BTreeMap<String, String>,
    pid: u32,
    sync_url: String,
    token: String,
}

fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        o => o,
    }
}

fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: buf is writable for its full length.
        if unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } == 0 {
            let n = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            return String::from_utf8_lossy(&buf[..n]).into_owned();
        }
    }
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "localhost".into())
}

pub fn info(bridge: &Bridge, root: &Path) -> Info {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let home = env.get(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).cloned().unwrap_or_default();
    Info {
        platform: platform(),
        arch: match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            "x86" => "ia32",
            a => a,
        },
        cwd: root.to_string_lossy().into_owned(),
        homedir: home,
        tmpdir: std::env::temp_dir().to_string_lossy().trim_end_matches(['/', '\\']).to_string(),
        hostname: hostname(),
        username: env.get("USER").or_else(|| env.get("USERNAME")).cloned().unwrap_or_default(),
        env,
        pid: std::process::id(),
        sync_url: if cfg!(any(windows, target_os = "android")) { format!("http://{SCHEME}.localhost/") } else { format!("{SCHEME}://localhost/") },
        token: bridge.token.clone(),
    }
}

// ------------------------------------------------------------------ Tauri commands

fn consent_file(app: &AppHandle) -> Res<PathBuf> {
    Ok(app.path().app_config_dir().map_err(|e| e.to_string())?.join("node-bridge.json"))
}

fn vault_root(state: &State<crate::App>) -> Res<PathBuf> {
    state.with(|ws| Ok(ws.vault.root().to_path_buf()))
}

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    active: bool,
}

/// Whether the user allowed the bridge for this vault, and whether it is active in this session.
#[tauri::command]
pub fn bridge_status(app: AppHandle, state: State<crate::App>, bridge: State<Bridge>) -> Res<Status> {
    let root = vault_root(&state)?;
    Ok(Status { enabled: consent_load(&consent_file(&app)?, &root), active: bridge.is_active() })
}

/// Activate (community plugins turned on) or deactivate (restricted mode) the bridge for this session.
/// Only activates when the user consented for this vault. Returns the platform info when active.
#[tauri::command]
pub fn bridge_activate(app: AppHandle, state: State<crate::App>, bridge: State<Bridge>, active: bool) -> Res<Option<Info>> {
    let root = vault_root(&state)?;
    let consented = consent_load(&consent_file(&app)?, &root);
    Ok(bridge.set_active(&root, active, consented).then(|| info(&bridge, &root)))
}

/// Record the user's choice (called by the UI only after the warning modal was accepted) and apply it now.
#[tauri::command]
pub fn bridge_set_enabled(app: AppHandle, state: State<crate::App>, bridge: State<Bridge>, enabled: bool) -> Res<Option<Info>> {
    let root = vault_root(&state)?;
    consent_save(&consent_file(&app)?, &root, enabled).map_err(|e| e.to_string())?;
    Ok(bridge.set_active(&root, enabled, enabled).then(|| info(&bridge, &root)))
}

#[tauri::command]
pub fn bridge_fs(bridge: State<Bridge>, op: FsOp) -> Res<Value> {
    bridge.check()?;
    fs_op(op).map_err(|e| e.to_json())
}

/// Spawn a process; output arrives as `bridge-process` events. Returns the pid, or a Node-shaped spawn error.
#[tauri::command]
pub fn bridge_spawn(app: AppHandle, bridge: State<Bridge>, req: SpawnReq) -> Res<Value> {
    let cwd = bridge.check()?;
    let handle = app.clone();
    let id = req.id;
    let res = spawn_process(&req, &cwd, move |ev| {
        if let ProcEvent::Close { id, .. } = &ev {
            if let Some(b) = handle.try_state::<Bridge>() {
                if let Ok(mut p) = b.procs.lock() {
                    p.remove(id);
                }
            }
        }
        let _ = handle.emit("bridge-process", &ev);
    });
    match res {
        Ok(p) => {
            let pid = p.pid;
            bridge.procs.lock().map_err(|e| e.to_string())?.insert(id, p);
            Ok(json!({ "pid": pid }))
        }
        Err(e) => Ok(json!({ "error": e })),
    }
}

fn proc_of(bridge: &Bridge, id: u64) -> Res<Arc<Proc>> {
    bridge.procs.lock().map_err(|e| e.to_string())?.get(&id).cloned().ok_or_else(|| "no such process".into())
}

#[tauri::command]
pub fn bridge_stdin(bridge: State<Bridge>, id: u64, data: Option<String>, end: Option<bool>) -> Res<()> {
    bridge.check()?;
    let bytes = data.map(|d| B64.decode(d.as_bytes()).map_err(|e| e.to_string())).transpose()?.unwrap_or_default();
    write_stdin(&*proc_of(&bridge, id)?, &bytes, end.unwrap_or(false)).map_err(|e| NodeErr::io(&e, "write", Path::new("")).to_json())
}

#[tauri::command]
pub fn bridge_kill(bridge: State<Bridge>, id: u64, signal: Option<String>) -> Res<bool> {
    bridge.check()?;
    match proc_of(&bridge, id) {
        Ok(p) => p.kill(signal.as_deref()).map_err(|e| e.to_string()),
        Err(_) => Ok(false),
    }
}

/// `child_process.*Sync` and `fs.*Sync` through the async IPC (used when the sync channel is unavailable, and by tests).
#[tauri::command]
pub async fn bridge_spawn_sync(bridge: State<'_, Bridge>, req: SpawnSyncReq) -> Res<Value> {
    let cwd = bridge.check()?;
    tauri::async_runtime::spawn_blocking(move || spawn_sync(req, &cwd)).await.map_err(|e| e.to_string())
}

/// `fs.watch`: emits `bridge-watch` events `{id, eventType: "rename"|"change", filename}` until `bridge_unwatch`.
#[tauri::command]
pub fn bridge_watch(app: AppHandle, bridge: State<Bridge>, id: u64, path: String, recursive: Option<bool>) -> Res<()> {
    use notify::Watcher;
    bridge.check()?;
    let p = abs(&path, "watch").map_err(|e| e.to_json())?;
    if !p.exists() {
        return Err(NodeErr::new("ENOENT", "watch", Some(&p)).to_json());
    }
    let base = if p.is_dir() { p.clone() } else { p.parent().map(Path::to_path_buf).unwrap_or_default() };
    let handle = app.clone();
    let mut w = notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
        let Ok(ev) = ev else { return };
        let kind = match ev.kind {
            notify::EventKind::Create(_) | notify::EventKind::Remove(_) | notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => "rename",
            notify::EventKind::Modify(_) => "change",
            _ => return,
        };
        for f in ev.paths {
            let name = f.strip_prefix(&base).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
            let _ = handle.emit("bridge-watch", json!({ "id": id, "eventType": kind, "filename": name }));
        }
    })
    .map_err(|e| e.to_string())?;
    let mode = if recursive.unwrap_or(false) { notify::RecursiveMode::Recursive } else { notify::RecursiveMode::NonRecursive };
    w.watch(&p, mode).map_err(|e| e.to_string())?;
    bridge.watchers.lock().map_err(|e| e.to_string())?.insert(id, w);
    Ok(())
}

#[tauri::command]
pub fn bridge_unwatch(bridge: State<Bridge>, id: u64) -> Res<()> {
    bridge.watchers.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}

/// electron `shell.openPath` / `shell.showItemInFolder` (reveal: open the containing folder; selects it on macOS/Windows).
#[tauri::command]
pub fn bridge_open_path(bridge: State<Bridge>, path: String, reveal: Option<bool>) -> Res<()> {
    bridge.check()?;
    let p = abs(&path, "open").map_err(|e| e.to_json())?;
    if !p.exists() {
        return Err(NodeErr::new("ENOENT", "open", Some(&p)).to_json());
    }
    let reveal = reveal.unwrap_or(false);
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        if reveal {
            c.arg("-R");
        }
        c.arg(&p);
        c
    } else if cfg!(windows) {
        let mut c = Command::new("explorer");
        if reveal {
            c.arg(format!("/select,{}", p.display()));
        } else {
            c.arg(&p);
        }
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(if reveal { p.parent().unwrap_or(&p) } else { &p });
        c
    };
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ synchronous channel (custom URI scheme)

#[derive(Deserialize)]
#[serde(tag = "call", rename_all = "camelCase")]
enum SyncCall {
    Fs { op: FsOp },
    SpawnSync { req: SpawnSyncReq },
}

/// Handle one sync request: `POST` body `{token, call: "fs"|"spawnSync", ...}` -> `{ok}` or `{err}`.
pub fn handle_sync(bridge: &Bridge, body: &[u8]) -> (u16, Value) {
    let Ok(mut v) = serde_json::from_slice::<Value>(body) else { return (400, json!({ "err": "bad request" })) };
    let token = v.get("token").and_then(Value::as_str).unwrap_or_default().to_string();
    // Constant-time-ish comparison; the token is per session and never leaves this webview.
    if token.len() != bridge.token.len() || token.bytes().zip(bridge.token.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) != 0 {
        return (403, json!({ "err": "forbidden" }));
    }
    let cwd = match bridge.check() {
        Ok(c) => c,
        Err(e) => return (200, json!({ "err": e })),
    };
    if let Some(o) = v.as_object_mut() {
        o.remove("token");
    }
    match serde_json::from_value::<SyncCall>(v) {
        Ok(SyncCall::Fs { op }) => match fs_op(op) {
            Ok(r) => (200, json!({ "ok": r })),
            Err(e) => (200, json!({ "err": e.to_json() })),
        },
        Ok(SyncCall::SpawnSync { req }) => (200, json!({ "ok": spawn_sync(req, &cwd) })),
        Err(e) => (400, json!({ "err": e.to_string() })),
    }
}

/// Tauri URI scheme handler for [`SCHEME`].
pub fn protocol(app: &AppHandle, req: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    let app = app.clone();
    thread::spawn(move || {
        let base = || {
            tauri::http::Response::builder()
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "POST, OPTIONS")
                .header("Access-Control-Allow-Headers", "Content-Type")
                .header("Cache-Control", "no-store")
        };
        let resp = if req.method() == tauri::http::Method::OPTIONS {
            base().status(204).body(vec![])
        } else if req.method() != tauri::http::Method::POST {
            base().status(405).body(vec![])
        } else {
            let (status, v) = handle_sync(&app.state::<Bridge>(), req.body());
            base().status(status).header("Content-Type", "application/json").body(serde_json::to_vec(&v).unwrap_or_default())
        };
        responder.respond(resp.unwrap_or_else(|_| tauri::http::Response::new(vec![])));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn gate_requires_activation_and_consent() {
        let b = Bridge::default();
        let d = tmp();
        assert!(b.check().unwrap_err().starts_with("ERR_BRIDGE_DISABLED"));
        assert!(!b.set_active(d.path(), true, false), "no consent: stays off");
        assert!(b.check().is_err());
        assert!(b.set_active(d.path(), true, true));
        assert_eq!(b.check().unwrap(), d.path());
        assert!(!b.set_active(d.path(), false, true), "restricted mode turns it off");
        assert!(b.check().is_err());
    }

    #[test]
    fn sync_channel_checks_token_and_gate() {
        let b = Bridge::default();
        let d = tmp();
        fs::write(d.path().join("a.txt"), "hi").unwrap();
        let body =
            |tok: &str| serde_json::to_vec(&json!({ "token": tok, "call": "fs", "op": { "op": "readFile", "path": s(&d.path().join("a.txt")) } })).unwrap();
        assert_eq!(handle_sync(&b, &body("nope")).0, 403);
        let (st, v) = handle_sync(&b, &body(&b.token));
        assert_eq!(st, 200);
        assert!(v["err"].as_str().unwrap().starts_with("ERR_BRIDGE_DISABLED"), "gate closed: {v}");
        b.set_active(d.path(), true, true);
        let (_, v) = handle_sync(&b, &body(&b.token));
        assert_eq!(B64.decode(v["ok"].as_str().unwrap()).unwrap(), b"hi");
        assert_eq!(b.token.len(), 48);
        assert_ne!(Bridge::default().token, b.token);
    }

    #[test]
    fn consent_is_per_vault_and_revocable() {
        let d = tmp();
        let f = d.path().join("cfg/node-bridge.json");
        let (a, c) = (Path::new("/vaults/a"), Path::new("/vaults/c"));
        assert!(!consent_load(&f, a));
        consent_save(&f, a, true).unwrap();
        consent_save(&f, c, true).unwrap();
        assert!(consent_load(&f, a) && consent_load(&f, c));
        consent_save(&f, a, false).unwrap();
        assert!(!consent_load(&f, a) && consent_load(&f, c));
    }

    fn op(v: Value) -> Result<Value, NodeErr> {
        fs_op(serde_json::from_value(v).unwrap())
    }

    #[test]
    fn fs_ops_cover_node_semantics() {
        let d = tmp();
        let p = |x: &str| s(&d.path().join(x));
        op(json!({ "op": "writeFile", "path": p("f.txt"), "data": B64.encode("one") })).unwrap();
        op(json!({ "op": "writeFile", "path": p("f.txt"), "data": B64.encode("+two"), "flag": "a" })).unwrap();
        assert_eq!(fs::read_to_string(d.path().join("f.txt")).unwrap(), "one+two");
        let e = op(json!({ "op": "writeFile", "path": p("f.txt"), "data": "", "flag": "wx" })).unwrap_err();
        assert_eq!((e.code.as_str(), e.syscall.as_str()), ("EEXIST", "open"));
        let first = op(json!({ "op": "mkdir", "path": p("a/b/c"), "recursive": true })).unwrap();
        assert_eq!(first, Value::String(p("a")));
        assert_eq!(op(json!({ "op": "mkdir", "path": p("a/b/c"), "recursive": true })).unwrap(), Value::Null);
        assert_eq!(op(json!({ "op": "mkdir", "path": p("a") })).unwrap_err().code, "EEXIST");
        let st = op(json!({ "op": "stat", "path": p("f.txt") })).unwrap();
        assert_eq!((st["kind"].as_str(), st["size"].as_u64()), (Some("file"), Some(7)));
        assert!(st["mtimeMs"].as_f64().unwrap() > 1.0e12);
        let ls = op(json!({ "op": "readdir", "path": p("") })).unwrap();
        assert_eq!(ls, json!([{ "name": "a", "kind": "dir" }, { "name": "f.txt", "kind": "file" }]));
        let e = op(json!({ "op": "readFile", "path": p("missing") })).unwrap_err();
        assert_eq!((e.code.as_str(), e.message.as_str(), e.path.clone()), ("ENOENT", "no such file or directory", Some(p("missing"))));
        assert_eq!(op(json!({ "op": "rm", "path": p("missing"), "force": true })).unwrap(), Value::Null);
        assert_eq!(op(json!({ "op": "rm", "path": p("a") })).unwrap_err().code, "ERR_FS_EISDIR");
        assert_eq!(op(json!({ "op": "rmdir", "path": p("a") })).unwrap_err().code, "ENOTEMPTY");
        op(json!({ "op": "copyFile", "from": p("f.txt"), "to": p("g.txt") })).unwrap();
        assert_eq!(op(json!({ "op": "copyFile", "from": p("f.txt"), "to": p("g.txt"), "excl": true })).unwrap_err().code, "EEXIST");
        op(json!({ "op": "rename", "from": p("g.txt"), "to": p("a/h.txt") })).unwrap();
        assert_eq!(op(json!({ "op": "exists", "path": p("a/h.txt") })).unwrap(), Value::Bool(true));
        op(json!({ "op": "rm", "path": p("a"), "recursive": true })).unwrap();
        assert_eq!(op(json!({ "op": "exists", "path": p("a") })).unwrap(), Value::Bool(false));
        assert_eq!(op(json!({ "op": "access", "path": p("nope") })).unwrap_err().code, "ENOENT");
        op(json!({ "op": "access", "path": p("f.txt"), "mode": 4 })).unwrap();
        assert_eq!(op(json!({ "op": "readFile", "path": "relative.txt" })).unwrap_err().code, "EINVAL");
        let real = op(json!({ "op": "realpath", "path": p("f.txt") })).unwrap();
        assert!(real.as_str().unwrap().ends_with("f.txt"));
        let t = op(json!({ "op": "mkdtemp", "prefix": p("tmp-") })).unwrap();
        assert!(Path::new(t.as_str().unwrap()).is_dir());
        op(json!({ "op": "utimes", "path": p("f.txt"), "atime": 1000.0, "mtime": 2000.0 })).unwrap();
        assert_eq!(op(json!({ "op": "stat", "path": p("f.txt") })).unwrap()["mtimeMs"].as_f64(), Some(2_000_000.0));
        op(json!({ "op": "truncate", "path": p("f.txt"), "len": 3 })).unwrap();
        assert_eq!(fs::read_to_string(d.path().join("f.txt")).unwrap(), "one");
        #[cfg(unix)]
        {
            op(json!({ "op": "symlink", "target": "f.txt", "path": p("ln") })).unwrap();
            assert_eq!(op(json!({ "op": "stat", "path": p("ln"), "lstat": true })).unwrap()["kind"], "symlink");
            assert_eq!(op(json!({ "op": "readlink", "path": p("ln") })).unwrap(), "f.txt");
            op(json!({ "op": "chmod", "path": p("f.txt"), "mode": 0o600 })).unwrap();
            assert_eq!(op(json!({ "op": "stat", "path": p("f.txt") })).unwrap()["mode"].as_u64().unwrap() & 0o777, 0o600);
        }
    }

    fn collect(rx: &mpsc::Receiver<ProcEvent>) -> (String, String, Vec<ProcEvent>) {
        let (mut out, mut err, mut rest) = (vec![], vec![], vec![]);
        loop {
            let ev = rx.recv_timeout(Duration::from_secs(10)).expect("process events");
            match &ev {
                ProcEvent::Stdout { data, .. } => out.extend(B64.decode(data).unwrap()),
                ProcEvent::Stderr { data, .. } => err.extend(B64.decode(data).unwrap()),
                ProcEvent::Exit { .. } => rest.push(ev),
                ProcEvent::Close { .. } => {
                    rest.push(ev);
                    break;
                }
            }
        }
        (String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap(), rest)
    }

    #[cfg(unix)]
    #[test]
    fn spawn_streams_output_stdin_and_exit_in_node_order() {
        let d = tmp();
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let req = SpawnReq { id: 7, file: "/bin/sh".into(), args: vec!["-c".into(), "pwd; cat; echo oops >&2; exit 3".into()], ..Default::default() };
        let p = spawn_process(&req, d.path(), move |e| tx.lock().unwrap().send(e).unwrap()).unwrap();
        assert!(p.pid > 0);
        write_stdin(&p, b"from stdin\n", true).unwrap();
        let (out, err, rest) = collect(&rx);
        let cwd = fs::canonicalize(d.path()).unwrap();
        assert_eq!(out, format!("{}\nfrom stdin\n", cwd.display()), "default cwd is the vault root");
        assert_eq!(err, "oops\n");
        assert_eq!(rest, vec![ProcEvent::Exit { id: 7, code: Some(3), signal: None }, ProcEvent::Close { id: 7, code: Some(3), signal: None }]);
    }

    #[cfg(unix)]
    #[test]
    fn spawn_env_cwd_kill_and_missing_binary() {
        let d = tmp();
        fs::create_dir(d.path().join("sub")).unwrap();
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let env = BTreeMap::from([("FOO".to_string(), "bar".to_string()), ("PATH".to_string(), std::env::var("PATH").unwrap())]);
        let req = SpawnReq {
            id: 1,
            file: "sh".into(),
            args: vec!["-c".into(), "echo $FOO $HOME; basename $(pwd)".into()],
            env: Some(env),
            cwd: Some("sub".into()),
            ..Default::default()
        };
        spawn_process(&req, d.path(), move |e| tx.lock().unwrap().send(e).unwrap()).unwrap();
        assert_eq!(collect(&rx).0, "bar\nsub\n", "env replaces the environment; relative cwd resolves against the vault");

        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let p = spawn_process(&SpawnReq { id: 2, file: "sleep".into(), args: vec!["30".into()], ..Default::default() }, d.path(), move |e| {
            tx.lock().unwrap().send(e).unwrap()
        })
        .unwrap();
        assert!(p.kill(None).unwrap());
        let (_, _, rest) = collect(&rx);
        assert_eq!(rest[0], ProcEvent::Exit { id: 2, code: None, signal: Some("SIGTERM".into()) });
        assert!(!p.kill(None).unwrap(), "already reaped");

        let e = spawn_process(&SpawnReq { file: "definitely-not-a-binary-xyz".into(), ..Default::default() }, d.path(), |_| {}).err().unwrap();
        assert_eq!((e.code.as_str(), e.errno, e.syscall.as_str()), ("ENOENT", -2, "spawn definitely-not-a-binary-xyz"));
    }

    #[test]
    fn spawn_git_version() {
        let d = tmp();
        let r = spawn_sync(
            SpawnSyncReq { spawn: SpawnReq { file: "git".into(), args: vec!["--version".into()], ..Default::default() }, ..Default::default() },
            d.path(),
        );
        if r["error"]["code"] == "ENOENT" {
            return; // git not installed on this machine
        }
        assert_eq!(r["status"], 0);
        assert!(String::from_utf8(B64.decode(r["stdout"].as_str().unwrap()).unwrap()).unwrap().starts_with("git version"));
    }

    #[cfg(unix)]
    #[test]
    fn spawn_sync_input_timeout_and_buffer() {
        let d = tmp();
        let sh = |cmd: &str| SpawnReq { file: "/bin/sh".into(), args: vec!["-c".into(), cmd.into()], ..Default::default() };
        let r = spawn_sync(SpawnSyncReq { spawn: sh("tr a-z A-Z"), input: Some(B64.encode("hello")), ..Default::default() }, d.path());
        assert_eq!(B64.decode(r["stdout"].as_str().unwrap()).unwrap(), b"HELLO");
        assert_eq!(r["status"], 0);
        let t = Instant::now();
        let r = spawn_sync(SpawnSyncReq { spawn: sh("sleep 5"), timeout: Some(100), ..Default::default() }, d.path());
        assert!(t.elapsed() < Duration::from_secs(3));
        assert_eq!((r["error"]["code"].as_str(), r["signal"].as_str()), (Some("ETIMEDOUT"), Some("SIGTERM")));
        let r = spawn_sync(SpawnSyncReq { spawn: sh("printf 0123456789"), max_buffer: Some(4), ..Default::default() }, d.path());
        assert_eq!(r["error"]["code"], "ENOBUFS");
        assert_eq!(B64.decode(r["stdout"].as_str().unwrap()).unwrap(), b"0123");
        let r = spawn_sync(SpawnSyncReq { spawn: SpawnReq { file: "no-such-binary-xyz".into(), ..Default::default() }, ..Default::default() }, d.path());
        assert_eq!(r["error"]["code"], "ENOENT");
    }

    #[test]
    fn deactivation_kills_running_processes() {
        let b = Bridge::default();
        let d = tmp();
        b.set_active(d.path(), true, true);
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let (file, args) = if cfg!(windows) { ("ping", vec!["-n", "30", "127.0.0.1"]) } else { ("sleep", vec!["30"]) };
        let req = SpawnReq { id: 9, file: file.into(), args: args.into_iter().map(String::from).collect(), ..Default::default() };
        let p = spawn_process(&req, d.path(), move |e| tx.lock().unwrap().send(e).unwrap()).unwrap();
        b.procs.lock().unwrap().insert(9, p);
        b.set_active(d.path(), false, true);
        let (_, _, rest) = collect(&rx);
        assert!(matches!(rest[0], ProcEvent::Exit { id: 9, .. }));
    }
}
