import { defineConfig } from "vite";
export default defineConfig({
  build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 4000 },
  clearScreen: false,
  test: {
    environment: "happy-dom",
    globalSetup: ["test/setup/realPlugins.ts"],
    // A CodeMirror timer can still fire after its test's happy-dom window was torn down; that says nothing about the code under test.
    onUnhandledError(error) { if (/requestAnimationFrame is not a function/.test(String((error as Error).message))) return false; },
  },
});
