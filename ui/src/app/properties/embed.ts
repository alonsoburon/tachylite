// The Properties table inside notes (Live Preview widget and reading view), wired through the editor host / render context.
import { TFile, type App } from "../../obsidian";
import { liveEditors, mountMetadataEditor, takeNewRowRequest, type MetadataEditor } from "./metadataEditor";

export type PropertiesMode = "visible" | "hidden" | "source";
export function propertiesMode(app: App): PropertiesMode {
  const v = app.vault.getConfig("propertiesInDocument");
  return v === "hidden" || v === "source" ? v : "visible";
}

export function renderPropertiesTable(app: App, el: HTMLElement, fm: Record<string, unknown>, sourcePath: string): { destroy(): void; component: MetadataEditor } | null {
  const file = app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile) || file.extension !== "md") return null;
  const ed = mountMetadataEditor(app, file, el, fm);
  if (takeNewRowRequest(file.path)) setTimeout(() => ed.addProperty(), 0);
  return { component: ed, destroy: () => ed.unload() };
}

/** The table shown inside `containerEl` (a markdown view's `metadataEditor`). */
export function metadataEditorIn(containerEl: HTMLElement): MetadataEditor | null {
  for (const ed of liveEditors) if (ed.containerEl.isConnected && containerEl.contains(ed.containerEl) && ed.containerEl.offsetParent !== null) return ed;
  for (const ed of liveEditors) if (ed.containerEl.isConnected && containerEl.contains(ed.containerEl)) return ed;
  return null;
}
