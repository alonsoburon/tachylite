import { describe, expect, it } from "vitest";
import { paneFor } from "../src/markdown/pane";

describe("paneFor", () => {
  it("maps click modifiers to where a link opens", () => {
    expect(paneFor({ button: 0 })).toBe(false);
    expect(paneFor({ ctrlKey: true })).toBe("tab");
    expect(paneFor({ metaKey: true })).toBe("tab");
    expect(paneFor({ button: 1 })).toBe("tab");
    expect(paneFor({ ctrlKey: true, altKey: true })).toBe("split");
    expect(paneFor({ ctrlKey: true, altKey: true, shiftKey: true })).toBe("window");
  });
  it("ignores Alt and Shift on their own", () => {
    expect(paneFor({ altKey: true })).toBe(false);
    expect(paneFor({ shiftKey: true })).toBe(false);
  });
});
