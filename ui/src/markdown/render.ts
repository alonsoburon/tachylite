import type { MarkdownIt } from "markdown-it";
import type { Token } from "markdown-it";
import type {
  ChildLike, CodeBlockProcessor, PostProcessorContext, RenderContext, RenderViewOptions, SectionInfo,
} from "./types";
import { createMarkdownIt, defaultDisplay, type MdEnv } from "./plugins";
import {
  extractSubpath, scrollToSubpath, splitFences, splitFrontmatter, splitLinktext, stripComments,
} from "./util";
import { processCallouts } from "./callouts";
import { paneFor } from "./pane";
import { highlightCodeBlocks } from "./highlight";
import { renderFrontmatter } from "./frontmatter";
import { chevronIcon, linkIcon } from "./icons";

const parsers = new Map<boolean, MarkdownIt>();
function getParser(strict: boolean): MarkdownIt {
  let p = parsers.get(strict);
  if (!p) parsers.set(strict, (p = createMarkdownIt({ strictLineBreaks: strict })));
  return p;
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "ico"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "ogg", "3gp", "flac", "oga", "opus"]);
const VIDEO_EXT = new Set(["mp4", "webm", "ogv", "mov", "mkv", "m4v"]);

function extOf(p: string): string {
  const base = p.split("/").pop() ?? p;
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i + 1).toLowerCase();
}
function baseName(p: string): string {
  return (p.split("/").pop() ?? p).replace(/\.md$/i, "");
}

interface Internal {
  stack: string[];
  hideFrontmatter: boolean;
  children: ChildLike[];
}

let docCounter = 0;
const sectionInfoMap = new WeakMap<HTMLElement, SectionInfo>();
const rootCtx = new WeakMap<HTMLElement, { ctx: RenderContext; root: HTMLElement }>();

// ---------------------------------------------------------------- public API

/** Render markdown into `el` (appends). Produces `.markdown-preview-sizer > .markdown-preview-section*`. */
export async function renderMarkdown(md: string, el: HTMLElement, ctx: RenderContext): Promise<void> {
  const st: Internal = { stack: [ctx.sourcePath], hideFrontmatter: false, children: [] };
  await renderInternal(md, el, ctx, st);
}

export interface RenderHandle {
  unload(): void;
}

/** Render a full reading view: clears `el`, adds root classes, returns a handle to unload children. */
export async function renderView(
  el: HTMLElement,
  md: string,
  ctx: RenderContext,
  opts: RenderViewOptions = {},
): Promise<RenderHandle> {
  el.replaceChildren();
  if (opts.rootClasses !== false) el.classList.add("markdown-preview-view", "markdown-rendered");
  const st: Internal = { stack: [ctx.sourcePath], hideFrontmatter: !!opts.hideFrontmatter, children: [] };
  await renderInternal(md, el, ctx, st);
  return {
    unload() {
      for (const c of st.children) c.unload?.();
      st.children.length = 0;
    },
  };
}

/** Render markdown synchronously to an HTML string (no embeds/callouts/post-processing). */
export function renderToHtml(md: string, ctx: RenderContext): string {
  const mdIt = getParser(!!ctx.strictLineBreaks);
  const env = newEnv(ctx, ctx.sourcePath);
  const { text } = prepare(md, env, false);
  return mdIt.render(text, env);
}

export { scrollToSubpath };

// ---------------------------------------------------------------- internals

function newEnv(ctx: RenderContext, sourcePath: string): MdEnv {
  return {
    ctx,
    sourcePath,
    footnotes: { defs: new Map(), order: [], refCount: new Map() },
    headingIds: new Map(),
  };
}

function prepare(md: string, env: MdEnv, hideFm: boolean) {
  const split = splitFrontmatter(md);
  const body = stripComments(split.body);
  const text = extractFootnotes(body, env);
  return { split, text: "\n".repeat(split.lines) + text, hideFm };
}

function extractFootnotes(md: string, env: MdEnv): string {
  if (!md.includes("[^")) return md;
  return splitFences(md)
    .map((seg) => {
      if (seg.code) return seg.text;
      const lines = seg.text.split("\n");
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const m = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(lines[i]);
        if (!m) {
          out.push(lines[i]);
          continue;
        }
        const body = [m[2]];
        out.push("");
        let blanks = 0;
        let j = i + 1;
        for (; j < lines.length; j++) {
          const l = lines[j];
          if (l.trim() === "") {
            blanks++;
            out.push("");
            continue;
          }
          if (/^( {2,}|\t)/.test(l)) {
            for (; blanks > 0; blanks--) body.push("");
            body.push(l.replace(/^( {2,4}|\t)/, ""));
            out.push("");
            continue;
          }
          break;
        }
        env.footnotes.defs.set(m[1], body.join("\n").trim());
        i = j - 1;
      }
      return out.join("\n");
    })
    .join("");
}

