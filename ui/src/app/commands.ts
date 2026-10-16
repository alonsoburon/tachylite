// Core commands (ids follow Obsidian's public command ids) and their default hotkeys.
import { FileView, FuzzySuggestModal, MarkdownView, Notice, TFile, TFolder, WorkspaceTabs, WorkspaceWindow, type App, type Command, type Hotkey, type WorkspaceLeaf } from "../obsidian";
import {
  indentListLess, indentListMore, insertLink, toggleBold, toggleChecklist, toggleHighlight, toggleInlineCode, toggleItalic, toggleStrikethrough,
} from "../editor";
import { linkAt } from "../editor";
import { openExternal } from "./bridge";
import {
  deleteParagraph, insertCallout, insertCodeBlock, insertEmbed, insertHorizontalRule, insertMathBlock, insertTable, insertTag, insertWikilink,
  clearFormatting, insertFootnote, setHeading, toggleBlockquote, toggleBulletList, toggleNumberedList,
} from "../editor";
import { foldAll, toggleFold, unfoldAll } from "@codemirror/language";
import { moveLineDown, moveLineUp } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { copyText, deleteWithPrompt, moveInto, newNote, promptRename, revealInExplorer } from "./files";
import type { History } from "./history";
import { coreEnabled, whileCoreEnabled } from "./core/util";
import { TachyMarkdownView } from "./markdownView";
import { ipc } from "../ipc";
import { uriForFile } from "./uri";

const HELP_URL = "https://github.com/alonsoburon/tachylite#readme";
const mod = (key: string, ...more: Hotkey["modifiers"]): Hotkey[] => [{ modifiers: ["Mod", ...more], key }];

export function openVaultSwitcher(): void {
  sessionStorage.setItem("tachylite-show-picker", "1");
  location.reload();
}

const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
/** Picker behind "Move current file to another folder": every folder, the vault root first. */
class FolderPicker extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private file: TFile) { super(app); this.setPlaceholder("Move file to..."); }
  getItems(): TFolder[] { return this.app.vault.getAllFolders(true); }
  getItemText(f: TFolder): string { return f.isRoot() ? "/" : f.path; }
  onChooseItem(f: TFolder): void { void moveInto(this.app, this.file, f).catch((e) => new Notice(String(e?.message ?? e))); }
}

const ZOOM_KEY = "zoom";
const ZOOM_STEP = 0.1;
/** Page zoom: persisted per vault, applied by the shell (the webview's own zoom, so layout and popovers stay correct). */
export function applyZoom(app: App, factor: number): void {
  const f = Math.min(3, Math.max(0.5, Math.round(factor * 100) / 100));
  app.saveLocalStorage(ZOOM_KEY, f === 1 ? null : f);
  void ipc.setZoom(f).catch(() => {});
}
export function restoreZoom(app: App): void {
  const f = app.loadLocalStorage(ZOOM_KEY);
  if (typeof f === "number" && f !== 1) void ipc.setZoom(f).catch(() => {});
}

