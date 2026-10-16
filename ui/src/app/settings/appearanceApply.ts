// Applies .obsidian/appearance.json to the document: base theme class, accent colour, font size and families.
import { ipc } from "../../ipc";
import type { App } from "../../obsidian";
import { hexToHsl } from "./util";

interface State { mql: MediaQueryList | null; handler: (() => void) | null; system: boolean; quickFontSize: boolean }
const states = new WeakMap<App, State>();

function stateOf(app: App): State {
  let s = states.get(app);
  if (!s) { s = { mql: null, handler: null, system: true, quickFontSize: true }; states.set(app, s); }
  return s;
}

function setThemeClass(dark: boolean): void {
  const c = document.body.classList;
  c.toggle("theme-dark", dark);
  c.toggle("theme-light", !dark);
}

function prefersDark(mql: MediaQueryList | null): boolean { return !!mql?.matches; }

export async function readAppearance(): Promise<Record<string, any>> {
  try {
    const v = await ipc.configRead("appearance.json");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** Merge `patch` into appearance.json (undefined removes a key) and re-apply. */
let queue: Promise<void> = Promise.resolve();
export function updateAppearance(app: App, patch: Record<string, unknown>): Promise<void> {
  // Serialised so quick successive edits never overwrite each other's keys.
  const run = queue.then(async () => {
    const ap = await readAppearance();
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete ap[k]; else ap[k] = v; }
    await ipc.configWrite("appearance.json", ap);
    await applyAppearance(app);
    app.workspace.trigger("css-change");
  });
  queue = run.catch(() => {});
  return run;
}

const FONT_VARS: [string, string][] = [
  ["interfaceFontFamily", "--font-interface-theme"],
  ["textFontFamily", "--font-text-theme"],
  ["monospaceFontFamily", "--font-monospace-theme"],
];

/** h in degrees, s and l in percent -> [r, g, b] (0-255), for the `--interactive-accent-rgb` variable themes use in rgba(). */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const S = s / 100, L = l / 100, k = (n: number) => (n + h / 30) % 12, a = S * Math.min(L, 1 - L);
  const f = (n: number) => Math.round(255 * (L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return [f(0), f(8), f(4)];
}

export const DEFAULT_FONT_SIZE = 16;
const MIN_FONT_SIZE = 10, MAX_FONT_SIZE = 32;

/** Whether Ctrl/Cmd+scroll adjusts the font size (Settings > Appearance > Quick font size adjustment; on by default). */
export function quickFontSizeEnabled(app: App): boolean { return stateOf(app).quickFontSize; }

/** Change the base font size by `delta` pixels (clamped), persisting it like the settings slider does. */
export async function adjustFontSize(app: App, delta: number): Promise<number> {
  const ap = await readAppearance();
  const cur = Number(ap.baseFontSize);
  const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, (Number.isFinite(cur) && cur >= 8 ? cur : DEFAULT_FONT_SIZE) + delta));
  await updateAppearance(app, { baseFontSize: next === DEFAULT_FONT_SIZE ? undefined : next });
  return next;
}

/** Idempotent; tolerates a missing or partial appearance.json. */
export async function applyAppearance(app: App): Promise<void> {
  const ap = await readAppearance();
  const body = document.body;
  const st = stateOf(app);

  // Base colour scheme.
  const theme = ap.theme;
  st.system = !(theme === "moonstone" || theme === "obsidian");
  if (st.system) {
    if (!st.mql && typeof window !== "undefined" && typeof window.matchMedia === "function") {
      st.mql = window.matchMedia("(prefers-color-scheme: dark)");
      st.handler = () => {
        if (!st.system) return;
        setThemeClass(prefersDark(st.mql));
        app.workspace.trigger("css-change");
      };
      st.mql.addEventListener?.("change", st.handler);
    }
    setThemeClass(prefersDark(st.mql));
  } else {
    setThemeClass(theme === "obsidian");
  }

  // Accent colour: override the hue/saturation/lightness variables the theme derives its accents from.
  const hsl = typeof ap.accentColor === "string" ? hexToHsl(ap.accentColor) : null;
  if (hsl) {
    body.style.setProperty("--accent-h", String(hsl.h));
    body.style.setProperty("--accent-s", `${hsl.s}%`);
    body.style.setProperty("--accent-l", `${hsl.l}%`);
    body.style.setProperty("--interactive-accent-rgb", hslToRgb(hsl.h, hsl.s, hsl.l).join(", "));
  } else {
    for (const v of ["--accent-h", "--accent-s", "--accent-l", "--interactive-accent-rgb"]) body.style.removeProperty(v);
  }

  // Font size (and whether Ctrl/Cmd+scroll may change it).
  st.quickFontSize = ap.baseFontSizeAction !== false;
  const size = Number(ap.baseFontSize);
  if (Number.isFinite(size) && size >= 8 && size <= 48) body.style.setProperty("--font-text-size", `${size}px`);
  else body.style.removeProperty("--font-text-size");

  // Font families.
  for (const [key, cssVar] of FONT_VARS) {
    const f = typeof ap[key] === "string" ? (ap[key] as string).trim() : "";
    if (f) body.style.setProperty(cssVar, f); else body.style.removeProperty(cssVar);
  }

  // View chrome flags from app.json (cheap and keeps the body classes in sync).
  body.classList.toggle("show-inline-title", app.vault.getConfig("showInlineTitle") !== false);
  body.classList.toggle("show-view-header", app.vault.getConfig("showViewHeader") !== false);
}

/** Remove the system colour scheme listener registered by applyAppearance. */
export function disposeAppearance(app: App): void {
  const st = states.get(app);
  if (st?.mql && st.handler) st.mql.removeEventListener?.("change", st.handler);
  states.delete(app);
}
