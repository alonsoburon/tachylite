// Built-in "cards" Bases view: a grid of cards with an optional cover image property.
import { ImageValue, LinkValue, ListValue, NullValue, StringValue, resolveResource, type Value } from "../../obsidian/values";
import { BasesView, type QueryController } from "../api";
import { groupLabel, renderValue } from "./common";

/** Image source (URL / resource path) or colour for a cover value. */
export function coverOf(app: any, v: Value | null, sourcePath: string): { url?: string; color?: string } | null {
  if (!v || v instanceof NullValue) return null;
  if (v instanceof ListValue) return coverOf(app, v.value[0] ?? null, sourcePath);
  if (v instanceof LinkValue) {
    if (v.isExternal) return { url: v.value };
    const f = v.resolve(app);
    return f ? { url: app.vault.getResourcePath(f) } : null;
  }
  if (v instanceof ImageValue) return { url: resolveResource(app, v.value, sourcePath) };
  if (v instanceof StringValue) {
    const s = v.value.trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return { color: s };
    if (/^(https?:|data:image\/)/i.test(s)) return { url: s };
    if (s) return { url: resolveResource(app, s, sourcePath) };
  }
  return null;
}

export class CardsView extends BasesView {
  type = "cards";
  private root: HTMLElement;
  constructor(controller: QueryController, public containerEl: HTMLElement) {
    super(controller);
    this.root = containerEl.createDiv({ cls: "bases-cards-container" });
  }
  onDataUpdated(): void {
    const root = this.root;
    root.empty();
    const size = Number(this.config.get("cardSize"));
    if (size > 0) root.style.setProperty("--bases-cards-width", `${size}px`); else root.style.removeProperty("--bases-cards-width");
    const ratio = Number(this.config.get("imageAspectRatio"));
    root.style.setProperty("--bases-cards-ratio", String(ratio > 0 ? ratio : 1));
    root.toggleClass("mod-image-contain", this.config.get("imageFit") === "contain");
    const imageProp = this.config.getAsPropertyId("image");
    const props = this.data.properties;
    const groupProp = (this.config.get("groupBy") as any)?.property ? String((this.config.get("groupBy") as any).property) : null;
    for (const g of this.data.groupedData) {
      const groupEl = root.createDiv({ cls: "bases-cards-group" });
      if (groupProp) groupLabel(groupEl, g, groupProp, (p) => this.config.getDisplayName(p));
      const grid = groupEl.createDiv({ cls: "bases-cards-grid" });
      for (const e of g.entries) {
        const card = grid.createDiv({ cls: "bases-cards-item", attr: { "data-path": e.file.path } });
        if (imageProp) {
          const cover = card.createDiv({ cls: "bases-cards-cover" });
          const c = coverOf(this.app, e.getValue(imageProp), e.file.path);
          if (c?.color) cover.style.backgroundColor = c.color;
          else if (c?.url) cover.createEl("img", { attr: { src: c.url, alt: "", loading: "lazy" } });
          else cover.addClass("is-empty");
        }
        props.forEach((p, i) => {
          const line = card.createDiv({ cls: "bases-cards-property" + (i === 0 ? " mod-title" : ""), attr: { "data-property": p } });
          if (i > 0) line.createDiv({ cls: "bases-cards-label", text: this.config.getDisplayName(p) });
          renderValue(line.createDiv({ cls: "bases-cards-line" }), this.app, e, p);
        });
        card.addEventListener("click", (evt) => {
          if ((evt.target as HTMLElement).closest("a")) return;
          void this.app.workspace.getLeaf(evt.ctrlKey || evt.metaKey ? "tab" : false).openFile(e.file);
        });
      }
    }
    if (!this.data.data.length) root.createDiv({ cls: "bases-empty", text: "No results" });
  }
}
