//! A vault plus its metadata cache: the unit the app and plugins operate on.
//! Operations that must keep the link graph consistent (rename, delete) live here.

use crate::metadata::{split_subpath, MetadataCache};
use crate::path::{extension, normalize};
use crate::vault::{Result, TrashMode, Vault, VaultFile};
use std::collections::{BTreeMap, BTreeSet};
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

    /// Delete following the vault's `trashOption`; returns where the file went.
    pub fn delete(&mut self, path: &str) -> Result<TrashMode> {
        let m = self.vault.delete(path)?;
        self.meta = MetadataCache::build(&self.vault);
        Ok(m)
    }

    /// Delete with an explicit mode, ignoring the vault's `trashOption`.
    pub fn delete_mode(&mut self, path: &str, mode: TrashMode) -> Result<TrashMode> {
        let m = self.vault.delete_mode(path, mode)?;
        self.meta = MetadataCache::build(&self.vault);
        Ok(m)
    }

    /// Rename or move a file, rewriting links in other notes when `alwaysUpdateLinks` is on
    /// (or `force_update_links`). Returns the paths of notes whose links were rewritten.
    pub fn rename(&mut self, from: &str, to: &str, force_update_links: bool) -> Result<Vec<String>> {
        self.rename_opt(from, to, force_update_links.then_some(true))
    }

    /// Like `rename`, but `update_links` overrides the vault setting: `Some(false)` never rewrites
    /// links, `Some(true)` always does, `None` follows `alwaysUpdateLinks`.
    ///
    /// `from` may be a file or a folder. Links (body, embeds and frontmatter) that pointed at a moved file are
    /// regenerated with the vault's link format; links inside moved notes are rewritten only when the move
    /// would otherwise break them (e.g. relative paths).
    pub fn rename_opt(&mut self, from: &str, to: &str, update_links: Option<bool>) -> Result<Vec<String>> {
        let (from, to) = (normalize(from), normalize(to));
        let update = update_links.unwrap_or_else(|| self.vault.config.always_update_links());
        // Every file that moves, old path -> new path.
        let moved: BTreeMap<String, String> = if self.vault.get(&from).is_some() {
            BTreeMap::from([(from.clone(), to.clone())])
        } else {
            let prefix = format!("{from}/");
            self.vault.files().filter_map(|f| f.path.strip_prefix(&prefix).map(|rest| (f.path.clone(), format!("{to}/{rest}")))).collect()
        };
        // Snapshot, before moving, every note that may need edits and what each of its links resolved to.
        let mut plans: Vec<(String, String, Vec<LinkRef>)> = vec![];
        if update {
            let mut srcs: BTreeSet<String> = moved.keys().filter(|p| extension(p) == "md").cloned().collect();
            for old in moved.keys() {
                srcs.extend(self.meta.backlinks(old).into_keys());
            }
            for src in srcs {
                let Ok(text) = self.vault.read(&src) else { continue };
                let refs: Vec<LinkRef> = link_refs(&text)
                    .into_iter()
                    .filter_map(|r| {
                        let (lp, _) = split_subpath(&r.link);
                        if lp.is_empty() {
                            return None;
                        }
                        let target = self.meta.first_linkpath_dest(lp, &src)?;
                        Some(LinkRef { target: Some(target), ..r })
                    })
                    .collect();
                if !refs.is_empty() {
                    plans.push((src, text, refs));
                }
            }
        }
        self.vault.rename(&from, &to)?;
        self.meta = MetadataCache::build(&self.vault);
        let mut changed = vec![];
        for (src, text, refs) in plans {
            let new_src = moved.get(&src).cloned().unwrap_or_else(|| src.clone());
            let mut edits: Vec<(usize, usize, String)> = vec![];
            for r in refs {
                let old_target = r.target.clone().unwrap();
                let new_target = moved.get(&old_target).cloned().unwrap_or(old_target.clone());
                let (lp, sub) = split_subpath(&r.link);
                let still_ok = self.meta.first_linkpath_dest(lp, &new_src).as_deref() == Some(new_target.as_str());
                if !moved.contains_key(&old_target) && still_ok {
                    continue;
                }
                let new_text = self.meta.file_to_linktext(&self.vault, &new_target, &new_src, extension(&new_target) == "md");
                let replacement = render_link(&r, &new_text, sub, &new_target);
                if replacement != r.original {
                    edits.push((r.start, r.end, replacement));
                }
            }
            if edits.is_empty() {
                continue;
            }
            let mut out = text.clone();
            edits.sort_by_key(|e| e.0);
            for (s, e, rep) in edits.into_iter().rev() {
                out.replace_range(s..e, &rep);
            }
            self.vault.write(&new_src, out.as_bytes())?;
            changed.push(new_src);
        }
        if !changed.is_empty() {
            self.meta = MetadataCache::build(&self.vault);
        }
        Ok(changed)
    }
}

/// One link occurrence in a note's text: byte range, how it is written, and (once resolved) its target.
#[derive(Debug, Clone)]
struct LinkRef {
    start: usize,
    end: usize,
    link: String,
    original: String,
    display: Option<String>,
    target: Option<String>,
}

/// Links, embeds and frontmatter links of `text` with byte ranges.
fn link_refs(text: &str) -> Vec<LinkRef> {
    let parsed = crate::parse::parse(text);
    let to_byte = build_u16_map(text);
    let mut out: Vec<LinkRef> = parsed
        .links
        .iter()
        .chain(parsed.embeds.iter())
        .map(|l| LinkRef {
            start: to_byte(l.position.start.offset),
            end: to_byte(l.position.end.offset),
            link: l.link.clone(),
            original: l.original.clone(),
            display: l.display_text.clone(),
            target: None,
        })
        .collect();
    // Frontmatter links carry no position: find each value's text inside the frontmatter block, in order.
    if let Some(fm) = parsed.frontmatter_position {
        let fm_end = to_byte(fm.end.offset);
        let mut from = 0;
        for l in &parsed.frontmatter_links {
            if let Some(i) = text[from..fm_end].find(&l.original) {
                let s = from + i;
                out.push(LinkRef {
                    start: s,
                    end: s + l.original.len(),
                    link: l.link.clone(),
                    original: l.original.clone(),
                    display: l.display_text.clone(),
                    target: None,
                });
                from = s + l.original.len();
            }
        }
    }
    out.sort_by_key(|r| r.start);
    out
}

/// Write a link to `new_text` in the same style as `r` (wikilink or markdown, embed, alias, subpath).
fn render_link(r: &LinkRef, new_text: &str, sub: &str, new_target: &str) -> String {
    let embed = r.original.starts_with('!');
    let bang = if embed { "!" } else { "" };
    if r.original.trim_start_matches('!').starts_with("[[") {
        // Keep an explicit alias (`[[x|alias]]`, `[[x\|alias]]` in tables) exactly as written.
        let inner = &r.original[bang.len() + 2..r.original.len() - 2];
        let alias = inner.find('|').map(|i| if i > 0 && inner.as_bytes()[i - 1] == b'\\' { &inner[i - 1..] } else { &inner[i..] });
        format!("{bang}[[{new_text}{sub}{}]]", alias.unwrap_or(""))
    } else {
        let ext = if extension(new_target) == "md" && !new_text.ends_with(".md") { ".md" } else { "" };
        let dest = format!("{new_text}{ext}{sub}").replace(' ', "%20");
        format!("{bang}[{}]({dest})", r.display.clone().unwrap_or_default())
    }
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
