import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALLOWED_METHODS, MAX_MINE_PER_CALL, type Meter, blocksOf, hold, pieces, proxy, screen, snapshotId, track } from "../src/playground/rpc";

describe("the Playground's JSON-RPC allowlist", () => {
  it("passes what the app uses", () => {
    for (const m of ["eth_call", "eth_sendRawTransaction", "eth_fillTransaction", "eth_getLogs", "eth_simulateV1", "evm_snapshot", "evm_revert", "anvil_mine", "evm_setAutomine", "anvil_setBalance", "anvil_metadata"]) {
      expect(ALLOWED_METHODS.has(m), m).toBe(true);
    }
  });

  it("refuses what reaches the host or edits the chain behind the app's back", () => {
    for (const m of ["anvil_reset", "anvil_setRpcUrl", "anvil_loadState", "anvil_dumpState", "anvil_impersonateAccount", "anvil_setCode", "anvil_setStorageAt", "debug_traceTransaction", "eth_sendTransaction", "admin_peers"]) {
      expect(ALLOWED_METHODS.has(m), m).toBe(false);
    }
  });

  it("answers a refused call in place and forwards the rest", () => {
    const { batch, forward, refused, size } = screen(
      JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_chainId" },
        { jsonrpc: "2.0", id: 2, method: "anvil_reset", params: [{ forking: { jsonRpcUrl: "http://169.254.169.254" } }] },
        { jsonrpc: "2.0", id: 3, method: "eth_blockNumber" },
      ]),
    );
    expect(batch).toBe(true);
    expect(size).toBe(3);
    expect(forward.map((f) => f.method)).toEqual(["eth_chainId", "eth_blockNumber"]);
    expect(refused.get(1)?.error?.code).toBe(-32601);
    expect(refused.get(1)?.id).toBe(2);
  });

  it("rejects bodies that are not JSON-RPC", () => {
    expect(() => screen("not json")).toThrow(/not JSON/);
    expect(() => screen("[]")).toThrow(/batch/);
    expect(screen(JSON.stringify({ id: 9 })).refused.get(0)?.error?.code).toBe(-32600);
  });

  it("refuses a mine past the per-call cap, and a count it cannot read, before it reaches Anvil", () => {
    const call = (method: string, params: unknown[]) => screen(JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }));
    expect(call("anvil_mine", [`0x${MAX_MINE_PER_CALL.toString(16)}`]).forward).toHaveLength(1);
    const over = call("anvil_mine", [`0x${(MAX_MINE_PER_CALL + 1).toString(16)}`]);
    expect(over.forward).toHaveLength(0);
    expect(over.refused.get(0)?.error?.code).toBe(-32602);
    expect(over.refused.get(0)?.error?.message).toMatch(/more than a Playground chain allows/);
    expect(call("anvil_mine", ["0x3b9aca00"]).refused.get(0)?.error?.message).toMatch(/1000000000 blocks/);
    expect(call("anvil_mine", [`0x${"f".repeat(64)}`]).forward).toHaveLength(0);
    expect(call("anvil_mine", ["lots"]).refused.get(0)?.error?.message).toMatch(/not a number/);
    expect(call("anvil_mine", [-5]).forward).toHaveLength(0);
    expect(call("evm_mine", [{ blocks: MAX_MINE_PER_CALL + 1 }]).forward).toHaveLength(0);
    // the plain forms the app sends: one block, or a count well under the cap
    expect(call("evm_mine", []).forward).toHaveLength(1);
    expect(call("anvil_mine", []).forward).toHaveLength(1);
    expect(call("anvil_mine", [250]).forward).toHaveLength(1);
  });

  it("counts what each call mines", () => {
    expect(blocksOf("anvil_mine", ["0x64"])).toBe(100);
    expect(blocksOf("anvil_mine", [])).toBe(1);
    expect(blocksOf("evm_mine", [1_800_000_000])).toBe(1);
    expect(blocksOf("evm_mine", [{ blocks: 12 }])).toBe(12);
    expect(blocksOf("eth_sendRawTransaction", ["0x02"])).toBe(1);
    expect(blocksOf("eth_call", [])).toBe(0);
    expect(blocksOf("anvil_mine", [{}])).toBeNull();
  });

  it("holds a chain to its height above the seed and the snapshots it may hold, in order, refusing only what goes past", async () => {
    let height = 1_200;
    const meter: Meter = { usage: { held: [1n, 2n] }, limits: { height: 1_500, snapshots: 3 }, height: async () => height };
    const screened = (calls: { method: string; params?: unknown[] }[]) => screen(JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, ...c }))));
    const s1 = screened([{ method: "anvil_mine", params: [250] }, { method: "eth_blockNumber" }, { method: "eth_sendRawTransaction", params: ["0x02"] }, { method: "anvil_mine", params: [100] }]);
    await hold(s1.forward, s1.refused, s1.size, meter);
    // 1,200 + 250 + 1 fit under 1,500; the next 100 would not
    expect(s1.forward.map((f) => f.method)).toEqual(["anvil_mine", "eth_blockNumber", "eth_sendRawTransaction"]);
    expect(s1.refused.get(3)?.error?.code).toBe(-32000);
    expect(s1.refused.get(3)?.error?.message).toMatch(/1500 blocks past its seed.*Reset it/);
    // a revert lowers the height, and the same mine goes through
    height = 100;
    const s2 = screened([{ method: "anvil_mine", params: [100] }]);
    await hold(s2.forward, s2.refused, s2.size, meter);
    expect(s2.forward).toHaveLength(1);
    // one more snapshot fits beside the two held; a second does not
    const s3 = screened([{ method: "evm_snapshot" }, { method: "evm_snapshot" }]);
    await hold(s3.forward, s3.refused, s3.size, meter);
    expect(s3.forward).toHaveLength(1);
    expect(s3.refused.get(1)?.error?.message).toMatch(/holds 3 snapshots and save points/);
  });

  it("asks the chain its height only when a call mines", async () => {
    let asked = 0;
    const meter: Meter = { usage: { held: [] }, limits: { height: 10, snapshots: 2 }, height: async () => (asked++, 0) };
    const s = screen(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{}, "latest"] }, { jsonrpc: "2.0", id: 2, method: "evm_snapshot" }]));
    await hold(s.forward, s.refused, s.size, meter);
    expect(asked).toBe(0);
    expect(s.forward).toHaveLength(2);
  });

  it("tracks the snapshots held: each new id, and a revert, whatever its answer, gives back its own and every later one", () => {
    const meter: Meter = { usage: { held: [] }, limits: { height: 10, snapshots: 9 }, height: async () => 0 };
    for (const id of ["0x1", "0x2", "0x3", "0x4", "0x5"]) track(meter, { method: "evm_snapshot" }, { jsonrpc: "2.0", id: 1, result: id });
    expect(meter.usage.held).toEqual([1n, 2n, 3n, 4n, 5n]);
    track(meter, { method: "evm_revert", params: ["0x4"] }, { jsonrpc: "2.0", id: 1, result: true });
    expect(meter.usage.held).toEqual([1n, 2n, 3n]);
    // Anvil drops every later snapshot even when it answers false, and an error leaves the revert's outcome unknown
    track(meter, { method: "evm_revert", params: ["0x3"] }, { jsonrpc: "2.0", id: 1, result: false });
    expect(meter.usage.held).toEqual([1n, 2n]);
    track(meter, { method: "evm_revert", params: ["0x2"] }, { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Resource not found" } });
    expect(meter.usage.held).toEqual([1n]);
    // a snapshot that failed adds nothing
    track(meter, { method: "evm_snapshot" }, { jsonrpc: "2.0", id: 1, error: { code: -32603, message: "no" } });
    expect(meter.usage.held).toEqual([1n]);
  });

  it("reads a snapshot id only in the forms Anvil reads the same way", () => {
    expect(snapshotId("0x1f")).toBe(31n);
    expect(snapshotId("0X0")).toBe(0n);
    expect(snapshotId(7)).toBe(7n);
    for (const v of ["", "0x", "12", "0b1", " 0x1", "0x1 ", -1, 1.5, null, undefined, {}, [1], `0x${"f".repeat(65)}`]) expect(snapshotId(v), JSON.stringify(v)).toBeNull();
  });

  it("splits a batch so each snapshot or revert goes alone, in order, and the calls between them together", () => {
    const m = (...ms: string[]) => ms.map((method, i) => ({ id: i, method }));
    const names = (ps: { method?: unknown }[][]) => ps.map((p) => p.map((r) => r.method).join(","));
    expect(names(pieces(m("eth_call", "eth_blockNumber")))).toEqual(["eth_call,eth_blockNumber"]);
    // the app's save point: the chain's snapshots read before and after the one taken
    expect(names(pieces(m("anvil_metadata", "evm_snapshot", "anvil_metadata")))).toEqual(["anvil_metadata", "evm_snapshot", "anvil_metadata"]);
    expect(names(pieces(m("eth_call", "eth_chainId", "evm_snapshot", "eth_getBalance", "evm_revert", "evm_snapshot", "eth_call")))).toEqual(["eth_call,eth_chainId", "evm_snapshot", "eth_getBalance", "evm_revert", "evm_snapshot", "eth_call"]);
  });

  it("stops a chain growing once its memory is past the limit, and lets reads and reverts through", async () => {
    let mb: number | null = 120;
    const told: string[] = [];
    const meter: Meter = { usage: { held: [] }, limits: { height: 3_000, snapshots: 32, memoryMb: 100 }, height: async () => 10, memoryMb: () => mb, onRefuse: (w) => void told.push(w) };
    const s1 = screen(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x02"] }, { jsonrpc: "2.0", id: 2, method: "evm_snapshot" }, { jsonrpc: "2.0", id: 3, method: "evm_revert", params: ["0x1"] }, { jsonrpc: "2.0", id: 4, method: "eth_call", params: [{}, "latest"] }]));
    await hold(s1.forward, s1.refused, s1.size, meter);
    expect(s1.forward.map((f) => f.method)).toEqual(["evm_revert", "eth_call"]);
    expect(s1.refused.get(0)?.error?.message).toMatch(/^This Playground chain has used the memory one chain may \(100 MB\)\. Reset it to start again/);
    expect(told).toEqual(["eth_sendRawTransaction: memory 120 MB, past 100", "evm_snapshot: memory 120 MB, past 100"]);
    expect(s1.refused.get(1)?.error?.code).toBe(-32000);
    // where memory cannot be read (macOS), the guard stands aside
    mb = null;
    const s2 = screen(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x02"] }));
    await hold(s2.forward, s2.refused, s2.size, meter);
    expect(s2.forward).toHaveLength(1);
  });
});

/**
 * A stand-in Anvil that keeps snapshots the way Anvil's state store does: ids count up, a revert consumes its own and
 * drops every later one (answering false, and still dropping the later ones, when it does not have the id).
 */
function standIn() {
  const got: { method: string; params: unknown[] }[][] = [];
  let next = 0n;
  let store: bigint[] = [];
  let gate: Promise<void> = Promise.resolve();
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      const calls = JSON.parse(body) as { id: unknown; method: string; params: unknown[] }[];
      got.push(calls.map(({ method, params }) => ({ method, params })));
      await gate;
      const replies = calls.map((c) => {
        if (c.method === "evm_snapshot") {
          store.push(next);
          return { jsonrpc: "2.0", id: c.id, result: `0x${(next++).toString(16)}` };
        }
        if (c.method === "evm_revert") {
          const id = BigInt(c.params[0] as string);
          const had = store.includes(id);
          store = store.filter((s) => s < id);
          return { jsonrpc: "2.0", id: c.id, result: had };
        }
        return { jsonrpc: "2.0", id: c.id, result: "0x1" };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(replies));
    });
  });
  return {
    server,
    got,
    store: () => store,
    /** Hold every answer until the returned function is called. */
    pause: () => {
      let open!: () => void;
      gate = new Promise<void>((r) => (open = r));
      return () => open();
    },
  };
}

