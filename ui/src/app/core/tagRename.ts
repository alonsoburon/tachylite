// Rename a tag across the vault: inline tags in note bodies and `tags`/`tag` properties, including nested children.
import { type App, TFile } from "../../obsidian";

const fold = (s: string) => s.normalize("NFC").toLowerCase();

export function validateTagName(name: string): string | null {
  const n = name.replace(/^#/, "");
  if (!n) return "A tag cannot be empty.";
  if (!/^[\p{L}\p{N}_\-/]+$/u.test(n)) return "Tags may only contain letters, numbers, underscores, hyphens and slashes.";
  if (/^\d+$/.test(n.replace(/\//g, ""))) return "A tag must contain at least one non-numerical character.";
  if (n.split("/").some((s) => !s)) return "A tag cannot have empty parts.";
  return null;
}

/** `#old` -> `#new`, keeping the tail of nested tags (`#old/sub` -> `#new/sub`); null when it is not `old` or below it. */
function renamed(tag: string, from: string, to: string): string | null {
  const body = tag.replace(/^#/, "");
  if (fold(body) === fold(from)) return to;
  if (fold(body).startsWith(fold(from) + "/")) return to + body.slice(from.length);
  return null;
}

/** Returns how many notes changed. */
export async function renameTag(app: App, fromTag: string, toTag: string): Promise<number> {
  const from = fromTag.replace(/^#/, ""), to = toTag.replace(/^#/, "");
  let changed = 0;
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    const hits = (cache.tags ?? []).filter((t) => renamed(t.tag, from, to) !== null);
    let touched = false;
    if (hits.length) {
      const text = await app.vault.read(file);
      let out = text;
      for (const t of [...hits].sort((a, b) => b.position.start.offset - a.position.start.offset)) {
        const at = t.position.start.offset;
        if (out.slice(at, at + t.tag.length) !== t.tag) continue; // the note changed since it was indexed
        out = out.slice(0, at) + "#" + renamed(t.tag, from, to) + out.slice(at + t.tag.length);
      }
      if (out !== text) { await app.vault.modify(file, out); touched = true; }
    }
    const fm = cache.frontmatter;
    const has = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : []).some((x) => typeof x === "string" && renamed(x.replace(/^#/, ""), from, to) !== null);
    if (fm && (has(fm.tags) || has(fm.tag))) {
      await app.fileManager.processFrontMatter(file as TFile, (f) => {
        for (const key of ["tags", "tag"]) {
          const v = f[key];
          const map = (x: string) => renamed(x.replace(/^#/, ""), from, to) ?? x;
          if (Array.isArray(v)) f[key] = v.map((x) => (typeof x === "string" ? map(x) : x));
          else if (typeof v === "string" && has(v)) f[key] = v.split(/([,\s]+)/).map((p, i) => (i % 2 ? p : map(p))).join("");
        }
      });
      touched = true;
    }
    if (touched) changed++;
  }
  return changed;
}
