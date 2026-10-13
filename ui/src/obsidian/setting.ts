// Settings UI: Setting + components, SettingTab family and the settings dialog (`app.setting`).
import moment from "moment";
import { setIcon } from "./icons";
import { Modal, setTooltip, type TooltipOptions } from "./ui";
import type { App } from "./app";
import type { Plugin } from "./plugin";

export abstract class BaseComponent {
  disabled = false;
  then(cb: (c: this) => any): this { cb(this); return this; }
  setDisabled(disabled: boolean): this { this.disabled = disabled; return this; }
}

export abstract class ValueComponent<T> extends BaseComponent {
  private optionListeners: Record<string, (value?: T) => T> = {};
  registerOptionListener(listeners: Record<string, (value?: T) => T>, key: string): this {
    this.optionListeners = listeners;
    const getter = listeners[key];
    if (getter) this.setValue(getter());
    return this;
  }
  abstract getValue(): T;
  abstract setValue(value: T): this;
}

export class AbstractTextComponent<T extends HTMLInputElement | HTMLTextAreaElement> extends ValueComponent<string> {
  inputEl: T;
  private changeCb: ((v: string) => any) | null = null;
  constructor(inputEl: T) {
    super();
    this.inputEl = inputEl;
    inputEl.addEventListener("input", () => this.onChanged());
  }
  setDisabled(disabled: boolean): this { super.setDisabled(disabled); this.inputEl.disabled = disabled; return this; }
  getValue(): string { return this.inputEl.value; }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  setPlaceholder(p: string): this { this.inputEl.placeholder = p; return this; }
  onChanged(): void { this.changeCb?.(this.getValue()); }
  onChange(cb: (v: string) => any): this { this.changeCb = cb; return this; }
}
export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
  constructor(containerEl: HTMLElement) { super(containerEl.createEl("input", { type: "text", attr: { spellcheck: "false" } })); }
}
export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
  constructor(containerEl: HTMLElement) { super(containerEl.createEl("textarea")); }
}
export class SearchComponent extends AbstractTextComponent<HTMLInputElement> {
  containerEl: HTMLElement;
  clearButtonEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    const wrap = containerEl.createDiv({ cls: "search-input-container" });
    super(wrap.createEl("input", { type: "search", attr: { enterkeyhint: "search", spellcheck: "false" } }));
    this.containerEl = wrap;
    this.clearButtonEl = wrap.createDiv({ cls: "search-input-clear-button", attr: { "aria-label": "Clear search" } });
    this.clearButtonEl.addEventListener("click", () => { this.setValue(""); this.inputEl.focus(); this.onChanged(); });
    this.updateClear();
  }
  private updateClear(): void { this.clearButtonEl?.toggleClass("is-visible", !!this.inputEl.value); wrapToggle(this); }
  setValue(v: string): this { super.setValue(v); this.clearButtonEl && this.updateClear(); return this; }
  onChanged(): void { super.onChanged(); this.updateClear(); }
}
function wrapToggle(c: SearchComponent): void { c.containerEl?.toggleClass("is-empty", !c.inputEl.value); }

export class MomentFormatComponent extends TextComponent {
  sampleEl!: HTMLElement;
  defaultFormat = "";
  setDefaultFormat(f: string): this { this.defaultFormat = f; this.setPlaceholder(f); return this; }
  setSampleEl(el: HTMLElement): this { this.sampleEl = el; this.updateSample(); return this; }
  setValue(v: string): this { super.setValue(v); this.updateSample(); return this; }
  onChanged(): void { super.onChanged(); this.updateSample(); }
  updateSample(): void {
    if (!this.sampleEl) return;
    const f = this.getValue() || this.defaultFormat;
    try { this.sampleEl.setText(moment().format(f)); this.sampleEl.removeClass("mod-warning"); } catch { this.sampleEl.setText("Invalid format"); this.sampleEl.addClass("mod-warning"); }
  }
}

