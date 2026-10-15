/** A link under a text position, as `editor:follow-link` needs it. */
export interface LinkAt { kind: "wiki" | "markdown"; target: string; external: boolean }

const WIKI = /!?\[\[([^\[\]]*?)\]\]/g;
const MARKDOWN = /!?\[[^\[\]]*\]\(\s*(<[^>]*>|[^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s+"[^"]*")?\s*\)/g;

/** The `[[wikilink]]` or `[text](target)` that contains column `ch` of `line`, if any. */
export function linkAt(line: string, ch: number): LinkAt | null {
  for (const m of line.matchAll(WIKI)) {
    const from = m.index!, to = from + m[0].length;
    if (ch < from || ch > to) continue;
    const target = m[1].split("|")[0].trim();
    return target ? { kind: "wiki", target, external: false } : null;
  }
  for (const m of line.matchAll(MARKDOWN)) {
    const from = m.index!, to = from + m[0].length;
    if (ch < from || ch > to) continue;
    const raw = m[1].replace(/^<|>$/g, "").trim();
    if (!raw) return null;
    return { kind: "markdown", target: raw, external: /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw) };
  }
  return null;
}
