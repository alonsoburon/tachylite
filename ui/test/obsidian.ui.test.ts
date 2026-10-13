import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApp, makeVault, type FakeVault } from "./helpers/backend";
import {
  Setting, SettingGroup, ToggleComponent, TextComponent, TextAreaComponent, DropdownComponent, SliderComponent, ButtonComponent, ExtraButtonComponent, ColorComponent,
  SearchComponent, ProgressBarComponent, MomentFormatComponent, ValueComponent, BaseComponent, PluginSettingTab, Notice, Modal, Menu, MenuItem, MenuSeparator, SuggestModal, FuzzySuggestModal,
  AbstractInputSuggest, ConfirmationModal, requestUrl, request, Plugin, MarkdownRenderer, MarkdownRenderChild, Component, Events, TFile,
} from "../src/obsidian";
import { setMarkdownRenderer } from "../src/obsidian/markdown";
import type { App } from "../src/obsidian/app";

let v: FakeVault, app: App;
beforeEach(async () => { v = makeVault({ "A.md": "# A", "B.md": "# B", "dir/C.md": "# C" }); app = await makeApp(v); });
afterEach(async () => { await app.stop(); v.cleanup(); document.body.innerHTML = ""; });

describe("Setting + components", () => {
  it("renders Obsidian's class structure", () => {
    const c = createDiv();
    const s = new Setting(c).setName("N").setDesc("D").setClass("extra");
    expect(s.settingEl.className).toBe("setting-item extra");
    expect(s.infoEl.className).toBe("setting-item-info"); expect(s.nameEl.className).toBe("setting-item-name"); expect(s.descEl.className).toBe("setting-item-description"); expect(s.controlEl.className).toBe("setting-item-control");
    expect([s.nameEl.textContent, s.descEl.textContent]).toEqual(["N", "D"]);
    s.setDesc(createFragment((f) => f.createEl("b", { text: "frag" }))); expect(s.descEl.innerHTML).toBe("<b>frag</b>");
    s.setHeading(); expect(s.settingEl.hasClass("setting-item-heading")).toBe(true);
    s.setDisabled(true); expect(s.settingEl.hasClass("is-disabled")).toBe(true);
    s.setErrorMessage("bad"); expect(s.settingEl.querySelector(".setting-item-error")!.textContent).toBe("bad"); s.setErrorMessage(null); expect(s.errorEl).toBeNull();
    s.setVisibility(false); expect(s.settingEl.style.display).toBe("none");
    s.clear(); expect(s.nameEl.textContent).toBe("");
  });
  it("toggle: checkbox-container, is-enabled, onChange, disabled", () => {
    const c = createDiv(); const seen: boolean[] = [];
    let t!: ToggleComponent;
    new Setting(c).addToggle((x) => { t = x; x.setValue(false).onChange((v) => seen.push(v)); });
    const el = c.querySelector(".checkbox-container") as HTMLElement;
    expect(el.classList.contains("is-enabled")).toBe(false); el.click(); expect(seen).toEqual([true]); expect(el.classList.contains("is-enabled")).toBe(true); expect(t.getValue()).toBe(true);
    t.setValue(false); expect(seen).toEqual([true]); // programmatic set does not fire onChange
    t.setDisabled(true); el.click(); expect(seen).toEqual([true]);
    expect(el.querySelector("input[type=checkbox]")).not.toBeNull();
  });
  it("text, textarea, search, moment format, dropdown, slider, color, progress, button, extra button", () => {
    const c = createDiv(); const got: Record<string, unknown> = {};
    new Setting(c)
      .addText((t) => t.setPlaceholder("ph").setValue("a").onChange((v) => (got.text = v)))
      .addTextArea((t) => t.setValue("multi").onChange((v) => (got.area = v)))
      .addSearch((t) => t.onChange((v) => (got.search = v)))
      .addDropdown((d) => d.addOption("1", "One").addOptions({ 2: "Two" }).setValue("2").onChange((v) => (got.dd = v)))
      .addSlider((s) => s.setLimits(0, 10, 1).setValue(3).setDynamicTooltip().onChange((v) => (got.slider = v)))
      .addColorPicker((p) => p.setValue("#ff0000").onChange((v) => (got.color = v)))
      .addProgressBar((p) => p.setValue(40))
      .addButton((b) => b.setButtonText("Go").setCta().onClick(() => (got.btn = true)))
      .addExtraButton((b) => b.setIcon("lucide-x").setTooltip("close").onClick(() => (got.extra = true)));
    const text = c.querySelector("input[type=text]") as HTMLInputElement; expect(text.placeholder).toBe("ph"); text.value = "b"; text.dispatchEvent(new Event("input")); expect(got.text).toBe("b");
    const area = c.querySelector("textarea")!; area.value = "m2"; area.dispatchEvent(new Event("input")); expect(got.area).toBe("m2");
    const search = c.querySelector(".search-input-container input") as HTMLInputElement; search.value = "q"; search.dispatchEvent(new Event("input")); expect(got.search).toBe("q");
    (c.querySelector(".search-input-clear-button") as HTMLElement).click(); expect(got.search).toBe(""); expect(search.value).toBe("");
    const sel = c.querySelector("select.dropdown") as HTMLSelectElement; expect(sel.options).toHaveLength(2); expect(sel.value).toBe("2"); sel.value = "1"; sel.dispatchEvent(new Event("change")); expect(got.dd).toBe("1");
    const slider = c.querySelector("input.slider") as HTMLInputElement; expect(slider.type).toBe("range"); expect(slider.value).toBe("3"); slider.value = "7"; slider.dispatchEvent(new Event("change")); expect(got.slider).toBe(7);
    const color = c.querySelector("input[type=color]") as HTMLInputElement; expect(color.value).toBe("#ff0000"); color.value = "#00ff00"; color.dispatchEvent(new Event("input")); expect(got.color).toBe("#00ff00");
    expect((c.querySelector(".setting-progress-bar-inner") as HTMLElement).style.width).toBe("40%");
    const btn = c.querySelector("button") as HTMLButtonElement; expect(btn.classList.contains("mod-cta")).toBe(true); expect(btn.textContent).toBe("Go"); btn.click(); expect(got.btn).toBe(true);
    const extra = c.querySelector(".clickable-icon.extra-setting-button") as HTMLElement; expect(extra.getAttribute("aria-label")).toBe("close"); expect(extra.querySelector("svg")).not.toBeNull(); extra.click(); expect(got.extra).toBe(true);
  });
  it("component classes: ValueComponent/BaseComponent.then, color conversions, MomentFormat sample, SettingGroup", () => {
    const c = createDiv();
    const color = new ColorComponent(c).setValueRgb({ r: 255, g: 128, b: 0 }); expect(color.getValue()).toBe("#ff8000"); expect(color.getValueRgb()).toEqual({ r: 255, g: 128, b: 0 }); expect(color.getValueHsl().h).toBe(30);
    expect(new ColorComponent(c).setValueHsl({ h: 0, s: 100, l: 50 }).getValue()).toBe("#ff0000");
    const mf = new MomentFormatComponent(c); const sample = createDiv(); mf.setDefaultFormat("YYYY").setSampleEl(sample); expect(sample.textContent).toMatch(/^\d{4}$/); mf.setValue("[x]"); expect(sample.textContent).toBe("x");
    expect(new TextComponent(c)).toBeInstanceOf(ValueComponent); expect(new ButtonComponent(c)).toBeInstanceOf(BaseComponent);
    const tc = new TextComponent(c); expect(tc.then((x) => x.setValue("z")).getValue()).toBe("z");
    const g = new SettingGroup(c).setHeading("Group").addSetting((s) => s.setName("inside"));
    expect(g.groupEl.className).toBe("setting-group"); expect(g.listEl.querySelector(".setting-item-name")!.textContent).toBe("inside"); expect(g.groupEl.querySelector(".setting-item-heading")!.textContent).toBe("Group");
    const sl = new SliderComponent(c).setLimits(0, 100, 5).setDisplayFormat((n) => n + "%").setValue(50); expect(sl.getValuePretty()).toBe("50%");
  });
  it("PluginSettingTab: definitions-based rendering and default get/setControlValue", async () => {
    const plugin: any = { manifest: { id: "p", name: "P" }, settings: { on: true, name: "x" }, saveData: vi.fn(async () => {}) };
    class T extends PluginSettingTab { getSettingDefinitions() { return [{ name: "On", control: { type: "toggle", key: "on" } }, { name: "Name", control: { type: "text", key: "name" } }, { type: "group", heading: "G", items: [{ name: "DD", control: { type: "dropdown", key: "dd", options: { a: "A" }, defaultValue: "a" } }] }] as any; } }
    const t = new T(app, plugin); t.display();
    expect(t.containerEl.querySelectorAll(".setting-item").length).toBe(4); // 3 settings + the group heading row; expect(t.containerEl.querySelector(".setting-group")).not.toBeNull();
    (t.containerEl.querySelector(".checkbox-container") as HTMLElement).click(); await vi.waitFor(() => expect(plugin.saveData).toHaveBeenCalledWith({ on: false, name: "x" }));
    expect(t.id).toBe("p"); expect(t.name).toBe("P");
  });
});

