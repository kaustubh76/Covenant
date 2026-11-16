// Pre-flight: run an action against the vault in a simulated next block, then read the vault back with the lens in
// the same simulation. The result is what the contract would do, exactly: the revert it would raise, or the state it
// would leave, with no transaction sent and nothing changed.

import { type Abi, type Address, type Hex, decodeEventLog } from "viem";
import { covenantLensAbi, covenantVaultAbi } from "./abi.generated";
import type { Actor } from "./accounts";
import type { ChainCtx } from "./client";
import { type DecodedError, decodeRevert } from "./errors";
import { simulate } from "./tx";
import { type LensState, type VaultView, viewFromSnapshot } from "./view";

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

export async function preflight(ctx: ChainCtx, actor: Actor, call: ActionCall, base: VaultView): Promise<Preflight> {
  const describe = { now: base.time + 1, quoteSymbol: base.quoteSymbol, tokenSymbol: base.tokenSymbol };
  const latest = await ctx.pub.getBlock({ blockTag: "latest" });
  try {
    const [block] = await ctx.pub.simulateBlocks({
      blocks: [
        {
          // the block the transaction would land in: next number, next second
          blockOverrides: { number: latest.number + 1n, time: latest.timestamp + 1n },
          calls: [
            { account: ctx.address(actor), to: call.address, abi: call.abi, functionName: call.functionName, args: call.args, value: call.value },
            { to: ctx.net.manifest.lens, abi: covenantLensAbi, functionName: "snapshot", args: [base.address] },
          ],
        },
      ],
    } as never);
    const [action, snapshot] = (block as unknown as { calls: { status: string; result?: unknown; error?: unknown; logs?: never[] }[] }).calls;
    if (action.status !== "success") return { ok: false, error: decodeRevert(action.error, describe), events: [] };
    return {
      ok: true,
      value: action.result,
      after: snapshot.status === "success" ? viewFromSnapshot(base, snapshot.result as LensState) : undefined,
      events: vaultEvents(action.logs, base.address),
    };
  } catch {
    // No eth_simulateV1 on this RPC: fall back to a plain call, which still gives the verdict.
    const o = await simulate(ctx, actor, call as never, describe);
    return { ok: o.ok, error: o.error, value: o.value, events: [] };
  }
}
