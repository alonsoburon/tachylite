// Theme contract: every CSS variable the app stylesheets read without a fallback is defined, and the chrome variables themes restyle exist.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.join(__dirname, "../src/styles");
const css = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
const all = Object.values(css).join("\n");
const defined = new Set([...all.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

describe("stylesheet variables", () => {
  it("defines the chrome variables themes override", () => {
    for (const v of ["--status-bar-background", "--status-bar-text-color", "--toggle-radius", "--slider-track-background", "--clickable-icon-radius", "--file-header-height", "--titlebar-background", "--ribbon-padding"]) {
      expect(css["variables.css"], v).toContain(`${v}:`);
    }
  });
  it("uses the status bar variables on the status bar", () => {
    expect(css["app.css"]).toMatch(/\.status-bar \{[^}]*var\(--status-bar-background\)/);
  });
  it("never reads an undefined variable without a fallback", () => {
    const missing = new Set<string>();
    for (const m of all.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) if (!defined.has(m[1])) missing.add(m[1]);
    // set at runtime by the app (appearance settings, layout) rather than in a stylesheet
    expect([...missing].sort()).toEqual([]);
  });
});
