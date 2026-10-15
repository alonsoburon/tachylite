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
