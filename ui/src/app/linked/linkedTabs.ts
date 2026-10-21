// Linked tabs: tabs that share a leaf `group`. "Link with tab..." dims the workspace and links with the next tab you click;
// "Unlink tab" (menu entry or the link icon in the tab header) leaves the group. Views that follow a note (backlinks,
// outgoing links, outline, file properties) show the note of their linked group instead of the active one.
// "Open linked view" opens one of those views in a new tab linked to this one.
import { setIcon, type App, type Menu, type WorkspaceLeaf } from "../../obsidian";
import { FILE_PROPERTIES_VIEW } from "../properties";
import { LOCAL_GRAPH_VIEW } from "../core/graph/view";
import { BACKLINK_VIEW, OUTGOING_VIEW } from "../core/links";
import { OUTLINE_VIEW } from "../core/outline";

export const LINKED_VIEWS: { title: string; icon: string; type: string }[] = [
  { title: "Open local graph", icon: "lucide-git-fork", type: LOCAL_GRAPH_VIEW },
  { title: "Open backlinks", icon: "lucide-links-coming-in", type: BACKLINK_VIEW },
  { title: "Open outgoing links", icon: "lucide-links-going-out", type: OUTGOING_VIEW },
  { title: "Open file properties", icon: "lucide-info", type: FILE_PROPERTIES_VIEW },
  { title: "Open outline", icon: "lucide-list", type: OUTLINE_VIEW },
];

/** Take `leaf` out of its group; a group left with one tab dissolves. */
export function unlinkLeaf(app: App, leaf: WorkspaceLeaf): void {
  const g = leaf.group;
  if (!g) return;
  leaf.setGroup(null);
  const rest = app.workspace.getGroupLeaves(g);
  if (rest.length === 1) rest[0].setGroup(null);
}

/** Wait for a click on another tab (header or content) and link `leaf` with it. Escape or a click elsewhere cancels. */
export function startLinkPicking(app: App, leaf: WorkspaceLeaf): () => void {
  const doc = document;
  const bg = doc.body.createDiv({ cls: "suggestion-bg tachylite-link-picking" });
  const pick = (t: EventTarget | null): WorkspaceLeaf | null => {
    const el = t as Node | null;
    return el ? app.workspace.allLeaves().find((l) => l !== leaf && (l.tabHeaderEl.contains(el) || l.containerEl.contains(el))) ?? null : null;
  };
  const stop = () => {
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("mousedown", swallow, true);
    doc.removeEventListener("keydown", onKey, true);
    bg.detach();
  };
  const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  const onClick = (e: MouseEvent) => {
    swallow(e);
    const other = pick(e.target);
    stop();
    if (other) leaf.setGroupMember(other);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { swallow(e); stop(); } };
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("mousedown", swallow, true);
  doc.addEventListener("keydown", onKey, true);
  return stop;
}

/** "Link with tab..." / "Unlink tab" for the tab header menu. */
export function addLinkMenuItem(menu: Menu, app: App, leaf: WorkspaceLeaf): void {
  if (leaf.group) menu.addItem((i) => i.setSection("pane").setTitle("Unlink tab").setIcon("lucide-unlink").onClick(() => unlinkLeaf(app, leaf)));
  else menu.addItem((i) => i.setSection("pane").setTitle("Link with tab...").setIcon("lucide-link").onClick(() => { startLinkPicking(app, leaf); }));
}

/** "Open linked view" with its submenu, for the file menus of a note's tab header and More options. */
export function addLinkedViewItem(menu: Menu, app: App, leaf: WorkspaceLeaf | null): void {
  if (!leaf) return;
  menu.addItem((i) => {
    i.setSection("info").setTitle("Open linked view").setIcon("lucide-link");
    const sub = i.setSubmenu();
    for (const v of LINKED_VIEWS) {
      if (!app.viewRegistry.getViewCreatorByType(v.type)) continue;
      sub.addItem((j) => j.setTitle(v.title).setIcon(v.icon).onClick(() => { void openLinkedView(app, leaf, v.type); }));
    }
  });
}

export async function openLinkedView(app: App, source: WorkspaceLeaf, type: string): Promise<WorkspaceLeaf> {
  const file = (source.view as { file?: { path: string } }).file;
  const leaf = app.workspace.getLeaf("tab");
  await leaf.setViewState({ type, active: true, ...(type === LOCAL_GRAPH_VIEW ? { state: { file: file?.path ?? null } } : {}) });
  source.setGroupMember(leaf);
  app.workspace.setActiveLeaf(leaf, { focus: true });
  return leaf;
}

/** Keep the "Unlink tab" icon in the tab headers of linked tabs in step with `leaf.group`. */
export function installLinkedTabs(app: App): () => void {
  const sync = () => {
    for (const l of app.workspace.allLeaves()) {
      const box = l.tabHeaderEl.querySelector<HTMLElement>(".workspace-tab-header-status-container");
      if (!box) continue;
      let icon = box.querySelector<HTMLElement>(".workspace-tab-header-status-icon.mod-linked");
      if (l.group && !icon) {
        icon = box.createDiv({ cls: "workspace-tab-header-status-icon mod-linked", attr: { "aria-label": "Unlink tab" } });
        setIcon(icon, "lucide-link");
        icon.addEventListener("click", (e) => { e.stopPropagation(); unlinkLeaf(app, l); });
      } else if (!l.group && icon) icon.detach();
    }
  };
  const ref = app.workspace.on("layout-change", sync);
  sync();
  return () => { app.workspace.offref(ref); };
}