export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private value = false;
  private changeCb: ((v: boolean) => any) | null = null;
  constructor(containerEl: HTMLElement) {
    super();
    this.toggleEl = containerEl.createDiv({ cls: "checkbox-container", attr: { tabindex: 0 } });
    this.inputEl = this.toggleEl.createEl("input", { type: "checkbox", attr: { tabindex: -1 } });
    this.toggleEl.addEventListener("click", (e) => { if (e.target === this.inputEl) return; this.onClick(); });
    this.inputEl.addEventListener("click", (e) => { e.stopPropagation(); this.value = this.inputEl.checked; this.sync(); this.onChanged(); });
    this.toggleEl.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); this.onClick(); } });
  }
  private sync(): void { this.toggleEl.toggleClass("is-enabled", this.value); this.inputEl.checked = this.value; }
  setDisabled(d: boolean): this { super.setDisabled(d); this.toggleEl.toggleClass("is-disabled", d); return this; }
  getValue(): boolean { return this.value; }
  setValue(on: boolean): this { this.value = !!on; this.sync(); return this; }
  setTooltip(tooltip: string, o?: TooltipOptions): this { setTooltip(this.toggleEl, tooltip, o); return this; }
  onClick(): void { if (this.disabled) return; this.setValue(!this.value); this.onChanged(); }
  private onChanged(): void { this.changeCb?.(this.value); }
  onChange(cb: (v: boolean) => any): this { this.changeCb = cb; return this; }
}

export class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement;
  private changeCb: ((v: string) => any) | null = null;
  constructor(containerEl: HTMLElement) {
    super();
    this.selectEl = containerEl.createEl("select", { cls: "dropdown" });
    this.selectEl.addEventListener("change", () => this.changeCb?.(this.getValue()));
  }
  setDisabled(d: boolean): this { super.setDisabled(d); this.selectEl.disabled = d; return this; }
  addOption(value: string, display: string): this { this.selectEl.createEl("option", { value, text: display }); return this; }
  addOptions(o: Record<string, string>): this { for (const k of Object.keys(o)) this.addOption(k, o[k]); return this; }
  getValue(): string { return this.selectEl.value; }
  setValue(v: string): this { this.selectEl.value = v; return this; }
  onChange(cb: (v: string) => any): this { this.changeCb = cb; return this; }
}

export class SliderComponent extends ValueComponent<number> {
  sliderEl: HTMLInputElement;
  private changeCb: ((v: number) => any) | null = null;
  private format: ((v: number) => string) | null = null;
  private instant = false;
  private dynamic = false;
  constructor(containerEl: HTMLElement) {
    super();
    this.sliderEl = containerEl.createEl("input", { cls: "slider", type: "range" });
    const fire = () => { this.updateTip(); this.changeCb?.(this.getValue()); };
    this.sliderEl.addEventListener("input", () => { this.updateTip(); if (this.instant) this.changeCb?.(this.getValue()); });
    this.sliderEl.addEventListener("change", () => { if (!this.instant) fire(); });
  }
  private updateTip(): void { if (this.dynamic) this.sliderEl.setAttribute("aria-label", this.getValuePretty()); }
  setDisabled(d: boolean): this { super.setDisabled(d); this.sliderEl.disabled = d; return this; }
  setInstant(i: boolean): this { this.instant = i; return this; }
  setLimits(min: number | null, max: number | null, step: number | "any"): this {
    if (min !== null) this.sliderEl.min = String(min);
    if (max !== null) this.sliderEl.max = String(max);
    this.sliderEl.step = String(step);
    return this;
  }
  getValue(): number { return Number(this.sliderEl.value); }
  setValue(v: number): this { this.sliderEl.value = String(v); this.updateTip(); return this; }
  getValuePretty(): string { const v = this.getValue(); return this.format ? this.format(v) : String(v); }
  setDisplayFormat(f: (v: number) => string): this { this.format = f; return this; }
  setDynamicTooltip(): this { this.dynamic = true; this.updateTip(); return this; }
  onChange(cb: (v: number) => any): this { this.changeCb = cb; return this; }
}

