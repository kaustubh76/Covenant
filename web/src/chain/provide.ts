// Deposits in kind, priced the way the Provide page and the LP proof both price them: simulate the deposit from the
// depositor's own address, then pay what the simulation says plus a little slack. The vault refunds native ETH it does
// not need, and takes tokens only up to the cap the call names.

import { type Address, maxUint256, parseEther } from "viem";
import { covenantVaultAbi, testTokenAbi } from "./abi.generated";
import type { ChainCtx } from "./client";
import { NEVER } from "./launch";
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
