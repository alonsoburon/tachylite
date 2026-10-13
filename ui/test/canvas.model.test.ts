import { describe, expect, it } from "vitest";
import {
  arrowPoints, autoSides, bboxContains, bboxIntersects, closestSide, cssColor, distanceToEdge, edgeGeometry, parseCanvas, randomId, rectBBox,
  serializeCanvas, sidePoint, snap, unionBBox,
} from "../src/canvas/model";

// The layout Obsidian writes: tab-indented top level, one compact object per line, no trailing newline.
const FILE = `{
\t"nodes":[
\t\t{"id":"g1","type":"group","x":-40,"y":-40,"width":700,"height":400,"label":"Group","color":"4","x-plugin":{"a":1}},
\t\t{"id":"t1","type":"text","text":"# Hi\\n[[Note]]","x":0,"y":0,"width":250,"height":60,"color":"#ff8800"},
\t\t{"id":"f1","type":"file","file":"Note.md","subpath":"#Head","x":300,"y":0,"width":400,"height":400,"styleAttributes":{}},
\t\t{"id":"l1","type":"link","url":"https://example.com","x":0,"y":500,"width":400,"height":300}
\t],
\t"edges":[
\t\t{"id":"e1","fromNode":"t1","fromSide":"right","toNode":"f1","toSide":"left","label":"rel","color":"1","x-weight":3},
\t\t{"id":"e2","fromNode":"t1","toNode":"l1","fromEnd":"arrow","toEnd":"none"}
\t],
\t"metadata":{"version":"1.0-1.0","frontmatter":{}}
}`;

describe("JSON Canvas model", () => {
  it("round-trips a file byte for byte, including unknown keys at every level", () => {
    const d = parseCanvas(FILE);
    expect(d.nodes).toHaveLength(4);
    expect(d.edges).toHaveLength(2);
    expect(d.metadata).toEqual({ version: "1.0-1.0", frontmatter: {} });
    expect(serializeCanvas(d)).toBe(FILE);
  });

  it("treats empty files as empty canvases and writes both arrays", () => {
    expect(parseCanvas("")).toEqual({ nodes: [], edges: [] });
    expect(parseCanvas("{}")).toEqual({ nodes: [], edges: [] });
    expect(serializeCanvas(parseCanvas(""))).toBe('{\n\t"nodes":[],\n\t"edges":[]\n}');
  });

  it("rejects non-JSON and non-objects, drops malformed items", () => {
    expect(() => parseCanvas("nope")).toThrow();
    expect(() => parseCanvas("[]")).toThrow();
    const d = parseCanvas('{"nodes":[{"id":"a","type":"text","text":"x"},{"type":"text"},null],"edges":[{"id":"e","fromNode":"a"},{"id":"f","fromNode":"a","toNode":"a"}]}');
    expect(d.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(d.nodes[0]).toMatchObject({ x: 0, y: 0, width: 250, height: 60 });
    expect(d.edges.map((e) => e.id)).toEqual(["f"]);
  });

  it("maps colours to the theme presets or keeps hex", () => {
    expect(cssColor("1")).toBe("var(--canvas-color-1)");
    expect(cssColor("6")).toBe("var(--canvas-color-6)");
    expect(cssColor("#AbC")).toBe("#AbC");
    expect(cssColor("7")).toBeNull();
    expect(cssColor("url(x)")).toBeNull();
    expect(cssColor(undefined)).toBeNull();
  });

  it("geometry: sides, nearest side, automatic sides, boxes", () => {
    const r = { x: 0, y: 0, width: 100, height: 50 };
    expect(sidePoint(r, "top")).toEqual({ x: 50, y: 0 });
    expect(sidePoint(r, "right")).toEqual({ x: 100, y: 25 });
    expect(sidePoint(r, "bottom")).toEqual({ x: 50, y: 50 });
    expect(sidePoint(r, "left")).toEqual({ x: 0, y: 25 });
    expect(closestSide(r, { x: 120, y: 30 })).toBe("right");
    expect(closestSide(r, { x: 40, y: -30 })).toBe("top");
    expect(autoSides(r, { x: 300, y: 0, width: 100, height: 50 })).toEqual(["right", "left"]);
    expect(autoSides(r, { x: 0, y: -300, width: 100, height: 50 })).toEqual(["top", "bottom"]);
    const b = rectBBox(r);
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
    expect(bboxContains(b, { minX: 10, minY: 10, maxX: 20, maxY: 20 })).toBe(true);
    expect(bboxContains(b, { minX: 10, minY: 10, maxX: 200, maxY: 20 })).toBe(false);
    expect(bboxIntersects(b, { minX: 90, minY: 40, maxX: 200, maxY: 200 })).toBe(true);
    expect(unionBBox([b, { minX: -5, minY: 10, maxX: 20, maxY: 80 }])).toEqual({ minX: -5, minY: 0, maxX: 100, maxY: 80 });
    expect(unionBBox([])).toBeNull();
    expect(snap(29, 20)).toBe(20);
    expect(snap(31, 20)).toBe(40);
    expect(snap(3.6, 0)).toBe(4);
  });

  it("edge endpoints: the curve starts and ends on the sides and leaves along their normals", () => {
    const g = edgeGeometry({ x: 100, y: 25 }, "right", { x: 300, y: 25 }, "left");
    expect(g.path.startsWith("M100,25 C")).toBe(true);
    expect(g.path.endsWith(" 300,25")).toBe(true);
    expect(g.c1.x).toBeGreaterThan(100);
    expect(g.c2.x).toBeLessThan(300);
    expect(g.mid).toEqual({ x: 200, y: 25 });
    expect(distanceToEdge(g, { x: 200, y: 25 })).toBeLessThan(1);
    expect(distanceToEdge(g, { x: 200, y: 125 })).toBeGreaterThan(90);
    // Arrow into the left side of a node: tip on the side, body outside (to the left).
    const pts = arrowPoints({ x: 300, y: 25 }, "left").split(" ").map((p) => p.split(",").map(Number));
    expect(pts[0]).toEqual([300, 25]);
    expect(pts[1][0]).toBeLessThan(300);
    expect(pts[2][0]).toBeLessThan(300);
  });

  it("ids look like Obsidian's (16 hex digits)", () => {
    const a = randomId(), b = randomId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});
