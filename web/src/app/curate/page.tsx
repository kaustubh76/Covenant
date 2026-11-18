"use client";

import { Minus, MoveHorizontal, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseEther } from "viem";
import { covenantVaultAbi } from "@/chain/abi.generated";
import { shortAddress } from "@/chain/accounts";
import { beatOf, note } from "@/chain/beat";
import { pushTo } from "@/chain/market";
import { NEVER } from "@/chain/launch";
import { type Leg, SINK, askFloor, askLeg, bidCeiling, bidLeg, bidTop, cut, reserveIndex, supportIndex } from "@/chain/plans";
import { type Preflight, preflight, vaultEvents, failedPreflight } from "@/chain/preflight";
import { ceilTo, floorTo, holdingsAtPrice, priceAt } from "@/chain/price";
import { advance } from "@/chain/time";
import { isAddressParty, send } from "@/chain/tx";
import type { VaultView } from "@/chain/view";
import { NeedsChain } from "@/components/chain/NeedsChain";
import { type ShapeSource, ShapeChart, ShapeLegend, chartDomain } from "@/components/covenant/ShapeChart";
import { ReshapeVerdict } from "@/components/covenant/Verdict";
import { Button, PageHeader, Panel, Tag } from "@/components/ui";
import { amt, axisPrice, duration, pct } from "@/lib/format";
import { layoutKey } from "@/lib/layout";
import { describeRange } from "@/lib/ranges";
import { actorFor, canSendAs, partyFor, useChain } from "@/store/chain";
import { SendButton } from "@/components/controls/SendButton";

interface Draft {
  id: string;
  asset: "quote" | "token";
  /** Price ticks. */
  lower: number;
  upper: number;
  /** Share of the freed asset, 0..1. The last draft of an asset fully allocated takes the remainder (a sink). */
  share: number;
}
interface Editor {
  rm: number[];
  drafts: Draft[];
}

let uid = 0;
const d = (asset: Draft["asset"], lower: number, upper: number, share: number): Draft => ({ id: `d${++uid}`, asset, lower, upper, share });

function bounds(v: VaultView) {
  const sp = v.tickSpacing;
  const B = v.terms.supportBandTicks;
  // Honest bids stop at the Anchor ceiling as well as under the price: after a pump the ceiling binds, and a preset that
  // ignored it would be refused like the hostile one. The band's bottom stays below that cap, so no range turns inside out.
  const bidMax = bidCeiling(v);
  return { sp, B, p: v.spotTick, bidMax, askMin: askFloor(v), bidBottom: Math.min(ceilTo(v.spotTick - B, sp) + sp, bidMax - sp) };
}
/** In the setup epoch the whole vault may move; after it, Pace allows the main support range. */
const movable = (v: VaultView) => (v.pace.setup ? v.ranges.map((_, i) => i) : [supportIndex(v)]);

function freedBy(v: VaultView, rm: number[]) {
  return rm.reduce((s, i) => ({ quote: s.quote + (v.ranges[i]?.quote ?? 0), token: s.token + (v.ranges[i]?.token ?? 0) }), { quote: v.idle.quote, token: v.idle.token });
}

