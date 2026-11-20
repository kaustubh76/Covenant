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
import type { ActionCall } from "../../src/chain/preflight";
import { type Outcome, send, simulate } from "../../src/chain/tx";
import { rpc } from "./localchain";

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

  const onResume = "settled before the runner stopped, and recorded when it resumed";

  /**
   * A step that must settle, sent from `a.ctx`'s own signer. Already recorded: returned as it was. Landed in an earlier
   * run: recorded from its receipt, with `onResume` as its detail. `detail` reads what the step did from its outcome.
   */
  const settle = async (key: K, a: Attempt & { detail?: (o: Outcome) => string | Promise<string>; value?: (o: Outcome) => bigint | undefined }): Promise<RunStep> => {
    const done = p.steps[key];
    if (done) return done;
    const prior = await landed(key);
    if (prior) {
      record(key, { title: a.title, status: "success", ...mined(prior.transactionHash, prior), detail: onResume });
      return p.steps[key] as RunStep;
    }
    const from = signerOf(a.ctx);
    const sent = await send(a.ctx, from, a.call as never, { ...sending(key), describe: a.describe?.() });
    if (!sent.ok) throw new Error(`${key} (${a.title}) failed: ${sent.error?.signature ?? sent.refused ?? "unknown error"}. ${sent.error?.reason ?? ""}`.trim());
    const value = a.value?.(sent);
    record(key, { title: a.title, status: "success", ...mined(sent.hash, sent.receipt), detail: (await a.detail?.(sent)) ?? "settled", ...(value !== undefined ? { value: value.toString() } : {}) });
    return p.steps[key] as RunStep;
  };

  /**
   * A step the contracts must refuse, put on chain anyway so the refusal is the chain's own: pre-flighted first, and
   * sent only if the pre-flight fails with one of `expect` (anything else stops the run with nothing sent). It goes out
   * with a gas limit from a simulation, since an estimate of a revert fails, and its error is decoded by replaying it
   * in its own block. One that an earlier run sent and that settled stops the run: the contract accepted what it should
   * have refused, and that is for a person to look at, not something to send again.
   */
  const refuse = async (key: K, a: Attempt & { expect: string | string[]; detail?: (e: DecodedError) => string }): Promise<RunStep> => {
    const done = p.steps[key];
    if (done) return done;
    const expect = Array.isArray(a.expect) ? a.expect : [a.expect];
    const earlier = p.pending?.[key];
    if (earlier) {
      const r = await ctx.pub.getTransactionReceipt({ hash: earlier }).catch(() => null);
      if (r?.status === "success") throw new Error(`${key} (${a.title}) was meant to be refused, but ${link(earlier)} settled. Nothing more was sent.`);
    }
    let receipt = await landed(key, "reverted");
    if (!receipt) {
      const from = signerOf(a.ctx);
      const pre = await simulate(a.ctx, from, a.call as never, a.describe?.());
      if (pre.ok) throw new Error(`${key} (${a.title}) passed pre-flight; it was meant to be refused with ${expect.join(" or ")}. Nothing was sent.`);
      if (!expect.includes(pre.error?.name ?? "")) {
        throw new Error(`${key} (${a.title}) was refused with ${pre.error?.signature ?? "an unknown error"}, not ${expect.join(" or ")}. Nothing was sent.`);
      }
      const gas = await gasOf(a.ctx, from, a.call);
      const w = a.ctx.wallet("holder");
      const hash = await w.writeContract({ ...(a.call as object), account: w.account, chain: a.ctx.chain, gas } as never);
      sending(key).onHash(hash);
      receipt = await ctx.pub.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 180_000 });
      if (receipt.status !== "reverted") throw new Error(`${key} (${a.title}) was meant to revert, but it settled: ${link(hash)}`);
    }
    const err = await replayTx(ctx, receipt.transactionHash, a.describe?.());
    if (!expect.includes(err.name)) log(`  note: the chain refused ${key} with ${err.signature}, where the pre-flight said ${expect.join(" or ")}`);
    record(key, { title: a.title, status: "reverted", ...mined(receipt.transactionHash, receipt), error: err.signature, detail: a.detail?.(err) ?? `${err.signature}: ${err.reason}` });
    return p.steps[key] as RunStep;
  };

  return { save, link, record, sending, landed, settle, refuse, onResume };
}

/** One call, from one context's signer, with the title it is recorded under. */
export interface Attempt {
  ctx: ChainCtx;
  call: ActionCall;
  title: string;
  describe?: () => DescribeContext;
}

const signerOf = (ctx: ChainCtx): Address => {
  if (!ctx.signer) throw new Error("this context has no signer");
  return ctx.signer;
};

/**
 * Wait until `check` says done, polling every `pollMs` (a minute by default), logging its note at most once a minute. On
 * a fork, `warp` jumps the clock by the seconds `check` says are left instead, and mines a block.
 */
export async function hold(o: {
  label: string;
  check: () => Promise<{ done: boolean; left?: number; note?: string }>;
  warp?: { rpcUrl: string };
  pollMs?: number;
  log: (line: string) => void;
  /** Give up after this many seconds of real waiting (default: six hours). */
  maxS?: number;
}): Promise<void> {
  const started = Date.now();
  let lastLog = 0;
  for (let jumps = 0; ; ) {
    const r = await o.check();
    if (r.done) return;
    if (o.warp) {
      if (++jumps > 20) throw new Error(`${o.label}: still waiting after 20 jumps`);
      await rpc(o.warp.rpcUrl, "evm_increaseTime", [Math.max(1, Math.ceil(r.left ?? 60))]);
      await rpc(o.warp.rpcUrl, "evm_mine", []);
      continue;
    }
    if ((Date.now() - started) / 1000 > (o.maxS ?? 6 * 3600)) throw new Error(`${o.label}: gave up waiting`);
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      o.log(`  ${o.label}${r.note ? `: ${r.note}` : ""}${r.left !== undefined ? ` (about ${Math.max(1, Math.ceil(r.left / 60))} min)` : ""}`);
    }
    const wait = o.pollMs ?? 60_000;
    await new Promise((res) => setTimeout(res, r.left !== undefined ? Math.min(wait, Math.max(2_000, r.left * 1000 + 2_000)) : wait));
  }
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
export async function gasOf(ctx: ChainCtx, from: Address, call: { address: Address; abi: Abi | readonly unknown[]; functionName: string; args: readonly unknown[]; value?: bigint }): Promise<bigint> {
  const latest = await ctx.pub.getBlock({ blockTag: "latest" });
  const [block] = (await ctx.pub.simulateBlocks({
    blockNumber: latest.number,
    blocks: [{ blockOverrides: { number: latest.number + 1n, time: latest.timestamp + 1n }, calls: [{ account: from, to: call.address, abi: call.abi, functionName: call.functionName, args: call.args, value: call.value }] }],
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
