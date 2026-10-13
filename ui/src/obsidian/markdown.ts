// Markdown rendering glue: renderer hook, post-processor and code-block-processor registries,
// MarkdownRenderChild / MarkdownRenderer / MarkdownPreviewRenderer.
import { Component } from "./events";
import type { App } from "./app";
import type { TFile } from "./files";

export interface MarkdownSectionInformation { text: string; lineStart: number; lineEnd: number }
export interface MarkdownPostProcessorContext {
  docId: string;
  sourcePath: string;
  frontmatter: any | null | undefined;
  addChild(child: MarkdownRenderChild): void;
  getSectionInfo(el: HTMLElement): MarkdownSectionInformation | null;
}
export interface MarkdownPostProcessor {
  (el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<any> | void;
  sortOrder?: number;
}

/** What the markdown pipeline must provide: turn `markdown` into DOM under `el`. Post-processors are run by us afterwards. */
export interface RenderRequest {
  app: App;
  markdown: string;
  el: HTMLElement;
  sourcePath: string;
  component: Component;
}
export type MarkdownRendererFn = (req: RenderRequest) => Promise<void> | void;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** Trivial default: paragraphs split on blank lines, fenced code blocks to `pre > code.language-x`. */
export const defaultMarkdownRenderer: MarkdownRendererFn = ({ markdown, el }) => {
  const lines = markdown.split(/\r?\n/);
  let html = "", para: string[] = [], i = 0;
  const flush = () => { if (para.length) { html += `<p>${escapeHtml(para.join("\n"))}</p>`; para = []; } };
  while (i < lines.length) {
    const fence = /^```\s*([\w-]*)/.exec(lines[i]);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      html += `<pre><code${fence[1] ? ` class="language-${fence[1]}"` : ""}>${escapeHtml(body.join("\n"))}\n</code></pre>`;
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (h) { flush(); html += `<h${h[1].length}>${escapeHtml(h[2])}</h${h[1].length}>`; }
    else if (!lines[i].trim()) flush();
    else para.push(lines[i]);
    i++;
  }
  flush();
  el.innerHTML = html;
};

let renderer: MarkdownRendererFn = defaultMarkdownRenderer;
export function setMarkdownRenderer(fn: MarkdownRendererFn | null): void { renderer = fn ?? defaultMarkdownRenderer; }
export function getMarkdownRenderer(): MarkdownRendererFn { return renderer; }

// ---- post-processor registry (global, like MarkdownPreviewRenderer's statics)
interface PPEntry { fn: MarkdownPostProcessor; sortOrder: number }
let postProcessors: PPEntry[] = [];

export class MarkdownPreviewRenderer {
  static registerPostProcessor(postProcessor: MarkdownPostProcessor, sortOrder?: number): void {
    const so = sortOrder ?? postProcessor.sortOrder ?? 0;
    postProcessor.sortOrder = so;
    postProcessors.push({ fn: postProcessor, sortOrder: so });
    postProcessors.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  static unregisterPostProcessor(postProcessor: MarkdownPostProcessor): void {
    postProcessors = postProcessors.filter((e) => e.fn !== postProcessor);
  }
  static createCodeBlockPostProcessor(language: string, handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<any> | void) {
    const fn = (el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> | void => {
      const jobs: Promise<unknown>[] = [];
      for (const code of Array.from(el.querySelectorAll<HTMLElement>("pre > code"))) {
        if (!code.classList.contains(`language-${language}`)) continue;
        const pre = code.parentElement!;
        const source = (code.textContent ?? "").replace(/\n$/, "");
        const container = pre.ownerDocument.createElement("div");
        container.className = `block-language-${language}`;
        pre.replaceWith(container);
        try {
          const r = handler(source, container, ctx);
          if (r && typeof (r as Promise<unknown>).then === "function") jobs.push(Promise.resolve(r).catch((e) => console.error(e)));
        } catch (e) { console.error(e); }
      }
      if (jobs.length) return Promise.all(jobs).then(() => {});
    };
    (fn as any).codeBlockLanguage = language;
    (fn as any).codeBlockHandler = handler;
    return fn;
  }
  /** Languages claimed by registered code-block processors (Live Preview renders those blocks as widgets). */
  static getCodeBlockLanguages(): string[] {
    return [...new Set(postProcessors.map((e) => (e.fn as any).codeBlockLanguage as string | undefined).filter((l): l is string => !!l))];
  }
  static getPostProcessors(): MarkdownPostProcessor[] { return postProcessors.map((e) => e.fn); }
}

export function clearPostProcessors(): void { postProcessors = []; }

export function createPostProcessorContext(app: App, sourcePath: string, component: Component, extra?: Partial<MarkdownPostProcessorContext>): MarkdownPostProcessorContext {
  return {
    docId: Math.random().toString(16).slice(2, 10),
    sourcePath,
    frontmatter: app.metadataCache.getCache(sourcePath)?.frontmatter,
    addChild: (child) => component.addChild(child),
    getSectionInfo: () => null,
    ...extra,
  };
}

/** Run every registered post-processor on `el` (renderer implementations that render sections can call this per section). */
export async function runPostProcessors(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
  // Plugins may set `registered.sortOrder` after registering (Dataview does), so order by the current value.
  for (const { fn } of sortedProcessors()) {
    try { await fn(el, ctx); } catch (e) { console.error("markdown post-processor failed", e); }
  }
}

function sortedProcessors(): PPEntry[] {
  return postProcessors.map((e, i) => ({ e, i, so: e.fn.sortOrder ?? e.sortOrder })).sort((a, b) => a.so - b.so || a.i - b.i).map((x) => x.e);
}

/**
 * Run the code-block processor claiming `language` on `source` (fence body), the way Live Preview does: `el` becomes the
 * `block-language-<lang>` container. Returns false when no processor claims the language.
 */
export async function runCodeBlockProcessor(language: string, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<boolean> {
  const entry = sortedProcessors().find((e) => (e.fn as any).codeBlockLanguage === language);
  const handler = entry && ((entry.fn as any).codeBlockHandler as ((s: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => unknown) | undefined);
  if (!handler) return false;
  el.classList.add(`block-language-${language}`);
  try { await handler(source, el, ctx); } catch (e) { console.error(`code block processor "${language}" failed`, e); }
  return true;
}

export class MarkdownRenderChild extends Component {
  containerEl: HTMLElement;
  constructor(containerEl: HTMLElement) { super(); this.containerEl = containerEl; }
}

export abstract class MarkdownRenderer extends MarkdownRenderChild {
  static currentApp: App | null = null;
  app!: App;
  hoverPopover: any = null;
  abstract get file(): TFile;
  static async render(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
    await renderer({ app, markdown, el, sourcePath, component });
    await runPostProcessors(el, createPostProcessorContext(app, sourcePath, component));
  }
  static renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
    const app = MarkdownRenderer.currentApp ?? (globalThis as any).app;
    return MarkdownRenderer.render(app, markdown, el, sourcePath, component);
  }
}