const PRESETS: { key: string; name: string; hint: string; hostile?: boolean; when?: (v: VaultView) => string | null; make: (v: VaultView) => Editor }[] = [
  {
    key: "tighten",
    name: "Concentrate near price",
    hint: "Deep support in the band, a reserve behind it",
    make: (v) => {
      const { B, bidMax, askMin, bidBottom } = bounds(v);
      const rm = movable(v);
      // the reserve reaches four bands down, as CovenantTestBase._honestLegs places it: deep enough that a crash strands
      // part of it below the band, which is what restore is for
      const drafts = [d("quote", bidBottom, bidMax, 0.7), d("quote", bidBottom - 4 * B, bidBottom, 0.3)];
      if (freedBy(v, rm).token > 1e-9) drafts.push(d("token", askMin, askMin + 2 * B, 1));
      return { rm, drafts };
    },
  },
  {
    key: "recentre",
    name: "Re-centre on TWAP",
    hint: "Move only the main support range",
    make: (v) => {
      const { sp, B, bidMax } = bounds(v);
      const top = Math.min(bidMax, floorTo(v.twap, sp));
      return { rm: [supportIndex(v)], drafts: [d("quote", Math.min(top - sp, ceilTo(v.twap - B, sp) + sp), top, 1)] };
    },
  },
  {
    key: "softrug",
    name: "Park support far away",
    hint: "The soft rug",
    hostile: true,
    make: (v) => {
      const { p } = bounds(v);
      const rm = movable(v);
      const drafts = [d("quote", p - 12_000, p - 9_000, 1)];
      if (freedBy(v, rm).token > 1e-9) drafts.push(d("token", p + 9_000, p + 12_000, 1));
      return { rm, drafts };
    },
  },
  {
    key: "skim",
    name: "Keep 10% for yourself",
    hint: "Put back less than you lift",
    hostile: true,
    make: (v) => {
      const { B, bidMax, askMin, bidBottom } = bounds(v);
      const rm = movable(v);
      const drafts = [d("quote", bidBottom, bidMax, 0.6), d("quote", bidBottom - 3 * B, bidBottom, 0.3)];
      if (freedBy(v, rm).token > 1e-9) drafts.push(d("token", askMin, askMin + 2 * B, 1));
      return { rm, drafts };
    },
  },
  {
    key: "fragment",
    name: "Split into slivers",
    hint: "Grief every later call's gas",
    hostile: true,
    make: (v) => {
      const top0 = floorTo(v.spotTick - v.terms.supportBandTicks, v.tickSpacing);
      const drafts = Array.from({ length: 12 }, (_, i) => d("quote", top0 - 60 * (i + 1), top0 - 60 * i, i < 11 ? 0.05 : 0.45));
      return { rm: [reserveIndex(v)], drafts };
    },
  },
  {
    key: "ceiling",
    name: "Bid above the Anchor",
    hint: "Chase a pumped price",
    hostile: true,
    when: (v) => (bidTop(v) > v.ceiling + v.tickSpacing ? null : "Needs a pump first: spot has to run above the Anchor ceiling"),
    make: (v) => {
      const { sp } = bounds(v);
      // The one preset that ignores the ceiling: bids up to the pumped price itself.
      return { rm: [supportIndex(v)], drafts: [d("quote", floorTo(v.ceiling, sp) + sp, bidTop(v), 1)] };
    },
  },
];

/** Drafts as the contract's legs. The last draft of a fully allocated asset becomes its sink. */
function toLegs(v: VaultView, drafts: Draft[]): Leg[] {
  const out: Leg[] = [];
  for (const asset of ["quote", "token"] as const) {
    const list = drafts.filter((x) => x.asset === asset);
    const total = list.reduce((s, x) => s + x.share, 0);
    list.forEach((x, i) => {
      const sink = Math.abs(total - 1) < 0.005 && i === list.length - 1;
      const bps = sink ? SINK : Math.round(x.share * 1e4);
      out.push(asset === "quote" ? bidLeg(v, x.lower, x.upper, bps) : askLeg(v, x.lower, x.upper, bps));
    });
  }
  return out;
}

/** A client-side sketch of the proposed layout, drawn while the exact pre-flight is on its way. */
function sketch(v: VaultView, ed: Editor): ShapeSource {
  const freed = freedBy(v, ed.rm);
  const keep = v.ranges.filter((_, i) => !ed.rm.includes(i));
  const adds = ed.drafts.map((x) => {
    const unit = holdingsAtPrice(v.quoteIs0, v.spot, x.lower, x.upper, 1);
    const amount = (x.asset === "quote" ? freed.quote : freed.token) * x.share;
    const per = x.asset === "quote" ? unit.quote : unit.token;
    return { priceLower: x.lower, priceUpper: x.upper, L: per > 0 ? amount / per : 0 };
  });
  return { ...v, ranges: [...keep, ...adds] };
}

