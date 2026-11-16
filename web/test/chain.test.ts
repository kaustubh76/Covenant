// The app's scripted scenarios, run against the real contracts: the outcomes must match the Solidity suite's
// (test/integration/LaunchToRelease.t.sol, test/attacks/AttackCatalogue.t.sol, test/attacks/PumpRatchet.t.sol).

import { describe, expect, inject, it } from "vitest";
import { readNetwork } from "../scripts/lib/localchain";
import type { BeatInput } from "../src/chain/beat";
import { createChainCtx } from "../src/chain/client";
import { ATTACKS, type AttackRun, runAttacks } from "../src/chain/scenarios/attacks";
import { DEMO_STEPS, emptyDemo } from "../src/chain/scenarios/demo";
import { collectingKit } from "../src/chain/scenarios/kit";
import { discoverLaunches } from "../src/chain/discover";
import { readVaultView } from "../src/chain/view";

const ctx = createChainCtx(readNetwork(inject("rpcUrl"), inject("deployments")));
const outcome = (beats: BeatInput[]) => beats.map((b) => (b.ok ? "ok" : (b.error?.name ?? "?")));

describe("the seeded launch", () => {
  it("matches the integration test's numbers", async () => {
    const v = await readVaultView(ctx, ctx.net.runtime!.defaultVault);
    expect(v.support.have).toBe(5238);
    expect(v.ranges).toHaveLength(5);
    // the client's own support figure agrees with the contract to within rounding
    expect(Math.abs((v.support.inBand / v.support.total) * 1e4 - v.support.have)).toBeLessThan(2);
    const launches = await discoverLaunches(ctx);
    expect(launches.map((l) => l.vault)).toContain(v.address);
  });
});

describe("the guided demo, step by step", () => {
  it("reproduces LaunchToRelease, with the crash-and-restore as step 7", async () => {
    const state = emptyDemo();
    const out: string[][] = [];
    const details: string[][] = [];
    for (const step of DEMO_STEPS) {
      const kit = collectingKit(ctx);
      await step.run(kit, state);
      out.push(outcome(kit.beats));
      details.push(kit.beats.map((b) => b.detail ?? ""));
    }
    expect(out[0]).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(out[1].every((o) => o === "ok")).toBe(true);
    expect(details[2][1]).toContain("7.2% → 52.4%");
    expect(state.fullRangeImpact! / state.managedImpact!).toBeGreaterThan(3);
    expect(out[4]).toEqual(["InsufficientShares", "IdleTooLarge", "SupportBroken"]);
    expect(out[5]).toEqual(["ok", "ok", "PriceGuard", "PriceGuard", "ok", "ok"]);
    expect(out[6]).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(out[7]).toEqual(["ok", "ok", "ok"]);
    expect(out[8].slice(0, 4)).toEqual(["ok", "TimelockActive", "ok", "ok"]);
    expect(["SupportBroken", "PaceExceeded"]).toContain(out[8][4]);
    expect(out[9]).toEqual(["Locked", "ok", "ok", "Locked"]);
  });
});

describe("the attack lab", () => {
  it("blocks every attack, as the Solidity suite asserts", async () => {
    const results: Record<string, AttackRun> = {};
    await runAttacks(ctx, ATTACKS, (id, r) => {
      results[id] = r;
    });
    for (const a of ATTACKS) expect(results[a.id]?.blocked, `${a.id}: ${results[a.id]?.summary}`).toBe(true);
    expect(results["pump-patient"].beats.find((b) => !b.ok)?.error?.name).toBe("RestoreBandEmpty");
    expect(results["colluding-curator"].beats.find((b) => !b.ok)?.error?.name).toBe("BidAboveCeiling");
    expect(results["fragment"].beats[0].error?.signature).toBe("TooManyRanges(15, 14)");
  });

  it("leaves the chain exactly as it found it", async () => {
    const before = await ctx.pub.getBlockNumber();
    await runAttacks(ctx, [ATTACKS.find((a) => a.id === "farm")!], () => {});
    expect(await ctx.pub.getBlockNumber()).toBe(before);
  });
});
