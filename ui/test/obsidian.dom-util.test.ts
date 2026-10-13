import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  normalizePath, debounce, parseYaml, stringifyYaml, parseLinktext, getLinkpath, stripHeading, stripHeadingForLink, resolveSubpath, getAllTags,
  getFrontMatterInfo, parseFrontMatterEntry, parseFrontMatterAliases, parseFrontMatterTags, parseFrontMatterStringArray, sanitizeHTMLToDom, htmlToMarkdown,
  prepareFuzzySearch, prepareSimpleSearch, renderResults, sortSearchResults, setIcon, getIcon, addIcon, removeIcon, getIconIds, apiVersion, requireApiVersion,
  moment, Platform, Keymap, arrayBufferToBase64, base64ToArrayBuffer, arrayBufferToHex, hexToArrayBuffer, iterateRefs, Scope,
} from "../src/obsidian";

describe("global DOM helpers", () => {
  it("createEl/createDiv/createSpan/createSvg/createFragment with DomElementInfo", () => {
    const parent = createDiv({ cls: ["a", "b"], attr: { "data-x": 1, hidden: null }, text: "hi", title: "T" });
    expect(parent.className).toBe("a b");
    expect(parent.getAttribute("data-x")).toBe("1");
    expect(parent.title).toBe("T");
    const kid = parent.createEl("input", { type: "text", value: "v", placeholder: "p", cls: "k" });
    expect(kid.value).toBe("v"); expect(kid.placeholder).toBe("p"); expect(kid.parentElement).toBe(parent);
    const first = parent.createSpan({ text: "first", prepend: true });
    expect(parent.firstChild).toBe(first);
    const a = createEl("a", { href: "http://x/", text: "x" });
    expect(a.getAttribute("href")).toBe("http://x/");
    const cb = vi.fn(); parent.createDiv("str-cls", cb);
    expect(parent.querySelector(".str-cls")).not.toBeNull(); expect(cb).toHaveBeenCalled();
    const svg = parent.createSvg("svg", { attr: { width: 10 } });
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    const frag = createFragment((f) => { f.createDiv({ text: "in frag" }); });
    expect(frag.textContent).toBe("in frag");
    expect(frag.find("div")!.textContent).toBe("in frag");
  });
  it("empty/detach/addClass/removeClass/toggleClass/hasClass/setAttr(s)/getAttr/setText/getText/appendText", () => {
    const el = createDiv();
    el.addClass("a", "b c"); expect(el.className).toBe("a b c");
    el.removeClass("b"); expect(el.hasClass("b")).toBe(false);
    el.addClasses(["x", "y"]); el.removeClasses(["x"]); expect(el.hasClass("y")).toBe(true);
    el.toggleClass("t", true); expect(el.hasClass("t")).toBe(true); el.toggleClass(["t", "u"], false); expect(el.hasClass("u")).toBe(false);
    el.setAttr("k", 5); expect(el.getAttr("k")).toBe("5"); el.setAttr("k", null); expect(el.getAttr("k")).toBeNull();
    el.setAttrs({ a: "1", b: true }); expect(el.getAttribute("b")).toBe("true");
    el.setText("hello"); el.appendText(" world"); expect(el.getText()).toBe("hello world");
    el.createDiv(); el.empty(); expect(el.childNodes.length).toBe(0);
    const host = createDiv(); const c = host.createDiv(); c.detach(); expect(host.children.length).toBe(0);
  });
  it("insertAfter/indexOf/setChildrenInPlace/matchParent/find/findAll/findAllSelf/instanceOf", () => {
    const p = createDiv(); const a = p.createDiv({ cls: "i", text: "1" }), b = p.createDiv({ cls: "i", text: "2" });
    const n = createDiv({ text: "n" }); p.insertAfter(n, a);
    expect(Array.from(p.children)).toEqual([a, n, b]); expect(p.indexOf(b)).toBe(2);
    p.insertAfter(createDiv({ text: "0" }), null); expect(p.firstElementChild!.textContent).toBe("0");
    p.setChildrenInPlace([b, a]); expect(Array.from(p.children)).toEqual([b, a]);
    expect(a.matchParent("div")).toBe(p);
    expect(p.find(".i")).toBe(b); expect(p.findAll(".i")).toEqual([b, a]);
    expect(a.findAllSelf(".i")).toEqual([a]);
    expect(a.instanceOf(HTMLDivElement)).toBe(true); expect(a.instanceOf(HTMLSpanElement as any)).toBe(false);
  });
  it("show/hide/toggle/isShown/setCssStyles/setCssProps", () => {
    const el = document.body.createDiv();
    el.hide(); expect(el.style.display).toBe("none"); expect(el.isShown()).toBe(false);
    el.show(); expect(el.isShown()).toBe(true); el.toggle(false); expect(el.style.display).toBe("none");
    el.setCssStyles({ color: "red" }); expect(el.style.color).toBe("red");
    el.setCssProps({ "--foo": "bar" }); expect(el.style.getPropertyValue("--foo")).toBe("bar");
    el.detach();
  });
  it("on/off delegated events, onClickEvent, trigger", () => {
    const root = document.body.createDiv(); const btn = root.createEl("button", { cls: "btn" }); const inner = btn.createSpan();
    const seen: any[] = [];
    const fn = function (this: HTMLElement, ev: Event, delegate: HTMLElement) { seen.push([ev.type, delegate === btn, this === btn]); };
    root.on("click", ".btn", fn);
    inner.click(); expect(seen).toEqual([["click", true, true]]);
    root.off("click", ".btn", fn); inner.click(); expect(seen).toHaveLength(1);
    const clicks = vi.fn(); btn.onClickEvent(clicks); btn.click(); expect(clicks).toHaveBeenCalledTimes(1);
    const evs = vi.fn(); btn.addEventListener("custom", evs); btn.trigger("custom"); expect(evs).toHaveBeenCalled();
    root.detach();
  });
  it("document.on works too", () => {
    const hit = vi.fn(); const d = document.body.createDiv({ cls: "dd" });
    document.on("click", ".dd", hit); d.click(); expect(hit).toHaveBeenCalled(); document.off("click", ".dd", hit); d.detach();
  });
  it("globals: sleep, nextFrame, fish, fishAll, isBoolean, activeWindow/activeDocument, ready", async () => {
    const t = Date.now(); await sleep(15); expect(Date.now() - t).toBeGreaterThanOrEqual(10);
    await nextFrame();
    const e = document.body.createDiv({ cls: "fishy" });
    expect(fish(".fishy")).toBe(e); expect(fishAll(".fishy")).toEqual([e]); e.detach();
    expect(isBoolean(true)).toBe(true); expect(isBoolean(1)).toBe(false);
    expect(activeDocument).toBe(document); expect(activeWindow).toBe(window);
    const r = vi.fn(); ready(r); expect(r).toHaveBeenCalled();
  });
  it("prototype extensions: Array/String/Object/Math/Number", () => {
    expect([1, 2, 3].first()).toBe(1); expect([1, 2, 3].last()).toBe(3); expect([].first()).toBeUndefined();
    expect([1, 2].contains(2)).toBe(true);
    const a = [1, 2, 3, 2]; a.remove(2); expect(a).toEqual([1, 3]);
    expect([1, 1, 2].unique()).toEqual([1, 2]); expect(Array.combine([[1], [2, 3]])).toEqual([1, 2, 3]);
    const s = [1, 2, 3, 4]; expect(s.shuffle().sort()).toEqual([1, 2, 3, 4]);
    expect([1, 2, 3, 2, 1].findLastIndex((x: number) => x === 2)).toBe(3);
    expect("foo".contains("oo")).toBe(true); expect("a{0}b{1}{0}".format("x", "y")).toBe("axby" + "x");
    expect(String.isString("x")).toBe(true); expect(Number.isNumber(NaN)).toBe(true);
    expect(Object.isEmpty({})).toBe(true); expect(Object.isEmpty({ a: 1 })).toBe(false);
    expect(Object.each({ a: 1, b: 2 }, (v) => v < 2)).toBe(false);
    expect(Math.clamp(10, 0, 5)).toBe(5); expect(Math.square(-3)).toBe(9);
    // not enumerable: must not leak into for..in
    const keys: string[] = []; for (const k in [1]) keys.push(k); expect(keys).toEqual(["0"]);
  });
});