describe("Notice", () => {
  it("renders notice-container > notice > notice-message, auto-hides, click hides, setMessage, sticky", () => {
    vi.useFakeTimers();
    const n = new Notice("hello", 1000);
    expect(document.querySelector(".notice-container > .notice > .notice-message")!.textContent).toBe("hello");
    expect(n.noticeEl.classList.contains("notice")).toBe(true); expect(n.messageEl.classList.contains("notice-message")).toBe(true); expect(n.containerEl.classList.contains("notice-container")).toBe(true);
    n.setMessage("changed"); expect(n.messageEl.textContent).toBe("changed");
    const frag = createFragment((f) => f.createEl("i", { text: "x" })); n.setMessage(frag); expect(n.messageEl.innerHTML).toBe("<i>x</i>");
    vi.advanceTimersByTime(1001); expect(document.querySelector(".notice")).toBeNull();
    const sticky = new Notice("stay", 0); vi.advanceTimersByTime(60000); expect(document.querySelector(".notice")).not.toBeNull(); sticky.noticeEl.click(); expect(document.querySelector(".notice")).toBeNull();
    const a = new Notice("a"), b = new Notice("b"); expect(document.querySelectorAll(".notice-container .notice")).toHaveLength(2); a.hide(); b.hide();
    vi.useRealTimers();
  });
});

