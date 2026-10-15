import { describe, expect, it } from "vitest";
import { getIcon } from "../src/obsidian/icons";

describe("icons the app itself uses", () => {
  it("resolves the backlinks and outgoing-links tab icons", () => {
    for (const id of ["lucide-links-coming-in", "lucide-links-going-out"]) {
      const svg = getIcon(id);
      expect(svg, id).not.toBeNull();
      expect(svg!.querySelectorAll("path").length).toBeGreaterThan(0);
    }
  });
});

describe("icon ids", () => {
  it("every id getIconIds() returns resolves through getIcon() (plugins such as Iconize iterate them all)", async () => {
    const { getIconIds } = await import("../src/obsidian/icons");
    const ids = getIconIds();
    expect(ids.length).toBeGreaterThan(1000);
    expect(ids.filter((id) => !getIcon(id))).toEqual([]);
    expect(ids).toEqual(expect.arrayContaining(["lucide-a-arrow-down", "lucide-x-circle", "lucide-usb-c-port", "lucide-links-coming-in"]));
  });
});
