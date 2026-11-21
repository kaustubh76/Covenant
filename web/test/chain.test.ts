// The app's scripted scenarios, run against the real contracts: the outcomes must match the Solidity suite's
// (test/integration/LaunchToRelease.t.sol, test/attacks/AttackCatalogue.t.sol, test/attacks/PumpRatchet.t.sol).

import { type Address, encodePacked, formatEther, isAddressEqual, keccak256, pad, zeroAddress } from "viem";
import { describe, expect, inject, it } from "vitest";
import { readNetwork } from "../scripts/lib/localchain";
import { covenantHookAbi, covenantVaultAbi, poolManagerAbi, testTokenAbi } from "../src/chain/abi.generated";
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
import { EXPECTED, judged } from "../src/chain/scenarios/livechecks";
import { DEMO_STEPS, emptyDemo } from "../src/chain/scenarios/demo";
import { collectingKit } from "../src/chain/scenarios/kit";
import { discoverLaunches } from "../src/chain/discover";
import { advance, revertTo, setSnapshotSender, takeSnapshot } from "../src/chain/time";
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
    // and blocked by the rule each attack tests: every refusal is the one the attack lab counts (livechecks EXPECTED),
    // so the page's own judgement leaves every verdict standing
    for (const a of ATTACKS) expect(judged({ expect: EXPECTED[a.id] ?? [] }, results[a.id]).noVerdict, a.id).toBeUndefined();
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

describe("save points, on real Anvil (src/chain/snapguard.ts)", () => {
  const latest = () => ctx.pub.getBlock({ blockTag: "latest" });

  it("refuses one a revert went past, without sending it, and the chain stays whole", async () => {
    const demo = await takeSnapshot(ctx); // the guided demo, before a step
    await advance(ctx, 3600);
    const save = await takeSnapshot(ctx); // the Dock's Save
    await advance(ctx, 3600);
    await revertTo(ctx, demo.id); // the demo's Start over
    const head = await latest();
    await expect(revertTo(ctx, save.id, save.record)).rejects.toMatchObject({ name: "SnapshotGone", why: "gone" });
    // Anvil would have pointed the head at a block it no longer has; nothing went, so the head is the real block
    const after = await latest();
    expect(after.hash).toBe(head.hash);
    expect(after.number).toBe(head.number);
  });

  it("refuses one made stale at its own block, where only the count below it shows", async () => {
    const s1 = await takeSnapshot(ctx);
    const s2 = await takeSnapshot(ctx); // the same block
    await revertTo(ctx, s1.id);
    await advance(ctx, 60);
    const before = await latest();
    await expect(revertTo(ctx, s2.id, s2.record)).rejects.toMatchObject({ why: "gone" });
    expect((await latest()).hash).toBe(before.hash);
  });

  it("goes back to one kept across a reload, by the record it carries, clock and all", async () => {
    const s = await takeSnapshot(ctx);
    const at = await latest();
    await advance(ctx, 86_400);
    setSnapshotSender(null); // a new page: nothing remembered in memory
    await revertTo(ctx, s.id, s.record);
    const back = await latest();
    expect(back.hash).toBe(at.hash);
    expect(back.timestamp).toBe(at.timestamp);
  });
});

