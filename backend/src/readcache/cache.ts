// How long a Base Sepolia read may be served again, by what it asks. Results that cannot change (a mined receipt, code
// or logs at a settled block) are kept for long; reads of the chain's head are shared for a moment, which is what lets
// every visitor polling the same vault cost the upstream RPC one call instead of one each.

export const FOREVER = 30 * 60_000;
/** Reads of the head: shared this long, so visitors polling every two seconds mostly hit. */
export const HEAD_MS = 1_500;
/** Blocks behind the head after which logs and blocks count as settled. */
export const SETTLED = 20;

export const READ_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId", "net_version", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getBalance",
  "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount", "eth_call", "eth_estimateGas", "eth_gasPrice",
  "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs",
  "eth_simulateV1", "eth_createAccessList", "eth_blobBaseFee",
]);

const isNumber = (tag: unknown): boolean => typeof tag === "string" && /^0x[0-9a-f]+$/i.test(tag);
const blockOf = (tag: unknown): number | null => (isNumber(tag) ? parseInt(tag as string, 16) : null);

/** Milliseconds `result` of `method(params)` may be served again, given the head block the cache knows (or null). */
export function ttl(method: string, params: unknown[], result: unknown, head: number | null): number {
  switch (method) {
    case "eth_chainId":
    case "net_version":
      return FOREVER;
    case "eth_getTransactionReceipt":
    case "eth_getTransactionByHash":
    case "eth_getBlockByHash":
      // Mined is final here; not found yet may change any moment.
      return result ? FOREVER : 500;
    case "eth_getBlockByNumber": {
      const n = blockOf(params[0]);
      return n !== null && head !== null && n <= head - SETTLED ? FOREVER : HEAD_MS;
    }
    case "eth_getLogs": {
      const f = (params[0] ?? {}) as { toBlock?: unknown; blockHash?: unknown };
      if (f.blockHash) return FOREVER;
      const to = blockOf(f.toBlock);
      return to !== null && head !== null && to <= head - SETTLED ? FOREVER : HEAD_MS;
    }
    case "eth_call":
    case "eth_getBalance":
    case "eth_getCode":
    case "eth_getStorageAt":
    case "eth_getTransactionCount": {
      const tag = params[params.length - 1];
      const n = blockOf(tag);
      return n !== null && head !== null && n <= head - SETTLED ? FOREVER : HEAD_MS;
    }
    default:
      // The head, gas prices, simulations, estimates: shared briefly, which also merges identical calls in flight.
      return method === "eth_blockNumber" ? 1_000 : HEAD_MS;
  }
}

interface Entry {
  at: number;
  ttl: number;
  value: unknown;
}

/** A small LRU of JSON-RPC results, keyed by method and parameters. */
export class ResultCache {
  private readonly max: number;
  private readonly now: () => number;
  private readonly map = new Map<string, Entry>();
  constructor(max = 5_000, now: () => number = Date.now) {
    this.max = max;
    this.now = now;
  }
  static key(method: string, params: unknown): string {
    return `${method}:${JSON.stringify(params ?? [])}`;
  }
  get(key: string): { value: unknown } | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (this.now() - e.at > e.ttl) {
      this.map.delete(key);
      return null;
    }
    // Most recently used goes last.
    this.map.delete(key);
    this.map.set(key, e);
    return { value: e.value };
  }
  set(key: string, value: unknown, ttl: number): void {
    if (ttl <= 0) return;
    this.map.delete(key);
    this.map.set(key, { at: this.now(), ttl, value });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size(): number {
    return this.map.size;
  }
}
