// Page preview core plugin: hover-link emission from our surfaces, the Mod-key rules of page-preview.json,
// HoverPopover lifetime (hover persistence, nesting), the settings tab and the API Hover Editor-style plugins use.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { bootCore, tick, type Core } from "./helpers/core";
import { readJson, row, clickToggle, show } from "./helpers/settings";
import { HoverPopover, MarkdownView, PopoverState, Plugin } from "../src/obsidian";
import { PagePreviewPlugin, findHoverTarget } from "../src/app/core/pagePreview";
import { installBridge } from "../src/app/bridge";

let c: Core;
let unbridge: () => void;
const files = {
  "Home.md": "# Home\nSee [[Target]] and [[Target#Second|the second part]] and [[Missing]].\n",
  "Target.md": "---\ntags: [x]\n---\n# First\nfirst body links to [[Deep]]\n# Second\nsecond body\n",
  "Deep.md": "deep note text\n",
};

beforeEach(async () => {
  c = await bootCore(files);
  unbridge = installBridge(c.app);
});
afterEach(async () => { for (const p of HoverPopover.getActive()) p.hide(); unbridge(); await c.dispose(); });

const plugin = () => c.app.internalPlugins.getPluginById("page-preview")!.instance as unknown as PagePreviewPlugin;
function over(el: Element, init: MouseEventInit = {}, from: Element | null = null): void {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: from, ...init }));
}
function out(el: Element, to: Element | null = null): void {
  el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: to }));
}
async function openReading(path: string): Promise<MarkdownView> {
  const leaf = c.app.workspace.getLeaf("tab");
  await leaf.openFile(c.app.vault.getFileByPath(path)!, { active: true });
  const v = leaf.view as MarkdownView;
  v.setMode("preview");
  await v.previewMode.whenRendered();
  return v;
}
const shown = () => HoverPopover.getActive().filter((p) => p.state === PopoverState.Shown);
const waitShown = (n = 1) => vi.waitFor(() => expect(shown()).toHaveLength(n), { timeout: 2000 });
const waitRendered = (p: HoverPopover, text: string) => vi.waitFor(() => expect(p.hoverEl.textContent).toContain(text), { timeout: 2000 });

