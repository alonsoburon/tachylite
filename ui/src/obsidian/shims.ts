// Browser-safe shims for the node / electron modules community plugins commonly require.
// Honesty rule: anything that cannot work in a webview throws a clear "not supported" error when called
// (never silently succeeds), but requiring the module itself always works so plugins can load.
import pathBrowserify from "path-browserify";
import { Buffer } from "buffer";
import { ipc } from "../ipc";
import EventEmitter from "events";
import type { App } from "./app";
import { nodeBridge, openPath } from "./nodeBridge";
import { detectOS } from "./events";

export { Buffer, EventEmitter };
export const path = pathBrowserify;

function notSupported(mod: string, member: string): never {
  const e = new Error(`${mod}.${member} is not supported in Tachylite (no Node.js runtime in the webview)`);
  (e as any).code = "ERR_NOT_SUPPORTED";
  throw e;
}

/** Module whose every member exists but throws when called (so `class X extends mod.Foo` still evaluates). */
export function unsupportedModule(name: string, overrides: Record<string, unknown> = {}): any {
  const cache: Record<string, unknown> = {};
  return new Proxy(overrides, {
    get(t, prop) {
      if (typeof prop === "symbol" || prop === "__esModule" || prop === "then" || prop === "toJSON") return undefined;
      if (prop in t) return (t as any)[prop];
      return (cache[prop] ??= function (this: unknown) { return notSupported(name, prop); });
    },
    has: () => true,
  });
}

/**
 * `http` / `https`: there is no socket server in the webview. `createServer` still returns a server object so plugins
 * that build one at load time (Omnisearch's local API) keep working; `listen` reports an `error` event instead.
 */
export function httpModule(name: string): any {
  const createServer = (..._args: unknown[]) => {
    const server: any = new EventEmitter();
    server.listening = false;
    server.listen = (...args: unknown[]) => {
      const cb = args.find((a) => typeof a === "function") as (() => void) | undefined;
      void cb;
      setTimeout(() => {
        const e: any = new Error(`${name}.Server.listen is not supported in Tachylite (no Node.js runtime in the webview)`);
        e.code = "ERR_NOT_SUPPORTED";
        if (server.listenerCount("error")) server.emit("error", e); else console.warn(e.message);
      }, 0);
      return server;
    };
    server.close = (cb?: (err?: Error) => void) => { setTimeout(() => cb?.()); server.emit("close"); return server; };
    server.address = () => null;
    server.setTimeout = () => server;
    server.ref = server.unref = () => server;
    return server;
  };
  const fail = (m: string) => () => notSupported(name, m);
  return unsupportedModule(name, {
    createServer, Server: function Server() { return createServer(); }, STATUS_CODES: {}, METHODS: ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    request: fail("request"), get: fail("get"), Agent: function Agent() { /* no sockets */ }, globalAgent: {},
  });
}

// ------------------------------------------------------------------ process
const uaPlatform = () => ({ macos: "darwin", windows: "win32", linux: "linux" } as const)[detectOS()];
/** Platform, env, cwd and pid come from the Node bridge while it is active (see nodeBridge.ts), else browser guesses. */
export function createProcess(): any {
  const p: any = new EventEmitter();
  let envOverride: Record<string, string> | null = null;
  Object.defineProperties(p, {
    platform: { get: () => nodeBridge.info?.platform ?? uaPlatform(), enumerable: true, configurable: true },
    arch: { get: () => nodeBridge.info?.arch ?? "x64", enumerable: true, configurable: true },
    pid: { get: () => nodeBridge.info?.pid ?? 1, enumerable: true, configurable: true },
    env: { get: () => envOverride ?? nodeBridge.env, set: (v) => { envOverride = v; }, enumerable: true, configurable: true },
  });
  Object.assign(p, {
    argv: [], execPath: "", title: "tachylite", version: "v20.0.0",
    versions: { node: "20.0.0" }, browser: true,
    cwd: () => nodeBridge.info?.cwd ?? "/", chdir() {}, umask: () => 0,
    nextTick: (fn: (...a: any[]) => void, ...args: any[]) => queueMicrotask(() => fn(...args)),
    hrtime: Object.assign((prev?: [number, number]) => {
      const t = performance.now(), s = Math.floor(t / 1000), n = Math.floor((t % 1000) * 1e6);
      return prev ? [s - prev[0], n - prev[1]] : [s, n];
    }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) }),
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
    uptime: () => performance.now() / 1000,
    emitWarning: (w: unknown) => console.warn(w),
    exit: () => notSupported("process", "exit"),
    kill: () => notSupported("process", "kill"),
  });
  return p;
}

