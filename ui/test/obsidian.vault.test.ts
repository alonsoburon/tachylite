import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeApp, makeVault, type FakeVault } from "./helpers/backend";
import { TFile, TFolder, TAbstractFile } from "../src/obsidian";
import type { App } from "../src/obsidian/app";

let v: FakeVault, app: App;
beforeEach(async () => {
  v = makeVault({
    "Home.md": "---\ntags: [a, b]\nalias: Start\n---\n# Home\nSee [[Note]] and [[folder/Deep]] #tag1\n",
    "Note.md": "# Note\nback to [[Home]] and [[Missing]]\n",
    "folder/Deep.md": "deep [[Home]]",
    "img.png": "x",
  });
  app = await makeApp(v);
});
afterEach(async () => { await app.stop(); v.cleanup(); });

describe("Vault tree", () => {
  it("builds TFile/TFolder with parent, name, basename, extension, stat", () => {
    const home = app.vault.getAbstractFileByPath("Home.md")!;
    expect(home).toBeInstanceOf(TFile);
    const f = home as TFile;
    expect(f.name).toBe("Home.md");
    expect(f.basename).toBe("Home");
    expect(f.extension).toBe("md");
    expect(f.stat.size).toBeGreaterThan(0);
    expect(f.parent).toBe(app.vault.getRoot());
    expect(app.vault.getRoot().isRoot()).toBe(true);
    expect(app.vault.getRoot().path).toBe("/");
    const deep = app.vault.getFileByPath("folder/Deep.md")!;
    expect(deep.parent).toBeInstanceOf(TFolder);
    expect(deep.parent!.name).toBe("folder");
    expect(deep.parent!.children).toContain(deep);
    expect(deep).toBeInstanceOf(TAbstractFile);
    expect(app.vault.getFolderByPath("folder")).toBe(deep.parent);
    expect(app.vault.getFileByPath("folder")).toBeNull();
  });
  it("getFiles / getMarkdownFiles / name / config dir", () => {
    expect(app.vault.getFiles().map((f) => f.path).sort()).toEqual(["Home.md", "Note.md", "folder/Deep.md", "img.png"]);
    expect(app.vault.getMarkdownFiles()).toHaveLength(3);
    expect(app.vault.configDir).toBe(".obsidian");
    expect(app.vault.getName()).toBe(path.basename(v.root));
  });
  it("read/cachedRead/readBinary", async () => {
    const f = app.vault.getFileByPath("Note.md")!;
    expect(await app.vault.read(f)).toContain("# Note");
    await app.vault.cachedRead(f); await app.vault.cachedRead(f);
    expect(v.calls.filter((c) => c.cmd === "fs_read" && c.args.path === "Note.md")).toHaveLength(2); // read + one cachedRead fetch
    const bin = await app.vault.readBinary(app.vault.getFileByPath("img.png")!);
    expect(new Uint8Array(bin)[0]).toBe(120);
  });
  it("modify fires 'modify' after the write and updates stat", async () => {
    const f = app.vault.getFileByPath("Note.md")!;
    const seen: string[] = [];
    app.vault.on("modify", (x: TAbstractFile) => seen.push(fs.readFileSync(path.join(v.root, x.path), "utf8")));
    await app.vault.modify(f, "changed!");
    expect(seen).toEqual(["changed!"]);
    expect(f.stat.size).toBe(8);
    expect(await app.vault.cachedRead(f)).toBe("changed!");
  });
  it("create / createFolder / createBinary and 'create' events", async () => {
    const created: string[] = [];
    app.vault.on("create", (f: TAbstractFile) => created.push(f.path));
    const f = await app.vault.create("new/dir/X.md", "hi");
    expect(f.parent!.path).toBe("new/dir");
    await app.vault.createFolder("emptyDir");
    await app.vault.createBinary("b.bin", new Uint8Array([1, 2, 3]).buffer);
    expect(created).toEqual(["new/dir/X.md", "emptyDir", "b.bin"]);
    await expect(app.vault.create("new/dir/X.md", "again")).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(path.join(v.root, "new/dir/X.md"), "utf8")).toBe("hi");
  });
  it("append / process", async () => {
    const f = await app.vault.create("p.md", "a");
    await app.vault.append(f, "b");
    expect(await app.vault.read(f)).toBe("ab");
    expect(await app.vault.process(f, (d) => d.toUpperCase())).toBe("AB");
    expect(await app.vault.read(f)).toBe("AB");
  });
  it("rename moves the node, fires 'rename'(file, oldPath), keeps instanceof", async () => {
    const f = app.vault.getFileByPath("Note.md")!;
    const ev: [string, string][] = [];
    app.vault.on("rename", (x: TAbstractFile, old: string) => ev.push([x.path, old]));
    await app.vault.rename(f, "sub/Renamed.md");
    expect(ev).toEqual([["sub/Renamed.md", "Note.md"]]);
    expect(f.path).toBe("sub/Renamed.md");
    expect(f.basename).toBe("Renamed");
    expect(f.parent!.path).toBe("sub");
    expect(app.vault.getAbstractFileByPath("Note.md")).toBeNull();
    expect(app.vault.getFileByPath("sub/Renamed.md")).toBe(f);
    expect(fs.existsSync(path.join(v.root, "sub/Renamed.md"))).toBe(true);
  });
  it("rename folder updates descendants", async () => {
    const folder = app.vault.getFolderByPath("folder")!;
    await app.vault.rename(folder, "moved");
    expect(app.vault.getFileByPath("moved/Deep.md")).not.toBeNull();
    expect(app.vault.getAbstractFileByPath("folder/Deep.md")).toBeNull();
  });
  it("delete/trash fire 'delete' (children first) and detach", async () => {
    const del: string[] = [];
    app.vault.on("delete", (x: TAbstractFile) => del.push(x.path));
    await app.vault.delete(app.vault.getFolderByPath("folder")!);
    expect(del).toEqual(["folder/Deep.md", "folder"]);
    await app.vault.trash(app.vault.getFileByPath("img.png")!, false);
    expect(app.vault.getFileByPath("img.png")).toBeNull();
    expect(app.vault.getRoot().children.map((c) => c.name).sort()).toEqual(["Home.md", "Note.md"]);
  });
  it("external changes via backend events are diffed into create/modify/delete", async () => {
    const log: string[] = [];
    for (const n of ["create", "modify", "delete"]) app.vault.on(n, (f: TAbstractFile) => log.push(`${n}:${f.path}`));
    fs.writeFileSync(path.join(v.root, "ext.md"), "e");
    fs.writeFileSync(path.join(v.root, "Home.md"), "now different and longer content");
    fs.rmSync(path.join(v.root, "img.png"));
    await app.vault.sync();
    expect(log.sort()).toEqual(["create:ext.md", "delete:img.png", "modify:Home.md"]);
  });
  it("process() and sibling helpers are static-safe: recurseChildren", () => {
    const seen: string[] = [];
    (app.vault.constructor as any).recurseChildren(app.vault.getRoot(), (f: TAbstractFile) => seen.push(f.path));
    expect(seen.sort()).toEqual(["Home.md", "Note.md", "folder", "folder/Deep.md", "img.png"]);
  });
  it("getConfig/setConfig persist to .obsidian/app.json with defaults", async () => {
    expect(app.vault.getConfig("useMarkdownLinks")).toBe(false);
    expect(app.vault.getConfig("tabSize")).toBe(4);
    app.vault.setConfig("useMarkdownLinks", true);
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(v.root, ".obsidian/app.json"), "utf8")).useMarkdownLinks).toBe(true));
    expect(app.vault.getConfig("useMarkdownLinks")).toBe(true);
  });
});