function sectionClass(first: Token): string {
  switch (first.type) {
    case "heading_open": return "el-" + first.tag;
    case "paragraph_open": return "el-p";
    case "bullet_list_open": return "el-ul";
    case "ordered_list_open": return "el-ol";
    case "blockquote_open": return "el-blockquote";
    case "fence": case "code_block": return "el-pre";
    case "table_open": return "el-table";
    case "hr": return "el-hr";
    default: return "el-div";
  }
}

/**
 * Fold arrows on reading-view headings: folding a heading hides the sections after it up to the next heading of the
 * same or a higher level (`.heading-collapse-indicator` and `.is-collapsed`, the classes themes style).
 */
function installHeadingFolds(sections: HTMLElement[]): void {
  const level = (sec: HTMLElement): { h: HTMLElement; n: number } | null => {
    const h = sec.firstElementChild;
    const m = h && /^H([1-6])$/.exec(h.tagName);
    return m ? { h: h as HTMLElement, n: Number(m[1]) } : null;
  };
  const apply = () => {
    let hideBelow = 0; // level of the folded heading currently swallowing sections (0 = none)
    for (const sec of sections) {
      const hd = level(sec);
      if (hd && hideBelow && hd.n <= hideBelow) hideBelow = 0;
      sec.classList.toggle("is-folded-away", hideBelow > 0);
      if (hd && !hideBelow && hd.h.classList.contains("is-collapsed")) hideBelow = hd.n;
    }
  };
  for (const sec of sections) {
    const hd = level(sec);
    if (!hd) continue;
    const arrow = document.createElement("div");
    arrow.className = "heading-collapse-indicator collapse-indicator collapse-icon";
    arrow.appendChild(chevronIcon());
    hd.h.insertBefore(arrow, hd.h.firstChild);
    arrow.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hd.h.classList.toggle("is-collapsed");
      arrow.classList.toggle("is-collapsed", hd.h.classList.contains("is-collapsed"));
      apply();
    });
  }
}

/** Fold arrows on list items that have a sub-list (`.list-collapse-indicator`); folding hides the sub-list (CSS keys on `.is-collapsed`). */
function installListFolds(sections: HTMLElement[]): void {
  for (const sec of sections) {
    for (const li of sec.querySelectorAll<HTMLElement>("li")) {
      if (!li.querySelector(":scope > ul, :scope > ol")) continue;
      const arrow = document.createElement("div");
      arrow.className = "list-collapse-indicator collapse-indicator collapse-icon";
      arrow.appendChild(chevronIcon());
      li.insertBefore(arrow, li.firstChild);
      arrow.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const folded = li.classList.toggle("is-collapsed");
        arrow.classList.toggle("is-collapsed", folded);
      });
    }
  }
}

