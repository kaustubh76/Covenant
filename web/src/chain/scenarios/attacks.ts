// The attack lab: every row of the spec's catalogue (test/attacks/AttackCatalogue.t.sol), the attacks found while
// building this version, and the pump-ratchet (test/attacks/PumpRatchet.t.sol), replayed as real transactions. Each
// attack runs in its own sandbox against one fresh vault set up exactly like the suite's setUp, and the chain is put
// back afterwards.

import { type Address, formatEther, maxUint256, parseEther, zeroHash } from "viem";
import { covenantVaultAbi, liquidityRouterAbi, poolSwapTestAbi, testTokenAbi } from "../abi.generated";
import { beatOf, note } from "../beat";
import type { ChainCtx } from "../client";
import { type Launch, NEVER, defaultLaunchSpec, launchAndAdopt } from "../launch";
import { pushTo, sqrtPriceLimitAt, swap } from "../market";
import { SINK, bidLeg, cut, cutAll, honestLegs } from "../plans";
import { toPool } from "../price";
import { PRESETS } from "../terms";
import { advance, sandbox } from "../time";
import { devTxFields, must, send } from "../tx";
import { type VaultView, positionLiquidity, readSqrtPrice, readVaultView } from "../view";
import { type Kit, attempt, collectingKit, fund, sameBlock, settleTwap, ticksAsDrop, tokenBalance, view } from "./kit";

export interface Fixture {
  vault: Address;
  launch: Launch;
  /** Spot price tick when the honest seed was placed (AttackCatalogue's seedPrice). */
  seedPrice: number;
}

export interface AttackOutcome {
  /** True when the attack failed to take value, as the Solidity test asserts. */
  blocked: boolean;
  summary: string;
}

export interface Attack {
  id: string;
  title: string;
  who: string;
  story: string;
  rule: "Access" | "Conservation" | "Support" | "Guard" | "Pace" | "Lock" | "Anchor" | "Restore" | "Oracle" | "Shares" | "Shape";
  /** The Solidity test this replays. */
  test: string;
  slow?: boolean;
  run(k: Kit, f: Fixture): Promise<AttackOutcome>;
}

