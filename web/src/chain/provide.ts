// Deposits in kind, priced the way the Provide page and the LP proof both price them: simulate the deposit from the
// depositor's own address, then pay what the simulation says plus a little slack. The vault refunds native ETH it does
// not need, and takes tokens only up to the cap the call names.

import { type Abi, type Address, maxUint256, parseEther } from "viem";
import { covenantVaultAbi, testTokenAbi } from "./abi.generated";
import type { ChainCtx } from "./client";
import { classify } from "./failure";
import { decodeRevert } from "./errors";
import { NEVER } from "./launch";
import type { Preflight } from "./preflight";
import { type Party, must, partyAddress, send } from "./tx";
import type { VaultView } from "./view";

/** Pay a little over the simulated cost: the vault refunds any native ETH it does not need. */
export const withSlack = (x: bigint) => x + x / 200n + 1n;

export function depositCall(v: Pick<VaultView, "address">, shares: bigint, value: bigint) {
  return { address: v.address, abi: covenantVaultAbi, functionName: "deposit" as const, args: [shares, maxUint256, maxUint256, NEVER] as const, value };
}

/**
 * A generous native amount to simulate the deposit with, from the vault's own holdings: the vault refunds what it does
 * not need. `cap` keeps it within what the payer can spend; a simulation that sends more than the account holds fails
 * for that alone, before the vault is asked anything. The lens's principal already counts idle quote (CovenantLens
 * `_ranges`), so idle is not added again.
 */
export const quoteBudget = (v: Pick<VaultView, "principal">, fraction: number, cap?: bigint) => {
  const budget = parseEther((v.principal.quote * fraction * 1.1 + 0.01).toFixed(18));
  return cap !== undefined && cap < budget ? (cap > 0n ? cap : 0n) : budget;
};

/**
 * Approve the vault to pull `amount` of the token from `who`, if it may not already. `exact` approves just that amount,
 * for a person's own wallet on a public chain, rather than leaving the vault an open-ended allowance.
 */
export async function ensureAllowance(ctx: ChainCtx, who: Party, v: Pick<VaultView, "address" | "token">, amount: bigint, exact = false) {
  const owner: Address = partyAddress(ctx, who);
  const allowance = await ctx.pub.readContract({ address: v.token, abi: testTokenAbi, functionName: "allowance", args: [owner, v.address] });
  if (allowance < amount) must(await send(ctx, who, { address: v.token, abi: testTokenAbi, functionName: "approve", args: [v.address, exact ? amount : maxUint256] }), "approve");
}

/** A stand-in depositor with no role, funded only inside a simulation (as the attack lab's live checks fund theirs). */
const STAND_IN: Address = "0x0000000000000000000000000000000000001a1f";

/**
 * A deposit's exact cost for a visitor with no wallet on a public chain: simulated from a stand-in given ETH by state
 * override and the tokens by a transfer from the issuer, in one block on top of the head. Nothing is sent. Fails, with
 * the contract's reason, when the vault refuses the deposit (the setup epoch, the guard), or when the issuer holds too
 * few tokens to fund the stand-in.
 */
export async function standInDeposit(ctx: ChainCtx, v: Pick<VaultView, "address" | "token" | "principal" | "people" | "time" | "tokenSymbol">, shares: bigint, fraction: number): Promise<Preflight> {
  const describe = { now: v.time + 1, tokenSymbol: v.tokenSymbol };
  const tokens = parseEther((v.principal.token * fraction * 1.2 + 1e-6).toFixed(18));
  const value = quoteBudget(v, fraction);
  try {
    const latest = await ctx.pub.getBlock({ blockTag: "latest" });
    const [block] = (await ctx.pub.simulateBlocks({
      blockNumber: latest.number,
      blocks: [
        {
          blockOverrides: { number: latest.number + 1n, time: latest.timestamp + 1n },
          stateOverrides: [{ address: STAND_IN, balance: value + parseEther("1") }],
          calls: [
            { account: v.people.issuer, to: v.token, abi: testTokenAbi as Abi, functionName: "transfer", args: [STAND_IN, tokens] },
            { account: STAND_IN, to: v.token, abi: testTokenAbi as Abi, functionName: "approve", args: [v.address, maxUint256] },
            { account: STAND_IN, to: v.address, abi: covenantVaultAbi as Abi, functionName: "deposit", args: [shares, maxUint256, maxUint256, NEVER], value },
          ],
        },
      ],
    } as never)) as unknown as { calls: { status: string; result?: unknown; error?: unknown }[] }[];
    const [fund, , deposit] = block.calls;
    // The issuer could not lend the stand-in enough tokens: no exact figure, rather than a wrong one.
    if (fund.status !== "success") return { ok: false, error: { name: "NoPreview", args: [], signature: "No preview", rule: "Other", reason: "Connect a wallet to price this deposit exactly." }, events: [] };
    if (deposit.status !== "success") return { ok: false, error: decodeRevert(deposit.error, describe), events: [] };
    return { ok: true, value: deposit.result, events: [] };
  } catch (e) {
    return { ok: false, error: classify(e) ?? decodeRevert(e, describe), events: [] };
  }
}
