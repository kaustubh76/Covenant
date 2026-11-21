import { NextResponse } from "next/server";
import type { Hex } from "viem";
import { NETWORKS } from "@/chain/network";
import { type SnapRecord, acceptRecord, judge, parseMetadata, sendBatch, snapshotId } from "@/chain/snapguard";
import { localChain, saveRuntime, servedNetworks } from "@/server/deployments";

export const dynamic = "force-dynamic";

/** One reset at a time: a second one racing the first would revert to the baseline the first had just used up. */
let turn: Promise<unknown> = Promise.resolve();
/** The baseline this server took last, with its record, so the next reset can check it fully (chain/snapguard.ts). */
let taken: SnapRecord | null = null;

const META = { method: "anvil_metadata", params: [] as unknown[] };
const hashOf = (r: unknown) => (r && typeof r === "object" && typeof (r as { hash?: unknown }).hash === "string" ? ((r as { hash: string }).hash.toLowerCase() as Hex) : null);

/**
 * Put the local chain back to the freshly seeded state: revert to the baseline snapshot, take a new one (Anvil consumes
 * a snapshot when it reverts to it) and record its id, so the next reset works too, from any tab.
 */
export async function POST() {
  // A server that does not offer the local chain (a hosted copy) has nothing to reset.
  if (!servedNetworks().includes("local")) return NextResponse.json({ ok: false, reason: "This copy of the app does not run a local chain." }, { status: 404 });
  const next = turn.then(reset);
  turn = next.catch(() => undefined);
  return next;
}

async function reset(): Promise<NextResponse> {
  const local = await localChain();
  if (local.state !== "ready" || !local.network.runtime) return NextResponse.json({ ok: false, reason: local.state === "offline" ? local.reason : "not seeded" }, { status: 409 });
  const { rpcUrl, runtime } = { rpcUrl: local.network.rpcUrl, runtime: local.network.runtime };
  const baseline = runtime.baselineSnapshot;
  if (!baseline) return NextResponse.json({ ok: false, reason: "The local chain has no baseline snapshot. Restart it with make demo." }, { status: 409 });
  const gone = () =>
    NextResponse.json({ ok: false, reason: "The baseline snapshot is gone (the chain was reset from elsewhere or restarted). Restart it with make demo." }, { status: 409 });

  // Checked before it is sent: a revert to a snapshot that is gone takes the blocks back without the state, or leaves the
  // chain's head on a block it no longer has (chain/snapguard.ts).
  const id = snapshotId(baseline);
  const [m] = await sendBatch(rpcUrl, [META], 10_000);
  const now = parseMetadata(m?.result);
  if (now && id !== null) {
    const at = now.listed.get(id);
    const block = at ? (await sendBatch(rpcUrl, [{ method: "eth_getBlockByNumber", params: [`0x${at.number.toString(16)}`, false] }], 10_000))[0] : undefined;
    const rec = taken && snapshotId(taken.id) === id ? taken : null;
    if (!judge(baseline, rec, now, hashOf(block?.result)).ok) return gone();
  }
  const [reverted] = await sendBatch(rpcUrl, [{ method: "evm_revert", params: [baseline] }], 10_000);
  if (reverted?.error) {
    return NextResponse.json({ ok: false, reason: `The chain could not go back to its baseline (${reverted.error.message}). Restart it with make demo.` }, { status: 500 });
  }
  if (reverted?.result !== true) return gone();

  // The new baseline, between two reads of the chain's snapshots, so the next reset can check it.
  const [pre, snap, post] = await sendBatch(rpcUrl, [META, { method: "evm_snapshot", params: [] }, META], 10_000);
  const baselineSnapshot = snap?.result;
  if (typeof baselineSnapshot !== "string" || snapshotId(baselineSnapshot) === null) {
    return NextResponse.json({ ok: false, reason: `The chain is back at its seed, but took no new baseline (${snap?.error?.message ?? "no id"}). Restart it with make demo.` }, { status: 500 });
  }
  const before = parseMetadata(pre?.result);
  const after = parseMetadata(post?.result);
  taken = before && after ? acceptRecord(before, baselineSnapshot as Hex, after) : null;
  await saveRuntime(NETWORKS.local.records, { ...runtime, baselineSnapshot: baselineSnapshot as Hex });
  return NextResponse.json({ ok: true, baselineSnapshot });
}
