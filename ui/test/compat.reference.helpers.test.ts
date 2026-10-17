// The comparison helpers, against a small hand-made reference (not real Obsidian data).
import { describe, expect, it } from "vitest";
import { diffCommands, diffConfig, diffCorePlugins, diffMenu, diffMenus, formatReport } from "./helpers/reference";

const cmd = (id: string, name: string, hotkeys: { modifiers: string[]; key: string }[] = []) => ({ id, name, hotkeys });

describe("reference comparison", () => {
  it("reports missing, extra, renamed and re-bound commands, and ignores hotkey case and order", () => {
    const ref = [cmd("a:one", "One", [{ modifiers: ["Mod", "Shift"], key: "P" }]), cmd("a:two", "Two"), cmd("a:three", "Three", [{ modifiers: ["Mod"], key: "j" }]), cmd("a:four", "Four")];
    const ours = [cmd("a:one", "One", [{ modifiers: ["Shift", "Mod"], key: "p" }]), cmd("a:two", "Second"), cmd("a:three", "Three"), cmd("a:five", "Five")];
    expect(diffCommands(ref, ours)).toEqual([
      'name of a:two: Obsidian "Two", Tachylite "Second"',
      "default hotkeys of a:three: Obsidian Mod+j, Tachylite (none)",
      'missing command a:four ("Four")',
      'extra command a:five ("Five"): not in this Obsidian',
    ]);
    expect(diffCommands(ref.slice(0, 1), ours.slice(0, 1))).toEqual([]);
  });

  it("compares core plugins by id and name", () => {
    expect(diffCorePlugins([{ id: "x", name: "X" }, { id: "y", name: "Y" }], [{ id: "x", name: "Ex" }, { id: "z", name: "Z" }])).toEqual([
      'name of core plugin x: Obsidian "X", Tachylite "Ex"',
      'missing core plugin y ("Y")',
      'extra core plugin z ("Z")',
    ]);
  });

  it("compares menus: missing, extra, order and separators", () => {
    expect(diffMenu("m", ["A", "---", "B"], ["A", "---", "B"])).toEqual([]);
    expect(diffMenu("m", ["A", "B"], ["A", "C"])).toEqual(['m: Obsidian has "B"', 'm: only Tachylite has "C"']);
    expect(diffMenu("m", ["A", "B", "C"], ["A", "C", "B"])[0]).toContain("different order");
    expect(diffMenu("m", ["A", "---", "B"], ["A", "B"])[0]).toContain("different separators");
    expect(diffMenus({ file: ["A"], tab: null, gone: { error: "x" }, notOpened: ["Q"] }, { file: ["A"], tab: ["Z"], notOpened: null })).toEqual(["notOpened: not compared (Tachylite menu was not opened)"]);
  });

  it("compares config values and unknown keys", () => {
    const ours: Record<string, unknown> = { tabSize: 4, list: [1, 2], theme: "moonstone" };
    expect(diffConfig({ tabSize: 4, list: [1, 2], theme: "obsidian", brandNew: true }, (k) => ours[k])).toEqual([
      'config theme: Obsidian "obsidian", Tachylite "moonstone"',
      "config brandNew: Obsidian true, Tachylite has no default",
    ]);
  });

  it("formats a readable report with a total", () => {
    const text = formatReport([["Commands", ["one", "two"]], ["Menus", []]]);
    expect(text).toBe("## Commands: 2 differences\n  - one\n  - two\n## Menus: no differences\n\n2 differences in total");
  });
});
