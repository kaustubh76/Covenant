import { NextResponse } from "next/server";
import type { Hex } from "viem";
import { localChain, rpc, saveRuntime } from "@/server/deployments";

export const dynamic = "force-dynamic";

/**
 * Put the local chain back to the freshly seeded state: revert to the baseline snapshot, take a new one (Anvil consumes
 * a snapshot when it reverts to it) and record its id, so the next reset works too, from any tab.
 */
export async function POST() {
  const local = await localChain();
  if (local.state !== "ready" || !local.network.runtime) return NextResponse.json({ ok: false, reason: local.state === "offline" ? local.reason : "not seeded" }, { status: 409 });
  const { rpcUrl, runtime } = { rpcUrl: local.network.rpcUrl, runtime: local.network.runtime };
  if (!runtime.baselineSnapshot) return NextResponse.json({ ok: false, reason: "The local chain has no baseline snapshot. Restart it with make demo." }, { status: 409 });
  const reverted = await rpc<boolean>(rpcUrl, "evm_revert", [runtime.baselineSnapshot], 10_000).catch(() => false);
  if (!reverted) {
    return NextResponse.json(
      { ok: false, reason: "The baseline snapshot is gone (the chain was reset from elsewhere or restarted). Restart it with make demo." },
      { status: 409 },
    );
  }
  const baselineSnapshot = await rpc<Hex>(rpcUrl, "evm_snapshot", [], 10_000);
  await saveRuntime(local.network.chainId, { ...runtime, baselineSnapshot });
  return NextResponse.json({ ok: true, baselineSnapshot });
}
