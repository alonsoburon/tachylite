// Community plugin catalog access and update checking.
import { ipc } from "../../ipc";
import type { App } from "../../obsidian";
import { compareVersions, utf8 } from "./util";

export interface CatalogEntry { id: string; name: string; author: string; description: string; repo: string }
export interface UpdateInfo { id: string; name: string; current: string; latest: string }

export function normalizeCatalog(raw: unknown[]): CatalogEntry[] {
  return raw.map((r: any) => ({
    id: String(r?.id ?? ""), name: String(r?.name ?? r?.id ?? ""), author: String(r?.author ?? ""),
    description: String(r?.description ?? ""), repo: String(r?.repo ?? ""),
  })).filter((e) => e.id);
}

export async function fetchCatalog(): Promise<CatalogEntry[]> {
  return normalizeCatalog(await ipc.pluginCatalog());
}

/** Fetch the latest manifest.json of a plugin repository; null when unreachable or malformed. */
async function latestVersion(repo: string): Promise<string | null> {
  try {
    const r = await ipc.httpRequest({ url: `https://raw.githubusercontent.com/${repo}/HEAD/manifest.json` });
    if (r.status < 200 || r.status >= 300) return null;
    const m = JSON.parse(utf8(r.body));
    return typeof m?.version === "string" ? m.version : null;
  } catch { return null; }
}

/** Compare every installed plugin that appears in the catalog against its repository's manifest. */
export async function checkForUpdates(app: App, catalog?: CatalogEntry[]): Promise<UpdateInfo[]> {
  const cat = catalog ?? (await fetchCatalog());
  const byId = new Map(cat.map((e) => [e.id, e]));
  const jobs = Object.values(app.plugins.manifests).filter((m) => byId.get(m.id)?.repo);
  const out: UpdateInfo[] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < jobs.length; i = next++) {
      const m = jobs[i];
      const latest = await latestVersion(byId.get(m.id)!.repo);
      if (latest && compareVersions(latest, m.version) > 0) out.push({ id: m.id, name: m.name || m.id, current: m.version, latest });
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Re-download a plugin and reload it if it was running. Returns false when the reload failed. */
export async function updatePlugin(app: App, id: string): Promise<boolean> {
  const wasLoaded = !!app.plugins.plugins[id];
  await ipc.pluginInstall(id);
  if (wasLoaded) await app.plugins.unloadPlugin(id);
  await app.plugins.loadManifests();
  if (wasLoaded) return !!(await app.plugins.loadPlugin(id));
  return true;
}
