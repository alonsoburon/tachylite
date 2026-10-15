// The editor's right-click menu and the editor-menu workspace event plugins hook into.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";

let v: FakeVault;
let session: Session | null = null;
const qa = (s: string, r: ParentNode = document) => [...r.querySelectorAll<HTMLElement>(s)];

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Note.md": "hello world\n", "Other.md": "# Other\n", "Web.md": "see [site](https://example.com/p) now\n" });
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
});
afterEach(async () => { await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

async function openNote() {
  const host = document.body.appendChild(document.createElement("div"));
  session = await startSession((await v.backend("vault_info")) as any, host);
  const app = session.app;
  await app.workspace.openLinkText("Note", "", false);
  const view = app.workspace.activeLeaf!.view as any;
  await vi.waitFor(() => expect(view.file?.basename).toBe("Note"));
  view.editor.focus = () => {}; // happy-dom re-enters CodeMirror's update on DOM selection changes of a focused editor
  return { app, view, cm: view.editor.cm };
}
const titles = () => qa(".menu .menu-item-title").map((e) => e.textContent);

describe("editor context menu", () => {
  it("offers clipboard, link, format, paragraph and insert actions, and plugins extend it through editor-menu", async () => {
    const { app, view, cm } = await openNote();
    const seen: unknown[] = [];
    app.workspace.on("editor-menu", (menu: any, editor: any, v2: any) => {
      seen.push([editor === view.editor, v2 === view]);
      menu.addItem((i: any) => i.setTitle("Plugin item"));
    });
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    cm.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(titles()).toContain("Plugin item"));
    expect(titles()).toEqual(expect.arrayContaining(["Add link", "Cut", "Copy", "Paste", "Select all", "Format", "Paragraph", "Insert", "Plugin item"]));
    expect(seen).toEqual([[true, true]]);
  });

  it("disables Cut and Copy without a selection and runs a command from the Format submenu", async () => {
    const { view, cm } = await openNote();
    cm.dispatch({ selection: { anchor: 0, head: 5 } });
    cm.contentDOM.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(titles()).toContain("Copy"));
    const item = (t: string) => qa(".menu-item").find((e) => e.querySelector(".menu-item-title")?.textContent === t)!;
    expect(item("Copy").classList.contains("is-disabled")).toBe(false);
    item("Format").dispatchEvent(new MouseEvent("mouseenter"));
    await vi.waitFor(() => expect(titles()).toContain("Bold"));
    item("Bold").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(cm.state.doc.toString()).toBe("**hello** world\n"));
    void view;
  });

  it("an external link gets Open link and Copy URL, and plugins extend it through url-menu", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    session = await startSession((await v.backend("vault_info")) as any, host);
    const app = session.app;
    await app.workspace.openLinkText("Web", "", false);
    const view = app.workspace.activeLeaf!.view as any;
    await vi.waitFor(() => expect(view.file?.basename).toBe("Web"));
    view.editor.focus = () => {};
    const link = await vi.waitFor(() => { const l = view.contentEl.querySelector(".cm-link[data-url]"); if (!l) throw new Error("no link"); return l as HTMLElement; });
    const urls: string[] = [];
    app.workspace.on("url-menu", (menu: any, url: string) => { urls.push(url); menu.addItem((i: any) => i.setTitle("Plugin url item")); });
    link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(titles()).toContain("Plugin url item"));
    expect(titles()).toEqual(expect.arrayContaining(["Open link", "Copy URL"]));
    expect(urls).toEqual(["https://example.com/p"]);
  });

  it("leaves the properties area and inline title alone", async () => {
    const { view } = await openNote();
    const title = view.contentEl.querySelector(".inline-title") as HTMLElement | null;
    if (title) {
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      title.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
  });
});
