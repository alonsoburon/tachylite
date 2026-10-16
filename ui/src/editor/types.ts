import type { Extension } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import type { RenderContext } from "../markdown/types";

export type EditorMode = "source" | "live-preview";

export interface LinkTarget {
  /** Text to insert between `[[` and `]]` (e.g. `folder/Note`, `Note#Heading`, `Note#^abc123`). */
  linktext: string;
  /** Displayed label (defaults to linktext). */
  label?: string;
  /** Secondary text (folder, heading level, block excerpt...). */
  detail?: string;
  type: "file" | "heading" | "block" | "alias" | "unresolved";
}

export interface EditorHost {
  resolveLink(linkpath: string, sourcePath: string): string | null;
  /**
   * Autocomplete backend. `query` is everything typed after `[[` up to the cursor
   * (before any `|`), e.g. `Not`, `Note#Hea`, `Note#^ab`. The host filters/ranks.
   */
  listLinkTargets(query: string, sourcePath: string): LinkTarget[] | Promise<LinkTarget[]>;
  /** All tags known in the vault (with or without leading `#`). */
  listTags(): string[] | Promise<string[]>;
  getResourceUrl(path: string): string;
  /** `newLeaf`: false = same tab, true or "tab" = new tab, "split" = split to the side, "window" = new window. */
  openLink(linktext: string, sourcePath: string, newLeaf: boolean | "tab" | "split" | "window"): void;
  readFile(path: string): Promise<string>;
  /** Render a note/media embed into `el`. If omitted, the built-in markdown renderer is used. */
  renderEmbed?(el: HTMLElement, linktext: string, sourcePath: string): void | Promise<void>;
  openTag?(tag: string): void;
  /** Save the note now (Vim `:w`). */
  save?(sourcePath: string): void;
  /** See RenderContext.renderFileEmbed (embeds of non-markdown file types registered in app.embedRegistry: `.canvas`, `.base`, plugin types). */
  renderFileEmbed?(el: HTMLElement, path: string, subpath: string, linktext: string, sourcePath: string): boolean | Promise<boolean>;
  openExternal?(url: string): void;
  /**
   * Linux: the primary selection (the text last selected anywhere). When provided, a middle-click in the editor
   * pastes it at the click position through this instead of the webview's own paste, which can hang the page.
   */
  /** Whether pasted HTML is converted to Markdown (app.json `autoConvertHtml`, default on). */
  autoConvertHtml?(): boolean;
  readPrimarySelection?(): Promise<string | null>;
  /** Fired for paste and drop before the editor handles them, so the app can emit `editor-paste` / `editor-drop`; `preventDefault()` on the event cancels the default handling. */
  editorEvent?(name: "editor-paste" | "editor-drop", e: ClipboardEvent | DragEvent, view: EditorView): void;
  /**
   * Store pasted or dropped files as attachments and return the links to insert (one per line). `pasted` is true for
   * the clipboard, where an image has no real file name and gets a timestamped one.
   */
  /** The link to insert when a vault file (dragged from the file explorer) is dropped into the editor; null when `path` is not a file. */
  linkForFile?(path: string, sourcePath: string): string | null;
  saveAttachments?(files: File[], sourcePath: string, pasted: boolean): Promise<string>;
  /** Languages of fenced blocks that plugins render themselves (code-block processors). */
  codeBlockLanguages?(): string[];
  /** Render a whole fenced block (```lang ... ```) through the plugins' processors; the handle is unloaded with the widget. */
  renderCodeBlock?(el: HTMLElement, markdown: string, sourcePath: string, info?: CodeBlockRenderInfo): { unload(): void } | void | Promise<{ unload(): void } | void>;
  /** Show a context menu (Live Preview table cells). Without it, the table widget has no context menu. */
  /** app.json `propertiesInDocument`: "visible" (editable table, default), "hidden", or "source" (raw YAML). */
  propertiesInDocument?(): "visible" | "hidden" | "source";
  /** Draw the editable Properties table for valid frontmatter; null = use the built-in read-only block. */
  renderProperties?(el: HTMLElement, frontmatter: Record<string, unknown>, sourcePath: string): { destroy(): void } | null;
  showMenu?(evt: MouseEvent, items: { title: string; icon: string; section: string; checked?: boolean; disabled?: boolean; onClick(): void }[]): void;
}

/** Live data about a Live Preview code-block widget (backs `MarkdownPostProcessorContext.getSectionInfo`). */
export interface CodeBlockRenderInfo {
  getSectionInfo(): { text: string; lineStart: number; lineEnd: number } | null;
}

export interface EditorOptions {
  doc?: string;
  mode?: EditorMode;
  host: EditorHost;
  /** Vault path of the note being edited; used to resolve relative links. */
  sourcePath?: string;
  onChange?(doc: string, update: ViewUpdate): void;
  readOnly?: boolean;
  /** Vim key bindings (app.json `vimMode`). */
  vimMode?: boolean;
  lineWrapping?: boolean;
  tabSize?: number;
  /** Indent with a tab character (default true, like Obsidian). */
  useTabs?: boolean;
  spellcheck?: boolean;
  showLineNumbers?: boolean;
  /** Show fold markers for headings (default true). */
  foldHeading?: boolean;
  /** Show fold markers for list items (default true). */
  foldIndent?: boolean;
  /** Accepted for API parity; only affects reading view. */
  strictLineBreaks?: boolean;
  extraExtensions?: Extension[];
}

export interface EditorHandle {
  view: EditorView;
  readonly mode: EditorMode;
  setMode(mode: EditorMode): void;
  setValue(doc: string): void;
  getValue(): string;
  focus(): void;
  destroy(): void;
  /** Update a subset of options at runtime. */
  reconfigure(opts: Partial<Omit<EditorOptions, "host" | "doc" | "mode" | "onChange">>): void;
  setSourcePath(path: string): void;
}
