// Bases queries: .base parsing and round trip, filter trees, sort, group, limit, summaries, view config API.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as yaml from "js-yaml";
import { makeApp, makeVault, type FakeVault } from "./helpers/backend";
import type { App } from "../src/obsidian/app";
import { addCondition, BaseConfig, BaseConfigError, displayName, filterErrors, matchesFilter, normalizePropertyId } from "../src/bases/config";
import { BasesViewConfig, computeSummary, runQuery } from "../src/bases/api";
import { BooleanValue, DateValue, DurationValue, NullValue, NumberValue, StringValue } from "../src/obsidian/values";

let v: FakeVault;
let app: App;
beforeAll(async () => {
  v = makeVault({
    "Books/A.md": "---\ntags: [book]\nprice: 10\nage: 2\nstatus: done\nread: true\nfinished: 2024-03-01\n---\nlinks [[Textbook]]\n",
    "Books/B.md": "---\ntags: [book]\nprice: 30\nage: 3\nstatus: reading\nread: false\nfinished: 2024-01-10\n---\nb\n",
    "Books/C.md": "---\ntags: [book]\nprice: 3\nage: 1\nstatus: todo\n---\n",
    "Required Reading/R.md": "---\ntags: [book]\nprice: 8\nage: 4\n---\n",
    "Notes/N.md": "---\ntags: [tag]\n---\nplain\n",
    "Textbook.md": "# t\n",
    "pic.png": "x",
  });
  app = await makeApp(v);
});
afterAll(async () => { await app.stop(); v.cleanup(); });

const DOC_EXAMPLE = `filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
`;
const names = (rows: { file: { path: string } }[]) => rows.map((r) => r.file.path);

describe(".base files", () => {
  it("parses the documented example", () => {
    const c = BaseConfig.parse(DOC_EXAMPLE);
    expect(c.views).toHaveLength(1);
    expect(c.views[0].name).toBe("My table");
    expect(Object.keys(c.formulas)).toEqual(["formatted_price", "ppu"]);
    expect(displayName(c, "note.status")).toBe("Status");
    expect(displayName(c, "status")).toBe("Status");
    expect(displayName(c, "formula.formatted_price")).toBe("Price");
    expect(displayName(c, "file.ext")).toBe("Extension");
    expect(displayName(c, "note.age")).toBe("age");
  });
  it("rejects invalid YAML and non-mappings", () => {
    expect(() => BaseConfig.parse("views: [")).toThrow(BaseConfigError);
    expect(() => BaseConfig.parse("- a\n- b\n")).toThrow(BaseConfigError);
    expect(BaseConfig.parse("").views).toEqual([]);
  });
  it("round-trips unknown keys at every level", () => {
    const src = `myPluginKey:
  nested: [1, 2]
filters: file.hasTag("x")
views:
  - type: map
    name: Map
    lat: note.lat
    customOption: { a: 1 }
  - type: table
    name: T
    columnSize:
      note.price: 120
`;
    const c = BaseConfig.parse(src);
    c.views[1].sort = [{ property: "note.price", direction: "DESC" }];
    const back = yaml.load(c.serialize()) as any;
    expect(back.myPluginKey).toEqual({ nested: [1, 2] });
    expect(back.filters).toBe('file.hasTag("x")');
    expect(back.views[0]).toEqual({ type: "map", name: "Map", lat: "note.lat", customOption: { a: 1 } });
    expect(back.views[1].columnSize).toEqual({ "note.price": 120 });
    expect(back.views[1].sort).toEqual([{ property: "note.price", direction: "DESC" }]);
    // Key order is kept.
    expect(Object.keys(back)).toEqual(["myPluginKey", "filters", "views"]);
  });
  it("normalizes property ids", () => {
    expect(normalizePropertyId("status")).toBe("note.status");
    expect(normalizePropertyId("file.name")).toBe("file.name");
    expect(normalizePropertyId("formula.x")).toBe("formula.x");
  });
});

