// Glue between the Obsidian-API model (ui/src/obsidian) and the real renderers:
// editor factory (CM6 Live Preview), reading-view markdown renderer, external links.
import moment from "moment";
import type { EditorView } from "@codemirror/view";
import { createEditor, splitFence, type EditorHandle, type EditorHost, type EditorMode, type LinkTarget } from "../editor";
import { renderMarkdown, type RenderContext } from "../markdown";
import { ipc } from "../ipc";
import { Component, MarkdownPreviewRenderer, MarkdownPreviewView, MarkdownRenderer, Menu, Platform, prepareFuzzySearch, type App } from "../obsidian";
import { handleUri } from "./uri";
import { propertiesMode, renderPropertiesTable } from "./properties/embed";
import { editorInfoField, setEditorFactory } from "../obsidian/editor";
import { createPostProcessorContext, runCodeBlockProcessor, setMarkdownRenderer } from "../obsidian/markdown";

/** CM6 view -> handle of the real editor (mode switching, source path). */
export const editorHandles = new WeakMap<EditorView, EditorHandle>();

export function openExternal(url: string, app?: App): void {
  // obsidian:// and tachylite:// links (open, search, daily, ...) are this app's own; only unknown ones go to the OS.
  if (app && /^(obsidian|tachylite):/i.test(url)) {
    void handleUri(app, url).then((handled) => { if (!handled) openExternal(url); }).catch((e) => console.warn("uri failed", e));
    return;
  }
  if (!/^(https?:|mailto:|obsidian:)/i.test(url)) return;
  void ipc.openUrl(url).catch((e) => console.warn("open_url failed", e));
}

/** Embeds of extensions with a creator in app.embedRegistry that the markdown renderer does not draw itself (canvas, plugin types). */
/** Extensions the editor embeds (`![[…]]`) rather than links. */
const EMBEDDABLE = /\.(png|jpe?g|gif|svg|webp|bmp|avif|mp3|wav|m4a|ogg|3gp|flac|opus|mp4|webm|ogv|mov|mkv|pdf)$/i;
const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp", "image/avif": "avif" };

/** Store one pasted/dropped file in the vault's attachment folder and return the link to insert for it. */
export async function saveAttachment(app: App, file: File, sourcePath: string, pasted: boolean): Promise<string> {
  let name = file.name;
  if (pasted && (!name || /^image\.[a-z0-9]+$/i.test(name))) {
    const ext = MIME_EXT[file.type] ?? (name.split(".").pop() || "png");
    name = `Pasted image ${moment().format("YYYYMMDDHHmmss")}.${ext}`;
  }
  const path = await app.fileManager.getAvailablePathForAttachment(name || "file", sourcePath);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
  const saved = await app.vault.createBinary(path, await file.arrayBuffer());
  const link = app.fileManager.generateMarkdownLink(saved, sourcePath);
  // Markdown-style links: a pasted image has no alt text (it has no real name), a dropped file keeps its name.
  const styled = pasted ? link.replace(/^(!?)\[[^\]]*\]\(/, "$1[](") : link;
  return EMBEDDABLE.test(saved.path) && !styled.startsWith("!") ? "!" + styled : styled;
}

