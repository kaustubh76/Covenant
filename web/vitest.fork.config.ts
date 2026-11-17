import { defineConfig } from "vitest/config";

// The fork tests: Base Sepolia's deployment and launch rehearsed on a local fork of the live chain, then the app's
// public-chain code path against it (no Anvil controls, one signer for every role). Needs network access; skipped
// when Base Sepolia cannot be reached.
//   npm run test:fork
export default defineConfig({
  test: {
    // fork-proof.test.ts starts a fork of its own (port 8551) for the live proof's runner; files run one at a time.
    include: ["test/fork.test.ts", "test/fork-proof.test.ts"],
    globalSetup: ["test/fork.setup.ts"],
    testTimeout: 300_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
