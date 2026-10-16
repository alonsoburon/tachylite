// Core plugin "Slides": splitting a note into slides and presenting it full screen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { splitSlides } from "../src/app/core/slides";

describe("splitSlides", () => {
  it("splits on horizontal rules and drops empty slides", () => {
    expect(splitSlides("# One\ntext\n\n---\n\n## Two\n\n---\n---\nThree")).toEqual(["# One\ntext", "## Two", "Three"]);
  });
  it("ignores a leading frontmatter block and rules inside code fences", () => {
    expect(splitSlides("---\ntitle: T\n---\n# A\n\n```md\n---\nnot a split\n```\n\n---\n# B")).toEqual(["# A\n\n```md\n---\nnot a split\n```", "# B"]);
    expect(splitSlides("~~~\n---\n~~~\nafter")).toEqual(["~~~\n---\n~~~\nafter"]);
  });
  it("gives one empty slide for an empty note", () => {
    expect(splitSlides("")).toEqual([""]);
    expect(splitSlides("---\n---\n")).toEqual([""]);
  });
});

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Talk.md": "# First\nhello\n\n---\n\n# Second\n\n---\n\n# Third\n" });
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

const key = (k: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const counter = () => document.querySelector(".slides-counter")?.textContent;
const slideText = () => document.querySelector(".slides-slide")?.textContent ?? "";

describe("presentation", () => {
  it("is off by default; the command needs an open note and presents it with keyboard navigation", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    session = await startSession((await v.backend("vault_info")) as any, host);
    const app = session.app;
    expect(app.commands.findCommand("slides:start")).toBeUndefined();
    await app.internalPlugins.getPluginById("slides")!.enable();
    expect(app.commands.findCommand("slides:start")?.name).toBe("Slides: Start presentation");
    expect(document.querySelector('.side-dock-ribbon-action[aria-label="Start presentation"]')).toBeTruthy();

    await app.workspace.openLinkText("Talk", "", false);
    await vi.waitFor(() => expect((app.workspace.activeLeaf!.view as any).file?.basename).toBe("Talk"));
    const editor = (app.workspace.activeLeaf!.view as any).editor;
    editor.setCursor({ line: 0, ch: 0 });
    expect(app.commands.executeCommandById("slides:start")).toBe(true);
    await vi.waitFor(() => expect(counter()).toBe("1 / 3"));
    await vi.waitFor(() => expect(slideText()).toContain("First"));
    key("ArrowRight");
    await vi.waitFor(() => expect(counter()).toBe("2 / 3"));
    await vi.waitFor(() => expect(slideText()).toContain("Second"));
    key("End");
    await vi.waitFor(() => expect(counter()).toBe("3 / 3"));
    key("ArrowRight"); // already on the last slide
    await new Promise((r) => setTimeout(r, 30));
    expect(counter()).toBe("3 / 3");
    key("ArrowLeft");
    await vi.waitFor(() => expect(counter()).toBe("2 / 3"));
    key("Home");
    await vi.waitFor(() => expect(counter()).toBe("1 / 3"));
    expect(editor.getCursor()).toEqual({ line: 0, ch: 0 }); // the keys went to the presentation, not the editor
    key("Escape");
    expect(document.querySelector(".slides-presentation")).toBeNull();
    key("ArrowDown"); // after closing the keyboard belongs to the app again
    await app.internalPlugins.getPluginById("slides")!.disable();
    expect(app.commands.findCommand("slides:start")).toBeUndefined();
  });

  it("the command is unavailable without an open note", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    session = await startSession((await v.backend("vault_info")) as any, host);
    const app = session.app;
    await app.internalPlugins.getPluginById("slides")!.enable();
    expect(app.commands.executeCommandById("slides:start")).toBe(false);
  });
});
