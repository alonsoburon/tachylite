// Toolbar dialogs of a base: view settings (incl. plugin view options), sort & group, filters, properties & formulas.
import * as yaml from "js-yaml";
import type { App } from "../obsidian/app";
import { Modal } from "../obsidian/ui";
import { Setting } from "../obsidian/setting";
import { checkExpression } from "./expr";
import { addCondition, filterErrors, normalizePropertyId, type FilterNode, type ViewRaw } from "./config";
import type { BasesController } from "./host";

function propertyOptions(c: BasesController, none?: string): Record<string, string> {
  const o: Record<string, string> = none !== undefined ? { "": none } : {};
  for (const p of c.allProperties()) o[p] = `${c.displayName(p)} (${p})`;
  return o;
}

/** View name, layout and the options a view registration declares (BasesViewRegistration.options). */
export class ViewSettingsModal extends Modal {
  constructor(app: App, private c: BasesController, private index: number) { super(app); }
  onOpen(): void { this.setTitle("View settings"); this.render(); }
  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("bases-view-settings");
    const raw = this.c.config!.views[this.index];
    if (!raw) return;
    const cfg = this.c.viewConfigFor(this.index);
    new Setting(el).setName("Name").addText((t) => t.setValue(String(raw.name ?? "")).onChange((v) => { raw.name = v; this.c.configChanged("name"); }));
    const types: Record<string, string> = {};
    for (const [id, r] of Object.entries(this.c.registrations())) types[id] = r.name ?? id;
    if (!(raw.type in types)) types[raw.type] = raw.type;
    new Setting(el).setName("Layout").addDropdown((d) => d.addOptions(types).setValue(raw.type).onChange((v) => { raw.type = v; this.c.configChanged("type"); this.render(); }));
    new Setting(el).setName("Result limit").setDesc("Leave empty to show every result.").addText((t) => {
      t.inputEl.type = "number";
      t.setValue(raw.limit ? String(raw.limit) : "").onChange((v) => { const n = parseInt(v, 10); if (n > 0) raw.limit = n; else delete raw.limit; this.c.configChanged("limit"); });
    });
    const reg = this.c.registrations()[raw.type];
    let opts: any[] = [];
    try { opts = reg?.options?.(cfg) ?? []; } catch (e) { console.error("bases view options failed", e); }
    const renderOpt = (parent: HTMLElement, o: any) => {
      if (!o || (typeof o.shouldHide === "function" && o.shouldHide())) return;
      if (o.type === "group") {
        parent.createDiv({ cls: "bases-view-settings-group", text: o.displayName ?? "" });
        for (const it of o.items ?? []) renderOpt(parent, it);
        return;
      }
      const cur = cfg.get(o.key) ?? o.default;
      const set = (v: unknown) => cfg.set(o.key, v === "" || v === undefined ? null : v);
      const s = new Setting(parent).setName(o.displayName ?? o.key);
      switch (o.type) {
        case "toggle": s.addToggle((t) => t.setValue(!!cur).onChange(set)); break;
        case "dropdown": s.addDropdown((d) => d.addOptions(o.options ?? {}).setValue(String(cur ?? "")).onChange(set)); break;
        case "slider": s.addSlider((sl) => sl.setLimits(o.min ?? 0, o.max ?? 100, o.step ?? 1).setValue(Number(cur ?? o.min ?? 0)).setDynamicTooltip().onChange(set)); break;
        case "property": {
          const options = propertyOptions(this.c, o.placeholder ?? "None");
          const filtered = typeof o.filter === "function" ? Object.fromEntries(Object.entries(options).filter(([k]) => !k || o.filter(k))) : options;
          s.addDropdown((d) => d.addOptions(filtered).setValue(cur ? normalizePropertyId(String(cur)) : "").onChange(set));
          break;
        }
        case "multitext": s.addText((t) => t.setValue(Array.isArray(cur) ? cur.join(", ") : String(cur ?? "")).onChange((v) => set(v.split(",").map((x) => x.trim()).filter(Boolean)))); break;
        default: s.addText((t) => t.setPlaceholder(o.placeholder ?? "").setValue(cur === undefined || cur === null ? "" : String(cur)).onChange(set));
      }
    };
    if (opts.length) el.createEl("h4", { cls: "bases-view-settings-heading", text: `${reg?.name ?? raw.type} options` });
    for (const o of opts) renderOpt(el, o);
  }
}

