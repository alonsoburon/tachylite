// Comparison of Tachylite with a dump from a real Obsidian (tools/obsidian-dump). Pure functions: each returns
// human-readable difference lines, empty when the two agree.

export interface RefHotkey { modifiers: string[]; key: string }
export interface RefCommand { id: string; name: string; hotkeys: RefHotkey[] }
export interface Reference {
  apiVersion?: string;
  commands?: RefCommand[];
  corePlugins?: { id: string; name: string; enabled: boolean }[];
  config?: Record<string, unknown>;
  menus?: Record<string, string[] | { error: string } | null>;
}

const hk = (h: RefHotkey) => `${[...h.modifiers].sort().join("+")}${h.modifiers.length ? "+" : ""}${h.key.length === 1 ? h.key.toLowerCase() : h.key}`;
const hks = (hs: RefHotkey[]) => hs.map(hk).sort().join(", ") || "(none)";

export function diffCommands(ref: RefCommand[], ours: RefCommand[]): string[] {
  const out: string[] = [];
  const mine = new Map(ours.map((c) => [c.id, c]));
  const theirs = new Set(ref.map((c) => c.id));
  for (const c of ref) {
    const m = mine.get(c.id);
    if (!m) { out.push(`missing command ${c.id} ("${c.name}"${c.hotkeys.length ? `, default ${hks(c.hotkeys)}` : ""})`); continue; }
    if (m.name !== c.name) out.push(`name of ${c.id}: Obsidian "${c.name}", Tachylite "${m.name}"`);
    if (hks(m.hotkeys) !== hks(c.hotkeys)) out.push(`default hotkeys of ${c.id}: Obsidian ${hks(c.hotkeys)}, Tachylite ${hks(m.hotkeys)}`);
  }
  for (const c of ours) if (!theirs.has(c.id)) out.push(`extra command ${c.id} ("${c.name}"): not in this Obsidian`);
  return out;
}

export function diffCorePlugins(ref: { id: string; name: string }[], ours: { id: string; name: string }[]): string[] {
  const out: string[] = [];
  const mine = new Map(ours.map((p) => [p.id, p]));
  for (const p of ref) {
    const m = mine.get(p.id);
    if (!m) out.push(`missing core plugin ${p.id} ("${p.name}")`);
    else if (m.name !== p.name) out.push(`name of core plugin ${p.id}: Obsidian "${p.name}", Tachylite "${m.name}"`);
  }
  const theirs = new Set(ref.map((p) => p.id));
  for (const p of ours) if (!theirs.has(p.id)) out.push(`extra core plugin ${p.id} ("${p.name}")`);
  return out;
}

export function diffMenu(name: string, ref: string[], ours: string[]): string[] {
  if (JSON.stringify(ref) === JSON.stringify(ours)) return [];
  const out: string[] = [];
  const titles = (l: string[]) => l.filter((t) => t !== "---");
  const r = titles(ref), o = titles(ours);
  const missing = r.filter((t) => !o.includes(t)), extra = o.filter((t) => !r.includes(t));
  if (missing.length) out.push(`${name}: Obsidian has ${missing.map((t) => `"${t}"`).join(", ")}`);
  if (extra.length) out.push(`${name}: only Tachylite has ${extra.map((t) => `"${t}"`).join(", ")}`);
  const shared = r.filter((t) => o.includes(t));
  if (!missing.length && !extra.length && JSON.stringify(r) !== JSON.stringify(o)) out.push(`${name}: same entries, different order. Obsidian: ${r.join(" | ")}. Tachylite: ${o.join(" | ")}`);
  else if (shared.length > 1 && JSON.stringify(shared) !== JSON.stringify(o.filter((t) => r.includes(t)))) out.push(`${name}: shared entries are ordered differently`);
  if (!missing.length && !extra.length && JSON.stringify(r) === JSON.stringify(o)) out.push(`${name}: same entries, different separators. Obsidian: ${ref.join(" | ")}. Tachylite: ${ours.join(" | ")}`);
  return out;
}

export function diffMenus(ref: NonNullable<Reference["menus"]>, ours: Record<string, string[] | null>): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(ref)) {
    if (!Array.isArray(list)) continue; // could not be opened in Obsidian
    const mine = ours[name];
    if (!mine) { out.push(`${name}: not compared (Tachylite menu was not opened)`); continue; }
    out.push(...diffMenu(name, list, mine));
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffConfig(ref: Record<string, unknown>, get: (key: string) => unknown): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(ref)) {
    const mine = get(k);
    if (mine === undefined) out.push(`config ${k}: Obsidian ${JSON.stringify(v)}, Tachylite has no default`);
    else if (!same(mine, v)) out.push(`config ${k}: Obsidian ${JSON.stringify(v)}, Tachylite ${JSON.stringify(mine)}`);
  }
  return out;
}

export function formatReport(sections: [string, string[]][]): string {
  const lines: string[] = [];
  let total = 0;
  for (const [title, diffs] of sections) {
    total += diffs.length;
    lines.push(`## ${title}: ${diffs.length ? `${diffs.length} difference${diffs.length === 1 ? "" : "s"}` : "no differences"}`);
    for (const d of diffs) lines.push(`  - ${d}`);
  }
  lines.push("", `${total} difference${total === 1 ? "" : "s"} in total`);
  return lines.join("\n");
}
