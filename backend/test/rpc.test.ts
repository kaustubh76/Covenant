import { describe, expect, it } from "vitest";
import { ALLOWED_METHODS, MAX_MINE_PER_CALL, type Meter, blocksOf, hold, screen, track } from "../src/playground/rpc";

describe("the Playground's JSON-RPC allowlist", () => {
  it("passes what the app uses", () => {
    for (const m of ["eth_call", "eth_sendRawTransaction", "eth_fillTransaction", "eth_getLogs", "eth_simulateV1", "evm_snapshot", "evm_revert", "anvil_mine", "evm_setAutomine", "anvil_setBalance"]) {
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

  it("tracks the snapshots held: each new id, and a revert gives back its own and every later one", () => {
    const meter: Meter = { usage: { held: [] }, limits: { height: 10, snapshots: 9 }, height: async () => 0 };
    for (const id of ["0x1", "0x2", "0x3", "0x4"]) track(meter, { method: "evm_snapshot" }, { jsonrpc: "2.0", id: 1, result: id });
    expect(meter.usage.held).toEqual([1n, 2n, 3n, 4n]);
    track(meter, { method: "evm_revert", params: ["0x3"] }, { jsonrpc: "2.0", id: 1, result: true });
    expect(meter.usage.held).toEqual([1n, 2n]);
    // a revert the chain refused gives nothing back
    track(meter, { method: "evm_revert", params: ["0x1"] }, { jsonrpc: "2.0", id: 1, result: false });
    expect(meter.usage.held).toEqual([1n, 2n]);
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
