// What the proof runners share (proof.ts, lpproof.ts): a JSON record of steps that resumes safely.
//
// Each transaction's hash is saved the moment it is broadcast (tx.ts `onHash`), before its receipt is waited for. A rerun
// after a crash or a dropped connection looks for those hashes first: one that landed as it should is recorded, never
// sent again; one that never landed is sent afresh. One still waiting in the mempool stops the run, since sending it again
// could land twice.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Abi, type Address, type Hex, type TransactionReceipt, decodeEventLog, isAddressEqual } from "viem";
import { covenantVaultAbi } from "../../src/chain/abi.generated";
import type { ChainCtx } from "../../src/chain/client";
import { type DecodedError, type DescribeContext, decodeRevert } from "../../src/chain/errors";
import { explorerTx } from "../../src/chain/network";

export interface RunStep {
  title: string;
  status: "success" | "reverted";
  hash: Hex;
  block: number;
  detail: string;
  /** The revert, decoded, for a transaction meant to fail. */
  error?: string;
  /** An amount the step moved, in wei: a bounty paid, a pool topped up, shares minted. */
  value?: string;
}

export interface RunRecord<K extends string> {
  steps: Partial<Record<K, RunStep>>;
  /** Hashes broadcast but not yet recorded. A rerun settles these before it sends anything. */
  pending?: Partial<Record<K, Hex>>;
}

export function loadRecord<R>(path: string, fresh?: boolean): R | null {
  return !fresh && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as R) : null;
}

export const mined = (hash: Hex | undefined, receipt: TransactionReceipt | undefined) => ({ hash: hash as Hex, block: Number(receipt?.blockNumber ?? 0n) });

export function runKit<K extends string>(o: { path: string; record: RunRecord<K>; ctx: ChainCtx; check?: boolean; log: (line: string) => void }) {
  const { record: p, ctx, log } = o;
  const save = () => {
    if (!o.check) writeFileSync(o.path, JSON.stringify(p, null, 2) + "\n");
  };
  const link = (h: Hex) => explorerTx(ctx.net, h) ?? h;

  const record = (key: K, step: RunStep) => {
    p.steps[key] = step;
    if (p.pending) delete p.pending[key];
    save();
    log(`${step.title}: ${step.status === "reverted" ? "reverted on chain" : "settled"} in block ${step.block}  ${link(step.hash)}`);
    log(`  ${step.detail}`);
  };

  /** Send options that save `key`'s hash as soon as it is broadcast. */
  const sending = (key: K) => ({
    onHash: (hash: Hex) => {
      p.pending ??= {} as Partial<Record<K, Hex>>;
      p.pending[key] = hash;
      save();
    },
  });

  /**
   * `key`'s transaction from an earlier run, if it landed as `want`: its receipt, to record without sending again.
   * Otherwise null, with the stale hash cleared so the step is sent afresh.
   */
  const landed = async (key: K, want: "success" | "reverted" = "success"): Promise<TransactionReceipt | null> => {
    const hash = p.pending?.[key];
    if (!hash) return null;
    const receipt = await ctx.pub.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 90_000 }).catch(() => null);
    if (receipt?.status === want) return receipt;
    if (!receipt && (await ctx.pub.getTransaction({ hash }).catch(() => null))) {
      throw new Error(`${key}: ${hash} is still waiting to be mined. Run again once it has landed or been dropped.`);
    }
    delete p.pending![key];
    save();
    log(`${key}: ${hash} ${receipt ? `ended ${receipt.status}` : "never landed"}; sending it again`);
    return null;
  };

  return { save, link, record, sending, landed };
}

/**
 * Why a mined transaction reverted: its own calldata replayed in its own block. A reverted transaction changed nothing,
 * so that block's state is the one it ran on, and the block's timestamp keeps arguments that move with time exact:
 * replayed a block earlier, PaceExceeded's `available` comes out a second's refill short of what the chain said.
 */
export async function replayTx(ctx: ChainCtx, hash: Hex, describe: DescribeContext = {}): Promise<DecodedError> {
  const [tx, receipt] = await Promise.all([ctx.pub.getTransaction({ hash }), ctx.pub.getTransactionReceipt({ hash })]);
  if (receipt.status !== "reverted") throw new Error(`${hash} did not revert`);
  try {
    await ctx.pub.call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, blockNumber: receipt.blockNumber });
  } catch (e) {
    return decodeRevert(e, describe);
  }
  throw new Error(`replaying ${hash} did not revert`);
}

/** A call's gas as the chain would use it (reverting or not), with room to spare, for sending it unestimated. */
export async function gasOf(ctx: ChainCtx, from: Address, call: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args: readonly unknown[] }): Promise<bigint> {
  const latest = await ctx.pub.getBlock({ blockTag: "latest" });
  const [block] = (await ctx.pub.simulateBlocks({
    blockNumber: latest.number,
    blocks: [{ blockOverrides: { number: latest.number + 1n, time: latest.timestamp + 1n }, calls: [{ account: from, to: call.address, abi: call.abi, functionName: call.functionName, args: call.args }] }],
  } as never)) as unknown as { calls: { gasUsed: bigint }[] }[];
  return (block.calls[0].gasUsed * 3n) / 2n + 100_000n;
}

/** The vault's `name` event in a receipt, decoded, or null. */
export function vaultEvent(receipt: TransactionReceipt | undefined, vault: Address, name: string): Record<string, unknown> | null {
  for (const log of receipt?.logs ?? []) {
    if (!isAddressEqual(log.address, vault)) continue;
    try {
      const d = decodeEventLog({ abi: covenantVaultAbi, data: log.data, topics: log.topics });
      if (d.eventName === name) return d.args as Record<string, unknown>;
    } catch {
      /* another event */
    }
  }
  return null;
}