describe("the Playground's snapshots, through the proxy", () => {
  const anvil = standIn();
  let url = "";
  beforeAll(() => new Promise<void>((r) => anvil.server.listen(0, "127.0.0.1", () => ((url = `http://127.0.0.1:${(anvil.server.address() as AddressInfo).port}`), r()))));
  afterAll(() => new Promise<void>((r) => anvil.server.close(() => r())));

  const told: string[] = [];
  let turn: Promise<unknown> = Promise.resolve();
  const meter: Meter = {
    usage: { held: [] },
    limits: { height: 3_000, snapshots: 32 },
    height: async () => 0,
    onRefuse: (w) => void told.push(w),
    exclusive: <T>(job: () => Promise<T>) => {
      const next = turn.then(job);
      turn = next.catch(() => undefined);
      return next;
    },
  };
  const rpc = (calls: { method: string; params?: unknown[] }[]) => proxy(url, JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, ...c })))) as Promise<{ result?: unknown }[]>;
  const via = (calls: { method: string; params?: unknown[] }[]) => proxy(() => url, JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, ...c }))), 5_000, meter) as Promise<{ result?: unknown; error?: unknown }[]>;
  const sent = () => anvil.got.flat().map((c) => `${c.method}${c.method === "evm_revert" ? `(${c.params[0]})` : ""}`);

  it("answers false, and sends nothing, for a revert to a snapshot the chain no longer holds", async () => {
    // the backend's own baseline, taken outside the proxy, as a chain's start and a reset take it
    const [{ result: baseline }] = await rpc([{ method: "evm_snapshot" }]);
    anvil.got.length = 0;
    const [{ result: s1 }] = await via([{ method: "evm_snapshot" }]);
    const [{ result: s2 }] = await via([{ method: "evm_snapshot" }]);
    expect(meter.usage.held).toEqual([1n, 2n]);
    expect((await via([{ method: "evm_revert", params: [s1] }]))[0].result).toBe(true);
    // S2 went with S1: Anvil would take the blocks back to S2's and leave the state as it is
    expect(meter.usage.held).toEqual([]);
    const [stale] = await via([{ method: "evm_revert", params: [s2] }]);
    expect(stale.result).toBe(false);
    // so would a second revert to S1, and a visitor's revert to the baseline
    expect((await via([{ method: "evm_revert", params: [s1] }]))[0].result).toBe(false);
    expect((await via([{ method: "evm_revert", params: [baseline] }]))[0].result).toBe(false);
    expect((await via([{ method: "evm_revert", params: ["7"] }]))[0].result).toBe(false);
    expect(sent()).toEqual(["evm_snapshot", "evm_snapshot", `evm_revert(${s1})`]);
    expect(told).toEqual([`evm_revert(${s2}): not a snapshot this chain holds`, `evm_revert(${s1}): not a snapshot this chain holds`, `evm_revert(${baseline}): not a snapshot this chain holds`, "evm_revert(7): not a snapshot this chain holds"]);
    // the baseline is still there for a reset
    expect(anvil.store()).toEqual([0n]);
  });

  it("sends a batch's snapshots and reverts in its order, one piece at a time", async () => {
    anvil.got.length = 0;
    const [{ result: s }] = await via([{ method: "evm_snapshot" }]);
    // a revert to the snapshot just taken, and a new one, batched with reads as the app's transport batches them
    const out = await via([{ method: "eth_blockNumber" }, { method: "evm_revert", params: [s] }, { method: "eth_call", params: [] }, { method: "evm_snapshot" }]);
    expect(out.map((r) => r.result)).toEqual(["0x1", true, "0x1", "0x4"]);
    expect(anvil.got.map((b) => b.map((c) => c.method).join(","))).toEqual(["evm_snapshot", "eth_blockNumber", "evm_revert", "eth_call", "evm_snapshot"]);
    expect(meter.usage.held).toEqual([4n]);
    // a snapshot and a revert to it in one batch: the revert waits for the snapshot's id, then goes
    const both = await via([{ method: "evm_snapshot" }, { method: "evm_revert", params: ["0x5"] }]);
    expect(both.map((r) => r.result)).toEqual(["0x5", true]);
    expect(meter.usage.held).toEqual([4n]);
  });

  it("runs one request's snapshot and the next one's revert in the order they came, even when the chain is slow", async () => {
    const open = anvil.pause();
    const first = via([{ method: "evm_snapshot" }]);
    const second = via([{ method: "evm_revert", params: ["0x6"] }]);
    await new Promise((r) => setTimeout(r, 50));
    open();
    expect((await first)[0].result).toBe("0x6");
    // without the turn, the revert would have been checked before 0x6 was held, and answered false
    expect((await second)[0].result).toBe(true);
    expect(meter.usage.held).toEqual([4n]);
  });

  it("gives a revert's snapshots back when the chain does not answer, since it may have run", async () => {
    const dead: Meter = { usage: { held: [1n, 2n, 3n] }, limits: { height: 3_000, snapshots: 32 }, height: async () => 0 };
    await expect(proxy("http://127.0.0.1:9", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "evm_revert", params: ["0x2"] }), 2_000, dead)).rejects.toThrow();
    expect(dead.usage.held).toEqual([1n]);
  });
});
