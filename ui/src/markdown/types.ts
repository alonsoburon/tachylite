/** Minimal child contract (compatible with Obsidian's Component). */
export interface ChildLike {
  load?(): void;
  unload?(): void;
}

export interface SectionInfo {
  text: string;
  lineStart: number;
  lineEnd: number;
}

/** Shape-compatible with obsidian.d.ts MarkdownPostProcessorContext. */
export interface PostProcessorContext {
  docId: string;
  sourcePath: string;
  frontmatter: Record<string, unknown> | null | undefined;
  addChild(child: ChildLike): void;
  getSectionInfo(el: HTMLElement): SectionInfo | null;
  containerEl: HTMLElement;
}

export type PostProcessor = (el: HTMLElement, ctx: PostProcessorContext) => void | Promise<void>;
export type CodeBlockProcessor = (
  source: string,
  el: HTMLElement,
  ctx: PostProcessorContext,
) => void | Promise<void>;

export interface RenderContext {
  sourcePath: string;
  /** Returns the vault path a link resolves to, or null when unresolved. */
  resolveLink(linkpath: string, sourcePath: string): string | null;
  readFile(path: string): Promise<string>;
  getResourceUrl(path: string): string;
  getFrontmatter?(path: string): Record<string, unknown> | null;
  /** `newLeaf`: false = same tab, true or "tab" = new tab, "split" = split to the side, "window" = new window. */
  openLink(linktext: string, sourcePath: string, newLeaf: boolean | "tab" | "split" | "window"): void;
  postProcessors?: PostProcessor[];
  codeBlockProcessors?: Map<string, CodeBlockProcessor>;
  maxEmbedDepth?: number;
  /** Optional extras (not required by the app model). */
  openTag?(tag: string): void;
  addChild?(child: ChildLike): void;
  /** Render an embed of a non-markdown file type the host knows (registered in app.embedRegistry: `.canvas`, `.base`, plugin types) into `el`; return false to fall back to a link. */
  renderFileEmbed?(el: HTMLElement, path: string, subpath: string, linktext: string, sourcePath: string): boolean | Promise<boolean>;
  /** app.json `propertiesInDocument` (default "visible"; "source" shows the YAML, "hidden" nothing). */
  propertiesInDocument?: "visible" | "hidden" | "source";
  /** Draw the editable Properties table into `el`; return false to use the read-only block. */
  renderProperties?(el: HTMLElement, frontmatter: Record<string, unknown>, sourcePath: string): boolean;
  /** When true a single newline is NOT a line break. Default false (Obsidian default). */
  strictLineBreaks?: boolean;
}

export interface RenderViewOptions {
  /** Add `markdown-preview-view markdown-rendered` to the root element. Default true. */
  rootClasses?: boolean;
  /** Skip frontmatter block (used for embeds). */
  hideFrontmatter?: boolean;
}