const CONTAINER = "details|div|section|aside|figure|center|blockquote|fieldset";
/** How many HTML container elements an html_block opens without closing (negative if it only closes). */
function unclosedContainers(html: string): number {
  const open = (html.match(new RegExp(`<(?:${CONTAINER})(?=[\\s>])[^>]*(?<!/)>`, "gi")) ?? []).length;
  const close = (html.match(new RegExp(`</(?:${CONTAINER})\\s*>`, "gi")) ?? []).length;
  return open - close;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function sanitize(root: HTMLElement): void {
  root.querySelectorAll("script, iframe, object, embed, link, meta, base, form").forEach((n) => n.remove());
  root.querySelectorAll("*").forEach((n) => {
    for (const a of Array.from(n.attributes)) {
      const name = a.name.toLowerCase();
      if (name.startsWith("on")) n.removeAttribute(a.name);
      else if ((name === "href" || name === "src" || name === "xlink:href") && /^\s*(javascript|vbscript):/i.test(a.value)) n.removeAttribute(a.name);
    }
  });
}

async function renderInternal(md: string, el: HTMLElement, ctx: RenderContext, st: Internal): Promise<void> {
  const mdIt = getParser(!!ctx.strictLineBreaks);
  const env = newEnv(ctx, ctx.sourcePath);
  const { split, text } = prepare(md, env, st.hideFrontmatter);
  const tokens = mdIt.parse(text, env);

  const sizer = document.createElement("div");
  sizer.className = "markdown-preview-sizer";
  el.appendChild(sizer);
  attachHandlers(el, ctx);

  const frontmatter = split.frontmatter ?? ctx.getFrontmatter?.(ctx.sourcePath) ?? null;
  const fmMode = ctx.propertiesInDocument ?? "visible";
  if (split.raw !== null && !st.hideFrontmatter && fmMode !== "hidden") {
    const inl = (s: string) => mdIt.renderInline(s, env);
    if (fmMode === "source") {
      const pre = sizer.appendChild(document.createElement("pre"));
      pre.className = "frontmatter language-yaml";
      pre.appendChild(document.createElement("code")).textContent = split.raw;
    } else {
      const holder = document.createElement("div");
      holder.className = "mod-frontmatter mod-ui";
      if (split.frontmatter && ctx.renderProperties?.(holder, split.frontmatter, ctx.sourcePath)) sizer.appendChild(holder);
      else sizer.appendChild(renderFrontmatter(split, inl));
    }
  }

  // group top-level tokens into sections
  const sections: HTMLElement[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    let j = i;
    if (t.nesting === 1) {
      j = i + 1;
      while (j < tokens.length && !(tokens[j].nesting === -1 && tokens[j].level === t.level)) j++;
    }
    let html = mdIt.renderer.render(tokens.slice(i, j + 1), mdIt.options, env);
    i = j + 1;
    // An HTML container left open (e.g. <details>) swallows the blocks after it up to its closing tag, so Markdown inside renders.
    if (t.type === "html_block") {
      let open = unclosedContainers(t.content);
      let last = t;
      while (open > 0 && i < tokens.length) {
        const n = tokens[i];
        let k = i;
        if (n.nesting === 1) { k = i + 1; while (k < tokens.length && !(tokens[k].nesting === -1 && tokens[k].level === n.level)) k++; }
        html += mdIt.renderer.render(tokens.slice(i, k + 1), mdIt.options, env);
        if (n.type === "html_block") open += unclosedContainers(n.content);
        last = n;
        i = k + 1;
      }
      if (last !== t && t.map && last.map) t.map = [t.map[0], last.map[1]];
    }
    if (!html.trim()) continue;
    const sec = document.createElement("div");
    sec.className = "markdown-preview-section " + sectionClass(t);
    sec.innerHTML = html;
    sanitize(sec);
    const lineStart = t.map?.[0] ?? 0;
    const lineEnd = Math.max(lineStart, (t.map?.[1] ?? lineStart + 1) - 1);
    sectionInfoMap.set(sec, { text: md, lineStart, lineEnd });
    sections.push(sec);
    sizer.appendChild(sec);
  }

  if (env.footnotes.order.length) {
    const sec = document.createElement("div");
    sec.className = "markdown-preview-section el-section";
    sec.appendChild(buildFootnotes(mdIt, env));
    sections.push(sec);
    sizer.appendChild(sec);
  }

  if (ctx.foldHeading) installHeadingFolds(sections);
  if (ctx.foldIndent) installListFolds(sections);

  const pctx: PostProcessorContext = {
    docId: "doc-" + ++docCounter,
    sourcePath: ctx.sourcePath,
    frontmatter,
    addChild(child) {
      st.children.push(child);
      child.load?.();
      ctx.addChild?.(child);
    },
    getSectionInfo(node) {
      let cur: HTMLElement | null = node;
      while (cur) {
        const info = sectionInfoMap.get(cur);
        if (info) return info;
        cur = cur.parentElement;
      }
      return null;
    },
    containerEl: el,
  };

  await Promise.all(
    sections.map(async (sec) => {
      processLinks(sec, ctx);
      await processEmbeds(sec, ctx, st);
      processCallouts(sec);
      await processCodeBlocks(sec, ctx, pctx);
      await highlightCodeBlocks(sec);
      for (const pp of ctx.postProcessors ?? []) {
        try {
          await pp(sec, pctx);
        } catch (e) {
          console.error("post-processor failed", e);
        }
      }
    }),
  );
}

function buildFootnotes(mdIt: MarkdownIt, env: MdEnv): HTMLElement {
  const root = document.createElement("section");
  root.className = "footnotes";
  root.appendChild(document.createElement("hr"));
  const ol = document.createElement("ol");
  for (const id of env.footnotes.order) {
    const li = document.createElement("li");
    const eid = encodeURIComponent(id);
    li.id = `fn-${eid}`;
    li.setAttribute("data-footnote-id", id);
    const subEnv = newEnv(env.ctx, env.sourcePath);
    subEnv.footnotes = { defs: new Map(), order: [], refCount: new Map() };
    li.innerHTML = mdIt.render(env.footnotes.defs.get(id) ?? "", subEnv);
    sanitize(li);
    const back = document.createElement("a");
    back.className = "footnote-backref";
    back.href = `#fnref-${eid}`;
    back.setAttribute("data-footref", id);
    back.textContent = "↩";
    (li.querySelector("p:last-of-type") ?? li).appendChild(back);
    ol.appendChild(li);
  }
  root.appendChild(ol);
  return root;
}

// ---------------------------------------------------------------- links

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function processLinks(root: HTMLElement, ctx: RenderContext): void {
  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    if (a.classList.contains("internal-link") || a.classList.contains("tag") || a.classList.contains("footnote-link") || a.classList.contains("footnote-backref")) return;
    const href = a.getAttribute("href") ?? "";
    if (SCHEME.test(href)) {
      a.classList.add("external-link");
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener nofollow");
      return;
    }
    const target = safeDecode(href);
    a.classList.add("internal-link");
    a.setAttribute("data-href", target);
    a.setAttribute("href", target);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener nofollow");
    const { path } = splitLinktext(target);
    if (path && ctx.resolveLink(path, ctx.sourcePath) === null) a.classList.add("is-unresolved");
  });
  root.querySelectorAll<HTMLImageElement>("img[src]").forEach((img) => {
    if (img.closest(".internal-embed")) return;
    const src = img.getAttribute("src") ?? "";
    let alt = img.getAttribute("alt") ?? "";
    const m = /\|(\d+)(?:x(\d+))?\s*$/.exec(alt);
    if (m) {
      img.setAttribute("width", m[1]);
      if (m[2]) img.setAttribute("height", m[2]);
      alt = alt.slice(0, m.index);
      img.setAttribute("alt", alt);
    }
    if (SCHEME.test(src)) return;
    const path = safeDecode(src);
    const resolved = ctx.resolveLink(path, ctx.sourcePath) ?? null;
    if (resolved !== null) img.setAttribute("src", ctx.getResourceUrl(resolved));
  });
}