/** Sort list, group-by and limit of the current view. */
export class SortModal extends Modal {
  constructor(app: App, private c: BasesController) { super(app); }
  onOpen(): void { this.setTitle("Sort and group"); this.render(); }
  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("bases-sort-modal");
    const raw = this.c.currentRaw();
    if (!raw) return;
    const sorts: { property: string; direction: string }[] = Array.isArray(raw.sort) ? raw.sort : [];
    const opts = propertyOptions(this.c);
    const commit = () => { if (sorts.length) raw.sort = sorts as any; else delete raw.sort; this.c.configChanged("sort"); };
    el.createEl("h4", { text: "Sort" });
    sorts.forEach((s, i) => {
      new Setting(el).setClass("bases-sort-row")
        .addDropdown((d) => d.addOptions({ ...opts, [normalizePropertyId(s.property)]: opts[normalizePropertyId(s.property)] ?? s.property }).setValue(normalizePropertyId(s.property)).onChange((v) => { s.property = v; commit(); }))
        .addDropdown((d) => d.addOptions({ ASC: "Ascending", DESC: "Descending" }).setValue(String(s.direction).toUpperCase() === "DESC" ? "DESC" : "ASC").onChange((v) => { s.direction = v; commit(); }))
        .addExtraButton((b) => b.setIcon("lucide-trash-2").setTooltip("Remove sort").onClick(() => { sorts.splice(i, 1); commit(); this.render(); }));
    });
    new Setting(el).addButton((b) => b.setButtonText("Add sort").onClick(() => { sorts.push({ property: "file.name", direction: "ASC" }); commit(); this.render(); }));
    el.createEl("h4", { text: "Group by" });
    const gb = raw.groupBy && typeof raw.groupBy === "object" ? raw.groupBy : null;
    new Setting(el).setName("Property")
      .addDropdown((d) => d.addOptions(propertyOptions(this.c, "None")).setValue(gb?.property ? normalizePropertyId(gb.property) : "").onChange((v) => {
        if (!v) { delete raw.groupBy; delete raw.groupOrder; } else raw.groupBy = { property: v, direction: (gb?.direction as "ASC") ?? "ASC" };
        this.c.configChanged("groupBy");
        this.render();
      }));
    if (gb) {
      new Setting(el).setName("Direction").addDropdown((d) => d.addOptions({ ASC: "Ascending", DESC: "Descending" }).setValue(String(gb.direction ?? "ASC").toUpperCase()).onChange((v) => {
        gb.direction = v as "ASC";
        this.c.configChanged("groupBy");
      }));
    }
  }
}

function dumpFilter(f: FilterNode | undefined): string {
  return f === undefined || f === null ? "" : yaml.dump(f, { lineWidth: -1 }).trimEnd();
}
function parseFilter(text: string): FilterNode | undefined {
  if (!text.trim()) return undefined;
  const v = yaml.load(text) as FilterNode;
  if (typeof v !== "string" && (typeof v !== "object" || v === null || Array.isArray(v))) throw new Error("A filter is a statement or an and/or/not mapping");
  return v;
}

/** Filters for all views and for this view, edited as YAML (the "advanced filter editor"), plus a quick add field. */
export class FilterModal extends Modal {
  constructor(app: App, private c: BasesController) { super(app); }
  onOpen(): void { this.setTitle("Filters"); this.render(); }
  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("bases-filter-modal");
    const cfg = this.c.config!, raw = this.c.currentRaw();
    const section = (title: string, get: () => FilterNode | undefined, set: (f: FilterNode | undefined) => void) => {
      const box = el.createDiv({ cls: "bases-filter-section" });
      box.createEl("h4", { text: title });
      const ta = box.createEl("textarea", { cls: "bases-filter-source", attr: { rows: "6", spellcheck: "false" } });
      ta.value = dumpFilter(get());
      const err = box.createDiv({ cls: "bases-filter-error" });
      const quick = new Setting(box).setName("Add condition").setClass("bases-filter-add");
      let input!: HTMLInputElement;
      quick.addText((t) => { input = t.inputEl; t.setPlaceholder('file.hasTag("book")'); });
      const apply = (text: string) => {
        err.empty();
        let f: FilterNode | undefined;
        try { f = parseFilter(text); } catch (e) { err.setText((e as Error).message.split("\n")[0]); return false; }
        const errs = filterErrors(f);
        if (errs.length) { err.setText(errs.join("\n")); return false; }
        set(f);
        this.c.configChanged("filters");
        return true;
      };
      quick.addButton((b) => b.setButtonText("Add").onClick(() => {
        const expr = input.value.trim();
        if (!expr) return;
        const bad = checkExpression(expr);
        if (bad) { err.setText(bad); return; }
        set(addCondition(get(), expr));
        this.c.configChanged("filters");
        this.render();
      }));
      new Setting(box).addButton((b) => b.setButtonText("Apply").setCta().onClick(() => { if (apply(ta.value)) this.render(); }));
    };
    section("All views", () => cfg.raw.filters, (f) => { if (f === undefined) delete cfg.raw.filters; else cfg.raw.filters = f; });
    if (raw) section(`This view (${raw.name || raw.type})`, () => raw.filters, (f) => { if (f === undefined) delete raw.filters; else raw.filters = f; });
  }
}

