// Export to PDF, backlinks in document, linked tabs (happy-dom; real printing and the real window are not covered).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault } from "./helpers/backend";
import { startSession } from "../src/app/session";

let s: Awaited<ReturnType<typeof startSession>>;
beforeEach(async () => {
  document.body.innerHTML = "";
  const v = makeVault({ "Note.md": "# Title\nbody text\n", "Other.md": "links to [[Note]]\n", "Third.md": "x\n" });
  setBackend(async (cmd, a) => { switch (cmd) { case "meta_tags": return {}; case "vault_search": return []; case "launch_args": return { vault: null, script: null }; case "log_frontend": return null; default: return v.backend(cmd, a); } });
  s = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
  await s.app.workspace.openLinkText("Note", "", false);
});
afterEach(async () => { await s.stop(); });

const titles = () => [...document.querySelectorAll(".menu-item-title")].map((e) => e.textContent);

describe("export to PDF", () => {
  it("shows the options modal and prints the reading view with the print class", async () => {
    const print = vi.fn(() => {
      expect(document.body.classList.contains("is-printing")).toBe(true);
      expect(document.querySelector(".print .markdown-preview-view")?.textContent).toContain("body text");
      expect(document.querySelector("style.tachylite-print-style")?.textContent).toContain("@page { size: A4 landscape;");
    });
    (window as any).print = print;
    expect(s.app.commands.executeCommandById("workspace:export-pdf")).toBe(true);
    const modal = document.querySelector(".modal-container.mod-confirmation")!;
    expect(modal.querySelector(".modal-title")?.textContent).toBe("Export to PDF");
    expect([...modal.querySelectorAll(".setting-item-name")].map((e) => e.textContent)).toEqual(["Include file name as title", "Page size", "Landscape", "Margin", "Downscale percent"]);
    const drop = modal.querySelectorAll<HTMLSelectElement>("select.dropdown");
    expect([...drop[0].options].map((o) => o.value)).toEqual(["A3", "A4", "A5", "Legal", "Letter", "Tabloid"]);
    expect(drop[0].value).toBe("Letter");
    drop[0].value = "A4"; drop[0].dispatchEvent(new Event("change"));
    const toggles = modal.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    toggles[1].click();
    modal.querySelector<HTMLButtonElement>("button.mod-cta")!.click();
    expect(s.app.vault.getConfig("pdfExportSettings")).toMatchObject({ pageSize: "A4", landscape: true, margin: "0", downscalePercent: 100 });
    await vi.waitFor(() => expect(print).toHaveBeenCalled());
    await vi.waitFor(() => expect(document.querySelector(".print")).toBeNull());
    expect(document.body.classList.contains("is-printing")).toBe(false);
    expect(document.querySelector(".modal-container")).toBeNull();
  });
  it("Cancel prints nothing and keeps the settings", () => {
    const print = vi.fn(); (window as any).print = print;
    s.app.commands.executeCommandById("workspace:export-pdf");
    document.querySelector<HTMLButtonElement>(".modal button.mod-cancel")!.click();
    expect(print).not.toHaveBeenCalled();
    expect(document.querySelector(".modal-container")).toBeNull();
  });
  it("is in the tab header and More options menus", () => {
    (s as any).shell.tabMenu(s.app.workspace.activeLeaf!, new MouseEvent("contextmenu"));
    expect(titles()).toContain("Export to PDF...");
    document.body.innerHTML = "";
    (s.app.workspace.activeLeaf!.view as any).showMoreMenu(new MouseEvent("click"));
    expect(titles()).toContain("Export to PDF...");
  });
});

