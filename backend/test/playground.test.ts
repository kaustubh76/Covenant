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

  it("resets to the seed, even after the baseline snapshot was reverted away", async () => {
    const { body } = await post("/v1/playground/sessions");
    await call(body.rpcPath, "anvil_mine", ["0x5"]);
    expect(Number((await call(body.rpcPath, "eth_blockNumber")).result)).toBe(143);
    expect((await post(`/v1/playground/sessions/${body.id}/reset`)).status).toBe(200);
    expect(Number((await call(body.rpcPath, "eth_blockNumber")).result)).toBe(138);
    // A visitor reverting the baseline themselves leaves nothing to revert to: the chain is replaced from the seed.
    const { body: s } = await post("/v1/playground/sessions", { id: body.id });
    await call(s.rpcPath, "evm_revert", [s.runtime.baselineSnapshot]);
    await call(s.rpcPath, "anvil_mine", ["0x2"]);
    expect((await post(`/v1/playground/sessions/${body.id}/reset`)).status).toBe(200);
    expect(Number((await call(body.rpcPath, "eth_blockNumber")).result)).toBe(138);
  });

  it("answers 410 for a chain that is gone, and 503 when every chain is busy", async () => {
    expect((await post("/rpc/play/" + "0".repeat(32), { jsonrpc: "2.0", id: 1, method: "eth_chainId" })).status).toBe(410);
    // Two chains are allowed and both were just used: a third visitor from another address must wait.
    const res = await fetch(base + "/v1/playground/sessions", { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
  });
});
