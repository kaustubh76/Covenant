// npm run fork [-- --port 8548] [--block-time 2] [--blocks 128] [--fork-block N] [--exit]
//
// A rehearsal of the Base Sepolia deployment and launch, on a local fork of the live chain (scripts/lib/forkchain.ts):
// the real deploy script beside Uniswap's deployed contracts, then the launch in 2-second blocks, as it will run on Base
// Sepolia (whose blocks come every 200 ms). The app reaches the result as the "Base Sepolia fork" network. Records go to
// deployments/84532-fork*.json, never to the real chain's files.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/localchain";
import { startFork } from "./lib/forkchain";
import { progressPath } from "./lib/publiclaunch";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

async function main() {
  const env = join(ROOT, ".env");
  if (existsSync(env)) process.loadEnvFile(env);
  const t0 = Date.now();
  const fork = await startFork({
    port: num(arg("port")),
    blockTime: num(arg("block-time")),
    durationBlocks: num(arg("blocks")),
    forkBlock: num(arg("fork-block")),
    log: (s) => console.log(s),
  });
  console.log(`fork: progress: ${progressPath(fork.records)}`);
  console.log(`fork: ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  let stopping = false;
  const shutdown = async (why: string, code = 0) => {
    stopping = true;
    console.log(`fork: stopping (${why})`);
    await fork.stop();
    process.exit(code);
  };
  if (argv.includes("--exit")) return shutdown("--exit");
  fork.anvil.proc.once("exit", (code, signal) => {
    if (stopping) return;
    console.log(`fork: anvil exited (code ${code}, signal ${signal})`);
    process.exit(1);
  });
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  console.log("fork: running. Ctrl-C to stop.");
}

main().catch((e) => {
  console.error(`fork: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