describe("backlinks in document", () => {
  it("toggles the panel, saves it in the view state, in editing and reading view", async () => {
    const leaf = s.app.workspace.activeLeaf!;
    const view = leaf.view as any;
    expect(leaf.getViewState().state).not.toHaveProperty("backlinks");
    expect(s.app.commands.executeCommandById("backlink:toggle-backlinks-in-document")).toBe(true);
    expect(view.contentEl.querySelector(".cm-scroller > .embedded-backlinks")).not.toBeNull();
    const st: any = leaf.getViewState().state;
    expect(st.backlinks).toBe(true);
    expect(st.backlinkOpts).toMatchObject({ collapseAll: false, sortOrder: "alphabetical", unlinkedCollapsed: true });
    await vi.waitFor(() => expect(view.contentEl.querySelector(".embedded-backlinks")?.textContent).toContain("Linked mentions"));
    view.showMoreMenu(new MouseEvent("click"));
    expect(document.querySelector(".menu-item.is-checked .menu-item-title")?.textContent).toBe("Backlinks in document");
    document.body.innerHTML = "";
    s.app.commands.executeCommandById("markdown:toggle-preview");
    await vi.waitFor(() => expect(view.previewEl.querySelector(".markdown-preview-sizer > .mod-footer > .embedded-backlinks")).not.toBeNull());
    s.app.commands.executeCommandById("backlink:toggle-backlinks-in-document");
    expect(view.contentEl.querySelector(".embedded-backlinks")).toBeNull();
    expect(leaf.getViewState().state).toMatchObject({ backlinks: false });
    expect(leaf.getViewState().state).not.toHaveProperty("backlinkOpts");
  });
  it("is restored from the view state", async () => {
    const leaf = s.app.workspace.activeLeaf!;
    await leaf.setViewState({ type: "markdown", state: { file: "Note.md", mode: "source", backlinks: true, backlinkOpts: { showSearch: true } } });
    expect((leaf.view as any).contentEl.querySelector(".embedded-backlinks")).not.toBeNull();
    expect((leaf.getViewState().state as any).backlinkOpts.showSearch).toBe(true);
  });
  it("is in the tab header menu before Reading view", () => {
    (s as any).shell.tabMenu(s.app.workspace.activeLeaf!, new MouseEvent("contextmenu"));
    const t = titles();
    expect(t.indexOf("Backlinks in document")).toBe(t.indexOf("Reading view") - 1);
    expect(t.indexOf("Link with tab...")).toBe(t.indexOf("Backlinks in document") - 1);
  });
});

describe("linked tabs", () => {
  it("links with the clicked tab, shows the unlink icon, unlinks", async () => {
    const ws = s.app.workspace;
    const a = ws.activeLeaf!;
    const b = ws.getLeaf("tab"); await b.openFile(s.app.vault.getFileByPath("Third.md")!);
    ws.setActiveLeaf(a);
    (s as any).shell.tabMenu(a, new MouseEvent("contextmenu"));
    [...document.querySelectorAll<HTMLElement>(".menu-item")].find((e) => e.textContent === "Link with tab...")!.click();
    expect(document.querySelector(".suggestion-bg")).not.toBeNull();
    b.tabHeaderEl.click();
    expect(document.querySelector(".suggestion-bg")).toBeNull();
    expect(a.group).toBeTruthy();
    expect(a.group).toBe(b.group);
    expect(a.getViewState()).toHaveProperty("group", a.group);
    expect(a.tabHeaderEl.querySelector(".workspace-tab-header-status-icon.mod-linked")?.getAttribute("aria-label")).toBe("Unlink tab");
    document.body.innerHTML = "";
    (s as any).shell.tabMenu(a, new MouseEvent("contextmenu"));
    expect(titles()).toContain("Unlink tab");
    expect(titles()).not.toContain("Link with tab...");
    a.tabHeaderEl.querySelector<HTMLElement>(".mod-linked")!.click();
    expect(a.group).toBeNull();
    expect(b.group).toBeNull();
    expect(b.tabHeaderEl.querySelector(".mod-linked")).toBeNull();
  });
  it("Escape cancels linking", () => {
    const a = s.app.workspace.activeLeaf!;
    (s as any).shell.tabMenu(a, new MouseEvent("contextmenu"));
    [...document.querySelectorAll<HTMLElement>(".menu-item")].find((e) => e.textContent === "Link with tab...")!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".suggestion-bg")).toBeNull();
    expect(a.group).toBeNull();
  });
  it("Open linked view lists the views and opens one linked to the note, following it", async () => {
    const ws = s.app.workspace;
    const a = ws.activeLeaf!;
    (s as any).shell.tabMenu(a, new MouseEvent("contextmenu"));
    const item = [...document.querySelectorAll<HTMLElement>(".menu-item")].find((e) => e.textContent === "Open linked view")!;
    expect(item).toBeTruthy();
    const { openLinkedView, LINKED_VIEWS } = await import("../src/app/linked/linkedTabs");
    expect(LINKED_VIEWS.map((v) => v.title)).toEqual(["Open local graph", "Open backlinks", "Open outgoing links", "Open file properties", "Open outline"]);
    const bl = await openLinkedView(s.app, a, "backlink");
    expect(bl.group).toBe(a.group);
    expect(a.group).toBeTruthy();
    await vi.waitFor(() => expect((bl.view as any).file?.path).toBe("Note.md"));
    // Activating the backlinks tab must not change what it shows: it follows its linked note.
    ws.setActiveLeaf(bl);
    expect((bl.view as any).followedFile()?.path).toBe("Note.md");
  });
});
