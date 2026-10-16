//! The vault: a folder of files with an in-memory index, plus file operations.

use crate::config::AppConfig;
use crate::path::{self, extension, is_hidden, normalize};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use thiserror::Error;
use walkdir::WalkDir;

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("{0}: not found")]
    NotFound(String),
    #[error("{0}: already exists")]
    Exists(String),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("could not move to the system trash: {0}")]
    Trash(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Where deleted files go (`trashOption` in `app.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrashMode {
    /// The operating system's trash / recycle bin.
    System,
    /// The vault's `.trash` folder.
    Local,
    /// Removed for good.
    Permanent,
}

impl TrashMode {
    /// `system` (default), `local`/`trash`, `none`/`permanent`.
    pub fn from_option(v: &str) -> Self {
        match v {
            "local" | "trash" => TrashMode::Local,
            "none" | "permanent" => TrashMode::Permanent,
            _ => TrashMode::System,
        }
    }
}

pub type Result<T> = std::result::Result<T, VaultError>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileStat {
    pub ctime: u64,
    pub mtime: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VaultFile {
    /// Vault-relative path with `/` separators.
    pub path: String,
    pub name: String,
    pub basename: String,
    pub extension: String,
    pub stat: FileStat,
}

impl VaultFile {
    pub fn is_markdown(&self) -> bool {
        self.extension == "md"
    }
}

fn stat_of(abs: &Path) -> io::Result<FileStat> {
    let m = fs::metadata(abs)?;
    let ms = |t: io::Result<std::time::SystemTime>| t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    Ok(FileStat { ctime: ms(m.created()), mtime: ms(m.modified()), size: m.len() })
}

fn make_file(rel: &str, abs: &Path) -> io::Result<VaultFile> {
    Ok(VaultFile {
        path: rel.to_string(),
        name: path::basename(rel).to_string(),
        basename: path::stem(rel).to_string(),
        extension: extension(rel),
        stat: stat_of(abs)?,
    })
}

#[derive(Debug)]
pub struct Vault {
    root: PathBuf,
    files: BTreeMap<String, VaultFile>,
    folders: Vec<String>,
    pub config: AppConfig,
}

impl Vault {
    /// Open a vault folder and index it. Dot-folders (`.obsidian`, `.trash`, ...) are skipped.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().canonicalize()?;
        #[cfg(windows)]
        let root = PathBuf::from(path::simplify_verbatim(&root.to_string_lossy()));
        let config = AppConfig::load(&root);
        let mut v = Vault { root, files: BTreeMap::new(), folders: vec![], config };
        v.reindex()?;
        Ok(v)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn name(&self) -> String {
        self.root.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned())
    }

    pub fn reindex(&mut self) -> Result<()> {
        self.files.clear();
        self.folders.clear();
        let ignore = self.config.user_ignore_filters();
        for e in WalkDir::new(&self.root).min_depth(1).into_iter().filter_entry(|e| {
            let rel = e.path().strip_prefix(&self.root).unwrap_or(e.path());
            let rel = normalize(&rel.to_string_lossy());
            !is_hidden(&rel) && !ignored(&rel, &ignore)
        }) {
            let e = e.map_err(io::Error::other)?;
            let rel = normalize(&e.path().strip_prefix(&self.root).unwrap().to_string_lossy());
            if e.file_type().is_dir() {
                self.folders.push(rel);
            } else if e.file_type().is_file() {
                self.files.insert(rel.clone(), make_file(&rel, e.path())?);
            }
        }
        Ok(())
    }

    pub fn files(&self) -> impl Iterator<Item = &VaultFile> {
        self.files.values()
    }
    pub fn markdown_files(&self) -> impl Iterator<Item = &VaultFile> {
        self.files.values().filter(|f| f.is_markdown())
    }
    pub fn folders(&self) -> &[String] {
        &self.folders
    }
    pub fn get(&self, path: &str) -> Option<&VaultFile> {
        self.files.get(&normalize(path))
    }

    /// Resolve a vault path to an absolute one, refusing anything that escapes the root.
    pub fn abs(&self, rel: &str) -> Result<PathBuf> {
        let rel = normalize(rel);
        if rel.split('/').any(|s| s == "..") {
            return Err(VaultError::InvalidPath(rel));
        }
        Ok(self.root.join(rel))
    }

    /// Read a text file. A leading byte order mark (Notepad and some exporters write one) is dropped, so the
    /// frontmatter, the editor and the cached offsets all see the same text; the file keeps its BOM until it is saved.
    pub fn read(&self, rel: &str) -> Result<String> {
        let p = self.abs(rel)?;
        let text = fs::read_to_string(&p).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => VaultError::NotFound(rel.into()),
            _ => VaultError::from(e),
        })?;
        Ok(match text.strip_prefix('\u{feff}') {
            Some(rest) => rest.to_string(),
            None => text,
        })
    }

    pub fn read_binary(&self, rel: &str) -> Result<Vec<u8>> {
        fs::read(self.abs(rel)?).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => VaultError::NotFound(rel.into()),
            _ => e.into(),
        })
    }

    /// Write (create or overwrite) a file, creating parent folders. Returns the indexed file.
    pub fn write(&mut self, rel: &str, data: &[u8]) -> Result<VaultFile> {
        let rel = normalize(rel);
        let abs = self.abs(&rel)?;
        if let Some(d) = abs.parent() {
            fs::create_dir_all(d)?;
        }
        fs::write(&abs, data)?;
        self.track_folders(&rel);
        let f = make_file(&rel, &abs)?;
        self.files.insert(rel, f.clone());
        Ok(f)
    }

    /// Create a new file; fails if it already exists.
    pub fn create(&mut self, rel: &str, data: &[u8]) -> Result<VaultFile> {
        if self.abs(rel)?.exists() {
            return Err(VaultError::Exists(rel.into()));
        }
        self.write(rel, data)
    }

    pub fn create_folder(&mut self, rel: &str) -> Result<()> {
        let rel = normalize(rel);
        fs::create_dir_all(self.abs(&rel)?)?;
        self.track_folders(&format!("{rel}/x"));
        Ok(())
    }

    fn track_folders(&mut self, file_rel: &str) {
        let mut d = path::dirname(file_rel).to_string();
        while !d.is_empty() {
            if !self.folders.contains(&d) {
                self.folders.push(d.clone());
            }
            d = path::dirname(&d).to_string();
        }
    }

    /// Rename/move a file or folder. Does not rewrite links; see `Workspace::rename`.
    pub fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        let (from, to) = (normalize(from), normalize(to));
        let (a, b) = (self.abs(&from)?, self.abs(&to)?);
        if !a.exists() {
            return Err(VaultError::NotFound(from));
        }
        let to_exists = b.exists();
        match rename_plan(&from, &to, to_exists, to_exists && same_entry(&a, &b)) {
            RenamePlan::Conflict => return Err(VaultError::Exists(to)),
            RenamePlan::ViaTemp => rename_via_temp(&a, &b)?,
            RenamePlan::Direct => {
                if let Some(d) = b.parent() {
                    fs::create_dir_all(d)?;
                }
                fs::rename(&a, &b)?
            }
        }
        self.reindex()
    }

    /// Delete following the vault's `trashOption`: OS trash (`system`, the default), the vault's `.trash`
    /// folder (`local`), or permanent removal (`none`). When the OS trash is unavailable or fails, the file
    /// goes to `.trash` instead, as the app does. Returns where the file went.
    pub fn delete(&mut self, rel: &str) -> Result<TrashMode> {
        let mode = TrashMode::from_option(&self.config.trash_option());
        match self.delete_mode(rel, mode) {
            Err(VaultError::Trash(_)) if mode == TrashMode::System => self.delete_mode(rel, TrashMode::Local),
            r => r,
        }
    }

    /// Delete `rel` with an explicit mode (no fallback: a failing OS trash is an error).
    pub fn delete_mode(&mut self, rel: &str, mode: TrashMode) -> Result<TrashMode> {
        let rel = normalize(rel);
        let abs = self.abs(&rel)?;
        if !abs.exists() {
            return Err(VaultError::NotFound(rel));
        }
        match mode {
            TrashMode::Permanent => {
                if abs.is_dir() {
                    fs::remove_dir_all(&abs)?
                } else {
                    fs::remove_file(&abs)?
                }
            }
            TrashMode::System => trash::delete(&abs).map_err(|e| VaultError::Trash(e.to_string()))?,
            TrashMode::Local => {
                let mut dest = self.root.join(".trash").join(path::basename(&rel));
                let mut n = 1;
                while dest.exists() {
                    n += 1;
                    let stem = path::stem(&rel);
                    let ext = extension(&rel);
                    let name = if ext.is_empty() { format!("{stem} {n}") } else { format!("{stem} {n}.{ext}") };
                    dest = self.root.join(".trash").join(name);
                }
                fs::create_dir_all(dest.parent().unwrap())?;
                fs::rename(&abs, &dest)?;
            }
        }
        self.reindex()?;
        Ok(mode)
    }

    /// Re-stat a single file after an external change. Returns `None` if it vanished.
    pub fn refresh(&mut self, rel: &str) -> Option<VaultFile> {
        let rel = normalize(rel);
        let abs = self.root.join(&rel);
        if abs.is_file() && !is_hidden(&rel) {
            let f = make_file(&rel, &abs).ok()?;
            self.track_folders(&rel);
            self.files.insert(rel, f.clone());
            Some(f)
        } else {
            self.files.remove(&rel);
            None
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RenamePlan {
    Direct,
    /// Case-only rename on a case-insensitive file system: go through a temporary name.
    ViaTemp,
    Conflict,
}

/// `same` is true when `to` already exists and is the very entry `from` names (macOS/Windows report
/// `note.md` as existing while renaming `Note.md`). Anything else that exists is a conflict, so a
/// case-sensitive file system never overwrites a distinct `A.md` when renaming `a.md`.
fn rename_plan(from: &str, to: &str, to_exists: bool, same: bool) -> RenamePlan {
    if !to_exists || from == to {
        RenamePlan::Direct
    } else if same && from.to_lowercase() == to.to_lowercase() {
        RenamePlan::ViaTemp
    } else {
        RenamePlan::Conflict
    }
}

/// True when both paths open the same file system entry.
fn same_entry(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        matches!((fs::symlink_metadata(a), fs::symlink_metadata(b)), (Ok(x), Ok(y)) if x.dev() == y.dev() && x.ino() == y.ino())
    }
    #[cfg(windows)]
    {
        // `canonicalize` resolves to the on-disk spelling, so both spellings of one entry agree.
        matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (a, b);
        false
    }
}

/// Two-step rename through a sibling temporary name: case-insensitive file systems that ignore a direct
/// case-only rename (FAT/exFAT, some network shares) still record the new spelling.
fn rename_via_temp(a: &Path, b: &Path) -> io::Result<()> {
    let name = a.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let mut tmp = a.with_file_name(format!(".{name}.tachylite-rename"));
    let mut n = 1;
    while tmp.exists() {
        n += 1;
        tmp = a.with_file_name(format!(".{name}.tachylite-rename-{n}"));
    }
    fs::rename(a, &tmp)?;
    fs::rename(&tmp, b).inspect_err(|_| {
        let _ = fs::rename(&tmp, a);
    })
}

/// `userIgnoreFilters`: plain entries match as path prefixes/substrings; `/regex/` entries as regex.
fn ignored(rel: &str, filters: &[String]) -> bool {
    filters.iter().any(|f| {
        if f.len() > 1 && f.starts_with('/') && f.ends_with('/') {
            regex::Regex::new(&f[1..f.len() - 1]).is_ok_and(|r| r.is_match(rel))
        } else {
            let f = f.trim_end_matches('/');
            rel == f || rel.starts_with(&format!("{f}/")) || rel.contains(f)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_plan_covers_case_only_renames() {
        // Nothing at the target: plain rename (also a case-only rename on a case-sensitive file system).
        assert_eq!(rename_plan("Note.md", "note.md", false, false), RenamePlan::Direct);
        // Case-insensitive file system: the target "exists" because it is the same entry.
        assert_eq!(rename_plan("Note.md", "note.md", true, true), RenamePlan::ViaTemp);
        assert_eq!(rename_plan("Ärger.md", "ärger.md", true, true), RenamePlan::ViaTemp);
        // Case-sensitive file system with a distinct `A.md`: never overwrite it.
        assert_eq!(rename_plan("a.md", "A.md", true, false), RenamePlan::Conflict);
        // Hard links share an entry but are different names.
        assert_eq!(rename_plan("a.md", "b.md", true, true), RenamePlan::Conflict);
        assert_eq!(rename_plan("a.md", "a.md", true, true), RenamePlan::Direct);
    }

    #[test]
    fn rename_via_temp_moves_the_file() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("Note.md"), "x").unwrap();
        rename_via_temp(&d.path().join("Note.md"), &d.path().join("note.md")).unwrap();
        let names: Vec<String> = fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["note.md"]);
    }

    #[test]
    fn same_entry_detects_one_file_under_two_names() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("a.md"), "x").unwrap();
        fs::write(d.path().join("b.md"), "x").unwrap();
        assert!(same_entry(&d.path().join("a.md"), &d.path().join("./a.md")));
        assert!(!same_entry(&d.path().join("a.md"), &d.path().join("b.md")));
    }
}