describe("pure utilities", () => {
  it("normalizePath", () => {
    expect(normalizePath("/a//b\\c/")).toBe("a/b/c"); expect(normalizePath("")).toBe("/"); expect(normalizePath("/")).toBe("/");
    expect(normalizePath("a b")).toBe("a b"); expect(normalizePath("é")).toBe("é");
  });
  it("debounce: trailing, cancel, run, resetTimer", async () => {
    vi.useFakeTimers();
    const f = vi.fn(); const d = debounce(f, 100);
    d(1); d(2); vi.advanceTimersByTime(99); expect(f).not.toHaveBeenCalled(); vi.advanceTimersByTime(2); expect(f).toHaveBeenCalledTimes(1); expect(f).toHaveBeenCalledWith(2);
    d(3); d.cancel(); vi.advanceTimersByTime(500); expect(f).toHaveBeenCalledTimes(1);
    d(4); d.run(); expect(f).toHaveBeenLastCalledWith(4); vi.advanceTimersByTime(500); expect(f).toHaveBeenCalledTimes(2);
    const g = vi.fn(); const r = debounce(g, 100, true);
    r("a"); vi.advanceTimersByTime(80); r("b"); vi.advanceTimersByTime(80); expect(g).not.toHaveBeenCalled(); vi.advanceTimersByTime(30); expect(g).toHaveBeenCalledWith("b");
    vi.useRealTimers();
  });
  it("yaml round trip keeps date-like strings and block lists", () => {
    expect(parseYaml("a: 2020-01-01\nb: [x, y]")).toEqual({ a: "2020-01-01", b: ["x", "y"] });
    expect(stringifyYaml({ tags: ["a", "b"], n: 1 })).toBe("tags:\n  - a\n  - b\nn: 1\n");
    expect(() => parseYaml("a: [")).toThrow();
  });
  it("links and headings", () => {
    expect(parseLinktext("Note#Head")).toEqual({ path: "Note", subpath: "#Head" }); expect(parseLinktext("Note")).toEqual({ path: "Note", subpath: "" });
    expect(getLinkpath("a/b#c")).toBe("a/b");
    expect(stripHeading('foo!"#$%&()*+,.:;<=>?@^`{|}~\\/\\[\\]\\\\\r\nbar')).toBe("foo bar");
    expect(stripHeadingForLink("foo:#|^\\\r\n%%[[]]bar")).toBe("foo bar");
  });
  it("resolveSubpath for headings, nested headings, blocks", () => {
    const loc = (n: number) => ({ line: n, col: 0, offset: n * 10 });
    const pos = (n: number) => ({ start: loc(n), end: loc(n + 1) });
    const cache: any = { headings: [{ heading: "A", level: 1, position: pos(0) }, { heading: "Sub", level: 2, position: pos(2) }, { heading: "B", level: 1, position: pos(4) }], blocks: { abc: { id: "abc", position: pos(6) } }, listItems: [] };
    const h = resolveSubpath(cache, "#A")!; expect(h.type).toBe("heading"); expect(h.start.line).toBe(0); expect(h.end.line).toBe(4);
    expect(resolveSubpath(cache, "#a#sub")!.current.heading).toBe("Sub");
    expect(resolveSubpath(cache, "#B")!.end).toBeNull();
    expect(resolveSubpath(cache, "#^abc")!.type).toBe("block"); expect(resolveSubpath(cache, "#nope")).toBeNull();
  });
  it("front matter helpers", () => {
    const info = getFrontMatterInfo("---\nk: v\n---\nbody"); expect(info).toMatchObject({ exists: true, frontmatter: "k: v", from: 4, to: 8, contentStart: 13 });
    expect(getFrontMatterInfo("no fm").exists).toBe(false);
    expect(parseFrontMatterEntry({ Foo: 1 }, "foo")).toBe(1); expect(parseFrontMatterEntry({ bar: 2 }, /^b/)).toBe(2); expect(parseFrontMatterEntry(null, "x")).toBeNull();
    expect(parseFrontMatterTags({ tags: ["foo", "#bar"] })).toEqual(["#foo", "#bar"]); expect(parseFrontMatterTags({ tags: "baz" })).toEqual(["#baz"]); expect(parseFrontMatterTags({})).toBeNull();
    expect(parseFrontMatterAliases({ aliases: "a, b" })).toEqual(["a", "b"]); expect(parseFrontMatterAliases({ alias: ["x"] })).toEqual(["x"]);
    expect(parseFrontMatterStringArray({ k: ["a", 1] }, "k")).toEqual(["a", "1"]);
    expect(getAllTags({ tags: [{ tag: "#a", position: {} as any }], frontmatter: { tags: ["b", "a"] } })!.sort()).toEqual(["#a", "#b"]);
    expect(getAllTags({})).toBeNull();
    expect(iterateRefs([{ link: "a" } as any, { link: "b" } as any], (r) => r.link === "a")).toBe(true);
  });
  it("sanitizeHTMLToDom strips scripts/handlers/javascript: urls; htmlToMarkdown", () => {
    const f = sanitizeHTMLToDom('<p onclick="x()">ok<script>bad()</script><a href="javascript:alert(1)">l</a><img src=x onerror=y></p>');
    expect(f.querySelector("script")).toBeNull(); expect(f.querySelector("p")!.hasAttribute("onclick")).toBe(false);
    expect(f.querySelector("a")!.hasAttribute("href")).toBe(false); expect(f.querySelector("img")!.hasAttribute("onerror")).toBe(false);
    expect(htmlToMarkdown("<h2>T</h2><p>a <strong>b</strong> <em>c</em> <a href='u'>l</a></p><ul><li>x</li><li>y</li></ul><pre><code>c</code></pre>")).toBe("## T\n\na **b** *c* [l](u)\n\n- x\n- y\n\n```\nc\n```");
  });
  it("fuzzy and simple search + render", () => {
    const fz = prepareFuzzySearch("nte hm"); expect(fz("Note Home")).not.toBeNull(); expect(fz("zzz")).toBeNull(); expect(prepareFuzzySearch("")("x")).toEqual({ score: 0, matches: [] });
    const exact = prepareFuzzySearch("note")("Note")!, loose = prepareFuzzySearch("note")("N-o-t-e long")!;
    expect(exact.score).toBeGreaterThan(loose.score);
    const items = [{ match: loose }, { match: exact }]; sortSearchResults(items); expect(items[0].match).toBe(exact);
    const ss = prepareSimpleSearch("foo bar"); expect(ss("a bar foo")!.matches).toHaveLength(2); expect(ss("foo")).toBeNull();
    const el = createDiv(); renderResults(el, "Hello World", prepareSimpleSearch("wor")("Hello World")!);
    expect(el.innerHTML).toBe('Hello <span class="suggestion-highlight">Wor</span>ld');
  });
  it("icons: lucide ids, bare names, custom icons", () => {
    const svg = getIcon("lucide-search")!; expect(svg.tagName.toLowerCase()).toBe("svg"); expect(svg.classList.contains("svg-icon")).toBe(true);
    expect(getIcon("search")).not.toBeNull(); expect(getIcon("dice")).not.toBeNull(); expect(getIcon("definitely-not-an-icon")).toBeNull();
    addIcon("my-icon", '<circle cx="50" cy="50" r="40"/>'); expect(getIcon("my-icon")!.getAttribute("viewBox")).toBe("0 0 100 100");
    const host = createDiv(); setIcon(host, "my-icon"); expect(host.querySelector("svg circle")).not.toBeNull(); setIcon(host, "lucide-x"); expect(host.querySelectorAll("svg")).toHaveLength(1);
    removeIcon("my-icon"); expect(getIcon("my-icon")).toBeNull();
    expect(getIconIds()).toContain("lucide-search");
  });
  it("misc: apiVersion, requireApiVersion, moment, Platform, binary helpers", () => {
    expect(apiVersion).toBe("1.14.4"); expect(requireApiVersion("1.0.0")).toBe(true); expect(requireApiVersion("1.14.4")).toBe(true); expect(requireApiVersion("1.14.5")).toBe(false); expect(requireApiVersion("2.0")).toBe(false);
    expect(moment("2020-03-04").format("YYYY/MM/DD")).toBe("2020/03/04");
    expect(Platform.isDesktop).toBe(true); expect(Platform.isMobile).toBe(false); expect(Platform.isDesktopApp).toBe(true);
    expect([Platform.isMacOS, Platform.isWin, Platform.isLinux].filter(Boolean)).toHaveLength(1);
    const buf = new Uint8Array([1, 2, 255]).buffer; expect(arrayBufferToBase64(buf)).toBe("AQL/"); expect(Array.from(new Uint8Array(base64ToArrayBuffer("AQL/")))).toEqual([1, 2, 255]);
    expect(arrayBufferToHex(buf)).toBe("0102ff"); expect(Array.from(new Uint8Array(hexToArrayBuffer("0102ff")))).toEqual([1, 2, 255]);
  });
});