// ---------------------------------------------------------------- embeds

async function processEmbeds(root: HTMLElement, ctx: RenderContext, st: Internal): Promise<void> {
  const embeds = Array.from(root.querySelectorAll<HTMLElement>("span.internal-embed[src]"));
  for (const span of embeds) {
    try {
      await renderEmbed(span, ctx, st);
    } catch (e) {
      span.classList.add("is-unresolved");
      span.textContent = `Unable to load ${span.getAttribute("src")}`;
      console.error(e);
    }
  }
}

/** Size from an embed alias: `100`, `100x50`, or after a caption (`caption|100x50`, which also returns the caption as `text`). */
function parseSize(alias: string): { w?: number; h?: number; text?: string } | null {
  const m = /(?:^|\|)\s*(\d+)(?:x(\d+))?\s*$/.exec(alias);
  if (!m) return null;
  const text = alias.slice(0, m.index).trim();
  return { w: Number(m[1]), h: m[2] ? Number(m[2]) : undefined, text: text || undefined };
}

async function renderEmbed(span: HTMLElement, ctx: RenderContext, st: Internal): Promise<void> {
  const src = span.getAttribute("src") ?? "";
  const alias = span.getAttribute("alt") ?? "";
  const { path, subpath } = splitLinktext(src);
  const target = path ? ctx.resolveLink(path, ctx.sourcePath) : ctx.sourcePath;
  if (target === null) {
    span.classList.add("is-unresolved");
    span.textContent = src;
    return;
  }
  const ext = path ? extOf(target) : "md";
  if (IMAGE_EXT.has(ext)) {
    span.classList.add("image-embed", "is-loaded");
    const img = document.createElement("img");
    img.src = ctx.getResourceUrl(target);
    img.loading = "lazy";
    const size = parseSize(alias);
    if (size) {
      img.setAttribute("width", String(size.w));
      if (size.h !== undefined) img.setAttribute("height", String(size.h));
      img.alt = size.text ?? baseName(target);
    } else img.alt = alias || baseName(target);
    span.replaceChildren(img);
    return;
  }
  if (AUDIO_EXT.has(ext) || VIDEO_EXT.has(ext)) {
    const isAudio = AUDIO_EXT.has(ext);
    span.classList.add("media-embed", "is-loaded", isAudio ? "audio-embed" : "video-embed");
    const m = document.createElement(isAudio ? "audio" : "video") as HTMLMediaElement;
    m.controls = true;
    m.src = ctx.getResourceUrl(target);
    m.preload = "metadata";
    span.replaceChildren(m);
    return;
  }
  if (ext === "pdf") {
    span.classList.add("pdf-embed", "is-loaded");
    const f = document.createElement("iframe");
    const page = /page=(\d+)/.exec(subpath);
    f.src = ctx.getResourceUrl(target) + (page ? `#page=${page[1]}` : "");
    f.className = "pdf-embed-frame";
    const size = parseSize(alias);
    if (size?.w) f.style.width = size.w + "px";
    if (size?.h) f.style.height = size.h + "px";
    span.replaceChildren(f);
    return;
  }
  if (ext !== "md" && ext !== "" && ctx.renderFileEmbed && (await ctx.renderFileEmbed(span, target, subpath, src, ctx.sourcePath))) return;
  if (ext !== "md" && ext !== "") {
    // unknown attachment: link to it
    span.classList.add("is-loaded", "file-embed");
    const a = document.createElement("a");
    a.className = "internal-link";
    a.setAttribute("data-href", src);
    a.href = src;
    a.textContent = baseName(target) + "." + ext;
    span.replaceChildren(a);
    return;
  }

  // note embed
  const box = document.createElement("div");
  box.className = "internal-embed markdown-embed inline-embed is-loaded";
  box.setAttribute("src", src);
  if (alias) box.setAttribute("alt", alias);
  const title = document.createElement("div");
  title.className = "markdown-embed-title";
  const size = parseSize(alias);
  const caption = size ? size.text : alias;
  title.textContent = caption || (path ? defaultDisplay(src) : defaultDisplay(baseName(target) + subpath));
  const content = document.createElement("div");
  content.className = "markdown-embed-content";
  const link = document.createElement("div");
  link.className = "markdown-embed-link";
  link.setAttribute("aria-label", "Open link");
  link.appendChild(linkIcon());
  box.append(title, content, link);
  span.replaceWith(box);

  const key = target + subpath;
  const max = ctx.maxEmbedDepth ?? 5;
  if (st.stack.includes(key) || st.stack.length > max) {
    box.classList.add("is-recursive");
    const msg = document.createElement("div");
    msg.className = "embed-recursion-message";
    msg.textContent = st.stack.includes(key) ? `Circular embed: ${baseName(target)}` : "Embed depth limit reached";
    content.appendChild(msg);
    return;
  }
  let raw: string;
  try {
    raw = await ctx.readFile(target);
  } catch {
    box.classList.add("is-unresolved");
    content.textContent = `Unable to read ${target}`;
    return;
  }
  const part = subpath ? extractSubpath(raw, subpath) : raw;
  if (part === null) {
    box.classList.add("is-unresolved");
    content.textContent = `Unable to find ${subpath}`;
    return;
  }
  content.classList.add("markdown-preview-view", "markdown-rendered");
  await renderInternal(part, content, { ...ctx, sourcePath: target }, {
    stack: [...st.stack, key],
    hideFrontmatter: true,
    children: st.children,
  });
}

