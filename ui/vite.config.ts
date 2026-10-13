import { defineConfig } from "vite";
export default defineConfig({
  build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 4000 },
  clearScreen: false,
  test: { environment: "happy-dom", globalSetup: ["test/setup/realPlugins.ts"] },
});
