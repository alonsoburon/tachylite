// Pure utility functions exported by the `obsidian` module.
import * as yaml from "js-yaml";
import moment from "moment";

export { moment };
export const apiVersion = "1.14.4";

export function normalizePath(path: string): string {
  path = path.replace(/([\\/])+/g, "/").replace(/(^\/+|\/+$)/g, "");
  path = path.replace(/[  ]/g, " ").normalize("NFC");
  return path === "" ? "/" : path;
}

export interface Debouncer<T extends unknown[], V> {
  (...args: [...T]): Debouncer<T, V>;
  cancel(): Debouncer<T, V>;
  run(): V | void;
}
export function debounce<T extends unknown[], V>(cb: (...args: [...T]) => V, timeout = 0, resetTimer = false): Debouncer<T, V> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let args: [...T] | null = null;
  let ctx: unknown;
  const fire = (): V | void => {
    timer = null;
    const a = args; args = null;
    if (a) return cb.apply(ctx, a);
  };
  const d = function (this: unknown, ...a: [...T]) {
    args = a; ctx = this;
    if (resetTimer && timer !== null) { clearTimeout(timer); timer = null; }
    if (timer === null) timer = setTimeout(fire, timeout);
    return d;
  } as Debouncer<T, V>;
  d.cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; args = null; return d; };
  d.run = () => {
    if (timer === null) return;
    clearTimeout(timer);
    return fire();
  };
  return d;
}

