import MarkdownIt, { type MarkdownIt as MdType } from "markdown-it";
import type { StateInline, StateBlock, StateCore, Token } from "markdown-it";
import katex from "katex";
import type { RenderContext } from "./types";
import { slugifyHeading, splitLinktext } from "./util";

/** Per-render environment threaded through markdown-it. */
export interface MdEnv {
  ctx: RenderContext;
  sourcePath: string;
  footnotes: { defs: Map<string, string>; order: string[]; refCount: Map<string, number> };
  headingIds: Map<string, number>;
  [k: string | symbol]: unknown;
}

const esc = (s: string) => MarkdownIt().utils.escapeHtml(s);

export function inlineText(children: Token[] | null): string {
  if (!children) return "";
  let out = "";
  for (const t of children) {
    if (t.type === "text" || t.type === "code_inline") out += t.content;
    else if (t.type === "wikilink") out += t.content;
    else if (t.type === "tag") out += "#" + t.content;
    else if (t.type === "softbreak" || t.type === "hardbreak") out += " ";
    else if (t.type === "math_inline") out += t.content;
    else if (t.type === "image" && t.children) out += inlineText(t.children);
  }
  return out;
}

function wikilinkParts(inner: string): { target: string; alias: string | null } {
  const m = /\\?\|/.exec(inner);
  if (!m) return { target: inner.trim(), alias: null };
  return { target: inner.slice(0, m.index).trim(), alias: inner.slice(m.index + m[0].length) };
}

function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner.trim() || /[[\]\n]/.test(inner)) return false;
  if (!silent) {
    const { target, alias } = wikilinkParts(inner);
    const t = state.push("wikilink", "a", 0);
    t.meta = { target, alias };
    t.content = alias ?? defaultDisplay(target);
  }
  state.pos = end + 2;
  return true;
}

function embedRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x21 || src.charCodeAt(pos + 1) !== 0x5b || src.charCodeAt(pos + 2) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 3);
  if (end < 0) return false;
  const inner = src.slice(pos + 3, end);
  if (!inner.trim() || /[[\]\n]/.test(inner)) return false;
  if (!silent) {
    const { target, alias } = wikilinkParts(inner);
    const t = state.push("embed", "span", 0);
    t.meta = { target, alias };
    t.content = target;
  }
  state.pos = end + 2;
  return true;
}

export function defaultDisplay(target: string): string {
  const { path, subpath } = splitLinktext(target);
  const subs = subpath.split("#").filter(Boolean);
  return [path, ...subs].filter(Boolean).join(" > ");
}

const TAG_RE = /#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/uy;

function tagRule(state: StateInline, silent: boolean): boolean {
  const pos = state.pos;
  if (state.src.charCodeAt(pos) !== 0x23) return false;
  if (pos > 0 && /[\p{L}\p{N}/&#\\]/u.test(state.src[pos - 1])) return false;
  TAG_RE.lastIndex = pos;
  const m = TAG_RE.exec(state.src);
  if (!m) return false;
  if (!silent) {
    const t = state.push("tag", "a", 0);
    t.content = m[1];
  }
  state.pos = pos + m[0].length;
  return true;
}

function highlightRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x3d || src.charCodeAt(pos + 1) !== 0x3d) return false;
  const after = src[pos + 2];
  if (after === undefined || after === "=" || /\s/.test(after)) return false;
  let e = pos + 2;
  for (;;) {
    e = src.indexOf("==", e);
    if (e < 0 || e >= state.posMax) return false;
    if (/\s/.test(src[e - 1])) {
      e += 2;
      continue;
    }
    break;
  }
  if (!silent) {
    const oldMax = state.posMax;
    state.pos = pos + 2;
    state.posMax = e;
    state.push("mark_open", "mark", 1);
    state.md.inline.tokenize(state);
    state.push("mark_close", "mark", -1);
    state.posMax = oldMax;
  }
  state.pos = e + 2;
  return true;
}

function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x24) return false;
  const display = src.charCodeAt(pos + 1) === 0x24;
  const open = display ? 2 : 1;
  const first = src[pos + open];
  if (first === undefined) return false;
  if (!display && (/\s/.test(first) || first === "$")) return false;
  let e = pos + open;
  for (;;) {
    e = src.indexOf(display ? "$$" : "$", e);
    if (e < 0 || e >= state.posMax) return false;
    if (src[e - 1] === "\\") {
      e += 1;
      continue;
    }
    break;
  }
  if (!display) {
    if (/\s/.test(src[e - 1])) return false;
    if (/\d/.test(src[e + 1] ?? "")) return false;
  }
  const tex = src.slice(pos + open, e);
  if (!tex.trim()) return false;
  if (!silent) {
    const t = state.push("math_inline", "span", 0);
    t.content = tex;
    t.meta = { display };
  }
  state.pos = e + open;
  return true;
}

