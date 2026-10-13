// Built-in "table" Bases view: sortable, resizable columns, editable note-property cells, group headings, summaries.
import { Menu } from "../../obsidian/ui";
import { setIcon } from "../../obsidian/icons";
import { BooleanValue, ListValue } from "../../obsidian/values";
import { BasesView, DEFAULT_SUMMARIES, type BasesEntry, type QueryController } from "../api";
import { splitPropertyId } from "../config";
import { cellInputText, groupLabel, isEditable, parseCellInput, renderPlain, renderValue, writeProperty } from "./common";

const MIN_COL = 60;
const TYPE_ICONS: Record<string, string> = { file: "lucide-file", formula: "lucide-function-square", note: "lucide-text" };

export class TableView extends BasesView {
  type = "table";
  private scrollEl: HTMLElement;
  constructor(controller: QueryController, public containerEl: HTMLElement) {
    super(controller);
    this.scrollEl = containerEl.createDiv({ cls: "bases-table-container" });
  }

  private widths(): Record<string, number> {
    const v = this.config.get("columnSize");
    return v && typeof v === "object" ? { ...(v as Record<string, number>) } : {};
  }
  private sortState(prop: string): "ASC" | "DESC" | null {
    return this.config.getSort().find((s) => s.property === prop)?.direction ?? null;
  }
  /** Header click: ascending, descending, then no sort on this column (other sorts are dropped). */
  private cycleSort(prop: string): void {
    const cur = this.sortState(prop);
    this.config.set("sort", cur === null ? [{ property: prop, direction: "ASC" }] : cur === "ASC" ? [{ property: prop, direction: "DESC" }] : null);
  }

  onDataUpdated(): void {
    const keepScroll = { top: this.scrollEl.scrollTop, left: this.scrollEl.scrollLeft };
    this.scrollEl.empty();
    const props = this.data.properties;
    const widths = this.widths();
    const rh = String(this.config.get("rowHeight") ?? "");
    const table = this.scrollEl.createEl("table", { cls: "bases-table" + (rh ? ` mod-row-height-${rh}` : "") });
    const colgroup = table.createEl("colgroup");
    for (const p of props) { const c = colgroup.createEl("col"); if (widths[p]) c.style.width = `${widths[p]}px`; }
    const thead = table.createEl("thead", { cls: "bases-thead" });
    const hr = thead.createEl("tr", { cls: "bases-tr" });
    props.forEach((p, i) => this.header(hr, p, colgroup.children[i] as HTMLElement));

    const summaries = (this.config.get("summaries") as Record<string, string> | undefined) ?? {};
    const sumProps = Object.keys(summaries).filter((k) => props.includes(k) || props.includes(`note.${k}`));
    const groupProp = (this.config.get("groupBy") as any)?.property ? String((this.config.get("groupBy") as any).property) : null;
    const grouped = !!groupProp;
    for (const g of this.data.groupedData) {
      const tbody = table.createEl("tbody", { cls: "bases-tbody" });
      if (grouped) {
        const tr = tbody.createEl("tr", { cls: "bases-group-row" });
        const td = tr.createEl("td", { attr: { colspan: String(props.length) } });
        groupLabel(td, g, groupProp, (p) => this.config.getDisplayName(p));
        if (sumProps.length) this.summaryRow(tbody, props, g.entries, summaries, "bases-table-group-summary-row");
      }
      for (const e of g.entries) this.row(tbody, e, props);
    }
    if (!this.data.data.length) {
      const tr = table.createEl("tbody", { cls: "bases-tbody" }).createEl("tr", { cls: "bases-tr bases-empty" });
      tr.createEl("td", { cls: "bases-td", text: "No results", attr: { colspan: String(props.length) } });
    }
    if (sumProps.length) this.summaryRow(table.createEl("tfoot", { cls: "bases-table-footer" }), props, this.data.data, summaries, "bases-table-summary-row");
    this.scrollEl.scrollTop = keepScroll.top;
    this.scrollEl.scrollLeft = keepScroll.left;
  }

