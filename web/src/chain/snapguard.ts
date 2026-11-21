// Going back to an Anvil snapshot, safely.
//
// Anvil (1.1.0, which the Playground runs, and 1.7.1 alike) keeps two records of its snapshots:
// - a list of each id with the block it was taken at, which `anvil_metadata` returns. A revert takes only its own id off
//   it (crates/anvil/src/eth/backend/mem/mod.rs, revert_state_snapshot);
// - the saved states. A revert drops its own id and every later one, even when its own is missing
//   (crates/evm/core/src/state_snapshot.rs, StateSnapshots::remove).
// So once the chain goes back to an earlier snapshot, the later ones are still listed but gone. Going back to one of
// those takes the blocks and the clock back but not the state, or points the head at a block that no longer exists. A
// revert to an id already used answers false and silently drops every later snapshot. `evm_revert` is safe only for a
// snapshot that is still live.
//
// Whether one is live can be read from the list. An id joins it only when it is taken, ids are never used twice, and
// every revert, live or not, takes its own id off. So a snapshot is live while it is still listed at the block it was
// taken at, with as many ids listed below it as when it was taken: a revert to any of those would have taken one off.
// Two things it cannot see are a revert to an already-used id sent by a tool outside the app, and tabs on another
// origin; the Playground's proxy refuses both kinds of revert itself (backend/src/playground/rpc.ts).

import type { Hex } from "viem";

/** A block, as a snapshot or the head names it. */
export interface BlockRef {
  number: number;
  hash: Hex;
}

/** What `anvil_metadata` says about a chain's snapshots. */
export interface ChainSnapshots {
  /** Drawn at random when Anvil starts: another value is another chain, whatever ids it gives out. */
  instance: Hex;
  head: BlockRef;
  /** Every listed snapshot id with the block it was taken at, including ids a revert past them has made stale. */
  listed: Map<bigint, BlockRef>;
}

/** A snapshot as it was when taken: what tells, later, whether the chain can still go back to it. */
export interface SnapRecord {
  id: Hex;
  instance: Hex;
  block: BlockRef;
  /** How many snapshot ids were listed below it. */
  below: number;
}

/** Why a snapshot cannot be gone back to: gone from this chain, or taken on a chain that has since restarted. */
export type GoneWhy = "gone" | "restarted";

const HASH = /^0x[0-9a-fA-F]{64}$/;

function count(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v !== "string" || !/^(0x[0-9a-fA-F]{1,16}|[0-9]{1,16})$/.test(v)) return null;
  const n = Number(BigInt(v));
  return Number.isSafeInteger(n) ? n : null;
}

/** A snapshot id as Anvil writes it, a hex string (a decimal one is read too); null for anything else. */
export function snapshotId(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v)) return null;
  return BigInt(v);
}

const block = (number: unknown, hash: unknown): BlockRef | null => {
  const n = count(number);
  return n !== null && typeof hash === "string" && HASH.test(hash) ? { number: n, hash: hash.toLowerCase() as Hex } : null;
};

/** `anvil_metadata`'s answer, or null when it is not one this can trust. */
export function parseMetadata(raw: unknown): ChainSnapshots | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.instanceId !== "string" || !HASH.test(m.instanceId)) return null;
  const head = block(m.latestBlockNumber, m.latestBlockHash);
  if (!head || !m.snapshots || typeof m.snapshots !== "object" || Array.isArray(m.snapshots)) return null;
  const listed = new Map<bigint, BlockRef>();
  for (const [k, v] of Object.entries(m.snapshots as Record<string, unknown>)) {
    const id = snapshotId(k);
    const at = Array.isArray(v) ? block(v[0], v[1]) : null;
    if (id === null || !at) return null;
    listed.set(id, at);
  }
  return { instance: m.instanceId.toLowerCase() as Hex, head, listed };
}

const sameBlock = (a: BlockRef, b: BlockRef) => a.number === b.number && a.hash.toLowerCase() === b.hash.toLowerCase();

/** How many ids are listed below `id`. */
export function listedBelow(listed: Map<bigint, BlockRef>, id: bigint): number {
  let n = 0;
  for (const k of listed.keys()) if (k < id) n++;
  return n;
}

/**
 * The record of snapshot `id`, from the chain read just before and just after it was taken, or null when those reads
 * do not vouch for it: another chain, the reads out of order, a block mined across it, or a snapshot taken back
 * meanwhile. Then it is taken again.
 */
export function acceptRecord(pre: ChainSnapshots, id: Hex, post: ChainSnapshots): SnapRecord | null {
  const s = snapshotId(id);
  if (s === null || pre.instance !== post.instance) return null;
  const at = post.listed.get(s);
  if (pre.listed.has(s) || !at || !sameBlock(at, pre.head) || !sameBlock(at, post.head)) return null;
  for (const k of pre.listed.keys()) if (!post.listed.has(k)) return null;
  return { id, instance: post.instance, block: at, below: listedBelow(post.listed, s) };
}

