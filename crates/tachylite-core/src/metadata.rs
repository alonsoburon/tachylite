//! Metadata cache and link graph. Link resolution follows Obsidian's observable rules:
//! lookup by lowercase file name, path-qualified links match as path suffixes, relative
//! (`./`, `../`) links resolve against the source folder, and ties prefer the source's
//! own folder, then the shortest path.

use crate::canvas::canvas_links;
use crate::parse::{self, CachedMetadata};
use crate::path::{basename, dirname, extension, strip_ext};
use crate::vault::Vault;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Default)]
pub struct MetadataCache {
    cache: BTreeMap<String, CachedMetadata>,
    /// lowercase file name (with extension) -> vault paths
    lookup: HashMap<String, Vec<String>>,
    /// all vault paths (exact), for direct resolution
    paths: HashMap<String, String>,
    /// source path -> (target path -> count)
    pub resolved_links: BTreeMap<String, BTreeMap<String, usize>>,
    /// source path -> (unresolved link text -> count)
    pub unresolved_links: BTreeMap<String, BTreeMap<String, usize>>,
    /// `.canvas` path -> link paths its nodes reference (see `canvas::canvas_links`)
    canvas: BTreeMap<String, Vec<String>>,
}

/// Split `path#subpath` into its parts (subpath keeps the leading `#`).
pub fn split_subpath(link: &str) -> (&str, &str) {
    match link.find('#') {
        Some(i) => (&link[..i], &link[i..]),
        None => (link, ""),
    }
}

impl MetadataCache {
    pub fn build(vault: &Vault) -> Self {
        let mut c = MetadataCache::default();
        for f in vault.files() {
            c.register(&f.path);
        }
        for f in vault.markdown_files() {
            if let Ok(text) = vault.read(&f.path) {
                c.cache.insert(f.path.clone(), parse::parse(&text));
            }
        }
        for f in vault.files().filter(|f| f.extension == "canvas") {
            if let Ok(text) = vault.read(&f.path) {
                c.canvas.insert(f.path.clone(), canvas_links(&text));
            }
        }
        c.resolve_all();
        c
    }

    fn register(&mut self, path: &str) {
        let key = basename(path).to_lowercase();
        let v = self.lookup.entry(key).or_default();
        if !v.iter().any(|p| p == path) {
            v.push(path.to_string());
        }
        self.paths.insert(path.to_string(), path.to_string());
    }

    fn unregister(&mut self, path: &str) {
        if let Some(v) = self.lookup.get_mut(&basename(path).to_lowercase()) {
            v.retain(|p| p != path);
        }
        self.paths.remove(path);
    }

    pub fn get(&self, path: &str) -> Option<&CachedMetadata> {
        self.cache.get(path)
    }

    /// Update a single file after create/modify.
    pub fn update_file(&mut self, vault: &Vault, path: &str) {
        if vault.get(path).is_none() {
            return self.remove_file(path);
        }
        self.register(path);
        if extension(path) == "md" {
            if let Ok(text) = vault.read(path) {
                self.cache.insert(path.to_string(), parse::parse(&text));
            }
        } else if extension(path) == "canvas" {
            self.canvas.insert(path.to_string(), vault.read(path).map(|t| canvas_links(&t)).unwrap_or_default());
        }
        self.resolve_all();
    }

    pub fn remove_file(&mut self, path: &str) {
        self.unregister(path);
        self.cache.remove(path);
        self.canvas.remove(path);
        self.resolved_links.remove(path);
        self.unresolved_links.remove(path);
        self.resolve_all();
    }

    fn resolve_all(&mut self) {
        let mut resolved = BTreeMap::new();
        let mut unresolved = BTreeMap::new();
        let notes = self.cache.iter().map(|(src, meta)| {
            let refs: Vec<&str> = meta
                .links
                .iter()
                .map(|l| l.link.as_str())
                .chain(meta.embeds.iter().map(|l| l.link.as_str()))
                .chain(meta.frontmatter_links.iter().map(|l| l.link.as_str()))
                .collect();
            (src, refs)
        });
        let canvases = self.canvas.iter().map(|(src, links)| (src, links.iter().map(String::as_str).collect::<Vec<_>>()));
        for (src, refs) in notes.chain(canvases) {
            let mut r: BTreeMap<String, usize> = BTreeMap::new();
            let mut u: BTreeMap<String, usize> = BTreeMap::new();
            for link in refs {
                let (p, _) = split_subpath(link);
                match self.first_linkpath_dest(p, src) {
                    Some(t) => *r.entry(t).or_default() += 1,
                    None => *u.entry(p.to_string()).or_default() += 1,
                }
            }
            resolved.insert(src.clone(), r);
            unresolved.insert(src.clone(), u);
        }
        self.resolved_links = resolved;
        self.unresolved_links = unresolved;
    }