/** js-yaml rejects documents with no content; YAML (and Obsidian) read them as null. */
export function isBlankYaml(text: string): boolean { return text.split("\n").every((l) => /^\s*(#.*)?$/.test(l)); }
export function parseYaml(text: string): any {
  return isBlankYaml(text) ? null : yaml.load(text);
}
/** Block style like Obsidian's output: double quotes when needed, `key:` for null, no line folding. */
export function stringifyYaml(obj: any): string {
  return yaml.dump(obj, {
    lineWidth: -1, schema: yaml.CORE_SCHEMA, quoteStyle: "double",
    transform: (docs) => yaml.visit(docs, (n: any) => { if (n.kind === "scalar" && n.tag === "tag:yaml.org,2002:null") n.value = ""; }),
  });
}

export function requireApiVersion(version: string): boolean {
  const a = apiVersion.split(".").map(Number), b = version.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}
export function getLanguage(): string {
  return (typeof navigator !== "undefined" && navigator.language ? navigator.language : "en").split("-")[0];
}

// ---- links & headings
export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const i = linktext.indexOf("#");
  return i < 0 ? { path: linktext, subpath: "" } : { path: linktext.slice(0, i), subpath: linktext.slice(i) };
}
export function getLinkpath(linktext: string): string {
  return parseLinktext(linktext).path;
}
export function stripHeading(heading: string): string {
  return heading.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\]/g, " ").replace(/\s+/g, " ").trim();
}
export function stripHeadingForLink(heading: string): string {
  return heading.replace(/[:#|^\\%]{1,2}|\[\[|\]\]/g, " ").replace(/\s+/g, " ").trim();
}

export interface Loc { line: number; col: number; offset: number }
export interface Pos { start: Loc; end: Loc }
export interface CachedMetadata {
  links?: any[]; embeds?: any[]; tags?: { tag: string; position: Pos }[]; headings?: { heading: string; level: number; position: Pos }[];
  footnotes?: any[]; footnoteRefs?: any[]; referenceLinks?: any[]; sections?: any[]; listItems?: any[];
  frontmatter?: Record<string, any>; frontmatterPosition?: Pos; frontmatterLinks?: any[]; blocks?: Record<string, any>;
}

export function resolveSubpath(cache: CachedMetadata, subpath: string): any | null {
  let sp = subpath.startsWith("#") ? subpath.slice(1) : subpath;
  if (!sp) return null;
  if (sp.startsWith("^")) {
    const id = sp.slice(1).toLowerCase();
    const block = cache.blocks?.[id];
    if (!block) return null;
    const list = cache.listItems?.find((l) => l.id === id || l.position.start.line === block.position.start.line);
    const r: any = { type: "block", block, start: block.position.start, end: block.position.end };
    if (list) r.list = list;
    return r;
  }
  if (sp.startsWith("[^")) {
    const id = sp.slice(2, sp.endsWith("]") ? -1 : undefined);
    const f = cache.footnotes?.find((x) => String(x.id).toLowerCase() === id.toLowerCase());
    return f ? { type: "footnote", footnote: f, start: f.position.start, end: f.position.end } : null;
  }
  const parts = sp.split("#").map((p) => stripHeading(p).toLowerCase()).filter((p) => p.length);
  const hs = cache.headings ?? [];
  let from = 0, cur: any = null, curIdx = -1;
  for (const part of parts) {
    let found = -1;
    for (let i = from; i < hs.length; i++) {
      if (cur && hs[i].level <= cur.level && i > curIdx) {
        // left the section of the previous heading
        break;
      }
      if (stripHeading(hs[i].heading).toLowerCase() === part) { found = i; break; }
    }
    if (found < 0) return null;
    cur = hs[found]; curIdx = found; from = found + 1;
  }
  if (!cur) return null;
  let next: any = null;
  for (let i = curIdx + 1; i < hs.length; i++) if (hs[i].level <= cur.level) { next = hs[i]; break; }
  return { type: "heading", current: cur, next, start: cur.position.start, end: next ? next.position.start : null };
}

export function iterateRefs(refs: any[], cb: (ref: any) => boolean | void): boolean {
  for (const r of refs) if (cb(r) === true) return true;
  return false;
}
export function iterateCacheRefs(cache: CachedMetadata, cb: (ref: any) => boolean | void): boolean {
  return iterateRefs(cache.links ?? [], cb) || iterateRefs(cache.embeds ?? [], cb);
}

// ---- front matter
/** `---` YAML `---` (or `...`) at the very start; the body group is absent for an empty block (`---\n---`). */
export const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
export function getFrontMatterInfo(content: string): { exists: boolean; frontmatter: string; from: number; to: number; contentStart: number } {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  const fm = m[1] ?? "";
  const first = content.indexOf("\n") + 1;
  return { exists: true, frontmatter: fm, from: first, to: first + fm.length, contentStart: m[0].length };
}
export function parseFrontMatterEntry(fm: any | null, key: string | RegExp): any | null {
  if (!fm || typeof fm !== "object") return null;
  for (const k of Object.keys(fm)) {
    if (typeof key === "string" ? k.toLowerCase() === key.toLowerCase() : key.test(k)) return fm[k] ?? null;
  }
  return null;
}
function toStrings(v: any, splitter: RegExp): string[] | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => x.length);
  if (typeof v === "string") return v.split(splitter).map((x) => x.trim()).filter((x) => x.length);
  return null;
}
export function parseFrontMatterStringArray(fm: any | null, key: string | RegExp, nospaces = false): string[] | null {
  return toStrings(parseFrontMatterEntry(fm, key), nospaces ? /[,\s]+/ : /,/);
}
export function parseFrontMatterTags(fm: any | null): string[] | null {
  const raw = parseFrontMatterStringArray(fm, /^tags?$/i, true);
  if (!raw) return null;
  return raw.map((t) => (t.startsWith("#") ? t : "#" + t));
}
export function parseFrontMatterAliases(fm: any | null): string[] | null {
  return parseFrontMatterStringArray(fm, /^alias(es)?$/i);
}
export function getAllTags(cache: CachedMetadata): string[] | null {
  const out = new Set<string>();
  for (const t of cache.tags ?? []) out.add(t.tag);
  for (const t of parseFrontMatterTags(cache.frontmatter) ?? []) out.add(t);
  return out.size ? [...out] : null;
}