describe("the vault view the pages show is the contracts' own state", () => {
  it("equals a direct read of every figure, at the block the view was read at", async () => {
    const vault = ctx.net.runtime!.defaultVault;
    const v = await readVaultView(ctx, vault);
    const at = { blockNumber: v.block };
    const r = <T>(functionName: string, args: readonly unknown[] = []) =>
      ctx.pub.readContract({ address: vault, abi: covenantVaultAbi, functionName, args, ...at } as never) as Promise<T>;
    const f = (x: bigint) => Number(formatEther(x));

    const [support, terms, anchor, pace, withdrawable, withdrawn, totalValue, totalShares, principalShares, bountyPool] = await Promise.all([
      r<readonly [bigint, bigint]>("support"),
      r<Record<string, number | bigint>>("terms"),
      r<number>("anchor"),
      r<bigint>("paceAvailable"),
      r<bigint>("principalWithdrawable"),
      r<bigint>("principalWithdrawn"),
      r<bigint>("totalValue"),
      r<bigint>("totalShares"),
      r<bigint>("principalShares"),
      r<bigint>("bountyPool"),
    ]);
    const [feePot0, feePot1, idle0, idle1, curator, issuer, pendingCurator, curatorReadyAt, treasury, q0, poolId, ranges] = await Promise.all([
      r<bigint>("feePot0"),
      r<bigint>("feePot1"),
      r<bigint>("idle0"),
      r<bigint>("idle1"),
      r<Address>("curator"),
      r<Address>("issuer"),
      r<Address>("pendingCurator"),
      r<bigint>("curatorReadyAt"),
      r<Address>("treasury"),
      r<boolean>("quoteIsCurrency0"),
      r<`0x${string}`>("poolId"),
      r<readonly { tickLower: number; tickUpper: number; liquidity: bigint }[]>("ranges"),
    ]);
    const split = (a0: bigint, a1: bigint) => (q0 ? { quote: f(a0), token: f(a1) } : { quote: f(a1), token: f(a0) });

    // support, terms and the rule state
    expect(v.support.have).toBe(Number(support[0]));
    expect(v.support.need).toBe(Number(support[1]));
    for (const [k, x] of Object.entries(terms)) expect((v.terms as unknown as Record<string, unknown>)[k], `terms.${k}`).toEqual(x);
    expect(v.anchor).toBe(anchor);
    expect(v.pace.available).toBe(pace >= 2n ** 255n ? 1 : Number(pace) / 1e9);
    expect(v.raw.principalWithdrawable).toBe(withdrawable);
    expect(v.lock.vested).toBeCloseTo(Number(withdrawable + withdrawn) / 1e18, 12);

    // the guard, measured as the contract measures it: the pool's tick against the hook's TWAP tick
    const slot = keccak256(encodePacked(["bytes32", "bytes32"], [poolId, pad("0x06", { size: 32 })]));
    const word = BigInt(await ctx.pub.readContract({ address: ctx.net.manifest.poolManager, abi: poolManagerAbi, functionName: "extsload", args: [slot], ...at }));
    const raw24 = Number((word >> 160n) & 0xffffffn);
    const spotTick = raw24 >= 0x800000 ? raw24 - 0x1000000 : raw24;
    const twapTick = await ctx.pub.readContract({ address: ctx.net.manifest.hook, abi: covenantHookAbi, functionName: "consult", args: [poolId, Number(terms.twapWindow)], ...at });
    expect(v.guard.diff).toBe(Math.abs(spotTick - twapTick));
    expect(v.guard.ok).toBe(Math.abs(spotTick - twapTick) <= Number(terms.guardTicks));

    // holdings, shares and fees
    expect(v.value).toBe(f(totalValue));
    expect(v.raw.totalShares).toBe(totalShares);
    expect(v.raw.principalShares).toBe(principalShares);
    expect(v.fees.bountyPool).toBe(f(bountyPool));
    expect(v.fees.pot).toEqual(split(feePot0, feePot1));
    expect(v.idle).toEqual(split(idle0, idle1));
    for (const actor of ["lp", "holder", "keeper", "curator", "issuer", "attacker", "market"] as const) {
      expect(v.raw.sharesOf[actor], `sharesOf(${actor})`).toBe(await r<bigint>("sharesOf", [addressOf(actor)]));
    }

    // the people and the clock
    expect(v.people.curator).toBe(curator);
    expect(v.people.issuer).toBe(issuer);
    expect(v.people.pendingCurator).toBe(pendingCurator === zeroAddress ? null : pendingCurator);
    expect(v.people.curatorReadyAt).toBe(Number(curatorReadyAt));
    expect(v.people.treasury).toBe(treasury);
    expect(v.time).toBe(Number((await ctx.pub.getBlock({ blockNumber: v.block })).timestamp));

    // the ranges, one for one
    expect(v.ranges.map((x) => [x.tickLower, x.tickUpper, x.liquidity])).toEqual(ranges.map((x) => [x.tickLower, x.tickUpper, x.liquidity]));
    // the token's name, as its contract gives it
    expect(v.symbolRead).toBe(true);
    expect(v.tokenSymbol).toBe(await ctx.pub.readContract({ address: v.token, abi: testTokenAbi, functionName: "symbol" }));
  });
});
