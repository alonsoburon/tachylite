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
  openLink(linktext: string, sourcePath: string, newLeaf: boolean): void;
  postProcessors?: PostProcessor[];
  codeBlockProcessors?: Map<string, CodeBlockProcessor>;
  maxEmbedDepth?: number;
  /** Optional extras (not required by the app model). */
  openTag?(tag: string): void;
  addChild?(child: ChildLike): void;
  /**
   * Embed renderer for a file extension the renderer does not handle itself (e.g. `canvas`, or ones plugins register in
   * app.embedRegistry). It fills `el`, the embed span (classes `internal-embed is-loaded` already set).
   */
  getEmbedRenderer?(ext: string): ((el: HTMLElement, target: string, subpath: string, alias: string) => void | Promise<void>) | null;
  /** When true a single newline is NOT a line break. Default false (Obsidian default). */
  strictLineBreaks?: boolean;
}

export interface RenderViewOptions {
  /** Add `markdown-preview-view markdown-rendered` to the root element. Default true. */
  rootClasses?: boolean;
  /** Skip frontmatter block (used for embeds). */
  hideFrontmatter?: boolean;
}
