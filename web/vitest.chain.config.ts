import { defineConfig } from "vitest/config";

// Chain tests: the guided demo and the attack lab against the real contracts on a dedicated local chain.
//   npm run test:chain
export default defineConfig({
  test: {
    include: ["test/chain.test.ts"],
    globalSetup: ["test/chain.setup.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