describe("filters", () => {
  const entryEnv = (p: string) => ({ app, file: app.vault.getFileByPath(p)!, thisFile: null, formulas: {} });
  it("evaluates and/or/not trees as documented", () => {
    const c = BaseConfig.parse(DOC_EXAMPLE);
    const match = (p: string) => matchesFilter(c.filters, entryEnv(p));
    expect(match("Notes/N.md")).toBe(true); // has #tag
    expect(match("Books/A.md")).toBe(true); // book + links Textbook
    expect(match("Books/B.md")).toBe(false); // book, no link: fails "not" (has book)
    expect(match("Textbook.md")).toBe(true); // none of the not-conditions hold
    expect(match("Required Reading/R.md")).toBe(false);
  });
  it("treats empty groups and failing statements sensibly", () => {
    expect(matchesFilter({ and: [] }, entryEnv("Books/A.md"))).toBe(true);
    expect(matchesFilter({ or: [] }, entryEnv("Books/A.md"))).toBe(true);
    expect(matchesFilter("price.nosuch()", entryEnv("Books/A.md"))).toBe(false);
    expect(matchesFilter('file.ext == "md"', entryEnv("pic.png"))).toBe(false);
    expect(matchesFilter('file.ext == "png"', entryEnv("pic.png"))).toBe(true);
  });
  it("lists syntax errors and adds conditions", () => {
    expect(filterErrors({ and: ["ok", "bad >"] })).toHaveLength(1);
    expect(addCondition(undefined, "a")).toEqual({ and: ["a"] });
    expect(addCondition({ and: ["a"] }, "b")).toEqual({ and: ["a", "b"] });
    expect(addCondition("a", "b")).toEqual({ and: ["a", "b"] });
    expect(addCondition({ or: ["a"] }, "b")).toEqual({ and: [{ or: ["a"] }, "b"] });
  });
});

describe("query execution", () => {
  it("includes every file without filters (attachments too)", () => {
    const run = runQuery(app, BaseConfig.parse("views:\n  - type: table\n    name: T\n"), undefined, null);
    expect(names(run.result.data)).toContain("pic.png");
    expect(run.total).toBe(7);
    expect(run.result.properties).toEqual(["file.name"]);
  });
  it("combines global and view filters, then sorts, groups and limits", () => {
    const c = BaseConfig.parse(`filters:
  and:
    - file.hasTag("book")
views:
  - type: table
    name: Cheap
    filters: "price < 20"
    sort:
      - property: price
        direction: DESC
  - type: table
    name: Grouped
    groupBy:
      property: status
      direction: ASC
    sort:
      - property: file.name
        direction: ASC
  - type: table
    name: Limited
    limit: 2
    sort:
      - property: age
        direction: ASC
`);
    const cheap = runQuery(app, c, c.views[0], null);
    expect(names(cheap.result.data)).toEqual(["Books/A.md", "Required Reading/R.md", "Books/C.md"]);
    const grouped = runQuery(app, c, c.views[1], null);
    const g = grouped.result.groupedData;
    expect(g.map((x) => (x.hasKey() ? x.key!.toString() : null))).toEqual(["done", "reading", "todo", null]);
    expect(names(g[3].entries)).toEqual(["Required Reading/R.md"]);
    const limited = runQuery(app, c, c.views[2], null);
    expect(names(limited.result.data)).toEqual(["Books/C.md", "Books/A.md"]);
    expect(limited.total).toBe(4);
  });
  it("puts empty values last in either direction and honours groupOrder", () => {
    const c = BaseConfig.parse(`filters: 'file.hasTag("book")'
views:
  - type: table
    name: T
    sort: [{ property: status, direction: DESC }]
    groupBy: { property: status, direction: ASC }
    groupOrder: [todo, null, missing-group]
`);
    const r = runQuery(app, c, c.views[0], null);
    expect(r.result.data[r.result.data.length - 1].file.path).toBe("Required Reading/R.md");
    const g = r.result.groupedData;
    expect(g.map((x) => (x.hasKey() ? x.key!.toString() : null))).toEqual(["todo", null, "missing-group"]);
    expect(g[2].entries).toHaveLength(0);
  });
  it("sorts by formulas and dates", () => {
    const c = BaseConfig.parse(`filters: 'file.inFolder("Books")'
formulas:
  ppu: price / age
views:
  - type: table
    name: T
    sort: [{ property: formula.ppu, direction: ASC }]
    order: [file.name, formula.ppu, finished]
`);
    const r = runQuery(app, c, c.views[0], null);
    expect(names(r.result.data)).toEqual(["Books/C.md", "Books/A.md", "Books/B.md"]);
    expect(r.result.properties).toEqual(["file.name", "formula.ppu", "note.finished"]);
    expect(r.result.data[1].getValue("formula.ppu")!.toString()).toBe("5");
    expect(r.result.data[1].getValue("note.finished")).toBeInstanceOf(DateValue);
    expect(r.result.data[0].getValue("formula.nope")).toBeNull();
    expect(r.allProperties).toContain("note.price");
    expect(r.allProperties).toContain("formula.ppu");
    expect(r.allProperties).toContain("file.mtime");
  });
  it("uses `this` for the context file", () => {
    const c = BaseConfig.parse("filters: file.hasLink(this.file)\nviews:\n  - type: table\n    name: Backlinks\n");
    const r = runQuery(app, c, c.views[0], app.vault.getFileByPath("Textbook.md"));
    expect(names(r.result.data)).toEqual(["Books/A.md"]);
  });
});

