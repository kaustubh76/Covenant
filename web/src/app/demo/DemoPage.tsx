"use client";

import clsx from "clsx";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { type BeatInput, note } from "@/chain/beat";
import { DEMO_BIDS, DEMO_STEPS, DUMP_SIZE, type DemoState, bidPrice, emptyDemo } from "@/chain/scenarios/demo";
import { PRESETS } from "@/chain/terms";
import { revertTo, snapshot } from "@/chain/time";
import { type VaultView, readVaultView } from "@/chain/view";
import { NeedsChain } from "@/components/chain/NeedsChain";
import { DemandCurve } from "@/components/covenant/DemandCurve";
import { ImpactCompare } from "@/components/covenant/ImpactCompare";
import { RuleRail } from "@/components/covenant/RuleRail";
import { ShapeChart, ShapeLegend } from "@/components/covenant/ShapeChart";
import { TermsCard } from "@/components/covenant/TermsCard";
import { BeatList } from "@/components/covenant/Verdict";
import { Backdrop } from "@/components/landing/FluidField";
import { LiveWalkthrough } from "@/components/demo/LiveWalkthrough";
import { Button, Panel } from "@/components/ui";
import type { LiveDeployment } from "@/server/live";
import { offeredDevNetwork, useChain } from "@/store/chain";

interface StepRecord {
  beats: BeatInput[];
  before: VaultView | null;
  after: VaultView | null;
  state: DemoState;
}

const CURVE_BIDS = DEMO_BIDS.map((b) => ({ id: b.id, bidder: b.bidder === "bob" ? "Bob" : "Alice", maxPrice: bidPrice(b), amount: b.amount }));

/** Why a step found its snapshot gone. */
const GONE = "This chain was reset, or taken back past this step, since the demo ran it: the demo starts again from step 1.";
const TORN = " The chain may have moved partway, so reset it to start clean.";

/**
 * Revert to `id`: "back" when the chain went back to it; "gone" when the snapshot is gone and nothing moved, "torn" when
 * it is gone and the chain may have moved (SnapshotGone either way). Anything else throws.
 */
async function rewind(ctx: Parameters<typeof revertTo>[0], id: Hex): Promise<"back" | "gone" | "torn"> {
  try {
    await revertTo(ctx, id);
    return "back";
  } catch (e) {
    if ((e as { name?: string })?.name !== "SnapshotGone") throw e;
    return (e as { why?: string }).why === "torn" ? "torn" : "gone";
  }
}