// ------------------------------------------------------------------ os
export function createOs(): any {
  const proc = createProcess();
  const b = () => nodeBridge.info;
  const os: any = {
    platform: () => proc.platform, arch: () => proc.arch, type: () => (proc.platform === "win32" ? "Windows_NT" : proc.platform === "darwin" ? "Darwin" : "Linux"),
    release: () => "0.0.0", hostname: () => b()?.hostname ?? "tachylite", homedir: () => b()?.homedir ?? "/", tmpdir: () => b()?.tmpdir ?? "/tmp",
    endianness: () => "LE", cpus: () => [], totalmem: () => 0, freemem: () => 0,
    uptime: () => 0, loadavg: () => [0, 0, 0], networkInterfaces: () => ({}),
    userInfo: () => ({ username: b()?.username ?? "user", uid: -1, gid: -1, shell: null, homedir: b()?.homedir ?? "/" }), constants: {},
  };
  Object.defineProperty(os, "EOL", { get: () => (proc.platform === "win32" ? "\r\n" : "\n"), enumerable: true });
  Object.defineProperty(os, "devNull", { get: () => (proc.platform === "win32" ? "\\\\.\\nul" : "/dev/null"), enumerable: true });
  return os;
}

// ------------------------------------------------------------------ url / querystring / util / assert
export function createUrl(): any {
  const fileURLToPath = (u: string | URL) => decodeURIComponent(new URL(String(u)).pathname);
  const pathToFileURL = (p: string) => new URL("file://" + encodeURI(p.startsWith("/") ? p : "/" + p));
  const parse = (s: string, parseQuery?: boolean) => {
    let u: URL | null = null;
    try { u = new URL(s); } catch { try { u = new URL(s, "http://placeholder.invalid"); } catch { /* ignore */ } }
    const abs = /^[a-z][a-z0-9+.-]*:/i.test(s);
    return {
      protocol: abs && u ? u.protocol : null, slashes: abs ? true : null, auth: u && (u.username || u.password) ? `${u.username}:${u.password}` : null,
      host: abs && u ? u.host : null, port: abs && u ? u.port || null : null, hostname: abs && u ? u.hostname : null,
      hash: u?.hash || null, search: u?.search || null,
      query: parseQuery ? Object.fromEntries(u?.searchParams ?? []) : (u?.search || "").replace(/^\?/, "") || null,
      pathname: u?.pathname ?? s, path: (u?.pathname ?? s) + (u?.search ?? ""), href: abs && u ? u.href : s,
    };
  };
  const format = (o: any) => (typeof o === "string" ? o : o instanceof URL ? o.href : `${o.protocol ? o.protocol + "//" : ""}${o.host ?? o.hostname ?? ""}${o.pathname ?? ""}${o.search ?? ""}${o.hash ?? ""}`);
  const resolve = (from: string, to: string) => new URL(to, new URL(from, "http://placeholder.invalid/")).href.replace("http://placeholder.invalid", "");
  return { URL, URLSearchParams, fileURLToPath, pathToFileURL, parse, format, resolve };
}
export function createQuerystring(): any {
  return {
    parse: (s: string) => { const o: Record<string, any> = {}; for (const [k, v] of new URLSearchParams(s)) o[k] = k in o ? [].concat(o[k], v as any) : v; return o; },
    stringify: (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]]))).toString(),
    escape: encodeURIComponent, unescape: decodeURIComponent,
  };
}
export function createUtil(): any {
  const format = (f: unknown, ...args: unknown[]) => {
    if (typeof f !== "string") return [f, ...args].map((a) => (typeof a === "string" ? a : inspect(a))).join(" ");
    let i = 0;
    const s = f.replace(/%[sdifjoO%]/g, (m) => {
      if (m === "%%") return "%";
      if (i >= args.length) return m;
      const a = args[i++];
      switch (m) { case "%s": return String(a); case "%d": case "%i": return String(parseInt(String(a), 10)); case "%f": return String(parseFloat(String(a))); case "%j": return JSON.stringify(a); default: return inspect(a); }
    });
    return [s, ...args.slice(i).map((a) => (typeof a === "string" ? a : inspect(a)))].join(" ");
  };
  const inspect = (v: unknown): string => {
    const seen = new WeakSet();
    try { return typeof v === "string" ? v : JSON.stringify(v, (_k, x) => { if (typeof x === "object" && x) { if (seen.has(x)) return "[Circular]"; seen.add(x); } return typeof x === "function" ? `[Function ${x.name}]` : typeof x === "bigint" ? `${x}n` : x; }, 2) ?? String(v); } catch { return String(v); }
  };
  // Honours `fn[util.promisify.custom]` like Node (child_process.exec resolves `{ stdout, stderr }`).
  const promisify = (fn: (...a: any[]) => any) => (typeof (fn as any)?.[promisify.custom] === "function" ? (fn as any)[promisify.custom] : (...args: any[]) => new Promise((res, rej) => fn(...args, (err: unknown, ...vals: unknown[]) => (err ? rej(err) : res(vals.length > 1 ? vals : vals[0])))));
  promisify.custom = Symbol.for("nodejs.util.promisify.custom");
  const isDeepStrictEqual = (a: any, b: any): boolean => {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => isDeepStrictEqual(a[k], b[k]));
  };
  return {
    format, inspect: Object.assign(inspect, { custom: Symbol.for("nodejs.util.inspect.custom"), defaultOptions: {} }), promisify,
    callbackify: (fn: (...a: any[]) => Promise<any>) => (...args: any[]) => { const cb = args.pop(); fn(...args).then((v) => cb(null, v), (e) => cb(e)); },
    inherits: (ctor: any, superCtor: any) => { Object.defineProperty(ctor, "super_", { value: superCtor, writable: true, configurable: true }); Object.setPrototypeOf(ctor.prototype, superCtor.prototype); },
    deprecate: <T>(fn: T) => fn, isDeepStrictEqual, TextEncoder, TextDecoder,
    types: { isPromise: (x: any) => !!x && typeof x.then === "function", isDate: (x: any) => x instanceof Date, isRegExp: (x: any) => x instanceof RegExp, isUint8Array: (x: any) => x instanceof Uint8Array, isArrayBuffer: (x: any) => x instanceof ArrayBuffer, isMap: (x: any) => x instanceof Map, isSet: (x: any) => x instanceof Set, isAsyncFunction: (x: any) => x?.constructor?.name === "AsyncFunction" },
    isArray: Array.isArray, isString: (x: any) => typeof x === "string", isFunction: (x: any) => typeof x === "function",
  };
}
export function createAssert(): any {
  const util = createUtil();
  class AssertionError extends Error { code = "ERR_ASSERTION"; actual?: unknown; expected?: unknown; }
  const fail = (m?: string | Error): never => { throw m instanceof Error ? m : new AssertionError(m ?? "Assertion failed"); };
  const assert: any = (v: unknown, m?: string) => { if (!v) fail(m ?? "The expression evaluated to a falsy value"); };
  Object.assign(assert, {
    ok: assert, fail, AssertionError,
    equal: (a: unknown, b: unknown, m?: string) => { if (a != b) fail(m ?? `${a} == ${b}`); },
    notEqual: (a: unknown, b: unknown, m?: string) => { if (a == b) fail(m ?? `${a} != ${b}`); },
    strictEqual: (a: unknown, b: unknown, m?: string) => { if (!Object.is(a, b)) fail(m ?? `Expected values to be strictly equal: ${util.inspect(a)} !== ${util.inspect(b)}`); },
    notStrictEqual: (a: unknown, b: unknown, m?: string) => { if (Object.is(a, b)) fail(m ?? "Expected values to differ"); },
    deepStrictEqual: (a: unknown, b: unknown, m?: string) => { if (!util.isDeepStrictEqual(a, b)) fail(m ?? "Expected values to be strictly deep-equal"); },
    deepEqual: (a: unknown, b: unknown, m?: string) => { if (!util.isDeepStrictEqual(a, b)) fail(m ?? "Expected values to be deep-equal"); },
    throws: (fn: () => unknown, _e?: unknown, m?: string) => { try { fn(); } catch { return; } fail(m ?? "Missing expected exception"); },
    rejects: async (p: Promise<unknown> | (() => Promise<unknown>)) => { try { await (typeof p === "function" ? p() : p); } catch { return; } fail("Missing expected rejection"); },
  });
  assert.strict = assert;
  return assert;
}
export function createStringDecoder(): any {
  class StringDecoder { private d: TextDecoder; constructor(enc = "utf8") { this.d = new TextDecoder(enc === "utf8" ? "utf-8" : enc); } write(b: Uint8Array) { return this.d.decode(b, { stream: true }); } end(b?: Uint8Array) { return b ? this.d.decode(b) : this.d.decode(); } }
  return { StringDecoder };
}
export function createTimers(): any {
  return {
    setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis),
    setImmediate: (fn: (...a: any[]) => void, ...a: any[]) => setTimeout(fn, 0, ...a), clearImmediate: (id: any) => clearTimeout(id),
    promises: { setTimeout: (ms: number, v?: unknown) => new Promise((r) => setTimeout(() => r(v), ms)), setImmediate: (v?: unknown) => new Promise((r) => setTimeout(() => r(v), 0)) },
  };
}
export function createStream(): any {
  class Stream extends EventEmitter { pipe<T>(d: T): T { return d; } }
  class Readable extends Stream { readable = true; push(_c: unknown) { return true; } read() { return null; } destroy() { return this; } static from() { return notSupported("stream", "Readable.from"); } }
  class Writable extends Stream { writable = true; write(_c: unknown, _e?: unknown, cb?: () => void) { cb?.(); return true; } end(cb?: () => void) { cb?.(); return this; } destroy() { return this; } }
  class Duplex extends Readable { writable = true; write(_c: unknown) { return true; } end() { return this; } }
  class Transform extends Duplex {}
  class PassThrough extends Transform {}
  const s: any = Stream;
  Object.assign(s, { Stream, Readable, Writable, Duplex, Transform, PassThrough, pipeline: () => notSupported("stream", "pipeline"), finished: () => {} });
  return s;
}