  private header(tr: HTMLElement, prop: string, col: HTMLElement): void {
    const th = tr.createEl("th", { cls: "bases-table-header", attr: { "data-property": prop } });
    const name = th.createDiv({ cls: "bases-table-header-name" });
    setIcon(name.createSpan({ cls: "bases-table-header-icon" }), TYPE_ICONS[splitPropertyId(prop).type]);
    name.createSpan({ cls: "bases-table-header-label", text: this.config.getDisplayName(prop) });
    const dir = this.sortState(prop);
    if (dir) setIcon(name.createSpan({ cls: "bases-table-header-sort", attr: { "data-direction": dir } }), dir === "ASC" ? "lucide-arrow-up" : "lucide-arrow-down");
    name.addEventListener("click", () => this.cycleSort(prop));
    th.addEventListener("contextmenu", (evt) => { evt.preventDefault(); this.headerMenu(prop).showAtMouseEvent(evt); });
    const handle = th.createDiv({ cls: "bases-table-header-resizer" });
    handle.addEventListener("mousedown", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const startX = evt.clientX, startW = th.getBoundingClientRect().width || MIN_COL * 2;
      let w = startW;
      const move = (e: MouseEvent) => { w = Math.max(MIN_COL, Math.round(startW + e.clientX - startX)); col.style.width = `${w}px`; th.style.width = `${w}px`; };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        const sizes = this.widths();
        sizes[prop] = w;
        this.config.set("columnSize", sizes);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  private headerMenu(prop: string): Menu {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Sort ascending").setIcon("lucide-arrow-up").onClick(() => this.config.set("sort", [{ property: prop, direction: "ASC" }])));
    menu.addItem((i) => i.setTitle("Sort descending").setIcon("lucide-arrow-down").onClick(() => this.config.set("sort", [{ property: prop, direction: "DESC" }])));
    menu.addSeparator();
    const sums = { ...((this.config.get("summaries") as Record<string, string>) ?? {}) };
    for (const s of [...DEFAULT_SUMMARIES, ...Object.keys(this.config.base.summaries)]) {
      menu.addItem((i) => i.setTitle(`Summarize: ${s}`).setIcon("lucide-calculator").setChecked(sums[prop] === s).onClick(() => {
        if (sums[prop] === s) delete sums[prop]; else sums[prop] = s;
        this.config.set("summaries", Object.keys(sums).length ? sums : null);
      }));
    }
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Hide property").setIcon("lucide-eye-off").onClick(() => {
      const order = this.config.getOrder().filter((p) => p !== prop);
      this.config.set("order", order.length ? order : null);
    }));
    return menu;
  }

  private summaryRow(parent: HTMLElement, props: string[], entries: BasesEntry[], summaries: Record<string, string>, cls: string): void {
    const tr = parent.createEl("tr", { cls: `bases-tr ${cls}` });
    for (const p of props) {
      const td = tr.createEl("td", { cls: "bases-td bases-table-summary-cell", attr: { "data-property": p } });
      const key = summaries[p] ?? summaries[p.replace(/^note\./, "")];
      if (!key) continue;
      td.createSpan({ cls: "bases-summary-label", text: key });
      renderPlain(td.createSpan({ cls: "bases-summary-value" }), this.data.getSummaryValue(this.controller, entries, p, key));
    }
  }

  private row(tbody: HTMLElement, e: BasesEntry, props: string[]): void {
    const tr = tbody.createEl("tr", { cls: "bases-tr", attr: { "data-path": e.file.path } });
    for (const p of props) {
      const td = tr.createEl("td", { cls: "bases-td", attr: { "data-property": p } });
      const cell = td.createDiv({ cls: "bases-table-cell" });
      const v = e.getValue(p);
      if (v instanceof BooleanValue && isEditable(p, e.file)) {
        const cb = cell.createEl("input", { cls: "bases-checkbox", attr: { type: "checkbox" } });
        cb.checked = v.value;
        cb.addEventListener("change", () => { void writeProperty(this.app, e.file, p, cb.checked); });
        continue;
      }
      renderValue(cell, this.app, e, p);
      if (isEditable(p, e.file)) {
        cell.addClass("is-editable");
        cell.addEventListener("click", (evt) => {
          if ((evt.target as HTMLElement).closest("a")) return;
          this.edit(cell, e, p);
        });
      }
    }
  }

  /** Inline editor for a note property; Enter/blur commits through processFrontMatter, Escape cancels. */
  private edit(cell: HTMLElement, e: BasesEntry, prop: string): void {
    if (cell.querySelector("input")) return;
    const prev = e.getValue(prop);
    const original = cellInputText(prev);
    cell.empty();
    cell.addClass("is-editing");
    const input = cell.createEl("input", { cls: "bases-cell-input", attr: { type: "text", spellcheck: "false" } });
    input.value = original;
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      cell.removeClass("is-editing");
      if (commit && input.value !== original) {
        void writeProperty(this.app, e.file, prop, parseCellInput(input.value, prev instanceof ListValue || prop === "note.tags" ? prev ?? new ListValue([]) : prev));
      } else {
        cell.empty();
        renderValue(cell, this.app, e, prop);
      }
    };
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") { evt.preventDefault(); finish(true); }
      else if (evt.key === "Escape") { evt.preventDefault(); finish(false); }
      evt.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
  }
}
