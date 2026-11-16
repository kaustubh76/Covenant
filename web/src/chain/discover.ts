import type { Address } from "viem";
import { covenantFactoryAbi, covenantVaultAbi, lbpStrategyAbi, testTokenAbi } from "./abi.generated";
import type { ChainCtx } from "./client";
import type { LaunchRecord } from "./network";

const symbols = new Map<Address, string>();

/**
 * Every Covenant launch on the chain: LBPStrategy emits the full migration parameters when a launch is registered, so
 * each auction maps to the vault named as its LP recipient. Only recipients the factory created are listed.
 */
export async function discoverLaunches(ctx: ChainCtx): Promise<LaunchRecord[]> {
  const m = ctx.net.manifest;
  const logs = await ctx.pub.getLogs({
    address: m.lbpStrategy,
    event: lbpStrategyAbi.find((e) => e.type === "event" && e.name === "InitializerCreated") as Extract<
      (typeof lbpStrategyAbi)[number],
      { type: "event"; name: "InitializerCreated" }
    >,
    fromBlock: 0n,
    toBlock: "latest",
  });
  const out: LaunchRecord[] = [];
  for (const log of logs) {
    const auction = log.args.initializer as Address;
    const mp = log.args.migrationParams as { token: Address; positionRecipient: Address };
    const isVault = await ctx.pub.readContract({ address: m.factory, abi: covenantFactoryAbi, functionName: "isVault", args: [mp.positionRecipient] });
    if (!isVault) continue;
    let symbol = symbols.get(mp.token);
    if (!symbol) {
      symbol = await ctx.pub.readContract({ address: mp.token, abi: testTokenAbi, functionName: "symbol" }).catch(() => "TOKEN");
      symbols.set(mp.token, symbol);
    }
    const adoptedAt = await ctx.pub.readContract({ address: mp.positionRecipient, abi: covenantVaultAbi, functionName: "adoptedAt" });
    out.push({ vault: mp.positionRecipient, token: mp.token, symbol, auction, createdAtBlock: Number(log.blockNumber), adopted: adoptedAt > 0n });
  }
  return out;
}