// ------------------------------------------------------------------ crypto (sync hashes in pure JS + webcrypto)
const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
function toBytes(data: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}
function pad(msg: Uint8Array, bigEndian: boolean): Uint8Array {
  const len = msg.length, total = (((len + 8) >> 6) + 1) << 6;
  const out = new Uint8Array(total);
  out.set(msg);
  out[len] = 0x80;
  const dv = new DataView(out.buffer);
  const bits = len * 8;
  if (bigEndian) { dv.setUint32(total - 8, Math.floor(bits / 2 ** 32)); dv.setUint32(total - 4, bits >>> 0); }
  else { dv.setUint32(total - 8, bits >>> 0, true); dv.setUint32(total - 4, Math.floor(bits / 2 ** 32), true); }
  return out;
}
function sha1(msg: Uint8Array): Uint8Array {
  const m = pad(msg, true), dv = new DataView(m.buffer), w = new Uint32Array(80);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  for (let i = 0; i < m.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 80; t++) w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      const [f, k] = t < 20 ? [(b & c) | (~b & d), 0x5a827999] : t < 40 ? [b ^ c ^ d, 0x6ed9eba1] : t < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const tmp = (rotl(a, 5) + f + e + k + w[t]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20), o = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((v, i) => o.setUint32(i * 4, v));
  return out;
}
const K256 = Uint32Array.from([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
function sha256(msg: Uint8Array): Uint8Array {
  const m = pad(msg, true), dv = new DataView(m.buffer), w = new Uint32Array(64);
  const H = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < m.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3), s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K256[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32), o = new DataView(out.buffer);
  H.forEach((v, i) => o.setUint32(i * 4, v));
  return out;
}
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
function md5(msg: Uint8Array): Uint8Array {
  const m = pad(msg, false), dv = new DataView(m.buffer);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let i = 0; i < m.length; i += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let t = 0; t < 64; t++) {
      let f: number, g: number;
      if (t < 16) { f = (b & c) | (~b & d); g = t; } else if (t < 32) { f = (d & b) | (~d & c); g = (5 * t + 1) % 16; } else if (t < 48) { f = b ^ c ^ d; g = (3 * t + 5) % 16; } else { f = c ^ (b | ~d); g = (7 * t) % 16; }
      const tmp = d; d = c; c = b;
      b = (b + rotl((a + f + MD5_K[t] + dv.getUint32(i + g * 4, true)) | 0, MD5_S[t])) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16), o = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => o.setUint32(i * 4, v, true));
  return out;
}
const HASHES: Record<string, { fn: (m: Uint8Array) => Uint8Array; block: number }> = {
  sha1: { fn: sha1, block: 64 }, sha256: { fn: sha256, block: 64 }, md5: { fn: md5, block: 64 },
};
function encodeOut(bytes: Uint8Array, enc?: string): any {
  const b = Buffer.from(bytes);
  return enc ? b.toString(enc as BufferEncoding) : b;
}
function hashAlg(alg: string) {
  const a = HASHES[alg.toLowerCase().replace("-", "")];
  if (!a) notSupported("crypto", `createHash('${alg}') (sync hashing supports md5, sha1, sha256; use crypto.subtle for others)`);
  return a!;
}
export function createCrypto(): any {
  const wc: Crypto | undefined = (globalThis as any).crypto;
  const randomBytes = (n: number) => { const b = new Uint8Array(n); wc!.getRandomValues(b); return Buffer.from(b); };
  const createHash = (alg: string) => {
    const a = hashAlg(alg);
    const chunks: Uint8Array[] = [];
    const h: any = {
      update(d: string | ArrayBuffer | ArrayBufferView, enc?: string) { chunks.push(typeof d === "string" && enc && enc !== "utf8" ? new Uint8Array(Buffer.from(d, enc as BufferEncoding)) : toBytes(d)); return h; },
      digest(enc?: string) { return encodeOut(a.fn(concat(chunks)), enc); },
    };
    return h;
  };
  const createHmac = (alg: string, key: string | ArrayBuffer | ArrayBufferView) => {
    const a = hashAlg(alg);
    let k = toBytes(key);
    if (k.length > a.block) k = a.fn(k);
    const ipad = new Uint8Array(a.block), opad = new Uint8Array(a.block);
    for (let i = 0; i < a.block; i++) { ipad[i] = (k[i] ?? 0) ^ 0x36; opad[i] = (k[i] ?? 0) ^ 0x5c; }
    const chunks: Uint8Array[] = [];
    const h: any = {
      update(d: string | ArrayBuffer | ArrayBufferView) { chunks.push(toBytes(d)); return h; },
      digest(enc?: string) { return encodeOut(a.fn(concat([opad, a.fn(concat([ipad, ...chunks]))])), enc); },
    };
    return h;
  };
  return {
    randomBytes, createHash, createHmac, webcrypto: wc, subtle: wc?.subtle,
    getRandomValues: (a: ArrayBufferView) => wc!.getRandomValues(a as any),
    randomUUID: () => wc!.randomUUID(),
    randomInt: (a: number, b?: number) => { const [lo, hi] = b === undefined ? [0, a] : [a, b]; return lo + Math.floor((randomBytes(4).readUInt32BE(0) / 2 ** 32) * (hi - lo)); },
    timingSafeEqual: (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]),
    getHashes: () => Object.keys(HASHES),
    createCipheriv: () => notSupported("crypto", "createCipheriv (use crypto.subtle)"),
    createDecipheriv: () => notSupported("crypto", "createDecipheriv (use crypto.subtle)"),
    pbkdf2Sync: () => notSupported("crypto", "pbkdf2Sync (use crypto.subtle.deriveBits)"),
    scryptSync: () => notSupported("crypto", "scryptSync"),
  };
}
function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Uint8Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ------------------------------------------------------------------ fs (vault-confined, async-backed)
function fsError(code: string, syscall: string, p: string, msg?: string): Error {
  const e: any = new Error(`${code}: ${msg ?? ({ ENOENT: "no such file or directory", EACCES: "permission denied", ENOSYS: "function not implemented", EEXIST: "file already exists", EISDIR: "illegal operation on a directory" } as Record<string, string>)[code] ?? code}, ${syscall} '${p}'`);
  e.code = code; e.syscall = syscall; e.path = p;
  return e;
}

