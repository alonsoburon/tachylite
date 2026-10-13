// Glue between the Obsidian-API model (ui/src/obsidian) and the real renderers:
// editor factory (CM6 Live Preview), reading-view markdown renderer, external links.
import type { EditorView } from "@codemirror/view";
import { createEditor, type EditorHandle, type EditorHost, type EditorMode, type LinkTarget } from "../editor";
import { renderMarkdown, type RenderContext } from "../markdown";
import { ipc } from "../ipc";
import { Component, MarkdownPreviewRenderer, MarkdownRenderer, prepareFuzzySearch, type App } from "../obsidian";
import { setEditorFactory } from "../obsidian/editor";
import { setMarkdownRenderer } from "../obsidian/markdown";

/** CM6 view -> handle of the real editor (mode switching, source path). */
export const editorHandles = new WeakMap<EditorView, EditorHandle>();

export function openExternal(url: string): void {
  if (!/^(https?:|mailto:|obsidian:)/i.test(url)) return;
  void ipc.openUrl(url).catch((e) => console.warn("open_url failed", e));
}

export function makeEditorHost(app: App): EditorHost {
  const md = (p: string) => app.vault.getFileByPath(p);
  return {
    resolveLink: (lp, src) => app.metadataCache.getFirstLinkpathDest(lp, src)?.path ?? null,
    getResourceUrl: (p) => app.vault.adapter.getResourcePath(p),
    openLink: (lt, src, newLeaf) => { void app.workspace.openLinkText(lt, src, newLeaf ? "tab" : false); },
    readFile: async (p) => { const f = md(p); return f ? app.vault.cachedRead(f) : app.vault.adapter.read(p); },
    openTag: (tag) => { void openTagSearch(app, tag); },
    openExternal,
    listTags: () => Object.keys(app.metadataCache.getTags()),
    listLinkTargets: (query, source) => linkTargets(app, query, source),
    codeBlockLanguages: () => MarkdownPreviewRenderer.getCodeBlockLanguages(),
    renderCodeBlock: async (el, markdown, sourcePath) => {
      const comp = new Component();
      comp.load();
      await MarkdownRenderer.render(app, markdown, el, sourcePath, comp);
      return comp;
    },
  };
}

export async function openTagSearch(app: App, tag: string): Promise<void> {
  const leaf = await app.workspace.ensureSideLeaf("search", "left", { active: true, reveal: true });
  (leaf.view as any).setQuery?.(`tag:${tag.startsWith("#") ? tag : "#" + tag}`);
}

function linkTargets(app: App, query: string, source: string): LinkTarget[] {
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
        if (am) out.push({ score: am.score - 0.01, t: { linktext: `${file.path.replace(/\.md$/, "")}|${a}`, label: String(a), detail: file.path, type: "alias" } });
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
      if (/^[a-z][a-z0-9+.-]*:/i.test(lt) && !/^[a-z]:[\\/]/i.test(lt)) { openExternal(lt); return; }
      void app.workspace.openLinkText(lt, src, newLeaf ? "tab" : false);
    },
    openTag: (tag) => { void openTagSearch(app, tag); },
    addChild: component ? (c) => component.addChild(c) : undefined,
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
  });
  return () => { setEditorFactory(null); setMarkdownRenderer(null); };
}
