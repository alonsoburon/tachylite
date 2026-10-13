import { chevronIcon } from "./icons";

export interface FrontmatterInfo {
  frontmatter: Record<string, unknown> | null;
  raw: string | null;
  error?: string;
}

/** Build the collapsed properties block. `inlineHtml` renders markdown inline (wikilinks) to HTML. */
export function renderFrontmatter(info: FrontmatterInfo, inlineHtml: (s: string) => string): HTMLElement {
  const c = document.createElement("div");
  c.className = "frontmatter-container metadata-container is-collapsed";
  const head = document.createElement("div");
  head.className = "metadata-properties-heading";
  head.setAttribute("role", "button");
  head.tabIndex = 0;
  const ind = document.createElement("div");
  ind.className = "collapse-indicator collapse-icon is-collapsed";
  ind.appendChild(chevronIcon());
  const title = document.createElement("div");
  title.className = "metadata-properties-title";
  title.textContent = "Properties";
  head.append(ind, title);
  const content = document.createElement("div");
  content.className = "metadata-content";
  c.append(head, content);

  if (!info.frontmatter) {
    const pre = document.createElement("pre");
    pre.className = "frontmatter language-yaml";
    pre.textContent = info.raw ?? "";
    content.appendChild(pre);
    return c;
  }
  const props = document.createElement("div");
  props.className = "metadata-properties";
  for (const [key, val] of Object.entries(info.frontmatter)) {
    const row = document.createElement("div");
    row.className = "metadata-property";
    row.setAttribute("data-property-key", key);
    const k = document.createElement("div");
    k.className = "metadata-property-key";
    const kt = document.createElement("span");
    kt.className = "metadata-property-key-text";
    kt.textContent = key;
    k.appendChild(kt);
    const v = document.createElement("div");
    v.className = "metadata-property-value";
    fillValue(v, key, val, row, inlineHtml);
    row.append(k, v);
    props.appendChild(row);
  }
  content.appendChild(props);
  return c;
}

function fillValue(v: HTMLElement, key: string, val: unknown, row: HTMLElement, inlineHtml: (s: string) => string) {
  const isTags = key === "tags" || key === "tag";
  if (Array.isArray(val)) {
    row.setAttribute("data-property-type", isTags ? "tags" : "multitext");
    const box = document.createElement("div");
    box.className = "multi-select-container";
    for (const item of val) {
      const pill = document.createElement("div");
      pill.className = "multi-select-pill";
      const inner = document.createElement("div");
      inner.className = "multi-select-pill-content";
      if (isTags) {
        const t = String(item).replace(/^#/, "");
        inner.innerHTML = `<a class="tag" href="#${escapeAttr(t)}">#${escapeText(t)}</a>`;
      } else inner.innerHTML = inlineHtml(String(item));
      pill.appendChild(inner);
      box.appendChild(pill);
    }
    v.appendChild(box);
  } else if (typeof val === "boolean") {
    row.setAttribute("data-property-type", "checkbox");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "metadata-input-checkbox";
    cb.checked = val;
    cb.disabled = true;
    v.appendChild(cb);
  } else if (typeof val === "number") {
    row.setAttribute("data-property-type", "number");
    v.textContent = String(val);
  } else if (val instanceof Date) {
    row.setAttribute("data-property-type", "date");
    v.textContent = val.toISOString().slice(0, 10);
  } else if (val !== null && typeof val === "object") {
    row.setAttribute("data-property-type", "unknown");
    v.textContent = JSON.stringify(val);
  } else {
    row.setAttribute("data-property-type", "text");
    const s = val == null ? "" : String(val);
    if (isTags && s) {
      v.innerHTML = s.split(/[\s,]+/).filter(Boolean).map((t) => `<a class="tag" href="#${escapeAttr(t.replace(/^#/, ""))}">#${escapeText(t.replace(/^#/, ""))}</a>`).join(" ");
    } else if (s.includes("[[")) v.innerHTML = inlineHtml(s);
    else v.textContent = s;
  }
}

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");