export function makeEditorHost(app: App): EditorHost {
  const md = (p: string) => app.vault.getFileByPath(p);
  return {
    resolveLink: (lp, src) => app.metadataCache.getFirstLinkpathDest(lp, src)?.path ?? null,
    getResourceUrl: (p) => app.vault.adapter.getResourcePath(p),
    openLink: (lt, src, newLeaf) => { void app.workspace.openLinkText(lt, src, newLeaf === true ? "tab" : newLeaf); },
    readFile: async (p) => { const f = md(p); return f ? app.vault.cachedRead(f) : app.vault.adapter.read(p); },
    openTag: (tag) => { void openTagSearch(app, tag); },
    openExternal: (u) => openExternal(u, app),
    editorEvent: (name, e, view) => {
      const info = view.state.field(editorInfoField, false);
      if (info) app.workspace.trigger(name, e, info.editor, info);
    },
    linkForFile: (path, sourcePath) => {
      const f = app.vault.getFileByPath(path);
      if (!f) return null;
      const link = app.fileManager.generateMarkdownLink(f, sourcePath);
      return EMBEDDABLE.test(f.path) && !link.startsWith("!") ? "!" + link : link;
    },
    saveAttachments: async (files, sourcePath, pasted) => {
      const links: string[] = [];
      for (const f of files) links.push(await saveAttachment(app, f, sourcePath, pasted));
      return links.join("\n");
    },
    // Only Linux has a primary selection; elsewhere the middle button does nothing special in the editor.
    autoConvertHtml: () => app.vault.getConfig("autoConvertHtml") !== false,
    readPrimarySelection: Platform.isLinux ? () => ipc.readPrimarySelection().catch(() => null) : undefined,
    save: (path) => {
      for (const leaf of app.workspace.getLeavesOfType("markdown")) {
        const v = leaf.view as unknown as { file?: { path: string }; save?(): Promise<void> };
        if (v.file?.path === path) void v.save?.();
      }
    },
    listTags: () => Object.keys(app.metadataCache.getTags()),
    listLinkTargets: (query, source) => linkTargets(app, query, source),
    codeBlockLanguages: () => MarkdownPreviewRenderer.getCodeBlockLanguages(),
    renderFileEmbed: fileEmbedRenderer(app),
    propertiesInDocument: () => propertiesMode(app),
    renderProperties: (el, fm, sourcePath) => renderPropertiesTable(app, el, fm, sourcePath),
    renderCodeBlock: async (el, markdown, sourcePath, info) => {
      const comp = new Component();
      comp.load();
      const { lang, source } = splitFence(markdown);
      const ctx = createPostProcessorContext(app, sourcePath, comp, info ? { getSectionInfo: () => info.getSectionInfo() } : undefined);
      if (!(await runCodeBlockProcessor(lang, source, el, ctx))) await MarkdownRenderer.render(app, markdown, el, sourcePath, comp);
      return comp;
    },
    showMenu: (evt, items) => {
      const menu = new Menu();
      for (const it of items) {
        menu.addItem((i) => {
          i.setSection(it.section).setTitle(it.title).setIcon(it.icon).setDisabled(!!it.disabled).onClick(() => it.onClick());
          if (it.checked) i.setChecked(true);
        });
      }
      menu.showAtMouseEvent(evt);
    },
  };
}

/**
 * Embeds of file types registered in app.embedRegistry beyond what the markdown renderer handles itself (`.base`, plugin
 * types). The component is a child of `component` when given; otherwise it lives as long as its element (Live Preview).
 */
export function fileEmbedRenderer(app: App, component?: { addChild(c: any): any }) {
  return (el: HTMLElement, path: string, subpath: string, linktext: string, sourcePath: string): boolean => {
    const file = app.vault.getFileByPath(path);
    const creator = file && file.extension !== "md" ? app.embedRegistry.getEmbedCreator(file) : null;
    if (!file || !creator) return false;
    el.addClass("is-loaded");
    el.empty();
    const child = creator({ app, containerEl: el, linktext, sourcePath, depth: 0 }, file, subpath);
    component?.addChild(child);
    // Render children of a component that is not loaded (the reading view) still need to run; they unload once detached.
    if (!child._loaded) child.load();
    return true;
  };
}

export async function openTagSearch(app: App, tag: string): Promise<void> {
  const leaf = await app.workspace.ensureSideLeaf("search", "left", { active: true, reveal: true });
  (leaf.view as any).setQuery?.(`tag:${tag.startsWith("#") ? tag : "#" + tag}`);
}

function linkTargets(app: App, query: string, source: string): LinkTarget[] {
  const out = wikiTargets(app, query, source);
  if (!app.vault.getConfig("useMarkdownLinks")) return out;
  // Markdown-links vaults get `[text](path)` from the same suggestions.
  return out.map((t) => {
    const [target, alias] = t.linktext.split("|");
    const hash = target.indexOf("#");
    const name = hash >= 0 ? target.slice(0, hash) : target;
    const sub = hash >= 0 ? target.slice(hash) : "";
    const file = name ? app.metadataCache.getFirstLinkpathDest(name, source) : app.vault.getFileByPath(source);
    if (!file) return t;
    return { ...t, markdown: app.fileManager.generateMarkdownLink(file, source, sub, alias).replace(/^!/, "") };
  });
}

