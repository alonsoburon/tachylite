// requestUrl / request over the Rust http_request command (bypasses webview CORS).
import { ipc } from "../ipc";

export interface RequestUrlParam { url: string; method?: string; contentType?: string; body?: string | ArrayBuffer; headers?: Record<string, string>; throw?: boolean }
export interface RequestUrlResponse { status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer; json: any; text: string }
export interface RequestUrlResponsePromise extends Promise<RequestUrlResponse> {
  arrayBuffer: Promise<ArrayBuffer>; json: Promise<any>; text: Promise<string>;
}

export function requestUrl(request: RequestUrlParam | string): RequestUrlResponsePromise {
  const req: RequestUrlParam = typeof request === "string" ? { url: request } : request;
  const run = async (): Promise<RequestUrlResponse> => {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (req.contentType) headers["Content-Type"] = req.contentType;
    let body: number[] | null = null;
    if (req.body !== undefined && req.body !== null) {
      const bytes = typeof req.body === "string" ? new TextEncoder().encode(req.body) : new Uint8Array(req.body);
      body = Array.from(bytes);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type") && typeof req.body === "string") headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const r = await ipc.httpRequest({ url: req.url, method: req.method ?? (body ? "POST" : "GET"), headers, body });
    const u8 = Uint8Array.from(r.body ?? []);
    const arrayBuffer = u8.buffer as ArrayBuffer;
    let text: string | undefined, json: any, jsonDone = false;
    const resp: RequestUrlResponse = {
      status: r.status,
      headers: r.headers ?? {},
      arrayBuffer,
      get text() { return (text ??= new TextDecoder().decode(u8)); },
      get json() { if (!jsonDone) { json = JSON.parse(this.text); jsonDone = true; } return json; },
    };
    if (req.throw !== false && r.status >= 400) {
      const err: any = new Error(`Request failed, status ${r.status}`);
      err.status = r.status; err.headers = resp.headers; err.response = resp;
      throw err;
    }
    return resp;
  };
  const p = run() as RequestUrlResponsePromise;
  Object.defineProperty(p, "arrayBuffer", { get: () => p.then((r) => r.arrayBuffer) });
  Object.defineProperty(p, "json", { get: () => p.then((r) => r.json) });
  Object.defineProperty(p, "text", { get: () => p.then((r) => r.text) });
  return p;
}

export function request(request: RequestUrlParam | string): Promise<string> {
  return requestUrl(request).text;
}