    pub fn first_linkpath_dest(&self, linkpath: &str, source: &str) -> Option<String> {
        self.linkpath_dest(linkpath, source).into_iter().next()
    }

    /// Candidate files for a link path (without `#subpath`), best first.
    pub fn linkpath_dest(&self, linkpath: &str, source: &str) -> Vec<String> {
        if linkpath.is_empty() {
            return if self.paths.contains_key(source) { vec![source.to_string()] } else { vec![] };
        }
        let mut target = linkpath.to_lowercase();
        let mut name = basename(&target).to_string();
        let mut found: Option<&Vec<String>> = None;
        if name.contains('.') {
            found = self.lookup.get(&name).filter(|c| !c.is_empty());
        }
        if found.is_none() {
            target = format!("{linkpath}.md").to_lowercase();
            name = basename(&target).to_string();
            found = self.lookup.get(&name);
        }
        let Some(cands) = found.filter(|c| !c.is_empty()) else { return vec![] };
        if name == target && cands.len() == 1 {
            return cands.clone();
        }
        let mut src_dir = dirname(source).to_lowercase();
        if target.starts_with("./") || target.starts_with("../") {
            if target.starts_with("./../") {
                target = target[2..].to_string();
            }
            if let Some(rest) = target.strip_prefix("./") {
                if !src_dir.is_empty() {
                    src_dir.push('/');
                }
                target = format!("{src_dir}{rest}");
            } else {
                while let Some(rest) = target.strip_prefix("../") {
                    target = rest.to_string();
                    src_dir = dirname(&src_dir).to_string();
                }
                if !src_dir.is_empty() {
                    src_dir.push('/');
                }
                target = format!("{src_dir}{target}");
            }
            if let Some(c) = cands.iter().find(|c| c.to_lowercase() == target) {
                return vec![c.clone()];
            }
        }
        let target = target.strip_prefix('/').unwrap_or(&target).to_string();
        if let Some(c) = cands.iter().find(|c| c.to_lowercase() == target) {
            return vec![c.clone()];
        }
        if linkpath.starts_with('/') {
            return vec![];
        }
        // Suffix and folder tests are plain string prefix/suffix checks, not segment-aware: `older/Note`
        // matches `Folder/Note.md`, and a source in `a` counts `ab/x.md` as near (observed app behaviour).
        let (mut near, mut far): (Vec<String>, Vec<String>) = (vec![], vec![]);
        for c in cands {
            let lc = c.to_lowercase();
            if lc.ends_with(&target) {
                if lc.starts_with(&src_dir) {
                    near.push(c.clone())
                } else {
                    far.push(c.clone())
                }
            }
        }
        near.sort_by_key(String::len);
        far.sort_by_key(String::len);
        near.extend(far);
        near
    }

    /// Files linking to `path`, with how many links each contains.
    pub fn backlinks(&self, path: &str) -> BTreeMap<String, usize> {
        self.resolved_links.iter().filter_map(|(src, targets)| targets.get(path).map(|n| (src.clone(), *n))).collect()
    }

    /// Every tag in the vault (body and frontmatter) with usage counts. Nested tags also count toward parents.
    pub fn tags(&self) -> BTreeMap<String, usize> {
        let mut out = BTreeMap::new();
        for meta in self.cache.values() {
            for t in all_tags(meta) {
                *out.entry(t).or_insert(0) += 1;
            }
        }
        out
    }