// ---------------------------------------------------------------- code blocks

let mermaidLoader: Promise<any | null> | null = null;
function loadMermaid(): Promise<any | null> {
  if (!mermaidLoader) {
    const name = "mermaid";
    mermaidLoader = import(/* @vite-ignore */ name)
      .then((m) => {
        const mm = m.default ?? m;
        mm.initialize?.({ startOnLoad: false, securityLevel: "strict" });
        return mm;
      })
      .catch(() => null);
  }
  return mermaidLoader;
}
let mermaidId = 0;

async function processCodeBlocks(root: HTMLElement, ctx: RenderContext, pctx: PostProcessorContext): Promise<void> {
  const codes = Array.from(root.querySelectorAll<HTMLElement>("pre > code[data-lang]"));
  for (const code of codes) {
    const lang = code.getAttribute("data-lang") ?? "";
    const pre = code.parentElement as HTMLElement;
    const source = (code.textContent ?? "").replace(/\n$/, "");
    let proc: CodeBlockProcessor | undefined = ctx.codeBlockProcessors?.get(lang);
    if (!proc && lang === "mermaid") {
      const mm = await loadMermaid();
      if (!mm) continue; // degrade to a plain code block
      proc = async (src, el) => {
        const { svg } = await mm.render("tachylite-mermaid-" + ++mermaidId, src);
        el.classList.add("mermaid");
        el.innerHTML = svg;
      };
    }
    if (!proc) continue;
    const div = document.createElement("div");
    div.className = `block-language-${lang}`;
    const bid = pre.getAttribute("data-block-id");
    if (bid) div.setAttribute("data-block-id", bid);
    pre.replaceWith(div);
    try {
      await proc(source, div, pctx);
    } catch (e) {
      div.classList.add("markdown-rendered-error");
      div.textContent = `Error rendering ${lang} block: ${(e as Error).message ?? e}`;
    }
  }
}

