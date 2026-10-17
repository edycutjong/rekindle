import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: { provider: "v8", include: ["lib/**/*.ts", "app/api/**/*.ts"], reporter: ["text-summary", "lcov", "json-summary"],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