export class ColorComponent extends ValueComponent<string> {
  colorPickerEl: HTMLInputElement;
  private changeCb: ((v: string) => any) | null = null;
  constructor(containerEl: HTMLElement) {
    super();
    this.colorPickerEl = containerEl.createEl("input", { type: "color" });
    this.colorPickerEl.addEventListener("input", () => this.changeCb?.(this.getValue()));
  }
  setDisabled(d: boolean): this { super.setDisabled(d); this.colorPickerEl.disabled = d; return this; }
  getValue(): string { return this.colorPickerEl.value; }
  setValue(v: string): this { this.colorPickerEl.value = v; return this; }
  getValueRgb(): { r: number; g: number; b: number } {
    const h = this.getValue().replace("#", "");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  setValueRgb(c: { r: number; g: number; b: number }): this {
    return this.setValue("#" + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join(""));
  }
  getValueHsl(): { h: number; s: number; l: number } {
    const { r: r0, g: g0, b: b0 } = this.getValueRgb();
    const r = r0 / 255, g = g0 / 255, b = b0 / 255, max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2, d = max - min;
    let h = 0, s = 0;
    if (d) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
  }
  setValueHsl(c: { h: number; s: number; l: number }): this {
    const s = c.s / 100, l = c.l / 100, k = (n: number) => (n + c.h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return this.setValueRgb({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 });
  }
  onChange(cb: (v: string) => any): this { this.changeCb = cb; return this; }
}

export class ProgressBarComponent extends ValueComponent<number> {
  progressBar: HTMLElement;
  private bar: HTMLElement;
  private value = 0;
  constructor(containerEl: HTMLElement) {
    super();
    this.progressBar = containerEl.createDiv({ cls: "setting-progress-bar" });
    this.bar = this.progressBar.createDiv({ cls: "setting-progress-bar-inner" });
  }
  setVisibility(v: boolean): this { this.progressBar.hidden = !v; return this; }
  getValue(): number { return this.value; }
  setValue(v: number): this {
    this.value = Math.max(0, Math.min(100, v));
    this.bar.style.width = `${this.value}%`;
    return this;
  }
}

export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement;
  constructor(containerEl: HTMLElement) { super(); this.buttonEl = containerEl.createEl("button"); }
  setDisabled(d: boolean): this { super.setDisabled(d); this.buttonEl.disabled = d; this.buttonEl.toggleClass("is-disabled", d); return this; }
  setCta(): this { this.buttonEl.addClass("mod-cta"); return this; }
  removeCta(): this { this.buttonEl.removeClass("mod-cta"); return this; }
  setWarning(): this { this.buttonEl.addClass("mod-warning"); return this; }
  setDestructive(): this { this.buttonEl.addClass("mod-destructive"); return this; }
  removeDestructive(): this { this.buttonEl.removeClass("mod-destructive"); return this; }
  setTooltip(t: string, o?: TooltipOptions): this { setTooltip(this.buttonEl, t, o); return this; }
  setButtonText(name: string): this { this.buttonEl.setText(name); return this; }
  setIcon(icon: string): this { setIcon(this.buttonEl, icon); return this; }
  setClass(cls: string): this { this.buttonEl.addClass(cls); return this; }
  onClick(cb: (evt: MouseEvent) => unknown | Promise<unknown>): this {
    this.buttonEl.addEventListener("click", (e) => { void Promise.resolve(cb(e)).catch((err) => console.error(err)); });
    return this;
  }
}

export class ExtraButtonComponent extends BaseComponent {
  extraSettingsEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.extraSettingsEl = containerEl.createDiv({ cls: "clickable-icon extra-setting-button", attr: { "aria-label": "", role: "button", tabindex: 0 } });
  }
  setDisabled(d: boolean): this { super.setDisabled(d); this.extraSettingsEl.toggleClass("is-disabled", d); return this; }
  setTooltip(t: string, o?: TooltipOptions): this { setTooltip(this.extraSettingsEl, t, o); return this; }
  setIcon(icon: string): this { setIcon(this.extraSettingsEl, icon); return this; }
  onClick(cb: () => any): this { this.extraSettingsEl.addEventListener("click", () => { if (!this.disabled) cb(); }); return this; }
}

