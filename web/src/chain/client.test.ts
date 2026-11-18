import { HttpRequestError, RpcRequestError, custom } from "viem";
import { describe, expect, it } from "vitest";
import { pacer, patient, preferBackend } from "./client";

// The way viem's http transport reports a JSON-RPC error: an RpcRequestError carrying the endpoint's code.
const rpcError = (code: number, message: string) => new RpcRequestError({ body: {}, error: { code, message }, url: "https://sepolia.base.org" });

/** A transport that fails its first `failures` calls with `error`, then answers. */
function flaky(failures: number, error: Error) {
  let calls = 0;
  const transport = custom(
    {
      async request() {
        calls++;
        if (calls <= failures) throw error;
        return "0x14a34";
      },
    },
    { retryCount: 0 },
  );
  return { transport, calls: () => calls };
}

describe("patient transport", () => {
  it("retries Base Sepolia's rate-limit answer until the call goes through", async () => {
    const f = flaky(3, rpcError(-32007, "25/second request limit reached - reduce calls per second or use another RPC"));
    const t = patient(f.transport, 6, 1)({});
    await expect(t.request({ method: "eth_chainId" })).resolves.toBe("0x14a34");
    expect(f.calls()).toBe(4);
  });

  it("keeps backing off on HTTP 429 after viem's own quick retries", async () => {
    const f = flaky(2, new HttpRequestError({ url: "https://sepolia.base.org", status: 429, details: "Too Many Requests" }));
    const t = patient(f.transport, 6, 1)({});
    await expect(t.request({ method: "eth_chainId" })).resolves.toBe("0x14a34");
    expect(f.calls()).toBe(3);
  });

  it("gives up after its tries, with the endpoint's error", async () => {
    const f = flaky(10, rpcError(-32007, "25/second request limit reached"));
    const t = patient(f.transport, 3, 1)({});
    await expect(t.request({ method: "eth_chainId" })).rejects.toThrow(/request limit reached/);
    expect(f.calls()).toBe(3);
  });

  it("passes any other error straight through, untried", async () => {
    const f = flaky(1, rpcError(3, "execution reverted"));
    const t = patient(f.transport, 6, 1)({});
    await expect(t.request({ method: "eth_call" })).rejects.toThrow(/execution reverted/);
    expect(f.calls()).toBe(1);
  });
});

describe("pacer", () => {
  it("lets the burst through at once, then one every 1/perSecond seconds, in order", async () => {
    const turn = pacer(20, 4);
    const t0 = Date.now();
    const done: number[] = [];
    await Promise.all(Array.from({ length: 14 }, (_, i) => turn().then(() => done.push(i))));
    expect(done).toEqual(Array.from({ length: 14 }, (_, i) => i));
    // 4 at once, then 10 more at 20 a second: about half a second.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("never lets more than burst + perSecond through in any one second", async () => {
    const turn = pacer(12, 4);
    const at: number[] = [];
    await Promise.all(Array.from({ length: 30 }, () => turn().then(() => at.push(Date.now()))));
    for (const t of at) expect(at.filter((u) => u >= t && u < t + 1000).length).toBeLessThanOrEqual(16 + 1);
  });
});

describe("preferBackend", () => {
  /** A transport that always answers `value`, counting its calls. */
  const answers = (value: string) => {
    let calls = 0;
    const transport = custom({ async request() { calls++; return value; } }, { retryCount: 0 });
    return { transport, calls: () => calls };
  };
  /** A transport that always fails with `error`, counting its calls. */
  const failing = (error: Error) => {
    let calls = 0;
    const transport = custom({ async request() { calls++; throw error; } }, { retryCount: 0 });
    return { transport, calls: () => calls };
  };

  it("reads through the backend while it answers", async () => {
    const b = answers("0xb");
    const d = answers("0xd");
    await expect(preferBackend(b.transport, d.transport)({}).request({ method: "eth_getLogs", params: [{}] })).resolves.toBe("0xb");
    expect(d.calls()).toBe(0);
  });

  it("keeps reads of the head direct: each browser has its own budget at the public endpoint", async () => {
    const b = answers("0xb");
    const d = answers("0xd");
    const t = preferBackend(b.transport, d.transport)({});
    for (const method of ["eth_call", "eth_blockNumber", "eth_getBalance", "eth_simulateV1"]) await expect(t.request({ method })).resolves.toBe("0xd");
    await expect(t.request({ method: "eth_getBlockByNumber", params: ["latest", false] })).resolves.toBe("0xd");
    await expect(t.request({ method: "eth_getBlockByNumber", params: ["0x10", false] })).resolves.toBe("0xb");
    expect(b.calls()).toBe(1);
  });

  it("goes direct when the backend gives no answer, and stays direct for a while before trying it again", async () => {
    let now = 0;
    const b = failing(new HttpRequestError({ url: "https://backend.example/rpc/base-sepolia", status: 503 }));
    const d = answers("0xd");
    const t = preferBackend(b.transport, d.transport, 30_000, () => now)({});
    await expect(t.request({ method: "eth_getLogs", params: [{}] })).resolves.toBe("0xd");
    await expect(t.request({ method: "eth_getLogs", params: [{}] })).resolves.toBe("0xd");
    expect(b.calls()).toBe(1);
    now = 31_000;
    await t.request({ method: "eth_getLogs", params: [{}] });
    expect(b.calls()).toBe(2);
  });

  it("goes direct for a method the backend does not serve, and when it is rate-limited", async () => {
    for (const e of [rpcError(-32601, "eth_getLogs is not served here"), rpcError(-32007, "request limit reached")]) {
      const d = answers("0xd");
      await expect(preferBackend(failing(e).transport, d.transport)({}).request({ method: "eth_getLogs", params: [{}] })).resolves.toBe("0xd");
    }
  });

  it("passes the chain's own answer through: an error from the node is not a reason to ask elsewhere", async () => {
    const d = answers("0xd");
    await expect(preferBackend(failing(rpcError(-32000, "query returned more than 10000 results")).transport, d.transport)({}).request({ method: "eth_getLogs", params: [{}] })).rejects.toThrow(/more than/);
    expect(d.calls()).toBe(0);
  });
});