describe("Modal", () => {
  it("DOM: modal-container.mod-dim > modal-bg + modal(close button, title, content); open/close lifecycle; Escape; bg click", () => {
    const log: string[] = [];
    class M extends Modal { onOpen() { log.push("open"); this.contentEl.createEl("p", { text: "body" }); } onClose() { log.push("close"); } }
    const m = new M(app); m.setTitle("T");
    m.open(); m.open();
    expect(log).toEqual(["open"]);
    const c = document.querySelector(".modal-container.mod-dim")!; expect(c).toBe(m.containerEl);
    expect(c.querySelector(".modal-bg")).not.toBeNull(); expect(c.querySelector(".modal > .modal-close-button")).not.toBeNull();
    expect(c.querySelector(".modal-title")!.textContent).toBe("T"); expect(c.querySelector(".modal-content p")!.textContent).toBe("body");
    expect(app.keymap.scope).toBe(m.scope);
    app.keymap.handleEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(log).toEqual(["open", "close"]); expect(document.querySelector(".modal-container")).toBeNull(); expect(app.keymap.scope).not.toBe(m.scope);
    const cb = vi.fn(); m.setCloseCallback(cb); m.open(); (m.bgEl).click(); expect(cb).toHaveBeenCalled(); expect(log.filter((x) => x === "close")).toHaveLength(2);
    m.setContent("plain"); expect(m.contentEl.textContent).toBe("plain");
  });
  it("ConfirmationModal buttons", () => {
    const m = new ConfirmationModal(app); const ok = vi.fn();
    m.addButton((b) => b.setButtonText("OK").setCta().onClick(ok)).addCancelButton(); m.open();
    const btns = m.buttonContainerEl.querySelectorAll("button"); expect(btns).toHaveLength(2); (btns[0] as HTMLElement).click(); expect(ok).toHaveBeenCalled(); (btns[1] as HTMLElement).click(); expect(document.querySelector(".modal-container")).toBeNull();
  });
});

