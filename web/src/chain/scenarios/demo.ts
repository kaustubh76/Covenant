// The guided demo (docs/SPEC.md §18) on the real contracts: test/integration/LaunchToRelease.t.sol step by step, with
// step 7 as the crash-and-restore of test_demo_restoreAfterACrash. Every step is real transactions on the local chain.

import { type Address, formatEther, parseEther } from "viem";
import { ccaAbi, covenantLensAbi, covenantVaultAbi, seedPlannerAbi } from "../abi.generated";
import { shortAddress } from "../accounts";
import { note } from "../beat";
import { type Launch, NEVER, adopt, auctionPrice, bid, closeAuction, defaultLaunchSpec, migrate, registerLaunch, seed } from "../launch";
import { pushTo, spotOf, swap } from "../market";
import { SINK, bidLeg, cut, deepenReserve } from "../plans";
import { priceAt, q96ToNumber } from "../price";
import { PRESETS } from "../terms";
import { advance, mineTo, sandbox } from "../time";
import { type VaultView } from "../view";
import { type Kit, attempt, fund, settleTwap, ticksAsDrop, view } from "./kit";
import { crash, findLapsingCrash, planRestore, restoreCall } from "./restore";

export interface DemoBid {
  id: string;
  bidder: "alice" | "bob";
  /** Price levels above the 1.0 floor, in 1/64ths (UniswapStack._price). */
  steps: number;
  amount: number;
}
/** The suite's default auction: two losing bids and a winner that clears the whole supply. */
export const DEMO_BIDS: DemoBid[] = [
  { id: "b1", bidder: "bob", steps: 1, amount: 300 },
  { id: "b2", bidder: "bob", steps: 3, amount: 300 },
  { id: "b3", bidder: "alice", steps: 19, amount: 1400 },
];
export const bidPrice = (b: DemoBid) => 1 + b.steps / 64;

export interface DemoState {
  launch: Launch | null;
  vault: Address | null;
  clearing?: number;
  raised?: number;
  seedPrice?: number;
  supportAtMigration?: number;
  fullRangeImpact?: number;
  managedImpact?: number;
}
export const emptyDemo = (): DemoState => ({ launch: null, vault: null });

export interface DemoStep {
  n: number;
  title: string;
  verb: string;
  say: string;
  view: "auction" | "vault" | "compare";
  run(k: Kit, s: DemoState): Promise<void>;
}

export const DUMP_SIZE = 5;

const pct = (bps: number | bigint) => `${(Number(bps) / 100).toFixed(1)}%`;
const amt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3));
const eth = (x: unknown) => Number(formatEther((x as bigint) ?? 0n));

function need(s: DemoState) {
  if (!s.launch || !s.vault) throw new Error("run the demo steps in order");
  return { launch: s.launch, vault: s.vault };
}

async function supportOf(k: Kit, vault: Address) {
  const [have, req] = await k.ctx.pub.readContract({ address: vault, abi: covenantVaultAbi, functionName: "support" });
  return { have: Number(have), need: Number(req) };
}

/** Sell `tokens` into the pool in a sandbox and measure how far the price falls, in ticks. */
async function impactOfDump(k: Kit, v: VaultView, tokens: number): Promise<number> {
  return sandbox(k.ctx, async () => {
    const before = await spotOf(k.ctx, v);
    await swap(k.ctx, v, "attacker", false, parseEther(String(tokens)));
    return before - (await spotOf(k.ctx, v));
  });
}

const rangeWithMostQuote = (v: VaultView) => [...v.ranges].sort((a, b) => b.quote - a.quote)[0]?.index ?? 0;


