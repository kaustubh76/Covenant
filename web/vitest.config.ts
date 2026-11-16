import { defineConfig } from "vitest/config";

// Unit tests: pure functions only, no chain. The chain tests have their own config (vitest.chain.config.ts).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
