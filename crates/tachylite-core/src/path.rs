//! Vault path helpers. Vault paths are always `/`-separated, relative to the vault root.

pub fn basename(p: &str) -> &str {
    p.rsplit_once('/').map_or(p, |(_, b)| b)
}

pub fn dirname(p: &str) -> &str {
    p.rsplit_once('/').map_or("", |(d, _)| d)
}

/// Extension without the dot, lowercased. Dotfiles and trailing dots have none.
pub fn extension(p: &str) -> String {
    let b = basename(p);
    match b.rfind('.') {
        Some(i) if i != 0 && i != b.len() - 1 => b[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// File name without its extension.
pub fn stem(p: &str) -> &str {
    let b = basename(p);
    match b.rfind('.') {
        Some(i) if i != 0 && i != b.len() - 1 => &b[..i],
        _ => b,
    }
}

/// Path without its extension.
pub fn strip_ext(p: &str) -> &str {
    match p.rfind('.') {
        Some(i) if i != 0 && i != p.len() - 1 => &p[..i],
        _ => p,
    }
}

/// Collapse repeated separators and trim leading/trailing ones.
pub fn normalize(p: &str) -> String {
    let p = p.replace('\\', "/");
    p.split('/').filter(|s| !s.is_empty() && *s != ".").collect::<Vec<_>>().join("/")
}

/// True when any segment starts with a dot (hidden by the vault indexer).
pub fn is_hidden(p: &str) -> bool {
    p.split('/').any(|s| s.starts_with('.'))
}

/// Characters Obsidian refuses in file names.
pub fn is_valid_file_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['*', '"', '\\', '/', '<', '>', ':', '|', '?'])
}

/// Drop the `\\?\` prefix Windows' `canonicalize` adds when the rest is an ordinary drive or UNC path
/// (`\\?\C:\v` -> `C:\v`, `\\?\UNC\srv\share` -> `\\srv\share`), so the vault's base path looks like the one
/// users and plugins know. Other strings are returned unchanged.
pub fn simplify_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    match p.strip_prefix(r"\\?\") {
        Some(rest) if rest.len() >= 3 && rest.as_bytes()[0].is_ascii_alphabetic() && &rest[1..3] == r":\" => rest.to_string(),
        _ => p.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_handles_windows_separators() {
        assert_eq!(normalize(r"Folder\Sub\note.md"), "Folder/Sub/note.md");
        assert_eq!(normalize("/a//b/./c/"), "a/b/c");
    }

    #[test]
    fn verbatim_prefixes_are_simplified() {
        assert_eq!(simplify_verbatim(r"\\?\C:\Users\me\Vault"), r"C:\Users\me\Vault");
        assert_eq!(simplify_verbatim(r"\\?\UNC\server\share\Vault"), r"\\server\share\Vault");
        assert_eq!(simplify_verbatim(r"\\?\Volume{1234}\x"), r"\\?\Volume{1234}\x");
        assert_eq!(simplify_verbatim("/home/me/Vault"), "/home/me/Vault");
    }
}
