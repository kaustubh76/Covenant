// npm run demo   (make demo from the repository root)
// The whole local demo in one command: Anvil with Uniswap's launch stack and Covenant, a seeded launch, and the app.
// Ctrl-C stops both.

import { spawn } from "node:child_process";
import { startLocalChain } from "./lib/localchain";

async function main() {
  const argv = process.argv.slice(2);
  const chain = await startLocalChain({ reuse: argv.includes("--reuse"), log: (s) => console.log(`chain: ${s}`) });
  console.log(`chain: ready on ${chain.rpcUrl}. Default vault ${chain.runtime.defaultVault}`);

  const port = process.env.PORT ?? "3000";
  // Turbopack keeps its build cache in memory, so the dev build stays small on disk.
  const app = spawn("npx", ["next", "dev", "--turbopack", "--port", port], { stdio: "inherit", env: process.env });
  console.log(`app: http://localhost:${port}`);

  let stopping = false;
  const stop = async (why: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    console.log(`demo: stopping (${why})`);
    if (app.exitCode === null) app.kill("SIGTERM");
    await chain.stop();
    process.exit(code);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  app.on("exit", (code) => void stop(`the app exited with ${code}`, code ?? 0));
  chain.onExit?.((code) => void stop(`anvil exited with ${code}`, 1));
}

main().catch((e) => {
  console.error(`demo: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
