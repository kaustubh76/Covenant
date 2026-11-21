"use client";

import clsx from "clsx";
import { Check, Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { type Address, formatEther, isAddressEqual } from "viem";
import { ccaAbi, covenantHookAbi, covenantLensAbi, covenantVaultAbi, seedPlannerAbi } from "@/chain/abi.generated";
import { ACTOR_LABEL, actorOf, shortAddress } from "@/chain/accounts";
import { beatOf, note } from "@/chain/beat";
import { type DraftBid, addBid, bidProblems, bidWei, draftBids, matchPlaced, maxBids, placedPrice, placementOrder, removeBid, switchBidder } from "@/chain/bids";
import {
  AUCTION_FLOOR,
  AUCTION_TICK,
  type AuctionBid,
  type AuctionGrid,
  type Launch,
  type LaunchPlan,
  type OnWait,
  SWEEP_DUST,
  type Sale,
  TESTNET_PRICE_SHIFT,
  WALLET_AUCTION_BLOCKS,
  WALLET_START_DELAY,
  adopt,
  allBids,
  bid,
  closeAuction,
  createLaunchVault,
  defaultLaunchSpec,
  deployLaunchToken,
  migrate,
  ownBids,
  readLaunchPlan,
  readSale,
  registerAuction,
  seed,
  seedParamsFor,
  settleBids,
  sweepUnsold,
  testnetLaunchSpec,
} from "@/chain/launch";
import { priceAt, q96ToNumber, ticksBelowPct, ticksToPct } from "@/chain/price";
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
import { SendButton } from "@/components/controls/SendButton";

const DAY = 86_400;
const HOUR = 3_600;

const LOCAL_GRID: AuctionGrid = { floorPrice: AUCTION_FLOOR, auctionTick: AUCTION_TICK };
/** A public chain's launch (testnetLaunchSpec): every price and bid divided by 2^13, so faucet ETH is enough. */
const TESTNET_GRID: AuctionGrid = { floorPrice: AUCTION_FLOOR >> BigInt(TESTNET_PRICE_SHIFT), auctionTick: AUCTION_TICK >> BigInt(TESTNET_PRICE_SHIFT) };
const tokens = (x: bigint) => Number(formatEther(x));

type Check = { ok: boolean; isCovenantVault: boolean; hookIsCovenant: boolean; poolMatchesVault: boolean; lpGoesToVault: boolean; vaultIsFresh: boolean; tokensReservedForLp: bigint; terms?: Terms };
type Phase = "terms" | "bidding" | "bid" | "closed" | "migrated" | "seeded";
type Settled = { exited: number; claimed: number };

/**
 * A public chain's launch is permanent and spans minutes of wallet prompts, so the desk keeps where it got to and a
 * reload resumes it. Kept per network and wallet, in this browser only. The local chain resets, so it keeps nothing.
 */
/** What a create that has not finished already put on chain: it resumes from the first step missing. */
type Creating = { token?: Address; vault?: Address };
interface SavedLaunch {
  /** Null until the launch is registered; `creating` holds what is on chain before that. */
  launch: Launch | null;
  creating?: Creating | null;
  phase: Phase;
  check: Check | null;
  result: { clearing: number; raised: number; outbid: number } | null;
  supportBefore: number | null;
  settled: Settled | null;
  bids: DraftBid[];
  /** Ids of the drafts already in the auction. */
  placed?: string[];
  draft: Terms;
  symbol: string;
}
const BIG = "$bigint";
const savedKey = (net: string, wallet: string) => `covenant.launch:${net}:${wallet.toLowerCase()}`;
function loadLaunch(key: string): SavedLaunch | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw, (_k, v) => (v && typeof v === "object" && typeof v[BIG] === "string" ? BigInt(v[BIG]) : v)) as SavedLaunch) : null;
  } catch {
    return null;
  }
}
function storeLaunch(key: string, s: SavedLaunch | null) {
  try {
    if (s) localStorage.setItem(key, JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? { [BIG]: v.toString() } : v)));
    else localStorage.removeItem(key);
  } catch {
    /* private mode: nothing kept */
  }
}

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
  const chainEpoch = useChain((s) => s.chainEpoch);
  // A public chain runs the same launch in real time, at testnet scale, signed by the connected wallet.
  const isPublic = !!net && !net.caps.devChain;
  const grid = isPublic ? TESTNET_GRID : LOCAL_GRID;
  const floorEth = q96ToNumber(grid.floorPrice);
  const scale = isPublic ? 2 ** -TESTNET_PRICE_SHIFT : 1;
  /** The grid price a typed price is placed at (one tick above the floor at least): what the auction will see. */
  const snap = (p: number) => q96ToNumber(placedPrice(p, grid));
  const who = (b: DraftBid) => (isPublic ? "You" : b.bidder === "bob" ? "Bob" : "Alice");
  const ctx = useChain((s) => s.ctx);

  const [presetKey, setPresetKey] = useState<PresetKey | "">("standard");
  const [draft, setDraft] = useState<Terms>(PRESETS.standard);
  const [symbol, setSymbol] = useState("TOKEN");
  // A public chain's book starts empty: every bid there is the wallet's own. A dev chain's starts with the test suite's
  // bids from its dev accounts, labelled as such where the book is shown.
  const [bids, setBids] = useState<DraftBid[]>([]);
  const [phase, setPhase] = useState<Phase>("terms");
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [result, setResult] = useState<{ clearing: number; raised: number; outbid: number } | null>(null);
  const [supportBefore, setSupportBefore] = useState<number | null>(null);
  const [settled, setSettled] = useState<Settled | null>(null);
  // What the auction sold, once it is over, and whether the treasury has swept the rest. Read when the auction closes,
  // after a sweep, and once for a saved public launch that resumes past its close.
  const [sale, setSale] = useState<Sale | null>(null);
  // The drafts already in the auction, and what an unfinished create already put on chain.
  const [placed, setPlaced] = useState<string[]>([]);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const pastClose = phase === "closed" || phase === "migrated" || phase === "seeded";
  // A failed read is tried again on the next block rather than never: the sale decides whether Sweep shows.
  useEffect(() => {
    if (!ctx || !launch || !pastClose || sale) return;
    let live = true;
    readSale(ctx, launch)
      .then((s) => live && setSale(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ctx, launch, pastClose, sale, view?.block]);

  // What the launch's contracts say it is (supply, floor, grid, the pool's share) and every bid in its auction, read
  // from the chain once the auction exists, so nothing below restates them from the app's own defaults.
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [chainBids, setChainBids] = useState<AuctionBid[] | null>(null);
  const [maxWindow, setMaxWindow] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!ctx || !launch || plan) return;
    let live = true;
    readLaunchPlan(ctx, launch)
      .then((p) => live && setPlan(p))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ctx, launch, plan, view?.block]);
  const auctionLive = !!launch && (phase === "bidding" || phase === "bid" || phase === "closed");
  const bidsTick = Math.floor(Number(view?.block ?? 0n) / 10);
  useEffect(() => {
    if (!ctx || !launch || (!auctionLive && chainBids)) return;
    let live = true;
    allBids(ctx, launch)
      .then((b) => live && setChainBids(b))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ctx, launch, auctionLive, chainBids === null, bidsTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ctx) return;
    let live = true;
    ctx.pub
      .readContract({ address: ctx.net.manifest.hook, abi: covenantHookAbi, functionName: "MAX_WINDOW" })
      .then((w) => live && setMaxWindow(Number(w)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ctx]);

  const keep = isPublic && net && wallet ? savedKey(net.key, wallet.address) : null;
  // A launch belongs to the chain it was made on, and on a public chain to the wallet that made it. Another network, a
  // reset, a fresh Playground chain or another wallet starts the desk over, and resumes that wallet's saved launch if it
  // has one. Carried over, a launch's contracts and block numbers would not be there: on a dev chain the next wait
  // would mine all the way to a public chain's block height.
  const deskKey = net ? `${net.key}:${chainEpoch}:${isPublic ? (wallet?.address.toLowerCase() ?? "") : ""}` : null;
  const [deskOf, setDeskOf] = useState<string | null>(null);
  useEffect(() => {
    if (!deskKey || deskKey === deskOf) return;
    setDeskOf(deskKey);
    const s = keep ? loadLaunch(keep) : null;
    setPresetKey(s ? "" : "standard");
    setDraft(s?.draft ?? PRESETS.standard);
    setSymbol(s?.symbol ?? "TOKEN");
    setBids(s?.bids ?? (isPublic ? [] : draftBids(floorEth, scale)));
    setPlaced(s?.placed ?? []);
    setCreating(s?.creating ?? null);
    setPlan(null);
    setChainBids(null);
    setLaunch(s?.launch ?? null);
    setCheck(s?.check ?? null);
    setResult(s?.result ?? null);
    setSupportBefore(s?.supportBefore ?? null);
    setSettled(s?.settled ?? null);
    setSale(null);
    setConfirmAbandon(false);
    setPhase(s?.phase ?? "terms");
    if (s?.launch && (s.phase === "migrated" || s.phase === "seeded")) void selectVault(s.launch.vault);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deskKey]);
  useEffect(() => {
    // Only the desk of the chain and wallet on screen is saved: for one render after a switch the old one is still here.
    if (!keep || deskOf !== deskKey || (!launch && !creating)) return;
    storeLaunch(keep, { launch, creating, phase, check, result, supportBefore, settled, bids, placed, draft, symbol });
  }, [keep, deskOf, deskKey, launch, creating, phase, check, result, supportBefore, settled, bids, placed, draft, symbol]);

  if (status !== "ready") return <NeedsChain what="the launch desk" />;

  const problems = termsProblems(draft, defaultLaunchSpec(draft).tickSpacing, maxWindow);
  const set = (k: keyof Terms, v: number) => {
    setPresetKey("");
    setDraft((d) => ({ ...d, [k]: v }));
  };
  const editBid = (id: string, k: "price" | "amount", v: number) => setBids((b) => b.map((x) => (x.id === id ? { ...x, [k]: v } : x)));
  const draftIssues = bidProblems(bids, grid);
  const fullBook = bids.length >= maxBids(isPublic);
  const opened = phase !== "terms";
  // The bidding is over once every bid is in: the book is fixed from then on. Before that, each bid that is already in
  // the auction is fixed, and the rest stay editable (a declined prompt, a refusal, a reload in between).
  const bidsIn = !["terms", "bidding"].includes(phase);
  const isPlaced = (b: DraftBid) => bidsIn || placed.includes(b.id);
  const toPlace = phase === "bidding" ? placementOrder(bids, grid).filter((b) => !placed.includes(b.id)).length : 0;
  const inAuction = bidsIn ? placementOrder(bids, grid).length : placed.length;
  const live = ["migrated", "seeded"].includes(phase);
  const ours = live && view && launch && vault?.toLowerCase() === launch.vault.toLowerCase() ? view : null;

  const commit = () =>
    run("Creating the vault and registering the launch", async (ctx, rec) => {
      const named = { name: `${symbol} Launch`, symbol };
      const spec = isPublic ? testnetLaunchSpec(draft, { ...named, durationBlocks: WALLET_AUCTION_BLOCKS, startDelay: WALLET_START_DELAY }) : defaultLaunchSpec(draft, named);
      // Each step is kept as it lands: after a declined prompt, a refusal or a reload, the next try resumes from the
      // first step not on chain yet, instead of deploying another token and vault.
      let made: Creating = creating ?? {};
      if (!made.token) {
        made = { token: await deployLaunchToken(ctx, spec) };
        setCreating(made);
      }
      if (!made.vault) {
        made = { ...made, vault: await createLaunchVault(ctx, spec, made.token as Address) };
        setCreating(made);
      }
      const l = await registerAuction(ctx, spec, made.token as Address, made.vault as Address);
      const m = ctx.net.manifest;
      const c = await ctx.pub.readContract({ address: m.lens, abi: covenantLensAbi, functionName: "verifyLaunch", args: [m.factory, m.lbpStrategy, l.auction] });
      rec.record(
        [
          note("issuer", "Vault created before the auction", `Terms fixed at creation. Vault ${shortAddress(l.vault)}`),
          note("issuer", "Launch registered with Uniswap's LBPStrategy", `The CCA opens. LP positions will be minted to ${shortAddress(l.vault)}`),
        ],
        { toast: true },
      );
      setCreating(null);
      setLaunch(l);
      setCheck(c);
      setPhase("bidding");
    });

  const placeBids = () =>
    run("Placing bids", async (ctx, rec) => {
      if (!launch) return;
      await reach(ctx, launch.startBlock, (now, target) => rec.progress(`The auction opens in ${target - now} blocks`));
      const done = new Set(placed);
      // On a public chain, the auction says which of this wallet's bids already landed (a reload just after one), so
      // none is sent twice.
      if (isPublic) {
        const mine = await ownBids(ctx, launch, ctx.address("alice"));
        for (const id of matchPlaced(bids.filter((b) => !done.has(b.id)), mine, launch)) done.add(id);
        setPlaced([...done]);
      }
      // Lowest price first: the clearing price never falls, so each bid lands at or above the one the last bid left.
      for (const b of placementOrder(bids, launch).filter((x) => !done.has(x.id))) {
        const price = placedPrice(b.price, launch);
        const o = await bid(ctx, launch, b.bidder, price, bidWei(b.amount));
        rec.record(beatOf(o, b.bidder, `${who(b)} ${isPublic ? "bid" : "bids"} ${amt(b.amount)} ETH up to ${priceText(q96ToNumber(price))}`), { toast: !o.ok });
        if (o.ok) {
          done.add(b.id);
          setPlaced([...done]);
        } else if (o.error?.name === "Rejected") {
          break; // declined in the wallet: stop asking, and leave the rest for the next try
        }
      }
      // The auction moves on only with the whole book in. A bid refused or declined stays in the draft, to retry, edit
      // or remove.
      if (placementOrder(bids, launch).every((b) => done.has(b.id))) setPhase("bid");
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
      setSale(await readSale(ctx, launch));
      rec.record(note("anyone", `Auction clears at ${priceText(r.clearing)} ETH`, `${amt(r.raised)} ETH raised. ${amt(r.outbid)} ETH of outbid demand stays on-chain`), { toast: true });
      setPhase("closed");
    });

  // The auction's tokens recipient (the launch's treasury) takes what no bid bought. Once, any time after the close.
  const sweep = () =>
    run("Sweeping the unsold tokens", async (ctx, rec) => {
      if (!launch) return;
      const o = await sweepUnsold(ctx, launch);
      const to = isPublic ? "your wallet" : "the treasury";
      rec.record(beatOf(o, "treasury", `Unsold ${symbol} swept to ${to}`, () => (o.amount !== undefined ? `${amt(tokens(o.amount))} ${symbol} the auction did not sell` : undefined)), { toast: true });
      setSale(await readSale(ctx, launch));
    });

  const migrateAndAdopt = async () => {
    const vaultAddr = await run("Migrating into the pool", async (ctx, rec) => {
      if (!launch) return null;
      // The strategy migrates a launch once. With its positions known, a retry (after a declined or refused adopt) goes
      // straight to adopting them: anyone may, and migrating again would only be refused.
      let l = launch;
      if (!l.lpIds?.length) {
        const ids = await migrate(ctx, launch, "deployer", (now, target) => rec.progress(`Migration opens in ${target - now} blocks`));
        l = { ...launch, lpIds: ids };
        setLaunch(l);
        rec.record(note("anyone", "Pool created at the clearing price, through the Covenant hook", `LP position #${ids[0]} minted to the vault`));
      }
      const o = await adopt(ctx, l);
      if (!o.ok) {
        rec.record(beatOf(o, "anyone", "The vault adopts the launch liquidity"), { toast: true });
        return null;
      }
      const [have] = await ctx.pub.readContract({ address: l.vault, abi: covenantVaultAbi, functionName: "support" });
      setSupportBefore(Number(have));
      rec.record(beatOf(o, "anyone", "The vault adopts the launch liquidity", () => `Support starts at ${pct(Number(have))}`), { toast: true });
      setPhase("migrated");
      return l.vault;
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

  // After the auction: exit every bid, so the ETH it did not spend comes back, then claim the tokens it bought.
  const settle = () =>
    run("Settling the bids", async (ctx, rec) => {
      if (!launch) return;
      // one pass per bidding address: on a public chain every bid is the wallet's
      const owners = new Map<string, DraftBid["bidder"]>();
      for (const b of bids) if (b.amount > 0) owners.set(ctx.address(b.bidder).toLowerCase(), b.bidder);
      const total: Settled = { exited: 0, claimed: 0 };
      for (const by of owners.values()) {
        const r = await settleBids(ctx, launch, by, { claim: true, onWait: (now, target) => rec.progress(`Claims open in ${target - now} blocks`) });
        total.exited += r.exited;
        total.claimed += r.claimed;
      }
      setSettled(total);
      rec.record(note("anyone", "Bids settled", `${total.exited} exited, returning the ETH they did not spend; ${total.claimed} claimed the tokens they bought`), { toast: true });
    });
  const startOver = () => {
    if (keep) storeLaunch(keep, null);
    setLaunch(null);
    setCreating(null);
    setCheck(null);
    setResult(null);
    setSupportBefore(null);
    setSettled(null);
    setSale(null);
    setPlaced([]);
    setConfirmAbandon(false);
    // back to "terms" with the default bids: the next commit deploys a fresh token, so a new vault and pool. On a dev
    // chain the old launch stays where it is.
    setBids(isPublic ? [] : draftBids(floorEth, scale));
    setPlan(null);
    setChainBids(null);
    setPhase("terms");
  };
  const raisedNothing = phase === "closed" && result !== null && result.raised === 0;
  const sweepTo = isPublic ? "your wallet" : "the treasury";
  // On a public chain only the auction's named recipient can sweep: the wallet that made the launch. (With no wallet at
  // all, the send button asks for one first.)
  const sweepRefused = isPublic && sale && wallet && !isAddressEqual(wallet.address, sale.recipient) ? `Only ${shortAddress(sale.recipient)} can sweep` : null;

  // Once the auction exists, its demand is what the auction holds: every bid read from it, the wallet's own named "You",
  // plus any draft not placed yet, drawn dashed. Before then there are only drafts.
  const ownerName = (owner: Address) => {
    if (wallet && isAddressEqual(owner, wallet.address)) return "You";
    const dev = isPublic ? undefined : actorOf(owner);
    return dev ? ACTOR_LABEL[dev] : shortAddress(owner);
  };
  const draftCurve = bids.filter((b) => !(launch && chainBids && isPlaced(b))).map((b) => ({ id: b.id, bidder: who(b), maxPrice: snap(b.price), amount: b.amount, pending: true }));
  const curveBids =
    launch && chainBids
      ? [...chainBids.map((b) => ({ id: `bid-${b.id}`, bidder: ownerName(b.owner), maxPrice: q96ToNumber(b.maxPrice), amount: Number(formatEther(b.amount)) })), ...draftCurve]
      : draftCurve;
  const gridOf = plan ? Math.round(Number(plan.floorPrice) / Number(plan.priceStep)) : null;
  const floorShown = plan ? q96ToNumber(plan.floorPrice) : floorEth;
  // The terms and symbol are fixed while a job runs (the create reads them) and once a create is under way: its token,
  // and perhaps its vault, already carry them.
  const termsLocked = opened || !!busy || !!creating;

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
                  disabled={termsLocked}
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
            <fieldset disabled={termsLocked} className="mt-6 grid gap-x-8 gap-y-5 disabled:opacity-60 sm:grid-cols-2">
              <Slider label="Support: minimum share of the quote in the band" value={draft.supportBps} min={2000} max={7000} step={500} onChange={(v) => set("supportBps", v)} display={pct(draft.supportBps, 0)} />
              <Slider label="Band: how far below the price counts" value={draft.supportBandTicks} min={600} max={3000} step={60} onChange={(v) => set("supportBandTicks", v)} display={`${ticksBelowPct(draft.supportBandTicks).toFixed(1)}%`} />
              <Slider label="Pace: most value moved per epoch" value={draft.paceBps} min={1000} max={10000} step={500} onChange={(v) => set("paceBps", v)} display={pct(draft.paceBps, 0)} />
              <Slider label="Epoch length" value={draft.epochLength / HOUR} min={1} max={72} step={1} onChange={(v) => set("epochLength", v * HOUR)} display={duration(draft.epochLength)} />
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
            <TermsCard terms={launch && check?.terms ? check.terms : draft} symbol={symbol} />
            {launch && check?.terms && <p className="mt-2 text-xs text-faint">The vault&apos;s terms as its contract holds them (CovenantLens.verifyLaunch).</p>}
            {!opened && (
              <>
                <label className="mt-4 flex items-center gap-3 text-[13px] text-muted">
                  Token symbol
                  <input
                    value={symbol}
                    maxLength={8}
                    disabled={termsLocked}
                    onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                    className="num h-9 w-28 rounded-md border border-line-strong bg-transparent px-2 text-ink outline-none disabled:opacity-60"
                  />
                </label>
                {!symbol && <p className="mt-1.5 text-xs text-breach">Give the token a symbol: letters and digits, up to 8.</p>}
                <SendButton verb="launch" variant="primary" size="lg" className="mt-4 w-full" disabled={!!busy || problems.length > 0 || !symbol} onClick={() => void commit()}>
                  {creating ? "Resume: finish the vault and the auction" : "Create the vault and open the auction"}
                </SendButton>
                {creating && (
                  <p className="mt-2 text-center text-xs leading-relaxed text-warn">
                    {creating.vault ? "The token and the vault are" : "The token is"} already on chain, so the terms and the symbol are fixed: resuming finishes the
                    launch from the next step.{" "}
                    <button type="button" disabled={!!busy} onClick={startOver} className="underline underline-offset-2 hover:text-ink disabled:opacity-50">
                      Discard them and start over
                    </button>
                  </p>
                )}
                {isPublic && (
                  <p className="mt-2 text-center text-xs text-faint">
                    On {net?.name}: a fixed-supply token, prices at 1/{(2 ** TESTNET_PRICE_SHIFT).toLocaleString("en-US")} of the local launch and a{" "}
                    {WALLET_AUCTION_BLOCKS.toLocaleString("en-US")}-block auction, about {duration((WALLET_AUCTION_BLOCKS * (net?.caps.blockTimeMs ?? 2000)) / 1000)}. Your wallet signs each
                    step, and the desk resumes if you reload. The vault opens to deposits after its first epoch: {duration(draft.epochLength)} after the migration.
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
              <Panel
                eyebrow={`${plan ? `${amt(tokens(plan.totalSupply))} tokens · floor ${priceText(q96ToNumber(plan.floorPrice))} ETH` : "Reading the auction…"} · auction ${shortAddress(launch.auction)}`}
                title="Bids by maximum price"
              >
                <DemandCurve bids={curveBids} result={result ? { clearingPrice: result.clearing, floorPrice: floorShown } : null} />
                <p className="mt-2 text-xs text-faint">
                  {chainBids
                    ? `${chainBids.length} bid${chainBids.length === 1 ? "" : "s"} in the auction, read from it${draftCurve.length ? "; dashed: drafts not placed yet" : ""}.`
                    : "Reading the auction's bids…"}
                </p>
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
            <Panel eyebrow="Order book" title={bidsIn ? "Bids placed" : isPublic ? "Your bids" : "Bidders"}>
              {!isPublic && !bidsIn && (
                <p className="mb-3 text-xs text-faint">The test suite&apos;s bids, from this dev chain&apos;s accounts Bob and Alice. Edit, add or remove them.</p>
              )}
              {isPublic && !bids.length && <p className="mb-3 text-xs text-faint">No bids yet. Add yours: each is one wallet prompt.</p>}
              <ul className="space-y-3">
                {bids.map((b, i) => (
                  <li key={b.id} className="grid grid-cols-[48px_1.2fr_1fr_20px] items-center gap-2 text-sm sm:grid-cols-[52px_1.2fr_1fr_24px] sm:gap-2.5">
                    {isPublic || isPlaced(b) ? (
                      <span className="text-ink">{who(b)}</span>
                    ) : (
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => setBids((x) => switchBidder(x, b.id))}
                        title="Switch the bidder"
                        aria-label={`Bid ${i + 1} is ${who(b)}'s: switch to ${b.bidder === "bob" ? "Alice" : "Bob"}`}
                        className="rounded-md border border-dashed border-line-strong px-1.5 py-1 text-left text-ink transition-colors hover:border-muted disabled:opacity-60"
                      >
                        {who(b)}
                      </button>
                    )}
                    <label className="flex items-center gap-2 rounded-md border border-line-strong px-2 py-1.5 sm:px-2.5">
                      {/* on a phone the field keeps its name for assistive tech, and the chart above says "maximum price" */}
                      <span className="hidden whitespace-nowrap text-xs text-faint sm:inline">up to</span>
                      <input
                        disabled={isPlaced(b) || !!busy}
                        type="number"
                        step={floorEth / 64}
                        min={floorEth}
                        // typed freely ("0", "0.", "0.0002"): it snaps to the auction's grid when the field is left
                        value={Number.isFinite(b.price) ? Number(b.price.toPrecision(5)) : ""}
                        onChange={(e) => editBid(b.id, "price", Number(e.target.value))}
                        onBlur={() => editBid(b.id, "price", snap(b.price))}
                        className="num w-full bg-transparent text-right text-ink outline-none"
                        aria-label={`Bid ${i + 1} (${who(b)}): max price`}
                      />
                    </label>
                    <label className="flex items-center gap-2 rounded-md border border-line-strong px-2 py-1.5 sm:px-2.5">
                      <span className="text-xs text-faint">ETH</span>
                      <input
                        disabled={isPlaced(b) || !!busy}
                        type="number"
                        step={50 * scale}
                        min={0}
                        value={Number(b.amount.toPrecision(6))}
                        onChange={(e) => editBid(b.id, "amount", Math.max(0, Number(e.target.value) || 0))}
                        className="num w-full bg-transparent text-right text-ink outline-none"
                        aria-label={`Bid ${i + 1} (${who(b)}): ETH`}
                      />
                    </label>
                    {bidsIn ? (
                      <span />
                    ) : isPlaced(b) ? (
                      <span className="grid h-7 w-5 place-items-center text-pass sm:w-6" title="In the auction" aria-label={`Bid ${i + 1} is in the auction`}>
                        <Check size={14} />
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => setBids((x) => removeBid(x, b.id))}
                        title="Remove this bid"
                        aria-label={`Remove bid ${i + 1} (${who(b)}, up to ${priceText(snap(b.price))} ETH)`}
                        className="grid h-7 w-5 place-items-center rounded text-faint transition-colors hover:text-breach disabled:opacity-50 sm:w-6"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {!bidsIn && placed.length === 0 && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <Button size="sm" variant="ghost" disabled={fullBook || !!busy} onClick={() => setBids((x) => addBid(x, grid, scale, isPublic))}>
                    <Plus size={14} />
                    Add a bid
                  </Button>
                  {fullBook && (
                    <span className="text-xs text-faint">
                      {maxBids(isPublic)} bids at most{isPublic ? ": each is a wallet prompt" : ""}
                    </span>
                  )}
                </div>
              )}
              <p className="mt-3 text-xs leading-relaxed text-faint">
                Prices snap to the auction&apos;s grid{gridOf ? ` of 1/${gridOf} of the floor` : ""} and must be above the {priceText(floorShown)} ETH floor. Bids go in lowest
                price first, so a higher bid can&apos;t price out a lower one. Bid for less than the {plan ? amt(tokens(plan.totalSupply)) : "auction's"} tokens and the treasury
                sweeps what is left.
              </p>
              {phase === "bidding" && (draftIssues.blocking || draftIssues.warning) && (
                <p className={clsx("mt-2 text-xs", draftIssues.blocking ? "text-breach" : "text-warn")}>{draftIssues.blocking ?? draftIssues.warning}</p>
              )}
              {result && (
                <div className="mt-5">
                  <Row label="Clearing price">{priceText(result.clearing)} ETH</Row>
                  <Row label="Raised">{amt(result.raised)} ETH</Row>
                  <Row label={plan ? `To the pool (${pct(plan.lpShare * 10_000)} of the raise, as registered)` : "To the pool"}>
                    {plan ? `${amt(result.raised * plan.lpShare)} ETH + up to ${amt(tokens(plan.reservedForLp))} tokens` : "Reading the launch's parameters…"}
                  </Row>
                  <Row label="Outbid demand left on-chain">{amt(result.outbid)} ETH</Row>
                  {sale && (
                    <>
                      <Row label="Sold">
                        {amt(tokens(sale.sold))} of {plan ? amt(tokens(plan.totalSupply)) : "…"} tokens
                      </Row>
                      <Row label="Unsold">
                        {sale.unsold <= SWEEP_DUST ? "none: sold out" : `${amt(tokens(sale.unsold))}${sale.swept ? `, swept to ${sweepTo}` : ""}`}
                      </Row>
                    </>
                  )}
                </div>
              )}
              {sale && sale.closed && !sale.swept && sale.unsold > SWEEP_DUST && (
                <SendButton verb="sweep" variant="secondary" className="mt-5 w-full" disabled={!!busy || !!sweepRefused} onClick={() => void sweep()}>
                  {sweepRefused ?? `Sweep ${amt(tokens(sale.unsold))} unsold ${symbol} to ${sweepTo}`}
                </SendButton>
              )}
              {/* Each step that a wallet signs is a SendButton: with no wallet, or one on another network, it offers to connect
                  or switch instead of failing with "Not sent". */}
              {phase === "bidding" && (
                <>
                  <SendButton verb="bid" variant="primary" className="mt-5 w-full" disabled={!!busy || !!draftIssues.blocking} onClick={() => void placeBids()}>
                    {placed.length > 0 ? `Place the remaining ${toPlace === 1 ? "bid" : `${toPlace} bids`}` : "Place the bids"}
                  </SendButton>
                  {placed.length > 0 && (
                    <p className="mt-2 text-center text-xs text-faint">
                      {placed.length} {placed.length === 1 ? "bid is" : "bids are"} in the auction (ticked). The rest were declined or refused: place them again, or edit
                      or remove them first.
                    </p>
                  )}
                </>
              )}
              {phase === "bid" && (
                <SendButton verb="close" variant="primary" className="mt-5 w-full" disabled={!!busy} onClick={() => void close()}>
                  Close the auction
                </SendButton>
              )}
              {phase === "closed" &&
                (raisedNothing ? (
                  <p className="mt-4 text-[13px] text-breach">No bid was accepted, so nothing was raised and there is nothing to migrate. Start over below.</p>
                ) : (
                  <SendButton verb="migrate" variant="primary" className="mt-5 w-full" disabled={!!busy} onClick={() => void migrateAndAdopt()}>
                    {launch.lpIds?.length ? "Adopt the launch's positions into the vault" : "Migrate into Covenant"}
                  </SendButton>
                ))}
              {/* Bidders can leave once the auction is over, migrated or not: so the ETH their bids hold never depends on
                  the rest of the launch going through. */}
              {pastClose &&
                !raisedNothing &&
                (settled ? (
                  <p className="mt-4 text-[13px] text-pass">
                    Bids settled: {settled.exited} exited and {settled.claimed} claimed. Unspent ETH is back with the {isPublic ? "wallet" : "bidders"}.
                  </p>
                ) : (
                  <SendButton verb="settle" variant={live ? "secondary" : "ghost"} className={live ? "mt-5 w-full" : "mt-2.5 w-full"} disabled={!!busy} onClick={() => void settle()}>
                    Exit the bids and claim the tokens
                  </SendButton>
                ))}
              {!live &&
                (confirmAbandon ? (
                  <div className="mt-3 text-center text-xs leading-relaxed">
                    <p className="text-warn">
                      Your {inAuction === 1 ? "bid holds its" : `${inAuction} bids hold their`} ETH in this auction. Once it is over, exit them here:
                      abandoning forgets this launch on this page.
                    </p>
                    <div className="mt-1.5 flex justify-center gap-4">
                      <button type="button" disabled={!!busy} onClick={startOver} className="text-breach underline underline-offset-2 disabled:opacity-50">
                        Abandon anyway
                      </button>
                      <button type="button" onClick={() => setConfirmAbandon(false)} className="text-faint underline underline-offset-2 hover:text-ink">
                        Keep the launch
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={!!busy}
                    // On a public chain, bids hold the wallet's real ETH until they are exited: ask before forgetting them.
                    onClick={() => (isPublic && inAuction > 0 && !settled ? setConfirmAbandon(true) : startOver())}
                    title={isPublic ? undefined : "The old launch stays on this chain. The next one deploys a new token, vault and pool."}
                    className="mt-3 w-full text-center text-xs text-faint underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
                  >
                    Abandon this launch and start over
                  </button>
                ))}
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
                  <div className="flex flex-wrap gap-2.5">
                    <Button variant="ghost" disabled={!!busy} onClick={startOver}>
                      Start a new launch
                    </Button>
                    <Link href="/vault">
                      <Button variant="primary">Open the vault</Button>
                    </Link>
                  </div>
                ) : (
                  <SendButton verb="seed" variant="primary" disabled={!!busy} onClick={() => void runSeed()}>
                    Run the demand-shaped seed
                  </SendButton>
                )}
              </div>
            </Panel>
            <RuleRail world={ours} />
            <p className="text-xs text-faint">
              Price now: {priceText(priceAt(ours.spot))} ETH, at block {ours.block.toLocaleString("en-US")}. The launch cleared at the price above. The vault is now the app&apos;s
              current vault: every other page shows it.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
