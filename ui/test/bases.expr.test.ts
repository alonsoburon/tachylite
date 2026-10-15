// Bases expression language: tokenizer/parser, operators, and the documented functions (examples from help.obsidian.md/bases).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeApp, makeVault, type FakeVault } from "./helpers/backend";
import type { App } from "../src/obsidian/app";
import { checkExpression, parseExpression, tokenize } from "../src/bases/expr";
import { evaluate, evaluateSource, ErrorValue, type EvalEnv } from "../src/bases/evaluate";
import { DateValue, DurationValue, FileValue, LinkValue, ListValue, NullValue, NumberValue, StringValue, type Value } from "../src/obsidian/values";

let v: FakeVault;
let app: App;
const NOTES: Record<string, string> = {
  "Books/Dune.md": "---\ntitle: Dune\nprice: 12.5\nage: 5\ntags: [book, scifi/classic]\nauthor: \"[[Frank Herbert]]\"\nstatus: reading\ndue: 2025-01-15\ndone: false\nscores: [3, 1, 2]\n---\nA desert planet. Links to [[Textbook]] and #inline\n",
  "Frank Herbert.md": "---\nborn: 1920-10-08\n---\nAuthor.\n",
  "Textbook.md": "# Textbook\n",
  "Required Reading/Old.md": "---\ntags: [book]\n---\nsee [[Dune]]\n",
  "img.png": "PNG",
};

beforeAll(async () => {
  v = makeVault(NOTES);
  app = await makeApp(v);
});
afterAll(async () => { await app.stop(); v.cleanup(); });

const file = (p: string) => app.vault.getFileByPath(p)!;
function env(path: string | null = "Books/Dune.md", extra: Partial<EvalEnv> = {}): EvalEnv {
  return { app, file: path ? file(path) : null, thisFile: path ? file(path) : null, formulas: {}, ...extra };
}
function ev(src: string, e: EvalEnv = env()): Value { return evaluate(parseExpression(src), e); }
/** Plain JS form of a value, for compact assertions. */
function js(x: Value): unknown {
  if (x instanceof NullValue) return null;
  if (x instanceof ListValue) return x.value.map(js);
  if (x instanceof NumberValue || x instanceof StringValue) return x.value;
  if ("value" in x) return (x as any).value;
  return x.toString();
}
const run = (src: string, e?: EvalEnv) => js(ev(src, e));

describe("string case", () => {
  it("lower, upper and title change the case", () => {
    expect(run('"Abc dEf".lower()')).toBe("abc def");
    expect(run('"Abc dEf".upper()')).toBe("ABC DEF");
    expect(run('"abc def".title()')).toBe("Abc Def");
  });
});

describe("parser", () => {
  it("tokenizes numbers followed by method calls and regex literals", () => {
    expect(tokenize("1.isTruthy()").map((t) => t.k)).toEqual(["num", "op", "ident", "op", "op", "eof"]);
    expect(tokenize('"a:b".replace(/:/g, "-")').some((t) => t.k === "regex")).toBe(true);
    expect(tokenize("a / b").some((t) => t.k === "regex")).toBe(false);
  });
  it("respects precedence and parentheses", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("10 % 4 - 1")).toBe(1);
    expect(run("1 < 2 && 2 < 3 || false")).toBe(true);
    expect(run("!true || -(-2) == 2")).toBe(true);
  });
  it("reports syntax errors", () => {
    expect(checkExpression("price >")).toBeTruthy();
    expect(checkExpression('"unterminated')).toMatch(/Unterminated/);
    expect(checkExpression("file.hasTag(\"x\")")).toBeNull();
  });
  it("parses list and object literals with indexing", () => {
    expect(run("[1, 2, 3][1]")).toBe(2);
    expect(run('{"a": 1, "b": [2]}.b[0]')).toBe(2);
    expect(run('{"a": 1}["a"]')).toBe(1);
  });
});

