import type { Hex } from "viem";
import { type ChainCtx, devControls } from "./client";
import {
  type ChainSnapshots,
  type GoneWhy,
  type RpcAnswer,
  type Send,
  type SnapRecord,
  acceptRecord,
  judge,
  notOffered,
  parseMetadata,
  sendBatch,
  snapshotId,
  withChainLock,
} from "./snapguard";

export async function latest(ctx: ChainCtx): Promise<{ number: bigint; timestamp: bigint }> {
  const b = await ctx.pub.getBlock({ blockTag: "latest" });
  return { number: b.number, timestamp: b.timestamp };
}

/**
 * Move the chain clock forward and mine a block there. The local chain stamps one second per block otherwise, so the
 * clock (and with it the TWAP and the Guard) only moves when something happens.
 */
export async function advance(ctx: ChainCtx, seconds: number): Promise<void> {
  const test = devControls(ctx);
  const { timestamp } = await latest(ctx);
  await test.setNextBlockTimestamp({ timestamp: timestamp + BigInt(Math.max(1, Math.round(seconds))) });
  await test.mine({ blocks: 1 });
}

/** Blocks a public chain is waited past the one asked for (reach). */
export const REACH_MARGIN = 2n;

/**
 * Until the next block is at least `blockNumber`, so a call gated on it can go now (pre-flights run in the pending
 * block). The dev chain mines there at once; a public chain is waited for, since its blocks come on their own.
 */
export async function reach(ctx: ChainCtx, blockNumber: bigint, onWait?: (latest: bigint, target: bigint) => void): Promise<void> {
  if (ctx.test) return mineTo(ctx, blockNumber - 1n);
  // A public RPC answers from whichever node a call reaches, and one can be a block or two behind the one that said the
  // height was reached: the call waiting on it would be simulated there, and refused as too early. Two blocks more, 400
  // ms on Base Sepolia, puts every node past it.
  const target = blockNumber + REACH_MARGIN;
  for (;;) {
    const now = await ctx.pub.getBlockNumber({ cacheTime: 0 });
    if (now + 1n >= target) return;
    onWait?.(now, target);
    // Once a block, but no more than once a second: Base Sepolia makes a block every 200 ms.
    await new Promise((r) => setTimeout(r, Math.max(ctx.net.caps.blockTimeMs, 1000)));
  }
}

/**
 * The most blocks one mine may ask for: the Playground backend's own per-call cap. The app's longest wait is a dev
 * launch's auction, about 200 blocks. A target far beyond it is a block height from another chain (a public launch's,
 * say): mining to it would stall the chain and fill its memory, at about 75 KB a block.
 */
export const MAX_MINE = 1_000;

/** A mine refused before it was asked for: `target` is too far ahead of `from`. Nothing was mined. */
export class TooManyBlocks extends Error {
  override name = "TooManyBlocks";
  constructor(
    readonly target: bigint,
    readonly from: bigint,
    readonly cap: number = MAX_MINE,
  ) {
    super(`Block ${target} is ${target - from} blocks ahead of this chain, more than the ${cap.toLocaleString("en-US")} it mines at once. Nothing was mined.`);
  }
}

/** Mine empty blocks until `blockNumber` is the latest block. Refuses, with TooManyBlocks, a target past MAX_MINE. */
export async function mineTo(ctx: ChainCtx, blockNumber: bigint): Promise<void> {
  const test = devControls(ctx);
  const { number } = await latest(ctx);
  if (blockNumber <= number) return;
  if (blockNumber - number > BigInt(MAX_MINE)) throw new TooManyBlocks(blockNumber, number);
  await test.mine({ blocks: Number(blockNumber - number) });
}

// Snapshots. Anvil goes back safely only to a snapshot that is still live (snapguard.ts says why, and how that is told).
// Where the chain says what it holds (anvil_metadata), each snapshot is taken between two reads of that, its record is
// kept, and a revert is checked against the chain first: one that cannot go safely throws SnapshotGone and sends
// nothing. A Playground backend that predates anvil_metadata gets the plain calls, as before.

let send: Send = sendBatch;
/** Whether the chain at each URL says what it holds: unknown until asked, false for a backend that refuses it. */
const offered = new Map<string, boolean>();
/** The record of every snapshot taken from this page, by chain URL and id, until a revert takes it back. */
const records = new Map<string, Map<bigint, SnapRecord>>();