export class DisplayValueComponent {
  valueEl: HTMLElement;
  constructor(containerEl: HTMLElement) { this.valueEl = containerEl.createDiv({ cls: "setting-item-value" }); }
  setValue(v: string | null): this { this.valueEl.setText(v ?? ""); return this; }
  setStatus(s: "warning" | null): this { this.valueEl.toggleClass("mod-warning", s === "warning"); return this; }
}

export class SecretComponent extends BaseComponent {
  inputEl: HTMLInputElement;
  constructor(public app: App, containerEl: HTMLElement) { super(); this.inputEl = containerEl.createEl("input", { type: "password" }); }
  setValue(v: string): this { this.inputEl.value = v; return this; }
  onChange(cb: (v: string | null) => unknown): this { this.inputEl.addEventListener("input", () => cb(this.inputEl.value || null)); return this; }
}

// ---------------------------------------------------------------- Setting

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  components: BaseComponent[] = [];
  errorEl: HTMLElement | null = null;
  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(name: string | DocumentFragment): this { this.nameEl.setText(name); return this; }
  setDesc(desc: string | DocumentFragment): this { this.descEl.setText(desc); return this; }
  setClass(cls: string): this { this.settingEl.addClass(...cls.split(/\s+/).filter(Boolean)); return this; }
  setTooltip(t: string, o?: TooltipOptions): this { setTooltip(this.settingEl, t, o); return this; }
  setHeading(): this { this.settingEl.addClass("setting-item-heading"); return this; }
  setVisibility(visible: boolean): this { this.settingEl.toggle(visible); return this; }
  setInvalid(): this { this.settingEl.addClass("is-invalid"); return this; }
  removeInvalid(): this { this.settingEl.removeClass("is-invalid"); return this; }
  setDisabled(d: boolean): this {
    this.settingEl.toggleClass("is-disabled", d);
    for (const c of this.components) c.setDisabled(d);
    return this;
  }
  setErrorMessage(message: string | null): this {
    if (!message) { this.errorEl?.detach(); this.errorEl = null; this.settingEl.removeClass("has-error"); return this; }
    if (!this.errorEl) this.errorEl = this.infoEl.createDiv({ cls: "setting-item-error" });
    this.errorEl.setText(message);
    this.settingEl.addClass("has-error");
    return this;
  }
  private add<C extends BaseComponent>(c: C, cb: (c: C) => any): this { this.components.push(c); cb(c); return this; }
  addButton(cb: (c: ButtonComponent) => any): this { return this.add(new ButtonComponent(this.controlEl), cb); }
  addExtraButton(cb: (c: ExtraButtonComponent) => any): this { return this.add(new ExtraButtonComponent(this.controlEl), cb); }
  addToggle(cb: (c: ToggleComponent) => any): this { return this.add(new ToggleComponent(this.controlEl), cb); }
  addText(cb: (c: TextComponent) => any): this { return this.add(new TextComponent(this.controlEl), cb); }
  addSearch(cb: (c: SearchComponent) => any): this { return this.add(new SearchComponent(this.controlEl), cb); }
  addTextArea(cb: (c: TextAreaComponent) => any): this { return this.add(new TextAreaComponent(this.controlEl), cb); }
  addMomentFormat(cb: (c: MomentFormatComponent) => any): this { return this.add(new MomentFormatComponent(this.controlEl), cb); }
  addDropdown(cb: (c: DropdownComponent) => any): this { return this.add(new DropdownComponent(this.controlEl), cb); }
  addColorPicker(cb: (c: ColorComponent) => any): this { return this.add(new ColorComponent(this.controlEl), cb); }
  addProgressBar(cb: (c: ProgressBarComponent) => any): this { return this.add(new ProgressBarComponent(this.controlEl), cb); }
  addSlider(cb: (c: SliderComponent) => any): this { return this.add(new SliderComponent(this.controlEl), cb); }
  addDisplayValue(cb: (c: DisplayValueComponent) => any): this { cb(new DisplayValueComponent(this.controlEl)); return this; }
  addComponent<T extends BaseComponent>(cb: (el: HTMLElement) => T): this { this.components.push(cb(this.controlEl)); return this; }
  then(cb: (s: this) => any): this { cb(this); return this; }
  clear(): this { this.components = []; this.controlEl.empty(); this.nameEl.empty(); this.descEl.empty(); return this; }
}

