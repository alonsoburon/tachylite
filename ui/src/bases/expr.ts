// Bases expression language: tokenizer and recursive-descent parser producing a small AST.
// Grammar (lowest to highest precedence): || , && , == != , < <= > >= , + - , * / % , unary ! - + , postfix . [] () , primary.

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "regex"; source: string; flags: string }
  | { t: "ident"; name: string }
  | { t: "member"; obj: Node; name: string }
  | { t: "index"; obj: Node; key: Node }
  | { t: "call"; callee: Node; args: Node[] }
  | { t: "unary"; op: "!" | "-" | "+"; x: Node }
  | { t: "binary"; op: string; l: Node; r: Node }
  | { t: "list"; items: Node[] }
  | { t: "object"; entries: [string, Node][] };

export class ExprSyntaxError extends Error {
  constructor(message: string, public pos: number) { super(message); }
}

type Tok =
  | { k: "num"; v: number; p: number }
  | { k: "str"; v: string; p: number }
  | { k: "regex"; source: string; flags: string; p: number }
  | { k: "ident"; v: string; p: number }
  | { k: "op"; v: string; p: number }
  | { k: "eof"; p: number };

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "<", ">", "!", "(", ")", "[", "]", "{", "}", ",", ".", ":"];
const IDENT_START = /[\p{L}_$]/u;
const IDENT_PART = /[\p{L}\p{N}_$]/u;

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  // A `/` starts a regex literal only where a value is expected.
  const valueExpected = () => {
    const last = out[out.length - 1];
    return !last || (last.k === "op" && !(last.v === ")" || last.v === "]" || last.v === "}"));
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const p = i;
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? "") && valueExpected())) {
      let j = i;
      while (/[0-9]/.test(src[j] ?? "")) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) { j++; while (/[0-9]/.test(src[j] ?? "")) j++; }
      if (/[eE]/.test(src[j] ?? "") && /[0-9]/.test(src[j + 1] === "-" || src[j + 1] === "+" ? src[j + 2] ?? "" : src[j + 1] ?? "")) {
        j += src[j + 1] === "-" || src[j + 1] === "+" ? 2 : 1;
        while (/[0-9]/.test(src[j] ?? "")) j++;
      }
      out.push({ k: "num", v: parseFloat(src.slice(i, j)), p });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const e = src[j + 1];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new ExprSyntaxError("Unterminated string", p);
      out.push({ k: "str", v: s, p });
      i = j + 1;
      continue;
    }
    if (c === "/" && valueExpected()) {
      let j = i + 1, inClass = false;
      while (j < src.length && (src[j] !== "/" || inClass)) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        j++;
      }
      if (j >= src.length) throw new ExprSyntaxError("Unterminated regular expression", p);
      const source = src.slice(i + 1, j);
      let k = j + 1;
      while (/[a-z]/i.test(src[k] ?? "")) k++;
      out.push({ k: "regex", source, flags: src.slice(j + 1, k), p });
      i = k;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j])) j++;
      out.push({ k: "ident", v: src.slice(i, j), p });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprSyntaxError(`Unexpected character "${c}"`, p);
    out.push({ k: "op", v: op, p });
    i += op.length;
  }
  out.push({ k: "eof", p: src.length });
  return out;
}

const BINARY_LEVELS: string[][] = [["||"], ["&&"], ["==", "!="], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"]];

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}
  private peek(): Tok { return this.toks[this.i]; }
  private isOp(v: string): boolean { const t = this.peek(); return t.k === "op" && t.v === v; }
  private expect(v: string): void {
    const t = this.peek();
    if (t.k !== "op" || t.v !== v) throw new ExprSyntaxError(`Expected "${v}"`, t.p);
    this.i++;
  }
  parseAll(): Node {
    const n = this.expr();
    const t = this.peek();
    if (t.k !== "eof") throw new ExprSyntaxError("Unexpected token", t.p);
    return n;
  }
  expr(level = 0): Node {
    if (level >= BINARY_LEVELS.length) return this.unary();
    let l = this.expr(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.k !== "op" || !BINARY_LEVELS[level].includes(t.v)) return l;
      this.i++;
      l = { t: "binary", op: t.v, l, r: this.expr(level + 1) };
    }
  }
  unary(): Node {
    const t = this.peek();
    if (t.k === "op" && (t.v === "!" || t.v === "-" || t.v === "+")) { this.i++; return { t: "unary", op: t.v, x: this.unary() }; }
    return this.postfix(this.primary());
  }
  postfix(n: Node): Node {
    for (;;) {
      if (this.isOp(".")) {
        this.i++;
        const t = this.peek();
        if (t.k !== "ident") throw new ExprSyntaxError("Expected a property name after \".\"", t.p);
        this.i++;
        n = { t: "member", obj: n, name: t.v };
      } else if (this.isOp("[")) {
        this.i++;
        const key = this.expr();
        this.expect("]");
        n = { t: "index", obj: n, key };
      } else if (this.isOp("(")) {
        this.i++;
        n = { t: "call", callee: n, args: this.list(")") };
      } else return n;
    }
  }
  private list(close: string): Node[] {
    const items: Node[] = [];
    if (this.isOp(close)) { this.i++; return items; }
    for (;;) {
      items.push(this.expr());
      if (this.isOp(",")) { this.i++; if (this.isOp(close)) { this.i++; return items; } continue; }
      this.expect(close);
      return items;
    }
  }
  primary(): Node {
    const t = this.peek();
    this.i++;
    switch (t.k) {
      case "num": return { t: "num", v: t.v };
      case "str": return { t: "str", v: t.v };
      case "regex": return { t: "regex", source: t.source, flags: t.flags };
      case "ident":
        if (t.v === "true" || t.v === "false") return { t: "bool", v: t.v === "true" };
        if (t.v === "null") return { t: "null" };
        return { t: "ident", name: t.v };
      case "op":
        if (t.v === "(") { const n = this.expr(); this.expect(")"); return n; }
        if (t.v === "[") return { t: "list", items: this.list("]") };
        if (t.v === "{") {
          const entries: [string, Node][] = [];
          while (!this.isOp("}")) {
            const k = this.peek();
            if (k.k !== "str" && k.k !== "ident" && k.k !== "num") throw new ExprSyntaxError("Expected an object key", k.p);
            this.i++;
            this.expect(":");
            entries.push([String(k.v), this.expr()]);
            if (!this.isOp(",")) break;
            this.i++;
          }
          this.expect("}");
          return { t: "object", entries };
        }
        throw new ExprSyntaxError(`Unexpected "${t.v}"`, t.p);
      default:
        throw new ExprSyntaxError("Unexpected end of expression", t.p);
    }
  }
}

const cache = new Map<string, Node>();
/** Parse an expression (memoised: the same filter/formula strings are evaluated for every row). */
export function parseExpression(src: string): Node {
  let n = cache.get(src);
  if (!n) {
    n = new Parser(tokenize(src)).parseAll();
    if (cache.size > 2000) cache.clear();
    cache.set(src, n);
  }
  return n;
}

/** Returns the syntax error message for `src`, or null if it parses. */
export function checkExpression(src: string): string | null {
  try { parseExpression(src); return null; } catch (e) { return (e as Error).message; }
}