/** Visible properties (order), display names and formulas. */
export class PropertiesModal extends Modal {
  constructor(app: App, private c: BasesController) { super(app); }
  onOpen(): void { this.setTitle("Properties"); this.render(); }
  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("bases-properties-modal");
    const raw = this.c.currentRaw() as ViewRaw;
    const cfg = this.c.config!;
    const order = (): string[] => (Array.isArray(raw.order) ? raw.order.map((p) => normalizePropertyId(String(p))) : ["file.name"]);
    const setOrder = (o: string[]) => { raw.order = o; this.c.configChanged("order"); this.render(); };
    const shown = order();
    const all = [...shown, ...this.c.allProperties().filter((p) => !shown.includes(p))];
    for (const p of all) {
      const visible = shown.includes(p);
      const s = new Setting(el).setClass("bases-property-row").setName(this.c.displayName(p)).setDesc(p);
      s.addToggle((t) => t.setValue(visible).onChange((v) => setOrder(v ? [...order(), p] : order().filter((x) => x !== p))));
      if (visible) {
        s.addExtraButton((b) => b.setIcon("lucide-arrow-up").setTooltip("Move up").onClick(() => {
          const o = order(), i = o.indexOf(p);
          if (i > 0) { [o[i - 1], o[i]] = [o[i], o[i - 1]]; setOrder(o); }
        }));
        s.addExtraButton((b) => b.setIcon("lucide-pencil").setTooltip("Rename").onClick(() => {
          const name = window.prompt?.("Display name", this.c.displayName(p));
          if (name !== null && name !== undefined) { cfg.setDisplayName(p, name.trim() || null); this.c.configChanged("properties"); this.render(); }
        }));
      }
      if (p.startsWith("formula.")) {
        s.addExtraButton((b) => b.setIcon("lucide-trash-2").setTooltip("Delete formula").onClick(() => {
          cfg.setFormula(p.slice(8), null);
          for (const v of cfg.views) if (Array.isArray(v.order)) v.order = v.order.filter((x) => normalizePropertyId(String(x)) !== p);
          this.c.configChanged("formulas");
          this.render();
        }));
      }
    }
    el.createEl("h4", { text: "Formulas" });
    for (const [name, src] of Object.entries(cfg.formulas)) {
      const s = new Setting(el).setClass("bases-formula-row").setName(name);
      const err = s.descEl;
      s.addText((t) => {
        t.inputEl.addClass("bases-formula-input");
        t.setValue(String(src)).onChange((v) => {
          const bad = checkExpression(v);
          err.setText(bad ?? "");
          if (!bad) { cfg.setFormula(name, v); this.c.configChanged("formulas"); }
        });
      });
    }
    const add = new Setting(el).setName("Add formula").setClass("bases-formula-add");
    let nameEl!: HTMLInputElement, exprEl!: HTMLInputElement;
    add.addText((t) => { nameEl = t.inputEl; t.setPlaceholder("Name"); });
    add.addText((t) => { exprEl = t.inputEl; t.setPlaceholder('price * quantity'); });
    add.addButton((b) => b.setButtonText("Add").onClick(() => {
      const name = nameEl.value.trim(), expr = exprEl.value.trim();
      if (!name || !/^[\p{L}_$][\p{L}\p{N}_$ -]*$/u.test(name)) { add.descEl.setText("Formula names must start with a letter."); return; }
      const bad = checkExpression(expr);
      if (bad) { add.descEl.setText(bad); return; }
      cfg.setFormula(name, expr);
      raw.order = [...order(), `formula.${name}`];
      this.c.configChanged("formulas");
      this.render();
    }));
  }
}