function movedFraction(v: VaultView, rm: number[]): number {
  const px = priceAt(v.twap);
  const value = rm.reduce((s, i) => s + (v.ranges[i] ? v.ranges[i].quote + v.ranges[i].token * px : 0), 0);
  return v.value > 0 ? value / v.value : 0;
}

export default function CuratePage() {
  const v = useChain((s) => s.view);
  const ctx = useChain((s) => s.ctx);
  const role = useChain((s) => s.role);
  const setRole = useChain((s) => s.setRole);
  const run = useChain((s) => s.run);
  const busy = useChain((s) => s.busy);
  const net = useChain((s) => s.net);
  // On a dev chain, the live management proof's setup in one click, so "Bid above the Anchor" can be tried: the price
  // runs past the Anchor's ceiling, then holds for a TWAP window. The TWAP follows, so the guard passes; the Anchor climbs
  // at most a band a day, so the ceiling stays under the pumped price, and a chase is refused with BidAboveCeiling.
  const pumpAndHold = (v: VaultView) =>
    run("Market pumps past the Anchor ceiling and holds", async (ctx, rec) => {
      const target = v.ceiling + Math.round(v.terms.supportBandTicks / 2) + 4 * v.tickSpacing;
      const o = await pushTo(ctx, v, "market", target, parseEther("5000"));
      rec.record(beatOf(o, "market", "Market pumps past the Anchor ceiling", () => `Spot runs to ${priceAt(target).toPrecision(4)} ${v.quoteSymbol}, above the ceiling at ${priceAt(v.ceiling).toPrecision(4)}`), { toast: !o.ok });
      if (!o.ok) return;
      await advance(ctx, v.terms.twapWindow);
      rec.record(note("anyone", `The pump holds for ${duration(v.terms.twapWindow)}`, "The TWAP has followed it and the guard passes; the Anchor has not. Now try Bid above the Anchor."), { toast: true });
    });
  const wallet = useChain((s) => s.wallet);
  const [ed, setEd] = useState<Editor | null>(null);
  const [preset, setPreset] = useState("tighten");
  const [domain, setDomain] = useState<[number, number] | null>(null);
  const [pre, setPre] = useState<Preflight | null>(null);
  const [checking, setChecking] = useState(false);
  const req = useRef(0);

  const refit = (view: VaultView, e: Editor) => setDomain(chartDomain([view], e.drafts));
  const apply = (key: string, view: VaultView) => {
    const p = PRESETS.find((x) => x.key === key)!;
    if (p.when?.(view)) return;
    const e = p.make(view);
    setPreset(key);
    setEd(e);
    refit(view, e);
  };
  // A named preset follows the vault and the price, so it is rebuilt from every new block. A hand-edited draft (preset
  // "") is kept until the layout under it changes: on a public chain a block lands every poll, and rebuilding on each
  // one threw the curator's edits away every couple of seconds.
  const block = v?.block;
  const layout = v ? layoutKey(v) : "";
  useEffect(() => {
    if (v && preset) apply(PRESETS.find((p) => p.key === preset)?.when?.(v) ? "tighten" : preset, v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block]);
  useEffect(() => {
    if (v && !preset) apply("tighten", v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  const legs = useMemo(() => (v && ed ? toLegs(v, ed.drafts) : []), [v, ed]);
  const cuts = useMemo(() => (ed ? [...ed.rm].sort((a, b) => a - b).map((i) => cut(i)) : []), [ed]);
  const actor = actorFor(role, v);
  // Who the reshape is simulated and sent as: on a public chain, the vault's real curator (see partyFor).
  const party = partyFor(role, v, net);
  const publicChain = !!net && !net.caps.devChain;
  const mayAct = canSendAs(party, net, wallet);

  // Pre-flight the exact transaction whenever the plan changes.
  useEffect(() => {
    if (!ctx || !v || !ed) return;
    const id = ++req.current;
    setChecking(true);
    const t = setTimeout(async () => {
      // Never left waiting: a check that could not be made says why, and the next block checks again.
      const r = await preflight(ctx, party, { address: v.address, abi: covenantVaultAbi, functionName: "reshape", args: [cuts, legs, NEVER] }, v).catch(failedPreflight);
      if (id === req.current) {
        setPre(r);
        setChecking(false);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [ctx, v, ed, cuts, legs, party]);

  if (!v || !ed) return <NeedsChain what="the curator's desk" />;

  const b = bounds(v);
  const freed = freedBy(v, ed.rm);
  const sum = (asset: Draft["asset"]) => ed.drafts.filter((x) => x.asset === asset).reduce((s, x) => s + x.share, 0);
  const moved = (pre?.events.find((e) => e.name === "Reshaped")?.args.movedFraction as bigint | undefined) ?? undefined;
  const movedNow = moved !== undefined ? Number(moved) / 1e9 : movedFraction(v, ed.rm);
  const proposed: ShapeSource = pre?.ok && pre.after && !checking ? pre.after : sketch(v, ed);

  const clamp = (x: Draft): Draft => {
    let { lower, upper } = x;
    if (x.asset === "quote" && upper > b.bidMax) {
      lower -= upper - b.bidMax;
      upper = b.bidMax;
    }
    if (x.asset === "token" && lower < b.askMin) {
      upper += b.askMin - lower;
      lower = b.askMin;
    }
    if (upper <= lower) upper = lower + b.sp;
    return { ...x, lower, upper };
  };
  const patch = (id: string, f: (x: Draft) => Draft) => {
    setPreset("");
    setEd((e) => (e ? { ...e, drafts: e.drafts.map((x) => (x.id === id ? clamp(f(x)) : x)) } : e));
  };
  const toggleRm = (i: number) => {
    setPreset("");
    setEd((e) => (e ? { ...e, rm: e.rm.includes(i) ? e.rm.filter((k) => k !== i) : [...e.rm, i].sort((a, c) => a - c) } : e));
  };
  const addDraft = (asset: Draft["asset"]) => {
    setPreset("");
    const next = {
      ...ed,
      drafts: [...ed.drafts, asset === "quote" ? d("quote", b.bidBottom, b.bidMax, Math.max(0, 1 - sum("quote"))) : d("token", b.askMin, b.askMin + b.B, Math.max(0, 1 - sum("token")))],
    };
    setEd(next);
    refit(v, next);
  };

  const submit = () =>
    run("Reshape", async (c, rec) => {
      const o = await send(c, party, { address: v.address, abi: covenantVaultAbi, functionName: "reshape", args: [cuts, legs, NEVER] }, { force: true, describe: { now: v.time + 1, tokenSymbol: v.tokenSymbol } });
      const ev = vaultEvents(o.receipt?.logs as never, v.address).find((e) => e.name === "Reshaped");
      rec.record(
        beatOf(o, actor, "Reshape", () => (ev ? `Moved ${pct(Number(ev.args.movedFraction as bigint) / 1e5)} of the vault's value. Support ${pct(Number(ev.args.supportBps as bigint))}` : undefined)),
        { toast: true },
      );
    });

  const STEP = b.sp * 5;
  const sym = v.tokenSymbol;
  return (
    <>
      <PageHeader
        eyebrow="Curator"
        title="Reshape the liquidity. Try to take it, too."
        lead="Choose which ranges to lift and where to put the assets back. Every edit is simulated against the deployed vault in the next block, so the verdict is the contract's own. The hostile presets are there on purpose."
        aside={
          role === "curator" ? (
            <Tag tone="accent">Acting as curator</Tag>
          ) : (
            <Button size="sm" onClick={() => setRole("curator")}>
              Act as curator
            </Button>
          )
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-6">
          <Panel eyebrow="Proposed shape" title={pre?.ok && !checking ? "Exactly what the contract would place" : "Drag the bars under the chart to move a range"}>
            <ShapeChart
              world={proposed}
              ghost={v}
              domain={domain ?? undefined}
              height={360}
              handles={ed.drafts.map((x) => ({ id: x.id, lower: x.lower, upper: x.upper, asset: x.asset }))}
              onHandle={(id, lower, upper) => patch(id, (x) => ({ ...x, lower: domain ? Math.max(domain[0], lower) : lower, upper: domain ? Math.min(domain[1], upper) : upper }))}
              onHandleEnd={() => refit(v, ed)}
              maxBidUpper={b.bidMax}
              minAskLower={b.askMin}
            />
            <div className="mt-3">
              <ShapeLegend ghost="Current" />
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {PRESETS.map((p) => {
                const blocked = p.when?.(v) ?? null;
                return (
                  <button
                    key={p.key}
                    onClick={() => apply(p.key, v)}
                    disabled={!!blocked}
                    title={blocked ?? undefined}
                    aria-pressed={preset === p.key}
                    className={`rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${preset === p.key ? (p.hostile ? "border-breach/60 bg-breach/5" : "border-ink bg-raised") : "border-line-strong hover:border-muted"}`}
                  >
                    <div className={`text-[13px] font-medium ${p.hostile ? "text-breach" : "text-ink"}`}>{p.name}</div>
                    <div className="text-xs text-faint">{blocked ? "After a pump" : p.hint}</div>
                  </button>
                );
              })}
            </div>
            {net?.caps.devChain && PRESETS.find((p) => p.key === "ceiling")?.when?.(v) && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
                Bidding above the Anchor needs a pump that has held.
                <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void pumpAndHold(v)}>
                  Pump past the ceiling and hold {duration(v.terms.twapWindow)}
                </Button>
              </div>
            )}
          </Panel>

          <div className="grid gap-6 xl:grid-cols-2">
            <Panel eyebrow="Step 1" title="Lift these ranges">
              <ul>
                {v.ranges.map((_, i) => {
                  const r = describeRange(v, i);
                  const on = ed.rm.includes(i);
                  return (
                    <li key={i} className="border-b border-line last:border-b-0">
                      <label className="flex cursor-pointer items-center gap-3 py-2.5">
                        <input type="checkbox" checked={on} onChange={() => toggleRm(i)} className="h-4 w-4 accent-[var(--ink)]" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-ink">{r.kind}</span>
                          <span className="num block text-xs text-faint">{r.label}</span>
                        </span>
                        <span className="num text-right text-[13px] text-muted">
                          {r.quote > 1e-9 && (
                            <span className="block">
                              {amt(r.quote)} {v.quoteSymbol}
                            </span>
                          )}
                          {r.token > 1e-9 && (
                            <span className="block">
                              {amt(r.token)} {sym}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-3 flex items-baseline justify-between text-[13px]">
                <span className="text-muted">Freed to place</span>
                <span className="num text-ink">
                  {amt(freed.quote)} {v.quoteSymbol} · {amt(freed.token)} {sym}
                </span>
              </div>
            </Panel>

            <Panel
              eyebrow="Step 2"
              title="Put the assets back"
              action={
                <div className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => addDraft("quote")}>
                    <Plus size={13} /> {v.quoteSymbol}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => addDraft("token")}>
                    <Plus size={13} /> {sym}
                  </Button>
                </div>
              }
            >
              <ul className="space-y-4">
                {ed.drafts.map((x) => {
                  const total = x.asset === "quote" ? freed.quote : freed.token;
                  return (
                    <li key={x.id} className="rounded-md border border-line p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-sm text-ink">
                          <span className={`h-2 w-2 rounded-[2px] ${x.asset === "quote" ? "bg-support" : "bg-ask"}`} />
                          {x.asset === "quote" ? `${v.quoteSymbol} bids` : `${sym} asks`}
                          <span className="num text-xs text-faint">
                            {axisPrice(priceAt(x.lower))} – {axisPrice(priceAt(x.upper))}
                          </span>
                        </span>
                        <button
                          aria-label="Remove range"
                          onClick={() => {
                            setPreset("");
                            setEd((e) => (e ? { ...e, drafts: e.drafts.filter((k) => k.id !== x.id) } : e));
                          }}
                          className="grid h-7 w-7 place-items-center rounded text-faint hover:bg-raised hover:text-ink"
                        >
                          <X size={14} />
                        </button>
                      </div>
                      <div className="mt-2 flex items-center gap-3">
                        <input type="range" min={0} max={100} value={Math.round(x.share * 100)} onChange={(e) => patch(x.id, (k) => ({ ...k, share: Number(e.target.value) / 100 }))} aria-label="Share of freed asset" />
                        <span className="num w-[104px] shrink-0 text-right text-[13px] text-ink">
                          {Math.round(x.share * 100)}% <span className="text-faint">· {amt(total * x.share)}</span>
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 text-xs text-faint">
                        <MoveHorizontal size={13} />
                        <button className="rounded border border-line px-2 py-1 text-muted hover:text-ink" onClick={() => patch(x.id, (k) => ({ ...k, lower: k.lower - STEP, upper: k.upper - STEP }))}>
                          Lower price
                        </button>
                        <button className="rounded border border-line px-2 py-1 text-muted hover:text-ink" onClick={() => patch(x.id, (k) => ({ ...k, lower: k.lower + STEP, upper: k.upper + STEP }))}>
                          Higher price
                        </button>
                        <span className="ml-auto">Width</span>
                        <button
                          aria-label="Narrower"
                          className="grid h-6 w-6 place-items-center rounded border border-line text-muted hover:text-ink"
                          onClick={() => patch(x.id, (k) => (k.asset === "quote" ? { ...k, lower: Math.min(k.upper - b.sp, k.lower + STEP) } : { ...k, upper: Math.max(k.lower + b.sp, k.upper - STEP) }))}
                        >
                          <Minus size={12} />
                        </button>
                        <button
                          aria-label="Wider"
                          className="grid h-6 w-6 place-items-center rounded border border-line text-muted hover:text-ink"
                          onClick={() => patch(x.id, (k) => (k.asset === "quote" ? { ...k, lower: k.lower - STEP } : { ...k, upper: k.upper + STEP }))}
                        >
                          <Plus size={12} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-3 flex items-baseline justify-between text-[13px]">
                <span className="text-muted">Allocated</span>
                <span className="num">
                  <span className={Math.abs(sum("quote") - 1) < 0.005 || freed.quote < 1e-9 ? "text-ink" : "text-breach"}>
                    {Math.round(sum("quote") * 100)}% {v.quoteSymbol}
                  </span>
                  <span className="text-faint"> · </span>
                  <span className={Math.abs(sum("token") - 1) < 0.005 || freed.token < 1e-9 ? "text-ink" : "text-breach"}>
                    {Math.round(sum("token") * 100)}% {sym}
                  </span>
                </span>
              </div>
            </Panel>
          </div>
        </div>

        <div className="lg:sticky lg:top-20 lg:self-start">
          <Panel eyebrow="Pre-flight" title="What the contract will say">
            <ReshapeVerdict before={v} pre={pre} moved={movedNow} loading={checking} />
            <SendButton
              verb="submit"
              variant={pre && !pre.ok ? "danger" : "primary"}
              className="mt-4 w-full"
              onClick={submit}
              disabled={!!busy || (publicChain && (!mayAct || (!!pre && !pre.ok)))}
            >
              {publicChain && !mayAct ? "Only the curator's wallet can submit" : pre && !pre.ok ? (publicChain ? "The contract refuses this" : "Submit anyway") : "Submit reshape"}
            </SendButton>
            <p className="mt-2 text-center text-xs text-faint">
              {publicChain && !mayAct && isAddressParty(party)
                ? `Simulated as the curator, ${shortAddress(party)}. Only that wallet can send it.`
                : pre && !pre.ok
                  ? publicChain
                    ? "Nothing is sent: on a public chain a refused transaction would only cost gas."
                    : "It will be mined and revert. Nothing will change."
                  : "One transaction. Liquidity never leaves the pool."}
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
