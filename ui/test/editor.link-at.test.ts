import { describe, expect, it } from "vitest";
import { linkAt } from "../src/editor/linkAt";

describe("linkAt", () => {
  it("finds wikilinks, aliases, subpaths and embeds around the cursor", () => {
    const line = "see [[Note#Head|alias]] and ![[pic.png]] end";
    expect(linkAt(line, line.indexOf("Note") + 2)).toEqual({ kind: "wiki", target: "Note#Head", external: false });
    expect(linkAt(line, line.indexOf("pic"))).toEqual({ kind: "wiki", target: "pic.png", external: false });
    expect(linkAt(line, 1)).toBeNull();
    expect(linkAt(line, line.length)).toBeNull();
  });
  it("includes the brackets' edges but not text outside", () => {
    expect(linkAt("[[A]]", 0)?.target).toBe("A");
    expect(linkAt("[[A]]", 5)?.target).toBe("A");
    expect(linkAt("x [[A]] y", 8)).toBeNull();
  });
  it("finds markdown links and tells external from internal", () => {
    expect(linkAt("a [t](https://x.org/p) b", 6)).toEqual({ kind: "markdown", target: "https://x.org/p", external: true });
    expect(linkAt("[t](Some%20Note.md)", 4)).toEqual({ kind: "markdown", target: "Some%20Note.md", external: false });
    expect(linkAt("[t](<My Note.md>)", 5)?.target).toBe("My Note.md");
    expect(linkAt("[t](C:\\x\\y.md)", 5)?.external).toBe(false);
  });
  it("ignores empty links", () => {
    expect(linkAt("[[ ]]", 2)).toBeNull();
    expect(linkAt("[t]()", 3)).toBeNull();
  });
});
