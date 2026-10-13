// vitest globalSetup: fetch the pinned real plugin bundles before the run when TACHYLITE_REAL_PLUGINS=1.
import { fetchRealPlugins } from "../../scripts/real-plugins.mjs";

export default async function setup(): Promise<void> {
  if (process.env.TACHYLITE_REAL_PLUGINS === "1") await fetchRealPlugins();
}
