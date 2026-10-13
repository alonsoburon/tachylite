// Forward console errors and uncaught exceptions to the backend log file (no eval, no devtools needed).
import { ipc } from "../ipc";

let installed = false;
function fmt(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}
function send(level: string, parts: unknown[]): void {
  void ipc.logFrontend(level, parts.map(fmt).join(" ")).catch(() => {});
}

export function installFrontendLog(): void {
  if (installed) return;
  installed = true;
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => { orig(...args); send(level, args); };
  }
  window.addEventListener("error", (e) => send("uncaught", [e.message, e.error ?? `${e.filename}:${e.lineno}`]));
  window.addEventListener("unhandledrejection", (e) => send("unhandled-rejection", [e.reason]));
  send("info", ["frontend started"]);
}
export function logInfo(...parts: unknown[]): void { send("info", parts); }