export class SettingGroup {
  containerEl: HTMLElement;
  groupEl: HTMLElement;
  headerEl: HTMLElement | null = null;
  listEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.containerEl = containerEl;
    this.groupEl = containerEl.createDiv({ cls: "setting-group" });
    this.listEl = this.groupEl.createDiv({ cls: "setting-items" });
  }
  setHeading(text: string | DocumentFragment): this {
    if (!this.headerEl) this.headerEl = this.groupEl.createDiv({ cls: "setting-item setting-item-heading" }, (e) => this.groupEl.insertBefore(e, this.groupEl.firstChild));
    this.headerEl.empty();
    this.headerEl.createDiv({ cls: "setting-item-name" }).setText(text);
    return this;
  }
  addClass(...classes: string[]): this { this.groupEl.addClass(...classes); return this; }
  addSetting(cb: (s: Setting) => void): this { cb(new Setting(this.listEl)); return this; }
  addSearch(cb: (c: SearchComponent) => any): this {
    if (!this.headerEl) this.setHeading("");
    cb(new SearchComponent(this.headerEl!));
    return this;
  }
  addExtraButton(cb: (c: ExtraButtonComponent) => any): this {
    if (!this.headerEl) this.setHeading("");
    cb(new ExtraButtonComponent(this.headerEl!));
    return this;
  }
}

// ---------------------------------------------------------------- SettingTab

export abstract class SettingPage {
  rootEl: HTMLElement;
  titlebarEl: HTMLElement;
  containerEl: HTMLElement;
  title = "";
  constructor() {
    this.rootEl = createDiv({ cls: "setting-page" });
    this.titlebarEl = this.rootEl.createDiv({ cls: "setting-page-titlebar" });
    this.containerEl = this.rootEl.createDiv({ cls: "setting-page-content" });
  }
  abstract display(): void;
  hide(): void { this.containerEl.empty(); }
}

export abstract class SettingTab {
  id = "";
  name = "";
  icon = "";
  app: App;
  containerEl: HTMLElement;
  settingItems: any[] = [];
  constructor(app: App) {
    this.app = app;
    this.containerEl = createDiv({ cls: "vertical-tab-content" });
  }
  getSettingDefinitions(): any[] { return []; }
  getControlValue(_key: string): unknown { return undefined; }
  setControlValue(_key: string, _value: unknown): void | Promise<void> {}
  update(): void { this.hide(); this.display(); }
  refreshDomState(): void {}
  display(): void {
    const defs = this.getSettingDefinitions();
    this.settingItems = defs;
    renderDefinitions(this, this.containerEl, defs);
  }
  /** Like Obsidian, hiding does not touch the DOM: plugins tear their own UI down (e.g. Svelte $destroy) in hide(). */
  hide(): void {}
}

export abstract class PluginSettingTab extends SettingTab {
  plugin: Plugin;
  constructor(app: App, plugin: Plugin) {
    super(app);
    this.plugin = plugin;
    this.id = plugin.manifest.id;
    this.name = plugin.manifest.name;
  }
  getControlValue(key: string): unknown { return (this.plugin as any).settings?.[key]; }
  async setControlValue(key: string, value: unknown): Promise<void> {
    const p = this.plugin as any;
    p.settings = p.settings ?? {};
    p.settings[key] = value;
    await this.plugin.saveData(p.settings);
  }
}

