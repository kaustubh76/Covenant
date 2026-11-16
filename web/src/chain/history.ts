// The vault's history, read back from the chain: every vault event and every swap in its pool, attributed to the
// demo actor that sent the transaction. This keeps the activity feed after a reload and includes other tabs' actions.

import { type Address, type Hex, type Log, decodeEventLog, formatEther } from "viem";
import { covenantVaultAbi, poolManagerAbi } from "./abi.generated";
import { type Who, actorOf } from "./accounts";
import type { Beat } from "./beat";
import type { ChainCtx } from "./client";
import type { VaultView } from "./view";

const MAX_LOGS = 300;
const blockTimes = new Map<Hex, number>();
const senders = new Map<Hex, Address>();
const n = (x: bigint) => Number(formatEther(x));
const amt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3));
const pct = (bps: bigint | number) => `${(Number(bps) / 100).toFixed(1)}%`;

function describe(name: string, args: Record<string, unknown>, v: VaultView): { title: string; detail?: string; actor?: Who } | null {
  const q = (a0: bigint, a1: bigint) => (v.quoteIs0 ? `${amt(n(a0))} ETH and ${amt(n(a1))} ${v.tokenSymbol}` : `${amt(n(a1))} ETH and ${amt(n(a0))} ${v.tokenSymbol}`);
  // decoded event arguments: amounts are bigints, `tokenIds` a list, addresses read through `who`
  const a = args as unknown as Record<string, bigint> & { tokenIds: readonly bigint[] };
  const who = (k: string) => actorOf(args[k] as Address);
  switch (name) {
    case "Adopted":
      return { title: "Launch liquidity adopted", detail: `${a.tokenIds.length} launcher position${a.tokenIds.length === 1 ? "" : "s"} → ${a.rangesAfter} vault range${a.rangesAfter === 1n ? "" : "s"}` };
    case "Reshaped":
      return { title: "Reshape", detail: `Moved ${(Number(a.movedFraction) / 1e7).toFixed(1)}% of the vault's value. Support ${pct(a.supportBps)} across ${a.rangesAfter} ranges.`, actor: who("curator") };
    case "Restored":
      return { title: "Support restored", detail: `Support ${pct(a.supportBefore)} → ${pct(a.supportAfter)}. Bounty paid: ${amt(n(a.bounty))} ETH`, actor: who("keeper") };
    case "Deposited":
      return { title: "Deposit", detail: `${amt(n(a.shares))} shares for ${q(a.amount0, a.amount1)}`, actor: who("owner") };
    case "Withdrawn":
      return { title: "Withdrawal", detail: `${amt(n(a.shares))} shares for ${q(a.amount0, a.amount1)}`, actor: who("owner") };
    case "PrincipalWithdrawn":
      return { title: "Principal withdrawn to the treasury", detail: `${(n(a.shares) * 100).toFixed(1)}% of principal: ${q(a.amount0, a.amount1)}`, actor: "issuer" };
    case "CuratorProposed":
      return { title: "New curator proposed", detail: `Can take over after the timelock`, actor: "issuer" };
    case "CuratorProposalCancelled":
      return { title: "Curator proposal cancelled", actor: "issuer" };
    case "CuratorChanged":
      return { title: "Curator changed", detail: "The new curator is bound by the same rules" };
    case "IssuerTransferStarted":
      return { title: "Issuer transfer started" };
    case "IssuerTransferred":
      return { title: "Issuer role transferred" };
    case "FeesCollected":
      return { title: "Fees collected", detail: `${q(a.toTreasury0, a.toTreasury1)} to the treasury, ${amt(n(a.toBountyPool))} ETH to the bounty pool` };
    case "FeesClaimed":
      return { title: "LP fees claimed", detail: q(a.amount0, a.amount1), actor: who("account") };
    case "CuratorFeesClaimed":
      return { title: "Curator fees claimed", detail: q(a.amount0, a.amount1), actor: who("curator") };
    case "BountyFunded":
      return { title: "Bounty pool funded", detail: `${amt(n(a.amount))} ETH`, actor: who("from") };
    default:
      return null;
  }
}

export async function readHistory(ctx: ChainCtx, v: VaultView): Promise<Beat[]> {
  const [vaultLogs, swapLogs] = await Promise.all([
    ctx.pub.getLogs({ address: v.address, fromBlock: 0n, toBlock: "latest" }),
    ctx.pub.getLogs({
      address: ctx.net.manifest.poolManager,
      event: poolManagerAbi.find((e) => e.type === "event" && e.name === "Swap") as Extract<(typeof poolManagerAbi)[number], { type: "event"; name: "Swap" }>,
      args: { id: v.poolId },
      fromBlock: 0n,
      toBlock: "latest",
    }),
  ]);
  const logs = [...vaultLogs, ...swapLogs].sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.logIndex ?? 0) - (b.logIndex ?? 0)).slice(-MAX_LOGS);

  // Block times and senders never change for a given block hash or transaction hash, so they are fetched once. (Block
  // numbers do repeat after a snapshot revert, which is why times are keyed by hash.)
  await Promise.all(
    [...new Set(logs.map((l) => l.blockHash!))]
      .filter((h) => !blockTimes.has(h))
      .map(async (h) => blockTimes.set(h, Number((await ctx.pub.getBlock({ blockHash: h })).timestamp))),
  );
  await Promise.all(
    [...new Set(logs.map((l) => l.transactionHash!))]
      .filter((h) => !senders.has(h))
      .map(async (h) => senders.set(h, (await ctx.pub.getTransaction({ hash: h })).from)),
  );

  const out: Beat[] = [];
  for (const log of logs as Log[]) {
    const from = actorOf(senders.get(log.transactionHash!)) ?? "anyone";
    const base = { at: blockTimes.get(log.blockHash!) ?? 0, block: Number(log.blockNumber), hash: log.transactionHash!, ok: true, source: "chain" as const, id: `${log.transactionHash}:${log.logIndex}` };
    if (log.address.toLowerCase() === v.address.toLowerCase()) {
      try {
        const d = decodeEventLog({ abi: covenantVaultAbi, data: log.data, topics: log.topics });
        const desc = describe(d.eventName, (d.args ?? {}) as Record<string, unknown>, v);
        if (desc) out.push({ ...base, actor: desc.actor ?? from, title: desc.title, detail: desc.detail });
      } catch {
        /* an event this app does not show */
      }
    } else {
      const d = decodeEventLog({ abi: poolManagerAbi, data: log.data, topics: log.topics, eventName: "Swap" });
      const { amount0, amount1 } = d.args as { amount0: bigint; amount1: bigint };
      // Deltas are from the pool's side: negative means the pool paid it out to the trader.
      const quoteDelta = v.quoteIs0 ? amount0 : amount1;
      const tokenDelta = v.quoteIs0 ? amount1 : amount0;
      const buy = tokenDelta > 0n; // the trader received tokens
      const tokens = n(buy ? tokenDelta : -tokenDelta);
      const quote = n(buy ? -quoteDelta : quoteDelta);
      out.push({
        ...base,
        actor: from === "anyone" ? "market" : from,
        title: buy ? `Bought ${amt(tokens)} ${v.tokenSymbol}` : `Sold ${amt(tokens)} ${v.tokenSymbol}`,
        detail: `${buy ? "Paid" : "Received"} ${amt(quote)} ETH`,
      });
    }
  }
  return out.reverse();
}
