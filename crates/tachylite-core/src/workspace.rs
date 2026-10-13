//! A vault plus its metadata cache: the unit the app and plugins operate on.
//! Operations that must keep the link graph consistent (rename, delete) live here.

use crate::metadata::{split_subpath, MetadataCache};
use crate::path::{basename, dirname, extension, normalize, strip_ext};
use crate::vault::{Result, Vault, VaultFile};
use std::path::Path;

pub struct Workspace {
    pub vault: Vault,
    pub meta: MetadataCache,
}

impl Workspace {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let vault = Vault::open(root)?;
        let meta = MetadataCache::build(&vault);
        Ok(Workspace { vault, meta })
    }

    pub fn write(&mut self, path: &str, data: &str) -> Result<VaultFile> {
        let f = self.vault.write(path, data.as_bytes())?;
        self.meta.update_file(&self.vault, &f.path);
        Ok(f)
    }

    pub fn create(&mut self, path: &str, data: &str) -> Result<VaultFile> {
        let f = self.vault.create(path, data.as_bytes())?;
        self.meta.update_file(&self.vault, &f.path);
        Ok(f)
    }

    pub fn delete(&mut self, path: &str) -> Result<()> {
        self.vault.delete(path)?;
        self.meta = MetadataCache::build(&self.vault);
        Ok(())
    }

    /// Delete into `.trash` (`permanent == false`) or for good, ignoring the vault's `trashOption`.
    pub fn delete_mode(&mut self, path: &str, permanent: bool) -> Result<()> {
        self.vault.delete_mode(path, permanent)?;
        self.meta = MetadataCache::build(&self.vault);
        Ok(())
    }

    /// Rename or move a file, rewriting links in other notes when `alwaysUpdateLinks` is on
    /// (or `force_update_links`). Returns the paths of notes whose links were rewritten.
    pub fn rename(&mut self, from: &str, to: &str, force_update_links: bool) -> Result<Vec<String>> {
        self.rename_opt(from, to, force_update_links.then_some(true))
    }

    /// Like `rename`, but `update_links` overrides the vault setting: `Some(false)` never rewrites
    /// links, `Some(true)` always does, `None` follows `alwaysUpdateLinks`.
    pub fn rename_opt(&mut self, from: &str, to: &str, update_links: Option<bool>) -> Result<Vec<String>> {
        let (from, to) = (normalize(from), normalize(to));
        let update = update_links.unwrap_or_else(|| self.vault.config.always_update_links());
        let linkers: Vec<String> = if update { self.meta.backlinks(&from).into_keys().collect() } else { vec![] };
        // Snapshot how each linker referred to the file before moving.
        let mut edits = vec![];
        for src in &linkers {
            if let Ok(text) = self.vault.read(src) {
                edits.push((src.clone(), text));
            }
        }
        self.vault.rename(&from, &to)?;
        self.meta = MetadataCache::build(&self.vault);
        let mut changed = vec![];
        for (src, text) in edits {
            let new_src = if src == from { to.clone() } else { src.clone() };
            let rewritten = rewrite_links(&text, &src, &from, &to, &self.meta, &self.vault, &new_src);
            if rewritten != text {
                self.vault.write(&new_src, rewritten.as_bytes())?;
                changed.push(new_src);
            }
        }
        if !changed.is_empty() {
            self.meta = MetadataCache::build(&self.vault);
        }
        Ok(changed)
    }
}

/// Rewrite wikilinks and markdown links in `text` (a note at `src`) that pointed at `from` so they
/// point at `to`, preserving subpaths and aliases and using the vault's link-format settings.
fn rewrite_links(text: &str, src: &str, from: &str, to: &str, meta: &MetadataCache, vault: &Vault, new_src: &str) -> String {
    let parsed = crate::parse::parse(text);
    // Resolve against the *old* name by rebuilding a tiny lookup: a link targeted `from` if its
    // linkpath equals the old name/path in any accepted spelling.
    let was_target = |linkpath: &str| {
        let lp = linkpath.to_lowercase();
        let f = from.to_lowercase();
        let cands = [f.clone(), strip_ext(&f).to_string(), basename(&f).to_string(), strip_ext(basename(&f)).to_string()];
        cands.iter().any(|c| {
            lp == *c || f.ends_with(&format!("/{lp}")) || f.ends_with(&format!("/{lp}.md")) && extension(&f) == "md" && !lp.is_empty() && !lp.contains("..")
        }) || (src != from && meta_resolves_old(linkpath, src, from))
    };
    let mut edits: Vec<(usize, usize, String)> = vec![];
    let mut all: Vec<&crate::parse::LinkCache> = parsed.links.iter().chain(parsed.embeds.iter()).collect();
    all.sort_by_key(|l| l.position.start.offset);
    let u16_to_byte = build_u16_map(text);
    for l in all {
        let (lp, sub) = split_subpath(&l.link);
        if lp.is_empty() || !was_target(lp) {
            continue;
        }
        let new_text = meta.file_to_linktext(vault, to, new_src, extension(to) == "md");
        let is_wiki = l.original.contains("[[");
        let embed = l.original.starts_with('!');
        let alias = l.display_text.as_deref().filter(|d| *d != l.link);
        let new_original = if is_wiki {
            let mut s = format!("{}[[{new_text}{sub}", if embed { "!" } else { "" });
            if let Some(a) = alias {
                s.push('|');
                s.push_str(a);
            }
            s.push_str("]]");
            s
        } else {
            let enc = format!("{new_text}{}", if extension(to) == "md" && !new_text.ends_with(".md") { ".md" } else { "" }).replace(' ', "%20");
            format!("{}[{}]({enc}{sub})", if embed { "!" } else { "" }, l.display_text.clone().unwrap_or_default())
        };
        let (s, e) = (u16_to_byte(l.position.start.offset), u16_to_byte(l.position.end.offset));
        edits.push((s, e, new_original));
    }
    let mut out = text.to_string();
    for (s, e, r) in edits.into_iter().rev() {
        out.replace_range(s..e, &r);
    }
    let _ = dirname;
    out
}

/// A link written relative to `src` (e.g. `../a/b`) may not match `from` textually;
/// accept it when stripping `..`/`.` segments yields a path-suffix of `from`.
fn meta_resolves_old(linkpath: &str, src: &str, from: &str) -> bool {
    let mut parts: Vec<&str> = dirname(src).split('/').filter(|s| !s.is_empty()).collect();
    for seg in linkpath.split('/') {
        match seg {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    let joined = parts.join("/").to_lowercase();
    let f = from.to_lowercase();
    joined == f || format!("{joined}.md") == f
}

fn build_u16_map(text: &str) -> impl Fn(usize) -> usize + '_ {
    move |u16_off| {
        let mut units = 0;
        for (b, c) in text.char_indices() {
            if units >= u16_off {
                return b;
            }
            units += c.len_utf16();
        }
        text.len()
    }
}
