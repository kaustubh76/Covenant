import type { Address } from "viem";
import { covenantFactoryAbi, covenantVaultAbi, lbpStrategyAbi, testTokenAbi } from "./abi.generated";
import type { ChainCtx } from "./client";
import { scanLogs } from "./logs";
import type { LaunchRecord } from "./network";

const symbols = new Map<Address, string>();
/** Public chains only: a launch, once adopted, stays adopted, so it is not read again on every block. */
const adopted = new Map<string, LaunchRecord>();
/** Every launch last listed, by network and vault. */
const listed = new Map<string, LaunchRecord>();

/** The record of `vault`'s launch, as last listed or as the runtime records it: when it was created, what to keep. */
export function launchRecord(ctx: ChainCtx, vault: Address): LaunchRecord | undefined {
  const v = vault.toLowerCase();
  return listed.get(`${ctx.net.key}:${v}`) ?? ctx.net.runtime?.launches.find((l) => l.vault.toLowerCase() === v);
}

const INITIALIZER_CREATED = lbpStrategyAbi.find((e) => e.type === "event" && e.name === "InitializerCreated") as Extract<
  (typeof lbpStrategyAbi)[number],
  { type: "event"; name: "InitializerCreated" }
>;

/**
 * Every Covenant launch on the chain: LBPStrategy emits the full migration parameters when a launch is registered, so
 * each auction maps to the vault named as its LP recipient. Only recipients the factory created are listed. On a
 * public chain the strategy is Uniswap's shared one and logs can only be scanned so far back, so the launches the
 * launch script recorded come first, then `known` ones (those this browser has seen before), then whatever the recent
 * scan finds. Each is checked against the factory, so a stale or forged `known` record is dropped.
 */
export async function discoverLaunches(ctx: ChainCtx, known: readonly LaunchRecord[] = []): Promise<LaunchRecord[]> {
  const m = ctx.net.manifest;
  const floor = BigInt(m.deployedAtBlock ?? 0);
  const logs = await scanLogs(ctx, "launches", floor, (fromBlock, toBlock) =>
    ctx.pub.getLogs({ address: m.lbpStrategy, event: INITIALIZER_CREATED, fromBlock, toBlock }),
  );
  const found: Omit<LaunchRecord, "adopted" | "symbol">[] = [
    ...(ctx.net.caps.devChain ? [] : (ctx.net.runtime?.launches ?? [])),
    ...(ctx.net.caps.devChain ? [] : known),
    ...logs.map((log) => {
      const mp = log.args.migrationParams as { token: Address; positionRecipient: Address };
      return { vault: mp.positionRecipient, token: mp.token, auction: log.args.initializer as Address, createdAtBlock: Number(log.blockNumber) };
    }),
  ];

  const out: LaunchRecord[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    const id = `${ctx.net.key}:${f.vault.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const cached = ctx.net.caps.devChain ? undefined : adopted.get(id);
    if (cached) {
      out.push(cached);
      listed.set(id, cached);
      continue;
    }
    const isVault = await ctx.pub.readContract({ address: m.factory, abi: covenantFactoryAbi, functionName: "isVault", args: [f.vault] });
    if (!isVault) continue;
    let symbol = symbols.get(f.token);
    if (!symbol) {
      symbol = await ctx.pub.readContract({ address: f.token, abi: testTokenAbi, functionName: "symbol" }).catch(() => "TOKEN");
      symbols.set(f.token, symbol);
    }
    const adoptedAt = await ctx.pub.readContract({ address: f.vault, abi: covenantVaultAbi, functionName: "adoptedAt" });
    const record: LaunchRecord = { ...f, symbol, adopted: adoptedAt > 0n };
    if (record.adopted && !ctx.net.caps.devChain) adopted.set(id, record);
    out.push(record);
    listed.set(id, record);
  }
  return out;
}
