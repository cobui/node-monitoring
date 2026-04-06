import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["**/*.ts"],
      exclude: ["tests/**", "benchmark/**", "vitest.config.mts", "index.ts", "types.ts"],
      reporter: ["text", "html"],
    },
  },
});