describe("summaries", () => {
  const num = (xs: (number | null)[]) => xs.map((x) => (x === null ? NullValue.value : new NumberValue(x)));
  it("computes the default summaries", () => {
    const vals = num([1, 2, 3, 10, null]);
    const s = (n: string) => computeSummary(n, vals, {}).toString();
    expect(s("Average")).toBe("4");
    expect(s("Sum")).toBe("16");
    expect(s("Min")).toBe("1");
    expect(s("Max")).toBe("10");
    expect(s("Range")).toBe("9");
    expect(s("Median")).toBe("2.5");
    expect(Number(s("Stddev"))).toBeCloseTo(3.5355, 3);
    expect(s("Empty")).toBe("1");
    expect(s("Filled")).toBe("4");
    expect(s("Unique")).toBe("4");
    expect(computeSummary("average", vals, {}).toString()).toBe("4");
    const bools = [new BooleanValue(true), new BooleanValue(false), new BooleanValue(true)];
    expect(computeSummary("Checked", bools, {}).toString()).toBe("2");
    expect(computeSummary("Unchecked", bools, {}).toString()).toBe("1");
    const dates = [DateValue.parseFromString("2024-01-01")!, DateValue.parseFromString("2024-01-03")!];
    expect(computeSummary("Earliest", dates, {}).toString()).toBe("2024-01-01");
    expect(computeSummary("Latest", dates, {}).toString()).toBe("2024-01-03");
    const range = computeSummary("Range", dates, {});
    expect(range).toBeInstanceOf(DurationValue);
    expect((range as DurationValue).getMilliseconds()).toBe(2 * 86400000);
    expect(computeSummary("Unique", [new StringValue("a"), new StringValue("a"), new StringValue("b")], {}).toString()).toBe("2");
  });
  it("evaluates custom summary formulas over `values`", () => {
    const c = BaseConfig.parse(DOC_EXAMPLE);
    delete c.raw.filters;
    const r = runQuery(app, c, { type: "table", name: "x", filters: 'file.inFolder("Books")' }, null);
    expect(r.result.getSummaryValue(null, r.result.data, "note.price", "customAverage").toString()).toBe("14.333");
    expect(r.result.getSummaryValue(null, r.result.data, "note.price", "Sum").toString()).toBe("43");
  });
});

describe("BasesViewConfig", () => {
  it("reads and writes view settings through the raw YAML object", () => {
    const c = BaseConfig.parse("views:\n  - type: cards\n    name: Gallery\n    image: cover\n    order: [file.name, status]\n    sort:\n      - property: price\n        direction: desc\n      - direction: ASC\n");
    const changed: string[] = [];
    const vc = new BasesViewConfig(c.views[0], c, (k) => changed.push(k));
    expect(vc.name).toBe("Gallery");
    expect(vc.getAsPropertyId("image")).toBe("note.cover");
    expect(vc.getOrder()).toEqual(["file.name", "note.status"]);
    expect(vc.getSort()).toEqual([{ property: "note.price", direction: "DESC" }]);
    vc.set("cardSize", 300);
    vc.set("image", null);
    expect(changed).toEqual(["cardSize", "image"]);
    const back = yaml.load(c.serialize()) as any;
    expect(back.views[0].cardSize).toBe(300);
    expect(back.views[0].image).toBeUndefined();
    expect(vc.getDisplayName("file.name")).toBe("file name");
  });
});