export function installCommands(app: App, history: History): () => void {
  const ws = app.workspace;
  const active = (): TachyMarkdownView | null => ws.getActiveViewOfType(MarkdownView) as TachyMarkdownView | null;
  const activeFileView = (): FileView | null => (ws.activeLeaf?.view instanceof FileView && ws.activeLeaf.view.file ? ws.activeLeaf.view : null);
  const mainTabs = (): { tabs: WorkspaceTabs; leaf: WorkspaceLeaf } | null => {
    const l = ws.activeLeaf;
    return l && l.parent instanceof WorkspaceTabs ? { tabs: l.parent, leaf: l } : null;
  };
  /** The active leaf when it is a tab of the main area or of a popout (not a sidebar). */
  const rootLeaf = (): WorkspaceLeaf | null => { const l = ws.activeLeaf; const r = l?.getRoot(); return l && (r === ws.rootSplit || r instanceof WorkspaceWindow) ? l : null; };
  const cmdIds: string[] = [];
  const add = (c: Command) => { app.commands.addCommand(c); cmdIds.push(c.id); };
  const cm = (e: { cm?: EditorView }) => e.cm as EditorView;

  // ---- app
  const zoom = (delta: number | null) => () => { applyZoom(app, delta === null ? 1 : (app.loadLocalStorage(ZOOM_KEY) ?? 1) + delta); };
  // Both "=" and "+" zoom in (Ctrl+= and Ctrl+Shift+=), as do the numpad keys.
  add({ id: "app:zoom-in", name: "Zoom in", hotkeys: [{ modifiers: ["Mod"], key: "=" }, { modifiers: ["Mod", "Shift"], key: "+" }, { modifiers: ["Mod"], key: "+" }], callback: zoom(ZOOM_STEP) });
  add({ id: "app:zoom-out", name: "Zoom out", hotkeys: mod("-"), callback: zoom(-ZOOM_STEP) });
  add({ id: "app:zoom-reset", name: "Reset zoom", hotkeys: mod("0"), callback: zoom(null) });
  add({ id: "app:open-settings", name: "Open settings", hotkeys: mod(","), callback: () => app.setting.open() });
  add({ id: "app:go-back", name: "Navigate back", hotkeys: [{ modifiers: ["Alt"], key: "ArrowLeft" }], checkCallback: (c) => { if (!history.canGo(-1)) return false; if (!c) void history.go(-1); return true; } });
  add({ id: "app:go-forward", name: "Navigate forward", hotkeys: [{ modifiers: ["Alt"], key: "ArrowRight" }], checkCallback: (c) => { if (!history.canGo(1)) return false; if (!c) void history.go(1); return true; } });
  add({ id: "app:toggle-ribbon", name: "Toggle ribbon", callback: () => { app.vault.setConfig("showRibbon", app.vault.getConfig("showRibbon") === false); app.workspace.trigger("config-changed"); } });
  add({ id: "app:toggle-left-sidebar", name: "Toggle left sidebar", callback: () => ws.leftSplit.toggle() });
  add({ id: "app:toggle-right-sidebar", name: "Toggle right sidebar", callback: () => ws.rightSplit.toggle() });
  add({ id: "app:open-vault-switcher", name: "Open another vault", callback: openVaultSwitcher });
  add({ id: "app:reload", name: "Reload app without saving", callback: () => location.reload() });
  add({ id: "app:open-help", name: "Open help", callback: () => { void ipc.openUrl(HELP_URL).catch((e) => new Notice(String(e.message ?? e))); } });
  add({ id: "workspace:copy-url", name: "Copy Tachylite URL", checkCallback: (c) => { const f = ws.getActiveFile(); if (!f) return false; if (!c) { copyText(uriForFile(app, f)); new Notice("URL copied to clipboard"); } return true; } });

  // ---- files
  add({ id: "file-explorer:new-file", name: "Create new note", hotkeys: mod("n"), callback: () => { void newNote(app, { open: ws.activeLeaf?.view.getViewType() === "empty" && ws.activeLeaf.getRoot() === ws.rootSplit ? true : "tab" }); } });
  add({ id: "file-explorer:new-file-in-new-tab", name: "Create note in new tab", callback: () => { void newNote(app, { open: "tab" }); } });
  add({ id: "file-explorer:new-file-in-current-tab", name: "Create note in current tab", callback: () => { void newNote(app, { open: true }); } });
  add({ id: "file-explorer:reveal-active-file", name: "Reveal current file in navigation", checkCallback: (c) => { const f = ws.getActiveFile(); if (!f) return false; if (!c) revealInExplorer(app, f); return true; } });
  add({ id: "workspace:rename-file", name: "Rename current file", checkCallback: (c) => { const f = ws.getActiveFile(); if (!f) return false; if (!c) void promptRename(app, f); return true; } });
  add({ id: "app:delete-file", name: "Delete current file", checkCallback: (c) => { const f = ws.getActiveFile(); if (!f) return false; if (!c) void deleteWithPrompt(app, f); return true; } });
  add({ id: "workspace:copy-path", name: "Copy file path", checkCallback: (c) => { const f = ws.getActiveFile(); if (!f) return false; if (!c) { copyText(f.path); new Notice("Path copied to clipboard"); } return true; } });

  // ---- workspace / tabs
  add({ id: "workspace:new-tab", name: "New tab", hotkeys: mod("t"), callback: () => { const l = ws.getLeaf("tab"); ws.setActiveLeaf(l, { focus: true }); } });
  add({ id: "workspace:close", name: "Close current tab", hotkeys: mod("w"), checkCallback: (c) => { const l = rootLeaf(); if (!l) return false; if (!c) l.detach(); return true; } });
  add({ id: "workspace:next-tab", name: "Go to next tab", hotkeys: [{ modifiers: ["Ctrl"], key: "Tab" }], checkCallback: (c) => { const t = mainTabs(); if (!t || t.tabs.children.length < 2) return false; if (!c) ws.setActiveLeaf(t.tabs.children[(t.tabs.children.indexOf(t.leaf) + 1) % t.tabs.children.length] as WorkspaceLeaf, { focus: true }); return true; } });
  add({ id: "workspace:previous-tab", name: "Go to previous tab", hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "Tab" }], checkCallback: (c) => { const t = mainTabs(); if (!t || t.tabs.children.length < 2) return false; if (!c) { const n = t.tabs.children.length; ws.setActiveLeaf(t.tabs.children[(t.tabs.children.indexOf(t.leaf) + n - 1) % n] as WorkspaceLeaf, { focus: true }); } return true; } });
  add({ id: "workspace:split-vertical", name: "Split right", checkCallback: (c) => { const l = rootLeaf(); if (!l) return false; if (!c) void ws.duplicateLeaf(l, "split", "vertical"); return true; } });
  add({ id: "workspace:split-horizontal", name: "Split down", checkCallback: (c) => { const l = rootLeaf(); if (!l) return false; if (!c) void ws.duplicateLeaf(l, "split", "horizontal"); return true; } });
  // ---- popout windows (ids and names as in Obsidian)
  add({ id: "workspace:new-window", name: "New window", callback: () => { ws.openPopoutLeaf(); } });
  add({ id: "workspace:open-in-new-window", name: "Open current tab in new window", checkCallback: (c) => { const l = ws.activeLeaf; if (!l) return false; if (!c) void ws.duplicateLeaf(l, "window"); return true; } });
  add({ id: "workspace:move-to-new-window", name: "Move current tab to new window", checkCallback: (c) => { const l = ws.activeLeaf; if (!l) return false; if (!c) { try { ws.moveLeafToPopout(l); } catch (e) { console.error(e); new Notice("Unable to open a new window."); } } return true; } });
  add({ id: "workspace:close-window", name: "Close window", checkCallback: (c) => { const w = ws.activeLeaf?.getContainer(); if (!(w instanceof WorkspaceWindow)) return false; if (!c) w.close(); return true; } });
  add({ id: "workspace:toggle-pin", name: "Pin/unpin tab", checkCallback: (c) => { const l = ws.activeLeaf; if (!l) return false; if (!c) l.togglePinned(); return true; } });
  add({ id: "workspace:undo-close-pane", name: "Undo close tab", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "t" }], checkCallback: (c) => {
    if (!ws.closedLeaves.length) return false;
    if (!c) void ws.undoCloseLeaf();
    return true;
  } });
  add({ id: "workspace:close-tab-group", name: "Close tab group", checkCallback: (c) => {
    const t = mainTabs();
    if (!t) return false;
    if (!c) for (const l of [...t.tabs.children] as WorkspaceLeaf[]) if (!l.pinned) l.detach();
    return true;
  } });
  add({ id: "app:show-release-notes", name: "Show release notes", callback: () => openExternal("https://github.com/alonsoburon/tachylite/releases", app) });
  add({ id: "file-explorer:move-file", name: "Move current file to another folder", checkCallback: (c) => {
    const f = ws.getActiveFile();
    if (!f) return false;
    if (!c) new FolderPicker(app, f).open();
    return true;
  } });
  // Focus the nearest tab group (main area or sidebars) in a direction, judged by where the groups are on screen.
  type Dir = "left" | "right" | "top" | "bottom";
  const focusGroup = (dir: Dir) => (checking: boolean) => {
    const from = mainTabs()?.tabs ?? (ws.activeLeaf?.parent instanceof WorkspaceTabs ? ws.activeLeaf.parent : null);
    if (!from) return false;
    const a = from.containerEl.getBoundingClientRect();
    const horizontal = dir === "left" || dir === "right";
    let best: WorkspaceTabs | null = null, bestScore = Infinity;
    const seen = new Set<WorkspaceTabs>();
    ws.iterateAllLeaves((l) => {
      const t = l.parent;
      if (!(t instanceof WorkspaceTabs) || t === from || seen.has(t)) return;
      seen.add(t);
      const r = t.containerEl.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      // The candidate must lie on that side and share some of the other axis with the current group.
      const gap = dir === "left" ? a.left - r.right : dir === "right" ? r.left - a.right : dir === "top" ? a.top - r.bottom : r.top - a.bottom;
      const overlap = horizontal ? Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top) : Math.min(a.right, r.right) - Math.max(a.left, r.left);
      if (gap < -1 || overlap <= 0) return;
      const score = Math.max(gap, 0) * 10000 - overlap; // nearest first, the better-aligned one on a tie
      if (score < bestScore) { best = t; bestScore = score; }
    });
    const target = best as WorkspaceTabs | null;
    if (!target) return false;
    if (!checking) { const l = (target.children[target.currentTab] ?? target.children[0]) as WorkspaceLeaf; ws.setActiveLeaf(l, { focus: true }); }
    return true;
  };
  const FOCUS_NAMES: Record<Dir, string> = { left: "to the left", right: "to the right", top: "above", bottom: "below" };
  for (const dir of ["left", "right", "top", "bottom"] as Dir[]) {
    add({ id: `workspace:focus-${dir}`, name: `Focus on tab group ${FOCUS_NAMES[dir]}`, checkCallback: focusGroup(dir) });
  }
  add({ id: "workspace:close-others", name: "Close other tabs", checkCallback: (c) => { const t = mainTabs(); if (!t) return false; if (!c) for (const l of [...t.tabs.children] as WorkspaceLeaf[]) if (l !== t.leaf && !l.pinned) l.detach(); return true; } });

  // ---- markdown view modes
  add({ id: "markdown:toggle-preview", name: "Toggle reading view", hotkeys: mod("e"), checkCallback: (c) => { const v = active(); if (!v) return false; if (!c) v.toggleReading(); return true; } });
  add({ id: "editor:toggle-source", name: "Toggle Live Preview/Source mode", checkCallback: (c) => { const v = active(); if (!v || v.getMode() === "preview") return false; if (!c) v.toggleSource(); return true; } });
  add({ id: "editor:focus", name: "Focus on last note", checkCallback: (c) => { const l = ws.getMostRecentLeaf(); if (!l) return false; if (!c) ws.setActiveLeaf(l, { focus: true }); return true; } });

  // ---- editor formatting (hotkeys come from the editor's own keymap)
  const ed = (id: string, name: string, run: (v: EditorView) => boolean, hotkeys?: Hotkey[]) => add({ id, name, hotkeys, editorCallback: (e) => { run(cm(e as any)); } });
  ed("editor:toggle-bold", "Toggle bold", toggleBold);
  ed("editor:toggle-italics", "Toggle italics", toggleItalic);
  ed("editor:toggle-strikethrough", "Toggle strikethrough", toggleStrikethrough);
  ed("editor:toggle-highlight", "Toggle highlight", toggleHighlight);
  ed("editor:toggle-code", "Toggle code", toggleInlineCode);
  ed("editor:insert-link", "Insert Markdown link", insertLink);
  ed("editor:toggle-checklist-status", "Toggle checkbox status", toggleChecklist);
  ed("editor:indent-list", "Indent list item", indentListMore);
  ed("editor:unindent-list", "Unindent list item", indentListLess);
  ed("editor:fold-all", "Fold all headings and lists", foldAll);
  ed("editor:unfold-all", "Unfold all headings and lists", unfoldAll);
  ed("editor:toggle-fold", "Toggle fold on the current line", toggleFold);
  ed("editor:toggle-bullet-list", "Toggle bullet list", toggleBulletList);
  ed("editor:toggle-numbered-list", "Toggle numbered list", toggleNumberedList);
  ed("editor:toggle-blockquote", "Toggle blockquote", toggleBlockquote);
  ed("editor:set-heading-0", "Remove heading", setHeading(0));
  for (let n = 1; n <= 6; n++) ed(`editor:set-heading-${n}`, `Toggle heading ${n}`, setHeading(n));
  ed("editor:insert-wikilink", "Add internal link", insertWikilink);
  ed("editor:insert-embed", "Add embed", insertEmbed);
  ed("editor:insert-tag", "Add tag", insertTag);
  ed("editor:insert-callout", "Insert callout", insertCallout);
  ed("editor:insert-codeblock", "Insert code block", insertCodeBlock);
  ed("editor:insert-horizontal-rule", "Insert horizontal rule", insertHorizontalRule);
  ed("editor:insert-table", "Insert table", insertTable);
  ed("editor:insert-mathblock", "Insert math block", insertMathBlock);
  ed("editor:delete-paragraph", "Delete paragraph", deleteParagraph);
  ed("editor:clear-formatting", "Clear formatting", clearFormatting);
  ed("editor:insert-footnote", "Insert footnote", insertFootnote);
  ed("editor:swap-line-up", "Move line up", moveLineUp);
  ed("editor:swap-line-down", "Move line down", moveLineDown);
  add({
    id: "editor:follow-link", name: "Follow link under cursor", hotkeys: [{ modifiers: ["Alt"], key: "Enter" }],
    editorCheckCallback: (checking, editor, ctx) => {
      const cur = editor.getCursor();
      const link = linkAt(editor.getLine(cur.line), cur.ch);
      if (!link) return false;
      if (!checking) {
        if (link.external) openExternal(link.target, app);
        else void app.workspace.openLinkText(link.kind === "markdown" ? safeDecode(link.target) : link.target, ctx?.file?.path ?? "", false);
      }
      return true;
    },
  });
  // The link under the cursor, opened somewhere other than this tab.
  const openLinkIn = (id: string, name: string, where: "tab" | "split" | "window") => add({
    id, name, editorCheckCallback: (checking, editor, ctx) => {
      const cur = editor.getCursor();
      const link = linkAt(editor.getLine(cur.line), cur.ch);
      if (!link) return false;
      if (!checking) {
        if (link.external) openExternal(link.target, app);
        else void app.workspace.openLinkText(link.kind === "markdown" ? safeDecode(link.target) : link.target, ctx?.file?.path ?? "", where);
      }
      return true;
    },
  });
  openLinkIn("editor:open-link-in-new-leaf", "Open link under cursor in new tab", "tab");
  openLinkIn("editor:open-link-in-new-split", "Open link under cursor to the right", "split");
  openLinkIn("editor:open-link-in-new-window", "Open link under cursor in new window", "window");
  ed("editor:open-search", "Search current file", openSearchPanel, mod("f"));
  ed("editor:open-search-replace", "Search and replace in current file", openSearchPanel, mod("h"));

  // Jump to the Nth tab of the current tab group (Ctrl/Cmd+1..8) or the last one (Ctrl/Cmd+9).
  const tabsHere = () => { const l = ws.activeLeaf; return l && l.parent instanceof WorkspaceTabs ? l.parent : null; };
  for (let n = 1; n <= 8; n++) {
    add({ id: `workspace:goto-tab-${n}`, name: `Go to tab #${n}`, hotkeys: mod(String(n)), checkCallback: (c) => {
      const t = tabsHere()?.children[n - 1] as WorkspaceLeaf | undefined;
      if (!t) return false;
      if (!c) ws.setActiveLeaf(t, { focus: true });
      return true;
    } });
  }
  add({ id: "workspace:goto-last-tab", name: "Go to last tab", hotkeys: mod("9"), checkCallback: (c) => {
    const kids = tabsHere()?.children;
    if (!kids?.length) return false;
    if (!c) ws.setActiveLeaf(kids[kids.length - 1] as WorkspaceLeaf, { focus: true });
    return true;
  } });

  const disposers: (() => void)[] = [
    // core plugins whose commands live here
    whileCoreEnabled(app, "switcher", () => {
      const el = ws.leftRibbon.addRibbonItemButton("switcher", "lucide-navigation", "Open quick switcher", () => { app.commands.executeCommandById("switcher:open"); });
      return () => ws.leftRibbon.removeRibbonItemButton(el);
    }),
    whileCoreEnabled(app, "command-palette", () => {
      const el = ws.leftRibbon.addRibbonItemButton("command-palette", "lucide-terminal", "Open command palette", () => { app.commands.executeCommandById("command-palette:open"); });
      return () => ws.leftRibbon.removeRibbonItemButton(el);
    }),
    whileCoreEnabled(app, "file-explorer", () => {
      const el = ws.leftRibbon.addRibbonItemButton("new-note", "lucide-square-pen", "Create new note", () => { app.commands.executeCommandById("file-explorer:new-file"); });
      return () => ws.leftRibbon.removeRibbonItemButton(el);
    }),
  ];
  void coreEnabled;
  return () => { for (const id of cmdIds) app.commands.removeCommand(id); for (const d of disposers) d(); };
}
