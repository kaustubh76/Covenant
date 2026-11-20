import { describe, expect, it } from "vitest";
import { WALLET_AUCTION_BLOCKS, WALLET_START_DELAY } from "../launch";
import { NETWORKS } from "../network";
import { ATTACKS } from "./attacks";
import { KEEPER, LIVE_CHECKS, NEW_CURATOR, overTheCap, pastSetup, runLiveChecks } from "./livechecks";

const ranges = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ index: i, kind: i === 0 ? "Support" : "Reserve", quote: 10 - i, token: 1, tickLower: -600 * (i + 1), tickUpper: -600 * i, liquidity: 1n }));
const view = (n: number, over: Record<string, unknown> = {}) =>
  ({
    address: "0xa999c514FB4B9063Ef047CF39EdCb37098f84AFc",
    token: "0xBd539bdf1864d951Eda75Ec5760d04BA554FC989",
    tokenSymbol: "CVNT",
    quoteSymbol: "ETH",
    quoteIs0: true,
    tickSpacing: 60,
    spotTick: 0,
    twap: 0,
    time: 1_000,
    terms: { supportBandTicks: 1500, paceBps: 5000, curatorTimelock: 2 * 86_400, twapWindow: 1800, bounty: 10n ** 16n },
    pace: { setupEndsAt: 0 },
    support: { have: 5000, need: 4000 },
    people: { curator: "0x455EbCA0935d9cd06908E96Aac2BB95047e88eb1", issuer: "0x455EbCA0935d9cd06908E96Aac2BB95047e88eb1" },
    raw: { principalWithdrawable: 0n, totalShares: 10n ** 18n, principalShares: 10n ** 18n },
    principal: { quote: 0.03, token: 100 },
    idle: { quote: 0, token: 0 },
    extras: {},
    key: {},
    ranges: ranges(n),
    ...over,
  }) as never;

/** A chain context whose simulations all succeed, and which remembers what it was asked. */
function fakeCtx() {
  const asked: { blocks: { blockOverrides: { time: bigint }; stateOverrides?: { address: string }[]; calls: { functionName: string; account?: string }[] }[] }[] = [];
  const ctx = {
    net: { manifest: { lens: "0x2f572fab2f0802B4Ef6Ce325EEf7a4B494d754Da", swapRouter: "0x8B5bcC363ddE2614281aD875bad385E0A785D3B9", liquidityRouter: "0x37429cD17Cb1454C34E7F50b09725202Fd533039" } },
    pub: {
      getBlock: async () => ({ number: 100n, timestamp: 1_000n }),
      readContract: async () => 10n ** 21n,
      simulateBlocks: async (p: (typeof asked)[number]) => {
        asked.push(p);
        return p.blocks.map((b) => ({ calls: b.calls.map(() => ({ status: "success", result: undefined })) }));
      },
    },
  };
  return { ctx: ctx as never, asked };
}

describe("live attack checks", () => {
  it("each stands for a card in the attack lab, once, and all but the days-long pump are covered", () => {
    const ids = LIVE_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cards = new Set(ATTACKS.map((a) => a.id));
    for (const id of ids) expect(cards.has(id), id).toBe(true);
    expect(ATTACKS.filter((a) => !ids.includes(a.id)).map((a) => a.id)).toEqual(["pump-patient"]);
  });

  it("splits the reserve into enough slivers to go over the 14-range cap, whatever the vault holds", () => {
    for (let n = 1; n <= 10; n++) {
      const p = overTheCap(view(n));
      expect(n - p.cuts.length + p.legs.length, `${n} ranges`).toBeGreaterThan(14);
      for (const l of p.legs) expect(l.tickLower % 60 === 0 && l.tickUpper % 60 === 0 && l.tickLower < l.tickUpper).toBe(true);
    }
  });

  it("moves past the setup epoch before trying anything the epoch would excuse", () => {
    expect(pastSetup({ v: view(4, { pace: { setupEndsAt: 2_000 } }), base: { number: 1n, timestamp: 1_000n } })).toBe(1_001);
    expect(pastSetup({ v: view(4), base: { number: 1n, timestamp: 1_000n } })).toBe(1);
  });

  it("waits out the curator timelock in a later simulated block, with the stand-ins funded first", async () => {
    const { ctx, asked } = fakeCtx();
    const check = LIVE_CHECKS.find((c) => c.id === "instant-curator")!;
    await runLiveChecks(ctx, view(4), () => {}, [check]);
    const [sim] = asked;
    expect(sim.blocks.map((b) => b.blockOverrides.time)).toEqual([1_001n, 1_000n + 2n + 2n * 86_400n]);
    expect(sim.blocks[0].stateOverrides?.map((o) => o.address)).toContain(KEEPER);
    expect(sim.blocks[0].calls.map((c) => c.functionName)).toEqual(["proposeCurator", "acceptCurator"]);
    expect(sim.blocks[1].calls[1].account).toBe(NEW_CURATOR);
  });

  it("reports a refusal as blocked, and an attack the chain would accept as getting through", async () => {
    const { ctx } = fakeCtx();
    const got: Record<string, boolean> = {};
    await runLiveChecks(ctx, view(4), (id, r) => (got[id] = r.blocked), [LIVE_CHECKS.find((c) => c.id === "vault-pays")!]);
    // every simulated call succeeds here, so the 1-wei deposit "went through": the check must say so, not hide it
    expect(got["vault-pays"]).toBe(false);
  });

  it("shows nothing for a check whose scene could not be set, and says why a check could not run", async () => {
    const { ctx } = fakeCtx();
    const seen: Record<string, string | undefined> = {};
    await runLiveChecks(ctx, view(4), (id, r) => (seen[id] = r.noVerdict), [{ id: "x", run: async () => null }, { id: "y", run: async () => Promise.reject(new Error("no eth_simulateV1")) }]);
    // no scene: nothing to show. A check that threw: no verdict, with the reason, so its card keeps the recorded run.
    expect(seen).toEqual({ y: "This check could not run: no eth_simulateV1" });
  });
});

describe("a wallet's launch on a public chain", () => {
  it("runs an auction a person can bid in, on the CCA's even split of 1e7 mps", () => {
    expect(1e7 % WALLET_AUCTION_BLOCKS).toBe(0);
    expect(WALLET_AUCTION_BLOCKS % 2).toBe(0);
    const seconds = (WALLET_AUCTION_BLOCKS * NETWORKS["base-sepolia"].caps.blockTimeMs) / 1000;
    expect(seconds).toBeGreaterThanOrEqual(180);
    expect((WALLET_START_DELAY * NETWORKS["base-sepolia"].caps.blockTimeMs) / 1000).toBeGreaterThanOrEqual(5);
  });
});
