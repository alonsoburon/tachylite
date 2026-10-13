// Icon registry: lucide icons (ids `lucide-<name>` or bare `<name>`) plus plugin-registered icons.
import { icons as lucideIcons } from "lucide";

type IconNode = [string, Record<string, string>][];
const SVG_NS = "http://www.w3.org/2000/svg";
const custom = new Map<string, string>();

function pascal(name: string): string {
  return name.replace(/(^|[-_ ])(\w)/g, (_m, _s, c: string) => c.toUpperCase());
}
/** Ids that older lucide releases (the ones Obsidian ships) accepted and newer ones renamed. */
const ALIASES: Record<string, string> = {
  dice: "dices", layout: "panels-top-left", "kanban-square": "square-kanban", "check-square": "square-check-big", "x-square": "square-x",
  "plus-square": "square-plus", "minus-square": "square-minus", edit: "square-pen", "edit-2": "pen", "edit-3": "pen-line", "help-circle": "circle-help",
  "alert-circle": "circle-alert", "alert-triangle": "triangle-alert", "check-circle": "circle-check-big", "check-circle-2": "circle-check", "x-circle": "circle-x",
  "more-vertical": "ellipsis-vertical", "more-horizontal": "ellipsis", "play-circle": "circle-play", "pause-circle": "circle-pause", "stop-circle": "circle-stop",
  "arrow-up-circle": "circle-arrow-up", "arrow-down-circle": "circle-arrow-down", "user-circle": "circle-user", sliders: "sliders-vertical", unlock: "lock-open",
  "bar-chart": "chart-no-axes-column", "bar-chart-2": "chart-no-axes-column-increasing", "line-chart": "chart-line", "pie-chart": "chart-pie", home: "house",
  "wand-2": "wand-sparkles", sidebar: "panel-left", "sidebar-open": "panel-left-open", "sidebar-close": "panel-left-close", "file-spreadsheet": "file-spreadsheet",
  spreadsheet: "sheet", "layout-grid": "layout-grid", "calendar-day": "calendar", "arrow-enter": "corner-down-left", document: "file", "calendar-with-checkmark": "calendar-check", "image-file": "file-image", "audio-file": "file-audio", "video-file": "file-video", "pdf-file": "file-text", "create-new": "square-pen", "go-to-file": "file-search", "paper-plane": "send", "vertical-three-dots": "ellipsis-vertical", "horizontal-split": "separator-horizontal", "vertical-split": "separator-vertical", "star-list": "list-todo", "bullet-list": "list", "number-list": "list-ordered", "code-2": "code-xml", "double-up-arrow-glyph": "chevrons-up", "double-down-arrow-glyph": "chevrons-down", "up-chevron-glyph": "chevron-up", "down-chevron-glyph": "chevron-down", "right-triangle": "chevron-right", "left-arrow": "arrow-left", "right-arrow": "arrow-right", "link-glyph": "link", "search-glyph": "search", "cross": "x", "checkmark": "check", "plus-with-circle": "circle-plus", "minus-with-circle": "circle-minus", "cross-in-box": "square-x", "lock-glyph": "lock", "help": "circle-help", "reset": "rotate-ccw", "restore-file-glyph": "history", "crossed-star": "star-off", "any-key": "keyboard", "stacked-levels": "layers", "audio-file-glyph": "file-audio", "workspace-glyph": "layout-dashboard", "gear": "settings", "trash": "trash-2", "pin": "pin", "open-vault": "vault", "folder": "folder", "star": "star", "enter": "corner-down-left",
};
function lucideNode(id: string): { name: string; node: IconNode } | null {
  const name = id.replace(/^lucide-/, "");
  const table = lucideIcons as Record<string, IconNode>;
  const node = table[pascal(name)] ?? (ALIASES[name] ? table[pascal(ALIASES[name])] : undefined);
  return node ? { name, node } : null;
}

export function addIcon(iconId: string, svgContent: string): void { custom.set(iconId, svgContent); }
export function removeIcon(iconId: string): void { custom.delete(iconId); }

export function getIconIds(): string[] {
  const ids = Object.keys(lucideIcons).map((n) => "lucide-" + n.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([a-zA-Z])(\d)/g, "$1-$2").toLowerCase());
  return [...custom.keys(), ...ids];
}

export function getIcon(iconId: string): SVGSVGElement | null {
  const c = custom.get(iconId);
  if (c !== undefined) {
    const tpl = document.createElement("div");
    tpl.innerHTML = `<svg xmlns="${SVG_NS}" viewBox="0 0 100 100" class="svg-icon ${iconId}">${c}</svg>`;
    return tpl.firstElementChild as SVGSVGElement;
  }
  const l = lucideNode(iconId);
  if (!l) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ xmlns: SVG_NS, width: "24", height: "24", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", class: `svg-icon lucide-${l.name}` })) svg.setAttribute(k, v);
  for (const [tag, attrs] of l.node) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, String(v));
    svg.appendChild(child);
  }
  return svg;
}

export function setIcon(parent: HTMLElement, iconId: string): void {
  parent.empty?.();
  if (!parent.empty) while (parent.firstChild) parent.removeChild(parent.firstChild);
  const svg = getIcon(iconId);
  if (svg) parent.appendChild(svg);
  parent.setAttribute("data-icon", iconId);
}