describe("properties", () => {
  it("reads note properties bare, with note. and note[]", () => {
    expect(run("price")).toBe(12.5);
    expect(run("note.price")).toBe(12.5);
    expect(run('note["price"]')).toBe(12.5);
    expect(run("missing")).toBeNull();
  });
  it("reads file properties", () => {
    expect(run("file.name")).toBe("Dune.md");
    expect(run("file.basename")).toBe("Dune");
    expect(run("file.ext")).toBe("md");
    expect(run("file.folder")).toBe("Books");
    expect(run("file.path")).toBe("Books/Dune.md");
    expect(run("file.size") as number).toBeGreaterThan(10);
    expect(ev("file.mtime")).toBeInstanceOf(DateValue);
    expect(run("file.tags.contains(\"book\")")).toBe(true);
    expect(run("file.links.length")).toBeGreaterThanOrEqual(1);
    expect(run('file.properties.status')).toBe("reading");
    expect(ev("file.file")).toBeInstanceOf(FileValue);
  });
  it("turns frontmatter wikilinks into links and ISO dates into dates", () => {
    expect(ev("author")).toBeInstanceOf(LinkValue);
    expect(ev("due")).toBeInstanceOf(DateValue);
    expect(run("due.year")).toBe(2025);
    expect(run("due.month")).toBe(1);
    expect(run("due.day")).toBe(15);
  });
  it("evaluates formulas, including formulas using other formulas, and detects cycles", () => {
    const e = env("Books/Dune.md", { formulas: { ppu: "(price / age).toFixed(2)", label: 'formula.ppu + " each"', a: "formula.b", b: "formula.a" } });
    expect(run("formula.ppu", e)).toBe("2.50");
    expect(run("formula.label", e)).toBe("2.50 each");
    expect(evaluateSource("formula.a", e)).toBeInstanceOf(ErrorValue);
    expect(run("formula.unknown", e)).toBeNull();
  });
  it("resolves this to the context file", () => {
    const e = env("Books/Dune.md", { thisFile: file("Textbook.md") });
    expect(run("this.file.name", e)).toBe("Textbook.md");
    expect(run("file.hasLink(this.file)", e)).toBe(true);
    expect(run("file.hasLink(this)", e)).toBe(true);
    const old = env("Required Reading/Old.md", { thisFile: file("Books/Dune.md") });
    expect(run("file.hasLink(this.file)", old)).toBe(true);
    expect(run("this.status", old)).toBe("reading");
  });
});

describe("operators", () => {
  it("compares values", () => {
    expect(run('status != "done"')).toBe(true);
    expect(run("price > 2.1")).toBe(true);
    expect(run("price >= 12.5 && price <= 12.5")).toBe(true);
    expect(run('"b" > "a"')).toBe(true);
    expect(run("missing > 3")).toBe(false);
    expect(run("missing == null")).toBe(true);
  });
  it("concatenates strings", () => {
    expect(run('file.basename + " - " + status')).toBe("Dune - reading");
    expect(run('price + " dollars"')).toBe("12.5 dollars");
  });
  it("does date arithmetic with durations (documented examples)", () => {
    expect(ev('date("2024-12-01") + "1M" + "4h" + "3m"').toString()).toBe("2025-01-01 04:03");
    expect(run('(date("2025-01-02") - date("2025-01-01"))')).toBe(86400000);
    expect(run('(now() + "1d") - now()') as number).toBeGreaterThan(86399000);
    expect(run('file.mtime > now() - "1 week"')).toBe(true);
    expect(run('now() + "1 day" > now()')).toBe(true);
    expect(ev('today() + "7d"')).toBeInstanceOf(DateValue);
    expect(ev('due + "2w"').toString()).toBe("2025-01-29");
    expect(ev('date("2025-01-31") - "1y"').toString()).toBe("2024-01-31");
    expect(run('due < date("2025-02-01")')).toBe(true);
  });
  it("does duration arithmetic", () => {
    const d = ev("duration('5h') * 2");
    expect(d).toBeInstanceOf(DurationValue);
    expect((d as DurationValue).getMilliseconds()).toBe(10 * 3600000);
    expect(ev("now() + (duration('1d') * 2)")).toBeInstanceOf(DateValue);
    expect((ev('duration("1 hour") + duration("30m")') as DurationValue).getMilliseconds()).toBe(5400000);
    expect(DurationValue.parseFromString("P1DT2H")!.getMilliseconds()).toBe(26 * 3600000);
    expect(DurationValue.parseFromString("nope")).toBeNull();
  });
  it("uses JavaScript-like truthiness for && and ||", () => {
    expect(run('missing || "fallback"')).toBe("fallback");
    expect(run("price && age")).toBe(5);
  });
});

