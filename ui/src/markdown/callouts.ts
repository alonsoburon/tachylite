import { calloutIcon, chevronIcon } from "./icons";

/** Convert `> [!type]±` blockquotes inside `root` into Obsidian-style callout DOM. */
export function processCallouts(root: HTMLElement): void {
  const quotes = Array.from(root.querySelectorAll("blockquote")).reverse(); // innermost first
  for (const bq of quotes) {
    const first = bq.firstElementChild;
    if (!first || first.tagName !== "P") continue;
    const fc = first.firstChild;
    if (!fc || fc.nodeType !== 3) continue;
    const m = /^\[!([^\]\s]+)\]([+-])?[ \t]*/.exec(fc.textContent ?? "");
    if (!m) continue;
    const type = m[1].toLowerCase();
    const fold = m[2] ?? "";
    fc.textContent = (fc.textContent ?? "").slice(m[0].length);

    // split first paragraph at first line break: title | rest
    const titleNodes: Node[] = [];
    const restNodes: Node[] = [];
    let inTitle = true;
    for (const n of Array.from(first.childNodes)) {
      if (!inTitle) {
        restNodes.push(n);
        continue;
      }
      if (n.nodeType === 1 && (n as Element).tagName === "BR") {
        inTitle = false;
        continue;
      }
      if (n.nodeType === 3 && (n.textContent ?? "").includes("\n")) {
        const t = n.textContent ?? "";
        const k = t.indexOf("\n");
        titleNodes.push(document.createTextNode(t.slice(0, k)));
        restNodes.push(document.createTextNode(t.slice(k + 1)));
        inTitle = false;
        continue;
      }
      titleNodes.push(n);
    }

    const callout = document.createElement("div");
    callout.className = "callout";
    callout.setAttribute("data-callout", type);
    callout.setAttribute("data-callout-metadata", "");
    callout.setAttribute("data-callout-fold", fold);
    if (fold) callout.classList.add("is-collapsible");
    if (fold === "-") callout.classList.add("is-collapsed");

    const title = document.createElement("div");
    title.className = "callout-title";
    const icon = document.createElement("div");
    icon.className = "callout-icon";
    icon.appendChild(calloutIcon(type));
    const inner = document.createElement("div");
    inner.className = "callout-title-inner";
    const hasTitle = titleNodes.some((n) => (n.textContent ?? "").trim() !== "" || n.nodeType === 1);
    if (hasTitle) titleNodes.forEach((n) => inner.appendChild(n));
    else inner.textContent = type.charAt(0).toUpperCase() + type.slice(1);
    title.append(icon, inner);
    if (fold) {
      const f = document.createElement("div");
      f.className = "callout-fold" + (fold === "-" ? " is-collapsed" : "");
      f.appendChild(chevronIcon());
      title.appendChild(f);
      title.setAttribute("role", "button");
      title.tabIndex = 0;
      const toggle = () => {
        const c = callout.classList.toggle("is-collapsed");
        f.classList.toggle("is-collapsed", c);
        callout.setAttribute("aria-expanded", String(!c));
      };
      title.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("a")) return;
        toggle();
      });
      title.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    }

    const content = document.createElement("div");
    content.className = "callout-content";
    if (restNodes.some((n) => (n.textContent ?? "").trim() !== "" || n.nodeType === 1)) {
      const p = document.createElement("p");
      restNodes.forEach((n) => p.appendChild(n));
      content.appendChild(p);
    }
    first.remove();
    while (bq.firstChild) content.appendChild(bq.firstChild);
    callout.append(title, content);
    bq.replaceWith(callout);
  }
}