describe("Scope / Keymap", () => {
  const key = (k: string, o: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: k, cancelable: true, ...o });
  it("scope handlers match modifiers and keys; false stops and preventDefaults", () => {
    const km = new Keymap(); const scope = new Scope(); const fn = vi.fn(() => false); const other = vi.fn();
    const h = scope.register(["Mod", "Shift"], "k", fn); scope.register([], "Escape", other);
    km.pushScope(scope);
    const e1 = key("K", { ctrlKey: true, shiftKey: true, metaKey: Platform.isMacOS }); expect(km.handleEvent(e1)).toBe(Platform.isMacOS ? false : true);
    const e = key("k", Platform.isMacOS ? { metaKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true });
    expect(km.handleEvent(e)).toBe(true); expect(e.defaultPrevented).toBe(true);
    expect(km.handleEvent(key("k"))).toBe(false);
    km.handleEvent(key("Escape")); expect(other).toHaveBeenCalled();
    scope.unregister(h); expect(scope.keys).toHaveLength(1);
    km.popScope(scope); expect(km.handleEvent(key("Escape"))).toBe(false);
  });
  it("parent scopes are consulted; Keymap.isModEvent / isModifier", () => {
    const parent = new Scope(); const child = new Scope(parent); const hit = vi.fn(() => false); parent.register(null, "x", hit);
    const km = new Keymap(); km.pushScope(child); expect(km.handleEvent(key("x"))).toBe(true);
    const mod = Platform.isMacOS ? { metaKey: true } : { ctrlKey: true };
    expect(Keymap.isModEvent(new MouseEvent("click", mod))).toBe("tab");
    expect(Keymap.isModEvent(new MouseEvent("click", { ...mod, altKey: true }))).toBe("split");
    expect(Keymap.isModEvent(new MouseEvent("click", { ...mod, altKey: true, shiftKey: true }))).toBe("window");
    expect(Keymap.isModEvent(new MouseEvent("click"))).toBe(false); expect(Keymap.isModEvent(null)).toBe(false);
    expect(Keymap.isModifier(new MouseEvent("click", { shiftKey: true }), "Shift")).toBe(true);
  });
});