describe("Menu", () => {
  it("renders .menu > .menu-item(.menu-item-icon,.menu-item-title), click runs callback and hides; separators; onHide", () => {
    const m = new Menu(); const cb = vi.fn(); const hid = vi.fn(); m.onHide(hid);
    m.addItem((i) => i.setTitle("One").setIcon("lucide-x").onClick(cb)).addSeparator().addItem((i) => i.setTitle("Two").setDisabled(true).setWarning(true)).addItem((i) => i.setTitle("Checked").setChecked(true));
    m.showAtPosition({ x: 10, y: 20 });
    const el = document.querySelector(".menu")!; expect(el).toBe(m.dom);
    const items = el.querySelectorAll(".menu-item"); expect(items).toHaveLength(3);
    expect(items[0].querySelector(".menu-item-icon svg")).not.toBeNull(); expect(items[0].querySelector(".menu-item-title")!.textContent).toBe("One");
    expect(items[1].classList.contains("is-disabled") && items[1].classList.contains("is-warning")).toBe(true); expect(items[2].classList.contains("is-checked")).toBe(true);
    expect(m.items[1]).toBeInstanceOf(MenuSeparator); expect(m.items[0]).toBeInstanceOf(MenuItem);
    (items[1] as HTMLElement).click(); expect(document.querySelector(".menu")).not.toBeNull(); // disabled: no-op
    (items[0] as HTMLElement).click(); expect(cb).toHaveBeenCalledTimes(1); expect(document.querySelector(".menu")).toBeNull(); expect(hid).toHaveBeenCalled();
  });
  it("sections group items with separators; Escape and outside click hide; showAtMouseEvent; Menu.forEvent", async () => {
    const m = new Menu();
    m.addItem((i) => i.setTitle("a").setSection("x")).addItem((i) => i.setTitle("b").setSection("y")).addItem((i) => i.setTitle("c").setSection("x"));
    m.showAtMouseEvent(new MouseEvent("contextmenu", { clientX: 5, clientY: 6 }));
    expect(Array.from(m.dom.children).map((e) => (e.classList.contains("menu-separator") ? "|" : e.textContent))).toEqual(["a", "c", "|", "b"]);
    expect(m.dom.style.left).toBe("5px");
    m.hide();
    m.addItem((i) => i.setTitle("again")); m.showAtPosition({ x: 0, y: 0 });
    app.keymap.handleEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })); expect(document.querySelector(".menu")).toBeNull();
    m.showAtPosition({ x: 0, y: 0 }); await new Promise((r) => setTimeout(r, 5));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); expect(document.querySelector(".menu")).toBeNull();
    expect(Menu.forEvent(new MouseEvent("click"))).toBeInstanceOf(Menu);
  });
  it("setSubmenu", () => {
    const m = new Menu(); let sub!: Menu;
    m.addItem((i) => { sub = i.setTitle("More").setSubmenu(); sub.addItem((s) => s.setTitle("Inner")); });
    m.showAtPosition({ x: 0, y: 0 }); expect(m.dom.querySelector(".menu-item.has-submenu")).not.toBeNull();
    (m.dom.querySelector(".has-submenu") as HTMLElement).dispatchEvent(new MouseEvent("mouseenter")); expect(document.querySelectorAll(".menu")).toHaveLength(2); m.hide(); expect(document.querySelectorAll(".menu")).toHaveLength(0);
  });
});

