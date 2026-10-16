// Core plugin "Unique note creator": a timestamp-named note, from an optional template.
import fs from "node:fs";
import path from "node:path";
import moment from "moment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { readJson, row, show, type as typeIn } from "./helpers/settings";
import { createUniqueNote, uniqueNoteName } from "../src/app/core/uniqueNote";

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Templates/Zettel.md": "---\ntags: [z]\n---\n# {{title}}\ncreated {{date:YYYY}}\n", "Other.md": "x\n" });
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

async function boot() {
  const host = document.body.appendChild(document.createElement("div"));
  session = await startSession((await v.backend("vault_info")) as any, host);
  return session.app;
}
const read = (rel: string) => fs.readFileSync(path.join(v.root, rel), "utf8");
const mds = () => fs.readdirSync(v.root).filter((n) => n.endsWith(".md") && n !== "Other.md");

describe("unique note creator", () => {
  it("is off by default; enabling it adds the command, and disabling removes it again", async () => {
    const app = await boot();
    const plugin = app.internalPlugins.getPluginById("zk-prefixer")!;
    expect(plugin.enabled).toBe(false);
    expect(app.commands.findCommand("zk-prefixer")).toBeUndefined();
    await plugin.enable();
    expect(app.commands.findCommand("zk-prefixer")?.name).toBe("Unique note creator: Create new unique note");
    await plugin.disable();
    expect(app.commands.findCommand("zk-prefixer")).toBeUndefined();
  });

  it("creates a note named by the default YYYYMMDDHHmm prefix and opens it", async () => {
    const app = await boot();
    await app.internalPlugins.getPluginById("zk-prefixer")!.enable();
    const when = moment("2025-03-04 09:05");
    expect(uniqueNoteName(app, when)).toBe("202503040905");
    const f = await createUniqueNote(app, when);
    expect(f?.path).toBe("202503040905.md");
    expect(read("202503040905.md")).toBe("");
    await vi.waitFor(() => expect((app.workspace.activeLeaf!.view as any).file?.path).toBe("202503040905.md"));
    // a second note in the same minute gets a distinct name instead of overwriting
    const g = await createUniqueNote(app, when);
    expect(g?.path).toBe("202503040905 1.md");
    expect(mds().sort()).toEqual(["202503040905 1.md", "202503040905.md"]);
  });

  it("uses the configured format and template, and keeps file names valid", async () => {
    const app = await boot();
    const plugin = app.internalPlugins.getPluginById("zk-prefixer")!;
    await plugin.enable();
    plugin.instance.options.format = "YYYY-MM-DD HHmm [idea/x]"; // the slash must not create a folder
    plugin.instance.options.template = "Templates/Zettel";
    const when = moment("2025-03-04 09:05");
    expect(uniqueNoteName(app, when)).toBe("2025-03-04 0905 idea-x");
    const f = await createUniqueNote(app, when);
    expect(f?.path).toBe("2025-03-04 0905 idea-x.md");
    expect(read(f!.path)).toBe("---\ntags: [z]\n---\n# 2025-03-04 0905 idea-x\ncreated 2025\n");
  });

  it("does nothing but tell you when the configured template is missing", async () => {
    const app = await boot();
    const plugin = app.internalPlugins.getPluginById("zk-prefixer")!;
    await plugin.enable();
    plugin.instance.options.template = "Templates/Nope";
    expect(await createUniqueNote(app)).toBeNull();
    expect(mds()).toEqual([]);
  });

  it("has an options tab that persists format and template to zk-prefixer.json", async () => {
    const app = await boot();
    await app.internalPlugins.getPluginById("zk-prefixer")!.enable();
    const el = (await show(app, "zk-prefixer")).containerEl;
    typeIn(row(el, "Unique note prefix format").querySelector("input")!, "YYMMDD-HHmm");
    typeIn(row(el, "Template file location").querySelector("input")!, "Templates/Zettel");
    await vi.waitFor(() => expect(readJson(v, ".obsidian/zk-prefixer.json")).toEqual({ format: "YYMMDD-HHmm", template: "Templates/Zettel" }));
  });
});
