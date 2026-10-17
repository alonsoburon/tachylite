// vitest globalSetup: build the Rust helper the tests parse notes with, and fetch the pinned real plugin bundles when
// TACHYLITE_REAL_PLUGINS=1.
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fetchRealPlugins } from "../../scripts/real-plugins.mjs";

/** `tachy parse-json`: the real tachylite-core parser, so UI tests see what the desktop app sees. */
function buildParser(): void {
  const root = path.resolve(__dirname, "../../..");
  const env = { ...process.env, PATH: `${path.join(os.homedir(), ".cargo", "bin")}${path.delimiter}${process.env.PATH ?? ""}` };
  const r = spawnSync("cargo", ["build", "-q", "-p", "tachylite-cli"], { cwd: root, env, encoding: "utf8" });
  if (r.error || r.status !== 0) {
    throw new Error(`The UI tests parse notes with the Rust core, which needs \`cargo build -p tachylite-cli\` to work.\n${r.error ?? ""}${r.stderr ?? ""}`);
  }
  process.env.TACHYLITE_PARSE_BIN = path.join(process.env.CARGO_TARGET_DIR ?? path.join(root, "target"), "debug", process.platform === "win32" ? "tachy.exe" : "tachy");
}

export default async function setup(): Promise<void> {
  buildParser();
  if (process.env.TACHYLITE_REAL_PLUGINS === "1") await fetchRealPlugins();
}