describe("DataAdapter", () => {
  const a = () => app.vault.adapter;
  it("exists/read/write/list/stat/remove/mkdir/rmdir/append/readBinary/writeBinary", async () => {
    expect(await a().exists(".obsidian")).toBe(true);
    await a().mkdir(".obsidian/x/y");
    await a().write(".obsidian/x/y/f.txt", "hello");
    expect(await a().read(".obsidian/x/y/f.txt")).toBe("hello");
    await a().append(".obsidian/x/y/f.txt", " world");
    expect(await a().read(".obsidian/x/y/f.txt")).toBe("hello world");
    expect(await a().list(".obsidian/x")).toEqual({ files: [], folders: [".obsidian/x/y"] });
    expect((await a().list(".obsidian/x/y")).files).toEqual([".obsidian/x/y/f.txt"]);
    expect((await a().stat(".obsidian/x/y/f.txt"))!.type).toBe("file");
    expect((await a().stat(".obsidian/x/y"))!.type).toBe("folder");
    expect(await a().stat(".obsidian/nope")).toBeNull();
    await a().writeBinary(".obsidian/x/b.bin", new Uint8Array([9, 8]).buffer);
    expect(Array.from(new Uint8Array(await a().readBinary(".obsidian/x/b.bin")))).toEqual([9, 8]);
    expect(await a().process(".obsidian/x/y/f.txt", (d) => d + "!")).toBe("hello world!");
    await a().remove(".obsidian/x/y/f.txt");
    expect(await a().exists(".obsidian/x/y/f.txt")).toBe(false);
    await a().rmdir(".obsidian/x", true);
    expect(await a().exists(".obsidian/x")).toBe(false);
  });
  it("stat of an indexed file uses the vault stat; base path & resource path", async () => {
    const st = await a().stat("Home.md");
    expect(st!.size).toBe(app.vault.getFileByPath("Home.md")!.stat.size);
    expect((a() as any).getBasePath()).toBe(v.root);
    expect(a().getResourcePath("Home.md")).toMatch(/Home\.md\?\d+/);
    expect(app.vault.getResourcePath(app.vault.getFileByPath("Home.md")!)).toContain("Home.md");
  });
  it("copy and rename of non-indexed paths", async () => {
    await a().write(".obsidian/c1.txt", "z");
    await a().copy(".obsidian/c1.txt", ".obsidian/c2.txt");
    await a().rename(".obsidian/c2.txt", ".obsidian/c3.txt");
    expect(await a().read(".obsidian/c3.txt")).toBe("z");
    expect(await a().exists(".obsidian/c2.txt")).toBe(false);
  });
});

