import { describe, expect, it } from "vitest";
import { hslToRgb } from "../src/app/settings/appearanceApply";

describe("hslToRgb", () => {
  it("matches known colours (the default accent, primaries, gray)", () => {
    expect(hslToRgb(262, 62, 52)).toEqual([112, 57, 208]); // the value shipped as --interactive-accent-rgb
    expect(hslToRgb(0, 100, 50)).toEqual([255, 0, 0]);
    expect(hslToRgb(120, 100, 50)).toEqual([0, 255, 0]);
    expect(hslToRgb(240, 100, 50)).toEqual([0, 0, 255]);
    expect(hslToRgb(0, 0, 50)).toEqual([128, 128, 128]);
  });
});