function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.src.slice(pos, pos + 2) !== "$$") return false;
  const first = state.src.slice(pos + 2, max);
  let content = "";
  let last = startLine;
  let found = false;
  if (first.trim().endsWith("$$")) {
    content = first.trim().slice(0, -2);
    found = true;
  } else {
    content = first;
    for (let n = startLine + 1; n < endLine; n++) {
      const t = state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]);
      if (t.trim().endsWith("$$")) {
        content += "\n" + t.trim().slice(0, -2);
        last = n;
        found = true;
        break;
      }
      content += "\n" + t;
    }
  }
  if (!found) return false;
  if (silent) return true;
  state.line = last + 1;
  const tok = state.push("math_block", "div", 0);
  tok.block = true;
  tok.content = content.trim();
  tok.map = [startLine, state.line];
  tok.markup = "$$";
  return true;
}

function footnoteRefRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5e) return false;
  const m = /^\[\^([^\]\s]+)\]/.exec(src.slice(pos));
  if (!m) return false;
  const env = state.env as unknown as MdEnv;
  if (!env?.footnotes?.defs.has(m[1])) return false;
  if (!silent) {
    const t = state.push("footnote_ref", "sup", 0);
    t.meta = { id: m[1] };
  }
  state.pos = pos + m[0].length;
  return true;
}

const INLINE_COUNT = Symbol("inlineFootnotes");

/** Inline footnote `^[text]` (balanced brackets): registers an anonymous footnote, numbered with the others in document order. */
function inlineFootnoteRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5e || src.charCodeAt(start + 1) !== 0x5b) return false;
  let depth = 0;
  let end = -1;
  for (let i = start + 1; i < state.posMax; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x5c) { i++; continue; }
    if (c === 0x5b) depth++;
    else if (c === 0x5d && --depth === 0) { end = i; break; }
  }
  if (end < 0 || end === start + 2) return false;
  if (!silent) {
    const env = state.env as unknown as MdEnv;
    const fn = env.footnotes;
    if (!fn) return false;
    const n = ((env[INLINE_COUNT] as number | undefined) ?? 0) + 1;
    env[INLINE_COUNT] = n;
    const id = `inline-${n}`;
    fn.defs.set(id, src.slice(start + 2, end));
    const t = state.push("footnote_ref", "sup", 0);
    t.meta = { id };
  }
  state.pos = end + 1;
  return true;
}

function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "htmlAndMathml" });
  } catch {
    return `<code class="math-error">${esc(tex)}</code>`;
  }
}

// ---------- core rules ----------

function headingRule(state: StateCore): void {
  const env = state.env as unknown as MdEnv;
  const toks = state.tokens;
  for (let i = 0; i < toks.length - 1; i++) {
    if (toks[i].type !== "heading_open" || toks[i + 1].type !== "inline") continue;
    const text = inlineText(toks[i + 1].children).replace(/\s*\^[\w-]+\s*$/, "").trim();
    toks[i].attrSet("data-heading", text);
    let slug = slugifyHeading(text);
    const seen = env.headingIds.get(slug) ?? 0;
    env.headingIds.set(slug, seen + 1);
    if (seen > 0) slug += "-" + seen;
    if (slug) toks[i].attrSet("id", slug);
  }
}

/** `data-line` (0-based source line) on list items, as Obsidian's reading view has; the fold state is keyed on it. */
function listLineRule(state: StateCore): void {
  for (const t of state.tokens) if (t.type === "list_item_open" && t.map) t.attrSet("data-line", String(t.map[0]));
}