/** `live` is the real Base Sepolia deployment and its proof (server/live.ts), walked through on a public chain. */
export function DemoPage({ live }: { live: LiveDeployment | null }) {
  const status = useChain((s) => s.status);
  const run = useChain((s) => s.run);
  const busy = useChain((s) => s.busy);
  const selectVault = useChain((s) => s.selectVault);
  const net = useChain((s) => s.net);
  const [records, setRecords] = useState<StepRecord[]>([]);
  const [at, setAt] = useState(0);
  // the step whose events should play out one by one: the one just run, until the presenter moves on
  const [freshAt, setFreshAt] = useState(-1);
  useEffect(() => {
    if (freshAt !== -1 && at !== freshAt) setFreshAt(-1);
  }, [at, freshAt]);
  // snaps[i]: the chain just before step i. states[i]: the demo's own state just before step i.
  const snaps = useRef<Hex[]>([]);
  const states = useRef<DemoState[]>([emptyDemo()]);
  const forget = useCallback(() => {
    snaps.current = [];
    states.current = [emptyDemo()];
    setRecords([]);
    setAt(0);
  }, []);

  // The chain the steps and their snapshots belong to. A reset Playground (a new baseline) or a replaced one (a new
  // session) has none of them: the demo starts again from step 1 there, rather than rewinding to snapshots that are gone.
  // A moment offline (no network) is not a new chain: only a chain that is there can replace the one before.
  const chainKey = net ? `${net.key}|${net.rpcUrl}|${net.runtime?.baselineSnapshot ?? ""}` : null;
  const onChain = useRef(chainKey);
  useEffect(() => {
    if (chainKey === null) return;
    if (onChain.current === null) {
      onChain.current = chainKey;
      return;
    }
    if (onChain.current === chainKey) return;
    onChain.current = chainKey;
    forget();
  }, [chainKey, forget]);

  const step = DEMO_STEPS[at];
  const rec = records[at];
  const prev = at > 0 ? records[at - 1] : undefined;
  const canRun = at === 0 || !!prev;

  const runStep = useCallback(
    async (i: number) => {
      const title = `Demo step ${i + 1}: ${DEMO_STEPS[i].title}`;
      const vault = await run(
        title,
        async (ctx, r) => {
          if (snaps.current[i]) {
            // Running a step again: rewind the chain to just before it (Anvil consumes the snapshot, so take it again).
            // If the snapshot is gone, start the demo over and say so: nothing was sent.
            const went = await rewind(ctx, snaps.current[i]);
            if (went !== "back") {
              forget();
              r.record({ actor: "anyone", title, ok: false, error: { name: "NotSent", args: [], signature: "Step gone", rule: "Other", reason: GONE + (went === "torn" ? TORN : "") } }, { toast: true });
              return null;
            }
            snaps.current[i] = await snapshot(ctx);
            snaps.current.length = i + 1;
          } else {
            snaps.current[i] = await snapshot(ctx);
          }
          const state = structuredClone(states.current[i]);
          // Only a live vault has a shape to draw: before migration there is no pool yet.
          const live = async () => {
            const v = state.vault ? await readVaultView(ctx, state.vault).catch(() => null) : null;
            return v?.adopted ? v : null;
          };
          const before = await live();
          const beats: BeatInput[] = [];
          await DEMO_STEPS[i].run({ ctx, progress: r.progress, record: (b) => beats.push(...(Array.isArray(b) ? b : [b])) }, state);
          const after = await live();
          states.current[i + 1] = structuredClone(state);
          states.current.length = i + 2;
          setRecords((rs) => [...rs.slice(0, i), { beats, before, after, state }]);
          setFreshAt(i);
          return after ? state.vault : null;
        },
        { quiet: true },
      );
      // keep the rest of the app on the vault the demo is showing
      if (vault) await selectVault(vault as Address);
    },
    [run, selectVault, forget],
  );

  const startOver = () =>
    run("Starting the demo over", async (ctx, r) => {
      // Any other failure leaves the demo as it was, to try again.
      const went = snaps.current[0] ? await rewind(ctx, snaps.current[0]) : "back";
      forget();
      if (went !== "back") r.record(note("anyone", "The demo starts over from here", `The chain was reset, or taken back past step 1, since the demo ran it, so there was nothing to rewind to.${went === "torn" ? TORN : ""}`), { toast: true });
    }).then(() => net?.runtime && selectVault(net.runtime.defaultVault));

  const forward = useCallback(() => {
    if (busy) return;
    if (!rec) {
      if (canRun) void runStep(at);
    } else if (at < DEMO_STEPS.length - 1) setAt(at + 1);
  }, [busy, rec, canRun, runStep, at]);
  const back = useCallback(() => setAt((a) => Math.max(0, a - 1)), []);

  // The arrows run the steps only where the steps run: a ready dev chain. On a public chain the live walkthrough below
  // has arrows of its own, and these would try to run step 1 there. A focused field or control keeps its own keys.
  const keys = status === "ready" && !!net?.caps.devChain;
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(t.tagName))) return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        forward();
      } else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, forward, back]);

  if (status !== "ready") return <NeedsChain what="the guided demo" />;
  // Every step runs from a snapshot and most move the clock (vesting, timelocks, the TWAP): local chain only.
  // A public chain cannot jump the clock or rewind: there the demo is the live proof, as real transactions.
  if (net && !net.caps.devChain) {
    if (!live || !live.steps.length) return <NeedsLocalChain name={net.name} />;
    return (
      <>
        <RunItYourself name={net.name} />
        <LiveWalkthrough live={live} />
      </>
    );
  }

  const finished = records.length === DEMO_STEPS.length && at === DEMO_STEPS.length - 1;
  const reverts = records.reduce((n, r) => n + r.beats.filter((b) => !b.ok).length, 0);
  const world = rec?.after ?? prev?.after ?? null;
  const clearing = records[1]?.state.clearing;
  const impacts = rec?.state ?? prev?.state;

  return (
    <div className="relative isolate grid gap-8 pt-8 lg:grid-cols-[232px_1fr]">
      <Backdrop className="h-[440px]" />
      {/* step rail */}
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <div className="eyebrow mb-3">Guided demo · live</div>
        <ol className="scroll-x flex gap-1 lg:block lg:space-y-0.5">
          {DEMO_STEPS.map((s, i) => {
            const done = !!records[i];
            const reachable = i === 0 || !!records[i - 1];
            return (
              <li key={s.n} className="shrink-0">
                <button
                  disabled={!reachable}
                  onClick={() => setAt(i)}
                  aria-current={i === at ? "step" : undefined}
                  className={clsx(
                    "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed",
                    i === at ? "bg-raised text-ink" : reachable ? "text-muted hover:text-ink" : "text-faint",
                  )}
                >
                  <span className={clsx("num grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px]", done ? "border-pass/50 text-pass" : i === at ? "border-ink" : "border-line-strong")}>
                    {done ? <Check size={11} strokeWidth={3} /> : s.n}
                  </span>
                  <span className="whitespace-nowrap">{s.title}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="mt-4 hidden border-t border-line pt-4 text-xs leading-relaxed text-faint lg:block">
          <kbd className="num rounded border border-line-strong px-1.5 py-0.5 text-muted">→</kbd> runs the step on the chain, then moves on.{" "}
          <kbd className="num rounded border border-line-strong px-1.5 py-0.5 text-muted">←</kbd> goes back. Running a step again rewinds the chain to just before it.
        </div>
        <Button size="sm" variant="ghost" className="mt-3" disabled={!!busy || !records.length} onClick={() => void startOver()}>
          <RotateCcw size={13} /> Start over
        </Button>
      </aside>

      <div className="min-w-0">
        <div className="mb-7 h-px w-full bg-line" role="progressbar" aria-label="Demo progress" aria-valuemin={0} aria-valuemax={DEMO_STEPS.length} aria-valuenow={records.length}>
          <motion.div className="h-px bg-accent" initial={false} animate={{ width: `${(records.length / DEMO_STEPS.length) * 100}%` }} transition={{ duration: 0.6, ease: [0.2, 0.7, 0.2, 1] }} />
        </div>
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <motion.div key={at} className="max-w-2xl" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.2, 0.7, 0.2, 1] }}>
            <div className="eyebrow">
              Step {step.n} of {DEMO_STEPS.length}
            </div>
            <h1 className="display mt-1 text-[44px] leading-[1.05] text-ink md:text-[52px]">{step.title}</h1>
            <p className="mt-3 text-[16px] leading-relaxed text-muted">{step.say}</p>
          </motion.div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" onClick={back} disabled={at === 0} aria-label="Previous step">
              <ArrowLeft size={16} />
            </Button>
            {!rec ? (
              <Button variant="primary" size="lg" onClick={() => void runStep(at)} disabled={!canRun || !!busy}>
                {busy ? "Running on the chain…" : step.verb}
              </Button>
            ) : at < DEMO_STEPS.length - 1 ? (
              <>
                <Button variant="ghost" onClick={() => void runStep(at)} disabled={!!busy}>
                  Run again
                </Button>
                <Button variant="primary" size="lg" onClick={() => setAt(at + 1)}>
                  Next: {DEMO_STEPS[at + 1].title} <ArrowRight size={16} />
                </Button>
              </>
            ) : (
              <Link href="/vault">
                <Button variant="primary" size="lg">
                  Open the vault <ArrowRight size={16} />
                </Button>
              </Link>
            )}
          </div>
        </div>

        <div className="mt-8 grid gap-6 xl:grid-cols-[1fr_380px]">
          <div className="min-w-0 space-y-6">
            {step.view === "auction" && (
              <Panel eyebrow="Continuous Clearing Auction" title="1,000 tokens, three bids">
                <DemandCurve bids={CURVE_BIDS} result={clearing ? { clearingPrice: clearing, floorPrice: 1 } : null} height={280} />
              </Panel>
            )}
            {step.view === "compare" && (
              <Panel eyebrow="Same sell, two layouts" title={`Selling ${DUMP_SIZE} tokens`}>
                {rec && impacts?.fullRangeImpact !== undefined && impacts.managedImpact !== undefined ? (
                  <ImpactCompare fullTicks={impacts.fullRangeImpact} managedTicks={impacts.managedImpact} size={DUMP_SIZE} />
                ) : (
                  <p className="py-10 text-center text-sm text-muted">Run the step to sell into both layouts.</p>
                )}
              </Panel>
            )}
            {step.view !== "auction" && world && (
              <>
                <Panel eyebrow="Liquidity shape" title={rec?.before && step.view === "vault" ? "After this step" : "The vault"}>
                  <ShapeChart world={world} ghost={rec?.before ?? undefined} height={step.view === "compare" ? 240 : 320} />
                  <div className="mt-3">
                    <ShapeLegend ghost={rec?.before ? "Before" : undefined} />
                  </div>
                </Panel>
                <RuleRail world={world} />
              </>
            )}
            {step.view !== "auction" && !world && (
              <Panel>
                <p className="py-12 text-center text-sm text-muted">Run the step to create the pool.</p>
              </Panel>
            )}
          </div>

          <div className="space-y-6">
            <Panel eyebrow="What happened on-chain" title={rec ? `${rec.beats.length} events` : "Not run yet"}>
              {rec ? (
                <BeatList key={`${at}:${freshAt}`} beats={rec.beats} stagger={freshAt === at ? 0.45 : 0} />
              ) : (
                <p className="py-6 text-center text-[13px] text-muted">
                  Press <span className="text-ink">{step.verb}</span> to run this step as real transactions against the deployed contracts.
                </p>
              )}
            </Panel>
            {step.view === "auction" && <TermsCard terms={PRESETS.standard} compact />}
          </div>
        </div>

        {finished && (
          <div className="mt-8 rounded-lg border border-line-strong bg-raised p-6">
            <div className="display text-[32px] leading-tight text-ink">The liquidity was reshaped, attacked, restored and released. None of it left the pool early.</div>
            <p className="mt-2 text-[15px] text-muted">
              Across ten steps the contracts refused <span className="num text-ink">{reverts}</span> actions. Every refusal came from a rule fixed before the auction opened.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Above the live proofs: where the ten steps themselves can run, when this copy of the app offers such a chain. */
function RunItYourself({ name }: { name: string }) {
  const setNetwork = useChain((s) => s.setNetwork);
  const busy = useChain((s) => s.busy);
  const devNet = useChain(offeredDevNetwork);
  if (!devNet) return null;
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-5 py-3.5">
      <p className="text-[13.5px] leading-relaxed text-muted">
        These are the proofs, as real transactions on {name}. The guided demo&apos;s ten steps need a clock that can jump months:
        {devNet === "playground" ? " run them yourself on a Playground chain, with no wallet." : " run them on the local chain."}
      </p>
      <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void setNetwork(devNet)} title={busy ? `Wait for "${busy}" to finish` : undefined}>
        {devNet === "playground" ? "Run the ten steps on the Playground" : "Switch to the local chain"}
      </Button>
    </div>
  );
}

/** On a public chain: the demo's ten steps need a chain whose clock can jump and whose state can be rewound. */
function NeedsLocalChain({ name }: { name: string }) {
  const setNetwork = useChain((s) => s.setNetwork);
  const busy = useChain((s) => s.busy);
  const devNet = useChain(offeredDevNetwork);
  return (
    <div className="mx-auto max-w-2xl py-16">
      <Panel eyebrow="Guided demo" title="The ten steps run on the local chain">
        <p className="text-[14px] leading-relaxed text-muted">
          The demo walks a launch from its auction to its release, which takes months of chain time: vesting, the curator timelock, a sell-off held for a whole
          TWAP window. On the local chain the app moves the clock forward and can rewind every step. {name} keeps real time, so the demo cannot run here. On{" "}
          {name} the provide and keep pages act with your wallet (or, without one, the backend&apos;s relayer), curate and govern show the curator&apos;s and
          issuer&apos;s calls as the contract would answer them, and the ledger links every function and attack to its real transactions.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          {devNet && (
            <Button variant="primary" disabled={!!busy} onClick={() => void setNetwork(devNet)} title={busy ? `Wait for "${busy}" to finish` : undefined}>
              {devNet === "playground" ? "Open the Playground" : "Switch to the local chain"}
            </Button>
          )}
          <Link href="/vault">
            <Button>Open the vault on {name}</Button>
          </Link>
        </div>
      </Panel>
    </div>
  );
}

