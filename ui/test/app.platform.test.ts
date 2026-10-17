// Platform polish: OS detection, native paths and resource URLs, `tachylite://` URIs (parser, vault matching,
// built-in actions, plugin handlers, launch URIs) and native menu commands, against the fake backend.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { detectOS, Platform } from "../src/obsidian/events";
import { fileUrl, joinNative } from "../src/obsidian/vault";
import { dispatchUri, handleUri, matchVault, parseUri, relativeTo, vaultForUri } from "../src/app/uri";
import { installBodyClasses } from "../src/app/platform";

let v: FakeVault;
let session: Session | null = null;
const q = (s: string) => document.querySelector<HTMLElement>(s);
const noticeText = () => [...document.querySelectorAll(".notice")].map((n) => n.textContent).join("\n");

async function boot(): Promise<Session> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  session = await startSession((await v.backend("vault_info")) as any, host);
  return session;
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
  v = makeVault({ "Note.md": "# Note\n\n## Part\nbody\n", "folder/Deep note.md": "deep\n", "Log.md": "line 1\n" });
});
afterEach(async () => {
  await session?.stop();
  session = null;
  v.cleanup();
  document.body.innerHTML = "";
});

describe("platform detection and paths", () => {
  it("prefers the OS the shell injects, then the user agent", () => {
    expect(detectOS("macos", "X11; Linux", "Linux x86_64")).toBe("macos");
    expect(detectOS("windows", "", "")).toBe("windows");
    expect(detectOS(undefined, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", "MacIntel")).toBe("macos");
    expect(detectOS(undefined, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/120", "Win32")).toBe("windows");
    expect(detectOS(undefined, "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15", "Linux x86_64")).toBe("linux");
    expect([Platform.isMacOS, Platform.isWin, Platform.isLinux].filter(Boolean)).toHaveLength(1);
  });

  it("joins vault paths with the native separator and builds file:// URLs", () => {
    expect(joinNative("/home/me/Vault", "a/b.md")).toBe("/home/me/Vault/a/b.md");
    expect(joinNative("/home/me/Vault/", "/")).toBe("/home/me/Vault");
    expect(joinNative("C:\\Users\\me\\Vault", "a/b.md")).toBe("C:\\Users\\me\\Vault\\a\\b.md");
    expect(joinNative("C:\\", "a.md")).toBe("C:\\a.md");
    expect(joinNative("C:\\", "/")).toBe("C:\\");
    expect(joinNative("\\\\server\\share\\Vault", "x.md")).toBe("\\\\server\\share\\Vault\\x.md");
    expect(fileUrl("/home/me/My Vault/a#b?c%d é.md")).toBe("file:///home/me/My%20Vault/a%23b%3Fc%25d%20%C3%A9.md");
    expect(fileUrl("C:\\Users\\me\\Vault\\a b.md")).toBe("file:///C:/Users/me/Vault/a%20b.md");
    expect(fileUrl("\\\\server\\share\\x.md")).toBe("file://server/share/x.md");
  });

  it("encodes resource URLs like Tauri's convertFileSrc (#, ?, %, spaces, unicode)", async () => {
    v.write("img/a #1 ?50% é.png", "x");
    const s = await boot();
    const url = s.app.vault.adapter.getResourcePath("img/a #1 ?50% é.png");
    expect(url.startsWith(Platform.resourcePathPrefix)).toBe(true);
    const [enc, mtime] = url.slice(Platform.resourcePathPrefix.length).split("?");
    expect(decodeURIComponent(enc)).toBe(path.join(v.root, "img/a #1 ?50% é.png"));
    expect(Number(mtime)).toBeGreaterThan(0);
    expect(s.app.vault.adapter.getFilePath("Note.md")).toBe("file://" + path.join(v.root, "Note.md"));
  });

  it("puts the OS and window-focus classes on body", () => {
    const off = installBodyClasses();
    expect(["mod-macos", "mod-windows", "mod-linux"].filter((c) => document.body.classList.contains(c))).toHaveLength(1);
    window.dispatchEvent(new Event("blur"));
    expect(document.body.classList.contains("is-focused")).toBe(document.hasFocus());
    off();
  });
});

describe("tachylite:// URI parsing", () => {
  it("decodes actions and parameters the way obsidian:// URIs are", () => {
    expect(parseUri("tachylite://open?vault=my%20vault&file=a%2Fb%20c")).toEqual({ action: "open", vault: "my vault", file: "a/b c" });
    expect(parseUri("tachylite://new?name=x&silent&content=a%26b#frag")).toEqual({ action: "new", name: "x", silent: "true", content: "a&b", hash: "frag" });
    expect(parseUri("tachylite://my-plugin-action/?x=1")).toEqual({ action: "my-plugin-action", x: "1" });
    expect(parseUri("TACHYLITE://search?query=tag%3A%23x")).toEqual({ action: "search", query: "tag:#x" });
    expect(parseUri("tachylite://vault/My%20Vault/folder/Deep%20note")).toEqual({ action: "open", vault: "My Vault", file: "folder/Deep note" });
    expect(parseUri("tachylite:///home/me/Vault/a%20b.md")).toEqual({ action: "open", path: "/home/me/Vault/a b.md" });
    expect(parseUri("tachylite:///C:/Vault/a.md", true)).toEqual({ action: "open", path: "C:/Vault/a.md" });
    expect(parseUri("tachylite://open?bad=%E0%A4%A")).toEqual({ action: "open", bad: "%E0%A4%A" });
    expect(parseUri("https://example.com")).toBeNull();
  });

  it("matches vaults by name, path or containing path", () => {
    const cur = { name: "Work", path: "/v/Work" };
    const recents = ["/v/Work", "/v/Home", "/v/Home/Nested"];
    let p = parseUri("tachylite://open?vault=work&file=x")!;
    expect(matchVault(p, cur, recents, false)).toEqual({ current: true });
    expect(p.vault).toBeUndefined();
    p = parseUri("tachylite://open?vault=Home&file=x")!;
    expect(matchVault(p, cur, recents, false)).toEqual({ current: false, path: "/v/Home" });
    p = parseUri("tachylite://open?vault=%2Fv%2FHome%2FNested")!;
    expect(matchVault(p, cur, recents, false)).toEqual({ current: false, path: "/v/Home/Nested" });
    p = parseUri("tachylite:///v/Home/Nested/sub/n.md")!;
    expect(matchVault(p, cur, recents, false)).toEqual({ current: false, path: "/v/Home/Nested" });
    expect(p).toEqual({ action: "open", file: "sub/n.md" });
    expect(matchVault(parseUri("tachylite://open?vault=Nope")!, cur, recents, false)).toBeNull();
    expect(matchVault(parseUri("tachylite:///elsewhere/x.md")!, cur, recents, false)).toBeNull();
    expect(relativeTo("C:\\V\\Work", "c:/v/work/A.md", true)).toBe("A.md");
    expect(relativeTo("/v/Work", "/v/work/A.md", false)).toBeNull();
    expect(vaultForUri("tachylite://open?vault=Home", recents)).toBe("/v/Home");
    expect(vaultForUri("tachylite://new?name=x", recents)).toBeNull();
  });
});

describe("tachylite:// URI actions (fake backend)", () => {
  it("opens a file (with heading subpath) in the named vault", async () => {
    const s = await boot();
    const name = path.basename(v.root);
    expect(await handleUri(s.app, `tachylite://open?vault=${encodeURIComponent(name)}&file=Note%23Part`)).toBe(true);
    expect(s.app.workspace.getActiveFile()?.path).toBe("Note.md");
    await handleUri(s.app, `tachylite://vault/${encodeURIComponent(name)}/folder/Deep%20note`);
    expect(s.app.workspace.getActiveFile()?.path).toBe("folder/Deep note.md");
    await handleUri(s.app, `tachylite://${encodeURI(v.root)}/Log.md`.replace("tachylite:///", "tachylite:///"));
    expect(s.app.workspace.getActiveFile()?.path).toBe("Log.md");
    await handleUri(s.app, `tachylite://open?file=Missing`);
    expect(noticeText()).toContain("File not found");
  });

  it("creates, appends, prepends and overwrites notes with new", async () => {
    const s = await boot();
    await handleUri(s.app, "tachylite://new?name=Inbox&content=hello%20world");
    expect(fs.readFileSync(path.join(v.root, "Inbox.md"), "utf8")).toBe("hello world");
    expect(s.app.workspace.getActiveFile()?.path).toBe("Inbox.md");
    await handleUri(s.app, "tachylite://new?file=Log&content=line%202&append");
    expect(fs.readFileSync(path.join(v.root, "Log.md"), "utf8")).toBe("line 1\nline 2");
    await handleUri(s.app, "tachylite://new?file=Log&content=line%200&prepend&silent");
    expect(fs.readFileSync(path.join(v.root, "Log.md"), "utf8")).toBe("line 0\nline 1\nline 2");
    await handleUri(s.app, "tachylite://new?file=Log&content=fresh&overwrite");
    expect(fs.readFileSync(path.join(v.root, "Log.md"), "utf8")).toBe("fresh");
    await handleUri(s.app, "tachylite://new?file=projects%2FPlan&content=p");
    expect(fs.readFileSync(path.join(v.root, "projects/Plan.md"), "utf8")).toBe("p");
    // an existing name without append/overwrite gets a fresh file, like the app does
    await handleUri(s.app, "tachylite://new?name=Inbox&content=second&silent");
    expect(fs.readFileSync(path.join(v.root, "Inbox 1.md"), "utf8")).toBe("second");
    await handleUri(s.app, "tachylite://new?file=..%2Fescape&content=x");
    expect(fs.existsSync(path.join(v.root, "..", "escape.md"))).toBe(false);
  });

  it("runs search, daily, plugin handlers and reports unknown actions", async () => {
    const s = await boot();
    await handleUri(s.app, "tachylite://search?query=body");
    const search = s.app.workspace.getLeavesOfType("search")[0]?.view as any;
    expect(search.query ?? search.inputEl?.value).toBe("body");
    const seen: any[] = [];
    s.app.protocolHandlers["my-action"] = (p) => { seen.push(p); };
    await handleUri(s.app, "tachylite://my-action?x=1&flag");
    expect(seen).toEqual([{ action: "my-action", x: "1", flag: "true" }]);
    expect(await dispatchUri(s.app, { action: "nope" })).toBe(false);
    expect(noticeText()).toContain('Unknown Tachylite URI action "nope"');
    // a bare open just focuses the app
    expect(await dispatchUri(s.app, { action: "open" })).toBe(true);
    await s.app.internalPlugins.getPluginById("daily-notes")!.disable(); // on by default, as in Obsidian
    await handleUri(s.app, "tachylite://daily");
    expect(noticeText()).toContain("Daily notes is turned off");
  });

  it("switches to the recent vault a URI names, carrying the URI across the reload", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "Other Vault-"));
    v.recents.push(other);
    const s = await boot();
    const sw = vi.fn();
    expect(await handleUri(s.app, `tachylite://open?vault=${encodeURIComponent(path.basename(other))}&file=x`, sw)).toBe(true);
    expect(sw).toHaveBeenCalledWith(other, expect.stringContaining("file=x"));
    await handleUri(s.app, "tachylite://open?vault=Unknown%20Vault&file=x", sw);
    expect(sw).toHaveBeenCalledTimes(1);
    expect(noticeText()).toContain("Vault not found");
    fs.rmSync(other, { recursive: true, force: true });
  });

  it("handles launch URIs once the layout is ready and URIs forwarded later", async () => {
    v.openUrl(`tachylite://open?file=Note`);
    const s = await boot();
    await vi.waitFor(() => expect(s.app.workspace.getActiveFile()?.path).toBe("Note.md"));
    v.openUrl("tachylite://open?file=Log");
    await vi.waitFor(() => expect(s.app.workspace.getActiveFile()?.path).toBe("Log.md"));
    sessionStorage.setItem("tachylite-uri", JSON.stringify(["tachylite://open?file=folder%2FDeep%20note"]));
    await session!.stop();
    session = null;
    const s2 = await boot();
    await vi.waitFor(() => expect(s2.app.workspace.getActiveFile()?.path).toBe("folder/Deep note.md"));
    expect(sessionStorage.getItem("tachylite-uri")).toBeNull();
  });

  it("dispatches native menu items to commands and copies a file's URI", async () => {
    const s = await boot();
    const left = s.app.workspace.leftSplit.collapsed;
    v.emitEvent("menu-command", "app:toggle-left-sidebar");
    expect(s.app.workspace.leftSplit.collapsed).toBe(!left);
    const file = s.app.vault.getFileByPath("folder/Deep note.md")!;
    expect(s.app.getObsidianUrl(file)).toBe(`tachylite://open?vault=${encodeURIComponent(path.basename(v.root))}&file=folder%2FDeep%20note`);
    expect(parseUri(s.app.getObsidianUrl(file))).toMatchObject({ action: "open", file: "folder/Deep note" });
    expect(q(".workspace")).toBeTruthy();
  });
});
