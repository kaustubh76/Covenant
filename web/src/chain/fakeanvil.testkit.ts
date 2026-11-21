// For tests: a small Anvil, as far as snapshots go, following revert_state_snapshot and StateSnapshots::remove (see
// snapguard.ts): a list that a revert takes only its own id off, saved states that a revert drops from its id on, and a
// head. `state` stands in for balances: every block mined adds one. `send` answers the JSON-RPC calls snapshots need, as
// Anvil would; with `proxied`, as the Playground's proxy in front of it does, refusing a revert to an id it does not hold.

import type { Hex } from "viem";
import type { BlockRef, ChainSnapshots, RpcAnswer, Send } from "./snapguard";

export const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const hex = (n: bigint | number) => `0x${n.toString(16)}` as Hex;

export type RevertOutcome = "full" | "used" | "never" | "half" | "wedged";

export class FakeAnvil {
  instance: Hex;
  private next = 0n;
  list = new Map<bigint, BlockRef>();
  saved = new Map<bigint, number>();
  blocks: Hex[] = [H(1)];
  head: BlockRef = { number: 0, hash: H(1) };
  state = 0;
  wedged = false;
  /** Every method asked for, in order. */
  calls: string[] = [];
  /** The ids the Playground's proxy holds, when it stands in front (null: called directly, as the local chain is). */
  held: Set<bigint> | null;
  private seq = 2;

  constructor(seed = 1, opts: { proxied?: boolean } = {}) {
    this.instance = H(1_000_000 + seed);
    this.held = opts.proxied ? new Set() : null;
  }

  mine(k = 1) {
    for (let i = 0; i < k; i++) {
      // every block gets a fresh hash, as Anvil's random prevrandao gives it
      this.blocks.push(H(this.seq++));
      this.state++;
    }
    this.head = { number: this.blocks.length - 1, hash: this.blocks[this.blocks.length - 1] };
  }

  snapshot(): Hex {
    const id = this.next++;
    this.list.set(id, { ...this.head });
    this.saved.set(id, this.state);
    this.held?.add(id);
    return hex(id);
  }

  /** What evm_revert does: "full" (true), "used" or "never" (false, nothing visible), "half" (false), "wedged" (an error). */
  revert(idHex: Hex): RevertOutcome {
    const id = BigInt(idHex);
    if (this.held) for (const k of [...this.held]) if (k >= id) this.held.delete(k);
    const entry = this.list.get(id);
    this.list.delete(id);
    if (entry) {
      if (this.blocks.length - 1 > entry.number) this.blocks.length = entry.number + 1;
      if (this.blocks[entry.number] !== entry.hash) {
        // the head now names a block that is not there, and the saved states are never reached
        this.head = { ...entry };
        this.wedged = true;
        return "wedged";
      }
      this.head = { ...entry };
    }
    const live = this.saved.get(id);
    for (const k of [...this.saved.keys()]) if (k >= id) this.saved.delete(k);
    if (live !== undefined) {
      this.state = live;
      return "full";
    }
    return entry ? "half" : id < this.next ? "used" : "never";
  }

  metadata(): ChainSnapshots {
    return { instance: this.instance, head: { ...this.head }, listed: new Map([...this.list].map(([k, v]) => [k, { ...v }])) };
  }

  hashAt(n: number): Hex | null {
    return this.blocks[n] ?? null;
  }

  /** One call, answered as Anvil (behind the proxy, when `proxied`) answers it. */
  answer(method: string, params: unknown[]): RpcAnswer {
    this.calls.push(method);
    switch (method) {
      case "anvil_metadata":
        return {
          result: {
            clientVersion: "anvil/v1.1.0",
            chainId: 31337,
            instanceId: this.instance,
            latestBlockNumber: this.head.number,
            latestBlockHash: this.head.hash,
            forkedNetwork: null,
            snapshots: Object.fromEntries([...this.list].map(([k, v]) => [hex(k), [v.number, v.hash]])),
          },
        };
      case "evm_snapshot":
        return { result: this.snapshot() };
      case "evm_revert": {
        const id = BigInt(params[0] as string);
        if (this.held && !this.held.has(id)) return { result: false }; // the proxy refuses it: Anvil never sees it
        const out = this.revert(params[0] as Hex);
        return out === "wedged" ? { error: { code: -32001, message: "Resource not found" } } : { result: out === "full" };
      }
      case "eth_getBlockByNumber": {
        const n = Number(BigInt(params[0] as string));
        const h = this.blocks[n];
        return { result: h ? { number: hex(n), hash: h } : null };
      }
      default:
        return { error: { code: -32601, message: `Method not found: ${method}` } };
    }
  }

  send: Send = async (_url, calls) => calls.map((c) => this.answer(c.method, c.params));
}

/** A sender for a chain that predates anvil_metadata (an older Playground backend): it is refused, the rest go on. */
export const notOfferedSend: Send = async (_url, calls) =>
  calls.map((c) => (c.method === "anvil_metadata" ? { error: { code: -32601, message: "anvil_metadata is not available on a Playground chain" } } : { error: { code: -32603, message: "unexpected" } }));