/**
 * Whether the chain can go back to `rec` now. `now` is the chain's list; `blockHash` the hash it gives for the
 * snapshot's block number, or null for none. Without a record (a snapshot taken before this page loaded), only what
 * the list shows is checked.
 */
export function judge(id: Hex, rec: SnapRecord | null, now: ChainSnapshots, blockHash: Hex | null): { ok: true } | { ok: false; why: GoneWhy } {
  const s = snapshotId(id);
  if (s === null) return { ok: false, why: "gone" };
  if (rec) {
    const listed = stillListed(rec, now);
    if (!listed.ok) return listed;
  }
  const at = now.listed.get(s);
  if (!at) return { ok: false, why: "gone" };
  // The snapshot's block still on the chain, and the head no lower: belt and braces for what the list cannot show.
  if (!blockHash || blockHash.toLowerCase() !== at.hash.toLowerCase() || now.head.number < at.number) return { ok: false, why: "gone" };
  return { ok: true };
}

/** What the list alone says of `rec`: on this chain, listed at its block, with as many ids below it as when taken. */
export function stillListed(rec: SnapRecord, now: ChainSnapshots): { ok: true } | { ok: false; why: GoneWhy } {
  if (rec.instance !== now.instance) return { ok: false, why: "restarted" };
  const s = snapshotId(rec.id);
  const at = s === null ? undefined : now.listed.get(s);
  if (s === null || !at || !sameBlock(at, rec.block) || listedBelow(now.listed, s) !== rec.below) return { ok: false, why: "gone" };
  return { ok: true };
}

/** What a revert to `id` leaves of `points`, whatever Anvil answered: none at or above it. */
export function afterRevert<T extends { id: Hex }>(points: T[], id: Hex): T[] {
  const r = snapshotId(id);
  return r === null ? points : points.filter((p) => (snapshotId(p.id) ?? r) < r);
}

/** A save point: a snapshot to come back to, and the chain's clock when it was taken. */
export interface SavePoint extends SnapRecord {
  at: number;
}

/** The save points this browser keeps for a network, all taken on one chain (`instance`). */
export interface StoredSavePoints {
  instance: Hex;
  points: SavePoint[];
}

/** Stored save points as far as they still look like save points (storage is the visitor's to edit), else null. */
export function sanitizeStored(raw: unknown): StoredSavePoints | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { instance?: unknown; points?: unknown };
  if (typeof r.instance !== "string" || !HASH.test(r.instance) || !Array.isArray(r.points)) return null;
  const instance = r.instance.toLowerCase() as Hex;
  const points: SavePoint[] = [];
  for (const p of r.points as unknown[]) {
    if (!p || typeof p !== "object") continue;
    const q = p as Record<string, unknown>;
    const b = q.block && typeof q.block === "object" ? block((q.block as Record<string, unknown>).number, (q.block as Record<string, unknown>).hash) : null;
    if (typeof q.id !== "string" || snapshotId(q.id) === null || q.instance !== instance || !b) continue;
    if (typeof q.below !== "number" || !Number.isSafeInteger(q.below) || q.below < 0 || typeof q.at !== "number" || !Number.isFinite(q.at)) continue;
    points.push({ id: q.id as Hex, instance, block: b, below: q.below, at: q.at });
  }
  // newest last, as they were taken
  points.sort((a, b) => (snapshotId(a.id)! < snapshotId(b.id)! ? -1 : 1));
  return { instance, points };
}

/** A JSON-RPC answer, as `send` returns it. */
export interface RpcAnswer {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Send calls to a chain as one JSON-RPC batch, answered in order. Never retried: a snapshot or revert must go once. */
export type Send = (url: string, calls: { method: string; params: unknown[] }[], timeoutMs?: number) => Promise<RpcAnswer[]>;

export const sendBatch: Send = async (url, calls, timeoutMs = 60_000) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }))),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    // The Playground's backend says why it refused (a stopped chain answers 410), which the app already reads.
    const why = body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string" ? (body as { error: string }).error : res.statusText;
    throw new Error(`${why} (HTTP ${res.status})`);
  }
  const list = (Array.isArray(body) ? body : [body]) as ({ id?: unknown } & RpcAnswer)[];
  return calls.map((_, i) => list.find((a) => a && a.id === i + 1) ?? { error: { code: -32603, message: "No answer from the chain" } });
};

/**
 * Whether an error answer means the chain does not offer the method: JSON-RPC's "method not found", which Anvil and a
 * Playground backend that predates `anvil_metadata` both answer. (Not a message match: Anvil's "Resource not found" is
 * a missing block.)
 */
export const notOffered = (e: RpcAnswer["error"]) => !!e && e.code === -32601;

/**
 * Run `fn` holding this origin's lock on the chain at `url`, so two tabs never take or check-and-revert snapshots on it
 * at the same moment. Where the browser has no lock manager (or outside one), it just runs.
 */
export async function withChainLock<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : (navigator as { locks?: { request(name: string, cb: () => Promise<T>): Promise<T> } }).locks;
  if (!locks || typeof locks.request !== "function") return fn();
  return locks.request(`covenant.snapshots ${url}`, fn);
}
