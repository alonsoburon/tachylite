// Node bridge for desktop plugins (src/obsidian/nodeBridge.ts) against the fake backend, which emulates bridge.rs with
// node's own fs / child_process: real processes, real files outside the vault, gating and the settings switch.
import ncp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeApp, makeVault, type FakeVault } from "./helpers/backend";
import { clickToggle, flush, row, show } from "./helpers/settings";
import { installSettings } from "../src/app/settings";
import { NODE_BRIDGE_SETTING } from "../src/app/settings/community";
import { nodeBridge } from "../src/obsidian/nodeBridge";
import type { App } from "../src/obsidian/app";

let v: FakeVault | undefined, app: App | undefined, out: string | undefined, dispose: (() => void) | undefined;
afterEach(async () => {
  dispose?.();
  await app?.stop();
  v?.cleanup();
  if (out) fs.rmSync(out, { recursive: true, force: true });
  nodeBridge.reset();
  document.body.innerHTML = "";
  v = app = out = dispose = undefined;
});

const req = (id: string) => (globalThis as any).require(id);
async function bridged(consent = true) {
  v = makeVault({ "Note.md": "# Note" }, { bridgeConsent: consent });
  app = await makeApp(v);
  return app;
}
const hasGit = (() => { try { return ncp.spawnSync("git", ["--version"]).status === 0; } catch { return false; } })();

describe("gate", () => {
  it("stays off without consent: child_process throws, fs is vault-confined, process has no env", async () => {
    await bridged(false);
    expect(nodeBridge.active).toBe(false);
    expect(() => req("child_process").exec("echo hi")).toThrow(/child_process\.exec is not supported: plugins are not allowed to run programs/);
    await expect(req("fs").promises.readFile(path.join(os.tmpdir(), "x"))).rejects.toMatchObject({ code: "EACCES" });
    expect(app!.pluginProcess.env).toEqual({});
    expect(app!.pluginProcess.cwd()).toBe("/");
    // The backend enforces it too, whatever the UI does.
    await expect(v!.backend("bridge_fs", { op: { op: "exists", path: "/" } })).rejects.toMatch(/ERR_BRIDGE_DISABLED/);
  });

  it("needs community plugins on: restricted mode deactivates it, consent is kept", async () => {
    await bridged(true);
    expect(nodeBridge.active).toBe(true);
    await app!.plugins.turnOffCommunityPlugins();
    expect(nodeBridge.active).toBe(false);
    expect(v!.bridge).toMatchObject({ consent: true, active: false });
    await app!.plugins.turnOnCommunityPlugins();
    expect(nodeBridge.active).toBe(true);
  });
});

