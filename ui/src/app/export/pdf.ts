// "Export to PDF...": an options modal (page size, landscape, margin, downscale; saved as `pdfExportSettings` in app.json),
// then the note's reading view is rendered into a print-only container and handed to window.print().
import { Component, MarkdownRenderer, MarkdownView, Modal, Setting, type App, type TFile } from "../../obsidian";

export interface PdfExportSettings { pageSize: string; landscape: boolean; margin: string; downscalePercent: number; includeName?: boolean }

export const PDF_PAGE_SIZES = ["A3", "A4", "A5", "Legal", "Letter", "Tabloid"] as const;
/** Margin values follow the print API: "0" default, "1" none, "2" minimal. */
export const PDF_MARGINS: Record<string, string> = { "0": "Default", "2": "Minimal", "1": "None" };
const PAGE_CSS: Record<string, string> = { A3: "A3", A4: "A4", A5: "A5", Legal: "legal", Letter: "letter", Tabloid: "11in 17in" };
const MARGIN_CSS: Record<string, string> = { "0": "15mm", "1": "0", "2": "5mm" };

export function getPdfSettings(app: App): PdfExportSettings {
  return { pageSize: "Letter", landscape: false, margin: "0", downscalePercent: 100, ...(app.vault.getConfig("pdfExportSettings") ?? {}) };
}

/** The @page rule and zoom for a settings object. */
export function printCss(s: PdfExportSettings): string {
  const size = `${PAGE_CSS[s.pageSize] ?? "letter"}${s.landscape ? " landscape" : ""}`;
  const zoom = Math.min(100, Math.max(10, Number(s.downscalePercent) || 100)) / 100;
  return `@page { size: ${size}; margin: ${MARGIN_CSS[s.margin] ?? MARGIN_CSS["0"]}; }\n.print .markdown-preview-view { zoom: ${zoom}; }`;
}

export class PdfExportModal extends Modal {
  constructor(app: App, private file: TFile, private onExport: (s: PdfExportSettings) => void) { super(app); }
  onOpen(): void {
    const s = getPdfSettings(this.app);
    this.containerEl.addClass("mod-confirmation");
    this.modalEl.addClass("mod-narrow");
    this.setTitle("Export to PDF");
    const c = this.contentEl;
    c.createEl("p", { cls: "u-muted u-break-word", text: `Export “${this.file.basename}” to PDF with the settings below.` });
    new Setting(c).setName("Include file name as title").addToggle((t) => t.setValue(!!s.includeName).onChange((v) => { s.includeName = v; }));
    new Setting(c).setName("Page size").addDropdown((d) => d.addOptions(Object.fromEntries(PDF_PAGE_SIZES.map((p) => [p, p]))).setValue(s.pageSize).onChange((v) => { s.pageSize = v; }));
    new Setting(c).setName("Landscape").addToggle((t) => t.setValue(s.landscape).onChange((v) => { s.landscape = v; }));
    new Setting(c).setName("Margin").addDropdown((d) => d.addOptions(PDF_MARGINS).setValue(String(s.margin)).onChange((v) => { s.margin = v; }));
    new Setting(c).setName("Downscale percent").addSlider((sl) => sl.setLimits(10, 100, 1).setValue(s.downscalePercent).setDynamicTooltip().onChange((v) => { s.downscalePercent = v; }));
    const bar = c.createDiv({ cls: "modal-button-container" });
    const ok = bar.createEl("button", { cls: "mod-cta", text: "Export to PDF" });
    ok.addEventListener("click", () => { this.close(); this.onExport(s); });
    bar.createEl("button", { cls: "mod-cancel", text: "Cancel" }).addEventListener("click", () => this.close());
  }
}

/** Render `file` as a reading view inside `body > .print` and print it; resolves once the print dialog returned. */
export async function printFile(app: App, file: TFile, s: PdfExportSettings): Promise<void> {
  const doc = document;
  const host = doc.body.createDiv({ cls: "print" });
  const style = doc.head.createEl("style", { cls: "tachylite-print-style", text: printCss(s) });
  const comp = new Component();
  comp.load();
  const view = host.createDiv({ cls: "markdown-preview-view markdown-rendered" });
  const sizer = view.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
  if (s.includeName) sizer.createEl("h1", { cls: "inline-title", text: file.basename });
  try {
    await MarkdownRenderer.render(app, await app.vault.cachedRead(file), sizer, file.path, comp);
    doc.body.addClass("is-printing");
    await new Promise<void>((resolve) => {
      const done = () => { window.removeEventListener("afterprint", done); resolve(); };
      window.addEventListener("afterprint", done);
      window.print();
      // window.print() blocks in most engines; if it returned without afterprint (headless), do not hang.
      setTimeout(done, 0);
    });
  } finally {
    doc.body.removeClass("is-printing");
    comp.unload();
    host.detach();
    style.detach();
  }
}

export function exportToPdf(app: App, view: MarkdownView | null = app.workspace.getActiveViewOfType(MarkdownView)): void {
  const file = view?.file;
  if (!file) return;
  new PdfExportModal(app, file, (s) => {
    app.vault.setConfig("pdfExportSettings", s);
    void printFile(app, file, s).catch((e) => console.error("export to PDF failed", e));
  }).open();
}

export function installPdfExport(app: App): () => void {
  const cmd = { id: "workspace:export-pdf", name: "Export to PDF...", checkCallback: (checking: boolean) => {
    const v = app.workspace.getActiveViewOfType(MarkdownView);
    if (!v?.file) return false;
    if (!checking) exportToPdf(app, v);
    return true;
  } };
  app.commands.addCommand(cmd);
  return () => app.commands.removeCommand(cmd.id);
}
