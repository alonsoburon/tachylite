// Turn pasted HTML into Markdown, like Obsidian's "Auto convert HTML" paste behaviour.
const SKIP = new Set(["script", "style", "meta", "link", "head", "title", "noscript", "template"]);

function esc(text: string): string {
  return text.replace(/\s+/g, " ").replace(/([\\`*_[\]])/g, "\\$1");
}

function inline(node: Node): string {
  if (node.nodeType === 3) return esc(node.textContent ?? "");
  if (node.nodeType !== 1) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag)) return "";
  const inner = () => [...el.childNodes].map(inline).join("");
  const wrap = (m: string) => { const t = inner(); const s = t.trim(); return s ? `${t.match(/^\s*/)![0]}${m}${s}${m}${t.match(/\s*$/)![0]}` : t; };
  switch (tag) {
    case "br": return "\n";
    case "strong": case "b": return wrap("**");
    case "em": case "i": return wrap("*");
    case "del": case "s": case "strike": return wrap("~~");
    case "mark": return wrap("==");
    case "code": { const t = el.textContent ?? ""; return t ? "`" + t.replace(/`/g, "\\`") + "`" : ""; }
    case "a": {
      const href = el.getAttribute("href");
      const t = inner().trim();
      if (!href || href.startsWith("javascript:")) return t;
      return t ? `[${t}](${href.replace(/ /g, "%20").replace(/\)/g, "%29")})` : "";
    }
    case "img": {
      const src = el.getAttribute("src");
      return src && !src.startsWith("data:") ? `![${el.getAttribute("alt") ?? ""}](${src.replace(/ /g, "%20")})` : "";
    }
    case "input": return el.getAttribute("type") === "checkbox" ? (el.hasAttribute("checked") ? "[x] " : "[ ] ") : "";
    default: return inner();
  }
}

function list(el: HTMLElement, depth: number): string {
  const ordered = el.tagName.toLowerCase() === "ol";
  let n = parseInt(el.getAttribute("start") ?? "1", 10) || 1;
  const lines: string[] = [];
  for (const li of el.children) {
    if (li.tagName.toLowerCase() !== "li") continue;
    const pad = "\t".repeat(depth);
    const text: string[] = [];
    const nested: string[] = [];
    for (const c of li.childNodes) {
      const t = c.nodeType === 1 ? (c as HTMLElement).tagName.toLowerCase() : "";
      if (t === "ul" || t === "ol") nested.push(list(c as HTMLElement, depth + 1));
      else if (t === "p" || t === "div") text.push(inline(c).trim());
      else text.push(inline(c));
    }
    const body = text.join(" ").replace(/\s+/g, " ").trim();
    lines.push(`${pad}${ordered ? `${n++}.` : "-"} ${body}`);
    lines.push(...nested);
  }
  return lines.join("\n");
}

function table(el: HTMLElement): string {
  const rows = [...el.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => inline(c).trim().replace(/\|/g, "\\|").replace(/\n/g, " ")));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const fmt = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [fmt(rows[0]), fmt(Array(width).fill("---")), ...rows.slice(1).map(fmt)].join("\n");
}

function block(node: Node, out: string[]): void {
  if (node.nodeType === 3) { const t = esc(node.textContent ?? "").trim(); if (t) out.push(t); return; }
  if (node.nodeType !== 1) return;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag)) return;
  if (/^h[1-6]$/.test(tag)) { const t = inline(el).trim(); if (t) out.push(`${"#".repeat(Number(tag[1]))} ${t}`); return; }
  switch (tag) {
    case "ul": case "ol": out.push(list(el, 0)); return;
    case "pre": out.push("```\n" + (el.textContent ?? "").replace(/\n$/, "") + "\n```"); return;
    case "blockquote": {
      const inner: string[] = [];
      for (const c of el.childNodes) block(c, inner);
      out.push(inner.join("\n\n").split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
      return;
    }
    case "hr": out.push("---"); return;
    case "table": out.push(table(el)); return;
    case "p": { const t = inline(el).trim(); if (t) out.push(t); return; }
    case "div": case "section": case "article": case "body": case "html": case "main": case "header": case "footer": case "figure": case "span": case "a": case "strong": case "em": case "b": case "i": case "code": case "img": case "br": case "del": case "s": case "mark": {
      const blocky = [...el.children].some((c) => /^(p|div|ul|ol|h[1-6]|pre|blockquote|table|hr|section|article)$/i.test(c.tagName));
      if (!blocky) { const t = inline(el).trim(); if (t) out.push(t); return; }
      for (const c of el.childNodes) block(c, out);
      return;
    }
    default: for (const c of el.childNodes) block(c, out);
  }
}

/** Markdown for a clipboard HTML fragment, or null when it has no structure worth converting. */
export function htmlToMarkdown(html: string, plain = ""): string | null {
  if (!html.trim()) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];
  block(doc.body, out);
  const md = out.join("\n\n").trim();
  if (!md) return null;
  const same = (s: string) => s.replace(/\s+/g, " ").trim();
  return same(md) === same(plain) ? null : md;
}
