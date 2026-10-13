// Deleting notes: OS trash (with fallback to .trash and a notice), the vault's .trash, permanent deletion,
// and errors reaching the user, through the real session against the fake backend.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";

let v: FakeVault;
let session: Session | null = null;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function boot(trashOption?: string): Promise<Session> {
  fs.writeFileSync(path.join(v.root, ".obsidian/app.json"), JSON.stringify({ promptDelete: false, ...(trashOption ? { trashOption } : {}) }));
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
  const host = document.body.createDiv();
  session = await startSession((await v.backend("vault_info")) as any, host);
  return session;
}

async function deleteActive(s: Session, file: string): Promise<void> {
  await s.app.workspace.openLinkText(file, "", false);
  await tick(20);
  s.app.commands.executeCommandById("app:delete-file");
  await tick(50);
}
const notices = () => [...document.querySelectorAll(".notice")].map((n) => n.textContent ?? "");

beforeEach(() => { document.body.innerHTML = ""; localStorage.clear(); v = makeVault({ "A.md": "a", "B.md": "b", "Keep.md": "k" }); });
afterEach(async () => { await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

describe("deleting files", () => {
  it("moves to the OS trash by default", async () => {
    const s = await boot();
    await deleteActive(s, "A");
    expect(fs.existsSync(path.join(v.root, "A.md"))).toBe(false);
    expect(fs.existsSync(path.join(v.systemTrash, "A.md"))).toBe(true);
    expect(fs.existsSync(path.join(v.root, ".trash/A.md"))).toBe(false);
    expect(s.app.vault.getFileByPath("A.md")).toBeNull();
    expect(v.calls.some((c) => c.cmd === "fs_trash" && c.args.mode === "system")).toBe(true);
  });

  it("falls back to .trash with a notice when the OS trash fails", async () => {
    const s = await boot("system");
    v.systemTrashFails = true;
    await deleteActive(s, "A");
    expect(fs.existsSync(path.join(v.root, ".trash/A.md"))).toBe(true);
    expect(notices().some((t) => /system trash/.test(t) && /\.trash/.test(t))).toBe(true);
  });

  it("honours trashOption local and none", async () => {
    let s = await boot("local");
    await deleteActive(s, "A");
    expect(fs.existsSync(path.join(v.root, ".trash/A.md"))).toBe(true);
    expect(fs.existsSync(path.join(v.systemTrash, "A.md"))).toBe(false);
    await session!.stop(); session = null; document.body.innerHTML = "";
    s = await boot("none");
    await deleteActive(s, "B");
    expect(fs.existsSync(path.join(v.root, "B.md"))).toBe(false);
    expect(fs.existsSync(path.join(v.root, ".trash/B.md"))).toBe(false);
    expect(fs.existsSync(path.join(v.systemTrash, "B.md"))).toBe(false);
  });

  it("plugin API: Vault.delete is permanent, Vault.trash and adapter.trashSystem report the OS trash", async () => {
    const s = await boot("local");
    const vault = s.app.vault;
    await vault.delete(vault.getFileByPath("A.md")!);
    expect(fs.existsSync(path.join(v.root, ".trash/A.md"))).toBe(false);
    expect(await vault.trash(vault.getFileByPath("B.md")!, true)).toBe("system");
    expect(fs.existsSync(path.join(v.systemTrash, "B.md"))).toBe(true);
    v.systemTrashFails = true;
    expect(await vault.adapter.trashSystem("Keep.md")).toBe(false);
    expect(fs.existsSync(path.join(v.root, "Keep.md"))).toBe(true);
    await vault.adapter.trashLocal("Keep.md");
    expect(fs.existsSync(path.join(v.root, ".trash/Keep.md"))).toBe(true);
  });

  it("shows a notice instead of failing silently when deletion errors", async () => {
    const s = await boot("local");
    await s.app.workspace.openLinkText("A", "", false);
    await tick(20);
    fs.rmSync(path.join(v.root, "A.md")); // vanished behind the app's back
    s.app.commands.executeCommandById("app:delete-file");
    await tick(50);
    expect(notices().some((t) => /Couldn't delete "A\.md"/.test(t))).toBe(true);
  });
});