function taskRule(state: StateCore): void {
  const toks = state.tokens;
  for (let i = 2; i < toks.length; i++) {
    const inl = toks[i];
    if (inl.type !== "inline" || toks[i - 1].type !== "paragraph_open" || toks[i - 2].type !== "list_item_open") continue;
    const first = inl.children?.[0];
    if (!first || first.type !== "text") continue;
    const m = /^\[(.)\](?:[ \t]+|$)/.exec(first.content);
    if (!m) continue;
    const li = toks[i - 2];
    const ch = m[1];
    const checked = ch !== " ";
    li.attrJoin("class", "task-list-item");
    if (checked) li.attrJoin("class", "is-checked");
    li.attrSet("data-task", ch);
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input class="task-list-item-checkbox" type="checkbox"${checked ? " checked" : ""} data-line="${li.map ? li.map[0] : 0}">`;
    inl.children!.unshift(box);
    for (let j = i - 3; j >= 0; j--) {
      const t = toks[j];
      if ((t.type === "bullet_list_open" || t.type === "ordered_list_open") && t.level === li.level - 1) {
        t.attrJoin("class", "contains-task-list");
        break;
      }
    }
  }
}

function blockIdRule(state: StateCore): void {
  const toks = state.tokens;
  for (let i = 1; i < toks.length; i++) {
    const inl = toks[i];
    if (inl.type !== "inline" || !inl.children?.length) continue;
    const owner = toks[i - 1];
    if (owner.type !== "paragraph_open" && owner.type !== "heading_open") continue;
    const last = inl.children[inl.children.length - 1];
    if (last.type !== "text") continue;
    const own = inl.children.length === 1 && /^\^([A-Za-z0-9-]+)$/.exec(last.content.trim());
    if (own && owner.type === "paragraph_open") {
      // attach to the previous sibling block
      let j = i - 2;
      if (j >= 0 && toks[j].nesting === -1) {
        const lvl = toks[j].level;
        while (j >= 0 && !(toks[j].nesting === 1 && toks[j].level === lvl)) j--;
      }
      if (j >= 0 && toks[j].level === owner.level) {
        toks[j].attrSet("data-block-id", own[1]);
        owner.hidden = true;
        toks[i + 1].hidden = true;
        inl.children = [];
        inl.content = "";
      }
      continue;
    }
    const m = /(^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(last.content);
    if (!m) continue;
    last.content = last.content.slice(0, m.index).replace(/\s+$/, "");
    let target = owner;
    if (owner.hidden && toks[i - 2]?.type === "list_item_open") target = toks[i - 2];
    target.attrSet("data-block-id", m[2]);
  }
}

// ---------- installer ----------

export function createMarkdownIt(opts: { strictLineBreaks: boolean }): MdType {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: !opts.strictLineBreaks, typographer: false });

  md.inline.ruler.before("link", "footnote_ref", footnoteRefRule);
  md.inline.ruler.before("link", "footnote_inline", inlineFootnoteRule);
  md.inline.ruler.before("link", "wikilink", wikilinkRule);
  md.inline.ruler.before("image", "embed", embedRule);
  md.inline.ruler.push("tag", tagRule);
  md.inline.ruler.push("highlight", highlightRule);
  md.inline.ruler.push("math_inline", mathInlineRule);
  md.block.ruler.before("fence", "math_block", mathBlockRule, { alt: ["paragraph", "reference", "blockquote", "list"] });

  md.core.ruler.push("tachylite_headings", headingRule);
  md.core.ruler.push("tachylite_list_lines", listLineRule);
  md.core.ruler.push("tachylite_tasks", taskRule);
  md.core.ruler.push("tachylite_blockids", blockIdRule);

  const r = md.renderer.rules;

  r.wikilink = (tokens, idx, _o, env: any) => {
    const t = tokens[idx];
    const { target } = t.meta as { target: string };
    const { path } = splitLinktext(target);
    const resolved = path ? env.ctx.resolveLink(path, env.sourcePath) : env.sourcePath;
    const cls = "internal-link" + (resolved === null ? " is-unresolved" : "");
    return `<a class="${cls}" data-href="${esc(target)}" href="${esc(target)}" target="_blank" rel="noopener nofollow">${esc(t.content)}</a>`;
  };
  r.embed = (tokens, idx) => {
    const t = tokens[idx];
    const { target, alias } = t.meta as { target: string; alias: string | null };
    return `<span class="internal-embed" src="${esc(target)}" alt="${esc(alias ?? "")}"></span>`;
  };
  r.tag = (tokens, idx) => {
    const tag = "#" + tokens[idx].content;
    return `<a href="${esc(tag)}" class="tag" target="_blank" rel="noopener nofollow">${esc(tag)}</a>`;
  };
  r.math_inline = (tokens, idx) => {
    const t = tokens[idx];
    const display = !!t.meta?.display;
    return `<span class="math ${display ? "math-block" : "math-inline"} is-loaded">${renderMath(t.content, display)}</span>`;
  };
  r.math_block = (tokens, idx) =>
    `<div class="math math-block is-loaded">${renderMath(tokens[idx].content, true)}</div>\n`;
  r.footnote_ref = (tokens, idx, _o, env: any) => {
    const id = (tokens[idx].meta as { id: string }).id;
    const fn = env.footnotes;
    let n = fn.order.indexOf(id) + 1;
    if (!n) {
      fn.order.push(id);
      n = fn.order.length;
    }
    const k = (fn.refCount.get(id) ?? 0) + 1;
    fn.refCount.set(id, k);
    const eid = encodeURIComponent(id);
    return `<sup class="footnote-ref" data-footnote-id="${esc(id)}"><a href="#fn-${eid}" id="fnref-${eid}${k > 1 ? "-" + k : ""}" class="footnote-link" data-footref="${esc(id)}">${n}</a></sup>`;
  };
  r.fence = (tokens, idx) => {
    const t = tokens[idx];
    const lang = (t.info.trim().split(/\s+/)[0] ?? "").replace(/[^\w+#.-]/g, "");
    const cls = lang ? ` class="language-${lang}"` : "";
    const bid = t.attrGet("data-block-id");
    return `<pre${cls}${bid ? ` data-block-id="${esc(String(bid))}"` : ""}><code${cls}${lang ? ` data-lang="${lang}"` : ""}>${esc(t.content)}</code><button class="copy-code-button" type="button">Copy</button></pre>\n`;
  };
  // code_block (indented) keeps default.

  return md;
}