// ---------------------------------------------------------------- event handling

function attachHandlers(el: HTMLElement, ctx: RenderContext): void {
  const existing = rootCtx.get(el);
  if (existing) {
    existing.ctx = ctx;
    return;
  }
  const holder = { ctx, root: el };
  rootCtx.set(el, holder);
  const handler = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest) return;
    const c = holder.ctx;
    const newLeaf = paneFor(e);
    if (e.type === "auxclick" && e.button !== 1) return;

    const internal = target.closest<HTMLElement>("a.internal-link");
    if (internal && el.contains(internal)) {
      e.preventDefault();
      e.stopPropagation();
      const href = internal.getAttribute("data-href") ?? "";
      const { path, subpath } = splitLinktext(href);
      if (!path && subpath) {
        scrollToSubpath(el, subpath);
        return;
      }
      c.openLink(href, c.sourcePath, newLeaf);
      return;
    }
    const tag = target.closest<HTMLElement>("a.tag");
    if (tag && el.contains(tag)) {
      e.preventDefault();
      e.stopPropagation();
      c.openTag?.(tag.getAttribute("href") ?? "");
      return;
    }
    const fn = target.closest<HTMLElement>("a.footnote-link, a.footnote-backref");
    if (fn && el.contains(fn)) {
      e.preventDefault();
      e.stopPropagation();
      const id = (fn.getAttribute("href") ?? "").slice(1);
      const dest = Array.from(el.querySelectorAll<HTMLElement>("[id]")).find((n) => n.id === id);
      (dest as any)?.scrollIntoView?.({ block: "center" });
      return;
    }
    const copy = target.closest<HTMLElement>(".copy-code-button");
    if (copy && el.contains(copy)) {
      e.preventDefault();
      e.stopPropagation();
      const code = copy.parentElement?.querySelector("code")?.textContent ?? "";
      void navigator.clipboard?.writeText(code.replace(/\n$/, ""))?.catch(() => {});
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
      return;
    }
    const embedLink = target.closest<HTMLElement>(".markdown-embed-link");
    if (embedLink && el.contains(embedLink)) {
      e.preventDefault();
      e.stopPropagation();
      const src = embedLink.closest(".markdown-embed")?.getAttribute("src") ?? "";
      c.openLink(src, c.sourcePath, newLeaf);
      return;
    }
    const head = target.closest<HTMLElement>(".frontmatter-container .metadata-properties-heading");
    if (head && el.contains(head)) {
      const box = head.closest(".frontmatter-container")!;
      const collapsed = box.classList.toggle("is-collapsed");
      head.querySelector(".collapse-indicator")?.classList.toggle("is-collapsed", collapsed);
    }
  };
  el.addEventListener("click", handler);
  el.addEventListener("auxclick", handler);
}

/** Render a single inline markdown string to sanitized HTML (used for table cells, properties). */
export function renderInline(md: string, ctx: RenderContext): string {
  const mdIt = getParser(!!ctx.strictLineBreaks);
  const env = newEnv(ctx, ctx.sourcePath);
  const tmp = document.createElement("div");
  tmp.innerHTML = mdIt.renderInline(md, env);
  sanitize(tmp);
  processLinks(tmp, ctx);
  return tmp.innerHTML;
}