const OUTSIDE = 'access outside the vault is not permitted by Tachylite (allow it in Settings > Community plugins > "Allow plugins to run programs and access files outside the vault")';
/** Vault-confined `fs` used while the Node bridge is off. */
export function createFs(app: App): any {
  const base = () => app.vault.adapter.getBasePath().replace(/\\/g, "/").replace(/\/+$/, "");
  const toVault = (p: string | URL, syscall: string): string => {
    let s = String(p instanceof URL ? p.pathname : p).replace(/\\/g, "/");
    if (/^file:\/\//.test(s)) s = decodeURIComponent(new URL(s).pathname).replace(/^\/([A-Za-z]:\/)/, "$1");
    const b = base();
    if (s === b) return "";
    if (s.startsWith(b + "/")) s = s.slice(b.length + 1);
    else if (s.startsWith("/") || /^[A-Za-z]:\//.test(s)) throw fsError("EACCES", syscall, String(p), OUTSIDE);
    const norm = pathBrowserify.normalize(s).replace(/^\.\/?/, "").replace(/\/$/, "");
    if (norm === ".." || norm.startsWith("../")) throw fsError("EACCES", syscall, String(p), OUTSIDE);
    return norm === "." ? "" : norm;
  };
  const ad = () => app.vault.adapter;
  const mkStats = (st: { type: string; ctime: number; mtime: number; size: number }) => ({
    isFile: () => st.type === "file", isDirectory: () => st.type === "folder", isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
    size: st.size, mode: st.type === "folder" ? 0o40755 : 0o100644, uid: 0, gid: 0,
    atimeMs: st.mtime, mtimeMs: st.mtime, ctimeMs: st.ctime, birthtimeMs: st.ctime,
    atime: new Date(st.mtime), mtime: new Date(st.mtime), ctime: new Date(st.ctime), birthtime: new Date(st.ctime),
  });
  const encOf = (o: unknown): string | null => (typeof o === "string" ? o : (o as any)?.encoding ?? null);
  const promises: any = {
    async readFile(p: string, o?: unknown) {
      const v = toVault(p, "open"), enc = encOf(o);
      try {
        if (enc && /^utf-?8$/i.test(enc)) return await ad().read(v);
        const buf = Buffer.from(await ad().readBinary(v));
        return enc ? buf.toString(enc as BufferEncoding) : buf;
      } catch (e) { throw wrap(e, "open", p); }
    },
    async writeFile(p: string, data: string | ArrayBufferView | ArrayBuffer, o?: unknown) {
      const v = toVault(p, "open");
      try {
        if (typeof data === "string") { const enc = encOf(o); await ad().writeBinary(v, enc && !/^utf-?8$/i.test(enc) ? new Uint8Array(Buffer.from(data, enc as BufferEncoding)).buffer as ArrayBuffer : toBytes(data).slice().buffer as ArrayBuffer); }
        else await ad().writeBinary(v, toBytes(data).slice().buffer as ArrayBuffer);
      } catch (e) { throw wrap(e, "open", p); }
    },
    async appendFile(p: string, data: string | ArrayBufferView) {
      const v = toVault(p, "open");
      await ad().appendBinary(v, toBytes(data).slice().buffer as ArrayBuffer);
    },
    async readdir(p: string, o?: { withFileTypes?: boolean }) {
      const v = toVault(p, "scandir");
      let l;
      try { l = await ad().list(v); } catch (e) { throw wrap(e, "scandir", p); }
      const names = [...l.folders.map((f) => ({ n: f.slice(f.lastIndexOf("/") + 1), d: true })), ...l.files.map((f) => ({ n: f.slice(f.lastIndexOf("/") + 1), d: false }))].sort((a, b) => (a.n < b.n ? -1 : 1));
      return o?.withFileTypes ? names.map((x) => ({ name: x.n, isDirectory: () => x.d, isFile: () => !x.d, isSymbolicLink: () => false })) : names.map((x) => x.n);
    },
    async stat(p: string) {
      const s = await ad().stat(toVault(p, "stat"));
      if (!s) throw fsError("ENOENT", "stat", p);
      return mkStats(s);
    },
    async lstat(p: string) { return promises.stat(p); },
    async access(p: string) { if (!(await ad().exists(toVault(p, "access")))) throw fsError("ENOENT", "access", p); },
    async mkdir(p: string) { await ad().mkdir(toVault(p, "mkdir")); },
    async rmdir(p: string, o?: { recursive?: boolean }) { await ad().rmdir(toVault(p, "rmdir"), !!o?.recursive); },
    async rm(p: string, o?: { recursive?: boolean; force?: boolean }) {
      const v = toVault(p, "rm");
      if (!(await ad().exists(v))) { if (o?.force) return; throw fsError("ENOENT", "rm", p); }
      const st = await ad().stat(v);
      if (st?.type === "folder") await ad().rmdir(v, !!o?.recursive); else await ad().remove(v);
    },
    async unlink(p: string) { const v = toVault(p, "unlink"); if (!(await ad().exists(v))) throw fsError("ENOENT", "unlink", p); await ad().remove(v); },
    async rename(a: string, b: string) { await ad().rename(toVault(a, "rename"), toVault(b, "rename")); },
    async copyFile(a: string, b: string) { await ad().copy(toVault(a, "copyfile"), toVault(b, "copyfile")); },
    async realpath(p: string) { return p; },
    async mkdtemp() { throw fsError("ENOSYS", "mkdtemp", "", "mkdtemp is not supported"); },
  };
  function wrap(e: unknown, syscall: string, p: string): Error {
    const msg = String((e as Error)?.message ?? e);
    if (/not found|no such|os error 2|NotFound/i.test(msg)) return fsError("ENOENT", syscall, p);
    return e instanceof Error ? e : new Error(msg);
  }
  const fs: any = { promises, constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 } };
  // callback flavours
  for (const name of Object.keys(promises)) {
    fs[name] = (...args: any[]) => {
      const cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
      const p = promises[name](...args);
      if (!cb) return p.catch(() => {});
      p.then((v: unknown) => cb(null, v), (e: unknown) => cb(e));
    };
  }
  fs.exists = (p: string, cb: (b: boolean) => void) => { try { void ad().exists(toVault(p, "exists")).then(cb, () => cb(false)); } catch { cb(false); } };
  // sync flavours: only what can be answered from the in-memory vault index
  fs.existsSync = (p: string) => { try { const v = toVault(p, "exists"); return v === "" || !!app.vault.getAbstractFileByPath(v); } catch { return false; } };
  fs.statSync = (p: string) => {
    const v = toVault(p, "stat"), f = v === "" ? app.vault.getRoot() : app.vault.getAbstractFileByPath(v);
    if (!f) throw fsError("ENOENT", "stat", p);
    const isFile = "stat" in f;
    return mkStats({ type: isFile ? "file" : "folder", ctime: isFile ? (f as any).stat.ctime : 0, mtime: isFile ? (f as any).stat.mtime : 0, size: isFile ? (f as any).stat.size : 0 });
  };
  fs.lstatSync = fs.statSync;
  for (const n of ["readFile", "writeFile", "appendFile", "readdir", "mkdir", "rmdir", "rm", "unlink", "rename", "copyFile", "access", "realpath"]) {
    fs[n + "Sync"] = () => { throw fsError("ENOSYS", n, "", `fs.${n}Sync is not supported: the Tachylite backend is asynchronous; use the vault adapter or fs.promises`); };
  }
  fs.createReadStream = () => notSupported("fs", "createReadStream");
  fs.createWriteStream = () => notSupported("fs", "createWriteStream");
  fs.watch = () => ({ close() {}, on() { return this; } });
  fs.watchFile = () => {};
  return fs;
}

// ------------------------------------------------------------------ electron
export function createElectron(app: App | null): any {
  let lastClipboard = "";
  const clipboard = {
    writeText(t: string) { lastClipboard = t; void navigator.clipboard?.writeText(t); },
    readText() { return lastClipboard; }, // synchronous read is impossible in a webview; returns the last text we wrote
    readHTML: () => "", writeHTML(h: string) { lastClipboard = h; }, clear() { lastClipboard = ""; }, availableFormats: () => [], has: () => false,
    readImage: () => ({ isEmpty: () => true, toDataURL: () => "", toPNG: () => Buffer.alloc(0) }),
  };
  const noop = () => undefined;
  const ipcRenderer: any = new EventEmitter();
  Object.assign(ipcRenderer, { send: noop, sendSync: noop, invoke: async () => undefined, sendTo: noop, sendToHost: noop });
  const shell = {
    openExternal: async (url: string) => { if (/^(https?|mailto):/i.test(url)) await ipc.openUrl(url).catch(() => window.open(url, "_blank", "noopener")); else window.open(url, "_blank", "noopener"); },
    // Opening local files needs the Node bridge (it can launch any program registered for the file type).
    openPath: async (p: string) => (nodeBridge.active ? openPath(p, false) : "Opening files is not allowed: turn on \"Allow plugins to run programs and access files outside the vault\" in Settings > Community plugins"),
    showItemInFolder: (p: string) => { if (nodeBridge.active) void openPath(p, true); },
    trashItem: async () => {}, beep: noop,
  };
  const win: any = Object.assign(new EventEmitter(), {
    isMaximized: () => false, isFullScreen: () => false, isFocused: () => document.hasFocus(), isDestroyed: () => false, isMinimized: () => false,
    maximize: noop, minimize: noop, unmaximize: noop, focus: () => window.focus(), close: noop, show: noop, hide: noop, setTitle: noop, setFullScreen: noop,
    webContents: Object.assign(new EventEmitter(), { openDevTools: noop, closeDevTools: noop, isDevToolsOpened: () => false, setZoomFactor: noop, getZoomFactor: () => 1, executeJavaScript: async () => undefined, session: {} }),
    getBounds: () => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }), setBounds: noop, setAlwaysOnTop: noop,
  });
  const dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined as string | undefined }),
    showMessageBox: async () => ({ response: 0, checkboxChecked: false }), showErrorBox: noop,
  };
  const appObj = {
    getPath: (n: string) => (n === "home" ? nodeBridge.info?.homedir ?? "/" : n === "temp" ? nodeBridge.info?.tmpdir ?? "/tmp" : "/"),
    getVersion: () => "1.14.4", getName: () => "Tachylite", getLocale: () => navigator.language, getAppPath: () => "/", isPackaged: true,
    on: noop, once: noop, quit: noop, relaunch: noop, focus: noop,
  };
  const nativeTheme = Object.assign(new EventEmitter(), { get shouldUseDarkColors() { return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false; }, themeSource: "system" });
  class Menu extends EventEmitter { items: unknown[] = []; append(i: unknown) { this.items.push(i); } popup() {} static buildFromTemplate(t: unknown[]) { const m = new Menu(); m.items = t; return m; } static setApplicationMenu() {} }
  class MenuItem { constructor(public options: unknown) {} }
  class BrowserWindow extends EventEmitter { constructor(_o?: unknown) { super(); } loadURL() { return Promise.resolve(); } static getAllWindows() { return []; } static getFocusedWindow() { return win; } }
  const remote: any = {
    app: appObj, dialog, shell, clipboard, nativeTheme, Menu, MenuItem, BrowserWindow,
    getCurrentWindow: () => win, getCurrentWebContents: () => win.webContents, getGlobal: () => undefined,
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: window.screen?.width ?? 1920, height: window.screen?.height ?? 1080 }, scaleFactor: window.devicePixelRatio || 1 }), getAllDisplays: () => [] },
    session: { defaultSession: {} }, process: createProcess(), require: (m: string) => { throw new Error(`remote.require('${m}') is not supported in Tachylite`); },
  };
  const electron: any = {
    remote, ipcRenderer, shell, clipboard, nativeTheme, webFrame: { setZoomFactor: noop, getZoomFactor: () => 1, setZoomLevel: noop, getZoomLevel: () => 0 },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }), createFromDataURL: () => ({ isEmpty: () => true }), createEmpty: () => ({ isEmpty: () => true }) },
    contextBridge: { exposeInMainWorld: noop }, app: appObj, dialog, Menu, MenuItem, BrowserWindow, screen: remote.screen,
    ipcMain: ipcRenderer, desktopCapturer: { getSources: async () => [] }, crashReporter: {}, powerMonitor: new EventEmitter(),
  };
  void app;
  return electron;
}
