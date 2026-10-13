import {
  Pencil, Info, ClipboardList, Flame, Check, CircleQuestionMark, TriangleAlert, X, Zap, Bug, List, Quote,
  ChevronDown, Copy, Link as LinkIcon, ClipboardCheck, Lightbulb, Hash,
} from "lucide";

type IconNode = [string, Record<string, string | number>][];
const SVG_NS = "http://www.w3.org/2000/svg";

export function svgIcon(node: IconNode, cls = "svg-icon"): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  const attrs: Record<string, string> = {
    xmlns: SVG_NS, width: "24", height: "24", viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
    class: cls,
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const [tag, a] of node) {
    const c = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(a)) c.setAttribute(k, String(v));
    svg.appendChild(c);
  }
  return svg;
}

const CALLOUT_ICONS: Record<string, IconNode> = {
  note: Pencil as IconNode,
  abstract: ClipboardList as IconNode,
  info: Info as IconNode,
  todo: ClipboardCheck as IconNode,
  tip: Flame as IconNode,
  success: Check as IconNode,
  question: CircleQuestionMark as IconNode,
  warning: TriangleAlert as IconNode,
  failure: X as IconNode,
  danger: Zap as IconNode,
  bug: Bug as IconNode,
  example: List as IconNode,
  quote: Quote as IconNode,
};

const ALIASES: Record<string, string> = {
  summary: "abstract", tldr: "abstract", hint: "tip", important: "tip", check: "success", done: "success",
  help: "question", faq: "question", caution: "warning", attention: "warning", fail: "failure",
  missing: "failure", error: "danger", cite: "quote",
};

export function canonicalCallout(type: string): string {
  const t = type.toLowerCase();
  return ALIASES[t] ?? (CALLOUT_ICONS[t] ? t : "note");
}

export function calloutIcon(type: string): SVGElement {
  return svgIcon(CALLOUT_ICONS[canonicalCallout(type)], "svg-icon");
}
export const chevronIcon = () => svgIcon(ChevronDown as IconNode, "svg-icon right-triangle");
export const copyIcon = () => svgIcon(Copy as IconNode);
export const linkIcon = () => svgIcon(LinkIcon as IconNode);
export const lightbulbIcon = () => svgIcon(Lightbulb as IconNode);
export const hashIcon = () => svgIcon(Hash as IconNode);
