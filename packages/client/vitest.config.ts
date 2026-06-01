import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ["source"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    exclude: ["e2e/**", "node_modules/**"],
    passWithNoTests: true,
    setupFiles: ["./vitest.setup.ts"],
    maxWorkers: 3,
    minWorkers: 1,
  },
});
