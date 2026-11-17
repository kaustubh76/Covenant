"use client";

import clsx from "clsx";
import { Check, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatEther, parseEther } from "viem";
import { ccaAbi, covenantLensAbi, covenantVaultAbi, seedPlannerAbi } from "@/chain/abi.generated";
import { shortAddress } from "@/chain/accounts";
import { beatOf, note } from "@/chain/beat";
import {
  AUCTION_FLOOR,
  AUCTION_TICK,
  type AuctionGrid,
  type Launch,
  type OnWait,
  TESTNET_PRICE_SHIFT,
  adopt,
  bid,
  closeAuction,
  defaultLaunchSpec,
  migrate,
  registerLaunch,
  seed,
  seedParamsFor,
  testnetLaunchSpec,
} from "@/chain/launch";
import { priceAt, q96ToNumber, snapToAuctionTick, ticksToPct } from "@/chain/price";
import { PRESETS, PRESET_INFO, type PresetKey, type Terms, termsProblems } from "@/chain/terms";
import { reach } from "@/chain/time";
import { NeedsChain } from "@/components/chain/NeedsChain";
import { DemandCurve } from "@/components/covenant/DemandCurve";
import { RuleRail } from "@/components/covenant/RuleRail";
import { ShapeChart, ShapeLegend } from "@/components/covenant/ShapeChart";
import { TermsCard } from "@/components/covenant/TermsCard";
import { Button, PageHeader, Panel, Row, Slider, Tag } from "@/components/ui";
import { amt, duration, pct, price as priceText } from "@/lib/format";
import { useChain } from "@/store/chain";

const DAY = 86_400;
const HOUR = 3_600;

interface DraftBid {
  id: string;
  bidder: "alice" | "bob";
  price: number;
  amount: number;
}
/** The suite's bids at a launch's scale: prices from its floor, amounts times `scale` (1 locally, 1/8192 on a testnet). */
const draftBids = (floorEth: number, scale: number): DraftBid[] => [
  { id: "b1", bidder: "bob", price: floorEth * (1 + 1 / 64), amount: 300 * scale },
  { id: "b2", bidder: "bob", price: floorEth * (1 + 3 / 64), amount: 300 * scale },
  { id: "b3", bidder: "alice", price: floorEth * (1 + 19 / 64), amount: 1400 * scale },
];
const LOCAL_GRID: AuctionGrid = { floorPrice: AUCTION_FLOOR, auctionTick: AUCTION_TICK };
/** A public chain's launch (testnetLaunchSpec): every price and bid divided by 2^13, so faucet ETH is enough. */
const TESTNET_GRID: AuctionGrid = { floorPrice: AUCTION_FLOOR >> BigInt(TESTNET_PRICE_SHIFT), auctionTick: AUCTION_TICK >> BigInt(TESTNET_PRICE_SHIFT) };
const wei = (eth: number) => parseEther(eth.toFixed(18));

type Check = { ok: boolean; isCovenantVault: boolean; hookIsCovenant: boolean; poolMatchesVault: boolean; lpGoesToVault: boolean; vaultIsFresh: boolean; tokensReservedForLp: bigint };
type Phase = "terms" | "bidding" | "bid" | "closed" | "migrated" | "seeded";

function StepHead({ n, title, state }: { n: number; title: string; state: "done" | "now" | "todo" }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span
        className={clsx(
          "num grid h-7 w-7 place-items-center rounded-full border text-[13px]",
          state === "done" && "border-pass/50 text-pass",
          state === "now" && "border-ink bg-ink text-bg",
          state === "todo" && "border-line-strong text-faint",
        )}
      >
        {n}
      </span>
      <h2 className={clsx("display text-[28px] leading-none", state === "todo" ? "text-faint" : "text-ink")}>{title}</h2>
    </div>
  );
}

function CheckRow({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5 text-[13.5px]">
      <span className={clsx("mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full", ok ? "bg-pass/15 text-pass" : "bg-breach/15 text-breach")}>
        {ok ? <Check size={12} strokeWidth={2.5} /> : <X size={12} strokeWidth={2.5} />}
      </span>
      <span className={ok ? "text-muted" : "text-breach"}>{children}</span>
    </li>
  );
}