describe("MetadataCache", () => {
  it("serves CachedMetadata synchronously after start()", () => {
    const home = app.vault.getFileByPath("Home.md")!;
    const c = app.metadataCache.getFileCache(home)!;
    expect(c.frontmatter).toMatchObject({ tags: ["a", "b"] });
    expect(c.links!.map((l) => l.link)).toEqual(["Note", "folder/Deep"]);
    expect(c.headings![0]).toMatchObject({ heading: "Home", level: 1 });
    expect(app.metadataCache.getCache("Home.md")).toBe(c);
    expect(app.metadataCache.getFileCache(app.vault.getFileByPath("img.png")!)).toBeNull();
  });
  it("resolvedLinks / unresolvedLinks", () => {
    expect(app.metadataCache.resolvedLinks["Home.md"]).toEqual({ "Note.md": 1, "folder/Deep.md": 1 });
    expect(app.metadataCache.unresolvedLinks["Note.md"]).toEqual({ Missing: 1 });
  });
  it("getFirstLinkpathDest: name, path, ext-less, case-insensitive, closest", async () => {
    const mc = app.metadataCache;
    expect(mc.getFirstLinkpathDest("Note", "Home.md")!.path).toBe("Note.md");
    expect(mc.getFirstLinkpathDest("note", "Home.md")!.path).toBe("Note.md");
    expect(mc.getFirstLinkpathDest("Deep", "Home.md")!.path).toBe("folder/Deep.md");
    expect(mc.getFirstLinkpathDest("folder/Deep", "Home.md")!.path).toBe("folder/Deep.md");
    expect(mc.getFirstLinkpathDest("img.png", "Home.md")!.path).toBe("img.png");
    expect(mc.getFirstLinkpathDest("Nope", "Home.md")).toBeNull();
    await app.vault.create("folder/Home.md", "dup");
    expect(mc.getFirstLinkpathDest("Home", "folder/Deep.md")!.path).toBe("folder/Home.md"); // closest to source
    expect(mc.getFirstLinkpathDest("Home", "Note.md")!.path).toBe("Home.md");
  });
  it("getFirstLinkpathDest ignores Unicode normalization form", async () => {
    await app.vault.create("Cafe\u0301.md", "x");
    const hit = (l: string) => app.metadataCache.getFirstLinkpathDest(l, "Home.md")?.name.normalize("NFC");
    expect(hit("Caf\u00e9")).toBe("Caf\u00e9.md");
    expect(hit("Cafe\u0301")).toBe("Caf\u00e9.md");
    expect(hit("CAFE\u0301")).toBe("Caf\u00e9.md");
  });
  it("fileToLinktext gives the shortest unambiguous link", async () => {
    const mc = app.metadataCache;
    expect(mc.fileToLinktext(app.vault.getFileByPath("folder/Deep.md")!, "Home.md")).toBe("Deep");
    expect(mc.fileToLinktext(app.vault.getFileByPath("Home.md")!, "Note.md", false)).toBe("Home.md");
    expect(mc.fileToLinktext(app.vault.getFileByPath("img.png")!, "Home.md")).toBe("img.png");
    await app.vault.create("folder/Home.md", "dup");
    expect(mc.fileToLinktext(app.vault.getFileByPath("folder/Home.md")!, "Note.md")).toBe("folder/Home");
  });
  it("getTags merges tags that differ only in case", async () => {
    await app.vault.create("Cased1.md", "#Zed #Zed #zed");
    await app.vault.create("Cased2.md", "#ZED");
    await vi.waitFor(() => expect(app.metadataCache.getTags()["#Zed"]).toBe(4));
    expect(Object.keys(app.metadataCache.getTags()).filter((t) => t.toLowerCase() === "#zed")).toEqual(["#Zed"]);
  });
  it("getTags", () => {
    expect(app.metadataCache.getTags()).toMatchObject({ "#tag1": 1, "#a": 1, "#b": 1 });
  });
  it("modify triggers 'changed'(file, data, cache) then 'resolve' then 'resolved'", async () => {
    const order: string[] = [];
    const mc = app.metadataCache;
    mc.on("changed", (f: TFile, data: string, cache: any) => order.push(`changed:${f.path}:${data}:${cache.links?.[0]?.link}`));
    mc.on("resolve", (f: TFile) => order.push(`resolve:${f.path}`));
    mc.on("resolved", () => order.push("resolved"));
    await app.vault.modify(app.vault.getFileByPath("Note.md")!, "[[Deep]] new");
    await mc.flush();
    expect(order).toEqual(["changed:Note.md:[[Deep]] new:Deep", "resolve:Note.md", "resolved"]);
    expect(mc.getFileCache(app.vault.getFileByPath("Note.md")!)!.links![0].link).toBe("Deep");
    expect(mc.resolvedLinks["Note.md"]).toEqual({ "folder/Deep.md": 1 });
  });
  it("delete triggers 'deleted'(file, prevCache) and rename moves the cache", async () => {
    const mc = app.metadataCache;
    const del: any[] = [];
    mc.on("deleted", (f: TFile, prev: any) => del.push([f.path, prev?.headings?.[0]?.heading]));
    const note = app.vault.getFileByPath("Note.md")!;
    await app.vault.rename(note, "Renamed.md");
    expect(mc.getFileCache(note)!.headings![0].heading).toBe("Note");
    await app.vault.delete(note);
    expect(del).toEqual([["Renamed.md", "Note"]]);
    expect(mc.getFileCache(note)).toBeNull();
  });
  it("getBacklinksForFile", () => {
    const b = app.metadataCache.getBacklinksForFile(app.vault.getFileByPath("Home.md")!);
    expect(b.keys().sort()).toEqual(["Note.md", "folder/Deep.md"]);
  });
});