function renderDefinitions(tab: SettingTab, el: HTMLElement, items: any[]): void {
  const vis = (v: unknown) => (typeof v === "function" ? (v as () => boolean)() : v) !== false;
  for (const def of items) {
    if (!vis(def.visible)) continue;
    if (def.type === "group" || def.type === "list") {
      const g = new SettingGroup(el);
      if (def.heading) g.setHeading(def.heading);
      if (def.cls) g.addClass(def.cls);
      const inner = g.listEl;
      renderDefinitions(tab, inner, def.items ?? []);
      continue;
    }
    if (def.type === "page") {
      const s = new Setting(el).setName(def.name);
      if (def.desc) s.setDesc(def.desc);
      continue;
    }
    const s = new Setting(el).setName(def.name);
    if (def.desc) s.setDesc(def.desc);
    if (def.render) { def.render(s, new SettingGroup(el)); continue; }
    if (def.action) { s.addButton((b) => b.setButtonText(def.name).onClick(() => def.action(s.controlEl, 0))); continue; }
    const c = def.control;
    if (!c) continue;
    const cur = tab.getControlValue(c.key) ?? c.defaultValue;
    const commit = async (v: unknown) => {
      if (c.validate) { const err = await c.validate(v); if (err) { s.setErrorMessage(err); return; } }
      s.setErrorMessage(null);
      await tab.setControlValue(c.key, v);
    };
    switch (c.type) {
      case "toggle": s.addToggle((t) => t.setValue(!!cur).onChange(commit)); break;
      case "dropdown": s.addDropdown((d) => d.addOptions(c.options).setValue(String(cur ?? "")).onChange(commit)); break;
      case "text": s.addText((t) => t.setValue(String(cur ?? "")).setPlaceholder(c.placeholder ?? "").onChange(commit)); break;
      case "textarea": s.addTextArea((t) => t.setValue(String(cur ?? "")).onChange(commit)); break;
      case "number": s.addText((t) => { t.inputEl.type = "number"; t.setValue(String(cur ?? "")).onChange((v) => commit(v === "" ? undefined : Number(v))); }); break;
      case "slider": s.addSlider((sl) => sl.setLimits(c.min, c.max, c.step).setValue(Number(cur ?? c.min)).onChange(commit)); break;
      case "color": s.addColorPicker((cp) => cp.setValue(String(cur ?? "#000000")).onChange(commit)); break;
      default: s.addText((t) => t.setValue(String(cur ?? "")).onChange(commit));
    }
  }
}

// ---------------------------------------------------------------- Confirmation

export class ConfirmationButton extends ButtonComponent {
  setInitialFocus(): this { this.buttonEl.setAttribute("data-initial-focus", "true"); return this; }
  setSecondary(): this { this.buttonEl.addClass("mod-secondary"); return this; }
  setCancel(): this { this.buttonEl.addClass("mod-cancel"); return this; }
}
export class ConfirmationModal extends Modal {
  buttonContainerEl: HTMLElement;
  constructor(app: App) {
    super(app);
    this.modalEl.addClass("mod-confirmation");
    this.buttonContainerEl = this.modalEl.createDiv({ cls: "modal-button-container" });
  }
  addClass(cls: string): this { this.modalEl.addClass(cls); return this; }
  addCheckbox(label: string, cb: (v: boolean) => any | Promise<any>): this {
    const l = this.contentEl.createEl("label", { cls: "mod-checkbox" });
    const i = l.createEl("input", { type: "checkbox" });
    l.appendText(label);
    i.addEventListener("change", () => { void cb(i.checked); });
    return this;
  }
  addButton(cb: (btn: ConfirmationButton) => any): this { cb(new ConfirmationButton(this.buttonContainerEl)); return this; }
  addCancelButton(text = "Cancel"): this {
    return this.addButton((b) => b.setButtonText(text).setCancel().onClick(() => this.close()));
  }
}

