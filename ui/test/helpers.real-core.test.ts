// The UI tests' backend runs the real Rust core for parsing and link resolution (see test/helpers/backend.ts).
// These behaviors exist only in the Rust implementation, so they fail if the helper falls back to an imitation.
import { afterEach, describe, expect, it } from "vitest";
import { makeVault, type FakeVault } from "./helpers/backend";

let v: FakeVault;
afterEach(() => v?.cleanup());

describe("UI test backend uses the real core", () => {
  it("reports UTF-16 offsets like the plugin API (an emoji is two units)", async () => {
    v = makeVault({ "A.md": "😀 [[B]] #tag\n", "B.md": "" });
    const meta: any = await v.backend("meta_get", { path: "A.md" });
    expect(meta.links[0].position.start).toEqual({ line: 0, col: 3, offset: 3 });
    expect(meta.tags[0].position.start.offset).toBe(9);
  });

  it("resolves links across Unicode normalization forms", async () => {
    v = makeVault({ "Café.md": "", "Src.md": "[[Café]]" });
    const links: any = await v.backend("meta_links");
    expect(links.resolved["Src.md"]).toEqual({ "Café.md": 1 });
  });

  it("produces sections and list items, which the old imitation never did", async () => {
    v = makeVault({ "A.md": "# H\n\n- [ ] task\n- plain\n" });
    const meta: any = await v.backend("meta_get", { path: "A.md" });
    expect(meta.sections.map((s: any) => s.type)).toEqual(["heading", "list"]);
    expect(meta.listItems.map((i: any) => i.task)).toEqual([" ", undefined]);
  });
});
