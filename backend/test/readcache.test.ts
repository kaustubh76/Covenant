import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FOREVER, HEAD_MS, ResultCache, ttl } from "../src/readcache/cache";
import { BaseSepoliaReader } from "../src/readcache/proxy";

describe("how long a read is kept", () => {
  it("keeps what cannot change, and shares reads of the head briefly", () => {
    expect(ttl("eth_chainId", [], "0x14a34", null)).toBe(FOREVER);
    expect(ttl("eth_getTransactionReceipt", ["0xabc"], { status: "0x1" }, 100)).toBe(FOREVER);
    expect(ttl("eth_getTransactionReceipt", ["0xabc"], null, 100)).toBe(500);
    expect(ttl("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x10" }], [], 1_000)).toBe(FOREVER);
    expect(ttl("eth_getLogs", [{ fromBlock: "0x3e0", toBlock: "0x3e8" }], [], 1_000)).toBe(HEAD_MS);
    expect(ttl("eth_call", [{ to: "0x1", data: "0x" }, "latest"], "0x", 1_000)).toBe(HEAD_MS);
    expect(ttl("eth_call", [{ to: "0x1", data: "0x" }, "0x10"], "0x", 1_000)).toBe(FOREVER);
    expect(ttl("eth_blockNumber", [], "0x10", null)).toBe(1_000);
  });

  it("expires entries and evicts the least recently used", () => {
    let now = 0;
    const c = new ResultCache(2, () => now);
    c.set("a", 1, 100);
    c.set("b", 2, 100);
    c.get("a");
    c.set("c", 3, 100); // b was used least recently
    expect(c.get("b")).toBeNull();
    expect(c.get("a")?.value).toBe(1);
    now = 150;
    expect(c.get("a")).toBeNull();
  });
});

describe("the Base Sepolia reader", () => {
  let upstream: Server;
  let url = "";
  const seen: string[] = [];
  let throttleNext = 0;
  const read = (req: IncomingMessage) => new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

  beforeAll(async () => {
    upstream = createServer(async (req, res) => {
      const calls = JSON.parse(await read(req)) as { id: number; method: string }[];
      for (const c of calls) seen.push(c.method);
      if (throttleNext > 0) {
        throttleNext--;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32007, message: "request limit reached" } }))));
        return;
      }
      // Slow enough that identical calls overlap.
      await new Promise((r) => setTimeout(r, 50));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, result: c.method === "eth_blockNumber" ? "0x64" : "0xabc" }))));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

  const call = (method: string, params: unknown[] = [], id: unknown = 1) => ({ jsonrpc: "2.0", id, method, params });

  it("refuses writes and anything it does not read", async () => {
    const reader = new BaseSepoliaReader({ upstream: url, rate: 1_000, maxWaitMs: 1_000 });
    const { reply } = await reader.handle(JSON.stringify([call("eth_sendRawTransaction", ["0x00"]), call("anvil_setBalance", [])]));
    expect((reply as { error: { code: number } }[]).map((r) => r.error.code)).toEqual([-32601, -32601]);
    expect(seen).not.toContain("eth_sendRawTransaction");
  });

  it("merges identical calls in flight and serves repeats from the cache", async () => {
    const reader = new BaseSepoliaReader({ upstream: url, rate: 1_000, maxWaitMs: 1_000 });
    const before = seen.length;
    const q = JSON.stringify(call("eth_call", [{ to: "0x1", data: "0x01" }, "latest"], 7));
    const [a, b] = await Promise.all([reader.handle(q), reader.handle(q)]);
    expect(seen.length - before).toBe(1);
    expect((a.reply as { id: number }).id).toBe(7);
    expect((b.reply as { result: string }).result).toBe("0xabc");
    const again = await reader.handle(q);
    expect(again.cache).toBe("hit");
    expect(seen.length - before).toBe(1);
    const mixed = await reader.handle(JSON.stringify([call("eth_call", [{ to: "0x1", data: "0x01" }, "latest"], 1), call("eth_getBalance", ["0x2", "latest"], 2)]));
    expect(mixed.cache).toBe("mixed");
  });

  it("retries when the upstream says slow down", async () => {
    const reader = new BaseSepoliaReader({ upstream: url, rate: 1_000, maxWaitMs: 1_000 });
    throttleNext = 1;
    const { reply } = await reader.handle(JSON.stringify(call("eth_gasPrice")));
    expect((reply as { result: string }).result).toBe("0xabc");
    expect(reader.stats.throttled).toBe(1);
  });

  it("tells the caller to go direct rather than queue for long", async () => {
    const reader = new BaseSepoliaReader({ upstream: url, rate: 1, maxWaitMs: 500 });
    await reader.handle(JSON.stringify(call("eth_getBalance", ["0x3", "latest"])));
    // One call a second: the next would wait about a second, longer than allowed, so it is refused for the app to go direct.
    await expect(reader.handle(JSON.stringify(call("eth_getBalance", ["0x4", "latest"])))).rejects.toMatchObject({ status: 429 });
  });
});
