// The attack lab's single calls, built from a live vault as it is now. The live checks (livechecks.ts) pre-flight them
// from stand-ins; the public-chain proof runners (scripts/lib/refusalproof.ts, lifecycleproof.ts) send exactly the same
// calldata from real keys, so a card's simulated refusal and its mined transaction are the same call.

import { type Address, maxUint256, zeroHash } from "viem";
import { covenantVaultAbi, liquidityRouterAbi } from "../abi.generated";
import { NEVER } from "../launch";
import type { Manifest } from "../network";
import { type Leg, type Plan, SINK, bidLeg, cut, reserveIndex, skim, softRug } from "../plans";
import type { ActionCall } from "../preflight";
import type { VaultView } from "../view";

/** The most ranges a reshape may leave (CovenantVault's cap, test_13_2_08). */
export const MAX_RANGES = 14;
/** A hundredth of a share: small enough to be refused for the right reason, never for its size. */
export const CENT = 10n ** 16n;

type V = Pick<VaultView, "address" | "quoteIs0" | "tickSpacing" | "terms" | "ranges" | "spotTick">;

export const vaultCall = (v: Pick<VaultView, "address">, functionName: string, args: readonly unknown[], value?: bigint): ActionCall => ({
  address: v.address,
  abi: covenantVaultAbi,
  functionName,
  args,
  ...(value !== undefined ? { value } : {}),
});
export const reshapeCall = (v: Pick<VaultView, "address">, p: Plan) => vaultCall(v, "reshape", [p.cuts, p.legs, NEVER]);

/** Slivers enough that the vault would end up over the range cap, whatever it holds now. */
export function overTheCap(v: V): Plan {
  const slivers = Math.max(12, MAX_RANGES + 1 - (v.ranges.length - 1));
  const legs: Leg[] = [];
  let top = v.spotTick - v.terms.supportBandTicks;
  for (let i = 0; i < slivers; i++) {
    legs.push(bidLeg(v, top - 60, top, i === 0 ? SINK : 300));
    top -= 60;
  }
  return { cuts: [cut(reserveIndex(v))], legs };
}

/**
 * The curator tries to take value out. Where the curator is also the issuer (one key holding both roles, as on the
 * first live vaults), asking for the principal would only show the issuer's lock; the curator's own exit, an LP
 * withdrawal of shares it does not hold, is the honest question there.
 */
export function curatorWithdrawCall(v: Pick<VaultView, "address" | "people">): {
  call: ActionCall;
  title: string;
} {
  const same = v.people.curator.toLowerCase() === v.people.issuer.toLowerCase();
  return same
    ? {
        call: vaultCall(v, "withdraw", [CENT, 0n, 0n, NEVER]),
        title: "The curator withdraws shares it does not hold",
      }
    : {
        call: vaultCall(v, "withdrawPrincipal", [CENT, 0n, 0n, NEVER]),
        title: "The curator asks for the issuer's principal",
      };
}
export const curatorSharesCall = (v: Pick<VaultView, "address">) => vaultCall(v, "withdraw", [CENT, 0n, 0n, NEVER]);
export const curatorPrincipalCall = (v: Pick<VaultView, "address">) => vaultCall(v, "withdrawPrincipal", [CENT, 0n, 0n, NEVER]);

export const skimCall = (v: V) => reshapeCall(v, skim(v));
export const softRugCall = (v: V) => reshapeCall(v, softRug(v));
export const fragmentCall = (v: V) => reshapeCall(v, overTheCap(v));
/** A 1-wei cut and nothing re-added: the smallest state change the guard checks. */
export const nudgeCall = (v: Pick<VaultView, "address">) => reshapeCall(v, { cuts: [cut(0, 1n)], legs: [] });

/** More principal than has vested. */
export const issuerExitCall = (v: Pick<VaultView, "address" | "raw">) => vaultCall(v, "withdrawPrincipal", [v.raw.principalWithdrawable + CENT, 0n, 0n, NEVER]);

/** Restore on a healthy vault, naming every range. */
export const farmCall = (v: Pick<VaultView, "address" | "ranges">) => vaultCall(v, "restore", [v.ranges.map((r) => BigInt(r.index)), NEVER]);

/** Remove one of the vault's ranges directly, through the liquidity router: the router's own position is what moves. */
export function outsiderCall(v: Pick<VaultView, "key" | "ranges">, manifest: Pick<Manifest, "liquidityRouter">): ActionCall | null {
  const r = v.ranges[0];
  const lr = manifest.liquidityRouter as Address | undefined;
  if (!r || !lr) return null;
  // a modest amount: the whole of a launch's full-range position would overflow int128 first
  const delta = r.liquidity < 10n ** 18n ? r.liquidity : 10n ** 18n;
  return {
    address: lr,
    abi: liquidityRouterAbi,
    functionName: "modifyLiquidity",
    args: [
      v.key,
      {
        tickLower: r.tickLower,
        tickUpper: r.tickUpper,
        liquidityDelta: -delta,
        salt: zeroHash,
      },
      "0x",
    ],
  };
}

/** A deposit for a tenth of the shares with 1 wei attached: the vault must not cover the rest from its own balance. */
export const vaultPaysCall = (v: Pick<VaultView, "address" | "raw">) => vaultCall(v, "deposit", [v.raw.totalShares / 10n, maxUint256, maxUint256, NEVER], 1n);