describe("SuggestModal / FuzzySuggestModal / AbstractInputSuggest", () => {
  const key = (k: string) => app.keymap.handleEvent(new KeyboardEvent("keydown", { key: k, cancelable: true }));
  it("SuggestModal: prompt DOM, filtering, selection with arrows/Enter, onNoSuggestion, async getSuggestions, limit", async () => {
    const chosen: string[] = [];
    class S extends SuggestModal<string> {
      getSuggestions(q: string) { return ["apple", "apricot", "banana"].filter((x) => x.includes(q)); }
      renderSuggestion(v: string, el: HTMLElement) { el.setText(v); }
      onChooseSuggestion(v: string) { chosen.push(v); }
    }
    const m = new S(app); m.setPlaceholder("Pick"); m.setInstructions([{ command: "↵", purpose: "choose" }]); m.open();
    await vi.waitFor(() => expect(m.resultContainerEl.querySelectorAll(".suggestion-item")).toHaveLength(3));
    expect(m.modalEl.classList.contains("prompt")).toBe(true); expect(m.inputEl.className).toBe("prompt-input"); expect(m.inputEl.placeholder).toBe("Pick");
    expect(m.modalEl.querySelector(".prompt-instruction")!.textContent).toContain("choose");
    expect(m.resultContainerEl.querySelector(".suggestion-item.is-selected")!.textContent).toBe("apple");
    key("ArrowDown"); expect(m.resultContainerEl.querySelector(".is-selected")!.textContent).toBe("apricot");
    m.inputEl.value = "ban"; m.inputEl.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(m.resultContainerEl.querySelectorAll(".suggestion-item")).toHaveLength(1));
    key("Enter"); expect(chosen).toEqual(["banana"]); expect(document.querySelector(".modal-container")).toBeNull();
    const m2 = new S(app); m2.open(); m2.inputEl.value = "zzz"; m2.inputEl.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(m2.resultContainerEl.querySelector(".prompt-no-results")!.textContent).toBe("No results found.")); m2.close();
    // clicking a row selects it
    const m3 = new S(app); m3.open(); await vi.waitFor(() => expect(m3.resultContainerEl.children.length).toBe(3)); (m3.resultContainerEl.children[1] as HTMLElement).click(); expect(chosen.at(-1)).toBe("apricot");
  });
  it("FuzzySuggestModal ranks, highlights and calls onChooseItem", async () => {
    const chosen: any[] = [];
    class F extends FuzzySuggestModal<TFile> {
      getItems() { return app.vault.getMarkdownFiles(); } getItemText(f: TFile) { return f.path; } onChooseItem(f: TFile) { chosen.push(f.path); }
    }
    const m = new F(app); m.open(); await vi.waitFor(() => expect(m.resultContainerEl.querySelectorAll(".suggestion-item")).toHaveLength(3));
    m.inputEl.value = "c"; m.inputEl.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(m.resultContainerEl.querySelectorAll(".suggestion-item")).toHaveLength(1));
    expect(m.resultContainerEl.querySelector(".suggestion-highlight")!.textContent).toBe("C");
    key("Enter"); expect(chosen).toEqual(["dir/C.md"]);
  });
  it("AbstractInputSuggest shows suggestions for an input, selecting calls onSelect callbacks", async () => {
    const input = document.body.createEl("input", { type: "text" }); const picked: string[] = [];
    class A extends AbstractInputSuggest<string> {
      protected getSuggestions(q: string) { return ["alpha", "beta"].filter((x) => x.startsWith(q)); }
      renderSuggestion(v: string, el: HTMLElement) { el.setText(v); }
    }
    const s = new A(app, input); s.onSelect((v) => { picked.push(v); s.setValue(v); s.close(); });
    input.value = "b"; input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(document.querySelector(".suggestion-container .suggestion-item")!.textContent).toBe("beta"));
    (document.querySelector(".suggestion-item") as HTMLElement).click(); expect(picked).toEqual(["beta"]); expect(input.value).toBe("beta"); expect(document.querySelector(".suggestion-container")).toBeNull();
  });
});

describe("requestUrl / request", () => {
  it("goes through http_request, decodes text/json/arrayBuffer, throws on >=400 unless throw:false", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      if (req.url === "/json") { res.setHeader("content-type", "application/json"); res.end('{"a":1}'); }
      else if (req.url === "/echo") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { res.end(JSON.stringify({ m: req.method, b, h: req.headers["x-t"], ct: req.headers["content-type"] })); }); }
      else { res.statusCode = 404; res.end("nope"); }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const r = await requestUrl(base + "/json"); expect(r.status).toBe(200); expect(r.json).toEqual({ a: 1 }); expect(r.text).toBe('{"a":1}'); expect(r.headers["content-type"]).toBe("application/json"); expect(new Uint8Array(r.arrayBuffer)[0]).toBe(123);
      expect(await requestUrl(base + "/json").json).toEqual({ a: 1 }); expect(await requestUrl({ url: base + "/json" }).text).toBe('{"a":1}');
      const e = await requestUrl({ url: base + "/echo", method: "POST", body: "x=1", contentType: "text/plain", headers: { "X-T": "h" } }); expect(e.json).toEqual({ m: "POST", b: "x=1", h: "h", ct: "text/plain" });
      await expect(requestUrl(base + "/missing")).rejects.toMatchObject({ status: 404 });
      expect((await requestUrl({ url: base + "/missing", throw: false })).status).toBe(404);
      expect(await request(base + "/json")).toBe('{"a":1}');
    } finally { server.close(); }
  });
});

