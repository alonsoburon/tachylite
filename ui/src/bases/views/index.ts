// Registrations of the built-in Bases view types (same shape plugins pass to Plugin.registerBasesView).
import type { BasesViewRegistration } from "../api";
import { CardsView } from "./cards";
import { ListView } from "./list";
import { TableView } from "./table";

export const CORE_VIEWS: Record<string, BasesViewRegistration> = {
  table: {
    name: "Table", icon: "lucide-table", factory: (c, el) => new TableView(c, el),
    options: () => [{ type: "dropdown", key: "rowHeight", displayName: "Row height", default: "", options: { "": "Short", medium: "Medium", tall: "Tall", extra: "Extra tall" } }],
  },
  cards: {
    name: "Cards", icon: "lucide-layout-grid", factory: (c, el) => new CardsView(c, el),
    options: () => [
      { type: "slider", key: "cardSize", displayName: "Card size", min: 50, max: 800, step: 10, default: 200 },
      { type: "property", key: "image", displayName: "Image property", placeholder: "None" },
      { type: "dropdown", key: "imageFit", displayName: "Image fit", default: "", options: { "": "Cover", contain: "Contain" } },
      { type: "slider", key: "imageAspectRatio", displayName: "Image aspect ratio", min: 0.25, max: 2.5, step: 0.05, default: 1 },
    ],
  },
  list: {
    name: "List", icon: "lucide-list", factory: (c, el) => new ListView(c, el),
    options: () => [
      { type: "dropdown", key: "markers", displayName: "Markers", default: "bullet", options: { bullet: "Bullets", number: "Numbers", none: "None" } },
      { type: "toggle", key: "indentProperties", displayName: "Indent properties", default: false },
      { type: "text", key: "separator", displayName: "Separator", default: ", " },
    ],
  },
};
