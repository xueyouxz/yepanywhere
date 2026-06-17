import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  test: {
    exclude: ["node_modules/**", "dist/**"],
    // Strip developer-shell config env (e.g. YA_DEFERRED_JOIN_WINDOW_S) before
    // each file so the suite reproduces identically everywhere. See the setup file.
    setupFiles: ["./test/setup/hermetic-env.ts"],
    passWithNoTests: true,
    maxWorkers: 4,
    minWorkers: 1,
  },
});