// ---- binary helpers
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const u8 = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const s = atob(b64.replace(/[\r\n\s]/g, ""));
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer as ArrayBuffer;
}
export function arrayBufferToHex(data: ArrayBuffer): string {
  return Array.from(new Uint8Array(data), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function hexToArrayBuffer(hex: string): ArrayBuffer {
  const u8 = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < u8.length; i++) u8[i] = parseInt(hex.substr(i * 2, 2), 16);
  return u8.buffer as ArrayBuffer;
}
export function getBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as ArrayBuffer); r.onerror = () => rej(r.error); r.readAsArrayBuffer(blob); });
}

// ---- search
export type SearchMatchPart = [number, number];
export interface SearchResult { score: number; matches: SearchMatchPart[] }

function mergeMatches(m: SearchMatchPart[]): SearchMatchPart[] {
  m.sort((a, b) => a[0] - b[0]);
  const out: SearchMatchPart[] = [];
  for (const p of m) {
    const last = out[out.length - 1];
    if (last && p[0] <= last[1]) last[1] = Math.max(last[1], p[1]);
    else out.push([p[0], p[1]]);
  }
  return out;
}
function tokens(q: string): string[] { return q.toLowerCase().split(/\s+/).filter(Boolean); }

export function prepareSimpleSearch(query: string): (text: string) => SearchResult | null {
  const toks = tokens(query);
  return (text) => {
    const lower = text.toLowerCase();
    const matches: SearchMatchPart[] = [];
    let score = 0;
    for (const t of toks) {
      const i = lower.indexOf(t);
      if (i < 0) return null;
      matches.push([i, i + t.length]);
      score -= i * 0.01 + (lower.length - t.length) * 0.001 + (i > 0 && /\w/.test(lower[i - 1]) ? 1 : 0);
    }
    return { score, matches: mergeMatches(matches) };
  };
}

function fuzzyToken(lower: string, t: string): { score: number; matches: SearchMatchPart[] } | null {
  const idx = lower.indexOf(t);
  if (idx >= 0) {
    const boundary = idx === 0 || /[^a-z0-9]/.test(lower[idx - 1]);
    return { score: -idx * 0.05 - (boundary ? 0 : 1), matches: [[idx, idx + t.length]] };
  }
  // subsequence; prefer word-boundary starts
  let best: { score: number; matches: SearchMatchPart[] } | null = null;
  for (let start = lower.indexOf(t[0]); start >= 0 && start < lower.length; start = lower.indexOf(t[0], start + 1)) {
    let pos = start, score = -start * 0.05 - 2;
    const matches: SearchMatchPart[] = [];
    let ok = true;
    for (let k = 0; k < t.length; k++) {
      const j = k === 0 ? start : lower.indexOf(t[k], pos + 1);
      if (j < 0) { ok = false; break; }
      if (k > 0) score -= (j - pos - 1) * 0.5 + 1;
      const last = matches[matches.length - 1];
      if (last && last[1] === j) last[1] = j + 1; else matches.push([j, j + 1]);
      pos = j;
    }
    if (ok && (!best || score > best.score)) best = { score, matches };
    if (best && start > 8) break;
  }
  return best;
}
export function prepareFuzzySearch(query: string): (text: string) => SearchResult | null {
  const toks = tokens(query);
  return (text) => {
    if (!toks.length) return { score: 0, matches: [] };
    const lower = text.toLowerCase();
    const matches: SearchMatchPart[] = [];
    let score = 0;
    for (const t of toks) {
      const r = fuzzyToken(lower, t);
      if (!r) return null;
      score += r.score; matches.push(...r.matches);
    }
    return { score: score - lower.length * 0.001, matches: mergeMatches(matches) };
  };
}
export function sortSearchResults(results: { match: SearchResult }[]): void {
  results.sort((a, b) => b.match.score - a.match.score);
}
export function renderMatches(el: HTMLElement | DocumentFragment, text: string, matches: SearchMatchPart[] | null, offset = 0): void {
  const doc = (el as any).ownerDocument ?? document;
  let cur = 0;
  for (const [s0, e0] of matches ?? []) {
    const s = s0 - offset, e = e0 - offset;
    if (e <= 0 || s >= text.length) continue;
    const ss = Math.max(0, s), ee = Math.min(text.length, e);
    if (ss > cur) el.appendChild(doc.createTextNode(text.slice(cur, ss)));
    const span = doc.createElement("span");
    span.className = "suggestion-highlight";
    span.textContent = text.slice(ss, ee);
    el.appendChild(span);
    cur = ee;
  }
  if (cur < text.length) el.appendChild(doc.createTextNode(text.slice(cur)));
}
export function renderResults(el: HTMLElement, text: string, result: SearchResult, offset = 0): void {
  renderMatches(el, text, result.matches, offset);
}

