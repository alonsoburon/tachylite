import { describe, expect, it } from "vitest";
import { eventKey, hotkeyMatches } from "../src/obsidian/events";

describe("hotkeys with an unidentified key", () => {
  it("falls back to the physical code (WebKitGTK reports Shift+Tab as Unidentified)", () => {
    expect(eventKey({ key: "Unidentified", code: "Tab" })).toBe("Tab");
    expect(eventKey({ key: "Unidentified", code: "KeyP" })).toBe("p");
    expect(eventKey({ key: "a", code: "KeyA" })).toBe("a");
  });
  it("matches Ctrl+Shift+Tab", () => {
    const evt = new KeyboardEvent("keydown", { key: "Unidentified", code: "Tab", ctrlKey: true, shiftKey: true });
    expect(hotkeyMatches({ modifiers: ["Ctrl", "Shift"], key: "Tab" }, evt)).toBe(true);
    expect(hotkeyMatches({ modifiers: ["Ctrl"], key: "Tab" }, evt)).toBe(false);
  });
});

describe("hotkeys on non-Latin layouts", () => {
  it("uses the physical key when the layout types a non-Latin letter", () => {
    expect(eventKey({ key: "з", code: "KeyP" })).toBe("p");
    const evt = new KeyboardEvent("keydown", { key: "з", code: "KeyP", ctrlKey: true });
    expect(hotkeyMatches({ modifiers: ["Ctrl"], key: "p" }, evt)).toBe(true);
  });
  it("keeps Latin keys with diacritics as typed", () => {
    expect(eventKey({ key: "é", code: "Digit2" })).toBe("é");
  });
});
