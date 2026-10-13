import * as yaml from "js-yaml";

/** GitHub-ish slug used for heading ids. Unicode aware. */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

export interface FrontmatterSplit {
  frontmatter: Record<string, unknown> | null;
  raw: string | null;
  /** Source without the frontmatter block */
  body: string;
  /** number of lines the block occupied (incl. fences) */
  lines: number;
  error?: string;
}

export function splitFrontmatter(md: string): FrontmatterSplit {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return { frontmatter: null, raw: null, body: md, lines: 0 };
  const raw = m[1];
  const lines = m[0].split("\n").length - (m[0].endsWith("\n") ? 1 : 0);
  let fm: Record<string, unknown> | null = null;
  let error: string | undefined;
  try {
    const v = yaml.load(raw);
    fm = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch (e) {
    error = String((e as Error).message ?? e);
  }
  return { frontmatter: fm, raw, body: md.slice(m[0].length), lines, error };
}

const HEADING = /^ {0,3}#{1,6}\s/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Split text into segments flagged as fenced code or not. */
export function splitFences(md: string): { text: string; code: boolean }[] {
  const lines = md.split("\n");
  const out: { text: string; code: boolean }[] = [];
  let cur: string[] = [];
  let curCode = false;
  let fence: string | null = null;
  const flush = () => {
    if (cur.length) out.push({ text: cur.join("\n"), code: curCode });
    cur = [];
  };
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? "\n" : "";
    const m = FENCE.exec(line);
    if (fence === null && m) {
      flush();
      curCode = true;
      fence = m[1];
      cur.push(line + nl);
      return;
    }
    if (fence !== null) {
      cur.push(line + nl);
      const c = FENCE.exec(line);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length && line.trim() === c[1]) {
        flush();
        fence = null;
        curCode = false;
      }
      return;
    }
    if (curCode) {
      flush();
      curCode = false;
    }
    cur.push(line + nl);
  });
  flush();
  // segments were built with embedded newlines; join with "" later
  return out;
}

/** Remove %%comments%% outside fenced code. */
export function stripComments(md: string): string {
  if (!md.includes("%%")) return md;
  return splitFences(md)
    .map((s) => (s.code ? s.text : s.text.replace(/%%[\s\S]*?%%/g, "")))
    .join("");
}

export interface SubpathPart {
  kind: "heading" | "block";
  value: string;
}

/** Parse `#Heading`, `#A#B`, `#^block` into a part (last heading wins). */
export function parseSubpath(sub: string): SubpathPart | null {
  if (!sub) return null;
  const s = sub.startsWith("#") ? sub.slice(1) : sub;
  if (!s) return null;
  if (s.startsWith("^")) return { kind: "block", value: s.slice(1) };
  const parts = s.split("#").filter(Boolean);
  const last = parts[parts.length - 1];
  if (last === undefined) return null;
  if (last.startsWith("^")) return { kind: "block", value: last.slice(1) };
  return { kind: "heading", value: last };
}

export function normHeading(t: string): string {
  return t.replace(/[\s\u00a0]+/g, " ").trim().toLowerCase();
}

/** Split a link text into linkpath and subpath (`#...` retained). */
export function splitLinktext(linktext: string): { path: string; subpath: string } {
  const i = linktext.indexOf("#");
  if (i < 0) return { path: linktext, subpath: "" };
  return { path: linktext.slice(0, i), subpath: linktext.slice(i) };
}

/** Extract the part of a markdown source addressed by a subpath. Returns null if not found. */
export function extractSubpath(md: string, subpath: string): string | null {
  const part = parseSubpath(subpath);
  if (!part) return md;
  const lines = md.split("\n");
  if (part.kind === "heading") {
    let inFence = false;
    let start = -1;
    let level = 0;
    const want = normHeading(part.value);
    for (let i = 0; i < lines.length; i++) {
      if (FENCE.test(lines[i])) inFence = !inFence;
      if (inFence) continue;
      const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
      if (!m) continue;
      if (start < 0) {
        const text = m[2].replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2");
        if (normHeading(text) === want) {
          start = i;
          level = m[1].length;
        }
      } else if (m[1].length <= level) {
        return lines.slice(start, i).join("\n").replace(/\s+$/, "");
      }
    }
    return start >= 0 ? lines.slice(start).join("\n").replace(/\s+$/, "") : null;
  }
  // block id
  const idRe = new RegExp(`(?:^|\\s)\\^${part.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (!idRe.test(lines[i])) continue;
    const isOwnLine = /^\s*\^[\w-]+\s*$/.test(lines[i]);
    const listM = /^(\s*)([-*+]|\d+[.)])\s/.exec(lines[i]);
    if (listM && !isOwnLine) {
      // list item and its more-indented children
      const indent = listM[1].length;
      let end = i + 1;
      while (end < lines.length && lines[end].trim() !== "" && /^\s*/.exec(lines[end])![0].length > indent) end++;
      return lines.slice(i, end).join("\n").replace(idRe, "");
    }
    let end = isOwnLine ? i - 1 : i;
    if (isOwnLine) {
      // block = previous paragraph
      while (end >= 0 && lines[end].trim() === "") end--;
      let s = end;
      while (s > 0 && lines[s - 1].trim() !== "" && !HEADING.test(lines[s - 1])) s--;
      return lines.slice(s, end + 1).join("\n");
    }
    let s = i;
    while (s > 0 && lines[s - 1].trim() !== "" && !HEADING.test(lines[s - 1])) s--;
    const out = lines.slice(s, i + 1);
    out[out.length - 1] = out[out.length - 1].replace(idRe, "");
    return out.join("\n");
  }
  return null;
}

/** Find the element addressed by a subpath inside rendered DOM and scroll to it. */
export function findSubpathTarget(el: HTMLElement, subpath: string): HTMLElement | null {
  const part = parseSubpath(subpath);
  if (!part) return null;
  if (part.kind === "block") {
    const id = part.value;
    return el.querySelector<HTMLElement>(`[data-block-id="${cssEscape(id)}"]`);
  }
  const want = normHeading(part.value);
  const heads = Array.from(el.querySelectorAll<HTMLElement>("[data-heading]"));
  return (
    heads.find((h) => normHeading(h.getAttribute("data-heading") ?? "") === want) ??
    heads.find((h) => h.id === slugifyHeading(part.value)) ??
    null
  );
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

export function scrollToSubpath(el: HTMLElement, subpath: string): HTMLElement | null {
  const target = findSubpathTarget(el, subpath);
  if (!target) return null;
  (target as any).scrollIntoView?.({ block: "start", behavior: "auto" });
  target.classList.add("is-flashing");
  setTimeout(() => target.classList.remove("is-flashing"), 1500);
  return target;
}