describe("MarkdownRenderer + registries", () => {
  it("renders through the swappable hook, then runs post-processors; renderMarkdown legacy; MarkdownRenderChild", async () => {
    const calls: string[] = [];
    setMarkdownRenderer(({ markdown, el, sourcePath }) => { calls.push(sourcePath); el.innerHTML = `<p>${markdown}</p>`; });
    class P extends Plugin {} const p = new (P as any)(app, { id: "z", name: "Z" }); p.load();
    p.registerMarkdownPostProcessor((el: HTMLElement, ctx: any) => { el.setAttribute("data-src", ctx.sourcePath); });
    const host = createDiv(); const comp = new Component(); comp.load();
    await MarkdownRenderer.render(app, "hi", host, "A.md", comp);
    expect(host.innerHTML).toBe("<p>hi</p>"); expect(host.getAttribute("data-src")).toBe("A.md"); expect(calls).toEqual(["A.md"]);
    const h2 = createDiv(); await MarkdownRenderer.renderMarkdown("legacy", h2, "B.md", comp); expect(h2.textContent).toBe("legacy");
    const child = new MarkdownRenderChild(h2); expect(child.containerEl).toBe(h2); expect(child).toBeInstanceOf(Component);
    p.unload(); setMarkdownRenderer(null);
    const h3 = createDiv(); await MarkdownRenderer.render(app, "# T\n\npara\n\n```js\ncode\n```", h3, "A.md", comp); // default trivial renderer
    expect(h3.querySelector("h1")!.textContent).toBe("T"); expect(h3.querySelector("pre code.language-js")!.textContent).toContain("code"); expect(h3.hasAttribute("data-src")).toBe(false);
  });
});

describe("Component / Events semantics", () => {
  it("load/unload order, addChild when loaded, register order, registerEvent/registerDomEvent/registerInterval", async () => {
    vi.useFakeTimers();
    const log: string[] = []; const ev = new Events();
    class C extends Component { onload() { log.push("load:" + this.name); } onunload() { log.push("unload:" + this.name); } constructor(public name: string) { super(); } }
    const parent = new C("p"), child = new C("c"); parent.addChild(child); parent.register(() => log.push("reg1")); parent.register(() => log.push("reg2"));
    parent.load(); expect(log).toEqual(["load:p", "load:c"]);
    const late = new C("late"); parent.addChild(late); expect(log.at(-1)).toBe("load:late");
    const fn = vi.fn(); parent.registerEvent(ev.on("x", fn)); ev.trigger("x", 1, 2); expect(fn).toHaveBeenCalledWith(1, 2);
    const el = createDiv(); const dom = vi.fn(); parent.registerDomEvent(el, "click", dom); el.click(); expect(dom).toHaveBeenCalledTimes(1);
    const tick = vi.fn(); parent.registerInterval(window.setInterval(tick, 10)); vi.advanceTimersByTime(35); expect(tick).toHaveBeenCalledTimes(3);
    log.length = 0; parent.unload();
    expect(log).toEqual(["unload:late", "unload:c", "reg2", "reg1", "unload:p"]); // children, then registered callbacks (reverse), then onunload
    ev.trigger("x"); expect(fn).toHaveBeenCalledTimes(1); el.click(); expect(dom).toHaveBeenCalledTimes(1); vi.advanceTimersByTime(100); expect(tick).toHaveBeenCalledTimes(3);
    parent.unload(); expect(log).toHaveLength(5); // idempotent
    vi.useRealTimers();
  });
  it("Events: off/offref, ctx, errors in handlers do not break emitters", () => {
    const ev = new Events(); const a = vi.fn(), b = vi.fn(); const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ra = ev.on("e", a); ev.on("e", () => { throw new Error("x"); }); ev.on("e", b, { ctx: 1 });
    ev.trigger("e"); expect(a).toHaveBeenCalled(); expect(b).toHaveBeenCalled(); expect(b.mock.contexts[0]).toEqual({ ctx: 1 }); expect(err).toHaveBeenCalled();
    ev.offref(ra); ev.off("e", b); ev.trigger("e"); expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1);
    ev.offref(undefined as any); err.mockRestore();
  });
});
