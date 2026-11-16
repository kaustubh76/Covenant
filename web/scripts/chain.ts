// npm run chain [-- --port 8545] [-- --reuse]
// Starts a local Anvil chain with Uniswap's stack, Covenant and a seeded launch, then keeps it running.

import { formatEther } from "viem";
import { covenantLensAbi } from "../src/chain/abi.generated";
import { startLocalChain } from "./lib/localchain";

async function main() {
  const argv = process.argv.slice(2);
  const portArg = argv.indexOf("--port");
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : undefined;
  const t0 = Date.now();
  const chain = await startLocalChain({ port, reuse: argv.includes("--reuse"), log: (s) => console.log(`chain: ${s}`) });

  const m = chain.net.manifest;
  const s = await chain.ctx.pub.readContract({ address: m.lens, abi: covenantLensAbi, functionName: "snapshot", args: [chain.runtime.defaultVault] });
  console.log("");
  console.log(`  RPC              ${chain.rpcUrl}`);
  console.log(`  Covenant factory ${m.factory}`);
  console.log(`  Lens             ${m.lens}`);
  console.log(`  Default vault    ${chain.runtime.defaultVault}`);
  console.log(`  Support          ${s.supportBps} bps (needs ${s.terms.supportBps})`);
  console.log(`  Principal        ${Number(formatEther(s.principalQuote)).toFixed(3)} ETH + ${Number(formatEther(s.principalToken)).toFixed(3)} tokens in ${s.ranges.length} ranges`);
  console.log(`  Baseline         snapshot ${chain.runtime.baselineSnapshot}`);
  console.log(`  Ready in         ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("");

  if (argv.includes("--exit")) {
    await chain.stop();
    return;
  }
  console.log("chain: running. Ctrl-C to stop.");
  const shutdown = async (why: string, code = 0) => {
    console.log(`chain: stopping (${why})`);
    await chain.stop();
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  // A long-running dev process should say why it stops, and never leave Anvil behind.
  process.on("uncaughtException", (e) => void shutdown(`uncaught exception: ${e.stack ?? e.message}`, 1));
  process.on("unhandledRejection", (e) => void shutdown(`unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`, 1));
  chain.onExit?.((code, signal) => {
    console.log(`chain: anvil exited (code ${code}, signal ${signal})`);
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(`chain: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