describe("global functions", () => {
  it("if()", () => {
    expect(run('if(price, price.toFixed(2) + " dollars")')).toBe("12.50 dollars");
    expect(run('if(missing, "yes")')).toBeNull();
    expect(run('if(done, "Modified", "Unmodified")')).toBe("Unmodified");
  });
  it("date(), now(), today(), duration(), number()", () => {
    expect(ev('date("2025-01-01 12:00:00")').toString()).toBe("2025-01-01 12:00");
    expect(ev("today()").toString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(run('now().date().format("HH:mm:ss")')).toBe("00:00:00");
    expect(run('number("3.4")')).toBe(3.4);
    expect(run("number(true)")).toBe(1);
    expect(run('number(date("1970-01-01T00:00:00Z"))')).toBe(0);
    expect(evaluateSource('number("abc")', env())).toBeInstanceOf(ErrorValue);
  });
  it("list(), min(), max(), random()", () => {
    expect(run('list("value")')).toEqual(["value"]);
    expect(run("list(scores)")).toEqual([3, 1, 2]);
    expect(run("max(1, 5, 3)")).toBe(5);
    expect(run("min(4, 2, 8)")).toBe(2);
    const r = run("random()") as number;
    expect(r >= 0 && r < 1).toBe(true);
  });
  it("link(), file(), image(), icon(), html(), escapeHTML()", () => {
    const l = ev('link("Textbook")') as LinkValue;
    expect(l.resolve(app)?.path).toBe("Textbook.md");
    expect(ev('link("Textbook", "display")').toString()).toBe("display");
    expect(ev('link("https://obsidian.md")')).toBeInstanceOf(LinkValue);
    expect((ev('file("Textbook.md")') as FileValue).file.path).toBe("Textbook.md");
    expect((ev('file(link("[[Textbook]]"))') as FileValue).file.path).toBe("Textbook.md");
    expect(run('file("nope.md")')).toBeNull();
    expect(ev('image("img.png")').constructor.name).toBe("ImageValue");
    expect(ev('icon("arrow-right")').constructor.name).toBe("IconValue");
    expect(ev('html("<b>x</b>")').constructor.name).toBe("HTMLValue");
    expect(run('escapeHTML("<a>")')).toBe("&lt;a&gt;");
    expect(evaluateSource("nosuchfn()", env())).toBeInstanceOf(ErrorValue);
  });
});

describe("type methods (documented examples)", () => {
  it("any", () => {
    expect(run("1.isTruthy()")).toBe(true);
    expect(run('"example".isType("string")')).toBe(true);
    expect(run('true.isType("boolean")')).toBe(true);
    expect(run("123.toString()")).toBe("123");
    expect(run('author.isType("link")')).toBe(true);
  });
  it("string", () => {
    expect(run('"hello".contains("ell")')).toBe(true);
    expect(run('"hello".containsAll("h", "e")')).toBe(true);
    expect(run('"hello".containsAny("x", "y", "e")')).toBe(true);
    expect(run('"hello".endsWith("lo")')).toBe(true);
    expect(run('"hello".startsWith("he")')).toBe(true);
    expect(run('"Hello world".isEmpty()')).toBe(false);
    expect(run('"".isEmpty()')).toBe(true);
    expect(run('"HeLLo".lower()')).toBe("hello");
    expect(run('"a:b:c:d".replace(/:/, "-")')).toBe("a-b:c:d");
    expect(run('"a:b:c:d".replace(/:/g, "-")')).toBe("a-b-c-d");
    expect(run('"a:b:c:d".replace(":", "-")')).toBe("a-b-c-d");
    expect(run('"John Smith".replace(/(\\w+) (\\w+)/, "$2, $1")')).toBe("Smith, John");
    expect(run('"123".repeat(2)')).toBe("123123");
    expect(run('"hello".reverse()')).toBe("olleh");
    expect(run('"hello".slice(1, 4)')).toBe("ell");
    expect(run('"hello".slice(1)')).toBe("ello");
    expect(run('"a,b,c,d".split(",", 3)')).toEqual(["a", "b", "c"]);
    expect(run('"a,b,c,d".split(/,/, 3)')).toEqual(["a", "b", "c"]);
    expect(run('"hello world".title()')).toBe("Hello World");
    expect(run('"  hi  ".trim()')).toBe("hi");
    expect(run('"hello".length')).toBe(5);
    expect(run("status.contains(\"read\")")).toBe(true);
    expect(run("missing.contains(\"x\")")).toBeNull();
  });
  it("number", () => {
    expect(run("(-5).abs()")).toBe(5);
    expect(run("(2.1).ceil()")).toBe(3);
    expect(run("(2.9).floor()")).toBe(2);
    expect(run("5.isEmpty()")).toBe(false);
    expect(run("(2.5).round()")).toBe(3);
    expect(run("(2.3333).round(2)")).toBe(2.33);
    expect(run("(3.14159).toFixed(2)")).toBe("3.14");
  });
  it("date", () => {
    expect(run('date("2025-05-27").format("YYYY-MM-DD")')).toBe("2025-05-27");
    expect(run('date("2025-05-27 23:59:58").time()')).toBe("23:59:58");
    expect(run('date("2025-05-27 10:11:12").hour')).toBe(10);
    expect(run('date("2025-05-27 10:11:12").minute')).toBe(11);
    expect(run('date("2025-05-27 10:11:12").second')).toBe(12);
    expect(run("file.mtime.relative()")).toMatch(/ago|seconds|now/);
    expect(run("due.isEmpty()")).toBe(false);
  });
  it("list", () => {
    expect(run("[1,2,3].contains(2)")).toBe(true);
    expect(run("[1,2,3].containsAll(2,3)")).toBe(true);
    expect(run("[1,2,3].containsAny(3,4)")).toBe(true);
    expect(run("[1,2,3,4].filter(value > 2)")).toEqual([3, 4]);
    expect(run("[1,2,3,4].filter(index < 2)")).toEqual([1, 2]);
    expect(run("[1,[2,3]].flat()")).toEqual([1, 2, 3]);
    expect(run("[1,2,3].isEmpty()")).toBe(false);
    expect(run('[1,2,3].join(",")')).toBe("1,2,3");
    expect(run("[1,2,3,4].map(value + 1)")).toEqual([2, 3, 4, 5]);
    expect(run("[1,2,3].reduce(acc + value, 0)")).toBe(6);
    expect(run('[5, "x", 9, 2].filter(value.isType("number")).reduce(if(acc == null || value > acc, value, acc), null)')).toBe(9);
    expect(run("[1,2,3].reverse()")).toEqual([3, 2, 1]);
    expect(run("[1,2,3,4].slice(1,3)")).toEqual([2, 3]);
    expect(run("[3, 1, 2].sort()")).toEqual([1, 2, 3]);
    expect(run('["c", "a", "b"].sort()')).toEqual(["a", "b", "c"]);
    expect(run("[1,2,2,3].unique()")).toEqual([1, 2, 3]);
    expect(run("scores.length")).toBe(3);
    expect(run('tags.contains("book")')).toBe(true);
    expect(run("[1,2,3,4].mean().round(3)")).toBe(2.5);
  });
  it("link", () => {
    expect((ev('link("[[Textbook]]").asFile()') as FileValue).file.path).toBe("Textbook.md");
    expect(run('link("Required Reading/Old").linksTo(file("Books/Dune.md"))')).toBe(true);
    expect(run('author == link("Frank Herbert")')).toBe(true);
    expect(run('author == file("Frank Herbert.md")')).toBe(true);
    expect(run('author.asFile().born.year')).toBeNull(); // File fields only; note props are not file fields
    expect(run('[author].contains(file("Frank Herbert.md"))')).toBe(true);
  });
  it("file", () => {
    expect(ev("file.asLink()")).toBeInstanceOf(LinkValue);
    expect(run('file.hasLink("Textbook")')).toBe(true);
    expect(run('file.hasLink(file("Textbook.md"))')).toBe(true);
    expect(run('file.hasLink("Nope")')).toBe(false);
    expect(run('file.hasProperty("price")')).toBe(true);
    expect(run('file.hasProperty("nope")')).toBe(false);
    expect(run('file.hasTag("book")')).toBe(true);
    expect(run('file.hasTag("scifi")')).toBe(true); // nested tag
    expect(run('file.hasTag("x", "inline")')).toBe(true);
    expect(run('file.hasTag("sci")')).toBe(false);
    expect(run('file.inFolder("Books")')).toBe(true);
    expect(run('file.inFolder("Required Reading")')).toBe(false);
    expect(run('file.inFolder("Required Reading")', env("Required Reading/Old.md"))).toBe(true);
  });
  it("object and regexp", () => {
    expect(run("{}.isEmpty()")).toBe(true);
    expect(run('{"a": 1, "b": 2}.keys()')).toEqual(["a", "b"]);
    expect(run('{"a": 1, "b": 2}.values()')).toEqual([1, 2]);
    expect(run('/abc/.matches("abcde")')).toBe(true);
    expect(run('/^x/.matches("abc")')).toBe(false);
  });
  it("reports unknown methods as errors", () => {
    expect(evaluateSource("price.nosuch()", env())).toBeInstanceOf(ErrorValue);
  });
});
