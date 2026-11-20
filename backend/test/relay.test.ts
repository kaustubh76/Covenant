// The relayer's rules, with stand-in chain clients: nothing here touches a network.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Hex, parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { Relayer } from "../src/relay/relayer";

const RECORDS = resolve(import.meta.dirname, "..", "..", "deployments");
const HASH = `0x${"ab".repeat(32)}` as Hex;
const ME = "0x00000000000000000000000000000000000000a1";

/** Chain clients that answer every read, pass every simulation unless told otherwise, and mine every send. */
function clients(o: { revert?: string; me?: string; curator?: string; twap?: number } = {}) {
  const sent: string[] = [];
  const pub = {
    simulateContract: async (c: { functionName: string }) => {
      if (o.revert === c.functionName) throw new Error("execution reverted: NothingToRestore(9999, 4000)");
      return {};
    },
    readContract: async (c: { functionName: string }) => {
      if (c.functionName === "allowance") return 0n;
      if (c.functionName === "treasury") return "0x00000000000000000000000000000000000000f1";
      return {
        key: { currency0: "0x0000000000000000000000000000000000000000", currency1: "0x1", fee: 3000, tickSpacing: 60, hooks: "0x2" },
        quoteIsCurrency0: true,
        spotPrice: -88_000,
        twapPrice: o.twap ?? -88_010,
        terms: { guardTicks: 300 },
        issuer: "0x00000000000000000000000000000000000000e1",
        curator: o.curator ?? "0x00000000000000000000000000000000000000c1",
      };
    },
    waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 50_000n, effectiveGasPrice: 1_000_000n }),
    getBalance: async () => parseEther("0.05"),
  };
  const wallet = {
    account: { address: o.me ?? ME },
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

  it("charges no quota for a request that sends nothing", async () => {
    const c = clients({ revert: "restore" });
    const r = relayer(c);
    for (let i = 0; i < 12; i++) await expect(r.handle("restore", JSON.stringify({ indices: [0] }), "6.6.6.6")).rejects.toMatchObject({ status: 409 });
    await expect(r.handle("poke", "", "6.6.6.6")).resolves.toMatchObject({ status: "success" });
    expect(c.sent).toEqual(["poke"]);
  });

  it("names the vaults it serves in its status", async () => {
    const s = await relayer().status();
    expect(s).toMatchObject({ enabled: true });
    expect((s as { vaults: string[] }).vaults.length).toBeGreaterThan(0);
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

  it("cannot be raced: ten parallel drips from one caller send one", async () => {
    const c = clients();
    const r = relayer(c);
    const tries = Array.from({ length: 10 }, (_, i) => r.handle("drip", JSON.stringify({ to: `0x00000000000000000000000000000000000001${String(i).padStart(2, "0")}` }), "4.4.4.4"));
    const results = await Promise.allSettled(tries);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });

  it("holds its budget against parallel callers too", async () => {
    const r = relayer(clients(), { dailyEth: 0.006 });
    const tries = Array.from({ length: 6 }, (_, i) => r.handle("drip", JSON.stringify({ to: `0x00000000000000000000000000000000000002${String(i).padStart(2, "0")}` }), `3.3.3.${i}`));
    const ok = (await Promise.allSettled(tries)).filter((x) => x.status === "fulfilled");
    expect(ok).toHaveLength(2); // 0.0024 reserved each: two fit in 0.006, a third would not
  });

  it("refuses to run from the deployer's key or from any vault role's", async () => {
    const deployer = JSON.parse(readFileSync(resolve(RECORDS, "84532.json"), "utf8")).deployer as string;
    expect(relayer(clients({ me: deployer })).enabled).toBe(false);
    const asCurator = relayer(clients({ curator: ME }));
    await expect(asCurator.handle("poke", "", "1.1.1.1")).rejects.toMatchObject({ status: 503 });
    await expect(asCurator.status()).resolves.toMatchObject({ enabled: false });
  });

  it("will not trade while spot is already half a guard from its average", async () => {
    await expect(relayer(clients({ twap: -88_200 })).handle("buy", "", "2.2.2.2")).rejects.toMatchObject({ status: 409 });
  });

  it("caps relayed trades across every caller", async () => {
    const r = relayer(clients(), { dailyEth: 1 });
    for (let i = 0; i < 20; i++) await r.handle("poke", "", `10.0.0.${i}`); // pokes are not trades
    for (let i = 0; i < 20; i++) await r.handle("buy", "", `10.1.0.${i}`);
    await expect(r.handle("buy", "", "10.2.0.1")).rejects.toMatchObject({ status: 429 });
  });

  it("fails closed when the key's roles cannot be checked, and checks again next time", async () => {
    const c = clients();
    let failing = true;
    const read = (c.clients as unknown as { pub: { readContract: (x: { functionName: string }) => Promise<unknown> } }).pub;
    const real = read.readContract;
    read.readContract = async (x) => {
      if (failing && x.functionName === "snapshot") throw new Error("rpc down");
      return real(x);
    };
    const r = relayer(c);
    await expect(r.handle("poke", "", "1.2.3.4")).rejects.toMatchObject({ status: 503 });
    failing = false;
    await expect(r.handle("poke", "", "1.2.3.4")).resolves.toMatchObject({ status: "success" });
  });
});