// Shared helpers for the settings tabs.
import { Notice, SearchComponent, Setting, type App } from "../../obsidian";

export function heading(el: HTMLElement, name: string, desc?: string): Setting {
  const s = new Setting(el).setName(name).setHeading();
  if (desc) s.setDesc(desc);
  return s;
}

/** Write a vault config key and let the editor integration know. */
export function commitConfig(app: App, key: string, value: unknown): void {
  app.vault.setConfig(key, value);
  app.workspace.updateOptions();
  app.workspace.trigger("config-changed");
}

export function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function notify(msg: string, ms?: number): void { new Notice(msg, ms); }

/** Dotted-numeric comparison ("1.10.0" > "1.9.3"); non-numeric suffixes are ignored. Returns <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/i, "").split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : 0));
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function utf8(body: number[] | Uint8Array): string {
  return new TextDecoder("utf-8").decode(Uint8Array.from(body as ArrayLike<number>));
}

export function searchBox(parent: HTMLElement, placeholder: string, onChange: (v: string) => void): SearchComponent {
  const c = new SearchComponent(parent);
  c.setPlaceholder(placeholder).onChange(onChange);
  return c;
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0, s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function hslToHex(h: number, s: number, l: number): string {
  const S = s / 100, L = l / 100, a = S * Math.min(L, 1 - L);
  const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return "#" + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
