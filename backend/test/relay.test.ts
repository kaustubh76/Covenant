// The relayer's rules, with stand-in chain clients: nothing here touches a network.

import { resolve } from "node:path";
import { type Hex, parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { Relayer } from "../src/relay/relayer";

const RECORDS = resolve(import.meta.dirname, "..", "..", "deployments");
const HASH = `0x${"ab".repeat(32)}` as Hex;
const ME = "0x00000000000000000000000000000000000000a1";

/** Chain clients that answer every read, pass every simulation unless told otherwise, and mine every send. */
function clients(o: { revert?: string } = {}) {
  const sent: string[] = [];
  const pub = {
    simulateContract: async (c: { functionName: string }) => {
      if (o.revert === c.functionName) throw new Error("execution reverted: NothingToRestore(9999, 4000)");
      return {};
    },
    readContract: async (c: { functionName: string }) => {
      if (c.functionName === "allowance") return 0n;
      return { key: { currency0: "0x0000000000000000000000000000000000000000", currency1: "0x1", fee: 3000, tickSpacing: 60, hooks: "0x2" }, quoteIsCurrency0: true, spotPrice: -88_000 };
    },
    waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 50_000n, effectiveGasPrice: 1_000_000n }),
    getBalance: async () => parseEther("0.05"),
  };
  const wallet = {
    account: { address: ME },
    writeContract: async (c: { functionName: string }) => (sent.push(c.functionName), HASH),
    sendTransaction: async () => (sent.push("transfer"), HASH),
  };
  return { clients: { pub, wallet } as never, sent };
}

const relayer = (c = clients(), extra: Partial<ConstructorParameters<typeof Relayer>[0]> = {}) =>
  new Relayer({ key: null, rpc: "http://unused", records: RECORDS, dailyEth: 0.02, dripEth: 0.002, dripTokens: 2, clients: c.clients, ...extra });

describe("the relayer", () => {
  it("is off without a key, and says so", async () => {
    const r = new Relayer({ key: null, rpc: "http://unused", records: RECORDS, dailyEth: 0.02, dripEth: 0.002, dripTokens: 2 });
    expect(r.enabled).toBe(false);
    await expect(r.handle("poke", "", "1.1.1.1")).rejects.toMatchObject({ status: 503 });
  });

  it("sends only its own actions, for recorded vaults, with valid fields", async () => {
    const r = relayer();
    await expect(r.handle("transferOwnership", "", "1.1.1.1")).rejects.toMatchObject({ status: 404 });
    await expect(r.handle("poke", JSON.stringify({ vault: "0x000000000000000000000000000000000000dEaD" }), "1.1.1.1")).rejects.toMatchObject({ status: 400 });
    await expect(r.handle("drip", "{}", "1.1.1.1")).rejects.toMatchObject({ status: 400 });
    await expect(r.handle("restore", JSON.stringify({ indices: [1, 1] }), "1.1.1.1")).rejects.toMatchObject({ status: 400 });
    await expect(r.handle("restore", JSON.stringify({ indices: "0x1234" }), "1.1.1.1")).rejects.toMatchObject({ status: 400 });
  });

  it("simulates first and sends nothing when the contract would refuse", async () => {
    const c = clients({ revert: "restore" });
    await expect(relayer(c).handle("restore", JSON.stringify({ indices: [0] }), "1.1.1.1")).rejects.toMatchObject({ status: 409 });
    expect(c.sent).toEqual([]);
  });

  it("sends a passing action and returns its hash", async () => {
    const c = clients();
    const out = await relayer(c).handle("poke", "", "1.1.1.1");
    expect(out).toMatchObject({ hash: HASH, status: "success" });
    expect(c.sent).toEqual(["poke"]);
    const sold = await relayer(c).handle("sell", "", "1.1.1.2");
    expect(sold.hashes).toHaveLength(2); // approve, then the swap
  });

  it("allows ten actions an hour per address", async () => {
    const r = relayer();
    for (let i = 0; i < 10; i++) await r.handle("poke", "", "9.9.9.9");
    await expect(r.handle("poke", "", "9.9.9.9")).rejects.toMatchObject({ status: 429 });
    await expect(r.handle("poke", "", "8.8.8.8")).resolves.toMatchObject({ status: "success" });
  });

  it("drips once a day per address and per caller", async () => {
    let t = 0;
    const r = relayer(clients(), { now: () => t });
    const to = JSON.stringify({ to: "0x00000000000000000000000000000000000000b2" });
    await expect(r.handle("drip", to, "7.7.7.7")).resolves.toMatchObject({ status: "success" });
    await expect(r.handle("drip", to, "6.6.6.6")).rejects.toMatchObject({ status: 429 });
    await expect(r.handle("drip", JSON.stringify({ to: "0x00000000000000000000000000000000000000b3" }), "7.7.7.7")).rejects.toMatchObject({ status: 429 });
    t += 25 * 3600_000;
    await expect(r.handle("drip", to, "6.6.6.6")).resolves.toMatchObject({ status: "success" });
  });

  it("stops at its daily budget", async () => {
    const r = relayer(clients(), { dailyEth: 0.003 });
    await expect(r.handle("drip", JSON.stringify({ to: "0x00000000000000000000000000000000000000b4" }), "5.5.5.5")).resolves.toBeTruthy();
    await expect(r.handle("buy", "", "5.5.5.6")).rejects.toMatchObject({ status: 503 });
  });
});
