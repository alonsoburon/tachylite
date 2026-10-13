// Core commands (ids follow Obsidian's public command ids) and their default hotkeys.
import { FileView, MarkdownView, Notice, WorkspaceTabs, WorkspaceWindow, type App, type Command, type Hotkey, type WorkspaceLeaf } from "../obsidian";
import {
  indentListLess, indentListMore, insertLink, toggleBold, toggleChecklist, toggleHighlight, toggleInlineCode, toggleItalic, toggleStrikethrough,
} from "../editor";
import { foldAll, toggleFold, unfoldAll } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { copyText, deleteWithPrompt, newNote, promptRename, revealInExplorer } from "./files";
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
  add({ id: "app:open-settings", name: "Open settings", hotkeys: mod(","), callback: () => app.setting.open() });
  add({ id: "app:go-back", name: "Navigate back", hotkeys: [{ modifiers: ["Alt"], key: "ArrowLeft" }], checkCallback: (c) => { if (!history.canGo(-1)) return false; if (!c) void history.go(-1); return true; } });
  add({ id: "app:go-forward", name: "Navigate forward", hotkeys: [{ modifiers: ["Alt"], key: "ArrowRight" }], checkCallback: (c) => { if (!history.canGo(1)) return false; if (!c) void history.go(1); return true; } });
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
  add({ id: "workspace:close-others", name: "Close other tabs", checkCallback: (c) => { const t = mainTabs(); if (!t) return false; if (!c) for (const l of [...t.tabs.children] as WorkspaceLeaf[]) if (l !== t.leaf && !l.pinned) l.detach(); return true; } });

  // ---- markdown view modes
  add({ id: "markdown:toggle-preview", name: "Toggle reading view", hotkeys: mod("e"), checkCallback: (c) => { const v = active(); if (!v) return false; if (!c) v.toggleReading(); return true; } });
  add({ id: "editor:toggle-source", name: "Toggle Live Preview/Source mode", checkCallback: (c) => { const v = active(); if (!v || v.getMode() === "preview") return false; if (!c) v.toggleSource(); return true; } });
  add({ id: "editor:focus", name: "Focus on last note", checkCallback: (c) => { const l = ws.getMostRecentLeaf(); if (!l) return false; if (!c) ws.setActiveLeaf(l, { focus: true }); return true; } });

  // ---- editor formatting (hotkeys come from the editor's own keymap)
  const ed = (id: string, name: string, run: (v: EditorView) => boolean) => add({ id, name, editorCallback: (e) => { run(cm(e as any)); } });
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