describe("child_process", () => {
  it.skipIf(!hasGit)("spawn git --version streams stdout and emits spawn, exit, close in order", async () => {
    await bridged();
    const { spawn } = req("child_process");
    const events: string[] = [];
    let stdout = "";
    const child = spawn("git", ["--version"]);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    for (const ev of ["spawn", "exit", "close"]) child.on(ev, () => events.push(ev));
    const code = await new Promise((r) => child.on("close", r));
    expect(code).toBe(0);
    expect(stdout).toMatch(/^git version \d/);
    expect(events).toEqual(["spawn", "exit", "close"]);
    expect(child.pid).toBeGreaterThan(0);
    expect(child.exitCode).toBe(0);
  });

  it("exec works with util.promisify (stdout/stderr object; Node's error shape on failure)", async () => {
    await bridged();
    const exec = req("util").promisify(req("child_process").exec);
    await expect(exec("echo hi && echo warn >&2")).resolves.toEqual({ stdout: "hi\n", stderr: "warn\n" });
    const err = await exec("echo partial; echo bad >&2; exit 3").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 3, killed: false, signal: null, cmd: "echo partial; echo bad >&2; exit 3", stdout: "partial\n", stderr: "bad\n" });
    expect(err.message).toBe("Command failed: echo partial; echo bad >&2; exit 3\nbad\n");
    // shell semantics + cwd: exec runs in /bin/sh with the vault root as default cwd
    expect((await exec("pwd")).stdout.trim()).toBe(fs.realpathSync(v!.root));
    expect((await exec("echo $TACHY_X", { env: { ...process.env, TACHY_X: "from-env" } })).stdout).toBe("from-env\n");
  });

  it("exec callback: timeout kills, maxBuffer, encoding buffer", async () => {
    await bridged();
    const { exec } = req("child_process");
    const run = (cmd: string, o: object) => new Promise<any[]>((r) => exec(cmd, o, (...a: any[]) => r(a)));
    const [e1] = await run("sleep 5", { timeout: 100 });
    expect(e1).toMatchObject({ killed: true, signal: "SIGTERM", code: null });
    const [e2, so2] = await run("printf 0123456789", { maxBuffer: 4 });
    expect(e2).toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    expect(so2).toBe("0123");
    const [e3, so3] = await run("printf abc", { encoding: "buffer" });
    expect(e3).toBeNull();
    expect(ArrayBuffer.isView(so3) && so3.toString()).toBe("abc");
  });

  it("stdin write/end, setEncoding and pipe", async () => {
    await bridged();
    const { spawn } = req("child_process");
    const child = spawn("cat");
    child.stdout.setEncoding("utf8");
    const chunks: unknown[] = [];
    const sink = { write: (c: unknown) => chunks.push(c), end: vi.fn() };
    child.stdout.pipe(sink);
    child.stdin.write("hello ");
    child.stdin.end("world");
    await new Promise((r) => child.on("close", r));
    expect(chunks.join("")).toBe("hello world");
    expect(typeof chunks[0]).toBe("string");
    expect(sink.end).toHaveBeenCalled();
  });

  it("missing binary: 'error' with ENOENT then 'close'; kill() sends signals", async () => {
    await bridged();
    const { spawn } = req("child_process");
    const bad = spawn("definitely-not-a-binary-xyz", ["a"]);
    const err: any = await new Promise((r) => bad.on("error", r));
    expect(err).toMatchObject({ code: "ENOENT", syscall: "spawn definitely-not-a-binary-xyz", path: "definitely-not-a-binary-xyz", spawnargs: ["definitely-not-a-binary-xyz", "a"] });
    expect(err.message).toBe("spawn definitely-not-a-binary-xyz ENOENT");
    const sleeper = spawn("sleep", ["30"]);
    await new Promise((r) => sleeper.on("spawn", r));
    expect(sleeper.kill()).toBe(true);
    const [code, sig] = await new Promise<any[]>((r) => sleeper.on("exit", (...a: any[]) => r(a)));
    expect([code, sig, sleeper.killed]).toEqual([null, "SIGTERM", true]);
  });

  it("sync variants go through the sync channel", async () => {
    await bridged();
    const cp = req("child_process");
    expect(cp.execSync("echo sync").toString()).toBe("sync\n");
    expect(cp.execSync("echo sync", { encoding: "utf8" })).toBe("sync\n");
    expect(cp.execFileSync("sh", ["-c", "cat"], { input: "piped", encoding: "utf8" })).toBe("piped");
    const r = cp.spawnSync("sh", ["-c", "echo o; echo e >&2; exit 2"], { encoding: "utf8" });
    expect(r).toMatchObject({ status: 2, signal: null, stdout: "o\n", stderr: "e\n" });
    expect(() => cp.execSync("exit 4")).toThrow(expect.objectContaining({ status: 4, message: "Command failed: exit 4" }));
  });
});

