import type { Extension } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";

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
  openLink(linktext: string, sourcePath: string, newLeaf: boolean): void;
  readFile(path: string): Promise<string>;
  /** Render a note/media embed into `el`. If omitted, the built-in markdown renderer is used. */
  renderEmbed?(el: HTMLElement, linktext: string, sourcePath: string): void | Promise<void>;
  openTag?(tag: string): void;
  openExternal?(url: string): void;
  /** Languages of fenced blocks that plugins render themselves (code-block processors). */
  codeBlockLanguages?(): string[];
  /** Render a whole fenced block (```lang ... ```) through the plugins' processors; the handle is unloaded with the widget. */
  renderCodeBlock?(el: HTMLElement, markdown: string, sourcePath: string): { unload(): void } | void | Promise<{ unload(): void } | void>;
  /** Show a context menu (Live Preview table cells). Without it, the table widget has no context menu. */
  showMenu?(evt: MouseEvent, items: { title: string; icon: string; section: string; checked?: boolean; disabled?: boolean; onClick(): void }[]): void;
}

export interface EditorOptions {
  doc?: string;
  mode?: EditorMode;
  host: EditorHost;
  /** Vault path of the note being edited; used to resolve relative links. */
  sourcePath?: string;
  onChange?(doc: string, update: ViewUpdate): void;
  readOnly?: boolean;
  vimMode?: false;
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