describe("page preview", () => {
  it("replaces the core plugin instance with a patchable class and registers the built-in sources", () => {
    expect(plugin()).toBeInstanceOf(PagePreviewPlugin);
    expect(typeof (plugin().constructor.prototype as any).onLinkHover).toBe("function");
    expect(c.app.workspace.hoverLinkSources.preview.defaultMod).toBe(false);
    expect(c.app.workspace.hoverLinkSources.editor.defaultMod).toBe(true);
  });

  it("previews a reading-view link without Mod, renders the note, keeps it while hovered and closes after leaving", async () => {
    const v = await openReading("Home.md");
    const a = v.previewEl.querySelector<HTMLElement>('a.internal-link[data-href="Target"]')!;
    expect(findHoverTarget(c.app, a)).toMatchObject({ source: "preview", linktext: "Target", sourcePath: "Home.md" });
    over(a);
    await waitShown();
    const pop = shown()[0];
    expect(pop.hoverEl.classList.contains("hover-popover")).toBe(true);
    expect(pop.hoverEl.isConnected).toBe(true);
    expect(pop.targetEl).toBe(a);
    expect(v.hoverPopover).toBe(pop); // the view is the HoverParent
    await waitRendered(pop, "first body");
    expect(pop.hoverEl.querySelector(".markdown-embed .markdown-preview-view h1")?.textContent).toBe("First");
    // moving from the link onto the popover keeps it
    out(a, pop.hoverEl); over(pop.hoverEl, {}, a);
    await tick(450);
    expect(pop.state).toBe(PopoverState.Shown);
    // leaving the popover closes it after the grace delay
    out(pop.hoverEl, document.body);
    await vi.waitFor(() => expect(pop.state).toBe(PopoverState.Hidden), { timeout: 2000 });
    expect(pop.hoverEl.isConnected).toBe(false);
    expect(v.hoverPopover).toBeNull();
  });

  it("previews only the heading section of a subpath and nothing for unresolved links", async () => {
    const v = await openReading("Home.md");
    const sub = v.previewEl.querySelector<HTMLElement>('a.internal-link[data-href="Target#Second"]')!;
    over(sub);
    await waitShown();
    await waitRendered(shown()[0], "second body");
    expect(shown()[0].hoverEl.textContent).not.toContain("first body");
    shown()[0].hide();
    over(v.previewEl.querySelector<HTMLElement>('a.internal-link[data-href="Missing"]')!);
    await tick(400);
    expect(HoverPopover.getActive()).toHaveLength(0);
  });

  it("a link leaving before the delay never shows", async () => {
    const v = await openReading("Home.md");
    const a = v.previewEl.querySelector<HTMLElement>('a.internal-link[data-href="Target"]')!;
    over(a);
    await tick(50);
    out(a, document.body);
    await tick(400);
    expect(HoverPopover.getActive()).toHaveLength(0);
  });

  it("nests popovers: the outer one stays open while the inner one is hovered", async () => {
    const v = await openReading("Home.md");
    const a = v.previewEl.querySelector<HTMLElement>('a.internal-link[data-href="Target"]')!;
    over(a);
    await waitShown();
    const outer = shown()[0];
    await waitRendered(outer, "first body");
    const inner = outer.hoverEl.querySelector<HTMLElement>('a.internal-link[data-href="Deep"]')!;
    expect(findHoverTarget(c.app, inner)).toMatchObject({ source: "preview", sourcePath: "Target.md" });
    out(a, outer.hoverEl); over(outer.hoverEl, {}, a);
    over(inner, {}, outer.hoverEl);
    await waitShown(2);
    const child = shown().find((p) => p !== outer)!;
    await waitRendered(child, "deep note text");
    // pointer goes from the outer popover into the inner one
    out(inner, child.hoverEl); out(outer.hoverEl, child.hoverEl); over(child.hoverEl, {}, inner);
    await tick(450);
    expect(outer.state).toBe(PopoverState.Shown);
    expect(child.state).toBe(PopoverState.Shown);
    // leaving everything closes both
    out(child.hoverEl, document.body);
    await vi.waitFor(() => expect(HoverPopover.getActive()).toHaveLength(0), { timeout: 2000 });
  });

  it("editor links need Mod by default: hovering then pressing Ctrl opens the preview", async () => {
    const leaf = c.app.workspace.getLeaf("tab");
    await leaf.openFile(c.app.vault.getFileByPath("Home.md")!, { active: true });
    const v = leaf.view as MarkdownView;
    v.editor.setCursor({ line: 0, ch: 0 });
    const link = await vi.waitFor(() => { const el = v.contentEl.querySelector<HTMLElement>('.cm-hmd-internal-link[data-href="Target"]'); if (!el) throw new Error("no link"); return el; });
    const hit = findHoverTarget(c.app, link)!;
    expect(hit).toMatchObject({ source: "editor", linktext: "Target", sourcePath: "Home.md" });
    expect(EditorView.findFromDOM(link.closest(".cm-editor") as HTMLElement)).toBeTruthy();
    over(link);
    await tick(400);
    expect(HoverPopover.getActive()).toHaveLength(0);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true, bubbles: true }));
    await waitShown();
    expect(shown()[0].targetEl).toBe(link);
    shown()[0].hide();
    // with Ctrl already held while entering the link it opens straight away
    out(link, document.body);
    over(link, { ctrlKey: true });
    await waitShown();
  });

  it("file explorer, tab headers and settings: page-preview.json switches the Mod requirement per source", async () => {
    await c.app.workspace.ensureSideLeaf("file-explorer", "left", { active: true });
    const nav = await vi.waitFor(() => { const el = document.querySelector<HTMLElement>('.nav-file-title[data-path="Deep.md"]'); if (!el) throw new Error("no explorer row"); return el; });
    expect(findHoverTarget(c.app, nav)).toMatchObject({ source: "file-explorer", linktext: "Deep.md" });
    over(nav);
    await tick(400);
    expect(HoverPopover.getActive()).toHaveLength(0);
    const tab = await show(c.app, "page-preview");
    const r = row(tab.containerEl, "Files");
    clickToggle(r); // turn "require Ctrl" off for the explorer
    await vi.waitFor(() => expect(readJson(c.v, ".obsidian/page-preview.json")).toMatchObject({ "file-explorer": false }));
    out(nav, document.body); over(nav);
    await waitShown();
    await waitRendered(shown()[0], "deep note text");
    shown()[0].hide();
    const leaf = c.app.workspace.getLeaf("tab");
    await leaf.openFile(c.app.vault.getFileByPath("Deep.md")!, { active: true });
    expect(findHoverTarget(c.app, leaf.tabHeaderEl)).toMatchObject({ source: "tab-header", linktext: "Deep.md", hoverParent: leaf });
  });

  it("plugins: registerHoverLinkSource shows in settings, custom hover-link events preview, onLinkHover can be patched", async () => {
    class P extends Plugin {}
    const p = new P(c.app, { id: "hov", name: "Hov", version: "1", minAppVersion: "0", author: "", description: "" } as any);
    p.load();
    p.registerHoverLinkSource("hov", { display: "Hov plugin", defaultMod: false });
    const tab = await show(c.app, "page-preview");
    expect(row(tab.containerEl, "Hov plugin")).toBeTruthy();
    const el = document.body.createDiv({ text: "custom" });
    const parent = { hoverPopover: null as HoverPopover | null };
    c.app.workspace.trigger("hover-link", { event: new MouseEvent("mouseover"), source: "hov", hoverParent: parent, targetEl: el, linktext: "Deep", sourcePath: "" });
    await waitShown();
    expect(parent.hoverPopover).toBe(shown()[0]);
    parent.hoverPopover!.hide();
    // Hover Editor style: patch the prototype, previews go through the patched method
    const proto = plugin().constructor.prototype as any;
    const orig = proto.onLinkHover;
    const seen: string[] = [];
    proto.onLinkHover = function (this: unknown, ...args: any[]) { seen.push(args[2]); return orig.apply(this, args); };
    try {
      c.app.workspace.trigger("hover-link", { event: new MouseEvent("mouseover"), source: "hov", hoverParent: parent, targetEl: el, linktext: "Target", sourcePath: "" });
      expect(seen).toEqual(["Target"]);
    } finally { proto.onLinkHover = orig; }
    p.unload();
    expect(c.app.workspace.hoverLinkSources.hov).toBeUndefined();
  });

  it("disabling the core plugin stops previews", async () => {
    await c.app.internalPlugins.getPluginById("page-preview")!.disable();
    const v = await openReading("Home.md");
    over(v.previewEl.querySelector<HTMLElement>('a.internal-link[data-href="Target"]')!);
    await tick(400);
    expect(HoverPopover.getActive()).toHaveLength(0);
  });
});
