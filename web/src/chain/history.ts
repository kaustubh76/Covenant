// The vault's history, read back from the chain: every vault event and every swap in its pool, attributed to the
// demo actor that sent the transaction. This keeps the activity feed after a reload and includes other tabs' actions.

import { type Address, type Hex, type Log, decodeEventLog, formatEther, getAddress, isAddressEqual } from "viem";
import { covenantVaultAbi, poolManagerAbi } from "./abi.generated";
import { type Who, actorOf, shortAddress } from "./accounts";
import type { Beat } from "./beat";
import type { ChainCtx } from "./client";
import { launchRecord } from "./discover";
import { scanLogs, scanOnce } from "./logs";
import type { VaultView } from "./view";

const MAX_LOGS = 300;
/** How many blocks after its vault is created a launch's own story (adoption, the seed, the bounty) is read from. */
const LAUNCH_SPAN = 600n;

/** The block spans a vault's feed keeps for good: its launch's first blocks, and any its launch record lists. */
function keptSpans(ctx: ChainCtx, vault: Address): [bigint, bigint][] {
  const launch = launchRecord(ctx, vault);
  if (!launch) return [];
  const born = BigInt(launch.createdAtBlock);
  return [[born, born + LAUNCH_SPAN], ...(launch.spans ?? []).map(([a, b]) => [BigInt(a), BigInt(b)] as [bigint, bigint])];
}
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

const SWAP = poolManagerAbi.find((e) => e.type === "event" && e.name === "Swap") as Extract<(typeof poolManagerAbi)[number], { type: "event"; name: "Swap" }>;

export async function readHistory(ctx: ChainCtx, v: VaultView): Promise<Beat[]> {
  // On a public chain only the recent window is read on first load, then only new blocks (logs.ts). Kept spans (the
  // launch's first blocks, the live proof's) are read once, so the vault's own story stays in the feed after that.
  const floor = BigInt(ctx.net.manifest.deployedAtBlock ?? 0);
  const readVault = (fromBlock: bigint, toBlock: bigint) => ctx.pub.getLogs({ address: v.address, fromBlock, toBlock });
  const readSwaps = (fromBlock: bigint, toBlock: bigint) =>
    ctx.pub.getLogs({ address: ctx.net.manifest.poolManager, event: SWAP, args: { id: v.poolId }, fromBlock, toBlock });
  const kept = keptSpans(ctx, v.address);
  const [keptVault, keptSwaps, vaultLogs, swapLogs] = await Promise.all([
    Promise.all(kept.map(([a, b]) => scanOnce(ctx, `vault:${v.address}:${a}`, a, b, readVault))),
    Promise.all(kept.map(([a, b]) => scanOnce(ctx, `swaps:${v.poolId}:${a}`, a, b, readSwaps))),
    scanLogs(ctx, `vault:${v.address}`, floor, readVault),
    scanLogs(ctx, `swaps:${v.poolId}`, floor, readSwaps),
  ]);
  // Kept spans and the recent window can overlap: keep each log once.
  const seen = new Set<string>();
  const logs = [...keptVault.flat(), ...keptSwaps.flat(), ...vaultLogs, ...swapLogs]
    .filter((l) => !seen.has(`${l.transactionHash}:${l.logIndex}`) && !!seen.add(`${l.transactionHash}:${l.logIndex}`))
    .sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || (a.logIndex ?? 0) - (b.logIndex ?? 0))
    .slice(-MAX_LOGS);

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
    const sender = senders.get(log.transactionHash!);
    const from = actorOf(sender) ?? "anyone";
    // On a public chain the senders are real accounts, not demo roles: name yours as yours and the rest by address.
    const by = !ctx.net.caps.devChain && from === "anyone" && sender ? (ctx.signer && isAddressEqual(sender, ctx.signer) ? "You" : shortAddress(getAddress(sender))) : undefined;
    const base = { at: blockTimes.get(log.blockHash!) ?? 0, block: Number(log.blockNumber), hash: log.transactionHash!, ok: true, source: "chain" as const, id: `${log.transactionHash}:${log.logIndex}`, ...(by ? { by } : {}) };
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
