// The stacked-tabs layout can only be seen in a real engine (scripts/smoke.sh checks it there). These guard the two CSS
// mistakes the real window showed: a block container (panes stacked vertically, off screen) and sticky panes (clamped
// inside the container's viewport and hidden behind the header strips).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { it, expect } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/stacked.css"), "utf8");
const rule = (selector: string): string => {
  const i = css.indexOf(selector + " {");
  expect(i, selector).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf("}", i));
};

it("lays the panes out in a horizontal flex row", () => {
  const r = rule(".workspace-tabs.mod-stacked > .workspace-tab-container");
  expect(r).toContain("display: flex");
  expect(r).toContain("flex-direction: row");
});

it("keeps panes in normal flow and only the header strips sticky", () => {
  expect(rule(".workspace-tabs.mod-stacked > .workspace-tab-container > .workspace-leaf")).not.toContain("sticky");
  expect(rule(".workspace-tabs.mod-stacked > .workspace-tab-container > .workspace-tab-header")).toContain("position: sticky");
});

it("writes only the title vertically, so the flex axis of the header stays a column", () => {
  const inner = rule(".workspace-tabs.mod-stacked > .workspace-tab-container > .workspace-tab-header .workspace-tab-header-inner");
  expect(inner).not.toContain("writing-mode");
  expect(rule(".workspace-tabs.mod-stacked > .workspace-tab-container > .workspace-tab-header .workspace-tab-header-inner-title")).toContain("writing-mode: vertical-lr");
});
