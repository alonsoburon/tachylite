// The canvas "Convert to file" name prompt used an unstyled textarea (narrow and four lines tall in the real window).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { it, expect } from "vitest";

it("styles the name prompt's textarea as a single full-width line", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");
  const i = css.indexOf(".modal.mod-file-rename .rename-textarea");
  expect(i).toBeGreaterThanOrEqual(0);
  const rule = css.slice(i, css.indexOf("}", i));
  expect(rule).toContain("width: 100%");
  expect(rule).toContain("resize: none");
});

it("menus taller than the window scroll instead of running off it (seen in the real window with the 30-entry tab menu)", () => {
  const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");
  const i = css.indexOf("\n.menu {");
  const rule = css.slice(i, css.indexOf("}", i));
  expect(rule).toContain("max-height: calc(100vh");
  expect(rule).toContain("overflow-y: auto");
});
