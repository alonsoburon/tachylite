// Built-in "list" Bases view: one list item per file, other properties inline or indented.
import { NullValue } from "../../obsidian/values";
import { BasesView, type QueryController } from "../api";
import { groupLabel, renderValue } from "./common";

export class ListView extends BasesView {
  type = "list";
  private root: HTMLElement;
  constructor(controller: QueryController, public containerEl: HTMLElement) {
    super(controller);
    this.root = containerEl.createDiv({ cls: "bases-list-container" });
  }
  onDataUpdated(): void {
    const root = this.root;
    root.empty();
    const markers = String(this.config.get("markers") ?? "bullet");
    const indent = !!this.config.get("indentProperties");
    const sepRaw = this.config.get("separator");
    const sep = typeof sepRaw === "string" ? sepRaw : ", ";
    const [first, ...rest] = this.data.properties;
    const groupProp = (this.config.get("groupBy") as any)?.property ? String((this.config.get("groupBy") as any).property) : null;
    for (const g of this.data.groupedData) {
      const groupEl = root.createDiv({ cls: "bases-list-group" });
      if (groupProp) groupLabel(groupEl, g, groupProp, (p) => this.config.getDisplayName(p));
      const list = groupEl.createEl(markers === "number" ? "ol" : "ul", { cls: `bases-list-group-list mod-markers-${markers}` });
      for (const e of g.entries) {
        const li = list.createEl("li", { cls: "bases-list-item", attr: { "data-path": e.file.path } });
        const main = li.createDiv({ cls: "bases-list-property mod-primary", attr: { "data-property": first ?? "file.name" } });
        renderValue(main, this.app, e, first ?? "file.name");
        const shown = rest.filter((p) => { const v = e.getValue(p); return v && !(v instanceof NullValue) && v.toString() !== ""; });
        if (!shown.length) continue;
        if (indent) {
          const sub = li.createEl("ul", { cls: "bases-list-item-properties" });
          for (const p of shown) {
            const item = sub.createEl("li", { cls: "bases-list-property", attr: { "data-property": p } });
            item.createSpan({ cls: "bases-list-property-label", text: this.config.getDisplayName(p) + ": " });
            renderValue(item, this.app, e, p);
          }
        } else {
          for (const p of shown) {
            li.createSpan({ cls: "bases-list-separator", text: sep });
            renderValue(li.createDiv({ cls: "bases-list-property", attr: { "data-property": p } }), this.app, e, p);
          }
        }
      }
    }
    if (!this.data.data.length) root.createDiv({ cls: "bases-empty", text: "No results" });
  }
}