    /// Link text Obsidian would insert for `target` when linking from `source`, per `newLinkFormat`.
    pub fn file_to_linktext(&self, vault: &Vault, target: &str, source: &str, omit_md: bool) -> String {
        let md = extension(target) == "md" && omit_md;
        let full = if md { strip_ext(target).to_string() } else { target.to_string() };
        match vault.config.new_link_format().as_str() {
            "absolute" => return full,
            "relative" => {
                let mut up = String::new();
                let mut d = dirname(source).to_string();
                while !d.is_empty() && !full.starts_with(&format!("{d}/")) {
                    up.push_str("../");
                    d = dirname(&d).to_string();
                }
                return if d.is_empty() { format!("{up}{full}") } else { format!("{up}{}", &full[d.len() + 1..]) };
            }
            _ => {}
        }
        let short = if md { vault.get(target).map_or_else(|| basename(target).to_string(), |f| f.basename.clone()) } else { basename(target).to_string() };
        let dests = self.linkpath_dest(&short, source);
        if dests.len() == 1 && dests[0] == target {
            short
        } else {
            full
        }
    }
}

/// Tags of one file: body tags plus frontmatter `tags`/`tag`, each expanded with its parents.
pub fn all_tags(meta: &CachedMetadata) -> Vec<String> {
    let mut raw: Vec<String> = meta.tags.iter().map(|t| t.tag.clone()).collect();
    if let Some(fm) = &meta.frontmatter {
        for key in ["tags", "tag"] {
            match fm.get(key) {
                Some(serde_json::Value::String(s)) => {
                    raw.extend(s.split([',', ' ']).filter(|x| !x.is_empty()).map(|x| format!("#{}", x.trim_start_matches('#'))))
                }
                Some(serde_json::Value::Array(a)) => raw.extend(a.iter().filter_map(|v| v.as_str()).map(|x| format!("#{}", x.trim_start_matches('#')))),
                _ => {}
            }
        }
    }
    let mut out = vec![];
    for t in raw {
        let mut acc = String::new();
        for (i, seg) in t.split('/').enumerate() {
            if i > 0 {
                acc.push('/');
            }
            acc.push_str(seg);
            if !out.contains(&acc) {
                out.push(acc.clone());
            }
        }
    }
    out
}

/// Heading text as compared by subpath lookups: punctuation folded to spaces, whitespace collapsed
/// (the same rule as `stripHeading` in ui/src/obsidian/util.ts).
pub fn strip_heading(h: &str) -> String {
    let folded: String = h.chars().map(|c| if c.is_ascii_punctuation() && c != '_' && c != '-' && c != '\'' { ' ' } else { c }).collect();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Result of resolving `#Heading#Sub` / `#^block` against a note, shaped like the plugin API's `resolveSubpath`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SubpathResult {
    Heading { current: crate::parse::HeadingCache, next: Option<crate::parse::HeadingCache>, start: crate::parse::Loc, end: Option<crate::parse::Loc> },
    Block { block: crate::parse::BlockCache, start: crate::parse::Loc, end: crate::parse::Loc },
}

/// Resolve a link subpath. Block ids match case-insensitively; heading chains (`#A#B`) match each part
/// case-insensitively inside the section of the previous part.
pub fn resolve_subpath(meta: &CachedMetadata, subpath: &str) -> Option<SubpathResult> {
    let sp = subpath.strip_prefix('#').unwrap_or(subpath);
    if let Some(id) = sp.strip_prefix('^') {
        let b = meta.blocks.get(&id.to_lowercase())?;
        return Some(SubpathResult::Block { block: b.clone(), start: b.position.start, end: b.position.end });
    }
    let parts: Vec<String> = sp.split('#').map(|p| strip_heading(p).to_lowercase()).filter(|p| !p.is_empty()).collect();
    let hs = &meta.headings;
    let (mut from, mut cur): (usize, Option<usize>) = (0, None);
    for part in parts {
        let mut found = None;
        for (i, h) in hs.iter().enumerate().skip(from) {
            if cur.is_some_and(|c| h.level <= hs[c].level) {
                break;
            }
            if strip_heading(&h.heading).to_lowercase() == part {
                found = Some(i);
                break;
            }
        }
        let f = found?;
        cur = Some(f);
        from = f + 1;
    }
    let c = cur?;
    let next = hs[c + 1..].iter().find(|h| h.level <= hs[c].level).cloned();
    Some(SubpathResult::Heading { current: hs[c].clone(), start: hs[c].position.start, end: next.as_ref().map(|n| n.position.start), next })
}
