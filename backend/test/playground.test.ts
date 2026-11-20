// The server end to end, with real Anvil chains loaded from the committed seed.

import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { createBackend } from "../src/server";

const hasAnvil = (() => {
  try {
    execFileSync("anvil", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasAnvil)("Playground chains", () => {
  const backend = createBackend({ ...loadConfig(), port: 0, host: "127.0.0.1", maxChains: 2, chainsPerIp: 2, evictAfterMs: 60_000 }, () => {});
  let base = "";
  const post = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const call = async (rpcPath: string, method: string, params: unknown[] = []) => (await post(rpcPath, { jsonrpc: "2.0", id: 1, method, params })).body;
  // An address may open six chains a minute, which the tests above use up; the stale-revert test reuses the reset test's.
  let reused: { id: string; rpcPath: string } | undefined;

  beforeAll(async () => {
    await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(backend.server.address() as AddressInfo).port}`;
  });
  afterAll(() => backend.close());

  it("opens a private chain at the seed's head, with the records the app needs", async () => {
    const { status, body } = await post("/v1/playground/sessions");
    expect(status).toBe(200);
    expect(body.id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.chainId).toBe(31337);
    expect(body.manifest.factory).toMatch(/^0x/);
    expect(body.runtime.defaultVault).toMatch(/^0x/);
    expect(Number((await call(body.rpcPath, "eth_chainId")).result)).toBe(31337);
    expect(Number((await call(body.rpcPath, "eth_blockNumber")).result)).toBe(138);
  });

  it("keeps the seed's clock: the next block is one second after the head", async () => {
    const { body } = await post("/v1/playground/sessions");
    const head = (await call(body.rpcPath, "eth_getBlockByNumber", ["latest", false])).result;
    await call(body.rpcPath, "evm_mine");
    const next = (await call(body.rpcPath, "eth_getBlockByNumber", ["latest", false])).result;
    expect(Number(next.timestamp) - Number(head.timestamp)).toBe(1);
  });

  it("refuses methods that reach the host, and resumes a session by id", async () => {
    const { body } = await post("/v1/playground/sessions");
    const refused = await call(body.rpcPath, "anvil_setRpcUrl", ["http://169.254.169.254"]);
    expect(refused.error.code).toBe(-32601);
    const again = await post("/v1/playground/sessions", { id: body.id });
    expect(again.body.resumed).toBe(true);
    expect(again.body.id).toBe(body.id);
  });

  it("resets to the seed; a visitor's own revert to the baseline is refused, so a reset always has it", async () => {
    const { body } = await post("/v1/playground/sessions");
    await call(body.rpcPath, "anvil_mine", ["0x5"]);
    expect(Number((await call(body.rpcPath, "eth_blockNumber")).result)).toBe(143);
    expect((await post(`/v1/playground/sessions/${body.id}/reset`)).status).toBe(200);
    expect(Number((await call(body.rpcPath, "eth_blockNumber")).result)).toBe(138);
    const { body: s } = await post("/v1/playground/sessions", { id: body.id });
    await call(s.rpcPath, "anvil_mine", ["0x2"]);
    expect((await call(s.rpcPath, "evm_revert", [s.runtime.baselineSnapshot])).result).toBe(false);
    expect(Number((await call(s.rpcPath, "eth_blockNumber")).result)).toBe(140);
    expect((await post(`/v1/playground/sessions/${body.id}/reset`)).status).toBe(200);
    expect(Number((await call(body.rpcPath, "eth_blockNumber")).result)).toBe(138);
    reused = { id: body.id, rpcPath: body.rpcPath };
  });

  it("answers false for a revert to a snapshot an earlier revert made stale, and the chain stays whole", async () => {
    expect(reused).toBeDefined();
    const body = reused!;
    const x = "0x00000000000000000000000000000000000000a1";
    const balance = async () => BigInt((await call(body.rpcPath, "eth_getBalance", [x, "latest"])).result);
    const s1 = (await call(body.rpcPath, "evm_snapshot")).result;
    const s2 = (await call(body.rpcPath, "evm_snapshot")).result;
    expect((await call(body.rpcPath, "evm_revert", [s1])).result).toBe(true);
    // Anvil still lists S2 (anvil_metadata), though its state went with S1
    expect(Object.keys((await call(body.rpcPath, "anvil_metadata")).result.snapshots)).toContain(s2);
    await call(body.rpcPath, "anvil_setBalance", [x, "0x5"]);
    await call(body.rpcPath, "evm_increaseTime", [3600]);
    await call(body.rpcPath, "anvil_mine", ["0x3"]);
    const before = (await call(body.rpcPath, "eth_getBlockByNumber", ["latest", false])).result;
    // Sent to Anvil, this would take the blocks and the clock back to S2 and leave the balance at 5
    expect((await call(body.rpcPath, "evm_revert", [s2])).result).toBe(false);
    const after = (await call(body.rpcPath, "eth_getBlockByNumber", ["latest", false])).result;
    expect(after.hash).toBe(before.hash);
    expect(after.timestamp).toBe(before.timestamp);
    expect(await balance()).toBe(5n);
    // the chain goes on as before: a new snapshot reverts, and a reset takes it back to the seed
    const s3 = (await call(body.rpcPath, "evm_snapshot")).result;
    await call(body.rpcPath, "anvil_mine", ["0x2"]);
    expect((await call(body.rpcPath, "evm_revert", [s3])).result).toBe(true);
    expect((await call(body.rpcPath, "eth_getBlockByNumber", ["latest", false])).result.hash).toBe(before.hash);
    expect((await post(`/v1/playground/sessions/${body.id}/reset`)).status).toBe(200);
    expect(Number((await call(body.rpcPath, "eth_blockNumber")).result)).toBe(138);
    expect(await balance()).toBe(0n);
  });

  it("answers 410 for a chain that is gone, and 503 when every chain is busy", async () => {
    expect((await post("/rpc/play/" + "0".repeat(32), { jsonrpc: "2.0", id: 1, method: "eth_chainId" })).status).toBe(410);
    // Two chains are allowed and both were just used: a third visitor from another address must wait.
    const res = await fetch(base + "/v1/playground/sessions", { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
  });
});
