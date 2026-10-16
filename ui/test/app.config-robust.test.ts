// Hand-edited or corrupt config files must not stop the app from starting.
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
  v = makeVault({ "Note.md": "x\n" });
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
  const app = session.app;
  return app;
}

describe("hand-edited hotkeys.json", () => {
  it("keeps well-formed entries and ignores junk", async () => {
    fs.writeFileSync(path.join(v.root, ".obsidian/hotkeys.json"), JSON.stringify({
      "t:a": [{ modifiers: ["Mod"], key: "J" }],
      "t:bad1": "oops", "t:bad2": [{ key: 5 }], "t:bad3": [null], "t:ok-empty": [],
    }));
    const app = await boot();
    expect(app.hotkeyManager.customKeys).toEqual({ "t:a": [{ modifiers: ["Mod"], key: "J" }], "t:ok-empty": [] });
  });
  it("survives a hotkeys.json that is not an object", async () => {
    fs.writeFileSync(path.join(v.root, ".obsidian/hotkeys.json"), "[1,2,3]");
    const app = await boot();
    expect(app.hotkeyManager.customKeys).toEqual({});
  });
});

describe("garbage config files", () => {
  const cases: Record<string, string> = { "[]": "[]", "null": "null", "number": "5", "truncated": "{", "string": "\"x\"", "BOM + wrong types": "﻿{\"theme\":5,\"cssTheme\":[],\"enabledPlugins\":\"x\",\"baseFontSize\":\"big\",\"accentColor\":7}" };
  for (const [name, body] of Object.entries(cases)) {
    it(`the app still starts when app.json, appearance.json, core-plugins.json and workspace.json are ${name}`, async () => {
      for (const f of ["app.json", "appearance.json", "core-plugins.json", "community-plugins.json", "workspace.json", "graph.json", "bookmarks.json", "types.json"]) fs.writeFileSync(path.join(v.root, ".obsidian", f), body);
      const app = await boot();
      await app.workspace.openLinkText("Note", "", false);
      expect(app.workspace.getActiveFile()?.path).toBe("Note.md");
      expect(typeof app.vault.getConfig("tabSize")).toBe("number");
    });
  }
});
