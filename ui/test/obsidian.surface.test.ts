// The shim must export every value and every class method that the published `obsidian` typings declare.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as shim from "../src/obsidian";

const text = fs.readFileSync(path.join(__dirname, "../node_modules/obsidian/obsidian.d.ts"), "utf8");
const lines = text.split("\n");

// A light scan of the typings (the TypeScript compiler API is not available in TS 7).
const values = new Set<string>();
const classes = new Map<string, { methods: string[]; statics: string[]; props: string[] }>();
let cur: { methods: string[]; statics: string[]; props: string[] } | null = null;
for (const line of lines) {
  let m: RegExpExecArray | null;
  if ((m = /^export (?:declare )?(abstract )?class (\w+)/.exec(line))) {
    values.add(m[2]);
    cur = { methods: [], statics: [], props: [] };
    classes.set(m[2], cur);
    continue;
  }
  if ((m = /^export (?:declare )?(?:function|const|enum|var|let) (\w+)/.exec(line))) values.add(m[1]);
  if (/^}/.test(line)) { cur = null; continue; }
  if (cur && (m = /^    (?:readonly )?(\w+)(\??): /.exec(line))) { if (!m[2]) cur.props.push(m[1]); }
  if (cur && (m = /^    (static )?(abstract )?(?:async )?(\w+)\??(?:<[^>]*>)?\(/.exec(line)) && !m[2] && m[3] !== "constructor") {
    (m[1] ? cur.statics : cur.methods).push(m[3]);
  }
}

// Declared in the typings but not implemented on purpose (mobile only, paid services or internals).
const KNOWN_MISSING_VALUES = new Set<string>([]);
// `CapacitorAdapter` is the mobile adapter; `onExternalSettingsChange` is an optional hook the loader calls when a plugin defines it.
const KNOWN_MISSING_METHODS = new Set<string>([]);

const KNOWN_MISSING_PROPS = new Set<string>([]);

describe("obsidian module surface", () => {
  it("scans the typings", () => {
    expect(values.size).toBeGreaterThan(100);
    expect(classes.get("Plugin")!.methods).toContain("loadData");
  });
  it("exports every declared value", () => {
    const missing = [...values].filter((n) => !(n in shim) && !KNOWN_MISSING_VALUES.has(n));
    expect(missing.sort()).toEqual([]);
  });
  it("implements every declared class method", () => {
    const missing: string[] = [];
    for (const [name, { methods, statics }] of classes) {
      const impl = (shim as any)[name];
      if (name === "CapacitorAdapter") continue;
      if (typeof impl !== "function") continue;
      for (const m of methods) if (m !== "onExternalSettingsChange" && typeof impl.prototype?.[m] !== "function") missing.push(`${name}.${m}`);
      for (const m of statics) if (typeof impl[m] !== "function") missing.push(`${name}.static ${m}`);
    }
    expect(missing.sort()).toEqual([]);
  });
});

describe("FileSystemAdapter static helpers", () => {
  it("refuse absolute paths while the Node bridge is off", async () => {
    await expect(shim.FileSystemAdapter.readLocalFile("/etc/hostname")).rejects.toThrow(/outside the vault/);
    await expect(shim.FileSystemAdapter.mkdir("/tmp/x")).rejects.toThrow(/outside the vault/);
  });
});

// Declared fields of the core objects plugins reach through `app`, checked on a running session.
import { afterEach, beforeEach, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";

describe("core object properties", () => {
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

  it("leaf, markdown view, file and plugin-facing objects carry every declared field", async () => {
    session = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
    const app = session.app as any;
    await app.workspace.openLinkText("Note", "", false);
    const leaf = app.workspace.activeLeaf;
    const view = leaf.view;
    await vi.waitFor(() => expect(view.file?.basename).toBe("Note"));
    const targets: Record<string, any> = { WorkspaceLeaf: leaf, MarkdownView: view, TFile: view.file, TFolder: app.vault.getRoot(), Keymap: app.keymap, Scope: app.scope, HotkeyManager: app.hotkeyManager, Commands: app.commands, SettingTab: undefined };
    const missing: string[] = [];
    for (const [name, obj] of Object.entries(targets)) {
      if (!obj || !classes.has(name)) continue;
      for (const prop of classes.get(name)!.props) if (!(prop in obj)) missing.push(`${name}.${prop}`);
    }
    expect(missing.sort()).toEqual([]);
  });

  it("App, Vault, Workspace, MetadataCache and FileManager carry every declared field", async () => {
    session = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
    const app = session.app as any;
    const targets: Record<string, any> = { App: app, Vault: app.vault, Workspace: app.workspace, MetadataCache: app.metadataCache, FileManager: app.fileManager };
    const missing: string[] = [];
    expect(classes.get("App")!.props).toEqual(expect.arrayContaining(["workspace", "vault", "metadataCache"]));
    for (const [name, obj] of Object.entries(targets)) {
      for (const prop of classes.get(name)!.props) if (!(prop in obj) && !KNOWN_MISSING_PROPS.has(`${name}.${prop}`)) missing.push(`${name}.${prop}`);
    }
    expect(missing.sort()).toEqual([]);
  });
});
