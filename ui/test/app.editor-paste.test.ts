// Pasting and dropping files into the editor: attachments, links in the vault's style, and the editor-paste / editor-drop events.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Notes/Note.md": "before after\n" });
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
const withData = <T extends Event>(ev: T, key: "clipboardData" | "dataTransfer", files: File[]): T => {
  Object.defineProperty(ev, key, { value: { files, items: [], types: ["Files"], getData: () => "" } });
  return ev;
};
const file = (name: string, type: string, body = "x") => new File([body], name, { type });
const read = (rel: string) => fs.readFileSync(path.join(v.root, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(v.root, rel));

describe("paste and drop into the editor", () => {
  it("saves a pasted clipboard image as a timestamped attachment and embeds it at the cursor", async () => {
    const { cm } = await openNote();
    cm.dispatch({ selection: { anchor: 6 } });
    const ev = withData(new Event("paste", { bubbles: true, cancelable: true }), "clipboardData", [file("image.png", "image/png", "PNGDATA")]);
    cm.contentDOM.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(cm.state.doc.toString()).toMatch(/^before!\[\[Pasted image \d{14}\.png\]\] after\n$/));
    const name = /Pasted image \d{14}\.png/.exec(cm.state.doc.toString())![0];
    expect(read(name)).toBe("PNGDATA");
  });

  it("keeps a dropped file's own name, avoids clobbering, and links non-embeddable files without an embed", async () => {
    const { cm } = await openNote();
    for (const f of [file("doc.pdf", "application/pdf", "A"), file("doc.pdf", "application/pdf", "B"), file("data.zip", "application/zip", "Z")]) {
      cm.contentDOM.dispatchEvent(withData(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { clientX: 0, clientY: 0 }), "dataTransfer", [f]));
      await vi.waitFor(() => expect(cm.state.doc.length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 30));
    }
    const doc = cm.state.doc.toString();
    expect(doc).toContain("![[doc.pdf]]");
    expect(doc).toContain("![[doc 1.pdf]]");
    expect(doc).toContain("[[data.zip]]");
    expect(doc).not.toContain("![[data.zip]]");
    expect([read("doc.pdf"), read("doc 1.pdf"), read("data.zip")]).toEqual(["A", "B", "Z"]);
  });

  it("uses the vault's attachment folder and Markdown links when configured", async () => {
    const { app, cm } = await openNote();
    app.vault.setConfig("attachmentFolderPath", "assets");
    app.vault.setConfig("useMarkdownLinks", true);
    cm.dispatch({ selection: { anchor: 0 } });
    cm.contentDOM.dispatchEvent(withData(new Event("paste", { bubbles: true, cancelable: true }), "clipboardData", [file("pic.png", "image/png", "P")]));
    await vi.waitFor(() => expect(cm.state.doc.toString()).toContain("![](pic.png)")); // empty alt for a pasted image; the shortest-path format drops the folder
    expect(exists("assets/pic.png")).toBe(true);
  });

  it("fires editor-paste and editor-drop for plugins, and a plugin can cancel the default handling", async () => {
    const { app, view, cm } = await openNote();
    const seen: string[] = [];
    app.workspace.on("editor-paste", (e: Event, editor: any, v2: any) => { seen.push(`paste:${editor === view.editor}:${v2 === view}`); e.preventDefault(); });
    app.workspace.on("editor-drop", (_e: Event, _editor: any, _v: any) => { seen.push("drop"); });
    const paste = withData(new Event("paste", { bubbles: true, cancelable: true }), "clipboardData", [file("img.png", "image/png")]);
    cm.contentDOM.dispatchEvent(paste);
    expect(seen).toEqual(["paste:true:true"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(exists("img.png")).toBe(false); // canceled: nothing was saved
    expect(cm.state.doc.toString()).toBe("before after\n");
    cm.contentDOM.dispatchEvent(withData(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { clientX: 0, clientY: 0 }), "dataTransfer", []));
    expect(seen).toEqual(["paste:true:true", "drop"]);
  });

  it("turns a file dragged from the explorer into a link, embedding media", async () => {
    const { cm } = await openNote();
    v.write?.("Other.md", "# Other\n");
    const drop = (p: string) => cm.contentDOM.dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), {
      clientX: 0, clientY: 0, dataTransfer: { files: [], getData: (t: string) => (t === "application/x-tachylite-vault-path" ? p : "") },
    }));
    drop("Notes/Note.md");
    await vi.waitFor(() => expect(cm.state.doc.toString()).toContain("[[Note]]"));
    drop("does/not/exist.md"); // not a vault file: the editor's own text drop applies
    await new Promise((r) => setTimeout(r, 30));
    expect(cm.state.doc.toString().match(/\[\[/g)?.length).toBe(1);
  });

  it("leaves plain text pastes to the editor", async () => {
    const { cm } = await openNote();
    const ev = withData(new Event("paste", { bubbles: true, cancelable: true }), "clipboardData", []);
    cm.contentDOM.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 30));
    expect(cm.state.doc.toString()).toBe("before after\n"); // CodeMirror's own paste handling took it; no attachment was made
    expect(fs.readdirSync(v.root).filter((n) => !n.startsWith(".") && n !== "Notes")).toEqual([]);
  });
});

describe("pasting HTML", () => {
  const htmlPaste = (cm: any, html: string, plain: string) => {
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { files: [], items: [], types: ["text/html"], getData: (t: string) => (t === "text/html" ? html : plain) } });
    cm.contentDOM.dispatchEvent(ev);
    return ev;
  };
  it("converts it to Markdown by default", async () => {
    const { cm } = await openNote();
    cm.dispatch({ selection: { anchor: 6, head: 6 } });
    const ev = htmlPaste(cm, "<p>a <b>b</b></p>", "a b");
    expect(ev.defaultPrevented).toBe(true);
    expect(cm.state.doc.toString()).toBe("beforea **b** after\n");
  });
  it("is left alone with autoConvertHtml off or when the HTML is only plain text", async () => {
    const { app, cm } = await openNote();
    cm.dispatch({ selection: { anchor: 0 } });
    htmlPaste(cm, "<span>x</span>", "x");
    expect(cm.state.doc.toString()).toBe("xbefore after\n");
    app.vault.setConfig("autoConvertHtml", false);
    htmlPaste(cm, "<p><b>y</b></p>", "y");
    expect(cm.state.doc.toString()).not.toContain("**");
  });
});

describe("pasting a URL over a selection", () => {
  it("wraps the selected text in a Markdown link", async () => {
    const { cm } = await openNote();
    cm.dispatch({ selection: { anchor: 0, head: 6 } });
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { files: [], items: [], types: ["text/plain"], getData: (t: string) => (t === "text/plain" ? "https://example.com/a" : "") } });
    cm.contentDOM.dispatchEvent(ev);
    expect(cm.state.doc.toString()).toBe("[before](https://example.com/a) after\n");
  });
});

describe("quit event", () => {
  it("lets plugins delay the close until their tasks finish", async () => {
    const { app } = await openNote();
    let done = false;
    app.workspace.on("quit", (tasks: any) => { tasks.add(async () => { await new Promise((r) => setTimeout(r, 40)); done = true; }); });
    await session!.shell.flushAsync();
    expect(done).toBe(true);
  });
});
