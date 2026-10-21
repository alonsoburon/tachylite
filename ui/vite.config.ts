import { defineConfig } from "vite";
export default defineConfig({
  build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 4000 },
  clearScreen: false,
  test: {
    environment: "happy-dom",
    globalSetup: ["test/setup/realPlugins.ts"],
    // A CodeMirror timer can still fire after its test's happy-dom window was torn down; that says nothing about the code under test.
    onUnhandledError(error) {
      const msg = String((error as Error).message);
      if (/requestAnimationFrame is not a function/.test(msg)) return false;
      // Smart Connections' save queue fires after its test has finished and the plugin was unloaded; not our code.
      if (/No 'data' adapter class found for event_logs or smart_collections/.test(msg)) return false;
    },
  },
});
