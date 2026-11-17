import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests: pure functions only, no chain. The chain tests have their own config (vitest.chain.config.ts).
export default defineConfig({
  // The app's own import alias (tsconfig.json), so a test can import modules that use it.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