describe("fs, os, process, electron", () => {
  it("reads and writes absolute paths anywhere, with Node's API shapes", async () => {
    await bridged();
    out = fs.mkdtempSync(path.join(os.tmpdir(), "tachy-out-"));
    const nfs = req("fs"), fsp = req("fs/promises");
    expect(nfs.promises).toBe(fsp);
    const f = path.join(out, "a", "b.txt");
    expect(await fsp.mkdir(path.join(out, "a"), { recursive: true })).toBe(path.join(out, "a"));
    await fsp.writeFile(f, "one");
    await fsp.appendFile(f, Buffer.from("+two"));
    expect(await fsp.readFile(f, "utf8")).toBe("one+two");
    expect(fs.readFileSync(f, "utf8")).toBe("one+two");
    expect(ArrayBuffer.isView(await fsp.readFile(f))).toBe(true); // the webview's Buffer (npm "buffer"), not node's
    const st = await fsp.stat(f);
    expect([st.isFile(), st.isDirectory(), st.size, st.mtime instanceof Date]).toEqual([true, false, 7, true]);
    expect(Math.abs(st.mtimeMs - fs.statSync(f).mtimeMs)).toBeLessThan(1);
    const ents = await fsp.readdir(out, { withFileTypes: true });
    expect(ents.map((d: any) => [d.name, d.isDirectory(), d.parentPath])).toEqual([["a", true, out]]);
    // sync + callback flavours
    expect(nfs.existsSync(f)).toBe(true);
    expect(nfs.statSync(path.join(out, "a")).isDirectory()).toBe(true);
    nfs.writeFileSync(path.join(out, "s.txt"), "sync");
    expect(nfs.readdirSync(out)).toEqual(["a", "s.txt"]);
    const cbRead = await new Promise<any[]>((r) => nfs.readFile(path.join(out!, "s.txt"), "utf8", (...a: any[]) => r(a)));
    expect(cbRead).toEqual([null, "sync"]);
    await fsp.copyFile(f, path.join(out, "c.txt"));
    await fsp.rename(path.join(out, "c.txt"), path.join(out, "d.txt"));
    expect(await fsp.realpath(path.join(out, "d.txt"))).toBe(fs.realpathSync(path.join(out, "d.txt")));
    await fsp.rm(path.join(out, "a"), { recursive: true });
    expect(fs.existsSync(path.join(out, "a"))).toBe(false);
    // Node error shape
    const err = await fsp.readFile(path.join(out, "missing")).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "ENOENT", syscall: "open", path: path.join(out, "missing"), errno: -2 });
    expect(err.message).toBe(`ENOENT: no such file or directory, open '${path.join(out, "missing")}'`);
    expect(() => nfs.statSync(path.join(out!, "missing"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
    await expect(fsp.access(path.join(out, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("relative paths resolve against process.cwd() (the vault root); real os/process values", async () => {
    await bridged();
    const p = app!.pluginProcess;
    expect(p.cwd()).toBe(v!.root);
    expect(p.platform).toBe(process.platform);
    expect(p.env.PATH).toBe(process.env.PATH);
    req("fs").writeFileSync("rel.txt", "x");
    expect(fs.readFileSync(path.join(v!.root, "rel.txt"), "utf8")).toBe("x");
    const o = req("os");
    expect([o.homedir(), o.tmpdir(), o.hostname(), o.EOL]).toEqual([os.homedir(), os.tmpdir(), os.hostname(), os.EOL]);
    expect(app!.vault.adapter.getBasePath()).toBe(v!.root);
    expect(app!.vault.adapter.getFullPath("Note.md")).toBe(path.join(v!.root, "Note.md"));
  });

  it("fs.promises.watch yields changes until aborted", async () => {
    await bridged();
    out = fs.mkdtempSync(path.join(os.tmpdir(), "tachy-watch-"));
    const ac = new AbortController();
    const it = req("fs/promises").watch(out, { signal: ac.signal });
    const first = it.next();
    await flush();
    fs.writeFileSync(path.join(out, "touched"), "1");
    expect((await first).value).toMatchObject({ filename: "touched" });
    ac.abort();
    await expect(it.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("electron shell.openPath / showItemInFolder go through the bridge", async () => {
    await bridged();
    const { shell } = req("electron");
    expect(await shell.openPath(path.join(v!.root, "Note.md"))).toBe("");
    shell.showItemInFolder(path.join(v!.root, "Note.md"));
    await flush();
    expect(v!.bridge.opened).toEqual([{ path: path.join(v!.root, "Note.md"), reveal: false }, { path: path.join(v!.root, "Note.md"), reveal: true }]);
  });
});

describe("settings switch (e2e)", () => {
  const PLUGIN = `
const { Plugin } = require("obsidian");
module.exports = class P extends Plugin {
  onload() {
    try { window.__bridgeProbe = require("child_process").execSync("echo bridged", { encoding: "utf8" }).trim(); }
    catch (e) { window.__bridgeProbe = "error: " + e.code; }
  }
};`;
  const modal = () => document.querySelector<HTMLElement>(".modal.mod-node-bridge-warning");
  const modalBtn = (t: string) => [...modal()!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === t)!;

  it("first turn-on asks with a warning modal; cancel keeps it off, accept enables, toggle turns it off", async () => {
    v = makeVault({ "A.md": "# A" }, { plugins: { probe: { main: PLUGIN } }, enabled: ["probe"] });
    app = await makeApp(v);
    dispose = installSettings(app);
    expect((window as any).__bridgeProbe).toBe("error: ERR_BRIDGE_DISABLED");
    const t = await show(app, "community-plugins");
    const toggle = () => row(t.containerEl, NODE_BRIDGE_SETTING);
    expect(toggle().querySelector(".checkbox-container")!.classList.contains("is-enabled")).toBe(false);

    clickToggle(toggle());
    await vi.waitFor(() => expect(modal()).not.toBeNull());
    expect(modal()!.textContent).toContain("full permissions of your user account");
    expect(modal()!.textContent).toContain("read, change or delete any file");
    modalBtn("Cancel").click();
    await vi.waitFor(() => expect(modal()).toBeNull());
    expect(v.bridge).toMatchObject({ consent: false, active: false });
    expect(v.calls.some((c) => c.cmd === "bridge_set_enabled")).toBe(false);

    clickToggle(toggle());
    await vi.waitFor(() => expect(modal()).not.toBeNull());
    modalBtn("Allow full access").click();
    await vi.waitFor(() => expect((window as any).__bridgeProbe).toBe("bridged"));
    expect(v.bridge).toMatchObject({ consent: true, active: true });
    await vi.waitFor(() => expect(toggle().querySelector(".checkbox-container")!.classList.contains("is-enabled")).toBe(true));

    clickToggle(toggle());
    await vi.waitFor(() => expect((window as any).__bridgeProbe).toBe("error: ERR_BRIDGE_DISABLED"));
    expect(modal()).toBeNull(); // turning it off needs no confirmation
    expect(v.bridge).toMatchObject({ consent: false, active: false });
    expect(nodeBridge.active).toBe(false);
  });
});
