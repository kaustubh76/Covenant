// The Base Sepolia reader: a read-only JSON-RPC proxy in front of the public endpoint, shared by every visitor.
//
// Every visitor's browser used to call sepolia.base.org itself, each within its own 25 calls a second. Through here they
// share one upstream, so it caches what it can (cache.ts), merges identical calls in flight, and paces what reaches the
// upstream to a fixed rate whatever the number of visitors. Writes are refused: wallets send through their own RPC.

import { HttpError } from "../http";
import { READ_METHODS, ResultCache, ttl } from "./cache";

interface Request {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}
interface Reply {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ReaderOptions {
  upstream: string;
  /** Upstream calls a second, across all visitors. */
  rate: number;
  /** How long a call may wait for its turn before the caller is told to go direct. */
  maxWaitMs: number;
  now?: () => number;
}

const refuse = (id: unknown, code: number, message: string): Reply => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The upstream's "slow down" answers, retried after a pause. */
const throttled = (r: Reply) => r.error?.code === -32007 || r.error?.code === -32005 || /rate limit|too many/i.test(r.error?.message ?? "");

export class BaseSepoliaReader {
  private readonly o: ReaderOptions;
  private readonly cache = new ResultCache();
  private readonly inflight = new Map<string, Promise<Reply>>();
  private head: number | null = null;
  /** The next moment a call may go upstream: calls are spaced 1/rate apart. */
  private nextSlot = 0;
  stats = { calls: 0, hits: 0, merged: 0, upstream: 0, throttled: 0 };

  constructor(o: ReaderOptions) {
    this.o = o;
  }
  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Wait for an upstream slot, or refuse if the queue is longer than maxWaitMs. */
  private async slot(): Promise<void> {
    const t = this.now();
    const at = Math.max(t, this.nextSlot);
    if (at - t > this.o.maxWaitMs) throw new HttpError(429, "The reader is busy; call the network directly.", { "retry-after": "2" });
    this.nextSlot = at + 1000 / this.o.rate;
    if (at > t) await sleep(at - t);
  }

  private async upstream(calls: Request[]): Promise<Reply[]> {
    for (let attempt = 0; ; attempt++) {
      for (let i = 0; i < calls.length; i++) await this.slot();
      this.stats.upstream += calls.length;
      const res = await fetch(this.o.upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params ?? [] }))),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 && attempt < 3) {
        this.stats.throttled++;
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new HttpError(502, `Base Sepolia's RPC answered ${res.status}.`);
      const body = (await res.json()) as Reply | Reply[];
      const replies = Array.isArray(body) ? body : [body];
      const byId = new Map(replies.map((r) => [Number(r.id), r]));
      const out = calls.map((c, i) => byId.get(i) ?? refuse(c.id, -32603, "No answer from Base Sepolia"));
      if (out.some(throttled) && attempt < 3) {
        this.stats.throttled++;
        await sleep(500 * (attempt + 1));
        continue;
      }
      return out;
    }
  }

  /** One call: from the cache, merged with the same call in flight, or upstream. */
  private one(r: Request): Promise<Reply> {
    const method = r.method as string;
    const params = Array.isArray(r.params) ? r.params : [];
    const key = ResultCache.key(method, params);
    const hit = this.cache.get(key);
    if (hit) {
      this.stats.hits++;
      return Promise.resolve({ jsonrpc: "2.0", id: r.id ?? null, result: hit.value });
    }
    const flying = this.inflight.get(key);
    if (flying) {
      this.stats.merged++;
      return flying.then((x) => ({ ...x, id: r.id ?? null }));
    }
    const p = this.upstream([{ method, params }])
      .then(([reply]) => {
        if (reply.result !== undefined) {
          if (method === "eth_blockNumber" && typeof reply.result === "string") this.head = parseInt(reply.result, 16);
          this.cache.set(key, reply.result, ttl(method, params, reply.result, this.head));
        }
        return reply;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p.then((x) => ({ ...x, id: r.id ?? null }));
  }

  /** Answer a request body: every allowed call, each from the cache or upstream; writes and the rest refused. */
  async handle(body: string): Promise<{ reply: unknown; cache: "hit" | "miss" | "mixed" }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new HttpError(400, "The body is not JSON.");
    }
    const batch = Array.isArray(parsed);
    const items = (batch ? parsed : [parsed]) as Request[];
    if (items.length === 0 || items.length > 100) throw new HttpError(400, "A batch holds 1 to 100 calls.");
    this.stats.calls += items.length;
    const before = this.stats.hits + this.stats.merged;
    const replies = await Promise.all(
      items.map((r) => {
        if (!r || typeof r !== "object" || typeof r.method !== "string") return refuse(r?.id, -32600, "Invalid request");
        if (!READ_METHODS.has(r.method)) return refuse(r.id, -32601, `${r.method} is not served here: this reader only reads. Send transactions through your wallet.`);
        return this.one(r);
      }),
    );
    const served = this.stats.hits + this.stats.merged - before;
    return { reply: batch ? replies : replies[0], cache: served === items.length ? "hit" : served === 0 ? "miss" : "mixed" };
  }
}
