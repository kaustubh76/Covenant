import { describe, expect, it } from "vitest";
import { ALLOWED_METHODS, screen } from "../src/playground/rpc";

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
});
