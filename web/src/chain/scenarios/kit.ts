// A small toolkit for scripted scenarios (the guided demo, the attack lab, the recorder and the chain tests). Each
// helper mirrors one in the Solidity suite, so a scenario reads like the test it replays.
//
// One rule throughout: a call the suite expects to revert (vm.expectRevert) is pre-flighted and recorded, never sent.

import { type Address, type Hex, maxUint256, parseEther } from "viem";
import { covenantVaultAbi, testTokenAbi } from "../abi.generated";
import type { Actor } from "../accounts";
import { type BeatInput, beatOf } from "../beat";
import type { ChainCtx } from "../client";
import { devControls } from "../client";
import { advance } from "../time";
import { type Outcome, must, receiptFor, send } from "../tx";
import { type VaultView, readVaultView } from "../view";

export interface Kit {
  ctx: ChainCtx;
  record(beats: BeatInput | BeatInput[]): void;
  progress(label: string): void;
}

/** A kit that keeps its beats in a list, for sandboxed runs whose beats are shown apart from the activity log. */
export function collectingKit(ctx: ChainCtx, progress: (label: string) => void = () => {}): Kit & { beats: BeatInput[] } {
  const beats: BeatInput[] = [];
  return { ctx, beats, progress, record: (b) => beats.push(...(Array.isArray(b) ? b : [b])) };
}

type VaultFn =
  | "reshape"
  | "restore"
  | "deposit"
  | "withdraw"
  | "withdrawPrincipal"
  | "proposeCurator"
  | "acceptCurator"
  | "cancelCuratorProposal"
  | "fundBounty"
  | "collectFees"
  | "poke";

/** Call a vault function as `actor` and record how it ended. Sent when the contract accepts it. */
export async function attempt(
  k: Kit,
  actor: Actor,
  title: string,
  vault: Address,
  functionName: VaultFn,
  args: readonly unknown[],
  opts: { value?: bigint; detail?: (o: Outcome) => string | undefined } = {},
): Promise<Outcome> {
  const o = await send(k.ctx, actor, { address: vault, abi: covenantVaultAbi, functionName, args, value: opts.value } as never);
  k.record(beatOf(o, actor, title, () => opts.detail?.(o)));
  return o;
}

export const view = (k: Kit, vault: Address) => readVaultView(k.ctx, vault);

/** Hold the current price long enough for spot and TWAP to agree (CovenantTestBase._settleTwap). */
export const settleTwap = (k: Kit, v: VaultView) => advance(k.ctx, v.terms.twapWindow + 3600);

/** Mint tokens to `who` and approve the vault and the swap router (CovenantTestBase._fund). */
export async function fund(k: Kit, who: Actor, v: Pick<VaultView, "token" | "address">, amount = parseEther("100000")) {
  const me = k.ctx.address(who);
  must(await send(k.ctx, who, { address: v.token, abi: testTokenAbi, functionName: "mint", args: [me, amount] }), "mint");
  for (const spender of [v.address, k.ctx.net.manifest.swapRouter as Address]) {
    must(await send(k.ctx, who, { address: v.token, abi: testTokenAbi, functionName: "approve", args: [spender, maxUint256] }), "approve");
  }
}

export const tokenBalance = (k: Kit, token: Address, who: Actor) => k.ctx.pub.readContract({ address: token, abi: testTokenAbi, functionName: "balanceOf", args: [k.ctx.address(who)] });

/**
 * Land several transactions in one block, the way calls inside one Solidity test share a block. Automine is paused
 * while they queue, then one block is mined. Each sender returns its transaction hash without waiting for it.
 */
export async function sameBlock(k: Kit, senders: (() => Promise<Hex>)[]): Promise<void> {
  const test = devControls(k.ctx);
  await test.setAutomine(false);
  try {
    const hashes: Hex[] = [];
    for (const s of senders) hashes.push(await s());
    await test.mine({ blocks: 1 });
    for (const hash of hashes) {
      const r = await receiptFor(k.ctx, hash);
      if (r.status !== "success") throw new Error(`same-block transaction ${hash} reverted`);
    }
  } finally {
    await test.setAutomine(true);
  }
}

export const ticksAsDrop = (ticks: number) => `${((1 - Math.exp(-ticks * Math.log(1.0001))) * 100).toFixed(1)}%`;
export const ticksAsRise = (ticks: number) => `${((Math.exp(ticks * Math.log(1.0001)) - 1) * 100).toFixed(1)}%`;