function wikiTargets(app: App, query: string, source: string): LinkTarget[] {
  const hash = query.indexOf("#");
  if (hash >= 0) {
    const name = query.slice(0, hash), sub = query.slice(hash + 1);
    const file = name ? app.metadataCache.getFirstLinkpathDest(name, source) : app.vault.getFileByPath(source);
    const cache = file ? app.metadataCache.getFileCache(file) : null;
    if (!file || !cache) return [];
    const base = name ? app.metadataCache.fileToLinktext(file, source, true) : "";
    if (sub.startsWith("^")) {
      return Object.values(cache.blocks ?? {}).map((b: any) => ({ linktext: `${base}#^${b.id}`, label: `^${b.id}`, type: "block" as const }));
    }
    const f = prepareFuzzySearch(sub);
    return (cache.headings ?? []).filter((h) => !sub || f(h.heading)).map((h) => ({ linktext: `${base}#${h.heading}`, label: h.heading, detail: `H${h.level}`, type: "heading" as const }));
  }
  const f = prepareFuzzySearch(query);
  const out: { t: LinkTarget; score: number }[] = [];
  for (const file of app.vault.getFiles()) {
    const isMd = file.extension === "md";
    const text = isMd ? file.path.replace(/\.md$/, "") : file.path;
    const m = f(text);
    if (m) out.push({ score: m.score, t: { linktext: app.metadataCache.fileToLinktext(file, source, true), label: isMd ? file.basename : file.name, detail: file.parent && !file.parent.isRoot() ? file.parent.path : undefined, type: "file" } });
    if (isMd) {
      const aliases = app.metadataCache.getFileCache(file)?.frontmatter?.aliases;
      for (const a of Array.isArray(aliases) ? aliases : typeof aliases === "string" ? [aliases] : []) {
        const am = f(String(a));
        if (am) out.push({ score: am.score - 0.01, t: { linktext: `${app.metadataCache.fileToLinktext(file, source, true)}|${a}`, label: String(a), detail: file.path, type: "alias" } });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 60).map((x) => x.t);
}

export function makeRenderContext(app: App, sourcePath: string, component?: { addChild(c: any): any }): RenderContext {
  return {
    sourcePath,
    resolveLink: (lp, src) => app.metadataCache.getFirstLinkpathDest(lp, src)?.path ?? null,
    readFile: async (p) => { const f = app.vault.getFileByPath(p); return f ? app.vault.cachedRead(f) : app.vault.adapter.read(p); },
    getResourceUrl: (p) => app.vault.adapter.getResourcePath(p),
    getFrontmatter: (p) => app.metadataCache.getCache(p)?.frontmatter ?? null,
    openLink: (lt, src, newLeaf) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(lt) && !/^[a-z]:[\\/]/i.test(lt)) { openExternal(lt, app); return; }
      void app.workspace.openLinkText(lt, src, newLeaf === true ? "tab" : newLeaf);
    },
    openTag: (tag) => { void openTagSearch(app, tag); },
    addChild: component ? (c) => component.addChild(c) : undefined,
    renderFileEmbed: fileEmbedRenderer(app, component),
    propertiesInDocument: propertiesMode(app),
    // Editable only in a note's own reading view; other renders (embeds, plugins) keep the read-only block.
    renderProperties: component instanceof MarkdownPreviewView ? (el, fm, sourcePath) => {
      const h = renderPropertiesTable(app, el, fm, sourcePath);
      if (h) component.addChild(h.component);
      return !!h;
    } : undefined,
    strictLineBreaks: !!app.vault.getConfig("strictLineBreaks"),
  };
}

/** Wire the real editor and reading-view renderer into the model. Returns an undo function. */
export function installBridge(app: App): () => void {
  const host = makeEditorHost(app);
  setEditorFactory({
    create({ parent, doc, extensions }) {
      const cfg = (k: string) => app.vault.getConfig(k);
      const mode: EditorMode = cfg("livePreview") === false ? "source" : "live-preview";
      const handle = createEditor(parent, {
        doc, host, mode, extraExtensions: extensions,
        tabSize: cfg("tabSize"), useTabs: cfg("useTab"), spellcheck: cfg("spellcheck"),
        showLineNumbers: cfg("showLineNumber"), foldHeading: cfg("foldHeading"), foldIndent: cfg("foldIndent"),
        vimMode: !!cfg("vimMode"),
      });
      editorHandles.set(handle.view, handle);
      return handle.view;
    },
  });
  setMarkdownRenderer(async ({ app: a, markdown, el, sourcePath, component }) => {
    await renderMarkdown(markdown, el, makeRenderContext(a, sourcePath, component));
    // The renderer wraps its output in `.markdown-preview-sizer`; Obsidian's MarkdownRenderer.render does not
    // (callers such as the reading view and plugins provide their own container), so unwrap it.
    for (const sizer of Array.from(el.querySelectorAll<HTMLElement>(":scope > .markdown-preview-sizer"))) sizer.replaceWith(...Array.from(sizer.childNodes));
    // Outside the reading view (whose container is the sizer) it is flat too: no `.el-*` section wrappers and no whitespace
    // text between blocks. Plugins rely on that, e.g. Dataview unwraps a lone `:scope > p` when `childNodes.length == 1`.
    if (el.classList.contains("markdown-preview-sizer")) return;
    for (const sec of Array.from(el.querySelectorAll<HTMLElement>(":scope > .markdown-preview-section"))) sec.replaceWith(...Array.from(sec.childNodes));
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3 && !/\S/.test(n.textContent ?? "")) n.remove();
  });
  return () => { setEditorFactory(null); setMarkdownRenderer(null); };
}
