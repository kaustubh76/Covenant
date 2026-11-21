// Pre-flight: run an action against the vault in a simulated next block, then read the vault back with the lens in
// the same simulation. The result is what the contract would do, exactly: the revert it would raise, or the state it
// would leave, with no transaction sent and nothing changed.

import { type Abi, type Address, type Hex, decodeEventLog } from "viem";
import { covenantLensAbi, covenantVaultAbi } from "./abi.generated";
import type { ChainCtx } from "./client";
import { type DecodedError, decodeRevert } from "./errors";
import { type Party, partyAddress, simulate } from "./tx";
import { type LensState, type VaultView, viewFromSnapshot } from "./view";
import { classify } from "./failure";

export interface VaultEvent {
  name: string;
  args: Record<string, unknown>;
}

export interface Preflight {
  ok: boolean;
  error?: DecodedError;
  /** The vault as the action would leave it. Missing when the action reverts, or the RPC cannot simulate blocks. */
  after?: VaultView;
  /** Vault events the action would emit, e.g. Reshaped(movedFraction, rangesAfter, supportBps). */
  events: VaultEvent[];
  /** The block the action was simulated in (the head's next), when it was simulated as a block: what a page names. */
  simulatedAt?: bigint;
  value?: unknown;
}

export interface ActionCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

export function vaultEvents(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[] | undefined, vault: Address): VaultEvent[] {
  const out: VaultEvent[] = [];
  for (const log of logs ?? []) {
    if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: covenantVaultAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      out.push({ name: d.eventName, args: (d.args ?? {}) as Record<string, unknown> });
    } catch {
      /* not a vault event */
    }
  }
  return out;
}

/**
 * `setup` calls run first, from the same account and in the same simulated block: an `approve` a wallet has not sent
 * yet, so a deposit's cost can be shown exactly before the approval exists. A setup call that fails fails the action.
 */
export async function preflight(ctx: ChainCtx, party: Party, call: ActionCall, base: VaultView, setup: ActionCall[] = []): Promise<Preflight> {
  const describe = { now: base.time + 1, quoteSymbol: base.quoteSymbol, tokenSymbol: base.tokenSymbol };
  const account = partyAddress(ctx, party);
  try {
    const latest = await ctx.pub.getBlock({ blockTag: "latest" });
    const [block] = await ctx.pub.simulateBlocks({
      // On top of the block just read. Unpinned, the simulation builds on the RPC's head at the time of this call, and
      // on a public chain that has often moved on a block, so the overrides below fall behind it and are rejected.
      blockNumber: latest.number,
      blocks: [
        {
          // the block the transaction would land in: next number, next second
          blockOverrides: { number: latest.number + 1n, time: latest.timestamp + 1n },
          calls: [
            ...setup.map((s) => ({ account, to: s.address, abi: s.abi, functionName: s.functionName, args: s.args, value: s.value })),
            { account, to: call.address, abi: call.abi, functionName: call.functionName, args: call.args, value: call.value },
            { to: ctx.net.manifest.lens, abi: covenantLensAbi, functionName: "snapshot", args: [base.address] },
          ],
        },
      ],
    } as never);
    const calls = (block as unknown as { calls: { status: string; result?: unknown; error?: unknown; logs?: never[] }[] }).calls;
    const failedSetup = calls.slice(0, setup.length).find((c) => c.status !== "success");
    const simulatedAt = latest.number + 1n;
    if (failedSetup) return { ok: false, error: decodeRevert(failedSetup.error, describe), events: [], simulatedAt };
    const [action, snapshot] = calls.slice(setup.length);
    if (action.status !== "success") return { ok: false, error: decodeRevert(action.error, describe), events: [], simulatedAt };
    return {
      ok: true,
      simulatedAt,
      value: action.result,
      after: snapshot.status === "success" ? viewFromSnapshot(base, snapshot.result as LensState) : undefined,
      events: vaultEvents(action.logs, base.address),
    };
  } catch (e) {
    // A node that did not answer (rate-limited, unreachable) is not a verdict: say so. Falling back to a plain call
    // would drop the setup calls, and a deposit would then fail on its token transfer for no reason of its own.
    const why = classify(e);
    if (why) return { ok: false, error: why, events: [] };
    // No eth_simulateV1 on this RPC: fall back to a plain call, which still gives the verdict (without setup calls,
    // so a missing approval shows as the transfer's failure).
    const o = await simulate(ctx, party, call as never, describe);
    return { ok: o.ok, error: o.error, value: o.value, events: [] };
  }
}

/** A preview that could not be made, as a failed preflight that says why, for pages to show instead of waiting forever. */
export function failedPreflight(e: unknown): Preflight {
  const reason = e instanceof Error ? e.message.split("\n")[0] : String(e);
  return { ok: false, error: classify(e) ?? { name: "Error", args: [], signature: "The check failed", rule: "Other", reason }, events: [] };
}