const ONE = 10n ** 18n;
const TENTH = 10n ** 17n;
const BIG = parseEther("100000");
const eth = (x: bigint) => Number(formatEther(x));
const signed = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(3)}`;

/** The attack suite's setUp: Standard terms, the honest seed, a 1 ETH bounty pool, one hour later. */
export async function attackFixture(ctx: ChainCtx): Promise<Fixture> {
  const launch = await launchAndAdopt(ctx, defaultLaunchSpec(PRESETS.standard, { name: "Attack Lab", symbol: "TOKEN" }));
  const v = await readVaultView(ctx, launch.vault);
  const seedPrice = v.spotTick;
  must(await send(ctx, "curator", { address: launch.vault, abi: covenantVaultAbi, functionName: "reshape", args: [cutAll(v), honestLegs(v, seedPrice, 6000), NEVER] }), "honest seed");
  must(await send(ctx, "issuer", { address: launch.vault, abi: covenantVaultAbi, functionName: "fundBounty", args: [ONE], value: ONE }), "fund bounty");
  await advance(ctx, 3600);
  return { vault: launch.vault, launch, seedPrice };
}

/** AttackCatalogue._indexOfLeg: where the honest seed's leg `i` lives in the range list. */
function indexOfLeg(v: VaultView, f: Fixture, i: number): number {
  const leg = honestLegs(v, f.seedPrice, 6000)[i];
  const r = v.ranges.find((x) => x.tickLower === leg.tickLower && x.tickUpper === leg.tickUpper);
  if (!r) throw new Error(`honest leg ${i} not found`);
  return r.index;
}

/** PumpRatchet._quoteRanges: ranges starting under the price. */
const quoteRangesUnderSpot = (v: VaultView) => v.ranges.filter((r) => r.priceLower < v.spotTick).map((r) => BigInt(r.index));

/** AttackCatalogue._quoteRangesBelowTheBand. */
function quoteRangesBelowTheBand(v: VaultView) {
  const bottom = Math.min(v.anchor, v.twap) - v.terms.supportBandTicks;
  return v.ranges.filter((r) => r.priceLower < bottom && r.priceLower < v.twap).map((r) => BigInt(r.index));
}

const depositArgs = [TENTH, maxUint256, maxUint256, NEVER] as const;

async function pumpThroughTheAsks(k: Kit, f: Fixture, ticks: number) {
  const v = await view(k, f.vault);
  const before = await tokenBalance(k, v.token, "attacker");
  const o = await pushTo(k.ctx, v, "attacker", f.seedPrice + ticks, BIG);
  const bought = (await tokenBalance(k, v.token, "attacker")) - before;
  k.record(beatOf(o, "attacker", `Buy every ask and push ${ticks.toLocaleString()} ticks through empty ticks`, () => `Bought ${eth(bought).toFixed(2)} tokens. Spot now sits wherever the attacker put it`));
  return bought;
}

async function sellBack(k: Kit, f: Fixture, amount: bigint) {
  const v = await view(k, f.vault);
  const o = await swap(k.ctx, v, "attacker", false, amount);
  k.record(beatOf(o, "attacker", "Sell the tokens back", () => "The attacker is flat in tokens again"));
}

export const ATTACKS: Attack[] = [
  {
    id: "curator-withdraw",
    title: "Curator withdraws the liquidity",
    who: "Curator",
    story: "The curator manages the vault but owns none of it. Try both exits: an LP withdrawal and the issuer's principal.",
    rule: "Access",
    test: "test_13_2_01_curatorCannotWithdrawPrincipal",
    async run(k, f) {
      const a = await attempt(k, "curator", "Withdraw shares", f.vault, "withdraw", [1n, 0n, 0n, NEVER]);
      const b = await attempt(k, "curator", "Withdraw principal", f.vault, "withdrawPrincipal", [1n, 0n, 0n, NEVER]);
      return { blocked: !a.ok && !b.ok, summary: "No code path: the curator holds no shares and is not the issuer" };
    },
  },
  {
    id: "skim",
    title: "Skim 10% while reshaping",
    who: "Curator",
    story: "Lift the support and re-add only 90% of it during an otherwise ordinary reshape, keeping the difference.",
    rule: "Conservation",
    test: "test_13_2_02_curatorCannotSkim",
    async run(k, f) {
      const v = await view(k, f.vault);
      const o = await attempt(k, "curator", "Reshape, re-adding 90% of the support", f.vault, "reshape", [[cut(indexOfLeg(v, f, 1))], [bidLeg(v, f.seedPrice - 1440, f.seedPrice - 180, 9000)], NEVER]);
      return { blocked: !o.ok, summary: "What is not put back may not even sit idle" };
    },
  },
  {
    id: "softrug",
    title: "Soft rug",
    who: "Curator",
    story: "Leave every asset in the pool, but move all of the buy support far below the price, where it will never trade.",
    rule: "Support",
    test: "test_13_2_03_softRugIsRejected",
    async run(k, f) {
      const v = await view(k, f.vault);
      const o = await attempt(k, "curator", "Move the support 9,000 ticks down", f.vault, "reshape", [[cut(indexOfLeg(v, f, 1))], [bidLeg(v, f.seedPrice - 12_000, f.seedPrice - 9_000, SINK)], NEVER]);
      return { blocked: !o.ok, summary: "Support is checked on the layout the reshape leaves" };
    },
  },
  {
    id: "manipulate",
    title: "Push the price, then act",
    who: "Attacker and friends",
    story: "Dump to move spot, then reshape, deposit and restore against the manipulated price.",
    rule: "Guard",
    test: "test_13_2_04_manipulatedSpotBlocksEveryStateChange",
    async run(k, f) {
      await advance(k.ctx, 86_400);
      let v = await view(k, f.vault);
      await fund(k, "lp", v);
      const d = await pushTo(k.ctx, v, "attacker", v.spotTick - 2000, BIG);
      k.record(beatOf(d, "attacker", "Dump the token", () => `Spot falls 2,000 ticks (${ticksAsDrop(2000)})`));
      v = await view(k, f.vault);
      const a = await attempt(k, "curator", "Reshape at the new spot", f.vault, "reshape", [[cut(0, 1n)], [], NEVER]);
      const b = await attempt(k, "lp", "Deposit at the manipulated price", f.vault, "deposit", depositArgs, { value: parseEther("50") });
      const c = await attempt(k, "keeper", "Call restore", f.vault, "restore", [[0n], NEVER]);
      return { blocked: !a.ok && !b.ok && !c.ok, summary: "The guard blocks all three until the price has held" };
    },
  },
  {
    id: "flash",
    title: "Flash round trip to bend the TWAP",
    who: "Attacker",
    story: "Push the price 5,000 ticks and straight back in the same block, hoping the average remembers the spike.",
    rule: "Oracle",
    test: "test_13_2_05_flashRoundTripHasNoEffect",
    async run(k, f) {
      const v = await view(k, f.vault);
      const home = await readSqrtPrice(k.ctx, v.poolId);
      const w = k.ctx.wallet("attacker");
      const router = k.ctx.net.manifest.swapRouter as Address;
      await fund(k, "attacker", v, BIG);
      const sellLimit = sqrtPriceLimitAt(toPool(v.quoteIs0, v.spotTick - 5000));
      const settings = { takeClaims: false, settleUsingBurn: false };
      await sameBlock(k, [
        () =>
          w.writeContract({
            address: router,
            abi: poolSwapTestAbi,
            functionName: "swap",
            args: [v.key, { zeroForOne: !v.quoteIs0, amountSpecified: -BIG, sqrtPriceLimitX96: sellLimit }, settings, "0x"],
            gas: 3_000_000n,
            ...devTxFields(k.ctx, 3_000_000n),
          }),
        () =>
          w.writeContract({
            address: router,
            abi: poolSwapTestAbi,
            functionName: "swap",
            args: [v.key, { zeroForOne: v.quoteIs0, amountSpecified: -BIG, sqrtPriceLimitX96: home }, settings, "0x"],
            value: BIG,
            gas: 3_000_000n,
            ...devTxFields(k.ctx, 3_000_000n),
          }),
      ]);
      const after = await view(k, f.vault);
      k.record(note("attacker", "Dump 5,000 ticks and buy back, in one block", `TWAP before ${v.twap}, after ${after.twap}`));
      const o = await attempt(k, "curator", "Reshape: is the guard fooled?", f.vault, "reshape", [[cut(0, 1n)], [], NEVER], { detail: () => "The guard passes: nothing happened, as far as the average is concerned" });
      return { blocked: after.twap === v.twap && o.ok, summary: "Same-block writes add no weight to the average" };
    },
  },
  {
    id: "pace",
    title: "Restructure the whole vault at once",
    who: "Curator",
    story: "After the setup epoch, try to relocate the entire vault in a single transaction.",
    rule: "Pace",
    test: "test_13_2_06_wholeVaultInOneBlockExceedsPace",
    async run(k, f) {
      await advance(k.ctx, 86_400);
      const v = await view(k, f.vault);
      const o = await attempt(k, "curator", "Move 100% of the vault", f.vault, "reshape", [cutAll(v), honestLegs(v, v.spotTick, 6000), NEVER]);
      return { blocked: !o.ok, summary: "At most half the vault moves per epoch under Standard terms" };
    },
  },
  {
    id: "instant-curator",
    title: "Swap in a friendly curator",
    who: "Issuer and a new curator",
    story: "Replace the curator instantly, then have the new one move the support away.",
    rule: "Pace",
    test: "test_13_2_07_curatorSwapIsTimelockedAndBound",
    async run(k, f) {
      await attempt(k, "issuer", "Propose a new curator", f.vault, "proposeCurator", [k.ctx.address("newCurator")], { detail: () => "Timelock starts" });
      await attempt(k, "keeper", "Accept immediately", f.vault, "acceptCurator", []);
      await advance(k.ctx, 2 * 86_400);
      await attempt(k, "keeper", "Accept after two days", f.vault, "acceptCurator", [], { detail: () => "New curator in place" });
      const v = await view(k, f.vault);
      const o = await attempt(k, "newCurator", "New curator moves the support away", f.vault, "reshape", [[cut(indexOfLeg(v, f, 1))], [bidLeg(v, f.seedPrice - 12_000, f.seedPrice - 9_000, SINK)], NEVER]);
      return { blocked: !o.ok, summary: "Timelocked, then bound by exactly the same rules" };
    },
  },
  {
    id: "fragment",
    title: "Gas-grief the vault",
    who: "Curator",
    story: "Split the reserve into a dozen slivers so that every later call costs too much gas to run.",
    rule: "Shape",
    test: "test_13_2_08_fragmentationIsCapped",
    async run(k, f) {
      const v = await view(k, f.vault);
      const legs = [];
      let top = f.seedPrice - 1500;
      for (let i = 0; i < 12; i++) {
        legs.push(bidLeg(v, top - 60, top, i === 0 ? SINK : 500));
        top -= 60;
      }
      const o = await attempt(k, "curator", "Fragment the reserve into 12 ranges", f.vault, "reshape", [[cut(indexOfLeg(v, f, 2))], legs, NEVER]);
      return { blocked: !o.ok, summary: "A reshape may leave 14 ranges at most, so restore always has room" };
    },
  },
  {
    id: "farm",
    title: "Farm the restore bounty",
    who: "Keeper",
    story: "Call restore while support is healthy, hoping to drain the bounty pool.",
    rule: "Restore",
    test: "test_13_2_09_restoreBountyCannotBeFarmed",
    async run(k, f) {
      const o = await attempt(k, "keeper", "Call restore on a healthy vault", f.vault, "restore", [[0n], NEVER]);
      return { blocked: !o.ok, summary: "Healthy support pays nothing" };
    },
  },
  {
    id: "cheap-shares",
    title: "Mint shares cheaply",
    who: "Outside LP",
    story: "Deposit for a tenth of the vault and see what it costs: there is no share price to game.",
    rule: "Shares",
    test: "test_13_2_10_noCheapShares",
    async run(k, f) {
      await advance(k.ctx, 86_400);
      const v = await view(k, f.vault);
      await fund(k, "lp", v);
      const o = await attempt(k, "lp", "Deposit for a tenth of the shares", f.vault, "deposit", depositArgs, { value: parseEther("50") });
      const [a0, a1] = (o.value ?? [0n, 0n]) as readonly [bigint, bigint];
      const q = v.quoteIs0 ? eth(a0) : eth(a1);
      const t = v.quoteIs0 ? eth(a1) : eth(a0);
      const fq = q / (v.principal.quote + v.idle.quote);
      const ft = t / (v.principal.token + v.idle.token);
      k.record(note("lp", "What a tenth of the shares cost", `${(fq * 100).toFixed(3)}% of the quote and ${(ft * 100).toFixed(3)}% of the tokens`));
      return { blocked: o.ok && Math.abs(fq - 0.1) < 1e-4 && Math.abs(ft - 0.1) < 1e-4, summary: "A tenth of the shares costs exactly a tenth of every range" };
    },
  },
  {
    id: "lp-exit",
    title: "An LP exit hurts holders",
    who: "Outside LP",
    story: "Join, then leave, and check whether the remaining holders or the support paid for it.",
    rule: "Shares",
    test: "test_13_2_11_lpExitLeavesHoldersWhole",
    async run(k, f) {
      await advance(k.ctx, 86_400);
      let v = await view(k, f.vault);
      await fund(k, "lp", v);
      await attempt(k, "lp", "Deposit", f.vault, "deposit", depositArgs, { value: parseEther("50") });
      v = await view(k, f.vault);
      const before = v.support.have;
      await attempt(k, "lp", "Withdraw everything", f.vault, "withdraw", [TENTH, 0n, 0n, NEVER]);
      const after = await view(k, f.vault);
      k.record(note("anyone", "After the exit", `Support ${before} → ${after.support.have} bps. Issuer principal still ${(eth(after.raw.principalShares) * 100).toFixed(0)}%`));
      return { blocked: after.support.have === before && after.raw.principalShares === ONE, summary: "A proportional exit leaves the shape and the issuer untouched" };
    },
  },
  {
    id: "big-dump",
    title: "Drain the support with a big dump",
    who: "Attacker",
    story: "Sell 20 tokens into the vault's bids and see where the vault's value goes.",
    rule: "Conservation",
    test: "test_13_2_12_dumpIsAbsorbedNotLeaked",
    async run(k, f) {
      const v = await view(k, f.vault);
      const ethBefore = await k.ctx.pub.getBalance({ address: f.vault });
      const tokBefore = await k.ctx.pub.readContract({ address: v.token, abi: testTokenAbi, functionName: "balanceOf", args: [f.vault] });
      const o = await swap(k.ctx, v, "attacker", false, parseEther("20"));
      k.record(beatOf(o, "attacker", "Dump 20 tokens"));
      const after = await view(k, f.vault);
      const ethAfter = await k.ctx.pub.getBalance({ address: f.vault });
      const tokAfter = await k.ctx.pub.readContract({ address: v.token, abi: testTokenAbi, functionName: "balanceOf", args: [f.vault] });
      k.record(note("anyone", "The vault's bids bought the dump", `Quote in the pool ${v.principal.quote.toFixed(2)} → ${after.principal.quote.toFixed(2)}, tokens ${v.principal.token.toFixed(2)} → ${after.principal.token.toFixed(2)}`));
      return { blocked: ethAfter === ethBefore && tokAfter === tokBefore && after.principal.token > v.principal.token, summary: "Absorbed inside the pool: nothing left the vault" };
    },
  },
  {
    id: "issuer-exit",
    title: "Issuer exits early",
    who: "Issuer",
    story: "The team tries to take its principal out before the unlock date.",
    rule: "Lock",
    test: "test_13_2_13_issuerCannotExitEarly",
    async run(k, f) {
      const o = await attempt(k, "issuer", "Withdraw all principal on day 0", f.vault, "withdrawPrincipal", [ONE, 0n, 0n, NEVER]);
      return { blocked: !o.ok, summary: "Nothing vests before the lock ends" };
    },
  },
  {
    id: "outsider",
    title: "Remove the vault's liquidity directly",
    who: "Attacker",
    story: "Skip the vault and call the PoolManager through a router, asking to remove one of the vault's ranges.",
    rule: "Access",
    test: "test_13_2_14_outsiderCannotTouchVaultPositions",
    async run(k, f) {
      const router = k.ctx.net.manifest.liquidityRouter;
      if (!router) throw new Error("no liquidity router on this chain: restart it with `make chain`");
      const v = await view(k, f.vault);
      const r = v.ranges[0];
      const before = await positionLiquidity(k.ctx, v.poolId, f.vault, r.tickLower, r.tickUpper);
      const o = await send(k.ctx, "attacker", {
        address: router,
        abi: liquidityRouterAbi,
        functionName: "modifyLiquidity",
        args: [v.key, { tickLower: r.tickLower, tickUpper: r.tickUpper, liquidityDelta: -r.liquidity, salt: zeroHash }, "0x"],
      });
      k.record(beatOf(o, "attacker", "modifyLiquidity on the vault's range, through a router"));
      const after = await positionLiquidity(k.ctx, v.poolId, f.vault, r.tickLower, r.tickUpper);
      k.record(note("anyone", "The vault's position in the PoolManager", `${eth(before)} → ${eth(after)} liquidity (×1e18): untouched`));
      return { blocked: !o.ok && after === before && after === r.liquidity, summary: "Positions are keyed to their owner: the vault's are out of reach" };
    },
  },
  {
    id: "pump-quick",
    title: "Pump-ratchet, quick",
    who: "Attacker",
    story: "The drain that took 82% of the prototype's quote: buy the asks, push the price 30,000 ticks through empty ticks, hold it, call restore to drag the vault's bids up under it, sell back.",
    rule: "Anchor",
    test: "test_pumpRatchet_quickPumpFindsNothingToRestore",
    async run(k, f) {
      const ethBefore = await k.ctx.pub.getBalance({ address: k.ctx.address("attacker") });
      const bought = await pumpThroughTheAsks(k, f, 30_000);
      await advance(k.ctx, 2 * 3600);
      const v = await view(k, f.vault);
      k.record(note("anyone", "Two hours later the TWAP has followed the pump", `Support is still ${(v.support.have / 100).toFixed(1)}%: the filled asks are quote just under the old price, and count`));
      const o = await attempt(k, "attacker", "Call restore to drag the bids up", f.vault, "restore", [quoteRangesUnderSpot(v), NEVER]);
      await sellBack(k, f, bought);
      const pnl = eth((await k.ctx.pub.getBalance({ address: k.ctx.address("attacker") })) - ethBefore);
      k.record(note("attacker", `Attacker P&L: ${signed(pnl)} ETH`, "The swap fees stay with the vault"));
      return { blocked: !o.ok && pnl < 0, summary: `Nothing to restore. The attacker ends ${signed(pnl)} ETH` };
    },
  },
  {
    id: "pump-patient",
    title: "Pump-ratchet, held for four days",
    who: "Attacker",
    story: "The same pump, held for four days while the Anchor is synced every 30 minutes, until the band floats above the filled asks and support reads as lapsed. Then restore.",
    rule: "Anchor",
    test: "test_pumpRatchet_patientPumpCannotPullRestoreAboveWhereTheVaultSold",
    slow: true,
    async run(k, f) {
      const ethBefore = await k.ctx.pub.getBalance({ address: k.ctx.address("attacker") });
      const bought = await pumpThroughTheAsks(k, f, 30_000);
      const v0 = await view(k, f.vault);
      const step = v0.terms.twapWindow;
      for (let t = 0, i = 0; t < 4 * 86_400; t += step, i++) {
        if (i % 16 === 0) k.progress(`Holding the pump: day ${(t / 86_400).toFixed(1)} of 4`);
        await advance(k.ctx, step);
        must(await send(k.ctx, "keeper", { address: f.vault, abi: covenantVaultAbi, functionName: "poke", args: [] }), "poke");
      }
      const v = await view(k, f.vault);
      k.record(note("anyone", "Four days, synced every 30 minutes", `The Anchor climbed ${v.anchor - f.seedPrice} ticks. Support now reads ${(v.support.have / 100).toFixed(1)}%`));
      const o = await attempt(k, "attacker", "Call restore to drag the bids up", f.vault, "restore", [quoteRangesUnderSpot(v), NEVER]);
      await sellBack(k, f, bought);
      const pnl = eth((await k.ctx.pub.getBalance({ address: k.ctx.address("attacker") })) - ethBefore);
      k.record(note("attacker", `Attacker P&L: ${signed(pnl)} ETH`, "Restore never bids above where the vault has sold"));
      return { blocked: !o.ok && o.error?.name === "RestoreBandEmpty" && pnl < 0, summary: `Restore refuses to chase the pump. The attacker ends ${signed(pnl)} ETH` };
    },
  },
  {
    id: "colluding-curator",
    title: "A curator chases a pump",
    who: "Curator and attacker",
    story: "An accomplice pumps the price through empty ticks and holds it; the curator then moves the vault's bids up under the fake price.",
    rule: "Anchor",
    test: "test_new_colludingCuratorIsHeldToTheAnchor",
    async run(k, f) {
      await pumpThroughTheAsks(k, f, 15_000);
      let v = await view(k, f.vault);
      await settleTwap(k, v);
      v = await view(k, f.vault);
      const p = v.spotTick;
      const o = await attempt(k, "curator", "Bid just under the pumped price", f.vault, "reshape", [[cut(indexOfLeg(v, f, 3))], [bidLeg(v, p - 900, p - 120, SINK)], NEVER]);
      return { blocked: !o.ok, summary: "No bid above the Anchor plus the guard, and the Anchor climbs a band a day at most" };
    },
  },
  {
    id: "freeze-exits",
    title: "Freeze withdrawals",
    who: "Attacker",
    story: "Hold spot far from the average so that every guarded action is refused, including, the attacker hopes, LP exits.",
    rule: "Guard",
    test: "test_new_exitsCannotBeFrozen",
    async run(k, f) {
      await advance(k.ctx, 86_400);
      let v = await view(k, f.vault);
      await fund(k, "lp", v);
      await attempt(k, "lp", "Deposit", f.vault, "deposit", depositArgs, { value: parseEther("50") });
      const d = await pushTo(k.ctx, v, "attacker", v.spotTick - 2500, BIG);
      k.record(beatOf(d, "attacker", "Hold spot 2,500 ticks below the average"));
      v = await view(k, f.vault);
      k.record(note("anyone", v.guard.ok ? "The guard still passes" : "The guard is tripped", `Spot is ${Math.round(v.guard.diff)} ticks from the TWAP`));
      const o = await attempt(k, "lp", "Withdraw anyway", f.vault, "withdraw", [TENTH, 0n, 0n, NEVER], { detail: () => "Exits are never guarded: a proportional burn cannot be priced wrong" });
      return { blocked: o.ok && !v.guard.ok, summary: "The LP leaves while the guard is tripped" };
    },
  },
  {
    id: "dust-restore",
    title: "Restore dust for the bounty",
    who: "Keeper",
    story: "After a crash strands the reserve, restore it and check that the bounty is capped by how much quote actually moved.",
    rule: "Restore",
    test: "test_new_dustRestorePaysDust",
    async run(k, f) {
      let v = await view(k, f.vault);
      const d = await pushTo(k.ctx, v, "attacker", v.spotTick - 3000, BIG);
      k.record(beatOf(d, "attacker", "Dump 3,000 ticks and hold"));
      await settleTwap(k, v);
      v = await view(k, f.vault);
      const before = await k.ctx.pub.getBalance({ address: k.ctx.address("keeper") });
      const o = await attempt(k, "keeper", `Restore with support at ${(v.support.have / 100).toFixed(1)}%`, f.vault, "restore", [quoteRangesBelowTheBand(v), NEVER]);
      const paid = eth((await k.ctx.pub.getBalance({ address: k.ctx.address("keeper") })) - before);
      const cap = eth(v.terms.bounty);
      k.record(note("keeper", `Bounty paid: ${paid.toFixed(4)} ETH`, `Never more than ${cap} ETH, and never more than 1% of the quote moved`));
      return { blocked: o.ok && paid > 0 && paid <= cap, summary: "The bounty is capped, so dust earns dust" };
    },
  },
  {
    id: "vault-pays",
    title: "Make the vault pay for a deposit",
    who: "Outside LP",
    story: "Deposit with far too little ETH attached, hoping the vault covers the difference from its own balance.",
    rule: "Conservation",
    test: "test_new_depositCannotBeFundedByTheVault",
    async run(k, f) {
      await advance(k.ctx, 86_400);
      const v = await view(k, f.vault);
      await fund(k, "lp", v);
      const o = await attempt(k, "lp", "Deposit for 10% with 1 ETH attached", f.vault, "deposit", depositArgs, { value: ONE });
      return { blocked: !o.ok, summary: "The vault never pays for a depositor" };
    },
  },
];

export interface AttackRun extends AttackOutcome {
  beats: ReturnType<typeof collectingKit>["beats"];
}

/**
 * Run `attacks` against one fresh fixture, each in its own sandbox, then put the chain back exactly as it was. Results
 * arrive one by one through `onResult`.
 */
export async function runAttacks(ctx: ChainCtx, attacks: Attack[], onResult: (id: string, r: AttackRun) => void, progress: (label: string) => void = () => {}) {
  await sandbox(ctx, async () => {
    progress("Launching a fresh vault for the attack lab");
    const f = await attackFixture(ctx);
    for (const a of attacks) {
      progress(`Attempting: ${a.title}`);
      const kit = collectingKit(ctx, progress);
      const r = await sandbox(ctx, () => a.run(kit, f)).catch((e: unknown) => ({ blocked: false, summary: `The script failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` }));
      onResult(a.id, { ...r, beats: kit.beats });
    }
  });
}

