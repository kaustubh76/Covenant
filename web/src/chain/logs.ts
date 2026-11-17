// Log scans that work on public RPCs, which cap how many blocks one eth_getLogs may span (Base Sepolia's: 200).
//
// On the dev chain a scan is one call from block 0: Anvil has no cap, and its history can be rewound by a snapshot
// revert, so nothing is cached. On a public chain a scan covers a bounded recent window in spans the RPC accepts, and
// what was read is kept, so each refresh only reads the blocks that are new since the last one.

import type { ChainCtx } from "./client";

/**
 * How far back a public chain's activity is read on first load: six minutes of Base Sepolia's 200 ms blocks, in nine
 * calls. Older activity worth keeping (a launch, the live proof) is read from the runtime record's kept spans instead.
 */
export const PUBLIC_WINDOW = 1800n;
const PARALLEL = 4;

/** Read [from, to] in spans of at most `caps.logRange` blocks, a few spans at a time, in block order. */
export async function scanRange<T>(ctx: ChainCtx, from: bigint, to: bigint, read: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>): Promise<T[]> {
  if (from > to) return [];
  const span = ctx.net.caps.logRange ? BigInt(ctx.net.caps.logRange) : 0n;
  if (!span || to - from + 1n <= span) return read(from, to);
  const spans: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += span) spans.push([a, a + span - 1n < to ? a + span - 1n : to]);
  const out: T[] = [];
  for (let i = 0; i < spans.length; i += PARALLEL) {
    const batch = await Promise.all(spans.slice(i, i + PARALLEL).map(([a, b]) => read(a, b)));
    for (const items of batch) out.push(...items);
  }
  return out;
}

interface Cursor<T> {
  /** The last block read. */
  to: bigint;
  items: T[];
}

const cursors = new Map<string, Cursor<unknown>>();

/**
 * Everything `read` returns from `floor` (or the recent window) up to the latest block. Public chains keep what was
 * read under `key` and only read new blocks afterwards; the dev chain reads it all, every time, from `floor`.
 */
export async function scanLogs<T>(
  ctx: ChainCtx,
  key: string,
  floor: bigint,
  read: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  window: bigint = PUBLIC_WINDOW,
): Promise<T[]> {
  const latest = await ctx.pub.getBlockNumber({ cacheTime: 0 });
  if (ctx.net.caps.devChain) return scanRange(ctx, floor, latest, read);
  const id = `${ctx.net.key}:${key}`;
  const cursor = cursors.get(id) as Cursor<T> | undefined;
  const from = cursor ? cursor.to + 1n : latest - window > floor ? latest - window : floor;
  const fresh = await scanRange(ctx, from, latest, read);
  const items = cursor ? [...cursor.items, ...fresh] : fresh;
  cursors.set(id, { to: latest, items });
  return items;
}

const spans = new Map<string, unknown[]>();

/**
 * A fixed span of past blocks, read once and kept: on a public chain, the blocks just after a launch, which soon fall
 * behind the recent window. Nothing is read while the recent window still covers the span's start, nor on the dev
 * chain, whose scans read every block anyway. A span that reaches past the head is read but not kept.
 */
export async function scanOnce<T>(
  ctx: ChainCtx,
  key: string,
  from: bigint,
  to: bigint,
  read: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  window: bigint = PUBLIC_WINDOW,
): Promise<T[]> {
  if (ctx.net.caps.devChain) return [];
  const id = `${ctx.net.key}:${key}`;
  const kept = spans.get(id) as T[] | undefined;
  if (kept) return kept;
  const latest = await ctx.pub.getBlockNumber({ cacheTime: 0 });
  if (from >= latest - window) return [];
  const end = to < latest ? to : latest;
  const items = await scanRange(ctx, from, end, read);
  if (end === to) spans.set(id, items);
  return items;
}

/** Forget a network's cached scans (after switching networks, or when its records change). */
export function forgetScans(netKey?: string): void {
  for (const map of [cursors, spans]) for (const id of [...map.keys()]) if (!netKey || id.startsWith(`${netKey}:`)) map.delete(id);
}

/**
 * Kept spans covering `blocks` too, merged wherever one log call (`span` blocks) reads them together. Every kept span
 * costs each visitor a call per `span` blocks on first load, so a run that spans thousands of blocks keeps only the
 * blocks its events are in.
 */
export function mergeSpans(spans: readonly (readonly [number, number])[], blocks: readonly number[], span = 200): [number, number][] {
  const all = [...spans.map(([a, b]) => [a, b] as [number, number]), ...blocks.map((b) => [b, b] as [number, number])].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of all) {
    const last = out[out.length - 1];
    if (last && Math.max(b, last[1]) - last[0] < span) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