export const DEMO_STEPS: DemoStep[] = [
  {
    n: 1,
    title: "Launch",
    verb: "Run the auction",
    say: "The issuer creates the Covenant vault first and registers the launch with Uniswap's LBPStrategy, naming the vault as LP recipient. Bidders can check that on-chain before they bid. Then the Continuous Clearing Auction runs.",
    view: "auction",
    async run(k, s) {
      const launch = await registerLaunch(k.ctx, defaultLaunchSpec(PRESETS.standard, { name: "Demo Launch", symbol: "TOKEN" }));
      s.launch = launch;
      s.vault = launch.vault;
      k.record([
        note("issuer", "Vault created before the auction", `Standard terms: 40% support, 50% pace, 90-day lock. Vault ${shortAddress(launch.vault)}`),
        note("issuer", "Launch registered with Uniswap's LBPStrategy", "The CCA opens. Every LP position the launcher mints will go to the vault"),
      ]);
      const m = k.ctx.net.manifest;
      const check = await k.ctx.pub.readContract({ address: m.lens, abi: covenantLensAbi, functionName: "verifyLaunch", args: [m.factory, m.lbpStrategy, launch.auction] });
      k.record({
        actor: "anyone",
        title: "A bidder verifies the covenant on-chain",
        ok: check.ok,
        detail: check.ok ? "LP goes to a Covenant vault bound to this pool, terms readable before the first bid" : undefined,
        error: check.ok ? undefined : { name: "LaunchCheck", args: [], signature: "verifyLaunch: not ok", rule: "Terms", reason: "The launch does not commit its liquidity to this vault." },
      });
      await mineTo(k.ctx, launch.startBlock - 1n);
      for (const b of DEMO_BIDS) {
        const o = await bid(k.ctx, launch, b.bidder, auctionPrice(b.steps), parseEther(String(b.amount)));
        k.record({ actor: b.bidder, title: `${b.bidder === "bob" ? "Bob" : "Alice"} bids ${b.amount} ETH up to ${bidPrice(b).toFixed(4)}`, ok: o.ok, error: o.error, hash: o.hash });
      }
    },
  },
  {
    n: 2,
    title: "Migrate",
    verb: "Migrate to the pool",
    say: "The auction closes. Anyone migrates through Uniswap's stock strategy: it creates the v4 pool at the clearing price through the Covenant hook and mints the LP position to the vault. Anyone can then hand it to the vault to manage.",
    view: "vault",
    async run(k, s) {
      const { launch, vault } = need(s);
      await closeAuction(k.ctx, launch);
      const [clearing, raised] = await Promise.all([
        k.ctx.pub.readContract({ address: launch.auction, abi: ccaAbi, functionName: "clearingPrice" }),
        k.ctx.pub.readContract({ address: launch.auction, abi: ccaAbi, functionName: "currencyRaised" }),
      ]);
      s.clearing = q96ToNumber(clearing);
      s.raised = eth(raised);
      k.record([
        note("anyone", `Auction clears at ${s.clearing.toFixed(4)} ETH`, `${amt(s.raised)} ETH raised. Bob's bids were outbid; their demand stays on-chain`),
      ]);
      const ids = await migrate(k.ctx, launch);
      k.record(note("anyone", "Pool created at the clearing price, through the Covenant hook", `LP position #${ids[0]} minted to the vault`));
      const o = await adopt(k.ctx, launch);
      const v = await view(k, vault);
      s.seedPrice = v.spotTick;
      s.supportAtMigration = v.support.have;
      k.record([
        { actor: "anyone", title: "The vault adopts the launch liquidity", ok: o.ok, error: o.error, hash: o.hash, detail: `${amt(v.principal.quote)} ETH and ${amt(v.principal.token)} tokens, full range` },
        note("issuer", "Issuer receives principal shares", "Locked for 90 days from now, then vesting over 30"),
        note("anyone", `Support is ${pct(v.support.have)}`, "Full-range liquidity is spread too thin to meet a 40% covenant"),
      ]);
    },
  },
  {
    n: 3,
    title: "Seed",
    verb: "Seed from demand",
    say: "The curator's first reshape reads the auction's outbid bids, which the CCA keeps on-chain, and places support where those buyers said they would buy.",
    view: "vault",
    async run(k, s) {
      const { launch, vault } = need(s);
      const v = await view(k, vault);
      s.fullRangeImpact = await impactOfDump(k, v, DUMP_SIZE);
      const levels = await k.ctx.pub.readContract({ address: k.ctx.net.manifest.seedPlanner, abi: seedPlannerAbi, functionName: "outbidDemand", args: [launch.auction, true] });
      const before = await supportOf(k, vault);
      const o = await seed(k.ctx, launch);
      const after = await view(k, vault);
      k.record([
        note("curator", `SeedPlanner reads ${levels.length} outbid demand levels from the CCA`, levels.map((l) => `${amt(Number(l.demand) / 2 ** 96 / 1e18)} ETH at ${priceAt(l.priceTick).toFixed(4)}`).join(" · ")),
        { actor: "curator", title: "Demand-shaped seed", ok: o.ok, error: o.error, hash: o.hash, detail: `Support ${pct(before.have)} → ${pct(after.support.have)} across ${after.ranges.length} ranges. Principal conserved` },
      ]);
    },
  },
  {
    n: 4,
    title: "Depth",
    verb: "Sell into both layouts",
    say: "Sell the same tokens into the launcher's full-range position and into the Covenant layout. Same assets, same price, very different outcome.",
    view: "compare",
    async run(k, s) {
      const { vault } = need(s);
      const v = await view(k, vault);
      s.managedImpact = await impactOfDump(k, v, DUMP_SIZE);
      const full = s.fullRangeImpact ?? 0;
      const managed = s.managedImpact;
      k.record([
        note("market", `Sell ${DUMP_SIZE} tokens into the full-range position`, `Price falls ${Math.round(full)} ticks (${ticksAsDrop(full)})`),
        note("market", `Sell ${DUMP_SIZE} tokens into the Covenant layout`, `Price falls ${Math.round(managed)} ticks (${ticksAsDrop(managed)})`),
        note("anyone", `${(full / Math.max(managed, 1e-9)).toFixed(1)}× less price impact`, "Both measured on the real pool, in a sandbox, so nothing was traded"),
      ]);
    },
  },
  {
    n: 5,
    title: "Three rug attempts",
    verb: "Try to rug",
    say: "The curator turns hostile and tries three ways out: withdraw, keep a slice during a reshape, and move support where it can never trade.",
    view: "vault",
    async run(k, s) {
      const { vault } = need(s);
      const v = await view(k, vault);
      const p = s.seedPrice ?? v.spotTick;
      const lift = [cut(rangeWithMostQuote(v))];
      await attempt(k, "curator", "Withdraw the liquidity", vault, "withdraw", [1n, 0n, 0n, NEVER]);
      await attempt(k, "curator", "Reshape, re-adding only 90%", vault, "reshape", [lift, [bidLeg(v, p - 1440, p - 180, 9000)], NEVER]);
      await attempt(k, "curator", "Move all support far below the price", vault, "reshape", [lift, [bidLeg(v, p - 12_000, p - 9_000, SINK)], NEVER]);
    },
  },
  {
    n: 6,
    title: "Manipulation",
    verb: "Push the price",
    say: "An attacker dumps to move spot, then the curator and an LP try to act on that price straight away. The guard refuses until the price has held for the window.",
    view: "vault",
    async run(k, s) {
      const { vault } = need(s);
      await advance(k.ctx, 86_400);
      k.record(note("anyone", "A day passes", "The setup epoch is over: Pace applies and deposits are open"));
      let v = await view(k, vault);
      await fund(k, "lp", v);
      const before = v.spotTick;
      const dump = await pushTo(k.ctx, v, "attacker", v.spotTick - 1000, parseEther("100000"));
      v = await view(k, vault);
      k.record({ actor: "attacker", title: "Attacker dumps the token", ok: dump.ok, error: dump.error, hash: dump.hash, detail: `Spot falls ${before - v.spotTick} ticks (${ticksAsDrop(before - v.spotTick)})` });
      await attempt(k, "curator", "Reshape around the new spot", vault, "reshape", [[cut(0, 1n)], [], NEVER]);
      await attempt(k, "lp", "Deposit at the manipulated price", vault, "deposit", [10n ** 17n, 2n ** 256n - 1n, 2n ** 256n - 1n, NEVER], { value: parseEther("50") });
      await settleTwap(k, v);
      k.record(note("anyone", `The price holds for ${Math.round((v.terms.twapWindow + 3600) / 60)} minutes`, "The time-weighted price catches up with spot"));
      await attempt(k, "curator", "Act on the settled price", vault, "reshape", [[cut(0, 1n)], [], NEVER], {
        detail: () => "Accepted: once a move persists, it is the market",
      });
    },
  },
  {
    n: 7,
    title: "Restore",
    verb: "Crash and restore",
    say: "The curator keeps half the reserve deep below the price. A sell-off that holds drags the support band down past it and strands that quote under the band. Any address can put it back, and collect the bounty.",
    view: "vault",
    async run(k, s) {
      const { vault } = need(s);
      await attempt(k, "issuer", "Fund the bounty pool", vault, "fundBounty", [parseEther("0.1")], { value: parseEther("0.1"), detail: () => "0.1 ETH" });
      let v = await view(k, vault);
      const deepen = deepenReserve(v);
      await attempt(k, "curator", "Spread half the reserve four bands deep", vault, "reshape", [deepen.cuts, deepen.legs, NEVER], {
        detail: () => "Within Pace, and support stays above the covenant",
      });
      v = await view(k, vault);
      k.progress("Finding a sell-off that strands support");
      const depth = await findLapsingCrash(k.ctx, v);
      if (depth === null) {
        k.record({ actor: "market", title: "No sell-off strands this layout", ok: false, error: { name: "Error", args: [], signature: "no lapsing crash", rule: "Other", reason: "Every bid is within reach of the price." } });
        return;
      }
      const sold = await crash(k.ctx, v, depth);
      const lapsed = await view(k, vault);
      k.record([
        { actor: "market", title: `The market sells the token down ${ticksAsDrop(depth)}`, ok: sold.ok, error: sold.error, hash: sold.hash, detail: `And it holds for ${Math.round((v.terms.twapWindow + 3600) / 60)} minutes` },
        note("anyone", `Support has lapsed to ${pct(lapsed.support.have)}`, `Below the ${pct(lapsed.support.need)} minimum: the deep reserve now sits under the band`),
      ]);
      const plan = await planRestore(k.ctx, lapsed, "holder");
      const indices = [...(plan?.indices ?? [])].sort((a, b) => a - b);
      const o = await attempt(k, "holder", "A stranger calls restore", vault, "restore", restoreCall(lapsed, indices).args);
      if (o.ok) {
        const after = await view(k, vault);
        k.record(note("holder", `Support ${pct(lapsed.support.have)} → ${pct(after.support.have)}`, `Bounty paid from the pool: ${amt(lapsed.fees.bountyPool - after.fees.bountyPool)} ETH`));
      }
    },
  },
  {
    n: 8,
    title: "Outside LP",
    verb: "Deposit and withdraw",
    say: "Anyone can add liquidity beside the issuer's. Shares are in kind: you pay exactly your slice of every range, and take exactly that back.",
    view: "vault",
    async run(k, s) {
      const { vault } = need(s);
      const before = await supportOf(k, vault);
      const dep = await attempt(k, "lp", "Deposit for 10% new shares", vault, "deposit", [10n ** 17n, 2n ** 256n - 1n, 2n ** 256n - 1n, NEVER], {
        value: parseEther("500"),
        detail: (o) => {
          const [a0, a1] = (o.value ?? [0n, 0n]) as readonly [bigint, bigint];
          return `Pays ${amt(eth(a0))} ETH and ${amt(eth(a1))} tokens: exactly a tenth of every range`;
        },
      });
      await attempt(k, "lp", "Withdraw the same shares", vault, "withdraw", [10n ** 17n, 0n, 0n, NEVER], {
        detail: (o) => {
          const [a0, a1] = (o.value ?? [0n, 0n]) as readonly [bigint, bigint];
          return `Receives ${amt(eth(a0))} ETH and ${amt(eth(a1))} tokens`;
        },
      });
      const after = await supportOf(k, vault);
      const principal = await k.ctx.pub.readContract({ address: vault, abi: covenantVaultAbi, functionName: "principalShares" });
      if (dep.ok) k.record(note("anyone", "The issuer's position is untouched", `Principal shares still ${(eth(principal) * 100).toFixed(0)}% of the original. Support ${pct(before.have)} → ${pct(after.have)}`));
    },
  },
  {
    n: 9,
    title: "Curator change",
    verb: "Replace the curator",
    say: "The issuer can replace the curator, but only through a timelock. And a new curator inherits every rule the old one was bound by.",
    view: "vault",
    async run(k, s) {
      const { vault } = need(s);
      await attempt(k, "issuer", "Propose a new curator", vault, "proposeCurator", [k.ctx.address("newCurator")], { detail: () => "The 2-day timelock starts" });
      await attempt(k, "keeper", "Accept immediately", vault, "acceptCurator", []);
      await advance(k.ctx, 2 * 86_400);
      k.record(note("anyone", "Two days pass", "Holders had the whole timelock to react"));
      await attempt(k, "keeper", "Accept after the timelock", vault, "acceptCurator", [], { detail: () => "New curator in place" });
      const v = await view(k, vault);
      await attempt(k, "newCurator", "New curator moves support far away", vault, "reshape", [[cut(rangeWithMostQuote(v))], [bidLeg(v, v.spotTick - 14_000, v.spotTick - 11_000, SINK)], NEVER]);
    },
  },
  {
    n: 10,
    title: "Release",
    verb: "Jump past the unlock",
    say: "After the lock, the issuer's principal vests in a straight line, to the treasury. Halfway through vesting, about half can leave. Not a share more.",
    view: "vault",
    async run(k, s) {
      const { vault } = need(s);
      await attempt(k, "issuer", "Withdraw principal before the unlock", vault, "withdrawPrincipal", [1n, 0n, 0n, NEVER]);
      await advance(k.ctx, (90 + 15) * 86_400);
      const withdrawable = await k.ctx.pub.readContract({ address: vault, abi: covenantVaultAbi, functionName: "principalWithdrawable" });
      k.record(note("anyone", "105 days pass", `${(eth(withdrawable) * 100).toFixed(1)}% of the principal has vested`));
      await attempt(k, "issuer", "Withdraw everything vested", vault, "withdrawPrincipal", [withdrawable, 0n, 0n, NEVER], {
        detail: (o) => {
          const [a0, a1] = (o.value ?? [0n, 0n]) as readonly [bigint, bigint];
          return `${amt(eth(a0))} ETH and ${amt(eth(a1))} tokens to the treasury`;
        },
      });
      await attempt(k, "issuer", "Withdraw another 1%", vault, "withdrawPrincipal", [10n ** 16n, 0n, 0n, NEVER]);
    },
  },
];