export default function LaunchPage() {
  const status = useChain((s) => s.status);
  const view = useChain((s) => s.view);
  const vault = useChain((s) => s.vault);
  const run = useChain((s) => s.run);
  const busy = useChain((s) => s.busy);
  const selectVault = useChain((s) => s.selectVault);
  const setRole = useChain((s) => s.setRole);
  const net = useChain((s) => s.net);
  const wallet = useChain((s) => s.wallet);
  // A public chain runs the same launch in real time, at testnet scale, signed by the connected wallet.
  const isPublic = !!net && !net.caps.devChain;
  const grid = isPublic ? TESTNET_GRID : LOCAL_GRID;
  const floorEth = q96ToNumber(grid.floorPrice);
  const scale = isPublic ? 2 ** -TESTNET_PRICE_SHIFT : 1;
  const snap = (p: number) => q96ToNumber(snapToAuctionTick(p, grid.floorPrice, grid.auctionTick));
  const who = (b: DraftBid) => (isPublic ? "You" : b.bidder === "bob" ? "Bob" : "Alice");

  const [presetKey, setPresetKey] = useState<PresetKey | "">("standard");
  const [draft, setDraft] = useState<Terms>(PRESETS.standard);
  const [symbol, setSymbol] = useState("TOKEN");
  const [bids, setBids] = useState<DraftBid[]>(() => draftBids(1, 1));
  const [phase, setPhase] = useState<Phase>("terms");
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [result, setResult] = useState<{ clearing: number; raised: number; outbid: number } | null>(null);
  const [supportBefore, setSupportBefore] = useState<number | null>(null);
  // the bids follow the network's scale until they are placed
  useEffect(() => {
    if (phase === "terms") setBids(draftBids(floorEth, scale));
  }, [floorEth, scale, phase]);

  if (status !== "ready") return <NeedsChain what="the launch desk" />;

  const problems = termsProblems(draft, 60);
  const set = (k: keyof Terms, v: number) => {
    setPresetKey("");
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const editBid = (id: string, k: "price" | "amount", v: number) => setBids((b) => b.map((x) => (x.id === id ? { ...x, [k]: v } : x)));
  const opened = phase !== "terms";
  const placed = !["terms", "bidding"].includes(phase);
  const live = ["migrated", "seeded"].includes(phase);
  const ours = live && view && launch && vault?.toLowerCase() === launch.vault.toLowerCase() ? view : null;

  const commit = () =>
    run("Creating the vault and registering the launch", async (ctx, rec) => {
      const named = { name: `${symbol} Launch`, symbol };
      const l = await registerLaunch(ctx, isPublic ? testnetLaunchSpec(draft, named) : defaultLaunchSpec(draft, named));
      const m = ctx.net.manifest;
      const c = await ctx.pub.readContract({ address: m.lens, abi: covenantLensAbi, functionName: "verifyLaunch", args: [m.factory, m.lbpStrategy, l.auction] });
      rec.record(
        [
          note("issuer", "Vault created before the auction", `Terms fixed at creation. Vault ${shortAddress(l.vault)}`),
          note("issuer", "Launch registered with Uniswap's LBPStrategy", `The CCA opens. LP positions will be minted to ${shortAddress(l.vault)}`),
        ],
        { toast: true },
      );
      setLaunch(l);
      setCheck(c);
      setPhase("bidding");
    });

  const placeBids = () =>
    run("Placing bids", async (ctx, rec) => {
      if (!launch) return;
      await reach(ctx, launch.startBlock, (now, target) => rec.progress(`The auction opens in ${target - now} blocks`));
      for (const b of bids) {
        if (b.amount <= 0) continue;
        const o = await bid(ctx, launch, b.bidder, snapToAuctionTick(b.price, launch.floorPrice, launch.auctionTick), wei(b.amount));
        rec.record(beatOf(o, b.bidder, `${who(b)} ${isPublic ? "bid" : "bids"} ${amt(b.amount)} ETH up to ${priceText(snap(b.price))}`), { toast: !o.ok });
      }
      setPhase("bid");
    });

  const close = () =>
    run("Closing the auction", async (ctx, rec) => {
      if (!launch) return;
      const counting: OnWait = (now, target) => rec.progress(`The auction ends in ${target - now} blocks (about ${duration((Number(target - now) * ctx.net.caps.blockTimeMs) / 1000)})`);
      await closeAuction(ctx, launch, "deployer", counting);
      const [clearing, raised, levels] = await Promise.all([
        ctx.pub.readContract({ address: launch.auction, abi: ccaAbi, functionName: "clearingPrice" }),
        ctx.pub.readContract({ address: launch.auction, abi: ccaAbi, functionName: "currencyRaised" }),
        ctx.pub.readContract({ address: ctx.net.manifest.seedPlanner, abi: seedPlannerAbi, functionName: "outbidDemand", args: [launch.auction, true] }),
      ]);
      const r = { clearing: q96ToNumber(clearing), raised: Number(formatEther(raised)), outbid: levels.reduce((s, l) => s + Number(l.demand) / 2 ** 96 / 1e18, 0) };
      setResult(r);
      rec.record(note("anyone", `Auction clears at ${priceText(r.clearing)} ETH`, `${amt(r.raised)} ETH raised. ${amt(r.outbid)} ETH of outbid demand stays on-chain`), { toast: true });
      setPhase("closed");
    });

  const migrateAndAdopt = async () => {
    const vaultAddr = await run("Migrating into the pool", async (ctx, rec) => {
      if (!launch) return null;
      const ids = await migrate(ctx, launch, "deployer", (now, target) => rec.progress(`Migration opens in ${target - now} blocks`));
      rec.record(note("anyone", "Pool created at the clearing price, through the Covenant hook", `LP position #${ids[0]} minted to the vault`));
      const o = await adopt(ctx, launch);
      const [have] = await ctx.pub.readContract({ address: launch.vault, abi: covenantVaultAbi, functionName: "support" });
      setSupportBefore(Number(have));
      rec.record(beatOf(o, "anyone", "The vault adopts the launch liquidity", () => `Support starts at ${pct(Number(have))}`), { toast: true });
      if (o.ok) setPhase("migrated");
      return o.ok ? launch.vault : null;
    });
    if (vaultAddr) {
      await selectVault(vaultAddr);
      setRole("curator");
    }
  };

  const runSeed = () =>
    run("Demand-shaped seed", async (ctx, rec) => {
      if (!launch) return;
      const o = await seed(ctx, launch, "curator", seedParamsFor(draft));
      const [have] = await ctx.pub.readContract({ address: launch.vault, abi: covenantVaultAbi, functionName: "support" });
      rec.record(beatOf(o, "curator", "Demand-shaped seed", () => `Support ${pct(supportBefore ?? 0)} → ${pct(Number(have))}. Principal conserved`), { toast: true });
      if (o.ok) setPhase("seeded");
    });

  const curveBids = bids.map((b) => ({ id: b.id, bidder: b.bidder === "bob" ? "Bob" : "Alice", maxPrice: snap(b.price), amount: b.amount }));

  return (
    <>
      <PageHeader
        eyebrow="Issuer"
        title="Write the covenant before anyone bids."
        lead="The vault and its terms are created first and named as the launch's LP recipient, so every bidder can check on-chain what will happen to the liquidity their bids create. Then the auction's own outbid demand decides where support goes. Every step here is a real transaction."
      />

      {/* 1 — terms */}
      <section className="border-t border-line py-8">
        <StepHead n={1} title="Set the terms" state={opened ? "done" : "now"} />
        <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
          <Panel>
            <div className="grid gap-3 sm:grid-cols-3">
              {PRESET_INFO.map((p) => (
                <button
                  key={p.key}
                  disabled={opened}
                  onClick={() => {
                    setPresetKey(p.key);
                    setDraft(PRESETS[p.key]);
                  }}
                  aria-pressed={presetKey === p.key}
                  className={clsx("rounded-md border p-3 text-left transition-colors disabled:opacity-60", presetKey === p.key ? "border-ink bg-raised" : "border-line-strong hover:border-muted")}
                >
                  <div className="text-sm font-medium text-ink">{p.name}</div>
                  <div className="text-xs text-faint">{p.blurb}</div>
                  <div className="num mt-2 text-xs text-muted">
                    {pct(PRESETS[p.key].supportBps, 0)} support · {Math.round(PRESETS[p.key].lockDuration / DAY)}d lock
                  </div>
                </button>
              ))}
            </div>
            <fieldset disabled={opened} className="mt-6 grid gap-x-8 gap-y-5 disabled:opacity-60 sm:grid-cols-2">
              <Slider label="Support: minimum share of the quote in the band" value={draft.supportBps} min={2000} max={7000} step={500} onChange={(v) => set("supportBps", v)} display={pct(draft.supportBps, 0)} />
              <Slider label="Band: how far below the price counts" value={draft.supportBandTicks} min={600} max={3000} step={60} onChange={(v) => set("supportBandTicks", v)} display={`${ticksToPct(draft.supportBandTicks).toFixed(1)}%`} />
              <Slider label="Pace: most value moved per epoch" value={draft.paceBps} min={1000} max={10000} step={500} onChange={(v) => set("paceBps", v)} display={pct(draft.paceBps, 0)} />
              <Slider label="Epoch length" value={draft.epochLength / HOUR} min={6} max={72} step={6} onChange={(v) => set("epochLength", v * HOUR)} display={duration(draft.epochLength)} />
              <Slider label="Guard: allowed gap between spot and average" value={draft.guardTicks} min={100} max={800} step={50} onChange={(v) => set("guardTicks", v)} display={`${ticksToPct(draft.guardTicks).toFixed(1)}%`} />
              <Slider label="Averaging window" value={draft.twapWindow / 60} min={5} max={60} step={5} onChange={(v) => set("twapWindow", v * 60)} display={duration(draft.twapWindow)} />
              <Slider label="Lock on issuer principal" value={draft.lockDuration / DAY} min={30} max={365} step={15} onChange={(v) => set("lockDuration", v * DAY)} display={`${Math.round(draft.lockDuration / DAY)} days`} />
              <Slider label="Vesting after the lock" value={draft.vestDuration / DAY} min={0} max={180} step={15} onChange={(v) => set("vestDuration", v * DAY)} display={`${Math.round(draft.vestDuration / DAY)} days`} />
              <Slider label="Curator change timelock" value={draft.curatorTimelock / DAY} min={1} max={7} onChange={(v) => set("curatorTimelock", v * DAY)} display={duration(draft.curatorTimelock)} />
              <Slider label="Curator's share of swap fees" value={draft.curatorFeeBps} min={0} max={3000} step={250} onChange={(v) => set("curatorFeeBps", v)} display={pct(draft.curatorFeeBps, 1)} />
            </fieldset>
            {problems.length > 0 && (
              <ul className="mt-4 space-y-1 text-[13px] text-breach">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </Panel>
          <div>
            <TermsCard terms={draft} symbol={symbol} />
            {!opened && (
              <>
                <label className="mt-4 flex items-center gap-3 text-[13px] text-muted">
                  Token symbol
                  <input value={symbol} maxLength={8} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} className="num h-9 w-28 rounded-md border border-line-strong bg-transparent px-2 text-ink outline-none" />
                </label>
                <Button variant="primary" size="lg" className="mt-4 w-full" disabled={!!busy || problems.length > 0 || !symbol || (isPublic && !wallet)} onClick={() => void commit()}>
                  {isPublic && !wallet ? "Connect a wallet to launch" : "Create the vault and open the auction"}
                </Button>
                {isPublic && (
                  <p className="mt-2 text-center text-xs text-faint">
                    On {net?.name}: a fixed-supply token, prices at 1/8192 of the local launch and a 128-block auction, about {duration((128 * (net?.caps.blockTimeMs ?? 2000)) / 1000)}.
                    Your wallet signs each step.
                  </p>
                )}
                <p className="mt-2 text-center text-xs text-faint">The factory checks the same bounds on-chain and refuses anything else.</p>
              </>
            )}
          </div>
        </div>
      </section>

      {/* 2 — auction */}
      <section className={clsx("border-t border-line py-8", !opened && "opacity-50")}>
        <StepHead n={2} title="Run the auction" state={!opened ? "todo" : live ? "done" : "now"} />
        {opened && launch && (
          <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
            <div className="space-y-6">
              <Panel eyebrow={`1,000 tokens · floor ${priceText(floorEth)} ETH · auction ${shortAddress(launch.auction)}`} title="Bids by maximum price">
                <DemandCurve bids={curveBids} result={result ? { clearingPrice: result.clearing, floorPrice: floorEth } : null} />
              </Panel>
              {check && (
                <Panel eyebrow="Before bidding" title={check.ok ? "Bidders can verify the covenant on-chain" : "This launch does not verify"}>
                  <ul>
                    <CheckRow ok={check.isCovenantVault}>The LP recipient is a vault the Covenant factory created</CheckRow>
                    <CheckRow ok={check.hookIsCovenant}>The pool will be hooked by Covenant</CheckRow>
                    <CheckRow ok={check.poolMatchesVault}>The pool the launch commits to is exactly the one the vault is bound to</CheckRow>
                    <CheckRow ok={check.lpGoesToVault}>Every LP position the launcher mints goes to the vault</CheckRow>
                    <CheckRow ok={check.vaultIsFresh}>The vault holds nothing yet</CheckRow>
                  </ul>
                  <p className="mt-3 text-xs text-faint">From CovenantLens.verifyLaunch, one view call against the strategy, the factory and the vault. {amt(Number(formatEther(check.tokensReservedForLp)))} tokens are reserved for the pool.</p>
                </Panel>
              )}
            </div>
            <Panel eyebrow="Order book" title={placed ? "Bids placed" : "Scripted bidders"}>
              <ul className="space-y-3">
                {bids.map((b) => (
                  <li key={b.id} className="grid grid-cols-[48px_1.2fr_1fr] items-center gap-3 text-sm">
                    <span className="text-ink">{who(b)}</span>
                    <label className="flex items-center gap-2 rounded-md border border-line-strong px-2.5 py-1.5">
                      <span className="whitespace-nowrap text-xs text-faint">up to</span>
                      <input
                        disabled={placed}
                        type="number"
                        step={floorEth / 64}
                        min={floorEth}
                        value={Number(b.price.toPrecision(5))}
                        onChange={(e) => editBid(b.id, "price", Number(e.target.value) || floorEth)}
                        onBlur={() => editBid(b.id, "price", Math.max(floorEth * (1 + 1 / 64), snap(b.price)))}
                        className="num w-full bg-transparent text-right text-ink outline-none"
                        aria-label={`${b.bidder} max price`}
                      />
                    </label>
                    <label className="flex items-center gap-2 rounded-md border border-line-strong px-2.5 py-1.5">
                      <span className="text-xs text-faint">ETH</span>
                      <input
                        disabled={placed}
                        type="number"
                        step={50 * scale}
                        min={0}
                        value={Number(b.amount.toPrecision(6))}
                        onChange={(e) => editBid(b.id, "amount", Math.max(0, Number(e.target.value) || 0))}
                        className="num w-full bg-transparent text-right text-ink outline-none"
                        aria-label={`${b.bidder} amount`}
                      />
                    </label>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-faint">Prices snap to the auction&apos;s grid of 1/64 of the floor. Bids must be above the {priceText(floorEth)} ETH floor.</p>
              {result && (
                <div className="mt-5">
                  <Row label="Clearing price">{priceText(result.clearing)} ETH</Row>
                  <Row label="Raised">{amt(result.raised)} ETH</Row>
                  <Row label="To the pool (10% of the raise)">{amt(result.raised * 0.1)} ETH + 100 tokens</Row>
                  <Row label="Outbid demand left on-chain">{amt(result.outbid)} ETH</Row>
                </div>
              )}
              {phase === "bidding" && (
                <Button variant="primary" className="mt-5 w-full" disabled={!!busy} onClick={() => void placeBids()}>
                  Place the bids
                </Button>
              )}
              {phase === "bid" && (
                <Button variant="primary" className="mt-5 w-full" disabled={!!busy} onClick={() => void close()}>
                  Close the auction
                </Button>
              )}
              {phase === "closed" && (
                <Button variant="primary" className="mt-5 w-full" disabled={!!busy} onClick={() => void migrateAndAdopt()}>
                  Migrate into Covenant
                </Button>
              )}
            </Panel>
          </div>
        )}
      </section>

      {/* 3 — seed */}
      <section className={clsx("border-t border-line py-8", !live && "opacity-50")}>
        <StepHead n={3} title="Seed from demand" state={!live ? "todo" : phase === "seeded" ? "done" : "now"} />
        {live && ours && (
          <div className="space-y-6">
            <Panel
              eyebrow={phase === "seeded" ? "After the seed" : "As migrated"}
              title={phase === "seeded" ? "Support sits where outbid buyers said they would buy" : "Full-range liquidity: spread thin across every price"}
              action={<Tag tone={ours.support.have >= ours.support.need ? "pass" : "breach"}>Support {pct(ours.support.have)}</Tag>}
            >
              <ShapeChart world={ours} height={320} />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
                <ShapeLegend />
                {phase === "seeded" ? (
                  <Link href="/vault">
                    <Button variant="primary">Open the vault</Button>
                  </Link>
                ) : (
                  <Button variant="primary" disabled={!!busy} onClick={() => void runSeed()}>
                    Run the demand-shaped seed
                  </Button>
                )}
              </div>
            </Panel>
            <RuleRail world={ours} />
            <p className="text-xs text-faint">Price at launch: {priceText(priceAt(ours.spot))} ETH. The vault is now the app&apos;s current vault: every other page shows it.</p>
          </div>
        )}
      </section>
    </>
  );
}