/** Tests: answer the snapshot calls (anvil_metadata, evm_snapshot, evm_revert, eth_getBlockByNumber) with `fake`. */
export function setSnapshotSender(fake: Send | null): void {
  send = fake ?? sendBatch;
  offered.clear();
  records.clear();
}

/** Which snapshots a revert took with it: those from its id on, only its own, or every one on that chain. */
export type Gone = "from" | "one" | "all";
type RevertListener = (url: string, id: Hex, gone: Gone) => void;
const listeners = new Set<RevertListener>();

/** Hear of every revert sent from this page, whatever it answered, and which snapshots it took with it. */
export function onReverted(fn: RevertListener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function forget(url: string, id: Hex, gone: Gone): void {
  const mine = records.get(url);
  const r = snapshotId(id);
  if (mine && r !== null) for (const k of [...mine.keys()]) if (gone === "all" || (gone === "one" ? k === r : k >= r)) mine.delete(k);
  for (const fn of listeners) fn(url, id, gone);
}

const META = { method: "anvil_metadata", params: [] as unknown[] };
const blockCall = (n: number) => ({ method: "eth_getBlockByNumber", params: [`0x${n.toString(16)}`, false] as unknown[] });
const hashOf = (a: RpcAnswer | undefined): Hex | null => {
  const r = a?.result as { hash?: unknown } | null | undefined;
  return r && typeof r.hash === "string" ? (r.hash.toLowerCase() as Hex) : null;
};
const rpcError = (e: NonNullable<RpcAnswer["error"]>) => Object.assign(new Error(e.message), { code: e.code, details: e.message });

function readMeta(url: string, a: RpcAnswer | undefined): ChainSnapshots | null {
  if (!a) throw new Error("No answer from the chain");
  if (a.error) {
    if (notOffered(a.error)) {
      offered.set(url, false);
      return null;
    }
    throw rpcError(a.error);
  }
  const m = parseMetadata(a.result);
  // An answer this cannot read is treated as none: the plain calls, as before.
  offered.set(url, m !== null);
  return m;
}

/** What the chain lists of its snapshots, or null when it does not say. */
export async function chainSnapshots(ctx: ChainCtx): Promise<ChainSnapshots | null> {
  devControls(ctx);
  const url = ctx.net.rpcUrl;
  if (offered.get(url) === false) return null;
  const [a] = await send(url, [META]);
  return readMeta(url, a);
}

/** Take a snapshot; returns its id. Where the chain says what it holds, the snapshot's record is kept, for revertTo. */
export async function snapshot(ctx: ChainCtx): Promise<Hex> {
  return (await takeSnapshot(ctx)).id;
}

/**
 * Take a snapshot, with its record where the chain says what it holds: one request reads the chain, takes the snapshot
 * and reads it again, so the record knows what was live beneath it. One the reads cannot vouch for (another tab or tool
 * at work at that moment) is taken again once, then refused.
 */
export async function takeSnapshot(ctx: ChainCtx): Promise<{ id: Hex; record: SnapRecord | null }> {
  const test = devControls(ctx);
  const url = ctx.net.rpcUrl;
  if (offered.get(url) === undefined) await chainSnapshots(ctx);
  if (offered.get(url) !== true) return { id: await test.snapshot(), record: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    const took = await withChainLock(url, async () => {
      const [a, s, b] = await send(url, [META, { method: "evm_snapshot", params: [] }, META]);
      if (s?.error) throw rpcError(s.error);
      const id = s?.result;
      if (typeof id !== "string" || snapshotId(id) === null) throw new Error("The chain took no snapshot (it answered without an id).");
      const pre = readMeta(url, a);
      let post = readMeta(url, b);
      if (!pre || !post) return { id: id as Hex, record: null, plain: true };
      // Anvil runs a batch's calls at once, and a snapshot waits for the state while a read does not: the read after it
      // can come back first, without it. Read again, still under the lock, rather than take another.
      if (!post.listed.has(snapshotId(id)!)) post = readMeta(url, (await send(url, [META]))[0]) ?? post;
      return { id: id as Hex, record: acceptRecord(pre, id as Hex, post), plain: false };
    });
    if (took.plain) return { id: took.id, record: null };
    if (took.record) {
      if (!records.has(url)) records.set(url, new Map());
      records.get(url)!.set(snapshotId(took.id)!, took.record);
      return { id: took.id, record: took.record };
    }
  }
  throw new Error("The chain kept changing while the snapshot was taken (blocks mined, or snapshots taken back, by something else at work on it), so it was not used. Try again.");
}

const GONE_TEXT = {
  gone: "That save point is gone: the chain was reset, or taken back past it, since it was taken. Nothing was sent.",
  restarted: "That save point is gone: the chain has restarted since it was taken. Nothing was sent.",
  torn: "That save point is gone, and going back to it did not finish cleanly: something else changed the chain's snapshots at the same moment, so the chain may have moved partway. Reset it to start clean.",
};

/**
 * A snapshot the chain cannot go back to: `gone` (reset, or taken back past it) or `restarted` (another chain now), both
 * refused before anything was sent; or `torn`, a revert that went out and did not finish cleanly because something else
 * changed the chain's snapshots at the same moment.
 */
export class SnapshotGone extends Error {
  override name = "SnapshotGone";
  constructor(
    readonly id: Hex,
    readonly why: GoneWhy | "torn" = "gone",
  ) {
    super(GONE_TEXT[why]);
  }
}

/**
 * Go back to snapshot `id`: Anvil restores state, block number and clock, and uses the snapshot up. Where the chain says
 * what it holds, the revert is checked against it first (snapguard.ts) and sent only when it can go cleanly; otherwise
 * SnapshotGone, and nothing sent. `record` is the snapshot's, when the caller kept it (a save point after a reload);
 * else the one kept when it was taken here. After any revert, the snapshots it took with it are forgotten (onReverted).
 */
export async function revertTo(ctx: ChainCtx, id: Hex, record?: SnapRecord | null): Promise<void> {
  const test = devControls(ctx);
  const url = ctx.net.rpcUrl;
  const s = snapshotId(id);
  if (offered.get(url) === undefined) await chainSnapshots(ctx);
  if (offered.get(url) !== true || s === null) {
    // A chain that does not say what it holds: the plain revert. Anvil answers false for an id it does not list, and
    // drops every later snapshot either way.
    const reverted: unknown = await test.request({ method: "evm_revert", params: [id] });
    forget(url, id, "from");
    if (reverted === false) throw new SnapshotGone(id);
    return;
  }
  const rec = record ?? records.get(url)?.get(s) ?? null;
  await withChainLock(url, async () => {
    const asked = await send(url, rec ? [META, blockCall(rec.block.number)] : [META]);
    const now = readMeta(url, asked[0]);
    if (!now) throw new Error("The chain stopped saying which snapshots it holds, so nothing was sent.");
    const at = now.listed.get(s);
    const hash = rec ? hashOf(asked[1]) : at ? hashOf((await send(url, [blockCall(at.number)]))[0]) : null;
    const verdict = judge(id, rec, now, hash);
    if (!verdict.ok) throw new SnapshotGone(id, verdict.why);

    let answer: RpcAnswer | null = null;
    try {
      [answer] = await send(url, [{ method: "evm_revert", params: [id] }]);
    } catch {
      answer = null; // no answer: whether it ran is read from the chain below
    }
    if (answer?.result === true) return forget(url, id, "from");

    // False, an error, or no answer. Anvil takes an id off its list as soon as it takes a revert in, so the list says
    // which: still listed, it never took it (the Playground's proxy refused it, or the request was lost).
    const after = await chainSnapshots(ctx).catch(() => null);
    if (after?.listed.has(s)) {
      if (answer?.result === false) {
        forget(url, id, "one");
        throw new SnapshotGone(id, "gone");
      }
      throw answer?.error ? rpcError(answer.error) : new Error("The chain did not answer the revert, and did not take it: nothing moved.");
    }
    // Taken in. With no answer to go by, it ran cleanly if the head is back on the snapshot's own block, and that block
    // is there; an answer of false here is a revert Anvil only half did.
    const target = rec?.block ?? at!;
    if (answer?.result !== false && after && after.head.number === target.number && after.head.hash === target.hash) {
      const there = hashOf((await send(url, [blockCall(target.number)]).catch(() => []))[0]);
      if (there === target.hash) return forget(url, id, "from");
    }
    forget(url, id, "all");
    throw new SnapshotGone(id, "torn");
  });
}

/** Run `fn` and put the chain back exactly as it was, whatever happens. */
export async function sandbox<T>(ctx: ChainCtx, fn: () => Promise<T>): Promise<T> {
  const id = await snapshot(ctx);
  try {
    return await fn();
  } finally {
    await revertTo(ctx, id);
  }
}
