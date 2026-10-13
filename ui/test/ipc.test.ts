import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc, setBackend, bytes, toArrayBuffer } from "../src/ipc";

afterEach(() => { setBackend(() => { throw new Error("no backend"); }); });

describe("ipc wrappers", () => {
  it("send camelCase argument names matching the Tauri command contract", async () => {
    const calls: [string, any][] = [];
    setBackend(async (cmd, args) => { calls.push([cmd, args]); return cmd === "meta_resolve" ? null : []; });
    await ipc.fsRename("a.md", "b.md");
    await ipc.metaResolve("L", "src.md");
    await ipc.metaLinktext("t.md", "s.md", true);
    await ipc.adapterRemove("x", true);
    await ipc.configWrite("app.json", { a: 1 });
    await ipc.pluginSetEnabled("id", false);
    await ipc.pluginBundle("id");
    await ipc.httpRequest({ url: "http://x", method: "GET" });
    expect(calls).toEqual([
      ["fs_rename", { from: "a.md", to: "b.md" }], ["meta_resolve", { link: "L", source: "src.md" }], ["meta_linktext", { target: "t.md", source: "s.md", omitMd: true }],
      ["adapter_remove", { path: "x", recursive: true }], ["config_write", { name: "app.json", value: { a: 1 } }], ["plugin_set_enabled", { id: "id", enabled: false }],
      ["plugin_bundle", { id: "id" }], ["http_request", { req: { url: "http://x", method: "GET" } }],
    ]);
  });
  it("binary: writes send number arrays (serde Vec<u8>), reads return ArrayBuffer for ArrayBuffer/typed array/array payloads", async () => {
    let sent: any;
    setBackend(async (cmd, args) => { sent = args; return cmd.endsWith("read_binary") ? new Uint8Array([1, 2, 3]) : { path: "p" }; });
    await ipc.fsWriteBinary("p", new Uint8Array([9, 8]).buffer); expect(sent).toEqual({ path: "p", data: [9, 8] });
    await ipc.adapterWrite("p", new Uint8Array([7])); expect(sent.data).toEqual([7]);
    const ab = await ipc.fsReadBinary("p"); expect(ab).toBeInstanceOf(ArrayBuffer); expect(Array.from(new Uint8Array(ab))).toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(toArrayBuffer([4, 5])))).toEqual([4, 5]); expect(bytes([1])).toEqual([1]);
    expect(() => toArrayBuffer("nope")).toThrow();
  });
  it("string errors from the backend become Error objects", async () => {
    setBackend(async () => { throw "no vault open"; });
    await expect(ipc.vaultInfo()).rejects.toThrow("no vault open");
    await expect(ipc.vaultInfo()).rejects.toBeInstanceOf(Error);
  });
  it("defaults to window.__TAURI__.core.invoke and event.listen('vault-event') (fresh module, no setBackend)", async () => {
    const invoke = vi.fn(async () => ["x"]);
    (globalThis as any).__TAURI__ = { core: { invoke }, event: { listen: vi.fn(async (_e: string, cb: any) => { cb({ payload: { kind: "modify", path: "a.md" } }); return () => {}; }) } };
    vi.resetModules();
    const fresh = await import("../src/ipc");
    expect(await fresh.ipc.vaultsRecent()).toEqual(["x"]); expect(invoke).toHaveBeenCalledWith("vaults_recent", undefined);
    await fresh.ipc.fsRead("n.md"); expect(invoke).toHaveBeenLastCalledWith("fs_read", { path: "n.md" });
    const seen: any[] = []; const un = await fresh.listen("vault-event", (ev) => seen.push(ev)); expect(seen).toEqual([{ kind: "modify", path: "a.md" }]); expect(typeof un).toBe("function");
    delete (globalThis as any).__TAURI__;
    await expect(fresh.ipc.vaultInfo()).rejects.toThrow(/Tauri backend not available/);
  });
});
