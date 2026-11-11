import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/services/**/*.ts", "src/storage/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/screens/**", "src/index.ts"]
    }
  }
});
