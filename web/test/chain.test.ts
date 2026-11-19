// The app's scripted scenarios, run against the real contracts: the outcomes must match the Solidity suite's
// (test/integration/LaunchToRelease.t.sol, test/attacks/AttackCatalogue.t.sol, test/attacks/PumpRatchet.t.sol).

import { type Address, formatEther, isAddressEqual } from "viem";
import { describe, expect, inject, it } from "vitest";
import { readNetwork } from "../scripts/lib/localchain";
import { covenantVaultAbi, testTokenAbi } from "../src/chain/abi.generated";
import { actorOf, addressOf } from "../src/chain/accounts";
import type { BeatInput } from "../src/chain/beat";
import { createChainCtx } from "../src/chain/client";
import { readActivity } from "../src/chain/history";
import {
  DEFAULT_BIDS,
  adopt,
  closeAuction,
  defaultLaunchSpec,
  migrate,
  readSale,
  registerLaunch,
  runAuction,
  seed,
  seedParamsFor,
  settleBids,
  sweepUnsold,
} from "../src/chain/launch";
import { PRESETS } from "../src/chain/terms";
import { must, send } from "../src/chain/tx";
import { ATTACKS, type AttackRun, runAttacks } from "../src/chain/scenarios/attacks";
import { DEMO_STEPS, emptyDemo } from "../src/chain/scenarios/demo";
import { collectingKit } from "../src/chain/scenarios/kit";
import { discoverLaunches } from "../src/chain/discover";
import { readVaultView } from "../src/chain/view";

const ctx = createChainCtx(readNetwork(inject("rpcUrl"), inject("deployments")));
const outcome = (beats: BeatInput[]) => beats.map((b) => (b.ok ? "ok" : (b.error?.name ?? "?")));
const tokenBalance = (token: Address, who: Address) => ctx.pub.readContract({ address: token, abi: testTokenAbi, functionName: "balanceOf", args: [who] });
const has = (list: readonly Address[], a: Address) => list.some((x) => isAddressEqual(x, a));

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
  // shared with the claim below, which reads the vault the demo leaves behind
  const state = emptyDemo();
  it("reproduces LaunchToRelease, with the crash-and-restore as step 7", async () => {
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

  it("leaves the replaced curator owed what it booked in office, paid out on its own claim", async () => {
    const vault = state.launch!.vault;
    const v = await readVaultView(ctx, vault);
    expect(actorOf(v.people.curator)).toBe("newCurator");
    const original = addressOf("curator");
    const { seen } = await readActivity(ctx, v);
    expect(isAddressEqual(seen.vault, vault)).toBe(true);
    expect(has(seen.curators, original)).toBe(true);
    expect(has(seen.depositors, addressOf("lp"))).toBe(true);

    const booked = (who: Address) =>
      Promise.all([
        ctx.pub.readContract({ address: vault, abi: covenantVaultAbi, functionName: "curatorFees0", args: [who] }),
        ctx.pub.readContract({ address: vault, abi: covenantVaultAbi, functionName: "curatorFees1", args: [who] }),
      ]);
    const [fees0, fees1] = await booked(original);
    expect(fees0 + fees1).toBeGreaterThan(0n);
    const successor = await booked(addressOf("newCurator"));
    const eth = await ctx.pub.getBalance({ address: original });
    const tokens = await tokenBalance(v.token, original);

    // sent by address: on a dev chain the original curator's dev key signs; gas is free, so balances move exactly
    const o = await send(ctx, original, { address: vault, abi: covenantVaultAbi, functionName: "claimCuratorFees", args: [] });
    expect(o.ok).toBe(true);
    expect(o.value).toEqual([fees0, fees1]);
    expect(await ctx.pub.getBalance({ address: original })).toBe(eth + fees0); // ETH is currency0
    expect(await tokenBalance(v.token, original)).toBe(tokens + fees1);
    expect(await booked(original)).toEqual([0n, 0n]);
    expect(await booked(addressOf("newCurator"))).toEqual(successor);
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

describe("an undersold launch", () => {
  it("leaves the rest for the treasury to sweep, once, and still migrates, seeds and settles", async () => {
    const launch = await registerLaunch(ctx, defaultLaunchSpec(PRESETS.standard, { name: "Undersold Launch", symbol: "UNDR" }));
    // Bob's two bids only: 600 ETH never lifts the price off the 1.0 floor, so the auction cannot sell its 1,000 tokens
    await runAuction(
      ctx,
      launch,
      DEFAULT_BIDS.filter((b) => b.bidder === "bob"),
    );
    await closeAuction(ctx, launch);
    const sale = await readSale(ctx, launch);
    const treasury = addressOf("treasury");
    expect(sale.closed).toBe(true);
    expect(sale.swept).toBe(false);
    expect(isAddressEqual(sale.recipient, treasury)).toBe(true);
    expect(Number(formatEther(sale.unsold))).toBeGreaterThan(300);
    expect(Number(formatEther(sale.sold + sale.unsold))).toBeCloseTo(1000, 6);

    // anyone else is refused with the reason, and nothing is sent
    const refused = await sweepUnsold(ctx, launch, "bob");
    expect(refused.ok).toBe(false);
    expect(refused.hash).toBeUndefined();
    expect(refused.error?.name).toBe("NotAuthorized");
    expect(refused.error?.reason).toContain("the recipient the auction names");

    // the treasury takes exactly what was left, once
    const before = await tokenBalance(launch.token, treasury);
    const swept = await sweepUnsold(ctx, launch);
    expect(swept.ok).toBe(true);
    expect(swept.amount).toBe(sale.unsold);
    expect(await tokenBalance(launch.token, treasury)).toBe(before + sale.unsold);
    const again = await sweepUnsold(ctx, launch);
    expect(again.ok).toBe(false);
    expect(again.error?.name).toBe("CannotSweepTokens");
    const after = await readSale(ctx, launch);
    expect(after.swept).toBe(true);
    expect(after.unsold).toBe(sale.unsold);

    // the sweep changes nothing for the rest of the launch: with no outbid demand the seed puts the quote in support
    expect((await migrate(ctx, launch)).length).toBeGreaterThan(0);
    must(await adopt(ctx, launch), "adopt");
    expect((await seed(ctx, launch, "curator", seedParamsFor(PRESETS.standard))).ok).toBe(true);
    const v = await readVaultView(ctx, launch.vault);
    expect(v.support.have).toBeGreaterThanOrEqual(v.support.need);
    expect(await settleBids(ctx, launch, "bob", { claim: true })).toEqual({ exited: 2, claimed: 2 });
  });
});
