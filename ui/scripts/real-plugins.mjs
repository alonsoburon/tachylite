// Pinned community plugin releases used by test/obsidian.real-plugins.test.ts.
// `node scripts/real-plugins.mjs` (or `TACHYLITE_REAL_PLUGINS=1 bunx vitest run`) downloads them from GitHub
// releases into ui/.cache/real-plugins/<id>/ (gitignored). Bump a version here to test a newer release.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** [plugin id, GitHub repo, release tag] */
export const PINNED = [
  ["dataview", "blacksmithgu/obsidian-dataview", "0.5.68"],
  ["obsidian-git", "Vinzent03/obsidian-git", "2.41.1"],
  ["calendar", "liamcain/obsidian-calendar-plugin", "2.0.0-beta.2"],
  ["templater-obsidian", "SilentVoid13/Templater", "2.26.0"],
  ["obsidian-tasks-plugin", "obsidian-tasks-group/obsidian-tasks", "8.5.0"],
  ["obsidian-excalidraw-plugin", "zsviczian/obsidian-excalidraw-plugin", "2.29.0"],
  ["quickadd", "chhoumann/quickadd", "2.32.1"],
  ["obsidian-kanban", "mgmeyers/obsidian-kanban", "2.0.51"],
  ["various-complements", "tadashi-aikawa/obsidian-various-complements-plugin", "11.4.2"],
  ["obsidian-style-settings", "obsidian-community/obsidian-style-settings", "1.0.9"],
  ["omnisearch", "scambier/obsidian-omnisearch", "1.31.0"],
  ["periodic-notes", "liamcain/obsidian-periodic-notes", "0.0.17"],
  ["table-editor-obsidian", "tgrosinger/advanced-tables-obsidian", "0.23.2"],
  ["obsidian-completr", "tth05/obsidian-completr", "3.2.0"],
  ["buttons", "shabegom/buttons", "0.9.13"],
  ["obsidian-banners", "noatpad/obsidian-banners", "1.3.3"],
  ["nldates-obsidian", "argenos/nldates-obsidian", "0.6.2"],
  ["obsidian-outliner", "vslinko/obsidian-outliner", "4.10.2"],
  ["obsidian-linter", "platers/obsidian-linter", "1.34.1"],
  ["obsidian-latex-suite", "artisticat1/obsidian-latex-suite", "1.14.0"],
  ["tag-wrangler", "pjeby/tag-wrangler", "0.6.5"],
  ["obsidian-emoji-toolbar", "oliveryh/obsidian-emoji-toolbar", "1.0.0"],
  ["recent-files-obsidian", "tgrosinger/recent-files-obsidian", "1.7.10"],
  ["cmdr", "phibr0/obsidian-commander", "0.5.13"],
  ["obsidian-day-planner", "ivan-lednev/obsidian-day-planner", "0.35.1"],
  ["better-word-count", "lukeleppan/better-word-count", "0.10.1"],
  ["obsidian-folder-note-plugin", "xpgo/obsidian-folder-note-plugin", "0.7.3"],
  ["obsidian-minimal-settings", "kepano/obsidian-minimal-settings", "9.0.0"],
  ["mysnippets-plugin", "chetachiezikeuzor/MySnippets-Plugin", "1.2.3"],
  ["obsidian42-brat", "TfTHacker/obsidian42-brat", "2.2.0"],
  ["obsidian-hover-editor", "nothingislost/obsidian-hover-editor", "0.11.31"],
  ["text-extractor", "scambier/obsidian-text-extractor", "0.7.0"],
  ["obsidian-codemirror-options", "nothingislost/obsidian-codemirror-options", "0.9.5"],
];

export const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".cache", "real-plugins");

async function get(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (r.status === 404) return null;
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
  throw new Error(`download failed: ${url}`);
}

/** Download every pinned plugin missing from the cache (a `.tag` file records the version present). */
export async function fetchRealPlugins(dir = CACHE_DIR, log = console.log) {
  for (const [id, repo, tag] of PINNED) {
    const d = path.join(dir, id);
    const stamp = path.join(d, ".tag");
    if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === tag) continue;
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    for (const f of ["main.js", "manifest.json", "styles.css"]) {
      const buf = await get(`https://github.com/${repo}/releases/download/${tag}/${f}`);
      if (buf) fs.writeFileSync(path.join(d, f), buf);
      else if (f !== "styles.css") throw new Error(`${id}@${tag}: ${f} missing from the release`);
    }
    fs.writeFileSync(stamp, tag);
    log(`real-plugins: ${id}@${tag}`);
  }
  return dir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await fetchRealPlugins();