// ---------------------------------------------------------------- app.setting

export class SettingManager {
  settingTabs: SettingTab[] = [];
  pluginTabs: SettingTab[] = [];
  activeTab: SettingTab | null = null;
  containerEl: HTMLElement | null = null;
  private tabHeaderEl!: HTMLElement;
  private contentEl!: HTMLElement;
  /** Shells can override how the dialog is shown. */
  host: { open?(): void; close?(): void } | null = null;
  isOpen = false;
  constructor(public app: App) {}

  addSettingTab(tab: SettingTab): void {
    if (!this.pluginTabs.includes(tab)) this.pluginTabs.push(tab);
    if (this.isOpen) this.renderNav();
  }
  removeSettingTab(tab: SettingTab): void {
    this.pluginTabs = this.pluginTabs.filter((t) => t !== tab);
    if (this.activeTab === tab) { tab.hide(); this.activeTab = null; this.contentEl?.empty(); }
    if (this.isOpen) this.renderNav();
  }
  open(): void {
    if (this.host?.open) { this.host.open(); this.isOpen = true; return; }
    if (this.isOpen) return;
    this.isOpen = true;
    const c = (this.containerEl = createDiv({ cls: "modal-container mod-dim" }));
    c.createDiv({ cls: "modal-bg" }).addEventListener("click", () => this.close());
    const modal = c.createDiv({ cls: "modal mod-settings mod-sidebar-layout" });
    modal.createDiv({ cls: "modal-close-button" }).addEventListener("click", () => this.close());
    const tabs = modal.createDiv({ cls: "vertical-tabs-container" });
    this.tabHeaderEl = tabs.createDiv({ cls: "vertical-tab-header" });
    this.contentEl = tabs.createDiv({ cls: "vertical-tab-content-container" });
    document.body.appendChild(c);
    this.renderNav();
    const first = this.settingTabs[0] ?? this.pluginTabs[0];
    if (first) this.openTab(first);
  }
  /** Redraw the navigation after tabs were added or removed. */
  refreshNav(): void { if (this.isOpen) this.renderNav(); }
  private renderNav(): void {
    if (!this.tabHeaderEl) return; // a host-provided dialog renders its own navigation
    this.tabHeaderEl.empty();
    const group = (title: string, tabs: SettingTab[]) => {
      if (!tabs.length) return;
      const g = this.tabHeaderEl.createDiv({ cls: "vertical-tab-header-group" });
      g.createDiv({ cls: "vertical-tab-header-group-title", text: title });
      const items = g.createDiv({ cls: "vertical-tab-header-group-items" });
      for (const t of tabs) {
        const it = items.createDiv({ cls: "vertical-tab-nav-item", text: t.name });
        it.toggleClass("is-active", t === this.activeTab);
        it.addEventListener("click", () => this.openTab(t));
      }
    };
    // Tabs of core plugins carry `corePluginId` (app/core/settingTab.ts) and get their own group, like Obsidian.
    group("Options", this.settingTabs.filter((t) => !(t as any).corePluginId));
    group("Core plugins", this.settingTabs.filter((t) => (t as any).corePluginId).sort((a, b) => a.name.localeCompare(b.name)));
    group("Community plugins", this.pluginTabs);
  }
  openTab(tab: SettingTab): void {
    this.activeTab?.hide();
    this.activeTab = tab;
    this.contentEl.empty();
    this.contentEl.appendChild(tab.containerEl);
    try { tab.display(); } catch (e) { console.error(e); }
    this.renderNav();
  }
  openTabById(id: string): void {
    this.open();
    const t = [...this.settingTabs, ...this.pluginTabs].find((x) => x.id === id);
    if (t) this.openTab(t);
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this.host?.close) this.host.close();
    this.activeTab?.hide();
    this.activeTab = null;
    this.containerEl?.detach();
    this.containerEl = null;
  }
}