describe("FileManager", () => {
  it("processFrontMatter edits, adds and removes front matter", async () => {
    const f = app.vault.getFileByPath("Home.md")!;
    await app.fileManager.processFrontMatter(f, (fm) => { fm.status = "done"; fm.tags.push("c"); delete fm.alias; });
    const text = await app.vault.read(f);
    expect(text).toMatch(/^---\ntags:\n  - a\n  - b\n  - c\nstatus: done\n---\n# Home/);
    const n = app.vault.getFileByPath("Note.md")!;
    await app.fileManager.processFrontMatter(n, (fm) => { fm.x = 1; });
    expect(await app.vault.read(n)).toMatch(/^---\nx: 1\n---\n# Note/);
    await app.fileManager.processFrontMatter(n, (fm) => { delete fm.x; });
    expect(await app.vault.read(n)).toMatch(/^# Note/);
  });
  it("generateMarkdownLink: wiki, markdown, subpath, alias, embeds", () => {
    const fm = app.fileManager, d = app.vault.getFileByPath("folder/Deep.md")!, img = app.vault.getFileByPath("img.png")!;
    expect(fm.generateMarkdownLink(d, "Home.md")).toBe("[[Deep]]");
    expect(fm.generateMarkdownLink(d, "Home.md", "#Head", "alias")).toBe("[[Deep#Head|alias]]");
    expect(fm.generateMarkdownLink(img, "Home.md")).toBe("![[img.png]]");
    app.vault.config.useMarkdownLinks = true;
    expect(fm.generateMarkdownLink(d, "Home.md")).toBe("[Deep](Deep.md)"); // "shortest path when possible"
    app.vault.config.newLinkFormat = "absolute";
    expect(fm.generateMarkdownLink(d, "Home.md")).toBe("[Deep](folder/Deep.md)");
    app.vault.config.newLinkFormat = "relative";
    expect(fm.generateMarkdownLink(app.vault.getFileByPath("Note.md")!, "folder/Deep.md")).toBe("[Note](../Note.md)");
  });
  it("renameFile delegates to the core rename; trashFile removes; getNewFileParent honours config", async () => {
    const note = app.vault.getFileByPath("Note.md")!;
    await app.fileManager.renameFile(note, "N2.md");
    expect(v.calls.some((c) => c.cmd === "fs_rename" && c.args.from === "Note.md" && c.args.to === "N2.md")).toBe(true);
    expect(app.fileManager.getNewFileParent("folder/Deep.md").isRoot()).toBe(true);
    app.vault.config.newFileLocation = "current";
    expect(app.fileManager.getNewFileParent("folder/Deep.md").path).toBe("folder");
    app.vault.config.newFileLocation = "folder"; app.vault.config.newFileFolderPath = "folder";
    expect(app.fileManager.getNewFileParent("Home.md").path).toBe("folder");
    await app.fileManager.trashFile(note);
    expect(app.vault.getAbstractFileByPath("N2.md")).toBeNull();
  });
  it("getAvailablePathForAttachment avoids collisions", async () => {
    expect(await app.fileManager.getAvailablePathForAttachment("img.png")).toBe("img 1.png");
    expect(await app.fileManager.getAvailablePathForAttachment("new.png")).toBe("new.png");
  });
});