// ---- HTML
const FORBIDDEN_TAGS = new Set(["script", "iframe", "object", "embed", "link", "meta", "base", "style", "frame", "frameset"]);
export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const frag = tpl.content ?? (() => { const f = document.createDocumentFragment(); while (tpl.firstChild) f.appendChild(tpl.firstChild); return f; })();
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === 1) {
        const el = c as Element;
        if (FORBIDDEN_TAGS.has(el.tagName.toLowerCase())) { n.removeChild(c); continue; }
        for (const a of Array.from(el.attributes)) {
          const name = a.name.toLowerCase();
          if (name.startsWith("on") || ((name === "href" || name === "src" || name === "xlink:href") && /^\s*(javascript|vbscript|data:text\/html)/i.test(a.value))) el.removeAttribute(a.name);
        }
        walk(el);
      }
    }
  };
  walk(frag);
  return frag as DocumentFragment;
}

export function htmlToMarkdown(html: string | HTMLElement | Document | DocumentFragment): string {
  let root: Node;
  if (typeof html === "string") { const d = document.createElement("div"); d.innerHTML = html; root = d; }
  else if ((html as Document).nodeType === 9) root = (html as Document).body;
  else root = html;
  const inline = (n: Node): string => Array.from(n.childNodes).map((c) => conv(c)).join("");
  const conv = (n: Node, listCtx?: { ordered: boolean; depth: number }): string => {
    if (n.nodeType === 3) return (n.textContent ?? "").replace(/\s+/g, " ");
    if (n.nodeType !== 1) return "";
    const el = n as HTMLElement, tag = el.tagName.toLowerCase();
    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        return `\n\n${"#".repeat(+tag[1])} ${inline(el).trim()}\n\n`;
      case "p": case "div": case "section": case "article": return `\n\n${inline(el).trim()}\n\n`;
      case "br": return "\n";
      case "hr": return "\n\n---\n\n";
      case "strong": case "b": return `**${inline(el)}**`;
      case "em": case "i": return `*${inline(el)}*`;
      case "del": case "s": case "strike": return `~~${inline(el)}~~`;
      case "code": return el.parentElement?.tagName.toLowerCase() === "pre" ? el.textContent ?? "" : "`" + (el.textContent ?? "") + "`";
      case "pre": return `\n\n\`\`\`\n${(el.textContent ?? "").replace(/\n$/, "")}\n\`\`\`\n\n`;
      case "a": { const h = el.getAttribute("href"); return h ? `[${inline(el)}](${h})` : inline(el); }
      case "img": return `![${el.getAttribute("alt") ?? ""}](${el.getAttribute("src") ?? ""})`;
      case "blockquote": return "\n\n" + inline(el).trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
      case "ul": case "ol": {
        const depth = (listCtx?.depth ?? -1) + 1;
        let i = 0;
        const items = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === "li").map((li) => {
          i++;
          const body = Array.from(li.childNodes).map((c) => conv(c, { ordered: tag === "ol", depth })).join("").trim().replace(/\n{2,}/g, "\n");
          return `${"  ".repeat(depth)}${tag === "ol" ? i + "." : "-"} ${body}`;
        });
        return (depth === 0 ? "\n\n" : "\n") + items.join("\n") + (depth === 0 ? "\n\n" : "");
      }
      case "script": case "style": return "";
      default: return Array.from(el.childNodes).map((c) => conv(c, listCtx)).join("");
    }
  };
  return inline(root).replace(/\n{3,}/g, "\n\n").trim();
}
